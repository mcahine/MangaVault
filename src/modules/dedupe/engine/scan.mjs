// engine/scan.mjs — 单元发现 + 多库根章节映射 + SHA-256 字节查重（判定口径与原实现一致）。
// 查重侧结构：scanRoot/<分类>/<名称>/图片…（任意层级，凡是「直接含图片的目录」都算一个比对单元）。
// 库侧支持多根（config.libraryRoots），并兼容「目录即章节」形态（先期漫画：图片直接躺在漫画目录、无 元数据.json）。
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listImages, pool, naturalCompare } from '../../../core/util.mjs';
import { ownerOf, relInRoot, isCoverName } from './paths.mjs';

export const VERDICTS = ['完全重复', '同图不同编码', '部分重复', '未找到'];
export const CHAPTER_META = '章节元数据.json';
export const COMIC_META = '元数据.json';
export const PARTIAL_RATIO = 0.3;

/**
 * 判定口径（与 picacg处理/查重模块 完全一致）：
 *  - 全部命中：exact == total -> 完全重复，否则 同图不同编码
 *  - 命中率 >= 30% -> 部分重复（零星命中多来自空白页/扉页巧合，不算）
 *  - 其余 -> 未找到
 */
export function judgeOf(total, exactCount, pixelCount) {
  const n = Number(total) || 0;
  if (!n) return '未找到';
  const exact = Number(exactCount) || 0;
  const pixel = Number(pixelCount) || 0;
  const matched = exact + pixel;
  if (matched === n) return exact === n ? '完全重复' : '同图不同编码';
  return matched / n >= PARTIAL_RATIO ? '部分重复' : '未找到';
}

export const COV_FULL = 0.9;   // 主章节覆盖率 >= 这个值即视为「同一部作品」（缺封面/扉页不算未找到）

/**
 * 覆盖率口径判定（像素阶段用）—— 与 judgeOf 的关键区别：
 * judgeOf 看的是「全库命中总张数 / 总张数」，一次偶然命中就计入分子；
 * 而重编码（webp<->jpg）会让字节级命中几乎全灭，此时唯一可靠的证据是
 * 「绝大多数页都指向同一个库章节」。
 *  - 主章节覆盖率 >= COV_FULL 且所有张数字节一致 -> 完全重复，否则 同图不同编码
 *  - 主章节覆盖率 >= PARTIAL_RATIO，或命中散布在多个章节但总量 >= PARTIAL_RATIO -> 部分重复
 *  - 其余 -> 未找到
 * cover = { total, exact, cov, globalRatio }
 */
export function judgeCoverage(cover) {
  const c = cover || {};
  const total = Number(c.total) || 0;
  if (!total) return '未找到';
  const cov = Number(c.cov) || 0;
  const globalRatio = Number(c.globalRatio) || 0;
  const exact = Number(c.exact) || 0;
  // 全部张数字节一致：定义上就是完全重复（与 judgeOf 一致，不受章节映射影响）
  if (exact === total) return '完全重复';
  if (cov >= COV_FULL) return '同图不同编码';
  if (cov >= PARTIAL_RATIO || globalRatio >= PARTIAL_RATIO) return '部分重复';
  return '未找到';
}

/** 任务中止时统一抛出的错误（runner 据此广播 done{aborted:true}）。 */
export function abortError() {
  return Object.assign(new Error('任务已中止'), { aborted: true });
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw abortError();
}

/** exact 可能是 Map（内存阶段）或普通对象（从 hash-result.json 读回），统一读取。 */
export function exactGet(exact, name) {
  if (!exact) return null;
  if (typeof exact.get === 'function') return exact.get(name) || null;
  return exact[name] || null;
}

/** exact 条目数（兼容 Map 与普通对象）。 */
export function exactSize(exact) {
  if (!exact) return 0;
  if (typeof exact.get === 'function') return exact.size;
  return Object.keys(exact).length;
}

/** 带记忆的文件 SHA-256（流式，避免把大图整块读进内存）。 */
export function makeShaCache() {
  const cache = new Map();
  return function shaOf(abs) {
    let p = cache.get(abs);
    if (p) return p;
    p = new Promise(function (resolve) {
      let hash;
      try { hash = crypto.createHash('sha256'); }
      catch (e) { resolve(''); return; }
      const stream = fs.createReadStream(abs);
      stream.on('data', function (c) { try { hash.update(c); } catch (e) { /* 忽略 */ } });
      stream.on('error', function () { resolve(''); });
      stream.on('end', function () { try { resolve(hash.digest('hex')); } catch (e) { resolve(''); } });
    });
    cache.set(abs, p);
    return p;
  };
}

