#!/usr/bin/env node
/* ============================================================================
 * 三角洲行动动画编辑器 —— 自助命令行工具(中文界面)
 *
 * 为什么用 Node 写而不是 .bat:
 *   cmd.exe 的代码页会撕裂中文,实测 .bat 里写中文会被当成命令执行而报错。
 *   Node 在 Windows 控制台里直接写 UTF-8,中文不会有问题。
 *   所以界面放在这里,外面只留一个不含任何中文的 .bat 启动器。
 *
 * 用法:
 *   node scripts/dfae-cli.mjs            进菜单
 *   node scripts/dfae-cli.mjs commit     直接提交代码
 *   node scripts/dfae-cli.mjs release    直接发布新版本
 *   node scripts/dfae-cli.mjs upload     直接上传安装包
 *   node scripts/dfae-cli.mjs status     直接查发布状态
 * ========================================================================== */
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const REPO = 'TFR-Studios/DeltaForceAnimation_app';
const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);

/* ---------- 颜色(设了 NO_COLOR 就退化纯文本) ---------- */
const USE_COLOR = !process.env.NO_COLOR;
const paint = (code) => (s) => (USE_COLOR ? ESC + '[' + code + 'm' + String(s) + ESC + '[0m' : String(s));
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');
const gray = paint('90');

/* ---------- 输出小工具 ---------- */
const rule = (ch = '─', n = 62) => gray(ch.repeat(n));
const title = (t) => { console.log(''); console.log(bold(cyan('  ' + t))); console.log(rule()); };
const step = (t) => console.log('  ' + cyan('▸') + ' ' + t);
const ok = (t) => console.log('  ' + green('✔') + ' ' + t);
const warn = (t) => console.log('  ' + yellow('!') + ' ' + t);
const bad = (t) => console.log('  ' + red('✘') + ' ' + t);
const info = (t) => console.log('  ' + gray('·') + ' ' + t);
const indent = (t, pad = '    ') => t.split(NL).map((l) => pad + l).join(NL);

/* ---------- 交互 ---------- */
let rl = null;
function reader() {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => { console.log(''); process.exit(130); });
  }
  return rl;
}
function ask(q) {
  return new Promise((resolve) => reader().question(q, (a) => resolve(a)));
}
function closeReader() { if (rl) { rl.close(); rl = null; } }

/* ---------- 跑命令 ---------- */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...opts,
  });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}
const git = (...args) => run('git', args);
const node = (...args) => run(process.execPath, args);

/* ---------- 读仓库状态 ---------- */
function pkgVersion() {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '(读不到)'; }
}
function gitBranch() {
  const r = git('rev-parse', '--abbrev-ref', 'HEAD');
  return r.code === 0 ? r.out : '(未知)';
}
function gitDirty() {
  const r = git('status', '--porcelain');
  if (r.code !== 0) return '(未知)';
  return r.out ? '有 ' + r.out.split(NL).length + ' 处未提交' : '干净';
}
function latestTag() {
  const r = git('describe', '--tags', '--abbrev=0');
  return r.code === 0 ? r.out : '(还没有标签)';
}
function aheadBehind() {
  const r = git('rev-list', '--left-right', '--count', 'origin/main...HEAD');
  if (r.code !== 0) return '';
  const [behind, ahead] = r.out.split(/[ \t]+/).map((x) => parseInt(x, 10) || 0);
  if (!ahead && !behind) return '与 GitHub 一致';
  const bits = [];
  if (ahead) bits.push('领先 ' + ahead + ' 个提交');
  if (behind) bits.push('落后 ' + behind + ' 个提交');
  return bits.join(',');
}

/* ---------- 各个动作 ---------- */

async function actionCommit() {
  title('提交代码');
  const dirty = git('status', '--porcelain');
  if (dirty.code !== 0) { bad('当前目录不是 git 仓库。'); return; }
  if (!dirty.out) { info('没有需要提交的改动,先回去改点东西再回来。'); return; }
  console.log(dim('  本次会提交这些改动:'));
  console.log(indent(dirty.out));
  console.log('');
  const msg = (await ask('  这次改了什么?(必填,一句话说清): ')).trim();
  if (!msg) { warn('没写说明,已取消。'); return; }

  step('git add -A');
  const a = git('add', '-A');
  if (a.code !== 0) { bad('git add 失败:'); console.log(indent(a.out)); return; }

  step('git commit');
  const c = git('commit', '-m', msg);
  if (c.code !== 0) { bad('提交失败(可能是 git 用户名/邮箱没配):'); console.log(indent(c.out)); return; }
  ok('已提交');

  step('git push 到 GitHub');
  const u = git('push');
  if (u.code !== 0) {
    bad('推送失败(网络或凭据问题)。提交已经做好,修好网络后重跑本工具即可。');
    console.log(indent(u.out));
    return;
  }
  ok('已推送到 GitHub');
  console.log('');
  info('GitCode 的代码镜像会自动跟上(有延迟,不是实时的)。');
  info('本次没有打包 —— 要出安装包请选「发布新版本」。');
}

