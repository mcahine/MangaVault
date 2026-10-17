
import path from 'node:path';
import fsp from 'node:fs/promises';
import { roots, rootById, labelOf } from '../../../core/roots.mjs';
import { loadCatalog, findComic, findComicByDir, invalidateCatalog } from '../catalog.mjs';
import { META_FILE, META_BAK, tidySpaces, requireInsideRoot } from '../paths.mjs';
import { bad } from './_shared.mjs';
import { readJson } from '../../../core/util.mjs';
import { record, archiveBlob } from '../audit.mjs';
import { flushAll } from '../storage.mjs';

/**
 * 批量元数据：选中多部漫画，一次性改 作者 / 汉化组 / 描述 / 标签 / 分类。
 *
 * 沿用「先预演，后执行」的范式：
 *   planBatchMeta()  → 只读，算出每部会变成什么样、哪些没变化
 *   applyBatchMeta() → 先给每部写 元数据.json.bak，再写新文件，同时落审计归档（可一键撤销）
 *
 * 注意：这里**不**提供批量改标题。多部漫画共用一个标题是明确的用户事故，
 * 需要改标题请用单部的「编辑元数据」。
 */

const STRING_FIELDS = ['author', 'chineseTeam', 'description'];
const ARRAY_FIELDS = ['tags', 'categories'];
const MODES = ['merge', 'set', 'remove'];

function tidyArray(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const s = tidySpaces(raw);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** 归一化补丁：只保留认识的字段，非法输入直接报中文错误 */
export function normalizeMetaPatch(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const out = { fields: {}, arrays: {} };
  for (const k of STRING_FIELDS) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== 'string') throw bad(400, '字段「' + k + '」必须是字符串');
    out.fields[k] = tidySpaces(p[k]);
  }
  for (const k of ARRAY_FIELDS) {
    if (p[k] === undefined) continue;
    const raw = p[k];
    const mode = raw && typeof raw === 'object' && !Array.isArray(raw) ? String(raw.mode || 'merge') : 'merge';
    if (MODES.indexOf(mode) < 0) throw bad(400, '字段「' + k + '」的模式只能是 merge / set / remove');
    const values = tidyArray(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.values : raw);
    out.arrays[k] = { mode: mode, values: values };
  }
  if (!Object.keys(out.fields).length && !Object.keys(out.arrays).length) {
    throw bad(400, '没有要修改的字段（支持 author / chineseTeam / description / tags / categories）');
  }
  return out;
}

