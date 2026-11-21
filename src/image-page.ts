/* ============================================================================
 * 图片编辑器(src/image-page.ts)
 * ---------------------------------------------------------------------------
 * 应用里的第二个编辑器:打开应用内置的结算图 PSD(pictures/settlement/settlement.psd),
 * 改文字图层的内容 / 颜色 / 透明度,导出 PNG。与动画编辑器完全独立 —— 它不 import
 * main.ts,只依赖 src/psd-document.ts(解析与合成)和本目录的 image-page.css。
 *
 * 这个页面刻意只做一件事:用户不需要选文件、也不需要把结果存回 PSD。示例图是应用的一部分,
 * 进来就是它;输出只有 PNG。
 *
 * 画布交互与动画编辑器同一套模型:
 *   · baseScale = 适配缩放(contain),viewZoom = 用户滚轮倍数,viewPan = 屏幕像素平移;
 *   · 最终 transform 只写在 .imged-scale 上(translate(pan) scale(baseScale * viewZoom));
 *   · 滚轮以鼠标位置为中心缩放,拖动平移,双击复位。
 * ========================================================================== */
import './image-page.css';
import {
  loadPsdDocument,
  renderDocument,
  createEditMap,
  renderToCanvas,
  type PsdDocument,
  type PsdTextLayer,
  type TextEditState,
} from './psd-document';
/* 内置示例就是仓库里的 pictures/settlement/settlement.psd,由 Vite 当静态资源输出。
 * 用 ?url 而不是放到 public/:产物带 hash,部署到子路径也不会失效。 */
import samplePsdUrl from '../pictures/settlement/settlement.psd?url';
import cardManifestRaw from '../pictures/cards/manifest.json?raw';
import {
  warpImageToQuad,
  quadKey,
  quadCenter,
  translateQuad,
  rotateQuadAround,
  type Quad,
} from './card-quad';
import {
  loadCardOriginal,
  cachedCard,
  sourceLabel,
  type RemoteSource,
} from './card-remote';
/* 背景图片来自 TFR-Studios/DFAsset 仓库的 settlement/ 目录(与 PSD 里的 Settlement_Sp_11
 * 同源)。打包成静态资源随应用分发:编辑器离线也能换背景,不依赖 GitCode 的可用性。
 * 目录里新增图片时,在这里补一项即可。 */
import bgDefault from '../pictures/settlement/backgrounds/Settlement_Sp_11.png?url';
import bgBoss from '../pictures/settlement/backgrounds/Boss_c601_Settlement_Sp_08.png?url';
import bg21 from '../pictures/settlement/backgrounds/Settlement_Sp_21.png?url';
import bg40 from '../pictures/settlement/backgrounds/Settlement_Sp_40.png?url';

type BackgroundOption = {
  /** 与 PSD 图层名一致的那张是默认背景(不覆盖,直接用 PSD 原像素) */
  id: string;
  label: string;
  file: string;
  url: string;
};

const BACKGROUNDS: BackgroundOption[] = [
  { id: 'Settlement_Sp_11', label: '默认', file: 'Settlement_Sp_11.png', url: bgDefault },
  { id: 'Boss_c601_Settlement_Sp_08', label: '首领', file: 'Boss_c601_Settlement_Sp_08.png', url: bgBoss },
  { id: 'Settlement_Sp_21', label: '场景 21', file: 'Settlement_Sp_21.png', url: bg21 },
  { id: 'Settlement_Sp_40', label: '场景 40', file: 'Settlement_Sp_40.png', url: bg40 },
];

/* ---------------------------------------------------------------------------
 * 名片素材(来自 TFR-Studios/DFAsset 的 Commerical/BusinessFiller 与 Commerical/Skin)
 * 打包里只有 manifest.json + 160px 缩略图(约 1.3MB);选中名片时按需从 GitCode
 * 拉原图(card-remote.ts,Cache Storage 按 commit sha 缓存),断网回退本地缩略图。
 * ------------------------------------------------------------------------ */
type CardCategory = 'business' | 'skin';
type CardEntry = {
  id: string;
  category: CardCategory;
  group: string;
  file: string;
  thumb?: string;
  label: string;
  width: number;
  height: number;
};

