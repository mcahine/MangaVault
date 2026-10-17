
import path from 'node:path';
import fsp from 'node:fs/promises';
import { dataDir, dataPath } from '../../../core/config.mjs';
import { roots } from '../../../core/roots.mjs';
import { readLibraryIndex } from '../../../core/library-index.mjs';
import { loadCatalog, invalidateCatalog } from '../catalog.mjs';
import { trashStore, touchTrash, flushAll } from '../storage.mjs';
import { trashComics } from './trash.mjs';
import { stamp } from '../paths.mjs';
import { bad } from './_shared.mjs';
import { record } from '../audit.mjs';

/**
 * 孤儿清理。
 *
 * 三类孤儿：
 *   1) disk-only  ：磁盘上有目录，索引里没有（例如手工拷进来的漫画、索引过期）
 *   2) index-only ：索引里有，磁盘上没了（改名/删除后没重扫 → 幽灵条目，会让统计虚高）
 *   3) trash-missing：回收站清单里有，回收站里的文件却没了
 *
 * 清理策略（一律先留退路）：
 *   · 幽灵条目 → 先备份索引文件，再触发重扫，让索引与磁盘一致
 *   · 磁盘孤立目录 → **移入回收站**（不是删除），随时可还原
 *   · 回收站丢文件的条目 → 只从清单里摘掉（文件本来就不在了，不存在误删）
 */

async function exists(p) {
  return fsp.stat(p).then(function () { return true; }).catch(function () { return false; });
}

function trashDir() { return path.join(dataDir(), 'vault-trash'); }

/** 扫描孤儿；纯只读 */
export async function scanOrphans(cfg) {
  const cat = await loadCatalog(cfg, { force: true });
  const idx = await readLibraryIndex(true);
  const list = roots(cfg);

  const diskOnly = [];
  for (const c of cat.items) {
    if (c.indexed) continue;
    diskOnly.push({ comicId: c.id, dir: c.dir, title: c.title, rootId: c.rootId, rootName: c.rootName, hasMeta: c.hasMeta, images: c.images, bytes: c.bytes, kind: 'disk-only', reason: '磁盘上有这个目录，但索引里没有它' });
  }

  const indexOnly = [];
  for (const raw of (idx.comics || [])) {
    const dirName = String(raw.dir || '');
    if (!dirName) continue;
    let foundIn = null;
    for (const r of list) {
      if (!r.enabled) continue;
      if (await exists(path.join(r.path, dirName))) { foundIn = r.id; break; }
    }
    // 磁盘上找得到就不是幽灵条目（只是索引里 root 字段过期），不报
    if (foundIn) continue;
    indexOnly.push({
      dir: dirName, title: raw.title || dirName, root: raw.root || null,
      images: raw.images || 0, bytes: raw.bytes || 0, kind: 'index-only',
      reason: '索引里有这本，磁盘上却找不到目录（改名或删除后没有重扫）'
    });
  }

  const trashMissing = [];
  for (const it of (trashStore().data.items || [])) {
    const abs = path.join(trashDir(), it.trashPath || '');
    if (await exists(abs)) continue;
    trashMissing.push({ trashPath: it.trashPath || '', comicId: it.comicId || null, dir: it.dir, title: it.title || it.dir, at: it.at || null, kind: 'trash-missing', reason: '回收站清单里有，但回收站里的文件已经不在了' });
  }

  /* 按库根汇总。用途见 cleanOrphans 护栏 2：某个根「一部都没进索引」时，
     它的 disk-only 不是孤儿，而是「索引还没建立」，清理必须跳过。 */
  const byRoot = list.map(function (r) {
    const mine = cat.items.filter(function (c) { return c.rootId === r.id; });
    const indexed = mine.filter(function (c) { return c.indexed; }).length;
    return {
      rootId: r.id, rootName: r.name || r.id, enabled: Boolean(r.enabled),
      comics: mine.length, indexed: indexed, diskOnly: mine.length - indexed
    };
  });

  return {
    scannedAt: new Date().toISOString(),
    indexScannedAt: (idx && idx.scannedAt) || null,
    catalog: { comics: cat.items.length, indexed: cat.indexCount, extra: cat.extraCount },
    indexCount: (idx.comics || []).length,
    byRoot: byRoot,
    counts: { diskOnly: diskOnly.length, indexOnly: indexOnly.length, trashMissing: trashMissing.length, total: diskOnly.length + indexOnly.length + trashMissing.length },
    diskOnly: diskOnly,
    indexOnly: indexOnly,
    trashMissing: trashMissing
  };
}

