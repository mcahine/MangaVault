
import path from 'node:path';
import fsp from 'node:fs/promises';
import { safeJoin } from '../../../core/util.mjs';
import { rootById, roots } from '../../../core/roots.mjs';
import { invalidateCatalog } from '../catalog.mjs';
import { META_FILE, requireInsideRoot } from '../paths.mjs';
import { overlayStore, trashStore, touchOverlay, touchTrash, flushAll } from '../storage.mjs';
import { bad } from './_shared.mjs';
import { record, entryById, undoable, markUndone, readBlobText } from '../audit.mjs';

/**
 * 撤销（回滚）最近一次可撤销的写操作。
 *
 * 铁律：撤销本身也要有记录；撤销里任何一步失败都不静默吞掉，而是收集成中文原因返回，
 * 让用户知道「哪几项没还原成功」，而不是以为全好了。
 */

/** 目录搬动：同盘用 rename，跨盘先复制再删（与 move.mjs 的策略保持一致） */
async function moveDir(fromAbs, toAbs) {
  const src = path.parse(fromAbs).root.toLowerCase();
  const dst = path.parse(toAbs).root.toLowerCase();
  if (src !== dst) {
    await fsp.cp(fromAbs, toAbs, { recursive: true });
    await fsp.rm(fromAbs, { recursive: true, force: true });
    return 'copy';
  }
  await fsp.rename(fromAbs, toAbs);
  return 'rename';
}

async function exists(p) {
  return fsp.stat(p).then(function () { return true; }).catch(function () { return false; });
}

/** 目标被占用时找一个不冲突的名字（撤销绝不覆盖用户文件） */
async function uniqueDir(rootPath, dirName) {
  if (!(await exists(path.join(rootPath, dirName)))) return dirName;
  for (let i = 2; i <= 99; i++) {
    const cand = dirName + ' (还原' + (i > 2 ? ' ' + i : '') + ')';
    if (!(await exists(path.join(rootPath, cand)))) return cand;
  }
  throw new Error('目标目录名已占满，无法还原：' + dirName);
}

/* ---------------- 各类操作的逆操作 ---------------- */

async function undoMetaEdit(cfg, entry) {
  const restored = [];
  const failed = [];
  const items = (entry.details && entry.details.items) || [];
  for (const it of items) {
    try {
      const root = roots(cfg).find(function (r) { return r.id === it.rootId; }) || null;
      if (!root) { failed.push({ dir: it.dir, error: '库根已不存在：' + it.rootId }); continue; }
      if (!(await exists(path.join(root.path, it.dir)))) { failed.push({ dir: it.dir, error: '目录已不在原位置' }); continue; }
      const text = it.blob ? await readBlobText(it.blob) : (it.beforeText || null);
      if (text === null || text === undefined) { failed.push({ dir: it.dir, error: '没有可用的旧元数据归档' }); continue; }
      const abs = safeJoin(root.path, it.dir);
      const file = path.join(abs, META_FILE);
      requireInsideRoot(cfg, file, '元数据文件');
      await fsp.writeFile(file + '.tmp', text, 'utf8');
      await fsp.rename(file + '.tmp', file);
      restored.push({ dir: it.dir, title: it.title });
    } catch (err) {
      failed.push({ dir: it.dir, error: String((err && err.message) || err) });
    }
  }
  invalidateCatalog();
  return { restored: restored, failed: failed, what: '元数据' };
}

