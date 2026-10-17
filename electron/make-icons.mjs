/* ============================================================================
 * 生成 Windows 应用图标:build/icon.ico(256/128/64/48/32/24/16 共七档)+ build/icon.png(256)。
 *
 * 为什么要用 Electron 自己跑这个脚本(electron electron/make-icons.mjs):
 *   图标源是 public/logo.svg,机器上不一定有 ImageMagick / Inkscape,但应用本身就带着
 *   一整个 Chromium —— 直接开个隐藏窗口把 SVG 画到 canvas 上取像素,零额外依赖。
 *
 * ICO 的组装是手写的(不引第三方库):
 *   · 每个尺寸一条 16 字节目录 + 一段 BMP DIB(32bpp + AND 掩码);
 *   · DIB 里的像素是**自下而上**的 BGRA,颜色在 canvas 里是 RGBA,需要交换通道并翻行;
 *   · 256 这一档也写成 DIB(而不是常见的内嵌 PNG):体积大 ~256KB,但兼容性最好,
 *     rcedit / electron-builder 都不会有意见。
 *
 * 用法:npm run icons(不会自动执行,图标已随仓库提供;换了 logo 才需要重跑)。
 * ========================================================================== */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const SIZES = [256, 128, 64, 48, 32, 24, 16];   // 从大到小,目录顺序无所谓,便于人读

/** 在页面里把 logo 画到指定尺寸的画布上,返回 RGBA 像素(一维数组)。
 * logo.svg 是裸标志(透明背景、近白形状),这里等比居中栅格化,背景保持透明。 */
function rasterizeJs(svgDataUrl) {
  return `(async () => {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('SVG 加载失败'));
      img.src = ${JSON.stringify(svgDataUrl)};
    });
    const out = [];
    for (const size of ${JSON.stringify(SIZES)}) {
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      /* 源图 385.48×322.72(宽>高),画满宽、上下多留一点边 */
      const box = size * 0.92;
      const ratio = 385.48 / 322.72;
      const w = box, h = box / ratio;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      out.push({ size, data: Array.from(ctx.getImageData(0, 0, size, size).data) });
    }
    return out;
  })()`;
}

/** 把一批 RGBA 位图打包成 ICO(BMP DIB 条目)。 */
function buildIco(frames) {
  const entries = [];
  let offset = 6 + frames.length * 16;
  for (const f of frames) {
    const { size, data } = f;
    const xorSize = size * size * 4;
    const andRow = Math.ceil(size / 32) * 4;      // 1bpp,每行按 4 字节对齐
    const andSize = andRow * size;
    const dib = Buffer.alloc(40 + xorSize + andSize);

    dib.writeUInt32LE(40, 0);                     // biSize
    dib.writeInt32LE(size, 4);                    // biWidth
    dib.writeInt32LE(size * 2, 8);                // biHeight = XOR + AND 两张图的高度
    dib.writeUInt16LE(1, 12);                     // biPlanes
    dib.writeUInt16LE(32, 14);                    // biBitCount
    dib.writeUInt32LE(0, 16);                     // biCompression = BI_RGB
    dib.writeUInt32LE(xorSize, 20);               // biSizeImage
    dib.writeInt32LE(0, 24);                      // biXPelsPerMeter
    dib.writeInt32LE(0, 28);                      // biYPelsPerMeter
    dib.writeUInt32LE(0, 32);                     // biClrUsed
    dib.writeUInt32LE(0, 36);                     // biClrImportant

    /* 像素自下而上,通道 RGBA → BGRA;AND 掩码全 0 = 完全交给 alpha 通道。 */
    for (let y = 0; y < size; y++) {
      const src = (size - 1 - y) * size * 4;
      const dst = 40 + y * size * 4;
      for (let x = 0; x < size; x++) {
        const s = src + x * 4;
        const d = dst + x * 4;
        dib[d] = data[s + 2];
        dib[d + 1] = data[s + 1];
        dib[d + 2] = data[s];
        dib[d + 3] = data[s + 3];
      }
    }

    entries.push({ size, dib, bytes: dib.length, offset });
    offset += dib.length;
  }

  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);                     // reserved
  header.writeUInt16LE(1, 2);                     // type = icon
  header.writeUInt16LE(entries.length, 4);        // count
  entries.forEach((e, i) => {
    const p = 6 + i * 16;
    header.writeUInt8(e.size >= 256 ? 0 : e.size, p);       // 256 用 0 表示
    header.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1);
    header.writeUInt8(0, p + 2);                            // 调色板数
    header.writeUInt8(0, p + 3);                            // reserved
    header.writeUInt16LE(1, p + 4);                         // planes
    header.writeUInt16LE(32, p + 6);                        // bpp
    header.writeUInt32LE(e.bytes, p + 8);
    header.writeUInt32LE(e.offset, p + 12);
  });

  return Buffer.concat([header, ...entries.map((e) => e.dib)]);
}

