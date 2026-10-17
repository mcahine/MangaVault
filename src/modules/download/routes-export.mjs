/**
 * 下载模块路由：导出。
 *
 * 从 index.mjs 的 register() 闭包里拆出来，路由体逻辑与原实现逐字节一致；
 * 共享闭包状态由 index.mjs 组装成上下文对象传入，避免把 register 再撑回上千行。
 */

import path from 'node:path';
import { roots, activeRoots, ownerRootOf, probeRoots, labelOf } from '../../core/roots.mjs';

export function registerRoutes(app, s) {
  const { cfg, exportDir, localComic, root, exports, hub } = s;

  /* ================= 导出 ================= */

  app.post('/api/download/export', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const comicIds = Array.isArray(body.comicIds) ? body.comicIds.map(String) : [];
    if (!comicIds.length) { c.error(400, '请选择要导出的漫画'); return; }
    const format = ['zip', 'cbz', 'folder'].indexOf(String(body.format)) >= 0 ? String(body.format) : 'zip';
    try {
      let outDir = String(body.outDir || '').trim();
      outDir = outDir ? path.resolve(outDir) : await exportDir();
      const allowed = [root()].concat(activeRoots(cfg()).map(function (r) { return r.path; })).filter(Boolean);
      const owner = ownerRootOf(cfg(), outDir);
      // 导出目录允许在库根内，也允许是库根的同级目录（用户自选），但必须是绝对路径
      if (!path.isAbsolute(outDir)) { c.error(400, '导出目录必须是绝对路径'); return; }
      const items = [];
      const missing = [];
      for (const id of comicIds) {
        const local = await localComic(id, '');
        if (!local) { missing.push(id); continue; }
        items.push({ comicId: id, title: local.title, dir: local.dir });
      }
      if (!items.length) { c.error(404, '选中的漫画在本地都找不到，无法导出'); return; }
      const job = await exports.submit(items, { format: format, outDir: outDir, method: body.method === 'store' ? 'store' : 'deflate' });
      hub.send('state', { exportJob: job });
      c.json({ ok: true, job: job, missing: missing, message: '已开始导出 ' + items.length + ' 部到 ' + outDir + '（' + (format === 'folder' ? '复制目录' : format.toUpperCase()) + '）' });
    } catch (err) {
      c.error(400, err && err.message ? err.message : '导出失败');
    }
  });

  app.get('/api/download/exports', async function (c) {
    try {
      const list = await exports.list();
      c.json({ ok: true, jobs: list, busy: exports.isBusy(), queued: exports.queuedCount(), defaultDir: await exportDir() });
    } catch (err) {
      c.error(500, '读取导出记录失败：' + (err && err.message ? err.message : err));
    }
  });

  app.get('/api/download/export/:id', async function (c) {
    try {
      const job = await exports.get(c.params.id);
      if (!job) { c.error(404, '导出任务不存在'); return; }
      c.json({ ok: true, job: job });
    } catch (err) { c.error(500, '读取导出任务失败：' + (err && err.message ? err.message : err)); }
  });

  app.post('/api/download/export/:id/remove', async function (c) {
    try {
      await exports.remove(c.params.id);
      c.json({ ok: true, message: '导出记录已删除（文件保留）' });
    } catch (err) { c.error(400, err && err.message ? err.message : '删除导出记录失败'); }
  });
}
