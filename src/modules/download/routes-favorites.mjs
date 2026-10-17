/**
 * 下载模块路由：收藏夹。
 *
 * 从 index.mjs 的 register() 闭包里拆出来，路由体逻辑与原实现逐字节一致；
 * 共享闭包状态由 index.mjs 组装成上下文对象传入，避免把 register 再撑回上千行。
 */

import { diskFree, isInside, chapterStats, scanChapterStates, coverUrlFor } from './comic.mjs';

export function registerRoutes(app, s) {
  const { chaptersAllOf, coverPathOf, currentProxy, favoritesAllOf, localComic, paths, pickSource, replySourceError, requireToken, taskComicOf, engine, hub, tasks } = s;

  /* ================= 收藏夹 ================= */

  app.get('/api/download/favorites', async function (c) {
    if (!requireToken(c)) return;
    const page = Math.max(1, c.queryInt('page', 1));
    /* 必须把前端传的 sort 透传给适配器：适配器对未传值默认 dd，
       漏传会让「点最早收藏仍按最新收藏拉取」——界面上完全看不出来，
       只有对比上游请求（s=dd / s=da）才发现。 */
    const sort = String(c.query('sort', 'dd') || 'dd');
    const picked = pickSource(c, 'favorites');
    if (!picked.source) { c.error(400, picked.error); return; }
    await currentProxy();
    try {
      const data = await picked.source.favorites({ page: page, sort: sort });
      const docs = Array.isArray(data.docs) ? data.docs : [];
      const items = [];
      for (const d of docs) {
        const id = String(d.id || '');
        const local = await localComic(id, d.title || '');
        items.push({
          id: id, title: d.title || '', author: d.author || '',
          cover: coverPathOf(d),
          tags: (d.tags || []).slice(0, 6),
          chapterCount: Number(d.chapterCount || 0),
          likes: Number(d.likes || 0),
          finished: Boolean(d.finished),
          inLibrary: Boolean(local), localDir: local ? local.dir : null
        });
      }
      c.json({ ok: true, page: Number(data.page || page), pages: Number(data.pages || 1), total: Number(data.total || items.length), items: items });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '获取收藏夹失败：' + (err && err.message ? err.message : err));
    }
  });

  app.post('/api/download/favorites/sync', async function (c) {
    if (!requireToken(c)) return;
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const comicIds = Array.isArray(body.comicIds) ? body.comicIds.map(String) : [];
    const takeAll = body.all === true || body.all === 'true';
    if (!comicIds.length && !takeAll) { c.error(400, '请指定要同步的漫画（comicIds）或勾选全部'); return; }
    const picked = pickSource(c, 'favorites');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();
    try {
      let docs = [];
      if (takeAll) {
        const fav = await favoritesAllOf(src, { maxPages: Math.max(1, Number(body.maxPages || 20)) });
        docs = fav.docs || [];
      } else {
        docs = comicIds.map(function (id) { return { _id: id }; });
      }
      const result = { queued: [], skipped: [], failed: [] };
      for (const d of docs) {
        const id = String(d.id || d._id || '');
        if (!id) continue;
        try {
          const local = await localComic(id, d.title || '');
          if (local) { result.skipped.push({ comicId: id, title: local.title, reason: '已在库' }); continue; }
          const dup = tasks.list().filter(function (t) { return String(t.comicId) === id && t.state !== 'done' && t.state !== 'canceled'; })[0];
          if (dup) { result.skipped.push({ comicId: id, title: dup.title, reason: '已有任务' }); continue; }
          const comic = await src.comic(id);
          const all = await chaptersAllOf(src, id);
          if (!all.length) { result.skipped.push({ comicId: id, title: comic.title, reason: '没有章节' }); continue; }
          const p = paths();
          const title = String(comic.title || id);
          const states = await scanChapterStates(p.comicDir(title), all, p, { title: title, comicId: id });
          const sections = all.map(function (ch) {
            return {
              chapterId: String(ch.chapterId || ''),
              chapterTitle: ch.chapterTitle || ('第 ' + ch.order + ' 话'),
              order: Number(ch.order || 0),
              alreadyDone: Boolean((states[String(ch.order)] || {}).done)
            };
          });
          const task = await engine.createTask({
            comicId: id, sourceId: src.meta.id, title: title, author: comic.author || '',
            cover: coverPathOf(comic),
            comic: taskComicOf(comic), chapters: sections, priority: Number(body.priority || 0)
          });
          engine.enqueue(task);
          result.queued.push({ comicId: id, taskId: task.id, title: title, chapters: sections.length });
        } catch (err) {
          result.failed.push({ comicId: id, error: err && err.message ? err.message : String(err) });
        }
      }
      hub.send('state', { tasks: tasks.list(), stats: tasks.status() });
      c.json({
        ok: true, ...result,
        message: '同步完成：入队 ' + result.queued.length + ' 部 / 跳过 ' + result.skipped.length + ' 部 / 失败 ' + result.failed.length + ' 部'
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '同步收藏夹失败：' + (err && err.message ? err.message : err));
    }
  });
}
