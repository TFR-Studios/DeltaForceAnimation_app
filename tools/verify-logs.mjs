/* ============================================================================
 * 日志功能回归(常驻,不参与构建):
 *   node tools/verify-logs.mjs [--url http://127.0.0.1:5174/] [--out release/logs-verify]
 *
 * 覆盖 2026-11 这一轮新增的「日志」页:
 *   · 侧边栏 logs 入口 + ?view=logs 深链直接落页;
 *   · 类型筛选(全部/信息/警告/错误/调试)、搜索与清空、跟随最新、刷新;
 *   · console.info / warn / error 的采集与错误计数;
 *   · 复制 / 下载的文本格式(表头 + 毫秒时间戳 + 中文等级 + 标签 + 消息);
 *   · 未读错误徽标(has-error 出现 / 进入日志页后消失);
 *   · 桌面端持久化桥 window.dfaeLogs 的调用契约(读 / 写 / 导出 / 清空 / 定位);
 *   · 手机 ?ui=mobile 版式:筛选与按钮可见、无横向滚动、日志行改纵向排布。
 *
 * 桥是假的:真桥在 electron/preload.cjs,浏览器里没有。这里用 evaluateOnNewDocument
 * 先注入再让页面加载,顺便记录每次调用 —— 本脚本只验证"界面有没有按契约去调",
 * 不碰真实磁盘(所以实现没完成时也可以先做语法检查,等实现完成再跑)。
 *
 * 说明:测试自己用 console.* 造日志,这些消息一律带 [TEST] 前缀,
 * 页面报错收集器会跳过它们 —— 它们是被测功能的一部分,不是页面出错。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:5174/');
const OUT = arg('out', 'release/logs-verify');
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

/* 导出/复制的文本格式契约:表头固定,每行是 [日期 时间.毫秒] [中文等级] [标签] 消息。 */
const EXPORT_HEAD = '三角洲行动动画编辑器 · 日志导出';
const EXPORT_LINE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[(信息|警告|错误|调试)\] \[[^\]\r\n]+\] .+$/m;

/* 假桥:形状对齐 electron/preload.cjs 的 window.dfaeLogs,另外把调用记在 window.__fakeLogs。
 * 历史两条(一条 info 一条 warn),启动日志由页面自己补 —— 合起来应当 ≥ 3 行。 */
const FAKE_LOGS = () => {
  const now = Date.now();
  const history = [
    { id: 'hist-1', t: now - 3600 * 1000, level: 'info', tag: '应用', msg: 'HIST-INFO 上次启动完成,共载入 12 套动画' },
    { id: 'hist-2', t: now - 3500 * 1000, level: 'warn', tag: '导出', msg: 'HIST-WARN 导出目录剩余空间偏低' },
  ];
  const state = window.__fakeLogs = {
    history,
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
      return { ok: true, path: 'C:\\fake\\logs\\dfae-logs.log' };
    },
    clear: async () => { state.clearCalls++; return { ok: true }; },
    copyText: async (text) => { state.copyCalls++; state.copied.push(String(text)); return true; },
    reveal: async () => { state.revealCalls++; return true; },
    info: async () => { state.infoCalls++; return { dir: 'C:\\fake\\logs', file: 'C:\\fake\\logs\\dfae.log', size: 2048 }; },
  };
};

/* navigator.clipboard 桩:实现可能优先走桌面桥的 copyText,也可能走浏览器剪贴板,两条都收。 */
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

async function openLogs(opts = {}) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e && e.message).slice(0, 160)));
  page.on('console', (m) => {
    const text = m.text();
    /* [TEST] 是本脚本自己造的日志,实现本来就会把它们收进日志页,不算页面报错。 */
    if (m.type() === 'error' && !text.includes('[TEST]')) errs.push('console: ' + text.slice(0, 160));
  });
  /* 清空可能弹确认框:一律接受,否则脚本会卡在 dialog 上。 */
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
  return { page, errs };
}

