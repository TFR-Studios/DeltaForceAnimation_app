/* 导出浮层「渲染器日志」的回归断言(开发期辅助,不参与构建)。
 * 这块黑底日志窗口是纯展示,但它绑定在导出热路径(逐帧回调 / 进度回调 / 终态)上,
 * 改导出流程或改浮层结构时最容易静默坏掉 —— 所以这里用真实导出跑一遍:
 *   · 桌面深色 / 浅色:窗口必须是固定的近黑,两套主题里都出现逐帧拆分明细、状态与用时,
 *     且旧版的圆点 / LIVE 指示不再存在;
 *   · 取消:状态切到「已取消导出」、最后一行是 ABORT,帧号停止增长;
 *   · 手机壳:卡片与日志窗口都不能超出 390×844 视口,也不能横向溢出。
 * 取帧需要真的跑几帧,所以每段只导出约 4 秒就取消。
 * 用法:node tools/verify-render-log.mjs [--url http://127.0.0.1:5173/]
 * 退出码 0 = 全绿;1 = 有 FAIL;2 = 找不到浏览器。
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:5173/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '   ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });

async function openEditor({ theme = 'dark', mobile = false, width = 1440, height = 1000 }) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('dfae.ui.theme.v1', t); } catch (e) { /* 忽略 */ } }, theme);
  if (mobile) {
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36');
  }
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(url + (mobile ? '?ui=mobile&view=editor' : '?view=editor'), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => {
    const ld = document.getElementById('app-loading');
    const b = document.getElementById('btnExport');
    return (!ld || ld.classList.contains('is-hidden') || !document.contains(ld)) && b && !b.disabled;
  }, { timeout: 120000, polling: 300 });
  await sleep(900);
  return page;
}

async function startExport(page) {
  await page.evaluate(() => document.getElementById('btnExport').click());
  await page.waitForSelector('#exportOverlay:not([hidden])', { timeout: 30000 });
  /* 等第一条帧行:阶段 / BOOT 那几行先到,帧行出现才说明真的开始渲染了。 */
  await page.waitForFunction(() => document.querySelectorAll('#renderLogBody .render-log-line[data-level="frame"]').length >= 2, { timeout: 60000, polling: 150 });
  await sleep(900);
}

async function cancelExport(page) {
  await page.evaluate(() => document.getElementById('btnExportCancel').click());
  await page.waitForFunction(() => /已取消/.test(document.getElementById('renderLogState').textContent), { timeout: 20000, polling: 120 });
  await sleep(250);
}

const readState = (page) => page.evaluate(() => {
  const panel = document.getElementById('renderLog');
  const body = document.getElementById('renderLogBody');
  const card = document.querySelector('.export-card');
  const rect = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
  const bg = getComputedStyle(panel).backgroundColor.match(/\d+/g).map(Number);
  const lines = [...document.querySelectorAll('#renderLogBody .render-log-line')];
  return {
    theme: document.documentElement.dataset.theme,
    bg, bgText: getComputedStyle(panel).backgroundColor,
    panel: rect(panel), card: rect(card), viewport: { w: innerWidth, h: innerHeight },
    frame: document.getElementById('renderLogFrame').textContent,
    state: document.getElementById('renderLogState').textContent,
    elapsed: document.getElementById('renderLogElapsed').textContent,
    hasLiveNode: !!document.getElementById('renderLogLive'),
    lineCount: lines.length,
    tags: lines.map((l) => l.querySelector('.rl-tag')?.textContent || ''),
    firstLine: lines[0] ? lines[0].textContent : '',
    lastLine: lines.length ? lines[lines.length - 1].textContent : '',
    frameLines: lines.filter((l) => l.dataset.level === 'frame').map((l) => l.textContent),
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyScroll: { h: body.scrollHeight, c: body.clientHeight },
  };
});

