'use strict';
/* ============================================================================
 * UI 图标提取服务（主进程）
 * ---------------------------------------------------------------------------
 * 把 electron/icons/ 的底层能力组装成 IPC 用的方法，边界与音频提取完全一致：
 *   · 只读游戏目录；导出只写用户设置的导出目录；
 *   · 索引构建放 worker 线程；
 *   · pak 句柄 LRU（8 个），图集原始载荷 LRU（3 个，每个 ~22MB），
 *     解码好的 PNG 预览 LRU（300 个）—— 网格滚动时同一图标不重复解码。
 * 游戏目录与音频提取共用同一份设置（audio-extract.json 的 gameDir），
 * 用户在任一页面设置过目录，另一页直接可用。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { PakFile } = require('../audio/pak.cjs');
const oodle = require('../audio/oodle.cjs');
const keysLoader = require('../audio/keys.cjs');
const gamedir = require('../audio/gamedir.cjs');
const settingsStore = require('../audio/settings.cjs');
const indexer = require('./index.cjs');
const { parseAtlas, decodeRegion, tintRGBA, isBlankRGBA } = require('./atlas.cjs');
const { encodePNG } = require('./png.cjs');

const MAX_PAK_HANDLES = 8;
/* 图集载荷缓存按**字节预算**而不是条数：图集 6KB~88MB 不等，条数上限会在
 * 大图集上瞬间吃光内存、在小图集上又白白浪费。384MB 覆盖常用页(一页约 60 个
 * 图标通常只涉及 1~3 个图集)，翻页来回基本不重复解压。 */
const MAX_ATLAS_BYTES = 384 * 1024 * 1024;
const MAX_PREVIEW_CACHE = 400;

/** 染色预设（银灰取自实现思路文档实测样例 #E6F0FA 附近）。 */
const TINTS = {
  none: null,
  silver: [230, 240, 250],
  dark: [40, 44, 52],
  black: [16, 18, 22],
};

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'icon';
}

function lruGet(map, order, key, max) {
  const hit = map.get(key);
  if (hit !== undefined) {
    const at = order.indexOf(key);
    if (at >= 0) { order.splice(at, 1); order.push(key); }
  }
  if (order.length > max) {
    const old = order.shift();
    map.delete(old);
  }
  return hit;
}

function lruSet(map, order, key, value, max) {
  map.set(key, value);
  order.push(key);
  while (order.length > max) {
    const old = order.shift();
    map.delete(old);
  }
}

class IconsService {
  constructor(opts) {
    this.userData = opts.userData;
    this.getWindow = opts.getWindow || (() => null);
    this.vault = keysLoader.load(this.userData);
    this.index = null;
    this.indexLoaded = false;
    this.building = null;
    this.pakFiles = new Map();
    this.pakOrder = [];
    this.atlasCache = new Map();
    this.atlasOrder = [];
    this.previewCache = new Map();
    this.previewOrder = [];
    this.previewInflight = new Map();
  }

  _reloadSettings() {
    // 音频页可能改过同一个设置文件，每次访问都重读（几 KB 的 JSON，代价可忽略）
    this.settings = settingsStore.load(this.userData);
    return this.settings;
  }

  /* ---------------- 游戏目录（与音频页共用设置） ---------------- */

  getGameDir() {
    const s = this._reloadSettings();
    const dir = s.gameDir || null;
    return { dir, valid: dir ? gamedir.isValid(dir) : false };
  }

  detectGameDir() {
    const found = gamedir.detect();
    if (!found.ok) return { ok: false, error: '没有自动找到游戏目录，请手动选择' };
    return { ok: true, dir: found.dir, source: found.source };
  }

  setGameDir(dir) {
    if (!dir || !gamedir.isValid(dir)) {
      return { ok: false, valid: false, error: '这个目录里没有 DeltaForce/Content/Paks，确认选的是 DeltaForce(2001918) 文件夹' };
    }
    settingsStore.save(this.userData, { gameDir: dir });
    this._reloadSettings();
    if (this.indexLoaded && this.index && this.index.gameRoot !== dir) {
      this.index = null;
      this.indexLoaded = false;
    }
    const dirs = indexer.pakDirsForIcons(dir);
    let pakCount = 0;
    for (const d of dirs) {
      try { pakCount += fs.readdirSync(d).filter((f) => /\.pak$/i.test(f)).length; } catch (e) {}
    }
    return { ok: true, valid: true, dir, pakCount };
  }

