#!/usr/bin/env node
/* ============================================================================
 * 版本号与发布文档助手
 *
 * 一次发版要动的地方是分散的:
 *   三个文件里的版本号(package.json / tauri.conf.json / Cargo.toml)必须一致,
 *   标签名又要等于版本号,发布说明的文件名还得和标签名严格对应。
 *   少改一处,流水线会在第一步拦住;但这些约定记起来很累,所以收进一个命令。
 *
 * 用法:
 *   node scripts/bump-version.mjs 1.0.2 | patch | minor | major
 *   --notes       顺便起草发布说明
 *   --notes-only  只起草发布说明,不动版本号
 *   --write       发布说明已存在时也覆盖(默认保留你手改过的内容)
 *   --dry-run     只预览,不写文件
 * ========================================================================== */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const forceWrite = flags.has('--write');
const notesOnly = flags.has('--notes-only');
const wantNotes = flags.has('--notes') || notesOnly;
const target = positional[0];

if (!notesOnly && !target) {
  console.error('用法: node scripts/bump-version.mjs <版本号|patch|minor|major> [--notes] [--write] [--dry-run]');
  process.exit(2);
}

const die = (m) => { console.error('X ' + m); process.exit(1); };
const ok = (m) => console.log('  OK ' + m);

/* 严格校验语义化版本:只接受 x.y.z(可带预发布后缀)。
 * 不用 semver 包:脚本要在 CI 与本地都能跑,少一个依赖少一处风险。 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}
const fmt = (o) => o.major + '.' + o.minor + '.' + o.patch + (o.pre ? '-' + o.pre : '');

const PKG = 'package.json';
const TAURI = 'src-tauri/tauri.conf.json';
const CARGO = 'src-tauri/Cargo.toml';

if (!existsSync(PKG)) die('找不到 package.json —— 请在项目根目录执行');

const pkgText = await readFile(PKG, 'utf8');
const pkg = JSON.parse(pkgText);
const current = pkg.version;
const tauriText = await readFile(TAURI, 'utf8');
const tauriObj = JSON.parse(tauriText);
const cargoText = await readFile(CARGO, 'utf8');

let next = current;
if (!notesOnly) {
  const cur = parseVersion(current) || die('package.json 里的版本号不是 x.y.z 格式: ' + current);
  if (['patch', 'minor', 'major'].includes(target)) {
    const o = { ...cur, pre: '' };
    if (target === 'patch') o.patch += 1;
    else if (target === 'minor') { o.minor += 1; o.patch = 0; }
    else { o.major += 1; o.minor = 0; o.patch = 0; }
    next = fmt(o);
  } else {
    if (!parseVersion(target)) die('版本号格式不对(要 x.y.z): ' + target);
    next = String(target).trim();
  }
  if (next === current) console.log('  ! 目标版本与当前相同(' + current + '),不会产生改动');
}

console.log('');
console.log(notesOnly ? '  只起草发布说明' : '  版本号: ' + current + '  ->  ' + next);
console.log('');

const writes = [];

if (!notesOnly) {
  /* 只替换 version 那一个字段的文本,不做 JSON.parse+stringify 回写 ——
   * 那会重排键、改缩进,让改版本号这种小改动的 diff 变成一坨。 */
  const pkgRe = /("version"\s*:\s*")[^"]+(")/;
  const pkgNext = pkgText.replace(pkgRe, (_, a, b) => a + next + b);
  if (pkgNext === pkgText && current !== next) die('没能在 package.json 里定位到 version 字段');
  writes.push([PKG, pkgNext, current]);

  const tauriNext = tauriText.replace(pkgRe, (_, a, b) => a + next + b);
  if (tauriNext === tauriText && tauriObj.version !== next) die('没能在 tauri.conf.json 里定位到 version 字段');
  writes.push([TAURI, tauriNext, tauriObj.version]);

  /* Cargo.toml 只认 [package] 段里的 version:依赖段里也有 version,全局替换会把依赖版本改坏 */
  const cargoRe = /(^\[package\][^]*?^version\s*=\s*")[^"]+(")/m;
  const cargoNow = (cargoText.match(/^version\s*=\s*"([^"]+)"/m) || [])[1] || '(未知)';
  const cargoNext = cargoText.replace(cargoRe, (_, a, b) => a + next + b);
  if (cargoNext === cargoText && cargoNow !== next) die('没能在 Cargo.toml 的 [package] 段里定位到 version');
  writes.push([CARGO, cargoNext, cargoNow]);
}

for (const [file, content, from] of writes) {
  ok(file + '  ' + from + '  ->  ' + next);
  if (!dryRun) await writeFile(file, content, 'utf8');
}

const tag = 'v' + next;
const notesPath = 'docs/RELEASE_NOTES_' + tag + '.md';

/* 按「类型(范围): 标题」分组,和 CHANGELOG 的写法一致。
 * 分类写死在这里而不是引入提交规范 —— 项目里的提交本来就是这么写的。 */
function classify(subject) {
  const m = /^([a-zA-Z]+)(?:\(([^)]+)\))?!?:\s*(.*)$/.exec(subject);
  const type = m ? m[1].toLowerCase() : '';
  const scope = m ? (m[2] || '') : '';
  const text = m ? m[3] : subject;
  const map = { feat: '新功能', fix: '修复', perf: '性能', refactor: '重构', build: '构建', ci: '持续集成', docs: '文档', style: '样式', test: '测试', chore: '其他' };
  return { group: map[type] || (type ? '其他' : '未分类'), scope, text };
}