function mergedArray(oldList, patch) {
  const cur = tidyArray(oldList);
  if (patch.mode === 'set') return patch.values.slice();
  if (patch.mode === 'remove') {
    const drop = new Set(patch.values.map(function (s) { return s.toLowerCase(); }));
    return cur.filter(function (s) { return !drop.has(s.toLowerCase()); });
  }
  const out = cur.slice();
  const seen = new Set(out.map(function (s) { return s.toLowerCase(); }));
  for (const v of patch.values) {
    if (seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

function norm(normPatch, existing) {
  const next = Object.assign({}, existing);
  for (const k of Object.keys(normPatch.fields)) next[k] = normPatch.fields[k];
  for (const k of Object.keys(normPatch.arrays)) next[k] = mergedArray(existing[k], normPatch.arrays[k]);
  return next;
}

function textOf(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join('、');
  return String(v);
}

/** 逐字段差异（只报真正变化的，前端直接展示） */
function diffOf(before, after) {
  const keys = Array.from(new Set(Object.keys(before).concat(Object.keys(after))));
  const out = [];
  for (const k of keys) {
    const a = textOf(before[k]);
    const b = textOf(after[k]);
    if (a !== b) out.push({ field: k, from: a, to: b });
  }
  return out;
}

function absOfComic(cfg, c) {
  const root = rootById(cfg, c.rootId) || roots(cfg).find(function (r) { return r.path === c.root; }) || null;
  if (!root) return null;
  return { root: root, abs: path.join(root.path, c.dir) };
}

/** 预演：不写盘。返回 affected / unchanged / missing / skipped 四类 */
export async function planBatchMeta(cfg, comicIds, patch) {
  const normPatch = normalizeMetaPatch(patch);
  const ids = (Array.isArray(comicIds) ? comicIds : []).map(String).filter(Boolean);
  if (!ids.length) throw bad(400, '请选择至少一部漫画（comicIds 不能为空）');
  const cat = await loadCatalog(cfg);
  const items = [];
  const missing = [];
  const unchanged = [];
  const skipped = [];
  for (const id of ids) {
    const c = findComic(cat, id);
    if (!c) { missing.push({ comicId: id, reason: '漫画不存在（可能已被移动或删除）' }); continue; }
    const loc = absOfComic(cfg, c);
    if (!loc) { skipped.push({ comicId: c.id, dir: c.dir, reason: '找不到所属库根' }); continue; }
    try { requireInsideRoot(cfg, loc.abs, '漫画目录'); } catch (e) { skipped.push({ comicId: c.id, dir: c.dir, reason: '目录不在任何库根内' }); continue; }
    const exists = await fsp.stat(loc.abs).then(function () { return true; }).catch(function () { return false; });
    if (!exists) { skipped.push({ comicId: c.id, dir: c.dir, reason: '目录在磁盘上不存在' }); continue; }
    const before = (await readJson(path.join(loc.abs, META_FILE), null)) || {};
    const base = Object.assign({}, before);
    if (!base.title) base.title = c.title || c.dir;
    const after = norm(normPatch, base);
    const diff = diffOf(before, after);
    if (!diff.length) { unchanged.push({ comicId: c.id, dir: c.dir, title: c.title }); continue; }
    items.push({ comicId: c.id, dir: c.dir, title: c.title, rootId: c.rootId, rootName: labelOf(cfg, c.rootId), diff: diff, next: after, hasMeta: Boolean(before && Object.keys(before).length) });
  }
  return {
    dryRun: true,
    patch: normPatch,
    count: items.length,
    affected: items.length,
    unchangedCount: unchanged.length,
    missingCount: missing.length,
    skippedCount: skipped.length,
    items: items,
    unchanged: unchanged,
    missing: missing,
    skipped: skipped
  };
}

/** 执行：先备份 元数据.json.bak，再写新文件；旧内容归档进审计，可一键撤销 */
export async function applyBatchMeta(cfg, comicIds, patch, opts) {
  const o = opts || {};
  if (o.confirm !== true) throw bad(400, '执行批量元数据修改需要 confirm=true（请先看预演结果）');
  const plan = await planBatchMeta(cfg, comicIds, patch);
  if (!plan.count) return Object.assign({ applied: false }, plan, { backups: [], appliedCount: 0, failedCount: 0, failed: [] });

  const cat = await loadCatalog(cfg);
  const backups = [];
  const failed = [];
  const auditItems = [];
  for (const it of plan.items) {
    const c = findComic(cat, it.comicId);
    const loc = c ? absOfComic(cfg, c) : null;
    if (!c || !loc) { failed.push({ comicId: it.comicId, dir: it.dir, error: '漫画已不存在' }); continue; }
    const file = path.join(loc.abs, META_FILE);
    try {
      requireInsideRoot(cfg, loc.abs, '漫画目录');
      const before = await readJson(file, null);
      const beforeText = before && Object.keys(before).length ? JSON.stringify(before, null, 2) : null;
      // 归档永远先落盘：拿不到退路就不执行这一步
      const blob = beforeText ? await archiveBlob('meta-' + (c.dir || c.id) + '.json', beforeText) : null;
      if (beforeText) {
        const bak = path.join(loc.abs, META_BAK);
        await fsp.writeFile(bak + '.tmp', beforeText, 'utf8');
        await fsp.rename(bak + '.tmp', bak);
      }
      const next = Object.assign({}, before || {}, it.next);
      if (!next.id) next.id = c.id;
      if (!next.title) next.title = c.title || c.dir;
      if (!Array.isArray(next.tags)) next.tags = [];
      if (!Array.isArray(next.categories)) next.categories = [];
      await fsp.writeFile(file + '.tmp', JSON.stringify(next, null, 2), 'utf8');
      await fsp.rename(file + '.tmp', file);
      auditItems.push({ comicId: c.id, dir: c.dir, title: c.title, rootId: c.rootId, blob: blob });
      backups.push({ comicId: c.id, dir: c.dir, backup: META_BAK });
    } catch (err) {
      failed.push({ comicId: it.comicId, dir: it.dir, error: String((err && err.message) || err) });
    }
  }
  invalidateCatalog();
  const entry = await record({
    action: 'meta-edit',
    target: '批量元数据（' + auditItems.length + ' 部）',
    comicIds: plan.items.map(function (x) { return x.comicId; }),
    details: { batch: true, patch: plan.patch, items: auditItems },
    counts: { affected: auditItems.length, failed: failed.length, unchanged: plan.unchangedCount },
    reversible: auditItems.length > 0,
    message: '批量修改元数据：' + auditItems.length + ' 部'
  });
  await flushAll();
  return {
    applied: true, dryRun: false,
    appliedCount: auditItems.length, failedCount: failed.length, failed: failed,
    backups: backups, auditId: entry.id,
    affected: auditItems.length, unchangedCount: plan.unchangedCount, missingCount: plan.missingCount, skippedCount: plan.skippedCount
  };
}

/* ============================ 元数据导出 / 导入 ============================ */

function absByDir(cfg, c) {
  const root = rootById(cfg, c.rootId) || null;
  if (!root) return null;
  return path.join(root.path, c.dir);
}

function metaKey(m) {
  return [tidySpaces(m.title || '').toLowerCase(), tidySpaces(m.author || '').toLowerCase(), tidySpaces(m.chineseTeam || '').toLowerCase()].join('|');
}

/** 导出全部漫画的元数据（含派生标签与库根名，便于跨机识别） */
export async function exportMetaPayload(cfg, comicIds) {
  const cat = await loadCatalog(cfg);
  const want = Array.isArray(comicIds) && comicIds.length ? new Set(comicIds.map(String)) : null;
  const comics = [];
  for (const c of cat.items) {
    if (want && !want.has(c.id)) continue;
    const abs = absByDir(cfg, c);
    const meta = abs ? ((await readJson(path.join(abs, META_FILE), null)) || null) : null;
    comics.push({
      comicId: c.id, rootId: c.rootId, rootName: labelOf(cfg, c.rootId), dir: c.dir,
      title: c.title, author: c.author || '', chineseTeam: c.chineseTeam || '',
      tags: c.tags || [], categories: c.categories || [],
      description: c.description || '', hasMeta: Boolean(c.hasMeta),
      images: c.images, bytes: c.bytes, chapterCount: c.chapterCount,
      meta: meta
    });
  }
  return {
    app: 'MangaVault', kind: 'vault-comic-meta', version: 1,
    exportedAt: new Date().toISOString(),
    roots: roots(cfg).map(function (r) { return { id: r.id, name: r.name, path: r.path }; }),
    count: comics.length,
    comics: comics
  };
}

/**
 * 导入元数据。匹配顺序：comicId → 库根名+目录名 → 标题。
 * 匹配不上的条目按 skipUnmatched 决定是跳过还是报错（默认跳过并逐条说明）。
 */
export async function importMetaPayload(cfg, payload, opts) {
  const o = opts || {};
  const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.comics) ? payload.comics : null);
  if (!list) throw bad(400, '导入内容必须是 { comics: [...] } 或漫画数组');
  const dry = o.confirm !== true;
  const cat = await loadCatalog(cfg);
  const plan = [];
  const unmatched = [];
  const invalid = [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') { invalid.push('忽略非对象条目'); continue; }
    let c = raw.comicId ? findComic(cat, String(raw.comicId)) : null;
    if (!c && raw.dir) {
      const rid = raw.rootId || roots(cfg).find(function (r) { return r.name === raw.rootName; });
      c = findComicByDir(cat, rid && rid.id ? rid.id : rid, raw.dir);
      if (!c) c = findComicByDir(cat, null, raw.dir);
    }
    if (!c && raw.title) {
      const hit = cat.items.filter(function (x) { return tidySpaces(x.title) === tidySpaces(raw.title) || metaKey({ title: x.title, author: '', chineseTeam: '' }) === metaKey(raw); });
      if (hit.length === 1) c = hit[0];
      else if (hit.length > 1) { invalid.push('标题「' + raw.title + '」匹配到 ' + hit.length + ' 部，跳过以免改错'); continue; }
    }
    if (!c) { unmatched.push({ dir: raw.dir || '', title: raw.title || raw.comicId || '(无标题)', reason: '当前库里找不到对应的漫画' }); continue; }
    const abs = absByDir(cfg, c);
    if (!abs) { invalid.push('「' + (c.title || c.dir) + '」找不到所属库根'); continue; }
    const before = (await readJson(path.join(abs, META_FILE), null)) || {};
    const next = Object.assign({}, before);
    if (raw.title !== undefined) next.title = tidySpaces(raw.title) || next.title || c.title;
    if (raw.author !== undefined) next.author = tidySpaces(raw.author);
    if (raw.chineseTeam !== undefined) next.chineseTeam = tidySpaces(raw.chineseTeam);
    if (raw.description !== undefined) next.description = String(raw.description);
    if (raw.tags !== undefined) next.tags = tidyArray(raw.tags);
    if (raw.categories !== undefined) next.categories = tidyArray(raw.categories);
    if (!next.id) next.id = c.id;
    if (!next.title) next.title = c.title || c.dir;
    if (!Array.isArray(next.tags)) next.tags = [];
    if (!Array.isArray(next.categories)) next.categories = [];
    if (!dry && o.mode === 'skip' && Object.keys(before).length) { invalid.push('「' + c.title + '」已有元数据，按 skip 策略跳过'); continue; }
    const diff = diffOf(before, next);
    if (!diff.length) continue;
    plan.push({ comicId: c.id, dir: c.dir, title: c.title, rootId: c.rootId, diff: diff, next: next });
  }

  if (dry) {
    return {
      dryRun: true, count: plan.length, items: plan,
      unmatched: unmatched, invalid: invalid,
      unchangedCount: list.length - plan.length - unmatched.length - invalid.length
    };
  }

  const failed = [];
  const auditItems = [];
  const backups = [];
  for (const it of plan) {
    try {
      const c = findComic(cat, it.comicId);
      const abs = c ? absByDir(cfg, c) : null;
      if (!c || !abs) { failed.push({ dir: it.dir, error: '漫画已不存在' }); continue; }
      requireInsideRoot(cfg, abs, '漫画目录');
      const file = path.join(abs, META_FILE);
      const before = await readJson(file, null);
      const beforeText = before && Object.keys(before).length ? JSON.stringify(before, null, 2) : null;
      const blob = beforeText ? await archiveBlob('import-' + (c.dir || c.id) + '.json', beforeText) : null;
      if (beforeText) {
        const bak = path.join(abs, META_BAK);
        await fsp.writeFile(bak + '.tmp', beforeText, 'utf8');
        await fsp.rename(bak + '.tmp', bak);
      }
      await fsp.writeFile(file + '.tmp', JSON.stringify(it.next, null, 2), 'utf8');
      await fsp.rename(file + '.tmp', file);
      auditItems.push({ comicId: c.id, dir: c.dir, title: c.title, rootId: c.rootId, blob: blob });
      backups.push({ comicId: c.id, dir: c.dir, backup: META_BAK });
    } catch (err) {
      failed.push({ dir: it.dir, error: String((err && err.message) || err) });
    }
  }
  invalidateCatalog();
  const entry = await record({
    action: 'meta-import',
    target: '导入元数据（' + auditItems.length + ' 部）',
    comicIds: plan.map(function (x) { return x.comicId; }),
    details: { items: auditItems, unmatched: unmatched },
    counts: { imported: auditItems.length, failed: failed.length, unmatched: unmatched.length },
    reversible: auditItems.length > 0,
    message: '导入元数据：' + auditItems.length + ' 部'
  });
  await flushAll();
  return {
    applied: true, dryRun: false, imported: auditItems.length, failed: failed, failedCount: failed.length,
    unmatched: unmatched, invalid: invalid, backups: backups, auditId: entry.id, count: plan.length
  };
}
