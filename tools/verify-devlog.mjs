/* ============================================================================
 * 开发者日志回归(常驻,不参与构建):
 *   node tools/verify-devlog.mjs [--url http://127.0.0.1:5174/] [--out release/devlog-verify]
 *
 * 覆盖「日志」页新增的开发者日志视图(终端式 CLI,原生英文格式):
 *   · 模式切换:用户日志 / 开发者日志两枚按钮、pane 切换、#logsState 隐藏、
 *     localStorage 键 dfae.ui.logMode.v1 与刷新后的持久化;
 *   · 终端骨架:标题 / 本次会话 / 中文控制按钮 / 5 个等级芯片 / 命令行 /
 *     #devLogCmd 输入框 / 空状态;
 *   · 采集(自动生效,切换视图之前就开始):console.debug/log/info/warn/error、
 *     对象参数 JSON、Error 堆栈详情、fetch 产生 source=net、页面切换产生 source=ui;
 *   · 行结构与等级筛选芯片(计数恒为全量);
 *   · CLI 命令:help / version / count / level / filter / grep / /text / follow /
 *     copy / save / download / mode / clear / exit、未知命令 .is-err、↑↓ 历史、Esc 清输入;
 *   · 导出文本:COPY 与 SAVE 共用头部 DFAE DEV LOG · SESSION EXPORT、
 *     exported 第二行、entries=... 第三行、[HH:MM:SS.mmm] LEVEL source message 行、
 *     detail 前 4 空格缩进;桌面桥 exportText 的调用与落盘路径提示;
 *   · 桌面 1480x940 与手机 390x844(?ui=mobile + __DFAE_MOBILE__):切换、终端无横向溢出、
 *     #devLogCmd 可输入、截图。
 *
 * 用法与 verify-logs 一致:注入假桥 window.dfaeLogs(append/read/clear/exportText/copyText/
 * reveal/info)+ navigator.clipboard 桩;测试自己造的数据一律带 [TEST] 前缀,
 * 页面报错收集器会跳过这些 console.error —— 它们是被测功能的一部分。
 *
 * 本脚本不碰真实磁盘;实现未完成时可以先 node --check,等实现完成再跑。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:5174/');
const OUT = arg('out', 'release/devlog-verify');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = []; let failures = 0;
const check = (n, ok, extra = '') => { if (!ok) failures++; out.push((ok ? 'PASS ' : 'FAIL ') + n + (extra ? '  -> ' + extra : '')); };
fs.mkdirSync(OUT, { recursive: true });

/* 导出文本契约(见 task-7 / 实现约定):
 *   第 1 行 DFAE DEV LOG · SESSION EXPORT
 *   第 2 行 exported <ISO8601>
 *   第 3 行 entries=<n> level=<filter> text="<text>"
 *   分隔线 ----,之后每行 [HH:MM:SS.mmm] LEVEL source message,detail 每行前 4 空格 */
const EXPO_HEAD = 'DFAE DEV LOG · SESSION EXPORT';
const EXPO_LINE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] (DEBUG|INFO|WARN|ERROR) \S+ .+$/m;
const ISO_LINE = /^exported \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m;
const ENTRIES_LINE = /^entries=\d+ level=\S+ text=".*"$/m;

/* 假桥:形状对齐 electron/preload.cjs 的 window.dfaeLogs;调用都记在 window.__fakeLogs。
 * 用户日志会读两条历史(验证既有功能没被这次改造弄坏),开发者日志只关心 save 导出。 */
const FAKE_EXPORT_PATH = 'C:\\fake\\logs\\devlog-export.log';
const FAKE_LOGS = () => {
  const now = Date.now();
  const history = [
    { id: 'hist-1', t: now - 3600 * 1000, level: 'info', tag: '应用', msg: 'HIST-INFO 上次启动完成,共载入 12 套动画' },
    { id: 'hist-2', t: now - 3500 * 1000, level: 'warn', tag: '导出', msg: 'HIST-WARN 导出目录剩余空间偏低' },
  ];
  const state = window.__fakeLogs = {
    readCalls: 0, readLimits: [],
    appendCalls: 0, appended: [],
    exportCalls: 0, texts: [], exportNames: [],
    clearCalls: 0,
    copyCalls: 0, copied: [],
    revealCalls: 0,
    infoCalls: 0,
  };
  window.dfaeLogs = {
    isDesktop: true,
    read: async (opts) => {
      state.readCalls++;
      state.readLimits.push(opts && opts.limit);
      return { ok: true, records: history.map((r) => ({ ...r })), dir: 'C:\\fake\\logs', file: 'C:\\fake\\logs\\dfae.log' };
    },
    append: async (records) => {
      state.appendCalls++;
      const list = Array.isArray(records) ? records.slice() : [];
      state.appended.push(...list);
      return { ok: true, written: list.length };
    },
    exportText: async (text, defaultName) => {
      state.exportCalls++;
      state.texts.push(String(text));
      state.exportNames.push(String(defaultName || ''));
      return { ok: true, path: 'C:\\fake\\logs\\devlog-export.log' };
    },
    clear: async () => { state.clearCalls++; return { ok: true }; },
    copyText: async (text) => { state.copyCalls++; state.copied.push(String(text)); return true; },
    reveal: async () => { state.revealCalls++; return true; },
    info: async () => { state.infoCalls++; return { dir: 'C:\\fake\\logs', file: 'C:\\fake\\logs\\dfae.log', size: 2048 }; },
  };
};

/* navigator.clipboard 桩:COPY 可能优先走浏览器剪贴板,也可能兜底桌面桥的 copyText,两条都收。 */
const CLIP_STUB = () => {
  window.__clip = [];
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get() {
        return {
          writeText: async (t) => { window.__clip.push(String(t)); return true; },
          readText: async () => '',
        };
      },
    });
  } catch { /* 定义不上就只靠桌面桥 */ }
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'] });

