/**
 * TokenPurse（鲸囊）· 浏览器半边。
 * ---------------------------------------------------------------------------
 * 把会话累计消耗的 token 折算成的「大致花费」徽标，插进输入框下方的会话
 * 统计行（轮数·步数·tok/s、token·缓存命中率），与它们同行显示。
 *
 * 数据来自宿主推送的两个会话投影：
 *   - tokenUsage    四个互斥计费桶（未缓存输入 / 缓存命中 / 缓存写入 / 输出）
 *   - modelSelection 当前（或最近一次）provider/model
 * 花费 = Σ(桶 token 数 × 每百万 token 单价) × 货币换算系数。
 *
 * 本文件刻意不依赖除 react 之外的任何客户端模块，因此是自包含的；
 * scripts/build.mjs 会把它包进 DSH 客户端模块加载器外壳。
 */

const React = require("react");
const { createPortal } = require("react-dom");
const { useState, useEffect, useRef, useMemo, createElement: h } = React;

/* ──────────────────────────────── 常量 ──────────────────────────────── */

const NS = "token-purse";
const STYLE_ID = "@dsh-plugins/token-purse/client.css";
const STORAGE_KEY = "dsh.token-purse.config.v2";
const STORAGE_KEY_V1 = "dsh.token-purse.config.v1";
const LEDGER_KEY = "dsh.token-purse.ledger.v1";
/* v1 里 deepseek-flash 是官方示例价；迁移时只有仍等于旧值的条目才换成新默认价。 */
const LEGACY_FLASH_V1 = { input: 0.28, cacheRead: 0.028, output: 0.42 };

/* 兜底费率（人民币 / 百万 token，取 DeepSeek 官方 Flash 空闲价）。cacheRead/cacheWrite 缺省时按 input 计。 */
const FALLBACK_RATES = { currency: "CNY", input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4, peakMultiplier: 1 };

/*
 * 费率表：每条自带 currency（默认 CNY）的「每百万 token」单价，含分时系数。
 * 同一个 model id 在不同 provider 价格不同，所以 key 支持 "provider/model"：
 * provider/model 精确 → model 精确 → model 子串（取最长）→ 兜底。
 * 数据源：api-docs.deepseek.com/zh-cn/quick_start/pricing（官方）
 *         packyapi 官方渠道 = 官方价 × 分组倍率 0.8（docs.packyapi.com/docs/token）。
 */
const DEFAULT_MODELS = {
  /*
   * packyapi：官方人民币价 × 分组倍率。数据源是它的定价页：
   * deepseek-officially 组 8 折，deepseek-sale 组 5 折，都带分时定价。
   * 注意它页面用 $ 显示，但数值 = 官方「元」价 × 倍率（例：v4-pro 官方 ¥4.5，5 折后 $2.25），
   * 官方英文页同款价格是 $0.66，所以 packyapi 这里是人民币。
   */
  "packyapi/deepseek-flash": { currency: "CNY", input: 0.8, cacheRead: 0.016, cacheWrite: 0.8, output: 3.2, peakMultiplier: 2 },
  "packyapi/deepseek-v4-flash": { currency: "CNY", input: 0.5, cacheRead: 0.01, cacheWrite: 0.5, output: 2, peakMultiplier: 2 },
  "packyapi/deepseek-v4-flash-vision-exp": { currency: "CNY", input: 0.8, cacheRead: 0.016, cacheWrite: 0.8, output: 3.2, peakMultiplier: 2 },
  "packyapi/deepseek-v4-pro": { currency: "CNY", input: 2.25, cacheRead: 0.075, cacheWrite: 2.25, output: 6.75, peakMultiplier: 2 },
  /* 官方 deepseek-flash（V4.1-Flash）：空闲 ¥1 / 缓存命中 ¥0.02 / 输出 ¥4，高峰 = 空闲 ×2。 */
  "deepseek-official/deepseek-flash": { currency: "CNY", input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4, peakMultiplier: 2 },
  /* 旧模型名 deepseek-v4-flash / -vision-exp 仍可调用，由 V4.1-Flash 服务并按 Flash 计费。 */
  "deepseek-official/deepseek-v4-flash": { currency: "CNY", input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4, peakMultiplier: 2 },
  /* 官方 deepseek-v4-pro：空闲 ¥4.5 / ¥0.15 / ¥13.5；官方计划 2026-09-14 12:00 后路由到 V4.1-Flash。 */
  "deepseek-official/deepseek-v4-pro": { currency: "CNY", input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5, peakMultiplier: 2 }
};

/* 分时时段：工作日 Asia/Shanghai 09:00–12:00、14:00–18:00（半开区间）。 */
const DEFAULT_PEAK = {
  timezone: "Asia/Shanghai",
  windows: ["Mon-Fri 09:00-12:00", "Mon-Fri 14:00-18:00"]
};

/* currency.perUsd = 显示币种每 1 美元的数额；fx = 各币种每 1 美元的数额（用于费率自带币种的换算）。 */
const DEFAULT_CONFIG = {
  currency: { code: "CNY", symbol: "¥", perUsd: 7.1, auto: false },
  fx: { USD: 1, CNY: 7.1 },
  peak: DEFAULT_PEAK,
  models: DEFAULT_MODELS
};

const FX_TIME_KEY = "dsh.token-purse.fx.v1";
const FX_TTL_MS = 12 * 60 * 60 * 1000;
/* 汇率来源（均免费、免 key、带 CORS）；按顺序尝试，失败换下一个。 */
const FX_ENDPOINTS = [
  { url: "https://open.er-api.com/v6/latest/USD", source: "open.er-api.com", table: "rates" },
  { url: "https://latest.currency-api.pages.dev/v1/currencies/usd.json", source: "currency-api.pages.dev", table: "usd" }
];

/* 常用币种预设：perUsd = 1 美元折合多少该币种。汇率为示例值，可在面板里改。 */
const CURRENCY_PRESETS = [
  { code: "USD", symbol: "$", perUsd: 1 },
  { code: "CNY", symbol: "¥", perUsd: 7.2 },
  { code: "EUR", symbol: "€", perUsd: 0.92 },
  { code: "GBP", symbol: "£", perUsd: 0.79 },
  { code: "JPY", symbol: "¥", perUsd: 150 },
  { code: "HKD", symbol: "HK$", perUsd: 7.8 },
  { code: "TWD", symbol: "NT$", perUsd: 32 },
  { code: "KRW", symbol: "₩", perUsd: 1380 },
  { code: "SGD", symbol: "S$", perUsd: 1.35 },
  { code: "INR", symbol: "₹", perUsd: 84 }
];

function matchCurrencyPreset(symbol, perUsd) {
  for (const preset of CURRENCY_PRESETS) {
    if (preset.symbol === symbol && Math.abs(preset.perUsd - perUsd) < 1e-9) return preset;
  }
  return null;
}

function findCurrencyPreset(code, symbol) {
  for (const preset of CURRENCY_PRESETS) {
    if (preset.code === code && preset.symbol === symbol) return preset;
  }
  return null;
}

