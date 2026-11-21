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
 *   · 页面切换(ui => view)与显式 devEvent(anim / export / update / app …);
 *   · 启动环境横幅(env)、长任务与导航耗时(perf)、资源加载失败(res,捕获阶段);
 *   · 内存 / 帧率采样只进环形缓冲,命令按需查看(perf / frames / net),不写入日志流 ——
 *     否则日志页一打开就开始刷屏,还会把真正的错误挤出可视区。
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
  '  env — print the boot environment banner',
  '  gpu — print GPU / WebGL details',
  '  perf — print memory, frame rate and long-task samples',
  '  frames — print the frame rate of the last 5s',
  '  net [n] — print the last n network failures',
  '  sample [on|off] — toggle the 30s memory/frame sampling',
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

export type DevConsoleMethod =
  | 'debug'
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'assert'
  | 'table'
  | 'group'
  | 'groupCollapsed'
  | 'groupEnd';

/** 与浏览器控制台一致的等级映射:assert 只有断言失败时才输出错误,table 是信息,group 只是排版。 */
const CONSOLE_LEVEL: Record<DevConsoleMethod, DevLogLevel> = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  assert: 'error',
  table: 'info',
  group: 'debug',
  groupCollapsed: 'debug',
  groupEnd: 'debug',
};

/** console 包装器调用:保留原始参数,不再经过用户日志的"汇总成一句"格式化。 */
export function devCaptureConsole(method: DevConsoleMethod, args: unknown[]): void {
  /* assert 的条件参数由调用方剥掉(见 logs.ts 的 captureExtraConsole):到这里只剩
   * 浏览器真的会打印的那几个值,与控制台行为保持一致。 */
  const formatted = formatConsoleArgs(args);
  let msg = formatted.msg;
  if (method === 'assert') msg = msg ? 'assertion failed: ' + msg : 'assertion failed';
  else if (method === 'group' || method === 'groupCollapsed') msg = 'group: ' + (msg || '(no label)');
  else if (method === 'groupEnd') msg = 'group end';
  pushEntry(CONSOLE_LEVEL[method], 'console.' + method, msg || '(empty)', formatted.detail);
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
        /* 失败也进环形缓冲:net 命令要能一次看全最近几次断网 / 跨域 / 404,
         * 不必在几千行日志里翻。 */
        recordNetFailure('!!! ' + methodLabel + ' ' + shortUrl + ' · ' + errText(e));
        throw e;
      }
      return response.then(
        (res) => {
          const ms = Math.round(performance.now() - started);
          const level: DevLogLevel = res.ok ? 'debug' : 'warn';
          devEvent('net', '<-- ' + res.status + ' ' + res.statusText + ' ' + shortUrl + ' · ' + ms + 'ms', undefined, level);
          if (!res.ok) recordNetFailure(res.status + ' ' + res.statusText + ' ' + methodLabel + ' ' + shortUrl + ' · ' + ms + 'ms');
          return res;
        },
        (e) => {
          const ms = Math.round(performance.now() - started);
          devEvent('net', '!!! ' + methodLabel + ' ' + shortUrl + ' · ' + errText(e) + ' · ' + ms + 'ms', undefined, 'error');
          recordNetFailure('!!! ' + methodLabel + ' ' + shortUrl + ' · ' + errText(e) + ' · ' + ms + 'ms');
          throw e;
        },
      );
    } as typeof window.fetch;
  } catch {
    fetchInstalled = false;
  }
}

/* ---------------------------------------------------------------------------
 * 环境 / GPU / 能力探测
 * ---------------------------------------------------------------------------
 * 排障时最先要回答的永远是「什么机器、什么内核、什么 GPU、缺哪个 API」。
 * 这些信息散在开发者工具的七八个面板里,而且手机壳里根本看不到;这里一次性
 * 收成可复制的文本:启动时记一条(见 logEnvironment),随时也能用 env / gpu 重打。
 * 全部按需计算,不做轮询 —— 环境不会中途变化,没必要为它花电。
 * ------------------------------------------------------------------------- */

