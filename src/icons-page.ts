/* ============================================================================
 * UI 图标提取(src/icons-page.ts)
 * ---------------------------------------------------------------------------
 * 应用里的"图标提取"页只有一条主线:**定位游戏目录 -> 扫描 pak 建索引 -> 检索
 * -> 预览 / 导出 PNG**。本文件负责这一页的全部 UI 与交互,能力一律来自主进程
 * 预载的 window.dfaeIcons(契约见 electron/preload.cjs),不碰主进程、不改 index.html。
 *
 * 页面结构(全部渲染进宿主元素):
 *   · 游戏目录条 —— 与音频提取共用同一份目录设置,未设置时提供选择 / 自动定位;
 *   · 索引卡片 —— 「扫描 UI 图标包」+ 进度条;完成后显示条数 / 分组数 / 失败数;
 *   · 工具条 —— 关键词搜索(300ms 防抖)、分组筛选、染色(原色/银灰/深灰/黑/自定义)、
 *     「导出当前筛选全部」;
 *   · 网格 —— 分页拉取(每页 120),图标缩略图按可视区懒加载:IntersectionObserver
 *     把进入视野的 id 排队,主进程解 BC7 裁块返回 PNG 字节,转 objectURL 展示;
 *   · 详情面板 —— 点选图标后显示大图 / 尺寸 / UV / 图集路径 / 导出按钮;
 *   · 导出 —— 单条直接导出;「导出当前筛选全部」先翻页收集 id,再按 25 条一批
 *     调 exportIcons,结果卡是唯一的"长任务结论"(成功: 文件数 + 「打开文件夹」;
 *     失败: 原因 + 「再试一次」)。
 *
 * 边界:
 *   · 浏览器 / 手机端没有 window.dfaeIcons:整页退化为"仅桌面客户端可用"的空状态;
 *   · 可重复调用 initIconsPage(host):先销毁上一份实例(退订进度、断开观察器、
 *     释放 objectURL),再清空宿主重绘;
 *   · 不引入任何新依赖;样式在 ./icons-page.css,全部规则收在 .icons-page 作用域内,
 *     颜色只取 style.css 的语义令牌。
 * ========================================================================== */
import './icons-page.css';

/* ---------------------------------------------------------------------------
 * 一、接口契约(与 electron/preload.cjs 的唯一约定)
 * ------------------------------------------------------------------------- */

type CategoryCount = { key: string; label: string; count: number };

type IconItem = {
  id: string;
  name: string;
  group: string;
  cat?: string;
  vpath: string;
  pak: string;
  uv: [number, number];
  dim: [number, number];
  atlas: string;
  hd: boolean;
};

type GameDirDetect = { ok: boolean; dir?: string; source?: string; error?: string };
type GameDirState = { dir: string | null; valid?: boolean };
type GameDirPick = { ok: boolean; dir?: string; error?: string; canceled?: boolean };
type GameDirSet = { ok: boolean; valid: boolean; pakCount?: number; error?: string };
type IndexState = { ready: boolean; count: number; building?: boolean; builtAt?: number; stale?: boolean; gameDir?: string | null };
type IndexProgress = { phase: string; done: number; total: number; detail?: string };
type SearchResult = { total: number; items: IconItem[] };
type ExportResult = { ok: boolean; saved: number; failed: number; outDir?: string; tint?: string; error?: string; errors?: string[] };
type PreviewResult = { ok: boolean; data?: Uint8Array; width?: number; height?: number; error?: string; blank?: boolean };

type IconsBridge = {
  isDesktop: true;
  detectGameDir(): Promise<GameDirDetect>;
  getGameDir(): Promise<GameDirState>;
  pickGameDir(): Promise<GameDirPick>;
  setGameDir(dir: string): Promise<GameDirSet>;
  getIndexState(): Promise<IndexState>;
  buildIndex(): Promise<{ ok: boolean; count?: number; error?: string }>;
  onIndexProgress(cb: (p: IndexProgress) => void): () => void;
  search(opts: { query?: string; group?: string; offset?: number; limit?: number }): Promise<SearchResult>;
  getCategories(): Promise<{ items: CategoryCount[] }>;
  preview(opts: { id: string; tint?: string }): Promise<PreviewResult>;
  exportIcons(opts: { ids: string[]; tint?: string }): Promise<ExportResult>;
  getExportDir(): Promise<{ dir: string }>;
  pickExportDir(): Promise<{ ok: boolean; dir?: string; error?: string }>;
};

/* ---------------------------------------------------------------------------
 * 二、常量与通用工具
 * ------------------------------------------------------------------------- */

const PAGE_SIZE = 120; // 一页 120 个：宽屏约 14~16 行，翻页次数少、每页图集仍集中
const EXPORT_BATCH = 25;
const SEARCH_DEBOUNCE = 300;
const TOAST_MS = 4600;
const MAX_COLLECT = 20000;
const PREVIEW_ROOT_MARGIN = '480px';
const PREVIEW_CONCURRENCY = 4;

/** 染色预设;value 传给主进程,主进程有同名表,这里只管展示与取值。 */
const TINT_OPTIONS: { key: string; label: string }[] = [
  { key: 'none', label: '原色' },
  { key: 'silver', label: '银灰' },
  { key: 'dark', label: '深灰' },
  { key: 'black', label: '纯黑' },
];

interface AttemptOk<T> { ok: true; value: T }
interface AttemptErr { ok: false; error: string }
type Attempt<T> = AttemptOk<T> | AttemptErr;

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

function errText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in (error as Record<string, unknown>)) {
    return String((error as { message: unknown }).message || '未知错误');
  }
  return String(error || '未知错误');
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function formatBuiltAt(stamp?: number): string {
  if (!stamp) return '';
  try {
    const d = new Date(stamp);
    const pad = (n: number) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } catch { return ''; }
}

