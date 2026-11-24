import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Built-in reference API pricing table (USD per 1M tokens).
 * Users can override or add any model directly inside the dashboard drawer.
 */
export const DEFAULT_PRICES = {
  'Gemini 3 Pro':      { input: 1.25,  cacheRead: 0.125, output: 10.00, isReference: true  },
  'Gemini 3 Flash':    { input: 0.30,  cacheRead: 0.03,  output: 2.50,  isReference: false },
  'Gemini 2.5 Pro':    { input: 1.25,  cacheRead: 0.125, output: 10.00, isReference: false },
  'Gemini 2.5 Flash':  { input: 0.30,  cacheRead: 0.03,  output: 2.50,  isReference: false },
  'Gemini 2.0 Flash':  { input: 0.10,  cacheRead: 0.025, output: 0.40,  isReference: false },
  'Claude Opus':       { input: 15.00, cacheRead: 1.50,  output: 75.00, isReference: true  },
  'Claude Sonnet':     { input: 3.00,  cacheRead: 0.30,  output: 15.00, isReference: false },
  'Claude Haiku':      { input: 0.80,  cacheRead: 0.08,  output: 4.00,  isReference: false },
  'GPT-4o':            { input: 2.50,  cacheRead: 1.25,  output: 10.00, isReference: false },
  'o3':                { input: 2.00,  cacheRead: 0.50,  output: 8.00,  isReference: true  },
};

const FAMILY_FALLBACKS = [
  { pattern: /\bopus\b/i,                     rate: { input: 4.00,  cacheRead: 0.20,  output: 20.00 } },
  { pattern: /\bsonnet\b/i,                   rate: { input: 2.00,  cacheRead: 0.10,  output: 10.00 } },
  { pattern: /\bhaiku\b/i,                    rate: { input: 0.80,  cacheRead: 0.08,  output: 4.00  } },
  { pattern: /\b(ultra|pro)\b/i,              rate: { input: 2.00,  cacheRead: 0.20,  output: 12.00 } },
  { pattern: /\b(flash|lite|mini)\b/i,        rate: { input: 0.30,  cacheRead: 0.03,  output: 2.50  } },
  { pattern: /\b(gpt|o1|o3|o4)\b/i,           rate: { input: 2.50,  cacheRead: 0.50,  output: 10.00 } },
];

const GENERIC_FALLBACK = { input: 1.50, cacheRead: 0.15, output: 10.00 };

