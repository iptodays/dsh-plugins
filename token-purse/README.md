# TokenPurse · 鲸囊

**把 DSH 会话消耗的 token，折算成看得见的大致现金。**

TokenPurse 是一个 DSH Web 客户端插件。它在输入框下方的会话统计行（轮数·步数·tok/s、token·缓存命中率）里放一枚小徽标，
显示当前会话从开始到现在累计消耗的 token 大约值多少钱；点开可以查看
输入 / 缓存命中 / 缓存写入 / 输出四个计费桶各自的用量与小计，并能在弹窗里
直接改费率。

- 英文名：TokenPurse
- 中文名：鲸囊（DSH 的品牌是一条鲸鱼，Purse 是钱袋）
- 定位：与自带的 ContextMeter（量上下文占用）并列，一个量上下文，一个量钱
- 包名：@dsh-plugins/token-purse
- 形态：纯客户端插件（主机半边为空实现）

## 界面

- 平时：底部统计行里多一枚 **≈$0.0123**，与「轮数·步数·tok/s」「token·缓存命中率」同行；**≈** 表示估算。
- 点击：下拉面板，逐桶列出 token 数与折算金额、计价模型、合计 token 数，
  以及一句免责说明。
- 面板底部 **调整费率**：用 JSON 覆盖默认费率与货币，存在浏览器本地。
- 还没有任何计费 token 时（例如刚创建的空会话），徽标不渲染，保持界面干净。

## 工作原理

1. 宿主的 token-meter 插件维护一个 **tokenUsage** 会话投影，累计整个会话日志里
   provider 上报的四个互斥计费桶：**uncachedInputTokens**、**cacheReadTokens**、
   **cacheWriteTokens**、**outputTokens**。
2. 浏览器端通过标准属性 **useProjection("tokenUsage")** 读到它。
3. 插件再用 **useProjection("modelSelection")** 拿到当前（或最近一次）的
   **provider / model**，按「provider/model 精确 → model 精确 → model 子串 →
   兜底」匹配费率；一条都没命中时显示「未配置」并按通用兜底价估算。
4. 花费 = Σ(桶 token 数 × 每百万 token 单价) × 货币换算系数；单价按**分时**
   取低峰或高峰价。
5. 全部在浏览器本地完成：配置与增量账本写在 localStorage；只有点「自动获取
   汇率」（或开启自动）时才会向公开汇率接口发一次请求，不发送任何会话数据。

实现细节：底部统计行由 @deepseek-ai/dsh-client-ui-chat 直接渲染，并不是插槽，
因此本插件把徽标 portal 进带 data-composer-stats 的那一行，与原有 pill 共用同
一个 flex 行；统计行不存在时（空会话）徽标不渲染。

## 安装

前提：已经用 **dsh web**（或桌面端）启动，profile 目录在
**$DSH_HOME/profiles/web**。

第一步，把本包装进 profile：

    dsh plugin --profile web add file:/Users/a/Desktop/dev/iptodays/dsh-plugins/token-purse

这条命令只是把参数转发给 profile 目录里的 pnpm。也可以手动执行：

    cd "$DSH_HOME/profiles/web"
    pnpm add file:/Users/a/Desktop/dev/iptodays/dsh-plugins/token-purse

第二步，把下面这段插进 **$DSH_HOME/profiles/web/cordis.patch.yml** 的顶层数组：

    - insert:
        - id: ui-token-purse
          name: '@dsh-plugins/token-purse'

第三步，保存即可。web profile 的 patchReload 是 live，改完 patch 会自动重载；
浏览器刷新一次页面，随便发一条消息，底部统计行出现 **≈$...** 就装好了。

仓库里也附带了一份现成片段：**cordis.patch.yml**。

## 费率配置

默认费率是**示例值**（美元 / 百万 token），不保证与你的账单一致——尤其是走
代理或第三方网关（例如 packyapi）时。请按实际价目校准；本插件永远只是
「约等于」，不能当账单用。

