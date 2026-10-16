/* ============================================================================
 * 三角洲行动动画编辑器 · 下载列表 / 下载历史(主进程)
 *
 * 这个模块解决三件事,都在主进程做,渲染进程只通过 preload 暴露的具名接口取数据:
 *
 *  1) 落盘位置固定
 *     以前每次导完都弹「另存为」,文件散落在用户随手选的地方 —— 一旦选错目录,
 *     「下载列表」就无从管起。现在自动保存(默认开)统一落到软件目录旁的
 *     downloads/,文件名由渲染进程给出(动画名 + 时间戳),重名自动加 (1)(2) 后缀。
 *     用户也可以把「自动保存」关掉,退回每次询问保存位置的老行为。
 *
 *  2) 下载历史(软件删掉/搬走都还在)
 *     历史清单是 userData/download-history.json —— 它在 %APPDATA% 下,
 *     不在软件目录里。所以把软件整个删掉、或搬到别的盘、或换一个免安装 exe 打开,
 *     历史条目依然读得到(条目带文件的绝对路径 + 相对 downloads 的相对路径,
 *     软件搬走时靠相对路径自动重新定位到新位置)。
 *
 *  3) 列表与磁盘对账
 *     每次 list() 都会:重建缺失的清单扫描 downloads/ → 把清单里指向旧机器/旧路径的条目
 *     用「相对路径、文件名+体积」两级手段重新定位。找不到的文件不删除,只标 missing ——
 *     「这条记录曾经导出过」本身就是历史信息,不该因为文件被挪走就消失。
 *
 * 职责边界:本模块只碰文件系统与清单,不关心导出格式、编码、渲染,也不碰窗口。
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/* 目录名固定为 downloads:与系统「下载」同名,用户一看就知道是导出产物;
 * 前面不加点、不进子目录,方便用户在资源管理器里直接拖走整个文件夹。 */
const DOWNLOADS_DIR_NAME = 'downloads';
/* 系统「下载」文件夹里的应用子目录名。用中文产品名而不是 npm 包名:
 * 用户会在资源管理器里看到它,「delta-force-animation-editor-desktop」毫无意义。 */
const APP_FOLDER_NAME = '三角洲行动动画编辑器';
/* 清单文件名。放在 userData(而非产物目录)是刻意的,理由见文件头第 2 条。 */
const HISTORY_FILE_NAME = 'download-history.json';
const HISTORY_VERSION = 1;

/* Windows 文件名禁区:控制字符 + < > : " / \ | ? *,
 * 另外结尾的点和空格在 Windows 上会被静默丢掉,统一在这里处理掉。 */
const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
/* Windows 设备名:即使带扩展名也不能用作文件名(con.mp4 同样打不开)。 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/* ---------------------------------------------------------------------------
 * 小工具
 * ------------------------------------------------------------------------- */

/** 目录是否可写。用真实写入探测,而不是 fs.access —— 权限位在 Windows 上不可靠。 */
function canWriteDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.dfae-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** 把任意输入收敛成一个合法、可读的文件名(保留中文,去掉路径分隔符与非法字符)。 */
function sanitizeFilename(name, fallback = 'animation') {
  let base = String(name ?? '').trim();
  if (!base) base = fallback;
  // 只取最后一段:外部传进来 './a/b.mp4' 或 'C:\\x\\y.mp4' 都不能变成目录穿越
  base = base.split(/[\\/]/).pop() || fallback;
  base = base.replace(INVALID_NAME_CHARS, '_');
  // 结尾的点/空格会被 Windows 吞掉,挪成下划线以免「显示的名字」和「盘上的名字」不一致
  base = base.replace(/[. ]+$/, '_');
  // 开头的点会让文件在资源管理器里默认隐藏,挪成下划线
  base = base.replace(/^\.+/, '_');
  if (RESERVED_NAMES.test(base.replace(/\.[^.]*$/, ''))) base = '_' + base;
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 12);
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base || fallback;
}

