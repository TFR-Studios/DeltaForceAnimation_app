#!/usr/bin/env node
/* ============================================================================
 * 把一次发布的产物同步到 GitCode 的仓库(代码 + 发行版在同一个普通仓库)。
 *
 * 历史注意:GitCode 原来的镜像仓库不允许创建新标签,给新版本建发行版会报
 * “this operation is not allowed because the repository is an image repository”。
 * 那个镜像仓库已经删除;现在的 TFR-Studios/DeltaForceAnimation_app 是普通仓库,
 * 代码由 GitHub Actions / 管理工具推过去,发行版由本脚本创建。
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
import http from 'node:http';
import https from 'node:https';

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

/* 大文件上传不要用 fetch:undici 默认 5 分钟收不到响应头就抛 HeadersTimeoutError,
 * 132 MB 的安装包从 GitHub Actions 传到 GitCode 正好会踩到(2026-10-17 的 v1.0.2 补同步就失败在这里)。
 * Node 的 http/https 客户端默认不设超时,这里只加一个 30 分钟的兜底。 */
/* 已经传过的附件不重复传:GitCode 的附件列表没有文件大小。
 * 不能用 HEAD(GitCode 对 HEAD 返回 401),改用 Range: bytes=0-0 的 GET,
 * 从 Content-Range 里读总大小 —— 只下 1 个字节,几秒钟就能判断。
 * 这样补同步/重跑工作流时不会再把 100+ MB 的包传一遍,也不会在上传失败前先删掉旧包。 */
async function remoteSize(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { Range: 'bytes=0-0', 'User-Agent': 'dfae-release' },
    });
    if (res.status === 206) {
      const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      if (res.body) await res.body.cancel().catch(() => {});
      return total ? Number(total[1]) : null;
    }
    if (res.status === 200) {
      const n = Number(res.headers.get('content-length'));
      if (res.body) await res.body.cancel().catch(() => {});
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (res.body) await res.body.cancel().catch(() => {});
    return null;
  } catch {
    return null;
  }
}

function putBytes(url, headers, bytes) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'PUT',
      headers: { ...headers, 'Content-Length': bytes.length },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('上传超过 30 分钟')));
    req.on('error', reject);
    req.end(bytes);
  });
}

/* 说明文字:优先用发布说明文件,没有就留空 */
const nf = notesFile();
const body = existsSync(nf) ? await readFile(nf, 'utf8') : '';
if (body) console.log('[GitCode] 使用说明文件:', nf);
else console.log('[GitCode] 没有找到说明文件(' + nf + '),发行版说明留空');

/* 1) 找发行版;没有就建。
 * GitCode 仓库是普通仓库,tag 由 GitCode 按 tag_name 自动创建;不需要等镜像。
 * 如果 GITCODE_REPO 误指到镜像仓库,创建会返回 image repository,下面会给出明确提示。 */
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
      console.log('[GitCode] 标签 ' + tag + ' 还没就绪,10 秒后重试(' + attempt + '/6)...');
      await sleep(10000);
      continue;
    }
    if (/image repository|镜像仓库/i.test(text)) {
      console.error('[GitCode] 目标仓库是镜像仓库,不能创建新标签/发行版:', owner + '/' + repo);
      console.error('[GitCode] 请使用普通仓库 ' + owner + '/DeltaForceAnimation_app,不要指到旧的只读镜像仓库。');
      process.exit(1);
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
  if (release && typeof release.body === 'string' && release.body === body) {
    console.log('[GitCode] 说明未变化,跳过更新');
  } else {
    const upd = await apiRetry('/releases/' + encodeURIComponent(tag), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tag, body, prerelease: false }),
    });
    console.log('[GitCode] 更新说明:', upd.status, upd.status >= 400 ? (await upd.text()).slice(0, 200) : 'ok');
  }
}

/* 3) 逐个上传附件:**只补缺,绝不先删**。
 *
 * 为什么要改(2026-10-24 v1.1.0 的真实事故):这里原来写的是"同名且大小不一致 → 先 DELETE 再 PUT"。
 * 那一次 CI 的上传在 40 分钟后失败,而 DELETE 已经成功执行 —— 于是 GitCode 上
 * Setup 和 APK 两个附件被删掉后没能传回来(用户几天后来问"APK 怎么没了")。
 * 现在的规矩:
 *   · 同名附件**存在就跳过**,不管大小是否一致(同一个 tag 下的产物就是同一版,
 *     大小不同一般是"两次构建撞到同一个 tag",这种情况下删掉别人已传上去的包只会更糟);
 *   · 大小不一致时打一行 WARN,让人去看,而不是自作主张删;
 *   · 按体积**从小到大**上传:手机 APK 最先落地,后面大包即使失败,用户也已经有得下。 */
const all = (await readdir(assetsDir)).filter((n) => !n.startsWith('.') && !n.endsWith('.blockmap'));
if (!all.length) { console.error('[GitCode] 产物目录是空的:', assetsDir); process.exit(1); }
const files = [];
for (const n of all) {
  const st = await stat(path.join(assetsDir, n));
  if (st.isFile()) files.push({ name: n, size: st.size });
}
files.sort((a, b) => a.size - b.size);
let failed = 0;
for (const f of files) {
  const name = f.name;
  const filePath = path.join(assetsDir, name);
  const info = { size: f.size };
  console.log('[GitCode] 处理 ' + name + ' (' + (info.size / 1048576).toFixed(1) + ' MB)');

  /* 3a) 已存在 → 跳过(不删、不覆盖) */
  const cur = await apiRetry('/releases/tags/' + encodeURIComponent(tag));
  if (cur.status === 200) {
    const data = await cur.json();
    const existing = (data.assets || []).find((a) => a.name === name) || null;
    if (existing) {
      let remote = null;
      if (existing.browser_download_url) remote = await remoteSize(existing.browser_download_url);
      if (remote === info.size) console.log('        已存在且大小一致(' + remote + ' 字节),跳过');
      else console.log('        WARN 已存在但大小不同(远端 ' + remote + ' / 本地 ' + info.size + '),跳过以免删掉可用附件;如需替换请手工删除后再传');
      continue;
    }
  }

  /* 3c) 取上传地址并 PUT */
  const bytes = await readFile(filePath);
  const urlRes = await apiRetry('/releases/' + encodeURIComponent(tag) + '/upload_url?file_name=' + encodeURIComponent(name));
  if (urlRes.status >= 400) { console.error('        取上传地址失败:', urlRes.status, (await urlRes.text()).slice(0, 200)); failed++; continue; }
  const { url, headers } = await urlRes.json();
  const put = await putBytes(url, headers, bytes);
  const text = (put.body || '').slice(0, 120);
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
