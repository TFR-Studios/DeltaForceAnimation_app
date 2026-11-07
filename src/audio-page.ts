/* ============================================================================
 * 音频提取(src/audio-page.ts)
 * ---------------------------------------------------------------------------
 * 应用里的"音频提取"页只有一条主线:**定位游戏目录 -> 扫描 pak 建索引 -> 检索 -> 试听 / 导出**。
 * 本文件负责这一页的全部 UI 与交互,能力一律来自主进程预载的 window.dfaeAudio
 * (契约见 electron/preload.cjs),不碰主进程、不碰 index.html、也不 import 业务模块。
 *
 * 页面结构(全部渲染进宿主元素,宿主只负责给一块容器):
 *   · 游戏目录条 —— 未设置时提供「选择游戏目录 / 自动定位」,已设置时显示路径与「更换」;
 *   · 索引卡片 —— 未建索引时「扫描游戏包」+ 首次耗时说明;构建中显示进度条;
 *     完成后显示音频条数与构建时间,索引过期时提醒重新扫描;
 *   · 工具条 —— 关键词搜索(300ms 防抖)、结果计数、「导出当前筛选全部」;
 *   · 列表 —— searchAudio 分页拉取(每页 100),滚动到底或点「加载更多」继续;
 *     每条显示真名 / codec 徽标 / 时长 / 大小 / 所属 pak,并提供「试听」「导出」;
 *   · 试听 —— previewAudio 返回 WAV 字节,转 Blob URL 交给单个 <audio> 播放。
 *     同一时刻只播一个:换一条时先暂停并释放上一条的 URL;提供「停止」;
 *   · 导出 —— 单条直接导出;「导出当前筛选全部」先按同一筛选翻页收集 id,
 *     再按 50 条一批调用 exportAudio,面板里持续显示进度与成功 / 失败数。
 *
 * 边界:
 *   · 浏览器 / 手机端没有 window.dfaeAudio:整页退化为"仅桌面客户端可用"的空状态,
 *     import 本模块不会因为缺桥而抛错;
 *   · 可重复调用 initAudioPage(host):会先销毁上一份实例(取消计时器、退订进度、
 *     释放 Blob URL、断开观察器),再清空宿主重绘;
 *   · 不引入任何新依赖,样式由本文件 import 的 ./audio-page.css 负责,全部规则都收在
 *     .audio-page 作用域内;颜色只取 style.css 里的语义令牌,深浅主题自动跟随。
 * ========================================================================== */
import './audio-page.css';

/* ---------------------------------------------------------------------------
 * 一、接口契约(与 electron/preload.cjs 的唯一约定)
 * ------------------------------------------------------------------------- */

/** 一条音频索引记录:id 是后端稳定主键,其余字段只用于展示。 */
/** 分类条目（后端按文件名规则算好，含每类条数）。 */
type CategoryCount = { key: string; label: string; count: number };

type AudioItem = {
  id: string;
  name: string;
  category?: string;
  vpath: string;
  pak: string;
  codec: string;
  rate?: number;
  channels?: number;
  duration?: number;
  size?: number;
};

type GameDirDetect = { ok: boolean; dir?: string; source?: string; error?: string };
type GameDirState = { dir: string | null; valid?: boolean };
type GameDirPick = { ok: boolean; dir?: string; error?: string };
type GameDirSet = { ok: boolean; valid: boolean; pakCount?: number; error?: string };
/** WwiseAudio 的全量覆盖统计(用于和 FModel 对账)。 */
type IndexCoverage = {
  wwiseFiles: number; wwiseAssets: number; audioAssets: number;
  otherAssets: number; withPayload: number; emptyPayload: number;
};
type IndexState = { ready: boolean; count: number; building?: boolean; builtAt?: number; stale?: boolean; coverage?: IndexCoverage };
type IndexProgress = { phase: string; done: number; total: number; detail?: string };
type SearchResult = { total: number; items: AudioItem[] };
type ExportResult = { ok: boolean; saved: number; failed: number; outDir?: string; error?: string };
type PreviewResult = { ok: boolean; data?: Uint8Array; error?: string };

/** 主进程桥。网页版 / 手机端为 undefined;方法在运行期仍逐个做 typeof 防御。 */
type AudioBridge = {
  isDesktop: true;
  detectGameDir(): Promise<GameDirDetect>;
  getGameDir(): Promise<GameDirState>;
  pickGameDir(): Promise<GameDirPick>;
  setGameDir(dir: string): Promise<GameDirSet>;
  getIndexState(): Promise<IndexState>;
  buildIndex(): Promise<{ ok: boolean; count?: number; error?: string }>;
  onIndexProgress(cb: (p: IndexProgress) => void): () => void;
  searchAudio(opts: { query?: string; category?: string; offset?: number; limit?: number }): Promise<SearchResult>;
  getCategories(): Promise<{ items: CategoryCount[] }>;
  exportAudio(opts: { ids: string[]; decode?: boolean }): Promise<ExportResult>;
  previewAudio(id: string): Promise<PreviewResult>;
  getExportDir(): Promise<{ dir: string }>;
  pickExportDir(): Promise<{ ok: boolean; dir?: string; error?: string }>;
};

/* ---------------------------------------------------------------------------
 * 二、常量与通用工具
 * ------------------------------------------------------------------------- */

const PAGE_SIZE = 100;
const EXPORT_BATCH = 50;
const SEARCH_DEBOUNCE = 300;
const TOAST_MS = 4600;
const MAX_COLLECT = 100000;

interface AttemptOk<T> { ok: true; value: T }
interface AttemptErr { ok: false; error: string }
type Attempt<T> = AttemptOk<T> | AttemptErr;

type BulkState = {
  active: boolean;
  phase: 'collect' | 'export';
  done: number;
  total: number;
  saved: number;
  failed: number;
  note: string;
  kind: 'info' | 'ok' | 'error';
};

const ICONS = {
  search: '<path d="M11.74 10.34a6.5 6.5 0 1 0-1.397 1.398l.098.115 3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>',
  clear: '<path d="M4.65 4.65a.8.8 0 0 1 1.13 0L8 6.87l2.22-2.22a.8.8 0 1 1 1.13 1.13L9.13 8l2.22 2.22a.8.8 0 0 1-1.13 1.13L8 9.13l-2.22 2.22a.8.8 0 0 1-1.13-1.13L6.87 8 4.65 5.78a.8.8 0 0 1 0-1.13z"/>',
  music: '<path d="M6.2 1.2a.9.9 0 0 1 .9-.72l6 1.45a.9.9 0 0 1 .7.88v1.12a.9.9 0 0 1-1.08.88L7.6 3.83v6.3a2.53 2.53 0 1 1-1.8-2.42V1.2z"/><path d="M6.05 8.35a3.4 3.4 0 0 0-.25-.13v2.26a1.63 1.63 0 1 0 1.8 1.62V9.46a3.4 3.4 0 0 0-1.55-1.11z" opacity=".55"/>',
  desktop: '<path d="M2.5 2A1.5 1.5 0 0 0 1 3.5v7A1.5 1.5 0 0 0 2.5 12h4.25v1.5H5a.75.75 0 0 0 0 1.5h6a.75.75 0 0 0 0-1.5H9.25V12h4.25A1.5 1.5 0 0 0 15 10.5v-7A1.5 1.5 0 0 0 13.5 2zm0 1.5h11v7h-11z"/>',
} as const;

function icon(name: keyof typeof ICONS, cls = 'bi'): string {
  return '<svg class="' + cls + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' + ICONS[name] + '</svg>';
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) => (
    char === '&' ? '&amp;'
      : char === '<' ? '&lt;'
        : char === '>' ? '&gt;'
          : char === '"' ? '&quot;'
            : '&#39;'
  ));
}

function errText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error.trim() || '未知错误';
  if (error == null) return '未知错误';
  try {
    const text = JSON.stringify(error);
    return text && text !== '{}' ? text : '未知错误';
  } catch {
    return String(error);
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function basename(path: string): string {
  const name = path.split(/[\\/]/).pop() || '';
  return name.trim();
}

function formatDuration(seconds?: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.floor(seconds);
  let value = whole;
  let tenths = Math.floor((seconds - whole) * 10 + 0.5);
  if (tenths >= 10) { value += 1; tenths = 0; }
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  const core = hours > 0
    ? hours + ':' + pad(minutes) + ':' + pad(secs)
    : minutes + ':' + pad(secs);
  return hours === 0 && tenths > 0 ? core + '.' + tenths : core;
}

function exactSeconds(seconds?: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '未知时长';
  return seconds.toFixed(2) + ' 秒';
}

function formatSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return Math.round(bytes) + ' B';
  const kb = bytes / 1024;
  if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + ' KB';
  const mb = kb / 1024;
  if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + ' MB';
  return (mb / 1024).toFixed(2) + ' GB';
}

function formatRate(rate?: number): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return '';
  const khz = rate / 1000;
  return (khz < 10 ? khz.toFixed(1) : String(Math.round(khz))) + ' kHz';
}