function readFxTime() {
  try {
    const value = Number(window.localStorage.getItem(FX_TIME_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch (error) {
    return 0;
  }
}

function writeFxTime(at) {
  try {
    window.localStorage.setItem(FX_TIME_KEY, String(at));
  } catch (error) {
    /* 忽略：大不了下次重新取。 */
  }
}

/**
 * 从公开接口取「1 美元 = ? 目标币种」。全部失败返回 null。
 * @param code - 三位币种代码，如 CNY。
 * @returns 成功 { rate, source }，失败 null。
 */
async function fetchUsdRate(code) {
  if (typeof fetch !== "function" || typeof code !== "string" || code.length === 0) return null;
  const target = code.toUpperCase();
  for (const endpoint of FX_ENDPOINTS) {
    try {
      const response = await fetch(endpoint.url, { cache: "no-store" });
      if (!response.ok) continue;
      const payload = await response.json();
      const table = payload === null || typeof payload !== "object" ? null : payload[endpoint.table];
      if (table === null || typeof table !== "object") continue;
      const raw = table[target] !== undefined ? table[target] : table[target.toLowerCase()];
      const value = typeof raw === "string" ? Number(raw) : raw;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return { rate: value, source: endpoint.source };
    } catch (error) {
      /* 换下一个接口 */
    }
  }
  return null;
}

/* ──────────────────────────────── 样式 ──────────────────────────────── */

const CSS_TEXT =
  ".TPurse_root{position:relative;display:inline-flex;align-items:center}" +
  ".TPurse_trigger{display:inline-flex;align-items:center;gap:3px;height:28px;padding:0 8px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer;font-variant-numeric:tabular-nums}" +
  ".TPurse_trigger:hover,.TPurse_trigger:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}" +
  ".TPurse_approx{opacity:.75}" +
  ".TPurse_amount{font-weight:500;color:var(--dsw-alias-label-secondary)}" +
  ".TPurse_chevron{font-size:9px;opacity:.6;transition:transform .12s}" +
  ".TPurse_chevronOpen{transform:rotate(180deg)}" +
  ".TPurse_panel{position:absolute;bottom:calc(100% + 8px);top:auto;right:0;z-index:100;box-sizing:border-box;width:min(320px,calc(100vw - 32px));padding:12px;border:0;border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;cursor:default}" +
  ".TPurse_head{display:flex;align-items:baseline;gap:8px}" +
  ".TPurse_title{color:var(--dsw-alias-label-tertiary)}" +
  ".TPurse_total{margin-left:auto;color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}" +
  ".TPurse_modelLine{display:flex;align-items:baseline;gap:8px;margin-top:2px;color:var(--dsw-alias-label-tertiary)}" +
  ".TPurse_modelValue{margin-left:auto;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono);font-size:11px}" +
  ".TPurse_rows{margin:10px 0 0;padding:8px 0 0;border-top:1px solid var(--dsw-alias-border-l1)}" +
  ".TPurse_row{display:flex;align-items:center;gap:12px;padding:3px 0}" +
  ".TPurse_row dt{color:var(--dsw-alias-label-secondary)}" +
  ".TPurse_row dd{display:flex;gap:10px;margin:0 0 0 auto;font-variant-numeric:tabular-nums}" +
  ".TPurse_rowTotal dt{color:var(--dsw-alias-label-tertiary)}" +
  ".TPurse_tokens{min-width:52px;text-align:right;color:var(--dsw-alias-label-tertiary)}" +
  ".TPurse_sub{min-width:68px;text-align:right;color:var(--dsw-alias-label-primary)}" +
  ".TPurse_note{margin-top:10px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}" +
  ".TPurse_editButton{margin-top:8px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer}" +
  ".TPurse_editButton:hover{color:var(--dsw-alias-label-secondary)}" +
  ".TPurse_editor{margin-top:8px}" +
  ".TPurse_textarea{box-sizing:border-box;width:100%;height:148px;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-fill-l2,transparent);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono);font-size:11px;line-height:16px;resize:vertical}" +
  ".TPurse_hint{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}" +
  ".TPurse_error{margin-top:4px;color:var(--dsw-static-red-500,var(--dsw-alias-label-primary));font-size:11px}" +
  ".TPurse_actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}" +
  ".TPurse_ghost,.TPurse_primary{padding:4px 10px;border:0;border-radius:8px;font-size:11px;cursor:pointer}" +
  ".TPurse_ghost{background:transparent;color:var(--dsw-alias-label-secondary)}" +
  ".TPurse_ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
  ".TPurse_primary{background:var(--dsw-alias-label-primary);color:var(--dsw-specific-menu)}" +
  ".TPurse_host{display:none}" +
  "[data-composer-stats] .TPurse_root{font:inherit}" +
  "[data-composer-stats] .TPurse_trigger{height:auto;padding:1px 8px;gap:6px;border-radius:24px;font:inherit;line-height:inherit}" +
  "[data-composer-stats] .TPurse_amount{font-weight:400}" +
  ".TPurse_fields{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:center;gap:6px 10px;margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px}" +
  ".TPurse_fieldLabel{white-space:nowrap}" +
  ".TPurse_select,.TPurse_rateInput{font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l2,transparent);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 5px}" +
  ".TPurse_select{width:100%;max-width:160px;min-width:0}" +
  ".TPurse_rateInput{width:76px;text-align:right;font-family:var(--dsw-font-mono);font-variant-numeric:tabular-nums}" +
  ".TPurse_fxRow{display:flex;align-items:center;gap:10px;margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:11px}" +
  ".TPurse_fxButton{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}" +
  ".TPurse_fxButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
  ".TPurse_fxButton:disabled{opacity:.5;cursor:default}" +
  ".TPurse_fxAuto{display:inline-flex;align-items:center;gap:4px;cursor:pointer}" +
  ".TPurse_fxNote{margin-top:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;word-break:break-word}" +
  ".TPurse_peakNote{display:flex;align-items:flex-start;gap:6px;margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}" +
  ".TPurse_peakChip{flex:none;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-fill-l2,transparent);color:var(--dsw-alias-label-secondary)}" +
  ".TPurse_peakChipOn{background:var(--dsw-static-yellow-500,var(--dsw-alias-fill-l2,transparent));color:var(--dsw-alias-label-primary)}" +
  ".TPurse_peakText{min-width:0;word-break:break-word}" +
  ".TPurse_peakLabel{flex:none;color:var(--dsw-alias-label-tertiary)}" +
  ".TPurse_modeChip{flex:none;padding:0 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:10px;line-height:14px;letter-spacing:.02em;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}" +
  ".TPurse_modeChipOn{border-color:var(--dsw-static-yellow-500,#d97706);color:var(--dsw-static-yellow-500,#d97706);font-weight:600}" +
  ".TPurse_section{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}" +
  ".TPurse_sectionHead{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-bottom:4px}" +
  ".TPurse_breakItem{margin-bottom:5px}" +
  ".TPurse_breakRow{display:flex;align-items:baseline;gap:8px;font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}" +
  ".TPurse_breakLabel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}" +
  ".TPurse_breakDay{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary)}" +
  ".TPurse_breakTokens{flex:none;color:var(--dsw-alias-label-tertiary)}" +
  ".TPurse_breakAmount{flex:none;min-width:58px;text-align:right;color:var(--dsw-alias-label-primary)}" +
  ".TPurse_breakSub{margin-left:12px}" +
  ".TPurse_breakSub .TPurse_breakLabel,.TPurse_breakSub .TPurse_breakTokens{color:var(--dsw-alias-label-tertiary)}" +
  ".TPurse_breakSub .TPurse_breakAmount{color:var(--dsw-alias-label-secondary)}" +
  ".TPurse_share{display:block;height:3px;margin:3px 0 0;border-radius:2px;background:var(--dsw-alias-fill-l2);overflow:hidden}" +
  ".TPurse_shareFill{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-label-tertiary)}" +
  ".TPurse_sparkWrap{margin:2px 0 6px}" +
  ".TPurse_spark{display:block;width:100%;height:28px;overflow:visible}" +
  ".TPurse_sparkLine{fill:none;stroke:var(--dsw-alias-label-secondary);stroke-width:1.25;stroke-linecap:round;stroke-linejoin:round}" +
  ".TPurse_sparkArea{fill:var(--dsw-alias-fill-l2);stroke:none}" +
  ".TPurse_sparkNote{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;font-variant-numeric:tabular-nums}" +
  ".TPurse_tabs{display:flex;gap:2px;margin-top:10px;padding:2px;border-radius:8px;background:var(--dsw-alias-fill-l2)}" +
  ".TPurse_tab{flex:1 1 0;min-width:0;padding:3px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-family:inherit;cursor:pointer}" +
  ".TPurse_tabOn{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}" +
  ".TPurse_sectionFlat{margin-top:8px;padding-top:0;border-top:0}" +
  ".TPurse_dayRow{width:100%;padding:0;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}" +
  ".TPurse_peakLine{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}" +
  ".TPurse_warnNote{margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;word-break:break-word}" +
  ".TPurse_sourceChip{flex:none;padding:0 6px;border-radius:999px;background:var(--dsw-alias-fill-l2,transparent);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}" +
  ".TPurse_sourceChipExact{color:var(--dsw-alias-label-secondary)}" +
  ".TPurse_sourceChipMiss{color:var(--dsw-alias-label-primary)}";

const CSS = {
  root: "TPurse_root",
  trigger: "TPurse_trigger",
  approx: "TPurse_approx",
  amount: "TPurse_amount",
  chevron: "TPurse_chevron",
  chevronOpen: "TPurse_chevronOpen",
  panel: "TPurse_panel",
  head: "TPurse_head",
  title: "TPurse_title",
  total: "TPurse_total",
  modelLine: "TPurse_modelLine",
  modelValue: "TPurse_modelValue",
  rows: "TPurse_rows",
  row: "TPurse_row",
  rowTotal: "TPurse_rowTotal",
  tokens: "TPurse_tokens",
  sub: "TPurse_sub",
  note: "TPurse_note",
  editButton: "TPurse_editButton",
  editor: "TPurse_editor",
  textarea: "TPurse_textarea",
  hint: "TPurse_hint",
  error: "TPurse_error",
  actions: "TPurse_actions",
  ghost: "TPurse_ghost",
  primary: "TPurse_primary",
  host: "TPurse_host",
  fields: "TPurse_fields",
  fieldLabel: "TPurse_fieldLabel",
  select: "TPurse_select",
  rateInput: "TPurse_rateInput",
  fxRow: "TPurse_fxRow",
  fxButton: "TPurse_fxButton",
  fxAuto: "TPurse_fxAuto",
  fxNote: "TPurse_fxNote",
  peakNote: "TPurse_peakNote",
  peakChip: "TPurse_peakChip",
  peakChipOn: "TPurse_peakChipOn",
  peakText: "TPurse_peakText",
  peakLabel: "TPurse_peakLabel",
  modeChip: "TPurse_modeChip",
  modeChipOn: "TPurse_modeChipOn",
  section: "TPurse_section",
  sectionHead: "TPurse_sectionHead",
  breakItem: "TPurse_breakItem",
  breakRow: "TPurse_breakRow",
  breakLabel: "TPurse_breakLabel",
  breakDay: "TPurse_breakDay",
  breakTokens: "TPurse_breakTokens",
  breakAmount: "TPurse_breakAmount",
  breakSub: "TPurse_breakSub",
  share: "TPurse_share",
  shareFill: "TPurse_shareFill",
  peakLine: "TPurse_peakLine",
  tabs: "TPurse_tabs",
  tab: "TPurse_tab",
  tabOn: "TPurse_tabOn",
  sectionFlat: "TPurse_sectionFlat",
  dayRow: "TPurse_dayRow",
  sparkWrap: "TPurse_sparkWrap",
  spark: "TPurse_spark",
  sparkLine: "TPurse_sparkLine",
  sparkArea: "TPurse_sparkArea",
  sparkNote: "TPurse_sparkNote",
  warnNote: "TPurse_warnNote",
  sourceChip: "TPurse_sourceChip",
  sourceChipExact: "TPurse_sourceChipExact",
  sourceChipMiss: "TPurse_sourceChipMiss"
};

if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
  const styleTag = document.createElement("style");
  styleTag.dataset.plugin = "@dsh-plugins/token-purse";
  styleTag.dataset.pluginCss = STYLE_ID;
  styleTag.textContent = CSS_TEXT;
  document.head.appendChild(styleTag);
}

/* ──────────────────────────────── 配置 ──────────────────────────────── */

function toNumber(value, fallback) {
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeRates(raw) {
  const source = raw !== null && raw !== undefined && typeof raw === "object" ? raw : {};
  const input = toNumber(source.input, FALLBACK_RATES.input);
  const peakMultiplier = toNumber(source.peakMultiplier, 1);
  const currency =
    typeof source.currency === "string" && source.currency.length > 0 && source.currency.length <= 8
      ? source.currency.toUpperCase()
      : FALLBACK_RATES.currency;
  return {
    currency,
    input,
    cacheRead: toNumber(source.cacheRead, input),
    cacheWrite: toNumber(source.cacheWrite, input),
    output: toNumber(source.output, FALLBACK_RATES.output),
    peakMultiplier: peakMultiplier > 1 ? peakMultiplier : 1
  };
}

/** fx 表：各币种每 1 美元的数额（USD 恒为 1）。 */
function normalizeFx(raw) {
  const fx = { USD: 1 };
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return fx;
  for (const key of Object.keys(raw)) {
    const code = key.toUpperCase();
    if (code.length === 0 || code.length > 8) continue;
    if (code === "__PROTO__" || code === "PROTOTYPE" || code === "CONSTRUCTOR") continue;
    const value = toNumber(raw[key], null);
    if (value !== null && value > 0) fx[code] = value;
  }
  return fx;
}

function normalizePeak(raw) {
  const source = raw !== null && raw !== undefined && typeof raw === "object" ? raw : {};
  const timezone =
    typeof source.timezone === "string" && source.timezone.length > 0 && source.timezone.length <= 64
      ? source.timezone
      : DEFAULT_PEAK.timezone;
  const windows = Array.isArray(source.windows)
    ? source.windows.filter((item) => typeof item === "string" && item.length > 0 && item.length <= 64)
    : DEFAULT_PEAK.windows.slice();
  return { timezone, windows };
}

function cloneConfig(config) {
  const models = {};
  for (const key of Object.keys(config.models)) models[key] = normalizeRates(config.models[key]);
  return {
    currency: {
      code: typeof config.currency.code === "string" ? config.currency.code : "",
      symbol: config.currency.symbol,
      perUsd: config.currency.perUsd,
      auto: config.currency.auto === true
    },
    fx: normalizeFx(config.fx),
    peak: normalizePeak(config.peak),
    models
  };
}

function mergeConfig(base, patch) {
  const merged = cloneConfig(base);
  if (patch === null || patch === undefined || typeof patch !== "object") return merged;
  const currency = patch.currency;
  if (currency !== null && currency !== undefined && typeof currency === "object") {
    if (typeof currency.symbol === "string" && currency.symbol.length > 0 && currency.symbol.length <= 4) merged.currency.symbol = currency.symbol;
    const perUsd = toNumber(currency.perUsd, null);
    if (perUsd !== null && perUsd > 0) merged.currency.perUsd = perUsd;
    if (typeof currency.code === "string" && currency.code.length > 0 && currency.code.length <= 8) {
      merged.currency.code = currency.code.toUpperCase();
    } else {
      const inferred = matchCurrencyPreset(merged.currency.symbol, merged.currency.perUsd);
      if (inferred !== null) merged.currency.code = inferred.code;
    }
    if (typeof currency.auto === "boolean") merged.currency.auto = currency.auto;
  }
  const peak = patch.peak;
  if (peak !== null && peak !== undefined && typeof peak === "object") {
    if (typeof peak.timezone === "string" && peak.timezone.length > 0 && peak.timezone.length <= 64) merged.peak.timezone = peak.timezone;
    if (Array.isArray(peak.windows)) {
      merged.peak.windows = peak.windows.filter((item) => typeof item === "string" && item.length > 0 && item.length <= 64);
    }
  }
  const models = patch.models;
  if (models !== null && models !== undefined && typeof models === "object" && !Array.isArray(models)) {
    for (const rawKey of Object.keys(models)) {
      const key = rawKey.toLowerCase();
      if (key.length === 0 || key.length > 64) continue;
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      merged.models[key] = normalizeRates(models[rawKey]);
    }
  }
  const fx = patch.fx;
  if (fx !== null && fx !== undefined && typeof fx === "object" && !Array.isArray(fx)) {
    const normalized = normalizeFx(fx);
    for (const code of Object.keys(normalized)) merged.fx[code] = normalized[code];
  }
  return merged;
}

/* 迁移旧配置：只把仍是 v1 示例价的 deepseek-flash 换掉，用户自己改过的费率原样保留。 */
function migrateConfigV1(parsed) {
  if (parsed === null || parsed === undefined || typeof parsed !== "object") return parsed;
  const models = parsed.models;
  if (models !== null && models !== undefined && typeof models === "object" && !Array.isArray(models)) {
    const flash = models["deepseek-flash"];
    if (
      flash !== null && flash !== undefined && typeof flash === "object"
      && toNumber(flash.input, null) === LEGACY_FLASH_V1.input
      && toNumber(flash.cacheRead, null) === LEGACY_FLASH_V1.cacheRead
      && toNumber(flash.output, null) === LEGACY_FLASH_V1.output
    ) {
      delete models["deepseek-flash"];
    }
  }
  return parsed;
}

/** 0.1.0 的配置没有 currency.code 字段，那会儿默认币种是美元。 */
function legacyCurrencyConfig(parsed) {
  if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const currency = parsed.currency;
  if (currency === null || currency === undefined || typeof currency !== "object" || Array.isArray(currency)) return false;
  return !(typeof currency.code === "string" && currency.code.length > 0);
}

/** 把 0.1.0 的默认币种一次性升到人民币，用户自己的 auto 开关保留。 */
function migrateLegacyCurrency(parsed) {
  if (!legacyCurrencyConfig(parsed)) return parsed;
  const auto = parsed.currency.auto === true;
  parsed.currency = {
    code: DEFAULT_CONFIG.currency.code,
    symbol: DEFAULT_CONFIG.currency.symbol,
    perUsd: DEFAULT_CONFIG.currency.perUsd,
    auto
  };
  return parsed;
}

function readConfig() {
  const base = cloneConfig(DEFAULT_CONFIG);
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null && stored !== undefined) {
      const parsed = JSON.parse(stored);
      const stale = legacyCurrencyConfig(parsed);
      const merged = mergeConfig(base, migrateLegacyCurrency(parsed));
      if (stale) writeConfig(merged);
      return merged;
    }
    const legacyStored = window.localStorage.getItem(STORAGE_KEY_V1);
    if (legacyStored !== null && legacyStored !== undefined) {
      const migrated = mergeConfig(base, migrateLegacyCurrency(migrateConfigV1(JSON.parse(legacyStored))));
      writeConfig(migrated);
      return migrated;
    }
    return base;
  } catch (error) {
    return base;
  }
}

function writeConfig(config) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    /* 无痕模式等写入失败时保留内存态即可。 */
  }
}

