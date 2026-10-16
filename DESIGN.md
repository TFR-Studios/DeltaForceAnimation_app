# Design

<!-- impeccable:design-schema 1 -->
<!-- 这份文件记录“当前已经在生产里跑的视觉系统”,不是愿望清单。
     改配色或改组件前先读它,改完同步更新;它由 src/style.css 与
     src/ui-theme.ts / src/ui-upgrade.ts 的实际实现决定。 -->

## Design Read

Reading this as: **桌面级动画编辑器(Operate 模式)** 面向需要把游戏动画改成成片的中文社区作者,
用一套 **克制的中性灰 + 单一交互色** 语言,基础是 **Microsoft Fluent UI Web Components**
(@fluentui/web-components)承载控件、自维护的 CSS 令牌层承载颜色与版式。

三个刻度:DESIGN_VARIANCE 3(工具界面,一致性优先)/ MOTION_INTENSITY 2(只留状态反馈)/ VISUAL_DENSITY 6(检查器很密,但不堆卡片)。

## Theme

两套主题,同一套令牌名,只换值。由 <html data-theme> 切换,选择存 localStorage 的 dfae.ui.theme.v1,
首屏由 index.html 的内联脚本提前落主题(避免先亮一下深色再切)。

| 令牌 | 深色(默认) | 浅色 |
|---|---|---|
| --bg 页面底 | **#242424** | #eaeaf0 |
| --bg-deep 画布底 | #1a1a1b | #dcdce4 |
| --surface 面板 | #2b2b2d | #ffffff |
| --surface-2 抬升面/控件底 | #333334 | #f7f7fa |
| --surface-3 内嵌面 | #3e3e42 | #e4e4ec |
| --text 主文字 | **#f2f2f4** | **#242424** |
| --text-2 次要文字 | #c3c3c9 | #4b4b52 |
| --text-3 三级文字 | #9b9ba3 | #5f5f68 |
| --line / --line-strong | #3e3e42 / #4c4c50 | #c6c6d0 / #b4b4c0 |
| --brand 交互色 | #c9c9d1 | #5c5c63 |
| --on-brand 品牌面文字 | #1a1a1c | #ffffff |
| --danger / --warn / --ok | #ff99a4 / #f9d67a / #54d6a4 | #a4262c / #8a5a00 / #0b6a45 |

锚点色(用户指定)#f2f2f4 与 #242424 是整套灰阶的两端:其余中性色都是它们的派生值,不做第二族中性色。
交互色是**中性灰**而不是彩色 —— 界面里出现的彩色只留给状态语义(danger / warn / ok),
这样“当前选中”和“出错了”不会互相抢注意力。

**浅色的四层面**:页面底 #eaeaf0 → 面板 #ffffff → 卡片/控件 #f7f7fa → 内嵌槽 #e4e4ec,
相邻层对比度 1.15-1.25。这个差值是刻意放大的:同样的明度差在浅底上会被高亮度吃掉,
按深色主题的 1.10 来取会让侧栏糊在页面上(实测过一次,所以写在这里当反例)。

对比度:最低正文 4.57:1,全部 >=4.5:1(WCAG AA)。可用 node tools/contrast.mjs 复核。

## Type

**字体是自托管的产品字体**(与动画渲染用的那两份同源,另存到 public/fonts 供界面使用):

| 角色 | 字体 | 字重 | 字号 |
|---|---|---|---|
| 正文与控件 | ProjectD Type | 500 | 13-14px |
| 标题 / 强调 | ProjectD Type Curve | 700 | 13-17px |
| 唯一大数(导出百分比) | ProjectD Type Curve | 700 | 34px / -0.02em |
| 快捷键 / 路径 | ui-monospace | 400 | 11-12px |

- 只提供 500 与 700 两个字重,所以 body 的默认字重写 500(写 400 会触发浏览器减重合成,笔画发虚)。
- 覆盖约 6.7k 个常用简体字形,生僻字回退系统字体,font-family 末尾保留 "Microsoft YaHei" / "PingFang SC"。
- font-display: swap:离线或字体未到位时先用系统字体渲染,不会出现空白文字。
- 数值列仍一律 font-variant-numeric: tabular-nums。

## Color roles