function formatBuiltAt(stamp?: number): string {
  if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return '';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function codecInfo(codec: string): { label: string; key: string } {
  const raw = String(codec || '').trim();
  const lower = raw.toLowerCase();
  let label = raw ? raw.toUpperCase() : '未知';
  if (lower.includes('opus')) label = 'Opus';
  else if (lower.includes('vorbis')) label = 'Vorbis';
  else if (lower.includes('pcm') || lower.includes('wav')) label = 'PCM';
  else if (lower.includes('mp3')) label = 'MP3';
  else if (lower.includes('aac')) label = 'AAC';
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'unknown';
  return { label, key };
}

const PHASE_LABELS: Record<string, string> = {
  scan: '扫描游戏包',
  scanning: '扫描游戏包',
  pak: '扫描游戏包',
  parse: '解析音频资源',
  parsing: '解析音频资源',
  decode: '解析音频资源',
  decoding: '解析音频资源',
  media: '解析音频资源',
  index: '写入索引',
  indexing: '写入索引',
  write: '写入索引',
  saving: '写入索引',
  done: '完成',
  ready: '完成',
};

function phaseLabel(phase: string): string {
  const raw = String(phase || '').trim();
  return PHASE_LABELS[raw.toLowerCase()] || raw || '处理中';
}

function normalizeAudioItem(raw: unknown): AudioItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  const vpath = typeof record.vpath === 'string' ? record.vpath.trim() : '';
  const rawName = typeof record.name === 'string' ? record.name.trim() : '';
  return {
    id,
    name: rawName || basename(vpath) || id,
    vpath,
    pak: typeof record.pak === 'string' ? record.pak.trim() : '',
    codec: typeof record.codec === 'string' ? record.codec.trim() : '',
    rate: finiteNumber(record.rate),
    channels: finiteNumber(record.channels),
    duration: finiteNumber(record.duration),
    size: finiteNumber(record.size),
  };
}

function normalizeCoverage(raw: unknown): IndexCoverage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => Math.max(0, Math.floor(finiteNumber(v) ?? 0));
  return {
    wwiseFiles: num(r.wwiseFiles), wwiseAssets: num(r.wwiseAssets), audioAssets: num(r.audioAssets),
    otherAssets: num(r.otherAssets), withPayload: num(r.withPayload), emptyPayload: num(r.emptyPayload),
  };
}

function normalizeIndex(raw: unknown): IndexState {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    ready: record.ready === true,
    count: Math.max(0, Math.floor(finiteNumber(record.count) ?? 0)),
    building: record.building === true,
    builtAt: finiteNumber(record.builtAt),
    stale: record.stale === true,
    coverage: normalizeCoverage(record.coverage),
  };
}

function normalizeProgress(raw: unknown): IndexProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const phase = typeof record.phase === 'string' && record.phase.trim() ? record.phase.trim() : '处理中';
  const done = Math.max(0, Math.floor(finiteNumber(record.done) ?? 0));
  const total = Math.max(0, Math.floor(finiteNumber(record.total) ?? 0));
  const detail = typeof record.detail === 'string' ? record.detail.trim() : '';
  return { phase, done, total, ...(detail ? { detail } : {}) };
}

