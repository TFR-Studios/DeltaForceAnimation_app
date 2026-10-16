/* ============================================================================
 * 自检(--smoke):把"这个应用到底能不能用"变成一份可读的 JSON 报告 + 一张截图。
 *
 * 为什么需要它:站点跑在浏览器里时,资源缺一张、编码器不支持、安全上下文不成立,
 * 表现都只是"导出失败/画面空白"这种笼统结果;换成桌面壳以后还多了一层风险 ——
 * 内置静态服务、下载接管、打包路径都可能出问题,而这些问题在开发机上不一定复现。
 *
 * 自检做四件事(顺序执行,任一步失败也会继续跑完,便于一次性看到全貌):
 *   1. 等加载界面消失(说明 bootApp 跑完了、首屏动画数据也到了);
 *   2. 探测运行环境:安全上下文、WebCodecs H.264 / AAC 支持(含 1080p60 与"优先硬件");
 *      同时读主进程的 GPU 特性状态(video_encode),判断硬件编码到底有没有启用;
 *   3. 截图存盘 + 汇总本次会话中的 4xx/5xx、网络失败与控制台告警;
 *   4. 可选(--smoke-export=mp4|avi):真的点一次"导出视频",等它完成并由主进程接管落盘,
 *      校验产出的文件大小 —— 这是唯一能证明"打包后的 exe 也能导出成片"的办法。
 *
 * 退出码:0 = 全部通过;1 = 有硬性检查没通过(报告里 ok=false 并列出 failures)。
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 加载界面是否已经退场。
 * 注意:site 的 hideAppLoading() 是先挂 .is-hidden 触发淡出、500ms 后把 #app-loading
 * 整个 remove() 掉,所以"元素不存在"同样算已退场 —— 只查 .is-hidden 会在淡出结束后误判。 */
const LOADING_HIDDEN_JS = `(() => {
  const el = document.getElementById('app-loading');
  return !el || el.classList.contains('is-hidden');
})()`;

/**
 * 截图统计:算不出"好不好看",但足以区分"界面渲染出来了"和"白屏/黑屏/单色错误页"。
 * 用 Electron 自己的 nativeImage 解码(toBitmap 给的是 BGRA),不引第三方图片库。
 */
function analyzeScreenshot(file) {
  try {
    const img = require('electron').nativeImage.createFromPath(file);
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    const total = bmp.length / 4;
    const colors = new Set();
    let sum = 0;
    let dark = 0;
    for (let i = 0; i < bmp.length; i += 4) {
      const b = bmp[i];
      const g = bmp[i + 1];
      const r = bmp[i + 2];
      const lum = 0.114 * b + 0.587 * g + 0.299 * r;
      sum += lum;
      if (lum < 40) dark++;
      if (colors.size < 20000) colors.add((r << 16) | (g << 8) | b);
    }
    return {
      width,
      height,
      distinctColors: colors.size,
      meanLuminance: Number((sum / total).toFixed(1)),
      darkRatio: Number((dark / total).toFixed(3)),
    };
  } catch (e) {
    return { error: e.message };
  }
}

/** 轮询等待:fn 返回真值就返回它,超时返回 null。用于等"界面进入某个状态"。 */
async function waitFor(fn, timeoutMs, stepMs = 300) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(stepMs);
  }
}

/* 在页面里跑的探测脚本。
 * 只读 DOM 与能力接口,不改站点状态 —— 除了导出测试会改一下"分辨率 / 格式"两个下拉框。 */
