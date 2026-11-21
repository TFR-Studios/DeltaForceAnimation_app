# 三角洲行动动画编辑器

## Project
- 纯静态前端(Vite 7 + TypeScript 5.8 + lottie-web,无后端、无框架),把 10 套游戏 Lottie 动画变成可改文案 / 颜色族 / 图标 / 时长 / 不透明度并导出 MP4 或透明 AVI 的工具。
- 同一份产物里还有第二个编辑器「图片编辑器」:编辑应用内置的结算图 PSD(pictures/settlement),改文字图层的内容 / 颜色 / 透明度,从 190 张名片素材里选一张,支持等比 / 自由 / 四角透视三种缩放方式,导出 PNG(桌面端专用)。
- 同一份 `dist/` 套两层壳:Windows 用 Electron 31.7.7(主推发布形态),Android 用 Tauri v2 + 系统 WebView;平台差异只在编译期 cfg、`src/mobile.ts` 与落盘路径。
- 版本真源是 `package.json`,但发版时 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处必须一致,且 tag `vX.Y.Z` 必须等于它(`scripts/check-version.mjs`,CI 第一道闸)。
- 编辑结果不落盘:只有"最近使用的动画"记在 localStorage,刷新即还原。
- 代码 GPL-3.0;游戏素材(JSON / PNG / 音频)版权归原游戏,不在 GPL 授权内。

## Layout
```text
index.html            单页外壳;id 与 main.ts 顶部 $() 常量一一对应;首屏主题与加载层样式内联
src/                  前端全部逻辑,14 个 .ts 约 24k 行
  main.ts             动画编辑器主体(≈14.7k 行):动画注册、lottie 渲染补丁、编辑面板、导出管线、下载列表
  start-screen.ts     应用外壳:主页、导航切换、版本、检查更新、按需拉起图片编辑器
  psd-document.ts     图片编辑器数据层:ag-psd 解析、文字重排、图层合成
  card-quad.ts        名片四角透视:单应矩阵 + 逐像素双线性采样
  card-remote.ts      名片原图在线加载:GitCode raw API + Cache Storage + 缩略图兜底
  image-page.ts/.css  图片编辑器页面(#viewImage):舞台(滚轮缩放/拖动平移)+ 背景/名片/文字图层检查器;首次进入才加载
  mobile.ts/.css      移动端外壳 + 手写触屏手势;非触屏设备上零副作用
  logs.ts/devlog.ts   用户日志 / 开发者日志(采集 console、异常、业务事件;桌面端由主进程写 JSONL)
  audio-page.ts/.css  音频提取页;数据经 window.dfaeAudio 走主进程
  ui-upgrade.ts       Fluent 组件注册与 DOM 升级(顶层 await,必须最先执行)
  ui-theme.ts         主题开关;style.css 是唯一颜色令牌来源
  update-check.ts     更新检查
electron/             Windows 壳
  main.cjs            127.0.0.1 随机端口静态服务、窗口/菜单/单实例、下载接管、自检/审计开关、IPC
  preload.cjs         contextBridge 暴露 dfaeDesktop / dfaeDownloads / dfaeLogs / dfaeAudio
  downloads.cjs       下载列表与历史(命名、清单、对账找回、重命名)
  logs.cjs            <userData>/logs/dfae.log(JSONL,2MB 轮转一代)
  smoke.cjs measure.cjs  自检(--smoke)与布局审计(--measure)
  audio/              读游戏 pak、解 Oodle(koffi)、vgmstream 解码;密钥在 audio/keys/AESKey1.json
src-tauri/            Android / Tauri 壳(Rust);gen/android 已提交,含锁横屏与权限定制
animations/           10 套动画素材(约 130MB),打包时按动画分包
posters/              画廊封面
tools/                239 项(215 个 *.mjs、79 个 verify-*);一次性排障占多数,头部标「常驻」的才是回归套件
build/                打包输入(icon.ico / icon.png / splash.bmp),必须提交
scripts/              dev-app / bump-version / check-version / clean-release / dfae-cli(管理工具) / publish-to-gitcode
docs/                 FEATURES.md + 每版 RELEASE_NOTES_v<ver>.md
*.bat                 双击入口;界面文案不要写进 .bat,统一放 scripts/dfae-cli.mjs
README.md             维护手册:安装、打包、发版、外壳实现、FAQ
```