/* ---------- 1. 桌面深色:结构 / 近黑底 / 逐帧拆分明细 / 步骤标签 / 用时 / 取消 ---------- */
{
  const page = await openEditor({ theme: 'dark' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  await startExport(page);
  const s = await readState(page);
  check('桌面深色:主题确实是 dark', s.theme === 'dark', s.theme);
  check('桌面深色:终端底是近黑(固定色,不是 gray panel)', s.bg.every((v) => v <= 30), s.bgText);
  check('桌面深色:帧号是 FRAME n / n 且总数 > 0', /^FRAME \d+ \/ \d+$/.test(s.frame) && Number(s.frame.split('/')[1].trim()) > 0, s.frame);
  check('桌面深色:帧行拆出了主渲染 / 总耗时', s.frameLines.some((l) => /主\d+\.\d/.test(l) && /总\d+\.\dms/.test(l)), s.frameLines[0]);
  check('桌面深色:帧行按帧记录(>= 6 行)', s.frameLines.length >= 6, s.frameLines.length);
  check('桌面深色:已打出的步骤标签包含 SPEC / CODEC / INIT / ENC', ['SPEC', 'CODEC', 'INIT', 'ENC'].every((t) => s.tags.includes(t)), [...new Set(s.tags)].join(','));
  check('桌面深色:状态文案非空', s.state.length > 0, s.state);
  check('桌面深色:旧的 LIVE 圆点已移除', !s.hasLiveNode, s.hasLiveNode);
  check('桌面深色:用时在走', /^\d{2}:\d{2}\.\d$/.test(s.elapsed), s.elapsed);
  check('桌面深色:终端在浮层卡片内', s.panel.x >= s.card.x - 1 && s.panel.right <= s.card.right + 1 && s.panel.y >= s.card.y && s.panel.bottom <= s.card.bottom, { panel: s.panel, card: s.card });
  check('桌面深色:卡片不超出视口', s.card.y >= 0 && s.card.bottom <= s.viewport.h && s.card.x >= 0 && s.card.right <= s.viewport.w, { card: s.card, viewport: s.viewport });
  check('桌面深色:页面无横向溢出', s.pageOverflowX <= 0, s.pageOverflowX);
  await cancelExport(page);
  const c = await readState(page);
  check('桌面深色取消:状态切到已取消', /已取消/.test(c.state), c.state);
  check('桌面深色取消:最后一行是 ABORT', /^\d{2}:\d{2}\.\d+ABORT/.test(c.lastLine), c.lastLine);
  const frameAtCancel = c.frame;
  await sleep(500);
  const frameLater = await page.evaluate(() => document.getElementById('renderLogFrame').textContent);
  check('桌面深色取消:帧号停止更新', frameLater === frameAtCancel, frameAtCancel + ' → ' + frameLater);
  check('桌面深色:无页面异常', errors.length === 0, errors);
  await page.close();
}

/* ---------- 2. 桌面浅色:终端仍必须是近黑,且文字可读(采样 body 主色) ---------- */
{
  const page = await openEditor({ theme: 'light' });
  await startExport(page);
  const s = await readState(page);
  check('桌面浅色:主题确实是 light', s.theme === 'light', s.theme);
  check('桌面浅色:终端底仍是近黑', s.bg.every((v) => v <= 30), s.bgText);
  check('桌面浅色:帧号 / 状态正常', /^FRAME \d+ \/ \d+$/.test(s.frame) && s.state.length > 0, { frame: s.frame, state: s.state });
  check('桌面浅色:帧行仍有分段耗时', s.frameLines.some((l) => /主\d+\.\d/.test(l)), s.frameLines[0]);
  await cancelExport(page);
  await page.close();
}

/* ---------- 3. 手机壳:卡片与终端都要待在 390×844 里 ---------- */
{
  const page = await openEditor({ theme: 'dark', mobile: true, width: 390, height: 844 });
  await startExport(page);
  const s = await readState(page);
  check('手机壳:识别为 mobile', await page.evaluate(() => document.documentElement.dataset.ui === 'mobile'), await page.evaluate(() => document.documentElement.dataset.ui));
  check('手机壳:卡片纵向不超出视口', s.card.y >= 0 && s.card.bottom <= s.viewport.h, { top: +s.card.y.toFixed(1), bottom: +s.card.bottom.toFixed(1), vh: s.viewport.h });
  check('手机壳:卡片横向不超出视口', s.card.x >= 0 && s.card.right <= s.viewport.w, { x: +s.card.x.toFixed(1), right: +s.card.right.toFixed(1), vw: s.viewport.w });
  check('手机壳:终端在卡片内且宽度合理', s.panel.x >= s.card.x && s.panel.right <= s.card.right && s.panel.w > 280, { panelW: +s.panel.w.toFixed(1), cardW: +s.card.w.toFixed(1) });
  check('手机壳:页面无横向溢出', s.pageOverflowX <= 0, s.pageOverflowX);
  check('手机壳:帧行仍在更新', /^FRAME \d+ \/ \d+$/.test(s.frame), s.frame);
  check('手机壳:帧行拆出了分段耗时', s.frameLines.some((l) => /主\d+\.\d/.test(l)), s.frameLines[0]);
  await cancelExport(page);
  await page.close();
}

await browser.close();
console.log('\n' + (failed ? failed + ' 项 FAIL' : '全部 PASS'));
process.exit(failed ? 1 : 0);