const CARD_ENTRIES: CardEntry[] = JSON.parse(cardManifestRaw) as CardEntry[];
const CARD_BY_ID = new Map(CARD_ENTRIES.map((c) => [c.id, c]));
const CARD_COUNTS = {
  all: CARD_ENTRIES.length,
  business: CARD_ENTRIES.filter((c) => c.category === 'business').length,
  skin: CARD_ENTRIES.filter((c) => c.category === 'skin').length,
};
const CARD_THUMB_GLOB = import.meta.glob('../pictures/cards/thumbs/**/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const CARD_THUMB_URLS: Record<string, string> = {};
for (const [key, url] of Object.entries(CARD_THUMB_GLOB)) {
  CARD_THUMB_URLS[key.replace(/^.*\/pictures\/cards\//, '')] = url;
}
/* 选择器用 160px 缩略图:190 张全解码也只有约 40MB;选中后才在线拉原图做透视。 */
function cardThumbUrl(entry: CardEntry): string {
  return (entry.thumb && CARD_THUMB_URLS[entry.thumb]) || '';
}

const CARD_PLACEHOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-4.5-4.5L7 20"/></svg>';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

type El = {
  mount: HTMLElement;
  barMeta: HTMLElement;
  stage: HTMLElement;
  canvasWrap: HTMLElement;
  scaleLayer: HTMLElement;
  canvas: HTMLCanvasElement;
  selBox: HTMLElement;
  zoom: HTMLElement;
  zoomValue: HTMLElement;
  empty: HTMLElement;
  loading: HTMLElement;
  loadingText: HTMLElement;
  progressBar: HTMLElement;
  progressFill: HTMLElement;
  status: HTMLElement;
  panel: HTMLElement;
  bgGrid: HTMLElement;
  list: HTMLElement;
  count: HTMLElement;
  inspector: HTMLElement;
  selName: HTMLElement;
  selMeta: HTMLElement;
  textarea: HTMLTextAreaElement;
  color: HTMLInputElement;
  hex: HTMLInputElement;
  opacity: HTMLInputElement;
  opacityPct: HTMLElement;
  cardModes: HTMLElement;
  cardModeButtons: HTMLButtonElement[];
  cardNote: HTMLElement;
  cardQuad: SVGSVGElement;
  cardQuadFill: SVGPolygonElement;
  cardQuadLine: SVGLineElement;
  cardQuadCorners: SVGCircleElement[];
  cardRotateHandle: SVGCircleElement;
  cardResetRect: HTMLButtonElement;
  cardCurrent: HTMLButtonElement;
  cardThumb: HTMLElement;
  cardName: HTMLElement;
  cardSource: HTMLElement;
  cardMeta: HTMLElement;
  cardGo: HTMLElement;
  cardClear: HTMLButtonElement;
  picker: HTMLDialogElement;
  pickerGrid: HTMLElement;
  pickerSearch: HTMLInputElement;
  pickerClear: HTMLButtonElement;
  pickerCount: HTMLElement;
  pickerEmpty: HTMLElement;
  pickerTabs: HTMLElement;
  btnReset: HTMLButtonElement;
  btnPng: HTMLButtonElement;
  btnPngText: HTMLElement;
  btnReveal: HTMLButtonElement;
  btnRestore: HTMLButtonElement;
  result: HTMLElement;
  live: HTMLElement;
  resultTitle: HTMLElement;
  resultName: HTMLElement;
  resultNote: HTMLElement;
  resultReveal: HTMLButtonElement;
  resultRetry: HTMLButtonElement;
  resultClose: HTMLButtonElement;
};

let els: El | null = null;
let doc: PsdDocument | null = null;
let edits = new Map<string, TextEditState>();
let selectedUid = '';
let initialized = false;
let loading = false;
let exporting = false;
type SaveResult = { name: string; id?: string; path?: string; size?: number };
/** 上一次成功落盘的文件(桌面端带 id/path,用来"打开文件夹") */
let lastExport: SaveResult | null = null;
let loadSeq = 0;
let rafId = 0;
/* 背景选择:0 = PSD 自带的 Settlement_Sp_11(不覆盖),其它是 DFAsset/settlement 里的图片 */
let bgIndex = 0;
/* 换背景时预先合成好的"背景 + 黑色屏幕 + 手机屏幕内容"整幅画布。 */
const bgComposed: (HTMLCanvasElement | undefined)[] = [];
/* 名片:三种缩放方式 + 用户实测的默认透视四角。 */
type CardMode = 'proportional' | 'free' | 'perspective';
type CardBase = { x: number; y: number; width: number; height: number; rotation: number };
const CARD_DEFAULT_QUAD: Quad = [
  { x: 1126, y: 230 },
  { x: 1454, y: 279 },
  { x: 1369, y: 828 },
  { x: 1030, y: 771 },
];
let selectedCardId = '';
let cardMode: CardMode = 'perspective';
let cardQuad: Quad = CARD_DEFAULT_QUAD.map((p) => ({ ...p })) as Quad;
let cardBase: CardBase = baseFromQuad(CARD_DEFAULT_QUAD);
let cardNaturalWidth = 384;
let cardNaturalHeight = 617;
let cardBusy = false;
let cardSource: RemoteSource | null = null;
let cardLoading = '';
let cardTab: 'all' | 'business' | 'skin' = 'all';
let cardRenderRaf = 0;
const cardWarpCanvas = document.createElement('canvas');
const cardClipCanvas = document.createElement('canvas');
let cardWarpKey = '';
let cardWarped: HTMLCanvasElement | null = null;
let cardMaskIndex = -1;
let cardMask: HTMLCanvasElement | null = null;
type CardDrag = {
  mode: 'move' | 'corner' | 'rotate';
  corner: number;
  pointerId: number;
  startX: number;
  startY: number;
  startDocX: number;
  startDocY: number;
  startQuad: Quad;
  startBase: CardBase;
  startAngle: number;
  centerScreenX: number;
  centerScreenY: number;
  scale: number;
};
let cardDrag: CardDrag | null = null;
const cardImages = new Map<string, HTMLImageElement>();
const DEFAULT_BG_INDEX = 0;
let layerRefs = new Map<string, { btn: HTMLButtonElement; name: HTMLElement; snippet: HTMLElement; dirty: HTMLElement; swatch: HTMLElement }>();

/* 屏幕画布与合成画布分开:
 *   · composite 是文档原尺寸的合成结果,重绘只写它;
 *   · canvas 是屏幕上的那张,每次把 composite 1:1 铺上去;
 *   · 缩放/平移只改 .imged-scale 的 transform(与动画编辑器同一套,不改位图尺寸)。 */
const composite = document.createElement('canvas');
const compositeCtx = composite.getContext('2d');
/* 不含名片的底层场景:拖动/缩放名片时只复制它再画名片,不用重复渲染 13 个图层。 */
const baseScene = document.createElement('canvas');
const baseSceneCtx = baseScene.getContext('2d');

/* ---------- 视图状态(与 main.ts 的 baseScale / viewZoom / viewPan 同构)---------- */
let baseScale = 1;
let viewZoom = 1;
let viewPanX = 0;
let viewPanY = 0;
let lastTransform = '';
let lastZoomText = '';
let panning = false;
let panStartX = 0;
let panStartY = 0;
let panOrigX = 0;
let panOrigY = 0;

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

function fmtBytes(n: number): string {
  if (!n || n < 1024) return (n || 0) + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

const CARD_CODE_TOKENS = new Set(['vx', '4i', '7l', '5g', '6c', 'ob', 'hc', 'nk', 'i1', 'cd', 'dg', 'lc']);

function cardDisplayLabel(entry: CardEntry): string {
  if (entry.category === 'skin') return entry.label;
  const parts = entry.label.split(/\s+/);
  if (parts.length > 1 && (/^Ma\d+/i.test(parts[0]) || /^she4$/i.test(parts[0]))) parts.shift();
  while (parts.length > 1 && CARD_CODE_TOKENS.has(parts[0].toLowerCase())) parts.shift();
  return parts.join(' ') || entry.label;
}

function cardPickerItemsHtml(): string {
  return CARD_ENTRIES.map((entry) =>
    '<button type="button" class="imged-card-item" data-card-id="' + esc(entry.id) + '" data-category="' + entry.category + '" title="' + esc(cardDisplayLabel(entry)) + '" aria-pressed="false">' +
      '<span class="imged-card-thumb" aria-hidden="true"><img src="' + cardThumbUrl(entry) + '" alt="" loading="lazy" decoding="async" draggable="false" /></span>' +
      '<span class="imged-card-item-label">' + esc(cardDisplayLabel(entry)) + '</span>' +
      '<span class="imged-card-item-group">' + esc(entry.group) + '</span>' +
    '</button>').join('');
}

/* ==================== 页面骨架 ==================== */

export function initImagePage(): void {
  if (initialized) return;
  const mount = $('imgedMount');
  if (!mount) return;
  initialized = true;
  mount.innerHTML =
    '<div class="imged">' +
      '<header class="imged-bar">' +
        '<div class="imged-head">' +
          '<h1 class="imged-title" id="imgedTitle">图片编辑器</h1>' +
          '<p class="imged-meta" id="imgedMeta">内置结算图 · 改文字内容 / 颜色 / 透明度</p>' +
        '</div>' +
        '<div class="imged-actions">' +
          '<button type="button" class="imged-btn imged-btn-quiet" data-imged="reveal" hidden title="打开上一次导出的文件所在文件夹">' +
            '<svg class="imged-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/></svg>' +
            '<span>打开文件夹</span>' +
          '</button>' +
          '<span class="imged-actions-sep" aria-hidden="true"></span>' +
          '<button type="button" class="imged-btn" data-imged="reset" disabled>撤销修改</button>' +
          '<button type="button" class="imged-btn imged-btn-primary" data-imged="export-png" disabled>' +
            '<span class="imged-btn-spinner" aria-hidden="true"></span>' +
            '<span class="imged-btn-text">导出 PNG</span>' +
          '</button>' +
        '</div>' +
      '</header>' +
      '<p class="sr-only imged-live" role="status" aria-live="polite" aria-atomic="true"></p>' +
      '<div class="imged-body">' +
        '<section class="imged-stage" aria-label="PSD 预览">' +
          '<div class="imged-canvas-wrap" hidden>' +
            '<div class="imged-scale">' +
              '<canvas class="imged-canvas" role="img" aria-label="PSD 合成预览"></canvas>' +
            '</div>' +
          '</div>' +
          '<div class="imged-sel-box" hidden aria-hidden="true"></div>' +
          '<svg class="imged-card-quad" hidden aria-hidden="true" focusable="false">' +
            '<polygon class="imged-card-quad-fill"></polygon>' +
            '<line class="imged-card-rotate-line"></line>' +
            '<circle class="imged-card-corner" data-card-corner="0" r="6"></circle>' +
            '<circle class="imged-card-corner" data-card-corner="1" r="6"></circle>' +
            '<circle class="imged-card-corner" data-card-corner="2" r="6"></circle>' +
            '<circle class="imged-card-corner" data-card-corner="3" r="6"></circle>' +
            '<circle class="imged-card-rotate-handle" data-card-corner="rotate" r="9"></circle>' +
          '</svg>' +
          '<div class="imged-zoom" hidden>' +
            '<button type="button" class="imged-zoom-btn" data-imged="zoom-out" title="缩小" aria-label="缩小">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14"/></svg>' +
            '</button>' +
            '<span class="imged-zoom-value">100%</span>' +
            '<button type="button" class="imged-zoom-btn" data-imged="zoom-in" title="放大" aria-label="放大">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 5v14"/><path d="M5 12h14"/></svg>' +
            '</button>' +
            '<button type="button" class="imged-zoom-fit" data-imged="zoom-fit" title="适应窗口(双击预览也可复位)">适应</button>' +
          '</div>' +
          '<div class="imged-result" hidden role="region" aria-label="导出结果">' +
            '<span class="imged-result-icon" aria-hidden="true">' +
              '<svg class="imged-result-ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.4 2.6 2.6 4.6-5.2"/></svg>' +
              '<svg class="imged-result-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16.5h.01"/></svg>' +
            '</span>' +
            '<div class="imged-result-body">' +
              '<p class="imged-result-title"></p>' +
              '<p class="imged-result-name imged-mono"></p>' +
              '<p class="imged-result-note"></p>' +
            '</div>' +
            '<button type="button" class="imged-result-close" data-imged="result-close" title="关闭提示" aria-label="关闭导出提示">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>' +
            '</button>' +
            '<div class="imged-result-actions">' +
              '<button type="button" class="imged-btn imged-btn-primary imged-btn-sm" data-imged="reveal" hidden>打开文件夹</button>' +
              '<button type="button" class="imged-btn imged-btn-sm" data-imged="retry-export" hidden>再试一次</button>' +
            '</div>' +
          '</div>' +
          '<div class="imged-empty">' +
            '<span class="imged-empty-ico" aria-hidden="true">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-4.5-4.5L7 20"/></svg>' +
            '</span>' +
            '<p class="imged-empty-title">内置示例还没载入</p>' +
            '<p class="imged-empty-desc">图片编辑器打开的是应用内置的结算图(撤离结算 / settlement.psd)。如果刚才没载入成功,可以点下面重试。</p>' +
            '<div class="imged-empty-actions">' +
              '<button type="button" class="imged-btn imged-btn-primary" data-imged="sample">重新载入示例</button>' +
            '</div>' +
          '</div>' +
          '<div class="imged-loading" hidden>' +
            '<span class="imged-spinner" aria-hidden="true"></span>' +
            '<span class="imged-loading-text">正在读取 PSD…</span>' +
            '<span class="imged-progress"><span class="imged-progress-fill"></span></span>' +
          '</div>' +
          '<p class="imged-status" role="status" aria-live="polite" hidden></p>' +
        '</section>' +
        '<aside class="imged-panel" aria-label="背景、名片与文字图层" hidden>' +
          '<div class="imged-bg">' +
            '<div class="imged-bg-head"><span>背景</span><span class="imged-bg-note">DFAsset · settlement</span></div>' +
            '<div class="imged-bg-grid" role="group" aria-label="背景图片">' +
              BACKGROUNDS.map((bg, i) =>
                '<button type="button" class="imged-bg-item' + (i === 0 ? ' is-selected' : '') + '" data-bg="' + i + '" title="' + bg.file + '" aria-label="背景:' + bg.file + '" aria-pressed="' + (i === 0 ? 'true' : 'false') + '">' +
                  '<img src="' + bg.url + '" alt="" draggable="false" />' +
                  '<span class="imged-bg-tag">' + bg.label + '</span>' +
                '</button>').join('') +
            '</div>' +
          '</div>' +
          '<div class="imged-card">' +
            '<div class="imged-card-head"><span>名片</span><span class="imged-bg-note">DFAsset</span>' +
              '<div class="imged-card-modes" role="group" aria-label="名片缩放方式" hidden>' +
                '<button type="button" class="imged-card-mode" data-card-mode="proportional" aria-pressed="false">等比</button>' +
                '<button type="button" class="imged-card-mode" data-card-mode="free" aria-pressed="false">自由</button>' +
                '<button type="button" class="imged-card-mode is-active" data-card-mode="perspective" aria-pressed="true">透视</button>' +
              '</div>' +
              '<button type="button" class="imged-card-reset" data-imged="reset-card-quad" hidden title="回到默认四角" aria-label="复位名片四角">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>' +
              '</button>' +
              '<button type="button" class="imged-card-clear" data-imged="clear-card" hidden>' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>' +
              '<span>恢复默认</span>' +
            '</button></div>' +
            '<button type="button" class="imged-card-current" data-imged="pick-card" aria-label="选择名片">' +
              '<span class="imged-card-thumb" aria-hidden="true">' + CARD_PLACEHOLDER + '</span>' +
              '<span class="imged-card-main"><span class="imged-card-name">选择名片</span><span class="imged-card-source"></span><span class="imged-card-meta">从 ' + CARD_COUNTS.business + ' 张名片 / ' + CARD_COUNTS.skin + ' 张皮肤中选择</span></span>' +
              '<span class="imged-card-go">选择</span>' +
            '</button>' +
          '</div>' +
          '<div class="imged-panel-head"><span>文字图层</span><span class="imged-count">0</span></div>' +
          '<ul class="imged-layers"></ul>' +
          '<div class="imged-inspector" hidden>' +
            '<div class="imged-inspector-head">' +
            '<span class="imged-sel-info"><span class="imged-sel-name">—</span><span class="imged-sel-meta"></span></span>' +
            '<button type="button" class="imged-btn imged-btn-sm" data-imged="restore">恢复原样</button>' +
          '</div>' +
            '<label class="imged-field"><span class="imged-label">文字内容</span><textarea class="imged-text" rows="2" spellcheck="false"></textarea></label>' +
            '<div class="imged-grid">' +
              '<div class="imged-field"><span class="imged-label">颜色</span><span class="imged-color-row"><input type="color" class="imged-color" /><input type="text" class="imged-hex imged-mono" maxlength="7" spellcheck="false" aria-label="颜色十六进制值" /></span></div>' +
              '<label class="imged-field"><span class="imged-label">透明度 <b class="imged-pct">100%</b></span><input type="range" class="imged-range" min="0" max="100" step="1" /></label>' +
            '</div>' +
          '</div>' +
          '<p class="imged-hint">滚轮缩放 · 拖动平移 · 双击复位。只改颜色保留原始字形边缘;改内容按图层字体重排。</p>' +
        '</aside>' +
      '</div>' +
      '<dialog class="imged-picker" id="imgedPicker" aria-labelledby="imgedPickerTitle">' +
        '<div class="imged-picker-head">' +
          '<div class="imged-picker-title-wrap">' +
            '<h2 class="imged-picker-title" id="imgedPickerTitle">选择名片</h2>' +
            '<p class="imged-picker-sub">' + CARD_COUNTS.business + ' 张名片 · ' + CARD_COUNTS.skin + ' 张皮肤 · 素材来自 DFAsset</p>' +
          '</div>' +
          '<button type="button" class="imged-picker-close" data-imged="close-card-picker" title="关闭(Esc)" aria-label="关闭名片选择器">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="imged-picker-tools">' +
          '<div class="imged-picker-search">' +
            '<svg class="imged-picker-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
            '<input type="search" id="imgedCardSearch" class="imged-picker-input" placeholder="搜索角色 / 分组 / 文件名" autocomplete="off" spellcheck="false" aria-label="搜索名片" />' +
            '<button type="button" class="imged-picker-clear" data-imged="clear-card-search" title="清空搜索" aria-label="清空搜索" hidden>' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>' +
            '</button>' +
          '</div>' +
          '<div class="imged-picker-tabs" role="group" aria-label="名片分类">' +
            '<button type="button" class="imged-picker-tab is-active" data-card-tab="all" aria-pressed="true">全部 <b>' + CARD_COUNTS.all + '</b></button>' +
            '<button type="button" class="imged-picker-tab" data-card-tab="business" aria-pressed="false">名片 <b>' + CARD_COUNTS.business + '</b></button>' +
            '<button type="button" class="imged-picker-tab" data-card-tab="skin" aria-pressed="false">皮肤 <b>' + CARD_COUNTS.skin + '</b></button>' +
          '</div>' +
          '<span class="imged-picker-count" aria-live="polite">显示 ' + CARD_COUNTS.all + ' / ' + CARD_COUNTS.all + '</span>' +
        '</div>' +
        '<div class="imged-picker-body">' +
          '<div class="imged-picker-grid" id="imgedCardGrid" role="group" aria-label="名片列表">' + cardPickerItemsHtml() + '</div>' +
          '<p class="imged-picker-empty" hidden>没有匹配的名片。试试换个关键词,或切回「全部」。</p>' +
        '</div>' +
      '</dialog>' +
    '</div>';

  const q = <T extends Element>(sel: string): T => {
    const el = mount.querySelector(sel);
    if (!el) throw new Error('图片编辑器缺少节点:' + sel);
    return el as T;
  };
  els = {
    mount,
    barMeta: q('#imgedMeta'),
    stage: q('.imged-stage'),
    canvasWrap: q('.imged-canvas-wrap'),
    scaleLayer: q('.imged-scale'),
    canvas: q<HTMLCanvasElement>('.imged-canvas'),
    selBox: q('.imged-sel-box'),
    zoom: q('.imged-zoom'),
    zoomValue: q('.imged-zoom-value'),
    empty: q('.imged-empty'),
    loading: q('.imged-loading'),
    loadingText: q('.imged-loading-text'),
    progressBar: q('.imged-progress'),
    progressFill: q('.imged-progress-fill'),
    status: q('.imged-status'),
    panel: q('.imged-panel'),
    bgGrid: q('.imged-bg-grid'),
    list: q('.imged-layers'),
    count: q('.imged-count'),
    inspector: q('.imged-inspector'),
    selName: q('.imged-sel-name'),
    selMeta: q('.imged-sel-meta'),
    textarea: q<HTMLTextAreaElement>('.imged-text'),
    color: q<HTMLInputElement>('.imged-color'),
    hex: q<HTMLInputElement>('.imged-hex'),
    opacity: q<HTMLInputElement>('.imged-range'),
    opacityPct: q('.imged-pct'),
    cardModes: q('.imged-card-modes'),
    cardModeButtons: [...mount.querySelectorAll<HTMLButtonElement>('[data-card-mode]')],
    cardNote: q('.imged-card-head .imged-bg-note'),
    cardQuad: q<SVGSVGElement>('.imged-card-quad'),
    cardQuadFill: q<SVGPolygonElement>('.imged-card-quad-fill'),
    cardQuadLine: q<SVGLineElement>('.imged-card-rotate-line'),
    cardQuadCorners: [...mount.querySelectorAll<SVGCircleElement>('.imged-card-corner')],
    cardRotateHandle: q<SVGCircleElement>('.imged-card-rotate-handle'),
    cardResetRect: q<HTMLButtonElement>('[data-imged="reset-card-quad"]'),
    cardCurrent: q<HTMLButtonElement>('[data-imged="pick-card"]'),
    cardThumb: q('.imged-card-current .imged-card-thumb'),
    cardName: q('.imged-card-name'),
    cardSource: q('.imged-card-source'),
    cardMeta: q('.imged-card-meta'),
    cardGo: q('.imged-card-go'),
    cardClear: q<HTMLButtonElement>('[data-imged="clear-card"]'),
    picker: q<HTMLDialogElement>('.imged-picker'),
    pickerGrid: q('.imged-picker-grid'),
    pickerSearch: q<HTMLInputElement>('#imgedCardSearch'),
    pickerClear: q<HTMLButtonElement>('[data-imged="clear-card-search"]'),
    pickerCount: q('.imged-picker-count'),
    pickerEmpty: q('.imged-picker-empty'),
    pickerTabs: q('.imged-picker-tabs'),
    btnReset: q<HTMLButtonElement>('[data-imged="reset"]'),
    btnPng: q<HTMLButtonElement>('[data-imged="export-png"]'),
    btnPngText: q<HTMLElement>('.imged-btn-text'),
    btnReveal: q<HTMLButtonElement>('.imged-actions [data-imged="reveal"]'),
    btnRestore: q<HTMLButtonElement>('[data-imged="restore"]'),
    result: q('.imged-result'),
    live: q('.imged-live'),
    resultTitle: q('.imged-result-title'),
    resultName: q('.imged-result-name'),
    resultNote: q('.imged-result-note'),
    resultReveal: q<HTMLButtonElement>('.imged-result [data-imged="reveal"]'),
    resultRetry: q<HTMLButtonElement>('.imged-result [data-imged="retry-export"]'),
    resultClose: q<HTMLButtonElement>('.imged-result-close'),
  };

  bindEvents(els);
  updateCardSection();
  updateCardPickerSelection();
  applyCardFilter();
  new ResizeObserver(() => { if (doc) applyFit(); }).observe(els.stage);
  /* 这个页面的第一个（也是唯一的）用户任务就是改这张结算图:进来直接载入,
   * 不让用户先对着空状态再找按钮。失败会停在空状态并写明原因。 */
  void loadSample();
}

function bindEvents(e: El): void {
  e.mount.addEventListener('click', (ev) => {
    const bgBtn = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-bg]');
    if (bgBtn) { void selectBackground(Number(bgBtn.dataset.bg)); return; }
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-imged]');
    if (!btn) return;
    const act = btn.dataset.imged;
    if (act === 'sample') void loadSample();
    else if (act === 'reset') resetAll();
    else if (act === 'restore') restoreSelected();
    else if (act === 'export-png') void exportImage();
    else if (act === 'reveal') void revealSaved();
    else if (act === 'retry-export') void exportImage();
    else if (act === 'result-close') hideResult();
    else if (act === 'zoom-in') zoomBy(1.25);
    else if (act === 'zoom-out') zoomBy(1 / 1.25);
    else if (act === 'zoom-fit') resetView();
    else if (act === 'pick-card') openCardPicker();
    else if (act === 'clear-card') clearCard();
    else if (act === 'reset-card-quad') resetCardQuad();
    else if (act === 'close-card-picker') closeCardPicker();
    else if (act === 'clear-card-search') {
      e.pickerSearch.value = '';
      applyCardFilter();
      e.pickerSearch.focus();
    }
  });

  e.list.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.imged-layer');
    if (!btn) return;
    const uid = btn.dataset.uid || '';
    if (uid) selectLayer(uid);
  });

  e.textarea.addEventListener('input', () => {
    const st = currentState();
    if (!st) return;
    st.text = e.textarea.value;
    markDirty(selectedUid);
    syncLayerRow(selectedUid);
    refreshDirtyUi();
    requestRender();
  });

  e.color.addEventListener('input', () => {
    const st = currentState();
    if (!st) return;
    st.color = e.color.value;
    markDirty(selectedUid);
    e.hex.value = e.color.value.toUpperCase();
    syncLayerRow(selectedUid);
    refreshDirtyUi();
    requestRender();
  });

  e.hex.addEventListener('change', () => {
    const st = currentState();
    if (!st) return;
    const v = normalizeHex(e.hex.value);
    if (!v) { e.hex.value = st.color.toUpperCase(); return; }
    st.color = v;
    markDirty(selectedUid);
    e.color.value = v;
    e.hex.value = v.toUpperCase();
    syncLayerRow(selectedUid);
    refreshDirtyUi();
    requestRender();
  });

  e.opacity.addEventListener('input', () => {
    const st = currentState();
    if (!st) return;
    const v = Math.max(0, Math.min(100, Number(e.opacity.value))) / 100;
    st.opacity = v;
    markDirty(selectedUid);
    e.opacityPct.textContent = Math.round(v * 100) + '%';
    e.opacity.style.setProperty('--imged-fill', Math.round(v * 100) + '%');
    const tl = doc && doc.textLayers.find((l) => l.uid === selectedUid);
    if (tl) syncSelMeta(tl, Math.round(v * 100));
    syncLayerRow(selectedUid);
    refreshDirtyUi();
    requestRender();
  });

  /* ---------- 画布:滚轮缩放 / 拖动平移 / 双击复位(与动画编辑器同一套公式)---------- */
  /* 浮在舞台上、需要自己收事件的控件;用 closest 判断,图标里的 svg 路径也算命中。
   * 原生控件同样放行,避免以后新加按钮时再犯同一个错。 */
  const STAGE_UI = [
    '.imged-zoom', '.imged-card-quad', '.imged-result', '.imged-status',
    '.imged-loading', '.imged-empty', '.imged-sel-box',
    'button', 'a[href]', 'input', 'select', 'textarea', 'label',
    '[role="button"]', '[data-imged]',
  ].join(',');
  const isStageUi = (target: EventTarget | null): boolean =>
    !!target && ((target as Element).closest?.(STAGE_UI) ?? null) !== null;
  e.stage.addEventListener('wheel', (ev) => {
    if (!doc) return;
    ev.preventDefault();
    const rect = e.stage.getBoundingClientRect();
    const dx = ev.clientX - rect.left - rect.width / 2;
    const dy = ev.clientY - rect.top - rect.height / 2;
    const factor = Math.pow(1.1, -ev.deltaY / 100);
    const nextZoom = Math.min(50, Math.max(0.05, viewZoom * factor));
    const z = nextZoom / viewZoom;
    /* 补偿:让鼠标指向的那个点在缩放前后留在原地(以舞台中心为原点) */
    viewPanX = dx * (1 - z) + z * viewPanX;
    viewPanY = dy * (1 - z) + z * viewPanY;
    viewZoom = nextZoom;
    updateViewTransform();
  }, { passive: false });

  e.stage.addEventListener('pointerdown', (ev) => {
    if (!doc) return;
    /* 舞台上的浮层控件不参与拖画布。必须在这里就放行:一旦走到底下的
     * preventDefault + setPointerCapture,pointerup 会被舞台抢走,里面的按钮
     * 永远收不到 click(导出结果卡、缩放条、空状态都踩过这个坑)。 */
    if (isStageUi(ev.target)) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    panning = true;
    panStartX = ev.clientX;
    panStartY = ev.clientY;
    panOrigX = viewPanX;
    panOrigY = viewPanY;
    e.stage.setPointerCapture(ev.pointerId);
    e.stage.classList.add('is-panning');
  });
  e.stage.addEventListener('pointermove', (ev) => {
    if (!panning) return;
    viewPanX = panOrigX + (ev.clientX - panStartX);
    viewPanY = panOrigY + (ev.clientY - panStartY);
    updateViewTransform();
  });
  const endPan = (): void => {
    if (!panning) return;
    panning = false;
    e.stage.classList.remove('is-panning');
  };
  e.stage.addEventListener('pointerup', endPan);
  e.stage.addEventListener('pointercancel', endPan);
  e.stage.addEventListener('dblclick', (ev) => {
    if (!doc) return;
    if (isStageUi(ev.target)) return;
    resetView();
  });

  /* ---------- 名片:四角透视 / 整体平移 / 旋转 ---------- */
  e.cardModes.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-card-mode]');
    const mode = btn?.dataset.cardMode;
    if (mode === 'proportional' || mode === 'free' || mode === 'perspective') setCardMode(mode);
  });
  e.cardQuad.addEventListener('pointerdown', beginCardDrag);
  e.cardQuad.addEventListener('pointermove', moveCardDrag);
  e.cardQuad.addEventListener('pointerup', endCardDrag);
  e.cardQuad.addEventListener('pointercancel', endCardDrag);

  /* ---------- 名片选择器 ---------- */
  e.pickerSearch.addEventListener('input', () => applyCardFilter());
  e.pickerTabs.addEventListener('click', (ev) => {
    const tab = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-card-tab]');
    const v = tab?.dataset.cardTab;
    if (v !== 'all' && v !== 'business' && v !== 'skin') return;
    cardTab = v;
    applyCardFilter();
  });
  e.pickerGrid.addEventListener('click', (ev) => {
    const item = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.imged-card-item');
    const id = item?.dataset.cardId;
    if (id) void chooseCard(id);
  });
  e.pickerGrid.addEventListener('focusin', (ev) => {
    const item = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.imged-card-item');
    if (!item) return;
    for (const other of e.pickerGrid.querySelectorAll<HTMLElement>('.imged-card-item')) other.tabIndex = -1;
    item.tabIndex = 0;
  });
  e.pickerGrid.addEventListener('keydown', (ev) => {
    const items = [...e.pickerGrid.querySelectorAll<HTMLElement>('.imged-card-item')].filter((el) => !el.hidden);
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (idx < 0) return;
    const cols = (() => {
      if (!items.length) return 1;
      const top = items[0].getBoundingClientRect().top;
      let n = 0;
      for (const it of items) {
        if (Math.abs(it.getBoundingClientRect().top - top) < 2) n++;
        else break;
      }
      return Math.max(1, n);
    })();
    let next = -1;
    if (ev.key === 'ArrowRight') next = Math.min(items.length - 1, idx + 1);
    else if (ev.key === 'ArrowLeft') next = Math.max(0, idx - 1);
    else if (ev.key === 'ArrowDown') next = Math.min(items.length - 1, idx + cols);
    else if (ev.key === 'ArrowUp') next = Math.max(0, idx - cols);
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = items.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    items[next].focus();
    items[next].scrollIntoView({ block: 'nearest' });
  });
  /* 原生 dialog:只有点在 dialog 元素本身(暗色 backdrop / 面板留白)才关闭。
   * 不能按 clientX/Y 判断 —— 键盘 Enter 或脚本 .click() 的坐标是 0,0,
   * 会把面板内部的按钮误当成 backdrop,点一下分类就把选择器关了。 */
  e.picker.addEventListener('click', (ev) => {
    if (ev.target === e.picker) closeCardPicker();
  });
  /* 搜索框会吞掉 Esc(浏览器默认清空 type=search),所以显式关闭,别让对话框卡住 */
  e.picker.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    closeCardPicker();
  });
  e.picker.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    closeCardPicker();
  });
  e.picker.addEventListener('close', () => {
    /* 关闭后把焦点还给"选择名片"入口,键盘用户不会掉回页面开头 */
    if (!e.cardCurrent.disabled) e.cardCurrent.focus();
  });
}