## Docs
- 改 UI、加控件前 -> [DESIGN_SPEC.md](DESIGN_SPEC.md)(强制规范:颜色令牌、对比度、字号、控件状态集、动效白名单、性能预算)
- 想确认"当前视觉系统长什么样" -> [DESIGN.md](DESIGN.md)(生产在跑的令牌与组件)
- 查上游网页版功能、兼容导出规则与历史坑 -> [docs/FEATURES.md](docs/FEATURES.md)
- 需要产品定位、用户或成功标准 -> [PRODUCT.md](PRODUCT.md)
- 写发版说明、核对安装包文件名 -> [docs/RELEASE_NOTES_v1.1.4.md](docs/RELEASE_NOTES_v1.1.4.md)(最新一版的格式与产物命名)

## Commands
- Node ≥ 20(仓库 `.nvmrc` = 22);首次 `npm install`,CI 用 `npm ci`。
- `npm run build` = `tsc && vite build`(类型检查 + 产物);只做类型检查用 `npx tsc --noEmit`。
- `npm run app:dev` 开发模式(vite dev server + Electron,HMR);`npm run dev` 只起浏览器版(固定 5173,占用时顺延)。
- `npm run app` 重新构建并启动;`npm run app:start` 直接启动,要求 `dist/` 已存在(不重建)。
- 自检:`npm run app:smoke` / `npm run app:smoke:export`(真跑一次 MP4 导出),报告与截图在 `release/smoke/`,退出码 0 = 全过。打包后的 exe 也接受 `--smoke [--smoke-export=mp4]`。
- 布局审计:`node tools/measure-ui.mjs`(拉起 Electron --measure,喂极端夹具,退出码 0 = 不变量全过)。
- 下载历史自检:`node tools/check-downloads.mjs`(纯 Node,不依赖 Electron)。
- 打包:`npm run dist`(dir + portable + nsis,结束清理旧版本包);`npm run dist:dir` / `npm run dist:portable` 单打一种。
- 图标:`npm run icons`(需拉起 Electron,重生成 build/ 三件套);`npm run icons:app` 为另一套应用图标流程。
- Android 调试包:`npm run tauri android build -- --debug --apk -t aarch64`(需 NDK r25、SDK 37、JDK 17/21,Rust target aarch64-linux-android;**项目路径不能带空格**)。
- Rust 纯逻辑测试:`cd src-tauri && cargo test`;单个用 `cargo test release_never_uses_configured_dev_url`。
- 发版:`node scripts/bump-version.mjs patch --notes` -> 提交 -> `git tag vX.Y.Z` -> 推 tag。CI:`release.yml` 依次 verify → windows/android → 建 Release 并推 GitCode;`mirror-gitcode.yml` 把 main 与标签镜像到 GitCode 普通仓库,`sync-gitcode.yml` 手动补传某个版本的发行版附件。

