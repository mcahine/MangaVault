// engine/fpio.mjs — 32x32 灰度指纹二进制读写（格式与原实现一致）。
// 格式: int32 条数 + 每条 { int32 名字字节数, UTF8 名字, int32 宽, int32 高, 1024 字节灰度 }
import fs from 'node:fs';
import path from 'node:path';

export const FP_GRAY_BYTES = 1024;
export const FP_SIZE = 32;

/** 读取一个指纹文件，返回 { buf, names, offsets(name->灰度起始偏移) }；失败返回 null。 */
export function readSet(file) {
  let buf = null;
  try { buf = fs.readFileSync(file); } catch (e) { return null; }
  if (!buf || buf.length < 4) return null;
  const names = [];
  const offsets = new Map();
  let o = 4;
  const declared = buf.readInt32LE(0);
  while (o + 4 <= buf.length && names.length < declared) {
    const nl = buf.readInt32LE(o); o += 4;
    if (nl < 0 || o + nl + 8 + FP_GRAY_BYTES > buf.length) break;
    const name = buf.toString('utf8', o, o + nl); o += nl;
    const w = buf.readInt32LE(o); o += 4;
    const h = buf.readInt32LE(o); o += 4;
    offsets.set(name, o);
    names.push({ name: name, w: w, h: h });
    o += FP_GRAY_BYTES;
  }
  return { buf: buf, names: names, offsets: offsets, declared: declared };
}

/** 读取库指纹索引 index.json；失败返回 null。 */
export function readIndex(libFpDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(libFpDir, 'index.json'), 'utf8'));
    return Array.isArray(raw) ? raw : null;
  } catch (e) { return null; }
}

/** 32x32 灰度 -> 8x8 粗筛特征（每格 4x4 平均值），与原实现一致。 */
export function coarseOf(gray, off) {
  const out = new Uint8Array(64);
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let s = 0;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) s += gray[off + (by * 4 + y) * FP_SIZE + bx * 4 + x];
      out[by * 8 + bx] = (s / 16) | 0;
    }
  }
  return out;
}

/** 平均绝对误差（0..255），与原实现的 mad 完全一致。 */
export function madOf(grayA, offA, grayB, offB) {
  let s = 0;
  for (let k = 0; k < FP_GRAY_BYTES; k++) {
    const d = grayA[offA + k] - grayB[offB + k];
    s += d < 0 ? -d : d;
  }
  return s / FP_GRAY_BYTES;
}