async function undoRename(cfg, entry) {
  const items = ((entry.details && entry.details.items) || []).slice().reverse();
  const restored = [];
  const failed = [];
  for (const it of items) {
    try {
      const root = rootById(cfg, it.rootId);
      if (!root) { failed.push({ from: it.from, error: '库根已不存在：' + it.rootId }); continue; }
      const curAbs = safeJoin(root.path, it.to);
      const backAbs = safeJoin(root.path, it.from);
      if (!(await exists(curAbs))) { failed.push({ from: it.from, error: '当前目录已不存在：' + it.to }); continue; }
      if (await exists(backAbs)) { failed.push({ from: it.from, error: '原目录名已被占用，未覆盖' }); continue; }
      await moveDir(curAbs, backAbs);
      restored.push({ from: it.to, to: it.from });
    } catch (err) {
      failed.push({ from: it.from, error: String((err && err.message) || err) });
    }
  }
  invalidateCatalog();
  return { restored: restored, failed: failed, what: '目录名' };
}

async function undoMove(cfg, entry) {
  const items = (entry.details && entry.details.items) || [];
  const restored = [];
  const failed = [];
  for (const it of items) {
    try {
      const fromRoot = rootById(cfg, it.fromRootId);
      if (!fromRoot) { failed.push({ dir: it.dir, error: '原库根已不存在：' + it.fromRootId }); continue; }
      // 重名时 move.mjs 会按 rename 策略把落点目录改成 destDir，撤销必须用 destDir 定位，
      // 否则「自动改名后撤销」会找不到目录（本轮真 HTTP 测试实测到该缺陷）。
      const curName = it.destDir || it.dir;
      const curAbs = safeJoin(it.toPath, curName);
      if (!(await exists(curAbs))) { failed.push({ dir: it.dir, error: '搬迁后的目录已不存在：' + curName }); continue; }
      const name = await uniqueDir(fromRoot.path, it.dir);
      const backAbs = safeJoin(fromRoot.path, name);
      requireInsideRoot(cfg, backAbs, '还原目标');
      await moveDir(curAbs, backAbs);
      restored.push({ dir: it.dir, to: fromRoot.name || fromRoot.id, as: name });
    } catch (err) {
      failed.push({ dir: it.dir, error: String((err && err.message) || err) });
    }
  }
  invalidateCatalog();
  return { restored: restored, failed: failed, what: '搬迁' };
}

async function undoTrash(cfg, entry) {
  const { restoreTrash } = await import('./trash.mjs');
  const r = await restoreTrash(cfg, entry.details && entry.details.trashPaths ? entry.details.trashPaths : []);
  return { restored: r.items, failed: r.failed, what: '回收站条目' };
}

async function undoTagAssign(cfg, entry) {
  const before = (entry.details && entry.details.before) || {};
  const overlay = overlayStore().data.overlay;
  let n = 0;
  for (const id of Object.keys(before)) {
    const rec = before[id];
    if (rec === null || rec === undefined) delete overlay[id];
    else overlay[id] = rec;
    n++;
  }
  if (n) touchOverlay();
  return { restored: n, failed: [], what: '标签覆盖层' };
}

async function undoTrashRestore(cfg, entry) {
  const items = (entry.details && entry.details.items) || [];
  const st = trashStore();
  const restored = [];
  const failed = [];
  for (const it of items) {
    try {
      const root = rootById(cfg, it.rootId);
      if (!root) { failed.push({ dir: it.dir, error: '库根已不存在：' + it.rootId }); continue; }
      const abs = safeJoin(root.path, it.dir);
      if (!(await exists(abs))) { failed.push({ dir: it.dir, error: '还原后的目录已不在原位置' }); continue; }
      const box = path.join(path.dirname(abs), '.vault-undo-' + Date.now().toString(36));
      await fsp.mkdir(box, { recursive: true });
      const target = path.join(box, it.dir);
      await moveDir(abs, target);
      // 放回回收站并复原垃圾路径
      const { dataDir } = await import('../../../core/config.mjs');
      const trashDir = path.join(dataDir(), 'vault-trash', it.batch || 'undo');
      await fsp.mkdir(trashDir, { recursive: true });
      const finalAbs = path.join(trashDir, it.dir);
      await moveDir(target, finalAbs);
      await fsp.rm(box, { recursive: true, force: true });
      st.data.items = (st.data.items || []).concat([Object.assign({}, it, { trashPath: (it.batch || 'undo') + '/' + it.dir, at: new Date().toISOString() })]);
      restored.push({ dir: it.dir });
    } catch (err) {
      failed.push({ dir: it.dir, error: String((err && err.message) || err) });
    }
  }
  if (restored.length) { touchTrash(); }
  invalidateCatalog();
  return { restored: restored, failed: failed, what: '重新入回收站' };
}

