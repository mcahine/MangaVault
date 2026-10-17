// tests/dedupe-fast.test.mjs —— 快速查重（v7）契约测试。
// 为什么必须有：快速模式是「只为候选建指纹、只比候选章节」的新链路，
// 历史 bug 恰好都出在「下标/配对/字段缺一半」这类看不见的地方
//（指纹签名只认 mtime+字节+张数，只为候选建指纹会让同一 .bin 的张数变少，
//  不 force 就会读到整章旧指纹导致区间全部错位）。这里用合成指纹文件把配对逐张钉死。
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { STAGES, STAGE_WEIGHTS, STAGE_LABEL } from '../src/modules/dedupe/engine/runner.mjs';
import {
  computeCoverageOf, loadCandidateFingerprints, isCandidateWorth,
  buildFastSamples, MAX_FAST_CHAPTERS, MAX_FAST_SAMPLES, runFastStage
} from '../src/modules/dedupe/engine/pipeline.mjs';
import { invOf, grayStats } from '../src/modules/dedupe/engine/match.mjs';
import { readSet } from '../src/modules/dedupe/engine/fpio.mjs';

export const name = '快速查重（v7 元数据预筛 + 候选章节比对）';

const GRAY = 1024;
const LEVEL = 128;

/**
 * 去掉注释与三类字符串字面量，只留「代码骨架」。
 * 为什么必须逐字符状态机：用正则一次性替换会把中文与 \w 混排处的末字符吃掉，
 * 产出满屏假命中（本仓库踩过：每个单词都被截掉末字母，如 accoun / accountLoadin）。
 */
function stripForFast(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      const q = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** 造一个指纹 .bin：int32 条数 + 每条 { int32 名字长度, UTF8 名字, int32 宽, int32 高, 1024 灰度 }。 */
function writeBin(file, entries) {
  const parts = [];
  const head = Buffer.alloc(4);
  head.writeInt32LE(entries.length, 0);
  parts.push(head);
  for (const e of entries) {
    const nb = Buffer.from(e.name, 'utf8');
    const nl = Buffer.alloc(4); nl.writeInt32LE(nb.length, 0); parts.push(nl, nb);
    const wh = Buffer.alloc(8); wh.writeInt32LE(1024, 0); wh.writeInt32LE(1024, 4); parts.push(wh);
    // grad=true 造「半页 30 / 半页 200」的有方差页（标准差 85），用于验证 linv > 0；否则是全平坦页（sd=0）
    const page = Buffer.alloc(GRAY, e.level == null ? LEVEL : e.level);
    if (e.grad) { page.fill(30, 0, GRAY / 2); page.fill(200, GRAY / 2); }
    parts.push(page);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(parts));
}

/** 按 engine/match.mjs 的 loadLibraryFingerprints 同形造一份库指纹视图。
 *  linv/lnrm 必须补齐：zMadOf 会读 lib.linv[i] / lib.lnrm[i]，缺了会抛 TypeError（本测试第一版就踩了这个）。 */
function fakeLib(chapters) {
  const names = [];
  const chOf = [];
  const grayParts = [];
  chapters.forEach(function (c, ci) {
    for (const name of c.names) {
      names.push(name);
      chOf.push(ci);
      grayParts.push(Buffer.alloc(GRAY, c.level == null ? LEVEL : c.level));
    }
  });
  const views = [];
  let start = 0;
  chapters.forEach(function (c, ci) {
    views.push({
      key: 'k' + ci, dir: c.dir, comic: c.comic || '漫画', title: c.title || '',
      rootId: 'picacg', rootName: '哔咔', rootPath: 'C:\\lib',
      start: start, count: c.names.length
    });
    start += c.names.length;
  });
  const N = names.length;
  const gray = Buffer.concat(grayParts, N * GRAY);
  const lmean = new Float32Array(N);
  const lsd = new Float32Array(N);
  const linv = new Float32Array(N);
  const lnrm = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const st = grayStats(gray, i * GRAY);
    const iv = invOf(st.sd);
    lmean[i] = st.m; lsd[i] = st.sd; linv[i] = iv; lnrm[i] = st.m * iv;
  }
  return { chapters: views, names: names, chOf: chOf, gray: gray, coarse: null, lmean: lmean, lsd: lsd, linv: linv, lnrm: lnrm, N: N, map: null };
}

