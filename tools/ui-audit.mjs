/* UI 走查(开发期辅助,不参与构建):
 * 用本机 Chrome 打开开发服务器,把"界面是否真的长成设计要的样子"变成可读结论。
 * 检查项:令牌锚点色 / Fluent 组件是否升级 / 主题切换 / 正文字号与对比度 /
 *         控件尺寸 / 关键区块是否渲染 / 控制台报错。
 * 用法:node tools/ui-audit.mjs [--url http://127.0.0.1:5174/] [--out release/ui-audit] [--theme both]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:5174/');
const outDir = arg('out', 'release/ui-audit');
const shot = arg('shot', '');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const PROBE = () => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const tok = (n) => cs.getPropertyValue(n).trim();
  const rgb = (s) => {
    const m = String(s).match(/(\d+(?:\.\d+)?)/g);
    return m ? m.slice(0, 3).map(Number) : null;
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };

  /* 背景色要往上找第一个不透明的祖先(元素自身多为透明) */
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      const a = String(getComputedStyle(n).backgroundColor).match(/rgba?\([^)]*?,\s*([\d.]+)\)/);
      if (c && (!a || Number(a[1]) > 0.5)) return c;
      n = n.parentElement;
    }
    return rgb(getComputedStyle(document.body).backgroundColor) || [36, 36, 36];
  };

  const textSamples = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement)) continue;
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own) continue;
    const c = getComputedStyle(el);
    if (c.visibility === 'hidden' || c.display === 'none' || Number(c.opacity) < 0.2) continue;
    if (!el.offsetParent && c.position !== 'fixed') continue;
    const fg = rgb(c.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const size = parseFloat(c.fontSize);
    const key = c.color + '|' + size.toFixed(1);
    if (seen.has(key)) continue;
    seen.add(key);
    const r = ratio(fg, bg);
    const large = size >= 18.66 || (size >= 14 && Number(c.fontWeight) >= 700);
    textSamples.push({
      sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/)[0] : ''),
      text: (el.textContent || '').trim().slice(0, 18),
      size: size, weight: c.fontWeight, fg: c.color, bg: 'rgb(' + bg.join(', ') + ')',
      ratio: Math.round(r * 100) / 100, need: large ? 3 : 4.5, pass: r >= (large ? 3 : 4.5) - 0.005,
    });
  }
  textSamples.sort((a, b) => a.ratio - b.ratio);

  const countTag = (t) => document.querySelectorAll(t).length;
  const btnNative = document.querySelectorAll('button').length;
  const btnFluent = countTag('fluent-button');

  /* 关键区块的存在性与尺寸 */
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
  };

  /* 溢出检测:横向滚动条(界面不应该出现) */
  const docOverflow = {
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    scrollH: document.documentElement.scrollHeight,
    clientH: document.documentElement.clientHeight,
  };

  /* 字号集合:确认类型尺度是收敛的(不出现 9px 之类的毛刺) */
  const sizes = {};
  for (const el of document.querySelectorAll('body, body *')) {
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const s = parseFloat(getComputedStyle(el).fontSize);
    sizes[s] = (sizes[s] || 0) + 1;
  }

  /* 触屏/鼠标可达性:可点控件的命中尺寸。
   * fluent-switch 的本体只有 36×18,但它挂了一层透明伪元素把命中区上下各外扩 7px
   * (style.css 的 fluent-switch::before),所以这里量"有效命中区"而不是宿主盒,
   * 否则会稳定报三条假阳性。 */
  const smallTargets = [];
  for (const el of document.querySelectorAll('button, fluent-button, fluent-toggle-button, fluent-switch, select, input[type="checkbox"]')) {
    if (!(el instanceof HTMLElement)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    let extraY = 0;
    try {
      const before = getComputedStyle(el, '::before');
      if (before && before.content && before.content !== 'none') {
        extraY = Math.abs(parseFloat(before.top) || 0) + Math.abs(parseFloat(before.bottom) || 0);
      }
    } catch { /* 拿不到伪元素就按宿主盒算 */ }
    if (r.height + extraY < 24 || r.width < 20) {
      smallTargets.push({ tag: el.tagName.toLowerCase(), id: el.id || '', w: Math.round(r.width), h: Math.round(r.height + extraY) });
    }
  }

  return {
    theme: root.dataset.theme,
    tokens: { bg: tok('--bg'), surface: tok('--surface'), text: tok('--text'), line: tok('--line'), brand: tok('--brand') },
    fluentVars: {
      neutralBackground1: tok('--colorNeutralBackground1'),
      neutralForeground1: tok('--colorNeutralForeground1'),
      brandBackground: tok('--colorBrandBackground'),
      onBrand: tok('--colorNeutralForegroundOnBrand'),
    },
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    bodyFont: getComputedStyle(document.body).fontFamily,
    counts: { nativeButtons: btnNative, fluentButtons: btnFluent, fluentSwitches: countTag('fluent-switch'), fluentToggleButtons: countTag('fluent-toggle-button') },
    themeSwitch: !!document.querySelector('.theme-switch'),
    /* 认 [data-theme] 而不是标签名:元素实现(fluent-toggle-button / 原生 button)会变,
     * data-theme 才是"这是主题按钮"的契约。 */
    themeSwitchButtons: document.querySelectorAll('.theme-switch [data-theme]').length,
    boxes: {
      topbar: box('.topbar'), stage: box('.preview-stage'), timeline: box('.timeline'),
      transport: box('.transport'), sidebar: box('.side-panel'), statusbar: box('.statusbar'),
    },
    docOverflow,
    textSamples: textSamples.slice(0, 14),
    textSampleCount: textSamples.length,
    contrastFails: textSamples.filter((t) => !t.pass).length,
    sizes,
    smallTargets,
    statusbar: (document.getElementById('statusbar') || {}).textContent,
    animName: (document.getElementById('animTriggerName') || {}).textContent,
    frameInfo: (document.getElementById('frameInfo') || {}).textContent,
    stageSvg: document.querySelectorAll('#stage svg').length,
    sideRows: document.querySelectorAll('#textList li, #shapeList li, #imageList li, #iconList li').length,
    loadingGone: !document.getElementById('app-loading'),
  };
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', '--hide-scrollbars', '--force-palette-color-profile=srgb'],
});

