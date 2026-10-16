import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto(process.argv[2] + '?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => document.querySelector('#app-loading')?.classList.contains('is-hidden'), { timeout: 120000, polling: 250 }).catch(() => {});
await page.waitForFunction(() => document.querySelectorAll('fluent-button').length > 5, { timeout: 20000, polling: 100 }).catch(() => {});
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => document.getElementById('animTrigger').click());
await new Promise((r) => setTimeout(r, 900));
const out = await page.evaluate(async () => {
  const cards = [...document.querySelectorAll('.ap-card')];
  const rows = [];
  for (const c of cards) {
    const img = c.querySelector('.ap-card-cover img');
    if (!img) { rows.push({ key: c.dataset.key, img: false }); continue; }
    try { await img.decode(); } catch (e) { /* 解码失败在下面用 naturalWidth 判断 */ }
    rows.push({ key: c.dataset.key, img: true, data: img.src.startsWith('data:'), natural: img.naturalWidth + 'x' + img.naturalHeight });
  }
  return { n: cards.length, rows };
});
console.log('卡片数:', out.n);
for (const r of out.rows) console.log('  ' + String(r.key).padEnd(12) + (r.img ? ' img ' + r.natural + (r.data ? ' [data-uri!]' : '') : ' 无图(渐变兜底)'));
await browser.close();
