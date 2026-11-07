'use strict';
/* ============================================================================
 * 三角洲行动 pak 读取器（UE4 pak v11）
 * ---------------------------------------------------------------------------
 * 移植自 DFViewer 的 core/pak.py（REA 逆向 + 本机实测验证）。
 *
 * 只读，不写游戏目录。链路：
 *   footer -> 索引区 AES-256-ECB + XOR 单字节 mask -> 条目表(FDI) -> 按虚拟路径读文件
 *
 * 几个实测结论（不要"优化"掉）：
 *   · footer 就是最后 204 字节：magic/version/index_offset/index_size/sha1/5x32 方法名；
 *   · 索引的 mask 可以从密文首块推出来：明文前 8 字节是 path_hash_seed=0，
 *     所以 AES 解出来的前几个字节都等于 mask；
 *   · FPakEntry 是位打包的，32/64 位字段由 bitfield 的 31/30/29 位决定，
 *     不能按固定布局切（见 record()）；
 *   · 数据块的 offset 是 i64 且可能为负，定位只用 blocks[]，不要拿 offset 猜。
 * ========================================================================== */
const fs = require('fs');
const crypto = require('crypto');

const FOOTER_SIZE = 204;
const MAGIC = 0x5A6F12E1;

class PakError extends Error {}

function xorByte(buf, m) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ m;
  return out;
}

/** UE FString：i32 长度（含结尾 0），负数为 UTF-16。 */
function readFString(buf, pos) {
  const len = buf.readInt32LE(pos);
  pos += 4;
  if (len === 0) return { value: '', pos };
  if (len > 0) {
    return { value: buf.toString('latin1', pos, pos + len - 1), pos: pos + len };
  }
  const n = -len;
  return { value: buf.toString('utf16le', pos, pos + n * 2 - 2), pos: pos + n * 2 };
}

class PakFile {
  /**
   * @param {string} filePath
   * @param {{ keyvault?: {keys:Object, paks:Object}, oodle?: Object }} opts
   */
  constructor(filePath, opts) {
    opts = opts || {};
    this.path = filePath;
    this.name = filePath.split(/[\\/]/).pop();
    this.size = fs.statSync(filePath).size;
    this.fd = fs.openSync(filePath, 'r');
    this.keyvault = opts.keyvault || null;
    this.oodle = opts.oodle || null;
    /** 只保留匹配前缀的目录，避免把 100 万条目全塞进内存 */
    this.keepFilter = opts.keepFilter || null;
    this.entries = new Map();
    this.methods = ['None'];
    try {
      this._readFooter();
      this._findKey();
      this._openIndex();
    } catch (e) {
      try { fs.closeSync(this.fd); } catch (e2) {}
      throw e;
    }
  }

