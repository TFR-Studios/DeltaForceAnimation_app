'use strict';
/* ============================================================================
 * 音频分类（按文件名 / 路径归类）
 * ---------------------------------------------------------------------------
 * 三角洲的 Wwise 媒体命名有规律，但前缀并不总是关键词：
 *   Wpn_ 开头最常见，可也有 Intro_Wpn_MCX_Fire… / MP_Amb_Skyline…
 * 所以规则分两层：先看开头的「主词」，再退一步看名字里是否含「关键片段」。
 * 顺序即优先级，先命中先算；分类只影响筛选和展示，不改变导出行为。
 *
 * 改规则后要把 index.cjs 的 INDEX_VERSION 加一，让旧索引重新扫描。
 * ========================================================================== */

const has = (n, re) => re.test(n);

const CATEGORIES = [
  {
    key: 'voice', label: '语音台词',
    test: (n, v) => v.includes('/WwiseAudio/Localized/') || /^(voice|vocie|vo)[_\- ]?/i.test(n),
  },
  {
    key: 'weapon', label: '武器枪械',
    test: (n) => /^(wpn|weapon|gun|bullet|shell|ammo|mag)/i.test(n) ||
      has(n, /(wpn[_\-]|weapon|rifle|pistol|shotgun|sniper|smg|lmg|dmr|m249|mcx|ak47|qcq|bipod|suppressor)/i),
  },
  {
    key: 'movement', label: '移动脚步',
    test: (n) => /^(footsteps?|mvmnt|movement|step|land|jump|dive|prone|crouch|vault|climb|swim)/i.test(n) ||
      has(n, /(footstep|parachute|_walk|_run|_jump|_land)/i),
  },
  {
    key: 'vehicle', label: '载具引擎',
    test: (n) => /^(vehicle|veh|engine|wheel|tire|track)/i.test(n) ||
      has(n, /(engine|rpm|helicopter|aircraft|propeller|rotor|motorboat|tank|pickup)/i),
  },
  {
    key: 'ambience', label: '环境氛围',
    test: (n) => /^(amb|ambience|ambient|atmo|weather|env|wind|rain|thunder|water|fire|forest|bird|insect)/i.test(n) ||
      has(n, /(amb[_\-]|ambience|atmo|_wind|thunder|_rain)/i),
  },
  {
    key: 'music', label: '音乐配乐',
    /* 音乐的名字比其它类更"不守规矩"：有拼写错的 Muic、有靠 BPM/调号标注的配乐、
     * 有 _MX（music mix）/Stems/Trailer/PV 这类制作术语，也有像 "Unreal Thoughts"
     * 这种纯标题。所以这里除了乐器/曲风词，还吃元信息（体积、时长）。 */
    test: (n, v, m) => {
      if (has(n, /(music|bgm|theme|song|soundtrack|instrument|harmonica|piano|guitar|drum|violin|cello|trumpet|choir)/i)) return true;
      // 注意:Stems 里既有 _MX(音乐分层) 也有 _FX(音效分层)，不能整体算音乐，只认 _MX/mix
      if (has(n, /(bpm|trailer|muic)/i)) return true;
      if (has(n, /(^|[_\- ])mx([_\- ]|$)/i)) return true;
      if (has(n, /(^|[_\- ])mix([_\- ]|$)/i)) return true;
      // 抽奖/开箱：只有循环曲或体积够大才算音乐，动画短音效不算
      if (has(n, /(lottery|luckydraw)/i) && (/loop/i.test(n) || (m && m.size > 1024 * 1024))) return true;
      // 宣传片（PV）的配乐
      if (has(n, /(^|[_\- ])pv([_\- ]|$)/i)) return true;
      // 超过 60 秒的，基本都是配乐（语音台词在更前面就被分走了）
      if (m && m.duration > 60) return true;
      // 纯标题式名字（每个词首字母大写、没有下划线），如 "Unreal Thoughts"
      if (/^[A-Z][A-Za-z0-9]*(?: [A-Z][A-Za-z0-9]*)+$/.test(n)) return true;
      return false;
    },
  },
  {
    key: 'ui', label: '界面交互',
    test: (n) => /^(ui|menu|click|hover|button|notify|notification|toast)/i.test(n) ||
      has(n, /(_ui_|ui\d|lobby|inventory|inv_|itemview|hit_marker|marker)/i),
  },
  {
    key: 'combat', label: '爆炸破坏',
    test: (n) => /^(explosion|explo|blast|destruction|destructible|impact|grenade|bomb|artillery|rumble)/i.test(n) ||
      has(n, /(explosion|explode|blast|_impact|rumble)/i),
  },
  {
    key: 'character', label: '角色技能',
    test: (n) => /^(char|npc|skill|ability|ultimate|emote|gesture|operator|class)/i.test(n) ||
      /^c[0-9]{3}[_\-]/i.test(n) || /^(cs|cinematic)[_\-]/i.test(n),
  },
  {
    key: 'foley', label: '拟音交互',
    test: (n) => /^(foley|reload|bolt|mech|mechanism|door|switch|lever|item|object|container|loot|pickup)/i.test(n) ||
      has(n, /(pouch|_door|elevator|hack|interact|cloth|gear|rustle|equip|holster|inspect|open|close)/i),
  },
];

const OTHER = { key: 'other', label: '其他' };
const ALL = [{ key: 'all', label: '全部' }].concat(CATEGORIES.map((c) => ({ key: c.key, label: c.label })), [OTHER]);

/** 给一条音频算分类 key。 */
function classify(name, vpath, meta) {
  const n = String(name || '').trim();
  const v = String(vpath || '');
  const m = meta && typeof meta === 'object' ? meta : {};
  if (!n) return 'other';
  for (const c of CATEGORIES) {
    try { if (c.test(n, v, m)) return c.key; } catch (e) { /* 规则写错不该让索引挂掉 */ }
  }
  return 'other';
}

function labelOf(key) {
  const hit = ALL.find((c) => c.key === key);
  return hit ? hit.label : OTHER.label;
}

/** 统计每个分类的条数，返回 [{key,label,count}]（不含 all）。 */
function summarize(items) {
  const map = new Map();
  for (const it of items) map.set(it.category || 'other', (map.get(it.category || 'other') || 0) + 1);
  return ALL.filter((c) => c.key !== 'all').map((c) => ({ key: c.key, label: c.label, count: map.get(c.key) || 0 }));
}

module.exports = { CATEGORIES, ALL, OTHER, classify, labelOf, summarize };
