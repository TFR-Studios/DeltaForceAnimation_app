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
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  if (theme) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等启动加载层退场(与 electron/smoke.cjs 同一判据)
  await page.waitForFunction(() => {
    const el = document.getElementById('app-loading');
    return !el || el.classList.contains('is-hidden');
  }, { timeout: 90000, polling: 300 }).catch(() => { errs.push('loading-timeout'); });
  await new Promise((r) => setTimeout(r, 1200 + waitExtra));
  if (sel) {
    await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); }, sel);
    await new Promise((r) => setTimeout(r, 700));
  }
  if (has('full')) await page.screenshot({ path: out, fullPage: true });
  else await page.screenshot({ path: out });
  const stats = await page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return { bodyBg: cs.backgroundColor, bodyColor: cs.color, title: document.title };
  });
  console.log(JSON.stringify({ ok: true, out, stats, errors: errs.slice(0, 12) }, null, 2));
} finally {
  await browser.close();
}
