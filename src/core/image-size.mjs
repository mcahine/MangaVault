
/**
 * 图片头部尺寸读取（零第三方依赖）。
 *
 * 为什么需要它：阅读器原来只在 <img> 上写 src，浏览器要等图片下载完才知道宽高，
 * 于是每张图加载完都把后面的内容重新挤一遍 —— 条漫里就是「边滚边跳、滚到哪卡到哪」。
 * 把宽高提前写进 <img>，浏览器在解码前就能算出每张的占位高度，滚动与翻页都稳。
 *
 * 只读文件头部（默认 64KB，认不出再补读一次到 256KB），所以对 6 万张的库也不构成负担。
 * 支持的容器：JPEG（含 progressive，SOF0/1/2/9/10/14…）、PNG、GIF、WebP（VP8 / VP8L / VP8X）。
 */
import fsp from 'node:fs/promises';

const HEAD_BYTES = 64 * 1024;
const HEAD_BYTES_BIG = 256 * 1024;

/** 从已读到的头部字节里解析宽高；认不出来返回 null。 */
export function sizeFromBuffer(buf) {
  if (!buf || buf.length < 16) return null;
  try {
    // PNG：8 字节签名 + 长度(4) + 'IHDR' + 宽(4) + 高(4)
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      if (buf.length < 24) return null;
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      return w > 0 && h > 0 ? { w: w, h: h } : null;
    }
    // GIF：'GIF8' + 宽(2,LE) + 高(2,LE)
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      const w = buf.readUInt16LE(6);
      const h = buf.readUInt16LE(8);
      return w > 0 && h > 0 ? { w: w, h: h } : null;
    }
    // WebP：RIFF....WEBP + 变体块
    if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('latin1', 12, 16);
      if (fourcc === 'VP8 ') {
        // 关键帧头：3 字节 tag + 0x9D 0x01 0x2A + 宽(2,LE,14bit) + 高(2,LE,14bit)
        if (buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
          const w = buf.readUInt16LE(26) & 0x3fff;
          const h = buf.readUInt16LE(28) & 0x3fff;
          if (w > 0 && h > 0) return { w: w, h: h };
        }
        return null;
      }
      if (fourcc === 'VP8L') {
        // 无损：0x2F + 14bit 宽 + 14bit 高（位跨字节拼）
        if (buf[20] !== 0x2f) return null;
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        const w = 1 + (((b1 & 0x3f) << 8) | b0);
        const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return w > 0 && h > 0 ? { w: w, h: h } : null;
      }
      if (fourcc === 'VP8X') {
        // 扩展格式（动图/透明）：canvas 宽高各 3 字节 LE，存的是「值-1」
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return w > 0 && h > 0 ? { w: w, h: h } : null;
      }
      return null;
    }
    // JPEG：逐段扫描到 SOF（C4 是 DHT、C8 是 JPG、CC 是 DAC，都不是尺寸）
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let p = 2;
      while (p + 9 < buf.length) {
        if (buf[p] !== 0xff) { p++; continue; }
        let marker = buf[p + 1];
        while (marker === 0xff && p + 2 < buf.length) { p++; marker = buf[p + 1]; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
        if (marker === 0xd9 || marker === 0xda) return null;   // EOI / 进了扫描数据，等不到 SOF
        const len = buf.readUInt16BE(p + 2);
        if (len < 2) return null;
        const isSof = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          if (p + 9 >= buf.length) return null;
          const h = buf.readUInt16BE(p + 5);
          const w = buf.readUInt16BE(p + 7);
          return w > 0 && h > 0 ? { w: w, h: h } : null;
        }
        p += 2 + len;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

/** 读单个图片文件的宽高。读不到（不是图片 / 头部残缺）返回 null。 */
export async function readImageSize(abs, options) {
  const o = options || {};
  let fh = null;
  try {
    fh = await fsp.open(abs, 'r');
    let size = o.headBytes || HEAD_BYTES;
    let buf = Buffer.alloc(size);
    let read = await fh.read(buf, 0, size, 0);
    let hit = sizeFromBuffer(buf.subarray(0, read.bytesRead));
    if (hit) return hit;
    // JPEG 的 SOF 理论上总在很前面，但陈年文件 / 超大 ICC 段落也可能拖后，补读一次
    if (size < HEAD_BYTES_BIG) {
      size = HEAD_BYTES_BIG;
      buf = Buffer.alloc(size);
      read = await fh.read(buf, 0, size, 0);
      hit = sizeFromBuffer(buf.subarray(0, read.bytesRead));
      if (hit) return hit;
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (fh) { try { await fh.close(); } catch (e) { /* 已经关掉了 */ } }
  }
}

/**
 * 批量读尺寸（有界并发）。files 是 [{ name, abs }]，返回与入参等长、顺序一致的数组，
 * 读不到的位是 null —— **不要过滤掉**，否则调用方就没法按下标对齐页码了。
 */
export async function readImageSizes(files, options) {
  const o = options || {};
  const list = Array.isArray(files) ? files : [];
  const out = new Array(list.length).fill(null);
  const workers = Math.max(1, Math.min(32, Number(o.concurrency) || 16));
  let next = 0;
  async function pump() {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      const f = list[i];
      out[i] = f && f.abs ? await readImageSize(f.abs, o) : null;
    }
  }
  const pool = [];
  for (let i = 0; i < workers; i++) pool.push(pump());
  await Promise.all(pool);
  return out;
}
