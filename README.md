# dsh-plugins

自用的 DSH 插件集合（以 Web 客户端插件为主，也含纯宿主插件）。每个子目录是一个独立、零依赖的插件包。

## 插件

- **[token-purse](./token-purse) · 鲸囊** — 把会话累计消耗的 token 折算成大致现金，挂在
  输入框下方的统计行上；点开可看四桶明细，以及本会话 / 累计 / 项目三种范围下的
  模型 / 峰谷 / 每日三种拆分。
- **[session-reaper](./session-reaper) · 会话清道夫** — 纯宿主插件：定期把超过保留期的
  会话日志与投影缓存删掉，同时保护存活 / 置顶 / 白名单会话，并给每个项目保留最新的
  若干条；默认保留 30 天、每小时扫一次，支持 dry-run 预演。

界面、费率配置、已知限制、版本与更新记录都在各插件自己的 README 里，本页不复述——
免得两处一起漂移。

## 安装

各插件步骤相同，只是包名不同。下面用 `<profile>` 表示你实际在用的 profile
（Web 版是 `web`，桌面 App 是 `desktop`）。单插件的更详细说明见各自的「安装」
（[token-purse](./token-purse#安装) / [session-reaper](./session-reaper#安装)）。

```bash
# 从 GitHub 装（推荐）。仓库根不是包，path: 不能省；# 和 & 记得整体加引号，
# committish 必须是完整的 40 位 SHA（短 SHA 会被当成 ref 名而解析失败）
dsh plugin --profile <profile> add "github:iptodays/dsh-plugins#<完整 SHA>&path:token-purse"
dsh plugin --profile <profile> add "github:iptodays/dsh-plugins#<完整 SHA>&path:session-reaper"

# 改插件本身时，从本地目录装
dsh plugin --profile <profile> add file:/path/to/dsh-plugins/token-purse
dsh plugin --profile <profile> add file:/path/to/dsh-plugins/session-reaper
```

再把对应插件目录里的 **cordis.patch.yml** 内容并进
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的顶层数组。该 profile 的 patchReload
是 live，改完 patch 会自动重载：

- **token-purse**（客户端插件）：浏览器刷新一次，随便发一条消息即可看到底部统计行。
- **session-reaper**（宿主插件）：重载后开始计时（默认启动 90 秒后跑第一轮），
  第一次建议先开 `dryRun: true`，看日志确认要删的正是你以为的那些再关掉。

## 开发

各插件自带零依赖的构建与冒烟测试，在插件目录里跑：

    npm run build     # 由 src/ 生成 lib/ 产物
    npm run check     # 语法检查
    npm test          # 冒烟测试

改完 `src/` 记得 `npm run build`，并把 `lib/` 一起提交（它就是最终产物）。

## License

MIT，见 [LICENSE](./LICENSE)。
