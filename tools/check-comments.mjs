/* 找出注释体内部提前出现闭合符的位置(那会结束注释,把后面一整块规则吃掉) */
import fs from 'node:fs';
const css = fs.readFileSync(process.argv[2] || 'src/style.css', 'utf8');
const CLOSE = '*' + '/';
let i = 0, line = 1, bad = [];
while (i < css.length) {
  const c = css[i];
  if (c === '\n') { line++; i++; continue; }
  if (c === '/' && css[i + 1] === '*') {
    const startLine = line;
    let j = i + 2;
    for (;;) {
      if (j >= css.length) { bad.push({ startLine, kind: 'unclosed' }); i = j; break; }
      if (css[j] === '\n') line++;
      if (css[j] === '*' && css[j + 1] === '/') {
        const inner = css.slice(i + 2, j);
        if (inner.includes(CLOSE)) bad.push({ startLine, kind: 'inner-close', at: inner.indexOf(CLOSE) });
        i = j + 2;
        break;
      }
      j++;
    }
    continue;
  }
  i++;
}
console.log(bad.length ? JSON.stringify(bad, null, 1) : 'clean');
