/**
 * SessionReaper（会话清道夫）· 宿主半边。
 *
 * DSH 的会话持久化只提供「读/追加/关闭」，没有删除与保留期 API
 * （见 @deepseek-ai/dsh-session-persistence 的 Known Limitations：
 *  "No deletion or retention API — pruning stored sessions is out-of-band
 *   backend maintenance."）。这个插件就是那件 out-of-band 维护：
 *
 *   1. 周期性调用 ctx.sessionPersistence.list() 拿到全部可见会话；
 *   2. 扫描 JSONL 后端落盘的会话目录，用文件 mtime 作为最后活动时间；
 *   3. 对超过保留期的会话，先用 open(id, 'write') 探一次写锁（跨进程防止
 *      删掉另一个 DSH 实例正在写的会话），再 rm 掉整个会话目录；
 *   4. 顺带删掉 session_projcache 域里对应的投影缓存记录，避免侧栏出现
 *      指向已删日志的幽灵条目。
 *
 * 所有判断逻辑在 ./core.js（无副作用、可单测）；本文件只负责接线与落盘动作。
 */
import { rm } from "node:fs/promises";
import {
  defaultSessionsRoot,
  formatBytes,
  isInside,
  normalizeConfig,
  planSweep,
  scanStoredSessions
} from "./core.js";

/** Cordis 插件名，用于 Loader 诊断。 */
export const name = "session-reaper";

/** 必需服务：内存会话注册表（判断存活）+ 持久化后端（枚举与写锁探测）。 */
export const inject = ["sessions", "sessionPersistence"];

/**
 * 配置校验器，实现 Standard Schema v1。刻意不依赖 schemastery：
 * 本插件保持零第三方依赖，冒烟测试才能在没有 node_modules 的目录里直跑。
 */
export const Config = {
  "~standard": {
    version: 1,
    vendor: "dsh-plugins/session-reaper",
    validate(value) {
      try {
        return { value: normalizeConfig(value) };
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
      }
    }
  }
};

/**
 * 装载插件：注册定时清扫，并返回一个可被其它插件/测试手动触发的句柄。
 * @param {any} ctx - Cordis 上下文（已注入 sessions 与 sessionPersistence）。
 * @param {unknown} rawConfig - patch 中 config 字段的原始值。
 * @returns {{ config: object, status: () => object, sweep: (options?: object) => Promise<object> }}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const state = { sweeps: 0, lastResult: null };
  const api = {
    config,
    status: () => ({ sweeps: state.sweeps, lastResult: state.lastResult, config }),
    sweep: (options = {}) => runSweep(ctx, config, options, state)
  };

  // 尽力把句柄注册成服务 ctx.sessionReaper，方便其它插件或未来的设置页
  // 手动触发一轮清扫；注册失败（重名、旧宿主没有 provide）不影响定时清扫。
  if (typeof ctx.provide === "function") {
    try {
      ctx.provide("sessionReaper", api);
    } catch {
      /* 非必需能力，失败不影响清扫 */
    }
  }

  if (!config.enabled) {
    ctx.logger.info("session-reaper: disabled by config; no sweep scheduled");
    return api;
  }

  const intervalMs = Math.round(config.sweepIntervalMinutes * 60_000);
  ctx.effect(() => {
    const timer = setInterval(() => {
      void api.sweep().catch((error) => ctx.logger.warn("session-reaper: sweep failed: " + describe(error)));
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }, "session-reaper.interval");

  if (config.runOnStart) {
    const delayMs = Math.round(config.startDelaySeconds * 1000);
    ctx.effect(() => {
      const timer = setTimeout(() => {
        void api.sweep().catch((error) => ctx.logger.warn("session-reaper: startup sweep failed: " + describe(error)));
      }, delayMs);
      if (typeof timer.unref === "function") timer.unref();
      return () => clearTimeout(timer);
    }, "session-reaper.startup");
  }

  ctx.logger.info(
    "session-reaper: armed (retention " +
      config.retentionDays +
      "d, every " +
      config.sweepIntervalMinutes +
      "min, keep newest " +
      config.minRetainedPerProject +
      " per project" +
      (config.dryRun ? ", dry-run" : "") +
      ")"
  );
  return api;
}

/**
 * 执行一轮清扫。
 * @param {any} ctx - 宿主上下文。
 * @param {object} config - 规范化配置。
 * @param {{ now?: number }} options - 可注入的当前时间，测试用。
 * @param {{ sweeps: number, lastResult: object | null }} state - 插件状态。
 * @returns {Promise<object>} 本轮结果摘要。
 */
async function runSweep(ctx, config, options, state) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const persistence = ctx.sessionPersistence;
  const sessions = ctx.sessions;
  const root = typeof config.sessionsRoot === "string" && config.sessionsRoot.length > 0 ? config.sessionsRoot : defaultSessionsRoot();

  // 存活会话：内存注册表 + 当前会话 env，双保险。
  const liveIds = new Set();
  if (sessions && typeof sessions.list === "function") {
    for (const session of sessions.list()) liveIds.add(session.id);
  }
  const currentId = process.env.DSH_SESSION_ID;
  if (typeof currentId === "string" && currentId.length > 0) liveIds.add(currentId);

  // workspace 置顶/归档集合。优先走 workspaceRegistry 服务；它没挂载时退回
  // 直接读已打开的 workspace 域（同一份内存状态），两者都没有就按空集处理。
  const pinned = new Set();
  const archived = new Set();
  const registry = typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : undefined;
  const workspaceState = registry !== undefined ? registry : readWorkspaceState(ctx);
  if (workspaceState) {
    for (const id of workspaceState.pinnedSessionIds || []) pinned.add(id);
    for (const id of workspaceState.archivedSessionIds || []) archived.add(id);
  }

  const snapshots = await persistence.list();
  const disk = await scanStoredSessions(root);
  const headers = snapshots.map((snapshot) => ({
    id: snapshot.header.id,
    createdAt: snapshot.header.createdAt,
    cwd: snapshot.header.cwd,
    origin: snapshot.header.origin,
    isSeeded: snapshot.header.isSeeded
  }));

  const plan = planSweep({ now, config, sessions: headers, disk, liveIds, pinnedIds: pinned, archivedIds: archived });
  const result = {
    at: now,
    root,
    dryRun: config.dryRun,
    scanned: headers.length,
    candidates: plan.candidates.length,
    deferred: plan.deferred.length,
    retained: plan.retained.length,
    skipped: plan.skipped,
    deleted: [],
    failed: [],
    freedBytes: 0
  };

  for (const row of plan.candidates) {
    if (typeof row.dir !== "string" || !isInside(root, row.dir)) {
      result.failed.push({ id: row.id, reason: "unresolved-directory" });
      continue;
    }
    // 写锁探测：open(..., "write") 成功说明此刻没有别的写持有者；持有者
    // 可能是另一个 DSH 进程，也可能是本进程里没进 sessions 表的会话。
    if (config.verifyOwnership && persistence && typeof persistence.open === "function") {
      let handle;
      try {
        handle = await persistence.open(row.id, "write");
      } catch (error) {
        result.failed.push({ id: row.id, reason: "owned:" + describe(error) });
        continue;
      }
      if (handle && typeof handle.close === "function") {
        try {
          await handle.close();
        } catch {
          /* 关不掉也不阻塞删除；最坏情况是日志目录已经没了 */
        }
      }
    }

    if (config.dryRun) {
      result.deleted.push({ id: row.id, bytes: row.bytes, dryRun: true });
      continue;
    }

    try {
      await rm(row.dir, { recursive: true, force: true });
      result.deleted.push({ id: row.id, bytes: row.bytes });
      result.freedBytes += row.bytes;
      if (config.deleteProjectionCache) await deleteProjectionCache(ctx, row.id);
    } catch (error) {
      result.failed.push({ id: row.id, reason: "delete-failed:" + describe(error) });
    }
  }

  state.sweeps += 1;
  state.lastResult = result;
  logResult(ctx, result, config);
  return result;
}

