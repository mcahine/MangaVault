
import path from 'node:path';
import fsp from 'node:fs/promises';
import { readJson } from './util.mjs';
import { dataDir } from './config.mjs';

/**
 * 漫画库索引的只读视图（带 mtime 缓存）。
 * library 模块负责写 data/library-index.json；其他模块（reader / download）一律通过这里读，
 * 避免模块在启动时把索引快照进内存，之后扫描更新了却读不到（曾导致「漫画不存在」）。
 */
function indexFile() { return path.join(dataDir(), 'library-index.json'); }
const EMPTY = { version: 1, scannedAt: null, root: null, stats: null, facets: null, comics: [] };
const cache = { mtimeMs: -1, size: -1, data: EMPTY, checkedAt: 0, file: '' };
/* 正在进行的读盘（并发请求共享同一份结果）。
   历史 bug：以前 checkedAt 是在 await 之前推进的，于是「第一个请求还在读盘、第二个请求
   进来」时会走 800ms 短路，直接拿到上一次的快照 —— 索引刚建好时那次就是空快照。
   阅读器同时请求章节数据与图片尺寸，正好会撞上：偶发「漫画不存在」，重试一次又好了。
   现在并发请求共享同一次读取，不再有人拿到中间态。 */
let inFlight = null;

export function indexFilePath() { return indexFile(); }

async function readOnce(file) {
  try {
    const st = await fsp.stat(file);
    if (st.mtimeMs === cache.mtimeMs && st.size === cache.size) { cache.checkedAt = Date.now(); return cache.data; }
    const data = await readJson(file, null);
    if (data && Array.isArray(data.comics)) {
      cache.mtimeMs = st.mtimeMs;
      cache.size = st.size;
      cache.data = data;
    }
  } catch (e) { /* 索引还没生成 */ }
  cache.checkedAt = Date.now();
  return cache.data;
}

export async function readLibraryIndex(force) {
  const file = indexFile();
  if (file !== cache.file) { cache.file = file; cache.mtimeMs = -1; cache.size = -1; cache.data = EMPTY; cache.checkedAt = 0; inFlight = null; }  // 数据目录换了
  if (inFlight) return inFlight;
  if (!force && Date.now() - cache.checkedAt < 800) return cache.data;
  inFlight = readOnce(file);
  try { return await inFlight; } finally { inFlight = null; }
}

export async function listComics() {
  const idx = await readLibraryIndex();
  return idx.comics || [];
}

export async function findComicById(id) {
  const comics = await listComics();
  return comics.find(function (c) { return c.id === id; }) || null;
}

/** 判断某个漫画目录是否已经存在于索引（下载模块用于「已在库」提示） */
export async function findByDir(dirName) {
  const comics = await listComics();
  const key = String(dirName).trim();
  return comics.find(function (c) { return String(c.dir).trim() === key || String(c.title).trim() === key; }) || null;
}

/** 索引整体状态（下载/查重模块用来判断要不要提示先扫描） */
export async function indexSummary() {
  const idx = await readLibraryIndex();
  return { scannedAt: idx.scannedAt || null, root: idx.root || null, stats: idx.stats || null, count: (idx.comics || []).length };
}
