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
    "\nexports.__test = { rateUsage, rateLedger, resolveRates, mergeConfig, formatMoney, formatTokens, formatRate, DEFAULT_CONFIG, TokenPurseView, matchCurrencyPreset, findCurrencyPreset, fetchUsdRate, parsePeakWindow, parsePeak, isPeakAt, ratesAt, emptyLedger, syncLedger, migrateConfigV1, rateSource, CURRENCY_PRESETS, localDayKey, sessionModelRows, formatModelLabel, sharePercent, legacyCurrencyConfig, migrateLegacyCurrency, readConfig, dailySeries, sparklinePoints, sparklineLine, sparklineArea, SPARK_DAYS, aggregateDaily, sessionTone, SESSION_TONES, splitByPeak, ledgerSegments, priceSegment, normalizePeakFlag, sessionDayRows, mergeSessionDayRows, dailyStats, normalizeDaily, emptyDaily, formatDayKey };\n";
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
const aggAll = internals.aggregateDaily(dayStatRows);
check(
  "aggregateDaily sums the whole store",
  aggAll.days === 2 && aggAll.sessions === 2 && aggAll.tokens === 6000000 && Math.abs(aggAll.amount - 6) < 1e-9
);
check(
  "aggregateDaily keeps buckets, models and brackets in sync with the total",
  Math.abs(aggAll.rows.reduce((sum, row) => sum + row.amount, 0) - aggAll.amount) < 1e-9 &&
    aggAll.rows.reduce((sum, row) => sum + row.tokens, 0) === aggAll.tokens &&
    aggAll.models.length === 1 &&
    Math.abs(aggAll.models[0].amount - aggAll.amount) < 1e-9 &&
    Math.abs(aggAll.peakRows.reduce((sum, row) => sum + row.amount, 0) - aggAll.amount) < 1e-9 &&
    aggAll.peakRows.length === 1 &&
    /* 该 fixture 的账本行没记模型，回退兜底费率（peakMultiplier 1）所以算平价。 */
    aggAll.peakRows[0].key === "flat"
);
const aggEmpty = internals.aggregateDaily([]);
check("aggregateDaily handles an empty store", aggEmpty.days === 0 && aggEmpty.sessions === 0 && aggEmpty.rows.length === 0 && aggEmpty.amount === 0);

/* ── 项目维度 ─────────────────────────────────────────────────────── */

check(
  "sessionDayRows carries the project",
  internals.sessionDayRows(dayLedger, ledgerConfig, "/w/alpha").every((row) => row.w === "/w/alpha") &&
    internals.sessionDayRows(dayLedger, ledgerConfig).every((row) => row.w === "")
);
const projectStore = internals.mergeSessionDayRows(internals.emptyDaily(), "s1", internals.sessionDayRows(dayLedger, ledgerConfig, "/w/alpha"), day2);
check("mergeSessionDayRows keeps the project", projectStore.days["2025-01-06"][0].w === "/w/alpha");
check(
  "normalizeDaily round-trips the project",
  internals.normalizeDaily(JSON.parse(JSON.stringify(projectStore))).days["2025-01-06"][0].w === "/w/alpha"
);
const legacyStore = internals.normalizeDaily({ days: { "2025-01-06": [{ s: "s1", b: { uncachedInputTokens: 5 } }] } });
check("rows without a project normalise to null", legacyStore.days["2025-01-06"][0].w === null);