/** 把 canvas 的 RGBA 写成最小 PNG(只有 256 那档需要,直接复用 Electron 的编码能力更省事)。 */
async function writeIconPng(win, size) {
  const dataUrl = await win.webContents.executeJavaScript(`(() => {
    const src = document.createElement('canvas');
    src.width = ${size}; src.height = ${size};
    const ctx = src.getContext('2d');
    const img = new Image();
    return new Promise((resolve, reject) => {
      img.onload = () => {
        const box = ${size} * 0.92, ratio = 385.48 / 322.72;
        const w = box, h = box / ratio;
        ctx.drawImage(img, (${size} - w) / 2, (${size} - h) / 2, w, h);
        resolve(src.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('SVG 加载失败'));
      img.src = ${JSON.stringify(svgUrl)};
    });
  })()`, true);
  const b64 = String(dataUrl).split(',')[1];
  return Buffer.from(b64, 'base64');
}

/* ============================================================================
 * 顺带生成便携版「解包中」的启动图:build/splash.bmp
 *
 * 为什么需要它:便携版 exe 每次启动要先把上百 MB 解包到临时目录(实测这台机器上
 * 一分钟以上),而这段时间 Electron 还没被启动 —— 屏幕上原本什么都没有,用户会以为
 * 软件没反应。electron-builder 用 NSIS 的 BgImage 插件在解包期间显示一张 BMP,
 * 于是「双击 → 解包图 → 编辑器自己的加载层」是连着的,中间没有黑屏。
 *
 * 这张图和 electron/portable-splash.html 是同一份:直接把那个页面渲染成 460×272 再取像素,
 * 所以两边永远不会长得不一样(改了页面就重跑 npm run icons)。
 * 尺寸写死在下面,并由 package.json 的 portable.splashImage 引用成品图。
 *
 * 注意它**不可能有动画**:NSIS 在解包时是阻塞的,这一阶段没有任何东西能重绘窗口,
 * 所以画面里不画假进度(见页面里的注释)。
 * ========================================================================== */
const SPLASH_W = 460;
const SPLASH_H = 272;

/** 把 BGRA 原始像素写成一个 24bpp 的 BMP(像素自下而上、每行 4 字节对齐)。
 * 不用 32bpp:NSIS 的 BgImage 走的是 GDI,BMP 里带 alpha 反而在不同系统上表现不一致 ——
 * 而这张图本来就是一整块不透明的窗口,不需要透明通道。 */
function buildBmp(bgra, w, h) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const pixelBytes = rowSize * h;
  const out = Buffer.alloc(54 + pixelBytes);
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(54 + pixelBytes, 2);      // bfSize
  out.writeUInt32LE(54, 10);                  // bfOffBits
  out.writeUInt32LE(40, 14);                  // biSize = BITMAPINFOHEADER
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);                    // 正数 = 像素自下而上
  out.writeUInt16LE(1, 26);                   // biPlanes
  out.writeUInt16LE(24, 28);                  // biBitCount
  out.writeUInt32LE(0, 30);                   // BI_RGB
  out.writeUInt32LE(pixelBytes, 34);
  out.writeInt32LE(2835, 38);                 // 72 DPI
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    const dst = 54 + y * rowSize;
    for (let x = 0; x < w; x++) {
      const s = src + x * 4;
      const d = dst + x * 3;
      out[d] = bgra[s];        // B
      out[d + 1] = bgra[s + 1]; // G
      out[d + 2] = bgra[s + 2]; // R
    }
  }
  return out;
}

