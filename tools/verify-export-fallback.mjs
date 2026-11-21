/* 导出音轨回退 + 手机端能力门禁的回归验证(纯 Node + puppeteer,不依赖 ffmpeg/ffprobe)。
 *
 * 背景:部分 Android WebView / 模拟器 / 定制 ROM 没有系统 AAC 编码器。以前这种情况会静默
 * 产出一段没有声音的 MP4;兼容录制回退又优先挑 MP4 + mp4a,同样编不出声音。现在的行为是:
 *   1) 有 AAC → 照旧 AAC-LC(桌面/大多数手机不变);
 *   2) 没 AAC → 用 WebCodecs 的 Opus 编音轨,mp4-muxer 封成 Opus-in-MP4(离线编码,不降速);
 *   3) 连 WebCodecs 都没有 → 兼容录制优先 WebM + Opus(Chromium 软件实现,不需要 AAC);
 *   4) 手机端没有下载列表入口;导出成功卡不出现「打开文件夹」。
 *
 * 用法(先 npm run dev,默认连 5173):
 *   node tools/verify-export-fallback.mjs                # 跑全部
 *   node tools/verify-export-fallback.mjs --case noaac
 *   node tools/verify-export-fallback.mjs --url http://127.0.0.1:5173/
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const BASE = (arg('url', process.env.VERIFY_BASE || 'http://127.0.0.1:5173/')).replace(/\/+$/, '') + '/';
const CHROME = [
  process.env.VERIFY_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('NO_BROWSER'); process.exit(2); }

const OUT = 'release/export-fallback';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 两种"没有可用音频编码器"的现场 ---- */
const noAac = () => {
  window.__noAacSeen = !!window.AudioEncoder;
  if (!window.AudioEncoder) return;
  const orig = window.AudioEncoder.isConfigSupported.bind(window.AudioEncoder);
  window.AudioEncoder.isConfigSupported = (cfg) =>
    cfg && String(cfg.codec).indexOf('mp4a') === 0
      ? Promise.resolve({ supported: false, config: cfg })
      : orig(cfg);
  /* MediaRecorder 也按"没有 AAC 编码器"处理:真机上 isTypeSupported('...mp4a...') 可能
   * 仍答支持,start 时才失败或悄悄丢音轨。这里一并拒掉 MP4,逼回退走 WebM + Opus。 */
  const MR = window.MediaRecorder;
  if (MR && typeof MR.isTypeSupported === 'function') {
    const origSupported = MR.isTypeSupported.bind(MR);
    MR.isTypeSupported = (m) => (/mp4/i.test(String(m)) ? false : origSupported(m));
  }
  window.__noAacPatched = true;
};
const noWebCodecs = () => {
  delete window.VideoEncoder; delete window.VideoFrame; delete window.AudioEncoder; delete window.AudioData;
};
/* 模拟 Android 壳:__DFAE_MOBILE__ 是端判定第一权威信号;dfaeDownloads 与真实桥接同形。 */
const mobileBridge = () => {
  window.__DFAE_MOBILE__ = true;
  window.dfaeDownloads = {
    isDesktop: true,
    save: async (filename) => ({ mode: 'auto', name: filename, path: '/storage/emulated/0/Movies/x/' + filename }),
    list: async () => ({ entries: [], total: 0, dir: '/storage/emulated/0/Movies/x' }),
    getPromptOnSave: async () => false,
    setPromptOnSave: async () => true,
    rename: async () => true,
    remove: async () => true,
    reveal: async () => true,
    open: async () => true,
    onChanged: () => () => {},
  };
  window.dfaeDesktop = {
    isDesktop: true, platform: 'android',
    getInfo: async () => ({ version: '1.1.4', packaged: true }),
    openExternal: async () => true, revealFile: async () => true,
  };
};

