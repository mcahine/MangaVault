// engine/match.mjs — 多库根 32x32 灰度指纹像素搜索（z 归一化精算 + 章节聚合覆盖率 + 受控救援）。
// 本文件只负责「打分」与「覆盖面统计」，判定口径统一走 scan.mjs 的 judgeOf。
// 依赖: data/dedupe/tmp/fp-lib/（index.json + <key>.bin）+ hash-result.json
//
// 【为什么必须 z 归一化，别退化回纯 raw MAD】
// 重编码（webp <-> jpg）会让整页亮度整体漂移，而 raw MAD 对「整体提亮/压暗」完全失明，
// 对亮度漂移的惩罚经常比「两张无关图」还大。实测 P2「ごちそうさま」在真值章节内有 7 张页：
// z-MAD 只有 0.56~1.02，raw 8x8 粗筛 L1 却高达 1257~9593，被 SEARCH_LIMIT=896 提前排除 —— 
// 这就是用户说的「查重没招」的直接原因。
// 结论：粗筛仍用 raw L1（它对无关图选择性最强，实测负样本保留率 0.04%），
//       但**精算必须用 z-MAD**（去均值 + 除标准差，对亮度/对比度整体漂移免疫）；
//       被粗筛漏掉的那几页由「受控救援」补回（见 RESCUE_MIN 注释）。
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { readSet, readIndex, coarseOf, madOf, FP_GRAY_BYTES } from './fpio.mjs';
import { sleep } from '../../../core/util.mjs';
import { judgeCoverage, recordOf, abortError } from './scan.mjs';
import { keyOf, relInRoot } from './paths.mjs';
import { createLogger } from '../../../core/log.mjs';

// 引擎级日志器：并行失败要留下痕迹，否则真实缺陷会被静默降级吃掉
const log = createLogger('dedupe:match');

export const SEARCH_LIMIT = 64 * 14;   // 8x8 raw L1 粗筛上限（对无关图选择性最强，与原实现一致）
export const SAMPLES = 8;              // 抽样投票数量（只用于界面展示候选章节，不参与判定）
export const SD_FLOOR = 8;             // 标准差下限：低于它视为平坦页，退回 raw MAD，免得归一化把噪声放大
export const RESCUE_THRESH = 2;        // 救援命中阈值：比主阈值 8 紧 4 倍，无守卫的救援会把负样本覆盖率从 1.9% 拉到 77%~100%
export const RESCUE_MIN = 0.5;         // 主章节覆盖率不到这个值就不救援（有守卫才有选择性）
export const COV_FULL = 0.9;           // 主章节覆盖率 >= 90% 即视为「同一部作品」（缺封面/扉页不算未找到）
// 像素比对的默认并行度。实测（4 物理核 / 8 逻辑核）4 线程 36.4s、6 线程 30.1s，
// 再往上（8/12）收益趋平；与 build-fp.py 的 worker 口径保持一致。
export const PIXEL_WORKERS_MAX = 6;

/**
 * 共享指纹缓冲的分块大小。**为什么不再一次性 new SharedArrayBuffer(63MB)**：
 * 主线程本来就持有一份 gray(63MB) Buffer，为了让 6 个 worker 只读共享，
 * 还要再向系统镜像一块同样大的连续共享内存 —— 峰值瞬间翻倍到 130MB 级，
 * 而事故机器的空闲物理内存只有 1.1GB（本机实测）。分块后单次分配上限 64MB，
 * 且任一块分配失败都可被捕获 → 回退串行，不再把整个「重新扫描」拖崩。
 * （注意：SAB 视图跨线程是共享引用，不会把数据复制给每个 worker；
 *   这里省的是「主线程那份额外镜像」，不是「每线程一份拷贝」。）
 * 分块粒度取 16MB：真实库 N≈63395 时 gray=63MB 会被切成 4 块，
 * 单次申请上限从 63MB 降到 16MB，任何一次失败都只抛错、可回退，不会崩。
 */
const SAB_CHUNK_BYTES = 16 * 1024 * 1024;
/** 每个 pixel worker 的额外内存预留（结构化克隆的 chapters/names + 自算 linv/lnrm），实测约 10MB。 */
const PER_WORKER_EXTRA_MB = 12;
/** 留给主线程/浏览器/操作系统的安全水位（MB）：可用内存低于它就一律退回串行。 */
const MEM_RESERVE_MB = 256;

