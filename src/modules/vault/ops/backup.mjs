
import path from 'node:path';
import fsp from 'node:fs/promises';
import { atomicWriteJson, readJson } from '../../../core/util.mjs';
import { dataDir } from '../../../core/config.mjs';
import { stamp } from '../paths.mjs';
import { invalidateCatalog } from '../catalog.mjs';
import { bad } from './_shared.mjs';

/* ---------------- 10 备份 / 恢复 ---------------- */
const BACKUP_KEEP = 10;
function backupDir() { return path.join(dataDir(), 'backups'); }

export async function makeBackup(note) {
  const dir = backupDir();
  await fsp.mkdir(dir, { recursive: true });
  const files = ['library-index.json', 'library-progress.json', 'library-marks.json', 'vault-tags.json', 'vault-comic-tags.json', 'vault-shelves.json', 'vault-reading.json'];
  const payload = { version: 1, createdAt: new Date().toISOString(), note: note || '', files: {} };
  let bytes = 0;
  for (const f of files) {
    try {
      const text = await fsp.readFile(path.join(dataDir(), f), 'utf8');
      const json = JSON.parse(text);
      payload.files[f] = json;
      bytes += Buffer.byteLength(text, 'utf8');
    } catch (e) { payload.files[f] = null; }
  }
  const name = 'backup-' + stamp() + '.json';
  const file = path.join(dir, name);
  await atomicWriteJson(file, payload);
  // 只保留最近 N 份
  const all = (await fsp.readdir(dir)).filter(function (n) { return /^backup-.*\.json$/.test(n); }).sort();
  const drop = all.slice(0, Math.max(0, all.length - BACKUP_KEEP));
  for (const d of drop) await fsp.rm(path.join(dir, d), { force: true });
  return { file: name, bytes: bytes, kept: Math.min(BACKUP_KEEP, all.length - drop.length), dropped: drop.length };
}

export async function listBackups() {
  const dir = backupDir();
  const names = (await fsp.readdir(dir).catch(function () { return []; })).filter(function (n) { return /^backup-.*\.json$/.test(n); }).sort().reverse();
  const out = [];
  for (const n of names) {
    const st = await fsp.stat(path.join(dir, n)).catch(function () { return null; });
    out.push({ file: n, bytes: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 });
  }
  return { dir: dir, items: out, count: out.length };
}

export async function restoreBackup(fileName, confirm) {
  if (String(confirm || '').trim().toUpperCase() !== 'RESTORE') throw bad(400, '恢复备份需要 confirm=RESTORE');
  const safe = path.basename(String(fileName || ''));
  if (!/^backup-.*\.json$/.test(safe)) throw bad(400, '备份文件名不合法');
  const payload = await readJson(path.join(backupDir(), safe), null);
  if (!payload || !payload.files) throw bad(404, '备份文件不存在或损坏：' + safe);
  const written = [];
  for (const f of Object.keys(payload.files)) {
    if (!payload.files[f]) continue;
    await atomicWriteJson(path.join(dataDir(), f), payload.files[f]);
    written.push(f);
  }
  invalidateCatalog();
  const { loadStores } = await import('../storage.mjs');
  await loadStores();
  return { restored: written, count: written.length, from: safe, createdAt: payload.createdAt };
}