/** 命中哪一条费率：provider 专属 / 同名模型 / 子串 / 兜底。 */
function lookupRates(config, modelId, provider) {
  const models =
    config !== null && config !== undefined && config.models !== null && typeof config.models === "object" ? config.models : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(models, key);
  const id = typeof modelId === "string" && modelId.length > 0 ? modelId.toLowerCase() : null;
  const owner = typeof provider === "string" && provider.length > 0 ? provider.toLowerCase() : null;
  if (id !== null) {
    if (owner !== null && has(owner + "/" + id)) return { rates: normalizeRates(models[owner + "/" + id]), source: "provider" };
    if (has(id)) return { rates: normalizeRates(models[id]), source: "model" };
    let best = null;
    for (const key of Object.keys(models)) {
      if (key.indexOf("/") !== -1) continue;
      if (id.indexOf(key) !== -1 && (best === null || key.length > best.length)) best = key;
    }
    if (best !== null) return { rates: normalizeRates(models[best]), source: "substring" };
  }
  return { rates: normalizeRates(FALLBACK_RATES), source: "fallback" };
}

function resolveRates(config, modelId, provider) {
  return lookupRates(config, modelId, provider).rates;
}

function rateSource(config, modelId, provider) {
  return lookupRates(config, modelId, provider).source;
}

function pickModel(selection) {
  if (selection === null || selection === undefined || typeof selection !== "object") return null;
  const candidates = [selection.next, selection.lastUsed];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && typeof candidate === "object" && typeof candidate.model === "string" && candidate.model.length > 0) return candidate;
  }
  return null;
}

/* ─────────────────────────── 分时、账本与计费 ─────────────────────────── */

const BUCKETS = ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];
const BUCKET_DEFINITIONS = [
  { key: "uncachedInputTokens", label: "bucket.input", rate: "input" },
  { key: "cacheReadTokens", label: "bucket.cacheRead", rate: "cacheRead" },
  { key: "cacheWriteTokens", label: "bucket.cacheWrite", rate: "cacheWrite" },
  { key: "outputTokens", label: "bucket.output", rate: "output" }
];
const LEDGER_LIMIT = 1000;

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function zeroBuckets() {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
}

function bucketSnapshot(usage) {
  const buckets = zeroBuckets();
  if (usage === null || usage === undefined || typeof usage !== "object") return buckets;
  for (const key of BUCKETS) buckets[key] = toNumber(usage[key], 0);
  return buckets;
}

function totalOf(buckets) {
  let total = 0;
  for (const key of BUCKETS) total += buckets[key];
  return total;
}

function parseDays(text) {
  const days = new Set();
  for (const rawPart of String(text).split(",")) {
    const part = rawPart.trim().toLowerCase();
    if (part === "*") {
      for (let day = 0; day < 7; day += 1) days.add(day);
      continue;
    }
    const range = part.split("-");
    if (range.length === 2) {
      const from = WEEKDAYS[range[0].trim().slice(0, 3)];
      const to = WEEKDAYS[range[1].trim().slice(0, 3)];
      if (from === undefined || to === undefined) return null;
      for (let day = from; ; day = (day + 1) % 7) {
        days.add(day);
        if (day === to) break;
      }
    } else {
      const day = WEEKDAYS[part.slice(0, 3)];
      if (day === undefined) return null;
      days.add(day);
    }
  }
  return days.size > 0 ? days : null;
}

function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total <= 1440 ? total : null;
}