- --brand 只用于:主操作(导出)、当前选中(画廊卡片、开关打开)、主题开关的选中段。
- --danger 只用于状态栏报错与导出失败;--warn 只用于“需要处理”的提示与告警徽标;--ok 只用于导出成功。
- 面板/卡片之间用 1px --line 描边而不是卡片阴影;阴影只给真正浮起来的浮层(--shadow-2/3)。

## Components

### 5.1 Fluent UI Web Components(骨架控件)

src/ui-upgrade.ts 在 **main.ts 的模块体之前**(顶层 await customElements.whenDefined(...))
把 index.html 骨架里的原生控件就地升级:

- 所有 button -> fluent-button(只换标签名,id/class/子节点/行内样式原样保留,事件绑定不受影响);
- data-df-switch 标记的勾选控件 -> fluent-switch(循环、透明背景、二次扫描、报酬显隐、显示弹窗、显示图标、跟随图标)。

**刻意不升级**:运行期由 main.ts 生成的动态行(下载列表行、预设项、图层重置按钮、画廊卡片)
保持原生元素 —— 它们是列表项而不是产品级控件,且每次 innerHTML 重建后再逐个替换会拖慢交互。
这条边界写在 ui-upgrade.ts 的注释里。

颜色桥接:style.css 定义了一整层 --colorNeutral* / --colorBrand* / --colorStroke*
(名字取自 @fluentui/tokens,不引入它的 lightTheme/darkTheme —— 那套值会把界面染成
另外一族暖灰)。所以 Fluent 组件自动跟随本产品的主题,不需要逐个覆盖样式。

**最小尺寸必须清零(2026-10 修)**:Fluent 按钮的 :host 上有 `min-width: 96px` 与 `min-height: 32px`,
会静默顶掉按 width/height 写的小控件。实测到的后果:画廊 / 下载列表的关闭按钮被撑成 96×32 的
扁方块;搜索框里的清空按钮被撑成 96px 宽,把 220px 的搜索框挤到 290px(输入区只剩 150px),
而且那 96px 全是可以触发"清空"的命中区;导出浮层的三个动作按钮因为样式写在 `button` 元素选择器上,
升级成 <fluent-button> 后整圈样式落空 —— 直角、无边框、"保存到手机"看起来和次级按钮一模一样。
现在的做法:style.css 里一条 `fluent-button, fluent-toggle-button { min-width: 0 }` 统一清零
(外层文档规则优先级高于 :host),`.ap-search-clear` 再单独压掉 min-height,
所有涉及按钮的选择器一律写 `:is(button, fluent-button)`。

### 5.2 顶栏主题开关(自己的分段控件)

形态:**胶囊外壳 68x32 + 两个图标按钮(29x24)+ 一枚滑动指示器**。
太阳 = 描边几何(stroke 1.25 / fill:none),月亮 = 实心新月;两者同 15px 盒、同 --text-3 静息色,
选中态图标反白在 --brand 实心指示器上。当前主题由 指示器位置 + 图标颜色 + aria-pressed 三重表达。

**为什么不用 Fluent 按钮**:Fluent 按钮 min-width 96px 且盒模型画在宿主上,
两个并排会得到 97x38 的笨重方块(顶栏里其它控件都是 32px 高)。
分段控件这种“外壳 + 滑动指示器”的形态组件库并不提供,自绘是正确的选择;
Fluent 的设计语言(实心指示器、圆角、焦点环、aria 状态)被完整保留。

### 5.3 顶栏空间分配

一行等高工具条,高度统一 --topbar-control-h = 32px(徽标 26px 居中):

- 左侧组:品牌 + 制作声明徽标;
- 右侧组:动画选择器(容器 max-width 520px,靠右)+ 下载入口 + 主题开关。
- 中间由 .anim-switch 的 margin-left:auto 吸收全部剩余宽度 —— **不许出现死区**。

动画触发器在一行里表达四件事:缩略图(30x22)、动画名、总数徽标(与名称同行)、规格行。
<=1180px 收起规格行,<=720px 再收起总数徽标,按钮高度全程保持 32px(所以顶栏不会跳)。

### 5.4 自绘的原生控件(滑杆 / 下拉)

整屏只有这两类控件原来还是浏览器默认外观,而滑杆正好是本应用被用得最多的控件(时间轴):

