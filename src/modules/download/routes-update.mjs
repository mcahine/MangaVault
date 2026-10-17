/**
 * 下载模块路由：已下载漫画更新。
 *
 * 从 index.mjs 的 register() 闭包里拆出来，路由体逻辑与原实现逐字节一致；
 * 共享闭包状态由 index.mjs 组装成上下文对象传入，避免把 register 再撑回上千行。
 */

import { diskFree, isInside, chapterStats, scanChapterStates, coverUrlFor } from './comic.mjs';
import { findComicById, findByDir, listComics } from '../../core/library-index.mjs';

export function registerRoutes(app, s) {
  const { chaptersAllOf, coverPathOf, currentProxy, localComic, paths, pickSource, replySourceError, requireToken, taskComicOf, engine, tasks } = s;

  /* ================= 已下载漫画更新 ================= */

  app.post('/api/download/update-check', async function (c) {
    if (!requireToken(c)) return;
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const limit = Math.max(1, Math.min(200, Number(body.limit || 40)));
    const picked = pickSource(c, 'comic');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();
    try {
      const comics = (await listComics()).filter(function (x) { return x && x.id; });
      const targets = comics.slice(0, limit);
      const results = [];
      // 串行 + 小延迟：避免把上游打爆
      for (const comic of targets) {
        try {
          const chapters = await chaptersAllOf(src, comic.id);
          const localCount = Number(comic.chapters || comic.chapterCount || 0);
          const localOrders = Array.isArray(comic.chapterOrders) ? comic.chapterOrders : null;
          let newOnes;
          if (localOrders && localOrders.length) {
            const set = new Set(localOrders.map(String));
            newOnes = chapters.filter(function (ch) { return !set.has(String(ch.order)); });
          } else {
            // 没有明细时用章节数推断：上游比本地多出来的就是新的
            newOnes = chapters.length > localCount ? chapters.slice(localCount) : [];
          }
          results.push({
            comicId: comic.id,
            title: comic.title || '',
            dir: comic.dir || '',
            localChapters: localCount,
            remoteChapters: chapters.length,
            newChapters: newOnes.map(function (ch) { return { order: Number(ch.order || 0), title: ch.chapterTitle || '' }; })
          });
        } catch (err) {
          results.push({ comicId: comic.id, title: comic.title || '', error: err && err.message ? err.message : String(err) });
        }
      }
      const withNew = results.filter(function (r) { return r.newChapters && r.newChapters.length; });
      c.json({
        ok: true,
        checked: results.length,
        withUpdates: withNew.length,
        items: results,
        message: '检查 ' + results.length + ' 部，' + withNew.length + ' 部有新章节'
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '更新检测失败：' + (err && err.message ? err.message : err));
    }
  });

  app.post('/api/download/update', async function (c) {
    if (!requireToken(c)) return;
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const comicIds = Array.isArray(body.comicIds) ? body.comicIds.map(String) : [];
    if (!comicIds.length) { c.error(400, '请指定要更新的漫画'); return; }
    const picked = pickSource(c, 'comic');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();
    try {
      const queued = [];
      const skipped = [];
      for (const id of comicIds) {
        try {
          const local = await localComic(id, '');
          if (!local) { skipped.push({ comicId: id, reason: '本地没有这部漫画，请先下载' }); continue; }
          const chapters = await chaptersAllOf(src, id);
          const p = paths();
          const states = await scanChapterStates(local.dir, chapters, p, { title: local.title, comicId: id });
          const missing = chapters.filter(function (ch) { return !(states[String(ch.order)] || {}).done; });
          if (!missing.length) { skipped.push({ comicId: id, title: local.title, reason: '已是最新' }); continue; }
          const dup = tasks.list().filter(function (t) { return String(t.comicId) === id && t.state !== 'done' && t.state !== 'canceled'; })[0];
          if (dup) { skipped.push({ comicId: id, title: local.title, reason: '已有任务在跑' }); continue; }
          const comic = await src.comic(id);
          const task = await engine.createTask({
            comicId: id, sourceId: src.meta.id, title: local.title || comic.title, author: comic.author || '',
            cover: coverPathOf(comic),
            comic: taskComicOf(comic),
            chapters: missing.map(function (ch) {
              return { chapterId: String(ch.chapterId || ''), chapterTitle: ch.chapterTitle || ('第 ' + ch.order + ' 话'), order: Number(ch.order || 0) };
            }),
            priority: Number(body.priority || 1)
          });
          engine.enqueue(task);
          queued.push({ comicId: id, taskId: task.id, title: task.title, newChapters: missing.length });
        } catch (err) {
          skipped.push({ comicId: id, reason: err && err.message ? err.message : String(err) });
        }
      }
      c.json({ ok: true, queued: queued, skipped: skipped, message: '已入队 ' + queued.length + ' 部更新（只下新章节）' });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '增量更新失败：' + (err && err.message ? err.message : err));
    }
  });
}
