#!/usr/bin/env node
/**
 * 从 DSH 主题包里导出全部 --dsw-* token 名与两套主题下的解析值，写成
 * scripts/theme-tokens.json。
 *
 * 为什么需要这个文件：面板 CSS 只允许引用真实存在的主题 token。此前引用的
 * --dsw-alias-fill-l2 / --dsw-font-mono / --dsw-static-yellow-500 三个 token 在主题里
 * 根本不存在——在 background 位置失效只是变透明，但在 fill 位置（fill 可继承）会退化成
 * 黑色，于是折线面积被画成一块黑楔形。快照 + smoke 里的两项断言（存在性、对比度）把这类
 * 错误钉死在测试里。
 *
 * 用法（仅在主题升级后需要重跑）：
 *   node scripts/refresh-theme-tokens.mjs                 # 自动探测
 *   node scripts/refresh-theme-tokens.mjs /path/to/client.js
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rel = "node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js";

function candidates() {
  const list = [];
  if (process.argv[2]) list.push(process.argv[2]);
  if (process.env.DSH_THEME_FILE) list.push(process.env.DSH_THEME_FILE);
  const home = process.env.DSH_HOME || join(process.env.HOME || "", ".dsh");
  const profiles = join(home, "profiles");
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) list.push(join(profiles, name, rel));
  }
  /* 开发机上第一方包来自 dsh 的 npx 检出目录（profile 里只有 @dsh-plugins）。 */
  const npx = join(process.env.HOME || "", ".npm", "_npx");
  if (existsSync(npx)) {
    for (const name of readdirSync(npx)) list.push(join(npx, name, rel));
  }
  return list;
}

const found = candidates().find((path) => existsSync(path));
if (!found) {
  console.error("找不到主题包；请把 client.js 路径作为参数传入。");
  process.exit(1);
}

/* ── 取出 design-platform.css 那段字符串 ─────────────────────────────── */
const raw = readFileSync(found, "utf8");
const marker = 'var design_platform_css_default = "';
const from = raw.indexOf(marker);
if (from === -1) throw new Error("主题包里找不到 design_platform_css_default");
const body = raw.slice(from + marker.length);
const css = JSON.parse('"' + body.slice(0, body.indexOf('";')) + '"');

const blocks = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({
  selector: m[1].trim(),
  dark: m[1].includes("data-ds-dark-theme"),
  decls: Object.fromEntries(
    Array.from(m[2].matchAll(/(--dsw-[a-z0-9-]+)\s*:\s*([^;]+)/g), (d) => [d[1], d[2].trim()])
  )
}));

const palette = { light: {}, dark: {} };
for (const block of blocks) Object.assign(palette[block.dark ? "dark" : "light"], block.decls);

/*
 * 存在性检查用「整个主题包出现过的 token 名」：调色板 163 个之外，base.css /
 * corner-shape / gradient-shadow-text / scrollbar / shiki 等还定义了字体、圆角、阴影、
 * elevation 等结构 token，一共 357 个。只用调色板会误报。
 */
const tokens = Array.from(new Set(Array.from(raw.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g), (m) => m[1]))).sort();

function resolve(name, mode, depth = 0) {
  const value = palette[mode][name];
  if (value === undefined || depth > 12) return undefined;
  const varMatch = value.match(/^var\((--dsw-[a-z0-9-]+)(?:,\s*(.+))?\)$/);
  if (varMatch) {
    const inner = resolve(varMatch[1], mode, depth + 1);
    return inner === undefined ? varMatch[2] : inner;
  }
  return value;
}

/** 把 3/4 位缩写 hex 展开成 6/8 位，其余原样返回。 */
function expandHex(text) {
  const short = text.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/);
  if (short === null) return text;
  const [, r, g, b, a] = short;
  return "#" + r + r + g + g + b + b + (a === undefined ? "" : a + a);
}

/** 只保留能当颜色用的解析结果，供 smoke 直接做对比度断言。 */
function colorOf(name, mode) {
  const value = resolve(name, mode);
  if (typeof value !== "string") return undefined;
  const text = expandHex(value.trim().toLowerCase());
  if (text === "transparent") return "#00000000";
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(text) ? text : undefined;
}

const values = {};
for (const name of tokens) {
  const light = colorOf(name, "light");
  const dark = colorOf(name, "dark");
  if (light !== undefined && dark !== undefined) values[name] = { light, dark };
}

const out = {
  note: "由 scripts/refresh-theme-tokens.mjs 生成；主题升级后请重跑。values 只含可解析为纯色的 token。",
  source: found,
  count: tokens.length,
  tokens,
  values
};
writeFileSync(join(root, "scripts/theme-tokens.json"), JSON.stringify(out, null, 1) + "\n");
console.log("wrote " + tokens.length + " tokens (" + Object.keys(values).length + " with colours) from " + found);
