/* 截图工具(开发期辅助,不参与构建):用本机 Chrome 打开 Vite 开发服务器并出图。
 * 用法:node tools/shot.mjs --url http://127.0.0.1:5173/ --out release/ui-audit/x.png [--w 1600 --h 1000] [--theme light|dark] [--full] [--sel .selector]
 * 依赖:本机 Chrome 可执行文件 + puppeteer-core。仅用于 UI 走查,产物只写到 --out。 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes('--' + name);

const url = arg('url', 'http://127.0.0.1:5173/');
const out = arg('out', 'release/ui-audit/shot.png');
const width = Number(arg('w', 1600));
const height = Number(arg('h', 1000));
const theme = arg('theme', '');
const sel = arg('sel', '');
const waitExtra = Number(arg('wait', 0));
/* 这个项目有**两套前端**:手机 / 平板走 src/mobile.ts(src/mobile.css,html[data-ui=mobile]),
 * 桌面走 src/style.css。只改 viewport 宽度拍不到手机壳 —— 必须带 ?ui=mobile 并把
 * isMobile/hasTouch 一起设上,否则拿到的是"被挤窄的桌面布局",容易得出错误结论。 */
const ui = arg('ui', '');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const exe = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
if (!exe) { console.error('NO_BROWSER'); process.exit(2); }

fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', '--hide-scrollbars', '--force-color-profile=srgb'],
});
try {
  const page = await browser.newPage();
  const mobileUI = ui === 'mobile';
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: mobileUI, hasTouch: mobileUI });
  if (theme) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 200)));
  const target = ui ? url + (url.includes('?') ? '&' : '?') + 'ui=' + encodeURIComponent(ui) : url;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等启动加载层退场(与 electron/smoke.cjs 同一判据)
  await page.waitForFunction(() => {
    const el = document.getElementById('app-loading');
    return !el || el.classList.contains('is-hidden');
  }, { timeout: 90000, polling: 300 }).catch(() => { errs.push('loading-timeout'); });
  await new Promise((r) => setTimeout(r, 1200 + waitExtra));
  /* 主题开关:这个应用的主题是**显式存下来的**(localStorage dfae.ui.theme.v1,
     首屏由 index.html 的内联脚本落 data-theme),不跟 prefers-color-scheme 走 ——
     只 emulateMediaFeatures 拍出来的永远是深色,而参数叫 --theme,不说一句就静默产出
     一张"看起来切了其实没切"的图。所以这里改点开关本身(与用户操作同一条路径)。 */
  if (theme === 'light' || theme === 'dark') {
    const clicked = await page.evaluate((want) => {
      const btn = document.querySelector('.theme-btn[data-theme="' + want + '"]');
      if (!btn) return false;
      btn.click();
      return true;
    }, theme);
    if (!clicked) errs.push('theme-switch-not-found');
    await new Promise((r) => setTimeout(r, 400));
  }
  if (sel) {
    await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); }, sel);
    await new Promise((r) => setTimeout(r, 700));
  }
  if (has('full')) await page.screenshot({ path: out, fullPage: true });
  else await page.screenshot({ path: out });
  const stats = await page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return { bodyBg: cs.backgroundColor, bodyColor: cs.color, title: document.title, ui: document.documentElement.dataset.ui || 'desktop' };
  });
  console.log(JSON.stringify({ ok: true, out, stats, errors: errs.slice(0, 12) }, null, 2));
} finally {
  await browser.close();
}
