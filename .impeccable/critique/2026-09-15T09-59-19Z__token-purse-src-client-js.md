---
target: 当前的布局合理吗? (token-purse panel layout)
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/Users/a/Desktop/dev/iptodays/dsh-plugins/token-purse/src/client.js"
target_fingerprint: "sha256:b2b91c83ac2906cdf463fe3b17c032d3e92cc73fb57bf7c31fcae4bdb7fc1d9b"
target_path: /Users/a/Desktop/dev/iptodays/dsh-plugins/token-purse/src/client.js
timestamp: 2026-09-15T09-59-19Z
slug: token-purse-src-client-js
---
# TokenPurse 面板 — 设计评审（impeccable critique）

Target: token-purse/src/client.js · slug: token-purse-src-client-js · Date: 2025

## Design Specificity Verdict

**产品专属的数据模型，品类通用的构图。**

信息架构无疑属于 TokenPurse：四个互斥的 DeepSeek 计费桶（输入 / 缓存命中 / 缓存写入 / 输出）、由
peakMultiplier 对照 Asia/Shanghai 窗口解出的 高峰/低峰 ×2、以及从 dsh.token-purse.daily.v1 联合出来的
「项目 → 会话」账本，都不是通用计量组件会知道的东西。按 provider/model 索引的 JSON 费率表是真正的
定制逃生口。

但**表面**是可以互换的。去掉文案，面板就是：标题 + 右对齐大数字 + 两条一模一样的分段控件 + 一个
label/value 的 dl + 三段灰色 11px 说明文字 + 一个文字按钮。一切都继承 --dsw-* 别名，所以它读起来像
「又一个 DSH 设置弹层」，而不是一件**钱的仪器**。**鲸囊——产品真正的名字与唯一的隐喻——在渲染结果里
从不出现**；标题是 panel.title =「Token 花费」。没有任何货币符号系统：总额没有颜色/字形/标记，四个桶在
dl 里视觉上完全相同，唯一有辨识度的字形是 10px 的 谷 / 峰×2 chip。shareFill 是单一灰色条，桶与模型的
身份完全靠读文字。

判定：**内容为本产品而作，视觉语言不是。**

## Height & Density Evidence

两份评估独立测量（渲染 TokenPurseView，按 CSS_TEXT 的行高/边距逐块求和）。夹具与度量模型不同，
所以给区间而不是单值：

| 状态 | A 估高 | B 估高 | 结论 |
|---|---|---|---|
| 本会话 · 模型 | 438px | 463px | 固定装饰约 258–390px，模型明细只占 64px（约 15%） |
| 累计 · 项目（全折叠） | 454px | 383px | 装饰占绝对多数；仅 scope.coverage 就 42px |
| 累计 · 项目（展开 1 个项目） | 539px（4 会话） | 451px（3 会话） | 每个会话恰好 +17px；10 个会话约 641px，40 个约 1151px |
| 累计 · 每日（折线 + 7 天） | 570px | 499px | 390/570 = 68% 是固定装饰；数据只有 180px |

两点由此确凿：README:67 写的「典型状态下面板约 260–310px 高」只对最稀疏的会话成立（2 个桶、无峰谷
说明），**上面每一个有数据的状态都是它的 1.4–1.8 倍**；而且 .TPurse_panel **没有 max-height、没有
overflow**（全文件 max-height 出现 0 次；带 overflow 的只有 modelValue/breakLabel/share/spark/tab，
全是横向或文本溢出），面板又是 position:absolute; bottom:calc(100% + 8px) ——**锚定在底部、向上生长**，
所以列表没有上限，标题与首行会先跑出屏幕。

## Nielsen Heuristic Scores

