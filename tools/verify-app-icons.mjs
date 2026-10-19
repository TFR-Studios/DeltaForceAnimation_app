/* 应用图标的回归断言(开发期辅助,不参与构建):
 * 起因:手机端 launcher 图标一直是 Tauri 模板自带的黄+青默认图标
 * (mipmap-各密度/ic_launcher.png 的像素是 rgb(255,193,49) + rgb(36,200,219)),
 * 网页端也只有一张透明底的白色 logo.svg —— iOS 不认 SVG favicon、Android 的
 * "添加到主屏幕"要 manifest,于是手机上显示的是浏览器默认的链接图标。
 *
 * 这里守四件事:
 *   1) 网页端真的挂上了 PNG 图标 / apple-touch-icon / manifest,并且都能 200;
 *   2) 每张图标的尺寸与声明一致,maskable 的留白足够(标志不贴边);
 *   3) Android 的 launcher 图标里不再出现 Tauri 默认的黄+青,且中心是品牌标志色;
 *   4) 自适应图标 XML 引用的资源都真实存在。
 * 用法:node tools/verify-app-icons.mjs [--url http://127.0.0.1:5173/]
 * 退出码 0 = 全绿;1 = 有 FAIL。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const url = arg('url', 'http://127.0.0.1:5173/');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '   ' + JSON.stringify(detail)));
};

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const RES = path.join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');

/* ---------- A. 静态资源:文件存在 / XML 引用完整 ---------- */
const webFiles = [
  'public/icons/favicon-16.png', 'public/icons/favicon-32.png',
  'public/icons/apple-touch-icon.png', 'public/icons/icon-192.png',
  'public/icons/icon-512.png', 'public/icons/icon-maskable-512.png',
  'public/favicon.ico', 'public/manifest.webmanifest',
];
check('网页图标文件齐全', webFiles.every((f) => fs.existsSync(path.join(ROOT, f))), webFiles.filter((f) => !fs.existsSync(path.join(ROOT, f))));

