import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * 导出：零依赖手写 ZIP（符合 PKZIP/APPNOTE，中央目录 + CRC32 + UTF-8 文件名标志位）。
 *   zip    → 压缩包（默认 zlib deflate，可选 stored）
 *   cbz    → 同上，扩展名换成 .cbz（漫画阅读器通用格式，结构不变）
 *   folder → 直接复制目录
 */

/* ---------------- CRC32 ---------------- */

const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- DOS 时间 ---------------- */

function dosDateTime(date) {
  const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  };
}

/* ---------------- ZIP 写入 ---------------- */

export const ZIP_METHOD_STORE = 0;
export const ZIP_METHOD_DEFLATE = 8;

/**
 * 打包成 ZIP Buffer。
 * entries: [{ name, data(Buffer), date(Date), method(0|8), compressLevel }]
 * options: { method: 'deflate'|'store', level }
 */
export async function buildZip(entries, options) {
  const o = options || {};
  const defaultMethod = o.method === 'store' ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE;
  const level = Number.isFinite(Number(o.level)) ? Number(o.level) : 6;
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const ent of entries) {
    const nameBuf = Buffer.from(String(ent.name || '').replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(ent.data) ? ent.data : Buffer.from(ent.data || '');
    let method = ent.method === ZIP_METHOD_STORE || ent.method === ZIP_METHOD_DEFLATE ? ent.method : defaultMethod;
    let stored = data;
    if (method === ZIP_METHOD_DEFLATE) {
      const deflated = zlib.deflateRawSync(data, { level: level });
      // 压缩没收益就退回 stored，避免小文件反而变大
      if (deflated.length >= data.length) { method = ZIP_METHOD_STORE; stored = data; } else { stored = deflated; }
    }
    const crc = crc32(data);
    const dt = dosDateTime(ent.date);
    const flags = 0x0800; // bit 11：文件名为 UTF-8（中文名必须）
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dt.time, 12);
    central.writeUInt16LE(dt.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + stored.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), centralBuf, end]);
}

/* ---------------- ZIP 读取（仅测试/自检用：最小解析器） ---------------- */

/** 解析 ZIP Buffer → { name, data, method, crc }[]，用于验证自产包的中央目录正确性。 */
export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // 1) 从尾部倒着找 End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到中央目录结束记录');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录第 ' + (i + 1) + ' 条签名非法');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('本地头签名非法：' + name);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    const data = method === ZIP_METHOD_DEFLATE ? zlib.inflateRawSync(raw) : raw;
    out.push({ name: name, data: data, method: method, crc: crc, crcOk: crc32(data) === crc, utf8: Boolean(flags & 0x0800), size: rawSize });
  }
  return out;
}

/* ---------------- 收集 / 导出 ---------------- */

const SKIP_NAMES = new Set(['元数据.json', '章节元数据.json']);

/** 递归收集目录里的图片文件（跳过元数据与隐藏文件、临时文件）。 */
export async function collectComicFiles(dir, options) {
  const o = options || {};
  const prefix = String(o.prefix || '');
  const out = [];
  const stack = [{ abs: dir, rel: prefix }];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = await fsp.readdir(cur.abs, { withFileTypes: true }); } catch (e) { continue; }
    entries.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }); });
    for (const ent of entries) {
      const name = ent.name;
      if (name.startsWith('.') || name.startsWith('~')) continue;
      if (SKIP_NAMES.has(name)) continue;
      const abs = path.join(cur.abs, name);
      const rel = cur.rel ? (cur.rel + '/' + name) : name;
      if (ent.isDirectory()) { stack.push({ abs: abs, rel: rel }); continue; }
      if (!ent.isFile()) continue;
      out.push({ abs: abs, rel: rel, name: name });
    }
  }
  out.sort(function (a, b) { return a.rel.localeCompare(b.rel, 'zh-Hans-CN', { numeric: true }); });
  if (o.imagesOnly === false) return out;
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.jxl', '.json', '.txt'];
  return out.filter(function (f) { return exts.indexOf(path.extname(f.name).toLowerCase()) >= 0; });
}

/**
 * 把一部漫画打包成 ZIP Buffer。
 * options: { method:'deflate'|'store', prefix, rootFolder }
 */
export async function zipComic(dir, options) {
  const o = options || {};
  const files = await collectComicFiles(dir, { prefix: o.rootFolder === false ? '' : '' });
  const entries = [];
  for (const f of files) {
    let data;
    try { data = await fsp.readFile(f.abs); } catch (e) { continue; }
    entries.push({ name: f.rel, data: data });
  }
  return buildZip(entries, { method: o.method, level: o.level });
}

/** 把目录复制到目标目录（folder 模式）。 */
export async function copyFolder(src, destDir, options) {
  const o = options || {};
  let dest = destDir;
  if (!o.overwrite) {
    let n = 2;
    let candidate = destDir;
    while (true) {
      try { await fsp.stat(candidate); } catch (e) { break; }
      candidate = destDir + ' (' + n + ')';
      n++;
    }
    dest = candidate;
  }
  await fsp.mkdir(dest, { recursive: true });
  const files = await collectComicFiles(src, { imagesOnly: false });
  for (const f of files) {
    const target = path.join(dest, f.rel.replace(/\//g, path.sep));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try { await fsp.copyFile(f.abs, target); } catch (e) { /* 单个文件失败继续 */ }
  }
  return { dir: dest, files: files.length };
}

/** 文件名清洗（导出用，避免非法字符）。 */
export function safeFileBase(name, fallback) {
  const s = String(name == null ? '' : name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  const trimmed = s || fallback || 'comic';
  return trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed;
}