const UNDO_HANDLERS = {
  'meta-edit': undoMetaEdit,
  'meta-import': undoMetaEdit,
  'rename': undoRename,
  'move-to-root': undoMove,
  'trash-applied': undoTrash,
  'trash-restored': undoTrashRestore,
  'tag-assign': undoTagAssign
};

/** 某条审计是否真的能撤销（动作支持 + 状态允许 + 归档还在） */
export async function canUndo(cfg, entry) {
  if (!entry || entry.reversible !== true || entry.status !== 'done') return false;
  if (!UNDO_HANDLERS[entry.action]) return false;
  if (entry.action === 'meta-edit' || entry.action === 'meta-import') {
    const items = (entry.details && entry.details.items) || [];
    if (!items.length) return false;
    for (const it of items) if (!it.blob) return false;
  }
  return true;
}

/**
 * 撤销一次操作。
 * opts { entryId?, confirm? } —— entryId 省略时撤销「最近一次可撤销」的操作。
 */
export async function undoLast(cfg, opts) {
  const o = opts || {};
  if (o.confirm !== true) throw bad(400, '撤销需要 confirm=true');
  const entry = o.entryId ? entryById(o.entryId) : undoable();
  if (!entry) throw bad(404, '没有可撤销的操作（审计日志里最近一条不支持撤销）');
  if (entry.status === 'undone') throw bad(409, '该操作已经撤销过了');
  if (!entry.reversible) throw bad(409, '该操作不可撤销：' + (entry.message || entry.actionLabel));
  const handler = UNDO_HANDLERS[entry.action];
  if (!handler) throw bad(409, '暂不支持撤销类型：' + entry.actionLabel);

  const r = await handler(cfg, entry);
  const ok = (r.restored && r.restored.length) || 0;
  const failedCount = (r.failed || []).length;
  markUndone(entry.id, '已撤销 ' + ok + ' 项' + (failedCount ? '，失败 ' + failedCount + ' 项' : ''));
  await flushAll();
  const log = await record({
    action: 'undo',
    target: entry.actionLabel,
    comicIds: entry.comicIds,
    details: { undoOf: entry.id, restored: ok, failed: r.failed || [] },
    counts: { restored: ok, failed: failedCount },
    reversible: false,
    message: '已撤销「' + entry.actionLabel + '」' + ok + ' 项'
  });
  invalidateCatalog();
  return {
    undone: entry.id, undoneAction: entry.action, undoneActionLabel: entry.actionLabel,
    restored: ok, failed: r.failed || [], what: r.what || '',
    undoRecordId: log.id,
    message: '已撤销「' + entry.actionLabel + '」：还原 ' + ok + ' 项' + (failedCount ? '，失败 ' + failedCount + ' 项（详见列表）' : '')
  };
}

/** 读一条归档（撤销前的旧内容），给前端「查看原内容」用 */
export async function readArchive(entryId) {
  const entry = entryById(entryId);
  if (!entry) throw bad(404, '审计记录不存在：' + entryId);
  const items = (entry.details && entry.details.items) || [];
  const first = items.find(function (x) { return x.blob; });
  if (!first) throw bad(404, '该操作没有归档内容');
  const text = await readBlobText(first.blob);
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 不是 JSON 就原样返回 */ }
  return { entryId: entry.id, dir: first.dir, blob: first.blob, bytes: Buffer.byteLength(text, 'utf8'), json: json, text: json ? null : text };
}