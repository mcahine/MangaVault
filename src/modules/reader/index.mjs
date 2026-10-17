
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createLogger } from '../../core/log.mjs';
import { JsonStore } from '../../core/store.mjs';
import { readJson, safeJoin } from '../../core/util.mjs';
import { readImageSizes } from '../../core/image-size.mjs';
import { readLibraryIndex } from '../../core/library-index.mjs';
import { saveProgress } from '../../core/reading-progress.mjs';
import { roots, rootById } from '../../core/roots.mjs';

/** 多库根（兼容旧配置的单 libraryRoot） */
function rootsWithFallback() {
  const list = roots(cfg);
  if (list.length) return list;
  return cfg.libraryRoot ? [{ id: 'root', name: '漫画库', path: cfg.libraryRoot }] : [];
}

export const meta = {
  id: 'reader',
  name: '阅读器',
  description: '章节数据、阅读偏好与进度记忆',
  order: 20,
  help: ['GET /api/reader/chapter?comic=&order=', 'GET /api/reader/sizes?comic=&order=', 'GET /api/reader/prefs', 'POST /api/reader/prefs']
};

const DEFAULTS = {
  mode: 'single',        // single | spread | webtoon
  fit: 'height',         // height | width | original
  rtl: true,             // 日漫默认从右往左翻页
  gap: 0,
  bg: 'auto',            // auto | black | white | gray
  preload: 3,
  autoHideBar: true,
  // 翻页条锁定：true = 常显不淡出；false = 鼠标不动一会儿就淡出（默认）
  barLock: false
};

const prefs = new JsonStore('reader-prefs.json', Object.assign({}, DEFAULTS));
let cfg = null;
let log = null;