/* ---- 最小 MP4 box 解析:只找 moov/trak 的 handler 与 stsd 样本格式 ---- */
function mp4Tracks(buf) {
  const tracks = [];
  function walk(start, end, path) {
    let off = start;
    while (off + 8 <= end) {
      let size = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      let hdr = 8;
      if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; }
      if (size === 0) size = end - off;
      if (size < hdr || off + size > end) break;
      const ps = off + hdr, pe = off + size;
      if (type === 'trak') {
        tracks.push({ handler: null, formats: [] });
        walk(ps, pe, path.concat('trak'));
      } else if (['moov', 'mdia', 'minf', 'stbl'].includes(type)) {
        walk(ps, pe, path.concat(type));
      } else if (type === 'hdlr') {
        const t = tracks[tracks.length - 1];
        if (t) t.handler = buf.toString('ascii', ps + 8, ps + 12);
      } else if (type === 'stsd') {
        const count = buf.readUInt32BE(ps + 4);
        let e = ps + 8;
        const formats = [];
        for (let i = 0; i < count && e + 8 <= pe; i++) {
          const esize = buf.readUInt32BE(e);
          if (esize < 8) break;
          formats.push(buf.toString('ascii', e + 4, e + 8));
          e += esize;
        }
        const t = tracks[tracks.length - 1];
        if (t) t.formats = formats;
      }
      off += size;
    }
  }
  walk(0, buf.length, []);
  return tracks;
}

async function readBlob(page, file) {
  const size = await page.evaluate(() => (window.__blobs.length ? window.__blobs[window.__blobs.length - 1].size : -1));
  if (size <= 0) return -1;
  const CHUNK = 4 * 1024 * 1024;
  const fd = fs.openSync(file, 'w');
  for (let off = 0; off < size; off += CHUNK) {
    const b64 = await page.evaluate(async ({ off, len }) => {
      const blob = window.__blobs[window.__blobs.length - 1];
      const r = new FileReader();
      return new Promise((res) => { r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob.slice(off, off + len)); });
    }, { off, len: Math.min(CHUNK, size - off) });
    fs.writeSync(fd, Buffer.from(b64, 'base64'));
  }
  fs.closeSync(fd);
  return size;
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : ''));
}

async function openEditor(browser, preload, viewport) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  if (viewport) await page.setViewport(viewport);
  if (preload) await page.evaluateOnNewDocument(preload);
  await page.goto(BASE + '?view=editor&ui=mobile', { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(() => { const l = document.getElementById('app-loading'); return !l || l.classList.contains('is-hidden'); }, { timeout: 120000, polling: 100 });
  await page.waitForFunction(() => window.__anim && window.__anim.isLoaded, { timeout: 120000, polling: 100 }).catch(() => {});
  await sleep(800);
  return { page, errors };
}

async function audioProbe(page) {
  return page.evaluate(async () => {
    const out = { patched: !!window.__noAacPatched, seen: !!window.__noAacSeen, hasAE: !!window.AudioEncoder };
    try { const a = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }); out.aac = !!a.supported; } catch (e) { out.aac = 'err:' + e.message; }
    try { const o = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }); out.opus = !!o.supported; } catch (e) { out.opus = 'err:' + e.message; }
    return out;
  });
}

async function exportOnce(page) {
  await page.evaluate(() => {
    const t = document.getElementById('chkTransparent'); if (t && t.checked) t.click();
    const f = document.getElementById('selFormat'); f.value = 'mp4'; f.dispatchEvent(new Event('change'));
    const r = document.getElementById('selRes'); r.value = 'auto'; r.dispatchEvent(new Event('change'));
    window.__blobs = [];
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (b) { if (b && String(b.type).indexOf('video') === 0) window.__blobs.push(b); return orig.call(this, b); };
  });
  await page.evaluate(() => document.getElementById('btnExport').click());
  await page.waitForFunction(() => {
    const s = document.getElementById('statusbar').textContent;
    const o = document.getElementById('exportStatus').textContent;
    return s.includes('导出完成') || s.includes('导出失败') || s.includes('已保存到手机相册')
      || o.includes('导出成功') || o.includes('导出失败');
  }, { timeout: 300000, polling: 1000 });
  await sleep(1200);
  return page.evaluate(() => ({
    status: document.getElementById('statusbar').textContent,
    outcome: document.getElementById('exportStatus').textContent,
    detail: document.getElementById('exportDetail').textContent,
    successSub: document.getElementById('exportSuccessSub').textContent,
    blobTypes: window.__blobs.map((b) => b.type + ':' + b.size),
    openDirShown: document.getElementById('btnExportOpenDir').getClientRects().length > 0,
    openDirHidden: document.getElementById('btnExportOpenDir').hidden,
    panelShown: !document.getElementById('downloadsPanel').hidden,
  }));
}

