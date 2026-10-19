/* ============================================================================
 * 生成全套品牌图标:网页 / PWA / Android launcher。
 *
 * 背景:Android 的 launcher 图标一直是 Tauri 模板自带的黄+青默认图标
 *   (mipmap-各密度/ic_launcher.png 的像素是 rgb(255,193,49) + rgb(36,200,219)),
 *   而网页端只有一张 logo.svg —— iOS 不认 SVG favicon、Android 的"添加到主屏幕"
 *   也拿不到 manifest,于是手机上是浏览器默认的链接图标。这个脚本把两件事一起解决:
 *     · 网页:public/icons/*.png + apple-touch-icon + favicon.ico + manifest.webmanifest
 *     · Android:各密度 ic_launcher.png / ic_launcher_round.png / ic_launcher_foreground.png
 *
 * 为什么用 Electron 自己跑(electron scripts/build-app-icons.mjs):
 *   和 electron/make-icons.mjs 同一套理由 —— 机器上不保证有 ImageMagick / sharp,
 *   但应用本身带着一整个 Chromium,把 logo.svg 画到 canvas 上取 PNG 零额外依赖。
 *
 * 画法:深色圆角底板 + 居中的品牌标志(logo.svg,近白 #e2e2e8),尺寸按用途区分:
 *   网页 any(整块方形,交给系统裁圆角)/ maskable(标志再缩小,进 80% 安全圆)/
 *   apple-touch(不透明方形,iOS 自己裁)/ 旧版 launcher(圆角方形)/ round(正圆)。
 *   Android 的自适应图标由 mipmap-anydpi-v26 引用这里的 foreground PNG。
 *
 * 用法:npm run icons:app(换 logo 或换图标风格时才需要重跑)。
 * ============================================================================ */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'public', 'icons');
const ANDROID_RES = path.join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');

/* brand:底板渐变两端,都取自 #242424 这一族中性色(不做第二套灰) */
const PLATE_FROM = '#303034';
const PLATE_TO = '#19191b';
const MARK = '#e2e2e8';

/* 各用途的"标志宽度占画布比例"。Android 自适应前景的安全区是 66/108,
 * 所以 foreground 取 0.50;maskable 同理走 0.50。 */
const JOBS = [
  // 网页
  /* 16/32 这两档把标志放大:实测 0.66 时 16px 只有 8% 的像素是标志色,
   * 缩小后细笔画会被抗锯齿吃掉,标签页上就是一团灰。小尺寸宁可占得满一点。 */
  { file: path.join(WEB_DIR, 'favicon-16.png'), size: 16, mode: 'square', logo: 0.82 },
  { file: path.join(WEB_DIR, 'favicon-32.png'), size: 32, mode: 'square', logo: 0.74 },
  { file: path.join(WEB_DIR, 'favicon-48.png'), size: 48, mode: 'square', logo: 0.7 },
  { file: path.join(WEB_DIR, 'apple-touch-icon.png'), size: 180, mode: 'square', logo: 0.58 },
  { file: path.join(WEB_DIR, 'icon-192.png'), size: 192, mode: 'square', logo: 0.58 },
  { file: path.join(WEB_DIR, 'icon-512.png'), size: 512, mode: 'square', logo: 0.58 },
  { file: path.join(WEB_DIR, 'icon-maskable-512.png'), size: 512, mode: 'square', logo: 0.5 },
  // Android 旧版 launcher(无 anydpi 时用)与 round
  { file: path.join(ANDROID_RES, 'mipmap-mdpi', 'ic_launcher.png'), size: 48, mode: 'rounded', logo: 0.6 },
  { file: path.join(ANDROID_RES, 'mipmap-hdpi', 'ic_launcher.png'), size: 72, mode: 'rounded', logo: 0.6 },
  { file: path.join(ANDROID_RES, 'mipmap-xhdpi', 'ic_launcher.png'), size: 96, mode: 'rounded', logo: 0.6 },
  { file: path.join(ANDROID_RES, 'mipmap-xxhdpi', 'ic_launcher.png'), size: 144, mode: 'rounded', logo: 0.6 },
  { file: path.join(ANDROID_RES, 'mipmap-xxxhdpi', 'ic_launcher.png'), size: 192, mode: 'rounded', logo: 0.6 },
  { file: path.join(ANDROID_RES, 'mipmap-mdpi', 'ic_launcher_round.png'), size: 48, mode: 'circle', logo: 0.56 },
  { file: path.join(ANDROID_RES, 'mipmap-hdpi', 'ic_launcher_round.png'), size: 72, mode: 'circle', logo: 0.56 },
  { file: path.join(ANDROID_RES, 'mipmap-xhdpi', 'ic_launcher_round.png'), size: 96, mode: 'circle', logo: 0.56 },
  { file: path.join(ANDROID_RES, 'mipmap-xxhdpi', 'ic_launcher_round.png'), size: 144, mode: 'circle', logo: 0.56 },
  { file: path.join(ANDROID_RES, 'mipmap-xxxhdpi', 'ic_launcher_round.png'), size: 192, mode: 'circle', logo: 0.56 },
  // Android 自适应前景(108dp,背景由 values/colors.xml 的 ic_launcher_background 提供)
  { file: path.join(ANDROID_RES, 'mipmap-mdpi', 'ic_launcher_foreground.png'), size: 108, mode: 'foreground', logo: 0.5 },
  { file: path.join(ANDROID_RES, 'mipmap-hdpi', 'ic_launcher_foreground.png'), size: 162, mode: 'foreground', logo: 0.5 },
  { file: path.join(ANDROID_RES, 'mipmap-xhdpi', 'ic_launcher_foreground.png'), size: 216, mode: 'foreground', logo: 0.5 },
  { file: path.join(ANDROID_RES, 'mipmap-xxhdpi', 'ic_launcher_foreground.png'), size: 324, mode: 'foreground', logo: 0.5 },
  { file: path.join(ANDROID_RES, 'mipmap-xxxhdpi', 'ic_launcher_foreground.png'), size: 432, mode: 'foreground', logo: 0.5 },
];