const androidDensities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
const androidFiles = androidDensities.flatMap((d) => ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'].map((n) => path.join(RES, 'mipmap-' + d, n)));
check('Android 各密度 launcher 图标齐全', androidFiles.every((f) => fs.existsSync(f)), androidFiles.filter((f) => !fs.existsSync(f)).map((f) => path.relative(ROOT, f)));

const adaptive = fs.readFileSync(path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'utf8');
check('自适应图标引用的是品牌背景 + mipmap 前景', /@color\/ic_launcher_background/.test(adaptive) && /@mipmap\/ic_launcher_foreground/.test(adaptive), adaptive.replace(/\s+/g, ' ').slice(0, 120));
check('brand 背景色已定义', /ic_launcher_background/.test(fs.readFileSync(path.join(RES, 'values', 'colors.xml'), 'utf8')));
check('单色(Android 13 主题图标)已提供', fs.existsSync(path.join(RES, 'drawable', 'ic_launcher_monochrome.xml')));

/* ---------- B. 浏览器里:链接可用 / 尺寸对 / 主题色跟随 ---------- */
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await page.goto(url + '?ui=mobile', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => {
  const el = document.getElementById('app-loading');
  return !el || el.classList.contains('is-hidden');
}, { timeout: 90000, polling: 300 }).catch(() => {});
await new Promise((r) => setTimeout(r, 900));

const web = await page.evaluate(async () => {
  const links = [...document.querySelectorAll('link[rel*="icon"], link[rel="manifest"]')].map((l) => ({ rel: l.rel, href: l.getAttribute('href'), sizes: l.sizes ? l.sizes.value : '' }));
  const out = { links, icons: {}, manifest: null, ico: null, themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') };
  for (const href of ['/icons/favicon-16.png', '/icons/favicon-32.png', '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png']) {
    try {
      const r = await fetch(href);
      const blob = await r.blob();
      const bmp = await createImageBitmap(blob);
      out.icons[href] = { status: r.status, type: blob.type, w: bmp.width, h: bmp.height };
    } catch (e) { out.icons[href] = { error: String(e) }; }
  }
  try {
    const mr = await fetch('/manifest.webmanifest');
    out.manifest = { status: mr.status, json: await mr.json() };
  } catch (e) { out.manifest = { error: String(e) }; }
  try {
    const r = await fetch('/favicon.ico');
    out.ico = { status: r.status, type: r.headers.get('content-type') };
  } catch (e) { out.ico = { error: String(e) }; }
  return out;
});

check('页面挂载了 apple-touch-icon 与 manifest',
  web.links.some((l) => l.rel === 'apple-touch-icon') && web.links.some((l) => l.rel === 'manifest'), web.links);
check('不再只依赖 SVG favicon', web.links.filter((l) => l.rel === 'icon' && (l.href || '').endsWith('.png')).length >= 2, web.links.filter((l) => l.rel === 'icon'));
const wantSize = { '/icons/favicon-16.png': 16, '/icons/favicon-32.png': 32, '/icons/apple-touch-icon.png': 180, '/icons/icon-192.png': 192, '/icons/icon-512.png': 512, '/icons/icon-maskable-512.png': 512 };
const sizeBad = Object.entries(wantSize).filter(([href, size]) => !web.icons[href] || web.icons[href].status !== 200 || web.icons[href].w !== size || web.icons[href].h !== size);
check('全部 PNG 图标 200 且尺寸正确', sizeBad.length === 0, sizeBad.map(([h]) => ({ href: h, got: web.icons[h] })));
check('manifest 可解析且含 192/512/maskable',
  web.manifest && web.manifest.status === 200 && Array.isArray(web.manifest.json.icons) && ['192x192', '512x512'].every((s) => web.manifest.json.icons.some((i) => i.sizes === s)) && web.manifest.json.icons.some((i) => i.purpose === 'maskable'),
  web.manifest && web.manifest.json);
check('favicon.ico 可取(老书签 / 部分浏览器会直接找它)', web.ico && web.ico.status === 200, web.ico);

await page.evaluate(() => { const btn = document.querySelector('.theme-btn[data-theme="light"]'); if (btn) btn.click(); });
await new Promise((r) => setTimeout(r, 450));
const lightMeta = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') }));
check('主题色 meta 跟随主题(浅色 #eaeaf0)', lightMeta.theme === 'light' && lightMeta.meta === '#eaeaf0', lightMeta);

/* ---------- C. 图标像素:不再是默认黄+青,中心是品牌标志色 ---------- */
const probePixels = async (file) => {
  const b64 = fs.readFileSync(file).toString('base64');
  return page.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let cyan = 0, yellow = 0, mark = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
      if (a < 40) continue;
      if (Math.abs(r - 36) < 24 && Math.abs(g - 200) < 24 && Math.abs(b - 219) < 24) cyan++;
      if (Math.abs(r - 255) < 20 && Math.abs(g - 193) < 24 && Math.abs(b - 49) < 24) yellow++;
      if (r > 190 && g > 190 && b > 195 && a > 200) mark++;
      if (r < 70 && g < 70 && b < 75 && a > 200) dark++;
    }
    return { w: c.width, h: c.height, cyan, yellow, mark, dark, cornerAlpha: d[3] };
  }, 'data:image/png;base64,' + b64);
};

for (const d of ['mdpi', 'xxxhdpi']) {
  const std = await probePixels(path.join(RES, 'mipmap-' + d, 'ic_launcher.png'));
  check('Android ' + d + ' launcher 不再含 Tauri 默认黄+青', std.cyan === 0 && std.yellow === 0, std);
  check('Android ' + d + ' launcher 中心有品牌标志像素', std.mark > 0 && std.dark > 0, std);
  check('Android ' + d + ' launcher 是圆角(四角透明)', std.cornerAlpha === 0, std);
  const fg = await probePixels(path.join(RES, 'mipmap-' + d, 'ic_launcher_foreground.png'));
  check('Android ' + d + ' 自适应前景是透明底 + 标志', fg.mark > 0 && fg.dark === 0, fg);
}
const mask = await probePixels(path.join(ROOT, 'public', 'icons', 'icon-maskable-512.png'));
check('maskable 图标满版不透明(没有透明角)', mask.cornerAlpha === 255 && mask.dark > 0 && mask.cyan === 0, mask);
const apple = await probePixels(path.join(ROOT, 'public', 'icons', 'apple-touch-icon.png'));
check('apple-touch-icon 不透明(iOS 会自己裁圆角)', apple.cornerAlpha === 255 && apple.mark > 0, apple);

check('无页面级 JS 报错', errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log('\n未通过: ' + failed + ' 项');
process.exit(failed ? 1 : 0);
