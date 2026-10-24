/* ============================================================================
 * 更新检查(src/update-check.ts)
 *
 * 解决的是**一个数据源问题**:GitCode 优先,连不上再退 GitHub。
 *
 *   桌面客户端 —— 请求由主进程代发(见 electron/main.cjs 的 dfae:check-update)。
 *      两条实打实的理由:① 主进程用的是 Electron 的 net.fetch,走系统代理设置 ——
 *      渲染进程的 fetch 不认系统代理,公司网络里就只剩"网络错误";② 少一道跨域开关。
 *      api.gitcode.com 的 ACAO 是**动态**的:带 Origin 的请求它会给(实测页面里 fetch
 *      返回 type:'cors' 且能读到 JSON),不带 Origin 的请求(curl / PowerShell)看不到这个头 ——
 *      也就是说这条行为会随请求头、代理、网关变化,不适合当唯一通路。
 *   网页 / 手机 —— 直接 fetch:先 GitCode,任何异常都退 GitHub(ACAO: *,稳)。
 *
 *   两个接口的字段名是一致的(tag_name / name / body / assets[].browser_download_url),
 *   所以下面只有一份解析逻辑,不按平台分叉。
 *
 * 版本比较只做数字段比较:tag 形如 v1.0.5,允许 1.0 / v1.0.5.1 这类写法,
 * 缺的段补 0。带后缀(v1.0.6-beta)的按"同一版更小"处理 —— 稳定版才算升级。
 *
 * 这里不发任何写操作、不下载安装包:只回答"有没有新版本、点哪儿去拿"。
 * 安装包的选择在 pickAsset 里按平台判定(Windows 优先安装版 exe,Android 取 apk)。
 * ========================================================================== */

/** 发行版所在的两个仓库(同一个仓库名,两个托管站,见 README 的「同步到 GitCode」)。
 *  改名/迁移时只改这一处。 */
const REPO_PATH = 'TFR-Studios/DeltaForceAnimation_app';

/** 数据源,按顺序尝试;第一个通的就停。 */
const SOURCES = [
  {
    id: 'gitcode' as const,
    label: 'GitCode',
    api: 'https://api.gitcode.com/api/v5/repos/' + REPO_PATH + '/releases/latest',
    page: 'https://gitcode.com/' + REPO_PATH + '/releases',
  },
  {
    id: 'github' as const,
    label: 'GitHub',
    api: 'https://api.github.com/repos/' + REPO_PATH + '/releases/latest',
    page: 'https://github.com/' + REPO_PATH + '/releases',
  },
];

export type SourceId = 'gitcode' | 'github';

/** 一个发行版里的单个附件(安装包)。 */
export type ReleaseAsset = { name: string; url: string };

/** 归一化之后的发行版信息:两个平台共用这一份形状。 */
export type ReleaseInfo = {
  /** 原始 tag,如 v1.0.5(展示与拼接下载页地址用) */
  tag: string;
  /** 去掉前缀 v 的版本号,比较用 */
  version: string;
  name: string;
  /** 发行版说明(markdown,当前只在提示里截取首行用) */
  notes: string;
  /** 这个版本的发行版页面 */
  pageUrl: string;
  assets: ReleaseAsset[];
};

export type ReleaseOrigin = { source: SourceId; label: string };

/** 一次检查的结果:有新版 / 已是最新 / 出错。 */
export type UpdateResult =
  | { kind: 'latest'; current: string; release: ReleaseInfo; origin: ReleaseOrigin; asset: ReleaseAsset | null }
  | { kind: 'available'; current: string; release: ReleaseInfo; origin: ReleaseOrigin; asset: ReleaseAsset | null }
  | { kind: 'error'; message: string; detail: string };

/** 单次请求的超时。两个源都等满的话总耗时翻倍,所以每个都给 8s ——
 *  手机弱网下这个值是"再等就没意义了"的那条线。 */
const REQUEST_TIMEOUT = 8000;

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e || '未知错误');
}

/* 带超时的 JSON 请求。AbortController 而不是 Promise.race:后者只是"不再等",
 * 请求本身还挂着,在弱网设备上会一直占着连接。 */
async function fetchJson(url: string, timeoutMs = REQUEST_TIMEOUT): Promise<any> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    window.clearTimeout(timer);
  }
}

/** 把两个平台不同来源的原始 JSON 归一化成 ReleaseInfo。
 *  字段缺失不抛错:宁可显示"已是最新"也不要把一个缺字段的响应变成崩溃。 */
function normalizeRelease(raw: any, source: SourceId): ReleaseInfo {
  const tag = String(raw?.tag_name || raw?.name || '').trim();
  const version = tag.replace(/^v/i, '').trim();
  const assets: ReleaseAsset[] = (Array.isArray(raw?.assets) ? raw.assets : [])
    .map((a: any) => ({
      name: String(a?.name || ''),
      url: String(a?.browser_download_url || a?.download_url || ''),
    }))
    .filter((a: ReleaseAsset) => !!a.name && !!a.url);
  const page = SOURCES.find((s) => s.id === source)?.page || '';
  return {
    tag,
    version,
    name: String(raw?.name || tag || ''),
    notes: String(raw?.body || ''),
    /* GitCode 的响应里没有 html_url(实测),所以发行版页面地址自己拼;
     * GitHub 两个地址指向同一页,拼出来同样有效。 */
    pageUrl: tag ? page + '/tag/' + encodeURIComponent(tag) : page,
    assets,
  };
}

