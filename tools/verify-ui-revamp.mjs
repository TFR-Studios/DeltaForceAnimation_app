/* 界面改版(2026-10 追加一轮)的常驻校验:把"这一轮到底改对了没有"逐条量出来。
 * 覆盖九件事:
 *   1) 滑杆自绘后每个 input[type=range] 都有填充比例(--range-fill);
 *   2) 没有按钮再被 Fluent 的 96px 最小宽度撑住(曾把画廊关闭按钮撑成 96×32、
 *      把搜索框里的清空按钮撑成 96px 宽、把搜索输入区挤到 150px);
 *   3) 状态栏长文案真的出省略号(而不是被硬切);
 *   4) 主题切换会挂上 is-theme-fading 并在 260ms 后摘掉(不常驻接管 hover 过渡);
 *   5) 切换动画时舞台的扫描线与画布落定真的在播、播完就收、类名被摘掉;
 *   6) 播放中的呼吸环随暂停消失;
 *   7) 导出浮层三个动作按钮的样式(实心主按钮、36px 高、10px 圆角、112px 最小宽);
 *   8) 窄屏顶栏不再出现"主题开关独自折到左边"的孤儿控件;
 *   9) 开关本体仍是 36×18,但带一层外扩命中区;
 *  10) 侧栏区块跳转:选项按"实际显示的区块"生成、标签不带计数、跳转后标题进视口、
 *      「显示弹窗」开关可见可命中可开弹窗,以及**切走再切回撤离动画时「弹窗图层」不会消失**
 *      (这是本轮修掉的一个真实数据 bug,见文件里那段注释)。
 * 用法:node tools/verify-ui-revamp.mjs   (需要开发服务器在 5173)
 * 退出码 0 = 全部通过。 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && fs.existsSync(p));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => document.querySelector('#app-loading')?.classList.contains('is-hidden'), { timeout: 90000, polling: 250 });
await new Promise((r) => setTimeout(r, 1500));

const lines = [];
let fails = 0;
const check = (n, ok, d) => { if (!ok) fails++; lines.push((ok ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '   ' + JSON.stringify(d) : '')); };

/* ---------- 0. 首屏(未做任何切换)的撤离动画弹窗 ----------
 * 这一条必须在其它会切动画的检查之前跑:首屏**不经过 switchAnimation**,弹窗数据的落位
 * 由 bootApp 单独负责。踩过一次:把"当前动画的弹窗数据"和"撤离动画自己的素材缓存"分开存之后,
 * bootApp 里读的还是那个没人赋值的槽,结果首屏的「弹窗文字」列表是空的、
 * 「显示弹窗」点了也没反应(自检的侧栏条目从 36 掉到 35 就是这个)。 */
const boot = await page.evaluate(async () => {
  const list = document.querySelectorAll('#popupTextList li').length;
  const shapes = document.querySelectorAll('#popupShapeList li').length;
  const sec = document.getElementById('popupSection');
  const sw = document.getElementById('chkPopup');
  sw.click();
  await new Promise((r) => setTimeout(r, 700));
  const on = { checked: sw.checked, popupShown: !document.getElementById('popupLayer').hidden };
  sw.click();
  await new Promise((r) => setTimeout(r, 300));
  return { list, shapes, hidden: sec.hidden, on };
});
check('首屏:「弹窗图层」可见且弹窗文字/颜色列表已渲染', boot.hidden === false && boot.list >= 1 && boot.shapes >= 1, boot);
check('首屏:「显示弹窗」能真的打开弹窗(bootApp 已把弹窗数据落位)', boot.on.checked === true && boot.on.popupShown === true, boot.on);

/* ---------- 1. 滑杆:自绘轨道 + 已选进度 ---------- */
const range = await page.evaluate(() => {
  const r = document.getElementById('rngFrame');
  const cs = getComputedStyle(r);
  const fill0 = r.style.getPropertyValue('--range-fill');
  /* 把它拖到 80%,看委托监听是否把进度写进去 */
  r.value = String(Math.round(Number(r.min) + (Number(r.max) - Number(r.min)) * 0.8));
  r.dispatchEvent(new Event('input', { bubbles: true }));
  const fill80 = r.style.getPropertyValue('--range-fill');
  const all = [...document.querySelectorAll('input[type="range"]')].map((el) => ({
    id: el.id || el.className, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height),
    fill: el.style.getPropertyValue('--range-fill'), appearance: getComputedStyle(el).appearance,
  }));
  return { fill0, fill80, appearance: cs.appearance, height: Math.round(r.getBoundingClientRect().height), all };
});
check('滑杆已自绘(appearance: none)', range.appearance === 'none', range.appearance);
check('滑杆拖动后写入 --range-fill ≈ 80%', /7[5-9](\.\d)?%|8[0-5](\.\d)?%/.test(range.fill80), { before: range.fill0, after: range.fill80 });
check('每个滑杆都有填充比例(无空值)', range.all.every((r) => r.fill !== ''), range.all);

