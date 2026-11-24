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
  { pattern: /opus/i,                     rate: { input: 15.00, cacheRead: 1.50,  output: 75.00 } },
  { pattern: /sonnet/i,                   rate: { input: 3.00,  cacheRead: 0.30,  output: 15.00 } },
  { pattern: /haiku/i,                    rate: { input: 0.80,  cacheRead: 0.08,  output: 4.00  } },
  { pattern: /ultra|pro/i,                rate: { input: 1.25,  cacheRead: 0.125, output: 10.00 } },
  { pattern: /flash|lite|mini/i,          rate: { input: 0.30,  cacheRead: 0.03,  output: 2.50  } },
  { pattern: /gpt|o[134]/i,               rate: { input: 2.50,  cacheRead: 1.25,  output: 10.00 } },
];

const GENERIC_FALLBACK = { input: 1.25, cacheRead: 0.125, output: 10.00 };

export const DEFAULT_CONFIG = {
  currency: 'CNY',
  fxRate: 7.25,
  appearance: {
    palette: 'glacier', // 冰川清透 (user chosen default)
    font: 'comic',      // Comic Sans MS (user chosen default)
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
      appearance: {
        palette: ['glacier', 'sky', 'dawn'].includes(raw?.appearance?.palette)
          ? raw.appearance.palette
          : DEFAULT_CONFIG.appearance.palette,
        font: ['comic', 'times', 'garamond', 'baskerville', 'century', 'candara', 'editorial', 'humanist'].includes(raw?.appearance?.font)
          ? raw.appearance.font
          : DEFAULT_CONFIG.appearance.font,
      },
      prices: { ...DEFAULT_PRICES, ...(raw.prices || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(dataDir, patch) {
  const current = loadConfig(dataDir);
  const next = {
    currency: patch.currency === 'USD' || patch.currency === 'CNY' ? patch.currency : current.currency,
    fxRate: Number(patch.fxRate) > 0 ? Number(patch.fxRate) : current.fxRate,
    appearance: {
      palette: patch?.appearance?.palette || current.appearance.palette,
      font: patch?.appearance?.font || current.appearance.font,
    },
    prices: patch.resetPrices
      ? { ...DEFAULT_PRICES }
      : { ...current.prices, ...(patch.prices || {}) },
  };
  // Normalize price values
  for (const [k, v] of Object.entries(next.prices)) {
    if (!v || typeof v !== 'object') {
      delete next.prices[k];
      continue;
    }
    next.prices[k] = {
      input: Math.max(0, Number(v.input) || 0),
      cacheRead: Math.max(0, Number(v.cacheRead) || 0),
      output: Math.max(0, Number(v.output) || 0),
      isReference: Boolean(v.isReference),
    };
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function resolveRate(modelName, pricesMap) {
  const clean = String(modelName || '').trim();
  const prices = pricesMap || DEFAULT_PRICES;

  // 1. Exact match
  if (clean && prices[clean]) {
    return { ...prices[clean], matchedKey: clean };
  }

  // 2. Longest prefix / substring match against user & default table
  const lower = clean.toLowerCase();
  let bestKey = '';
  for (const key of Object.keys(prices)) {
    if (lower.includes(key.toLowerCase()) && key.length > bestKey.length) {
      bestKey = key;
    }
  }
  if (bestKey) {
    return { ...prices[bestKey], matchedKey: bestKey };
  }

  // 3. Family regex fallback (always marked as reference estimate)
  for (const f of FAMILY_FALLBACKS) {
    if (f.pattern.test(clean)) {
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
