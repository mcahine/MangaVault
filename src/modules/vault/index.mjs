import { createLogger } from '../../core/log.mjs';
import { roots, rootById } from '../../core/roots.mjs';
import { loadCatalog, invalidateCatalog, hydrateComic, findComic as findComicAnywhere } from './catalog.mjs';
import { loadStores, allStores, flushAll, tagStore, shelfStore } from './storage.mjs';
import {
  listTags, tagById, findTagRef, createTag, updateTag, deleteTag, mergeTags,
  setDeriveSettings, makeTagEnv, effectiveTags, effectiveNames, assignTags, comicOverlay,
  tagStats, tagComics, searchComics, exportTagsPayload, importTags
} from './tags.mjs';
import {
  editMeta, planRename, applyRename, moveToRoot, trashComics, listTrash, restoreTrash,
  purgeTrash, setCover, verifyComics, fixComics, duplicates, stats, readingTime, readingStats,
  makeBackup, listBackups, restoreBackup,
  planBatchMeta, applyBatchMeta, exportMetaPayload, importMetaPayload,
  scanOrphans, cleanOrphans, undoLast
} from './ops/index.mjs';
import { auditLog, undoable, auditDir, auditActionLabel, record } from './audit.mjs';
import { tidySpaces } from './paths.mjs';
import { withHeartbeat } from '../../core/heartbeat.mjs';

export const meta = {
  id: 'vault',
  name: '管理台',
  description: '标签体系 · 批量整理 · 校验修复 · 回收站 · 统计 · 备份',
  order: 30,
  help: [
    'GET  /api/vault/state',
    'GET  /api/vault/tags · POST /api/vault/tags · PATCH /api/vault/tags · DELETE /api/vault/tags',
    'POST /api/vault/tags/merge · POST /api/vault/tags/assign · POST /api/vault/tags/import',
    'GET  /api/vault/tags/stats · GET /api/vault/tag/:id/comics',
    'GET  /api/vault/search',
    'GET  /api/vault/shelves · POST /api/vault/shelves · DELETE /api/vault/shelves',
    'POST /api/vault/comic/:id/meta',
    'POST /api/vault/batch · GET /api/vault/batch/plan',
    'GET  /api/vault/trash · POST /api/vault/trash · POST /api/vault/trash/restore · POST /api/vault/trash/purge',
    'GET  /api/vault/verify · POST /api/vault/verify/fix',
    'GET  /api/vault/duplicates · GET /api/vault/stats',
    'POST /api/vault/reading-time · GET /api/vault/reading-stats',
    'POST /api/vault/backup · GET /api/vault/backup · POST /api/vault/backup/restore',
    'POST /api/vault/tags/assign（支持 dryRun 预演 / 批量加删标签）',
    'POST /api/vault/meta/plan · POST /api/vault/meta/batch · GET /api/vault/meta/export · POST /api/vault/meta/import',
    'POST /api/vault/move/plan · POST /api/vault/move',
    'GET /api/vault/orphans · POST /api/vault/orphans/clean',
    'GET /api/vault/audit · GET /api/vault/audit/undoable · POST /api/vault/audit/undo · GET /api/vault/audit/archive/:id'
  ]
};

let moduleCtx = null;
let log = null;

/**
 * 每次都用最新配置：设置页改了库根 / 查重目录后必须立刻生效。
 * （曾经把 register 时的 ctx.config 存成 cfgNow()，导致改完配置 vault 仍读旧库根 —— 缓存命中旧数据。）
 */
function cfgNow() { return moduleCtx ? moduleCtx.config : {}; }

/** 库根中文名（给前端展示） */
function rootLabel(id) {
  const r = rootById(cfgNow(), id);
  return r ? r.name : (id || '未知库根');
}

/** 给列表项补上派生的有效标签与库根名（前端标签墙直接用） */
function decorate(cat, c, env) {
  return {
    id: c.id, title: c.title, dir: c.dir, rootId: c.rootId, rootName: rootLabel(c.rootId),
    author: c.author, hasMeta: c.hasMeta, images: c.images, bytes: c.bytes,
    chapterCount: c.chapterCount, cover: Boolean(c.cover),
    indexed: c.indexed,
    autoTags: (function () {
      const eff = effectiveTags(c, cfgNow(), env);
      return eff.map(function (t) { return { name: t.name, source: t.source, color: t.color || null }; });
    })(),
    overlay: comicOverlay(c.id)
  };
}

