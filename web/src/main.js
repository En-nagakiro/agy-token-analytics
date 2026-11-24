import { App } from '@modelcontextprotocol/ext-apps';
import './styles.css';

// ============================================================================
// State & Constants
// ============================================================================

const PALETTE_OPTIONS = [
  { id: 'glacier', label: '冰川清透' },
  { id: 'sky', label: '晴空瓷白' },
  { id: 'dawn', label: '晨光暖白' },
];

const FONT_OPTIONS = [
  { id: 'comic', label: 'Comic Sans MS', preview: '"Comic Sans MS", cursive' },
  { id: 'times', label: 'Times New Roman', preview: '"Times New Roman", serif' },
  { id: 'garamond', label: 'Garamond', preview: '"Garamond", serif' },
  { id: 'baskerville', label: 'Baskerville', preview: '"Baskerville Old Face", serif' },
  { id: 'century', label: 'Century Gothic', preview: '"Century Gothic", sans-serif' },
  { id: 'candara', label: 'Candara Light', preview: '"Candara", sans-serif' },
  { id: 'editorial', label: 'Georgia Pro', preview: '"Georgia Pro Light", serif' },
  { id: 'humanist', label: 'Gill Sans Nova', preview: '"Gill Sans Nova", sans-serif' },
];

const STATE = {
  connected: false,
  canMessageHost: false,
  canUpdateContext: false,
  loading: true,
  refreshing: false,
  error: '',
  tab: 'overview',
  range: '7d',
  projectFilter: '',
  modelFilter: '',
  chartMode: 'spline', // spline | pills
  searchQuery: '',
  expandedSessionId: null,
  showAllChildrenFor: new Set(),
  selectedSessionId: null,
  sessionDetail: null,
  sessionLoading: false,
  drawerOpen: false,
  aiPromptPreview: '',
  dashboard: null,
  quota: null,
  config: {
    currency: 'CNY',
    fxRate: 7.25,
    appearance: { palette: 'glacier', font: 'comic' },
    prices: {},
  },
  defaultPrices: {},
};

const app = new App({ name: 'AGY Token Analytics', version: '1.0.0' }, {});

// ============================================================================
// Formatting Helpers
// ============================================================================

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTok(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k`;
  return String(v);
}

function fmtCost(usd) {
  const v = Number(usd || 0);
  if (STATE.config.currency === 'CNY') {
    const cny = v * (STATE.config.fxRate || 7.25);
    return `¥${cny >= 1000 ? cny.toFixed(0) : cny.toFixed(2)}`;
  }
  return `$${v >= 1000 ? v.toFixed(0) : v.toFixed(2)}`;
}

function fmtTime(ts) {
  if (!ts) return '未知时间';
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function fmtCountdown(iso) {
  if (!iso) return '滚动刷新';
  const diffMs = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return iso;
  if (diffMs <= 0) return '即将重置';
  const mins = Math.floor(diffMs / 60000);
  const days = Math.floor(mins / 1440);
  const hrs = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days > 0) return `${days}d ${hrs}h 后重置`;
  if (hrs > 0) return `${hrs}h ${m}m 后重置`;
  return `${m}m 后重置`;
}

function fmtLatency(ms) {
  const v = Number(ms || 0);
  if (v <= 0) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${v}ms`;
}

