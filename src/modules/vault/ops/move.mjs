
import path from 'node:path';
import fsp from 'node:fs/promises';
import { safeJoin } from '../../../core/util.mjs';
import { rootById } from '../../../core/roots.mjs';
import { loadCatalog, findComic, invalidateCatalog } from '../catalog.mjs';
import { requireInsideRoot, sanitizeDirName } from '../paths.mjs';
import { flushAll } from '../storage.mjs';
import { record } from '../audit.mjs';
import { bad } from './_shared.mjs';

/* ---------------- 03 库根之间移动 ---------------- */
const COLLISION = ['error', 'skip', 'rename'];

async function exists(p) {
  return fsp.stat(p).then(function () { return true; }).catch(function () { return false; });
}

/** 目标被占用时按策略找新名字（rename 策略），找不到就抛错 */
async function pickName(dir, i) {
  const cand = sanitizeDirName(dir) + ' (搬迁' + (i > 1 ? ' ' + i : '') + ')';
  return cand;
}

function sameVolume(a, b) {
  return path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase();
}

/**
 * 跨库根搬迁。collecion 策略 options.collision = error | skip | rename（默认 error，绝不覆盖）。
 * 不传 confirm 就是预演：把「会搬到哪、哪些有重名、哪些跨盘」全部列出来。
 */
