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
| --on-danger 危险面文字 | #2a1416 | #ffffff |

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
- --danger 只用于错误状态(状态栏报错、导出失败)与**破坏性动作的二段确认**(日志「清空」上膛态);
  --warn 只用于“需要处理”的提示与告警徽标;--ok 只用于导出成功。
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

### 5.7 开始页的控件与状态(2026-10 新增)

开始页(第一屏)不是编辑器的一部分,但它的控件与状态**必须**跟编辑器同一套语言,
所以它的约定也写在这一节里:结构见 index.html 的 `#startScreen`,逻辑在 src/start-screen.ts,
桌面样式在 style.css 第 9.5 节,手机样式在 mobile.css 第 11 节。

- **主操作只有一枚实心按钮**(「打开编辑器」,`--h-cta` 36px / `--brand` / `--on-brand`)。
  没有"因为它是首屏所以更大"的第四档高度 —— 主次靠位置、字重与留白表达。
- **次要动作两枚描边按钮**(检查更新 / 动画保存目录,`--h-ctl` 32px)。手机上它们通栏 46px、
  主按钮 48px:触屏命中区下限 40px 是 PRODUCT.md 的硬要求,手机端本来就自成一套尺寸。
- **动画库卡片整张是一个 `<button>`**:左边 16:9 真实封面、右边名称 + 规格 + 两条能力标签。
  桌面 2 列 × 4 行,手机改回封面在上的竖卡(179px 宽里放不下三行文字)。
  "当前这一套"用与画廊卡片相同的语言表达(描边 + 1px 光晕),**不在封面上叠任何徽标**。
- **状态行(#ssStatus)是唯一的反馈出口**:检查更新中(2px 扫描条)/ 发现新版本(`--warn` +
  「前往下载」链接)/ 已是最新(刻意用**中性色**而不是 `--ok` —— 那个色只留给导出成功)/
  失败(`--danger`)。载入某套动画失败也复用它,不再有第二个错误位。
  `role=status` + `aria-live=polite`,只在内容变化时读一次。
- **版本徽标**是一枚 26px 胶囊(`--h-sm`),数字以 `app.getVersion()` 为准、构建期常量兜底 ——
  界面上写的版本必须就是"实际在跑的那个"。