/** 去掉两边空白与结尾分隔符的展示名。 */
function baseNameOf(rel) {
  const parts = String(rel).split('/');
  return parts[parts.length - 1] || rel;
}

/** 分类 = 相对路径第一段；根目录下的单元记为「(根目录)」（与原实现一致）。 */
function categoryOf(rel) {
  return String(rel).includes('/') ? String(rel).split('/')[0] : '(根目录)';
}


/** 异步读取 JSON，失败返回 null。 */
async function readJsonSafe(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    if (!text.trim()) return null;
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) { return null; }
}

// ============ 1. 多库根索引 ============

/** 统一把入参规范成库根数组：字符串 / 字符串数组 / [{id,name,path}] 都接受。 */
export function normalizeRootList(input) {
  const raw = Array.isArray(input) ? input : (input ? [input] : []);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!e) continue;
    const p = typeof e === 'string' ? e : e.path;
    if (!p) continue;
    const abs = path.resolve(String(p));
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({
      id: String((typeof e === 'object' && e.id) || ('root' + (i + 1))),
      name: String((typeof e === 'object' && e.name) || path.basename(abs) || ('库 ' + (i + 1))),
      path: abs
    });
  }
  return out;
}

export function emptyLib(source) {
  return { comics: [], chapters: [], chapterById: new Map(), sizeIdx: new Map(), libImages: 0, byRoot: [], source: source || '' };
}

function addSize(sizeIdx, size, abs, ch) {
  const arr = sizeIdx.get(size);
  if (arr) arr.push({ abs: abs, ch: ch });
  else sizeIdx.set(size, [{ abs: abs, ch: ch }]);
}

/** 给一个根的索引结果打上根标记并合并进总结果。 */
function mergeLib(merged, part, root) {
  let images = 0;
  for (const comic of part.comics) {
    comic.rootId = root.id;
    comic.rootName = root.name;
    comic.rootPath = root.path;
    merged.comics.push(comic);
  }
  for (const ch of part.chapters) {
    ch.rootId = root.id;
    ch.rootName = root.name;
    ch.rootPath = root.path;
    merged.chapters.push(ch);
    if (ch.chapterId) merged.chapterById.set(ch.chapterId, ch);
    images += ch.files.length;
    for (const name of ch.files) {
      // 体积倒排表：key 用绝对路径（多根下目录不会重名）；拿不到体积的跳过，避免误入同一桶
      const abs = path.join(ch.dir, name);
      const size = part.sizeMap.get(abs);
      if (!size) continue;
      addSize(merged.sizeIdx, size, abs, ch);
    }
  }
  merged.libImages += images;
  merged.byRoot.push({ id: root.id, name: root.name, path: root.path, comics: part.comics.length, chapters: part.chapters.length, images: images });
  return merged;
}

/**
 * 1. 多库根库索引。
 * 每个根：优先复用 Lead 的共享索引 data/library-index.json（若它覆盖该根），否则实时目录遍历。
 * 共享索引里没有单张体积，因此仍逐个 stat 拿 size（stat 失败=文件已删，跳过）。
 * opts: { useSharedIndex?, signal?, statConcurrency? }
 */
export async function buildLibraryIndex(libRoots, onProgress, opts) {
  const o = opts || {};
  const list = normalizeRootList(libRoots);
  const statConcurrency = Number(o.statConcurrency) || 32;
  const merged = emptyLib('');
  const sources = [];
  for (let i = 0; i < list.length; i++) {
    const root = list[i];
    checkAbort(o.signal);
    let part = null;
    if (o.useSharedIndex !== false) part = await buildFromSharedIndex(root, o, statConcurrency);
    if (part) sources.push('library-index');
    else { part = await walkLibraryIndex(root, null, o.signal); sources.push('目录遍历'); }
    mergeLib(merged, part, root);
    if (onProgress) onProgress((i + 1) / list.length, root.name + '（' + root.path + '）');
  }
  merged.source = [...new Set(sources)].join('+');
  return merged;
}

