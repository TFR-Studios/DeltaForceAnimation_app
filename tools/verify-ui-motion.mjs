/* UI 动效走查(常驻校验,先跑一套 CSS 变更再看要不要用 CDP)
 * 查三件事:
 *   ① 每个控件的 :hover / :active 是否都有 CSS 定义(不依赖真实鼠标,靠解析样式表);
 *   ② 所有自身带 transform 的 :active 规则,是否都在 prefers-reduced-motion 段落里被取消;
 *   ③ reduced-motion 下是否存在"按下会产生位移/缩放"的漏网控件。
 * 为什么用解析而不是模拟鼠标:CSS.forcePseudoState 只能通过 CDP 用,且 dispatchEvent
 * 不会真的命中 :hover/:active —— 解析样式表是这里唯一可靠的口径。 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const url = process.argv[2];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => document.querySelector('#app-loading')?.classList.contains('is-hidden'), { timeout: 120000, polling: 250 }).catch(() => {});
await page.waitForFunction(() => document.querySelectorAll('fluent-button').length > 5, { timeout: 20000, polling: 100 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1000));
await page.evaluate(() => document.getElementById('animTrigger').click());
await new Promise((r) => setTimeout(r, 700));

const CONTROLS = [
  ['顶栏·下载入口', '#btnDownloads'],
  ['顶栏·主题按钮', '.theme-btn'],
  ['顶栏·动画触发器', '.anim-trigger'],
  ['播放条·图标按钮', '.transport .icon-btn'],
  ['播放条·播放', '#btnPlay'],
  ['播放条·复位视图', '#btnResetView'],
  ['播放条·导出', '#btnExport'],
  ['侧栏·图层重置', '.t-reset'],
  ['侧栏·勾选行', '.popup-toggle'],
  ['侧栏·预设项', '.preset-toggle'],
  ['侧栏·主题重置', '#themeReset'],
  ['画廊·关闭', '#animPickerClose'],
  ['画廊·卡片', '.ap-card'],
  ['画廊·搜索清空', '.ap-search-clear'],
  ['画廊·卡片选中图标', '.ap-card-pick'],
];

const res = await page.evaluate((CONTROLS) => {
  const rows = [];
  /* 收集全部分组规则:{selector, props, inReducedMotion} */
  const rules = [];
  for (const sheet of document.styleSheets) {
    let list; try { list = sheet.cssRules; } catch (e) { continue; }
    const walk = (arr, reduced) => {
      for (const rule of arr) {
        if (rule.cssRules && !rule.selectorText) {
          const isRM = rule.conditionText ? /prefers-reduced-motion/.test(rule.conditionText) : false;
          walk(rule.cssRules, reduced || isRM);
          continue;
        }
        if (!rule.selectorText) continue;
        rules.push({ sel: rule.selectorText, css: rule.style ? rule.style.cssText : '', reduced });
      }
    };
    walk(list, false);
  }
  for (const [label, sel] of CONTROLS) {
    const el = document.querySelector(sel);
    if (!el) { rows.push({ label, missing: true }); continue; }
    /** 把选择器里的伪类去掉,只留"哪个元素"。'::part(...)' 先整体删掉 —— 否则去掉伪类后
     *  会剩下一个无法解析的选择器,matches() 直接抛异常,统计出来的"没定义"就全是假的。 */
    const bare = (part) => part.replace(/::[\w-]+(\([^)]*\))?/g, '').replace(/:(hover|active|focus-visible|focus)\b/g, '').trim();
    const matches = (s) => { if (!s) return false; try { return el.matches(s); } catch (e) { return false; } };
    const groupHas = (pseudo) => rules.some((r) => r.sel.split(',').some((part) => part.includes(pseudo) && matches(bare(part))));
    /* 按下会不会产生位移/缩放,以及 reduced-motion 里有没有取消它 */
    const hasActiveTransform = (r) => r.sel.split(',').some((part) => part.includes(':active') && matches(bare(part)));
    const activeScales = rules.filter((r) => hasActiveTransform(r) && /transform\s*:/.test(r.css) && !r.reduced).length;
    const rmCancels = rules.some((r) => r.reduced && /transform\s*:\s*none/.test(r.css) && hasActiveTransform(r));
    rows.push({ label, hover: groupHas(':hover'), active: groupHas(':active'), activeScales, rmCancels });
  }
  return rows;
}, CONTROLS);

let fail = 0;
console.log('控件'.padEnd(20) + '悬停  按下  按下会缩放  减少动效时已取消');
for (const r of res) {
  if (r.missing) { console.log(String(r.label).padEnd(18) + ' (未找到)'); fail++; continue; }
  const mark = (b) => (b ? ' ✓  ' : ' ✗  ');
  const ok = r.hover && r.active && (r.activeScales === 0 || r.rmCancels);
  if (!ok) fail++;
  console.log(String(r.label).padEnd(18) + ' ' + mark(r.hover) + ' ' + mark(r.active) + '     ' + String(r.activeScales).padEnd(8) + '  ' + mark(r.activeScales === 0 || r.rmCancels));
}
/* ---------- 浮层退场:必须"先播退场动画、再 display:none" ----------
 * 只看 CSS 定义不够 —— 真正的坑在状态机上:漏了 is-closing 就是瞬间消失,忘记收尾
 * 就是浮层永远盖着。这里直接点「关闭」按钮,观察类名与最终状态。 */
const overlay = await page.evaluate(async () => {
  const ov = document.getElementById('exportOverlay');
  const btn = document.getElementById('btnExportCancel');
  if (!ov || !btn) return { error: '找不到导出浮层或关闭按钮' };
  ov.hidden = false;
  const before = { hidden: ov.hidden, closing: ov.classList.contains('is-closing') };
  btn.click();
  await new Promise((r) => setTimeout(r, 30));
  const during = { hidden: ov.hidden, closing: ov.classList.contains('is-closing'), anim: getComputedStyle(ov).animationName };
  await new Promise((r) => setTimeout(r, 420));
  const after = { hidden: ov.hidden, closing: ov.classList.contains('is-closing') };
  return { before, during, after };
});
const overlayOk = !overlay.error && overlay.during.closing && overlay.during.anim === 'df-overlay-out' && overlay.after.hidden && !overlay.after.closing;
console.log('\n导出浮层退场:' + (overlayOk ? ' ✓ ' : ' ✗ ') + JSON.stringify(overlay));
if (!overlayOk) fail++;

console.log('\n未通过:' + fail + ' 项');
await browser.close();
process.exit(fail ? 1 : 0);
