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
 *   · 编辑器 —— 原来的 .layout(#viewEditor),预览 + 检查器。
 *   · 下载列表 —— 复用既有面板(#downloadsPanel):它已经是完整的下载管理器。
 *   · 关于 —— 版本 / 检查更新 / 保存目录(仅桌面)/ 制作声明 / 许可。
 *
 * 检查更新:GitCode 优先,失败退 GitHub,解析与版本比较在 src/update-check.ts。
 * 桌面端请求由主进程代发(见 electron/main.cjs、src-tauri 侧同理),网页端直接 fetch。
 * ========================================================================== */

import { checkForUpdate, type Platform } from './update-check';

export type PageId = 'home' | 'editor' | 'about';

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
  const viewEditor = document.querySelector<HTMLElement>('.layout');
  const rail = document.getElementById('appRail');
  const navButtons = Array.from(document.querySelectorAll<HTMLElement>('.rail-item'));
  const navDownloads = document.getElementById('navDownloads');

  const btnOpenEditor = document.getElementById('btnOpenEditor') as HTMLButtonElement | null;
  const btnGoAbout = document.getElementById('btnGoAbout') as HTMLButtonElement | null;
  const homeChannel = document.getElementById('homeChannel');
  const homeLast = document.getElementById('homeLast');
  const railVersion = document.getElementById('railVersion');

  const aboutVersion = document.getElementById('aboutVersion');
  const aboutChannel = document.getElementById('aboutChannel');
  const btnCheck = document.getElementById('btnCheckUpdate') as HTMLButtonElement | null;
  const statusEl = document.getElementById('updateStatus');
  const dirRow = document.getElementById('aboutDirRow');
  const btnOpenDir = document.getElementById('btnOpenDir') as HTMLButtonElement | null;
  const aboutPath = document.getElementById('aboutPath');

  const pages: Record<PageId, HTMLElement | null> = { home: viewHome, editor: viewEditor, about: viewAbout };
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
   * 手机端没有这一项,所以按钮直接隐藏。 */
  if (navDownloads) navDownloads.hidden = hooks.isMobile;

  /* ---------- 版本 / 渠道文案 ---------- */
  function paintVersion(): void {
    const v = 'v' + currentVersion;
    if (railVersion) railVersion.textContent = v;
    if (homeChannel) homeChannel.textContent = channel + ' ' + v;
    if (aboutVersion) aboutVersion.textContent = v;
    if (aboutChannel) aboutChannel.textContent = channel;
  }

  /* ---------- 主页的"上次打开" ---------- */
  function paintHome(): void {
    if (!homeLast) return;
    const key = hooks.lastKey() || hooks.currentKey();
    if (!key) {
      homeLast.textContent = '';
      return;
    }
    const label = hooks.labelOf(key) || key;
    homeLast.textContent = hooks.lastKey() ? '上次打开:' + label : '还没有打开过动画';
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
    const page: PageId = raw === 'editor' || raw === 'about' ? raw : 'home';
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
    for (const id of ['home', 'editor', 'about'] as PageId[]) {
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
    /* 手机端:新页面淡入 + 轻微上移(6px),只在真的换页时播 —— 同一页重复点不重播动画。
     * 桌面端不加:工具界面切页应当瞬时,过渡会拖慢"切过去马上框选"的操作节奏。 */
    if (changed && hooks.isMobile) {
      target.classList.remove('is-entering');
      void target.offsetWidth; /* 强制回流,让同一个动画能连续播两次 */
      target.classList.add('is-entering');
      window.setTimeout(() => target.classList.remove('is-entering'), 240);
    }
    if (page === 'home') paintHome();
    if (page === 'editor') hooks.onEnterEditor();
    /* 旧事件名保留:mobile.ts 的首次手势提示等的是「进编辑器」这一刻。
     * 语义映射:编辑器 = 'editor',其它页 = 'home'(提示只关心"是否在编辑器里")。 */
    try {
      window.dispatchEvent(new CustomEvent('dfae:viewchange', { detail: { view: page === 'editor' ? 'editor' : 'home', page } }));
    } catch { /* 老环境没有 CustomEvent 构造器也无所谓:data-page 是唯一权威 */ }
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
    /* 侧边栏宽度变了 → 舞台宽度也变了。ResizeObserver 下一帧才跑,
     * 这里主动补一次,切换那一帧就不会看到错位的缩放。 */
    hooks.onEnterEditor();
  }
  if (railToggle) railToggle.addEventListener('click', toggleRail);
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
    if (page !== 'home' && page !== 'editor' && page !== 'about') return;
    /* 同一页再点一次:手机上按惯例是"回到顶部"(而不是什么都不发生) */
    if (page === current) {
      if (hooks.isMobile) pages[page]?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    showPage(page);
  }

  /* 手机端现场数据(只在关于页显示):排"底栏点不动"这类问题用。
   * 关键读数:底栏的 y/高(是否被系统手势区压住)、安全区 inset 是否为 0、
   * 以及最近一次 pointerup 落在哪一格 —— 点得到但页面不换 = 事件没到处理器。 */
  const deviceEl = document.getElementById('aboutDevice');
  let lastTapInfo = '尚无点击';
  function paintDeviceInfo(): void {
    if (!deviceEl) return;
    if (!hooks.isMobile) { deviceEl.hidden = true; return; }
    deviceEl.hidden = false;
    const railRect = rail ? rail.getBoundingClientRect() : null;
    const safeB = getComputedStyle(document.documentElement).getPropertyValue('--m-safe-b').trim() || '0px';
    deviceEl.textContent =
      '设备 · 视口 ' + window.innerWidth + '×' + window.innerHeight +
      ' · 安全区底 ' + safeB +
      (railRect ? ' · 底栏 y=' + Math.round(railRect.y) + ' 高=' + Math.round(railRect.height) : '') +
      ' · ' + lastTapInfo;
  }
  window.addEventListener('resize', paintDeviceInfo);
  window.addEventListener('orientationchange', paintDeviceInfo);

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
  if (btnGoAbout) btnGoAbout.addEventListener('click', () => showPage('about'));

  paintVersion();
  paintHome();
  paintDeviceInfo();
  /* 初始页:?view=home|editor|about 显式指定,默认主页。
   * tools/ 下走 puppeteer 的几何脚本要靠 ?view=editor 直接落在编辑器上
   * (它们量的是编辑器几何,主页会把测量全打偏)。 */
  let initial: PageId = 'home';
  try {
    const q = new URLSearchParams(location.search).get('view');
    if (q === 'editor' || q === 'about' || q === 'home') initial = q;
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
