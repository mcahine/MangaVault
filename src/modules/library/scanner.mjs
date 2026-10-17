
import path from 'node:path';
import fsp from 'node:fs/promises';
import { readJson, listImages, naturalCompare, shortHash, pool, IMAGE_EXT } from '../../core/util.mjs';

/**
 * 漫画库扫描器。
 * 目录约定（与 picacomic-downloader 产物一致）：
 *   <库根>/<漫画目录>/元数据.json
 *   <库根>/<漫画目录>/cover.jpg
 *   <库根>/<漫画目录>/<order> <章节标题>/章节元数据.json
 *   <库根>/<漫画目录>/<order> <章节标题>/001.jpg …
 * 也兼容：漫画目录下直接放图片（视为单章）、以及多一层子目录的旧结构。
 */

const META_FILE = '元数据.json';
const CHAPTER_META_FILE = '章节元数据.json';

async function dirsOf(dir) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return []; }
  return entries
    .filter(function (e) { return e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'); })
    .map(function (e) { return e.name; })
    .sort(naturalCompare);
}

async function filesOf(dir, onlyImage) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return []; }
  return entries.filter(function (e) {
    if (!e.isFile() || e.name.startsWith('.')) return false;
    if (!onlyImage) return true;
    return IMAGE_EXT.has(path.extname(e.name).toLowerCase());
  }).map(function (e) { return e.name; }).sort(naturalCompare);
}

async function dirBytes(dir, names) {
  let total = 0;
  for (const n of names) {
    try { const st = await fsp.stat(path.join(dir, n)); total += st.size; } catch (e) { /* 忽略消失的文件 */ }
  }
  return total;
}

function parseOrder(name, fallbackIndex) {
  const m = /^(\d+)/.exec(String(name).trim());
  if (m) return parseInt(m[1], 10);
  return fallbackIndex + 1;
}

function stripOrder(name) {
  return String(name).replace(/^\s*\d+[\s._-]*/, '').trim() || String(name).trim();
}

/**
 * 扫描单个漫画目录。
 * @returns {Promise<object|null>}
 */
