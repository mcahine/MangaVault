import path from 'node:path';
import fsp from 'node:fs/promises';
import { createLogger } from '../../core/log.mjs';
import { JsonStore } from '../../core/store.mjs';
import { safeJoin, formatBytes, IMAGE_EXT, naturalCompare } from '../../core/util.mjs';
import { scanRoots } from './scanner.mjs';
import { roots, activeRoots, rootById, ownerRootOf, labelOf, probeRoots, upsertRoot, removeRoot } from '../../core/roots.mjs';
import { readProgress, saveProgress, continueList } from '../../core/reading-progress.mjs';
import { openSSE } from '../../core/http.mjs';
import { withHeartbeat } from '../../core/heartbeat.mjs';

export const meta = {
  id: 'library',
  name: '漫画库',
  description: '多库根索引、搜索、封面与图片服务、库根管理',
  order: 10,
  help: [
    'GET /api/library/state',
    'POST /api/library/scan {root?}',
    'GET /api/library/comics?q&sort&tag&root&fav&page&size',
    'GET /api/library/comic/:id',
    'GET /api/library/roots · POST /api/library/roots · DELETE /api/library/roots?id=',
    'POST /api/library/refresh-single {comicId}'
  ]
};

let cfg = null;
let log = null;
const store = new JsonStore('library-index.json', { version: 2, scannedAt: null, roots: [], byRoot: {}, stats: null, facets: null, comics: [] });
const marksStore = new JsonStore('library-marks.json', { favorites: [], tags: {} });

let scanning = false;
let lastProgress = null;
const sseClients = new Set();

function broadcast(event, data) {
  for (const c of sseClients) {
    if (!c.send(event, data)) sseClients.delete(c);
  }
}

function comics() { return store.data.comics || []; }

function findComic(id) { return comics().find(function (c) { return c.id === id; }) || null; }

/** 某个漫画所属库根的绝对路径；老索引没有 root 字段时在所有根里探测 */
async function basePathOf(comic) {
  const direct = comic && comic.root ? rootById(cfg, comic.root) : null;
  if (direct) return direct.path;
  const list = roots(cfg);
  for (const r of list) {
    try {
      const st = await fsp.stat(path.join(r.path, comic.dir));
      if (st.isDirectory()) return r.path;
    } catch (e) { /* 换下一个根 */ }
  }
  return list.length ? list[0].path : (cfg.libraryRoot || '');
}

/** 该漫画是否能提供一张封面图（本地 > 远程 > 首章首图回落） */
function hasCover(c) {
  if (c.cover || c.coverRemote) return true;
  return Array.isArray(c.chapters) && c.chapters.some(function (x) { return x && x.count > 0; });
}

/** 轻量字段（列表用），避免把 6 万张图片名发给前端 */
function light(c) {
  return {
    id: c.id, dir: c.dir, title: c.title, author: c.author, tags: c.tags.slice(0, 6),
    pagesCount: c.pagesCount, chapterCount: c.chapterCount, images: c.images, bytes: c.bytes,
    // cover 表示“前端能不能拿到一张封面图”。
    // 除了本地 cover.jpg 与远程 thumb，还必须把“有正文图可回落”算进来 ——
    // /api/library/cover/:id 本就会回落到首章首图，但这里若报 false，前端连请求都不会发，
    // 裸形态库（如「先期漫画」53 部，无 cover.jpg）就会整库显示占位块。
    likes: c.likes, views: c.views, cover: hasCover(c), hasMeta: c.hasMeta,
    createdAt: c.createdAt, updatedAt: c.updatedAt, dirMtime: c.dirMtime,
    description: (c.description || '').slice(0, 140), chineseTeam: c.chineseTeam,
    root: c.root || null, rootName: c.rootName || null
  };
}