function buildUrl(params) {
  const u = new URL(BASE);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/* 每个场景用独立 browser context:localStorage 互不影响(桌面持久化测试要 reload,
 * 手机场景必须从默认 user 模式开始)。 */
async function newContext() {
  if (typeof browser.createBrowserContext === 'function') return browser.createBrowserContext();
  if (typeof browser.createIncognitoBrowserContext === 'function') return browser.createIncognitoBrowserContext();
  return null;
}

async function openLogs(opts = {}) {
  const context = await newContext();
  const page = context ? await context.newPage() : await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e && e.message).slice(0, 160)));
  page.on('console', (m) => {
    const text = m.text();
    /* [TEST] 是本脚本自己造的日志:开发者日志功能会正常采集它们,不算页面报错。 */
    if (m.type() === 'error' && !text.includes('[TEST]')) errs.push('console: ' + text.slice(0, 160));
  });
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  if (opts.mobile) await page.evaluateOnNewDocument(() => { window.__DFAE_MOBILE__ = true; });
  await page.evaluateOnNewDocument(FAKE_LOGS);
  await page.evaluateOnNewDocument(CLIP_STUB);
  await page.setViewport(opts.viewport);
  await page.goto(buildUrl(opts.mobile ? { view: 'logs', ui: 'mobile' } : { view: 'logs' }), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app-loading');
    return !el || el.classList.contains('is-hidden');
  }, { timeout: 120000, polling: 300 }).catch(() => errs.push('loading-timeout'));
  await sleep(700);
  return { page, context, errs };
}

async function reloadPage(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app-loading');
    return !el || el.classList.contains('is-hidden');
  }, { timeout: 120000, polling: 300 }).catch(() => {});
  await sleep(800);
}

const waitFor = (page, fn, fnArgs = [], timeout = 8000) =>
  page.waitForFunction(fn, { timeout, polling: 100 }, ...fnArgs).then(() => true).catch(() => false);

/* ---------- 读页面状态 ---------- */

/* 终端行:数据行(.dev-row[data-level] 内含 .dev-head 的四个字段 + 可选 .dev-detail)、
 * 本地命令行(.is-cmd/.is-out/.is-err > .dev-local;前缀由 CSS 或文本给出)。 */
const readDevRows = (page) => page.evaluate(() => {
  const trim = (root, sel) => {
    const el = root.querySelector(sel);
    return el ? (el.textContent || '').trim() : '';
  };
  return [...document.querySelectorAll('#devLogList .dev-row')].map((el) => {
    const local = el.querySelector('.dev-local');
    let before = '';
    let pad = '';
    if (local) {
      const cs = getComputedStyle(local);
      pad = cs.paddingLeft;
      try { before = getComputedStyle(local, '::before').content || ''; } catch { before = ''; }
    }
    const detail = el.querySelector('.dev-detail');
    return {
      className: String(el.className || ''),
      level: el.getAttribute('data-level') || '',
      text: el.textContent || '',
      isCmd: el.classList.contains('is-cmd'),
      isOut: el.classList.contains('is-out'),
      isErr: el.classList.contains('is-err'),
      time: trim(el, '.dev-time'),
      lvl: trim(el, '.dev-lvl'),
      src: trim(el, '.dev-src'),
      msg: trim(el, '.dev-msg'),
      localText: local ? (local.textContent || '') : '',
      localBefore: before,
      localPad: pad,
      detail: detail ? (detail.textContent || '') : null,
    };
  });
});

const dataRowsOf = (rows) => rows.filter((r) => r.level !== '');

const readDevCounts = (page) => page.evaluate(() => {
  const num = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const digits = String(el.textContent || '').replace(/[^\d]/g, '');
    return digits === '' ? null : Number(digits);
  };
  return {
    all: num('devCountAll'), debug: num('devCountDebug'), info: num('devCountInfo'),
    warn: num('devCountWarn'), error: num('devCountError'),
  };
});

const readDevChips = (page) => page.evaluate(() => [...document.querySelectorAll('#devLogFilters .dev-chip')].map((b) => ({
  level: b.getAttribute('data-level') || '',
  active: b.classList.contains('is-active'),
  pressed: b.getAttribute('aria-pressed'),
  visible: b.getClientRects().length > 0 && getComputedStyle(b).display !== 'none',
})));

/* 模式条 / pane / #logsState / localStorage / 溢出 —— 一次取全。 */
const readDevMode = (page) => page.evaluate(() => {
  const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none'
    && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
  const btn = (id) => {
    const el = document.getElementById(id);
    return el ? {
      active: el.classList.contains('is-active'),
      selected: el.getAttribute('aria-selected'),
      visible: vis(el),
      mode: el.getAttribute('data-mode') || '',
    } : null;
  };
  const body = document.getElementById('devLogBody');
  let stored = null;
  try { stored = localStorage.getItem('dfae.ui.logMode.v1'); } catch { stored = null; }
  return {
    userBtn: btn('logsModeUser'),
    devBtn: btn('logsModeDev'),
    modeWrap: vis(document.getElementById('logsMode')),
    userPane: vis(document.getElementById('logsUserPane')),
    devPane: vis(document.getElementById('logsDevPane')),
    stateVisible: vis(document.getElementById('logsState')),
    cmdVisible: vis(document.getElementById('devLogCmd')),
    bodyVisible: vis(body),
    filtersVisible: vis(document.getElementById('devLogFilters')),
    chipsVisible: [...document.querySelectorAll('#devLogFilters .dev-chip')].filter((b) => b.getClientRects().length > 0).length,
    stored,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    termOverflowX: body ? body.scrollWidth - body.clientWidth : 0,
  };
});

const readDevEmpty = (page) => page.evaluate(() => {
  const el = document.getElementById('devLogEmpty');
  const text = document.getElementById('devLogEmptyText');
  return {
    visible: !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0,
    text: text ? (text.textContent || '').trim() : '',
  };
});

const readFilterInfo = (page) => page.evaluate(() => {
  const el = document.getElementById('devLogFilterInfo');
  if (!el) return null;
  return {
    visible: !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0,
    text: (el.textContent || '').trim(),
  };
});

