/* ============================================================================
 * PSD 文档模型与渲染(src/psd-document.ts)
 * ---------------------------------------------------------------------------
 * 图片编辑器的"数据层":用 ag-psd 把 .psd 读成 DOM 友好的树,再按图层顺序合成到
 * canvas。它不碰任何界面元素,界面(图片编辑器页)只调用这里的函数。
 *
 * 三个必须守住的点(改这块前先看):
 *  1) **图层顺序**:ag-psd 的 children 已经是"从下往上"的绘制顺序(readLayerInfo 里
 *     反向遍历 + unshift),直接顺序画即可,不要再反转 —— 反转会把整张图上下颠倒。
 *  2) **文字图层不重画**:没有改动过的文字图层直接画 PSD 里已经栅格化的像素(与 Photoshop
 *     逐像素一致);只改颜色时用原像素的 alpha 当蒙版填新色(字形完全不变);只有改了内容才
 *     用 canvas 重新排版 —— 重新排版依赖字体,项目自带 ProjectDType 两份,字形能对上。
 *  3) **透明度**写在绘制时:globalAlpha = 图层透明度 × 组透明度,不要动图层像素本身。
 * ========================================================================== */
import {
  readPsd,
  initializeCanvas,
  type Layer,
  type LayerTextData,
  type TextStyle,
  type ParagraphStyle,
  type PixelData,
} from 'ag-psd';

/* 画布工厂只装一次:ag-psd 读图层像素时需要它建 canvas。
 * 放在模块顶层而不是 readPsd 内部,重复调用也只是覆盖同样的两个工厂。 */
initializeCanvas(
  (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  },
  (w, h) => new ImageData(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))),
);

/** 文字图层的可编辑状态(界面上的"改了什么"就以它为准) */
export type TextEditState = {
  /** 当前内容(允许换行) */
  text: string;
  /** 当前颜色 #rrggbb */
  color: string;
  /** 当前透明度 0..1(乘在图层自身透明度上) */
  opacity: number;
  /** 已改动过(含回退到原值后仍标脏,用于重绘判断) */
  dirty: boolean;
};

/** 文字图层在文档里的原始信息 + 渲染所需的一切 */
export type PsdTextLayer = {
  uid: string;
  name: string;
  /** 原始内容 */
  text: string;
  /** 原始颜色 #rrggbb */
  color: string;
  /** 图层自身透明度(PSD 值) */
  layerOpacity: number;
  /** 有效字号(文档像素) = style.fontSize × 变换缩放 */
  fontSize: number;
  /** 字体族(已映射成 CSS 可用的名字) */
  family: string;
  weight: number;
  /** 图层边界(文档坐标) */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** 原始栅格像素(未改内容时直接画这一份) */
  canvas: HTMLCanvasElement;
  /** 文字引擎数据(重排时读它) */
  data: LayerTextData;
  hidden: boolean;
};

/** 渲染树节点:组节点带 children,普通节点带 canvas */
export type PsdNode = {
  id: string;
  name: string;
  group: boolean;
  hidden: boolean;
  opacity: number;
  blendMode: string;
  clipping: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  canvas?: HTMLCanvasElement;
  children?: PsdNode[];
  /** 文字图层才有(指向扁平列表里的那一项) */
  textLayer?: PsdTextLayer;
  /** 背景图层:整幅、名字形如 Settlement_Sp_*;渲染时可以被外部图片替换 */
  isBackground?: boolean;
  /** 屏幕内容层:紧贴在背景图层下面、尺寸落在背景里(结算图的「形状 1」)。
   * 换背景时由图片编辑器把它合成到背景里(填入新图的透明屏幕区域)。 */
  isScreenContent?: boolean;
};

export type PsdDocument = {
  width: number;
  height: number;
  /** 合成顺序:children 是从下往上的绘制顺序 */
  root: PsdNode[];
  /** 全部文字图层(自下而上的顺序;界面按它渲染列表) */
  textLayers: PsdTextLayer[];
  /** 文件字节数(界面显示"多大") */
  bytes: number;
  /** 手机屏幕内容层(紧贴背景下方的那一层):换背景时用它填满新图片的透明挖孔。
   * 没有这种图层时为 undefined。 */
  screenContent?: { canvas: HTMLCanvasElement; left: number; top: number; right: number; bottom: number };
};

/* ---------------------------------------------------------------------------
 * 字体映射:PSD 里写的是字体 PostScript 名,canvas 要的是 CSS family。
 * 项目已经把 ProjectDType 两份字体托管进页面(style.css 的 @font-face),
 * 这里只做名字到 family 的映射;不认识的字体会落到产品字体 + 系统中文字体,
 * 至少保证中文能显示,而不是"整段文字消失"。
 * ------------------------------------------------------------------------ */
