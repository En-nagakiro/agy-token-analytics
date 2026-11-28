#!/usr/bin/env python3
"""Unit & real-database integration tests for parser/engine.py."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine


def test_helpers():
    p, name = engine.parse_workspace_uri('["file:///c%3A/Projects/my%20demo%2Capp"]')
    assert p == "C:/Projects/my demo,app", f"Unexpected path: {p}"
    assert name == "my demo,app", f"Unexpected name: {name}"

    p2, name2 = engine.parse_workspace_uri("")
    assert p2 == "" and "无工作区" in name2

    ts = engine.parse_iso_timestamp("2026-11-24 04:20:09.2083581+00:00")
    assert ts > 1_700_000_000, f"Bad ts: {ts}"

    # Varint + packed varint
    assert engine.decode_packed_varints(bytes.fromhex("01020304050607")) == [1, 2, 3, 4, 5, 6, 7]
    print("[PASS] Helper unit tests")


def test_real_local_data():
    agy_dir = engine.default_agy_dir()
    if not (agy_dir / "conversations").exists():
        print("[SKIP] Local ~/.gemini/antigravity/conversations not found")
        return

    tmp_dir = Path(tempfile.mkdtemp(prefix="agy_token_test_"))
    try:
        r1 = engine.sync_index(agy_dir, tmp_dir, force=True)
        print(f"[INFO] Cold sync: {r1}")
        assert r1["ok"] is True
        assert r1["total_dbs"] > 0
        assert r1["errors"] == 0, f"Unexpected parse errors: {r1['errors']}"

        r2 = engine.sync_index(agy_dir, tmp_dir, force=False)
        print(f"[INFO] Warm incremental sync: {r2}")
        assert r2["ok"] is True
        assert r2["elapsed_ms"] < 2000, f"Warm sync too slow: {r2['elapsed_ms']}ms"

        dash = engine.query_dashboard(agy_dir, tmp_dir, range_key="7d", skip_sync=True)
        s = dash["summary"]
        print(
            f"[INFO] 7d summary: total={s['total']:,} (in={s['input']:,}, cache={s['cache_read']:,}, "
            f"think={s['thinking']:,}, resp={s['response']:,}) hit={s['cache_hit_rate']}% "
            f"main={s['main_sessions']} sub={s['subagent_sessions']} sub_share={s['subagent_share']}%"
        )
        print(f"[INFO] Models ({len(dash['models'])}): {[m['model_name'] for m in dash['models'][:5]]}")
        print(f"[INFO] Projects ({len(dash['projects'])}): {[p['project'] for p in dash['projects'][:5]]}")
        assert s["total"] == s["input"] + s["cache_read"] + s["output"]
        assert len(dash["series"]) == 7
        assert len(dash["heatmap"]) == 28

        if dash["sessions"]:
            top = dash["sessions"][0]
            detail = engine.query_session_detail(agy_dir, tmp_dir, top["id"])
            print(
                f"[INFO] Top session drilldown: id={top['id'][:8]} turns={detail['summary']['turns']} "
                f"peak_ctx={detail['summary']['peak_context']:,} compactions={detail['summary']['compaction_count']} "
                f"children={len(detail['children'])} tools={len(detail['tools'])}"
            )
            assert detail["summary"]["turns"] >= 0
        print("[PASS] Real local DB integration tests")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _pb_varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _pb_field_int(fn: int, val: int) -> bytes:
    return _pb_varint((fn << 3) | 0) + _pb_varint(val)


def _pb_field_bytes(fn: int, data: bytes) -> bytes:
    return _pb_varint((fn << 3) | 2) + _pb_varint(len(data)) + data


def _make_step_payload(
    step_type: int,
    status: int,
    ts: int,
    tool_name: str = "",
    tool_args: bytes = b"",
    extra_bytes: bytes = b"",
) -> bytes:
    md = _pb_field_bytes(1, _pb_field_int(1, ts))
    if tool_name:
        tc = _pb_field_bytes(2, tool_name.encode("utf-8"))
        if tool_args:
            tc += _pb_field_bytes(3, tool_args)
        md += _pb_field_bytes(4, tc)
    pb = _pb_field_int(1, step_type) + _pb_field_int(4, status) + _pb_field_bytes(5, md)
    if extra_bytes:
        pb += _pb_field_bytes(99, extra_bytes)
    return pb


def _make_gen_blob(
    covered: list[int],
    in_tok: int,
    ca_tok: int,
    th_tok: int,
    resp_tok: int,
    model_name: str = "Gemini 4 Neon",
) -> bytes:
    usage = (
        _pb_field_int(2, in_tok)
        + _pb_field_int(3, th_tok + resp_tok)
        + _pb_field_int(5, ca_tok)
        + _pb_field_int(9, th_tok)
        + _pb_field_int(10, resp_tok)
    )
    chat = (
        _pb_field_bytes(4, usage)
        + _pb_field_bytes(19, b"gemini-4-neon")
        + _pb_field_bytes(21, model_name.encode("utf-8"))
    )
    blob = _pb_field_bytes(1, chat)
    for s in covered:
        blob += _pb_field_int(2, s)
    return blob


def test_checkpoints_images_and_btw_branches():
    tmp_root = Path(tempfile.mkdtemp(prefix="agy_token_synthetic_"))
    try:
        agy_dir = tmp_root / "agy"
        conv_dir = agy_dir / "conversations"
        data_dir = tmp_root / "data"
        conv_dir.mkdir(parents=True)

        ts_base = 1_795_000_000
        # Summary DB with root session + /btw child entry in conversation_parents
        sconn = sqlite3.connect(str(agy_dir / "conversation_summaries.db"))
        sconn.execute(
            """
            CREATE TABLE conversation_summaries (
                conversation_id TEXT PRIMARY KEY,
                title TEXT,
                step_count INTEGER,
                last_modified_time TEXT,
                workspace_uris TEXT,
                agent_name TEXT,
                parent_conversation_id TEXT,
                nesting_depth INTEGER
            )
            """
        )
        sconn.execute(
            "CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT)"
        )
        sconn.execute(
            "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "root-conv",
                "Root Session",
                10,
                "2026-11-27 10:00:00+00:00",
                '["file:///a%3A/WorkSpace/demo"]',
                "",
                "",
                0,
            ),
        )
        sconn.execute(
            "INSERT INTO conversation_parents VALUES (?, ?)",
            ("btw-conv", "root-conv"),
        )
        sconn.commit()
        sconn.close()

        # Root DB: includes archived checkpoint (status=5), active checkpoint (status=3),
        # image read_file (~160KB payload), and text read_file (~8KB payload)
        rconn = sqlite3.connect(str(conv_dir / "root-conv.db"))
        rconn.execute(
            "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)"
        )
        rconn.execute("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
        img_args = json.dumps({"Path": "A:/tmp/screenshot.jpg"}).encode("utf-8")
        txt_args = json.dumps({"Path": "A:/src/app.py"}).encode("utf-8")
        root_steps = [
            (0, 14, 3, b"", _make_step_payload(14, 3, ts_base)),
            (1, 15, 3, b"", _make_step_payload(15, 3, ts_base + 1)),
            (2, 132, 3, b"", _make_step_payload(132, 3, ts_base + 2, "read_file", img_args, b"X" * 160_000)),
            (3, 23, 5, b"", _make_step_payload(23, 5, ts_base + 3)),  # archived compaction
            (4, 15, 3, b"", _make_step_payload(15, 3, ts_base + 4)),
            (5, 132, 3, b"", _make_step_payload(132, 3, ts_base + 5, "read_file", txt_args, b"Y" * 8_000)),
            (6, 23, 3, b"", _make_step_payload(23, 3, ts_base + 6)),  # active compaction
            (7, 15, 3, b"", _make_step_payload(15, 3, ts_base + 7)),
        ]
        rconn.executemany("INSERT INTO steps VALUES (?, ?, ?, ?, ?)", root_steps)
        root_gens = [
            (0, _make_gen_blob([1, 2], 10_000, 90_000, 100, 200)),
            (1, _make_gen_blob([4, 5], 20_000, 0, 100, 200)),
            (2, _make_gen_blob([7], 15_000, 0, 50, 100)),
        ]
        rconn.executemany("INSERT INTO gen_metadata VALUES (?, ?)", root_gens)
        rconn.commit()
        rconn.close()

        # /btw branch DB: copies root steps 0..7 + btw marker at step 8 + net branch steps 9..11
        bconn = sqlite3.connect(str(conv_dir / "btw-conv.db"))
        bconn.execute(
            "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)"
        )
        bconn.execute("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
        btw_steps = list(root_steps) + [
            (8, 101, 3, b"", _pb_field_int(1, 101) + _pb_field_int(4, 3) + _pb_field_bytes(99, engine.BTW_BRANCH_MARKER)),
            (9, 14, 3, b"", _make_step_payload(14, 3, ts_base + 100)),
            (10, 15, 3, b"", _make_step_payload(15, 3, ts_base + 101)),
            (11, 132, 3, b"", _make_step_payload(132, 3, ts_base + 102, "run_command", b'{"CommandLine":"echo hi"}', b"Z" * 800)),
        ]
        bconn.executemany("INSERT INTO steps VALUES (?, ?, ?, ?, ?)", btw_steps)
        btw_gens = list(root_gens) + [
            (3, _make_gen_blob([10, 11], 5_000, 40_000, 80, 120)),
        ]
        bconn.executemany("INSERT INTO gen_metadata VALUES (?, ?)", btw_gens)
        bconn.commit()
        bconn.close()

        dash = engine.query_dashboard(agy_dir, data_dir, range_key="all")
        # Root (100k + 20k + 15k + 750 out = 135,750) + /btw net (45k + 200 out = 45,200) = 180,950
        assert dash["summary"]["total"] == 180_950, f"Double counting occurred: {dash['summary']['total']}"
        assert dash["summary"]["main_sessions"] == 1
        assert dash["summary"]["subagent_sessions"] == 1
        assert len(dash["sessions"]) == 1
        assert dash["sessions"][0]["project"] == "demo"
        assert dash["sessions"][0]["children"][0]["role"] == "/btw"
        assert dash["sessions"][0]["children"][0]["turns"] == 1

        root_detail = engine.query_session_detail(agy_dir, data_dir, "root-conv")
        assert root_detail["summary"]["compaction_count"] == 2, (
            f"Expected 2 compactions (status=5 and status=3), got {root_detail['summary']['compaction_count']}"
        )
        rf_tool = next(t for t in root_detail["tools"] if t["tool"] == "read_file")
        # 1 image (1400) + 1 ~8k text (~2000) should be << 10,000 (not 40,000+!)
        assert rf_tool["tokens"] < 5_000, f"Image read_file inflated: {rf_tool}"

        btw_detail = engine.query_session_detail(agy_dir, data_dir, "btw-conv")
        assert btw_detail["summary"]["turns"] == 1
        assert btw_detail["meta"]["project"] == "demo"
        assert [t["tool"] for t in btw_detail["tools"] if t["tool"] != "Thinking（深度推理）"] == ["run_command"]
        print("[PASS] Synthetic compaction, image read, and /btw deduplication tests")
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    test_helpers()
    test_checkpoints_images_and_btw_branches()
    test_real_local_data()
    print("ALL PARSER TESTS PASSED")