### 常驻回归
前置:先 `npm run dev`(默认连 5173),脚本用 puppeteer-core 找本机 Chrome / Edge;每个脚本打印 PASS/FAIL,失败退出码 1,多数支持 `--url` 指向别的端口。
- `node tools/verify-app-shell.mjs` 多页外壳、导航、关于页、切页不销毁编辑器
- `node tools/verify-mobile-touch.mjs`/`verify-mobile-layout.mjs` 触屏手势、拖动帧率预算、移动端排版
- `node tools/verify-mobile-export.mjs <desktop|ladder|recorder|noaac|avih264|avimjpeg>` 导出各降级路:编码器降档、无 WebCodecs、无 AAC、AVI 两种;断言成片带音轨且容器里有时长
- `node tools/verify-export-fallback.mjs` AAC / Opus / 无 WebCodecs / 移动端下载门禁
- `node tools/verify-export-resilience.mjs` 探测挂死、编码器报错、透明 AVI 内存护栏后按钮锁复位
- `node tools/verify-render-log.mjs` 导出浮层里的渲染器日志(卡片边界、无横向溢出)
- `node tools/verify-image-editor.mjs` 图片编辑器:内置 PSD 载入 / 4 张背景图切换与撤销(换背景后屏幕无透明孔)/ 滚轮缩放+拖动平移+双击复位 / 改字改色改透明度 / 名片选择器(190 张、分类、搜索、方向键、等比/自由/透视三种模式、单角拖动、整体平移、旋转、复位、换背景位置不变、来源标注、Esc 焦点归还)/ 导出 PNG(含忙碌态、结果卡、「打开文件夹」/整幅不透明且屏幕中心非黑)/ 撤销(含名片)/ 窄屏 / 手机端不出现
- `node tools/verify-logs.mjs`、`tools/verify-devlog.mjs`、`tools/verify-ux-motion.mjs` 用户日志 / 开发者日志 / 动效
- `node tools/mobile-perf.mjs` 移动端交互性能探针(非断言型)