- **退出路径**:编辑器顶栏最右多了一枚 32px 的「开始页」按钮(#btnHome),它是回去看版本 /
  更新 / 保存目录的唯一入口;手机上它占「下载列表」那一格(手机端不需要下载列表)。

### 5.8 一键重置(右侧编辑区第一位的主操作)

十套动画的编辑都是**就地改内存里那份 JSON**(文字 / 颜色 / 图标 / 不透明度 / 时长 / 二次扫描 /
弹窗 / 预设),所以「恢复默认」不是逐个字段撤回 —— 那要枚举二十多个改动点,漏一处就是
"重置了但没完全重置"。实现走唯一可靠的路径:**丢掉这套动画的数据缓存,再按打包的出厂 JSON
重新载入一次**(src/main.ts 的「一键重置」段);重新取的是打包资源(Electron / APK 里是本地文件,
网页版有 HTTP 缓存),代价只有一次 JSON.parse,换来的是与"第一次打开这套动画"相同的状态。

- **位置:右侧编辑区(检查器)的第一个元素,并吸顶**(.side-head)。
  为什么在这里:改动都发生在这栏,「把这一套恢复出厂」就该在这一栏的头一格。
  它先后试过两个位置都不对:时间轴行右侧的一枚 26px 小按钮(被滑杆和帧读数的视觉主体吃掉,
  实测**找不到**);预览列顶部的一整行(挡住了画布,而且"编辑"这件事在右栏不在左栏)。
- **视觉层级 = 主操作**:通栏 303×(38-52) 实心 --brand / --on-brand,32px(--h-ctl)/ 600 字重 /
  10px 圆角,与「导出视频」「打开编辑器」同一档。--danger 仍然只留给错误 ——
  重置成功不是错误,用红色只会让它看起来像失败提示。
- **说明行在按钮下方**(#resetHint):「恢复「撤离动画」的出厂状态」一行(nowrap + 省略号),
  完整的"清哪些东西"进 title。作用域必须写在**动作旁边**,而不是只藏在 title 里;
  侧栏只有 272-336px 宽,所以正文短、全文进 tooltip。
- **吸顶是必须的**:侧栏最长 5900px,这枚按钮滚出去就等于没有。现在重置行(z=4)、
  区块跳转条(z=3)、区块标题(z=2)三层依次顺延:--side-head-h 由 main.ts 的
  syncSideHeadHeight 用实测高度写回(字体 swap 后会变),跳转条 top = 它,标题 top = 它 + --side-nav-h。
- **结果写回那一行**:重置成功后说明行变成「已恢复「X」的默认状态」(is-done 提亮),
  切动画时由 writeAnimTrigger 复原成出厂口径 —— 动作在顶端,结果也在顶端,
  不必低头去看状态栏。
- **重置 = 重载,所以会顺带归位一批模块级开关**:二次扫描(关)、第二段时长(3.2s)、
  两段图标(默认素材)、「显示图标」(勾上)、居中微调(0)、报酬显隐(显示)、弹窗(关)、
  「默认时长已应用过」标记(删掉,于是 1.25s 会重新套用一次)、调色记录(按 '动画key:' 前缀清)、
  按图片地址的解码缓存。少一样都会出现"数据是出厂的、界面还停在改过的状态"。
- **状态栏也说结果**:「已恢复 X 的默认状态」由 onAnimReady 在**第一帧真的画出来之后**写
  (提前写会被随后的「已载入: X」盖掉 —— 实测用户只看到"已载入")。导出进行中不执行重置,
  并在状态栏说明原因。
- **代价与尺寸**:桌面占侧栏顶部 71px(等于吸顶偏移),画布不再被占用(1480×940 仍是 968×718);
  手机占底部面板 53px、按钮通栏 40px(触屏下限),说明行在手机上收起 ——
  面板收起时只有约 140px 高,这一行压到 53px 是为了给分区内容留出空间。
- **layout 的 min-width:0 保留**:说明行是 nowrap,flex 项默认 min-width:auto 会把它算进整列的
  min-content(实测 601px,900px 窗口的 .layout 被撑到 873、390px 被撑到 601)。虽然它现在在右栏,
  窄窗下右栏仍会被这段 nowrap 文字顶宽,所以 .layout 保持 min-width:0。

### 5.9 全屏更新提示(两端两套版式)

检查发现新版本时盖住整屏,由用户选「现在更新 / 稍后再说 / 跳过这个版本」。以前只有关于页里
一行小字 + 导航上的一个小点 —— 自动检查真发现了版本,不进关于页的人永远不知道。

- **桌面版式**:居中卡片(460px)+ 半透明遮罩,与导出浮层同一族语言(圆角 14 / --shadow-3)。
  层级 **8800**:高于内容与导航,**低于**导出浮层(9000)与数据加载(9999) —— 它是"需要表态"
  的提示,不该盖住用户正在等的那件事。
- **手机版式**:占满整屏的面板(不是压在遮罩上的卡片)。顶部标记 + 标题 / 版本 / 安装包 / 说明,
  动作区 margin-top:auto 贴底、通栏 48px,主操作在最靠拇指的一档,上下内边距带安全区。
  同一份 DOM,由 <html data-ui="mobile"> 分流(mobile.css 第 12 节)。
- **文案差异只有"怎么装"**:桌面安装版能应用内下载安装(「下载并安装」+ 进度条也在浮层里);
  手机 / 网页只能去浏览器拿安装包(「去浏览器下载」/「前往下载页」),
  说明里点明"手动安装,相册 / 保存目录里的成品不受影响"。
- **「稍后再说」= 本会话不再打扰**:同一版本自动检查只弹一次(Esc / 关闭 / 点遮罩同义)。
- **「跳过这个版本」写进 localStorage** dfae.ui.skipUpdate.v1:同一版永不再弹,换版本才会再弹。
  关于页那条行内状态与导航小点仍然如实显示"有新版本"(跳过的是打扰,不是信息)。
- **焦点是模态的**:打开即把焦点交给主操作,Tab 两端收口 + focusin 兜底拉回(与画廊 / 导出浮层
  同一做法);浮层里有 Fluent 自定义元素,自己算 Tab 顺序一定算错,所以只回答"焦点跑出去了吗"。

### 5.10 动画唯一编号(快速管理)

每套动画有一个**唯一编号**,界面显示成 `#001`。它回答的问题只有一个:"我说的是哪一套" ——
不用读一长串中文名,搜 `003` 或对一下卡片右侧就能确认;外部脚本 / 文档 / 导出记录里也能当一个稳定引用。

- **它是身份,不是行号**:编号写进 `ANIMATIONS` 注册项的 `no`(源头在 `src/main.ts` 的「动画编号」段)。
  画廊卡片按「最近使用」重排、搜索过滤、增删别的动画,都不会改变任何一套的编号;
  封面左下角的 1–9 才是"行号"(数字键快捷键,跟着位置走)。两者写法刻意不同:裸数字 vs `#001`。
- **放在名称行右侧,而不是封面角标**。封面上已经有「当前」(右上)与数字键序号(左下)两枚角标,
  再叠一枚就是角标墙,而且会和序号混成"两个数字"。放进信息区后它是名称的同行元信息:
  11px / `--text-3` / 表格数字,与规格行、特性标签同一族,既扫得到又不抢戏(视觉密度 6 的界面里,
  编号这种"高频但对号用"的信息要靠位置被找到,而不是靠颜色被强调)。
- **零维护**:新增动画不写 `no` 也会在启动时拿到「当前最大编号 + 1」,所以界面上不会出现没号的动画;
  两套写了同一个号时后来者自动改号并在控制台告警(唯一性由启动时的一次分配强制)。
  真要退役某个号(旧导出 / 文档还在引用),把它写进 `ANIM_NO_RETIRED`,后来者不会顶上。
- **三处同一串**:画廊卡片、顶栏触发器第二行(`#001 · 1920×1080 · 60fps`)、侧栏「动画信息」第一行。
  切换动画后三处必须同时变 —— 只改一处,用户就会以为自己切错了套。
  (顶栏那行在 ≤1360px 会随规格一起收起,这是既有的信息优先级「名称 > 总数 > 规格」;
  编号在画廊与侧栏仍然可见,手机上同样如此。)
- **搜索认编号**:`3` / `003` / `#003` 三种写法都过滤得到;搜索态下位置序号隐藏(那时数字键是输入),
  但编号照常显示 —— 按编号搜完还要能对号。
- 文案统一走 `animNoText()`(零填充 3 位 + `#`),读屏用 `aria-label="编号 3"` 而不是让它念"井号零零三"。

### 5.11 导出浮层的渲染器日志(2026-11 新增)

导出浮层里有一块**简单的黑色矩形日志窗口**(`.render-log`,夹在状态行与「这次导出的文件」行之间)。
它只做一件事:把导出正在做的每一步按时间打出来,让人知道"现在卡在哪、慢在哪"。

- **视觉**:纯黑矩形 + 1px 描边,顶部一行「渲染器日志 + 当前帧」,中间是滚动日志,底部是当前状态与用时。
  刻意不画红黄绿圆点、LIVE 呼吸灯、闪烁光标和顶部渐隐 —— 用户要的是日志,不是终端拟物。
- **每帧一行**:主渲染 / 弹窗 / 序列图 / SVG 光栅化 / 合成 / 总耗时,例如
  `042/609 主6.2 弹1.1 序2.0 合0.8 总12.6ms`;图例在开始处打一次。这是"哪一段慢"最直接的证据。
- **刷新节奏**:距上次让路超过 100ms 就主动让出一次事件循环(约 8-10 次/秒,按帧率自适应)。DOM 里每帧都有行,
  但主线程不让出的话浏览器不会重绘,用户看到的会是每半秒跳一大段 —— 这正是"刷新快"的关键。
  探测编码能力时每秒、编码器排空(flush)时每 300ms 各写一行心跳,长阶段不会看着像卡死。
- **流水线每一步**:`SPEC`(输出规格 / 背景 / 音轨 / 渲染器)、`CODEC`(编码方案 + 探测耗时)、
  `INIT`(导出实例 / 字体 / 弹窗 / 合成画布 / 缩放)、`AUDIO`(解码 / 重采样 / AAC / PCM)、
  `ENC`(编码器配置 / 每 12 帧的 queue 深度)、`FLUSH`(排空耗时)、`MUX`(封装 / finalize)、
  `AVI` 与 `REC`(回退路径)、`SAVE`、终态 `DONE / ERROR / ABORT`。
- **数据从哪来**:帧行的分段耗时来自 `renderFrame` 里的 `performance.now()`;序列图解码的墙钟
  在 `ensureSeqDecoded` 里记账、由下一帧消费;编码队列深度来自 `VideoEncoder.encodeQueueSize`;
  阶段与结局来自 `updateExportProgress` / `finishExportOverlay`。
- **可读性**:等宽 10.5px、时间 / 标签 / 正文三列网格、行尾省略号 + `title` 全文;
  行数上限 400。用户往上滚时停止自动跟随,可以回看已经滚过去的步骤;停在底部才继续跟最新一行。
- **无障碍**:整块 `aria-hidden` —— 它每秒更新几十次,进无障碍树只会变成播报噪音;
  真正的进度语义仍由 `.export-status` 与 `role=progressbar` 承担。
- **成功态默认折叠(2026-11)**:导出成功后卡片要让位给对勾与「导出成功」,
  日志槽收成 `0fr`(由卡片高度过渡一起收);底部「查看渲染日志」可再展开,
  展开/收起走同一次卡片高度过渡。失败 / 取消不折叠 —— 那两态要回答"为什么没成"。

### 5.12 导出成功态与外壳动效(2026-11 新增)

**导出成功**:进度区(状态 / 34px 百分比 / 进度条 / 明细)在 180-240ms 内淡出并轻微上移,
同一格里换成自绘对勾 —— 外环 560ms 描边、内勾 420ms 描边(延迟 300ms)、
一张 76px 的 `--ok` 淡底在 480ms 内弹开、一圈 760ms 的扩散环只播一次;
「导出成功」19px / 文件名 / 保存结果分三级错峰出现;动作按钮与日志开关在 420 / 520ms 后入场。
卡片从带日志的 527px 高收成 311px:main.ts 的 `animateExportCardHeight` 同步量旧高/新高,
用一次 420ms 的显式 height 过渡落位(减少动效下直接落位)。**不引入动画库**:
对勾是两条 SVG 路径的 stroke-dashoffset,CSS 变量与 Web Animations 足够,也避免离线包多一个依赖。

- **文案**:浮层标题与成功块写「导出成功」;状态栏仍写「导出完成」(大量回归脚本在读它,
  两个词表达同一件事,不为改文案去动既有断言)。
- **出口按平台收敛**:桌面客户端 = 打开文件夹(主) + 重新下载 + 关闭;手机 = 保存到手机 + 关闭;
  网页 = 重新下载 + 关闭。旧版把「分享 / 保存」与「重新下载」同时亮出来,两个按钮做同一件事。
- **自动关闭从 2.6s 提到 6s**,且指针/键盘/焦点一进浮层就停掉计时:
  成功卡上有真实动作,2.6s 只够看一眼;手机仍然保持常开(文件是异步写进相册的)。
- **下载列表延后 2s 打开**:桌面导出成功后原本会立刻弹下载列表,把成功动效整个盖住;
  现在先让对勾落定,再交接给列表(用户在此之前自己关了浮层就不再弹)。
- **触控**:`@media (pointer: coarse)` 下日志开关命中区 40px、动作按钮 44px;
  外形仍然是文字链 / 36px 按钮,不把手机做成另一套组件。
- **编码成功 ≠ 落盘成功**:手机端文件超过单次保存上限 / 写相册失败时,成功卡副文案转 `--warn`
  写清失败原因(不能只显示「导出成功」),并保留「保存到手机」的重试出口。

**桌面外壳**:导航轨的选中态从"每行自己换底色"变成一枚铺满行宽的滑块(`translateY`,280ms),
JS 只建一个 `span.rail-indicator`;没有 JS 时退回原样。切页时 `.page` 180ms 淡入 + 4px 上移,
页头/卡片 220ms 再错峰(仅 `html:not([data-ui='mobile'])`,手机有自己的 260-280ms 两级);
编辑器 `.layout` 不参与 —— 画布一动就会被读成"画面跳了"。

**主页双栏**:左边回答"现在做什么"(标题、说明、主 CTA、常用快捷键),
右边只放**上次打开的那一套**一张卡(真实封面 + 编号规格 + 继续编辑)。
没有历史时是带「选择动画」的空状态,点它进编辑器并打开画廊。
仍然遵守"主页不放动画列表"的约束 —— 只有一张,不是列表。浅色主题下品牌标志
(源图是近白 `#e2e2e8`)用 `filter: brightness(0)` 落成深色,否则它在浅色底上几乎不可见。
- **色彩**:终端面固定近黑(`--term-*`,两套主题同值),与预览舞台固定 `#16181d` 同理 ——
  它是一块"屏幕",不跟随界面明暗;状态色另给一组能落在黑底上的值。
  两套主题的对比度都补进了 `tools/contrast.mjs`。

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
- 播放中的呼吸环(2.6s 循环):由"正在走帧"这个真实状态驱动,暂停立即消失。
- 另一条循环也归同一判据:**导出进度条的流光**(1.8s,任务在走,终态即停)。
  两条都由真实任务状态驱动,不是待机装饰;无状态的循环动效仍然禁止(见 DESIGN_SPEC 第 6 节的判据)。
- 其它状态变化动效:切换动画时触发器换片(200ms)、侧栏区块错峰落位(220ms + 20ms/级,封顶 120ms)、
  导出百分比终态落定(220ms)、滑杆 / 开关的按下反馈(120ms)。
- 2026-11 新增的四组(全部状态驱动):导出成功态(进度区淡出 -> 对勾 560/420ms 描边 ->
  文案与动作错峰 -> 卡片高度一次 420ms 收起,详见 5.12);桌面导航滑块(280ms translateY);
  桌面切页(180ms 页面 + 220ms 子项错峰,编辑器不参与);日志「清空」二段确认(180ms 实心危险面)。
  更新提示与数据加载卡片的入场复用 df-card-in(240ms),不是新的编排。
- 日志页(2026-11)只有三处动效,都是"状态变了":用户 / 开发者日志的切换指示器
  (与主题开关同一套 220ms 滑动;两格等宽,切换时整组不横移)、新到日志行的 300ms 底色
  (这一行是刚出现的,不是旧内容)、操作结果条 180ms 入 / 120ms 出(绝对定位浮在列表右下角,
  不推动内容)。展开的「详情」、选中的文字与滚动位置在日志流式到达时保持不动 ——
  列表按 id 增量更新,不再整表重画。
- 叠加层动效:画廊面板进出场 + 卡片错峰入场(仅在刚打开那一次,搜索结果重画不重播)。
- 状态栏微光:setStatus 时 520ms,且刻意用 text-shadow 而不是插入节点 ——
  状态栏的 textContent 被大量校验脚本读取,额外节点会污染它(文案虽然搬进了内层 span,
  但微光仍然走 text-shadow,因为没有再加节点)。
- 开始页(2026-10 新增)只有两处动效,都是状态变化:
  · 进出开始页 200ms 淡出 / 160ms 淡入(换了一个表面,不是入场编排);
  · 检查更新期间的两条不确定信号 —— 状态行底部 2px 的 1.1s 扫描条 + 按钮图标 900ms 匀速转。
  两者都表达"进度未知、还在等",减少动效下分别变成一条静止细线与静止图标(信息不丢)。
  卡片与按钮只有 hover 位移 / 按下缩放(与画廊卡片同一套),没有任何首屏入场编排 ——
  产品界面每次启动都重播一遍入场属于装饰,这一条对开始页同样成立。

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

## Iconography

侧边栏图标在 2026-11 换成一套线性图标。之前的问题不是"哪个图标不好看",而是**三种笔画同时挤在一列里**:
主页 / 编辑器 / 音频提取 / 下载列表是实心自绘图标(接近 Bootstrap 填充风),日志与关于却是 Bootstrap 的细线图标。
同一个 16px 盒子里,实心块的视觉重量是细线的两三倍,于是"关于"看起来比"主页"轻一档,
一列读下来像是从两个产品里各拿了一半。

- **导航图标:Lucide 1.70.0(ISC)** —— 24×24 网格、`fill: none`、`stroke: currentColor`、
  `stroke-width: 2`、圆头圆角。桌面 16px / 手机底栏 19px / 收起按钮 13px;颜色仍走
  `--text-3 → --text-2 → --text` 这条既有状态色阶,不新增强调色。
  语义按"这一页到底是什么"选,不按"最像哪个常见符号"选:

  | 页面 | 图标 | 选择理由 |
  |---|---|---|
  | 主页 | `house` | 入口符号,没有歧义 |
  | 编辑器 | `square-play` | 这一页的主任务就是预览并就地编辑;方形外框把它和播放条那枚三角播放键分开 |
  | 音频提取 | `audio-lines` | 波形就是声音本身;喇叭 / 音符会读成"播放音乐",而这页是从 pak 里抽 Wwise 音频 |
  | 日志 | `file-text` | 日志是文本文件;卷轴 / 列表在 16px 下会糊成表格 |
  | 下载列表 | `download` | 系统通用的"落到本地"符号 |
  | 关于 | `info` | 标准信息符号 |
  | 收起 | `chevron-left` | 收起时旋转 180° 变成展开,与 220ms 的容器变形同时发生 |

- **轨内只允许一种笔画**:`.rail .bi` 强制 `fill: none; stroke: currentColor; stroke-width: 2`、
  `stroke-linecap/linejoin: round`。混进一枚填充图标或 16 网格图标,`tools/verify-rail-icons.mjs`
  会直接 FAIL。功能图标(顶栏、按钮、播放条)继续用填充式 `.bi` —— **导航是线,动作是面**,
  两层分工不同,不是"还没统一完"。这条边界也写进了 index.html 的导航注释。
- **图标与文字的间距归 Fluent 按钮的 `::part(content)` 管**:rail-item 在运行时被升级成
  `<fluent-button>`,它的 shadow DOM 把 slot 内容包进 `.content`,宿主上的 `gap` / `flex-direction`
  进不去。上一版实测图标与文字间距是 0(设计写的是 10px),手机底栏的"图标在上"也变成了横排。
  现在桌面 10px / 收起 0 / 手机竖排 3px 都由 `::part(content)` 接管。
- **收起态中线**:56 − 6 − 6 − 1(右边框)= 43 内容宽;`padding-left: 12px` 抵掉行自身 1px 边框
  与 Fluent 内容盒 1px 内缩后,16px 图标中心落在 28px 中线上(实测 28.5,是亚像素差)。
- **回归**:`tools/verify-rail-icons.mjs`(13 项)判的不是截图,而是逐枚图标"24 网格 / 2px 描边 /
  round cap / round join / stroke=currentColor",外加桌面 10px、收起 0、手机竖排与 19px。
  改图标先跑它,再看 `tools/verify-app-shell.mjs` 的外壳几何。
- **许可(随源码分发)**:图标来自 Lucide 1.70.0 / lucide-static。整体为 ISC,其中沿用 Feather 的图标
  (`download` / `info` / `chevron-left` 等)为 MIT:

```text
ISC License — Lucide
Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

```text
MIT License — Feather(部分 Lucide 图标沿用)
Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## App icons

应用图标是同一张品牌标志的三套落地,源图永远是 public/logo.svg,由 npm run icons:app
(scripts/build-app-icons.mjs)用 Electron 自带的 Chromium 栅格化 —— 机器上不保证有
sharp / ImageMagick,而应用本身就带着一整个渲染引擎。

- 网页:16/32/48 + 180(apple-touch)+ 192/512 + maskable 512,外加 public/favicon.ico;
  index.html 的 link rel=manifest 指向 public/manifest.webmanifest。
  **不能只挂 logo.svg**:iOS 不认 SVG favicon、Android 的"添加到主屏幕"只认 manifest /
  apple-touch-icon,而透明底的白色标志在浅色标签页上还会直接消失。
- Android:旧版用各密度 mipmap 的 ic_launcher / ic_launcher_round;Android 8+ 走
  mipmap-anydpi-v26 的自适应图标(背景 = values/colors.xml 的 #242424,前景 = 各密度
  ic_launcher_foreground);Android 13 主题图标用 drawable/ic_launcher_monochrome。
  **模板自带的黄+青 Tauri 图标已全部替换** —— 它就是"手机端图标不对"的根因
  (旧像素 rgb(255,193,49) + rgb(36,200,219)),tools/verify-app-icons.mjs 对这两族颜色
  做像素断言,出现一个都算 FAIL。
- 小尺寸取舍:16px 的 favicon 用 82% 的标志宽度(0.66 时只有 8% 的像素是标志色,糊成一团),
  32px 用 74%,48px 用 70%。
- 主题色:index.html 的 meta[name=theme-color] 由 src/ui-theme.ts 在切换时同步
  (#242424 / #eaeaf0),移动端浏览器地址栏跟着应用主题走,不做"界面浅了、地址栏还是黑"的半截事。

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
- 外壳是**顶栏 + 左侧导航轨 176px + 内容区 + 状态栏**:顶栏 52px 通栏(品牌 / 制作声明 /
  主题开关),导航轨在它下面贴着左边(主页 / 编辑器 / 音频提取 / 日志 / 下载列表 / 关于),内容区按页切换。
  1480×940 实测:导航轨 176×858,编辑器舞台 968×718 —— 画布没被导航吃掉(右侧还有 336px 检查器);
  右侧检查器顶部那 71px 是吸顶的「一键重置」行(见 5.8)。
  手机端导航轨变**底部标签栏 56px**(状态栏在它上面一行,标签栏贴到屏幕最底)。

## App shell

应用不再是"一打开就是编辑器",也不是一块盖住编辑器的开始页,而是**真正的多页外壳**:

| 页面 | 职责 | 关键约束 |
|---|---|---|
| 主页(默认) | 只回答"现在要干什么":版本、主操作、上次打开那一套 | **不放动画列表** —— 选动画是编辑器顶栏触发器 / 画廊的事。2026-11 改成双栏:右侧只有"上次打开"一张卡 + 空状态里的「选择动画」,见 5.12 |
| 编辑器 | 原来的 .layout(预览 + 检查器) | 切页时**不销毁**:舞台几何、适配、导出参数全部保住 |
| 下载列表 | 复用既有 #downloadsPanel(它已是完整的下载管理器) | 手机端整项不出现(落点是系统相册) |
| 关于 | 版本 / **检查更新**(含应用内下载安装)/ 保存目录(仅桌面)/ 制作声明 / 许可 | 启动时自动检查一次(可在关于页关掉) |

- **页面状态唯一权威**:`<html data-page="home|editor|about">`。切页只动 `[hidden]` 与目标页之外的
  `inert`,变更时广播 `dfae:viewchange`(mobile.ts 的首次手势提示等它)。
- **为什么编辑器不 display:none**:画布适配与舞台尺寸挂在它的几何上,设成 none 会让舞台 0×0、
  适配算法重算,回来时画面跳一下。实测切回编辑器舞台仍是 968×718(1480×940)。
- **顶栏只留全局件**:品牌、制作声明、主题开关。动画选择器与下载入口用
  `html:not([data-page="editor"])` 收起 —— 它们在主页/关于页没有意义。
- **桌面导航轨**:176px 宽、36px 高的行,选中态用 `--brand-subtle` + 亮描边(与动画触发器同一套语言)。
  **默认收起(56px)**,右上角一枚 28px 的箭头按钮(或 Ctrl/Cmd+B)切换,状态是
  `<html data-rail="collapsed">` —— 默认值也写在 index.html 的标记上,首帧就是折叠态,
  不会先展开再'啪'地缩回去;用户展开过则记进 localStorage `dfae.ui.rail.v1` 并恢复。
- **收起/展开是一次容器变形(220ms)**:宽度、内边距、行的左内边距与 gap 一起过渡,
  图标因此是'滑'到中线上(12px:56 − 左右各 6 − 右边框 1 = 43 内容宽,再抵掉行边框与
  Fluent 内容盒的 2px 内缩,16px 图标中心 = 28px);文字用 `max-width: 120px → 0` 收放
  (不用 display:none,否则收起瞬间那行字会突然消失),opacity 140ms 比宽度先退场。
  220ms 是一次性值,不往 tokens 里加第四档。舞台宽度 968↔1088 由 ResizeObserver 每帧重算,实测无跳变。
- **手机端页面栈**:接系统返回键 —— 每次切页 pushState,`popstate` 逐级回退,退到主页再按才退出应用。
  桌面端不接(没有返回键,接了只会让 Alt+← 出现意外行为)。同一页再点一次 = 回到顶部(手机惯例)。
- **手机端换页过渡**:新页面淡入 + 上移 6px(220ms,只挂在 `is-entering` 这一帧类上);
  标签选中条用 `scaleX(0.2)→1` 从中间长出来,按下时图标 `scale(0.88)` 给即时反馈。
  桌面端切页保持瞬时 —— 工具界面不该拖节奏。
- **手机端状态栏**:那条状态栏说的是编辑器状态(第几帧 / 缩放 / 导出目录),在主页/关于页上是错位噪音,
  手机上只在编辑器页显示;桌面端保留(它属于整个窗口的底边)。
- **手机底栏点击(重要)**:不依赖 `click` 合成。`pointerup` / `touchend` 按**坐标**反推落点
  (`getBoundingClientRect` 判定,不信任 `e.target` —— 子元素可能被裁剪),再走同一条 `activateRailItem`。
  `justNavigatedAt` 700ms 窗口保证 click 与 pointer 兜底不会重复触发(push 两条历史)。
- **底栏不贴系统手势区**:底部 inset 取 `max(env(safe-area-inset-bottom), 12px)`,高度 68px。
  WebView 若是 edge-to-edge 而 `env()` 报 0,原来那 56px 会被系统手势条盖住一半 —— 看得见、点不动。
  另加 `position: relative; z-index: 30`,防止面板或浮层在底部留透明命中区。
- **触屏响应**:底栏格子 `touch-action: manipulation`(去掉 300ms 双击等待)、`-webkit-tap-highlight-color: transparent`。
- **关于页的现场数据行**(仅手机):`设备 · 视口 390×844 · 安全区底 0px · 底栏 y=776 高=68 · pointerup → editor`。
  排查点不动只看这一行:落点格子 = 事件到了处理器;页面不换 = 切换逻辑有问题;不是格子 = 命中区被压住。
- **手机端不自动聚焦搜索框**:桌面端打开动画画廊即聚焦(键盘即搜索),手机上聚焦 = 弹输入法
  顶掉半屏,而手机用户本来就是想先看列表。
- **手机端**:同一份 DOM。导航轨在 mobile.css 里变成**底部标签栏**;
  .app-body 用 `display:contents` 让标签栏能排到状态栏之下、贴到屏幕最底(不用 fixed、不改 DOM)。
  选中态在手机上换成"图文提亮 + 顶部 2px 指示条",不用实心底块(那会变成一条突兀的色块)。
- **手机端识别的修复(重要)**:Tauri 在 Android 上注入 `window.__DFAE_MOBILE__ = true`
  (src-tauri/src/lib.rs),但之前**只有桥接层自己**用它分流"保存到相册",UI 从没读过 ——
  UA / 指针判定一旦失手,安卓 APK 就按桌面端渲染(用户报的"手机上还是桌面端"就是它)。
  现在它是 IS_MOBILE 的第一权威信号(main.ts 的 ⑥),mobile.ts 的 resolveMobile 也优先认它。
- **关于页的渠道判定必须移动端优先(2026-10 修)**:安卓 APK 里同样挂着 window.dfaeDesktop 桥接层
  (它本来就叫这个名字,提供的是"能落盘 / 能开系统浏览器"这层能力),于是 isDesktopApp 在手机上
  也成立 —— 只看它,关于页会写「桌面版」、还会露出只有桌面才有的「保存目录」。现在
  start-screen 里先算 `desktopClient = isDesktopApp && !isMobile`,渠道 / 平台 / 保存目录 / 自更新
  全部跟着它走:用户看见哪套 UI,版本渠道就写哪一套,更新检查也据此去挑 APK 而不是 Setup.exe。
  回归在 tools/verify-reset-update.mjs 第 4 组(带桌面桥接 + 原生移动信号,断言渠道是「手机版」)。

## Audio (preview)

预览音效**不走 HTMLAudioElement**,而是 WebAudio(`AudioContext` + `AudioBufferSourceNode`)。原因在 lottie-web 的
`AudioElement.renderFrame`(lottie.js:6875):它每一帧都做

```js
if (!audio.playing() || Math.abs(动画时间 - audio.seek()) > 0.1) audio.seek(动画时间)
```

手机上 `<audio>.currentTime` 会因缓冲/解码滞后,于是**每帧都判定不齐 → 每帧 seek → 声音永远停在开头 0.2s**
(用户报的"一直重复 0~0.2s");自动播放被拦截时错误名不一定是 `NotAllowedError`、元素没 loaded 时 `play()`
直接被拒且不重试 → "有的没声音";元素加载 + 每次 play 的握手延迟 → "延迟很久才响"。

现在的约定:
- 位置由 `AudioContext.currentTime` 推算,精确且不随缓冲漂移,`playing()` 只认"有活动音源";
- `seek(t)` **只有真实跳变(>250ms)才重排音源**,逐帧的小偏差直接忽略(消除"重复开头"的关键);
- 解码后的 `AudioBuffer` 按资源路径缓存,切动画不重解码;
- 全站只有一个 `AudioContext`,首次用户手势统一解锁,排队中的播放自动补上(不再每个层各自被拦截);
- 没有 WebAudio 的极老 WebView 退回 `HTMLAudioElement` 实现(功能降级但不崩);
- 开发期读数:`window.__audioDbg.{ctxState,buffers,starts}`。`starts` 是音源创建次数 ——
  实测播放 6 秒恒为 2(每层一次);修复前它会持续增长。

## Update check

开始页的「检查更新」查的是**发行版**,不是代码仓库:

- GitCode 优先:`GET https://api.gitcode.com/api/v5/repos/TFR-Studios/DeltaForceAnimation_app/releases/latest`;
  失败(网络错误 / 非 2xx / 没有 tag_name)退 GitHub 同名接口。两边字段名一致,解析只有一份
  (src/update-check.ts)。
- **桌面端的请求由主进程代发**(electron/main.cjs 的 dfae:check-update,用 Electron 的 net.fetch)。
  两条理由:主进程走**系统代理**(渲染进程的 fetch 不认),以及少一道跨域开关。
  实测(2026-10,本机):`window.dfaeDesktop.checkUpdate()` 返回 `{ok:true, source:'gitcode', tag:'v1.0.5'}`;
  网页里直接 fetch 两个源也都是 200 —— api.gitcode.com 的 Access-Control-Allow-Origin 是**动态**的,
  带 Origin 的请求它会给,不带 Origin(curl / PowerShell)看不到这个头。所以桌面端不押在这上面,
  网页端则以"任何异常退 GitHub"兜底(它固定返回 `Access-Control-Allow-Origin: *`)。
- 版本比较只做数字段;带后缀的(v1.0.6-beta)按"同版更低"算,稳定版才算升级。
- 附件挑选:Windows 安装版 Setup > 便携版 Portable > win-unpacked.zip > 其它 exe;Android 取 apk;
  网页版没有安装包,给发行版页面。按钮只负责"把链接交给系统浏览器",不在应用内下载安装包。
- **发现新版本会弹全屏提示**(#updateOverlay,版式见 5.9):启动时自动检查(1.2s 后发请求,
  自动化页面跳过)与手动「检查更新」共用同一次结果 —— 行内状态与浮层是同一份数据,不发两次请求。
  自动检查对同一版本只弹一次;「跳过这个版本」记进 localStorage,同一版永不再弹。
- **能自更新的只有桌面安装版**:dfaeDesktop.updateCapabilities().canSelfUpdate 为真时才出现
  「下载并安装」(边下边报进度 → 校验 → 启动 NSIS 安装器 → 退出自己);便携版 / 手机 / 网页
  一律「去浏览器下载 / 前往下载页」,走 openExternal(校验 http/https)而不是自己下安装包。
- 桌面端的检查请求由主进程代发这条仍然成立;手机(Android WebView)没有这个通道,走页面 fetch,
  两个源都带 CORS 头,失败由 update-check 统一收成一行人话。

## Interaction performance

手机上的"拖动卡顿"不是玄学,是三个具体写法叠在一起。全部数字来自
tools/mobile-perf.mjs(390×844 / DPR 3 / 6× CPU 降频,CDP 派发真实触摸,暂停动画以排除
Lottie 逐帧渲染),同一台机器上改前 / 改后对照。

| 场景 | 改版前 | 改版后 |
|---|---|---|
| 拖底部面板把手:样式重算累计(一次拖动) | **9.9s**(占 14.3s 的 69%,单次最长 370ms) | **0.05-0.12s** |
| 拖把手:强制布局次数 / 帧 p95 | 168 次 / 266.7ms | 26-31 次 / 50-83ms |
| 单指平移:帧 p95 / >50ms 帧 | 33.3ms / 1 | 16.8ms / 0 |
| 双指捏合:帧 p95 / 最长任务 | 33.4ms / 133ms | 16.8ms / 无 |

**一、尺寸不能走自定义属性(决定性的一条)。** 把手拖拽原来是
`root.style.setProperty('--m-sheet', …)`。改 html 上的自定义属性会让**整棵文档树**
(含每个 Fluent 组件各自的 shadow 树)重算样式:手机壳下本页 1848 个元素,一次 25ms,6× 降频下 147ms ——
而它是一帧改一次。现在改成写面板自己的行内 `height` / `flex`(0.3ms,只失效这一个盒子的布局)。
CSS 里的 `--m-sheet` / `--m-side` 保留为首屏与"还没拖过"时的默认值;两个轴向互相清掉对方的
行内值(竖屏的行内高度留到停靠模式会把侧栏顶成整屏高)。

**二、手势里不许读布局。** 拖把手时每条 pointermove 都调一次 `snapList()`,而它读
`layout.clientHeight` —— 刚写完尺寸又去读布局,浏览器只能当场做一次全量样式重算 + 布局。
舞台中心(`getBoundingClientRect`)同理。现在吸附档位与舞台矩形都在**手势开始时**取一次,
尺寸变化与视口变化时标脏;移动里只用缓存。

**三、一帧只结算一次。** 触屏 pointermove 能到 120-240Hz,而屏幕只画 60-120 帧:原来每条事件都
算一遍视图、写一次 transform、同步一次悬浮控件。现在移动事件只更新"手指在哪",视图计算与写 DOM
放进 rAF;抬起时把还没结算的最后一次移动补上(否则松手会往回跳一帧)。悬浮控件同步也改成
"值没变就一个字节都不写"。

**手势期间的合成层。** 平移 / 捏合 / 惯性 / 双击补间时给 .preview-inner 挂
`will-change: transform`:画布这一层不再每帧重新光栅化(它挂着一幅近 900 节点的 SVG),
松手立刻摘掉(常驻会永久占一张接近画布像素尺寸的贴图)。同一段时间里收掉两枚悬浮按钮与
缩放读数的 backdrop-filter —— 它们正压在会动的画布上,每帧都要重算背景模糊。像素采样:
静止态与手势态的最大通道差 14/255、平均 1.08、39.7 万个采样点里只有 32 个超过 8 —— 手势中
手指就压在屏幕上,这点差别看不见,松手立刻恢复成毛玻璃。

**没有动的那件事:播放时的渲染开销。** 这套动画的 SVG 里有 618 个 `<image>`、DOM 序列化后
11MB,播放时 Lottie 每帧写这六百多个节点的属性 —— 6× 降频下"什么都不动、只让动画跑"就已经是
p50 50-117ms。这是素材与渲染器决定的,**不属于交互路径**,本轮没有改它,也不建议改:
把移动端预览切到 canvas 渲染器实测更差(同条件 p50 1266ms、捏合 p95 150ms),所以渲染器默认值
保持 svg。要真正解决得换掉这套素材的构成方式,那是另一个议题。

常驻回归:tools/verify-mobile-touch.mjs(27 项,真实触摸驱动)。它断言的是**样式重算 / 布局预算**
(6× 降频下一次拖动累计 <=0.5s、重算次数与帧数同量级),帧间隔只做"没有塌"的松断言 ——
headless 没有 GPU,重绘走软件光栅化,同一份代码的 p95 会在 50-83ms 之间跳,拿它当硬阈值只会得到
一个爱闪的红灯。

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
  - tools/ui-states-audit.mjs —— 状态走查:十套动画逐个载入,查侧栏有没有"有标题没内容"的
    空壳与零高度占位块,再强制打开导出 / 数据加载浮层量内部几何。
  - tools/verify-ui-revamp.mjs —— 这一轮的九条常驻断言(滑杆填充、96px 泄漏、状态栏省略号、
    主题过渡类、舞台落定、呼吸环、导出按钮样式、窄屏顶栏、开关命中区)。
  - tools/verify-interactive-states.mjs —— 不看清单的全量交互态走查:页面上每个可见可交互元素
    都要有 :hover / :active 与手型光标。首轮跑出 6 处缺口(select 无 hover、fluent-switch 无 active、
    画廊卡片 cursor:auto),已全部补上,现在 24 项全绿。
- **2026-10 第四轮(移动端交互性能)**新增的两个工具,与上一轮的分工是"量"和"守":
  - tools/mobile-perf.mjs —— 交互性能探针。CDP 派发真实触摸(不是合成 PointerEvent),
    在手机壳参数下量平移 / 捏合 / 拖把手 / 拖时间轴四类拖动,输出帧间隔分布、长任务与
    CDP Performance 的布局 / 样式重算增量;支持 --cpu / --dpr / --renderer / --inject 做 A/B
    ("这条 rule 值不值得加"靠它回答,不靠感觉)。
  - tools/verify-mobile-touch.mjs —— 27 项常驻回归,断言手势**真的做到了它承诺的事**
    (跟手位移、吸附、双击、单击、长按复位、旋转停靠),外加拖动期间的样式重算 / 布局预算。
    它替掉了"桌面上看着没问题"这种验证方式:手势数学只在触屏上运行。
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
- **2026-10 第三轮(UI bug 修复 + 浮层可访问性)**:这一轮修的是三类"只在特定宽度或键盘流里
  才出现"的问题 —— 截图看不出来,但都能量,常驻断言在 tools/verify-dialog-a11y.mjs。
  **先分清两套前端**:手机 / 平板走 src/mobile.ts + src/mobile.css(html[data-ui="mobile"],
  按硬件信号判定,顶栏是显式两行 grid);桌面走 src/style.css(网页版与 Electron)。这一轮里
  只有第 1 条与触屏尺寸同时服务两端,第 2 条**只对桌面前端的窄窗口**生效。
  1) 画廊 / 下载列表的头部(**两端共用同一个 #animPicker**)在 <=479px 会把关闭按钮挤出面板:
     标题 + 220px 搜索框 + 关闭按钮放不进一行,390px 实测面板 scrollWidth 比宽度大 48px,
     关闭按钮整体不可见(不在视口里);逐像素扫过一遍,470px 还差 2px、480px 才刚好放下。
     现在 <=480px 折成两行:标题一行、搜索框 + 关闭按钮一行,关闭仍在最右。
  2) 桌面前端的顶栏在 <=480px 主次反了:动画触发器被制作声明徽标挤到只剩 124px
     (名字被省略号吃掉),而"未使用 AI"那枚徽标占 222px。现在选择器独占一整行
     (390px 下 358px),品牌与主题开关同排,声明落到第三行;顺序用 order 而不是改 DOM,
     Tab 顺序不变。顶栏高度 113 -> 107px。Electron 窗口最小宽 1024,所以这条只会在
     网页版被拖窄、或开发期 ?ui=desktop 调试时命中;**手机端不受影响** —— 那边
     mobile.css 的 .topbar 是显式的两行网格,实测 390px 下动画触发器 245px、
     制作声明独占第二行 24px,本来就是对的。这一条最初被误写成"手机端顶栏",
     是把「桌面前端在 390px 的表现」当成了手机。
  3) 三个浮层都声明了 aria-modal,但键盘焦点没有被约束:画廊里第 10 次 Tab 就跑到浮层背后
     (被盖住的顶栏与播放条),导出浮层则完全没有焦点管理,读屏也拿不到它的角色。
     现在 src/main.ts 的 holdFocusInside 用"Tab 两端收口 + focusin 兜底"把焦点锁在浮层内
     (浮层里有 Fluent 自定义元素,焦点节点在 shadow DOM 里,自己算 Tab 顺序一定算错);
     导出浮层补上 role=dialog / aria-modal / aria-labelledby / tabindex=-1,打开时接管焦点,
     关闭时只在"焦点还在这一层"时交还给导出按钮;导出成功自动打开下载列表时焦点归最上面那层
     (列表),列表关掉而导出浮层还开着时再交回给浮层 —— 两层模态重叠是这条真实路径带来的。
  4) 两个进度条(数据加载 / 导出)补上 role=progressbar + aria-valuenow;总长度未知时用
     aria-valuetext="正在加载",不留一个假的 0%。状态栏补 role=status;数据加载浮层是 live region,
     百分比数字对读屏隐藏(值由进度条承担,避免每 5% 念一遍)。
  5) 测试工具:tools/verify-anim-picker.mjs 读的 #animTriggerThumb 早已随缩略图一起删除,
     脚本在 getAttribute 上空指针崩掉、整份 35 项回归失效;已改成断言"触发器里不该再有 img",
     把"缩略图是有意移除"写成不变量。
  6) 两个"浅色主题"工具其实一直在量深色(这一轮一并修掉):
     · tools/ui-audit.mjs 的浅色分支点的是 .theme-switch fluent-toggle-button,而开关早换成
       自绘的 .theme-btn[data-theme] —— 一个都点不到,于是 DARK / LIGHT 两段报告一字不差。
       现在点真正的按钮并回读 data-theme 确认,修完之后浅色段的令牌与对比度样本才是浅色的
       (0/16 fail,最低 6.32:1)。
     · tools/shot.mjs 的 --theme 原来只 emulate prefers-color-scheme,而本应用的主题是
       显式存下来的、不跟系统走 —— 传 --theme light 拍出来仍是深色,且不报错。
       现在改成点开关本身(与用户操作同一条路径),拍完回读 bodyBg 可以核对。
       同一条命令加了 --ui mobile:带 ?ui=mobile 并把 isMobile/hasTouch 一起设上,
       否则 390px 拍到的只是"被挤窄的桌面布局",不是手机壳。拍完会回读 data-ui 供核对。
  7) 手机端(html[data-ui="mobile"])的触屏命中区补到 PRODUCT.md 的下限 40px:
     · 主题开关两格实测只有 29×24(外壳 68×32),而顶栏这一行 46px 高。不动外观,
       只把命中区上下各扩 8px(有效 29×40,做法与 fluent-switch 的外扩一致);
       横向不扩 —— 两格之间只有 2px,左右扩会互相重叠,更容易点错主题。
     · 动画触发器 38 -> 40px、分区芯片 .m-tab 38 -> 40px(芯片条本身 46px 高,放得下)。
       侧栏里那批 38px 的控件不动:它们挤在密集的检查器行里,统一抬到 40 会把每行再拉高,
       收益不抵代价(这是 DESIGN 的取舍,不是遗漏)。
