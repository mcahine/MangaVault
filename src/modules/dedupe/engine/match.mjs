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
import { readSet, readIndex, coarseOf, madOf, FP_GRAY_BYTES } from './fpio.mjs';
import { relInRoot } from './paths.mjs';

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
export const PER_WORKER_EXTRA_MB = 12;
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

export function round2(v) { return Math.round(v * 100) / 100; }

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
export function chapterOfDir(lib, dir) {
  const abs = path.resolve(dir);
  for (let i = 0; i < lib.chapters.length; i++) {
    if (path.resolve(lib.chapters[i].dir) === abs) return i;
  }
  return -1;
}

/** 从指纹集合里取主章节信息（含根标识与首图根相对路径）。 */
export function chapterInfoOf(lib, ci) {
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
