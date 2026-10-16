/* 界面深度走查(开发期辅助,不参与构建):
 * ui-audit.mjs 回答"令牌 / 对比度 / 控件是否升级",本脚本回答更难的一类问题 ——
 * "界面几何是不是真的对":中轴对称、行内对齐、间距节奏、折行、溢出、重叠、命中区。
 *
 * 为什么用几何而不是截图:这些问题(相差 2px 的错位、一个被压扁的按钮、
 * 一行只差 1px 的错行)肉眼看不出,但量得出来。每个检查项都有明确的阈值与理由。
 *
 * 用法:node tools/ui-deep-audit.mjs [--url http://127.0.0.1:5173/] [--out release/ui-audit/deep.json]
 * 退出码 0 = 无发现;1 = 有 FAIL 项。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:5173/');
const outPath = arg('out', 'release/ui-audit/deep.json');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

/* ---------- 页面内的探针(纯函数,序列化后丢进浏览器执行) ---------- */
const PROBE = () => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), cx: +(r.x + r.width / 2).toFixed(1), cy: +(r.y + r.height / 2).toFixed(1) }; };
  const vis = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const name = (el) => (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '')).slice(0, 70);

  /* --- 1. 顶栏:子项中轴是否对齐、是否折行、是否溢出 --- */
  /* 折行会把子项推到不同纵坐标上,所以"中轴对齐"必须**逐行**判断:
   * 拿第一项当基准会在换行时把第二行的每一项都误判成错位(踩过一次)。 */
  const clusterRows = (items) => {
    const rows = [];
    for (const it of [...items].sort((a, b) => a.y - b.y)) {
      const row = rows.find((r) => it.y < r.bottom - 3);
      if (row) { row.items.push(it); row.bottom = Math.max(row.bottom, it.bottom); }
      else rows.push({ bottom: it.bottom, items: [it] });
    }
    return rows;
  };
  const topbar = document.querySelector('.topbar');
  const topbarKids = topbar ? [...topbar.children].filter(vis).map((el) => ({ n: name(el), ...R(el) })) : [];
  const topbarRowList = clusterRows(topbarKids);
  const topbarMisaligned = [];
  for (const row of topbarRowList) {
    const mid = row.items.reduce((s, k) => s + k.cy, 0) / row.items.length;
    for (const k of row.items) if (Math.abs(k.cy - mid) > 1.5) topbarMisaligned.push({ n: k.n, dy: +(k.cy - mid).toFixed(1), row: row.items.length });
  }
  const topbarRows = topbarRowList.length;

  /* --- 2. 播放条:折了几行、行内控件高度是否统一、label 与控件是否同轴 --- */
  const transport = document.querySelector('.transport');
  const trKids = transport ? [...transport.children].filter(vis) : [];
  /* 行的判定同上:按纵向区间分组,不用 top 的精确值(同一行里各控件高度不同,
   * align-items:center 会让它们的 top 天然相差最多十几像素)。 */
  const trRowList = clusterRows(trKids.map((el) => ({ n: name(el), ...R(el) })));
  const trRows = {};
  trRowList.forEach((r, i) => { trRows[i] = r.items.length; });
  /* label 内部:文字与它所控的控件是否同轴(常见的"文字比输入框高半个字") */
  const labelMisalign = [];
  for (const lab of transport ? transport.querySelectorAll('label') : []) {
    if (!vis(lab)) continue;
    const kids = [...lab.children].filter(vis);
    if (kids.length < 2) continue;
    const mid = kids[0].getBoundingClientRect();
    const midY = mid.top + mid.height / 2;
    for (const k of kids.slice(1)) {
      const r = k.getBoundingClientRect();
      const dy = r.top + r.height / 2 - midY;
      if (Math.abs(dy) > 1.5) labelMisalign.push({ label: name(lab), child: name(k), dy: +dy.toFixed(1) });
    }
  }
  /* 播放条里所有可点控件的高度集合:出现第三、第四种高度就是"散" */
  const trHeights = [...new Set(trKids.flatMap((el) => {
    const out = [Math.round(el.getBoundingClientRect().height)];
    for (const c of el.querySelectorAll('button,select,input,fluent-button')) if (vis(c)) out.push(Math.round(c.getBoundingClientRect().height));
    return out;
  }))].sort((a, b) => a - b);

  /* --- 3. 时间轴 --- */
  const timeline = document.querySelector('.timeline');
  const tlKids = timeline ? [...timeline.children].filter(vis) : [];
  const tlMids = tlKids.map((el) => R(el).cy);
  const tlAligned = tlMids.length < 2 || Math.max(...tlMids) - Math.min(...tlMids) <= 1.5;

  /* --- 4. 画布是否真的在舞台正中(量 .preview-inner:它身上才有 scale) --- */
  const stage = document.querySelector('.preview-stage');
  const canvas = document.querySelector('.preview-inner');
  let canvasOffset = null;
  if (stage && canvas) {
    const s = R(stage), c = R(canvas);
    canvasOffset = { dx: +(c.cx - s.cx).toFixed(1), dy: +(c.cy - s.cy).toFixed(1), cw: c.w, ch: c.h, sw: s.w, sh: s.h, fit: +(c.w / s.w).toFixed(3) };
  }

  /* --- 5. 侧栏:标题与内容的左边缘是否共用一条轴;标题吸顶是否遮住内容 --- */
  const side = document.querySelector('.side-panel');
  const sideLefts = [];
  if (side) {
    for (const el of side.children) {
      if (!vis(el)) continue;
      const b = R(el);
      sideLefts.push({ n: name(el).slice(0, 40), left: b.x, w: b.w });
    }
  }
  const leftSet = [...new Set(sideLefts.map((s) => s.left))];

  /* --- 6. 文本截断:区分"有意省略号"与"真被裁掉" ---
   * 有 text-overflow:ellipsis 的截断是设计(图层名、文件名、长文案标题),不算缺陷;
   * 只有 white-space:nowrap 却没有省略号、文字被硬切掉的,才是排版 bug。 */
  const clipped = [];
  const ellipsized = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement) || !vis(el)) continue;
    const cs = getComputedStyle(el);
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
    if (!own) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const item = { n: name(el).slice(0, 50), text: el.textContent.trim().slice(0, 24), over: el.scrollWidth - el.clientWidth };
    if (cs.textOverflow === 'ellipsis') ellipsized.push(item);
    else if (cs.whiteSpace === 'nowrap') clipped.push(item);
  }

  /* --- 7. 重叠:同一父元素下、可见的兄弟块级控件互相压住 --- */
  const overlaps = [];
  const scopes = ['.topbar', '.transport', '.timeline', '.statusbar', '.ap-head', '.ap-foot', '.dw-bar', '.export-actions'];
  for (const sc of scopes) {
    const host = document.querySelector(sc);
    if (!host || !vis(host)) continue;
    const kids = [...host.children].filter(vis);
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) overlaps.push({ scope: sc, a: name(kids[i]).slice(0, 40), b: name(kids[j]).slice(0, 40), ox: +ox.toFixed(1), oy: +oy.toFixed(1) });
      }
    }
  }

  /* --- 8. 溢出容器:元素右边缘超出视口或父容器 --- */
  const bleed = [];
  for (const el of document.querySelectorAll('.topbar > *, .transport > *, .timeline > *, .statusbar > *')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 0.5 || r.left < -0.5) bleed.push({ n: name(el).slice(0, 50), right: +r.right.toFixed(1), left: +r.left.toFixed(1), vw: window.innerWidth });
  }

  /* --- 9. 命中区 ---
   * fluent-switch 的本体只有 36×18,但它挂了一层透明伪元素把命中区上下各外扩
   * (style.css 的 fluent-switch::before),所以这里量的是"有效命中区"而不是宿主盒。 */
  const effectiveBox = (el) => {
    const r = el.getBoundingClientRect();
    let extraY = 0;
    try {
      const before = getComputedStyle(el, '::before');
      if (before && before.content && before.content !== 'none') {
        extraY = Math.abs(parseFloat(before.top) || 0) + Math.abs(parseFloat(before.bottom) || 0);
      }
    } catch { /* 拿不到伪元素就按宿主盒算 */ }
    return { w: r.width, h: r.height + extraY, expanded: extraY > 0 };
  };
  const targets = [];
  for (const el of document.querySelectorAll('button, fluent-button, fluent-switch, select, input[type="checkbox"], .ap-card, .icon-item, .preset-item, .dw-row')) {
    if (!(el instanceof HTMLElement) || !vis(el)) continue;
    const b = effectiveBox(el);
    if (b.h < 24 || b.w < 24) targets.push({ n: name(el).slice(0, 40), w: Math.round(b.w), h: Math.round(b.h) });
  }

  /* --- 10. 主题开关:指示器位置是否与当前主题一致 --- */
  const sw = document.querySelector('.theme-switch');
  let themeSwitch = null;
  if (sw) {
    const ind = sw.querySelector('.theme-indicator');
    const cur = sw.dataset.current;
    const btns = [...sw.querySelectorAll('.theme-btn')];
    const active = btns.find((b) => b.getAttribute('aria-pressed') === 'true');
    const ir = ind ? ind.getBoundingClientRect() : null;
    const ar = active ? active.getBoundingClientRect() : null;
    themeSwitch = {
      dataCurrent: cur,
      activeTheme: active ? active.dataset.theme : null,
      indicatorOverActive: !!(ir && ar && Math.abs(ir.left - ar.left) < 2),
      indicatorTransform: ind ? getComputedStyle(ind).transform : null,
      btnColor: btns.map((b) => b.dataset.theme + '=' + getComputedStyle(b).color),
      hostH: Math.round(sw.getBoundingClientRect().height),
      hostW: Math.round(sw.getBoundingClientRect().width),
    };
  }

  /* --- 11. 侧栏粘性标题:滚过一整屏之后,当前区块的标题是否吸在"吸顶线"上、底色是否不透明 ---
   * 注意 sticky 的语义:任意时刻只有"当前那一节"的标题是吸住的,前面的会正常滚走,
   * 所以判据是"至少有一个吸住",不是"全都吸住"(拿"全部"当判据会永远失败)。
   * 吸顶线不是面板顶边:侧栏顶部还有一条 40px 的区块跳转条(sticky),标题停在它下面
   * (--side-nav-h),所以这里量的是跳转条的底边。 */
  let stickyOverlap = null;
  if (side) {
    const h3s = [...side.querySelectorAll('h3')].filter(vis);
    const navEl = side.querySelector('.side-nav');
    const navShown = !!navEl && !navEl.hidden && vis(navEl);
    const line = navShown ? navEl.getBoundingClientRect().bottom : side.getBoundingClientRect().top;
    if (h3s.length > 2) {
      const sideTop = side.getBoundingClientRect().top;
      /* offsetTop 的参照物是最近的定位祖先(这里是 body),不能直接当滚动目标;
       * 用矩形求"它相对面板顶部的自然偏移",再加上当前滚动量。 */
      const naturalTop = h3s[2].getBoundingClientRect().top - sideTop + side.scrollTop;
      side.scrollTop = Math.round(naturalTop - 40);
      const stuck = h3s.map((el) => {
        const r = el.getBoundingClientRect();
        const atLine = Math.abs(r.top - line) < 2;
        return { title: el.textContent.trim().slice(0, 10), top: +r.top.toFixed(1), stuck: atLine, bg: getComputedStyle(el).backgroundColor };
      });
      side.scrollTop = 0;
      stickyOverlap = { sideTop: +sideTop.toFixed(1), line: +line.toFixed(1), navShown, stuck, anyStuck: stuck.some((s) => s.stuck), opaque: stuck.filter((s) => s.stuck).every((s) => !/rgba\([^)]*,\s*0\)$/.test(s.bg)) };
    }
  }

  return {
    vw: window.innerWidth, vh: window.innerHeight,
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    topbar: { ...(topbar ? R(topbar) : {}), kids: topbarKids, rows: topbarRows, misaligned: topbarMisaligned },
    transport: {
      ...(transport ? R(transport) : {}),
      rows: Object.keys(trRows).length,
      rowSizes: trRows,
      heights: trHeights,
      labelMisalign,
      kids: trKids.map((el) => ({ n: name(el).slice(0, 46), ...R(el) })),
    },
    timeline: { aligned: tlAligned, mids: tlMids, h: timeline ? Math.round(timeline.getBoundingClientRect().height) : 0 },
    canvasOffset, sideLefts: leftSet, sideLeftCount: leftSet.length,
    clipped, ellipsized: ellipsized.slice(0, 8), overlaps, bleed, targets, themeSwitch, stickyOverlap,
  };
};

