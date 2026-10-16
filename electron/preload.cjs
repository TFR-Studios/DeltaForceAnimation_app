/* ============================================================================
 * 预加载脚本:在渲染进程里挂一个只有只读能力的 window.dfaeDesktop。
 *
 * 站点(src/main.ts)本身不需要任何桌面能力就能跑 —— 导出走 Blob + <a download>,
 * 由主进程的下载管线接管。这里提供的接口只用于两件事:
 *   · 自检/排障时读一下运行环境(版本号、是否打包版、目录位置);
 *   · 以后要在页面里加"打开在线站点""在资源管理器里显示文件"这类桌面特有按钮时,
 *     可以直接用 window.dfaeDesktop.openExternal / revealFile,不必再改主进程。
 *
 * 三条红线(改动本文件时请保持):
 *   1. 只暴露具名方法,不暴露 ipcRenderer 本体 —— 否则等于把任意 IPC 通道交给页面;
 *   2. 不暴露任何写文件/执行命令的能力;
 *   3. contextIsolation 保持开启(见 main.cjs),不要往 window 上直接塞对象引用。
 * ========================================================================== */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dfaeDesktop', {
  /** 固定为 true:页面可据此判断"我正跑在桌面客户端里"而不是浏览器里。 */
  isDesktop: true,
  platform: process.platform,
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  /** 异步取应用信息(版本号 / 是否打包版 / 下载目录等),见 main.cjs 的 dfae:info。 */
  getInfo: () => ipcRenderer.invoke('dfae:info'),
  /** 用系统默认浏览器打开 http(s) 链接;非 http(s) 会被主进程拒绝并返回 false。 */
  openExternal: (url) => ipcRenderer.invoke('dfae:open-external', String(url)),
  /** 在资源管理器里定位某个文件。 */
  revealFile: (file) => ipcRenderer.invoke('dfae:reveal-file', String(file)),
});

/* ---------------------------------------------------------------------------
 * 下载列表 / 下载历史(window.dfaeDownloads)
 *
 * 页面上「下载列表」面板的全部数据都从这里来。仍然是逐条具名方法,不暴露 ipcRenderer 本体;
 * 改动时守住上面那三条红线(尤其第 2 条:这里多出来的 remove/rename 只能作用于
 * 主进程登记的下载目录内的文件 —— 具体校验在 downloads.cjs 里,不在这里)。
 *
 * 历史清单由主进程管理(见 electron/downloads.cjs),页面只做展示与转发,
 * 所以刷新页面、甚至重装软件都不会把列表弄丢。
 * ------------------------------------------------------------------------- */
contextBridge.exposeInMainWorld('dfaeDownloads', {
  /** 面板是否可用:页面据此决定要不要显示顶栏那个「下载列表」按钮。 */
  isDesktop: true,
  /** 取列表。deep=true 会额外搜索「被挪到别处的文件」,仅由「找回文件」按钮触发。 */
  list: (deep = false) => ipcRenderer.invoke('dfae:downloads-list', { deep: !!deep }),
  /** 读 / 写「每次导出询问保存位置」。关掉(默认)时导出直接落到下载目录。 */
  getPromptOnSave: async () => !!(await ipcRenderer.invoke('dfae:downloads-list', { deep: false })).promptOnSave,
  setPromptOnSave: (on) => ipcRenderer.invoke('dfae:downloads-prompt', !!on),
  /**
   * 桌面端的导出落盘入口:把字节流传给主进程,由它写进 downloads/ 并登记历史。
   * 返回 { mode:'auto', name, path } 或 { mode:'prompt' }(用户关掉了自动保存,
   * 此时页面自己走 <a download> 弹「另存为」)。
   */
  save: (filename, bytes) => ipcRenderer.invoke('dfae:downloads-save', String(filename), bytes),
  /** 重命名(不计扩展名;重名自动加序号,不覆盖)。 */
  rename: (id, name) => ipcRenderer.invoke('dfae:downloads-rename', String(id), String(name)),
  /** 删除记录;withFile=true 时连磁盘上的视频一起删。 */
  remove: (id, withFile = false) => ipcRenderer.invoke('dfae:downloads-remove', String(id), withFile ? 'file' : 'record'),
  /** 在资源管理器里定位(不传 id = 打开下载目录本身)。 */
  reveal: (id = '') => ipcRenderer.invoke('dfae:downloads-reveal', id ? String(id) : ''),
  /** 用系统默认播放器打开。 */
  open: (id) => ipcRenderer.invoke('dfae:downloads-open', String(id)),
  /** 主进程在导出落盘后广播;返回取消订阅函数。 */
  onChanged: (handler) => {
    const listener = () => { try { handler(); } catch { /* 页面自己的异常不该影响主进程 */ } };
    ipcRenderer.on('dfae:downloads-changed', listener);
    return () => ipcRenderer.removeListener('dfae:downloads-changed', listener);
  },
});
