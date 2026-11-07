'use strict';
/* 音频提取功能的本地设置（游戏目录、导出目录）。存在 userData 下，不进程序目录。 */
const fs = require('fs');
const path = require('path');

function file(userData) { return path.join(userData, 'audio-extract.json'); }

function load(userData) {
  try { return JSON.parse(fs.readFileSync(file(userData), 'utf8')); } catch (e) { return {}; }
}

function save(userData, patch) {
  const cur = load(userData);
  const next = Object.assign({}, cur, patch);
  try { fs.mkdirSync(userData, { recursive: true }); } catch (e) {}
  fs.writeFileSync(file(userData), JSON.stringify(next, null, 2));
  return next;
}

module.exports = { load, save, file };