/* ---------- 驱动 ---------- */
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', '--hide-scrollbars', '--force-color-profile=srgb'],
});

const report = { url, at: new Date().toISOString(), runs: {} };
const lines = [];
let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  lines.push((ok ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
};

const VIEWPORTS = [
  { label: 'desktop-1600x1000', w: 1600, h: 1000 },
  { label: 'laptop-1366x768', w: 1366, h: 768 },
  { label: 'narrow-1024x800', w: 1024, h: 800 },
  { label: 'tablet-768x900', w: 768, h: 900 },
  { label: 'phone-390x844', w: 390, h: 844 },
];

try {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('#app-loading')?.classList.contains('is-hidden'), { timeout: 90000, polling: 250 }).catch(() => errs.push('loading-timeout'));
    await page.waitForFunction(() => document.querySelectorAll('fluent-button').length > 5, { timeout: 20000, polling: 100 }).catch(() => errs.push('fluent-timeout'));
    await new Promise((r) => setTimeout(r, 1200));

    const d = await page.evaluate(PROBE);
    report.runs[vp.label] = { ...d, errors: errs.slice(0, 10) };

    lines.push('');
    lines.push('========== ' + vp.label + '  (topbarH=' + (d.topbar.h || 0) + ', transportH=' + (d.transport.h || 0) + ', rows=' + d.transport.rows + ') ==========');
    check(vp.label + ' 无横向溢出', d.docOverflowX <= 0, 'overflowX=' + d.docOverflowX);
    check(vp.label + ' 无页面级 JS 报错', errs.length === 0, errs.join(' | ') || '');
    check(vp.label + ' 顶栏子项中轴对齐', d.topbar.misaligned.length === 0, d.topbar.misaligned);
    check(vp.label + ' 顶栏无子项溢出视口', d.bleed.length === 0, d.bleed);
    check(vp.label + ' 无元素重叠', d.overlaps.length === 0, d.overlaps);
    check(vp.label + ' label 与控件同轴', d.transport.labelMisalign.length === 0, d.transport.labelMisalign);
    check(vp.label + ' 时间轴行内对齐', d.timeline.aligned, d.timeline.mids);
    check(vp.label + ' 侧栏内容共用一条左轴', d.sideLeftCount <= 1, d.sideLefts);
    if (d.canvasOffset) {
      const off = d.canvasOffset;
      /* 画布在舞台内"居中"允许有亚像素误差;超过 1.5px 就是真的没居中(改版前偏左上半屏)。 */
      check(vp.label + ' 画布在舞台中居中', Math.abs(off.dx) <= 1.5 && Math.abs(off.dy) <= 1.5, off);
    }
    check(vp.label + ' 无文字被硬裁(省略号不算)', d.clipped.length === 0, d.clipped.slice(0, 6));
    if (d.stickyOverlap) {
      const st = d.stickyOverlap;
      check(vp.label + ' 侧栏滚动时当前区块标题吸顶', st.anyStuck, st.stuck);
      check(vp.label + ' 吸顶标题底色不透明', st.opaque, st.stuck.filter((s) => s.stuck).map((s) => s.bg));
    }
    lines.push('  播放条控件高度集合: ' + JSON.stringify(d.transport.heights));
    lines.push('  触屏/鼠标命中区偏小: ' + JSON.stringify(d.targets.slice(0, 8)));
    lines.push('  主题开关: ' + JSON.stringify(d.themeSwitch));
    lines.push('  有意省略号(设计,不算缺陷): ' + JSON.stringify(d.ellipsized));

    /* --- 主题切换:真的能切、指示器跟着走 --- */
    if (vp.label === 'desktop-1600x1000') {
      await page.evaluate(() => document.querySelector('.theme-btn[data-theme="light"]').click());
      await new Promise((r) => setTimeout(r, 500));
      const light = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        bg: getComputedStyle(document.body).backgroundColor,
        color: getComputedStyle(document.body).color,
        sw: (() => {
          const s = document.querySelector('.theme-switch');
          const ind = s.querySelector('.theme-indicator');
          const act = s.querySelector('.theme-btn[aria-pressed="true"]');
          const ir = ind.getBoundingClientRect(), ar = act ? act.getBoundingClientRect() : null;
          return { current: s.dataset.current, active: act ? act.dataset.theme : null, over: ar ? Math.abs(ir.left - ar.left) < 2 : false };
        })(),
      }));
      report.runs['theme-switch'] = light;
      lines.push('');
      lines.push('========== 主题切换 ==========');
      check('点击浅色按钮后 data-theme 变 light', light.theme === 'light', light.theme);
      check('body 底色跟随令牌', light.bg === 'rgb(234, 234, 240)', light.bg);
      check('指示器落在被选中的那一格', light.sw.over && light.sw.active === 'light', light.sw);
      await page.evaluate(() => document.querySelector('.theme-btn[data-theme="dark"]').click());
      await new Promise((r) => setTimeout(r, 400));

      /* --- 动画画廊:面板不溢出、卡片不重叠 --- */
      await page.evaluate(() => document.getElementById('animTrigger').click());
      await new Promise((r) => setTimeout(r, 700));
      const gallery = await page.evaluate(PROBE_GALLERY);
      report.runs['gallery'] = gallery;
      lines.push('');
      lines.push('========== 动画画廊 ==========');
      check('画廊面板不溢出视口', gallery.descOverflow === false, gallery);
      check('画廊卡片网格无重叠', gallery.cardOverlaps.length === 0, gallery.cardOverlaps.slice(0, 5));
      check('画廊头部右侧成组(关闭在最右)', gallery.closeRightmost, gallery.headOrder);
      await page.evaluate(() => document.getElementById('animPickerClose').click());
      await new Promise((r) => setTimeout(r, 400));
    }
    await page.close();
  }
} finally {
  await browser.close();
}