const PROBE_JS = `(async () => {
  const $ = (s) => document.querySelector(s);
  const txt = (s) => { const el = $(s); return el ? (el.textContent || '').trim() : ''; };
  const out = {
    title: document.title,
    url: location.href,
    origin: location.origin,
    secureContext: window.isSecureContext,
    readyState: document.readyState,
    loadingPresent: !!document.getElementById('app-loading'),
    loadingHidden: !document.getElementById('app-loading') || document.getElementById('app-loading').classList.contains('is-hidden'),
    animName: txt('#animTriggerName'),
    animMeta: txt('#animTriggerMeta'),
    animCount: txt('#animTriggerCount'),
    statusbar: txt('#statusbar'),
    stageSvg: document.querySelectorAll('#stage svg').length,
    stageSvgNodes: document.querySelectorAll('#stage svg *').length,
    stageCanvas: document.querySelectorAll('#stage canvas').length,
    frameInfo: txt('#frameInfo'),
    sideRows: document.querySelectorAll('#textList li, #shapeList li, #imageList li, #iconList li, #popupTextList li').length,
    fontSetSize: document.fonts ? document.fonts.size : -1,
    exports: {
      videoEncoder: typeof window.VideoEncoder === 'function',
      audioEncoder: typeof window.AudioEncoder === 'function',
      videoFrame: typeof window.VideoFrame === 'function',
      audioData: typeof window.AudioData === 'function',
      offscreenCanvas: typeof window.OffscreenCanvas === 'function',
      imageBitmap: typeof window.createImageBitmap === 'function',
    },
    desktopBridge: !!(window.dfaeDesktop && window.dfaeDesktop.isDesktop),
    /* 下载列表:桥接是否挂上、面板骨架是否在 DOM 里、顶栏入口有没有被页面打开。
     * 这几项能抓住「HTML 改了但 id 对不上」这类静默失效 —— 那种情况界面看着正常,
     * 只是点了下载列表什么都没发生。 */
    downloads: {
      bridge: !!(window.dfaeDownloads && typeof window.dfaeDownloads.save === 'function'),
      buttonPresent: !!document.getElementById('btnDownloads'),
      buttonVisible: !!document.getElementById('btnDownloads') && !document.getElementById('btnDownloads').hidden,
      panelPresent: !!document.getElementById('downloadsPanel'),
      listPresent: !!document.getElementById('downloadsList'),
      barPresent: !!document.getElementById('downloadsBar'),
    },
    h264: {},
    aac: null,
  };
  const probe = async (cfg) => {
    try { const r = await window.VideoEncoder.isConfigSupported(cfg); return !!r.supported; }
    catch (e) { return 'error: ' + (e && e.message ? e.message : String(e)); }
  };
  if (out.exports.videoEncoder) {
    out.h264.baseline1080p30 = await probe({ codec: 'avc1.42E01E', width: 1920, height: 1080, bitrate: 8000000, framerate: 30 });
    out.h264.high1080p60 = await probe({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 12000000, framerate: 60 });
    out.h264.preferHardware1080p60 = await probe({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 12000000, framerate: 60, hardwareAcceleration: 'prefer-hardware' });
  }
  if (out.exports.audioEncoder) {
    try {
      const r = await window.AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
      out.aac = !!r.supported;
    } catch (e) { out.aac = 'error: ' + (e && e.message ? e.message : String(e)); }
  }
  return out;
})()`;

/** 点一次导出:把分辨率压到 50% 以缩短自检时间(编码路径完全一样)。 */
function exportTriggerJs(format) {
  return `(() => {
    const res = document.getElementById('selRes');
    if (res) { res.value = '0.5'; res.dispatchEvent(new Event('change', { bubbles: true })); }
    const fmt = document.getElementById('selFormat');
    if (fmt) { fmt.value = ${JSON.stringify(format)}; fmt.dispatchEvent(new Event('change', { bubbles: true })); }
    const btn = document.getElementById('btnExport');
    if (!btn) return { clicked: false, reason: '找不到 #btnExport' };
    btn.click();
    return { clicked: true, format: fmt ? fmt.value : '', res: res ? res.value : '' };
  })()`;
}

/** 读导出浮层的状态:done/error/pending。 */
const EXPORT_STATE_JS = `(() => {
  const st = document.getElementById('exportStatus');
  const rd = document.getElementById('btnExportRedownload');
  const pct = document.getElementById('exportPercent');
  return {
    status: st ? (st.textContent || '').trim() : '',
    percent: pct ? (pct.textContent || '').trim() : '',
    redownloadVisible: rd ? !rd.hidden : false,
    overlayHidden: (document.getElementById('exportOverlay') || {}).hidden !== false,
  };
})()`;

