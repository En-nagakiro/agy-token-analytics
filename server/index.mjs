import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import {
  DEFAULT_PRICES,
  enrichDashboardWithCosts,
  enrichSessionDetailWithCosts,
  loadConfig,
  saveConfig,
} from './pricing.mjs';

// ---------------------------------------------------------------------------
// Paths & CLI Flags
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const CLI = parseArgs(process.argv);
const SCRIPT_DIR = typeof __dirname !== 'undefined' ? __dirname : dirname(process.argv[1]);
const PLUGIN_ROOT = CLI['plugin-root']
  ? resolve(CLI['plugin-root'])
  : resolve(SCRIPT_DIR, '..');
const DATA_DIR = CLI['data-dir']
  ? resolve(CLI['data-dir'])
  : join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-token-analytics');
const AGY_DIR = CLI['agy-dir']
  ? resolve(CLI['agy-dir'])
  : join(process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini'), 'antigravity');

const PARSER_SCRIPT = join(PLUGIN_ROOT, 'parser', 'engine.py');
const UI_HTML_PATH =
  process.env.AGY_TOKEN_ANALYTICS_HTML || join(PLUGIN_ROOT, 'dist', 'ui', 'index.html');
const APP_URI = 'ui://agy-token-analytics/dashboard.html';

// ---------------------------------------------------------------------------
// Python Bridge (UTF-8, zero-pollution, deduplicated sync)
// ---------------------------------------------------------------------------

const PYTHON_CANDIDATES =
  process.platform === 'win32'
    ? [
        ['python', []],
        ['py', ['-3']],
        ['python3', []],
      ]
    : [
        ['python3', []],
        ['python', []],
      ];

let detectedPython = null;

function execPromise(cmd, args, timeout = 45000) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || 'Python failed').trim()));
        } else {
          resolvePromise(stdout);
        }
      },
    );
  });
}