| # | 启发式 | 分 | 关键问题 |
|---|---|---|---|
| 1 | 系统状态可见性 | 3 | 触发器带金额 + aria-expanded + 当前 谷/峰×2；汇率有「获取中…」；JSON 有报错。但**保存设置没有任何确认**，编辑器直接消失，唯一反馈是顶部数字变了。 |
| 2 | 贴合现实世界 | 3 | 高峰/低峰、缓存写入、合计 tokens 与 DeepSeek 口径一致；峰谷窗口永远带时区写出来。计价模型 + 「专属费率/通用费率/按型号匹配/未配置」是需要用户自行解码的内部术语。 |
| 3 | 用户控制与自由 | 2 | 范围可点、Escape 可关（退出动画期间再点还能取消）。但 editing **没有取消/关闭**——只有「恢复默认」（立即、破坏性）和「保存」，一旦按下调整费率，不保存或不清空就回不去。恢复默认还无二次确认。 |
| 4 | 一致性与标准 | 2 | 两条**视觉完全相同**的分段条代表两个不同维度（范围 / 视角），上下相邻。都是 role=tablist，但只有第一条有 aria-label；都没有 tabpanel。.TPurse_dayRow 声明了 transition:color 却没有任何 hover 规则。 |
| 5 | 错误预防 | 2 | 费率编辑器是 148px 的裸 JSON textarea，唯一防线是保存时的 JSON.parse。perUsd 接受任意数值，≤0 时静默退化成 1。切币种会立刻发网络请求。恢复默认无确认。 |
| 6 | 识别而非回忆 | 2 | 峰谷窗口有写出来，但**每日页签完全无视范围控件**，而标题仍显示 scopeTotal——用户必须记得 README:64 才知道面板两半是两个宇宙。桶的定义面板里没有。 |
| 7 | 灵活与高效 | 2 | 折线支持 ←/→（好），但页签没有方向键导航，没有快捷键打开面板，除了内部 PROJECT_CLOSED 哨兵没有「全部折叠」，不能复制总额，改费率只有 JSON 一条路。 |
| 8 | 美学与极简 | 2 | 颜色克制，但**文字不极简**：scope.coverage（42px）+ 峰谷说明（37px）+ panel.note（26px）= 105px 灰色散文，围绕在四到十一个数字旁边。 |
| 9 | 错误识别与恢复 | 2 | 汇率失败处理得好（「获取失败，已保留当前汇率」），未配置费率会点名模型并指向修复处。JSON 报错是一句无行号无位置的通用话。 |
| 10 | 帮助与文档 | 2 | rates.hint 解释了 JSON 形状，页签和模型值有 title。面板里没有指向 README 的链接，没有解释缓存写入是什么、为什么可能是 0，panel.note 是免责声明而不是帮助。 |
| | **合计** | **22 / 40** | 诚实的中间带：称职、观感一致，但带着可避免的歧义、一个关不掉的编辑器，以及 105px 散文在干三个短标签的活。 |

## Priority Issues

**[P0] 三个主题 token 根本不存在，其中之一把折线段画成了黑色。**
- Why：DSH 主题包只定义 357 个 token。--dsw-alias-fill-l2、--dsw-font-mono、--dsw-static-yellow-500
  **都不在其中**（整个 node_modules 里 0 处定义；两个 app CSS 里也没有）。fill-l2 用了 9 次，其中 4 处
  **没有 fallback**：share 轨道、tabs 背景、spark 面积、spark 圆点外圈。
  在 background 位置，未定义 var() → 声明失效 → 透明（可容忍；上游 dsh-client-ui-jobs 的 _kind 徽章
  也这么用）。但在 **fill 位置**，fill 是可继承属性 → 失效后取继承值 → 最终是**黑色**，所以「每日」
  页签的折线面积会渲染成一块黑色楔形。这条不是审美问题。
- Fix：把 .TPurse_sparkArea 改成不等 token 的画法——fill:currentColor + fill-opacity:.14（或
  fill:var(--dsw-alias-label-secondary);fill-opacity:.14）。给另外 3 处补 fallback：
  share 用 var(--dsw-alias-fill-l2, var(--dsw-static-neutral-200))，tabs 用
  var(--dsw-alias-fill-l2, transparent)，圆点外圈同理。--dsw-font-mono 换成真实存在的
  --dsw-font-markdown-code-font-family；--dsw-static-yellow-500 三处 fallback #d97706 在浅色主题只有
  3.19:1，改用真实 token（--dsw-static-amber-500 存在）。注意 fill-l2 / font-mono 上游也在引用，
  是 DSH 的既存空档，但只有 fill 位置会响亮地坏掉。
- Command: $impeccable harden

**[P1] 没有纵向上限，列表无界。**
- Why：.TPurse_panel 无 max-height / overflow，且底部锚定向上生长。实测状态已经 499–570px；20 个项目
  约 990px，展开一个 40 会话的项目再加约 697px，标题与首行跑到屏幕外不可达。Riley 第一台真机就会撞上。
- Fix：封住滚动区而不是整个面板——.TPurse_tabBody{max-height:320px;overflow-y:auto;
  overscroll-behavior:contain}，让标题/范围/dl/说明保持钉住；再加 .TPurse_panel{max-height:min(72vh,600px);
  overflow-y:auto} 作兜底。若整面板滚动，则 .TPurse_head{position:sticky;top:0;background:var(--dsw-specific-menu)}。
  同时给 allTime.projects.map 与 item.sessions.map 加「显示全部」上限。
- Command: $impeccable harden

**[P1] 范围控件与「每日」页签自相矛盾。**（已机械验证）
- Why：dailyStats 按设计就是全局的（README:64），但「每日」活在范围 tablist 里面，而标题仍显示 scopeTotal。
  实测：本会话档切到每日，标题 ≈¥0.80，下面两行是 ¥4.40 与 ¥1.00（全局）。默认路径上大数字与它下面的行
  属于两个宇宙且永不和解——这是本界面最大的信任缺陷。