const FONT_FAMILY_MAP: Record<string, string> = {
  projectdtypemedium: 'ProjectD Type',
  'projectdtype-medium': 'ProjectD Type',
  projectdtypecurvebold: 'ProjectD Type Curve',
  'projectdtypecurve-bold': 'ProjectD Type Curve',
};

function cssFontFamily(name: string | undefined): { family: string; weight: number } {
  const raw = (name || '').trim();
  const key = raw.toLowerCase();
  if (FONT_FAMILY_MAP[key]) {
    const fam = FONT_FAMILY_MAP[key];
    return { family: '"' + fam + '", "Microsoft YaHei", "PingFang SC", sans-serif', weight: fam === 'ProjectD Type Curve' ? 700 : 500 };
  }
  /* 未知字体:按名字里的 bold/curve 猜字重,family 落到产品字体 + 系统中文字体。
   * 这是"能看、能改"的最低保证;真要逐像素一致,只能把该字体也托管进项目。 */
  const bold = /bold|black|heavy|curve/i.test(raw);
  const fallback = bold ? 'ProjectD Type Curve' : 'ProjectD Type';
  return {
    family: '"' + fallback + '", "Microsoft YaHei", "PingFang SC", sans-serif',
    weight: bold ? 700 : 500,
  };
}

function clampColor(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function colorToHex(c: { r?: number; g?: number; b?: number } | undefined): string {
  if (!c) return '#000000';
  const to2 = (n: number | undefined): string => clampColor(n || 0).toString(16).padStart(2, '0');
  return '#' + to2(c.r) + to2(c.g) + to2(c.b);
}

/** ===================== 读取 ===================== */

export function loadPsdDocument(buffer: ArrayBuffer): PsdDocument {
  const bytes = buffer.byteLength;
  const psd = readPsd(buffer, {
    /* 用 imageData 而不是 canvas:ag-psd 说明里提到 canvas 的预乘 alpha 会破坏像素,
     * 而我们在"改颜色"时要把像素的 alpha 当蒙版用,必须拿到未预乘的原始值。 */
    useImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
    /* 只要图层像素:PSD 内嵌的合成预览不进内存(全画幅约 8MB,对我们没有用处)。 */
    skipCompositeImageData: true,
    logMissingFeatures: false,
    logDevFeatures: false,
  });

  const textLayers: PsdTextLayer[] = [];
  let seq = 0;

  function build(layer: Layer): PsdNode {
    const id = 'l' + (seq++);
    const node: PsdNode = {
      id,
      name: layer.name || '图层',
      group: !!(layer.children && layer.children.length),
      hidden: !!layer.hidden,
      opacity: typeof layer.opacity === 'number' ? layer.opacity : 1,
      blendMode: layer.blendMode || 'normal',
      clipping: !!layer.clipping,
      left: layer.left || 0,
      top: layer.top || 0,
      right: layer.right || 0,
      bottom: layer.bottom || 0,
    };
    if (node.group) {
      node.children = (layer.children || []).map(build);
      return node;
    }
    const px = (layer as Layer & { imageData?: PixelData }).imageData;
    if (px) {
      node.canvas = pixelDataToCanvas(px);
      applyLayerMask(node, layer);
    }
    if (layer.text) {
      const tl = makeTextLayer(id, layer, node.canvas);
      if (tl) {
        textLayers.push(tl);
        node.textLayer = tl;
      }
    }
    return node;
  }

  const root = (psd.children || []).map(build);
  markBackground(root, psd.width, psd.height);
  const screenNode = findScreenContent(root);
  const doc: PsdDocument = {
    width: psd.width,
    height: psd.height,
    root,
    textLayers,
    bytes,
    screenContent: screenNode && screenNode.canvas
      ? { canvas: screenNode.canvas, left: screenNode.left, top: screenNode.top, right: screenNode.right, bottom: screenNode.bottom }
      : undefined,
  };
  return doc;
}

function findScreenContent(nodes: PsdNode[]): PsdNode | undefined {
  for (const node of nodes) {
    if (node.isScreenContent) return node;
    if (node.children) {
      const found = findScreenContent(node.children);
      if (found) return found;
    }
  }
  return undefined;
}

/** 找出"能被换掉的背景图层":名字形如 Settlement_Sp_*、并且铺满整幅画布。
 * 结算图里它就是那张场景图(屏幕位置留透明,靠下层「形状 1」透出游戏画面)。 */
function markBackground(nodes: PsdNode[], width: number, height: number): boolean {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.group && node.children) {
      if (markBackground(node.children, width, height)) return true;
      continue;
    }
    if (/^Settlement_Sp_/i.test(node.name)
      && node.left <= 0 && node.top <= 0 && node.right >= width && node.bottom >= height) {
      node.isBackground = true;
      /* 结算图的背景图层会挖掉手机屏幕(透明),屏幕内容来自紧贴在它下面的那一层。
       * 记下这一层:换背景时要把它的内容对齐到新图片的屏幕挖孔上。 */
      const prev = nodes[i - 1];
      if (prev && !prev.group && !prev.hidden
        && prev.left < node.right && prev.right > node.left
        && prev.top < node.bottom && prev.bottom > node.top) {
        prev.isScreenContent = true;
      }
      return true;
    }
  }
  return false;
}