- 两套前端的判定与调试入口(2026-10 记录):桌面 / 手机的切换靠 main.ts 的 IS_MOBILE
  (UA-CH、粗指针、多触点、iPad 桌面模式、小屏触屏兜底),不是一个 width 断点;
  URL 参数 ?ui=mobile / ?ui=desktop 与 localStorage dfae.ui.mobile 用于在桌面上调试两端。
  **做移动端结论必须用 ?ui=mobile + isMobile/hasTouch 复现**,只在 390px 桌面窗口量出来的
  几何是桌面前端的答案,不能拿来描述手机。
- 响应式阈值(第三轮新增):<=480px 触发桌面前端顶栏与**两端共用**的浮层头部重排;
  保持原样(768px 实测画廊头部仍是单行)。改阈值前先量 .ap-head 的自然宽度
  (标题 + 搜索 + 关闭约 468px)与面板内宽(视口 - 34px),不要凭感觉调:
  470px 的关闭按钮只差 2px 就出界,截图看不出,量得出来。
- impeccable detect 剩余 7 条(2026-10 第四轮复跑),均已在代码注释与规范里说明理由,
  不要为了让它变绿而改设计:
  1) 五条 layout-transition(桌面 3 + 移动端 2 个轴向 1 条):
     · 两条进度条 `transition: width` —— 进度填充表达的就是「完成度」这个量本身,
       无法用 transform 等价表达,且每秒只更新数次(数据加载 / 导出进度条);
     · 开关滑块的 `margin-inline-start`(2026-10 追加一轮引入)—— 13px 的滑块在 18px 轨道里
       位移 16px,位移方式由组件内部布局决定(组件自己用 margin 定位),元素极小、不触发整页重排;
     · 移动端底部面板的吸附过渡(`transition: height` / 停靠时 `transition: width`):
       面板尺寸就是布局本身,没有 transform 等价物(用 translateY 表现"变大"会让画布先跳到
       最终尺寸、再让面板滑过去,画面在开头闪一帧)。它是**一次性、有界(320ms)、只在松手后**
       的收尾动作,拖动过程中一律不挂(见 DESIGN_SPEC 第 9 节的交互预算)。刻意不做"瞬间吸附":
       吸附要让人看见"落到了哪一档",那正是这段过渡在讲的事。
  2) 一条 codex-grid-background(预览舞台网格)—— 它命中的正是规则的豁免条件「真实画布/测量表面」,
     网格在那是量具(尺度参照 + 中心十字基准),不是装饰。
  (flat-type-hierarchy 那条误报在第四轮已消失:解析器能读到 style.css 的真实字号了。)

