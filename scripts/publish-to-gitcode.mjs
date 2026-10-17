#!/usr/bin/env node
/* ============================================================================
 * 把一次发布的产物同步到 GitCode(把 GitCode 当作 GitHub 的镜像 + 更新源)
 *
 * 为什么要这一步:GitCode 的「仓库镜像」只同步**代码**(分支/标签/提交),
 * 不同步 Release 的附件。而软件的更新检查要靠 GitCode 上的附件下载地址,
 * 所以每次发布都要把安装包也传一份上去。
 *
 * 用法(node ≥ 20):
 *   GITCODE_TOKEN=xxx node scripts/publish-to-gitcode.mjs <tag> <产物目录> [说明文件]
 *
 * 说明文件的默认值是 docs/RELEASE_NOTES_<tag>.md;也可以用环境变量
 * RELEASE_NOTES_FILE 指定(补同步旧版本时很有用)。
 *
 * 幂等:可以反复跑。同名的附件会先删掉再传,发行版说明会就地更新。
 * 退出码非 0 表示确实有附件没同步成功 —— CI 里不要再把它当“可忽略的警告”。
 * ========================================================================== */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const [tag, assetsDir, notesArg] = process.argv.slice(2);
const token = process.env.GITCODE_TOKEN;
const owner = process.env.GITCODE_OWNER || 'TFR-Studios';
const repo = process.env.GITCODE_REPO || 'DeltaForceAnimation_app';

if (!tag || !assetsDir) { console.error('用法: GITCODE_TOKEN=xxx node scripts/publish-to-gitcode.mjs <tag> <产物目录> [说明文件]'); process.exit(2); }
if (!token) { console.error('缺少环境变量 GITCODE_TOKEN(到 GitCode → 设置 → 访问令牌 生成)'); process.exit(2); }

const API = 'https://api.gitcode.com/api/v5/repos/' + owner + '/' + repo;
const UA = { 'User-Agent': 'dfae-release/' + tag, Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init = {}) {
  const sep = pathname.includes('?') ? '&' : '?';
  const url = API + pathname + sep + 'access_token=' + encodeURIComponent(token);
  const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
  return res;
}

/* 5xx / 网络抖动重试几次;4xx 不重试(重试也不会变好) */
async function apiRetry(pathname, init = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await api(pathname, init);
      if (res.status < 500) return res;
      last = res;
    } catch (e) {
      last = e;
    }
    await sleep(1500 * (i + 1));
  }
  if (last instanceof Error) throw last;
  return last;
}

function notesFile() {
  if (notesArg) return notesArg;
  if (process.env.RELEASE_NOTES_FILE) return process.env.RELEASE_NOTES_FILE;
  return path.join('docs', 'RELEASE_NOTES_' + tag + '.md');
}

/* 说明文字:优先用发布说明文件,没有就留空 */
const nf = notesFile();
const body = existsSync(nf) ? await readFile(nf, 'utf8') : '';
if (body) console.log('[GitCode] 使用说明文件:', nf);
else console.log('[GitCode] 没有找到说明文件(' + nf + '),发行版说明留空');

/* 1) 找发行版;没有就建。
 * 新建时 GitCode 要求 tag 已经在镜像里 —— 代码镜像有延迟,所以对 404 做几次等待。 */
let release = null;
let got = await apiRetry('/releases/tags/' + encodeURIComponent(tag));
if (got.status === 200) {
  release = await got.json();
  console.log('[GitCode] 发行版已存在:', release.tag_name);
} else if (got.status === 404) {
  let created = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    created = await apiRetry('/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: tag, body, target_commitish: 'main', prerelease: false }),
    });
    if (created.status < 400) break;
    const text = (await created.text()).slice(0, 300);
    /* 标签还没被镜像过来时 GitCode 通常回 404;等 10s 再试 */
    if (created.status === 404 && attempt < 6) {
      console.log('[GitCode] 标签 ' + tag + ' 还没镜像过来,10 秒后重试(' + attempt + '/6)...');
      await sleep(10000);
      continue;
    }
    console.error('[GitCode] 建发行版失败:', created.status, text);
    process.exit(1);
  }
  release = await created.json();
  console.log('[GitCode] 发行版已创建:', release.tag_name);
} else {
  console.error('[GitCode] 查询发行版失败:', got.status, (await got.text()).slice(0, 300));
  process.exit(1);
}