function normalizeIconItem(raw: unknown): IconItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  const name = typeof r.name === 'string' ? r.name : '';
  if (!id || !name) return null;
  const uv = Array.isArray(r.uv) ? r.uv : [];
  const dim = Array.isArray(r.dim) ? r.dim : [];
  return {
    id,
    name,
    group: typeof r.group === 'string' ? r.group : '',
    cat: typeof r.cat === 'string' ? r.cat : undefined,
    vpath: typeof r.vpath === 'string' ? r.vpath : '',
    pak: typeof r.pak === 'string' ? r.pak : '',
    uv: [finiteNumber(uv[0]) ?? 0, finiteNumber(uv[1]) ?? 0],
    dim: [finiteNumber(dim[0]) ?? 0, finiteNumber(dim[1]) ?? 0],
    atlas: typeof r.atlas === 'string' ? r.atlas : '',
    hd: !!r.hd,
  };
}

function normalizeIndex(raw: unknown): IndexState {
  const r = (raw || {}) as Record<string, unknown>;
  return {
    ready: !!r.ready,
    count: finiteNumber(r.count) ?? 0,
    building: !!r.building,
    builtAt: finiteNumber(r.builtAt),
    stale: !!r.stale,
    gameDir: typeof r.gameDir === 'string' ? r.gameDir : null,
  };
}

function normalizeProgress(raw: unknown): IndexProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const done = finiteNumber(r.done);
  const total = finiteNumber(r.total);
  if (done == null || total == null) return null;
  return { phase: String(r.phase || ''), done, total, detail: typeof r.detail === 'string' ? r.detail : '' };
}

function toBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) {
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = Number(raw[i]) & 0xFF;
    return out;
  }
  return null;
}

/** 经「逐个字段 typeof 防御」拿到桥;任何方法缺失都视为不可用。 */
function readBridge(): IconsBridge | null {
  const raw = (window as unknown as { dfaeIcons?: unknown }).dfaeIcons;
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as unknown as Record<string, unknown>;
  const need = ['detectGameDir', 'getGameDir', 'pickGameDir', 'setGameDir', 'getIndexState', 'buildIndex', 'onIndexProgress', 'search', 'getCategories', 'preview', 'exportIcons', 'getExportDir', 'pickExportDir'];
  for (const m of need) {
    if (typeof b[m] !== 'function') return null;
  }
  return raw as unknown as IconsBridge;
}

async function attempt<T>(label: string, fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: label + '失败：' + errText(error) };
  }
}

/* ---------------------------------------------------------------------------
 * 三、页面骨架
 * ------------------------------------------------------------------------- */

type Ui = {
  root: HTMLElement;
  /* indexProgress / detailBody 等在分段渲染时才落位,允许短暂为 null */
  dirText: HTMLElement;
  dirActions: HTMLElement;
  dirError: HTMLElement;
  indexCard: HTMLElement;
  indexMain: HTMLElement | null;
  indexProgress: HTMLElement | null;
  toolbar: HTMLElement;
  searchInput: HTMLInputElement;
  catSelect: HTMLSelectElement;
  tintSelect: HTMLSelectElement;
  tintColor: HTMLInputElement;
  exportFilteredBtn: HTMLButtonElement;
  countText: HTMLElement;
  grid: HTMLElement;
  footer: HTMLElement;
  detail: HTMLElement;
  detailBody: HTMLElement;
  detailClose: HTMLButtonElement;
  resultCard: HTMLElement;
  toastHost: HTMLElement;
};

const ICON_GRID = '<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
const ICON_FOLDER = '<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
const ICON_DOWNLOAD = '<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
const ICON_SEARCH = '<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const ICON_REFRESH = '<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>';
const ICON_CLOSE = '<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

function buildShell(host: HTMLElement): Ui {
  host.innerHTML = [
    '<div class="icons-page" role="region" aria-label="UI 图标提取">',
    '  <header class="icons-head">',
    '    <h1 id="iconsTitle">UI 图标提取</h1>',
    '    <p class="icons-sub">从本地游戏包里按名字提取 UI 图标（透明底 PNG）。仅桌面客户端可用；图标版权归游戏所有，请勿用于商业用途。</p>',
    '  </header>',
    '  <section class="icons-dir" aria-label="游戏目录">',
    '    <div class="icons-dir-main"><span class="icons-dir-label">游戏目录</span><span class="icons-dir-text" data-role="dirText"></span></div>',
    '    <div class="icons-dir-actions" data-role="dirActions"></div>',
    '    <p class="icons-dir-error" data-role="dirError" hidden></p>',
    '  </section>',
    '  <section class="icons-index" data-role="indexCard" aria-label="图标索引"></section>',
    '  <section class="icons-toolbar" data-role="toolbar" aria-label="检索与导出"></section>',
    '  <div class="icons-body">',
    '    <div class="icons-gridwrap">',
    '      <div class="icons-grid" data-role="grid" role="list" aria-label="图标列表"></div>',
    '    </div>',
    '    <aside class="icons-detail" data-role="detail" hidden aria-label="图标详情"></aside>',
    '  </div>',
    '  <footer class="icons-footer" data-role="footer"></footer>',
    '  <div class="icons-result" data-role="resultCard" hidden></div>',
    '  <div class="icons-toast-host" data-role="toastHost" aria-live="polite"></div>',
    '</div>',
  ].join('');

  const $ = (role: string) => host.querySelector<HTMLElement>('[data-role="' + role + '"]');
  return {
    root: host.querySelector<HTMLElement>('.icons-page')!,
    dirText: $('dirText')!,
    dirActions: $('dirActions')!,
    dirError: $('dirError')!,
    indexCard: $('indexCard')!,
    indexMain: null as unknown as HTMLElement,
    indexProgress: null as unknown as HTMLElement,
    toolbar: $('toolbar')!,
    searchInput: null as unknown as HTMLInputElement,
    catSelect: null as unknown as HTMLSelectElement,
    tintSelect: null as unknown as HTMLSelectElement,
    tintColor: null as unknown as HTMLInputElement,
    exportFilteredBtn: null as unknown as HTMLButtonElement,
    countText: null as unknown as HTMLElement,
    grid: $('grid')!,
    footer: $('footer')!,
    detail: $('detail')!,
    detailBody: null as unknown as HTMLElement,
    detailClose: null as unknown as HTMLButtonElement,
    resultCard: $('resultCard')!,
    toastHost: $('toastHost')!,
  };
}

