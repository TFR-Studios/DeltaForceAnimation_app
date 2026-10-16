/* ============================================================================
 * 界面布局审计(--measure):把"看起来对不对"变成一组可复现的数字。
 *
 * 为什么需要它:桌面端没有视觉回归测试,而"比例不对 / 挤 / 溢出 / 换行"这类问题
 * 全都要在**真实渲染**里才看得见 —— 光读 CSS 只能猜。这个模式在真实窗口里量一遍,
 * 把结果写成 JSON,既能人工看,也能在改动前后对比。
 *
 * 它检查的是几条"硬"的布局不变量(违反任何一条都是 bug,不是审美问题):
 *   1) 面板宽度不得因为行内容而撑破(检查 content-box 溢出);
 *   2) 行内任何文字块都不许溢出它自己的容器(长文件名必须省略,不能顶出去);
 *   3) 任何按钮的文字都不许折成两行(折了就是按钮坏了);
 *   4) 表格化的列表必须列对齐(格式角标、文件名、操作区的左边界一致);
 *   5) 交互目标的命中区不小于 24×24(触屏可点);
 *   6) 文字与背景的对比度达到 WCAG AA(正文 4.5:1,大字 3:1);
 *   7) 面板在窄屏下不得横向溢出视口。
 *
 * 用法(由 tools/measure-ui.mjs 拉起,也可手动):
 *   electron . --measure --measure-width=1464 --measure-out=release/measure
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里跑的测量脚本。只读 DOM 与 getComputedStyle,不改任何状态(除了打开面板)。 */
const MEASURE_JS = `(() => {
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height) };
  };
  const cs = (el) => (el ? getComputedStyle(el) : null);

  /* 相对亮度 + 对比度(WCAG 2.x)。用于判断"文字在背景上够不够清楚"。 */
  const lum = (rgb) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(rgb || '');
    if (!m) return null;
    const parts = m[1].split(',').map((s) => parseFloat(s));
    const [r, g, b] = parts;
    const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  /** 往上找到第一个不透明背景色(元素自己可能是透明的) */
  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const c = getComputedStyle(node).backgroundColor;
      const m = /rgba?\\(([^)]+)\\)/.exec(c || '');
      if (m) {
        const a = m[1].split(',').length > 3 ? parseFloat(m[1].split(',')[3]) : 1;
        if (a > 0.9) return c;
      }
      node = node.parentElement;
    }
    return 'rgb(15,17,21)';
  };
  const contrast = (el) => {
    const fg = cs(el).color;
    const bg = bgOf(el);
    const L1 = lum(fg), L2 = lum(bg);
    if (L1 === null || L2 === null) return null;
    const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  /** 元素里有没有"装不下的文字"。区分两种情况,别把正常的省略当溢出:
   *   · clip      —— overflow 可见/hidden 但**没有**省略号:文字真的顶出去了(缺陷);
   *   · truncated —— 有 text-overflow: ellipsis:文字被省略号收住了(设计如此,
   *                  但它必须配 title 提示,而且不能被截得只剩一点点)。 */
  const textState = (el) => {
    if (!el) return null;
    const style = getComputedStyle(el);
    if (style.overflowX === 'auto' || style.overflowX === 'scroll') return 'scroll';
    const truncated = el.scrollWidth > el.clientWidth + 1;
    if (!truncated) return 'fits';
    return style.textOverflow === 'ellipsis' ? 'truncated' : 'clip';
  };
  const visibleRatio = (el) => {
    if (!el || el.scrollWidth <= 0) return 1;
    return Math.round(Math.min(1, el.clientWidth / el.scrollWidth) * 100) / 100;
  };
  /** 文字是否折行:用 Range 量实际文本行数。
   * 判定"同一行"要比对垂直区间是否重叠 —— 只比 top 会把"同一行里高矮不一的兄弟"
   * 误判成两行(工具条里的开关比按钮高,靠 top 就会数出 2 行)。 */
  const lineCount = (el) => {
    if (!el || !el.firstChild) return 0;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects()).filter((r) => r.height > 1);
    if (!rects.length) return 0;
    const rows = [];
    for (const r of rects.sort((a, b) => a.top - b.top)) {
      const hit = rows.find((row) => r.top < row.bottom - 1 && r.bottom > row.top + 1);
      if (hit) {
        hit.top = Math.min(hit.top, r.top);
        hit.bottom = Math.max(hit.bottom, r.bottom);
      } else {
        rows.push({ top: r.top, bottom: r.bottom });
      }
    }
    return rows.length;
  };
  /** 一组兄弟元素实际占了几行(按垂直区间重叠归并,同上) */
  const rowsOf = (parent) => {
    if (!parent) return 0;
    const kids = Array.from(parent.children)
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.height > 0);
    if (!kids.length) return 0;
    const rows = [];
    for (const r of kids.sort((a, b) => a.top - b.top)) {
      const hit = rows.find((row) => r.top < row.bottom - 1 && r.bottom > row.top + 1);
      if (hit) { hit.top = Math.min(hit.top, r.top); hit.bottom = Math.max(hit.bottom, r.bottom); }
      else rows.push({ top: r.top, bottom: r.bottom });
    }
    return rows.length;
  };

  const panel = document.getElementById('downloadsPanel');
  const out = {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    panelOpen: !!panel && !panel.hidden,
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
  };

  /* ---- 顶栏:入口按钮与动画选择器谁占了多少、有没有挤在一起 ---- */
  const topbar = document.querySelector('.topbar');
  const brand = document.querySelector('.brand');
  const switchEl = document.querySelector('.anim-switch');
  const dlBtn = document.getElementById('btnDownloads');
  out.topbar = {
    rect: rectOf(topbar),
    rowCount: rowsOf(topbar),          // 顶栏必须始终 1 行
    /* 逐个孩子列出宽度与所在行:顶栏换行时,唯一能指出"是谁把行撑破了"的证据 */
    children: topbar ? Array.from(topbar.children).map((c) => ({
      cls: c.className || c.tagName,
      rect: rectOf(c),
      display: getComputedStyle(c).display,
    })) : [],
    /* 视觉间距的算法见下面 gap 断言处的注释:DOM 顺序与视觉顺序未必一致,要取绝对值 */
    gapBetweenSwitchAndButton: (() => {
      if (!switchEl || !dlBtn) return null;
      const a = switchEl.getBoundingClientRect();
      const b = dlBtn.getBoundingClientRect();
      return px(Math.abs(b.left - a.left) > Math.abs(a.left - b.right)
        ? Math.abs(a.left - b.right)
        : Math.abs(b.left - a.right));
    })(),
    sameRowAsSwitch: (() => {
      if (!switchEl || !dlBtn) return null;
      const a = switchEl.getBoundingClientRect();
      const b = dlBtn.getBoundingClientRect();
      return b.top < a.bottom && b.bottom > a.top;
    })(),
    brandRect: rectOf(brand),
    switchRect: rectOf(switchEl),
    buttonRect: rectOf(dlBtn),
    buttonLabelLines: dlBtn ? lineCount(dlBtn.querySelector('.dw-open-text')) : 0,
    buttonLabelShown: !!(dlBtn && dlBtn.querySelector('.dw-open-text') && getComputedStyle(dlBtn.querySelector('.dw-open-text')).display !== 'none'),
    buttonVisible: !!dlBtn && !dlBtn.hidden,
  };

  if (!out.panelOpen) return out;

  const dp = document.querySelector('.dw-panel');
  const head = document.querySelector('.dw-head');
  const bar = document.querySelector('.dw-bar');
  const body = document.querySelector('.dw-body');
  const list = document.getElementById('downloadsList');
  const foot = document.querySelector('.dw-foot');
  out.panel = {
    rect: rectOf(dp),
    headRect: rectOf(head),
    barRect: rectOf(bar),
    bodyRect: rectOf(body),
    listRect: rectOf(list),
    footRect: rectOf(foot),
    /* 面板自身有没有被内容顶破(overflowX:visible 才算真溢出) */
    overflowX: textState(dp) === 'clip',
    /* 三段高度占面板的比例:头部/工具条/底部如果吃掉太多,列表就被压扁 */
    chromeRatio: 0,
    scrollable: body ? body.scrollHeight > body.clientHeight + 1 : null,
  };
  if (dp && out.panel.rect) {
    const chrome = out.panel.rect.h - (out.panel.bodyRect ? out.panel.bodyRect.h : 0);
    out.panel.chromeRatio = Math.round((chrome / out.panel.rect.h) * 100) / 100;
  }

  /* ---- 列表行:几何、对齐、溢出、按钮折行、命中区 ---- */
  const rows = Array.from(document.querySelectorAll('#downloadsList .dw-row'));
  out.rows = rows.map((row, i) => {
    const fmt = row.querySelector('.dw-fmt');
    const name = row.querySelector('.dw-name');
    const meta = row.querySelector('.dw-meta');
    const acts = row.querySelector('.dw-acts');
    const btns = Array.from(row.querySelectorAll('button'));
    return {
      i,
      rect: rectOf(row),
      missing: row.classList.contains('is-missing'),
      fmtRect: rectOf(fmt),
      nameRect: rectOf(name),
      /* 文件名允许省略号收尾(设计如此),但要记下"被截掉多少"和"有没有 title 兜底" */
      nameState: textState(name),
      nameVisibleRatio: visibleRatio(name),
      nameHasTitle: !!(name && name.getAttribute('title')),
      nameLines: name ? lineCount(name) : 0,
      metaRect: rectOf(meta),
      /* 元信息是"体积 · 帧数 · 时间",必须完整可读 —— 被省略号截掉就算缺陷 */
      metaState: textState(meta),
      metaVisibleRatio: visibleRatio(meta),
      metaLines: meta ? lineCount(meta) : 0,
      actsRect: rectOf(acts),
      /* 操作区按钮:命中区是否够大、文字是否折行 */
      buttons: btns.map((b) => ({
        label: (b.textContent || '').trim(),
        rect: rectOf(b),
        lines: lineCount(b),
        fontSize: px(cs(b).fontSize),
        contrast: contrast(b),
      })),
      /* 行内的间距:角标→文件名、文件名→操作区 */
      gapFmtToInfo: (fmt && name) ? px(name.getBoundingClientRect().left - fmt.getBoundingClientRect().right) : null,
      /* 行高与内容高:行高明显大于内容高 = 上下留白过多 */
      contentH: name && meta ? px(meta.getBoundingClientRect().bottom - name.getBoundingClientRect().top) : null,
      fontSizeName: name ? px(cs(name).fontSize) : null,
      fontSizeMeta: meta ? px(cs(meta).fontSize) : null,
      contrastName: name ? contrast(name) : null,
      contrastMeta: meta ? contrast(meta) : null,
    };
  });

  /* ---- 信息列的可读宽度:面板变窄时最先牺牲的就是文件名,量出来才知道牺牲了多少 ---- */
  const infoEl = document.querySelector('#downloadsList .dw-info');
  const nameEl = document.querySelector('#downloadsList .dw-name');
  out.infoColumn = {
    width: infoEl ? Math.round(infoEl.getBoundingClientRect().width) : null,
    nameWidth: nameEl ? Math.round(nameEl.getBoundingClientRect().width) : null,
    /* 名字完整显示时需要的宽度:用 scrollWidth(被省略时它仍是全文宽度) */
    nameNatural: nameEl ? Math.round(nameEl.scrollWidth) : null,
  };

  /* ---- 列对齐:所有行的角标左边界 / 操作区左边界是否一致 ---- */
  const lefts = (sel) => rows.map((r) => {
    const el = r.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().left) : null;
  }).filter((v) => v !== null);
  const spread = (arr) => (arr.length ? Math.max(...arr) - Math.min(...arr) : 0);
  const rights = (sel) => rows.map((r) => {
    const el = r.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().right) : null;
  }).filter((v) => v !== null);
  out.alignment = {
    fmtLeftSpread: spread(lefts('.dw-fmt')),
    nameLeftSpread: spread(lefts('.dw-name')),
    actsRightSpread: spread(rights('.dw-acts')),
  };

  /* ---- 工具条与底部:控件尺寸、文字折行、对比度 ---- */
  const barButtons = Array.from(document.querySelectorAll('#downloadsBar button'));
  out.bar = {
    controls: barButtons.map((b) => ({
      label: (b.textContent || '').trim(),
      rect: rectOf(b),
      lines: lineCount(b),
      contrast: contrast(b),
    })),
    toggleLines: (() => { const t = document.querySelector('.dw-toggle'); return t ? lineCount(t) : 0; })(),
    wraps: rowsOf(bar),
  };
  const hints = Array.from(document.querySelectorAll('.dw-foot .dw-hint, .dw-sub'));
  out.text = hints.map((el) => ({
    text: (el.textContent || '').trim().slice(0, 80),
    lines: lineCount(el),
    fontSize: px(cs(el).fontSize),
    contrast: contrast(el),
    state: textState(el),
    visibleRatio: visibleRatio(el),
  }));

  return out;
})()`;