- **滑杆**:`appearance:none`,轨道 4px 胶囊(已选段 --brand、未选段 --surface-3),滑块 13px 圆点
  (--brand + 1px 内描边 + --shadow-1),悬停放大 1.12、拖动 1.22 并套一圈光晕。
  自绘之后 UA 画的"已选进度"就没了,因此引入 `--range-fill`,由 src/main.ts 的 syncRangeFill
  在三处写入:用户拖动(document 上的 input 委托)、播放时在 tick() 里跟帧号、换动画后整栏重算;
  动态生成的图层滑杆直接把比例写进行内 style,避免重画时闪一帧空轨道。
  实测像素采样:轨道 25% 处是 #e2e2e8(= --brand),90% 处是 #3e3e43(= --surface-3)。
- **下拉**:`appearance:none` + `--select-chevron`(10px 箭头 data-URI,两套主题各一版,
  颜色写死在令牌层 —— data-URI 只能写具体色值,这是"组件里不写裸色值"规则唯一允许的落点)+ 右侧 26px 留白。
  同样做了像素采样:深色下箭头比底色亮 138 级,浅色下暗 147 级,两套主题都真的画出来了。
- 命中区不因自绘变小:滑杆仍是 22px 高的一整行,下拉仍是 --h-ctl。

### 5.5 状态栏文案的省略号

文案写在内层 `<span class="statusbar-text">` 上,不是直接写 `#statusbar`:
flex 容器上的 `text-overflow` 不产生省略号(省略号只对块级 / 行内框生效),长文案
(导出失败原因、路径)以前是被硬切掉的。`setStatus` 写这个 span;
`#statusbar.textContent` 仍然聚合子节点文本,所以读取状态栏的校验脚本一行都不用改
(verify-craft-note.mjs 与 smoke 都在读它,已复跑通过)。

### 5.6 侧栏区块跳转(吸顶)

侧栏最长的撤离动画内容高约 5940px、10 个区块(其中 13 个文字图层占 1988px、22 个形状图层占
2609px),「弹窗图层 · 显示弹窗」在 5217px 处 —— 控件一直都在,只是找不到。侧栏顶部因此多了一条
40px 的吸顶跳转控件(index.html 的 `#sideNav`),选项由 main.ts 的 `renderSideNav()` 按
**当前动画实际显示的区块**生成(区块显隐跟着 caps 走),并且滚动时用它的当前值回答"我在看哪一段"。

- **为什么是 `<select>` 而不是一排胶囊**:面板只有 272-336px 宽,10 个中文区块名排成胶囊要 3 行,
  吸顶条会吃掉侧栏 12% 的高度(实测);下拉展开时同样列出全部区块,而且一次点击即可到达。
- 区块名取标题里**第一个直接文本子节点** —— 计数写在 `<span>` 里,直接读 textContent 会把
  「· 13 个 · 可编辑」一起带进来;预设区块的标题整个是一个按钮,退回 `.preset-title`。
- 标题的吸顶偏移从 `top: 0` 改成 `top: var(--side-nav-h)`:跳转条也是 sticky,两者必须错开,
  否则会在同一行叠起来。跳转条不在时变量回到 0(由 `.has-nav` 控制),标题上方不留缝。
- 落点反馈:一次可能跨 5000px 的瞬间移动之后,给目标标题 700ms 的底色 + 描边闪一次(只闪色,无位移)。
  **刻意不用平滑滚动** —— 跨度太大,平滑滚要等一秒多,而这条控件的价值就是"立刻到"。
- 滚动跟随用 IntersectionObserver 当触发源(不监听 scroll),但当前区块**由矩形算**:
  标题都是 sticky,滚过去之后前面每一节的标题都停在同一线上,靠 entries 顺序取会停在中间项上。
  另外"到底就认最后一节":最后一节的剩余内容可能比视口矮(弹窗图层 715px vs 视口 918px),
  它永远到不了吸顶线,不特判的话刚选中的那一节会被跟随逻辑立刻改回上一节(看起来像点了没反应)。
- 两个重建调用点都是必要的:`switchAnimation`(面板一切换立刻反映)与 `onAnimReady`
  (`#imageSection / #iconSection / #themeSection` 的显隐是渲染列表时才写的,这一遍才权威)。

## Motion

**动效论点**:这里的运动有两个职责 —— 让“状态变了”和“我点到了”立刻可见;
以及让**“舞台重新量了一次、这一帧到了”**被看见。全部清单与时长见 DESIGN_SPEC 第 6 节。

