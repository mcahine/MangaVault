
import path from 'node:path';
import fsp from 'node:fs/promises';
import { atomicWriteJson, readJson } from '../../../core/util.mjs';
import { loadCatalog, invalidateCatalog } from '../catalog.mjs';
import { META_FILE, META_BAK, tidySpaces, comicAbs, requireInsideRoot, relOfRoot } from '../paths.mjs';
import { needComic } from './_shared.mjs';
import { record, archiveBlob } from '../audit.mjs';
import { flushAll } from '../storage.mjs';

/* ---------------- 01 元数据编辑 ---------------- */
export async function editMeta(cfg, id, patch) {
  const cat = await loadCatalog(cfg);
  const c = needComic(cfg, cat, id);
  const abs = comicAbs(cfg, c);
  requireInsideRoot(cfg, abs, '漫画目录');
  const file = path.join(abs, META_FILE);

  const existing = (await readJson(file, null)) || {};
  const next = Object.assign({}, existing);
  const fields = ['title', 'author', 'description', 'chineseTeam'];
  for (const k of fields) if (patch && patch[k] !== undefined) next[k] = String(patch[k]);
  for (const k of ['tags', 'categories']) {
    if (patch && Array.isArray(patch[k])) next[k] = patch[k].map(String).map(tidySpaces).filter(Boolean);
  }
  if (!next.id) next.id = c.id;
  if (!next.title) next.title = c.title || c.dir;
  if (!Array.isArray(next.tags)) next.tags = [];
  if (!Array.isArray(next.categories)) next.categories = [];

  let backup = null;
  if (existing && Object.keys(existing).length) {
    backup = path.join(abs, META_BAK);
    await fsp.writeFile(backup + '.tmp', JSON.stringify(existing, null, 2), 'utf8');
    await fsp.rename(backup + '.tmp', backup);
  }
  await atomicWriteJson(file, next);
  invalidateCatalog();
  // 审计归档：拿不到旧内容（首次创建元数据）就不给撤销，避免假装能回滚
  const changed = [];
  for (const k of Object.keys(next)) {
    const a = existing ? existing[k] : undefined;
    const b = next[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k);
  }
  const beforeText = existing && Object.keys(existing).length ? JSON.stringify(existing, null, 2) : null;
  const blob = beforeText ? await archiveBlob('meta-' + (c.dir || c.id) + '.json', beforeText) : null;
  const entry = await record({
    action: 'meta-edit',
    target: '元数据 · ' + (c.title || c.dir),
    comicIds: [c.id],
    details: { single: true, fields: changed, items: [{ comicId: c.id, dir: c.dir, title: c.title, rootId: c.rootId, blob: blob }] },
    counts: { affected: 1 },
    reversible: Boolean(blob),
    message: '修改元数据：' + (c.title || c.dir)
  });
  await flushAll();
  return {
    id: c.id, dir: c.dir, file: relOfRoot(requireInsideRoot(cfg, abs, '漫画目录'), file),
    backup: backup ? META_BAK : null, meta: next, fields: changed, auditId: entry.id, reversible: Boolean(blob)
  };
}