/** 库侧需要跨线程共享的两个大数组（linv/lnrm 由各 worker 自查，不进共享内存）。 */
const LIB_FIELDS = [
  { key: 'gray', f32: false, bytesPer: 1, stride: FP_GRAY_BYTES },
  { key: 'coarse', f32: false, bytesPer: 1, stride: 64 }
];

/**
 * 依据可用内存决定像素并行的线程数。纯函数，便于单测（真实调用传 os.freemem 的结果）。
 * freeMb <= 0 表示取不到内存信息，按「不收缩」处理（沿用 CPU 上限）。
 * 每个 worker 需要：结构化克隆的 chapters/names（约 12MB）+ 自算的 linv/lnrm（8 字节/张）。
 * 例：可用 300MB 时 room=3；可用 256MB 及以下时返回 0（串行）。
 * 可用内存低于安全水位时宁可退回 0（串行），也不要冒被 OOM/看护杀掉的风险。
 */
export function pickPixelWorkers(freeMb, n, cap) {
  const limit = Math.max(0, Number(cap) || 0);
  if (!(freeMb > 0)) return limit;
  const perWorker = PER_WORKER_EXTRA_MB + Math.ceil((Math.max(0, n) * 8) / 1048576);
  const room = Math.floor((freeMb - MEM_RESERVE_MB) / Math.max(1, perWorker));
  return Math.max(0, Math.min(limit, room));
}

/** 系统可用物理内存（MB）。取不到或不合理时返回 -1，调用方按「不限制」处理。 */
export function freeMemMb() {
  try {
    const n = os.freemem();
    if (!Number.isFinite(n) || n <= 0) return -1;
    return Math.floor(n / 1048576);
  } catch (e) { return -1; }
}

/**
 * 把库侧大数组分块搬进 SharedArrayBuffer，并生成一张「采样索引」表。
 * 采样表把 libIdx 映射到「哪个分块 + 块内字节偏移」，worker 与主线程都靠它访问，
 * 避免把数组本身（或视图）结构化克隆过去 —— 视图克隆语义容易踩坑，SAB 只传引用最稳。
 * 返回 { map, attach }；map 可放进 workerData，attach() 负责真正拷贝数据。
 */
export function planLibShared(lib, chunkBytes) {
  const CH = Math.max(64, Number(chunkBytes) || SAB_CHUNK_BYTES);
  const bufs = {};
  for (const f of LIB_FIELDS) {
    // total 是**字节数**：stride 只用于把行号换算成字节偏移，绝不能参与总长度计算
    // （早期版本写成 length * stride，63MB 的 gray 被算成 63GB，共享缓冲必然分配失败，
    //   于是每次都静默回退串行 —— 不崩，但像素阶段慢好几倍，属于自己引入的回归。）
    const total = lib[f.key].length * f.bytesPer;
    const n = Math.max(1, Math.ceil(total / CH));
    const arr = [];
    for (let i = 0; i < n; i++) {
      const span = Math.min(CH, total - i * CH);
      arr.push(new SharedArrayBuffer(span));   // 可能抛错：由调用方捕获并回退串行
    }
    bufs[f.key] = arr;
  }
  function attach() {
    for (const f of LIB_FIELDS) {
      const src = lib[f.key];
      const perChunk = Math.floor(CH / f.stride);   // 每块多少「行」
      const arr = bufs[f.key];
      for (let c = 0; c < arr.length; c++) {
        // 关键：c*perChunk 是行号，落到源缓冲上必须乘 stride 才是字节偏移。
        // 早期版本漏了这一步，结果每块只拷进 perChunk 个字节，并行结果与串行悄悄不一致。
        const from = c * perChunk * f.stride;   // 字节

        const to = Math.min(src.length, from + perChunk * f.stride);
        new Uint8Array(arr[c]).set(src.subarray(from, to));
      }
    }
  }
  const map = { N: lib.N };
  for (const f of LIB_FIELDS) {
    const perChunk = Math.floor(CH / f.stride);
    // 切点必须同时满足两件事：①每个分块边界都要切一刀，否则会出现「采样点比块边界稀疏」
    // 造成空隙 —— 空档里的行会被二分到上一段，算出的下标越过该块末尾，读到 undefined，
    // 像素结果静默错误（N=63395、16MB 分块时确实命中过，只有真实库量级才暴露）。
    // ②采样点也切一刀，让顺序游标 slotCursor 每次推进的距离保持有界。
    const cuts = [];
    const seen = {};
    const addCut = function (r) {
      if (r <= 0 || r >= lib.N || seen[r]) return;
      seen[r] = 1;
      cuts.push(r);
    };
    for (let s = 1; s <= Math.min(64, lib.N); s++) addCut(Math.floor((lib.N * s) / (Math.min(64, lib.N) + 1)));
    for (let c = 1; c * perChunk < lib.N; c++) addCut(c * perChunk);
    cuts.sort(function (a, b) { return a - b; });
    const offs = [];
    const rows = [];
    const next = [];
    const chunk = [];
    for (let i = 0; i <= cuts.length; i++) {
      // 段的起点：第 0 段从行 0 起，其后每段起点就是一个切点
      const start = i === 0 ? 0 : cuts[i - 1];
      if (start >= lib.N) break;
      const ci = Math.floor(start / perChunk);
      // 段的终点：下一个切点、本块末尾、行总数三者取最小 —— 保证段不跨块且首尾相接无空隙
      const end = Math.min(i < cuts.length ? cuts[i] : lib.N, (ci + 1) * perChunk, lib.N);
      rows.push(start);
      offs.push((start - ci * perChunk) * f.stride);
      chunk.push(ci);
      next.push(Math.max(start + 1, end));
    }
    map[f.key] = { bufs: bufs[f.key], offs: offs, rows: rows, next: next, chunk: chunk, stride: f.stride, f32: f.f32 };
  }
  return { map: map, attach: attach };
}

