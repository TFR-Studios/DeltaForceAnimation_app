/* ============================================================================
 * 应用外壳(src/start-screen.ts):主页 / 编辑器 / 下载列表 / 关于
 *
 * 应用不再"一打开就是编辑器",也不是一块盖住编辑器的开始页 —— 现在是**真正的多页外壳**:
 *   桌面:左侧导航轨(rail)+ 右侧内容区,当前页由 <html data-page> 决定;
 *         视图本身用 [hidden] 切换,编辑器那一块**不销毁**,所以预览画布、时间轴、
 *         导出参数在来回切页时几何与状态都不变(这是能随便切页的前提)。
 *   手机:同一份 DOM,导航轨在 mobile.css 里变成底部标签栏,下载列表整项不出现
 *         (手机落点是系统相册,列表里那套"定位 / 打开 / 重命名"对 content:// 没意义)。
 *
 * 页面职责(刻意划清,避免又把东西堆回主页):
 *   · 主页 —— 只回答"现在要干什么":版本、主操作、上次打开那一套。**不放动画列表**,
 *     选动画是编辑器顶栏触发器 / 动画画廊的事。
 *   · 动画编辑器 —— 原来的 .layout(#viewEditor),预览 + 检查器。
 *   · 图片编辑器 —— #viewImage:按需加载的 PSD 文字编辑器(见 src/image-page.ts)。
 *   · 下载列表 —— 复用既有面板(#downloadsPanel):它已经是完整的下载管理器。
 *   · 关于 —— 版本 / 检查更新 / 保存目录(仅桌面)/ 制作声明 / 许可。
 *   · 日志 —— #viewLogs:运行记录 / 类型筛选 / 搜索 / 复制 / 下载(逻辑在 src/logs.ts)。
 *
 * 检查更新:GitCode 优先,失败退 GitHub,解析与版本比较在 src/update-check.ts。
 * 桌面端请求由主进程代发(见 electron/main.cjs、src-tauri 侧同理),网页端直接 fetch。
 * ========================================================================== */

import { checkForUpdate, type Platform } from './update-check';
/* 更新检查的结果写进日志页:远程排障时"到底查没查、查到什么"是第一个要回答的问题。 */
import { logs } from './logs';
/* 开发者日志:更新检查的请求源 / 版本 / 失败原因也进原始流 */
import { devEvent } from './devlog';

export type PageId = 'home' | 'editor' | 'image' | 'about' | 'logs' | 'audio';

export type AppShellHooks = {
  /** 手机 / 平板(与 mobile.ts 同一套判定,由 main.ts 的 IS_MOBILE 传进来) */
  isMobile: boolean;
  /** 桌面客户端(Electron / Tauri 桌面):决定"能不能打开保存目录" */
  isDesktopApp: boolean;
  /** 主进程桥接是否存在(能打开导出目录) */
  hasExportDir: boolean;
  /** 构建期版本号,桌面端随后用主进程的 getVersion() 覆盖 */
  version: string;
  /** 取主进程信息(版本 / 导出目录),网页版返回 null */
  getInfo: () => Promise<{ version?: string; exportDir?: string } | null>;
  /** 在资源管理器里打开导出目录 */
  openExportDir: () => Promise<boolean>;
  /** 当前载入的动画 key */
  currentKey: () => string;
  /** 上一次打开的动画 key;没有则空串 */
  lastKey: () => string;
  /** 按 key 取动画中文名(主页"上次打开:…"用) */
  labelOf: (key: string) => string;
  /** 某套动画的封面 URL(主页「继续上次」卡用);缺省时卡片退回中性底 */
  posterOf?: (key: string) => string;
  /** 某套动画的规格短串(编号 · 尺寸 · 帧率),与画廊卡片同一口径 */
  specOf?: (key: string) => string;
  /** 打开某套动画(切换 + 载入数据) */
  open: (key: string) => Promise<void>;
  /** 打开下载列表面板(桌面端才有意义) */
  openDownloads: () => void;
  /** 桌面客户端的更新桥(window.dfaeDesktop);网页 / 手机传 null */
  desktop: unknown;
  /** 真的进到编辑器之后 main.ts 要做的事(舞台落定) */
  onEnterEditor: () => void;
};

export type AppShellApi = {
  /** 切到某一页(导航轨 / 主页按钮 / 代码里都能调) */
  showPage: (page: PageId) => void;
  /** 当前页 */
  currentPage: () => PageId;
};

const ICONS = {
  alert: '<path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/><path d="M7 11a1 1 0 1 1 2 0 1 1 0 0 1-2 0zM7.1 4.99a.9.9 0 1 1 1.8 0l-.35 3.5a.55.55 0 0 1-1.1 0z"/>',
  check: '<path d="M12.74 3.97a.73.73 0 0 1 1.05 0c.28.29.29.76.01 1.05L7.88 12.01a.73.73 0 0 1-1.07.02L3.22 8.38a.76.76 0 0 1 0-1.06.73.73 0 0 1 1.05 0l3.05 3.09z"/>',
  download: '<path d="M8 1.2a.9.9 0 0 1 .9.9v6.03l1.53-1.53a.9.9 0 1 1 1.27 1.27l-3.06 3.06a.9.9 0 0 1-1.27 0L4.3 7.87a.9.9 0 0 1 1.27-1.27L7.1 8.13V2.1a.9.9 0 0 1 .9-.9z"/><path d="M2.4 11.2a.9.9 0 0 1 .9.9v1.1h9.4v-1.1a.9.9 0 1 1 1.8 0v1.5a1.4 1.4 0 0 1-1.4 1.4H2.9a1.4 1.4 0 0 1-1.4-1.4v-1.5a.9.9 0 0 1 .9-.9z"/>',
  refresh: '<path d="M8 1.4a6.6 6.6 0 0 1 6.24 4.5.85.85 0 1 1-1.6.58A4.9 4.9 0 0 0 3.3 7.7h1.4a.7.7 0 0 1 .5 1.2L3.16 11a.7.7 0 0 1-1 0L.12 8.9a.7.7 0 0 1 .5-1.2h1.5A6.6 6.6 0 0 1 8 1.4zm6.38 3.7 2.04 2.1a.7.7 0 0 1-.5 1.2h-1.5A6.6 6.6 0 0 1 2.1 11.9a.85.85 0 1 1 1.6-.58A4.9 4.9 0 0 0 12.7 8.3h-1.4a.7.7 0 0 1-.5-1.2z"/>',
} as const;

function icon(name: keyof typeof ICONS, cls = 'bi'): string {
  return '<svg class="' + cls + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' + ICONS[name] + '</svg>';
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e || '未知错误');
}

