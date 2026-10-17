// engine/pixel-search.mjs — 像素比对本体：单元打分（pixelCompareUnit）与像素阶段（runPixelStage）。
// 从 match.mjs 拆出：本文件只做「打分 + 覆盖面统计」，判定口径仍然走 scan.mjs 的 judgeCoverage。
// 依赖 match.mjs 的检索底层（粗筛/Z 精算/指纹加载/记忆体规划）与 pixel-worker.mjs 的并行执行。
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { readSet, coarseOf } from './fpio.mjs';
import { sleep } from '../../../core/util.mjs';
import { createLogger } from '../../../core/log.mjs';
import { judgeCoverage, recordOf, abortError } from './scan.mjs';
import { keyOf } from './paths.mjs';
import {
  RESCUE_THRESH,
  RESCUE_MIN,
  PIXEL_WORKERS_MAX,
  pickPixelWorkers,
  freeMemMb,
  planLibShared,
  grayStats,
  invOf,
  loadLibraryFingerprints,
  hitOf,
  searchZRange,
  madHistogram,
  round2,
  chapterOfDir,
  chapterInfoOf,
  PER_WORKER_EXTRA_MB
} from './match.mjs';
/**
 * 单个单元的全库像素比对。四步：
 *   1) 字节命中页按章节计入（数量很少，但证据最硬）；
 *   2) 逐张全库搜索（raw 8x8 L1 粗筛 + z-MAD 精算），命中按章节聚合；
 *   3) 取命中最多者为「主章节」，cov1 = 主章节命中数 / 总张数；
 *   4) 受控救援：仅当 cov1 >= RESCUE_MIN 时，对未命中页在主章节区间内做无粗筛 z-MAD 搜索
 *      （阈值 RESCUE_THRESH，且必须仍落在主章节），补回被粗筛漏掉的亮度漂移页。
 * 返回 { bestOf: Map<文件名,{mad,libIdx,libName,lib,root}>, info, cover }。
 */