/** 取库图 i 所在的 [视图, 下标]；f32 数组的下标按元素算，u8 数组按字节算。 */
export function sharedSlot(m, i) {
  if (!m.views) m.views = m.bufs.map(function (b) { return m.f32 ? new Float32Array(b) : new Uint8Array(b); });
  let lo = 0;
  if (m.hit !== undefined && i >= m.hitRow && i < m.hitNext) {
    lo = m.hit;
  } else {
    let hi = m.rows.length - 1;
    lo = 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (m.rows[mid] <= i) lo = mid; else hi = mid - 1;
    }
    m.hit = lo;
    m.hitRow = m.rows[lo];
    m.hitNext = m.next[lo];
  }
  return [m.views[m.chunk[lo]], m.offs[lo] + (i - m.rows[lo]) * m.stride];
}

/** 取某个字段第 i 项；map 为空时退回普通数组（串行路径）。返回 [视图, 下标]。 */
export function slotOf(map, plain, i, stride) {
  if (!map) return [plain, i * stride];
  const s = sharedSlot(map, i);
  return [s[0], map.f32 ? s[1] / 4 : s[1]];
}

/**
 * 顺序遍历用的零分配游标。粗筛循环要对全库 6 万多行逐行取 coarse 数据，
 * 每次 new 一个 [视图,下标] 会带来上千万次小对象分配；这里改成游标 + at()。
 */
export function slotCursor(map, plain, stride, start) {
  if (!map) return { plain: plain, stride: stride, rows: null };
  const views = map.views || (map.views = map.bufs.map(function (b) { return map.f32 ? new Float32Array(b) : new Uint8Array(b); }));
  let lo = 0;
  let hi = map.rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.rows[mid] <= start) lo = mid; else hi = mid - 1;
  }
  return {
    plain: null, stride: stride, rows: map.rows, next: map.next, offs: map.offs, chunk: map.chunk, views: views,
    idx: lo, view: views[map.chunk[lo]], base: map.offs[lo], row: map.rows[lo]
  };
}

/** 游标前进到 i，返回该行的下标（视图取 c.view 或 c.plain）。零分配。 */
export function atSlot(c, i) {
  if (c.rows) {
    while (c.idx < c.rows.length - 1 && i >= c.next[c.idx]) {
      c.idx++;
      c.view = c.views[c.chunk[c.idx]];
      c.base = c.offs[c.idx];
      c.row = c.rows[c.idx];
    }
    return c.base + (i - c.row) * c.stride;
  }
  return i * c.stride;
}

function round2(v) { return Math.round(v * 100) / 100; }