/* ---------- 2. Fluent 最小宽度泄漏 ---------- */
const mw = await page.evaluate(() => {
  const list = [...document.querySelectorAll('fluent-button, fluent-toggle-button')]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => ({ id: el.id || el.className, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), minW: getComputedStyle(el).minWidth }))
    .filter((x) => x.w === 96 || x.minW === '96px');
  return list;
});
check('没有按钮被 Fluent 的 96px 最小宽度顶住', mw.length === 0, mw);

/* ---------- 3. 状态栏省略号 ---------- */
const sb = await page.evaluate(() => {
  const text = document.getElementById('statusbarText');
  const host = document.getElementById('statusbar');
  /* 写进内层 span,再从外层读 —— 这正是校验脚本读状态栏的方式 */
  text.textContent = '探针写入';
  const readBackFromHost = host.textContent;
  return {
    hasSpan: !!text,
    readBackFromHost,
    spanOverflow: getComputedStyle(text).textOverflow,
    spanEllipsisWorks: (() => {
      text.textContent = '导出失败:编码器初始化失败(WebCodecs 不可用),已自动降级到 AVI 自封装,请检查磁盘剩余空间后重试。'.repeat(3);
      const clipped = text.scrollWidth > text.clientWidth + 1;
      const cs = getComputedStyle(text);
      text.textContent = '就绪';
      return clipped && cs.textOverflow === 'ellipsis' && cs.overflow === 'hidden';
    })(),
    hostTextAfterRestore: host.textContent.trim(),
  };
});
check('状态栏文案在内层 span 上,外层 textContent 仍读得到', sb.hasSpan && sb.readBackFromHost === '探针写入', sb);
check('长状态文案会被省略号截断(不再是硬切)', sb.spanEllipsisWorks, sb);

/* ---------- 4. 主题切换:过渡类 + 颜色跟随 ---------- */
const theme = await page.evaluate(async () => {
  const root = document.documentElement;
  const btn = document.querySelector('.theme-btn[data-theme="light"]');
  btn.click();
  const during = {
    fading: root.classList.contains('is-theme-fading'),
    theme: root.dataset.theme,
    transitionOnBody: getComputedStyle(document.body).transitionProperty,
  };
  await new Promise((r) => setTimeout(r, 420));
  return { during, after: { fading: root.classList.contains('is-theme-fading'), theme: root.dataset.theme, bg: getComputedStyle(document.body).backgroundColor } };
});
check('切浅色时挂上 is-theme-fading', theme.during.fading && theme.during.theme === 'light', theme.during);
check('过渡覆盖颜色属性', /background-color/.test(theme.during.transitionOnBody), theme.during.transitionOnBody);
check('220ms 后过渡类被摘掉(不会常驻接管 hover)', !theme.after.fading, theme.after);
await page.evaluate(() => document.querySelector('.theme-btn[data-theme="dark"]').click());
await new Promise((r) => setTimeout(r, 400));

