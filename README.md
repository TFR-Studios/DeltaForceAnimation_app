# 三角洲行动动画编辑器 · Windows + Android

把八套已经做好的游戏动画(Lottie / JSON)变成普通人也能改的东西:预览、改文字、改颜色、换图标、
调时长,再导出成带音频的 MP4 / AVI。**Windows 端与 Android 端共用同一份前端产物**,
平台差异全部收在编译期与运行期分支里(见[两个外壳,一份前端](#两个外壳一份前端))。

| 平台 | 外壳 | 发布形态 | 入口 |
|---|---|---|---|
| **Windows**(主推) | Electron 31.7.7 / Chromium 126 | 免安装目录 **296 MB** / 便携版单文件 **~88 MB** / 一键安装包 **~88 MB** | 双击 **`启动应用.bat`**,或直接跑 `release\win-unpacked\三角洲行动动画编辑器.exe` |
| **Android 手机 / 平板** | Tauri v2 / 系统 WebView | debug APK(内测包,**288 MB**) | `npm run tauri android build -- --apk`(见 [Android 端](#android-端tauri-v2)) |
| Windows(Tauri 外壳) | Tauri v2 / WebView2 | 与 Android 同一份 Rust 外壳 | `npm run tauri build` —— **不是发布形态**,桌面请用 Electron 那套 |

| | |
|---|---|
| **运行内核** | Windows:Electron 自带的 Chromium 126(H.264 硬件编码可用);Android:系统 WebView |
| **完整功能说明** | [docs/FEATURES.md](docs/FEATURES.md) —— 上游网页版 673 行功能文档存档 |

> 上游网页版:在线站点 <https://df.tfr-studio.top> · 仓库 <https://github.com/TFR-Studios/DeltaForceAnimation>
> **制作声明**:内置动画均由人工使用 **AE** 制作,未使用 AI 辅助。
> **素材版权**:动画素材(JSON / PNG / 音频)来源于游戏,开源或商用前请自行确认授权。

---

## 目录

- [两个外壳,一份前端](#两个外壳一份前端)
- [快速上手](#快速上手)
- [Windows 端比网页版多了什么](#windows-端比网页版多了什么)
- [Android 端(Tauri v2)](#android-端tauri-v2)
- [构建与打包(维护者)](#构建与打包维护者)
- [自助工具(双击就能用)](#自助工具双击就能用)
- [发版(打标签 → CI 自动出包)](#发版打标签--ci-自动出包)
- [同步到 GitCode(代码 + 发行版同一个仓库)](#同步到-gitcode代码--发行版同一个仓库)
- [命令一览](#命令一览)
- [目录结构](#目录结构)
- [桌面外壳实现要点](#桌面外壳实现要点)
- [下载列表与下载历史](#下载列表与下载历史)
- [界面布局审计(比例/对齐/溢出)](#界面布局审计比例对齐溢出)
- [自检:一条命令验证"产物是不是好的"](#自检一条命令验证产物是不是好的)
- [常见问题](#常见问题)
- [已知边界](#已知边界)
- [License 与素材版权](#license-与素材版权)

---

## 两个外壳,一份前端

原项目是一个**纯静态单页站点**(Vite + TypeScript,`src/main.ts` 513 KB),构建产物 `dist/` 直接扔到静态托管上即可。
本仓库**没有重写任何前端逻辑**,而是给同一份 `dist/` 套了两层外壳 —— 一层给 Windows,一层给 Android:

```text
网页版:      dist/  →  静态托管                        →  浏览器打开
Windows 端:  dist/  →  electron/main.cjs 内置静态服务  →  Chromium 窗口
Android 端:  dist/  →  Tauri v2 的 asset 协议 + 注入桥接层 →  系统 WebView
```

平台差异只有三处,**都不在业务代码里**:

| 差异 | Windows(Electron) | Android(Tauri v2) |
|---|---|---|
| Rust 主进程 | `#[cfg(dfae_desktop)]` | `#[cfg(dfae_mobile)]` |
| 前端界面 | 默认布局 | `html[data-ui="mobile"]` + `IS_MOBILE`(见 `src/mobile.ts` / `src/mobile.css`) |
| 导出落盘 | 系统「下载」文件夹 + 下载历史 | 系统相册(MediaStore) |

**为什么不能直接把 `index.html` 用 `file://` 打开**(这是整件事最关键的一点):

1. 站点里的动画 JSON、音频、字体都是 `fetch()` 按需拉的。`file://` 下这些请求会被 CORS 拦掉,
   **一个资源都加载不到**;
2. 导出用 WebCodecs(`VideoEncoder` / `AudioEncoder`),它**只在不透明源或安全上下文**里可用。
   `file://` 的安全上下文判定在各版本 Chromium 里反复变过,不能指望;
3. `fetch(url, { method: 'HEAD' })` 读 `Content-Length` 算加载进度(切换动画时的进度浮层就靠它)。
   `file://` 下连 HEAD 都不成立。

所以 `electron/main.cjs` 自己起了一个**只监听 `127.0.0.1`、端口交给系统随机分配**的迷你静态服务,
把 `dist/` 当站点根目录 —— 等价于原来那条 `npm run preview`,只是不需要用户先敲命令、也永远不会和别的程序抢 5173。
桌面版因此拿到了一个真正的 `http://127.0.0.1:<随机端口>` 源:安全上下文成立、fetch 正常、HEAD 正常、
WebCodecs 正常,而端口随机意味着**不存在"端口被占用"这种故障**。

---

## 快速上手

### 方式一:免安装版(推荐)

```text
release\win-unpacked\三角洲行动动画编辑器.exe
```

整个 `win-unpacked` 文件夹就是完整应用(296 MB / 479 个文件),**拷到任何地方双击即用**,不写注册表、不需要安装。
也可以双击根目录的 `启动应用.bat`,它会优先找这个。

### 方式二:便携版单文件

```text
release\DeltaForceAnimationEditor-Portable-<版本>.exe        (约 88 MB)
```

单个 exe,拷贝/U 盘/发人都方便。**它每次启动都要先把自己解压到 `%TEMP%\DeltaForceAnimationEditor`** ——
这台机器上实测 **65 秒**才出界面(解压 170 MB + 杀软扫描,机器不同差别很大),所以:

- 想要「双击就开、有进度条、能 Alt+Tab」→ 用下面的**一键安装包**(装一次,之后启动约 1 秒);
- 只想解压一次、以后都快 → 用**免安装版**(上面方式一)。

> 解压那段时间屏幕上那张 460×272 的图由 NSIS 解包器显示(`build/splash.bmp`),**它不会有动画**:
> NSIS 解压是阻塞的,这一阶段没有任何东西能重绘窗口;而且它的窗口是 toolwindow —— 任务栏没有按钮、
> Alt+Tab 里也看不到。这是便携版形态的固有限制,不是漏做。

### 方式三:一键安装包

```text
release\DeltaForceAnimationEditor-Setup-<版本>.exe
```

双击即装(装到当前用户目录,不需要管理员权限),安装器是标准 NSIS 窗口:**有真实进度条、任务栏有按钮、
Alt+Tab 可见**;装完自动启动,之后从开始菜单/桌面快捷方式打开约 1 秒 —— 不再有解压等待。
不想用了在「设置 → 应用」里正常卸载(用户数据目录默认保留)。

### 方式四:开发模式(改代码时用)

```bash
npm install      # 首次:装依赖(Electron 约 110 MB)
npm run app:dev  # 起 vite dev server + Electron,改 src/ 热更新
```

或者直接双击 `开发模式.bat`。

### 方式五:Android(手机 / 平板)

现阶段还没有签名好的 release 包,APK 要自己构建(完整步骤见 [Android 端](#android-端tauri-v2))。最短路径:

```powershell
npm run tauri android build -- --debug --apk -t aarch64
adb install -r -t src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

装上以后**导出的视频会直接进系统相册**里的「三角洲行动动画编辑器」相册,**不需要授予任何存储权限**(Android 10 及以上)。

> 开发模式从 **5173** 起挑第一个空闲端口(和上游「启动网站.bat」的策略一致),所以即使 5173 上跑着别的项目
> (比如上游网页版自己的 dev server)也不会串台 —— 它会顺延到 5174,并把真实地址注入给 Electron。

### 系统要求

| 平台 | 要求 |
|---|---|
| **Windows** | Windows 10 x64(1809 及以上)/ Windows 11;无需 Node.js(除非自己构建)、无需联网;**需要能跑图形加速的环境** —— 导出走 WebCodecs 硬件编码,远程桌面 / 部分虚拟机里可能拿不到编码器,这时会自动降级(见[常见问题](#常见问题)与 [docs/FEATURES.md](docs/FEATURES.md) 的「兼容导出」)。 |
| **Android** | Android 7.0(API 24)及以上,`arm64-v8a`(现在的 APK 只打了这一个 ABI)。真机上 H.264 硬编可用;模拟器往往没有硬编,会退到兼容录制。 |

> **首次运行可能遇到 SmartScreen**:产物没有代码签名证书,Windows 会提示"已保护你的电脑" → 点「更多信息」→「仍要运行」。
> 想避免这条提示只能用受信任的证书给 exe 签名(见[已知边界](#已知边界))。

---

## Windows 端比网页版多了什么

前端的编辑能力一字未改,下面这些是桌面外壳带来的差异(表格里都写了"为什么"):

| 桌面端行为 | 说明 / 为什么 |
|---|---|
| **双击即用** | 不用装/挑浏览器,不用起服务器。内核固定是 Electron 自带的 Chromium 126。 |
| **完全离线** | 动画 JSON / 图片 / 音频 / 字体全部打包进应用(`dist/` 38.3 MB / 402 个文件),切换动画读的是本地文件。 |
| **系统原生"另存为"** | 想在每次导出时自己挑位置,就在「下载列表」面板里勾上「每次询问保存位置」—— 那时弹的是 Windows 保存对话框(默认落到下载文件夹、预填文件名、按格式过滤)。默认不勾,见下一条。 |
| **下载列表 + 下载历史** | 顶栏「下载列表」按钮:每次导出的视频自动落进**系统「下载」文件夹 → `三角洲行动动画编辑器\`**,不再弹框;文件名是「动画名 + 时间戳」,重名自动加 `(1)(2)`。列表里可搜索、资源管理器定位(文件夹图标)、移除记录;**两个动作都是矢量图标按钮**(悬停有文字提示),行首是文件类型图标。改名与播放不放在列表里:文件名已经是「动画名 + 时间戳」,要改要播直接在资源管理器里更顺手,列表里少两个按钮,名字列就能多显示十几个字。导出浮层里会同步显示"这次下载的文件"与进度,导出成功后自动打开下载列表并把新记录高亮。**历史清单存在 `%APPDATA%` 下、产物存在下载文件夹里,所以删掉软件、把软件搬到别的盘、甚至重装之后,历史与视频都还在**(详见[下载列表与下载历史](#下载列表与下载历史))。 |
| **导出完成有系统通知** | 存完发一条 Windows 通知,**点通知直接在资源管理器里定位到文件**。 |
| **窗口大小记忆** | 下次打开还是上次的位置和尺寸(含是否最大化),记在 `%APPDATA%\三角洲行动动画编辑器\window-state.json`。 |
| **单实例** | 重复双击只把已有窗口拿到前台,不会开出第二个应用。 |
| **启动第一屏只有两处图形** | 不做"Electron 启动后再弹一个自己的悬浮窗":Electron 一起来、窗口第一帧画出来,屏幕上直接就是编辑器自带的加载层(`#app-loading`:终端式日志 + 22 格方块进度条),那才是真正的加载反馈。唯一在它之前出现的是**便携版解包期的一张静态图**(`build/splash.bmp`)—— 它由 NSIS 解包器显示,和应用加载层同一套配色/字体/方块条,所以两屏接得上;那张图没有动画、也没有任务栏按钮(工具窗口),这是 NSIS 解包的固有限制,想避开就用安装包或免安装版。 |
| **中文菜单(Alt 唤出)** | 文件(打开导出文件夹 / 数据目录 / 退出)、视图(重载 / 开发者工具 F12 / 缩放 / 全屏)、帮助(在线站点 / 关于)。 |
| **导出不被后台节流** | `backgroundThrottling: false`:窗口被最小化或挡在后面时,Chromium 不会把渲染/计时器降频 —— 长导出不会被拖慢。 |
| **音频不被自动播放策略拦** | 加了 `autoplay-policy=no-user-gesture-required`:桌面应用没有"用户手势"语义,不加这条预览音效会静默拒播。 |
| **外链交给系统浏览器** | 页面里的外链不会在应用窗口里打开,而是交给默认浏览器;应用窗口只跑编辑器。 |
| **三件套自检** | `--smoke` 能把"环境 / 编码能力 / 资源加载 / 界面 / 真实导出"一次测完并出报告(见下文)。这是桌面版最实用的排障入口,网页版没有对应物。 |
| **仍是同一份前端产物** | `release\win-unpacked\resources\app\dist\` 就是那个 `dist/`(没有打成 asar),想核对"跑的是不是最新构建"可以直接翻这个目录。 |

> **没有做的事**:没有加自动更新、没有加安装包、没有做代码签名、没有改任何前端逻辑。
> 前三条是刻意留白(离线工具 + 无签名证书的场景下,自动更新的收益远小于复杂度),需要的话见[已知边界](#已知边界)。

---

## Android 端(Tauri v2)

### 构建前置

| 组件 | 本次验证用的版本 | 说明 |
|---|---|---|
| NDK | **r25**(`25.2.9519653`) | 由 cargo 的 clang 链接器使用。**项目路径不能带空格** —— 这是 NDK r25 的硬限制,放到 `Program Files` 下面那类路径一定会失败 |
| Android SDK | `platforms;android-37.0` + `build-tools;37.0.0` + `platform-tools` | `gen/android` 里是 `compileSdk = 37`;只装 `cmdline-tools` 是不够的 |
| JDK | 17 或 21(`JAVA_HOME`) | Gradle 9.6.1 / AGP 9.3.1 |
| Rust 目标 | `rustup target add aarch64-linux-android` | 目前只打 arm64 一个 ABI |
| 环境变量 | `NDK_HOME` / `ANDROID_NDK_HOME` → NDK 绝对路径 | Tauri CLI 靠它定位 NDK |

缺 SDK 组件就补:

```powershell
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" "platforms;android-37.0" "build-tools;37.0.0" "platform-tools"
```

### 构建与安装

```powershell
# 调试包(先只编 arm64,快)
npm run tauri android build -- --debug --apk -t aarch64

# 装到设备 / 模拟器并启动
adb install -r -t src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
adb shell am start -n top.tfrstudio.dfae.tauri/.MainActivity

# 真机热重载调试
npm run tauri android dev
```

> **别重复跑 `npm run tauri android init`**:`gen/android` 已经生成好并且**提交进了仓库**,
> 重跑会覆盖掉里面本项目的定制(MainActivity 的平板锁横屏与权限请求、AndroidManifest 的权限声明)。
> `gen/android/.gitignore` 已经把 build/、.gradle/、local.properties、keystore.properties 排除在外,
> 所以进仓库的是源码级的 Android 工程,不含构建产物(约 1 MB / 65 个文件)。

### 导出落在哪:系统相册

Android 端的导出**不写应用私有目录,而是直接进系统相册**(MediaStore):

| 项 | 值 |
|---|---|
| 相册归属 | `Movies/三角洲行动动画编辑器/` —— 系统图库 / Google Photos / 各家 ROM 相册都能看到 |
| 权限 | **Android 10(API 29)及以上:零权限**。分区存储下应用往 MediaStore 插入自己的媒体项就是官方路径,不需要也不该申请 `WRITE_EXTERNAL_STORAGE` / `MANAGE_EXTERNAL_STORAGE` |
| Android 9 及以下 | 写公共目录才需要 `WRITE_EXTERNAL_STORAGE`。清单里已声明并带 `android:maxSdkVersion="28"`(新版系统上不会出现在权限列表里),启动时请求一次,不在导出中途打断 |
| 实现 | `src-tauri/src/mediastore.rs` —— JNI 调 `ContentResolver.insert` + `openOutputStream`,`is_pending` 两段式写入(图库不会扫到半个文件),写完读回系统最终采用的显示名 |

**为什么不能只写文件路径**:相册只索引 MediaStore 里的媒体项,写进应用私有目录就是"导出成功但相册里找不到"。

### 导出字节是怎么过 IPC 的

产物从 WebView 交给 Rust 时走 **base64 单串**(见 `webview/dfae-bridge.js` 的 `saveToGallery` 与 `ipc.rs` 的 `base64_decode`):

- **不能用数字数组**(`{ bytes: [0..255, ...] }`):Rust 侧会先把它建成整棵 `serde_json::Value` 树(每个元素约 16 字节),30 MB 的导出就是约 5 亿字节,手机进程必然 OOM;
- **也不能用 Tauri 的 Raw 通道**:本应用的 IPC 走 WebView 的 `postMessage` 那条(没有 custom protocol),它只支持 JSON —— 实测把 `Uint8Array` 当载荷会被 stringify 成 `{"0":..,"1":..}`,后端根本拿不到 `bytes`;
- base64 字符串在 `Value` 里只是一段连续内存,没有逐元素开销。实测 **1 MB / 8 MB / 25 MB 分别 0.2 s / 0.6 s / 1.7 s** 落进相册;
- 上限 **120 MB**(`MOBILE_INLINE_SAVE_MAX`,见 `src/main.ts`):再大就明确报错,而不是静默退回 `<a download>` —— Android WebView 没有实现下载监听,那条路是死的。

### 桥接层为什么要重试注入

桌面端有 `initialization_script`,每个文档加载前自动跑一遍;Android 上没有等价物,Rust 只能在 `setup` 里 `eval` 一次 —— 而那一刻 WebView 还没开始加载真正的页面,脚本打在空文档上,随文档被替换就丢了。表现是 `window.dfaeDownloads` 永远不存在,于是导出走 `<a download>`,而 WebView 里没有下载监听:**提示"导出完成",文件却哪儿都没有**。

现在的做法:`setup` 里注入一次,然后起一个线程每 250 ms 重试一次,**直到收到桥接层自己的回执**(`dfae_bridge_ready`)。桥接层开头有幂等判断(`if (window.dfaeDesktop && window.dfaeDownloads) return;`),重复注入无副作用。日志里会看到:

```text
[dfae] 桥接层已确认落位(第 2 次尝试)
```

### 移动端界面与手势

- **竖屏**:侧栏变成底部可拖拽面板 + 横向滚动的分区芯片,替换桌面那条动辄 5900px 的长滚动;
- **横屏 或 宽度 ≥ 1024**:面板改成右侧停靠栏,同一个把手改成拖宽度;
- **画布手势**:单指拖动平移(带惯性滑行)、双指捏合缩放(以两指中点为焦点)、双击在适配与 2.5× 之间切换、长按复位视图、单击播放暂停;
- 触摸目标一律 ≥ 44px,处理刘海与手势条的安全区,禁掉下拉刷新与页面双击缩放;
- 手机端**没有「下载列表」**:落点是系统相册,而列表里那套「定位 / 打开 / 重命名」对 `content://` URI 没有对应能力,所以整条通路在移动端关闭,导出完成后**停在原页面**。

### 平板:锁定横屏

`gen/android/.../MainActivity.kt` 里按 **`smallestScreenWidthDp >= 600`**(Android 官方的平板档;折叠屏展开后会自动落到同一条策略)设 `sensorLandscape`:平板永远横屏,手机不受影响。用 `sensorLandscape` 而不是 `LANDSCAPE`,是为了允许 180° 翻转(平板倒过来拿时界面不会上下颠倒)。

### 已验证 / 未验证

| 项 | 状态 |
|---|---|
| 构建 → 安装 → 启动 → 桥接层注入 | ✅ 实测(MuMu 模拟器 / Android 15 / API 35) |
| 导出字节 → 相册(1 / 8 / 25 MB,以及一份真实的 0.48 MB MP4) | ✅ 实测:MediaStore 里有记录,磁盘落在 `/storage/emulated/0/Movies/三角洲行动动画编辑器/`,`content://` 用系统图库的播放器能正常出画 |
| 平板自动锁横屏 | ✅ 实测(把模拟器改成 sw800dp 后,即使系统开着自动旋转,应用仍是横屏) |
| **完整导出链路(编码 → 落相册)** | ❌ **没在设备上跑通** —— MuMu 的 WebView 既没有 H.264 硬编(WebCodecs 路径不可用),画布 MediaRecorder 也被禁,编码那一步必然失败,与保存无关。真机上应该正常,但需要用自己的手机验一次 |
| API 24–28 的老设备 | ❌ 只有代码层面的准备,没有真机验证 |
| 签名 release 包 / AAB | ❌ 尚未做,需要先建 keystore(`gen/android/keystore.properties`) |

---

## 构建与打包(维护者)

### 一键构建

双击 **`构建应用.bat`**,它会依次做:检查 Node → 装依赖 → `npm run build` → 生成图标 → `electron-builder` 打包 → 清理旧版本安装包。

版本号**只从 `package.json` 读**,构建开始时会打印当前版本,结束时会按这个版本号清理 `release\` 里别的版本
(1.0.0 / 1.0.1 …)的 exe / zip。所以不会再出现「日志写着 1.0.0、实际产物是 1.0.2」或「点到了旧版 exe」的错位。

### 命令行分步

要求 **Node.js ≥ 20**(推荐 22,仓库自带 `.nvmrc` = 22)。本次产物的构建环境:Node **v24.11.1** / npm 11.19.0。

```bash
npm install        # 装依赖(含 Electron 31.7.7、electron-builder 24.13.3)
npm run build      # 类型检查 + Vite 构建 → dist/
npm run icons      # public/logo.svg → build/icon.ico + icon.png;并把 electron/portable-splash.html
                   # 渲染成 build/splash.bmp(便携版解压时那张图)。换 logo / 改那张图后才需要重跑
npm run dist       # 打包:免安装目录 + 便携版单文件 + 一键安装包,结束后清理旧版本包
```

`npm run dist` 的产物:

```text
release\
├── win-unpacked\                              # 免安装版(296.6 MB / 479 文件)
│   ├── 三角洲行动动画编辑器.exe                #   172.8 MB,带自定义图标与版本信息
│   └── resources\app\{dist,electron,package.json}
├── DeltaForceAnimationEditor-Portable-<版本>.exe  # 便携版单文件(约 88 MB,每次启动先解包)
├── DeltaForceAnimationEditor-Setup-<版本>.exe     # 一键安装包(约 88 MB,有进度条、装完启动 1 秒)
└── smoke\                                     # 自检报告(跑过 app:smoke 才有)
```

> **依赖下载慢/卡住**:Electron 二进制(约 110 MB)与 electron-builder 的辅助包(winCodeSign / NSIS)默认从 GitHub 拉,
> 国内网络容易卡。`构建应用.bat` 与 `开发模式.bat` 里已经预置了 npmmirror 镜像环境变量
> (`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`);在命令行手工装的话自己 `set` 一下即可,
> 或者删掉这两个变量走直连。

### 打包配置在哪

全部在 `package.json` 的 **`build`** 字段里(没有单独的 electron-builder 配置文件),几个关键取舍:

| 配置 | 值 | 为什么 |
|---|---|---|
| `win.target` | `dir` + `portable` + `nsis` | 三种形态各管一件事:**dir** = 免安装目录(解压即用、启动快),**portable** = 单文件随身带(代价是每次启动先解包),**nsis** = 一键安装包(装一次之后启动 1 秒,安装器有真实进度条、任务栏可见)。 |
| `nsis.oneClick` / `perMachine` | `true` / `false` | 一键安装、装到当前用户(`%LOCALAPPDATA%\Programs\…`,不弹 UAC),装完自动启动;卸载走系统「应用和功能」。 |
| `portable.splashImage` | `build/splash.bmp` | 便携版解包时那张静态图。NSIS 解包是阻塞的,所以只能是静态图(详见[快速上手](#方式二便携版单文件))。 |
| `portable.splashImage` 的尺寸 | 460×272 | NSIS 会把 BgImage 窗口调成图片尺寸;图由 `electron/portable-splash.html` 按这个尺寸渲染(见 `electron/make-icons.mjs`),改一边必须同步另一边。 |
| `asar` | `false` | ⚠️ electron-builder 会警告"不建议关闭 asar"。这里是有意为之:产物是 400+ 个静态资源文件,关掉 asar 后 `resources\app\dist\` 保持普通目录,方便核对/热替换产物,也避开 asar 路径下的一些边角问题。 |
| `signAndEditExecutable` | `true` | 需要它才能把 `build/icon.ico` 与版本信息写进 exe。**代价**:构建时要下载 winCodeSign 辅助包(约 5.6 MB)。 |
| `productName` | `三角洲行动动画编辑器` | 决定 exe 名、任务栏名、通知来源名。 |
| `portable.unpackDirName` | `DeltaForceAnimationEditor` | 便携版解压到 `%TEMP%` 时用**纯 ASCII** 目录名,避免中文路径在个别环境下的坑。 |
| `files` | `electron/**` + `dist/**` + `package.json` | 源码(`src/`、`animations/`、`tools/`)不进产物 —— 产物里只有"跑起来需要的东西"。 |

---

## 发版(打标签 → CI 自动出包)

[.github/workflows/release.yml](.github/workflows/release.yml) 已经配好:打一个 `v*` 标签,GitHub 会开两个 runner 分别出包,并自动建 Release 把附件挂上去。

### 一次性配置(两个 Secret)

| Secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | 签名密钥的 base64。在项目根目录跑一行拿到:
`[Convert]::ToBase64String([IO.File]::ReadAllBytes("src-tauri\gen\android\dfae-release.keystore"))` |
| `ANDROID_KEYSTORE_PASSWORD` | `src-tauri\gen\android\keystore.properties` 里 `storePassword` 的值 |

加到仓库的 `Settings → Secrets and variables → Actions → New repository secret`。
本地那份 `keystore.properties` 与 `.keystore` **不在仓库里**(`.gitignore` 挡住了),不要提交。

> ⚠️ **把 keystore 备份到仓库之外**(私有仓库 / 网盘都行)。Android 要求同一个应用的后续版本必须用同一把密钥签名 ——
> 密钥丢了,老用户就只能卸载重装才能升级。

### 发一版

版本号散在三个文件里,标签名又必须等于版本号 —— 这些约定都收进了 [scripts/bump-version.mjs](scripts/bump-version.mjs):

```powershell
# 一条命令:改三个文件的版本号 + 按提交记录起草发布说明
node scripts/bump-version.mjs patch --notes     # 1.0.1 → 1.0.2
```

| 参数 | 作用 |
|---|---|
| `patch` / `minor` / `major` | 自动升版本号 |
| `x.y.z` | 直接指定版本号 |
| `--notes` | 顺便按提交记录起草 `docs/RELEASE_NOTES_v<版本>.md` |
| `--notes-only` | 只起草发布说明,不动版本号 |
| `--write` | 说明文件已存在时也覆盖(默认保留你手改过的内容) |
| `--dry-run` | 只预览,不写文件 |

它会改好 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`(只动 `[package]` 段,不碰依赖),
并按标签名写好发布说明文件。**起草完记得手改成给用户看的话**。

然后照常提交并推标签:

```powershell
git add -A
git commit -m "chore: v1.0.2"
git push
git tag v1.0.2
git push origin v1.0.2
```

> 想手动改版本号也没问题,但流水线会校验:**三处版本号必须一致,且标签名去掉 `v` 之后必须等于它们**。

> **流水线的第一道闸就是校验版本号**([scripts/check-version.mjs](scripts/check-version.mjs)):
> 三处版本号必须完全一致,而且**标签名去掉 `v` 之后必须等于它们**。
> 还会检查 `docs/RELEASE_NOTES_v<当前版本>.md` 里的安装包文件名 —— 写了别的版本会直接失败
> (v1.0.2 的说明曾整段沿用 v1.0.1 的文件名,用户照着下会 404)。
> `README.md` / `docs/FEATURES.md` 里的旧版本示例只提示、不拦截。
> 对不上会立刻报错并停止 —— 不会白跑十分钟打包,更不会打出「标签叫 v1.0.2、包名却是 1.0.1」的包。
> 手动触发(`workflow_dispatch`)时没有标签可比,只校验三处版本号互相一致。

CI 产出四个附件:

| 附件 | 说明 |
|---|---|
| `DeltaForceAnimationEditor-Portable-<版本>.exe` | Windows 便携版单文件(约 88 MB,每次启动先解包) |
| `DeltaForceAnimationEditor-Setup-<版本>.exe` | Windows 一键安装包(约 88 MB,**推荐**,有进度条、装完启动 1 秒) |
| `DeltaForceAnimationEditor-<版本>-win-unpacked.zip` | Windows 免安装版 |
| `dfae-<版本>-arm64-v8a.apk` | Android **release 签名包**(约 27 MB,含 `arm64-v8a`) |

不想发 Release、只想出包:到 Actions 页面手动 `Run workflow` —— 手动触发只上传 artifacts,不发 Release。

### 本地出签名包

```powershell
npm run tauri android build -- --apk -t aarch64
# 产物:src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk
```

体积对比:**debug 288 MB → release 26.9 MB**(调试符号与未优化代码去掉之后)。

---

## 同步到 GitCode(代码 + 发行版同一个仓库)

GitCode 上只有一个仓库:

**[TFR-Studios/DeltaForceAnimation_app](https://gitcode.com/TFR-Studios/DeltaForceAnimation_app)**
—— 普通仓库(不是镜像仓库),代码和发行版都放在这里。

> 原来的只读镜像仓库已经删除;v1.0.1 / v1.0.2 的旧发行版也一起清掉了。
> 从 **v1.0.3** 开始,这里同时承载代码、标签和发行版。

### 代码:GitHub → GitCode

GitCode 不再用「Pull 镜像」,因为镜像仓库是只读的,不能建新标签/发行版。
改成两条推送路径:

1. **GitHub Actions 自动推**:[.github/workflows/mirror-gitcode.yml](.github/workflows/mirror-gitcode.yml)
   在每次 push `main` 或 `v*` 标签时,把对应提交/标签推到 GitCode;
2. **本地工具推**:`管理工具.bat` → **1「提交代码」** 会先推 GitHub,再推 GitCode;
   **2「发布新版本」** 会把分支和标签都推到两边,然后才触发云端打包。

> ⚠️ 不要在 GitCode 项目设置里重新添加 Pull 镜像 —— 镜像仓库会重新变成只读,
> 发行版又会被 "image repository" 拦住。

### 安装包:由 CI 自动同步

[.github/workflows/release.yml](.github/workflows/release.yml) 的 `publish` 作业会:

1. 先把代码和标签强制推到 GitCode(保证发行版不会落到旧提交上);
2. 建 GitHub 发行版并挂附件;
3. 用 [scripts/publish-to-gitcode.mjs](scripts/publish-to-gitcode.mjs) 把同一批附件传到
   [GitCode 发行版](https://gitcode.com/TFR-Studios/DeltaForceAnimation_app/releases)。

需要配一个 Secret:

| Secret | 内容 |
|---|---|
| `GITCODE_TOKEN` | GitCode 的私人令牌(GitCode 右上角头像 → 设置 → 访问令牌) |

**没配令牌会让流水线在最后一步失败**(GitHub 发行版仍然会建好,但工作流是红的) ——
这是故意的:以前缺令牌时只打一条黄色警告就 `exit 0`,于是 **v1.0.2 在 GitHub 上有包、GitCode 一直停在 v1.0.1**,
而整条流水线看上去还是成功的。

本地也能手动跑(脚本是幂等的:同名附件先删再传,发行版说明就地更新):

```bash
# 默认目标就是 DeltaForceAnimation_app,不用额外指定
GITCODE_TOKEN=xxx node scripts/publish-to-gitcode.mjs v1.0.3 release-assets
```

### 已经漏掉的版本怎么补

不用重新打包。三种方式任选:

1. **Actions 页面 → Sync to GitCode → Run workflow**,填标签(如 `v1.0.3`)。
   它会先用仓库里的 `docs/RELEASE_NOTES_v1.0.3.md` 修正 GitHub 发行版说明,再从 GitHub 下载附件传到 GitCode,
   见 [.github/workflows/sync-gitcode.yml](.github/workflows/sync-gitcode.yml);
2. **管理工具.bat → 5「从 GitHub 补同步到 GitCode」**(需要本地有 `GITCODE_TOKEN` 或按提示粘贴令牌);
3. 手工先把附件下到 `release-assets\`,再跑上面的命令。

> [.github/workflows/sync-gitcode.yml](.github/workflows/sync-gitcode.yml) 每天 03:17 UTC 会兜底跑一次,
> 把最新版本缺失的附件补齐;已存在且大小一致的会跳过。

### 软件怎么做更新检查

GitCode 的接口**不用登录就能读**,直接问它「最新发行版是哪个」:

```
GET https://api.gitcode.com/api/v5/repos/TFR-Studios/DeltaForceAnimation_app/releases/latest
```

返回里带着版本号(`tag_name`)和每个安装包的下载地址(`assets[].browser_download_url`)。
字段名与 GitHub 一致,所以两端的解析逻辑可以共用一套。

> **两个平台的更新方式不一样**:
> Windows 可以做成真·自动更新(下载新 exe 替换自己);
> Android **做不到静默更新** —— 系统不允许 App 自己装自己,只能下载 APK 后跳到系统安装界面,让用户点「安装」。

---

## 自助工具(双击就能用)

根目录有三个启动器,不用碰命令行:

| 双击 | 作用 |
|---|---|
| **[管理工具.bat](管理工具.bat)** | 打开带菜单的中文界面,所有功能都在里面 |
| **[提交代码.bat](提交代码.bat)** | 直接进入「提交代码」 |
| **[发布新版本.bat](发布新版本.bat)** | 直接进入「发布新版本」 |

管理工具的菜单长这样:

```
  版本 v1.0.3   分支 main   改动 干净
  最新标签 v1.0.3   与 GitHub 一致

  1  提交代码
     把改动提交并同时推送到 GitHub + GitCode(不含打包)

  2  发布新版本
     改版本号 → 起草说明 → 提交 → 打标签 → 推送 GitHub + GitCode → 云端自动打包发布

  3  上传安装包到 GitCode
     把本地打好的包补传到某个版本的发行版

  4  检查发布状态
     对比 GitHub 与 GitCode 两边的安装包

  5  从 GitHub 补同步到 GitCode
     某个版本只在 GitHub 发过、GitCode 缺安装包时,一键下载并补传

  0  退出
```

做完一件事会回到菜单,可以连着做几件。

### 为什么界面在 Node 里,而不是写在 .bat 里

`.bat` 里写中文会被 cmd 的代码页撕裂 —— 实测会报 `'装' is not recognized as an internal or external command`,
连字形都被拆坏了。所以界面全部放在 [scripts/dfae-cli.mjs](scripts/dfae-cli.mjs) 里(Node 在 Windows 控制台输出 UTF-8 没问题),
`.bat` 只负责启动,里面一个中文字符都没有。

### 「上传安装包到 GitCode」干什么用

正常发版时安装包会自动同步到 GitCode 仓库,这个功能是**补传**用的:
比如某个版本当初只在 GitHub 发过、GitCode 上没有包,或者从别处拿到了新的安装包,可以用它手动补齐。

它会:列出本地找到的安装包 → 让你挑 → 问传到哪个版本 → 要 GitCode 令牌 → 上传。
列表默认只显示**当前版本**的包,避免把 `release\` 里 1.0.0 的旧 exe 误传到新版本发行版。
令牌建议设成环境变量 `GITCODE_TOKEN`,这样不用每次输入。

### 「从 GitHub 补同步到 GitCode」干什么用

如果本地没有那一版的安装包(换电脑、清理过 `release\`),用它最省事:
选版本 → 从 GitHub 发行版下载附件到临时目录 → 调同一个上传脚本传到 GitCode 仓库。
它和 Actions 里的 **Sync to GitCode** 工作流是同一套逻辑,区别只是一个在本地跑、一个在云端跑。

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `npm run app` | 构建前端 + 启动桌面应用(日常最常用) |
| `npm run app:start` | 直接启动(不重新构建,要求 `dist/` 已存在) |
| `npm run app:dev` | 开发模式:vite dev server + Electron,改 `src/` 热更新 |
| `npm run app:smoke` | 自检(不带导出),报告与截图写进 `release/smoke/` |
| `npm run app:smoke:export` | 自检 + **真跑一次 MP4 导出**并校验落盘文件 |
| `node tools/measure-ui.mjs` | **界面布局审计**:在真实窗口里按 7 档宽度量几何/对齐/对比度,报告写进 `release/measure/` |
| `node tools/check-downloads.mjs` | 下载列表/下载历史的行为自检(纯 Node,57 项断言) |
| `npm run build` | 仅构建前端 → `dist/`(类型检查 + Vite) |
| `npm run icons` | 生成 `build/icon.ico` / `icon.png` |
| `npm run dist` | 打包:免安装目录 + 便携版 |
| `npm run dist:dir` / `dist:portable` | 只打其中一种 |
| `npm run dev` / `preview` | 纯网页版工作流(浏览器里跑,和上游项目一致) |
| `npm run tauri android build -- --debug --apk -t aarch64` | 出 Android 调试 APK(见 [Android 端](#android-端tauri-v2)) |
| `npm run tauri android dev` | Android 真机热重载调试 |
| `npm run tauri build` | Tauri 桌面端打包(**非发布形态**,桌面请用 Electron 那套) |

双击即用的四个入口:`启动应用.bat` / `构建应用.bat` / `开发模式.bat` / `应用自检.bat`。

---

## 目录结构

```text
.
├── electron/                  # ← 桌面外壳(网页版没有这一层)
│   ├── main.cjs               #   主进程:静态服务 / 窗口 / 菜单 / 单实例 / 下载接管 / 自检入口
│   ├── downloads.cjs          #   下载列表 + 下载历史(落盘命名 / 清单读写 / 对账找回 / 重命名)
│   ├── measure.cjs            #   界面布局审计(--measure:在真实窗口里量几何/对齐/对比度/比例)
│   ├── preload.cjs            #   预加载:暴露 window.dfaeDesktop 与 window.dfaeDownloads
│   ├── smoke.cjs              #   自检逻辑(能力探测 + 资源健康 + 截图 + 可选真导出 + 下载列表核查)
│   ├── portable-splash.html   #   便携版解包期那张图的**源文件**(460×272;样式/标志全内联)
│   └── make-icons.mjs         #   logo.svg → icon.ico / icon.png,以及便携版解包图 splash.bmp
├── scripts/
│   └── dev-app.mjs            #   npm run app:dev 的启动器(起 vite → 等端口 → 拉起 Electron)
├── src-tauri/                 # ← Android 端外壳(Tauri v2 / Rust),桌面端也可用但不是发布形态
│   ├── src/                   #   lib.rs(装配) / ipc.rs(命令) / downloads.rs(下载历史)
│   │                          #   platform.rs(平台外壳能力) / mediastore.rs(Android 写相册,JNI)
│   ├── webview/dfae-bridge.js #   注入的桥接层(window.dfaeDesktop / window.dfaeDownloads)
│   ├── gen/android/           #   Android 工程(**已提交**:含平板锁横屏与权限声明等定制)
│   ├── tauri.conf.json        #   桌面端配置(app.windows 为空 —— 窗口由 main.rs 手建)
│   └── tauri.android.conf.json#   Android 专用覆盖(在这里声明移动端主窗口)
├── build/                     # 应用图标与便携版启动图(icon.ico / icon.png / splash.bmp)
├── release/                   # 打包产物 + 自检报告(已 gitignore)
├── dist/                      # Vite 构建产物 = 站点本体(已 gitignore)
├── src/
│   ├── main.ts                # 编辑器全部逻辑(513 KB,文件开头有总览)
│   ├── style.css              # 全局样式
│   └── vite-env.d.ts
├── animations/                # 八套动画素材(114.5 MB)
├── posters/                   # 动画画廊卡片预览图(由 tools/fit-posters.py 重新构图过)
├── tools/                     # 开发/排障脚本(上游带来的,多数非必需)
│   └── fit-posters.py         # 按内容包围盒重新构图封面(内容太小/偏一边时跑一次)
├── docs/FEATURES.md           # 上游网页版功能说明存档(673 行)
├── index.html / vite.config.ts / tsconfig.json / package.json
├── LICENSE                    # GPL-3.0
├── 启动应用.bat 构建应用.bat 开发模式.bat 应用自检.bat
└── README.md                  # 本文
```

---

## 桌面外壳实现要点

给要改 `electron/` 的人(设计取舍都写在源码注释里,这里只列骨架):

| 位置 | 做什么 | 关键决策 |
|---|---|---|
| `main.cjs` → `createStaticServer` | 内置静态服务 | 只绑 `127.0.0.1`、端口由系统分配;支持 GET/HEAD/**Range**(音频试听、`<video>` 都带 Range)、按 `Content-Length` 响应(站点靠它算进度);带扩展名的资源缺失一律**真 404**(不回落 index.html,免得资源缺了却看起来是 200)。 |
| `main.cjs` → `installDownloadHandler` | 接管导出落盘 | 默认**自动保存**:直接落到下载目录并登记下载历史,不再弹「另存为」;在下载列表面板里勾选「每次询问保存位置」就退回原来的原生另存为。完成后发系统通知(点通知定位文件),并通知页面刷新列表;`--smoke` 下静默落盘到指定目录,但**依然登记历史**(自检要证明这条链路通)。 |
| `downloads.cjs` | 下载列表 / 下载历史 | 产物落在**系统「下载」文件夹的应用子目录**(卸载/搬走软件都不会丢),清单落在 `%APPDATA%` 下的 `download-history.json`(所以删掉软件重装、甚至换台机器放回目录,历史都还在)。重名自动加 `(1)(2)`;清单坏了或丢了就扫描产物目录重建;文件被挪走时按「相对路径 → 文件名+体积(+帧数)」两级找回来,找不到也**只标记不删记录**。 |
| `main.cjs` → `createWindow` | 窗口与安全 | `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`;外链与 `window.open` 全部交给系统浏览器;窗口尺寸写入 `userData`。 |
| `portable-splash.html` → `make-icons.mjs` → `build/splash.bmp` | 便携版解包图 | 只出现在 Electron 起来之前、NSIS 解包的那几十秒里。设计上刻意与应用 `#app-loading` 同构(同底色 #242424、同产品字体、同 22 格方块条),但**不画假进度**:这一阶段读不到任何进度,所以方块全灭 + 一行文案说明原因。渲染走离屏(OSR)`paint` 事件取帧,再手写 24bpp BMP(NSIS 的 BgImage 只吃 BMP)。 |
| `main.cjs` → `bootstrap` | 启动编排 | 先开悬浮窗 → 起服务(46%)→ 建窗口 / 首屏(74%)→ 装诊断收集(控制台告警 + 4xx/5xx)→ `loadURL` → 主窗口第一帧画出来后淡出悬浮窗;`--smoke` 时跑自检并 `app.exit(code)`。 |
| `preload.cjs` | 渲染进程接口 | 暴露两个具名桥:`window.dfaeDesktop`(版本信息 / `openExternal` / `revealFile`)与 `window.dfaeDownloads`(下载列表:list / save / rename / remove / reveal / open / 自动保存开关 / 变更事件)。三条红线写在文件头:不暴露 `ipcRenderer`、只做登记目录内的文件操作、保持 contextIsolation。 |
| `dev-app.mjs` | 开发启动器 | 用 `process.execPath` + `node_modules/vite/bin/vite.js` 直接起 vite(避开 Windows 下 `.cmd` 的 shell 问题),轮询端口真的通了再拉 Electron;关窗即回收 vite。 |
| `make-icons.mjs` | 图标生成 | 不依赖 ImageMagick/Inkscape:开个隐藏窗口把 SVG 画进 canvas 取像素,再**手写 ICO 容器**(32bpp BMP DIB + AND 掩码,7 档尺寸 256→16)。顺带把 `portable-splash.html` 离屏渲染成 `build/splash.bmp`(便携版解包时那张图,必须是 BMP)—— 图和页面共用同一份源,不会长得不一样。 |

---

## 下载列表与下载历史

桌面版把"导出"从"浏览器下载"改成了应用自己管的下载列表 —— 目的是让用户**随时找得到自己导出的东西**,即使软件已经被删掉或搬走。

### 文件都在哪

| 东西 | 位置 | 为什么放这里 |
|---|---|---|
| 导出的视频 | `系统「下载」文件夹\三角洲行动动画编辑器\` | 在用户自己的下载文件夹里(一眼能找到),但**不在软件目录里** —— 卸载、换 exe、把软件搬到别的盘都不会连视频一起删掉。单独一个子目录,扫描补录历史时不会把你其它的 mp4 也吸进列表。 |
| 下载历史清单 | `%APPDATA%\delta-force-animation-editor-desktop\download-history.json` | 与软件目录彻底无关,所以**删掉软件、重装、换目录之后历史依然读得到**。 |
| 兜底位置 | `%APPDATA%\...\downloads\` 或软件目录旁的 `downloads\` | 只有在系统下载目录取不到 / 不可写的时候才会用到。 |

文件名是「动画名 + 导出时刻」,例:`撤离动画-20261007-153705.mp4`。这样反复导出同一个动画时,文件名本身就带上了"哪一次"的信息,不必逐个打开确认。

### 面板能做什么

顶栏 →「下载列表」(带条数角标):

- **搜索**:按文件名 / 格式过滤;
- **重命名**:就地编辑(那一行的文件名变成输入框),回车或点别处生效、Esc 取消。
  重名**不会覆盖**已有文件,而是自动加 `(1)(2)`;不写扩展名时沿用原扩展名;Windows 禁区字符自动替换、`con` 之类的设备名自动规避;
- **播放**:用系统默认播放器打开;
- **定位**:在资源管理器里选中该文件;「打开下载文件夹」打开产物目录;
- **移除**:只删列表里的一条记录,磁盘上的视频保持不动;
- **每次询问保存位置**:勾上就退回原来的原生「另存为」对话框(网页版一直是这个行为);
- **找回文件**:清单里标记为「文件已不在原位置」的条目,会按「文件名 + 体积(+ 帧数)」在附近目录里找一遍(深度封顶 3 层),找到就把路径接回去。

### 「删掉软件后历史还在」是怎么做到的

1. 清单写在 `%APPDATA%`,产物写在系统下载文件夹 —— 两者都不在软件目录里,所以删掉 / 搬走软件都不影响;
2. 清单如果真的丢了(换机器、清了缓存),下次打开会**扫描产物目录重建列表**(体积、帧数都重新读;帧数用于区分同名不同内容的导出);
3. 记录对应的文件被单独挪走或删掉时,**记录不会消失**,只标记为「文件已不在原位置」——"这个动画我在哪天导出过"本身就是有用的信息。

行为验证(纯 Node,不需要 Electron,直接跑 `electron/downloads.cjs`):

```bash
node tools/check-downloads.mjs     # 57 项断言:重名、卸载重装、搬盘、找回、重命名、坏清单自愈、目录兜底…
```

`--smoke --smoke-export=mp4` 里也带一段下载列表核查(清单是否在用户数据目录、刚导出的文件是否已登记且真实存在、重命名与重名后缀是否生效),所以打包后的 exe 同样能证明这条链路是通的。

---

## 界面布局审计(比例/对齐/溢出)

"看起来挤不挤、比例对不对"这类问题不适合靠读 CSS 猜,也不适合靠一轮轮截图「感觉」。这个仓库的做法是**在真实窗口里量出来**:

```bash
node tools/measure-ui.mjs        # 拉起应用 → 在 7 档宽度下量一遍 → 写 release/measure/measure-report.json
```

它先造一份刻意的极端夹具(超长中文文件名、GB 级体积、AVI/WEBM、文件已丢失的记录),再用临时的用户数据目录与下载目录喂给应用,不碰你真实的历史与文件。然后按 **1464 / 1280 / 1180 / 1024 / 900 / 720 / 420** 七档宽度量,检查下面这些**硬不变量**(违反任何一条都是 bug,不是审美):

| 检查 | 判据 |
|---|---|
| 横向溢出 | 页面不出现横向滚动、面板不超出视口 |
| 文字 | 文件名允许省略号收尾(必须有 title 兜底,且至少显示得下 45%);元信息与说明文字**不许**被截断 |
| 折行 | 文件名与按钮文字单行;说明文字在 ≥1024px 单行;顶栏**任何宽度下都单行** |
| 对齐 | 各行的格式角标左边界、操作区右边界一致(误差 ≤1~2px) |
| 命中区 | 每个可点元素 ≥24×24(触屏档 ≥32 高) |
| 对比度 | 文件名 / 元信息 / 按钮 / 说明文字都 ≥4.5:1(WCAG AA) |
| 比例 | 元信息字号 ≥ 文件名的 85%;行高 ≤ 名字字号 ×8;面板占视口 50%~85%;面板头部+工具条+底部 ≤ 面板高的 45%;行内上下留白 8~18px |

退出码 `0` = 全部通过,`1` = 有失败项(报告里逐条列出宽度与行号)。

这套检查在本次改动里直接抓出了三个真问题:下载面板的 `.dl-*` 类名与「数据加载浮层」撞名(`.dl-bar` 被写成 8px 高的进度条槽,工具条因此塌成 0×0)、顶栏在 1000px 以下换行、窄屏下元信息被省略号吃掉。修完后的实测数字:

```
面板宽 955.67px(视口 1448px,占 66%) | 头部+工具条+底部占 26% | 列表可视高 418px
行高 60.73px(内容 38.73px → 上下各 11px) | 文件名 13px / 元信息 12px(比 0.92) | 格式角标宽 46px
```

> 类名前缀是这行的**约定**:`.dl-*` 属于「数据加载浮层」,`.ap-*` 属于「动画画廊」,`.dw-*` 属于「下载列表」。
> 撞名的后果很隐蔽 —— 不报错、不缺元素,只是某个容器被另一套规则压成 0 高。新增浮层时请换一个前缀,别复用。

---

## 自检:一条命令验证"产物是不是好的"

```bash
npm run app:smoke              # 环境 + 能力 + 资源 + 截图
npm run app:smoke:export       # 再加一次真实的 MP4 导出与落盘校验
```

打包后的 exe 也能带同样参数跑(这才是最有价值的一次验证):

```powershell
.\release\win-unpacked\三角洲行动动画编辑器.exe --smoke --smoke-export=mp4 `
  --smoke-out="I:\Delta Force custom animation_application\release\smoke-packaged"
```

自检做四件事,结果同时写到**标准输出**、`<smoke-out>\smoke-report.json` 和两张截图里:

1. **等界面真的起来**:等启动加载界面退场(它淡出后会被 `remove()`,所以判据是"不存在或已 `is-hidden`");
2. **探测能力**:`isSecureContext`、`VideoEncoder` / `AudioEncoder`、H.264 1080p60 与 AAC 配置是否被支持、
   预览渲染出多少 SVG 节点、字体数量,以及主进程的 GPU 特性状态(`video_encode` 是否 `enabled` = 有没有硬件编码);
3. **采集健康度**:本次会话所有 4xx/5xx、网络失败(`ERR_ABORTED` 单列,它通常只是被取消的预取)、控制台告警/错误,
   外加**截图的像素统计**(颜色数 / 平均亮度 / 暗像素占比)—— 用"颜色数 < 100"兜住"白屏/纯黑错误页"这种情况;
4. **可选真导出**:把分辨率切到 50%(缩短时间,编码路径完全一样)点一次"导出视频",等浮层进入完成态,
   再由主进程接管落盘,校验产出文件的字节数;
5. **下载列表核查**:历史清单是否落在用户数据目录(而不是软件目录 —— 那决定"删了软件历史还在不在"),
   刚导出的文件是否已登记且指向真实存在的文件,重命名与"重名自动加序号"是否生效。

> 真导出有两条落盘路径,`DFAE_SMOKE_SAVE` 可以指定走哪条:
> 默认 `download`(关掉自动保存 → `<a download>` → 主进程接管保存位置),
> 设成 `auto` 则走渲染进程 → IPC 的静默落盘。两条都验证过能落盘并进下载列表。

退出码 `0` = 全部通过,`1` = 有硬性检查没过(报告里 `failures` 逐条列出)。

### 本次产物的实测结果

| 项目 | 结果 |
|---|---|
| 页面来源 / 安全上下文 | `http://127.0.0.1:<随机端口>` / `isSecureContext = true` ✅ |
| 编码能力 | H.264 1080p60 ✅、AAC ✅、`video_encode = enabled`(硬件编码可用)✅ |
| 资源健康 | 失败请求 **0**、中断请求 **0**、控制台告警 **0**(打包版)/ 1(开发版,只有 Electron 的"未设 CSP"提示,打包后不再出现) |
| 首屏 | 加载界面已退场、当前动画「撤离动画」、预览 SVG 节点 **855**、侧栏条目 **36**、字体 **8** |
| 预览播放 | lottie 实例 `isLoaded=true` `isPaused=false`,采样帧序列 `208 → 299 → 391`(**60fps 精确对齐**,1.5s ≈ 90 帧) |
| 截图 | 1464×901、颜色数 **2728**、平均亮度 28.5、暗像素占比 0.934(深色主题 UI) |
| **真实导出(打包版)** | MP4 完成;同一份产物两次实测:**13.8 s**(热机)/ **58.3 s**(首次,含显卡预热与着色器编译);`animation.mp4` **0.48 MB**;解析 MP4 box:**2 条轨道、视频 H.264(avc1)609 帧、音频 AAC(mp4a)476 帧、时长 10.155 s** ✅ |
| 便携版 | 双击 → 解压到 `%TEMP%\DeltaForceAnimationEditor` → 约 20 s 出窗口,标题「三角洲行动动画编辑器」,内存约 155 MB ✅ |
| exe 图标 | 自定义 ICO 字节确实写进了 `三角洲行动动画编辑器.exe`(版本信息含 ProductName / FileVersion 与 package.json 一致 / Copyright)✅ |

> 导出那 609 帧正好等于这套动画的总帧数,`10.155 s` 也正好等于 609 ÷ 60fps —— 说明导出的是**完整成片**,
> 不是"文件存在就算过"。

---

## 常见问题

**Q:双击 exe 没反应 / 被杀软或 SmartScreen 拦了**
产物没有代码签名,Windows 会提示"已保护你的电脑" → 「更多信息」→「仍要运行」。若被安全软件直接隔离,把
`release\win-unpacked\` 加进白名单即可(免安装版比便携版更不容易被拦:便携版会往 `%TEMP%` 解压,这个行为本身容易被启发式规则盯上)。

**Q:导出失败,提示"本机不支持 WebCodecs H.264"**
说明这个环境拿不到 H.264 编码器。常见于:**远程桌面会话**、部分虚拟机、显卡驱动异常或禁用了硬件加速的机器。
排查顺序:① 跑 `应用自检.bat`,看报告里的 `page.h264` 与 `gpu.video_encode`;② 换成物理机会话再试;
③ 站点本身有回退路径(兼容录制 / MJPEG AVI),但**透明 AVI 与 MP4 会降级**,详见 [docs/FEATURES.md](docs/FEATURES.md) 的「视频导出」与「兼容导出」。

**Q:界面白屏 / 黑屏**
跑 `应用自检.bat`,它会给出截图和报告(`release\smoke\`)。
如果想看内核日志:应用里按 **F12** 打开开发者工具,或从菜单「视图 → 开发者工具」。

**Q:导出以后文件在哪?**
默认在 **`系统「下载」文件夹\三角洲行动动画编辑器\`**,名字是「动画名 + 时间戳」。
忘了的话有三个入口:顶栏「下载列表」(里面能搜索、定位、重命名)、菜单「文件 → 打开导出文件夹」、导出完成那条系统通知(点一下直接定位到文件)。
如果你是勾选了「每次询问保存位置」导出的,那就在你当时在保存对话框里选的位置。

**Q:便携版为什么每次启动都慢?**
它**每次**都要先把自己(约 170 MB 文件)解压到 `%TEMP%\DeltaForceAnimationEditor` —— 这台机器上实测 **65 秒**才出界面(解压 + 杀软扫描,机器差异很大)。
着急用就别用便携版:装一次**一键安装包**(之后启动约 1 秒),或者解压一次**免安装版**(之后双击 exe 就是 1 秒级)。

**Q:便携版解压时那张图为什么不动?能不能让它出现在任务栏?**
不能,这是 NSIS 解包器的固有限制(不是本应用画的):解压期间是阻塞执行的,没有任何东西能重绘那个窗口,所以它只能是一张静态图;它的窗口是 toolwindow,任务栏没有按钮、Alt+Tab 里也没有。
要"有进度条、能 Alt+Tab",用**一键安装包** —— 那是标准 NSIS 安装窗口,进度条是真在动的,装完就不用再解包了。

**Q:能出 macOS / Linux 版吗?**
外壳代码是跨平台的(Electron),但图标与打包配置目前只做了 Windows。在对应平台上改 `build` 里的 target 即可,`make-icons.mjs` 生成的 ICO 也需要换成 icns/png。

**Q:改了 `src/` 但界面没变?**
`npm run app:start` 不会重新构建 —— 要么用 `npm run app:dev`(热更新),要么 `npm run app` / `npm run build` 重新构建后再启动。

**Q:端口冲突?**
不存在。内置服务的端口每次启动都由系统分配。

**Q:手机上导出成功了,相册里找不到?**
正常情况会出现在系统相册的「三角洲行动动画编辑器」相册里(物理路径 `/storage/emulated/0/Movies/三角洲行动动画编辑器/`)。
如果那里也没有,先看导出浮层的终态文案:失败会写明原因(编码器、内存、体积上限),它不会自动消失。
另外模拟器(如 MuMu)常常既没有 H.264 硬编、画布 MediaRecorder 也被禁,编码阶段就会失败 —— 请用真机验。

**Q:手机上为什么没有「下载列表」?**
因为落点是系统相册(MediaStore),不是文件目录;列表里那套「定位 / 打开 / 重命名」对 `content://` URI 没有对应能力,
摆出来只会是一堆点了没反应的按钮。所以移动端把这条通路整段关掉了,导出完成后停在原页面。

**Q:Android 上要给存储权限吗?**
Android 10 及以上**不需要任何权限** —— 分区存储下应用往 MediaStore 插入自己的媒体项是官方路径。
Android 9 及以下才需要「存储」权限(清单里已用 `maxSdkVersion=28` 限定),应用启动时会请求一次。

**Q:`npm run tauri android init` 能重跑吗?**
**别重跑。**`gen/android` 是提交进仓库的,里面有几处本项目的定制(平板锁横屏、API<29 的存储权限请求、
AndroidManifest 的权限声明),`init` 会覆盖它们。

---

## 已知边界

- **产物未签名**:首次运行有 SmartScreen 提示;也无法做自动更新签名校验。要正式分发建议买代码签名证书,
  并把 `signAndEditExecutable` 之外的签名配置补上(当前是"只改资源、不签名"的状态)。
- **只打了 Windows x64**:没有 ARM64/ia32 目标。
- **Android 只有 debug 包**:现在的 APK 是调试包(约 288 MB,其中 `libdfae_tauri_lib.so` 带 140 MB 调试符号),
  而且只打了 `arm64-v8a` 一个 ABI。正式发布应该出 release APK(需要先建 keystore)或 AAB。
- **Android 的单次保存上限是 120 MB**:超过会明确报错。透明的无压缩 AVI(上 GB)在移动端本来就被内存护栏拦住。
- **Android 端的完整导出链路没有在真机上验证过**:模拟器缺少 H.264 硬编,只能验到「字节 → 相册」这一段。
- **没有自动更新**:离线工具,升级方式就是换掉 `release\` 里的文件夹/exe。
- **便携版会占用 `%TEMP%`**:留了一份解压副本(约 296 MB),删掉不影响使用,只是下次启动重新解压。
- **前端功能边界与网页版完全一致**:编辑结果不落盘、刷新即还原、透明只能导 AVI、手机端那些降级规则等,
  全部见 [docs/FEATURES.md](docs/FEATURES.md) 的「已知边界」(该节开头有桌面版对照说明)。
- **`tools/` 里的调试转储没有随本项目带过来**:上游仓库里那些 `.raw` / `.pcm` / 帧截图动辄 GB 级
  (光 `tools/.frames.raw` 就有 5 GB),这里只保留了脚本(`.mjs` / `.cjs` / `.py` / `.c`)。

---

## License 与素材版权

[![License: GPL v3](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](./LICENSE)

Copyright © 2026 [TFR-Studios](https://github.com/TFR-Studios)

编辑器代码(含本项目新增的 `electron/` 桌面外壳与 `src-tauri/` 的 Tauri / Android 外壳)以 **GNU General Public License v3.0** 开源,完整条款见 [LICENSE](./LICENSE):
可自由使用、修改与再分发,但衍生作品必须同样以 GPL-3.0 发布,且**不提供任何担保**。

> **注意**:LICENSE 只覆盖自研的编辑器代码与桌面外壳;**仓库内的游戏动画素材(JSON / PNG / 音频)版权归原游戏版权方所有**,
> 不在 GPL-3.0 授予范围内,开源或商用前请自行确认授权。