function commitsSinceLastTag() {
  try {
    const last = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf8' }).trim();
    const out = execFileSync('git', ['log', last + '..HEAD', '--pretty=format:%s'], { encoding: 'utf8' });
    return { last, list: out.split(String.fromCharCode(10)).filter(Boolean) };
  } catch {
    try {
      const out = execFileSync('git', ['log', '-20', '--pretty=format:%s'], { encoding: 'utf8' });
      return { last: '(无标签)', list: out.split(String.fromCharCode(10)).filter(Boolean) };
    } catch { return { last: '(不是 git 仓库)', list: [] }; }
  }
}

if (wantNotes) {
  const { last, list } = commitsSinceLastTag();
  const groups = new Map();
  for (const s of list) {
    const c = classify(s);
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  const order = ['新功能', '修复', '性能', '重构', '构建', '持续集成', '文档', '样式', '测试', '其他', '未分类'];
  const out = [];
  out.push('# ' + tag);
  out.push('');
  out.push('> 这份文件由 bump-version.mjs 按提交记录起草,发布前请手改成给用户看的话:');
  out.push('> 说清「下载哪个」「这版能不能用」「有什么已知问题」,而不是罗列提交标题。');
  out.push('');
  out.push('## 下载哪个');
  out.push('');
  out.push('| 文件 | 平台 | 说明 |');
  out.push('|---|---|---|');
  out.push('| DeltaForceAnimationEditor-Setup-' + next + '.exe | Windows x64 | 一键安装包(推荐):安装器有进度条,装完启动约 1 秒 |');
  out.push('| DeltaForceAnimationEditor-Portable-' + next + '.exe | Windows x64 | 便携版单文件,每次启动都要先解压到 %TEMP%(慢) |');
  out.push('| DeltaForceAnimationEditor-' + next + '-win-unpacked.zip | Windows x64 | 免安装版,解压即用 |');
  out.push('| dfae-' + next + '-arm64-v8a.apk | Android | release 签名包,下载后直接点开安装 |');
  out.push('');
  out.push('## 这一版改了什么');
  out.push('');
  if (!list.length) {
    out.push('- (没有收集到提交记录,请手写)');
    out.push('');
  } else {
    for (const g of order) {
      const items = groups.get(g);
      if (!items || !items.length) continue;
      out.push('### ' + g);
      out.push('');
      for (const it of items) out.push('- ' + (it.scope ? '[' + it.scope + '] ' : '') + it.text);
      out.push('');
    }
    out.push('> 自上一个标签 ' + last + ' 以来的 ' + list.length + ' 条提交。');
    out.push('');
  }

  const exists = existsSync(notesPath);
  console.log('');
  if (exists && !forceWrite) {
    console.log('  ! ' + notesPath + ' 已存在,保留你写的内容(要覆盖请加 --write)');
  } else {
    ok(notesPath + (exists ? '  (已覆盖)' : '  (已创建,收录 ' + list.length + ' 条提交)'));
    if (!dryRun) {
      await mkdir('docs', { recursive: true });
      await writeFile(notesPath, out.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
    }
  }
}

console.log('');
if (dryRun) { console.log('  (--dry-run:只是预览,没有写入任何文件)'); console.log(''); process.exit(0); }

if (notesOnly) {
  console.log('  下一步:检查 docs/RELEASE_NOTES_' + tag + '.md 的内容,然后照常提交');
  console.log('');
  process.exit(0);
}

console.log('  下一步(复制即用):');
console.log('');
console.log('    git add -A');
console.log('    git commit -m "chore: ' + tag + '"');
console.log('    git push');
console.log('    git tag ' + tag);
console.log('    git push origin ' + tag);
console.log('');
console.log('  推完标签后自动:校版本 -> 双端打包 -> 发 GitHub 发行版 -> 同步到 GitCode');