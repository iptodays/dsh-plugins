/**
 * SessionReaper（会话清道夫）· 纯逻辑核心。
 *
 * 这个模块不 import 任何第三方包，只依赖 node: 内置模块，因此既能被宿主插件
 * （./index.js）复用，也能在零安装的冒烟测试里直接 import。
 *
 * 它负责三件不需要 Cordis 上下文的事：
 *   1. 解析/校验插件配置，给出确定性的默认值；
 *   2. 复刻 JSONL 持久化后端的目录编码，扫描磁盘上真实的会话目录；
 *   3. 根据「最后活动时间 + 保留期 + 保护规则」算出本轮该删哪些、留哪些。
 *
 * 真正调用 ctx.sessionPersistence / ctx.storageDomain 与 rm() 的动作在
 * ./index.js 里，本模块保持无副作用，便于单测。
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/** 一天的毫秒数。保留期统一以「天」为配置单位。 */
export const DAY_MS = 86_400_000;

/**
 * 默认配置。字段含义见 README；这里只保留可执行的事实。
 * archivedRetentionDays 为 null 表示「与 retentionDays 相同」。
 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  retentionDays: 30,
  archivedRetentionDays: null,
  sweepIntervalMinutes: 60,
  startDelaySeconds: 90,
  runOnStart: true,
  dryRun: false,
  verifyOwnership: true,
  maxDeletesPerSweep: 200,
  minRetainedPerProject: 2,
  includeSubagentSessions: true,
  deleteProjectionCache: true,
  sessionsRoot: null,
  protect: []
});

/** 配置校验失败时抛出的错误；Config 的 Standard Schema 适配器会把它转成 issues。 */
export class SessionReaperConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionReaperConfigError";
  }
}

/**
 * 把用户 patch 里的松散配置规范化成完整、可信的运行时配置。
 *
 * 只做「报错或接受」，不做静默夹取：类型不对、越界都会累积成一条错误，
 * 让 Loader 在装载期直接失败，而不是带着半吊子配置去删数据。
 *
 * @param {unknown} raw - patch 中 config 字段的原始值（允许 undefined）。
 * @returns {typeof DEFAULT_CONFIG} 完整配置对象。
 * @throws {SessionReaperConfigError} 任一字段非法时。
 */
export function normalizeConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new SessionReaperConfigError("config must be a mapping");
  }
  const issues = [];

  const bool = (key, fallback) => {
    const value = input[key];
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      issues.push(key + " must be a boolean");
      return fallback;
    }
    return value;
  };
  const number = (key, fallback, bounds = {}) => {
    const value = input[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push(key + " must be a finite number");
      return fallback;
    }
    if (bounds.integer && !Number.isInteger(value)) {
      issues.push(key + " must be an integer");
      return fallback;
    }
    if (bounds.min !== undefined && value < bounds.min) {
      issues.push(key + " must be >= " + bounds.min);
      return fallback;
    }
    if (bounds.max !== undefined && value > bounds.max) {
      issues.push(key + " must be <= " + bounds.max);
      return fallback;
    }
    return value;
  };

  const config = { ...DEFAULT_CONFIG };
  config.enabled = bool("enabled", DEFAULT_CONFIG.enabled);
  config.retentionDays = number("retentionDays", DEFAULT_CONFIG.retentionDays, { min: 0 });
  config.archivedRetentionDays = number("archivedRetentionDays", DEFAULT_CONFIG.archivedRetentionDays, { min: 0 });
  config.sweepIntervalMinutes = number("sweepIntervalMinutes", DEFAULT_CONFIG.sweepIntervalMinutes, { min: 1 });
  config.startDelaySeconds = number("startDelaySeconds", DEFAULT_CONFIG.startDelaySeconds, { min: 0 });
  config.runOnStart = bool("runOnStart", DEFAULT_CONFIG.runOnStart);
  config.dryRun = bool("dryRun", DEFAULT_CONFIG.dryRun);
  config.verifyOwnership = bool("verifyOwnership", DEFAULT_CONFIG.verifyOwnership);
  config.maxDeletesPerSweep = number("maxDeletesPerSweep", DEFAULT_CONFIG.maxDeletesPerSweep, { min: 0, integer: true });
  config.minRetainedPerProject = number("minRetainedPerProject", DEFAULT_CONFIG.minRetainedPerProject, { min: 0, integer: true });
  config.includeSubagentSessions = bool("includeSubagentSessions", DEFAULT_CONFIG.includeSubagentSessions);
  config.deleteProjectionCache = bool("deleteProjectionCache", DEFAULT_CONFIG.deleteProjectionCache);

  const root = input.sessionsRoot;
  if (root === undefined || root === null) config.sessionsRoot = null;
  else if (typeof root === "string" && root.trim().length > 0) config.sessionsRoot = root;
  else issues.push("sessionsRoot must be a non-empty string");

  const protect = input.protect;
  if (protect === undefined) config.protect = [];
  else if (Array.isArray(protect) && protect.every((entry) => typeof entry === "string" && entry.length > 0)) {
    config.protect = [...protect];
  } else {
    issues.push("protect must be an array of non-empty strings");
  }

  if (issues.length > 0) throw new SessionReaperConfigError(issues.join("; "));
  return config;
}