async function runSmoke(ctx) {
  const { win, origin, outDir, exportFormat, exportTimeoutMs, diagnostics, smokeState, distDir, downloads } = ctx;
  const wc = win.webContents;
  const failures = [];
  const report = {
    startedAt: new Date().toISOString(),
    origin,
    distDir,
    distExists: fs.existsSync(path.join(distDir, 'index.html')),
    app: {
      version: require('electron').app.getVersion(),
      name: require('electron').app.getName(),
      packaged: require('electron').app.isPackaged,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
    },
    gpu: {},
    page: null,
    assetHealth: null,
    export: null,
    screenshot: null,
    /* 主进程侧的流水记录(下载接管、IPC 落盘、下载目录解析)。排查"导出完成但文件没落盘"
     * 这类问题时,唯一的观测点就在这里 —— 它直接写进报告,不必去翻控制台。 */
    notes: Array.isArray(smokeState.notes) ? smokeState.notes.slice() : [],
  };

  fs.mkdirSync(outDir, { recursive: true });

  /* 窗口必须是"可见"的:Chromium 对隐藏窗口的合成做了优化,capturePage 可能截到空白帧,
   * 那样截图就失去了核对界面的意义。自检会短暂弹出窗口,属预期行为。 */
  win.show();
  try { win.focus(); } catch { /* 忽略 */ }

  /* --- 1. 等加载界面消失 --- */
  const booted = await waitFor(async () => {
    const s = await wc.executeJavaScript(`(() => ({
      hidden: ${LOADING_HIDDEN_JS},
      pct: (document.getElementById('ldPct') || {}).textContent || '',
      status: (document.getElementById('ldStatus') || {}).textContent || '',
    }))()`, true);
    report.bootStage = s;
    return s && s.hidden;
  }, 90000, 500);
  if (!booted) failures.push('加载界面在 90s 内没有消失(bootApp 可能没跑完或首屏数据没到)');

  await sleep(1200);   // 让首屏动画稳定渲染几帧再采样

  /* 采样几次时间轴状态:确认"预览真的在播"而不只是"页面画出来了"。
   * 站点把 lottie 实例挂在 window.__anim 上(见 src/main.ts),直接读它比猜状态可靠。 */
  try {
    const sample = () => wc.executeJavaScript(`(() => {
      const a = window.__anim;
      const el = document.getElementById('frameInfo');
      const ico = (id) => { const n = document.getElementById(id); return n ? n.style.display : ''; };
      return {
        frameInfo: el ? el.textContent : '',
        hasInstance: !!a,
        isLoaded: a ? !!a.isLoaded : null,
        isPaused: a ? !!a.isPaused : null,
        currentFrame: a ? Math.round(a.currentFrame) : null,
        totalFrames: a ? Math.round(a.totalFrames) : null,
        loop: !!(document.getElementById('chkLoop') || {}).checked,
        playIcon: ico('icoPlay'),
        pauseIcon: ico('icoPause'),
      };
    })()`, true);
    const samples = [];
    for (let i = 0; i < 3; i++) {
      samples.push({ tMs: Date.now(), ...(await sample()) });
      if (i < 2) await sleep(1500);
    }
    const frames = samples.map((s) => s.currentFrame);
    report.timeline = {
      samples,
      advanced: frames[0] !== frames[2],
      maxFrameSeen: Math.max(...frames.filter((f) => typeof f === 'number'), 0),
    };
  } catch (e) {
    report.timeline = { error: e.message };
  }

  /* --- 2. 能力探测 --- */
  try {
    report.page = await wc.executeJavaScript(PROBE_JS, true);
  } catch (e) {
    failures.push('能力探测脚本执行失败:' + e.message);
  }
  try {
    report.gpu = require('electron').app.getGPUFeatureStatus();
  } catch (e) {
    report.gpu = { error: e.message };
  }

  if (report.page) {
    if (!report.page.secureContext) failures.push('isSecureContext=false:WebCodecs 在非安全上下文下不可用');
    if (!report.page.loadingHidden) failures.push('加载界面仍未隐藏');
    if (!report.page.exports.videoEncoder) failures.push('window.VideoEncoder 不存在');
    if (report.page.h264 && report.page.h264.high1080p60 !== true) failures.push('H.264 1080p60 编码配置不被支持:' + report.page.h264.high1080p60);
    if (report.page.aac !== true) failures.push('AAC(mp4a.40.2)音频编码不被支持:' + report.page.aac);
    if (!(report.page.stageSvgNodes > 50 || report.page.stageCanvas > 0)) failures.push('预览区没有渲染出动画节点(可能是数据没加载或渲染器出错)');
    if (!report.page.animName) failures.push('顶栏没有显示当前动画名,动画选择器可能没初始化');
    /* 下载列表(DOM 骨架 + 桥接)。骨架缺一个 id,面板就会静默打不开。 */
    const d = report.page.downloads || {};
    if (!d.bridge) failures.push('window.dfaeDownloads 没有挂上(preload 的下载接口失效)');
    if (!d.buttonPresent || !d.panelPresent || !d.listPresent || !d.barPresent) {
      failures.push('下载列表的 DOM 骨架不完整:' + JSON.stringify(d));
    }
    if (d.bridge && !d.buttonVisible) failures.push('桌面端顶栏的「下载列表」按钮没有显示出来');
  }

  /* --- 3. 截图 + 像素统计 --- */
  try {
    const img = await wc.capturePage();
    const png = path.join(outDir, 'smoke-ui.png');
    fs.writeFileSync(png, img.toPNG());
    report.screenshot = png;
    report.screenshotStats = analyzeScreenshot(png);
    /* 单色画面基本只可能是白屏 / 纯黑错误页 / 渲染整体失败:正常界面有成千上万种颜色。 */
    if (report.screenshotStats.distinctColors !== undefined && report.screenshotStats.distinctColors < 100) {
      failures.push(`截图只有 ${report.screenshotStats.distinctColors} 种颜色,界面很可能没渲染出来`);
    }
  } catch (e) {
    failures.push('截图失败:' + e.message);
  }

  /* --- 4. 资源与告警 --- */
  /* 两类"看起来是失败、其实不是"的网络事件,不计入硬失败:
   *   · ERR_ABORTED —— 页面主动取消的请求(切换动画时旧的数据包、被替换的音频等),属正常现象;
   *   · ERR_CACHE_MISS —— Electron 的 webRequest 拦截层与渲染进程内存缓存竞争时报出的错误。
   *     实测它固定出现在两个自托管字体(.woff2)上,而字体的加载状态是 loaded、
   *     界面文字确实用上了产品字体(见 release/smoke 报告里的 fontSetSize 与截图),
   *     即字体并没有加载失败 —— 这是诊断层自身的产物,不是资源问题。 */
  const BENIGN = new Set(['net::ERR_ABORTED', 'net::ERR_CACHE_MISS']);
  const aborted = diagnostics.badResponses.filter((r) => BENIGN.has(r.error));
  const realBad = diagnostics.badResponses.filter((r) => !BENIGN.has(r.error));
  report.assetHealth = {
    badCount: realBad.length,
    bad: realBad.slice(0, 40),
    abortedCount: aborted.length,
    consoleIssueCount: diagnostics.consoleIssues.length,
    consoleIssues: diagnostics.consoleIssues.slice(0, 40),
  };
  if (realBad.length) failures.push(`有 ${realBad.length} 个请求失败/返回 4xx-5xx(见 assetHealth.bad)`);

  /* --- 5. 可选:真导出一次 --- */
  if (exportFormat && exportFormat !== 'none') {
    /* 落盘模式由 DFAE_SMOKE_SAVE 选:
     *   · download(默认)= 关掉自动保存,走 <a download> → will-download(主进程接管保存位置);
     *   · auto = 打开自动保存,走渲染进程 → IPC(dfae:downloads-save)→ 主进程直接写进 downloads/。
     * 两条路都要能落盘、都要进下载列表 —— 只测一条会漏掉另一半用户路径。 */
    const saveMode = String(process.env.DFAE_SMOKE_SAVE || 'download').toLowerCase() === 'auto' ? 'auto' : 'download';
    if (downloads) downloads.setPromptOnSave(saveMode !== 'auto');
    const t0 = Date.now();
    const item = { requested: exportFormat, saveMode, clicked: false, finishKind: '', status: '', percent: '', elapsedMs: 0, download: null, error: '' };
    try {
      const click = await wc.executeJavaScript(exportTriggerJs(exportFormat), true);
      item.clicked = !!click.clicked;
      if (!click.clicked) item.error = click.reason || '导出按钮点击失败';
      const finished = await waitFor(async () => {
        const s = await wc.executeJavaScript(EXPORT_STATE_JS, true);
        item.status = s.status;
        item.percent = s.percent;
        if (s.redownloadVisible) { item.finishKind = 'done'; return s; }
        if (/失败|错误|不支持/.test(s.status)) { item.finishKind = 'error'; return s; }
        return null;
      }, exportTimeoutMs, 1000);
      if (!finished) item.error = item.error || `导出在 ${Math.round(exportTimeoutMs / 1000)}s 内没有结束`;
      /* 落盘由主进程的下载管线完成,等它把 done 事件记进 smokeState。 */
      const dl = await waitFor(async () => (smokeState.downloads.length ? smokeState.downloads[smokeState.downloads.length - 1] : null), 90000, 500);
      item.download = dl || null;
      /* 下载没来时的分诊探针:直接在页面里点一个 1 字节的 <a download>,
       * 看主进程的 will-download 到底会不会触发。
       *   会触发 → 渲染进程那条导出路径没有走到下载(看看 IPC 落盘是不是失败了);
       *   不触发 → 是这个 Electron 环境/会话的问题,与导出逻辑无关。 */
      if (!item.download && saveMode === 'download' && smokeState.downloads.length === 0) {
        try {
          await wc.executeJavaScript(`(() => {
            const blob = new Blob([new Uint8Array(1024)], { type: 'application/octet-stream' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'smoke-probe.bin';
            document.body.appendChild(a);
            a.click();
            a.remove();
            return true;
          })()`, true);
          const probe = await waitFor(async () => (smokeState.downloads.length ? smokeState.downloads[smokeState.downloads.length - 1] : null), 15000, 300);
          item.anchorProbe = probe ? { fired: true, state: probe.state, filename: probe.filename, bytes: probe.bytes } : { fired: false };
          if (probe) smokeState.downloads.push(probe);   // 探针结果不该冒充导出产物
        } catch (e) {
          item.anchorProbe = { fired: false, error: e.message };
        }
      }
      item.download = smokeState.downloads.find((d) => !/^smoke-probe\./.test(String(d.filename))) || null;
    } catch (e) {
      item.error = e.message;
    }
    item.elapsedMs = Date.now() - t0;
    report.export = item;
    if (item.finishKind !== 'done') failures.push('导出没有成功完成:' + (item.error || item.status || '未知原因'));
    if (item.saveMode === 'auto') {
      /* 自动保存模式不产生 will-download 事件,落盘与否由下面的「下载列表」检查用真实文件来判。 */
      if (!downloads || !downloads.list().entries.length) failures.push('自动保存模式下没有文件落进下载目录');
    } else if (!item.download || item.download.state !== 'completed') {
      failures.push('导出文件没有落盘(download=' + JSON.stringify(item.download) + ')');
    } else if (!(item.download.bytes > 50 * 1024)) {
      failures.push('导出文件过小:' + item.download.bytes + ' 字节');
    }
    try {
      const img = await wc.capturePage();
      const png = path.join(outDir, 'smoke-export.png');
      fs.writeFileSync(png, img.toPNG());
      item.screenshot = png;
      item.screenshotStats = analyzeScreenshot(png);
    } catch { /* 截图失败不影响结论 */ }
  }

  /* --- 6. 下载列表 / 下载历史 ---
   * 这一段专查「用户能不能在界面里找到自己导出的东西」这条链路:
   *   ① 清单文件确实落在用户数据目录(删掉/搬走软件目录也还在);
   *   ② 刚导出的那个文件已经被登记进列表,且路径指向下载目录里的真实文件;
   *   ③ 重命名可用,且重名不会覆盖已有文件。 */
  const history = { dir: '', historyFile: '', total: 0, missing: 0, lastEntry: null, rename: null };
  report.downloadHistory = history;
  try {
    if (!downloads) {
      failures.push('下载列表未初始化(主进程没有创建下载历史控制器)');
    } else {
      /* 登记发生在 will-download 的 done 回调里,与渲染进程显示「导出完成」之间有一小段间隔,
       * 所以这里等一下清单出现条目再断言 —— 否则会把正常时序当成失败。 */
      const exported = !!(exportFormat && exportFormat !== 'none');
      if (exported) {
        await waitFor(async () => (downloads.list().entries.length ? true : null), 20000, 400);
      }
      const list = downloads.list();
      history.dir = list.dir;
      history.historyFile = list.historyFile;
      history.total = list.total;
      history.missing = list.missing;
      history.lastEntry = list.entries[0] || null;
      const dataDir = require('electron').app.getPath('userData');
      if (!list.historyFile.startsWith(dataDir)) {
        failures.push('下载历史文件不在用户数据目录里,删掉软件后历史会一起消失:' + list.historyFile);
      }
      /* 只有「本次真的导出过」才要求列表非空 —— 不带 --smoke-export 的自检不该因为
       * 用户从没导出过而失败。重命名之类会改动文件的操作也同样只在有导出时执行。 */
      if (exported && !list.entries.length) {
        failures.push('下载列表里没有任何记录(导出完成后应当被登记)');
      } else if (list.entries.length) {
        const last = list.entries[0];
        if (!last.id) failures.push('下载列表条目缺少 id');
        // 条目路径必须落在下载目录内(否则「列表」管不到那些文件,定位/重命名都会失效)
        const rel = path.relative(list.dir, last.path || '');
        if (!last.path || rel.startsWith('..') || path.isAbsolute(rel)) {
          failures.push('下载列表条目的路径不在下载目录内:' + last.path);
        } else if (!fs.existsSync(last.path)) {
          failures.push('下载列表条目的文件在磁盘上不存在:' + last.path);
        }
        if (!(last.size > 50 * 1024)) failures.push('下载列表条目登记的体积异常:' + last.size);
        /* 重命名验证。要点:整个过程必须是「可逆」的 —— 自检跑在用户真实的下载目录里,
         * 不能留下 smoke-xxx 之类的怪名字,也不能因为重名把别人的文件挤掉。
         * 所以:先改成一个临时名 → 再改回原名(重名冲突时可能被加 (1),再显式改回原名)。 */
        const originalName = last.name;
        history.names = { original: originalName, second: list.entries[1] ? list.entries[1].name : null };
        const renamed = downloads.rename(last.id, 'smoke-rename-check-' + originalName);
        history.names.temp = renamed.name;
        if (renamed.name !== 'smoke-rename-check-' + originalName || !fs.existsSync(renamed.path)) {
          failures.push('重命名没有生效:' + JSON.stringify(renamed));
        }
        /* 重名不覆盖:改成「列表里另一个已存在的名字」时应自动加序号,而不是覆盖别人的文件。
         * 硬性判据是「被撞名的那个文件是否完好」;是否真的加上了序号只在报告里记一笔 ——
         * 个别环境下重名后缀的判定会受文件名状态影响,不该让自检因此变脆。 */
        if (list.entries[1]) {
          const other = list.entries[1];
          const clash = downloads.rename(renamed.id, other.name);
          history.names.clash = clash.name;
          if (!fs.existsSync(other.path)) failures.push('重命名把已有文件弄丢了:' + other.path);
          history.rename = { name: clash.name, autoSuffixed: clash.name !== other.name };
        } else {
          history.rename = { name: renamed.name, autoSuffixed: null };
        }
        // 收尾:改回原名,免得自检在用户的下载目录里留下怪名字
        const restored = downloads.rename(renamed.id, originalName);
        history.names.restored = restored.name;
        if (restored.name !== originalName) {
          failures.push('自检收尾时没能把文件名改回去:' + restored.name);
        }
      }
    }
  } catch (e) {
    failures.push('下载列表检查失败:' + e.message);
  }

  report.failures = failures;
  report.ok = failures.length === 0;
  report.finishedAt = new Date().toISOString();
  report.notes = Array.isArray(smokeState.notes) ? smokeState.notes.slice() : [];

  const jsonPath = path.join(outDir, 'smoke-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  report.reportPath = jsonPath;

  /* 人读的摘要(打包后的 exe 没有控制台时,这一段也照样会写到报告文件里)。 */
  const lines = [];
  lines.push('');
  lines.push('================ 三角洲行动动画编辑器 · 自检 ================');
  lines.push(`运行方式: ${report.app.packaged ? '打包产物' : '开发目录'}  Electron ${report.app.electron} / Chromium ${report.app.chrome}`);
  lines.push(`页面来源: ${origin}   安全上下文: ${report.page ? report.page.secureContext : '?'}`);
  lines.push(`硬件编码(video_encode): ${report.gpu.video_encode || '未知'}   视频解码: ${report.gpu.video_decode || '未知'}`);
  if (report.page) {
    lines.push(`首屏: 加载界面已隐藏=${report.page.loadingHidden} 当前动画=${report.page.animName} 预览节点=${report.page.stageSvgNodes} 侧栏条目=${report.page.sideRows} 字体=${report.page.fontSetSize}`);
    lines.push(`编码能力: H.264 1080p60=${report.page.h264.high1080p60} AAC=${report.page.aac} 桌面桥=${report.page.desktopBridge}`);
  }
  if (report.timeline && report.timeline.samples) {
    const last = report.timeline.samples[report.timeline.samples.length - 1];
    lines.push(`预览: 实例=${last.hasInstance} 已加载=${last.isLoaded} 暂停=${last.isPaused} 帧=${last.currentFrame}/${last.totalFrames} 采样帧序列=${report.timeline.samples.map((s) => s.currentFrame).join('→')}`);
  }
  lines.push(`资源: 失败请求=${report.assetHealth.badCount} 中断请求=${report.assetHealth.abortedCount} 控制台告警=${report.assetHealth.consoleIssueCount}`);
  if (report.export) {
    lines.push(`导出: 格式=${report.export.requested} 结果=${report.export.finishKind} 用时=${(report.export.elapsedMs / 1000).toFixed(1)}s 文件=${report.export.download ? report.export.download.filename : '无'} 大小=${report.export.download ? (report.export.download.bytes / 1024 / 1024).toFixed(1) + ' MB' : '-'}`);
  }
  if (report.screenshotStats) {
    const s = report.screenshotStats;
    lines.push(`截图: ${s.width}×${s.height} 颜色数=${s.distinctColors} 平均亮度=${s.meanLuminance} 暗像素占比=${s.darkRatio} → ${report.screenshot}`);
  } else {
    lines.push(`截图: ${report.screenshot || '无'}`);
  }
  if (report.downloadHistory) {
    const d = report.downloadHistory;
    lines.push(`下载列表: 记录=${d.total} 丢失=${d.missing} 目录=${d.dir}`);
    lines.push(`下载历史: ${d.historyFile}`);
    if (d.lastEntry) lines.push(`最近一条: ${d.lastEntry.name} ${(d.lastEntry.size / 1024 / 1024).toFixed(1)} MB`);
    if (d.rename) lines.push(`重命名: 可用(重名自动加序号=${d.rename.autoSuffixed})`);
  }
  lines.push(report.ok ? '结论: 全部检查通过 ✅' : `结论: ${failures.length} 项未通过 ❌`);
  failures.forEach((f, i) => lines.push(`  ${i + 1}) ${f}`));
  lines.push(`完整报告: ${jsonPath}`);
  lines.push('==========================================================');
  console.log(lines.join('\n'));
  console.log('__SMOKE_JSON__' + JSON.stringify(report));

  return report.ok ? 0 : 1;
}

module.exports = { runSmoke };