  readAt(off, n) {
    if (n <= 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(n);
    let got = 0;
    while (got < n) {
      const r = fs.readSync(this.fd, buf, got, n - got, off + got);
      if (!r) break;
      got += r;
    }
    return got === n ? buf : buf.subarray(0, got);
  }

  close() {
    if (this.fd != null) {
      try { fs.closeSync(this.fd); } catch (e) {}
      this.fd = null;
    }
  }

  _readFooter() {
    if (this.size < FOOTER_SIZE) throw new PakError('文件太小，不是 pak: ' + this.name);
    const buf = this.readAt(this.size - FOOTER_SIZE, FOOTER_SIZE);
    if (buf.readUInt32LE(0) !== MAGIC) throw new PakError('magic 不对: ' + this.name);
    this.version = buf.readUInt32LE(4);
    this.indexOffset = Number(buf.readBigInt64LE(8));
    this.indexSize = Number(buf.readBigInt64LE(16));
    this.indexHash = buf.subarray(24, 44);
    const names = [];
    for (let i = 0; i < 5; i++) {
      const slot = buf.subarray(44 + i * 32, 44 + (i + 1) * 32);
      const z = slot.indexOf(0);
      const s = (z === -1 ? slot : slot.subarray(0, z)).toString('latin1');
      if (s) names.push(s);
    }
    this.compressionMethodNames = names;
    this.methods = ['None'].concat(names);
  }

  /** 在密钥库里试出 (key, mask)：明文开头是 8 字节 0，所以解密结果前几字节相同即 mask。 */
  _findKey() {
    const vault = this.keyvault;
    if (!vault || !vault.keys) throw new PakError('缺少密钥库');
    const head = this.readAt(this.indexOffset, 16);
    const tried = new Set();
    const attempt = (keyBuf, guid, maskGuess) => {
      if (!keyBuf || keyBuf.length !== 32) return null;
      let dec;
      try {
        const d = crypto.createDecipheriv('aes-256-ecb', keyBuf, null);
        d.setAutoPadding(false);
        dec = Buffer.concat([d.update(head), d.final()]);
      } catch (e) { return null; }
      const masks = maskGuess == null ? [dec[0]] : [maskGuess];
      for (const m of masks) {
        const plain = xorByte(dec, m);
        if (plain.readUInt32LE(0) !== 0 || plain.readUInt32LE(4) !== 0) continue;
        const count = plain.readUInt32LE(8);
        if (count <= 0 || count > 5000000) continue;
        const len = plain.readInt32LE(12);
        if (len <= 0 || len > 512) continue;
        return { key: keyBuf, keyName: guid || '?', mask: m };
      }
      return null;
    };

    const known = vault.paks && vault.paks[this.name];
    if (known && vault.keys[known.guid]) {
      const r = attempt(Buffer.from(vault.keys[known.guid].replace(/^0x/i, ''), 'hex'), known.guid, known.mask);
      if (r) { this.key = r.key; this.keyName = r.keyName; this.mask = r.mask; return; }
    }
    for (const guid of Object.keys(vault.keys)) {
      if (tried.has(guid)) continue;
      tried.add(guid);
      const r = attempt(Buffer.from(vault.keys[guid].replace(/^0x/i, ''), 'hex'), guid, null);
      if (r) { this.key = r.key; this.keyName = r.keyName; this.mask = r.mask; return; }
    }
    throw new PakError('没有可用的 AES 密钥: ' + this.name);
  }

  _decrypt(blob, size) {
    const m = this.mask;
    const cut = blob.length - (blob.length % 16);
    let out;
    if (cut <= 0) {
      out = xorByte(blob, m);
    } else {
      const d = crypto.createDecipheriv('aes-256-ecb', this.key, null);
      d.setAutoPadding(false);
      const dec = Buffer.concat([d.update(blob.subarray(0, cut)), d.final()]);
      out = Buffer.concat([xorByte(dec, m), xorByte(blob.subarray(cut), m)]);
    }
    return size ? out.subarray(0, size) : out;
  }

  _openIndex() {
    const plain = this._decrypt(this.readAt(this.indexOffset, this.indexSize), 0);
    let p = 0;
    this.pathHashSeed = Number(plain.readBigUInt64LE(p)); p += 8;
    this.fileCount = plain.readUInt32LE(p); p += 4;
    const mount = readFString(plain, p); p = mount.pos;
    this.mountPoint = mount.value;
    const hasPathHash = plain.readUInt32LE(p); p += 4;
    if (hasPathHash) p += 8 + 8 + 20;
    const hasFdi = plain.readUInt32LE(p); p += 4;
    if (hasFdi) {
      this.fdiOffset = Number(plain.readBigInt64LE(p)); p += 8;
      this.fdiSize = Number(plain.readBigInt64LE(p)); p += 8;
      p += 20;
    }
    this.encodedSize = plain.readUInt32LE(p); p += 4;
    this.encoded = plain.subarray(p, p + this.encodedSize);
    if (this.fdiOffset && this.fdiSize) this._parseFdi();
  }

  _parseFdi() {
    const plain = this._decrypt(this.readAt(this.fdiOffset, this.fdiSize), 0);
    let p = 0;
    const dirCount = plain.readUInt32LE(p); p += 4;
    const keep = this.keepFilter;
    for (let i = 0; i < dirCount; i++) {
      const dir = readFString(plain, p); p = dir.pos;
      const fileCount = plain.readUInt32LE(p); p += 4;
      const prefix = dir.value;
      const keepDir = !keep || keep(prefix);
      for (let j = 0; j < fileCount; j++) {
        const nm = readFString(plain, p); p = nm.pos;
        const loc = plain.readUInt32LE(p); p += 4;
        if (keepDir || !keep) this.entries.set(prefix + nm.value, loc);
      }
    }
  }

  _lookup(vpath) {
    let loc = this.entries.get(vpath);
    if (loc === undefined && this.mountPoint && vpath.startsWith(this.mountPoint)) {
      loc = this.entries.get(vpath.slice(this.mountPoint.length));
    }
    if (loc === undefined) loc = this.entries.get(vpath.replace(/^\.+/, '').replace(/^\/+/, ''));
    return loc;
  }

  /** 解开一条 FPakEntry（UE4 FPakFile::DecodePakEntry 的等价实现）。 */
  record(vpath) {
    const loc = this._lookup(vpath);
    const enc = this.encoded;
    if (loc === undefined || loc === null || loc < 0 || loc + 4 > enc.length) return null;
    let p = loc;
    const bitfield = enc.readUInt32LE(p); p += 4;
    let blockSize;
    if ((bitfield & 63) === 63) {
      if (p + 4 > enc.length) return null;
      blockSize = enc.readUInt32LE(p); p += 4;
    } else {
      blockSize = (bitfield & 63) << 11;
    }
    const methodIndex = (bitfield >>> 23) & 63;
    const method = methodIndex < this.methods.length ? this.methods[methodIndex] : '?';
    const off32 = (bitfield >>> 31) & 1;
    const usz32 = (bitfield >>> 30) & 1;
    const csz32 = (bitfield >>> 29) & 1;
    const encrypted = (bitfield >>> 22) & 1;
    const blockCount = (bitfield >>> 6) & 0xffff;
    const compressed = method.toLowerCase() !== 'none';
    let need = (off32 ? 4 : 8) + (usz32 ? 4 : 8);
    if (compressed) need += csz32 ? 4 : 8;
    if (blockCount > 1) need += blockCount * 4;
    if (p + need > enc.length) return null;
    let offset, usize, csize;
    if (off32) { offset = enc.readUInt32LE(p); p += 4; } else { offset = Number(enc.readBigInt64LE(p)); p += 8; }
    if (usz32) { usize = enc.readUInt32LE(p); p += 4; } else { usize = Number(enc.readBigInt64LE(p)); p += 8; }
    if (compressed) {
      if (csz32) { csize = enc.readUInt32LE(p); p += 4; } else { csize = Number(enc.readBigInt64LE(p)); p += 8; }
    } else {
      csize = usize;
    }
    const headerSize = 53 + (compressed ? 4 + blockCount * 16 : 0);
    const blocks = [];
    if (compressed && blockCount === 1 && !encrypted) {
      blocks.push([offset + headerSize, offset + headerSize + csize]);
    } else if (blockCount > 0) {
      let base = offset + headerSize;
      const align = encrypted ? 16 : 1;
      for (let i = 0; i < blockCount; i++) {
        if (p + 4 > enc.length) return null;
        const len = enc.readUInt32LE(p); p += 4;
        blocks.push([base, base + len]);
        base += Math.ceil(len / align) * align;
      }
    }
    return {
      kind: compressed ? 'compressed' : 'stored',
      flags: encrypted ? 1 : 0,
      method, usize, offset, csize, headerSize, blocks,
      encrypted: !!encrypted,
      blockSize,
    };
  }

  _readBlocks(rec, oodle, decrypted) {
    const out = [];
    let pos = 0;
    let remain = rec.usize;
    const enc = rec.encrypted;
    for (const pair of rec.blocks) {
      const a = pair[0], b = pair[1];
      const n = b - a;
      const want = Math.min(rec.blockSize || remain, remain);
      let chunk;
      if (decrypted) {
        const span = enc ? Math.ceil(n / 16) * 16 : n;
        chunk = decrypted.subarray(pos, pos + span);
      } else {
        chunk = this.readAt(a, n);
      }
      const part = oodle.decompress(chunk.subarray(0, n), want);
      if (!part) return null;
      out.push(part);
      remain -= want;
      pos += enc ? Math.ceil(n / 16) * 16 : n;
    }
    return Buffer.concat(out);
  }

  /** 读一个虚拟路径的完整内容；读不到/解压失败返回 null。 */
  read(vpath, oodle) {
    const rec = this.record(vpath);
    if (!rec) return null;
    const start = rec.offset + rec.headerSize;
    const padded = Math.ceil(rec.csize / 16) * 16;
    if (rec.kind === 'stored') {
      if (rec.encrypted) return this._decrypt(this.readAt(start, padded), rec.csize);
      return this.readAt(start, rec.csize);
    }
    if (!oodle) return null;
    if (!rec.encrypted) {
      if (rec.blocks.length <= 1) return oodle.decompress(this.readAt(start, rec.csize), rec.usize);
      return this._readBlocks(rec, oodle, null);
    }
    const blob = this._decrypt(this.readAt(start, padded), rec.csize);
    if (rec.blocks.length <= 1) return oodle.decompress(blob, rec.usize);
    return this._readBlocks(rec, oodle, blob);
  }

  info() {
    return {
      name: this.name, size: this.size, version: this.version,
      keyName: this.keyName, mask: this.mask,
      fileCount: this.fileCount, mountPoint: this.mountPoint,
      indexOffset: this.indexOffset, indexSize: this.indexSize,
      fdiOffset: this.fdiOffset, fdiSize: this.fdiSize,
    };
  }
}

module.exports = { PakFile, PakError, readFString };