/** 解析 "Mon-Fri 09:00-12:00" 这样的时段；无法解析返回 null。 */
function parsePeakWindow(text) {
  const match = /^(.*?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(String(text).trim());
  if (match === null) return null;
  const days = parseDays(match[1]);
  const from = parseClock(match[2]);
  const to = parseClock(match[3]);
  if (days === null || from === null || to === null || from >= to) return null;
  return { days, from, to };
}

function parsePeak(config) {
  const source = config !== null && config !== undefined && typeof config.peak === "object" ? config.peak : null;
  if (source === null || source === undefined || !Array.isArray(source.windows)) return null;
  const windows = [];
  for (const text of source.windows) {
    const parsed = typeof text === "string" ? parsePeakWindow(text) : null;
    if (parsed !== null) windows.push(parsed);
  }
  if (windows.length === 0) return null;
  const timezone = typeof source.timezone === "string" && source.timezone.length > 0 ? source.timezone : "UTC";
  return { timezone, windows };
}

const DAY_FORMATTERS = new Map();

function zonedDayMinutes(date, timeZone) {
  let formatter = DAY_FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    } catch (error) {
      formatter = null;
    }
    DAY_FORMATTERS.set(timeZone, formatter);
  }
  if (formatter === null) return null;
  try {
    let weekday = null;
    let hours = null;
    let minutes = null;
    for (const part of formatter.formatToParts(date)) {
      if (part.type === "weekday") weekday = part.value;
      else if (part.type === "hour") hours = part.value;
      else if (part.type === "minute") minutes = part.value;
    }
    const day = weekday === null ? undefined : WEEKDAYS[String(weekday).toLowerCase().slice(0, 3)];
    if (day === undefined || hours === null || minutes === null) return null;
    const hour = Number(hours) === 24 ? 0 : Number(hours);
    return { day, minutes: hour * 60 + Number(minutes) };
  } catch (error) {
    return null;
  }
}

function isPeakAt(date, peak) {
  if (peak === null) return false;
  const zoned = zonedDayMinutes(date, peak.timezone);
  if (zoned === null) return false;
  for (const window of peak.windows) {
    if (window.days.has(zoned.day) && zoned.minutes >= window.from && zoned.minutes < window.to) return true;
  }
  return false;
}

/** 某模型在 at 时刻生效的单价（高峰时段按 peakMultiplier 上浮）。 */
function ratesAt(config, modelId, at, peak, provider) {
  const rates = resolveRates(config, modelId, provider);
  if (peak === null || !(rates.peakMultiplier > 1)) return rates;
  if (!isPeakAt(new Date(at), peak)) return rates;
  const factor = rates.peakMultiplier;
  return {
    currency: rates.currency,
    input: rates.input * factor,
    cacheRead: rates.cacheRead * factor,
    cacheWrite: rates.cacheWrite * factor,
    output: rates.output * factor,
    peakMultiplier: factor
  };
}

/* ── 增量账本：会话投影只给累计值，这里按观察时刻切成增量、逐段计价 ── */

function emptyLedger() {
  return { observed: false, seen: zeroBuckets(), base: null, entries: [] };
}

function normalizeLedger(raw) {
  const ledger = emptyLedger();
  if (raw === null || raw === undefined || typeof raw !== "object") return ledger;
  ledger.observed = raw.observed === true;
  if (raw.seen !== null && raw.seen !== undefined && typeof raw.seen === "object") ledger.seen = bucketSnapshot(raw.seen);
  if (raw.base !== null && raw.base !== undefined && typeof raw.base === "object" && typeof raw.base.at === "number") {
    ledger.base = { at: raw.base.at, provider: typeof raw.base.provider === "string" ? raw.base.provider : null, model: typeof raw.base.model === "string" ? raw.base.model : null, b: bucketSnapshot(raw.base.b) };
    ledger.observed = true;
  }
  if (Array.isArray(raw.entries)) {
    for (const entry of raw.entries) {
      if (entry === null || entry === undefined || typeof entry !== "object" || typeof entry.at !== "number") continue;
      ledger.entries.push({ at: entry.at, provider: typeof entry.provider === "string" ? entry.provider : null, model: typeof entry.model === "string" ? entry.model : null, b: bucketSnapshot(entry.b) });
    }
    if (ledger.entries.length > 0) ledger.observed = true;
  }
  return ledger;
}

function ledgerKey(sessionId) {
  return LEDGER_KEY + ":" + String(sessionId === undefined || sessionId === null ? "default" : sessionId);
}

function readLedger(sessionId) {
  try {
    const raw = window.localStorage.getItem(ledgerKey(sessionId));
    if (raw === null || raw === undefined) return emptyLedger();
    return normalizeLedger(JSON.parse(raw));
  } catch (error) {
    return emptyLedger();
  }
}

function writeLedger(sessionId, ledger) {
  try {
    window.localStorage.setItem(ledgerKey(sessionId), JSON.stringify(ledger));
  } catch (error) {
    /* 忽略：写不进去只影响刷新后的精度。 */
  }
}

/** 用最新累计值推进账本；无变化时原样返回，避免多余渲染。 */
function syncLedger(current, usage, providerId, modelId, now) {
  const ledger = current === null || current === undefined ? emptyLedger() : current;
  const next = bucketSnapshot(usage);
  let reset = false;
  for (const key of BUCKETS) if (next[key] < ledger.seen[key]) reset = true;
  if (reset) {
    return { observed: true, seen: next, base: totalOf(next) > 0 ? { at: now, provider: providerId, model: modelId, b: next } : null, entries: [] };
  }
  if (ledger.observed !== true) {
    return { observed: true, seen: next, base: totalOf(next) > 0 ? { at: now, provider: providerId, model: modelId, b: next } : null, entries: [] };
  }
  const delta = zeroBuckets();
  let changed = false;
  for (const key of BUCKETS) {
    const value = next[key] - ledger.seen[key];
    if (value > 0) {
      delta[key] = value;
      changed = true;
    }
  }
  if (!changed) return ledger;
  const entries = ledger.entries.concat([{ at: now, provider: providerId, model: modelId, b: delta }]);
  return {
    observed: true,
    seen: next,
    base: ledger.base,
    entries: entries.length > LEDGER_LIMIT ? entries.slice(entries.length - LEDGER_LIMIT) : entries
  };
}

/* ── 计费 ── */

function costBuckets(buckets, rates) {
  const native = zeroBuckets();
  for (const definition of BUCKET_DEFINITIONS) native[definition.key] = (buckets[definition.key] * rates[definition.rate]) / 1e6;
  return native;
}

/** 解析 fx 表：显示币种一律以 currency.perUsd 为准，USD 恒为 1。 */
function fxPerUsd(config) {
  const safe = config !== null && config !== undefined ? config : {};
  const fx = normalizeFx(safe.fx);
  const currency = safe.currency !== null && safe.currency !== undefined && typeof safe.currency === "object" ? safe.currency : {};
  const code = typeof currency.code === "string" && currency.code.length > 0 ? currency.code.toUpperCase() : "USD";
  const perUsd = toNumber(currency.perUsd, 1);
  fx[code] = code === "USD" ? 1 : perUsd > 0 ? perUsd : 1;
  fx.USD = 1;
  return fx;
}

/** "provider / model"，没有 provider 时只有模型名。 */
function formatModelLabel(provider, model) {
  if (model === null || model === undefined) return null;
  return typeof provider === "string" && provider.length > 0 ? provider + " / " + model : model;
}

/** 占比进度条宽度：忽略 0，给最小值 2% 以免看不见。 */
function sharePercent(amount, total) {
  if (!(total > 0) || !(amount > 0)) return 0;
  return Math.min(100, Math.max(2, (amount / total) * 100));
}

function usdBreakdown(totals, selection, config, ledger, at) {
  const model = pickModel(selection);
  const modelId = model === null ? null : model.model;
  const providerId = model === null || typeof model.provider !== "string" || model.provider.length === 0 ? null : model.provider;
  const peak = parsePeak(config);
  const fx = fxPerUsd(config);
  const usd = zeroBuckets();
  const accumulate = (buckets, entryProvider, entryModel, moment) => {
    const rates = ratesAt(config, entryModel === null ? modelId : entryModel, moment, peak, entryProvider === null || entryProvider === undefined ? providerId : entryProvider);
    const cost = costBuckets(buckets, rates);
    /* 费率自带币种 → 美元：除以「该币种每 1 美元的数额」；显示时再乘 currency.perUsd。 */
    const ratePerUsd = toNumber(fx[rates.currency], 1);
    const factor = ratePerUsd > 0 ? 1 / ratePerUsd : 1;
    for (const key of BUCKETS) usd[key] += cost[key] * factor;
  };
  if (ledger !== null && ledger !== undefined) {
    if (ledger.base !== null) accumulate(ledger.base.b, ledger.base.provider, ledger.base.model, ledger.base.at);
    for (const entry of ledger.entries) accumulate(entry.b, entry.provider, entry.model, entry.at);
    const covered = zeroBuckets();
    if (ledger.base !== null) for (const key of BUCKETS) covered[key] += ledger.base.b[key];
    for (const entry of ledger.entries) for (const key of BUCKETS) covered[key] += entry.b[key];
    const remainder = zeroBuckets();
    let hasRemainder = false;
    for (const key of BUCKETS) {
      const value = totals[key] - covered[key];
      if (value > 0) {
        remainder[key] = value;
        hasRemainder = true;
      }
    }
    if (hasRemainder) accumulate(remainder, providerId, modelId, at);
  } else {
    accumulate(totals, providerId, modelId, at);
  }
  const rates = resolveRates(config, modelId, providerId);
  const active = peak !== null && rates.peakMultiplier > 1 && isPeakAt(new Date(at), peak);
  return {
    usd,
    source: rateSource(config, modelId, providerId),
    peak:
      peak === null || rates.peakMultiplier <= 1
        ? null
        : { active, multiplier: rates.peakMultiplier, timezone: peak.timezone, windows: config.peak.windows }
  };
}

function rateUsage(usage, selection, config, at) {
  return rateLedger(null, usage, selection, config, at);
}