export async function register(app, ctx) {
  cfg = ctx.config;
  log = createLogger('reader', cfg.logLevel);
  await prefs.load();
  // 索引由 library 模块写盘，这里每次请求都读最新版（带 mtime 缓存），不要缓存成内存快照
  const findComic = async function (id) {
    const idx = await readLibraryIndex();
    return (idx.comics || []).find(function (c) { return c.id === id; }) || null;
  };

  app.get('/api/reader/prefs', function (c) {
    c.json({ ok: true, prefs: Object.assign({}, DEFAULTS, prefs.data || {}) });
  });

  app.post('/api/reader/prefs', async function (c) {
    const body = c.body || {};
    const next = Object.assign({}, DEFAULTS, prefs.data || {});
    for (const k of Object.keys(DEFAULTS)) {
      if (body[k] !== undefined) next[k] = body[k];
    }
    next.preload = Math.max(0, Math.min(10, Number(next.preload) || 0));
    prefs.data = next;
    prefs.markDirty();
    await prefs.flush();
    c.json({ ok: true, prefs: next });
  });

  /** 一次拿齐阅读器需要的一切：章节图片、上下章、库内全景（章节列表） */
  app.get('/api/reader/chapter', async function (c) {
    const comicId = c.query('comic', '');
    const comic = await findComic(comicId);
    if (!comic) c.throwError(404, '漫画不存在：' + comicId);
    const order = c.queryInt('order', comic.chapters.length ? comic.chapters[0].order : 1);
    const idx = comic.chapters.findIndex(function (x) { return Number(x.order) === Number(order); });
    if (idx < 0) c.throwError(404, '章节不存在：' + order);
    const ch = comic.chapters[idx];
    const prev = idx > 0 ? comic.chapters[idx - 1] : null;
    const next = idx < comic.chapters.length - 1 ? comic.chapters[idx + 1] : null;
    const base = '/api/library/image?comic=' + encodeURIComponent(comic.id) + '&order=' + ch.order + '&file=';
    c.json({
      ok: true,
      comic: {
        id: comic.id, title: comic.title, author: comic.author, dir: comic.dir,
        cover: comic.cover || comic.coverRemote ? '/api/library/cover/' + encodeURIComponent(comic.id) : null,
        chapterCount: comic.chapterCount, images: comic.images, tags: comic.tags
      },
      chapter: { order: ch.order, title: ch.title, count: ch.count, dir: ch.dir },
      pages: ch.images.map(function (name, i) {
        return { index: i, name: name, url: base + encodeURIComponent(name) };
      }),
      chapters: comic.chapters.map(function (x) { return { order: x.order, title: x.title, count: x.count }; }),
      prev: prev ? { order: prev.order, title: prev.title } : null,
      next: next ? { order: next.order, title: next.title } : null,
      index: idx,
      total: comic.chapters.length
    });
  });

  /** 阅读进度写回（与 library 模块共用 library-progress.json，保证「继续阅读」一致） */
  app.post('/api/reader/progress', async function (c) {
    const b = c.body || {};
    const comic = await findComic(String(b.comicId || ''));
    if (!comic) c.throwError(404, '漫画不存在');
    const chapter = Number(b.chapter || 1);
    const index = Math.max(0, Number(b.index || 0));
    const ch = comic.chapters.find(function (x) { return Number(x.order) === chapter; });
    // 与 library 模块共用同一份进度存储，避免两份内存快照互相覆盖
    const saved = await saveProgress({
      comicId: comic.id, title: comic.title, chapter: chapter,
      chapterTitle: ch ? ch.title : '', index: index, totalImages: comic.images
    });
    c.json({ ok: true, progress: saved });
  });

  /** 阅读器需要的相邻章节预取（前端翻页时少一次往返） */
  app.get('/api/reader/neighbors', async function (c) {
    const comic = await findComic(c.query('comic', ''));
    if (!comic) c.throwError(404, '漫画不存在');
    const order = c.queryInt('order', 0);
    const idx = comic.chapters.findIndex(function (x) { return Number(x.order) === Number(order); });
    const at = function (i) {
      if (i < 0 || i >= comic.chapters.length) return null;
      const ch = comic.chapters[i];
      return { order: ch.order, title: ch.title, count: ch.count, dir: ch.dir };
    };
    c.json({ ok: true, current: at(idx), prev: at(idx - 1), next: at(idx + 1), index: idx, total: comic.chapters.length });
  });

  /* ---------- 图片尺寸（阅读器预加载优化的地基） ----------
     为什么需要：条漫模式下如果 <img> 不写宽高，浏览器要等图片下载并解码完才知道尺寸，
     每加载一张就把后面所有内容重新挤一遍 —— 表现就是「边滚边跳、滚到哪卡到哪」。
     这里只读文件头部（64KB 以内）拿宽高，前端据此给占位元素写 aspect-ratio，
     让布局在解码前就确定。结果按「漫画+章节」缓存在内存里（图片本身不会变）。 */
  const sizeCache = new Map();
  const SIZE_CACHE_MAX = 32;

  /** 某个漫画所属库根的绝对路径（与 library 模块同口径，索引缺 root 时逐个根探测） */
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

  app.get('/api/reader/sizes', async function (c) {
    const comic = await findComic(c.query('comic', ''));
    if (!comic) c.throwError(404, '漫画不存在：' + c.query('comic', ''));
    // order 缺省时与 /api/reader/chapter 同一口径（取第一话）。前端为了让章节数据与尺寸并行
    // 请求，首次加载时确实不带 order；这里必须兜底，否则会平白多两个 404（曾发生过）。
    const order = c.queryInt('order', comic.chapters.length ? comic.chapters[0].order : 1);
    const ch = comic.chapters.find(function (x) { return Number(x.order) === Number(order); });
    if (!ch) c.throwError(404, '章节不存在：' + order);
    const key = comic.id + ':' + ch.order + ':' + ch.images.length;
    let sizes = sizeCache.get(key);
    if (!sizes) {
      const base = await basePathOf(comic);
      const dir = ch.dir === '.' ? comic.dir : path.join(comic.dir, ch.dir);
      const files = ch.images.map(function (name) {
        return { name: name, abs: safeJoin(base, path.join(dir, name)) };
      });
      sizes = await readImageSizes(files, { concurrency: 16 });
      // 读不到的位保持 null（前端用默认比例兜底），不要过滤，否则对不齐页码
      if (sizeCache.size >= SIZE_CACHE_MAX) sizeCache.delete(sizeCache.keys().next().value);
      sizeCache.set(key, sizes);
    }
    c.json({ ok: true, count: ch.images.length, sizes: sizes });
  });

  app.get('/api/reader/health', async function (c) {
    const idx = await readLibraryIndex();
    const comics = idx.comics || [];
    const rootList = rootsWithFallback();
    const broken = [];
    let checked = 0;
    for (const comic of comics) {
      const base = (comic.root && rootList.find(function (r) { return r.id === comic.root; })) || rootList.find(function (r) { return r.path === idx.root; }) || rootList[0];
      if (!base) continue;
      for (const ch of comic.chapters) {
        if (!ch.count || ch.dir === '.') continue;   // 单章结构没有章节目录，跳过
        checked++;
        const dir = path.join(base.path, comic.dir, ch.dir);
        const cm = await readJson(path.join(dir, '章节元数据.json'), null);
        if (!cm) broken.push(comic.dir + ' / ' + ch.dir);
      }
    }
    c.json({
      ok: true,
      roots: rootList.map(function (r) { return { id: r.id, name: r.name, path: r.path }; }),
      comics: comics.length,
      chaptersChecked: checked,
      chaptersMissingMeta: broken.slice(0, 50),
      chaptersMissingMetaCount: broken.length,
      prefs: prefs.data
    });
  });
}

export async function dispose() {
  try { await prefs.flush(); } catch (e) {}
}