async function runCodecCase(name, preload, expect) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const { page, errors } = await openEditor(browser, preload);
    const probe = await audioProbe(page);
    if (expect.audioCodec === 'Opus') check(name + ':模拟环境确实没有 AAC 编码器', probe.aac === false && probe.opus === true, JSON.stringify(probe));
    const state = await exportOnce(page);
    const ext = /webm/i.test(state.blobTypes.join(',')) ? 'webm' : 'mp4';
    const file = OUT + '/' + name + '.' + ext;
    const bytes = await readBlob(page, file);
    check(name + ':导出成功且无 JS 报错', /导出成功|已保存到手机相册/.test(state.outcome + state.status) && errors.length === 0, errors.slice(0, 2).join(' | '));
    check(name + ':产出视频文件', bytes > 0, bytes + ' bytes');
    if (bytes > 0) {
      const buf = fs.readFileSync(file);
      if (ext === 'mp4') {
        const tracks = mp4Tracks(buf);
        const audio = tracks.find((t) => t.handler === 'soun');
        const video = tracks.find((t) => t.handler === 'vide');
        check(name + ':MP4 有视频轨', !!video && video.formats.includes('avc1'), JSON.stringify(video));
        check(name + ':MP4 音轨为 ' + expect.codec, !!audio && audio.formats.includes(expect.codec), JSON.stringify(audio));
        if (expect.notCodec) check(name + ':不再出现 ' + expect.notCodec, !audio || !audio.formats.includes(expect.notCodec), JSON.stringify(audio));
      } else {
        const head = buf.subarray(0, Math.min(bytes, 512 * 1024)).toString('latin1');
        check(name + ':WebM 音轨为 Opus', head.includes('A_OPUS'), head.includes('A_OPUS') ? 'A_OPUS' : 'no A_OPUS');
        check(name + ':WebM 有视频轨', /V_VP8|V_VP9|V_AV1/.test(head), (head.match(/V_VP8|V_VP9|V_AV1/) || [])[0] || 'none');
        check(name + ':WebM 没有 AAC 依赖', !head.includes('A_AAC'), head.includes('A_AAC') ? 'A_AAC' : 'ok');
      }
    }
    await page.close();
  } finally {
    await browser.close();
  }
}

async function runMobileGating() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const { page, errors } = await openEditor(browser, mobileBridge, { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const pre = await page.evaluate(() => ({
      hasBtnDownloads: !!document.getElementById('btnDownloads'),
      hasNavDownloads: !!document.querySelector('#navDownloads'),
      navPages: [...document.querySelectorAll('.rail-item')].filter((e) => e.getClientRects().length).map((e) => e.dataset.page),
      panelHidden: document.getElementById('downloadsPanel').hidden,
    }));
    check('手机:下载列表按钮已移除', !pre.hasBtnDownloads);
    check('手机:导航无下载列表项', !pre.hasNavDownloads && !pre.navPages.includes('downloads'), pre.navPages.join(','));
    check('手机:下载列表面板未显示', pre.panelHidden);
    const state = await exportOnce(page);
    check('手机:导出成功且无 JS 报错', /导出成功|已保存到手机相册/.test(state.outcome + state.status) && errors.length === 0, errors.slice(0, 2).join(' | '));
    check('手机:成功卡不显示「打开文件夹」', state.openDirHidden && !state.openDirShown, JSON.stringify({ hidden: state.openDirHidden, shown: state.openDirShown }));
    check('手机:不会弹下载列表', !state.panelShown);
    check('手机:落盘结果写回成功卡', /手机相册/.test(state.successSub), state.successSub);
    await page.close();
  } finally {
    await browser.close();
  }
}

const only = arg('case', '');
if (!only || only === 'base') await runCodecCase('base', null, { codec: 'mp4a', audioCodec: 'AAC' });
/* 无 AAC:MP4 走 Opus-in-MP4;若这台机器连 H.264 都不可用,则允许退到 WebM + Opus。
 * 两条都必须"有声音",且都不能出现 mp4a。 */
if (!only || only === 'noaac') await runCodecCase('noaac', noAac, { codec: 'Opus', audioCodec: 'Opus', notCodec: 'mp4a' });
if (!only || only === 'nowebcodecs') await runCodecCase('nowebcodecs', noWebCodecs, { codec: 'opus', webmOpus: true });
if (!only || only === 'mobile') await runMobileGating();

const failed = results.filter((r) => !r.ok).length;
console.log('\n' + (failed ? failed + ' 项失败 / ' + results.length + ' 项' : 'ALL PASS / ' + results.length + ' 项'));
if (failed) process.exitCode = 1;
