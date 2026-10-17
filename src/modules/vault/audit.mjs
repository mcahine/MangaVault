
import path from 'node:path';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { dataDir } from '../../core/config.mjs';
import { readJson } from '../../core/util.mjs';
import { auditStore, touchAudit, flushAll } from './storage.mjs';

/**
 * 操作审计日志 + 撤销。
 *
 * 设计要点：
 *   1）只记「真正改动过磁盘或数据文件」的操作。预演（dryRun）不记，失败也不记成成功。
 *   2）破坏性操作必须先有退路才允许执行：
 *        - meta-edit / tag-assign / rename / move / trash 都能撤销（reversible=true）；
 *        - trash-purge（永久删除）与 orphan-clean（清索引/清空条目）不可撤销，
 *          必须在前端二次确认；其中 orphan-clean 只清索引，不动磁盘文件。
 *   3）撤销需要「操作前的旧内容」。旧内容一律落盘到 data/vault-audit/，
 *      不塞进 JSON 里，避免审计文件无限膨胀。
 *   4）只保留最近 MAX_ENTRIES 条；被挤出日志的条目连带删除它的归档文件。
 */

const MAX_ENTRIES = 300;
const AUDIT_ACTION_LABEL = {
  'rename': '重命名目录',
  'move-to-root': '跨库根搬迁',
  'meta-edit': '修改元数据',
  'tag-assign': '批量打标签',
  'trash-applied': '移入回收站',
  'trash-restored': '从回收站还原',
  'trash-purge': '永久删除',
  'orphan-clean': '孤儿清理',
  'meta-import': '导入元数据',
  'undo': '撤销'
};

function auditRoot() { return path.join(dataDir(), 'vault-audit'); }

export function auditActionLabel(action) {
  return AUDIT_ACTION_LABEL[action] || String(action || '未知操作');
}

/** 审计归档目录的绝对路径（前端「查看」按钮与排查用） */
export function auditDir() { return auditRoot(); }

function newId() {
  return 'au-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

/**
 * 把「操作前的旧内容」写进归档目录，返回归档文件相对路径。
 * 失败时抛错 —— 宁可不执行，也不要执行了一个撤不回来的操作。
 */
export async function archiveBlob(name, text) {
  const dir = auditRoot();
  await fsp.mkdir(dir, { recursive: true });
  const safe = String(name || 'blob').replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').slice(0, 60);
  const file = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '-' + safe;
  await fsp.writeFile(path.join(dir, file + '.tmp'), String(text), 'utf8');
  await fsp.rename(path.join(dir, file + '.tmp'), path.join(dir, file));
  return file;
}

export async function readBlobText(blob) {
  const rel = String(blob || '');
  if (!rel || rel.indexOf('..') >= 0 || /[\\/]/.test(rel)) throw new Error('归档文件名不合法');
  return fsp.readFile(path.join(auditRoot(), rel), 'utf8');
}

/** 归档文件还是不是 JSON 对象（撤销前用它判断旧元数据是否可解析） */
export async function readBlobJson(blob) {
  const text = await readBlobText(blob);
  try { return JSON.parse(text); } catch (e) { throw new Error('归档内容不是合法 JSON，撤销已中止'); }
}

async function pruneBlobs() {
  const used = new Set();
  for (const e of auditStore().data.entries) for (const f of (e.files || [])) used.add(f);
  const dir = auditRoot();
  const names = await fsp.readdir(dir).catch(function () { return []; });
  let dropped = 0;
  for (const n of names) {
    if (used.has(n)) continue;
    try { await fsp.rm(path.join(dir, n), { force: true }); dropped++; } catch (e) { /* 忽略 */ }
  }
  return dropped;
}

/**
 * 记一条审计日志。
 * record = { action, target, comicIds, details, counts, reversible, files, before, after, status, error, message }
 * 返回落盘后的记录对象（带 id / at / undoOf）。
 */
export async function record(rec) {
  const r = rec || {};
  const entry = {
    id: newId(),
    at: new Date().toISOString(),
    action: String(r.action || 'unknown'),
    actionLabel: auditActionLabel(r.action),
    target: String(r.target || ''),
    comicIds: (Array.isArray(r.comicIds) ? r.comicIds : []).map(String).slice(0, 500),
    details: r.details || {},
    counts: r.counts || {},
    reversible: r.reversible === true,
    files: (Array.isArray(r.files) ? r.files : []).map(String),
    before: r.before || null,
    after: r.after || null,
    status: r.status === 'failed' ? 'failed' : 'done',
    error: r.error ? String(r.error) : null,
    message: String(r.message || ''),
    undoOf: r.undoOf || null
  };
  const st = auditStore();
  const list = st.data.entries || (st.data.entries = []);
  list.push(entry);
  const over = list.length - MAX_ENTRIES;
  let dropped = 0;
  if (over > 0) { list.splice(0, over); dropped = over; }
  st.data.version = st.data.version || 1;
  st.data.updatedAt = entry.at;
  touchAudit();
  if (dropped) await pruneBlobs();
  await flushAll();
  return entry;
}

/** 审计日志（倒序：最新的在前） */
export function auditLog(query) {
  const q = query || {};
  const limit = Math.max(1, Math.min(300, Number(q.limit) || 60));
  const page = Math.max(1, Number(q.page) || 1);
  const action = String(q.action || '').trim();
  let items = (auditStore().data.entries || []).slice().reverse();
  if (action) items = items.filter(function (e) { return e.action === action; });
  const total = items.length;
  return {
    total: total,
    page: page,
    limit: limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    reversibleCount: items.filter(function (e) { return e.reversible && e.status === 'done'; }).length,
    actions: Object.keys(AUDIT_ACTION_LABEL),
    items: items.slice((page - 1) * limit, page * limit)
  };
}

/** 最近一条还能撤销的操作；没有则返回 null */
export function undoable() {
  const items = (auditStore().data.entries || []).slice().reverse();
  return items.find(function (e) { return e.reversible === true && e.status === 'done'; }) || null;
}

export function entryById(id) {
  const key = String(id || '');
  return (auditStore().data.entries || []).find(function (e) { return e.id === key; }) || null;
}

export function markUndone(id, note) {
  const e = entryById(id);
  if (!e) return null;
  e.status = 'undone';
  e.reversible = false;
  e.undoneAt = new Date().toISOString();
  e.undoNote = String(note || '');
  touchAudit();
  return e;
}