async function actionRelease() {
  title('发布新版本');
  const cur = pkgVersion();
  info('当前版本 ' + bold('v' + cur));
  info('最新标签 ' + latestTag());
  console.log('');
  console.log('  ' + bold('1') + '  补丁版  (' + dim('修 bug,最常用') + ')   ' + cur + ' → 最后一位 +1');
  console.log('  ' + bold('2') + '  次版本  (' + dim('加了新功能') + ')     ' + cur + ' → 中间位 +1,末位归零');
  console.log('  ' + bold('3') + '  大版本  (' + dim('不兼容的大改') + ')   ' + cur + ' → 首位 +1,后两位归零');
  console.log('  ' + bold('4') + '  我自己指定版本号');
  console.log('');
  const ch = (await ask('  选 1-4 后回车: ')).trim();
  let bump = 'patch';
  if (ch === '2') bump = 'minor';
  else if (ch === '3') bump = 'major';
  else if (ch === '4') {
    bump = (await ask('  输入版本号(形如 1.2.3): ')).trim();
    if (!bump) { warn('没输入版本号,已取消。'); return; }
  }

  console.log('');
  console.log(dim('  接下来会自动做这些事:'));
  console.log(dim('    1. 改三个文件的版本号(package.json / tauri.conf.json / Cargo.toml)'));
  console.log(dim('    2. 按提交记录起草发布说明'));
  console.log(dim('    3. 提交 + 推送 + 打标签 + 推标签'));
  console.log(dim('    4. GitHub 云端双端打包(约 10 分钟)并同步到 GitCode'));
  console.log('');
  const go = (await ask('  确认开始?(输入 y 回车开始,直接回车取消): ')).trim().toLowerCase();
  if (go !== 'y') { info('已取消。'); return; }

  step('[1/4] 改版本号 + 起草说明');
  const b = node('scripts/bump-version.mjs', bump, '--notes');
  console.log(indent(b.out));
  if (b.code !== 0) { bad('改版本号失败,已停止。'); return; }

  const next = pkgVersion();
  const tag = 'v' + next;
  const notesFile = path.join(ROOT, 'docs', 'RELEASE_NOTES_' + tag + '.md');

  console.log('');
  info('发布说明在:' + ' docs/RELEASE_NOTES_' + tag + '.md');
  info('建议改写成「给用户看的话」(下载哪个、能不能用、有什么坑)。');
  const ed = (await ask('  现在打开记事本编辑吗?(输入 y 打开,直接回车跳过): ')).trim().toLowerCase();
  if (ed === 'y' && existsSync(notesFile)) {
    closeReader();
    console.log(dim('  (记事本关掉后会自动继续)'));
    spawnSync('notepad', [notesFile], { stdio: 'inherit' });
  }

  step('[2/4] 提交');
  const a2 = git('add', '-A');
  if (a2.code !== 0) { bad('git add 失败'); console.log(indent(a2.out)); return; }
  const c2 = git('commit', '-m', 'chore: ' + tag);
  if (c2.code !== 0) { bad('提交失败:'); console.log(indent(c2.out)); return; }
  ok('已提交 ' + tag);

  step('[3/4] 推送到 GitHub');
  const u2 = git('push');
  if (u2.code !== 0) { bad('推送失败。修好后重跑本工具,或手动 git push。'); console.log(indent(u2.out)); return; }
  ok('已推送');

  step('[4/4] 打标签并推送(这一步触发云端打包)');
  const exists = git('rev-parse', '-q', '--verify', 'refs/tags/' + tag).code === 0;
  const t1 = git('tag', '-f', tag);
  if (t1.code !== 0) { bad('打标签失败:'); console.log(indent(t1.out)); return; }
  const pushArgs = exists ? ['push', '-f', 'origin', tag] : ['push', 'origin', tag];
  if (exists) warn('这个标签之前就存在,会用强制更新覆盖远端。');
  const t2 = git(...pushArgs);
  if (t2.code !== 0) { bad('推标签失败。手动重试: git push -f origin ' + tag); console.log(indent(t2.out)); return; }
  ok('标签 ' + tag + ' 已推送');

  console.log('');
  console.log(rule('═'));
  console.log(bold(green('  发布流程已启动!')));
  console.log(rule('═'));
  console.log('');
  console.log('  GitHub 云端会自动:');
  console.log('    1. 校验版本号是否一致');
  console.log('    2. Windows + Android 双端打包(约 10 分钟)');
  console.log('    3. 建 GitHub 发行版并挂上安装包');
  console.log('    4. 把安装包同步到 GitCode');
  console.log('');
  console.log('  你可以关掉这个窗口,关掉不影响打包。');
  console.log('');
  console.log('  进度: ' + cyan('https://github.com/' + REPO + '/actions'));
  console.log('  结果: ' + cyan('https://github.com/' + REPO + '/releases'));
  console.log('        ' + cyan('https://gitcode.com/' + REPO + '/releases'));
  console.log('');
  const open = (await ask('  现在打开进度页吗?(输入 y 打开): ')).trim().toLowerCase();
  if (open === 'y') {
    spawnSync('cmd', ['/c', 'start', '', 'https://github.com/' + REPO + '/actions'], { stdio: 'ignore' });
  }
}