export async function scanComic(rootPath, dirName, rootMeta) {
  const root = rootPath;
  const meta0 = rootMeta || {};
  const dir = path.join(root, dirName);
  let st = null;
  try { st = await fsp.stat(dir); } catch (e) { return null; }
  if (!st.isDirectory()) return null;

  const meta = await readJson(path.join(dir, META_FILE), null);
  const topFiles = await filesOf(dir, false);
  const coverName = topFiles.find(function (n) { return /^cover\.(jpg|jpeg|png|webp)$/i.test(n); }) || null;
  // 注意：cover.jpg 是封面而不是正文，绝不能因为它存在就把整本漫画误判成「单章」
  const topImages = topFiles.filter(function (n) { return IMAGE_EXT.has(path.extname(n).toLowerCase()) && n !== coverName; });
  const subDirs = await dirsOf(dir);

  const chapters = [];
  const chapterMetaByOrder = new Map();

  if (Array.isArray(meta && meta.chapterInfos)) {
    for (const ci of meta.chapterInfos) {
      if (ci && ci.order !== undefined) chapterMetaByOrder.set(Number(ci.order), ci);
    }
  }

  {
    for (let i = 0; i < subDirs.length; i++) {
      const sub = subDirs[i];
      const subPath = path.join(dir, sub);
      const subImages = (await filesOf(subPath, true));
      if (subImages.length > 0) {
        const bytes = await dirBytes(subPath, subImages);
        const order = parseOrder(sub, i);
        const cm = chapterMetaByOrder.get(order) || (await readJson(path.join(subPath, CHAPTER_META_FILE), null)) || {};
        chapters.push({
          order: Number(cm.order || order),
          title: cm.chapterTitle || stripOrder(sub),
          chapterId: cm.chapterId || null,
          dir: sub,
          images: subImages,
          count: subImages.length,
          bytes: bytes
        });
        continue;
      }
      // 再深一层（旧结构：<漫画>/<分类>/<章节>/图片）
      const subSubs = await dirsOf(subPath);
      let deepFound = false;
      for (let j = 0; j < subSubs.length; j++) {
        const deep = subSubs[j];
        const deepPath = path.join(subPath, deep);
        const deepImages = await filesOf(deepPath, true);
        if (!deepImages.length) continue;
        deepFound = true;
        const bytes = await dirBytes(deepPath, deepImages);
        const order = parseOrder(deep, chapters.length);
        const cm = (await readJson(path.join(deepPath, CHAPTER_META_FILE), null)) || chapterMetaByOrder.get(order) || {};
        chapters.push({
          order: Number(cm.order || order),
          title: cm.chapterTitle || stripOrder(deep),
          chapterId: cm.chapterId || null,
          dir: path.join(sub, deep),
          images: deepImages,
          count: deepImages.length,
          bytes: bytes
        });
      }
      if (!deepFound) {
        // 子目录里没有图片（可能是说明文件/空目录）：只在目录非空时登记，便于用户在体检里发现
        const anyFiles = await filesOf(subPath, false);
        if (anyFiles.length) {
          chapters.push({ order: parseOrder(sub, i), title: stripOrder(sub), chapterId: null, dir: sub, images: [], count: 0, bytes: await dirBytes(subPath, anyFiles) });
        }
      }
    }
  }

  // 没有任何「含图子目录」时才认为正文直接放在漫画目录下（单章结构）
  if (chapters.filter(function (c) { return c.count > 0; }).length === 0 && topImages.length > 0) {
    chapters.length = 0;
    const cm = chapterMetaByOrder.get(1) || {};
    chapters.push({
      order: 1,
      title: cm.chapterTitle || '第1話',
      chapterId: cm.chapterId || null,
      dir: '.',
      images: topImages,
      count: topImages.length,
      bytes: await dirBytes(dir, topImages)
    });
  }

  chapters.sort(function (a, b) { return a.order - b.order; });
  const images = chapters.reduce(function (n, c) { return n + c.count; }, 0);
  const bytes = chapters.reduce(function (n, c) { return n + c.bytes; }, 0);

  const id = (meta && meta.id) || ('d-' + shortHash(dirName, 12));
  const title = (meta && meta.title) || dirName;

  return {
    id: String(id),
    dir: dirName,
    root: meta0.id || null,          // 所属库根 id
    rootName: meta0.name || null,    // 所属库根中文名
    rel: path.join(meta0.id || '', dirName),  // 根内相对路径（多根下唯一）
    title: String(title),
    author: (meta && meta.author) || '',
    tags: Array.isArray(meta && meta.tags) ? meta.tags.filter(function (x) { return typeof x === 'string'; }) : [],
    categories: Array.isArray(meta && meta.categories) ? meta.categories.filter(function (x) { return typeof x === 'string'; }) : [],
    description: (meta && meta.description) || '',
    chineseTeam: (meta && meta.chineseTeam) || '',
    likes: Number((meta && meta.likesCount) || 0),
    views: Number((meta && meta.viewsCount) || 0),
    pagesCount: Number((meta && meta.pagesCount) || images),
    createdAt: (meta && meta.createdAt) || null,
    updatedAt: (meta && meta.updatedAt) || null,
    thumb: (meta && meta.thumb) || null,
    creator: meta && meta.creator ? { name: meta.creator.name || '', avatar: (meta.creator.avatar && meta.creator.avatar.path) || null } : null,
    hasMeta: Boolean(meta),
    cover: coverName,
    coverRemote: (meta && meta.thumb && meta.thumb.fileServer && meta.thumb.path) ? (meta.thumb.fileServer.replace(/\/+$/, '') + '/' + String(meta.thumb.path).replace(/^\/+/, '')) : null,
    chapters: chapters,
    chapterCount: chapters.length,
    images: images,
    bytes: bytes,
    dirMtime: st.mtimeMs
  };
}

/**
 * 全库扫描。
 * @param {string} root 库根目录
 * @param {(p:{phase:string,current:number,total:number,message:string})=>void} onProgress
 */
export async function scanLibrary(root, onProgress) {
  return scanRoots([{ id: 'root', name: '漫画库', path: root }], onProgress);
}