function rateLedger(ledger, usage, selection, config, at) {
  if (usage === null || usage === undefined || typeof usage !== "object") return null;
  const totals = bucketSnapshot(usage);
  if (totalOf(totals) <= 0) return null;
  const moment = at === undefined ? Date.now() : at;
  const model = pickModel(selection);
  const { usd, peak, source } = usdBreakdown(totals, selection, config, ledger, moment);
  const rows = [];
  let amount = 0;
  for (const definition of BUCKET_DEFINITIONS) {
    const count = totals[definition.key];
    if (count <= 0) continue;
    const subtotal = usd[definition.key] * config.currency.perUsd;
    amount += subtotal;
    rows.push({ key: definition.key, label: definition.label, tokens: count, amount: subtotal });
  }
  const modelLabel = model === null ? null : formatModelLabel(typeof model.provider === "string" ? model.provider : null, model.model);
  return { rows, tokens: totalOf(totals), amount, modelLabel, source, peak };
}

/* ──────────────────────────────── 格式化 ──────────────────────────────── */

function compactNumber(value) {
  if (value >= 100) return String(Math.round(value));
  return String(Math.round(value * 10) / 10);
}

/* ── 每日统计：把各会话的增量按「天」归类，跨会话汇总并持久化 ───────────── */

const DAILY_KEY = "dsh.token-purse.daily.v1";
const DAILY_KEEP_DAYS = 90;
const DAILY_VIEW_DAYS = 7;

/** 本地日期键，如 "2026-09-11"。 */
function localDayKey(moment) {
  const date = new Date(moment);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() + "-" + month + "-" + day;
}

function emptyDaily() {
  return { v: 1, days: {} };
}

/** 档位标记：p 高峰 / o 低峰 / f 平价。兼容 0.1.7 及以前的布尔值。 */
function normalizePeakFlag(value) {
  if (value === "p" || value === 1 || value === true) return "p";
  if (value === "f") return "f";
  return "o";
}

function normalizeDaily(raw) {
  const store = emptyDaily();
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return store;
  if (raw.days === null || raw.days === undefined || typeof raw.days !== "object" || Array.isArray(raw.days)) return store;
  for (const day of Object.keys(raw.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const rows = raw.days[day];
    if (!Array.isArray(rows)) continue;
    const kept = [];
    for (const row of rows) {
      if (row === null || row === undefined || typeof row !== "object") continue;
      kept.push({
        s: typeof row.s === "string" ? row.s : null,
        p: typeof row.p === "string" ? row.p : null,
        m: typeof row.m === "string" ? row.m : null,
        k: normalizePeakFlag(row.k),
        b: bucketSnapshot(row.b)
      });
    }
    if (kept.length > 0) store.days[day] = kept;
  }
  return store;
}

function readDaily() {
  try {
    const raw = window.localStorage.getItem(DAILY_KEY);
    return raw === null || raw === undefined ? emptyDaily() : normalizeDaily(JSON.parse(raw));
  } catch (error) {
    return emptyDaily();
  }
}

function writeDaily(store) {
  try {
    window.localStorage.setItem(DAILY_KEY, JSON.stringify(store));
  } catch (error) {
    /* 配额不足等：跳过，下次观察重算即可。 */
  }
}

/** 把会话账本折算成「天 × 模型 × 峰谷」的桶；重复计算同一账本结果一致（幂等）。 */
function sessionDayRows(ledger, config) {
  const peak = parsePeak(config);
  const rows = new Map();
  const push = (buckets, provider, model, moment) => {
    const day = localDayKey(moment);
    const rates = resolveRates(config, model, provider);
    const flag = rates.peakMultiplier <= 1 ? "f" : isPeakAt(new Date(moment), peak) ? "p" : "o";
    const key = day + "\u0000" + (provider === null ? "" : provider) + "\u0000" + (model === null ? "" : model) + "\u0000" + flag;
    let row = rows.get(key);
    if (row === undefined) {
      row = { d: day, p: provider, m: model, k: flag, b: zeroBuckets() };
      rows.set(key, row);
    }
    for (const bucket of BUCKETS) row.b[bucket] += buckets[bucket];
  };
  if (ledger !== null && ledger !== undefined) {
    if (ledger.base !== null) push(ledger.base.b, ledger.base.provider, ledger.base.model, ledger.base.at);
    for (const entry of ledger.entries) push(entry.b, entry.provider, entry.model, entry.at);
  }
  return Array.from(rows.values());
}

/** 把账本摊平成计价所需的「段」：base + 每笔增量 + 未被覆盖的余量（算到当前模型）。 */
function ledgerSegments(ledger, usage, selection, at) {
  const current = pickModel(selection);
  const modelId = current === null ? null : current.model;
  const providerId = current === null || typeof current.provider !== "string" || current.provider.length === 0 ? null : current.provider;
  const segments = [];
  const covered = zeroBuckets();
  /* 条目没记 provider/model 时回退到当前模型，和 rateLedger 的口径保持一致。 */
  const push = (buckets, provider, model, moment) => {
    segments.push({
      b: buckets,
      provider: provider === null || provider === undefined ? providerId : provider,
      model: model === null || model === undefined ? modelId : model,
      at: moment
    });
    for (const bucket of BUCKETS) covered[bucket] += buckets[bucket];
  };
  if (ledger !== null && ledger !== undefined) {
    if (ledger.base !== null) push(ledger.base.b, ledger.base.provider, ledger.base.model, ledger.base.at);
    for (const entry of ledger.entries) push(entry.b, entry.provider, entry.model, entry.at);
  }
  const totals = bucketSnapshot(usage);
  const rest = zeroBuckets();
  let hasRest = false;
  for (const bucket of BUCKETS) {
    const value = totals[bucket] - covered[bucket];
    if (value > 0) {
      rest[bucket] = value;
      hasRest = true;
    }
  }
  if (hasRest) push(rest, providerId, modelId, at);
  return segments;
}

/** 一段用量折算成显示币种的花费。 */
function priceSegment(buckets, rates, fx, perUsd) {
  const native = costBuckets(buckets, rates);
  const ratePerUsd = toNumber(fx[rates.currency], 1);
  const divide = ratePerUsd > 0 ? 1 / ratePerUsd : 1;
  let amount = 0;
  for (const bucket of BUCKETS) amount += native[bucket] * divide * perUsd;
  return amount;
}

/** 当前会话按 provider/model 拆分的明细，金额大的在前。 */
function sessionModelRows(ledger, usage, selection, config, at) {
  const peak = parsePeak(config);
  const fx = fxPerUsd(config);
  const perUsdValue = toNumber(config.currency.perUsd, 1);
  const perUsd = perUsdValue > 0 ? perUsdValue : 1;
  const rows = new Map();
  for (const segment of ledgerSegments(ledger, usage, selection, at)) {
    const key = (segment.provider === null ? "" : segment.provider) + "\u0000" + (segment.model === null ? "" : segment.model);
    let row = rows.get(key);
    if (row === undefined) {
      row = { key, provider: segment.provider, model: segment.model, label: formatModelLabel(segment.provider, segment.model), tokens: 0, amount: 0 };
      rows.set(key, row);
    }
    const rates = ratesAt(config, segment.model, segment.at, peak, segment.provider);
    row.amount += priceSegment(segment.b, rates, fx, perUsd);
    for (const bucket of BUCKETS) row.tokens += segment.b[bucket];
  }
  const list = Array.from(rows.values());
  list.sort((left, right) => right.amount - left.amount);
  return list;
}

/** 当前会话按「高峰 / 低峰 / 平价」分组；平价指没有配置分时价的模型。 */
function splitByPeak(ledger, usage, selection, config, at) {
  const peak = parsePeak(config);
  const fx = fxPerUsd(config);
  const perUsdValue = toNumber(config.currency.perUsd, 1);
  const perUsd = perUsdValue > 0 ? perUsdValue : 1;
  const groups = {
    peak: { key: "peak", label: "peak.group.high", tokens: 0, amount: 0 },
    off: { key: "off", label: "peak.group.low", tokens: 0, amount: 0 },
    flat: { key: "flat", label: "peak.group.flat", tokens: 0, amount: 0 }
  };
  for (const segment of ledgerSegments(ledger, usage, selection, at)) {
    const rates = ratesAt(config, segment.model, segment.at, peak, segment.provider);
    const member = rates.peakMultiplier <= 1 ? "flat" : isPeakAt(new Date(segment.at), peak) ? "peak" : "off";
    const target = groups[member];
    target.amount += priceSegment(segment.b, rates, fx, perUsd);
    for (const bucket of BUCKETS) target.tokens += segment.b[bucket];
  }
  const list = [groups.off, groups.peak, groups.flat].filter((row) => row.tokens > 0);
  list.sort((left, right) => right.amount - left.amount);
  return list;
}

/** 用当前会话的数据替换它自己的旧记录，并丢掉过期天数。 */
function mergeSessionDayRows(store, sessionId, rows, now) {
  const next = emptyDaily();
  for (const day of Object.keys(store.days)) {
    const kept = store.days[day].filter((row) => row.s !== sessionId);
    if (kept.length > 0) next.days[day] = kept;
  }
  for (const row of rows) {
    if (next.days[row.d] === undefined) next.days[row.d] = [];
    next.days[row.d].push({ s: sessionId, p: row.p, m: row.m, k: row.k, b: row.b });
  }
  const cutoff = localDayKey(now - DAILY_KEEP_DAYS * 24 * 60 * 60 * 1000);
  for (const day of Object.keys(next.days)) if (day < cutoff) delete next.days[day];
  return next;
}

/** 汇总所有会话：每天一条（含当天各 provider/model 的明细），按当前费率计价，最近的在前。 */
function dailyStats(store, config) {
  const fx = fxPerUsd(config);
  const perUsdValue = toNumber(config.currency.perUsd, 1);
  const perUsd = perUsdValue > 0 ? perUsdValue : 1;
  const days = [];
  for (const day of Object.keys(store.days)) {
    const byModel = new Map();
    const groups = {
      p: { tokens: 0, amount: 0 },
      o: { tokens: 0, amount: 0 },
      f: { tokens: 0, amount: 0 }
    };
    let amount = 0;
    let tokens = 0;
    for (const row of store.days[day]) {
      const flag = normalizePeakFlag(row.k);
      const rates = resolveRates(config, row.m, row.p);
      const factor = flag === "p" && rates.peakMultiplier > 1 ? rates.peakMultiplier : 1;
      const effective = {
        currency: rates.currency,
        input: rates.input * factor,
        cacheRead: rates.cacheRead * factor,
        cacheWrite: rates.cacheWrite * factor,
        output: rates.output * factor,
        peakMultiplier: rates.peakMultiplier
      };
      const native = costBuckets(row.b, effective);
      const ratePerUsd = toNumber(fx[effective.currency], 1);
      const divide = ratePerUsd > 0 ? 1 / ratePerUsd : 1;
      const key = (row.p === null ? "" : row.p) + "\u0000" + (row.m === null ? "" : row.m);
      let entry = byModel.get(key);
      if (entry === undefined) {
        entry = { key, provider: row.p, model: row.m, label: formatModelLabel(row.p, row.m), amount: 0, tokens: 0 };
        byModel.set(key, entry);
      }
      for (const bucket of BUCKETS) {
        const value = native[bucket] * divide * perUsd;
        amount += value;
        entry.amount += value;
        groups[flag].amount += value;
        tokens += row.b[bucket];
        entry.tokens += row.b[bucket];
        groups[flag].tokens += row.b[bucket];
      }
    }
    const models = Array.from(byModel.values());
    models.sort((left, right) => right.amount - left.amount);
    days.push({ day, amount, tokens, models, groups });
  }
  days.sort((left, right) => (left.day < right.day ? 1 : left.day > right.day ? -1 : 0));
  return days;
}

const SPARK_DAYS = 30;
const SPARK_VIEW_W = 100;
const SPARK_VIEW_H = 30;
const SPARK_PAD = 2;

/* 三种分解方式，同一时间只展开一个。 */
const TABS = [
  { key: "model", label: "tab.model", hint: "breakdown.byModelHint" },
  { key: "peak", label: "tab.peak", hint: "peak.splitHint" },
  { key: "daily", label: "tab.daily", hint: "daily.hint" }
];

/** 把稀疏的每日数据铺成连续的 count 天（缺的补 0），从旧到新。 */
function dailySeries(rows, count, now) {
  const byDay = new Map();
  for (const row of rows) byDay.set(row.day, row);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const series = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(end.getTime());
    date.setDate(date.getDate() - offset);
    const day = localDayKey(date.getTime());
    const row = byDay.get(day);
    series.push({ day, amount: row === undefined ? 0 : row.amount });
  }
  return series;
}