function svgDataUrl() {
  const svg = fs.readFileSync(path.join(ROOT, 'public', 'logo.svg'), 'utf8');
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

/* 在页面里执行:把每个 job 画到 canvas,返回 base64 PNG。
 * 注意这里不引用任何外部库 —— 只用到 Chromium 自带的 canvas 2D。 */
function drawAll(svgUrl, jobs, palette) {
  return `(async () => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('logo.svg 加载失败'));
      img.src = ${JSON.stringify(svgUrl)};
    });
    const RATIO = 385.48 / 322.72;  // logo.svg 的 viewBox,宽 > 高
    const out = [];
    for (const job of ${JSON.stringify(jobs)}) {
      const { size, mode, logo } = job;
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      if (mode !== 'foreground') {
        ctx.save();
        const r = size * 0.22;
        ctx.beginPath();
        if (mode === 'circle') ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        else if (mode === 'rounded') ctx.roundRect(0, 0, size, size, r);
        else ctx.rect(0, 0, size, size);
        ctx.clip();
        const g = ctx.createLinearGradient(0, 0, size, size);
        g.addColorStop(0, ${JSON.stringify(palette.from)});
        g.addColorStop(1, ${JSON.stringify(palette.to)});
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        ctx.restore();
      }
      const w = size * logo;
      const h = w / RATIO;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      out.push({ file: job.file, data: c.toDataURL('image/png') });
    }
    return out;
  })()`;
}

/** ICO 容器(Vista+ 允许条目直接内嵌 PNG,不用再写 DIB 掩码)。 */
function buildIco(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  entries.forEach((e, i) => {
    const p = 6 + i * 16;
    header.writeUInt8(e.size >= 256 ? 0 : e.size, p);
    header.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1);
    header.writeUInt8(0, p + 2);
    header.writeUInt8(0, p + 3);
    header.writeUInt16LE(1, p + 4);
    header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(e.buf.length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += e.buf.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.buf)]);
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(WEB_DIR, { recursive: true });
  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><body></body>'));
  const results = await win.webContents.executeJavaScript(
    drawAll(svgDataUrl(), JOBS, { from: PLATE_FROM, to: PLATE_TO }),
    true,
  );
  const byFile = new Map();
  for (const r of results) {
    const buf = Buffer.from(String(r.data).split(',')[1], 'base64');
    fs.writeFileSync(r.file, buf);
    byFile.set(r.file, buf);
  }
  /* favicon.ico:16/32/48 三档。网页端不保证一定请求它,但老书签、部分国产浏览器、
   * 以及"从网页创建快捷方式"都会默认去找 /favicon.ico —— 没有就是默认链接图标。 */
  const icoSizes = [16, 32, 48];
  const icoEntries = icoSizes.map((size) => {
    const hit = [...byFile.entries()].find(([f, b]) => f.endsWith('favicon-' + size + '.png') && b);
    return { size, buf: hit ? hit[1] : byFile.get(path.join(WEB_DIR, 'favicon-32.png')) };
  });
  fs.writeFileSync(path.join(ROOT, 'public', 'favicon.ico'), buildIco(icoEntries));

  const list = [...byFile.keys()].map((f) => path.relative(ROOT, f));
  console.log('生成 ' + list.length + ' 张 PNG + public/favicon.ico');
  for (const f of list) console.log('  ' + f);
  win.destroy();
  app.quit();
}

main().catch((e) => {
  console.error('图标生成失败:', e);
  app.exit(1);
});
