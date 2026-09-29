#!/usr/bin/env node
/**
 * SessionReaper 冒烟测试（零依赖、不联网、不碰真实的 ~/.dsh）。
 *
 * 覆盖四层：
 *   1. core 的纯函数：路径编解码、配置规范化、保护规则、字节格式化；
 *   2. 磁盘扫描：在临时目录里摆出真实的 JSONL 目录布局，验证 mtime/字节统计；
 *   3. 清理计划：存活/置顶/白名单/子代理/归档/项目保底/单轮上限；
 *   4. 插件接线：用假的 ctx + 假的持久化后端跑完整一轮，验证真的删了目录、
 *      清了投影缓存，并且没碰存活/置顶/被别处占写的会话。
 *
 * 所有临时目录都建在插件目录下的 .tmp-*，跑完即删，避免污染宿主。
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAY_MS,
  defaultSessionsRoot,
  directoryStats,
  encodeSegment,
  decodeSegment,
  formatBytes,
  isInside,
  matchGlob,
  matchProtect,
  normalizeConfig,
  planSweep,
  retentionDaysFor,
  scanStoredSessions
} from "../src/core.js";
import { Config, apply, inject, name } from "../src/index.js";

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log("  ok   " + label);
  else {
    failures += 1;
    console.error("  FAIL " + label + (detail === undefined ? "" : " - " + detail));
  }
}
function section(title) {
  console.log("");
  console.log(title);
}

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const tmp = await mkdtemp(join(pluginRoot, ".tmp-"));

/** 在 root/project 下摆一个会话目录，日志文件 mtime 设为 ageDays 天前。 */
async function seed(root, project, id, ageDays, bytes = 32) {
  const dir = join(root, project, encodeSegment(id));
  await mkdir(dir, { recursive: true });
  const file = join(dir, "session.v4.jsonl.zstd");
  await writeFile(file, "x".repeat(bytes));
  const when = new Date(NOW - ageDays * DAY_MS);
  await utimes(file, when, when);
  return dir;
}