/** 备份索引文件（清理前留退路），返回备份文件名 */
async function backupIndex() {
  const src = dataPath('library-index.json');
  if (!(await exists(src))) return null;
  const box = path.join(dataDir(), 'backups');
  await fsp.mkdir(box, { recursive: true });
  const name = 'library-index-orphan-' + stamp() + '.json';
  await fsp.copyFile(src, path.join(box, name));
  return name;
}

/** 触发一次库重扫（走 library 模块已验证的接口，不重复实现扫描逻辑） */
export async function triggerRescan(cfg) {
  const port = Number(cfg && cfg.port) || 8775;
  let res = null;
  let body = null;
  try {
    res = await fetch('http://127.0.0.1:' + port + '/api/library/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    body = await res.json().catch(function () { return null; });
  } catch (e) {
    throw bad(503, '无法触发库扫描（后端未就绪）：' + String((e && e.message) || e));
  }
  if (!res.ok || !body || body.ok !== true) {
    throw bad(res.status === 409 ? 409 : 500, '触发扫描失败：' + ((body && body.error) || ('HTTP ' + res.status)));
  }
  return { scanning: true, roots: body.roots || [] };
}

/** 读取库扫描状态（走 library 模块接口）。返回 null 表示「无法确认」。 */
async function libraryState(cfg) {
  const port = Number(cfg && cfg.port) || 8775;
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/library/state', { method: 'GET' });
    if (!res.ok) return null;
    const body = await res.json().catch(function () { return null; });
    return body && body.ok ? body : null;
  } catch (e) {
    return null;
  }
}

/**
 * 执行清理。confirm=true 才动手。
 * opts { parts: { diskOnly?, indexOnly?, trashMissing? }, confirm, note }
 * 每一步单独 try/catch：一步失败不影响其它步，失败原因如实回给用户。
 */
