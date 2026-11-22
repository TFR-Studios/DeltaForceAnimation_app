/* 图片编辑器回归(常驻,不参与构建):
 *   node tools/verify-image-editor.mjs [--url http://127.0.0.1:5173/] [--out release/image-editor]
 *
 * 覆盖 2026-11 新增的「图片编辑器」(#viewImage / src/image-page.ts):
 *   1) 导航轨里有这一格,切过去能落位到图片编辑器;
 *   2) 首次进入自动载入内置结算图(pictures/settlement/settlement.psd),画布按文档尺寸合成;
 *   3) 页面只做"编辑内置 PSD + 导出 PNG":没有打开文件入口,也没有导出 PSD;
 *   4) 画布与动画编辑器同一套视图操作:滚轮缩放(以鼠标为中心)、拖动平移、双击复位,
 *      选中框随缩放/平移一起走;
 *   5) 改内容 / 颜色 / 透明度后画面真的重绘(旧颜色像素清掉),撤销能回到原值;
 *   6) 导出 PNG(走假的主进程桥,拿到字节数);
 *   7) 900px 单列;手机端底栏入口 + 控制条 / 分区 chips。
 * 退出码 0 = 全绿。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:5173/');
const OUT = arg('out', 'release/image-editor');
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

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'] });

async function openImagePage(viewport, query = '') {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 240)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 240)); });
  await page.setViewport(viewport);
  const url = BASE + (BASE.includes('?') ? '&' : '?') + 'view=image' + query;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => { const p = document.querySelector('.imged-panel'); return p && !p.hidden; }, { timeout: 120000, polling: 300 })
    .catch(() => errs.push('load-timeout'));
  await page.waitForFunction(() => { const el = document.getElementById('app-loading'); return !el || el.classList.contains('is-hidden') || el.hidden; }, { timeout: 120000, polling: 300 })
    .catch(() => {});
  await sleep(500);
  return { page, errs };
}

const scaleOf = (transform) => {
  const m = /scale\(([-\d.]+)\)/.exec(transform || '');
  return m ? parseFloat(m[1]) : NaN;
};

const parseQuad = (meta) => {
  const m = /TL (-?\d+),(-?\d+) · TR (-?\d+),(-?\d+)\s+BR (-?\d+),(-?\d+) · BL (-?\d+),(-?\d+)/.exec(meta || '');
  return m ? {
    tl: { x: Number(m[1]), y: Number(m[2]) },
    tr: { x: Number(m[3]), y: Number(m[4]) },
    br: { x: Number(m[5]), y: Number(m[6]) },
    bl: { x: Number(m[7]), y: Number(m[8]) },
  } : null;
};
const samePoint = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
const parseNormal = (meta) => {
  const m = /X (-?\d+) · Y (-?\d+) · (\d+) × (\d+)\s+(\d+)% \/ (\d+)% · (-?\d+)°/.exec(meta || '');
  return m ? {
    x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]), sx: Number(m[5]), sy: Number(m[6]), angle: Number(m[7]),
  } : null;
};

/* ---------- 桌面:载入 / 视图操作 / 编辑 / 导出 ---------- */
{
  const { page, errs } = await openImagePage({ width: 1480, height: 940, deviceScaleFactor: 1 });
  check('桌面:切到图片编辑器(页面已显示、无横向滚动)',
    await page.evaluate(() => document.documentElement.dataset.page === 'image'
      && getComputedStyle(document.getElementById('viewImage')).display !== 'none'
      && document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0));
  check('桌面:导航轨含「图片编辑器」一格',
    await page.evaluate(() => !!document.querySelector('.rail-item[data-page="image"]')));

  const loaded = await page.evaluate(() => {
    const c = document.querySelector('.imged-canvas');
    const mount = document.getElementById('imgedMount');
    return {
      w: c ? c.width : 0,
      h: c ? c.height : 0,
      layers: document.querySelectorAll('.imged-layer').length,
      selected: document.querySelector('.imged-layer.is-selected .imged-layer-name')?.textContent || '',
      status: document.querySelector('.imged-status')?.textContent || '',
      hasFileInput: !!mount.querySelector('input[type="file"]'),
      btnTexts: [...mount.querySelectorAll('.imged-bar .imged-btn')].filter((b) => !b.hidden).map((b) => b.textContent.trim()),
      hasPsdExport: [...mount.querySelectorAll('.imged-btn')].some((b) => /PSD/.test(b.textContent) && /导出/.test(b.textContent)),
    };
  });
  check('桌面:内置结算图自动载入(1920×1066 / 13 个文字图层)',
    loaded.w === 1920 && loaded.h === 1066 && loaded.layers === 13, JSON.stringify(loaded));
  check('桌面:默认选中字号最大的标题(撤离成功)', loaded.selected === '撤离成功', loaded.selected);
  check('桌面:顶栏只有重载 PSD / 撤销 / 导出,没有打开文件与导出 PSD',
    loaded.btnTexts.length === 3 && loaded.btnTexts.includes('重载 PSD')
      && loaded.btnTexts.includes('撤销修改') && loaded.btnTexts.includes('导出 PNG')
      && !loaded.hasFileInput && !loaded.hasPsdExport, JSON.stringify(loaded));

  /* ---- 背景选择(DFAsset/settlement) ---- */
  const bgInitial = await page.evaluate(() => {
    const grid = document.querySelector('.imged-bg-grid');
    const items = [...grid.querySelectorAll('.imged-bg-item')];
    const c = document.querySelector('.imged-canvas');
    const d = c.getContext('2d').getImageData(1500, 100, 300, 200).data;
    let fp = 0; for (let i = 0; i < d.length; i += 40) fp = (fp + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) % 1000000007;
    return {
      count: items.length,
      selected: items.findIndex((b) => b.classList.contains('is-selected')),
      tag: items[0]?.querySelector('.imged-bg-tag')?.textContent || '',
      loaded: items.every((b) => { const img = b.querySelector('img'); return img && img.complete && img.naturalWidth > 0; }),
      fingerprint: fp,
    };
  });
  check('背景:4 张缩略图、默认选中、图片都已加载',
    bgInitial.count === 4 && bgInitial.selected === 0 && bgInitial.tag === '默认' && bgInitial.loaded, JSON.stringify(bgInitial));

  const bgSwitched = await page.evaluate(async () => {
    document.querySelectorAll('.imged-bg-item')[1].click();
    await new Promise((r) => setTimeout(r, 900));
    const items = [...document.querySelectorAll('.imged-bg-item')];
    const c = document.querySelector('.imged-canvas');
    const d = c.getContext('2d').getImageData(1500, 100, 300, 200).data;
    let fp = 0; for (let i = 0; i < d.length; i += 40) fp = (fp + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) % 1000000007;
    const screen = c.getContext('2d').getImageData(980, 200, 500, 640).data;
    let holes = 0; for (let i = 3; i < screen.length; i += 4) if (screen[i] < 8) holes++;
    return { selected: items.findIndex((b) => b.classList.contains('is-selected')), fingerprint: fp, holes, resetOn: !document.querySelector('[data-imged="reset"]').disabled };
  });
  check('背景:切换后画面变化、选中态跟随、撤销可用',
    bgSwitched.selected === 1 && bgSwitched.fingerprint !== bgInitial.fingerprint && bgSwitched.resetOn, JSON.stringify(bgSwitched));
  check('背景:新背景的手机屏幕没有透明孔(屏幕内容已重新合成)', bgSwitched.holes === 0, bgSwitched.holes);
  await page.screenshot({ path: path.join(OUT, 'verify-background.png') });

  const bgReset = await page.evaluate(() => {
    document.querySelector('[data-imged="reset"]').click();
    return {
      selected: [...document.querySelectorAll('.imged-bg-item')].findIndex((b) => b.classList.contains('is-selected')),
      resetOff: document.querySelector('[data-imged="reset"]').disabled,
    };
  });
  check('背景:撤销修改回到默认背景', bgReset.selected === 0 && bgReset.resetOff, JSON.stringify(bgReset));

  await page.screenshot({ path: path.join(OUT, 'verify-initial.png') });

  /* ---- 名片:190 张素材 / 分类 / 搜索 / 键盘 / 自由覆盖 / 拖动缩放 ---- */
  const cardBase = await page.evaluate(() => ({
    hasSection: !!document.querySelector('.imged-card'),
    name: document.querySelector('.imged-card-name')?.textContent || '',
    clearHidden: document.querySelector('[data-imged="clear-card"]')?.hidden,
    pickerOpen: document.querySelector('.imged-picker')?.open,
    source: document.querySelector('.imged-card-head .imged-bg-note')?.textContent || '',
  }));
  check('名片:默认未选择、选择器关闭、来源标注可见',
    cardBase.hasSection && cardBase.name === '选择名片' && cardBase.clearHidden === true
      && cardBase.pickerOpen === false && /DFAsset/.test(cardBase.source), JSON.stringify(cardBase));

  await page.evaluate(() => document.querySelector('[data-imged="pick-card"]').click());
  await page.waitForFunction(() => document.querySelector('.imged-picker').open, { timeout: 10000 });
  await sleep(450);
  const picker = await page.evaluate(() => ({
    items: document.querySelectorAll('.imged-card-item').length,
    visible: [...document.querySelectorAll('.imged-card-item')].filter((e) => !e.hidden).length,
    tabs: [...document.querySelectorAll('[data-card-tab]')].map((b) => b.textContent.trim()),
    count: document.querySelector('.imged-picker-count').textContent,
    focus: document.activeElement?.id,
    selected: document.querySelectorAll('.imged-card-item.is-selected').length,
  }));
  check('名片:选择器 190 张、分类计数、搜索框自动聚焦',
    picker.items === 190 && picker.visible === 190 && picker.focus === 'imgedCardSearch'
      && picker.tabs.join('|').includes('全部 190') && picker.tabs.join('|').includes('名片 147')
      && picker.tabs.join('|').includes('皮肤 43') && picker.count === '显示 190 / 190'
      && picker.selected === 0, JSON.stringify(picker));
  await page.screenshot({ path: path.join(OUT, 'verify-card-picker.png') });

  await page.evaluate(() => document.querySelector('[data-card-tab="skin"]').click());
  await sleep(150);
  const skinTab = await page.evaluate(() => ({
    visible: [...document.querySelectorAll('.imged-card-item')].filter((e) => !e.hidden).length,
    count: document.querySelector('.imged-picker-count').textContent,
    open: document.querySelector('.imged-picker').open,
  }));
  check('名片:分类筛选「皮肤」= 43 张(选择器保持打开)',
    skinTab.visible === 43 && skinTab.count === '显示 43 / 190' && skinTab.open, JSON.stringify(skinTab));

  await page.evaluate(() => {
    const input = document.querySelector('#imgedCardSearch');
    input.value = 'Alexei';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(150);
  const cardSearch = await page.evaluate(() => ({
    visible: [...document.querySelectorAll('.imged-card-item')].filter((e) => !e.hidden).length,
    clearVisible: !document.querySelector('[data-imged="clear-card-search"]').hidden,
    count: document.querySelector('.imged-picker-count').textContent,
    open: document.querySelector('.imged-picker').open,
  }));
  check('名片:搜索过滤(皮肤里搜 Alexei 命中且清空按钮出现)',
    cardSearch.visible > 0 && cardSearch.visible < 43 && cardSearch.clearVisible && cardSearch.open, JSON.stringify(cardSearch));

  await page.evaluate(() => document.querySelector('[data-imged="clear-card-search"]').click());
  await page.evaluate(() => document.querySelector('[data-card-tab="all"]').click());
  await sleep(150);
  const searchCleared = await page.evaluate(() => ({
    value: document.querySelector('#imgedCardSearch').value,
    visible: [...document.querySelectorAll('.imged-card-item')].filter((e) => !e.hidden).length,
    tabStops: [...document.querySelectorAll('.imged-card-item')].filter((e) => e.tabIndex === 0).length,
    open: document.querySelector('.imged-picker').open,
  }));
  check('名片:清空搜索回到全部,网格只保留 1 个 tab 停靠点',
    searchCleared.value === '' && searchCleared.visible === 190 && searchCleared.tabStops === 1
      && searchCleared.open, JSON.stringify(searchCleared));

  const kbBefore = await page.evaluate(() => {
    document.querySelector('.imged-card-item[tabindex="0"]').focus();
    return document.activeElement?.dataset.cardId;
  });
  await sleep(120);
  await page.keyboard.press('ArrowRight');
  await sleep(80);
  const kbAfter = await page.evaluate(() => ({
    id: document.activeElement?.dataset.cardId,
    tabStops: [...document.querySelectorAll('.imged-card-item')].filter((e) => e.tabIndex === 0).length,
  }));
  check('名片:方向键在网格里移动焦点(roving tabindex)',
    kbBefore && kbAfter.id && kbBefore !== kbAfter.id && kbAfter.tabStops === 1, JSON.stringify({ kbBefore, kbAfter }));

  await page.evaluate(() => document.querySelector('[data-card-id="business/Ma1/Card_Ma1_vx_4i_Bit_B"]').click());
  await page.waitForFunction(() => !document.querySelector('.imged-picker').open
    && document.querySelector('.imged-card-name').textContent === 'Bit B', { timeout: 30000 });
  await sleep(500);
  const cardApplied = await page.evaluate(() => {
    const c = document.querySelector('.imged-canvas');
    const d = c.getContext('2d').getImageData(1240, 500, 1, 1).data;
    const img = document.querySelector('.imged-card-current img');
    return {
      name: document.querySelector('.imged-card-name').textContent,
      meta: document.querySelector('.imged-card-meta').textContent,
      clearHidden: document.querySelector('[data-imged="clear-card"]').hidden,
      resetOn: !document.querySelector('[data-imged="reset"]').disabled,
      pixel: Array.from(d),
      thumbLoaded: !!img && img.complete && img.naturalWidth > 0,
      pickerOpen: document.querySelector('.imged-picker').open,
    };
  });
  check('名片:选中后覆盖画面(画面非黑、名片区更新、可撤销)',
    cardApplied.name === 'Bit B' && /^TL -?\d+,-?\d+/.test(cardApplied.meta) && cardApplied.clearHidden === false
      && cardApplied.resetOn && cardApplied.pixel[3] === 255
      && (cardApplied.pixel[0] + cardApplied.pixel[1] + cardApplied.pixel[2]) > 15
      && cardApplied.thumbLoaded && cardApplied.pickerOpen === false, JSON.stringify(cardApplied));
  const cardSourceInfo = await page.evaluate(() => ({
    source: document.querySelector('.imged-card-source').textContent,
  }));
  check('名片:来源标注可见(GitCode 原图 / 已缓存 / 本地缩略图)',
    /^(GitCode 原图( · 已缓存)?|本地缩略图|正在从 GitCode 加载原图…)/.test(cardSourceInfo.source),
    JSON.stringify(cardSourceInfo));
  await page.screenshot({ path: path.join(OUT, 'verify-card-applied.png') });

  /* 四角透视:默认四角 / 单角拖动 / 整体平移 / 旋转 / 复位 */
  const cardQuadBefore = await page.evaluate(() => {
    const svg = document.querySelector('.imged-card-quad');
    const poly = svg.querySelector('.imged-card-quad-fill');
    return {
      hidden: svg.hasAttribute('hidden'),
      points: ((poly.getAttribute('points') || '').trim().split(/\s+/)).filter(Boolean).length,
      corners: svg.querySelectorAll('.imged-card-corner').length,
      meta: document.querySelector('.imged-card-meta').textContent,
    };
  });
  const q0 = parseQuad(cardQuadBefore.meta);
  check('名片:四角透视选框可见并显示 TL/TR/BR/BL',
    !cardQuadBefore.hidden && cardQuadBefore.points === 4 && cardQuadBefore.corners === 4
      && !!q0 && q0.tl.x < q0.tr.x && q0.tl.y < q0.bl.y, JSON.stringify(cardQuadBefore));

  /* 三种缩放方式:默认透视 / 等比 / 自由 / 再回透视 */
  const modes = await page.evaluate(() => ({
    count: document.querySelectorAll('[data-card-mode]').length,
    perspective: document.querySelector('[data-card-mode="perspective"]').getAttribute('aria-pressed'),
    modesHidden: document.querySelector('.imged-card-modes').hidden,
    meta: document.querySelector('.imged-card-meta').textContent,
  }));
  check('名片:三种缩放方式可见,默认透视',
    modes.count === 3 && modes.perspective === 'true' && modes.modesHidden === false
      && /^TL /.test(modes.meta), JSON.stringify(modes));

  await page.evaluate(() => document.querySelector('[data-card-mode="proportional"]').click());
  await sleep(200);
  const normalBefore = parseNormal(await page.evaluate(() => document.querySelector('.imged-card-meta').textContent));
  const brHandle = await page.evaluate(() => {
    const r = document.querySelector('[data-card-corner="2"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(brHandle.x, brHandle.y);
  await page.mouse.down();
  await page.mouse.move(brHandle.x + 40, brHandle.y + 20, { steps: 8 });
  await page.mouse.up();
  await sleep(250);
  const normalAfter = parseNormal(await page.evaluate(() => document.querySelector('.imged-card-meta').textContent));
  check('名片:等比缩放模式(拖角后宽高比不变)',
    !!normalBefore && !!normalAfter && normalAfter.w !== normalBefore.w
      && Math.abs(normalAfter.w / normalAfter.h - normalBefore.w / normalBefore.h) < 0.02,
    JSON.stringify({ before: normalBefore, after: normalAfter }));
  await page.screenshot({ path: path.join(OUT, 'verify-card-mode-proportional.png') });

  await page.evaluate(() => document.querySelector('[data-card-mode="free"]').click());
  await sleep(200);
  const freeBefore = parseNormal(await page.evaluate(() => document.querySelector('.imged-card-meta').textContent));
  const brHandle2 = await page.evaluate(() => {
    const r = document.querySelector('[data-card-corner="2"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(brHandle2.x, brHandle2.y);
  await page.mouse.down();
  await page.mouse.move(brHandle2.x + 40, brHandle2.y + 20, { steps: 8 });
  await page.mouse.up();
  await sleep(250);
  const freeAfter = parseNormal(await page.evaluate(() => document.querySelector('.imged-card-meta').textContent));
  check('名片:自由缩放模式(拖角后宽高比改变)',
    !!freeBefore && !!freeAfter && freeAfter.w !== freeBefore.w
      && Math.abs(freeAfter.w / freeAfter.h - freeBefore.w / freeBefore.h) > 0.02,
    JSON.stringify({ before: freeBefore, after: freeAfter }));
  await page.screenshot({ path: path.join(OUT, 'verify-card-mode-free.png') });

  await page.evaluate(() => document.querySelector('[data-card-mode="perspective"]').click());
  await sleep(200);
  const backToPerspective = parseQuad(await page.evaluate(() => document.querySelector('.imged-card-meta').textContent));
  check('名片:切回透视模式读取四角坐标',
    !!backToPerspective && (await page.evaluate(() => document.querySelector('[data-card-mode="perspective"]').getAttribute('aria-pressed'))) === 'true',
    JSON.stringify(backToPerspective));

  const trHandle = await page.evaluate(() => {
    const r = document.querySelector('[data-card-corner="1"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(trHandle.x, trHandle.y);
  await page.mouse.down();
  await page.mouse.move(trHandle.x + 40, trHandle.y + 20, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const q1 = parseQuad(await page.evaluate(() => document.querySelector('.imged-card-meta').textContent));
  check('名片:拖单个角改变该角(其余三角不动,产生透视)',
    !!backToPerspective && !!q1 && !samePoint(q1.tr, backToPerspective.tr)
      && samePoint(q1.tl, backToPerspective.tl) && samePoint(q1.br, backToPerspective.br)
      && samePoint(q1.bl, backToPerspective.bl),
    JSON.stringify({ before: backToPerspective, after: q1 }));
  await page.screenshot({ path: path.join(OUT, 'verify-card-quad-drag.png') });

  /* 框内拖动:四个角同步平移 */
  const moveStart = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('.imged-card-corner')].slice(0, 4).map((c) => c.getBoundingClientRect());
    return { x: rs.reduce((a, r) => a + r.x + r.width / 2, 0) / 4, y: rs.reduce((a, r) => a + r.y + r.height / 2, 0) / 4 };
  });
  await page.mouse.move(moveStart.x, moveStart.y);
  await page.mouse.down();
  await page.mouse.move(moveStart.x + 40, moveStart.y + 20, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const q2 = parseQuad(await page.evaluate(() => document.querySelector('.imged-card-meta').textContent));
  const deltas = q1 && q2 ? [q2.tl.x - q1.tl.x, q2.tr.x - q1.tr.x, q2.br.x - q1.br.x, q2.bl.x - q1.bl.x] : [];
  const deltasY = q1 && q2 ? [q2.tl.y - q1.tl.y, q2.tr.y - q1.tr.y, q2.br.y - q1.br.y, q2.bl.y - q1.bl.y] : [];
  check('名片:框内拖动,四个角一起平移',
    !!q1 && !!q2 && deltas.every((d) => Math.abs(d - deltas[0]) <= 2 && d !== 0)
      && deltasY.every((d) => Math.abs(d - deltasY[0]) <= 2 && d !== 0),
    JSON.stringify({ before: q1, after: q2 }));

  await page.evaluate(() => document.querySelector('[data-imged="reset-card-quad"]').click());
  await sleep(250);

  /* 旋转:拖顶边中点的圆形手柄,读 TL→TR 的边角 */
  const rotStart = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('.imged-card-corner')].slice(0, 4).map((c) => c.getBoundingClientRect());
    const h = document.querySelector('.imged-card-rotate-handle').getBoundingClientRect();
    return {
      cx: rs.reduce((a, r) => a + r.x + r.width / 2, 0) / 4,
      cy: rs.reduce((a, r) => a + r.y + r.height / 2, 0) / 4,
      hx: h.x + h.width / 2,
      hy: h.y + h.height / 2,
    };
  });
  const radius = rotStart.cy - rotStart.hy;
  await page.mouse.move(rotStart.hx, rotStart.hy);
  await page.mouse.down();
  await page.mouse.move(rotStart.cx + radius * Math.sin(Math.PI / 4), rotStart.cy - radius * Math.cos(Math.PI / 4), { steps: 10 });
  await page.mouse.up();
  await sleep(300);
  const q3 = parseQuad(await page.evaluate(() => document.querySelector('.imged-card-meta').textContent));
  const edgeAngle = q3 ? Math.atan2(q3.tr.y - q3.tl.y, q3.tr.x - q3.tl.x) * 180 / Math.PI : 0;
  check('名片:拖旋转手柄,四角一起旋转(顶边约 45°)',
    !!q3 && Math.abs(edgeAngle) >= 30 && Math.abs(edgeAngle) <= 60, JSON.stringify({ angle: edgeAngle, quad: q3 }));
  await page.screenshot({ path: path.join(OUT, 'verify-card-rotated.png') });

  await page.evaluate(() => document.querySelector('[data-imged="reset-card-quad"]').click());
  await sleep(250);
  const q4 = parseQuad(await page.evaluate(() => document.querySelector('.imged-card-meta').textContent));
  const quadVisible = await page.evaluate(() => !document.querySelector('.imged-card-quad').hasAttribute('hidden'));
  check('名片:复位回到默认四角',
    !!q0 && !!q4 && samePoint(q4.tl, q0.tl) && samePoint(q4.tr, q0.tr)
      && samePoint(q4.br, q0.br) && samePoint(q4.bl, q0.bl) && quadVisible,
    JSON.stringify({ before: q0, reset: q4 }));
  await page.screenshot({ path: path.join(OUT, 'verify-card-quad.png') });

  /* 换背景后名片留在原位 */
  await page.evaluate(() => document.querySelectorAll('.imged-bg-item')[1].click());
  await sleep(900);
  const cardOnBg = await page.evaluate(() => {
    const c = document.querySelector('.imged-canvas');
    const d = c.getContext('2d').getImageData(1240, 500, 1, 1).data;
    return {
      name: document.querySelector('.imged-card-name').textContent,
      bg: [...document.querySelectorAll('.imged-bg-item')].findIndex((b) => b.classList.contains('is-selected')),
      pixel: Array.from(d),
    };
  });
  check('名片:换背景后名片仍在、位置和大小不变',
    cardOnBg.name === 'Bit B' && cardOnBg.bg === 1 && cardOnBg.pixel[3] === 255
      && (cardOnBg.pixel[0] + cardOnBg.pixel[1] + cardOnBg.pixel[2]) > 15, JSON.stringify(cardOnBg));
  await page.evaluate(() => document.querySelectorAll('.imged-bg-item')[0].click());
  await sleep(900);

  /* 重新打开:选中态 + Esc 关闭 + 焦点回到入口 */
  await page.evaluate(() => document.querySelector('[data-imged="pick-card"]').click());
  await page.waitForFunction(() => document.querySelector('.imged-picker').open, { timeout: 5000 });
  const selectedInPicker = await page.evaluate(() => ({
    chosen: document.querySelector('.imged-card-item.is-selected .imged-card-item-label')?.textContent || '',
    pressed: document.querySelector('.imged-card-item.is-selected')?.getAttribute('aria-pressed'),
  }));
  await page.keyboard.press('Escape');
  await sleep(250);
  const escClosed = await page.evaluate(() => ({
    open: document.querySelector('.imged-picker').open,
    focus: document.activeElement?.getAttribute('data-imged'),
  }));
  check('名片:重新打开时选中项高亮,Esc 关闭并把焦点还给入口',
    selectedInPicker.chosen === 'Bit B' && selectedInPicker.pressed === 'true'
      && escClosed.open === false && escClosed.focus === 'pick-card', JSON.stringify({ selectedInPicker, escClosed }));

  /* ---- 滚轮缩放(以鼠标为中心) ---- */
  const view = await page.evaluate(() => {
    const stage = document.querySelector('.imged-stage');
    const scale = document.querySelector('.imged-scale');
    const box = document.querySelector('.imged-sel-box');
    const r = stage.getBoundingClientRect();
    const before = {
      transform: scale.style.transform,
      zoom: document.querySelector('.imged-zoom-value').textContent,
      boxLeft: box.hidden ? null : Math.round(box.getBoundingClientRect().left),
      boxW: box.hidden ? null : Math.round(box.getBoundingClientRect().width),
    };
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    const afterZoom = { transform: scale.style.transform, zoom: document.querySelector('.imged-zoom-value').textContent };
    return { before, afterZoom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
  const s0 = scaleOf(view.before.transform); const s1 = scaleOf(view.afterZoom.transform);
  check('视图:初始按 contain 适配(显示缩放 < 100%)', s0 > 0.2 && s0 < 1 && view.before.zoom === '100%', JSON.stringify({ s0, zoom: view.before.zoom }));
  check('视图:滚轮放大(约 1.33 倍,读数同步)', s1 / s0 > 1.25 && s1 / s0 < 1.4 && view.afterZoom.zoom !== '100%', JSON.stringify({ s0, s1, zoom: view.afterZoom.zoom }));

  /* 记下"缩放后、平移前"的选中框位置:下一步拖动要让它在屏幕上正好平移 120px */
  const boxBeforePan = await page.evaluate(() => {
    const box = document.querySelector('.imged-sel-box');
    return box.hidden ? null : { left: Math.round(box.getBoundingClientRect().left), w: Math.round(box.getBoundingClientRect().width) };
  });

  /* ---- 拖动平移 ---- */
  await page.mouse.move(view.cx, view.cy);
  await page.mouse.down();
  await page.mouse.move(view.cx + 120, view.cy + 60, { steps: 6 });
  await page.mouse.up();
  const panned = await page.evaluate(() => {
    const scale = document.querySelector('.imged-scale');
    const box = document.querySelector('.imged-sel-box');
    return {
      transform: scale.style.transform,
      boxLeft: box.hidden ? null : Math.round(box.getBoundingClientRect().left),
      boxW: box.hidden ? null : Math.round(box.getBoundingClientRect().width),
      panning: document.querySelector('.imged-stage').classList.contains('is-panning'),
    };
  });
  const panMatch = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(panned.transform);
  check('视图:拖动平移(transform 写入约 120/60 的平移,松手退出拖动态)',
    !!panMatch && Math.abs(parseFloat(panMatch[1]) - 120) <= 2 && Math.abs(parseFloat(panMatch[2]) - 60) <= 2
      && panned.panning === false, panned.transform);
  check('视图:选中框是屏幕坐标,平移后跟着走且尺寸不变',
    panned.boxLeft !== null && boxBeforePan !== null
      && Math.abs((panned.boxLeft - boxBeforePan.left) - 120) <= 2 && panned.boxW === boxBeforePan.w,
    JSON.stringify({ from: boxBeforePan && boxBeforePan.left, to: panned.boxLeft, beforeW: boxBeforePan && boxBeforePan.w, afterW: panned.boxW }));
  await page.screenshot({ path: path.join(OUT, 'verify-zoom.png') });

  /* ---- 双击复位 ---- */
  const resetView = await page.evaluate(() => {
    const stage = document.querySelector('.imged-stage');
    const scale = document.querySelector('.imged-scale');
    const r = stage.getBoundingClientRect();
    stage.dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }));
    return { transform: scale.style.transform, zoom: document.querySelector('.imged-zoom-value').textContent };
  });
  check('视图:双击复位回适配视图(100% / 平移归零)',
    resetView.zoom === '100%' && /translate\(0px, 0px\)/.test(resetView.transform), JSON.stringify(resetView));

  /* ---- 注入最小下载桥,记录导出字节 + 定位调用 ---- */
  await page.evaluate(() => {
    window.__SAVED__ = null;
    window.__SAVED_BYTES__ = null;
    window.__REVEALED__ = null;
    window.dfaeDownloads = {
      isDesktop: true,
      save: async (name, bytes) => {
        window.__SAVED__ = { name, size: bytes.length };
        window.__SAVED_BYTES__ = bytes;
        await new Promise((r) => setTimeout(r, 350));
        return { mode: 'auto', name, path: 'C:\\fake\\' + name, entry: { id: 'test-export-id' } };
      },
      list: async () => ({ entries: [], promptOnSave: false }),
      reveal: async (id = '') => { window.__REVEALED__ = id; return true; },
    };
  });

  const edited = await page.evaluate(() => {
    const ta = document.querySelector('.imged-text');
    const color = document.querySelector('.imged-color');
    const range = document.querySelector('.imged-range');
    ta.value = '测试成功';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    color.value = '#ff3b30';
    color.dispatchEvent(new Event('input', { bubbles: true }));
    range.value = '60';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      dirty: [...document.querySelectorAll('.imged-dirty')].filter((n) => !n.hidden).length,
      resetOn: !document.querySelector('[data-imged="reset"]').disabled,
      restoreOn: !document.querySelector('[data-imged="restore"]').disabled,
      pct: document.querySelector('.imged-pct').textContent,
    };
  });
  check('桌面:改文字 / 颜色 / 透明度后出现「已改」并启用撤销与恢复',
    edited.dirty === 1 && edited.resetOn && edited.restoreOn && edited.pct === '60%', JSON.stringify(edited));
  await sleep(300);

  const pixels = await page.evaluate(() => {
    const c = document.querySelector('.imged-canvas');
    const d = c.getContext('2d').getImageData(190, 169, 311, 78).data;
    let red = 0, green = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue;
      if (d[i] > 140 && d[i + 1] < 90) red++;
      if (d[i + 1] > 140 && d[i] < 80) green++;
    }
    return { red, green };
  });
  check('桌面:画面真的重绘了(标题只剩新颜色,旧绿色像素为 0)', pixels.red > 1000 && pixels.green === 0, JSON.stringify(pixels));
  await page.screenshot({ path: path.join(OUT, 'verify-edited.png') });

  await page.evaluate(() => { document.querySelector('[data-imged="export-png"]').click(); });
  await sleep(90);
  const loading = await page.evaluate(() => ({
    text: document.querySelector('[data-imged="export-png"] .imged-btn-text').textContent,
    busy: document.querySelector('[data-imged="export-png"]').getAttribute('aria-busy'),
    disabled: document.querySelector('[data-imged="export-png"]').disabled,
    spinner: getComputedStyle(document.querySelector('[data-imged="export-png"] .imged-btn-spinner')).display,
  }));
  check('导出:进行中按钮显示「正在导出…」并有忙碌指示',
    loading.text === '正在导出…' && loading.busy === 'true' && loading.disabled && loading.spinner !== 'none', JSON.stringify(loading));

  await page.waitForFunction(() => !document.querySelector('.imged-result').hidden, { timeout: 30000 }).catch(() => {});
  const png = await page.evaluate(() => (window.__SAVED__ ? { ...window.__SAVED__ } : null));
  const result = await page.evaluate(() => {
    const r = document.querySelector('.imged-result');
    return {
      hidden: r.hidden,
      state: r.dataset.state,
      title: document.querySelector('.imged-result-title').textContent,
      name: document.querySelector('.imged-result-name').textContent,
      note: document.querySelector('.imged-result-note').textContent,
      revealHidden: document.querySelector('.imged-result [data-imged="reveal"]').hidden,
      toolbarRevealHidden: document.querySelector('.imged-actions [data-imged="reveal"]').hidden,
    };
  });
  check('导出:PNG 成功(>100KB)', !!png && /\.png$/.test(png.name) && png.size > 100 * 1024, JSON.stringify(png));

  const exportedAlpha = await page.evaluate(async () => {
    const bytes = window.__SAVED_BYTES__;
    if (!bytes) return null;
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let min = 255;
    for (let i = 3; i < d.length; i += 4) if (d[i] < min) min = d[i];
    const center = Array.from(ctx.getImageData(1240, 500, 1, 1).data);
    return { w: bmp.width, h: bmp.height, min, center };
  });
  check('导出:PNG 整幅不透明,屏幕中心是名片而不是黑屏',
    !!exportedAlpha && exportedAlpha.w === 1920 && exportedAlpha.min === 255
      && exportedAlpha.center[3] === 255
      && (exportedAlpha.center[0] + exportedAlpha.center[1] + exportedAlpha.center[2]) > 15,
    JSON.stringify(exportedAlpha));
  check('导出:右上角结果卡展示文件名与「打开文件夹」',
    !result.hidden && result.state === 'ok' && result.title === 'PNG 已导出'
      && /\.png$/.test(result.name) && result.note.startsWith('已保存到下载文件夹')
      && !result.revealHidden && !result.toolbarRevealHidden,
    JSON.stringify(result));
  await page.screenshot({ path: path.join(OUT, 'verify-export-result.png') });

  /* 结果卡浮在舞台上,必须用真实鼠标点:脚本 .click() 不会走 pointerdown,
   * 盖不住"结果卡按钮被舞台拖拽( preventDefault + setPointerCapture )吞掉"这类回归。 */
  const clickReal = async (selector) => {
    const box = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, selector);
    if (!box) return false;
    await page.mouse.click(box.x, box.y);
    await sleep(150);
    return true;
  };
  await clickReal('.imged-result [data-imged="reveal"]');
  const revealedByCard = await page.evaluate(() => window.__REVEALED__);
  check('导出:结果卡「打开文件夹」用真实鼠标点得动(调用主进程定位)',
    revealedByCard === 'test-export-id', String(revealedByCard));

  await clickReal('[data-imged="result-close"]');
  const closed = await page.evaluate(() => document.querySelector('.imged-result').hidden);
  check('导出:结果卡可以关闭(真实鼠标点关闭按钮)', closed === true);

  await page.evaluate(() => document.querySelector('.imged-actions [data-imged="reveal"]').click());
  await sleep(120);
  const revealedByBar = await page.evaluate(() => window.__REVEALED__);
  check('导出:顶栏「打开文件夹」同样可以定位上一次文件', revealedByBar === 'test-export-id', String(revealedByBar));

  const reset = await page.evaluate(() => {
    document.querySelector('[data-imged="reset"]').click();
    return {
      text: document.querySelector('.imged-text').value,
      pct: document.querySelector('.imged-pct').textContent,
      dirty: [...document.querySelectorAll('.imged-dirty')].filter((n) => !n.hidden).length,
      cardName: document.querySelector('.imged-card-name').textContent,
      cardClearHidden: document.querySelector('[data-imged="clear-card"]').hidden,
      resetOff: document.querySelector('[data-imged="reset"]').disabled,
    };
  });
  check('桌面:撤销全部修改回到原值(名片也清掉)',
    reset.text === '撤离成功' && reset.pct === '100%' && reset.dirty === 0 && reset.resetOff
      && reset.cardName === '选择名片' && reset.cardClearHidden === true, JSON.stringify(reset));
  check('桌面:图片编辑器无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.close();
}

/* ---------- 窄屏:检查器折到下方,无横向滚动 ---------- */
{
  const { page, errs } = await openImagePage({ width: 900, height: 820, deviceScaleFactor: 1 });
  const s = await page.evaluate(() => {
    const panel = document.querySelector('.imged-panel').getBoundingClientRect();
    const stage = document.querySelector('.imged-stage').getBoundingClientRect();
    return {
      ox: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stacked: panel.top >= stage.bottom - 1,
      panelW: Math.round(panel.width),
      stageW: Math.round(stage.width),
    };
  });
  check('900px:无横向滚动', s.ox <= 0, s.ox);
  check('900px:检查器在舞台下方(单列)', s.stacked && s.panelW > 600, JSON.stringify(s));
  await page.evaluate(() => document.querySelector('[data-imged="pick-card"]').click());
  await page.waitForFunction(() => document.querySelector('.imged-picker').open, { timeout: 10000 });
  await sleep(400);
  const pickerNarrow = await page.evaluate(() => {
    const d = document.querySelector('.imged-picker').getBoundingClientRect();
    return {
      left: Math.round(d.left),
      right: Math.round(d.right),
      width: Math.round(d.width),
      ox: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      items: document.querySelectorAll('.imged-card-item').length,
    };
  });
  check('900px:名片选择器收进视口、190 张都在', pickerNarrow.left >= 0 && pickerNarrow.right <= 900
    && pickerNarrow.width > 600 && pickerNarrow.ox <= 0 && pickerNarrow.items === 190, JSON.stringify(pickerNarrow));
  await page.keyboard.press('Escape');
  await sleep(250);
  check('900px:无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.screenshot({ path: path.join(OUT, 'verify-narrow.png') });
  await page.close();
}

/* ---------- 手机:底栏入口 + 参照动画编辑器的控制条 / 分区 chips ---------- */
{
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(BASE + (BASE.includes('?') ? '&' : '?') + 'ui=mobile&view=home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => { const el = document.getElementById('app-loading'); return !el || el.classList.contains('is-hidden') || el.hidden; }, { timeout: 120000, polling: 300 }).catch(() => {});
  await sleep(600);
  const mobile = await page.evaluate(() => ({
    icon: (() => { const el = document.querySelector('.rail-item[data-page="image"]'); return el ? getComputedStyle(el).display : 'missing'; })(),
    nav: [...document.querySelectorAll('.rail-item')].filter((b) => b.getClientRects().length > 0).map((b) => b.dataset.page),
  }));
  check('手机:底栏出现图片编辑器入口', mobile.icon !== 'none' && mobile.nav.includes('image'), JSON.stringify(mobile));
  await page.evaluate(() => document.querySelector('.rail-item[data-page="image"]').click());
  await page.waitForFunction(() => { const p = document.getElementById('viewImage'); return p && !p.hidden; }, { timeout: 30000 });
  await page.waitForFunction(() => { const p = document.querySelector('.imged-panel'); return p && !p.hidden; }, { timeout: 120000, polling: 300 }).catch(() => {});
  await sleep(2500);
  const layout = await page.evaluate(() => {
    const visible = (el) => !!el && el.getClientRects().length > 0;
    const row = document.querySelector('.imged-mobile-row');
    /* 底栏指示条必须落在选中格中心:按真实 rect 算,不再假设五等分 */
    const rail = document.querySelector('.rail-items');
    const railRect = rail.getBoundingClientRect();
    const active = [...rail.querySelectorAll('.rail-item')].find((b) => b.classList.contains('is-active'));
    const activeRect = active.getBoundingClientRect();
    const cs = getComputedStyle(rail);
    const indCenter = (parseFloat(cs.getPropertyValue('--m-nav-x')) || 0) + (parseFloat(cs.getPropertyValue('--m-nav-w')) || 0) / 2;
    const itemCenter = activeRect.x + activeRect.width / 2 - railRect.x;
    const iconRect = active.querySelector('svg').getBoundingClientRect();
    const labelRect = active.querySelector('span').getBoundingClientRect();
    return {
      iconDelta: Math.round(Math.abs(iconRect.x + iconRect.width / 2 - (activeRect.x + activeRect.width / 2))),
      textDelta: Math.round(Math.abs(labelRect.x + labelRect.width / 2 - (activeRect.x + activeRect.width / 2))),
      barDisplay: getComputedStyle(document.querySelector('.imged-bar')).display,
      rowVisible: visible(row),
      rowButtons: [...document.querySelectorAll('.imged-mobile-row [data-imged]')].filter(visible).map((el) => el.dataset.imged),
      chips: [...document.querySelectorAll('.imged-m-chip')].map((el) => el.textContent),
      chipsVisible: visible(document.querySelector('.imged-m-chips')),
      navDelta: Math.round(Math.abs(indCenter - itemCenter)),
      ox: document.documentElement.scrollWidth - innerWidth,
    };
  });
  check('手机:图片编辑器控制条 + 分区 chips(参照动画编辑器)',
    layout.barDisplay === 'none' && layout.rowVisible && layout.chipsVisible
      && layout.chips.join('|') === '背景|名片|文字图层'
      && layout.rowButtons.includes('reload-psd') && layout.rowButtons.includes('reset')
      && layout.rowButtons.includes('export-png') && layout.ox <= 0
      && layout.navDelta <= 1 && layout.iconDelta <= 1 && layout.textDelta <= 1,
    JSON.stringify(layout));
  /* 编辑区拉条:下拖收起、点按展开(与动画编辑器的底部面板同一套手感) */
  const panelHeight = () => page.evaluate(() => Math.round(document.querySelector('.imged-panel').getBoundingClientRect().height));
  const gripCenter = () => page.evaluate(() => {
    const r = document.querySelector('.imged-m-grip').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const sheetH0 = await panelHeight();
  let grip = await gripCenter();
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x, grip.y + 160, { steps: 10 });
  await page.mouse.up();
  await sleep(450);
  const sheetH1 = await panelHeight();
  grip = await gripCenter();
  await page.mouse.click(grip.x, grip.y);
  await sleep(450);
  const sheetH2 = await panelHeight();
  check('手机:编辑区拉条下拖收起、点按展开',
    sheetH1 < sheetH0 - 80 && sheetH2 > sheetH1 + 80,
    JSON.stringify({ half: sheetH0, collapsed: sheetH1, expanded: sheetH2 }));

  const pinchBefore = await page.evaluate(() => document.querySelector('.imged-zoom-value').textContent);
  const stageCenter = await page.evaluate(() => {
    const r = document.querySelector('.imged-stage').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const cdp = await page.createCDPSession();
  const two = (x1, x2, y) => [{ x: x1, y, id: 1 }, { x: x2, y, id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: two(stageCenter.x - 50, stageCenter.x + 50, stageCenter.y) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: two(stageCenter.x - 80, stageCenter.x + 80, stageCenter.y) });
  await sleep(220);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
  const pinchAfter = await page.evaluate(() => document.querySelector('.imged-zoom-value').textContent);
  check('手机:双指捏合缩放画面', pinchBefore !== pinchAfter, JSON.stringify({ before: pinchBefore, after: pinchAfter }));

  await page.evaluate(() => document.querySelector('[data-imged-jump="card"]').click());
  await sleep(800);
  const jump = await page.evaluate(() => {
    const panel = document.querySelector('.imged-panel');
    const target = document.querySelector('[data-imged-sec="card"]');
    return {
      active: document.querySelector('[data-imged-jump="card"]').getAttribute('aria-current'),
      top: Math.round(target.getBoundingClientRect().top - panel.getBoundingClientRect().top),
    };
  });
  check('手机:点击 chips 跳转到对应分区并高亮', jump.active === 'true' && jump.top >= -8 && jump.top < 180, JSON.stringify(jump));
  /* 触屏名片:四角手柄要能直接拖,不能只支持鼠标 */
  await page.evaluate(() => document.querySelector('[data-imged="pick-card"]').click());
  await page.waitForFunction(() => document.querySelector('.imged-picker').open, { timeout: 10000 });
  await page.evaluate(() => document.querySelector('[data-card-id="business/Ma1/Card_Ma1_vx_4i_Bit_B"]').click());
  await page.waitForFunction(() => document.querySelector('.imged-card-name').textContent === 'Bit B', { timeout: 30000 });
  await sleep(700);
  const cardTouchBefore = parseQuad(await page.evaluate(() => document.querySelector('.imged-card-meta').textContent));
  const handle = await page.evaluate(() => {
    const c = document.querySelector('[data-card-corner="1"]');
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, r: Number(c.getAttribute('r')) };
  });
  const touch = await page.createCDPSession();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: handle.x, y: handle.y, id: 1 }] });
  for (let i = 1; i <= 6; i++) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: handle.x + (36 * i) / 6, y: handle.y + (18 * i) / 6, id: 1 }],
    });
    await sleep(30);
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
  const cardTouchAfter = parseQuad(await page.evaluate(() => document.querySelector('.imged-card-meta').textContent));
  check('手机:名片四角手柄可触屏拖动(手柄已放大)',
    !!cardTouchBefore && !!cardTouchAfter && handle.r >= 9
      && !samePoint(cardTouchAfter.tr, cardTouchBefore.tr)
      && samePoint(cardTouchAfter.tl, cardTouchBefore.tl)
      && samePoint(cardTouchAfter.br, cardTouchBefore.br)
      && samePoint(cardTouchAfter.bl, cardTouchBefore.bl),
    JSON.stringify({ radius: handle.r, before: cardTouchBefore, after: cardTouchAfter }));

  /* 横屏:舞台在左、编辑区停靠右侧,底部面板不再挤占高度 */
  await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
  await sleep(800);
  const land = await page.evaluate(() => {
    const stage = document.querySelector('.imged-stage').getBoundingClientRect();
    const panel = document.querySelector('.imged-panel').getBoundingClientRect();
    return {
      display: getComputedStyle(document.querySelector('.imged-body')).display,
      stage: { x: Math.round(stage.x), w: Math.round(stage.width), h: Math.round(stage.height) },
      panel: { x: Math.round(panel.x), w: Math.round(panel.width), h: Math.round(panel.height) },
      grip: getComputedStyle(document.querySelector('.imged-m-grip')).display,
      ox: document.documentElement.scrollWidth - innerWidth,
    };
  });
  check('手机横屏:舞台左 / 编辑区右停靠、无横向溢出',
    land.display === 'grid' && land.stage.x === 0 && land.panel.x >= land.stage.w - 1
      && land.panel.w >= 260 && land.stage.h >= 150 && land.grip === 'none' && land.ox <= 0,
    JSON.stringify(land));
  await page.screenshot({ path: path.join(OUT, 'verify-mobile-landscape.png') });

  check('手机:外壳无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.screenshot({ path: path.join(OUT, 'verify-mobile.png') });
  await page.close();
}

await browser.close();
for (const line of out) console.log(line);
console.log(failures ? ('FAILED ' + failures + ' 项') : 'ALL PASS');
process.exit(failures ? 1 : 0);
