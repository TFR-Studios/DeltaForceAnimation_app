'use strict';
/* ============================================================================
 * PNG 编码器（主进程，图标提取导出用）
 * ---------------------------------------------------------------------------
 * 图标裁剪结果是 8-bit RGBA 像素，直接按 PNG 规范封一个最小文件：
 * IHDR(8bit RGBA) + IDAT(zlib, 每行前置 filter 0) + IEND。不引第三方依赖。
 * 只写 filter 0（None），tools/check-icons-parser.mjs 里的校验器按这个约定解包。
 * ========================================================================== */
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * 把 RGBA 像素编成 PNG。
 * @param {number} w 宽
 * @param {number} h 高
 * @param {Uint8Array|Buffer} rgba 长度必须等于 w*h*4
 * @returns {Buffer}
 */
function encodePNG(w, h, rgba) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w > 16384 || h > 16384) {
    throw new Error('PNG 尺寸非法: ' + w + 'x' + h);
  }
  if (!rgba || rgba.length !== w * h * 4) {
    throw new Error('PNG 像素长度不符: 期望 ' + (w * h * 4) + ' 实得 ' + (rgba ? rgba.length : 'null'));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { encodePNG };
