# dsh-plugins

自用的 DSH Web 客户端插件集合。每个子目录是一个独立、零依赖的插件包。

## 插件

- **[token-purse](./token-purse) · 鲸囊** — 把会话累计消耗的 token 折算成大致现金，挂在
  输入框下方的统计行上；点开可看四桶明细，以及本会话 / 累计 / 项目三种范围下的
  模型 / 峰谷 / 每日三种拆分。

界面、费率配置、已知限制、版本与更新记录都在各插件自己的 README 里，本页不复述——
免得两处一起漂移。

## 安装

完整说明见 [token-purse 的「安装」](./token-purse#安装)。摘要：

    # 从 GitHub 装（推荐）。仓库根不是包，path: 不能省；# 和 & 记得整体加引号，
    # committish 必须是完整的 40 位 SHA（短 SHA 会被当成 ref 名而解析失败）
    dsh plugin --profile web add "github:iptodays/dsh-plugins#<完整 SHA>&path:token-purse"

    # 改这个插件本身时，从本地目录装
    dsh plugin --profile web add file:/path/to/dsh-plugins/token-purse

再把插件目录里的 **cordis.patch.yml** 内容并进
`$DSH_HOME/profiles/web/cordis.patch.yml` 的顶层数组。该 profile 的 patchReload 是
live，改完 patch 会自动重载；浏览器刷新一次，随便发一条消息即可看到底部统计行。

## 开发

各插件自带零依赖的构建与冒烟测试，在插件目录里跑：

    npm run build     # 由 src/client.js 生成 lib/client.js
    npm run check     # 语法检查
    npm test          # 冒烟测试

改完 `src/client.js` 记得 `npm run build`，并把 `lib/client.js` 一起提交（它就是最终产物）。

## License

MIT，见 [LICENSE](./LICENSE)。