/** 浏览器 / 手机端：没有主进程桥，整页只显示"仅桌面可用"。 */
function renderUnavailable(host: HTMLElement): void {
  host.innerHTML = [
    '<div class="icons-page icons-page--unavailable" role="region" aria-label="UI 图标提取">',
    '  <h1 id="iconsTitle">UI 图标提取</h1>',
    '  <div class="icons-empty">',
    '    ' + ICON_GRID,
    '    <p>这一页只在 Windows 桌面客户端里可用：需要读取本机游戏包（pak），并调用游戏的 Oodle 解压库。</p>',
    '    <p class="icons-empty-sub">在桌面客户端打开「图标提取」即可扫描游戏里的全部 UI 图标并导出透明底 PNG。</p>',
    '  </div>',
    '</div>',
  ].join('');
}

/* ---------------------------------------------------------------------------
 * 四、页面控制器
 * ------------------------------------------------------------------------- */

type PageController = { dispose(): void };

export function initIconsPage(host?: HTMLElement): void {
  const mount = host || document.getElementById('iconsMount');
  if (!mount) return;
  const bridge = readBridge();
  if (!bridge) {
    renderUnavailable(mount);
    return;
  }
  let controller: PageController | null = null;
  try {
    controller = createIconsPage(mount, bridge);
  } catch (error) {
    console.warn('[图标提取] 页面初始化失败:', error);
    renderUnavailable(mount);
    return;
  }
  const prev = (mount as HTMLElement & { __iconsDispose?: () => void }).__iconsDispose;
  if (prev) prev();
  (mount as HTMLElement & { __iconsDispose?: () => void }).__iconsDispose = () => controller?.dispose();
}

function callMethod<T>(bridge: IconsBridge, method: string, ...args: unknown[]): Promise<T> {
  const fn = (bridge as unknown as Record<string, unknown>)[method] as (...a: unknown[]) => Promise<T>;
  return fn.apply(bridge, args);
}

