/* ============================================================================
 * 日志(src/logs.ts)
 * ---------------------------------------------------------------------------
 * 应用里的"日志"只有一条主线:**采集 → 过滤 → 导出**,不做后端、不做上报。
 *
 * 采集(自动,不需要业务代码逐处埋点):
 *   · console.debug / log / info / warn / error —— 包装后原样转发,再记一条;
 *   · window 的 error / unhandledrejection —— 未捕获异常与未处理的 Promise 拒绝;
 *   · 状态栏 —— 由 main.ts 的 setStatus 转发(它本来就是"最近一次操作的结果");
 *   · 关键业务事件 —— main.ts / start-screen.ts 在载入、导出、更新等节点显式记一条。
 *
 * 落盘(仅桌面客户端):
 *   主进程(见 electron/logs.cjs)把同一份记录写成 JSONL:<userData>/logs/dfae.log,
 *   超过 2MB 轮转一代。页面启动时读回最近 1000 条,之后按 ~300ms 批量追加。
 *   网页版 / 手机端没有这条桥,日志只存在内存里(本次会话),UI 上会如实说明。
 *
 * 查看:
 *   · 类型单选(全部 / 信息 / 警告 / 错误 / 调试) + 关键词搜索;
 *   · 默认"跟随最新"(新日志出现自动滚到底);用户往上翻会自动暂停,
 *     翻回底部或点按钮恢复 —— 这是看日志时最省心的默认行为;
 *   · 列表最多渲染最近 500 行(内存里保留 2000 条),避免一次导出把 DOM 撑爆。
 *
 * 导出:
 *   · 复制 = 当前筛选结果写进剪贴板(优先 navigator.clipboard,桌面端兜底主进程);
 *   · 下载 = 桌面端弹"另存为",网页端 <a download>,手机端优先系统分享。
 *
 * 与 main.ts 的约定:本模块不 import 任何业务模块(避免循环依赖),只暴露 initLogs / logs;
 * 业务侧调用 logs.info('导出', '...') 即可,写入磁盘、渲染、徽标全部在内部完成。
 * 同页还有开发者日志视图(src/devlog.ts):它复用本模块的 console / 全局异常包装,
 * 采集原始流并渲染成终端;本文件只单向把事件转给它,不反向依赖它的 UI。
 * ========================================================================== */

/* 开发者日志(终端视图)的采集入口。logs.ts 单向依赖 devlog.ts:
 * 这里把 console / 全局异常的原始参数转给它;devlog 不反向 import 本文件,避免循环。 */
import { devCaptureConsole, devCaptureError, initDevLog } from './devlog';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  /** 唯一 id:跨"内存 + 磁盘历史"去重用(同一批记录可能既在内存里、又被读回来) */
  id: string;
  /** epoch 毫秒(与主进程日志同一时基,合并后按它排序) */
  t: number;
  level: LogLevel;
  /** 分类标签:应用 / 控制台 / 异常 / 状态 / 导出 / 更新 / 下载 / 主进程 … */
  tag: string;
  msg: string;
  /** 可选的多行细节(错误堆栈、环境信息),点"详情"展开 */
  detail?: string;
};

/** 主进程桥(见 electron/preload.cjs 的 window.dfaeLogs;网页版为 undefined)。 */
type LogsBridge = {
  isDesktop?: boolean;
  append?: (records: LogEntry[]) => Promise<{ ok?: boolean; written?: number; error?: string }>;
  read?: (opts?: { limit?: number }) => Promise<{ ok?: boolean; records?: unknown[]; dir?: string; file?: string; error?: string }>;
  clear?: () => Promise<{ ok?: boolean; error?: string }>;
  exportText?: (text: string, defaultName: string) => Promise<{ ok?: boolean; path?: string; canceled?: boolean; error?: string }>;
  reveal?: () => Promise<boolean>;
  copyText?: (text: string) => Promise<boolean>;
  info?: () => Promise<{ dir?: string; file?: string; size?: number }>;
};

const MAX_ENTRIES = 2000;
const MAX_ROWS = 500;
const HISTORY_LIMIT = 1000;
const FLUSH_MS = 300;
const HINT_MS = 4200;

const LEVEL_LABEL: Record<LogLevel, string> = { debug: '调试', info: '信息', warn: '警告', error: '错误' };
const LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const entries: LogEntry[] = [];
const seenIds = new Set<string>();
let entrySeq = 0;
let flushTimer = 0;
let renderQueued = false;
let hintTimer = 0;
let hintExitTimer = 0;
let booted = false;
let unseenErrors = 0;
let diskDir = '';
let diskFile = '';
let bridge: LogsBridge | null = null;
/** 清空一代:每次清空 +1,让清空前发起的磁盘读取知道自己的结果已过期。 */
let historyEpoch = 0;

type LevelFilter = 'all' | LogLevel;
let levelFilter: LevelFilter = 'all';
let searchQuery = '';
let followLatest = true;

/** 网页版 / 手机端的判定:mobile.ts 会在启动后写 data-ui,这里两路都认。 */
function isMobileLike(): boolean {
  try {
    if (document.documentElement.dataset.ui === 'mobile') return true;
    return !!(window as unknown as { __DFAE_MOBILE__?: boolean }).__DFAE_MOBILE__;
  } catch {
    return false;
  }
}

function isLogsPage(): boolean {
  return document.documentElement.dataset.page === 'logs';
}