const readChrome = (page) => page.evaluate(() => {
  const vis = (id) => {
    const el = document.getElementById(id);
    return !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  };
  const follow = document.getElementById('devLogFollow');
  const meta = document.getElementById('devLogMeta');
  return {
    meta: meta ? (meta.textContent || '').trim() : '',
    title: ((document.querySelector('.dev-term-title') || {}).textContent || '').trim(),
    hint: ((document.querySelector('.dev-term-hint') || {}).textContent || '').trim(),
    placeholder: (document.getElementById('devLogCmd') || {}).getAttribute ? (document.getElementById('devLogCmd').getAttribute('placeholder') || '') : '',
    followPressed: follow ? follow.getAttribute('aria-pressed') : null,
    buttons: ['devLogFollow', 'devLogCopy', 'devLogDownload', 'devLogClear', 'devLogCmd'].map((id) => ({ id, visible: vis(id) })),
    buttonText: [...document.querySelectorAll('#logsDevPane .dev-term-btn')].map((b) => (b.textContent || '').trim()),
    chipText: [...document.querySelectorAll('#devLogFilters .dev-chip')].map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim()),
    emptyHidden: !vis('devLogEmpty'),
  };
});

const readInput = (page) => page.evaluate(() => (document.getElementById('devLogCmd') || {}).value || '');
const clipped = (page) => page.evaluate(() => (window.__clip || []).slice());
const fakeState = (page) => page.evaluate(() => {
  const s = window.__fakeLogs;
  return {
    readCalls: s.readCalls, appendCalls: s.appendCalls,
    exportCalls: s.exportCalls, texts: s.texts.slice(), exportNames: s.exportNames.slice(),
    clearCalls: s.clearCalls, copyCalls: s.copyCalls, copied: s.copied.slice(),
    revealCalls: s.revealCalls, infoCalls: s.infoCalls,
  };
});

async function press(page, sel) {
  const ok = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);
  if (!ok) throw new Error('找不到控件:' + sel);
}

/* 在终端里执行一条命令:先清空并聚焦输入框,再用真实键盘输入 + Enter(实现监听 keydown)。 */
async function runCmd(page, cmd, wait = 300) {
  const ok = await page.evaluate(() => {
    const el = document.getElementById('devLogCmd');
    if (!el) return false;
    el.value = '';
    el.focus();
    return document.activeElement === el;
  });
  if (!ok) throw new Error('找不到 #devLogCmd 或无法聚焦');
  await page.keyboard.type(cmd);
  await page.keyboard.press('Enter');
  await sleep(wait);
}

/* 取最近一次命令产生的输出行(命令回显之后的 .is-out/.is-err)。 */
function sliceLocal(rows, from) {
  return rows.slice(from);
}
const localTextOf = (rows) => rows.filter((r) => r.isOut || r.isErr).map((r) => r.localText).join('\n');

