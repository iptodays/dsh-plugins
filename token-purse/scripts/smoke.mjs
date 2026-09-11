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

function makeSandbox(react, extra) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED_NOW);
      else super(...args);
    }
    static now() {
      return FIXED_NOW;
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

function loadInternals(react) {
  const sandbox = makeSandbox(react);
  const source =
    readFileSync(join(root, "src", "client.js"), "utf8") +
    "\nexports.__test = { rateUsage, rateLedger, resolveRates, mergeConfig, formatMoney, formatTokens, formatRate, DEFAULT_CONFIG, TokenPurseView, matchCurrencyPreset, findCurrencyPreset, fetchUsdRate, parsePeakWindow, parsePeak, isPeakAt, ratesAt, emptyLedger, syncLedger, migrateConfigV1, rateSource, CURRENCY_PRESETS };\n";
  vm.runInContext(source, sandbox);
  return sandbox.exports.__test;
}

function loadBundle(react) {
  const sandbox = makeSandbox(react);
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

/* ── 2. 模块外壳与注册 ──────────────────────────────────────────────── */

console.log("bundle + registration");
const registration = loadBundle(react);
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

react.reset();
const hostless = captured.component({ useProjection: () => undefined, t });
check("host renders hidden anchor without DOM", JSON.stringify(hostless).indexOf("TPurse_host") !== -1);

if (failures > 0) {
  console.error("\n" + failures + " check(s) failed");
  process.exit(1);
}
console.log("\nall checks passed");