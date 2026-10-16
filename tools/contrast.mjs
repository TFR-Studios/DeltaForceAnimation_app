/* 设计令牌的对比度参考表(与 src/style.css 的两套主题同步)。
 * 只打印结论、永远 exit 0 —— 它是"选色时的核对清单",不是断言。
 * 改配色时同步更新本表,否则它会把误导性的数字留给下一个人。
 * 判据:正文/控件文字 >= 4.5:1,大字(>=18.66px 或 >=14px 粗体)>= 3:1。
 * 用法:node tools/contrast.mjs
 */
const hex2rgb = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (h) => { const [r, g, b] = hex2rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };

/* 两套主题的七个中性锚点(与 style.css 的令牌一一对应) */
const D = { bg: '#242424', surface: '#2b2b2e', surface2: '#333336', line: '#3e3e42', text: '#f2f2f4', text2: '#c3c3c9', text3: '#9b9ba3', brand: '#e2e2e8', onBrand: '#1a1a1c', danger: '#ff99a4', warn: '#f9d67a', ok: '#54d6a4' };
const L = { bg: '#eaeaf0', surface: '#ffffff', surface2: '#f7f7fa', inset: '#e4e4ec', line: '#c6c6d0', text: '#242424', text2: '#4b4b52', text3: '#5f5f68', brand: '#4a4a52', onBrand: '#ffffff', danger: '#a4262c', warn: '#8a5a00', ok: '#0b6a45' };

const cases = [
  ['dark  正文 on 页面底', D.text, D.bg],
  ['dark  次要文字 on 面板', D.text2, D.surface],
  ['dark  三级文字 on 面板', D.text3, D.surface],
  ['dark  三级文字 on 控件底', D.text3, D.surface2],
  ['dark  品牌面文字', D.onBrand, D.brand],
  ['dark  danger on 面板', D.danger, D.surface],
  ['dark  warn on 面板', D.warn, D.surface],
  ['dark  ok on 面板', D.ok, D.surface],
  ['dark  正文 on 控件底', D.text, D.surface2],
  ['light 正文 on 页面底', L.text, L.bg],
  ['light 次要文字 on 面板', L.text2, L.surface],
  ['light 三级文字 on 面板', L.text3, L.surface],
  ['light 三级文字 on 控件底', L.text3, L.surface2],
  ['light 三级文字 on 内嵌槽', L.text3, L.inset],
  ['light 正文 on 内嵌槽', L.text, L.inset],
  ['light 次要文字 on 内嵌槽', L.text2, L.inset],
  ['light 品牌面文字', L.onBrand, L.brand],
  ['light danger on 面板', L.danger, L.surface],
  ['light warn on 面板', L.warn, L.surface],
  ['light ok on 面板', L.ok, L.surface],
  ['light 正文 on 控件底', L.text, L.surface2],
  /* 描边不是文字,只做"看得见"的参考(>=1.3 即可分辨边界) */
  ['dark  分隔线 on 页面底', D.line, D.bg],
  ['light 分隔线 on 页面底', L.line, L.bg],
];

let worst = Infinity, fails = 0;
for (const [name, fg, bg] of cases) {
  const r = ratio(fg, bg);
  const isLine = name.includes('分隔线');
  const need = isLine ? 1.3 : 4.5;
  const pass = r >= need - 1e-9;
  if (!isLine) { worst = Math.min(worst, r); if (!pass) fails++; }
  console.log(name.padEnd(26) + fg + ' on ' + bg + '  ' + r.toFixed(2).padStart(6) + '  ' + (pass ? 'OK' : 'FAIL') + (isLine ? ' (边界参考,非文字)' : ''));
}
console.log('\n最低正文对比度 ' + worst.toFixed(2) + ':1,未达标 ' + fails + ' 项(阈值 4.5:1)。');
