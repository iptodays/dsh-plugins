#!/usr/bin/env node
/**
 * TokenPurse 冒烟测试（零依赖，不联网）。
 *
 * 覆盖三件事：
 *   1. lib/client.js 是可被 DSH 模块加载器物化的合法外壳；
 *   2. exports.apply 会把词条与会话统计行占位注册到正确的 slot；
 *   3. src/client.js 里的纯换算函数（费率匹配 / 计费 / 格式化 / 配置合并）
 *      给出预期的数值。
 *
 * 用 node:vm 在隔离沙箱里执行，避免污染进程全局。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log("  ok   " + label);
  } else {
    failures += 1;
    console.error("  FAIL " + label);
  }
}

/* 固定“当前时间”为周一 12:00 Asia/Shanghai（空闲时段），让渲染测试可复现。 */
const FIXED_NOW = new Date("2025-01-06T04:00:00Z").getTime();
const monday0900Utc = new Date("2025-01-06T01:00:00Z");
const monday1200Utc = new Date("2025-01-06T04:00:00Z");
const monday1430Utc = new Date("2025-01-06T06:30:00Z");
const monday1800Utc = new Date("2025-01-06T10:00:00Z");
const sunday0900Utc = new Date("2025-01-05T01:00:00Z");

function fakeReact() {
  let index = 0;
  const store = [];
  return {
    reset() {
      index = 0;
      store.length = 0;
    },
    seed(values) {
      for (const key of Object.keys(values)) store[Number(key)] = values[key];
    },
    useState(init) {
      const at = index++;
      if (!(at in store)) store[at] = typeof init === "function" ? init() : init;
      return [store[at], () => {}];
    },
    useRef(init) {
      const at = index++;
      if (!(at in store)) store[at] = { current: init };
      return store[at];
    },
    useMemo(fn) {
      const at = index++;
      if (!(at in store)) store[at] = fn();
      return store[at];
    },
    useEffect() {
      index += 1;
    },
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() };
    }
  };
}

const fakeReactDom = { createPortal: (node, container) => ({ type: "portal", node, container }) };

function makeSandbox(react, extra, now) {
  const RealDate = Date;
  const at = now === undefined ? FIXED_NOW : now;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(at);
      else super(...args);
    }
    static now() {
      return at;
    }
  }
  const sandbox = { console, Date: FixedDate };
  sandbox.window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    __ModuleLoader__: { load: (registration) => { sandbox.registration = registration; } }
  };
  sandbox.document = undefined;
  sandbox.fetch = async () => ({
    ok: true,
    json: async () => ({ rates: { CNY: 7.11, EUR: 0.9 } })
  });
  sandbox.require = (specifier) => {
    if (specifier === "react") return react;
    if (specifier === "react-dom") return fakeReactDom;
    throw new Error("unexpected require: " + specifier);
  };
  sandbox.exports = {};
  sandbox.module = { exports: sandbox.exports };
  if (extra) extra(sandbox);
  vm.createContext(sandbox);
  return sandbox;
}

function loadInternals(react, now, extra) {
  const sandbox = makeSandbox(react, extra, now);
  const source =
    readFileSync(join(root, "src", "client.js"), "utf8") +
    "\nexports.__test = { rateUsage, rateLedger, resolveRates, mergeConfig, formatMoney, formatTokens, formatRate, DEFAULT_CONFIG, TokenPurseView, matchCurrencyPreset, findCurrencyPreset, fetchUsdRate, parsePeakWindow, parsePeak, isPeakAt, ratesAt, emptyLedger, syncLedger, migrateConfigV1, rateSource, CURRENCY_PRESETS, localDayKey, sessionModelRows, formatModelLabel, sharePercent, legacyCurrencyConfig, migrateLegacyCurrency, readConfig, dailySeries, sparklinePoints, sparklineLine, sparklineArea, SPARK_DAYS, splitByPeak, ledgerSegments, priceSegment, normalizePeakFlag, sessionDayRows, mergeSessionDayRows, dailyStats, normalizeDaily, emptyDaily, formatDayKey };\n";
  vm.runInContext(source, sandbox);
  return sandbox.exports.__test;
}

function loadBundle(react, now, extra) {
  const sandbox = makeSandbox(react, extra, now);
  vm.runInContext(readFileSync(join(root, "lib", "client.js"), "utf8"), sandbox);
  return sandbox.registration;
}

/* ── 1. 纯函数 ──────────────────────────────────────────────────────── */

console.log("pure helpers");
const react = fakeReact();
const internals = loadInternals(react);
const config = internals.DEFAULT_CONFIG;
/* 只带模型名、不带 provider 前缀的条目（验证兜底匹配）。 */
const modelOnlyConfig = internals.mergeConfig(config, {
  models: { "deepseek-v4-pro": { currency: "CNY", input: 4.5 }, "deepseek-v4-flash": { currency: "CNY", input: 1 } }
});