function roundCoord(value) {
  return Math.round(value * 100) / 100;
}

/** 折线坐标：x 均匀分布，y 按「相对最大值」落在 padding..height-padding。 */
function sparklinePoints(series, width, height, padding) {
  const inner = Math.max(height - padding * 2, 0);
  const span = Math.max(width - padding * 2, 0);
  const step = series.length > 1 ? span / (series.length - 1) : 0;
  let max = 0;
  for (const point of series) if (point.amount > max) max = point.amount;
  const points = series.map((point, index) => {
    const ratio = max > 0 ? point.amount / max : 0;
    return {
      x: roundCoord(padding + index * step),
      y: roundCoord(padding + (1 - ratio) * inner),
      amount: point.amount,
      day: point.day
    };
  });
  return { points, max };
}

function sparklineLine(points) {
  return points.map((point, index) => (index === 0 ? "M" : "L") + point.x + " " + point.y).join(" ");
}

function sparklineArea(points, height, padding) {
  if (points.length === 0) return "";
  const floor = roundCoord(height - padding);
  return sparklineLine(points) + " L" + points[points.length - 1].x + " " + floor + " L" + points[0].x + " " + floor + " Z";
}

/** "2026-09-11" -> "09-11" */
function formatDayKey(day) {
  const text = typeof day === "string" ? day : String(day);
  return text.length >= 10 ? text.slice(5) : text;
}

function formatTokens(value) {
  const count = Math.round(value);
  if (count < 1000) return String(count);
  if (count < 1e6) return compactNumber(count / 1e3) + "K";
  return compactNumber(count / 1e6) + "M";
}

function formatMoney(value, symbol) {
  const abs = Math.abs(value);
  let digits = 2;
  if (abs > 0 && abs < 0.001) digits = 5;
  else if (abs < 0.1) digits = 4;
  else if (abs < 1) digits = 3;
  let text = value.toFixed(digits);
  if (digits > 2) {
    text = text.replace(/0+$/, "");
    const dot = text.indexOf(".");
    const decimals = dot === -1 ? 0 : text.length - dot - 1;
    if (decimals < 2) text = text + "0".repeat(2 - decimals);
  }
  return symbol + text;
}

function formatRate(value) {
  return String(Number(value.toFixed(4)));
}

/* ──────────────────────────────── 组件 ──────────────────────────────── */