/** 共享索引是否覆盖某个库根（兼容单根 idx.root 与未来的 idx.roots）。 */
function indexCoversRoot(idx, rootPath) {
  const cands = [];
  if (Array.isArray(idx.roots)) {
    for (const r of idx.roots) cands.push(typeof r === 'string' ? r : (r && r.path));
  }
  if (Array.isArray(idx.root)) { for (const r of idx.root) cands.push(typeof r === 'string' ? r : (r && r.path)); }
  else if (idx.root) cands.push(idx.root);
  const target = path.resolve(rootPath);
  return cands.some(function (p) { return p && path.resolve(String(p)) === target; });
}

/** 用 Lead 的共享索引组装单个根；索引不覆盖该根时返回 null（调用方退回目录遍历）。 */
async function buildFromSharedIndex(root, o, statConcurrency) {
  let idx = null;
  try {
    const mod = await import('../../../core/library-index.mjs');
    idx = await mod.readLibraryIndex();
  } catch (e) { return null; }
  if (!idx || !Array.isArray(idx.comics) || !idx.comics.length) return null;
  if (!indexCoversRoot(idx, root.path)) return null;
  const hasPerComicRoot = idx.comics.some(function (c) { return c.rootId || c.root; });
  const comicsOfRoot = hasPerComicRoot
    ? idx.comics.filter(function (c) {
        return (c.rootId && String(c.rootId) === root.id) || (c.root && path.resolve(String(c.root)) === root.path);
      })
    : idx.comics;   // 单根索引：整个索引都属于 idx.root
  if (!comicsOfRoot.length) return null;
  const part = emptyLib('library-index');
  const sizeMap = new Map();
  for (const c of comicsOfRoot) {
    checkAbort(o.signal);
    const dirName = c.dir || c.title || '';
    const cdir = path.join(root.path, dirName);
    const comic = { dir: cdir, name: dirName, id: c.id || '', title: c.title || dirName, chapters: [] };
    for (const ch of (c.chapters || [])) {
      checkAbort(o.signal);
      const names = (Array.isArray(ch.images) ? ch.images.slice() : []).sort(naturalCompare);
      if (!names.length) continue;
      const sdir = ch.dir ? path.join(cdir, ch.dir) : cdir;   // ch.dir 为空 = 目录即章节
      const sized = await pool(names, statConcurrency, async function (n) {
        if (o.signal && o.signal.aborted) throw abortError();
        try { const st = await fsp.stat(path.join(sdir, n)); return st.isFile() ? { name: n, size: st.size } : null; }
        catch (e) { return null; }
      });
      const keep = sized.filter(Boolean);
      if (!keep.length) continue;
      const chRec = {
        dir: sdir, name: ch.dir || '', comic: comic,
        chapterId: ch.chapterId || '',
        chapterTitle: ch.title || ch.dir || comic.title,
        order: (ch.order === undefined || ch.order === null) ? null : ch.order,
        files: keep.map(function (k) { return k.name; }),
        fileSet: new Set(keep.map(function (k) { return k.name; }))
      };
      comic.chapters.push(chRec);
      part.chapters.push(chRec);
      if (chRec.chapterId) part.chapterById.set(chRec.chapterId, chRec);
      for (const k of keep) sizeMap.set(path.join(sdir, k.name), k.size);
    }
    part.comics.push(comic);
  }
  if (!part.chapters.length) return null;
  part.sizeMap = sizeMap;
  return part;
}

/**
 * 实时目录遍历单个根（共享索引不可用时的兜底，也是原实现的口径）。
 * 「目录即章节」：漫画目录没有 元数据.json 却直接含（非 cover.*）图片时，漫画目录本身就是一个章节。
 */
