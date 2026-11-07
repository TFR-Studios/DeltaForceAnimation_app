'use strict';
/* ============================================================================
 * AES 密钥来源（标准 AESKey1.json 格式）
 * ---------------------------------------------------------------------------
 * 支持 FModel 社区通行格式:
 *   { "Version": "...", "MainKey": "0x...", "Keys": [ { "key": "0x...", "guid": "..." } ] }
 *
 * 查找顺序:
 *   1) <userData>/audio-keys/AESKey1.json —— 用户自己替换的（游戏更新出新包时用）
 *   2) electron/audio/keys/AESKey1.json   —— 随程序内置
 * 另外读 pakkeys.json 里的「包名 -> guid/mask」加速表；表里没有的包会走
 * 逐把钥匙试解（200 把 × 16 字节，很快），所以换新密钥后旧加速表也不会挡路。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const BUNDLED = path.join(__dirname, 'keys', 'AESKey1.json');
const MASKS = path.join(__dirname, 'pakkeys.json');

/** 读一份标准格式密钥库，返回 { GUID: '0x...' }（含伪 guid 'MAIN'）。 */
function readVault(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = {};
  for (const k of j.Keys || []) {
    if (k && k.guid && k.key) keys[String(k.guid).toUpperCase()] = String(k.key);
  }
  if (j.MainKey) keys.MAIN = String(j.MainKey);
  return keys;
}

/** 读取加速表（包名 -> { guid, mask }），失败返回空表。 */
function readMasks() {
  try {
    const j = JSON.parse(fs.readFileSync(MASKS, 'utf8'));
    return j.paks || {};
  } catch (e) { return {}; }
}

/**
 * @param {string} [userData] 用户数据目录；给了就优先用它下面的音频密钥文件
 * @returns {{ keys: Object, paks: Object, source: string }}
 */
function load(userData) {
  const candidates = [];
  if (userData) candidates.push(path.join(userData, 'audio-keys', 'AESKey1.json'));
  candidates.push(BUNDLED);
  for (const file of candidates) {
    try {
      const keys = readVault(file);
      if (Object.keys(keys).length) return { keys, paks: readMasks(), source: file };
    } catch (e) { /* 没有或格式不对就试下一个 */ }
  }
  return { keys: {}, paks: readMasks(), source: '(无)' };
}

module.exports = { load, readVault, BUNDLED };
