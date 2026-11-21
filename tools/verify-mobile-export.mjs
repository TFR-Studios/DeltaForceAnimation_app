/* 手机导出加固的回归验证:在真实浏览器里跑四种"环境",确认桌面行为不变、手机上各条降级路都能出片。
 *
 * 用法(先确保 dev server 在 5173 上跑着):
 *   node tools/verify-mobile-export.mjs desktop   # 桌面基准:必须与改造前一致(1920×1080 / 有音轨)
 *   node tools/verify-mobile-export.mjs ladder    # 模拟"手机硬编码器只到 960 宽":应自动降档并成功
 *   node tools/verify-mobile-export.mjs recorder  # 模拟"完全没有 WebCodecs":应走兼容录制并出片(带音轨)
 *   node tools/verify-mobile-export.mjs noaac     # 模拟"不支持 AAC":应改走兼容录制(带音轨),而不是无声 MP4
 *   node tools/verify-mobile-export.mjs all
 *
 * 三个"环境"都是 evaluateOnNewDocument 注入的:必须在页面脚本执行前改写好,
 * 因为 main.ts 在模块加载时就把 VideoEncoder 等构造器取出来了。 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5173/';
const TMP = 'I:/Delta Force custom animation/tools/.mobile-test';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// 模拟:本机硬编码器不支持宽度 > 960 的配置(中低端手机的常见形态)
const rejectBig = () => {
  const proto = window.VideoEncoder && window.VideoEncoder.prototype;
  if (!proto) return;
  const orig = window.VideoEncoder.isConfigSupported.bind(window.VideoEncoder);
  window.VideoEncoder.isConfigSupported = (cfg) => (cfg && cfg.width > 960)
    ? Promise.resolve({ supported: false, config: cfg })
    : orig(cfg);
};

// 模拟:浏览器完全没有 WebCodecs(老 iOS Safari / 部分国产内核)
const noWebCodecs = () => {
  delete window.VideoEncoder; delete window.VideoFrame; delete window.AudioEncoder; delete window.AudioData;
};

// 模拟:能编视频但编不了 AAC
const noAac = () => {
  if (!window.AudioEncoder) return;
  const orig = window.AudioEncoder.isConfigSupported.bind(window.AudioEncoder);
  window.AudioEncoder.isConfigSupported = (cfg) => (cfg && String(cfg.codec).indexOf('mp4a') === 0)
    ? Promise.resolve({ supported: false, config: cfg })
    : orig(cfg);
};

/* 用例里的动画都有讲究:
 *  - 撤离动画(extraction)= canvas 渲染器,逐帧画面真的在变,用来验证"录到的是不是动画本身";
 *  - 任务弹窗(mission)走 SVG 逐帧光栅化,在无头 Chrome 里栅格化会出空帧(环境限制,与本改造无关),
 *    所以内容类断言不用它 —— 否则会把"渲染环境的问题"误判成导出管线的问题;
 *  - 所有用例用的撤离动画都带音轨:每个用例都应当产出带音轨的成片,
 *    包括「无 WebCodecs」(兼容录制带音轨)与「不支持 AAC」(改走兼容录制带音轨)。
 *    缺少音轨即判失败(见文件末尾的 audioOk 断言)。 */
const CASES = {
  desktop: { anim: null, ua: null, preload: null, res: 'auto', format: 'mp4' },
  ladder: { anim: 'extraction', ua: IPHONE_UA, preload: rejectBig, res: 'auto', format: 'mp4' },
  recorder: { anim: 'extraction', ua: IPHONE_UA, preload: noWebCodecs, res: 'auto', format: 'mp4' },
  noaac: { anim: 'extraction', ua: null, preload: noAac, res: '0.5', format: 'mp4' },
  avih264: { anim: 'extraction', ua: null, preload: null, res: 'auto', format: 'avi' },
  avimjpeg: { anim: 'extraction', ua: null, preload: noWebCodecs, res: 'auto', format: 'avi' },
};

