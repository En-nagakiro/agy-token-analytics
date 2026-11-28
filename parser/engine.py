#!/usr/bin/env python3
"""Read-only incremental token usage parser & analytics engine for Antigravity 2.0.

Zero external dependencies (Python 3.10+ stdlib only).
Reads ~/.gemini/antigravity/conversation_summaries.db and conversations/*.db
strictly in read-only mode (URI mode=ro + PRAGMA query_only = ON) and caches
parsed metrics incrementally in <data_dir>/usage_index.sqlite for sub-100ms queries.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
from urllib.parse import unquote, urlparse

# Force UTF-8 stdio on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

INDEX_SCHEMA_VERSION = 2

# Step type id -> readable name fallback when tool_call name is absent
STEP_TYPE_NAMES: dict[int, str] = {
    5: "code_action",
    6: "git_commit",
    7: "grep_search",
    8: "view_file",
    9: "list_directory",
    13: "view_code_item",
    14: "user_input",
    15: "planner_response",
    21: "run_command",
    23: "checkpoint",
    24: "propose_code",
    25: "find",
    28: "command_status",
    31: "read_url_content",
    33: "search_web",
    38: "mcp_tool",
    51: "list_resources",
    52: "read_resource",
    56: "open_browser_url",
    61: "execute_browser_js",
    63: "capture_screenshot",
    67: "read_browser_page",
    68: "browser_get_dom",
    73: "code_search",
    85: "browser_subagent",
    86: "file_change",
    91: "generate_image",
    112: "shell_exec",
    127: "invoke_subagent",
    132: "generic_tool",
    138: "ask_question",
}

STEP_PLANNER_RESPONSE = 15
STEP_CHECKPOINT = 23
STEP_SYSTEM_MESSAGE = 101
STEP_GENERIC = 132
STATUS_DONE = 3
STATUS_ARCHIVED = 5
CHECKPOINT_VALID_STATUSES = (STATUS_DONE, STATUS_ARCHIVED)

BTW_BRANCH_MARKER = (
    b"Above is the conversation history from the parent conversation; "
    b"what follows is a side question (/btw)"
)
IMAGE_READ_TOOLS = ("read_file", "view_file")
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
EST_IMAGE_READ_TOKENS = 1400


# ---------------------------------------------------------------------------
# Lightweight Protobuf Wire Decoder
# ---------------------------------------------------------------------------


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    val = 0
    shift = 0
    n = len(buf)
    while pos < n:
        b = buf[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, pos
        shift += 7
        if shift > 70:
            raise ValueError("Varint overflow")
    raise ValueError("Truncated varint")


def decode_packed_varints(buf: bytes) -> list[int]:
    out: list[int] = []
    pos, n = 0, len(buf)
    while pos < n:
        try:
            v, pos = read_varint(buf, pos)
            out.append(v)
        except ValueError:
            break
    return out


class Msg:
    """Lazy protobuf message decoder: field number -> list of raw values."""

    __slots__ = ("fields",)

    def __init__(self, buf: bytes | None):
        self.fields: dict[int, list] = {}
        if not buf:
            return
        pos, n = 0, len(buf)
        while pos < n:
            try:
                tag, pos = read_varint(buf, pos)
                fn, wt = tag >> 3, tag & 7
                if fn == 0:
                    break
                if wt == 0:
                    val, pos = read_varint(buf, pos)
                elif wt == 2:
                    ln, pos = read_varint(buf, pos)
                    if pos + ln > n:
                        break
                    val = buf[pos : pos + ln]
                    pos += ln
                elif wt == 1:
                    if pos + 8 > n:
                        break
                    val = buf[pos : pos + 8]
                    pos += 8
                elif wt == 5:
                    if pos + 4 > n:
                        break
                    val = buf[pos : pos + 4]
                    pos += 4
                else:
                    break
            except ValueError:
                break
            self.fields.setdefault(fn, []).append(val)

    def has(self, fn: int) -> bool:
        return fn in self.fields

    def int(self, fn: int, signed32: bool = False) -> int:
        vals = self.fields.get(fn)
        if not vals:
            return 0
        v = vals[-1]
        if not isinstance(v, int):
            return 0
        if signed32 and v >= (1 << 63):
            v -= 1 << 64
        return v

    def ints(self, fn: int) -> list[int]:
        out: list[int] = []
        for v in self.fields.get(fn, []):
            if isinstance(v, int):
                out.append(v)
            elif isinstance(v, bytes):
                out.extend(decode_packed_varints(v))
        return out

    def bytes(self, fn: int) -> bytes:
        vals = self.fields.get(fn)
        if not vals:
            return b""
        v = vals[-1]
        return v if isinstance(v, bytes) else b""

    def str(self, fn: int) -> str:
        return self.bytes(fn).decode("utf-8", errors="replace")

    def msg(self, fn: int) -> Msg | None:
        return Msg(self.bytes(fn)) if self.has(fn) else None


def decode_duration_ms(msg: Msg | None) -> int:
    if msg is None:
        return 0
    secs = msg.int(1, signed32=True)
    nanos = msg.int(2, signed32=True)
    if secs < 0 or secs > 3600:
        return 0
    ms = int(secs * 1000 + nanos / 1_000_000)
    return ms if 0 <= ms <= 3_600_000 else 0


# ---------------------------------------------------------------------------
# Path & Timestamp Helpers
# ---------------------------------------------------------------------------


def default_agy_dir() -> Path:
    gemini_dir = os.environ.get("ANTIGRAVITY_GEMINI_DIR")
    if gemini_dir:
        return Path(gemini_dir) / "antigravity"
    return Path.home() / ".gemini" / "antigravity"


def parse_workspace_uri(raw: str) -> tuple[str, str]:
    """Return (clean_path, project_name) from conversation_summaries.workspace_uris."""
    if not raw or not raw.strip():
        return ("", "无工作区（临时对话）")
    uri = raw.strip()
    if uri.startswith("["):
        try:
            arr = json.loads(uri)
            uri = arr[0] if isinstance(arr, list) and arr else ""
        except Exception:
            pass
    if not uri:
        return ("", "无工作区（临时对话）")
    path_str = uri
    if path_str.startswith("file:"):
        parsed = urlparse(path_str)
        path_str = unquote(parsed.path)
        if len(path_str) > 2 and path_str[0] == "/" and path_str[2] == ":":
            path_str = path_str[1:]
    path_str = path_str.replace("\\", "/").rstrip("/")
    if not path_str:
        return ("", "无工作区（临时对话）")
    # Uppercase drive letter on Windows for consistency
    if len(path_str) >= 2 and path_str[1] == ":":
        path_str = path_str[0].upper() + path_str[1:]
    name = path_str.rsplit("/", 1)[-1] or path_str
    return (path_str, name)


def parse_iso_timestamp(val: str | None) -> int:
    if not val:
        return 0
    s = str(val).strip()
    if not s:
        return 0
    # Normalize Go/SQLite formats like "2026-11-24 04:20:09.2083581+00:00"
    try:
        s_norm = s.replace(" ", "T")
        if s_norm.endswith("Z"):
            s_norm = s_norm[:-1] + "+00:00"
        # Truncate fractional seconds > 6 digits for Python <3.11 edge safety
        if "." in s_norm:
            head, rest = s_norm.split(".", 1)
            tz_pos = -1
            for ch in ("+", "-"):
                idx = rest.find(ch)
                if idx != -1:
                    tz_pos = idx
                    break
            if tz_pos != -1:
                frac = rest[:tz_pos][:6]
                tz = rest[tz_pos:]
                s_norm = f"{head}.{frac}{tz}"
            else:
                s_norm = f"{head}.{rest[:6]}"
        dt = datetime.fromisoformat(s_norm)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except Exception:
        return 0


def has_nonempty_wal(db_path: Path) -> bool:
    wal = Path(str(db_path) + "-wal")
    try:
        return wal.exists() and wal.stat().st_size > 0
    except OSError:
        return False


def open_ro_sqlite(db_path: Path, allow_immutable: bool = True) -> sqlite3.Connection:
    # For static DBs without an active non-empty WAL, immutable=1 avoids creating
    # 0-byte -wal/-shm sidecars and is 3x-5x faster on Windows.
    if allow_immutable and not has_nonempty_wal(db_path):
        uri = f"file:{db_path.as_posix()}?mode=ro&immutable=1"
    else:
        uri = f"file:{db_path.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    conn.execute("PRAGMA query_only = ON;")
    return conn


def file_stamp(db_path: Path) -> str:
    try:
        s1 = db_path.stat()
        p1 = f"{s1.st_mtime_ns}:{s1.st_size}"
    except OSError:
        p1 = "-"
    wal = Path(str(db_path) + "-wal")
    try:
        s2 = wal.stat()
        # Treat missing and 0-byte WAL files identically (no pending WAL frames)
        p2 = f"{s2.st_mtime_ns}:{s2.st_size}" if s2.st_size > 0 else "0"
    except OSError:
        p2 = "0"
    return f"{p1}|{p2}"


# ---------------------------------------------------------------------------
# Index Cache Management
# ---------------------------------------------------------------------------


def open_index_db(data_dir: Path) -> sqlite3.Connection:
    data_dir.mkdir(parents=True, exist_ok=True)
    idx_path = data_dir / "usage_index.sqlite"
    conn = sqlite3.connect(str(idx_path), timeout=10.0)
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS index_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    row = conn.execute(
        "SELECT value FROM index_meta WHERE key = 'schema_version'"
    ).fetchone()
    if not row or int(row[0]) != INDEX_SCHEMA_VERSION:
        conn.executescript(
            """
            DROP TABLE IF EXISTS indexed_files;
            DROP TABLE IF EXISTS gen_turns;
            DROP TABLE IF EXISTS tool_usage;
            DROP TABLE IF EXISTS conv_meta;
            """
        )
        conn.execute(
            "INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', ?)",
            (str(INDEX_SCHEMA_VERSION),),
        )

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS indexed_files (
            conversation_id TEXT PRIMARY KEY,
            stamp TEXT NOT NULL,
            indexed_at REAL NOT NULL,
            turn_count INTEGER NOT NULL DEFAULT 0,
            first_ts INTEGER NOT NULL DEFAULT 0,
            last_ts INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS gen_turns (
            conversation_id TEXT NOT NULL,
            gen_idx INTEGER NOT NULL,
            ts INTEGER NOT NULL DEFAULT 0,
            model_id TEXT NOT NULL DEFAULT '',
            model_name TEXT NOT NULL DEFAULT '',
            input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            thinking_tokens INTEGER NOT NULL DEFAULT 0,
            response_tokens INTEGER NOT NULL DEFAULT 0,
            ttft_ms INTEGER NOT NULL DEFAULT 0,
            gen_ms INTEGER NOT NULL DEFAULT 0,
            step_count INTEGER NOT NULL DEFAULT 0,
            compacted INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (conversation_id, gen_idx)
        );
        CREATE INDEX IF NOT EXISTS idx_gen_turns_ts ON gen_turns(ts);
        CREATE INDEX IF NOT EXISTS idx_gen_turns_conv ON gen_turns(conversation_id);

        CREATE TABLE IF NOT EXISTS tool_usage (
            conversation_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            call_count INTEGER NOT NULL DEFAULT 0,
            est_tokens INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (conversation_id, tool_name)
        );

        CREATE TABLE IF NOT EXISTS conv_meta (
            conversation_id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            workspace TEXT NOT NULL DEFAULT '',
            project_name TEXT NOT NULL DEFAULT '无工作区（临时对话）',
            parent_id TEXT NOT NULL DEFAULT '',
            root_id TEXT NOT NULL DEFAULT '',
            nesting_depth INTEGER NOT NULL DEFAULT 0,
            agent_name TEXT NOT NULL DEFAULT '',
            step_count INTEGER NOT NULL DEFAULT 0,
            last_modified_ts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_conv_meta_root ON conv_meta(root_id);
        """
    )
    conn.commit()
    return conn