type UaChData = {
  brands?: Array<{ brand: string; version: string }>;
  mobile?: boolean;
  platform?: string;
};

type MemoryInfo = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

type GlInfo = {
  vendor: string;
  renderer: string;
  version: string;
  glsl: string;
  maxTexture: number;
};

const WEBCODECS_APIS = ['VideoEncoder', 'AudioEncoder', 'VideoFrame', 'AudioData'];
const MEDIA_MIMES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

function hasApi(name: string): boolean {
  try {
    return typeof (window as unknown as Record<string, unknown>)[name] !== 'undefined';
  } catch {
    return false;
  }
}

function buildMode(): string {
  try {
    return import.meta.env.DEV ? 'dev' : 'production';
  } catch {
    return '?';
  }
}

/** 渠道:桌面壳 / 手机壳 / 网页版 —— 与 logs.ts 同一套判定(桌面桥 + mobile 标记)。 */
function clientText(): string {
  const bridge = getBridge();
  if (!bridge) return 'web';
  return isMobileLike() ? 'mobile client' : 'desktop client';
}

/** 从 UA 里抠内核版本。Electron 壳的 UA 同时带 Chrome 与 Electron,两个都要:
 *  报 bug 时「Electron 31 + Chromium 126」比单独一个 Chromium 号更有用。 */
function engineText(): string {
  try {
    const ua = navigator.userAgent || '';
    const electron = ua.match(/Electron\/([\d.]+)/);
    const chrome = ua.match(/Chrome\/([\d.]+)/);
    const firefox = ua.match(/Firefox\/([\d.]+)/);
    const safari = ua.match(/Version\/([\d.]+).*Safari/);
    const parts: string[] = [];
    if (electron) parts.push('Electron/' + electron[1]);
    if (chrome) parts.push('Chrome/' + chrome[1]);
    if (firefox) parts.push('Firefox/' + firefox[1]);
    if (!chrome && !firefox && safari) parts.push('Safari/' + safari[1]);
    return parts.join(' · ') || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** UA-CH 的 brands 是结构化客户端提示;它不含真实内核版本(常被 "Not A Brand" 填充),
 *  所以内核版本仍以 UA 为准,这里只补 brands / mobile / platform 三项。 */
function uaChText(): string {
  try {
    const data = (navigator as Navigator & { userAgentData?: UaChData }).userAgentData;
    if (!data) return 'unavailable';
    const brands = (data.brands || []).map((item) => item.brand + '/' + item.version).join(', ');
    return (brands || '(no brands)')
      + ' · mobile=' + (data.mobile === true)
      + (data.platform ? ' · platform=' + data.platform : '');
  } catch {
    return 'unavailable';
  }
}

function screenText(): string {
  try {
    const screen = window.screen;
    if (!screen) return 'unavailable';
    return screen.width + '×' + screen.height
      + ' · avail ' + screen.availWidth + '×' + screen.availHeight
      + ' · dpr ' + (window.devicePixelRatio || 1)
      + ' · depth ' + (screen.colorDepth || 0);
  } catch {
    return 'unavailable';
  }
}

function viewportText(): string {
  try {
    const vv = window.visualViewport;
    const vvText = vv
      ? ' · visualViewport ' + Math.round(vv.width) + '×' + Math.round(vv.height) + ' scale=' + vv.scale.toFixed(2)
      : ' · visualViewport unavailable';
    return window.innerWidth + '×' + window.innerHeight + vvText;
  } catch {
    return 'unavailable';
  }
}

/** CSS env(safe-area-inset-*) 没有 JS 读取接口,只能放一个探针元素量它的 padding:
 *  这是拿到刘海 / 手势条占位的唯一可靠办法(手机端导出被裁切时先看这一项)。 */
function safeAreaText(): string {
  try {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'
      + 'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);'
      + 'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);';
    (document.body || document.documentElement).appendChild(probe);
    const style = getComputedStyle(probe);
    const value = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join(' ');
    probe.remove();
    return value;
  } catch {
    return 'unavailable';
  }
}

function localeText(): string {
  try {
    const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]).join(',');
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '?';
    return 'lang ' + navigator.language + ' · langs ' + langs + ' · tz ' + tz;
  } catch {
    return 'unavailable';
  }
}