async function renderSplashBmp() {
  /* 用离屏渲染(offscreen)拿这一帧,而不是开一个真窗口去截:
   *  · 普通隐藏窗口里 CSS 动画不推进,capturePage 只能截到渐变第一帧(整块半透明);
   *  · 把窗口挪到屏幕外用坐标骗过去,DWM 根本不会合成它,capturePage 返回全透明;
   *  · 开真窗口再截最稳,但 npm run icons 会在用户眼前闪一下。
   * 离屏渲染两个问题都没有:帧由 Chromium 画进一块离屏缓冲,像素从 paint 事件里拿。 */
  const win = new BrowserWindow({
    width: SPLASH_W,
    height: SPLASH_H,
    show: false,
    frame: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,     // 离屏窗口默认会被降频,动画要按正常速率跑完
    },
  });
  /* paint 事件给的就是整帧打包好的 NativeImage;留最后一帧即可 ——
   * 页面是静态的,字体到位后会重绘一次,那一帧就是最终画面。 */
  let latest = null;
  win.webContents.on('paint', (_event, _dirty, image) => { latest = image; });
  await win.loadFile(path.join(__dirname, 'portable-splash.html'));
  /* 图片里用的是项目自带的产品字体(ProjectD Type),必须等字体真的解码完再截,
   * 否则会拍下系统字体回退的那一帧 —— 那正是"和应用不是一个设计语言"的来源。 */
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true);
  await new Promise((resolve) => setTimeout(resolve, 350));   // 再等一帧合成
  if (!latest) {
    win.destroy();
    throw new Error('离屏渲染没有拿到任何一帧,无法生成 build/splash.bmp');
  }
  /* 缩放不是 100% 时离屏帧的像素会比 DIP 尺寸大 —— 缩回目标尺寸再写 BMP,
   * 否则 NSIS 会把这张图按自己的尺寸当窗口大小,和 460×272 的悬浮窗对不齐。 */
  const size = latest.getSize();
  const shot = size.width === SPLASH_W && size.height === SPLASH_H
    ? latest
    : latest.resize({ width: SPLASH_W, height: SPLASH_H, quality: 'best' });
  const bgra = shot.toBitmap();                                // 原始像素,自上而下 BGRA
  win.destroy();
  return buildBmp(bgra, SPLASH_W, SPLASH_H);
}

let svgUrl = '';

app.whenReady().then(async () => {
  const svgPath = path.join(ROOT, 'public', 'logo.svg');
  const svg = fs.readFileSync(svgPath);
  svgUrl = 'data:image/svg+xml;base64,' + svg.toString('base64');

  const win = new BrowserWindow({ width: 300, height: 300, show: false, webPreferences: { offscreen: false } });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const frames = await win.webContents.executeJavaScript(rasterizeJs(svgUrl), true);
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const ico = buildIco(frames);
  const icoPath = path.join(BUILD_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, ico);

  const png = await writeIconPng(win, 256);
  const pngPath = path.join(BUILD_DIR, 'icon.png');
  fs.writeFileSync(pngPath, png);

  console.log(`[icons] ${icoPath}  ${(ico.length / 1024).toFixed(1)} KB  尺寸: ${SIZES.join('/')}`);
  console.log(`[icons] ${pngPath}  ${(png.length / 1024).toFixed(1)} KB`);

  /* 便携版解包时的启动图(见文件后半段):内容是 portable-splash.html 的静态渲染,
   * 只换了一句文案。写 BMP 而不是 PNG,是因为 NSIS 的 BgImage 只吃 BMP。 */
  const bmp = await renderSplashBmp();
  const bmpPath = path.join(BUILD_DIR, 'splash.bmp');
  fs.writeFileSync(bmpPath, bmp);
  console.log(`[icons] ${bmpPath}  ${(bmp.length / 1024).toFixed(1)} KB  ${SPLASH_W}×${SPLASH_H}`);

  win.destroy();
  app.exit(0);
});