async function getPython() {
  if (detectedPython) return detectedPython;
  for (const [cmd, pre] of PYTHON_CANDIDATES) {
    try {
      const ver = await execPromise(cmd, [...pre, '--version'], 5000);
      if (/^Python 3\./i.test(ver.trim())) {
        detectedPython = { cmd, pre };
        return detectedPython;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error('未检测到 Python 3，请确认 Python 3 已加入系统 PATH。');
}

async function callParser(subArgs) {
  const { cmd, pre } = await getPython();
  const fullArgs = [
    ...pre,
    PARSER_SCRIPT,
    '--agy-dir',
    AGY_DIR,
    '--data-dir',
    DATA_DIR,
    ...subArgs,
  ];
  const raw = await execPromise(cmd, fullArgs, 60000);
  return JSON.parse(raw);
}

// Serialize concurrent sync calls so simultaneous UI requests never contend on SQLite writes
let inflightSync = null;
async function ensureSynced(force = false) {
  if (inflightSync && !force) return inflightSync;
  const p = callParser(force ? ['sync', '--force'] : ['sync']).finally(() => {
    if (inflightSync === p) inflightSync = null;
  });
  inflightSync = p;
  return p;
}

// ---------------------------------------------------------------------------
// Local Language Server Live Quota Client (Graceful Degradation)
// ---------------------------------------------------------------------------

function lsRequest(method, body) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) {
    return Promise.reject(new Error('NO_LS_ENV'));
  }
  const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
  const data = JSON.stringify(body);
  const transport = base.protocol === 'https:' ? https : http;
  return new Promise((resolvePromise, reject) => {
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 4000,
        rejectUnauthorized: false,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${method}: HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolvePromise(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(data);
  });
}

function stripVariantSuffix(label) {
  return String(label || '').replace(/\s*\((Low|Medium|High|XHigh|Fast|Thinking)\)\s*$/i, '').trim();
}

function derivePoolTitle(models) {
  const joined = models.join(' ');
  const hasGemini = /gemini|orchestrator/i.test(joined);
  const hasClaude = /claude/i.test(joined);
  const hasGpt = /gpt|o[134]/i.test(joined);
  if (hasClaude && hasGpt && !hasGemini) return 'Claude & GPT 共享配额池';
  if (hasClaude && !hasGemini) return 'Claude 系列配额池';
  if (hasGemini && !hasClaude && !hasGpt) {
    const allFlash = models.length > 0 && models.every((m) => /flash/i.test(m));
    if (allFlash) return 'Gemini Flash 配额池';
    return 'Gemini 共享配额池';
  }
  if (hasGpt && !hasGemini && !hasClaude) return 'GPT 系列配额池';
  const baseNames = [...new Set(models.map(stripVariantSuffix).filter(Boolean))];
  return baseNames.slice(0, 2).join(' / ') || '模型配额池';
}

function groupQuotasFromModels(items) {
  // Models sharing identical remainingFraction + resetTime belong to the exact same backend quota pool
  const bucketMap = new Map();
  for (const item of items) {
    const q = item.quotaInfo;
    if (!q || typeof q.remainingFraction !== 'number') continue;
    const pct = Math.max(0, Math.min(100, q.remainingFraction * 100));
    const resetTime = q.resetTime || '';
    const key = `${pct.toFixed(3)}|${resetTime}`;
    if (!bucketMap.has(key)) {
      bucketMap.set(key, {
        remainingPct: Number(pct.toFixed(1)),
        resetTime,
        models: [],
      });
    }
    const entry = bucketMap.get(key);
    const baseName = stripVariantSuffix(item.label);
    if (baseName && !entry.models.includes(baseName)) {
      entry.models.push(baseName);
    }
  }

  const pools = Array.from(bucketMap.values())
    .map((p) => {
      const status = p.remainingPct < 15 ? 'bad' : p.remainingPct < 45 ? 'warn' : 'ok';
      return {
        name: derivePoolTitle(p.models),
        remainingPct: p.remainingPct,
        resetTime: p.resetTime,
        models: p.models,
        status,
        modelsText: p.models.slice(0, 4).join(' · ') + (p.models.length > 4 ? ` +${p.models.length - 4}` : ''),
      };
    })
    .sort((a, b) => a.remainingPct - b.remainingPct);

  return pools;
}

async function fetchLiveQuota() {
  const payload = { metadata: { ideName: 'antigravity', extensionName: 'antigravity' } };
  try {
    const resp = await lsRequest('GetUserStatus', payload);
    const configs = resp?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const items = configs.map((c) => ({
      label: c.label || c.modelId || '',
      quotaInfo: c.quotaInfo,
    }));
    const pools = groupQuotasFromModels(items);
    if (pools.length > 0) {
      return {
        live: true,
        source: 'GetUserStatus',
        tier: resp?.userStatus?.userTier?.name || resp?.userStatus?.planStatus?.planInfo?.planName || '',
        pools,
        updatedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    if (err.message === 'NO_LS_ENV') {
      return {
        live: false,
        reason: '当前 MCP Server 进程未注入本地 Language Server 地址，已自动切换为近 5 小时本地滚动消耗监控。',
        pools: [],
        updatedAt: new Date().toISOString(),
      };
    }
  }

  // Fallback RPC: GetAvailableModels
  try {
    const resp = await lsRequest('GetAvailableModels', payload);
    const modelsObj = resp?.response?.models || resp?.models || {};
    const items = Object.entries(modelsObj).map(([id, m]) => ({
      label: m?.displayName || id,
      quotaInfo: m?.quotaInfo,
    }));
    const pools = groupQuotasFromModels(items);
    if (pools.length > 0) {
      return {
        live: true,
        source: 'GetAvailableModels',
        tier: '',
        pools,
        updatedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    return {
      live: false,
      reason: `本地配额服务暂不可用（${err.message}），已自动降级为本地 5 小时滚动消耗统计。`,
      pools: [],
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    live: false,
    reason: '未从本地服务解析到模型配额字段，已自动降级为本地 5 小时滚动消耗统计。',
    pools: [],
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Formatting Helpers (for Model-visible compact summaries & CSV export)
// ---------------------------------------------------------------------------

function fmtTok(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

function fmtMoney(usd, config) {
  const v = Number(usd || 0);
  if (config.currency === 'CNY') return `¥${(v * config.fxRate).toFixed(2)}`;
  return `$${v.toFixed(2)}`;
}

function buildCompactSummaryText(dash, quota, config) {
  const s = dash.summary;
  const lines = [
    `## AGY Token 用量摘要（范围：${dash.range}，已索引 ${dash.total_indexed_dbs} 个本地会话）`,
    `- **总 Token**：${fmtTok(s.total)}（非缓存输入 ${fmtTok(s.input)} / 缓存读取 ${fmtTok(s.cache_read)} / Thinking ${fmtTok(s.thinking)} / 回复 ${fmtTok(s.response)}）`,
    `- **缓存命中率**：${s.cache_hit_rate}%（Prompt Cache 估算节省 ${fmtMoney(s.saved_usd, config)}）`,
    `- **等效 API 费用**：${fmtMoney(s.cost_usd, config)}${s.has_reference_pricing ? '（含部分新模型参考价）' : ''}`,
    `- **会话结构**：${s.main_sessions} 主会话 + ${s.subagent_sessions} 子代理（子代理占总耗 ${s.subagent_share}%）`,
  ];
  if (dash.models.length) {
    lines.push(
      `- **Top 模型**：` +
        dash.models
          .slice(0, 3)
          .map((m) => `${m.model_name} ${fmtTok(m.total)} (${fmtMoney(m.cost_usd, config)})`)
          .join('；'),
    );
  }
  if (dash.projects.length) {
    lines.push(
      `- **Top 项目**：` +
        dash.projects
          .slice(0, 3)
          .map((p) => `${p.project} ${fmtTok(p.total)} (${fmtMoney(p.cost_usd, config)})`)
          .join('；'),
    );
  }
  if (quota?.live && quota.pools?.length) {
    lines.push(
      `- **实时配额池**：` +
        quota.pools.slice(0, 4).map((p) => `${p.name} 剩余 ${p.remainingPct}%`).join('；'),
    );
  }
  return lines.join('\n');
}

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsvReport(dash, config) {
  const fx = config.currency === 'CNY' ? config.fxRate : 1;
  const cur = config.currency;
  const header = [
    'SessionID',
    'Title',
    'Project',
    'PrimaryModel',
    'MainTurns',
    'SubagentCount',
    'TotalTokens',
    'FreshInput',
    'CacheRead',
    'Thinking',
    'Response',
    'CacheHitPct',
    `EstCost_${cur}`,
    `CacheSaved_${cur}`,
    'LastActive',
  ];
  const rows = [header.join(',')];
  for (const s of dash.sessions || []) {
    const dt = s.last_ts ? new Date(s.last_ts * 1000).toISOString() : '';
    rows.push(
      [
        s.id,
        s.title,
        s.project,
        s.primary_model,
        s.main_turns,
        s.children_count ?? (s.children || []).length,
        s.total,
        s.input,
        s.cache_read,
        s.thinking,
        s.response,
        s.cache_hit_rate,
        (s.cost_usd * fx).toFixed(4),
        (s.saved_usd * fx).toFixed(4),
        dt,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return '\uFEFF' + rows.join('\r\n');
}

// ---------------------------------------------------------------------------
// Data Loading Pipeline
// ---------------------------------------------------------------------------

async function loadFullDashboard({ range = '7d', project = '', model = '', forceSync = false } = {}) {
  const config = loadConfig(DATA_DIR);
  const syncInfo = await ensureSynced(Boolean(forceSync));
  const args = ['dashboard', '--range', range, '--skip-sync'];
  if (project) args.push('--project', project);
  if (model) args.push('--model', model);
  const raw = await callParser(args);
  raw.sync = syncInfo;
  return {
    dashboard: enrichDashboardWithCosts(raw, config),
    config,
  };
}

// ---------------------------------------------------------------------------
// MCP Server & Tools Registration
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'agy-token-analytics',
  version: '1.0.0',
});

// 1. UI Resource (single-file self-contained MCP App HTML)
registerAppResource(
  server,
  'AGY Token Analytics Dashboard',
  APP_URI,
  {
    description: 'Antigravity 2.0 本地只读 Token 用量与实时配额交互分析大盘',
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  async () => {
    if (!existsSync(UI_HTML_PATH)) {
      throw new Error(`Dashboard UI bundle not found at ${UI_HTML_PATH}. Run npm run build first.`);
    }
    const html = readFileSync(UI_HTML_PATH, 'utf8');
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    };
  },
);

// 2. Model + App Tool: Entrypoint Dashboard (global sidebar + aux side pane + inline)
registerAppTool(
  server,
  'open_usage_dashboard',
  {
    title: 'AGY Token 分析',
    description:
      '打开 Antigravity 本地 Token 用量、实时模型池配额、项目与子代理归因、等效费用分析大盘。所有参数均可留空打开默认近 7 天总览。',
    inputSchema: {
      range: z.enum(['5h', 'today', '7d', '30d', 'all']).optional().describe('时间范围，默认 7d'),
      tab: z
        .enum(['overview', 'models', 'projects', 'subagents', 'sessions'])
        .optional()
        .describe('默认打开的 Tab'),
      project: z.string().optional().describe('按工作区项目名筛选'),
      model: z.string().optional().describe('按模型名筛选'),
    },
    annotations: { readOnlyHint: true },
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'global', title: 'Token 分析' },
          { type: 'aux_pane', title: 'Token 分析' },
        ],
      },
    },
  },
  async (args = {}) => {
    const range = args.range || '7d';
    const [{ dashboard, config }, quota] = await Promise.all([
      loadFullDashboard({ range, project: args.project || '', model: args.model || '' }),
      fetchLiveQuota(),
    ]);

    return {
      content: [{ type: 'text', text: buildCompactSummaryText(dashboard, quota, config) }],
      structuredContent: {
        initialTab: args.tab || 'overview',
        dashboard,
        quota,
        config,
        defaultPrices: DEFAULT_PRICES,
      },
    };
  },
);

// 3. Model-friendly Compact Query Tool (protects context window)
server.registerTool(
  'query_usage_summary',
  {
    title: '查询 AGY Token 用量摘要',
    description:
      '按时间范围、项目或模型查询本机 Antigravity 的精确 Token 消耗、缓存命中率、等效费用、子代理占比与实时配额摘要（返回紧凑文本，低上下文占用）。',
    inputSchema: {
      range: z.enum(['5h', 'today', '7d', '30d', 'all']).optional().describe('统计时间范围，默认 7d'),
      project: z.string().optional().describe('按项目名精确筛选'),
      model: z.string().optional().describe('按模型名精确筛选'),
    },
    annotations: { readOnlyHint: true },
  },
  async (args = {}) => {
    const range = args.range || '7d';
    const [{ dashboard, config }, quota] = await Promise.all([
      loadFullDashboard({ range, project: args.project || '', model: args.model || '' }),
      fetchLiveQuota(),
    ]);
    const text = buildCompactSummaryText(dashboard, quota, config);
    return {
      content: [{ type: 'text', text }],
    };
  },
);

// 4. Model-friendly Session Diagnostics Tool
server.registerTool(
  'inspect_session_usage',
  {
    title: '诊断高消耗会话与轮次明细',
    description:
      '查看指定会话（或近期消耗最高的 Top N 会话）的轮次增长趋势、缓存命中率、上下文压缩次数、子代理消耗及最费 Token 的工具分布，用于给出省 Token 优化建议。',
    inputSchema: {
      session_id: z.string().optional().describe('会话 UUID；留空则自动诊断区间内最消耗 Token 的会话'),
      range: z.enum(['5h', 'today', '7d', '30d', 'all']).optional().describe('当 session_id 留空时的筛选范围，默认 7d'),
      top_n: z.number().int().min(1).max(5).optional().describe('当 session_id 留空时返回前 N 个高耗会话，默认 3'),
    },
    annotations: { readOnlyHint: true },
  },
  async (args = {}) => {
    const config = loadConfig(DATA_DIR);
    if (args.session_id) {
      const raw = await callParser(['session', '--id', args.session_id]);
      const detail = enrichSessionDetailWithCosts(raw, config);
      const s = detail.summary;
      const topTools = detail.tools
        .slice(0, 6)
        .map((t) => `  - ${t.tool}: ${fmtTok(t.tokens)} (${t.calls} 次, ${t.share}%)`)
        .join('\n');
      const text = [
        `### 会话诊断：${detail.meta.title} (\`${detail.meta.id.slice(0, 8)}\`)`,
        `- **项目**：${detail.meta.project} | **轮次**：${s.turns} 轮 | **峰值上下文**：${fmtTok(s.peak_context)} | **压缩次数**：${s.compaction_count}`,
        `- **总耗**：${fmtTok(s.total)}（输入 ${fmtTok(s.input)} / 缓存 ${fmtTok(s.cache_read)} / Thinking ${fmtTok(s.thinking)} / 回复 ${fmtTok(s.response)}）`,
        `- **缓存命中率**：${s.cache_hit_rate}% | **等效费用**：${fmtMoney(s.cost_usd, config)} | **下属子代理数**：${detail.children.length}`,
        `- **高耗步骤 / 工具分布**：\n${topTools || '  - 暂无记录'}`,
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    }

    const { dashboard } = await loadFullDashboard({ range: args.range || '7d' });
    const topN = (dashboard.sessions || []).slice(0, args.top_n || 3);
    if (!topN.length) {
      return { content: [{ type: 'text', text: '该时间范围内暂无会话消耗记录。' }] };
    }
    const blocks = [];
    for (const s of topN) {
      const raw = await callParser(['session', '--id', s.id]);
      const topTools = (raw.tools || [])
        .slice(0, 3)
        .map((t) => `${t.tool} (${fmtTok(t.tokens)})`)
        .join('、');
      blocks.push(
        `- **${s.title}** (\`${s.id.slice(0, 8)}\`)\n` +
          `  - 项目：${s.project} | 主模型：${s.primary_model} | 总耗：${fmtTok(s.total)}（主 ${fmtTok(s.main_total)} + ${s.children_count} 子代理 ${fmtTok(s.sub_total)}）\n` +
          `  - 等效费用：${fmtMoney(s.cost_usd, config)} | 缓存命中：${s.cache_hit_rate}% | 高耗工具：${topTools || '无'}`,
      );
    }
    return {
      content: [{ type: 'text', text: `### 近 ${dashboard.range} 最消耗 Token 的 Top ${topN.length} 会话\n${blocks.join('\n')}` }],
    };
  },
);

// 5. App-Only Tools (Hidden from model -> 0 context window overhead)
const APP_ONLY_META = { ui: { visibility: ['app'] } };

registerAppTool(
  server,
  'app_get_dashboard',
  {
    description: 'App internal: fetch filtered dashboard analytics',
    inputSchema: {
      range: z.enum(['5h', 'today', '7d', '30d', 'all']).optional(),
      project: z.string().optional(),
      model: z.string().optional(),
      forceSync: z.boolean().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async (args = {}) => {
    const { dashboard, config } = await loadFullDashboard({
      range: args.range || '7d',
      project: args.project || '',
      model: args.model || '',
      forceSync: Boolean(args.forceSync),
    });
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { dashboard, config },
    };
  },
);

registerAppTool(
  server,
  'app_get_session_detail',
  {
    description: 'App internal: fetch turn-by-turn drilldown for a conversation',
    inputSchema: {
      conversationId: z.string().min(4),
    },
    _meta: APP_ONLY_META,
  },
  async ({ conversationId }) => {
    const config = loadConfig(DATA_DIR);
    const raw = await callParser(['session', '--id', conversationId]);
    const detail = enrichSessionDetailWithCosts(raw, config);
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { detail },
    };
  },
);

registerAppTool(
  server,
  'app_get_live_quota',
  {
    description: 'App internal: refresh live local Language Server quotas',
    inputSchema: {},
    _meta: APP_ONLY_META,
  },
  async () => {
    const quota = await fetchLiveQuota();
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { quota },
    };
  },
);

registerAppTool(
  server,
  'app_get_config',
  {
    description: 'App internal: read pricing, currency, FX, and appearance preferences',
    inputSchema: {},
    _meta: APP_ONLY_META,
  },
  async () => {
    const config = loadConfig(DATA_DIR);
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { config, defaultPrices: DEFAULT_PRICES },
    };
  },
);

registerAppTool(
  server,
  'app_save_config',
  {
    description: 'App internal: persist pricing, currency, FX, and appearance preferences',
    inputSchema: {
      currency: z.enum(['CNY', 'USD']).optional(),
      fxRate: z.number().positive().optional(),
      appearance: z
        .object({
          palette: z.enum(['glacier', 'sky', 'dawn']).optional(),
          font: z
            .enum(['comic', 'times', 'garamond', 'baskerville', 'century', 'candara', 'editorial', 'humanist'])
            .optional(),
        })
        .optional(),
      prices: z
        .record(
          z.string(),
          z.object({
            input: z.number().min(0),
            cacheRead: z.number().min(0),
            output: z.number().min(0),
            isReference: z.boolean().optional(),
          }),
        )
        .optional(),
      resetPrices: z.boolean().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async (args = {}) => {
    const config = saveConfig(DATA_DIR, args);
    return {
      content: [{ type: 'text', text: 'saved' }],
      structuredContent: { config },
    };
  },
);

registerAppTool(
  server,
  'app_export_report',
  {
    description: 'App internal: export current filtered usage report as CSV or JSON',
    inputSchema: {
      format: z.enum(['csv', 'json']),
      range: z.enum(['5h', 'today', '7d', '30d', 'all']).optional(),
      project: z.string().optional(),
      model: z.string().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ format, range = '7d', project = '', model = '' }) => {
    const { dashboard, config } = await loadFullDashboard({ range, project, model });
    const exportDir = join(DATA_DIR, 'exports');
    mkdirSync(exportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `agy-token-${range}-${stamp}.${format}`;
    const savedPath = join(exportDir, filename);

    const payload =
      format === 'csv'
        ? buildCsvReport(dashboard, config)
        : JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              currency: config.currency,
              fxRate: config.fxRate,
              summary: dashboard.summary,
              models: dashboard.models,
              projects: dashboard.projects,
              sessions: dashboard.sessions,
            },
            null,
            2,
          );

    writeFileSync(savedPath, payload, 'utf8');
    return {
      content: [{ type: 'text', text: savedPath }],
      structuredContent: {
        filename,
        savedPath,
        mimeType: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
        data: payload,
      },
    };
  },
);

// ---------------------------------------------------------------------------
// Start Stdio Transport
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[agy-token-analytics] fatal error:', err);
  process.exit(1);
});
