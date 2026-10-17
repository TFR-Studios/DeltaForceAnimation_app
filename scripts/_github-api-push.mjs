#!/usr/bin/env node
/* One-off: publish working-tree changes through GitHub Git Data API (github.com:443 is unreachable here),
 * and update the v1.0.2 release notes. Token comes from GH_TOKEN env. */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const owner = 'TFR-Studios';
const repo = 'DeltaForceAnimation_app';
const token = process.env.GH_TOKEN;
if (!token) { console.error('missing GH_TOKEN'); process.exit(2); }
const apiBase = 'https://api.github.com/repos/' + owner + '/' + repo;

async function api(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dfae-release-tool',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status + ': ' + (typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)));
  return data;
}

// 1) Update v1.0.2 release notes
const notes = await readFile('docs/RELEASE_NOTES_v1.0.2.md', 'utf8');
const found = await api('/repos/' + owner + '/' + repo + '/releases/tags/v1.0.2');
const rel = await api('/repos/' + owner + '/' + repo + '/releases/' + found.id, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'v1.0.2', body: notes }),
});
console.log('release notes updated:', rel.html_url);

// 2) Collect changed/untracked files
const out = execFileSync('git', ['ls-files', '-m', '-o', '--exclude-standard', '-z'], { encoding: 'buffer' });
const paths = out.toString('utf8').split('\u0000').filter(Boolean);
if (!paths.length) { console.log('no file changes'); process.exit(0); }
console.log('files to publish:', paths.length);
for (const p of paths) console.log('  ' + p);

// 3) Current head commit/tree
const ref = await api('/repos/' + owner + '/' + repo + '/git/ref/heads/main');
const headSha = ref.object.sha;
const headCommit = await api('/repos/' + owner + '/' + repo + '/git/commits/' + headSha);
console.log('base commit:', headSha);

// 4) Blobs
const entries = [];
for (const p of paths) {
  const bytes = await readFile(p);
  const blob = await api('/repos/' + owner + '/' + repo + '/git/blobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: bytes.toString('base64'), encoding: 'base64' }),
  });
  entries.push({ path: p.replaceAll('\\', '/'), mode: '100644', type: 'blob', sha: blob.sha });
  console.log('  blob', p, blob.sha.slice(0, 10));
}

// 5) Tree
const tree = await api('/repos/' + owner + '/' + repo + '/git/trees', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: entries }),
});
console.log('tree:', tree.sha);

// 6) Commit
const message = process.env.COMMIT_MESSAGE || 'fix(release): 修复 GitCode 静默漏发与版本号漂移';
const commit = await api('/repos/' + owner + '/' + repo + '/git/commits', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
});
console.log('commit:', commit.sha);

// 7) Fast-forward main
const upd = await api('/repos/' + owner + '/' + repo + '/git/refs/heads/main', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sha: commit.sha, force: false }),
});
console.log('main ->', upd.object.sha);
console.log('https://github.com/' + owner + '/' + repo + '/commit/' + commit.sha);
