/* 浮层、窄屏顶栏与手机壳的回归断言(开发期辅助,不参与构建):
 * 注意:这个项目有**两套前端** —— 桌面(src/style.css)与手机(src/mobile.ts + mobile.css,
 * html[data-ui=mobile])。第 1-4 组跑桌面壳(?ui=desktop),第 5 组用 ?ui=mobile + isMobile/hasTouch
 * 跑手机壳;两边的结论不能互相替代。
 * 这一轮修的是三类"只在特定宽度/键盘流里才出现"的问题,肉眼看截图看不出来,
 * 但都能量:
 *   1) 手机宽度下画廊头部的关闭按钮被挤出面板(390px 时整体不可见);
 *   2) 手机宽度下顶栏的主角(动画选择器)被制作声明徽标挤成 124px;
 *   3) 声明了 aria-modal 的浮层里,连续 Tab 会把焦点送到浮层背后(画廊第 10 下就出去了)。
 * 判据与理由写在各检查项旁边。用法:
 *   node tools/verify-dialog-a11y.mjs [--url http://127.0.0.1:5173/]
 * 退出码 0 = 全绿;1 = 有 FAIL。
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:5173/');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '   ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

/* desktop = 默认的桌面壳;mobile = 真机上那套手机壳(src/mobile.ts)。
 * 两套前端不是同一份 DOM 的响应式:顶栏、播放条、侧栏都在 mobile.ts 里重排,
 * 所以手机端的结论必须用 ?ui=mobile + isMobile/hasTouch 复现,不能拿 390px 桌面窗口的几何代替。 */
async function load(width, height, mode = 'desktop') {
  const mobile = mode === 'mobile';
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  await page.goto(url + (mobile ? '?ui=mobile' : '?ui=desktop'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app-loading');
    return !el || el.classList.contains('is-hidden');
  }, { timeout: 90000, polling: 300 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  await page.bringToFront();
}

/* ---------- 1. 桌面前端的窄窗口:动画选择器是主角,必须独占一整行 ----------
 * (手机端的顶栏是 mobile.css 的两行 grid,由第 5 组单独判断) */
for (const w of [390, 430, 470]) {
  await load(w, 844, 'desktop');
  const t = await page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), right: Math.round(b.right), w: Math.round(b.width) }; };
    return { vw: innerWidth, anim: r(document.querySelector('.anim-switch')), sw: r(document.querySelector('.theme-switch')), brand: r(document.querySelector('.brand')), tbH: Math.round(document.querySelector('.topbar').getBoundingClientRect().height) };
  });
  /* 判据:触发器从内容左边界(16px = 顶栏内边距)起、吃掉整行;主题开关贴在右侧。
   * 只判"占满剩余宽度"(w > vw*0.7)会把"靠右但很短"的旧排法也放过去,所以两个都判。 */
  check('桌面前端 ' + w + 'px:动画触发器独占整行(左起、占满宽度)', t.anim.x <= 20 && t.anim.w >= t.vw * 0.7, t);
  check('桌面前端 ' + w + 'px:主题开关与品牌同排且贴右', t.sw.right >= t.vw - 20 && t.sw.x > t.brand.right, t);
}

/* ---------- 2. 画廊 / 下载列表头部:窄屏必须折行,关闭按钮留在面板内 ---------- */
for (const w of [390, 430, 470, 480, 768]) {
  await load(w, 900, 'desktop');
  await page.evaluate(() => document.getElementById('animTrigger').click());
  await new Promise((r) => setTimeout(r, 450));
  const g = await page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
    const panel = document.querySelector('.ap-panel');
    const close = document.getElementById('animPickerClose');
    const search = document.getElementById('animSearch').closest('.ap-search');
    const title = document.getElementById('animPickerTitle');
    const pr = panel.getBoundingClientRect();
    return {
      panel: r(panel), close: r(close), search: r(search), title: r(title),
      scrollW: panel.scrollWidth, clientW: panel.clientWidth, vw: innerWidth,
      closeInside: (() => { const c = close.getBoundingClientRect(); return c.left >= pr.left - 0.5 && c.right <= pr.right + 0.5 && c.top >= pr.top - 0.5 && c.bottom <= pr.bottom + 0.5; })(),
      closeInViewport: (() => { const c = close.getBoundingClientRect(); return c.left >= -0.5 && c.right <= innerWidth + 0.5; })(),
      headerStacked: title.getBoundingClientRect().bottom <= search.getBoundingClientRect().top + 0.5,
    };
  });
  check(w + 'px:画廊关闭按钮在面板内且可见', g.closeInside && g.closeInViewport, g);
  check(w + 'px:画廊面板无横向溢出', g.scrollW <= g.clientW + 1, { scrollW: g.scrollW, clientW: g.clientW });
  if (w <= 480) check(w + 'px:画廊头部折成两行(标题在上、搜索在下)', g.headerStacked, g.close);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await new Promise((r) => setTimeout(r, 250));
}

/* ---------- 3. 焦点:模态浮层里连续 Tab 不许离开 ---------- */
await load(1280, 800);
const trap = await page.evaluate(() => {
  document.getElementById('animTrigger').click();
  return true;
});
await new Promise((r) => setTimeout(r, 400));
const seq = [];
for (let i = 0; i < 30; i++) {
  await page.keyboard.press('Tab');
  seq.push(await page.evaluate(() => {
    const a = document.activeElement;
    return { inside: !!a && document.getElementById('animPicker').contains(a), name: a ? (a.id || String(a.className || a.tagName)).slice(0, 40) : 'null' };
  }));
}
check('画廊:连续 30 次 Tab 焦点始终在浮层内', seq.every((s) => s.inside), seq.filter((s) => !s.inside).slice(0, 4));
/* Shift+Tab 从首项往回走:同样不能出去 */
const back = [];
for (let i = 0; i < 12; i++) {
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  back.push(await page.evaluate(() => !!document.activeElement && document.getElementById('animPicker').contains(document.activeElement)));
}
check('画廊:Shift+Tab 反向同样不离开浮层', back.every(Boolean), back.indexOf(false));
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 350));
const afterEsc = await page.evaluate(() => ({ open: !document.getElementById('animPicker').hidden, focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName) }));
check('画廊:Esc 关闭并把焦点交还触发器', !afterEsc.open && afterEsc.focus === 'animTrigger', afterEsc);

