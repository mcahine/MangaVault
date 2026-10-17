
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);

export function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function shortHash(text, len) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, len || 12);
}

/** 把相对路径安全地拼到 root 下，任何越界（.. / 绝对路径）都抛错。 */
export function safeJoin(root, relative) {
  const absRoot = path.resolve(root);
  const cleaned = String(relative == null ? '' : relative).replace(/^[\\/]+/, '');
  const abs = path.resolve(absRoot, cleaned);
  const rel = path.relative(absRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('路径越界: ' + relative), { statusCode: 400 });
  }
  return abs;
}

export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Windows / 各种文件系统的非法字符清洗，保留中日文。 */
export function sanitizeName(name, fallback) {
  let out = String(name == null ? '' : name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!out) out = fallback || 'untitled';
  if (out.length > 120) out = out.slice(0, 120).trim();
  return out;
}

export function formatBytes(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v = v / 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(v < 10 ? 2 : 1)) + ' ' + units[i];
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * 临时目录候选（从高到低）：MV_TMPDIR -> TEMP -> TMP -> os.tmpdir() -> C:\Windows\Temp
 *
 * 为什么要专门做这件事：在 DSH 的 run_code「内联执行」的 Node 里，process.env 是空对象，
 * 此时 os.tmpdir() 返回的不是 null 也不是抛错，而是一个**看似正常的相对路径** "undefined\\temp"。
 * 直接 path.join 之后目录会静默落进 process.cwd()（曾把垃圾目录写进项目根）。
 * 所以每个候选都必须先过 path.isAbsolute()。
 */
function tempDirCandidates() {
  const list = [process.env.MV_TMPDIR, process.env.TEMP, process.env.TMP];
  try { list.push(os.tmpdir()); } catch (e) { /* 取不到就跳过 */ }
  list.push('C:\\Windows\\Temp');
  return list;
}

/**
 * 创建一个**绝对路径**的临时目录并返回它。
 *
 * 候选逐个尝试：不是绝对路径的候选直接跳过；建不出来（不存在且无权创建）也跳过。
 * 全部候选都失败时抛中文错误 —— **绝不返回相对路径**（那是静默落盘脏数据的根源）。
 *
 * @param {string} [prefix] 目录名前缀，非法字符会被替换为下划线
 * @param {string[]} [candidatesOverride] 仅供单测：覆盖候选列表以模拟异常环境
 * @returns {string} 新建目录的绝对路径
 */
export function safeTmpDir(prefix, candidatesOverride) {
  const leaf = String(prefix == null ? 'mv-tmp' : prefix).replace(/[^A-Za-z0-9._-]/g, '_') || 'mv-tmp';
  const list = Array.isArray(candidatesOverride) ? candidatesOverride : tempDirCandidates();
  const rejected = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw) { rejected.push(String(raw)); continue; }
    // 关键守卫：必须在 path.join/resolve **之前**判断。
    // 因为 path.resolve('undefined\\temp') 总返回绝对路径，会把相对路径「洗白」，守卫就失效了。
    if (!path.isAbsolute(raw)) { rejected.push(raw + '（不是绝对路径）'); continue; }
    try { fs.mkdirSync(raw, { recursive: true }); } catch (e) { /* 已存在或无权创建，交给 mkdtemp 判定 */ }
    try {
      return fs.mkdtempSync(path.join(raw, leaf + '-'));
    } catch (e) {
      rejected.push(raw + '（' + (e && e.code ? e.code : (e && e.message) || '创建失败') + '）');
    }
  }
  throw Object.assign(new Error(
    '找不到可用的绝对临时目录（已尝试：' + rejected.join(' / ') + '）。可用环境变量 MV_TMPDIR 指定一个绝对路径。'
  ), { statusCode: 500 });
}

export async function readJson(file, fallback) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    return fallback;
  }
}

/**
 * Windows 上「目标文件正被另一个句柄读」时 rename 会抛 EPERM（共享冲突）。
 * 典型触发：管理台轮询 /api/vault/* 会不断读 library-index.json，
 * 同时库扫描在 atomicWriteJson 里 rename 覆盖它 —— 实测约 1/3 概率失败，
 * 且失败只写日志：内存里的扫描结果照常生效、磁盘上的索引却还是旧的（幽灵条目永远清不掉）。
 * 这是瞬时冲突，退避重试即可；重试仍失败就把原始错误抛出去，绝不假装写成功。
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

async function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try { await fsp.rename(from, to); return; }
    catch (err) {
      if (i >= 20 || !RENAME_RETRY_CODES.has(err && err.code)) throw err;
      await new Promise(function (r) { setTimeout(r, 25 + i * 25); });
    }
  }
}

export async function atomicWriteJson(file, value, pretty) {
  await ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(value, null, pretty === false ? 0 : 2), 'utf8');
  await renameWithRetry(tmp, file);
}

export async function atomicWrite(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, data);
  await renameWithRetry(tmp, file);
}

/** 递归列出目录（默认深度不限），返回 {dir, name, abs, size, mtime}。 */
export async function listImages(dir) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (ent.name.startsWith('.')) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const abs = path.join(dir, ent.name);
    let st = null;
    try { st = await fsp.stat(abs); } catch (e) { continue; }
    out.push({ name: ent.name, abs: abs, size: st.size, mtime: st.mtimeMs });
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }); });
  return out;
}

/** 并发池：限制并发数执行任务数组。 */
export async function pool(items, limit, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit || 1, list.length || 1));
  const runners = [];
  for (let i = 0; i < size; i++) {
    runners.push((async function () {
      while (true) {
        const idx = cursor++;
        if (idx >= list.length) return;
        results[idx] = await worker(list[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

/** 简易令牌桶 / 间隔限速器。 */
export function createRateLimiter(minIntervalMs) {
  let last = 0;
  let chain = Promise.resolve();
  return function () {
    chain = chain.then(async function () {
      const now = Date.now();
      const wait = last + minIntervalMs - now;
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    return chain;
  };
}

export function parseBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** 自然排序（章节名 1,2,10 而不是 1,10,2）。 */
export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

export function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8'
  };
  return map[ext] || 'application/octet-stream';
}