function smoothPath(points) {
  if (points.length < 2) return '';
  let d = `M ${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[0] - p1[0]) / 6;
    d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

// ============================================================================
// Toast, Tooltip & Appearance
// ============================================================================

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function showTooltip(e, html) {
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  tip.innerHTML = html;
  tip.classList.remove('hidden');
  const x = Math.min(window.innerWidth - 220, e.clientX + 14);
  const y = Math.max(10, e.clientY - 76);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideTooltip() {
  const tip = document.getElementById('tooltip');
  if (tip) tip.classList.add('hidden');
}

function applyAppearance() {
  const pal = STATE.config?.appearance?.palette || 'glacier';
  const font = STATE.config?.appearance?.font || 'comic';
  document.body.className = `pal-${pal} font-${font}`;
}

// ============================================================================
// Server Calls (App-Only Tools)
// ============================================================================

async function fetchDashboard({ forceSync = false } = {}) {
  STATE.refreshing = true;
  render();
  try {
    const res = await app.callServerTool({
      name: 'app_get_dashboard',
      arguments: {
        range: STATE.range,
        project: STATE.projectFilter || undefined,
        model: STATE.modelFilter || undefined,
        forceSync,
      },
    });
    const sc = res?.structuredContent;
    if (sc?.dashboard) {
      STATE.dashboard = sc.dashboard;
      if (sc.config) STATE.config = sc.config;
      applyAppearance();
      STATE.loading = false;
      STATE.error = '';
      // Auto-select first session if none selected or not in current list
      const sessions = STATE.dashboard.sessions || [];
      if (sessions.length && (!STATE.selectedSessionId || !sessions.some((s) => s.id === STATE.selectedSessionId))) {
        STATE.selectedSessionId = sessions[0].id;
        STATE.sessionDetail = null;
      }
      if (forceSync) {
        showToast(`增量同步完成 · 耗时 ${sc.dashboard.sync?.elapsed_ms ?? 0}ms`);
      }
    }
  } catch (err) {
    STATE.error = err?.message || String(err);
    showToast(`拉取失败：${STATE.error}`);
  } finally {
    STATE.refreshing = false;
    STATE.loading = false;
    render();
    if (STATE.tab === 'sessions' && STATE.selectedSessionId && !STATE.sessionDetail) {
      loadSessionDetail(STATE.selectedSessionId);
    }
  }
}

async function fetchQuota() {
  try {
    const res = await app.callServerTool({
      name: 'app_get_live_quota',
      arguments: {},
    });
    if (res?.structuredContent?.quota) {
      STATE.quota = res.structuredContent.quota;
      render();
    }
  } catch {
    // Graceful no-op
  }
}

async function loadSessionDetail(conversationId) {
  if (!conversationId) return;
  STATE.selectedSessionId = conversationId;
  STATE.sessionLoading = true;
  render();
  try {
    const res = await app.callServerTool({
      name: 'app_get_session_detail',
      arguments: { conversationId },
    });
    if (res?.structuredContent?.detail && STATE.selectedSessionId === conversationId) {
      STATE.sessionDetail = res.structuredContent.detail;
    }
  } catch (err) {
    showToast(`加载会话详情失败：${err?.message || err}`);
  } finally {
    STATE.sessionLoading = false;
    render();
  }
}

async function persistConfig(patch, reloadDashboard = true) {
  try {
    const res = await app.callServerTool({
      name: 'app_save_config',
      arguments: patch,
    });
    if (res?.structuredContent?.config) {
      STATE.config = res.structuredContent.config;
      applyAppearance();
    }
    if (reloadDashboard) {
      await fetchDashboard({ forceSync: false });
    } else {
      render();
    }
  } catch (err) {
    showToast(`保存配置失败：${err?.message || err}`);
  }
}

async function exportReport(format) {
  try {
    const res = await app.callServerTool({
      name: 'app_export_report',
      arguments: {
        format,
        range: STATE.range,
        project: STATE.projectFilter || undefined,
        model: STATE.modelFilter || undefined,
      },
    });
    const sc = res?.structuredContent;
    if (!sc) return;
    // Trigger browser download as convenience AND show saved disk path
    try {
      const blob = new Blob([sc.data], { type: sc.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = sc.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      // Fallback already saved to disk
    }
    showToast(`已导出至：${sc.savedPath}`);
  } catch (err) {
    showToast(`导出失败：${err?.message || err}`);
  }
}

async function sendSessionToAI() {
  const d = STATE.sessionDetail;
  if (!d) return;
  const s = d.summary;
  const topTools = (d.tools || [])
    .slice(0, 6)
    .map((t) => `- ${t.tool}：约 ${fmtTok(t.tokens)}（${t.calls} 次，占 ${t.share}%）`)
    .join('\n');
  const promptText = [
    `请帮我诊断以下 Antigravity 会话的 Token 消耗瓶颈，并给出具体可执行的省 Token 优化建议：`,
    `- 会话标题：${d.meta.title} (${d.meta.id.slice(0, 8)})`,
    `- 所属项目：${d.meta.project}`,
    `- 总消耗：${fmtTok(s.total)}（非缓存输入 ${fmtTok(s.input)} / 缓存读 ${fmtTok(s.cache_read)} / Thinking ${fmtTok(s.thinking)} / 回复 ${fmtTok(s.response)}）`,
    `- 轮次：${s.turns} 轮 | 峰值上下文：${fmtTok(s.peak_context)} | 压缩次数：${s.compaction_count} | 缓存命中率：${s.cache_hit_rate}%`,
    `- 等效费用：${fmtCost(s.cost_usd)} | 下属子代理数：${(d.children || []).length}`,
    `- 高耗步骤 / 工具分布：\n${topTools || '- 暂无记录'}`,
  ].join('\n');

  try {
    if (STATE.canMessageHost) {
      await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: promptText }],
      });
      showToast('已将诊断摘要发送给当前对话 AI');
    } else if (STATE.canUpdateContext) {
      await app.updateModelContext({
        content: [{ type: 'text', text: promptText }],
      });
      showToast('已附加上下文到对话输入框，发消息即可让 AI 诊断');
    }
  } catch (err) {
    showToast(`发送失败：${err?.message || err}`);
  }
}

function buildPricingUpdatePrompt() {
  const refModels = (STATE.dashboard?.models || [])
    .filter((m) => m.is_reference)
    .map((m) => m.model_name);
  const allSeen = (STATE.dashboard?.filters?.models || []).slice(0, 12);
  return [
    '请帮我联网更新 AGY Token 分析插件的 USD→CNY 实时汇率、受支持模型列表和最新官方 API 报价：',
    '1. 先调用 `sync_pricing_catalog(action="inspect")` 查看当前单价表和本机历史用过的模型；',
    '2. 联网核实今日 USD→CNY 实时汇率以及 Google Gemini / Anthropic Claude / OpenAI 官方 API 最新每百万 Token 报价（分别列出 input / cacheRead / output）；',
    ...(refModels.length ? [`3. 重点核查当前走参考价的模型：${refModels.join('、')}（若尚无官方公开报价，请保留 isReference=true 并注明依据）；`] : []),
    ...(allSeen.length && !refModels.length ? [`3. 本机已用模型包括：${allSeen.join('、')}；`] : []),
    '4. 调用 `sync_pricing_catalog(action="update", ...)` 写入更新，并向我列出变更前后对比与官方来源链接。',
  ].join('\n');
}

async function askAIToUpdatePricing() {
  const promptText = buildPricingUpdatePrompt();
  if (STATE.canMessageHost) {
    try {
      await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: promptText }],
      });
      STATE.drawerOpen = false;
      STATE.aiPromptPreview = '';
      render();
      showToast('已发给当前对话 AI 联网更新，完成后点「同步」生效');
      return;
    } catch (err) {
      showToast(`直接发送失败：${err?.message || err}`);
    }
  } else if (STATE.canUpdateContext) {
    try {
      await app.updateModelContext({
        content: [{ type: 'text', text: promptText }],
      });
      STATE.drawerOpen = false;
      STATE.aiPromptPreview = '';
      render();
      showToast('已附加更新指令到输入框，发送任意消息即可让 AI 执行');
      return;
    } catch (err) {
      showToast(`附加上下文失败：${err?.message || err}`);
    }
  }

  // Global view fallback (no owning conversation): copy prompt & reveal inline box
  STATE.aiPromptPreview = promptText;
  render();
  try {
    await navigator.clipboard.writeText(promptText);
    showToast('已复制更新指令，粘贴到任意对话即可让 AI 自动更新');
  } catch {
    showToast('全页模式无法直接发消息，请复制下方指令粘贴到对话中执行');
  }
}

// ============================================================================
// Chart Renderers (Zero external charting deps — pure crisp SVG)
// ============================================================================

function renderTrendChart(series) {
  if (!series || !series.length) {
    return `<div class="well subtle" style="text-align:center; padding:42px 16px;">当前筛选范围内暂无 Token 记录</div>`;
  }
  const maxV = Math.max(...series.map((d) => d.total), 1) * 1.14;
  const W = 620;
  const H = 205;
  const padL = 44;
  const padR = 14;
  const padT = 14;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const xAt = (i) =>
    series.length === 1 ? padL + plotW / 2 : padL + (i / (series.length - 1)) * plotW;
  const yAt = (v) => padT + plotH - (v / maxV) * plotH;

  const gridLines = [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = padT + plotH * (1 - f);
      return `
        <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"
              stroke="rgba(11,37,41,0.065)" stroke-dasharray="3 4" />
        <text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end"
              fill="#7FA0A6" font-size="10.5" class="en-font">${esc(fmtTok(maxV * f))}</text>`;
    })
    .join('');

  const labelStep = series.length > 14 ? Math.ceil(series.length / 7) : series.length > 8 ? 2 : 1;

  if (STATE.chartMode === 'pills') {
    const bw = Math.max(8, Math.min(22, Math.floor((plotW / series.length) * 0.52)));
    const bars = series
      .map((d, i) => {
        const cx = padL + ((i + 0.5) / series.length) * plotW;
        let y = padT + plotH;
        const segs = [
          { h: (d.cache_read / maxV) * plotH, c: 'var(--c-cache)' },
          { h: (d.input / maxV) * plotH, c: 'var(--c-input)' },
          { h: (d.thinking / maxV) * plotH, c: 'var(--c-think)' },
          { h: (d.response / maxV) * plotH, c: 'var(--c-out)' },
        ]
          .filter((s) => s.h > 0.4)
          .map((s) => {
            y -= s.h;
            return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${Math.max(2, s.h - 1.5).toFixed(1)}" rx="4" fill="${s.c}" opacity="0.9" />`;
          })
          .join('');
        const showLbl = i % labelStep === 0 || i === series.length - 1;
        return `
          <g class="trend-pt" data-idx="${i}" style="cursor:pointer">
            <rect x="${(cx - Math.max(bw, 22) / 2).toFixed(1)}" y="${padT}" width="${Math.max(bw, 22)}" height="${plotH}" fill="transparent" />
            ${segs}
            ${showLbl ? `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="#7FA0A6" font-size="10.5" class="en-font">${esc(d.label)}</text>` : ''}
          </g>`;
      })
      .join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:206px; overflow:visible;">${gridLines}${bars}</svg>`;
  }

  const pts = series.map((d, i) => [xAt(i), yAt(d.total)]);
  const line = series.length > 1 ? smoothPath(pts) : '';
  const area =
    series.length > 1
      ? `${line} L ${pts[pts.length - 1][0].toFixed(1)},${(padT + plotH).toFixed(1)} L ${pts[0][0].toFixed(1)},${(padT + plotH).toFixed(1)} Z`
      : '';

  const hotspots = series
    .map((d, i) => {
      const [x, y] = pts[i];
      const showLbl = i % labelStep === 0 || i === series.length - 1;
      const hitW = Math.max(16, plotW / Math.max(series.length, 1));
      return `
        <g class="trend-pt" data-idx="${i}" style="cursor:pointer">
          <rect x="${(x - hitW / 2).toFixed(1)}" y="${padT}" width="${hitW.toFixed(1)}" height="${plotH}" fill="transparent" />
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${series.length <= 10 ? 3.5 : 2.5}"
                  fill="#FFFFFF" stroke="var(--brand)" stroke-width="2" />
          ${showLbl ? `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="#7FA0A6" font-size="10.5" class="en-font">${esc(d.label)}</text>` : ''}
        </g>`;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:206px; overflow:visible;">
      <defs>
        <linearGradient id="strokeGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="var(--brand)" />
          <stop offset="100%" stop-color="var(--brand-2)" />
        </linearGradient>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--brand)" stop-opacity="0.22" />
          <stop offset="100%" stop-color="var(--brand-2)" stop-opacity="0.0" />
        </linearGradient>
      </defs>
      ${gridLines}
      ${area ? `<path d="${area}" fill="url(#areaGrad)" />` : ''}
      ${line ? `<path d="${line}" fill="none" stroke="url(#strokeGrad)" stroke-width="2.4" stroke-linecap="round" />` : ''}
      ${hotspots}
    </svg>`;
}

function renderQuotaPanel(quota, rolling5h) {
  if (quota?.live && quota.pools?.length) {
    const rings = quota.pools
      .slice(0, 4)
      .map((p, idx) => {
        const r = 22;
        const c = 2 * Math.PI * r;
        const off = c * (1 - Math.max(0.025, p.remainingPct / 100));
        const [c1, c2, badgeCls, badgeTxt] =
          p.status === 'bad'
            ? ['#FB7185', '#F43F5E', 'badge-bad', '紧张']
            : p.status === 'warn'
              ? ['#FBBF24', '#F59E0B', 'badge-warn', '注意']
              : ['#06B6D4', '#0D9488', 'badge-ok', '充裕'];
        return `
          <div class="well interactive quota-item ease">
            <div class="ring-wrap">
              <svg viewBox="0 0 54 54">
                <defs>
                  <linearGradient id="qg-${idx}" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="${c1}" />
                    <stop offset="100%" stop-color="${c2}" />
                  </linearGradient>
                </defs>
                <circle cx="27" cy="27" r="${r}" fill="none" stroke="rgba(11,37,41,0.07)" stroke-width="4.2" />
                <circle cx="27" cy="27" r="${r}" fill="none" stroke="url(#qg-${idx})" stroke-width="4.2"
                        stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" />
              </svg>
              <div class="ring-val num">${Math.round(p.remainingPct)}%</div>
            </div>
            <div style="min-width:0; flex:1;">
              <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                <span class="en-font" style="font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(p.name)}</span>
                <span class="badge ${badgeCls}">${badgeTxt}</span>
              </div>
              <div class="subtle" style="font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px;">${esc(p.modelsText)}</div>
              <div class="muted num" style="font-size:11.5px; margin-top:3px;">${esc(fmtCountdown(p.resetTime))}</div>
            </div>
          </div>`;
      })
      .join('');

    return `
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
        <div>
          <div class="en-font" style="font-size:15px; font-weight:500;">Live Model Quotas</div>
          <div class="subtle" style="font-size:11.5px;">本地服务直连${quota.tier ? ` · ${esc(quota.tier)}` : ''}</div>
        </div>
        <button id="btn-refresh-quota" class="pill-btn" style="padding:4px 10px;">刷新配额</button>
      </div>
      <div class="quota-list">${rings}</div>`;
  }

  // Graceful fallback: Local 5-hour rolling window consumption monitor
  const r5 = rolling5h || { total: 0, input: 0, cache_read: 0, thinking: 0, response: 0, calls: 0 };
  const denom = Math.max(r5.input + r5.cache_read, 1);
  const hit5 = ((r5.cache_read / denom) * 100).toFixed(1);
  return `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
      <div>
        <div class="en-font" style="font-size:15px; font-weight:500;">5-Hour Rolling Window</div>
        <div class="subtle" style="font-size:11.5px;">本地只读滚动统计（自动降级模式）</div>
      </div>
      <span class="badge badge-brand">本地模式</span>
    </div>
    <div class="well" style="margin-bottom:12px;">
      <div class="subtle" style="font-size:11.5px;">近 5 小时累计消耗</div>
      <div class="stat-figure num" style="margin-top:4px;">${esc(fmtTok(r5.total))}</div>
      <div class="muted num" style="font-size:12px; margin-top:6px;">
        ${r5.calls} 次模型调用 · 缓存命中 ${hit5}%
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:10px; font-size:11.5px;" class="num muted">
        <span>新输入：${esc(fmtTok(r5.input))}</span>
        <span>缓存读：${esc(fmtTok(r5.cache_read))}</span>
        <span>Thinking：${esc(fmtTok(r5.thinking))}</span>
        <span>回复：${esc(fmtTok(r5.response))}</span>
      </div>
    </div>
    <div class="subtle" style="font-size:11.5px; line-height:1.5;">
      ${esc(quota?.reason || '当前进程未连接到本地配额服务，已自动切换为近 5 小时本地消耗统计。')}
    </div>`;
}

function renderTurnCurve(turns) {
  if (!turns || !turns.length) {
    return `<div class="subtle" style="padding:24px; text-align:center;">该会话暂无轮次消耗记录</div>`;
  }
  const W = 440;
  const H = 132;
  const padL = 12;
  const padR = 12;
  const padT = 22;
  const padB = 22;
  const vals = turns.map((t) => t.context_tokens || t.total);
  const max = Math.max(...vals, 1) * 1.12;
  const pts = vals.map((v, i) => [
    turns.length === 1 ? W / 2 : padL + (i / (turns.length - 1)) * (W - padL - padR),
    padT + (H - padT - padB) * (1 - v / max),
  ]);
  const line = turns.length > 1 ? smoothPath(pts) : '';
  const area =
    turns.length > 1
      ? `${line} L ${pts[pts.length - 1][0].toFixed(1)},${H - padB} L ${pts[0][0].toFixed(1)},${H - padB} Z`
      : '';

  const compacts = turns
    .map((t, i) => {
      if (!t.compacted) return '';
      const cx = pts[i][0];
      return `
        <line x1="${cx.toFixed(1)}" y1="${padT - 4}" x2="${cx.toFixed(1)}" y2="${H - padB}"
              stroke="var(--warn)" stroke-dasharray="3 3" stroke-width="1.3" />
        <text x="${cx.toFixed(1)}" y="12" text-anchor="middle" fill="var(--warn)" font-size="10">上下文压缩</text>`;
    })
    .join('');

  const dotStep = turns.length > 35 ? Math.ceil(turns.length / 25) : 1;
  const dots = pts
    .map((p, i) => {
      if (i % dotStep !== 0 && i !== turns.length - 1 && !turns[i].compacted) return '';
      return `<circle class="turn-dot" data-tidx="${i}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2"
                      fill="#FFFFFF" stroke="var(--brand)" stroke-width="1.8" style="cursor:pointer" />`;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:136px; overflow:visible;">
      <defs>
        <linearGradient id="tLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="var(--brand)" />
          <stop offset="100%" stop-color="var(--brand-2)" />
        </linearGradient>
        <linearGradient id="tArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--brand)" stop-opacity="0.18" />
          <stop offset="100%" stop-color="var(--brand)" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${compacts}
      ${area ? `<path d="${area}" fill="url(#tArea)" />` : ''}
      ${line ? `<path d="${line}" fill="none" stroke="url(#tLine)" stroke-width="2.2" stroke-linecap="round" />` : ''}
      ${dots}
    </svg>
    <div style="display:flex; justify-content:space-between; font-size:11.5px; margin-top:-6px;" class="en-font subtle num">
      <span>Turn 1 · ${esc(fmtTok(vals[0]))}</span>
      <span>Peak ${esc(fmtTok(Math.max(...vals)))}</span>
      <span>Turn ${turns.length} · ${esc(fmtTok(vals[vals.length - 1]))}</span>
    </div>`;
}

