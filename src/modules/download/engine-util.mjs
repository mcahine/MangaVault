import fsp from 'node:fs/promises';
import path from 'node:path';
import { createPaths, extOfFormat, sniffImageExt, listChapterImages, isChapterComplete, MSG_COMIC_META } from './paths.mjs';
import { read as readLedger, recordPage as recordLedgerPage, remove as removeLedger } from './ledger.mjs';

/**
 * 下载引擎的纯工具层：并发池 / 限流 / 速度计 / 原子写 / 元数据构造 / 图片辅助。
 *
 * 从 engine.mjs 拆出。这一层没有闭包状态（只有原子写的序号与写队列两个模块级变量），
 * 与任务生命周期无关，单独成文件后 engine.mjs 只保留 createEngine 本体。
 */

/* 内部小工具（str/num/runPool/sleep/coverUrlOfComic/chapterImageUrls/clone）也 export：engine.mjs 的 createEngine 会跨文件复用。 */
/** 把值规整为字符串（拿不到就返回空串，不瞎编）。 */
export function str(v) {
  return v === undefined || v === null ? '' : String(v);
}

/** 数字规整。 */
export function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
}

/** 合并 abort signal。 */
function anySignal(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ac = new AbortController();
  function onA() { ac.abort(); }
  if (a.aborted || b.aborted) { ac.abort(); return ac.signal; }
  a.addEventListener('abort', onA, { once: true });
  b.addEventListener('abort', onA, { once: true });
  return ac.signal;
}