/* ==================== 桌面(1480x940) ==================== */
{
  const { page, context, errs } = await openLogs({ viewport: { width: 1480, height: 940, deviceScaleFactor: 1 } });

  /* ---------- A. 默认用户视图 + 既有用户日志 ---------- */
  await waitFor(page, () => document.querySelectorAll('#logsList .log-row').length >= 3, [], 12000);
  await sleep(400);
  const userRows = await page.evaluate(() => document.querySelectorAll('#logsList .log-row').length);
  const m0 = await readDevMode(page);
  check('桌面:?view=logs 打开日志页且模式条存在', !!m0.userBtn && !!m0.devBtn && m0.modeWrap, JSON.stringify({ user: !!m0.userBtn, dev: !!m0.devBtn, wrap: m0.modeWrap }));
  check('桌面:默认用户视图(#logsUserPane 可见 / #logsDevPane 隐藏)', m0.userPane && !m0.devPane, JSON.stringify({ user: m0.userPane, dev: m0.devPane }));
  check('桌面:模式条两枚按钮可见', !!(m0.userBtn && m0.userBtn.visible && m0.devBtn && m0.devBtn.visible), JSON.stringify({ user: m0.userBtn, dev: m0.devBtn }));
  check('桌面:既有用户日志仍可用(行数 >= 3)', userRows >= 3, userRows);
  check('桌面:用户视图显示 #logsState', m0.stateVisible, m0.stateVisible);
  check('桌面:默认选中 user 模式(.is-active + aria-selected)', !!m0.userBtn && m0.userBtn.active && m0.userBtn.selected === 'true' && !(m0.devBtn && m0.devBtn.active), JSON.stringify({ active: m0.userBtn && m0.userBtn.active, selected: m0.userBtn && m0.userBtn.selected }));

  /* ---------- B. 切换之前就造采集数据(证明采集自动生效) ---------- */
  await page.evaluate(() => {
    console.debug('[TEST] dbg-marker');
    console.log('[TEST] log-marker');
    console.info('[TEST] info-marker');
    console.warn('[TEST] warn-marker');
    console.error('[TEST] boom', new Error('kaboom'));
    console.log('[TEST] obj', { a: 1, b: 'x' });
  });
  await page.evaluate(() => fetch(location.href).then((r) => r.text()).then((t) => t.length));
  /* 页面切换:日志页 → 编辑器 → 日志页;开发者流里应出现 source=ui 的行。 */
  await page.evaluate(() => document.querySelector('.rail-item[data-page="editor"]').click());
  await sleep(500);
  await page.evaluate(() => document.querySelector('.rail-item[data-page="logs"]').click());
  await sleep(500);

  /* ---------- C. 切到开发者日志 ---------- */
  /* 切换前记一次切换器的位置 / 两格宽度:状态枚在开发者视图隐藏,但不能把切换器推着横移 */
  const modeGeomBefore = await page.evaluate(() => {
    const wrap = document.getElementById('logsMode');
    const user = document.getElementById('logsModeUser');
    const dev = document.getElementById('logsModeDev');
    return {
      x: wrap.getBoundingClientRect().x,
      userW: user.getBoundingClientRect().width,
      devW: dev.getBoundingClientRect().width,
      current: wrap.dataset.current,
      indicator: getComputedStyle(document.querySelector('.logs-mode-indicator')).transform,
    };
  });
  await press(page, '#logsModeDev');
  await sleep(700);
  const m1 = await readDevMode(page);
  check('桌面:切到开发者日志 → pane 切换 + 选中态', m1.devPane && !m1.userPane && !!m1.devBtn && m1.devBtn.active && m1.devBtn.selected === 'true' && !(m1.userBtn && m1.userBtn.active), JSON.stringify({ dev: m1.devPane, user: m1.userPane }));
  check('桌面:开发者视图隐藏 #logsState', !m1.stateVisible, m1.stateVisible);
  check('桌面:localStorage dfae.ui.logMode.v1 记住 dev', !!m1.stored && /dev/i.test(String(m1.stored)), String(m1.stored));

  const modeGeomAfter = await page.evaluate(() => {
    const wrap = document.getElementById('logsMode');
    return {
      x: wrap.getBoundingClientRect().x,
      current: wrap.dataset.current,
      indicator: getComputedStyle(document.querySelector('.logs-mode-indicator')).transform,
      stateHidden: document.getElementById('logsState').hidden,
    };
  });
  check('模式:两格等宽(选中态不改变胶囊宽度)', Math.abs(modeGeomBefore.userW - modeGeomBefore.devW) < 0.5, JSON.stringify({ user: modeGeomBefore.userW, dev: modeGeomBefore.devW }));
  check('模式:隐藏状态枚时切换器不横移', Math.abs(modeGeomAfter.x - modeGeomBefore.x) < 0.5, JSON.stringify({ before: modeGeomBefore.x, after: modeGeomAfter.x }));
  check('模式:指示器滑到第二格(data-current=dev + transform)', modeGeomBefore.current === 'user' && modeGeomAfter.current === 'dev' && modeGeomAfter.stateHidden && modeGeomAfter.indicator !== 'none' && modeGeomAfter.indicator !== modeGeomBefore.indicator, JSON.stringify({ before: modeGeomBefore.indicator, after: modeGeomAfter.indicator }));

  /* ---------- C2. tablist 键盘:←/→ 切换,焦点留在 tab 上 ---------- */
  await page.evaluate(() => document.getElementById('logsModeDev').focus());
  await page.keyboard.press('ArrowLeft');
  await sleep(400);
  const arrowState = await page.evaluate(() => ({
    current: document.getElementById('logsMode').dataset.current,
    active: document.activeElement ? document.activeElement.id : '',
    userPane: !document.getElementById('logsUserPane').hidden,
    userRows: document.querySelectorAll('#logsList .log-row').length,
    userTabIndex: document.getElementById('logsModeUser').getAttribute('tabindex'),
    devTabIndex: document.getElementById('logsModeDev').getAttribute('tabindex'),
  }));
  await page.keyboard.press('ArrowRight');
  await sleep(450);
  const arrowBack = await page.evaluate(() => ({
    current: document.getElementById('logsMode').dataset.current,
    active: document.activeElement ? document.activeElement.id : '',
    devPane: !document.getElementById('logsDevPane').hidden,
  }));
  check('模式:←/→ 切换 + 焦点留在 tab + roving tabindex',
    arrowState.current === 'user' && arrowState.active === 'logsModeUser' && arrowState.userPane && arrowState.userRows >= 3
      && arrowState.userTabIndex === '0' && arrowState.devTabIndex === '-1'
      && arrowBack.current === 'dev' && arrowBack.active === 'logsModeDev' && arrowBack.devPane,
    JSON.stringify({ arrowState, arrowBack }));

  /* ---------- C3. 开发者视图开着时,用户日志不做 DOM 重建 ---------- */
  const hiddenRender = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const list = document.getElementById('logsList');
    let mutations = 0;
    const mo = new MutationObserver((items) => { mutations += items.length; });
    mo.observe(list, { childList: true });
    for (let i = 0; i < 20; i++) console.info('[TEST] hidden-render-probe ' + i);
    await wait(450);
    mo.disconnect();
    return { mutations, rows: list.children.length };
  });
  check('性能:开发者视图下不重画隐藏的用户日志', hiddenRender.mutations === 0, JSON.stringify(hiddenRender));

  /* ---------- D. 终端骨架 ---------- */
  const rowsReady = await waitFor(page, () => document.querySelectorAll('#devLogList .dev-row[data-level]').length > 0, [], 10000);
  const netReady = await waitFor(page, () => [...document.querySelectorAll('#devLogList .dev-src')].some((e) => (e.textContent || '').trim() === 'net'), [], 10000);
  const uiReady = await waitFor(page, () => [...document.querySelectorAll('#devLogList .dev-src')].some((e) => (e.textContent || '').trim() === 'ui'), [], 10000);
  await sleep(300);
  const rows1 = await readDevRows(page);
  const dataRows = dataRowsOf(rows1);
  check('终端:切换过来立刻有切换前采集的日志', rowsReady && dataRows.some((r) => r.msg.includes('[TEST] log-marker')), JSON.stringify({ rows: dataRows.length }));
  const structOk = dataRows.length > 0 && dataRows.every((r) => /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(r.time)
    && ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(r.lvl) && r.src.length > 0);
  check('终端:行结构 .dev-time/.dev-lvl/.dev-src/.dev-msg', structOk, JSON.stringify(dataRows.slice(0, 2)));
  const chrome = await readChrome(page);
  check('终端:标题/本次会话/控制按钮/命令输入可见', chrome.title.includes('开发者日志') && /本次会话/.test(chrome.meta) && chrome.followPressed === 'true' && chrome.buttons.every((b) => b.visible) && m1.bodyVisible && m1.filtersVisible, JSON.stringify(chrome));
  const chineseChrome = JSON.stringify(chrome.buttonText) === JSON.stringify(['跟随最新', '复制', '保存', '清空'])
    && JSON.stringify(chrome.chipText.map((t) => t.replace(/\s*\d+$/, ''))) === JSON.stringify(['全部', '调试', '信息', '警告', '错误'])
    && /输入 help/.test(chrome.placeholder);
  check('终端:控制区按钮/芯片为中文(标题、占位符同为中文)', chineseChrome, JSON.stringify({ buttons: chrome.buttonText, chips: chrome.chipText, placeholder: chrome.placeholder }));
  const chips0 = await readDevChips(page);
  check('终端:5 个等级芯片(all/debug/info/warn/error)可见', JSON.stringify(chips0.map((c) => c.level)) === JSON.stringify(['all', 'debug', 'info', 'warn', 'error']) && chips0.every((c) => c.visible), JSON.stringify(chips0.map((c) => c.level)));
  check('终端:默认选中「全部」芯片', chips0[0].active && chips0[0].pressed === 'true' && chips0.slice(1).every((c) => c.pressed === 'false'), JSON.stringify(chips0));
  const empty0 = await readDevEmpty(page);
  check('终端:有行时空状态隐藏', !empty0.visible && chrome.emptyHidden, JSON.stringify(empty0));

  /* ---------- E. 采集 ---------- */
  const cases = [
    ['debug', '[TEST] dbg-marker', 'debug'],
    ['log', '[TEST] log-marker', 'info'],
    ['info', '[TEST] info-marker', 'info'],
    ['warn', '[TEST] warn-marker', 'warn'],
    ['error', '[TEST] boom', 'error'],
  ];
  for (const [kind, marker, level] of cases) {
    const hit = dataRows.filter((r) => r.msg.includes(marker));
    check('采集:console.' + kind + ' → ' + level.toUpperCase() + ' 行(source 含 console.' + kind + ')',
      hit.length > 0 && hit.every((r) => r.level === level && r.src.includes('console.') && r.src.includes(kind)),
      JSON.stringify(hit.slice(0, 2)));
  }
  const objRow = dataRows.find((r) => r.msg.includes('[TEST] obj'));
  check('采集:对象参数转成 JSON', !!objRow && /"a"\s*:\s*1/.test(objRow.msg) && /"b"\s*:\s*"x"/.test(objRow.msg), objRow ? objRow.msg : 'no-row');
  const errRow = dataRows.find((r) => r.msg.includes('[TEST] boom'));
  check('采集:Error 带堆栈详情(.dev-detail)', !!errRow && errRow.level === 'error' && errRow.detail !== null && /kaboom/.test(errRow.detail) && /(at |Error)/.test(errRow.detail), errRow && errRow.detail ? errRow.detail.slice(0, 120) : 'no-detail');
  const netRows = dataRows.filter((r) => r.src === 'net' || r.src.includes('net'));
  check('采集:fetch 产生 source=net 行', netReady && netRows.length > 0, JSON.stringify({ ready: netReady, rows: netRows.slice(0, 2) }));
  const uiRows = dataRows.filter((r) => r.src === 'ui' || r.src.includes('ui'));
  check('采集:页面切换产生 source=ui 行', uiReady && uiRows.length > 0, JSON.stringify({ ready: uiReady, rows: uiRows.slice(0, 2) }));

  /* ---------- F. 计数与芯片筛选 ---------- */
  const counts0 = await readDevCounts(page);
  const byLevel = (lvl) => dataRows.filter((r) => r.level === lvl).length;
  check('终端:5 个计数与行数一致(恒为全量)', counts0.all === dataRows.length && counts0.debug === byLevel('debug') && counts0.info === byLevel('info') && counts0.warn === byLevel('warn') && counts0.error === byLevel('error'), JSON.stringify({ counts: counts0, rows: { debug: byLevel('debug'), info: byLevel('info'), warn: byLevel('warn'), error: byLevel('error') } }));

  await press(page, '#devLogFilters .dev-chip[data-level="debug"]'); await sleep(350);
  const debugRows = dataRowsOf(await readDevRows(page));
  const chipsDebug = await readDevChips(page);
  check('芯片:DEBUG 只显示 debug 行', debugRows.length > 0 && debugRows.every((r) => r.level === 'debug') && debugRows.some((r) => r.msg.includes('[TEST] dbg-marker')), JSON.stringify(debugRows.map((r) => r.level)));
  const debugChip = chipsDebug.find((c) => c.level === 'debug');
  check('芯片:DEBUG 选中态', !!debugChip && debugChip.active && debugChip.pressed === 'true' && !chipsDebug[0].active, JSON.stringify(chipsDebug));
  const countsAfterChip = await readDevCounts(page);
  check('芯片:筛选不影响计数(恒全量)', JSON.stringify(countsAfterChip) === JSON.stringify(counts0), JSON.stringify({ before: counts0, after: countsAfterChip }));

  await press(page, '#devLogFilters .dev-chip[data-level="error"]'); await sleep(350);
  const errorRows = dataRowsOf(await readDevRows(page));
  check('芯片:ERROR 只显示 error 行', errorRows.length > 0 && errorRows.every((r) => r.level === 'error') && errorRows.some((r) => r.msg.includes('[TEST] boom')), JSON.stringify(errorRows.map((r) => r.level)));

  await press(page, '#devLogFilters .dev-chip[data-level="all"]'); await sleep(350);
  const allRowsChip = dataRowsOf(await readDevRows(page));
  const chipsAll = await readDevChips(page);
  check('芯片:ALL 恢复全部行 + 选中态', allRowsChip.length >= dataRows.length && chipsAll[0].active && chipsAll[0].pressed === 'true', JSON.stringify({ rows: allRowsChip.length, before: dataRows.length }));

  /* ---------- F2. 增量追加:旧行节点不被重建(放在计数断言之后,别干扰全量计数) ---------- */
  const devIncr = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const rows = [...document.querySelectorAll('#devLogList .dev-row[data-level]')];
    const last = rows[rows.length - 1];
    if (!last) return { ok: false };
    last.dataset.probe = 'keep';
    const before = rows.length;
    for (let i = 0; i < 5; i++) console.info('[TEST] dev-incr-marker ' + i);
    await wait(500);
    const kept = document.querySelector('#devLogList .dev-row[data-probe="keep"]');
    return { ok: true, sameNode: kept === last, before, after: document.querySelectorAll('#devLogList .dev-row[data-level]').length };
  });
  check('终端:新行增量追加,旧行节点保留', devIncr.ok && devIncr.sameNode && devIncr.after >= devIncr.before + 5, JSON.stringify(devIncr));

  /* ---------- G. CLI 命令 ---------- */
  /* help */
  const beforeHelp = (await readDevRows(page)).length;
  await runCmd(page, 'help', 500);
  const afterHelp = await readDevRows(page);
  const helpNew = sliceLocal(afterHelp, beforeHelp);
  const helpEcho = helpNew.find((r) => r.isCmd);
  const helpOuts = helpNew.filter((r) => r.isOut);
  const helpText = localTextOf(helpNew);
  check('命令:help 回显 + 输出多行且含 COMMANDS', !!helpEcho && helpEcho.localText.includes('help') && helpOuts.length > 0 && /COMMANDS/i.test(helpText) && (helpOuts.length >= 2 || helpText.split('\n').length >= 2), JSON.stringify({ echo: helpEcho && helpEcho.localText, outs: helpOuts.length, head: helpText.slice(0, 120) }));
  const echoPrefixOk = !!helpEcho && ((helpEcho.localBefore || '').includes('$') || /^\s*\$\s/.test(helpEcho.localText || ''));
  const firstOut = helpOuts[0];
  const outIndentOk = !!firstOut && ((parseFloat(firstOut.localPad || '0') || 0) >= 8 || /^ {2}/.test(firstOut.localText || ''));
  check('命令:回显带 $ 前缀、输出两空格缩进', echoPrefixOk && outIndentOk, JSON.stringify({ before: helpEcho && helpEcho.localBefore, pad: firstOut && firstOut.localPad, text: firstOut && firstOut.localText.slice(0, 40) }));

  /* version */
  const beforeVersion = (await readDevRows(page)).length;
  await runCmd(page, 'version', 400);
  const versionText = localTextOf(sliceLocal(await readDevRows(page), beforeVersion));
  check('命令:version 输出版本号', /\d+\.\d+\.\d+/.test(versionText), versionText.slice(0, 120));

  /* count */
  const beforeCount = (await readDevRows(page)).length;
  await runCmd(page, 'count', 400);
  const countText = localTextOf(sliceLocal(await readDevRows(page), beforeCount));
  check('命令:count 输出计数', /\d+/.test(countText) && /(entries|count|total|lines|records|logs)/i.test(countText), countText.slice(0, 120));

  /* level */
  const countsBeforeLevel = await readDevCounts(page);
  await runCmd(page, 'level error', 450);
  const levelErrRows = dataRowsOf(await readDevRows(page));
  const chipsLevelErr = await readDevChips(page);
  check('命令:level error 只剩 ERROR 行', levelErrRows.length > 0 && levelErrRows.every((r) => r.level === 'error') && levelErrRows.some((r) => r.msg.includes('[TEST] boom')), JSON.stringify(levelErrRows.map((r) => r.level)));
  const errChip = chipsLevelErr.find((c) => c.level === 'error');
  check('命令:level error 同步芯片选中态', !!errChip && errChip.active && errChip.pressed === 'true', JSON.stringify(chipsLevelErr));
  const countsAfterLevel = await readDevCounts(page);
  check('命令:level 过滤不影响计数(恒全量)', JSON.stringify(countsAfterLevel) === JSON.stringify(countsBeforeLevel), JSON.stringify({ before: countsBeforeLevel, after: countsAfterLevel }));

  await runCmd(page, 'level all', 400);
  const levelAllRows = dataRowsOf(await readDevRows(page));
  check('命令:level all 恢复全部行', levelAllRows.length >= dataRows.length, JSON.stringify({ now: levelAllRows.length, before: dataRows.length }));

  /* filter / grep / /text 简写 */
  await runCmd(page, 'filter log-marker', 500);
  const filterRows = dataRowsOf(await readDevRows(page));
  const filterInfo = await readFilterInfo(page);
  check('命令:filter 只剩匹配行', filterRows.length > 0 && filterRows.every((r) => r.text.toLowerCase().includes('log-marker')), JSON.stringify(filterRows.slice(0, 3).map((r) => r.msg)));
  check('命令:filter 显示 #devLogFilterInfo', !!filterInfo && filterInfo.visible && filterInfo.text.toLowerCase().includes('log-marker'), JSON.stringify(filterInfo));
  await runCmd(page, 'filter', 400);
  const filterInfoClear = await readFilterInfo(page);
  const afterFilterClear = dataRowsOf(await readDevRows(page));
  check('命令:filter 无参数清空过滤', !!filterInfoClear && !filterInfoClear.visible && afterFilterClear.length >= dataRows.length, JSON.stringify({ info: filterInfoClear, rows: afterFilterClear.length }));

  await runCmd(page, 'grep obj', 450);
  const grepRows = dataRowsOf(await readDevRows(page));
  check('命令:grep 生效', grepRows.length > 0 && grepRows.every((r) => r.text.includes('obj')), JSON.stringify(grepRows.map((r) => r.msg)));
  await runCmd(page, 'filter', 350);

  await runCmd(page, '/boom', 450);
  const slashRows = dataRowsOf(await readDevRows(page));
  check('命令:/text 简写生效', slashRows.length > 0 && slashRows.every((r) => r.text.includes('boom')), JSON.stringify(slashRows.map((r) => r.msg)));
  await runCmd(page, 'filter', 350);

  /* follow */
  await runCmd(page, 'follow off', 300);
  const followOff = await page.evaluate(() => (document.getElementById('devLogFollow') || {}).getAttribute ? document.getElementById('devLogFollow').getAttribute('aria-pressed') : null);
  await runCmd(page, 'follow on', 300);
  const followOn = await page.evaluate(() => (document.getElementById('devLogFollow') || {}).getAttribute ? document.getElementById('devLogFollow').getAttribute('aria-pressed') : null);
  check('命令:follow off/on 翻转 aria-pressed', followOff === 'false' && followOn === 'true', JSON.stringify({ off: followOff, on: followOn }));
  await press(page, '#devLogFollow'); await sleep(250);
  const followClick = await page.evaluate(() => (document.getElementById('devLogFollow') || {}).getAttribute ? document.getElementById('devLogFollow').getAttribute('aria-pressed') : null);
  check('UI:FOLLOW 按钮点击翻转', followClick === 'false', followClick);
  await press(page, '#devLogFollow'); await sleep(150);

  /* ---------- H. COPY:导出文本格式 ---------- */
  /* 用 msg 里的 boom(而不是只写在 detail 里的 kaboom)做过滤词:不同实现对
   * 过滤是否覆盖 detail 的选择可能不同,但 msg 一定要能搜到。 */
  await runCmd(page, 'filter boom', 500);
  await page.evaluate(() => { window.__clip = []; window.__fakeLogs.copied.length = 0; });
  await runCmd(page, 'copy', 700);
  await waitFor(page, () => (window.__clip || []).length > 0 || window.__fakeLogs.copied.length > 0, [], 6000);
  const clip = await clipped(page);
  const fsCopy = await fakeState(page);
  const copyText = clip[0] || fsCopy.copied[0] || '';
  check('命令:copy 文本以 DFAE DEV LOG · SESSION EXPORT 开头', copyText.startsWith(EXPO_HEAD), JSON.stringify(copyText.split('\n').slice(0, 3)));
  check('命令:copy 含 exported ISO8601 与 entries= 行', ISO_LINE.test(copyText) && ENTRIES_LINE.test(copyText), JSON.stringify(copyText.split('\n').slice(0, 3)));
  check('命令:copy 日志行 [HH:MM:SS.mmm] LEVEL source message', EXPO_LINE.test(copyText) && copyText.includes('kaboom'), JSON.stringify(copyText.split('\n').slice(3, 8)));
  check('命令:copy detail 每行前 4 空格', /^ {4}\S/m.test(copyText), JSON.stringify(copyText.split('\n').filter((l) => l.startsWith('    ')).slice(0, 2)));
  await runCmd(page, 'filter', 350);

  /* UI COPY 按钮 */
  await page.evaluate(() => { window.__clip = []; window.__fakeLogs.copied.length = 0; });
  await press(page, '#devLogCopy');
  await waitFor(page, () => (window.__clip || []).length > 0 || window.__fakeLogs.copied.length > 0, [], 6000);
  const clipBtn = await clipped(page);
  const fsCopyBtn = await fakeState(page);
  const copyBtnText = clipBtn[0] || fsCopyBtn.copied[0] || '';
  check('UI:COPY 按钮同样产出导出文本', copyBtnText.startsWith(EXPO_HEAD), copyBtnText.slice(0, 60));

  /* ---------- I. SAVE / DOWNLOAD:桌面桥 exportText ---------- */
  await page.evaluate(() => { window.__fakeLogs.texts.length = 0; window.__fakeLogs.exportNames.length = 0; });
  await runCmd(page, 'save', 800);
  await waitFor(page, () => window.__fakeLogs.texts.length > 0, [], 6000);
  const fsSave = await fakeState(page);
  const saveText = fsSave.texts[0] || '';
  check('命令:save 调桥 exportText(同一导出格式)', fsSave.exportCalls > 0 && saveText.startsWith(EXPO_HEAD) && EXPO_LINE.test(saveText), JSON.stringify({ calls: fsSave.exportCalls, head: saveText.slice(0, 60) }));
  /* 落盘提示可能出现在终端输出行,也可能复用页面上的提示位:在整个日志页里找。 */
  const pathSeen = await waitFor(page, (p) => {
    const view = document.getElementById('viewLogs');
    return !!view && (view.textContent || '').includes(p);
  }, [FAKE_EXPORT_PATH], 6000);
  check('命令:save 提示包含落盘路径', pathSeen, FAKE_EXPORT_PATH);

  const exportBefore = (await fakeState(page)).exportCalls;
  await runCmd(page, 'download', 800);
  const downloadOk = await waitFor(page, (n) => window.__fakeLogs.exportCalls > n, [exportBefore], 6000);
  check('命令:download 同样触发桥导出', downloadOk, String(exportBefore));

  /* ---------- J. 未知命令 / 历史 / Esc ---------- */
  const beforeUnknown = (await readDevRows(page)).length;
  await runCmd(page, 'zzz-unknown', 450);
  const unknownNew = sliceLocal(await readDevRows(page), beforeUnknown);
  const errOut = unknownNew.filter((r) => r.isErr);
  check('命令:未知命令输出 .is-err', errOut.length > 0 && /zzz-unknown|unknown|invalid|not found/i.test(errOut[errOut.length - 1].localText), JSON.stringify(errOut.map((r) => r.localText)));

  await runCmd(page, 'count', 300);
  await runCmd(page, 'version', 300);
  await page.evaluate(() => { const el = document.getElementById('devLogCmd'); el.value = ''; el.focus(); });
  await page.keyboard.press('ArrowUp'); await sleep(150);
  const hist1 = await readInput(page);
  await page.keyboard.press('ArrowUp'); await sleep(150);
  const hist2 = await readInput(page);
  await page.keyboard.press('ArrowDown'); await sleep(150);
  const hist3 = await readInput(page);
  check('命令:↑/↓ 历史回填', hist1 === 'version' && hist2 === 'count' && hist3 === 'version', JSON.stringify({ up1: hist1, up2: hist2, down: hist3 }));

  await page.evaluate(() => { const el = document.getElementById('devLogCmd'); el.value = ''; el.focus(); });
  await page.keyboard.type('partial-cmd');
  await page.keyboard.press('Escape');
  await sleep(200);
  const escValue = await readInput(page);
  check('命令:Esc 清空输入', escValue === '', JSON.stringify(escValue));

  /* ---------- K. mode 命令 + 持久化 ---------- */
  await runCmd(page, 'mode user', 550);
  const mUser = await readDevMode(page);
  check('命令:mode user 切回用户视图 + localStorage', mUser.userPane && !mUser.devPane && mUser.stateVisible && !!mUser.userBtn && mUser.userBtn.active && /user/i.test(String(mUser.stored || '')), JSON.stringify({ user: mUser.userPane, state: mUser.stateVisible, stored: mUser.stored }));

  await press(page, '#logsModeDev'); await sleep(500);
  const mDevAgain = await readDevMode(page);
  check('模式:点按钮切回开发者日志 + localStorage', mDevAgain.devPane && !mDevAgain.userPane && /dev/i.test(String(mDevAgain.stored || '')), JSON.stringify({ dev: mDevAgain.devPane, stored: mDevAgain.stored }));
  await runCmd(page, 'mode dev', 400);
  const mModeDev = await readDevMode(page);
  check('命令:mode dev 保持开发者视图', mModeDev.devPane && !!mModeDev.devBtn && mModeDev.devBtn.active, JSON.stringify({ dev: mModeDev.devPane, active: mModeDev.devBtn && mModeDev.devBtn.active }));

  /* ---------- L. 截图(清空之前,终端有内容) ---------- */
  await page.screenshot({ path: path.join(OUT, 'verify-desktop-devlog.png') });

  /* ---------- M. clear / exit ---------- */
  const rowsPreClear = await readDevRows(page);
  const dataPreClear = dataRowsOf(rowsPreClear);
  await runCmd(page, 'clear', 700);
  await sleep(250);
  const rowsPostClear = await readDevRows(page);
  const dataPostClear = dataRowsOf(rowsPostClear);
  const cmdPostClear = rowsPostClear.filter((r) => r.isCmd);
  check('命令:clear 清空日志行(测试前有 ' + dataPreClear.length + ' 行)', dataPostClear.length === 0, JSON.stringify({ before: dataPreClear.length, after: dataPostClear.length }));
  check('命令:clear 保留命令回显', cmdPostClear.length >= 1, JSON.stringify(cmdPostClear.map((r) => r.localText).slice(0, 3)));
  const emptyClear = await readDevEmpty(page);
  const countsClear = await readDevCounts(page);
  check('终端:清空后空状态可见 + 计数归零', emptyClear.visible && emptyClear.text.length > 0 && countsClear.all === 0, JSON.stringify({ empty: emptyClear, counts: countsClear }));

  await runCmd(page, 'exit', 600);
  const mExit = await readDevMode(page);
  const exitConsistent = (mExit.userPane && !mExit.devPane && !!mExit.userBtn && mExit.userBtn.active)
    || (mExit.devPane && !mExit.userPane && !!mExit.devBtn && mExit.devBtn.active);
  check('命令:exit 不报错且视图状态一致', exitConsistent, JSON.stringify({ user: mExit.userPane, dev: mExit.devPane }));

  /* 用户模式刷新持久化 */
  if (!(mExit.userPane && !mExit.devPane)) {
    await runCmd(page, 'mode user', 500);
  }
  await reloadPage(page);
  const mUserReload = await readDevMode(page);
  check('模式:刷新后保持用户视图', mUserReload.userPane && !mUserReload.devPane && !!mUserReload.userBtn && mUserReload.userBtn.active && /user/i.test(String(mUserReload.stored || '')), JSON.stringify({ user: mUserReload.userPane, stored: mUserReload.stored }));

  /* 开发者模式刷新持久化 */
  await press(page, '#logsModeDev'); await sleep(500);
  await reloadPage(page);
  const mDevReload = await readDevMode(page);
  check('模式:刷新后保持开发者日志', mDevReload.devPane && !mDevReload.userPane && !!mDevReload.devBtn && mDevReload.devBtn.active && !mDevReload.stateVisible && /dev/i.test(String(mDevReload.stored || '')), JSON.stringify({ dev: mDevReload.devPane, stored: mDevReload.stored, state: mDevReload.stateVisible }));

  /* ---------- N. 稳定性 ---------- */
  const finalMode = await readDevMode(page);
  check('模式:localStorage 键 dfae.ui.logMode.v1 = dev', /dev/i.test(String(finalMode.stored || '')), String(finalMode.stored));
  check('桌面:无横向滚动', finalMode.overflowX <= 0, finalMode.overflowX);
  check('桌面:终端无横向溢出', finalMode.termOverflowX <= 1, finalMode.termOverflowX);
  check('桌面:无 JS 报错(测试用 [TEST] 日志已排除)', errs.length === 0, errs.slice(0, 3).join(' | '));

  if (context) await context.close(); else await page.close();
}