  async pickGameDir() {
    const { dialog } = require('electron');
    const win = this.getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: '选择 DeltaForce(2001918) 游戏目录',
      properties: ['openDirectory'],
      buttonLabel: '使用这个目录',
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return this.setGameDir(res.filePaths[0]);
  }

  /* ---------------- 索引 ---------------- */

  _ensureIndex() {
    if (this.indexLoaded) return this.index;
    this.indexLoaded = true;
    const data = indexer.loadIndex(this.userData);
    if (data && data.items) {
      this.index = data;
      const s = this._reloadSettings();
      if (!s.gameDir) settingsStore.save(this.userData, { gameDir: data.gameRoot });
    }
    return this.index;
  }

  getIndexState() {
    const idx = this._ensureIndex();
    const gameDir = this._reloadSettings().gameDir || null;
    return {
      ready: !!idx,
      count: idx ? idx.items.length : 0,
      builtAt: idx ? idx.builtAt : 0,
      stale: !!(idx && gameDir && idx.gameRoot !== gameDir),
      building: !!this.building,
      gameDir,
    };
  }

  buildIndex(onProgress) {
    if (this.building) return this.building;
    const gameDir = this._reloadSettings().gameDir;
    if (!gameDir || !gamedir.isValid(gameDir)) {
      return Promise.resolve({ ok: false, error: '先选择游戏目录' });
    }
    if (!oodle.find(gameDir)) {
      return Promise.resolve({ ok: false, error: '没有找到游戏的 Oodle 解压库（DeltaForce/Binaries/Win64/oo2core_*_win64.dll），游戏可能没装完整' });
    }
    this.building = new Promise((resolve) => {
      let worker;
      try {
        worker = new Worker(path.join(__dirname, 'index-worker.cjs'), { workerData: { gameRoot: gameDir, userData: this.userData } });
      } catch (e) {
        this.building = null;
        resolve({ ok: false, error: e.message });
        return;
      }
      const finish = (r) => {
        this.building = null;
        try { worker.terminate(); } catch (e) {}
        resolve(r);
      };
      worker.on('message', (m) => {
        if (!m || !m.type) return;
        if (m.type === 'progress') { try { onProgress && onProgress(m.progress); } catch (e) {} return; }
        if (m.type === 'done') {
          this.index = m.data;
          indexer.saveIndex(this.userData, m.data);
          finish({ ok: true, count: m.data.items.length, stats: m.stats });
          return;
        }
        if (m.type === 'error') finish({ ok: false, error: m.message });
      });
      worker.on('error', (e) => finish({ ok: false, error: e.message || String(e) }));
      worker.on('exit', () => { if (this.building) finish({ ok: false, error: '索引线程意外退出' }); });
    });
    return this.building;
  }

  search(opts) {
    if (!this._ensureIndex()) return { total: 0, items: [] };
    return indexer.search(this.index.items, opts || {});
  }

  getCategories() {
    if (!this._ensureIndex()) return { items: [] };
    if (Array.isArray(this.index.categories)) return { items: this.index.categories };
    return { items: [] };
  }

  /* ---------------- pak / 图集 / 解码 ---------------- */

