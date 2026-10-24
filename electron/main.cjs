/* ============================================================================
 * 三角洲行动动画编辑器 · Electron 主进程(桌面外壳)
 *
 * 这个文件负责把原来"用 Chrome 打开的静态网站"变成双击即用的 Windows 应用。
 * 四块内容:
 *
 *  1) 内置静态服务(createStaticServer)
 *     站点里到处是 fetch() / HEAD 请求(按需拉动画 JSON、读 Content-Length 算进度),
 *     而且导出用的 WebCodecs 只在**安全上下文**里可用。直接 file:// 打开:相对资源会被
 *     CORS 拦、fetch 直接失败、isSecureContext 也不作数。所以这里自己起一个只监听
 *     127.0.0.1、端口随机(交给系统分配)、把 dist/ 当站点根目录的迷你 http 服务,
 *     等价于原来的 `vite preview`,只是不需要用户先跑命令、也不占固定端口。
 *
 *  2) 原生窗口 / 菜单 / 单实例 / 窗口大小记忆
 *     双击第二次时聚焦已有窗口而不是再开一个;关窗即退出(桌面应用的习惯);
 *     窗口尺寸与是否最大化记在 userData/window-state.json。
 *
 *  3) 导出落盘(installDownloadHandler)
 *     站点导出完成后是 `<a download>` + Blob 触发保存。桌面端把这个动作接管成原生的
 *     "另存为"对话框,存完发一条系统通知(点通知直接在资源管理器里定位文件),
 *     替代浏览器右下角那条下载气泡。
 *
 *  4) 自检模式(见 electron/smoke.cjs)
 *     `electron . --smoke`:启动 → 探测 WebCodecs 能力 → 检查有没有 4xx → 截图 →
 *     (可选)真跑一次导出并校验落盘文件 → 打印 JSON 报告后退出。
 *     打包出来的 exe 也能带这个参数跑,用来证明"产物本身是好的"。
 *
 * 修改这个文件时的两条红线:
 *  - 不要打开 nodeIntegration、不要给渲染进程 Node 能力:站点本身不需要,开了只是扩大攻击面;
 *  - 不要在 file:// 上做妥协(比如把站点改成相对路径去适配):WebCodecs 与 fetch 都依赖
 *    http(s) 源,保住内置服务是最省事的做法。
 * ========================================================================== */
'use strict';

const { app, BrowserWindow, Menu, shell, dialog, session, Notification, nativeImage, ipcMain, net } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
/* 应用内更新:下载流写盘 + detached 启动安装器(见 5c 段) */
const spawn = require('node:child_process').spawn;
const { createDownloads } = require('./downloads.cjs');

/* ---------------------------------------------------------------------------
 * 0. 运行期常量与命令行开关
 * ------------------------------------------------------------------------- */
const APP_ROOT = app.getAppPath();                 // 免安装版是 resources/app;开发时就是工程根目录
const DIST_DIR = path.join(APP_ROOT, 'dist');      // Vite 构建产物 = 站点根目录
const DEV_URL = process.env.DFAE_DEV_URL || '';    // 由 scripts/dev-app.mjs 注入:走 vite dev server 时不启内置服务

const argv = process.argv.slice(1);
const hasFlag = (name) => argv.some((a) => a === name || a.startsWith(name + '='));
const argValue = (name, fallback = '') => {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '1';
};

const SMOKE = hasFlag('--smoke');
const SMOKE_OUT = path.resolve(APP_ROOT, argValue('--smoke-out', path.join('release', 'smoke')));
const SMOKE_EXPORT = String(argValue('--smoke-export', 'none')).toLowerCase();   // none | mp4 | avi
const SMOKE_EXPORT_TIMEOUT = Number(argValue('--smoke-export-timeout', '900000')) || 900000;

/* 布局审计(见 electron/measure.cjs):在真实窗口里量一遍界面的几何/对齐/对比度,
 * 把"比例不对、挤、溢出、折行"这类问题变成可复现的数字。它只读 DOM,不改站点状态。 */
const MEASURE = hasFlag('--measure');
const MEASURE_OUT = path.resolve(APP_ROOT, argValue('--measure-out', path.join('release', 'measure')));

/* 导出落盘与下载历史(见 electron/downloads.cjs)。
 * 延迟到 bootstrap 里创建:它要读 app.getPath('userData'),而 userData 在 ready 之前
 * 还可能是默认值(受 --user-data-dir 等开关影响),早期解析会把历史写到错的地方。 */
let downloads = null;

