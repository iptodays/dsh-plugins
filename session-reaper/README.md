# SessionReaper · 会话清道夫

**给 DSH 的会话日志补上一个回收站。**

DSH 会把每个会话的事件日志永久留在 `$DSH_HOME/sessions/` 下：一个项目一个目录，一个会话一个子目录，里面是 `session.vN.jsonl.zstd` 和 `session.lock`。持久化服务只提供读 / 追加 / 关闭，**没有删除与保留期 API**——上游文档的 Known Limitations 原话是 `No deletion or retention API — pruning stored sessions is out-of-band backend maintenance.` 用久了它就是几十上百个永远不会自己消失的目录（我这台机器上现在 48 个会话、86.6 MB）。

SessionReaper 补上这件 out-of-band 维护：定期把所有会话扫一遍，把超过保留期、又不在任何保护名单里的删掉，并顺手清掉对应的投影缓存记录。

- 英文名：SessionReaper
- 中文名：会话清道夫
- 包名：`@dsh-plugins/session-reaper`
- 形态：纯宿主插件（没有浏览器半边）
- 依赖：零第三方依赖，只用 node: 内置模块
- 默认：保留 30 天、每 60 分钟扫一次、每个项目至少留最新 2 个

## 它怎么判断「过期」

一个会话的**最后活动时间**取两个值的较大者：

1. `ctx.sessionPersistence.list()` 返回的 header.createdAt（会话创建时间）；
2. 会话目录里所有文件的最新 mtime——日志是追加 + fsync 写的，所以文件 mtime 就是「最后一次落盘」的可靠近似。

`now - 最后活动时间 > retentionDays 天` 才算过期。归档会话（workspace 的 archivedSessionIds）可以用更短的 archivedRetentionDays。

注意：**不是按创建时间算**。一个创建于 100 天前、但今天还在用的会话不会被删；反过来，一个再没打开过的会话，从它最后一次写盘那天开始计时。

## 它绝不会删的东西

按优先级从高到低：

- **磁盘上没有目录的会话**（刚 create、还没落盘的）——本来就没东西可删；
- **存活会话**：`ctx.sessions.list()` 里的，以及当前进程 `DSH_SESSION_ID` 指向的；
- **置顶会话**：workspace 的 pinnedSessionIds；
- **白名单**：protect 里任一规则命中 id 或 cwd 的；
- **子代理会话**（当 `includeSubagentSessions: false`）；
- **每个项目最新的 minRetainedPerProject 个**（默认 2）——防止某个项目的历史被一次清空；
- **写锁被别处持有的会话**：删除前用 `sessionPersistence.open(id, 'write')` 探一次；另一个 DSH 实例正在写、或本进程里还有写句柄时，open 会抛 `SessionAlreadyOwnedError`，这一条直接跳过并记一条 warn。

## 一轮清扫做什么

1. 调 `ctx.sessionPersistence.list()` 拿到全部可见会话的 header；
2. 扫 `sessionsRoot`（默认 `$DSH_HOME/sessions`）重建 `id -> 目录`，统计字节数与最新 mtime；
3. 套上上面的保护规则，算出 candidates；按最旧优先排序，单轮最多 `maxDeletesPerSweep` 个，多出来的留到下一轮；
4. 逐条探写锁，通过就 `rm` 掉整个会话目录；
5. 删掉 `session_projcache` 域里对应的投影缓存记录——否则侧栏会留下指向已删日志的幽灵条目。

删了多少、回收了多少字节会打一行 info 日志；没有任何动作时降到 debug，避免每小时刷屏。

## 配置

