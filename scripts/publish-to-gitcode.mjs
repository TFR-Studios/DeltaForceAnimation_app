#!/usr/bin/env node
/* ============================================================================
 * 把一次发布的产物同步到 GitCode(把 GitCode 当作 GitHub 的镜像 + 更新源)
 *
 * 为什么要这一步:GitCode 的「仓库镜像」只同步**代码**(分支/标签/提交),
 * 不同步 Release 的附件。而软件的更新检查要靠 GitCode 上的附件下载地址,
 * 所以每次发布都要把安装包也传一份上去。
 *
 * 用法(node ≥ 20):
 *   GITCODE_TOKEN=xxx node scripts/publish-to-gitcode.mjs <tag> <产物目录>
 *
 * 幂等:可以反复跑。同名的附件会先删掉再传,发行版说明会就地更新。
 * ========================================================================== */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const [tag, assetsDir] = process.argv.slice(2);
const token = process.env.GITCODE_TOKEN;
const owner = process.env.GITCODE_OWNER || 'TFR-Studios';
const repo = process.env.GITCODE_REPO || 'DeltaForceAnimation_app';

if (!tag || !assetsDir) { console.error('用法: GITCODE_TOKEN=xxx node scripts/publish-to-gitcode.mjs <tag> <产物目录>'); process.exit(2); }
if (!token) { console.error('缺少环境变量 GITCODE_TOKEN'); process.exit(2); }

const API = 'https://api.gitcode.com/api/v5/repos/' + owner + '/' + repo;
const Q = '?access_token=' + encodeURIComponent(token);
const UA = { 'User-Agent': 'dfae-release/' + tag };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init = {}) {
  const res = await fetch(API + pathname + (pathname.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token), {
    ...init, headers: { ...UA, ...(init.headers || {}) },
  });
  return res;
}

/* 说明文字:优先用 docs/RELEASE_NOTES_<tag>.md,没有就留空 */
const notesFile = path.join('docs', 'RELEASE_NOTES_' + tag + '.md');
const body = existsSync(notesFile) ? await readFile(notesFile, 'utf8') : '';

/* 1) 找发行版;没有就建 */
let release = null;
const got = await api('/releases/tags/' + encodeURIComponent(tag));
if (got.status === 200) {
  release = await got.json();
  console.log('[GitCode] 发行版已存在:', release.tag_name);
} else {
  const created = await api('/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag, body, target_commitish: 'main', prerelease: false }),
  });
  if (created.status >= 400) { console.error('[GitCode] 建发行版失败:', created.status, (await created.text()).slice(0, 300)); process.exit(1); }
  release = await created.json();
  console.log('[GitCode] 发行版已创建:', release.tag_name);
}

/* 2) 说明文字就地更新(失败不致命:附件才是关键) */
if (body) {
  const upd = await api('/releases/' + encodeURIComponent(tag), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: tag, body, prerelease: false }),
  });
  console.log('[GitCode] 更新说明:', upd.status, upd.status >= 400 ? (await upd.text()).slice(0, 200) : 'ok');
}

/* 3) 逐个上传附件:同名先删再传,保证不会出现两份 */
const files = (await readdir(assetsDir)).filter((n) => !n.startsWith('.'));
if (!files.length) { console.error('[GitCode] 产物目录是空的:', assetsDir); process.exit(1); }
let failed = 0;
for (const name of files) {
  const filePath = path.join(assetsDir, name);
  const info = await stat(filePath);
  if (!info.isFile()) continue;
  const bytes = await readFile(filePath);
  console.log('[GitCode] 上传 ' + name + ' (' + (bytes.length / 1048576).toFixed(1) + ' MB)');

  /* 3a) 删掉同名旧附件 */
  const cur = await api('/releases/tags/' + encodeURIComponent(tag));
  if (cur.status === 200) {
    const data = await cur.json();
    for (const a of data.assets || []) {
      if (a.name === name) {
        const del = await api('/releases/' + encodeURIComponent(tag) + '/attach_files/' + a.id, { method: 'DELETE' });
        console.log('        删除同名旧附件 id=' + a.id + ' → ' + del.status);
      }
    }
  }

  /* 3b) 取上传地址并 PUT */
  const urlRes = await api('/releases/' + encodeURIComponent(tag) + '/upload_url?file_name=' + encodeURIComponent(name));
  if (urlRes.status >= 400) { console.error('        取上传地址失败:', urlRes.status, (await urlRes.text()).slice(0, 200)); failed++; continue; }
  const { url, headers } = await urlRes.json();
  const put = await fetch(url, { method: 'PUT', headers, body: bytes });
  const text = (await put.text()).slice(0, 120);
  console.log('        PUT → ' + put.status + ' ' + text);
  if (put.status >= 400) failed++;
  await sleep(1500);
}

/* 4) 复核 */
const final = await api('/releases/tags/' + encodeURIComponent(tag));
if (final.status === 200) {
  const data = await final.json();
  const names = (data.assets || []).map((a) => a.name);
  console.log('[GitCode] 发行版现有附件:');
  for (const n of names) console.log('    - ' + n);
  for (const want of files) {
    if (!names.includes(want)) { console.error('[GitCode] 缺少附件: ' + want); failed++; }
  }
}
process.exit(failed ? 1 : 0);
