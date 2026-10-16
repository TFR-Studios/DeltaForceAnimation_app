/* 界面状态走查(开发期辅助,不参与构建):
 * 前两个走查脚本查的是"静态第一屏"。这个脚本查**状态**:八套动画各自打开之后,
 * 侧栏出现了哪些区块、有没有"有标题没内容"的空壳、有没有零高度却仍占位的区块;
 * 三个浮层(数据加载 / 导出 / 画廊)打开后的几何是否成立。
 *
 * 用法:node tools/ui-states-audit.mjs [--url http://127.0.0.1:5173/] [--out release/ui-audit/states.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:5173/');
const outPath = arg('out', 'release/ui-audit/states.json');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

/* 侧栏区块 = h3 标题 + 紧随其后的内容。判据是"标题可见但内容容器高度为 0"。 */
const PROBE_SIDE = () => {
  const side = document.querySelector('.side-panel');
  if (!side) return null;
  const blocks = [];
  const kids = [...side.children];
  kids.forEach((el, i) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || el.hidden) return;
    const r = el.getBoundingClientRect();
    const isHead = el.tagName === 'H3';
    const title = isHead ? el.textContent.trim().split('\n')[0].slice(0, 20) : '';
    /* 标题后的内容 = 兄弟节点里第一个非 h3 的可见元素(直到下一个 h3 之前,取合并高度) */
    let bodyH = 0, bodyNodes = 0;
    if (isHead) {
      for (let j = i + 1; j < kids.length; j++) {
        const n = kids[j];
        if (n.tagName === 'H3') break;
        const ncs = getComputedStyle(n);
        if (ncs.display === 'none' || n.hidden) continue;
        bodyNodes++;
        bodyH += n.getBoundingClientRect().height;
      }
    }
    blocks.push({
      tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
      title, head: isHead, h: +r.height.toFixed(1), w: +r.width.toFixed(1),
      bodyH: +bodyH.toFixed(1), bodyNodes,
      empty: isHead && bodyH < 1,
    });
  });
  return {
    scrollH: side.scrollHeight, clientH: side.clientHeight,
    blocks,
    emptyHeads: blocks.filter((b) => b.empty).map((b) => b.title || b.tag),
    zeroHeight: blocks.filter((b) => b.h < 1).map((b) => b.tag),
  };
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => document.querySelector('#app-loading')?.classList.contains('is-hidden'), { timeout: 90000, polling: 250 }).catch(() => {});
await page.waitForFunction(() => document.querySelectorAll('#selAnim option').length > 0, { timeout: 30000, polling: 200 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1200));

const keys = await page.$$eval('#selAnim option', (os) => os.map((o) => o.value));
const report = { url, at: new Date().toISOString(), animations: {}, overlays: {}, errors: errs };
const lines = [];
let fails = 0;
const check = (n, ok, detail) => { if (!ok) fails++; lines.push((ok ? 'PASS  ' : 'FAIL  ') + n + (detail !== undefined ? '   ' + JSON.stringify(detail) : '')); };

for (const key of keys) {
  await page.select('#selAnim', key);
  /* 等到状态栏不再是"就绪"且侧栏稳定下来 */
  await new Promise((r) => setTimeout(r, 1600));
  const state = await page.evaluate(PROBE_SIDE);
  const meta = await page.evaluate(() => ({
    name: document.getElementById('animTriggerName')?.textContent,
    status: document.getElementById('statusbar')?.textContent,
    frame: document.getElementById('frameInfo')?.textContent,
    popup: !document.getElementById('popupSection')?.hidden,
    timing: !document.getElementById('timingSection')?.hidden,
    mission: !document.getElementById('missionRewardSection')?.hidden,
    preset: !document.getElementById('presetSection')?.hidden,
    icon: !document.getElementById('iconSection')?.hidden,
    theme: !document.getElementById('themeSection')?.hidden,
    image: !document.getElementById('imageSection')?.hidden,
    textRows: document.querySelectorAll('#textList > li').length,
    shapeRows: document.querySelectorAll('#shapeList > li').length,
  }));
  report.animations[key] = { ...meta, side: state };
  lines.push('');
  lines.push('========== ' + key + '  (' + (meta.name || '?') + ') ==========');
  lines.push('  区块: ' + JSON.stringify({ popup: meta.popup, timing: meta.timing, mission: meta.mission, preset: meta.preset, icon: meta.icon, theme: meta.theme, image: meta.image, text: meta.textRows, shape: meta.shapeRows }));
  lines.push('  侧栏内容高 ' + state.scrollH + ' / 视口 ' + state.clientH);
  check(key + ' 侧栏没有"有标题没内容"的空壳', state.emptyHeads.length === 0, state.emptyHeads);
  check(key + ' 侧栏没有零高度却占位的区块', state.zeroHeight.length === 0, state.zeroHeight);
  check(key + ' 切换后状态栏给出结果', !!meta.status && meta.status !== '就绪', meta.status);
}

