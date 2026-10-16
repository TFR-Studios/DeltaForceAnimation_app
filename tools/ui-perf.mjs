/* 界面性能与绘制成本走查(开发期辅助,不参与构建):
 * 用真实 Chrome 打开开发/预览服务器,量四件事:
 *   1. 首屏时间线(FCP / 加载层消失 / DOMContentLoaded);
 *   2. 主题切换耗时(只改一个属性,不应该重建动画);
 *   3. 连续窗口缩放时每帧的重排耗时(ResizeObserver → applyFit → 写 transform);
 *   4. 版面体量:CSS 规则数、DOM 节点数、Fluent 组件数、字体字号种类。
 * 用法:node tools/ui-perf.mjs [--url http://127.0.0.1:5175/] [--json release/ui-audit/perf.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:5175/');
const jsonOut = arg('json', '');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
/* 关掉缓存后的首屏数字才有意义 */
await page.setCacheEnabled(false);
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
const domContentLoaded = Date.now() - t0;
await page.waitForFunction(() => {
  const el = document.getElementById('app-loading');
  return !el || el.classList.contains('is-hidden');
}, { timeout: 120000, polling: 100 }).catch(() => {});
const bootMs = Date.now() - t0;
await page.waitForFunction(() => window.__anim && window.__anim.isLoaded, { timeout: 120000, polling: 100 }).catch(() => {});

const base = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = performance.getEntriesByType('paint').map((p) => ({ name: p.name, t: Math.round(p.startTime) }));
  const countRules = (sheet) => {
    try { return sheet.cssRules ? sheet.cssRules.length : 0; } catch { return -1; }
  };
  let docRules = 0, sheetCount = 0;
  for (const s of document.styleSheets) { sheetCount++; docRules += Math.max(0, countRules(s)); }
  /* 组件库的样式在各自 shadowRoot 的 adoptedStyleSheets 里 */
  let shadowRules = 0;
  document.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot && el.shadowRoot.adoptedStyleSheets) {
      for (const s of el.shadowRoot.adoptedStyleSheets) shadowRules += Math.max(0, countRules(s));
    }
  });
  /* 只统计界面文字:排除 SVG 内部(那是动画素材自己的文字元素,
   * 字号由 Lottie JSON 决定,不属于界面排版尺度)。 */
  const sizes = {};
  document.querySelectorAll('body, body *').forEach((el) => {
    /* 画布里是动画素材自己的文字(字号来自 Lottie JSON),不属于界面排版尺度 */
    if (el.closest('svg') || el.closest('.preview-inner')) return;
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) return;
    const fs2 = parseFloat(getComputedStyle(el).fontSize);
    sizes[fs2] = (sizes[fs2] || 0) + 1;
  });
  return {
    nav: { domInteractive: Math.round(nav.domInteractive || 0), loadEnd: Math.round(nav.loadEventEnd || 0) },
    paints,
    sheets: { document: sheetCount, rules: docRules, shadowRules },
    dom: { elements: document.querySelectorAll('*').length, nodes: document.getElementsByTagName('*').length },
    fluent: {
      button: document.querySelectorAll('fluent-button').length,
      toggleButton: document.querySelectorAll('fluent-toggle-button').length,
      switch: document.querySelectorAll('fluent-switch').length,
      nativeButtons: document.querySelectorAll('button').length,
    },
    fontSizes: sizes,
    uniqueFontSizes: Object.keys(sizes).length,
    backdropFilters: [...document.querySelectorAll('*')].filter((el) => {
      const c = getComputedStyle(el);
      return c.backdropFilter && c.backdropFilter !== 'none';
    }).length,
  };
});

/* 主题切换:同一帧里改属性,量到下一次样式计算完成 */
const themeSwitch = await page.evaluate(async () => {
  const samples = [];
  /* 认 [data-theme] 而不是标签名:元素实现会变(fluent-toggle-button / fluent-button / 原生 button),
   * data-theme 才是"这是主题按钮"的契约。两个按钮交替点 ——
   * 只点一边等于每次都选中已经选中的那个,量不出真实切换成本。
   *
   * 这里不写"取第一个按钮"之类的兜底:早期版本先 querySelector 一个写死标签的选择器,
   * 元素实现一改就静默 return,报告里 themeMs 直接变空(看起来像"没测",其实是测错了对象)。 */
  const buttons = [...document.querySelectorAll('.theme-switch [data-theme]')];
  if (buttons.length < 2) return { error: 'theme buttons missing: found ' + buttons.length };
  for (let i = 0; i < 6; i++) {
    const target = document.documentElement.dataset.theme === 'light' ? buttons[1] : buttons[0];
    const before = document.documentElement.dataset.theme;
    const t = performance.now();
    target.click();
    void getComputedStyle(document.body).backgroundColor;
    const dt = performance.now() - t;
    samples.push({ from: before, to: document.documentElement.dataset.theme, ms: +dt.toFixed(2) });
    await new Promise((r) => setTimeout(r, 150));
  }
  return { samples, animRebuilt: false };
});

/* 用 CDP 量连续缩放时的每帧时间:改窗口宽度 → 读一帧 */
const client = await page.target().createCDPSession();
await client.send('Performance.enable');
const resizeMetrics = [];
for (const w of [1600, 1500, 1400, 1300, 1200, 1100, 1000]) {
  await page.setViewport({ width: w, height: 1000 });
  /* 先等浏览器把视口变更应用完,再单独量"强制一次布局 + 样式重算"的成本。
   * 直接量 setViewport + 两帧的墙钟时间会把浏览器自身的视口同步与 60fps 帧间隔算进去,
   * 那部分和我们的 CSS 无关。 */
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const layoutMs = await page.evaluate(() => {
    const t = performance.now();
    // 读 scrollWidth 会强制同步布局(样式重算 + 重排),这就是我们关心的那一段
    void document.documentElement.scrollWidth;
    void getComputedStyle(document.querySelector('.side-panel')).width;
    return +(performance.now() - t).toFixed(2);
  });
  resizeMetrics.push({ width: w, layoutMs });
}

/* 布局偏移(CLS)与最大偏移来源。
 * 注意:这里拿到的是"从本次导航开始累积"的值(buffered),所以它包含启动阶段的位移;
 * 启动时加载层淡出 + 首屏动画数据落位本来就是会移一次,关键是能不能说清是谁在动。 */
const stability = await page.evaluate(async () => {
  return await new Promise((resolve) => {
    const entries = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          entries.push({
            value: +e.value.toFixed(4),
            t: Math.round(e.startTime),
            sources: (e.sources || []).slice(0, 3).map((s) => {
              const n = s.node;
              if (!n) return '?';
              const cls = typeof n.className === 'string' ? n.className : (n.getAttribute && n.getAttribute('class')) || '';
              return (n.tagName || '') + (n.id ? '#' + n.id : '') + (cls ? '.' + cls.split(' ')[0] : '');
            }),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) { /* 不支持就算了 */ }
    setTimeout(() => {
      const cls = entries.reduce((a, e) => a + e.value, 0);
      resolve({
        shifts: entries.length,
        cls: +cls.toFixed(4),
        worst: entries.sort((a, b) => b.value - a.value).slice(0, 5),
      });
    }, 400);
  });
});

const report = {
  url,
  timings: { domContentLoadedMs: domContentLoaded, bootMs },
  base,
  themeSwitch,
  resize: resizeMetrics,
  stability,
};
console.log(JSON.stringify(report, null, 1));
if (jsonOut) { fs.mkdirSync(path.dirname(jsonOut), { recursive: true }); fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2)); }
await browser.close();
