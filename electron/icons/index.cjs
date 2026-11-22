'use strict';
/* ============================================================================
 * UI 图标清单：扫描 pak 索引 -> 解析 PaperSprite -> 缓存成 JSON
 * ---------------------------------------------------------------------------
 * 图标不是独立贴图，而是 PaperSprite(UV+尺寸) -> Texture2DSpriteAtlas(大图集)
 * 的两级结构（见 sprite.cjs / atlas.cjs）。索引要回答三个问题：
 *   · 有哪些 sprite（按名字 / 分组检索）；
 *   · 每个 sprite 在哪个 pak 里（导出时按路径开包）；
 *   · 它引用的图集文件在哪个 pak（图集常和 sprite 不同包，建索引时顺带登记）。
 *
 * 一次构建要解 ~1.5 万个 sprite（每个只读 ~1.4KB），比音频索引快得多；
 * 结果缓存 userData/icons-index.json，游戏目录变了或手动重建才重扫。
 * SD(/Content/UI/UIAtlas) 与 HD(/Content/UI_HD/UIAtlas) 都在包里：同名 sprite
 * 以 SD 为准入列（游戏 1080p UI 用的就是它），HD 只补 SD 里没有的名字。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { PakFile } = require('../audio/pak.cjs');
const oodle = require('../audio/oodle.cjs');
const { pakDirs, listPakFiles } = require('../audio/index.cjs');
const { extractSprite } = require('./sprite.cjs');

const INDEX_VERSION = 3; // 3: 增加按名称的分类（cat），条目按 (分组, 名字) 排序

function pakDirsForIcons(gameRoot) { return pakDirs(gameRoot); }
function listPaks(dirs) { return listPakFiles(dirs); }

function groupOf(vpath) {
  // .../UIAtlas/<任意深度>/BakedSprite/X.uasset -> 分组取中间的完整目录段
  const i = vpath.indexOf('/UIAtlas/');
  const j = vpath.indexOf('/BakedSprite/');
  if (i >= 0 && j > i) {
    const seg = vpath.slice(i + '/UIAtlas/'.length, j);
    if (seg && !seg.includes('//')) return seg;
  }
  return '(其他)';
}

/** 按名称分类：取第一个下划线前的段（TaskSystem_De_102 → TaskSystem，Boss_c601_… → Boss）。
 *  没有下划线就整名当一个分类；空名归 "(其他)"。实测 8554 个图标 → 154 类，只有 13 个单件。 */
function nameCategory(name) {
  const s = String(name || '');
  const i = s.indexOf('_');
  const head = i > 0 ? s.slice(0, i) : s;
  return head || '(其他)';
}

function labelOf(group) {
  const parts = String(group).split('/');
  return parts[parts.length - 1] || group;
}

/**
 * @param {string} gameRoot
 * @param {{vault:object}} opts
 * @param {(p:{phase:string,done:number,total:number,detail?:string})=>void} onProgress
 */