- Fix：在 shownTab === "daily" 分支里，要么（a）隐藏/禁用范围条并把 daily.hint 作为 sectionHead 渲染，
  要么（b）保留 scope 但让标题显示当前可见页签自己的合计并追加「（全量）」限定。绝不要留一个静默无效的控件。
- Command: $impeccable clarify

**[P1] 可访问性：对比度、tab 模式、焦点、点击目标。**
- Why（B 从主题 token 直接算出，因无浏览器实测）：
  · --dsw-alias-label-tertiary（浅色 #81858c）在面板底色上 = **3.71:1，AA 不达标**，而它在 **22 处**
    用作 10–11px 正文/元信息；.TPurse_error（#ef4444）浅色 3.76 / 深色 3.21 不达标；
    .TPurse_modeChipOn（#d97706）浅色 3.19 / 深色 3.80 不达标。
  · 第二条 role=tablist（JSX 1716）**没有 aria-label**；role=tab 没有 aria-controls，页签体没有
    role=tabpanel/aria-labelledby，没有 roving tabindex 与方向键——ARIA tabs 模式只做了一半。
  · 折线 SVG 是 tabIndex:0 + 方向键，但**没有任何 focus 样式**，键盘焦点看不见；读数气泡只是普通 span，
    没有 aria-live / aria-valuetext，方向键移动的是 Sam 感知不到的像素。
  · 点击目标 <24×24（WCAG 2.2 2.5.8）约 7 处：页签 22px、项目/每日行 17px、editButton 约 13px、
    fxButton 约 19px、select/input 约 20px、复选框约 16px、折线 hover 格约 9.9px 宽。
  · 币种 select（JSX 1966）无可访问名，可见标签未关联（邻近的 number input 与 textarea 反而有 aria-label，
    属于不一致）。
- Fix：把 22 处 11px 元信息从 label-tertiary 提到 label-secondary；给第二条 tablist 加 aria-label、
  给身体加 role=tabpanel + aria-labelledby 并实现方向键；给 .TPurse_spark:focus-visible 加可见轮廓；
  折线读数加 role=status 或 aria-live=polite；把行按钮与页签的垂直 padding 提到 24px；给 select 加
  aria-labelledby 指向它的 fieldLabel。
- Command: $impeccable audit

**[P2] 重量放错了地方：散文挤掉数字，而唯一让数字正确的控件是最难退出的一块 JSON。**
- Why：在最高状态里 390/570px 是固定装饰，其中 105px 是三段灰色散文；本会话·模型档里真正的模型明细
  只占 15%。用户点开一个「钱」的徽标，拿到的说明文字比数字多。同时费率编辑器是裸 JSON textarea：
  JSON.parse 只回一句无行号的错，perUsd 静默退化，且**没有取消**，只有破坏性的恢复默认。
- Fix：把 scope.coverage 从 296px 宽的 note 降级为贴在总额下方的 10px 注脚（它限定的就是那个数字）；
  峰谷说明缩到 chip + title（窗口已经在触发器的 tooltip 里），或移进「峰谷」页签；panel.note 降为合计行的
  title。目标每个状态减 100–130px。费率编辑器改成复用现有 .TPurse_fields 两列栅格的按模型费率表
  （provider/model、input、cacheRead、cacheWrite、output、币种），把 textarea 降级为「高级 JSON」折叠项；
  加一个 .TPurse_ghost 取消按钮；perUsd 内联校验（min、非零）；恢复默认加二次确认。
- Command: $impeccable quieter

## Persona Red Flags

**Alex（ impatient power user ）**
- 想回答「今天花了多少」，他要：点徽标 → 点累计 → 点**第四个**页签（TABS 顺序 项目/模型/峰谷/每日）
  → 读一个 570px 的面板。三次交互换一个数字。
- 快捷路径（本会话 + 每日）上标题 ≈scopeTotal 与全局日行互不相等，没有任何东西纠正他，所以他要么误读
  总额，要么停止信任它。
- 范围条对「每日」是死控件，所以他「范围会过滤这个面板」的心智模型是**错的**，界面从不说明。
- 这一切都无法设成默认：tab/scope 在视图重挂载（会话 key 变化）时重置为 TABS[0]/SCOPES[0]，偏好不持久化。

**Sam（ accessibility-dependent, keyboard / screen reader ）**
- 第二条 tablist 没有 aria-label、没有 aria-controls，页签体没有 role=tabpanel（JSX 1716–1737）；
  只有第一条范围 tablist 有 label。两条都没有 roving tabindex 或方向键，所以 Sam 必须 Tab 穿过每个分段。