/* ==================== 背景 ==================== */

/** 当前要传给渲染器的背景图;默认背景返回 undefined(直接用 PSD 自带的像素)。 */
function activeBackground(): CanvasImageSource | undefined {
  return bgIndex === DEFAULT_BG_INDEX ? undefined : bgComposed[bgIndex];
}

function drawCoverTo(ctx: CanvasRenderingContext2D, img: HTMLImageElement, dw: number, dh: number): void {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;
  const scale = Math.max(dw / iw, dh / ih);
  const sw = dw / scale;
  const sh = dh / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, dw, dh);
}

/** 合成一张可替换背景:背景图 + 挖孔补黑 + 手机屏幕内容。
 *   · 背景 PNG 的手机屏幕是透明的,原 PSD 靠下层「形状 1」透出来;
 *   · 换背景后挖孔位置会差几像素,所以先按背景自身的透明区域补一层黑,
 *     再把「形状 1」缩放到这块区域,并用同一个挖孔遮罩裁掉溢出部分;
 *   · 结果是一张不透明的整幅画布,渲染器只需要按普通背景图画。
 * 这个合成只跟背景图有关,切文字/颜色/透明度不会让它失效。 */
function composeBackground(img: HTMLImageElement): HTMLCanvasElement | undefined {
  if (!doc) return undefined;
  const w = doc.width;
  const h = doc.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) return undefined;
  drawCoverTo(ctx, img, w, h);

  /* 挖孔遮罩:整块黑,再用背景图"减掉"不透明部分 → 剩下的就是屏幕挖孔(alpha=1)。 */
  const mask = document.createElement('canvas');
  mask.width = w;
  mask.height = h;
  const mctx = mask.getContext('2d');
  const rect = computeScreenRect(img);
  if (mctx) {
    mctx.fillStyle = '#000';
    mctx.fillRect(0, 0, w, h);
    mctx.globalCompositeOperation = 'destination-out';
    drawCoverTo(mctx, img, w, h);
    /* 先补黑:屏幕内容本身的圆角/透视边要是没盖满,也不会露出透明缝 */
    ctx.drawImage(mask, 0, 0);

    /* 屏幕里的内容:沿用原来的黑屏 + 绿点(缩放到新的挖孔范围)。
     * 名片是自由的顶层覆盖,不再写进背景合成。 */
    const sc = doc.screenContent;
    if (sc) {
      const r = rect || { left: sc.left, top: sc.top, width: Math.max(1, sc.right - sc.left), height: Math.max(1, sc.bottom - sc.top) };
      const layer = document.createElement('canvas');
      layer.width = w;
      layer.height = h;
      const lctx = layer.getContext('2d');
      if (lctx) {
        lctx.drawImage(sc.canvas, r.left, r.top, Math.max(1, r.width), Math.max(1, r.height));
        lctx.globalCompositeOperation = 'destination-in';
        lctx.drawImage(mask, 0, 0);
        ctx.drawImage(layer, 0, 0);
      }
    }
  }
  return out;
}