/**
 * 多库根扫描。
 * @param {Array<{id:string,name:string,path:string}>} rootList
 * @param {(p:{phase:string,current:number,total:number,message:string,root?:string})=>void} onProgress
 */
export async function scanRoots(rootList, onProgress) {
  const report = function (phase, current, total, message, rootId) {
    if (typeof onProgress === 'function') { try { onProgress({ phase: phase, current: current, total: total, message: message, root: rootId || null }); } catch (e) {} }
  };

  report('list', 0, 1, '读取 ' + rootList.length + ' 个库根…');
  const jobs = [];      // { rootMeta, name }
  const rootStats = [];
  for (const r of rootList) {
    let entries = [];
    try { entries = await fsp.readdir(r.path, { withFileTypes: true }); }
    catch (err) {
      rootStats.push({ id: r.id, name: r.name, path: r.path, ok: false, error: err.code === 'ENOENT' ? '目录不存在' : String(err.message || err), dirs: 0 });
      report('list', 1, 1, '库根不可读：' + r.name + '（' + (err.code === 'ENOENT' ? '目录不存在' : err.message) + '）', r.id);
      continue;
    }
    const names = entries
      .filter(function (e) { return e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'); })
      .map(function (e) { return e.name; })
      .sort(naturalCompare);
    rootStats.push({ id: r.id, name: r.name, path: r.path, ok: true, error: null, dirs: names.length });
    for (const name of names) jobs.push({ rootMeta: r, name: name });
  }

  report('list', 1, 1, '发现 ' + jobs.length + ' 个漫画目录（' + rootStats.filter(function (r) { return r.ok; }).length + '/' + rootList.length + ' 个根可读）');

  let done = 0;
  const comics = [];
  await pool(jobs, 8, async function (job) {
    const comic = await scanComic(job.rootMeta.path, job.name, job.rootMeta).catch(function () { return null; });
    done++;
    if (comic) comics.push(comic);
    if (done % 5 === 0 || done === jobs.length) {
      report('scan', done, jobs.length, '已解析 ' + done + '/' + jobs.length + ' 个漫画', job.rootMeta.id);
    }
  });

  comics.sort(function (a, b) { return naturalCompare(a.title, b.title); });

  report('facets', 0, 1, '统计标签与作者…');
  const tagCount = new Map();
  const authorCount = new Map();
  const catCount = new Map();
  for (const c of comics) {
    for (const t of c.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    for (const t of c.categories) catCount.set(t, (catCount.get(t) || 0) + 1);
    if (c.author) authorCount.set(c.author, (authorCount.get(c.author) || 0) + 1);
  }
  const top = function (map, n) {
    return Array.from(map.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n).map(function (e) { return { name: e[0], count: e[1] }; });
  };

  const stats = {
    comics: comics.length,
    chapters: comics.reduce(function (n, c) { return n + c.chapterCount; }, 0),
    images: comics.reduce(function (n, c) { return n + c.images; }, 0),
    bytes: comics.reduce(function (n, c) { return n + c.bytes; }, 0),
    withMeta: comics.filter(function (c) { return c.hasMeta; }).length,
    empty: comics.filter(function (c) { return c.images === 0; }).length
  };

  const byRoot = {};
  for (const c of comics) {
    const k = c.root || 'root';
    byRoot[k] = byRoot[k] || { id: k, name: c.rootName || k, comics: 0, chapters: 0, images: 0, bytes: 0 };
    byRoot[k].comics++;
    byRoot[k].chapters += c.chapterCount;
    byRoot[k].images += c.images;
    byRoot[k].bytes += c.bytes;
  }

  report('facets', 1, 1, '统计完成');
  return {
    version: 2,
    roots: rootStats,
    byRoot: byRoot,
    root: rootList.map(function (r) { return r.path; }).join(' ; '),
    scannedAt: new Date().toISOString(),
    stats: stats,
    facets: {
      tags: top(tagCount, 200),
      authors: top(authorCount, 200),
      categories: top(catCount, 100)
    },
    comics: comics
  };
}
