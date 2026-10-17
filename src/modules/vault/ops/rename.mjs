
import path from 'node:path';
import fsp from 'node:fs/promises';
import { safeJoin } from '../../../core/util.mjs';
import { roots, rootById } from '../../../core/roots.mjs';
import { loadCatalog, findComic, invalidateCatalog } from '../catalog.mjs';
import {
  tidySpaces, sanitizeDirName, dirNameIssues, parseOrderPrefix, chapterDirName, requireInsideRoot
} from '../paths.mjs';
import { flushAll } from '../storage.mjs';
import { record } from '../audit.mjs';

/* ---------------- 02 目录规范化：先出计划 ---------------- */
export async function planRename(cfg, comicIds) {
  const cat = await loadCatalog(cfg);
  const ids = Array.isArray(comicIds) && comicIds.length ? comicIds.map(String) : cat.items.map(function (c) { return c.id; });
  const plan = [];
  for (const id of ids) {
    const c = findComic(cat, id);
    if (!c) continue;
    const root = rootById(cfg, c.rootId) || (roots(cfg)[0] || null);
    if (!root) continue;
    const desired = sanitizeDirName(tidySpaces(c.dir), c.id);
    if (desired !== c.dir) {
      plan.push({ type: 'comic-dir', comicId: c.id, rootId: root.id, from: c.dir, to: desired, reason: dirNameIssues(c.dir).join('、') || '规范化命名' });
    }
    // 章节目录：统一「序 标题」并补零
    for (const ch of (c.chapters || [])) {
      if (!ch.dir || ch.dir === '.') continue;
      const order = Number(ch.order) || parseOrderPrefix(ch.dir) || 1;
      const title = tidySpaces(String(ch.dir).replace(/^\s*\d+\s*/, '')) || ch.title || ('第' + order + '話');
      const desiredCh = chapterDirName(order, title);
      if (desiredCh !== ch.dir) {
        plan.push({ type: 'chapter-dir', comicId: c.id, rootId: root.id, from: path.join(c.dir, ch.dir), to: path.join(c.dir, desiredCh), reason: '章节序号/命名规范化' });
      }
    }
  }
  return { count: plan.length, plan: plan, affectedComics: new Set(plan.map(function (p) { return p.comicId; })).size };
}

export async function applyRename(cfg, comicIds, options) {
  const dry = !options || options.confirm !== true;
  const p = await planRename(cfg, comicIds);
  if (dry) return Object.assign({ applied: false, dryRun: true }, p);

  const done = [];
  const failed = [];
  for (const item of p.plan) {
    const root = rootById(cfg, item.rootId);
    if (!root) { failed.push({ from: item.from, error: '库根不存在' }); continue; }
    const fromAbs = safeJoin(root.path, item.from);
    const toAbs = safeJoin(root.path, item.to);
    try {
      requireInsideRoot(cfg, fromAbs, '源路径');
      requireInsideRoot(cfg, toAbs, '目标路径');
      await fsp.stat(fromAbs);
      try { await fsp.stat(toAbs); failed.push({ from: item.from, to: item.to, error: '目标已存在，跳过' }); continue; } catch (e) { /* 目标不存在，正常 */ }
      await fsp.rename(fromAbs, toAbs);
      done.push(item);
    } catch (err) {
      failed.push({ from: item.from, to: item.to, error: String(err.message || err) });
    }
  }
  invalidateCatalog();
  const entry = await record({
    action: 'rename',
    target: '批量重命名目录',
    comicIds: Array.from(new Set(done.map(function (x) { return x.comicId; }))),
    // 反向撤销要用到 rootId 与 from/to，这里必须完整留存
    details: { items: done.map(function (x) { return { type: x.type, comicId: x.comicId, rootId: x.rootId, from: x.from, to: x.to }; }) },
    counts: { renamed: done.length, failed: failed.length },
    reversible: done.length > 0,
    message: '重命名 ' + done.length + ' 项' + (failed.length ? '，失败 ' + failed.length + ' 项' : '')
  });
  await flushAll();
  return { applied: true, dryRun: false, renamed: done.length, failed: failed, details: done, auditId: entry.id, reversible: done.length > 0 };
}
