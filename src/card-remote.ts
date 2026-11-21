/* ============================================================================
 * 名片原图在线加载(src/card-remote.ts)
 * ---------------------------------------------------------------------------
 * 打包里只有 manifest + 160px 缩略图;选中名片时按需从 GitCode 拉原图:
 *   raw API: https://api.gitcode.com/api/v5/repos/<repo>/raw/<path>?ref=<ref>
 *   (实测带 Access-Control-Allow-Origin,二进制可直接画进 canvas)
 * 分层:内存 → Cache Storage(键含 commit sha)→ 网络 → 本地缩略图兜底。
 * ========================================================================== */

export type RemoteSource = 'remote' | 'cache' | 'thumb';
export type LoadedCard = { img: HTMLImageElement; source: RemoteSource; width: number; height: number };

const REPO = 'TFR-Studios/DFAsset';
const BRANCH = 'main';
const CACHE_NAME = 'dfae-cards-v1';
const FETCH_TIMEOUT = 20000;
/* 探测失败后 30s 内不再打网络,避免弱网下每张卡都等超时 */
const PROBE_RETRY_MS = 30000;

/** entry.id(business/Ma1/Card_x / skin/Skin_x)→ 仓库内路径 */
export function repoPathOf(entryId: string): string {
  if (entryId.startsWith('business/')) {
    return 'Commerical/BusinessFiller/Card/' + entryId.slice('business/'.length) + '.png';
  }
  if (entryId.startsWith('skin/')) {
    return 'Commerical/Skin/' + entryId.slice('skin/'.length) + '.png';
  }
  return '';
}

function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal, mode: 'cors' }).finally(() => clearTimeout(timer));
}

let headPromise: Promise<string | null> | null = null;
let headFailedAt = 0;

/** 最新 commit sha;失败返回 null(30s 内直接走兜底,不再重复探测)。 */
export function branchHead(): Promise<string | null> {
  if (headPromise) return headPromise;
  if (Date.now() - headFailedAt < PROBE_RETRY_MS) return Promise.resolve(null);
  headPromise = (async () => {
    try {
      const res = await fetchWithTimeout(
        'https://api.gitcode.com/api/v5/repos/' + REPO + '/branches/' + BRANCH,
        10000,
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = (await res.json()) as { commit?: { sha?: string; id?: string } };
      const sha = data.commit?.sha || data.commit?.id || null;
      if (!sha) throw new Error('no sha');
      return sha;
    } catch {
      headFailedAt = Date.now();
      headPromise = null;
      return null;
    }
  })();
  return headPromise;
}

const memory = new Map<string, LoadedCard>();
const inflight = new Map<string, Promise<LoadedCard>>();

function decode(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    img.src = url;
  });
}

async function fromCache(sha: string, path: string): Promise<Blob | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match('https://dfae-cards.dfae.local/v1/' + sha + '/' + path);
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

async function intoCache(sha: string, path: string, res: Response): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put('https://dfae-cards.dfae.local/v1/' + sha + '/' + path, res.clone());
  } catch { /* 缓存失败不阻断 */ }
}

/**
 * 加载一张名片原图。任何一层失败都落到 bundled 缩略图,保证永远有图可用。
 * @param entryId manifest 的 id
 * @param thumbUrl 打包缩略图地址(兜底)
 */
export function loadCardOriginal(entryId: string, thumbUrl: string): Promise<LoadedCard> {
  const hit = memory.get(entryId);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(entryId);
  if (running) return running;
  const task = (async (): Promise<LoadedCard> => {
    const path = repoPathOf(entryId);
    if (path) {
      const sha = await branchHead();
      if (sha) {
        const cached = await fromCache(sha, path);
        if (cached) {
          const img = await decode(cached);
          const done = { img, source: 'cache' as const, width: img.naturalWidth, height: img.naturalHeight };
          memory.set(entryId, done);
          return done;
        }
        try {
          const res = await fetchWithTimeout(
            'https://api.gitcode.com/api/v5/repos/' + REPO + '/raw/' + path + '?ref=' + BRANCH,
            FETCH_TIMEOUT,
          );
          const type = res.headers.get('content-type') || '';
          if (!res.ok || /text\/html|svg/.test(type)) throw new Error('HTTP ' + res.status + ' ' + type);
          const blob = await res.blob();
          const img = await decode(blob);
          await intoCache(sha, path, res);
          const done = { img, source: 'remote' as const, width: img.naturalWidth, height: img.naturalHeight };
          memory.set(entryId, done);
          return done;
        } catch { /* 网络失败 → 兜底 */ }
      }
    }
    const img = await decode(await (await fetch(thumbUrl)).blob());
    const done = { img, source: 'thumb' as const, width: img.naturalWidth, height: img.naturalHeight };
    memory.set(entryId, done);
    return done;
  })();
  inflight.set(entryId, task);
  return task.finally(() => inflight.delete(entryId));
}

export function cachedCard(entryId: string): LoadedCard | undefined {
  return memory.get(entryId);
}

/** 供检查器显示的来源文案 */
export function sourceLabel(source: RemoteSource): string {
  return source === 'remote' ? 'GitCode 原图' : source === 'cache' ? 'GitCode 原图 · 已缓存' : '本地缩略图';
}