/** 桌面客户端是否存在主进程代发请求的通道。 */
function desktopBridge(): { checkUpdate?: () => Promise<any> } | undefined {
  const d = (window as any).dfaeDesktop;
  return d && typeof d === 'object' ? d : undefined;
}

/** 取最新发行版。返回"用的是哪个源",界面会如实标出来 ——
 *  国内源挂了走 GitHub 这件事,用户有权知道。 */
export async function fetchLatestRelease(): Promise<{ release: ReleaseInfo; origin: ReleaseOrigin }> {
  const bridge = desktopBridge();
  if (bridge && typeof bridge.checkUpdate === 'function') {
    const res = await bridge.checkUpdate();
    if (res && res.ok && res.release) {
      const source: SourceId = res.source === 'github' ? 'github' : 'gitcode';
      const label = SOURCES.find((s) => s.id === source)?.label || res.label || source;
      return { release: normalizeRelease(res.release, source), origin: { source, label } };
    }
    const tried = Array.isArray(res?.tried) ? res.tried.filter(Boolean) : [];
    throw new Error(tried.length ? tried.join(' / ') : '两个更新源都没有连上');
  }

  const errors: string[] = [];
  for (const src of SOURCES) {
    try {
      const raw = await fetchJson(src.api);
      const release = normalizeRelease(raw, src.id);
      /* 拿不到 tag 的响应不能算"成功":那样会把"服务端返回了一坨错误页"当成"已是最新"。 */
      if (!release.version) throw new Error('返回内容里没有版本号');
      return { release, origin: { source: src.id, label: src.label } };
    } catch (e) {
      errors.push(src.label + ': ' + errText(e));
    }
  }
  throw new Error(errors.join(' / '));
}

/** 把版本号拆成数字段。非数字段按 0 处理(不认识的格式不至于让整次检查失败)。 */
function versionParts(v: string): number[] {
  const core = String(v).replace(/^v/i, '').split(/[-+]/)[0];
  const nums = core.split('.').map((n) => parseInt(n, 10));
  const out = nums.map((n) => (Number.isFinite(n) ? n : 0));
  while (out.length < 3) out.push(0);
  return out;
}

/** 比较两个版本号。\>0 表示 a 比 b 新,\<0 表示旧,0 表示相同。 */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  /* 数字段相同:带后缀的(1.0.6-beta)按"同版更低"算,稳定版才算升级。 */
  const sa = String(a).replace(/^v/i, '').includes('-');
  const sb = String(b).replace(/^v/i, '').includes('-');
  if (sa !== sb) return sa ? -1 : 1;
  return 0;
}

export type Platform = 'windows' | 'android' | 'web';

/** 从附件里挑一个"这个平台该下哪个"。
 *  Windows:安装版 Setup > 便携版 Portable > 免安装 zip > 其它 exe;
 *  Android:apk;
 *  web:不提供直接下载(网页版没有安装包,给发行版页面)。 */
export function pickAsset(assets: ReleaseAsset[], platform: Platform): ReleaseAsset | null {
  const rank = (name: string): number => {
    const n = name.toLowerCase();
    if (platform === 'android') return n.endsWith('.apk') ? 10 : 0;
    if (platform === 'windows') {
      if (n.includes('setup') && n.endsWith('.exe')) return 40;
      if (n.includes('portable') && n.endsWith('.exe')) return 30;
      if (n.includes('unpacked') && n.endsWith('.zip')) return 20;
      if (n.endsWith('.exe')) return 10;
      return 0;
    }
    return 0;
  };
  let best: ReleaseAsset | null = null;
  let bestScore = 0;
  for (const a of assets) {
    const s = rank(a.name);
    if (s > bestScore) {
      best = a;
      bestScore = s;
    }
  }
  return best;
}

/** 一次完整的检查:取最新版 → 比较 → 挑附件。任何异常都收成 kind:'error'。 */
export async function checkForUpdate(opts: { current: string; platform: Platform }): Promise<UpdateResult> {
  try {
    const { release, origin } = await fetchLatestRelease();
    const cmp = compareVersions(release.version, opts.current);
    const kind: 'latest' | 'available' = cmp > 0 ? 'available' : 'latest';
    return {
      kind,
      current: opts.current,
      release,
      origin,
      asset: kind === 'available' ? pickAsset(release.assets, opts.platform) : null,
    };
  } catch (e) {
    return {
      kind: 'error',
      message: '检查失败:无法连接更新服务器',
      detail: errText(e),
    };
  }
}
