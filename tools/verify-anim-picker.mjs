/*
 * 动画选择器(顶栏触发器 + 画廊浮层)的端到端验证。
 *
 * 覆盖:触发器内容 → 画廊开关 → 卡片生成 → 搜索 → 数字键直选 → 键盘导航 →
 *       鼠标跟随光标 → 滚轮转发 → 选完焦点交还 → 点卡片切换 → 隐藏 select 兼容层 → 窄屏。
 * 另外会断言「分组筛选 / 收藏 / 简介」这三块确实已经不存在(它们是有意去掉的,
 * 如果哪天又被加回来,这里的检查会红,提醒同步更新 README 与样式)。
 *
 * 用法(需要 dev server 已在 5173 上运行):
 *   npm run dev
 *   node tools/verify-anim-picker.mjs
 * 也可以指向生产构建产物:
 *   npm run preview
 *   $env:DEV_ORIGIN='http://127.0.0.1:4173'; node tools/verify-anim-picker.mjs
 *
 * 截图在跑完后统一写入 tools/anim-picker-*.png。
 * 注意:不能边跑边写文件 —— dev server 的文件监听会把「项目里多了个文件」当成变更,
 * 给页面发一次 full-reload,把正在跑的验证打断。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.DEV_ORIGIN || 'http://127.0.0.1:5173';
const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = [];
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  out.push((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : ''));
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
await page.setViewport({ width: 1600, height: 950 });
await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction(() => !document.getElementById('app-loading'), { timeout: 300_000, polling: 200 });
await page.waitForFunction(() => window.__anim && window.__anim.isLoaded, { timeout: 300_000, polling: 150 });
/* 应用外壳默认落在主页(#viewHome),动画选择器在编辑器页 —— 不先切过去的话
 * #animTrigger 的排版尺寸是 0×0,下面的 page.click 会直接以
 * "Node is either not clickable or not an Element" 崩掉(整份回归失效)。
 * 切页走导航轨上的编辑器项,与用户手动进入编辑器的路径一致。 */
await page.evaluate(() => {
  const item = document.querySelector('.rail-item[data-page="editor"]');
  if (item instanceof HTMLElement) item.click();
});
await page.waitForFunction(() => document.documentElement.dataset.page === 'editor', { timeout: 30_000, polling: 100 });
await sleep(500);

const shots = [];
/* 关闭画廊是先播 140ms 退场动画、再由定时器设 hidden(见 main.ts closeAnimPicker),
 * 所以任何"关掉之后"的断言都必须等 hidden 真正落下来,不能立刻读。 */
const waitPickerHidden = () => page.waitForFunction(
  () => document.getElementById('animPicker').hidden,
  { timeout: 5000, polling: 30 },
).catch(() => {});
const galleryState = () => page.evaluate(() => ({
  open: !document.getElementById('animPicker').hidden,
  expanded: document.getElementById('animTrigger').getAttribute('aria-expanded'),
  cards: [...document.querySelectorAll('.ap-card')].map((c) => c.dataset.key),
  nums: [...document.querySelectorAll('.ap-card-num')].map((n) => n.textContent),
  /* 唯一编号:卡片名称行右侧那串 #001(dataset.no 与文本同源,这里两个都读,
   * 顺带验证"属性和显示文本一致") */
  nos: [...document.querySelectorAll('.ap-card')].map((c) => c.dataset.no ?? ''),
  noTexts: [...document.querySelectorAll('.ap-card-no')].map((n) => n.textContent),
  searching: document.getElementById('animGrid').classList.contains('is-searching'),
  current: document.querySelector('.ap-card.is-current')?.dataset.key ?? '',
  focused: document.activeElement?.id || document.activeElement?.tagName || '',
}));
/* 切到某个 key 并等它真的载入(状态栏会写「已载入: <名字>」) */
const waitLoaded = (key) => page.waitForFunction(
  (k) => document.getElementById('selAnim').value === k
    && /已载入/.test(document.getElementById('statusbar').textContent || ''),
  { timeout: 300_000, polling: 200 }, key);