export function pixelCompareUnit(lib, unit, fp, opts) {
  const o = opts || {};
  const threshold = Number(o.pixelThreshold || 8);
  const info = { samples: 0, votes: [], candidates: [], exhaustive: 0, searched: 0 };
  const cover = { total: 0, exact: 0, pixel: 0, rescue: 0, cov1: 0, cov: 0, globalRatio: 0, mainCi: -1, byCh: [] };
  const bestOf = new Map();
  const files = unit.files || [];
  const total = files.length;
  const exactKeys = Object.keys(unit.exact || {});
  const exactSet = new Set(exactKeys);
  const nonExact = (unit.nonExact && unit.nonExact.length)
    ? unit.nonExact
    : files.filter(function (n) { return !exactSet.has(n); });
  cover.total = total;
  cover.exact = exactKeys.length;
  if (!fp) return { bestOf: bestOf, info: info, cover: cover };

  // 1) 字节命中页按章节计入（exact 里存的是绝对路径）
  const byCh = new Map();
  for (const k of exactKeys) {
    const ci = chapterOfDir(lib, path.dirname(String(unit.exact[k])));
    if (ci >= 0) byCh.set(ci, (byCh.get(ci) || 0) + 1);
  }

  // 2) 逐张全库搜索；每张的离线信息留给救援阶段复用（避免二次算均值/粗筛）
  const pages = [];
  for (const n of nonExact) {
    const off = fp.offsets.get(n);
    if (off === undefined) continue;
    const q = grayStats(fp.buf, off);
    const qiv = invOf(q.sd);
    const cq = coarseOf(fp.buf, off);
    const b = searchZRange(lib, fp.buf, off, cq, q.m, qiv, 0, lib.N, true);
    info.searched++;
    if (b.i >= 0) bestOf.set(n, Object.assign({ mad: round2(b.v) }, hitOf(lib, b.i)));
    pages.push({ name: n, off: off, qm: q.m, qiv: qiv, cq: cq, best: b });
    if (b.i >= 0 && b.v <= threshold) {
      const ci = lib.chOf[b.i];
      byCh.set(ci, (byCh.get(ci) || 0) + 1);
      info.exhaustive++;   // 全库搜索直接命中（阈值内）的张数
    }
  }

  // 3) 主章节 + cov1
  let topCi = -1;
  let topN = 0;
  for (const e of byCh) if (e[1] > topN) { topN = e[1]; topCi = e[0]; }
  cover.cov1 = total ? topN / total : 0;

  // 4) 受控救援：只在「主章节已经很明确」时才做，否则假阳性会爆炸
  let rescue = 0;
  if (topCi >= 0 && cover.cov1 >= RESCUE_MIN) {
    const c = lib.chapters[topCi];
    for (const p of pages) {
      if (p.best.i >= 0 && p.best.v <= threshold) continue;
      const rb = searchZRange(lib, fp.buf, p.off, p.cq, p.qm, p.qiv, c.start, c.count, false);
      if (rb.i >= 0 && rb.v <= RESCUE_THRESH && lib.chOf[rb.i] === topCi) {
        p.best = rb;
        bestOf.set(p.name, Object.assign({ mad: round2(rb.v) }, hitOf(lib, rb.i)));
        byCh.set(topCi, (byCh.get(topCi) || 0) + 1);
        rescue++;
      }
    }
  }
  cover.rescue = rescue;
  cover.cov = total ? ((byCh.get(topCi) || 0) / total) : 0;

  // 5) 全局命中（不限定章节）与最终聚合统计
  let pixelHits = 0;
  for (const p of pages) if (p.best.i >= 0 && p.best.v <= threshold) pixelHits++;
  cover.pixel = pixelHits;
  cover.globalRatio = total ? (exactKeys.length + pixelHits) / total : 0;
  cover.mainCi = topCi;
  cover.byCh = [...byCh.entries()]
    .sort(function (a, b) { return b[1] - a[1]; })
    .map(function (e) { return { ci: e[0], n: e[1] }; });
  // 候选章节 / 票数由 byCh 直接派生（旧实现的「抽样投票」是全库搜索，与逐张搜索完全重复，
  // 白花约 11 秒/轮；而 byCh 是按真实命中张数聚合出来的，比抽样投票更准）
  info.samples = total;
  info.votes = cover.byCh.slice(0, 5).map(function (e) {
    const c = lib.chapters[e.ci];
    return { comic: c.comic, title: c.title, root: c.rootName, votes: e.n };
  });
  info.candidates = cover.byCh.slice(0, 8).map(function (e) {
    const c = lib.chapters[e.ci];
    return { comic: c.comic, title: c.title, dir: c.dir, rootId: c.rootId, rootName: c.rootName };
  });
  return { bestOf: bestOf, info: info, cover: cover };
}

/**
 * 用 worker_threads 并行跑一批单元的像素比对。
 * 库侧大数组放进 SharedArrayBuffer 只读共享（4 核 8 线程下 63395 张约 68MB），
 * 不复制到每个线程；worker 内部复用 pixelCompareUnit，保证与单线程结果逐字节一致。
 * opts: { signal, onCancel(registerKiller) } —— 中止必须能打断并行，否则用户点了中止还要空跑 30~40 秒。
 * 返回 Map<unitId, {bestOf, info, cover}>；任何异常都 reject，由调用方回退单线程。
 */