/**
 * 在不同窗口宽度下量一遍。宽度覆盖:大桌面、常见笔记本、窄桌面、跨过 720 断点、手机。
 * 每一步都等一帧再量,避免拿到改尺寸过程中的中间值。
 *
 * 注意:主窗口有 minWidth(1024),只 setSize 是压不到 720/420 的 —— 那样量到的
 * 全是同一个宽度,窄屏规则永远测不到。所以每一步先把最小尺寸放开,量完最后再恢复。
 */
const WIDTHS = [1464, 1280, 1180, 1024, 900, 720, 420];
const MIN_W = { width: 1024, height: 640 };

async function runMeasure(ctx) {
  const { win, outDir } = ctx;
  const wc = win.webContents;
  const report = { startedAt: new Date().toISOString(), steps: [], invariants: [], failures: [] };

  win.show();
  await sleep(600);

  for (const width of WIDTHS) {
    try {
      win.setMinimumSize(Math.min(width, MIN_W.width), MIN_W.height);
      win.setSize(width, 900);
    } catch { /* 忽略 */ }
    await sleep(350);
    /* 打开面板(第一次会去取列表;后面只是重新量几何) */
    try {
      await wc.executeJavaScript(`(() => {
        const panel = document.getElementById('downloadsPanel');
        if (panel && panel.hidden) {
          const btn = document.getElementById('btnDownloads');
          if (btn) btn.click();
        }
        return true;
      })()`, true);
    } catch { /* 忽略 */ }
    await sleep(500);
    let data = null;
    try {
      data = await wc.executeJavaScript(MEASURE_JS, true);
    } catch (e) {
      report.failures.push('宽度 ' + width + ' 测量失败: ' + e.message);
      continue;
    }
    report.steps.push({ requestedWidth: width, data });
  }

  /* 量完把窗口的最小尺寸恢复成应用的真实下限(见 main.cjs 的 MIN_BOUNDS) */
  try { win.setMinimumSize(MIN_W.width, MIN_W.height); } catch { /* 忽略 */ }

  /* ---- 断言语义:把"看着不对"翻译成可复现的失败项 ---- */
  const fail = (m) => report.failures.push(m);
  const stepOf = (w) => report.steps.find((s) => s.requestedWidth === w);

  for (const step of report.steps) {
    const w = step.requestedWidth;
    const d = step.data;
    if (!d || !d.panelOpen) { fail(w + 'px:下载列表面板没有打开,量不到几何'); continue; }
    if (d.bodyScrollWidth > d.bodyClientWidth + 1) {
      fail(w + 'px:页面出现横向滚动(' + d.bodyScrollWidth + ' > ' + d.bodyClientWidth + ')');
    }
    if (d.panel.overflowX) fail(w + 'px:面板横向溢出');
    if (d.panel.rect && d.panel.rect.w > d.viewport.w + 1) {
      fail(w + 'px:面板比视口还宽(' + d.panel.rect.w + ' > ' + d.viewport.w + ')');
    }
    if (w > 720 && d.panel.chromeRatio > 0.4) {
      fail(w + 'px:面板的头部+工具条+底部占掉了 ' + Math.round(d.panel.chromeRatio * 100) + '%(列表被压扁,建议 ≤ 35%)');
    }
    (d.rows || []).forEach((r) => {
      /* 文件名:允许省略号,但不许"没有省略号地顶出去";被截掉时必须有 title 兜底,
       * 而且可见比例不能低到只剩几个字(那时应该让面板更宽或字号更小)。 */
      if (r.nameState === 'clip') fail(w + 'px 第' + (r.i + 1) + '行:文件名溢出容器(没有省略号收尾)');
      if (r.nameState === 'truncated') {
        if (!r.nameHasTitle) fail(w + 'px 第' + (r.i + 1) + '行:文件名被截断但没有 title,看不到全名');
        if (r.nameVisibleRatio < 0.45) {
          fail(w + 'px 第' + (r.i + 1) + '行:文件名只显示得下 ' + Math.round(r.nameVisibleRatio * 100) + '%(信息列太窄)');
        }
      }
      /* 元信息(体积 · 帧数 · 时间)是列表的核心信息,必须完整可读 */
      if (r.metaState === 'clip') fail(w + 'px 第' + (r.i + 1) + '行:元信息溢出容器');
      if (r.metaState === 'truncated') {
        fail(w + 'px 第' + (r.i + 1) + '行:元信息被截断(只显示 ' + Math.round(r.metaVisibleRatio * 100) + '%)');
      }
      if (r.nameLines > 1) fail(w + 'px 第' + (r.i + 1) + '行:文件名折成 ' + r.nameLines + ' 行');
      /* 元信息在窄屏可以折行(宁可多占一行也不能被省略号吃掉),所以只在桌面宽度下要求单行 */
      if (r.metaLines > 1 && w >= 1024) {
        fail(w + 'px 第' + (r.i + 1) + '行:元信息折成 ' + r.metaLines + ' 行(桌面宽度下应当单行)');
      }
      r.buttons.forEach((b) => {
        if (b.lines > 1) fail(w + 'px 第' + (r.i + 1) + '行:按钮「' + b.label + '」折成 ' + b.lines + ' 行');
        if (b.rect && (b.rect.h < 24 || b.rect.w < 24)) {
          fail(w + 'px 第' + (r.i + 1) + '行:按钮「' + b.label + '」命中区只有 ' + b.rect.w + '×' + b.rect.h);
        }
        if (b.contrast !== null && b.contrast < 4.5) {
          fail(w + 'px 第' + (r.i + 1) + '行:按钮「' + b.label + '」对比度 ' + b.contrast + ' < 4.5');
        }
      });
      if (r.contrastName !== null && r.contrastName < 4.5) {
        fail(w + 'px 第' + (r.i + 1) + '行:文件名对比度 ' + r.contrastName + ' < 4.5');
      }
      if (r.contrastMeta !== null && r.contrastMeta < 4.5) {
        fail(w + 'px 第' + (r.i + 1) + '行:元信息对比度 ' + r.contrastMeta + ' < 4.5');
      }
    });
    if (d.alignment) {
      if (d.alignment.fmtLeftSpread > 1) fail(w + 'px:格式角标左边没有对齐(差 ' + d.alignment.fmtLeftSpread + 'px)');
      if (d.alignment.actsRightSpread > 2) fail(w + 'px:操作区右边没有对齐(差 ' + d.alignment.actsRightSpread + 'px)');
    }
    /* 顶栏必须始终一行 —— 这是硬规则,换了行就是坏了 */
    if (d.topbar && d.topbar.rowCount > 1) {
      fail(w + 'px:顶栏折成 ' + d.topbar.rowCount + ' 行(桌面端必须单行)');
    }
    if (d.topbar && d.topbar.buttonLabelLines > 1) fail(w + 'px:顶栏「下载列表」按钮文字折行');
    /* 工具条在桌面宽度下必须单行(窄屏允许换行,所以只查 ≥1024) */
    if (d.bar && d.bar.wraps > 1 && w >= 1024) {
      fail(w + 'px:下载面板工具条折成 ' + d.bar.wraps + ' 行(桌面宽度下应当一行放下)');
    }
    (d.text || []).forEach((t) => {
      if (t.state === 'clip') fail(w + 'px:说明文字溢出「' + t.text.slice(0, 24) + '…」');
      if (t.lines > 1 && w >= 1024) fail(w + 'px:说明文字折成 ' + t.lines + ' 行「' + t.text.slice(0, 24) + '…」');
      if (t.contrast !== null && t.contrast < 4.5) fail(w + 'px:说明文字对比度 ' + t.contrast + ' < 4.5');
    });
    /* 信息列的最小可读宽度:低于这个数,四个操作按钮就把文件名挤得没法认 */
    if (d.infoColumn && d.infoColumn.width !== null && w >= 1024 && d.infoColumn.width < 300) {
      fail(w + 'px:文件名可用宽度只有 ' + d.infoColumn.width + 'px(操作区把信息列挤太狠)');
    }
  }

  /* ---- 行高/字号的比例检查 ---- */
  const base = stepOf(1464) || report.steps[0];
  if (base && base.data.rows && base.data.rows.length) {
    const r = base.data.rows[0];
    report.metrics = {
      rowHeight: r.rect ? r.rect.h : null,
      rowContentHeight: r.contentH,
      paddingVertical: (r.rect && r.contentH) ? Math.round(((r.rect.h - r.contentH) / 2) * 100) / 100 : null,
      nameFontSize: r.fontSizeName,
      metaFontSize: r.fontSizeMeta,
      metaToNameRatio: (r.fontSizeName && r.fontSizeMeta) ? Math.round((r.fontSizeMeta / r.fontSizeName) * 100) / 100 : null,
      panelWidth: base.data.panel.rect ? base.data.panel.rect.w : null,
      panelToViewportRatio: base.data.panel.rect ? Math.round((base.data.panel.rect.w / base.data.viewport.w) * 100) / 100 : null,
      chromeRatio: base.data.panel.chromeRatio,
      fmtBadgeWidth: r.fmtRect ? r.fmtRect.w : null,
      listVisibleHeight: base.data.panel.bodyRect ? base.data.panel.bodyRect.h : null,
      rowHeightToNameRatio: (r.rect && r.fontSizeName) ? Math.round((r.rect.h / r.fontSizeName) * 100) / 100 : null,
      /* 角标的最小可读宽度:WEBM 这类四字母标签也要放得下 */
      fmtBadgeMinWidthForWebm: null,
    };
    const m = report.metrics;
    /* 比例断言(只在 1440px 级视口下判定,那是"设计意图"生效的宽度) */
    if (m.metaToNameRatio !== null && m.metaToNameRatio < 0.85) {
      fail('元信息字号只有文件名的 ' + Math.round(m.metaToNameRatio * 100) + '%(小于 85% 就偏小难读)');
    }
    if (m.rowHeightToNameRatio !== null && m.rowHeightToNameRatio > 8) {
      fail('行高是文件名字号的 ' + m.rowHeightToNameRatio + ' 倍(超过 8 倍显得松散)');
    }
    if (m.chromeRatio > 0.45) {
      fail('面板头部+工具条+底部占掉 ' + Math.round(m.chromeRatio * 100) + '%(超过 45% 列表就被压扁了)');
    }
    if (m.panelToViewportRatio !== null && (m.panelToViewportRatio < 0.5 || m.panelToViewportRatio > 0.85)) {
      fail('面板占视口 ' + Math.round(m.panelToViewportRatio * 100) + '%(合理区间 50%~85%)');
    }
    if (m.paddingVertical !== null && (m.paddingVertical < 8 || m.paddingVertical > 18)) {
      fail('行内上下留白 ' + m.paddingVertical + 'px(合理区间 8~18px)');
    }
    /* 顶栏那块"选择器与下载入口"的间距:太小会挤在一起,太大说明有元素被压得太狠。
     * 只在两者落在同一行时判定 —— 分成两行说明顶栏已经换行,那是上面那条断言的事。 */
    const gapStep = base.data.topbar ? base.data.topbar.gapBetweenSwitchAndButton : null;
    const sameRow = base.data.topbar ? base.data.topbar.sameRowAsSwitch : false;
    if (sameRow && gapStep !== null && gapStep < 8) {
      fail('顶栏「动画选择器」与「下载列表」入口只隔了 ' + Math.round(gapStep) + 'px(太挤,建议 ≥8px)');
    }
  }

  /* ---- 极值:超长文件名、缺失文件、空列表 ---- */
  try {
    const stress = await wc.executeJavaScript(`(() => {
      const name = document.querySelector('#downloadsList .dw-name');
      if (!name) return null;
      const original = name.textContent;
      name.textContent = '撤离动画-超长文件名压力测试-'.repeat(4) + '20261007-153705.mp4';
      const r = name.getBoundingClientRect();
      const info = name.parentElement.getBoundingClientRect();
      const over = name.scrollWidth > name.clientWidth + 1;
      const inside = r.right <= info.right + 0.5;
      name.textContent = original;
      return { overflowScroll: over, staysInside: inside, nameW: Math.round(r.width), infoW: Math.round(info.width) };
    })()`, true);
    report.stress = stress;
    if (stress) {
      if (!stress.overflowScroll) fail('超长文件名没有触发省略(scrollWidth 未超出)');
      if (!stress.staysInside) fail('超长文件名溢出到信息区之外');
    }
  } catch (e) {
    report.failures.push('超长文件名压力测试失败: ' + e.message);
  }

  report.ok = report.failures.length === 0;
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'measure-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  report.reportPath = jsonPath;

  const lines = [];
  lines.push('');
  lines.push('============ 界面布局审计(下载列表) ============');
  if (report.metrics) {
    const m = report.metrics;
    lines.push(`面板宽 ${m.panelWidth}px(视口 ${base.data.viewport.w}px,占 ${Math.round(m.panelToViewportRatio * 100)}%)`
      + ` | 头部+工具条+底部占 ${Math.round(m.chromeRatio * 100)}% | 列表可视高 ${m.listVisibleHeight}px`);
    lines.push(`行高 ${m.rowHeight}px(内容 ${m.rowContentHeight}px → 上下各 ${m.paddingVertical}px)`
      + ` | 文件名 ${m.nameFontSize}px / 元信息 ${m.metaFontSize}px(比 ${m.metaToNameRatio}) | 格式角标宽 ${m.fmtBadgeWidth}px`);
  }
  for (const step of report.steps) {
    const d = step.data;
    if (!d || !d.panel) continue;
    const row0 = (d.rows || [])[0] || {};
    lines.push(`${String(step.requestedWidth).padStart(4)}px(实测视口 ${d.viewport.w})`
      + ` 面板 ${d.panel.rect ? d.panel.rect.w : '?'}×${d.panel.rect ? d.panel.rect.h : '?'}`
      + ` 行高 ${row0.rect ? row0.rect.h : '?'}`
      + ` 角标 ${row0.fmtRect ? row0.fmtRect.w : '?'}px`
      + ` 工具条行数 ${d.bar ? d.bar.wraps : '?'}`
      + ` 列表可滚 ${d.panel.scrollable ? '是' : '否'}`);
  }
  if (report.stress) lines.push(`超长文件名: 省略=${report.stress.overflowScroll} 留在区内=${report.stress.staysInside}`);
  lines.push(report.ok ? '结论: 布局不变量全部通过 ✅' : `结论: ${report.failures.length} 项不通过 ❌`);
  report.failures.forEach((f, i) => lines.push(`  ${i + 1}) ${f}`));
  lines.push(`完整报告: ${jsonPath}`);
  lines.push('================================================');
  console.log(lines.join('\n'));
  console.log('__MEASURE_JSON__' + JSON.stringify(report));
  return report.ok ? 0 : 1;
}

module.exports = { runMeasure };
