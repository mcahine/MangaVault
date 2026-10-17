// 漫库 MangaVault · 图标生成器（零依赖：zlib + 手写 PNG chunk + 手写 ICO 目录）
// 用法：node desktop/make-icon.mjs   ->  assets/icon.png (256x256)  assets/icon.ico (256/128/64/48/32/16 内嵌 PNG)
// 图形走 v2 RISO 风格：朱红底 #ff4b3e + 纸白 #f2ece1 书页 + 粉色书签 + 网点底纹，不依赖任何字体渲染。

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { clamp } from '../src/core/util.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(ROOT, 'assets');

/* ---------- 颜色（严格取自 UI_GUIDELINE 印色板） ---------- */
const RED = [0xff, 0x4b, 0x3e];
const PAPER = [0xf2, 0xec, 0xe1];
const PINK = [0xff, 0x4f, 0xa3];
const SHADOW = [0, 0, 0, 0.55];
const HALFTONE = [0, 0, 0, 0.09];

/* ---------- PNG：手写 IHDR/IDAT/IEND ---------- */
const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

/** PNG 标准 CRC32 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA 像素 + filter 0 行 -> PNG Buffer */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型 6 = RGBA
  ihdr[10] = 0;  // 压缩方法
  ihdr[11] = 0;  // 滤波方法
  ihdr[12] = 0;  // 隔行扫描
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** 经典 DIB（BITMAPINFOHEADER + BGRA 自下而上 + AND 掩码）：GDI+/旧版资源管理器都能认 */
export function encodeDib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);          // biSize
  header.writeInt32LE(size, 4);         // biWidth
  header.writeInt32LE(size * 2, 8);     // biHeight = 颜色 + 掩码 两张
  header.writeUInt16LE(1, 12);          // biPlanes
  header.writeUInt16LE(32, 14);         // biBitCount
  header.writeUInt32LE(0, 16);          // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];       // B
      xor[d + 1] = rgba[s + 1];   // G
      xor[d + 2] = rgba[s];       // R
      xor[d + 3] = rgba[s + 3];   // A
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      if (rgba[srcRow + x * 4 + 3] >= 128) continue;
      mask[y * maskStride + (x >> 3)] |= (0x80 >> (x & 7));
    }
  }
  return Buffer.concat([header, xor, mask]);
}

/** 单张图标载荷：>=128 用内嵌 PNG（省体积），小图用经典 DIB（最大兼容） */
export function iconPayload(size, png, rgba) {
  if (size >= 128) return { size: size, png: true, data: png };
  return { size: size, png: false, data: encodeDib(size, rgba) };
}

/** ICO：ICONDIR + ICONDIRENTRY[]，载荷按 iconPayload 规则混排 */
export function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type 1 = icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(function (img, i) {
    const payload = img.data ? img : iconPayload(img.size, img.png, img.rgba);
    const o = i * 16;
    dir[o] = payload.size >= 256 ? 0 : payload.size;   // 256 记作 0
    dir[o + 1] = payload.size >= 256 ? 0 : payload.size;
    dir[o + 2] = 0;                                    // 调色板数
    dir[o + 3] = 0;                                    // reserved
    dir.writeUInt16LE(1, o + 4);                       // 色彩平面
    dir.writeUInt16LE(32, o + 6);                      // 位深
    dir.writeUInt32LE(payload.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += payload.data.length;
  });
  return Buffer.concat([header, dir].concat(images.map(function (img, i) {
    return (img.data ? img : iconPayload(img.size, img.png, img.rgba)).data;
  })));
}

/* ---------- 绘制 ---------- */

/** u,v 是否落在「中心 + 半宽半高」的矩形内 */
function inRect(u, v, cx, cy, halfW, halfH) {
  return Math.abs(u - cx) <= halfW && Math.abs(v - cy) <= halfH;
}

/** 阴影的软边台阶（零模糊工具下用分层硬边近似投影质感） */
function shadowAlpha(t) {
  if (t < 0.30) return 0.55;
  if (t < 0.62) return 0.34;
  return 0.20;
}

/**
 * 按相对坐标 (u,v ∈ [0,1]) 求颜色，返回 [r,g,b,a]，a ∈ [0,1]。
 * 形状：朱红底 + 网点底纹 + 深色硬投影 + 纸白书页 + 粉色书签。
 */
