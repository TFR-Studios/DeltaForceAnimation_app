/* ============================================================================
 * 开发模式启动器:npm run app:dev
 *
 * 干四件事:
 *   1. 挑一个可用端口(5173 起顺延,和上游「启动网站.bat」的策略一致,便于书签/脚本复用);
 *   2. 起 vite dev server,并轮询到它**真的能连上**为止(首次冷启动要预构建依赖,可能要十几秒,
 *      不能只等固定秒数);
 *   3. 用 electron 打开 dev server 地址 —— 通过 DFAE_DEV_URL 告诉主进程"这次别启内置服务,
 *      直接连 vite"。这样改 src/ 时是热更新,不用每次重新 build;
 *   4. 任一方退出就回收另一方(关掉应用窗口 → vite 一起停;Ctrl+C → 一起停)。
 *
 * AVI 落盘钩子(站点里 dev 专用、POST /save-avi)由 vite.config.ts 里那个中间件负责,
 * 走 dev server 时与浏览器里完全一样,所以 tools/*.mjs 那些排障脚本依旧能直接对着它跑。
 *
 * 为什么必须先探测端口空闲:5173 上如果跑着**别的**项目(比如上游网页版自己的 dev server),
 * 光判断"端口有响应"会误以为自己的 vite 起来了,于是 Electron 打开的是另一个站点 ——
 * 表现是"窗口里跑的不是这个项目",极难排查。所以这里先占位探测,再让 vite --strictPort 兜底。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT_START = Number(process.env.PORT || 5173);
const PORT_END = PORT_START + 17;

const children = [];
let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const c of children) {
    if (c && !c.killed) { try { c.kill(); } catch { /* 忽略 */ } }
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** 探测端口是否真的空闲(能不能绑上)。 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (await isPortFree(p)) return p;
  }
  return 0;
}

const port = await pickPort();
if (!port) {
  console.error(`[app:dev] ${PORT_START}-${PORT_END} 之间的端口全被占用,请先关掉一些程序。`);
  process.exit(1);
}
if (port !== PORT_START) console.log(`[app:dev] 端口 ${PORT_START} 被占用,改用 ${port}`);
const URL_BASE = `http://127.0.0.1:${port}`;

const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort'], {
  cwd: ROOT, stdio: 'inherit',
});
children.push(vite);
let viteExited = false;
vite.on('exit', (code) => {
  viteExited = true;
  if (code) console.error(`[app:dev] vite 退出,code=${code}`);
  shutdown(code || 0);
});

/** 等 dev server 真的响应(最多 60s);vite 中途退出就直接放弃,别去连一个死的端口。 */
async function waitForServer() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (viteExited) return false;
    try {
      const res = await fetch(URL_BASE + '/', { method: 'GET' });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

if (!(await waitForServer())) {
  console.error(`[app:dev] ${URL_BASE} 没有就绪,vite 可能启动失败。`);
  shutdown(1);
}

const electronPath = require('electron');   // electron 包导出的是 electron.exe 的绝对路径
console.log(`[app:dev] dev server 就绪 → ${URL_BASE},正在启动 Electron…`);
const child = spawn(electronPath, [ROOT], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DFAE_DEV_URL: URL_BASE },
});
children.push(child);
child.on('exit', (code) => shutdown(code || 0));