- 折线的键盘读数只作用于视觉：onSparkKey 改 sparkHover，渲染出的 .TPurse_sparkTip 是普通 span，
  没有 aria-live / role=status / aria-valuetext，role=img 的 svg 标签是静态的。方向键移动的像素 Sam 看不到。
- title 是页签用途（1728）、项目完整路径（1756）、被截断模型名的**唯一**提示，对读屏不可靠、触摸不可达。
- 对比度：.TPurse_tokens/.TPurse_note/.TPurse_peakNote/.TPurse_breakTokens/.TPurse_dayRow/.TPurse_editButton
  全部是最低层级别名上的 11px 文本。
- 打开面板后焦点仍留在触发器上；role=dialog 有 aria-label 但没有 aria-labelledby、没有焦点转移。
  Escape 处理是明确做对的一处。

**Riley（ deliberate stress tester ）**
- 列表无界：projects.map（1741）与 sessions.map（1776）渲染每一项，面板又没有 max-height。
- 币种 select 10 个预设 + 自定义；非常用币种只能去改裸 JSON 里的 currency.symbol / perUsd。
- mergeConfig 跑在裸 JSON.parse 之后，未知键静默合并；parsePeak/normalizeLedger 静默修数据，把写错的
  peakMultiplier 藏起来而不是暴露出来。
- perUsd 是 type=number + step=0.01，接受 -、0、科学计数法；toNumber 随后替换成 1，所以压力测试者可以
  在零报错的情况下把整个面板的意义清零。

## Minor Observations

- 覆盖说明渲染在峰谷说明**上面**（JSX 1702 先于 1703），与文档顺序相反（已用 vm 渲染确认）。数据完整性
  的告示坐在「当前计费」之上。
- .TPurse_modelValue 强制 mono + 11px（166）：对 provider/model 正确，对累计档的散文摘要
  「2 天 · 3 个会话 · 3 个模型」错误。
- .TPurse_dayRow（235）声明 transition:color .12s 但没有任何 :hover/:focus-visible 改色，过渡永不触发；
  可点的项目/每日行只有 cursor:pointer。
- 面板头从不出现鲸囊 / TokenPurse，而是 panel.title。
- .TPurse_modeChip 是 10px/14px，全界面最小的字，却承载 ×2 计价这个事实。
- sharePercent 的 2% 下限是好细节，但所有 shareFill 都用 label-tertiary，所以条只编码大小、从不编码类别。
- scope.coverage 只在一个会话时也渲染，纯噪音。
- ≈ 是 aria-hidden 而可访问名已含「约」，正确，值得保留。
- 每日列表封顶 7 行（DAILY_VIEW_DAYS）而折线覆盖 30 天，两个周期相邻但从未标注是不同的窗口。
- 检测器在 src、lib、整个包目录、以及抽出的 CSS 上都是 **0 findings / exit 0**，且用故意写坏的夹具
  （font-family:Inter + bounce cubic-bezier）验证过它确实会开火（2 条规则）——所以那是真的「没有文本级
  反模式」，不是解析失败。但它在非 HTML 模式只做正则匹配：**看不到对比度、目标尺寸、ARIA、布局**。
  干净的检测结果不能当成健康证明。
- i18n 干净：zh 64 / en 64 键，0 缺失，0 占位符不匹配。
- prefers-reduced-motion 的媒体查询覆盖了全部 8 个动画用户，但 **7 个 transition 未关闭**，其中
  chevron 180° 旋转（159）是真实的动态；README 声称「所有动画自动关闭」，严格说不成立。

## Questions to Consider

1. 如果「累计」永远只能看到插件自己观察过的会话，它是在回答一个真问题，还是一个永远被低估的数字？
   把它标成「已观察 / since {date}」会不会比绝对的「累计」更诚实、也更可信？
2. 「每日」按设计是全局的，那它为什么活在一个无法影响它的范围控件里？把范围与视角合成一条轴
   （本会话 / 累计 / 每日，并给全局项打标）会不会一次性消掉 36px 和最大的歧义？
3. 峰谷策略要花一个常驻 37px 说明块加触发器上 10px 的 chip。既然 chip 已经报告了当前档位，
   面板里那句说明提供了峰谷页签给不了的东西吗？
4. 费率编辑该住在一个盖在输入框上方、320px 宽的弹层里吗？还是该住在 DSH 设置里？为什么让唯一决定
   所有数字对错的输入用手写 JSON 来改？
5. 面板花 499–570px 呈现 4–11 个数字，其中最高状态 68% 不是数据。如果核心问题只是「这次花了多少」，
   要怎样才做出一个约 120px、永远可见的答案，其余全部收在一次刻意的点击之后？
6. 产品的名字（鲸囊）与隐喻在界面里从不出现——这是有意的克制，还是漏掉了？
