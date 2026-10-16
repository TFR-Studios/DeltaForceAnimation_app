/* 全量交互态走查(常驻校验,不参与构建):
 * tools/verify-ui-motion.mjs 只检查一份写死的 15 项控件清单。这个脚本不看清单,
 * 把页面上**所有**可见的可交互元素(含画廊与导出浮层打开后的)找出来,逐个问样式表:
 * "你有没有 :hover / :active 规则?光标是不是手型?"
 * 漏掉一处悬停或按下反馈,是"界面感觉生硬"最常见的来源,而它不会报错、也不影响功能。
 * 两个已知的解析要点(都踩过):
 *   · 不能按逗号切规则 —— 会把 :is(a, b) 从中间切开,碎片无法解析,报出假阳性;
 *   · 要先把 :not(...) 整段去掉,否则 select:hover:not(:disabled) 清理出来是 select:not()。
 * 用法:node tools/verify-interactive-states.mjs [--url http://127.0.0.1:5173/]
 * 退出码 0 = 每一条都有悬停与按下反馈。 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:5173/');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && fs.existsSync(p));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => document.querySelector('#app-loading')?.classList.contains('is-hidden'), { timeout: 90000, polling: 250 });
await page.waitForFunction(() => document.querySelectorAll('fluent-button').length > 5, { timeout: 20000, polling: 100 }).catch(() => {});

const rows = await page.evaluate(async () => {
  /* 打开画廊与导出浮层,把它们内部的控件也纳入扫描 */
  document.getElementById('animTrigger').click();
  await new Promise((r) => setTimeout(r, 600));
  const ov = document.getElementById('exportOverlay');
  ov.hidden = false;
  document.getElementById('btnExportSave').hidden = false;
  document.getElementById('btnExportCancel').disabled = false;
  document.getElementById('btnExportCancel').textContent = '关闭';
  await new Promise((r) => setTimeout(r, 400));

  const rules = [];
  for (const sheet of document.styleSheets) {
    let list; try { list = sheet.cssRules; } catch { continue; }
    const walk = (arr) => {
      for (const rule of arr) {
        if (rule.cssRules && !rule.selectorText) { walk(rule.cssRules); continue; }
        if (!rule.selectorText) continue;
        rules.push({ sel: rule.selectorText, css: rule.style ? rule.style.cssText : '' });
      }
    };
    walk(list);
  }
  const bare = (part) => part.replace(/::[\w-]+(\([^)]*\))?/g, '').replace(/:(hover|active|focus-visible|focus|disabled)\b/g, '').trim();
  /* 按逗号切规则会把 :is(a, b) 从中间切开,于是 ' fluent-button):hover' 这种碎片
   * 变成无法解析的选择器,matches() 抛异常 → 被当成"没有悬停规则"(假阳性)。
   * 所以改成对整条选择器做一次清理,不切分。 */
  const clean = (s) => s
    .replace(/::[\w-]+(\([^)]*\))?/g, '')
    .replace(/:not\([^)]*\)/g, '')
    .replace(/:(hover|active|focus-visible|focus|focus-within|disabled|checked)\b/g, '')
    .trim();
  const matches = (el, s) => { if (!s) return false; try { return el.matches(s); } catch { return false; } };
  const has = (el, pseudo) => rules.some((r) => {
    if (!r.sel.includes(pseudo)) return false;
    return r.sel.split(',').some((part) => part.includes(pseudo)) && matches(el, clean(r.sel));
  });

  const sel = 'button, fluent-button, fluent-switch, fluent-toggle-button, select, .ap-card, .icon-item, .preset-item, .dw-row, input[type="checkbox"]';
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!(el instanceof HTMLElement)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const key = el.tagName.toLowerCase() + '.' + (typeof el.className === 'string' ? el.className : '') + '#' + el.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
    out.push({
      key,
      cursor: cs.cursor,
      hover: has(el, ':hover'),
      active: has(el, ':active'),
      disabled,
      w: Math.round(r.width), h: Math.round(r.height),
    });
  }
  return out;
});

const bad = rows.filter((r) => !r.disabled && (!r.hover || !r.active));
const noCursor = rows.filter((r) => !r.disabled && r.cursor !== 'pointer' && r.cursor !== 'grab');
console.log('扫描到可交互元素(去重): ' + rows.length);
console.log('\n缺少 :hover 或 :active 的:');
if (!bad.length) console.log('  (无)');
for (const r of bad) console.log('  ' + (r.hover ? '' : '无hover ') + (r.active ? '' : '无active ') + r.key);
console.log('\ncursor 不是 pointer/grab 的:');
if (!noCursor.length) console.log('  (无)');
for (const r of noCursor) console.log('  ' + r.cursor + '  ' + r.key);
await browser.close();
process.exit(bad.length ? 1 : 0);
