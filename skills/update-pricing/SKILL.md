---
name: update-pricing
description: >-
  Update USD-to-CNY exchange rate, supported AI models, and official per-1M-token
  API pricing (input, cache read, output/thinking) for the agy-token-analytics
  plugin using live web search and the sync_pricing_catalog MCP tool. Use whenever
  the user asks to refresh or update token pricing, exchange rates, or supported
  models for AGY Token Analytics.
---

# Update AGY Token Analytics Pricing, Models & FX Rate

Follow this exact procedure to keep `agy-token-analytics` pricing and exchange
rates accurate without guessing or fabricating numbers.

## Step 1: Inspect local models & current catalog

Call the MCP tool `sync_pricing_catalog` on server `agy-token-analytics_analytics`
with:

```json
{"action": "inspect"}
```

Review:
- `fxRate` and `pricingMeta` (last updated time & source)
- `localObservedModels` (every model actually used on this machine)
- `needsAttentionModels` (models currently falling back to reference estimates)

## Step 2: Verify live FX rate & official API pricing via web search

Always run live web searches before writing any numbers:

1. **USD → CNY exchange rate**: search current USD to CNY spot rate. Verify it is
   in the normal numeric range (USD 1 = ~6–8 CNY, never the inverted CNY→USD rate).
2. **Official API pricing pages** (unit: **USD per 1,000,000 tokens**):
   - Google Gemini API official pricing (`ai.google.dev/gemini-api/docs/pricing`)
   - Anthropic Claude API official pricing (`docs.anthropic.com` / `anthropic.com/pricing`)
   - OpenAI API pricing (`openai.com/api/pricing`) if GPT/o-series models appear locally
3. Record three rates per model:
   - `input`: standard non-cached input tokens (USD / 1M)
   - `cacheRead`: prompt-cache read tokens (USD / 1M; typically 10%–25% of input)
   - `output`: output / reasoning (thinking) tokens (USD / 1M)
4. **Honesty guardrail for unreleased or preview models**:
   - If a model observed locally has **no official published API price**, do NOT
     fabricate an official rate. Either keep a reasonable sibling-tier estimate
     with `"isReference": true`, or omit it so the family fallback continues to
     mark it as reference, and explicitly tell the user which models lacked
     official published rates.

## Step 3: Apply updates via `sync_pricing_catalog`

Call `sync_pricing_catalog` with `action: "update"`:

```json
{
  "action": "update",
  "fx_rate": 7.24,
  "prices": {
    "Gemini 2.5 Pro": {
      "input": 1.25,
      "cacheRead": 0.125,
      "output": 10.0,
      "isReference": false
    }
  },
  "source_note": "YYYY-MM-DD 官方 API 定价页 + 实时汇率"
}
```

- Set `isReference: false` **only** for prices directly verified on official pricing pages.
- Set `isReference: true` for estimated/preview models.
- Never delete custom user models unless the user explicitly asks to remove them.

## Step 4: Report concisely

Present a brief summary table to the user showing:
- Updated `USD → CNY` rate (before → after)
- Added/updated models, per-1M-token rates (`input / cacheRead / output`), and whether verified or reference
- Official source URLs / date boundary
- Remind the user to click **同步 (Sync)** in the **Token 分析** dashboard to recalculate all charts immediately.