function PROBE_GALLERY() {
  const p = document.querySelector('.ap-panel');
  const g = document.querySelector('.ap-grid');
  const head = document.querySelector('.ap-head');
  const cards = [...document.querySelectorAll('.ap-card')];
  const overlaps = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i].getBoundingClientRect(), b = cards[j].getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) overlaps.push({ i, j, ox: +ox.toFixed(1), oy: +oy.toFixed(1) });
    }
  }
  const kids = head ? [...head.children].filter((e) => e.getBoundingClientRect().width > 0) : [];
  const close = document.querySelector('.ap-close');
  /* 关闭按钮升级后是 <fluent-button>,所以不能只按 <button> 找"最右的可交互元素"。 */
  const all = [...document.querySelectorAll('.ap-head button, .ap-head fluent-button, .ap-head input')].filter((e) => e.getBoundingClientRect().width > 0);
  const rightmost = all.length ? all.reduce((m, e) => (e.getBoundingClientRect().right > m.getBoundingClientRect().right ? e : m)) : null;
  return {
    panel: p ? { w: Math.round(p.getBoundingClientRect().width), h: Math.round(p.getBoundingClientRect().height) } : null,
    cards: cards.length,
    cardOverlaps: overlaps,
    descOverflow: p ? p.getBoundingClientRect().bottom > window.innerHeight + 1 || p.getBoundingClientRect().top < -1 : null,
    headOrder: kids.map((e) => e.className),
    closeRightmost: !!(close && rightmost && close === rightmost),
  };
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(lines.join('\n'));
console.log('\n报告: ' + outPath);
console.log('未通过: ' + fails + ' 项');
process.exit(fails ? 1 : 0);
