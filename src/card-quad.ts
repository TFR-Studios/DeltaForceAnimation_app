/* ============================================================================
 * 名片四角透视合成(src/card-quad.ts)
 * ---------------------------------------------------------------------------
 * 四角各自拖动的"透视编辑器"用:把名片原图映射到任意四边形。
 *  · 四角顺序固定为 左上、右上、右下、左下;
 *  · 单应矩阵把文档坐标反算回原图坐标,逐像素双线性采样;
 *  · 输出文档尺寸画布,四边形外透明,直接盖在结算图最上层。
 * ========================================================================== */

export type QuadPoint = { x: number; y: number };
export type Quad = [QuadPoint, QuadPoint, QuadPoint, QuadPoint];

export function quadKey(quad: Quad): string {
  return quad.map((p) => Math.round(p.x) + ',' + Math.round(p.y)).join(';');
}

export function quadCenter(quad: Quad): QuadPoint {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

export function translateQuad(quad: Quad, dx: number, dy: number): Quad {
  return quad.map((p) => ({ x: p.x + dx, y: p.y + dy })) as Quad;
}

export function rotateQuadAround(quad: Quad, cx: number, cy: number, deg: number): Quad {
  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return quad.map((p) => {
    const x = p.x - cx;
    const y = p.y - cy;
    return { x: cx + x * cos - y * sin, y: cy + x * sin + y * cos };
  }) as Quad;
}

type Source = { w: number; h: number; data: Uint8ClampedArray };
const sourceCache = new WeakMap<HTMLImageElement, Source>();

function sourceOf(img: HTMLImageElement): Source | null {
  const cached = sourceCache.get(img);
  if (cached) return cached;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  const source = { w, h, data };
  sourceCache.set(img, source);
  return source;
}

function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    if (pivot !== col) {
      const t = a[pivot]; a[pivot] = a[col]; a[col] = t;
      const tv = b[pivot]; b[pivot] = b[col]; b[col] = tv;
    }
    const p = a[col][col];
    for (let j = col; j < n; j++) a[col][j] /= p;
    b[col] /= p;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = a[row][col];
      if (!f) continue;
      for (let j = col; j < n; j++) a[row][j] -= f * a[col][j];
      b[row] -= f * b[col];
    }
  }
  return b;
}

/** 把 src 四边形映射到 dst 四边形,返回 h0..h7。调用方给 doc 四角 → 原图四角,得到 doc→原图。 */
function solveHomography(src: Quad, dst: Quad): number[] | null {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const X = src[i].x, Y = src[i].y;
    const u = dst[i].x, v = dst[i].y;
    a.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); b.push(u);
    a.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); b.push(v);
  }
  return solveLinear(a, b);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 把名片原图透视映射到 quad;输出文档尺寸画布,四边形外透明。可传入复用画布。 */
export function warpImageToQuad(
  img: HTMLImageElement,
  quad: Quad,
  docWidth: number,
  docHeight: number,
  out?: HTMLCanvasElement,
): HTMLCanvasElement | null {
  const src = sourceOf(img);
  if (!src) return null;
  const area = Math.abs(
    (quad[0].x * quad[1].y - quad[1].x * quad[0].y) +
    (quad[1].x * quad[2].y - quad[2].x * quad[1].y) +
    (quad[2].x * quad[3].y - quad[3].x * quad[2].y) +
    (quad[3].x * quad[0].y - quad[0].x * quad[3].y)
  ) / 2;
  if (!Number.isFinite(area) || area < 100) return null;

  const sourceRect: Quad = [
    { x: 0, y: 0 },
    { x: src.w, y: 0 },
    { x: src.w, y: src.h },
    { x: 0, y: src.h },
  ];
  const h = solveHomography(quad, sourceRect);
  if (!h) return null;

  const minX = clamp(Math.floor(Math.min(quad[0].x, quad[1].x, quad[2].x, quad[3].x)), 0, docWidth);
  const maxX = clamp(Math.ceil(Math.max(quad[0].x, quad[1].x, quad[2].x, quad[3].x)), 0, docWidth);
  const minY = clamp(Math.floor(Math.min(quad[0].y, quad[1].y, quad[2].y, quad[3].y)), 0, docHeight);
  const maxY = clamp(Math.ceil(Math.max(quad[0].y, quad[1].y, quad[2].y, quad[3].y)), 0, docHeight);
  const bw = maxX - minX;
  const bh = maxY - minY;
  if (bw <= 0 || bh <= 0) return null;

  const canvas = out || document.createElement('canvas');
  if (canvas.width !== docWidth || canvas.height !== docHeight) {
    canvas.width = docWidth;
    canvas.height = docHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, docWidth, docHeight);
  const pixels = ctx.createImageData(bw, bh);
  const outData = pixels.data;

  const sample = (x: number, y: number, channel: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const x1 = Math.min(src.w - 1, x0 + 1);
    const y1 = Math.min(src.h - 1, y0 + 1);
    const i00 = (y0 * src.w + x0) * 4 + channel;
    const i10 = (y0 * src.w + x1) * 4 + channel;
    const i01 = (y1 * src.w + x0) * 4 + channel;
    const i11 = (y1 * src.w + x1) * 4 + channel;
    const top = src.data[i00] * (1 - fx) + src.data[i10] * fx;
    const bottom = src.data[i01] * (1 - fx) + src.data[i11] * fx;
    return top * (1 - fy) + bottom * fy;
  };

  for (let y = 0; y < bh; y++) {
    const py = minY + y + 0.5;
    for (let x = 0; x < bw; x++) {
      const px = minX + x + 0.5;
      const denom = h[6] * px + h[7] * py + 1;
      if (Math.abs(denom) < 1e-9) continue;
      const u = (h[0] * px + h[1] * py + h[2]) / denom;
      const v = (h[3] * px + h[4] * py + h[5]) / denom;
      if (u < 0 || v < 0 || u >= src.w || v >= src.h) continue;
      const idx = (y * bw + x) * 4;
      outData[idx] = sample(u, v, 0);
      outData[idx + 1] = sample(u, v, 1);
      outData[idx + 2] = sample(u, v, 2);
      outData[idx + 3] = 255;
    }
  }
  ctx.putImageData(pixels, minX, minY);
  return canvas;
}