// ============================================================================
// Tab Views
// ============================================================================

function renderOverviewTab(dash) {
  const s = dash.summary;
  const hm = dash.heatmap || [];
  return `
    <div class="stack-lg">
      <section class="grid-hero">
        <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; gap:18px;">
          <div style="display:flex; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:12px;">
            <div>
              <div class="label-caps">Total Token Consumption</div>
              <div style="display:flex; align-items:baseline; gap:12px; margin-top:6px; flex-wrap:wrap;">
                <span class="hero-figure num">${esc(fmtTok(s.total))}</span>
                <span class="badge badge-ok num">Cache Hit ${s.cache_hit_rate}%</span>
                ${s.has_reference_pricing ? `<span class="badge badge-warn">含参考价</span>` : ''}
              </div>
              <div class="muted num" style="font-size:12.5px; margin-top:8px;">
                等效 API 费用 <strong class="en-font" style="color:var(--ink-1); font-size:14px;">${esc(fmtCost(s.cost_usd))}</strong>
                <span class="subtle" style="margin:0 8px;">·</span>
                Prompt Cache 节省 <strong class="en-font" style="color:var(--ok); font-size:14px;">${esc(fmtCost(s.saved_usd))}</strong>
              </div>
            </div>

            <div class="seg-group" style="background:var(--surface-soft); border-color:transparent;">
              <button class="seg-btn chart-mode-btn ${STATE.chartMode === 'spline' ? 'active' : ''}" data-cmode="spline">柔光曲线</button>
              <button class="seg-btn chart-mode-btn ${STATE.chartMode === 'pills' ? 'active' : ''}" data-cmode="pills">四维胶囊柱</button>
            </div>
          </div>

          <div>${renderTrendChart(dash.series)}</div>

          <div class="legend-bar num">
            <div class="legend-items">
              <span><i class="dot" style="background:var(--c-cache)"></i>缓存读 <strong class="en-font">${esc(fmtTok(s.cache_read))}</strong></span>
              <span><i class="dot" style="background:var(--c-input)"></i>新输入 <strong class="en-font">${esc(fmtTok(s.input))}</strong></span>
              <span><i class="dot" style="background:var(--c-think)"></i>Thinking <strong class="en-font">${esc(fmtTok(s.thinking))}</strong></span>
              <span><i class="dot" style="background:var(--c-out)"></i>回复 <strong class="en-font">${esc(fmtTok(s.response))}</strong></span>
            </div>
            <span class="en-font subtle">${s.main_sessions} Sessions · ${s.subagent_sessions} Subagents</span>
          </div>
        </div>

        <div class="card" style="display:flex; flex-direction:column; justify-content:space-between;">
          ${renderQuotaPanel(STATE.quota, dash.rolling_5h)}
          <div style="padding-top:12px; margin-top:12px; border-top:1px solid var(--hairline); display:flex; justify-content:space-between; font-size:12px;" class="subtle num">
            <span>近 5h：${esc(fmtTok(dash.rolling_5h?.total || 0))}</span>
            <button id="link-top-sessions" style="border:none; background:transparent; color:var(--brand); cursor:pointer; font-weight:500;">高耗会话 →</button>
          </div>
        </div>
      </section>

      <section class="grid-kpi">
        <div class="card">
          <div class="label-caps">Thinking Ratio</div>
          <div class="stat-figure num">${s.thinking_ratio}<span style="font-size:15px;" class="subtle">%</span></div>
          <div class="muted" style="font-size:12px; margin-top:6px;">占总输出比例（${esc(fmtTok(s.thinking))}）</div>
        </div>
        <div class="card">
          <div class="label-caps">Avg Latency · TTFT</div>
          <div class="stat-figure num">${esc(fmtLatency(s.avg_ttft_ms))}</div>
          <div class="muted en-font num" style="font-size:12px; margin-top:6px;">${s.avg_tps > 0 ? `${s.avg_tps} tokens / sec` : '暂无速度数据'}</div>
        </div>
        <div class="card">
          <div class="label-caps">Subagent Share</div>
          <div class="stat-figure num">${s.subagent_share}<span style="font-size:15px;" class="subtle">%</span></div>
          <div class="muted" style="font-size:12px; margin-top:6px;">已树状归并至主会话</div>
        </div>
        <div class="card">
          <div class="label-caps">28-Day Rhythm</div>
          <div class="heatmap-grid">
            ${hm
              .map((cell) => {
                const ops = [0.07, 0.28, 0.5, 0.75, 1];
                const bg = cell.level === 0 ? 'rgba(11,37,41,0.07)' : 'var(--brand)';
                const op = cell.level === 0 ? 1 : ops[cell.level];
                return `<span class="heat-cell" data-date="${esc(cell.date)}" data-tok="${cell.total}" style="background:${bg}; opacity:${op};"></span>`;
              })
              .join('')}
          </div>
        </div>
      </section>
    </div>`;
}