/**
 * 决定某个会话适用的保留期：归档会话可以单独设更短的期限。
 * @param {ReturnType<typeof normalizeConfig>} config - 运行时配置。
 * @param {boolean} archived - 该会话是否在 workspace 归档集合里。
 * @returns {number} 以「天」计的保留期。
 */
export function retentionDaysFor(config, archived) {
  if (archived && config.archivedRetentionDays !== null) return config.archivedRetentionDays;
  return config.retentionDays;
}

/**
 * 解析 DSH 家目录下的默认会话根目录，规则与 @deepseek-ai/dsh-home-paths 一致：
 * 非空白的 DSH_HOME 优先，否则 ~/.dsh。
 * @param {Record<string, string | undefined>} [env] - 环境变量表，测试可注入。
 * @param {string} [home] - 用户家目录，测试可注入。
 * @returns {string} 默认会话根目录的绝对路径。
 */
export function defaultSessionsRoot(env = process.env, home = homedir()) {
  const configured = env && env.DSH_HOME;
  const base = typeof configured === "string" && configured.trim().length > 0 ? configured : join(home, ".dsh");
  return join(base, "sessions");
}

/**
 * 复刻 dsh-session-persistence-jsonl 的 encodeSegment：把任意 Session id
 * 编码成单个安全路径段。只做解码还需要的东西，方便测试里的往返验证。
 * @param {string} raw - 原始字符串（非空）。
 * @returns {string} 编码后的路径段。
 */
export function encodeSegment(raw) {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char !== "~" && /^[A-Za-z0-9._-]$/.test(char)) out += char;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/**
 * encodeSegment 的逆运算：目录名 -> Session id。目录名只可能由安全字符
 * 与 ~XXXX 转义组成，遇到非法转义就抛错，交由调用方跳过。
 * @param {string} segment - 磁盘上的会话目录名。
 * @returns {string} 解码出的 Session id。
 */
export function decodeSegment(segment) {
  if (typeof segment !== "string" || segment.length === 0) throw new Error("cannot decode an empty path segment");
  let out = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char !== "~") {
      out += char;
      continue;
    }
    const hex = segment.slice(index + 1, index + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Error("malformed path escape in " + JSON.stringify(segment));
    out += String.fromCharCode(parseInt(hex, 16));
    index += 4;
  }
  return out;
}

/**
 * 把一个会话目录里所有文件/子目录的最新 mtime 与文件总字节数汇总出来。
 * 日志是追加写的，所以文件 mtime 就是「最后一次写盘」的可靠近似。
 * @param {string} dir - 会话目录。
 * @returns {Promise<{ latestMtimeMs: number, bytes: number, files: number }>}
 */
export async function directoryStats(dir) {
  let latestMtimeMs = 0;
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (info.mtimeMs > latestMtimeMs) latestMtimeMs = info.mtimeMs;
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (info.isFile()) {
        files += 1;
        bytes += info.size;
      }
    }
  }
  return { latestMtimeMs, bytes, files };
}

/**
 * 扫描会话根目录，按磁盘布局重建 id -> { dir, ... }。
 *
 * 只认「普通目录」：符号链接既不会当作项目目录也不会当作会话目录，避免顺着
 * 链接删到根目录之外。根目录不存在时返回空表（首次启动、尚未落盘任何会话）。
 *
 * @param {string} root - 会话根目录。
 * @returns {Promise<Map<string, { id: string, dir: string, project: string, latestMtimeMs: number, bytes: number, files: number }>>}
 */
export async function scanStoredSessions(root) {
  const found = new Map();
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return found;
    throw error;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(projectDir, entry.name);
      let id;
      try {
        id = decodeSegment(entry.name);
      } catch {
        continue;
      }
      const stats = await directoryStats(dir);
      found.set(id, { id, dir, project: project.name, ...stats });
    }
  }
  return found;
}

/**
 * 把 patch 里的保护规则套到会话上。含 * 或 ? 的规则按通配符匹配（整串），
 * 否则按大小写敏感的子串匹配；两者都会同时看 id 与 cwd。
 * @param {readonly string[]} patterns - 规则列表。
 * @param {string} id - 会话 id。
 * @param {string | undefined} cwd - 会话工作目录。
 * @returns {string | null} 命中的规则，未命中为 null。
 */
export function matchProtect(patterns, id, cwd) {
  if (!Array.isArray(patterns)) return null;
  for (const pattern of patterns) {
    if (matchGlob(pattern, id)) return pattern;
    if (typeof cwd === "string" && cwd.length > 0 && matchGlob(pattern, cwd)) return pattern;
  }
  return null;
}

