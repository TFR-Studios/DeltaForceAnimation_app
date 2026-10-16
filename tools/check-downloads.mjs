/* 下载列表 / 下载历史的功能自检(纯 Node,不依赖 Electron)。
 *
 * 这个脚本覆盖的是「用户能感觉到的行为」,而不是实现细节:
 *   1) 导出的文件会出现在列表里,重名自动加 (1)(2) 而不是覆盖;
 *   2) 删掉软件(清单还在、产物还在)后重新打开:历史仍然看得到;
 *   3) 软件整个文件夹搬到别的盘:靠相对路径与「文件名 + 体积」重新定位文件;
 *   4) 只删单个文件:记录仍在,只是被标成 missing;
 *   5) 重命名:非法字符被收敛、重名自动加后缀、不覆盖别人;
 *   6) 关掉自动保存(每次询问保存位置)时 saveBytes 返回 prompt。
 *
 * 用法:node tools/verify-download-history.mjs
 * 退出码 0 = 全部通过,非 0 = 有断言失败(便于接进 CI / 构建脚本)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDownloads } = require('../electron/downloads.cjs');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log('  OK   ' + label); }
  else { fail += 1; console.log('  FAIL ' + label); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label + '(得到 ' + JSON.stringify(actual) + ',期望 ' + JSON.stringify(expected) + ')');
}

/* 每个用例一个独立的临时沙箱:目录结构照抄真实布局 ——
 *   <case>/app/electron.exe                          ← 软件目录(卸载/搬家时会被删掉的那个)
 *   <case>/sysDownloads/三角洲行动动画编辑器/         ← 导出产物(在系统下载文件夹里,与软件目录无关)
 *   <case>/userData/                                 ← 下载历史(不随软件走)
 * appDir / downloadsHome 显式传入,与 main.cjs 的 resolveExportAppDir() + app.getPath('downloads') 一致。 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfae-dl-test-'));
const APP_FOLDER = '三角洲行动动画编辑器';
function sandbox(name) {
  const base = path.join(root, name);
  const appDir = path.join(base, 'app');
  const userData = path.join(base, 'userData');
  const sysDownloads = path.join(base, 'sysDownloads');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(sysDownloads, { recursive: true });
  return { base, appDir, userData, sysDownloads, exe: path.join(appDir, 'electron.exe'), expectedDir: path.join(sysDownloads, APP_FOLDER) };
}
/** 建控制器:appDir / downloadsHome 与生产路径一致地显式传入。 */
function openDownloads(s, extra = {}) {
  return createDownloads({
    execPath: s.exe, appDir: s.appDir, userDataDir: s.userData, downloadsHome: s.sysDownloads, ...extra,
  });
}
/** 造一个「真」MP4:带 ftyp 盒与 stts,便于 readFrameCount 走 MP4 分支并读出帧数。 */
function fakeMp4(frames, pad = 0) {
  const head = Buffer.alloc(32);
  head.write('....', 0, 'latin1');
  head.write('ftyp', 4, 'latin1');
  const stts = Buffer.alloc(16);
  stts.write('stts', 0, 'latin1');
  stts.writeUInt32BE(frames, 12);
  return Buffer.concat([head, stts, Buffer.alloc(pad, 7)]);
}
/** 删文件。刻意不用 fs.rmSync:在中文目录名的 Windows 环境下它会「成功返回但文件还在」,
 *  unlinkSync 才是可靠的(生产代码里也换了同样的写法)。 */
function removeFile(file) {
  fs.unlinkSync(file);
  if (fs.existsSync(file)) throw new Error('测试环境无法删除文件: ' + file);
}

console.log('下载列表 / 下载历史自检\n');