```yaml
- insert:
    - id: session-reaper
      name: '@dsh-plugins/session-reaper'
      config:
        retentionDays: 30
        sweepIntervalMinutes: 60
        protect:
          - 'session-keep-*'
          - /Users/you/Desktop/dev/important
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后只注册句柄，不排任何定时任务 |
| `retentionDays` | `30` | 保留期（天）。`0` 表示「除保护名单外全过期」，适合先配白名单再清场 |
| `archivedRetentionDays` | `null` | 归档会话的保留期；`null` 表示跟 `retentionDays` 一样 |
| `sweepIntervalMinutes` | `60` | 清扫间隔（分钟），最小 1 |
| `startDelaySeconds` | `90` | 启动后第一次清扫的延迟（秒），避开开机高峰 |
| `runOnStart` | `true` | 是否在启动后跑一次 |
| `dryRun` | `false` | 只算不删，把计划打进日志。**第一次用建议先开** |
| `verifyOwnership` | `true` | 删除前探测写锁；关掉更快，但可能删掉别处正在写的会话 |
| `maxDeletesPerSweep` | `200` | 单轮删除上限；`0` 表示不限 |
| `minRetainedPerProject` | `2` | 每个项目至少保留的最新会话数 |
| `includeSubagentSessions` | `true` | 是否把子代理会话也算进清理范围 |
| `deleteProjectionCache` | `true` | 删日志时是否顺带删投影缓存记录 |
| `sessionsRoot` | `null` | 会话根目录；`null` 表示 `$DSH_HOME/sessions` |
| `protect` | `[]` | 保护规则列表：不含 `*` / `?` 的按子串匹配，含的按通配符整串匹配；id 与 cwd 都会看 |

配置在装载期校验：类型不对、越界都会让插件装载失败并报出字段名，而不是带着半吊子配置去删数据。

## 安全边界（先说清楚）

- 这是 out-of-band 删除，不是后端提供的删除 API。删除动作与其它进程 / 读句柄之间没有原子性保证：写锁探测把竞争窗口压到「close 到 rm」之间的一瞬，但不能完全消除。
- 只认普通目录；符号链接既不会当作项目目录也不会当作会话目录，所以不会顺着链接删到 `sessionsRoot` 之外。
- 只处理 `sessionPersistence.list()` 能列出来的会话；列不出来的（例如当前版本解释不了的格式）一律不动。
- **不清理附件**：图片等附件是内容寻址、跨会话共享的，删会话不会回收它们。
- **不清理 workspace 归档列表**：删掉的归档会话 id 会留在 archivedSessionIds 里，成为无害的悬空 id。
- 如果你把 `session-query-sqlite` 的 `openAt` 开成持久索引，删日志不会同步删索引，搜索结果里可能出现幽灵条目。默认配置（`openAt: never`、`:memory:`）没有这个问题。

## 安装

```bash
# 从 GitHub 装（推荐）。仓库根不是包，path: 不能省；# 和 & 记得整体加引号，
# committish 必须是完整的 40 位 SHA（短 SHA 会被当成 ref 名而解析失败）
dsh plugin --profile web add 'github:iptodays/dsh-plugins#<完整 SHA>&path:session-reaper'

# 改这个插件本身时，从本地目录装
dsh plugin --profile web add file:/path/to/dsh-plugins/session-reaper
```

把插件目录里的 **cordis.patch.yml** 内容并进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的顶层数组。该 profile 的 patchReload 是 live，改完 patch 会自动重载。上面的 `--profile web` 换成你实际在用的 profile（桌面 App 用的是 `desktop`）。

第一次装好建议先把 `dryRun: true`，等一轮日志确认要删的正是你以为的那些，再改回 `false`。

## 目录结构

```text
session-reaper/
  src/core.js        纯逻辑：配置、路径编解码、扫描、清理计划（零依赖，可单测）
  src/index.js       Cordis 宿主插件：定时器、写锁探测、rm、缓存清理
  lib/               build 产物（Loader 实际 import 的入口）
  scripts/build.mjs  把 src/*.js 复制进 lib/
  scripts/smoke.mjs  零依赖冒烟测试
  cordis.patch.yml   安装片段
```

## 开发

```bash
npm run build   # src/*.js -> lib/*.js
npm run check   # node --check 所有源文件与产物
npm test        # 冒烟测试（自建临时目录，不碰真实 ~/.dsh）
```

改完 `src/` 记得 `npm run build`，并把 `lib/` 一起提交——它就是最终产物。

## 常见问题

- **会不会误删我正在用的会话？** 不会。存活会话、置顶会话、白名单、每个项目最新的 N 个都在保护名单里；删除前还会用写锁探一次别的进程/句柄。
- **日志删了，侧栏为什么偶尔还闪一下旧条目？** 插件会同步删投影缓存；万一没删到（域没挂载），下次列表读取会把它当冷会话跳过。
- **磁盘空间没立刻降下来？** `rm` 后空间由文件系统异步回收；用 `du -sh $DSH_HOME/sessions` 复查即可，不必重装或重启。
- **只想清某个项目？** 用 protect 反向保护其余项目，或把 `sessionsRoot` 指向一份拷贝、先 `dryRun` 预演。
- **附件会一起删吗？** 不会，见上面「安全边界」。

## 为什么能直接跑

SessionReaper 不 import 任何第三方包：配置校验是把 Standard Schema v1 手写成一个适配器，路径编码复刻自 JSONL 后端，服务通过 Cordis 的 `inject` 取得。所以 `npm test` 在一个没有任何 `node_modules` 的插件目录里也能直接跑。

## 更新记录

### 0.1.0

- 首个版本：定时清扫、保留期（含归档覆盖）、存活 / 置顶 / 白名单 / 项目保底保护、写锁探测、dry-run、投影缓存同步清理。

## License

MIT，见 [LICENSE](./LICENSE)。
