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
  - tools/ui-states-audit.mjs —— 状态走查:八套动画逐个载入,查侧栏有没有"有标题没内容"的
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