check("default currency is CNY", internals.DEFAULT_CONFIG.currency.code === "CNY" && internals.DEFAULT_CONFIG.currency.symbol === "¥" && internals.DEFAULT_CONFIG.currency.perUsd > 1);
check(
  "legacyCurrencyConfig spots 0.1.0 configs",
  internals.legacyCurrencyConfig({ currency: { symbol: "$", perUsd: 1 } }) === true &&
    internals.legacyCurrencyConfig({ currency: { code: "USD", symbol: "$", perUsd: 1 } }) === false &&
    internals.legacyCurrencyConfig({ models: {} }) === false
);
const migratedCurrency = internals.migrateLegacyCurrency({ currency: { symbol: "$", perUsd: 1, auto: true } });
check(
  "migrateLegacyCurrency -> CNY",
  migratedCurrency.currency.code === "CNY" && migratedCurrency.currency.symbol === "¥" && migratedCurrency.currency.perUsd === 7.1 && migratedCurrency.currency.auto === true
);
const keptCurrency = internals.migrateLegacyCurrency({ currency: { code: "USD", symbol: "$", perUsd: 1 } });
check("migrateLegacyCurrency keeps explicit USD", keptCurrency.currency.code === "USD" && keptCurrency.currency.symbol === "$");
check("formatMoney(0.28) -> $0.28", internals.formatMoney(0.28, "$") === "$0.28");
check("formatMoney(0.0123) -> $0.0123", internals.formatMoney(0.0123, "$") === "$0.0123");
check("formatMoney(12.5) -> $12.50", internals.formatMoney(12.5, "$") === "$12.50");
check("formatTokens(1234567) -> 1.2M", internals.formatTokens(1234567) === "1.2M");
check("formatTokens(1500) -> 1.5K", internals.formatTokens(1500) === "1.5K");

check("resolveRates provider exact", internals.resolveRates(config, "deepseek-flash", "deepseek-official").output === 4 && internals.resolveRates(config, "deepseek-flash", "deepseek-official").currency === "CNY");
check("resolveRates model exact", internals.resolveRates(modelOnlyConfig, "deepseek-v4-pro", "some-gateway").input === 4.5);
check("resolveRates substring", internals.resolveRates(modelOnlyConfig, "deepseek-v4-flash-exp", "packyapi").input === 1);
check("resolveRates fallback", internals.resolveRates(config, "utterly-unknown").input === 1);

const usage = { uncachedInputTokens: 1000000, cacheReadTokens: 1000000, cacheWriteTokens: 0, outputTokens: 500000 };
const selection = { next: { provider: "deepseek-official", model: "deepseek-flash" }, lastUsed: null };
const rated = internals.rateUsage(usage, selection, config, monday1200Utc.getTime());
check("rateUsage CNY 1 + 0.02 + 2 = 3.02", Math.abs(rated.amount - 3.02) < 1e-9);
check("rateUsage drops empty buckets", rated.rows.length === 3);
check("rateUsage model label", rated.modelLabel === "deepseek-official / deepseek-flash");
check("rateUsage zero usage -> null", internals.rateUsage({}, selection, config) === null);

const merged = internals.mergeConfig(config, {
  currency: { symbol: "y", perUsd: 7.2 },
  models: { "my-model": { input: 1, output: 2 } }
});
check("mergeConfig currency", merged.currency.symbol === "y" && merged.currency.perUsd === 7.2);
check("mergeConfig adds model", merged.models["my-model"].input === 1 && merged.models["my-model"].cacheRead === 1);

check("matchCurrencyPreset CNY", internals.matchCurrencyPreset("¥", 7.2).code === "CNY");
check("matchCurrencyPreset JPY distinct", internals.matchCurrencyPreset("¥", 150).code === "JPY");
check("matchCurrencyPreset custom -> null", internals.matchCurrencyPreset("$", 3) === null);
const usdConfig = internals.mergeConfig(config, { currency: { code: "USD", symbol: "$", perUsd: 1 }, fx: { CNY: 7.2 } });
check("CNY rates -> USD display", Math.abs(internals.rateUsage(usage, selection, usdConfig, monday1200Utc.getTime()).amount - 3.02 / 7.2) < 1e-9);
const cnyConfig = internals.mergeConfig(config, { currency: { symbol: "¥", perUsd: 7.2 } });
check("CNY display keeps list price", Math.abs(internals.rateUsage(usage, selection, cnyConfig, monday1200Utc.getTime()).amount - 3.02) < 1e-9);
check("findCurrencyPreset CNY", internals.findCurrencyPreset("CNY", "¥").code === "CNY");
check("findCurrencyPreset symbol mismatch -> null", internals.findCurrencyPreset("USD", "¥") === null);
check("formatRate trims", internals.formatRate(6.728034) === "6.728");
const autoCfg = internals.mergeConfig(config, { currency: { code: "CNY", symbol: "¥", perUsd: 7.2, auto: true } });
check("mergeConfig keeps code+auto", autoCfg.currency.code === "CNY" && autoCfg.currency.auto === true && autoCfg.currency.symbol === "¥");
const fx = await internals.fetchUsdRate("CNY");
check("fetchUsdRate parses provider", fx !== null && Math.abs(fx.rate - 7.11) < 1e-9 && fx.source === "open.er-api.com");
check("fetchUsdRate unknown -> null", (await internals.fetchUsdRate("XYZ")) === null);

