/* 图标几何校验:把下载列表的四颗图标注入页面,用 SVG 自身的 getBBox 检查
 * "路径真的有面积" —— 空 path 是最容易混过去的失败(按钮在、图标不显示)。
 * 为什么不用 canvas 量像素:把内联 SVG 当图片加载会污染 canvas,getImageData 抛异常,
 * 探针会卡在那儿。getBBox 是纯几何计算,不受污染策略影响,对"是不是空路径"同样有效。 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => document.querySelector('#app-loading')?.classList.contains('is-hidden'), { timeout: 120000, polling: 250 }).catch(() => {});
await new Promise((r) => setTimeout(r, 900));
/* 从脚本源里解析图标常量:下载列表在浏览器里没有数据(要主进程 IPC),
 * 但那份 HTML 由同一批常量拼出来,所以直接读常量比去页面里找实例更稳。
 * 列表里只剩"定位(文件夹)"与"移除(垃圾桶)";ICON_CHECK 是导出浮层完成态的对勾,
 * 与前两颗同源(同一批手写图标),几何异常的概率一样,所以一并纳入。 */
const src = fs.readFileSync('src/main.ts', 'utf8');
const want = ['ICON_REVEAL', 'ICON_TRASH', 'ICON_CHECK'];
const svgs = {};
for (const name of want) {
  const i = src.indexOf('const ' + name + ' =');
  if (i < 0) continue;
  const seg = src.slice(i, i + 900);
  const paths = [...seg.matchAll(/'<path d="([^"]+)"/g)].map((m) => m[1]);
  svgs[name] = paths;
}
const out = await page.evaluate((svgs) => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-4000px;top:0;';
  document.body.appendChild(host);
  const res = [];
  for (const [name, paths] of Object.entries(svgs)) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    host.appendChild(svg);
    let total = 0;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (const d of paths) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
      let b = null;
      try { b = p.getBBox(); } catch (e) { b = null; }
      if (b && b.width > 0 && b.height > 0) {
        total += b.width * b.height;
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
      }
    }
    res.push({ name, paths: paths.length, areaInk: +total.toFixed(1), bbox: maxX < 0 ? null : [ +minX.toFixed(1), +minY.toFixed(1), +(maxX - minX).toFixed(1), +(maxY - minY).toFixed(1) ] });
    host.removeChild(svg);
  }
  host.remove();
  return res;
}, svgs);
let fail = 0;
for (const r of out) {
  /* 判据:每颗图标至少 1 条非空路径,且墨迹总面积 > 20(16x16 视图里小于这个就是"几乎看不见") */
  const ok = r.paths >= 1 && r.areaInk > 20 && r.bbox && r.bbox[0] >= -0.5 && r.bbox[1] >= -0.5 && r.bbox[0] + r.bbox[2] <= 16.5 && r.bbox[1] + r.bbox[3] <= 16.5;
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + r.name.padEnd(14) + ' 路径 ' + r.paths + ' 条, 墨迹面积 ' + String(r.areaInk).padStart(6) + ', 包围盒 ' + JSON.stringify(r.bbox));
}
console.log('\n未通过:' + fail + ' 项');
await browser.close();
process.exit(fail ? 1 : 0);
