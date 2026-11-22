'use strict';
/* ============================================================================
 * Texture2DSpriteAtlas 解析 + 像素解码（图标提取核心）
 * ---------------------------------------------------------------------------
 * 图集是自定义类 Texture2DSpriteAtlas，CUE4Parse 不能自动解它的像素，
 * FModel 时代靠手动解（实现思路文档第 5 节）。本模块复刻该链路：
 *
 *  · 元数据：属性区走 ImportedSize（仅展示用）；存储尺寸/格式/像素起点
 *    直接在 uexp 里搜「平台数据头」—— SizeX/SizeY 都是 2 的幂
 *    (PadToPowerOfTwo)，其后 96 字节内必有一条 PF_XXX 的 FString。
 *  · 像素格式（本作实测三种，全量 179 个图集：PF_BC7×110、PF_DXT5×19、
 *    PF_B8G8R8A8×48）。PF 字符串之后是一段固定头部，长度随格式不同
 *    （BC7 32B、B8G8R8A8 135B…），所以用「mip 链总长 = 文件剩余字节」
 *    反解起点：按 16..256 步长试探，用格式的每像素字节数校验。
 *  · 解码：BC7/DXT5 走 texture2ddecoder-wasm（BC7 按 4x4 块独立编码，
 *    只抽裁剪区域的块解，256x256 图标 ~10ms；DXT5 同理 16B/块）；
 *    B8G8R8A8 是未压缩 BGRA，直接按字节裁。BGRA → RGBA 都要交换 R/B。
 *  · WASM 在 Electron 31（Node 20）下官方入口加载失败，见 wasm-loader.cjs。
 * ========================================================================== */
const { parseNames, parseSummary, walkProperties } = require('./sprite.cjs');

function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }

function readFStringAt(buf, pos) {
  if (pos + 4 > buf.length) return null;
  const len = buf.readInt32LE(pos);
  if (len <= 0 || len > 64 || pos + 4 + len > buf.length) return null;
  if (buf[pos + 4 + len - 1] !== 0) return null;
  return buf.toString('latin1', pos + 4, pos + 4 + len - 1);
}

/** 各格式的每像素/每块字节数与解码器。decompress=false 表示未压缩 RAW。 */
const FORMATS = {
  PF_BC7:      { decoder: 'bc7',   bytesPerPixel: 1, blockBytes: 16 },
  PF_DXT5:     { decoder: 'bc3',   bytesPerPixel: 1, blockBytes: 16 },
  PF_DXT1:     { decoder: 'bc1',   bytesPerPixel: 0.5, blockBytes: 8 },
  PF_BC5:      { decoder: 'bc5',   bytesPerPixel: 1, blockBytes: 16 },
  PF_BC6H:     { decoder: 'bc6',   bytesPerPixel: 1, blockBytes: 16 },
  PF_B8G8R8A8: { decoder: null,    bytesPerPixel: 4, blockBytes: 0 },
  PF_R8G8B8A8: { decoder: 'rgba',  bytesPerPixel: 4, blockBytes: 0 },
  PF_A8R8G8B8: { decoder: null,    bytesPerPixel: 4, blockBytes: 0 },
};

/** 一个完整 mip 链（直到 1x1）的总像素数 = W*H*(1+1/4+1/16+…)。 */
function fullChainPixels(w, h) {
  let total = 0;
  let cw = w, ch = h;
  for (let i = 0; i < 16 && cw >= 1 && ch >= 1; i++) {
    total += cw * ch;
    if (cw === 1 && ch === 1) break;
    cw = Math.max(1, Math.floor(cw / 2));
    ch = Math.max(1, Math.floor(ch / 2));
  }
  return total;
}

/**
 * 解析图集：存储尺寸、像素格式、mip0 载荷起点。
 * @returns {{ok:true, storageW, storageH, format, formatInfo, payloadOffset, importedSize?:{x,y}}
 *          |{ok:false, error:string}}
 */
