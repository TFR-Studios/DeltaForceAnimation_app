/* 导航轨图标系统回归(常驻,不参与构建):
 *   node tools/verify-rail-icons.mjs [--url http://127.0.0.1:5173/?view=home]
 *
 * 2026-11 的侧边栏图标统一:导航轨全部换成 Lucide 线性图标(24 网格 / 2 单位描边 /
 * 圆头圆角),手机底部标签栏复用同一份 SVG。这个脚本守的是"一种笔画"这件事本身:
 *   1) 每个导航图标都是 24×24 viewBox、fill:none、stroke:currentColor、2px、
 *      round cap / round join —— 混进一枚填充式或 16 网格图标就 FAIL;
 *   2) 图标与文字的间距由 Fluent 按钮的 ::part(content) 接管(展开 10px / 收起 0);
 *   3) 手机端图标在上、文字在下(3px),不再被 Fluent 的默认横排吞掉;
 *   4) 收起态图标仍然落在 56px 轨的中线上。
 * 退出码 0 = 全绿。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:5173/?view=home');
const OUT = arg('out', 'release/rail-icons');
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

/* 下载列表只在有主进程桥接时出现;注入一份最小桥,让桌面导航轨是完整的六格。 */
const FAKE_BRIDGE = () => {
  window.dfaeDownloads = {
    isDesktop: true,
    list: async () => ({ entries: [], promptOnSave: false }),
    reveal: async () => true,
  };
  window.dfaeDesktop = {
    isDesktop: true,
    platform: 'win32',
    getInfo: async () => ({ version: '1.1.3', exportDir: 'C:\\Users\\tester\\Downloads' }),
  };
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'] });

async function openPage(opts) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  if (opts.bridge) await page.evaluateOnNewDocument(FAKE_BRIDGE);
  await page.setViewport(opts.viewport);
  const url = opts.query ? BASE + (BASE.includes('?') ? '&' : '?') + opts.query : BASE;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app-loading');
    return !el || el.classList.contains('is-hidden');
  }, { timeout: 120000, polling: 300 }).catch(() => errs.push('loading-timeout'));
  await sleep(900);
  return { page, errs };
}

const iconProbe = () => [...document.querySelectorAll('.rail .bi')].map((svg) => {
  const cs = getComputedStyle(svg);
  const rect = svg.getBoundingClientRect();
  return {
    owner: svg.closest('.rail-item')?.dataset.page || (svg.closest('.rail-toggle') ? 'toggle' : '?'),
    viewBox: svg.getAttribute('viewBox'),
    fill: cs.fill,
    stroke: cs.stroke,
    color: cs.color,
    strokeWidth: cs.strokeWidth,
    linecap: cs.strokeLinecap,
    linejoin: cs.strokeLinejoin,
    w: Math.round(rect.width),
    h: Math.round(rect.height),
    visible: rect.width > 0 && getComputedStyle(svg).display !== 'none',
  };
});

