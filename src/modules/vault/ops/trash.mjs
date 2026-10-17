
import path from 'node:path';
import fsp from 'node:fs/promises';
import { dataDir } from '../../../core/config.mjs';
import { rootById } from '../../../core/roots.mjs';
import { safeJoin } from '../../../core/util.mjs';
import { loadCatalog, findComic, invalidateCatalog } from '../catalog.mjs';
import { sanitizeDirName, stamp, requireInsideRoot } from '../paths.mjs';
import { trashStore, touchTrash, flushAll } from '../storage.mjs';
import { bad } from './_shared.mjs';
import { record } from '../audit.mjs';

/* ---------------- 04 回收站 ---------------- */
function trashRootDir() { return path.join(dataDir(), 'vault-trash'); }

export async function trashComics(cfg, comicIds, note) {
  const cat = await loadCatalog(cfg);
  const batch = stamp() + '-' + Math.random().toString(36).slice(2, 6);
  const dest = path.join(trashRootDir(), batch);
  await fsp.mkdir(dest, { recursive: true });
  const moved = [], failed = [];
  for (const id of (comicIds || []).map(String)) {
    const c = findComic(cat, id);
    if (!c) { failed.push({ id: id, error: '漫画不存在' }); continue; }
    const root = rootById(cfg, c.rootId);
    if (!root) { failed.push({ id: id, error: '库根不存在' }); continue; }
    const abs = safeJoin(root.path, c.dir);
    try {
      requireInsideRoot(cfg, abs, '漫画目录');
      const box = path.join(dest, root.id);
      await fsp.mkdir(box, { recursive: true });
      const target = path.join(box, sanitizeDirName(c.dir, c.id));
      await fsp.rename(abs, target);
      moved.push({ comicId: c.id, title: c.title, rootId: root.id, dir: c.dir, bytes: c.bytes, images: c.images, trashPath: path.relative(trashRootDir(), target).split(path.sep).join('/'), batch: batch });
    } catch (err) {
      failed.push({ id: id, title: c.title, error: String(err.message || err) });
    }
  }
  if (moved.length) {
    const st = trashStore();
    st.data.items = (st.data.items || []).concat(moved.map(function (m) {
      return Object.assign({}, m, { at: new Date().toISOString(), note: note || '' });
    }));
    st.data.updatedAt = new Date().toISOString();
    touchTrash();
    await flushAll();
  }
  invalidateCatalog();
  const audit = await record({
    action: 'trash-applied',
    target: '移入回收站',
    comicIds: moved.map(function (m) { return m.comicId; }),
    details: { batch: batch, note: note || '', items: moved.map(function (m) { return { comicId: m.comicId, title: m.title, dir: m.dir, rootId: m.rootId, trashPath: m.trashPath, bytes: m.bytes, images: m.images }; }), trashPaths: moved.map(function (m) { return m.trashPath; }) },
    counts: { moved: moved.length, failed: failed.length },
    reversible: moved.length > 0,   // 回收站里的东西可以还原回原位
    message: '移入回收站 ' + moved.length + ' 部'
  });
  await flushAll();
  return { moved: moved.length, failed: failed, batch: batch, items: moved, auditId: audit.id, reversible: moved.length > 0 };
}

export async function listTrash() {
  const st = trashStore();
  const items = (st.data.items || []).slice().reverse();
  const out = [];
  for (const it of items) {
    const abs = path.join(trashRootDir(), it.trashPath);
    const exists = await fsp.stat(abs).then(function () { return true; }).catch(function () { return false; });
    out.push(Object.assign({}, it, { exists: exists }));
  }
  return { items: out, count: out.length, bytes: out.reduce(function (n, x) { return n + (Number(x.bytes) || 0); }, 0) };
}

export async function restoreTrash(cfg, ids) {
  const st = trashStore();
  const want = new Set((ids || []).map(String));
  const keep = [];
  const restored = [], failed = [];
  for (const it of (st.data.items || [])) {
    const key = it.trashPath || it.comicId;
    if (want.size && !want.has(key) && !want.has(String(it.comicId))) { keep.push(it); continue; }
    const root = rootById(cfg, it.rootId);
    if (!root) { failed.push({ dir: it.dir, error: '库根已不存在：' + it.rootId }); keep.push(it); continue; }
    const fromAbs = path.join(trashRootDir(), it.trashPath);
    const toAbs = safeJoin(root.path, it.dir);
    try {
      if (await fsp.stat(toAbs).then(function () { return true; }).catch(function () { return false; })) {
        failed.push({ dir: it.dir, error: '原位置已被占用，未覆盖' });
        keep.push(it);
        continue;
      }
      await fsp.mkdir(path.dirname(toAbs), { recursive: true });
      await fsp.rename(fromAbs, toAbs);
      restored.push(it);
    } catch (err) {
      failed.push({ dir: it.dir, error: String(err.message || err) });
      keep.push(it);
    }
  }
  st.data.items = keep;
  st.data.updatedAt = new Date().toISOString();
  touchTrash();
  await flushAll();
  invalidateCatalog();
  const audit = await record({
    action: 'trash-restored',
    target: '从回收站还原',
    comicIds: restored.map(function (it) { return it.comicId; }),
    details: { items: restored.map(function (it) { return { comicId: it.comicId, title: it.title, dir: it.dir, rootId: it.rootId, batch: it.batch, bytes: it.bytes, images: it.images }; }) },
    counts: { restored: restored.length, failed: failed.length },
    reversible: restored.length > 0,   // 撤销 = 重新移回回收站
    message: '从回收站还原 ' + restored.length + ' 部'
  });
  await flushAll();
  return { restored: restored.length, failed: failed, items: restored, auditId: audit.id, reversible: restored.length > 0 };
}

export async function purgeTrash(ids, confirm) {
  if (String(confirm || '').trim().toUpperCase() !== 'DELETE') throw bad(400, '永久删除需要 confirm=DELETE');
  const st = trashStore();
  const want = new Set((ids || []).map(String));
  const keep = [];
  const purged = [], failed = [];
  for (const it of (st.data.items || [])) {
    const key = it.trashPath || it.comicId;
    if (want.size && !want.has(key) && !want.has(String(it.comicId))) { keep.push(it); continue; }
    const abs = path.join(trashRootDir(), it.trashPath);
    if (!path.resolve(abs).startsWith(path.resolve(trashRootDir()))) { failed.push({ dir: it.dir, error: '路径越界' }); keep.push(it); continue; }
    try { await fsp.rm(abs, { recursive: true, force: true }); purged.push(it); }
    catch (err) { failed.push({ dir: it.dir, error: String(err.message || err) }); keep.push(it); }
  }
  st.data.items = keep;
  st.data.updatedAt = new Date().toISOString();
  touchTrash();
  await flushAll();
  // 永久删除是不可逆的：审计里如实标注 reversible=false，绝不假装能撤销
  await record({
    action: 'trash-purge',
    target: '永久删除回收站内容',
    comicIds: purged.map(function (it) { return it.comicId; }),
    details: { items: purged.map(function (it) { return { comicId: it.comicId, title: it.title, dir: it.dir, rootId: it.rootId, bytes: it.bytes }; }) },
    counts: { purged: purged.length, failed: failed.length },
    reversible: false,
    message: '永久删除 ' + purged.length + ' 部（不可恢复）'
  });
  await flushAll();
  return { purged: purged.length, failed: failed, items: purged, reversible: false };
}