/** previewAudio 的数据在不同 IPC 序列化路径下可能是 Uint8Array / ArrayBuffer / 数组。 */
function toBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) {
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      const value = raw[i];
      bytes[i] = typeof value === 'number' && Number.isFinite(value) ? value & 0xff : 0;
    }
    return bytes;
  }
  if (raw && typeof raw === 'object') {
    const record = raw as { data?: unknown; buffer?: unknown };
    if (record.data !== undefined) return toBytes(record.data);
    if (record.buffer !== undefined) return toBytes(record.buffer);
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 三、DOM 骨架
 * ------------------------------------------------------------------------- */

type Ui = {
  root: HTMLElement;
  dirbar: HTMLElement;
  dirPath: HTMLElement;
  dirNote: HTMLElement;
  dirPick: HTMLButtonElement;
  dirDetect: HTMLButtonElement;
  dirChange: HTMLButtonElement;
  index: HTMLElement;
  indexDesc: HTMLElement;
  indexNote: HTMLElement;
  indexScan: HTMLButtonElement;
  indexRefresh: HTMLButtonElement;
  indexProgress: HTMLElement;
  indexTrack: HTMLElement;
  indexFill: HTMLElement;
  indexProgressText: HTMLElement;
  indexProgressPct: HTMLElement;
  search: HTMLInputElement;
  searchClear: HTMLButtonElement;
  cats: HTMLElement;
  total: HTMLElement;
  exportAll: HTMLButtonElement;
  bulk: HTMLElement;
  bulkTitle: HTMLElement;
  bulkStats: HTMLElement;
  bulkTrack: HTMLElement;
  bulkFill: HTMLElement;
  bulkNote: HTMLElement;
  player: HTMLElement;
  playerKicker: HTMLElement;
  playerName: HTMLElement;
  audio: HTMLAudioElement;
  playerStop: HTMLButtonElement;
  alert: HTMLElement;
  alertText: HTMLElement;
  alertRetry: HTMLButtonElement;
  skeleton: HTMLElement;
  list: HTMLUListElement;
  empty: HTMLElement;
  emptyTitle: HTMLElement;
  emptyDesc: HTMLElement;
  emptyAction: HTMLButtonElement;
  more: HTMLElement;
  moreBtn: HTMLButtonElement;
  moreNote: HTMLElement;
  footNote: HTMLElement;
  footDir: HTMLElement;
  footDirBtn: HTMLButtonElement;
  toast: HTMLElement;
};

let instanceSeq = 0;

function buildShell(host: HTMLElement): Ui {
  instanceSeq += 1;
  const uid = 'audio-page-' + instanceSeq.toString(36);
  const searchId = uid + '-search';
  const indexTitleId = uid + '-index-title';

  const skeletonRows = Array.from({ length: 6 }, () => '<div class="audio-skeleton-row"></div>').join('');
  const root = document.createElement('div');
  root.className = 'audio-page';
  root.innerHTML = [
    '<div class="audio-wrap">',
    '  <header class="page-head audio-head">',
    '    <div class="audio-head-main">',
    '      <h1 class="page-title" id="audioTitle">音频提取</h1>',
    '      <p class="page-sub">从游戏包中检索音效与音乐,试听后导出为 WAV;仅桌面客户端可用</p>',
    '    </div>',
    '  </header>',
    '  <section class="audio-dirbar" data-role="dirbar" data-state="loading" aria-label="游戏目录">',
    '    <span class="audio-dirbar-dot" aria-hidden="true"></span>',
    '    <div class="audio-dirbar-main">',
    '      <span class="audio-dirbar-label">游戏目录</span>',
    '      <code class="audio-dirbar-path is-empty" data-role="dir-path">正在读取游戏目录…</code>',
    '      <span class="audio-dirbar-note" data-role="dir-note" hidden></span>',
    '    </div>',
    '    <div class="audio-dirbar-actions">',
    '      <button type="button" class="audio-btn" data-role="dir-pick" data-df-native>选择游戏目录</button>',
    '      <button type="button" class="audio-btn" data-role="dir-detect" data-df-native>自动定位</button>',
    '      <button type="button" class="audio-btn" data-role="dir-change" data-df-native hidden>更换</button>',
    '    </div>',
    '  </section>',
    '  <section class="audio-index" data-role="index" aria-labelledby="' + indexTitleId + '">',
    '    <div class="audio-index-head">',
    '      <div class="audio-index-copy">',
    '        <h2 class="audio-index-title" id="' + indexTitleId + '">音频索引</h2>',
    '        <p class="audio-index-desc" data-role="index-desc">正在读取索引状态…</p>',
    '        <p class="audio-index-note" data-role="index-note" hidden></p>',
    '      </div>',
    '      <div class="audio-index-actions">',
    '        <button type="button" class="audio-btn audio-btn-primary" data-role="index-scan" data-df-native disabled>扫描游戏包</button>',
    '        <button type="button" class="audio-btn" data-role="index-refresh" data-df-native hidden>刷新状态</button>',
    '      </div>',
    '    </div>',
    '    <div class="audio-progress" data-role="index-progress" hidden>',
    '      <div class="audio-progress-track" data-role="index-track">',
    '        <span class="audio-progress-fill" data-role="index-fill"></span>',
    '      </div>',
    '      <div class="audio-progress-meta">',
    '        <span data-role="index-progress-text"></span>',
    '        <span data-role="index-progress-pct"></span>',
    '      </div>',
    '    </div>',
    '  </section>',
    '  <div class="audio-bar">',
    '    <div class="audio-search">',
    '      <label class="audio-search-label" for="' + searchId + '">搜索音频</label>',
    '      <div class="audio-search-box">',
    icon('search', 'bi audio-search-ico'),
    '        <input type="search" id="' + searchId + '" data-role="search" placeholder="索引建立后可搜索名称 / 路径 / pak…" autocomplete="off" spellcheck="false" disabled />',
    '        <button type="button" class="audio-search-clear" data-role="search-clear" data-df-native title="清空搜索" aria-label="清空搜索" hidden>' + icon('clear') + '</button>',
    '      </div>',
    '    </div>',
    '    <div class="audio-bar-actions">',
    '      <span class="audio-total" data-role="total" aria-live="polite"></span>',
    '      <button type="button" class="audio-btn audio-btn-primary" data-role="export-all" data-df-native disabled>导出当前筛选全部</button>',
    '    </div>',
    '  </div>',
    '  <div class="audio-cats" data-role="cats" role="group" aria-label="按类别筛选音频" hidden></div>',
    '  <div class="audio-bulk" data-role="bulk" data-kind="info" hidden role="status" aria-live="polite">',
    '    <div class="audio-bulk-head">',
    '      <span class="audio-bulk-title" data-role="bulk-title"></span>',
    '      <span class="audio-bulk-stats" data-role="bulk-stats"></span>',
    '    </div>',
    '    <div class="audio-progress">',
    '      <div class="audio-progress-track" data-role="bulk-track">',
    '        <span class="audio-progress-fill" data-role="bulk-fill"></span>',
    '      </div>',
    '    </div>',
    '    <p class="audio-bulk-note" data-role="bulk-note" hidden></p>',
    '  </div>',
    '  <div class="audio-player" data-role="player" hidden>',
    '    <div class="audio-player-main">',
    '      <span class="audio-player-kicker" data-role="player-kicker">正在试听</span>',
    '      <span class="audio-player-name" data-role="player-name"></span>',
    '    </div>',
    '    <audio data-role="audio" controls preload="auto"></audio>',
    '    <button type="button" class="audio-btn audio-player-stop" data-role="player-stop" data-df-native>停止</button>',
    '  </div>',
    '  <div class="audio-alert" data-role="alert" role="alert" hidden>',
    '    <span class="audio-alert-text" data-role="alert-text"></span>',
    '    <button type="button" class="audio-btn audio-btn-sm" data-role="alert-retry" data-df-native>重试</button>',
    '  </div>',
    '  <div class="audio-stage">',
    '    <div class="audio-skeleton" data-role="skeleton" aria-hidden="true" hidden>' + skeletonRows + '</div>',
    '    <ul class="audio-list" data-role="list" hidden></ul>',
    '    <div class="audio-empty" data-role="empty" hidden>',
    icon('music', 'bi bi-xl audio-empty-ico'),
    '      <p class="audio-empty-title" data-role="empty-title"></p>',
    '      <p class="audio-empty-desc" data-role="empty-desc"></p>',
    '      <button type="button" class="audio-btn" data-role="empty-action" data-df-native hidden></button>',
    '    </div>',
    '  </div>',
    '  <div class="audio-more" data-role="more" hidden>',
    '    <button type="button" class="audio-btn audio-btn-ghost" data-role="more-btn" data-df-native>加载更多</button>',
    '    <span class="audio-more-note" data-role="more-note"></span>',
    '  </div>',
    '  <footer class="audio-foot">',
    '    <span class="audio-foot-note" data-role="foot-note"></span>',
    '    <span class="audio-foot-dir">',
    '      <span>导出到</span>',
    '      <code data-role="foot-dir">读取中…</code>',
    '      <button type="button" class="audio-link" data-role="foot-dir-btn" data-df-native>更改</button>',
    '    </span>',
    '  </footer>',
    '</div>',
    '<p class="audio-toast" data-role="toast" role="status" aria-live="polite" hidden></p>',
  ].join('\n');

  host.replaceChildren(root);

  const q = <T extends Element>(role: string): T => {
    const element = root.querySelector<T>('[data-role="' + role + '"]');
    if (!element) throw new Error('音频页缺少元素: ' + role);
    return element;
  };

  return {
    root,
    dirbar: q<HTMLElement>('dirbar'),
    dirPath: q<HTMLElement>('dir-path'),
    dirNote: q<HTMLElement>('dir-note'),
    dirPick: q<HTMLButtonElement>('dir-pick'),
    dirDetect: q<HTMLButtonElement>('dir-detect'),
    dirChange: q<HTMLButtonElement>('dir-change'),
    index: q<HTMLElement>('index'),
    indexDesc: q<HTMLElement>('index-desc'),
    indexNote: q<HTMLElement>('index-note'),
    indexScan: q<HTMLButtonElement>('index-scan'),
    indexRefresh: q<HTMLButtonElement>('index-refresh'),
    indexProgress: q<HTMLElement>('index-progress'),
    indexTrack: q<HTMLElement>('index-track'),
    indexFill: q<HTMLElement>('index-fill'),
    indexProgressText: q<HTMLElement>('index-progress-text'),
    indexProgressPct: q<HTMLElement>('index-progress-pct'),
    search: q<HTMLInputElement>('search'),
    searchClear: q<HTMLButtonElement>('search-clear'),
    cats: q<HTMLElement>('cats'),
    total: q<HTMLElement>('total'),
    exportAll: q<HTMLButtonElement>('export-all'),
    bulk: q<HTMLElement>('bulk'),
    bulkTitle: q<HTMLElement>('bulk-title'),
    bulkStats: q<HTMLElement>('bulk-stats'),
    bulkTrack: q<HTMLElement>('bulk-track'),
    bulkFill: q<HTMLElement>('bulk-fill'),
    bulkNote: q<HTMLElement>('bulk-note'),
    player: q<HTMLElement>('player'),
    playerKicker: q<HTMLElement>('player-kicker'),
    playerName: q<HTMLElement>('player-name'),
    audio: q<HTMLAudioElement>('audio'),
    playerStop: q<HTMLButtonElement>('player-stop'),
    alert: q<HTMLElement>('alert'),
    alertText: q<HTMLElement>('alert-text'),
    alertRetry: q<HTMLButtonElement>('alert-retry'),
    skeleton: q<HTMLElement>('skeleton'),
    list: q<HTMLUListElement>('list'),
    empty: q<HTMLElement>('empty'),
    emptyTitle: q<HTMLElement>('empty-title'),
    emptyDesc: q<HTMLElement>('empty-desc'),
    emptyAction: q<HTMLButtonElement>('empty-action'),
    more: q<HTMLElement>('more'),
    moreBtn: q<HTMLButtonElement>('more-btn'),
    moreNote: q<HTMLElement>('more-note'),
    footNote: q<HTMLElement>('foot-note'),
    footDir: q<HTMLElement>('foot-dir'),
    footDirBtn: q<HTMLButtonElement>('foot-dir-btn'),
    toast: q<HTMLElement>('toast'),
  };
}

/** 网页版 / 手机端的退化页。只依赖标题与说明,不碰任何桥方法。 */
function renderUnavailable(host: HTMLElement): void {
  const root = document.createElement('div');
  root.className = 'audio-page';
  root.innerHTML = [
    '<div class="audio-wrap">',
    '  <header class="page-head audio-head">',
    '    <div class="audio-head-main">',
    '      <h1 class="page-title" id="audioTitle">音频提取</h1>',
    '      <p class="page-sub">从游戏包中检索音效与音乐,试听后导出为 WAV</p>',
    '    </div>',
    '  </header>',
    '  <section class="audio-unavailable" aria-labelledby="audioUnavailableTitle">',
    icon('desktop', 'bi audio-unavailable-ico'),
    '    <h2 class="audio-unavailable-title" id="audioUnavailableTitle">仅桌面客户端可用</h2>',
    '    <p class="audio-unavailable-desc">音频提取需要读取本机的游戏目录与 pak 文件,浏览器 / 手机端没有这项能力。请在 Windows 桌面版中打开本页。</p>',
    '  </section>',
    '</div>',
  ].join('\n');
  host.replaceChildren(root);
}

/* ---------------------------------------------------------------------------
 * 四、页面实例
 * ------------------------------------------------------------------------- */

type PageController = { dispose(): void };

let currentController: PageController | null = null;

/** 页面入口:可重复调用。重复调用会先销毁上一份实例,再把 UI 重绘进 host。 */
export function initAudioPage(host: HTMLElement): void {
  if (!host) return;
  if (currentController) {
    try { currentController.dispose(); } catch { /* 销毁失败也要继续重绘 */ }
    currentController = null;
  }
  const bridge = readBridge();
  if (!bridge) {
    renderUnavailable(host);
    currentController = {
      dispose() {
        host.replaceChildren();
      },
    };
    return;
  }
  currentController = createAudioPage(host, bridge);
}

function readBridge(): AudioBridge | null {
  try {
    const raw = (window as unknown as { dfaeAudio?: unknown }).dfaeAudio;
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as { isDesktop?: unknown };
    if (record.isDesktop === false) return null;
    return raw as AudioBridge;
  } catch {
    return null;
  }
}

function createAudioPage(host: HTMLElement, bridge: AudioBridge): PageController {
  const ui = buildShell(host);
  let disposed = false;
  let searchTimer = 0;
  let toastTimer = 0;
  let indexSeq = 0;
  let indexRecheckTimer = 0;
  let indexRecheckCount = 0;
  let progressUnsub: (() => void) | null = null;
  let moreObserver: IntersectionObserver | null = null;
  let emptyActionKind: '' | 'scan' | 'clear' = '';

  const rows = new Map<string, HTMLElement>();
  const byId = new Map<string, AudioItem>();

  const state = {
    gameDir: '',
    gameDirKnown: false,
    dirBusy: '' as '' | 'pick' | 'detect' | 'set',
    dirNote: '',
    index: null as IndexState | null,
    indexLoading: true,
    indexError: '',
    building: false,
    progress: null as IndexProgress | null,
    query: '',
    category: 'all',
    categories: [] as CategoryCount[],
    searchPending: false,
    items: [] as AudioItem[],
    total: 0,
    loaded: false,
    listLoading: false,
    listError: '',
    searchSeq: 0,
    previewId: '',
    previewLoadingId: '',
    previewUrl: '',
    previewEnded: false,
    previewSeq: 0,
    exporting: new Set<string>(),
    bulk: null as BulkState | null,
    exportDir: '',
    exportDirKnown: false,
    exportDirBusy: false,
  };

  /* -------------------------------------------------------------------------
   * 4.1 桥调用与进度订阅
   * ----------------------------------------------------------------------- */

  async function callBridge<T>(method: keyof AudioBridge, what: string, args: unknown[] = []): Promise<Attempt<T>> {
    try {
      const fn = (bridge as unknown as Record<string, unknown>)[method as string];
      if (typeof fn !== 'function') {
        return { ok: false, error: what + '失败:当前客户端不支持该操作' };
      }
      const value = await (fn as (...params: unknown[]) => Promise<T>).apply(bridge, args);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: what + '失败:' + errText(error) };
    }
  }

  function handleProgress(raw: IndexProgress): void {
    if (disposed) return;
    const progress = normalizeProgress(raw);
    if (!progress) return;
    state.progress = progress;
    if (state.building || state.index?.building) paintIndex();
  }

  function subscribeProgress(): void {
    try {
      if (typeof bridge.onIndexProgress !== 'function') return;
      const unsubscribe = bridge.onIndexProgress(handleProgress);
      if (typeof unsubscribe === 'function') progressUnsub = unsubscribe;
    } catch {
      /* 进度订阅失败不影响手动扫描:结果仍会通过 buildIndex 的返回值刷新 */
    }
  }

  /* -------------------------------------------------------------------------
   * 4.2 状态绘制
   * ----------------------------------------------------------------------- */

  function canSearch(): boolean {
    return !disposed && !!state.gameDir && !!state.index?.ready;
  }

  function paintDir(): void {
    const hasDir = !!state.gameDir;
    ui.dirbar.dataset.state = !state.gameDirKnown ? 'loading' : hasDir ? 'ready' : 'unset';
    ui.dirPath.textContent = !state.gameDirKnown
      ? '正在读取游戏目录…'
      : hasDir ? state.gameDir : '尚未选择游戏目录';
    ui.dirPath.title = hasDir ? state.gameDir : '';
    ui.dirPath.classList.toggle('is-empty', !hasDir);
    ui.dirNote.hidden = !state.dirNote;
    ui.dirNote.textContent = state.dirNote;

    const busy = state.dirBusy !== '';
    ui.dirPick.hidden = hasDir;
    ui.dirDetect.hidden = hasDir;
    ui.dirChange.hidden = !hasDir;
    ui.dirPick.disabled = busy;
    ui.dirDetect.disabled = busy;
    ui.dirChange.disabled = busy;
    ui.dirPick.textContent = state.dirBusy === 'pick' ? '选择中…' : '选择游戏目录';
    ui.dirDetect.textContent = state.dirBusy === 'detect' ? '定位中…' : '自动定位';
    ui.dirChange.textContent = state.dirBusy === 'pick' || state.dirBusy === 'set' ? '选择中…' : '更换';
  }

  function setProgress(fill: HTMLElement, track: HTMLElement, done: number, total: number, text: string): void {
    const determinate = total > 0;
    const percent = determinate ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
    if (determinate) fill.style.width = percent + '%';
    else fill.style.width = '';
    track.classList.toggle('is-indeterminate', !determinate);
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    if (determinate) track.setAttribute('aria-valuenow', String(percent));
    else track.removeAttribute('aria-valuenow');
    track.setAttribute('aria-valuetext', text || (determinate ? percent + '%' : '处理中'));
  }

  function paintIndex(): void {
    const building = state.building || !!state.index?.building;
    const ready = !!state.index?.ready;
    const count = state.index?.count ?? 0;
    let desc = '正在读取索引状态…';
    let note = '';
    let noteKind: 'info' | 'warn' | 'error' = 'info';
    let showProgress = false;
    let scanText = ready ? '重新扫描' : '扫描游戏包';

    if (!state.gameDirKnown) {
      desc = '正在读取游戏目录…';
    } else if (!state.gameDir) {
      desc = '先设置游戏目录,才能扫描游戏包并建立音频索引。';
      note = '索引只读取目录里的 pak,不会改动游戏文件。';
    } else if (state.indexLoading && !state.index) {
      desc = '正在读取索引状态…';
    } else if (building) {
      desc = '正在扫描游戏包并解析音频资源;首次大约需要 20–60 秒。';
      note = '构建期间可以切到其它页面,回来时会看到最新状态。';
      showProgress = true;
      scanText = '扫描中…';
    } else if (ready) {
      desc = count > 0
        ? '索引中已有 ' + count + ' 条音频;可直接搜索、试听与导出。'
        : '索引已建立,但没有找到音频资源。';
      const built = state.index?.builtAt ? formatBuiltAt(state.index.builtAt) : '';
      if (built) note = '构建于 ' + built;
      /* 和 FModel 对账:玩家在 FModel 里看到的是「文件数」,这里是「可导出音频数」,
       * 两者差着一倍多的 .uexp/.ubulk 与事件定义,不写清楚就会被当成漏扫。 */
      const cov = state.index?.coverage;
      if (cov && cov.wwiseFiles > 0) {
        const fmt = (n: number) => n.toLocaleString('zh-CN');
        const covLine = 'WwiseAudio 全量 ' + fmt(cov.wwiseFiles) + ' 个文件 / ' + fmt(cov.wwiseAssets) +
          ' 个资产,其中可导出音频 ' + fmt(count) + ' 条,其余 ' + fmt(cov.otherAssets) + ' 个是事件定义与参数(不含音频)。';
        note = (note ? note + ' · ' : '') + covLine;
      }
      if (state.index?.stale) {
        note = (note ? note + ' · ' : '') + '游戏包可能有更新,建议重新扫描。';
        noteKind = 'warn';
        scanText = '重新扫描';
      }
      if (state.indexError) {
        note = (note ? note + ' · ' : '') + '最近一次刷新失败:' + state.indexError;
        noteKind = 'warn';
      }
      if (!note && count === 0) note = '游戏包中可能没有音频资源,或需要重新扫描。';
    } else if (state.indexError) {
      desc = '索引还没有准备好。读取状态时出错:' + state.indexError;
      note = '可以重试读取状态,或直接扫描游戏包。';
      noteKind = 'error';
    } else {
      desc = '还没有音频索引。首次扫描约 20–60 秒,完成后会列出游戏包内的全部音频。';
      note = '扫描只读取游戏包,不会改动游戏目录。';
    }

    ui.indexDesc.textContent = desc;
    ui.indexNote.hidden = !note;
    ui.indexNote.textContent = note;
    ui.indexNote.dataset.kind = noteKind;
    ui.indexScan.textContent = scanText;
    ui.indexScan.disabled = !state.gameDir || building || state.indexLoading || !!state.dirBusy;
    ui.indexScan.title = !state.gameDir
      ? '请先选择游戏目录'
      : building ? '正在扫描游戏包' : '扫描游戏包并建立音频索引';
    ui.indexRefresh.hidden = !state.indexError;
    ui.indexRefresh.disabled = state.indexLoading || building;
    ui.indexProgress.hidden = !showProgress;
    ui.index.setAttribute('aria-busy', building || state.indexLoading ? 'true' : 'false');

    if (showProgress) {
      const progress = state.progress;
      const done = progress?.done ?? 0;
      const total = progress?.total ?? 0;
      const label = progress ? phaseLabel(progress.phase) : '准备扫描';
      const pieces = [label];
      if (total > 0) pieces.push(done + ' / ' + total);
      else if (done > 0) pieces.push(String(done));
      if (progress?.detail) pieces.push(progress.detail);
      const text = pieces.filter(Boolean).join(' · ');
      ui.indexProgressText.textContent = text;
      ui.indexProgressPct.textContent = total > 0 ? Math.round(Math.min(1, done / total) * 100) + '%' : '';
      setProgress(ui.indexFill, ui.indexTrack, done, total, text);
    }
  }

  /** 分类胶囊：`全部` + 后端给的各类，显示条数，单选。 */
  function paintCats(): void {
    const ready = canSearch();
    const items = state.categories;
    if (!ready || !items.length) {
      ui.cats.hidden = true;
      ui.cats.replaceChildren();
      return;
    }
    ui.cats.hidden = false;
    const total = items.reduce((sum, c) => sum + (c.count || 0), 0);
    const list = [{ key: 'all', label: '全部', count: total }].concat(items);
    const frag = document.createDocumentFragment();
    for (const c of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'audio-chip';
      b.dataset.category = c.key;
      const active = state.category === c.key;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      b.append(document.createTextNode(c.label));
      const num = document.createElement('b');
      num.textContent = c.count.toLocaleString('zh-CN');
      b.append(num);
      frag.append(b);
    }
    ui.cats.replaceChildren(frag);
  }

  async function loadCategories(): Promise<void> {
    const fn = (bridge as unknown as Record<string, unknown>).getCategories;
    if (typeof fn !== 'function') { state.categories = []; paintCats(); return; }
    const result = await callBridge<{ items: CategoryCount[] }>('getCategories', '读取音频分类');
    if (disposed) return;
    const items = result.ok && result.value && Array.isArray(result.value.items) ? result.value.items : [];
    state.categories = items.filter((c) => c && typeof c.key === 'string' && typeof c.label === 'string');
    if (state.category !== 'all' && !state.categories.some((c) => c.key === state.category)) state.category = 'all';
    paintCats();
  }

  function paintToolbar(): void {
    paintCats();
    const ready = canSearch();
    const bulkActive = !!state.bulk?.active;
    const searchEnabled = ready && !bulkActive;
    ui.search.disabled = !searchEnabled;
    ui.searchClear.disabled = !searchEnabled;
    ui.searchClear.hidden = !ui.search.value;
    ui.search.placeholder = ready
      ? '搜索音频名称 / 路径 / pak…'
      : state.building || state.index?.building
        ? '索引构建中,稍后可搜索'
        : !state.gameDir
          ? '请先选择游戏目录'
          : '索引建立后可搜索';

    const loadingMore = state.listLoading && state.loaded;
    ui.exportAll.disabled = !ready
      || state.total <= 0
      || bulkActive
      || state.listLoading
      || state.searchPending
      || state.exporting.size > 0;
    ui.exportAll.textContent = bulkActive ? '正在导出…' : '导出当前筛选全部';
    ui.exportAll.title = ready && state.total > 0
      ? '导出当前筛选的 ' + state.total + ' 条音频'
      : '当前没有可导出的音频';

    if (!ready) {
      ui.total.textContent = '';
      return;
    }
    if (state.total > 0) {
      ui.total.textContent = (state.query ? '匹配 ' : '共 ') + state.total + ' 条'
        + ' · 已加载 ' + state.items.length + ' 条'
        + (loadingMore ? ' · 正在加载更多…' : '');
    } else {
      ui.total.textContent = state.listLoading ? '正在检索…' : state.loaded ? '没有匹配结果' : '';
    }
  }

  function paintFooter(): void {
    const pieces: string[] = [];
    if (!state.gameDirKnown) pieces.push('正在读取游戏目录…');
    else if (!state.gameDir) pieces.push('尚未设置游戏目录');
    else if (canSearch()) {
      pieces.push('共 ' + state.total + ' 条');
      if (state.category !== 'all') {
        const hit = state.categories.find((c) => c.key === state.category);
        if (hit) pieces.push('分类「' + hit.label + '」');
      }
      if (state.query) pieces.push('关键词「' + state.query + '」');
      pieces.push('已加载 ' + state.items.length + ' 条');
    } else if (state.building || state.index?.building) {
      pieces.push('索引构建中');
    } else {
      pieces.push('索引未就绪');
    }
    ui.footNote.textContent = pieces.join(' · ');
    ui.footDir.textContent = state.exportDir || (state.exportDirKnown ? '默认目录' : '读取中…');
    ui.footDir.title = state.exportDir;
    ui.footDirBtn.disabled = state.exportDirBusy || !!state.bulk?.active;
    ui.footDirBtn.textContent = state.exportDirBusy ? '选择中…' : '更改';
  }

  function paintBulk(): void {
    const bulk = state.bulk;
    if (!bulk) {
      ui.bulk.hidden = true;
      return;
    }
    ui.bulk.hidden = false;
    ui.bulk.dataset.kind = bulk.kind;
    const title = bulk.active
      ? (bulk.phase === 'collect' ? '正在收集筛选结果…' : '正在导出音频…')
      : bulk.kind === 'ok' ? '导出完成' : '导出未全部完成';
    ui.bulkTitle.textContent = title;

    const stats: string[] = [];
    if (bulk.active && bulk.phase === 'collect') {
      stats.push('已收集 ' + bulk.done + (bulk.total > 0 ? ' / ' + bulk.total : ''));
    } else {
      if (bulk.total > 0) stats.push('进度 ' + Math.min(bulk.done, bulk.total) + ' / ' + bulk.total);
      stats.push('成功 ' + bulk.saved + ' 条');
      stats.push('失败 ' + bulk.failed + ' 条');
    }
    ui.bulkStats.textContent = stats.join(' · ');
    ui.bulkNote.hidden = !bulk.note;
    ui.bulkNote.textContent = bulk.note;

    const total = bulk.total;
    const done = Math.min(bulk.done, total);
    const text = stats.join(' · ');
    setProgress(ui.bulkFill, ui.bulkTrack, done, total, text);
  }

  function paintPlayer(): void {
    const visible = !!state.previewId;
    ui.player.hidden = !visible;
    if (!visible) return;
    const item = byId.get(state.previewId);
    const name = item ? item.name : '音频';
    ui.playerName.textContent = name;
    ui.playerName.title = item ? (item.vpath || item.name) : '';
    ui.audio.setAttribute('aria-label', '试听:' + name);
    ui.playerKicker.textContent = state.previewEnded ? '播放结束' : '正在试听';
  }

  function paintList(): void {
    const ready = canSearch();
    const building = state.building || !!state.index?.building;
    const initialLoading = ready && state.listLoading && !state.loaded;
    const showSkeleton = initialLoading;
    const showAlert = !!state.listError;
    const hasItems = state.items.length > 0;

    ui.skeleton.hidden = !showSkeleton;
    ui.alert.hidden = !showAlert;
    if (showAlert) ui.alertText.textContent = state.listError;
    ui.alertRetry.disabled = state.listLoading;
    ui.list.hidden = !hasItems;
    ui.list.setAttribute('aria-busy', state.listLoading ? 'true' : 'false');
    ui.empty.hidden = showSkeleton || showAlert || hasItems;

    if (!ui.empty.hidden) {
      let title = '正在读取音频索引…';
      let desc = '稍等一下,正在确认游戏目录与索引状态。';
      let action: '' | 'scan' | 'clear' = '';
      if (!state.gameDirKnown) {
        title = '正在读取游戏目录…';
        desc = '稍等一下,正在确认游戏目录状态。';
      } else if (!state.gameDir) {
        title = '先设置游戏目录';
        desc = '点上方「选择游戏目录」或「自动定位」,然后扫描游戏包建立索引。';
      } else if (state.indexLoading && !state.index) {
        title = '正在读取音频索引…';
        desc = '正在确认索引是否已经建立。';
      } else if (building) {
        title = '正在建立音频索引';
        desc = '扫描完成后,游戏包里的音频会出现在这里。';
      } else if (state.indexError && !state.index?.ready) {
        title = '索引还没有准备好';
        desc = state.indexError;
      } else if (!state.index?.ready) {
        title = '还没有音频索引';
        desc = '点击上方「扫描游戏包」建立索引,首次约需 20–60 秒。';
        action = state.gameDir ? 'scan' : '';
      } else if (state.query) {
        title = '没有匹配「' + state.query + '」的音频';
        desc = '换个关键词试试,或清空搜索查看全部音频。';
        action = 'clear';
      } else {
        title = '索引里还没有音频';
        desc = '游戏包中可能没有音频资源,或索引需要重新扫描。';
        action = 'scan';
      }
      emptyActionKind = action;
      ui.emptyTitle.textContent = title;
      ui.emptyDesc.textContent = desc;
      ui.emptyAction.hidden = !action;
      ui.emptyAction.textContent = action === 'scan' ? '扫描游戏包' : action === 'clear' ? '清空搜索' : '';
      ui.emptyAction.disabled = action === 'scan'
        && (state.building || state.indexLoading || !state.gameDir || !!state.dirBusy);
    }

    const showMore = ready && !showAlert && state.loaded && state.total > 0;
    ui.more.hidden = !showMore;
    if (showMore) {
      const hasMore = state.items.length < state.total;
      ui.moreBtn.hidden = !hasMore;
      ui.moreBtn.disabled = state.listLoading || state.searchPending;
      ui.moreBtn.textContent = state.listLoading ? '加载中…' : '加载更多';
      ui.moreNote.textContent = state.listLoading
        ? '正在加载更多…'
        : hasMore
          ? '已加载 ' + state.items.length + ' / ' + state.total + ' 条'
          : '已加载全部 ' + state.total + ' 条';
    }
  }

  function updateRowState(item: AudioItem): void {
    const row = rows.get(item.id);
    if (!row) return;
    const previewBtn = row.querySelector<HTMLButtonElement>('[data-act="preview"]');
    const exportBtn = row.querySelector<HTMLButtonElement>('[data-act="export"]');
    const isPreview = state.previewId === item.id;
    const isLoading = state.previewLoadingId === item.id;
    const isExporting = state.exporting.has(item.id);
    const bulkActive = !!state.bulk?.active;
    row.classList.toggle('is-previewing', isPreview);
    row.classList.toggle('is-preview-loading', isLoading);
    if (previewBtn) {
      previewBtn.textContent = isLoading ? '取消' : isPreview ? '停止' : '试听';
      previewBtn.setAttribute('aria-pressed', isPreview ? 'true' : 'false');
      previewBtn.title = isPreview ? '停止试听' : '试听这段音频';
    }
    if (exportBtn) {
      exportBtn.textContent = isExporting ? '导出中…' : '导出';
      exportBtn.disabled = isExporting || bulkActive;
    }
  }

  function updateAllRows(): void {
    for (const item of state.items) updateRowState(item);
  }

  function createRow(item: AudioItem): HTMLElement {
    const codec = codecInfo(item.codec);
    const pak = item.pak ? basename(item.pak) || item.pak : '';
    const size = formatSize(item.size);
    const rate = formatRate(item.rate);
    const channels = typeof item.channels === 'number' && item.channels > 0 ? item.channels + ' 声道' : '';
    const codecTitle = [rate, channels].filter(Boolean).join(' · ');
    const listItem = document.createElement('li');
    listItem.className = 'audio-row';
    listItem.dataset.id = item.id;
    listItem.innerHTML = [
      '<div class="audio-row-main">',
      '  <div class="audio-row-title">',
      '    <span class="audio-row-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span>',
      '    <span class="audio-codec" data-codec="' + escapeHtml(codec.key) + '"'
        + (codecTitle ? ' title="' + escapeHtml(codecTitle) + '"' : '') + '>' + escapeHtml(codec.label) + '</span>',
      '    <span class="audio-row-duration" title="' + escapeHtml(exactSeconds(item.duration)) + '">'
        + escapeHtml(formatDuration(item.duration)) + '</span>',
      '  </div>',
      '  <div class="audio-row-sub">',
      '    <span class="audio-row-vpath" title="' + escapeHtml(item.vpath) + '">'
        + escapeHtml(item.vpath || item.name) + '</span>',
      '  </div>',
      '</div>',
      '<div class="audio-row-meta">',
      pak ? '<span class="audio-pak" title="' + escapeHtml(item.pak) + '">' + escapeHtml(pak) + '</span>' : '',
      '<span class="audio-size" title="大小 ' + escapeHtml(size) + '">' + escapeHtml(size) + '</span>',
      '</div>',
      '<div class="audio-row-actions">',
      '  <button type="button" class="audio-btn audio-btn-sm" data-act="preview" data-df-native title="试听这段音频">试听</button>',
      '  <button type="button" class="audio-btn audio-btn-sm" data-act="export" data-df-native title="导出为 WAV">导出</button>',
      '</div>',
    ].join('');
    return listItem;
  }

  function appendRows(items: AudioItem[]): void {
    if (items.length === 0) return;
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      if (rows.has(item.id)) continue;
      const row = createRow(item);
      rows.set(item.id, row);
      fragment.appendChild(row);
    }
    ui.list.appendChild(fragment);
    for (const item of items) updateRowState(item);
  }

  function showToast(message: string, kind: 'ok' | 'error' | 'info' = 'ok'): void {
    if (disposed) return;
    const text = String(message || '').trim();
    if (!text) return;
    ui.toast.textContent = text;
    ui.toast.dataset.kind = kind;
    ui.toast.hidden = false;
    ui.toast.classList.remove('is-in');
    void ui.toast.offsetWidth;
    ui.toast.classList.add('is-in');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastTimer = 0;
      if (disposed) return;
      ui.toast.hidden = true;
      ui.toast.classList.remove('is-in');
    }, TOAST_MS);
  }

  /* -------------------------------------------------------------------------
   * 4.3 游戏目录
   * ----------------------------------------------------------------------- */

  async function loadGameDir(): Promise<void> {
    const result = await callBridge<GameDirState>('getGameDir', '读取游戏目录');
    if (disposed) return;
    state.gameDirKnown = true;
    if (!result.ok) {
      state.gameDir = '';
      state.dirNote = result.error;
      paintDir();
      return;
    }
    const dir = result.value && typeof result.value.dir === 'string' ? result.value.dir.trim() : '';
    state.gameDir = dir;
    if (!dir) state.dirNote = '还没有设置游戏目录';
    else if (result.value && result.value.valid === false) state.dirNote = '这个目录当前不可用,可能已被移动或删除';
    else state.dirNote = '';
    paintDir();
  }

  function cancelText(message: string): boolean {
    return /取消|cancel/i.test(message);
  }

  async function commitGameDir(dir: string, info: { source?: string; from: 'pick' | 'detect' }): Promise<void> {
    const clean = String(dir || '').trim();
    if (!clean) {
      showToast('没有拿到有效的游戏目录', 'error');
      return;
    }
    state.dirBusy = 'set';
    state.dirNote = '正在校验游戏目录…';
    paintDir();
    const result = await callBridge<GameDirSet>('setGameDir', '设置游戏目录', [clean]);
    if (disposed) return;
    state.dirBusy = '';
    if (!result.ok) {
      state.dirNote = result.error;
      paintDir();
      showToast(result.error, 'error');
      return;
    }
    const value = result.value;
    if (!value || !value.ok || !value.valid) {
      const message = value && typeof value.error === 'string' && value.error
        ? value.error
        : '目录校验未通过';
      state.dirNote = message;
      paintDir();
      showToast('游戏目录不可用:' + message, 'error');
      return;
    }
    state.gameDir = clean;
    state.gameDirKnown = true;
    const pakCount = finiteNumber(value.pakCount);
    const pieces: string[] = [];
    pieces.push(pakCount !== undefined ? '检测到 ' + pakCount + ' 个游戏包' : '目录已设置');
    if (info.source) pieces.push('来源:' + info.source);
    state.dirNote = pieces.join(' · ');
    paintDir();
    showToast('已设置游戏目录' + (pakCount !== undefined ? '(' + pakCount + ' 个 pak)' : ''), 'ok');
    clearList();
    await loadIndexState({ search: true });
  }

  async function chooseGameDir(): Promise<void> {
    if (state.dirBusy) return;
    state.dirBusy = 'pick';
    state.dirNote = '正在打开目录选择…';
    paintDir();
    const result = await callBridge<GameDirPick>('pickGameDir', '选择游戏目录');
    if (disposed) return;
    if (!result.ok) {
      state.dirBusy = '';
      state.dirNote = result.error;
      paintDir();
      showToast(result.error, 'error');
      return;
    }
    const value = result.value;
    if (!value || !value.ok || typeof value.dir !== 'string' || !value.dir.trim()) {
      state.dirBusy = '';
      const message = value && typeof value.error === 'string' && value.error ? value.error : '已取消选择';
      state.dirNote = cancelText(message) ? '已取消选择' : message;
      paintDir();
      if (!cancelText(message)) showToast('选择游戏目录失败:' + message, 'error');
      return;
    }
    state.dirBusy = '';
    await commitGameDir(value.dir, { from: 'pick' });
  }

  async function autoDetectDir(): Promise<void> {
    if (state.dirBusy) return;
    state.dirBusy = 'detect';
    state.dirNote = '正在自动定位游戏目录…';
    paintDir();
    const result = await callBridge<GameDirDetect>('detectGameDir', '自动定位游戏目录');
    if (disposed) return;
    state.dirBusy = '';
    if (!result.ok) {
      state.dirNote = result.error;
      paintDir();
      showToast(result.error, 'error');
      return;
    }
    const value = result.value;
    if (!value || !value.ok || typeof value.dir !== 'string' || !value.dir.trim()) {
      const message = value && typeof value.error === 'string' && value.error ? value.error : '没有找到游戏目录';
      state.dirNote = message;
      paintDir();
      showToast('自动定位失败:' + message, 'error');
      return;
    }
    await commitGameDir(value.dir, { from: 'detect', source: value.source });
  }

  /* -------------------------------------------------------------------------
   * 4.4 索引状态与构建
   * ----------------------------------------------------------------------- */

  /* 页面可能在主进程已经开始扫描之后才被挂载 / 重新挂载(例如用户切走再回来)。
   * 这时拿到的 getIndexState 会是 building:true,但没有 buildIndex 的 Promise 可等,
   * 所以隔一小段时间重新读一次状态,直到 building 归零,避免整页停在"正在扫描"。
   * 只做轻量的 IPC 轮询,不重复开扫描;上限约 5 分钟,超时后交给手动刷新。 */
  function cancelIndexRecheck(): void {
    if (indexRecheckTimer) {
      window.clearTimeout(indexRecheckTimer);
      indexRecheckTimer = 0;
    }
    indexRecheckCount = 0;
  }

  function scheduleIndexRecheck(): void {
    if (disposed || indexRecheckTimer) return;
    if (indexRecheckCount >= 200) return;
    indexRecheckTimer = window.setTimeout(() => {
      indexRecheckTimer = 0;
      if (disposed) return;
      indexRecheckCount += 1;
      if (state.building) {
        scheduleIndexRecheck();
        return;
      }
      if (state.index?.building) {
        void loadIndexState({ search: true });
      } else {
        indexRecheckCount = 0;
      }
    }, 1600);
  }

  async function loadIndexState(options: { search: boolean }): Promise<void> {
    const seq = ++indexSeq;
    if (!state.gameDir) {
      cancelIndexRecheck();
      state.index = null;
      state.indexError = '';
      state.indexLoading = false;
      state.building = false;
      state.progress = null;
      clearList();
      paintIndex();
      return;
    }

    state.indexLoading = true;
    state.indexError = '';
    paintIndex();
    paintToolbar();

    const result = await callBridge<IndexState>('getIndexState', '读取索引状态');
    if (disposed || seq !== indexSeq) return;
    state.indexLoading = false;
    if (!result.ok) {
      state.indexError = result.error;
      if (state.index?.building) scheduleIndexRecheck();
      else cancelIndexRecheck();
      paintIndex();
      paintToolbar();
      paintList();
      paintFooter();
      return;
    }

    state.index = normalizeIndex(result.value);
    if (state.index.ready) void loadCategories();
    if (state.index.building) scheduleIndexRecheck();
    else cancelIndexRecheck();
    paintIndex();
    paintToolbar();

    if (state.index.building) {
      /* 后台还在重建:有旧索引就继续用旧列表(可搜索),没有就显示"正在建立"。
       * 这里不能反复 runSearch —— 轮询每 1.6s 一次,重画列表会把正在试听 / 正在
       * 滚动的位置反复清掉。 */
      if (!state.index.ready) {
        clearList();
        paintIndex();
        paintList();
        paintToolbar();
      } else {
        paintList();
        paintFooter();
      }
    } else if (state.index.ready) {
      if (options.search) await runSearch(true);
      else {
        paintList();
        paintFooter();
      }
    } else {
      clearList();
      paintIndex();
      paintList();
      paintToolbar();
    }
  }

  async function buildIndex(): Promise<void> {
    if (state.building) return;
    if (!state.gameDir) {
      showToast('请先选择游戏目录', 'error');
      return;
    }
    if (state.indexLoading) return;
    cancelIndexRecheck();
    state.building = true;
    state.indexError = '';
    state.progress = { phase: '准备扫描', done: 0, total: 0 };
    paintIndex();
    paintToolbar();

    const result = await callBridge<{ ok: boolean; count?: number; error?: string }>('buildIndex', '扫描游戏包');
    if (disposed) return;
    state.building = false;
    if (!result.ok) {
      state.progress = null;
      state.indexError = result.error;
      paintIndex();
      paintToolbar();
      showToast('扫描失败:' + result.error, 'error');
      return;
    }
    const value = result.value;
    if (!value || !value.ok) {
      state.progress = null;
      const message = value && typeof value.error === 'string' && value.error ? value.error : '未知原因';
      state.indexError = message;
      paintIndex();
      paintToolbar();
      showToast('扫描失败:' + message, 'error');
      return;
    }
    state.progress = null;
    const count = finiteNumber(value.count);
    showToast('扫描完成:索引到 ' + (count !== undefined ? count : 0) + ' 条音频', 'ok');
    await loadIndexState({ search: true });
  }

  /* -------------------------------------------------------------------------
   * 4.5 音频检索与分页
   * ----------------------------------------------------------------------- */

  function clearList(): void {
    state.searchSeq += 1;
    if (searchTimer) { window.clearTimeout(searchTimer); searchTimer = 0; }
    state.items = [];
    byId.clear();
    rows.clear();
    state.total = 0;
    state.loaded = false;
    state.listLoading = false;
    state.listError = '';
    state.query = '';
    state.category = 'all';
    state.categories = [];
    state.searchPending = false;
    if (ui.search.value) ui.search.value = '';
    ui.list.replaceChildren();
    stopPreview();
    paintToolbar();
    paintList();
    paintFooter();
  }

  async function runSearch(reset: boolean): Promise<void> {
    if (!canSearch()) {
      paintToolbar();
      paintList();
      return;
    }
    if (!reset && state.listLoading) return;
    const query = state.query;
    const seq = ++state.searchSeq;
    const offset = reset ? 0 : state.items.length;

    if (reset) {
      state.items = [];
      byId.clear();
      rows.clear();
      ui.list.replaceChildren();
      state.total = 0;
      state.loaded = false;
      state.listError = '';
      stopPreview();
    }
    state.listLoading = true;
    state.searchPending = false;
    paintToolbar();
    paintList();
    paintFooter();

    const result = await callBridge<SearchResult>('searchAudio', '检索音频', [
      { query: query || undefined, category: state.category !== 'all' ? state.category : undefined, offset, limit: PAGE_SIZE },
    ]);
    if (disposed || seq !== state.searchSeq) return;
    state.listLoading = false;

    if (!result.ok) {
      state.listError = result.error;
      state.loaded = true;
      paintToolbar();
      paintList();
      paintFooter();
      return;
    }

    const record = result.value && typeof result.value === 'object'
      ? result.value as unknown as Record<string, unknown>
      : {};
    const rawItems = Array.isArray(record.items) ? record.items : [];
    const start = state.items.length;
    for (const raw of rawItems) {
      const item = normalizeAudioItem(raw);
      if (!item || byId.has(item.id)) continue;
      state.items.push(item);
      byId.set(item.id, item);
    }
    const totalValue = finiteNumber(record.total);
    state.total = Math.max(0, Math.floor(totalValue ?? state.items.length));
    if (state.total < state.items.length) state.total = state.items.length;
    state.loaded = true;
    appendRows(state.items.slice(start));
    paintToolbar();
    paintList();
    paintFooter();
  }

  function loadMore(): void {
    if (!canSearch() || state.listLoading || state.searchPending) return;
    if (state.items.length >= state.total) return;
    void runSearch(false);
  }

  function retrySearch(): void {
    state.listError = '';
    void runSearch(true);
  }

  function clearSearch(): void {
    if (searchTimer) { window.clearTimeout(searchTimer); searchTimer = 0; }
    ui.search.value = '';
    state.query = '';
    state.searchPending = false;
    ui.searchClear.hidden = true;
    if (canSearch()) void runSearch(true);
    else {
      paintToolbar();
      paintList();
      paintFooter();
    }
    ui.search.focus();
  }

  function scheduleSearch(immediate: boolean): void {
    if (searchTimer) { window.clearTimeout(searchTimer); searchTimer = 0; }
    state.query = ui.search.value.trim();
    ui.searchClear.hidden = !ui.search.value;
    if (!canSearch()) {
      paintToolbar();
      return;
    }
    if (immediate) {
      state.searchPending = false;
      void runSearch(true);
      return;
    }
    state.searchPending = true;
    paintToolbar();
    searchTimer = window.setTimeout(() => {
      searchTimer = 0;
      state.searchPending = false;
      void runSearch(true);
    }, SEARCH_DEBOUNCE);
  }

  /* -------------------------------------------------------------------------
   * 4.6 试听
   * ----------------------------------------------------------------------- */

  function stopPreview(): void {
    state.previewSeq += 1;
    const previousId = state.previewId;
    const loadingId = state.previewLoadingId;
    state.previewLoadingId = '';
    state.previewId = '';
    state.previewEnded = false;
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = '';
    }
    try {
      ui.audio.pause();
      ui.audio.removeAttribute('src');
      ui.audio.load();
    } catch {
      /* 个别 WebView 清空 src 会抛,不影响页面其余部分 */
    }
    paintPlayer();
    if (previousId) {
      const item = byId.get(previousId);
      if (item) updateRowState(item);
    }
    if (loadingId && loadingId !== previousId) {
      const item = byId.get(loadingId);
      if (item) updateRowState(item);
    }
  }

  async function startPreview(item: AudioItem): Promise<void> {
    if (!canSearch()) {
      showToast('索引尚未就绪,暂时不能试听', 'error');
      return;
    }
    if (state.previewLoadingId === item.id || state.previewId === item.id) {
      stopPreview();
      return;
    }
    stopPreview();
    const seq = ++state.previewSeq;
    state.previewLoadingId = item.id;
    state.previewEnded = false;
    updateRowState(item);

    const result = await callBridge<PreviewResult>('previewAudio', '读取试听数据', [item.id]);
    if (disposed || seq !== state.previewSeq) return;
    state.previewLoadingId = '';
    if (!result.ok) {
      updateRowState(item);
      showToast(result.error, 'error');
      return;
    }
    const value = result.value;
    if (!value || !value.ok) {
      updateRowState(item);
      showToast('试听失败:' + (value && value.error ? value.error : '没有返回音频数据'), 'error');
      return;
    }
    const bytes = value.data ? toBytes(value.data) : null;
    if (!bytes || bytes.byteLength === 0) {
      updateRowState(item);
      showToast('试听失败:音频数据为空', 'error');
      return;
    }

    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    const blob = new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });
    state.previewUrl = URL.createObjectURL(blob);
    state.previewId = item.id;
    state.previewEnded = false;
    ui.audio.src = state.previewUrl;
    ui.audio.load();
    paintPlayer();
    updateRowState(item);
    try {
      await ui.audio.play();
    } catch {
      if (disposed || seq !== state.previewSeq || state.previewId !== item.id) return;
      showToast('已载入音频,点播放按钮开始试听', 'info');
    }
  }

  function togglePreview(item: AudioItem): void {
    if (state.previewLoadingId === item.id || state.previewId === item.id) {
      stopPreview();
      return;
    }
    void startPreview(item);
  }

  /* -------------------------------------------------------------------------
   * 4.7 导出
   * ----------------------------------------------------------------------- */

  function applyExportDir(dir: unknown): void {
    if (typeof dir === 'string' && dir.trim()) {
      state.exportDir = dir.trim();
      state.exportDirKnown = true;
      paintFooter();
    }
  }

  async function refreshExportDir(): Promise<void> {
    const result = await callBridge<{ dir: string }>('getExportDir', '读取导出目录');
    if (disposed) return;
    state.exportDirKnown = true;
    if (result.ok && result.value && typeof result.value.dir === 'string') {
      state.exportDir = result.value.dir;
    }
    paintFooter();
  }

  async function changeExportDir(): Promise<void> {
    if (state.exportDirBusy || state.bulk?.active) return;
    state.exportDirBusy = true;
    paintFooter();
    const result = await callBridge<{ ok: boolean; dir?: string; error?: string }>('pickExportDir', '选择导出目录');
    if (disposed) return;
    state.exportDirBusy = false;
    if (!result.ok) {
      paintFooter();
      showToast(result.error, 'error');
      return;
    }
    const value = result.value;
    if (value && value.ok && typeof value.dir === 'string' && value.dir.trim()) {
      state.exportDir = value.dir.trim();
      state.exportDirKnown = true;
      paintFooter();
      showToast('导出目录已更新', 'ok');
      return;
    }
    paintFooter();
    const message = value && typeof value.error === 'string' && value.error ? value.error : '已取消选择';
    if (!cancelText(message)) showToast('选择导出目录失败:' + message, 'error');
  }

  async function exportOne(item: AudioItem): Promise<void> {
    if (state.exporting.has(item.id)) return;
    if (state.bulk?.active) {
      showToast('批量导出进行中,请稍候', 'info');
      return;
    }
    if (!canSearch()) {
      showToast('索引尚未就绪,暂时不能导出', 'error');
      return;
    }
    state.exporting.add(item.id);
    updateRowState(item);
    paintToolbar();
    const result = await callBridge<ExportResult>('exportAudio', '导出音频', [
      { ids: [item.id], decode: true },
    ]);
    if (disposed) return;
    state.exporting.delete(item.id);
    updateRowState(item);
    paintToolbar();
    if (!result.ok) {
      showToast(result.error, 'error');
      return;
    }
    const value = result.value;
    applyExportDir(value && value.outDir);
    const saved = Math.max(0, Math.floor(finiteNumber(value?.saved) ?? 0));
    const failed = Math.max(0, Math.floor(finiteNumber(value?.failed) ?? 0));
    if (value && value.ok && saved > 0) {
      showToast('已导出「' + item.name + '」' + (value.outDir ? ' 到 ' + value.outDir : ''), 'ok');
    } else {
      showToast('导出失败:' + (value && value.error
        ? value.error
        : failed > 0 ? '有 ' + failed + ' 条文件导出失败' : '未知原因'), 'error');
    }
  }

  async function collectFilteredIds(query: string, expectedTotal: number): Promise<string[]> {
    if (state.items.length >= expectedTotal && state.items.length > 0) {
      return state.items.map((item) => item.id);
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let guard = 0;
    while (offset < expectedTotal) {
      if (disposed) break;
      guard += 1;
      if (guard > 1000) break;
      const result = await callBridge<SearchResult>('searchAudio', '读取筛选结果', [
        { query: query || undefined, category: state.category !== 'all' ? state.category : undefined, offset, limit: PAGE_SIZE },
      ]);
      if (!result.ok) throw new Error(result.error);
      const record = result.value && typeof result.value === 'object'
        ? result.value as unknown as Record<string, unknown>
        : {};
      const rawItems = Array.isArray(record.items) ? record.items : [];
      if (rawItems.length === 0) break;
      for (const raw of rawItems) {
        const item = normalizeAudioItem(raw);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        ids.push(item.id);
        if (ids.length >= MAX_COLLECT) break;
      }
      offset += rawItems.length;
      if (state.bulk) {
        state.bulk.done = Math.min(ids.length, expectedTotal);
        paintBulk();
      }
      if (rawItems.length < PAGE_SIZE) break;
      if (ids.length >= MAX_COLLECT) break;
    }
    return ids;
  }

  function finishBulk(fatal: string): void {
    const bulk = state.bulk;
    if (!bulk) return;
    bulk.active = false;
    bulk.kind = fatal || bulk.failed > 0 ? 'error' : 'ok';
    if (!fatal && bulk.total > 0) bulk.done = bulk.total;
    const dir = state.exportDir || '默认导出目录';
    bulk.note = fatal
      ? fatal + ' · 输出目录:' + dir
      : '输出目录:' + dir;
    paintBulk();
    paintToolbar();
    updateAllRows();
    const summary = '导出结束:成功 ' + bulk.saved + ' 条,失败 ' + bulk.failed + ' 条';
    showToast(summary + ' · ' + dir, bulk.kind === 'ok' ? 'ok' : 'error');
  }

  async function exportAllFiltered(): Promise<void> {
    if (state.bulk?.active) return;
    if (!canSearch()) {
      showToast('索引尚未就绪,暂时不能导出', 'error');
      return;
    }
    if (state.searchPending) {
      showToast('正在搜索,请稍候', 'info');
      return;
    }
    if (state.total <= 0) {
      showToast('当前筛选没有可导出的音频', 'error');
      return;
    }
    if (state.exporting.size > 0) {
      showToast('有单条导出正在进行,请稍候', 'info');
      return;
    }

    const query = state.query;
    const expectedTotal = state.total;
    state.bulk = {
      active: true,
      phase: 'collect',
      done: 0,
      total: expectedTotal,
      saved: 0,
      failed: 0,
      note: '',
      kind: 'info',
    };
    paintBulk();
    paintToolbar();
    updateAllRows();

    let fatal = '';
    try {
      const ids = await collectFilteredIds(query, expectedTotal);
      if (disposed) return;
      const bulk = state.bulk;
      if (!bulk) return;
      if (ids.length === 0) {
        finishBulk('没有找到可导出的音频');
        return;
      }
      bulk.total = ids.length;
      bulk.done = 0;
      bulk.phase = 'export';
      paintBulk();

      for (let i = 0; i < ids.length; i += EXPORT_BATCH) {
        if (disposed) return;
        const batch = ids.slice(i, i + EXPORT_BATCH);
        const result = await callBridge<ExportResult>('exportAudio', '导出音频', [
          { ids: batch, decode: true },
        ]);
        if (disposed) return;
        if (!result.ok) {
          bulk.failed += batch.length;
          bulk.done += batch.length;
          fatal = result.error;
          paintBulk();
          break;
        }
        const value = result.value;
        const failed = Math.max(0, Math.floor(finiteNumber(value?.failed) ?? 0));
        let saved = Math.max(0, Math.floor(finiteNumber(value?.saved) ?? 0));
        if (saved === 0 && failed === 0 && value && value.ok) saved = batch.length;
        bulk.saved += saved;
        bulk.failed += failed;
        bulk.done += batch.length;
        if (value && typeof value.outDir === 'string' && value.outDir) applyExportDir(value.outDir);
        if (value && typeof value.error === 'string' && value.error) fatal = value.error;
        if (value && !value.ok && saved === 0 && failed === 0) {
          bulk.failed += batch.length;
          fatal = value.error || '当前批次导出失败';
          paintBulk();
          break;
        }
        paintBulk();
        paintFooter();
      }
    } catch (error) {
      fatal = '导出失败:' + errText(error);
    }

    if (disposed) return;
    if (!state.exportDir) {
      await refreshExportDir();
      if (disposed) return;
    }
    finishBulk(fatal);
  }

  /* -------------------------------------------------------------------------
   * 4.8 事件绑定
   * ----------------------------------------------------------------------- */

  ui.dirPick.addEventListener('click', () => { void chooseGameDir(); });
  ui.dirChange.addEventListener('click', () => { void chooseGameDir(); });
  ui.dirDetect.addEventListener('click', () => { void autoDetectDir(); });
  ui.indexScan.addEventListener('click', () => { void buildIndex(); });

  /* 分类胶囊：单选，点已选中的那枚退回"全部"。 */
  ui.cats.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLElement>('.audio-chip');
    if (!btn || !ui.cats.contains(btn)) return;
    const next = btn.dataset.category || 'all';
    if (state.category === next) return;
    state.category = next;
    paintCats();
    if (canSearch()) void runSearch(true);
  });
  ui.indexRefresh.addEventListener('click', () => {
    void loadIndexState({ search: state.items.length === 0 });
  });
  ui.exportAll.addEventListener('click', () => { void exportAllFiltered(); });
  ui.alertRetry.addEventListener('click', retrySearch);
  ui.moreBtn.addEventListener('click', loadMore);
  ui.playerStop.addEventListener('click', stopPreview);
  ui.footDirBtn.addEventListener('click', () => { void changeExportDir(); });

  ui.emptyAction.addEventListener('click', () => {
    if (emptyActionKind === 'scan') void buildIndex();
    else if (emptyActionKind === 'clear') clearSearch();
  });

  ui.search.addEventListener('input', () => { scheduleSearch(false); });
  ui.search.addEventListener('search', () => {
    /* type=search 的原生"清除"只发 search 事件,不触发 input;不同步会留下
     * 一个看得见却点不动的清空按钮。原生清除等同于空关键词,立即检索。 */
    if (searchTimer) { window.clearTimeout(searchTimer); searchTimer = 0; }
    state.query = ui.search.value.trim();
    state.searchPending = false;
    ui.searchClear.hidden = !ui.search.value;
    if (canSearch()) void runSearch(true);
  });
  ui.search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      scheduleSearch(true);
    } else if (event.key === 'Escape' && ui.search.value) {
      event.stopPropagation();
      clearSearch();
    }
  });
  ui.searchClear.addEventListener('click', clearSearch);

  ui.list.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button[data-act]');
    if (!button || !ui.list.contains(button)) return;
    const row = button.closest<HTMLElement>('.audio-row');
    const id = row && row.dataset.id;
    if (!id) return;
    const item = byId.get(id);
    if (!item) return;
    if (button.dataset.act === 'preview') togglePreview(item);
    else if (button.dataset.act === 'export') void exportOne(item);
  });

  ui.audio.addEventListener('play', () => {
    if (!state.previewId) return;
    state.previewEnded = false;
    paintPlayer();
  });
  ui.audio.addEventListener('ended', () => {
    if (!state.previewId) return;
    state.previewEnded = true;
    paintPlayer();
  });
  ui.audio.addEventListener('error', () => {
    if (!state.previewId || disposed) return;
    showToast('音频播放失败:文件可能不是有效的 WAV', 'error');
  });

  /* 滚动到列表底部时自动加载下一页;没有 IntersectionObserver 的内核仍然有
   * 「加载更多」按钮可用。rootMargin 提前 240px 触发,避免用户真的滚到底才等。 */
  function setupAutoLoad(): void {
    if (typeof IntersectionObserver !== 'function') return;
    try {
      moreObserver = new IntersectionObserver((entries) => {
        if (disposed) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (state.items.length < state.total && !state.listLoading && !state.searchPending && !state.listError) {
            loadMore();
          }
        }
      }, { rootMargin: '240px 0px' });
      moreObserver.observe(ui.more);
    } catch {
      moreObserver = null;
    }
  }

  /* -------------------------------------------------------------------------
   * 4.9 启动:先画一版"读取中",再依次确认目录 / 导出目录 / 索引
   * ----------------------------------------------------------------------- */

  function boot(): void {
    paintDir();
    paintIndex();
    paintToolbar();
    paintList();
    paintPlayer();
    paintBulk();
    paintFooter();
    subscribeProgress();
    setupAutoLoad();
    void (async () => {
      await loadGameDir();
      if (disposed) return;
      paintDir();
      await Promise.all([
        loadExportDir(),
        loadIndexState({ search: true }),
      ]);
    })();
  }

  async function loadExportDir(): Promise<void> {
    const result = await callBridge<{ dir: string }>('getExportDir', '读取导出目录');
    if (disposed) return;
    state.exportDirKnown = true;
    if (result.ok && result.value && typeof result.value.dir === 'string') {
      state.exportDir = result.value.dir;
    }
    paintFooter();
  }

  boot();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (searchTimer) { window.clearTimeout(searchTimer); searchTimer = 0; }
      if (toastTimer) { window.clearTimeout(toastTimer); toastTimer = 0; }
      cancelIndexRecheck();
      if (progressUnsub) {
        try { progressUnsub(); } catch { /* 退订失败也要继续销毁 */ }
        progressUnsub = null;
      }
      if (moreObserver) {
        try { moreObserver.disconnect(); } catch { /* 忽略 */ }
        moreObserver = null;
      }
      stopPreview();
      ui.root.remove();
    },
  };
}