function versionLabel(): string {
  try {
    /* __APP_VERSION__ 由 vite.config.ts 的 define 注入(见 src/vite-env.d.ts) */
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
  } catch {
    return '';
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e || '未知错误');
}

function clip(s: string, max: number): string {
  const text = String(s == null ? '' : s);
  /* 截断后的长度必须**不超过** max:主进程按同一套上限做白名单校验,
   * 多出那一个省略号(2001 > 2000)会让整条记录被丢掉,而且丢得无声无息。 */
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + '…' : text;
}

function makeId(): string {
  entrySeq += 1;
  return 'l-' + Date.now().toString(36) + '-' + entrySeq.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function normalizeLevel(value: unknown): LogLevel | null {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : null;
}

/** 磁盘读回 / 主进程写入的记录都要过一遍校验:日志页不该因为一条脏数据整页崩掉。 */
function normalizeEntry(raw: unknown): LogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const level = normalizeLevel(r.level);
  const msg = typeof r.msg === 'string' ? r.msg.trim() : '';
  if (!level || !msg) return null;
  const t = typeof r.t === 'number' && Number.isFinite(r.t) ? r.t : Date.now();
  const id = typeof r.id === 'string' && r.id ? r.id : 'h-' + t.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const tag = typeof r.tag === 'string' && r.tag.trim() ? clip(r.tag.trim(), 32) : '应用';
  const detail = typeof r.detail === 'string' && r.detail ? clip(r.detail, 20000) : undefined;
  return { id, t, level, tag, msg: clip(msg, 2000), ...(detail ? { detail } : {}) };
}

function trimMemory(): void {
  while (entries.length > MAX_ENTRIES) {
    const dropped = entries.shift();
    if (dropped) seenIds.delete(dropped.id);
  }
}

function getBridge(): LogsBridge | null {
  try {
    const b = (window as unknown as { dfaeLogs?: LogsBridge }).dfaeLogs;
    return b && typeof b === 'object' ? b : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * 写入入口:所有采集最终都汇到这里
 * ------------------------------------------------------------------------- */

type PushOptions = {
  /** 来自磁盘历史:只放进内存,不再写回文件、不点亮未读徽标 */
  fromHistory?: boolean;
  /** 这条记录是"用户已看到"的:即使日志页不在前台也不点亮徽标 */
  seen?: boolean;
};

function pushEntry(level: LogLevel, tag: string, msg: string, detail?: string, opts: PushOptions = {}): void {
  try {
    const text = clip(String(msg == null ? '' : msg).replace(/\s+/g, ' ').trim(), 2000);
    if (!text) return;
    const entry: LogEntry = {
      id: makeId(),
      t: Date.now(),
      level,
      tag: clip(tag || '应用', 32),
      msg: text,
      ...(detail ? { detail: clip(detail, 20000) } : {}),
    };
    entries.push(entry);
    seenIds.add(entry.id);
    trimMemory();

    if (!opts.fromHistory) enqueueDisk(entry);

    /* 只有"日志页在前台、用户日志也可见"时到的一行才配得上入场提示;
     * 在开发者视图 / 别的页面攒下的行,切回来时不能再整屏闪一遍。 */
    if (isLogsPage() && logsPaneVisible()) freshIds.add(entry.id);

    if (level === 'error' && !opts.fromHistory && !opts.seen && !isLogsPage()) {
      unseenErrors += 1;
      updateBadge();
    }
    if (isLogsPage()) scheduleRender();
  } catch {
    /* 日志模块自身绝不向业务抛错 */
  }
}

/* ---------------------------------------------------------------------------
 * 采集一:console 包装
 * ------------------------------------------------------------------------- */

let consoleCaptured = false;

/** 把任意 console 参数变成可读文本:Error 取 message,对象安全 stringify,DOM 之类返回简短描述。 */
function argToText(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (value instanceof Error) return value.message || value.name;
    if (typeof value === 'object') {
      const seen = new WeakSet<object>();
      const json = JSON.stringify(value, (_key, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v as object)) return '[循环引用]';
          seen.add(v as object);
        }
        if (typeof v === 'function') return '[函数 ' + ((v as () => void).name || '匿名') + ']';
        return v;
      });
      return json && json !== '{}' ? json : Object.prototype.toString.call(value);
    }
    return String(value);
  } catch {
    return '[无法序列化的值]';
  }
}

function captureConsole(): void {
  if (consoleCaptured) return;
  consoleCaptured = true;
  const methods = ['debug', 'log', 'info', 'warn', 'error'] as const;
  for (const name of methods) {
    const original = console[name].bind(console);
    const level: LogLevel = name === 'debug' ? 'debug' : name === 'warn' ? 'warn' : name === 'error' ? 'error' : 'info';
    console[name] = (...args: unknown[]) => {
      /* 先保持原行为(开发者工具里照旧打印),再落一条日志 */
      original(...args);
      try {
        /* 开发者日志要原始参数(对象 / 堆栈 / printf 占位符都得保留),
         * 所以在汇总成中文用户日志之前先交给 devlog;两次格式化互不影响。 */
        try { devCaptureConsole(name, args); } catch { /* 开发者日志失败不影响用户日志 */ }
        const text = args.map(argToText).join(' ').trim();
        if (!text) return;
        const errorArg = args.find((a): a is Error => a instanceof Error);
        pushEntry(level, '控制台', text, errorArg && errorArg.stack ? String(errorArg.stack) : undefined);
      } catch {
        /* 采集失败不影响控制台本身 */
      }
    };
  }
}

