// engine/pixel-worker.mjs — 像素比对工作线程。
// 设计要点：worker 里**复用 match.mjs 的同一套判定代码**（pixelCompareUnit），
// 只把库侧大数组（gray/coarse）换成 SharedArrayBuffer 的分块视图，
// 因此并行与单线程走的是完全相同的算法，不存在两份实现漂移的风险。
//
// 【为什么 linv/lnrm 不再进共享内存】
// 旧版把 linv/lnrm 也各拷一份进 SAB（Float32Array(N)，N≈63000 时每份 252KB，
// 加上主线程那两份与 6 个 worker 的自有副本，叠加起来是几百 KB~几 MB 的无谓常驻），
// 而这两个数组完全可以从共享的 gray 当场算出来（每张 1024 字节遍历一次）。
// 现改由 worker 在启动时现算，省掉两份共享缓冲与跨线程拷贝。
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { readSet, FP_GRAY_BYTES } from './fpio.mjs';
import { keyOf } from './paths.mjs';
import { pixelCompareUnit, grayStats, SD_FLOOR } from './match.mjs';

/** 标准差的倒数；低于 SD_FLOOR 的平坦页返回 0（与 match.mjs 的 invOf 逐字同口径）。 */
function invOf(sd) { return sd < SD_FLOOR ? 0 : 1 / sd; }

const d = workerData;
const sm = d.shared;
if (!sm) throw new Error('像素工作线程缺少共享缓冲映射表');

// 共享视图（只读）：gray 与 coarse 都按分块拿，绝不复制到线程私有内存
const views = {};
for (const key of Object.keys(sm)) {
  if (key === 'N') continue;
  const m = sm[key];
  views[key] = m.f32 ? m.bufs.map(function (b) { return new Float32Array(b); }) : m.bufs.map(function (b) { return new Uint8Array(b); });
}
const lib = {
  chapters: d.chapters,
  names: d.names,
  chOf: d.chOf,
  N: d.N,
  map: sm,
  // 数据一律走共享分块（见 slotOf/slotCursor），这两个字段在这里不会被读到；
  // 留空数组只是为了让 pixelCompareUnit 的字段形状与主线程一致。
  gray: Buffer.alloc(0),
  coarse: new Uint8Array(0),
  linv: new Float32Array(d.N),
  lnrm: new Float32Array(d.N)
};
// 现算 linv/lnrm：从共享 gray 里读每张的 1024 字节，与主线程 loadLibraryFingerprints 完全同口径。
{
  const g = views.gray;
  const offs = sm.gray.offs;
  const rows = sm.gray.rows;
  const next = sm.gray.next;
  const chunk = sm.gray.chunk;
  for (let seg = 0; seg < rows.length; seg++) {
    const end = next[seg];
    for (let i = rows[seg]; i < end; i++) {
      // 必须用 chunk[seg] 取分块视图：一段≠一块（多个采样段可以落在同一块里）
      const st = grayStats(g[chunk[seg]], offs[seg] + (i - rows[seg]) * FP_GRAY_BYTES);
      const iv = invOf(st.sd);
      lib.linv[i] = iv;
      lib.lnrm[i] = st.m * iv;
    }
  }
}

const out = [];
let done = 0;
for (const u of d.units) {
  // 与主线程同口径：指纹按单元所在目录定位（id 会随库格式正规化改变）
  const fp = readSet(path.join(d.fpDup, keyOf(u.dir || u.id) + '.bin'));
  const res = pixelCompareUnit(lib, u, fp, { pixelThreshold: d.pixelThreshold });
  const bestOf = [];
  for (const entry of res.bestOf) bestOf.push(Object.assign({ name: entry[0] }, entry[1]));
  out.push({ id: u.id, bestOf: bestOf, info: res.info, cover: res.cover });
  done++;
  // 每完成 1 个单元就上报（总单元仅百余个，开销可忽略），主线程据此累计真实进度
  parentPort.postMessage({ progress: done, id: u.id });
}
parentPort.postMessage({ result: out });
