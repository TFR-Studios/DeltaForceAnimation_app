/* 应用外壳回归(常驻,不参与构建):
 *   node tools/verify-app-shell.mjs [--url http://127.0.0.1:5174/?view=home]
 *
 * 覆盖 2026-10 这一轮的结构改动:侧边导航轨(手机=底部标签栏)、
 * 主页 / 编辑器 / 关于 三页切换、主页不放动画列表、关于页承载检查更新。
 * tools/ 下其它脚本走 puppeteer(navigator.webdriver)会直接进编辑器页,量的是编辑器;
 * 外壳这一层由本脚本负责。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:5173/');
const OUT = arg('out', 'release/shell');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = []; let failures = 0;
const check = (n, ok, extra = '') => { if (!ok) failures++; out.push((ok ? 'PASS ' : 'FAIL ') + n + (extra ? '  -> ' + extra : '')); };
fs.mkdirSync(OUT, { recursive: true });

const FAKE_BRIDGE = () => {
  window.dfaeDesktop = {
    isDesktop: true,
    platform: 'win32',
    getInfo: async () => ({ version: '1.0.5', exportDir: 'C:\\Users\\tester\\Downloads\\DeltaForceAnimationEditor' }),
    checkUpdate: async () => ({
      ok: true, source: 'gitcode', label: 'GitCode',
      release: { tag_name: 'v9.9.9', name: 'v9.9.9', body: '', assets: [{ name: 'DeltaForceAnimationEditor-Setup-9.9.9.exe', browser_download_url: 'https://example.com/setup.exe' }] },
    }),
  };
  window.dfaeDownloads = { isDesktop: true, list: async () => ({ entries: [], promptOnSave: false }), reveal: async () => true };
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'] });

async function openPage(opts) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  if (opts.nativeMobile) await page.evaluateOnNewDocument(() => { window.__DFAE_MOBILE__ = true; });
  if (opts.bridge) await page.evaluateOnNewDocument(FAKE_BRIDGE);
  await page.setViewport(opts.viewport);
  await page.goto(BASE + '?view=home' + (opts.query || ''), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app-loading');
    return !el || el.classList.contains('is-hidden');
  }, { timeout: 120000, polling: 300 }).catch(() => errs.push('loading-timeout'));
  await sleep(700);
  return { page, errs };
}

const probe = () => {
  const r = (q) => { const el = document.querySelector(q); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }; };
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && !el.hidden;
  return {
    page: document.documentElement.dataset.page || '',
    ui: document.documentElement.dataset.ui || 'desktop',
    rail: r('.rail'),
    railItems: [...document.querySelectorAll('.rail-item')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.dataset.page),
    home: vis(document.getElementById('viewHome')),
    about: vis(document.getElementById('viewAbout')),
    editor: vis(document.querySelector('.layout')),
    animSwitch: (() => { const el = document.querySelector('.anim-switch'); return el ? getComputedStyle(el).display !== 'none' : false; })(),
    homeTitle: (document.getElementById('homeTitle') || {}).textContent || '',
    homeChannel: (document.getElementById('homeChannel') || {}).textContent || '',
    primaryH: r('#btnOpenEditor') ? r('#btnOpenEditor').h : 0,
    primaryW: r('#btnOpenEditor') ? r('#btnOpenEditor').w : 0,
    ghostH: r('#btnGoAbout') ? r('#btnGoAbout').h : 0,
    animCards: document.querySelectorAll('.ss-card, #ssGrid, .ap-card').length,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vh: innerHeight, vw: innerWidth,
    aboutVersion: (document.getElementById('aboutVersion') || {}).textContent || '',
    hasCheck: !!document.getElementById('btnCheckUpdate'),
    dirRowHidden: !!(document.getElementById('aboutDirRow') || {}).hidden,
    stage: r('.preview-stage'),
  };
};

/* ---------- 桌面 ---------- */
{
  const { page, errs } = await openPage({ viewport: { width: 1480, height: 940, deviceScaleFactor: 1 }, bridge: true });
  const s = await page.evaluate(probe);
  check('桌面:无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  check('桌面:默认停在主页', s.page === 'home' && s.home && !s.editor && !s.about, JSON.stringify({ page: s.page, h: s.home, e: s.editor, a: s.about }));
  /* 默认是收起态(56px),所以这里只断言"贴左 + 在顶栏之下 + 在 56~176 之间",
   * 具体宽度的行为由下面「侧边栏:默认收起 + 展开动画」那一组负责。 */
  check('桌面:左侧导航轨贴左、位于顶栏之下', s.rail && s.rail.x === 0 && s.rail.y <= 60 && s.rail.w >= 56 && s.rail.w <= 176, JSON.stringify(s.rail));
  check('桌面:导航含 主页/编辑器/下载列表/关于', JSON.stringify(s.railItems) === JSON.stringify(['home', 'editor', 'downloads', 'about']), JSON.stringify(s.railItems));
  check('桌面:主页**没有**动画卡片', s.animCards === 0, s.animCards);
  check('桌面:主页标题文案已换', /把游戏动画/.test(s.homeTitle), s.homeTitle);
  check('桌面:主页主按钮 36px 不换行', s.primaryH === 36 && s.primaryW > 100, JSON.stringify({ h: s.primaryH, w: s.primaryW }));
  check('桌面:非编辑器页隐藏动画选择器', s.animSwitch === false, s.animSwitch);
  check('桌面:无横向滚动', s.overflowX <= 0, s.overflowX);
  await page.screenshot({ path: path.join(OUT, 'verify-desktop-home.png') });

  await page.evaluate(() => document.querySelector('.rail-item[data-page="editor"]').click());
  await sleep(500);
  const ed = await page.evaluate(probe);
  check('桌面:切到编辑器 → 编辑器可见、主页隐藏', ed.page === 'editor' && ed.editor && !ed.home, JSON.stringify({ p: ed.page, e: ed.editor }));
  check('桌面:编辑器舞台有尺寸(没被 display:none 压塌)', ed.stage && ed.stage.w > 400 && ed.stage.h > 300, JSON.stringify(ed.stage));
  check('桌面:编辑器页显示动画选择器', ed.animSwitch === true, ed.animSwitch);
  await page.screenshot({ path: path.join(OUT, 'verify-desktop-editor.png') });

  await page.evaluate(() => document.querySelector('.rail-item[data-page="about"]').click());
  await sleep(400);
  const ab = await page.evaluate(probe);
  check('桌面:切到关于 → 关于可见', ab.page === 'about' && ab.about && !ab.home, JSON.stringify({ p: ab.page, a: ab.about }));
  check('桌面:关于页有版本号与检查更新按钮', /^v\d/.test(ab.aboutVersion) && ab.hasCheck, JSON.stringify({ v: ab.aboutVersion, c: ab.hasCheck }));

  await page.click('#btnCheckUpdate');
  await page.waitForFunction(() => document.querySelector('#updateStatus').dataset.state !== 'checking', { timeout: 15000, polling: 100 }).catch(() => {});
  const upd = await page.evaluate(() => ({
    state: document.querySelector('#updateStatus').dataset.state,
    text: document.querySelector('#updateStatus').textContent,
    href: (document.querySelector('.update-link') || {}).href || '',
  }));
  check('桌面:检查更新 → 发现新版本 + 下载链接', upd.state === 'available' && /9\.9\.9/.test(upd.text) && /setup\.exe/.test(upd.href), JSON.stringify(upd));
  await page.screenshot({ path: path.join(OUT, 'verify-desktop-about.png') });

  await page.evaluate(() => document.querySelector('.rail-item[data-page="home"]').click());
  await sleep(300);
  const back = await page.evaluate(probe);
  check('桌面:能回到主页', back.page === 'home' && back.home, back.page);
  await page.close();
}

/* ---------- 侧边栏:默认收起 + 展开动画 ---------- */
{
  const { page } = await openPage({ viewport: { width: 1480, height: 940, deviceScaleFactor: 1 } });
  const w = () => page.evaluate(() => Math.round(document.querySelector('.rail').getBoundingClientRect().width));
  check('侧边栏默认是收起的(56px)', (await w()) <= 60, await w());
  await page.evaluate(() => document.querySelector('.rail-item[data-page="editor"]').click());
  await sleep(600);
  const inEditor = await page.evaluate(() => {
    const inner = document.getElementById('previewInner');
    const m = getComputedStyle(inner).transform.match(/matrix\(([-\d.]+)/);
    return { scale: m ? +m[1] : 0, stageW: document.querySelector('.preview-stage').clientWidth };
  });
  check('主页→编辑器:舞台适配重新算过(scale > 0.05)', inEditor.scale > 0.05 && inEditor.stageW > 400, JSON.stringify(inEditor));

  await page.click('#railToggle');
  await sleep(80);
  const mid = await w();
  await sleep(360);
  const expanded = await page.evaluate(() => ({
    railW: Math.round(document.querySelector('.rail').getBoundingClientRect().width),
    stageW: document.querySelector('.preview-stage').clientWidth,
  }));
  check('展开有过渡(80ms 时应处在 56~176 之间)', mid > 60 && mid < 176, mid);
  check('展开后 176px 且舞台变窄重算', expanded.railW === 176 && expanded.stageW < inEditor.stageW, JSON.stringify(expanded));
  await page.click('#railToggle');
  await sleep(360);
  check('再点可收起(56px)', (await w()) <= 60, await w());
  await page.close();
}

/* ---------- 窄窗口 ---------- *//* ---------- 窄窗口 ---------- */
for (const w of [1024, 900]) {
  const { page, errs } = await openPage({ viewport: { width: w, height: 760, deviceScaleFactor: 1 } });
  const s = await page.evaluate(probe);
  check(w + 'px:无横向滚动且主页可见', s.overflowX <= 0 && s.home, JSON.stringify({ ox: s.overflowX }));
  check(w + 'px:无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.close();
}

/* ---------- 手机(原生信号 + ?ui=mobile) ---------- */
{
  const { page, errs } = await openPage({
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    nativeMobile: true,
    query: '&ui=mobile',
  });
  const s = await page.evaluate(probe);
  check('手机:data-ui=mobile(原生信号生效)', s.ui === 'mobile', s.ui);
  check('手机:导航轨变底部标签栏', s.rail && s.rail.w >= 380 && Math.abs(s.rail.bottom - s.vh) <= 2, JSON.stringify(s.rail));
  check('手机:导航只有 主页/编辑器/关于(无下载列表)', JSON.stringify(s.railItems) === JSON.stringify(['home', 'editor', 'about']), JSON.stringify(s.railItems));
  check('手机:主页主按钮通栏 48px', s.primaryH === 48 && s.primaryW > 300, JSON.stringify({ h: s.primaryH, w: s.primaryW }));
  check('手机:主页没有动画卡片', s.animCards === 0, s.animCards);
  check('手机:无横向滚动', s.overflowX <= 0, s.overflowX);
  check('手机:无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.screenshot({ path: path.join(OUT, 'verify-mobile-home.png') });

  await page.evaluate(() => document.querySelector('.rail-item[data-page="about"]').click());
  await sleep(400);
  const ab = await page.evaluate(probe);
  check('手机:能进关于页且带检查更新', ab.page === 'about' && ab.about && ab.hasCheck, JSON.stringify({ p: ab.page }));
  check('手机:关于页不出现保存目录(桌面端能力)', ab.dirRowHidden === true, ab.dirRowHidden);
  await page.screenshot({ path: path.join(OUT, 'verify-mobile-about.png') });

  await page.evaluate(() => document.querySelector('.rail-item[data-page="editor"]').click());
  await sleep(600);
  const ed = await page.evaluate(probe);
  check('手机:切到编辑器舞台有尺寸', ed.page === 'editor' && ed.stage && ed.stage.w > 200 && ed.stage.h > 100, JSON.stringify(ed.stage));
  await page.screenshot({ path: path.join(OUT, 'verify-mobile-editor.png') });
  await page.close();
}

/* ---------- 手机:页面栈 / 过渡 / 状态栏 / 不抢焦点 ---------- */
{
  const { page, errs } = await openPage({
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    nativeMobile: true,
    query: '&ui=mobile',
  });
  const st0 = await page.evaluate(() => ({
    page: document.documentElement.dataset.page,
    bar: getComputedStyle(document.getElementById('statusbar')).display,
  }));
  check('手机:主页隐藏编辑器状态栏', st0.page === 'home' && st0.bar === 'none', JSON.stringify(st0));

  /* 换页有入场动画(取一帧中间态) */
  const frames = await page.evaluate(() => new Promise((resolve) => {
    const el = document.querySelector('.layout');
    const seen = [];
    const t0 = performance.now();
    const tick = () => {
      seen.push({ cls: el.classList.contains('is-entering'), anim: getComputedStyle(el).animationName, op: +getComputedStyle(el).opacity });
      if (performance.now() - t0 < 280) requestAnimationFrame(tick); else resolve(seen);
    };
    document.querySelector('.rail-item[data-page="editor"]').click();
    requestAnimationFrame(tick);
  }));
  const animated = frames.some((f) => f.anim === 'page-enter' && f.op > 0 && f.op < 1);
  check('手机:换页有入场过渡(拍到中间帧)', animated, JSON.stringify(frames.slice(0, 3)));

  const hist1 = await page.evaluate(() => ({ len: history.length, state: history.state && history.state.dfaePage }));
  await page.evaluate(() => document.querySelector('.rail-item[data-page="about"]').click());
  await sleep(320);
  const hist2 = await page.evaluate(() => ({ len: history.length, state: history.state && history.state.dfaePage, bar: getComputedStyle(document.getElementById('statusbar')).display }));
  check('手机:切页会入历史栈(关于)', hist2.state === 'about' && hist2.len > hist1.len, JSON.stringify(hist2));
  check('手机:关于页也隐藏状态栏', hist2.bar === 'none', hist2.bar);

  await page.goBack();
  await sleep(420);
  const back1 = await page.evaluate(() => document.documentElement.dataset.page);
  check('手机:返回键回到编辑器(不是退出应用)', back1 === 'editor', back1);
  await page.goBack();
  await sleep(420);
  const back2 = await page.evaluate(() => ({ page: document.documentElement.dataset.page, bar: getComputedStyle(document.getElementById('statusbar')).display }));
  check('手机:再返回回到主页,状态栏消失', back2.page === 'home' && back2.bar === 'none', JSON.stringify(back2));

  /* 打开动画画廊:手机端不该抢焦点(否则弹输入法) */
  await page.evaluate(() => document.querySelector('.rail-item[data-page="editor"]').click());
  await sleep(500);
  await page.evaluate(() => document.querySelector('#animTrigger').click());
  await sleep(500);
  const focus = await page.evaluate(() => ({
    active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '',
    open: !document.getElementById('animPicker').hidden,
  }));
  check('手机:打开画廊不聚焦搜索框(不弹输入法)', focus.open && focus.active !== 'animSearch', JSON.stringify(focus));
  check('手机:导航改动无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  /* 真实触摸点击(不是 element.click())—— element.click() 绕过命中判定,
   * 真机上的"看得见点不动"它永远测不出来。
   * 先把上面打开的画廊关掉:它是模态浮层(z-index 9000),开着时底栏本来就点不到。 */
  await page.keyboard.press('Escape');
  await sleep(400);
  await page.evaluate(() => document.querySelector('.rail-item[data-page="about"]').click());
  await sleep(400);
  const geo = await page.evaluate(() => {
    const rail = document.querySelector('.rail').getBoundingClientRect();
    const cs = getComputedStyle(document.querySelector('.rail'));
    return {
      barBottom: Math.round(rail.bottom),
      barH: Math.round(rail.height),
      padBottom: cs.paddingBottom,
      items: [...document.querySelectorAll('.rail-item')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => {
        const r = b.getBoundingClientRect();
        return { page: b.dataset.page, cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
      }),
    };
  });
  check('手机:底栏被抬起(底部 inset ≥ 12px,不贴系统手势区)', parseFloat(geo.padBottom) >= 12 && geo.barBottom === 844, JSON.stringify({ h: geo.barH, pad: geo.padBottom, bottom: geo.barBottom }));

  const tapResults = [];
  for (const target of ['home', 'editor', 'about']) {
    const it = geo.items.find((i) => i.page === target);
    if (!it) { tapResults.push({ target, page: 'no-item' }); continue; }
    await page.touchscreen.tap(it.cx, it.cy);
    await sleep(520);
    tapResults.push({ target, page: await page.evaluate(() => document.documentElement.dataset.page) });
  }
  check('手机:真实触摸点击底栏三格都能跳转', tapResults.every((r) => r.target === r.page), JSON.stringify(tapResults));

  const h0 = await page.evaluate(() => history.length);
  const edItem = geo.items.find((i) => i.page === 'editor');
  await page.touchscreen.tap(edItem.cx, edItem.cy);
  await sleep(420);
  const h1 = await page.evaluate(() => history.length);
  check('手机:一次点击只入一条历史(不重复触发)', h1 - h0 === 1, h1 - h0);

  const dev = await page.evaluate(() => {
    const el = document.getElementById('aboutDevice');
    return el ? { hidden: el.hidden, text: el.textContent } : null;
  });
  check('手机:关于页有现场数据行(视口/安全区/底栏/落点)', !!dev && !dev.hidden && /视口 \d+×\d+/.test(dev.text), dev && dev.text);
  await page.close();
}

await browser.close();
console.log(out.join('\n'));
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);