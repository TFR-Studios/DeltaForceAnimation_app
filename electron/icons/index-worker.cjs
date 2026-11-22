'use strict';
/* 图标索引构建跑在 worker 线程里（与音频索引同理由：1.5 万个 sprite 要读盘解压，
 * 放主进程会把界面卡死）。进度经 postMessage 转发。 */
const { parentPort, workerData } = require('worker_threads');
const { buildIndex } = require('./index.cjs');
const keys = require('../audio/keys.cjs');
const vault = keys.load(workerData.userData);

try {
  const res = buildIndex(workerData.gameRoot, { vault }, (p) => {
    parentPort.postMessage({ type: 'progress', progress: p });
  });
  parentPort.postMessage({ type: 'done', data: res.data, stats: res.stats });
} catch (e) {
  parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
}