  _pakPath(name) {
    const dirs = indexer.pakDirsForIcons(this._reloadSettings().gameDir || '');
    for (const d of dirs) {
      const p = path.join(d, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  _pak(name) {
    const hit = this.pakFiles.get(name);
    if (hit) return hit;
    const file = this._pakPath(name);
    if (!file) return null;
    const pf = new PakFile(file, { keyvault: this.vault });
    this.pakFiles.set(name, pf);
    this.pakOrder.push(name);
    while (this.pakOrder.length > MAX_PAK_HANDLES) {
      const old = this.pakOrder.shift();
      const victim = this.pakFiles.get(old);
      if (victim) { try { victim.close(); } catch (e) {} this.pakFiles.delete(old); }
    }
    return pf;
  }

  _ensureOodle() {
    if (oodle.isReady()) return true;
    const dir = this._reloadSettings().gameDir;
    const dll = dir ? oodle.find(dir) : null;
    if (!dll) return false;
    try { oodle.init(dll); return true; } catch (e) { return false; }
  }

  _findItem(id) {
    if (!this._ensureIndex()) return null;
    return this.index.items.find((it) => it.id === id) || null;
  }

  _findAtlasRel(rel) {
    if (!this._ensureIndex()) return null;
    return this.index.atlasPaks && this.index.atlasPaks[rel] || null;
  }

  /** 图集载荷进缓存：按字节预算淘汰最旧的（大图集 88MB，条数上限不合适）。 */
  _cacheAtlas(rel, rec) {
    this.atlasCache.set(rel, rec);
    this.atlasOrder.push(rel);
    this.atlasBytes = (this.atlasBytes || 0) + (rec.bytes || 0);
    while (this.atlasOrder.length > 1 && this.atlasBytes > MAX_ATLAS_BYTES) {
      const old = this.atlasOrder.shift();
      const victim = this.atlasCache.get(old);
      if (victim) {
        this.atlasBytes -= victim.bytes || 0;
        this.atlasCache.delete(old);
      }
    }
  }

  /** 读一个图集的 uexp（带 LRU），返回 { ok, uexp, meta } 或 { ok:false, error }。 */
  _loadAtlas(atlasRel) {
    const hit = this.atlasCache.get(atlasRel);
    if (hit) {
      // 命中只刷新 LRU 顺序；淘汰由 _cacheAtlas 的字节预算负责，不按条数删
      const at = this.atlasOrder.indexOf(atlasRel);
      if (at >= 0) { this.atlasOrder.splice(at, 1); this.atlasOrder.push(atlasRel); }
      return hit;
    }
    const pakName = this._findAtlasRel(atlasRel);
    if (!pakName) return { ok: false, error: '索引里没有登记图集所在包: ' + atlasRel };
    if (!this._ensureOodle()) return { ok: false, error: '没有找到 Oodle 解压库，无法读取游戏包' };
    let pf;
    try { pf = this._pak(pakName); } catch (e) { return { ok: false, error: '打开 pak 失败: ' + e.message }; }
    if (!pf) return { ok: false, error: '找不到 pak ' + pakName };
    const rel = atlasRel;
    const uassetRel = rel;
    const uexpRel = rel.replace(/\.uasset$/i, '.uexp');
    const uasset = pf.read(uassetRel, oodle);
    const uexp = pf.read(uexpRel, oodle);
    if (!uasset || !uexp) return { ok: false, error: '读取图集失败: ' + rel };
    const meta = parseAtlas(uasset, uexp);
    if (!meta.ok) return { ok: false, error: '图集解析失败: ' + meta.error };
    // 只留 mip0 起点之后的字节（payload 与 uexp 共享同一块内存，不额外复制）
    const payload = uexp.subarray(meta.payloadOffset);
    const rec = { ok: true, meta, payload, bytes: uexp.length };
    this._cacheAtlas(atlasRel, rec);
    return rec;
  }

  /** 单个图标 -> PNG 字节（内部共享：预览与导出同一条路）。 */
  async renderIcon(id, tintKey) {
    const item = this._findItem(id);
    if (!item) return { ok: false, error: '找不到这个图标' };
    const tint = TINTS[tintKey] || (tintKey && /^#[0-9a-fA-F]{6}$/.test(tintKey) ? hexToRGB(tintKey) : null);
    const cacheKey = id + '|' + (tint ? tint.join(',') : 'none');
    const cached = lruGet(this.previewCache, this.previewOrder, cacheKey, MAX_PREVIEW_CACHE);
    if (cached) {
      if (cached.blank) return { ok: false, blank: true, error: '该图标在图集中是空白区域', fromCache: true };
      return { ok: true, data: cached.png, width: cached.width, height: cached.height, fromCache: true };
    }
    if (!this._ensureOodle()) return { ok: false, error: '没有找到 Oodle 解压库，无法读取游戏包' };
    let pf;
    try { pf = this._pak(item.pak); } catch (e) { return { ok: false, error: '打开 pak 失败: ' + e.message }; }
    if (!pf) return { ok: false, error: '找不到 pak ' + item.pak };
    const uasset = pf.read(item.id + '.uasset', oodle);
    const uexp = pf.read(item.id + '.uexp', oodle);
    if (!uasset || !uexp) return { ok: false, error: '读取 sprite 失败: ' + item.id };
    const { extractSprite } = require('./sprite.cjs');
    const info = extractSprite(uasset, uexp);
    if (!info.ok) return { ok: false, error: 'sprite 解析失败: ' + info.error };
    const atlas = this._loadAtlas(info.atlas.path.replace(/^\/Game\//, '') + '.uasset');
    if (!atlas.ok) return { ok: false, error: atlas.error };
    const dec = await decodeRegion(atlas.payload, atlas.meta.storageW, atlas.meta.storageH,
      Math.round(info.uv.x), Math.round(info.uv.y), info.dim.w, info.dim.h, atlas.meta);
    if (!dec.ok) return { ok: false, error: dec.error };
    /* 图集里那块是空白（未烘焙 / 移动端残留）：不是故障，但也导不出图 —— 
     * 明确告诉页面"空白"，让它显示无图占位而不是一直重试。 */
    if (isBlankRGBA(dec.rgba)) {
      lruSet(this.previewCache, this.previewOrder, cacheKey, { blank: true }, MAX_PREVIEW_CACHE);
      return { ok: false, blank: true, error: '该图标在图集中是空白区域' };
    }
    tintRGBA(dec.rgba, tint);
    let png;
    try { png = encodePNG(dec.w, dec.h, dec.rgba); } catch (e) { return { ok: false, error: e.message }; }
    lruSet(this.previewCache, this.previewOrder, cacheKey, { png, width: dec.w, height: dec.h }, MAX_PREVIEW_CACHE);
    return { ok: true, data: png, width: dec.w, height: dec.h };
  }

  /** 网格预览：并发去重（同一图标同时只会解一次）。 */
  preview(id, tintKey) {
    const key = id + '|' + (tintKey || 'none');
    const inflight = this.previewInflight.get(key);
    if (inflight) return inflight;
    const p = this.renderIcon(id, tintKey || 'none').finally(() => this.previewInflight.delete(key));
    this.previewInflight.set(key, p);
    return p;
  }

  /* ---------------- 导出 ---------------- */

  getExportDir() {
    const dir = this._reloadSettings().iconExportDir || path.join(require('electron').app.getPath('downloads'), 'DFAE-Icons');
    return { dir };
  }

  async pickExportDir() {
    const { dialog } = require('electron');
    const win = this.getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: '选择图标导出目录',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '导出到这里',
      defaultPath: this.getExportDir().dir,
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    settingsStore.save(this.userData, { iconExportDir: res.filePaths[0] });
    this._reloadSettings();
    return { ok: true, dir: res.filePaths[0] };
  }

  async exportIcons(opts) {
    opts = opts || {};
    const ids = Array.isArray(opts.ids) ? opts.ids : [];
    if (!ids.length) return { ok: false, saved: 0, failed: 0, error: '没有选中图标' };
    if (!this._ensureIndex()) return { ok: false, saved: 0, failed: 0, error: '还没有建立图标索引' };
    const tintKey = opts.tint || 'none';
    const tintLabel = tintKey && tintKey !== 'none' ? '_' + safeName(tintKey).replace(/^#/, 'c') : '';
    const dir = this.getExportDir().dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      return { ok: false, saved: 0, failed: 0, error: '创建导出目录失败：' + e.message };
    }
    let saved = 0, failed = 0;
    const errors = [];
    const usedNames = new Map();
    for (const id of ids) {
      let r;
      try { r = await this.renderIcon(id, tintKey); } catch (e) { r = { ok: false, error: e.message }; }
      if (!r || !r.ok) { failed++; errors.push(id + ': ' + ((r && r.error) || '提取失败')); continue; }
      const item = this._findItem(id);
      const base = safeName((item && item.name) || id.split('/').pop());
      const n = (usedNames.get(base) || 0) + 1;
      usedNames.set(base, n);
      const stem = base + (n > 1 ? '_' + n : '') + tintLabel;
      try {
        fs.writeFileSync(path.join(dir, stem + '.png'), Buffer.from(r.data));
        saved++;
      } catch (e) {
        failed++;
        errors.push(id + ': 写文件失败 ' + e.message);
      }
    }
    return { ok: failed === 0, saved, failed, outDir: dir, tint: tintKey, errors: errors.slice(0, 20) };
  }

  dispose() {
    for (const pf of this.pakFiles.values()) { try { pf.close(); } catch (e) {} }
    this.pakFiles.clear();
    this.pakOrder = [];
    this.atlasCache.clear();
    this.atlasOrder = [];
    this.atlasBytes = 0;
    this.previewCache.clear();
    this.previewOrder = [];
    this.previewInflight.clear();
  }
}

function hexToRGB(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
}

function createIconsService(opts) { return new IconsService(opts); }

module.exports = { createIconsService, IconsService, TINTS };