function TokenPurseView({ usage, selection, t, sessionId }) {
  const [config, setConfig] = useState(readConfig);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(TABS[0].key);
  const [openDay, setOpenDay] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [fxState, setFxState] = useState("idle");
  const [fxNote, setFxNote] = useState(null);
  const [ledger, setLedger] = useState(() => readLedger(sessionId));
  const [daily, setDaily] = useState(readDaily);
  const [tick, setTick] = useState(0);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current !== null && event.target instanceof Node && rootRef.current.contains(event.target)) return;
      setOpen(false);
      setEditing(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        setEditing(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const currentModel = pickModel(selection);
  const currentModelId = currentModel === null ? null : currentModel.model;
  const currentProviderId =
    currentModel === null || typeof currentModel.provider !== "string" || currentModel.provider.length === 0 ? null : currentModel.provider;

  /* 投影只给累计值；每次变化记成一条带时刻的增量，之后按各自发生时刻的档位计价。 */
  useEffect(() => {
    if (usage === null || usage === undefined) return;
    setLedger((current) => syncLedger(current, usage, currentProviderId, currentModelId, Date.now()));
  }, [usage, currentProviderId, currentModelId]);

  useEffect(() => {
    writeLedger(sessionId, ledger);
  }, [sessionId, ledger]);

  /* 每日统计：本会话重复写入同一账本结果是幂等的，不会重复计费。 */
  useEffect(() => {
    const rows = sessionDayRows(ledger, config);
    setDaily((current) => mergeSessionDayRows(current, sessionId, rows, Date.now()));
  }, [sessionId, ledger, config]);

  useEffect(() => {
    writeDaily(daily);
  }, [daily]);

  /* 高峰/低峰随时间切换，定时重算；tick 只用于驱动上面的 useMemo。 */
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const rated = useMemo(
    () => rateLedger(ledger, usage, selection, config, Date.now()),
    [ledger, usage, selection, config, tick]
  );
  const dailyRows = dailyStats(daily, config);
  const modelRows = sessionModelRows(ledger, usage, selection, config, Date.now());
  const activeTab = TABS.find((item) => item.key === tab) || TABS[0];
  const peakRows = splitByPeak(ledger, usage, selection, config, Date.now());
  const sparkSeries = dailySeries(dailyRows, SPARK_DAYS, Date.now());
  const spark = sparklinePoints(sparkSeries, SPARK_VIEW_W, SPARK_VIEW_H, SPARK_PAD);
  const sparkAvg = sparkSeries.reduce((sum, point) => sum + point.amount, 0) / SPARK_DAYS;

  if (rated === null) return null;

  const symbol = config.currency.symbol;
  const amountText = formatMoney(rated.amount, symbol);
  const modelText = rated.modelLabel === null ? t("panel.defaultModel") : rated.modelLabel;

  const beginEdit = () => {
    setDraft(JSON.stringify(config, null, 2));
    setInvalid(false);
    setEditing(true);
  };
  const saveEdit = () => {
    let parsed;
    try {
      parsed = JSON.parse(draft);
    } catch (parseError) {
      setInvalid(true);
      return;
    }
    const merged = mergeConfig(cloneConfig(DEFAULT_CONFIG), parsed);
    writeConfig(merged);
    setConfig(merged);
    setInvalid(false);
    setEditing(false);
  };
  const resetEdit = () => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (removeError) {
      /* 忽略：读回默认值即可。 */
    }
    const fresh = readConfig();
    setConfig(fresh);
    setDraft(JSON.stringify(fresh, null, 2));
    setInvalid(false);
  };
  const updateCurrency = (patch) => {
    const merged = mergeConfig(config, { currency: patch });
    writeConfig(merged);
    setConfig(merged);
  };
  const currencyPreset = findCurrencyPreset(config.currency.code, symbol);

  const refreshRate = (codeOverride) => {
    const override = typeof codeOverride === "string" && codeOverride.length > 0 ? codeOverride : null;
    const code = override !== null ? override : currencyPreset === null ? "" : currencyPreset.code;
    if (code.length === 0 || typeof fetch !== "function") {
      setFxNote(t("currency.manual"));
      return;
    }
    setFxState("loading");
    setFxNote(null);
    fetchUsdRate(code).then((result) => {
      if (result === null) {
        setFxState("error");
        setFxNote(t("currency.failed"));
        return;
      }
      setConfig((current) => {
        const merged = mergeConfig(current, {
          currency: { perUsd: result.rate },
          /* 同步 fx，切到别的显示币种时费率换算仍准确。 */
          fx: { [code.toUpperCase()]: result.rate }
        });
        writeConfig(merged);
        return merged;
      });
      writeFxTime(Date.now());
      setFxState("idle");
      setFxNote(t("currency.updated", { rate: formatRate(result.rate), source: result.source }));
    });
  };

  const maybeAutoFetch = () => {
    if (config.currency.auto !== true || currencyPreset === null) return;
    if (Date.now() - readFxTime() < FX_TTL_MS) return;
    refreshRate(currencyPreset.code);
  };

  const peakInfo = rated.peak;
  const modeText =
    peakInfo === null || peakInfo === undefined
      ? null
      : peakInfo.active
        ? t("peak.high", { factor: peakInfo.multiplier })
        : t("peak.low");

  return h(
    "span",
    { className: CSS.root, ref: rootRef },
    h(
      "button",
      {
        type: "button",
        className: CSS.trigger,
        "aria-label": modeText === null ? t("trigger.aria", { amount: amountText }) : t("trigger.aria", { amount: amountText }) + " · " + modeText,
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        onClick: () => {
          const next = !open;
          setOpen(next);
          if (next) maybeAutoFetch();
        }
      },
      h("span", { className: CSS.approx, "aria-hidden": true }, "≈"),
      h("span", { className: CSS.amount }, amountText),
      modeText === null
        ? null
        : h(
            "span",
            {
              className: CSS.modeChip + (peakInfo.active ? " " + CSS.modeChipOn : ""),
              title:
                (peakInfo.active ? t("peak.modeHigh", { factor: peakInfo.multiplier }) : t("peak.modeLow")) +
                " · " +
                t("peak.note", { windows: peakInfo.windows.join(" / "), timezone: peakInfo.timezone }),
              "aria-hidden": true
            },
            peakInfo.active ? t("peak.badgeHigh", { factor: peakInfo.multiplier }) : t("peak.badgeLow")
          ),
      h("span", { className: open ? CSS.chevron + " " + CSS.chevronOpen : CSS.chevron, "aria-hidden": true }, "▾")
    ),
    open
      ? h(
          "div",
          { className: CSS.panel, role: "dialog", "aria-label": t("panel.title") },
          h(
            "div",
            { className: CSS.head },
            h("span", { className: CSS.title }, t("panel.title")),
            h("span", { className: CSS.total }, "≈" + amountText)
          ),
          h(
            "div",
            { className: CSS.modelLine },
            h("span", null, t("panel.model")),
            h(
              "span",
              {
                className:
                  CSS.sourceChip +
                  (rated.source === "provider" ? " " + CSS.sourceChipExact : rated.source === "fallback" ? " " + CSS.sourceChipMiss : ""),
                title: t("rate.source." + rated.source)
              },
              t("rate.source." + rated.source)
            ),
            h("span", { className: CSS.modelValue, title: modelText }, modelText)
          ),
          h(
            "dl",
            { className: CSS.rows },
            rated.rows.map((row) =>
              h(
                "div",
                { className: CSS.row, key: row.key },
                h("dt", null, t(row.label)),
                h(
                  "dd",
                  null,
                  h("span", { className: CSS.tokens }, formatTokens(row.tokens)),
                  h("span", { className: CSS.sub }, formatMoney(row.amount, symbol))
                )
              )
            ),
            h(
              "div",
              { className: CSS.row + " " + CSS.rowTotal },
              h("dt", null, t("panel.totalTokens")),
              h("dd", null, h("span", { className: CSS.tokens }, formatTokens(rated.tokens)))
            )
          ),
          rated.peak === null || rated.peak === undefined
            ? null
            : h(
                "div",
                { className: CSS.peakNote },
                h("span", { className: CSS.peakLabel }, t("peak.current")),
                h(
                  "span",
                  { className: CSS.peakChip + (rated.peak.active ? " " + CSS.peakChipOn : "") },
                  rated.peak.active ? t("peak.high", { factor: rated.peak.multiplier }) : t("peak.low")
                ),
                h("span", { className: CSS.peakText }, t("peak.note", { windows: rated.peak.windows.join(" / "), timezone: rated.peak.timezone }))
              ),
          h(
            "div",
            { className: CSS.tabs, role: "tablist" },
            TABS.map((item) =>
              h(
                "button",
                {
                  key: item.key,
                  type: "button",
                  role: "tab",
                  "aria-selected": tab === item.key,
                  className: tab === item.key ? CSS.tab + " " + CSS.tabOn : CSS.tab,
                  onClick: () => setTab(item.key)
                },
                t(item.label)
              )
            )
          ),
          h(
            "div",
            { className: CSS.section + " " + CSS.sectionFlat, title: t(activeTab.hint) },
            tab === "model"
              ? modelRows.length < 2
                ? h("div", { className: CSS.breakRow }, h("span", { className: CSS.peakLine }, t("breakdown.singleModel")))
                : modelRows.map((row) =>
                    h(
                      "div",
                      { className: CSS.breakItem, key: row.key },
                      h(
                        "div",
                        { className: CSS.breakRow },
                        h("span", { className: CSS.breakLabel, title: row.label === null ? t("breakdown.unknown") : row.label }, row.label === null ? t("breakdown.unknown") : row.label),
                        h("span", { className: CSS.breakTokens }, formatTokens(row.tokens)),
                        h("span", { className: CSS.breakAmount }, formatMoney(row.amount, symbol))
                      ),
                      h(
                        "span",
                        { className: CSS.share },
                        h("span", { className: CSS.shareFill, style: { width: sharePercent(row.amount, rated.amount) + "%" } })
                      )
                    )
                  )
              : tab === "peak"
                ? peakRows.length === 0
                  ? h("div", { className: CSS.breakRow }, h("span", { className: CSS.peakLine }, t("peak.splitNone")))
                  : peakRows.map((row) =>
                      h(
                        "div",
                        { className: CSS.breakItem, key: row.key },
                        h(
                          "div",
                          { className: CSS.breakRow },
                          h("span", { className: CSS.breakLabel }, t(row.label)),
                          h("span", { className: CSS.breakTokens }, formatTokens(row.tokens)),
                          h("span", { className: CSS.breakAmount }, formatMoney(row.amount, symbol))
                        ),
                        h(
                          "span",
                          { className: CSS.share },
                          h("span", { className: CSS.shareFill, style: { width: sharePercent(row.amount, rated.amount) + "%" } })
                        )
                      )
                    )
                : dailyRows.length === 0
                  ? h("div", { className: CSS.breakRow }, h("span", { className: CSS.peakLine }, t("daily.empty")))
                  : [
                      spark.max <= 0
                        ? null
                        : h(
                            "div",
                            { className: CSS.sparkWrap, key: "spark" },
                            h(
                              "svg",
                              {
                                className: CSS.spark,
                                viewBox: "0 0 " + SPARK_VIEW_W + " " + SPARK_VIEW_H,
                                preserveAspectRatio: "none",
                                role: "img",
                                "aria-label": t("spark.aria", { days: SPARK_DAYS, max: formatMoney(spark.max, symbol) })
                              },
                              h("path", { className: CSS.sparkArea, d: sparklineArea(spark.points, SPARK_VIEW_H, SPARK_PAD) }),
                              h("path", { className: CSS.sparkLine, d: sparklineLine(spark.points), vectorEffect: "non-scaling-stroke" })
                            ),
                            h(
                              "span",
                              { className: CSS.sparkNote },
                              t("spark.summary", { days: SPARK_DAYS, max: formatMoney(spark.max, symbol), avg: formatMoney(sparkAvg, symbol) })
                            )
                          ),
                      dailyRows.slice(0, DAILY_VIEW_DAYS).map((day) => {
                        const detail = day.models.length > 1 || day.groups.p.tokens > 0 || day.groups.f.tokens > 0;
                        const expanded = detail && openDay === day.day;
                        const cells = [
                          h("span", { className: CSS.breakDay, key: "day" }, formatDayKey(day.day)),
                          h("span", { className: CSS.breakTokens, key: "tokens" }, formatTokens(day.tokens)),
                          h("span", { className: CSS.breakAmount, key: "amount" }, formatMoney(day.amount, symbol))
                        ];
                        return h(
                          "div",
                          { key: day.day },
                          detail
                            ? h(
                                "button",
                                {
                                  type: "button",
                                  className: CSS.breakRow + " " + CSS.dayRow,
                                  "aria-expanded": expanded,
                                  onClick: () => setOpenDay(expanded ? null : day.day)
                                },
                                cells
                              )
                            : h("div", { className: CSS.breakRow }, cells),
                          expanded
                            ? h(
                                "div",
                                { className: CSS.breakSub },
                                day.groups.p.tokens > 0 || day.groups.f.tokens > 0
                                  ? h(
                                      "div",
                                      { className: CSS.breakRow },
                                      h(
                                        "span",
                                        { className: CSS.peakLine },
                                        [
                                          day.groups.p.tokens > 0 ? t("peak.group.high") + " " + formatMoney(day.groups.p.amount, symbol) : null,
                                          day.groups.o.tokens > 0 ? t("peak.group.low") + " " + formatMoney(day.groups.o.amount, symbol) : null,
                                          day.groups.f.tokens > 0 ? t("peak.group.flat") + " " + formatMoney(day.groups.f.amount, symbol) : null
                                        ]
                                          .filter((part) => part !== null)
                                          .join(" · ")
                                      )
                                    )
                                  : null,
                                day.models.map((model) =>
                                  h(
                                    "div",
                                    { className: CSS.breakRow, key: model.key },
                                    h("span", { className: CSS.breakLabel, title: model.label === null ? t("breakdown.unknown") : model.label }, model.label === null ? t("breakdown.unknown") : model.label),
                                    h("span", { className: CSS.breakTokens }, formatTokens(model.tokens)),
                                    h("span", { className: CSS.breakAmount }, formatMoney(model.amount, symbol))
                                  )
                                )
                              )
                            : null
                        );
                      })
                    ]
          ),
          h("div", { className: CSS.note }, t("panel.note")),
          rated.source === "fallback"
            ? h("div", { className: CSS.warnNote }, t("rate.unpriced", { model: rated.modelLabel }))
            : null,
          editing
            ? h(
                "div",
                { className: CSS.editor },
                h(
                  "div",
                  { className: CSS.fields },
                  h("span", { className: CSS.fieldLabel }, t("currency.label")),
                  h(
                    "select",
                    {
                      className: CSS.select,
                      value: currencyPreset === null ? "custom" : currencyPreset.code,
                      onChange: (event) => {
                        const preset = CURRENCY_PRESETS.find((item) => item.code === event.target.value);
                        if (preset === undefined) return;
                        updateCurrency({ code: preset.code, symbol: preset.symbol, perUsd: preset.perUsd });
                        refreshRate(preset.code);
                      }
                    },
                    CURRENCY_PRESETS.map((preset) => h("option", { key: preset.code, value: preset.code }, preset.code + " " + preset.symbol)),
                    currencyPreset === null ? h("option", { value: "custom" }, t("currency.custom", { symbol })) : null
                  ),
                  h("span", { className: CSS.fieldLabel }, t("currency.perUsd")),
                  h("input", {
                    key: symbol + ":" + config.currency.perUsd,
                    className: CSS.rateInput,
                    type: "number",
                    min: "0.0001",
                    step: "0.01",
                    defaultValue: String(config.currency.perUsd),
                    "aria-label": t("currency.perUsd"),
                    onBlur: (event) => updateCurrency({ perUsd: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === "Enter") event.target.blur();
                    }
                  })
                ),
                h(
                  "div",
                  { className: CSS.fxRow },
                  h(
                    "button",
                    {
                      type: "button",
                      className: CSS.fxButton,
                      disabled: fxState === "loading" || currencyPreset === null,
                      onClick: () => refreshRate()
                    },
                    fxState === "loading" ? t("currency.fetching") : t("currency.fetch")
                  ),
                  h(
                    "label",
                    { className: CSS.fxAuto },
                    h("input", {
                      type: "checkbox",
                      checked: config.currency.auto === true,
                      onChange: (event) => updateCurrency({ auto: event.target.checked })
                    }),
                    t("currency.auto")
                  )
                ),
                fxNote !== null ? h("div", { className: CSS.fxNote }, fxNote) : null,
                h("textarea", {
                  className: CSS.textarea,
                  value: draft,
                  spellCheck: false,
                  "aria-label": t("rates.hint"),
                  onChange: (event) => setDraft(event.target.value)
                }),
                h("div", { className: CSS.hint }, t("rates.hint")),
                invalid ? h("div", { className: CSS.error }, t("rates.invalid")) : null,
                h(
                  "div",
                  { className: CSS.actions },
                  h("button", { type: "button", className: CSS.ghost, onClick: resetEdit }, t("rates.reset")),
                  h("button", { type: "button", className: CSS.primary, onClick: saveEdit }, t("rates.save"))
                )
              )
            : h("button", { type: "button", className: CSS.editButton, onClick: beginEdit }, t("rates.edit"))
        )
      : null
  );
}

