/* 语法门禁：确认 plugin.js 的 Host / Client 两半都能被 DSH 正常求值。
 * DSH 把每一半当作函数体执行（内部没有 import/require、没有 TS 转换），
 * 所以这里用同样的方式解析；只做语法检查，不执行。
 *   node check-plugin.cjs
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'plugin.js'), 'utf8');
const MARK = ' * CLIENT 半边';

let fails = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log('ok   ' + name);
  else { fails++; console.log('FAIL ' + name + (extra === undefined ? '' : '  -> ' + extra)); }
};

const split = src.indexOf(MARK);
ok('找到 Host / Client 分界标记', split > 0, 'index=' + split);
if (split <= 0) process.exit(1);

const commentStart = src.lastIndexOf('/* =', split);
const hostHalf = src.slice(0, commentStart);
const clientHalf = src.slice(commentStart);

function parseHalf(label, body) {
  try {
    // 与 DSH 相同：函数体 + return 一个 Cordis Plugin
    new Function(body);
    return true;
  } catch (e) {
    console.log('     ' + label + ' 解析失败：' + (e && e.message));
    return false;
  }
}

ok('Host 半边可解析', parseHalf('Host', hostHalf));
ok('Client 半边可解析', parseHalf('Client', clientHalf));
ok('Host 返回插件对象', /return\s*\{/.test(hostHalf) && /inject:/.test(hostHalf));
ok('Client 返回插件对象', /return\s*\{/.test(clientHalf) && /slots\.register/.test(clientHalf));

// 两半都不应出现被沙箱禁用的写法
for (const [label, half] of [['Host', hostHalf], ['Client', clientHalf]]) {
  ok(label + ' 无 import/require', !/\b(import\s|require\()/.test(half));
  ok(label + ' 无全局 fetch', !/[^.\w]fetch\s*\(/.test(half));
  ok(label + ' 无裸定时器', !/[^.\w](setTimeout|setInterval)\s*\(/.test(half));
  ok(label + ' 无 JSX', !/<[A-Z][\w]*[\s/>]/.test(half));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);