try {
  section("bundle shape");
  check("plugin name", name === "session-reaper");
  check("inject declares sessions + sessionPersistence", Array.isArray(inject) && inject.includes("sessions") && inject.includes("sessionPersistence"));
  check("Config exposes a Standard Schema validator", typeof Config["~standard"].validate === "function");

  section("path encoding");
  const ids = ["session-1", "a.b_c-d", ".", "..", "~", "has space", "emoji-\u{1F600}", "slash/../x", "A".repeat(300)];
  let roundTrip = true;
  for (const id of ids) {
    if (decodeSegment(encodeSegment(id)) !== id) roundTrip = false;
  }
  check("encodeSegment -> decodeSegment round-trips " + ids.length + " ids", roundTrip);
  check("escapes path separators", !encodeSegment("a/b").includes("/") && !encodeSegment("slash/../x").includes("/"));
  check("escapes a literal tilde", encodeSegment("~") === "~007E");
  check("decodeSegment rejects a malformed escape", (() => {
    try {
      decodeSegment("~ZZZZ");
      return false;
    } catch {
      return true;
    }
  })());

  section("config normalization");
  const defaults = normalizeConfig(undefined);
  check(
    "defaults applied",
    defaults.retentionDays === 30 &&
      defaults.sweepIntervalMinutes === 60 &&
      defaults.minRetainedPerProject === 2 &&
      defaults.dryRun === false &&
      defaults.sessionsRoot === null
  );
  check("unknown keys ignored", normalizeConfig({ whatever: 1 }).retentionDays === 30);
  const custom = normalizeConfig({ retentionDays: 3, dryRun: true, protect: ["alpha", "beta"], sessionsRoot: "/tmp/x" });
  check("custom values kept", custom.retentionDays === 3 && custom.dryRun === true && custom.protect.length === 2 && custom.sessionsRoot === "/tmp/x");
  const badConfigs = [
    { retentionDays: -1 },
    { sweepIntervalMinutes: 0 },
    { maxDeletesPerSweep: 1.5 },
    { protect: "dsh" },
    { enabled: "yes" },
    { sessionsRoot: "" },
    { retentionDays: "30" }
  ];
  let allThrew = true;
  for (const value of badConfigs) {
    try {
      normalizeConfig(value);
      allThrew = false;
    } catch {
      /* expected */
    }
  }
  check("invalid configs rejected", allThrew);
  check("schema validate returns a value", Config["~standard"].validate({ retentionDays: 5 }).value.retentionDays === 5);
  check("schema validate returns issues", Array.isArray(Config["~standard"].validate({ retentionDays: -5 }).issues));
  check(
    "retentionDaysFor honours the archived override",
    retentionDaysFor(normalizeConfig({ retentionDays: 30, archivedRetentionDays: 7 }), true) === 7 &&
      retentionDaysFor(normalizeConfig({ retentionDays: 30, archivedRetentionDays: 7 }), false) === 30
  );
  check("defaultSessionsRoot uses DSH_HOME", defaultSessionsRoot({ DSH_HOME: "/custom/home" }, "/home/u") === join("/custom/home", "sessions"));
  check("defaultSessionsRoot falls back to ~/.dsh", defaultSessionsRoot({}, "/home/u") === join("/home/u", ".dsh", "sessions"));

  section("protection rules");
  check("plain pattern is a substring match", matchGlob("alpha", "/w/alpha/x") && !matchGlob("alpha", "/w/beta"));
  check("wildcard is an anchored glob", matchGlob("session-*", "session-abc") && !matchGlob("session-*", "x-session-abc"));
  check("? matches exactly one character", matchGlob("ab?", "abc") && !matchGlob("ab?", "abcd"));
  check("regex metacharacters are escaped", matchGlob("a+b", "a+b") && !matchGlob("a+b", "aab"));
  check(
    "matchProtect checks both id and cwd",
    matchProtect(["beta"], "session-a", "/w/beta") === "beta" && matchProtect(["beta"], "session-a", "/w/alpha") === null
  );

  section("disk scan");
  const scanRoot = join(tmp, "sessions");
  const oldDir = await seed(scanRoot, "--proj-a--", "session-old", 40);
  await seed(scanRoot, "--proj-a--", "session-new", 1);
  await seed(scanRoot, "_no-cwd", "session-nocwd", 40);
  const stats = await directoryStats(oldDir);
  check(
    "directoryStats tracks mtime and bytes",
    Math.abs(stats.latestMtimeMs - (NOW - 40 * DAY_MS)) < 5000 && stats.bytes === 32 && stats.files === 1
  );
  const disk = await scanStoredSessions(scanRoot);
  check(
    "scanStoredSessions finds every session",
    disk.size === 3 && disk.get("session-old").dir === oldDir && disk.get("session-new").project === "--proj-a--"
  );
  check("scanStoredSessions on a missing root yields an empty map", (await scanStoredSessions(join(tmp, "nope"))).size === 0);

  section("sweep planning");
  const base = normalizeConfig({ retentionDays: 30, minRetainedPerProject: 0, maxDeletesPerSweep: 0 });
  const diskMap = new Map([
    ["s-old", { dir: "/r/a/s-old", latestMtimeMs: NOW - 40 * DAY_MS, bytes: 100 }],
    ["s-new", { dir: "/r/a/s-new", latestMtimeMs: NOW - 1 * DAY_MS, bytes: 10 }],
    ["s-live", { dir: "/r/a/s-live", latestMtimeMs: NOW - 40 * DAY_MS, bytes: 10 }],
    ["s-pin", { dir: "/r/a/s-pin", latestMtimeMs: NOW - 40 * DAY_MS, bytes: 10 }]
  ]);
  const headers = [
    { id: "s-old", cwd: "/w/a", createdAt: NOW - 50 * DAY_MS },
    { id: "s-new", cwd: "/w/a", createdAt: NOW - 1 * DAY_MS },
    { id: "s-live", cwd: "/w/a", createdAt: NOW - 50 * DAY_MS },
    { id: "s-pin", cwd: "/w/a", createdAt: NOW - 50 * DAY_MS },
    { id: "s-unmaterialized", cwd: "/w/a", createdAt: NOW - 50 * DAY_MS }
  ];
  const plan = planSweep({ now: NOW, config: base, sessions: headers, disk: diskMap, liveIds: ["s-live"], pinnedIds: ["s-pin"] });
  check("only the expired, unprotected session is a candidate", plan.candidates.length === 1 && plan.candidates[0].id === "s-old");
  check("live session skipped", plan.skipped.some((entry) => entry.id === "s-live" && entry.reason === "live"));
  check("pinned session skipped", plan.skipped.some((entry) => entry.id === "s-pin" && entry.reason === "pinned"));
  check("unmaterialized session skipped", plan.skipped.some((entry) => entry.id === "s-unmaterialized" && entry.reason === "not-materialized"));
  check("recent session retained", plan.retained.some((entry) => entry.id === "s-new"));

  const many = [];
  const manyDisk = new Map();
  for (let index = 0; index < 4; index += 1) {
    const id = "k-" + index;
    const activity = NOW - (10 - index) * DAY_MS;
    many.push({ id, cwd: "/w/keep", createdAt: activity });
    manyDisk.set(id, { dir: "/r/" + id, latestMtimeMs: activity, bytes: 1 });
  }
  const keepPlan = planSweep({ now: NOW, config: normalizeConfig({ retentionDays: 0, minRetainedPerProject: 2, maxDeletesPerSweep: 0 }), sessions: many, disk: manyDisk });
  check(
    "minRetainedPerProject rescues the newest N",
    keepPlan.candidates.map((entry) => entry.id).sort().join(",") === "k-0,k-1" &&
      keepPlan.retained.map((entry) => entry.id).sort().join(",") === "k-2,k-3"
  );
  const capPlan = planSweep({ now: NOW, config: normalizeConfig({ retentionDays: 0, minRetainedPerProject: 0, maxDeletesPerSweep: 1 }), sessions: many, disk: manyDisk });
  check(
    "maxDeletesPerSweep caps one sweep and defers the rest",
    capPlan.candidates.length === 1 && capPlan.candidates[0].id === "k-0" && capPlan.deferred.length === 3
  );
  const archPlan = planSweep({
    now: NOW,
    config: normalizeConfig({ retentionDays: 30, archivedRetentionDays: 1, minRetainedPerProject: 0, maxDeletesPerSweep: 0 }),
    sessions: [{ id: "s-arch", cwd: "/w/a", createdAt: NOW - 3 * DAY_MS }],
    disk: new Map([["s-arch", { dir: "/r/s-arch", latestMtimeMs: NOW - 3 * DAY_MS, bytes: 1 }]]),
    archivedIds: ["s-arch"]
  });
  check("archived sessions use archivedRetentionDays", archPlan.candidates.length === 1);
  const protectPlan = planSweep({
    now: NOW,
    config: normalizeConfig({ retentionDays: 0, minRetainedPerProject: 0, maxDeletesPerSweep: 0, protect: ["/w/secret"] }),
    sessions: [{ id: "s-secret", cwd: "/w/secret", createdAt: NOW - 99 * DAY_MS }],
    disk: new Map([["s-secret", { dir: "/r/s-secret", latestMtimeMs: NOW - 99 * DAY_MS, bytes: 1 }]])
  });
  check("protect pattern keeps a session", protectPlan.candidates.length === 0 && protectPlan.skipped.some((entry) => entry.reason === "protected"));
  const subPlan = planSweep({
    now: NOW,
    config: normalizeConfig({ retentionDays: 0, minRetainedPerProject: 0, maxDeletesPerSweep: 0, includeSubagentSessions: false }),
    sessions: [{ id: "s-sub", cwd: "/w/a", origin: "subagent", createdAt: NOW - 99 * DAY_MS }],
    disk: new Map([["s-sub", { dir: "/r/s-sub", latestMtimeMs: NOW - 99 * DAY_MS }]])
  });
  check("subagent sessions can be excluded", subPlan.candidates.length === 0 && subPlan.skipped.some((entry) => entry.reason === "subagent"));

  check("formatBytes scales units", formatBytes(0) === "0 B" && formatBytes(1536) === "1.50 KB" && formatBytes(5 * 1024 * 1024) === "5.00 MB");
  check("isInside rejects siblings and the root itself", isInside("/a/b", "/a/b/c") && !isInside("/a/b", "/a/bc") && !isInside("/a/b", "/a/b"));

  section("apply() integration");
  const applyRoot = join(tmp, "apply-sessions");
  const dirOld = await seed(applyRoot, "--p--", "session-old", 90);
  const dirFresh = await seed(applyRoot, "--p--", "session-fresh", 1);
  const dirLive = await seed(applyRoot, "--p--", "session-live", 90);
  const dirPin = await seed(applyRoot, "--p--", "session-pin", 90);
  const dirOwned = await seed(applyRoot, "--p--", "session-owned", 90);

  const cacheDeletes = [];
  const storageDomain = {
    get: (domainName) =>
      domainName === "session_projcache"
        ? { table: () => ({ delete: async (id) => { cacheDeletes.push(id); return true; } }) }
        : undefined
  };
  const listed = [
    { id: "session-old", createdAt: NOW - 100 * DAY_MS, cwd: "/w/p" },
    { id: "session-fresh", createdAt: NOW - 1 * DAY_MS, cwd: "/w/p" },
    { id: "session-live", createdAt: NOW - 100 * DAY_MS, cwd: "/w/p" },
    { id: "session-pin", createdAt: NOW - 100 * DAY_MS, cwd: "/w/p" },
    { id: "session-owned", createdAt: NOW - 100 * DAY_MS, cwd: "/w/p" }
  ];
  const openCalls = [];
  const persistence = {
    list: async () => listed.map((header) => ({ header })),
    open: async (id) => {
      openCalls.push(id);
      if (id === "session-owned") {
        const error = new Error("write ownership is taken");
        error.name = "SessionAlreadyOwnedError";
        throw error;
      }
      return { id, close: async () => {} };
    }
  };
  const logs = [];
  const makeCtx = (overrides = {}) => ({
    sessions: { list: () => [{ id: "session-live" }] },
    sessionPersistence: persistence,
    logger: {
      info: (message) => logs.push(["info", message]),
      warn: (message) => logs.push(["warn", message]),
      debug: (message) => logs.push(["debug", message]),
      error: (message) => logs.push(["error", message])
    },
    effect: (body) => {
      const disposer = body();
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    get: (serviceName) =>
      serviceName === "storageDomain"
        ? storageDomain
        : serviceName === "workspaceRegistry"
          ? { pinnedSessionIds: ["session-pin"], archivedSessionIds: [] }
          : undefined,
    set: () => {},
    ...overrides
  });

  const api = apply(makeCtx(), {
    enabled: true,
    runOnStart: false,
    sweepIntervalMinutes: 60,
    retentionDays: 30,
    minRetainedPerProject: 0,
    sessionsRoot: applyRoot,
    dryRun: false
  });
  check("apply exposes a sweep handle", typeof api.sweep === "function");
  const result = await api.sweep({ now: NOW });
  check("expired session deleted", !existsSync(dirOld) && result.deleted.some((entry) => entry.id === "session-old"));
  check("projection cache record deleted", cacheDeletes.includes("session-old"));
  check("recent session kept", existsSync(dirFresh));
  check("live session kept", existsSync(dirLive));
  check("pinned session kept", existsSync(dirPin));
  check(
    "session owned elsewhere kept and reported",
    existsSync(dirOwned) && result.failed.some((entry) => entry.id === "session-owned" && entry.reason.indexOf("owned:") === 0)
  );
  check("ownership probed for candidates only", openCalls.sort().join(",") === "session-old,session-owned");
  check("freed bytes reported", result.freedBytes === 32 && result.deleted.find((entry) => entry.id === "session-old").bytes === 32);
  check("status reports the last sweep", api.status().sweeps === 1 && api.status().lastResult.at === NOW);
  check("summary logged at info", logs.some((entry) => entry[0] === "info" && entry[1].indexOf("session-reaper: scanned 5, deleted 1") === 0));

  const dryRoot = join(tmp, "dry-sessions");
  const dirDry = await seed(dryRoot, "--p--", "session-dry", 90);
  const dryCtx = makeCtx({
    sessions: { list: () => [] },
    sessionPersistence: {
      list: async () => [{ header: { id: "session-dry", createdAt: NOW - 100 * DAY_MS, cwd: "/w/p" } }],
      open: async () => ({ close: async () => {} })
    },
    get: () => undefined
  });
  const dryApi = apply(dryCtx, { enabled: true, runOnStart: false, retentionDays: 30, minRetainedPerProject: 0, sessionsRoot: dryRoot, dryRun: true });
  const dryResult = await dryApi.sweep({ now: NOW });
  check(
    "dry-run reports but does not delete",
    dryResult.deleted.some((entry) => entry.id === "session-dry" && entry.dryRun === true) && existsSync(dirDry)
  );

  const disabled = apply(makeCtx(), { enabled: false });
  check("disabled plugin schedules nothing but still exposes sweep", typeof disabled.sweep === "function");
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("all checks passed");