/**
 * 把花费徽标宿进会话统计行，与「轮数·步数·tok/s」「token·缓存命中率」同行。
 *
 * 统计行由 @deepseek-ai/dsh-client-ui-chat 直接渲染，不是插槽，所以这里：
 *   1. 从本插槽在同一父节点下找到带 data-composer-stats 的那一行；
 *   2. 用 portal 把徽标挂进该行，使其成为同一 flex 行里的一枚 pill；
 *   3. 行消失（空会话）时自动卸载，行重建（切换会话）时自动重挂。
 */
function StatsRowBadge({ useProjection, t, sessionId }) {
  const usage = useProjection("tokenUsage");
  const selection = useProjection("modelSelection");
  const anchorRef = useRef(null);
  const [host, setHost] = useState(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    const container = anchor === null || anchor === undefined ? null : anchor.parentElement;
    if (container === null || container === undefined || typeof MutationObserver === "undefined") return undefined;
    const locate = () => container.querySelector("[data-composer-stats]");
    const sync = () => {
      const found = locate();
      setHost((current) => (found === current ? current : found));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(container, { childList: true });
    return () => observer.disconnect();
  }, []);

  const anchor = h("span", { ref: anchorRef, className: CSS.host, "aria-hidden": "true" });
  if (host === null) return anchor;
  return h(React.Fragment, null, anchor, createPortal(h(TokenPurseView, { usage, selection, t, sessionId }), host));
}

/* ──────────────────────────────── 词条 ──────────────────────────────── */

const zh = {
  "trigger.aria": "Token 花费约 {amount}",
  "panel.title": "Token 花费",
  "panel.model": "计价模型",
  "panel.defaultModel": "默认费率",
  "panel.totalTokens": "合计 tokens",
  "panel.note": "按本地费率估算，仅供参考，并非账单数据。",
  "bucket.input": "输入（未缓存）",
  "bucket.cacheRead": "缓存命中",
  "bucket.cacheWrite": "缓存写入",
  "bucket.output": "输出",
  "rates.edit": "调整费率",
  "rates.hint": "以 JSON 覆盖默认费率。数值是「每百万 token」，币种由每条费率自己的 currency 决定（默认人民币）。",
  "rates.save": "保存",
  "rates.reset": "恢复默认",
  "rates.invalid": "JSON 格式有误，请检查后重试。",
  "currency.label": "货币",
  "currency.perUsd": "1 美元 =",
  "currency.custom": "自定义 {symbol}",
  "currency.fetch": "自动获取汇率",
  "currency.fetching": "获取中…",
  "currency.auto": "自动",
  "currency.updated": "已更新：1 美元 = {rate}（{source}）",
  "currency.failed": "获取失败，已保留当前汇率",
  "currency.manual": "该币种无法自动获取，请手动填写",
  "peak.high": "高峰 ×{factor}",
  "peak.low": "低峰",
  "peak.current": "当前计费",
  "peak.badgeHigh": "峰×{factor}",
  "peak.badgeLow": "谷",
  "peak.modeHigh": "当前处于高峰时段，单价 ×{factor}",
  "peak.modeLow": "当前处于低峰（空闲）时段",
  "breakdown.unknown": "未知模型",
  "breakdown.byModelHint": "本会话各 provider / 模型的用量与花费",
  "daily.hint": "按观察时刻归入当天，保留最近 90 天",
  "tab.model": "模型",
  "tab.peak": "峰谷",
  "tab.daily": "每日",
  "breakdown.singleModel": "本会话只用了一个模型",
  "peak.splitNone": "本会话没有分时计费的消耗",
  "daily.empty": "还没有历史记录",
  "peak.splitHint": "本会话按当时生效的费率档位汇总（高峰 / 低峰 / 平价）",
  "peak.group.high": "高峰",
  "peak.group.low": "低峰",
  "peak.group.flat": "平价",
  "spark.summary": "近 {days} 天 · 最高 {max} · 日均 {avg}",
  "spark.aria": "近 {days} 天花费折线图，最高 {max}",
  "peak.note": "{windows} · {timezone}",
  "rate.unpriced": "未配置 {model} 的费率，当前按通用兜底价估算——点下方「调整费率」补上。",
  "rate.source.provider": "专属费率",
  "rate.source.model": "通用费率",
  "rate.source.substring": "按型号匹配",
  "rate.source.fallback": "未配置"
};

const en = {
  "trigger.aria": "Token spend roughly {amount}",
  "panel.title": "Token spend",
  "panel.model": "Priced model",
  "panel.defaultModel": "Default rates",
  "panel.totalTokens": "Total tokens",
  "panel.note": "Estimated from local rates — an approximation, not a bill.",
  "bucket.input": "Input (uncached)",
  "bucket.cacheRead": "Cache read",
  "bucket.cacheWrite": "Cache write",
  "bucket.output": "Output",
  "rates.edit": "Edit rates",
  "rates.hint": "Override default rates with JSON. Values are per million tokens in each entry's own currency (CNY by default).",
  "rates.save": "Save",
  "rates.reset": "Reset",
  "rates.invalid": "Invalid JSON — please check and retry.",
  "currency.label": "Currency",
  "currency.perUsd": "1 USD =",
  "currency.custom": "Custom {symbol}",
  "currency.fetch": "Auto-fetch rate",
  "currency.fetching": "Fetching…",
  "currency.auto": "Auto",
  "currency.updated": "Updated: 1 USD = {rate} ({source})",
  "currency.failed": "Fetch failed — keeping current rate",
  "currency.manual": "Can't auto-fetch this currency — enter it manually",
  "peak.high": "Peak ×{factor}",
  "peak.low": "Off-peak",
  "peak.current": "Current pricing",
  "peak.badgeHigh": "Peak×{factor}",
  "peak.badgeLow": "Off",
  "peak.modeHigh": "Currently in peak hours, unit price ×{factor}",
  "peak.modeLow": "Currently off-peak (idle) hours",
  "breakdown.unknown": "Unknown model",
  "breakdown.byModelHint": "Tokens and spend per provider / model in this session",
  "daily.hint": "Bucketed by observation time, last 90 days kept",
  "tab.model": "Models",
  "tab.peak": "Peak",
  "tab.daily": "Daily",
  "breakdown.singleModel": "One model in this session",
  "peak.splitNone": "No time-of-day priced usage in this session",
  "daily.empty": "No history yet",
  "peak.splitHint": "This session grouped by the rate bracket that applied (peak / off-peak / flat)",
  "peak.group.high": "Peak",
  "peak.group.low": "Off-peak",
  "peak.group.flat": "Flat",
  "spark.summary": "Last {days} days · peak {max} · avg {avg}",
  "spark.aria": "Spend over the last {days} days, peak {max}",
  "peak.note": "{windows} · {timezone}",
  "rate.unpriced": "No rate configured for {model} — estimating with the generic fallback. Add it under Edit rates.",
  "rate.source.provider": "Provider rate",
  "rate.source.model": "Generic rate",
  "rate.source.substring": "Model match",
  "rate.source.fallback": "Unpriced"
};

/* ──────────────────────────────── 注册 ──────────────────────────────── */

const inject = ["sessions", "slots", "locale"];

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "token-purse: dictionaries");
  ctx.slots.inject("conversation.composer.dock", () =>
    ctx.slots.register({ name: "conversation.composer.dock", id: "token-purse", order: 100, locale: NS }, StatsRowBadge)
  );
}

exports.apply = apply;
exports.inject = inject;