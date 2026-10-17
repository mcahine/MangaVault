import fsp from 'node:fs/promises';
import path from 'node:path';
import { dataPath } from '../../core/config.mjs';
import { sanitizeName } from '../../core/util.mjs';
import { atomicWriteJson } from './engine.mjs';

/**
 * 逐页下载台账：断点续传的唯一真源。
 *
 * 为什么要有它：改造前的续传是「下载前扫目标目录，文件大于 512 字节就跳过」——
 * 进程重启后既分不清「已下完」和「下到一半」，也没有任何字节数校验，更无法判断
 * 某个具体页码是否真的落过盘。台账把「哪一章的第几页、落在哪个文件、多少字节」
 * 逐条记下来，重启后按记录核对文件即可精确续传，不需要猜目录。
 *
 * 落盘位置：data/download/ledger/<taskId>.json（dataPath 每次重新求值，遵循 MV_DATA_DIR）。
 * 结构：{ version, taskId, comicId, updatedAt, chapters: { <order>: { title, total, pages: { <index>: { file, bytes, url, at } } } } }
 *
 * 三条硬约束：
 *   1. 写盘复用 engine.mjs 的 atomicWriteJson（临时文件 + rename，且同一目标串行化）；
 *   2. 单进程内对同一 taskId 的写必须串行（见 withLock / flush）；
 *   3. 读不到或 JSON 损坏一律返回空台账 + 记一条日志，**绝不抛异常打断下载**。
 */

export const LEDGER_VERSION = 1;
const DEFAULT_MAX_AGE_DAYS = 30;
const MAX_LOGS = 80;

/** 把值规整为字符串（拿不到就给空串，不瞎编）。 */
function str(v) {
  return v === undefined || v === null ? '' : String(v);
}

/** 数字规整：非有限值一律退回默认值。 */
function num(v, dflt) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  return dflt === undefined ? 0 : dflt;
}

/* ---------------- 日志（读不到/损坏时必须留痕，且不能抛） ---------------- */

let logger = null;
const logs = [];
const missingLogged = new Set();

/** 注入日志器（engine 在 createEngine 时调用；没注入就只进内存环形缓冲）。 */
export function setLogger(l) {
  logger = l && typeof l === 'object' ? l : null;
}

function logLine(level, message) {
  const line = { t: new Date().toISOString(), level: String(level || 'info'), message: String(message) };
  logs.push(line);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  const fn = logger && typeof logger[line.level] === 'function' ? logger[line.level] : null;
  if (fn) {
    try { fn.call(logger, line.message); } catch (e) { /* 日志器自身异常不能影响下载 */ }
  }
}

/** 最近若干条台账日志（测试与排查用：读不到/损坏/落盘失败的证据都在这里）。 */
export function recentLogs() {
  return logs.slice();
}

/** 清空日志缓冲（测试用）。 */
export function clearLogs() {
  logs.length = 0;
}

/* ---------------- 路径 ---------------- */

/** 台账目录：data/download/ledger（每次求值，绝不缓存 —— MV_DATA_DIR 会被测试反复切换）。 */
export function ledgerDir() {
  return dataPath('download', 'ledger');
}

/** 台账文件名：taskId 先过 sanitizeName，杜绝路径穿越与非法字符。 */
function fileOf(taskId) {
  return sanitizeName(str(taskId), 'unknown') + '.json';
}

/** 某个任务的台账文件绝对路径。 */
export function ledgerPath(taskId) {
  return path.join(ledgerDir(), fileOf(taskId));
}

/** 空台账（版本号 + 空章节表）。 */
export function emptyLedger(taskId) {
  return {
    version: LEDGER_VERSION,
    taskId: str(taskId),
    comicId: '',
    updatedAt: new Date().toISOString(),
    chapters: {}
  };
}

