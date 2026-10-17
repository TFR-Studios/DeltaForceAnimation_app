#!/usr/bin/env node
/* ============================================================================
 * 清理 release\ 里“不属于当前版本”的旧安装包
 *
 * 为什么需要:electron-builder 只负责写新文件,不会删旧文件。于是 release\ 里会
 * 同时躺着 1.0.0 / 1.0.1 / 1.0.2 三个版本的 exe,双击「启动应用.bat」或看构建
 * 日志时很容易以为“构建出来的还是 1.0.0”。构建成功后跑一次这个脚本,只留下
 * 与 package.json 版本一致的那一批。
 *
 * 只删 release\ 顶层的安装包文件(exe / blockmap / zip),不碰目录、不碰 win-unpacked。
 *
 * 用法:
 *   node scripts/clean-release.mjs            直接删
 *   node scripts/clean-release.mjs --dry-run  只列出会删什么
 * ========================================================================== */
import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const version = pkg.version;

/* 匹配本项目 electron-builder 的产物名:
 *   DeltaForceAnimationEditor-Portable-1.0.2.exe
 *   DeltaForceAnimationEditor-Setup-1.0.2.exe / .exe.blockmap
 *   DeltaForceAnimationEditor-1.0.2-win-unpacked.zip
 * 也兼容 artifactName 中可能出现的 -x64 片段。 */
const artifactRe = /^DeltaForceAnimationEditor-(?:Portable-|Setup-)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:-x64)?(?:\.exe(?:\.blockmap)?|-win-unpacked\.zip)$/;

let names;
try {
  names = await readdir('release');
} catch {
  console.log('  · 没有 release\\ 目录,跳过清理');
  process.exit(0);
}

const stale = [];
for (const name of names) {
  const m = artifactRe.exec(name);
  if (!m) continue;
  if (m[1] === version) continue;
  stale.push(name);
}

if (!stale.length) {
  console.log('  ✔ release\\ 里没有旧版本安装包');
  process.exit(0);
}

for (const name of stale) {
  if (dryRun) {
    console.log('  · 会删除 release\\' + name);
    continue;
  }
  try {
    await unlink(path.join('release', name));
    console.log('  ✔ 已删除旧包 release\\' + name);
  } catch (e) {
    console.log('  ! 删除失败 release\\' + name + ' —— ' + (e.message || e));
  }
}

console.log(dryRun
  ? '  (--dry-run:以上 ' + stale.length + ' 个文件没有真的删除)'
  : '  ✔ 已清理 ' + stale.length + ' 个旧版本安装包,当前版本 ' + version);