/** 单条规则的匹配实现；导出便于单测。 */
export function matchGlob(pattern, value) {
  if (typeof pattern !== "string" || typeof value !== "string" || pattern.length === 0) return false;
  if (!/[*?]/.test(pattern)) return value.includes(pattern);
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") regex += ".*";
    else if (char === "?") regex += ".";
    else regex += char.replace(/[.*+?^$ {}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(regex + "$").test(value);
}

/**
 * 计算本轮清理计划——纯函数，不碰磁盘也不调服务。
 *
 * 判定顺序（越靠前越优先）：
 *   1. 磁盘上没有目录（例如刚 create 还没落盘）-> not-materialized；
 *   2. 本进程存活 / 用 DSH_SESSION_ID 指定的当前会话 -> live；
 *   3. workspace 置顶 -> pinned；
 *   4. 命中 protect 规则 -> protected；
 *   5. 子代理会话且配置排除 -> subagent；
 *   6. 未超保留期 -> retained；
 *   7. 其余进入 candidates；随后用 minRetainedPerProject 把每个项目最新的
 *      N 个从候选里捞回 retained（按 cwd 分组），最后按最旧优先截断到
 *      maxDeletesPerSweep。
 *
 * @param {{
 *   now: number,
 *   config: ReturnType<typeof normalizeConfig>,
 *   sessions: ReadonlyArray<{ id: string, createdAt?: number, cwd?: string, origin?: string, isSeeded?: boolean }>,
 *   disk: Map<string, { dir: string, latestMtimeMs: number, bytes?: number }>,
 *   liveIds?: Iterable<string>,
 *   pinnedIds?: Iterable<string>,
 *   archivedIds?: Iterable<string>
 * }} input - 本轮输入。
 * @returns {{ candidates: object[], deferred: object[], retained: object[], skipped: { id: string, reason: string }[] }}
 */
export function planSweep(input) {
  const { now, config } = input;
  const live = toSet(input.liveIds);
  const pinned = toSet(input.pinnedIds);
  const archived = toSet(input.archivedIds);
  const disk = input.disk instanceof Map ? input.disk : new Map();
  const skipped = [];
  const retained = [];
  const candidates = [];

  for (const session of input.sessions) {
    const id = session.id;
    const record = disk.get(id);
    const createdAt = Number.isFinite(session.createdAt) ? session.createdAt : 0;
    const row = {
      id,
      dir: record ? record.dir : null,
      cwd: session.cwd,
      origin: session.origin,
      createdAt,
      lastActivity: Math.max(createdAt, record ? record.latestMtimeMs : 0),
      bytes: record && Number.isFinite(record.bytes) ? record.bytes : 0
    };
    row.ageMs = now - row.lastActivity;
    row.retentionDays = retentionDaysFor(config, archived.has(id));
    row.retentionMs = row.retentionDays * DAY_MS;

    if (record === undefined) skipped.push({ id, reason: "not-materialized" });
    else if (live.has(id)) skipped.push({ id, reason: "live" });
    else if (pinned.has(id)) skipped.push({ id, reason: "pinned" });
    else if (matchProtect(config.protect, id, session.cwd) !== null) skipped.push({ id, reason: "protected" });
    else if (!config.includeSubagentSessions && session.origin === "subagent") skipped.push({ id, reason: "subagent" });
    else if (row.ageMs <= row.retentionMs) retained.push(row);
    else candidates.push(row);
  }

  // 每个项目至少保留最新 N 个，避免「整个项目历史被一次清空」。
  if (config.minRetainedPerProject > 0) {
    const groups = new Map();
    for (const row of [...retained, ...candidates]) {
      const key = typeof row.cwd === "string" && row.cwd.length > 0 ? row.cwd : "__no-cwd__";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const rescued = new Set();
    for (const group of groups.values()) {
      group.sort((left, right) => right.lastActivity - left.lastActivity);
      for (let index = 0; index < Math.min(config.minRetainedPerProject, group.length); index += 1) {
        rescued.add(group[index]);
      }
    }
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const row = candidates[index];
      if (rescued.has(row)) {
        row.rescuedBy = "min-retained-per-project";
        retained.push(row);
        candidates.splice(index, 1);
      }
    }
  }

  // 最旧的先删，超出单轮预算的留到下一轮。
  candidates.sort((left, right) => left.lastActivity - right.lastActivity || left.id.localeCompare(right.id));
  const limit = config.maxDeletesPerSweep;
  const deferred = limit > 0 ? candidates.slice(limit) : [];
  const selected = limit > 0 ? candidates.slice(0, limit) : candidates;

  retained.sort((left, right) => right.lastActivity - left.lastActivity);
  return { candidates: selected, deferred, retained, skipped };
}

/** 把可选 id 列表收敛成 Set。 */
function toSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  if (value && typeof value[Symbol.iterator] === "function") return new Set(value);
  return new Set();
}

/**
 * 人类可读的字节数，仅用于日志。
 * @param {number} bytes - 字节数。
 * @returns {string} 例如 "12.3 MB"。
 */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let at = 0;
  let scaled = value;
  while (scaled >= 1024 && at < units.length - 1) {
    scaled /= 1024;
    at += 1;
  }
  const digits = at === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return scaled.toFixed(digits) + " " + units[at];
}

/** 判断路径是否确实落在根目录内（防止符号链接/手工配置把删除指向别处）。 */
export function isInside(root, target) {
  if (typeof root !== "string" || typeof target !== "string") return false;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix) && target.length > prefix.length;
}