/* ---------- 5. 舞台落定:切换动画时扫描线 + 画布落定真的播 ---------- */
await page.evaluate(() => {
  window.__stageSamples = [];
  const stage = document.getElementById('stage');
  const scan = document.getElementById('stageScan');
  window.__stageObserver = new MutationObserver(() => {
    if (!stage.classList.contains('is-registering')) return;
    window.__stageSamples.push({
      t: Math.round(performance.now()),
      scanAnim: getComputedStyle(scan).animationName,
      scanOpacity: getComputedStyle(scan).opacity,
      canvasAnim: getComputedStyle(document.querySelector('.preview-canvas')).animationName,
      canvasFilter: getComputedStyle(document.querySelector('.preview-canvas')).filter,
    });
  });
  window.__stageObserver.observe(stage, { attributes: true, attributeFilter: ['class'] });
});
await page.select('#selAnim', 'exposed');
await new Promise((r) => setTimeout(r, 250));
const scanMid = await page.evaluate(() => ({
  registering: document.getElementById('stage').classList.contains('is-registering'),
  scanAnim: getComputedStyle(document.getElementById('stageScan')).animationName,
  scanTransform: getComputedStyle(document.getElementById('stageScan')).transform,
  canvasAnim: getComputedStyle(document.querySelector('.preview-canvas')).animationName,
  canvasOpacity: getComputedStyle(document.querySelector('.preview-canvas')).opacity,
  samples: window.__stageSamples.length,
}));
check('切动画时舞台进入 is-registering', scanMid.registering && scanMid.samples > 0, scanMid);
check('扫描线动画在播(df-stage-scan)', scanMid.scanAnim === 'df-stage-scan' && scanMid.scanTransform !== 'none', { anim: scanMid.scanAnim, tf: scanMid.scanTransform });
check('画布落定动画在播(df-canvas-lock)', scanMid.canvasAnim === 'df-canvas-lock', scanMid.canvasAnim);
await new Promise((r) => setTimeout(r, 1500));
const scanEnd = await page.evaluate(() => ({
  registering: document.getElementById('stage').classList.contains('is-registering'),
  scanAnim: getComputedStyle(document.getElementById('stageScan')).animationName,
  scanOpacity: getComputedStyle(document.getElementById('stageScan')).opacity,
  canvasOpacity: getComputedStyle(document.querySelector('.preview-canvas')).opacity,
  status: document.getElementById('statusbar').textContent.trim(),
}));
check('落定结束后类被摘掉、扫描线不可见、画布不透明',
  !scanEnd.registering && Number(scanEnd.scanOpacity) === 0 && Number(scanEnd.canvasOpacity) === 1, scanEnd);

/* ---------- 6. 播放中的呼吸环 ---------- */
const live = await page.evaluate(async () => {
  const btn = document.getElementById('btnPlay');
  const ring = () => {
    const cs = getComputedStyle(btn, '::after');
    return { content: cs.content, display: cs.display, anim: cs.animationName, border: cs.borderTopWidth };
  };
  const before = ring();
  btn.click();
  await new Promise((r) => setTimeout(r, 200));
  const playing = { pressed: btn.getAttribute('aria-pressed'), ...ring() };
  btn.click();
  await new Promise((r) => setTimeout(r, 200));
  return { before, playing, paused: { pressed: btn.getAttribute('aria-pressed'), ...ring() } };
});
check('播放时呼吸环出现(df-live-ring)', live.playing.pressed === 'true' && live.playing.anim === 'df-live-ring' && live.playing.content !== 'none', live.playing);
check('暂停后呼吸环不再生成', live.paused.pressed === 'false' && live.paused.content === 'none', live.paused);

/* ---------- 7. 导出浮层按钮样式恢复 ---------- */
const exp = await page.evaluate(async () => {
  const ov = document.getElementById('exportOverlay');
  ov.hidden = false;
  document.getElementById('btnExportSave').hidden = false;
  document.getElementById('btnExportRedownload').hidden = false;
  /* 等入场动画(240ms)播完再量:df-overlay-in 会 scale(0.985),
   * 在动画中途量出来的宽高都会偏小(踩过一次:112px 量成 110px)。 */
  await new Promise((r) => setTimeout(r, 360));
  const g = (id) => {
    const el = document.getElementById(id);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), radius: cs.borderRadius, border: cs.borderWidth, bg: cs.backgroundColor, color: cs.color, font: cs.fontSize };
  };
  const out = { save: g('btnExportSave'), redl: g('btnExportRedownload'), cancel: g('btnExportCancel') };
  const acts = document.querySelector('.export-actions');
  out.gapToRight = Math.round(acts.getBoundingClientRect().right - document.getElementById('btnExportCancel').getBoundingClientRect().right);
  ov.hidden = true;
  return out;
});
check('导出浮层主按钮恢复实心品牌底 + 反白字',
  exp.save.bg === 'rgb(226, 226, 232)' && exp.save.color === 'rgb(26, 26, 28)', exp.save);
check('导出浮层按钮恢复 36px 高 / 10px 圆角 / 112px 最小宽',
  exp.save.h === 36 && exp.save.radius === '10px' && exp.save.w >= 112, exp.save);