- 缓动两档:`--ease`(0.33, 1, 0.68, 1)常规反馈;`--ease-out`(0.16, 1, 0.3, 1)有到达感的一次性动作。
- 时长四档并全部走令牌:120 / 180 / 300 / 340ms。常规状态反馈 120-180ms;退场比入场快(面板 240ms 进 / 140ms 出)。
- **作者时刻(新增)**:`pulseStage()` 在**换动画**与**首帧到位**两刻给舞台挂 420ms 的 `is-registering`,
  舞台播两件事 —— 一条 340ms 的扫描线自上而下走一遍(舞台是一把量具,"重新量了一次"),
  以及画布从虚到实地落定(300ms, opacity + 3px 模糊,延迟 40ms 让扫描线先动)。
  画布落定**只用 opacity 与模糊,绝不碰 transform** —— 那个位置归适配算法,两处写同一个属性必然打架。
  首屏那一次正好落在加载层开始淡出的同一刻,所以"应用出现"看到的第一次落定就是它。
- 主题切换的整树颜色过渡(200ms):令牌值换了之后每一处 color/background/border 都会变,
  只让"大的面"过渡、让小字硬切会让中间一小段对比度不成立("字消失又出现")。所以切换的 200ms 内
  给整棵树挂一段同长的颜色过渡,由 src/ui-theme.ts 挂 240ms 后摘掉(常驻会把所有 hover 过渡一起接管)。
  实测:过渡期间帧间隔 p50 16.7ms、最大 18.2ms、无一帧超过 32ms(与不切主题的基线一致)。
- 播放中的呼吸环(2.6s 循环):由"正在走帧"这个真实状态驱动,暂停立即消失 ——
  这是全站唯一的循环动效;无状态的待机循环仍然禁止(见 DESIGN_SPEC 第 6 节的判据)。
- 其它状态变化动效:切换动画时触发器换片(200ms)、侧栏区块错峰落位(220ms + 20ms/级,封顶 120ms)、
  导出百分比终态落定(220ms)、滑杆 / 开关的按下反馈(120ms)。
- 叠加层动效:画廊面板进出场 + 卡片错峰入场(仅在刚打开那一次,搜索结果重画不重播)。
- 状态栏微光:setStatus 时 520ms,且刻意用 text-shadow 而不是插入节点 ——
  状态栏的 textContent 被大量校验脚本读取,额外节点会污染它(文案虽然搬进了内层 span,
  但微光仍然走 text-shadow,因为没有再加节点)。

刻意移除的(保持移除):顶栏「制作声明」徽标的扫光、蒙版入场、蓝光呼吸与待机动效 ——
产品界面每次启动都重播一遍编排式入场属于装饰,不是状态反馈(impeccable 的 operate 模式明确反对)。
它当年依赖的 `html.craft-ready` 钩子也随之删除(见 Known deviations)。
prefers-reduced-motion: reduce 下全部过渡与动画降为 0.001ms,功能不变;
舞台扫描线在减少动效下直接不画,画布落定降级为纯 opacity 淡入(信息保留、位移与模糊去掉);
播放呼吸环不画。动效承载的信息都有非动效替代(指示器位置、颜色、aria 状态、帧号读数)。

## Browser surfaces

::selection 用 --brand-subtle;滚动条交回原生(color-scheme + scrollbar-color: var(--line-strong)),
不自绘;焦点统一 :focus-visible 2px --focus 外描边 + 2px offset,鼠标点击不出现焦点环。

焦点环**不再声明 border-radius**:浏览器(Chrome 94+)的 outline 会自己贴合元素已有的圆角,
再写一次等于把元素自身的圆角改掉 —— 胶囊开关与 10px 圆角的画廊卡片一旦获得焦点,圆角会在
聚焦期间被压成 6px,是个看得见但很难归因的跳动。原生控件(滑杆 / 下拉 / 取色器)的自绘
同样属于这一层:它们的外观也是"产品的一部分",不能留给系统默认。

## Canvas stage

预览舞台(.preview-stage)的底纹是**量具而不是装饰**:24px 网格给缩放后的画布一个尺度参照,
中心十字是构图基准线。这是“真实画布/测量表面”,impeccable 的 decorative-grid 规则
明确把这类表面排除在外。画布本身(.preview-inner)保持不透明 #16181d ——
动画素材的原始底色,不受界面主题影响。