export default async function (t) {
  const root = path.join(os.tmpdir(), 'mv-fast-' + process.pid + '-' + Date.now());
  fs.mkdirSync(root, { recursive: true });
  try {
    // ---------- (a) runner 契约：fast 必须注册为可用阶段 ----------
    t.ok(STAGES.indexOf('fast') >= 0, '(a1) STAGES 含 fast');
    t.eq(STAGES[0], 'fast', '(a2) fast 排在首位（界面上是日常主推模式）');
    t.eq(STAGE_WEIGHTS.fast && STAGE_WEIGHTS.fast.fast, 1, '(a3) STAGE_WEIGHTS.fast = { fast: 1 }');
    t.ok(/快速查重/.test(STAGE_LABEL.fast || ''), '(a4) STAGE_LABEL.fast 有中文标签: ' + STAGE_LABEL.fast);
    t.eq(STAGES.length, 5, '(a5) 阶段总数 5（fast/full/hash/pixel/thumbs）');
    t.eq(Object.keys(STAGE_WEIGHTS.fast).length, 1, '(a6) fast 阶段权重只有一项，不与完整扫描权重混淆');

    // ---------- (b) 按自然序号配对，而不是按文件名 ----------
    const lib = fakeLib([{ dir: 'C:\\lib\\作品\\1 第1話', names: ['001.jpg', '002.jpg', '003.jpg'] }]);
    const fpFile = path.join(root, 'dup.bin');
    writeBin(fpFile, [{ name: '00000001.webp' }, { name: '00000002.webp' }, { name: '00000003.webp' }]);
    const fp = readSet(fpFile);
    const dupFiles = ['00000001.webp', '00000002.webp', '00000003.webp'];
    const cov = computeCoverageOf(lib, dupFiles, fp, lib.chapters[0], 8);
    t.eq(cov.pixel, 3, '(b1) 同亮度灰度全部命中（文件名完全不同也照样配对）');
    t.eq(cov.cov, 1, '(b2) 覆盖率 = 1');
    t.eq(cov.pairs['00000002.webp'].n, 1, '(b3) 第 2 张查重图配到库侧第 2 张（下标 1）');

    // 库侧多一张封面：整段错位一位，按文件名配会全灭，按序号配仍应命中
    const libOff = fakeLib([{ dir: 'C:\\lib\\作品\\1 第1話', names: ['cover.jpg', '001.jpg', '002.jpg', '003.jpg'] }]);
    const covOff = computeCoverageOf(libOff, dupFiles, fp, libOff.chapters[0], 8);
    t.eq(covOff.pixel, 3, '(b4) 库侧多一张封面导致错位时，仍按序号配对命中 3 张');

    // 亮度差得远时必须不命中（阈值真的起作用）
    const darkLib = fakeLib([{ dir: 'C:\\lib\\作品\\1 第1話', names: ['001.jpg', '002.jpg', '003.jpg'], level: 10 }]);
    const covDark = computeCoverageOf(darkLib, dupFiles, fp, darkLib.chapters[0], 8);
    t.eq(covDark.pixel, 0, '(b5) 灰度差 118 级时零命中（不是无脑全通过）');

    // 查重侧比库侧多的尾部页：没有配对对象，不能算命中，也不能越界
    const covMore = computeCoverageOf(lib, dupFiles.concat(['00000004.webp']), fp, lib.chapters[0], 8);
    t.eq(covMore.pixel, 3, '(b6) 查重侧多出的尾部页不参与命中');
    t.eq(covMore.total, 4, '(b7) 覆盖率分母是查重侧张数');
    t.eq(Math.round(covMore.cov * 100) / 100, 0.75, '(b8) cov = 3/4');
    t.eq(computeCoverageOf(null, dupFiles, fp, lib.chapters[0], 8).cov, 0, '(b9) 库视图为空时返回 cov=0，不抛错');
    t.eq(computeCoverageOf(lib, dupFiles, fp, null, 8).pixel, 0, '(b10) 章节为空时返回 0 命中');

    // ---------- (c) 只装载候选章节的指纹（下标必须从 0 重新起算） ----------
    const fpLib = path.join(root, 'fp-lib');
    const dirA = 'C:\\lib\\A\\1';
    const dirB = 'C:\\lib\\B\\1';
    writeBin(path.join(fpLib, 'aaaa.bin'), [{ name: '001.jpg', level: 30 }]);
    writeBin(path.join(fpLib, 'bbbb.bin'), [{ name: '001.jpg', level: LEVEL }, { name: '002.jpg', grad: true }]);
    writeBin(path.join(fpLib, 'cccc.bin'), [{ name: '001.jpg', level: 30 }]);
    fs.writeFileSync(path.join(fpLib, 'index.json'), JSON.stringify([
      { key: 'aaaa', dir: dirA, comic: 'A', title: '第1話', count: 1, rootId: 'picacg', rootName: '哔咔', rootPath: 'C:\\lib' },
      { key: 'bbbb', dir: dirB, comic: 'B', title: '第1话', count: 2, rootId: 'picacg', rootName: '哔咔', rootPath: 'C:\\lib' },
      { key: 'cccc', dir: 'C:\\lib\\C\\1', comic: 'C', title: '第2话', count: 1, rootId: 'picacg', rootName: '哔咔', rootPath: 'C:\\lib' }
    ]));
    const view = loadCandidateFingerprints({ fpLib: fpLib }, [dirB]);
    t.ok(view !== null, '(c1) 候选指纹视图可装载');
    t.eq(view.chapters.length, 1, '(c2) 只装载被点名的候选章节（另外两个章节一个字节都不读）');
    t.eq(view.chapters[0].dir, dirB, '(c3) 装载的正是被点名的那个章节');
    t.eq(view.N, 2, '(c4) 只含候选章节的 2 张图');
    t.eq(view.chapters[0].start, 0, '(c5) 区块起点归零（否则 zMadOf 会读到别的章节的灰度）');
    t.eq(view.linv[0], 0, '(c6) 全平坦页 linv=0（设计如此：归一化会把平坦页噪声放大，故退回 raw MAD）');
    t.ok(view.linv[1] > 0, '(c6b) 有方差的页 linv > 0（走 z 归一化）');
    t.eq(loadCandidateFingerprints({ fpLib: fpLib }, ['C:\\lib\\不存在']), null, '(c7) 没有匹配章节时返回 null，不回退成全库');
    t.eq(loadCandidateFingerprints({ fpLib: path.join(root, '没这目录') }, [dirB]), null, '(c8) index.json 不存在时返回 null（不抛错）');
    t.eq(loadCandidateFingerprints({ fpLib: fpLib }, []), null, '(c9) 空候选目录列表必须返回 null —— 早先会退化成装载整库 1236 个指纹（v7 要消灭的重税）');

    // 合成 .bin → loadCandidateFingerprints → computeCoverageOf 全链条（这是生产路径的真实形态）
    const dupB = path.join(root, 'dupB.bin');
    writeBin(dupB, [{ name: '00000001.webp', level: LEVEL }, { name: '00000002.webp', level: LEVEL }]);
    const fpB = readSet(dupB);
    const covChain = computeCoverageOf(view, ['00000001.webp', '00000002.webp'], fpB, view.chapters[0], 8);
    // 被点名章节的第 2 张是「半页 30 / 半页 200」的有方差页，查重侧两张都是平坦 128 ——
    // 它必须**不**命中：恰好证明 z 归一化没有把结构完全不同的页放行。
    t.eq(covChain.pixel, 1, '(c10) 从 .bin 装载的视图中只命中真正同亮度的那 1 张');
    t.eq(covChain.cov, 0.5, '(c11) 全链条覆盖率为 0.5（有方差页不因归一化被误判为相同）');

    // ---------- (d) 候选取舍口径 ----------
    t.ok(isCandidateWorth(0.3, null), '(d1) cov=0.30 算候选（部分重复的下限）');
    t.ok(!isCandidateWorth(0.29, null), '(d2) cov=0.29 不算候选');
    t.ok(isCandidateWorth(null, 0.5), '(d3) 无像素证据时按文件名命中率 0.5 兜底');
    t.ok(!isCandidateWorth(null, 0.4), '(d4) 命中率 0.4 且无像素证据时不算候选');
    t.ok(!isCandidateWorth(null, null), '(d5) 两个信号都没有时不进候选');
    t.ok(MAX_FAST_CHAPTERS >= 5, '(d6) 候选章节上限至少 5 个（否则用户看不到同作品的其它话）');
    t.ok(MAX_FAST_SAMPLES >= 3, '(d7) 抽样图上限至少 3 张');
    t.ok(!isCandidateWorth(0, 1), '(d8) 像素证据存在但 cov=0 时，不被标题分数救回来（有证据就只认证据）');

    // ---------- (e) 抽样图：整章等距取，且带 z-MAD ----------
    const manyNames = Array.from({ length: 20 }, function (_, i) { return 'TG@BGG_Home_' + String(i + 1).padStart(4, '0') + '.jpg'; });
    const libMany = fakeLib([{ dir: 'C:\\lib\\C\\1', names: Array.from({ length: 20 }, function (_, i) { return String(i + 1).padStart(3, '0') + '.jpg'; }) }]);
    const fpManyFile = path.join(root, 'many.bin');
    writeBin(fpManyFile, manyNames.map(function (n) { return { name: n }; }));
    const fpMany = readSet(fpManyFile);
    const covMany = computeCoverageOf(libMany, manyNames, fpMany, libMany.chapters[0], 8);
    const rec = { dir: 'C:\\lib\\C\\1', rootPath: 'C:\\lib', rootId: 'picacg' };
    const samples = buildFastSamples(libMany, fpMany, manyNames, { rec: rec, cover: covMany }, manyNames, 8, 4);
    t.eq(samples.length, 4, '(e1) 抽样图数量 = min(缩略图数量, 查重侧张数) = 4');
    t.eq(samples[0].dup, manyNames[0], '(e2) 第一张是首图');
    t.eq(samples[3].dup, manyNames[19], '(e3) 最后一张是末图（等距取到整章尾部，不是只看前几张）');
    t.ok(samples[0].lib && samples[0].lib.indexOf('/') >= 0, '(e4) 库侧返回相对库根的路径（多库根缩略图寻址必需）: ' + samples[0].lib);
    t.eq(samples[0].mad, 0, '(e5) 同亮度页的 z-MAD 为 0');
    t.eq(samples[0].root, 'picacg', '(e6) 抽样图带库根 id（缩略图路由要用）');
    t.eq(buildFastSamples(libMany, fpMany, manyNames, null, manyNames, 8, 4).length, 0, '(e7) 没有最佳章节时返回空数组');
    t.eq(buildFastSamples(libMany, fpMany, manyNames, { rec: rec, cover: covMany }, manyNames, 8, 1).length, 1, '(e8) thumbCount=1 时只给一张');
    // ---------- (f) 拆文件后的调用链自洽（真实事故：summaryOf 漏 import） ----------
    // 事故形态：拆 pipeline.mjs -> pipeline-fast.mjs 时 summaryOf 留在原文件，
    // pipeline-fast 里 汇总: summaryOf(outUnits) 没有对应 import。
    // 单测从不调用 runFastStage，1440 条断言全绿，真实点「快速查重」直接报
    // 'summaryOf is not defined'，整轮扫描落盘为 degraded。
    // 这里用静态扫描钉住：pipeline-fast.mjs 里调用的每个自由函数名，必须有 import 或本地声明。
    // 不跑真阶段的原因：要造 Python/Pillow + 指纹，代价与收益不成比例；缺陷形态就是「标识符没解析」。
    t.eq(typeof runFastStage, 'function', '(f1) runFastStage 必须能从 pipeline.mjs 导入（index.mjs 就是这样调的）');
    const FAST_SRC = path.join(import.meta.dirname, '..', 'src', 'modules', 'dedupe', 'engine', 'pipeline-fast.mjs');
    const fastRaw = fs.readFileSync(FAST_SRC, 'utf8');
    const fastBody = stripForFast(fastRaw);
    const importedNames = new Set();
    const reImp = /import\s*\{([^}]*)\}\s*from/g;
    let mi = null;
    while ((mi = reImp.exec(fastBody))) {
      for (const raw of mi[1].split(',')) {
        const nm = raw.trim().split(/\s+as\s+/).pop();
        if (nm) importedNames.add(nm.trim());
      }
    }
    const localNames = new Set();
    const reDecl = /(?:^|[\n;{}])\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g;
    let md = null;
    while ((md = reDecl.exec(fastBody))) localNames.add(md[1]);
    const reAssign = /(?:^|[\n;{}(,])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    let ma = null;
    while ((ma = reAssign.exec(fastBody))) localNames.add(ma[1]);
    // 白名单两类：①语言关键字 ②内建全局（ECMAScript 标准对象与函数）。
    // 刻意不把 Node 专有的东西（require / process / __dirname / Buffer）放进来：
    // 本仓库是纯 ESM，出现它们本身就是缺陷，让断言红出来才是有意义的。
    const KNOWN_GLOBALS = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try',
      'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
      'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
      'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'structuredClone',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
      'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
      'Float32Array', 'Float64Array', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'TextEncoder', 'TextDecoder', 'URL'
    ]);
    // 形参也是合法绑定（report / ctx / paths 都是 runFastStage 的形参）
    const params = new Set();
    const reParams = /export\s+async\s+function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g;
    let mp = null;
    while ((mp = reParams.exec(fastBody))) {
      for (const raw of mp[1].split(',')) {
        const nm = raw.trim().split(/[=\s]/)[0];
        if (nm) params.add(nm);
      }
    }
    const calledNames = new Set();
    const reCall = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let mc = null;
    while ((mc = reCall.exec(fastBody))) calledNames.add(mc[2]);
    const unresolved = [];
    for (const nm of calledNames) {
      if (KNOWN_GLOBALS.has(nm)) continue;
      if (importedNames.has(nm) || localNames.has(nm) || params.has(nm)) continue;
      unresolved.push(nm);
    }
    t.deepEq(unresolved, [], '(f2) pipeline-fast.mjs 调用的本地函数必须都有 import 或声明，未解析的会在运行期静默炸: ' + JSON.stringify(unresolved));
    t.ok(importedNames.has('summaryOf'), '(f3) summaryOf 必须有 import（漏掉会让整轮快速查重不可用）');
    t.ok(!/^\s*export\s+function\s+summaryOf/m.test(fastBody), '(f4) summaryOf 不能在本文件重新定义（会导致两份实现漂移）');
    void 0;
  } finally {
    try { await fsp.rm(root, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
  }
}
