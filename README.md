# dsh-plugins

自用的 DSH Web 客户端插件集合。每个子目录是一个独立、零依赖的插件包，可以直接装进 DSH profile。

## 插件

| 插件 | 版本 | 说明 |
| --- | --- | --- |
| [token-purse](./token-purse) · 鲸囊 | 0.2.0 | 把会话累计消耗的 token 折算成大致现金，挂在输入框下方的统计行上。点开有四桶明细、本会话 / 累计 / 项目三种范围，以及模型 / 峰谷 / 每日三种拆分。费率是 JSON 配置（带配置校验），按 provider/model 区分；分时方案可按平台或模型三层继承，加价与折扣两种方向都支持；币种与自动汇率、跨会话每日账本 |

## 安装

以 `token-purse` 为例：

    dsh plugin --profile web add file:/绝对路径/dsh-plugins/token-purse

再把下面这段插进 `$DSH_HOME/profiles/web/cordis.patch.yml` 的顶层数组：

    - insert:
        - id: ui-token-purse
          name: '@dsh-plugins/token-purse'

web profile 的 `patchReload` 是 live，保存后刷新页面即可。各插件的配置项、计费方式与已知限制见其自身 README。

## 目录

    dsh-plugins/
      token-purse/    TokenPurse（鲸囊）· 会话 token 折算现金

## 开发

各插件自带零依赖的构建与冒烟测试，在插件目录里跑：

    npm run build     # 由 src/client.js 生成 lib/client.js
    npm run check     # 语法检查
    npm test          # 冒烟测试

改完 `src/client.js` 记得 `npm run build`，并把 `lib/client.js` 一起提交（它就是最终产物）。

## License

MIT，见 [LICENSE](./LICENSE)。