/** 扫描背景图的透明屏幕区域(文档坐标):换背景时把屏幕内容缩放到这块区域。 */
function computeScreenRect(img: HTMLImageElement): { left: number; top: number; width: number; height: number } | undefined {
  if (!doc) return undefined;
  const c = document.createElement('canvas');
  c.width = doc.width;
  c.height = doc.height;
  const ctx = c.getContext('2d');
  if (!ctx) return undefined;
  const iw = img.naturalWidth; const ih = img.naturalHeight;
  if (!iw || !ih) return undefined;
  const scale = Math.max(doc.width / iw, doc.height / ih);
  const sw = doc.width / scale; const sh = doc.height / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, doc.width, doc.height);
  const data = ctx.getImageData(0, 0, doc.width, doc.height).data;
  let minX = doc.width, minY = doc.height, maxX = -1, maxY = -1;
  for (let y = 0; y < doc.height; y += 2) {
    const row = y * doc.width * 4;
    for (let x = 0; x < doc.width; x += 2) {
      if (data[row + x * 4 + 3] < 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return undefined;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 直接复用背景缩略图里的 <img>:它们本来就是同一张图,
 * 再 new Image() 会把同一张 2592×1440 在内存里解码第二份。 */
async function ensureBgImage(index: number): Promise<HTMLImageElement> {
  if (!els) throw new Error('页面尚未初始化');
  const img = els.bgGrid.querySelectorAll<HTMLImageElement>('.imged-bg-item img')[index];
  if (!img) throw new Error('背景图片缺失');
  if (img.complete && img.naturalWidth) return img;
  await new Promise<void>((resolve, reject) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => reject(new Error(BACKGROUNDS[index].file + ' 加载失败')), { once: true });
  });
  if (!img.naturalWidth) throw new Error(BACKGROUNDS[index].file + ' 解码失败');
  return img;
}

async function selectBackground(index: number): Promise<void> {
  if (!doc || index === bgIndex || !BACKGROUNDS[index]) return;
  const seq = ++bgSeq;
  if (index !== DEFAULT_BG_INDEX) {
    if (els) els.bgGrid.classList.add('is-busy');
    try {
      const img = await ensureBgImage(index);
      if (seq !== bgSeq) return;
      bgComposed[index] = composeBackground(img);
    } catch (err) {
      if (seq === bgSeq) setStatus('背景图片加载失败:' + errText(err), 'error');
      if (els) els.bgGrid.classList.remove('is-busy');
      return;
    }
    if (seq !== bgSeq) return;
  }
  bgIndex = index;
  updateBgUi();
  if (els) els.bgGrid.classList.remove('is-busy');
  refreshButtons();
  renderNow();
  setStatus('背景:' + BACKGROUNDS[index].file, 'ok');
}

let bgSeq = 0;

function updateBgUi(): void {
  if (!els) return;
  for (const btn of els.bgGrid.querySelectorAll<HTMLElement>('[data-bg]')) {
    const on = Number(btn.dataset.bg) === bgIndex;
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

/* ==================== 名片:四角透视 ==================== */

function cardQuadText(): string {
  const p = cardQuad.map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) }));
  return 'TL ' + p[0].x + ',' + p[0].y + ' · TR ' + p[1].x + ',' + p[1].y
    + '\nBR ' + p[2].x + ',' + p[2].y + ' · BL ' + p[3].x + ',' + p[3].y;
}


