'use strict';
/* 索引构建跑在 worker 线程里：2 万多条要读磁盘 + 解压，放主进程会把界面卡死。 */
const { parentPort, workerData } = require('worker_threads');
const { buildIndex } = require('./index.cjs');
const vault = require('./pakkeys.json');

try {
  const res = buildIndex(workerData.gameRoot, { vault, limit: workerData.limit }, (p) => {
    parentPort.postMessage({ type: 'progress', progress: p });
  });
  parentPort.postMessage({ type: 'done', data: res.data, stats: res.stats });
} catch (e) {
  parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
}
