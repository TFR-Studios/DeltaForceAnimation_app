/* ============================================================================
 * 开发者日志(src/devlog.ts)
 * ---------------------------------------------------------------------------
 * 面向开发的第二套日志视图,和 src/logs.ts 的用户日志并存、互不污染:
 *   · 用户日志:中文标签、业务事件、可落盘到 <userData>/logs/dfae.log(由 logs.ts + 主进程负责);
 *   · 开发者日志:原始流,终端形态,全部使用原生英文等级/来源,只存在当前会话内存里。
 *
 * 采集范围(进入应用就开始,不需要先切到开发者视图):
 *   · console.debug / log / info / warn / error:保留原始参数、printf 占位符、对象 JSON、Error 堆栈;
 *   · window 的 error / unhandledrejection;
 *   · fetch:请求方式 / URL / 状态 / 耗时 / 失败原因(不记录请求体与响应体);
 *   · setStatus 的状态栏事件(main.ts 转发;导出进度百分比在源头被过滤,避免刷屏);
 *   · 页面切换(ui => view)与显式 devEvent(anim / export / update / app …)。
 *
 * 查看:页头「用户日志 / 开发者日志」切换,开发者视图是内嵌终端:
 *   等级筛选 → 终端日志流 → 底部 $ 命令输入。命令集见 COMMANDS 常量(help 可查)。
 *   选择记在 localStorage(dfae.ui.logMode.v1),刷新后保持。
 *
 * 导出:终端 COPY / SAVE 与 copy/save 命令共用 buildDevText():
 *   DFAE DEV LOG · SESSION EXPORT
 *   exported <ISO8601>
 *   entries=<n> level=<filter> text="<text>"
 *   ----
 *   [HH:MM:SS.mmm] LEVEL source message
 *       detail(每行前 4 空格)
 *
 * 与 logs.ts 的边界:本模块不 import logs.ts(避免循环依赖),由 logs.ts 单向调用
 * devCaptureConsole / devCaptureError,并在 initLogs() 里调用 initDevLog()。
 * ========================================================================== */

export type DevLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DevLogEntry = {
  /** 会话内自增序号,只做渲染 key 与排序,不落盘 */
  id: number;
  t: number;
  level: DevLogLevel;
  /** 原生来源:console.warn / window.error / unhandledrejection / net / status / ui / anim / export … */
  source: string;
  msg: string;
  /** 堆栈、额外行;导出时每行缩进 4 空格 */
  detail?: string;
};

type DevMode = 'user' | 'dev';
type LevelFilter = 'all' | DevLogLevel;
type LocalKind = 'cmd' | 'out' | 'err';
type LocalLine = { id: number; kind: LocalKind; text: string };

type LogsBridge = {
  exportText?: (text: string, defaultName: string) => Promise<{ ok?: boolean; path?: string; canceled?: boolean; error?: string }>;
  copyText?: (text: string) => Promise<boolean>;
};

type DevUi = {
  root: HTMLElement;
  userPane: HTMLElement;
  devPane: HTMLElement;
  sub: HTMLElement | null;
  state: HTMLElement | null;
  modeWrap: HTMLElement;
  modeUser: HTMLButtonElement;
  modeDev: HTMLButtonElement;
  meta: HTMLElement;
  follow: HTMLButtonElement;
  copy: HTMLButtonElement;
  download: HTMLButtonElement;
  clear: HTMLButtonElement;
  body: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  emptyText: HTMLElement | null;
  cmd: HTMLInputElement;
  filterInfo: HTMLElement;
  chips: HTMLButtonElement[];
  counts: Record<'all' | DevLogLevel, HTMLElement | null>;
};

const MODE_KEY = 'dfae.ui.logMode.v1';
const MAX_ENTRIES = 5000;
const MAX_ROWS = 1200;
const MAX_LOCAL = 300;
const MAX_MSG = 4000;
const MAX_DETAIL = 12000;
const MAX_SOURCE = 48;
const MAX_TEXT = 6000;

const LEVELS: DevLogLevel[] = ['debug', 'info', 'warn', 'error'];
const LEVEL_LABEL: Record<DevLogLevel, string> = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };
const USER_SUB = '应用运行、导出与更新过程中的关键事件;遇到问题先看这里';
/* 控制区文案用中文;日志行本身仍是原生英文等级 / 来源 / 消息,不做翻译。 */
const DEV_SUB = '原始控制台日志流 · 原生格式 · 仅本次会话 · 输入 help 查看命令';

/* 帮助用"短横线分隔"而不是对齐到固定列:终端在手机 / 窄窗口里只有 ~330px,
 * 用空格对到 40 列会让每条帮助都折成两三行,反而更难读。 */