function renderModelsTab(dash) {
  const models = dash.models || [];
  return `
    <section class="card">
      <div style="display:flex; flex-wrap:wrap; align-items:flex-end; justify-content:space-between; gap:10px; margin-bottom:18px;">
        <div>
          <h2 class="section-title">Model Performance &amp; Cost</h2>
          <div class="subtle" style="font-size:12px; margin-top:3px;">点击模型可按该模型筛选全盘；带「参考」标示的新模型可在右上角自定义单价</div>
        </div>
        <button id="open-pricing-inline" class="pill-btn">编辑单价表 →</button>
      </div>
      ${
        !models.length
          ? `<div class="well subtle" style="text-align:center; padding:32px;">当前范围暂无模型调用记录</div>`
          : `<div class="table-wrap">
              <table class="clean-table">
                <thead>
                  <tr class="en-font">
                    <th>Model</th>
                    <th class="r">Calls</th>
                    <th class="r">Cache Hit</th>
                    <th class="r">Fresh Input</th>
                    <th class="r">Cache Read</th>
                    <th class="r">Thinking</th>
                    <th class="r">Est. Cost</th>
                    <th class="r hide-narrow">TTFT · Speed</th>
                  </tr>
                </thead>
                <tbody class="num">
                  ${models
                    .map(
                      (m) => `
                    <tr class="model-filter-row" data-model="${esc(m.model_name)}" style="cursor:pointer;">
                      <td>
                        <div class="en-font" style="font-weight:500; color:var(--ink-1); display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                          <span>${esc(m.model_name)}</span>
                          ${m.is_reference ? `<span class="badge badge-warn">参考</span>` : ''}
                        </div>
                      </td>
                      <td class="r">${m.calls}</td>
                      <td class="r" style="color:var(--ok); font-weight:500;">${m.cache_hit_rate}%</td>
                      <td class="r">${esc(fmtTok(m.input))}</td>
                      <td class="r" style="color:var(--c-cache);">${esc(fmtTok(m.cache_read))}</td>
                      <td class="r" style="color:var(--c-think);">${esc(fmtTok(m.thinking))}</td>
                      <td class="r en-font" style="font-weight:600; color:var(--ink-1);">${esc(fmtCost(m.cost_usd))}</td>
                      <td class="r en-font subtle hide-narrow">${esc(fmtLatency(m.avg_ttft_ms))} · ${m.avg_tps > 0 ? `${m.avg_tps} t/s` : '—'}</td>
                    </tr>`,
                    )
                    .join('')}
                </tbody>
              </table>
            </div>`
      }
    </section>`;
}

function renderProjectsTab(dash) {
  const projects = dash.projects || [];
  const maxTot = Math.max(...projects.map((p) => p.total), 1);
  const colors = ['var(--c-cache)', 'var(--c-input)', 'var(--c-think)', 'var(--c-out)'];
  return `
    <section class="card">
      <div style="margin-bottom:18px;">
        <h2 class="section-title">Workspace Attribution</h2>
        <div class="subtle" style="font-size:12px; margin-top:3px;">按工作区归集主会话与下属子代理总消耗；点击项目可过滤全局视图</div>
      </div>
      ${
        !projects.length
          ? `<div class="well subtle" style="text-align:center; padding:32px;">当前范围暂无项目记录</div>`
          : `<div>
              ${projects
                .map(
                  (p, idx) => `
                <div class="project-filter-row ease" data-project="${esc(p.project)}"
                     style="padding:14px 10px; border-bottom:1px solid var(--hairline); cursor:pointer; border-radius:12px;">
                  <div style="display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:8px;">
                    <div style="display:flex; align-items:baseline; gap:10px; min-width:0;">
                      <span class="en-font subtle num" style="font-size:12px;">${String(idx + 1).padStart(2, '0')}</span>
                      <span style="font-weight:500; color:var(--ink-1);">${esc(p.project)}</span>
                      <span class="subtle hide-narrow" style="font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(p.workspace || '未绑定目录')}</span>
                    </div>
                    <div class="num" style="display:flex; align-items:baseline; gap:14px; font-size:12.5px;">
                      <span class="en-font muted">${esc(fmtTok(p.total))}</span>
                      <strong class="en-font" style="color:var(--ink-1); font-size:14px;">${esc(fmtCost(p.cost_usd))}</strong>
                    </div>
                  </div>
                  <div style="display:flex; align-items:center; gap:14px; margin-top:9px;">
                    <div class="bar-track" style="flex:1;">
                      <div class="bar-fill" style="width:${((p.total / maxTot) * 100).toFixed(1)}%; background:${colors[idx % 4]};"></div>
                    </div>
                    <span class="subtle num" style="font-size:11.5px; flex-shrink:0;">
                      ${p.main_sessions} 主会话 · ${p.subagents} 子代理 · 命中 ${p.cache_hit_rate}%
                    </span>
                  </div>
                </div>`,
                )
                .join('')}
            </div>`
      }
    </section>`;
}

