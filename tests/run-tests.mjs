
/**
 * 极简测试运行器（零依赖）。
 *   node tests/run-tests.mjs            # 跑全部
 *   node tests/run-tests.mjs download   # 只跑名字含 download 的用例
 * 用例文件：tests/*.test.mjs，导出 name 与 default async (t) => {}
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = import.meta.dirname;
const filter = (process.argv[2] || '').toLowerCase();
const G = '\u001b[32m', R = '\u001b[31m', Y = '\u001b[33m', D = '\u001b[90m', B = '\u001b[36m', N = '\u001b[0m';

function makeT() {
  const t = {
    name: '',
    passed: 0, failed: 0, logs: [], failures: [], softFailed: false,
    ok(cond, msg) {
      if (cond) { t.passed++; }
      else { t.failed++; t.softFailed = true; t.failures.push(msg || '(ok 断言失败)'); }
    },
    eq(a, b, msg) { t.ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), (msg || 'eq') + ' | 实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b)); },
    deepEq(a, b, msg) { t.ok(JSON.stringify(a) === JSON.stringify(b), (msg || 'deepEq') + ' | 实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b)); },
    async throwsAsync(fn, re, msg) {
      try { await fn(); t.ok(false, (msg || 'throwsAsync') + ' | 期望抛错但没有'); }
      catch (err) {
        const s = String(err && err.message || err);
        t.ok(re ? re.test(s) : true, (msg || 'throwsAsync') + ' | 错误信息不匹配: ' + s);
      }
    },
    log() { t.logs.push(Array.from(arguments).join(' ')); }
  };
  return t;
}

const files = fs.readdirSync(DIR).filter(function (f) { return f.endsWith('.test.mjs'); }).sort();
if (!files.length) { console.log(Y + '没有找到测试文件 tests/*.test.mjs' + N); process.exit(0); }

let totalPass = 0, totalFail = 0, filesOk = 0, filesFail = 0;
const results = [];

for (const file of files) {
  if (filter && !file.toLowerCase().includes(filter)) continue;
  const t = makeT();
  let displayName = file;
  const started = Date.now();
  try {
    const mod = await import(pathToFileURL(path.join(DIR, file)).href);
    displayName = mod.name || file;
    if (typeof mod.default !== 'function') throw new Error('缺少默认导出的 async 测试函数');
    await mod.default(t);
  } catch (err) {
    t.failed++;
    t.softFailed = true;
    t.failures.push('用例异常: ' + (err && err.stack || err));
  }
  const ms = Date.now() - started;
  totalPass += t.passed; totalFail += t.failed;
  if (t.softFailed) filesFail++; else filesOk++;
  results.push({ file: file, name: displayName, pass: t.passed, fail: t.failed, ms: ms, failures: t.failures, logs: t.logs });
}

console.log('');
console.log(B + '══ 漫库 MangaVault 测试报告 ══' + N);
for (const r of results) {
  const tag = r.fail ? R + '✗ FAIL' + N : G + '✓ PASS' + N;
  console.log(tag + '  ' + r.name.padEnd(22) + D + r.file + N + '  ' + r.pass + ' 通过 / ' + r.fail + ' 失败 / ' + r.ms + 'ms');
  for (const f of r.failures) console.log('    ' + R + '→ ' + f + N);
  for (const l of r.logs) console.log('    ' + D + '· ' + l + N);
}
console.log('');
console.log('总计: ' + G + totalPass + ' 通过' + N + ' / ' + (totalFail ? R : D) + totalFail + ' 失败' + N + '  ·  用例文件 ' + filesOk + ' 通过 / ' + filesFail + ' 失败');
process.exit(totalFail ? 1 : 0);
