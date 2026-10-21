/* 移动端交互性能探针(开发期辅助,不参与构建)。
 *
 * 为什么需要它:桌面浏览器上"拖动一下"永远是顺的,而手机上是 4-6 倍 CPU、
 * 高 DPR、GPU 光栅化预算只有桌面几分之一 —— 拖动卡顿只能在这里复现。
 * 本脚本用 CDP 派发**真实触摸事件**(不是合成 PointerEvent),在移动端外壳
 * (?ui=mobile + isMobile/hasTouch)下量三类拖动:
 *   pan    —— 单指拖动画布(平移)
 *   pinch  —— 双指捏合(缩放,真正会触发重光栅的那个)
 *   sheet  —— 拖动底部面板把手(改 --m-sheet,牵动整页重排)
 *   scrub  —— 拖动时间轴滑杆(逐帧 seek)
 *
 * 每个场景输出:
 *   frames     每帧间隔(ms)分布 p50/p95/max、>25ms 与 >50ms 的帧数
 *   longtasks  主线程长任务(>50ms)的条数与最长值
 *   metrics    CDP Performance 指标增量:布局 / 样式重算 / 脚本 / 任务耗时,
 *              以及 LayoutCount、RecalcStyleCount —— "卡在哪一层"看这几个数
 *
 * 用法:
 *   node tools/mobile-perf.mjs [--url http://127.0.0.1:5173/] [--cpu 6]
 *                              [--tag before] [--json release/perf/before.json]
 *                              [--anim playing|paused] [--only pan,sheet]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:5173/');
const cpu = Number(arg('cpu', 6));
const tag = arg('tag', 'run');
const jsonOut = arg('json', '');
const animState = arg('anim', 'paused');
const inject = arg('inject', '');
const dpr = Number(arg('dpr', 3));
const renderer = arg('renderer', '');
const only = arg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=' + String(dpr), '--force-color-profile=srgb'],
});

const scenarios = [];
try {
  const page = await browser.newPage();
  /* 390×844 = 主流手机竖屏;DPR 3 是"光栅化最贵"的那一档,卡顿在这里最先现形 */
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
  await page.setCacheEnabled(true);

  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

  const target = url + (url.includes('?') ? '&' : '?') + 'ui=mobile';
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app-loading');
    return !el || el.classList.contains('is-hidden');
  }, { timeout: 120000, polling: 100 }).catch(() => errs.push('loading-timeout'));
  await page.waitForFunction(() => window.__anim && window.__anim.isLoaded, { timeout: 120000, polling: 100 }).catch(() => errs.push('anim-timeout'));
  if (renderer === 'canvas' || renderer === 'svg') {
    const ok = await page.evaluate((v) => {
      const s = document.getElementById('selRenderer');
      if (!s) return false;
      if (s.value === v) return true;
      s.value = v;
      s.dispatchEvent(new Event('change'));
      return true;
    }, renderer);
    if (ok) {
      await sleep(1500);
      await page.waitForFunction(() => window.__anim && window.__anim.isLoaded, { timeout: 120000, polling: 100 }).catch(() => {});
    }
  }
  await sleep(900);

  const client = await page.target().createCDPSession();
  await client.send('Performance.enable');
  await client.send('Emulation.setCPUThrottlingRate', { rate: cpu });

  const uiState = await page.evaluate(() => ({
    ui: document.documentElement.dataset.ui || 'desktop',
    hasTouch: navigator.maxTouchPoints,
    nodes: document.querySelectorAll('*').length,
    svgNodes: document.querySelectorAll('.preview-inner svg *').length,
    canvasEls: document.querySelectorAll('.preview-inner canvas').length,
    renderer: document.getElementById('selRenderer')?.value,
    stage: (() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
    inner: (() => {
      const el = document.querySelector('.preview-inner');
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, transform: el.style.transform, willChange: getComputedStyle(el).willChange, filter: getComputedStyle(el).filter };
    })(),
    grip: (() => { const el = document.querySelector('.m-grip'); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height }; })(),
    panel: (() => { const r = document.querySelector('.side-panel').getBoundingClientRect(); return { y: r.y, h: r.height }; })(),
    timeline: (() => {
      const el = document.querySelector('.timeline input[type=range]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x1: r.x + 12, x2: r.right - 12, y: r.y + r.height / 2 };
    })(),
    backdropFilters: [...document.querySelectorAll('*')].filter((el) => {
      const c = getComputedStyle(el).backdropFilter;
      return c && c !== 'none';
    }).length,
  }));

  if (inject) await page.addStyleTag({ content: inject });

  if (animState === 'paused') {
    await page.evaluate(() => { try { window.__anim?.pause?.(); } catch { /* ignore */ } });
  } else {
    await page.evaluate(() => { try { window.__anim?.play?.(); } catch { /* ignore */ } });
  }

  /* ---- 指标采集:每帧间隔 + 长任务 ---- */
  const startRecord = () => page.evaluate(() => {
    window.__perf = { frames: [], lt: [], t0: performance.now(), on: true };
    let last = performance.now();
    const loop = (t) => {
      if (!window.__perf.on) return;
      window.__perf.frames.push(t - last);
      last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    try {
      window.__obs?.disconnect();
      window.__obs = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__perf.lt.push(e.duration);
      });
      window.__obs.observe({ type: 'longtask', buffered: false });
    } catch { /* ignore */ }
  });

  const stopRecord = () => page.evaluate(() => {
    window.__perf.on = false;
    const f = window.__perf.frames.slice(1).sort((a, b) => a - b);
    const pct = (p) => (f.length ? +f[Math.min(f.length - 1, Math.floor(f.length * p))].toFixed(1) : 0);
    const out = {
      frames: f.length,
      ms: +((performance.now() - window.__perf.t0) / 1).toFixed(0),
      p50: pct(0.5),
      p95: pct(0.95),
      max: +(f[f.length - 1] || 0).toFixed(1),
      over25: f.filter((x) => x > 25).length,
      over50: f.filter((x) => x > 50).length,
      longtasks: window.__perf.lt.length,
      longestTask: +Math.max(0, ...window.__perf.lt).toFixed(1),
    };
    try { window.__obs?.disconnect(); } catch { /* ignore */ }
    return out;
  });

  const metricKeys = ['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount'];
  const readMetrics = async () => {
    const { metrics } = await client.send('Performance.getMetrics');
    const m = {};
    for (const k of metricKeys) m[k] = +(metrics.find((x) => x.name === k)?.value ?? 0);
    return m;
  };

  /* ---- 触摸驱动 ---- */
  const touch = async (type, pts) => client.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map((p, i) => ({ x: Math.round(p.x), y: Math.round(p.y), id: i + 1, radiusX: 12, radiusY: 12, force: 1 })),
  });

  async function run(name, moves, note) {
    if (only.length && !only.includes(name)) return;
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(320);
    const before = await readMetrics();
    await startRecord();
    await moves();
    await sleep(120);
    const after = await readMetrics();
    const rec = await stopRecord();
    const delta = {};
    for (const k of metricKeys) delta[k] = +(after[k] - before[k]).toFixed(1);
    scenarios.push({ name, note, ...rec, metrics: delta });
    console.log(JSON.stringify({ name, p50: rec.p50, p95: rec.p95, over25: rec.over25, over50: rec.over50, longTasks: rec.longtasks, longest: rec.longestTask, layoutMs: delta.LayoutDuration * 1000, styleMs: delta.RecalcStyleDuration * 1000, script: delta.ScriptDuration, layouts: delta.LayoutCount }));
    await sleep(260);
  }

  /* 0) 静止基线:不动手,只让动画自己跑 —— 用来把"动画本身的开销"和
   *    "交互本身的开销"分开。两者混在一起量,结论会一直归因错。 */
  await run('idle', async () => { await sleep(1400); }, 'no input; animation playing');

  const S = uiState.stage;
  const cx = S.x + S.w / 2;
  const cy = S.y + S.h / 2;

  /* 1) 单指拖动平移画布 */
  await run('pan', async () => {
    await touch('touchStart', [{ x: cx - 60, y: cy - 40 }]);
    for (let i = 1; i <= 54; i++) {
      const t = i / 54;
      await touch('touchMove', [{ x: cx - 60 + 120 * t, y: cy - 40 + 56 * t }]);
      await sleep(8);
    }
    await touch('touchEnd', []);
  }, 'single-finger pan on the canvas stage');

  /* 2) 双指捏合(缩放:会触发重光栅) */
  await run('pinch', async () => {
    const y0 = cy;
    await touch('touchStart', [{ x: cx - 45, y: y0 }, { x: cx + 45, y: y0 }]);
    for (let i = 1; i <= 54; i++) {
      const spread = 45 + 60 * (i / 54);
      await touch('touchMove', [{ x: cx - spread, y: y0 }, { x: cx + spread, y: y0 }]);
      await sleep(8);
    }
    await touch('touchEnd', []);
  }, 'two-finger pinch zoom on the canvas stage');

  /* 3) 拖动底部面板把手(改高度变量 → 整页重排) */
  const grip = uiState.grip;
  await run('sheet', async () => {
    await touch('touchStart', [{ x: grip.x, y: grip.y }]);
    for (let i = 1; i <= 54; i++) {
      const t = i / 54;
      await touch('touchMove', [{ x: grip.x, y: grip.y - 180 * t }]);
      await sleep(8);
    }
    await touch('touchEnd', []);
  }, 'drag the bottom sheet grip (panel height)');

  /* 4) 拖时间轴滑杆(逐帧 seek) */
  const tl = uiState.timeline;
  if (tl) {
    await run('scrub', async () => {
      await touch('touchStart', [{ x: tl.x1, y: tl.y }]);
      for (let i = 1; i <= 54; i++) {
        await touch('touchMove', [{ x: tl.x1 + (tl.x2 - tl.x1) * (i / 54), y: tl.y }]);
        await sleep(8);
      }
      await touch('touchEnd', []);
    }, 'drag the timeline scrubber');
  }

  const report = { tag, url, cpu, dpr, renderer: renderer || 'default', anim: animState, uiState, scenarios, errors: errs.slice(0, 10) };
  console.log(JSON.stringify({ summary: report.scenarios.map((s) => ({ name: s.name, p95: s.p95, over50: s.over50, layoutMs: +(s.metrics.LayoutDuration * 1000).toFixed(1) })), errors: report.errors }));
  if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  }
} finally {
  await browser.close();
}