- **2026-10 第五轮(开始页 + 更新检查)**:
  - tools/verify-app-shell.mjs —— 应用外壳的常驻回归(30 项)。桌面(带假的 Electron 桥接,
    这样"检查更新 / 动画保存目录"两条只有主进程才有的路径在普通 Chrome 里也能量)、浅色主题、
    1024 / 820 窄窗口、390px 手机壳各跑一遍;断言的是结构、几何、文字、交互与状态,不是截图。
    手机壳必须带 ?ui=mobile + isMobile/hasTouch —— 只把视口压到 390px 量到的是桌面前端(见第三轮)。
  - 顶栏**多了一枚 32px 的「开始页」按钮**(#btnHome,在下载列表与主题开关之间)。
    verify-craft-note 的"最后一个子项不溢出"因此从主题开关变成它,实测 1700 / 1280 / 1024 / 768 /
    390px 五档仍无溢出、无横向滚动(该脚本的三处绝对截图路径也已改到 release/verify/)。
  - **switchAnimation 现在 await loadData**(以前是 void)。这是开始页带来的顺序问题:
    "关开始页"与"构造 lottie 实例"原本并行,先关页面会让实例读到 editor 状态并 autoplay,
    动画在用户还没看见编辑器时就开始播(还带音效)。await 之后顺序确定:先以暂停建好,再淡出。
    对编辑器内的动画切换没有行为变化(它本来就是等数据好了再画)。
  - 手机端顶栏的第三格从「下载列表」(手机端本来就隐藏)改成「开始页」按钮,40px 命中区;
    mobile.css 的 grid-area 已同步。首次手势提示改成等 dfae:viewchange 的 editor 再计时 ——
    否则那 9 秒会全部播在开始页背后。
  - 两枚主题开关(src/ui-theme.ts 的 themeGroups)取代原来的两个模块级按钮引用。
    历史校验脚本按 querySelector('.theme-switch') 取开关,所以开始页在 DOM 里排在 </main> 之后,
    保证第一个仍然是顶栏那枚 —— 这一条写进 index.html 的注释里,不要"顺手"把开始页挪到最前面。
- **2026-10 第六轮(一键重置 + 全屏更新提示 + 关于页端判定)**:
  - tools/verify-reset-update.mjs —— 本轮三件事的常驻回归(51 项,桌面 + 手机各一遍)。
    它拦截更新接口并把版本伪造成 9.9.9,所以不依赖网络、也不会因为真的发了新版而变色:
    量重置按钮的几何 / 三轮真实编辑后逐项归位 / 状态栏文案;量全屏提示的两套版式、动作尺寸、
    焦点没跑出浮层、Esc 关、「跳过这个版本」写进 localStorage 且下次不再弹;
    量带桌面桥接的手机关于页渠道是「手机版」且没有「保存目录」。
    每个用例用独立的 browser context —— localStorage 不隔离时,前一个用例"跳过"掉的版本号
    会让后一个用例的自动提示静默不弹(排查起来很像功能没生效)。
  - 本轮把两个因**应用外壳改版**而失效的常驻脚本修回来了(它们默认停在主页上量编辑器):
    tools/verify-ui-revamp.mjs 与 tools/ui-states-audit.mjs 现在显式进编辑器(或以 ?view=editor 打开)。
    编辑器不可见时侧栏区块全在 [hidden] 里,量到的是"整片空壳 / 0×0 / 动画不跑"——
    那是主页期间的正常行为,不是缺陷;修之前两者分别稳定报 2 项与 16 项假失败。
  - 两次真机反馈后的修正:一键重置先放在时间轴右侧(26px 次级按钮,实测找不到),
    再上移到预览列顶部整行(挡画布、且"编辑"在右栏),最终落在**右侧编辑区顶部并吸顶**(见 5.8)。
    三处层叠吸顶(重置行 → 跳转条 → 区块标题)的偏移由实测高度驱动,不是写死数字。
    tools/verify-reset-update.mjs 的断言随之改为量"检查器第一个元素 / 按钮在跳转条与标题之上 /
    实心主操作外观 / 说明行带动画名 / 滚到侧栏底部时三层各就各位 / 结果写回说明行",
    并在 900px 与 390px 上确认无横向滚动。
  - tools/verify-mobile-layout.mjs **仍然是失效状态**(本轮没修):它写在应用外壳之前,
    断言"侧栏占满视口整宽"而现在是"视口 - 导航轨",而且它用 isMobile 视口跑的是桌面前端。
    要复活它得按外壳重写断言,不是改一行导航的事。320px 上"布局视口被撑到 374px"来自
    .transport(flex-wrap:nowrap 的一排按钮),与 5.8 的重置按钮无关(去掉按钮再量仍是 374)。
  - 计时类断言的小坑:把「重置后的状态栏文案」写成 setStatus 紧跟 switchAnimation 是不行的 ——
    loadData 是异步的,onAnimReady 随后会写「已载入: X」把它盖掉。现在由 onAnimReady 按
    resetStatusKey 改口径,并留了 6s 兜底放掉标记(否则下一次普通载入会被误写成"已恢复默认")。
- **2026-11 第七轮(导出成功态 + 外壳动效)**:
  - 新增 tools/verify-ux-motion.mjs:导出成功态的常驻回归(桌面 + 手机 × 正常 / 减少动效)。
    断言进度区隐去、对勾与「导出成功」在视口内、文件名与动作按钮完整、日志默认折叠且可展开、
    reduced-motion 下对勾 stroke-dashoffset=0 且无 >1ms 的关键帧。它不替代真实导出的 smoke:
    成功态的数据来自一次约 20s 的真实 WebCodecs 导出。
  - 导出浮层的 DOM 结构变了(进度区套进 .export-stage/.export-progress,日志套进 .export-log-slot),
    id 全部保留;回归脚本读的 #exportStatus / #exportPercent(含 done/error/cancel 类)不变。
  - 自动关闭 2.6s -> 6s,交互即停;桌面下载列表从"立即弹"改成延后 2s,先让成功动效落定。
  - 主页双栏:右侧只有一张"上次打开"卡,无历史时是带「选择动画」的空状态;
    用 lastKey 判断,不能拿启动默认动画兜底(否则空状态永远不出现)。
  - 导航轨多了 span.rail-indicator(桌面);没有 JS 时 .has-indicator 不出现,退回每行底色。
    切页入场 180ms 只作用于 .page,编辑器 .layout 不参与。
  - 日志「清空」改成按钮就地二段确认(不再 window.confirm),3.2s 自动复位;
    日志页 / 聚焦搜索框(与编辑器里 / 打开画廊同键不同页)。
  - 网页版隐藏导航轨「下载列表」(没有主进程能力时它是死入口);浅色主题的品牌标志
    (源图近白)用 filter: brightness(0) 落成深色。
  - 状态栏在非编辑页把非错误文案压到 opacity .92(0.88 会让 12px 字跌破 4.5:1);
    错误仍满色,textContent 不变。
