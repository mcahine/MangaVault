// tests/pixel-parallel.test.mjs — 像素比对并行化（worker_threads + SharedArrayBuffer）回归。
// 全部样本在系统临时目录里合成，离线、不碰真实漫画库。
// 核心诉求：并行路径与串行 path 必须给出**逐字段一致**的判定，且 worker 不能另写一套算法。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeTmpDir } from '../src/core/util.mjs';
import { resolvePaths, keyOf } from '../src/modules/dedupe/engine/paths.mjs';
import { readSet, coarseOf } from '../src/modules/dedupe/engine/fpio.mjs';
import {
  loadLibraryFingerprints, PIXEL_WORKERS_MAX,
  grayStats, zMadOf, SEARCH_LIMIT, RESCUE_THRESH, SD_FLOOR,
  pickPixelWorkers, planLibShared, slotOf, slotCursor, atSlot, freeMemMb
} from '../src/modules/dedupe/engine/match.mjs';
// 像素比对本体已从 match.mjs 拆到 pixel-search.mjs（match.mjs 只留检索底层）
import { pixelCompareUnit, runPixelStage } from '../src/modules/dedupe/engine/pixel-search.mjs';
import { judgeCoverage } from '../src/modules/dedupe/engine/scan.mjs';

export const name = '像素比对并行化';

/** 仓库根目录（源码契约断言用）。 */
const pathRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRAY_BYTES = 1024;

/**
 * 确定性合成灰度图：正弦 × 余弦，实测 sd 稳定在 30 附近（远高于 SD_FLOOR），
 * 且不同 seed/variant 的图案互不相同 —— 同图 z-MAD 为 0，异图 z-MAD 很大。
 */