function quadFromBase(base: CardBase): Quad {
  const rad = base.rotation * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = base.x + base.width / 2;
  const cy = base.y + base.height / 2;
  const local: [number, number][] = [
    [-base.width / 2, -base.height / 2],
    [base.width / 2, -base.height / 2],
    [base.width / 2, base.height / 2],
    [-base.width / 2, base.height / 2],
  ];
  return local.map(([x, y]) => ({
    x: cx + x * cos - y * sin,
    y: cy + x * sin + y * cos,
  })) as Quad;
}

function baseFromQuad(q: Quad): CardBase {
  const center = quadCenter(q);
  const tx = q[1].x - q[0].x;
  const ty = q[1].y - q[0].y;
  const rotation = Math.atan2(ty, tx) * 180 / Math.PI;
  const rad = rotation * Math.PI / 180;
  const nx = -Math.sin(rad);
  const ny = Math.cos(rad);
  const width = Math.max(24, (Math.hypot(tx, ty) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2);
  const h1 = (q[3].x - q[0].x) * nx + (q[3].y - q[0].y) * ny;
  const h2 = (q[2].x - q[1].x) * nx + (q[2].y - q[1].y) * ny;
  const height = Math.max(24, (h1 + h2) / 2);
  return { x: center.x - width / 2, y: center.y - height / 2, width, height, rotation };
}

function currentQuad(): Quad {
  return cardMode === 'perspective' ? cardQuad : quadFromBase(cardBase);
}

function cardAngle(): number {
  const v = ((Math.round(cardBase.rotation || 0) % 360) + 360) % 360;
  return v > 180 ? v - 360 : v;
}

function cardScaleX(): number {
  return Math.round((cardBase.width / Math.max(1, cardNaturalWidth)) * 100);
}

function cardScaleY(): number {
  return Math.round((cardBase.height / Math.max(1, cardNaturalHeight)) * 100);
}

function cardNormalText(): string {
  return 'X ' + Math.round(cardBase.x) + ' · Y ' + Math.round(cardBase.y)
    + ' · ' + Math.round(cardBase.width) + ' × ' + Math.round(cardBase.height)
    + '\n' + cardScaleX() + '% / ' + cardScaleY() + '% · ' + cardAngle() + '°';
}

function cardReadout(): string {
  return cardMode === 'perspective' ? cardQuadText() : cardNormalText();
}

function updateCardModeUi(): void {
  if (!els) return;
  const on = !!selectedCardId;
  els.cardModes.hidden = !on;
  els.cardNote.hidden = on;
  for (const btn of els.cardModeButtons) {
    const active = btn.dataset.cardMode === cardMode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function setCardMode(mode: CardMode): void {
  if (!doc || !selectedCardId || mode === cardMode) return;
  if (mode === 'perspective') {
    cardQuad = quadFromBase(cardBase);
  } else if (cardMode === 'perspective') {
    cardBase = baseFromQuad(cardQuad);
  }
  if (mode === 'proportional') {
    /* 等比模式回到名片原图宽高比,避免从透视切过来时带着透视的拉伸 */
    const height = cardBase.width * cardNaturalHeight / Math.max(1, cardNaturalWidth);
    const centerY = cardBase.y + cardBase.height / 2;
    cardBase = { ...cardBase, y: centerY - height / 2, height };
  }
  cardMode = mode;
  cardWarpKey = '';
  cardWarped = null;
  updateCardModeUi();
  syncCardUi();
  drawBaseAndCard();
  const label = mode === 'proportional' ? '等比缩放' : mode === 'free' ? '自由缩放' : '透视调整';
  setStatus('缩放方式:' + label, 'ok');
}

/** 当前名片的透视合成结果;key 命中时复用,拖动时只重算这一层。 */
function activeCardWarp(): HTMLCanvasElement | null {
  if (!doc || !selectedCardId) return null;
  const entry = CARD_BY_ID.get(selectedCardId);
  const img = entry ? cardImages.get(entry.id) : undefined;
  if (!entry || !img) return null;
  const quad = currentQuad();
  const key = selectedCardId + '|' + quadKey(quad) + '|' + doc.width + 'x' + doc.height;
  if (cardWarped && cardWarpKey === key) return cardWarped;
  cardWarped = warpImageToQuad(img, quad, doc.width, doc.height, cardWarpCanvas);
  cardWarpKey = cardWarped ? key : '';
  return cardWarped;
}

function bgImageElement(index: number): HTMLImageElement | undefined {
  return els ? els.bgGrid.querySelectorAll<HTMLImageElement>('.imged-bg-item img')[index] : undefined;
}

/** 当前背景图的透明屏幕挖孔:白色为可显示名片的位置,其余透明。 */
function screenHoleMask(): HTMLCanvasElement | null {
  if (!doc || !els) return null;
  if (cardMask && cardMaskIndex === bgIndex) return cardMask;
  const img = bgImageElement(bgIndex);
  if (!img || !img.naturalWidth) return null;
  const c = document.createElement('canvas');
  c.width = doc.width;
  c.height = doc.height;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, doc.width, doc.height);
  ctx.globalCompositeOperation = 'destination-out';
  drawCoverTo(ctx, img, doc.width, doc.height);
  ctx.globalCompositeOperation = 'source-over';
  cardMask = c;
  cardMaskIndex = bgIndex;
  return c;
}

/** 名片画在场景之上,但只保留屏幕挖孔内的像素:视觉上位于手机背景下层,不会盖住边框。 */
function drawCardTo(ctx: CanvasRenderingContext2D): void {
  const warp = activeCardWarp();
  const mask = screenHoleMask();
  if (!warp || !mask || !doc) return;
  if (cardClipCanvas.width !== doc.width || cardClipCanvas.height !== doc.height) {
    cardClipCanvas.width = doc.width;
    cardClipCanvas.height = doc.height;
  }
  const lctx = cardClipCanvas.getContext('2d');
  if (!lctx) return;
  lctx.clearRect(0, 0, doc.width, doc.height);
  lctx.globalCompositeOperation = 'source-over';
  lctx.drawImage(warp, 0, 0);
  lctx.globalCompositeOperation = 'destination-in';
  lctx.drawImage(mask, 0, 0);
  lctx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cardClipCanvas, 0, 0);
  ctx.restore();
}

function updateCardTransformUi(): void {
  if (!els) return;
  const on = !!selectedCardId;
  if (on) els.cardQuad.removeAttribute('hidden'); else els.cardQuad.setAttribute('hidden', '');
  els.cardResetRect.hidden = !on;
  updateCardModeUi();
  if (!on) return;
  els.cardMeta.textContent = cardReadout();
}

/** 四角选框是屏幕坐标的 SVG:四角、顶边中点的旋转手柄都按文档→屏幕映射。 */
function updateCardQuad(): void {
  if (!els || !doc) return;
  const on = !!selectedCardId;
  if (on) els.cardQuad.removeAttribute('hidden'); else els.cardQuad.setAttribute('hidden', '');
  if (!on) return;
  const cr = els.canvas.getBoundingClientRect();
  const sr = els.stage.getBoundingClientRect();
  if (!cr.width || !cr.height) return;
  const sx = cr.width / doc.width;
  const sy = cr.height / doc.height;
  const pts = currentQuad().map((p) => ({
    x: cr.left - sr.left + p.x * sx,
    y: cr.top - sr.top + p.y * sy,
  }));
  els.cardQuad.setAttribute('viewBox', '0 0 ' + Math.max(1, sr.width) + ' ' + Math.max(1, sr.height));
  els.cardQuadFill.setAttribute('points', pts.map((p) => p.x + ',' + p.y).join(' '));
  els.cardQuadCorners.forEach((c, i) => {
    const p = pts[i];
    if (!p) return;
    c.setAttribute('cx', String(p.x));
    c.setAttribute('cy', String(p.y));
  });
  const center = {
    x: (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4,
    y: (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4,
  };
  const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  const dx = mid.x - center.x;
  const dy = mid.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  const hx = mid.x + (dx / len) * 26;
  const hy = mid.y + (dy / len) * 26;
  els.cardQuadLine.setAttribute('x1', String(mid.x));
  els.cardQuadLine.setAttribute('y1', String(mid.y));
  els.cardQuadLine.setAttribute('x2', String(hx));
  els.cardQuadLine.setAttribute('y2', String(hy));
  els.cardRotateHandle.setAttribute('cx', String(hx));
  els.cardRotateHandle.setAttribute('cy', String(hy));
}

function syncCardUi(): void {
  updateCardTransformUi();
  updateCardQuad();
}

/** 把文档尺寸的 composite 1:1 铺到屏幕画布上(视图缩放只由 CSS transform 负责)。 */
function blitComposite(): void {
  if (!doc || !els || !compositeCtx) return;
  const c = els.canvas;
  if (c.width !== doc.width || c.height !== doc.height) {
    c.width = doc.width;
    c.height = doc.height;
  }
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(composite, 0, 0);
}

/** 只重画"底层场景 + 透视名片":拖动/缩放/旋转时不重跑 13 个 PSD 图层。 */
function drawBaseAndCard(): void {
  if (!doc || !compositeCtx) return;
  compositeCtx.clearRect(0, 0, doc.width, doc.height);
  compositeCtx.drawImage(baseScene, 0, 0);
  drawCardTo(compositeCtx);
  blitComposite();
  syncCardUi();
}

function renderCardOnly(): void {
  drawBaseAndCard();
}

function requestCardRender(): void {
  if (cardRenderRaf) return;
  cardRenderRaf = requestAnimationFrame(() => {
    cardRenderRaf = 0;
    drawBaseAndCard();
  });
}

function resetCardQuad(): void {
  if (!doc || !selectedCardId) return;
  cardMode = 'perspective';
  cardQuad = CARD_DEFAULT_QUAD.map((p) => ({ ...p })) as Quad;
  cardBase = baseFromQuad(CARD_DEFAULT_QUAD);
  cardWarpKey = '';
  cardWarped = null;
  updateCardModeUi();
  drawBaseAndCard();
  setStatus('名片回到默认透视四角', 'ok');
}

function beginCardDrag(ev: PointerEvent): void {
  if (!doc || !els || !selectedCardId || cardBusy) return;
  const cr = els.canvas.getBoundingClientRect();
  if (!cr.width) return;
  const scale = cr.width / doc.width;
  if (!scale) return;
  const target = ev.target as SVGElement | null;
  const cornerEl = target?.closest<SVGElement>('[data-card-corner]');
  const attr = cornerEl?.getAttribute('data-card-corner') || '';
  const mode = attr === 'rotate' ? 'rotate' : attr !== '' && Number.isFinite(Number(attr)) ? 'corner' : 'move';
  const startQuad = currentQuad();
  const center = quadCenter(startQuad);
  const centerScreenX = cr.left + center.x * scale;
  const centerScreenY = cr.top + center.y * scale;
  cardDrag = {
    mode,
    corner: mode === 'corner' ? Number(attr) : -1,
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    startDocX: (ev.clientX - cr.left) / scale,
    startDocY: (ev.clientY - cr.top) / scale,
    startQuad: startQuad.map((p) => ({ ...p })) as Quad,
    startBase: { ...cardBase },
    startAngle: Math.atan2(ev.clientY - centerScreenY, ev.clientX - centerScreenX),
    centerScreenX,
    centerScreenY,
    scale,
  };
  try { els.cardQuad.setPointerCapture(ev.pointerId); } catch { /* 指针失效时不阻断 */ }
  els.cardQuad.classList.add('is-dragging');
  ev.preventDefault();
  ev.stopPropagation();
}

function moveCardDrag(ev: PointerEvent): void {
  if (!cardDrag || ev.pointerId !== cardDrag.pointerId) return;
  const d = cardDrag;
  const dx = (ev.clientX - d.startX) / d.scale;
  const dy = (ev.clientY - d.startY) / d.scale;
  if (d.mode === 'move') {
    if (cardMode === 'perspective') {
      cardQuad = translateQuad(d.startQuad, dx, dy).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) as Quad;
    } else {
      cardBase = { ...d.startBase, x: Math.round(d.startBase.x + dx), y: Math.round(d.startBase.y + dy) };
    }
  } else if (d.mode === 'corner') {
    if (cardMode === 'perspective') {
      const next = d.startQuad.map((p) => ({ ...p })) as Quad;
      next[d.corner] = {
        x: Math.round(d.startDocX + dx),
        y: Math.round(d.startDocY + dy),
      };
      cardQuad = next;
    } else {
      /* 正常模式:把指针换算到名片自身坐标轴,保持对角固定 */
      const b = d.startBase;
      const rad = b.rotation * Math.PI / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const world = (lx: number, ly: number) => ({
        x: cx + lx * cos - ly * sin,
        y: cy + lx * sin + ly * cos,
      });
      const tl = world(-b.width / 2, -b.height / 2);
      const tr = world(b.width / 2, -b.height / 2);
      const br = world(b.width / 2, b.height / 2);
      const bl = world(-b.width / 2, b.height / 2);
      let fixed = tl;
      let signX = 1;
      let signY = 1;
      if (d.corner === 0) { fixed = br; signX = -1; signY = -1; }
      else if (d.corner === 1) { fixed = bl; signX = 1; signY = -1; }
      else if (d.corner === 2) { fixed = tl; signX = 1; signY = 1; }
      else if (d.corner === 3) { fixed = tr; signX = -1; signY = 1; }
      const docX = d.startDocX + dx;
      const docY = d.startDocY + dy;
      const vx = docX - fixed.x;
      const vy = docY - fixed.y;
      const lx = cos * vx + sin * vy;
      const ly = -sin * vx + cos * vy;
      const wantW = Math.max(24, Math.abs(lx));
      const wantH = Math.max(24, Math.abs(ly));
      let width = wantW;
      let height = wantH;
      if (cardMode === 'proportional') {
        const aspect = b.width / Math.max(1, b.height);
        width = Math.max(wantW, wantH * aspect);
        height = width / aspect;
      }
      const ncx = fixed.x + (signX * width / 2) * cos - (signY * height / 2) * sin;
      const ncy = fixed.y + (signX * width / 2) * sin + (signY * height / 2) * cos;
      cardBase = {
        x: Math.round(ncx - width / 2),
        y: Math.round(ncy - height / 2),
        width: Math.max(24, Math.round(width)),
        height: Math.max(24, Math.round(height)),
        rotation: b.rotation,
      };
    }
  } else {
    const angle = Math.atan2(ev.clientY - d.centerScreenY, ev.clientX - d.centerScreenX);
    let delta = angle - d.startAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    let deg = delta * 180 / Math.PI;
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
    if (cardMode === 'perspective') {
      const center = quadCenter(d.startQuad);
      cardQuad = rotateQuadAround(d.startQuad, center.x, center.y, deg)
        .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) as Quad;
    } else {
      cardBase = { ...d.startBase, rotation: d.startBase.rotation + deg };
    }
  }
  syncCardUi();
  requestCardRender();
  ev.preventDefault();
}

function endCardDrag(ev: PointerEvent): void {
  if (!cardDrag || ev.pointerId !== cardDrag.pointerId) return;
  cardDrag = null;
  if (els) {
    els.cardQuad.classList.remove('is-dragging');
    try { els.cardQuad.releasePointerCapture(ev.pointerId); } catch { /* 已释放 */ }
  }
  if (cardRenderRaf) {
    cancelAnimationFrame(cardRenderRaf);
    cardRenderRaf = 0;
  }
  renderCardOnly();
  ev.preventDefault();
}

async function ensureCardImage(entry: CardEntry): Promise<HTMLImageElement> {
  const cached = cardImages.get(entry.id);
  if (cached) return cached;
  cardLoading = entry.id;
  updateCardSection();
  try {
    /* 内存 → Cache Storage(按 commit sha)→ GitCode raw API → 本地缩略图兜底 */
    const loaded = await loadCardOriginal(entry.id, cardThumbUrl(entry));
    const img = loaded.img;
    if (!img.naturalWidth) throw new Error(entry.label + ' 解码失败');
    cardImages.set(entry.id, img);
    cardSource = loaded.source;
    return img;
  } finally {
    cardLoading = '';
  }
}

function cardSourceText(): string {
  if (selectedCardId === cardLoading) return '正在从 GitCode 加载原图…';
  const loaded = selectedCardId ? cachedCard(selectedCardId) : undefined;
  if (cardSource && loaded) return sourceLabel(cardSource) + ' · ' + loaded.width + '×' + loaded.height;
  return '';
}

function updateCardSection(): void {
  if (!els) return;
  const entry = selectedCardId ? CARD_BY_ID.get(selectedCardId) : undefined;
  if (entry) {
    els.cardThumb.innerHTML = '<img src="' + cardThumbUrl(entry) + '" alt="" draggable="false" />';
    els.cardName.textContent = cardDisplayLabel(entry);
    els.cardSource.textContent = cardSourceText();
    els.cardGo.textContent = '更换';
    els.cardClear.hidden = false;
    els.cardCurrent.classList.add('has-card');
    els.cardCurrent.setAttribute('aria-label', '更换名片:' + cardDisplayLabel(entry));
  } else {
    els.cardThumb.innerHTML = CARD_PLACEHOLDER;
    els.cardName.textContent = '选择名片';
    els.cardSource.textContent = '';
    els.cardMeta.textContent = '从 ' + CARD_COUNTS.business + ' 张名片 / ' + CARD_COUNTS.skin + ' 张皮肤中选择';
    els.cardGo.textContent = '选择';
    els.cardClear.hidden = true;
    els.cardCurrent.classList.remove('has-card');
    els.cardCurrent.setAttribute('aria-label', '选择名片');
  }
  syncCardUi();
}

function updateCardPickerSelection(): void {
  if (!els) return;
  for (const item of els.pickerGrid.querySelectorAll<HTMLElement>('.imged-card-item')) {
    const on = item.dataset.cardId === selectedCardId;
    item.classList.toggle('is-selected', on);
    item.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function setCardBusy(on: boolean): void {
  cardBusy = on;
  if (els) {
    els.cardCurrent.classList.toggle('is-busy', on);
    els.cardCurrent.setAttribute('aria-busy', on ? 'true' : 'false');
    els.cardGo.textContent = on ? '应用中…' : (selectedCardId ? '更换' : '选择');
    if (selectedCardId) els.cardSource.textContent = cardSourceText();
  }
  refreshButtons();
}

function applyCardFilter(): void {
  if (!els) return;
  const q = els.pickerSearch.value.trim().toLowerCase();
  const all = [...els.pickerGrid.querySelectorAll<HTMLElement>('.imged-card-item')];
  const shown: HTMLElement[] = [];
  for (const item of all) {
    const entry = CARD_BY_ID.get(item.dataset.cardId || '');
    if (!entry) continue;
    const catOk = cardTab === 'all' || entry.category === cardTab;
    const qOk = !q || (entry.label + ' ' + entry.group + ' ' + entry.id).toLowerCase().includes(q);
    const show = catOk && qOk;
    item.hidden = !show;
    if (show) shown.push(item);
  }
  /* 190 张全放 tab 序里会变成 190 个 tab 停靠点;用 roving tabindex,方向键在网格里走。 */
  const initial = shown.find((item) => item.dataset.cardId === selectedCardId) || shown[0];
  for (const item of all) item.tabIndex = item === initial ? 0 : -1;
  els.pickerCount.textContent = '显示 ' + shown.length + ' / ' + CARD_COUNTS.all;
  els.pickerEmpty.hidden = shown.length > 0;
  els.pickerClear.hidden = !els.pickerSearch.value;
  for (const tab of els.pickerTabs.querySelectorAll<HTMLButtonElement>('[data-card-tab]')) {
    const on = tab.dataset.cardTab === cardTab;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function openCardPicker(): void {
  if (!els || !doc || loading || exporting || cardBusy) return;
  updateCardPickerSelection();
  applyCardFilter();
  if (!els.picker.open) els.picker.showModal();
  requestAnimationFrame(() => {
    els?.pickerSearch.focus();
    const selected = els?.pickerGrid.querySelector<HTMLElement>('.imged-card-item.is-selected');
    if (selected) selected.scrollIntoView({ block: 'center' });
  });
}

function closeCardPicker(): void {
  if (els && els.picker.open) els.picker.close();
}

async function chooseCard(id: string): Promise<void> {
  if (!doc || cardBusy) return;
  const entry = CARD_BY_ID.get(id);
  if (!entry) return;
  closeCardPicker();
  setCardBusy(true);
  try {
    await ensureCardImage(entry);
    selectedCardId = id;
    cardNaturalWidth = entry.width;
    cardNaturalHeight = entry.height;
    cardWarpKey = '';
    cardWarped = null;
    cardMask = null;
    cardMaskIndex = -1;
    updateCardSection();
    updateCardPickerSelection();
    renderNow();
    setStatus('已应用名片:' + cardDisplayLabel(entry) + '(拖四角透视)', 'ok');
  } catch (err) {
    setStatus('名片加载失败:' + errText(err), 'error');
  } finally {
    setCardBusy(false);
    if (els && !els.cardCurrent.disabled) els.cardCurrent.focus();
  }
}

function clearCard(): void {
  if (!doc || !selectedCardId || cardBusy) return;
  selectedCardId = '';
  cardMode = 'perspective';
  cardQuad = CARD_DEFAULT_QUAD.map((p) => ({ ...p })) as Quad;
  cardBase = baseFromQuad(CARD_DEFAULT_QUAD);
  cardNaturalWidth = 384;
  cardNaturalHeight = 617;
  cardWarpKey = '';
  cardWarped = null;
  updateCardSection();
  updateCardPickerSelection();
  renderNow();
  if (els) els.cardCurrent.focus();
  setStatus('已恢复默认屏幕内容', 'ok');
}

/** "已改" = 与 PSD 原值不同(改回原值就不再算改动,撤销全部与导出都按这个口径)。 */
function markDirty(uid: string): void {
  const tl = doc && doc.textLayers.find((l) => l.uid === uid);
  const st = edits.get(uid);
  if (!tl || !st) return;
  st.dirty = st.text !== tl.text
    || st.color.toLowerCase() !== tl.color.toLowerCase()
    || Math.abs(st.opacity - tl.layerOpacity) > 0.0001;
}

function normalizeHex(raw: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(raw || '').trim());
  if (!m) return '';
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return '#' + h.toLowerCase();
}

function currentState(): TextEditState | null {
  if (!selectedUid) return null;
  return edits.get(selectedUid) || null;
}

/* ==================== 载入 ==================== */

async function loadSample(): Promise<void> {
  if (loading) return;
  loading = true;
  refreshButtons();
  const seq = ++loadSeq;
  showLoading('正在读取内置示例…', 0);
  try {
    const buf = await fetchBuffer(samplePsdUrl, (p) => {
      if (seq !== loadSeq) return;
      setLoadingProgress(p * 0.6);
    });
    if (seq !== loadSeq) return;
    parseBuffer(buf, seq);
  } catch (err) {
    if (seq === loadSeq) setStatus('内置示例载入失败:' + errText(err) + '。可以点「重新载入」再试一次。', 'error');
  } finally {
    if (seq === loadSeq) {
      loading = false;
      hideLoading();
      refreshButtons();
    }
  }
}

function parseBuffer(buf: ArrayBuffer, seq: number): void {
  const magic = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (buf.byteLength < 26 || String.fromCharCode(magic[0] || 0, magic[1] || 0, magic[2] || 0, magic[3] || 0) !== '8BPS') {
    setStatus('内置 PSD 无效(文件头不是 8BPS)', 'error');
    return;
  }
  const t0 = performance.now();
  try {
    const next = loadPsdDocument(buf);
    if (seq !== loadSeq) return;
    doc = next;
    edits = createEditMap(doc);
    selectedUid = '';
    bgIndex = DEFAULT_BG_INDEX;
    bgComposed.length = 0;
    selectedCardId = '';
    cardMode = 'perspective';
    cardQuad = CARD_DEFAULT_QUAD.map((p) => ({ ...p })) as Quad;
    cardBase = baseFromQuad(CARD_DEFAULT_QUAD);
    cardNaturalWidth = 384;
    cardNaturalHeight = 617;
    cardWarpKey = '';
    cardWarped = null;
    cardTab = 'all';
    if (els) els.pickerSearch.value = '';
    closeCardPicker();
    updateBgUi();
    updateCardSection();
    updateCardPickerSelection();
    applyCardFilter();
    composite.width = doc.width;
    composite.height = doc.height;
    baseScene.width = doc.width;
    baseScene.height = doc.height;
    eSetCanvasSize();
    buildLayerList();
    pickDefaultLayer();
    resetView();
    applyFit();
    renderNow();
    eSetMeta();
    hideResult();
    syncRevealButton();
    setStatus('已载入 ' + doc.width + '×' + doc.height + ' · ' + doc.textLayers.length + ' 个文字图层 · ' + Math.round(performance.now() - t0) + 'ms', 'ok');
  } catch (err) {
    setStatus('解析 PSD 失败:' + errText(err), 'error');
  }
}

function eSetCanvasSize(): void {
  if (!els || !doc) return;
  const c = els.canvas;
  c.width = doc.width;
  c.height = doc.height;
  els.canvasWrap.style.width = doc.width + 'px';
  els.canvasWrap.style.height = doc.height + 'px';
  els.canvasWrap.hidden = false;
  els.empty.hidden = true;
}

function eSetMeta(): void {
  if (!els || !doc) return;
  els.barMeta.textContent = doc.width + '×' + doc.height + ' · ' + doc.textLayers.length + ' 个文字图层 · ' + fmtBytes(doc.bytes);
}

async function fetchBuffer(url: string, onProgress: (p: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      if (total) onProgress(Math.min(1, received / total));
    }
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err || '未知错误');
}

/* ==================== 视图:适配 / 缩放 / 平移 ==================== */

/** 适配缩放:contain,按舞台去掉内边距后的可画面算(与动画编辑器同一条公式)。 */
function applyFit(): void {
  if (!els || !doc) return;
  const cs = getComputedStyle(els.stage);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const cw = Math.max(1, els.stage.clientWidth - padX);
  const ch = Math.max(1, els.stage.clientHeight - padY);
  baseScale = Math.min(cw / doc.width, ch / doc.height);
  updateViewTransform();
}

function updateViewTransform(): void {
  if (!els) return;
  const s = baseScale * viewZoom;
  const next = 'translate(' + viewPanX + 'px, ' + viewPanY + 'px) scale(' + s + ')';
  if (next !== lastTransform) {
    els.scaleLayer.style.transform = next;
    lastTransform = next;
  }
  const text = Math.round(viewZoom * 100) + '%';
  if (text !== lastZoomText) {
    els.zoomValue.textContent = text;
    lastZoomText = text;
  }
  syncSelectionBox();
  updateCardQuad();
}

/** 视图复位:滚轮倍数回 100%、平移归零(= 适应窗口)。 */
function resetView(): void {
  viewZoom = 1;
  viewPanX = 0;
  viewPanY = 0;
  updateViewTransform();
}

/** 以舞台中心为基准缩一档(工具条按钮用)。 */
function zoomBy(factor: number): void {
  if (!doc) return;
  viewZoom = Math.min(50, Math.max(0.05, viewZoom * factor));
  updateViewTransform();
}

/** 选中图层的虚线框画在舞台坐标里(不是画布位图里):
 * 这样无论缩放多少,边框始终是 1.5 个屏幕像素,不会被放大成粗线。 */
function syncSelectionBox(): void {
  if (!els) return;
  const tl = doc && doc.textLayers.find((l) => l.uid === selectedUid);
  if (!doc || !tl) { els.selBox.hidden = true; return; }
  /* 缩放写在 .imged-scale 上,所以它的 rect 才是"画布当前显示出来的矩形";
   * 外层 .imged-canvas-wrap 只负责居中,尺寸一直是文档像素。 */
  const wr = els.scaleLayer.getBoundingClientRect();
  const sr = els.stage.getBoundingClientRect();
  const s = wr.width / Math.max(1, doc.width);
  if (!wr.width) { els.selBox.hidden = true; return; }
  els.selBox.hidden = false;
  els.selBox.style.left = (wr.left - sr.left + tl.left * s) + 'px';
  els.selBox.style.top = (wr.top - sr.top + tl.top * s) + 'px';
  els.selBox.style.width = Math.max(1, (tl.right - tl.left) * s) + 'px';
  els.selBox.style.height = Math.max(1, (tl.bottom - tl.top) * s) + 'px';
}

/* ==================== 图层列表 / 选中 ==================== */

function buildLayerList(): void {
  if (!els || !doc) return;
  els.list.innerHTML = '';
  layerRefs = new Map();
  els.count.textContent = String(doc.textLayers.length);
  /* 列表按 Photoshop 面板的顺序显示(最上面的图层在最上面),
   * 而 doc.textLayers 是绘制顺序(从下往上),所以这里反着遍历。 */
  const ordered = doc.textLayers.slice().reverse();
  for (const tl of ordered) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'imged-layer';
    btn.dataset.uid = tl.uid;
    btn.innerHTML =
      '<span class="imged-swatch" aria-hidden="true"></span>' +
      '<span class="imged-layer-main"><span class="imged-layer-name"></span><span class="imged-layer-snippet"></span></span>' +
      '<span class="imged-dirty" hidden>已改</span>';
    const name = btn.querySelector<HTMLElement>('.imged-layer-name') as HTMLElement;
    const snippet = btn.querySelector<HTMLElement>('.imged-layer-snippet') as HTMLElement;
    const dirty = btn.querySelector<HTMLElement>('.imged-dirty') as HTMLElement;
    const swatch = btn.querySelector<HTMLElement>('.imged-swatch') as HTMLElement;
    name.textContent = tl.name;
    snippet.textContent = rowMeta(tl, edits.get(tl.uid));
    swatch.style.background = tl.color;
    li.appendChild(btn);
    els.list.appendChild(li);
    layerRefs.set(tl.uid, { btn, name, snippet, dirty, swatch });
  }
  els.panel.hidden = false;
  if (els.zoom) els.zoom.hidden = false;
}

function oneLine(s: string): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t || '(空)';
}

/** 图层行的第二行:内容与图层名不同时显示内容(方便按文案找图层),
 * 相同时显示"字号 · 透明度"这两个会随编辑变化的读数。 */
function rowMeta(tl: PsdTextLayer, st: TextEditState | undefined): string {
  const text = oneLine(st ? st.text : tl.text);
  if (text !== oneLine(tl.name)) return text;
  const pct = Math.round((st ? st.opacity : tl.layerOpacity) * 100);
  return Math.round(tl.fontSize) + 'px · ' + pct + '%';
}

function pickDefaultLayer(): void {
  if (!doc || !doc.textLayers.length) {
    selectedUid = '';
    if (els) els.inspector.hidden = true;
    return;
  }
  /* 默认选字号最大的那个文字图层 —— 结算图里就是「撤离成功」这类标题,
   * 也是用户进来最可能先改的一行。z 序最上面的那一格常常是角落里的小字。 */
  let pick = doc.textLayers[0];
  for (const tl of doc.textLayers) if (tl.fontSize > pick.fontSize) pick = tl;
  selectLayer(pick.uid);
}

function selectLayer(uid: string): void {
  if (!doc || !els) return;
  const tl = doc.textLayers.find((l) => l.uid === uid);
  if (!tl) return;
  selectedUid = uid;
  for (const [key, refs] of layerRefs) refs.btn.classList.toggle('is-selected', key === uid);
  /* 默认选中的是字号最大的标题,它常常在列表靠下的位置:滚到可见处,
   * 否则用户看不到"当前选的是哪一行"。直接按两个矩形算列表自己的 scrollTop。 */
  ensureRowVisible(uid);
  requestAnimationFrame(() => ensureRowVisible(uid));
  const st = edits.get(uid);
  els.inspector.hidden = false;
  els.selName.textContent = tl.name;
  els.textarea.value = st ? st.text : tl.text;
  const color = st ? st.color : tl.color;
  els.color.value = color;
  els.hex.value = color.toUpperCase();
  const pct = Math.round((st ? st.opacity : tl.layerOpacity) * 100);
  els.opacity.value = String(pct);
  els.opacityPct.textContent = pct + '%';
  els.opacity.style.setProperty('--imged-fill', pct + '%');
  els.btnRestore.disabled = !(st && st.dirty);
  syncSelMeta(tl, pct);
  requestRender();
  syncSelectionBox();
}

/** 检查器标题下面那行小读数:字号 + 当前透明度,让"选中的是谁、现在什么状态"一眼可见。 */
function syncSelMeta(tl: PsdTextLayer, pct: number): void {
  if (!els) return;
  els.selMeta.textContent = Math.round(tl.fontSize) + 'px · 不透明度 ' + pct + '%';
}

function ensureRowVisible(uid: string): void {
  if (!els) return;
  const refs = layerRefs.get(uid);
  if (!refs) return;
  const list = els.list;
  const lr = list.getBoundingClientRect();
  const br = refs.btn.getBoundingClientRect();
  if (!lr.height || !br.height) return;
  if (br.top < lr.top) list.scrollTop -= lr.top - br.top + 6;
  else if (br.bottom > lr.bottom) list.scrollTop += br.bottom - lr.bottom + 6;
}

function syncLayerRow(uid: string): void {
  const tl = doc && doc.textLayers.find((l) => l.uid === uid);
  const refs = layerRefs.get(uid);
  const st = edits.get(uid);
  if (!tl || !refs || !st) return;
  refs.snippet.textContent = rowMeta(tl, st);
  refs.swatch.style.background = st.color;
  refs.dirty.hidden = !st.dirty;
  refs.btn.classList.toggle('is-dirty', !!st.dirty);
}

function refreshDirtyUi(): void {
  if (!els) return;
  for (const [uid] of layerRefs) syncLayerRow(uid);
  const anyDirty = anyEdited();
  els.btnReset.disabled = !anyDirty || loading || exporting;
  els.btnRestore.disabled = !(currentState() && currentState()!.dirty);
}

function anyEdited(): boolean {
  if (bgIndex !== DEFAULT_BG_INDEX) return true;
  if (selectedCardId) return true;
  for (const st of edits.values()) if (st.dirty) return true;
  return false;
}

/* ==================== 绘制 ==================== */

function requestRender(): void {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    renderNow();
  });
}