## Architecture
- 启动链:`index.html` 外壳 → `main.ts` 顶部按序 import(`ui-upgrade` 必须最先,否则监听会绑到被替换掉的旧节点)→ 子模块通过回调注入(main.ts 单向依赖它们,子模块不反向 import,避免循环依赖)。
- 动画数据:`?url` 按需 fetch;JSON 用 `import.meta.glob` / 显式导入。`vite.config.ts` 的 `manualChunks` 仍按动画把各自的 URL 模块拆开(历史上是为绕开 Cloudflare Pages 单文件 25MiB 上限)。新增动画按现有条目补一条匹配规则,保持产物结构一致。
- 渲染:lottie-web SVG / Canvas 两套,打了三类补丁(Canvas 文字兜底、图片序列驱动、feColorMatrix 叠加调色)。文字编辑走"即时写实例 + 180ms 防抖重建",其余编辑走双缓冲单飞重建(新实例画好再换,避免闪白)。
- 图标编辑:换图只改写资源地址(`applyIconUrlToScope`);「图标大小」缩放写图标图层自身 `ks.s`(这些动画的锚点就是图片中心,等比缩放不裁切、不挪位),每次必须从首次载入采集的出厂快照乘系数,不能就地把当前值再乘 —— 拖滑杆、切动画、合并/取消二次扫描都会反复应用,就地乘会指数级放大;位置暴露的主段(ind 5)与二次扫描(ind 105)各记一份,第二段源数据不缩放。
- 导出:`renderFrame` → WebCodecs 编码 → mp4-muxer;编码族是阶梯 **H.264 → VP9(软件编码,无 H.264 时仍离线逐帧、时长精确、浮层显示 `MP4 · VP9`)** → MediaRecorder 实时录制兜底(**墙钟计时,时长会被渲染速度拉长**:录制前先空跑两帧测成本并自适应降帧,录制后补容器时长、做静止画面自检)。透明走自封装 AVI(BGRA + 预乘 alpha),AVI 只支持 avc1,否则退 MJPEG;导出实例与预览实例完全隔离。移动端单次保存上限 120MB,桌面 256MB。
- 导出渲染器选择:共用轨道遮罩 / 亮度遮罩(tt:3)一律 SVG 逐帧光栅化(Canvas 会画错或构建不出来);"只是改过字"先探一帧 —— Canvas 有内容就用 Canvas(快一个数量级),空帧才回退光栅化。
- 图片编辑器:独立页 `#viewImage`,`start-screen.ts` 首次进入才动态 import `image-page`(连带 ag-psd、11MB 内置 PSD、4 张背景图与 190 张名片,不进动画编辑器首屏)。页面**只编辑内置结算图、只导出 PNG**:不提供打开其它 PSD、也不提供导出 PSD(需求边界)。`psd-document.ts` 用 ag-psd 读出图层树,children 的顺序**就是**绘制顺序(自下而上);未改动的文字图层直接画 PSD 缓存的像素,只改颜色时把原像素 alpha 当蒙版填新色,改内容才用 canvas 重排。画布与动画编辑器同一套视图模型:`baseScale`(contain 适配)× `viewZoom` + `viewPan`,滚轮以鼠标为中心缩放、拖动平移、双击复位;选中框是屏幕坐标的独立元素,不随缩放变粗。
- 图片编辑器导出后的结果卡是唯一的"长任务结论":成功显示文件名 + 「打开文件夹」,失败显示原因 + 「再试一次」;「打开文件夹」走 `dfaeDownloads.reveal(entry.id)`(缺 id 时退回 `dfaeDesktop.revealFile(path)`),顶栏保留同一入口。导出中按钮文案切「正在导出…」并禁用。
- 图片编辑器的背景图:4 张来自 `TFR-Studios/DFAsset` 的 `settlement/` 目录,已下载到 `pictures/settlement/backgrounds/` 并随构建打包(离线可用)。换背景时替换名字形如 `Settlement_Sp_*` 的整幅图层;这些 PNG 的手机屏幕是透明挖孔,原 PSD 靠紧贴背景下方的「形状 1」透出屏幕内容。所以 `image-page.ts` 会先合成一张"背景 + 挖孔补黑 + 屏幕内容缩放"的画布再交给渲染器 —— 否则换背景后屏幕边缘会露出透明缝。新增背景图只需改 `BACKGROUNDS` 数组。
- 图片编辑器的名片:190 张来自 `Commerical/BusinessFiller`(147)与 `Commerical/Skin`(43)。**打包只有 manifest + 160px 缩略图(约 1.7MB)**,原图运行时从 GitCode raw API 拉取(`card-remote.ts`:内存 → Cache Storage(键含 commit sha)→ raw API → 本地缩略图兜底);raw.gitcode.com 的 raw 路径会 302 占位图,必须走 `api.gitcode.com/api/v5/repos/<repo>/raw/<path>`(带 CORS)。**三种缩放方式**:`CARD_DEFAULT_QUAD` 是默认透视四角(1126,230 / 1454,279 / 1369,828 / 1030,771),名片画在底层场景之上。标题栏可切换 **等比 / 自由 / 透视**:等价比锁原图宽高比,自由宽高独立,透视按四角单应矩阵变形;框内拖动整体平移、顶部圆点绕中心旋转(Shift 15°)。读数:等比/自由显示 X/Y/宽高/宽高%/角度,透视显示 TL/TR/BR/BL 四角。名片只保留当前背景屏幕挖孔内的像素(视觉上位于手机边框下层,不盖边框/HUD),导出时同样裁切;导出前垫黑底,回归断言屏幕中心是名片颜色。「复位」回默认透视四角,「恢复默认」清掉名片。选择器是原生 `<dialog>` + 搜索/分类/懒加载网格 + roving tabindex;新增素材跑 `python tools/build-card-assets.py <DFAsset 根目录>`。
- Electron:`main.cjs` 只监听 127.0.0.1、端口交系统分配,把 `dist/` 当站点根;渲染进程无 Node 能力,IPC 全部具名。不能用 `file://` 代替 —— WebCodecs 安全上下文、`fetch`、HEAD 进度都依赖 http 源。
- 下载历史:清单存 `<userData>/download-history.json`(删软件仍在),文件缺失标 missing,靠相对路径 + 文件名 + 体积找回。
- 日志:一条采集主线;桌面端主进程写 `<userData>/logs/dfae.log`(JSONL,2MB 轮转一代),网页/手机只留内存。
- 音频:仅桌面;主进程解析 pak 后用 `vendor/vgmstream` 解码;koffi 原生模块必须随 electron-builder 的 `files` 发出。
- Tauri / Android:同一份 `dist/` + 注入桥;导出字节必须 base64 单串过 IPC(数字数组会 OOM,Raw 通道不支持),写 MediaStore 进系统相册;release 构建必须走内置服务,不能使用配置里的 dev URL。