export async function cleanOrphans(cfg, opts) {
  const o = opts || {};
  if (o.confirm !== true) throw bad(400, '孤儿清理需要 confirm=true');
  const parts = o.parts || {};
  const doDisk = parts.diskOnly !== false;
  const doIndex = parts.indexOnly !== false;
  const doTrash = parts.trashMissing !== false;

  /* 护栏 1：扫描进行中不「搬目录」。
     为什么必须有：catalog 的目录兜底让「索引还没落盘」和「磁盘孤立」长得一模一样。
     库根刚加好、扫描还没结束时清理，整个库根的正常漫画都会被判成 disk-only
     并 rename 进回收站（审计已实测复现：150/150 部被搬走，报告 before.counts.diskOnly=150）。

     ★ 范围很关键：只挡「搬目录」这一步。幽灵条目重扫（indexOnly）与回收站摘除
     （trashMissing）都不动用户漫画，是安全的 —— 早先把扫描状态做成整个函数早退，
     结果把安全操作也一起挡了，测试里「重扫后不再有孤儿」直接失败。 */
  const st = await libraryState(cfg);
  const scanning = Boolean(st && st.scanning);

  const before = await scanOrphans(cfg);
  if (!before.counts.total) {
    return { applied: false, reason: 'empty', before: before, after: before, report: {}, backups: [], message: '没有发现孤儿条目' };
  }

  /* 护栏 2：某个库根一部都没进索引 → 它的 disk-only 是「尚未索引」，不是孤儿。
     新加的库根、或索引被清空后首次扫描前，都属于这一类，一律跳过并在报告里说明。 */
  const unindexed = new Set((before.byRoot || []).filter(function (r) {
    return r.enabled && r.diskOnly > 0 && r.indexed === 0;
  }).map(function (r) { return r.rootId; }));
  const diskTargets = before.diskOnly.filter(function (x) { return !unindexed.has(x.rootId); });
  const diskSkipped = before.diskOnly.filter(function (x) { return unindexed.has(x.rootId); });

  const report = { diskOnly: null, indexOnly: null, trashMissing: null, errors: [], backups: [] };

  if (doIndex && before.indexOnly.length && o.skipRescan !== true) {
    try {
      const bak = await backupIndex();
      if (bak) report.backups.push(bak);
      report.indexOnly = Object.assign(await triggerRescan(cfg), { backedUpIndex: bak, ghostCount: before.indexOnly.length });
    } catch (err) {
      report.errors.push('幽灵条目处理失败：' + String((err && err.message) || err));
    }
  }

  if (doDisk && scanning) {
    report.diskOnlyBlocked = {
      reason: 'scanning',
      message: '漫画库正在扫描，本次未搬动任何目录（扫描期间索引还没落盘，正常漫画会被误判成孤儿）。请等扫描结束后重新清理。'
    };
  } else if (doDisk && diskTargets.length) {
    /* 护栏 3：动手前再复核一次。快照与此刻不一致（例如索引刚好落盘、或磁盘又变了）
       就中止磁盘清理 —— 破坏性操作宁可少做一次，也不能按过期快照搬库。 */
    const recheck = await scanOrphans(cfg);
    const nowIds = recheck.diskOnly.map(function (x) { return x.comicId; }).sort().join(',');
    const wasIds = diskTargets.map(function (x) { return x.comicId; }).sort().join(',');
    if (nowIds !== wasIds) {
      report.errors.push('动手前复核发现磁盘/索引状态已变化（可能索引刚落盘），已中止磁盘清理，请重新扫描孤儿');
    } else {
      try {
        report.diskOnly = await trashComics(cfg, diskTargets.map(function (x) { return x.comicId; }), o.note || '孤儿清理：磁盘上存在但索引里没有');
      } catch (err) {
        report.errors.push('磁盘孤立目录移入回收站失败：' + String((err && err.message) || err));
      }
    }
  }
  if (diskSkipped.length) {
    report.skippedUnindexed = {
      count: diskSkipped.length,
      roots: Array.from(unindexed),
      note: '这些库根一部都没进索引，判为「尚未索引」而非孤儿，本次未处理'
    };
  }

  if (doTrash && before.trashMissing.length) {
    try {
      const keys = new Set(before.trashMissing.map(function (x) { return x.trashPath; }));
      const st = trashStore();
      const keep = (st.data.items || []).filter(function (it) { return !keys.has(it.trashPath || ''); });
      const dropped = (st.data.items || []).length - keep.length;
      st.data.items = keep;
      st.data.updatedAt = new Date().toISOString();
      touchTrash();
      await flushAll();
      report.trashMissing = { dropped: dropped };
    } catch (err) {
      report.errors.push('回收站失联条目摘除失败：' + String((err && err.message) || err));
    }
  }

  invalidateCatalog();
  const after = await scanOrphans(cfg);
  const entry = await record({
    action: 'orphan-clean',
    target: '孤儿清理',
    details: {
      before: before.counts,
      after: after.counts,
      movedToTrash: before.diskOnly.map(function (x) { return { comicId: x.comicId, dir: x.dir, title: x.title }; }),
      indexOnly: before.indexOnly.map(function (x) { return { dir: x.dir, title: x.title }; }),
      trashMissing: before.trashMissing.map(function (x) { return { trashPath: x.trashPath, dir: x.dir }; }),
      backups: report.backups,
      indexBackup: report.backups.length ? report.backups[0] : null,
      rescan: report.indexOnly,
      errors: report.errors
    },
    // 注意：报告里的计数只算「真的动手处理过」的，skipRescan 时不要把没清的说成清了
    counts: {
      diskOnly: report.diskOnly ? diskTargets.length : 0,
      indexOnly: report.indexOnly ? before.indexOnly.length : 0,
      trashMissing: report.trashMissing ? before.trashMissing.length : 0
    },
    // 磁盘孤立目录已进回收站可还原，但「清索引」与「回收站清单摘除」不可逆，
    // 所以整条审计标记为不可撤销 —— 绝不假装它能一键回滚。
    reversible: false,
    message: '孤儿清理：磁盘孤立 ' + before.diskOnly.length + ' 部 / 幽灵条目 ' + before.indexOnly.length + ' 条 / 回收站失联 ' + before.trashMissing.length + ' 条'
  });
  await flushAll();

  return {
    applied: true, before: before, after: after, report: report, auditId: entry.id,
    backups: report.backups,
    message: '清理完成：磁盘孤立 ' + before.diskOnly.length + ' 部已移入回收站（可还原），幽灵条目 ' + before.indexOnly.length + ' 条已触发重扫，回收站失联 ' + before.trashMissing.length + ' 条已摘除'
  };
}

export function orphanBackupDir() { return path.join(dataDir(), 'backups'); }