const APP_ID = 'top.tfrstudio.dfae';
const DEFAULT_BOUNDS = { width: 1480, height: 940 };
const MIN_BOUNDS = { width: 1024, height: 640 };
const BG_COLOR = '#0f1115';                        // 与站点加载界面的底色一致,避免起窗时白闪

/* 预览音效不该被"自动播放策略"拦住:桌面应用里没有浏览器那种"用户手势"语义,
 * 站点按空格播放动画时若带音频,默认策略会静默拒播,表现就是"点了没声音"。 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/* ---------------------------------------------------------------------------
 * 1. 内置静态服务
 * ------------------------------------------------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.txt': 'text/plain; charset=utf-8',
};

/** 目标路径是否真的落在站点根目录内(防 ../ 目录穿越)。 */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 把请求路径映射到磁盘文件。
 *  - 目录 → 其下的 index.html;
 *  - 带扩展名但不存在 → 返回 null(真 404)。**不能**回落到 index.html:
 *    否则资源缺失会被伪装成 200,排障时看不到任何异常;
 *  - 不带扩展名且不存在 → 回落 index.html(单页应用的客户端路由容错)。
 */
function resolveSiteFile(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let target = path.resolve(DIST_DIR, rel || 'index.html');
  if (!isInside(DIST_DIR, target)) return null;
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    if (!fs.existsSync(target)) {
      if (path.extname(rel)) return null;
      target = path.join(DIST_DIR, 'index.html');
      if (!fs.existsSync(target)) return null;
    }
  } catch {
    return null;
  }
  return target;
}

/** 解析 Range 头(导出预览、音频试听都可能带 Range)。返回 null 表示按整文件响应。 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  let start;
  let end;
  if (!hasStart) {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
    if (end >= size) end = size - 1;
  }
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

function createStaticServer() {
  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      res.end('method not allowed');
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    const file = resolveSiteFile(pathname);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + pathname);
      return;
    }
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('stat failed');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      /* 带指纹的产物(/assets/xxx-<hash>.png)可以长缓存;入口文件必须每次校验,
       * 否则用户改了 dist 重新打开还是旧界面。 */
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    const range = method === 'GET' ? parseRange(req.headers.range, size) : null;
    if (range && range.invalid) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = end - start + 1;
    headers['Content-Length'] = String(length);   // 站点靠 Content-Length 算加载进度,必须给准
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => { try { res.destroy(); } catch { /* 忽略 */ } });
    stream.pipe(res);
  });
  server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* 忽略 */ } });
  return server;
}

/** 起服务并把端口交给系统分配(0 → 随机空闲端口),避免与用户其它程序抢 5173。 */
function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = createStaticServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/* ---------------------------------------------------------------------------
 * 2. 窗口状态记忆
 * ------------------------------------------------------------------------- */
function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    const { screen } = require('electron');
    const ok = Number.isFinite(raw.width) && Number.isFinite(raw.height)
      && Number.isFinite(raw.x) && Number.isFinite(raw.y)
      && screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return raw.x < a.x + a.width - 40 && raw.x + raw.width > a.x + 40
          && raw.y < a.y + a.height - 40 && raw.y + raw.height > a.y + 40;
      });
    return ok ? raw : { width: raw.width, height: raw.height, maximized: !!raw.maximized };
  } catch {
    return null;
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify({
      ...bounds, maximized: win.isMaximized(), savedAt: new Date().toISOString(),
    }, null, 2));
  } catch { /* 记不住窗口大小不是错误,静默忽略 */ }
}

/* ---------------------------------------------------------------------------
 * 3. 菜单 / 下载 / 说明
 * ------------------------------------------------------------------------- */