# ---------------------------------------------------------------------------
# Single Conversation Parser
# ---------------------------------------------------------------------------


def _is_image_read_args(raw_args: bytes) -> bool:
    """Return True if read_file/view_file JSON args point to an image asset."""
    if not raw_args:
        return False
    try:
        obj = json.loads(raw_args.decode("utf-8", errors="replace"))
    except Exception:
        return False
    if not isinstance(obj, dict):
        return False
    for key in ("Path", "AbsolutePath", "path", "file_path"):
        val = obj.get(key)
        if isinstance(val, str) and val.strip().lower().endswith(IMAGE_EXTENSIONS):
            return True
    return False


def parse_single_conversation(
    db_path: Path, fallback_ts: int
) -> tuple[list[tuple], list[tuple], int, int]:
    """Parse one conversation .db (read-only) -> (gen_rows, tool_rows, first_ts, last_ts)."""
    last_err: Exception | None = None
    for attempt in range(3):
        conn = None
        try:
            conn = open_ro_sqlite(db_path)
            tables = {
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }

            step_ts: dict[int, int] = {}
            checkpoint_steps: set[int] = set()
            planner_fallback_rows: list[tuple] = []
            tool_counts: dict[str, int] = defaultdict(int)
            tool_tokens: dict[str, int] = defaultdict(int)
            branch_cutoff_step = -1

            if "steps" in tables:
                for idx, stype, status, md_blob, payload_blob in conn.execute(
                    "SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx"
                ):
                    pb = Msg(payload_blob)
                    real_type = pb.int(1) if pb.has(1) else stype
                    real_status = pb.int(4) if pb.has(4) else status
                    md = pb.msg(5) or Msg(md_blob)

                    # /btw branch DBs embed a copy of the parent's history up to the
                    # branch marker step; discard inherited prefix so only net branch
                    # steps and generations are counted.
                    if (
                        real_type == STEP_SYSTEM_MESSAGE
                        and payload_blob
                        and BTW_BRANCH_MARKER in payload_blob
                    ):
                        branch_cutoff_step = idx
                        step_ts.clear()
                        checkpoint_steps.clear()
                        planner_fallback_rows.clear()
                        tool_counts.clear()
                        tool_tokens.clear()
                        continue

                    ts_msg = md.msg(1)
                    ts_val = ts_msg.int(1) if ts_msg is not None else 0
                    if ts_val > 1_000_000_000:
                        step_ts[idx] = ts_val

                    if real_type == STEP_CHECKPOINT and real_status in CHECKPOINT_VALID_STATUSES:
                        checkpoint_steps.add(idx)

                    # Extract tool name and estimated token footprint
                    tc = md.msg(4)
                    tname = tc.str(2).strip() if tc is not None else ""
                    if not tname and real_type not in (0, 1, 2, 14, 15, 23, 101):
                        tname = STEP_TYPE_NAMES.get(real_type, f"step_{real_type}")

                    if tname:
                        tool_counts[tname] += 1
                        out_tok = md.int(23, signed32=True)
                        if out_tok > 0:
                            tool_tokens[tname] += out_tok
                        else:
                            raw_args = tc.bytes(3) if tc is not None else b""
                            if tname in IMAGE_READ_TOOLS and _is_image_read_args(raw_args):
                                approx = EST_IMAGE_READ_TOKENS
                            else:
                                # Fallback estimate from payload / args size
                                approx = len(payload_blob or b"") // 4
                                if raw_args:
                                    approx = max(approx, len(raw_args) // 4)
                            tool_tokens[tname] += max(0, approx)

                    mu = md.msg(9)
                    if mu is not None:
                        in_t = mu.int(2)
                        out_t = mu.int(3)
                        cache_t = mu.int(5)
                        think_t = mu.int(9)
                        resp_t = mu.int(10)
                        if resp_t == 0 and out_t > 0:
                            resp_t = max(0, out_t - think_t)
                        if out_t == 0 and (think_t + resp_t) > 0:
                            out_t = think_t + resp_t
                        if (in_t + cache_t + out_t) > 0:
                            planner_fallback_rows.append(
                                (idx, ts_val, in_t, cache_t, out_t, think_t, resp_t)
                            )

            gen_rows: list[tuple] = []
            conv_id = db_path.stem
            prev_last_step = -1

            if "gen_metadata" in tables:
                raw_gens = conn.execute(
                    "SELECT idx, data FROM gen_metadata ORDER BY idx"
                ).fetchall()
                for pos, (g_idx, blob) in enumerate(raw_gens):
                    g = Msg(blob)
                    chat = g.msg(1)
                    if chat is None:
                        continue
                    usage = chat.msg(4)
                    if usage is None:
                        continue

                    in_tok = max(0, usage.int(2))
                    out_tok = max(0, usage.int(3))
                    cache_tok = max(0, usage.int(5))
                    think_tok = max(0, usage.int(9))
                    resp_tok = max(0, usage.int(10))
                    if resp_tok == 0 and out_tok > 0:
                        resp_tok = max(0, out_tok - think_tok)
                    if out_tok == 0 and (think_tok + resp_tok) > 0:
                        out_tok = think_tok + resp_tok
                    if (in_tok + cache_tok + out_tok) == 0:
                        continue

                    model_id = chat.str(19).strip()
                    model_name = chat.str(21).strip() or model_id or "Unknown"
                    ttft_ms = decode_duration_ms(chat.msg(11))
                    gen_ms = decode_duration_ms(chat.msg(12))

                    covered = g.ints(2)
                    if branch_cutoff_step >= 0:
                        if covered:
                            if max(covered) <= branch_cutoff_step:
                                continue
                        elif prev_last_step <= branch_cutoff_step:
                            continue

                    ts_val = 0
                    for s_idx in covered:
                        if s_idx in step_ts:
                            ts_val = step_ts[s_idx]
                            break
                    if ts_val == 0 and pos < len(planner_fallback_rows):
                        ts_val = planner_fallback_rows[pos][1]
                    if ts_val == 0 and step_ts:
                        ts_val = max(step_ts.values())
                    if ts_val == 0:
                        ts_val = fallback_ts

                    first_step = covered[0] if covered else (prev_last_step + 1)
                    last_step = covered[-1] if covered else first_step
                    compacted = 0
                    if prev_last_step >= 0 and checkpoint_steps:
                        for ck in checkpoint_steps:
                            if prev_last_step < ck <= first_step:
                                compacted = 1
                                break
                    prev_last_step = max(prev_last_step, last_step)

                    gen_rows.append(
                        (
                            conv_id,
                            g_idx,
                            ts_val,
                            model_id,
                            model_name,
                            in_tok,
                            cache_tok,
                            out_tok,
                            think_tok,
                            resp_tok,
                            ttft_ms,
                            gen_ms,
                            len(covered),
                            compacted,
                        )
                    )

            # Fallback if gen_metadata was empty (older DB format)
            if not gen_rows and planner_fallback_rows:
                for pos, (s_idx, ts_val, in_t, cache_t, out_t, think_t, resp_t) in enumerate(
                    planner_fallback_rows
                ):
                    gen_rows.append(
                        (
                            conv_id,
                            pos,
                            ts_val or fallback_ts,
                            "unknown",
                            "Unknown",
                            in_t,
                            cache_t,
                            out_t,
                            think_t,
                            resp_t,
                            0,
                            0,
                            1,
                            0,
                        )
                    )

            all_ts = [r[2] for r in gen_rows if r[2] > 0]
            if not all_ts and step_ts:
                all_ts = list(step_ts.values())
            first_ts = min(all_ts) if all_ts else fallback_ts
            last_ts = max(all_ts) if all_ts else fallback_ts

            tool_rows = [
                (conv_id, name, cnt, tool_tokens[name])
                for name, cnt in tool_counts.items()
            ]
            return (gen_rows, tool_rows, first_ts, last_ts)

        except sqlite3.OperationalError as e:
            last_err = e
            time.sleep(0.08 * (attempt + 1))
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    raise RuntimeError(f"Failed reading {db_path.name}: {last_err}")


# ---------------------------------------------------------------------------
# Sync Metadata & Incremental Index
# ---------------------------------------------------------------------------


def sync_summaries_metadata(agy_dir: Path, idx_conn: sqlite3.Connection) -> dict[str, int]:
    """Refresh conv_meta from conversation_summaries.db and return conv_id -> last_modified_ts."""
    sdb = agy_dir / "conversation_summaries.db"
    fallback_ts_map: dict[str, int] = {}
    if not sdb.exists():
        return fallback_ts_map

    sconn = None
    try:
        sconn = open_ro_sqlite(sdb)
        raw_rows: dict[str, dict] = {}
        parent_map: dict[str, str] = {}

        tables = {
            r[0]
            for r in sconn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "conversation_parents" in tables:
            for cid, pid in sconn.execute(
                "SELECT conversation_id, parent_id FROM conversation_parents"
            ):
                if cid and pid:
                    parent_map[cid] = pid

        if "conversation_summaries" in tables:
            for row in sconn.execute(
                """
                SELECT conversation_id, title, step_count, last_modified_time,
                       workspace_uris, agent_name, parent_conversation_id, nesting_depth
                FROM conversation_summaries
                """
            ):
                cid, title, step_cnt, last_mod, ws_raw, agent_name, parent_id, depth = row
                if not cid:
                    continue
                pid = (parent_id or "").strip() or parent_map.get(cid, "")
                if pid:
                    parent_map[cid] = pid
                ws_path, proj_name = parse_workspace_uri(ws_raw or "")
                lm_ts = parse_iso_timestamp(last_mod)
                fallback_ts_map[cid] = lm_ts
                raw_rows[cid] = {
                    "cid": cid,
                    "title": (title or "").strip() or f"会话 {cid[:8]}",
                    "workspace": ws_path,
                    "project_name": proj_name,
                    "parent_id": pid,
                    "nesting_depth": int(depth or 0),
                    "agent_name": (agent_name or "").strip(),
                    "step_count": int(step_cnt or 0),
                    "last_modified_ts": lm_ts,
                }

        # Resolve root_id recursively and inherit workspace/project from root if child lacks it
        def find_root(cid: str) -> tuple[str, int]:
            cur = cid
            depth = 0
            seen = {cur}
            while True:
                p = parent_map.get(cur, "")
                if not p or p in seen:
                    return (cur, depth)
                seen.add(p)
                cur = p
                depth += 1

        # Include /btw side-branch conversations recorded only in conversation_parents
        conv_dir = agy_dir / "conversations"
        for cid, pid in parent_map.items():
            if cid in raw_rows:
                continue
            if not (conv_dir / f"{cid}.db").exists():
                continue
            root_id, calc_depth = find_root(cid)
            root_info = raw_rows.get(root_id)
            root_title = root_info["title"] if root_info else ""
            raw_rows[cid] = {
                "cid": cid,
                "title": f"{root_title} (/btw)" if root_title else f"会话 {cid[:8]} (/btw)",
                "workspace": root_info["workspace"] if root_info else "",
                "project_name": root_info["project_name"] if root_info else "无工作区（临时对话）",
                "parent_id": pid,
                "nesting_depth": max(1, calc_depth),
                "agent_name": "/btw",
                "step_count": 0,
                "last_modified_ts": 0,
            }

        meta_batch: list[tuple] = []
        for cid, info in raw_rows.items():
            root_id, calc_depth = find_root(cid)
            depth = max(info["nesting_depth"], calc_depth)
            ws = info["workspace"]
            proj = info["project_name"]
            if not ws and root_id in raw_rows and raw_rows[root_id]["workspace"]:
                ws = raw_rows[root_id]["workspace"]
                proj = raw_rows[root_id]["project_name"]
            agent_name = info["agent_name"]
            if depth > 0 and not agent_name:
                agent_name = "subagent"
            meta_batch.append(
                (
                    cid,
                    info["title"],
                    ws,
                    proj,
                    info["parent_id"],
                    root_id,
                    depth,
                    agent_name,
                    info["step_count"],
                    info["last_modified_ts"],
                )
            )

        idx_conn.execute("DELETE FROM conv_meta")
        idx_conn.executemany(
            """
            INSERT OR REPLACE INTO conv_meta(
                conversation_id, title, workspace, project_name,
                parent_id, root_id, nesting_depth, agent_name,
                step_count, last_modified_ts
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            meta_batch,
        )
        idx_conn.commit()
    finally:
        if sconn is not None:
            sconn.close()

    return fallback_ts_map


def sync_index(agy_dir: Path, data_dir: Path, force: bool = False) -> dict:
    t0 = time.perf_counter()
    idx_conn = open_index_db(data_dir)
    try:
        fallback_ts_map = sync_summaries_metadata(agy_dir, idx_conn)
        conv_dir = agy_dir / "conversations"
        if not conv_dir.exists():
            return {
                "ok": True,
                "total_dbs": 0,
                "updated": 0,
                "skipped": 0,
                "errors": 0,
                "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            }

        existing_stamps: dict[str, str] = {}
        if not force:
            for cid, st in idx_conn.execute(
                "SELECT conversation_id, stamp FROM indexed_files"
            ):
                existing_stamps[cid] = st
        else:
            idx_conn.executescript(
                "DELETE FROM indexed_files; DELETE FROM gen_turns; DELETE FROM tool_usage;"
            )

        db_files = sorted(conv_dir.glob("*.db"))
        seen_ids: set[str] = set()
        updated = 0
        skipped = 0
        errors = 0

        for db_path in db_files:
            cid = db_path.stem
            seen_ids.add(cid)
            st = file_stamp(db_path)
            if not force and existing_stamps.get(cid) == st:
                skipped += 1
                continue

            fb_ts = fallback_ts_map.get(cid, 0)
            if fb_ts == 0:
                try:
                    fb_ts = int(db_path.stat().st_mtime)
                except OSError:
                    fb_ts = int(time.time())

            try:
                gen_rows, tool_rows, first_ts, last_ts = parse_single_conversation(
                    db_path, fb_ts
                )
                idx_conn.execute(
                    "DELETE FROM gen_turns WHERE conversation_id = ?", (cid,)
                )
                idx_conn.execute(
                    "DELETE FROM tool_usage WHERE conversation_id = ?", (cid,)
                )
                if gen_rows:
                    idx_conn.executemany(
                        """
                        INSERT OR REPLACE INTO gen_turns(
                            conversation_id, gen_idx, ts, model_id, model_name,
                            input_tokens, cache_read_tokens, output_tokens,
                            thinking_tokens, response_tokens, ttft_ms, gen_ms,
                            step_count, compacted
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        gen_rows,
                    )
                if tool_rows:
                    idx_conn.executemany(
                        """
                        INSERT OR REPLACE INTO tool_usage(
                            conversation_id, tool_name, call_count, est_tokens
                        ) VALUES (?, ?, ?, ?)
                        """,
                        tool_rows,
                    )
                idx_conn.execute(
                    """
                    INSERT OR REPLACE INTO indexed_files(
                        conversation_id, stamp, indexed_at, turn_count, first_ts, last_ts
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (cid, st, time.time(), len(gen_rows), first_ts, last_ts),
                )
                updated += 1
            except Exception:
                errors += 1

        # Remove deleted conversation files from index
        stale_ids = set(existing_stamps.keys()) - seen_ids
        if stale_ids:
            for cid in stale_ids:
                idx_conn.execute(
                    "DELETE FROM indexed_files WHERE conversation_id = ?", (cid,)
                )
                idx_conn.execute(
                    "DELETE FROM gen_turns WHERE conversation_id = ?", (cid,)
                )
                idx_conn.execute(
                    "DELETE FROM tool_usage WHERE conversation_id = ?", (cid,)
                )

        idx_conn.commit()
        return {
            "ok": True,
            "total_dbs": len(db_files),
            "updated": updated,
            "skipped": skipped,
            "errors": errors,
            "elapsed_ms": int((time.perf_counter() - t0) * 1000),
        }
    finally:
        idx_conn.close()


# ---------------------------------------------------------------------------
# Aggregation & Query APIs
# ---------------------------------------------------------------------------


def range_bounds(range_key: str) -> tuple[int, str]:
    """Return (start_unix_ts, bucket_mode 'hour'|'day')."""
    now = datetime.now()
    now_ts = int(now.timestamp())
    if range_key == "5h":
        return (now_ts - 5 * 3600, "hour")
    if range_key == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return (int(start.timestamp()), "hour")
    if range_key == "7d":
        start = (now - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
        return (int(start.timestamp()), "day")
    if range_key == "30d":
        start = (now - timedelta(days=29)).replace(hour=0, minute=0, second=0, microsecond=0)
        return (int(start.timestamp()), "day")
    return (0, "day")


def query_dashboard(
    agy_dir: Path,
    data_dir: Path,
    range_key: str = "7d",
    project_filter: str = "",
    model_filter: str = "",
    skip_sync: bool = False,
) -> dict:
    sync_info = (
        {"ok": True, "skipped_sync": True, "elapsed_ms": 0}
        if skip_sync
        else sync_index(agy_dir, data_dir, force=False)
    )
    start_ts, bucket_mode = range_bounds(range_key)
    now_ts = int(time.time())
    five_h_ts = now_ts - 5 * 3600

    conn = open_index_db(data_dir)
    try:
        # Load metadata map
        meta_map: dict[str, dict] = {}
        for row in conn.execute(
            """
            SELECT conversation_id, title, workspace, project_name,
                   parent_id, root_id, nesting_depth, agent_name,
                   step_count, last_modified_ts
            FROM conv_meta
            """
        ):
            meta_map[row[0]] = {
                "id": row[0],
                "title": row[1],
                "workspace": row[2],
                "project": row[3] or "无工作区（临时对话）",
                "parent_id": row[4],
                "root_id": row[5] or row[0],
                "depth": row[6],
                "agent_name": row[7],
                "step_count": row[8],
                "last_modified_ts": row[9],
            }

        def get_meta(cid: str) -> dict:
            m = meta_map.get(cid)
            if m is not None:
                return m
            return {
                "id": cid,
                "title": f"会话 {cid[:8]}",
                "workspace": "",
                "project": "无工作区（临时对话）",
                "parent_id": "",
                "root_id": cid,
                "depth": 0,
                "agent_name": "",
                "step_count": 0,
                "last_modified_ts": 0,
            }

        # Collect available filter values across entire dataset
        all_projects = sorted({m["project"] for m in meta_map.values()})
        all_models = sorted(
            {
                r[0]
                for r in conn.execute(
                    "SELECT DISTINCT model_name FROM gen_turns WHERE model_name != ''"
                )
            }
        )

        # Rolling 5h window totals (always computed for quota fallback & status strip)
        r5 = conn.execute(
            """
            SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(cache_read_tokens),0),
                   COALESCE(SUM(thinking_tokens),0), COALESCE(SUM(response_tokens),0),
                   COUNT(*)
            FROM gen_turns WHERE ts >= ?
            """,
            (five_h_ts,),
        ).fetchone()
        rolling_5h = {
            "input": r5[0],
            "cache_read": r5[1],
            "thinking": r5[2],
            "response": r5[3],
            "total": r5[0] + r5[1] + r5[2] + r5[3],
            "calls": r5[4],
        }

        # 28-day heatmap (always global for rhythm card)
        hm_start = int(
            (datetime.now() - timedelta(days=27))
            .replace(hour=0, minute=0, second=0, microsecond=0)
            .timestamp()
        )
        hm_totals: dict[str, int] = defaultdict(int)
        for ts_v, in_t, ca_t, out_t in conn.execute(
            "SELECT ts, input_tokens, cache_read_tokens, output_tokens FROM gen_turns WHERE ts >= ?",
            (hm_start,),
        ):
            if ts_v > 0:
                dk = datetime.fromtimestamp(ts_v).strftime("%Y-%m-%d")
                hm_totals[dk] += in_t + ca_t + out_t

        heatmap_days: list[dict] = []
        base_day = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=27)
        max_hm = max(hm_totals.values()) if hm_totals else 1
        for i in range(28):
            d_str = (base_day + timedelta(days=i)).strftime("%Y-%m-%d")
            val = hm_totals.get(d_str, 0)
            if val == 0:
                lv = 0
            else:
                ratio = val / max_hm
                lv = 1 if ratio < 0.25 else 2 if ratio < 0.5 else 3 if ratio < 0.78 else 4
            heatmap_days.append({"date": d_str, "total": val, "level": lv})

        # Main filtered query
        rows = conn.execute(
            """
            SELECT conversation_id, gen_idx, ts, model_id, model_name,
                   input_tokens, cache_read_tokens, output_tokens,
                   thinking_tokens, response_tokens, ttft_ms, gen_ms, compacted
            FROM gen_turns
            WHERE ts >= ?
            ORDER BY ts ASC
            """,
            (start_ts,),
        ).fetchall()

        tot_in = tot_ca = tot_out = tot_th = tot_resp = 0
        tot_calls = 0
        ttft_sum = ttft_cnt = 0
        tps_tok_sum = tps_ms_sum = 0

        series_map: dict[str, dict] = {}
        model_map: dict[str, dict] = {}
        project_map: dict[str, dict] = {}
        subagent_role_map: dict[str, dict] = {}
        conv_acc: dict[str, dict] = {}

        main_tokens = 0
        sub_tokens = 0
        main_conv_ids: set[str] = set()
        sub_conv_ids: set[str] = set()

        for (
            cid,
            g_idx,
            ts_v,
            model_id,
            model_name,
            in_t,
            ca_t,
            out_t,
            th_t,
            resp_t,
            ttft_ms,
            gen_ms,
            compacted,
        ) in rows:
            m_info = get_meta(cid)
            root_info = get_meta(m_info["root_id"])
            proj_name = root_info["project"] if root_info["workspace"] else m_info["project"]
            ws_path = root_info["workspace"] or m_info["workspace"]

            if project_filter and proj_name != project_filter:
                continue
            if model_filter and model_name != model_filter:
                continue

            tot = in_t + ca_t + out_t
            tot_in += in_t
            tot_ca += ca_t
            tot_out += out_t
            tot_th += th_t
            tot_resp += resp_t
            tot_calls += 1

            if 0 < ttft_ms < 180_000:
                ttft_sum += ttft_ms
                ttft_cnt += 1
            if 50 < gen_ms < 300_000 and out_t > 0:
                tps_tok_sum += out_t
                tps_ms_sum += gen_ms

            # Time bucket
            if ts_v > 0:
                dt = datetime.fromtimestamp(ts_v)
                b_key = dt.strftime("%Y-%m-%d %H:00") if bucket_mode == "hour" else dt.strftime("%Y-%m-%d")
                b_lbl = dt.strftime("%H:00") if bucket_mode == "hour" else dt.strftime("%m/%d")
            else:
                b_key = "unknown"
                b_lbl = "未知"
            b = series_map.get(b_key)
            if b is None:
                b = {
                    "key": b_key,
                    "label": b_lbl,
                    "input": 0,
                    "cache_read": 0,
                    "thinking": 0,
                    "response": 0,
                    "output": 0,
                    "total": 0,
                    "calls": 0,
                }
                series_map[b_key] = b
            b["input"] += in_t
            b["cache_read"] += ca_t
            b["thinking"] += th_t
            b["response"] += resp_t
            b["output"] += out_t
            b["total"] += tot
            b["calls"] += 1

            # Model breakdown
            mm = model_map.get(model_name)
            if mm is None:
                mm = {
                    "model_id": model_id,
                    "model_name": model_name,
                    "calls": 0,
                    "input": 0,
                    "cache_read": 0,
                    "thinking": 0,
                    "response": 0,
                    "output": 0,
                    "total": 0,
                    "ttft_sum": 0,
                    "ttft_cnt": 0,
                    "tps_tok": 0,
                    "tps_ms": 0,
                }
                model_map[model_name] = mm
            mm["calls"] += 1
            mm["input"] += in_t
            mm["cache_read"] += ca_t
            mm["thinking"] += th_t
            mm["response"] += resp_t
            mm["output"] += out_t
            mm["total"] += tot
            if 0 < ttft_ms < 180_000:
                mm["ttft_sum"] += ttft_ms
                mm["ttft_cnt"] += 1
            if 50 < gen_ms < 300_000 and out_t > 0:
                mm["tps_tok"] += out_t
                mm["tps_ms"] += gen_ms

            # Project breakdown (attributed to root project)
            pm = project_map.get(proj_name)
            if pm is None:
                pm = {
                    "project": proj_name,
                    "workspace": ws_path,
                    "main_sessions": set(),
                    "subagents": set(),
                    "calls": 0,
                    "input": 0,
                    "cache_read": 0,
                    "thinking": 0,
                    "response": 0,
                    "output": 0,
                    "total": 0,
                    "by_model": defaultdict(lambda: [0, 0, 0, 0]),
                }
                project_map[proj_name] = pm
            pm["calls"] += 1
            pm["input"] += in_t
            pm["cache_read"] += ca_t
            pm["thinking"] += th_t
            pm["response"] += resp_t
            pm["output"] += out_t
            pm["total"] += tot
            bm = pm["by_model"][model_name]
            bm[0] += in_t
            bm[1] += ca_t
            bm[2] += th_t
            bm[3] += resp_t

            is_sub = m_info["depth"] > 0 or bool(m_info["parent_id"])
            if is_sub:
                sub_tokens += tot
                sub_conv_ids.add(cid)
                pm["subagents"].add(cid)
                pm["main_sessions"].add(m_info["root_id"])
                role = m_info["agent_name"] or "subagent"
                rm = subagent_role_map.get(role)
                if rm is None:
                    rm = {
                        "role": role,
                        "sessions": set(),
                        "calls": 0,
                        "input": 0,
                        "cache_read": 0,
                        "thinking": 0,
                        "response": 0,
                        "output": 0,
                        "total": 0,
                        "session_turns": defaultdict(int),
                    }
                    subagent_role_map[role] = rm
                rm["sessions"].add(cid)
                rm["calls"] += 1
                rm["input"] += in_t
                rm["cache_read"] += ca_t
                rm["thinking"] += th_t
                rm["response"] += resp_t
                rm["output"] += out_t
                rm["total"] += tot
                rm["session_turns"][cid] += 1
            else:
                main_tokens += tot
                main_conv_ids.add(cid)
                pm["main_sessions"].add(cid)

            # Per-conversation accumulator
            ca = conv_acc.get(cid)
            if ca is None:
                ca = {
                    "id": cid,
                    "root_id": m_info["root_id"],
                    "parent_id": m_info["parent_id"],
                    "is_subagent": is_sub,
                    "role": m_info["agent_name"] or ("subagent" if is_sub else ""),
                    "title": m_info["title"],
                    "project": proj_name,
                    "workspace": ws_path,
                    "turns": 0,
                    "input": 0,
                    "cache_read": 0,
                    "thinking": 0,
                    "response": 0,
                    "output": 0,
                    "total": 0,
                    "first_ts": ts_v,
                    "last_ts": ts_v,
                    "model_counts": defaultdict(int),
                    "by_model": defaultdict(lambda: [0, 0, 0, 0]),
                }
                conv_acc[cid] = ca
            ca["turns"] += 1
            ca["input"] += in_t
            ca["cache_read"] += ca_t
            ca["thinking"] += th_t
            ca["response"] += resp_t
            ca["output"] += out_t
            ca["total"] += tot
            if ts_v > 0:
                if ca["first_ts"] == 0 or ts_v < ca["first_ts"]:
                    ca["first_ts"] = ts_v
                if ts_v > ca["last_ts"]:
                    ca["last_ts"] = ts_v
            ca["model_counts"][model_name] += 1
            cm = ca["by_model"][model_name]
            cm[0] += in_t
            cm[1] += ca_t
            cm[2] += th_t
            cm[3] += resp_t

        # Build tree-merged sessions (group subagents under root_id)
        root_groups: dict[str, dict] = {}
        for cid, ca in conv_acc.items():
            rid = ca["root_id"] if ca["is_subagent"] else cid
            grp = root_groups.get(rid)
            if grp is None:
                rmeta = get_meta(rid)
                grp = {
                    "id": rid,
                    "title": rmeta["title"],
                    "project": rmeta["project"],
                    "workspace": rmeta["workspace"],
                    "main_turns": 0,
                    "sub_turns": 0,
                    "main_total": 0,
                    "sub_total": 0,
                    "input": 0,
                    "cache_read": 0,
                    "thinking": 0,
                    "response": 0,
                    "output": 0,
                    "total": 0,
                    "last_ts": rmeta["last_modified_ts"],
                    "model_counts": defaultdict(int),
                    "by_model": defaultdict(lambda: [0, 0, 0, 0]),
                    "children": [],
                }
                root_groups[rid] = grp

            grp["input"] += ca["input"]
            grp["cache_read"] += ca["cache_read"]
            grp["thinking"] += ca["thinking"]
            grp["response"] += ca["response"]
            grp["output"] += ca["output"]
            grp["total"] += ca["total"]
            if ca["last_ts"] > grp["last_ts"]:
                grp["last_ts"] = ca["last_ts"]
            for mn, cnt in ca["model_counts"].items():
                grp["model_counts"][mn] += cnt
            for mn, arr in ca["by_model"].items():
                gm = grp["by_model"][mn]
                gm[0] += arr[0]
                gm[1] += arr[1]
                gm[2] += arr[2]
                gm[3] += arr[3]

            if ca["is_subagent"]:
                grp["sub_turns"] += ca["turns"]
                grp["sub_total"] += ca["total"]
                top_m = max(ca["model_counts"].items(), key=lambda kv: kv[1])[0] if ca["model_counts"] else "Unknown"
                grp["children"].append(
                    {
                        "id": ca["id"],
                        "role": ca["role"] or "subagent",
                        "title": ca["title"],
                        "primary_model": top_m,
                        "turns": ca["turns"],
                        "input": ca["input"],
                        "cache_read": ca["cache_read"],
                        "thinking": ca["thinking"],
                        "response": ca["response"],
                        "output": ca["output"],
                        "total": ca["total"],
                        "last_ts": ca["last_ts"],
                        "by_model": {
                            k: {"input": v[0], "cache_read": v[1], "thinking": v[2], "response": v[3]}
                            for k, v in ca["by_model"].items()
                        },
                    }
                )
            else:
                grp["main_turns"] += ca["turns"]
                grp["main_total"] += ca["total"]

        # Format output collections
        series_list = sorted(series_map.values(), key=lambda x: x["key"])
        # Fill missing dates for 7d/30d so spline charts never look sparse
        if bucket_mode == "day" and range_key in ("7d", "30d"):
            days_n = 7 if range_key == "7d" else 30
            start_d = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days_n - 1)
            filled = []
            for i in range(days_n):
                d = start_d + timedelta(days=i)
                k = d.strftime("%Y-%m-%d")
                if k in series_map:
                    filled.append(series_map[k])
                else:
                    filled.append(
                        {
                            "key": k,
                            "label": d.strftime("%m/%d"),
                            "input": 0,
                            "cache_read": 0,
                            "thinking": 0,
                            "response": 0,
                            "output": 0,
                            "total": 0,
                            "calls": 0,
                        }
                    )
            series_list = filled

        models_out = []
        for mm in sorted(model_map.values(), key=lambda x: x["total"], reverse=True):
            denom = mm["input"] + mm["cache_read"]
            hit = round((mm["cache_read"] / denom) * 100, 1) if denom > 0 else 0.0
            avg_ttft = round(mm["ttft_sum"] / mm["ttft_cnt"]) if mm["ttft_cnt"] > 0 else 0
            avg_tps = round(mm["tps_tok"] / (mm["tps_ms"] / 1000.0), 1) if mm["tps_ms"] > 0 else 0.0
            models_out.append(
                {
                    "model_id": mm["model_id"],
                    "model_name": mm["model_name"],
                    "calls": mm["calls"],
                    "input": mm["input"],
                    "cache_read": mm["cache_read"],
                    "thinking": mm["thinking"],
                    "response": mm["response"],
                    "output": mm["output"],
                    "total": mm["total"],
                    "cache_hit_rate": hit,
                    "avg_ttft_ms": avg_ttft,
                    "avg_tps": avg_tps,
                }
            )

        projects_out = []
        for pm in sorted(project_map.values(), key=lambda x: x["total"], reverse=True):
            denom = pm["input"] + pm["cache_read"]
            hit = round((pm["cache_read"] / denom) * 100, 1) if denom > 0 else 0.0
            projects_out.append(
                {
                    "project": pm["project"],
                    "workspace": pm["workspace"],
                    "main_sessions": len(pm["main_sessions"]),
                    "subagents": len(pm["subagents"]),
                    "calls": pm["calls"],
                    "input": pm["input"],
                    "cache_read": pm["cache_read"],
                    "thinking": pm["thinking"],
                    "response": pm["response"],
                    "output": pm["output"],
                    "total": pm["total"],
                    "cache_hit_rate": hit,
                    "by_model": {
                        k: {"input": v[0], "cache_read": v[1], "thinking": v[2], "response": v[3]}
                        for k, v in pm["by_model"].items()
                    },
                }
            )

        roles_out = []
        high_turn_subagents = 0
        for rm in sorted(subagent_role_map.values(), key=lambda x: x["total"], reverse=True):
            over_10 = sum(1 for tcnt in rm["session_turns"].values() if tcnt >= 10)
            high_turn_subagents += over_10
            roles_out.append(
                {
                    "role": rm["role"],
                    "sessions": len(rm["sessions"]),
                    "calls": rm["calls"],
                    "input": rm["input"],
                    "cache_read": rm["cache_read"],
                    "thinking": rm["thinking"],
                    "response": rm["response"],
                    "output": rm["output"],
                    "total": rm["total"],
                    "high_turn_count": over_10,
                }
            )

        sessions_out = []
        for grp in sorted(root_groups.values(), key=lambda x: x["total"], reverse=True)[:50]:
            top_m = max(grp["model_counts"].items(), key=lambda kv: kv[1])[0] if grp["model_counts"] else "Unknown"
            denom = grp["input"] + grp["cache_read"]
            hit = round((grp["cache_read"] / denom) * 100, 1) if denom > 0 else 0.0
            grp["children"].sort(key=lambda c: c["total"], reverse=True)
            total_children_count = len(grp["children"])
            sessions_out.append(
                {
                    "id": grp["id"],
                    "title": grp["title"],
                    "project": grp["project"],
                    "workspace": grp["workspace"],
                    "primary_model": top_m,
                    "main_turns": grp["main_turns"],
                    "sub_turns": grp["sub_turns"],
                    "main_total": grp["main_total"],
                    "sub_total": grp["sub_total"],
                    "input": grp["input"],
                    "cache_read": grp["cache_read"],
                    "thinking": grp["thinking"],
                    "response": grp["response"],
                    "output": grp["output"],
                    "total": grp["total"],
                    "cache_hit_rate": hit,
                    "last_ts": grp["last_ts"],
                    "children_count": total_children_count,
                    "children": grp["children"][:20],
                    "by_model": {
                        k: {"input": v[0], "cache_read": v[1], "thinking": v[2], "response": v[3]}
                        for k, v in grp["by_model"].items()
                    },
                }
            )

        total_tokens = tot_in + tot_ca + tot_out
        denom_all = tot_in + tot_ca
        cache_hit_all = round((tot_ca / denom_all) * 100, 1) if denom_all > 0 else 0.0
        thinking_ratio = round((tot_th / tot_out) * 100, 1) if tot_out > 0 else 0.0
        sub_share = round((sub_tokens / total_tokens) * 100, 1) if total_tokens > 0 else 0.0

        total_indexed = conn.execute("SELECT COUNT(*) FROM indexed_files").fetchone()[0]

        return {
            "sync": sync_info,
            "total_indexed_dbs": total_indexed,
            "range": range_key,
            "bucket_mode": bucket_mode,
            "summary": {
                "total": total_tokens,
                "input": tot_in,
                "cache_read": tot_ca,
                "output": tot_out,
                "thinking": tot_th,
                "response": tot_resp,
                "calls": tot_calls,
                "cache_hit_rate": cache_hit_all,
                "thinking_ratio": thinking_ratio,
                "avg_ttft_ms": round(ttft_sum / ttft_cnt) if ttft_cnt > 0 else 0,
                "avg_tps": round(tps_tok_sum / (tps_ms_sum / 1000.0), 1) if tps_ms_sum > 0 else 0.0,
                "main_sessions": len(root_groups),
                "subagent_sessions": len(sub_conv_ids),
                "subagent_share": sub_share,
            },
            "rolling_5h": rolling_5h,
            "series": series_list,
            "heatmap": heatmap_days,
            "models": models_out,
            "projects": projects_out,
            "subagents": {
                "main_tokens": main_tokens,
                "sub_tokens": sub_tokens,
                "sub_share": sub_share,
                "total_calls": sum(r["calls"] for r in roles_out),
                "total_sessions": len(sub_conv_ids),
                "high_turn_count": high_turn_subagents,
                "roles": roles_out,
            },
            "sessions": sessions_out,
            "filters": {
                "projects": all_projects,
                "models": all_models,
            },
        }
    finally:
        conn.close()


def query_session_detail(agy_dir: Path, data_dir: Path, conv_id: str) -> dict:
    sync_index(agy_dir, data_dir, force=False)
    conn = open_index_db(data_dir)
    try:
        meta_row = conn.execute(
            """
            SELECT conversation_id, title, workspace, project_name,
                   parent_id, root_id, nesting_depth, agent_name, last_modified_ts
            FROM conv_meta WHERE conversation_id = ?
            """,
            (conv_id,),
        ).fetchone()

        if meta_row:
            meta = {
                "id": meta_row[0],
                "title": meta_row[1],
                "workspace": meta_row[2],
                "project": meta_row[3] or "无工作区（临时对话）",
                "parent_id": meta_row[4],
                "root_id": meta_row[5] or conv_id,
                "depth": meta_row[6],
                "agent_name": meta_row[7],
                "last_ts": meta_row[8],
            }
        else:
            meta = {
                "id": conv_id,
                "title": f"会话 {conv_id[:8]}",
                "workspace": "",
                "project": "无工作区（临时对话）",
                "parent_id": "",
                "root_id": conv_id,
                "depth": 0,
                "agent_name": "",
                "last_ts": 0,
            }

        turns = []
        tot_in = tot_ca = tot_out = tot_th = tot_resp = 0
        by_model: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])

        for pos, row in enumerate(
            conn.execute(
                """
                SELECT gen_idx, ts, model_id, model_name,
                       input_tokens, cache_read_tokens, output_tokens,
                       thinking_tokens, response_tokens, ttft_ms, gen_ms,
                       step_count, compacted
                FROM gen_turns
                WHERE conversation_id = ?
                ORDER BY gen_idx ASC
                """,
                (conv_id,),
            )
        ):
            (
                g_idx,
                ts_v,
                m_id,
                m_name,
                in_t,
                ca_t,
                out_t,
                th_t,
                resp_t,
                ttft_ms,
                gen_ms,
                scnt,
                compacted,
            ) = row
            tot_in += in_t
            tot_ca += ca_t
            tot_out += out_t
            tot_th += th_t
            tot_resp += resp_t
            bm = by_model[m_name]
            bm[0] += in_t
            bm[1] += ca_t
            bm[2] += th_t
            bm[3] += resp_t

            ctx_len = in_t + ca_t
            hit = round((ca_t / ctx_len) * 100, 1) if ctx_len > 0 else 0.0
            turns.append(
                {
                    "turn": pos + 1,
                    "gen_idx": g_idx,
                    "ts": ts_v,
                    "model_id": m_id,
                    "model_name": m_name,
                    "input": in_t,
                    "cache_read": ca_t,
                    "context_tokens": ctx_len,
                    "output": out_t,
                    "thinking": th_t,
                    "response": resp_t,
                    "total": ctx_len + out_t,
                    "cache_hit_rate": hit,
                    "ttft_ms": ttft_ms,
                    "gen_ms": gen_ms,
                    "step_count": scnt,
                    "compacted": bool(compacted),
                }
            )

        # Tool footprint for this conversation
        tools = []
        raw_tools = conn.execute(
            """
            SELECT tool_name, call_count, est_tokens
            FROM tool_usage
            WHERE conversation_id = ?
            ORDER BY est_tokens DESC, call_count DESC
            LIMIT 12
            """,
            (conv_id,),
        ).fetchall()
        tool_tok_sum = sum(r[2] for r in raw_tools) + tot_th
        for tname, cnt, etok in raw_tools:
            pct = round((etok / tool_tok_sum) * 100, 1) if tool_tok_sum > 0 else 0.0
            tools.append({"tool": tname, "calls": cnt, "tokens": etok, "share": pct})
        if tot_th > 0:
            pct = round((tot_th / tool_tok_sum) * 100, 1) if tool_tok_sum > 0 else 0.0
            tools.append({"tool": "Thinking（深度推理）", "calls": len(turns), "tokens": tot_th, "share": pct})
            tools.sort(key=lambda x: x["tokens"], reverse=True)
            tools = tools[:12]

        # Children subagents under this conversation (if it is a root)
        children = []
        for crow in conn.execute(
            """
            SELECT cm.conversation_id, cm.agent_name, cm.title,
                   COUNT(gt.gen_idx),
                   COALESCE(SUM(gt.input_tokens),0),
                   COALESCE(SUM(gt.cache_read_tokens),0),
                   COALESCE(SUM(gt.thinking_tokens),0),
                   COALESCE(SUM(gt.response_tokens),0),
                   COALESCE(SUM(gt.output_tokens),0),
                   COALESCE(MAX(gt.model_name), 'Unknown')
            FROM conv_meta cm
            LEFT JOIN gen_turns gt ON gt.conversation_id = cm.conversation_id
            WHERE cm.root_id = ? AND cm.conversation_id != ?
            GROUP BY cm.conversation_id
            ORDER BY (COALESCE(SUM(gt.input_tokens),0) + COALESCE(SUM(gt.cache_read_tokens),0) + COALESCE(SUM(gt.output_tokens),0)) DESC
            """,
            (conv_id, conv_id),
        ):
            c_tot = crow[4] + crow[5] + crow[8]
            if c_tot == 0 and crow[3] == 0:
                continue
            children.append(
                {
                    "id": crow[0],
                    "role": crow[1] or "subagent",
                    "title": crow[2],
                    "turns": crow[3],
                    "input": crow[4],
                    "cache_read": crow[5],
                    "thinking": crow[6],
                    "response": crow[7],
                    "output": crow[8],
                    "total": c_tot,
                    "primary_model": crow[9],
                }
            )

        denom = tot_in + tot_ca
        return {
            "meta": meta,
            "summary": {
                "turns": len(turns),
                "input": tot_in,
                "cache_read": tot_ca,
                "thinking": tot_th,
                "response": tot_resp,
                "output": tot_out,
                "total": tot_in + tot_ca + tot_out,
                "cache_hit_rate": round((tot_ca / denom) * 100, 1) if denom > 0 else 0.0,
                "peak_context": max((t["context_tokens"] for t in turns), default=0),
                "compaction_count": sum(1 for t in turns if t["compacted"]),
            },
            "by_model": {
                k: {"input": v[0], "cache_read": v[1], "thinking": v[2], "response": v[3]}
                for k, v in by_model.items()
            },
            "turns": turns,
            "tools": tools,
            "children": children,
        }
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="AGY Token Analytics Parser")
    ap.add_argument("--agy-dir", default=str(default_agy_dir()))
    ap.add_argument("--data-dir", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_sync = sub.add_parser("sync")
    p_sync.add_argument("--force", action="store_true")

    p_dash = sub.add_parser("dashboard")
    p_dash.add_argument("--range", default="7d", choices=["5h", "today", "7d", "30d", "all"])
    p_dash.add_argument("--project", default="")
    p_dash.add_argument("--model", default="")
    p_dash.add_argument("--skip-sync", action="store_true")

    p_sess = sub.add_parser("session")
    p_sess.add_argument("--id", required=True)

    args = ap.parse_args()
    agy_dir = Path(args.agy_dir)
    data_dir = Path(args.data_dir)

    if args.cmd == "sync":
        out = sync_index(agy_dir, data_dir, force=args.force)
    elif args.cmd == "dashboard":
        out = query_dashboard(
            agy_dir,
            data_dir,
            range_key=args.range,
            project_filter=args.project,
            model_filter=args.model,
            skip_sync=args.skip_sync,
        )
    elif args.cmd == "session":
        out = query_session_detail(agy_dir, data_dir, conv_id=args.id)
    else:
        raise ValueError(f"Unknown command: {args.cmd}")

    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