/* ==================== 手机(390x844 + ?ui=mobile) ==================== */
{
  const { page, context, errs } = await openLogs({
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    mobile: true,
  });
  await waitFor(page, () => document.querySelectorAll('#logsList .log-row').length >= 3, [], 12000);
  await sleep(400);
  const m0 = await readDevMode(page);
  check('手机:默认用户视图 + 模式条可见', m0.userPane && !m0.devPane && m0.modeWrap && !!(m0.userBtn && m0.userBtn.visible) && !!(m0.devBtn && m0.devBtn.visible), JSON.stringify({ user: m0.userPane, wrap: m0.modeWrap }));

  await press(page, '#logsModeDev');
  await sleep(800);
  const m = await readDevMode(page);
  check('手机:切到开发者日志 → pane 切换 + 选中态 + #logsState 隐藏', m.devPane && !m.userPane && !!m.devBtn && m.devBtn.active && m.devBtn.selected === 'true' && !m.stateVisible, JSON.stringify({ dev: m.devPane, user: m.userPane, active: m.devBtn && m.devBtn.active, state: m.stateVisible }));
  check('手机:命令输入框/操作按钮/5 芯片可见', m.cmdVisible && m.filtersVisible && m.chipsVisible === 5, JSON.stringify({ cmd: m.cmdVisible, filters: m.filtersVisible, chips: m.chipsVisible }));
  const mobileBtns = await page.evaluate(() => {
    const vis = (id) => {
      const el = document.getElementById(id);
      return !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    };
    return ['devLogFollow', 'devLogCopy', 'devLogDownload', 'devLogClear'].map((id) => ({ id, visible: vis(id) }));
  });
  check('手机:FOLLOW/COPY/SAVE/CLEAR 可见', mobileBtns.every((b) => b.visible), JSON.stringify(mobileBtns));

  await runCmd(page, 'help', 600);
  const helpReady = await waitFor(page, () => {
    const pane = document.getElementById('logsDevPane');
    return !!pane && /COMMANDS/i.test(pane.textContent || '');
  }, [], 6000);
  const m2 = await readDevMode(page);
  check('手机:#devLogCmd 可输入并执行 help(输出 COMMANDS)', helpReady, JSON.stringify({ help: helpReady, input: await readInput(page) }));
  check('手机:终端无横向溢出', m2.termOverflowX <= 1, m2.termOverflowX);
  check('手机:页面无横向滚动', m2.overflowX <= 0, m2.overflowX);
  check('手机:无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  await page.screenshot({ path: path.join(OUT, 'verify-mobile-devlog.png') });
  if (context) await context.close(); else await page.close();
}

await browser.close();
console.log(out.join('\n'));
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);