const COMMANDS = [
  'COMMANDS',
  '  help — show this list',
  '  clear — clear the session log',
  '  level <all|debug|info|warn|error> — set the level filter',
  '  filter <text> | /<text> — filter lines (no argument clears)',
  '  follow [on|off] — auto-scroll to the newest line',
  '  copy — copy filtered lines to clipboard',
  '  save | download — save filtered lines to a file',
  '  count — print level counts',
  '  mode user|dev — switch view',
  '  exit — back to the user log',
  '  version — print the app version',
  '  ↑/↓ history · Esc clears input · Ctrl+L clears the log',
];

const entries: DevLogEntry[] = [];
const localLines: LocalLine[] = [];
const commandHistory: string[] = [];
let seq = 0;
let localSeq = 0;
let historyIndex = 0;
let draftInput = '';
let mode: DevMode = 'user';
let levelFilter: LevelFilter = 'all';
let textFilter = '';
let followLatest = true;
let renderQueued = false;
let inited = false;
let fetchInstalled = false;
let ui: DevUi | null = null;

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e == null ? '' : e);
}

function versionLabel(): string {
  try {
    /* __APP_VERSION__ 由 vite.config.ts 的 define 注入(见 src/vite-env.d.ts) */
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
  } catch {
    return '';
  }
}

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

function isDevActive(): boolean {
  return mode === 'dev' && !!ui && isLogsPage();
}

function getBridge(): LogsBridge | null {
  try {
    const bridge = (window as unknown as { dfaeLogs?: LogsBridge }).dfaeLogs;
    return bridge && typeof bridge === 'object' ? bridge : null;
  } catch {
    return null;
  }
}

function $id<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function clip(text: string, max: number): string {
  const value = String(text == null ? '' : text);
  return value.length > max ? value.slice(0, Math.max(0, max - 1)) + '…' : value;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** 终端时间:HH:MM:SS.mmm(本地时区;原生控制台也没有日期,日期放在导出头里) */
function nativeTime(t: number): string {
  const d = new Date(t);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
}

function fileStamp(t: number): string {
  const d = new Date(t);
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/* ---------------------------------------------------------------------------
 * 原始值格式化:尽量贴近浏览器控制台的输出
 * ------------------------------------------------------------------------- */

function safeJson(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v as object)) return '[Circular]';
        seen.add(v as object);
      }
      if (typeof v === 'function') return '[Function ' + ((v as () => void).name || 'anonymous') + ']';
      if (typeof v === 'bigint') return String(v) + 'n';
      if (v instanceof Error) return '[Error ' + v.name + ': ' + v.message + ']';
      return v;
    });
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function inspectValue(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
    if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') return 'ƒ ' + ((value as () => void).name || 'anonymous') + '()';
    if (value instanceof Error) {
      /* 堆栈不塞进消息行:原始行保持"Error: message"一行,stack 由 formatConsoleArgs
       * 统一收进 detail —— 否则同一段栈会在消息和详情里各出现一次,还会把一条日志撑成十几行。 */
      return value.name + ': ' + value.message;
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return value.toString();
    if (typeof Element !== 'undefined' && value instanceof Element) {
      const tag = value.tagName.toLowerCase();
      const id = value.id ? '#' + value.id : '';
      const cls = value.classList && value.classList.length ? '.' + Array.from(value.classList).slice(0, 3).join('.') : '';
      return '<' + tag + id + cls + '>';
    }
    if (typeof Node !== 'undefined' && value instanceof Node) return '[Node ' + value.nodeName + ']';
    if (value instanceof Map) return 'Map(' + value.size + ') ' + safeJson(Array.from(value.entries()));
    if (value instanceof Set) return 'Set(' + value.size + ') ' + safeJson(Array.from(value.values()));
    return clip(safeJson(value), MAX_TEXT);
  } catch {
    return '[Unserializable]';
  }
}

type FormattedArgs = { msg: string; detail?: string };

/**
 * 按浏览器 console 的 printf 规则处理格式串:
 *   %s / %d / %i / %f / %o / %O / %j 正常替换;%c 消费一个样式参数但不输出;%% 输出百分号。
 * 没有格式串时,所有参数按空格拼接。Error 的 stack 进 detail。
 */
function formatConsoleArgs(args: unknown[]): FormattedArgs {
  let text = '';
  let consumed = 0;
  const first = args[0];
  if (typeof first === 'string') {
    const fmt = first;
    let out = '';
    let argIndex = 1;
    for (let i = 0; i < fmt.length; i += 1) {
      const ch = fmt[i];
      if (ch !== '%' || i + 1 >= fmt.length) {
        out += ch;
        continue;
      }
      const spec = fmt[i + 1];
      if (spec === '%') { out += '%'; i += 1; continue; }
      if (spec === 'c') { i += 1; argIndex += 1; continue; }
      if (spec === 's' || spec === 'd' || spec === 'i' || spec === 'f' || spec === 'o' || spec === 'O' || spec === 'j') {
        if (argIndex < args.length) {
          const value = args[argIndex];
          argIndex += 1;
          if (spec === 'd' || spec === 'i') out += String(Math.trunc(Number(value)));
          else if (spec === 'f') out += String(Number(value));
          else if (spec === 'j') out += safeJson(value);
          else out += inspectValue(value);
          i += 1;
          continue;
        }
      }
      out += '%';
    }
    text = out;
    consumed = argIndex;
  } else {
    text = args.map(inspectValue).join(' ');
    consumed = args.length;
  }
  if (consumed < args.length) {
    const rest = args.slice(consumed).map(inspectValue).join(' ');
    text = text ? text + ' ' + rest : rest;
  } else if (!text && args.length > 0) {
    text = args.map(inspectValue).join(' ');
  }
  const stacks: string[] = [];
  for (const arg of args) {
    if (arg instanceof Error && arg.stack) stacks.push(String(arg.stack));
  }
  return {
    msg: clip(text, MAX_MSG),
    ...(stacks.length ? { detail: clip(stacks.join('\n\n'), MAX_DETAIL) } : {}),
  };
}