/* 桌面:展开态 —— 六格、统一笔画、图标与文字 10px、图标落在行中轴 */
{
  const { page, errs } = await openPage({ bridge: true, viewport: { width: 1480, height: 940, deviceScaleFactor: 1 } });
  const items = await page.evaluate(() => [...document.querySelectorAll('.rail-item')]
    .filter((b) => b.getBoundingClientRect().width > 0)
    .map((b) => b.dataset.page));
  check('桌面:导航是主页/编辑器/音频/日志/下载列表/关于六格',
    JSON.stringify(items) === JSON.stringify(['home', 'editor', 'audio', 'logs', 'downloads', 'about']), JSON.stringify(items));

  if (await page.evaluate(() => document.documentElement.dataset.rail === 'collapsed')) {
    await page.click('#railToggle');
    await sleep(500);
  }

  const icons = await page.evaluate(iconProbe);
  const railIcons = icons.filter((i) => i.owner !== 'toggle');
  check('桌面:六枚导航图标 + 收起按钮各有一枚', railIcons.length === 6 && icons.some((i) => i.owner === 'toggle'), JSON.stringify(icons.map((i) => i.owner)));
  const bad = railIcons.filter((i) => i.viewBox !== '0 0 24 24' || i.fill !== 'none' ||
    i.stroke !== i.color || parseFloat(i.strokeWidth) !== 2 || i.linecap !== 'round' || i.linejoin !== 'round');
  check('桌面:全部是 24 网格 / 描边 2 / 圆头圆角 / stroke 跟随当前色', bad.length === 0, JSON.stringify(bad));
  check('桌面:导航图标 16×16、收起图标 13×13', railIcons.every((i) => i.w === 16 && i.h === 16) && icons.find((i) => i.owner === 'toggle')?.w === 13, JSON.stringify(icons.map((i) => [i.owner, i.w, i.h])));

  const gap = await page.evaluate(() => {
    const it = document.querySelector('.rail-item[data-page="home"]');
    const svg = it.querySelector('svg').getBoundingClientRect();
    const span = it.querySelector('span').getBoundingClientRect();
    return Math.round((span.left - svg.right) * 10) / 10;
  });
  check('桌面:展开态图标与文字间距 10px(::part(content) 生效)', Math.abs(gap - 10) <= 0.6, gap + 'px');

  await page.screenshot({ path: path.join(OUT, 'desktop-expanded.png'), clip: await page.evaluate(() => { const r = document.querySelector('.rail').getBoundingClientRect(); return { x: 0, y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; }) });

  /* 收起态:图标落在 56px 轨的中线;文字与图标的间距归零 */
  await page.click('#railToggle');
  await sleep(600);
  const collapsed = await page.evaluate(() => {
    const rail = document.querySelector('.rail').getBoundingClientRect();
    const it = document.querySelector('.rail-item[data-page="home"]');
    const svg = it.querySelector('svg').getBoundingClientRect();
    const span = it.querySelector('span').getBoundingClientRect();
    return {
      railW: Math.round(rail.width),
      railCenter: Math.round(rail.x + rail.width / 2),
      iconCenter: Math.round(svg.x + svg.width / 2),
      gap: Math.round((span.left - svg.right) * 10) / 10,
    };
  });
  check('桌面:收起态轨 56px,图标落在中线上', collapsed.railW === 56 && Math.abs(collapsed.iconCenter - collapsed.railCenter) <= 1, JSON.stringify(collapsed));
  check('桌面:收起态图标与文字间距归零', collapsed.gap === 0, collapsed.gap + 'px');
  await page.screenshot({ path: path.join(OUT, 'desktop-collapsed.png') });
  check('桌面:导航图标改动无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.close();
}

/* 手机:底部标签栏竖排(图标在上、文字在下),尺寸 19px */
{
  /* 必须带 ?ui=mobile:只把视口压到 390px 拿到的是桌面前端(见 DESIGN.md 的 Known deviations)。 */
  const { page, errs } = await openPage({ viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, query: 'ui=mobile' });
  const items = await page.evaluate(() => [...document.querySelectorAll('.rail-item')]
    .filter((b) => b.getBoundingClientRect().width > 0)
    .map((b) => b.dataset.page));
  check('手机:底栏是主页/编辑器/日志/关于四格', JSON.stringify(items) === JSON.stringify(['home', 'editor', 'logs', 'about']), JSON.stringify(items));

  const icons = (await page.evaluate(iconProbe)).filter((i) => i.visible);
  const bad = icons.filter((i) => i.viewBox !== '0 0 24 24' || i.fill !== 'none' ||
    i.stroke !== i.color || parseFloat(i.strokeWidth) !== 2 || i.linecap !== 'round' || i.linejoin !== 'round');
  check('手机:底栏图标与桌面同一套(24 网格 / 描边 2 / 圆头圆角)', bad.length === 0, JSON.stringify(bad));
  check('手机:底栏图标 19×19', icons.length === 4 && icons.every((i) => i.w === 19 && i.h === 19), JSON.stringify(icons.map((i) => [i.owner, i.w, i.h])));

  const stack = await page.evaluate(() => [...document.querySelectorAll('.rail-item')].filter((b) => b.getBoundingClientRect().width > 0).map((it) => {
    const svg = it.querySelector('svg').getBoundingClientRect();
    const span = it.querySelector('span').getBoundingClientRect();
    return { page: it.dataset.page, verticalGap: Math.round((span.top - svg.bottom) * 10) / 10, above: span.top >= svg.bottom - 0.5 };
  }));
  /* 选中格的图标有 translateY(-1px) 的"抬起"反馈,所以竖排间距 3-4px 都算对。 */
  check('手机:图标在上、文字在下(3-4px)', stack.every((s) => s.above && s.verticalGap >= 2.4 && s.verticalGap <= 4.6), JSON.stringify(stack));
  check('手机:底栏图标改动无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.screenshot({ path: path.join(OUT, 'mobile-bar.png'), clip: await page.evaluate(() => { const r = document.querySelector('.rail').getBoundingClientRect(); return { x: 0, y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; }) });
  await page.close();
}

await browser.close();
console.log(out.join('\n'));
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);
