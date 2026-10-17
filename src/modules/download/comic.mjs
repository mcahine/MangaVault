import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 任务辅助：本地库扫描、章节状态、磁盘空间、打开目录。
 * 全部是纯函数/显式传参，方便单测。
 */

/** 扫描下载根目录，返回 { byId: Map, titles: Set, dirs: [] }。 */
export async function indexLibrary(root) {
  const byId = new Map();
  const titles = new Set();
  const dirs = [];
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (e) {
    return { byId: byId, titles: titles, dirs: dirs };
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const dir = path.join(root, ent.name);
    dirs.push(dir);
    titles.add(ent.name);
    let text;
    try {
      text = await fsp.readFile(path.join(dir, '元数据.json'), 'utf8');
    } catch (e) {
      continue;
    }
    let obj = null;
    try { obj = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { continue; }
    const id = obj && (obj.id || obj._id);
    if (id) byId.set(String(id), { id: String(id), dir: dir, title: obj.title || ent.name, meta: obj });
  }
  return { byId: byId, titles: titles, dirs: dirs };
}

/** 磁盘可用空间（拿不到返回 null）。 */
export async function diskFree(root) {
  try {
    const st = await fsp.statfs(root);
    return Number(st.bavail) * Number(st.bsize);
  } catch (e) {
    return null;
  }
}

/** 把绝对路径编码成前端可用的封面 URL。 */
export function coverUrlFor(absPath) {
  if (!absPath) return '';
  return '/api/download/cover?path=' + encodeURIComponent(absPath);
}

function pad3(n) {
  const s = String(Math.max(0, Math.floor(Number(n) || 0)));
  return s.length >= 3 ? s : ('000' + s).slice(-3);
}

/** 统计章节目录里的图片。 */
export async function chapterStats(dir) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return { count: 0, bytes: 0, first: null }; }
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'];
  let count = 0;
  let bytes = 0;
  let first = null;
  const nums = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (exts.indexOf(ext) < 0) continue;
    if (!/^\d{1,6}\./.test(ent.name)) continue;
    let size = 0;
    try { size = (await fsp.stat(path.join(dir, ent.name))).size; } catch (e) { continue; }
    count++;
    bytes += size;
    nums.push(Number(ent.name.split('.')[0]));
    if (!first || ent.name < first) first = ent.name;
  }
  nums.sort(function (a, b) { return a - b; });
  return { count: count, bytes: bytes, first: first, nums: nums, paddedFirst: first };
}

/** 判断章节目录是否已完成（章节元数据 + 至少一张图）。 */
export async function chapterDone(dir) {
  try {
    const st = await fsp.stat(path.join(dir, '章节元数据.json'));
    if (!st.isFile()) return false;
  } catch (e) {
    return false;
  }
  const s = await chapterStats(dir);
  return s.count > 0;
}

/** 扫描一部漫画的所有章节状态。 */
export async function scanChapterStates(comicDir, chapters, paths, ctxInfo) {
  const out = {};
  for (const ch of chapters) {
    const dir = paths.chapterDir(ctxInfo.title, ch, { comicId: ctxInfo.comicId });
    const st = await chapterStats(dir);
    const done = await chapterDone(dir);
    out[String(ch.order)] = {
      order: ch.order,
      dir: dir,
      exists: st.count > 0,
      images: st.count,
      bytes: st.bytes,
      done: done,
      firstImage: st.first
    };
  }
  return out;
}

/** 路径是否在 root 内。 */
export function isInside(root, target) {
  const a = path.resolve(root);
  const b = path.resolve(target);
  const rel = path.relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