export async function walkLibraryIndex(rootInput, onProgress, signal) {
  const roots = normalizeRootList(rootInput);
  const root = roots[0];
  const part = emptyLib('目录遍历');
  const sizeMap = new Map();
  if (!root) return part;
  let comicNames = [];
  try { comicNames = (await fsp.readdir(root.path, { withFileTypes: true })).filter(function (e) { return e.isDirectory(); }).map(function (e) { return e.name; }); }
  catch (e) { return part; }
  comicNames.sort(naturalCompare);
  for (const comicName of comicNames) {
    checkAbort(signal);
    const cdir = path.join(root.path, comicName);
    const meta = await readJsonSafe(path.join(cdir, COMIC_META));
    const comic = { dir: cdir, name: comicName, id: (meta && meta.id) || '', title: (meta && meta.title) || comicName, chapters: [] };
    const direct = (await listImages(cdir)).filter(function (f) { return !isCoverName(f.name); });
    if (!meta && direct.length) {
      // 目录即章节（先期漫画形态）
      const names = direct.map(function (f) { return f.name; });
      const ch = {
        dir: cdir, name: '', comic: comic, chapterId: '',
        chapterTitle: comic.title, order: null,
        files: names, fileSet: new Set(names)
      };
      comic.chapters.push(ch);
      part.chapters.push(ch);
      for (const f of direct) sizeMap.set(f.abs, f.size || 0);
      part.comics.push(comic);
      if (onProgress) onProgress(part.comics.length, comicName);
      continue;
    }
    let subs = [];
    try { subs = (await fsp.readdir(cdir, { withFileTypes: true })).filter(function (e) { return e.isDirectory(); }).map(function (e) { return e.name; }); }
    catch (e) { subs = []; }
    subs.sort(naturalCompare);
    for (const sub of subs) {
      const sdir = path.join(cdir, sub);
      const files = await listImages(sdir);
      if (!files.length) continue;
      const names = files.map(function (f) { return f.name; });
      const cm = await readJsonSafe(path.join(sdir, CHAPTER_META));
      const ch = {
        dir: sdir, name: sub, comic: comic,
        chapterId: (cm && cm.chapterId) || '',
        chapterTitle: (cm && cm.chapterTitle) || sub,
        order: (cm && cm.order !== undefined) ? cm.order : null,
        files: names, fileSet: new Set(names)
      };
      comic.chapters.push(ch);
      part.chapters.push(ch);
      if (ch.chapterId) part.chapterById.set(ch.chapterId, ch);
      for (let i = 0; i < names.length; i++) sizeMap.set(path.join(sdir, names[i]), files[i].size || 0);
    }
    part.comics.push(comic);
    if (onProgress) onProgress(part.comics.length, comicName);
  }
  part.sizeMap = sizeMap;
  return part;
}

/**
 * 2. 递归发现比对单元：目录「直接含图片」即成为单元并停止下钻（与原实现一致）。
 * 返回 [{ id, name, category, dir, rel, files, bytes }]。
 *
 * id 的口径必须区分两种单元：
 *  - 裸形态（图片直接躺在被点名的那一层，如 scanRoot/<标题>/001.jpg）—— id 是目录名，
 *    这是历史口径，决策表、scan-latest.json、scan-fast.json、前端候选卡片全都按它存。
 *  - 规范形态（漫画目录被整理成 <漫画>/<序> <章节>/ 结构，如 scanRoot/<标题>/1 第1話/001.jpg）
 *    —— id 必须带章节后缀（<标题>/1 第1話）。
 * 为什么规范形态不能沿用目录名：同一部漫画的所有章节都在同一目录名下，不带章节会让多个
 * 章节塌成同一个 id 互相覆盖（指纹文件、决策、删除目标全都会串台）。
 *
 * rel：相对查重根的路径（展示/校验用）。id 是人看的、整理前后会变；指纹缓存因此改按 dir 定位，
 * 详见 collectDupJobs。
 */
export async function discoverUnits(scanRoot, onProgress, signal) {
  const units = [];
  async function walk(dir, rel) {
    checkAbort(signal);
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) { return; }
    const dirs = entries.filter(function (e) { return e.isDirectory(); }).map(function (e) { return e.name; });
    dirs.sort(naturalCompare);
    const imgs = await listImages(dir);
    if (imgs.length) {
      let bytes = 0;
      for (const f of imgs) bytes += f.size || 0;
      /* 单元 id 口径：相对查重根路径里有斜杠就整串用，否则用目录名。
         为什么：规范化形态（L2）的章节是 <漫画>/<序> 第N話/ 层层嵌套，若不带上层目录，
         一部漫画的每一章都叫「1 第1話」，id 全撞在一起（指纹、决策、删除目标全串台）。
         直接用「有没有斜杠」而不是「祖先有没有 元数据.json」是刻意的：
         前者对「分类/<标题>/<章节>/」这类裸布局同样给出唯一 id，且不会因上游形态而改变口径。 */
      const id = (rel && rel.indexOf('/') >= 0) ? rel : baseNameOf(rel);
      units.push({
        id: id,
        name: baseNameOf(rel),
        category: categoryOf(rel),
        dir: dir,
        rel: rel,
        files: imgs.map(function (f) { return f.name; }),
        bytes: bytes
      });
      if (onProgress) onProgress(units.length, rel);
      return;
    }
    for (const d of dirs) await walk(path.join(dir, d), rel ? rel + '/' + d : d);
  }
  if (scanRoot) await walk(scanRoot, '');
  units.sort(function (a, b) { return a.id.localeCompare(b.id); });
  return units;
}