function sanitizeModelKey(key) {
  return String(key || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

function normalizeForMatch(name) {
  return sanitizeModelKey(name).toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizePricesMap(rawMap) {
  const out = {};
  for (const [rawK, v] of Object.entries(rawMap || {})) {
    const k = sanitizeModelKey(rawK);
    if (!k || !v || typeof v !== 'object') continue;
    out[k] = {
      input: Math.max(0, Number(v.input) || 0),
      cacheRead: Math.max(0, Number(v.cacheRead) || 0),
      output: Math.max(0, Number(v.output) || 0),
      isReference: Boolean(v.isReference),
    };
  }
  return out;
}

export const DEFAULT_CONFIG = {
  currency: 'CNY',
  fxRate: 7.25,
  language: 'auto', // 'auto' | 'zh' | 'en'
  appearance: {
    palette: 'glacier', // 冰川清透 (user chosen default)
    font: 'comic',      // Comic Sans MS (user chosen default)
  },
  pricingMeta: {
    updatedAt: '',
    source: '内置默认参考表',
    updatedBy: 'default',
  },
  prices: { ...DEFAULT_PRICES },
};

export function loadConfig(dataDir) {
  const cfgPath = join(dataDir, 'config.json');
  if (!existsSync(cfgPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return {
      currency: raw.currency === 'USD' ? 'USD' : 'CNY',
      fxRate: Number(raw.fxRate) > 0 ? Number(raw.fxRate) : DEFAULT_CONFIG.fxRate,
      language: ['zh', 'en', 'auto'].includes(raw.language) ? raw.language : 'auto',
      appearance: {
        palette: ['glacier', 'sky', 'dawn'].includes(raw?.appearance?.palette)
          ? raw.appearance.palette
          : DEFAULT_CONFIG.appearance.palette,
        font: ['comic', 'times', 'garamond', 'baskerville', 'century', 'candara', 'editorial', 'humanist'].includes(raw?.appearance?.font)
          ? raw.appearance.font
          : DEFAULT_CONFIG.appearance.font,
      },
      pricingMeta: {
        updatedAt: String(raw?.pricingMeta?.updatedAt || ''),
        source: String(raw?.pricingMeta?.source || DEFAULT_CONFIG.pricingMeta.source),
        updatedBy: String(raw?.pricingMeta?.updatedBy || DEFAULT_CONFIG.pricingMeta.updatedBy),
      },
      prices: sanitizePricesMap({ ...DEFAULT_PRICES, ...(raw.prices || {}) }),
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(dataDir, patch) {
  const current = loadConfig(dataDir);
  const incomingPrices = sanitizePricesMap(patch.prices || {});
  const nextPrices = patch.resetPrices
    ? sanitizePricesMap(DEFAULT_PRICES)
    : patch.replacePrices && patch.prices
      ? incomingPrices
      : { ...current.prices, ...incomingPrices };

  if (Array.isArray(patch.removeModels)) {
    for (const m of patch.removeModels) {
      delete nextPrices[sanitizeModelKey(m)];
    }
  }

  const touchedPricing =
    Boolean(patch.resetPrices) ||
    Boolean(patch.prices && Object.keys(patch.prices).length > 0) ||
    Boolean(patch.fxRate) ||
    Boolean(patch.removeModels?.length);

  const nextMeta = touchedPricing
    ? {
        updatedAt: new Date().toISOString(),
        source: String(
          patch.sourceNote ||
            (patch.resetPrices
              ? '已重置为内置默认参考表'
              : patch.updatedBy === 'ai'
                ? 'AI 联网核实更新'
                : '手动编辑保存'),
        ),
        updatedBy: String(patch.updatedBy || (patch.resetPrices ? 'default' : 'manual')),
      }
    : current.pricingMeta;

  const next = {
    currency: patch.currency === 'USD' || patch.currency === 'CNY' ? patch.currency : current.currency,
    fxRate: Number(patch.fxRate) > 0 ? Number(patch.fxRate) : current.fxRate,
    language: ['zh', 'en', 'auto'].includes(patch.language) ? patch.language : current.language,
    appearance: {
      palette: patch?.appearance?.palette || current.appearance.palette,
      font: patch?.appearance?.font || current.appearance.font,
    },
    pricingMeta: nextMeta,
    prices: nextPrices,
  };

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function resolveRate(modelName, pricesMap) {
  const clean = sanitizeModelKey(modelName);
  const prices = pricesMap || DEFAULT_PRICES;

  // 1. Exact match
  if (clean && prices[clean]) {
    return { ...prices[clean], matchedKey: clean };
  }

  // 2. Normalized longest prefix / substring match (space/hyphen/underscore agnostic)
  const normName = normalizeForMatch(clean);
  let bestKey = '';
  let bestLen = 0;
  for (const key of Object.keys(prices)) {
    const normKey = normalizeForMatch(key);
    if (normKey && normName.includes(normKey) && normKey.length > bestLen) {
      bestKey = key;
      bestLen = normKey.length;
    }
  }
  if (bestKey) {
    return { ...prices[bestKey], matchedKey: bestKey };
  }

  // 3. Family regex fallback (always marked as reference estimate)
  for (const f of FAMILY_FALLBACKS) {
    if (f.pattern.test(normName)) {
      return { ...f.rate, isReference: true, matchedKey: '' };
    }
  }

  return { ...GENERIC_FALLBACK, isReference: true, matchedKey: '' };
}

export function calcCostForTokens(modelName, tokens, pricesMap) {
  const rate = resolveRate(modelName, pricesMap);
  const inTok = Number(tokens.input || 0);
  const caTok = Number(tokens.cache_read || 0);
  const outTok = Number(tokens.output ?? ((tokens.thinking || 0) + (tokens.response || 0)));

  const costUsd =
    (inTok / 1_000_000) * rate.input +
    (caTok / 1_000_000) * rate.cacheRead +
    (outTok / 1_000_000) * rate.output;

  const savedUsd = (caTok / 1_000_000) * Math.max(0, rate.input - rate.cacheRead);
  return {
    costUsd,
    savedUsd,
    isReference: Boolean(rate.isReference),
    rate,
  };
}

export function calcByModelMapCost(byModel, pricesMap) {
  let costUsd = 0;
  let savedUsd = 0;
  let hasRef = false;
  for (const [mName, tok] of Object.entries(byModel || {})) {
    const c = calcCostForTokens(mName, tok, pricesMap);
    costUsd += c.costUsd;
    savedUsd += c.savedUsd;
    if (c.isReference) hasRef = true;
  }
  return { costUsd, savedUsd, hasReference: hasRef };
}

export function enrichDashboardWithCosts(dash, config) {
  const prices = config.prices || DEFAULT_PRICES;

  let totalCostUsd = 0;
  let totalSavedUsd = 0;
  let anyReference = false;

  const models = (dash.models || []).map((m) => {
    const c = calcCostForTokens(m.model_name, m, prices);
    totalCostUsd += c.costUsd;
    totalSavedUsd += c.savedUsd;
    if (c.isReference) anyReference = true;
    return {
      ...m,
      cost_usd: Number(c.costUsd.toFixed(4)),
      saved_usd: Number(c.savedUsd.toFixed(4)),
      is_reference: c.isReference,
      rate: {
        input: c.rate.input,
        cacheRead: c.rate.cacheRead,
        output: c.rate.output,
      },
    };
  });

  const projects = (dash.projects || []).map((p) => {
    const c = calcByModelMapCost(p.by_model, prices);
    const { by_model, ...rest } = p;
    return {
      ...rest,
      cost_usd: Number(c.costUsd.toFixed(4)),
      saved_usd: Number(c.savedUsd.toFixed(4)),
      is_reference: c.hasReference,
    };
  });

  const sessions = (dash.sessions || []).map((s) => {
    const c = calcByModelMapCost(s.by_model, prices);
    const children = (s.children || []).map((ch) => {
      const cc = calcByModelMapCost(ch.by_model, prices);
      const { by_model: _cbm, ...chRest } = ch;
      return {
        ...chRest,
        cost_usd: Number(cc.costUsd.toFixed(4)),
      };
    });
    const { by_model: _sbm, ...sRest } = s;
    return {
      ...sRest,
      cost_usd: Number(c.costUsd.toFixed(4)),
      saved_usd: Number(c.savedUsd.toFixed(4)),
      is_reference: c.hasReference,
      children,
    };
  });

  return {
    ...dash,
    summary: {
      ...dash.summary,
      cost_usd: Number(totalCostUsd.toFixed(4)),
      saved_usd: Number(totalSavedUsd.toFixed(4)),
      has_reference_pricing: anyReference,
    },
    models,
    projects,
    sessions,
  };
}

export function enrichSessionDetailWithCosts(detail, config) {
  const prices = config.prices || DEFAULT_PRICES;
  const c = calcByModelMapCost(detail.by_model, prices);
  const children = (detail.children || []).map((ch) => {
    const cc = calcCostForTokens(ch.primary_model, ch, prices);
    return {
      ...ch,
      cost_usd: Number(cc.costUsd.toFixed(4)),
    };
  });
  return {
    ...detail,
    summary: {
      ...detail.summary,
      cost_usd: Number(c.costUsd.toFixed(4)),
      saved_usd: Number(c.savedUsd.toFixed(4)),
      has_reference_pricing: c.hasReference,
    },
    children,
  };
}