/* 读当前列表里的行(只认契约里的类名)。 */
const readRows = (page) => page.evaluate(() => [...document.querySelectorAll('#logsList .log-row')].map((li) => ({
  level: li.getAttribute('data-level') || '',
  text: li.textContent || '',
  time: ((li.querySelector('.log-time') || {}).textContent || '').trim(),
  lvl: ((li.querySelector('.log-lvl') || {}).textContent || '').trim(),
  tag: ((li.querySelector('.log-tag') || {}).textContent || '').trim(),
  msg: ((li.querySelector('.log-msg') || {}).textContent || '').trim(),
})));

/* 读 5 个计数(数字从文本里抠,兼容 "12" / "全部 12" 这类写法)。 */
const readCounts = (page) => page.evaluate(() => {
  const num = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const digits = String(el.textContent || '').replace(/[^\d]/g, '');
    return digits === '' ? null : Number(digits);
  };
  return {
    all: num('logsCountAll'), info: num('logsCountInfo'), warn: num('logsCountWarn'),
    error: num('logsCountError'), debug: num('logsCountDebug'),
  };
});

const readHint = (page) => page.evaluate(() => {
  const el = document.getElementById('logsHint');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { hidden: !!el.hidden, display: cs.display, visibility: cs.visibility, text: (el.textContent || '').trim() };
});
const hintVisible = (h) => !!h && !h.hidden && h.display !== 'none' && h.visibility !== 'hidden' && h.text.length > 0;