export async function register(app, ctx) {
  moduleCtx = ctx;
  log = createLogger('vault', ctx.config.logLevel);
  await loadStores();
  log.info('管理台就绪：标签 ' + listTags().length + ' 个 / 书架 ' + ((shelfStore().data.shelves || []).length) + ' 个');

  /* ---------- 状态 ---------- */
  app.get('/api/vault/state', async function (c) {
    const cat = await loadCatalog(cfgNow());
    c.json({
      ok: true,
      roots: roots(cfgNow()).map(function (r) { return { id: r.id, name: r.name, path: r.path, enabled: r.enabled }; }),
      catalog: { comics: cat.items.length, indexed: cat.indexCount, extra: cat.extraCount, scannedAt: cat.scannedAt },
      tags: listTags().length,
      shelves: (shelfStore().data.shelves || []).length,
      deriveSettings: tagStore().data.settings
    });
  });

  /** 目录视图（管理台的清单源） */
  app.get('/api/vault/comics', async function (c) {
    const cat = await loadCatalog(cfgNow());
    const env = makeTagEnv();
    const q = c.query('q', '');
    const rootId = c.query('root', '');
    const tagName = c.query('tag', '');
    const page = Math.max(1, c.queryInt('page', 1));
    const size = Math.min(500, Math.max(1, c.queryInt('size', 100)));

    let list = cat.items;
    if (rootId) list = list.filter(function (x) { return x.rootId === rootId; });
    if (q) {
      const kw = String(q).trim().toLowerCase();
      list = list.filter(function (x) {
        return String(x.title).toLowerCase().includes(kw) || String(x.dir).toLowerCase().includes(kw) || String(x.author || '').toLowerCase().includes(kw);
      });
    }
    if (tagName) {
      const key = String(tagName).trim().toLowerCase();
      list = list.filter(function (x) {
        return effectiveNames(x, cfgNow(), env).some(function (n) { return n.toLowerCase() === key; });
      });
    }
    const total = list.length;
    const slice = list.slice((page - 1) * size, page * size);
    c.json({ ok: true, total: total, page: page, size: size, pages: Math.max(1, Math.ceil(total / size)), items: slice.map(function (x) { return decorate(cat, x, env); }) });
  });

  /* ---------- 标签 ---------- */
  app.get('/api/vault/tags', function (c) {
    const s = tagStore().data;
    c.json({ ok: true, tags: listTags(), settings: s.settings, updatedAt: s.updatedAt });
  });

  app.post('/api/vault/tags', async function (c) {
    const r = createTag(c.body || {});
    await flushAll();
    invalidateCatalog();
    c.json({ ok: true, tag: r.tag, created: r.created, message: r.created ? '已新建标签「' + r.tag.name + '」' : '标签已存在，直接复用', status: r.created ? 201 : 200 });
  });

  app.put('/api/vault/tags', async function (c) {
    const r = updateTag(c.body || {});
    await flushAll();
    invalidateCatalog();
    c.json({ ok: true, tag: r.tag || r, message: '标签已更新' });
  });

  app.del('/api/vault/tags', async function (c) {
    const id = c.query('id', '') || (c.body && c.body.id) || '';
    if (!id) c.throwError(400, '缺少 id 参数（也可用 POST /api/vault/tags/delete）');
    const r = deleteTag({ id: id, keepOverlay: c.query('keepOverlay', '') === '1' });
    await flushAll();
    invalidateCatalog();
    c.json({ ok: true, removed: r.tag ? r.tag.name : id, cleaned: r.cleaned || 0, message: '标签已删除' });
  });

  app.post('/api/vault/tags/delete', async function (c) {
    const r = deleteTag(c.body || {});
    await flushAll();
    invalidateCatalog();
    c.json({ ok: true, removed: r.tag ? r.tag.name : '', cleaned: r.cleaned || 0, message: '标签已删除' });
  });

  app.post('/api/vault/tags/merge', async function (c) {
    const r = mergeTags(c.body || {});
    await flushAll();
    invalidateCatalog();
    c.json({ ok: true, message: '已合并标签', from: r.from, to: r.to, moved: r.moved || 0, tags: listTags() });
  });

  app.post('/api/vault/tags/assign', async function (c) {
    const b = c.body || {};
    const ids = (Array.isArray(b.comicIds) ? b.comicIds : []).map(String).filter(Boolean);
    const add = Array.isArray(b.add) ? b.add : [];
    const remove = Array.isArray(b.remove) ? b.remove : [];
    // 预演：只算「会加什么、会建哪些新标签、命中多少部」，不写盘
    if (b.dryRun === true) {
      const addNames = add.map(function (x) { return tidySpaces(x); }).filter(Boolean);
      const removeNames = remove.map(function (x) { return tidySpaces(x); }).filter(Boolean);
      const existing = addNames.filter(function (n) { return Boolean(findTagRef(n)); });
      const willCreate = addNames.filter(function (n) { return !findTagRef(n); });
      c.json({
        ok: true, dryRun: true,
        plan: {
          comicIds: ids, count: ids.length, add: addNames, remove: removeNames,
          existingTags: existing, willCreateTags: willCreate,
          note: ids.length ? '' : '还没有勾选任何漫画'
        },
        message: '预演：' + ids.length + ' 部漫画 +' + addNames.length + ' / -' + removeNames.length + ' 个标签' + (willCreate.length ? '（会新建 ' + willCreate.length + ' 个标签）' : '')
      });
      return;
    }
    if (!ids.length) c.throwError(400, '请先勾选漫画');
    if (!add.length && !remove.length) c.throwError(400, '请填写要添加或移除的标签');
    const r = assignTags(cfgNow(), ids, add, remove, b.note);
    const entry = await record({
      action: 'tag-assign',
      target: '批量打标签',
      comicIds: ids,
      details: { add: r.added, remove: r.removed, note: b.note || '', before: r.before || {} },
      counts: { affected: r.assigned, created: (r.createdTags || []).length },
      reversible: true,
      message: '打标签：' + r.assigned + ' 部，+' + (r.added || []).length + ' / -' + (r.removed || []).length
    });
    await flushAll();
    invalidateCatalog();
    const affected = r.affected !== undefined ? r.affected : ids.length;
    c.json({
      ok: true, affected: r.assigned !== undefined ? r.assigned : affected,
      created: r.createdTags || [], added: r.added || [], removed: r.removed || [],
      overlay: r.overlay || null, auditId: entry.id, reversible: true,
      message: '已更新 ' + (r.assigned !== undefined ? r.assigned : affected) + ' 部漫画的标签'
    });
  });

  app.post('/api/vault/tags/settings', async function (c) {
    setDeriveSettings(c.body || {});
    await flushAll();
    invalidateCatalog();
    c.json({ ok: true, settings: tagStore().data.settings, message: '派生规则已更新' });
  });

  app.get('/api/vault/tags/stats', async function (c) {
    c.json({ ok: true, stats: await tagStats(cfgNow()) });
  });

  app.get('/api/vault/tags/export', function (c) {
    c.json({ ok: true, payload: exportTagsPayload() });
  });

  app.post('/api/vault/tags/import', async function (c) {
    const b = c.body || {};
    const r = importTags(b.payload || b, b.mode || 'skip');
    await flushAll();
    invalidateCatalog();
    c.json({ ok: true, result: r, tags: listTags(), message: '标签已导入' });
  });

  app.get('/api/vault/tag/:id/comics', async function (c) {
    const page = Math.max(1, c.queryInt('page', 1));
    const size = Math.min(300, Math.max(1, c.queryInt('size', 60)));
    const r = await tagComics(cfgNow(), c.params.id, page, size);
    const cat = await loadCatalog(cfgNow());
    // tagComics 只回 id 列表，这里补上标题/库根名等展示字段
    const items = (r.items || []).map(function (x) {
      const raw = typeof x === 'string' ? x : (x && (x.id || x.comicId)) || '';
      const found = findComicAnywhere(cat, raw);
      if (found) return { id: found.id, title: found.title, dir: found.dir, rootId: found.rootId, rootName: rootLabel(found.rootId), images: found.images, bytes: found.bytes, hasMeta: found.hasMeta };
      return { id: String(raw), title: typeof x === 'object' && x ? (x.title || String(raw)) : String(raw), dir: '', rootId: null, rootName: '(不在当前库)', images: 0, bytes: 0, hasMeta: false };
    });
    c.json({ ok: true, tag: r.tag || c.params.id, total: r.total, page: page, size: size, items: items });
  });

  /* ---------- 搜索 / 书架 ---------- */
  app.get('/api/vault/search', async function (c) {
    const raw = {};
    ['tags', 'mode', 'exclude', 'author', 'root', 'hasMeta', 'minPages', 'sort', 'q', 'page', 'size', 'fav'].forEach(function (k) {
      const v = c.query(k, null);
      if (v !== null) raw[k] = v;
    });
    const r = await searchComics(cfgNow(), raw);
    c.json({ ok: true, total: r.total, page: r.page || 1, size: r.size || 60, query: raw, items: r.items });
  });

  app.get('/api/vault/shelves', function (c) {
    c.json({ ok: true, shelves: shelfStore().data.shelves || [] });
  });

  app.post('/api/vault/shelves', async function (c) {
    const b = c.body || {};
    const name = String(b.name || '').trim();
    if (!name) c.throwError(400, '书架名不能为空');
    const st = shelfStore();
    const list = st.data.shelves || (st.data.shelves = []);
    const id = b.id || ('shelf-' + Math.random().toString(36).slice(2, 8));
    const idx = list.findIndex(function (s) { return s.id === id || s.name === name; });
    const item = { id: idx >= 0 ? list[idx].id : id, name: name, group: String(b.group || ''), query: b.query || {}, note: String(b.note || ''), createdAt: idx >= 0 ? list[idx].createdAt : new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (idx >= 0) list[idx] = item; else list.push(item);
    st.data.updatedAt = new Date().toISOString();
    st.markDirty();
    await flushAll();
    c.json({ ok: true, shelf: item, shelves: list, message: '书架已保存' });
  });

  app.del('/api/vault/shelves', async function (c) {
    const id = c.query('id', '');
    if (!id) c.throwError(400, '缺少 id 参数');
    const st = shelfStore();
    const before = (st.data.shelves || []).length;
    st.data.shelves = (st.data.shelves || []).filter(function (s) { return s.id !== id; });
    st.data.updatedAt = new Date().toISOString();
    st.markDirty();
    await flushAll();
    c.json({ ok: true, removed: before - st.data.shelves.length, message: '书架已删除' });
  });

  /* ---------- 元数据编辑 ---------- */
  app.post('/api/vault/comic/:id/meta', async function (c) {
    const r = await editMeta(cfgNow(), c.params.id, c.body || {});
    // 通知 library 刷新单本（失败不影响本次写入结果）
    try {
      await fetch('http://127.0.0.1:' + (cfgNow().port || 8775) + '/api/library/refresh-single', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comicId: c.params.id })
      });
    } catch (e) { log.warn('library 单本刷新失败（不影响元数据写入）: ' + e.message); }
    c.json({ ok: true, result: r, message: '元数据已写入' + (r.backup ? '（原文件备份为 ' + r.backup + '）' : '') });
  });

  /* ---------- 批量操作 ---------- */
  app.get('/api/vault/batch/plan', async function (c) {
    const cat = await loadCatalog(cfgNow());
    const env = makeTagEnv();
    const ids = c.query('comicIds', '');
    const list = ids ? ids.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : cat.items.map(function (x) { return x.id; });
    c.json({ ok: true, plan: await planRename(cfgNow(), list) });
  });

  app.post('/api/vault/batch', async function (c) {
    const b = c.body || {};
    const action = String(b.action || '');
    const ids = Array.isArray(b.comicIds) ? b.comicIds.map(String) : [];
    const opts = b.options || {};
    switch (action) {
      case 'rename-dirs': {
        if (opts.confirm === true) {
          if (!ids.length) c.throwError(400, '执行批量重命名必须提供 comicIds，避免误操作全库');
          const r = await applyRename(cfgNow(), ids, opts);
          return c.json({ ok: true, action: action, result: r, message: '重命名完成：' + (r.renamed || 0) + ' 项' + ((r.failed || []).length ? '，失败 ' + r.failed.length + ' 项' : '') });
        }
        const plan = await planRename(cfgNow(), ids);
        return c.json({ ok: true, action: action, dryRun: true, plan: plan, message: '这是预演结果，确认后传 options.confirm=true 执行' });
      }
      case 'move-to-root': {
        const r = await moveToRoot(cfgNow(), ids, String(opts.targetRootId || ''), opts);
        return c.json({ ok: true, action: action, result: r, message: r.dryRun ? '这是预演结果' : '已移动 ' + r.moved + ' 部' });
      }
      case 'cover': {
        if (!ids.length) c.throwError(400, '请选择漫画');
        const out = [];
        for (const id of ids) out.push(await setCover(cfgNow(), id, { file: opts.file }));
        return c.json({ ok: true, action: action, result: out, message: '封面已更新 ' + out.length + ' 部' });
      }
      case 'normalize-chapters': {
        const r = await applyRename(cfgNow(), ids, opts);
        return c.json({ ok: true, action: action, result: r, message: opts.confirm === true ? '章节已重排' : '这是预演结果' });
      }
      case 'trash': {
        // 与 POST /api/vault/trash 等价，便于前端用同一个批量入口；必须显式给出 comicIds
        if (!ids.length) c.throwError(400, '移入回收站必须提供 comicIds，避免误操作全库');
        const r = await trashComics(cfgNow(), ids, b.note);
        return c.json({ ok: true, action: action, result: r, message: '已移入回收站 ' + r.moved + ' 部' + (r.failed.length ? '，失败 ' + r.failed.length + ' 部' : '') });
      }
      default:
        c.throwError(400, '未知的批量操作：' + action + '（支持 rename-dirs / normalize-chapters / move-to-root / cover / trash）');
    }
  });

  /* ---------- 批量改标签 / 批量改元数据（plan → execute） ---------- */
  app.post('/api/vault/meta/plan', async function (c) {
    const b = c.body || {};
    const plan = await planBatchMeta(cfgNow(), b.comicIds, b.patch || b.fields || {});
    c.json({ ok: true, plan: plan, message: '预演：将修改 ' + plan.count + ' 部' + (plan.unchangedCount ? '，' + plan.unchangedCount + ' 部无变化' : '') });
  });

  app.post('/api/vault/meta/batch', async function (c) {
    const b = c.body || {};
    if (b.confirm !== true) {
      const plan = await planBatchMeta(cfgNow(), b.comicIds, b.patch || b.fields || {});
      c.json({ ok: true, dryRun: true, plan: plan, message: '这是预演结果，确认后传 confirm=true 执行' });
      return;
    }
    const r = await applyBatchMeta(cfgNow(), b.comicIds, b.patch || b.fields || {}, { confirm: true });
    invalidateCatalog();
    c.json({
      ok: true, result: r, auditId: r.auditId, reversible: r.reversible !== false,
      message: '已修改 ' + r.appliedCount + ' 部元数据' + (r.failedCount ? '，失败 ' + r.failedCount + ' 部' : '') + '（可在「审计日志」一键撤销）'
    });
  });

  app.get('/api/vault/meta/export', async function (c) {
    const ids = c.query('comicIds', '');
    const list = ids ? ids.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    const payload = await exportMetaPayload(cfgNow(), list);
    c.json({ ok: true, payload: payload, count: payload.count, message: '已导出 ' + payload.count + ' 部漫画的元数据' });
  });

  app.post('/api/vault/meta/import', async function (c) {
    const b = c.body || {};
    const r = await importMetaPayload(cfgNow(), b.payload || b, { confirm: b.confirm === true, mode: b.mode || 'overwrite' });
    invalidateCatalog();
    if (r.dryRun) {
      c.json({ ok: true, dryRun: true, plan: r, message: '预演：将导入 ' + r.count + ' 部（匹配不上 ' + r.unmatched.length + ' 条），确认后传 confirm=true 执行' });
      return;
    }
    c.json({
      ok: true, result: r, auditId: r.auditId, reversible: r.imported > 0,
      message: '已导入 ' + r.imported + ' 部元数据' + (r.failedCount ? '，失败 ' + r.failedCount + ' 部' : '') + (r.unmatched.length ? '，' + r.unmatched.length + ' 条匹配不上已跳过' : '')
    });
  });

  /* ---------- 跨库根批量搬迁（plan → execute，可撤销） ---------- */
  app.post('/api/vault/move/plan', async function (c) {
    const b = c.body || {};
    const r = await moveToRoot(cfgNow(), b.comicIds, String(b.targetRootId || b.targetRoot || ''), { collision: b.collision || 'error' });
    c.json({
      ok: true, plan: r, conflictCount: r.conflictCount || 0, crossDeviceCount: r.crossDeviceCount || 0,
      message: '预演：将搬迁 ' + r.count + ' 部到「' + ((r.targetRoot && r.targetRoot.name) || '') + '」' + (r.conflictCount ? '，其中 ' + r.conflictCount + ' 部目标重名' : '') + (r.crossDeviceCount ? '，' + r.crossDeviceCount + ' 部需要跨盘复制' : '')
    });
  });

  app.post('/api/vault/move', async function (c) {
    const b = c.body || {};
    const r = await moveToRoot(cfgNow(), b.comicIds, String(b.targetRootId || b.targetRoot || ''), { confirm: b.confirm === true, collision: b.collision || 'error' });
    invalidateCatalog();
    c.json({
      ok: true, result: r, dryRun: r.dryRun === true, auditId: r.auditId, reversible: r.reversible === true,
      message: r.dryRun ? '这是预演结果，确认后传 confirm=true 执行' : ('已搬迁 ' + r.moved + ' 部' + (r.failedCount ? '，失败 ' + r.failedCount + ' 部' : '') + '（可在「审计日志」一键撤销）')
    });
  });

  /* ---------- 孤儿清理 ---------- */
  app.get('/api/vault/orphans', async function (c) {
    const r = await scanOrphans(cfgNow());
    c.json({ ok: true, ...r, message: r.counts.total ? '发现 ' + r.counts.total + ' 条孤儿记录' : '没有发现孤儿记录' });
  });

  app.post('/api/vault/orphans/clean', async function (c) {
    const b = c.body || {};
    if (b.confirm !== true) {
      const preview = await scanOrphans(cfgNow());
      c.json({ ok: true, dryRun: true, preview: preview, message: '这是预演结果，确认后传 confirm=true 执行清理' });
      return;
    }
    const r = await withHeartbeat(function () {
      return cleanOrphans(cfgNow(), { confirm: true, parts: b.parts || {}, note: b.note });
    }, { label: '孤儿记录清理', log: log });
    invalidateCatalog();
    c.json({ ok: true, result: r, auditId: r.auditId, reversible: false, message: r.message });
  });

  /* ---------- 审计日志 / 撤销 ---------- */
  app.get('/api/vault/audit', function (c) {
    const log2 = auditLog({ page: c.queryInt('page', 1), limit: c.queryInt('limit', 60), action: c.query('action', '') });
    const last = undoable();
    c.json({
      ok: true, ...log2,
      dir: auditDir(),
      undoable: last ? { id: last.id, action: last.action, actionLabel: last.actionLabel, message: last.message, at: last.at, counts: last.counts } : null,
      message: '审计日志 ' + log2.total + ' 条'
    });
  });

  app.get('/api/vault/audit/undoable', function (c) {
    const last = undoable();
    c.json({ ok: true, undoable: last, message: last ? '最近可撤销：' + last.actionLabel : '当前没有可撤销的操作' });
  });

  app.post('/api/vault/audit/undo', async function (c) {
    const b = c.body || {};
    const r = await undoLast(cfgNow(), { entryId: b.entryId || b.id || '', confirm: b.confirm === true });
    invalidateCatalog();
    c.json({ ok: true, result: r, message: r.message });
  });

  app.get('/api/vault/audit/archive/:id', async function (c) {
    const r = await readArchiveSafe(c.params.id);
    c.json({ ok: true, archive: r, message: '归档内容共 ' + r.bytes + ' 字节' });
  });

  /* ---------- 回收站 ---------- */
  app.get('/api/vault/trash', async function (c) {
    c.json({ ok: true, trash: await listTrash() });
  });

  app.post('/api/vault/trash', async function (c) {
    const b = c.body || {};
    const ids = Array.isArray(b.comicIds) ? b.comicIds.map(String) : [];
    if (!ids.length) c.throwError(400, 'comicIds 不能为空');
    const r = await trashComics(cfgNow(), ids, b.note);
    c.json({ ok: true, result: r, message: '已移入回收站 ' + r.moved + ' 部' + (r.failed.length ? '，失败 ' + r.failed.length + ' 部' : '') });
  });

  app.post('/api/vault/trash/restore', async function (c) {
    const b = c.body || {};
    const r = await restoreTrash(cfgNow(), b.ids || b.trashPaths || []);
    c.json({ ok: true, result: r, message: '已还原 ' + r.restored + ' 部' + (r.failed.length ? '，失败 ' + r.failed.length + ' 部' : '') });
  });

  app.post('/api/vault/trash/purge', async function (c) {
    const b = c.body || {};
    const r = await withHeartbeat(function () {
      return purgeTrash(b.ids || b.trashPaths || [], b.confirm);
    }, { label: '回收站永久删除', log: log });
    c.json({ ok: true, result: r, message: '已永久删除 ' + r.purged + ' 部' });
  });

  /* ---------- 校验 / 修复 ---------- */
  app.get('/api/vault/verify', async function (c) {
    const r = await verifyComics(cfgNow(), {
      comicId: c.query('comicId', '') || undefined,
      rootId: c.query('root', '') || undefined,
      limit: c.queryInt('limit', 400)
    });
    c.json({ ok: true, result: r });
  });

  app.post('/api/vault/verify/fix', async function (c) {
    const b = c.body || {};
    const r = await withHeartbeat(function () {
      return fixComics(cfgNow(), { comicId: b.comicId, confirm: b.confirm === true });
    }, { label: '校验修复', log: log });
    c.json({ ok: true, result: r, message: r.dryRun ? '这是预演结果，确认后传 confirm=true 执行' : '已修复 ' + r.count + ' 项' });
  });

  /* ---------- 重复 / 统计 ---------- */
  app.get('/api/vault/duplicates', async function (c) {
    c.json({ ok: true, result: await duplicates(cfgNow()) });
  });

  app.get('/api/vault/stats', async function (c) {
    c.json({ ok: true, stats: await stats(cfgNow()) });
  });

  app.post('/api/vault/reading-time', async function (c) {
    const b = c.body || {};
    if (!b.comicId) c.throwError(400, '缺少 comicId');
    c.json({ ok: true, ...(await readingTime(String(b.comicId), b.seconds)) });
  });

  app.get('/api/vault/reading-stats', async function (c) {
    c.json({ ok: true, stats: await readingStats(cfgNow()) });
  });

  /* ---------- 备份 ---------- */
  app.get('/api/vault/backup', async function (c) {
    c.json({ ok: true, ...(await listBackups()) });
  });

  app.post('/api/vault/backup', async function (c) {
    const b = c.body || {};
    const r = await makeBackup(b.note);
    c.json({ ok: true, result: r, message: '已备份到 ' + r.file + '（约 ' + Math.round(r.bytes / 1024) + ' KB）' });
  });

  app.post('/api/vault/backup/restore', async function (c) {
    const b = c.body || {};
    const r = await restoreBackup(b.file, b.confirm);
    c.json({ ok: true, result: r, message: '已从 ' + r.from + ' 恢复 ' + r.count + ' 个数据文件' });
  });

  app.post('/api/vault/refresh', function (c) {
    invalidateCatalog();
    c.json({ ok: true, message: '目录视图缓存已失效，下次请求重新读取' });
  });

  app.get('/api/vault/health', async function (c) {
    const cat = await loadCatalog(cfgNow());
    const env = makeTagEnv();
    const noTag = cat.items.filter(function (x) { return effectiveNames(x, cfgNow(), env).length === 0; }).length;
    c.json({
      ok: true,
      catalog: { total: cat.items.length, indexed: cat.indexCount, extra: cat.extraCount },
      tags: { total: listTags().length, unused: (await tagStats(cfgNow())).unusedCount || 0 },
      comicsWithoutTags: noTag,
      roots: roots(cfgNow()).length
    });
  });
}

/** 审计归档内容的读取（不存在时给中文原因，不抛英文栈） */
async function readArchiveSafe(entryId) {
  const { readArchive } = await import('./ops/index.mjs');
  return readArchive(entryId);
}

export async function dispose() {
  try { await flushAll(); } catch (e) { /* 忽略 */ }
}