/** 在 dir 里给 filename 找一个不重名的落点:name.mp4 → name (1).mp4 → name (2).mp4 … */
function uniquePath(dir, filename, taken = new Set()) {
  const safe = sanitizeFilename(filename);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  const lower = (p) => p.toLowerCase();
  const occupied = new Set([...taken].map((p) => lower(path.basename(p))));
  const exists = (p) => occupied.has(lower(path.basename(p))) || fs.existsSync(p);
  let candidate = path.join(dir, safe);
  let n = 0;
  while (exists(candidate)) {
    n += 1;
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (n > 999) break;   // 极端情况兜底,别在这里死循环
  }
  return candidate;
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function fileSize(p) {
  const st = safeStat(p);
  return st && st.isFile() ? st.size : 0;
}

/** 本地时间 YYYY-MM-DD HH:MM:SS(历史列表直接显示,不走 toLocaleString 以免受系统区域设置影响格式)。 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 由清单条目反推一个「最近一次记录时间」,用于给扫描出来的老文件排序。 */
function mtimeIso(p) {
  const st = safeStat(p);
  return st ? st.mtime.toISOString() : new Date().toISOString();
}

/** 从文件名猜导出格式(仅用于列表上显示一个 MP4/AVI 标签)。 */
function formatOf(file) {
  return path.extname(String(file || '')).replace('.', '').toUpperCase();
}

/* ---------------------------------------------------------------------------
 * 历史清单的读写
 * ------------------------------------------------------------------------- */
function emptyHistory() {
  return { version: HISTORY_VERSION, entries: {}, downloadsDir: '', promptOnSave: false };
}

/** 读清单。任何损坏 / 缺失都回落成空清单 —— 历史不该因为一个坏字节让应用起不来。 */
function readHistory(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = raw && typeof raw.entries === 'object' && raw.entries ? raw.entries : {};
    return {
      version: HISTORY_VERSION,
      entries,
      downloadsDir: typeof raw?.downloadsDir === 'string' ? raw.downloadsDir : '',
      promptOnSave: !!raw?.promptOnSave,
    };
  } catch {
    return emptyHistory();
  }
}

/* 写清单:先写临时文件再 rename。
 * 直接覆盖写有风险 —— 断电/崩溃会留下半截 JSON,下一次启动历史就整体丢了。
 * rename 在同一分区上是原子的,最坏情况也只是丢掉最后一次记录。 */