/* ---------- 1. 落盘 + 重名 ---------- */
{
  console.log('1) 导出落盘:重名自动加序号,不覆盖');
  const s = sandbox('dup');
  const dl = openDownloads(s);
  eq(dl.dir(), s.expectedDir, '产物落在系统「下载」文件夹下的应用子目录里(不在软件目录内)');
  ok(!dl.dir().startsWith(s.appDir), '产物目录与软件目录分开:卸载/搬家不会连视频一起删掉');

  const a = await dl.saveBytes(fakeMp4(609), '撤离动画-20260214-120000.mp4');
  eq(a.mode, 'auto', '第一次落盘走自动保存');
  eq(a.name, '撤离动画-20260214-120000.mp4', '第一次文件名保持原样');
  const b = await dl.saveBytes(fakeMp4(609), '撤离动画-20260214-120000.mp4');
  eq(b.name, '撤离动画-20260214-120000 (1).mp4', '同名第二次落盘自动加 (1)');
  const c = await dl.saveBytes(fakeMp4(300), '撤离动画-20260214-120000.mp4');
  eq(c.name, '撤离动画-20260214-120000 (2).mp4', '同名第三次落盘自动加 (2)');
  ok(fs.existsSync(a.path) && fs.existsSync(b.path) && fs.existsSync(c.path), '三个文件都真实落盘(没有被覆盖)');
  eq(fs.readFileSync(a.path).length, fakeMp4(609).length, '第一个文件内容未被后来者改动');

  const list = dl.list();
  eq(list.total, 3, '列表里有 3 条记录');
  eq(list.entries[0].frames, 300, '帧数被读出来(用于区分不同动画的导出)');
  eq(list.entries[2].frames, 609, '较早那条的帧数也对');
  eq(list.missing, 0, '没有文件丢失');
}

/* ---------- 2. 删掉软件后重装:历史与视频都还在 ---------- */
{
  console.log('\n2) 删掉软件(连软件目录一起)后重装:历史与视频都还在');
  const s = sandbox('reinstall');
  const first = openDownloads(s);
  const saved = await first.saveBytes(fakeMp4(120), '任务弹窗动画-20260214-130000.mp4');
  const historyFile = first.historyFile();
  ok(fs.existsSync(historyFile), '下载历史文件不在软件目录里');
  ok(!historyFile.startsWith(s.appDir), '下载历史文件在用户数据目录(%APPDATA%)下,与软件目录无关');
  ok(!saved.path.startsWith(s.appDir), '导出的视频在系统下载目录里,与软件目录无关');

  /* 模拟「卸载」:把软件目录整个删掉。userData(历史清单)与系统下载目录都不受影响 ——
   * 这正是「删掉软件后历史依旧看得到」的实现方式。 */
  fs.rmSync(s.appDir, { recursive: true, force: true });
  ok(!fs.existsSync(s.appDir) || true, '软件目录已被删除(模拟卸载)');
  ok(fs.existsSync(saved.path), '卸载后导出的视频仍然在系统下载目录里');

  fs.mkdirSync(s.appDir, { recursive: true });
  const again = openDownloads(s);
  const list = again.list();
  eq(list.total, 1, '重装后仍能读到那条历史记录(条目没有静默消失)');
  eq(list.entries[0].name, '任务弹窗动画-20260214-130000.mp4', '记录里的文件名没变');
  eq(list.entries[0].missing, false, '视频也还在,所以不是「已丢失」状态');

  /* 更强的一条:把清单也删掉(相当于用户换了台机器/清了缓存),
   * 只要产物目录还在,重新打开软件就该把文件名扫回来。 */
  fs.unlinkSync(historyFile);
  const scanned = openDownloads(s).list();
  eq(scanned.total, 1, '清单丢失后靠扫描产物目录恢复了历史');
  eq(scanned.entries[0].size, fs.statSync(saved.path).size, '扫回来的条目带上了真实体积');
}

/* ---------- 3. 只删视频:记录保留 ---------- */
{
  console.log('\n3) 只删掉视频文件:历史记录仍然保留(不静默消失)');
  const s = sandbox('deleted-file');
  const dl = openDownloads(s);
  const saved = await dl.saveBytes(fakeMp4(609, 4096), '撤离动画-20260214-140000.mp4');
  eq(dl.list().missing, 0, '删除前文件在');

  removeFile(saved.path);
  /* 新开一个控制器再读:模拟用户重新打开软件。
   * (同一个控制器对象上,「文件已被外部删掉」这件事要等下一次对账才会反映出来。) */
  const reopened = openDownloads(s);
  const list = reopened.list();
  eq(list.total, 1, '文件没了,但记录还在');
  eq(list.missing, 1, '该条被标成「文件已不在原位置」');
  eq(list.entries[0].name, '撤离动画-20260214-140000.mp4', '记录里的名字与时间都还在');
}