/* ---------- 4. 浮层语义:导出 / 数据加载 / 状态栏 ---------- */
const a11y = await page.evaluate(() => {
  const ov = document.getElementById('exportOverlay');
  const bar = ov.querySelector('[role="progressbar"]');
  const dl = document.getElementById('dataLoading');
  const dlBar = dl.querySelector('[role="progressbar"]');
  const sb = document.getElementById('statusbar');
  return {
    exportRole: ov.getAttribute('role'), exportModal: ov.getAttribute('aria-modal'),
    exportLabel: ov.getAttribute('aria-labelledby'), exportTabIndex: ov.getAttribute('tabindex'),
    barValue: bar && bar.getAttribute('aria-valuenow'), barMax: bar && bar.getAttribute('aria-valuemax'),
    dlRole: dl.getAttribute('role'), dlLive: dl.getAttribute('aria-live'),
    dlBarRole: dlBar && dlBar.getAttribute('role'), dlBarValue: dlBar && dlBar.getAttribute('aria-valuenow'),
    statusRole: sb.getAttribute('role'), statusLive: sb.getAttribute('aria-live'),
    exportTitleExists: !!document.getElementById('exportTitle'),
  };
});
check('导出浮层是带名字的模态对话框', a11y.exportRole === 'dialog' && a11y.exportModal === 'true' && a11y.exportLabel === 'exportTitle' && a11y.exportTitleExists, a11y);
check('导出进度条有 progressbar 语义与初值', a11y.barValue === '0' && a11y.barMax === '100', a11y);
check('数据加载浮层是 live region(状态栏同样)', a11y.dlRole === 'status' && a11y.dlLive === 'polite' && a11y.statusRole === 'status', a11y);
check('数据加载进度条有 progressbar 语义', a11y.dlBarRole === 'progressbar' && a11y.dlBarValue === '0', a11y);

/* ---------- 5. 手机壳(?ui=mobile):这是另一套前端,不是同一份 DOM 的响应式 ---------- */
for (const w of [390, 430]) {
  await load(w, 844, 'mobile');
  const m = await page.evaluate(() => {
    const R = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1) }; };
    const themeBtn = document.querySelector('.theme-btn');
    const before = getComputedStyle(themeBtn, '::before');
    const t = themeBtn.getBoundingClientRect();
    const tab = document.querySelector('.m-tab');
    const panel = document.querySelector('.ap-panel');
    return {
      ui: document.documentElement.dataset.ui,
      anim: R(document.querySelector('.anim-trigger')),
      craft: R(document.querySelector('.craft-note')),
      themeHitH: +(t.height + Math.abs(parseFloat(before.top || '0')) * 2).toFixed(1),
      tabH: tab ? +tab.getBoundingClientRect().height.toFixed(1) : 0,
      topbarH: +document.querySelector('.topbar').getBoundingClientRect().height.toFixed(1),
      galleryOpen: false,
    };
  });
  check('手机 ' + w + 'px:走的是手机壳(data-ui=mobile)', m.ui === 'mobile', m.ui);
  /* 手机端顶栏是两行 grid:选择器第一行、制作声明第二行;触发器吃掉剩余宽度 */
  check('手机 ' + w + 'px:顶栏两行,选择器在第一行、声明在第二行',
    m.anim.y < m.craft.y && m.anim.w > 200 && m.topbarH <= 80, m);
  check('手机 ' + w + 'px:动画触发器高度 >= 40', m.anim.h >= 40, m.anim);
  check('手机 ' + w + 'px:分区芯片高度 >= 40', m.tabH >= 40, m.tabH);
  check('手机 ' + w + 'px:主题开关命中区 >= 40 高(外观不变)', m.themeHitH >= 40, m.themeHitH);

  await page.evaluate(() => document.getElementById('animTrigger').click());
  await new Promise((r) => setTimeout(r, 450));
  const g = await page.evaluate(() => {
    const panel = document.querySelector('.ap-panel');
    const close = document.getElementById('animPickerClose').getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const search = document.getElementById('animSearch').closest('.ap-search').getBoundingClientRect();
    const title = document.getElementById('animPickerTitle').getBoundingClientRect();
    return {
      inside: close.left >= pr.left - 0.5 && close.right <= pr.right + 0.5,
      inViewport: close.right <= innerWidth + 0.5,
      scrollOver: panel.scrollWidth - panel.clientWidth,
      stacked: title.bottom <= search.top + 0.5,
    };
  });
  check('手机 ' + w + 'px:画廊关闭按钮在面板内且可见', g.inside && g.inViewport, g);
  check('手机 ' + w + 'px:画廊头部折成两行、无横向溢出', g.stacked && g.scrollOver <= 1, g);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await new Promise((r) => setTimeout(r, 250));
}

check('无页面级 JS 报错', errors.length === 0, errors.slice(0, 3));

await browser.close();
console.log('\n未通过: ' + failed + ' 项');
process.exit(failed ? 1 : 0);