## Conventions
- UI 文案与代码注释用简体中文;界面面向中文社区作者。
- 改 UI 必须满足 DESIGN_SPEC.md:颜色只取 `style.css` 的令牌,不在组件里写色值;交互色只用于主操作/选中/开关/焦点环;新增动效必须列入白名单表。
- `index.html` 的 id 与 `main.ts` 的 `$()` 常量一一对应;改名必须两边同步,否则取到 null 后静默失效。
- 字体地址用 `new URL(..., import.meta.url)`;不要用 `?url` 导字体(Vite 7 dev server 对字体 `?url` 返回 JS 模块而不是字体字节)。`vite-env.d.ts` 保持全局脚本(无顶层 import),否则 `?url` / `?raw` 通配声明失效。
- Electron 红线:不开 `nodeIntegration`、不给渲染进程 Node 能力;不把站点改成 `file://` 去"兼容"。
- 不要重跑 `npm run tauri android init`:会覆盖 `gen/android` 里已提交的定制(锁横屏、API<29 权限、清单)。
- PSD 图层像素必须用 `useImageData: true` 读:ag-psd 的 canvas 是预乘 alpha,拿它当蒙版改色会偏色/露边。
- 图片编辑器不要再加"打开本地 PSD / 导出 PSD"入口:需求就是编辑内置结算图并导出 PNG;加回来会重新引入 PSD 写回与烘焙的复杂度。
- 背景图与示例 PSD 都放 `pictures/settlement/`(背景在 `backgrounds/`),名片在 `pictures/cards/`,走 `?url` / `import.meta.glob` 由 Vite 输出。运行时拉 GitCode 的唯一例外是名片原图(`card-remote.ts`,用户明确要求在线取图):manifest + 缩略图仍必须打包兜底,其余素材不要依赖外网。
- `build/icon.ico` / `icon.png` / `splash.bmp` 是打包输入,必须提交;splash 固定 460×272,与 `electron/portable-splash.html` 改一边必须同步另一边。
- 版本号三处一起改,优先用 `scripts/bump-version.mjs`;发版说明写在 `docs/RELEASE_NOTES_v<版本>.md`,其中的安装包文件名必须匹配当前版本(CI 会校验)。
- 图片编辑器的页面 DOM 由 `image-page.ts` 在首次进入时生成(原生 `<button>`,不经过 `ui-upgrade` 的 Fluent 升级),样式全部收在 `image-page.css` 的 `.imged` 前缀下。
- 名片选择器的 backdrop 关闭只能判断 `ev.target === dialog`:键盘 Enter / 脚本 `.click()` 的坐标是 0,0,按坐标判断会把面板内部点击误判成点遮罩。
- 不要提交 `dist/`、`release/`、`release-assets*/`、keystore / keystore.properties。
- 动导出链路(编码族 / 录制 / 封装 / 文件名)必须跑 `verify-mobile-export.mjs` 的 recorder + noaac 用例与 `verify-export-fallback.mjs`;只跑桌面基准不够。
- 编码期异常一律经 `asVideoEncoderError` / `asAudioEncoderError` 归一后再抛:直接抛 DOMException 会跳过降级链,用户只看到一句 `EncodingError`。