function classifySort(list, sort) {
  const arr = list.slice();
  const num = function (v) { return Number(v) || 0; };
  switch (sort) {
    case 'size': arr.sort(function (a, b) { return num(b.bytes) - num(a.bytes); }); break;
    case 'pages': arr.sort(function (a, b) { return num(b.images) - num(a.images); }); break;
    case 'likes': arr.sort(function (a, b) { return num(b.likes) - num(a.likes); }); break;
    case 'views': arr.sort(function (a, b) { return num(b.views) - num(a.views); }); break;
    case 'recent': arr.sort(function (a, b) { return num(b.dirMtime || b.updatedAt) - num(a.dirMtime || a.updatedAt); }); break;
    case 'author': arr.sort(function (a, b) { return String(a.author || '').localeCompare(String(b.author || ''), 'zh-Hans-CN'); }); break;
    case 'chapters': arr.sort(function (a, b) { return num(b.chapterCount) - num(a.chapterCount); }); break;
    case 'random': arr.sort(function () { return Math.random() - 0.5; }); break;
    default: arr.sort(function (a, b) { return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN', { numeric: true }); });
  }
  return arr;
}

function search(list, q) {
  const kw = String(q || '').trim().toLowerCase();
  if (!kw) return list;
  const terms = kw.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const c of list) {
    const title = String(c.title).toLowerCase();
    const author = String(c.author || '').toLowerCase();
    const team = String(c.chineseTeam || '').toLowerCase();
    const desc = String(c.description || '').toLowerCase();
    const tags = c.tags.concat(c.categories || []).join(' ').toLowerCase();
    const dir = String(c.dir).toLowerCase();
    let score = 0;
    let allMatch = true;
    for (const t of terms) {
      if (t.startsWith('-') && t.length > 1) {           // 排除词：-xxx
        const neg = t.slice(1);
        if (title.includes(neg) || author.includes(neg) || tags.includes(neg)) { allMatch = false; break; }
        continue;
      }
      let s = 0;
      if (title === t) s += 100;
      else if (title.includes(t)) s += 40;
      if (author.includes(t)) s += 24;
      if (tags.includes(t)) s += 14;
      if (team.includes(t)) s += 8;
      if (dir.includes(t)) s += 6;
      if (desc.includes(t)) s += 5;
      if (s === 0) allMatch = false;
      score += s;
    }
    if (!allMatch) continue;
    scored.push({ c: c, score: score });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.map(function (x) { return x.c; });
}


export async function register(app, ctx) {
  cfg = ctx.config;
  log = createLogger('library', cfg.logLevel);
  await store.load();
  await marksStore.load();
  log.info('库索引载入：' + comics().length + ' 部漫画 / ' + roots(cfg).length + ' 个库根，扫描时间 ' + (store.data.scannedAt || '未扫描'));

  /* ---------- 状态 / 库根 ---------- */
  app.get('/api/library/state', async function (c) {
    c.json({
      ok: true,
      scanning: scanning,
      progress: lastProgress,
      roots: await probeRoots(cfg),
      scannedAt: store.data.scannedAt,
      stats: store.data.stats || { comics: 0, chapters: 0, images: 0, bytes: 0, withMeta: 0, empty: 0 },
      byRoot: store.data.byRoot || {},
      bytesText: formatBytes(((store.data.stats || {}).bytes) || 0)
    });
  });

  app.get('/api/library/roots', async function (c) {
    c.json({ ok: true, roots: await probeRoots(cfg) });
  });

  app.post('/api/library/roots', async function (c) {
    const b = c.body || {};
    if (!b.path) c.throwError(400, '缺少 path 参数');
    const abs = path.resolve(String(b.path));
    try {
      const st = await fsp.stat(abs);
      if (!st.isDirectory()) c.throwError(400, '不是一个目录：' + abs);
    } catch (err) {
      c.throwError(400, '目录不存在或不可读：' + abs);
    }
    const next = upsertRoot(cfg, { id: b.id, name: b.name || path.basename(abs), path: abs, enabled: b.enabled !== false });
    await ctx.saveConfig({ libraryRoots: next });
    cfg = await ctx.reloadConfig();
    const probe = await probeRoots(cfg);
    c.json({ ok: true, roots: probe, message: '已添加库根：' + (b.name || path.basename(abs)) });
  });

  app.del('/api/library/roots', async function (c) {
    const id = c.query('id', '');
    if (!id) c.throwError(400, '缺少 id 参数');
    const next = removeRoot(cfg, id);
    if (next.length === roots(cfg).length) c.throwError(404, '没有这个库根：' + id);
    await ctx.saveConfig({ libraryRoots: next });
    cfg = await ctx.reloadConfig();
    c.json({ ok: true, roots: await probeRoots(cfg), message: '已移除库根（磁盘文件未删除）' });
  });

  /* ---------- 扫描 ---------- */
  app.get('/api/library/scan/events', function (c) {
    const s = openSSE(c);
    sseClients.add(s);
    s.onClose(function () { sseClients.delete(s); });
    s.send('state', { scanning: scanning, scannedAt: store.data.scannedAt, progress: lastProgress });
  });

  app.post('/api/library/scan', async function (c) {
    if (scanning) c.throwError(409, '已在扫描中，请稍候');
    const body = c.body || {};
    let list = activeRoots(cfg);
    if (body.root) {
      const one = rootById(cfg, String(body.root)) || roots(cfg).find(function (r) { return r.path === path.resolve(String(body.root)); });
      if (!one) c.throwError(404, '没有这个库根：' + body.root);
      list = [one];
    }
    if (!list.length) c.throwError(400, '没有任何启用的库根，请先在设置里添加漫画目录');

    scanning = true;
    const started = Date.now();
    broadcast('progress', { phase: 'start', current: 0, total: 1, message: '开始扫描 ' + list.length + ' 个库根…' });
    (async function () {
      try {
        // 全库扫描期间事件循环会被占满，/api/ping 可能连续超时。
        // 不声明「我在忙」的话，桌面宿主看护会把它当成「后端已死」直接关窗口。
        const result = await withHeartbeat(function () {
          return scanRoots(list, function (p) {
            lastProgress = p;
            broadcast('progress', p);
          });
        }, { label: '漫画库扫描', log: log });
        result.stats.scanMs = Date.now() - started;
        store.data = result;
        store.markDirty();
        await store.flush();
        const done = { stats: result.stats, scannedAt: result.scannedAt, byRoot: result.byRoot, bytesText: formatBytes(result.stats.bytes) };
        lastProgress = { phase: 'done', current: 1, total: 1, message: '扫描完成' };
        broadcast('done', done);
        log.info('扫描完成：' + result.stats.comics + ' 部 / ' + result.stats.images + ' 张 / ' + formatBytes(result.stats.bytes) + '，耗时 ' + (Date.now() - started) + 'ms');
      } catch (err) {
        broadcast('error', { message: String(err && err.message || err) });
        log.error('扫描失败：', err);
      } finally {
        scanning = false;
      }
    })();
    c.json({ ok: true, scanning: true, roots: list.map(function (r) { return r.name; }) });
  });

  /** 单本重扫：vault 改完元数据 / 下载完一章后调用，避免整库重扫 */
  app.post('/api/library/refresh-single', async function (c) {
    const b = c.body || {};
    const comic = findComic(String(b.comicId || ''));
    if (!comic) c.throwError(404, '漫画不存在：' + b.comicId);
    const base = await basePathOf(comic);
    const { scanComic } = await import('./scanner.mjs');
    const rootMeta = rootById(cfg, comic.root) || { id: comic.root, name: comic.rootName };
    const fresh = await scanComic(base, comic.dir, rootMeta);
    if (!fresh) c.throwError(500, '重扫失败：读不到目录 ' + path.join(base, comic.dir));
    const list = comics();
    const idx = list.findIndex(function (x) { return x.id === comic.id; });
    if (idx >= 0) list[idx] = fresh; else list.push(fresh);
    store.data.stats = recomputeStats(list);
    store.data.byRoot = recomputeByRoot(list);
    store.markDirty();
    await store.flush();
    c.json({ ok: true, comic: light(fresh), message: '已刷新：' + fresh.title });
  });

  function recomputeStats(list) {
    return {
      comics: list.length,
      chapters: list.reduce(function (n, c) { return n + c.chapterCount; }, 0),
      images: list.reduce(function (n, c) { return n + c.images; }, 0),
      bytes: list.reduce(function (n, c) { return n + c.bytes; }, 0),
      withMeta: list.filter(function (c) { return c.hasMeta; }).length,
      empty: list.filter(function (c) { return c.images === 0; }).length,
      scanMs: (store.data.stats && store.data.stats.scanMs) || 0
    };
  }

  function recomputeByRoot(list) {
    const out = {};
    for (const c of list) {
      const k = c.root || 'root';
      out[k] = out[k] || { id: k, name: c.rootName || k, comics: 0, chapters: 0, images: 0, bytes: 0 };
      out[k].comics++; out[k].chapters += c.chapterCount; out[k].images += c.images; out[k].bytes += c.bytes;
    }
    return out;
  }

  /* ---------- 列表 / 详情 ---------- */
  app.get('/api/library/comics', async function (c) {
    const q = c.query('q', '');
    const sort = c.query('sort', 'title');
    const tag = c.query('tag', '');
    const author = c.query('author', '');
    const rootFilter = c.query('root', '');
    const favoriteOnly = c.query('fav', '') === '1';
    const withMeta = c.query('hasMeta', '');
    const minImages = c.queryInt('minImages', 0);
    const page = Math.max(1, c.queryInt('page', 1));
    const size = Math.min(300, Math.max(1, c.queryInt('size', 60)));

    let list = comics();
    if (rootFilter) list = list.filter(function (x) { return (x.root || '') === rootFilter; });
    if (withMeta === '1') list = list.filter(function (x) { return x.hasMeta; });
    if (withMeta === '0') list = list.filter(function (x) { return !x.hasMeta; });
    if (minImages > 0) list = list.filter(function (x) { return x.images >= minImages; });
    if (favoriteOnly) {
      const favs = new Set((marksStore.data.favorites || []));
      list = list.filter(function (x) { return favs.has(x.id); });
    }
    if (tag) list = list.filter(function (x) { return x.tags.includes(tag) || (x.categories || []).includes(tag); });
    if (author) list = list.filter(function (x) { return x.author === author; });
    if (q) list = search(list, q);
    else list = classifySort(list, sort);

    const total = list.length;
    const slice = list.slice((page - 1) * size, page * size);
    const favs = new Set((marksStore.data.favorites || []));
    const progress = await readProgress();
    c.json({
      ok: true, total: total, page: page, size: size,
      pages: Math.max(1, Math.ceil(total / size)),
      items: slice.map(function (x) {
        const o = light(x);
        o.favorite = favs.has(x.id);
        const p = progress[x.id];
        o.progress = p ? {
          chapter: p.chapter, index: p.index, chapterTitle: p.chapterTitle,
          percent: x.images ? Math.min(100, Math.round(((p.chapterRead || 0) / Math.max(1, x.images)) * 100)) : 0,
          updatedAt: p.updatedAt
        } : null;
        return o;
      })
    });
  });

  app.get('/api/library/facets', function (c) {
    c.json({ ok: true, facets: store.data.facets || { tags: [], authors: [], categories: [] }, byRoot: store.data.byRoot || {}, stats: store.data.stats || null });
  });

  app.get('/api/library/stats', function (c) {
    const list = comics();
    const recent = list.slice().sort(function (a, b) { return Number(b.dirMtime || 0) - Number(a.dirMtime || 0); }).slice(0, 12).map(light);
    const biggest = list.slice().sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 8).map(light);
    const noMeta = list.filter(function (x) { return !x.hasMeta; });
    const empty = list.filter(function (x) { return x.images === 0; });
    c.json({
      ok: true,
      stats: store.data.stats || null,
      scannedAt: store.data.scannedAt,
      roots: roots(cfg).map(function (r) { return { id: r.id, name: r.name, path: r.path, enabled: r.enabled }; }),
      byRoot: store.data.byRoot || {},
      recent: recent, biggest: biggest,
      facets: store.data.facets || null,
      issues: { noMeta: noMeta.length, empty: empty.length, noMetaList: noMeta.slice(0, 30).map(light), emptyList: empty.slice(0, 30).map(light) }
    });
  });

  app.get('/api/library/comic/:id', async function (c) {
    const comic = findComic(c.params.id);
    if (!comic) c.throwError(404, '漫画不存在：' + c.params.id);
    const p = (await readProgress())[comic.id] || null;
    const favs = new Set(marksStore.data.favorites || []);
    c.json({
      ok: true,
      comic: Object.assign({}, light(comic), {
        description: comic.description,
        categories: comic.categories || [],
        thumb: comic.cover ? null : comic.coverRemote,
        creator: comic.creator,
        favorite: favs.has(comic.id),
        progress: p,
        rootPath: await basePathOf(comic),
        chapters: comic.chapters.map(function (ch) {
          return { order: ch.order, title: ch.title, count: ch.count, bytes: ch.bytes, bytesText: formatBytes(ch.bytes), chapterId: ch.chapterId };
        })
      })
    });
  });

  /* ---------- 封面 / 图片 ---------- */
  app.get('/api/library/cover/:id', async function (c) {
    const comic = findComic(c.params.id);
    if (!comic) c.throwError(404, '漫画不存在');
    const base = await basePathOf(comic);
    let rel = null;
    if (comic.cover) rel = path.join(comic.dir, comic.cover);
    else {
      const ch = comic.chapters.find(function (x) { return x.count > 0; });
      if (ch) rel = path.join(comic.dir, ch.dir === '.' ? '' : ch.dir, ch.images[0]);
    }
    if (!rel) c.throwError(404, '该漫画没有封面');
    await c.file(safeJoin(base, rel), { cacheSeconds: 600 });
  });

  app.get('/api/library/image', async function (c) {
    const comicId = c.query('comic', '');
    const order = c.queryInt('order', 0);
    const file = c.query('file', '');
    const comic = findComic(comicId);
    if (!comic) c.throwError(404, '漫画不存在');
    if (!file || !IMAGE_EXT.has(path.extname(file).toLowerCase())) c.throwError(400, '文件名不合法');
    const ch = comic.chapters.find(function (x) { return Number(x.order) === Number(order); });
    if (!ch) c.throwError(404, '章节不存在：' + order);
    if (!ch.images.includes(file)) c.throwError(404, '该章节内没有这张图：' + file);
    const base = await basePathOf(comic);
    await c.file(safeJoin(base, path.join(comic.dir, ch.dir === '.' ? '' : ch.dir, file)), { cacheSeconds: 86400 });
  });

  /* ---------- 收藏 / 进度 ---------- */
  app.get('/api/library/marks', function (c) {
    c.json({ ok: true, favorites: marksStore.data.favorites || [], tags: marksStore.data.tags || {} });
  });

  app.post('/api/library/marks', async function (c) {
    const body = c.body || {};
    const id = String(body.id || '');
    if (!findComic(id)) c.throwError(404, '漫画不存在');
    const favs = new Set(marksStore.data.favorites || []);
    if (body.favorite === undefined) c.throwError(400, '缺少 favorite 参数');
    if (body.favorite) favs.add(id); else favs.delete(id);
    marksStore.data.favorites = Array.from(favs);
    if (body.tags && Array.isArray(body.tags)) {
      marksStore.data.tags = marksStore.data.tags || {};
      marksStore.data.tags[id] = body.tags.map(String);
    }
    marksStore.markDirty();
    await marksStore.flush();
    c.json({ ok: true, favorite: favs.has(id), total: favs.size });
  });

  app.get('/api/library/progress', async function (c) {
    c.json({ ok: true, progress: await readProgress() });
  });

  app.post('/api/library/progress', async function (c) {
    const b = c.body || {};
    const id = String(b.comicId || b.id || '');
    const comic = findComic(id);
    if (!comic) c.throwError(404, '漫画不存在');
    const chapter = Number(b.chapter || 1);
    const index = Math.max(0, Number(b.index || 0));
    const ch = comic.chapters.find(function (x) { return Number(x.order) === chapter; });
    const saved = await saveProgress({
      comicId: id, title: comic.title, chapter: chapter,
      chapterTitle: ch ? ch.title : '', index: index, totalImages: comic.images
    });
    c.json({ ok: true, progress: saved });
  });

  app.get('/api/library/continue', async function (c) {
    const list = (await continueList(12))
      .map(function (p) {
        const comic = findComic(p.comicId);
        if (!comic) return null;
        return { progress: p, comic: light(comic) };
      })
      .filter(Boolean);
    c.json({ ok: true, items: list });
  });

  app.get('/api/library/random', function (c) {
    let list = comics().filter(function (x) { return x.images > 0; });
    const rootFilter = c.query('root', '');
    if (rootFilter) list = list.filter(function (x) { return (x.root || '') === rootFilter; });
    if (!list.length) c.throwError(404, '漫画库为空');
    c.json({ ok: true, comic: light(list[Math.floor(Math.random() * list.length)]) });
  });

  app.get('/api/library/health', async function (c) {
    const list = comics();
    const dupTitles = (function () {
      const seen = new Map(); const dup = [];
      for (const x of list) {
        const k = String(x.title).trim();
        if (seen.has(k)) dup.push(k); else seen.set(k, 1);
      }
      return dup.slice(0, 50);
    })();
    c.json({
      ok: true,
      roots: await probeRoots(cfg),
      indexed: list.length,
      byRoot: store.data.byRoot || {},
      noMeta: list.filter(function (x) { return !x.hasMeta; }).map(function (x) { return x.rootName + ' / ' + x.dir; }).slice(0, 50),
      empty: list.filter(function (x) { return x.images === 0; }).map(function (x) { return x.rootName + ' / ' + x.dir; }).slice(0, 50),
      duplicatedTitles: dupTitles
    });
  });
}

export async function dispose() {
  try { store.markDirty(); await store.flush(); await marksStore.flush(); } catch (e) {}
}
