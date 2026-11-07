/* 导出成功态 + 减少动效的常驻回归(开发期辅助,不参与构建):
 *   node tools/verify-ux-motion.mjs [--url http://127.0.0.1:5173/] [--only desktop|mobile] [--out-dir release/ui-audit]
 *
 * 覆盖用户明确要求的 6 条:
 *   1) 导出成功后 .export-card.is-done 存在;
 *   2) 对勾在视口内且真的可见(不是 opacity:0 / 被裁);
 *   3) 文案「导出成功」可见;
 *   4) 进度区不可见(visibility/opacity 都判);
 *   5) 渲染日志默认折叠、点「查看渲染日志」能展开、再点能收起;
 *   6) 导出动作按钮可命中(elementFromPoint 打到它自己,且在视口内)。
 * 另外跑一遍 prefers-reduced-motion: reduce:浮层内不再有可感知的关键帧动画(时长 <= 1ms),
 * 且成功态信息仍然完整(对勾已画完、标题/文件名/按钮都在)。
 *
 * 两套前端分别跑:桌面 1480x940(style.css)与手机 390x844(?ui=mobile + isMobile/hasTouch)。
 * 退出码 0 = 全绿;1 = 有 FAIL。真实导出每轮约 20s,整份脚本约 2-3 分钟,属于发布前/改壳后跑的那一类。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const has = (name) => args.includes('--' + name);
const url = arg('url', 'http://127.0.0.1:5173/');
const only = arg('only', 'both');
const outDir = arg('out-dir', '');
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const exe = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
if (!exe) { console.error('NO_BROWSER: 找不到 Chrome/Edge'); process.exit(2); }
if (outDir) fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const lines = [];
const check = (name, ok, detail) => {
  if (!ok) fails++;
  lines.push((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '   ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};
const round1 = (n) => Math.round(n * 10) / 10;

/** 打开编辑器并等它可导出 */
async function openEditor(page, { mobile, reduced }) {
  await page.setViewport({ width: mobile ? 390 : 1480, height: mobile ? 844 : 940, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  else await page.emulateMediaFeatures([]);
  const target = url + (url.includes('?') ? '&' : '?') + (mobile ? 'ui=mobile' : 'ui=desktop');
  /* 开发机被并发任务压住时,单次 goto 偶发 60s 超时;这不是产品失败,重试一次再判负。 */
  let navErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 120000 });
      navErr = null;
      break;
    } catch (e) {
      navErr = e;
      await sleep(1200);
    }
  }
  if (navErr) throw navErr;
  await page.waitForFunction(() => {
    const el = document.getElementById('app-loading');
    return !el || el.classList.contains('is-hidden');
  }, { timeout: 120000, polling: 300 });
  await sleep(600);
  await page.evaluate(() => document.querySelector('.rail-item[data-page="editor"]')?.click());
  await page.waitForFunction(() => {
    const b = document.getElementById('btnExport');
    return !!b && !b.disabled && b.getBoundingClientRect().height > 0;
  }, { timeout: 60000, polling: 200 });
  await sleep(1200);
  /* 高度过渡采样:从导出开始逐帧记 #exportCard 高度,成功态用 done 标记。
   * 目的:防止以后把 animateExportCardHeight 删了(卡片直接跳)却仍然全绿。 */
  await page.evaluate(() => {
    window.__exportHeightSamples = [];
    window.__exportHeightDoneAt = 0;
    let stop = false;
    window.__stopExportHeightSampler = () => { stop = true; };
    const tick = () => {
      if (stop) return;
      const card = document.getElementById('exportCard');
      if (card) {
        const r = card.getBoundingClientRect();
        window.__exportHeightSamples.push({ t: performance.now(), h: +r.height.toFixed(2), done: card.classList.contains('is-done') });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** 点导出并等到成功/失败;返回 {state, baseHeight, doneAt} */
async function runExport(page) {
  await page.evaluate(() => document.getElementById('btnExport')?.click());
  await sleep(1200);
  const baseHeight = await page.evaluate(() => {
    const c = document.getElementById('exportCard');
    return c ? +c.getBoundingClientRect().height.toFixed(2) : 0;
  });
  const state = await page.waitForFunction(() => {
    const card = document.getElementById('exportCard');
    if (card && card.classList.contains('is-done')) return 'done';
    const p = document.getElementById('exportPercent');
    if (p && p.classList.contains('error')) return 'error';
    if (p && p.classList.contains('cancel')) return 'cancel';
    return '';
  }, { timeout: 300000, polling: 400 }).then((h) => h.jsonValue()).catch(() => 'timeout');
  const doneAt = state === 'done' ? Date.now() : 0;
  return { state, baseHeight, doneAt };
}

const METRICS = () => {
  const q = (s) => document.querySelector(s);
  const r = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const inViewport = (rc) => !!rc && rc.width > 0 && rc.height > 0 && rc.top >= -0.5 && rc.left >= -0.5 && rc.bottom <= innerHeight + 0.5 && rc.right <= innerWidth + 0.5;
  const visible = (el) => {
    if (!el) return false;
    const s = cs(el);
    const rc = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && rc.width > 0 && rc.height > 0;
  };
  const parseMs = (v) => {
    if (!v || v === 'none') return 0;
    const parts = String(v).split(',').map((s) => s.trim());
    return Math.max(...parts.map((p) => {
      const n = parseFloat(p);
      if (Number.isNaN(n)) return 0;
      return p.endsWith('ms') ? n : n * 1000;
    }));
  };
  const checkEl = q('.export-check');
  const titleEl = q('.export-success-title');
  const nameEl = q('.export-success-name');
  const progressEl = q('.export-progress');
  const slotEl = q('.export-log-slot');
  const toggleEl = q('#btnExportLog');
  const card = q('.export-card');
  const actions = [...document.querySelectorAll('.export-actions :is(button, fluent-button)')].map((b) => {
    const rc = b.getBoundingClientRect();
    const s = cs(b);
    const cx = rc.left + rc.width / 2;
    const cy = rc.top + rc.height / 2;
    const hit = (rc.width > 0 && rc.height > 0) ? document.elementFromPoint(cx, cy) : null;
    return {
      id: b.id || b.textContent.trim().slice(0, 12),
      text: (b.textContent || '').trim(),
      hidden: b.hidden,
      display: s.display,
      visibility: s.visibility,
      opacity: Number(s.opacity),
      pointerEvents: s.pointerEvents,
      rect: rc.toJSON(),
      hitSelf: !!hit && (hit === b || b.contains(hit)),
      hitId: hit ? (hit.id || hit.tagName) : null,
    };
  });
  const anims = ['.export-check-ring circle', '.export-check-mark path', '.export-success-title', '.export-success-name', '.export-success-sub', '.export-actions', '.export-foot'].map((sel) => {
    const el = q(sel);
    if (!el) return { sel, missing: true };
    const s = cs(el);
    return { sel, name: s.animationName, durationMs: parseMs(s.animationDuration), delayMs: parseMs(s.animationDelay), transitionMs: parseMs(s.transitionDuration) };
  });
  const overlayAnims = (document.getAnimations ? document.getAnimations() : []).filter((a) => {
    const t = a.effect && a.effect.target;
    return t && document.getElementById('exportOverlay')?.contains(t);
  }).map((a) => ({ durationMs: parseMs(a.effect.getTiming().duration + 'ms'), playState: a.playState }));
  const markPath = q('.export-check-mark path');
  return {
    cardClasses: card ? card.className : '',
    isDone: !!card && card.classList.contains('is-done'),
    isLogOpen: !!card && card.classList.contains('is-log-open'),
    check: { rect: r(checkEl), visible: visible(checkEl), inViewport: inViewport(r(checkEl)), opacity: checkEl ? Number(cs(checkEl).opacity) : null, dashoffset: markPath ? getComputedStyle(markPath).strokeDashoffset : null },
    title: { text: titleEl ? titleEl.textContent.trim() : '', rect: r(titleEl), visible: visible(titleEl), inViewport: inViewport(r(titleEl)) },
    name: { text: nameEl ? nameEl.textContent.trim() : '', visible: visible(nameEl) },
    progress: { display: cs(progressEl)?.display, visibility: cs(progressEl)?.visibility, opacity: progressEl ? Number(cs(progressEl).opacity) : null, height: progressEl ? Math.round(progressEl.getBoundingClientRect().height) : 0 },
    progressInvisible: !progressEl || (cs(progressEl).visibility === 'hidden' || Number(cs(progressEl).opacity) < 0.05 || cs(progressEl).display === 'none'),
    log: {
      slotHeight: slotEl ? Math.round(slotEl.getBoundingClientRect().height) : -1,
      toggleText: toggleEl ? toggleEl.textContent.trim() : '',
      toggleExpanded: toggleEl ? toggleEl.getAttribute('aria-expanded') : null,
      toggleRect: r(toggleEl),
      toggleVisible: visible(toggleEl),
      footHidden: document.getElementById('exportFoot')?.hidden,
    },
    actions,
    interactions: actions.filter((a) => !a.hidden && a.display !== 'none'),
    anims,
    overlayAnims,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    statusbar: document.getElementById('statusbar')?.textContent,
    activeElement: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
  };
};

async function runCase(kind, reduced) {
  const mobile = kind === 'mobile';
  const tag = kind + (reduced ? '-reduced-motion' : '');
  lines.push('');
  lines.push('========== ' + tag + ' ==========');
  const browser = await puppeteer.launch({
    executablePath: exe, headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--force-color-profile=srgb', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  let downloadDir = '';
  try {
    downloadDir = path.join(outDir || 'release/ui-audit', '.downloads-' + tag);
    fs.rmSync(downloadDir, { recursive: true, force: true });
    fs.mkdirSync(downloadDir, { recursive: true });
    const cdp = await page.createCDPSession();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(downloadDir) }).catch(() => {});
  } catch { /* 下载行为设置失败不影响导出成功态 */ }

  try {
    await openEditor(page, { mobile, reduced });
    const { state, baseHeight, doneAt } = await runExport(page);
    if (state !== 'done') {
      const diag = await page.evaluate(() => ({
        percent: document.getElementById('exportPercent')?.textContent,
        status: document.getElementById('exportStatus')?.textContent,
        detail: document.getElementById('exportDetail')?.textContent,
        card: document.getElementById('exportCard')?.className,
      })).catch(() => null);
      check(tag + ': 导出完成(成功态)', false, { state, diag, errors: errors.slice(0, 5) });
      return;
    }
    await sleep(reduced ? 350 : 1300); /* 正常动效最后一段 520ms + 余量;减少动效几乎瞬时 */
    let m = await page.evaluate(METRICS);

    /* 高度过渡:卡片从带日志的进度态收成成功态。正常动效必须量到中间高度;
     * 减少动效必须直接落位(没有中间高度),防止 transition 被 reducemotion 漏掉。 */
    const heightInfo = await page.evaluate((base) => {
      window.__stopExportHeightSampler?.();
      const samples = window.__exportHeightSamples || [];
      const done = samples.filter((s) => s.done).map((s) => s.h);
      const unique = [...new Set(done.map((h) => Math.round(h)))];
      return {
        base, final: done.length ? done[done.length - 1] : null,
        sampleCount: samples.length, doneCount: done.length,
        unique, min: done.length ? Math.min(...done) : null, max: done.length ? Math.max(...done) : null,
      };
    }, baseHeight);
    const interim = heightInfo.final == null ? [] : heightInfo.unique.filter((h) => h > Math.round(heightInfo.final) + 1 && h < Math.round(heightInfo.base) - 1);
    check(tag + ': 成功卡最终比进度态矮(高度确实收缩)', heightInfo.final != null && heightInfo.base - heightInfo.final >= 20, heightInfo);
    if (reduced) {
      check(tag + ': 减少动效下卡片直接落位(没有中间高度)', interim.length === 0, { interim, heightInfo });
    } else {
      check(tag + ': 卡片高度过渡确实发生(至少 2 个中间高度)', interim.length >= 2, { interim, heightInfo });
    }

    check(tag + ': .export-card.is-done 存在', m.isDone, m.cardClasses);
    check(tag + ': 对勾在视口内', m.check.inViewport, m.check.rect);
    check(tag + ': 对勾可见(opacity > .05)', m.check.visible && m.check.opacity > 0.05, { visible: m.check.visible, opacity: m.check.opacity });
    check(tag + ': 文案「导出成功」可见', m.title.text.includes('导出成功') && m.title.visible, m.title);
    check(tag + ': 进度区不可见', m.progressInvisible, m.progress);
    check(tag + ': 渲染日志默认折叠', !m.isLogOpen && m.log.slotHeight <= 1, { isLogOpen: m.isLogOpen, slotHeight: m.log.slotHeight });
    check(tag + ': 日志入口可见且文案是「查看渲染日志」', m.log.toggleVisible && m.log.toggleText === '查看渲染日志' && m.log.toggleExpanded === 'false', m.log);
    check(tag + ': 动作按钮至少一个且全部可命中', m.interactions.length > 0 && m.interactions.every((a) => a.hitSelf && a.rect.width >= 24 && a.rect.height >= 24 && a.visibility !== 'hidden' && a.pointerEvents !== 'none'), m.interactions.map((a) => ({ id: a.id, text: a.text, hitSelf: a.hitSelf, w: Math.round(a.rect.width), h: Math.round(a.rect.height), hitId: a.hitId })));
    if (mobile) {
      /* 触控基线:成功态的两个出口在粗指针下必须 >= 40px(DESIGN 的触屏命中区口径)。
       * 这一条对应用户报过的"成功页点不中",桌面 36px 鼠标目标不算失败。 */
      check(tag + ': 手机:日志入口触控高 >= 40px', !!m.log.toggleRect && m.log.toggleRect.height >= 40, m.log.toggleRect);
      check(tag + ': 手机:动作按钮触控高 >= 40px', m.interactions.every((a) => a.rect.height >= 40), m.interactions.map((a) => ({ id: a.id, h: Math.round(a.rect.height) })));
    }
    check(tag + ': 无页面级 JS 报错', errors.length === 0, errors.slice(0, 6));

    /* 日志展开 -> 收起 */
    const toggleHit = await page.evaluate(() => {
      const b = document.getElementById('btnExportLog');
      if (!b) return { ok: false, reason: 'missing' };
      const rc = b.getBoundingClientRect();
      const hit = document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2);
      b.click();
      return { ok: true, hitSelf: !!hit && (hit === b || b.contains(hit)), rect: rc.toJSON() };
    });
    await sleep(700);
    const expanded = await page.evaluate(METRICS);
    check(tag + ': 日志可展开(高度 > 20px、文案变「收起渲染日志」)', toggleHit.ok && expanded.isLogOpen && expanded.log.slotHeight > 20 && expanded.log.toggleText.includes('收起'), { isLogOpen: expanded.isLogOpen, slotHeight: expanded.log.slotHeight, text: expanded.log.toggleText, hitSelf: toggleHit.hitSelf });
    await page.evaluate(() => document.getElementById('btnExportLog')?.click());
    await sleep(600);
    const collapsed = await page.evaluate(METRICS);
    check(tag + ': 日志可再次收起', !collapsed.isLogOpen && collapsed.log.slotHeight <= 1, { isLogOpen: collapsed.isLogOpen, slotHeight: collapsed.log.slotHeight });

    if (reduced) {
      const animated = m.anims.filter((a) => !a.missing && a.durationMs > 1);
      const running = m.overlayAnims.filter((a) => a.durationMs > 1);
      check(tag + ': 减少动效下浮层内关键帧动画时长 <= 1ms', animated.length === 0, animated);
      check(tag + ': 减少动效下没有仍在播的长动画', running.length === 0, running);
      check(tag + ': 减少动效下对勾已画完(不再停在 0)', m.check.dashoffset == null || parseFloat(m.check.dashoffset) <= 0.5, m.check.dashoffset);
      check(tag + ': 减少动效下成功态信息完整(标题+文件名+动作)', m.title.visible && !!m.name.text && m.name.visible && m.interactions.length > 0, { title: m.title.text, name: m.name.text, actions: m.interactions.map((a) => a.text) });
    } else {
      const hasLivingMotion = m.anims.some((a) => !a.missing && (a.durationMs >= 100 || a.transitionMs >= 100));
      check(tag + ': 正常动效下成功态确实有入场动效', hasLivingMotion, m.anims);
    }

    /* 交互即停:成功卡上的日志开关点过之后,6s 自动关闭必须被取消。
     * 只在桌面正常动效这一轮判:手机完成态本来就是常开(main.ts 的 keepOpen)。 */
    if (!mobile && !reduced) {
      const waitMore = Math.max(0, 7100 - (Date.now() - doneAt));
      if (waitMore > 0) await sleep(waitMore);
      const stillOpen = await page.evaluate(() => !document.getElementById('exportOverlay')?.hidden);
      check(tag + ': 交互后 6s 自动关闭被取消(7s 后浮层仍开)', stillOpen, { doneAt, now: Date.now() });
    }

    if (outDir) {
      await page.screenshot({ path: path.join(outDir, 'verify-ux-motion-' + tag + '.png') });
      fs.writeFileSync(path.join(outDir, 'verify-ux-motion-' + tag + '.json'), JSON.stringify({ state, baseHeight, heightInfo, interim, metrics: m, collapsed: { isLogOpen: collapsed.isLogOpen, slotHeight: collapsed.log.slotHeight }, errors }, null, 2));
    }
  } catch (e) {
    check(tag + ': 运行未抛异常', false, String(e && e.message || e));
  } finally {
    await browser.close();
    try { if (downloadDir) fs.rmSync(downloadDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}

if (only === 'both' || only === 'desktop') await runCase('desktop', false);
if (only === 'both' || only === 'mobile') await runCase('mobile', false);
if (only === 'both' || only === 'desktop') await runCase('desktop', true);
if (only === 'both' || only === 'mobile') await runCase('mobile', true);

console.log(lines.join('\n'));
console.log('');
console.log(fails === 0 ? 'ALL PASS (' + lines.filter((l) => l.startsWith('PASS')).length + ' 项)' : '未通过: ' + fails + ' 项');
process.exit(fails === 0 ? 0 : 1);