内置模型表：

    packyapi/deepseek-flash   input 0.80   cacheRead 0.016   cacheWrite 0.80   output 3.20   peakMultiplier 2
    deepseek-chat             input 0.28   cacheRead 0.028   cacheWrite 0.28   output 0.42
    deepseek-reasoner         input 0.55   cacheRead 0.14    cacheWrite 0.55   output 2.19
    deepseek-v3               input 0.27   cacheRead 0.07    cacheWrite 0.27   output 1.10
    deepseek-v3.1 / v3.2      input 0.28   cacheRead 0.028   cacheWrite 0.28   output 0.42
    deepseek-v4-pro           input 0.55   cacheRead 0.14    cacheWrite 0.55   output 2.19
    deepseek-v4-flash         input 0.28   cacheRead 0.028   cacheWrite 0.28   output 0.42

**同一个 model id 在不同 provider 价格不同**——deepseek-flash 在 packyapi 和
deepseek-official 就是两个价。所以费率 key 支持 **provider/model**：带 provider
前缀的条目只对该 provider 生效，只有模型名的条目是通用兜底。

内置里 **packyapi/deepseek-flash** 用 packyapi 价目（低峰 $0.80 / $3.20 /
缓存读取 $0.016，缓存写入表里没给、按输入计），**peakMultiplier: 2** 表示
下面分时时段内单价翻倍；其余仍是官方/示例价，按需覆盖。

面板的「计价模型」旁会标出费率来源：**专属费率**（provider/model 精确命中）、
**通用费率**（只有模型名的条目）、**按型号匹配**（子串命中）、**未配置**（兜底）。
没命中任何条目时，面板还会提示**未配置该模型的费率**并按通用兜底价估算，
不会假装准确。

两种覆盖方式：

1. **推荐**：点开徽标 → **调整费率**，编辑 JSON 后保存。配置存在浏览器
   localStorage 的 **dsh.token-purse.config.v2** 键下（自动从旧 v1 迁移）。
2. 直接改 **src/client.js** 顶部的 **DEFAULT_MODELS** / **FALLBACK_RATES**，
   然后执行 **npm run build**。

配置 JSON 的形状：

    {
      "currency": { "code": "CNY", "symbol": "¥", "perUsd": 7.2, "auto": true },
      "peak": {
        "timezone": "Asia/Shanghai",
        "windows": ["Mon-Fri 09:00-12:00", "Mon-Fri 14:00-18:00"]
      },
      "models": {
        "packyapi/deepseek-flash": { "input": 0.80, "cacheRead": 0.016, "cacheWrite": 0.80, "output": 3.20, "peakMultiplier": 2 },
        "deepseek-official/deepseek-flash": { "input": 0.28, "cacheRead": 0.028, "cacheWrite": 0.28, "output": 0.42 },
        "my-private-model": { "input": 0.1, "output": 0.2 }
      }
    }

- **currency.symbol**：显示符号，最多 4 个字符。
- **currency.perUsd**：1 美元折合多少该货币；用人民币就填汇率。
- **currency.code / currency.auto**：币种代码与自动刷新开关（面板里选币种会自动维护）。
- **peak.timezone**：IANA 时区名，如 **Asia/Shanghai**；**peak.windows** 是
  「星期 起-止」列表，支持 **Mon-Fri**、**Sat,Sun**、**\***。解析不了的项直接
  忽略，全部无效就等于不分时。
- **models**：键可以写 **provider/model**（推荐）或只写模型 id，都小写。匹配
  顺序为「provider/model 精确 → model 精确 → model 子串（取最长）→ 兜底」；
  provider 前缀的键不参与子串匹配。所以 **deepseek-v4-flash-exp** 会命中
  **deepseek-v4-flash**（没有更精确的条目时）。
- 单条费率里 **cacheRead / cacheWrite** 省略时按 **input** 计；
  **peakMultiplier** 省略或 ≤ 1 表示该模型不分时。

### 分时计价（peak）

像 packyapi 的 **deepseek-flash** 那样，工作日 **09:00–12:00**、**14:00–18:00**
（Asia/Shanghai）单价是低峰的两倍。开启方式：给模型加 **peakMultiplier**，
再在顶层 **peak.windows** 写时段。

- 时段按 **peak.timezone** 判断，与你的系统时区无关；区间是**左闭右开**
  （12:00 整已算低峰），且只在列出的星期生效。
- 面板里会显示当前是 **高峰 ×2** 还是 **低峰**，以及时段配置。
- 计费按**每一笔用量增长发生的时刻**分档：插件把会话累计量的每次增量连同
  当前时间戳存进 **dsh.token-purse.ledger.v1:会话id**，逐笔套用当时的档位，
  所以跨档会话是**分段累加**，而不是「按当前时刻一刀切」。