/**
 * 3. 字节级查重：对同尺寸候选做 SHA-256 完全比对，记 exact 命中，并推断候选章节。
 * 原地写 u.exact / u.voteChapter / u.voteComic / u.nonExact / u.cand / u.candSrc / u.sizeVote。
 * 返回 { exactTotal, needPixel }。
 */
export async function byteDedupeUnits(units, lib, opts) {
  const o = opts || {};
  const shaOf = o.shaCache || makeShaCache();
  const chapterById = lib.chapterById;
  const sizeIdx = lib.sizeIdx;
  let exactTotal = 0;
  const needPixel = [];
  for (let ui = 0; ui < units.length; ui++) {
    const u = units[ui];
    checkAbort(o.signal);
    u.exact = new Map();
    u.voteChapter = new Map();
    u.voteComic = new Map();
    u.sizeVote = new Map();
    const tasks = u.files.slice();
    await pool(tasks, Math.max(1, Math.min(o.hashConcurrency || 8, tasks.length || 1)), async function (n) {
      const abs = path.join(u.dir, n);
      let size = 0;
      try { size = (await fsp.stat(abs)).size; } catch (e) { return; }
      const cands = sizeIdx.get(size) || [];
      for (const c of cands) u.sizeVote.set(c.ch, (u.sizeVote.get(c.ch) || 0) + 1);
      if (!cands.length) return;
      let mine = null;
      let hit = null;
      for (const c of cands) {
        if (mine === null) mine = await shaOf(abs);
        if (!mine) break;
        if ((await shaOf(c.abs)) === mine) { hit = c; break; }
      }
      if (hit) {
        u.exact.set(n, hit.abs);
        u.voteChapter.set(hit.ch, (u.voteChapter.get(hit.ch) || 0) + 1);
        u.voteComic.set(hit.ch.comic, (u.voteComic.get(hit.ch.comic) || 0) + 1);
      }
    });
    exactTotal += u.exact.size;
    // 候选章节：24 位十六进制名且命中 chapterId > 内容命中 > 体积近似（>= max(3, 15%)）
    let cand = null;
    let candSrc = '';
    if (/^[0-9a-f]{24}$/.test(u.name) && chapterById.has(u.name)) { cand = chapterById.get(u.name); candSrc = '章节ID'; }
    if (!cand && u.voteChapter.size) {
      cand = [...u.voteChapter.entries()].sort(function (a, b) { return b[1] - a[1]; })[0][0];
      candSrc = '内容命中';
    }
    if (!cand && u.sizeVote.size) {
      const top = [...u.sizeVote.entries()].sort(function (a, b) { return b[1] - a[1]; })[0];
      if (top[1] >= Math.max(3, Math.ceil(u.files.length * 0.15))) { cand = top[0]; candSrc = '体积近似'; }
    }
    u.cand = cand;
    u.candSrc = candSrc;
    u.nonExact = u.files.filter(function (n) { return !u.exact.has(n); });
    if (o.pixelReview !== false && u.nonExact.length && cand) needPixel.push(u);
    if (o.onProgress) o.onProgress((ui + 1) / units.length, u.id);
  }
  return { exactTotal: exactTotal, needPixel: needPixel };
}

/**
 * 单元 -> 最终记录（hash 阶段与 pixel 阶段共用同一口径，避免两处判定漂移）。
 * 多根相关字段：libRootId / libRootName（命中章节所属库根）、libDirRel（章节目录相对根）、
 * libFirst（主章节首图相对根路径，给前端拼缩略图 URL）；samples 每项带 root + 根相对 lib。
 * opts: { pixelCount, pixelMap, hitChapters, search, maxMad, madHist, farCount, checkedImages,
 *         scoredImages, filteredOut, scatterHits, matchBy, thumbCount, pixelThreshold, libRoots, libDir,
 *         libRootId, libRootName, libFirst, libCount, comic, chapter, chapterTitle }
 */
