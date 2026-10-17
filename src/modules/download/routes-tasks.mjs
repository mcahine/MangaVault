/**
 * 下载模块路由：任务。
 *
 * 从 index.mjs 的 register() 闭包里拆出来，路由体逻辑与原实现逐字节一致；
 * 共享闭包状态由 index.mjs 组装成上下文对象传入，避免把 register 再撑回上千行。
 */

import { diskFree, isInside, chapterStats, scanChapterStates, coverUrlFor } from './comic.mjs';

export function registerRoutes(app, s) {
  const { chaptersAllOf, coverPathOf, currentProxy, localComic, paths, pickSource, replySourceError, requireToken, root, stateText, taskComicOf, engine, hub, logger, sse, tasks } = s;

  /* ================= 任务 ================= */

  app.post('/api/download/tasks', async function (c) {
    if (!requireToken(c)) return;
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const comicId = String(body.comicId || '').trim();
    if (!comicId) { c.error(400, '缺少 comicId 参数'); return; }
    if (comicId.length > 64) { c.error(400, 'comicId 不合法'); return; }
    if (!root()) { c.error(400, '未配置下载根目录，请到「设置」里填写'); return; }
    const picked = pickSource(c, 'comic');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();

    try {
      const title0 = String(body.title || '');
      const local = await localComic(comicId, title0);
      if (local) {
        c.json({ ok: true, reused: true, reason: 'already_in_library', message: '《' + (local.title || title0) + '》已在库中，无需重复下载', dir: local.dir, comicId: comicId });
        return;
      }
      const dup = tasks.list().filter(function (t) {
        return String(t.comicId) === comicId && t.state !== 'done' && t.state !== 'canceled';
      })[0];
      if (dup) {
        c.json({ ok: true, reused: true, reason: 'already_queued', message: '该漫画已有下载任务（' + stateText(dup.state) + '），已复用', task: dup });
        return;
      }
      const comic = await src.comic(comicId);
      const all = await chaptersAllOf(src, comicId);
      if (!all.length) { c.error(400, '该漫画没有可下载的章节'); return; }
      const wanted = Array.isArray(body.chapters) && body.chapters.length
        ? all.filter(function (ch) { return body.chapters.map(String).indexOf(String(ch.order)) >= 0; })
        : all;
      if (!wanted.length) { c.error(400, '选中的章节在漫画里不存在'); return; }

      // 磁盘空间预检：按「平均章节体积 × 待下章节」粗估，不足直接拒绝
      const p = paths();
      const title = String(body.title || comic.title || comicId);
      const states = await scanChapterStates(p.comicDir(title), wanted, p, { title: title, comicId: comicId });
      const sections = wanted.map(function (ch) {
        const s = states[String(ch.order)] || {};
        return {
          chapterId: String(ch.chapterId || ''),
          chapterTitle: ch.chapterTitle || ('第 ' + ch.order + ' 话'),
          order: Number(ch.order || 0),
          alreadyDone: Boolean(s.done)
        };
      });
      const toDownload = sections.filter(function (s) { return !s.alreadyDone; });
      const free = await diskFree(root());
      let avgChapter = 0;
      if (comic.pagesCount && comic.chapterCount) avgChapter = (Number(comic.pagesCount) / Math.max(1, Number(comic.chapterCount))) * 250 * 1024;
      else avgChapter = 30 * 250 * 1024;
      const expectBytes = Math.round(avgChapter * toDownload.length);
      if (free !== null && expectBytes > 0 && free - expectBytes < 512 * 1024 * 1024 && body.force !== true) {
        c.error(507, '磁盘空间不足：预计需要 ' + (expectBytes / 1048576).toFixed(1) + 'MB，当前可用 ' + (free / 1048576).toFixed(1) + 'MB（至少保留 512MB）。可清理后重试，或用 force:true 强制加入');
        return;
      }

      const task = await engine.createTask({
        comicId: comicId, sourceId: src.meta.id, title: title, author: comic.author || '',
        cover: coverPathOf(comic),
        comic: taskComicOf(comic), chapters: sections, priority: Number(body.priority || 0)
      });
      engine.enqueue(task);
      logger.info('新建下载任务 ' + task.id + '：《' + title + '》' + sections.length + ' 章');
      c.json({ ok: true, reused: false, task: tasks.get(task.id), expectBytes: expectBytes, freeBytes: free });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '创建下载任务失败：' + (err && err.message ? err.message : err));
    }
  });

  app.get('/api/download/tasks', function (c) {
    const list = tasks.list();
    const st = tasks.status();
    c.json({
      ok: true,
      tasks: list,
      stats: {
        total: list.length,
        running: list.filter(function (t) { return t.state === 'running'; }).length,
        queued: list.filter(function (t) { return t.state === 'queued'; }).length,
        paused: list.filter(function (t) { return t.state === 'paused'; }).length,
        done: list.filter(function (t) { return t.state === 'done'; }).length,
        error: list.filter(function (t) { return t.state === 'error'; }).length,
        canceled: list.filter(function (t) { return t.state === 'canceled'; }).length,
        failedImages: list.reduce(function (a, t) { return a + Number(t.failed || 0); }, 0)
      },
      concurrency: st,
      sse: sse.stats()
    });
  });

  app.post('/api/download/tasks/bulk', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const action = String(body.action || '');
    if (['pause', 'resume', 'cancel', 'remove', 'retry'].indexOf(action) < 0) { c.error(400, '不支持的批量操作：' + action); return; }
    try {
      const r = await tasks.bulk(action, body.ids);
      c.json({ ok: true, ...r, message: '批量 ' + action + '：成功 ' + r.ok + '，失败 ' + r.failed.length });
    } catch (err) {
      c.error(400, err && err.message ? err.message : '批量操作失败');
    }
  });

  app.post('/api/download/tasks/clear-done', async function (c) {
    try {
      const r = await tasks.clearDone();
      hub.send('state', { tasks: tasks.list(), stats: tasks.status() });
      c.json({ ok: true, ...r, message: '已清理 ' + r.removed + ' 条已完成任务（磁盘文件保留）' });
    } catch (err) {
      c.error(400, err && err.message ? err.message : '清理失败');
    }
  });

  app.get('/api/download/tasks/:id', async function (c) {
    const t = tasks.get(c.params.id);
    if (!t) { c.error(404, '任务不存在'); return; }
    c.json({ ok: true, task: t, status: tasks.status() });
  });

  app.get('/api/download/tasks/:id/failures', async function (c) {
    try {
      const f = tasks.failures(c.params.id);
      c.json({ ok: true, ...f });
    } catch (err) { c.error(404, err && err.message ? err.message : '任务不存在'); }
  });

  app.post('/api/download/tasks/:id/retry', async function (c) {
    try {
      const t = await tasks.retryFailures(c.params.id);
      c.json({ ok: true, task: t, message: '已重新排队，只补失败与缺失的部分' });
    } catch (err) { c.error(400, err && err.message ? err.message : '重试失败'); }
  });

  app.post('/api/download/tasks/:id/priority', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    try {
      const t = tasks.setPriority(c.params.id, body.priority);
      c.json({ ok: true, task: t });
    } catch (err) { c.error(400, err && err.message ? err.message : '设置优先级失败'); }
  });

  app.post('/api/download/tasks/:id/pause', async function (c) {
    try {
      const t = await tasks.pause(c.params.id);
      c.json({ ok: true, task: t, message: '已暂停（等在途请求结束）' });
    } catch (err) { c.error(400, err && err.message ? err.message : '暂停失败'); }
  });

  app.post('/api/download/tasks/:id/resume', async function (c) {
    try {
      const t = await tasks.resume(c.params.id);
      c.json({ ok: true, task: t, message: '已继续，已存在的图片会自动跳过' });
    } catch (err) { c.error(400, err && err.message ? err.message : '继续失败'); }
  });

  app.post('/api/download/tasks/:id/cancel', async function (c) {
    try {
      const t = await tasks.cancel(c.params.id);
      c.json({ ok: true, task: t, message: '已取消' });
    } catch (err) { c.error(400, err && err.message ? err.message : '取消失败'); }
  });

  app.del('/api/download/tasks/:id', async function (c) {
    try {
      await tasks.remove(c.params.id);
      c.json({ ok: true, message: '任务已删除（已下载的文件保留在磁盘上）' });
    } catch (err) { c.error(400, err && err.message ? err.message : '删除失败'); }
  });

  /** 单任务日志 tail。 */
  app.get('/api/download/tasks/:id/logs', async function (c) {
    const t = tasks.get(c.params.id);
    if (!t) { c.error(404, '任务不存在'); return; }
    const limit = Math.max(1, Math.min(200, c.queryInt('limit', 40)));
    c.json({ ok: true, taskId: t.id, logs: (t.logs || []).slice(-limit) });
  });
}