export function sampleIcon(u, v) {
  // 1) 整块裁切（切角 .cut 的语义：四角斜切 10%）
  const cut = 0.105;
  if (u < cut && v < cut && (u + v) < cut) return [0, 0, 0, 0];
  if (u > 1 - cut && v < cut && ((1 - u) + v) < cut) return [0, 0, 0, 0];
  if (u < cut && v > 1 - cut && (u + (1 - v)) < cut) return [0, 0, 0, 0];
  if (u > 1 - cut && v > 1 - cut && ((1 - u) + (1 - v)) < cut) return [0, 0, 0, 0];
  // 2) 四角小缺口（呼应 UI 的纸角剪口）
  const notch = 0.135;
  const inNotch = (u < notch && v < notch) || (u > 1 - notch && v < notch) || (u < notch && v > 1 - notch) || (u > 1 - notch && v > 1 - notch);
  if (inNotch) return [0, 0, 0, 0];
  // 3) 朱红底 + 网点
  let col = RED.slice();
  const gx = u * 12;
  const gy = v * 12 + (Math.floor(u * 12) % 2 ? 0.5 : 0);
  const dx = gx - Math.round(gx);
  const dy = gy - Math.round(gy);
  if (Math.sqrt(dx * dx + dy * dy) < 0.17) col = [Math.round(RED[0] * (1 - HALFTONE[3])), Math.round(RED[1] * (1 - HALFTONE[3])), Math.round(RED[2] * (1 - HALFTONE[3]))];
  // 4) 书本参数（绕书脊微旋 -4.5deg，手作感）
  const cx = 0.5, cy = 0.525, halfW = 0.305, halfH = 0.335;
  const ang = -4.5 * Math.PI / 180;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const pu = u - cx, pv = v - cy;
  const lu = pu * cos + pv * sin;
  const lv = -pu * sin + pv * cos;
  const solid = inRect(lu, lv, 0, 0, halfW, halfH);
  const shadow = !solid && inRect(lu, lv, 0.035, 0.035, halfW, halfH);
  const onFace = inRect(lu, lv, 0.0725, 0, halfW - 0.0725, halfH);
  const seal = (lu - 0.175) * (lu - 0.175) + (lv - 0.205) * (lv - 0.205) <= 0.0805 * 0.0805;
  if (solid) {
    col = seal ? RED.slice() : PAPER.slice();
    if (onFace && !seal) col = [Math.round(PAPER[0] - 8), Math.round(PAPER[1] - 10), Math.round(PAPER[2] - 12)];
    return [col[0], col[1], col[2], 1];
  }
  if (shadow) {
    const t = (lu * lu + lv * lv) / 0.2;
    const a = shadowAlpha(clamp(t, 0, 1));
    return [0, 0, 0, a];
  }
  // 5) 粉色书签（右上角伸出书外）
  if (inRect(lu, lv, 0.225, -0.30, 0.032, 0.062)) return [PINK[0], PINK[1], PINK[2], 1];
  return [col[0], col[1], col[2], 1];
}

/** 以超采样渲染一张 RGBA 位图 */
export function renderIcon(size, samplesPerAxis) {
  const n = samplesPerAxis || 3;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const u = (x + (sx + 0.5) / n) / size;
          const v = (y + (sy + 0.5) / n) / size;
          const c = sampleIcon(u, v);
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const total = n * n;
      const alpha = a / total;
      const o = (y * size + x) * 4;
      if (alpha <= 0.0001) {
        rgba[o] = 0; rgba[o + 1] = 0; rgba[o + 2] = 0; rgba[o + 3] = 0;
      } else {
        rgba[o] = Math.round(r / a);
        rgba[o + 1] = Math.round(g / a);
        rgba[o + 2] = Math.round(b / a);
        rgba[o + 3] = Math.round(alpha * 255);
      }
    }
  }
  return rgba;
}

/** 生成 assets/icon.png 与 assets/icon.ico，返回写入信息 */
export function buildIcons(outDir) {
  const dir = outDir || ASSETS;
  fs.mkdirSync(dir, { recursive: true });
  const mainRgba = renderIcon(256, 3);
  const main = encodePng(256, 256, mainRgba);
  const pngPath = path.join(dir, 'icon.png');
  fs.writeFileSync(pngPath, main);
  const sizes = [256, 128, 64, 48, 32, 16];
  const images = sizes.map(function (s) {
    const rgba = s === 256 ? mainRgba : renderIcon(s, 4);
    const png = s === 256 ? main : encodePng(s, s, rgba);
    return { size: s, png: png, rgba: rgba };
  });
  const ico = encodeIco(images);
  const icoPath = path.join(dir, 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  return { png: pngPath, ico: icoPath, pngBytes: main.length, icoBytes: ico.length, sizes: sizes };
}

// 直接运行：node desktop/make-icon.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const info = buildIcons();
  console.log('已生成 ' + info.png + ' (' + info.pngBytes + ' 字节)');
  console.log('已生成 ' + info.ico + ' (' + info.icoBytes + ' 字节, 含 ' + info.sizes.join('/') + ' 尺寸)');
}
