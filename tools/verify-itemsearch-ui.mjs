/* 物品搜索动画(animations/animation_10)的交互校验:
 * 注册表 / 编号 / 侧栏区块显隐 / 文字图层(在预合成 comp_1 里)/ 形状图层(comp_2 的物品颜色)/
 * 图标选择(候选只含单图,不含 195 张序列帧)/ 逐帧序列的资源改写(195 张全部 200,无 404)/
 * 封面与画廊卡片。
 * 用法(dev server 已在 5173 运行时):node tools/verify-itemsearch-ui.mjs
 * 也可用 DEV_ORIGIN=http://127.0.0.1:4173 指向 npm run preview 的构建产物。 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.DEV_ORIGIN || 'http://127.0.0.1:5173';
const KEY = 'itemsearch';
const LABEL = '物品搜索动画';
const OUT = path.resolve(import.meta.dirname, '.itemsearch-check');
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
  const pngRequests = new Set();
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  page.on('response', (r) => {
    if (r.status() >= 400) bad404.push(r.status() + ' ' + r.url().slice(-70));
    const u = decodeURI(r.url());
    /* 序列帧的请求:dev 下是 /animations/animation_10/images/...,构建产物是 /assets/<hash>.png。
     * 两种形式都带「00000-00194」这段帧号,按它收集(不会把别的动画的图算进来)。
     * 只记 200 的 —— 浏览器对 SVG <image> 是**按需加载**的,停在哪一帧才会去取哪一张,
     * 所以「请求了多少张」不能当作验收标准,真正要断言的是「当前这一帧那张取到了」。 */
    if (r.status() === 200 && /00000-00194/.test(u) && /\.png(\?|$)/.test(u)) pngRequests.add(u.split('?')[0]);
  });

  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !document.getElementById('app-loading'), { timeout: 300_000, polling: 200 });
  await page.evaluate(() => document.querySelector('.rail-item[data-page="editor"]')?.click());
  await page.waitForFunction(() => {
    const layout = document.querySelector('.layout');
    return document.documentElement.dataset.page === 'editor' && !!layout && !layout.hidden;
  }, { timeout: 30_000, polling: 100 });
  await page.waitForFunction(() => document.getElementById('statusbar').textContent.includes('已载入'), { timeout: 120_000 });

  const options = await page.evaluate(() =>
    [...document.querySelectorAll('#selAnim option')].map((o) => ({ key: o.value, label: o.textContent })));
  console.log('[1] 注册表里的动画数:' + options.length);
  check(options.length === 10, '注册表里有 10 套动画', options.length);
  check(options.some((o) => o.key === KEY && o.label === LABEL), '列表里有「' + LABEL + '」且名字正确', options.find((o) => o.key === KEY));

  await page.evaluate(() => { window.__prevAnim = window.__anim; });
  await page.select('#selAnim', KEY);
  await page.waitForFunction((k) => document.getElementById('selAnim').value === k
    && window.__anim && window.__anim !== window.__prevAnim && window.__anim.isLoaded, { timeout: 180_000, polling: 200 }, KEY);
  await sleep(900);

  const info = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return el ? (el.hidden ? 'hidden' : 'visible') : 'missing'; };
    const d = window.__anim.animationData;
    return {
      sections: {
        timing: vis('timingSection'), theme: vis('themeSection'), mandelTheme: vis('mandelThemeSection'),
        image: vis('imageSection'), icon: vis('iconSection'), popup: vis('popupSection'), reward: vis('missionRewardSection'),
      },
      totalFrames: window.__anim.totalFrames,
      fr: window.__anim.frameRate,
      size: [d.w, d.h],
      layerCount: d.layers.length,
      topLayers: (d.layers || []).map((l) => ({ ind: l.ind, nm: l.nm, ty: l.ty, refId: l.refId })),
      precompAssets: (d.assets || []).filter((a) => Array.isArray(a.layers)).map((a) => String(a.id)),
      seqAssets: (d.assets || []).filter((a) => a.t === 'seq').length,
      numericAssets: (d.assets || []).filter((a) => typeof a.id === 'number').map((a) => a.id),
      imageAssets: (d.assets || []).filter((a) => typeof a.p === 'string' && a.t !== 'seq')
        .map((a) => ({ id: String(a.id), w: a.w, h: a.h, p: String(a.p), u: a.u, e: a.e, pr: a.pr })),
      seqSample: (d.assets || []).filter((a) => a.t === 'seq').slice(0, 2)
        .map((a) => ({ id: String(a.id), p: String(a.p), u: a.u, e: a.e, pr: a.pr })),
      textItems: [...document.querySelectorAll('#textList .t-name')].map((n) => n.textContent),
      textColors: document.querySelectorAll('#textList .t-color').length,
      shapeItems: [...document.querySelectorAll('#shapeList .t-name')].map((n) => n.textContent),
      shapeColorPickers: document.querySelectorAll('#shapeList input[type=color]').length,
      iconNames: [...document.querySelectorAll('#iconList .icon-name')].map((n) => n.textContent),
      iconCount: document.getElementById('iconCount')?.textContent ?? null,
      iconTabsHidden: document.getElementById('iconScopeTabs')?.hidden ?? null,
      triggerName: document.getElementById('animTriggerName').textContent,
      triggerCount: document.getElementById('animTriggerCount').textContent,
      triggerMeta: document.getElementById('animTriggerMeta').textContent,
      status: document.getElementById('statusbar').textContent,
      renderer: document.getElementById('selRenderer').value,
      infoText: document.getElementById('info')?.textContent ?? '',
    };
  });
  console.log('[2] ' + JSON.stringify(info, null, 1));
  check(info.totalFrames === 237, '总帧数 = 237', info.totalFrames);
  check(info.fr === 60, '帧率 = 60', info.fr);
  check(info.size[0] === 1920 && info.size[1] === 1080, '画布 1920×1080', info.size);
  check(info.triggerName === LABEL, '顶栏触发器显示新动画名', info.triggerName);
  check(info.triggerCount === '10 套', '顶栏总数 = 10 套', info.triggerCount);
  check(info.seqAssets === 195, '逐帧序列仍是 195 张', info.seqAssets);
  check(info.numericAssets.length === 0, '数值 id 的重复预合成已回收', info.numericAssets);
  const precompSet = new Set(info.precompAssets);
  check(['comp_0', 'comp_1', 'comp_2', 'sequence_0'].every((id) => precompSet.has(id)),
    'comp_0 / comp_1 / comp_2 / sequence_0 都在数据里', info.precompAssets);
  check(info.textItems.length === 1, '侧栏列出 1 个文字图层', info.textItems);
  check(info.textItems[0] === 'comp_1 › 非洲之心', '文字层名带预合成前缀且文案正确', info.textItems[0]);
  check(info.textColors === 1, '文字层有颜色选择器', info.textColors);
  check(info.shapeItems.length === 4, '「形状图层」列出 4 层(底框 + 物品颜色的三块)', info.shapeItems);
  check(info.shapeItems.includes('底部框框'), '底框在列表里', info.shapeItems);
  check(info.shapeItems.filter((n) => n.startsWith('comp_2 › ')).length === 3,
    'comp_2 里的三条物品颜色层都列出', info.shapeItems);
  check(info.shapeColorPickers >= 3, '物品颜色层有填充取色器', info.shapeColorPickers);
  check(info.sections.timing === 'hidden', '「动画时长」区块对这套动画隐藏(caps 为空)', info.sections.timing);
  check(info.sections.popup === 'hidden', '「弹窗叠加层」区块隐藏(没有独立弹窗)', info.sections.popup);
  check(info.sections.reward === 'hidden', '「报酬信息」区块隐藏(不是任务弹窗动画)', info.sections.reward);
  check(info.sections.image === 'hidden', '「图片图层」区块隐藏(位图只做图标/序列,没有可调色纹理)', info.sections.image);
  check(info.sections.icon === 'visible', '「图标选择」区块显示(单图标位)', info.sections.icon);
  check(info.iconTabsHidden === true, '单图标位:没有分段选项卡', info.iconTabsHidden);
  check(info.iconNames.length === 1, '图标候选只有那张单图(195 张序列帧不进列表)', info.iconNames);
  const iconAsset = info.imageAssets.find((a) => a.w === 286 && a.h === 300);
  check(!!iconAsset, '图标资源(286×300)在数据里', info.imageAssets);
  const bare = (p) => decodeURI(String(p || '').split('?')[0]);
  /* dev 下地址是 /animations/animation_10/images/____.png?no-inline,
   * 构建产物是 /assets/____-<hash>.png —— 两种都算「已改写成打包地址」*/
  check(!!iconAsset && /____(-[A-Za-z0-9_-]+)?\.png$/.test(bare(iconAsset.p)) && iconAsset.e === 1 && iconAsset.u === '',
    '图标资源已改写为打包地址(u 置空 / e 置 1)', iconAsset);
  check(!!iconAsset && iconAsset.pr === 'xMidYMid meet', '图标资源 pr = meet(上传窄长图不被裁)', iconAsset && iconAsset.pr);
  const bgAsset = info.imageAssets.find((a) => a.w === 1920 && a.h === 1080);
  check(!!bgAsset, '整幅斜条纹背景(1920×1080)在数据里', info.imageAssets);
  check(!!info.seqSample[0] && info.seqSample[0].e === 1 && /\.png$/.test(bare(info.seqSample[0].p)),
    '序列帧资源也走打包地址', info.seqSample[0]);

  /* 翻页书要逐帧换图:停在若干帧上,统计 <image> 是否都有真实 href(SVG 渲染路径) */
  const frameStats = await page.evaluate(async (frames) => {
    const out = [];
    for (const f of frames) {
      window.__anim.goToAndStop(f, true);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const svg = document.querySelector('#previewInner svg');
      const imgs = [...(svg?.querySelectorAll('image') ?? [])]
        .filter((im) => !im.closest('defs'))
        .map((im) => ({ href: (im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '').slice(-40), w: im.getAttribute('width') }));
      /* 当前这一帧到底在放序列里的哪一张:按「参与渲染(display 不是 none、opacity>0、有尺寸)」
       * 且文件名带帧号段筛出来 —— 翻页书每帧只该有**一条**这样的图。 */
      const shownSeq = [...(svg?.querySelectorAll('image') ?? [])]
        .filter((im) => !im.closest('defs'))
        .filter((im) => {
          const href = decodeURI(im.getAttribute('href') || '');
          if (!/00000-00194/.test(href)) return false;
          const cs = getComputedStyle(im);
          const r = im.getBoundingClientRect();
          return cs.display !== 'none' && +cs.opacity > 0.01 && r.width > 1;
        })
        .map((im) => (decodeURI(im.getAttribute('href') || '').split('?')[0]).split('/').pop() || '');
      out.push({ frame: f, images: imgs.length, real: imgs.filter((i) => !!i.href).length, shownSeq });
    }
    return out;
  }, [5, 40, 90, 130, 150, 180, 194, 220]);
  console.log('[3] 帧级渲染:' + JSON.stringify(frameStats.map((s) => ({ frame: s.frame, images: s.images, real: s.real, shownSeq: s.shownSeq }))));
  check(frameStats.every((s) => s.images > 0 && s.real === s.images), '每一帧都有真实图片地址(序列帧没有空白)', frameStats.map((s) => s.real));
  const shownNames = frameStats.flatMap((s) => s.shownSeq);
  /* 序列的白帧收尾在第 120~130 帧之间(实测 120 帧还在放大镜、130 帧已无内容),所以「序列段内」
   * 只取 ≤120 的停帧、「序列之后」取 ≥150 的停帧。 */
  const lensFrames = frameStats.filter((s) => s.frame <= 120);
  /* 只断言「序列段内每个停帧恰好有一条放大镜帧参与渲染」:
   * 第 130 帧之后那 195 条单帧图层的像素是全透明的(实测),但**元素是否还在 DOM 里、是否被
   * getComputedStyle 判为可见**取决于 lottie 的懒构建时机,dev 与构建产物下并不一致 ——
   * 那不是画面正确性的判据,所以不做「之后必须为 0」的断言。 */
  check(lensFrames.length > 0 && lensFrames.every((s) => s.shownSeq.length === 1),
    '序列段内的每个停帧恰好有一条「放大镜」帧参与渲染', lensFrames.map((s) => s.shownSeq.length));
  check(new Set(shownNames).size === shownNames.length, '各停帧显示序列里不同的一帧(翻页书真的在翻)', shownNames);

  await sleep(1500); // 让这些序列帧的请求落地
  /* 断言「当前帧显示的那张确实取到了」,而不是「一共请求了多少张」:
   * 浏览器对 SVG <image> 是按需加载的,dev 与构建产物下的预取行为不同(实测 dev 195 张、产物 70+ 张),
   * 拿总数当标准会随环境抖动,而"显示的这张有没有 200"才是画面正确性的判据(另有全量 404 检查兜底)。 */
  const requestedBases = new Set([...pngRequests].map((u) => u.split('/').pop() || ''));
  const missingShown = shownNames.filter((n) => !requestedBases.has(n));
  console.log('[4] 序列帧请求数:' + pngRequests.size + ' / 本页显示的 ' + shownNames.length + ' 张是否都已 200:' + (missingShown.length === 0));
  check(shownNames.length > 0 && missingShown.length === 0, '每张参与渲染的序列帧都以 200 取到(没有空白帧)', missingShown);
  check(bad404.length === 0, '没有任何 4xx/5xx 资源请求', bad404.slice(0, 5));
  check(!errors.some((e) => /animation|json|parse|undefined is not/i.test(e)), '页面没有脚本错误', errors.slice(0, 5));

  /* [6] 文字编辑 → 一键重置:验证编辑通道与 dropAnimDataCache 里为本套动画加的分支 */
  const readText = () => page.evaluate(() => {
    const d = window.__anim.animationData;
    const txt = [];
    const walk = (layers) => { for (const l of layers || []) { if (l.ty === 5) txt.push(l.t?.d?.k?.[0]?.s?.t); if (Array.isArray(l.layers)) walk(l.layers); } };
    walk(d.layers);
    for (const a of d.assets || []) if (Array.isArray(a.layers)) walk(a.layers);
    return [...new Set(txt)];
  });
  const readIconP = () => page.evaluate(() => {
    const d = window.__anim.animationData;
    const a = (d.assets || []).find((x) => x.w === 286 && x.h === 300 && typeof x.p === 'string');
    return a ? String(a.p) : '';
  });
  const textBefore = await readText();
  check(textBefore.join('|') === '非洲之心', '出厂文字是「非洲之心」', textBefore);
  await page.evaluate(() => {
    const ta = document.querySelector('#textList .t-input');
    ta.value = '测试物品';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(700);
  const textEdited = await readText();
  check(textEdited.includes('测试物品'), '在「文字图层」里改字会写进数据', textEdited);
  check(await page.evaluate(() => !document.getElementById('app-loading')), '改字没有把页面搞崩', null);

  /* [7] 上传自定义图标:走 applyIconUrlToScope 的 itemsearch 分支(写 comp_1 里那条资源) */
  const iconBeforeP = await readIconP();
  const uploadSrc = path.resolve(import.meta.dirname, '.itemsearch-upload-test.png');
  fs.copyFileSync(path.resolve(import.meta.dirname, '..', 'animations', 'animation_10', 'images', '____.png'), uploadSrc);
  const fileInput = await page.$('#iconFile');
  await fileInput.uploadFile(uploadSrc);
  await sleep(900);
  const iconAfterP = await readIconP();
  const uploadStatus = await page.evaluate(() => document.getElementById('statusbar').textContent);
  check(/^data:image\//.test(iconAfterP) && iconAfterP !== iconBeforeP,
    '上传自定义图标会写进图标资源(data URI)', { before: iconBeforeP.slice(-30), after: iconAfterP.slice(0, 30) });
  check(uploadStatus.includes('物品搜索动画'), '状态栏指明应用到了「物品搜索动画」', uploadStatus);

  /* [8] 一键重置:数据整份换回出厂(文字 / 图标一起回去) */
  await page.click('#btnResetAnim');
  await page.waitForFunction(() => /默认状态|已恢复/.test(document.getElementById('statusbar').textContent), { timeout: 120_000, polling: 200 });
  await sleep(1200);
  const afterReset = {
    text: await readText(),
    iconP: await readIconP(),
    iconNames: await page.evaluate(() => [...document.querySelectorAll('#iconList .icon-name')].map((n) => n.textContent)),
    status: await page.evaluate(() => document.getElementById('statusbar').textContent),
  };
  console.log('[8] 一键重置后:' + JSON.stringify(afterReset));
  check(afterReset.text.join('|') === '非洲之心', '一键重置把文字换回出厂值', afterReset.text);
  check(/____(-[A-Za-z0-9_-]+)?\.png/.test(decodeURI(afterReset.iconP.split('?')[0])), '一键重置把图标换回出厂那张', afterReset.iconP);
  check(afterReset.iconNames.length === 1, '重置后「图标选择」列表仍是那一张', afterReset.iconNames);
  fs.rmSync(uploadSrc, { force: true });

  const poster = path.resolve(import.meta.dirname, '..', 'posters', 'itemsearch.webp');
  check(fs.existsSync(poster) && fs.statSync(poster).size > 1024, '画廊封面 posters/itemsearch.webp 已生成',
    fs.existsSync(poster) ? fs.statSync(poster).size : 'missing');

  /* 画廊卡片:用动画画廊的搜索定位到这一项,确认卡片上有编号 #010 */
  const gallery = await page.evaluate(async (label) => {
    document.getElementById('animTrigger')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const cards = [...document.querySelectorAll('.ap-card')].map((c) => ({
      label: c.querySelector('.ap-card-name')?.textContent?.trim() ?? '',
      no: c.querySelector('.ap-card-no')?.textContent?.trim() ?? '',
      poster: c.querySelector('.ap-card-cover img')?.getAttribute('src') ?? '',
    }));
    return cards.filter((c) => c.label.includes(label.slice(0, 2)));
  }, LABEL);
  console.log('[5] 画廊卡片:' + JSON.stringify(gallery));
  check(gallery.some((c) => c.label === LABEL && c.no.includes('010')), '画廊里有这张卡片且编号 #010', gallery);
  check(gallery.some((c) => c.poster && /itemsearch/.test(c.poster)), '卡片封面指向 itemsearch.webp', gallery.map((c) => c.poster));

  await page.screenshot({ path: path.join(OUT, 'editor.png') });
  console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
