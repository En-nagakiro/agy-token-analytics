# AGY Token Analytics (`agy-token-analytics`)

A **100% local, read-only** Token Usage, Live Quota & Turn-by-Turn Diagnostics **MCP App plugin** for **Google Antigravity 2.0 Desktop**.

面向 **Google Antigravity 2.0 桌面版** 的纯本地只读 Token 用量、实时模型池配额与轮次级诊断 **MCP App** 原生插件。

---

## Features / 核心特性

- **Native MCP App Multi-Entrypoint (原生全入口)**
  - **Left Sidebar Full-Page Dashboard (`global`)**: Wide-screen analytics workspace.
  - **Right Auxiliary Side Pane (`aux_pane`)**: Compact side view with one-click **"Send to AI for Diagnostics"** (`发给 AI 诊断`).
  - **In-Chat AI Queries & Pricing Sync**: 4 lightweight tools are exposed to the model (dashboard entry, compact summary, session diagnostics, and `sync_pricing_catalog`); all heavy dashboard queries and exports are isolated as `app-only` tools (`visibility: ["app"]`) with **zero model context overhead**.
- **AI-Driven Live Pricing & FX Updates (大模型联网更新汇率与最新报价)**
  - The plugin itself remains 100% offline with zero outbound requests. Simply ask Antigravity *"更新 AGY Token 分析的汇率、受支持模型与最新报价"* (or click **"让 AI 更新汇率与报价"** in the settings drawer): the bundled `update-pricing` skill guides the model to inspect locally observed models, verify current USD→CNY FX rates and official API pricing via web search, and write verified updates safely back via `sync_pricing_catalog`.
- **100% Local Read-Only & Millisecond Incremental Sync (纯本地只读 & 毫秒级增量索引)**
  - Zero-dependency Python 3 parser reads `~/.gemini/antigravity/conversations/*.db` and `conversation_summaries.db` strictly in read-only mode (`mode=ro`, `PRAGMA query_only = ON`, and `immutable=1` for static DBs without an active WAL so zero `-wal`/`-shm` sidecars are created).
  - Caches parsed turn metrics incrementally in `${PLUGIN_DATA}/usage_index.sqlite` — hundreds of conversations sync in tens of milliseconds on subsequent opens.
- **4-Dimensional Token Breakdown & Cost Estimator (四维 Token 拆分与等效费用)**
  - Accurate protobuf decoding of **Non-cached Input / Cache Read / Thinking / Response**, **Prompt Cache hit rate & estimated savings**, **TTFT**, and **generation throughput (tok/s)**.
  - Editable per-model pricing table (USD per 1M tokens) + **USD / CNY** toggle with custom FX rate persisted locally; unknown new models automatically fall back by model family with a `"参考"` (reference) badge.
- **Live Model Pool Quotas with Graceful Fallback (实时配额池与优雅降级)**
  - Reads real-time model pool remaining percentages and reset countdowns via the local Language Server RPC (`GetUserStatus` / `GetAvailableModels`), automatically grouping models that share the same quota pool.
  - When unavailable in sandboxed environments, seamlessly degrades to a **local 5-hour rolling window consumption monitor**.
- **Recursive Subagent Attribution & Turn Drilldown (多级子代理树状归并 & 轮次下钻)**
  - Merges multi-level subagent token burn under root conversations, expands child subagents on demand, renders **Turn-by-Turn context curves** with automatic **Context Compaction** markers, and ranks top token-consuming tools.
- **Clean Luminous UI (干净明亮多主题与字体偏好)**
  - Ships with **3 luminous palettes** (Glacier Mint / Porcelain Sky / Alabaster Dawn) and **8 curated typography pairings**, zero external CDN dependencies (fully single-file bundled to satisfy strict MCP App CSP), and **CSV (UTF-8 BOM) / JSON** report export.

---

## Quick Install / 快速安装（免构建开箱即用）

Pre-built bundles (`dist/server.cjs` and single-file `dist/ui/index.html`) are committed in this repository, so you only need **Node.js 20+** and **Python 3.10+**.

### Option 1: Antigravity CLI (Recommended)

```bash
agy plugin install https://github.com/<your-username>/agy-token-analytics
```

### Option 2: Direct `git clone`

**Windows (PowerShell 7):**
```powershell
git clone https://github.com/<your-username>/agy-token-analytics.git "$HOME\.gemini\config\plugins\agy-token-analytics"
```

**macOS / Linux:**
```bash
git clone https://github.com/<your-username>/agy-token-analytics.git "${HOME}/.gemini/config/plugins/agy-token-analytics"
```

Antigravity 2.0 auto-discovers plugins in `~/.gemini/config/plugins/`. Open **Token 分析** from the left sidebar or the right auxiliary pane `+` menu.

---

## Development & Build from Source / 源码开发与构建

```bash
git clone https://github.com/<your-username>/agy-token-analytics.git
cd agy-token-analytics
npm install
```

- **Windows (PowerShell 7)** — test, build, deploy to `~/.gemini/config/plugins/agy-token-analytics`, and live-refresh MCP server:
  ```powershell
  pwsh -NoProfile -NonInteractive -File .\scripts\deploy.ps1
  ```
- **macOS / Linux**:
  ```bash
  bash ./scripts/deploy.sh
  ```

### Project Layout / 目录结构

```text
agy-token-analytics/
├── plugin.json             # Antigravity plugin manifest
├── mcp_config.json         # MCP server launch config (${PLUGIN_ROOT}, ${PLUGIN_DATA})
├── assets/logo.svg         # Plugin icon
├── parser/
│   ├── engine.py           # Zero-dependency Python 3 read-only incremental SQLite & protobuf engine
│   └── test_engine.py      # Unit & local DB regression tests
├── server/
│   ├── index.mjs           # Node.js MCP Server (4 model tools + 6 app-only tools + live quota client)
│   └── pricing.mjs         # Configurable pricing table, family fallback, USD/CNY & cache savings math
├── skills/
│   └── update-pricing/     # Built-in skill guiding the AI to verify & sync live FX rates and model pricing
├── web/
│   ├── index.html          # Vite single-file entry
│   ├── vite.config.mjs     # vite-plugin-singlefile config
│   └── src/                # Self-contained MCP App frontend (@modelcontextprotocol/ext-apps)
├── dist/                   # Pre-built self-contained bundles (server.cjs + ui/index.html)
└── scripts/
    ├── deploy.ps1          # Windows PowerShell 7 build & deploy script
    └── deploy.sh           # macOS / Linux build & deploy script
```

---

## Privacy & Security / 隐私与安全声明

- **No network telemetry**: The plugin makes **zero** external network requests. The single-file frontend loads no remote scripts, styles, or fonts.
- **Strictly read-only on Antigravity databases**: Source conversation databases are opened with SQLite `mode=ro` + `PRAGMA query_only = ON`. All caches, preferences, and exported reports are stored exclusively inside `${PLUGIN_DATA}`.

## License

[MIT](./LICENSE)