/** 把磁盘上读到的任意形状规整成合法台账（多余字段丢弃，缺字段补默认值）。 */
function normalizeDoc(taskId, raw) {
  const doc = emptyLedger(taskId);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return doc;
  doc.comicId = str(raw.comicId);
  doc.updatedAt = str(raw.updatedAt) || doc.updatedAt;
  doc.version = num(raw.version, LEDGER_VERSION) || LEDGER_VERSION;
  const chapters = raw.chapters && typeof raw.chapters === 'object' && !Array.isArray(raw.chapters) ? raw.chapters : {};
  for (const order of Object.keys(chapters)) {
    const src = chapters[order];
    if (!src || typeof src !== 'object') continue;
    const ch = { title: str(src.title), total: num(src.total, 0), pages: {} };
    const pages = src.pages && typeof src.pages === 'object' && !Array.isArray(src.pages) ? src.pages : {};
    for (const index of Object.keys(pages)) {
      const rec = pages[index];
      // 没有 file 的记录无法校验磁盘，直接丢弃（宁可重下一张，也不要凭假记录跳过）
      if (!rec || typeof rec !== 'object' || !rec.file) continue;
      ch.pages[String(index)] = {
        file: str(rec.file),
        bytes: num(rec.bytes, 0),
        url: str(rec.url),
        at: str(rec.at)
      };
    }
    doc.chapters[String(order)] = ch;
  }
  return doc;
}

/* ---------------- 单进程写串行化 ---------------- */

/** key -> 内存台账状态 { doc, mtimeMs, dirty, flushing } */
const states = new Map();
/** key -> 写入队列（同一台账的落盘必须串行，否则 rename 目标会打架） */
const chains = new Map();

function keyOf(taskId) {
  return sanitizeName(str(taskId), 'unknown');
}

function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(function () { /* 上一次失败不能卡死队列 */ }).then(function () { return fn(); });
  chains.set(key, next);
  const drop = function () {
    if (chains.get(key) === next) chains.delete(key);
  };
  next.then(drop, drop);
  return next;
}

/* ---------------- 读 ---------------- */

/**
 * 读台账：返回可用的台账对象（**内存里的活引用**，调用方只读，不要改）。
 * 文件不存在 / JSON 损坏 / 权限异常一律返回空台账并记一条日志，绝不抛。
 * @param {string} taskId
 * @param {{fresh?:boolean}} [options] fresh=true 时忽略内存缓存，强制重读磁盘（测试用）
 */
/**
 * 取（必要时同步创建）某个台账的内存状态。必须在任何 await 之前调用，否则并发读会各建一份状态。
 * seq 是内存改动代次：读盘是异步的，回来时必须用 seq 判断「这期间内存里有没有更新的记录」，
 * 有就绝不能拿磁盘结果去覆盖内存 —— 只靠 dirty 标记挡不住（落盘循环会短暂把它清掉），
 * 实测 20 条并发 recordPage 会因此丢掉 1 条。
 */
function stateOf(key) {
  let st = states.get(key);
  if (!st) {
    st = { doc: emptyLedger(key), mtimeMs: 0, dirty: false, flushing: null, seq: 0 };
    states.set(key, st);
  }
  return st;
}

/**
 * 原地换掉内存台账的内容（不换对象引用）。
 * 为什么必须原地：并发下载时多个 worker 各自持有同一份 doc 的引用，
 * 一旦换成新对象，之前那次读取拿到的引用就成了孤儿，它记下的页会整批丢失。
 */
function applyDoc(st, next) {
  st.doc.version = next.version;
  st.doc.taskId = next.taskId;
  st.doc.comicId = next.comicId;
  st.doc.updatedAt = next.updatedAt;
  st.doc.chapters = next.chapters;
}

