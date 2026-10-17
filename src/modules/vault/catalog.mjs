
import path from 'node:path';
import fsp from 'node:fs/promises';
import { readLibraryIndex } from '../../core/library-index.mjs';
import { roots } from '../../core/roots.mjs';
import { readJson, shortHash, naturalCompare, IMAGE_EXT } from '../../core/util.mjs';
import { META_FILE } from './paths.mjs';

/**
 * 全库目录视图（vault 的“管理对象清单”）。
 *
 * 主数据源是 library 模块写出的 data/library-index.json；但 library 可能还没覆盖某个库根
 * （例如「先期漫画」没有 元数据.json、扫描器未必收录），此时对本根做一次轻量目录兜底：
 * 只读顶层目录名 + 元数据.json，补出最小条目（indexed=false），保证管理功能能用。
 * 图片体积/章节结构等重字段延迟 hydrate，避免每次请求都全盘 stat。
 */

const CACHE_MS = 4000;
let cache = { at: 0, items: null, roots: null, indexCount: 0, extraCount: 0, scannedAt: null, sig: '' };

export function invalidateCatalog() {
  cache = { at: 0, items: null, roots: null, indexCount: 0, extraCount: 0, scannedAt: null, sig: '' };
}

/** 库根签名：id:path 列表。库根一变（增删改路径），缓存必须立刻失效，否则会拿旧根的数据。 */
function rootsSignature(cfg) {
  return roots(cfg).map(function (r) { return r.id + ':' + r.path + ':' + (r.enabled ? 1 : 0); }).join('|');
}

