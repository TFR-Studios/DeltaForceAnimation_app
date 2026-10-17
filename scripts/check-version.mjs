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
 * 另外还会检查 docs/RELEASE_NOTES_v<当前版本>.md:
 *   发行说明里的安装包文件名必须写当前版本。之前 v1.0.2 的说明整段照抄了 v1.0.1,
 *   结果 GitHub 发行版页面上给的下载文件名根本不存在 —— 这类错误现在会直接拦住。
 *
 * 手动跑: GITHUB_REF=refs/tags/v1.0.2 node scripts/check-version.mjs
 * ========================================================================== */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

function fail(lines) {
  console.error('');
  for (const l of lines) console.error('❌ ' + l);
  console.error('');
  process.exit(1);
}

/* 从一段文字里抓出「安装包文件名里的版本号」。
 * 只认本项目的产物命名,避免把 “Android 7.0+”“10.155 s” 这类数字误判成版本。 */
function artifactVersions(text) {
  const found = new Set();
  const patterns = [
    /DeltaForceAnimationEditor-(?:Portable-|Setup-)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:-x64)?(?:-win-unpacked\.zip|\.exe)/g,
    /dfae-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-arm64/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) found.add(m[1]);
  }
  return found;
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

/* 发行说明里的安装包文件名必须写当前版本 */
const notesPath = 'docs/RELEASE_NOTES_v' + pkgVersion + '.md';
if (existsSync(notesPath)) {
  console.log('  发行说明                   : ' + notesPath);
  const bad = [...artifactVersions(await readFile(notesPath, 'utf8'))].filter((v) => v !== pkgVersion);
  if (bad.length) {
    mismatch.push(notesPath + ' 里的安装包文件名写的是 ' + bad.join(' / ') + ',当前版本是 ' + pkgVersion + ' —— 用户照着说明会下到 404 的文件');
  }
}

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

/* 文档里的旧版本示例不阻止发布,但要让维护者看见 —— 它们正是“文档和产物对不上”的来源 */
const staleDocs = [];
for (const doc of ['README.md', 'docs/FEATURES.md']) {
  if (!existsSync(doc)) continue;
  const bad = [...artifactVersions(await readFile(doc, 'utf8'))].filter((v) => v !== pkgVersion);
  if (bad.length) staleDocs.push(doc + ' 里还有 ' + bad.join(' / ') + ' 的示例文件名');
}
if (staleDocs.length) {
  console.warn('');
  console.warn('⚠ 以下文档还在用旧版本号举例(不阻止发布,但建议同步):');
  for (const w of staleDocs) console.warn('   · ' + w);
}

console.log('');
console.log('✅ 版本号校验通过');