舞台里另有一枚 `.stage-scan`(绝对定位、pointer-events:none 的纯视觉元素,由 main.ts 的
pulseStage 挂 420ms 的 `is-registering` 触发):它是 6.1 那个作者时刻的载体,
不参与任何几何计算、不影响适配与导出(导出渲染的是画布本身,不经过舞台)。

## Layout

- 顶栏 52px(+1px 描边)/ 状态栏 30px / 侧栏 --side-w 336px(<=1380px 逐档收窄到 316 / 296 / 272)。
- 桌面:预览列 + 侧栏左右两栏,两侧各自滚动,页面不滚动。
- <=860px:单栏。预览列固定占上半屏(58vh,min-height 300px,max-height 70vh),
  舞台 min-height 140px;侧栏占满宽度并自己滚动;状态栏贴视口底;
  播放条允许折行并纵向滚动(不然窄屏上它会把预览挤到只剩十几像素)。
- <=860px 的画布内层改用 CSS 定位:main.ts 写的负 margin 被 left/top:50% + translate(-50%,-50%) 取代,
  缩放仍由 main.ts 的适配算法写进 transform —— 只改定位,不改适配链路(覆盖宽高会把画布缩成十分之一)。
- 圆角:控件 6 / 面板与卡片 10 / 浮层 14 / 胶囊 999。间距尺 4 / 8 / 12 / 16 / 20 / 28。

## Known deviations

- tools/verify-mobile-layout.mjs 已从“写死像素”改为相对断言(侧栏宽 / 舞台尺寸 / 播放条高度),
  并修正了它原来对“页面必须能滚”的假设:单栏模式下滚动在侧栏内部,页面本身不滚。
- tools/verify-craft-note.mjs 的顶栏基线已同步为 52px;原来“动画切换紧贴窗口右边”的断言
  改为“顶栏子项不溢出 + 动画切换排在右侧入口之前” —— 顶栏最右端现在是主题开关。
- 改版前的 tools/verify-craft-motion.mjs 已失效(它测的入场动效被这次改版有意删除),
  应视为废弃;不要为了让它变绿而把动效加回来。2026-10 追加一轮把它改成**快速失败**:
  等不到 craft-ready 就 15s 退出并打印"已废弃",不再默认干等 4 分钟 ——
  因为它等待的那个 `html.craft-ready` 钩子已经随动效一起从产品代码里删掉了
  (它曾挂在 hideAppLoading 里,注释说它触发顶栏徽标入场;那个入场早在上一轮就删了,
  钩子却留着,成了一段谁都不消费的死标记)。
- 2026-10 追加一轮(UI bug 修复 + 应用级动效)新增的校验脚本:
  - tools/ui-deep-audit.mjs —— 几何走查:中轴对称、逐行折行判定、label 与控件同轴、
    画布居中、文本硬裁 / 有意省略号、元素重叠、溢出、有效命中区(含开关的外扩伪元素)、
    吸顶标题、主题开关三项一致性;五档视口各跑一遍。
  - tools/ui-states-audit.mjs —— 状态走查:八套动画逐个载入,查侧栏有没有"有标题没内容"的
    空壳与零高度占位块,再强制打开导出 / 数据加载浮层量内部几何。
  - tools/verify-ui-revamp.mjs —— 这一轮的九条常驻断言(滑杆填充、96px 泄漏、状态栏省略号、
    主题过渡类、舞台落定、呼吸环、导出按钮样式、窄屏顶栏、开关命中区)。
  - tools/verify-interactive-states.mjs —— 不看清单的全量交互态走查:页面上每个可见可交互元素
    都要有 :hover / :active 与手型光标。首轮跑出 6 处缺口(select 无 hover、fluent-switch 无 active、
    画廊卡片 cursor:auto),已全部补上,现在 24 项全绿。
- 顶栏在 <=900px 的换行行为已改:原先 `.anim-switch` 靠 margin-left:auto 吸右,
  行宽不够时跟随其后的主题开关会**独自折到下一行的最左边**(768px 实测),像走丢的控件;
  现在 <=900px 让动画选择器吃掉剩余宽度、主题开关自己吸右,两者要么同行并排、
  要么主题开关独占一行并停在该行最右。