export async function read(taskId, options) {
  const key = keyOf(taskId);
  const opts = options || {};
  const file = ledgerPath(key);
  const st = stateOf(key);
  const seq0 = st.seq;
  let stDisk = null;
  try { stDisk = await fsp.stat(file); } catch (e) { stDisk = null; }
  if (!stDisk) {
    if (st.dirty || st.seq !== seq0) return st.doc;
    applyDoc(st, emptyLedger(key));
    st.mtimeMs = 0;
    if (!missingLogged.has(key)) {
      missingLogged.add(key);
      logLine('debug', '台账不存在，按空台账继续下载（任务 ' + key + '）');
    }
    return st.doc;
  }
  if (st.dirty || st.seq !== seq0) return st.doc;
  if (!opts.fresh && st.mtimeMs === stDisk.mtimeMs) return st.doc;
  let raw = null;
  let broken = false;
  try {
    const text = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('台账内容不是一个对象');
    raw = parsed;
  } catch (err) {
    broken = true;
    raw = null;
  }
  // 读盘期间若有新记录进内存（dirty / seq 变了），绝不能被这次读盘结果覆盖
  if (st.dirty || st.seq !== seq0) return st.doc;
  if (broken) {
    logLine('warn', '台账文件损坏，已忽略并重建（任务 ' + key + '，文件 ' + file + '）');
  }
  applyDoc(st, normalizeDoc(key, raw));
  st.mtimeMs = stDisk.mtimeMs;
  return st.doc;
}

/**
 * 读某一章的台账。没有该章返回 null（与「台账存在但该章为空」区分开）。
 * @param {string} taskId
 * @param {number} order 章节序号
 */
export async function readChapter(taskId, order) {
  const doc = await read(taskId);
  const ch = doc.chapters[String(num(order, 0))];
  if (!ch) return null;
  return { title: ch.title, total: ch.total, pages: ch.pages };
}

/* ---------------- 写 ---------------- */

/** 落盘：把内存快照原子写进台账文件；同一 key 的多次调用会被合并，且串行执行。 */
async function flush(key) {
  const st = states.get(key);
  if (!st) return false;
  if (!st.flushing) st.flushing = runFlush(key);
  return st.flushing;
}

async function runFlush(key) {
  const st = states.get(key);
  if (!st) return false;
  let ok = true;
  while (st.dirty) {
    // 先清标记再写：写盘期间新到的记录会把 dirty 重新置上，循环下一轮补写，不丢数据
    st.dirty = false;
    const snapshot = JSON.parse(JSON.stringify(st.doc));
    try {
      await withLock(key, function () { return atomicWriteJson(ledgerPath(key), snapshot); });
      try { st.mtimeMs = (await fsp.stat(ledgerPath(key))).mtimeMs; } catch (e) { /* 取不到 mtime 就不更新缓存 */ }
    } catch (err) {
      // 落盘失败：把脏标记放回去，绝不静默丢数据；调用方已经拿到「记录在内存里」的语义
      st.dirty = true;
      ok = false;
      logLine('warn', '台账落盘失败（任务 ' + key + '）：' + (err && err.message ? err.message : err));
      break;
    }
  }
  st.flushing = null;
  if (st.dirty) return flush(key);
  return ok;
}

/**
 * 整份写台账（覆盖）。给「迁移/修复/测试构造」用；日常逐页累积请用 recordPage。
 * @returns {Promise<object>} 规整后真正写下去的对象
 */
export async function write(taskId, obj) {
  const key = keyOf(taskId);
  const doc = normalizeDoc(key, obj);
  doc.taskId = key;
  doc.updatedAt = new Date().toISOString();
  const st = stateOf(key);
  applyDoc(st, doc);
  st.mtimeMs = 0;
  st.dirty = true;
  st.seq++;
  await flush(key);
  return st.doc;
}

/**
 * 记录一页成功落盘（逐页台账的写入入口）。
 * @param {string} taskId
 * @param {{ comicId?:string, chapterOrder:number, title?:string, total?:number, index:number, file:string, bytes:number, url?:string }} rec
 * @returns {Promise<boolean>} 是否记下（缺 file 直接返回 false）
 */