/* ---------------------------------------------------------------------------
 * 采集二:未捕获异常
 * ------------------------------------------------------------------------- */

let errorsCaptured = false;

function captureGlobalErrors(): void {
  if (errorsCaptured) return;
  errorsCaptured = true;
  window.addEventListener('error', (event) => {
    /* 资源加载失败也会走到这里(message 为空、target 是 img/script):
     * 它不是 JS 异常,当成错误记下来只会制造噪音,跳过。 */
    if (!event.message) return;
    const where = event.filename
      ? ' @ ' + event.filename + (event.lineno ? ':' + event.lineno + (event.colno ? ':' + event.colno : '') : '')
      : '';
    const err = event.error instanceof Error ? event.error : null;
    pushEntry('error', '异常', event.message + where, err && err.stack ? String(err.stack) : undefined);
    try {
      devCaptureError('window.error', event.message + where, err && err.stack ? String(err.stack) : undefined);
    } catch { /* 开发者日志失败不影响用户日志 */ }
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const text = reason instanceof Error ? reason.message : argToText(reason);
    pushEntry(
      'error',
      '异常',
      '未处理的 Promise 拒绝: ' + text,
      reason instanceof Error && reason.stack ? String(reason.stack) : undefined,
    );
    try {
      devCaptureError('unhandledrejection', text, reason instanceof Error && reason.stack ? String(reason.stack) : undefined);
    } catch { /* 开发者日志失败不影响用户日志 */ }
  });
}

/* ---------------------------------------------------------------------------
 * 落盘:批量、防抖、失败静默
 * ------------------------------------------------------------------------- */

const pendingDisk: LogEntry[] = [];
/* 主进程单次 append 上限 200 条(见 electron/logs.cjs 的 MAX_BATCH)。
 * 渲染层积压超过一帧时按 200 一批顺序发,不能一把梭 —— 超出部分会被主进程静默丢弃。 */
const DISK_BATCH = 200;

function enqueueDisk(entry: LogEntry): void {
  if (!bridge || typeof bridge.append !== 'function') return;
  pendingDisk.push(entry);
  if (pendingDisk.length > 400) pendingDisk.splice(0, pendingDisk.length - 400);
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    void flushDisk();
  }, FLUSH_MS);
}

async function flushDisk(): Promise<void> {
  if (!bridge || typeof bridge.append !== 'function') return;
  while (pendingDisk.length > 0) {
    const batch = pendingDisk.splice(0, DISK_BATCH);
    try {
      await bridge.append(batch);
    } catch {
      /* 磁盘写不进去(目录只读 / 主进程忙)时不影响页面:
       * 失败的那一批放弃,剩下的留在队列里等下一次触发,不做忙等重试。 */
      return;
    }
  }
}

/** 启动时把磁盘上的历史合并进内存:按 id 去重,按时间升序。 */
function mergeHistory(records: unknown[]): void {
  let added = 0;
  for (const raw of records) {
    const entry = normalizeEntry(raw);
    if (!entry || seenIds.has(entry.id)) continue;
    entries.push(entry);
    seenIds.add(entry.id);
    added += 1;
  }
  if (!added) return;
  entries.sort((a, b) => a.t - b.t);
  trimMemory();
  if (isLogsPage()) scheduleRender();
}

async function loadHistory(limit = HISTORY_LIMIT): Promise<void> {
  if (!bridge || typeof bridge.read !== 'function') return;
  /* 读历史是异步的,期间用户可能点了「清空」:用代数号把"清空之前发起的读"
   * 判为过期,否则刚清掉的记录会被这次读回重新塞进列表。 */
  const epoch = historyEpoch;
  try {
    const res = await bridge.read({ limit });
    if (epoch !== historyEpoch) return;
    if (res && typeof res.dir === 'string') diskDir = res.dir;
    if (res && typeof res.file === 'string') diskFile = res.file;
    if (res && res.ok && Array.isArray(res.records)) mergeHistory(res.records);
    paintBridgeState();
  } catch {
    /* 读不到历史:页面继续只用本次会话的日志 */
  }
}

async function refreshFromDisk(): Promise<void> {
  if (!bridge) {
    showHint('网页版没有磁盘日志;当前会话的记录仍在列表里');
    return;
  }
  if (typeof bridge.read !== 'function') return;
  showHint('正在重新读取日志文件…');
  const epoch = historyEpoch;
  try {
    const res = await bridge.read({ limit: HISTORY_LIMIT });
    if (epoch !== historyEpoch) return;
    if (res && typeof res.dir === 'string') diskDir = res.dir;
    if (res && typeof res.file === 'string') diskFile = res.file;
    const before = entries.length;
    if (res && res.ok && Array.isArray(res.records)) mergeHistory(res.records);
    paintBridgeState();
    showHint(entries.length > before ? '已从磁盘补回 ' + (entries.length - before) + ' 条日志' : '磁盘上没有更新的日志');
  } catch (e) {
    showHint('读取日志失败: ' + errText(e), 'error');
  }
}

/* ---------------------------------------------------------------------------
 * 时间 / 文本格式化
 * ------------------------------------------------------------------------- */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function formatClock(t: number): string {
  const d = new Date(t);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
}

function formatFull(t: number): string {
  const d = new Date(t);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
    + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
}

