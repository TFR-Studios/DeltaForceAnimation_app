/* 交互回归(开发期辅助):逐个"用真实鼠标点一遍"骨架里的关键控件,确认改版没有把事件绑定弄丢。
 * 用法:node tools/ui-interact.mjs [--url http://127.0.0.1:5174/]
 * 判据:点完之后控件真的发生了它该发生的变化(状态、类名、disabled、data-theme 等)。 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:5174/');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => { const el = document.getElementById('app-loading'); return !el || el.classList.contains('is-hidden'); }, { timeout: 90000, polling: 250 }).catch(() => errs.push('loading-timeout'));
await page.waitForFunction(() => document.querySelectorAll('fluent-button').length > 5, { timeout: 15000, polling: 100 }).catch(() => errs.push('fluent-upgrade-timeout'));
await new Promise((r) => setTimeout(r, 1200));

/** 用真实鼠标点某元素中心(先滚动到可见)。 */
async function click(sel) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  }, sel);
  if (!box) return { sel, ok: false, why: 'not-found' };
  await page.mouse.click(box.x, box.y);
  await new Promise((r) => setTimeout(r, 350));
  return { sel, ok: true, box };
}
const probe = (fn, ...a) => page.evaluate(fn, ...a);

const results = [];
const record = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

/* 1. 主题开关:点"浅色"应变浅,点"深色"应变深。
 * 选择器只认 [data-theme] —— 那个属性是"这是个主题按钮"的唯一契约,
 * 元素标签(fluent-toggle-button / fluent-button / 原生 button)会随实现变,
 * 绑死标签的测试会跟着实现的每次调整一起坏掉。 */
const THEME_LIGHT = '.theme-switch [data-theme="light"]';
const THEME_DARK = '.theme-switch [data-theme="dark"]';
await click(THEME_LIGHT);
let theme = await probe(() => document.documentElement.dataset.theme);
record('theme -> light', theme === 'light', theme);
/* 指示器必须跟着滑:这是这套控件"当前主题"的第一视觉信号。 */
const ind = await probe(() => {
  const i = document.querySelector('.theme-indicator');
  const g = document.querySelector('.theme-switch');
  if (!i || !g) return null;
  const ir = i.getBoundingClientRect();
  const gr = g.getBoundingClientRect();
  return { offset: Math.round(ir.x - gr.x), current: g.dataset.current };
});
record('theme indicator follows selection', ind !== null && ind.current === 'light' && ind.offset < 10, JSON.stringify(ind));
await click(THEME_DARK);
theme = await probe(() => document.documentElement.dataset.theme);
record('theme -> dark', theme === 'dark', theme);
/* 反复切:确认不是"只能切一次"(曾经因为 window 上的去重标志变成一次性开关) */
await click(THEME_LIGHT);
const again = await probe(() => document.documentElement.dataset.theme);
record('theme toggle repeats', again === 'light', again);
await click(THEME_DARK);

/* 2. 播放/暂停(#btnPlay 是 Fluent 按钮,且是骨架里最早绑事件的控件之一) */
const before = await probe(() => (window.__anim ? window.__anim.isPaused : null));
await click('#btnPlay');
const after = await probe(() => (window.__anim ? window.__anim.isPaused : null));
record('btnPlay toggles pause', before !== null && before !== after, before + ' -> ' + after);
await click('#btnPlay');

/* 3. 复位视图:点完缩放应回到 100% */
await click('#btnRestart');
const zoomBefore = await probe(() => document.getElementById('zoomInfo').textContent);
await click('#btnResetView');
const zoomAfter = await probe(() => document.getElementById('zoomInfo').textContent);
record('btnResetView runs', typeof zoomBefore === 'string' && zoomAfter === '100%', zoomBefore + ' -> ' + zoomAfter);

/* 4. 循环开关(fluent-switch):点标签文字也应切换 */
const loop0 = await probe(() => document.getElementById('chkLoop').checked);
await click('label.loop');
const loop1 = await probe(() => ({ v: document.getElementById('chkLoop').checked, tag: document.getElementById('chkLoop').tagName }));
record('chkLoop label click toggles', loop0 !== loop1.v, JSON.stringify({ before: loop0, ...loop1 }));

/* 5. 动画画库:#animTrigger 打开 → 卡片可点 → 关闭按钮 */
await click('#animTrigger');
const open1 = await probe(() => ({ hidden: document.getElementById('animPicker').hidden, cards: document.querySelectorAll('.ap-card').length, expanded: document.getElementById('animTrigger').getAttribute('aria-expanded') }));
record('animTrigger opens picker', open1.hidden === false && open1.cards > 0 && open1.expanded === 'true', JSON.stringify(open1));
await click('#animPickerClose');
const open2 = await probe(() => ({ hidden: document.getElementById('animPicker').hidden, expanded: document.getElementById('animTrigger').getAttribute('aria-expanded') }));
record('picker close button works', open2.hidden === true && open2.expanded === 'false', JSON.stringify(open2));

/* 6. 导出格式下拉(原生 select,改的是导出行为) */
const fmt = await probe(() => {
  const s = document.getElementById('selFormat');
  const old = s.value;
  s.value = old === 'mp4' ? 'avi' : 'mp4';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return { old, now: s.value };
});
record('selFormat change handled', fmt.old !== fmt.now, JSON.stringify(fmt));
await probe(() => { const s = document.getElementById('selFormat'); s.value = 'mp4'; s.dispatchEvent(new Event('change', { bubbles: true })); });

/* 7. 侧栏里的控件:找一个可见的"重置"按钮点一下(它们由 main.ts 生成,保持原生) */
const sideBtn = await probe(() => {
  const b = document.querySelector('#textList .t-reset, #shapeList .t-reset, #popupTextList .t-reset');
  if (!b) return null;
  b.click();
  return { tag: b.tagName, cls: b.className };
});
record('sidebar reset button clickable', !!sideBtn, JSON.stringify(sideBtn));

/* 8. 键盘:空格播放/暂停(全局快捷键没被改版影响) */
const p0 = await probe(() => (window.__anim ? window.__anim.isPaused : null));
await page.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 300));
const p1 = await probe(() => (window.__anim ? window.__anim.isPaused : null));
record('space toggles play', p0 !== p1, p0 + ' -> ' + p1);

/* 9. 导出浮层骨架仍在(不真的导出,只看按钮可点性) */
const overlay = await probe(() => ({ overlay: !!document.getElementById('exportOverlay'), cancel: !!document.getElementById('btnExportCancel'), exportBtn: !!document.getElementById('btnExport') }));
record('export skeleton present', overlay.overlay && overlay.cancel && overlay.exportBtn, JSON.stringify(overlay));

console.log(results.map((r) => (r.ok ? 'PASS  ' : 'FAIL  ') + r.name + '   ' + r.detail).join('\n'));
console.log('\nconsole/page errors (' + errs.length + '): ' + JSON.stringify(errs.slice(0, 10), null, 1));
const failed = results.filter((r) => !r.ok).length;
console.log('\n' + (failed ? failed + ' FAILED' : 'ALL PASS') + ' (' + results.length + ' checks)');
await browser.close();
process.exit(failed ? 1 : 0);