async function dirNamesOf(rootPath) {
  try {
    const entries = await fsp.readdir(rootPath, { withFileTypes: true });
    return entries
      .filter(function (e) { return e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'); })
      .map(function (e) { return e.name; });
  } catch (e) { return []; }
}

function fromIndex(c, rootId) {
  const chapters = Array.isArray(c.chapters) ? c.chapters : [];
  return {
    id: String(c.id), dir: String(c.dir), rootId: rootId, title: String(c.title || c.dir),
    author: c.author || '', tags: Array.isArray(c.tags) ? c.tags : [], categories: Array.isArray(c.categories) ? c.categories : [],
    chineseTeam: c.chineseTeam || '', description: c.description || '', hasMeta: Boolean(c.hasMeta),
    cover: c.cover || null, coverRemote: c.coverRemote || null,
    images: Number(c.images) || 0, bytes: Number(c.bytes) || 0, pagesCount: Number(c.pagesCount) || Number(c.images) || 0,
    likes: Number(c.likes) || 0, views: Number(c.views) || 0,
    chapterCount: Number(c.chapterCount) || chapters.length,
    chapters: chapters.map(function (ch) {
      return { order: Number(ch.order) || 0, title: ch.title || '', dir: ch.dir || '.', count: Number(ch.count) || 0, bytes: Number(ch.bytes) || 0, chapterId: ch.chapterId || null };
    }),
    dirMtime: Number(c.dirMtime) || 0, createdAt: c.createdAt || null, updatedAt: c.updatedAt || null,
    indexed: true, hydrated: true
  };
}

async function fromDir(root, dir) {
  const abs = path.join(root.path, dir);
  const meta = await readJson(path.join(abs, META_FILE), null);
  const m = meta && typeof meta === 'object' ? meta : null;
  let mtime = 0;
  try { mtime = (await fsp.stat(abs)).mtimeMs; } catch (e) { /* 目录可能刚消失 */ }
  return {
    id: m && m.id ? String(m.id) : ('d-' + shortHash(dir, 12)),
    dir: dir, rootId: root.id, title: (m && m.title) || dir,
    author: (m && m.author) || '',
    tags: Array.isArray(m && m.tags) ? m.tags.filter(function (x) { return typeof x === 'string'; }) : [],
    categories: Array.isArray(m && m.categories) ? m.categories.filter(function (x) { return typeof x === 'string'; }) : [],
    chineseTeam: (m && m.chineseTeam) || '', description: (m && m.description) || '', hasMeta: Boolean(m),
    cover: null, coverRemote: null,
    images: null, bytes: null, pagesCount: Number((m && m.pagesCount) || 0) || null,
    likes: Number((m && m.likesCount) || 0), views: Number((m && m.viewsCount) || 0),
    chapterCount: null, chapters: null,
    dirMtime: mtime, createdAt: (m && m.createdAt) || null, updatedAt: (m && m.updatedAt) || null,
    indexed: false, hydrated: false
  };
}

/**
 * 延迟补全：把目录里的图片/章节统计出来（与 library/scanner.mjs 的约定一致）。
 * 单章结构：图片直接躺在漫画目录；多章：一层子目录即章节（再深一层也兼容）。
 */
export async function hydrateComic(cfg, comic) {
  if (!comic || comic.hydrated) return comic;
  const list = roots(cfg);
  const root = list.find(function (r) { return r.id === comic.rootId; }) || list[0];
  if (!root) return comic;
  const abs = path.join(root.path, comic.dir);
  let entries = [];
  try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { comic.hydrated = true; comic.images = 0; comic.bytes = 0; comic.chapters = []; comic.chapterCount = 0; return comic; }
  const coverName = entries.find(function (e) { return e.isFile() && /^cover\.(jpg|jpeg|png|webp)$/i.test(e.name); });
  const topImages = entries
    .filter(function (e) { return e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()) && e.name !== (coverName && coverName.name); })
    .map(function (e) { return e.name; }).sort(naturalCompare);
  const subDirs = entries
    .filter(function (e) { return e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'); })
    .map(function (e) { return e.name; }).sort(naturalCompare);
  const chapters = [];
  for (let i = 0; i < subDirs.length; i++) {
    const sub = subDirs[i];
    const subAbs = path.join(abs, sub);
    let subEntries = [];
    try { subEntries = await fsp.readdir(subAbs, { withFileTypes: true }); } catch (e) { continue; }
    const imgs = subEntries.filter(function (e) { return e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()); }).map(function (e) { return e.name; }).sort(naturalCompare);
    const moreDirs = subEntries.filter(function (e) { return e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'); }).map(function (e) { return e.name; }).sort(naturalCompare);
    if (imgs.length) {
      chapters.push({ order: i + 1, title: sub.replace(/^\s*\d+[\s._\-]*/, '').trim() || sub, dir: sub, count: imgs.length, bytes: await dirBytes(subAbs, imgs), chapterId: null });
      continue;
    }
    for (const deep of moreDirs) {
      const deepAbs = path.join(subAbs, deep);
      let deepEntries = [];
      try { deepEntries = await fsp.readdir(deepAbs, { withFileTypes: true }); } catch (e) { continue; }
      const dimgs = deepEntries.filter(function (e) { return e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()); }).map(function (e) { return e.name; }).sort(naturalCompare);
      if (!dimgs.length) continue;
      chapters.push({ order: chapters.length + 1, title: deep.replace(/^\s*\d+[\s._\-]*/, '').trim() || deep, dir: path.join(sub, deep), count: dimgs.length, bytes: await dirBytes(deepAbs, dimgs), chapterId: null });
    }
  }
  if (!chapters.length && topImages.length) {
    chapters.push({ order: 1, title: '第1話', dir: '.', count: topImages.length, bytes: await dirBytes(abs, topImages), chapterId: null });
  }
  comic.chapters = chapters;
  comic.chapterCount = chapters.length;
  comic.images = chapters.reduce(function (n, c) { return n + c.count; }, 0);
  comic.bytes = chapters.reduce(function (n, c) { return n + c.bytes; }, 0);
  comic.hydrated = true;
  return comic;
}

async function dirBytes(dir, names) {
  let total = 0;
  for (const n of names) {
    try { total += (await fsp.stat(path.join(dir, n))).size; } catch (e) { /* 忽略消失的文件 */ }
  }
  return total;
}

/** 载入目录视图；force 时绕过 4s 缓存与索引 mtime 缓存 */
export async function loadCatalog(cfg, opts) {
  const force = Boolean(opts && opts.force);
  const now = Date.now();
  const sig = rootsSignature(cfg);
  if (sig !== cache.sig) { cache = { at: 0, items: null, roots: null, indexCount: 0, extraCount: 0, scannedAt: null, sig: sig }; }
  if (!force && cache.items && cache.sig === sig && (now - cache.at) < CACHE_MS) return cache;
  const idx = await readLibraryIndex(force);
  const list = roots(cfg);
  const rootDirs = new Map();
  for (const r of list) rootDirs.set(r.id, new Set(r.enabled ? await dirNamesOf(r.path) : []));
  const idxRootPath = idx && idx.root ? path.resolve(String(idx.root)) : null;
  const fallbackRoot = idxRootPath ? (list.find(function (r) { return r.path === idxRootPath; }) || null) : null;
  const items = [];
  const seen = new Set();
  // 是否有任何一个库根成功列出了目录（用于区分「根不可读」与「条目确实过期」）
  const anyRootListed = list.some(function (r) { return r.enabled && rootDirs.get(r.id).size > 0; });
  let staleIndexEntries = 0;
  for (const c of (idx.comics || [])) {
    let rootId = null;
    // 优先按索引条目自带的所属库根 id 定位（library/scanner.mjs 写的 c.root）。
    // 只按「目录名出现在哪个根里」顺序匹配时，两个库根出现同名目录会把两条都算到第一个根上：
    // 目录视图出现错误归属 + 重复条目、总数虚高，真实那一本还会被 orphan 判成「磁盘孤立」——
    // 孤儿清理一执行就会把正常漫画移进回收站（本轮用临时样本实测复现过）。
    if (c.root) {
      const own = list.find(function (r) { return r.id === c.root && rootDirs.get(r.id).has(c.dir); });
      if (own) rootId = own.id;
    }
    if (!rootId) for (const r of list) { if (rootDirs.get(r.id).has(c.dir)) { rootId = r.id; break; } }
    // 索引条目在磁盘上已不存在（目录被改名/删除但还没重扫）：
    // 必须丢弃，否则它会和下面的目录兜底条目重复计数（实测 2 部被算成 3 部）。
    if (!rootId) {
      if (anyRootListed) { staleIndexEntries++; continue; }
      // 所有根都读不到（例如整个根离线）：保守沿用索引，标记为未定位
      if (fallbackRoot) rootId = fallbackRoot.id;
      else if (list.length === 1) rootId = list[0].id;
      if (!rootId) { staleIndexEntries++; continue; }
    }
    items.push(fromIndex(c, rootId));
    seen.add(String(rootId || '?') + '\u0000' + String(c.dir).trim());
  }
  let extraCount = 0;
  for (const r of list) {
    if (!r.enabled) continue;
    const names = rootDirs.get(r.id);
    for (const dir of names) {
      if (seen.has(r.id + '\u0000' + dir.trim())) continue;
      items.push(await fromDir(r, dir));
      extraCount++;
    }
  }
  items.sort(function (a, b) { return naturalCompare(a.title, b.title); });
  const rootsInfo = list.map(function (r) {
    return {
      id: r.id, name: r.name, path: r.path, enabled: r.enabled,
      dirs: rootDirs.get(r.id).size,
      inIndex: items.filter(function (x) { return x.rootId === r.id && x.indexed; }).length,
      extra: items.filter(function (x) { return x.rootId === r.id && !x.indexed; }).length
    };
  });
  cache = { at: now, items: items, roots: rootsInfo, indexCount: (idx.comics || []).length, extraCount: extraCount, staleIndexEntries: staleIndexEntries, scannedAt: (idx && idx.scannedAt) || null, sig: sig };
  return cache;
}

export function findComic(cat, id) {
  const key = String(id == null ? '' : id);
  return (cat.items || []).find(function (c) { return c.id === key; }) || null;
}

export function findComicByDir(cat, rootId, dir) {
  const d = String(dir == null ? '' : dir).trim();
  return (cat.items || []).find(function (c) { return String(c.dir).trim() === d && (!rootId || c.rootId === rootId); }) || null;
}

/** 目录里第一张可用图片（生成封面用） */
export async function firstImageOf(cfg, comic) {
  await hydrateComic(cfg, comic);
  const root = roots(cfg).find(function (r) { return r.id === comic.rootId; }) || roots(cfg)[0];
  if (!root) return null;
  const abs = path.join(root.path, comic.dir);
  const coverName = (await listFiles(abs)).find(function (n) { return /^cover\./i.test(n); }) || null;
  for (const ch of (comic.chapters || [])) {
    if (!ch.count) continue;
    const dir = ch.dir === '.' ? abs : path.join(abs, ch.dir);
    const imgs = (await listFiles(dir)).filter(function (n) { return IMAGE_EXT.has(path.extname(n).toLowerCase()) && n !== coverName; });
    imgs.sort(naturalCompare);
    if (imgs.length) return path.join(dir, imgs[0]);
  }
  const top = (await listFiles(abs)).filter(function (n) { return IMAGE_EXT.has(path.extname(n).toLowerCase()) && n !== coverName; });
  top.sort(naturalCompare);
  if (top.length) return path.join(abs, top[0]);
  return null;
}

async function listFiles(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter(function (e) { return e.isFile() && !e.name.startsWith('.'); }).map(function (e) { return e.name; });
  } catch (e) { return []; }
}