function parseAtlas(uasset, uexp) {
  try {
    const summary = parseSummary(uasset);
    const nt = parseNames(uasset, summary.nameCount, summary.nameOffset);
    if (!nt.ok) return { ok: false, error: nt.error };
    // ImportedSize 只是展示信息，解析不到不影响裁剪（UV 在存储坐标系里）
    const walk = walkProperties(uexp, nt.names, {
      stop: (props) => props.has('ImportedSize') || props.has('ForcePlatformSettings'),
    });
    const importedSize = walk.props.get('ImportedSize') || null;

    /* 平台数据头（实测三种格式结构一致）：
     *   [SizeX][SizeY][1][PF 长度]["PF_XXX\0"]
     *   [0][NumMips][1][72][mip0Bytes][mip0Bytes][?][0]
     *   [mip0 数据...][mip1..][0x68 字节尾部]
     * 关键锚点：PF 字符串前 12/8 字节就是 SizeX/SizeY；PF 之后的那对等值
     * u32 = mip0 的**字节数**（= W*H*每像素字节数），载荷在它之后 +16。
     * 尾部固定 104 字节，mip 链 = mip0..mip(NumMips-1)。 */
    const limit = Math.min(uexp.length, 0x20000);
    for (let i = 8; i + 8 < limit; i++) {
      const name = readFStringAt(uexp, i);
      if (!name || !/^PF_[A-Za-z0-9_]+$/.test(name)) continue;
      const info = FORMATS[name];
      if (!info) continue; // 未知格式：继续找（同文件里可能有别的平台块）
      const w = uexp.readInt32LE(i - 12);
      const h = uexp.readInt32LE(i - 8);
      // 存储尺寸不一定被 pad 到 2 的幂（PowerOfTwoMode=None 的图集实测 1648x960），
      // 真正的锚点是下面那对 "mip0 字节数"。
      if (!(w >= 8 && h >= 8 && w <= 16384 && h <= 16384)) continue;
      const pfEnd = i + 4 + name.length + 1;
      const mip0Bytes = w * h * info.bytesPerPixel;
      // 找 PF 后 64 字节内那对等值 u32 = mip0Bytes
      let pairAt = -1;
      for (let q = pfEnd; q <= Math.min(pfEnd + 64, uexp.length - 8); q++) {
        if (uexp.readUInt32LE(q) === mip0Bytes && uexp.readUInt32LE(q + 4) === mip0Bytes) { pairAt = q; break; }
      }
      if (pairAt < 0) continue;
      // mip 链总长（用 NumMips 头字段；读不到就按 3 级）
      let numMips = uexp.readInt32LE(pfEnd + 4);
      if (!(numMips >= 1 && numMips <= 16)) numMips = 3;
      const chainBytes = (() => {
        let total = 0, cw = w, ch = h;
        for (let m = 0; m < numMips && cw >= 1 && ch >= 1; m++) {
          total += cw * ch * info.bytesPerPixel;
          if (cw === 1 && ch === 1) break;
          cw = Math.floor(cw / 2); ch = Math.floor(ch / 2);
        }
        return Math.ceil(total);
      })();
      for (const payload of [pairAt + 16, pairAt + 8]) {
        if (payload >= uexp.length) continue;
        const tailLen = uexp.length - payload;
        if (tailLen < mip0Bytes) continue;
        const extra = tailLen - chainBytes;
        if (extra >= 0 && extra <= 4096) {
          return {
            ok: true,
            storageW: w,
            storageH: h,
            format: name,
            formatInfo: info,
            payloadOffset: payload,
            importedSize,
            textLen: uexp.length,
            numMips,
            footerBytes: extra,
          };
        }
      }
    }
    return { ok: false, error: '没有找到可用的平台数据头（SizeX/SizeY + PF_ 字符串 + mip 链长度校验失败）' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 解码器懒加载：texture2ddecoder-wasm 是 WASM，首次用时要 initialize()。 */
let decoder = null;
let decoderError = null;
async function ensureDecoder() {
  if (decoder) return decoder;
  if (decoderError) throw new Error(decoderError);
  /* 1) 官方入口：Node ≥ 22 的主进程可以直接 require（CJS 里允许 import.meta）。 */
  try {
    const mod = require('texture2ddecoder-wasm');
    await mod.initialize();
    decoder = mod;
    return decoder;
  } catch (e) {
    /* 2) 官方入口加载失败（Electron 31 主进程 = Node 20，包内胶水是 ESM）：
     *    走 electron/icons/wasm-loader.cjs 的兼容加载器（复制成 .mjs 再动态 import）。 */
    try {
      const loader = require('./wasm-loader.cjs');
      const instance = await loader.load();
      decoder = {
        initialize: async () => {},
        decode_bc7: async (data, w, h) => loader.asUint8Array(instance.decode_bc7(data, w, h)),
        decode_bc3: async (data, w, h) => loader.asUint8Array(instance.decode_bc3(data, w, h)),
        decode_bc1: async (data, w, h) => loader.asUint8Array(instance.decode_bc1(data, w, h)),
        decode_bc5: async (data, w, h) => loader.asUint8Array(instance.decode_bc5(data, w, h)),
        decode_bc6: async (data, w, h) => loader.asUint8Array(instance.decode_bc6(data, w, h)),
      };
      return decoder;
    } catch (e2) {
      decoderError = 'BC7 解码库加载失败: ' + (e2 && e2.message ? e2.message : String(e2));
      throw new Error(decoderError);
    }
  }
}

/**
 * 只解码图集里需要的矩形区域。
 * @param {Buffer} payload mip0 起始的字节（不要求精确长度：按格式算）
 * @param {number} W 存储宽 @param {number} H 存储高
 * @param {number} x @param {number} y @param {number} rw @param {number} rh 请求区域
 * @param {object} meta parseAtlas 的结果（用 format/formatInfo）
 */
async function decodeRegion(payload, W, H, x, y, rw, rh, meta) {
  if (x < 0 || y < 0 || rw <= 0 || rh <= 0 || x + rw > W || y + rh > H) {
    return { ok: false, error: '裁剪区域越界: (' + x + ',' + y + ' ' + rw + 'x' + rh + ') 图集 ' + W + 'x' + H };
  }
  const format = (meta && meta.format) || 'PF_BC7';
  const info = (meta && meta.formatInfo) || FORMATS[format] || FORMATS.PF_BC7;
  const rgba = new Uint8Array(rw * rh * 4);

  // 未压缩格式：直接按字节裁（BGRA 换 R/B）
  if (info.decoder === null || info.decoder === 'rgba') {
    const isRGBA = info.decoder === 'rgba';
    for (let row = 0; row < rh; row++) {
      const src = ((y + row) * W + x) * 4;
      const dst = row * rw * 4;
      for (let col = 0; col < rw; col++) {
        const s = src + col * 4;
        const d = dst + col * 4;
        if (isRGBA) {
          rgba[d] = payload[s]; rgba[d + 1] = payload[s + 1]; rgba[d + 2] = payload[s + 2]; rgba[d + 3] = payload[s + 3];
        } else {
          rgba[d] = payload[s + 2]; rgba[d + 1] = payload[s + 1]; rgba[d + 2] = payload[s]; rgba[d + 3] = payload[s + 3];
        }
      }
    }
    return { ok: true, rgba, w: rw, h: rh, format };
  }

  // 块压缩格式：只抽覆盖裁剪区域的 4x4 块
  const bb = info.blockBytes;
  const bx0 = Math.floor(x / 4) * 4;
  const by0 = Math.floor(y / 4) * 4;
  const bx1 = Math.min(W, Math.ceil((x + rw) / 4) * 4);
  const by1 = Math.min(H, Math.ceil((y + rh) / 4) * 4);
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  const blocksX = W / 4;
  const outBlocksX = bw / 4;
  const outBlocksY = bh / 4;
  const sub = Buffer.alloc(outBlocksX * bb * outBlocksY);
  for (let row = 0; row < outBlocksY; row++) {
    const srcOff = ((by0 / 4 + row) * blocksX + bx0 / 4) * bb;
    payload.copy(sub, row * outBlocksX * bb, srcOff, srcOff + outBlocksX * bb);
  }
  let dec;
  try {
    const t2d = await ensureDecoder();
    const fnName = 'decode_' + info.decoder;
    const fn = t2d[fnName];
    if (typeof fn !== 'function') return { ok: false, error: '解码器缺少 ' + fnName };
    dec = await fn.call(t2d, sub, bw, bh);
  } catch (e) {
    return { ok: false, error: '解码失败(' + format + '): ' + (e && e.message ? e.message : String(e)) };
  }
  if (!dec || dec.length < bw * bh * 4) return { ok: false, error: '解码输出不足(' + format + ')' };
  // BGRA → RGBA，同时抽掉块对齐多出来的边缘
  for (let row = 0; row < rh; row++) {
    const sy = by0 + row - y;
    const srcRow = (sy * bw + (x - bx0)) * 4;
    const dstRow = row * rw * 4;
    for (let col = 0; col < rw; col++) {
      const s = srcRow + col * 4;
      const d = dstRow + col * 4;
      rgba[d] = dec[s + 2];
      rgba[d + 1] = dec[s + 1];
      rgba[d + 2] = dec[s];
      rgba[d + 3] = dec[s + 3];
    }
  }
  return { ok: true, rgba, w: rw, h: rh, format };
}

/** 按 RGB 乘法染色（白色 sprite × 目标色 = 成品色），alpha 不变。 */
function tintRGBA(rgba, rgb) {
  if (!rgb) return rgba;
  const kr = rgb[0] / 255, kg = rgb[1] / 255, kb = rgb[2] / 255;
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = Math.min(255, Math.round(rgba[i] * kr));
    rgba[i + 1] = Math.min(255, Math.round(rgba[i + 1] * kg));
    rgba[i + 2] = Math.min(255, Math.round(rgba[i + 2] * kb));
  }
  return rgba;
}

/** 判断裁剪结果是否全透明（图集里那块是空白）。 */
function isBlankRGBA(rgba) {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 0) return false;
  }
  return true;
}

module.exports = { parseAtlas, decodeRegion, tintRGBA, isBlankRGBA, ensureDecoder, FORMATS };
