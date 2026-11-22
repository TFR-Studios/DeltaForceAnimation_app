/* UI 图标提取页回归(常驻,不参与构建):
 *   node tools/verify-icons.mjs [--url http://127.0.0.1:5173/]
 *
 * 用注入的假 dfaeIcons 桥跑完整 UI(不需要装游戏):
 *   · 无桥(纯浏览器)时整页退化为"仅桌面可用"空状态;
 *   · 有桥:游戏目录条 / 索引卡片 / 扫描进度 / 搜索与分组 / 网格懒加载预览 /
 *     染色切换 / 详情面板 / 单个导出与批量导出(结果卡 + 打开文件夹 + 再试一次)。
 * 预览字节用脚本内嵌的最小 PNG;导出结果由假桥固定返回。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:5173/');
const OUT = arg('out', 'release/icons-verify');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
let failures = 0;
const check = (n, ok, extra = '') => { if (!ok) failures++; out.push((ok ? 'PASS ' : 'FAIL ') + n + (extra ? '  -> ' + extra : '')); };
fs.mkdirSync(OUT, { recursive: true });

const FAKE_ICONS = () => {
  /* 1x1 透明 PNG(手工构造的最小合法文件)。注意:必须定义在注入函数**内部**,
   * evaluateOnNewDocument 只序列化函数本体,外部闭包变量在页面里不存在。 */
  const TINY_PNG = Uint8Array.from(atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  ), (c2) => c2.charCodeAt(0));
  /* 名称首段即分类：Alpha_Icon_001 → Alpha。260 个 = Alpha 87 / Beta 87 / Gamma 86。 */
  const CATS = ['Alpha', 'Beta', 'Gamma'];
  const ITEMS = Array.from({ length: 260 }, (_, i) => {
    const cat = CATS[i % 3];
    const n = String(i + 1).padStart(3, '0');
    return {
      id: 'UI/UIAtlas/Fake/BakedSprite/' + cat + '_Icon_' + n,
      name: cat + '_Icon_' + n,
      group: 'Fake/Group' + (1 + (i % 3)),
      cat,
      vpath: '../../../DeltaForce/Content/UI/UIAtlas/Fake/BakedSprite/' + cat + '_Icon_' + n,
      pak: 'pak-0-0-fake-WindowsClient.pak',
      uv: [64, 64], dim: [256, 256],
      atlas: 'UI/UIAtlas/Fake/BakedTexture/Fake.uasset',
      hd: i % 17 === 0,
    };
  });
  let calls = { preview: 0, export: 0, search: 0 };
  window.__iconCalls = calls;
  window.dfaeIcons = {
    isDesktop: true,
    detectGameDir: async () => ({ ok: true, dir: 'J:\\WeGameApps\\rail_apps\\DeltaForce(2001918)', source: '常见安装位置' }),
    getGameDir: async () => ({ dir: 'J:\\WeGameApps\\rail_apps\\DeltaForce(2001918)', valid: true }),
    pickGameDir: async () => ({ ok: true, valid: true, dir: 'J:\\fake', pakCount: 3 }),
    setGameDir: async () => ({ ok: true, valid: true, pakCount: 3 }),
    getIndexState: async () => ({
      ready: !!window.__iconIndexReady, count: window.__iconIndexReady ? ITEMS.length : 0,
      builtAt: window.__iconIndexReady ? 1700000000000 : 0, stale: false,
      gameDir: 'J:\\fake',
    }),
    buildIndex: async () => {
      for (const p of [10, 50, 100]) window.__iconProgress && window.__iconProgress({ phase: 'pak', done: p, total: 100, detail: 'fake.pak' });
      window.__iconIndexReady = true;
      return { ok: true, count: ITEMS.length, stats: { parseErrors: 0, hdCount: 15 } };
    },
    onIndexProgress: (cb) => { window.__iconProgress = cb; return () => { window.__iconProgress = null; }; },
    search: async (opts) => {
      calls.search++;
      const q = (opts.query || '').toLowerCase();
      const cat = opts.cat || 'all';
      let list = ITEMS.filter((it) => (!q || it.name.toLowerCase().includes(q)) && (cat === 'all' || it.cat === cat));
      return { total: list.length, items: list.slice(opts.offset || 0, (opts.offset || 0) + (opts.limit || 120)) };
    },
    getCategories: async () => {
      return { items: CATS.map((cat) => ({ key: cat, label: cat, count: ITEMS.filter((i) => i.cat === cat).length })) };
    },
    preview: async (opts) => {
      calls.preview++;
      await new Promise((r) => setTimeout(r, 15));
      // 专项覆盖:图集空白 / 渲染失败 两种占位
      if (String(opts.id).endsWith('_Icon_003')) return { ok: false, blank: true, error: '该图标在图集中是空白区域' };
      if (String(opts.id).endsWith('_Icon_004')) return { ok: false, error: '假桥注入的渲染失败' };
      return { ok: true, data: TINY_PNG, width: 256, height: 256 };
    },
    exportIcons: async (opts) => {
      calls.export++;
      const n = (opts.ids || []).length;
      if (window.__iconExportFail) return { ok: false, saved: 0, failed: n, error: '假桥注入的失败', errors: ['假桥注入的失败'] };
      return { ok: true, saved: n, failed: 0, outDir: 'C:\\fake\\DFAE-Icons', tint: opts.tint || 'none' };
    },
    getExportDir: async () => ({ dir: 'C:\\fake\\DFAE-Icons' }),
    pickExportDir: async () => ({ ok: true, dir: 'C:\\fake\\DFAE-Icons2' }),
  };
  window.dfaeDesktop = { isDesktop: true, revealFile: async () => true };
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'] });