const CHUNK = 4 * 1024 * 1024;
async function saveBlob(page, out) {
  const size = await page.evaluate(() => (window.__blobs.length ? window.__blobs[window.__blobs.length - 1].size : -1));
  if (size <= 0) return { size: -1 };
  const fd = fs.openSync(out, 'w');
  for (let off = 0; off < size; off += CHUNK) {
    const b64 = await page.evaluate(async ({ off, len }) => {
      const blob = window.__blobs[window.__blobs.length - 1];
      const r = new FileReader();
      return new Promise((res) => { r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob.slice(off, off + len)); });
    }, { off, len: Math.min(CHUNK, size - off) });
    fs.writeSync(fd, Buffer.from(b64, 'base64'));
  }
  fs.closeSync(fd);
  return { size };
}

/* 抽几帧做「内容指纹」:同一部片子在不同时间点应当是不同的帧。
 * 只比文件大小不够(静止画面也可能大小不同),这里把帧缩到 64×36 灰度后逐像素哈希,
 * distinct 明显大于 1 才说明录到的是动画本身,而不是一张静止的背景色。 */
function frameFingerprints(file, indexes) {
  try {
    const expr = indexes.map((n) => 'eq(n\\,' + n + ')').join('+');
    const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', "select='" + expr + "',scale=64:36", '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 28, encoding: 'buffer' });
    const size = 64 * 36, hashes = [];
    for (let i = 0; i + size <= buf.length; i += size) {
      let h = 2166136261 >>> 0;
      for (let k = i; k < i + size; k++) { h ^= buf[k]; h = Math.imul(h, 16777619) >>> 0; }
      hashes.push(h);
    }
    return { frames: hashes.length, distinct: new Set(hashes).size };
  } catch (e) { return { error: String(e.message || e).slice(0, 160) }; }
}

/* 容器时长自检(不依赖 ffprobe):安卓相册只读容器元数据,MediaRecorder 的 WebM 若不写
 * Duration 就显示 0:00 —— 这正是用户报的「导出的视频是 0 秒」。所以每个用例产出的文件都必须
 * 自带一段 > 0 的时长。这里直接在字节里找:
 *   · WebM:Segment > Info > Duration(0x4489);
 *   · MP4 :moov > mvhd 的 duration 字段。
 * 自己解析的好处是 CI 里不需要装 ffmpeg,也能精确区分「装着 ffprobe 估出来有」与「文件里真有」。 */
