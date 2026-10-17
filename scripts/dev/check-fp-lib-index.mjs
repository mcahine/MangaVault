// scripts/dev/check-fp-lib-index.mjs —— 只读自检：真实全库指纹索引是否被快速模式污染。
// 背景：build-fp.py 无条件把本次 index 写进 <libFp>/index.json，而完整扫描的重建判据只是
// existsSync(fpLib/index.json)。快速模式（只为候选章节建指纹）一旦写进真实目录，就会把
// 1236 条的索引覆盖成十几条 -> 之后完整扫描误判「指纹还在」并跳过重建 -> 静默退化。
// 这里按「index.json 条数 vs 目录里 .bin 数量」的落差把这种不一致报出来。
import fs from 'node:fs';
import path from 'node:path';
const root = path.join(process.env.LOCALAPPDATA || '', 'MangaVault', 'dedupe', 'tmp');
const t = function (c, m) { console.log((c ? '[通过] ' : '[失败] ') + m); return c; };
let bad = 0;
function check(name, dir) {
  const indexFile = path.join(dir, 'index.json');
  if (!fs.existsSync(dir)) { console.log('[跳过] ' + name + ' 目录不存在: ' + dir); return; }
  const bins = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.bin'); }).length;
  let n = -1;
  if (fs.existsSync(indexFile)) { try { n = JSON.parse(fs.readFileSync(indexFile, 'utf8')).length; } catch (e) { n = -2; } }
  console.log('[信息] ' + name + ' bin=' + bins + ' index条数=' + n + ' ' + dir);
  if (bins > 0 && n !== bins) { bad++; console.log('[失败] ' + name + ' 索引条数与 .bin 数量不一致 -> 完整扫描会误判「指纹还在」而跳过重建，实际只比了十几章'); }
  else if (bins > 0) t(true, name + ' 索引与 .bin 数量一致（' + bins + '）');
}
/** fp-dup 从来没有 index.json（build-fp.py 只给 lib_fp 写索引），所以只报信息不判定失败。 */
function checkDupInfo(name, dir) {
  if (!fs.existsSync(dir)) { console.log('[跳过] ' + name + ' 目录不存在'); return; }
  const bins = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.bin'); }).length;
  console.log('[信息] ' + name + ' bin=' + bins + '（该目录按设计没有 index.json）');
}
check('全库指纹 fp-lib', path.join(root, 'fp-lib'));
checkDupInfo('查重侧指纹 fp-dup', path.join(root, 'fp-dup'));
const iso = ['fp-fast-lib', 'fp-fast-dup'].map(function (d) { return d + '=' + (fs.existsSync(path.join(root, d)) ? '存在' : '不存在'); }).join(' ');
console.log('[信息] 快速模式隔离目录: ' + iso);
console.log(bad ? ('发现 ' + bad + ' 处指纹索引不一致（建议在查重页点「重新扫描」并勾选重建指纹）') : '指纹索引自检通过');