function renderNow(): void {
  if (!doc || !els || !baseSceneCtx || !compositeCtx) return;
  if (baseScene.width !== doc.width || baseScene.height !== doc.height) {
    baseScene.width = doc.width;
    baseScene.height = doc.height;
  }
  /* 先画不含名片的底层场景;名片单独画在最上层,拖动/缩放时只重画这一步。 */
  renderDocument(doc, {
    ctx: baseSceneCtx,
    edits,
    background: activeBackground(),
    /* 屏幕挖孔的抗锯齿边会留下半透明像素;垫黑底,导出的 PNG 才是整幅不透明场景 */
    backgroundFill: '#000',
  });
  compositeCtx.clearRect(0, 0, doc.width, doc.height);
  compositeCtx.drawImage(baseScene, 0, 0);
  drawCardTo(compositeCtx);
  blitComposite();
  syncSelectionBox();
  syncCardUi();
}

/* ==================== 改动 / 复位 ==================== */

function restoreSelected(): void {
  if (!doc || !selectedUid) return;
  const tl = doc.textLayers.find((l) => l.uid === selectedUid);
  if (!tl) return;
  edits.set(selectedUid, { text: tl.text, color: tl.color, opacity: tl.layerOpacity, dirty: false });
  selectLayer(selectedUid);
  refreshDirtyUi();
  requestRender();
}