const bucketOf = (n) => ({ uncachedInputTokens: n, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
const projStore = {
  v: 1,
  days: {
    "2025-01-06": [
      { s: "sA", w: "/w/alpha", p: "packyapi", m: "deepseek-flash", k: "o", b: bucketOf(3000000) },
      { s: "sB", w: "/w/alpha", p: "packyapi", m: "deepseek-flash", k: "o", b: bucketOf(1000000) },
      { s: "sC", w: "/w/beta", p: "packyapi", m: "deepseek-flash", k: "o", b: bucketOf(2000000) }
    ],
    "2025-01-05": [{ s: "sC", w: "/w/beta", p: "packyapi", m: "deepseek-flash", k: "o", b: bucketOf(1000000) }]
  }
};
const projAgg = internals.aggregateDaily(internals.dailyStats(projStore, ledgerConfig));
check(
  "aggregateDaily groups by project, biggest first",
  projAgg.projects.length === 2 &&
    projAgg.projects[0].key === "/w/alpha" &&
    Math.abs(projAgg.projects[0].amount - 3.2) < 1e-9 &&
    projAgg.projects[1].key === "/w/beta"
);
check(
  "each project carries its own sessions",
  projAgg.projects[0].sessions.length === 2 &&
    projAgg.projects[0].sessions.map((session) => session.key).join(",") === "sA,sB" &&
    projAgg.projects[1].sessions.length === 1 &&
    projAgg.projects[1].sessions[0].tokens === 3000000
);
check(
  "project totals add up to the whole",
  Math.abs(projAgg.projects.reduce((sum, item) => sum + item.amount, 0) - projAgg.amount) < 1e-9 &&
    projAgg.projects.reduce((sum, item) => sum + item.sessions.length, 0) === 3
);

/* ── 每日展开：按会话的色块 ─────────────────────────────────────────── */

check(
  "sessionTone cycles a palette of distinct real theme tokens",
  internals.SESSION_TONES.length >= 4 &&
    new Set(internals.SESSION_TONES).size === internals.SESSION_TONES.length &&
    internals.SESSION_TONES.every((tone) => tone.indexOf("--dsw-static-") === 0) &&
    internals.sessionTone(0) === internals.SESSION_TONES[0] &&
    internals.sessionTone(internals.SESSION_TONES.length) === internals.SESSION_TONES[0] &&
    new Set(internals.SESSION_TONES.map((tone, at) => internals.sessionTone(at))).size === internals.SESSION_TONES.length
);

const dayStore = {
  v: 1,
  days: {
    "2025-01-06": [
      { s: "sA", w: "/w/alpha", p: "packyapi", m: "deepseek-flash", k: "o", b: bucketOf(3000000) },
      { s: "sB", w: "/w/alpha", p: "packyapi", m: "deepseek-v4-pro", k: "p", b: bucketOf(1000000) },
      { s: "sC", w: "/w/beta", p: "deepseek-official", m: "deepseek-flash", k: "o", b: bucketOf(2000000) }
    ]
  }
};
const dayStats = internals.dailyStats(dayStore, ledgerConfig);
check(
  "a day lists its sessions flat, biggest first, with their project",
  dayStats[0].sessions.length === 3 &&
    dayStats[0].sessions.map((item) => item.key).join(",") === "sB,sA,sC" &&
    dayStats[0].sessions.map((item) => item.project).join(",") === "/w/alpha,/w/alpha,/w/beta" &&
    dayStats[0].sessions.reduce((sum, item) => sum + item.amount, 0) === dayStats[0].amount
);

const flatStore = {
  v: 1,
  days: { "2025-01-06": [{ s: "sA", w: "/w/alpha", p: "packyapi", m: "deepseek-flash", k: "o", b: bucketOf(1000000) }] }
};

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

const aggPeak = internals.aggregateDaily(internals.dailyStats(peakDayStore, ledgerConfig));
check(
  "aggregateDaily merges brackets",
  aggPeak.peakRows.length === 3 &&
    aggPeak.peakRows[0].key === "peak" &&
    aggPeak.peakRows[1].key === "off" &&
    Math.abs(aggPeak.peakRows.reduce((sum, row) => sum + row.amount, 0) - aggPeak.amount) < 1e-9 &&
    Math.abs(aggPeak.amount - 4) < 1e-9
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
const cssSource = readFileSync(join(root, "src", "client.js"), "utf8");
check(
  "css ships entrance / reveal keyframes",
  ["@keyframes tp-panel-in", "@keyframes tp-panel-out", "@keyframes tp-rise", "@keyframes tp-draw", "@keyframes tp-grow", "@keyframes tp-fade"].every(
    (name) => cssSource.indexOf(name) !== -1
  )
);
check("animations respect reduced motion", cssSource.indexOf("prefers-reduced-motion:reduce") !== -1);
/* 评审里点出过：媒体查询只关了 animation，7 个 transition 还在（其中 chevron 180° 是真动画）。 */
const reducedMotion = cssSource.slice(cssSource.indexOf("prefers-reduced-motion:reduce"));
check(
  "reduced motion also kills transitions (chevron rotate)",
  reducedMotion.indexOf("transition:none!important") !== -1 && reducedMotion.indexOf(".TPurse_trigger *") !== -1
);
/* 没有纵向上限时，底部锚定的面板会一直向上长，标题与首行会跑到屏幕外不可达。 */
check(
  "panel caps its height and scrolls instead of growing without bound",
  cssSource.indexOf("max-height:min(72vh,600px)") !== -1 &&
    cssSource.indexOf("overflow-y:auto") !== -1 &&
    cssSource.indexOf("overscroll-behavior:contain") !== -1 &&
    cssSource.indexOf(".TPurse_head{display:flex;align-items:baseline;gap:8px;position:sticky") !== -1
);

/* ── 3a. 主题 token 护栏 ─────────────────────────────────────────────── */
/*
 * 面板只允许引用主题包里真实存在的 token。此前 --dsw-alias-fill-l2 / --dsw-font-mono /
 * --dsw-static-yellow-500 三个 token 并不存在：在 background 位置失效只是变透明，但在
 * fill 位置（fill 可继承）会退化成黑色，把折线面积画成一块黑楔形。
 */
const themeSnapshot = JSON.parse(readFileSync(join(root, "scripts", "theme-tokens.json"), "utf8"));
const themeTokens = new Set(themeSnapshot.tokens);
const referencedTokens = new Set();
for (const match of cssSource.matchAll(/(?:var\(|")(--dsw-[a-z0-9-]+)/g)) referencedTokens.add(match[1]);
const missingTokens = Array.from(referencedTokens).filter((name) => !themeTokens.has(name));
check(
  "every theme token the panel references exists (" + referencedTokens.size + " checked against " + themeTokens.size + ")",
  referencedTokens.size > 15 && missingTokens.length === 0
);
if (missingTokens.length > 0) console.error("       unknown: " + missingTokens.join(", "));

/* 对比度：正文只允许用实测达标的组合（WCAG 2.1 AA，普通文字 4.5:1）。 */
const relativeLuminance = (hex) => {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrastRatio = (one, two) => {
  const a = relativeLuminance(one);
  const b = relativeLuminance(two);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const alphaOf = (hex) => (hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1);
/* 主题里有半透明底（如 interactive-bg-hover 是 6% 黑），必须先压到面板底色上再算。 */
const flatten = (color, base) => {
  const alpha = alphaOf(color);
  if (alpha >= 1) return color;
  const mixed = [1, 3, 5].map((at) => {
    const top = parseInt(color.slice(at, at + 2), 16);
    const bottom = parseInt(base.slice(at, at + 2), 16);
    return Math.round(top * alpha + bottom * (1 - alpha));
  });
  return "#" + mixed.map((value) => value.toString(16).padStart(2, "0")).join("");
};
const TEXT_PAIRS = [
  ["--dsw-alias-label-primary", "--dsw-specific-menu", "总额 / 金额"],
  ["--dsw-alias-label-secondary", "--dsw-specific-menu", "标签 / 说明"],
  ["--dsw-alias-label-secondary", "--dsw-alias-interactive-bg-hover", "输入框内文字"],
  ["--dsw-alias-label-primary", "--dsw-alias-button-ghost-active-fill", "选中页签"],
  ["--dsw-static-amber-900", "--dsw-static-amber-400", "峰谷 chip"]
];
for (const [foreground, background, label] of TEXT_PAIRS) {
  for (const mode of ["light", "dark"]) {
    const front = themeSnapshot.values[foreground] && themeSnapshot.values[foreground][mode];
    const back = themeSnapshot.values[background] && themeSnapshot.values[background][mode];
    const surface = themeSnapshot.values["--dsw-specific-menu"][mode];
    const ratio = front && back ? contrastRatio(front, flatten(back, surface)) : 0;
    check(
      "AA contrast " + mode + " · " + label + " " + ratio.toFixed(2) + ":1",
      ratio >= 4.5
    );
  }
}
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
check("panel and tab body carry animation classes", modelSerialized.indexOf("TPurse_panel") !== -1 && modelSerialized.indexOf("TPurse_tabBody") !== -1);

/* 关闭时保留 panelOut 一帧，播完退场动画再卸载。 */
react.reset();
react.seed({ 1: false, 12: true });
const closingSerialized = JSON.stringify(modelInternals.TokenPurseView({ usage, selection, t }));
check("panel stays mounted while closing", closingSerialized.indexOf("TPurse_panelOut") !== -1 && closingSerialized.indexOf("panel.title") !== -1);
react.reset();
react.seed({ 1: false, 12: false });
const noPanelSerialized = JSON.stringify(modelInternals.TokenPurseView({ usage, selection, t }));
check("closed panel renders nothing", noPanelSerialized.indexOf("TPurse_panel") === -1 && noPanelSerialized.indexOf("panel.title") === -1);
check(
  "panel renders the scope (radiogroup) and view (tablist) switches",
  (modelSerialized.match(/"role":"radio"/g) || []).length === 2 &&
    (modelSerialized.match(/"role":"tab"/g) || []).length === 3 &&
    modelSerialized.indexOf("TPurse_tabOn") !== -1
);
/* 评审：第二条 tablist 没 label、没有 aria-controls、没有 tabpanel、没有 roving tabindex。 */
check(
  "tab pattern is complete (label, controls, tabpanel, roving tabindex)",
  modelSerialized.indexOf('"role":"tablist"') !== -1 &&
    modelSerialized.indexOf('"role":"tabpanel"') !== -1 &&
    modelSerialized.indexOf('"aria-labelledby"') !== -1 &&
    modelSerialized.indexOf('"aria-controls"') !== -1 &&
    modelSerialized.indexOf('"tabIndex":-1') !== -1 &&
    modelSerialized.indexOf("tab.label") !== -1
);
check(
  "scope control exposes mode semantics and is keyboard driven",
  modelSerialized.indexOf('"role":"radiogroup"') !== -1 &&
    modelSerialized.indexOf('"aria-checked":true') !== -1 &&
    cssSource.indexOf("ArrowRight") !== -1
);
check(
  "currency select is named by its visible label",
  modelSerialized.indexOf('"aria-labelledby"') !== -1 && cssSource.indexOf("min-height:24px") !== -1
);
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
check("sparkline carries a normalized path length", dailySerialized.indexOf('"pathLength":"1"') !== -1 && dailySerialized.indexOf("non-scaling-stroke") !== -1);

/* 累计口径：同一份每日库并起来，顶部合计与三个分解都跟着换。 */
react.reset();
react.seed({ 1: true, 2: "model", 13: "all" });
const allTimeSerialized = JSON.stringify(dailyInternals.TokenPurseView({ usage, selection, t }));
check(
  "all-time scope shows the accumulated total",
  allTimeSerialized.indexOf("≈¥3.00") !== -1 && allTimeSerialized.indexOf("scope.all") !== -1 && /scope.summary|/.test(allTimeSerialized)
);
check("all-time scope drops the session-only source chip", allTimeSerialized.indexOf("rate.source.") === -1);
check("session scope still shows the session total", dailySerialized.indexOf("≈¥3.02") !== -1 && dailySerialized.indexOf("rate.source.") !== -1);

/* 折线悬浮读数。 */
check(
  "sparkline has one hover cell per day and no tooltip when idle",
  (dailySerialized.match(/TPurse_sparkCell/g) || []).length === internals.SPARK_DAYS &&
    dailySerialized.indexOf("TPurse_sparkTip") === -1 &&
    dailySerialized.indexOf("TPurse_sparkGuide") === -1
);
react.reset();
react.seed({ 1: true, 2: "daily", 14: internals.SPARK_DAYS - 1 });
const hoverSerialized = JSON.stringify(dailyInternals.TokenPurseView({ usage, selection, t }));
const hoverTip = hoverSerialized.match(/spark\.tip\|.*?\\"day\\":\\"(\d\d-\d\d)\\",\\"amount\\":\\"([^\\"]+)\\"/);
check(
  "sparkline hover renders guide, dot and a day/amount tooltip",
  hoverSerialized.indexOf("TPurse_sparkTip") !== -1 &&
    hoverSerialized.indexOf("TPurse_sparkGuide") !== -1 &&
    hoverSerialized.indexOf("TPurse_sparkDot") !== -1 &&
    hoverTip !== null &&
    hoverTip[1] === "01-06" &&
    hoverTip[2] === "¥1.00"
);
react.reset();
react.seed({ 1: true, 2: "project", 13: "all", 10: projStore, 15: "/w/alpha" });
const projectSerialized = JSON.stringify(
  dailyInternals.TokenPurseView({
    usage,
    selection,
    t,
    sessionId: "sA",
    project: "/w/alpha",
    sessionsById: { sA: { displayTitle: "会话甲" }, sB: { displayTitle: "会话乙" }, sC: { displayTitle: "会话丙" } }
  })
);
check(
  "project tab lists each project and its sessions",
  projectSerialized.indexOf("tab.project") !== -1 &&
    projectSerialized.indexOf("alpha") !== -1 &&
    projectSerialized.indexOf("beta") !== -1 &&
    projectSerialized.indexOf("会话甲") !== -1 &&
    projectSerialized.indexOf("会话乙") !== -1 &&
    projectSerialized.indexOf("会话丙") === -1
);
check("project tab is hidden in session scope", modelSerialized.indexOf("tab.project") === -1);
check(
  "sparkline is keyboard reachable",
  dailySerialized.indexOf('"tabIndex":0') !== -1 && cssSource.indexOf("ArrowLeft") !== -1 && cssSource.indexOf("ArrowRight") !== -1
);
check("day detail stays collapsed by default", dailySerialized.indexOf("TPurse_breakSub") === -1 && dailySerialized.indexOf("peak.group.high") === -1);

/* 点开某一天：按会话分成色块。 */
/* 范围控件必须真的管住「每日」：否则标题是本会话合计、下面是全局日行。 */
const scopedStats = internals.dailyStats(dayStore, ledgerConfig, "sA");
check(
  "a session-scoped daily view counts only that session",
  scopedStats.length === 1 &&
    scopedStats[0].tokens === 3000000 &&
    Math.abs(scopedStats[0].amount - 2.4) < 1e-9 &&
    scopedStats[0].sessions.length === 1
);
check(
  "dailyStats without a filter stays global",
  internals.dailyStats(dayStore, ledgerConfig)[0].sessions.length === 3 &&
    internals.dailyStats(dayStore, ledgerConfig)[0].tokens === 6000000
);

const countOf = (haystack, needle) => haystack.split(needle).length - 1;
react.reset();
react.seed({ 1: true, 2: "daily", 13: "all", 10: dayStore, 3: "2025-01-06" });
const daySerialized = JSON.stringify(
  dailyInternals.TokenPurseView({
    usage,
    selection,
    t,
    sessionId: "sA",
    project: "/w/alpha",
    sessionsById: { sA: { displayTitle: "会话甲" }, sB: { displayTitle: "会话乙" }, sC: { displayTitle: "会话丙" } }
  })
);
check(
  "an expanded day gives each session its own colour block",
  countOf(daySerialized, "TPurse_toneSeg") === 3 &&
    countOf(daySerialized, "TPurse_toneDot") === 3 &&
    daySerialized.indexOf("--dsw-static-blue-500") !== -1 &&
    daySerialized.indexOf("--dsw-static-green-500") !== -1 &&
    daySerialized.indexOf("--dsw-static-amber-500") !== -1 &&
    daySerialized.indexOf("会话乙") !== -1 &&
    daySerialized.indexOf("会话甲") !== -1 &&
    daySerialized.indexOf("会话丙") !== -1 &&
    daySerialized.indexOf("daily.bySession") !== -1 &&
    daySerialized.indexOf("daily.byModel") !== -1
);
react.reset();
react.seed({ 1: true, 2: "daily", 13: "all", 10: flatStore });
const flatSerialized = JSON.stringify(
  dailyInternals.TokenPurseView({ usage, selection, t, sessionId: "sA", project: "/w/alpha", sessionsById: {} })
);
check(
  "a single-session flat day stays collapsed",
  flatSerialized.indexOf("TPurse_dayRow") === -1 && flatSerialized.indexOf("TPurse_toneBar") === -1
);

/* 悬浮色块要能说出「这是哪个会话、占当天多少」。 */
const toneProps = {
  usage,
  selection,
  t,
  sessionId: "sA",
  project: "/w/alpha",
  sessionsById: { sA: { displayTitle: "会话甲" }, sB: { displayTitle: "会话乙" }, sC: { displayTitle: "会话丙" } }
};
react.reset();
react.seed({ 1: true, 2: "daily", 13: "all", 10: dayStore, 3: "2025-01-06", 16: "sB" });
const toneSerialized = JSON.stringify(dailyInternals.TokenPurseView(toneProps));
/* 只取色块热区的宽度：折线的 30 个悬浮格也有 width，不要混进来。 */
const toneWidths = toneSerialized
  .split('"className":"TPurse_toneCell"')
  .slice(1)
  .map((chunk) => Number((chunk.match(/"width":"([0-9.]+)%"/) || [0, "0"])[1]));
check(
  "hovering a colour block names the session and its share of the day",
  countOf(toneSerialized, "TPurse_toneCell") === 3 &&
    countOf(toneSerialized, '"className":"TPurse_toneTip"') === 1 &&
    countOf(toneSerialized, "TPurse_toneTipText") === 1 &&
    /* 气泡改成整行居中 + 换行，不再用 clamp 定 left，所以不会横向顶出面板。 */
    (toneSerialized.split('"className":"TPurse_toneTip"')[1] || "").slice(0, 60).indexOf("left") === -1 &&
    /daily\.toneTip\|.*?\\"share\\":\\"51\\"/.test(toneSerialized) &&
    toneSerialized.indexOf("会话乙") !== -1 &&
    toneWidths.length === 3 &&
    Math.abs(toneWidths.reduce((sum, value) => sum + value, 0) - 100) < 0.01
);
react.reset();
react.seed({ 1: true, 2: "daily", 13: "all", 10: dayStore, 3: "2025-01-06" });
const noToneSerialized = JSON.stringify(dailyInternals.TokenPurseView({ ...toneProps, sessionsById: {} }));
check(
  "the bubble only appears while a block is hovered",
  noToneSerialized.indexOf("TPurse_toneTip") === -1 && countOf(noToneSerialized, "TPurse_toneCell") === 3
);

react.reset();
react.seed({ 1: true, 2: "daily", 13: "session", 10: dayStore, 3: "2025-01-06" });
const scopedSerialized = JSON.stringify(dailyInternals.TokenPurseView(toneProps));
check(
  "the daily tab follows the scope switch",
  scopedSerialized.indexOf('"3M"') !== -1 &&
    scopedSerialized.indexOf('"6M"') === -1 &&
    scopedSerialized.indexOf("daily.hintSession") !== -1
);
react.reset();
react.seed({ 1: true, 2: "daily", 13: "all", 10: dayStore, 3: "2025-01-06" });
const globalSerialized = JSON.stringify(dailyInternals.TokenPurseView(toneProps));
check(
  "all-time scope still shows every session, and says so",
  globalSerialized.indexOf('"6M"') !== -1 && globalSerialized.indexOf("daily.hintSession") === -1
);


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

/* ── 跨会话累积：跑真实 effect 的迷你 React ───────────────────────── */

console.log("cross-session accumulation");

function effectfulReact() {
  const hooks = [];
  let index = 0;
  let pending = [];
  let dirty = false;
  const same = (left, right) => {
    if (left === undefined || right === undefined) return false;
    if (left === null || right === null || left.length !== right.length) return false;
    return left.every((value, at) => Object.is(value, right[at]));
  };
  return {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() };
    },
    useState(init) {
      const at = index++;
      if (!(at in hooks)) hooks[at] = typeof init === "function" ? init() : init;
      return [
        hooks[at],
        (next) => {
          hooks[at] = typeof next === "function" ? next(hooks[at]) : next;
          dirty = true;
        }
      ];
    },
    useRef(init) {
      const at = index++;
      if (!(at in hooks)) hooks[at] = { current: init };
      return hooks[at];
    },
    useMemo(fn, deps) {
      const at = index++;
      const prev = hooks[at];
      if (prev !== undefined && same(prev.deps, deps)) return prev.value;
      const value = fn();
      hooks[at] = { value, deps };
      return value;
    },
    useEffect(fn, deps) {
      const at = index++;
      const prev = hooks[at];
      if (prev !== undefined && same(prev.deps, deps)) {
        pending.push({ skip: true });
        return;
      }
      pending.push({ at, fn, deps, prev });
    },
    begin() {
      index = 0;
      pending = [];
      dirty = false;
    },
    flush() {
      const jobs = pending;
      pending = [];
      for (const job of jobs) {
        if (job.skip) continue;
        if (job.prev !== undefined && typeof job.prev.cleanup === "function") job.prev.cleanup();
        hooks[job.at] = { deps: job.deps, cleanup: job.fn() };
      }
      return dirty;
    }
  };
}

const crossStorage = (() => {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
})();
const crossReact = effectfulReact();
const cross = loadInternals(crossReact, undefined, (sandbox) => {
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  sandbox.window.localStorage = crossStorage;
});
const DAILY_STORE_KEY = "dsh.token-purse.daily.v1";
const mkUsage = (tokens) => ({ uncachedInputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
const crossSelection = { next: { provider: "packyapi", model: "deepseek-flash" } };

/** 用同一个组件实例渲染若干轮，直到状态稳定（模拟真实 effect 收敛）。 */
function renderSession(sessionId, tokens) {
  const usage = mkUsage(tokens);
  for (let round = 0; round < 8; round += 1) {
    crossReact.begin();
    cross.TokenPurseView({ usage, selection: crossSelection, sessionId, t });
    if (!crossReact.flush()) break;
  }
}

function storedDaily() {
  const raw = crossStorage.map.get(DAILY_STORE_KEY);
  return raw === undefined ? { v: 1, days: {} } : JSON.parse(raw);
}

function storedSessionIds() {
  const ids = new Set();
  const store = storedDaily();
  for (const day of Object.keys(store.days)) {
    for (const row of store.days[day]) ids.add(row.s === undefined ? "<none>" : row.s);
  }
  return Array.from(ids).sort();
}

renderSession("sA", 2000000);
check("a session lands in the shared daily store", storedSessionIds().join(",") === "sA");

/* 模拟另一个标签页写入了它的会话——本页内存里的副本是旧的。 */
const otherTab = storedDaily();
const otherDay = Object.keys(otherTab.days)[0];
otherTab.days[otherDay].push({
  s: "sOther",
  p: "packyapi",
  m: "deepseek-flash",
  k: "o",
  b: { uncachedInputTokens: 500000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
});
crossStorage.setItem(DAILY_STORE_KEY, JSON.stringify(otherTab));

renderSession("sA", 3000000);
check(
  "merging re-reads the store so another tab's rows survive",
  storedSessionIds().join(",") === "sA,sOther"
);

renderSession("sB", 1000000);
check("a second session accumulates beside the first", storedSessionIds().join(",") === "sA,sB,sOther");

const crossAgg = internals.aggregateDaily(internals.dailyStats(storedDaily(), config));
check(
  "the all-time scope spans every stored session",
  crossAgg.sessions === 3 && crossAgg.tokens === 4500000 && Math.abs(crossAgg.amount - 4.5 * 0.8) < 1e-9
);

if (failures > 0) {
  console.error("\n" + failures + " check(s) failed");
  process.exit(1);
}
console.log("\nall checks passed");