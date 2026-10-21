/* 真文件验收:把出点临时压到 41 帧(避免 3.4GB),完整导出一次透明 AVI,
 * 再把产物从磁盘读回来解析 RIFF + 取中间帧核对 BGRA/alpha。 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const URL = 'http://127.0.0.1:5173/';
const ROOT = 'I:/DeltaForceCustomAnimation_application';
const AVI = ROOT + '/tools/user-export.avi';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (fs.existsSync(AVI)) fs.unlinkSync(AVI);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1700, height: 1000 });
const logs = [];
page.on('console', (m) => logs.push(m.text().slice(0, 200)));
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('已载入'), { timeout: 90000 });
await page.select('#selAnim', 'maptitle');
await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('地图标题'), { timeout: 60000 });
await page.waitForFunction(() => window.__anim && window.__anim.isLoaded, { timeout: 60000 });
await sleep(1200);
// 改字
await page.evaluate(() => {
  for (const li of [...document.querySelectorAll('#textList .text-item')]) {
    const nm = li.querySelector('.t-name').textContent;
    const ta = li.querySelector('.t-input');
    if (!ta) continue;
    ta.value = nm.includes('地点') ? '测试长地名测试长地名测试' : '测试地图名称';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await sleep(2500);
// 压缩出点(仅本次验收用)
const opInfo = await page.evaluate(() => {
  const d = window.__anim.animationData;
  const before = { ip: d.ip, op: d.op };
  d.op = 41;
  return { before, after: { ip: d.ip, op: d.op } };
});
console.log('出点压缩: ' + JSON.stringify(opInfo));
await page.evaluate(() => { const ch = document.getElementById('chkTransparent'); if (!ch.checked) { ch.checked = true; ch.dispatchEvent(new Event('change', { bubbles: true })); } });
await page.evaluate(() => document.getElementById('btnExport').click());
const t0 = Date.now();
let st = null;
while (Date.now() - t0 < 300000) {
  st = await page.evaluate(() => ({ s: document.getElementById('exportStatus').textContent.trim(), d: document.getElementById('exportDetail').textContent.trim(), p: document.getElementById('exportPercent').textContent.trim() }));
  if (st.p === '100%' || /失败|错误/.test(st.s)) break;
  await sleep(500);
}
console.log('导出: ' + JSON.stringify(st) + ' 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
// 等 /save-avi 落盘:等到「文件大小 == RIFF 头里声明的大小 + 8」为止(中途一直被写)
let size = 0, expected = 0;
for (let i = 0; i < 600; i++) {
  if (fs.existsSync(AVI)) {
    size = fs.statSync(AVI).size;
    if (size >= 8 && !expected) {
      const b = Buffer.alloc(8);
      const f = fs.openSync(AVI, 'r');
      fs.readSync(f, b, 0, 8, 0);
      fs.closeSync(f);
      expected = b.readUInt32LE(4) + 8;
    }
    if (expected && size >= expected) break;
  }
  await sleep(500);
}
console.log('落盘: ' + AVI + ' ' + (size / 1024 / 1024).toFixed(1) + ' MB(声明 ' + (expected / 1024 / 1024).toFixed(1) + ' MB)');
await browser.close();

// ---- 解析 AVI ----
if (!size) { console.log('没有产物,跳过解析'); process.exit(0); }
const fd = fs.openSync(AVI, 'r');
const head = Buffer.alloc(12);
fs.readSync(fd, head, 0, 12, 0);
const riff = head.toString('latin1', 0, 4);
const riffSize = head.readUInt32LE(4);
const form = head.toString('latin1', 8, 12);
console.log('RIFF=' + riff + ' size=' + riffSize + ' form=' + form + ' 实际=' + (size - 8));
// 扫描 hdrl 找 avih 与 strf
let pos = 12;
let avih = null, strf = null, moviStart = -1;
const rd = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; };
while (pos + 8 <= size) {
  const id = rd(pos, 4).toString('latin1');
  const len = rd(pos + 4, 4).readUInt32LE(0);
  if (id === 'LIST') {
    const type = rd(pos + 8, 4).toString('latin1');
    if (type === 'movi') { moviStart = pos + 12; break; }
    pos += 12;
    continue;
  }
  if (id === 'avih') avih = rd(pos + 8, Math.min(len, 56));
  if (id === 'strf') strf = rd(pos + 8, Math.min(len, 40));
  pos += 8 + len + (len % 2);
}
if (avih) {
  console.log('avih: microSecPerFrame=' + avih.readUInt32LE(0) + ' totalFrames=' + avih.readUInt32LE(16) + ' streams=' + avih.readUInt32LE(24) + ' w=' + avih.readUInt32LE(32) + ' h=' + avih.readUInt32LE(36));
}
if (strf) {
  console.log('strf: biSize=' + strf.readUInt32LE(0) + ' w=' + strf.readInt32LE(4) + ' h=' + strf.readInt32LE(8) + ' planes=' + strf.readUInt16LE(12) + ' bitCount=' + strf.readUInt16LE(14) + ' comp=' + strf.readUInt32LE(16) + ' sizeImage=' + strf.readUInt32LE(20));
}
// 遍历 movi 帧块,取第 30 帧
let p = moviStart, frameIdx = 0, picked = null;
while (p + 8 <= size && frameIdx <= 31) {
  const id = rd(p, 4).toString('latin1');
  const len = rd(p + 4, 4).readUInt32LE(0);
  if (id === '00db' || id === '00dc') {
    if (frameIdx === 30) { picked = { off: p + 8, len }; }
    frameIdx++;
  }
  p += 8 + len + (len % 2);
}
console.log('movi 帧块数(扫到第 ' + frameIdx + ' 帧) 取帧 30: ' + JSON.stringify(picked));
if (picked) {
  // BGRA 自下而上:统计 alpha 与颜色
  const W = strf.readInt32LE(4), H = Math.abs(strf.readInt32LE(8));
  const buf = rd(picked.off, Math.min(picked.len, W * H * 4));
  let nz = 0, premulBad = 0, whitePremul = 0, blackOpaque = 0, maxA = 0;
  for (let y = 0; y < H; y += 4) {
    for (let x = 0; x < W; x += 4) {
      const i = (y * W + x) * 4;
      const b = buf[i], g = buf[i + 1], r = buf[i + 2], a = buf[i + 3];
      if (a > 0) { nz++; if (a > maxA) maxA = a; }
      if (a === 255 && r > 200 && g > 200 && b > 200) whitePremul++;
      if (a > 0 && a < 255 && (r > a + 8 || g > a + 8 || b > a + 8)) premulBad++;
    }
  }
  console.log('帧30: 宽高=' + W + 'x' + H + ' 非透明像素=' + nz + ' alphaMax=' + maxA + ' 不透明白像素(文字)=' + whitePremul + ' 未预乘越界像素=' + premulBad);
}
fs.closeSync(fd);
console.log('日志尾: ' + logs.slice(-4).join(' || '));