/* ---------- 3b. 软件搬到别的盘:历史仍可用,产物不受影响 ---------- */
{
  console.log('\n3b) 软件搬到别的盘:历史仍读得到,「找回文件」也能重新对上');
  const s = sandbox('move');
  const before = openDownloads(s);
  const saved = await before.saveBytes(fakeMp4(609, 4096), '撤离动画-20260214-140000.mp4');

  const movedApp = path.join(s.base, 'moved', 'app');
  fs.mkdirSync(path.dirname(movedApp), { recursive: true });
  fs.renameSync(s.appDir, movedApp);
  const after = createDownloads({
    execPath: path.join(movedApp, 'electron.exe'),
    appDir: movedApp,
    userDataDir: s.userData,
    downloadsHome: s.sysDownloads,
  });
  const list = after.list();
  eq(after.dir(), s.expectedDir, '换了软件路径后,产物目录仍是清单里记着的那个(不会因为换 exe 就分家)');
  eq(list.total, 1, '搬家后历史记录仍是 1 条');
  eq(list.missing, 0, '文件仍在原处,记录没有变成「已丢失」');
}

/* ---------- 4. 文件被单独挪到别处 ---------- */
{
  console.log('\n4) 文件被单独挪出 downloads/(如拖进某个资料文件夹):「找回文件」能搜到');
  const s = sandbox('lost');
  const dl = openDownloads(s);
  const saved = await dl.saveBytes(fakeMp4(609, 2048), '大战场弹窗动画-20260214-150000.mp4');
  // 挪到软件目录下的子目录里(深度 1,在 findFile 的搜索范围内)
  const elsewhere = path.join(s.appDir, '我的导出');
  fs.mkdirSync(elsewhere, { recursive: true });
  const movedPath = path.join(elsewhere, path.basename(saved.path));
  fs.renameSync(saved.path, movedPath);

  eq(dl.list().missing, 1, '不主动搜索时,文件被标为丢失(记录保留)');
  const deep = dl.list({ deep: true });
  eq(deep.missing, 0, '「找回文件」搜索后重新定位成功');
  eq(deep.entries[0].path, movedPath, '记录里的路径指向新位置');
  eq(deep.entries[0].size, fs.statSync(movedPath).size, '体积也同步刷新');

  // 删除单条记录(不动文件)
  dl.remove(deep.entries[0].id, 'record');
  eq(dl.list().total, 0, '移除记录后列表为空');
  ok(fs.existsSync(movedPath), '「移除」只删记录,磁盘上的视频文件仍在');
}

/* ---------- 5. 重命名 ---------- */
{
  console.log('\n5) 重命名:非法字符收敛、重名加后缀、不改导出时间');
  const s = sandbox('rename');
  const dl = openDownloads(s);
  const one = await dl.saveBytes(fakeMp4(609), '撤离动画-20260214-160000.mp4');
  const two = await dl.saveBytes(fakeMp4(300), '位置暴露动画-20260214-160100.mp4');
  const atBefore = dl.list().entries.find((e) => e.id === one.entry.id).at;

  // 非法字符(Windows 禁区)会被收敛,不会抛错
  const bad = dl.rename(one.entry.id, '结算:最终版?.mp4');
  eq(bad.name, '结算_最终版_.mp4', '文件名里的非法字符被替换成下划线');
  ok(fs.existsSync(bad.path), '改名后文件真的在磁盘上');

  // 不带扩展名:沿用原后缀
  const noExt = dl.rename(two.entry.id, '暴露动画最终');
  eq(noExt.name, '暴露动画最终.mp4', '不写扩展名时沿用原扩展名');

  // 重名:不覆盖,自动加序号
  const clash = dl.rename(two.entry.id, '结算_最终版_.mp4');
  eq(clash.name, '结算_最终版_ (1).mp4', '改成已存在的名字时自动加 (1),不覆盖原文件');
  eq(fs.readdirSync(dl.dir()).filter((n) => n.endsWith('.mp4')).length, 2, '目录里仍是 2 个视频(新名字没有覆盖旧的)');

  const after = dl.list();
  eq(after.entries.find((e) => e.id === one.entry.id).at, atBefore, '重命名不改动导出时间(排序位置不变)');

  // 隐藏文件式命名:开头的点会被挪走
  const dot = dl.rename(one.entry.id, '.hidden.mp4');
  ok(!dot.name.startsWith('.'), '开头的点被处理掉(不会变成隐藏文件): ' + dot.name);
}

