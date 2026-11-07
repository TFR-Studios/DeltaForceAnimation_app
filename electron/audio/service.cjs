'use strict';
/* ============================================================================
 * 音频提取服务（主进程）
 * ---------------------------------------------------------------------------
 * 把 electron/audio/ 下的底层能力（pak 读取、Oodle 解压、索引、提取、vgmstream 解码）
 * 组装成一组给 IPC 用的方法。渲染进程拿不到任何文件系统能力，所有磁盘动作都在这里。
 *
 * 三条边界：
 *   · 只读游戏目录，绝不写入；导出只写用户选的输出目录；
 *   · 索引构建放 worker 线程（2 万条要读盘 + 解压，放主进程会把界面卡死）；
 *   · pak 句柄用 LRU 缓存，最多同时开 8 个，避免句柄泄漏。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { PakFile } = require('./pak.cjs');
const oodle = require('./oodle.cjs');
const keysLoader = require('./keys.cjs');
const gamedir = require('./gamedir.cjs');
const settingsStore = require('./settings.cjs');
const indexer = require('./index.cjs');
const { extractOne } = require('./extract.cjs');

let vgm = null;
try { vgm = require('./vgmstream.cjs'); } catch (e) { vgm = null; }

const MAX_PAK_HANDLES = 8;

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'audio';
}

class AudioService {
  constructor(opts) {
    this.userData = opts.userData;
    this.getWindow = opts.getWindow || (() => null);
    this.settings = settingsStore.load(this.userData);
    /* 密钥来源统一走 keys.cjs：<userData>/audio-keys/AESKey1.json 优先，其次内置。 */
    this.vault = keysLoader.load(this.userData);
    this.index = null;
    this.indexLoaded = false;
    this.building = null;
    this.pakFiles = new Map();
    this.pakOrder = [];
    /* 索引可能到 8 万条 / 25 MB，不在启动时解析：第一次用到（打开音频页）再读，
     * 否则每次开应用都要为一个可能不用的页面付出几百毫秒和几十 MB 内存。 */
  }

  _ensureIndex() {
    if (this.indexLoaded) return this.index;
    this.indexLoaded = true;
    const data = indexer.loadIndex(this.userData);
    if (data && data.items) {
      this.index = data;
      if (!this.settings.gameDir) this.settings.gameDir = data.gameRoot;
    }
    return this.index;
  }

  /* ---------------- 游戏目录 ---------------- */

  getGameDir() {
    const dir = this.settings.gameDir || null;
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
    this.settings = settingsStore.save(this.userData, { gameDir: dir });
    if (this.indexLoaded && this.index && this.index.gameRoot !== dir) {
      this.index = null;
      this.indexLoaded = false;
    }
    const dirs = indexer.pakDirs(dir);
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

  getIndexState() {
    const idx = this._ensureIndex();
    const gameDir = this.settings.gameDir || null;
    return {
      ready: !!idx,
      count: idx ? idx.items.length : 0,
      builtAt: idx ? idx.builtAt : 0,
      stale: !!(idx && gameDir && idx.gameRoot !== gameDir),
      building: !!this.building,
      gameDir,
      coverage: idx ? idx.coverage || null : null,
    };
  }

  buildIndex(onProgress) {
    if (this.building) return this.building;
    const gameDir = this.settings.gameDir;
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

  /** 主进程这侧的 Oodle 必须自己初始化：worker 线程里那份是独立的。 */
  _ensureOodle() {
    if (oodle.isReady()) return true;
    const dir = this.settings.gameDir;
    const dll = dir ? oodle.find(dir) : null;
    if (!dll) return false;
    try { oodle.init(dll); return true; } catch (e) { return false; }
  }

  /* ---------------- pak 句柄 ---------------- */

  _pakPath(name) {
    const dirs = indexer.pakDirs(this.settings.gameDir || '');
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

  _findItem(id) {
    if (!this._ensureIndex()) return null;
    return this.index.items.find((it) => it.id === id) || null;
  }

  /* ---------------- 导出 / 试听 ---------------- */

  getExportDir() {
    const dir = this.settings.exportDir || path.join(require('electron').app.getPath('downloads'), 'DFAE-Audio');
    return { dir };
  }

  async pickExportDir() {
    const { dialog } = require('electron');
    const win = this.getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: '选择音频导出目录',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '导出到这里',
      defaultPath: this.getExportDir().dir,
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    this.settings = settingsStore.save(this.userData, { exportDir: res.filePaths[0] });
    return { ok: true, dir: res.filePaths[0] };
  }

  async exportAudio(opts) {
    opts = opts || {};
    const ids = Array.isArray(opts.ids) ? opts.ids : [];
    if (!ids.length) return { ok: false, saved: 0, failed: 0, error: '没有选中音频' };
    if (!this._ensureIndex()) return { ok: false, saved: 0, failed: 0, error: '还没有建立音频索引' };
    if (!this._ensureOodle()) return { ok: false, saved: 0, failed: 0, error: '没有找到 Oodle 解压库，无法读取游戏包' };
    const dir = this.getExportDir().dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      return { ok: false, saved: 0, failed: 0, error: '创建导出目录失败：' + e.message };
    }
    const wantDecode = opts.decode !== false && !!(vgm && vgm.isAvailable());
    let saved = 0, failed = 0;
    const errors = [];
    for (const id of ids) {
      const item = this._findItem(id);
      if (!item) { failed++; continue; }
      let pf;
      try { pf = this._pak(item.pak); } catch (e) { failed++; errors.push(id + ': ' + e.message); continue; }
      if (!pf) { failed++; errors.push(id + ': 找不到 pak ' + item.pak); continue; }
      let r;
      try { r = extractOne(pf, item, oodle); } catch (e) { r = { ok: false, error: e.message }; }
      if (!r || !r.ok || !r.wem) { failed++; errors.push(id + ': ' + ((r && r.error) || '提取失败')); continue; }
      const stem = safeName(r.name || item.name) + '_' + id;
      try {
        fs.writeFileSync(path.join(dir, stem + '.wem'), r.wem);
        if (wantDecode) {
          const out = path.join(dir, stem + '.wav');
          const d = await vgm.decodeToWav(path.join(dir, stem + '.wem'), out);
          if (!d || !d.ok) { /* 解码失败也保留 .wem */ }
        }
        saved++;
      } catch (e) { failed++; errors.push(id + ': 写文件失败 ' + e.message); }
    }
    return { ok: failed === 0, saved, failed, outDir: dir, decoded: wantDecode, errors: errors.slice(0, 20) };
  }

  async previewAudio(id) {
    if (!this._ensureIndex()) return { ok: false, error: '还没有建立音频索引' };
    if (!vgm || !vgm.isAvailable()) return { ok: false, error: '没有找到 vgmstream，无法试听（导出 .wem 不受影响）' };
    if (!this._ensureOodle()) return { ok: false, error: '没有找到 Oodle 解压库，无法读取游戏包' };
    const item = this._findItem(id);
    if (!item) return { ok: false, error: '找不到这条音频' };
    const pf = this._pak(item.pak);
    if (!pf) return { ok: false, error: '找不到 pak ' + item.pak };
    const r = extractOne(pf, item, oodle);
    if (!r.ok || !r.wem) return { ok: false, error: r.error || '提取失败' };
    try {
      const wav = await vgm.decodeBufferToWav(r.wem);
      if (!wav || !wav.length) return { ok: false, error: 'vgmstream 解码失败' };
      return { ok: true, data: wav, info: r.info, name: r.name };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    for (const pf of this.pakFiles.values()) { try { pf.close(); } catch (e) {} }
    this.pakFiles.clear();
    this.pakOrder = [];
  }
}

function createAudioService(opts) { return new AudioService(opts); }

module.exports = { createAudioService, AudioService };