/* 找出本地已经打好的安装包 */
function localAssets() {
  const found = [];
  const add = (dir, filter) => {
    const full = path.join(ROOT, dir);
    if (!existsSync(full)) return;
    for (const name of readdirSync(full)) {
      const f = path.join(full, name);
      try { if (!statSync(f).isFile()) continue; } catch { continue; }
      if (filter && !filter(name)) continue;
      found.push({ name, file: f, size: statSync(f).size });
    }
  };
  add('release', (n) => n.endsWith('.exe') || n.endsWith('.zip'));
  add(path.join('src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk', 'universal', 'release'), (n) => n.endsWith('.apk'));
  add(path.join('src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk', 'universal', 'debug'), (n) => n.endsWith('.apk'));
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

async function actionUpload() {
  title('上传安装包到 GitCode');
  info('用途:当某个版本只发过 GitHub、GitCode 上还没有安装包时,用这个补上去。');
  console.log('');

  const files = localAssets();
  if (!files.length) {
    warn('本地没找到打好的安装包。');
    info('路径找的是 release\\*.exe / release\\*.zip 和安卓的 build 输出目录。');
    info('先跑一次「构建应用.bat」,或者从 GitHub 的发行版下载下来再传。');
    return;
  }

  console.log(dim('  本地找到这些安装包:'));
  files.forEach((f, i) => {
    console.log('    ' + bold(String(i + 1)) + '  ' + f.name + '  ' + gray('(' + mb(f.size) + ')'));
  });
  console.log('');
  const pick = (await ask('  传哪些?(输入编号,多个用逗号隔开;直接回车 = 全部): ')).trim();
  let chosen = files;
  if (pick) {
    chosen = pick.split(',').map((x) => files[parseInt(x, 10) - 1]).filter(Boolean);
    if (!chosen.length) { warn('没选中任何文件,已取消。'); return; }
  }

  const tag = (await ask('  传到哪个版本?(回车 = ' + latestTag() + '): ')).trim() || latestTag();
  if (tag.startsWith('(')) { warn('还没有标签可用,请先发布一个版本。'); return; }

  let token = process.env.GITCODE_TOKEN || '';
  if (!token) {
    info('需要一个 GitCode 访问令牌(GitCode 右上角头像 → 设置 → 访问令牌)。');
    info('建议设成环境变量 GITCODE_TOKEN,这样以后不用每次输入。');
    token = (await ask('  粘贴令牌(输入的内容会显示在屏幕上): ')).trim();
  }
  if (!token) { warn('没有令牌,已取消。'); return; }

  console.log('');
  console.log(dim('  将上传到 GitCode 的 ' + tag + ' 发行版:'));
  for (const f of chosen) console.log(dim('    · ' + f.name + '  ' + mb(f.size)));
  console.log('');
  const go = (await ask('  确认?(输入 y 回车开始): ')).trim().toLowerCase();
  if (go !== 'y') { info('已取消。'); return; }

  /* 复制到临时目录,再交给已有的发布脚本 —— 复用同一套上传逻辑,避免两份实现 */
  const tmp = mkdtempSync(path.join(tmpdir(), 'dfae-upload-'));
  try {
    for (const f of chosen) copyFileSync(f.file, path.join(tmp, f.name));
    step('上传中...');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'publish-to-gitcode.mjs'), tag, tmp], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, GITCODE_TOKEN: token },
    });
    if (r.status === 0) {
      console.log('');
      ok('上传完成');
      info('下载页: https://gitcode.com/' + REPO + '/releases');
    } else {
      console.log('');
      bad('上传失败(退出码 ' + r.status + ')。看上面的输出定位原因。');
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/* 对比两边的发行版附件 */
async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'dfae-cli', Accept: 'application/vnd.github+json' } });
    if (!r.ok) return { error: 'HTTP ' + r.status };
    return { data: await r.json() };
  } catch (e) { return { error: '连不上:' + String(e.message || e).slice(0, 60) }; }
}