function buildMenu(win, origin) {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开导出文件夹', click: () => shell.openPath(downloads ? downloads.dir() : app.getPath('downloads')) },
        { label: '打开应用数据目录', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        {
          label: '开发者工具',
          accelerator: 'F12',
          click: () => win.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '在线站点',
          click: () => shell.openExternal('https://df.tfr-studio.top'),
        },
        {
          label: '关于',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: '关于',
            message: '三角洲行动动画编辑器',
            detail: [
              `桌面版 ${app.getVersion()}`,
              `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
              '',
              '动画素材版权归原游戏所有,编辑器代码以 GPL-3.0 开源。',
            ].join('\n'),
            buttons: ['好'],
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 接管导出落盘。
 * 站点导出结束时用 `<a download>` 触发保存。桌面端分两条路:
 *   · 自动保存(默认,可在「下载列表」面板里关掉)—— 直接落到 downloads/ 并登记进下载历史,
 *     不再弹「另存为」;文件名由渲染进程给(动画名 + 时间戳),重名自动加 (1)(2);
 *   · 询问保存位置(把「自动保存」关掉后)—— 保留原来的原生「另存为」对话框。
 * 两条路完成后都发系统通知(点通知在资源管理器里定位文件),并通知渲染进程刷新下载列表。
 * 自检模式(--smoke)下不弹框:直接落到 --smoke-out 指定的目录,但**依然登记下载历史** ——
 * 自检的意义正是证明「导出 → 落盘 → 进下载列表」这条链路在打包产物里也是通的。
 */
function installDownloadHandler(getWin) {
  session.defaultSession.on('will-download', (event, item) => {
    const filename = item.getFilename();
    /* 自检时把每一次下载决策记进 smokeState.notes:导出完成但文件没落盘时,
     * "will-download 到底有没有触发、存到哪个路径"是唯一能区分两类原因的信息
     * (站点没触发下载 vs 主进程接管失败)。 */
    const trace = (m) => { if (SMOKE) smokeState.notes.push('[download] ' + m); };
    let allocated = null;                 // 自动保存时记下分配到的落点,完成后据此登记历史
    if (SMOKE) {
      try { fs.mkdirSync(SMOKE_OUT, { recursive: true }); } catch { /* 忽略 */ }
      item.setSavePath(path.join(SMOKE_OUT, filename));
    } else {
      /* 自动保存必须显式 setSavePath:只设 setSaveDialogOptions 会弹框。
       * 万一分配失败(目录这一瞬间不可写),退回「另存为」,不吞掉这次导出。 */
      try { allocated = downloads ? downloads.allocate(filename) : null; } catch { allocated = null; }
      if (allocated && allocated.mode === 'auto') {
        item.setSavePath(allocated.path);
      } else {
        const ext = path.extname(filename).toLowerCase();
        item.setSaveDialogOptions({
          title: '保存导出视频',
          defaultPath: path.join(downloads ? downloads.dir() : app.getPath('downloads'), filename),
          filters: ext === '.avi'
            ? [{ name: 'AVI 视频', extensions: ['avi'] }, { name: '所有文件', extensions: ['*'] }]
            : [{ name: 'MP4 视频', extensions: ['mp4'] }, { name: '所有文件', extensions: ['*'] }],
        });
      }
    }
    const started = Date.now();
    item.once('done', (_e, state) => {
      const savePath = item.getSavePath();
      const report = { filename, state, savePath, bytes: safeSize(savePath), elapsedMs: Date.now() - started };
      /* 先登记下载历史 —— 自检模式也要走这一步(自检正是用来证明这条链路通的),
       * 所以不能像以前那样在 SMOKE 分支里提前 return 掉。 */
      let entry = null;
      if (state === 'completed' && downloads && savePath) {
        /* 最终文件名可能与请求的不同(重名会加 (1) 后缀),所以以实际落盘路径为准。
         * 若渲染进程已经通过 dfae:downloads-save 落盘并登记过(自动保存那条路),
         * 这里就不再重复登记,否则列表里会出现两条一模一样的记录。 */
        try {
          entry = downloads.hasPath(savePath)
            ? { name: path.basename(savePath) }
            : downloads.importFile(savePath, { source: 'export' });
          trace('登记历史:' + (entry ? entry.name : '无'));
        } catch (e) { entry = null; trace('登记历史失败:' + e.message); }
      }
      if (SMOKE) {
        report.entry = entry ? entry.name : null;
        smokeState.downloads.push(report);
        return;
      }
      const win = getWin();
      if (state === 'completed') {
        notifyDownloadsChanged(win);
        const shown = entry ? entry.name : filename;
        const note = new Notification({
          title: '导出完成',
          body: `${shown}\n${(report.bytes / 1024 / 1024).toFixed(1)} MB · 点击定位文件`,
        });
        note.on('click', () => { if (savePath) shell.showItemInFolder(savePath); });
        note.show();
      } else if (state === 'interrupted') {
        new Notification({ title: '导出未完成', body: `${filename} 已中断` }).show();
        if (win) dialog.showMessageBox(win, { type: 'warning', title: '导出未完成', message: '导出未完成', detail: filename, buttons: ['好'] });
        notifyDownloadsChanged(win);
      }
    });
    // setSaveDialogOptions / setSavePath 后仍需显式 "不取消",否则部分版本会静默取消
    if (typeof item.isPaused === 'function' && item.isPaused()) item.resume();
    void event;
  });
}

/** 通知渲染进程刷新下载列表(面板开着时立即多出一条,不用手动刷新)。 */
function notifyDownloadsChanged(win) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('dfae:downloads-changed'); } catch { /* 窗口正在销毁,忽略 */ }
}

/**
 * 导出产物该放在哪个「软件目录」下(见 downloads.cjs 的 ensureDownloadsDir)。
 * 三种运行形态的正确答案不同:
 *   · 开发态(npm run app:start):工程根目录 —— APP_ROOT 就是它;
 *   · 普通打包(win-unpacked / 装到 Program Files):exe 所在目录;
 *   · 便携版(portable exe):**便携 exe 自己所在的目录**。便携版会把 resources 解到
 *     %TEMP%\<随机名> 里,app.getAppPath() 指的是那个临时目录 —— 拿它当软件目录,
 *     导出产物会落在退出即被清理的临时目录里,用户「导出完就找不到了」。
 *     PORTABLE_EXECUTABLE_DIR 是 electron-builder 便携版注入的变量,正好就是 exe 的所在目录。
 */
function resolveExportAppDir() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir && fs.existsSync(portableDir)) return portableDir;
  if (app.isPackaged) return path.dirname(process.execPath);
  return APP_ROOT;
}

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/* ---------------------------------------------------------------------------
 * 4. 窗口 / 自检
 * ------------------------------------------------------------------------- */
const smokeState = { downloads: [], notes: [] };
let mainWindow = null;
let appOrigin = '';

function createWindow(origin, restored) {
  const win = new BrowserWindow({
    ...DEFAULT_BOUNDS,
    ...(restored || {}),
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    show: false,
    backgroundColor: BG_COLOR,
    title: '三角洲行动动画编辑器',
    autoHideMenuBar: true,               // 菜单栏默认隐藏,按 Alt 唤出(桌面应用的习惯)
    icon: loadAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      /* 导出是"逐帧渲染 + 编码"的长任务:窗口被最小化/遮挡时若被 Chromium 节流,
       * 导出会被拖慢甚至看起来卡住。桌面端关掉后台节流。 */
      backgroundThrottling: false,
    },
  });
  win.removeMenu();                       // 先移掉默认英文菜单,再挂中文菜单
  buildMenu(win, origin);
  win.once('ready-to-show', () => {
    if (restored && restored.maximized) win.maximize();
    if (!SMOKE) win.show();
  });
  win.on('close', () => saveWindowState(win));

  /* 外链一律交给系统浏览器:应用窗口只用来跑编辑器本身。 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (appOrigin && url.startsWith(appOrigin)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  return win;
}

/** 打包后 exe 自带图标;开发态没有 exe 图标,退回 public/logo.svg 转的 PNG(拿不到就返回 undefined)。 */
function loadAppIcon() {
  const png = path.join(__dirname, '..', 'build', 'icon.png');
  try {
    if (fs.existsSync(png)) {
      const img = nativeImage.createFromPath(png);
      if (!img.isEmpty()) return img;
    }
  } catch { /* 忽略 */ }
  return undefined;
}

async function bootstrap() {
  app.setAppUserModelId(APP_ID);          // Windows 通知/任务栏归组要靠它

  /* 自检时把主进程里的未捕获异常/未处理拒绝也记进报告:
   * 这类异常只会让某个回调"悄悄不执行"(比如下载完成后的历史登记),
   * 表面上一切正常,不记下来根本查不到。 */
  if (SMOKE) {
    process.on('uncaughtException', (e) => smokeState.notes.push('[uncaught] ' + (e && e.stack ? e.stack : e)));
    process.on('unhandledRejection', (e) => smokeState.notes.push('[unhandled] ' + (e && e.stack ? e.stack : e)));
  }

  if (!DEV_URL && !fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    dialog.showErrorBox('缺少构建产物', `没有找到 ${path.join(DIST_DIR, 'index.html')}。\n\n请在工程目录先执行 npm run build,或用 npm run dist 重新打包。`);
    app.exit(2);
    return;
  }

  let server = null;
  if (DEV_URL) {
    appOrigin = DEV_URL.replace(/\/+$/, '');
  } else {
    const started = await startStaticServer();
    server = started.server;
    appOrigin = started.origin;
  }

  /* 导出落盘 / 下载列表。必须在 installDownloadHandler 之前建好 ——
   * will-download 里要用它分配落点。SMOKE 模式下仍创建(自检要覆盖下载历史这条链路),
   * 但导出走 --smoke-out,不落进 downloads/。 */
  downloads = createDownloads({
    execPath: process.execPath,
    appDir: resolveExportAppDir(),
    userDataDir: app.getPath('userData'),
    downloadsHome: app.getPath('downloads'),
    log: (m) => { if (SMOKE) smokeState.notes.push(m); },
  });

  installDownloadHandler(() => mainWindow);

  const restored = readWindowState() || {};
  mainWindow = createWindow(appOrigin, restored);

  /* 诊断收集:控制台告警/错误 + 4xx/5xx 与网络失败。
   * 平时只在开发者工具里能看到的这些东西,自检模式会把它们写进报告 —— 
   * "界面看着正常但缺了张图"这类问题只有这样才抓得住。 */
  const diagnostics = { consoleIssues: [], badResponses: [] };
  mainWindow.webContents.on('console-message', (...args) => {
    let level;
    let message;
    let source = '';
    let line = 0;
    if (args.length >= 5) { [, level, message, line, source] = args; }
    else if (args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
      ({ level, message, sourceId: source, lineNumber: line } = args[0]);
    } else return;
    const severe = level === 'warning' || level === 'error' || (typeof level === 'number' && level >= 2);
    if (!severe) return;
    diagnostics.consoleIssues.push({ level: String(level), message: String(message).slice(0, 500), source: String(source || ''), line });
  });
  session.defaultSession.webRequest.onCompleted({ urls: ['*://*/*'] }, (d) => {
    if (d.statusCode >= 400) diagnostics.badResponses.push({ status: d.statusCode, method: d.method, url: d.url.slice(0, 300) });
  });
  session.defaultSession.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (d) => {
    diagnostics.badResponses.push({ status: -1, error: d.error, method: d.method, url: d.url.slice(0, 300) });
  });

  /* 自检 / 布局审计直接进编辑器(?view=editor):它们量的是编辑器几何与导出链路,
   * 开始页盖在上面会让截图与点击全部落在开始页上。开始页自己的回归在
   * tools/verify-start-screen.mjs(它显式带 ?view=home)。 */
  await mainWindow.loadURL(appOrigin + '/index.html' + (SMOKE || MEASURE ? '?view=editor' : ''));

  if (SMOKE) {
    const { runSmoke } = require('./smoke.cjs');
    /* 自检期间临时改成「询问保存位置」。
     * 桌面端正常导出是渲染进程把字节流交给主进程(dfae:downloads-save)并静默落盘,
     * 自检需要看到「导出 → 落盘 → 登记历史」这条链路走得通,而它的观测点在 will-download 上,
     * 所以这里把自动保存关掉,让导出退回 <a download> 那条管线(会由 --smoke 分支直接写进
     * --smoke-out,不弹任何对话框)。跑完立刻改回用户原来的设置,绝不留下痕迹。 */
    const promptBefore = downloads.getPromptOnSave();
    downloads.setPromptOnSave(true);
    smokeState.notes.push('自检期间临时关闭自动保存(promptOnSave=true),跑完会还原');
    let code;
    try {
      code = await runSmoke({
        win: mainWindow,
        origin: appOrigin,
        outDir: SMOKE_OUT,
        exportFormat: SMOKE_EXPORT,
        exportTimeoutMs: SMOKE_EXPORT_TIMEOUT,
        diagnostics,
        smokeState,
        distDir: DIST_DIR,
        downloads,
      });
    } finally {
      downloads.setPromptOnSave(promptBefore);
    }
    if (server) server.close();
    app.exit(code);
    return;
  }

  if (MEASURE) {
    const { runMeasure } = require('./measure.cjs');
    const code = await runMeasure({ win: mainWindow, origin: appOrigin, outDir: MEASURE_OUT, downloads });
    if (server) server.close();
    app.exit(code);
    return;
  }

  mainWindow.show();

  app.on('window-all-closed', () => {
    if (server) server.close();
    app.quit();
  });
}

/* 单实例:第二次双击只把已有窗口拿到前台,避免开出两个一模一样的应用。 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  /* 渲染进程崩溃时别静默留个白窗口,至少告诉用户发生了什么。 */
  app.on('render-process-gone', (_e, _wc, details) => {
    if (SMOKE) return;
    dialog.showErrorBox('界面进程异常退出', `原因:${details.reason}\n\n重新打开应用即可继续。`);
  });

  app.whenReady().then(bootstrap);
}

/* ---------------------------------------------------------------------------
 * 5. 渲染进程可调用的小接口(见 preload.cjs)
 * ------------------------------------------------------------------------- */
ipcMain.handle('dfae:info', () => ({
  version: app.getVersion(),
  name: app.getName(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  packaged: app.isPackaged,
  downloadsDir: app.getPath('downloads'),
  userDataDir: app.getPath('userData'),
  /* 本应用的导出目录与下载历史文件位置(与系统「下载」区分开,面板上要如实显示) */
  exportDir: downloads ? downloads.dir() : '',
  historyFile: downloads ? downloads.historyFile() : '',
}));

/* ---------------------------------------------------------------------------
 * 5b. 更新检查(开始页的「检查更新」)
 *
 * 为什么放在主进程:主进程用的是 Electron 的 net.fetch,它**走系统代理设置** ——
 * 渲染进程的 fetch 不认系统代理,公司网络 / 代理后面就只剩"网络错误";
 * 顺带也少一道跨域开关(api.gitcode.com 的 ACAO 是动态的:带 Origin 才给,
 * 代理或网关一变就可能没有,不该把"能不能检查更新"押在这上面)。
 *
 * 顺序是 GitCode → GitHub,两个接口字段名一致(见 README「软件怎么做更新检查」),
 * 所以解析只做一次。两个都失败时把每一源的失败原因一起返回:界面上要能区分
 * "网络不可用"和"GitCode 挂了但 GitHub 顶上了",这决定了用户该不该换个时间再试。
 * ------------------------------------------------------------------------- */
const UPDATE_SOURCES = [
  { id: 'gitcode', label: 'GitCode', url: 'https://api.gitcode.com/api/v5/repos/TFR-Studios/DeltaForceAnimation_app/releases/latest' },
  { id: 'github', label: 'GitHub', url: 'https://api.github.com/repos/TFR-Studios/DeltaForceAnimation_app/releases/latest' },
];

/** 带超时的 JSON 请求。超时用 AbortController:Promise.race 只是"不再等",请求还挂着。 */
async function fetchReleaseJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const res = await net.fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        /* GitHub 的 API 对没有 User-Agent 的请求返回 403,这里显式给一个 */
        'user-agent': 'DeltaForceAnimationEditor/' + app.getVersion(),
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('dfae:check-update', async () => {
  const tried = [];
  for (const src of UPDATE_SOURCES) {
    try {
      const data = await fetchReleaseJson(src.url, 8000);
      if (!data || !data.tag_name) throw new Error('返回内容里没有版本号');
      return { ok: true, source: src.id, label: src.label, release: data };
    } catch (e) {
      tried.push(src.label + ': ' + ((e && e.message) || String(e)));
    }
  }
  return { ok: false, tried };
});

/* ---------------------------------------------------------------------------
 * 5c. 应用内更新:下载安装包 → 校验 → 启动安装器 → 退出自己
 *
 * 为什么能在应用内装:NSIS 安装包(oneClick,装到 %LOCALAPPDATA%)会**替换**掉正在运行的程序,
 * 所以必须先退出自己再启动安装器 —— 运行中的 exe 在 Windows 上不允许被覆盖。
 * 安装器是 detached 启动的:主进程退出后它还活着,装完由 runAfterFinish 自动拉起新版。
 *
 * 三条硬约束(改动这里之前先读):
 *   1) 只允许从发行版站点下载 —— URL 走白名单,不然这个接口等于"任意地址下载并执行";
 *   2) 只接受我方临时目录里的 .exe,并且校验 PE 头(MZ)—— 下载到一半的文件不能被当成安装包执行;
 *   3) 便携版不能用这条路:它每次启动都解压到 %TEMP%,没有固定安装目录可替换,
 *      所以便携版把 canSelfUpdate 报成 false,界面退回「前往下载」。
 * ------------------------------------------------------------------------- */
const UPDATE_DOWNLOAD_HOSTS = new Set([
  'gitcode.com',
  'api.gitcode.com',
  'raw.gitcode.com',
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
/* 安装包的落地目录:系统临时目录下的固定子目录,退出时不需要清理(系统会收)。 */
function updateDownloadDir() {
  const dir = path.join(app.getPath('temp'), 'dfae-update');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  return dir;
}
/** 便携版判定:electron-builder 给便携版注入 PORTABLE_EXECUTABLE_DIR。 */
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;

let updateJob = null; // { req, file, stream, cancelled, done }

function sendUpdateProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dfae:update-progress', payload);
  }
}

ipcMain.handle('dfae:update-capabilities', () => ({
  canSelfUpdate: !IS_PORTABLE && process.platform === 'win32',
  portable: IS_PORTABLE,
  platform: process.platform,
}));

ipcMain.handle('dfae:update-download', async (_e, arg) => {
  const rawUrl = String((arg && arg.url) || '');
  const rawName = String((arg && arg.filename) || '');
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: '下载地址不合法' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: '只允许 https 下载' };
  if (!UPDATE_DOWNLOAD_HOSTS.has(parsed.hostname)) return { ok: false, error: '不在允许的下载站点内: ' + parsed.hostname };
  if (!IS_PORTABLE && process.platform !== 'win32') return { ok: false, error: '当前平台不支持应用内安装' };

  if (updateJob && !updateJob.done) return { ok: false, error: '已经有一个下载在进行中' };

  /* 文件名:只保留安全字符,并且必须以 .exe 结尾(应用内安装只处理 Windows 安装包) */
  const safeName = rawName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'setup.exe';
  if (!/\.exe$/i.test(safeName)) return { ok: false, error: '只支持下载 .exe 安装包' };
  const dir = updateDownloadDir();
  const file = path.join(dir, Date.now() + '-' + safeName);
  const stream = fs.createWriteStream(file);

  return await new Promise((resolve) => {
    let received = 0;
    let total = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      updateJob = null;
      try { stream.close(); } catch { /* ignore */ }
      if (!result.ok) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
      resolve(result);
    };

    const req = net.request({ method: 'GET', url: parsed.toString(), redirect: 'follow' });
    updateJob = { req, file, stream, done: false, cancelled: false };

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish({ ok: false, error: '下载失败(HTTP ' + res.statusCode + ')' });
        return;
      }
      total = Number(res.headers['content-length'] || 0) || 0;
      sendUpdateProgress({ phase: 'start', received: 0, total, pct: 0 });
      let lastSent = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        stream.write(chunk);
        const now = Date.now();
        /* 进度事件按 120ms 节流:每块都发会把 IPC 通道塞爆,而进度条 8 帧/秒已经够顺 */
        if (now - lastSent > 120 || (total && received >= total)) {
          lastSent = now;
          sendUpdateProgress({ phase: 'downloading', received, total, pct: total ? Math.min(99, Math.round((received / total) * 100)) : 0 });
        }
      });
      res.on('end', () => {
        stream.end(() => {
          /* 校验:大小与 Content-Length 一致(拿不到 Content-Length 时跳过),
           * 且文件头必须是 MZ —— 下载到一半的残包不能被当作安装器启动。 */
          const size = (() => { try { return fs.statSync(file).size; } catch { return -1; } })();
          if (total && size !== total) {
            finish({ ok: false, error: '下载不完整(' + size + '/' + total + ' 字节)' });
            return;
          }
          let head = Buffer.alloc(0);
          try {
            const fd = fs.openSync(file, 'r');
            head = Buffer.alloc(2);
            fs.readSync(fd, head, 0, 2, 0);
            fs.closeSync(fd);
          } catch { /* 读不到头就按失败处理 */ }
          if (head.toString('latin1') !== 'MZ') {
            finish({ ok: false, error: '下载下来的文件不是 Windows 可执行文件' });
            return;
          }
          sendUpdateProgress({ phase: 'done', received, total: total || size, pct: 100 });
          finish({ ok: true, path: file, size, name: safeName });
        });
      });
      res.on('aborted', () => finish({ ok: false, error: '下载被中断' }));
      res.on('error', (err) => finish({ ok: false, error: '下载出错: ' + (err && err.message) }));
    });

    req.on('error', (err) => finish({ ok: false, error: '下载失败: ' + (err && err.message) }));
    req.end();
  });
});

ipcMain.handle('dfae:update-cancel', () => {
  if (!updateJob) return false;
  updateJob.cancelled = true;
  try { updateJob.req.abort(); } catch { /* ignore */ }
  const file = updateJob.file;
  updateJob = null;
  try { if (file) fs.unlinkSync(file); } catch { /* ignore */ }
  sendUpdateProgress({ phase: 'cancelled' });
  return true;
});

ipcMain.handle('dfae:update-install', async (_e, arg) => {
  const file = String((arg && arg.path) || '');
  const dir = updateDownloadDir();
  /* 只接受我们自己下载到临时目录里的文件:路径必须落在该目录内,且是 .exe */
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) return { ok: false, error: '安装包路径不在允许范围内' };
  if (!/\.exe$/i.test(resolved)) return { ok: false, error: '不是安装包' };
  if (!fs.existsSync(resolved)) return { ok: false, error: '安装包已被删除,请重新下载' };
  try {
    const fd = fs.openSync(resolved, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head.toString('latin1') !== 'MZ') return { ok: false, error: '安装包损坏' };
  } catch (e) {
    return { ok: false, error: '安装包读取失败: ' + (e && e.message) };
  }

  /* detached + unref:主进程退出后安装器继续跑;oneClick 安装器装完会自动拉起新版
   * (package.json 的 nsis.runAfterFinish 已经是 true)。 */
  const child = spawn(resolved, [], { detached: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => { try { app.quit(); } catch { /* ignore */ } }, 400);
  return { ok: true };
});

ipcMain.handle('dfae:open-external', (_e, url) => {
  const s = String(url || '');
  if (!/^https?:\/\//i.test(s)) return false;   // 只允许 http(s),避免被当作命令打开
  shell.openExternal(s);
  return true;
});

ipcMain.handle('dfae:reveal-file', (_e, file) => {
  const s = String(file || '');
  if (!s) return false;
  shell.showItemInFolder(s);
  return true;
});

/* ---------------------------------------------------------------------------
 * 6. 下载列表 / 下载历史(渲染进程的「下载列表」面板)
 *
 * 这里每个 handle 都只在 downloads 就绪后工作。bootstrap 之前(理论上不会发生)
 * 或创建失败时统一返回空结果,页面表现为「列表为空」而不是整块功能报错。
 * ------------------------------------------------------------------------- */

/** 下载列表(已与磁盘对账)。deep=true 时额外做一次有限深度的「文件被挪走」搜索。 */
ipcMain.handle('dfae:downloads-list', (_e, arg) => {
  if (!downloads) return { dir: '', historyFile: '', promptOnSave: false, entries: [], total: 0, missing: 0 };
  return downloads.list({ deep: !!(arg && arg.deep) });
});

/** 开/关「每次导出询问保存位置」。关掉 = 自动保存进 downloads/。 */
ipcMain.handle('dfae:downloads-prompt', (_e, on) => (downloads ? downloads.setPromptOnSave(!!on) : false));

/** 导出落盘:渲染进程把字节流传过来,主进程写进 downloads/ 并登记历史。
 * 返回 { mode:'auto', name, path, entry };用户关掉「自动保存」时返回 { mode:'prompt' },
 * 由页面退回 <a download> 走原生「另存为」。 */
ipcMain.handle('dfae:downloads-save', async (_e, filename, bytes) => {
  if (!downloads) throw new Error('下载历史尚未就绪');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const res = await downloads.saveBytes(buf, String(filename || 'animation.mp4'), { source: 'export' });
  /* 自检时记录这次落盘决策:能区分「页面没走 IPC」「用户关了自动保存」与「真的写失败了」。 */
  if (SMOKE) smokeState.notes.push('[ipc-save] ' + filename + ' → ' + res.mode + (res.path ? ' ' + res.path : '')); 
  return res;
});

/** 重命名。返回新的条目;重名不会覆盖,自动加序号后缀。 */
ipcMain.handle('dfae:downloads-rename', (_e, id, name) => {
  if (!downloads) throw new Error('下载历史尚未就绪');
  return downloads.rename(String(id || ''), String(name || ''));
});

/** 删除。mode='file' 连文件一起删;默认只删记录,磁盘上的视频保持不动。 */ipcMain.handle('dfae:downloads-remove', (_e, id, mode) => {
  if (!downloads) return { ok: false };
  return downloads.remove(String(id || ''), mode === 'file' ? 'file' : 'record');
});

/** 在资源管理器里定位:传条目 id 就定位该文件,传空就打开下载目录。 */
ipcMain.handle('dfae:downloads-reveal', (_e, id) => {
  if (!downloads) return false;
  const target = downloads.resolvePath(id ? String(id) : '');
  if (!target) return false;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) shell.showItemInFolder(target);
  else shell.openPath(target);
  return true;
});

/** 用系统默认播放器打开;文件不在时返回 false,由页面提示「文件已不在原位置」。 */
ipcMain.handle('dfae:downloads-open', async (_e, id) => {
  if (!downloads) return false;
  const target = downloads.resolvePath(id ? String(id) : '');
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const err = await shell.openPath(target);
  return !err;
});
