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
  win.destroy();
  app.exit(0);
});