## Pitfalls
- 分包规则匹配不到会静默退回默认分包:id 带 `?url` 查询串、Windows 路径是反斜杠。匹配前先 `split('?')[0].replace(/\\/g, '/')`;历史上这会让 JSON 回主 chunk 并撞上 25MiB 上限。
- 改了 `src/` 界面没变 → `npm run app:start` 不重建;用 `app:dev` 或先 `npm run build`。
- 便携版启动慢/启动图不动是 NSIS 阻塞解包的固有限制,不是漏做;要进度条与任务栏按钮用安装包。
- 远程桌面、虚拟机、禁用硬件加速常拿不到 H.264 编码器 → 先跑应用自检看报告里的 `page.h264` 与 `gpu.video_encode`。
- Android 模拟器通常没有 H.264 硬编、画布 MediaRecorder 也被禁,导出链路要用真机验证。
- 画布录制必须先确认 `track.requestFrame` 存在再 `captureStream(0)`:老 WebView(实测 Chrome 99/103)上它可能形同无效,成片只剩开始那一刻的背景。缺失时改用 `captureStream(fps)` 自动采样;两种取帧都只拿到静止画面就换路重录,别把纯色视频当成功交付。
- MediaRecorder 按墙钟计时:渲染慢 → 帧率低且时长被拉长(AVI 的 MJPEG 是离线编码,不受影响)。改这块要保住"自适应降帧"与"容器时长补写",否则用户会收到 0:00 或几十秒的慢放。
- MediaRecorder 产出的 WebM 天生没有 Duration,落盘前必须补(否则安卓相册显示 0:00);AVI 的 H.264 关键帧要重放 SPS/PPS,否则 seek 后报参数错误 / 花屏。
- 没有 H.264 时 MP4 会走 VP9 离线编码或降级成实时录制,后者落盘扩展名是 `.webm` —— 属预期,不是文件名 bug。
- 改字动画的强制光栅化在手机上实测约 245ms/帧(3.95s 动画被拉成 58s);不要删掉导出前的 Canvas 探测而重新"一律光栅化"。
- `tools/verify-mobile-export.mjs` 的 TMP 是硬编码绝对路径(`I:/Delta Force custom animation/tools/.mobile-test`),换机器/CI 前先改它,否则产物会写到别处。
- `tools/verify-devlog.mjs` 默认连 5174(其余脚本 5173),跑之前用 `--url http://127.0.0.1:5173/` 覆盖。
- `asar: false` 是有意为之(产物是 400+ 静态文件,便于核对/热替换),不要当警告"修复"。
- `.bat` 里的中文按**当前控制台代码页**解码:文件存 GBK、开头 `chcp 936`;`more` 和部分外部命令会把代码页切成 65001,之后 cmd 按 UTF-8 解批处理里的 GBK,中文全变「锟斤拷」。回放日志用 `type`,并在每条外部命令之后补 `chcp 936 >nul`。
- `.bat` 里把右括号转义成 `^)`(如 `(echo ...^)>> 日志`)会让 cmd 找不到收尾括号、一路读到文件尾并以退出码 255 中止整批,后面的 `pause` 不执行——构建一失败窗口就瞬间关闭。写日志改用 `>> "文件" echo ...`,或右括号不转义。
- `tools/` 里 200+ 脚本多为一次性排障;复用前先看文件头是否标「常驻」,别把一次性诊断当回归。
- 图片编辑器舞台的 `pointerdown` 会 `preventDefault()` + `setPointerCapture()`,浮层控件(导出结果卡、缩放条、空状态)只要没在 `isStageUi()` 里放行,里面的按钮就永远收不到 click;这类回归必须用 `page.mouse.click` 真实点,脚本 `.click()` 绕过 pointerdown 查不出来。
- `tools/check-downloads.mjs` 头部用法行写的是旧文件名 `verify-download-history.mjs`,以实际文件名为准。

## Maintenance
- 只写可复用事实与持久规则;命令、路径、阈值变了就改对应条目,不追加日期、一次性排障记录或出处标注。
- 条目按使用频率排序;删除已失效或指向已删除文件的条目。