/** 并发池（不依赖 core 的实现，方便引擎单测）。 */
export async function runPool(items, limit, worker) {
  const list = Array.from(items);
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  let cursor = 0;
  const runners = [];
  for (let i = 0; i < size; i++) {
    runners.push((async function () {
      while (true) {
        const idx = cursor++;
        if (idx >= list.length) return;
        await worker(list[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
}

export function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/**
 * 取封面直链：统一结构优先用 Comic.cover；
 * 老任务里存的是来源原始对象（只有 thumb）时，退回适配器的可选 coverUrl 能力。
 * @param {object} source 下载源适配器
 * @param {object} comic Comic 或来源原始对象
 * @returns {string}
 */
export function coverUrlOfComic(source, comic) {
  const c = comic || {};
  if (c.cover) return String(c.cover);
  const thumb = c.thumb || (c.raw && c.raw.thumb) || null;
  if (thumb && typeof source.coverUrl === 'function') return String(source.coverUrl(thumb) || '');
  return '';
}

/**
 * 取整章图片直链（适配器契约语义）。
 * 优先用可选的 pagesAll（自动翻页 + 整章连续序号）；没有就退回必备的 pages 自己翻页。
 * 返回数组按页序，空 url 也保留 —— 与改造前 allChapterImageUrls 的序号语义一致。
 * @param {object} source 下载源适配器
 * @param {string} comicId
 * @param {number} order
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function chapterImageUrls(source, comicId, order, signal) {
  if (typeof source.pagesAll === 'function') {
    const list = await source.pagesAll(comicId, order, { signal: signal });
    return (list || []).map(function (p) { return String((p && p.url) || ''); });
  }
  if (typeof source.pages !== 'function') {
    throw new Error('该下载源不支持获取章节图片列表（缺少 pages 能力）');
  }
  const urls = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await source.pages(comicId, order, { page: page, signal: signal });
    const docs = (res && res.docs) || [];
    for (const p of docs) urls.push(String((p && p.url) || ''));
    pages = Math.max(1, Number((res && res.pages) || 1));
    page++;
  } while (page <= pages && !(signal && signal.aborted));
  return urls;
}

/**
 * 预约式限速器：保证相邻两次"取号"至少间隔 minIntervalMs。
 * 与 core 的 createRateLimiter 语义一致，但取号不阻塞，适合放进并发池。
 */
export function createLimiter(minIntervalMs) {
  const gap = Math.max(0, Number(minIntervalMs) || 0);
  let next = 0;
  return async function acquire() {
    const now = Date.now();
    const slot = Math.max(now, next);
    next = slot + gap;
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  };
}

/** 轻量速度计：2 秒一个窗口。 */
export function createSpeedometer() {
  let windowStart = Date.now();
  let windowBytes = 0;
  let speed = 0;
  return {
    add: function (bytes) { windowBytes += Math.max(0, num(bytes)); },
    speed: function () {
      const now = Date.now();
      if (now - windowStart >= 2000) {
        speed = windowBytes / Math.max(0.001, (now - windowStart) / 1000);
        windowBytes = 0;
        windowStart = now;
      }
      return Math.round(speed);
    },
    reset: function () { windowStart = Date.now(); windowBytes = 0; speed = 0; }
  };
}

/** 深拷贝（JSON 语义，够用）。 */
export function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }

/**
 * 删除文件/目录，带重试。
 * Windows 上文件句柄释放滞后，递归 rm 常见 EBUSY/EPERM/ENOTEMPTY，
 * 立刻失败就重试（200ms 起线性退避），最后一次仍失败才抛，避免掩盖真实错误。
 */
export async function rmWithRetry(target, tries) {
  const max = Math.max(1, Number(tries) || 5);
  let last = null;
  for (let i = 0; i < max; i++) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return true;
    } catch (err) {
      last = err;
      const code = err && err.code;
      const retriable = ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES', 'EMFILE', 'ENOENT'].indexOf(code) >= 0;
      if (!retriable) throw err;
      if (i < max - 1) await sleep(200 * (i + 1));
    }
  }
  throw last;
}

/** 原子写序号：让并发的原子写各自用不同的临时文件名。 */
let atomicSeq = 0;

/** 每个目标文件一条写入队列：同一个文件的写入必须串行，否则 rename 目标会打架。 */
const atomicChains = new Map();

/** 单次「临时文件 → rename」写入。 */
async function writeAtomicOnce(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  atomicSeq++;
  const tmp = file + '.tmp-' + process.pid + '-' + atomicSeq;
  try {
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    try { await rmWithRetry(tmp, 3); } catch (e) { /* 清理失败不掩盖原错误 */ }
    throw err;
  }
}

/**
 * 原子写 JSON（先写临时文件再 rename）。
 *
 * 并发下载时每个章节完成都会刷新同一份 元数据.json，这里有两重竞态必须挡住：
 *   1. 临时文件名不能共用 —— 共用一个 .tmp-<pid> 时，先完成的 rename 会把后一次正在写的文件搬走（ENOENT）；
 *   2. 同一目标文件的写入必须串行 —— 两次 rename 同时落向 元数据.json，Windows 上会 EBUSY/EPERM，
 *      旧实现会走「写进临时目录」的兜底分支，在漫画目录里留下 .tmp- 残渣。
 * 两者都修掉后，5 次并发写不再失败（改造前实测必现 1 次）。
 */
export async function atomicWriteJson(file, value) {
  const key = path.resolve(file);
  const prev = atomicChains.get(key) || Promise.resolve();
  const next = prev.catch(function () { /* 上一次写入失败不能卡死队列 */ }).then(function () {
    return writeAtomicOnce(file, value);
  });
  atomicChains.set(key, next);
  try {
    await next;
  } finally {
    if (atomicChains.get(key) === next) atomicChains.delete(key);
  }
}

/** 台账里第 order 章第 index 页的记录（没有记录或记录不完整返回 null）。 */
export function chapterPageRecord(ledgerDoc, order, index) {
  if (!ledgerDoc || !ledgerDoc.chapters) return null;
  const ch = ledgerDoc.chapters[String(order)];
  if (!ch || !ch.pages) return null;
  const rec = ch.pages[String(index)];
  return rec && rec.file ? rec : null;
}

/**
 * 台账记录是否可信：文件仍在磁盘、大小 > 0、且字节数与记录**完全一致**。
 * 三条缺一不可 —— 只要对不上就当没记录（宁可重下一张，也不要凭半截文件跳过）。
 */
export async function pageRecordUsable(rec) {
  if (!rec || !rec.file) return false;
  const want = num(rec.bytes, 0);
  if (want <= 0) return false;
  let st = null;
  try { st = await fsp.stat(String(rec.file)); } catch (e) { return false; }
  if (!st.isFile() || st.size <= 0) return false;
  return st.size === want;
}

/**
 * 从下载结果里取「响应声明的字节数」。
 * 适配器可以用 contentLength 或 headers['content-length'] 提供；拿不到就返回 0（= 不校验）。
 */
export function declaredLengthOf(result) {
  if (!result || typeof result !== 'object') return 0;
  const direct = num(result.contentLength, 0);
  if (direct > 0) return direct;
  const headers = result.headers;
  if (headers && typeof headers === 'object') {
    const raw = headers['content-length'] !== undefined ? headers['content-length'] : headers['Content-Length'];
    const n = num(raw, 0);
    if (n > 0) return n;
  }
  return 0;
}

/** 原子替换目录：先把旧目录挪走，再把新目录改名就位，最后异步清理旧目录。 */
export async function swapDir(tmpDir, finalDir) {
  let backup = null;
  try {
    const st = await fsp.stat(finalDir);
    if (st.isDirectory()) {
      backup = finalDir + '.old-' + Date.now();
      await fsp.rename(finalDir, backup);
    }
  } catch (e) { /* 目标不存在 */ }
  try {
    await fsp.rename(tmpDir, finalDir);
  } catch (err) {
    if (backup) { try { await fsp.rename(backup, finalDir); } catch (e) { /* 回滚失败也不掩盖原错误 */ } }
    throw err;
  }
  if (backup) {
    // 旧目录必须删干净：以前这里是 fire-and-forget，测试紧接着 rm 整棵树时
    // 会和这次递归删除撞上（Windows 报 EBUSY/ENOTEMPTY）。改成等待 + 重试，
    // 失败也只记录不抛——目录替换本身已经成功。
    try { await rmWithRetry(backup, 5); } catch (e) { /* 备份目录清理失败不影响替换结果 */ }
  }
}

/** 取第一个「有定义」的值（0 与空串也算有值，只有 undefined/null 跳过）。 */
function firstDefined() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/**
 * 组装元数据.json：以来源详情为底，把 id 标准化、补上本地库约定的章节字段与 pagesCount。
 * 输入既可以是统一 Comic（id / likes / views / chapterCount），也可以是来源原始对象（_id / likesCount / epsCount）；
 * 统一结构没有建模的字段（thumb / creator）从 Comic.raw 兜底，保证落盘内容与改造前一致。
 * format 为 'reference'（默认，字段最少、与 picacomic-downloader 输出一致）或 'rich'（保留原始字段）。
 */
export function buildComicMetadata(comic, chapters, options) {
  const o = options || {};
  const src = comic || {};
  const raw = src.raw || {};
  let meta;
  if (o.format === 'rich') {
    meta = Object.assign({}, clone(src) || {});
  } else {
    const creator = src.creator || src._creator || raw.creator || raw._creator || {};
    const thumb = src.thumb || raw.thumb || {};
    meta = {
      id: str(src.id || src._id || raw._id),
      title: str(src.title),
      author: str(src.author),
      pagesCount: 0,
      chapterInfos: [],
      chapterCount: num(firstDefined(src.chapterCount, src.epsCount, src.eps_count, raw.epsCount, raw.eps_count), (chapters || []).length),
      finished: Boolean(src.finished),
      categories: Array.isArray(src.categories) ? src.categories.slice() : [],
      thumb: { originalName: str(thumb.originalName), path: str(thumb.path), fileServer: str(thumb.fileServer) },
      likesCount: num(firstDefined(src.likes, src.likesCount, raw.likesCount), 0),
      creator: {
        id: str(creator.id || creator._id),
        name: str(creator.name),
        title: str(creator.title),
        verified: creator.verified === undefined ? null : Boolean(creator.verified),
        level: num(creator.level, 0),
        avatar: {
          originalName: str((creator.avatar || {}).originalName),
          path: str((creator.avatar || {}).path),
          fileServer: str((creator.avatar || {}).fileServer)
        },
        slogan: str(creator.slogan),
        role: str(creator.role)
      },
      description: str(src.description),
      chineseTeam: str(src.chineseTeam),
      tags: Array.isArray(src.tags) ? src.tags.slice() : [],
      updatedAt: firstDefined(src.updatedAt, raw.updatedAt) || null,
      createdAt: firstDefined(src.createdAt, raw.createdAt) || null,
      viewsCount: num(firstDefined(src.views, src.viewsCount, raw.viewsCount), 0)
    };
  }
  const list = Array.isArray(chapters) ? chapters : [];
  meta.chapterInfos = list.map(function (ch) {
    return {
      chapterId: str(ch.chapterId || ch._id || ch.id),
      chapterTitle: str(ch.chapterTitle || ch.title),
      order: num(ch.order, 0)
    };
  }).sort(function (a, b) { return a.order - b.order; });
  if (!meta.chapterCount) meta.chapterCount = meta.chapterInfos.length;
  let pages = num(src.pagesCount, 0);
  if (!pages) {
    pages = list.reduce(function (sum, ch) { return sum + num(ch.total || ch.pagesCount, 0); }, 0);
  }
  meta.pagesCount = pages;
  return meta;
}

/** 组装章节元数据.json。 */
export function buildChapterMetadata(chapter) {
  const ch = chapter || {};
  return {
    chapterId: str(ch.chapterId || ch._id || ch.id),
    chapterTitle: str(ch.chapterTitle || ch.title),
    order: num(ch.order, 0)
  };
}

/** 由章节 API 响应 + 本地目录信息构造统一的章节描述。 */
export function normalizeChapter(raw, comicId) {
  const ch = raw || {};
  return {
    chapterId: str(ch.chapterId || ch.id || ch._id),
    chapterTitle: str(ch.chapterTitle || ch.title),
    order: num(ch.order, 0),
    comicId: str(comicId)
  };
}

/** 章目录里是否已有该序号的完整图片（大小 > 0）。 */
export async function hasImage(dir, index, configuredExt, options) {
  const minSize = num((options || {}).minSize, 1);
  const base = ('000' + String(index)).slice(-3);

  const preferred = path.join(dir, base + '.' + configuredExt);
  try {
    const st = await fsp.stat(preferred);
    if (st.isFile() && st.size >= minSize) return true;
  } catch (e) { /* 继续找别的扩展名 */ }
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch (e) { return false; }
  for (const name of entries) {
    if (name.indexOf(base + '.') !== 0) continue;
    const ext = path.extname(name).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'].indexOf(ext) < 0) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile() && st.size >= minSize) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

/** 列出目录里看起来「可疑」（过小/损坏）的图片序号，用于重下。 */
export async function listSuspiciousImages(dir, configuredExt, options) {
  const minSize = num((options || {}).minSize, 512);
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch (e) { return []; }
  const out = [];
  for (const name of entries) {
    if (!/^\d{3,6}\./.test(name)) continue;
    const ext = path.extname(name).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'].indexOf(ext) < 0) continue;
    let st = null;
    try { st = await fsp.stat(path.join(dir, name)); } catch (e) { continue; }
    if (!st.isFile() || st.size >= minSize) continue;
    out.push(Number(name.split('.')[0]));
  }
  return out;
}

/** 判断图片真实扩展名。普通图片跟随 downloadFormat，GIF 永远保留 gif（零依赖无法转码）。 */
export function extForImage(buffer, configuredExt) {
  const sniff = sniffImageExt(buffer);
  if (sniff === 'gif') return 'gif';
  if (sniff) return configuredExt || sniff;
  return configuredExt || 'jpg';
}