/* 页面整体状态:页面 id / 视图可见性 / 控件是否存在 / 芯片 / 徽标 / 空态 / 横向溢出。 */
const readState = (page) => page.evaluate(() => {
  const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const ids = ['logsFilters', 'logsSearch', 'logsSearchClear', 'logsFollow', 'logsRefresh', 'logsCopy',
    'logsDownload', 'logsReveal', 'logsClear', 'logsHint', 'logsBody', 'logsList', 'logsEmpty', 'logsEmptyText', 'logsFoot'];
  const exists = {};
  for (const id of ids) exists[id] = !!document.getElementById(id);
  const chips = [...document.querySelectorAll('#logsFilters .logs-chip')];
  const follow = document.getElementById('logsFollow');
  const hint = document.getElementById('logsHint');
  return {
    page: document.documentElement.dataset.page || '',
    ui: document.documentElement.dataset.ui || 'desktop',
    viewVisible: vis(document.getElementById('viewLogs')),
    bodyVisible: vis(document.getElementById('logsBody')),
    exists,
    chips: chips.map((b) => b.dataset.level),
    chipsVisible: chips.filter((b) => b.getClientRects().length > 0 && getComputedStyle(b).display !== 'none').length,
    followPressed: follow ? follow.getAttribute('aria-pressed') : null,
    hintAria: hint ? hint.getAttribute('aria-live') : null,
    rows: document.querySelectorAll('#logsList .log-row').length,
    emptyVisible: vis(document.getElementById('logsEmpty')),
    emptyText: ((document.getElementById('logsEmptyText') || {}).textContent || '').trim(),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

const clipped = (page) => page.evaluate(() => (window.__clip || []).slice());
const fakeState = (page) => page.evaluate(() => {
  const s = window.__fakeLogs;
  return {
    readCalls: s.readCalls, readLimits: s.readLimits.slice(),
    appendCalls: s.appendCalls, appendedCount: s.appended.length, lastBatch: s.appended.slice(-5),
    exportCalls: s.exportCalls, texts: s.texts.slice(), exportNames: s.exportNames.slice(),
    clearCalls: s.clearCalls, copyCalls: s.copyCalls, copied: s.copied.slice(),
    revealCalls: s.revealCalls, infoCalls: s.infoCalls,
  };
});

/* 统一的按钮点击:走元素自己的 click(),避免浮层/动画的一帧遮挡让脚本随机失败。 */
async function press(page, sel) {
  const ok = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);
  if (!ok) throw new Error('找不到控件:' + sel);
}

/* ==================== 桌面(1480×940) ==================== */
{
  const { page, errs } = await openLogs({ viewport: { width: 1480, height: 940, deviceScaleFactor: 1 } });

  /* ---------- A. 深链与基础结构 ---------- */
  await page.waitForFunction(() => document.querySelectorAll('#logsList .log-row').length >= 3, { timeout: 15000, polling: 100 }).catch(() => {});
  await sleep(500);
  const s0 = await readState(page);
  const rows0 = await readRows(page);
  check('桌面:?view=logs 直接进日志页', s0.page === 'logs' && s0.viewVisible && s0.bodyVisible, JSON.stringify({ page: s0.page, view: s0.viewVisible, body: s0.bodyVisible }));
  check('桌面:日志页控件 id 契约齐全', Object.values(s0.exists).every(Boolean), JSON.stringify(s0.exists));
  check('桌面:5 个类型筛选按钮 all/info/warn/error/debug', JSON.stringify(s0.chips) === JSON.stringify(['all', 'info', 'warn', 'error', 'debug']), JSON.stringify(s0.chips));
  check('桌面:列表 ≥ 3 行(2 条历史 + 启动日志)', rows0.length >= 3, rows0.length);
  const histInfo = rows0.filter((r) => r.text.includes('HIST-INFO'));
  const histWarn = rows0.filter((r) => r.text.includes('HIST-WARN'));
  check('桌面:读到了假桥的两条历史(info + warn)', histInfo.length === 1 && histInfo[0].level === 'info' && histWarn.length === 1 && histWarn[0].level === 'warn', JSON.stringify({ info: histInfo.length, warn: histWarn.length }));
  const first = await page.evaluate(() => {
    const li = document.querySelector('#logsList .log-row');
    if (!li) return null;
    const q = (sel) => li.querySelector(sel);
    const timeEl = q('time.log-time') || q('.log-time');
    return {
      isLi: li.tagName === 'LI',
      level: li.getAttribute('data-level'),
      meta: !!q('.log-meta'),
      timeTag: timeEl ? timeEl.tagName : '',
      time: timeEl ? (timeEl.textContent || '').trim() : '',
      lvl: q('span.log-lvl') ? (q('span.log-lvl').textContent || '').trim() : '',
      tag: q('span.log-tag') ? (q('span.log-tag').textContent || '').trim() : '',
      main: !!q('.log-main'),
      msg: q('.log-main .log-msg') ? (q('.log-main .log-msg').textContent || '').trim() : '',
    };
  });
  check('桌面:行结构 li.log-row > .log-meta + .log-main(.log-msg)', !!first && first.isLi && !!first.level && first.meta && !!first.time && !!first.lvl && !!first.tag && first.main && !!first.msg, JSON.stringify(first));
  const c0 = await readCounts(page);
  const byLevel = (lvl) => rows0.filter((r) => r.level === lvl).length;
  check('桌面:#logsCountAll 与行数一致', c0.all === rows0.length, JSON.stringify({ count: c0.all, rows: rows0.length }));
  check('桌面:各类型计数与列表一致', c0.info === byLevel('info') && c0.warn === byLevel('warn') && c0.error === byLevel('error') && c0.debug === byLevel('debug'), JSON.stringify({ counts: c0, rows: { info: byLevel('info'), warn: byLevel('warn'), error: byLevel('error'), debug: byLevel('debug') } }));
  check('桌面:有行时空状态隐藏', !s0.emptyVisible, s0.emptyVisible);
  check('桌面:#logsHint 带 aria-live', s0.hintAria !== null && s0.hintAria !== '', String(s0.hintAria));
  const fs0 = await fakeState(page);
  check('持久化:启动时向桥 read() 取历史', fs0.readCalls >= 1, JSON.stringify({ calls: fs0.readCalls, limits: fs0.readLimits }));
  await page.screenshot({ path: path.join(OUT, 'verify-desktop-logs.png') });

  /* ---------- A2. 增量渲染 / 结果条 / 视图切换器(2026-11) ---------- */
  /* 旧行节点应该原样留着:整表重画会把展开的「详情」收起、把选中文字清掉 */
  await page.evaluate(() => {
    const row = document.querySelector('#logsList .log-row');
    if (row) row.dataset.probe = 'keep';
    const det = document.querySelector('#logsList details.log-detail');
    if (det) det.open = true;
  });
  await page.evaluate(() => console.info('[TEST] incremental-marker'));
  const incrOk = await page.waitForFunction(() => {
    const list = document.getElementById('logsList');
    return !!list && (list.textContent || '').includes('incremental-marker');
  }, { timeout: 6000, polling: 100 }).then(() => true).catch(() => false);
  const incrState = await page.evaluate(() => {
    const kept = document.querySelector('#logsList .log-row[data-probe="keep"]');
    const det = document.querySelector('#logsList details.log-detail');
    const fresh = [...document.querySelectorAll('#logsList .log-row.is-new .log-msg')].map((e) => (e.textContent || '').trim());
    return { kept: !!kept, detailsOpen: !!det && det.open, freshIncludesMarker: fresh.some((t) => t.includes('incremental-marker')) };
  });
  check('增量:新日志不重建旧行', incrOk && incrState.kept, JSON.stringify(incrState));
  check('增量:已展开的详情保持展开', incrState.detailsOpen, JSON.stringify(incrState));
  check('增量:新行带 is-new 提示', incrState.freshIncludesMarker, JSON.stringify(incrState));

  /* 结果条绝对定位:出现时不应改变列表的 top / 高度 */
  const shift = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const body = document.getElementById('logsBody');
    const before = body.getBoundingClientRect();
    document.getElementById('logsCopy').click();
    await wait(120);
    const after = body.getBoundingClientRect();
    return { dt: +(after.top - before.top).toFixed(2), dh: +(after.height - before.height).toFixed(2) };
  });
  check('结果条:浮层不推动列表', Math.abs(shift.dt) < 0.5 && Math.abs(shift.dh) < 0.5, JSON.stringify(shift));

  /* 视图切换器:状态枚隐藏时不能把切换器推着横移;两格等宽 */
  const modeGeom = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const wrap = document.getElementById('logsMode');
    const user = document.getElementById('logsModeUser');
    const dev = document.getElementById('logsModeDev');
    const before = { x: wrap.getBoundingClientRect().x, userW: user.getBoundingClientRect().width, devW: dev.getBoundingClientRect().width, current: wrap.dataset.current };
    document.getElementById('logsModeDev').click();
    await wait(350);
    const devState = { x: wrap.getBoundingClientRect().x, current: wrap.dataset.current, transform: getComputedStyle(document.querySelector('.logs-mode-indicator')).transform, stateHidden: document.getElementById('logsState').hidden };
    document.getElementById('logsModeUser').click();
    await wait(350);
    const back = { x: wrap.getBoundingClientRect().x, current: wrap.dataset.current };
    return { before, devState, back };
  });
  check('切换器:两格等宽 + 指示器位置随状态', Math.abs(modeGeom.before.userW - modeGeom.before.devW) < 0.5 && modeGeom.devState.current === 'dev' && modeGeom.back.current === 'user', JSON.stringify(modeGeom));
  check('切换器:状态枚隐藏后切换器不横移', Math.abs(modeGeom.devState.x - modeGeom.before.x) < 0.5 && Math.abs(modeGeom.back.x - modeGeom.before.x) < 0.5, JSON.stringify({ before: modeGeom.before.x, dev: modeGeom.devState.x, back: modeGeom.back.x }));

  /* ---------- D. console 采集(先造出三种等级,后面筛选才有的筛) ---------- */
  const cBefore = await readCounts(page);
  await page.evaluate(() => { console.info('[TEST] info-marker'); console.warn('[TEST] warn-marker'); console.error('[TEST] error-marker'); });
  const captured = await page.waitForFunction(() => {
    const list = document.getElementById('logsList');
    const t = list ? list.textContent || '' : '';
    return t.includes('info-marker') && t.includes('warn-marker') && t.includes('error-marker');
  }, { timeout: 8000, polling: 150 }).then(() => true).catch(() => false);
  await sleep(350);
  const rows1 = await readRows(page);
  const found = (k) => rows1.filter((r) => r.text.includes(k));
  const iR = found('info-marker'), wR = found('warn-marker'), eR = found('error-marker');
  check('采集:console.info → info 行', iR.length > 0 && iR.every((r) => r.level === 'info'), JSON.stringify(iR.slice(0, 2)));
  check('采集:console.warn → warn 行', wR.length > 0 && wR.every((r) => r.level === 'warn'), JSON.stringify(wR.slice(0, 2)));
  check('采集:console.error → error 行', eR.length > 0 && eR.every((r) => r.level === 'error'), JSON.stringify(eR.slice(0, 2)));
  const cAfter = await readCounts(page);
  check('采集:错误计数 +1', captured && cAfter.error === cBefore.error + 1, JSON.stringify({ before: cBefore.error, after: cAfter.error }));
  /* 采集到的日志要按批交给桌面桥(约 300ms 一批);记录字段与 electron/logs.cjs 的契约一致。 */
  const persisted = await page.waitForFunction(() => {
    const s = window.__fakeLogs;
    return s.appendCalls > 0 && s.appended.some((r) => r && String(r.msg || '').includes('info-marker'));
  }, { timeout: 5000, polling: 100 }).then(() => true).catch(() => false);
  const fsAppend = await fakeState(page);
  const shapeOk = fsAppend.lastBatch.every((r) => r && typeof r.id === 'string' && r.id !== ''
    && typeof r.t === 'number' && ['debug', 'info', 'warn', 'error'].includes(r.level)
    && typeof r.tag === 'string' && typeof r.msg === 'string');
  check('持久化:日志按批 append 到桥(字段符合契约)', persisted && shapeOk, JSON.stringify({ calls: fsAppend.appendCalls, records: fsAppend.appendedCount, sample: fsAppend.lastBatch.slice(0, 1) }));

  /* ---------- B. 类型筛选 ---------- */
  await press(page, '#logsFilters .logs-chip[data-level="error"]'); await sleep(400);
  const errRows = await readRows(page);
  const chipState1 = await page.evaluate(() => {
    const m = {};
    for (const b of document.querySelectorAll('#logsFilters .logs-chip')) m[b.dataset.level] = { pressed: b.getAttribute('aria-pressed'), active: b.classList.contains('is-active') };
    return m;
  });
  check('筛选:错误 → 只剩 error 行', errRows.length > 0 && errRows.every((r) => r.level === 'error') && errRows.some((r) => r.text.includes('error-marker')), JSON.stringify(errRows.map((r) => r.level)));
  check('筛选:选中态 aria-pressed="true" + .is-active', !!chipState1.error && chipState1.error.pressed === 'true' && chipState1.error.active && !!chipState1.all && chipState1.all.pressed !== 'true', JSON.stringify(chipState1));
  await press(page, '#logsFilters .logs-chip[data-level="warn"]'); await sleep(400);
  const warnRows = await readRows(page);
  check('筛选:警告 → 只剩 warn 行(含历史警告)', warnRows.length >= 2 && warnRows.every((r) => r.level === 'warn') && warnRows.some((r) => r.text.includes('HIST-WARN')), JSON.stringify(warnRows.map((r) => r.level)));
  await press(page, '#logsFilters .logs-chip[data-level="info"]'); await sleep(400);
  const infoRows = await readRows(page);
  check('筛选:信息 → 只剩 info 行', infoRows.length > 0 && infoRows.every((r) => r.level === 'info'), infoRows.length);
  await press(page, '#logsFilters .logs-chip[data-level="debug"]'); await sleep(400);
  const dbgRows = await readRows(page);
  check('筛选:调试 → 只剩 debug 行(可以为空)', dbgRows.every((r) => r.level === 'debug'), dbgRows.length);
  await press(page, '#logsFilters .logs-chip[data-level="all"]'); await sleep(400);
  const allRows = await readRows(page);
  const chipState2 = await page.evaluate(() => {
    const m = {};
    for (const b of document.querySelectorAll('#logsFilters .logs-chip')) m[b.dataset.level] = { pressed: b.getAttribute('aria-pressed'), active: b.classList.contains('is-active') };
    return m;
  });
  check('筛选:全部 → 行数恢复', allRows.length >= rows1.length, JSON.stringify({ now: allRows.length, before: rows1.length }));
  check('筛选:全部选中态正确', !!chipState2.all && chipState2.all.pressed === 'true' && chipState2.all.active && !!chipState2.error && chipState2.error.pressed !== 'true', JSON.stringify(chipState2));

  /* ---------- C. 搜索 ---------- */
  /* 直接写值再派发 input/change:搜索框可能是包在 Fluent 自定义元素里的原生 input,
   * 键盘输入依赖焦点落在 shadow DOM 内部,回归脚本不该赌这一层。 */
  const typed = await page.evaluate(() => {
    const el = document.getElementById('logsSearch');
    if (!el) return false;
    el.focus();
    el.value = 'HIST-WARN';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === 'HIST-WARN';
  });
  const searchHits = await page.waitForFunction(() => {
    const rows = document.querySelectorAll('#logsList .log-row');
    const list = document.getElementById('logsList');
    return rows.length === 1 && !!list && (list.textContent || '').includes('HIST-WARN');
  }, { timeout: 6000, polling: 100 }).then(() => true).catch(() => false);
  const searched = await readRows(page);
  check('搜索:唯一关键词只剩匹配行', typed && searchHits && searched.length === 1 && searched[0].text.includes('HIST-WARN'), JSON.stringify({ typed, matches: searched.length, msgs: searched.map((r) => r.msg.slice(0, 40)) }));
  await press(page, '#logsSearchClear');
  const restored = await page.waitForFunction((n) => document.querySelectorAll('#logsList .log-row').length >= n, { timeout: 6000, polling: 100 }, allRows.length).then(() => true).catch(() => false);
  const searchVal = await page.evaluate(() => (document.getElementById('logsSearch') || {}).value);
  check('搜索:清空按钮恢复列表与输入框', restored && searchVal === '', JSON.stringify({ restored, value: searchVal }));

  /* ---------- E. 跟随开关 ---------- */
  const f0 = await page.evaluate(() => {
    const el = document.getElementById('logsFollow');
    return el ? { pressed: el.getAttribute('aria-pressed'), visible: el.getClientRects().length > 0 } : null;
  });
  if (f0) await press(page, '#logsFollow');
  await sleep(250);
  const f1 = await page.evaluate(() => {
    const el = document.getElementById('logsFollow');
    return el ? el.getAttribute('aria-pressed') : null;
  });
  if (f0) await press(page, '#logsFollow');
  await sleep(150);
  check('跟随:#logsFollow 有 aria-pressed 且可翻转', !!f0 && f0.pressed !== null && f1 !== null && f1 !== f0.pressed, JSON.stringify({ before: f0 && f0.pressed, after: f1 }));

  /* ---------- F. 复制 ---------- */
  await page.evaluate(() => { window.__clip = []; window.__fakeLogs.copied.length = 0; });
  await press(page, '#logsCopy');
  await page.waitForFunction(() => (window.__clip || []).length > 0 || window.__fakeLogs.copied.length > 0, { timeout: 6000, polling: 100 }).catch(() => {});
  await sleep(300);
  const clip = await clipped(page);
  const fsCopy = await fakeState(page);
  const copyText = clip[0] || fsCopy.copied[0] || '';
  check('复制:拿到导出格式文本(表头)', copyText.startsWith(EXPORT_HEAD), JSON.stringify(copyText.slice(0, 60)));
  check('复制:文本含标准日志行与 info-marker', EXPORT_LINE.test(copyText) && copyText.includes('info-marker'), JSON.stringify(copyText.split('\n').slice(0, 2)));
  const hintCopy = await readHint(page);
  check('复制:#logsHint 给出反馈', hintVisible(hintCopy), JSON.stringify(hintCopy));

  /* ---------- G. 下载 / 打开文件夹 ---------- */
  await page.evaluate(() => { window.__fakeLogs.texts.length = 0; });
  await press(page, '#logsDownload');
  await page.waitForFunction(() => window.__fakeLogs.texts.length > 0, { timeout: 6000, polling: 100 }).catch(() => {});
  await sleep(400);
  const dl = await fakeState(page);
  const dlText = dl.texts[0] || '';
  check('下载:桥 exportText 收到导出文本(表头 + 时间戳行)', dl.exportCalls > 0 && dlText.startsWith(EXPORT_HEAD) && EXPORT_LINE.test(dlText), JSON.stringify({ calls: dl.exportCalls, head: dlText.slice(0, 40) }));
  check('下载:默认文件名是 .log/.txt', /\.(log|txt)$/i.test(dl.exportNames[0] || ''), JSON.stringify(dl.exportNames));
  const hintDl = await readHint(page);
  check('下载:#logsHint 包含保存路径', hintVisible(hintDl) && /dfae-logs\.log/.test(hintDl.text), JSON.stringify(hintDl));
  const revealBefore = (await fakeState(page)).revealCalls;
  await press(page, '#logsReveal');
  await sleep(350);
  const revealAfter = (await fakeState(page)).revealCalls;
  check('打开文件夹:调用了桥 reveal()', revealAfter > revealBefore, JSON.stringify({ before: revealBefore, after: revealAfter }));

  /* ---------- H. 未读错误徽标 ---------- */
  await page.evaluate(() => document.querySelector('.rail-item[data-page="home"]').click());
  await sleep(450);
  const homeNow = await page.evaluate(() => document.documentElement.dataset.page);
  await page.evaluate(() => console.error('[TEST] badge-error'));
  const badgeShown = await page.waitForFunction(() => {
    const b = document.getElementById('navLogs');
    return !!b && b.classList.contains('has-error');
  }, { timeout: 6000, polling: 150 }).then(() => true).catch(() => false);
  check('徽标:主页出现未读错误(#navLogs.has-error)', homeNow === 'home' && badgeShown, JSON.stringify({ page: homeNow, badge: badgeShown }));
  await press(page, '#navLogs');
  const badgeCleared = await page.waitForFunction(() => {
    const b = document.getElementById('navLogs');
    return document.documentElement.dataset.page === 'logs' && !!b && !b.classList.contains('has-error');
  }, { timeout: 6000, polling: 100 }).then(() => true).catch(() => false);
  check('徽标:进入日志页后清除', badgeCleared, badgeCleared);

  /* ---------- I. 刷新 ---------- */
  const readBefore = (await fakeState(page)).readCalls;
  await press(page, '#logsRefresh');
  const refreshed = await page.waitForFunction((n) => window.__fakeLogs.readCalls > n, { timeout: 6000, polling: 100 }, readBefore).then(() => true).catch(() => false);
  check('刷新:重新向桥 read(),不报错', refreshed, JSON.stringify({ before: readBefore, after: (await fakeState(page)).readCalls }));

  /* ---------- J. 清空 ---------- */
  await page.evaluate(() => { window.__fakeLogs.clearCalls = 0; });
  await press(page, '#logsClear');
  const cleared = await page.waitForFunction(() => document.querySelectorAll('#logsList .log-row').length === 0, { timeout: 8000, polling: 100 }).then(() => true).catch(() => false);
  await sleep(400);
  const sClear = await readState(page);
  const cClear = await readCounts(page);
  const fsClear = await fakeState(page);
  check('清空:列表 0 行 + 空状态可见 + 空态文案', cleared && sClear.rows === 0 && sClear.emptyVisible && sClear.emptyText.length > 0, JSON.stringify({ rows: sClear.rows, empty: sClear.emptyVisible, text: sClear.emptyText }));
  check('清空:调用了桥 clear() 且计数归零', fsClear.clearCalls >= 1 && cClear.all === 0, JSON.stringify({ calls: fsClear.clearCalls, all: cClear.all }));
  await page.screenshot({ path: path.join(OUT, 'verify-desktop-logs-empty.png') });

  /* ---------- K. 稳定性 ---------- */
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('桌面:无横向滚动', overflow <= 0, overflow);
  check('桌面:无 JS 报错(测试用 [TEST] 日志已排除)', errs.length === 0, errs.slice(0, 3).join(' | '));

  await page.close();
}