check('次级按钮有描边且是面板底色', exp.cancel.border !== '0px' && exp.cancel.bg === 'rgb(43, 43, 46)', exp.cancel);
check('动作按钮贴右下(gap ≤ 卡片内边距)', exp.gapToRight <= 24, exp.gapToRight);

/* ---------- 8. 窄屏顶栏不再出现"孤儿"主题开关 ---------- */
const topbars = {};
for (const w of [768, 900, 390]) {
  await page.setViewport({ width: w, height: 900 });
  await new Promise((r) => setTimeout(r, 400));
  topbars[w] = await page.evaluate(() => {
    const tb = document.querySelector('.topbar');
    const sw = document.querySelector('.theme-switch');
    const as = document.querySelector('.anim-switch');
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), right: Math.round(b.right), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { topbarH: Math.round(tb.getBoundingClientRect().height), sw: r(sw), anim: r(as), vw: innerWidth, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
}
/* 判据是"主题开关落在右半屏并且贴右" —— 它不必与动画选择器同行:
 * 768px 上动画选择器占满第一行,主题开关独占第二行并停在最右边,这才是要的结果。 */
check('768px:主题开关靠右(不独占左侧)', topbars[768].sw.right >= topbars[768].vw - 20 && topbars[768].sw.x > topbars[768].vw / 2, topbars[768]);
check('390px:主题开关贴右、动画触发器占满剩余宽度', topbars[390].sw.right >= topbars[390].vw - 20 && topbars[390].anim.x <= 20, topbars[390]);
check('各宽度均无横向溢出', [768, 900, 390].every((w) => topbars[w].overflowX <= 0), Object.fromEntries(Object.entries(topbars).map(([k, v]) => [k, v.overflowX])));

/* ---------- 9. 开关命中区 ---------- */
await page.setViewport({ width: 1600, height: 1000 });
await new Promise((r) => setTimeout(r, 300));
const swHit = await page.evaluate(() => {
  const sw = document.getElementById('chkLoop');
  const r = sw.getBoundingClientRect();
  const before = getComputedStyle(sw, '::before');
  return { w: Math.round(r.width), h: Math.round(r.height), hitInset: before.inset, hitTop: before.top, hitBottom: before.bottom, position: getComputedStyle(sw).position };
});
check('开关本体仍 36×18 但带一层外扩命中区', swHit.h === 18 && swHit.position === 'relative' && /-7px/.test(swHit.hitTop + swHit.hitBottom), swHit);

/* ---------- 10. 侧栏区块跳转 + 「弹窗图层」不会消失 ----------
 * 第 2 条断言守的是一个真实 bug:extraction 的 popup() 原来读的是"当前动画的弹窗数据"
 * popupData,而切到任一无弹窗的动画时那个变量会被写成 null —— 再切回撤离动画,
 * def.popup() 读到的就是这个 null,侧栏「弹窗图层」整块隐藏,且因为 bootDataPromise 已 resolved
 * 不会重新下载,整场会话都回不来(状态栏也不报错)。用户看到的正是"按钮不见了"。 */
await page.setViewport({ width: 1600, height: 1000 });
await page.evaluate(() => { window.localStorage.removeItem('dfae.ui.anim-used.v1'); });
const readSideNav = () => page.evaluate(() => {
  const nav = document.getElementById('sideNav');
  const sel = document.getElementById('sideNavSelect');
  const side = document.querySelector('.side-panel');
  const navR = nav.getBoundingClientRect();
  return {
    hidden: nav.hidden,
    h: Math.round(navR.height),
    options: [...sel.options].map((o) => o.textContent),
    value: sel.value,
    label: sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : null,
    navVarH: getComputedStyle(side).getPropertyValue('--side-nav-h').trim(),
    popupHidden: document.getElementById('popupSection').hidden,
    sideMax: side.scrollHeight - side.clientHeight,
    sideTop: Math.round(side.getBoundingClientRect().top),
  };
});
await page.select('#selAnim', 'extraction');
await new Promise((r) => setTimeout(r, 2600));
const navA = await readSideNav();
check('撤离动画:跳转条列出全部 5 个区块', navA.hidden === false && navA.options.length === 5, navA.options);
check('区块名不带计数(「文字图层」而不是「文字图层 · 13 个」)', navA.options.every((t) => !/·|\d/.test(t)), navA.options);
check('跳转条高 40px,标题吸顶偏移跟着它(不会叠在一起)', navA.h === 40 && navA.navVarH === '40px', { h: navA.h, navVarH: navA.navVarH });

/* 切到无弹窗的动画再切回来 —— 「弹窗图层」必须还在 */
await page.select('#selAnim', 'maptitle');
await new Promise((r) => setTimeout(r, 2200));
const navMid = await readSideNav();
await page.select('#selAnim', 'extraction');
await new Promise((r) => setTimeout(r, 2600));
const navB = await readSideNav();
check('切到别的动画时该动画不列「弹窗图层」', !navMid.options.includes('弹窗图层'), navMid.options);
check('切走再切回撤离动画,「弹窗图层」仍然在(修掉的 bug)', navB.options.includes('弹窗图层') && navB.popupHidden === false, { options: navB.options, popupHidden: navB.popupHidden });

/* 选中「弹窗图层」:标题要进视口、开关要可见可命中、点一下真的要能开弹窗 */
const jump = await page.evaluate(async () => {
  const sel = document.getElementById('sideNavSelect');
  const side = document.querySelector('.side-panel');
  const nav = document.getElementById('sideNav');
  const idx = [...sel.options].findIndex((o) => o.textContent === '弹窗图层');
  sel.selectedIndex = idx;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const h3 = [...side.querySelectorAll('h3')].find((h) => h.textContent.includes('弹窗图层'));
  const h3r = h3.getBoundingClientRect();
  const sw = document.getElementById('chkPopup');
  const swr = sw.getBoundingClientRect();
  const hit = document.elementFromPoint(swr.x + swr.width / 2, swr.y + swr.height / 2);
  const flashed = h3.classList.contains('is-nav-target');
  /* 真点一下:开弹窗 */
  if (sw.checked) sw.click();
  await new Promise((r) => setTimeout(r, 60));
  const on = document.elementFromPoint(swr.x + swr.width / 2, swr.y + swr.height / 2);
  (on || sw).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  await new Promise((r) => setTimeout(r, 600));
  return {
    idx, flashed, value: sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : null,
    h3Top: Math.round(h3r.top), sideTop: Math.round(side.getBoundingClientRect().top),
    h3Visible: h3r.top >= 0 && h3r.top < innerHeight,
    switchHit: hit ? hit.tagName.toLowerCase() + '#' + hit.id : null,
    switchVisible: swr.top >= 0 && swr.bottom <= innerHeight,
    checked: sw.checked, popupShown: !document.getElementById('popupLayer').hidden,
    scrollTop: Math.round(side.scrollTop), max: side.scrollHeight - side.clientHeight,
  };
});
check('选「弹窗图层」后该区块标题进入视口并闪一次落点提示', jump.idx >= 0 && jump.flashed && jump.h3Visible, jump);
check('跳过去之后「显示弹窗」开关可见、可命中', jump.switchVisible && jump.switchHit === 'fluent-switch#chkPopup', jump);
check('点「显示弹窗」真的把弹窗显示出来(修复验证)', jump.checked === true && jump.popupShown === true, jump);
check('跳到最后一个区块时跟随读数不回退(到底认最后一节)', jump.value === '弹窗图层', jump);
if (jump.popupShown) {
  await page.evaluate(() => { const sw = document.getElementById('chkPopup'); if (sw.checked) sw.click(); });
}

/* 滚动跟随:顶部认第一节、底部认最后一节 */
const spy = await page.evaluate(async () => {
  const side = document.querySelector('.side-panel');
  const sel = document.getElementById('sideNavSelect');
  const read = () => (sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : null);
  side.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 400));
  const top = read();
  side.scrollTop = side.scrollHeight;
  await new Promise((r) => setTimeout(r, 500));
  const bottom = read();
  const h3TopWhenStuck = (() => {
    const h3 = [...side.querySelectorAll('h3')].find((h) => h.textContent.includes('形状图层'));
    return h3 ? Math.round(h3.getBoundingClientRect().top) : null;
  })();
  side.scrollTop = 0;
  return { top, bottom, h3TopWhenStuck, last: sel.options[sel.options.length - 1].textContent };
});
check('滚动跟随:顶部认第一节', spy.top === '动画信息', spy);
check('滚动跟随:底部认最后一节', spy.bottom === spy.last, spy);

await browser.close();
lines.push('');
lines.push('无页面级 JS 报错: ' + (errs.length === 0 ? 'OK' : JSON.stringify(errs)));
if (errs.length) fails++;
console.log(lines.join('\n'));
console.log('未通过: ' + fails + ' 项');
process.exit(fails ? 1 : 0);