function runPixelParallel(lib, hashUnits, fpDup, pixelThreshold, onProgress, opts) {
  const o = opts || {};
  if (o.signal && o.signal.aborted) return Promise.reject(abortError());
  // 至少 2 个线程才有并行意义；cpu 数未知时不强行开线程，回退串行
  const cpus = os.cpus() || [];
  let workers = Math.min(PIXEL_WORKERS_MAX, Math.max(0, cpus.length - 1));
  if (workers < 2 || hashUnits.length < 2) return Promise.resolve(null);
  // 按可用内存收缩：每个 worker 都要克隆一份 chapters/names，并且自带 linv/lnrm（约 8 字节/张）。
  // 空闲内存不够时直接少开线程，宁可慢也不要被 OOM/看护杀掉（旧版写死 6 个）。
  const freeMb = freeMemMb();
  const shrunk = pickPixelWorkers(freeMb, lib.N, workers);
  if (shrunk < workers) {
    workers = shrunk;
    {
      const extraPerWorkerMb = PER_WORKER_EXTRA_MB + Math.ceil((lib.N * 8) / 1048576);
      if (o.onLog) { try { o.onLog('可用内存 ' + freeMb + 'MB，每线程约 ' + extraPerWorkerMb + 'MB，像素并行收缩到 ' + workers + ' 线程'); } catch (e) { /* 忽略 */ } }
      else log.warn('可用内存 ' + freeMb + 'MB，每线程约 ' + extraPerWorkerMb + 'MB，像素并行收缩到 ' + workers + ' 线程');
    }
  }
  if (workers < 2) return Promise.resolve(null);
  // 分块共享库侧大数组（linv/lnrm 不再进共享内存，由 worker 自算，省下 2×(4+4) 字节/张的拷贝）。
  // 分块的好处：单次分配只有 64MB，任一块失败都只抛错、不崩；整块失败会回退串行。
  let shared = null;
  try {
    shared = planLibShared(lib);
    shared.attach();
    lib.map = shared.map;
  } catch (e) {
    lib.map = null;
    throw e;
  }
  // 按「非字节命中张数」贪心均分；权重至少 1，避免全 exact 单元让贪心退化成单线程
  const shards = [];
  const loads = [];
  for (let i = 0; i < workers; i++) { shards.push([]); loads.push(0); }
  const sorted = hashUnits.slice().sort(function (a, b) {
    return ((b.nonExact || []).length) - ((a.nonExact || []).length);
  });
  for (const u of sorted) {
    let mi = 0;
    for (let i = 1; i < workers; i++) if (loads[i] < loads[mi]) mi = i;
    shards[mi].push(u);
    loads[mi] += Math.max(1, (u.nonExact || []).length);
  }
  // 只传共享缓冲与映射表：不再克隆 gray/coarse，也彻底不传 linv/lnrm（worker 内现算）
  const common = {
    shared: shared.map,
    N: lib.N, chOf: lib.chOf, chapters: lib.chapters, names: lib.names,
    fpDup: fpDup, pixelThreshold: pixelThreshold
  };
  const spawned = [];
  let finished = 0;
  let aborted = false;
  // 中止：注册 killer 给 runner，用它 terminate 所有 worker（worker 里跑的是同步 JS 热循环，
  // 无法靠 signal 主动退出，必须 terminate）
  function killAll() {
    aborted = true;
    for (const w of spawned) { try { w.terminate(); } catch (e) { /* 已退出 */ } }
  }
  if (typeof o.onCancel === 'function') { try { o.onCancel(killAll); } catch (e) { /* 忽略 */ } }
  const tasks = shards.map(function (shard) {
    if (!shard.length) return Promise.resolve([]);
    return new Promise(function (resolve, reject) {
      let settled = false;
      let w = null;
      function fail(err) {
        if (settled) return;
        settled = true;
        reject(err);
      }
      function done(list) {
        if (settled) return;
        settled = true;
        resolve(list);
      }
      try {
        w = new Worker(new URL('./pixel-worker.mjs', import.meta.url), {
          workerData: Object.assign({}, common, { units: shard })
        });
      } catch (e) { fail(e); return; }
      spawned.push(w);
      w.on('message', function (msg) {
        if (aborted) return;
        if (msg && msg.result) { done(msg.result); return; }
        if (msg && msg.progress) {
          finished++;
          if (onProgress) { try { onProgress(finished, hashUnits.length, msg.id); } catch (e) { /* 忽略 */ } }
        }
      });
      w.on('error', fail);
      // exit 兜底：正常路径必然先收到 result；若 code=0 却没收到结果，也必须 settle，
      // 否则 Promise 永久 pending，整个像素阶段卡死。
      w.on('exit', function (code) {
        if (aborted) { fail(abortError()); return; }
        if (code !== 0) fail(new Error('像素比对工作线程退出码 ' + code));
        else fail(new Error('像素比对工作线程提前结束，未返回结果'));
      });
    });
  });
  return Promise.all(tasks).then(function (lists) {
    if (aborted) throw abortError();
    const map = new Map();
    for (const list of lists) for (const item of list) map.set(item.id, item);
    return map;
  }).catch(function (err) {
    // 任一 worker 失败/中止：立刻收掉其它 worker，否则它们会继续满核跑、
    // 继续上报进度，导致进度超过 100% 并把同一批单元重算一遍
    killAll();
    throw err;
  }).finally(function () {
    // 共享缓冲由主线程与 worker 共同持有引用，用完整块无法回收；
    // 比对结束后立刻松开引用，避免它陪跑到下一次扫描（旧版 65MB SAB 的常驻来源）
    lib.map = null;
  });
}