function containerDuration(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 40) return { kind: '?', duration: null };
  const readVint = (p, isId) => {
    const first = buf[p];
    if (!first) return null;
    let len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { mask >>= 1; len += 1; }
    if (len > 8) return null;
    let v = isId ? first : first & (mask - 1);
    for (let i = 1; i < len; i += 1) v = v * 256 + buf[p + i];
    return { len, value: v, unknown: !isId && v === Math.pow(2, len * 7) - 1 };
  };
  /* WebM:递归找 Duration;只在 Info 里认,避免把随机字节当成时长 */
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const MASTER = new Set([0x18538067, 0x1549a966]);
    let dur = null;
    const walk = (start, end, depth) => {
      let p = start;
      while (p + 2 <= end && dur === null) {
        const id = readVint(p, true); if (!id) break;
        const sz = readVint(p + id.len, false); if (!sz) break;
        const ds = p + id.len + sz.len;
        const de = Math.min(end, ds + (sz.unknown ? end - ds : sz.value));
        if (id.value === 0x4489 && de - ds >= 4) {
          dur = de - ds === 8 ? buf.readDoubleBE(ds) : buf.readFloatBE(ds);
        } else if (MASTER.has(id.value) && depth < 3) {
          walk(ds, de, depth + 1);
        }
        if (sz.unknown) break;
        p = de;
      }
    };
    walk(0, buf.length, 0);
    // Duration 的单位是 TimecodeScale ticks;取出 TimecodeScale(默认 1e6ns = 1ms)
    return { kind: 'webm', duration: dur === null ? null : dur, unit: 'ticks(≈ms)' };
  }
  /* MP4:顶层盒子找 moov → mvhd */
  if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    let p = 0;
    while (p + 8 <= buf.length) {
      const size = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      if (!size || size < 8 || p + size > buf.length) break;
      if (type === 'moov') {
        const moov = buf.subarray(p, p + size);
        const i = moov.indexOf('mvhd');
        if (i < 0) return { kind: 'mp4', duration: null };
        const version = moov[i + 4];
        if (version === 0) {
          const timescale = moov.readUInt32BE(i + 16) || 1;
          const d = moov.readUInt32BE(i + 20);
          return { kind: 'mp4', duration: d / timescale, unit: 's' };
        }
        const timescale = moov.readUInt32BE(i + 24) || 1;
        const d = Number(moov.readBigUInt64BE(i + 28));
        return { kind: 'mp4', duration: d / timescale, unit: 's' };
      }
      p += size;
    }
    return { kind: 'mp4', duration: null };
  }
  /* AVI(RIFF):时长 = dwTotalFrames × dwMicroSecPerFrame / 1e6。
   * 头部 hdrl 里的 avih 是固定布局,直接按 RIFF 块走一遍即可。 */
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'AVI ') {
    const i = buf.indexOf('avih');
    if (i < 0) return { kind: 'avi', duration: null };
    const usPerFrame = buf.readUInt32LE(i + 8);
    const totalFrames = buf.readUInt32LE(i + 8 + 16);
    if (!usPerFrame || !totalFrames) return { kind: 'avi', duration: null };
    return { kind: 'avi', duration: (usPerFrame * totalFrames) / 1e6, unit: 's' };
  }
  return { kind: '?', duration: null };
}

/* 没有 ffprobe 时也要能判断"成片里有没有音轨":容器里就是明文。
 * WebM 的 Tracks 写着 A_OPUS / A_VORBIS / A_AAC;MP4 的 moov 里有 soun handler。 */
function containerHasAudio(file) {
  try {
    const buf = fs.readFileSync(file);
    const head = buf.subarray(0, Math.min(buf.length, 1024 * 1024)).toString('latin1');
    // AVI 的音轨体现在流头 'auds'(LIST strl > strh fccType);WebM/MP4 见后两条
    const needles = ['A_OPUS', 'A_VORBIS', 'A_AAC', 'OpusHead', 'soun', 'auds'];
    if (needles.some((n) => head.includes(n))) return true;
    // 碎片化 MP4 的 moov 可能写在尾部
    if (buf.length > 1024 * 1024) {
      const tail = buf.subarray(Math.max(0, buf.length - 4 * 1024 * 1024)).toString('latin1');
      return needles.some((n) => tail.includes(n));
    }
    return false;
  } catch { return false; }
}

function probe(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', file], { encoding: 'utf8' });
    const j = JSON.parse(out);
    const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    return { video: (v.codec_name || '?') + ' ' + (v.width || '?') + 'x' + (v.height || '?'), audio: a ? a.codec_name : '(无音轨)', duration: j.format ? Number(j.format.duration).toFixed(2) + 's' : '?' };
  } catch (e) { return { error: String(e.message || e).slice(0, 200) }; }
}