function resetAll(): void {
  if (!doc) return;
  edits = createEditMap(doc);
  bgIndex = DEFAULT_BG_INDEX;
  selectedCardId = '';
  cardMode = 'perspective';
  cardQuad = CARD_DEFAULT_QUAD.map((p) => ({ ...p })) as Quad;
  cardBase = baseFromQuad(CARD_DEFAULT_QUAD);
  cardNaturalWidth = 384;
  cardNaturalHeight = 617;
  cardWarpKey = '';
  cardWarped = null;
  updateBgUi();
  updateCardSection();
  updateCardPickerSelection();
  refreshDirtyUi();
  const keep = selectedUid || (doc.textLayers.length ? doc.textLayers[doc.textLayers.length - 1].uid : '');
  if (keep) selectLayer(keep);
  requestRender();
  setStatus('已撤销全部修改');
}

/* ==================== 导出 ==================== */

async function exportImage(): Promise<void> {
  if (!doc || exporting || loading) return;
  /* 手机 / 平板上没有主进程落盘桥,<a download> 在 Android WebView 里也不会真正写文件。
   * 导航轨在手机端本来也不出现这一格;这里只把原因说清楚。 */
  if (!downloadBridge() && document.documentElement.dataset.ui === 'mobile') {
    setStatus('图片编辑器目前只在桌面版支持导出,手机端请用桌面版处理', 'error');
    return;
  }
  hideResult();
  setStatus('');
  exporting = true;
  setExporting(true);
  refreshButtons();
  const name = 'settlement-' + stamp() + '.png';
  try {
    const canvas = renderToCanvas(doc, edits, activeBackground(), '#000');
    const exportCtx = canvas.getContext('2d');
    if (exportCtx) drawCardTo(exportCtx);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('canvas.toBlob 返回空');
    lastExport = await saveBlob(blob, name);
    syncRevealButton();
    showResult('ok');
  } catch (err) {
    showResult('error', errText(err));
  } finally {
    exporting = false;
    setExporting(false);
    refreshButtons();
  }
}