function hardwareText(): string {
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const cores = navigator.hardwareConcurrency || 0;
    const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory + 'GB' : 'n/a';
    return 'cores ' + (cores || '?') + ' · deviceMemory ' + memory + ' · platform ' + (navigator.platform || '?');
  } catch {
    return 'unavailable';
  }
}

/** performance.memory 只有 Chromium 系有;拿不到就返回 null,由调用方写 unavailable。 */
function readMemory(): MemoryInfo | null {
  try {
    const memory = (performance as Performance & { memory?: MemoryInfo }).memory;
    if (!memory || typeof memory.usedJSHeapSize !== 'number') return null;
    return memory;
  } catch {
    return null;
  }
}

function mbText(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

function webCodecsText(): string {
  return WEBCODECS_APIS.map((name) => name + '=' + (hasApi(name) ? 'yes' : 'no')).join(' · ');
}

/** isTypeSupported 的结果矩阵:只报是否支持,不真的去构造 MediaRecorder(那会要权限)。 */
function mediaRecorderText(): string {
  try {
    if (typeof MediaRecorder === 'undefined') return 'missing';
    const ok: string[] = [];
    const no: string[] = [];
    for (const mime of MEDIA_MIMES) {
      let supported = false;
      try {
        supported = MediaRecorder.isTypeSupported(mime);
      } catch {
        supported = false;
      }
      (supported ? ok : no).push(mime);
    }
    return 'yes · ok=[' + (ok.join(', ') || '(none)') + '] · no=[' + (no.join(', ') || '(none)') + ']';
  } catch {
    return 'unknown';
  }
}

function captureStreamText(): string {
  try {
    const canvas = document.createElement('canvas');
    return typeof canvas.captureStream === 'function' ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

function readGlInfo(kind: 'webgl' | 'webgl2'): GlInfo | null {
  let context: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    context = (kind === 'webgl2' ? canvas.getContext('webgl2') : canvas.getContext('webgl')) as WebGLRenderingContext | WebGL2RenderingContext | null;
  } catch {
    context = null;
  }
  if (!context) return null;
  /* 先落到 const:下面的 param 是个闭包,TS 不保证闭包执行时 let 仍是非空 */
  const gl = context;
  const param = (pname: number): string => {
    try {
      return String(gl.getParameter(pname) ?? '?');
    } catch {
      return '?';
    }
  };
  const info: GlInfo = {
    vendor: param(gl.VENDOR),
    renderer: param(gl.RENDERER),
    version: param(gl.VERSION),
    glsl: param(gl.SHADING_LANGUAGE_VERSION),
    maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0),
  };
  try {
    /* WEBGL_debug_renderer_info 才能拿到真实 GPU 名(ANGLE 包装后的显卡型号);
     * 部分隐私设置会屏蔽它,那时保留标准 VENDOR/RENDERER,不要写 "?" 让人误判。 */
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info') as
      | { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number }
      | null;
    if (debugInfo) {
      info.vendor = param(debugInfo.UNMASKED_VENDOR_WEBGL);
      info.renderer = param(debugInfo.UNMASKED_RENDERER_WEBGL);
    }
  } catch {
    /* 扩展不可用:保留标准值 */
  }
  try {
    /* 用完立刻释放:环境横幅可能被反复打印,不能每次留下一个 WebGL 上下文 */
    const lose = gl.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null;
    if (lose && typeof lose.loseContext === 'function') lose.loseContext();
  } catch {
    /* 释放失败不影响结果 */
  }
  return info;
}

function gpuText(): string {
  const gl = readGlInfo('webgl');
  const gl2 = readGlInfo('webgl2');
  if (!gl && !gl2) return 'WebGL unavailable';
  const main = gl2 || gl;
  return (main ? main.renderer : '?') + ' · webgl=' + (gl ? 'yes' : 'no') + ' webgl2=' + (gl2 ? 'yes' : 'no');
}

function collectGpuLines(): string[] {
  const lines: string[] = [];
  const gl = readGlInfo('webgl');
  const gl2 = readGlInfo('webgl2');
  lines.push('GPU · webgl=' + (gl ? 'yes' : 'no') + ' · webgl2=' + (gl2 ? 'yes' : 'no'));
  const pairs: Array<[string, GlInfo | null]> = [['webgl', gl], ['webgl2', gl2]];
  for (const [label, info] of pairs) {
    if (!info) {
      lines.push('  ' + label + ': unavailable');
      continue;
    }
    lines.push('  ' + label + ' vendor: ' + clip(info.vendor, 200));
    lines.push('  ' + label + ' renderer: ' + clip(info.renderer, 300));
    lines.push('  ' + label + ' version: ' + clip(info.version, 200));
    lines.push('  ' + label + ' glsl: ' + clip(info.glsl, 160) + ' · maxTexture: ' + info.maxTexture);
  }
  return lines;
}

/** document.fonts 是 FontFaceSet:lib.dom 只声明了 forEach,size 需要自己确认。
 *  字体注册失败会让导出文字换字体,所以 Family 列表要能一眼看到。 */
function fontsText(): string {
  try {
    const fonts = document.fonts as FontFaceSet & { size?: number };
    if (!fonts) return 'unavailable';
    const families = new Set<string>();
    fonts.forEach((face) => {
      const family = String(face.family || '').replace(/^["']|["']$/g, '');
      if (family) families.add(family);
    });
    const list = Array.from(families);
    const shown = list.slice(0, 24).join(', ') || '(none)';
    return 'size ' + (typeof fonts.size === 'number' ? fonts.size : list.length)
      + ' · families ' + shown
      + (list.length > 24 ? ' …(+' + (list.length - 24) + ')' : '');
  } catch {
    return 'unavailable';
  }
}

function storageText(): string {
  try {
    const key = '__dfae_probe__';
    window.localStorage.setItem(key, '1');
    window.localStorage.removeItem(key);
    return 'localStorage=ok';
  } catch {
    return 'localStorage=blocked';
  }
}

/** 环境横幅的明细(多行)。env 命令与启动那条日志共用同一份输出,保证两处口径一致。
 *  gpu 由调用方传进来:探测一次 WebGL 要建两个上下文,标题与明细各算一遍太浪费。 */
function collectEnvLines(gpu: string): string[] {
  const memory = readMemory();
  return [
    'app: ' + (versionLabel() ? 'v' + versionLabel() : 'version unknown') + ' · ' + clientText() + ' · build ' + buildMode(),
    'ua: ' + clip(navigator.userAgent || '?', 400),
    'engine: ' + engineText() + ' · platform ' + (navigator.platform || '?'),
    'ua-ch: ' + uaChText(),
    'screen: ' + screenText(),
    'viewport: ' + viewportText(),
    'safe-area: ' + safeAreaText(),
    'locale: ' + localeText(),
    'hardware: ' + hardwareText(),
    'heap: ' + (memory
      ? mbText(memory.usedJSHeapSize) + ' used · ' + mbText(memory.totalJSHeapSize) + ' total · limit ' + mbText(memory.jsHeapSizeLimit)
      : 'unavailable'),
    'secure: ' + (window.isSecureContext ? 'yes' : 'no') + ' · webcodecs: ' + webCodecsText(),
    'mediarecorder: ' + mediaRecorderText(),
    'captureStream: ' + captureStreamText(),
    'gpu: ' + gpu,
    'fonts: ' + fontsText(),
    'storage: ' + storageText(),
  ];
}

function envSummary(gpu: string): string {
  const parts: string[] = [];
  try {
    parts.push(versionLabel() ? 'v' + versionLabel() : 'v?');
    parts.push(clientText());
    parts.push(engineText());
    if (window.screen) parts.push(window.screen.width + '×' + window.screen.height + '@' + (window.devicePixelRatio || 1));
    parts.push(clip(gpu, 90));
  } catch {
    /* 任意一项失败就保留已经拼好的部分,整条横幅不该因为一个 API 抛错而消失 */
  }
  return parts.join(' · ');
}

/** 导出链路强依赖的能力:缺了就在启动日志里标红,省得用户报「导出没反应」。 */
function missingCapabilities(): string[] {
  const missing: string[] = [];
  try {
    if (!window.isSecureContext) missing.push('isSecureContext=false · WebCodecs / 剪贴板 / 存储访问可能被限制');
    if (!hasApi('VideoEncoder') || !hasApi('VideoFrame')) missing.push('WebCodecs 视频编码缺失(VideoEncoder / VideoFrame)· MP4 / WebM 导出会失败');
    if (!hasApi('AudioEncoder') || !hasApi('AudioData')) missing.push('WebCodecs 音频编码缺失(AudioEncoder / AudioData)· 带音轨的导出会失败');
    if (captureStreamText() !== 'yes') missing.push('canvas.captureStream 缺失 · 逐帧推流录制的兜底路径不可用');
  } catch {
    /* 探测失败就当没缺:宁可少一条警告,也不要让人误判 */
  }
  return missing;
}

/* ---------------------------------------------------------------------------
 * 性能采集:长任务 / 导航耗时 / 内存与帧率采样
 * ---------------------------------------------------------------------------
 * 采样只在日志页可见(或开发者模式下)运行:rAF 回调本身便宜,但 performance.memory
 * 的读取和 30s 定时器在后台页里纯属耗电,手机壳上尤其明显;sample off 可以整体关掉。
 * 采样结果只进环形缓冲,不写进日志流 —— 排障时用 perf / frames 按需看,
 * 否则日志页开着就每 30s 多一行,真正的错误会被挤走。
 * ------------------------------------------------------------------------- */

const SAMPLE_MS = 30000;
const MAX_SAMPLES = 40;
const MAX_NET_FAILURES = 40;
const MAX_LONG_TASKS = 40;
const FRAME_WINDOW_MS = 5000;
const MAX_FRAME_STAMPS = 900;

type MemSample = { t: number; used: number; total: number; limit: number; fps: number };
type NetFailure = { t: number; msg: string };
type LongTask = { t: number; ms: number };
type FrameStats = { fps: number; frames: number; spanMs: number };

const memSamples: MemSample[] = [];
const netFailures: NetFailure[] = [];
const longTasks: LongTask[] = [];
const frameStamps: number[] = [];
let sampleEnabled = true;
let sampleTimer = 0;
let frameRaf = 0;
let hiddenSince = 0;

/** 只有日志页在可见状态时才值得采样;页面切走 / 窗口最小化都立刻停。 */
function samplingAllowed(): boolean {
  try {
    if (document.visibilityState === 'hidden') return false;
    return isLogsPage() || mode === 'dev';
  } catch {
    return false;
  }
}

function pruneFrameStamps(now: number): void {
  while (frameStamps.length > MAX_FRAME_STAMPS) frameStamps.shift();
  /* 留两个窗口:统计按最近 5s,更老的戳没有用处,只会让数组一直涨 */
  while (frameStamps.length && now - frameStamps[0] > FRAME_WINDOW_MS * 2) frameStamps.shift();
}

function onFrame(stamp: number): void {
  frameRaf = 0;
  try {
    frameStamps.push(stamp);
    pruneFrameStamps(stamp);
  } catch {
    /* 采样失败不能影响页面 */
  }
  if (samplingAllowed()) frameRaf = requestAnimationFrame(onFrame);
}

function startFrameLoop(): void {
  if (frameRaf || !samplingAllowed()) return;
  frameRaf = requestAnimationFrame(onFrame);
}

function stopFrameLoop(): void {
  if (!frameRaf) return;
  cancelAnimationFrame(frameRaf);
  frameRaf = 0;
}

/** 最近 windowMs 的粗略帧率:按 rAF 时间戳算,不依赖任何性能 API。 */
function frameStats(windowMs = FRAME_WINDOW_MS): FrameStats {
  try {
    const now = performance.now();
    let start = 0;
    while (start < frameStamps.length && now - frameStamps[start] > windowMs) start += 1;
    const frames = frameStamps.length - start;
    if (frames < 2) return { fps: 0, frames, spanMs: 0 };
    const span = frameStamps[frameStamps.length - 1] - frameStamps[start];
    return { fps: span > 0 ? ((frames - 1) * 1000) / span : 0, frames, spanMs: span };
  } catch {
    return { fps: 0, frames: 0, spanMs: 0 };
  }
}

function takeSample(): void {
  try {
    const memory = readMemory();
    /* 没有 performance.memory(部分 WebView)就不采样:全是 0 的样本比没有更误导 */
    if (!memory) return;
    const stats = frameStats();
    memSamples.push({
      t: Date.now(),
      used: memory.usedJSHeapSize,
      total: memory.totalJSHeapSize,
      limit: memory.jsHeapSizeLimit,
      fps: stats.fps,
    });
    if (memSamples.length > MAX_SAMPLES) memSamples.splice(0, memSamples.length - MAX_SAMPLES);
  } catch {
    /* 采样失败就当这次没采到 */
  }
}

function stopSampleTimer(): void {
  if (!sampleTimer) return;
  window.clearInterval(sampleTimer);
  sampleTimer = 0;
}

function ensureSampleTimer(): void {
  if (!sampleEnabled || !samplingAllowed()) {
    stopSampleTimer();
    return;
  }
  if (sampleTimer) return;
  sampleTimer = window.setInterval(takeSample, SAMPLE_MS);
  /* 先立刻采一次:否则 perf 命令在头 30s 里只能看到 "collecting" */
  takeSample();
}

/** 可见性 / 页面切换 / sample 开关都走这里:统一决定 rAF 与 30s 定时器该不该开。 */
function refreshSampling(): void {
  if (!samplingAllowed()) {
    stopFrameLoop();
    stopSampleTimer();
    return;
  }
  startFrameLoop();
  if (sampleEnabled) ensureSampleTimer();
  else stopSampleTimer();
}

function recordNetFailure(msg: string): void {
  try {
    netFailures.push({ t: Date.now(), msg: clip(msg, 400) });
    if (netFailures.length > MAX_NET_FAILURES) netFailures.splice(0, netFailures.length - MAX_NET_FAILURES);
  } catch {
    /* 诊断缓冲失败无所谓,不能影响网络请求本身 */
  }
}

function ageText(t: number): string {
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return '-' + sec + 's';
  if (sec < 3600) return '-' + Math.floor(sec / 60) + 'm' + (sec % 60) + 's';
  return '-' + Math.floor(sec / 3600) + 'h' + Math.floor((sec % 3600) / 60) + 'm';
}

/** 长任务只报 >50ms 的:再短的抖动在动画编辑器里到处都是,记下来只会淹没真问题。
 *  >200ms 提到 WARN:那种量级已经会让掉帧肉眼可见。 */
function installPerfObservers(): void {
  try {
    if (typeof PerformanceObserver !== 'undefined') {
      const supported = PerformanceObserver.supportedEntryTypes || [];
      if (supported.indexOf('longtask') >= 0) {
        const observer = new PerformanceObserver((list) => {
          try {
            for (const entry of list.getEntries()) {
              if (!(entry.duration > 50)) continue;
              const ms = Math.round(entry.duration);
              longTasks.push({ t: Date.now(), ms });
              if (longTasks.length > MAX_LONG_TASKS) longTasks.splice(0, longTasks.length - MAX_LONG_TASKS);
              devEvent(
                'perf',
                'longtask ' + ms + 'ms',
                'start ' + Math.round(entry.startTime) + 'ms · name ' + (entry.name || 'anonymous'),
                ms >= 200 ? 'warn' : 'debug',
              );
            }
          } catch {
            /* 单条 entry 解析失败不能把观察者打断 */
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      }
    }
  } catch {
    /* 老内核 / 不支持 longtask:静默跳过 */
  }
  /* loadEventEnd 要等 load 事件派发**结束**之后才写进 performance 条目:
   * 在 load 监听器里同步读只会拿到 0,所以再等一个任务(load 之后 initDevLog
   * 可能还没跑,也要补一次)。 */
  if (document.readyState === 'complete') reportNavigationTiming();
  else window.addEventListener('load', () => window.setTimeout(reportNavigationTiming, 0), { once: true });
}

function reportNavigationTiming(): void {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!nav) return;
    const dcl = Math.round(nav.domContentLoadedEventEnd);
    if (!dcl) return;
    const load = Math.round(nav.loadEventEnd || 0);
    devEvent('perf', 'navigation dcl=' + dcl + 'ms load=' + (load > 0 ? load + 'ms' : 'n/a'), [
      'type: ' + (nav.type || '?'),
      'responseEnd: ' + Math.round(nav.responseEnd) + 'ms',
      'domInteractive: ' + Math.round(nav.domInteractive) + 'ms',
      'domContentLoaded: ' + dcl + 'ms',
      'load: ' + (load > 0 ? load + 'ms' : 'n/a'),
      'transferSize: ' + (nav.transferSize || 0) + 'B',
    ].join('\n'), 'info');
  } catch {
    /* 老内核没有 navigation timing:静默跳过 */
  }
}

/** 资源加载失败(img / script / link 的 error 不冒泡,只能在捕获阶段听)。
 *  这类失败不会产生 JS 异常,logs.ts 的异常采集会跳过它,开发者日志必须自己收:
 *  白屏 / 缺图 / 样式没生效时,先看这里有没有 404。 */
function installResourceErrors(): void {
  window.addEventListener('error', (event) => {
    try {
      if (event.message) return; // 真正的 JS 异常交给 logs.ts,避免同一件事记两遍
      const target = event.target as (HTMLElement & { src?: string; href?: string; currentSrc?: string }) | null;
      if (!target || !target.tagName) return;
      const tag = String(target.tagName).toLowerCase();
      const url = String(target.currentSrc || target.src || target.href || '');
      const msg = '<' + tag + '> load failed' + (url ? ' · ' + compactUrl(url) : '');
      devEvent('res', msg, 'tag: ' + tag + '\nurl: ' + (url || '(none)'), 'warn');
      recordNetFailure(msg);
    } catch {
      /* 资源错误采集失败不影响页面 */
    }
  }, true);
}

/** 启动环境横幅:整组只写一条(明细全部塞进 detail),避免一开机就刷屏。 */
function logEnvironment(): void {
  const gpu = gpuText();
  devEvent('env', 'environment · ' + envSummary(gpu), collectEnvLines(gpu).join('\n'), 'info');
  const missing = missingCapabilities();
  if (missing.length) {
    devEvent('env', 'missing capability · ' + missing.length + ' item(s)', missing.map((item) => '- ' + item).join('\n'), 'error');
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

/* ---------------------------------------------------------------------------
 * 诊断命令输出
 * ---------------------------------------------------------------------------
 * 输出走命令行回显区(不只写日志流):这些是一次性快照,不该和业务日志抢位置,
 * 也不该被等级 / 关键词筛选挡住 —— 用户敲 env 就是想立刻看到结果。
 * ------------------------------------------------------------------------- */

function fpsText(stats: FrameStats): string {
  if (stats.frames < 2) return 'collecting';
  return stats.fps.toFixed(1) + ' fps · ' + stats.frames + ' frames / ' + (stats.spanMs / 1000).toFixed(1) + 's';
}

function printEnv(): void {
  const gpu = gpuText();
  addLocal('out', 'ENV · ' + envSummary(gpu));
  for (const line of collectEnvLines(gpu)) addLocal('out', '  ' + line);
}

function printGpu(): void {
  for (const line of collectGpuLines()) addLocal('out', '  ' + line);
}

function printFrames(): void {
  const stats = frameStats();
  if (stats.frames < 2) {
    startFrameLoop();
    addLocal('out', 'frames: collecting… the rAF sampler only runs while the logs page is visible');
    return;
  }
  addLocal('out', 'frames · ' + fpsText(stats));
}

function printPerf(): void {
  const memory = readMemory();
  const stats = frameStats();
  addLocal('out', 'PERF · heap '
    + (memory ? mbText(memory.usedJSHeapSize) + ' / limit ' + mbText(memory.jsHeapSizeLimit) : 'unavailable')
    + ' · fps ' + (stats.frames >= 2 ? stats.fps.toFixed(1) : 'collecting')
    + ' · sample ' + (sampleEnabled ? 'on' : 'off')
    + ' · longtasks ' + longTasks.length);
  /* 采样器还没跑过(刚打开日志页)就先补一个点,别让 perf 只回一行标题 */
  if (!memSamples.length && memory) takeSample();
  for (const sample of memSamples.slice(-8)) {
    addLocal('out', '  ' + ageText(sample.t)
      + ' heap ' + mbText(sample.used) + ' / limit ' + mbText(sample.limit)
      + ' · fps ' + (sample.fps > 0 ? sample.fps.toFixed(1) : 'n/a'));
  }
  if (longTasks.length) {
    for (const task of longTasks.slice(-3)) addLocal('out', '  ' + ageText(task.t) + ' longtask ' + task.ms + 'ms');
  }
}

function printNetFailures(rest: string): void {
  if (!netFailures.length) {
    addLocal('out', 'net: no failures recorded in this session');
    return;
  }
  const asked = Number(rest);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(MAX_NET_FAILURES, Math.floor(asked)) : 10;
  const list = netFailures.slice(-limit);
  addLocal('out', 'NET · ' + netFailures.length + ' failure(s) · showing last ' + list.length);
  for (const failure of list) addLocal('out', '  ' + nativeTime(failure.t) + ' ' + failure.msg);
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
  if (name === 'env') { printEnv(); return; }
  if (name === 'gpu') { printGpu(); return; }
  if (name === 'frames') { printFrames(); return; }
  if (name === 'perf') { printPerf(); return; }
  if (name === 'net') { printNetFailures(rest); return; }
  if (name === 'sample') {
    const value = rest.toLowerCase();
    if (!value) sampleEnabled = !sampleEnabled;
    else if (value === 'on' || value === 'true' || value === '1') sampleEnabled = true;
    else if (value === 'off' || value === 'false' || value === '0') sampleEnabled = false;
    else { addLocal('err', 'usage: sample [on|off]'); return; }
    /* refreshSampling 会按「是否在日志页」决定开不开定时器:off 之后即使切回
     * 日志页也不会自己复活,必须再敲 sample on —— 开关语义要明确。 */
    refreshSampling();
    addLocal('out', 'sample = ' + (sampleEnabled
      ? 'on · every ' + SAMPLE_MS / 1000 + 's while the logs page is visible'
      : 'off · periodic sampling stopped (perf / frames still work)'));
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
  /* 采样是否该跑和视图有关(开发者模式也算「正在看日志」),和有没有绑定到 DOM 无关,
   * 所以放在下面的 ui 判空前:启动阶段 ui 可能还没绑好。 */
  refreshSampling();
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
    /* 离开日志页要停掉 rAF / 定时器,回来再起:只在看日志时才付出这份开销 */
    refreshSampling();
  });
  document.addEventListener('visibilitychange', () => {
    const state = document.visibilityState;
    let suffix = '';
    if (state === 'hidden') {
      hiddenSince = Date.now();
    } else if (hiddenSince) {
      /* 前后台切换是「导出中断」类问题的第一现场:回来时补上离开了多久,
       * 才能判断是切后台被节流、还是导出本身卡住。 */
      suffix = ' · hidden ' + ((Date.now() - hiddenSince) / 1000).toFixed(1) + 's';
      hiddenSince = 0;
    }
    devEvent('ui', 'visibility = ' + state + suffix, undefined, 'debug');
    refreshSampling();
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
    'build: ' + buildMode(),
    'env: type env / gpu / perf / frames / net in the terminal for details',
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
  installResourceErrors();
  installPerfObservers();
  mode = readMode();
  if (ui) setMode(mode, false);
  logBoot();
  /* 环境横幅放在最后:前面的 boot 行已经标好「什么时候、哪个壳」,
   * 这一条只补「什么机器、什么能力」,两行合起来就是一份可直接贴进 issue 的现场。 */
  logEnvironment();
  refreshSampling();
}