export function initAppShell(hooks: AppShellHooks): AppShellApi {
  const root = document.documentElement;
  const viewHome = document.getElementById('viewHome');
  const viewAbout = document.getElementById('viewAbout');
  const viewLogs = document.getElementById('viewLogs');
  const viewAudio = document.getElementById('viewAudio');
  const viewEditor = document.querySelector<HTMLElement>('.layout');
  const viewImage = document.getElementById('viewImage');
  const rail = document.getElementById('appRail');
  const navButtons = Array.from(document.querySelectorAll<HTMLElement>('.rail-item'));
  const navDownloads = document.getElementById('navDownloads');

  /* ---------- 导航轨的滑动选中块(桌面)----------
   * 选中态不再由每一行自己"啪"地换底色,而是一枚铺满行宽的浅色块从上一行滑到下一行。
   * 元素由 JS 建在 .rail-items 里(手机端不需要,底栏有自己的一套指示条),
   * CSS 里 .has-indicator 只是把行自身的选中底色让位给这枚滑块 —— JS 没跑时退回原样。 */
  const railItemsEl = document.querySelector<HTMLElement>('.rail-items');
  let railIndicator: HTMLElement | null = null;
  let railIndicatorReady = false;
  if (railItemsEl && !hooks.isMobile) {
    railIndicator = document.createElement('span');
    railIndicator.className = 'rail-indicator';
    railIndicator.setAttribute('aria-hidden', 'true');
    railItemsEl.prepend(railIndicator);
    railItemsEl.classList.add('has-indicator');
  }
  function syncRailIndicator(animate = true): void {
    if (!railIndicator || !railItemsEl) return;
    const active = navButtons.find((b) => b.classList.contains('is-active') && !b.hidden);
    if (!active) { railIndicator.style.opacity = '0'; return; }
    if (!animate || !railIndicatorReady) {
      railIndicator.style.transition = 'none';
      railIndicator.style.transform = 'translateY(' + active.offsetTop + 'px)';
      railIndicator.style.height = active.offsetHeight + 'px';
      railIndicator.style.opacity = '1';
      /* 强制读一次布局,让"先落位、后过渡"在同一次任务里成立,首屏不会看到滑块从顶上滑下来。 */
      void railIndicator.offsetHeight;
      railIndicator.style.transition = '';
      railIndicatorReady = true;
      return;
    }
    railIndicator.style.transform = 'translateY(' + active.offsetTop + 'px)';
    railIndicator.style.height = active.offsetHeight + 'px';
    railIndicator.style.opacity = '1';
  }

  const btnOpenEditor = document.getElementById('btnOpenEditor') as HTMLButtonElement | null;
  const btnGoImage = document.getElementById('btnGoImage') as HTMLButtonElement | null;
  const btnGoAbout = document.getElementById('btnGoAbout') as HTMLButtonElement | null;
  const homeChannel = document.getElementById('homeChannel');
  const homeLast = document.getElementById('homeLast');
  const homeRecent = document.getElementById('homeRecent') as HTMLButtonElement | null;
  const homeRecentCover = document.getElementById('homeRecentCover') as HTMLImageElement | null;
  const homeRecentName = document.getElementById('homeRecentName');
  const homeRecentMeta = document.getElementById('homeRecentMeta');
  const homeSwitch = document.getElementById('homeSwitch') as HTMLButtonElement | null;
  const homeEmpty = document.getElementById('homeEmpty');
  const homeSideKicker = document.getElementById('homeSideKicker');
  const btnBrowseAnims = document.getElementById('btnBrowseAnims') as HTMLButtonElement | null;
  const btnOpenEditorText = document.getElementById('btnOpenEditorText');
  const railVersion = document.getElementById('railVersion');

  const aboutVersion = document.getElementById('aboutVersion');
  const aboutChannel = document.getElementById('aboutChannel');
  const btnCheck = document.getElementById('btnCheckUpdate') as HTMLButtonElement | null;
  const statusEl = document.getElementById('updateStatus');
  const dirRow = document.getElementById('aboutDirRow');
  const btnOpenDir = document.getElementById('btnOpenDir') as HTMLButtonElement | null;
  const aboutPath = document.getElementById('aboutPath');

  const pages: Record<PageId, HTMLElement | null> = { home: viewHome, editor: viewEditor, image: viewImage, about: viewAbout, logs: viewLogs, audio: viewAudio };
  /* 「跑在桌面客户端里」与「用的是手机 UI」是两件事,判定必须**移动端优先**。
   * 安卓 APK 里挂着同一个 window.dfaeDesktop 桥接层(它本来就叫这个名字,提供的是"能落盘 /
   * 能开系统浏览器"这一层能力),所以 isDesktopApp 在手机上同样成立 —— 只看它,关于页就会
   * 把手机写成「桌面版」,还露出只有桌面才有的「保存目录」,这正是用户报的"手机上被认成桌面端"。
   * 用户看见的是哪套 UI,版本渠道就写哪一套;平台判定同样手机优先 ——
   * 它决定更新检查去挑 APK 还是 Setup.exe,判错就会把 Windows 安装包塞到手机上。 */
  const desktopClient = hooks.isDesktopApp && !hooks.isMobile;
  const platform: Platform = hooks.isMobile ? 'android' : desktopClient ? 'windows' : 'web';
  const channel = hooks.isMobile ? '手机版' : desktopClient ? '桌面版' : '网页版';
  /** 「打开导出目录」是桌面客户端能力:手机上的落点是系统相册,没有可打开的文件夹 */
  const canOpenDir = hooks.hasExportDir && desktopClient;

  let currentVersion = hooks.version;
  let current: PageId = 'home';
  let busy = false;
  let checking = false;
  let lastUpdate: { state: 'latest' | 'available' | 'error'; html: string; title: string } | null = null;

  /* 下载列表不是一页:它复用既有的 #downloadsPanel(已是完整的下载管理器)。
   * 手机端没有这一项;网页版也没有主进程的落盘 / 历史能力 ——
   * 以前只隐藏了顶栏那枚按钮,导航轨里这一项仍然可点但什么都不会发生(死入口)。
   * 现在两项共用同一条判据:没有 reveal 能力就不出现(隐藏后也不在 Tab 顺序里)。 */
  if (navDownloads) navDownloads.hidden = hooks.isMobile || !hooks.hasExportDir;

  /* ---------- 版本 / 渠道文案 ---------- */
  function paintVersion(): void {
    const v = 'v' + currentVersion;
    if (railVersion) railVersion.textContent = v;
    if (homeChannel) homeChannel.textContent = channel + ' ' + v;
    if (aboutVersion) aboutVersion.textContent = v;
    if (aboutChannel) aboutChannel.textContent = channel;
    /* 设备快照里的版本要跟着主进程回报的版本走,否则复制出去的是一行过期版本号 */
    paintDeviceInfo();
  }

  /* ---------- 主页:上次打开的那一套 ----------
   * 主页只放**一张**卡(不放动画列表,见 PRODUCT.md):点它直接进编辑器并载入这套动画,
   * 省掉"进编辑器 -> 开画廊 -> 找上次那套"的三步。没有记录时换成一句能行动的空状态。
   * 信息全部来自 hooks,start-screen 不反向 import main.ts。 */
  function paintHome(): void {
    /* 只认「最近真正用过的」,不拿当前动画兜底:启动时默认载入的那一套用户从没选过,
     * 把它写成"继续上次"会让空状态永远不出现(第一次打开就被误称"上次")。 */
    const key = hooks.lastKey();
    const label = key ? (hooks.labelOf(key) || key) : '';
    if (homeLast) {
      homeLast.hidden = !!key;
      homeLast.textContent = key ? '上次打开:' + label : '';
    }
    /* 主按钮始终是"进入编辑器"这个总入口;右侧卡片才是"继续编辑这一套"。
     * 两者都写「继续编辑」会变成同一句话在两个位置抢注意力(重复 CTA 意图)。 */
    if (btnOpenEditorText) btnOpenEditorText.textContent = '打开动画编辑器';
    if (!key) {
      if (homeRecent) homeRecent.hidden = true;
      if (homeSwitch) homeSwitch.hidden = true;
      if (homeEmpty) homeEmpty.hidden = false;
      if (homeSideKicker) homeSideKicker.textContent = '从这里开始';
      return;
    }
    const poster = hooks.posterOf ? hooks.posterOf(key) : '';
    if (homeRecent) {
      homeRecent.hidden = false;
      homeRecent.setAttribute('aria-label', '继续编辑「' + label + '」');
      homeRecent.classList.toggle('is-no-cover', !poster);
    }
    if (homeSwitch) homeSwitch.hidden = false;
    if (homeEmpty) homeEmpty.hidden = true;
    if (homeSideKicker) homeSideKicker.textContent = '继续上次';
    if (homeRecentName) homeRecentName.textContent = label;
    if (homeRecentMeta) homeRecentMeta.textContent = hooks.specOf ? hooks.specOf(key) : '';
    if (homeRecentCover) {
      if (poster) {
        homeRecentCover.src = poster;
        homeRecentCover.alt = label + ' 的预览封面';
        homeRecentCover.hidden = false;
      } else {
        homeRecentCover.removeAttribute('src');
        homeRecentCover.alt = '';
        homeRecentCover.hidden = true;
      }
    }
  }

  /* ---------- 切页 ----------
   * 视图用 hidden 切换,编辑器不销毁:预览画布、适配、导出参数都保持原样。
   * inert 只加在当前页之外的页上,避免 Tab 顺序钻进看不见的界面。 */
  /* 页面栈:手机端要接系统返回键。
   * 桌面端不接(没有返回键,接了反而让 Alt+← 出现意外行为),手机上:
   *   主页 ← 编辑器 ← 关于 每次切页 pushState,返回键一格一格退,退到主页再按才退出应用。
   * Tauri 的 Android WebView 走的是 canGoBack/goBack,靠的就是这份 history。 */
  const wantHistory = hooks.isMobile;
  let suppressHistory = false;

  function pushPage(page: PageId, mode: 'push' | 'replace' | 'none'): void {
    if (!wantHistory || mode === 'none') return;
    try {
      const url = location.pathname + location.search;
      if (mode === 'replace') history.replaceState({ dfaePage: page }, '', url);
      else if (history.state && history.state.dfaePage === page) history.replaceState({ dfaePage: page }, '', url);
      else history.pushState({ dfaePage: page }, '', url);
    } catch { /* file:// 或沙箱里 pushState 可能被拒,不影响切页 */ }
  }

  window.addEventListener('popstate', (e) => {
    if (!wantHistory) return;
    const raw = e.state && e.state.dfaePage;
    const page: PageId = raw === 'editor' || raw === 'image' || raw === 'about' || raw === 'logs' || raw === 'audio' ? raw : 'home';
    suppressHistory = true;
    showPage(page, { history: 'none' });
    suppressHistory = false;
  });

  function showPage(page: PageId, opts: { history?: 'push' | 'replace' | 'none' } = {}): void {
    const target = pages[page] || null;
    if (!target) return;
    const mode = opts.history || 'push';
    if (!suppressHistory) pushPage(page, mode);
    const changed = current !== page;
    current = page;
    root.dataset.page = page;
    for (const id of ['home', 'editor', 'image', 'about', 'logs', 'audio'] as PageId[]) {
      const el = pages[id];
      if (!el) continue;
      const on = id === page;
      el.hidden = !on;
      el.toggleAttribute('inert', !on);
    }
    for (const b of navButtons) {
      const on = b.dataset.page === page;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    /* 手机端:新页面淡入 + 轻微上移;桌面端只给 .page 一档 180ms 的淡入(style.css 里
     * 用 html:not([data-ui='mobile']) 作用域,编辑器 .layout 不参与 —— 那一块一动就会
     * 让人以为画布跳了)。同一页重复点不重播。320ms 后摘类,给两级错峰留完整窗口。 */
    if (changed) {
      target.classList.remove('is-entering');
      void target.offsetWidth; /* 强制回流,让同一个动画能连续播两次 */
      target.classList.add('is-entering');
      window.setTimeout(() => target.classList.remove('is-entering'), 320);
    }
    /* 导航滑块的落点跟着当前页走:放在 rAF 里,量的是这一帧布局完成后的位置。 */
    requestAnimationFrame(() => syncRailIndicator(true));
    if (page === 'home') paintHome();
    /* 关于页每次进来重画一次设备信息:旋屏 / 换主题 / 换渲染器之后再进来,看到的才是当前值 */
    if (page === 'about') paintDeviceInfo();
    if (page === 'editor') hooks.onEnterEditor();
    /* 图片编辑器整页由 src/image-page.ts 在第一次进入时搭建(动态 import,
     * 让 ag-psd 与那张 PSD 示例只在真正用到时才下载)。 */
    if (page === 'image') ensureImagePage();
    /* 旧事件名保留:mobile.ts 的首次手势提示等的是「进编辑器」这一刻。
     * 语义映射:编辑器 = 'editor',其它页 = 'home'(提示只关心"是否在编辑器里")。 */
    try {
      window.dispatchEvent(new CustomEvent('dfae:viewchange', { detail: { view: page === 'editor' ? 'editor' : 'home', page } }));
    } catch { /* 老环境没有 CustomEvent 构造器也无所谓:data-page 是唯一权威 */ }
  }

  /* ---------- 图片编辑器:按需加载 ----------
   * 整页 DOM 与 PSD 解析库(ag-psd)都只在第一次进入图片编辑器时加载:动画编辑器的首屏
   * 不该为另一个编辑器多下载一份解析器和一张 11MB 的内置示例图。加载失败只记一行警告并
   * 允许下次重试 —— 页面本身是空的挂载点,不会把外壳带崩。 */
  let imagePageBooted = false;
  function ensureImagePage(): void {
    if (imagePageBooted) return;
    imagePageBooted = true;
    void import('./image-page')
      .then((mod) => mod.initImagePage())
      .catch((err) => {
        imagePageBooted = false;
        console.warn('[图片编辑器] 模块加载失败:', err);
      });
  }

  /* ---------- 关于页:检查更新 / 应用内下载安装 ----------
   * 两种更新形态:
   *   · 桌面安装版:发现新版本 → 「下载并安装」→ 主进程边下边报进度 → 校验(大小 + PE 头)
   *     → detached 启动 NSIS 安装器 → 自己退出;装完由安装器自动拉起新版。
   *   · 其它情况(便携版 / 手机 / 网页):退回「前往下载」,在系统浏览器里打开安装包地址。
   * 进度事件来自主进程(见 electron/main.cjs 的 5c 段),这里只负责画。 */
  type StatusState = 'idle' | 'checking' | 'latest' | 'available' | 'error';
  function setStatus(state: StatusState, html = '', title = ''): void {
    if (!statusEl) return;
    statusEl.dataset.state = state;
    statusEl.classList.toggle('is-checking', state === 'checking');
    statusEl.innerHTML = html;
    statusEl.title = title;
    statusEl.hidden = state === 'idle';
  }
  function chip(cls: string, ico: keyof typeof ICONS, text: string): string {
    return '<span class="update-item ' + cls + '">' + icon(ico, 'bi update-ico') +
      '<span class="update-text">' + text + '</span></span>';
  }
  function applyUpdate(v: { state: 'latest' | 'available' | 'error'; html: string; title: string }): void {
    lastUpdate = v;
    setStatus(v.state, v.html, v.title);
  }

  const progressEl = document.getElementById('updateProgress');
  const progressBar = document.getElementById('updateBar');
  const progressFill = document.getElementById('updateFill');
  const progressPct = document.getElementById('updatePct');
  const btnCancel = document.getElementById('btnCancelUpdate') as HTMLButtonElement | null;
  const chkAuto = document.getElementById('chkAutoUpdate') as HTMLInputElement | null;
  const AUTO_KEY = 'dfae.ui.autoUpdate.v1';
  const navAbout = document.querySelector<HTMLElement>('.rail-item[data-page="about"]');

  function setProgress(pct: number, text?: string): void {
    if (!progressEl) return;
    progressEl.hidden = false;
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    if (progressFill) progressFill.style.width = v + '%';
    if (progressPct) progressPct.textContent = text || v + '%';
    if (progressBar) {
      progressBar.setAttribute('aria-valuenow', String(v));
      progressBar.setAttribute('aria-valuetext', text || v + '%');
    }
  }
  function hideProgress(): void {
    if (progressEl) progressEl.hidden = true;
    if (progressFill) progressFill.style.width = '0%';
  }
  /* 侧边栏「关于」上的小点:自动检查发现新版本时才亮(真实状态,不是装饰)。 */
  function markUpdateFound(on: boolean): void {
    if (navAbout) navAbout.classList.toggle('has-update', on);
  }

  let updateAsset: { url: string; name: string } | null = null;
  let downloading = false;
  let canSelfUpdate = false;

  const bridge = hooks.desktop as
    | {
        updateCapabilities?: () => Promise<{ canSelfUpdate?: boolean }>;
        downloadUpdate?: (url: string, name: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
        cancelUpdate?: () => Promise<boolean>;
        installUpdate?: (p: string) => Promise<{ ok: boolean; error?: string }>;
        onUpdateProgress?: (cb: (p: any) => void) => () => void;
      }
    | null;

  async function detectCapabilities(): Promise<void> {
    if (!bridge || typeof bridge.updateCapabilities !== 'function') return;
    try {
      const caps = await bridge.updateCapabilities();
      canSelfUpdate = !!(caps && caps.canSelfUpdate);
    } catch {
      canSelfUpdate = false;
    }
  }

  function availableHtml(version: string, label: string): string {
    const head = chip('is-warn', 'alert', '发现新版本 <b>v' + esc(version) + '</b>');
    if (canSelfUpdate && updateAsset) {
      return head +
        '<button type="button" class="update-link update-link-btn" id="btnInstallUpdate">' +
        icon('download', 'bi update-ico') + '下载并安装</button>' +
        '<span class="update-note">装完会自动打开新版</span>';
    }
    const url = updateAsset ? updateAsset.url : '';
    return head +
      '<a class="update-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
      icon('download', 'bi update-ico') + '前往下载</a>' +
      '<span class="update-note">' + esc(label) + '</span>';
  }

  /* 下载 → 校验 → 启动安装器。失败一律回落成一行红字,不让用户停在半截。 */
  async function downloadAndInstall(): Promise<void> {
    if (!bridge || !updateAsset || downloading || !bridge.downloadUpdate || !bridge.installUpdate) return;
    downloading = true;
    promptBusy = true;
    const installBtn = document.getElementById('btnInstallUpdate') as HTMLButtonElement | null;
    if (installBtn) installBtn.disabled = true;
    if (updPrimary) updPrimary.disabled = true;
    hideProgress();
    hideUpdProgress();
    setProgress(0, '准备下载');
    setUpdProgress(0, '准备下载');
    if (updNoteEl && promptOpen) updNoteEl.textContent = '正在下载安装包…';
    setStatus('checking', chip('is-busy', 'refresh', '正在下载安装包…'));
    try {
      const res = await bridge.downloadUpdate(updateAsset.url, updateAsset.name);
      if (!res || !res.ok || !res.path) {
        const why = (res && res.error) || '下载失败';
        hideProgress();
        hideUpdProgress();
        if (promptOpen && updNoteEl) updNoteEl.textContent = '下载失败:' + why + '。可以再试一次,或者前往下载页手动下载。';
        applyUpdate({ state: 'error', html: chip('is-error', 'alert', esc(why)), title: '' });
        return;
      }
      setProgress(100, '已下载,正在安装');
      setUpdProgress(100, '已下载');
      if (updNoteEl && promptOpen) updNoteEl.textContent = '安装包已就绪,正在启动安装程序…';
      applyUpdate({ state: 'latest', html: chip('is-plain', 'check', '安装包已就绪,正在启动安装程序…'), title: res.path });
      const inst = await bridge.installUpdate(res.path);
      if (!inst || !inst.ok) {
        const why = (inst && inst.error) || '启动安装程序失败';
        hideProgress();
        hideUpdProgress();
        if (promptOpen && updNoteEl) updNoteEl.textContent = '启动安装程序失败:' + why + '。可以稍后手动安装。';
        applyUpdate({ state: 'error', html: chip('is-error', 'alert', esc(why)), title: '' });
      }
      /* 成功时主进程会退出自己,页面不用再做什么 */
    } catch (e) {
      hideProgress();
      hideUpdProgress();
      if (promptOpen && updNoteEl) updNoteEl.textContent = '更新失败:' + errText(e);
      applyUpdate({ state: 'error', html: chip('is-error', 'alert', '更新失败: ' + esc(errText(e))), title: '' });
    } finally {
      downloading = false;
      promptBusy = false;
      if (installBtn) installBtn.disabled = false;
      if (updPrimary) {
        updPrimary.disabled = false;
        updPrimary.textContent = canSelfUpdate && updateAsset
          ? '下载并安装'
          : isMobileUI() ? '去浏览器下载' : '前往下载页';
      }
    }
  }

  /* 进度事件:主进程按 120ms 节流推过来 */
  if (bridge && typeof bridge.onUpdateProgress === 'function') {
    bridge.onUpdateProgress((p) => {
      if (!p || !downloading) return;
      if (p.phase === 'downloading') {
        const text = p.total ? Math.round((p.received / p.total) * 100) + '%' : '下载中';
        setProgress(p.pct || 0, text);
        setUpdProgress(p.pct || 0, text);
      } else if (p.phase === 'done') {
        setProgress(100, '已下载');
        setUpdProgress(100, '已下载');
      } else if (p.phase === 'cancelled') {
        hideProgress();
        hideUpdProgress();
        setStatus('idle');
      }
    });
  }
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      void bridge?.cancelUpdate?.();
      hideProgress();
      hideUpdProgress();
      /* 浮层开着时把说明文字也退回"还没开始"的那一句,别停在"准备下载" */
      if (promptOpen && updNoteEl && !promptBusy) paintUpdatePrompt();
      setStatus('idle');
    });
  }

  /* ---------- 全屏更新提示 ----------
   * 发现新版本时盖住整屏,由用户决定「现在更新 / 稍后再说 / 跳过这个版本」。
   * 为什么值得一整屏:版本这件事最怕"用户从没看见"。以前只有关于页里一行小字 + 导航上的
   * 一个小点 —— 自动检查真的发现了新版本,不进关于页的人永远不知道。
   *
   * 两端是两套版式(同一份 DOM,由 <html data-ui> 决定命中哪套 CSS):
   *   · 桌面 —— 居中卡片,与导出浮层同一套浮层语言(遮罩 + 圆角 14 + --shadow-3);
   *   · 手机 —— 占满整屏的面板:顶部品牌标记、正文可滚、动作通栏贴底并避开安全区,
   *     拇指够得着;"稍后"与"跳过"的语义和桌面完全一致。
   * 两端文案的差别只有一句"怎么装":桌面安装版能在应用内下载安装;手机 / 网页只能去浏览器取安装包。
   *
   * 两条纪律:
   *  ① 「跳过这个版本」写进 localStorage:同一版永不再打扰,换版本才会再弹;
   *  ② 自动检查对同一版本只弹一次;手动点「检查更新」是显式动作,允许再弹。 */
  type PendingUpdate = {
    version: string;
    origin: string;
    asset: { url: string; name: string } | null;
    pageUrl: string;
  };
  const SKIP_KEY = 'dfae.ui.skipUpdate.v1';
  const updOverlay = document.getElementById('updateOverlay');
  const updLatestEl = document.getElementById('updLatest');
  const updFromEl = document.getElementById('updFrom');
  const updAssetEl = document.getElementById('updAsset');
  const updNoteEl = document.getElementById('updNote');
  const updProgressEl = document.getElementById('updProgress');
  const updBarEl = document.getElementById('updBar');
  const updFillEl = document.getElementById('updFill');
  const updPctEl = document.getElementById('updPct');
  const updPrimary = document.getElementById('updPrimary') as HTMLButtonElement | null;
  const updLater = document.getElementById('updLater') as HTMLButtonElement | null;
  const updSkip = document.getElementById('updSkip') as HTMLButtonElement | null;
  const updClose = document.getElementById('updClose') as HTMLButtonElement | null;

  let pendingUpdate: PendingUpdate | null = null;
  let promptedFor = '';      // 本会话已经自动弹过的版本
  let promptOpen = false;
  let promptBusy = false;
  let releasePromptFocus: (() => void) | null = null;
  let skippedVersion = '';
  try { skippedVersion = localStorage.getItem(SKIP_KEY) ?? ''; } catch { /* 存不了就只按会话内去重 */ }

  /** 当前是不是"手机那套 UI"。hooks.isMobile 与 mobile.ts 的 resolveMobile 可能不同
   *  (?ui=mobile / localStorage 调试口子),所以两处都认;data-ui 是渲染的既成事实。 */
  function isMobileUI(): boolean {
    return hooks.isMobile || document.documentElement.dataset.ui === 'mobile';
  }

  /* 焦点边界:浮层是模态的,焦点必须留在里面。做法与 main.ts 的 holdFocusInside 相同
   * (浮层里有 Fluent 自定义元素,真正的焦点节点在 shadow DOM 里,自己算 Tab 顺序迟早算错):
   * Tab 两端收口 + focusin 兜底。 */
  function trapFocus(root: HTMLElement): () => void {
    const focusable = (): HTMLElement[] =>
      Array.from(root.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, fluent-button, fluent-toggle-button, [tabindex]:not([tabindex="-1"])',
      )).filter((el) => !el.hasAttribute('disabled') && !el.hidden && el.getClientRects().length > 0);
    let lastInside: HTMLElement | null = null;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
      const list = focusable();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !active || !root.contains(active)) { e.preventDefault(); try { last.focus(); } catch { /* 忽略 */ } }
      } else if (active === last || !active || !root.contains(active)) {
        e.preventDefault();
        try { first.focus(); } catch { /* 忽略 */ }
      }
    };
    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && root.contains(t)) { lastInside = t; return; }
      const list = focusable();
      if (!list.length) { try { root.focus(); } catch { /* 忽略 */ } return; }
      const back = lastInside === list[list.length - 1] ? list[0] : list[list.length - 1];
      try { back.focus(); } catch { /* 忽略 */ }
      lastInside = back;
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }

  /** 浮层里的进度条(与关于页那条共用同一次下载,两条都更新)。 */
  function setUpdProgress(pct: number, text?: string): void {
    if (!updProgressEl) return;
    updProgressEl.hidden = false;
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    /* 填充走 transform: scaleX(见 style.css 的 .upd-fill):不触发布局,
     * 与导出 / 数据加载那两条进度条同一个"完成度"语义。 */
    if (updFillEl) updFillEl.style.transform = 'scaleX(' + v / 100 + ')';
    if (updPctEl) updPctEl.textContent = text || v + '%';
    if (updBarEl) {
      updBarEl.setAttribute('aria-valuenow', String(v));
      updBarEl.setAttribute('aria-valuetext', text || v + '%');
    }
  }
  function hideUpdProgress(): void {
    if (updProgressEl) updProgressEl.hidden = true;
    if (updFillEl) updFillEl.style.transform = 'scaleX(0)';
  }

  /** 把"怎么装"写清楚:这是两端唯一的文案差别,也是用户选择时最需要的那条信息。 */
  function paintUpdatePrompt(): void {
    const p = pendingUpdate;
    if (!p) return;
    if (updLatestEl) updLatestEl.textContent = 'v' + p.version;
    if (updFromEl) updFromEl.textContent = '从 v' + currentVersion + ' 升级 · 来源 ' + p.origin;
    if (updAssetEl) {
      updAssetEl.textContent = p.asset
        ? '安装包 ' + p.asset.name
        : '这个发行版没有适用于本机的安装包,将打开发行版页面';
    }
    const mobile = isMobileUI();
    if (updPrimary) {
      updPrimary.textContent = canSelfUpdate && updateAsset
        ? '下载并安装'
        : mobile ? '去浏览器下载' : '前往下载页';
      updPrimary.disabled = promptBusy;
    }
    if (updNoteEl && !promptBusy) {
      updNoteEl.textContent = canSelfUpdate && updateAsset
        ? '应用内下载并安装,装完会自动打开新版;已导出的视频与保存目录不受影响。'
        : mobile
          ? '在浏览器里下载 APK 后手动安装;已导出的视频保存在系统相册里,不受影响。'
          : '在浏览器里下载安装包;已导出的视频与保存目录不受影响。';
    }
  }

  function openUpdatePrompt(): void {
    if (!updOverlay || !pendingUpdate || promptOpen) return;
    promptOpen = true;
    paintUpdatePrompt();
    updOverlay.hidden = false;
    releasePromptFocus?.();
    releasePromptFocus = trapFocus(updOverlay);
    try { (updPrimary ?? updOverlay).focus(); } catch { /* 忽略 */ }
  }

  function closeUpdatePrompt(): void {
    if (!updOverlay || !promptOpen) return;
    promptOpen = false;
    releasePromptFocus?.();
    releasePromptFocus = null;
    updOverlay.hidden = true;
  }

  /** 检查结果到手后的唯一出口:决定"要不要弹"。force = 用户手动点的检查更新。 */
  function maybePromptUpdate(force: boolean): void {
    const p = pendingUpdate;
    if (!p) return;
    if (skippedVersion && p.version === skippedVersion) return; // 用户说过"这个版本别再问"
    if (!force && promptedFor === p.version) return;           // 自动检查对同一版只弹一次
    /* 导出 / 数据加载正在进行时不抢屏:那两层是 9000 / 9999,在本浮层(8800)之上 ——
     * 弹出来既会被盖住,又会和它们的焦点边界互相拉。关于页那条行内状态照常显示"有新版本",
     * 用户导出完再点「检查更新」,或者下次启动时会看到这里的全屏提示。 */
    const expOv = document.getElementById('exportOverlay');
    if (expOv && !expOv.hidden) return;
    const dlOv = document.getElementById('dataLoading');
    if (dlOv && !dlOv.hidden) return;
    promptedFor = p.version;
    openUpdatePrompt();
  }

  /** 非应用内安装的分支:交给系统浏览器。桌面桥接层有 openExternal(校验 http/https),
   *  手机 / 网页退回 window.open —— 两条路都只是"把链接递出去",不在应用内下载安装包。 */
  function openReleasePage(): void {
    const url = (updateAsset && updateAsset.url) || (pendingUpdate && pendingUpdate.pageUrl) || '';
    if (!url) return;
    const opener = (window as any).dfaeDesktop?.openExternal;
    if (typeof opener === 'function') {
      try { void opener(url); return; } catch { /* 落到 window.open */ }
    }
    try { window.open(url, '_blank', 'noopener'); } catch { /* 被拦就什么也做不了 */ }
  }

  async function onPromptPrimary(): Promise<void> {
    if (promptBusy) return;
    if (canSelfUpdate && updateAsset && bridge) {
      await downloadAndInstall();
      return;
    }
    openReleasePage();
  }

  if (updPrimary) updPrimary.addEventListener('click', () => void onPromptPrimary());
  if (updLater) updLater.addEventListener('click', closeUpdatePrompt);
  if (updClose) updClose.addEventListener('click', closeUpdatePrompt);
  if (updOverlay) {
    updOverlay.addEventListener('click', (e) => {
      if (e.target === updOverlay) closeUpdatePrompt(); // 点遮罩 = 稍后再说
    });
  }
  if (updSkip) {
    updSkip.addEventListener('click', () => {
      const p = pendingUpdate;
      if (p) {
        skippedVersion = p.version;
        try { localStorage.setItem(SKIP_KEY, p.version); } catch { /* 存不了就只记在本会话 */ }
      }
      closeUpdatePrompt();
    });
  }
  /* Esc = 稍后再说。用 keydown 而不是 keyup:与画廊 / 下载列表一致,按下的那一刻就该响应。 */
  document.addEventListener('keydown', (e) => {
    if (!promptOpen || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeUpdatePrompt();
  });


  /** 统一检查入口:silent = 启动时自动查(不显示"检查中"、失败也不报错)。 */
  async function runCheck(silent = false): Promise<void> {
    if (checking) return;
    checking = true;
    if (!silent) {
      if (btnCheck) { btnCheck.disabled = true; btnCheck.classList.add('is-busy'); }
      setStatus('checking', chip('is-busy', 'refresh', '正在检查更新…'));
    }
    try {
      const res = await checkForUpdate({ current: currentVersion, platform });
      if (res.kind === 'available') {
        logs.info('更新', '发现新版本 v' + res.release.version + '(来源 ' + res.origin.label + ')');
        devEvent('update', 'available version=' + res.release.version + ' source=' + res.origin.label, undefined, 'info');
        updateAsset = res.asset ? { url: res.asset.url, name: res.asset.name } : null;
        markUpdateFound(true);
        applyUpdate({
          state: 'available',
          html: availableHtml(res.release.version, res.origin.label),
          title: '当前 v' + currentVersion + ',最新 v' + res.release.version + '(来源 ' + res.origin.label + ')',
        });
        const installBtn = document.getElementById('btnInstallUpdate');
        if (installBtn) installBtn.addEventListener('click', () => void downloadAndInstall());
        /* 全屏提示:发现新版本就把"要不要现在更新"摆到用户面前。
         * 手动检查(silent=false)允许再弹一次 —— 那是用户自己按的按钮;
         * 自动检查对同一版本只弹一次,「跳过这个版本」则永久不再弹。 */
        pendingUpdate = {
          version: res.release.version,
          origin: res.origin.label,
          asset: updateAsset,
          pageUrl: res.release.pageUrl,
        };
        maybePromptUpdate(!silent);
      } else if (res.kind === 'latest') {
        logs.info('更新', '已是最新版本 v' + res.release.version + '(来源 ' + res.origin.label + ')');
        devEvent('update', 'latest version=' + res.release.version + ' source=' + res.origin.label, undefined, 'debug');
        updateAsset = null;
        pendingUpdate = null;
        closeUpdatePrompt();
        markUpdateFound(false);
        applyUpdate({
          state: 'latest',
          html:
            chip('is-plain', 'check', '已是最新版本 <b>v' + esc(res.release.version) + '</b>') +
            '<span class="update-note">来源 ' + esc(res.origin.label) + '</span>',
          title: '更新源:' + res.origin.label,
        });
      } else if (!silent) {
        logs.warn('更新', '检查更新失败: ' + res.message, res.detail ? String(res.detail) : undefined);
        devEvent('update', 'check failed: ' + res.message, res.detail ? String(res.detail) : undefined, 'warn');
        applyUpdate({ state: 'error', html: chip('is-error', 'alert', esc(res.message)), title: res.detail });
      }
    } finally {
      checking = false;
      if (btnCheck) { btnCheck.disabled = false; btnCheck.classList.remove('is-busy'); }
    }
  }

  if (btnCheck) btnCheck.addEventListener('click', () => void runCheck(false));

  /* 自动检查开关:默认开。关掉后启动时不再发请求,手动「检查更新」仍然可用。 */
  let autoCheck = true;
  try { autoCheck = localStorage.getItem(AUTO_KEY) !== 'off'; } catch { /* 忽略 */ }
  if (chkAuto) {
    chkAuto.checked = autoCheck;
    chkAuto.addEventListener('change', () => {
      autoCheck = chkAuto.checked;
      try { localStorage.setItem(AUTO_KEY, autoCheck ? 'on' : 'off'); } catch { /* 忽略 */ }
    });
  }

  /* ---------- 关于页:打开保存目录(仅桌面) ---------- */
  if (dirRow) dirRow.hidden = !canOpenDir;
  if (btnOpenDir && canOpenDir) {
    btnOpenDir.addEventListener('click', () => {
      void hooks.openExportDir().then((ok) => {
        if (!ok) setStatus('error', chip('is-error', 'alert', '打不开保存目录:系统没有返回可打开的路径'));
      });
    });
  }

  /* ---------- 主进程信息(版本以实际在跑的为准) ---------- */
  void Promise.resolve()
    .then(() => hooks.getInfo())
    .then((info) => {
      if (info && info.version && info.version !== currentVersion) {
        currentVersion = info.version;
        paintVersion();
      }
      const dir = info && typeof info.exportDir === 'string' ? info.exportDir : '';
      if (dir && aboutPath && dirRow && canOpenDir) {
        aboutPath.textContent = dir;
        aboutPath.title = dir;
      }
    })
    .catch(() => { /* 拿不到就用构建期版本 */ });

  /* ---------- 侧边栏收起 / 展开(桌面独占) ----------
   * 状态放在 <html data-rail="collapsed"> 上,与主题、页面同一层级:CSS 只认属性,
   * JS 不直接改元素尺寸,不会出现两套真相。选择记在 localStorage,下次打开保持。 */
  const railToggle = document.getElementById('railToggle') as HTMLButtonElement | null;
  const RAIL_KEY = 'dfae.ui.rail.v1';

  function applyRail(collapsed: boolean, persist = true): void {
    root.dataset.rail = collapsed ? 'collapsed' : 'expanded';
    if (railToggle) {
      railToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      const label = collapsed ? '展开侧边栏(Ctrl+B)' : '收起侧边栏(Ctrl+B)';
      railToggle.title = label;
      railToggle.setAttribute('aria-label', label);
    }
    if (persist) {
      try { localStorage.setItem(RAIL_KEY, collapsed ? 'collapsed' : 'expanded'); } catch { /* 存不了就算了 */ }
    }
  }
  /* 默认**收起**。只有用户明确展开过(存了 expanded)才恢复展开态。
   * 默认值同时写在 index.html 的 <html data-rail="collapsed"> 上,保证首帧就是折叠态。 */
  let railCollapsed = true;
  try {
    const savedRail = localStorage.getItem(RAIL_KEY);
    if (savedRail === 'expanded') railCollapsed = false;
  } catch { /* 私密模式 / 存储被拒:保持默认收起 */ }
  applyRail(railCollapsed, false);

  function toggleRail(): void {
    railCollapsed = !railCollapsed;
    applyRail(railCollapsed);
    /* 侧边栏宽度变了 → 编辑器舞台宽度也变了。ResizeObserver 下一帧才跑,
     * 这里主动补一次,切换那一帧就不会看到错位的缩放。
     * 只在**当前就在编辑器**时补:其它页(主页 / 关于 / 日志)里舞台是
     * [hidden] 的,补一次不会重排布局,却会顺着 onEnterEditor 走"隐藏期间建的实例"
     * 分支去重建动画(日志页会多出一组"字体加载/已载入"的假事件,画面也白重建一次)。
     * 真正进编辑器时 showPage 已经会调 onEnterEditor,那一次才是需要的。 */
    if (current === 'editor') hooks.onEnterEditor();
  }
  if (railToggle) railToggle.addEventListener('click', toggleRail);
  window.addEventListener('resize', () => syncRailIndicator(false));
  /* Ctrl/Cmd+B:侧边栏开关的通用手势(输入框里不抢键;手机端没有侧边栏,不生效)。 */
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'b') return;
    const t = e.target as HTMLElement | null;
    if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return;
    if (hooks.isMobile) return;
    e.preventDefault();
    toggleRail();
  });

  /* ---------- 导航接线 ----------
   * 桌面靠 click 派发就够了;手机端**不信 click**:真机上这条链路会被几件事吃掉 ——
   * 系统手势区压住底边、祖先元素的 pointer capture、某个浮层有透明命中区、
   * 或者 pointerdown 被 preventDefault 后浏览器干脆不合成 click。
   * 所以手机上再加一条 pointerup 兜底:直接按**坐标**反推落点是哪一格,
   * 不依赖 e.target(子元素可能被裁掉)、也不依赖 click 合成。两条路互斥(见 justNavigatedAt)。
   */
  let justNavigatedAt = 0;

  function activateRailItem(page: string | undefined): void {
    if (page === 'downloads') {
      /* 下载列表复用既有面板(它是完整的下载管理器),不是一页 */
      hooks.openDownloads();
      return;
    }
    if (page !== 'home' && page !== 'editor' && page !== 'image' && page !== 'about' && page !== 'logs' && page !== 'audio') return;
    /* 同一页再点一次:手机上按惯例是"回到顶部"(而不是什么都不发生) */
    if (page === current) {
      if (hooks.isMobile) pages[page]?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    showPage(page);
  }

  /* ---------- 手机端设备信息(关于页)----------
   * 这一块只为远程排障存在:底栏点不动、界面被系统手势区压住、手机上被认成桌面端 ——
   * 光靠用户口述永远对不上,必须拿到"视口多大 / 安全区多高 / 底栏落在哪 / 最近一次点击
   * 落在哪一格"。后来又加进 UA、内核、屏幕与 WebView 能力:同一份前端跑在安卓 WebView、
   * 桌面 Electron、普通浏览器里,差异十有八九先体现在这些数字上。
   *
   * 采集在每次重画时**现取**,不缓存:旋屏、软键盘弹出(visualViewport)、换主题、换渲染器
   * 都会让其中几项变;留一份过期快照比没有更误导。桌面端整块隐藏 —— 那里有 DevTools。 */
  const deviceEl = document.getElementById('aboutDevice');
  const deviceRowEl = document.getElementById('aboutDeviceRow');
  const deviceStatusEl = document.getElementById('aboutDeviceStatus');
  const btnCopyDevice = document.getElementById('btnCopyDevice') as HTMLButtonElement | null;
  const btnCopyDeviceText = document.getElementById('btnCopyDeviceText');
  let lastTapInfo = '尚无点击';

  /** 包一层 try:总有几个属性会在某些 WebView / 被策略拦掉的存储上直接抛,
   *  一处抛掉不该把整块现场数据变成空白。 */
  function probe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; }
  }

  /** 设备信息按「标签: 值 · 标签: 值」分组成行:一行一组相关读数,既不会把卡片撑成
   *  一句超长行,复制出去也是人眼能扫的结构。第一行保持原来的"现场读数"格式 ——
   *  底栏的 y/高与最近一次点击,是"点不动"这个问题最直接的证据。 */
  function collectDeviceInfo(): string[] {
    const ua = probe(() => navigator.userAgent, '');
    const uaCh = probe(
      () => (navigator as unknown as {
        userAgentData?: { brands?: { brand: string; version: string }[]; mobile?: boolean; platform?: string };
      }).userAgentData,
      undefined,
    );
    const vv = window.visualViewport;
    const cs = getComputedStyle(document.documentElement);
    const inset = (name: string): string => cs.getPropertyValue(name).trim() || '0px';
    const safeB = inset('--m-safe-b');
    const railRect = rail ? rail.getBoundingClientRect() : null;
    const theme = document.documentElement.dataset.theme === 'light' ? '浅色' : '深色';
    const rendererSel = document.getElementById('selRenderer') as HTMLSelectElement | null;
    const nativeShell = (window as unknown as { __DFAE_MOBILE__?: boolean }).__DFAE_MOBILE__ === true;
    const portrait = window.innerWidth <= window.innerHeight;
    const orientation = probe(() => (screen.orientation ? screen.orientation.type : ''), '');
    /* 内核版本从 UA 里抠:安卓 WebView 一定带 Chrome/xx,抠不出来说明 UA 被改过(本身就是线索) */
    const kernel = (() => {
      const chrome = /Chrome\/([\d.]+)/.exec(ua);
      if (chrome) return 'Chrome/' + chrome[1];
      const other = /(Firefox|Version)\/([\d.]+)/.exec(ua);
      return other ? other[1] + '/' + other[2] : '—';
    })();
    const tzOffsetMin = -new Date().getTimezoneOffset();
    const tzName = probe(() => Intl.DateTimeFormat().resolvedOptions().timeZone, '') || '未知';
    const tzText = 'UTC' + (tzOffsetMin >= 0 ? '+' : '-') +
      Math.abs(tzOffsetMin / 60).toFixed(tzOffsetMin % 60 === 0 ? 0 : 1);
    /* localStorage 探一次而不是只看 typeof:存在但写不进去(隐私模式 / 配额满)才是真问题 */
    const storage = probe(() => {
      const k = '__dfae_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return '可用';
    }, '不可用');
    const coarse = probe(() => window.matchMedia('(pointer: coarse)').matches, false);
    const mem = probe(() => {
      const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
      return gb ? gb + 'GB' : '未知';
    }, '未知');
    const brands = uaCh && uaCh.brands && uaCh.brands.length
      ? uaCh.brands.map((b) => b.brand + ' ' + b.version).join(', ')
      : '—';
    const uaChText = uaCh
      ? 'brands: ' + brands + ' · mobile: ' + (uaCh.mobile === true ? '是' : '否') + ' · platform: ' + (uaCh.platform || '—')
      : '不支持';

    return [
      '设备 · 视口 ' + window.innerWidth + '×' + window.innerHeight +
        ' · 安全区底 ' + safeB +
        (railRect ? ' · 底栏 y=' + Math.round(railRect.y) + ' 高=' + Math.round(railRect.height) : '') +
        ' · ' + lastTapInfo,
      '版本: v' + currentVersion + ' · ' + channel,
      '主题: ' + theme + ' · 渲染器: ' + (rendererSel ? rendererSel.value : '—') +
        ' · 方向: ' + (portrait ? '竖屏' : '横屏') + (orientation ? '(' + orientation + ')' : '') +
        ' · 原生壳: ' + (nativeShell ? '是' : '否') +
        ' · 安全上下文: ' + (window.isSecureContext ? '是' : '否'),
      '屏幕: ' + probe(() => screen.width + '×' + screen.height, '—') + ' @' + window.devicePixelRatio +
        ' · 可视视口: ' + (vv
          ? Math.round(vv.width) + '×' + Math.round(vv.height) + ' (offset ' +
            Math.round(vv.offsetLeft) + ',' + Math.round(vv.offsetTop) + ' · scale ' + vv.scale + ')'
          : '不支持'),
      '安全区: 上 ' + inset('--m-safe-t') + ' 右 ' + inset('--m-safe-r') +
        ' 下 ' + safeB + ' 左 ' + inset('--m-safe-l'),
      '平台: ' + probe(() => navigator.platform, '') + ' · 内核: ' + kernel +
        ' · 语言: ' + probe(() => navigator.language, '') + ' · 时区: ' + tzName + ' (' + tzText + ')',
      'CPU: ' + probe(() => navigator.hardwareConcurrency || 0, 0) + ' 线程 · 内存: ' + mem +
        ' · 本地存储: ' + storage + ' · 输入: ' + (coarse ? '粗指针(触摸)' : '精确指针') +
        ' · 触点: ' + probe(() => navigator.maxTouchPoints || 0, 0),
      '字体: ' + fontStatusText(),
      'UA-CH: ' + uaChText,
      'UA: ' + (ua || '—'),
    ];
  }

  /** 内嵌字体状态(排障用):手机上没有系统字体兜底,字体没注册成功时文字会回退系统字体 ——
   *  用户看到的就是「导出视频里字大了一圈」。主文档里注册成功后 main.ts 会挂 `__DFAE_FONTS__`,
   *  这里只读展示,不参与任何渲染决策。 */
  function fontStatusText(): string {
    const snap = probe(
      () => (window as unknown as { __DFAE_FONTS__?: { states?: Record<string, string>; warnings?: string[] } }).__DFAE_FONTS__,
      undefined,
    );
    const states = snap && snap.states ? snap.states : {};
    const names = Object.keys(states);
    if (!names.length) return '未注册(可能尚未载入动画)';
    const failed = names.filter((n) => states[n] !== 'ready');
    const fontsSize = probe(() => (document.fonts ? document.fonts.size : 0), 0);
    return (failed.length ? '未生效 ' + failed.join(' / ') : '全部生效(' + names.length + ')') +
      ' · document.fonts ' + fontsSize + ' 个' +
      (snap && snap.warnings && snap.warnings.length ? ' · 警告 ' + snap.warnings.join('; ') : '');
  }

  /** 复制出去的那一份:标题行带渠道与版本,第二行是 ISO 时间 ——
   *  "用户什么时候拿到的这份数据"决定它对应哪次构建,口头问一遍很容易记错。 */
  function buildDeviceInfoReport(): string {
    return [
      '三角洲行动动画编辑器 ' + channel + ' v' + currentVersion + ' · 设备信息',
      '复制时间: ' + new Date().toISOString(),
    ].concat(collectDeviceInfo()).join('\n');
  }

  /** 剪贴板写入。安卓 WebView 里 navigator.clipboard 只在安全上下文(https / localhost)才有,
   *  Tauri 壳的自定义源经常不算安全上下文,所以必须有第二条路。 */
  async function copyDeviceText(text: string): Promise<{ ok: boolean; why?: string }> {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return { ok: true };
      }
    } catch (e) {
      /* 权限策略拒了 / 前台化没到位:走兜底,并把原因带出去让状态行说人话 */
      return copyByExecCommand(text) ? { ok: true } : { ok: false, why: errText(e) };
    }
    return copyByExecCommand(text) ? { ok: true } : { ok: false, why: '当前 WebView 不允许写剪贴板' };
  }

  /** 兜底:临时 textarea + execCommand('copy')。
   *  用屏幕外定位而不是 display:none —— 选不中的元素 execCommand 会直接返回 false。 */
  function copyByExecCommand(text: string): boolean {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    let ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      ok = document.execCommand('copy');
    } catch { ok = false; }
    ta.remove();
    return ok;
  }

  let copyFlashTimer = 0;
  /** 复制结果双通道反馈:按钮文案(拇指底下最直观)+ 状态行(role=status,读屏也能听到)。
   *  2600ms 是"够看清、又不至于一直挂着"的长度。 */
  function flashCopyResult(ok: boolean, why = ''): void {
    if (btnCopyDeviceText) btnCopyDeviceText.textContent = ok ? '已复制' : '复制失败';
    if (btnCopyDevice) btnCopyDevice.classList.toggle('is-copied', ok);
    if (deviceStatusEl) {
      deviceStatusEl.dataset.state = ok ? 'ok' : 'error';
      deviceStatusEl.textContent = ok
        ? '已复制到剪贴板,直接粘贴发给开发者即可'
        : '复制失败' + (why ? ':' + why : '') + ';可以长按上面的设备信息手动选中复制';
    }
    window.clearTimeout(copyFlashTimer);
    copyFlashTimer = window.setTimeout(() => {
      if (btnCopyDeviceText) btnCopyDeviceText.textContent = '复制设备信息';
      if (btnCopyDevice) btnCopyDevice.classList.remove('is-copied');
      if (deviceStatusEl) {
        deviceStatusEl.textContent = '';
        deviceStatusEl.removeAttribute('data-state');
      }
    }, 2600);
  }

  function paintDeviceInfo(): void {
    /* 手机端才显示:桌面上有 DevTools,这一整块只是噪音。index.html 里已经不写 hidden ——
     * 空元素本来也没有高度,不会闪;这里仍然显式写 hidden,是为了让"桌面端不显示"只有一个真相。 */
    const show = isMobileUI();
    if (deviceEl) deviceEl.hidden = !show;
    if (deviceRowEl) deviceRowEl.hidden = !show;
    if (deviceStatusEl) deviceStatusEl.hidden = !show;
    if (!show || !deviceEl) return;
    deviceEl.textContent = collectDeviceInfo().join('\n');
  }

  if (btnCopyDevice) {
    btnCopyDevice.addEventListener('click', () => {
      /* 先重画再复制:用户可能是先旋屏 / 换主题再回来点,展示与复制必须是同一份 */
      paintDeviceInfo();
      btnCopyDevice.disabled = true;
      void copyDeviceText(buildDeviceInfoReport())
        .then((res) => flashCopyResult(res.ok, res.why))
        .finally(() => { btnCopyDevice.disabled = false; });
    });
  }

  window.addEventListener('resize', paintDeviceInfo);
  window.addEventListener('orientationchange', paintDeviceInfo);
  /* 软键盘弹出只改 visualViewport、不触发 window.resize —— "输入框把界面顶走"这类问题
   * 只有从这里才看得见。 */
  if (window.visualViewport) window.visualViewport.addEventListener('resize', paintDeviceInfo);
  /* 渲染器下拉在编辑器里,但它决定导出走哪套管线,快照要跟着当前值走 */
  const rendererSelect = document.getElementById('selRenderer');
  if (rendererSelect) rendererSelect.addEventListener('change', paintDeviceInfo);
  /* 主题开关只写 <html data-theme>、不发事件,观察属性比在 ui-theme.ts 里加钩子便宜 */
  new MutationObserver(() => paintDeviceInfo()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  if (rail) {
    rail.addEventListener('click', (e) => {
      /* pointerup 兜底刚处理过这一次点击:别让它再走一遍(否则会 push 两条历史) */
      if (performance.now() - justNavigatedAt < 700) return;
      const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('.rail-item');
      if (!btn) return;
      activateRailItem(btn.dataset.page);
    });

    if (hooks.isMobile) {
      const hitTest = (x: number, y: number): HTMLElement | null => {
        const items = Array.from(rail.querySelectorAll<HTMLElement>('.rail-item'));
        for (const b of items) {
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return b;
        }
        return null;
      };
      let downAt: { x: number; y: number } | null = null;
      rail.addEventListener('pointerdown', (e) => {
        downAt = { x: e.clientX, y: e.clientY };
      }, { passive: true });
      rail.addEventListener('pointerup', (e) => {
        if (!downAt) return;
        const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
        downAt = null;
        if (moved > 12) return;              /* 手指滑走了:这不是点击 */
        const btn = hitTest(e.clientX, e.clientY);
        lastTapInfo = btn ? 'pointerup → ' + btn.dataset.page : 'pointerup 落在格子外(' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ')';
        paintDeviceInfo();
        if (!btn) return;
        justNavigatedAt = performance.now();
        activateRailItem(btn.dataset.page);
      }, { passive: true });
      /* 兜底中的兜底:触摸浏览器的老行为里 pointerup 也可能被裁掉,
       * touchend 里按 changedTouches 的坐标再判一次。重复触发由 justNavigatedAt 挡住。 */
      rail.addEventListener('touchend', (e) => {
        if (performance.now() - justNavigatedAt < 700) return;
        const t = (e.changedTouches && e.changedTouches[0]) || null;
        if (!t) return;
        const btn = hitTest(t.clientX, t.clientY);
        if (!btn) return;
        justNavigatedAt = performance.now();
        activateRailItem(btn.dataset.page);
      }, { passive: true });
    }
  }

  if (btnOpenEditor) {
    btnOpenEditor.addEventListener('click', () => {
      if (busy) return;
      const key = hooks.lastKey() || hooks.currentKey();
      const openIt = key && key !== hooks.currentKey() ? hooks.open(key) : Promise.resolve();
      if (key && key !== hooks.currentKey()) {
        busy = true;
        btnOpenEditor.disabled = true;
        showPage('editor');
        void openIt.finally(() => { busy = false; btnOpenEditor.disabled = false; });
      } else {
        showPage('editor');
      }
    });
  }
  if (btnGoImage) btnGoImage.addEventListener('click', () => showPage('image'));
  if (btnGoAbout) btnGoAbout.addEventListener('click', () => showPage('about'));

  /* 主页右卡:点整张卡 = 进编辑器 + 载入这一套。先切页再载入 —— 切页是即时的,
   * 载入可能要等数据包下载,用户至少先看到编辑器,而不是对着主页等。 */
  if (homeRecent) {
    homeRecent.addEventListener('click', () => {
      const key = hooks.lastKey();
      if (!key || busy) return;
      busy = true;
      homeRecent.disabled = true;
      showPage('editor');
      void Promise.resolve(hooks.open(key)).finally(() => {
        busy = false;
        homeRecent.disabled = false;
      });
    });
  }
  /* 「换一套动画 / 选择动画」:进编辑器后把画廊打开(与斜杠快捷键同一条路径)。
   * 120ms 是有界的等待:切页那一帧舞台还在重新量,立刻开面板会让焦点落在旧布局上。 */
  function openAnimGallery(): void {
    showPage('editor');
    window.setTimeout(() => {
      const trigger = document.getElementById('animTrigger');
      if (trigger instanceof HTMLElement) trigger.click();
    }, 120);
  }
  if (homeSwitch) homeSwitch.addEventListener('click', openAnimGallery);
  if (btnBrowseAnims) btnBrowseAnims.addEventListener('click', openAnimGallery);

  paintVersion();
  paintHome();
  paintDeviceInfo();
  /* 初始页:?view=home|editor|about 显式指定,默认主页。
   * tools/ 下走 puppeteer 的几何脚本要靠 ?view=editor 直接落在编辑器上
   * (它们量的是编辑器几何,主页会把测量全打偏)。 */
  let initial: PageId = 'home';
  try {
    const q = new URLSearchParams(location.search).get('view');
    if (q === 'editor' || q === 'image' || q === 'about' || q === 'home' || q === 'logs') initial = q;
  } catch { /* 读不到参数就用默认页 */ }
  showPage(initial, { history: 'replace' });

  /* 能力探测 + 启动时自动检查。
   * 时机:等首屏稳定 1.2s 再发,避免和加载动画数据抢带宽;
   * 自动化脚本(navigator.webdriver)默认跳过 —— 不该被一次外网请求拖慢,
   * 要测更新链路就加 ?update=1 强制。 */
  void detectCapabilities().then(() => {
    let force = false;
    try { force = new URLSearchParams(location.search).get('update') === '1'; } catch { /* 忽略 */ }
    const automated = (() => { try { return !!navigator.webdriver; } catch { return false; } })();
    if (!autoCheck && !force) return;
    if (automated && !force) return;
    window.setTimeout(() => { void runCheck(true); }, 1200);
  });

  return {
    showPage,
    currentPage: () => current,
  };
}