/** 文件名里的时间戳:20261104-221341 */
function fileStamp(t: number): string {
  const d = new Date(t);
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

/* ---------------------------------------------------------------------------
 * 列表渲染
 * ------------------------------------------------------------------------- */

type LogUi = {
  root: HTMLElement;
  /** 用户日志 pane:不可见时(开发者视图 / 不在日志页)不重建列表 */
  userPane: HTMLElement;
  state: HTMLElement | null;
  body: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  emptyText: HTMLElement | null;
  hint: HTMLElement;
  foot: HTMLElement | null;
  follow: HTMLButtonElement;
  search: HTMLInputElement;
  searchClear: HTMLButtonElement;
  refresh: HTMLButtonElement;
  copy: HTMLButtonElement;
  download: HTMLButtonElement;
  reveal: HTMLButtonElement;
  clear: HTMLButtonElement;
  chips: HTMLButtonElement[];
  counts: Record<'all' | LogLevel, HTMLElement | null>;
};

let ui: LogUi | null = null;

function $id<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function filteredEntries(): LogEntry[] {
  const q = searchQuery.trim().toLowerCase();
  return entries.filter((e) => {
    if (levelFilter !== 'all' && e.level !== levelFilter) return false;
    if (!q) return true;
    return (e.msg + ' ' + e.tag + ' ' + (e.detail || '')).toLowerCase().includes(q);
  });
}

function filterLabel(): string {
  const level = levelFilter === 'all' ? '全部类型' : LEVEL_LABEL[levelFilter] + '日志';
  const q = searchQuery.trim();
  return q ? level + ' · 关键词「' + q + '」' : level;
}

/**
 * 上一次真正画进 DOM 的筛选签名与条目 id(顺序 = DOM 顺序)。
 * 日志是"只往后长"的流:绝大多数帧只是尾巴多一两条,或头部因 500 行上限掉一条。
 * 整表 innerHTML 重画会把展开的「详情」 <details> 收起、把用户正在选中的文字清掉,
 * 还会让整列在每次 console 输出时重排 —— 所以只在筛选条件变了 / 历史合并排序了时重建,
 * 其余情况只补尾部、删头部,并补掉头部被删掉的高度,滚动位置不跳。
 */
let renderedSig = '';
const renderedIds: string[] = [];
/** 本次等待渲染期间"真的刚出现"的条目 id:只有它们播一次 300ms 新行底色 */
const freshIds = new Set<string>();

function filterSig(): string {
  return levelFilter + '\u0000' + searchQuery;
}

/** 用户日志 pane 是否打开。只看 hidden,不查 getClientRects:这个判断在每条日志的
 * 写入路径上,强制同步布局会让"一次 console 突发几百条"变成几百次重排。
 * 页面本身不在日志页时 isLogsPage() 已经把整条渲染路径挡住了。 */
function logsPaneVisible(): boolean {
  const pane = ui && ui.userPane;
  return !!pane && !pane.hidden;
}

function scheduleRender(): void {
  if (!ui || renderQueued || !isLogsPage() || !logsPaneVisible()) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function rowHtml(e: LogEntry, fresh: boolean): string {
  const detail = e.detail
    ? '<details class="log-detail"><summary>详情</summary><pre>' + escapeHtml(e.detail) + '</pre></details>'
    : '';
  return '<li class="log-row' + (fresh ? ' is-new' : '') + '" data-level="' + e.level + '">'
    + '<span class="log-meta">'
    + '<time class="log-time" datetime="' + new Date(e.t).toISOString() + '">' + formatClock(e.t) + '</time>'
    + '<span class="log-lvl">' + LEVEL_LABEL[e.level] + '</span>'
    + '<span class="log-tag" title="' + escapeHtml(e.tag) + '">' + escapeHtml(e.tag) + '</span>'
    + '</span>'
    + '<span class="log-main"><span class="log-msg">' + escapeHtml(e.msg) + '</span>' + detail + '</span>'
    + '</li>';
}

function rebuildRows(rows: LogEntry[]): void {
  if (!ui) return;
  ui.list.innerHTML = rows.map((e) => rowHtml(e, false)).join('');
  renderedIds.length = 0;
  for (const e of rows) renderedIds.push(e.id);
}

type RowPatch = { ok: boolean; removedHeight: number };

/** 把 rows 与 DOM 的差量补进去。返回 ok=false 表示这次差异不适合 patch(调用方整表重画)。 */
function patchRows(rows: LogEntry[]): RowPatch {
  if (!ui) return { ok: false, removedHeight: 0 };
  if (renderedIds.length === 0) return { ok: rows.length === 0, removedHeight: 0 };
  if (rows.length === 0) return { ok: false, removedHeight: 0 };
  const children = Array.prototype.slice.call(ui.list.children) as HTMLElement[];
  if (children.length !== renderedIds.length) return { ok: false, removedHeight: 0 };
  /* 日志只往后长,所以新窗口的第一行一定是旧窗口里的一行 —— 找到它相对旧窗口的偏移 k,
   * k 就是这一帧从头部掉出去的行数(到了 500 行上限以后每帧都会掉)。
   * 找不到 = 一帧里的新增超过了整个窗口,或者是合并了更早的历史 → 交给重建。
   * 注意不能拿"旧窗口的第一行"去找:掉行时它恰恰是第一个被挤出去的。 */
  let k = -1;
  for (let i = 0; i < renderedIds.length; i += 1) {
    if (renderedIds[i] === rows[0].id) { k = i; break; }
  }
  if (k < 0) return { ok: false, removedHeight: 0 };
  const keep = renderedIds.length - k;
  if (keep > rows.length) return { ok: false, removedHeight: 0 };
  for (let i = 0; i < keep; i += 1) {
    if (rows[i].id !== renderedIds[k + i]) return { ok: false, removedHeight: 0 };
  }
  /* 头部掉行时补偿滚动高度。不能把 offsetHeight 加起来:行之间还有 1px 的 flex gap,
   * 30 行就差 30px,正在读的位置会跳一下。用"第一个留下的行距列表顶的距离"量,
   * 它天然包含 gap,删完正好是 0。 */
  let removedHeight = 0;
  if (k > 0) {
    const listTop = ui.list.getBoundingClientRect().top;
    removedHeight = Math.max(0, children[k].getBoundingClientRect().top - listTop);
    for (let i = 0; i < k; i += 1) children[i].remove();
  }
  const tail = rows.slice(keep);
  if (tail.length) {
    ui.list.insertAdjacentHTML('beforeend', tail.map((e) => rowHtml(e, freshIds.has(e.id))).join(''));
  }
  renderedIds.length = 0;
  for (const e of rows) renderedIds.push(e.id);
  return { ok: true, removedHeight };
}

function render(): void {
  if (!ui) return;
  /* pane 不可见时不画:开发者视图开着的时候,每来一条 console 都去重画 500 行隐藏列表
   * 是纯浪费(实测一次 100 条的突发会把 500 行整表重画一遍)。切回用户日志时由
   * dfae:logmode 事件补一次,内容不会丢。 */
  if (!logsPaneVisible()) return;

  const list = filteredEntries();
  const counts: Record<'all' | LogLevel, number> = { all: entries.length, debug: 0, info: 0, warn: 0, error: 0 };
  for (const e of entries) counts[e.level] += 1;
  for (const level of ['all', ...LEVEL_ORDER] as const) {
    const el = ui.counts[level];
    if (el) el.textContent = String(counts[level]);
  }
  for (const chip of ui.chips) {
    const on = (chip.dataset.level || 'all') === levelFilter;
    chip.classList.toggle('is-active', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  const rows = list.slice(Math.max(0, list.length - MAX_ROWS));
  const body = ui.body;
  const previousTop = body.scrollTop;
  const sig = filterSig();
  let rebuilt = false;
  let removedHeight = 0;
  if (sig === renderedSig) {
    const patch = patchRows(rows);
    if (patch.ok) removedHeight = patch.removedHeight;
    else rebuilt = true;
  } else {
    rebuilt = true;
  }
  if (rebuilt) rebuildRows(rows);
  renderedSig = sig;
  freshIds.clear();

  const empty = rows.length === 0;
  ui.empty.hidden = !empty;
  if (empty && ui.emptyText) {
    ui.emptyText.textContent = entries.length === 0
      ? '还没有日志。应用的关键操作与错误会记录在这里。'
      : '当前筛选没有匹配的日志。换个类型或清空搜索再看看。';
  }

  if (followLatest) {
    body.scrollTop = body.scrollHeight;
  } else if (rebuilt) {
    body.scrollTop = previousTop;
  } else if (removedHeight > 0) {
    /* 头部掉行(500 行上限)时把内容留在原处,而不是让视口跟着上移 */
    body.scrollTop = Math.max(0, previousTop - removedHeight);
  }
  paintFoot(list.length, counts.all);
}

function paintFoot(matched: number, total: number): void {
  if (!ui || !ui.foot) return;
  const parts: string[] = [];
  parts.push('共 ' + total + ' 条');
  if (matched !== total) parts.push('匹配 ' + matched + ' 条');
  if (matched > MAX_ROWS) parts.push('列表显示最近 ' + MAX_ROWS + ' 条');
  parts.push(bridge ? (diskFile ? '文件:' + diskFile : '桌面版自动保存到本地日志文件') : '本次会话(关闭页面即清空)');
  ui.foot.textContent = parts.join(' · ');
  ui.foot.title = bridge
    ? (diskFile || (diskDir ? diskDir : '日志保存位置由桌面客户端管理'))
    : '网页版与手机端没有磁盘日志;需要保留请用「复制」或「下载」';
}

function paintBridgeState(): void {
  if (!ui) return;
  const desktop = !!bridge;
  if (ui.state) {
    ui.state.textContent = desktop ? '自动保存' : '本次会话';
    ui.state.title = desktop
      ? (diskFile ? '日志写入:' + diskFile : '日志会写入桌面客户端的用户数据目录')
      : '网页版与手机端的日志只保存在当前页面,关闭后清空';
  }
  ui.reveal.hidden = !(desktop && typeof bridge?.reveal === 'function');
  paintFoot(filteredEntries().length, entries.length);
}

function updateBadge(): void {
  const nav = document.getElementById('navLogs');
  if (!nav) return;
  nav.classList.toggle('has-error', unseenErrors > 0);
  nav.dataset.unseen = String(unseenErrors);
  nav.title = unseenErrors > 0 ? '日志(' + unseenErrors + ' 个新错误)' : '日志';
}

function markLogsSeen(): void {
  if (unseenErrors === 0) return;
  unseenErrors = 0;
  updateBadge();
}

/** 收起结果条:先播 120ms 退场,再真正 hidden(比动画多留一帧,避免提前收起时闪一下)。 */
function hideHint(): void {
  if (!ui) return;
  if (hintTimer) { window.clearTimeout(hintTimer); hintTimer = 0; }
  if (hintExitTimer) { window.clearTimeout(hintExitTimer); hintExitTimer = 0; }
  const el = ui.hint;
  if (el.hidden) return;
  el.classList.remove('is-in');
  el.classList.add('is-leaving');
  hintExitTimer = window.setTimeout(() => {
    hintExitTimer = 0;
    if (!ui) return;
    ui.hint.hidden = true;
    ui.hint.classList.remove('is-leaving');
  }, 140);
}

function showHint(message: string, kind: 'ok' | 'error' = 'ok'): void {
  if (!ui) return;
  if (hintTimer) { window.clearTimeout(hintTimer); hintTimer = 0; }
  if (hintExitTimer) { window.clearTimeout(hintExitTimer); hintExitTimer = 0; }
  const el = ui.hint;
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.remove('is-leaving');
  el.hidden = false;
  /* 重播入场:先摘类并强制回流,否则同一条提示连续出现两次时第二遍没有动画 */
  el.classList.remove('is-in');
  void el.offsetWidth;
  el.classList.add('is-in');
  hintTimer = window.setTimeout(() => {
    hintTimer = 0;
    hideHint();
  }, HINT_MS);
}

function setFollow(on: boolean): void {
  followLatest = on;
  if (!ui) return;
  ui.follow.setAttribute('aria-pressed', on ? 'true' : 'false');
  ui.follow.title = on ? '新日志出现时自动滚动到最新一条(点一下暂停)' : '已暂停跟随;点一下恢复并滚到最新';
  if (on) ui.body.scrollTop = ui.body.scrollHeight;
}

/* ---------------------------------------------------------------------------
 * 导出文本 / 剪贴板 / 下载
 * ------------------------------------------------------------------------- */

function buildExportText(list: LogEntry[]): string {
  const head = [
    '三角洲行动动画编辑器 · 日志导出',
    '导出时间: ' + formatFull(Date.now()),
    '筛选: ' + filterLabel() + ' · 共 ' + list.length + ' 条',
  ];
  if (diskFile) head.push('日志文件: ' + diskFile);
  head.push('应用版本: v' + (versionLabel() || '未知') + ' · 平台: ' + (bridge ? (isMobileLike() ? '手机客户端' : '桌面客户端') : '网页版'));
  head.push('----------------------------------------------------------------------');
  const lines: string[] = [];
  for (const e of list) {
    lines.push('[' + formatFull(e.t) + '] [' + LEVEL_LABEL[e.level] + '] [' + e.tag + '] ' + e.msg);
    if (e.detail) {
      for (const line of e.detail.split(/\r?\n/)) lines.push('    ' + line);
    }
  }
  return head.join('\n') + (lines.length ? '\n' + lines.join('\n') + '\n' : '\n');
}

type ShareCapableNavigator = Navigator & {
  canShare?: (data: { files?: File[]; title?: string; text?: string }) => boolean;
  share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
};

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 没有权限 / 非安全上下文:继续走兜底 */
  }
  if (bridge && typeof bridge.copyText === 'function') {
    try {
      if (await bridge.copyText(text)) return true;
    } catch {
      /* 继续走 textarea */
    }
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function triggerDownload(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function copyCurrent(): Promise<void> {
  const list = filteredEntries();
  if (list.length === 0) {
    showHint('当前筛选没有可复制的日志', 'error');
    return;
  }
  const text = buildExportText(list);
  const ok = await writeClipboard(text);
  if (ok) showHint('已复制 ' + list.length + ' 条日志到剪贴板');
  else showHint('复制失败:剪贴板不可用,请改用「下载」', 'error');
}

async function downloadCurrent(): Promise<void> {
  const list = filteredEntries();
  if (list.length === 0) {
    showHint('当前筛选没有可下载的日志', 'error');
    return;
  }
  const text = buildExportText(list);
  const filename = 'dfae-logs-' + fileStamp(Date.now()) + '.log';

  if (bridge && typeof bridge.exportText === 'function') {
    showHint('正在准备日志文件…');
    try {
      const res = await bridge.exportText(text, filename);
      if (res && res.canceled) showHint('已取消保存');
      else if (res && res.ok && res.path) showHint('已保存到 ' + res.path);
      else showHint('保存失败: ' + ((res && res.error) || '未知原因'), 'error');
    } catch (e) {
      showHint('保存失败: ' + errText(e), 'error');
    }
    return;
  }

  /* 手机端优先系统分享:文件可以落到"文件 / 网盘 / 相册",比浏览器下载可靠。
   * 桌面网页仍然走 <a download>(会自动进系统下载目录)。 */
  if (isMobileLike()) {
    try {
      const nav = navigator as ShareCapableNavigator;
      const file = new File([text], filename, { type: 'text/plain' });
      if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: filename, text: '三角洲行动动画编辑器 · 日志' });
        showHint('已交给系统分享');
        return;
      }
    } catch {
      /* 用户取消分享 / 不支持文件分享:退回普通下载 */
    }
  }
  triggerDownload(text, filename);
  showHint('已开始下载 ' + filename);
}

/* 「清空」是这一页唯一的破坏性动作。原来的 window.confirm 会把用户从应用的视觉语言里
 * 拽到一个系统对话框;现在改成按钮就地二段确认(再点一次才清),3.2s 没跟上自动复位。
 * 既保留了"不能撤销"的阻力,又不弹窗、不丢上下文。 */
let clearArmed = false;
let clearArmTimer = 0;
function disarmClear(): void {
  clearArmed = false;
  window.clearTimeout(clearArmTimer);
  const btn = $id<HTMLButtonElement>('logsClear');
  if (!btn) return;
  btn.textContent = '清空';
  btn.classList.remove('is-armed');
  btn.removeAttribute('aria-label');
}

async function clearAll(): Promise<void> {
  disarmClear();
  if (entries.length === 0) {
    showHint('还没有日志,不需要清空');
    return;
  }
  historyEpoch += 1;
  entries.length = 0;
  seenIds.clear();
  pendingDisk.length = 0;
  unseenErrors = 0;
  updateBadge();
  let diskCleared = true;
  if (bridge && typeof bridge.clear === 'function') {
    try {
      const res = await bridge.clear();
      diskCleared = !!res && res.ok !== false;
    } catch {
      diskCleared = false;
    }
  }
  render();
  showHint(diskCleared ? '日志已清空' : '内存中的日志已清空,但磁盘文件删除失败;可到日志文件夹手动删除', diskCleared ? 'ok' : 'error');
}

/* ---------------------------------------------------------------------------
 * 事件绑定
 * ------------------------------------------------------------------------- */

function bindUi(): void {
  const root = $id<HTMLElement>('viewLogs');
  if (!root) return;
  const userPane = $id<HTMLElement>('logsUserPane');
  const list = $id<HTMLElement>('logsList');
  const body = $id<HTMLElement>('logsBody');
  const empty = $id<HTMLElement>('logsEmpty');
  const hint = $id<HTMLElement>('logsHint');
  const follow = $id<HTMLButtonElement>('logsFollow');
  const search = $id<HTMLInputElement>('logsSearch');
  const searchClear = $id<HTMLButtonElement>('logsSearchClear');
  const refresh = $id<HTMLButtonElement>('logsRefresh');
  const copy = $id<HTMLButtonElement>('logsCopy');
  const download = $id<HTMLButtonElement>('logsDownload');
  const reveal = $id<HTMLButtonElement>('logsReveal');
  const clear = $id<HTMLButtonElement>('logsClear');
  if (!userPane || !list || !body || !empty || !hint || !follow || !search || !searchClear || !refresh || !copy || !download || !reveal || !clear) {
    return;
  }

  ui = {
    root,
    userPane,
    state: $id<HTMLElement>('logsState'),
    body,
    list,
    empty,
    emptyText: $id<HTMLElement>('logsEmptyText'),
    hint,
    foot: $id<HTMLElement>('logsFoot'),
    follow,
    search,
    searchClear,
    refresh,
    copy,
    download,
    reveal,
    clear,
    chips: Array.from(root.querySelectorAll<HTMLButtonElement>('#logsFilters .logs-chip')),
    counts: {
      all: $id<HTMLElement>('logsCountAll'),
      debug: $id<HTMLElement>('logsCountDebug'),
      info: $id<HTMLElement>('logsCountInfo'),
      warn: $id<HTMLElement>('logsCountWarn'),
      error: $id<HTMLElement>('logsCountError'),
    },
  };

  for (const chip of ui.chips) {
    chip.addEventListener('click', () => {
      const value = chip.dataset.level;
      levelFilter = value === 'info' || value === 'warn' || value === 'error' || value === 'debug' ? value : 'all';
      setFollow(true);
      render();
    });
  }

  /* 初始状态:输入框可能是浏览器恢复的(返回上一页时),清空按钮的可见性要跟值走 */
  searchClear.hidden = !search.value;
  let searchTimer = 0;
  search.addEventListener('search', () => {
    /* type=search 的原生"清除"走的是 search 事件,不会触发 input;不同步会留下
     * 一个看得见但点不动的清空按钮。 */
    if (searchTimer) { window.clearTimeout(searchTimer); searchTimer = 0; }
    searchQuery = search.value;
    searchClear.hidden = !searchQuery;
    render();
  });
  search.addEventListener('input', () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = 0;
      searchQuery = search.value;
      searchClear.hidden = !searchQuery;
      render();
    }, 120);
  });
  searchClear.addEventListener('click', () => {
    search.value = '';
    searchQuery = '';
    searchClear.hidden = true;
    search.focus();
    render();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      search.value = '';
      searchQuery = '';
      searchClear.hidden = true;
      render();
    }
  });

  follow.addEventListener('click', () => setFollow(!followLatest));
  refresh.addEventListener('click', () => void refreshFromDisk());
  copy.addEventListener('click', () => void copyCurrent());
  download.addEventListener('click', () => void downloadCurrent());
  /* 二段确认:第一次点只是"上膛"(按钮变红、文案变「确认清空」),3.2s 内再点才真的清。
   * 比 window.confirm 好在:不离开页面、不打断上下文,误点一次也只是多看一眼。 */
  clear.addEventListener('click', () => {
    if (entries.length === 0) {
      showHint('还没有日志,不需要清空');
      return;
    }
    if (!clearArmed) {
      clearArmed = true;
      clear.textContent = '确认清空';
      clear.classList.add('is-armed');
      clear.setAttribute('aria-label', '再次点击确认清空全部日志');
      showHint(bridge ? '再点一次清空:桌面版会同时删除磁盘上的日志文件' : '再点一次清空本次会话的日志');
      window.clearTimeout(clearArmTimer);
      clearArmTimer = window.setTimeout(disarmClear, 3200);
      return;
    }
    void clearAll();
  });

  /* 日志页的 / :聚焦搜索框(与编辑器里的 / 打开画廊同键不同页)。
   * 只在当前页是日志、没在输入控件里时生效;Esc 已经由搜索框自己处理清空。 */
  window.addEventListener('keydown', (e) => {
    if (document.documentElement.dataset.page !== 'logs') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });
  reveal.addEventListener('click', () => {
    if (!bridge || typeof bridge.reveal !== 'function') return;
    void bridge.reveal().then((ok) => {
      if (!ok) showHint('打不开日志文件夹:系统没有返回可打开的路径', 'error');
    }).catch((e: unknown) => showHint('打不开日志文件夹: ' + errText(e), 'error'));
  });

  /* 用户往上翻 = 想看历史:自动暂停跟随;翻回底部(48px 内)自动恢复。
   * 这里不能用 render 里的"渲染前保存 scrollTop"来推断,必须听真实滚动。 */
  body.addEventListener('scroll', () => {
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (distance > 48 && followLatest) setFollow(false);
    else if (distance <= 48 && !followLatest) setFollow(true);
  }, { passive: true });

  setFollow(true);
  paintBridgeState();
}

