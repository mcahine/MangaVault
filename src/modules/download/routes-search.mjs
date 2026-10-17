/**
 * 下载模块路由：搜索 / 详情。
 *
 * 从 index.mjs 的 register() 闭包里拆出来，路由体逻辑与原实现逐字节一致；
 * 共享闭包状态由 index.mjs 组装成上下文对象传入，避免把 register 再撑回上千行。
 */

import { diskFree, isInside, chapterStats, scanChapterStates, coverUrlFor } from './comic.mjs';

export function registerRoutes(app, s) {
  const { chaptersAllOf, coverPathOf, currentProxy, localComic, paths, pickSource, replySourceError, requireToken } = s;

  /* ================= 搜索 / 详情 ================= */

  app.get('/api/download/search', async function (c) {
    const q = String(c.query('q', '') || '').trim();
    const page = Math.max(1, c.queryInt('page', 1));
    if (!q) { c.error(400, '请输入搜索关键字'); return; }
    if (!requireToken(c)) return;
    const picked = pickSource(c, 'search');
    if (!picked.source) { c.error(400, picked.error); return; }
    await currentProxy();
    try {
      const data = await picked.source.search(q, { page: page });
      const docs = Array.isArray(data.docs) ? data.docs : [];
      const items = [];
      for (const d of docs) {
        const id = String(d.id || '');
        const cover = coverPathOf(d);
        const local = await localComic(id, d.title || '');
        items.push({
          id: id,
          title: d.title || '',
          author: d.author || '',
          cover: cover,
          tags: (d.tags || []).slice(0, 8),
          categories: (d.categories || []).slice(0, 6),
          chapterCount: Number(d.chapterCount || 0),
          likes: Number(d.likes || 0),
          finished: Boolean(d.finished),
          inLibrary: Boolean(local),
          localDir: local ? local.dir : null,
          rootName: local ? local.rootName : null
        });
      }
      c.json({
        ok: true, query: q,
        page: Number(data.page || page),
        pages: Number(data.pages || 1),
        total: Number(data.total || items.length),
        items: items
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '搜索失败：' + (err && err.message ? err.message : err));
    }
  });

  app.get('/api/download/comic/:id', async function (c) {
    if (!requireToken(c)) return;
    const id = String(c.params.id || '');
    const picked = pickSource(c, 'comic');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();
    try {
      const comic = await src.comic(id);
      const chapters = await chaptersAllOf(src, id);
      const p = paths();
      const title = comic.title || id;
      const states = await scanChapterStates(p.comicDir(title), chapters, p, { title: title, comicId: id });
      const local = await localComic(id, title);
      const chaptersOut = chapters.map(function (ch) {
        const s = states[String(ch.order)] || {};
        return {
          chapterId: String(ch.chapterId || ''),
          chapterTitle: ch.chapterTitle || ('第 ' + ch.order + ' 话'),
          order: Number(ch.order || 0),
          updatedAt: ch.updatedAt || null,
          downloaded: Boolean(s.exists),
          complete: Boolean(s.done),
          images: Number(s.images || 0),
          bytes: Number(s.bytes || 0)
        };
      });
      const downloadedChapters = chaptersOut.filter(function (x) { return x.complete || x.downloaded; }).length;
      c.json({
        ok: true,
        comic: {
          id: id, title: title, author: comic.author || '',
          cover: coverPathOf(comic),
          description: comic.description || '',
          tags: comic.tags || [], categories: comic.categories || [],
          pagesCount: Number(comic.pagesCount || 0),
          chapterCount: Number(comic.chapterCount || chapters.length),
          finished: Boolean(comic.finished),
          likesCount: Number(comic.likes || 0),
          viewsCount: Number(comic.views || 0),
          chineseTeam: comic.chineseTeam || '',
          createdAt: comic.createdAt || null, updatedAt: comic.updatedAt || null,
          inLibrary: Boolean(local), localDir: local ? local.dir : null,
          downloadedChapters: downloadedChapters
        },
        chapters: chaptersOut
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '获取漫画详情失败：' + (err && err.message ? err.message : err));
    }
  });

  app.get('/api/download/comic/:id/chapters', async function (c) {
    if (!requireToken(c)) return;
    const id = String(c.params.id || '');
    const picked = pickSource(c, 'comic');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();
    try {
      const qTitle = String(c.query('title', '') || '');
      let title = qTitle;
      if (!title) {
        const comic = await src.comic(id);
        title = comic.title || id;
      }
      const chapters = await chaptersAllOf(src, id);
      const p = paths();
      const states = await scanChapterStates(p.comicDir(title), chapters, p, { title: title, comicId: id });
      const items = chapters.map(function (ch) {
        const s = states[String(ch.order)] || {};
        return {
          chapterId: String(ch.chapterId || ''),
          chapterTitle: ch.chapterTitle || ('第 ' + ch.order + ' 话'),
          order: Number(ch.order || 0),
          downloaded: Boolean(s.exists), complete: Boolean(s.done),
          images: Number(s.images || 0), bytes: Number(s.bytes || 0), dir: s.dir || ''
        };
      });
      c.json({ ok: true, comicId: id, title: title, comicDir: p.comicDir(title), chapters: items });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '获取章节列表失败：' + (err && err.message ? err.message : err));
    }
  });
}