/* ── 1b. 分时时段 ───────────────────────────────────────────────────── */

const peakWindow = internals.parsePeakWindow("Mon-Fri 09:00-12:00");
check("parsePeakWindow days+clock", peakWindow !== null && peakWindow.days.has(1) && peakWindow.days.has(5) && !peakWindow.days.has(6) && peakWindow.from === 540 && peakWindow.to === 720);
check("parsePeakWindow invalid -> null", internals.parsePeakWindow("nonsense") === null && internals.parsePeakWindow("Mon-Fri 12:00-09:00") === null);
const peak = internals.parsePeak(config);
check("isPeakAt Mon 09:00 CST", internals.isPeakAt(monday0900Utc, peak) === true);
check("isPeakAt Mon 12:00 CST off", internals.isPeakAt(monday1200Utc, peak) === false);
check("isPeakAt Mon 14:30 CST", internals.isPeakAt(monday1430Utc, peak) === true);
check("isPeakAt Mon 18:00 CST off (half-open)", internals.isPeakAt(monday1800Utc, peak) === false);
check("isPeakAt Sun 09:00 CST off", internals.isPeakAt(sunday0900Utc, peak) === false);

/* ── 1c. packyapi deepseek-flash 分时费率 ────────────────────────────── */

const flashSelection = { next: { provider: "packyapi", model: "deepseek-flash" }, lastUsed: null };
const flashUsage = { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000000 };
const flashOff = internals.rateUsage(flashUsage, flashSelection, config, monday1200Utc.getTime());
const flashHigh = internals.rateUsage(flashUsage, flashSelection, config, monday0900Utc.getTime());
check("packyapi flash idle ¥4.00", Math.abs(flashOff.amount - 4) < 1e-9 && flashOff.peak.active === false);
check("packyapi flash peak ¥8.00 (x2)", Math.abs(flashHigh.amount - 8) < 1e-9 && flashHigh.peak.active === true && flashHigh.peak.multiplier === 2);
const officialFlashIdle = internals.rateUsage(flashUsage, { next: { provider: "deepseek-official", model: "deepseek-flash" } }, config, monday1200Utc.getTime());
check("official flash idle ¥5.00", Math.abs(officialFlashIdle.amount - 5) < 1e-9);

/* ── 1d. 增量账本 ───────────────────────────────────────────────────── */

let led = internals.emptyLedger();
led = internals.syncLedger(led, { uncachedInputTokens: 100 }, null, null, 1000);
check("ledger first observation -> base", led.base !== null && led.base.b.uncachedInputTokens === 100 && led.entries.length === 0);
led = internals.syncLedger(led, { uncachedInputTokens: 300 }, null, null, 2000);
check("ledger delta -> entry", led.entries.length === 1 && led.entries[0].b.uncachedInputTokens === 200 && led.entries[0].at === 2000);
check("ledger no-op returns same object", internals.syncLedger(led, { uncachedInputTokens: 300 }, null, null, 3000) === led);
const ledReset = internals.syncLedger(led, { uncachedInputTokens: 5 }, null, null, 4000);
check("ledger resets on decrease", ledReset.entries.length === 0 && ledReset.base.b.uncachedInputTokens === 5);

const ledgerConfig = internals.mergeConfig(config, { models: { "deepseek-flash": { input: 1, output: 1, cacheRead: 1, peakMultiplier: 2 } } });
let splitLedger = internals.syncLedger(internals.emptyLedger(), { uncachedInputTokens: 0 }, null, null, monday1200Utc.getTime());
splitLedger = internals.syncLedger(splitLedger, { uncachedInputTokens: 1000000 }, null, null, monday1200Utc.getTime());
splitLedger = internals.syncLedger(splitLedger, { uncachedInputTokens: 2000000 }, null, null, monday0900Utc.getTime());
const splitRated = internals.rateLedger(splitLedger, { uncachedInputTokens: 2000000 }, { next: { model: "deepseek-flash" } }, ledgerConfig, monday0900Utc.getTime());
check("ledger prices each bracket ($1 off + $2 peak = $3)", Math.abs(splitRated.amount - 3) < 1e-9);
check("rateLedger reports active peak", splitRated.peak.active === true && splitRated.peak.multiplier === 2);

