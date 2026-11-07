'use strict';
/* ============================================================================
 * 音频提取（.wem + RIFF 信息）
 * ---------------------------------------------------------------------------
 * 已实测：WwiseAudio/Media 的 .ubulk 就是完整 .wem（RIFF/WAVE），
 * 且 RIFF size + 8 == 文件长度。所以不需要再解析 FByteBulkData 描述符，
 * 直接读 .ubulk 并做一次严格校验即可。
 *
 * 名字来自 .uexp：属性区里最长的可打印 ASCII 字符串就是 AkMediaAsset.MediaName
 * （随机 20 条实测 20/20 命中）；取不到就退回数字 ID。
 * ========================================================================== */
const { PakFile } = require('./pak.cjs');

/* 0x8311 是 Wwise 的 Platinum 4-bit ADPCM（vgmstream 实测确认），不是 Opus ——
 * 这是个常见的误标，别按 Opus 写。 */
const CODECS = {
  0x0001: 'PCM', 0x0002: 'ADPCM', 0x0003: 'IEEE_FLOAT', 0x0011: 'IMA_ADPCM',
  0xFFFF: 'Vorbis', 0x8311: 'ADPCM', 0x3032: 'ADPCM', 0xFFFE: 'Extensible',
};

const PLATFORM_NAMES = new Set(['Windows_HD', 'Windows_LS', 'None', 'Windows']);

/** 从 .uexp 里挑出最像 MediaName 的字符串。 */
function bestMediaName(buf, fallback) {
  if (!buf || !buf.length) return fallback;
  let best = '';
  for (let off = 0; off + 4 <= buf.length; off++) {
    const n = buf.readInt32LE(off);
    if (n < 3 || n > 200) continue;
    const end = off + 4 + n;
    if (end > buf.length) continue;
    if (buf[end - 1] !== 0) continue;
    let ok = true;
    for (let i = off + 4; i < end - 1; i++) {
      const c = buf[i];
      if (c < 32 || c > 126) { ok = false; break; }
    }
    if (!ok) continue;
    const s = buf.toString('latin1', off + 4, end - 1);
    if (PLATFORM_NAMES.has(s)) { off = end - 1; continue; }
    if (s.length > best.length) best = s;
    off = end - 1;
  }
  return best || fallback;
}

/** 解析 RIFF/WAVE；不是音频返回 null。 */
function riffInfo(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let p = 12, fmt = null, dataSize = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      fmt = {
        tag: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataSize = size;
    }
    p = body + size + (size & 1);
  }
  if (!fmt) return null;
  const codec = CODECS[fmt.tag] || ('tag_0x' + fmt.tag.toString(16).padStart(4, '0'));
  let duration = 0;
  if (dataSize && fmt.rate && fmt.channels) {
    const bytesPerSample = Math.max(1, Math.round(fmt.bits / 8));
    if (fmt.tag === 0x0001) {
      duration = dataSize / (fmt.rate * fmt.channels * bytesPerSample);
    } else if (fmt.tag === 0x8311) {
      // 0x8311 的时长：Wwise Platinum 4-bit ADPCM，1 字节 = 2 个采样（近似值）。
      duration = (dataSize * 2) / (fmt.rate * fmt.channels);
    }
  }
  return {
    codec, tag: fmt.tag, channels: fmt.channels, rate: fmt.rate, bits: fmt.bits,
    dataSize, duration, serializedSize: buf.length,
    riffSizeMatches: buf.readUInt32LE(4) + 8 === buf.length,
  };
}

function classify(buf) {
  if (!buf || !buf.length) return 'empty';
  if (buf.toString('latin1', 0, 4) === 'ADM3') return 'adm3';
  if (riffInfo(buf)) return 'riff';
  return 'other';
}

const ID_RE = /([0-9]+)$/;

/** 从 vpath 推 id（文件名主干）与 .uexp/.ubulk 路径。 */
function pathsOf(vpath) {
  const base = vpath.replace(/\.uasset$/i, '');
  const stem = base.slice(base.lastIndexOf('/') + 1);
  return { base, stem, uexp: base + '.uexp', ubulk: base + '.ubulk', id: stem };
}

/**
 * 提取一条音频。
 * @returns {{ok:boolean, kind?:string, wem?:Buffer, info?:object, name?:string, error?:string}}
 */
function extractOne(pak, item, oodle) {
  const p = pathsOf(item.vpath);
  let uexp = null;
  try { uexp = pak.read(p.uexp, oodle); } catch (e) { uexp = null; }
  const name = bestMediaName(uexp, item.name || p.id);
  let bulk = null;
  try { bulk = pak.read(p.ubulk, oodle); } catch (e) { bulk = null; }
  if (!bulk || !bulk.length) {
    // 没有 .ubulk：可能内联在 .uexp 尾部，退回到描述符扫描
    if (uexp) {
      for (let c = 0; c + 20 <= uexp.length; c++) {
        const flags = uexp.readUInt32LE(c);
        const count = uexp.readInt32LE(c + 4);
        const sod = uexp.readInt32LE(c + 8);
        if ((flags & 0x100) && count > 0 && count === sod && c + 20 + count <= uexp.length) {
          bulk = uexp.subarray(c + 20, c + 20 + count);
          break;
        }
      }
    }
  }
  if (!bulk || !bulk.length) return { ok: false, kind: 'empty', name, error: '没有音频数据（可能是不含该 chunk 的空占位）' };
  const kind = classify(bulk);
  if (kind !== 'riff') return { ok: false, kind, name, error: kind === 'adm3' ? 'ADM3 参数块，不是音频' : '不是 RIFF 音频' };
  const info = riffInfo(bulk);
  return { ok: true, kind, wem: bulk, info, name };
}

module.exports = { extractOne, riffInfo, classify, bestMediaName, pathsOf, CODECS };