function writeHistory(file, history) {
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * 目录解析
 * ------------------------------------------------------------------------- */

/**
 * 软件所在目录(下载目录的父目录)。
 *
 * 调用方(main.cjs)应当直接传 appDir —— 那是唯一正确的答案,由
 * main.cjs 的 resolveExportAppDir() 算出来:
 *   · 开发态 = 工程根目录;
 *   · 普通打包 = exe 所在目录;
 *   · 便携版 = **便携 exe 自己所在的目录**,而不是 resources/app(它被解在 %TEMP% 里,
 *     进程一退出就被清掉,导出产物放那儿等于当场失踪)。
 *
 * 这里只保留一个「从 execPath 猜」的兜底(自检脚本直接用 exe 路径构造时会走到):
 * 去掉 electron.exe 这一层再取上一级。注意它在路径里恰好还有别的 electron.exe 时会猜错,
 * 所以生产路径一定不要把 appDir 留给它猜。
 */
function resolveAppDir(execPath) {
  const exe = String(execPath || '');
  if (/[\\/]electron\.exe$/i.test(exe)) return path.dirname(path.dirname(exe));
  return path.dirname(exe);
}

/**
 * 决定导出产物放哪。
 *
 * 目标只有一个:**用户删掉软件、把软件搬到别的盘之后,导出的视频和下载历史都还在,
 * 而且用户能自己找到它们**。逐条对应:
 *
 *   1) 清单(下载历史)永远放用户数据目录(%APPDATA% 下),与软件目录无关 —— 见文件头;
 *   2) 产物放**系统「下载」文件夹下的一个应用子目录**:
 *      · 在用户的下载文件夹里 → 一眼能找到,也符合「下载列表」这个叫法;
 *      · 不在软件目录里 → 卸载/换目录不会连视频一起删掉(软件目录才是真正会被删的那个);
 *      · 单独一个子目录 → 「扫描目录补录历史」不会把用户其它无关的 mp4 吸进列表。
 *   3) 取不到系统下载目录(极少见)时退回用户数据目录下的同名子目录;
 *      再不行退回软件目录旁的 downloads/(老位置),保证功能不失效。
 *
 * requested 区分两种「记着的目录」:
 *   · 调用方/环境变量显式指定的 → 是指令,原样使用(便于自检与自定义存放);
 *   · 清单里记着的上一次落点 → 只是线索,没了或不可写就重新解析。
 */
function ensureDownloadsDir(opts) {
  const { requested = '', isExplicit = false, downloadsHome = '', userDataDir = '', appDir = '' } = opts;
  if (isExplicit && requested) return requested;
  // 上一次的落点仍可写就继续用,避免用户看到「文件突然换地方了」
  if (requested && fs.existsSync(requested) && canWriteDir(requested)) return requested;
  const candidates = [];
  if (downloadsHome) candidates.push(path.join(downloadsHome, APP_FOLDER_NAME));
  if (userDataDir) candidates.push(path.join(userDataDir, DOWNLOADS_DIR_NAME));
  if (appDir) candidates.push(path.join(appDir, DOWNLOADS_DIR_NAME));
  for (const candidate of candidates) {
    try { if (canWriteDir(candidate)) return candidate; } catch { /* 试下一个 */ }
  }
  // 全部不可写:返回第一个候选,让 writeBytes 去抛出真实错误(比在这里返回空路径更好定位)
  return candidates[0] || path.join(appDir || userDataDir || '.', DOWNLOADS_DIR_NAME);
}

/* ---------------------------------------------------------------------------
 * 扫描与对账
 * ------------------------------------------------------------------------- */

/**
 * 数一份文件里的帧数,用来区分「同一个动画的重复导出」——导出一模一样的动画,体积会完全一致。
 * 只读文件头(RIFF/AVI 的 avih.dwTotalFrames,或 MP4 的 stts 采样总数),不加载整份文件。
 * 读不出来就返回 null,此时退化成「同名同体积」判定,不会误判。
 */
function readFrameCount(file) {
  let fd = null;
  try {
    const st = safeStat(file);
    if (!st || !st.isFile() || st.size < 32) return null;
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(65536, st.size));
    fs.readSync(fd, head, 0, head.length, 0);
    const riff = head.toString('latin1', 0, 4);
    const mp4Brand = head.toString('latin1', 4, 8);
    if (riff === 'RIFF' && head.toString('latin1', 8, 12) === 'AVI ') {
      const idx = head.indexOf('avih', 0, 'latin1');
      // avih 的 16..20 字节是 dwTotalFrames(小端)
      if (idx >= 0 && idx + 24 <= head.length) return head.readUInt32LE(idx + 16);
      return null;
    }
    if (mp4Brand === 'ftyp') {
      // stts:完整盒子的第 12..16 字节是 sample count(盒头 8 字节 + version/flags 4 字节)
      const idx = head.indexOf('stts', 0, 'latin1');
      if (idx >= 0 && idx + 16 <= head.length) return head.readUInt32BE(idx + 12);
      return null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  }
}

/** 扫描目录下的所有视频文件(不递归:导出产物只落在这一层)。 */
function scanDir(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const st = safeStat(full);
    if (!st || !st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (ext !== '.mp4' && ext !== '.avi' && ext !== '.webm') continue;
    out.push({ path: full, name, size: st.size, mtime: st.mtime.toISOString() });
  }
  return out;
}

/* 把「盘上存在但清单里没有」的文件补进历史。
 * 这正是「软件删了再装回来 / 换个 exe 打开」时历史列表还能出现内容的原因 ——
 * 清单丢了,但 downloads/ 里的文件还在,扫一遍就能恢复。
 *
 * 去重必须先于补录:清单里的条目可能记着「搬家前的绝对路径」,此时只有相对路径能对上,
 * 不先对账就会给同一个文件再补一条,列表里出现两条一模一样的记录。 */
function importFromScan(history, dir) {
  const index = new Map();
  for (const e of Object.values(history.entries)) {
    // 先按相对路径对账:搬运软件目录是常见操作,这一步能顺手把旧绝对路径修正过来
    const base = path.basename(e.name || e.rel || e.path || '');
    if (base) {
      const byRel = path.join(dir, base);
      if (fs.existsSync(byRel)) {
        e.path = byRel;
        e.resolvedPath = byRel;
        e.rel = path.join(DOWNLOADS_DIR_NAME, base);
      }
    }
    const p = e.resolvedPath || e.path;
    if (p) index.set(path.resolve(p).toLowerCase(), e);
    if (e.rel) index.set(path.resolve(dir, path.basename(e.rel)).toLowerCase(), e);
    if (e.name) index.set(path.resolve(dir, e.name).toLowerCase(), e);
  }
  let added = 0;
  for (const f of scanDir(dir)) {
    const key = path.resolve(f.path).toLowerCase();
    if (index.has(key)) {
      // 已经在清单里:顺手把体积刷新一下(文件被外部改过时列表不会显示旧数字)
      index.get(key).size = f.size;
      continue;
    }
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const entry = {
      id,
      name: f.name,
      path: f.path,
      rel: path.join(DOWNLOADS_DIR_NAME, f.name),
      size: f.size,
      format: formatOf(f.name),
      at: stamp(new Date(f.mtime)),
      createdAt: f.mtime,
      frames: readFrameCount(f.path),
      source: 'scan',
    };
    history.entries[id] = entry;
    index.set(key, entry);
    added += 1;
  }
  return added;
}

/**
 * 把清单条目对到真实文件上(就地修正 + 返回是否可见)。
 * 三级手段,越靠后越慢,所以按顺序来:
 *   1) 记下来的绝对路径还在 → 直接用;
 *   2) 软件被搬走/换盘 → 用「相对 downloads 的相对路径」在新目录下找;
 *   3) 文件被单独挪走 → 按 文件名 + 体积(+ 帧数)在几个可疑根目录下搜一遍。
 * 都找不到就标 missing,条目保留。
 */
function resolveEntry(entry, dir, opts) {
  const abs = entry.path ? path.resolve(entry.path) : '';
  if (abs && fs.existsSync(abs)) {
    entry.resolvedPath = abs;
    entry.missing = false;
    entry.size = fileSize(abs);
    return;
  }
  const base = path.basename(entry.name || abs || entry.rel || '');
  const byRel = path.join(dir, base);
  if (base && fs.existsSync(byRel)) {
    entry.resolvedPath = byRel;
    entry.path = byRel;
    entry.rel = path.join(DOWNLOADS_DIR_NAME, base);
    entry.missing = false;
    entry.size = fileSize(byRel);
    return;
  }
  if (opts && opts.deep) {
    const hit = findFile(entry, opts.deepRoots || []);
    if (hit) {
      entry.resolvedPath = hit;
      entry.path = hit;
      entry.missing = false;
      entry.size = fileSize(hit);
      return;
    }
  }
  entry.resolvedPath = '';
  entry.missing = true;
}

/**
 * 在候选根目录下按「文件名 + 体积」找同一份导出。
 * 深度封顶 3 层:用户通常只是把 downloads 文件夹挪到上一层或挪进某个资料文件夹,
 * 再深就变成全盘遍历,代价不可接受。命中体积或帧数任一即可,避免同名不同内容误判。
 */
function findFile(entry, roots) {
  const want = String(entry.name || '').toLowerCase();
  if (!want) return '';
  const wantSize = Number(entry.size) || 0;
  const wantFrames = entry.frames || null;
  const queue = [];
  for (const root of roots) {
    if (root && fs.existsSync(root)) queue.push({ dir: root, depth: 0 });
  }
  const seen = new Set();
  while (queue.length) {
    const { dir, depth } = queue.shift();
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      const st = safeStat(full);
      if (!st) continue;
      if (st.isDirectory()) {
        if (depth < 3) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (name.toLowerCase() !== want) continue;
      if (wantSize && st.size !== wantSize) continue;
      if (wantFrames) {
        const f = readFrameCount(full);
        if (f && f !== wantFrames) continue;
      }
      return full;
    }
  }
  return '';
}

/* ---------------------------------------------------------------------------
 * 对外接口
 * ------------------------------------------------------------------------- */

/**
 * 创建下载历史/列表的控制器。
 * @param {{ execPath: string, userDataDir: string, appDir?: string, downloadsHome?: string, downloadsDir?: string, log?: (m: string) => void }} opts
 *   appDir:软件目录(最可信的来源见 resolveAppDir 的注释);不传才退回从 execPath 猜。
 *   downloadsHome:系统的「下载」文件夹(app.getPath('downloads')),产物默认落在它的应用子目录下。
 */
function createDownloads(opts) {
  const execPath = String(opts.execPath || process.execPath);
  const userDataDir = String(opts.userDataDir || '');
  const appDir = opts.appDir ? String(opts.appDir) : resolveAppDir(execPath);
  const downloadsHome = String(opts.downloadsHome || '');
  const historyFile = path.join(userDataDir, HISTORY_FILE_NAME);
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  let history = readHistory(historyFile);
  /* 下载目录的优先级(高 → 低):
   *   1) 调用方显式传入的 opts.downloadsDir / 环境变量(自检脚本、将来做「自定义下载位置」时用);
   *   2) 清单里记着的目录 —— 用户上次运行的落点就该一直用下去,不能因为一次解析变化就改判,
   *      否则文件会被拆到两个目录里;
   *   3) 按系统下载目录自动解析(见 ensureDownloadsDir)。 */
  const explicitDir = String(opts.downloadsDir || '').trim();
  const envDir = String(process.env.DFAE_DOWNLOADS_DIR || '').trim();
  const wanted = explicitDir || envDir || history.downloadsDir || '';
  const dir = ensureDownloadsDir({
    requested: wanted,
    isExplicit: !!(explicitDir || envDir),
    downloadsHome,
    userDataDir,
    appDir,
  });
  history.downloadsDir = dir;
  fs.mkdirSync(dir, { recursive: true });
  writeHistory(historyFile, history);
  // 首次使用时把 downloads/ 里已有的视频补进列表(历史空白也不会「什么都没看到」)
  if (importFromScan(history, dir) > 0) writeHistory(historyFile, history);
  log('下载目录:' + dir);
  log('下载历史:' + historyFile);

  /** 落盘:写文件并登记历史。saveFromFile 与 saveStream 共用一个入口保证行为一致。 */
  function record(filePath, requestedName, extra = {}) {
    const name = path.basename(filePath);
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const entry = {
      id,
      name,
      path: filePath,
      rel: path.join(DOWNLOADS_DIR_NAME, name),
      size: fileSize(filePath),
      format: formatOf(name) || extra.format || '',
      at: stamp(),
      createdAt: new Date().toISOString(),
      frames: readFrameCount(filePath),
      requested: requestedName && requestedName !== name ? requestedName : undefined,
      source: extra.source || 'export',
      durationMs: extra.durationMs,
    };
    history.entries[id] = entry;
    history.downloadsDir = dir;
    writeHistory(historyFile, history);
    log('已登记导出:' + filePath);
    return publicEntry(entry);
  }

  function publicEntry(entry) {
    return {
      id: entry.id,
      name: entry.name,
      path: entry.resolvedPath || entry.path || '',
      size: entry.size || 0,
      format: entry.format || '',
      at: entry.at || '',
      frames: entry.frames || null,
      source: entry.source || 'export',
      missing: entry.missing === true,
    };
  }

  return {
    /** 当前下载目录(UI 上显示、按钮「打开文件夹」用)。 */
    dir: () => dir,
    historyFile: () => historyFile,

    /** 是否每次导出都弹「另存为」。false(默认)= 自动落到 downloads/。 */
    getPromptOnSave: () => history.promptOnSave === true,
    setPromptOnSave: (on) => {
      history.promptOnSave = !!on;
      writeHistory(historyFile, history);
      return history.promptOnSave;
    },

    /** 这个路径是否已经登记过(用于避免 will-download 再登记一次同一条记录)。 */
    hasPath(p) {
      if (!p) return false;
      const key = path.resolve(p).toLowerCase();
      history = readHistory(historyFile);
      return Object.values(history.entries).some((e) => {
        const q = e.resolvedPath || e.path;
        return q && path.resolve(q).toLowerCase() === key;
      });
    },

    /**
     * 渲染进程把导出字节流传过来落盘(桌面端导出走这条路)。
     * 这样文件在「导出完成」那一刻就已经躺在 downloads/ 里了 —— 不用等 Chromium 写盘,
     * 页面上也能立刻显示真实文件名(重名加过后缀的那个),而不是请求时的名字。
     * 用户关掉「自动保存」时返回 { mode: 'prompt' },由页面退回 <a download> 走原生另存为。
     */
    async saveBytes(data, filename, extra = {}) {
      if (history.promptOnSave) return { mode: 'prompt' };
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      const target = uniquePath(dir, filename);
      /* 先写 .part 再改名:导出的视频动辄几百 MB,中途失败不能留下一个「看起来正常但播不动」的
       * 半截文件混进下载列表。改名在同一分区上是原子的。 */
      const tmp = target + '.part';
      try {
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, target);
      } catch (e) {
        try { await fsp.unlink(tmp); } catch { /* 忽略 */ }
        throw e;
      }
      const entry = record(target, filename, extra);
      return { mode: 'auto', path: target, name: entry.name, entry };
    },

    /**
     * 给一次新导出分配落点。autoSave=false(用户关了自动保存)时返回空对象,
     * 交给 Chromium 自己的「另存为」流程。
     * taken:同一时刻可能连续发起多次导出,用来避免两次分配撞到同一个候选名。
     */
    allocate(filename, taken = new Set()) {
      if (history.promptOnSave) return { mode: 'prompt' };
      const target = uniquePath(dir, filename, taken);
      return { mode: 'auto', path: target, name: path.basename(target) };
    },

    /**
     * 直接把磁盘上的一份文件登记进历史(自检/外部产出用)。
     * 文件不在 downloads/ 里时会先复制过去,保证「列表里的文件都在一起」。
     */
    importFile(srcPath, optsIn = {}) {
      const src = path.resolve(String(srcPath || ''));
      if (!fs.existsSync(src)) throw new Error('文件不存在: ' + src);
      let target = src;
      if (path.resolve(path.dirname(src)).toLowerCase() !== path.resolve(dir).toLowerCase()) {
        target = uniquePath(dir, path.basename(src));
        fs.copyFileSync(src, target);
      }
      return record(target, path.basename(src), { source: optsIn.source || 'import' });
    },

    /** 从渲染进程传上来的字节流落盘(导出产物走这条路)。 */
    async saveStream(data, filename, extra = {}) {
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      const target = uniquePath(dir, filename);
      const tmp = target + '.part';
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, target);
      return record(target, filename, extra);
    },

    /** 下载列表(已与磁盘对账)。deep=true 时额外做一次有限深度的搬家搜索。 */
    list(optsIn = {}) {
      history = readHistory(historyFile);
      history.downloadsDir = dir;
      /* 顺序很重要:先对账、再补录。
       * 反过来的话,「清单记着旧绝对路径、文件已随软件搬到新位置」的条目会被当成不存在,
       * 于是同一个文件被扫描补录成第二条,列表里出现重复。 */
      let list = Object.values(history.entries);
      if (optsIn.deep) {
        const roots = [path.dirname(dir), appDir, path.join(require('node:os').homedir(), 'Downloads')];
        for (const e of list) resolveEntry(e, dir, { deep: true, deepRoots: roots });
      } else {
        for (const e of list) resolveEntry(e, dir, null);
      }
      importFromScan(history, dir);
      list = Object.values(history.entries);
      writeHistory(historyFile, history);
      // 新的在前:先按 createdAt,缺了就退回文件 mtime,再缺就按显示时间字符串
      list.sort((a, b) => String(b.createdAt || b.at || '').localeCompare(String(a.createdAt || a.at || '')));
      return {
        dir,
        historyFile,
        promptOnSave: history.promptOnSave === true,
        entries: list.map(publicEntry),
        total: list.length,
        missing: list.filter((e) => e.missing).length,
      };
    },

    /**
     * 重命名。新名字不含扩展名时沿用原名后缀;重名不会覆盖,而是自动加 (1)(2)。
     * 文件缺失时拒绝重命名(没有可改的对象)。
     */
    rename(id, newName) {
      history = readHistory(historyFile);
      const entry = history.entries[id];
      if (!entry) throw new Error('记录不存在');
      resolveEntry(entry, dir, null);
      if (!entry.resolvedPath || !fs.existsSync(entry.resolvedPath)) throw new Error('文件已不在原位置,无法重命名');
      let wanted = sanitizeFilename(newName || entry.name);
      const ext = path.extname(wanted);
      if (!ext) wanted += path.extname(entry.name) || '';
      if (wanted === entry.name) return publicEntry(entry);
      const target = uniquePath(dir, wanted);
      if (path.resolve(target) !== path.resolve(entry.resolvedPath)) {
        fs.renameSync(entry.resolvedPath, target);
      }
      entry.name = path.basename(target);
      entry.path = target;
      entry.resolvedPath = target;
      entry.rel = path.join(DOWNLOADS_DIR_NAME, entry.name);
      entry.format = formatOf(entry.name);
      entry.size = fileSize(target);
      entry.missing = false;
      // 改名算一次修改,但不改导出时间:列表仍按「导出先后」排序,避免改个名字就跳到最前面
      history.entries[id] = entry;
      writeHistory(historyFile, history);
      return publicEntry(entry);
    },

    /** 删除。mode: 'record' 只删记录(文件留着), 'file' 连文件一起删。 */
    remove(id, mode = 'record') {
      history = readHistory(historyFile);
      const entry = history.entries[id];
      if (!entry) return { ok: false };
      if (mode === 'file') {
        resolveEntry(entry, dir, null);
        const p = entry.resolvedPath || entry.path;
        if (p && fs.existsSync(p)) {
          /* 用 unlink 而不是 rmSync:某些环境下(中文目录名 + Windows)rmSync 会"成功返回但文件还在",
           * 而 unlink 是直接的系统调用,删掉就是删掉了。失败一定要抛出 —— 静默留下文件会让用户
           * 以为删干净了。 */
          try {
            fs.unlinkSync(p);
          } catch (e) {
            throw new Error('文件删除失败:' + (e && e.message ? e.message : e));
          }
          if (fs.existsSync(p)) throw new Error('文件删除失败:文件仍存在(' + p + ')');
        }
      }
      delete history.entries[id];
      writeHistory(historyFile, history);
      return { ok: true };
    },

    /** 打开文件夹(不传 id 就是下载目录本身)。 */
    resolvePath(id) {
      if (!id) return dir;
      history = readHistory(historyFile);
      const entry = history.entries[id];
      if (!entry) return dir;
      resolveEntry(entry, dir, null);
      return entry.resolvedPath || dir;
    },
  };
}

module.exports = { createDownloads, sanitizeFilename, uniquePath, resolveAppDir, readFrameCount };
