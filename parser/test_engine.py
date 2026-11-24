#!/usr/bin/env python3
"""Unit & real-database integration tests for parser/engine.py."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
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


if __name__ == "__main__":
    test_helpers()
    test_real_local_data()
    print("ALL PARSER TESTS PASSED")