function pixelDataToCanvas(px: PixelData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = px.width;
  c.height = px.height;
  const ctx = c.getContext('2d');
  if (ctx) {
    /* 8 位 RGB 的 PixelArray 在这里就是 Uint8ClampedArray 语义的字节;
     * 重新包一个 ArrayBuffer 视图,避免 SharedArrayBuffer 的类型干扰。 */
    const bytes = new Uint8ClampedArray(px.data.buffer as ArrayBuffer, px.data.byteOffset, px.data.byteLength);
    ctx.putImageData(new ImageData(bytes, px.width, px.height), 0, 0);
  }
  return c;
}

/** 把图层蒙版乘进图层像素(alpha 相乘)。只有真的带蒙版的图层才会多一张临时画布。 */
function applyLayerMask(node: PsdNode, layer: Layer): void {
  const mask = layer.mask;
  if (!mask || mask.disabled || !mask.imageData || !node.canvas) return;
  const src = node.canvas;
  const mw = mask.imageData.width;
  const mh = mask.imageData.height;
  if (!mw || !mh) return;
  /* 蒙版像素是灰度(RGB 都等于遮罩值,alpha 恒为 255),要把它转成"alpha = 灰度",
   * 再 destination-in 乘进图层。直接 destination-in 会按 alpha 蒙版(全 1)等于没蒙。 */
  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = mw;
  alphaCanvas.height = mh;
  const actx = alphaCanvas.getContext('2d');
  if (!actx) return;
  const md = mask.imageData.data;
  const out = new ImageData(mw, mh);
  for (let i = 0; i < md.length; i += 4) {
    out.data[i + 3] = md[i];
  }
  actx.putImageData(out, 0, 0);

  /* 蒙版位置:positionRelativeToLayer 时相对图层左上角,否则是文档坐标。
   * 换算到图层自身的画布坐标后再画。 */
  const maskLeft = mask.positionRelativeToLayer ? (mask.left || 0) : (mask.left || 0) - node.left;
  const maskTop = mask.positionRelativeToLayer ? (mask.top || 0) : (mask.top || 0) - node.top;

  const ctx = src.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(alphaCanvas, maskLeft, maskTop);
  ctx.restore();
}

function makeTextLayer(uid: string, layer: Layer, canvas?: HTMLCanvasElement): PsdTextLayer | null {
  const data = layer.text;
  if (!data || !canvas) return null;
  const style: TextStyle = data.style || {};
  const para: ParagraphStyle = data.paragraphStyle || {};
  const fam = cssFontFamily(style.font?.name);
  const m = data.transform;
  const scale = m && m.length === 6 ? Math.abs(m[3] || m[0] || 1) : 1;
  const size = (style.fontSize || 38) * scale;
  return {
    uid,
    name: layer.name || '文字',
    text: String(data.text ?? ''),
    color: colorToHex(style.fillColor as { r?: number; g?: number; b?: number } | undefined),
    layerOpacity: typeof layer.opacity === 'number' ? layer.opacity : 1,
    fontSize: size,
    family: fam.family,
    weight: fam.weight,
    left: layer.left || 0,
    top: layer.top || 0,
    right: layer.right || 0,
    bottom: layer.bottom || 0,
    canvas,
    data,
    hidden: !!layer.hidden,
  };
}

/** ===================== 渲染 ===================== */

export type RenderOptions = {
  /** 目标画布(尺寸必须等于文档尺寸;由调用方复用) */
  ctx: CanvasRenderingContext2D;
  /** 文字改动表(uid -> 状态);没传就按原样绘制 */
  edits?: Map<string, TextEditState>;
  /** 强制重排文字图层(自检用:验证字体与字形是否对得上)。true = 全部,Set = 指定 uid */
  forceTextRerender?: boolean | Set<string>;
  /** 替换背景图层的图片(不传则画 PSD 自带的那一张)。图片按"铺满图层边界"裁切绘制。 */
  background?: CanvasImageSource;
  /** 先铺一层不透明底色再画图层:结算图是整幅场景,导出 PNG 不该在屏幕边缘留半透明像素。 */
  backgroundFill?: string;
};