async function openPage(opts = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  if (opts.bridge) await page.evaluateOnNewDocument(FAKE_ICONS);
  await page.goto(BASE + '?view=home', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  return { page, errors };
}

try {
  /* ---------- 1) 无桥:纯浏览器空状态 ---------- */
  {
    const { page, errors } = await openPage({ bridge: false });
    await page.evaluate(() => document.querySelector('#navIcons')?.click());
    await sleep(500);
    const hiddenOrEmpty = await page.evaluate(() => {
      const el = document.querySelector('#iconsMount');
      if (!el) return { mounted: false };
      return { mounted: true, unavailable: !!el.querySelector('.icons-page--unavailable'), text: (el.textContent || '').slice(0, 40) };
    });
    check('无桥时导航可进入图标页', hiddenOrEmpty.mounted);
    check('无桥显示"仅桌面可用"空状态', hiddenOrEmpty.unavailable, JSON.stringify(hiddenOrEmpty).slice(0, 80));
    check('无桥页面无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }

  /* ---------- 2) 有桥:完整 UI ---------- */
  {
    const { page, errors } = await openPage({ bridge: true });
    await page.evaluate(() => document.querySelector('#navIcons')?.click());
    await sleep(600);
    const shell = await page.evaluate(() => {
      const root = document.querySelector('#iconsMount .icons-page');
      return {
        mounted: !!root,
        dirText: root?.querySelector('[data-role="dirText"]')?.textContent || '',
        hasIndexCard: !!root?.querySelector('[data-role="indexCard"]'),
        buildBtn: !!root?.querySelector('[data-index-action="build"]'),
        searchInput: !!root?.querySelector('[data-role="iconSearch"]'),
      };
    });
    check('有桥页面骨架渲染', shell.mounted && shell.searchInput, JSON.stringify(shell).slice(0, 120));
    check('目录条显示游戏目录', (shell.dirText || '').includes('DeltaForce(2001918)'), shell.dirText);

    /* 扫描索引 */
    await page.evaluate(() => document.querySelector('[data-index-action="build"]')?.click());
    await sleep(900);
    const afterBuild = await page.evaluate(() => ({
      title: document.querySelector('[data-role="indexCard"] .icons-index-title')?.textContent || '',
      gridCells: document.querySelectorAll('.icons-cell').length,
      count: document.querySelector('[data-role="count"]')?.textContent || '',
      pagination: document.querySelector('.icons-pagination')?.textContent || '',
      pageBtns: Array.from(document.querySelectorAll('.icons-pagebtn[data-page-to]')).map((b) => b.textContent),
    }));
    check('扫描后索引卡片就绪', /索引就绪/.test(afterBuild.title) && /260/.test(afterBuild.title), afterBuild.title);
    check('扫描后网格有内容(第一页 120 个)', afterBuild.gridCells === 120, String(afterBuild.gridCells));
    check('计数显示总数', /共 260 个/.test(afterBuild.count), afterBuild.count);
    check('底部出现页码条', /第 1 \/ 3 页/.test(afterBuild.pagination), afterBuild.pagination.slice(0, 60));
    check('页码按钮 1..3', JSON.stringify(afterBuild.pageBtns) === JSON.stringify(['1', '2', '3']), JSON.stringify(afterBuild.pageBtns));

    /* 翻页:第 2 页 / 下一页 / 最后一页 / 上一页 */
    await page.evaluate(() => document.querySelector('.icons-pagebtn[data-page-to="2"]')?.click());
    await sleep(500);
    const page2 = await page.evaluate(() => ({
      first: document.querySelector('.icons-cell .icons-cell-name')?.textContent || '',
      cells: document.querySelectorAll('.icons-cell').length,
      info: document.querySelector('.icons-pagination-info')?.textContent || '',
      current: document.querySelector('.icons-pagebtn.is-current')?.textContent || '',
    }));
    check('点第 2 页载入第 121 个起', page2.first === 'Alpha_Icon_121' && page2.cells === 120, JSON.stringify(page2).slice(0, 120));
    check('页码条显示第 2 / 3 页', /第 2 \/ 3 页/.test(page2.info) && page2.current === '2', page2.info);
    await page.evaluate(() => document.querySelector('.icons-pagebtn[data-page-step="1"]')?.click());
    await sleep(500);
    const lastPage = await page.evaluate(() => ({
      cells: document.querySelectorAll('.icons-cell').length,
      info: document.querySelector('.icons-pagination-info')?.textContent || '',
      nextDisabled: !!document.querySelector('.icons-pagebtn[data-page-step="1"]')?.disabled,
    }));
    check('末页只剩 20 个且「下一页」禁用', lastPage.cells === 20 && lastPage.nextDisabled && /第 3 \/ 3 页/.test(lastPage.info), JSON.stringify(lastPage));
    await page.evaluate(() => document.querySelector('.icons-pagebtn[data-page-step="-1"]')?.click());
    await sleep(500);
    const page2b = await page.evaluate(() => document.querySelector('.icons-pagination-info')?.textContent || '');
    check('「上一页」回到第 2 页', /第 2 \/ 3 页/.test(page2b), page2b);
    await page.evaluate(() => document.querySelector('.icons-pagebtn[data-page-to="1"]')?.click());
    await sleep(500);

    /* 预览懒加载 */
    await sleep(700);
    const previews = await page.evaluate(() => ({
      previewed: document.querySelectorAll('.icons-cell.is-previewed').length,
      imgs: document.querySelectorAll('.icons-cell img').length,
    }));
    check('可视区图标完成预览渲染', previews.previewed > 0 && previews.imgs > 0, JSON.stringify(previews));
    const previewCalls = await page.evaluate(() => window.__iconCalls.preview);
    check('预览请求走的是主进程桥', previewCalls > 0, String(previewCalls));
    const fallbacks = await page.evaluate(() => ({
      blank: document.querySelectorAll('.icons-cell.is-preview-blank').length,
      failed: document.querySelectorAll('.icons-cell.is-preview-failed').length,
      blankText: document.querySelector('.icons-cell.is-preview-blank .icons-thumb-fallback')?.textContent || '',
      failedText: document.querySelector('.icons-cell.is-preview-failed .icons-thumb-fallback')?.textContent || '',
    }));
    check('空白图标显示「空白」占位', fallbacks.blank >= 1 && fallbacks.blankText === '空白', JSON.stringify(fallbacks));
    check('渲染失败显示「无图」占位', fallbacks.failed >= 1 && fallbacks.failedText === '无图', JSON.stringify(fallbacks));

    /* 搜索过滤 */
    await page.type('[data-role="iconSearch"]', 'Icon_00');
    await sleep(900);
    const searched = await page.evaluate(() => ({
      cells: document.querySelectorAll('.icons-cell').length,
      count: document.querySelector('[data-role="count"]')?.textContent || '',
      info: document.querySelector('.icons-pagination-info')?.textContent || '',
    }));
    check('关键词过滤生效(9 个,单页)', searched.cells === 9 && /9 个/.test(searched.count) && /第 1 \/ 1 页/.test(searched.info), JSON.stringify(searched));
    await page.evaluate(() => { const i = document.querySelector('[data-role="iconSearch"]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(800);

    /* 详情面板 + 导出单张 */
    await page.evaluate(() => document.querySelector('.icons-cell')?.click());
    await sleep(400);
    const detail = await page.evaluate(() => ({
      visible: !document.querySelector('[data-role="detail"]')?.hidden,
      title: document.querySelector('.icons-detail-title')?.textContent || '',
      hasExport: !!document.querySelector('[data-role="exportOne"]'),
      img: !!document.querySelector('[data-role="detailImg"] img'),
    }));
    check('点选图标打开详情面板', detail.visible && !!detail.title, JSON.stringify(detail).slice(0, 120));
    check('详情面板有大图', detail.img);
    await page.evaluate(() => document.querySelector('[data-role="exportOne"]')?.click());
    await sleep(700);
    const singleExport = await page.evaluate(() => ({
      result: document.querySelector('[data-role="resultCard"]')?.textContent || '',
      visible: !document.querySelector('[data-role="resultCard"]')?.hidden,
      reveal: !!document.querySelector('[data-result-action="reveal"]'),
    }));
    check('单张导出出现成功结果卡', singleExport.visible && /已导出 1 个/.test(singleExport.result), JSON.stringify(singleExport).slice(0, 140));
    check('结果卡带「打开文件夹」', singleExport.reveal);

    /* 失败路径:再试一次 */
    await page.evaluate(() => { window.__iconExportFail = true; document.querySelector('[data-result-action="reveal"]'); });
    await page.evaluate(() => document.querySelector('[data-role="exportOne"]')?.click());
    await sleep(700);
    const failCase = await page.evaluate(() => ({
      text: document.querySelector('[data-role="resultCard"]')?.textContent || '',
      retry: !!document.querySelector('[data-result-action="retry"]'),
    }));
    check('导出失败显示原因卡', /导出失败/.test(failCase.text) && /假桥注入的失败/.test(failCase.text), failCase.text.slice(0, 100));
    check('失败卡带「再试一次」', failCase.retry);
    await page.evaluate(() => { window.__iconExportFail = false; document.querySelector('[data-result-action="retry"]')?.click(); });
    await sleep(700);
    const retried = await page.evaluate(() => document.querySelector('[data-role="resultCard"]')?.textContent || '');
    check('「再试一次」走同一批导出', /已导出 1 个/.test(retried), retried.slice(0, 60));

    /* 染色切换:清空预览后重新渲染 */
    const beforeTint = await page.evaluate(() => window.__iconCalls.preview);
    await page.select('[data-role="iconTint"]', 'silver');
    await sleep(900);
    const afterTint = await page.evaluate(() => ({
      calls: window.__iconCalls.preview,
      previewed: document.querySelectorAll('.icons-cell.is-previewed').length,
    }));
    check('染色切换触发重新预览', afterTint.calls > beforeTint, beforeTint + '→' + afterTint.calls);
    check('染色后预览重新渲染', afterTint.previewed > 0, String(afterTint.previewed));

    /* 分组筛选 */
    const groupOpts = await page.evaluate(() => {
      const sel = document.querySelector('[data-role="iconCat"]');
      return { n: sel ? sel.options.length : 0, first: sel && sel.options[1] ? sel.options[1].value : '' };
    });
    check('分类下拉有数据(按名称)', groupOpts.n >= 2, JSON.stringify(groupOpts));
    await page.evaluate(() => { const s = document.querySelector('[data-role="iconCat"]'); s.value = s.options[1].value; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(800);
    const grouped = await page.evaluate(() => document.querySelector('[data-role="count"]')?.textContent || '');
    check('按名称分类筛选生效', /个/.test(grouped) && !/260 个/.test(grouped) && /当前分类/.test(grouped), grouped);

    /* 批量导出当前筛选 */
    const exportBtn = await page.evaluate(() => !!document.querySelector('[data-role="exportFiltered"]'));
    check('批量导出按钮存在', exportBtn);
    await page.evaluate(() => document.querySelector('[data-role="exportFiltered"]')?.click());
    await sleep(1200);
    const batch = await page.evaluate(() => ({
      text: document.querySelector('[data-role="resultCard"]')?.textContent || '',
      exportCalls: window.__iconCalls.export,
    }));
    check('批量导出结果卡就绪', /已导出 \d+ 个 PNG/.test(batch.text) || /已导出/.test(batch.text), JSON.stringify(batch).slice(0, 140));
    const exportCalls = await page.evaluate(() => window.__iconCalls.export);
    check('批量导出按批调用主进程', exportCalls >= 2, String(exportCalls));

    /* 切页不销毁:去主页再回来,预览与列表还在 */
    await page.evaluate(() => document.querySelector('[data-page="home"]')?.click());
    await sleep(400);
    await page.evaluate(() => document.querySelector('#navIcons')?.click());
    await sleep(600);
    const back = await page.evaluate(() => ({
      cells: document.querySelectorAll('.icons-cell').length,
      imgs: document.querySelectorAll('.icons-cell img').length,
    }));
    check('切页往返后列表不销毁', back.cells > 0, JSON.stringify(back));
    check('往返后无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));

    await page.screenshot({ path: path.join(OUT, 'icons-page.png'), fullPage: false });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(out.join('\n'));
console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exitCode = failures === 0 ? 0 : 1;