function buildIndex(gameRoot, opts, onProgress) {
  const vault = opts.vault;
  const dll = oodle.find(gameRoot);
  if (!dll) throw new Error('没有找到 Oodle 解压库（游戏 Binaries/Win64/oo2core_*_win64.dll）');
  oodle.init(dll);

  const dirs = pakDirsForIcons(gameRoot);
  if (!dirs.length) throw new Error('游戏目录里没有找到 pak 目录：' + gameRoot);
  const files = listPaks(dirs);

  const t0 = Date.now();
  const items = [];
  const byName = new Map();      // 名字 -> item（SD 优先去重）
  const atlasPaks = Object.create(null); // 图集相对路径 -> pak 文件名
  let parseErrors = 0, readErrors = 0;
  const errorSamples = [];

  files.forEach((file, i) => {
    const pakName = path.basename(file);
    onProgress({ phase: 'pak', done: i + 1, total: files.length, detail: pakName });
    let pf;
    try {
      pf = new PakFile(file, { keyvault: vault, keepFilter: (d) => d.includes('/UIAtlas/') });
    } catch (e) {
      return; // 密钥不匹配的包跳过（音频索引同样处理）
    }
    try {
      const sprites = [];
      for (const rel of pf.entries.keys()) {
        const vpath = pf.mountPoint + rel;
        if (!/\/UIAtlas\/.*\/BakedSprite\/[^/]+\.uasset$/i.test(vpath.replace(/\\/g, '/'))) continue;
        sprites.push({ rel, vpath });
        // 顺带登记同包里的图集
        if (/\/BakedTexture\/[^/]+\.uasset$/i.test(rel)) {
          const atlasRel = rel.replace(/\\/g, '/');
          if (!atlasPaks[atlasRel]) atlasPaks[atlasRel] = pakName;
        }
      }
      for (const { rel, vpath } of sprites) {
        const name = rel.split('/').pop().replace(/\.uasset$/i, '');
        const uasset = pf.read(rel, oodle);
        const uexpRel = rel.replace(/\.uasset$/i, '.uexp');
        const uexp = pf.read(uexpRel, oodle);
        if (!uasset || !uexp) { readErrors++; continue; }
        const info = extractSprite(uasset, uexp);
        if (!info.ok) {
          parseErrors++;
          if (errorSamples.length < 8) errorSamples.push(name + ': ' + info.error);
          continue;
        }
        // 图集路径归一成 pak 相对路径（/Game/ 前缀去掉，补 .uasset）
        const atlasRel = info.atlas.path.replace(/^\/Game\//, '') + '.uasset';
        if (!atlasPaks[atlasRel]) atlasPaks[atlasRel] = null; // 占位：其它包里再补
        const item = {
          id: rel.replace(/\\/g, '/').replace(/\.uasset$/i, ''),
          name,
          cat: nameCategory(name),
          group: groupOf(vpath),
          vpath: vpath.replace(/\\/g, '/'),
          pak: pakName,
          uv: [Math.round(info.uv.x), Math.round(info.uv.y)],
          dim: [info.dim.w, info.dim.h],
          atlas: atlasRel,
          hd: info.hd || /\/UI_HD\//.test(vpath.replace(/\\/g, '/')),
        };
        const prev = byName.get(name);
        if (!prev) {
          byName.set(name, item);
          items.push(item);
        } else if (prev.hd && !item.hd) {
          // SD 后到：顶掉 HD 项（同名时 SD 是 1080p UI 用的那份）
          const at = items.indexOf(prev);
          if (at >= 0) items[at] = item;
          byName.set(name, item);
        }
        // 其余情况：先到的是 SD 就保留，HD 同名项被忽略
      }
    } finally {
      pf.close();
    }
    if ((i & 7) === 0) onProgress({ phase: 'sprite', done: items.length, total: items.length + 64, detail: pakName });
  });

  // 图集可能分布在其它包里：再来一遍只为登记图集（只扫目录，不解内容）
  if (atlasPaks && Object.values(atlasPaks).some((v) => v === null)) {
    files.forEach((file, i) => {
      const pakName = path.basename(file);
      let pf;
      try {
        pf = new PakFile(file, { keyvault: vault, keepFilter: (d) => d.includes('/UIAtlas/') });
      } catch (e) { return; }
      try {
        for (const rel of pf.entries.keys()) {
          const r = rel.replace(/\\/g, '/');
          if (/\/BakedTexture\/[^/]+\.uasset$/i.test(r) && atlasPaks[r] == null) atlasPaks[r] = pakName;
        }
      } finally { pf.close(); }
      if ((i & 15) === 0) onProgress({ phase: 'atlas', done: i + 1, total: files.length, detail: pakName });
    });
  }

  /* 按 (分组, 名字) 排序：同一页的图标尽量落在同一两个图集里，
   * 翻页时不会频繁重新解压大图集（这是"图标渲染慢"的主因之一）。 */
  const items2 = items.sort((a, b) => (a.group === b.group ? a.name.localeCompare(b.name) : a.group.localeCompare(b.group)));
  const groups = new Map();
  for (const it of items2) {
    const g = groups.get(it.cat) || { key: it.cat, label: it.cat, count: 0 };
    g.count++;
    groups.set(it.cat, g);
  }
  const categories = Array.from(groups.values()).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  onProgress({ phase: 'done', done: items2.length, total: items2.length, detail: '完成' });

  return {
    data: {
      version: INDEX_VERSION,
      gameRoot,
      builtAt: Date.now(),
      pakCount: files.length,
      atlasPaks,
      categories,
      items: items2,
    },
    stats: {
      pakTotal: files.length,
      count: items2.length,
      hdCount: items2.filter((it) => it.hd).length,
      parseErrors,
      readErrors,
      errorSamples,
      atlasCount: Object.keys(atlasPaks).length,
      atlasMissing: Object.values(atlasPaks).filter((v) => v == null).length,
      ms: Date.now() - t0,
    },
  };
}

function indexPath(userData) { return path.join(userData, 'icons-index.json'); }

function saveIndex(userData, data) {
  try { fs.mkdirSync(userData, { recursive: true }); } catch (e) {}
  fs.writeFileSync(indexPath(userData), JSON.stringify(data));
  return indexPath(userData);
}

function loadIndex(userData) {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath(userData), 'utf8'));
    if (!data || !Array.isArray(data.items)) return null;
    if (data.version === INDEX_VERSION) return data;
    if (data.version > INDEX_VERSION) return null; // 未来版本无法处理，别瞎改
    /* 老版本索引**就地升级**：补 cat 字段与名称分类清单，完全不重扫游戏包。
     * （v2 及以前没有名称分类；直接丢弃会让用户以为"分类功能坏了"，
     *   还会逼着重新扫描 1.5 万个 sprite。） */
    let changed = false;
    for (const it of data.items) {
      if (!it.cat) { it.cat = nameCategory(it.name); changed = true; }
    }
    if (!Array.isArray(data.categories) || changed) {
      const groups = new Map();
      for (const it of data.items) {
        const g = groups.get(it.cat) || { key: it.cat, label: it.cat, count: 0 };
        g.count++;
        groups.set(it.cat, g);
      }
      data.categories = Array.from(groups.values())
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
      changed = true;
    }
    data.version = INDEX_VERSION;
    if (changed) {
      try { fs.writeFileSync(indexPath(userData), JSON.stringify(data)); } catch (e) { /* 写不回也不影响本次使用 */ }
    }
    return data;
  } catch (e) { return null; }
}

function search(items, opts) {
  opts = opts || {};
  const q = (opts.query || '').trim().toLowerCase();
  const cat = (opts.cat || 'all').trim();
  let list = items;
  if (cat && cat !== 'all') list = list.filter((it) => it.cat === cat);
  if (q) {
    list = list.filter((it) =>
      it.name.toLowerCase().includes(q) || (it.cat || '').toLowerCase().includes(q) || it.id.toLowerCase().includes(q));
  }
  const offset = Math.max(0, opts.offset || 0);
  const limit = Math.min(600, Math.max(1, opts.limit || 120));
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

module.exports = { buildIndex, saveIndex, loadIndex, search, indexPath, INDEX_VERSION, groupOf, nameCategory, pakDirsForIcons };
