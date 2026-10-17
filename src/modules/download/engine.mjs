import fsp from 'node:fs/promises';
import path from 'node:path';
import { createPaths, extOfFormat, sniffImageExt, listChapterImages, isChapterComplete, MSG_COMIC_META } from './paths.mjs';
import { read as readLedger, recordPage as recordLedgerPage, remove as removeLedger, setLogger as setLedgerLogger } from './ledger.mjs';

/**
 * 下载引擎：把一部漫画的若干章节下载到 downloadRoot 下，结构与现有库同构。
 * 全部依赖注入（source / store / emit / config / log）：
 *   source 是下载源适配器（sources/types.mjs 的契约），引擎只认 Comic/Chapter/Page 统一结构，
 *   不 import 任何具体来源、也不认识哔咔的字段名。
 */

/** 把值规整为字符串（拿不到就返回空串，不瞎编）。 */
function str(v) {
  return v === undefined || v === null ? '' : String(v);
}

/** 数字规整。 */
function num(v, dflt) {
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
async function runPool(items, limit, worker) {
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

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/**
 * 取封面直链：统一结构优先用 Comic.cover；
 * 老任务里存的是来源原始对象（只有 thumb）时，退回适配器的可选 coverUrl 能力。
 * @param {object} source 下载源适配器
 * @param {object} comic Comic 或来源原始对象
 * @returns {string}
 */
function coverUrlOfComic(source, comic) {
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
async function chapterImageUrls(source, comicId, order, signal) {
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
function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }

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

/**
 * 创建下载引擎。
 * options: { source, store, emit(event,payload), getConfig(), log, patchTask(taskId, patch, event, payload) }
 *   source 必填：下载源适配器（统一契约见 sources/types.mjs）。
 */
export function createEngine(options) {
  const o = options || {};
  const source = o.source;
  const log = o.log || { info: function () {}, warn: function () {}, error: function () {}, debug: function () {} };
  // 台账读写的问题（文件损坏/落盘失败）必须出现在同一个日志流里，否则只能靠猜
  setLedgerLogger(log);
  const emit = o.emit || function () {};
  const getConfig = o.getConfig || function () { return {}; };
  const tasks = new Map();
  const running = new Map(); // taskId -> { controller }
  const queue = [];
  let activeCount = 0;
  let disposed = false;
  let pumpScheduled = false;

  function pica() { return Object.assign({}, getConfig().picacomic || {}); }

  function paths() {
    const c = getConfig();
    const p = pica();
    return createPaths({
      root: function () { return c.downloadRoot || c.libraryRoot || '.'; },
      dirFmt: function () { return p.dirFmt || '{comic_title}/{order} {chapter_title}'; },
      format: function () { return p.downloadFormat || 'Jpeg'; }
    });
  }

  function configuredExt() {
    // Original：不转换、保留上游原扩展名（由魔数决定）
    if (String(pica().downloadFormat || '').toLowerCase() === 'original') return '';
    return extOfFormat(pica().downloadFormat || 'Jpeg');
  }

  /**
   * 全局下载限速（KB/s，0=不限）：按秒窗口记账，超了就让出时间。
   */
  const rateBucket = { windowStart: Date.now(), bytes: 0 };
  async function throttleGlobal(bytes) {
    const limitKb = num(pica().globalSpeedLimitKb, 0);
    if (!limitKb || limitKb <= 0 || !bytes) return;
    const limit = limitKb * 1024;
    const now = Date.now();
    if (now - rateBucket.windowStart > 1000) {
      rateBucket.windowStart = now;
      rateBucket.bytes = 0;
    }
    rateBucket.bytes += bytes;
    if (rateBucket.bytes > limit) {
      const wait = Math.min(3000, Math.round(((rateBucket.bytes - limit) / limit) * 1000));
      if (wait > 0) await sleep(wait);
      rateBucket.windowStart = Date.now();
      rateBucket.bytes = 0;
    }
  }

  // 每个任务一个图片限速器（同一任务内全局生效）
  const imgLimiters = new Map();
  function taskImgLimiter(task) {
    let l = imgLimiters.get(task.id);
    if (!l) {
      l = createLimiter(intervalMs('imgIntervalMs', 'imgDownloadIntervalSec'));
      imgLimiters.set(task.id, l);
    }
    return l;
  }

  function chapterLimiter() { return createLimiter(intervalMs('chapterIntervalMs', 'chapterDownloadIntervalSec')); }

  /**
   * 解析任务该用哪个下载源：任务记了 sourceId 就用它（可经 o.getSource 查出适配器），
   * 没记或该源已不可用时退回注入的默认源，并把原因写进任务日志（不打断下载）。
   */
  function sourceOf(task) {
    const id = task && task.sourceId ? String(task.sourceId) : '';
    if (!id || typeof o.getSource !== 'function') return source;
    try {
      return o.getSource(id) || source;
    } catch (err) {
      addLog(task, 'warn', '下载源 ' + id + ' 已不可用，改用默认源：' + (err && err.message ? err.message : err));
      return source;
    }
  }

  /** 章节/图片间隔：新配置用毫秒，老配置（picacomic-downloader）用秒，两个都认。 */
  function intervalMs(msKey, secKey) {
    const p = pica();
    if (p[msKey] !== undefined && p[msKey] !== null && p[msKey] !== '') return num(p[msKey], 0);
    if (p[secKey] !== undefined && p[secKey] !== null && p[secKey] !== '') return num(p[secKey], 0) * 1000;
    return 0;
  }

  function persist(task) {
    task.updatedAt = new Date().toISOString();
    if (o.store && typeof o.store.save === 'function') o.store.save(task);
  }

  function patch(task, changes, event, payload) {
    Object.assign(task, changes);
    task.updatedAt = new Date().toISOString();
    if (o.patchTask) o.patchTask(task.id, changes, event, payload);
    else if (o.store && typeof o.store.save === 'function') o.store.save(task);
  }

  function emitSafe(event, payload) {
    try { emit(event, payload); } catch (e) { /* 事件监听器异常不能影响下载 */ }
  }

  /** 任务公开视图（含聚合进度/速度/ETA）。 */
  function view(task) {
    const sections = (task.sections || []).map(function (s) {
      return { order: s.order, title: s.title, state: s.state, total: s.total, done: s.done, failed: s.failed, error: s.error || null };
    });
    const total = sections.reduce(function (a, s) { return a + (s.total || 0); }, 0);
    const done = sections.reduce(function (a, s) { return a + Math.min(s.done || 0, s.total || 0); }, 0);
    const failed = sections.reduce(function (a, s) { return a + (s.failed || 0); }, 0);
    const finishedChapters = sections.filter(function (s) { return s.state === 'done'; }).length;
    const totalChapters = sections.length;
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : (task.state === 'done' ? 100 : 0);
    const speed = task.speed || 0;
    const remain = Math.max(0, total - done);
    const etaMs = speed > 0 && remain > 0 ? Math.round((remain * avgBytes(task)) / speed) : null;
    return {
      id: task.id,
      comicId: task.comicId,
      title: task.title,
      author: task.author,
      cover: task.cover || '',
      state: task.state,
      dir: task.dir || '',
      chapters: sections,
      chapterCount: totalChapters,
      finishedChapters: finishedChapters,
      total: total,
      done: done,
      failed: failed,
      percent: percent,
      bytes: task.bytes || 0,
      speed: speed,
      etaMs: etaMs,
      // 由逐页台账命中、因而没有发 HTTP 请求的页数（断点续传的直接证据）
      ledgerHits: num(task.ledgerHits, 0),
      error: task.error || null,
      priority: num(task.priority, 0),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      logs: (task.logs || []).slice(-20)
    };
  }

  function avgBytes(task) {
    const done = (task.sections || []).reduce(function (a, s) { return a + (s.done || 0); }, 0);
    if (!done || !task.bytes) return 220 * 1024;
    return Math.max(30 * 1024, task.bytes / done);
  }

  function addLog(task, level, message) {
    if (!task.logs) task.logs = [];
    task.logs.push({ t: new Date().toISOString(), level: level || 'info', message: String(message) });
    if (task.logs.length > 200) task.logs.splice(0, task.logs.length - 200);
  }

  /* ---------------- 任务生命周期 ---------------- */

  function register(task) {
    const stored = Object.assign({}, task);
    stored.sections = (task.sections || []).map(function (s) { return Object.assign({}, s); });
    stored.logs = [];
    tasks.set(stored.id, stored);
    persist(stored);
    return stored;
  }

  function get(taskId) {
    const t = tasks.get(String(taskId));
    return t ? view(t) : null;
  }

  function list() {
    return Array.from(tasks.values()).map(view).sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  }

  function hydrate(saved) {
    const t = Object.assign({
      id: '', comicId: '', sourceId: '', title: '', author: '', cover: '',
      sections: [], state: 'paused', bytes: 0, speed: 0, logs: [], error: null, ledgerHits: 0
    }, saved || {});
    t.speed = 0;
    if (t.state === 'running' || t.state === 'queued') {
      t.state = 'paused';
      t.error = t.error || '服务重启导致中断，可点「继续」断点续传';
      addLog(t, 'warn', '服务重启，任务已暂停，可继续下载补全缺失图片');
    }
    t.sections = (t.sections || []).map(function (s) {
      return Object.assign({ order: 0, title: '', state: 'pending', total: 0, done: 0, failed: 0, error: null }, s);
    });
    for (const s of t.sections) {
      if (s.state === 'running') s.state = 'pending';
    }
    tasks.set(t.id, t);
    return t;
  }

  /** 入队：优先级大的先跑（同级按入队顺序）。 */
  function enqueue(task) {
    if (task.state === 'canceled') return;
    if (queue.indexOf(task.id) >= 0) return;
    task.state = 'queued';
    task.error = null;
    const prio = num(task.priority, 0);
    let idx = queue.length;
    for (let i = 0; i < queue.length; i++) {
      const other = tasks.get(queue[i]);
      if (num(other && other.priority, 0) < prio) { idx = i; break; }
    }
    queue.splice(idx, 0, task.id);
    persist(task);
    emitSafe('state', { taskId: task.id, state: task.state });
    schedulePump();
  }

  function schedulePump() {
    if (pumpScheduled || disposed) return;
    pumpScheduled = true;
    setTimeout(function () { pumpScheduled = false; pump().catch(function (e) { log.error('下载队列调度失败: ' + (e && e.message)); }); }, 10);
  }

  async function pump() {
    if (disposed) return;
    const max = Math.max(1, num(pica().maxConcurrentTasks, 2));
    while (activeCount < max && queue.length) {
      const id = queue.shift();
      const task = tasks.get(id);
      if (!task || task.state === 'canceled') continue;
      activeCount++;
      runTask(task).catch(function (err) {
        log.error('下载任务 ' + id + ' 异常: ' + (err && err.message));
        const t = tasks.get(id);
        if (t && t.state !== 'canceled') {
          t.state = 'error';
          t.error = '任务异常：' + (err && err.message ? err.message : String(err));
          emitSafe('error', { taskId: id, message: t.error });
          persist(t);
        }
      }).finally(function () {
        activeCount--;
        schedulePump();
      });
    }
  }

  /** 创建任务（不发车）。 */
  async function createTask(input) {
    const inp = input || {};
    const task = {
      id: inp.id || ('dl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)),
      comicId: str(inp.comicId),
      sourceId: str(inp.sourceId),
      title: str(inp.title),
      author: str(inp.author),
      cover: str(inp.cover),
      dir: '',
      state: 'queued',
      bytes: 0,
      speed: 0,
      error: null,
      ledgerHits: 0,
      priority: num(inp.priority, 0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      comic: inp.comic || null,
      sections: (inp.chapters || []).map(function (ch) {
        return {
          order: num(ch.order, 0),
          title: str(ch.chapterTitle || ch.title),
          chapterId: str(ch.chapterId || ch.id),
          state: 'pending',
          total: 0,
          done: 0,
          failed: 0,
          error: null
        };
      }),
      logs: []
    };
    const p = paths();
    task.dir = p.comicDir(task.title);
    addLog(task, 'info', '任务已创建，共 ' + task.sections.length + ' 个章节');
    return register(task);
  }

  /* ---------------- 执行一个任务 ---------------- */

  async function runTask(task) {
    if (task.state === 'canceled') return;
    const pc = pica();
    const pp = paths();
    const src = sourceOf(task);
    const controller = new AbortController();
    running.set(task.id, { controller: controller });
    const limiter = chapterLimiter();
    const speedo = createSpeedometer();
    const startedAt = Date.now();
    let lastEmit = 0;
    let doneCount = 0;
    let errorCount = 0;
    let bytes = 0;

    function progress(force, event) {
      task.speed = speedo.speed();
      task.bytes = bytes;
      const now = Date.now();
      if (force || now - lastEmit > 320) {
        lastEmit = now;
        persist(task);
        emitSafe(event || 'progress', { taskId: task.id, ...view(task) });
      }
    }

    patch(task, { state: 'running', error: null, speed: 0 }, 'state', { taskId: task.id, state: 'running' });
    emitSafe('progress', { taskId: task.id, ...view(task) });
    log.info('开始下载《' + task.title + '》共 ' + task.sections.length + ' 章');

    try {
      let comic = task.comic ? clone(task.comic) : null;
      // 统一 Comic 有 cover，来源原始对象有 thumb：两者都没有才需要重新拉详情
      if (!comic || (!comic.cover && !comic.thumb)) {
        try {
          comic = await src.comic(task.comicId, { signal: controller.signal });
          task.comic = comic;
        } catch (err) {
          if (controller.signal.aborted) throw err;
          // 详情拿不到不致命：老任务里可能已经带了标题信息
          addLog(task, 'warn', '获取漫画详情失败：' + err.message);
          log.warn('获取《' + task.title + '》详情失败：' + err.message);
        }
      }

      // 1) 先落盘元数据（结构与库一致），让 library 模块能立刻扫到
      const metaDir = pp.comicDir(task.title);
      const tempComicDir = pp.comicTempDir(task.title);

      /** 写元数据：pagesCount 用实际下载到的图片数（拿不准时按已知总数兜底）。 */
      async function writeComicMeta() {
        const filled = task.sections.map(function (s) {
          return { chapterId: s.chapterId, chapterTitle: s.title, order: s.order, total: s.total || 0 };
        });
        const comicMeta = buildComicMetadata(comic || { id: task.comicId, title: task.title, author: task.author }, filled, { format: 'reference' });
        const file = path.join(metaDir, MSG_COMIC_META);
        try {
          await fsp.mkdir(metaDir, { recursive: true });
          await atomicWriteJson(file, comicMeta);
        } catch (err) {
          // 正式目录写不进去时退回临时目录，任务照常继续；但原因必须留在任务日志里，不能静默吞掉
          addLog(task, 'warn', '正式目录写入元数据失败，已退回临时目录：' + (err && err.message ? err.message : err));
          // 临时目录只做一次兜底落盘，随即清理：它是漫画目录的「同级」目录（<漫画目录>.tmp-<pid>），
          // library 永远扫不到它，留着只会变成永久残渣 —— 实测把 <漫画目录>/元数据.json 造成目录、
          // 强制原子写的 rename 失败后，这个 .tmp- 目录会一直留在下载根下，没有任何代码路径会删它。
          // 兜底失败的原因已经写进任务日志，不需要靠目录留痕，所以写完就删。
          try {
            await fsp.mkdir(tempComicDir, { recursive: true });
            await atomicWriteJson(path.join(tempComicDir, MSG_COMIC_META), comicMeta);
          } finally {
            try { await rmWithRetry(tempComicDir, 5); } catch (e) { /* 清理失败不掩盖原错误 */ }
          }
        }
        return comicMeta;
      }
      await writeComicMeta();

      // 2) 封面（缺失才下，失败仅记日志）
      if (pc.shouldDownloadCover !== false) {
        const coverUrl = coverUrlOfComic(src, comic);
        if (coverUrl) {
          const coverFile = path.join(metaDir, 'cover.jpg');
          let need = true;
          try {
            const st = await fsp.stat(coverFile);
            need = !(st.isFile() && st.size > 0);
          } catch (e) { need = true; }
          if (need) {
            try {
              const dl = await src.download(coverUrl, { signal: controller.signal });
              if (!dl || !dl.buffer || !dl.buffer.length) throw new Error('封面内容为空');
              await fsp.mkdir(metaDir, { recursive: true });
              const tmp = coverFile + '.tmp-' + process.pid;
              try {
                await fsp.writeFile(tmp, dl.buffer);
                await fsp.rename(tmp, coverFile);
              } catch (err2) {
                // 半截封面必须清掉：rename 失败时它会永久留在漫画目录里（实测把 cover.jpg 造成目录
                // 强制 EPERM 后必现 1 个 .tmp- 残渣），而「漫画目录里不许有 .tmp- 残留」是测试和运维都在看的硬约束
                try { await rmWithRetry(tmp, 5); } catch (e2) { /* 清理失败不掩盖原错误 */ }
                throw err2;
              }
              bytes += dl.buffer.length;
              addLog(task, 'info', '封面已下载');
            } catch (err) {
              addLog(task, 'warn', '封面下载失败（不影响章节）：' + err.message);
              log.warn('《' + task.title + '》封面下载失败：' + err.message);
            }
          }
        }
      }

      // 3) 逐章节（章级并发 + 章间隔）
      const pending = task.sections.filter(function (s) { return s.state !== 'done'; });
      await runPool(pending, Math.max(1, num(pc.chapterConcurrency, 2)), async function (section) {
        if (task.state === 'canceled' || task.state === 'paused' || controller.signal.aborted) return;
        await limiter();
        if (task.state === 'canceled' || task.state === 'paused' || controller.signal.aborted) return;
        const result = await downloadChapter(task, section, { controller: controller, speedo: speedo, onBytes: function (n) { bytes += n; speedo.add(n); progress(false); } });
        if (result.ok) doneCount++;
        else if (result.canceled) return;
        else errorCount++;
        addLog(task, result.ok ? 'info' : 'error', '章节 ' + section.order + ' ' + (section.title || '') + (result.ok ? ' 完成' : ' 失败：' + section.error));
        try { await writeComicMeta(); } catch (e) { /* 元数据刷新失败不打断下载 */ }
        progress(true);
      });

      if (task.state === 'canceled' || controller.signal.aborted) {
        addLog(task, 'warn', '任务已取消');
        persist(task);
        emitSafe('state', { taskId: task.id, state: task.state });
        return;
      }

      // 4) 收尾
      // 先把最终元数据写完，再改任务状态：state 一旦对外是 done/error，磁盘就必须已经是最终状态。
      // 反过来（先 patch 状态再写元数据）时，轮询到 done 的调用方会读到还在写入中的 .tmp- 临时文件。
      try { await writeComicMeta(); } catch (e) {
        // 不改变任务结果（图与封面都已落盘），但必须留下痕迹：以前这里静默吞掉，
        // 于是「元数据没定稿却报 done」在事后完全无据可查，只能靠猜。
        addLog(task, 'warn', '最终元数据刷新失败（任务结果不受影响）：' + (e && e.message ? e.message : e));
      }
      const left = task.sections.filter(function (s) { return s.state !== 'done' && s.state !== 'skipped'; });
      if (left.length) {
        const detail = left.filter(function (s) { return s.error; }).slice(0, 2).map(function (s) { return '第 ' + s.order + ' 话：' + s.error; }).join('；');
        const message = '有 ' + left.length + ' 个章节未完成（' + left.slice(0, 4).map(function (s) { return s.order; }).join('、') + (left.length > 4 ? ' 等' : '') + '）'
          + (detail ? '，具体：' + detail : '')
          + '。已下载的图片都保留在磁盘，点「继续」只补缺的部分';
        patch(task, { state: 'error', error: message }, 'error', { taskId: task.id, message: message });
      } else {
        patch(task, { state: 'done', error: null }, 'state', { taskId: task.id, state: 'done' });
        addLog(task, 'info', '全部章节下载完成，用时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒');
        // 任务已完成：逐页台账不再有续传价值，删掉以免 data/ 无限膨胀（图片本身留在磁盘上）
        try { await removeLedger(task.id); } catch (e) { /* 台账清理失败不影响任务结果 */ }
      }
      progress(true, task.state === 'error' ? 'error' : 'done');
      emitSafe(task.state === 'error' ? 'error' : 'done', { taskId: task.id, ...view(task) });
      log.info('《' + task.title + '》下载结束：' + task.state + '（成功 ' + doneCount + ' / 失败 ' + errorCount + '）');
    } finally {
      task.speed = 0;
      running.delete(task.id);
      persist(task);
    }
  }

  /**
 * 台账命中后把文件「补进本次的临时目录」：
 * 进程重启后临时目录名带 pid（<章节目录>.tmp-<pid>），上次留下的文件路径与本次不同，
 * 但内容已被台账证明完整 —— 复制过来即可，绝不重新发请求。返回是否可用。
 */
async function restoreLedgerPage(rec, tmpDir, index, cfgExt, p) {
  const src = String(rec.file);
  const ext = String(path.extname(src) || '').replace(/^\./, '') || cfgExt || 'jpg';
  const dest = p.imageFile(tmpDir, index, ext);
  try {
    if (path.resolve(dest) !== path.resolve(src)) {
      await fsp.mkdir(tmpDir, { recursive: true });
      await fsp.copyFile(src, dest);
    }
  } catch (err) {
    return false;
  }
  try {
    const st = await fsp.stat(dest);
    return st.isFile() && st.size === num(rec.bytes, 0) && st.size > 0;
  } catch (err) {
    return false;
  }
}

/**
 * 记一页台账。台账写入失败绝不能把已经落盘的图片判成失败，
 * 所以这里全部吞掉异常，只往任务日志里写一条中文原因。
 */
async function recordLedgerPageSafe(task, section, item, dest, bytes2) {
  try {
    await recordLedgerPage(task.id, {
      comicId: task.comicId,
      chapterOrder: section.order,
      title: section.title,
      total: section.total,
      index: item.index,
      file: dest,
      bytes: bytes2,
      url: item.url
    });
  } catch (err) {
    addLog(task, 'warn', '逐页台账写入失败（不影响下载）：' + (err && err.message ? err.message : err));
  }
}

/** 下载单个章节：先补缺图，再原子替换目录并写章节元数据。 */
  async function downloadChapter(task, section, ctx2) {
    const c = ctx2 || {};
    const controller = c.controller;
    const signal = controller ? controller.signal : undefined;
    const p = paths();
    const src = sourceOf(task);   // 章节级也要认任务记录的 sourceId
    const ch = { chapterId: section.chapterId, chapterTitle: section.title, order: section.order };
    const finalDir = p.chapterDir(task.title, ch, { comicId: task.comicId, author: task.author });
    const tmpDir = p.chapterTempDir(task.title, ch, { comicId: task.comicId, author: task.author });

    section.state = 'running';
    section.error = null;
    if (!finalDir.startsWith(p.root())) {
      section.state = 'error';
      section.error = '目标路径越界，已拒绝写入';
      return { ok: false, canceled: false };
    }

    let urls;
    try {
      urls = await chapterImageUrls(src, task.comicId, section.order, signal);
    } catch (err) {
      if (signal && signal.aborted) { section.state = 'pending'; return { ok: false, canceled: true }; }
      section.state = 'error';
      section.error = '获取图片列表失败：' + err.message;
      return { ok: false, canceled: false };
    }
    if (!urls.length) {
      section.state = 'error';
      section.error = '该章节没有可下载的图片';
      return { ok: false, canceled: false };
    }
    section.total = urls.length;

    // 已完成的章节直接跳过（断点续传/重复下载都走这里）
    if (await isChapterComplete(finalDir)) {
      section.state = 'done';
      section.done = urls.length;
      section.failed = 0;
      return { ok: true, canceled: false };
    }

    if (typeof src.download !== 'function') {
      section.state = 'error';
      section.error = '该下载源不支持图片下载（缺少 download 能力）';
      return { ok: false, canceled: false };
    }

    try { await fsp.mkdir(tmpDir, { recursive: true }); } catch (e) { /* 可能已存在 */ }
    const cfgExt = configuredExt();

    // 小于 512B 的图片基本是坏图：删掉重下（避免「永远缺图」）
    for (const dir of [tmpDir, finalDir]) {
      const bad = await listSuspiciousImages(dir, cfgExt, { minSize: 512 });
      for (const n of bad) {
        try { await fsp.rm(path.join(dir, ('000' + String(n)).slice(-3)) + '.' + cfgExt, { force: true }); } catch (e) { /* ignore */ }
        addLog(task, 'warn', '图片 ' + n + ' 体积过小（疑似坏图），已删除重下');
      }
    }

    let done = 0;
    let failed = 0;
    let ledgerHits = 0;

    // 逐页台账：章开始时读一次，之后每页都先按台账判断，避免多余的目录扫描与 HTTP 请求。
    // 读失败/文件损坏都会被 ledger 内部兜成空台账，这里再兜一层，绝不让它打断下载。
    let ledgerDoc = null;
    try { ledgerDoc = await readLedger(task.id); } catch (e) { ledgerDoc = null; }

    await runPool(urls.map(function (u, i) { return { url: u, index: i + 1 }; }), Math.max(1, num(pica().imgConcurrency, 8)), async function (item) {
      if (task.state === 'canceled' || task.state === 'paused' || (signal && signal.aborted)) return;
      // 1) 台账优先：有该页记录、文件还在、字节数一致 → 直接跳过 HTTP（真正的断点续传）
      const rec = chapterPageRecord(ledgerDoc, section.order, item.index);
      if (rec) {
        if (await pageRecordUsable(rec)) {
          const restored = await restoreLedgerPage(rec, tmpDir, item.index, cfgExt, p);
          if (restored) {
            ledgerHits++;
            task.ledgerHits = num(task.ledgerHits, 0) + 1;
            done++;
            section.done = done;
            return;
          }
        } else {
          // 记录对不上磁盘（文件被删/被截断/字节数不符）：按未命中处理，重新下载
          addLog(task, 'warn', '图片 ' + item.index + ' 的台账记录与磁盘不符，重新下载');
        }
      }
      // 2) 台账没命中时退回老办法：临时目录与正式目录里已有该页就跳过（支持「只补缺图」）
      const hitTmp = await hasImage(tmpDir, item.index, cfgExt);
      const hitFinal = await hasImage(finalDir, item.index, cfgExt);
      if (hitTmp || hitFinal) {
        done++;
        section.done = done;
        return;
      }
      await taskImgLimiter(task)();
      if (task.state === 'canceled' || task.state === 'paused' || (signal && signal.aborted)) return;
      let attempt = 0;
      const maxTries = Math.max(1, num(pica().retryTimes, 3));
      while (true) {
        try {
          const dl = await src.download(item.url, { signal: signal });
          const buf = dl && dl.buffer;
          if (!buf || !buf.length) throw new Error('图片内容为空');
          // 上游声明了 Content-Length 就必须对得上：对不上按失败重试（半截文件绝不能进正式目录）
          const declared = declaredLengthOf(dl);
          if (declared > 0 && declared !== buf.length) {
            throw new Error('图片字节数与 Content-Length 不一致（声明 ' + declared + ' 字节，实收 ' + buf.length + ' 字节）');
          }
          const ext = extForImage(buf, cfgExt);
          const dest = p.imageFile(tmpDir, item.index, ext);
          const tmp = dest + '.part-' + process.pid;
          await fsp.writeFile(tmp, buf);
          await fsp.rename(tmp, dest);
          // 落盘成功才记账：台账只描述磁盘上真实存在、字节数确定的页
          await recordLedgerPageSafe(task, section, item, dest, buf.length);
          done++;
          section.done = done;
          if (c.onBytes) c.onBytes(buf.length);
          await throttleGlobal(buf.length);
          return;
        } catch (err) {
          if (signal && signal.aborted) return;
          if (task.state === 'canceled' || task.state === 'paused') return;
          attempt++;
          if (attempt >= maxTries) {
            failed++;
            section.failed = failed;
            addLog(task, 'warn', '图片 ' + item.index + ' 下载失败（已记入死信，继续下一张）：' + err.message);
            return;
          }
          await sleep(Math.min(8000, 500 * Math.pow(2, attempt - 1)));
        }
      }
    });

    section.done = done;
    section.failed = failed;
    if (ledgerHits > 0) {
      addLog(task, 'info', '章节 ' + section.order + '：逐页台账命中 ' + ledgerHits + ' 页，未重复发起请求');
    }

    if (task.state === 'canceled') {
      section.state = 'pending';
      return { ok: false, canceled: true };
    }

    // 有缺图：把已下好的图片「复制」到正式目录留底（临时目录里也保留一份），下次续传直接补缺
    if (done < urls.length) {
      section.state = 'error';
      section.error = '缺 ' + (urls.length - done) + ' 张图片（' + done + '/' + urls.length + '），可稍后继续补全';
      try {
        await fsp.mkdir(finalDir, { recursive: true });
        const existing = await listChapterImages(tmpDir);
        for (const f of existing) {
          if (f.size <= 0) continue;
          const dest = path.join(finalDir, f.name);
          try {
            const st = await fsp.stat(dest);
            if (st.size > 0) continue;
          } catch (e) { /* 目标不存在 */ }
          try { await fsp.copyFile(f.abs, dest); } catch (e) { /* 单个文件失败不影响整体 */ }
        }
      } catch (e) { /* ignore */ }
      return { ok: false, canceled: false };
    }

    // 全部到齐：把正式目录里已有的图片补进临时目录，再整体原子替换
    try {
      const inFinal = await listChapterImages(finalDir);
      for (const f of inFinal) {
        if (f.size <= 0) continue;
        const dest = path.join(tmpDir, f.name);
        let skip = false;
        try { skip = (await fsp.stat(dest)).size > 0; } catch (e) { skip = false; }
        if (skip) continue;
        try { await fsp.copyFile(f.abs, dest); } catch (e) { /* 单个文件失败不影响整体 */ }
      }
    } catch (e) { /* ignore */ }

    // 全部到齐：写章节元数据 + 原子替换目录
    try {
      await atomicWriteJson(path.join(tmpDir, '章节元数据.json'), buildChapterMetadata(ch));
      await swapDir(tmpDir, finalDir);
    } catch (err) {
      section.state = 'error';
      section.error = '写盘失败：' + err.message;
      return { ok: false, canceled: false };
    }
    section.state = 'done';
    return { ok: true, canceled: false };
  }


  /* ---------------- 对外操作 ---------------- */

  async function pause(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    if (t.state === 'done' || t.state === 'canceled') throw new Error('任务已结束，无法暂停');
    if (!running.has(t.id)) {
      t.state = 'paused';
      emitSafe('state', { taskId: t.id, state: t.state });
      persist(t);
      return view(t);
    }
    t.state = 'paused';
    addLog(t, 'info', '用户暂停任务（等在途请求结束）');
    emitSafe('state', { taskId: t.id, state: t.state });
    persist(t);
    return view(t);
  }

  async function resume(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    if (t.state === 'running') return view(t);
    for (const s of t.sections) {
      if (s.state === 'error' || s.state === 'running') s.state = 'pending';
    }
    t.error = null;
    t.bytes = t.bytes || 0;
    addLog(t, 'info', '用户继续任务（已存在的图片会跳过）');
    enqueue(t);
    return view(t);
  }

  async function cancel(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    t.state = 'canceled';
    t.speed = 0;
    for (const s of t.sections) {
      if (s.state === 'running' || s.state === 'pending') s.state = 'pending';
    }
    addLog(t, 'warn', '用户取消任务');
    const r = running.get(t.id);
    if (r && r.controller) r.controller.abort();
    const qi = queue.indexOf(t.id);
    if (qi >= 0) queue.splice(qi, 1);
    emitSafe('state', { taskId: t.id, state: t.state });
    persist(t);
    return view(t);
  }

  async function remove(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    if (running.has(t.id)) await cancel(t.id);
    const qi = queue.indexOf(t.id);
    if (qi >= 0) queue.splice(qi, 1);
    tasks.delete(t.id);
    if (o.store && typeof o.store.remove === 'function') o.store.remove(t.id);
    // 任务被删（DELETE /api/download/tasks/:id 与 clear-done 都走这里）：台账一并清掉
    try { await removeLedger(t.id); } catch (e) { /* 台账清理失败不影响删除结果 */ }
    emitSafe('state', { taskId: t.id, state: 'removed' });
    return true;
  }

  /** 任务里失败图片的明细（供「一键重试失败项」用）。 */
  function failures(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    return {
      taskId: t.id,
      title: t.title,
      chapters: (t.sections || []).filter(function (s) { return num(s.failed, 0) > 0 || s.state === 'error'; }).map(function (s) {
        return { order: s.order, title: s.title, state: s.state, failed: num(s.failed, 0), total: num(s.total, 0), done: num(s.done, 0), error: s.error || null };
      })
    };
  }

  /** 只重试失败项：清空失败计数并把任务推回队列（已存在的图片会跳过）。 */
  async function retryFailures(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    const failedChapters = (t.sections || []).filter(function (s) { return num(s.failed, 0) > 0 || s.state === 'error' || s.state === 'pending'; });
    if (!failedChapters.length) throw new Error('该任务没有失败项');
    for (const s of failedChapters) {
      s.failed = 0;
      s.error = null;
      if (s.state === 'error' || s.state === 'running') s.state = 'pending';
    }
    t.error = null;
    addLog(t, 'info', '重试失败项：' + failedChapters.length + ' 个章节');
    enqueue(t);
    return view(t);
  }

  /** 批量操作：pause / resume / cancel / remove / retry。 */
  async function bulk(action, ids) {
    const list = Array.isArray(ids) && ids.length ? ids : Array.from(tasks.keys());
    const done = [];
    const failed = [];
    for (const id of list) {
      try {
        if (action === 'pause') await pause(id);
        else if (action === 'resume') await resume(id);
        else if (action === 'cancel') await cancel(id);
        else if (action === 'remove') await remove(id);
        else if (action === 'retry') await retryFailures(id);
        else throw new Error('不支持的批量操作：' + action);
        done.push(id);
      } catch (err) {
        failed.push({ id: id, error: err && err.message ? err.message : String(err) });
      }
    }
    return { action: action, ok: done.length, failed: failed };
  }

  /** 清空已完成的任务记录（不动磁盘文件）。 */
  async function clearDone() {
    const ids = Array.from(tasks.values()).filter(function (t) { return t.state === 'done'; }).map(function (t) { return t.id; });
    for (const id of ids) { await remove(id); }
    return { removed: ids.length };
  }

  /** 设置优先级。 */
  function setPriority(taskId, priority) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    t.priority = num(priority, 0);
    persist(t);
    return view(t);
  }

  /** 当前正在执行的任务数。 */
  function runningCount() {
    return activeCount;
  }

  function status() {
    return {
      runningTasks: activeCount,
      queuedTasks: queue.length,
      totalTasks: tasks.size,
      maxConcurrentTasks: Math.max(1, num(pica().maxConcurrentTasks, 2))
    };
  }

  function hydrateAll(savedList) {
    for (const s of savedList || []) hydrate(s);
  }

  function dispose() {
    disposed = true;
    for (const r of running.values()) {
      if (r.controller) r.controller.abort();
    }
    running.clear();
    queue.length = 0;
  }

  return {
    createTask: createTask,
    enqueue: enqueue,
    get: get,
    list: list,
    view: view,
    hydrateAll: hydrateAll,
    hydrate: hydrate,
    pause: pause,
    resume: resume,
    cancel: cancel,
    remove: remove,
    status: status,
    failures: failures,
    retryFailures: retryFailures,
    bulk: bulk,
    clearDone: clearDone,
    setPriority: setPriority,
    runningCount: runningCount,
    paths: paths,
    buildComicMetadata: buildComicMetadata,
    dispose: dispose,
    rawTasks: function () { return tasks; }
  };
}