type SaveResponse = { mode?: string; name?: string; path?: string; entry?: { id?: string } };
type DownloadBridge = {
  save: (n: string, b: Uint8Array) => Promise<SaveResponse | null>;
  /** 在资源管理器里定位某条下载记录(空字符串 = 只打开下载目录) */
  reveal?: (id?: string) => Promise<boolean>;
};
type DesktopBridge = { revealFile?: (path: string) => Promise<boolean> };

/** 桌面客户端的主进程落盘桥(window.dfaeDownloads,见 electron/preload.cjs)。 */
function downloadBridge(): DownloadBridge | null {
  const b = (window as unknown as { dfaeDownloads?: Partial<DownloadBridge> }).dfaeDownloads;
  return b && typeof b.save === 'function' ? (b as DownloadBridge) : null;
}

function desktopBridge(): DesktopBridge | null {
  const d = (window as unknown as { dfaeDesktop?: Partial<DesktopBridge> }).dfaeDesktop;
  return d && typeof d.revealFile === 'function' ? (d as DesktopBridge) : null;
}

/** 落盘:桌面客户端交给主进程(进下载列表、可用"定位");其余走浏览器下载。 */
async function saveBlob(blob: Blob, filename: string): Promise<SaveResult> {
  const bridge = downloadBridge();
  if (bridge) {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const res = await bridge.save(filename, bytes);
      if (res && res.mode === 'auto') {
        return { name: res.name || filename, id: res.entry?.id, path: res.path, size: blob.size };
      }
    } catch {
      /* 主进程落盘失败就退回普通下载,不要停在"导出成功但没有文件" */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { name: filename, size: blob.size };
}

/* ---------- 导出结果卡 / 打开保存位置 ---------- */

function setExporting(on: boolean): void {
  if (!els) return;
  els.btnPng.classList.toggle('is-loading', on);
  els.btnPng.setAttribute('aria-busy', on ? 'true' : 'false');
  els.btnPngText.textContent = on ? '正在导出…' : '导出 PNG';
  els.btnPng.setAttribute('aria-label', on ? '正在导出 PNG' : '导出 PNG');
}

/** 上一次导出是否留下了可定位的文件,并且当前外壳具备"打开文件夹/定位文件"的能力。 */
function canRevealLast(): boolean {
  if (!lastExport || (!lastExport.id && !lastExport.path)) return false;
  const b = downloadBridge();
  const d = desktopBridge();
  return !!(b && typeof b.reveal === 'function') || !!(d && typeof d.revealFile === 'function');
}

function syncRevealButton(): void {
  if (!els) return;
  const can = canRevealLast();
  els.btnReveal.hidden = !can;
  els.resultReveal.hidden = !can;
}

async function revealSaved(): Promise<void> {
  if (!lastExport) return;
  const b = downloadBridge();
  const d = desktopBridge();
  try {
    if (lastExport.id && b && typeof b.reveal === 'function') {
      await b.reveal(lastExport.id);
      return;
    }
    if (lastExport.path && d && typeof d.revealFile === 'function') {
      await d.revealFile(lastExport.path);
      return;
    }
    if (b && typeof b.reveal === 'function') {
      await b.reveal('');
      return;
    }
    setStatus('当前环境不能打开保存位置', 'error');
  } catch (err) {
    setStatus('打开保存位置失败:' + errText(err), 'error');
  }
}

function showResult(kind: 'ok' | 'error', message = ''): void {
  if (!els) return;
  const ok = kind === 'ok';
  els.result.hidden = false;
  els.result.dataset.state = kind;
  els.resultTitle.textContent = ok ? 'PNG 已导出' : '导出失败';
  els.resultName.hidden = !ok || !lastExport;
  els.resultName.textContent = ok && lastExport ? lastExport.name : '';
  const where = canRevealLast() ? '已保存到下载文件夹' : '已通过浏览器下载';
  els.resultNote.textContent = ok
    ? where + (lastExport && lastExport.size ? ' · ' + fmtBytes(lastExport.size) : '')
    : (message || '未知错误');
  els.resultRetry.hidden = ok;
  syncRevealButton();
  /* 失败结果不提供"打开文件夹":它指向的是上一次成功的文件,会误导 */
  if (!ok) els.resultReveal.hidden = true;
  /* 视觉卡片是 region;读屏播报走独立的 live 区域(卡片里带按钮,不适合 role=status) */
  els.live.textContent = ok
    ? 'PNG 已导出:' + (lastExport ? lastExport.name : '') + '。' + els.resultNote.textContent
    : '导出失败:' + (message || '未知错误');
}

function hideResult(): void {
  if (els) els.result.hidden = true;
}

/* ==================== 状态 / 加载层 ==================== */

function refreshButtons(): void {
  if (!els) return;
  const hasDoc = !!doc;
  const blocked = loading || exporting || cardBusy;
  els.btnPng.disabled = !hasDoc || blocked;
  els.btnReset.disabled = !hasDoc || blocked || !anyEdited();
  els.btnRestore.disabled = blocked || !(currentState() && currentState()!.dirty);
  els.cardCurrent.disabled = !hasDoc || blocked;
  els.cardClear.disabled = !hasDoc || blocked;
  els.cardResetRect.disabled = !hasDoc || blocked || !selectedCardId;
  for (const b of els.mount.querySelectorAll<HTMLButtonElement>('[data-imged="sample"]')) b.disabled = blocked;
}

function showLoading(text: string, progress: number): void {
  if (!els) return;
  els.loading.hidden = false;
  els.loadingText.textContent = text;
  els.progressBar.hidden = progress <= 0;
  setLoadingProgress(progress);
}

function setLoadingProgress(p: number): void {
  if (!els) return;
  const pct = Math.max(0, Math.min(1, p));
  els.progressFill.style.transform = 'scaleX(' + pct.toFixed(4) + ')';
}

function hideLoading(): void {
  if (els) els.loading.hidden = true;
}

let statusTimer = 0;
function setStatus(text: string, kind?: 'ok' | 'error'): void {
  if (!els) return;
  els.status.hidden = !text;
  els.status.textContent = text;
  els.status.dataset.state = kind || 'info';
  window.clearTimeout(statusTimer);
  /* 普通提示 6 秒后淡出;失败信息留着(用户要能看到原因) */
  if (kind !== 'error') {
    statusTimer = window.setTimeout(() => {
      if (els) els.status.hidden = true;
    }, 6000);
  }
}