/* ── 1e. 旧配置迁移 ─────────────────────────────────────────────────── */

const legacy = internals.migrateConfigV1(JSON.parse(JSON.stringify({
  currency: { symbol: "¥", perUsd: 7 },
  models: { "deepseek-flash": { input: 0.28, cacheRead: 0.028, cacheWrite: 0.28, output: 0.42 }, custom: { input: 5, output: 6 } }
})));
check("migrate drops legacy flash", legacy.models["deepseek-flash"] === undefined && legacy.models.custom.input === 5);
check("migrate keeps edited flash", internals.migrateConfigV1({ models: { "deepseek-flash": { input: 0.5, output: 0.9 } } }).models["deepseek-flash"].input === 0.5);
const migrated = internals.mergeConfig(internals.DEFAULT_CONFIG, legacy);
check("migrated config gains packyapi flash", Math.abs(migrated.models["packyapi/deepseek-flash"].input - 0.8) < 1e-9 && migrated.models["packyapi/deepseek-flash"].peakMultiplier === 2);

/* ── 1f. provider 专属费率 ──────────────────────────────────────────── */

check("provider/model wins over model", internals.resolveRates(config, "deepseek-flash", "packyapi").input === 0.8 && internals.rateSource(config, "deepseek-flash", "packyapi") === "provider");
check("packyapi v4-flash 5折", internals.resolveRates(config, "deepseek-v4-flash", "packyapi").input === 0.5 && internals.resolveRates(config, "deepseek-v4-flash", "packyapi").output === 2);
check("packyapi v4-flash-vision-exp 8折 exact", internals.resolveRates(config, "deepseek-v4-flash-vision-exp", "packyapi").input === 0.8 && internals.rateSource(config, "deepseek-v4-flash-vision-exp", "packyapi") === "provider");
check("packyapi v4-pro 5折", internals.resolveRates(config, "deepseek-v4-pro", "packyapi").input === 2.25 && internals.resolveRates(config, "deepseek-v4-pro", "packyapi").cacheRead === 0.075);
check("official v4-pro full price", internals.resolveRates(config, "deepseek-v4-pro", "deepseek-official").input === 4.5);
check("official provider has its own rate", internals.rateSource(config, "deepseek-flash", "deepseek-official") === "provider" && internals.resolveRates(config, "deepseek-flash", "deepseek-official").input === 1);
check("unknown provider -> fallback (CNY)", internals.rateSource(config, "deepseek-flash", "some-gateway") === "fallback" && internals.resolveRates(config, "some-model", "some-gateway").currency === "CNY");
check("model-only key matches any provider", internals.rateSource(modelOnlyConfig, "deepseek-v4-flash-exp", "packyapi") === "substring" && internals.rateSource(modelOnlyConfig, "deepseek-v4-pro", "some-gateway") === "model");
const providerLedger = internals.syncLedger(
  internals.syncLedger(internals.emptyLedger(), { uncachedInputTokens: 0 }, "packyapi", "deepseek-flash", 0),
  { uncachedInputTokens: 1000000 }, "packyapi", "deepseek-flash", monday1200Utc.getTime()
);
const providerRated = internals.rateLedger(providerLedger, { uncachedInputTokens: 1000000 }, { next: { provider: "packyapi", model: "deepseek-flash" } }, config, monday1200Utc.getTime());
check("packyapi flash billed at 0.8 off-peak", Math.abs(providerRated.amount - 0.8) < 1e-9 && providerRated.source === "provider");
const officialLedger = internals.syncLedger(
  internals.syncLedger(internals.emptyLedger(), { uncachedInputTokens: 0 }, "deepseek-official", "deepseek-flash", 0),
  { uncachedInputTokens: 1000000 }, "deepseek-official", "deepseek-flash", monday1200Utc.getTime()
);
const officialRated = internals.rateLedger(officialLedger, { uncachedInputTokens: 1000000 }, { next: { provider: "deepseek-official", model: "deepseek-flash" } }, config, monday1200Utc.getTime());
check("official flash idle ¥1.00", Math.abs(officialRated.amount - 1) < 1e-9 && officialRated.source === "provider");
const mixedLedger = internals.syncLedger(providerLedger, { uncachedInputTokens: 2000000 }, "deepseek-official", "deepseek-flash", monday1200Utc.getTime());
const mixedRated = internals.rateLedger(mixedLedger, { uncachedInputTokens: 2000000 }, { next: { provider: "deepseek-official", model: "deepseek-flash" } }, config, monday1200Utc.getTime());
check("ledger keeps per-entry provider (0.8 + 1)", Math.abs(mixedRated.amount - 1.8) < 1e-9);

/* ── 1g. 按 provider/model 拆分 ─────────────────────────────────────── */

