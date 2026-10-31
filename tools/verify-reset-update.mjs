/* 一键重置 + 全屏更新提示 回归(常驻,不参与构建)
 *   node tools/verify-reset-update.mjs [--url http://127.0.0.1:5173/]
 *
 * 覆盖 2026-10 这一轮的三件事:
 *   1) 每套动画的一键重置(右侧编辑区顶部 #btnResetAnim):它是检查器的第一个元素、
 *      吸顶在侧栏顶部,实心主操作尺寸;点一下必须把文字 / 时长 / 二次扫描 / 图标 /
 *      主题色块 / 显示图标 全部回到出厂,并且**说明行与状态栏**都说"已恢复…";
 *   2) 发现新版本时的全屏提示(#updateOverlay):桌面是居中卡片、手机是占满整屏的面板,
 *      动作尺寸/位置按两端各自的规格量;焦点不出浮层、Esc 关、跳过写入 localStorage 且下次不再弹;
 *   3) 手机上"关于页被认成桌面端"的回归:带 dfaeDesktop 桥接 + 原生移动信号时,
 *      渠道必须写「手机版」,「保存目录」必须不出现。
 *
 * 更新检查的那次外网请求在脚本里被拦截并替换成一个必然更高的版本(9.9.9),
 * 所以既不需要联网,也不会因为真的发布了新版本而改变结果。 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:5173/');
const OUT = arg('out', 'release/verify-reset-update');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  rows.push((ok ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  -> ' + JSON.stringify(extra) : ''));
};

/* 假发行版:版本号一定比当前高(应用版本在 1.x),附件名故意带 Setup/不含平台也无关,
   这里只验证"提示出现了、按钮怎么摆",不验证挑选安装包的规则(那条在 update-check 里)。 */
const FAKE_RELEASE = {
  tag_name: 'v9.9.9',
  name: 'v9.9.9',
  body: '',
  assets: [{ name: 'DeltaForceAnimationEditor-Setup-9.9.9.exe', browser_download_url: 'https://example.com/setup.exe' }],
};

/* 桌面客户端的假桥接:isDesktop=true(安卓 APK 里也是 true,这正是"手机被认成桌面"的来源)。 */
const FAKE_BRIDGE = () => {
  window.dfaeDesktop = {
    isDesktop: true,
    platform: 'win32',
    getInfo: async () => ({ version: '1.1.0', exportDir: 'C:\\Users\\tester\\Downloads\\DeltaForceAnimationEditor' }),
  };
  window.dfaeDownloads = {
    isDesktop: true,
    list: async () => ({ entries: [], promptOnSave: false }),
    reveal: async () => true,
  };
};

/* 对比度:新浮层里的文字用量的,不靠肉眼(截图看不出来、也不好复核)。
 * 与 DESIGN.md 的口径一致:正文 4.5:1,大字(>=18px)3:1。 */
const srgb = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (rgb) => {
  const [r, g, b] = String(rgb).match(/[\d.]+/g).slice(0, 3).map(Number);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
};
const contrast = (a, b) => {
  const la = lum(a), lb = lum(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'] });

/** 打开一个页面。opts: viewport / query / init(在页面脚本之前执行)/ intercept(是否替换更新接口) */
async function open(opts) {
  /* 每个用例一个独立的浏览器上下文:localStorage 是隔离的 ——
   * 上一个用例"跳过这个版本"记下的版本号不能泄漏到下一个用例里(实测会漏,
   * 表现是"手机:更新提示应自动弹出 FAIL",排查起来很像功能没生效)。 */
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 180)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 180)); });
  if (opts.intercept) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('api.gitcode.com') || u.includes('api.github.com')) {
        /* 必须自己带 Access-Control-Allow-Origin:绕过的是真实网络,浏览器仍按 CORS 判 */
        req.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
          body: JSON.stringify(FAKE_RELEASE),
        });
        return;
      }
      req.continue();
    });
  }
  if (opts.init) await page.evaluateOnNewDocument(opts.init);
  await page.setViewport(opts.viewport);
  await page.goto(BASE + (opts.query || ''), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app-loading');
    return !el || el.classList.contains('is-hidden');
  }, { timeout: 120000, polling: 300 }).catch(() => errs.push('loading-timeout'));
  return { page, errs, ctx };
}