/**
 * 像素阶段主流程：对 hash-result 里每个单元做全库比对并重新判定。
 * opts: { hash, prevById, libRoots, pixelThreshold, thumbCount, onProgress(i,total,unitId), signal, onLog }
 * 返回 { units, summary, stats }。缺指纹时抛中文错误。
 */
export async function runPixelStage(paths, opts) {
  const o = opts || {};
  const lib = loadLibraryFingerprints(paths);
  if (!lib) {
    const err = new Error('缺少全库指纹（data/dedupe/tmp/fp-lib/index.json），请先「重建全库指纹」再深度比对');
    err.code = 'NO_FP';
    throw err;
  }
  const threshold = Number(o.pixelThreshold || paths.pixelThreshold || 8);
  const thumbCount = Number(o.thumbCount || paths.thumbCount || 6);
  const libRoots = o.libRoots || paths.libRoots || [];
  const units = [];
  let searched = 0;
  let rescueTotal = 0;
  let idx = 0;
  const hashUnits = o.hash.units || [];
  // 预先算好每单元需要逐张比对的页（字节命中的不需要），并行与串行两条路径共用
  for (const u of hashUnits) {
    const exactSet = new Set(Object.keys(u.exact || {}));
    u.nonExact = (u.files || []).filter(function (n) { return !exactSet.has(n); });
  }
  // 并行优先：把库侧指纹放进 SharedArrayBuffer 后切给多个 worker_threads。
  // 并行结果与串行逐单元一致（worker 内复用 pixelCompareUnit），失败则静默回退串行。
  let parallelMap = null;
  if (!o.signal || !o.signal.aborted) {
    try {
      parallelMap = await runPixelParallel(lib, hashUnits, paths.fpDup, threshold, function (done) {
        if (o.onProgress) o.onProgress(done, hashUnits.length, '');
      }, { signal: o.signal, onCancel: o.onCancel });
    } catch (e) {
      // 中止要原样往上抛：当成「并行不可用」回退串行的话，用户点了中止还会全量串行跑完
      if (e && e.aborted) throw e;
      parallelMap = null;
      const why = e && e.message ? e.message : e;
      // 失败可见性：并行不可用会静默回退串行，真实缺陷会被吃掉。MV_DBG_PIXEL=1 时打完整堆栈。
      if (process.env.MV_DBG_PIXEL === '1') log.error('像素并行失败（回退单线程）: ' + (e && e.stack ? e.stack : why));
      if (o.onLog) { try { o.onLog('像素并行不可用，回退单线程：' + why); } catch (e2) { /* 忽略 */ } }
      else log.warn('像素并行不可用，回退单线程：' + why);
    }
  }
  for (const u of hashUnits) {
    idx++;
    if (o.signal && o.signal.aborted) throw abortError();
    const pv = (o.prevById && o.prevById.get(u.id)) || {};
    let res;
    const hit = parallelMap ? parallelMap.get(u.id) : null;
    if (hit) {
      // worker 回传的 bestOf 是「条数少」的命中集合（多数单元为个位数），这里还原成 Map
      const m = new Map();
      for (const item of hit.bestOf) m.set(item.name, { mad: item.mad, libIdx: item.libIdx, libName: item.libName, lib: item.lib, root: item.root });
      res = { bestOf: m, info: hit.info, cover: hit.cover };
    } else {
      /* 指纹按「单元所在目录」定位，不按 id：库格式正规化会改 id（裸本 -> <标题>/1 第1話），
         按 id 会让整理后的单元找不到已建好的指纹，全部退化成「没有像素证据」。详见 collectDupJobs。 */
      const fp = readSet(path.join(paths.fpDup, keyOf(u.dir || u.id) + '.bin'));
      res = pixelCompareUnit(lib, u, fp, { pixelThreshold: threshold });
    }
    const bestOf = res.bestOf;
    const info = res.info;
    const cover = res.cover;
    searched += info.searched;
    rescueTotal += cover.rescue;
    const exactCount = cover.exact;
    // 判定口径：主章节覆盖率 + 分散命中兜底（口径统一定义在 scan.mjs 的 judgeCoverage）
    const verdict = judgeCoverage(cover);
    const pixelOk = cover.pixel;
    // 主章节：优先命中图片张数（byCh 已按张数降序），否则退回抽样投票 / 上一轮结果
    let mainCh = cover.mainCi >= 0 ? chapterInfoOf(lib, cover.mainCi) : null;
    const hitChapters = cover.byCh.slice(0, 5).map(function (e) {
      const c = lib.chapters[e.ci];
      return { chapter: c.comic + ' :: ' + c.title, n: e.n, root: c.rootName || '' };
    });
    if (!mainCh && info.votes.length) {
      const v = info.votes[0];
      const ci = lib.chapters.findIndex(function (c) { return c.comic === v.comic && c.title === v.title; });
      mainCh = chapterInfoOf(lib, ci);
    }
    const libDir = (mainCh && mainCh.dir) ? mainCh.dir : (pv.libDir || '');
    const libCount = (mainCh && mainCh.count) ? mainCh.count : (pv.libCount || 0);
    const h = madHistogram(bestOf);
    const maxMad = bestOf.size ? Math.max.apply(null, [...bestOf.values()].map(function (x) { return x.mad; })) : null;
    const nonExactCount = (u.nonExact || []).length;
    const rec = recordOf(u, {
      pixelCount: pixelOk,
      pixelMap: bestOf,
      hitChapters: hitChapters,
      cover: cover,
      search: {
        samples: info.samples, votes: info.votes, exhaustive: info.exhaustive,
        candidates: info.candidates.map(function (c) { return c.comic + ' :: ' + c.title; })
      },
      maxMad: maxMad,
      madHist: h.hist,
      farCount: h.farCount,
      checkedImages: nonExactCount,
      scoredImages: bestOf.size,
      filteredOut: nonExactCount - bestOf.size,
      scatterHits: verdict === '未找到' ? exactCount + pixelOk : 0,
      matchBy: u.candSrc ? (u.candSrc + ' + 全库像素搜索') : '全库像素搜索',
      thumbCount: thumbCount,
      pixelThreshold: threshold,
      libRoots: libRoots,
      libDir: libDir,
      libRootId: mainCh ? mainCh.rootId : (pv.libRootId || ''),
      libRootName: mainCh ? mainCh.rootName : (pv.libRootName || ''),
      libFirst: mainCh ? mainCh.libFirst : (pv.libFirst || ''),
      libCount: libCount,
      comic: mainCh ? mainCh.comic : (pv.comic || ''),
      chapterTitle: mainCh ? mainCh.title : (pv.chapterTitle || ''),
      chapter: pv.chapter || ''
    });
    units.push(rec);
    // 并行路径已由 worker 上报真实进度；只有回退串行时才在这里报
    if (o.onProgress && !parallelMap) o.onProgress(idx, hashUnits.length, u.id);
    // 让出事件循环：批次间 SSE 才能把真实进度推出去（重活不能阻塞事件循环）
    await sleep(0);
  }
  const summary = {
    完全重复: units.filter(function (f) { return f.judge === '完全重复'; }).length,
    同图不同编码: units.filter(function (f) { return f.judge === '同图不同编码'; }).length,
    部分重复: units.filter(function (f) { return f.judge === '部分重复'; }).length,
    未找到: units.filter(function (f) { return f.judge === '未找到'; }).length,
    字节一致图片数: units.reduce(function (s, f) { return s + f.exactCount; }, 0),
    像素一致图片数: units.reduce(function (s, f) { return s + f.pixelCount; }, 0),
    救援补回图片数: rescueTotal
  };
  const byRoot = libRoots.map(function (r) {
    return {
      id: r.id, name: r.name, path: r.path,
      units: units.filter(function (u) { return u.libRootId === r.id; }).length
    };
  });
  return {
    units: units,
    summary: summary,
    stats: { searched: searched, libImages: lib.N, libChapters: lib.chapters.length, rescue: rescueTotal, byRoot: byRoot }
  };
}