/** 单张灰度图的均值与标准差（1024 字节摊平缓冲 + 起始偏移）。 */
export function grayStats(g, off) {
  let s = 0;
  let s2 = 0;
  for (let k = 0; k < FP_GRAY_BYTES; k++) { const v = g[off + k]; s += v; s2 += v * v; }
  const m = s / FP_GRAY_BYTES;
  return { m: m, sd: Math.sqrt(Math.max(0, s2 / FP_GRAY_BYTES - m * m)) };
}

/** 标准差的倒数（1/sd）；低于 SD_FLOOR 的平坦页返回 0，调用方据此退回 raw MAD。 */
export function invOf(sd) { return sd < SD_FLOOR ? 0 : 1 / sd; }

/**
 * 载入全库指纹：把每个章节的 <key>.bin 摊平成一个连续灰度缓冲 + 每张 8x8 粗筛特征，
 * 并预算每张库图的均值/标准差（z 归一化用）。
 * chapters 带 rootId/rootName/rootPath（多库根下用来定位缩略图基准根）。
 * 返回 { chapters, names, chOf, gray, coarse, lmean, lsd, linv, lnrm, N }；没有指纹时返回 null。
 */
export function loadLibraryFingerprints(paths) {
  const index = readIndex(paths.fpLib);
  if (!index || !index.length) return null;
  const chapters = [];
  const names = [];
  const chOf = [];
  const grayParts = [];
  for (const c of index) {
    const set = readSet(path.join(paths.fpLib, c.key + '.bin'));
    if (!set) continue;
    const ci = chapters.length;
    chapters.push({
      key: c.key, dir: c.dir, comic: c.comic, title: c.title,
      rootId: c.rootId || '', rootName: c.rootName || '', rootPath: c.rootPath || '',
      start: names.length, count: 0
    });
    for (const item of set.names) {
      const off = set.offsets.get(item.name);
      if (off === undefined) continue;
      names.push(item.name);
      chOf.push(ci);
      grayParts.push(set.buf.subarray(off, off + FP_GRAY_BYTES));
    }
    chapters[ci].count = names.length - chapters[ci].start;
  }
  const N = names.length;
  if (!N) return null;
  const gray = Buffer.concat(grayParts, N * FP_GRAY_BYTES);
  const coarse = new Uint8Array(N * 64);
  for (let i = 0; i < N; i++) {
    const c = coarseOf(gray, i * FP_GRAY_BYTES);
    coarse.set(c, i * 64);
  }
  // 库侧 z 归一化预算：linv=0 表示平坦页（退回 raw MAD）
  const lmean = new Float32Array(N);
  const lsd = new Float32Array(N);
  const linv = new Float32Array(N);
  const lnrm = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const st = grayStats(gray, i * FP_GRAY_BYTES);
    const iv = invOf(st.sd);
    lmean[i] = st.m;
    lsd[i] = st.sd;
    linv[i] = iv;
    lnrm[i] = st.m * iv;
  }
  return {
    chapters: chapters, names: names, chOf: chOf, gray: gray, coarse: coarse,
    lmean: lmean, lsd: lsd, linv: linv, lnrm: lnrm, N: N, map: null
  };
}

/** 第 i 张库图 -> 命中信息（含所属根与根相对路径，供缩略图 URL 使用）。 */
export function hitOf(lib, i) {
  const name = lib.names[i];
  const ch = lib.chapters[lib.chOf[i]];
  const abs = path.join(ch.dir, name);
  const rel = ch.rootPath ? relInRoot(ch.rootPath, abs) : name;
  return { libIdx: i, libName: name, lib: rel, root: ch.rootId || '' };
}

/**
 * 第 i 张库图与查询图的 z-MAD（去均值 + 除标准差后的平均绝对差）。
 * 任一侧是平坦页（sd < SD_FLOOR）时退回 raw MAD：归一化会把平坦页的噪声放大成随机高分。
 */
export function zMadOf(lib, buf, off, qm, qiv, i) {
  const g = slotOf(lib.map && lib.map.gray, lib.gray, i, FP_GRAY_BYTES);
  const arr = g[0];
  const o2 = g[1];
  const iv = lib.linv[i];
  if (qiv === 0 || iv === 0) {
    let s = 0;
    for (let k = 0; k < FP_GRAY_BYTES; k++) { const d = buf[off + k] - arr[o2 + k]; s += d < 0 ? -d : d; }
    return s / FP_GRAY_BYTES;
  }
  const b = lib.lnrm[i];
  let s = 0;
  for (let k = 0; k < FP_GRAY_BYTES; k++) {
    const d = (buf[off + k] - qm) * qiv - (arr[o2 + k] * iv - b);
    s += d < 0 ? -d : d;
  }
  return s / FP_GRAY_BYTES;
}