const modelRows = internals.sessionModelRows(mixedLedger, { uncachedInputTokens: 2000000 }, { next: { provider: "deepseek-official", model: "deepseek-flash" } }, config, monday1200Utc.getTime());
check(
  "sessionModelRows splits by provider/model",
  modelRows.length === 2 &&
    modelRows[0].label === "deepseek-official / deepseek-flash" &&
    Math.abs(modelRows[0].amount - 1) < 1e-9 &&
    modelRows[1].label === "packyapi / deepseek-flash" &&
    Math.abs(modelRows[1].amount - 0.8) < 1e-9 &&
    modelRows[1].tokens === 1000000
);
check("sessionModelRows sorts by amount", modelRows[0].amount > modelRows[1].amount);
check("sessionModelRows covers the total", Math.abs(modelRows.reduce((sum, row) => sum + row.amount, 0) - mixedRated.amount) < 1e-9);
const bracketRows = internals.splitByPeak(splitLedger, { uncachedInputTokens: 2000000 }, { next: { model: "deepseek-flash" } }, ledgerConfig, monday0900Utc.getTime());
check(
  "splitByPeak separates peak from off-peak",
  bracketRows.length === 2 &&
    bracketRows[0].key === "peak" &&
    Math.abs(bracketRows[0].amount - 2) < 1e-9 &&
    bracketRows[0].tokens === 1000000 &&
    bracketRows[1].key === "off" &&
    Math.abs(bracketRows[1].amount - 1) < 1e-9
);
check("splitByPeak covers the total", Math.abs(bracketRows.reduce((sum, row) => sum + row.amount, 0) - splitRated.amount) < 1e-9);
check("splitByPeak falls back to flat", internals.splitByPeak(null, { uncachedInputTokens: 1000000 }, { next: { model: "deepseek-flash" } }, internals.mergeConfig(config, { models: { "deepseek-flash": { input: 1 } } }), monday1200Utc.getTime())[0].key === "flat");
check("normalizePeakFlag keeps legacy booleans", internals.normalizePeakFlag(1) === "p" && internals.normalizePeakFlag(0) === "o" && internals.normalizePeakFlag("f") === "f" && internals.normalizePeakFlag(undefined) === "o");
check("sharePercent bounds", internals.sharePercent(0, 10) === 0 && internals.sharePercent(1, 100) === 2 && internals.sharePercent(10, 10) === 100);
check("formatModelLabel plain model", internals.formatModelLabel(null, "m") === "m" && internals.formatModelLabel("p", "m") === "p / m");

/* ── 1h. 每日统计 ──────────────────────────────────────────────────── */

const day1 = new Date("2025-01-06T04:00:00Z").getTime();
const day2 = new Date("2025-01-07T04:00:00Z").getTime();
check("localDayKey / formatDayKey", internals.localDayKey(day1) === "2025-01-06" && internals.formatDayKey("2025-01-06") === "01-06");

let dayLedger = internals.syncLedger(internals.emptyLedger(), { uncachedInputTokens: 0 }, null, null, day1);
dayLedger = internals.syncLedger(dayLedger, { uncachedInputTokens: 1000000 }, null, null, day1);
dayLedger = internals.syncLedger(dayLedger, { uncachedInputTokens: 3000000 }, null, null, day2);
const dayRows = internals.sessionDayRows(dayLedger, ledgerConfig);
check(
  "sessionDayRows buckets by day",
  dayRows.length === 2 &&
    dayRows.some((row) => row.d === "2025-01-06" && row.b.uncachedInputTokens === 1000000) &&
    dayRows.some((row) => row.d === "2025-01-07" && row.b.uncachedInputTokens === 2000000)
);