/* 2) 说明文字就地更新(失败不致命:附件才是关键,但要把状态打出来) */
if (body) {
  const upd = await apiRetry('/releases/' + encodeURIComponent(tag), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: tag, body, prerelease: false }),
  });
  console.log('[GitCode] 更新说明:', upd.status, upd.status >= 400 ? (await upd.text()).slice(0, 200) : 'ok');
}

/* 3) 逐个上传附件:同名先删再传,保证不会出现两份 */
const files = (await readdir(assetsDir)).filter((n) => !n.startsWith('.') && !n.endsWith('.blockmap'));
if (!files.length) { console.error('[GitCode] 产物目录是空的:', assetsDir); process.exit(1); }
let failed = 0;
for (const name of files) {
  const filePath = path.join(assetsDir, name);
  const info = await stat(filePath);
  if (!info.isFile()) continue;
  const bytes = await readFile(filePath);
  console.log('[GitCode] 上传 ' + name + ' (' + (bytes.length / 1048576).toFixed(1) + ' MB)');

  /* 3a) 删掉同名旧附件(先取一次当前列表,避免用过期数据) */
  const cur = await apiRetry('/releases/tags/' + encodeURIComponent(tag));
  if (cur.status === 200) {
    const data = await cur.json();
    for (const a of data.assets || []) {
      if (a.name === name) {
        const id = a.id ?? a.attach_file_id;
        if (id == null) { console.log('        旧附件没有 id,跳过删除:', name); continue; }
        const del = await apiRetry('/releases/' + encodeURIComponent(tag) + '/attach_files/' + id, { method: 'DELETE' });
        console.log('        删除同名旧附件 id=' + id + ' → ' + del.status);
      }
    }
  }

  /* 3b) 取上传地址并 PUT */
  const urlRes = await apiRetry('/releases/' + encodeURIComponent(tag) + '/upload_url?file_name=' + encodeURIComponent(name));
  if (urlRes.status >= 400) { console.error('        取上传地址失败:', urlRes.status, (await urlRes.text()).slice(0, 200)); failed++; continue; }
  const { url, headers } = await urlRes.json();
  const put = await fetch(url, { method: 'PUT', headers, body: bytes });
  const text = (await put.text()).slice(0, 120);
  console.log('        PUT → ' + put.status + ' ' + text);
  if (put.status >= 400) failed++;
  await sleep(1500);
}

/* 4) 复核:GitCode 的附件列表有延迟,重试几次再下结论 */
let names = null;
for (let i = 0; i < 8; i++) {
  const final = await apiRetry('/releases/tags/' + encodeURIComponent(tag));
  if (final.status === 200) {
    const data = await final.json();
    names = (data.assets || []).map((a) => a.name);
    if (files.every((want) => names.includes(want))) break;
  } else if (final.status === 404) {
    names = null;
  }
  await sleep(3000);
}
if (names === null) {
  console.error('[GitCode] 复核失败:发行版 ' + tag + ' 在 GitCode 上仍然不存在');
  process.exit(1);
}
console.log('[GitCode] 发行版现有附件:');
for (const n of names) console.log('    - ' + n);
for (const want of files) {
  if (!names.includes(want)) { console.error('[GitCode] 缺少附件: ' + want); failed++; }
}
if (failed) {
  console.error('[GitCode] 同步未完成:失败 ' + failed + ' 项。修好后可重跑本脚本(幂等)。');
} else {
  console.log('[GitCode] ✅ 全部附件已同步');
}
process.exit(failed ? 1 : 0);
