'use strict';
/* ============================================================================
 * texture2ddecoder-wasm 兼容加载器
 * ---------------------------------------------------------------------------
 * 包的官方入口(dist/index.cjs)在 Node 下用 `await import("../wasm/texture2ddecoder.js")`
 * 加载 Emscripten 胶水。那份胶水是 ESM(用了 import.meta.url 与顶层 await),
 * 而包没有 "type":"module",于是：
 *   · Node ≥ 22：CJS 里允许 import.meta,能跑；
 *   · Electron 31 主进程(Node 20)：报
 *     "Cannot use 'import.meta' outside a module" —— 应用里 BC7 解码失败。
 *
 * 规避办法:把胶水复制成 .mjs(和 .wasm 放同一个临时目录),再用动态 import 加载。
 * ESM 下 import.meta.url 可用,胶水按自身位置找同目录的 .wasm,一切正常。
 * 临时目录用系统临时目录(只读安装目录也能用),体积约 180KB,内容不变时不重复复制。
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let cached = null;

/** @returns {string} 包根目录(如 .../node_modules/texture2ddecoder-wasm) */
function packageRoot() {
  // 不能用 require.resolve('texture2ddecoder-wasm/package.json'):
  // 包的 exports 只导出了 ".",子路径会被 Node 拒绝。
  return path.dirname(path.dirname(require.resolve('texture2ddecoder-wasm')));
}

function prepareFiles() {
  const srcDir = path.join(packageRoot(), 'wasm');
  const dstDir = path.join(os.tmpdir(), 'dfae-icons-wasm');
  fs.mkdirSync(dstDir, { recursive: true });
  const pairs = [
    [path.join(srcDir, 'texture2ddecoder.js'), path.join(dstDir, 'texture2ddecoder.mjs')],
    [path.join(srcDir, 'texture2ddecoder.wasm'), path.join(dstDir, 'texture2ddecoder.wasm')],
  ];
  for (const [src, dst] of pairs) {
    let need = true;
    try {
      const a = fs.statSync(src);
      const b = fs.statSync(dst);
      need = a.size !== b.size;
    } catch (e) { need = true; }
    if (need) fs.copyFileSync(src, dst);
  }
  return path.join(dstDir, 'texture2ddecoder.mjs');
}

/**
 * 加载 WASM 模块实例(只做一次)。
 * 返回的实例上直接有 decode_bc7(data, width, height) 等导出(与包内 CJS 包装层用法一致)。
 * @returns {Promise<{ decode_bc7: (data: Uint8Array, width: number, height: number) => unknown }>}
 */
async function load() {
  if (cached) return cached;
  const mjsPath = prepareFiles();
  const mod = await import(pathToFileURL(mjsPath).href);
  const factory = (mod && mod.default) || mod;
  if (typeof factory !== 'function') throw new Error('兼容加载器:WASM 工厂不是函数');
  const instance = await factory();
  if (!instance || typeof instance.decode_bc7 !== 'function') {
    throw new Error('兼容加载器:WASM 实例缺少 decode_bc7');
  }
  cached = instance;
  return instance;
}

/** 兼容包内包装层的输出转换:把 array-like 转成 Uint8Array。 */
function asUint8Array(out) {
  if (!out || out === null) return null;
  try {
    const n = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) n[i] = out[i];
    return n;
  } catch (e) { return null; }
}

module.exports = { load, asUint8Array, packageRoot, prepareFiles };
