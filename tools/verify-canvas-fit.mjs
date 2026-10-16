/* 画布适配与居中验证:覆盖"比例适配"这件事的完整矩阵。
 * 逐个视口断言:
 *   1. 画布(缩放后的 .preview-inner)中心与舞台中心的偏差 <=1px;
 *   2. contain 档位下画布完整落在舞台可见区内(不裁切、不溢出);
 *   3. 缩放比 = min(舞台宽/动画宽, 舞台高/动画高)(误差 <=0.5%);
 *   4. 画布长宽比 = 动画数据长宽比(不被拉伸);
 *   5. 舞台尺寸与侧栏不互相压塌(舞台宽高都 >0)。
 * 用法:node tools/verify-canvas-fit.mjs [--url http://127.0.0.1:5175/]
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:5175/');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

const out = [];
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; out.push((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : '')); };

const VIEWPORTS = [
  [320, 640, '320 手机'], [390, 844, '390 手机'], [430, 932, '430 手机'],
  [768, 1024, '768 竖屏平板'], [1024, 768, '1024 横屏平板'],
  [1280, 800, '1280 笔记本'], [1600, 1000, '1600 桌面'], [2560, 1440, '2560 大屏'],
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });

const probe = () => {
  const stage = document.querySelector('.preview-stage');
  const inner = document.getElementById('previewInner');
  const canvas = document.querySelector('.preview-canvas');
  const sr = stage.getBoundingClientRect();
  const ir = inner.getBoundingClientRect();
  const m = /scale\(([\d.]+)\)/.exec(inner.style.transform || '');
  const scale = m ? Number(m[1]) : NaN;
  const d = window.__anim && window.__anim.animationData ? window.__anim.animationData : null;
  const cs = getComputedStyle(stage);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  return {
    /* content = 舞台的内容盒(扣掉内边距):适配缩放按它计算,画布必须落在它里面 */
    content: { w: stage.clientWidth - padX, h: stage.clientHeight - padY },
    stage: { w: sr.width, h: sr.height, cx: sr.x + sr.width / 2, cy: sr.y + sr.height / 2 },
    inner: { w: ir.width, h: ir.height, cx: ir.x + ir.width / 2, cy: ir.y + ir.height / 2, x: ir.x, y: ir.y },
    canvasRect: (() => { const r = canvas.getBoundingClientRect(); return { w: r.width, h: r.height }; })(),
    scale,
    data: d ? { w: d.w, h: d.h } : null,
    fit: document.getElementById('selFit').value,
    zoom: document.getElementById('zoomInfo').textContent,
    stageClipped: getComputedStyle(stage).overflow === 'hidden',
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

for (const [w, h, label] of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, isMobile: w < 600, hasTouch: w < 600 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('#app-loading')?.classList.contains('is-hidden'), { timeout: 120000, polling: 250 }).catch(() => errs.push('loading-timeout'));
  await page.waitForFunction(() => window.__anim && window.__anim.isLoaded, { timeout: 120000, polling: 120 }).catch(() => errs.push('anim-timeout'));
  /* 画布尺寸由 ResizeObserver 在布局稳定后重算,等两帧再量 */
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await new Promise((r) => setTimeout(r, 600));
  const s = await page.evaluate(probe);

  check(label + ':无 JS 报错', errs.length === 0, errs.join(' | '));
  const dx = Math.abs(s.inner.cx - s.stage.cx);
  const dy = Math.abs(s.inner.cy - s.stage.cy);
  check(label + ':画布精确居中', dx <= 1 && dy <= 1, 'dx=' + dx.toFixed(2) + ' dy=' + dy.toFixed(2));

  const rawW = s.canvasRect.w / s.scale;
  const rawH = s.canvasRect.h / s.scale;
  const arCanvas = rawW / rawH;
  const arData = s.data ? s.data.w / s.data.h : NaN;
  check(label + ':长宽比与动画数据一致(未拉伸)', Math.abs(arCanvas - arData) < 0.005, arCanvas.toFixed(4) + ' vs ' + arData.toFixed(4));

  const expect = Math.min(s.content.w / s.data.w, s.content.h / s.data.h);
  check(label + ':contain 缩放比正确(按舞台内容盒)', Math.abs(s.scale - expect) / expect < 0.005, s.scale.toFixed(5) + ' vs ' + expect.toFixed(5));

  check(label + ':画布完整落在内容区内(四角仍有留白)', s.inner.w <= s.content.w + 0.5 && s.inner.h <= s.content.h + 0.5,
    'canvas=' + s.inner.w.toFixed(1) + 'x' + s.inner.h.toFixed(1) + ' content=' + s.content.w.toFixed(0) + 'x' + s.content.h.toFixed(0));
  check(label + ':舞台被裁切且无横向溢出', s.stageClipped && s.docOverflow <= 0, 'clip=' + s.stageClipped + ' overflow=' + s.docOverflow);
  await page.close();
}

/* cover / none 两档:只验证"切档后仍居中且缩放比方向正确" */
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__anim && window.__anim.isLoaded, { timeout: 120000, polling: 120 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  for (const [fit, name] of [['cover', '铺满'], ['none', '原始'], ['contain', '包含']]) {
    await page.select('#selFit', fit);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await new Promise((r) => setTimeout(r, 300));
    const s = await page.evaluate(probe);
    const dx = Math.abs(s.inner.cx - s.stage.cx);
    const dy = Math.abs(s.inner.cy - s.stage.cy);
    check('档位「' + name + '」:仍居中', dx <= 1 && dy <= 1, 'dx=' + dx.toFixed(2) + ' dy=' + dy.toFixed(2));
    if (fit === 'cover') {
      const expect = Math.max(s.content.w / s.data.w, s.content.h / s.data.h);
      check('档位「铺满」:缩放比取 max', Math.abs(s.scale - expect) / expect < 0.005, s.scale.toFixed(5) + ' vs ' + expect.toFixed(5));
    }
    if (fit === 'none') check('档位「原始」:缩放比 = 1', Math.abs(s.scale - 1) < 0.001, String(s.scale));
  }
  /* 缩放/平移后仍以画面中心为基准:滚轮放大一次,中心不应偏移 */
  await page.select('#selFit', 'contain');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  const stageBox = await page.evaluate(() => { const r = document.querySelector('.preview-stage').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(stageBox.x, stageBox.y);
  await page.mouse.wheel({ deltaY: -240 });
  await new Promise((r) => setTimeout(r, 300));
  const s2 = await page.evaluate(probe);
  check('滚轮缩放后画布仍居中(以指针为锚点,指针在中心)', Math.abs(s2.inner.cx - s2.stage.cx) <= 1.5 && Math.abs(s2.inner.cy - s2.stage.cy) <= 1.5,
    'dx=' + Math.abs(s2.inner.cx - s2.stage.cx).toFixed(2) + ' dy=' + Math.abs(s2.inner.cy - s2.stage.cy).toFixed(2) + ' zoom=' + s2.zoom);
  await page.close();
}

await browser.close();
console.log(out.join('\n'));
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);