- 表格 / 列表里的 `span.t-name`(图层名)是**有意省略号**(text-overflow:ellipsis),
  ui-deep-audit 会把它单独列在"有意省略号"里而不算缺陷;真正算缺陷的是 nowrap 却没有省略号的硬裁。
- CSS 规则数(tools/ui-perf.mjs 的顶层规则口径)实测 420 条,预算与"字号种类"(只数界面自身)/
  "backdrop-filter 数量"(实测 4 处遮罩)一并在 DESIGN_SPEC 第 9 节重新校准;
  同时把 `filter` 的约束从"只允许浮层遮罩"放宽到"一次性、有界、限定区域的动效里可以用"
  (目前唯一一处:画布落定的 3px 模糊),常驻滤镜仍然禁止。
- 两处测试工具的误报已修(不是产品问题,但不修就会一直误导):
  1) tools/ui-audit.mjs 与 tools/ui-deep-audit.mjs 原来按宿主盒量命中区,把开关的 36×18 稳定报成
     "命中区偏小" —— 现在会把宿主伪元素的外扩量算进有效命中区;
  2) 导出浮层的动作按钮改成 <fluent-button> 之后,两个脚本按 `button` 元素名找它们,一个都找不到
     (量出来是 null),现在统一用 `:is(button, fluent-button)`;
  3) ui-deep-audit 的"标题吸顶"判据原来按"标题顶边 = 面板顶边"算,加了区块跳转条之后
     吸顶线变成了跳转条的底边 —— 脚本跟着改成量跳转条底边(否则会稳定报 5 条假失败)。
- **修掉一个会让「弹窗图层」永久消失的数据 bug**(用户报的"撤离动画里打开丢失物品弹窗的按钮
  不见了",就是它):extraction 注册项的 `popup: () => popupData` 读的是"**当前动画**的弹窗数据",
  而这个变量在 switchAnimation 里被 `popupData = def.popup()` 整体改写 —— 切到任何无弹窗的动画
  都会把它写成 null,再切回撤离动画时 `def.popup()` 读到的就是这个 null,于是
  `popupSection.hidden = true`,侧栏「弹窗图层」整块消失;**而且** `ensureExtractionData` 因为
  `bootDataPromise` 已经 resolved 不会重新下载(它的提前返回判据 `bootAnimation && popupData`
  也是同一处错配),所以整场会话都回不来,状态栏还不报错(走的是"成功加载"的路径)。
  修法:撤离动画自己的那份素材单独存 `extractionPopupData`,`popup()` / `loaded()` /
  `ensureExtractionData` 全部改指向它,`popupData` 回归"当前动画的弹窗数据"这一个语义。
  复现方式:切到「地图标题动画」再切回「撤离动画」—— 修复前「弹窗图层」会消失。
  回归断言在 tools/verify-ui-revamp.mjs 第 10 组(切走再切回必须还在、开关必须可见可命中、
  点一下必须真的把弹窗显示出来)。
- 窄屏(<=430px)的画布按舞台高度缩放,在超矮的预览区里仍会很小 —— 这是既有适配算法
  (contain + 舞台高度)的行为,不是这次改版引入的;本次只保证舞台不被压塌、画布居中可见、
  触屏命中区 >= 40px。要真正解决应改“窄屏用画布宽度而非高度定标”的适配策略。
- impeccable detect 剩余 5 条,均已在代码注释与规范里说明理由,不要为了让它变绿而改设计:
  1) 三条 layout-transition:两条是进度条 `transition: width` —— 进度填充表达的就是「完成度」
     这个量本身,无法用 transform 等价表达,且每秒只更新数次(数据加载 / 导出进度条);
     第三条是开关滑块的 `margin-inline-start`(2026-10 追加一轮引入)—— 13px 的滑块在 18px 轨道里
     位移 16px,位移方式由组件内部布局决定(组件自己用 margin 定位),元素极小、不触发整页重排,
     已在 DESIGN_SPEC 第 6 节列为布局过渡的第二个允许例外;
  2) 一条 codex-grid-background(预览舞台网格)—— 它命中的正是规则的豁免条件「真实画布/测量表面」,
     网格在那是量具(尺度参照 + 中心十字基准),不是装饰;
  3) 一条 flat-type-hierarchy —— 解析器只读 index.html 的裸标签,拿到的是浏览器默认字号(16px),
     真实字号在 style.css(h3 17px / h4 12.5px / 正文 14px),属于工具误报。