/** 控制台地址里的长 data/blob URL 只留类型与长度,否则一条日志能占半屏 */
function compactUrl(url: string): string {
  if (!url) return '';
  if (/^data:/i.test(url)) return 'data:… (' + url.length + ' chars)';
  if (/^blob:/i.test(url)) return 'blob:… (' + url.length + ' chars)';
  return clip(url, 400);
}

/* ---------------------------------------------------------------------------
 * 写入:所有来源最终汇到这里
 * ------------------------------------------------------------------------- */

function scheduleRender(): void {
  if (!isDevActive() || renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function pushEntry(level: DevLogLevel, source: string, msg: string, detail?: string): void {
  try {
    const entry: DevLogEntry = {
      id: ++seq,
      t: Date.now(),
      level,
      source: clip(String(source || 'app').trim(), MAX_SOURCE),
      msg: clip(String(msg == null ? '' : msg), MAX_MSG),
      ...(detail ? { detail: clip(detail, MAX_DETAIL) } : {}),
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    scheduleRender();
  } catch {
    /* 开发者日志自身绝不能向业务抛错 */
  }
}

/** 显式事件入口:main.ts / start-screen.ts 在动画、导出、更新等节点调用。 */
export function devEvent(source: string, msg: string, detail?: string, level: DevLogLevel = 'info'): void {
  pushEntry(level, source, msg, detail);
}

/** console 包装器调用:保留原始参数,不再经过用户日志的"汇总成一句"格式化。 */
export function devCaptureConsole(method: 'debug' | 'log' | 'info' | 'warn' | 'error', args: unknown[]): void {
  const level: DevLogLevel = method === 'debug' ? 'debug' : method === 'warn' ? 'warn' : method === 'error' ? 'error' : 'info';
  const formatted = formatConsoleArgs(args);
  pushEntry(level, 'console.' + method, formatted.msg || '(empty)', formatted.detail);
}

/** window error / unhandledrejection 调用:source 用原生事件名区分。 */
export function devCaptureError(source: string, message: string, detail?: string): void {
  pushEntry('error', source, message || '(empty error)', detail);
}

/* ---------------------------------------------------------------------------
 * 网络采集:方法 / URL / 状态 / 耗时;不碰请求与响应内容
 * ------------------------------------------------------------------------- */

function installFetch(): void {
  if (fetchInstalled) return;
  fetchInstalled = true;
  const original = window.fetch;
  if (typeof original !== 'function') return;
  try {
    window.fetch = function devFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let url = '';
      let method = 'GET';
      try {
        if (input instanceof Request) {
          url = input.url;
          method = (init && init.method) || input.method || 'GET';
        } else {
          url = String(input);
          method = (init && init.method) || 'GET';
        }
      } catch {
        /* 非法 Request 也照常交给原生 fetch 决定怎么报错 */
      }
      const shortUrl = compactUrl(url);
      const methodLabel = String(method || 'GET').toUpperCase();
      const started = performance.now();
      devEvent('net', '--> ' + methodLabel + ' ' + shortUrl, undefined, 'debug');
      let response: Promise<Response>;
      try {
        response = original.call(window, input as RequestInfo, init);
      } catch (e) {
        devEvent('net', '!!! ' + methodLabel + ' ' + shortUrl + ' · ' + errText(e), undefined, 'error');
        throw e;
      }
      return response.then(
        (res) => {
          const ms = Math.round(performance.now() - started);
          const level: DevLogLevel = res.ok ? 'debug' : 'warn';
          devEvent('net', '<-- ' + res.status + ' ' + res.statusText + ' ' + shortUrl + ' · ' + ms + 'ms', undefined, level);
          return res;
        },
        (e) => {
          const ms = Math.round(performance.now() - started);
          devEvent('net', '!!! ' + methodLabel + ' ' + shortUrl + ' · ' + errText(e) + ' · ' + ms + 'ms', undefined, 'error');
          throw e;
        },
      );
    } as typeof window.fetch;
  } catch {
    fetchInstalled = false;
  }
}

/* ---------------------------------------------------------------------------
 * 渲染
 * ------------------------------------------------------------------------- */

function countsOf(): Record<'all' | DevLogLevel, number> {
  const counts: Record<'all' | DevLogLevel, number> = { all: entries.length, debug: 0, info: 0, warn: 0, error: 0 };
  for (const entry of entries) counts[entry.level] += 1;
  return counts;
}

function filteredEntries(): DevLogEntry[] {
  const query = textFilter.trim().toLowerCase();
  return entries.filter((entry) => {
    if (levelFilter !== 'all' && entry.level !== levelFilter) return false;
    if (!query) return true;
    return (entry.source + ' ' + entry.msg + ' ' + (entry.detail || '')).toLowerCase().includes(query);
  });
}

function addLocal(kind: LocalKind, text: string): void {
  const line: LocalLine = { id: ++localSeq, kind, text: String(text == null ? '' : text) };
  localLines.push(line);
  if (localLines.length > MAX_LOCAL) localLines.splice(0, localLines.length - MAX_LOCAL);
  localDirty = true;
  scheduleRender();
}

/* ---------------------------------------------------------------------------
 * 渲染(增量)
 * ---------------------------------------------------------------------------
 * 与用户日志同一套策略:原始流每秒可能来几十条,而终端最多显示 1200 行;
 * 每来一行就整表 innerHTML 重画会把滚动位置一次次拉回去、把正在选中的文本清掉。
 * 这里只补尾部、删头部(头部掉行时补偿滚动高度),命令行回显单独维护节点、
 * 永远排在数据行之后。筛选条件变了才整表重建。
 * ------------------------------------------------------------------------- */
let renderedSig = '';
const renderedIds: number[] = [];
const localElById = new Map<number, HTMLElement>();
let localDirty = false;

function devFilterSig(): string {
  return levelFilter + '\u0000' + textFilter;
}

function devRowHtml(entry: DevLogEntry): string {
  const detail = entry.detail
    ? '<pre class="dev-detail">' + escapeHtml(entry.detail) + '</pre>'
    : '';
  return '<div class="dev-row" data-level="' + entry.level + '">'
    + '<div class="dev-head">'
    + '<span class="dev-time">' + nativeTime(entry.t) + '</span>'
    + '<span class="dev-lvl">' + LEVEL_LABEL[entry.level] + '</span>'
    + '<span class="dev-src" title="' + escapeHtml(entry.source) + '">' + escapeHtml(entry.source) + '</span>'
    + '<span class="dev-msg">' + escapeHtml(entry.msg || '(empty)') + '</span>'
    + '</div>'
    + detail
    + '</div>';
}

function makeLocalEl(line: LocalLine): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dev-row is-' + line.kind;
  const span = document.createElement('span');
  span.className = 'dev-local';
  span.textContent = line.text;
  el.appendChild(span);
  return el;
}

/** 命令行回显:按 id 复用节点,只删被 MAX_LOCAL 挤掉的、补新来的。 */
function reconcileLocal(): void {
  if (!ui) return;
  const wanted = new Set<number>();
  for (const line of localLines) wanted.add(line.id);
  for (const [id, el] of Array.from(localElById)) {
    if (!wanted.has(id)) {
      el.remove();
      localElById.delete(id);
    }
  }
  for (const line of localLines) {
    let el = localElById.get(line.id);
    if (!el) {
      el = makeLocalEl(line);
      localElById.set(line.id, el);
    }
    ui.list.appendChild(el);
  }
  localDirty = false;
}

function rebuildDevRows(rows: DevLogEntry[]): void {
  if (!ui) return;
  ui.list.textContent = '';
  if (rows.length) ui.list.insertAdjacentHTML('beforeend', rows.map((e) => devRowHtml(e)).join(''));
  renderedIds.length = 0;
  for (const e of rows) renderedIds.push(e.id);
  localElById.clear();
  for (const line of localLines) {
    const el = makeLocalEl(line);
    localElById.set(line.id, el);
    ui.list.appendChild(el);
  }
  localDirty = false;
}

type DevRowPatch = { ok: boolean; removedHeight: number };

/** 补/删数据行;返回 ok=false 时调用方整表重建。 */
function patchDevRows(rows: DevLogEntry[]): DevRowPatch {
  if (!ui) return { ok: false, removedHeight: 0 };
  if (renderedIds.length === 0) {
    return { ok: rows.length === 0, removedHeight: 0 };
  }
  if (rows.length === 0) return { ok: false, removedHeight: 0 };
  const children = ui.list.children;
  if (children.length < renderedIds.length) return { ok: false, removedHeight: 0 };
  /* 数据行永远排在命令行回显前面:先确认前 renderedIds.length 个孩子都是数据行 */
  for (let i = 0; i < renderedIds.length; i += 1) {
    const el = children[i] as HTMLElement;
    if (!el.hasAttribute('data-level')) return { ok: false, removedHeight: 0 };
  }
  /* 与用户日志同一套:找新窗口第一行相对旧窗口的偏移 k = 这一帧从头部掉出去的行数。
   * 找旧窗口第一行是错的 —— 到达 1200 行上限后,它正是每帧被挤掉的那一行。 */
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
  /* 掉行补偿同样不能用 offsetHeight 相加(.dev-log-list 有 2px gap),量第一个留下的
   * 行距列表顶的距离,删完正好归零。 */
  let removedHeight = 0;
  if (k > 0) {
    const listTop = ui.list.getBoundingClientRect().top;
    removedHeight = Math.max(0, (ui.list.children[k] as HTMLElement).getBoundingClientRect().top - listTop);
    for (let i = 0; i < k; i += 1) {
      (ui.list.children[i] as HTMLElement).remove();
    }
  }
  const lastOld = ui.list.children[keep - 1] as HTMLElement | undefined;
  const tail = rows.slice(keep);
  if (tail.length) {
    const html = tail.map((e) => devRowHtml(e)).join('');
    if (lastOld) lastOld.insertAdjacentHTML('afterend', html);
    else ui.list.insertAdjacentHTML('afterbegin', html);
  }
  renderedIds.length = 0;
  for (const e of rows) renderedIds.push(e.id);
  return { ok: true, removedHeight };
}

function render(): void {
  if (!ui) return;
  const counts = countsOf();
  for (const level of ['all', ...LEVELS] as const) {
    const el = ui.counts[level];
    if (el) el.textContent = String(counts[level]);
  }
  for (const chip of ui.chips) {
    const on = (chip.dataset.level || 'all') === levelFilter;
    chip.classList.toggle('is-active', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  const matched = filteredEntries();
  const rows = matched.slice(Math.max(0, matched.length - MAX_ROWS));
  const body = ui.body;
  const previousTop = body.scrollTop;
  const sig = devFilterSig();
  let rebuilt = false;
  let removedHeight = 0;
  if (sig === renderedSig) {
    const patch = patchDevRows(rows);
    if (patch.ok) removedHeight = patch.removedHeight;
    else rebuilt = true;
  } else {
    rebuilt = true;
  }
  if (rebuilt) rebuildDevRows(rows);
  else if (localDirty) reconcileLocal();
  renderedSig = sig;

  /* 空态只看"有没有日志行":命令行输出(help / count / copy 结果)不算日志。
   * 这样 clear 命令执行后,回显仍留在终端里,但空态提示也出现 —— CLI 的常见形态。 */
  const empty = rows.length === 0;
  ui.empty.hidden = !empty;
  if (ui.emptyText) {
    ui.emptyText.textContent = entries.length === 0
      ? '本次会话还没有日志。控制台输出、错误与网络请求会出现在这里。'
      : '没有匹配当前筛选条件的日志。';
  }

  if (textFilter.trim()) {
    ui.filterInfo.hidden = false;
    ui.filterInfo.textContent = '过滤 "' + clip(textFilter.trim(), 80) + '"';
  } else {
    ui.filterInfo.hidden = true;
    ui.filterInfo.textContent = '';
  }

  /* 控制区用中文;日志行里的 LEVEL 仍是原生 DEBUG/INFO/WARN/ERROR */
  const meta: string[] = ['本次会话'];
  meta.push(counts.all + ' 行');
  /* "显示" 说的是 DOM 里真实渲染的行数,不是匹配总数:超过 MAX_ROWS 时两者不同,
   * 只写匹配数会让开发者误以为全部都在屏幕上。 */
  if (rows.length !== counts.all) {
    meta.push('显示 ' + rows.length + (matched.length > rows.length ? '/' + matched.length : ''));
  }
  if (levelFilter !== 'all') meta.push('等级=' + LEVEL_LABEL[levelFilter]);
  if (textFilter.trim()) meta.push('已过滤');
  ui.meta.textContent = meta.join(' · ');

  if (followLatest) body.scrollTop = body.scrollHeight;
  else if (rebuilt) body.scrollTop = previousTop;
  else if (removedHeight > 0) body.scrollTop = Math.max(0, previousTop - removedHeight);
}

/* ---------------------------------------------------------------------------
 * 导出 / 剪贴板
 * ------------------------------------------------------------------------- */

function buildDevText(list: DevLogEntry[]): string {
  const head = [
    'DFAE DEV LOG · SESSION EXPORT',
    'exported ' + new Date().toISOString(),
    'entries=' + list.length + ' level=' + levelFilter + ' text="' + textFilter.trim().replace(/"/g, "'") + '"',
    '----',
  ];
  const lines: string[] = [];
  for (const entry of list) {
    lines.push('[' + nativeTime(entry.t) + '] ' + LEVEL_LABEL[entry.level] + ' ' + entry.source + ' ' + entry.msg);
    if (entry.detail) {
      for (const line of entry.detail.split(/\r?\n/)) lines.push('    ' + line);
    }
  }
  return head.join('\n') + (lines.length ? '\n' + lines.join('\n') + '\n' : '\n');
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走桌面桥 / textarea */
  }
  const bridge = getBridge();
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

async function copyLines(): Promise<void> {
  const list = filteredEntries();
  if (list.length === 0) {
    addLocal('err', 'nothing to copy: the current filter has no lines');
    return;
  }
  const ok = await writeClipboard(buildDevText(list));
  if (ok) addLocal('out', 'copied ' + list.length + ' line(s) to clipboard');
  else addLocal('err', 'copy failed: clipboard is not available');
}

async function saveLines(): Promise<void> {
  const list = filteredEntries();
  if (list.length === 0) {
    addLocal('err', 'nothing to save: the current filter has no lines');
    return;
  }
  const text = buildDevText(list);
  const filename = 'dfae-devlog-' + fileStamp(Date.now()) + '.log';
  const bridge = getBridge();
  if (bridge && typeof bridge.exportText === 'function') {
    addLocal('out', 'saving ' + list.length + ' line(s) via system save dialog…');
    try {
      const res = await bridge.exportText(text, filename);
      if (res && res.canceled) addLocal('out', 'save canceled');
      else if (res && res.ok && res.path) addLocal('out', 'saved to ' + res.path);
      else addLocal('err', 'save failed: ' + ((res && res.error) || 'unknown error'));
    } catch (e) {
      addLocal('err', 'save failed: ' + errText(e));
    }
    return;
  }
  triggerDownload(text, filename);
  addLocal('out', 'download started: ' + filename);
}

/* ---------------------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------------------- */

function historyReset(): void {
  historyIndex = commandHistory.length;
  draftInput = '';
}

function showHistory(delta: number): void {
  if (!ui || commandHistory.length === 0) return;
  if (delta < 0) {
    if (historyIndex === commandHistory.length) draftInput = ui.cmd.value;
    if (historyIndex > 0) historyIndex -= 1;
  } else if (historyIndex < commandHistory.length) {
    historyIndex += 1;
  }
  ui.cmd.value = historyIndex >= commandHistory.length ? draftInput : commandHistory[historyIndex];
  const end = ui.cmd.value.length;
  ui.cmd.setSelectionRange(end, end);
}

function setLevelFilter(next: LevelFilter): void {
  levelFilter = next;
  if (ui) render();
}

function setTextFilter(next: string): void {
  textFilter = next;
  if (ui) render();
  if (ui && followLatest) ui.body.scrollTop = ui.body.scrollHeight;
}

function setFollow(on: boolean): void {
  followLatest = on;
  if (!ui) return;
  ui.follow.setAttribute('aria-pressed', on ? 'true' : 'false');
  ui.follow.title = on ? '自动滚动已开启(点击暂停)' : '已暂停跟随;点击恢复';
  if (on) ui.body.scrollTop = ui.body.scrollHeight;
}

function clearDevLog(keepCommand?: string): void {
  entries.length = 0;
  localLines.length = 0;
  localDirty = true;
  /* 强制下一次整表重建:DOM 里旧的数据行不能靠增量 patch 判断(全都没了,无法配对) */
  renderedSig = '';
  if (keepCommand) addLocal('cmd', keepCommand);
  render();
}

function runCommand(raw: string): void {
  const command = raw.trim();
  if (!command) return;
  if (commandHistory[commandHistory.length - 1] !== command) commandHistory.push(command);
  if (commandHistory.length > 100) commandHistory.shift();
  historyReset();
  addLocal('cmd', command);

  /* /text 是 filter text 的简写:开发者最常用的动作值得少打一个单词 */
  if (command.startsWith('/')) {
    const text = command.slice(1).trim();
    setTextFilter(text);
    addLocal('out', text ? 'filter = "' + text + '"' : 'filter cleared');
    return;
  }

  const match = command.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const name = (match?.[1] || '').toLowerCase();
  const rest = (match?.[2] || '').trim();

  if (name === 'help' || name === '?') {
    for (const line of COMMANDS) addLocal('out', line);
    return;
  }
  if (name === 'clear' || name === 'cls') {
    clearDevLog(command);
    addLocal('out', 'log cleared');
    return;
  }
  if (name === 'level') {
    const value = rest.toLowerCase();
    if (value === 'all' || value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
      setLevelFilter(value);
      addLocal('out', 'level = ' + value);
    } else {
      addLocal('err', 'usage: level <all|debug|info|warn|error>');
    }
    return;
  }
  if (name === 'filter' || name === 'grep' || name === 'find') {
    const value = rest.replace(/^["']|["']$/g, '');
    setTextFilter(value);
    addLocal('out', value ? 'filter = "' + value + '"' : 'filter cleared');
    return;
  }
  if (name === 'follow') {
    const value = rest.toLowerCase();
    if (value === 'on' || value === 'true' || value === '1') { setFollow(true); addLocal('out', 'follow = on'); }
    else if (value === 'off' || value === 'false' || value === '0') { setFollow(false); addLocal('out', 'follow = off'); }
    else if (!value) { setFollow(!followLatest); addLocal('out', 'follow = ' + (followLatest ? 'on' : 'off')); }
    else addLocal('err', 'usage: follow [on|off]');
    return;
  }
  if (name === 'copy') { void copyLines(); return; }
  if (name === 'save' || name === 'download' || name === 'export') { void saveLines(); return; }
  if (name === 'count') {
    const counts = countsOf();
    addLocal('out', 'total=' + counts.all + ' debug=' + counts.debug + ' info=' + counts.info + ' warn=' + counts.warn + ' error=' + counts.error);
    return;
  }
  if (name === 'mode') {
    const value = rest.toLowerCase();
    if (value === 'user' || value === 'dev') {
      setMode(value);
      addLocal('out', 'mode = ' + value);
    } else {
      addLocal('err', 'usage: mode user|dev');
    }
    return;
  }
  if (name === 'exit' || name === 'user') {
    setMode('user');
    return;
  }
  if (name === 'version') {
    addLocal('out', 'DFAE ' + (versionLabel() || 'unknown') + ' · devlog session');
    return;
  }
  addLocal('err', 'unknown command: ' + name + ' (type help)');
}

/* ---------------------------------------------------------------------------
 * 模式切换 / 绑定 / 初始化
 * ------------------------------------------------------------------------- */

function persistMode(next: DevMode): void {
  try { localStorage.setItem(MODE_KEY, next); } catch { /* 私密模式 / 存储被拒:本次会话内仍可切换 */ }
}

function readMode(): DevMode {
  try { return localStorage.getItem(MODE_KEY) === 'dev' ? 'dev' : 'user'; } catch { return 'user'; }
}

function setMode(next: DevMode, persist = true, focusCommand = true): void {
  mode = next;
  if (persist) persistMode(next);
  if (!ui) return;
  ui.root.dataset.logMode = next;
  ui.userPane.hidden = next === 'dev';
  ui.devPane.hidden = next !== 'dev';
  /* 滑动指示器的位置是纯状态:数据属性一换,CSS 用 transform 滑过去 */
  ui.modeWrap.dataset.current = next;
  if (ui.state) ui.state.hidden = next === 'dev';
  ui.modeUser.classList.toggle('is-active', next === 'user');
  ui.modeDev.classList.toggle('is-active', next === 'dev');
  ui.modeUser.setAttribute('aria-selected', next === 'user' ? 'true' : 'false');
  ui.modeDev.setAttribute('aria-selected', next === 'dev' ? 'true' : 'false');
  /* roving tabindex:Tab 只停在当前选中的那枚,方向键在两者间移动 */
  ui.modeUser.tabIndex = next === 'user' ? 0 : -1;
  ui.modeDev.tabIndex = next === 'dev' ? 0 : -1;
  if (ui.sub) ui.sub.textContent = next === 'dev' ? DEV_SUB : USER_SUB;
  /* 通知用户日志模块。开发者视图开着时它不做 DOM 重建(见 src/logs.ts 的可见性守卫),
   * 切回用户视图后由它补一次渲染并恢复"跟随最新"的贴底位置。 */
  try {
    window.dispatchEvent(new CustomEvent('dfae:logmode', { detail: { mode: next } }));
  } catch { /* 老环境没有 CustomEvent:下一次 dfae:viewchange 也会补渲染 */ }
  if (next === 'dev') {
    render();
    /* 只在日志页真的在前台时聚焦命令输入:启动时若上次记住的是 dev,
     * 这里可能还在主页 / 编辑器,聚焦隐藏元素既无意义还可能把滚动带走。
     * 键盘方向键切换时传 focusCommand=false,焦点留在 tab 上(读屏用户预期)。 */
    if (focusCommand && !isMobileLike() && isLogsPage()) {
      try { ui.cmd.focus({ preventScroll: true }); } catch { /* 老内核不支持 options */ }
    }
  }
}

function bindUi(): DevUi | null {
  const root = $id<HTMLElement>('viewLogs');
  const userPane = $id<HTMLElement>('logsUserPane');
  const devPane = $id<HTMLElement>('logsDevPane');
  const modeWrap = $id<HTMLElement>('logsMode');
  const modeUser = $id<HTMLButtonElement>('logsModeUser');
  const modeDev = $id<HTMLButtonElement>('logsModeDev');
  const meta = $id<HTMLElement>('devLogMeta');
  const follow = $id<HTMLButtonElement>('devLogFollow');
  const copy = $id<HTMLButtonElement>('devLogCopy');
  const download = $id<HTMLButtonElement>('devLogDownload');
  const clear = $id<HTMLButtonElement>('devLogClear');
  const body = $id<HTMLElement>('devLogBody');
  const list = $id<HTMLElement>('devLogList');
  const empty = $id<HTMLElement>('devLogEmpty');
  const cmd = $id<HTMLInputElement>('devLogCmd');
  const filterInfo = $id<HTMLElement>('devLogFilterInfo');
  if (!root || !userPane || !devPane || !modeWrap || !modeUser || !modeDev || !meta || !follow || !copy || !download || !clear || !body || !list || !empty || !cmd || !filterInfo) {
    return null;
  }
  const devUi: DevUi = {
    root,
    userPane,
    devPane,
    modeWrap,
    sub: $id<HTMLElement>('logsSub'),
    state: $id<HTMLElement>('logsState'),
    modeUser,
    modeDev,
    meta,
    follow,
    copy,
    download,
    clear,
    body,
    list,
    empty,
    emptyText: $id<HTMLElement>('devLogEmptyText'),
    cmd,
    filterInfo,
    chips: Array.from(root.querySelectorAll<HTMLButtonElement>('#devLogFilters .dev-chip')),
    counts: {
      all: $id<HTMLElement>('devCountAll'),
      debug: $id<HTMLElement>('devCountDebug'),
      info: $id<HTMLElement>('devCountInfo'),
      warn: $id<HTMLElement>('devCountWarn'),
      error: $id<HTMLElement>('devCountError'),
    },
  };

  modeUser.addEventListener('click', () => setMode('user'));
  modeDev.addEventListener('click', () => setMode('dev'));
  /* tablist 的键盘约定:←/→ 在两者间切换,Home/End 直接到首/尾。
   * 切换时不把焦点扔进命令输入(那是鼠标点击的便利行为),焦点留在 tab 上。 */
  const onModeKey = (event: KeyboardEvent): void => {
    const key = event.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
    event.preventDefault();
    const next: DevMode = key === 'ArrowLeft' || key === 'Home' ? 'user' : 'dev';
    if (next === mode) return;
    setMode(next, true, false);
    (next === 'dev' ? modeDev : modeUser).focus();
  };
  modeUser.addEventListener('keydown', onModeKey);
  modeDev.addEventListener('keydown', onModeKey);
  for (const chip of devUi.chips) {
    chip.addEventListener('click', () => {
      const value = chip.dataset.level;
      setLevelFilter(value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'all');
      setFollow(true);
    });
  }
  follow.addEventListener('click', () => setFollow(!followLatest));
  copy.addEventListener('click', () => void copyLines());
  download.addEventListener('click', () => void saveLines());
  clear.addEventListener('click', () => { clearDevLog(); setFollow(true); });
  cmd.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = cmd.value;
      cmd.value = '';
      runCommand(value);
      return;
    }
    if (event.key === 'ArrowUp') { event.preventDefault(); showHistory(-1); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); showHistory(1); return; }
    if (event.key === 'Escape') {
      event.stopPropagation();
      cmd.value = '';
      historyReset();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'l' || event.key === 'L')) {
      event.preventDefault();
      clearDevLog();
      return;
    }
  });
  body.addEventListener('scroll', () => {
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (distance > 48 && followLatest) setFollow(false);
    else if (distance <= 48 && !followLatest) setFollow(true);
  }, { passive: true });

  return devUi;
}

function installUiEvents(): void {
  window.addEventListener('dfae:viewchange', (event) => {
    const detail = (event as CustomEvent<{ page?: string }>).detail;
    if (!detail) return;
    devEvent('ui', 'view -> ' + (detail.page || '?'), undefined, 'debug');
    if (detail.page === 'logs' && mode === 'dev') render();
  });
  document.addEventListener('visibilitychange', () => {
    devEvent('ui', 'visibility = ' + document.visibilityState, undefined, 'debug');
  });
  window.addEventListener('online', () => devEvent('net', 'browser online', undefined, 'debug'));
  window.addEventListener('offline', () => devEvent('net', 'browser offline', undefined, 'warn'));
}

function logBoot(): void {
  const version = versionLabel();
  const bridge = getBridge();
  const mobile = isMobileLike();
  const client = bridge ? (mobile ? 'mobile client' : 'desktop client') : 'web';
  devEvent('app', 'boot' + (version ? ' v' + version : '') + ' · ' + client + ' · devlog attached', [
    'ua: ' + navigator.userAgent,
    'lang: ' + navigator.language + ' · tz: ' + (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return '?'; } })(),
    'viewport: ' + window.innerWidth + 'x' + window.innerHeight + ' · dpr: ' + (window.devicePixelRatio || 1),
    'href: ' + location.href,
    'bridge: ' + (bridge ? 'window.dfaeLogs' : 'none (session only)'),
    'mode: ' + mode,
    'build: ' + (() => { try { return import.meta.env.DEV ? 'dev' : 'production'; } catch { return '?'; } })(),
  ].join('\n'), 'info');
  devEvent('app', 'devlog mode restored: ' + mode, undefined, 'debug');
}

/** 由 logs.ts 调用一次(在 console / 全局异常包装之后)。 */
export function initDevLog(): void {
  if (inited) return;
  inited = true;
  ui = bindUi();
  installFetch();
  installUiEvents();
  mode = readMode();
  if (ui) setMode(mode, false);
  logBoot();
}
