
import path from 'node:path';
import { readJson, atomicWriteJson } from './util.mjs';
import { dataDir } from './config.mjs';

/**
 * 阅读进度（data/library-progress.json）统一读写入口。
 * library 与 reader 两个模块都写这个文件，若各自缓存内存快照会互相覆盖，
 * 所以这里每次都以磁盘为准（mtime 缓存），写操作串行化。
 */
function progressFile() { return path.join(dataDir(), 'library-progress.json'); }
let cache = { mtimeMs: -1, data: {}, checkedAt: 0, file: '' };
let writeChain = Promise.resolve();

export function progressFilePath() { return progressFile(); }

export async function readProgress() {
  const now = Date.now();
  const file = progressFile();
  if (file !== cache.file) { cache.file = file; cache.data = {}; cache.checkedAt = 0; }
  if (now - cache.checkedAt < 500) return cache.data;
  cache.checkedAt = now;
  const data = await readJson(file, null);
  if (data && typeof data === 'object') {
    cache.mtimeMs = now;
    cache.data = data;
  }
  return cache.data;
}

/** 写入一条进度记录：{ comicId, chapter, index, chapterRead, title, totalImages } */
export async function saveProgress(entry) {
  const comicId = String(entry && entry.comicId || '');
  if (!comicId) throw Object.assign(new Error('缺少 comicId'), { statusCode: 400 });
  writeChain = writeChain.then(async function () {
    const data = await readProgress();
    const old = data[comicId] || {};
    data[comicId] = {
      comicId: comicId,
      title: entry.title || old.title || '',
      chapter: Number(entry.chapter || old.chapter || 1),
      chapterTitle: entry.chapterTitle || old.chapterTitle || '',
      index: Math.max(0, Number(entry.index === undefined ? (old.index || 0) : entry.index)),
      chapterRead: Math.max(Number(old.chapterRead) || 0, Number(entry.chapterRead) || (Number(entry.index) + 1) || 0),
      totalImages: Number(entry.totalImages || old.totalImages || 0),
      updatedAt: new Date().toISOString()
    };
    cache.data = data;
    await atomicWriteJson(progressFile(), data);
  });
  await writeChain;
  return cache.data[comicId];
}

export async function continueList(limit) {
  const data = await readProgress();
  return Object.values(data)
    .sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); })
    .slice(0, limit || 12);
}