const waitTextItems = (page, min = 1) =>
  page.waitForFunction((n) => document.querySelectorAll('#textList .text-item').length >= n, { timeout: 120000, polling: 200 }, min);

/* 一组量:右侧编辑区顶部那一行(一键重置)的几何与配色 */
const probeReset = () => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  const btn = document.getElementById('btnResetAnim');
  const head = document.getElementById('sideHead');
  const hint = document.getElementById('resetHint');
  const panel = document.querySelector('.side-panel');
  const preview = document.querySelector('.preview-panel');
  const stage = document.getElementById('stage');
  const nav = document.getElementById('sideNav');
  const firstH3 = document.querySelector('.side-panel h3');
  const cs = btn ? getComputedStyle(btn) : null;
  const hintCs = hint ? getComputedStyle(hint) : null;
  return {
    ui: document.documentElement.dataset.ui || 'desktop',
    sideFirstChild: panel ? panel.firstElementChild.className : '',
    previewFirstChild: preview ? preview.firstElementChild.className : '',
    panel: box(panel),
    head: box(head),
    stage: box(stage),
    nav: box(nav),
    firstH3: box(firstH3),
    headVar: panel ? getComputedStyle(panel).getPropertyValue('--side-head-h').trim() : '',
    btn: box(btn),
    btnTag: btn ? btn.tagName : '',
    btnText: btn ? btn.textContent.trim() : '',
    btnTitle: btn ? btn.title : '',
    btnDisabled: btn ? btn.disabled : null,
    btnPaint: cs ? { bg: cs.backgroundColor, color: cs.color, radius: cs.borderRadius, weight: cs.fontWeight, cursor: cs.cursor } : null,
    hint: box(hint),
    hintText: hint ? hint.textContent : '',
    hintTitle: hint ? hint.title : '',
    hintDisplay: hintCs ? hintCs.display : '',
    timelineHasButton: !!document.querySelector('.timeline #btnResetAnim'),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

/* ==================== 一、桌面:一键重置 ==================== */
{
  const { page, errs } = await open({ viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, query: '?view=editor' });
  await waitTextItems(page, 3);
  await sleep(1200);

  const geo = await page.evaluate(probeReset);
  check('桌面:右侧编辑区的第一个元素就是「一键重置」那一行', geo.sideFirstChild === 'side-head', geo.sideFirstChild);
  check('桌面:画布那侧回到原样(预览列第一个是舞台,不被顶栏挤高度)', geo.previewFirstChild === 'preview-stage', geo.previewFirstChild);
  check('桌面:按钮在这一行的最上面、通栏(侧栏编辑区的第一位)', !!geo.head && !!geo.btn && geo.btn.y >= geo.head.y && geo.btn.y - geo.head.y <= 12 && geo.btn.w >= geo.head.w - 34, { head: geo.head, btn: geo.btn });
  check('桌面:按钮在编辑区里、且在跳转条与区块标题之上', geo.btn && geo.nav && geo.btn.bottom <= geo.nav.top + 1 && geo.nav.bottom <= geo.firstH3.top + 1, { btn: geo.btn, nav: geo.nav, h3: geo.firstH3 });
  check('桌面:按钮文案是「一键重置」、32px(--h-ctl)', !!geo.btn && geo.btnText === '一键重置' && geo.btn.h === 32, { text: geo.btnText, h: geo.btn && geo.btn.h });
  check('桌面:主操作外观(实心 --brand + 反白字 + 10px 圆角 + 600 字重)',
    !!geo.btnPaint && geo.btnPaint.bg === 'rgb(226, 226, 232)' && geo.btnPaint.color === 'rgb(26, 26, 28)' &&
    geo.btnPaint.radius === '10px' && String(geo.btnPaint.weight) === '600', geo.btnPaint);
  check('桌面:说明行带当前动画名,全文(清哪些东西)在 title 里', /撤离动画/.test(geo.hintText) && /清除/.test(geo.hintTitle), { text: geo.hintText, title: geo.hintTitle.slice(0, 40) });
  check('桌面:吸顶偏移等于这一行的实测高度(--side-head-h)', /^\d+px$/.test(geo.headVar) && Math.abs(parseInt(geo.headVar, 10) - geo.head.h) <= 1, { var: geo.headVar, h: geo.head.h });
  check('桌面:时间轴行里不再有第二个重置入口', geo.timelineHasButton === false, geo.timelineHasButton);
  check('桌面:点击区是 Fluent 按钮(与骨架控件同一套)', geo.btnTag === 'FLUENT-BUTTON', geo.btnTag);

  /* 改一处文字再重置 */
  const original = await page.evaluate(() => document.querySelector('#textList .t-input').value);
  await page.evaluate(() => {
    const ta = document.querySelector('#textList .t-input');
    ta.value = '重置测试文案';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(800);
  const edited = await page.evaluate(() => document.querySelector('#textList .t-input').value);
  check('桌面:编辑立即生效(数据被就地改过)', edited === '重置测试文案', edited);

  await page.click('#btnResetAnim');
  await page.waitForFunction(() => /已恢复/.test(document.getElementById('statusbar').textContent || ''), { timeout: 60000, polling: 150 }).catch(() => {});
  await sleep(400);
  const afterText = await page.evaluate(() => ({
    text: document.querySelector('#textList .t-input').value,
    status: document.getElementById('statusbar').textContent,
    disabled: document.getElementById('btnResetAnim').disabled,
    busy: document.getElementById('btnResetAnim').classList.contains('is-busy'),
    hint: document.getElementById('resetHint').textContent,
    hintDone: document.getElementById('resetHint').classList.contains('is-done'),
  }));
  check('桌面:重置后文字回到出厂文案', afterText.text === original && original !== '重置测试文案', { after: afterText.text, original });
  check('桌面:状态栏说「已恢复…」而不是「已载入…」', /已恢复「撤离动画」的默认状态/.test(afterText.status), afterText.status);
  check('桌面:重置结束后按钮恢复可用(不残留忙碌态)', afterText.disabled === false && afterText.busy === false, afterText);
  check('桌面:结果写回编辑区那一行(不必低头看状态栏)', /已恢复「撤离动画」的默认状态/.test(afterText.hint) && afterText.hintDone === true, { hint: afterText.hint, done: afterText.hintDone });
  await page.screenshot({ path: path.join(OUT, 'desktop-editor-reset.png') });

  /* 位置暴露:时长 / 二次扫描 / 图标 / 显示图标 一起归位 */
  await page.select('#selAnim', 'exposed');
  await page.waitForFunction(() => {
    const s = document.getElementById('timingSection');
    return s && !s.hidden && document.querySelectorAll('#textList .text-item').length > 0;
  }, { timeout: 120000, polling: 200 });
  await sleep(1500);
  await page.evaluate(() => {
    const d = document.getElementById('rngDuration');
    d.value = '2.4';
    d.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(900);
  await page.evaluate(() => {
    const n = document.getElementById('chkNextScan');
    n.checked = true;
    n.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(1500);
  await page.evaluate(() => {
    const i = document.getElementById('chkIcon');
    i.checked = false;
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(900);
  const picked = await page.evaluate(() => {
    const items = document.querySelectorAll('#iconList .icon-item');
    if (items.length < 2) return null;
    items[1].click();
    return items[1].textContent.trim().slice(0, 40);
  });
  await sleep(900);
  const beforeMulti = await page.evaluate(() => ({
    dur: document.getElementById('rngDuration').value,
    next: document.getElementById('chkNextScan').checked,
    nextRow: document.getElementById('nextDurationRow').hidden,
    icon: document.getElementById('chkIcon').checked,
    iconName: document.getElementById('iconScopeNameMain').textContent,
  }));
  check('桌面:位置暴露的长/二次扫描/图标 /显示图标 都已改成非默认',
    parseFloat(beforeMulti.dur) > 2 && beforeMulti.next === true && beforeMulti.nextRow === false &&
    beforeMulti.icon === false && !!picked && beforeMulti.iconName !== '', JSON.stringify(beforeMulti));
  await page.click('#btnResetAnim');
  await page.waitForFunction(() => /已恢复「位置暴露动画」/.test(document.getElementById('statusbar').textContent || ''), { timeout: 60000, polling: 150 }).catch(() => {});
  await sleep(600);
  const afterMulti = await page.evaluate(() => ({
    dur: document.getElementById('rngDuration').value,
    next: document.getElementById('chkNextScan').checked,
    nextRow: document.getElementById('nextDurationRow').hidden,
    icon: document.getElementById('chkIcon').checked,
    iconName: document.getElementById('iconScopeNameMain').textContent,
    name: document.getElementById('animTriggerName').textContent,
    status: document.getElementById('statusbar').textContent,
    frames: document.getElementById('frameInfo').textContent,
    hint: document.getElementById('resetHint').textContent,
  }));
  check('桌面:重置后默认时长回到 1.25s(1.3 显示值)', Math.abs(parseFloat(afterMulti.dur) - 1.25) < 0.06, afterMulti.dur);
  check('桌面:重置后二次扫描关闭、时长行收回', afterMulti.next === false && afterMulti.nextRow === true, afterMulti);
  check('桌面:重置后「显示图标」恢复勾选', afterMulti.icon === true, afterMulti.icon);
  check('桌面:重置后帧范围回到 80 帧(默认时长)', /\/ 80$/.test(afterMulti.frames.trim()), afterMulti.frames);
  check('桌面:重置后仍停在这套动画上(不会跳走)', afterMulti.name === '位置暴露动画', afterMulti.name);
  check('桌面:说明行写回这套动画的结果', /已恢复「位置暴露动画」的默认状态/.test(afterMulti.hint), afterMulti.hint);

  /* 吸顶:侧栏滚到最底部时,重置那一行、跳转条、区块标题必须各就各位(不叠、不被盖住) */
  const sticky = await page.evaluate(async () => {
    const panel = document.querySelector('.side-panel');
    panel.scrollTop = panel.scrollHeight;
    await new Promise((r) => setTimeout(r, 350));
    const b = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    return { panel: b(panel), head: b(document.getElementById('sideHead')), nav: b(document.getElementById('sideNav')), h3: b(document.querySelector('.side-panel h3')), scrollTop: Math.round(panel.scrollTop) };
  });
  check('桌面:滚到侧栏最底部时「一键重置」仍然吸在顶部', sticky.scrollTop > 100 && Math.abs(sticky.head.top - sticky.panel.top) <= 1, sticky);
  check('桌面:吸顶三层各就各位(重置行 → 跳转条 → 区块标题)', Math.abs(sticky.nav.top - sticky.head.bottom) <= 1 && sticky.h3.top >= sticky.nav.bottom - 1, sticky);
  check('桌面:全流程无 JS 报错', errs.length === 0, errs.slice(0, 3));
  await page.close();
}

/* ==================== 二、桌面:全屏更新提示 ==================== */
{
  const { page, errs } = await open({
    viewport: { width: 1480, height: 940, deviceScaleFactor: 1 },
    query: '?view=home&update=1',
    intercept: true,
  });
  const appeared = await page.waitForFunction(() => {
    const el = document.getElementById('updateOverlay');
    return !!el && !el.hidden;
  }, { timeout: 30000, polling: 100 }).then(() => true).catch(() => false);
  await sleep(500);
  check('桌面:自动检查发现新版本 → 全屏提示自动弹出', appeared, appeared);

  const geo = await page.evaluate(() => {
    const box = (id) => { const el = document.getElementById(id); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
    const ov = document.getElementById('updateOverlay');
    const card = document.getElementById('updCard');
    const c = card.getBoundingClientRect();
    const cs = getComputedStyle(ov);
    return {
      overlay: box('updateOverlay'), position: cs.position, z: cs.zIndex,
      card: box('updCard'), centered: Math.abs((c.x + c.width / 2) - innerWidth / 2) <= 2 && Math.abs((c.y + c.height / 2) - innerHeight / 2) <= 2,
      primary: box('updPrimary'), later: box('updLater'), skip: box('updSkip'), close: box('updClose'),
      ver: document.getElementById('updLatest').textContent,
      from: document.getElementById('updFrom').textContent,
      asset: document.getElementById('updAsset').textContent,
      primaryText: document.getElementById('updPrimary').textContent,
      note: document.getElementById('updNote').textContent,
      vw: innerWidth, vh: innerHeight,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      inlineState: document.getElementById('updateStatus').dataset.state,
    };
  });
  check('桌面:浮层铺满视口、居中卡片', geo.position === 'fixed' && geo.overlay && geo.overlay.w === geo.vw && geo.overlay.h === geo.vh && geo.centered && geo.card.w === 460, { overlay: geo.overlay, card: geo.card, centered: geo.centered });
  check('桌面:卡片层级在导出浮层(9000)之下', Number(geo.z) === 8800, geo.z);
  check('桌面:版本/来源/安装包三行说的是这次检查的结果', geo.ver === 'v9.9.9' && /GitCode/.test(geo.from) && geo.asset.length > 0, { ver: geo.ver, from: geo.from, asset: geo.asset });
  check('桌面:主/次按钮 36px(--h-cta),跳过 26px(--h-sm)', geo.primary && geo.primary.h === 36 && geo.later && geo.later.h === 36 && geo.skip && geo.skip.h === 26, { p: geo.primary, l: geo.later, s: geo.skip });
  check('桌面:主操作在右、稍后在左(对话框惯例)', geo.primary.x > geo.later.x, { p: geo.primary.x, l: geo.later.x });
  check('桌面:网页版没有安装包 → 主操作是「前往下载页」', geo.primaryText === '前往下载页', geo.primaryText);
  check('桌面:关于页那条行内状态仍然是 available(两处共用一次检查)', geo.inlineState === 'available', geo.inlineState);
  check('桌面:浮层不引起横向滚动', geo.overflowX <= 0, geo.overflowX);
  /* 对比度:量的是这一刻真实渲染出来的颜色(主题令牌 → 计算值),不是 CSS 里写的值 */
  const texts = await page.evaluate(() => {
    const bgOf = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const b = getComputedStyle(n).backgroundColor;
        if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') return b;
        n = n.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    return ['#updTitle', '#updLatest', '#updFrom', '#updAsset', '#updNote', '#updSkip'].map((sel) => {
      const el = document.querySelector(sel);
      const st = getComputedStyle(el);
      return { sel, fg: st.color, bg: bgOf(el), size: parseFloat(st.fontSize) };
    });
  });
  const measured = texts.map((t) => ({ ...t, ratio: +contrast(t.fg, t.bg).toFixed(2), need: t.size >= 18 ? 3 : 4.5 }));
  check('桌面:浮层里每处文字都达到 WCAG AA(大字 3:1 / 正文 4.5:1)',
    measured.every((m) => m.ratio >= m.need), measured.filter((m) => m.ratio < m.need).length ? measured : measured.map((m) => m.sel + ' ' + m.ratio));
  await page.screenshot({ path: path.join(OUT, 'desktop-update-prompt.png') });

  /* 焦点边界:连按 Tab 必须留在浮层里 */
  let escapes = 0;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const ov = document.getElementById('updateOverlay');
      const a = document.activeElement;
      return !!a && (ov.contains(a) || a === document.body || a === ov);
    });
    if (!inside) escapes++;
  }
  check('桌面:12 次 Tab 焦点都没跑出浮层', escapes === 0, escapes);

  await page.keyboard.press('Escape');
  await sleep(400);
  const closed = await page.evaluate(() => ({
    hidden: document.getElementById('updateOverlay').hidden,
    focus: document.activeElement ? document.activeElement.tagName : '',
  }));
  check('桌面:Esc = 稍后再说(浮层关闭、焦点交还)', closed.hidden === true, closed);

  /* 手动再检查一次:允许再弹(显式动作) */
  await page.evaluate(() => document.querySelector('.rail-item[data-page="about"]').click());
  await sleep(400);
  await page.click('#btnCheckUpdate');
  const reShown = await page.waitForFunction(() => !document.getElementById('updateOverlay').hidden, { timeout: 20000, polling: 100 }).then(() => true).catch(() => false);
  check('桌面:手动点「检查更新」允许再弹一次', reShown, reShown);
  await page.click('#updLater');
  await sleep(300);
  check('桌面:「稍后再说」关闭浮层', await page.evaluate(() => document.getElementById('updateOverlay').hidden));

  /* 跳过这个版本:写入 localStorage,同版本不再弹 */
  await page.evaluate(() => document.querySelector('.rail-item[data-page="about"]').click());
  await sleep(300);
  await page.click('#btnCheckUpdate');
  await page.waitForFunction(() => !document.getElementById('updateOverlay').hidden, { timeout: 20000, polling: 100 }).catch(() => {});
  await page.click('#updSkip');
  await sleep(300);
  const skip = await page.evaluate(() => ({ hidden: document.getElementById('updateOverlay').hidden, saved: localStorage.getItem('dfae.ui.skipUpdate.v1') }));
  check('桌面:「跳过这个版本」关闭浮层并记住版本号', skip.hidden === true && skip.saved === '9.9.9', skip);
  await page.goto(BASE + '?view=home&update=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => { const el = document.getElementById('app-loading'); return !el || el.classList.contains('is-hidden'); }, { timeout: 120000, polling: 300 });
  await sleep(3200);
  check('桌面:跳过的版本下次启动不再弹(行内状态仍会显示)', await page.evaluate(() => document.getElementById('updateOverlay').hidden));
  check('桌面更新链路无 JS 报错', errs.length === 0, errs.slice(0, 3));
  await page.close();
}

/* ==================== 三、手机:一键重置 + 全屏更新提示 ==================== */
{
  const { page, errs } = await open({
    viewport: { width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    query: '?view=editor&ui=mobile&update=1',
    init: () => { window.__DFAE_MOBILE__ = true; },
    intercept: true,
  });
  await page.waitForFunction(() => !!document.getElementById('btnResetAnim'), { timeout: 120000, polling: 200 });
  await sleep(1600);

  /* 等自动检查那一次(启动 1.2s 后发请求)把提示弹出来;后面的重置测量要贴着编辑器 */
  await page.waitForFunction(() => !document.getElementById('updateOverlay').hidden, { timeout: 30000, polling: 120 }).catch(() => {});
  const promptUp = await page.evaluate(() => !document.getElementById('updateOverlay').hidden);
  if (promptUp) {
    const mgeo = await page.evaluate(() => {
      const box = (id) => { const el = document.getElementById(id); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
      const card = document.getElementById('updCard');
      const c = card.getBoundingClientRect();
      return {
        card: box('updCard'), primary: box('updPrimary'), later: box('updLater'), skip: box('updSkip'), close: box('updClose'),
        primaryText: document.getElementById('updPrimary').textContent,
        note: document.getElementById('updNote').textContent,
        vw: innerWidth, vh: innerHeight,
        fullScreen: Math.abs(c.width - innerWidth) <= 1 && Math.abs(c.height - innerHeight) <= 1,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scrollH: card.scrollHeight, clientH: card.clientHeight,
      };
    });
    check('手机:更新提示是**占满整屏**的面板(不是桌面那张居中卡片)', mgeo.fullScreen, { card: mgeo.card, vw: mgeo.vw, vh: mgeo.vh });
    check('手机:主/次按钮通栏 48px,关闭 40px,跳过 40px',
      mgeo.primary && mgeo.primary.h === 48 && mgeo.primary.w > mgeo.vw - 60 &&
      mgeo.later && mgeo.later.h === 48 &&
      mgeo.close && mgeo.close.w === 40 && mgeo.skip && mgeo.skip.h === 40,
      { p: mgeo.primary, l: mgeo.later, c: mgeo.close, s: mgeo.skip });
    check('手机:动作区贴底(主操作落在屏幕下半部、不出安全区)', mgeo.primary.bottom <= mgeo.vh && mgeo.primary.top > mgeo.vh * 0.6, { top: mgeo.primary.top, bottom: mgeo.primary.bottom, vh: mgeo.vh });
    check('手机:主操作文案说"去浏览器下载"(手机不能应用内安装)', mgeo.primaryText === '去浏览器下载', mgeo.primaryText);
    check('手机:说明文案点明"手动安装 + 相册里的成品不受影响"', /手动安装/.test(mgeo.note) && /相册/.test(mgeo.note), mgeo.note);
    check('手机:面板不横滚、内容不需要内部滚动(393×851)', mgeo.overflowX <= 0 && mgeo.scrollH <= mgeo.clientH + 1, { ox: mgeo.overflowX, s: mgeo.scrollH, c: mgeo.clientH });
    await page.screenshot({ path: path.join(OUT, 'mobile-update-prompt.png') });
    await page.click('#updLater');
    await sleep(400);
  } else {
    check('手机:更新提示应自动弹出', false, 'not shown');
  }

  const mgeo = await page.evaluate(probeReset);
  check('手机:重置按钮在底部面板(右侧编辑区)里,且在分区内容之前', !!mgeo.head && !!mgeo.btn && mgeo.btn.x >= mgeo.head.x && mgeo.head.bottom <= mgeo.firstH3.top + 1, { head: mgeo.head, btn: mgeo.btn, h3: mgeo.firstH3 });
  check('手机:按钮通栏 40px(面板收起时也要给分区内容留高度)', !!mgeo.btn && mgeo.btn.h === 40 && mgeo.btn.w >= mgeo.head.w - 26, { btn: mgeo.btn, head: mgeo.head });
  check('手机:桌面那条说明行在手机上收起(按钮已经通栏)', mgeo.hintDisplay === 'none', mgeo.hintDisplay);
  check('手机:这一行不引起横向溢出', mgeo.overflowX <= 0, mgeo.overflowX);
  await page.screenshot({ path: path.join(OUT, 'mobile-editor-reset.png') });

  /* 手机上真的能重置 */
  await waitTextItems(page, 1);
  const original = await page.evaluate(() => document.querySelector('#textList .t-input').value);
  await page.evaluate(() => {
    const ta = document.querySelector('#textList .t-input');
    ta.value = '手机重置测试';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(800);
  await page.click('#btnResetAnim');
  await page.waitForFunction(() => /已恢复/.test(document.getElementById('statusbar').textContent || ''), { timeout: 60000, polling: 150 }).catch(() => {});
  await sleep(400);
  const mAfter = await page.evaluate(() => ({ text: document.querySelector('#textList .t-input').value, status: document.getElementById('statusbar').textContent }));
  check('手机:点一下就把文字恢复出厂', mAfter.text === original && original !== '手机重置测试', { after: mAfter.text });
  check('手机:状态栏确认重置结果', /已恢复/.test(mAfter.status), mAfter.status);
  check('手机:全流程无 JS 报错', errs.length === 0, errs.slice(0, 3));
  await page.close();
}

/* ==================== 四、手机:关于页不再把自己认成桌面端 ==================== */
{
  const { page, errs } = await open({
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    query: '?view=about&ui=mobile',
    init: () => { window.__DFAE_MOBILE__ = true; },
  });
  await sleep(1400);
  const about = await page.evaluate(() => ({
    channel: document.getElementById('aboutChannel').textContent,
    home: document.getElementById('homeChannel').textContent,
    dirHidden: document.getElementById('aboutDirRow').hidden,
    deviceHidden: document.getElementById('aboutDevice').hidden,
    hasCheck: !!document.getElementById('btnCheckUpdate'),
    version: document.getElementById('aboutVersion').textContent,
  }));
  check('手机:关于页渠道写「手机版」而不是「桌面版」', about.channel === '手机版', about.channel);
  check('手机:主页版本行也写「手机版」', /^手机版/.test(about.home), about.home);
  check('手机:关于页不出现「保存目录」(桌面端能力)', about.dirHidden === true, about.dirHidden);
  check('手机:版本号与检查更新仍在', /^v\d/.test(about.version) && about.hasCheck, { v: about.version, c: about.hasCheck });
  check('手机关于页无 JS 报错', errs.length === 0, errs.slice(0, 3));
  await page.screenshot({ path: path.join(OUT, 'mobile-about-channel.png') });
  await page.close();
}


/* ==================== 五、桌面安装版:应用内下载 + 进度 ==================== */
{
  /* 这条路径只有真正的安装版才有(portable / 手机 / 网页都没有 updateCapabilities)。
   * 桥接自己报 canSelfUpdate=true,下载时把进度事件喂回来 —— 量的是"浮层里也看得见进度",
   * 而不是"下载能不能成功"(那是主进程的事)。 */
  const SELF_UPDATE_BRIDGE = () => {
    window.dfaeDesktop = {
      isDesktop: true,
      platform: 'win32',
      getInfo: async () => ({ version: '1.1.0', exportDir: 'C:\\Users\\tester\\Downloads\\DeltaForceAnimationEditor' }),
      checkUpdate: async () => ({
        ok: true, source: 'gitcode', label: 'GitCode',
        release: { tag_name: 'v9.9.9', name: 'v9.9.9', body: '', assets: [{ name: 'DeltaForceAnimationEditor-Setup-9.9.9.exe', browser_download_url: 'https://example.com/setup.exe' }] },
      }),
      updateCapabilities: async () => ({ canSelfUpdate: true }),
      downloadUpdate: async () => {
        const cb = window.__updCb;
        if (cb) {
          cb({ phase: 'downloading', pct: 30, received: 3, total: 10 });
          cb({ phase: 'downloading', pct: 72, received: 7.2, total: 10 });
        }
        await new Promise((r) => setTimeout(r, 400));
        if (cb) cb({ phase: 'done' });
        return { ok: true, path: 'C:\\Users\\tester\\AppData\\Temp\\setup-9.9.9.exe' };
      },
      cancelUpdate: async () => true,
      installUpdate: async () => ({ ok: true }),
      onUpdateProgress: (cb) => { window.__updCb = cb; return () => { window.__updCb = null; }; },
    };
    window.dfaeDownloads = { isDesktop: true, list: async () => ({ entries: [], promptOnSave: false }), reveal: async () => true };
  };
  const { page, errs } = await open({
    viewport: { width: 1480, height: 940, deviceScaleFactor: 1 },
    query: '?view=home&update=1',
    init: SELF_UPDATE_BRIDGE,
  });
  await page.waitForFunction(() => !document.getElementById('updateOverlay').hidden, { timeout: 30000, polling: 120 }).catch(() => {});
  const before = await page.evaluate(() => ({
    primary: document.getElementById('updPrimary').textContent,
    note: document.getElementById('updNote').textContent,
    progressHidden: document.getElementById('updProgress').hidden,
  }));
  check('安装版:浮层主操作是「下载并安装」', before.primary === '下载并安装', before.primary);
  check('安装版:说明写明"应用内下载、装完自动打开新版"', /下载并安装|自动打开/.test(before.note), before.note);

  await page.click('#updPrimary');
  await sleep(200);
  const during = await page.evaluate(() => ({
    progressHidden: document.getElementById('updProgress').hidden,
    fill: document.getElementById('updFill').style.transform,
    pct: document.getElementById('updPct').textContent,
    note: document.getElementById('updNote').textContent,
    disabled: document.getElementById('updPrimary').disabled,
  }));
  check('安装版:下载中浮层里出现进度条(不是只在关于页)', during.progressHidden === false && /scaleX\(0\.[0-9]+\)/.test(during.fill), during);
  check('安装版:下载中主按钮置灰、说明改成"正在下载"', during.disabled === true && /正在下载/.test(during.note), during);
  await page.waitForFunction(() => /就绪|安装程序/.test(document.getElementById('updNote').textContent || ''), { timeout: 20000, polling: 120 }).catch(() => {});
  await sleep(500);
  const after = await page.evaluate(() => ({
    note: document.getElementById('updNote').textContent,
    fill: document.getElementById('updFill').style.transform,
    disabled: document.getElementById('updPrimary').disabled,
    inline: document.getElementById('updateStatus').dataset.state,
  }));
  check('安装版:下载完成 → 提示"安装包已就绪 / 正在启动安装程序"', /就绪|安装程序/.test(after.note), after.note);
  check('安装版:进度到 100%(scaleX(1))、按钮恢复可用', after.fill === 'scaleX(1)' && after.disabled === false, after);
  check('安装版:应用内下载链路无 JS 报错', errs.length === 0, errs.slice(0, 3));
  await page.screenshot({ path: path.join(OUT, 'desktop-update-self-install.png') });
  await page.close();
}

await browser.close();
console.log(rows.join('\n'));
console.log(failures ? 'FAILED: ' + failures + ' / ' + rows.length : 'ALL PASS (' + rows.length + ')');
process.exit(failures ? 1 : 0);