- 唯一的近似：插件安装前、或页面关闭期间累积的历史，账本里没有时刻，会按
  **打开面板那一刻的档位**补算。刷新页面不会清空账本（按会话 id 持久化）。

## 切换币种

点开徽标，面板下半部分是 **货币 / 汇率** 两行：

- 下拉框选常用币种（USD / CNY / EUR / GBP / JPY / HKD / TWD / KRW / SGD / INR），
  会同时带一个示例汇率；
- 右边的 **1 美元 =** 改成本地实际汇率，回车或点别处即保存。

### 自动获取汇率

- 点 **自动获取汇率**：从公开接口取当前币种的实时汇率，成功后自动写回输入框。
  主用 open.er-api.com，失败自动换 currency-api.pages.dev。
- 勾上 **自动**：打开面板时，如果距上次获取已超过 12 小时，会自动刷新一次。
- 取不到时（离线 / 被墙 / 该币种不在表里）会提示并**保留当前汇率**，不会覆盖。
- 只请求汇率，不发送任何会话数据；请求由你的浏览器直接发出。

改动即时写入浏览器 localStorage（键 **dsh.token-purse.config.v2**），徽标立刻按新
币种重算。汇率含义是 **1 美元折合多少该币种**；要任意符号或任意汇率，仍可点
**调整费率**，改 **currency.symbol** 与 **currency.perUsd**。

## 常见问题

- **徽标不出现？** 它只在会话已经产生计费 token（> 0）时渲染；空会话不显示。
  发完消息仍不显示时，看浏览器控制台有没有 slot 相关报错，并确认
  @deepseek-ai/dsh-token-meter 在配置里处于启用状态。
- **金额为 0 或明显偏小？** 多半是模型没命中费率表、走了默认费率，或该 provider
  没有上报 usage（那个投影就是空的）。
- **≈ 是什么意思？** 估算。DSH 本身不做计费，这里只是拿 token 数乘本地费率。
- **和账单对不上？** 内置只有 **packyapi/deepseek-flash** 是 packyapi 价目，其它模型仍是
  官方示例价；网关加价、缓存写入是否计费、分时时段都可能不同。点 **调整费率**
  按自己的账单校准。
- **跨高峰/低峰时段的会话怎么算？** 见「分时计价」：插件观察到的用量按发生
  时刻分档；安装前的历史按打开时的档位补算。
- **需要改宿主配置吗？** 不需要，纯客户端插件。

## 目录结构

    token-purse/
      package.json          包声明 + dsh.client 清单
      lib/index.js          主机半边（空实现，给 Loader 一行）
      lib/client.js         构建产物：浏览器半边
      src/client.js         浏览器半边源码（改这个）
      scripts/build.mjs     零依赖打包脚本
      scripts/smoke.mjs     零依赖冒烟测试
      cordis.patch.yml      安装片段
      README.md             本文
      README.en.md          English

## 开发

    npm run build     # 由 src/client.js 生成 lib/client.js
    npm run check     # 语法检查
    npm test          # 冒烟测试

改完 **src/client.js** 记得 **npm run build**。在 DSH 源码仓库里跑着
**pnpm run dev:web** 时，重写 **lib/client.js** 会触发客户端 HMR 自动重载；
否则刷新页面即可。

## 更新记录

- **0.1.0**：徽标 + 输入/缓存命中/缓存写入/输出四桶明细；币种切换与自动汇率；
  **packyapi/deepseek-flash** 分时价（**peakMultiplier** / **peak.windows**）并按
  每笔用量发生时刻分段计价；费率按 **provider/model** 区分，面板标注来源。

## 为什么能直接跑

DSH 的浏览器端用 window.__ModuleLoader__.load({ id, factory }) 登记每个客户端
插件的工厂，宿主的 dsh-client-modules 按 package.json 的 **dsh.client** 声明与
**exports["./client"]** 找到并原样提供这个文件。因此 **lib/client.js** 本身就是
最终产物，不需要 Vite / tsdown 之类的打包器；本仓库的 build 只是把它套进加载器
外壳，方便阅读与维护。

## License

MIT