function createIconsPage(host: HTMLElement, bridge: IconsBridge): PageController {
  const ui = buildShell(host);
  let disposed = false;

  /* ---------- 状态 ---------- */
  let gameDir: string | null = null;
  let gameDirValid = false;
  let index: IndexState = { ready: false, count: 0 };
  let categories: CategoryCount[] = [];
  let currentCat = 'all';
  let currentQuery = '';
  let queryPending = '';
  let searchTimer = 0;
  let total = 0;
  let page = 1;
  let pageLoading = false;
  let loadedIds = new Set<string>();
  const itemsById = new Map<string, IconItem>();
    let busy = false;          // 批量导出进行中
  let selectedId = '';
  let tintKey = 'none';
  let customColor = '';
  let unsubProgress: (() => void) | null = null;
  let lastExport: { ids: string[]; tint: string } | null = null;

  /* 预览管线:观察器把可视 id 丢进 pending,泵按并发度取走请求 */
  const objectUrls = new Map<string, string>();   // cacheKey -> objectURL
  const pendingPreview = new Set<string>();       // cacheKey
  const inflight = new Set<string>();
  const failedPreview = new Map<string, { blank: boolean; reason: string }>();
  let observer: IntersectionObserver | null = null;
  let pumpScheduled = false;

  const cacheKeyOf = (id: string) => id + '|' + tintKey;

  const tintLabelOf = (key: string) => {
    if (key === 'none') return '原色';
    if (key === 'silver') return '银灰';
    if (key === 'dark') return '深灰';
    if (key === 'black') return '纯黑';
    if (/^#[0-9a-fA-F]{6}$/.test(key)) return '自定义 ' + key;
    return key;
  };

  const exportTintArg = (): string => {
    if (tintKey === 'custom') return /^#[0-9a-fA-F]{6}$/.test(customColor) ? customColor : 'none';
    return tintKey;
  };

  /* ---------- 小工具 ---------- */

  /** 把已拿到的 PNG objectURL 挂到格子缩略图上（is-previewed 在 img load 后加）。 */
  function attachThumb(cell: HTMLElement, url: string): void {
    const thumb = cell.querySelector<HTMLElement>('[data-role="thumb"]');
    const fallback = cell.querySelector<HTMLElement>('.icons-thumb-fallback');
    if (!thumb || thumb.querySelector('img')) return;
    const img = document.createElement('img');
    img.alt = '';
    // 不要用 loading="lazy":缩略图在拿到 is-previewed 前是 display:none,
    // 无布局盒的懒加载图永远不会触发 load,而 is-previewed 又只在 load 后加
    // —— 自己的 IntersectionObserver 已经是懒加载机制,这里必须主动加载。
    img.decoding = 'async';
    img.src = url;
    img.addEventListener('load', () => { cell.classList.add('is-previewed'); if (fallback) fallback.classList.add('is-loaded'); }, { once: true });
    thumb.appendChild(img);
  }

  /** 缩略图渲染失败的统一落点：给格子换上"空白 / 无图"占位并写 tooltip 原因。 */
  function markCellFailed(cell: HTMLElement | null, reason: string): void {
    if (!cell) return;
    const blank = /空白/.test(reason);
    cell.classList.add(blank ? 'is-preview-blank' : 'is-preview-failed');
    const fb = cell.querySelector<HTMLElement>('.icons-thumb-fallback');
    if (fb) fb.textContent = blank ? '空白' : '无图';
    cell.title = nameOfCell(cell) + '：' + reason;
  }

  function nameOfCell(cell: HTMLElement): string {
    return cell.querySelector<HTMLElement>('.icons-cell-name')?.textContent || '这个图标';
  }

  function showToast(message: string, kind: 'ok' | 'error' | 'info' = 'ok'): void {
    const el = document.createElement('div');
    el.className = 'icons-toast icons-toast--' + kind;
    el.textContent = message;
    ui.toastHost.appendChild(el);
    window.setTimeout(() => { el.classList.add('is-out'); }, TOAST_MS - 400);
    window.setTimeout(() => { el.remove(); }, TOAST_MS);
  }

  function setBusy(on: boolean): void {
    busy = on;
    if (ui.exportFilteredBtn) {
      ui.exportFilteredBtn.disabled = on || !index.ready;
      ui.exportFilteredBtn.textContent = on ? '正在导出…' : '导出当前筛选全部';
    }
    ui.root.classList.toggle('is-busy', on);
  }

  function revealOutDir(dir: string): void {
    const desktop = (window as unknown as { dfaeDesktop?: { revealFile?: (p: string) => Promise<unknown> } }).dfaeDesktop;
    if (desktop && typeof desktop.revealFile === 'function') {
      void desktop.revealFile(dir).catch(() => {});
    } else {
      showToast('导出目录：' + dir, 'info');
    }
  }

  /* ---------- 游戏目录条 ---------- */

  function paintDir(): void {
    ui.dirText.textContent = gameDirValid && gameDir
      ? gameDir
      : (gameDir ? gameDir + '（目录无效）' : '未设置 —— 先定位 DeltaForce(2001918) 游戏目录');
    ui.dirText.classList.toggle('is-invalid', !!(gameDir && !gameDirValid));
    const actions: string[] = [];
    if (!gameDir) {
      actions.push('<button type="button" class="icons-btn" data-dir-action="detect">自动定位</button>');
      actions.push('<button type="button" class="icons-btn icons-btn--primary" data-dir-action="pick">选择游戏目录</button>');
    } else {
      actions.push('<button type="button" class="icons-btn" data-dir-action="pick">更换目录</button>');
    }
    actions.push('<button type="button" class="icons-btn" data-role="exportDirBtn" title="选择 PNG 导出目录">' + ICON_FOLDER + '导出目录</button>');
    ui.dirActions.innerHTML = actions.join('');
    ui.dirError.hidden = true;
  }

  ui.dirActions.addEventListener('click', async (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-dir-action]');
    if (!btn) return;
    const action = btn.dataset.dirAction;
    btn.setAttribute('data-busy', '1');
    try {
      if (action === 'detect') {
        const r = await attempt('自动定位', () => callMethod<GameDirDetect>(bridge, 'detectGameDir'));
        if (!r.ok) { showDirError(r.error); return; }
        if (!r.value.ok) { showDirError(r.value.error || '没有自动找到游戏目录'); return; }
        const set = await attempt('应用目录', () => callMethod<GameDirSet>(bridge, 'setGameDir', r.value.dir!));
        await refreshAfterDirChange(set.ok && set.value.ok);
      } else if (action === 'pick') {
        const r = await attempt('选择目录', () => callMethod<GameDirPick>(bridge, 'pickGameDir'));
        if (!r.ok) { showDirError(r.error); return; }
        if (r.value.canceled) return;
        await refreshAfterDirChange(!!r.value.ok);
      }
    } finally {
      btn.removeAttribute('data-busy');
    }
  });

  function showDirError(message: string): void {
    ui.dirError.textContent = message;
    ui.dirError.hidden = false;
  }

  async function refreshAfterDirChange(ok: boolean): Promise<void> {
    if (!ok) { await loadDir(); paintDir(); return; }
    await loadDir();
    paintDir();
    index = normalizeIndex(await attempt2State());
    paintIndex();
    clearList();
    if (index.ready) {
      await loadCategories();
      paintToolbar();
      reloadSearch();
    }
  }

  async function loadDir(): Promise<void> {
    const r = await attempt('读取游戏目录', () => callMethod<GameDirState>(bridge, 'getGameDir'));
    if (r.ok) { gameDir = r.value.dir; gameDirValid = !!r.value.valid; }
  }

  /* ---------- 索引卡片 ---------- */

  function paintIndex(): void {
    const parts: string[] = [];
    if (index.building) {
      parts.push('<div class="icons-index-main"><span class="icons-index-title">正在扫描 UI 图标包…</span></div>');
      parts.push('<div class="icons-progress" data-role="indexProgress"><div class="icons-progress-fill"></div><span class="icons-progress-text">准备中…</span></div>');
    } else if (!index.ready) {
      parts.push('<div class="icons-index-main"><span class="icons-index-title">还没有建立图标索引</span><span class="icons-index-sub">首次扫描需要读取全部游戏包（约 1~3 分钟，视磁盘而定），结果会缓存，之后打开页面直接可用。</span></div>');
      parts.push('<div class="icons-index-actions"><button type="button" class="icons-btn icons-btn--primary" data-index-action="build">' + ICON_REFRESH + '扫描 UI 图标包</button></div>');
    } else {
      const staleTag = index.stale ? '<span class="icons-tag icons-tag--warn">游戏目录已变化，请重新扫描</span>' : '';
      parts.push('<div class="icons-index-main"><span class="icons-index-title">索引就绪：' + index.count.toLocaleString('zh-CN') + ' 个图标</span>' + staleTag + '<span class="icons-index-sub">构建于 ' + (formatBuiltAt(index.builtAt) || '未知时间') + '（缓存于本机，无需重复扫描）</span></div>');
      parts.push('<div class="icons-index-actions"><button type="button" class="icons-btn" data-index-action="build">' + ICON_REFRESH + '重新扫描</button></div>');
    }
    ui.indexCard.innerHTML = parts.join('');
    ui.indexProgress = ui.indexCard.querySelector<HTMLElement>('[data-role="indexProgress"]');
    if (index.ready && ui.exportFilteredBtn) ui.exportFilteredBtn.disabled = busy;
  }

  ui.indexCard.addEventListener('click', async (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-index-action="build"]');
    if (!btn || busy) return;
    btn.setAttribute('data-busy', '1');
    index = { ...index, building: true };
    paintIndex();
    const r = await attempt('扫描图标包', () => callMethod<{ ok: boolean; count?: number; error?: string }>(bridge, 'buildIndex'));
    if (!r.ok || !r.value.ok) {
      index = { ready: false, count: 0 };
      paintIndex();
      showToast((!r.ok ? r.error : r.value.error) || '扫描失败', 'error');
      return;
    }
    index = normalizeIndex(await attempt2State());
    paintIndex();
    await loadCategories();
    paintToolbar();
    clearList();
    reloadSearch();
    showToast('扫描完成：' + index.count.toLocaleString('zh-CN') + ' 个图标', 'ok');
  });

  function handleProgress(raw: unknown): void {
    const p = normalizeProgress(raw);
    if (!p || !ui.indexProgress) return;
    const label = p.phase === 'pak' ? '扫描包 ' + p.detail
      : p.phase === 'atlas' ? '登记图集 ' + p.detail
      : p.phase === 'done' ? '完成' : '解析 ' + p.detail;
    const fill = ui.indexProgress.querySelector<HTMLElement>('.icons-progress-fill');
    const text = ui.indexProgress.querySelector<HTMLElement>('.icons-progress-text');
    const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = label + '（' + pct + '%）';
  }

  async function attempt2State(): Promise<IndexState> {
    const r = await attempt('读取索引状态', () => callMethod<IndexState>(bridge, 'getIndexState'));
    return r.ok ? normalizeIndex(r.value) : { ready: false, count: 0 };
  }

  /* ---------- 分组 ---------- */

  async function loadCategories(): Promise<void> {
    const r = await attempt('读取分组', () => callMethod<{ items: CategoryCount[] }>(bridge, 'getCategories'));
    categories = r.ok && Array.isArray(r.value.items) ? r.value.items : [];
  }

  /* ---------- 工具条 ---------- */

  function paintToolbar(): void {
    if (!ui.searchInput) {
      ui.toolbar.innerHTML = [
        '  <div class="icons-search">',
        '    ' + ICON_SEARCH,
        '    <input type="search" data-role="iconSearch" placeholder="按名字搜索图标，如 TaskSystem、De_102…" aria-label="搜索图标" />',
        '  </div>',
        '  <label class="icons-field"><span>分类</span><select data-role="iconCat" aria-label="按名称分类筛选"></select></label>',
        '  <label class="icons-field"><span>颜色</span><select data-role="iconTint" aria-label="导出颜色">',
        TINT_OPTIONS.map((t) => '<option value="' + t.key + '">' + t.label + '</option>').join(''),
        '    <option value="custom">自定义…</option>',
        '  </select><input type="color" data-role="iconTintCustom" value="#e6f0fa" aria-label="自定义颜色" /></label>',
        '  <button type="button" class="icons-btn icons-btn--primary" data-role="exportFiltered">' + ICON_DOWNLOAD + '导出当前筛选全部</button>',
        '  <span class="icons-count" data-role="count"></span>',
      ].join('');
      ui.searchInput = ui.toolbar.querySelector<HTMLInputElement>('[data-role="iconSearch"]')!;
      ui.catSelect = ui.toolbar.querySelector<HTMLSelectElement>('[data-role="iconCat"]')!;
      ui.tintSelect = ui.toolbar.querySelector<HTMLSelectElement>('[data-role="iconTint"]')!;
      ui.tintColor = ui.toolbar.querySelector<HTMLInputElement>('[data-role="iconTintCustom"]')!;
      ui.exportFilteredBtn = ui.toolbar.querySelector<HTMLButtonElement>('[data-role="exportFiltered"]')!;
      ui.countText = ui.toolbar.querySelector<HTMLElement>('[data-role="count"]')!;
      ui.searchInput.addEventListener('input', () => {
        queryPending = ui.searchInput.value.trim();
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => { currentQuery = queryPending; clearList(); void reloadSearch(); }, SEARCH_DEBOUNCE);
      });
      ui.catSelect.addEventListener('change', () => {
        currentCat = ui.catSelect.value;
        clearList();
        void reloadSearch();
      });
      ui.tintSelect.addEventListener('change', () => {
        tintKey = ui.tintSelect.value;
        ui.tintColor.hidden = tintKey !== 'custom';
        if (tintKey === 'custom' && /^#[0-9a-fA-F]{6}$/.test(ui.tintColor.value)) customColor = ui.tintColor.value;
        applyTintEverywhere();
      });
      ui.tintColor.addEventListener('input', () => {
        if (!/^#[0-9a-fA-F]{6}$/.test(ui.tintColor.value)) return;
        customColor = ui.tintColor.value;
        applyTintEverywhere();
      });
      ui.exportFilteredBtn.addEventListener('click', () => { void exportFiltered(); });
    }
    // 分组下拉
    const opts = ['<option value="all">全部分类（' + index.count.toLocaleString('zh-CN') + '）</option>']
      .concat(categories.map((c) => '<option value="' + escapeHtml(c.key) + '">' + escapeHtml(c.label) + '（' + c.count.toLocaleString('zh-CN') + '）</option>'));
    ui.catSelect.innerHTML = opts.join('');
    ui.catSelect.value = currentCat;
    if (!categories.some((c) => c.key === currentCat)) { currentCat = 'all'; ui.catSelect.value = 'all'; }
    ui.tintColor.hidden = tintKey !== 'custom';
    ui.exportFilteredBtn.disabled = busy || !index.ready;
  }

  /** 染色变化:清空全部预览,重载可视区与详情。 */
  function applyTintEverywhere(): void {
    for (const url of objectUrls.values()) { try { URL.revokeObjectURL(url); } catch { /* 忽略 */ } }
    objectUrls.clear();
    failedPreview.clear();
    pendingPreview.clear();
    for (const cell of Array.from(ui.grid.children)) {
      const img = cell.querySelector('img');
      if (img) { img.remove(); }
      const ph = cell.querySelector('.icons-thumb-fallback');
      if (ph) ph.classList.remove('is-loaded');
      cell.classList.remove('is-previewed');
    }
    if (selectedId) paintDetail(selectedId);
    observer?.disconnect();
    setupObserver();
  }

  /* ---------- 搜索与列表 ---------- */

  const totalPages = () => Math.max(1, Math.ceil(total / PAGE_SIZE));

  function paintCount(): void {
    if (!ui.countText) return;
    const scope = currentCat !== 'all' ? '（当前分类：' + currentCat + '）' : '';
    ui.countText.textContent = '共 ' + total.toLocaleString('zh-CN') + ' 个' + scope;
  }

  /** 页码条：搜索式的「‹ 1 2 3 … 12 ›」+ 第 x / y 页。首尾页与当前页的邻页可见，中间折叠成省略号。 */
  function paintPagination(): void {
    if (!index.ready || total === 0) { ui.footer.innerHTML = ''; paintCount(); return; }
    const pages = totalPages();
    const cur = Math.min(page, pages);
    const nums: number[] = [];
    const add = (n: number) => { if (n >= 1 && n <= pages && !nums.includes(n)) nums.push(n); };
    if (pages <= 7) {
      for (let n = 1; n <= pages; n++) add(n);
    } else {
      add(1);
      for (let n = cur - 2; n <= cur + 2; n++) add(n);
      add(pages);
    }
    nums.sort((a, b) => a - b);
    const parts: string[] = [];
    parts.push('<nav class="icons-pagination" aria-label="分页">');
    parts.push('<button type="button" class="icons-pagebtn" data-page-step="-1" aria-label="上一页"' + (cur <= 1 ? ' disabled' : '') + '>‹ 上一页</button>');
    let prev = 0;
    for (const n of nums) {
      if (prev && n - prev > 1) parts.push('<span class="icons-pagination-gap" aria-hidden="true">…</span>');
      parts.push('<button type="button" class="icons-pagebtn' + (n === cur ? ' is-current' : '') + '" data-page-to="' + n + '"' + (n === cur ? ' aria-current="page"' : '') + '>' + n + '</button>');
      prev = n;
    }
    parts.push('<button type="button" class="icons-pagebtn" data-page-step="1" aria-label="下一页"' + (cur >= pages ? ' disabled' : '') + '>下一页 ›</button>');
    parts.push('<span class="icons-pagination-info">第 ' + cur + ' / ' + pages + ' 页</span>');
    parts.push('</nav>');
    ui.footer.innerHTML = parts.join('');
    paintCount();
  }

  function createCell(item: IconItem): HTMLElement {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'icons-cell';
    cell.dataset.id = item.id;
    cell.setAttribute('role', 'listitem');
    cell.title = item.name + (item.hd ? '（HD）' : '');
    const dim = item.dim[0] + '×' + item.dim[1];
    cell.innerHTML = [
      '<span class="icons-thumb" data-role="thumb">',
      '  <span class="icons-thumb-fallback" aria-hidden="true">' + escapeHtml(item.name.slice(-2).toUpperCase()) + '</span>',
      '</span>',
      '<span class="icons-cell-name">' + escapeHtml(item.name) + '</span>',
      '<span class="icons-cell-meta">' + escapeHtml(dim) + (item.hd ? '<i class="icons-tag icons-tag--hd">HD</i>' : '') + '</span>',
    ].join('');
    if (selectedId === item.id) cell.classList.add('is-selected');
    return cell;
  }

  function appendRows(items: IconItem[]): void {
    const frag = document.createDocumentFragment();
    for (const it of items) {
      if (loadedIds.has(it.id)) continue;
      loadedIds.add(it.id);
      itemsById.set(it.id, it);
      const cell = createCell(it);
      const key = cacheKeyOf(it.id);
      const url = objectUrls.get(key);
      if (url) attachThumb(cell, url);
      const failed = failedPreview.get(key);
      if (failed) markCellFailed(cell, failed.reason);
      else if (!url) pendingPreview.add(key);
      frag.appendChild(cell);
      observer?.observe(cell);
    }
    ui.grid.appendChild(frag);
    paintPagination();
  }

  function clearList(): void {
    ui.grid.innerHTML = '';
    loadedIds = new Set();
    itemsById.clear();
    total = 0;
    selectedId = '';
    paintDetail(null);
    for (const url of objectUrls.values()) { try { URL.revokeObjectURL(url); } catch { /* 忽略 */ } }
    objectUrls.clear();
    pendingPreview.clear();
    failedPreview.clear();
    paintPagination();
  }

  /** 载入第 p 页（1 起）。翻页不追加：整页替换，缩略图缓存按 id 复用。 */
  async function goPage(p: number): Promise<void> {
    if (!index.ready) { paintPagination(); return; }
    const next = Math.max(1, Math.min(p, totalPages()));
    page = next;
    pageLoading = true;
    ui.root.classList.add('is-page-loading');
    ui.grid.innerHTML = '<div class="icons-loading">正在载入第 ' + next + ' 页…</div>';
    try {
      const r = await attempt('载入第 ' + next + ' 页', () => callMethod<SearchResult>(bridge, 'search', {
        query: currentQuery, cat: currentCat, offset: (next - 1) * PAGE_SIZE, limit: PAGE_SIZE,
      }));
      if (!r.ok) { showToast(r.error, 'error'); ui.grid.innerHTML = ''; paintPagination(); return; }
      total = r.value.total;
      // 结果总页数变少（比如被别处重建了索引）时回落到最后一页
      if (page > totalPages()) { page = totalPages(); ui.grid.innerHTML = ''; paintPagination(); return; }
      loadedIds = new Set();
      itemsById.clear();
      ui.grid.innerHTML = '';
      appendRows(r.value.items.map(normalizeIconItem).filter((x): x is IconItem => !!x));
      paintPagination();
      if (page > 1) {
        const pageEl = ui.root.closest<HTMLElement>('.page');
        pageEl?.scrollTo({ top: 0, behavior: 'auto' });
      }
    } finally {
      pageLoading = false;
      ui.root.classList.remove('is-page-loading');
    }
  }

  /** 首页（搜索条件变化时用）。 */
  function reloadSearch(): void { void goPage(1); }

  /* ---------- 懒加载预览 ---------- */

  function setupObserver(): void {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const cell = e.target as HTMLElement;
        const id = cell.dataset.id;
        if (!id) continue;
        const key = cacheKeyOf(id);
        if (!objectUrls.has(key) && !failedPreview.has(key)) pendingPreview.add(key);
        observer?.unobserve(cell);
      }
      schedulePump();
    }, { rootMargin: PREVIEW_ROOT_MARGIN });
    for (const cell of Array.from(ui.grid.children)) observer.observe(cell);
  }

  function schedulePump(): void {
    if (pumpScheduled || disposed) return;
    pumpScheduled = true;
    window.setTimeout(() => { pumpScheduled = false; void pump(); }, 60);
  }

  async function pump(): Promise<void> {
    if (disposed) return;
    while (pendingPreview.size > 0 && inflight.size < PREVIEW_CONCURRENCY) {
      const key = pendingPreview.values().next().value as string;
      pendingPreview.delete(key);
      if (objectUrls.has(key) || inflight.has(key)) continue;
      const id = key.slice(0, key.lastIndexOf('|'));
      inflight.add(key);
      void attempt('渲染预览', () => callMethod<PreviewResult>(bridge, 'preview', { id, tint: exportTintArg() }))
        .then((r) => {
          inflight.delete(key);
          const cell = ui.grid.querySelector<HTMLElement>('[data-id="' + id.replace(/[\\"]/g, '\\$&') + '"]');
          if (!r.ok) {
            failedPreview.set(key, { blank: false, reason: r.error });
            markCellFailed(cell, r.error);
            return;
          }
          if (!r.value.ok) {
            const reason = r.value.blank ? '该图标在图集中为空白' : (r.value.error || '渲染失败');
            failedPreview.set(key, { blank: !!r.value.blank, reason });
            markCellFailed(cell, reason);
            return;
          }
          const bytes = toBytes(r.value.data);
          if (!bytes || !bytes.length) {
            failedPreview.set(key, { blank: false, reason: '没有拿到 PNG 数据' });
            markCellFailed(cell, '没有拿到 PNG 数据');
            return;
          }
          const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }));
          objectUrls.set(key, url);
          if (!cell) return; // 列表可能刚被清空:URL 已缓存,下次渲染直接用
          attachThumb(cell, url);
          if (selectedId === id) paintDetailImage();
        })
        .catch(() => inflight.delete(key));
    }
    if (pendingPreview.size > 0) schedulePump();
  }

  /* ---------- 详情面板 ---------- */

  function findItem(id: string): IconItem | null {
    return itemsById.get(id) || null;
  }

  function paintDetailImage(): void {
    const imgHost = ui.detailBody?.querySelector<HTMLElement>('[data-role="detailImg"]');
    if (!imgHost || !selectedId) return;
    const key = cacheKeyOf(selectedId);
    const url = objectUrls.get(key);
    imgHost.innerHTML = '';
    if (url) {
      const img = document.createElement('img');
      img.alt = selectedId;
      img.src = url;
      imgHost.appendChild(img);
      imgHost.classList.remove('is-empty');
    } else {
      imgHost.classList.add('is-empty');
      imgHost.innerHTML = '<span class="icons-thumb-fallback is-loading">渲染中…</span>';
      pendingPreview.add(key);
      schedulePump();
    }
  }

  function paintDetail(id: string | null): void {
    if (!id) {
      ui.detail.hidden = true;
      ui.detail.innerHTML = '';
      ui.detailBody = null as unknown as HTMLElement;
      selectedId = '';
      ui.root.classList.remove('has-detail');
      return;
    }
    selectedId = id;
    const item = findItem(id);
    const name = item ? item.name : id.split('/').pop() || id;
    ui.root.classList.add('has-detail');
    ui.detail.hidden = false;
    ui.detail.innerHTML = [
      '  <div class="icons-detail-head">',
      '    <h2 class="icons-detail-title">' + escapeHtml(name) + '</h2>',
      '    <button type="button" class="icons-btn icons-btn--icon" data-role="detailClose" aria-label="关闭详情">' + ICON_CLOSE + '</button>',
      '  </div>',
      '  <div class="icons-detail-img" data-role="detailImg"></div>',
      '  <dl class="icons-detail-meta">',
      '    <div><dt>尺寸</dt><dd>' + (item ? item.dim[0] + ' × ' + item.dim[1] + ' px' : '—') + '</dd></div>',
      '    <div><dt>颜色</dt><dd>' + escapeHtml(tintLabelOf(exportTintArg())) + '</dd></div>',
      '    <div><dt>图标 ID</dt><dd><code>' + escapeHtml(id) + '</code></dd></div>',
      '    <div><dt>来源包</dt><dd>' + (item && item.pak ? escapeHtml(item.pak) : '—') + '</dd></div>',
      '  </dl>',
      '  <div class="icons-detail-actions">',
      '    <button type="button" class="icons-btn icons-btn--primary" data-role="exportOne">' + ICON_DOWNLOAD + '导出 PNG</button>',
      '  </div>',
      '  <p class="icons-detail-note">透明底 PNG，导出到设置里的图标目录；版权归游戏所有，仅供社区创作。</p>',
    ].join('');
    ui.detailBody = ui.detail;
    ui.detailClose = ui.detail.querySelector<HTMLButtonElement>('[data-role="detailClose"]')!;
    ui.detailClose.addEventListener('click', () => paintDetail(null));
    ui.detail.querySelector<HTMLElement>('[data-role="exportOne"]')?.addEventListener('click', () => { void exportOne(id); });
    paintDetailImage();
  }

  /* 分页:事件委托在 footer 上，页签重建后不用重新绑定 */
  ui.footer.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-page-step],[data-page-to]');
    if (!btn || pageLoading || !index.ready) return;
    if (btn.dataset.pageTo) { void goPage(Number(btn.dataset.pageTo)); return; }
    const step = Number(btn.dataset.pageStep || 0);
    if (step) void goPage(page + step);
  });

  ui.grid.addEventListener('click', (ev) => {
    const cell = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.icons-cell');
    if (!cell || !cell.dataset.id) return;
    for (const c of Array.from(ui.grid.children)) c.classList.remove('is-selected');
    cell.classList.add('is-selected');
    paintDetail(cell.dataset.id);
  });

  /* ---------- 导出 ---------- */

  async function collectFilteredIds(): Promise<string[]> {
    const ids: string[] = [];
    let offset = 0;
    while (offset < Math.min(total, MAX_COLLECT)) {
      const r = await attempt('收集导出列表', () => callMethod<SearchResult>(bridge, 'search', { query: currentQuery, cat: currentCat, offset, limit: 500 }));
      if (!r.ok) throw new Error(r.error);
      const items = r.value.items.map(normalizeIconItem).filter((x): x is IconItem => !!x);
      for (const it of items) ids.push(it.id);
      offset += items.length;
      if (items.length === 0 || offset >= r.value.total) break;
    }
    return ids;
  }

  function paintResult(state: { kind: 'ok' | 'error' | 'progress'; title: string; sub?: string; dir?: string; retry?: boolean }): void {
    if (state.kind === 'progress') {
      ui.resultCard.hidden = false;
      ui.resultCard.className = 'icons-result is-progress';
      ui.resultCard.innerHTML = '<span class="icons-result-title">' + escapeHtml(state.title) + '</span>' + (state.sub ? '<span class="icons-result-sub">' + escapeHtml(state.sub) + '</span>' : '');
      return;
    }
    ui.resultCard.hidden = false;
    ui.resultCard.className = 'icons-result is-' + state.kind;
    const parts = ['<span class="icons-result-title">' + escapeHtml(state.title) + '</span>'];
    if (state.sub) parts.push('<span class="icons-result-sub">' + escapeHtml(state.sub) + '</span>');
    const actions: string[] = [];
    if (state.kind === 'ok' && state.dir) actions.push('<button type="button" class="icons-btn" data-result-action="reveal">' + ICON_FOLDER + '打开文件夹</button>');
    if (state.kind === 'error' && state.retry) actions.push('<button type="button" class="icons-btn icons-btn--primary" data-result-action="retry">再试一次</button>');
    if (actions.length) parts.push('<span class="icons-result-actions">' + actions.join('') + '</span>');
    ui.resultCard.innerHTML = parts.join('');
    ui.resultCard.querySelector<HTMLElement>('[data-result-action="reveal"]')?.addEventListener('click', () => { if (state.dir) revealOutDir(state.dir); });
    ui.resultCard.querySelector<HTMLElement>('[data-result-action="retry"]')?.addEventListener('click', () => {
      if (lastExport) void runExport(lastExport.ids, lastExport.tint);
    });
  }

  async function runExport(ids: string[], tint: string): Promise<void> {
    lastExport = { ids: [...ids], tint };
    setBusy(true);
    paintResult({ kind: 'progress', title: '正在导出…', sub: '0/' + ids.length });
    let saved = 0, failed = 0, outDir = '', firstError = '';
    for (let i = 0; i < ids.length; i += EXPORT_BATCH) {
      const batch = ids.slice(i, i + EXPORT_BATCH);
      const r = await attempt('导出图标', () => callMethod<ExportResult>(bridge, 'exportIcons', { ids: batch, tint }));
      if (!r.ok) { failed += batch.length; if (!firstError) firstError = r.error; }
      else {
        saved += r.value.saved;
        failed += r.value.failed;
        outDir = r.value.outDir || outDir;
        if (!r.value.ok && !firstError) firstError = (r.value.errors && r.value.errors[0]) || '部分图标导出失败';
      }
      paintResult({ kind: 'progress', title: '正在导出…', sub: Math.min(i + EXPORT_BATCH, ids.length) + '/' + ids.length });
    }
    setBusy(false);
    const tintLabel = tintLabelOf(tint);
    if (saved > 0 && failed === 0) {
      paintResult({ kind: 'ok', title: '已导出 ' + saved + ' 个 PNG' + (tint !== 'none' ? '（' + tintLabel + '）' : ''), dir: outDir });
      showToast('导出完成', 'ok');
    } else if (saved > 0) {
      paintResult({ kind: 'error', title: '导出完成但有失败', sub: '成功 ' + saved + ' 个，失败 ' + failed + ' 个' + (firstError ? '：' + firstError : ''), retry: true });
    } else {
      paintResult({ kind: 'error', title: '导出失败', sub: firstError || '未知原因', retry: true });
    }
  }

  async function exportOne(id: string): Promise<void> {
    if (busy) return;
    await runExport([id], exportTintArg());
  }

  async function exportFiltered(): Promise<void> {
    if (busy || !index.ready) return;
    let ids: string[] = [];
    try { ids = await collectFilteredIds(); } catch (e) { showToast(errText(e), 'error'); return; }
    if (!ids.length) { showToast('当前筛选没有可导出的图标', 'info'); return; }
    await runExport(ids, exportTintArg());
  }

  /* ---------- 导出目录 ---------- */

  async function loadExportDir(): Promise<void> {
    const r = await attempt('读取导出目录', () => callMethod<{ dir: string }>(bridge, 'getExportDir'));
    if (r.ok && r.value.dir) exportDir = r.value.dir;
  }
  let exportDir = '';

  ui.root.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-role="exportDirBtn"]');
    if (!btn) return;
    void (async () => {
      const r = await attempt('选择导出目录', () => callMethod<{ ok: boolean; dir?: string }>(bridge, 'pickExportDir'));
      if (r.ok && r.value.ok && r.value.dir) { exportDir = r.value.dir; showToast('导出目录：' + exportDir, 'ok'); }
    })();
  });

  /* ---------- 滚动自动加载 ---------- */

  /* ---------- 索引过期复查(与音频页同思路:从别的页面改了目录/重建索引后回来要刷新) ---------- */

  let indexRecheckTimer = 0;
  function scheduleIndexRecheck(): void {
    window.clearTimeout(indexRecheckTimer);
    indexRecheckTimer = window.setTimeout(() => {
      void (async () => {
        if (disposed) return;
        const next = await attempt2State();
        const builtChanged = next.builtAt !== index.builtAt || next.count !== index.count;
        const dirChanged = next.gameDir !== index.gameDir;
        if (builtChanged || dirChanged || next.ready !== index.ready) {
          index = next;
          paintIndex();
          paintToolbar();
          clearList();
          reloadSearch();
        }
        scheduleIndexRecheck();
      })();
    }, 4000);
  }

  /* ---------- 启动 ---------- */

  async function boot(): Promise<void> {
    paintDir();
    paintIndex();
    paintToolbar();
    paintPagination();
    setupObserver();
    await loadDir();
    paintDir();
    index = normalizeIndex(await attempt2State());
    paintIndex();
    if (index.ready) {
      await loadCategories();
      paintToolbar();
      reloadSearch();
    }
    await loadExportDir();
    unsubProgress = bridge.onIndexProgress(handleProgress);
    scheduleIndexRecheck();
  }

  void boot();

  return {
    dispose(): void {
      disposed = true;
      window.clearTimeout(searchTimer);
      window.clearTimeout(indexRecheckTimer);
      if (unsubProgress) { try { unsubProgress(); } catch { /* 忽略 */ } unsubProgress = null; }
      observer?.disconnect();
      for (const url of objectUrls.values()) { try { URL.revokeObjectURL(url); } catch { /* 忽略 */ } }
      objectUrls.clear();
      host.innerHTML = '';
    },
  };
}
