/* ============================================================================
 * window.dfaeDesktop / window.dfaeDownloads 适配层(对应 electron/preload.cjs)
 *
 * 由 Rust 侧用 initialization_script 注入到每个页面脚本之前,所以页面顶层代码(以及
 * src/main.ts 里 `const desktopDownloads = window.dfaeDownloads` 那一句)都能立刻拿到它。
 *
 * 三条红线与 preload.cjs 一致:
 *   1) 只暴露具名方法,不把任意命令通道交给页面;
 *   2) 不暴露任何写文件/执行命令的通用能力;
 *   3) 只允许 http(s) 走系统浏览器(真正的校验在 Rust 的 dfae_open_external 里)。
 *
 * 返回值形状与 preload.cjs 完全一致,所以 src/ 下的调用代码一行都不用改。
 * ========================================================================== */
(function () {
  'use strict';
  if (window.dfaeDesktop && window.dfaeDownloads) return;

  /* 注入时机早于 Tauri 的全局对象就绪,所以真正调用时才去解析命令通道。 */
  function resolveInvoke() {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke;
    }
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke;
    }
    return null;
  }
  function ready() {
    return new Promise(function (resolve) {
      if (resolveInvoke()) return resolve();
      var tries = 0;
      var timer = setInterval(function () {
        tries += 1;
        if (resolveInvoke() || tries > 200) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
  }
  function call(cmd, args, options) {
    return ready().then(function () {
      var invoke = resolveInvoke();
      if (!invoke) throw new Error('Tauri IPC 不可用(' + cmd + ')');
      return invoke(cmd, args || {}, options);
    });
  }

  /*
   * 导出字节流的专用通道。
   * Tauri 的 IPC 会把参数经 JSON.stringify 序列化(WebView2 不走那套特殊二进制标记),
   * Uint8Array 会被 stringify 成 {"0":1,"1":2,...} 而不是数组,后端按数组解析必然失败。
   * 所以这里**主动**把字节转成真正的数字数组再发:Rust 侧 extract_payload 的一条分支就是为此写的。
   * 代价是大文件要多一次数字数组的内存拷贝 —— 前端本来就有 256MB 的 IPC 直存上限兜着。
   */
  function savePayload(filename, bytes) {
    var arr = [];
    for (var i = 0; i < bytes.length; i += 1) arr.push(bytes[i]);
    return call('dfae_downloads_save', { filename: filename, bytes: arr });
  }

  /* Uint8Array -> base64。分片喂 String.fromCharCode:一次性 apply 整个数组
   * 会因参数过多爆栈(经验值 32KB 一片是安全的)。 */
  function toBase64(bytes) {
    var s = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  /*
   * 移动端的落盘:整份字节以 base64 单串发过去。
   *
   * 为什么不用上面那条数字数组通道:后端会先把 { bytes: [...] } 建成整棵
   * serde_json::Value 树(每个元素约 16 字节),30MB 的导出就是约 5 亿字节 ——
   * 手机进程必然 OOM。而 base64 字符串在 Value 里只是一段连续 String。
   *
   * 为什么不用 Tauri 的 Raw 通道(直接把 Uint8Array 当载荷):本应用的 IPC 走的是
   * WebView 的 postMessage 那条(没有 custom protocol),它只支持 JSON ——
   * 实测 Uint8Array 会被 stringify 成 {"0":..,"1":..},后端根本拿不到 bytes。
   *
   * 落点在 Rust 侧是 MediaStore(系统相册),见 src-tauri/src/mediastore.rs。
   */
  function saveToGallery(filename, bytes) {
    return call('dfae_downloads_save', { filename: filename, data_b64: toBase64(bytes) });
  }

  var downloads = {
    /* 固定为 true:src/main.ts 据此决定要不要显示顶栏那个「下载列表」按钮。 */
    isDesktop: true,

    /** 取列表。deep=true 会额外搜索「被挪到别处的文件」,仅由「找回文件」按钮触发。 */
    list: function (deep) {
      return call('dfae_downloads_list', { deep: !!deep });
    },

    /** 读「每次导出询问保存位置」。关掉(默认)时导出直接落到下载目录。 */
    getPromptOnSave: function () {
      return call('dfae_downloads_list', { deep: false }).then(function (data) {
        return !!(data && data.promptOnSave);
      });
    },

    setPromptOnSave: function (on) {
      return call('dfae_downloads_prompt', { on: !!on });
    },

    /**
     * 导出落盘入口(与 preload.cjs 的 save 同签名)。
     * 返回 { mode:'auto', name, path, entry } 或 { mode:'prompt' }。
     * mode='prompt' 时本适配层会直接弹系统「另存为」,页面的 <a download> 已被拦截,不会重复下载。
     */
    save: function (filename, bytes) {
      var name = String(filename == null ? 'animation.mp4' : filename);
      if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) {
        var payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        /* 手机只有一个落点:系统相册。没有「询问保存位置」这回事,所以不走 prompt 分支。 */
        if (window.__DFAE_MOBILE__) return saveToGallery(name, payload);
        return savePayload(name, payload).then(function (res) {
            if (res && res.mode === 'prompt') return saveAs(payload, name);
            return res;
          });
      }
      return Promise.reject(new Error('save 需要 Uint8Array / ArrayBuffer'));
    },

    /** 重命名(不计扩展名;重名自动加序号,不覆盖)。当前版本入口已移除。 */
    rename: function (id, newName) {
      return call('dfae_downloads_rename', { id: String(id), name: String(newName) });
    },

    /** 删除记录;withFile=true 时连磁盘上的视频一起删。 */
    remove: function (id, withFile) {
      return call('dfae_downloads_remove', {
        id: String(id),
        mode: withFile ? 'file' : 'record'
      });
    },

    /** 在资源管理器里定位(不传 id = 打开下载目录本身)。 */
    reveal: function (id) {
      return call('dfae_downloads_reveal', { id: id ? String(id) : '' });
    },

    /** 用系统默认播放器打开。 */
    open: function (id) {
      return call('dfae_downloads_open', { id: String(id) });
    },

    /**
     * 订阅「导出已落盘」。与 preload.cjs 一样返回取消订阅函数(同步返回,内部等事件系统就绪)。
     * Rust 侧每次落盘后广播 'dfae:downloads-changed'。
     */
    onChanged: function (handler) {
      var unlisten = null;
      var canceled = false;
      ready().then(function () {
        var api = window.__TAURI__ && (window.__TAURI__.event || (window.__TAURI__.webviewWindow && window.__TAURI__.webviewWindow.getCurrentWebviewWindow));
        var listenFn = null;
        if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
          listenFn = window.__TAURI__.event.listen;
        }
        if (!listenFn) {
          /* 事件 API 不可用时退化成「点开面板时再取最新数据」,不影响主流程。 */
          return;
        }
        return listenFn('dfae:downloads-changed', function () {
          try { handler(); } catch (e) { /* 页面自己的异常不该影响主进程 */ }
        }).then(function (un) {
          if (canceled && typeof un === 'function') un();
          else unlisten = un;
        });
      });
      return function () {
        canceled = true;
        if (typeof unlisten === 'function') unlisten();
      };
    }
  };

  /* 「另存为」:由 Rust 侧的 rfd 原生对话框完成,写完照样登记进下载历史并发通知。 */
  function saveAs(bytes, filename) {
    return call('dfae_downloads_save_as', {
      filename: filename,
      bytes: Array.prototype.slice.call(bytes)
    });
  }

  var desktop = {
    /** 固定为 true:页面可据此判断「我正跑在桌面客户端里」而不是浏览器里。 */
    isDesktop: true,
    platform: 'win32',
    /* Electron 专有版本号在 Tauri 下没有对应概念:给出 Tauri 的标识,并保留字段名以免老代码取属性报错。 */
    electronVersion: undefined,
    chromeVersion: undefined,
    shell: 'tauri',
    /** 异步取应用信息(版本号 / 是否打包版 / 下载目录等)。 */
    getInfo: function () {
      return call('dfae_info');
    },
    /** 用系统默认浏览器打开 http(s) 链接;非 http(s) 会被拒绝并返回 false。 */
    openExternal: function (url) {
      return call('dfae_open_external', { url: String(url) });
    },
    /** 在资源管理器里定位某个文件。 */
    revealFile: function (file) {
      return call('dfae_reveal_file', { file: String(file) });
    }
  };

  /*
   * <a download> 拦截。
   * src/main.ts 的兜底路径(关掉自动保存、或文件超过 IPC 直存上限)会走 downloadBlob 造一个
   * blob: 链接点一下。WebView2 的原生下载只会丢进系统「下载」文件夹 —— 既不进应用的下载目录,
   * 也不登记历史、不发通知,和 Electron 版行为不一致。
   * 这里把它接管:先试自动保存(得到重名后缀等真实信息),需要询问时再弹系统「另存为」,
   * 两条路都会登记历史并触发系统通知。任何一步失败都回退成原生下载,绝不让导出成果丢掉。
   */
  var nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var href = this.href || '';
    var name = this.getAttribute('download');
    if (!name || !/^blob:/i.test(href)) return nativeClick.apply(this, arguments);
    var anchor = this;
    var fail = function () { try { nativeClick.call(anchor); } catch (e) { /* 忽略 */ } };
    fetch(href)
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) { return downloads.save(name, new Uint8Array(buf)); })
      .then(function () {
        try { URL.revokeObjectURL(href); } catch (e) { /* 忽略 */ }
      })
      .catch(function (err) { console.warn('[dfae] 接管下载失败,改用原生下载', err); fail(); });
  };

  Object.defineProperty(window, 'dfaeDownloads', {
    value: downloads,
    writable: false,
    configurable: false,
    enumerable: true
  });
  Object.defineProperty(window, 'dfaeDesktop', {
    value: desktop,
    writable: false,
    configurable: false,
    enumerable: true
  });

  /*
   * 落位回执。
   *
   * 为什么需要它:桌面端有 initialization_script,每个文档加载前都会自动跑一遍;
   * Android 上没有等价物,Rust 只能在 setup 里 eval 一次 —— 而那时 WebView 还没开始
   * 加载真正的页面,脚本打在空文档上,随文档被替换就丢了。表现是 window.dfaeDownloads
   * 永远不存在:导出「成功」,可是文件哪儿都没有。
   * Rust 侧(见 src/lib.rs 的注入循环)据此重试,直到收到这个回执为止。
   */
  ready().then(function () {
    var invoke = resolveInvoke();
    if (!invoke) return;
    try { invoke('dfae_bridge_ready', {}); } catch (e) { /* 回执失败不影响桥接层本身 */ }
  });
})();
