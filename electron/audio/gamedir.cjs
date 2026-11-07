'use strict';
/* ============================================================================
 * 游戏目录定位（三角洲行动 · WeGame 安装）
 * ---------------------------------------------------------------------------
 * 依次尝试：环境变量 > 上次保存的目录 > 常见安装位置 > 注册表 > DFViewer 配置。
 * 全部只读；找不到就让用户手选，不猜。
 * 判定标准是"能看见 DeltaForce/Content/Paks 或 DeltaForce/PackContent/Paks"，
 * 不能只看文件夹名 —— 玩家可能改过安装路径。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const APP_FOLDER = 'DeltaForce(2001918)';

function isValid(dir) {
  if (!dir) return false;
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
  } catch (e) { return false; }
  const probes = [
    ['DeltaForce', 'Content', 'Paks'],
    ['DeltaForce', 'PackContent', 'Paks'],
    ['DeltaForce', 'DeltaForceClient.exe'],
    ['DeltaForceClient.exe'],
  ];
  for (const parts of probes) {
    try { if (fs.existsSync(path.join(dir, ...parts))) return true; } catch (e) {}
  }
  return false;
}

function drives() {
  const out = [];
  for (let c = 67; c <= 90; c++) { // C..Z
    const d = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(d)) out.push(d); } catch (e) {}
  }
  return out;
}

const COMMON_REL = [
  path.join('WeGameApps', 'rail_apps', APP_FOLDER),
  path.join('Program Files', 'WeGameApps', 'rail_apps', APP_FOLDER),
  path.join('Program Files (x86)', 'WeGameApps', 'rail_apps', APP_FOLDER),
  path.join('WeGame', 'rail_apps', APP_FOLDER),
  path.join('Games', 'rail_apps', APP_FOLDER),
  path.join('Tencent', 'WeGameApps', 'rail_apps', APP_FOLDER),
  APP_FOLDER,
];

function fromDfViewer() {
  try {
    const p = path.join(process.env.LOCALAPPDATA || '', 'DFViewer', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cfg && typeof cfg.game_root === 'string' && isValid(cfg.game_root)) return cfg.game_root;
  } catch (e) {}
  return null;
}

function fromRegistry() {
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/s', '/f', 'DeltaForce', '/d'], {
        encoding: 'utf8', timeout: 4000, windowsHide: true,
      });
      const dirs = (out.match(/[A-Za-z]:\\[^\r\n]+/g) || []).filter(isValid);
      if (dirs.length) return dirs[0];
    } catch (e) { /* 注册表没有就跳过 */ }
  }
  return null;
}

/** 返回 { ok, dir, source } —— 找不到时 ok=false。 */
function detect() {
  const env = process.env.DFAE_GAME_DIR;
  if (env && isValid(env)) return { ok: true, dir: env, source: '环境变量' };
  for (const d of drives()) {
    for (const rel of COMMON_REL) {
      const p = path.join(d, rel);
      if (isValid(p)) return { ok: true, dir: p, source: '常见安装位置' };
    }
  }
  const dfv = fromDfViewer();
  if (dfv) return { ok: true, dir: dfv, source: 'DFViewer 配置' };
  const reg = fromRegistry();
  if (reg) return { ok: true, dir: reg, source: '注册表' };
  return { ok: false, dir: null, source: null };
}

module.exports = { detect, isValid, APP_FOLDER };
