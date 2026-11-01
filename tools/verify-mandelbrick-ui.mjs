/* 首领入侵/曼德尔砖标题动画(animations/animation_9)的交互校验:
 * 侧栏区块显隐 / 编辑区隐藏的图层 / 图标在最上层 / 文字可编辑 / 文字颜色 / 形状颜色 /
 * 动画主题色(设计红 #FF3D3B 整族替换与重置)/ 图标选择与上传 / 立绘调色(含「纯白 = 原图标」)/
 * 资源 404 / 画廊卡片与封面。
 * 用法(dev server 已在 5173 运行时):node tools/verify-mandelbrick-ui.mjs
 * 也可用 DEV_ORIGIN=http://127.0.0.1:4173 指向 npm run preview 的构建产物。 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.DEV_ORIGIN || 'http://127.0.0.1:5173';
const KEY = 'mandelbrick';
const LABEL = '首领入侵/曼德尔砖标题';
const ICON = '德穆兰.png';
const OUT = path.resolve(import.meta.dirname, '.mandelbrick-check');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, msg, extra) => {
  console.log((ok ? '  OK   ' : '  FAIL ') + msg + (extra === undefined ? '' : '  ' + JSON.stringify(extra)));
  if (!ok) failures++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1700, height: 1000 },
});
try {
  const page = await browser.newPage();
  const errors = [];
  const bad404 = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  page.on('response', (r) => { if (r.status() >= 400) bad404.push(r.status() + ' ' + r.url().slice(-70)); });

  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !document.getElementById('app-loading'), { timeout: 300_000, polling: 200 });
  /* 应用外壳是「主页 / 编辑器 / 关于」三页,初始停在主页时编辑器(.layout)带 hidden,
   * 舞台量出来是 0×0 —— 先切到编辑器页,后面的舞台截图与侧栏断言才有意义。 */
  await page.evaluate(() => document.querySelector('.rail-item[data-page="editor"]')?.click());
  await page.waitForFunction(() => {
    const layout = document.querySelector('.layout');
    return document.documentElement.dataset.page === 'editor' && !!layout && !layout.hidden;
  }, { timeout: 30_000, polling: 100 });
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('已载入'), { timeout: 120_000 });

  const options = await page.evaluate(() =>
    [...document.querySelectorAll('#selAnim option')].map((o) => ({ key: o.value, label: o.textContent })));
  console.log('[1] 注册表里的动画数:' + options.length);
  check(options.length === 9, '注册表里有 9 套动画', options.length);
  check(options.some((o) => o.key === KEY && o.label === LABEL), '列表里有「' + LABEL + '」且名字正确', options.find((o) => o.key === KEY));

  await page.evaluate(() => { window.__prevAnim = window.__anim; });
  await page.select('#selAnim', KEY);
  await page.waitForFunction((k) => document.getElementById('selAnim').value === k
    && window.__anim && window.__anim !== window.__prevAnim && window.__anim.isLoaded, { timeout: 180_000, polling: 200 }, KEY);
  await sleep(700);

  const info = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return el ? (el.hidden ? 'hidden' : 'visible') : 'missing'; };
    const d = window.__anim.animationData;
    const first = d.layers[0] || {};
    return {
      sections: {
        timing: vis('timingSection'), theme: vis('themeSection'), mandelTheme: vis('mandelThemeSection'),
        image: vis('imageSection'), icon: vis('iconSection'), popup: vis('popupSection'), reward: vis('missionRewardSection'),
      },
      mandelTheme: {
        picker: document.getElementById('mandelThemeColor')?.value ?? null,
        hex: document.getElementById('mandelThemeColorHex')?.value ?? null,
        count: document.getElementById('mandelThemeCount')?.textContent ?? null,
      },
      imageTintNote: vis('imageTintNote'),
      totalFrames: window.__anim.totalFrames,
      fr: window.__anim.frameRate,
      size: [d.w, d.h],
      layerCount: d.layers.length,
      firstLayer: { ind: first.ind, nm: first.nm, ty: first.ty, refId: first.refId },
      precompAssets: (d.assets || []).filter((a) => Array.isArray(a.layers)).map((a) => a.id),
      textItems: [...document.querySelectorAll('#textList .t-name')].map((n) => n.textContent),
      colorPickers: document.querySelectorAll('#textList .t-color').length,
      shapeItems: [...document.querySelectorAll('#shapeList .t-name')].map((n) => n.textContent),
      shapeColorPickers: document.querySelectorAll('#shapeList input[type=color]').length,
      imageItems: [...document.querySelectorAll('#imageList .t-name')].map((n) => n.textContent),
      imageCount: document.getElementById('imageCount').textContent,
      imageColor: document.querySelector('#imageList .i-color')?.value ?? null,
      imageOpacity: document.querySelectorAll('#imageList .o-slider').length,
      assets: (d.assets || []).map((a) => ({ id: a.id, p: String(a.p).slice(0, 60), u: a.u, e: a.e, pr: a.pr })),
      mattes: (d.layers || []).filter((l) => l.tt || l.td).map((l) => [l.ind, 'tt' + (l.tt ?? '-'), 'td' + (l.td ?? '-')]),
      renderer: document.getElementById('selRenderer').value,
      status: document.getElementById('statusbar').textContent,
      triggerName: document.getElementById('animTriggerName').textContent,
    };
  });
  console.log('[2] ' + JSON.stringify(info, null, 1));
  check(info.totalFrames === 188, '总帧数 = 188', info.totalFrames);
  check(info.fr === 60, '帧率 = 60', info.fr);
  check(info.size[0] === 1920 && info.size[1] === 1080, '画布 1920×1080', info.size);
  /* 图标在最上层:数据层的第 0 项就是那张位图(渲染顺序 = 数组顺序,见 SVG 一节的 DOM 断言) */
  check(info.firstLayer.ty === 2 && info.firstLayer.refId === 'image_0' && info.firstLayer.nm === ICON,
    '图标图层在 layers 队首(最上层)', info.firstLayer);
  check(info.layerCount === 28, '图层总数仍是 28(编辑区隐藏不影响画面)', info.layerCount);
  check(info.precompAssets.join(',') === 'comp_0,comp_1', 'comp_0 / comp_1 预合成仍在数据里(画布照常渲染)', info.precompAssets);
  check(info.textItems.length === 1, '侧栏列出 1 个文字图层', info.textItems);
  check(info.textItems[0] === '安全总监莅临', '文字层名字就是标题文案', info.textItems[0]);
  check(info.colorPickers === 1, '文字层有颜色选择器', info.colorPickers);
  /* 编辑区隐藏:comp_0 / comp_1 内部图层 + 顶层「形状图层 25」都不列(23 - 5 - 1 = 17) */
  check(info.shapeItems.length === 17, '「形状图层」列出 17 层(comp_0 / comp_1 与 形状图层 25 已隐藏)', info.shapeItems.length);
  check(!info.shapeItems.some((n) => n.includes('comp_0') || n.includes('comp_1')),
    '列表里没有 comp_0 / comp_1 的任何图层', info.shapeItems);
  check(!info.shapeItems.some((n) => n.replace(/\s+/g, '') === '形状图层25'),
    '列表里没有「形状图层 25」', info.shapeItems);
  check(info.shapeColorPickers >= 10, '剩余形状层仍有填充/描边取色器', info.shapeColorPickers);
  check(info.sections.timing === 'hidden', '「动画时长」区块对这套动画隐藏(caps 为空)', info.sections.timing);
  check(info.sections.popup === 'hidden', '「弹窗叠加层」区块隐藏(没有独立弹窗)', info.sections.popup);
  check(info.sections.reward === 'hidden', '「报酬信息」区块隐藏(不是任务弹窗动画)', info.sections.reward);
  check(info.sections.image === 'visible', '「图片图层」区块显示(立绘可调色 / 调不透明度)', info.sections.image);
  check(info.sections.icon === 'visible', '「图标选择」区块显示(立绘可换图)', info.sections.icon);
  /* 主题色统一换色(两族 HUD 色)不适用于本套红白配色 → 区块隐藏;
     换成本套自己的「动画主题色」区块(出厂 #FF3D3B)。 */
  check(info.sections.theme === 'hidden', '「主题颜色」(#77B0F0 / #78C5F3 两族)区块隐藏', info.sections.theme);
  check(info.sections.mandelTheme === 'visible', '「动画主题色」区块显示(本套的设计红 #FF3D3B)', info.sections.mandelTheme);
  /* 取色器与 HEX 框由 syncMandelThemeSection 回填,与「主题颜色」区同一条路子 → 小写 #ff3d3b */
  check(info.mandelTheme.picker === '#ff3d3b' && info.mandelTheme.hex === '#ff3d3b',
    '主题色色块初始是出厂 #FF3D3B', info.mandelTheme);
  check((info.mandelTheme.count || '').replace(/\s+/g, ' ').includes('19'),
    '主题色计数 = 19 处(15 描边 + 4 填充)', info.mandelTheme);
  check(info.imageTintNote === 'visible', '「图片图层」下有纯白 = 原图标的调色约定说明', info.imageTintNote);
  check(info.imageCount.includes('1'), '「图片图层」只列 1 项(那张立绘)', info.imageCount);
  check(info.imageItems.length === 1 && info.imageItems[0] === ICON, '图片图层就是「德穆兰.png」', info.imageItems);
  check(info.imageColor === '#ffffff', '立绘取色器初始为白色(未调色)', info.imageColor);
  check(info.imageOpacity === 1, '立绘有不透明度滑块', info.imageOpacity);
  check(info.triggerName === LABEL, '顶栏触发器显示动画名', info.triggerName);
  check(info.status.includes(LABEL), '状态栏文案点名这套动画', info.status);
  const imgAsset = info.assets.find((a) => a.id === 'image_0');
  check(!!imgAsset && imgAsset.e === 1 && imgAsset.u === '' && /^\//.test(imgAsset.p),
    '位图资源已改写为打包地址(u 置空、e=1、p 是站点地址)', imgAsset);
  const tt = info.mattes.filter((m) => m[1] !== 'tt-').length;
  const td = info.mattes.filter((m) => m[2] !== 'td-').length;
  check(tt === 4 && td === 3, '轨道遮罩 4 目标 / 3 源(预合成被两层共用,导出自动走 SVG 光栅化)', info.mattes);

  // 画面不是空的:第 90 帧(立绘与文字都已淡入完成)统计 SVG 内容并截图留档
  const draw = await page.evaluate(() => {
    window.__anim.pause();
    window.__anim.goToAndStop(90, true);
    const root = document.querySelector('#previewInner svg');
    const rootG = root?.querySelector(':scope > g');
    const kids = rootG ? [...rootG.children] : [];
    const img = [...document.querySelectorAll('#previewInner svg image')].find((i) => !i.closest('defs') && i.getAttribute('width'));
    const imgGroup = img ? (img.closest('svg > g > g') || img.closest('svg > g')) : null;
    return {
      svg: !!root,
      nodes: root ? root.querySelectorAll('path,text,image,g,rect').length : 0,
      groupCount: kids.length,
      iconGroupIndex: imgGroup ? kids.indexOf(imgGroup) : -1,
      iconGroupIsLast: !!imgGroup && imgGroup === kids[kids.length - 1],
    };
  });
  await sleep(500);
  const stage = await page.$('#stage');
  await stage.screenshot({ path: path.join(OUT, 'frame-90.png') });
  console.log('[3] 渲染节点:' + JSON.stringify(draw));
  check(draw.nodes > 10, '第 90 帧有内容(SVG 节点数 > 10)', draw.nodes);
  check(draw.iconGroupIsLast, 'SVG 里图标是最上层(图层组排在容器最后,后画的盖在上面)', draw);

  // 改文字:确认数据与画面都跟着变
  const edited = await page.evaluate(async () => {
    const ta = document.querySelector('#textList .t-input');
    const before = ta.value;
    ta.value = '曼德尔砖测试标题';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return { before, now: document.querySelector('#textList .t-input').value };
  });
  await sleep(1500);
  const afterText = await page.evaluate(() => {
    window.__anim.pause();
    window.__anim.goToAndStop(90, true);
    const root = document.querySelector('#previewInner svg');
    return { svgText: root ? root.textContent : '' };
  });
  await sleep(400);
  await stage.screenshot({ path: path.join(OUT, 'after-text-edit.png') });
  console.log('[4] 文字编辑:' + JSON.stringify({ ...edited, svgText: afterText.svgText.slice(0, 60) }));
  check(edited.before === '安全总监莅临', '文字框初值就是原文案', edited.before);
  check(edited.now === '曼德尔砖测试标题', '文字框接受了新文案', edited.now);
  check(afterText.svgText.includes('曼德尔砖测试标题'), '渲染出的 SVG 里出现新文案', afterText.svgText.slice(0, 60));
  check(!afterText.svgText.includes('安全总监莅临'), '旧文案已从画面消失', '');

  // 改文字颜色:fc 与画面填充都要跟着变
  const colorRes = await page.evaluate(async () => {
    const ci = document.querySelector('#textList .t-color');
    const ind = Number(ci.dataset.ind);
    ci.value = '#ff0000';
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.nextElementSibling.value = '#ff0000';
    ci.nextElementSibling.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    return { ind };
  });
  await sleep(1500);
  const afterColor = await page.evaluate((ind) => {
    const walk = (ls) => { for (const l of ls || []) { if (l.ind === ind) return l; const f = walk(l.layers); if (f) return f; } return null; };
    const l = walk(window.__anim.animationData.layers);
    const td = l && l.t && l.t.d && l.t.d.k;
    const s = Array.isArray(td) ? td[0].s : td && td.s;
    window.__anim.pause();
    window.__anim.goToAndStop(90, true);
    const counts = {};
    for (const e of document.querySelectorAll('#previewInner svg [fill]')) {
      const v = e.getAttribute('fill');
      counts[v] = (counts[v] || 0) + 1;
    }
    return { fc: s && s.fc, fills: counts, hexInput: document.querySelector('#textList .hex-input')?.value };
  }, colorRes.ind);
  await sleep(400);
  await stage.screenshot({ path: path.join(OUT, 'after-color-edit.png') });
  console.log('[5] 文字颜色:' + JSON.stringify(afterColor));
  check(JSON.stringify(afterColor.fc) === '[1,0,0]', '图层 fc 变成纯红 [1,0,0]', afterColor.fc);
  check(!!afterColor.fills['rgb(255,0,0)'], '渲染出的画面里出现纯红填充', afterColor.fills);
  check(afterColor.hexInput === '#ff0000', 'HEX 输入框与取色器同步', afterColor.hexInput);

  // 改形状层的填充色:数据与画面都要跟着变(取第一个带填充取色器的可见层)
  const shapeRes = await page.evaluate(async () => {
    const ci = document.querySelector('#shapeList .s-fill');
    if (!ci) return null;
    const ind = Number(ci.dataset.ind);
    const before = ci.value;
    ci.value = '#00ff88';
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.nextElementSibling.value = '#00ff88';
    ci.nextElementSibling.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    return { ind, before };
  });
  check(!!shapeRes, '形状图层列表里有填充取色器', shapeRes);
  await sleep(1500);
  const afterShape = await page.evaluate((ind) => {
    const walk = (ls) => { for (const l of ls || []) { if (l.ind === ind) return l; const f = walk(l.layers); if (f) return f; } return null; };
    const l = walk(window.__anim.animationData.layers);
    const found = [];
    const chk = (items) => {
      for (const it of items || []) {
        if (it.ty === 'fl' && it.c && it.c.a === 0) found.push(it.c.k.slice(0, 3).map((v) => Math.round(v * 255)).join(','));
        if (it.it) chk(it.it);
      }
    };
    chk(l && l.shapes);
    window.__anim.pause();
    window.__anim.goToAndStop(90, true);
    const fills = {};
    for (const e of document.querySelectorAll('#previewInner svg [fill]')) {
      const v = e.getAttribute('fill');
      fills[v] = (fills[v] || 0) + 1;
    }
    return { shapeFills: found, svgFills: fills };
  }, shapeRes?.ind ?? -1);
  await sleep(400);
  await stage.screenshot({ path: path.join(OUT, 'after-shape-color.png') });
  console.log('[6] 形状颜色:' + JSON.stringify({ ...shapeRes, ...afterShape }));
  check(afterShape.shapeFills.includes('0,255,136'), '形状层填充变成 #00ff88', afterShape.shapeFills);
  check(!!afterShape.svgFills['rgb(0,255,136)'], '画面里出现 #00ff88 填充', afterShape.svgFills);

  // 动画主题色(仅本套):改一次就把所有等于 #FF3D3B 的填充与描边整族换掉,「重置为默认色」换回出厂红
  await page.evaluate(() => {
    /* 数一遍当前数据里某个颜色值还剩多少处(填充与描边都算,含预合成内部) */
    window.__countColorHex = (hex) => {
      const hexOf = (v) => '#' + v.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
      let n = 0;
      const walkShapes = (items) => {
        for (const it of items || []) {
          if (it.ty === 'fl' || it.ty === 'st') {
            const c = it.c;
            if (c && c.a === 0 && Array.isArray(c.k) && hexOf(c.k) === hex) n++;
          }
          if (it.it) walkShapes(it.it);
        }
      };
      const walkLayers = (ls) => {
        for (const l of ls || []) { if (l.ty === 4) walkShapes(l.shapes); if (Array.isArray(l.layers)) walkLayers(l.layers); }
      };
      const d = window.__anim.animationData;
      walkLayers(d.layers);
      for (const a of d.assets || []) if (Array.isArray(a.layers)) walkLayers(a.layers);
      return n;
    };
    /* 画面里实际画出来的颜色(填充与描边两条属性一起数):#ff3d3b 在 SVG 里是 rgb(255,61,59) */
    window.__paintCounts = () => {
      const counts = {};
      for (const e of document.querySelectorAll('#previewInner svg [fill],#previewInner svg [stroke]')) {
        const v = e.getAttribute('fill') || e.getAttribute('stroke');
        if (v) counts[v] = (counts[v] || 0) + 1;
      }
      return counts;
    };
  });
  const themeBefore = await page.evaluate(() => {
    window.__anim.pause();
    window.__anim.goToAndStop(90, true);
    return {
      red: window.__countColorHex('#ff3d3b'),
      picker: document.getElementById('mandelThemeColor').value,
      paints: window.__paintCounts(),
    };
  });
  await page.evaluate(() => {
    const ci = document.getElementById('mandelThemeColor');
    ci.value = '#00ff88';
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.nextElementSibling.value = '#00ff88';
    ci.nextElementSibling.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('动画主题色已改为'), { timeout: 30_000, polling: 100 });
  await sleep(1200);
  const themeApplied = await page.evaluate(() => {
    window.__anim.pause();
    window.__anim.goToAndStop(90, true);
    return {
      red: window.__countColorHex('#ff3d3b'),
      green: window.__countColorHex('#00ff88'),
      picker: document.getElementById('mandelThemeColor').value,
      hexInput: document.querySelector('#mandelThemeSection .hex-input').value,
      count: document.getElementById('mandelThemeCount').textContent,
      section: document.getElementById('mandelThemeSection').hidden ? 'hidden' : 'visible',
      paints: window.__paintCounts(),
    };
  });
  await sleep(400);
  await stage.screenshot({ path: path.join(OUT, 'after-theme-color.png') });
  console.log('[6b] 动画主题色:' + JSON.stringify({ themeBefore, themeApplied }));
  check(themeBefore.red >= 15, '出厂数据里有 10 处以上的 #FF3D3B', themeBefore.red);
  check(!!themeBefore.paints['rgb(255,61,59)'], '画面里本来就有 #FF3D3B 的描边/填充', themeBefore.paints);
  /* 注意:上一步手改的某个形状层填充也是 #00ff88,所以这里只能断言"旧红一处不剩、新色覆盖到画面" */
  check(themeApplied.red === 0, '#FF3D3B 整族被换掉(数据里旧红一处不剩)', themeApplied.red);
  check(themeApplied.green >= themeBefore.red,
    '替换处数覆盖到整族(新色处数 >= 旧红原处数)', [themeBefore.red, themeApplied.green]);
  check(themeApplied.picker === '#00ff88' && themeApplied.hexInput === '#00ff88',
    '主题色色块与 HEX 输入框同步', [themeApplied.picker, themeApplied.hexInput]);
  check(/\d+/.test(themeApplied.count || '') && themeApplied.count.includes(String(themeApplied.green)),
    '计数跟着变成新颜色族的处数', [themeApplied.count, themeApplied.green]);
  check(themeApplied.section === 'visible', '改色后「动画主题色」区块仍显示', themeApplied.section);
  check(!themeApplied.paints['rgb(255,61,59)'] && !!themeApplied.paints['rgb(0,255,136)'],
    '画面里旧红消失、出现新主题色', themeApplied.paints);

  // 重置为默认色:整族换回出厂 #FF3D3B
  await page.evaluate(() => document.getElementById('mandelThemeReset').click());
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('动画主题色已恢复'), { timeout: 30_000, polling: 100 });
  await sleep(1200);
  const themeReset = await page.evaluate(() => {
    window.__anim.pause();
    window.__anim.goToAndStop(90, true);
    return {
      red: window.__countColorHex('#ff3d3b'),
      green: window.__countColorHex('#00ff88'),
      picker: document.getElementById('mandelThemeColor').value,
      count: document.getElementById('mandelThemeCount').textContent,
      paints: window.__paintCounts(),
    };
  });
  await stage.screenshot({ path: path.join(OUT, 'after-theme-reset.png') });
  console.log('[6c] 主题色重置:' + JSON.stringify(themeReset));
  /* 重置是**精确还原**:只把主题色真的改过的项换回原值,上一步手改的那一层(#00ff88)保持不动 */
  check(themeReset.red === themeBefore.red, '重置后主题色改过的项全部回到出厂 #FF3D3B', [themeBefore.red, themeReset.red]);
  check(themeReset.green === 1, '手改的那一层仍是 #00ff88(主题色只还原自己碰过的项)', themeReset.green);
  check(themeReset.picker === '#ff3d3b', '色块回到 #ff3d3b', themeReset.picker);
  check(!!themeReset.paints['rgb(255,61,59)'], '画面里重新出现 #FF3D3B', themeReset.paints);

  /* 主题色恰好等于素材里已有的另一种颜色(这里是纯白描边 #ffffff)时必须**不误伤**:
   * 那种情况按颜色值反查着还原,会把"本来就是这个颜色的地方"一起改掉,这里守住"只还原自己碰过的项"。 */
  const whiteTheme = await page.evaluate(() => {
    const whitesBefore = window.__countColorHex('#ffffff');
    const ci = document.getElementById('mandelThemeColor');
    ci.value = '#ffffff';
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.nextElementSibling.value = '#ffffff';
    ci.nextElementSibling.dispatchEvent(new Event('input', { bubbles: true }));
    return { whitesBefore, statusBefore: document.getElementById('statusbar').textContent };
  });
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('#FFFFFF'), { timeout: 30_000, polling: 100 });
  await sleep(1000);
  const whiteApplied = await page.evaluate(() => ({
    red: window.__countColorHex('#ff3d3b'),
    white: window.__countColorHex('#ffffff'),
  }));
  const statusBeforeReset = await page.evaluate(() => document.getElementById('statusbar').textContent);
  await page.evaluate(() => document.getElementById('mandelThemeReset').click());
  await page.waitForFunction((b) => document.getElementById('statusbar').textContent !== b, { timeout: 30_000, polling: 100 }, statusBeforeReset);
  await sleep(1000);
  const whiteReset = await page.evaluate(() => ({
    red: window.__countColorHex('#ff3d3b'),
    white: window.__countColorHex('#ffffff'),
    green: window.__countColorHex('#00ff88'),
    picker: document.getElementById('mandelThemeColor').value,
  }));
  console.log('[6d] 主题色撞已有颜色(纯白):' + JSON.stringify({ whiteTheme, whiteApplied, whiteReset }));
  check(whiteTheme.whitesBefore >= 5, '素材里本来就有若干处 #FFFFFF(白描边)', whiteTheme.whitesBefore);
  check(whiteApplied.red === 0 && whiteApplied.white === whiteTheme.whitesBefore + themeBefore.red,
    '把主题色改成纯白:整族红都变白(原有白描边不受影响)', [whiteApplied.red, whiteApplied.white, whiteTheme.whitesBefore]);
  check(whiteReset.white === whiteTheme.whitesBefore,
    '重置后原有白描边的处数一点没变(不按颜色值反查,只还原自己碰过的项)', [whiteReset.white, whiteTheme.whitesBefore]);
  check(whiteReset.red === themeBefore.red && whiteReset.green === 1,
    '重置后红色原样回到 ' + themeBefore.red + ' 处、手改那层仍是绿', whiteReset);

  // 图标选择:内置 1 张(animations/animation_9/images/德穆兰.png),默认选中数据里引用的那张;
  // 单图标位形态 —— 没有分段选项卡 /「显示图标」/「居中微调」/「图标不透明度」
  const iconUi = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return el ? (el.hidden ? 'hidden' : 'visible') : 'missing'; };
    return {
      section: vis('iconSection'), tabs: vis('iconScopeTabs'), toggle: vis('iconToggleRow'),
      opacity: vis('iconOpacityRow'), nudge: vis('iconNudgeRow'),
      hint: vis('iconScopeHint'),
      count: document.getElementById('iconCount').textContent,
      items: [...document.querySelectorAll('#iconList .icon-item')].map((li) => li.dataset.name),
      active: document.querySelector('#iconList .icon-item.is-active')?.dataset.name ?? null,
      thumbsOk: [...document.querySelectorAll('#iconList .icon-thumb')].every((im) => !!im.getAttribute('src')),
      layerName: (window.__anim.animationData.layers || []).find((l) => l.ty === 2)?.nm,
      pr: (window.__anim.animationData.assets || []).find((a) => a.id === 'image_0')?.pr,
    };
  });
  console.log('[7] 图标选择:' + JSON.stringify(iconUi));
  check(iconUi.items.length === 1, '内置候选 = 1 张(animations/animation_9/images/德穆兰.png)', iconUi.items);
  check(iconUi.items[0] === ICON, '列表里就是数据引用的 德穆兰.png', iconUi.items);
  check(iconUi.active === ICON, '默认选中数据里引用的 德穆兰.png', iconUi.active);
  check(iconUi.thumbsOk, '候选有缩略图', iconUi.thumbsOk);
  check(iconUi.layerName === ICON, '图标位就是立绘图层「德穆兰.png」', iconUi.layerName);
  check(iconUi.tabs === 'hidden' && iconUi.toggle === 'hidden' && iconUi.nudge === 'hidden',
    '单图标位形态:分段选项卡 /「显示图标」/ 居中微调都隐藏', [iconUi.tabs, iconUi.toggle, iconUi.nudge]);
  check(iconUi.opacity === 'hidden' && iconUi.hint === 'hidden',
    '「图标不透明度」(仅任务弹窗)与二次扫描提示隐藏', [iconUi.opacity, iconUi.hint]);
  check(iconUi.pr === 'xMidYMid meet', '立绘资源带 pr=xMidYMid meet(非正方自定义图不被裁切)', iconUi.pr);

  // 立绘调色:内置立绘是「纯黑 + alpha」的剪影,挑一个颜色应能把它整片上色。
  // 选纯绿(和画面里的红 HUD 区分度最高),断言资源换成着色后的 data URI、画面里的 <image> 跟着换、
  // 且**真正画出来的像素**以绿色为主 —— 只看 href 不够,黑色剪影用错算法(保留亮度换色相)会"拖了颜色画面不动"。
  await page.evaluate(() => {
    const ci = document.querySelector('#imageList .i-color');
    ci.value = '#00ff00';
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.nextElementSibling.value = '#00ff00';
    ci.nextElementSibling.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('图标颜色已改为'), { timeout: 30_000, polling: 100 });
  await sleep(1200);
  const tinted = await page.evaluate(() => {
    const a = window.__anim.animationData.assets.find((x) => x.id === 'image_0');
    const im = [...document.querySelectorAll('#previewInner svg image')].find((i) => !i.closest('defs') && i.getAttribute('width'));
    const href = im && (im.getAttribute('href') || im.getAttribute('xlink:href') || '');
    return {
      pIsData: String(a.p).startsWith('data:image/'), pLen: String(a.p).length,
      hrefIsData: String(href || '').startsWith('data:image/'),
      picker: document.querySelector('#imageList .i-color')?.value,
      status: document.getElementById('statusbar').textContent,
    };
  });
  await stage.screenshot({ path: path.join(OUT, 'after-icon-tint.png') });
  /* 像素实测:按 <image> 的渲染矩形截一张,数绿色像素占比 —— 纯黑剪影着色后应当大面积变绿 */
  const iconRect = await page.evaluate(() => {
    const im = [...document.querySelectorAll('#previewInner svg image')].find((i) => !i.closest('defs') && i.getAttribute('width'));
    const r = im.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const iconShot = await page.screenshot({ encoding: 'base64', clip: iconRect });
  const iconPixels = await page.evaluate(async ({ b, w, h }) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b; await img.decode();
    const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(w)); cv.height = Math.max(1, Math.round(h));
    const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let green = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) { n++; if (px[i + 1] > px[i] + 12 && px[i + 1] > px[i + 2] + 12) green++; }
    return { size: [cv.width, cv.height], greenFrac: +(green / n).toFixed(3) };
  }, { b: iconShot, w: iconRect.width, h: iconRect.height });
  console.log('[8] 立绘调色:' + JSON.stringify({ ...tinted, iconPixels }));
  check(tinted.pIsData, '资源 p 换成着色后的 data URI', tinted.pLen);
  check(tinted.hrefIsData, '画面里 <image> 的 href 也跟着换', tinted.hrefIsData);
  check(tinted.picker === '#00ff00', '取色器显示当前颜色 #00ff00', tinted.picker);
  check(iconPixels.greenFrac > 0.3, '画面里的立绘真的被染成绿色(黑色剪影走的是整片上色)', iconPixels);

  // 切走再切回:着色要保留(applyIconsToData 写回图标地址时按记录恢复着色结果)
  await page.evaluate(() => { window.__prevAnim = window.__anim; });
  await page.select('#selAnim', 'extraction');
  await sleep(700);
  const otherAnim = await page.evaluate(() => ({
    mandelTheme: document.getElementById('mandelThemeSection').hidden ? 'hidden' : 'visible',
    theme: document.getElementById('themeSection').hidden ? 'hidden' : 'visible',
  }));
  check(otherAnim.mandelTheme === 'hidden', '切到别的动画时「动画主题色」区块隐藏(仅 #009)', otherAnim);
  await page.evaluate(() => { window.__prevAnim = window.__anim; });
  await page.select('#selAnim', KEY);
  await page.waitForFunction((k) => document.getElementById('selAnim').value === k
    && window.__anim && window.__anim !== window.__prevAnim && window.__anim.isLoaded, { timeout: 180_000, polling: 200 }, KEY);
  await sleep(900);
  const kept = await page.evaluate(() => {
    const a = window.__anim.animationData.assets.find((x) => x.id === 'image_0');
    return {
      pIsData: String(a.p).startsWith('data:image/'),
      picker: document.querySelector('#imageList .i-color')?.value,
      active: document.querySelector('#iconList .icon-item.is-active')?.dataset.name ?? null,
      totalFrames: window.__anim.totalFrames,
      first: window.__anim.animationData.layers[0].nm,
      imageSection: document.getElementById('imageSection').hidden ? 'hidden' : 'visible',
    };
  });
  console.log('[9] 切换动画后保留:' + JSON.stringify(kept));
  check(kept.pIsData && kept.picker === '#00ff00', '切走再切回,立绘颜色仍是绿的', kept);
  check(kept.active === ICON, '切走再切回仍选中 德穆兰.png', kept.active);
  check(kept.totalFrames === 188, '切回来仍是 188 帧', kept.totalFrames);
  check(kept.first === ICON, '切回来图标仍在最上层', kept.first);
  check(kept.imageSection === 'visible', '切回来「图片图层」区块仍在', kept.imageSection);

  // 重置颜色:资源换回打包地址、取色器回白
  await page.evaluate(() => document.querySelector('#imageList .i-reset').click());
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('图标颜色已恢复'), { timeout: 30_000, polling: 100 });
  await sleep(1200);
  const afterReset = await page.evaluate(() => {
    const a = window.__anim.animationData.assets.find((x) => x.id === 'image_0');
    return { pIsData: String(a.p).startsWith('data:image/'), p: String(a.p).slice(0, 40), picker: document.querySelector('#imageList .i-color')?.value };
  });
  console.log('[10] 重置颜色:' + JSON.stringify(afterReset));
  check(!afterReset.pIsData && /^\//.test(afterReset.p), '资源换回打包地址', afterReset.p);
  check(afterReset.picker === '#ffffff', '取色器回到白色', afterReset.picker);

  /* 纯白 = 原图标(不做任何颜色叠加):先调成红色,再把取色器拖回纯白 —— 资源必须换回素材原地址。
   * 旧实现会把黑色剪影整片刷成白色(一片白,看起来像原图丢了),这条断言守住"白色不叠色"。 */
  await page.evaluate(() => {
    const ci = document.querySelector('#imageList .i-color');
    ci.value = '#ff0000';
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.nextElementSibling.value = '#ff0000';
    ci.nextElementSibling.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('图标颜色已改为'), { timeout: 30_000, polling: 100 });
  await sleep(900);
  const beforeWhite = await page.evaluate(() => {
    const a = window.__anim.animationData.assets.find((x) => x.id === 'image_0');
    return { p: String(a.p).slice(0, 24), pIsData: String(a.p).startsWith('data:image/') };
  });
  await page.evaluate(() => {
    const ci = document.querySelector('#imageList .i-color');
    ci.value = '#ffffff';
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.nextElementSibling.value = '#ffffff';
    ci.nextElementSibling.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('纯白'), { timeout: 30_000, polling: 100 });
  await sleep(900);
  const afterWhite = await page.evaluate(() => {
    const a = window.__anim.animationData.assets.find((x) => x.id === 'image_0');
    const im = [...document.querySelectorAll('#previewInner svg image')].find((i) => !i.closest('defs') && i.getAttribute('width'));
    const href = im && (im.getAttribute('href') || im.getAttribute('xlink:href') || '');
    return {
      pIsData: String(a.p).startsWith('data:image/'),
      p: String(a.p).slice(0, 40),
      hrefIsData: String(href || '').startsWith('data:image/'),
      picker: document.querySelector('#imageList .i-color')?.value,
      status: document.getElementById('statusbar').textContent,
    };
  });
  await stage.screenshot({ path: path.join(OUT, 'after-icon-white.png') });
  console.log('[10b] 纯白 = 原图标:' + JSON.stringify({ beforeWhite, afterWhite }));
  check(beforeWhite.pIsData, '先调成红色:资源是着色后的 data URI', beforeWhite.p);
  check(!afterWhite.pIsData && /^\//.test(afterWhite.p), '选纯白后资源换回打包原图(不做任何颜色叠加)', afterWhite.p);
  check(!afterWhite.hrefIsData, '画面里的 <image> 也跟着回到原图', afterWhite.hrefIsData);
  check(afterWhite.picker === '#ffffff', '取色器停在纯白', afterWhite.picker);
  check(afterWhite.status.includes('纯白'), '状态栏说明「纯白 = 使用原图标」', afterWhite.status);

  // 再调一次色,然后上传自定义图标:换图时旧着色作废,取色器回白
  await page.evaluate(() => {
    const ci = document.querySelector('#imageList .i-color');
    ci.value = '#ff0000';
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.nextElementSibling.value = '#ff0000';
    ci.nextElementSibling.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('图标颜色已改为'), { timeout: 30_000, polling: 100 });
  await sleep(800);
  await page.evaluate(() => {
    window.__statusLog = [];
    const el = document.getElementById('statusbar');
    new MutationObserver(() => window.__statusLog.push(el.textContent)).observe(el, { childList: true, subtree: true, characterData: true });
  });
  const uploadInput = await page.$('#iconFile');
  await uploadInput.uploadFile(path.resolve(import.meta.dirname, '..', 'public', 'icons', 'icon-192.png'));
  await sleep(2000);
  const afterUpload = await page.evaluate(() => ({
    items: [...document.querySelectorAll('#iconList .icon-item')].map((li) => li.dataset.name),
    active: document.querySelector('#iconList .icon-item.is-active')?.dataset.name ?? null,
    pIsData: String((window.__anim.animationData.assets || []).find((x) => x.id === 'image_0')?.p).startsWith('data:image/'),
    picker: document.querySelector('#imageList .i-color')?.value,
    statusLog: window.__statusLog || [],
  }));
  await stage.screenshot({ path: path.join(OUT, 'after-icon-upload.png') });
  console.log('[11] 上传自定义图标:' + JSON.stringify(afterUpload));
  check(afterUpload.items.length === 2 && afterUpload.active === 'icon-192',
    '自定义图标进入列表并成为当前项', afterUpload.items);
  check(afterUpload.pIsData, '立绘资源换成上传的 data URI', afterUpload.pIsData);
  check(afterUpload.picker === '#ffffff', '换图后着色作废,取色器回到白色', afterUpload.picker);
  check(afterUpload.statusLog.some((s) => s.includes('自定义图标') && s.includes('首领入侵/曼德尔砖标题动画')),
    '状态栏点名应用到「首领入侵/曼德尔砖标题动画」', afterUpload.statusLog.slice(0, 3));

  // 点回内置那张:资源地址与画面 <image> 同步换回,选中态转移
  const backClicked = await page.evaluate((name) => {
    const el = [...document.querySelectorAll('#iconList .icon-item')].find((li) => li.dataset.name === name);
    if (!el) return false;
    el.click();
    return true;
  }, ICON);
  check(backClicked, '列表里点得到内置的 德穆兰.png', backClicked);
  await page.waitForFunction(() => {
    const a = window.__anim.animationData.assets.find((x) => x.id === 'image_0');
    return !!a && !String(a.p).startsWith('data:');
  }, { timeout: 30_000, polling: 100 });
  await sleep(800);
  const afterIcon = await page.evaluate(() => {
    const a = (window.__anim.animationData.assets || []).find((x) => x.id === 'image_0');
    window.__anim.pause();
    window.__anim.goToAndStop(90, true);
    const imgs = [...document.querySelectorAll('#previewInner svg image')];
    return {
      p: String(a.p), pr: a.pr,
      pars: imgs.filter((i) => !i.closest('defs') && i.getAttribute('width')).map((i) => i.getAttribute('preserveAspectRatio')),
      active: document.querySelector('#iconList .icon-item.is-active')?.dataset.name ?? null,
      picker: document.querySelector('#imageList .i-color')?.value,
    };
  });
  await sleep(400);
  await stage.screenshot({ path: path.join(OUT, 'after-icon-back.png') });
  console.log('[12] 换回内置图:' + JSON.stringify(afterIcon));
  /* dev 下地址是 /animations/animation_9/images/德穆兰.png?no-inline(URL 编码),构建产物会被
   * Vite 重命名成 /assets/xxx-<hash>.png —— 两种形态都只断言「不再是上传的 data URI 且仍是 png」,
   * 具体是哪个文件由选中态与画面 href 一起兜住。 */
  check(!afterIcon.p.startsWith('data:') && /\.png(\?|$)/.test(afterIcon.p), '数据里的立绘资源换回打包地址', afterIcon.p);
  check(afterIcon.pars.length > 0 && afterIcon.pars.every((p) => p === 'xMidYMid meet'),
    '画面里 <image> 的 preserveAspectRatio = xMidYMid meet', afterIcon.pars);
  check(afterIcon.active === ICON, '选中态转回 德穆兰.png', afterIcon.active);

  // 一键重置:着色记录按 'mandelbrick:' 前缀一起清掉,取色器回白、图标仍在最上层
  await page.evaluate(() => {
    const ci = document.querySelector('#imageList .i-color');
    ci.value = '#00ff00';
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    ci.nextElementSibling.value = '#00ff00';
    ci.nextElementSibling.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('图标颜色已改为'), { timeout: 30_000, polling: 100 });
  await sleep(1000);
  await page.evaluate(() => document.getElementById('btnResetAnim').click());
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('已恢复'), { timeout: 90_000, polling: 200 });
  await sleep(1200);
  const afterFullReset = await page.evaluate(() => {
    const d = window.__anim.animationData;
    const a = (d.assets || []).find((x) => x.id === 'image_0');
    return {
      pIsData: String(a?.p).startsWith('data:image/'),
      picker: document.querySelector('#imageList .i-color')?.value,
      active: document.querySelector('#iconList .icon-item.is-active')?.dataset.name ?? null,
      first: d.layers[0]?.nm,
      shapeCount: document.querySelectorAll('#shapeList li').length,
      status: document.getElementById('statusbar').textContent,
    };
  });
  console.log('[reset] 一键重置:' + JSON.stringify(afterFullReset));
  check(!afterFullReset.pIsData && afterFullReset.picker === '#ffffff',
    '一键重置后立绘着色记录被清掉、取色器回白', afterFullReset);
  check(afterFullReset.first === ICON && afterFullReset.shapeCount === 17,
    '一键重置后图标仍在最上层、编辑区仍是 17 层', afterFullReset);

  // 画廊:新卡片在列、带专属封面
  await page.evaluate(() => document.getElementById('animTrigger').click());
  await sleep(800);
  const card = await page.evaluate((k) => {
    const el = document.querySelector('.ap-card[data-key="' + k + '"]');
    if (!el) return null;
    const img = el.querySelector('.ap-card-cover img');
    return { key: el.dataset.key, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100), img: img ? img.getAttribute('src') : null };
  }, KEY);
  console.log('[13] 画廊卡片:' + JSON.stringify(card));
  check(!!card && /(^|\/)mandelbrick[^/]*\.webp/.test(card.img || ''), '画廊里有卡片且使用 posters/mandelbrick.webp', card);
  check(!!card && card.text.includes(LABEL), '卡片标题就是「' + LABEL + '」', card?.text);
  check(!!card && card.text.includes('图标可换'), '卡片特性标签含「图标可换」', card?.text);
  await page.screenshot({ path: path.join(OUT, 'picker.png') });

  check(bad404.length === 0, '没有 4xx/5xx 请求', bad404.slice(0, 5));
  check(errors.length === 0, '没有页面异常', errors.slice(0, 3));
  console.log(failures ? '\n结果:' + failures + ' 项失败' : '\n结果:全部通过');
  console.log('截图目录:' + OUT);
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