/* 导出浮层:强制显示后量内部几何 */
await page.evaluate(() => {
  const ov = document.getElementById('exportOverlay');
  ov.hidden = false;
  document.getElementById('exportStatus').textContent = '正在编码视频帧…';
  document.getElementById('exportPercent').textContent = '42%';
  document.getElementById('exportDetail').textContent = '1920×1080 · 30fps · H.264 · 音频 AAC';
  document.getElementById('exportFile').hidden = false;
  document.getElementById('exportFileName').textContent = '撤离动画-20261007-153705.mp4';
  document.getElementById('exportFileMeta').textContent = '1.2 MB · 609 帧 · 20.3 秒';
  document.getElementById('exportFilePct').textContent = '42%';
  document.getElementById('exportWarn').hidden = false;
  document.getElementById('exportWarn').textContent = '当前环境不支持 WebCodecs,已降级为 AVI 自封装。';
});
await new Promise((r) => setTimeout(r, 300));
const exp = await page.evaluate(() => {
  const card = document.querySelector('.export-card');
  const r = card.getBoundingClientRect();
  const over = [];
  for (const el of card.querySelectorAll('*')) {
    const b = el.getBoundingClientRect();
    if (b.width === 0) continue;
    if (b.left < r.left - 0.5 || b.right > r.right + 0.5) over.push((el.className || el.tagName) + ':' + Math.round(b.left - r.left) + '..' + Math.round(b.right - r.left));
  }
  return {
    card: { w: Math.round(r.width), h: Math.round(r.height) },
    overflow: over.slice(0, 8),
    actionsRightAligned: (() => {
      const acts = document.querySelector('.export-actions');
      /* 动作按钮启动时会被升级成 <fluent-button>,只按 <button> 找会一个都找不到 */
      const btns = [...acts.querySelectorAll(':is(button, fluent-button)')].filter((b) => !b.hidden);
      if (!btns.length) return null;
      return Math.round(acts.getBoundingClientRect().right - btns[btns.length - 1].getBoundingClientRect().right);
    })(),
    warnVisible: !document.getElementById('exportWarn').hidden,
  };
});
report.overlays.export = exp;
lines.push('');
lines.push('========== 导出浮层 ==========');
check('导出卡片内部无溢出', exp.overflow.length === 0, exp.overflow);
check('导出浮层动作按钮贴右下(右侧留白 ≤ 卡片内边距)', exp.actionsRightAligned !== null && exp.actionsRightAligned <= 24, exp.actionsRightAligned);
await page.evaluate(() => { document.getElementById('exportOverlay').hidden = true; });

/* 数据加载浮层 */
await page.evaluate(() => {
  const dl = document.getElementById('dataLoading');
  dl.hidden = false;
  document.getElementById('dataLoadingFill').style.width = '64%';
  document.getElementById('dataLoadingPct').textContent = '64%';
});
await new Promise((r) => setTimeout(r, 200));
const dl = await page.evaluate(() => {
  const c = document.querySelector('.dl-card').getBoundingClientRect();
  return { w: Math.round(c.width), h: Math.round(c.height), centered: Math.abs((c.left + c.width / 2) - window.innerWidth / 2) < 1.5 };
});
report.overlays.dataLoading = dl;
lines.push('');
lines.push('========== 数据加载浮层 ==========');
check('数据加载卡片水平居中', dl.centered, dl);
await page.evaluate(() => { document.getElementById('dataLoading').hidden = true; });

report.errors = errs;
await browser.close();
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(lines.join('\n'));
console.log('\n报告: ' + outPath);
console.log('未通过: ' + fails + ' 项');
process.exit(fails ? 1 : 0);