const dayStoreA = internals.mergeSessionDayRows(internals.emptyDaily(), "s1", dayRows, day2);
check("merge stores per-session rows", dayStoreA.days["2025-01-06"].length === 1 && dayStoreA.days["2025-01-06"][0].s === "s1");
const dayStoreB = internals.mergeSessionDayRows(dayStoreA, "s2", dayRows, day2);
check("merge keeps other sessions", dayStoreB.days["2025-01-06"].length === 2);
const dayStoreC = internals.mergeSessionDayRows(dayStoreB, "s1", dayRows, day2);
check("re-merge is idempotent", dayStoreC.days["2025-01-06"].length === 2 && dayStoreC.days["2025-01-07"].length === 2);
const dayStatRows = internals.dailyStats(dayStoreC, ledgerConfig);
check("dailyStats sums sessions, newest first", dayStatRows.length === 2 && dayStatRows[0].day === "2025-01-07" && Math.abs(dayStatRows[0].amount - 4) < 1e-9 && dayStatRows[0].tokens === 4000000);
check("dailyStats older day", Math.abs(dayStatRows[1].amount - 2) < 1e-9 && dayStatRows[1].tokens === 2000000);
check("daily prune drops old days", Object.keys(internals.mergeSessionDayRows(dayStoreC, "s9", [], new Date("2025-06-01T00:00:00Z").getTime()).days).length === 0);
check("normalizeDaily drops junk", Object.keys(internals.normalizeDaily({ days: { bad: [], "2025-01-06": [{ b: { uncachedInputTokens: 5 } }] } }).days).length === 1);
check(
  "dailyStats carries per-model rows",
  dayStatRows[0].models.length === 1 && dayStatRows[0].models[0].label === null && Math.abs(dayStatRows[0].models[0].amount - dayStatRows[0].amount) < 1e-9
);
const peakDayStore = internals.mergeSessionDayRows(
  internals.emptyDaily(),
  "s1",
  [
    { d: "2025-01-06", p: null, m: "deepseek-flash", k: "p", b: { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } },
    { d: "2025-01-06", p: null, m: "deepseek-flash", k: "o", b: { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } },
    { d: "2025-01-06", p: null, m: "deepseek-flash", k: "f", b: { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }
  ],
  day2
);
const peakDayStats = internals.dailyStats(peakDayStore, ledgerConfig);
check(
  "dailyStats groups one day by bracket",
  Math.abs(peakDayStats[0].groups.p.amount - 2) < 1e-9 &&
    Math.abs(peakDayStats[0].groups.o.amount - 1) < 1e-9 &&
    Math.abs(peakDayStats[0].groups.f.amount - 1) < 1e-9 &&
    peakDayStats[0].groups.p.tokens === 1000000 &&
    Math.abs(peakDayStats[0].amount - peakDayStats[0].groups.p.amount - peakDayStats[0].groups.o.amount - peakDayStats[0].groups.f.amount) < 1e-9
);

const multiDayStore = internals.mergeSessionDayRows(
  internals.emptyDaily(),
  "s1",
  [
    { d: "2025-01-06", p: "packyapi", m: "deepseek-v4-pro", k: 0, b: { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } },
    { d: "2025-01-06", p: "deepseek-official", m: "deepseek-flash", k: 0, b: { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }
  ],
  day2
);
const sparkSeries = internals.dailySeries(dayStatRows, internals.SPARK_DAYS, day2);
check("dailySeries pads to 30 days", sparkSeries.length === 30 && sparkSeries[0].day === "2024-12-09" && sparkSeries[29].day === "2025-01-07");
check(
  "dailySeries zero-fills gaps",
  Math.abs(sparkSeries[29].amount - 4) < 1e-9 && Math.abs(sparkSeries[28].amount - 2) < 1e-9 && sparkSeries[27].amount === 0 && sparkSeries[0].amount === 0
);
const sparkGeom = internals.sparklinePoints(sparkSeries, 100, 30, 2);
check("sparkline spans the viewbox", sparkGeom.points.length === 30 && sparkGeom.points[0].x === 2 && sparkGeom.points[29].x === 98);
check(
  "sparkline y maps max to top, zero to bottom",
  Math.abs(sparkGeom.max - 4) < 1e-9 && Math.abs(sparkGeom.points[29].y - 2) < 1e-9 && Math.abs(sparkGeom.points[27].y - 28) < 1e-9
);
check(
  "sparkline paths are well formed",
  internals.sparklineLine(sparkGeom.points).indexOf("M2 28") === 0 && internals.sparklineArea(sparkGeom.points, 30, 2).slice(-1) === "Z"
);
const flatSpark = internals.sparklinePoints(internals.dailySeries([], 5, day2), 100, 30, 2);
check("sparkline handles an empty range", flatSpark.max === 0 && flatSpark.points.every((point) => point.y === 28));

const multiDayStats = internals.dailyStats(multiDayStore, config);
check(
  "dailyStats splits one day by model",
  multiDayStats[0].models.length === 2 &&
    multiDayStats[0].models[0].label === "packyapi / deepseek-v4-pro" &&
    Math.abs(multiDayStats[0].models[0].amount - 2.25) < 1e-9 &&
    Math.abs(multiDayStats[0].amount - 3.25) < 1e-9
);

/* ── 2. 模块外壳与注册 ──────────────────────────────────────────────── */

console.log("bundle + registration");
const DAILY_SEED = {
  v: 1,
  days: {
    "2025-01-06": [{ s: "s0", p: "deepseek-official", m: "deepseek-flash", k: 0, b: { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }],
    "2025-01-05": [{ s: "s0", p: "deepseek-official", m: "deepseek-flash", k: 0, b: { uncachedInputTokens: 2000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }]
  }
};
const registration = loadBundle(react, undefined, (sandbox) => {
  sandbox.window.localStorage.getItem = (key) => (key === "dsh.token-purse.daily.v1" ? JSON.stringify(DAILY_SEED) : null);
});
check("bundle id", registration.id === "@dsh-plugins/token-purse");
const bundleExports = registration.factory((specifier) => {
  if (specifier === "react") return react;
  if (specifier === "react-dom") return fakeReactDom;
  throw new Error("unexpected require: " + specifier);
});
check("exports.apply is a function", typeof bundleExports.apply === "function");
check("exports.inject includes slots", Array.isArray(bundleExports.inject) && bundleExports.inject.includes("slots"));

const captured = {};
const ctx = {
  effect: (fn) => {
    fn();
    return () => {};
  },
  locale: {
    register: (ns, dicts) => {
      captured.ns = ns;
      captured.dicts = dicts;
      return () => {};
    }
  },
  slots: {
    inject: (name, callback) => callback(),
    register: (spec, component) => {
      captured.spec = spec;
      captured.component = component;
      return () => {};
    }
  }
};
bundleExports.apply(ctx);

check("locale namespace", captured.ns === "token-purse");
check("locale zh + en", captured.dicts.zh["panel.title"] === "Token 花费" && captured.dicts.en["panel.title"] === "Token spend");
check(
  "slot spec targets composer stats dock",
  captured.spec.name === "conversation.composer.dock" && captured.spec.id === "token-purse" && captured.spec.order === 100
);

/* ── 3. 组件渲染 ────────────────────────────────────────────────────── */

console.log("component render");
const t = (key, params) => key + (params ? "|" + JSON.stringify(params) : "");
react.reset();
const empty = internals.TokenPurseView({ usage: undefined, selection: undefined, t });
check("no usage -> null", empty === null);

react.reset();
react.seed({ 1: true }); // open the popover panel
const tree = internals.TokenPurseView({ usage, selection, t });
const serialized = JSON.stringify(tree);
check("badge renders amount", serialized.indexOf("≈") !== -1 && serialized.indexOf("¥3.02") !== -1);
check("panel carries model label", serialized.indexOf("deepseek-official / deepseek-flash") !== -1);
check("trigger has aria label", serialized.indexOf("trigger.aria") !== -1);
check("badge shows current off-peak mode", serialized.indexOf("peak.badgeLow") !== -1 && serialized.indexOf("modeChipOn") === -1);
check("panel labels current pricing", serialized.indexOf("peak.current") !== -1);
const LEDGER_SEED = {
  observed: true,
  seen: { uncachedInputTokens: 1000000, cacheReadTokens: 1000000, cacheWriteTokens: 0, outputTokens: 500000 },
  base: null,
  entries: [
    { at: monday1200Utc.getTime(), provider: "packyapi", model: "deepseek-v4-pro", b: { uncachedInputTokens: 400000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } },
    { at: monday1200Utc.getTime(), provider: "deepseek-official", model: "deepseek-flash", b: { uncachedInputTokens: 600000, cacheReadTokens: 1000000, cacheWriteTokens: 0, outputTokens: 500000 } }
  ]
};
const modelInternals = loadInternals(react, undefined, (sandbox) => {
  sandbox.window.localStorage.getItem = (key) => (key === "dsh.token-purse.ledger.v1:default" ? JSON.stringify(LEDGER_SEED) : null);
});
react.reset();
react.seed({ 1: true, 2: "model" });
const modelSerialized = JSON.stringify(modelInternals.TokenPurseView({ usage, selection, t }));
check("panel renders by-model breakdown", modelSerialized.indexOf("packyapi / deepseek-v4-pro") !== -1 && modelSerialized.indexOf("TPurse_breakLabel") !== -1);
check("by-model rows carry a share bar", modelSerialized.indexOf("TPurse_shareFill") !== -1 && modelSerialized.indexOf("TPurse_breakAmount") !== -1);
check("panel renders three tabs", (modelSerialized.match(/"role":"tab"/g) || []).length === 3 && modelSerialized.indexOf("TPurse_tabOn") !== -1);
check(
  "settings stay behind the editor",
  modelSerialized.indexOf("TPurse_select") === -1 && modelSerialized.indexOf("TPurse_fxRow") === -1 && modelSerialized.indexOf("TPurse_editButton") !== -1
);

react.reset();
react.seed({ 1: true, 2: "model", 4: true });
const editingSerialized = JSON.stringify(modelInternals.TokenPurseView({ usage, selection, t }));
check(
  "editor holds the currency settings",
  editingSerialized.indexOf("TPurse_select") !== -1 && editingSerialized.indexOf("TPurse_fxRow") !== -1 && editingSerialized.indexOf("TPurse_textarea") !== -1
);

check(
  "model tab hides the other breakdowns",
  modelSerialized.indexOf("TPurse_sparkWrap") === -1 && modelSerialized.indexOf("peak.group.low") === -1 && (modelSerialized.match(/TPurse_sectionFlat/g) || []).length === 1
);

react.reset();
react.seed({ 1: true, 2: "peak" });
const peakTabSerialized = JSON.stringify(modelInternals.TokenPurseView({ usage, selection, t }));
check(
  "peak tab renders the peak / off-peak split",
  peakTabSerialized.indexOf("peak.group.low") !== -1 && peakTabSerialized.indexOf("peak.group.high") === -1 && peakTabSerialized.indexOf("TPurse_sparkWrap") === -1
);
check("peak tab keeps the total", peakTabSerialized.indexOf("¥3.52") !== -1 && peakTabSerialized.indexOf("packyapi / deepseek-v4-pro") === -1);

const legacyCurrencyInternals = loadInternals(react, undefined, (sandbox) => {
  sandbox.window.localStorage.getItem = (key) => (key === "dsh.token-purse.config.v2" ? JSON.stringify({ currency: { symbol: "$", perUsd: 1, auto: false }, models: {} }) : null);
});
react.reset();
react.seed({ 1: true });
const legacyCurrencySerialized = JSON.stringify(legacyCurrencyInternals.TokenPurseView({ usage, selection, t }));
check("legacy USD config renders as CNY", legacyCurrencySerialized.indexOf("¥3.02") !== -1 && legacyCurrencySerialized.indexOf("$3.02") === -1);
check("readConfig migrates 0.1.0 USD to CNY", legacyCurrencyInternals.readConfig().currency.code === "CNY" && legacyCurrencyInternals.readConfig().currency.symbol === "¥");

const dailyInternals = loadInternals(react, undefined, (sandbox) => {
  sandbox.window.localStorage.getItem = (key) => (key === "dsh.token-purse.daily.v1" ? JSON.stringify(DAILY_SEED) : null);
});
react.reset();
react.seed({ 1: true, 2: "daily" });
const dailySerialized = JSON.stringify(dailyInternals.TokenPurseView({ usage, selection, t }));
check("panel renders daily rows", dailySerialized.indexOf("01-06") !== -1 && dailySerialized.indexOf("01-05") !== -1 && dailySerialized.indexOf("TPurse_sparkWrap") !== -1);
check("daily rows show amount + tokens", dailySerialized.indexOf("¥1.00") !== -1 && dailySerialized.indexOf("¥2.00") !== -1 && dailySerialized.indexOf("2M") !== -1);
check("panel renders the 30-day sparkline", dailySerialized.indexOf("spark.summary") !== -1 && dailySerialized.indexOf("TPurse_sparkLine") !== -1 && dailySerialized.indexOf("spark.aria") !== -1);
check("sparkline path is drawn", /"d":"M[0-9.]+ [0-9.]+ L/.test(dailySerialized) && dailySerialized.indexOf("TPurse_sparkArea") !== -1);
check("day detail stays collapsed by default", dailySerialized.indexOf("TPurse_breakSub") === -1 && dailySerialized.indexOf("peak.group.high") === -1);

/* 有高峰用量的那天才可展开，展开后给出峰/谷明细。 */
const PEAK_DAILY_SEED = {
  v: 1,
  days: {
    "2025-01-06": [
      { s: "s0", p: "deepseek-official", m: "deepseek-flash", k: "p", b: { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } },
      { s: "s0", p: "deepseek-official", m: "deepseek-flash", k: "o", b: { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }
    ]
  }
};
const peakDayInternals = loadInternals(react, undefined, (sandbox) => {
  sandbox.window.localStorage.getItem = (key) => (key === "dsh.token-purse.daily.v1" ? JSON.stringify(PEAK_DAILY_SEED) : null);
});
react.reset();
react.seed({ 1: true, 2: "daily", 3: "2025-01-06" });
const expandedSerialized = JSON.stringify(peakDayInternals.TokenPurseView({ usage: { uncachedInputTokens: 2000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, selection, t }));
check(
  "expanded day shows the peak / off-peak line",
  expandedSerialized.indexOf("TPurse_breakSub") !== -1 &&
    expandedSerialized.indexOf("peak.group.high") !== -1 &&
    expandedSerialized.indexOf("¥2.00") !== -1 &&
    expandedSerialized.indexOf("¥1.00") !== -1
);

react.reset();
react.seed({ 1: true });
const peakInternals = loadInternals(react, monday0900Utc.getTime());
const peakSerialized = JSON.stringify(peakInternals.TokenPurseView({ usage, selection, t }));
check("badge shows current peak mode", peakSerialized.indexOf("peak.badgeHigh") !== -1 && peakSerialized.indexOf("modeChipOn") !== -1);
check("peak render still shows amount", peakSerialized.indexOf("¥6.04") !== -1);

react.reset();
const hostless = captured.component({ useProjection: () => undefined, t });
check("host renders hidden anchor without DOM", JSON.stringify(hostless).indexOf("TPurse_host") !== -1);

if (failures > 0) {
  console.error("\n" + failures + " check(s) failed");
  process.exit(1);
}
console.log("\nall checks passed");