/* ---------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------- */

/** 对外暴露的写入入口。业务侧只需要记"发生了什么",不需要知道磁盘和 UI。 */
export const logs = {
  debug(tag: string, msg: string, detail?: string): void { pushEntry('debug', tag, msg, detail); },
  info(tag: string, msg: string, detail?: string): void { pushEntry('info', tag, msg, detail); },
  warn(tag: string, msg: string, detail?: string): void { pushEntry('warn', tag, msg, detail); },
  error(tag: string, msg: string, detail?: string): void { pushEntry('error', tag, msg, detail); },
};

export function initLogs(): void {
  if (booted) return;
  booted = true;
  bridge = getBridge();

  captureConsole();
  captureGlobalErrors();
  bindUi();
  /* 「用户日志 / 开发者日志」的切换由 devlog.ts 负责两块 pane 的显隐,它切换后广播
   * dfae:logmode。开发者视图下本模块不渲染(见 render 的可见性守卫),所以切回用户
   * 日志时在这里补一次,并恢复"跟随最新"的贴底位置。 */
  window.addEventListener('dfae:logmode', (event) => {
    const detail = (event as CustomEvent<{ mode?: string }>).detail;
    if (!detail) return;
    if (detail.mode !== 'user') {
      /* 切去开发者视图前没来得及画的那几行,不该在切回来时被当成"刚出现"闪一遍 */
      freshIds.clear();
      return;
    }
    if (!isLogsPage()) return;
    render();
    if (followLatest && ui) ui.body.scrollTop = ui.body.scrollHeight;
  });

  /* 开发者日志的 UI / fetch / 页面事件 / 启动环境在 console 与全局异常包装之后初始化:
   * 这样它在启动阶段就能开始接原始流,也复用同一组 DOM。 */
  try { initDevLog(); } catch { /* 开发者日志失败不能拖垮用户日志页 */ }

  /* 启动信息:排障时最常问的三件事(哪个版本、什么环境、日志在哪)先记下来。
   * 这条会随桌面版一起落盘,所以下次打开日志页仍能看到"这次是什么时候开的"。 */
  const version = versionLabel();
  const desktop = !!bridge;
  const mobile = isMobileLike();
  const client = desktop ? (mobile ? '手机客户端' : '桌面客户端') : '网页版';
  pushEntry('info', '应用', '应用启动' + (version ? ' · v' + version : '') + ' · ' + client, [
    'UA: ' + navigator.userAgent,
    '语言: ' + navigator.language + ' · 视口: ' + window.innerWidth + '×' + window.innerHeight,
    '地址: ' + location.href,
  ].join('\n'));

  if (desktop) {
    paintBridgeState();
    if (bridge && typeof bridge.info === 'function') {
      void bridge.info().then((info) => {
        if (!info) return;
        if (typeof info.dir === 'string') diskDir = info.dir;
        if (typeof info.file === 'string') diskFile = info.file;
        paintBridgeState();
      }).catch(() => { /* 取不到路径不影响使用 */ });
    }
    void loadHistory();
    window.addEventListener('pagehide', () => { void flushDisk(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushDisk();
    });
  } else {
    pushEntry('info', '应用', '网页版 / 手机端的日志只保存在本次会话;需要保留请用「复制」或「下载」');
  }

  /* 页面切换:从别处进日志页时清掉未读徽标并补一次渲染(进入前不会有日志渲染,省开销) */
  window.addEventListener('dfae:viewchange', (event) => {
    const detail = (event as CustomEvent<{ page?: string }>).detail;
    if (!detail || detail.page !== 'logs') return;
    markLogsSeen();
    /* 桌面版顺手再读一次磁盘:主进程的日志(更新下载、导出落盘失败、渲染进程崩溃…)
     * 只写文件、不走 IPC 推送,不主动读的话用户点进日志页会以为"什么都没发生"。
     * 读回按 id 去重,重复打开页面不会重复堆积。 */
    if (bridge) void loadHistory();
    render();
    if (followLatest && ui) ui.body.scrollTop = ui.body.scrollHeight;
  });
}
