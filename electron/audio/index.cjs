'use strict';
/* ============================================================================
 * 音频清单：扫描 pak 索引 -> 抽 MediaName -> 缓存成 JSON
 * ---------------------------------------------------------------------------
 * 为什么自建索引：DFViewer 的 index.db 只有在用户装过 DFViewer 时才有，
 * 本程序不依赖任何第三方工具。pak 的索引区本身带完整目录表（FDI），
 * 扫一遍 257 个包就能拿到全部 WwiseAudio/Media 路径。
 *
 * 一次构建约 1~3 分钟（取决于磁盘），结果缓存在 userData/audio-index.json，
 * 之后启动直接读缓存；游戏目录变了或者用户手动重建才重扫。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { PakFile } = require('./pak.cjs');
const oodle = require('./oodle.cjs');
const { bestMediaName, pathsOf, riffInfo } = require('./extract.cjs');

const INDEX_VERSION = 1;

function pakDirs(gameRoot) {
  const out = [];
  const add = (p) => { try { if (fs.statSync(p).isDirectory()) out.push(p); } catch (e) {} };
  add(path.join(gameRoot, 'DeltaForce', 'Content', 'Paks'));
  add(path.join(gameRoot, 'DeltaForce', 'PackContent', 'Paks'));
  add(path.join(gameRoot, 'BlackHawkDown', 'BHD', 'Content', 'Paks'));
  const dolphin = path.join(gameRoot, 'DeltaForce', 'Saved', 'Dolphin');
  try {
    for (const name of fs.readdirSync(dolphin)) add(path.join(dolphin, name, 'Paks'));
  } catch (e) { /* 没有热更目录是正常的 */ }
  return out;
}

function listPakFiles(dirs) {
  const out = [];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) if (/\.pak$/i.test(f)) out.push(path.join(d, f));
    } catch (e) {}
  }
  return out;
}

function keepDir(dir) {
  return dir.startsWith('WwiseAudio/Media/') || dir.startsWith('WwiseAudio/Localized/');
}

/**
 * @param {string} gameRoot
 * @param {{vault:object, limit?:number}} opts
 * @param {(p:{phase:string,done:number,total:number,detail?:string})=>void} onProgress
 */
function buildIndex(gameRoot, opts, onProgress) {
  const vault = opts.vault;
  const dll = oodle.find(gameRoot);
  if (!dll) throw new Error('没有找到 Oodle 解压库（游戏 Binaries/Win64/oo2core_*_win64.dll）');
  oodle.init(dll);

  const dirs = pakDirs(gameRoot);
  if (!dirs.length) throw new Error('游戏目录里没有找到 pak 目录：' + gameRoot);
  let files = listPakFiles(dirs);
  if (opts.limit) files = files.slice(0, opts.limit);

  const t0 = Date.now();
  const byVpath = new Map();
  const skippedPaks = [];
  let skipped = 0, readErrors = 0, empty = 0;
  let handled = 0, totalAssets = 0;

  files.forEach((file, i) => {
    const pakName = path.basename(file);
    onProgress({ phase: 'pak', done: i + 1, total: files.length, detail: pakName });
    let pf;
    try {
      pf = new PakFile(file, { keyvault: vault, keepFilter: keepDir });
    } catch (e) {
      skipped++;
      skippedPaks.push({ pak: pakName, reason: e.message });
      return;
    }
    try {
      const list = [];
      for (const rel of pf.entries.keys()) {
        if (!rel.endsWith('.uasset')) continue;
        const vpath = pf.mountPoint + rel;
        const p = pathsOf(vpath);
        // 空占位：pak 里没有 .ubulk，或者它是 0 字节。这类条目点了也导不出东西，
        // 直接不进清单（实测约一成，都是「这个 chunk 没装」的占位）。
        const bulkRel = rel.replace(/\.uasset$/i, '.ubulk');
        const bulkRec = pf.record(bulkRel);
        if (!bulkRec || !bulkRec.usize) { empty++; continue; }
        totalAssets++;
        let name = null;
        try {
          const uexp = pf.read(p.uexp, oodle);
          name = bestMediaName(uexp, '');
        } catch (e) { readErrors++; }
        if (!name) empty++;
        const rec = pf.record(rel);
        // 顺带解一遍音频本体：编码 / 采样率 / 时长都在列表里用得上。
        // 这一步是索引耗时的大头，但换来的是打开页面就能看到编码徽标与时长。
        let info = null;
        try {
          const bulk = pf.read(bulkRel, oodle);
          if (bulk) info = riffInfo(bulk);
        } catch (e) { readErrors++; }
        list.push({
          id: p.id,
          name: name || p.id,
          vpath,
          pak: pakName,
          size: info ? info.serializedSize : (rec ? rec.usize : 0),
          codec: info ? info.codec : '',
          rate: info ? info.rate : 0,
          channels: info ? info.channels : 0,
          duration: info ? info.duration : 0,
          tag: info ? info.tag : 0,
        });
        handled++;
      }
      for (const it of list) byVpath.set(it.vpath, it);
    } finally {
      pf.close();
    }
    if ((i & 15) === 0) {
      onProgress({ phase: 'media', done: handled, total: totalAssets, detail: pakName });
    }
  });

  const items = Array.from(byVpath.values()).sort((a, b) => a.name.localeCompare(b.name));
  onProgress({ phase: 'media', done: handled, total: handled, detail: '完成' });

  return {
    data: {
      version: INDEX_VERSION,
      gameRoot,
      builtAt: Date.now(),
      pakCount: files.length,
      items,
    },
    stats: {
      pakTotal: files.length, pakSkipped: skipped, skippedPaks,
      count: items.length, emptyNames: empty, emptyPlaceholders: empty, readErrors,
      ms: Date.now() - t0,
    },
  };
}

function indexPath(userData) { return path.join(userData, 'audio-index.json'); }

function saveIndex(userData, data) {
  try { fs.mkdirSync(userData, { recursive: true }); } catch (e) {}
  fs.writeFileSync(indexPath(userData), JSON.stringify(data));
  return indexPath(userData);
}

function loadIndex(userData) {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath(userData), 'utf8'));
    if (!data || data.version !== INDEX_VERSION) return null;
    return data;
  } catch (e) { return null; }
}

function search(items, opts) {
  opts = opts || {};
  const q = (opts.query || '').trim().toLowerCase();
  let list = items;
  if (q) {
    list = items.filter((it) =>
      it.name.toLowerCase().includes(q) || it.id.includes(q) || it.pak.toLowerCase().includes(q));
  }
  const offset = Math.max(0, opts.offset || 0);
  const limit = Math.min(500, Math.max(1, opts.limit || 100));
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

module.exports = { buildIndex, saveIndex, loadIndex, search, pakDirs, listPakFiles, INDEX_VERSION };