export async function recordPage(taskId, rec) {
  const key = keyOf(taskId);
  const r = rec && typeof rec === 'object' ? rec : {};
  if (!r.file) return false;
  const order = String(num(r.chapterOrder, 0));
  const index = String(num(r.index, 0));
  const doc = await read(key);
  if (r.comicId) doc.comicId = str(r.comicId);
  let ch = doc.chapters[order];
  if (!ch) {
    ch = { title: '', total: 0, pages: {} };
    doc.chapters[order] = ch;
  }
  if (r.title !== undefined) ch.title = str(r.title);
  if (r.total !== undefined) ch.total = num(r.total, 0);
  ch.pages[index] = {
    file: str(r.file),
    bytes: num(r.bytes, 0),
    url: str(r.url),
    at: new Date().toISOString()
  };
  doc.updatedAt = new Date().toISOString();
  const st = states.get(key);
  if (st) {
    st.dirty = true;
    st.seq++;
  }
  await flush(key);
  return true;
}

/* ---------------- 删 / 清 ---------------- */

/**
 * 删除某个任务的台账（任务完成、被删除、clear-done 时调用）。
 * 先等在途落盘结束，再删文件，避免「刚删又被写回来」。
 */
export async function remove(taskId) {
  const key = keyOf(taskId);
  const st = states.get(key);
  if (st && st.flushing) {
    try { await st.flushing; } catch (e) { /* 落盘失败也要继续删 */ }
  }
  states.delete(key);
  missingLogged.delete(key);
  try {
    await withLock(key, function () { return fsp.rm(ledgerPath(key), { force: true }); });
    return true;
  } catch (err) {
    logLine('warn', '台账删除失败（任务 ' + key + '）：' + (err && err.message ? err.message : err));
    return false;
  }
}

/**
 * 清理超过 maxAgeDays 天的台账（默认 30 天），避免 data/ 无限膨胀。
 * 目录不存在视为「没有台账」，不报错、不创建目录。
 * @returns {Promise<{scanned:number, removed:number, kept:number, errors:number, files:string[]}>}
 */
export async function prune(maxAgeDays) {
  const days = num(maxAgeDays, 0) > 0 ? num(maxAgeDays, 0) : DEFAULT_MAX_AGE_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const dir = ledgerDir();
  const result = { scanned: 0, removed: 0, kept: 0, errors: 0, files: [] };
  let names = [];
  try { names = await fsp.readdir(dir); } catch (e) { return result; }
  for (const name of names) {
    if (!/\.json$/i.test(name)) continue;
    const file = path.join(dir, name);
    result.scanned++;
    let st = null;
    try { st = await fsp.stat(file); } catch (e) { result.errors++; continue; }
    if (st.mtimeMs >= cutoff) { result.kept++; continue; }
    try {
      await fsp.rm(file, { force: true });
      states.delete(name.replace(/\.json$/i, ''));
      result.removed++;
      result.files.push(name);
    } catch (e) {
      result.errors++;
    }
  }
  if (result.removed > 0) logLine('info', '已清理 ' + result.removed + ' 份超过 ' + days + ' 天的下载台账');
  return result;
}

/* ---------------- 汇总 ---------------- */

/** 台账汇总：章数 / 页数 / 已记录字节数（拿不到就是 0，不抛）。 */
export async function stats(taskId) {
  const doc = await read(taskId);
  let pages = 0;
  let bytes = 0;
  const orders = Object.keys(doc.chapters);
  for (const order of orders) {
    const ch = doc.chapters[order];
    const idxs = ch && ch.pages ? Object.keys(ch.pages) : [];
    pages += idxs.length;
    for (const i of idxs) bytes += num(ch.pages[i].bytes, 0);
  }
  return {
    taskId: str(taskId),
    comicId: doc.comicId,
    chapters: orders.length,
    pages: pages,
    bytes: bytes,
    updatedAt: doc.updatedAt
  };
}

/** 清空进程内缓存与日志（测试用；不会动磁盘文件）。 */
export function reset() {
  states.clear();
  chains.clear();
  missingLogged.clear();
  logs.length = 0;
}