async function actionStatus() {
  title('检查发布状态');
  const tag = (await ask('  查哪个版本?(回车 = ' + latestTag() + '): ')).trim() || latestTag();
  if (tag.startsWith('(')) { warn('还没有标签。'); return; }
  console.log('');
  step('查询 GitHub ...');
  const gh = await fetchJson('https://api.github.com/repos/' + REPO + '/releases/tags/' + tag);
  step('查询 GitCode ...');
  const gc = await fetchJson('https://api.gitcode.com/api/v5/repos/' + REPO + '/releases/tags/' + tag);

  const ghNames = gh.data ? (gh.data.assets || []).map((a) => a.name) : [];
  const gcNames = gc.data ? (gc.data.assets || []).map((a) => a.name) : [];
  const ghErr = gh.error;
  const gcErr = gc.error;

  const ghReal = ghNames.filter((n) => !n.endsWith('.zip') || n.includes('win-unpacked'));
  const gcReal = gcNames.filter((n) => !/^v[0-9]/.test(n));

  console.log('  ' + bold('GitHub') + '   ' + (ghErr ? red(ghErr) : green(ghReal.length + ' 个安装包')));
  for (const n of ghReal) console.log('      ' + green('✔') + ' ' + n);
  console.log('');
  console.log('  ' + bold('GitCode') + ' ' + (gcErr ? red(gcErr) : green(gcReal.length + ' 个安装包')));
  for (const n of gcReal) console.log('      ' + green('✔') + ' ' + n);
  console.log('');

  const missing = ghReal.filter((n) => !gcReal.includes(n));
  if (!ghErr && !gcErr) {
    if (!missing.length && ghReal.length) {
      ok('两边的安装包一致。');
    } else if (missing.length) {
      warn('GitCode 上缺少这些:');
      for (const n of missing) console.log('      ' + red('✘') + ' ' + n);
      console.log('');
      info('可以用菜单里的「上传安装包到 GitCode」补上去。');
    }
  }
  console.log('');
  console.log('  GitHub : ' + cyan('https://github.com/' + REPO + '/releases/tag/' + tag));
  console.log('  GitCode: ' + cyan('https://gitcode.com/' + REPO + '/releases'));
}

/* ---------- 菜单 ---------- */
function header() {
  console.log('');
  console.log(rule('═'));
  console.log('  ' + bold('三角洲行动动画编辑器') + '  ' + gray('·  自助工具'));
  console.log(rule('═'));
  const v = pkgVersion();
  const b = gitBranch();
  const d = gitDirty();
  const t = latestTag();
  const ab = aheadBehind();
  console.log('  版本 ' + bold('v' + v) + '   分支 ' + bold(b) + '   改动 ' + (d === '干净' ? green(d) : yellow(d)));
  console.log('  最新标签 ' + bold(t) + (ab ? '   ' + gray(ab) : ''));
  console.log('');
}

const MENU = [
  ['1', '提交代码', '把改动提交并推送到 GitHub(不含打包)', actionCommit],
  ['2', '发布新版本', '改版本号 → 起草说明 → 提交 → 打标签 → 云端自动打包发布', actionRelease],
  ['3', '上传安装包到 GitCode', '把本地打好的包补传到某个版本的发行版', actionUpload],
  ['4', '检查发布状态', '对比 GitHub 与 GitCode 两边的安装包', actionStatus],
];

function drawMenu() {
  MENU.forEach(([key, name, desc]) => {
    console.log('  ' + bold(cyan(key)) + '  ' + bold(name));
    console.log('     ' + gray(desc));
    console.log('');
  });
  console.log('  ' + bold(cyan('0')) + '  退出');
  console.log('');
}

async function menu() {
  while (true) {
    header();
    drawMenu();
    const raw = (await ask('  请输入编号后回车 › ')).trim();
    console.log('');
    if (raw === '0' || raw.toLowerCase() === 'q') break;
    const item = MENU.find(([k]) => k === raw);
    if (!item) { warn('没有这个选项,请输入 0-' + MENU.length + ' 之间的数字。'); continue; }
    try {
      await item[3]();
    } catch (e) {
      bad('出错了:' + String(e.message || e));
    }
    console.log('');
    await ask(gray('  按回车回到菜单 › '));
  }
  closeReader();
  console.log('');
  console.log(gray('  再见。'));
  console.log('');
}

/* ---------- 入口 ---------- */
const cmd = (process.argv[2] || '').toLowerCase();
const direct = {
  commit: actionCommit,
  release: actionRelease,
  upload: actionUpload,
  status: actionStatus,
};

if (!existsSync(path.join(ROOT, 'package.json'))) {
  console.log('');
  bad('这里不是项目目录 —— 请从项目根目录运行(或者用项目里的 .bat 启动器)。');
  console.log('');
  process.exit(1);
}

if (direct[cmd]) {
  direct[cmd]().then(() => { closeReader(); console.log(''); });
} else {
  menu();
}
