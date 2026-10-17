// scripts/dev/repair-fp-lib-index.mjs —— 修复被快速模式污染的全库指纹索引。
// 背景：build-fp.py 无条件把本次 index 写进 <libFp>/index.json，而完整扫描的重建判据只是
// existsSync(fpLib/index.json)。历史版本的快速模式一旦写进真实目录，就会把 1236 条的索引
// 覆盖成十几条 —— 之后完整扫描误判「指纹还在」而跳过重建，静默退化成只比十几章。
// 本脚本只重写 index.json 这**一个**文件，1236 个 .bin 指纹一个字节都不动。
// 索引内容用项目自己的 collectLibJobs() 生成，保证与完整构建写出来的格式完全一致。
import path from 'node:path';
import fsp from 'node:fs/promises';
import { collectLibJobs } from '../../src/modules/dedupe/engine/build-fp.mjs';
import { resolvePaths } from '../../src/modules/dedupe/engine/paths.mjs';
import { loadConfig, dataDir } from '../../src/core/config.mjs';
import { atomicWriteJson } from '../../src/core/util.mjs';

const cfg = await loadConfig(true);
const paths = resolvePaths(cfg, dataDir());
const indexFile = path.join(paths.fpLib, 'index.json');

const before = await fsp.readFile(indexFile, 'utf8').then(function (t) { return JSON.parse(t).length; }).catch(function () { return -1; });
const bins = (await fsp.readdir(paths.fpLib)).filter(function (f) { return f.endsWith('.bin'); }).length;
const collected = await collectLibJobs(paths.libRoots, paths.fpLib);
const index = collected.index || [];
console.log('库根: ' + paths.libRoots.map(function (r) { return r.id + ':' + r.path; }).join(' | '));
console.log('修复前 index 条数=' + before + '，目录内 .bin=' + bins + '，重新登记章节=' + index.length);
if (!index.length) { console.error('登记到 0 个章节，拒绝写入（库根可能没配好）'); process.exitCode = 1; }
else {
  await atomicWriteJson(indexFile, index);
  const after = JSON.parse(await fsp.readFile(indexFile, 'utf8')).length;
  const binsAfter = (await fsp.readdir(paths.fpLib)).filter(function (f) { return f.endsWith('.bin'); }).length;
  console.log('修复后 index 条数=' + after + '，目录内 .bin=' + binsAfter + (after === binsAfter ? ' —— 一致，完整扫描不会再有误判' : ' —— 仍不一致（可能有章节没有图片或是新增章节，属正常）'));
  process.exitCode = after > 0 ? 0 : 1;
}
