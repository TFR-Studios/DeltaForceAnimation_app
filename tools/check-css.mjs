/* 检查 CSS 注释是否成对(防止未闭合的 /* 把后面的规则整段吃掉) */
import fs from 'node:fs';
const css = fs.readFileSync(process.argv[2] || 'src/style.css', 'utf8');
let depth = 0, line = 1, problems = [];
for (let i = 0; i < css.length; i++) {
  const c = css[i];
  if (c === '\n') line++;
  if (c === '/' && css[i + 1] === '*') { depth++; if (depth > 1) problems.push('嵌套注释 at line ' + line); i++; continue; }
  if (c === '*' && css[i + 1] === '/') { depth--; if (depth < 0) problems.push('多余闭合 at line ' + line); i++; continue; }
}
console.log('最终嵌套层数:', depth, depth === 0 ? '(成对)' : '(有未闭合的注释!)');
console.log('问题:', problems.length ? problems.join(' | ') : '无');
/* 括号平衡 */
const braces = (css.match(/\{/g) || []).length - (css.match(/\}/g) || []).length;
console.log('花括号差值:', braces, braces === 0 ? '(平衡)' : '(不平衡!)');