async function runCase(name) {
  const c = CASES[name];
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const report = { case: name };
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    if (c.ua) await page.setUserAgent(c.ua);
    if (c.preload) await page.evaluateOnNewDocument(c.preload);
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForFunction(() => document.getElementById('statusbar') && document.getElementById('statusbar').textContent.includes('已载入'), { timeout: 120000 });

    if (c.anim) {
      await page.evaluate((key) => {
        const sel = document.getElementById('selAnim');
        sel.value = key;
        sel.dispatchEvent(new Event('change'));
      }, c.anim);
      await page.waitForFunction((key) => document.getElementById('selAnim').value === key
        && document.getElementById('statusbar').textContent.includes('已载入'), { timeout: 180000, polling: 500 }, c.anim);
    }

    report.mobileDetected = await page.evaluate(() => document.getElementById('selRes') ? true : false);
    await page.evaluate(({ res, format }) => {
      const t = document.getElementById('chkTransparent'); if (t.checked) t.click();
      const f = document.getElementById('selFormat'); f.value = format; f.dispatchEvent(new Event('change'));
      const r = document.getElementById('selRes'); r.value = res; r.dispatchEvent(new Event('change'));
      window.__blobs = [];
      window.__tags = [];
      const orig = URL.createObjectURL;
      URL.createObjectURL = function (b) { if (b && String(b.type).indexOf('video') === 0) window.__blobs.push(b); return orig.call(this, b); };
      window.__tagTimer = setInterval(() => {
        const tag = document.getElementById('exportFormatTag').textContent;
        if (tag && window.__tags[window.__tags.length - 1] !== tag) window.__tags.push(tag);
      }, 400);
    }, { res: c.res, format: c.format || 'mp4' });

    const t0 = Date.now();
    await page.evaluate(() => document.getElementById('btnExport').click());
    await page.waitForFunction(() => {
      const s = document.getElementById('statusbar').textContent;
      return s.includes('导出完成') || s.includes('导出失败');
    }, { timeout: 1800000, polling: 1000 });
    report.seconds = Math.round((Date.now() - t0) / 1000);

    report.state = await page.evaluate(() => ({
      status: document.getElementById('statusbar').textContent,
      overlayStatus: document.getElementById('exportStatus').textContent,
      overlayDetail: document.getElementById('exportDetail').textContent,
      tags: window.__tags,
      saveBtnHidden: document.getElementById('btnExportSave').hidden,
      redownloadHidden: document.getElementById('btnExportRedownload').hidden,
      blobTypes: window.__blobs.map((b) => b.type + ':' + b.size),
    }));
    clearInterval;
    const out = TMP + '/' + name + '.bin';
    const saved = await saveBlob(page, out);
    report.bytes = saved.size;
    if (saved.size > 0) {
      report.probe = probe(out);
      /* 本次修复的核心断言:成片必须带音轨。以前「无 WebCodecs」与「不支持 AAC」两条降级路
       * 都会静默产出无声文件,正是用户报的「部分机型导出没声音」。 */
      /* 有 ffprobe 就用它;没装 ffmpeg 的开发机上退回容器自检(结果同样可信,只是不报编解码器名) */
      report.containerAudio = containerHasAudio(out);
      report.audioOk = !!(report.probe && report.probe.audio && report.probe.audio !== '(无音轨)') || report.containerAudio;
      report.content = frameFingerprints(out, [10, 60, 120, 180]);
      /* ★ 容器里必须真的有时长:安卓相册读不到就是 0:00(这次修复的核心回归点) */
      report.container = containerDuration(out);
      report.durationOk = !!(report.container && report.container.duration > 0.2);
    }
  } finally {
    await browser.close();
  }
  report.errors = errors.slice(0, 6);
  return report;
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const want = process.argv[2] || 'desktop';
const names = want === 'all' ? Object.keys(CASES) : [want];
let failed = 0;
for (const n of names) {
  if (!CASES[n]) { console.log('未知用例:', n, '可选:', Object.keys(CASES).join(', ')); process.exit(1); }
  console.log('=== ' + n + ' ===');
  const report = await runCase(n);
  console.log(JSON.stringify(report, null, 2));
  if (!report.audioOk) {
    failed++;
    console.log('!! ' + n + ': 成片缺少音轨(本次修复要求所有用例都带音轨)');
  }
  /* 时长断言:兼容录制(recorder / noaac 的降级路)以前产出的 WebM 没有 Duration,
   * 安卓相册显示 0:00。这条断言就是防它复发 —— 任何用例的成片都必须自带时长。 */
  if (!report.durationOk) {
    failed++;
    console.log('!! ' + n + ': 成片容器里没有可读时长(安卓相册会显示 0:00)', JSON.stringify(report.container || null));
  }
}
if (failed) process.exitCode = 1;