export function recordOf(u, opts) {
  const o = opts || {};
  const threshold = Number(o.pixelThreshold || 8);
  const total = u.files.length;
  const exactCount = exactSize(u.exact);
  const pixelCount = Number(o.pixelCount) || 0;
  const matched = exactCount + pixelCount;
  // 像素阶段带 cover（覆盖率证据）时用覆盖率口径；hash 阶段退回旧口径
  const verdict = o.cover ? judgeCoverage(o.cover) : judgeOf(total, exactCount, pixelCount);
  const pixelMap = o.pixelMap || null;
  const libRoots = o.libRoots || [];
  const libDir = o.libDir || (u.cand ? u.cand.dir : '');
  const ownerDir = libDir ? ownerOf(libRoots, libDir) : null;
  const libRootId = o.libRootId || (ownerDir ? ownerDir.id : '');
  const libRootName = o.libRootName || (ownerDir ? ownerDir.name : '');
  const libDirRel = ownerDir && libDir ? relInRoot(ownerDir, libDir) : '';
  let libFirst = o.libFirst || '';
  if (!libFirst && u.cand && u.cand.files && u.cand.files.length) {
    const own = ownerOf(libRoots, u.cand.dir);
    if (own) libFirst = relInRoot(own, path.join(u.cand.dir, u.cand.files[0]));
  }
  const thumbCount = Number(o.thumbCount) || 6;
  const n = Math.min(thumbCount, total);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const name = u.files[i];
    const ex = exactGet(u.exact, name);
    const px = pixelMap ? (pixelMap.get(name) || null) : null;
    let libRel = '';
    let root = '';
    const mad = ex ? 0 : (px ? px.mad : null);
    if (ex) {
      const own = ownerOf(libRoots, ex);
      if (own) { libRel = relInRoot(own, ex); root = own.id; }
      else libRel = path.basename(ex);
    } else if (px && px.mad <= threshold) {
      libRel = px.lib || px.libName || '';
      root = px.root || libRootId;
    }
    if (verdict === '未找到') { libRel = ''; root = ''; }
    samples.push({ dup: name, lib: libRel, root: root, exact: Boolean(ex), mad: mad === undefined ? null : mad });
  }
  const dupBytes = u.bytes || 0;
  return {
    id: u.id, name: u.name, category: u.category,
    comic: o.comic || (u.cand ? u.cand.comic.name : ''),
    chapter: o.chapter || (u.cand ? u.cand.name : ''),
    chapterTitle: o.chapterTitle || (u.cand ? u.cand.chapterTitle : ''),
    matchBy: o.matchBy || u.candSrc || '',
    libRootId: libRootId,
    libRootName: libRootName,
    libDirRel: libDirRel,
    libFirst: libFirst,
    dupCount: total,
    libCount: o.libCount !== undefined ? o.libCount : (u.cand ? u.cand.files.length : 0),
    dupBytes: dupBytes,
    dupMB: Math.round((dupBytes / 1048576) * 10) / 10,
    exactCount: exactCount, pixelCount: pixelCount, missingCount: total - matched,
    matchRatio: total ? Math.round((matched / total) * 1000) / 1000 : 0,
    scatterHits: o.scatterHits || 0,
    judge: verdict,
    // 覆盖率证据（像素阶段才有）：主章节覆盖率 cov1、救援后 cov、散布命中率 globalRatio
    coverage: o.cover ? {
      total: o.cover.total,
      exact: o.cover.exact,
      pixel: o.cover.pixel,
      rescue: o.cover.rescue,
      cov1: Math.round((o.cover.cov1 || 0) * 1000) / 1000,
      cov: Math.round((o.cover.cov || 0) * 1000) / 1000,
      globalRatio: Math.round((o.cover.globalRatio || 0) * 1000) / 1000
    } : null,
    samples: samples,
    dupDir: u.dir, libDir: libDir,
    maxMad: o.maxMad === undefined ? null : o.maxMad,
    hitChapters: o.hitChapters || [],
    search: o.search || null,
    madHist: o.madHist || null,
    farCount: o.farCount || 0,
    checkedImages: o.checkedImages || 0,
    scoredImages: o.scoredImages || 0,
    filteredOut: o.filteredOut || 0,
    candSrc: u.candSrc || ''
  };
}
