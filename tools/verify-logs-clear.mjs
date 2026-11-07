/* 日志页「清空」二段确认的常驻回归(开发期辅助,不参与构建):
 *   node tools/verify-logs-clear.mjs [--url http://127.0.0.1:5173/] [--only desktop|mobile|both] [--out-dir release/ui-audit]
 *
 * 2026-11 的设计:去掉 window.confirm,改成按钮就地二段确认 ——
 *   第一次点只是"上膛"(文案变「确认清空」、加 .is-armed、变红、aria-label 变"再次点击确认…"),
 *   3.2s 内再点才真的清;超时自动复位。故意不弹系统对话框。
 * 断言(桌面 + 手机各一遍):
 *   1) 第一次点:文案/类名/aria-label 变化,日志条数不变,不出现 confirm();
 *   2) 3.4s 超时:自动复位(文案回「清空」、类名与 aria-label 摘掉),日志仍在;
 *   3) 再点两次:第二次才清空,列表归零、空态出现、清空按钮复位,全程 confirm() 调用次数为 0;
 *   4) 空列表再点:只提示"还没有日志,不需要清空",不进入上膛态。
 * 退出码 0 = 全绿;1 = 有 FAIL。
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const url = arg('url', 'http://127.0.0.1:5173/');
const only = arg('only', 'both');
const outDir = arg('out-dir', '');
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const exe = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
if (!exe) { console.error('NO_BROWSER'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const lines = [];
const check = (name, ok, detail) => {
  if (!ok) fails++;
  lines.push((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '   ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};

const SNAP = () => {
  const btn = document.getElementById('logsClear');
  const cs = btn ? getComputedStyle(btn) : null;
  return {
    count: document.getElementById('logsCountAll')?.textContent,
    children: document.getElementById('logsList')?.children.length,
    text: btn ? btn.textContent.trim() : null,
    armed: !!btn && btn.classList.contains('is-armed'),
    ariaLabel: btn ? btn.getAttribute('aria-label') : null,
    color: cs ? cs.color : null,
    disabled: btn ? btn.disabled : null,
    hint: document.getElementById('logsHint')?.textContent?.trim() || '',
    emptyDisplay: (() => { const el = document.getElementById('logsEmpty'); return el ? getComputedStyle(el).display : null; })(),
    emptyText: document.getElementById('logsEmpty')?.innerText?.trim() || '',
    page: document.documentElement.dataset.page,
    confirmCalls: window.__confirmCalls || 0,
  };
};

async function runCase(kind) {
  const mobile = kind === 'mobile';
  const tag = mobile ? '手机 390' : '桌面 1480';
  lines.push('');
  lines.push('========== ' + tag + ' ==========');
  const browser = await puppeteer.launch({
    executablePath: exe, headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  await page.setViewport({ width: mobile ? 390 : 1480, height: mobile ? 844 : 940, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  try {
    const target = url + (url.includes('?') ? '&' : '?') + (mobile ? 'ui=mobile' : 'ui=desktop');
    let navErr = null;
    for (let i = 0; i < 2; i++) {
      try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 120000 }); navErr = null; break; }
      catch (e) { navErr = e; await sleep(1200); }
    }
    if (navErr) throw navErr;
    await page.waitForFunction(() => {
      const el = document.getElementById('app-loading');
      return !el || el.classList.contains('is-hidden');
    }, { timeout: 120000, polling: 300 });
    await sleep(800);
    await page.evaluate(() => document.querySelector('.rail-item[data-page="logs"]')?.click());
    await page.waitForFunction(() => document.documentElement.dataset.page === 'logs', { timeout: 20000, polling: 100 });
    await sleep(500);
    /* 任何系统 confirm 都必须被记录为失败证据,而不是真的弹窗卡住 headless */
    await page.evaluate(() => {
      window.__confirmCalls = 0;
      window.confirm = function () { window.__confirmCalls++; return true; };
    });

    const before = await page.evaluate(SNAP);
    check(tag + ': 进入日志页且初始有日志可清', before.page === 'logs' && before.children > 0 && before.text === '清空' && !before.armed, { page: before.page, children: before.children, text: before.text, count: before.count });

    /* 第一次点:上膛,但一条都不能少 */
    await page.click('#logsClear');
    await sleep(150);
    const armed = await page.evaluate(SNAP);
    check(tag + ': 第一次点只上膛(文案「确认清空」+ .is-armed)', armed.text === '确认清空' && armed.armed, { text: armed.text, armed: armed.armed, color: armed.color });
    check(tag + ': 上膛时 aria-label 说明"再次点击确认"', armed.ariaLabel === '再次点击确认清空全部日志', armed.ariaLabel);
    check(tag + ': 第一次点不清空(条数/行数不变)', armed.children === before.children && armed.count === before.count, { before: { children: before.children, count: before.count }, after: { children: armed.children, count: armed.count } });
    check(tag + ': 上膛时没有 window.confirm()', armed.confirmCalls === 0, armed.confirmCalls);

    /* 3.2s 超时自动复位 */
    await sleep(3400);
    const disarmed = await page.evaluate(SNAP);
    check(tag + ': 3.4s 后自动复位(文案「清空」、类名/aria-label 摘掉)', disarmed.text === '清空' && !disarmed.armed && (disarmed.ariaLabel === null || disarmed.ariaLabel === ''), { text: disarmed.text, armed: disarmed.armed, ariaLabel: disarmed.ariaLabel });
    check(tag + ': 超时复位后日志仍在', disarmed.children === before.children, { children: disarmed.children, count: disarmed.count });

    /* 真正确认:两次点击,第二次才清 */
    await page.click('#logsClear');
    await sleep(200);
    const armed2 = await page.evaluate(SNAP);
    check(tag + ': 第二次上膛仍不清空', armed2.children === before.children && armed2.confirmCalls === 0, { children: armed2.children, confirmCalls: armed2.confirmCalls });
    await page.click('#logsClear');
    await sleep(600);
    const cleared = await page.evaluate(SNAP);
    check(tag + ': 第二次点击真的清空(列表归零)', cleared.children === 0 && String(cleared.count).trim() === '0', { children: cleared.children, count: cleared.count, hint: cleared.hint });
    check(tag + ': 清空后空态可见', cleared.emptyDisplay !== 'none' && cleared.emptyText.includes('还没有日志'), { display: cleared.emptyDisplay, text: cleared.emptyText });
    check(tag + ': 清空后按钮复位', cleared.text === '清空' && !cleared.armed, { text: cleared.text, armed: cleared.armed });
    check(tag + ': 全程没有 window.confirm()', cleared.confirmCalls === 0, cleared.confirmCalls);

    /* 空列表再点:提示而不是上膛 */
    await page.click('#logsClear');
    await sleep(200);
    const emptyClick = await page.evaluate(SNAP);
    check(tag + ': 空列表再点只提示、不进入上膛态', emptyClick.text === '清空' && !emptyClick.armed && emptyClick.hint.includes('还没有日志'), { text: emptyClick.text, armed: emptyClick.armed, hint: emptyClick.hint });
    check(tag + ': 无页面级 JS 报错', errors.length === 0, errors.slice(0, 5));

    const data = { before, armed, disarmed, armed2, cleared, emptyClick, errors };
    if (outDir) {
      await page.screenshot({ path: outDir + '/verify-logs-clear-' + (mobile ? 'mobile' : 'desktop') + '.png' });
      fs.writeFileSync(outDir + '/verify-logs-clear-' + (mobile ? 'mobile' : 'desktop') + '.json', JSON.stringify(data, null, 2));
    }
  } catch (e) {
    check(tag + ': 运行未抛异常', false, String(e && e.message || e));
  } finally {
    await browser.close();
  }
}

if (only === 'both' || only === 'desktop') await runCase('desktop');
if (only === 'both' || only === 'mobile') await runCase('mobile');
console.log(lines.join('\n'));
console.log('');
console.log(fails === 0 ? 'ALL PASS' : '未通过: ' + fails + ' 项');
process.exit(fails === 0 ? 0 : 1);