/**
 * 在 [start, start+count) 段内找 z-MAD 最小的一张。
 * coarse=true 时先用 8x8 raw L1 粗筛早停（SEARCH_LIMIT），只对通过的算 z-MAD。
 * 返回 { v, i }，没找到时 i = -1。
 */
export function searchZRange(lib, buf, off, cq, qm, qiv, start, count, coarse) {
  const end = Math.min(lib.N, start + count);
  let best = { v: 1e9, i: -1 };
  if (coarse && cq) {
    const cur = slotCursor(lib.map && lib.map.coarse, lib.coarse, 64, start);
    for (let i = start; i < end; i++) {
      const cb = atSlot(cur, i);
      const cArr = cur.rows ? cur.view : cur.plain;
      let s = 0;
      let k = 0;
      for (; k < 64; k++) { const d = cq[k] - cArr[cb + k]; s += d < 0 ? -d : d; if (s > SEARCH_LIMIT) break; }
      if (k < 64) continue;
      const v = zMadOf(lib, buf, off, qm, qiv, i);
      if (v < best.v) best = { v: v, i: i };
    }
    return best;
  }
  for (let i = start; i < end; i++) {
    const v = zMadOf(lib, buf, off, qm, qiv, i);
    if (v < best.v) best = { v: v, i: i };
  }
  return best;
}

/** 在 [start, start+count) 段内找 raw MAD 最小的一张（先粗筛后精算，保留旧口径备用）。 */
export function searchRange(lib, buf, off, cq, start, count) {
  const end = Math.min(lib.N, start + count);
  let best = { v: 1e9, i: -1 };
  const gcur = slotCursor(lib.map && lib.map.gray, lib.gray, FP_GRAY_BYTES, start);
  for (let i = start; i < end; i++) {
    const cb = i * 64;
    let s = 0;
    let k = 0;
    for (; k < 64; k++) { const d = cq[k] - lib.coarse[cb + k]; s += d < 0 ? -d : d; if (s > SEARCH_LIMIT) break; }
    if (k < 64) continue;
    const gb = atSlot(gcur, i);
    const v = madOf(buf, off, gcur.rows ? gcur.view : gcur.plain, gb);
    if (v < best.v) best = { v: v, i: i };
  }
  return best;
}

/** 全库 raw MAD 搜索（保留旧口径备用）。 */
export function searchAll(lib, buf, off, cq) {
  return searchRange(lib, buf, off, cq, 0, lib.N);
}

/** 章节目录（绝对路径） -> 章节下标；找不到返回 -1。exact 里存的是绝对路径。 */
function chapterOfDir(lib, dir) {
  const abs = path.resolve(dir);
  for (let i = 0; i < lib.chapters.length; i++) {
    if (path.resolve(lib.chapters[i].dir) === abs) return i;
  }
  return -1;
}

/** 从指纹集合里取主章节信息（含根标识与首图根相对路径）。 */
function chapterInfoOf(lib, ci) {
  if (ci < 0) return null;
  const c = lib.chapters[ci];
  const first = lib.names[c.start];
  return {
    comic: c.comic, title: c.title, dir: c.dir, count: c.count, name: c.key,
    rootId: c.rootId || '', rootName: c.rootName || '', rootPath: c.rootPath || '',
    libFirst: first ? relInRoot(c.rootPath || '', path.join(c.dir, first)) : ''
  };
}

/** 直方图分桶：<2, <4, <8, <16, <32, >=32（与原实现一致）。 */
export function madHistogram(bestOf) {
  const hist = [0, 0, 0, 0, 0, 0];
  let far = 0;
  for (const v of bestOf.values()) {
    const m = v.mad;
    if (m < 2) hist[0]++;
    else if (m < 4) hist[1]++;
    else if (m < 8) hist[2]++;
    else if (m < 16) hist[3]++;
    else if (m < 32) hist[4]++;
    else { hist[5]++; far++; }
  }
  return { hist: hist, farCount: far };
}

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
