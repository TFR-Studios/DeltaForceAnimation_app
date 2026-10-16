#!/usr/bin/env node
/* ============================================================================
 * 版本号一致性校验(发布前拦截)
 *
 * 为什么需要:标签名和代码里的版本号之间**没有任何自动关联** ——
 * 忘了改版本号就会打出「标签叫 v1.0.2、包名却还是 1.0.1」的包,而且发出去就不好收回了。
 *
 * 三处版本号必须一致,且(推标签触发时)标签名去掉前缀 v 后也要一致:
 *   package.json              → Electron 打包与 APK 命名用它
 *   src-tauri/tauri.conf.json → 安卓的 versionName / versionCode 由它派生
 *   src-tauri/Cargo.toml      → Rust 产物里的版本
 *
 * 手动跑: GITHUB_REF=refs/tags/v1.0.2 node scripts/check-version.mjs
 * ========================================================================== */
import { readFile } from 'node:fs/promises';

function fail(lines) {
  console.error('');
  for (const l of lines) console.error('❌ ' + l);
  console.error('');
  process.exit(1);
}

const pkgVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const tauriVersion = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).version;

/* Cargo.toml 里 version = "..." 会出现多次(依赖也有),只认 [package] 段里的那个 */
const cargoText = await readFile('src-tauri/Cargo.toml', 'utf8');
const pkgSection = cargoText.split(/^\[package\]/m)[1] || '';
const cargoBody = pkgSection.split(/^\[/m)[0];
const cargoMatch = cargoBody.match(/^version\s*=\s*"([^"]+)"/m);
const cargoVersion = cargoMatch ? cargoMatch[1] : null;

console.log('  package.json               : ' + pkgVersion);
console.log('  src-tauri/tauri.conf.json  : ' + tauriVersion);
console.log('  src-tauri/Cargo.toml       : ' + cargoVersion);

if (!pkgVersion || !tauriVersion || !cargoVersion) {
  fail(['有文件读不到版本号(路径或字段名变了?)。']);
}

const mismatch = [];
if (tauriVersion !== pkgVersion) mismatch.push('src-tauri/tauri.conf.json 是 ' + tauriVersion + ',但 package.json 是 ' + pkgVersion + ' —— 两处要一样');
if (cargoVersion !== pkgVersion) mismatch.push('src-tauri/Cargo.toml 是 ' + cargoVersion + ',但 package.json 是 ' + pkgVersion + ' —— 两处要一样');

/* 推标签触发时,标签名也要对上 */
const ref = process.env.GITHUB_REF || '';
const isTag = ref.startsWith('refs/tags/');
const tag = isTag ? ref.slice('refs/tags/'.length) : '';
if (isTag) {
  const expect = tag.replace(/^v/, '');
  console.log('  标签                       : ' + tag + '  → 期望版本号 ' + expect);
  if (expect !== pkgVersion) {
    mismatch.push('标签 ' + tag + ' 期望版本号 ' + expect + ',但代码里是 ' + pkgVersion + ' —— 把三处版本号改成 ' + expect + ',或者换一个标签');
  }
} else {
  console.log('  (手动触发,只校验三处版本号是否互相一致)');
}

if (mismatch.length) {
  fail(['版本号不一致,已中止发布:'].concat(mismatch.map((m) => '  · ' + m)));
}
console.log('');
console.log('✅ 版本号校验通过');
