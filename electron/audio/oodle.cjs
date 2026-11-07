'use strict';
/* ============================================================================
 * Oodle 解压（game/pak 依赖）
 * ---------------------------------------------------------------------------
 * UE pak 里的压缩块是 Oodle 编码，Node 没有内置实现，必须调用厂商 DLL。
 * DLL 由游戏自带（DeltaForce/Binaries/Win64/oo2core_*_win64.dll），不随程序分发。
 * 通过 koffi 做 FFI；找不到 DLL 时整个音频提取功能会明确报错，而不是静默出错。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');

let state = null;

/** 可能的 DLL 位置：环境变量 > 游戏目录 > 随程序携带的 vendor 目录。 */
function candidates(gameRoot) {
  const out = [];
  if (process.env.DFAE_OODLE) out.push(process.env.DFAE_OODLE);
  if (gameRoot) {
    const dir = path.join(gameRoot, 'DeltaForce', 'Binaries', 'Win64');
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/^oo2core_\d+_win64\.dll$/i.test(f)) out.push(path.join(dir, f));
      }
    } catch (e) { /* 目录不存在就跳过 */ }
  }
  out.push(path.join(__dirname, 'vendor', 'oodle', 'oo2core_8_win64.dll'));
  return out;
}

function find(gameRoot) {
  for (const p of candidates(gameRoot)) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

function init(dllPath) {
  if (state && state.dllPath === dllPath) return state;
  const lib = koffi.load(dllPath);
  // 与 CUE4Parse 的调用约定一致
  const fn = lib.func(
    'int OodleLZ_Decompress(void* comp, int64_t compSize, void* raw, int64_t rawSize,' +
    ' int fuzzSafe, int checkCrc, int verbosity, void* decBufBase, int64_t decBufSize,' +
    ' void* fpCallback, void* callbackUserData, void* decoderMemory, int64_t decoderMemorySize,' +
    ' int threadPhase)'
  );
  state = { dllPath, lib, fn };
  return state;
}

function isReady() { return !!state; }
function dllPath() { return state ? state.dllPath : null; }

/** 解一块压缩流；失败返回 null（调用方据此跳过）。 */
function decompress(comp, rawSize) {
  if (!state) throw new Error('Oodle 尚未初始化');
  const out = Buffer.alloc(rawSize);
  const n = state.fn(comp, comp.length, out, rawSize, 1, 0, 0, null, 0, null, null, null, 0, 3);
  if (!n || n <= 0) return null;
  return out.subarray(0, n);
}

module.exports = { candidates, find, init, isReady, dllPath, decompress };