/* ---------- 1. 顶栏触发器 ---------- */
const total = await page.evaluate(() => document.querySelectorAll('#selAnim option').length);
const trig = await page.evaluate(() => ({
  name: document.getElementById('animTriggerName').textContent,
  meta: document.getElementById('animTriggerMeta').textContent,
  count: document.getElementById('animTriggerCount').textContent,
  imgs: document.querySelectorAll('.anim-trigger img').length,
  expanded: document.getElementById('animTrigger').getAttribute('aria-expanded'),
}));
check('触发器显示当前动画名', trig.name === '撤离动画', JSON.stringify(trig));
check('触发器显示分辨率/帧率', /1920×1080.*60fps/.test(trig.meta), trig.meta);
/* 编号排在规格最前(#001 · 1920×1080 · 60fps),与画廊卡片上写的是同一串 */
check('触发器显示当前动画编号', /^#\d{3,} · /.test(trig.meta), trig.meta);
check('触发器显示动画总数', trig.count === total + ' 套', trig.count);
/* 触发器上的 30×22 缩略图是更早一版移除的(顶栏改成"名称 + 规格 + 总数"三件事一行读完)。
 * 这条断言原来读 #animTriggerThumb,元素没了之后脚本直接在 getAttribute 上空指针崩掉,
 * 整份回归失效 —— 现在改成"触发器里不该再有 img",把移除这件事本身当成不变量。 */
check('触发器不再带缩略图(有意移除,不是丢失)', trig.imgs === 0, trig.imgs);
check('初始 aria-expanded=false', trig.expanded === 'false');

/* ---------- 2. 打开画廊:卡片与「已去掉的三个东西」 ---------- */
await page.click('#animTrigger');
await sleep(400);
let st = await galleryState();
const extras = await page.evaluate(() => ({
  removed: document.querySelectorAll('.ap-chip, .ap-filters, .ap-card-star, .ap-card-desc, .is-pinned').length,
  covers: [...document.querySelectorAll('.ap-card-cover img')].filter((i) => i.naturalWidth > 0).length,
  sub: document.getElementById('animPickerSub').textContent,
  starHint: document.querySelectorAll('.ap-hint-fav').length,
}));
check('点触发器打开画廊', st.open && st.expanded === 'true');
check('卡片数量 = 动画数量', st.cards.length === total, st.cards.length + ' vs ' + total);
/* galleryState().current 是卡片的 data-key(不是中文名);「唯一」= 恰好一张带 is-current */
const currentCount = await page.evaluate(() => document.querySelectorAll('.ap-card.is-current').length);
check('当前动画带「当前」角标且唯一',
  st.current === 'extraction' && st.cards.length === total && currentCount === 1,
  st.current + ' ×' + currentCount);
check('封面图全部加载成功', extras.covers === total, extras.covers + '/' + total);
check('搜索框自动获得焦点', st.focused === 'animSearch', String(st.focused));
check('卡片带数字键序号角标', st.nums.length === Math.min(9, total), st.nums.join(','));
/* 唯一编号:每张卡片都有,格式 #001,且互不重复、与 dataset.no 一致。
 * 这是「快速管理」的底座 —— 编号一旦重复或缺失,对号就失去意义。 */
const nosUnique = st.nos.length === total && new Set(st.nos).size === total;
check('每张卡片都带唯一编号',
  nosUnique && st.nos.every((n) => /^#\d{3,}$/.test(n)) && st.nos.every((n, i) => n === st.noTexts[i]),
  st.nos.join(','));
/* 首次打开没有「最近使用」干扰(puppeteer 每次都是干净的临时 profile),顺序 = 注册表顺序,
 * 所以编号必须单调递增。这里刻意不写死 1..N —— 增删一套动画时这条不该红。 */
const noValues = st.nos.map((n) => Number(n.slice(1)));
check('编号按注册表顺序递增(未使用前)',
  noValues.every((v, i) => i === 0 || v > noValues[i - 1]),
  st.nos.join(','));
const cardTip = await page.evaluate(() => document.querySelector('.ap-card-pick').title);
check('卡片悬停提示带编号', /编号 #\d{3,}/.test(cardTip), cardTip);
check('分组筛选 / 收藏 / 简介均已移除', extras.removed === 0 && extras.starHint === 0, String(extras.removed));
shots.push({ name: 'anim-picker-gallery', data: await page.screenshot({ encoding: 'base64' }) });

/* ---------- 3. 搜索 ---------- */
await page.type('#animSearch', '扫描');
await sleep(250);
st = await galleryState();
check('搜索「扫描」只留位置暴露动画',
  st.cards.length === 1 && st.current !== undefined
  && (await page.evaluate(() => document.querySelector('.ap-card-name').textContent)) === '位置暴露动画',
  JSON.stringify(st.cards));
check('搜索态隐藏序号角标', st.searching && st.nums.length === 0, JSON.stringify({ searching: st.searching, nums: st.nums }));
await page.evaluate(() => { const i = document.getElementById('animSearch'); i.value = 'zzz'; i.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(200);
st = await page.evaluate(() => ({
  cards: document.querySelectorAll('.ap-card').length,
  empty: !document.getElementById('animEmpty').hidden,
  hint: document.getElementById('animEmptyText').textContent,
}));
check('无匹配时显示空状态', st.cards === 0 && st.empty && st.hint.includes('zzz'), JSON.stringify(st));
await page.click('#animSearchClear');
await sleep(200);
check('清空搜索后恢复全部卡片',
  (await page.evaluate(() => document.querySelectorAll('.ap-card').length)) === total);

/* 按编号搜索:界面上写的是 #003,但三种写法都得认(3 / 003 / #003)——
 * 有人按号记、有人按显示文本抄。搜索态下位置序号角标会隐藏,编号必须还在,
 * 否则"搜出来对不上号"。 */
const searchNo = async (text) => {
  await page.evaluate((v) => {
    const i = document.getElementById('animSearch');
    i.value = v;
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(200);
  return page.evaluate(() => ({
    cards: [...document.querySelectorAll('.ap-card')].map((c) => c.dataset.key),
    nos: [...document.querySelectorAll('.ap-card-no')].map((n) => n.textContent),
    nums: document.querySelectorAll('.ap-card-num').length,
    searching: document.getElementById('animGrid').classList.contains('is-searching'),
  }));
};
for (const q of ['3', '003', '#003']) {
  const hit = await searchNo(q);
  check('按编号搜索「' + q + '」只留 3 号动画',
    hit.cards.length === 1 && hit.cards[0] === 'blinds' && hit.nos.join('') === '#003',
    JSON.stringify(hit.cards) + ' / ' + hit.nos.join(','));
}
const searchingHit = await searchNo('003');
check('搜索态下编号仍然显示(只是位置序号隐藏)',
  searchingHit.searching && searchingHit.nos.length === 1 && searchingHit.nums === 0,
  JSON.stringify(searchingHit));
await page.click('#animSearchClear');
await sleep(200);

/* ---------- 4. 数字键直选 ---------- */
const beforeKey = await page.evaluate(() => document.getElementById('selAnim').value);
/* 卡片上的数字角标与卡片位置一一对应(位置 1 = 角标 1),所以按 '2' 应当切到**第二张**卡片。
 * 这里直接取位置 2 的 key,并顺带断言它的角标确实是 '2' —— 角标一旦与位置脱节,后一条会红。
 * (旧写法是"先看第一个角标是不是 2、再取第二张的 key",角标恒为 1 时取到空串,
 *  waitLoaded('') 会一直等到超时;那段是从"序号不跟位置走"的旧实现留下来的。) */
const numTarget = await page.evaluate(() => {
  const card = document.querySelectorAll('.ap-card')[1];
  return card ? {
    key: card.dataset.key,
    num: (card.querySelector('.ap-card-num') || {}).textContent,
    no: (card.querySelector('.ap-card-no') || {}).textContent,
  } : null;
});
check('第二张卡片的角标是 2', !!numTarget && numTarget.num === '2', JSON.stringify(numTarget));
const numKey = numTarget ? numTarget.key : '';
await page.keyboard.press('2');
await waitLoaded(numKey);
await waitPickerHidden();
await sleep(500);
st = await page.evaluate(() => {
  const dt = [...document.querySelectorAll('#infoList dt')].find((d) => d.textContent === '编号');
  return {
    key: document.getElementById('selAnim').value,
    open: !document.getElementById('animPicker').hidden,
    name: document.getElementById('animTriggerName').textContent,
    meta: document.getElementById('animTriggerMeta').textContent,
    infoNo: dt && dt.nextElementSibling ? dt.nextElementSibling.textContent : '',
  };
});
check('数字键 2 直接切换到第二张卡片', st.key === numKey && st.key !== beforeKey,
  st.key + ' (第一张是 ' + beforeKey + ')');
check('数字键切换后画廊关闭且触发器同步', !st.open && st.name.length > 0, JSON.stringify(st));
/* 切过去之后,编号在三处必须同时跟着换:顶栏规格行、侧栏「动画信息」第一行。
 * 只在一处对不上,用户就会以为自己切错了套。 */
check('切换后顶栏规格行换成目标卡片编号',
  st.meta.startsWith((numTarget?.no ?? '?') + ' · '), st.meta + ' vs ' + (numTarget?.no ?? '?'));
check('侧栏「动画信息」显示同一串编号', st.infoNo === (numTarget?.no ?? '?'),
  st.infoNo + ' vs ' + (numTarget?.no ?? '?'));

/* 搜索框有内容时,数字还给搜索框 */
/* 触发器的点击是「开/关」切换,所以先确认画廊确实关着再点,免得把刚打开的面板又关掉;
 * 点完等面板真的可见(而不是固定 sleep)再往下走 —— 上一套动画刚切完时页面还在重建,
 * 固定睡眠偶尔会抢在面板渲染之前(搜索框还是 display:none,typings 会打空)。 */
if (await page.evaluate(() => !document.getElementById('animPicker').hidden)) {
  await page.keyboard.press('Escape');
  await waitPickerHidden();
}
await page.click('#animTrigger');
await page.waitForFunction(() => !document.getElementById('animPicker').hidden, { timeout: 30_000, polling: 100 });
await sleep(200);
const keyBeforeType = await page.evaluate(() => document.getElementById('selAnim').value);
/* 数字直选的判据是「搜索框为空」:先敲一个字母让查询非空,再按数字,数字才应该进搜索框。
 * (直接往空框里按数字,按设计就是快捷键,会因为 preventDefault 而一个字符都进不去 ——
 *  这里要验的正是"已有内容之后数字还给搜索框",所以必须先有一个字母。) */
await page.type('#animSearch', 'a');
await page.waitForFunction(() => document.getElementById('animSearch').value === 'a', { timeout: 30_000, polling: 100 });
await page.keyboard.press('1');
await page.waitForFunction(() => document.getElementById('animSearch').value === 'a1', { timeout: 30_000, polling: 100 });
await sleep(250);
st = await page.evaluate(() => ({
  query: document.getElementById('animSearch').value,
  key: document.getElementById('selAnim').value,
  open: !document.getElementById('animPicker').hidden,
}));
check('搜索框已有内容时数字键不再直选', st.query === 'a1' && st.key === keyBeforeType && st.open,
  JSON.stringify(st));
/* 「清空搜索」按钮只在搜索框有内容时显示,先等它可点再点(同理,别跟固定 sleep 赌时序) */
await page.waitForFunction(() => {
  const c = document.getElementById('animSearchClear');
  return !!c && !c.hidden && c.getBoundingClientRect().width > 0;
}, { timeout: 30_000, polling: 100 });
await page.click('#animSearchClear');
await sleep(200);

/* ---------- 5. 键盘导航 ---------- */
await page.keyboard.press('Escape');
await waitPickerHidden();
st = await galleryState();
check('Esc 关闭画廊', !st.open && st.expanded === 'false', JSON.stringify(st));

await page.keyboard.press('/');
await sleep(300);
check('斜杠打开画廊', (await galleryState()).open);

const keyOnOpen = await page.evaluate(() => document.querySelector('.ap-card.is-cursor')?.dataset.key);
await page.keyboard.press('ArrowRight');
await sleep(150);
const keyAfterArrow = await page.evaluate(() => document.querySelector('.ap-card.is-cursor')?.dataset.key);
check('方向键移动卡片光标', !!keyAfterArrow && keyAfterArrow !== keyOnOpen, keyOnOpen + ' → ' + keyAfterArrow);
await page.keyboard.press('Enter');
await waitLoaded(keyAfterArrow);
await sleep(500);
check('Enter 切换到光标所在动画',
  (await page.evaluate(() => document.getElementById('selAnim').value)) === keyAfterArrow, keyAfterArrow);
check('「最近使用」写入 localStorage',
  (await page.evaluate(() => localStorage.getItem('dfa.animPicker.v1') || '')).includes(keyAfterArrow));

/* ---------- 6. 选完焦点交还:紧接着按空格应该是播放/暂停,而不是又打开画廊 ---------- */
const focusAfterPick = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || '');
check('选完动画后焦点没有停在触发器上', focusAfterPick !== 'animTrigger', focusAfterPick);
const pausedBefore = await page.evaluate(() => !!window.__anim.isPaused);
await page.keyboard.press('Space');
await sleep(400);
const afterSpace = await page.evaluate(() => ({
  paused: !!window.__anim.isPaused,
  open: !document.getElementById('animPicker').hidden,
}));
check('选完动画后按空格是播放/暂停,不会重开画廊',
  afterSpace.paused !== pausedBefore && !afterSpace.open, JSON.stringify({ pausedBefore, ...afterSpace }));

/* ---------- 7. 鼠标跟随 + 滚轮转发 ---------- */
await page.click('#animTrigger');
await sleep(350);
const hoverTarget = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.ap-card')];
  const t = cards[cards.length - 1];
  const r = t.getBoundingClientRect();
  return { key: t.dataset.key, x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(hoverTarget.x, hoverTarget.y);
await sleep(200);
const cursorKey = await page.evaluate(() => document.querySelector('.ap-card.is-cursor')?.dataset.key);
check('鼠标移到卡片上键盘光标跟随', cursorKey === hoverTarget.key, cursorKey + ' vs ' + hoverTarget.key);

/* 滚轮落在面板头部(不在网格上)也要能滚动网格 —— 需要网格确实可滚动,先把窗口压矮 */
await page.setViewport({ width: 900, height: 380 });
await sleep(300);
const scrollTest = await page.evaluate(() => {
  const body = document.getElementById('animPickerBody');
  const scrollable = body.scrollHeight > body.clientHeight;
  const before = body.scrollTop;
  document.querySelector('.ap-head').dispatchEvent(
    new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }));
  return { scrollable, before, after: body.scrollTop };
});
check('滚轮在面板头部也能滚动卡片网格',
  scrollTest.scrollable ? scrollTest.after > scrollTest.before : st.cards.length <= 6,
  JSON.stringify(scrollTest));
await page.setViewport({ width: 1600, height: 950 });
await page.keyboard.press('Escape');
await waitPickerHidden();
await page.keyboard.press('Escape');
await waitPickerHidden();

/* ---------- 8. 点卡片切换 + 隐藏 select 兼容层 ---------- */
await page.click('#animTrigger');
await sleep(350);
await page.evaluate(() => {
  [...document.querySelectorAll('.ap-card')].find((c) => c.dataset.key === 'extraction')
    .querySelector('.ap-card-pick').click();
});
await waitLoaded('extraction');
await waitPickerHidden();
await sleep(400);
st = await page.evaluate(() => ({
  key: document.getElementById('selAnim').value,
  open: !document.getElementById('animPicker').hidden,
  name: document.getElementById('animTriggerName').textContent,
  firstCard: document.querySelector('.ap-card')?.dataset.key ?? '',
}));
check('点卡片切换动画并关闭画廊', st.key === 'extraction' && !st.open, JSON.stringify(st));
check('触发器名称随切换更新', st.name === '撤离动画', st.name);

await page.click('#animTrigger');
await sleep(350);
st = await galleryState();
check('「最近使用」让刚用过的动画排在最前', st.cards[0] === 'extraction', st.cards.join(' > '));
/* 重排只动位置、不动身份:撤离动画被提到第一张之后,编号仍然是 #001。
 * 这正是「编号」与「数字键序号」的区别 —— 后者是位置(1–9 会变),前者是身份。 */
check('「最近使用」重排不改变编号', st.nos[0] === '#001' && st.nums[0] === '1',
  'no=' + st.nos[0] + ' pos=' + st.nums[0] + ' cards=' + st.cards.join('>'));
await page.keyboard.press('Escape');
await waitPickerHidden();

/* 历史脚本用 page.select('#selAnim', key) 驱动切换,必须继续可用 */
await page.select('#selAnim', 'blinds');
await sleep(1500);
check('隐藏 select 仍可驱动切换(老脚本兼容)',
  (await page.evaluate(() => document.getElementById('selAnim').value)) === 'blinds',
  await page.evaluate(() => document.getElementById('statusbar').textContent));
await page.select('#selAnim', 'extraction');
await sleep(1500);

/* ---------- 9. 窄屏 ---------- */
await page.setViewport({ width: 420, height: 880 });
await page.click('#animTrigger');
await sleep(500);
st = await page.evaluate(() => {
  const panel = document.querySelector('.ap-panel').getBoundingClientRect();
  return {
    open: !document.getElementById('animPicker').hidden,
    panelW: Math.round(panel.width),
    vw: window.innerWidth,
    numBadges: document.querySelectorAll('.ap-card-num').length,
  };
});
check('窄屏画廊铺满视口', st.open && st.panelW === st.vw, JSON.stringify(st));
shots.push({ name: 'anim-picker-mobile', data: await page.screenshot({ encoding: 'base64' }) });
await page.setViewport({ width: 1600, height: 950 });
await page.keyboard.press('Escape');
await sleep(300);
shots.push({ name: 'anim-picker-topbar', data: await page.screenshot({ encoding: 'base64' }) });

check('无页面异常', errs.length === 0, errs.join(' | '));

await browser.close();
/* 截图统一在浏览器关闭后落盘(原因见文件头注释) */
for (const s of shots) fs.writeFileSync(path.join(ROOT, 'tools', s.name + '.png'), Buffer.from(s.data, 'base64'));

console.log(out.join('\n'));
console.log('\n' + (failures ? failures + ' 项未通过' : '全部通过') + '(' + out.length + ' 项检查)');
process.exit(failures ? 1 : 0);