/**
 * 从已打开的 workspace 域里直接读置顶/归档集合（workspaceRegistry 缺失时的兜底）。
 * @returns {{ pinnedSessionIds?: readonly string[], archivedSessionIds?: readonly string[] } | undefined}
 */
function readWorkspaceState(ctx) {
  if (typeof ctx.get !== "function") return undefined;
  const facility = ctx.get("storageDomain");
  if (!facility || typeof facility.get !== "function") return undefined;
  try {
    const domain = facility.get("workspace");
    if (!domain) return undefined;
    return domain.global.get();
  } catch {
    return undefined;
  }
}

/**
 * 删掉 session_projcache 域里该会话的投影缓存记录（同时更新内存与磁盘）。
 * 域未挂载、记录不存在、后端报错都按「没删到」处理，不抛给调用方。
 * @returns {Promise<boolean>} 是否真的删掉了一条记录。
 */
async function deleteProjectionCache(ctx, id) {
  const facility = typeof ctx.get === "function" ? ctx.get("storageDomain") : undefined;
  if (!facility || typeof facility.get !== "function") return false;
  let domain;
  try {
    domain = facility.get("session_projcache");
  } catch {
    return false;
  }
  if (!domain || typeof domain.table !== "function") return false;
  try {
    return await domain.table("sessions").delete(id);
  } catch {
    return false;
  }
}

/** 从错误对象里取一个稳定的短名字用于日志/结果。 */
function describe(error) {
  if (error && typeof error.name === "string" && error.name.length > 0) return error.name;
  return String(error);
}

/** 输出一行摘要；没有任何动作时降到 debug，避免每小时刷屏。 */
function logResult(ctx, result, config) {
  const line =
    "session-reaper: " +
    (result.dryRun ? "[dry-run] " : "") +
    "scanned " +
    result.scanned +
    ", deleted " +
    result.deleted.length +
    (result.freedBytes > 0 ? " (" + formatBytes(result.freedBytes) + ")" : "") +
    ", retained " +
    result.retained +
    ", deferred " +
    result.deferred +
    ", skipped " +
    result.skipped.length +
    (result.failed.length > 0 ? ", failed " + result.failed.length : "");
  if (result.deleted.length > 0 || result.failed.length > 0 || config.dryRun) ctx.logger.info(line);
  else ctx.logger.debug(line);
  for (const failure of result.failed) {
    ctx.logger.warn("session-reaper: kept " + failure.id + " (" + failure.reason + ")");
  }
}