function patternGray(seed, variant) {
  const buf = Buffer.alloc(GRAY_BYTES);
  for (let k = 0; k < GRAY_BYTES; k++) {
    const x = k % 32;
    const y = (k / 32) | 0;
    const v = 128 + 60 * Math.sin((x + seed * 7 + variant * 3) * 0.35) * Math.cos((y + variant) * 0.28);
    buf[k] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return buf;
}

/** 整体提亮：模拟 webp <-> jpg 重编码造成的亮度漂移（z 归一化本应免疫，但会被粗筛挡掉）。 */
function brightnessShift(gray, delta) {
  const out = Buffer.alloc(GRAY_BYTES);
  for (let k = 0; k < GRAY_BYTES; k++) out[k] = Math.max(0, Math.min(255, gray[k] + delta));
  return out;
}

/** 写一个指纹 .bin（格式见 fpio.mjs 的 readSet：条数 + [名字长度, 名字, 宽, 高, 1024 灰度]）。 */
function writeFpBin(file, pages) {
  const parts = [];
  const head = Buffer.alloc(4);
  head.writeInt32LE(pages.length, 0);
  parts.push(head);
  for (const p of pages) {
    const nameBuf = Buffer.from(String(p.name), 'utf8');
    const nl = Buffer.alloc(4);
    nl.writeInt32LE(nameBuf.length, 0);
    const wh = Buffer.alloc(8);
    wh.writeInt32LE(32, 0);
    wh.writeInt32LE(32, 4);
    parts.push(nl, nameBuf, wh, p.gray);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(parts));
}

/** 算某张查询图在库里的最小 raw 8x8 粗筛 L1（判断它会不会被 SEARCH_LIMIT 挡掉）。 */
function minCoarseL1(lib, gray) {
  const cq = coarseOf(gray, 0);
  let best = Infinity;
  for (let i = 0; i < lib.N; i++) {
    let s = 0;
    for (let k = 0; k < 64; k++) s += Math.abs(cq[k] - lib.coarse[i * 64 + k]);
    if (s < best) best = s;
  }
  return best;
}

/** 算某张查询图在库里的最小 z-MAD（不做粗筛，等价于救援阶段的搜索口径）。 */
function minZMAD(lib, gray) {
  const qs = grayStats(gray, 0);
  const qiv = qs.sd < 8 ? 0 : 1 / qs.sd;
  let best = Infinity;
  for (let i = 0; i < lib.N; i++) {
    const v = zMadOf(lib, gray, 0, qs.m, qiv, i);
    if (v < best) best = v;
  }
  return best;
}

/**
 * 串行基准：完全走单线程 API（loadLibraryFingerprints + pixelCompareUnit + judgeCoverage），
 * 与 runPixelStage 的并行结果逐字段对照。这里刻意**不**调用 runPixelStage 的任何内部步骤。
 */
function serialBaseline(paths, lib, hash) {
  const out = [];
  for (const u of hash.units) {
    const exactSet = new Set(Object.keys(u.exact || {}));
    u.nonExact = (u.files || []).filter(function (n) { return !exactSet.has(n); });
    // 指纹 key 与生产一致：按单元目录定位（u.dir），不是按会随整理变化的 u.id
    const fp = readSet(path.join(paths.fpDup, keyOf(u.dir || u.id) + '.bin'));
    const res = pixelCompareUnit(lib, u, fp, { pixelThreshold: paths.pixelThreshold });
    out.push({
      id: u.id,
      judge: judgeCoverage(res.cover),
      exactCount: exactSet.size,
      pixelCount: res.cover.pixel,
      cov1: Math.round((res.cover.cov1 || 0) * 1000) / 1000,
      rescue: res.cover.rescue
    });
  }
  return out;
}

export default async function (t) {
  const root = safeTmpDir('mv-pixel-parallel-');
  try {
    // ============ 合成样本：2 个库章节（10 张 / 8 张）+ 2 个查重单元 ============
    const libRoot = path.join(root, 'lib');
    const chapterA = path.join(libRoot, 'A');
    const chapterB = path.join(libRoot, 'B');
    const scanDir = path.join(root, 'scan');
    const config = {
      libraryRoots: [{ id: 'r1', name: '测试库', path: libRoot }],
      dedupe: { scanRoot: scanDir, pixelThreshold: 8, thumbCount: 4 }
    };
    const paths = resolvePaths(config, path.join(root, 'data'));
    // 库侧指纹：章节 A 十张、章节 B 八张
    const pagesA = [];
    for (let i = 1; i <= 10; i++) pagesA.push({ name: 'a' + (i < 10 ? '0' + i : i) + '.jpg', gray: patternGray(1, i) });
    const pagesB = [];
    for (let i = 1; i <= 8; i++) pagesB.push({ name: 'b' + (i < 10 ? '0' + i : i) + '.jpg', gray: patternGray(2, i) });
    writeFpBin(path.join(paths.fpLib, 'chA.bin'), pagesA);
    writeFpBin(path.join(paths.fpLib, 'chB.bin'), pagesB);
    fs.mkdirSync(paths.fpLib, { recursive: true });
    fs.writeFileSync(path.join(paths.fpLib, 'index.json'), JSON.stringify([
      { key: 'chA', dir: chapterA, comic: '漫画A', title: '第1话', count: 10, rootId: 'r1', rootName: '测试库', rootPath: libRoot },
      { key: 'chB', dir: chapterB, comic: '漫画B', title: '第1话', count: 8, rootId: 'r1', rootName: '测试库', rootPath: libRoot }
    ]), 'utf8');
    // 查重侧指纹：单元一 3 张待复核（含 1 张亮度漂移页），单元二 6 张
    const driftGray = brightnessShift(patternGray(1, 7), 60);
    writeFpBin(path.join(paths.fpDup, keyOf(path.join(scanDir, '分类A', '单元一')) + '.bin'), [
      { name: 'b03.jpg', gray: patternGray(1, 3) },
      { name: 'b04.jpg', gray: patternGray(1, 4) },
      { name: 'drift.jpg', gray: driftGray }
    ]);
    const pages2 = [];
    for (let i = 1; i <= 6; i++) pages2.push({ name: 'b0' + i + '.jpg', gray: patternGray(2, i) });
    writeFpBin(path.join(paths.fpDup, keyOf(path.join(scanDir, '分类B', '单元二')) + '.bin'), pages2);

    /** 单元一：2 张字节命中（exact，value 是绝对路径，pixelCompareUnit 靠它反查章节）+ 3 张待像素复核。 */
    function unitOne() {
      return {
        id: '分类A/单元一', name: '单元一', category: '分类A',
        dir: path.join(scanDir, '分类A', '单元一'),
        files: ['e1.jpg', 'e2.jpg', 'b03.jpg', 'b04.jpg', 'drift.jpg'],
        exact: { 'e1.jpg': path.join(chapterA, 'e1.jpg'), 'e2.jpg': path.join(chapterA, 'e2.jpg') },
        bytes: 102400, candSrc: '内容命中'
      };
    }
    /** 单元二：无字节命中，6 张全部待像素复核，且都能直连章节 B。 */
    function unitTwo() {
      return {
        id: '分类B/单元二', name: '单元二', category: '分类B',
        dir: path.join(scanDir, '分类B', '单元二'),
        files: ['b01.jpg', 'b02.jpg', 'b03.jpg', 'b04.jpg', 'b05.jpg', 'b06.jpg'],
        exact: {}, bytes: 204800, candSrc: '内容命中'
      };
    }
    function makeHash() { return { units: [unitOne(), unitTwo()] }; }

    const lib = loadLibraryFingerprints(paths);
    t.ok(lib !== null, '(b) 前置：合成指纹库可载入');
    t.eq(lib.chapters.length, 2, '(b) 前置：2 个库章节');
    t.eq(lib.N, 18, '(b) 前置：库内共 18 张（10 + 8）');
    // 样本有效性：漂移页必须「粗筛挡掉、救援能补回」，否则这条回归根本没走到救援分支
    const coarseDrift = minCoarseL1(lib, driftGray);
    const zDrift = minZMAD(lib, driftGray);
    t.ok(coarseDrift > SEARCH_LIMIT, '(b) 前置：漂移页粗筛 L1 超过上限（实测 ' + coarseDrift + ' > ' + SEARCH_LIMIT + '），主搜索必然漏掉');
    t.ok(zDrift <= RESCUE_THRESH, '(b) 前置：漂移页去均值后 z-MAD 极小（实测 ' + zDrift.toFixed(4) + ' <= ' + RESCUE_THRESH + '），救援可补回');

    // ============ (b) 等价性：并行 runPixelStage 必须与串行基准逐字段一致 ============
    const logs = [];
    const progress = [];
    const out = await runPixelStage(paths, {
      hash: makeHash(), pixelThreshold: 8, thumbCount: 4, libRoots: paths.libRoots,
      onLog: function (m) { logs.push(String(m)); },
      onProgress: function (i, total, unitId) { progress.push({ i: i, total: total, unitId: unitId }); }
    });
    t.eq(out.units.length, 2, '(b) 并行阶段返回 2 个单元');
    t.ok(logs.every(function (m) { return m.indexOf('回退') < 0; }), '(b) 并行路径生效：没有任何「回退单线程」日志');
    t.eq(out.stats.libImages, 18, '(b) stats.libImages 与库一致');
    t.eq(out.stats.libChapters, 2, '(b) stats.libChapters 与库一致');
    const u1 = out.units.find(function (u) { return u.id === '分类A/单元一'; });
    const u2 = out.units.find(function (u) { return u.id === '分类B/单元二'; });
    t.ok(Boolean(u1) && Boolean(u2), '(b) 两个单元都出现在结果里');
    // 命中必须真实发生：单元一 2 张字节命中 + 2 张直接像素命中 + 1 张救援命中
    t.eq(u1.exactCount, 2, '(b) 单元一：2 张字节命中');
    t.eq(u1.pixelCount, 3, '(b) 单元一：3 张像素命中（含救援补回的 1 张）');
    t.eq(u1.coverage.rescue, 1, '(b) 单元一：救援恰好补回 1 张（cover.rescue=1，救援分支真实执行）');
    t.eq(u1.coverage.cov1, 0.8, '(b) 单元一：救援前主章节覆盖率 4/5 = 0.8（>= RESCUE_MIN 才允许救援）');
    t.eq(u1.coverage.cov, 1, '(b) 单元一：救援后主章节覆盖率 5/5 = 1');
    t.eq(u1.judge, '同图不同编码', '(b) 单元一判定：主章节 100% 覆盖');
    t.eq(u2.pixelCount, 6, '(b) 单元二：6 张全部像素命中');
    t.eq(u2.judge, '同图不同编码', '(b) 单元二判定：主章节 100% 覆盖');
    const base = serialBaseline(paths, lib, makeHash());
    t.eq(base.length, 2, '(b) 串行基准算出 2 个单元');
    for (const b of base) {
      const got = out.units.find(function (u) { return u.id === b.id; });
      t.ok(Boolean(got), '(b) 单元 ' + b.id + ' 两侧都存在');
      t.eq(got.judge, b.judge, '(b) ' + b.id + ' judge 并行=串行');
      t.eq(got.exactCount, b.exactCount, '(b) ' + b.id + ' exactCount 并行=串行');
      t.eq(got.pixelCount, b.pixelCount, '(b) ' + b.id + ' pixelCount 并行=串行');
      t.eq(got.coverage.cov1, b.cov1, '(b) ' + b.id + ' coverage.cov1 并行=串行');
      t.eq(got.coverage.rescue, b.rescue, '(b) ' + b.id + ' coverage.rescue 并行=串行');
    }
    t.log('(b) 并行与串行逐字段一致；漂移页粗筛 L1=' + coarseDrift + ' z-MAD=' + zDrift.toFixed(4));

    // ============ (c) 退化路径：只有一个单元时并行被跳过，仍走串行 ============
    const logs3 = [];
    const progress3 = [];
    const out3 = await runPixelStage(paths, {
      hash: { units: [unitTwo()] }, pixelThreshold: 8, thumbCount: 4, libRoots: paths.libRoots,
      onLog: function (m) { logs3.push(String(m)); },
      onProgress: function (i, total, unitId) { progress3.push({ i: i, total: total, unitId: unitId }); }
    });
    t.eq(out3.units.length, 1, '(c) 单单元时仍能正确返回');
    t.eq(out3.units[0].judge, '同图不同编码', '(c) 单单元判定与串行口径一致');
    t.eq(out3.units[0].pixelCount, 6, '(c) 单单元像素命中 6 张');
    t.ok(logs3.every(function (m) { return m.indexOf('回退') < 0; }), '(c) 单单元是「主动跳过并行」，不是异常回退');
    t.eq(progress3.length, 1, '(c) 单单元走串行，进度恰好回调 1 次');
    t.eq(progress3[0].unitId, '分类B/单元二', '(c) 串行进度带真实单元 id');

    // ============ (d) worker 不可用时的回退（源码契约） ============
    const matchSrc = fs.readFileSync(path.join(pathRepo, 'src', 'modules', 'dedupe', 'engine', 'match.mjs'), 'utf8');
    // 像素比对本体在 pixel-search.mjs：源码契约断言针对「这两份文件合起来」，
    // 拆文件不该让契约失效，也不该因为搬家而假红
    const pixelSrc = fs.readFileSync(path.join(pathRepo, 'src', 'modules', 'dedupe', 'engine', 'pixel-search.mjs'), 'utf8');
    const engineSrc = matchSrc + pixelSrc;
    const workerSrc = fs.readFileSync(path.join(pathRepo, 'src', 'modules', 'dedupe', 'engine', 'pixel-worker.mjs'), 'utf8');
    const iCall = engineSrc.indexOf('parallelMap = await runPixelParallel(');
    // 注意：必须从 iCall 之后开始找，否则会命中前面那句 let parallelMap = null; 声明
    const iNull = engineSrc.indexOf('parallelMap = null;', iCall);
    const iCatch = engineSrc.lastIndexOf('} catch (e) {', iNull);
    const iSerial = engineSrc.indexOf('res = pixelCompareUnit(lib, u, fp, { pixelThreshold: threshold });');
    t.ok(iCall >= 0, '(d) runPixelStage 里确实 await runPixelParallel');
    t.ok(iCatch > iCall, '(d) 并行调用被 try/catch 包住');
    t.ok(iNull > iCall, '(d) 并行抛错后 parallelMap 被置 null（静默回退）');
    t.ok(iSerial > iNull, '(d) 回退分支仍调用 pixelCompareUnit，保证串行口径');
    t.ok(engineSrc.indexOf('return Promise.resolve(null);') >= 0, '(d) 单元不足时直接返回 null 跳过并行');
    t.ok(engineSrc.indexOf('if (!o.signal || !o.signal.aborted)') >= 0, '(d) 已中止的任务不再启动并行');

    // ============ (a) 常量与源码契约 ============
    t.eq(PIXEL_WORKERS_MAX, 6, '(a) PIXEL_WORKERS_MAX === 6');
    t.ok(engineSrc.indexOf('node:worker_threads') >= 0, '(a) 引擎引入 node:worker_threads');
    t.ok(engineSrc.indexOf('SharedArrayBuffer') >= 0, '(a) 引擎使用 SharedArrayBuffer 共享库侧大数组');
    // ★内存修复回归★ linv/lnrm 不再进共享内存（由 worker 从共享 gray 现算），
    // 否则每张图要多拷 8 字节 × 线程数，且共享缓冲要多申请两块。
    t.ok(engineSrc.indexOf('new SharedArrayBuffer(lib.linv') < 0 && engineSrc.indexOf('new SharedArrayBuffer(lib.lnrm') < 0,
      '(a) linv/lnrm 不再单独申请 SharedArrayBuffer（改为 worker 内现算）');
    t.ok(engineSrc.indexOf('sabLinv') < 0 && engineSrc.indexOf('sabLnrm') < 0, '(a) 源码里不再有 sabLinv/sabLnrm 残留');
    // ★内存修复回归★ 共享缓冲必须分块申请：单块 63MB 在低内存机器上会被直接拒绝并崩掉
    t.ok(engineSrc.indexOf('SAB_CHUNK_BYTES = 16 * 1024 * 1024') >= 0, '(a) 共享缓冲按 16MB 分块申请，单次分配上限受控');
    t.ok(engineSrc.indexOf('.finally(function () {') >= 0 && engineSrc.indexOf('lib.map = null;') >= 0,
      '(a) 比对结束后松开共享缓冲引用，不再常驻到下一次扫描');
    t.ok(engineSrc.indexOf('runPixelParallel') >= 0, '(a) 引擎定义 runPixelParallel');
    t.ok(workerSrc.indexOf('pixelCompareUnit') >= 0, '(a) worker 复用 pixelCompareUnit，与串行同一套算法');
    t.ok(workerSrc.indexOf('pixel-search.mjs') >= 0, '(a) worker 从 pixel-search.mjs 引入算法，不会出现两份实现漂移');
    t.ok(workerSrc.indexOf('d.shared') >= 0, '(a) worker 通过分块 SAB 映射表访问库侧数组');
    t.ok(workerSrc.indexOf('grayStats(') >= 0 && workerSrc.indexOf('lib.linv[i] =') >= 0,
      '(a) worker 自己从共享 gray 现算 linv/lnrm，与主线程同口径');
    // ★内存放大回归★ gray/coarse 绝不能当 workerData 传：结构化克隆会把 63MB 复制一份给每个线程
    t.ok(engineSrc.indexOf('grayBuf') < 0 && engineSrc.indexOf('coarseBuf') < 0,
      '(a) workerData 里没有 gray/coarse（否则每个 worker 会被结构化克隆多拷 63MB）');

    // ============ (e) 进度回调：并行路径下也要被调用 ============
    t.ok(progress.length >= 1, '(e) 并行路径也能回调进度');
    t.eq(progress.length, 2, '(e) 2 个单元 -> worker 逐单元上报 2 次进度');
    t.ok(progress.every(function (p) { return p.total === 2; }), '(e) 每次回调的 total 恒为单元总数');
    let mono = true;
    for (let i = 1; i < progress.length; i++) if (progress[i].i < progress[i - 1].i) mono = false;
    t.ok(mono, '(e) 进度 i 单调不减');
    t.ok(progress[progress.length - 1].i <= 2, '(e) 进度最终不超过总单元数');
    t.eq(progress[progress.length - 1].i, 2, '(e) 收尾进度等于总单元数');
    t.ok(progress.every(function (p) { return p.unitId === ''; }), '(e) 进度确实来自并行 worker（串行上报会带真实单元 id）');

    // ============ (f) 内存回归：共享缓冲分块 + 线程数按可用内存收缩 ============
    // 事故背景：「重新扫描」在空闲内存只剩 1GB 出头的机器上崩掉。
    // 两条独立成因，这里各给一条可离线复跑的断言。
    // (f1) 单块 SAB 过大：主线程本身已持有 gray(63MB)，再向系统要一块同等大小的连续共享内存
    //      会被拒绝。分块后单次分配不得超过 64MB。
    const smallChunk = 1024;   // 每个粗筛行 64 字节 -> 16 行一块，强制走出多分块路径
    const plan = planLibShared(lib, smallChunk);
    t.ok(plan.map.gray.bufs.length > 1, '(f1) 小分块下 gray 确实被切成多块（实测 ' + plan.map.gray.bufs.length + ' 块）');
    t.ok(plan.map.coarse.bufs.length > 1, '(f1) 小分块下 coarse 同样多块（实测 ' + plan.map.coarse.bufs.length + ' 块）');
    let maxSpan = 0;
    for (const b of plan.map.gray.bufs.concat(plan.map.coarse.bufs)) if (b.byteLength > maxSpan) maxSpan = b.byteLength;
    t.ok(maxSpan <= smallChunk, '(f1) 任一分块都不超过设定上限（实测最大 ' + maxSpan + ' 字节）');
    plan.attach();
    // 分块视图必须与原始数组逐字节一致，否则并行结果会与串行悄悄漂移
    const gv = plan.map.gray.bufs.map(function (b) { return new Uint8Array(b); });
    let grayOk = true;
    for (let i = 0; i < lib.N; i++) {
      const s = slotOf(plan.map.gray, lib.gray, i, GRAY_BYTES);
      const src = lib.gray.subarray(i * GRAY_BYTES, (i + 1) * GRAY_BYTES);
      const dst = s[0].subarray(s[1], s[1] + GRAY_BYTES);
      if (Buffer.compare(Buffer.from(src), Buffer.from(dst)) !== 0) { grayOk = false; break; }
    }
    t.ok(grayOk, '(f1) 分块共享缓冲的内容与原始 gray 逐字节一致（' + lib.N + ' 行全查）');
    let coarseOk = true;
    for (let i = 0; i < lib.N; i++) {
      const s = slotOf(plan.map.coarse, lib.coarse, i, 64);
      for (let k = 0; k < 64; k++) if (s[0][s[1] + k] !== lib.coarse[i * 64 + k]) { coarseOk = false; break; }
      if (!coarseOk) break;
    }
    t.ok(coarseOk, '(f1) 分块共享缓冲的粗筛特征与原始 coarse 逐字节一致');
    t.ok(gv.length === plan.map.gray.bufs.length, '(f1) 分块视图数量与缓冲数量吻合');
    // ★回归★ 分块总字节数必须等于源字节数。曾经误写成 length*stride（把 63MB 算成 63GB），
    // 导致真实库上共享缓冲必然分配失败并静默回退串行 —— 不崩，但像素阶段慢好几倍。
    const grayBytes = plan.map.gray.bufs.reduce(function (s, b) { return s + b.byteLength; }, 0);
    const coarseBytes = plan.map.coarse.bufs.reduce(function (s, b) { return s + b.byteLength; }, 0);
    t.eq(grayBytes, lib.gray.length, '(f1) gray 分块总字节数 = 源字节数（' + grayBytes + '）');
    t.eq(coarseBytes, lib.coarse.length, '(f1) coarse 分块总字节数 = 源字节数（' + coarseBytes + '）');
    t.ok(grayBytes < lib.N * GRAY_BYTES * GRAY_BYTES, '(f1) 分块总量没有把 stride 二次乘进去（真实库上是 63GB 级错误）');

    // (f2) 线程数按可用内存收缩：这是「12 线程把内存打爆」的直接防线
    t.eq(pickPixelWorkers(0, lib.N, 6), 6, '(f2) 取不到内存信息时不收缩，沿用上限');
    t.eq(pickPixelWorkers(-1, lib.N, 6), 6, '(f2) freemem 返回负数（不可信）时同样不收缩');
    t.eq(pickPixelWorkers(8192, lib.N, 6), 6, '(f2) 8GB 空闲 -> 满额 6 线程');
    const tight = pickPixelWorkers(300, lib.N, 6);
    t.ok(tight >= 0 && tight < 6, '(f2) 300MB 空闲时必须收缩（实测 ' + tight + ' 线程）');
    t.eq(pickPixelWorkers(256, lib.N, 6), 0, '(f2) 触及安全水位 -> 0（退回串行，宁可慢也不冒被杀的风险）');
    t.eq(pickPixelWorkers(100, lib.N, 6), 0, '(f2) 100MB 空闲 -> 0');
    // 真实库量级（63395 张）也要能收缩：每 worker 预留随张数增长
    const big = pickPixelWorkers(300, 63395, 6);
    t.ok(big >= 0 && big <= 3, '(f2) 6.3 万张 + 300MB 空闲时收缩到 ' + big + ' 线程');
    t.ok(freeMemMb() !== 0, '(f2) freeMemMb() 能取到本机可用内存（实测 ' + freeMemMb() + 'MB）');
    // 收缩后统计必须仍与串行一致：内存防线不能改判定
    const tightOut = await runPixelStage(paths, {
      hash: makeHash(), pixelThreshold: 8, thumbCount: 4, libRoots: paths.libRoots
    });
    t.eq(tightOut.units.length, 2, '(f2) 收缩后仍返回 2 个单元');
    const t1 = tightOut.units.find(function (u) { return u.id === '分类A/单元一'; });
    t.eq(t1.judge, u1.judge, '(f2) 收缩后判定与串行一致（' + t1.judge + '）');
    t.eq(t1.pixelCount, u1.pixelCount, '(f2) 收缩后 pixelCount 与串行一致');

    // (f3) worker 里的 z 归一化预算必须与主线程同口径：worker 用自算的 linv/lnrm，
    //      这里直接按共享 gray 重算一遍，与 loadLibraryFingerprints 的结果对齐。
    let statOk = true;
    for (let i = 0; i < lib.N; i++) {
      const st = grayStats(lib.gray, i * GRAY_BYTES);
      const iv = st.sd < SD_FLOOR ? 0 : 1 / st.sd;
      // linv 存在 Float32Array 里，比较容差要按 float32 精度取（约 1e-7 相对误差）
      if (Math.abs(lib.linv[i] - iv) > 1e-6 || Math.abs(lib.lnrm[i] - st.m * iv) > 1e-5) { statOk = false; break; }
    }
    t.ok(statOk, '(f3) linv/lnrm 的口径可由共享 gray 重算得到（worker 现算不会漂移）');

    // (f4) ★关键回归★ 分块采样表必须覆盖**每一行**且每段都不跨块。
    // 事故背景：采样点比块边界稀疏时，空档里的行会被二分到上一段，算出的下标越过块末尾，
    // 读到 undefined —— 像素结果静默错误，且只有真实库量级（6 万行 + 16MB 分块）才暴露。
    // 这里构造「采样点稀疏 + 块边界密集」的规模，逐行检查映射是连续、不跨块、且能取到正确字节。
    const N4 = 600;
    const chunk4 = 4096;
    const perChunk4 = Math.floor(chunk4 / GRAY_BYTES);   // 每块 4 行
    const g4 = Buffer.alloc(N4 * GRAY_BYTES);
    for (let i = 0; i < N4; i++) for (let k = 0; k < GRAY_BYTES; k++) g4[i * GRAY_BYTES + k] = (i * 31 + k) & 255;
    const plan4 = planLibShared({ gray: g4, coarse: new Uint8Array(N4 * 64), N: N4 }, chunk4);
    plan4.attach();
    const segs = plan4.map.gray;
    let cover = true;
    let cursor = 0;
    for (let s = 0; s < segs.rows.length; s++) {
      if (segs.rows[s] !== cursor) { cover = false; break; }        // 段首必须紧接上一段段尾，空隙=错
      if (segs.next[s] <= segs.rows[s]) { cover = false; break; }   // 段必须有长度
      // 段内每一行都必须落在同一个块里
      if (Math.floor((segs.next[s] - 1) / perChunk4) !== segs.chunk[s]) { cover = false; break; }
      cursor = segs.next[s];
    }
    t.ok(cover && cursor === N4, '(f4) 分块段首尾相接、覆盖全部 ' + N4 + ' 行且不跨块');
    let mapOk = true;
    for (let i = 0; i < N4; i++) {
      const s = slotOf(plan4.map.gray, g4, i, GRAY_BYTES);
      if (s[0][s[1]] !== g4[i * GRAY_BYTES] || s[0][s[1] + GRAY_BYTES - 1] !== g4[i * GRAY_BYTES + GRAY_BYTES - 1]) { mapOk = false; break; }
    }
    t.ok(mapOk, '(f4) 逐行都能取到本行首尾字节（真实库量级曾出现 undefined）');
    // 顺序游标路径（粗筛用）同样要逐行正确
    const cur4 = slotCursor(plan4.map.gray, g4, GRAY_BYTES, 0);
    let curOk = true;
    for (let i = 0; i < N4; i++) {
      // 必须先 atSlot 推进游标、再读 view：写成 cur4.view[atSlot(cur4, i)] 会先取到旧视图
      // （JS 求值顺序：cur4.view 先求值，atSlot 后调用），索引到上一块的缓冲区。
      const off = atSlot(cur4, i);
      if (cur4.view[off] !== g4[i * GRAY_BYTES]) { curOk = false; break; }
    }
    t.ok(curOk, '(f4) 顺序游标 atSlot 逐行命中正确字节');

    t.log('临时样本目录: ' + root);
  } finally {
    // 只清理本次测试自己造的临时目录
    try { await fsp.rm(root, { recursive: true, force: true }); } catch (e) { t.log('临时目录清理失败: ' + e.message); }
  }
}
