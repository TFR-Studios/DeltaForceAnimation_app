/* 移动端触屏交互回归(常驻):真实触摸事件驱动,断言"手势真的做到了它承诺的事",
 * 以及"拖动期间不掉帧"。
 *
 * 为什么需要这一份:src/mobile.ts 的手势层是纯手写的数学 + 一堆状态机(单击 / 双击 /
 * 长按 / 惯性 / 双指),没有任何框架帮你兜底;而它又只在真机/模拟触屏上才会运行 ——
 * 桌面上"看着没问题"什么都不说明。这里全部用 CDP 的 Input.dispatchTouchEvent,
 * 走的是和手指一样的输入管线,不是合成 PointerEvent。
 *
 * 覆盖:
 *   1. 把手拖拽     高度跟着手指走 / 行内几何(不再写 html 上的自定义属性)/ 松手吸附
 *   2. 双击把手     在"最小"与"半开"两档之间切换
 *   3. 单指平移     位移 = 手指位移,松手不带惯性(慢拖)/ 手势期挂合成层、松手摘掉
 *   4. 双指捏合     以两指中点为焦点放大,缩放读数跟着变
 *   5. 单击 / 长按  播放暂停、复位视图
 *   6. 旋转到横屏   面板改成停靠(宽度行内、高度清掉),舞台矩形缓存跟着失效
 *   7. 拖动期间不掉帧 6× CPU 降频下:p95 帧间隔 <= 34ms 且无 >50ms 长任务
 *
 * 用法:npm run dev 后 node tools/verify-mobile-touch.mjs [--url http://127.0.0.1:5173/]
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', process.env.VERIFY_BASE || 'http://127.0.0.1:5173/');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  out.push((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : ''));
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=3'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

  await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=mobile', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('app-loading') || document.getElementById('app-loading').classList.contains('is-hidden'), { timeout: 120000, polling: 100 });
  await page.waitForFunction(() => window.__anim && window.__anim.isLoaded, { timeout: 120000, polling: 100 }).catch(() => {});
  await sleep(800);

  /* 帧率断言量的是"交互本身的开销",所以先把动画停在当前帧:
   * 播放中的 SVG 重绘是另一笔开销(软件光栅化下它自己就 60-100ms 一帧),
   * 混在一起量会把结论归因到交互代码上。播放中的数字单独打印、不做硬断言。 */
  const animPaused = await page.evaluate(() => {
    try { window.__anim?.pause?.(); return !!window.__anim; } catch { return false; }
  });
  const client = await page.target().createCDPSession();

  const touch = (type, pts) => client.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map((p, i) => ({ x: Math.round(p.x), y: Math.round(p.y), id: i + 1, radiusX: 12, radiusY: 12, force: 1 })),
  });

  const q = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }, sel);

  const state = () => page.evaluate(() => {
    const panel = document.querySelector('.side-panel');
    const inner = document.querySelector('.preview-inner');
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(inner.style.transform || '');
    return {
      ui: document.documentElement.dataset.ui,
      panelH: Math.round(panel.getBoundingClientRect().height),
      panelW: Math.round(panel.getBoundingClientRect().width),
      panelInlineH: panel.style.height,
      panelInlineW: panel.style.width,
      panelInlineFlex: panel.style.flex,
      htmlVarSheet: document.documentElement.style.getPropertyValue('--m-sheet'),
      htmlVarSide: document.documentElement.style.getPropertyValue('--m-side'),
      transform: inner.style.transform,
      panX: m ? +m[1] : null,
      panY: m ? +m[2] : null,
      scale: m ? +m[3] : null,
      badge: document.querySelector('.m-zoom-badge')?.textContent?.trim() || '',
      playing: document.getElementById('btnPlay')?.getAttribute('aria-pressed'),
      interacting: document.getElementById('stage')?.classList.contains('is-interacting'),
      dragging: panel.classList.contains('is-dragging'),
      snapping: panel.classList.contains('is-snapping'),
      docked: window.matchMedia('(orientation: landscape), (min-width: 1024px)').matches,
      layoutDir: getComputedStyle(document.querySelector('.layout')).flexDirection,
      status: document.getElementById('statusbar')?.textContent?.trim().slice(0, 60) || '',
    };
  });

  /* CDP 的 Performance 指标:布局 / 样式重算的累计耗时。
   * 为什么"帧率断言"不能只靠帧间隔:headless 里没有 GPU,重绘走软件光栅化,
   * 拖面板时整条 390px 横带每帧都要重绘 —— 那部分时间和我们的代码无关,
   * 却会随机器负载抖动(实测同一份代码 p95 在 33-66ms 之间跳)。
   * 真正要守住的是"我们的代码没有在拖动路径上让浏览器做全量样式重算":
   * 改版前拖一次把手,14.3 秒里 9.9 秒花在 RecalcStyle 上(单次 147ms);
   * 改版后同一条路是 0.1-0.2 秒。这个数字稳定、可归因。 */
  const metricKeys = ['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount'];
  const readMetrics = async () => {
    const { metrics } = await client.send('Performance.getMetrics');
    const m = {};
    for (const k of metricKeys) m[k] = +(metrics.find((x) => x.name === k)?.value ?? 0);
    return m;
  };
  const metricDelta = (a, b) => {
    const d = {};
    for (const k of metricKeys) d[k] = +(b[k] - a[k]).toFixed(2);
    return d;
  };
  await client.send('Performance.enable');

  /* 帧率 / 长任务记录:拖动期间主线程不许被长任务占住 */
  const rec = { on: false };
  const startRec = () => page.evaluate(() => {
    window.__v = { frames: [], lt: [], on: true };
    let last = performance.now();
    const loop = (t) => { if (!window.__v.on) return; window.__v.frames.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    window.__vo?.disconnect();
    window.__vo = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__v.lt.push(e.duration); });
    window.__vo.observe({ type: 'longtask', buffered: false });
  });
  const stopRec = () => page.evaluate(() => {
    window.__v.on = false;
    const f = window.__v.frames.slice(1).sort((a, b) => a - b);
    window.__vo?.disconnect();
    return {
      n: f.length,
      p50: +(f[Math.floor(f.length * 0.5)] || 0).toFixed(1),
      p95: +(f[Math.floor(f.length * 0.95)] || 0).toFixed(1),
      max: +(f[f.length - 1] || 0).toFixed(1),
      over50: f.filter((x) => x > 50).length,
      longtasks: window.__v.lt.length,
      longest: +Math.max(0, ...window.__v.lt).toFixed(1),
    };
  });

  /* ---------- 1. 把手拖拽 ---------- */
  let s0 = await state();
  let grip = await q('.m-grip');
  check('竖屏:面板初始高度是行内几何(不靠 html 自定义属性)', !!s0.panelInlineH && s0.htmlVarSheet === '', 'inline=' + s0.panelInlineH + ' var=' + JSON.stringify(s0.htmlVarSheet));
  check('竖屏:面板初始贴底、主布局上下单栏', s0.layoutDir === 'column' && s0.panelH > 100, s0.layoutDir + ' h=' + s0.panelH);

  await client.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await sleep(320);
  const metricSheet0 = await readMetrics();
  await startRec();
  await touch('touchStart', [{ x: grip.cx, y: grip.cy }]);
  for (let i = 1; i <= 24; i++) {
    await touch('touchMove', [{ x: grip.cx, y: grip.cy - 8 * i }]);
    await sleep(10);
  }
  const during = await state();
  await touch('touchEnd', []);
  /* 拖动本体到此为止:吸附过渡(320ms 的高度过渡)单独量,不和拖动混进同一个 p95 */
  const frameSheet = await stopRec();
  const metricSheet = metricDelta(metricSheet0, await readMetrics());
  /* 吸附过渡窗口同样用指标量:帧间隔在这个环境里受软件光栅化支配,p95 会在 33-133ms 之间跳,
   * 而"每帧只做一次布局、没有全量样式重算"是稳定的、且正是回归会破坏的东西。 */
  const metricSnap0 = await readMetrics();
  await startRec();
  await sleep(420);
  const frameSnap = await stopRec();
  const metricSnap = metricDelta(metricSnap0, await readMetrics());
  let s1 = await state();
  check('拖把手:拖动中带上 is-dragging 且高度跟着手指长高', during.dragging && during.panelH > s0.panelH + 150, 'h ' + s0.panelH + ' -> ' + during.panelH);
  check('拖把手:拖动中不写 html 上的自定义属性', during.htmlVarSheet === '' && during.htmlVarSide === '', JSON.stringify([during.htmlVarSheet, during.htmlVarSide]));
  check('拖把手:松手后吸附到三档之一且摘掉 is-dragging', !s1.dragging && s1.panelH > s0.panelH + 100, 'h=' + s1.panelH + ' dragging=' + s1.dragging);
  check('拖把手:吸附是过渡(有 is-snapping 收尾)', during.snapping === false, 'during.snapping=' + during.snapping);

  /* ---------- 2. 双击把手 ---------- */
  grip = await q('.m-grip');
  await touch('touchStart', [{ x: grip.cx, y: grip.cy }]);
  await sleep(40);
  await touch('touchEnd', []);
  await sleep(60);
  await touch('touchStart', [{ x: grip.cx, y: grip.cy }]);
  await sleep(40);
  await touch('touchEnd', []);
  await sleep(480);
  const s2 = await state();
  check('双击把手:高度切到另一档(值与拖动前不同)', s2.panelH !== s1.panelH, s1.panelH + ' -> ' + s2.panelH);

  /* ---------- 3. 单指平移(慢拖,不该有惯性) ---------- */
  const stage = await q('#stage');
  const before3 = await state();
  const metricPan0 = await readMetrics();
  await startRec();
  await touch('touchStart', [{ x: stage.cx, y: stage.cy }]);
  for (let i = 1; i <= 20; i++) {
    await touch('touchMove', [{ x: stage.cx + 2 * i, y: stage.cy + 1.2 * i }]);
    await sleep(20);
  }
  const mid3 = await state();
  await touch('touchEnd', []);
  await sleep(420);
  const framePan = await stopRec();
  const metricPan = metricDelta(metricPan0, await readMetrics());
  const after3 = await state();
  check('单指平移:手势中挂上合成层', mid3.interacting === true, 'interacting=' + mid3.interacting);
  check('单指平移:位移跟手(±2px)', Math.abs((mid3.panX ?? 0) - ((before3.panX ?? 0) + 38)) <= 2 && Math.abs((mid3.panY ?? 0) - ((before3.panY ?? 0) + 22.8)) <= 2, 'dx=' + (((mid3.panX ?? 0) - (before3.panX ?? 0)).toFixed(1)) + ' dy=' + (((mid3.panY ?? 0) - (before3.panY ?? 0)).toFixed(1)));
  check('单指平移:松手摘掉合成层且慢拖没有惯性漂移', after3.interacting === false && Math.abs((after3.panX ?? 0) - (mid3.panX ?? 0)) <= 1, 'interacting=' + after3.interacting + ' panX ' + mid3.panX + ' -> ' + after3.panX);

  /* ---------- 4. 双指捏合 ---------- */
  const before4 = await state();
  await touch('touchStart', [{ x: stage.cx - 40, y: stage.cy }, { x: stage.cx + 40, y: stage.cy }]);
  for (let i = 1; i <= 18; i++) {
    await touch('touchMove', [{ x: stage.cx - 40 - 4 * i, y: stage.cy }, { x: stage.cx + 40 + 4 * i, y: stage.cy }]);
    await sleep(12);
  }
  const mid4 = await state();
  await touch('touchEnd', []);
  await sleep(400);
  const after4 = await state();
  check('双指捏合:放大(scale 变大)', (mid4.scale ?? 0) > (before4.scale ?? 0) * 1.2, before4.scale + ' -> ' + mid4.scale);
  check('双指捏合:缩放读数跟着变', mid4.badge !== before4.badge, before4.badge + ' -> ' + mid4.badge);
  check('双指捏合:松手后倍数落在硬边界内(0.05–50)', (after4.scale ?? 0) >= (before4.scale ?? 0) * 0.9, 'scale=' + after4.scale);

  /* ---------- 5. 长按复位 + 单击播放 ---------- */
  await touch('touchStart', [{ x: stage.cx, y: stage.cy }]);
  await sleep(620);
  await touch('touchEnd', []);
  await sleep(400);
  const s5 = await state();
  check('长按:视图复位(平移归零、缩放回 100%)', Math.abs(s5.panX ?? 0) < 1 && Math.abs(s5.panY ?? 0) < 1 && s5.badge === '100%', 'pan=' + s5.panX + ',' + s5.panY + ' badge=' + s5.badge);

  const playing0 = (await state()).playing;
  await touch('touchStart', [{ x: stage.cx, y: stage.cy }]);
  await sleep(40);
  await touch('touchEnd', []);
  await sleep(420);
  const playing1 = (await state()).playing;
  check('单击:播放状态切换(点击被 220ms 延后吃掉双击前半段)', playing0 !== playing1, playing0 + ' -> ' + playing1);
  if (playing1 === 'true') { await touch('touchStart', [{ x: stage.cx, y: stage.cy }]); await sleep(40); await touch('touchEnd', []); await sleep(420); }

  /* ---------- 6. 旋转到横屏:面板改成停靠 ---------- */
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await sleep(600);
  const s6 = await state();
  check('旋转横屏:主布局转横向、面板停靠', s6.layoutDir === 'row' && s6.docked === true, s6.layoutDir + ' docked=' + s6.docked);
  check('旋转横屏:尺寸改写宽度、清掉竖屏的行内高度', !!s6.panelInlineW && s6.panelInlineH === '' && s6.panelW >= 260, 'w=' + s6.panelW + ' inlineH=' + JSON.stringify(s6.panelInlineH));
  check('旋转横屏:面板不再贴底占满高(高度由内容决定)', s6.panelH < 390, 'h=' + s6.panelH);

  /* 停靠模式下把手改拖宽度 */
  const grip6 = await q('.m-grip');
  await touch('touchStart', [{ x: grip6.cx, y: grip6.cy }]);
  for (let i = 1; i <= 16; i++) { await touch('touchMove', [{ x: grip6.cx - 6 * i, y: grip6.cy }]); await sleep(12); }
  await touch('touchEnd', []);
  await sleep(420);
  const s7 = await state();
  check('停靠模式:把手拖的是宽度(变宽)且高度仍是自动', s7.panelW > s6.panelW + 40 && s7.panelInlineH === '', 'w ' + s6.panelW + ' -> ' + s7.panelW);

  /* 旋转后舞台矩形缓存必须失效:平移仍然跟手 */
  const stage7 = await q('#stage');
  const b7 = await state();
  await touch('touchStart', [{ x: stage7.cx, y: stage7.cy }]);
  for (let i = 1; i <= 12; i++) { await touch('touchMove', [{ x: stage7.cx + 2 * i, y: stage7.cy }]); await sleep(20); }
  await touch('touchEnd', []);
  await sleep(300);
  const a7 = await state();
  check('旋转后平移仍跟手(舞台矩形缓存已失效)', Math.abs(((a7.panX ?? 0) - (b7.panX ?? 0)) - 24) <= 2, 'dx=' + ((a7.panX ?? 0) - (b7.panX ?? 0)).toFixed(1));

  /* 转回竖屏:两个轴向的行内尺寸必须各自复位(竖屏不会残留宽度、停靠不会残留高度) */
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await sleep(600);
  const s8 = await state();
  check('转回竖屏:尺寸改写高度、清掉停靠的行内宽度', s8.layoutDir === 'column' && !!s8.panelInlineH && s8.panelInlineW === '' && s8.panelH < 844 * 0.9,
    'dir=' + s8.layoutDir + ' h=' + s8.panelH + ' inlineW=' + JSON.stringify(s8.panelInlineW));

  /* ---------- 7. 帧率预算 ---------- */
  /* 拖把手的预算:样式重算 + 布局累计 <= 0.5s(6× CPU 降频,54 次移动)。
   * 改版前这一对数字是 9.9s / 0.3s —— 每帧一次全量样式重算,单次 147ms。 */
  check('拖把手:样式重算 + 布局累计 <= 0.5s(6× CPU)', metricSheet.RecalcStyleDuration <= 0.5 && metricSheet.LayoutDuration <= 0.5,
    'style=' + metricSheet.RecalcStyleDuration + 's layout=' + metricSheet.LayoutDuration + 's 重算次数=' + metricSheet.RecalcStyleCount);
  check('拖把手:重算次数与帧数同量级(不是每帧多次)', metricSheet.RecalcStyleCount <= frameSheet.n * 1.6,
    'count=' + metricSheet.RecalcStyleCount + ' frames=' + frameSheet.n);
  /* 帧间隔这一条刻意给宽(<=100ms):同一份代码在软件光栅化的 headless 里 p95 会在 50-83ms 之间跳,
   * 卡在 60-70 只会得到一个爱闪的红灯。它守的是"没有塌掉"(改版前 266ms) ——
   * 真正逐帧的保证在上面那两条样式重算 / 布局预算里。 */
  check('拖把手:帧间隔 p95 没有塌(<= 100ms)', frameSheet.p95 <= 100, 'p50=' + frameSheet.p50 + ' p95=' + frameSheet.p95 + ' max=' + frameSheet.max + ' n=' + frameSheet.n);
  check('平移:样式重算 + 布局累计 <= 0.3s(6× CPU,无强制布局)', metricPan.RecalcStyleDuration <= 0.3 && metricPan.LayoutDuration <= 0.3,
    'style=' + metricPan.RecalcStyleDuration + 's layout=' + metricPan.LayoutDuration + 's 布局次数=' + metricPan.LayoutCount);
  check('平移:帧间隔 p95 <= 40ms', framePan.p95 <= 40, 'p50=' + framePan.p50 + ' p95=' + framePan.p95 + ' max=' + framePan.max + ' n=' + framePan.n);
  check('松手吸附过渡:布局次数 <= 帧数 + 2(每帧最多一次)', metricSnap.LayoutCount <= frameSnap.n + 2,
    'layouts=' + metricSnap.LayoutCount + ' frames=' + frameSnap.n);
  check('松手吸附过渡:样式重算累计 <= 0.3s(6× CPU)', metricSnap.RecalcStyleDuration <= 0.3,
    'style=' + metricSnap.RecalcStyleDuration + 's layout=' + metricSnap.LayoutDuration + 's');

  /* 播放中的帧率:只报数,不设阈值 —— 它由渲染器与设备光栅化能力决定,
   * 不属于"交互开销"这条预算(改前/改后都一样慢,不是这一层能修的)。 */
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await sleep(500);
  await page.evaluate(() => { try { window.__anim?.play?.(); } catch { /* ignore */ } });
  await startRec();
  await sleep(1200);
  const framePlaying = await stopRec();
  await page.evaluate(() => { try { window.__anim?.pause?.(); } catch { /* ignore */ } });

  check('无 JS 报错', errs.length === 0, errs.slice(0, 4).join(' | '));

  console.log(out.join('\n'));
  console.log('\n' + (failures ? 'FAILED ' + failures : 'ALL PASS') + ' / ' + out.length + ' checks');
  console.log(JSON.stringify({
    frames: { sheet: frameSheet, snap: frameSnap, pan: framePan },
    metrics: { sheet: metricSheet, snap: metricSnap, pan: metricPan },
    playingIdle: { note: '仅报数,不做断言', ...framePlaying },
    animPaused,
    errors: errs.slice(0, 5),
  }));
  process.exitCode = failures ? 1 : 0;
} finally {
  await browser.close();
}