export async function moveToRoot(cfg, comicIds, targetRootId, options) {
  const o = options || {};
  const dry = o.confirm !== true;
  const collision = COLLISION.indexOf(String(o.collision || 'error')) >= 0 ? String(o.collision || 'error') : 'error';
  const cat = await loadCatalog(cfg);
  const target = rootById(cfg, targetRootId);
  if (!target) throw bad(404, '目标库根不存在：' + targetRootId);
  if (!(await exists(target.path))) throw bad(400, '目标库根目录在磁盘上不存在：' + target.path);
  const ids = (Array.isArray(comicIds) ? comicIds : []).map(String).filter(Boolean);
  if (!ids.length) throw bad(400, '请选择要搬迁的漫画（comicIds 不能为空）');

  const items = [];
  const skipped = [];
  const missing = [];
  const reserved = new Set();
  for (const id of ids) {
    const c = findComic(cat, id);
    if (!c) { missing.push({ comicId: id, reason: '漫画不存在' }); continue; }
    if (c.rootId === targetRootId) { skipped.push({ comicId: c.id, dir: c.dir, title: c.title, reason: '已经在目标库根里' }); continue; }
    const fromRoot = rootById(cfg, c.rootId);
    if (!fromRoot) { skipped.push({ comicId: c.id, dir: c.dir, title: c.title, reason: '原库根不存在：' + c.rootId }); continue; }
    const fromAbs = safeJoin(fromRoot.path, c.dir);
    const toAbs = safeJoin(target.path, c.dir);
    try {
      requireInsideRoot(cfg, fromAbs, '源路径');
      requireInsideRoot(cfg, toAbs, '目标路径');
    } catch (err) {
      skipped.push({ comicId: c.id, dir: c.dir, title: c.title, reason: '路径越界，拒绝搬迁' });
      continue;
    }
    const conflict = (await exists(toAbs)) || reserved.has(toAbs.toLowerCase());
    let destDir = c.dir;
    if (conflict) {
      if (collision === 'error') {
        skipped.push({ comicId: c.id, dir: c.dir, title: c.title, reason: '目标库里已有同名目录：' + c.dir });
        continue;
      }
      if (collision === 'skip') { skipped.push({ comicId: c.id, dir: c.dir, title: c.title, reason: '目标同名，按 skip 策略跳过' }); continue; }
      let picked = null;
      for (let i = 1; i <= 99; i++) {
        const cand = await pickName(c.dir, i);
        if (cand === c.dir) continue;
        if (!(await exists(safeJoin(target.path, cand))) && !reserved.has(safeJoin(target.path, cand).toLowerCase())) { picked = cand; break; }
      }
      if (!picked) { skipped.push({ comicId: c.id, dir: c.dir, title: c.title, reason: '重名太多，自动改名失败' }); continue; }
      destDir = picked;
    }
    reserved.add(safeJoin(target.path, destDir).toLowerCase());
    const st = await fsp.stat(fromAbs).catch(function () { return null; });
    if (!st || !st.isDirectory()) { missing.push({ comicId: c.id, dir: c.dir, reason: '源目录在磁盘上不存在' }); continue; }
    items.push({
      comicId: c.id, dir: c.dir, destDir: destDir, title: c.title,
      fromRootId: fromRoot.id, fromRootName: fromRoot.name || fromRoot.id,
      fromPath: fromRoot.path, toPath: target.path, toRootId: target.id, toRootName: target.name || target.id,
      fromAbs: fromAbs, toAbs: safeJoin(target.path, destDir),
      crossDevice: !sameVolume(fromAbs, safeJoin(target.path, destDir)),
      bytes: Number(c.bytes) || 0, images: Number(c.images) || 0
    });
  }

  const preflight = {
    dryRun: true,
    targetRoot: { id: target.id, name: target.name, path: target.path },
    collision: collision,
    count: items.length,
    affectedComics: items.length,
    crossDeviceCount: items.filter(function (x) { return x.crossDevice; }).length,
    conflictCount: items.filter(function (x) { return x.destDir !== x.dir; }).length,
    renamedCount: items.filter(function (x) { return x.destDir !== x.dir; }).length,
    skipped: skipped,
    missing: missing,
    items: items.map(function (x) {
      return {
        comicId: x.comicId, title: x.title, dir: x.dir, destDir: x.destDir,
        from: x.fromPath, to: x.toPath, crossDevice: x.crossDevice, bytes: x.bytes, images: x.images
      };
    })
  };
  if (dry) return Object.assign({ applied: false }, preflight);
  if (!items.length) return Object.assign({}, preflight, { applied: false, moved: 0, failed: [], skipped: skipped, missing: missing });

  const done = [];
  const failed = [];
  for (const it of items) {
    const tmpBox = it.crossDevice ? path.join(it.toPath, '.mv-move-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)) : null;
    let copied = false;
    try {
      const finalAbs = path.join(it.toPath, it.destDir);
      if (it.crossDevice) {
        // 跨盘：先整目录复制到临时名，确认无误后再改名为目标名，最后删源
        await fsp.mkdir(tmpBox, { recursive: true });
        const staging = path.join(tmpBox, it.destDir);
        await fsp.cp(it.fromAbs, staging, { recursive: true });
        copied = true;
        await fsp.rename(staging, finalAbs);
        await fsp.rm(it.fromAbs, { recursive: true, force: true });
      } else {
        await fsp.rename(it.fromAbs, finalAbs);
      }
      done.push({
        comicId: it.comicId, title: it.title, dir: it.dir, destDir: it.destDir,
        fromRootId: it.fromRootId, toRootId: it.toRootId, toPath: it.toPath,
        crossDevice: it.crossDevice, bytes: it.bytes, images: it.images
      });
    } catch (err) {
      failed.push({ comicId: it.comicId, dir: it.dir, error: String((err && err.message) || err) });
    } finally {
      if (tmpBox) { try { await fsp.rm(tmpBox, { recursive: true, force: true }); } catch (e) { /* 清理临时目录失败不阻断 */ } }
      void copied;
    }
  }
  invalidateCatalog();
  const entry = await record({
    action: 'move-to-root',
    target: '跨库根搬迁 → ' + (target.name || target.id),
    comicIds: done.map(function (x) { return x.comicId; }),
    details: {
      targetRootId: target.id, targetRootName: target.name || target.id, targetPath: target.path,
      items: done.map(function (x) {
        return { comicId: x.comicId, title: x.title, dir: x.dir, destDir: x.destDir, fromRootId: x.fromRootId, toRootId: x.toRootId, toPath: x.toPath };
      })
    },
    counts: { moved: done.length, failed: failed.length, skipped: skipped.length },
    reversible: done.length > 0,
    message: '搬迁 ' + done.length + ' 部到「' + (target.name || target.id) + '」'
  });
  await flushAll();
  return {
    applied: true, dryRun: false, moved: done.length, failed: failed, failedCount: failed.length,
    skipped: skipped, missing: missing, conflictCount: preflight.conflictCount,
    targetRoot: preflight.targetRoot, details: done, auditId: entry.id, reversible: done.length > 0
  };
}