/* ==================== 手机(390×844 + ?ui=mobile) ==================== */
{
  const { page, errs } = await openLogs({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, mobile: true });
  await page.waitForFunction(() => document.querySelectorAll('#logsList .log-row').length >= 3, { timeout: 15000, polling: 100 }).catch(() => {});
  await sleep(500);
  const s = await readState(page);
  check('手机:data-ui=mobile 且深链进日志页', s.ui === 'mobile' && s.page === 'logs' && s.viewVisible, JSON.stringify({ ui: s.ui, page: s.page, view: s.viewVisible }));
  check('手机:列表有行', s.rows >= 3, s.rows);
  check('手机:5 个类型筛选芯片可见', JSON.stringify(s.chips) === JSON.stringify(['all', 'info', 'warn', 'error', 'debug']) && s.chipsVisible === 5, JSON.stringify({ chips: s.chips, visible: s.chipsVisible }));
  const btns = await page.evaluate(() => {
    const ids = ['logsSearch', 'logsRefresh', 'logsCopy', 'logsDownload', 'logsClear'];
    const r = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      const b = el ? el.getBoundingClientRect() : null;
      r[id] = !!el && getComputedStyle(el).display !== 'none' && !!b && b.width > 0 && b.height > 0;
    }
    return r;
  });
  check('手机:搜索/刷新/复制/下载/清空按钮可见', Object.values(btns).every(Boolean), JSON.stringify(btns));
  check('手机:无横向滚动', s.overflowX <= 0, s.overflowX);
  /* 手机版式:meta(时间/等级/标签)与正文不再排在同一行 —— 用 offsetTop / 边界比较。 */
  const layout = await page.evaluate(() => {
    const row = document.querySelector('#logsList .log-row');
    if (!row) return null;
    const meta = row.querySelector('.log-meta');
    const main = row.querySelector('.log-main');
    if (!meta || !main) return null;
    const a = meta.getBoundingClientRect();
    const b = main.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    return {
      metaTop: Math.round(a.top), metaBottom: Math.round(a.bottom), mainTop: Math.round(b.top),
      offsetMeta: meta.offsetTop, offsetMain: main.offsetTop,
      rowW: Math.round(rr.width), innerW: Math.round(document.documentElement.clientWidth),
      sameLine: Math.abs(a.top - b.top) < 4,
    };
  });
  check('手机:日志行改纵向(消息在 meta 下方一行)', !!layout && layout.mainTop >= layout.metaBottom - 1 && !layout.sameLine, JSON.stringify(layout));
  check('手机:行不超出视口宽度', !!layout && layout.rowW <= layout.innerW + 1, JSON.stringify(layout));
  check('手机:无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.screenshot({ path: path.join(OUT, 'verify-mobile-logs.png') });
  await page.close();
}

await browser.close();
console.log(out.join('\n'));
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);