function renderSubagentsTab(dash) {
  const sub = dash.subagents || { main_tokens: 0, sub_tokens: 0, sub_share: 0, roles: [] };
  const s = dash.summary || {};
  const c = 2 * Math.PI * 15.5;
  const subPct = Math.min(100, Math.max(0, sub.sub_share || 0));
  const mainPct = 100 - subPct;
  const mainArc = (mainPct / 100) * c;
  const subArc = (subPct / 100) * c;
  const avgPerMain = s.main_sessions > 0 ? Math.round((sub.main_tokens || 0) / s.main_sessions) : 0;
  const avgPerSub = sub.total_sessions > 0 ? Math.round((sub.sub_tokens || 0) / sub.total_sessions) : 0;
  const avgSubTurns = sub.total_sessions > 0 ? ((sub.total_calls || 0) / sub.total_sessions).toFixed(1) : '0';
  const roles = (sub.roles || []).slice(0, 16);
  return `
    <section class="grid-2">
      <div class="card" style="display:flex; flex-direction:column; justify-content:flex-start; gap:20px;">
        <div>
          <h2 class="section-title">Main vs. Subagents</h2>
          <div class="subtle" style="font-size:12px; margin-top:3px;">识别后台异步子代理的静默消耗比例</div>
        </div>
        <div style="display:flex; align-items:center; gap:26px; flex-wrap:wrap;">
          <div style="position:relative; width:138px; height:138px; flex-shrink:0;">
            <svg viewBox="0 0 40 40" style="width:138px; height:138px; transform:rotate(-90deg);">
              <circle cx="20" cy="20" r="15.5" fill="none" stroke="rgba(11,37,41,0.06)" stroke-width="3.6" />
              <circle cx="20" cy="20" r="15.5" fill="none" stroke="var(--c-cache)" stroke-width="3.6"
                      stroke-dasharray="${mainArc.toFixed(1)} ${c.toFixed(1)}" stroke-linecap="round" />
              <circle cx="20" cy="20" r="15.5" fill="none" stroke="var(--c-think)" stroke-width="3.6"
                      stroke-dasharray="${subArc.toFixed(1)} ${c.toFixed(1)}" stroke-dashoffset="${(-mainArc).toFixed(1)}" stroke-linecap="round" />
            </svg>
            <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;">
              <span class="display-font num" style="font-size:22px; color:var(--ink-1);">${subPct}%</span>
              <span class="subtle" style="font-size:11px;">子代理占比</span>
            </div>
          </div>
          <div style="flex:1; min-width:160px; display:flex; flex-direction:column; gap:10px; font-size:12.5px;" class="num">
            <div style="display:flex; justify-content:space-between;">
              <span class="muted"><i class="dot" style="background:var(--c-cache)"></i>主会话</span>
              <strong class="en-font">${esc(fmtTok(sub.main_tokens))}</strong>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span class="muted"><i class="dot" style="background:var(--c-think)"></i>后台子代理</span>
              <strong class="en-font">${esc(fmtTok(sub.sub_tokens))}</strong>
            </div>
            <div style="padding-top:10px; border-top:1px solid var(--hairline); font-size:12px;" class="subtle">
              共 ${sub.total_sessions || 0} 个子代理实例（${sub.total_calls || 0} 轮调用）${sub.high_turn_count ? `，其中 <strong style="color:var(--warn)">${sub.high_turn_count}</strong> 个超过 10 轮` : ''}
            </div>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px;">
          <div class="well" style="padding:12px;">
            <div class="subtle" style="font-size:11px;">主会话均值</div>
            <div class="en-font num" style="font-size:16px; font-weight:500; margin-top:4px; color:var(--ink-1);">${esc(fmtTok(avgPerMain))}</div>
          </div>
          <div class="well" style="padding:12px;">
            <div class="subtle" style="font-size:11px;">单子代理均值</div>
            <div class="en-font num" style="font-size:16px; font-weight:500; margin-top:4px; color:var(--ink-1);">${esc(fmtTok(avgPerSub))}</div>
          </div>
          <div class="well" style="padding:12px;">
            <div class="subtle" style="font-size:11px;">子代理均轮次</div>
            <div class="en-font num" style="font-size:16px; font-weight:500; margin-top:4px; color:var(--ink-1);">${avgSubTurns} <span style="font-size:11px;" class="subtle">轮</span></div>
          </div>
        </div>
      </div>

      <div class="card">
        <h2 class="section-title">Subagent Roles</h2>
        <div class="subtle" style="font-size:12px; margin-top:3px; margin-bottom:14px;">按子代理角色聚合调用频次与总消耗</div>
        ${
          !roles.length
            ? `<div class="well subtle" style="text-align:center; padding:32px;">当前范围无子代理记录</div>`
            : `<div class="num" style="font-size:12.5px; max-height:420px; overflow-y:auto; padding-right:4px;">
                ${roles
                  .map(
                    (r, idx) => `
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:11px 0; ${idx < roles.length - 1 ? 'border-bottom:1px solid var(--hairline);' : ''}">
                    <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                      <span class="en-font" style="font-weight:500; color:var(--ink-1); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(r.role)}</span>
                      ${r.high_turn_count ? `<span class="badge badge-warn">${r.high_turn_count} 高轮次</span>` : ''}
                    </div>
                    <span class="muted" style="flex-shrink:0;">${r.sessions} 次 · ${r.calls} 轮 · <strong class="en-font" style="color:var(--ink-1);">${esc(fmtTok(r.total))}</strong></span>
                  </div>`,
                  )
                  .join('')}
              </div>`
        }
      </div>
    </section>`;
}

function renderSessionsTab(dash) {
  const q = STATE.searchQuery.trim().toLowerCase();
  const list = (dash.sessions || []).filter(
    (s) => !q || s.title.toLowerCase().includes(q) || s.project.toLowerCase().includes(q) || s.primary_model.toLowerCase().includes(q),
  );
  const d = STATE.sessionDetail;
  const canSendAI = STATE.canMessageHost || STATE.canUpdateContext;

  return `
    <section class="grid-2">
      <div class="card">
        <div style="margin-bottom:12px;">
          <h2 class="section-title">Top Sessions (Tree-Merged)</h2>
          <div class="subtle" style="font-size:12px; margin-top:2px;">已归并主会话与下属子代理消耗，点击展开树节点与右侧轮次明细</div>
        </div>
        <input id="session-search" class="search-input" type="text" placeholder="搜索会话标题、项目或模型..." value="${esc(STATE.searchQuery)}" />
        <div class="session-list">
          ${
            !list.length
              ? `<div class="well subtle" style="text-align:center; padding:28px;">没有匹配的会话记录</div>`
              : list
                  .map((s) => {
                    const isSelected = STATE.selectedSessionId === s.id;
                    const isExpanded = STATE.expandedSessionId === s.id;
                    const chCount = s.children_count ?? (s.children || []).length;
                    const showAll = STATE.showAllChildrenFor.has(s.id);
                    const visibleChildren = showAll ? s.children || [] : (s.children || []).slice(0, 6);
                    return `
                      <div class="session-row ease ${isSelected ? 'active' : ''}" data-sid="${esc(s.id)}">
                        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
                          <div style="font-weight:500; color:var(--ink-1); font-size:12.5px; line-height:1.4;">${esc(s.title)}</div>
                          <span class="en-font num" style="font-weight:600; font-size:12.5px; flex-shrink:0;">${esc(fmtCost(s.cost_usd))}</span>
                        </div>
                        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:7px; margin-top:6px; font-size:11.5px;" class="subtle num">
                          <span class="en-font">${esc(s.primary_model)}</span>
                          <span>·</span>
                          <span class="en-font">${esc(fmtTok(s.total))}</span>
                          ${chCount > 0 ? `<span class="badge badge-brand">+${chCount} 子代理</span>` : ''}
                          <span style="margin-left:auto;">${esc(fmtTime(s.last_ts))}</span>
                        </div>
                        ${
                          isExpanded && chCount > 0
                            ? `<div class="subagent-branch">
                                <div class="subtle" style="font-size:11.5px;">主会话 ${esc(fmtTok(s.main_total))} · 子代理合计 ${esc(fmtTok(s.sub_total))}（点击子代理也可单独下钻）</div>
                                ${visibleChildren
                                  .map(
                                    (ch) => `
                                  <div class="subagent-leaf num" data-subid="${esc(ch.id)}">
                                    <span class="en-font muted" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                      ${esc(ch.role)} <span class="subtle">· ${esc(ch.primary_model)} · ${ch.turns}T</span>
                                    </span>
                                    <span class="en-font" style="color:var(--ink-1); flex-shrink:0;">${esc(fmtTok(ch.total))} · ${esc(fmtCost(ch.cost_usd))}</span>
                                  </div>`,
                                  )
                                  .join('')}
                                ${
                                  !showAll && (s.children || []).length > 6
                                    ? `<button class="expand-children-btn" data-parent="${esc(s.id)}" style="border:none; background:transparent; color:var(--brand); font-size:11.5px; cursor:pointer; text-align:left; padding:2px 8px;">展开更多 Top 子代理（已收录前 ${(s.children || []).length} / 共 ${chCount} 个）...</button>`
                                    : ''
                                }
                              </div>`
                            : ''
                        }
                      </div>`;
                  })
                  .join('')
          }
        </div>
      </div>

      <div class="card" style="display:flex; flex-direction:column; gap:16px;">
        ${
          STATE.sessionLoading
            ? `<div class="loading-center"><div class="spinner"></div><div>正在加载轮次曲线与工具分布...</div></div>`
            : !d
              ? `<div class="loading-center subtle">在左侧点击任意主会话或子代理查看每轮曲线</div>`
              : `
                <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                  <div style="min-width:0;">
                    <div class="label-caps">${d.meta.depth > 0 ? `Subagent · ${esc(d.meta.agent_name || 'subagent')}` : 'Turn-by-Turn Drilldown'}</div>
                    <div style="font-weight:500; font-size:14px; color:var(--ink-1); margin-top:3px; line-height:1.35;">${esc(d.meta.title)}</div>
                    <div class="subtle num" style="font-size:11.5px; margin-top:4px;">
                      ${esc(d.meta.project)} · ${d.summary.turns} 轮 · 命中 ${d.summary.cache_hit_rate}% · ${esc(fmtCost(d.summary.cost_usd))}
                    </div>
                  </div>
                  ${
                    canSendAI
                      ? `<button id="btn-send-ai" class="pill-btn primary" style="flex-shrink:0;">发给 AI 诊断</button>`
                      : `<span class="subtle" style="font-size:11.5px; flex-shrink:0;">右侧栏模式可发 AI 诊断</span>`
                  }
                </div>

                <div class="well">
                  <div class="muted" style="font-size:12px; margin-bottom:6px;">每轮上下文 Token 增长曲线（悬停节点看明细）</div>
                  ${renderTurnCurve(d.turns)}
                </div>

                <div>
                  <div class="muted" style="font-size:12px; margin-bottom:10px;">高耗步骤与工具分布</div>
                  ${
                    !(d.tools || []).length
                      ? `<div class="subtle" style="font-size:12px;">暂无工具耗量记录</div>`
                      : `<div style="display:flex; flex-direction:column; gap:10px; font-size:12px;">
                          ${d.tools
                            .slice(0, 7)
                            .map(
                              (t) => `
                            <div>
                              <div style="display:flex; justify-content:space-between; margin-bottom:5px;" class="num">
                                <span style="color:var(--ink-1);">${esc(t.tool)} <span class="subtle">(${t.calls} 次)</span></span>
                                <span class="en-font subtle">${esc(fmtTok(t.tokens))} · ${t.share}%</span>
                              </div>
                              <div class="bar-track">
                                <div class="bar-fill" style="width:${Math.min(100, t.share)}%; background:linear-gradient(90deg, var(--brand), var(--brand-2));"></div>
                              </div>
                            </div>`,
                            )
                            .join('')}
                        </div>`
                  }
                </div>`
        }
      </div>
    </section>`;
}