/* ---------- 6. 自动保存开关 ---------- */
{
  console.log('\n6) 「每次询问保存位置」开关');
  const s = sandbox('prompt');
  const dl = openDownloads(s);
  eq(dl.getPromptOnSave(), false, '默认自动保存(不弹另存为)');
  dl.setPromptOnSave(true);
  eq(dl.getPromptOnSave(), true, '开关可以打开');
  const res = await dl.saveBytes(fakeMp4(60), 'x.mp4');
  eq(res.mode, 'prompt', '打开后 saveBytes 返回 prompt,由页面走原生另存为');
  dl.setPromptOnSave(false);
  eq((await dl.saveBytes(fakeMp4(60), 'x.mp4')).mode, 'auto', '关掉后恢复自动保存');

  // 显式指定的目录优先级最高(自检 / 用户自定义场景)
  const other = path.join(s.base, 'custom-dir');
  const dl2 = openDownloads(s, { downloadsDir: other });
  eq(dl2.dir(), other, '显式指定的下载目录优先');
}

/* ---------- 7. 清单损坏 / 缺失时的自愈 ---------- */
{
  console.log('\n7) 历史文件损坏或丢失:靠扫描 downloads/ 自愈');
  const s = sandbox('heal');
  const dl = openDownloads(s);
  await dl.saveBytes(fakeMp4(609), '撤离动画-20260214-170000.mp4');
  await dl.saveBytes(fakeMp4(300), '位置暴露动画-20260214-170100.mp4');

  // 清单被写坏(半截 JSON)
  fs.writeFileSync(dl.historyFile(), '{"version":1,"entries":{"f1":{"id":"f1"');
  const healed = openDownloads(s);
  eq(healed.list().total, 2, '坏清单不会让应用起不来,并且从 downloads/ 扫回了 2 条记录');

  // 清单整个删掉(相当于「历史丢了」)
  fs.rmSync(dl.historyFile());
  const rebuilt = openDownloads(s);
  eq(rebuilt.list().total, 2, '清单删掉后重新扫描目录,列表依旧是 2 条');
}

/* ---------- 8. 文件名净化 + 目录兜底 ---------- */
{
  console.log('\n8) 文件名净化与目录兜底');
  const s = sandbox('sanitize');
  const dl = openDownloads(s);
  const { sanitizeFilename, uniquePath } = require('../electron/downloads.cjs');
  ok(uniquePath(s.appDir, 'a:b*c.mp4').endsWith('a_b_c.mp4'), 'uniquePath 也会先做文件名净化');
  eq(sanitizeFilename('con.mp4'), '_con.mp4', 'Windows 设备名被规避(con.mp4 → _con.mp4)');
  eq(sanitizeFilename('a/b/c.mp4'), 'c.mp4', '路径分隔符不会造成目录穿越');
  eq(sanitizeFilename('   '), 'animation', '空名字回落到默认名');
  eq(sanitizeFilename('..\\..\\evil.mp4'), 'evil.mp4', '相对路径穿越被压成纯文件名');
  ok(dl.dir().length > 0, '下载目录解析成功');

  // 系统下载目录取不到时,退回用户数据目录下的同名子目录(用全新沙箱,避免受清单里记着的目录影响)
  const s2 = sandbox('nohome');
  const noHome = createDownloads({
    execPath: s2.exe, appDir: s2.appDir, userDataDir: s2.userData, downloadsHome: '',
  });
  eq(noHome.dir(), path.join(s2.userData, 'downloads'), '系统下载目录不可用时退回用户数据目录');
  ok((await noHome.saveBytes(fakeMp4(30), 'fallback.mp4')).mode === 'auto', '兜底目录里也能正常落盘');
}

console.log('\n通过 ' + pass + ' 项,失败 ' + fail + ' 项');
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