const report = { url, themes: {} };
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 240)); });
    page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 240)));
    page.on('requestfailed', (r) => errs.push('reqfail: ' + r.url().slice(0, 120) + ' ' + (r.failure() && r.failure().errorText)));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('app-loading');
      return !el || el.classList.contains('is-hidden');
    }, { timeout: 90000, polling: 250 }).catch(() => errs.push('loading-timeout'));
    // 等 Fluent 升级完成
    await page.waitForFunction(() => document.querySelectorAll('fluent-button').length > 5, { timeout: 15000, polling: 100 })
      .catch(() => errs.push('fluent-upgrade-timeout'));
    if (theme === 'light') {
      /* 主题开关现在是自绘的分段控件 .theme-btn[data-theme](外壳 + 滑动指示器),
       * 不是 fluent-toggle-button。旧选择器一个都点不到,于是"浅色"这一轮其实一直在量深色:
       * 两段报告的颜色一字不差,还被标成 DARK / LIGHT 各一份 —— 最糟的一种测试。
       * 这里点真正的按钮,并用 data-theme 回读确认真的切过去了,没切就记一条错误。 */
      const switched = await page.evaluate(() => {
        const btn = document.querySelector('.theme-btn[data-theme="light"]');
        if (!btn) return false;
        btn.click();
        return true;
      });
      await new Promise((r) => setTimeout(r, 500));
      const applied = await page.evaluate(() => document.documentElement.dataset.theme);
      if (!switched || applied !== 'light') errs.push('theme-switch-failed:' + switched + '/' + applied);
    }
    await new Promise((r) => setTimeout(r, 900));
    const data = await page.evaluate(PROBE);
    // 打开动画画廊看浮层
    await page.evaluate(() => { const b = document.getElementById('animTrigger'); if (b) b.click(); });
    await new Promise((r) => setTimeout(r, 700));
    const picker = await page.evaluate(() => {
      const p = document.querySelector('.ap-panel');
      const g = document.querySelector('.ap-grid');
      const r = p ? p.getBoundingClientRect() : null;
      return {
        panel: r ? { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) } : null,
        cards: document.querySelectorAll('.ap-card').length,
        cardW: g && g.firstElementChild ? Math.round(g.firstElementChild.getBoundingClientRect().width) : 0,
        clipped: g ? g.scrollHeight > g.clientHeight + 4 : null,
        descOverflow: p ? p.getBoundingClientRect().bottom > window.innerHeight + 1 : null,
      };
    });
    await page.screenshot({ path: path.join(outDir, 'after-' + theme + '.png') });
    report.themes[theme] = { data, picker, errors: errs.slice(0, 25) };
    // 关掉画廊
    await page.evaluate(() => { const b = document.getElementById('animPickerClose'); if (b) b.click(); });
    await page.close();
  }
} finally {
  await browser.close();
}

/* ---- 结论 ---- */
const lines = [];
for (const [theme, r] of Object.entries(report.themes)) {
  const d = r.data;
  lines.push('===== ' + theme.toUpperCase() + ' =====');
  lines.push('data-theme=' + d.theme + '  bodyBg=' + d.bodyBg + '  bodyColor=' + d.bodyColor);
  lines.push('tokens: ' + JSON.stringify(d.tokens));
  lines.push('fluent vars: ' + JSON.stringify(d.fluentVars));
  lines.push('counts: ' + JSON.stringify(d.counts) + '  themeSwitch=' + d.themeSwitch + '(' + d.themeSwitchButtons + ')');
  lines.push('boxes: ' + JSON.stringify(d.boxes));
  lines.push('overflow: ' + JSON.stringify(d.docOverflow));
  lines.push('font sizes: ' + JSON.stringify(d.sizes));
  lines.push('min-contrast samples (' + d.contrastFails + '/' + d.textSampleCount + ' fail):');
  for (const t of d.textSamples.slice(0, 8)) lines.push('   ' + JSON.stringify(t));
  lines.push('small targets: ' + JSON.stringify(d.smallTargets.slice(0, 10)));
  lines.push('picker: ' + JSON.stringify(r.picker));
  lines.push('errors(' + r.errors.length + '): ' + JSON.stringify(r.errors.slice(0, 10), null, 1));
  lines.push('');
}
fs.writeFileSync(path.join(outDir, 'ui-audit.json'), JSON.stringify(report, null, 2));
console.log(lines.join('\n'));