// ============================================================================
// Settings & Pricing Drawer
// ============================================================================

function renderDrawer() {
  if (!STATE.drawerOpen) return '';
  const cfg = STATE.config;
  const pal = cfg.appearance?.palette || 'glacier';
  const font = cfg.appearance?.font || 'comic';

  // Include both configured prices AND any new models seen in dashboard
  const seenModels = new Set(Object.keys(cfg.prices || {}));
  for (const m of STATE.dashboard?.models || []) {
    if (m.model_name && !seenModels.has(m.model_name) && m.is_reference) {
      seenModels.add(m.model_name);
    }
  }
  const priceEntries = Object.entries(cfg.prices || {});
  const meta = cfg.pricingMeta || {};
  const metaTime = meta.updatedAt
    ? new Date(meta.updatedAt).toLocaleString('zh-CN', { hour12: false })
    : '内置默认';
  const canSendAI = STATE.canMessageHost || STATE.canUpdateContext;

  return `
    <div id="drawer-backdrop" class="drawer-backdrop">
      <div class="drawer-panel" id="drawer-panel">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <div>
            <div class="display-font" style="font-size:20px; color:var(--ink-1);">外观与单价设置</div>
            <div class="subtle" style="font-size:11.5px; margin-top:2px;">自动持久化至本地 PLUGIN_DATA/config.json</div>
          </div>
          <button id="btn-close-drawer" class="pill-btn" style="padding:5px 10px;">关闭</button>
        </div>

        <!-- AI Auto-Update Pricing & FX Card -->
        <div class="well" style="border:1px solid var(--hairline-hover); background:var(--brand-soft);">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
            <div style="min-width:0;">
              <div style="font-weight:600; font-size:12.5px; color:var(--ink-1);">让 AI 联网更新汇率与最新报价</div>
              <div class="muted" style="font-size:11.5px; margin-top:2px;">
                插件保持离线只读，由对话 AI 检索官网定价与实时汇率后写回本地
              </div>
            </div>
            <button id="btn-ai-update-pricing" class="pill-btn primary" style="flex-shrink:0;">
              ${canSendAI ? '一键让 AI 更新' : '复制 AI 更新指令'}
            </button>
          </div>
          <div class="subtle num" style="font-size:11px; margin-top:8px; padding-top:7px; border-top:1px solid var(--hairline);">
            最近更新：${esc(metaTime)} · 来源：${esc(meta.source || '内置默认参考表')}
          </div>
          ${
            STATE.aiPromptPreview
              ? `<div style="margin-top:8px;">
                  <div class="muted" style="font-size:11px; margin-bottom:4px;">粘贴以下指令到任意 Antigravity 对话即可自动执行：</div>
                  <textarea readonly rows="4" onclick="this.select()"
                            style="width:100%; font-size:11px; padding:8px; border-radius:10px; border:1px solid var(--hairline); background:var(--surface-solid); color:var(--ink-1); resize:vertical;">${esc(STATE.aiPromptPreview)}</textarea>
                </div>`
              : ''
          }
        </div>

        <!-- Palette Picker -->
        <div class="well">
          <div style="font-weight:500; font-size:12.5px; margin-bottom:8px;">明亮色盘</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            ${PALETTE_OPTIONS.map(
              (p) =>
                `<button class="font-pill drawer-pal-btn ${pal === p.id ? 'active' : ''}" data-pal="${p.id}">${esc(p.label)}</button>`,
            ).join('')}
          </div>
        </div>

        <!-- Font Picker -->
        <div class="well">
          <div style="font-weight:500; font-size:12.5px; margin-bottom:8px;">英文字体偏好</div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            ${FONT_OPTIONS.map(
              (f) =>
                `<button class="font-pill drawer-font-btn ${font === f.id ? 'active' : ''}" data-font="${f.id}" style="font-family:${f.preview};">${esc(f.label)}</button>`,
            ).join('')}
          </div>
        </div>

        <!-- FX Rate -->
        <div class="well" style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
          <div>
            <div style="font-weight:500; font-size:12.5px;">USD → CNY 折算汇率</div>
            <div class="subtle" style="font-size:11.5px;">用于人民币等效费用计算</div>
          </div>
          <input id="input-fx" type="number" step="0.01" value="${cfg.fxRate}"
                 style="width:82px; padding:6px 8px; border-radius:10px; border:1px solid var(--hairline); background:var(--surface-solid); text-align:right; font-size:12.5px;" class="num" />
        </div>

        <!-- Pricing Table -->
        <div>
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
            <span style="font-weight:500; font-size:12.5px;">模型单价表（USD / 百万 Token）</span>
            <button id="btn-reset-prices" style="border:none; background:transparent; color:var(--brand); font-size:11.5px; cursor:pointer;">恢复默认</button>
          </div>
          <div style="display:grid; grid-template-columns:1.75fr 0.75fr 0.75fr 0.85fr 24px; gap:7px; padding:0 10px 6px; font-size:11px;" class="subtle en-font">
            <span>Model</span><span style="text-align:right;">Input</span><span style="text-align:right;">Cache</span><span style="text-align:right;">Output</span><span></span>
          </div>
          <div id="price-rows" style="display:flex; flex-direction:column; gap:7px;">
            ${priceEntries
              .map(
                ([name, rate]) => `
              <div class="price-grid-row" data-pname="${esc(name)}">
                <div class="en-font" style="font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(name)}">
                  ${esc(name)}${rate.isReference ? ` <span class="badge badge-warn" style="font-size:10px; padding:1px 5px;">参考</span>` : ''}
                </div>
                <input class="price-input num p-in" type="number" step="0.01" value="${rate.input}" />
                <input class="price-input num p-ca" type="number" step="0.005" value="${rate.cacheRead}" />
                <input class="price-input num p-out" type="number" step="0.05" value="${rate.output}" />
                <button class="btn-del-model" data-del-model="${esc(name)}" title="删除此模型"
                        style="border:none; background:transparent; color:var(--ink-3); cursor:pointer; font-size:13px; padding:0;">×</button>
              </div>`,
              )
              .join('')}
          </div>

          <!-- Quick Add Custom Model -->
          <div style="display:flex; gap:6px; margin-top:10px;">
            <input id="new-model-name" type="text" placeholder="添加新模型名称（如 Gemini 2.5 Pro）"
                   style="flex:1; padding:7px 11px; border-radius:10px; border:1px solid var(--hairline); background:var(--surface-soft); font-size:12px; outline:none;" />
            <button id="btn-add-model" class="pill-btn">添加</button>
          </div>
        </div>

        <div style="margin-top:auto; padding-top:14px; border-top:1px solid var(--hairline); display:flex; justify-content:flex-end; gap:8px;">
          <button id="btn-cancel-drawer" class="pill-btn">取消</button>
          <button id="btn-save-drawer" class="pill-btn primary">保存并重算</button>
        </div>
      </div>
    </div>`;
}