export function renderDocument(doc: PsdDocument, opts: RenderOptions): void {
  const ctx = opts.ctx;
  ctx.save();
  ctx.clearRect(0, 0, doc.width, doc.height);
  if (opts.backgroundFill) {
    ctx.fillStyle = opts.backgroundFill;
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  paintNodeList(ctx, doc.root, opts.edits, 1, opts.forceTextRerender, opts.background);
  ctx.restore();
}

function paintNodeList(
  ctx: CanvasRenderingContext2D,
  nodes: PsdNode[],
  edits: Map<string, TextEditState> | undefined,
  inheritedAlpha: number,
  forceText: boolean | Set<string> | undefined,
  background: CanvasImageSource | undefined,
): void {
  for (const node of nodes) {
    if (node.hidden) continue;
    const alpha = inheritedAlpha * node.opacity;
    if (alpha <= 0) continue;
    if (node.group && node.children) {
      /* 组透明度/混合模式不是 normal 时,租一块临时画布单独合成,再按组透明度贴回去 ——
       * 直接乘到子图层上在子图层互相重叠处会错(透明度该对"整组的结果"生效)。 */
      if (node.opacity < 1 || node.blendMode !== 'normal') {
        const g = document.createElement('canvas');
        g.width = Math.max(1, Math.round(node.right - node.left));
        g.height = Math.max(1, Math.round(node.bottom - node.top));
        const gctx = g.getContext('2d');
        if (!gctx) continue;
        gctx.translate(-node.left, -node.top);
        paintNodeList(gctx, node.children, edits, 1, forceText, background);
        ctx.save();
        ctx.globalAlpha = inheritedAlpha * node.opacity;
        ctx.globalCompositeOperation = blendModeToComposite(node.blendMode);
        ctx.drawImage(g, node.left, node.top);
        ctx.restore();
      } else {
        paintNodeList(ctx, node.children, edits, alpha, forceText, background);
      }
      continue;
    }
    if (node.isBackground && background) {
      /* 背景替换:图片自带的透明区(结算图的手机屏幕)照常留空,
       * 让下层「形状 1」的屏幕内容透出来 —— 与 PSD 自己的背景是同一套叠加关系。 */
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = blendModeToComposite(node.blendMode);
      drawImageCover(ctx, background, node.left, node.top, Math.max(1, node.right - node.left), Math.max(1, node.bottom - node.top));
      ctx.restore();
      continue;
    }
    if (!node.canvas) continue;
    const tl = node.textLayer;
    if (tl) {
      const edit = edits ? edits.get(tl.uid) : undefined;
      const force = forceText === true || (forceText instanceof Set && forceText.has(tl.uid));
      drawTextNode(ctx, node, tl, edit, alpha, force);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = blendModeToComposite(node.blendMode);
    ctx.drawImage(node.canvas, node.left, node.top);
    ctx.restore();
  }
}

function drawTextNode(
  ctx: CanvasRenderingContext2D,
  node: PsdNode,
  tl: PsdTextLayer,
  edit: TextEditState | undefined,
  alpha: number,
  forceText: boolean,
): void {
  ctx.save();
  ctx.globalCompositeOperation = blendModeToComposite(node.blendMode);
  const contentChanged = forceText || (!!edit && edit.text !== tl.text);
  const colorChanged = !!edit && edit.color.toLowerCase() !== tl.color.toLowerCase();
  if (contentChanged) {
    ctx.globalAlpha = alpha;
    drawTextContent(ctx, tl, edit && edit.text !== tl.text ? edit.text : tl.text, edit ? edit.color : tl.color);
  } else if (colorChanged) {
    /* 颜色:用原像素的 alpha 当蒙版填新色 —— 字形、抗锯齿边缘、描边都和 Photoshop 一致,
     * 比"用 canvas 重排一遍"保真得多。 */
    const tinted = tintLayerCanvas(tl.canvas, edit!.color);
    ctx.globalAlpha = alpha;
    ctx.drawImage(tinted, node.left, node.top);
  } else {
    ctx.globalAlpha = alpha;
    ctx.drawImage(tl.canvas, node.left, node.top);
  }
  ctx.restore();
}

/** 把任意图片按"铺满目标矩形"裁切绘制(等比,居中裁边),不拉伸。 */
function drawImageCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void {
  const iw = (img as HTMLImageElement).naturalWidth || (img as HTMLCanvasElement).width || 0;
  const ih = (img as HTMLImageElement).naturalHeight || (img as HTMLCanvasElement).height || 0;
  if (!iw || !ih) { ctx.drawImage(img, dx, dy, dw, dh); return; }
  const scale = Math.max(dw / iw, dh / ih);
  const sw = dw / scale;
  const sh = dh / scale;
  const sx = (iw - sw) / 2;
  const sy = (ih - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

function tintLayerCanvas(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d');
  if (!ctx) return src;
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/** 按 Photoshop 的文字引擎参数重排一段文字。坐标系是"文字空间",由 transform 映射到文档。 */
function drawTextContent(ctx: CanvasRenderingContext2D, tl: PsdTextLayer, text: string, color: string): void {
  const data = tl.data;
  const style: TextStyle = data.style || {};
  const para: ParagraphStyle = data.paragraphStyle || {};
  const m = data.transform;
  if (!m || m.length !== 6) {
    return;
  }
  const fam = cssFontFamily(style.font?.name);
  const fontSize = style.fontSize || 38;
  const tracking = ((style.tracking ?? 0) / 1000) * fontSize;
  const justifyRaw = (para.justification || 'left') as string;
  const justify = justifyRaw.indexOf('center') >= 0 ? 'center' : justifyRaw.indexOf('right') >= 0 ? 'right' : 'left';
  const autoLeading = style.autoLeading !== false;
  const leading = !autoLeading && typeof style.leading === 'number'
    ? style.leading
    : (para.autoLeading && para.autoLeading > 0 ? para.autoLeading * fontSize : fontSize * 1.2);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const fauxBold = !!style.fauxBold;
  const fauxItalic = !!style.fauxItalic;

  ctx.save();
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.font = (fauxBold ? '700 ' : fam.weight + ' ') + fontSize + 'px ' + fam.family;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  if (fauxItalic) {
    /* 伪斜体:Photoshop 用 12° 剪切,canvas 没有直接开关,用 setTransform 叠一层斜切 */
    const shear = 0.21;
    ctx.transform(1, 0, shear, 1, 0, 0);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const chars = Array.from(line);
    const widths: number[] = [];
    let total = 0;
    for (const ch of chars) {
      const w = ctx.measureText(ch).width;
      widths.push(w);
      total += w + tracking;
    }
    if (chars.length) total -= tracking;
    let x = justify === 'center' ? -total / 2 : justify === 'right' ? -total : 0;
    const y = i * leading;
    /* 逐字绘制:tracking(字距)在 canvas 上没有与 Photoshop 同单位的接口,
     * 而且逐字绘制能让中英混排的字距与引擎值一致(代价是不吃连字,可接受)。 */
    for (let k = 0; k < chars.length; k++) {
      ctx.fillText(chars[k], x, y);
      x += widths[k] + tracking;
    }
  }
  ctx.restore();
}

/* 混合模式:PSD 的 normal 之外,只映射最常用的几种;其余按 normal 处理(简单编辑够用) */
function blendModeToComposite(mode: string): GlobalCompositeOperation {
  switch (mode) {
    case 'multiply': return 'multiply';
    case 'screen': return 'screen';
    case 'overlay': return 'overlay';
    case 'darken': return 'darken';
    case 'lighten': return 'lighten';
    case 'color-dodge': return 'color-dodge';
    case 'color-burn': return 'color-burn';
    case 'hard-light': return 'hard-light';
    case 'soft-light': return 'soft-light';
    case 'difference': return 'difference';
    case 'exclusion': return 'exclusion';
    default: return 'source-over';
  }
}

/** ===================== 导出 ===================== */

/** 渲染成一张指定尺寸的 canvas(导出 PNG 用,scale=1 即 PSD 原尺寸) */
export function renderToCanvas(
  doc: PsdDocument,
  edits: Map<string, TextEditState>,
  background?: CanvasImageSource,
  backgroundFill?: string,
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = doc.width;
  c.height = doc.height;
  const ctx = c.getContext('2d');
  if (ctx) renderDocument(doc, { ctx, edits, background, backgroundFill });
  return c;
}

/** 由文档建一份初始状态表(全部是原值,不改) */
export function createEditMap(doc: PsdDocument): Map<string, TextEditState> {
  const map = new Map<string, TextEditState>();
  for (const tl of doc.textLayers) {
    map.set(tl.uid, {
      text: tl.text,
      color: tl.color,
      opacity: tl.layerOpacity,
      dirty: false,
    });
  }
  return map;
}
