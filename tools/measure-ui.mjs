/* ============================================================================
 * 界面布局审计的驱动器:准备确定性夹具 → 拉起 Electron 的 --measure 模式 → 报告结果。
 *
 * 为什么要有驱动器和夹具:
 *   布局问题(挤、溢出、折行、对齐、对比度)只有在"内容足够难"的时候才暴露 ——
 *   空列表永远好看。所以这里先造一份刻意的极端数据:
 *     · 一条超长中文文件名(考验省略与列对齐)
 *     · 一条被删掉文件的记录(考验"文件已不在原位置"那一行的排版)
 *     · 一条 AVI / 一条 WEBM(考验格式角标宽度)
 *     · 一条长体积(GB 级)记录(考验元信息长度)
 *   再用临时 userDataDir + 临时下载目录把它喂给应用,不碰用户真实的历史与文件。
 *
 * 用法:node tools/measure-ui.mjs [--keep]
 *   退出码 0 = 布局不变量全部通过;1 = 有失败项(逐条列出)。
 * ========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronBin = require('electron');

const keep = process.argv.includes('--keep');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfae-measure-'));
const userData = path.join(root, 'userData');
const downloadsDir = path.join(root, 'downloads', '三角洲行动动画编辑器');
const outDir = path.join(process.cwd(), 'release', 'measure');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(downloadsDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

/** 造一个"像真的"MP4:带 ftyp 与 stts,应用会读出帧数显示在列表里。 */
function fakeMp4(frames, bytes) {
  const head = Buffer.alloc(32);
  head.write('....', 0, 'latin1');
  head.write('ftyp', 4, 'latin1');
  const stts = Buffer.alloc(16);
  stts.write('stts', 0, 'latin1');
  stts.writeUInt32BE(frames, 12);
  return Buffer.concat([head, stts, Buffer.alloc(Math.max(0, bytes - 48), 7)]);
}
function fakeAvi(frames, bytes) {
  const head = Buffer.alloc(64);
  head.write('RIFF', 0, 'latin1');
  head.write('AVI ', 8, 'latin1');
  head.write('avih', 32, 'latin1');
  head.writeUInt32LE(frames, 48);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - 64), 5)]);
}

/* 夹具:名字长度、格式、体积、状态都刻意拉开,把排版推到边界。 */
const fixtures = [
  { name: '撤离动画-20261007-153705.mp4', size: 500506, frames: 609, kind: 'mp4' },
  { name: '大战场弹窗动画-副标题与内容都改成长文案-20261006-221430.mp4', size: 128_400_000, frames: 609, kind: 'mp4' },
  { name: '位置暴露动画-20261005-090501.avi', size: 2_340_000_000, frames: 601, kind: 'avi' },
  { name: '任务弹窗动画-20261004-184512.webm', size: 84_000, frames: 300, kind: 'webm' },
  { name: '撤离点开启动画-20261003-120000.mp4', size: 12_000_000, frames: 359, kind: 'mp4', missing: true },
  { name: '地图标题动画-20261002-080000.mp4', size: 1_100_000, frames: 240, kind: 'mp4' },
];

/* 夹具用「稀疏文件」造大体积:写个真文件头,再用 truncate 把长度撑到目标体积。
 * 这样能得到 GB 级的 size(考验元信息排版),而磁盘上几乎不占空间、也不会分配大 Buffer。 */
function makeFixtureFile(file, kind, frames, size) {
  const head = kind === 'avi' ? fakeAvi(frames, 64) : fakeMp4(frames, 48);
  fs.writeFileSync(file, head);
  if (size > head.length) fs.truncateSync(file, size);
}

const entries = {};
const now = Date.now();
fixtures.forEach((f, i) => {
  const id = 'fixture' + i;
  const file = path.join(downloadsDir, f.name);
  if (!f.missing) makeFixtureFile(file, f.kind, f.frames, f.size);
  const at = new Date(now - i * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  entries[id] = {
    id,
    name: f.name,
    path: file,
    rel: path.join('downloads', f.name),
    size: f.size,
    format: path.extname(f.name).replace('.', '').toUpperCase(),
    at: stamp,
    createdAt: at.toISOString(),
    frames: f.frames,
    source: 'export',
  };
});

fs.writeFileSync(path.join(userData, 'download-history.json'), JSON.stringify({
  version: 1,
  entries,
  downloadsDir,
  promptOnSave: false,
}, null, 2));

const args = [
  '.',
  '--measure',
  '--measure-out=' + outDir,
  '--user-data-dir=' + userData,
];
const child = spawn(electronBin, args, {
  cwd: process.cwd(),
  env: { ...process.env, DFAE_DOWNLOADS_DIR: downloadsDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (c) => { stdout += c.toString(); });
child.stderr.on('data', (c) => { stderr += c.toString(); });

const code = await new Promise((resolve) => child.on('close', resolve));

/* 把应用打印的摘要原样透传(它是给人的,不是给脚本的) */
const summary = stdout.split('__MEASURE_JSON__')[0].trim();
if (summary) console.log(summary);
if (code !== 0 && stderr.trim()) {
  console.log('\n--- 子进程 stderr ---\n' + stderr.trim().split('\n').slice(-25).join('\n'));
}

const reportPath = path.join(outDir, 'measure-report.json');
if (fs.existsSync(reportPath)) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  console.log('\n夹具:6 条记录(超长名 / GB 级体积 / AVI / WEBM / 已丢失 / 普通)');
  console.log('报告:' + reportPath);
}

/* 夹具清理:刻意不用 fs.rmSync。
 * 这台机器上有个诡异行为:目录名含非 ASCII(夹具里那个「三角洲行动动画编辑器」就是)
 * 时 rmSync 会"成功返回但文件还在",连 force+recursive 也不可靠 ——
 * 更糟的是它有时直接抛未处理异常,把整个脚本的退出码变成 1,于是"检查全过"也被判失败。
 * 所以这里自己递归删:unlink 文件、rmdir 目录,一步失败只影响那一个文件。 */
function removeTree(target) {
  let entries = [];
  try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(target, e.name);
    try {
      if (e.isDirectory()) removeTree(full);
      else fs.unlinkSync(full);
    } catch { /* 单个文件删不掉不影响结论 */ }
  }
  try { fs.rmdirSync(target); } catch { /* 目录非空/被占用,留给系统清理 */ }
}

if (!keep) {
  removeTree(root);
} else {
  console.log('夹具保留在:' + root);
}
process.exit(code === 0 ? 0 : 1);