// ============================================================================
// Root Render & Event Wiring
// ============================================================================

function render() {
  const root = document.getElementById('app');
  if (!root) return;

  if (STATE.loading && !STATE.dashboard) {
    root.innerHTML = `
      <div class="shell">
        <div class="card loading-center">
          <div class="spinner"></div>
          <div style="font-size:14px; font-weight:500;">正在只读解析本机 Antigravity 会话数据库...</div>
          <div class="subtle" style="font-size:12px;">首次建立增量索引约需数秒，后续打开毫秒级秒开</div>
        </div>
      </div>`;
    return;
  }

  if (STATE.error && !STATE.dashboard) {
    root.innerHTML = `
      <div class="shell">
        <div class="card loading-center">
          <div style="color:var(--bad); font-weight:500;">数据加载出错</div>
          <div class="subtle" style="font-size:12px;">${esc(STATE.error)}</div>
          <button id="btn-retry" class="pill-btn primary">重试</button>
        </div>
      </div>`;
    document.getElementById('btn-retry')?.addEventListener('click', () => fetchDashboard({ forceSync: false }));
    return;
  }

  const dash = STATE.dashboard;
  let bodyHtml = '';
  if (STATE.tab === 'overview') bodyHtml = renderOverviewTab(dash);
  else if (STATE.tab === 'models') bodyHtml = renderModelsTab(dash);
  else if (STATE.tab === 'projects') bodyHtml = renderProjectsTab(dash);
  else if (STATE.tab === 'subagents') bodyHtml = renderSubagentsTab(dash);
  else bodyHtml = renderSessionsTab(dash);

  const hasFilters = Boolean(STATE.projectFilter || STATE.modelFilter);

  root.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand-wrap">
          <div class="brand-icon">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5"/><path d="M12 12v9"/><path d="M12 12L4 7.5"/>
            </svg>
          </div>
          <div>
            <div class="brand-title-row">
              <h1 class="brand-title">Antigravity Telemetry</h1>
              <span class="brand-sub">AGY Token 分析</span>
            </div>
            <div class="brand-meta num">
              <span style="display:inline-flex; align-items:center; gap:5px; color:var(--ok);">
                <i class="live-dot"></i> Local Read-Only
              </span>
              <span>·</span>
              <span>已索引 ${dash.total_indexed_dbs || 0} 会话</span>
              ${dash.sync?.elapsed_ms != null ? `<span class="hide-narrow">· 同步 ${dash.sync.elapsed_ms}ms</span>` : ''}
            </div>
          </div>
        </div>

        <div class="controls">
          <div class="seg-group">
            ${[
              ['5h', '5h'],
              ['today', '今日'],
              ['7d', '7天'],
              ['30d', '30天'],
              ['all', '全部'],
            ]
              .map(
                ([k, lbl]) =>
                  `<button class="seg-btn range-btn ${STATE.range === k ? 'active' : ''}" data-range="${k}">${lbl}</button>`,
              )
              .join('')}
          </div>

          <button id="btn-currency" class="pill-btn num" style="font-weight:500; color:var(--ink-1);">
            ${STATE.config.currency === 'CNY' ? '¥ CNY' : '$ USD'}
          </button>
          <button id="btn-open-drawer" class="pill-btn">外观与单价</button>
          <button id="btn-export-csv" class="pill-btn hide-narrow">导出 CSV</button>
          <button id="btn-export-json" class="pill-btn hide-narrow">JSON</button>
          <button id="btn-sync" class="pill-btn primary" ${STATE.refreshing ? 'disabled' : ''}>
            ${STATE.refreshing ? '同步中...' : '同步'}
          </button>
        </div>
      </header>

      ${
        hasFilters
          ? `<div class="filter-bar">
              <span class="subtle">当前筛选：</span>
              ${STATE.projectFilter ? `<span class="filter-chip">项目：${esc(STATE.projectFilter)} <button id="clear-proj">✕</button></span>` : ''}
              ${STATE.modelFilter ? `<span class="filter-chip">模型：${esc(STATE.modelFilter)} <button id="clear-model">✕</button></span>` : ''}
            </div>`
          : ''
      }

      <nav class="tabs">
        ${[
          ['overview', '总览与配额'],
          ['models', '模型对比'],
          ['projects', '项目归因'],
          ['subagents', '主 / 子代理'],
          ['sessions', '会话下钻'],
        ]
          .map(
            ([k, lbl]) =>
              `<button class="tab-btn ${STATE.tab === k ? 'active' : ''}" data-tab="${k}">${lbl}</button>`,
          )
          .join('')}
      </nav>

      <main>${bodyHtml}</main>
    </div>
    ${renderDrawer()}
  `;

  bindEvents(dash);
}

function bindEvents(dash) {
  // Ranges
  document.querySelectorAll('.range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.range;
      if (r && r !== STATE.range) {
        STATE.range = r;
        fetchDashboard({ forceSync: false });
      }
    });
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tab;
      if (!t) return;
      STATE.tab = t;
      render();
      if (t === 'sessions' && STATE.selectedSessionId && !STATE.sessionDetail) {
        loadSessionDetail(STATE.selectedSessionId);
      }
    });
  });

  // Currency toggle
  document.getElementById('btn-currency')?.addEventListener('click', () => {
    const nextCur = STATE.config.currency === 'CNY' ? 'USD' : 'CNY';
    STATE.config.currency = nextCur;
    render();
    persistConfig({ currency: nextCur }, false);
  });

  // Refresh & Quota refresh
  document.getElementById('btn-sync')?.addEventListener('click', () => {
    fetchDashboard({ forceSync: true });
    fetchQuota();
  });
  document.getElementById('btn-refresh-quota')?.addEventListener('click', async () => {
    await fetchQuota();
    showToast('配额已刷新');
  });

  // Export
  document.getElementById('btn-export-csv')?.addEventListener('click', () => exportReport('csv'));
  document.getElementById('btn-export-json')?.addEventListener('click', () => exportReport('json'));

  // Drawer open/close
  document.getElementById('btn-open-drawer')?.addEventListener('click', () => {
    STATE.drawerOpen = true;
    render();
  });
  document.getElementById('open-pricing-inline')?.addEventListener('click', () => {
    STATE.drawerOpen = true;
    render();
  });
  document.getElementById('link-top-sessions')?.addEventListener('click', () => {
    STATE.tab = 'sessions';
    render();
    if (STATE.selectedSessionId && !STATE.sessionDetail) {
      loadSessionDetail(STATE.selectedSessionId);
    }
  });

  // Clear filters
  document.getElementById('clear-proj')?.addEventListener('click', () => {
    STATE.projectFilter = '';
    fetchDashboard({ forceSync: false });
  });
  document.getElementById('clear-model')?.addEventListener('click', () => {
    STATE.modelFilter = '';
    fetchDashboard({ forceSync: false });
  });

  // Chart mode
  document.querySelectorAll('.chart-mode-btn').forEach((b) => {
    b.addEventListener('click', () => {
      STATE.chartMode = b.dataset.cmode;
      render();
    });
  });

  // Trend chart tooltips
  const series = dash.series || [];
  document.querySelectorAll('.trend-pt').forEach((g) => {
    const idx = Number(g.dataset.idx);
    const d = series[idx];
    if (!d) return;
    g.addEventListener('mousemove', (e) => {
      showTooltip(
        e,
        `<div class="en-font" style="font-weight:600; margin-bottom:6px;">${esc(d.key)} · ${esc(fmtTok(d.total))}</div>
         <div class="num" style="display:flex; flex-direction:column; gap:3px;">
           <div style="display:flex; justify-content:space-between; gap:16px;"><span style="color:var(--c-cache);">● 缓存读取</span><span>${esc(fmtTok(d.cache_read))}</span></div>
           <div style="display:flex; justify-content:space-between; gap:16px;"><span style="color:var(--c-input);">● 非缓存输入</span><span>${esc(fmtTok(d.input))}</span></div>
           <div style="display:flex; justify-content:space-between; gap:16px;"><span style="color:var(--c-think);">● Thinking</span><span>${esc(fmtTok(d.thinking))}</span></div>
           <div style="display:flex; justify-content:space-between; gap:16px;"><span style="color:var(--c-out);">● 正文回复</span><span>${esc(fmtTok(d.response))}</span></div>
           <div style="margin-top:3px; padding-top:4px; border-top:1px solid var(--hairline);" class="subtle">${d.calls} 次模型调用</div>
         </div>`,
      );
    });
    g.addEventListener('mouseleave', hideTooltip);
  });

  // Heatmap tooltips
  document.querySelectorAll('.heat-cell').forEach((cell) => {
    cell.addEventListener('mousemove', (e) => {
      showTooltip(
        e,
        `<div class="en-font" style="font-weight:600;">${esc(cell.dataset.date)}</div>
         <div class="muted num" style="margin-top:3px;">当日消耗：${esc(fmtTok(Number(cell.dataset.tok || 0)))}</div>`,
      );
    });
    cell.addEventListener('mouseleave', hideTooltip);
  });

  // Turn curve tooltips
  const turns = STATE.sessionDetail?.turns || [];
  document.querySelectorAll('.turn-dot').forEach((dot) => {
    const t = turns[Number(dot.dataset.tidx)];
    if (!t) return;
    dot.addEventListener('mousemove', (e) => {
      showTooltip(
        e,
        `<div class="en-font" style="font-weight:600; margin-bottom:5px;">Turn ${t.turn} · ${esc(t.model_name)}</div>
         <div class="num" style="display:flex; flex-direction:column; gap:2px;">
           <div>上下文总长：<strong>${esc(fmtTok(t.context_tokens))}</strong></div>
           <div>新输入 ${esc(fmtTok(t.input))} / 缓存 ${esc(fmtTok(t.cache_read))} (${t.cache_hit_rate}%)</div>
           <div>Thinking ${esc(fmtTok(t.thinking))} / 回复 ${esc(fmtTok(t.response))}</div>
           <div class="subtle">TTFT ${esc(fmtLatency(t.ttft_ms))} · 生成 ${esc(fmtLatency(t.gen_ms))}</div>
           ${t.compacted ? `<div style="color:var(--warn); font-weight:500;">★ 本轮前发生上下文压缩</div>` : ''}
         </div>`,
      );
    });
    dot.addEventListener('mouseleave', hideTooltip);
  });

  // Model & Project row click filters
  document.querySelectorAll('.model-filter-row').forEach((tr) => {
    tr.addEventListener('click', () => {
      STATE.modelFilter = tr.dataset.model || '';
      STATE.tab = 'overview';
      fetchDashboard({ forceSync: false });
    });
  });
  document.querySelectorAll('.project-filter-row').forEach((row) => {
    row.addEventListener('click', () => {
      STATE.projectFilter = row.dataset.project || '';
      STATE.tab = 'overview';
      fetchDashboard({ forceSync: false });
    });
  });

  // Sessions search & selection
  const searchEl = document.getElementById('session-search');
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      STATE.searchQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el2 = document.getElementById('session-search');
      if (el2) {
        el2.focus();
        el2.setSelectionRange(pos, pos);
      }
    });
  }

  document.querySelectorAll('.session-row').forEach((row) => {
    row.addEventListener('click', () => {
      const sid = row.dataset.sid;
      if (!sid) return;
      STATE.expandedSessionId = STATE.expandedSessionId === sid ? null : sid;
      loadSessionDetail(sid);
    });
  });

  document.querySelectorAll('.subagent-leaf').forEach((leaf) => {
    leaf.addEventListener('click', (e) => {
      e.stopPropagation();
      const subId = leaf.dataset.subid;
      if (subId) loadSessionDetail(subId);
    });
  });

  document.querySelectorAll('.expand-children-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      STATE.showAllChildrenFor.add(btn.dataset.parent);
      render();
    });
  });

  document.getElementById('btn-send-ai')?.addEventListener('click', sendSessionToAI);

  // Drawer interactions
  if (STATE.drawerOpen) {
    const closeDrawer = () => {
      STATE.drawerOpen = false;
      STATE.aiPromptPreview = '';
      render();
    };
    document.getElementById('btn-close-drawer')?.addEventListener('click', closeDrawer);
    document.getElementById('btn-cancel-drawer')?.addEventListener('click', closeDrawer);
    document.getElementById('btn-ai-update-pricing')?.addEventListener('click', askAIToUpdatePricing);
    document.getElementById('drawer-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'drawer-backdrop') closeDrawer();
    });

    document.querySelectorAll('.btn-del-model').forEach((b) => {
      b.addEventListener('click', () => {
        const m = b.dataset.delModel;
        if (m && STATE.config.prices) {
          delete STATE.config.prices[m];
          render();
        }
      });
    });

    document.querySelectorAll('.drawer-pal-btn').forEach((b) => {
      b.addEventListener('click', () => {
        STATE.config.appearance.palette = b.dataset.pal;
        applyAppearance();
        render();
      });
    });

    document.querySelectorAll('.drawer-font-btn').forEach((b) => {
      b.addEventListener('click', () => {
        STATE.config.appearance.font = b.dataset.font;
        applyAppearance();
        render();
      });
    });

    document.getElementById('btn-add-model')?.addEventListener('click', () => {
      const inp = document.getElementById('new-model-name');
      const name = (inp?.value || '').trim();
      if (!name) return;
      STATE.config.prices[name] = { input: 1.25, cacheRead: 0.125, output: 10.0, isReference: false };
      render();
    });

    document.getElementById('btn-reset-prices')?.addEventListener('click', async () => {
      await persistConfig({ resetPrices: true }, true);
      showToast('已恢复默认参考单价表');
    });

    document.getElementById('btn-save-drawer')?.addEventListener('click', async () => {
      const fx = parseFloat(document.getElementById('input-fx')?.value || '7.25');
      const prices = {};
      document.querySelectorAll('#price-rows .price-grid-row').forEach((r) => {
        const name = r.dataset.pname;
        if (!name) return;
        prices[name] = {
          input: parseFloat(r.querySelector('.p-in')?.value || '0') || 0,
          cacheRead: parseFloat(r.querySelector('.p-ca')?.value || '0') || 0,
          output: parseFloat(r.querySelector('.p-out')?.value || '0') || 0,
          isReference: false,
        };
      });
      STATE.drawerOpen = false;
      STATE.aiPromptPreview = '';
      await persistConfig(
        {
          fxRate: fx > 0 ? fx : 7.25,
          appearance: STATE.config.appearance,
          prices,
          replacePrices: true,
        },
        true,
      );
      showToast('外观、汇率与单价配置已保存');
    });
  }
}

// ============================================================================
// MCP App Handshake & Lifecycle
// ============================================================================

app.ontoolinput = ({ arguments: args }) => {
  if (args?.range) STATE.range = args.range;
  if (args?.tab) STATE.tab = args.tab;
  if (args?.project) STATE.projectFilter = args.project;
  if (args?.model) STATE.modelFilter = args.model;
  render();
};

app.ontoolresult = (result) => {
  const sc = result?.structuredContent;
  if (sc?.dashboard) {
    STATE.dashboard = sc.dashboard;
    if (sc.quota) STATE.quota = sc.quota;
    if (sc.config) STATE.config = sc.config;
    if (sc.defaultPrices) STATE.defaultPrices = sc.defaultPrices;
    if (sc.initialTab) STATE.tab = sc.initialTab;
    applyAppearance();
    STATE.loading = false;
    STATE.error = '';
    const first = (STATE.dashboard.sessions || [])[0];
    if (first && !STATE.selectedSessionId) {
      STATE.selectedSessionId = first.id;
    }
    render();
    if (STATE.tab === 'sessions' && STATE.selectedSessionId) {
      loadSessionDetail(STATE.selectedSessionId);
    }
  }
};

app.ontoolcancelled = () => {
  STATE.loading = false;
  STATE.refreshing = false;
  render();
};

async function bootstrap() {
  applyAppearance();
  render();
  try {
    await app.connect();
    STATE.connected = true;
    const caps = app.getHostCapabilities() || {};
    STATE.canMessageHost = Boolean(caps.message);
    STATE.canUpdateContext = Boolean(caps.updateModelContext);
    // Fallback pull in case host opened the resource without pre-populating ontoolresult
    setTimeout(() => {
      if (STATE.loading && !STATE.dashboard) {
        fetchDashboard({ forceSync: false });
        fetchQuota();
      }
    }, 600);
  } catch (err) {
    STATE.loading = false;
    STATE.error = `MCP App 握手失败：${err?.message || err}`;
    render();
  }
}

bootstrap();
