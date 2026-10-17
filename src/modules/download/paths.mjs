import path from 'node:path';
import fsp from 'node:fs/promises';
import { sanitizeName } from '../../core/util.mjs';

/**
 * 下载落盘的目录/文件命名规范。
 * 与现有库（含 picacomic-downloader 下载结果）完全同构：
 *   <comic_title>/元数据.json
 *   <comic_title>/cover.jpg
 *   <comic_title>/<order> <chapter_title>/章节元数据.json
 *   <comic_title>/<order> <chapter_title>/001.jpg
 */

export const MSG_COMIC_META = '元数据.json';
export const MSG_CHAPTER_META = '章节元数据.json';
export const COVER_BASE = 'cover';
export const TMP_PREFIX = '.tmp-';

/** 下载格式 → 扩展名。 */
export function extOfFormat(fmt) {
  const s = String(fmt || 'Jpeg').toLowerCase();
  if (s === 'png') return 'png';
  if (s === 'webp') return 'webp';
  if (s === 'jpg' || s === 'jpeg') return 'jpg';
  return 'jpg';
}

/** 三位补零。 */
export function pad3(n) {
  const s = String(Math.max(0, Math.floor(Number(n) || 0)));
  return s.length >= 3 ? s : ('000' + s).slice(-3);
}

/** 由 {comic_title}/{order} {chapter_title} 之类的格式串生成漫画目录名。 */
export function comicDirName(title) {
  return sanitizeName(String(title || ''), 'untitled');
}

/** 由 dirFmt 生成章节目录名；默认 '{order} {chapter_title}'。 */
export function chapterDirName(chapter, dirFmt, ctxInfo) {
  const info = ctxInfo || {};
  const fmt = String(dirFmt || '{comic_title}/{order} {chapter_title}');
  const parts = fmt.split('/').filter(function (x) { return x; });
  let rel = parts.length ? parts[parts.length - 1] : '{order} {chapter_title}';
  rel = rel
    .replace(/\{comic_title\}/g, String(info.comicTitle || ''))
    .replace(/\{comic_id\}/g, String(info.comicId || ''))
    .replace(/\{author\}/g, String(info.author || ''))
    .replace(/\{chapter_id\}/g, String(chapter && chapter.chapterId || ''))
    .replace(/\{chapter_title\}/g, String(chapter && chapter.chapterTitle || ''))
    .replace(/\{order\}/g, String(chapter && chapter.order !== undefined ? chapter.order : ''));
  return sanitizeName(rel.replace(/\s+/g, ' '), 'chapter');
}

/** 所有生成路径的集合。 */
export function createPaths(opts) {
  const o = opts || {};
  const root = () => String(typeof o.root === 'function' ? o.root() : (o.root || '')) || '.';
  const dirFmt = () => (typeof o.dirFmt === 'function' ? o.dirFmt() : o.dirFmt) || '{comic_title}/{order} {chapter_title}';
  const format = () => (typeof o.format === 'function' ? o.format() : o.format) || 'Jpeg';

  function comicDir(title) {
    return path.join(root(), comicDirName(title));
  }

  function chapterDir(title, chapter, ctxInfo) {
    const info = Object.assign({ comicTitle: title }, ctxInfo || {});
    return path.join(comicDir(title), chapterDirName(chapter, dirFmt(), info));
  }

  function chapterTempDir(title, chapter, ctxInfo) {
    return chapterDir(title, chapter, ctxInfo) + TMP_PREFIX + process.pid;
  }

  function comicTempDir(title) {
    return comicDir(title) + TMP_PREFIX + process.pid;
  }

  function imageFile(dir, index, ext) {
    return path.join(dir, pad3(index) + '.' + (ext || extOfFormat(format())));
  }

  return {
    root: root,
    comicDirName: comicDirName,
    chapterDirName: function (ch, info) { return chapterDirName(ch, dirFmt(), info); },
    comicDir: comicDir,
    comicTempDir: comicTempDir,
    comicMetaFile: function (title) { return path.join(comicDir(title), MSG_COMIC_META); },
    coverFile: function (title) { return path.join(comicDir(title), COVER_BASE + '.jpg'); },
    coverFileWithExt: function (title, ext) { return path.join(comicDir(title), COVER_BASE + '.' + String(ext || 'jpg').replace(/^\./, '')); },
    chapterDir: chapterDir,
    chapterTempDir: chapterTempDir,
    chapterMetaFile: function (dir) { return path.join(dir, MSG_CHAPTER_META); },
    imageFile: imageFile,
    imageName: function (index, ext) { return pad3(index) + '.' + (ext || extOfFormat(format())); }
  };
}

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'];

/** 列出章节目录里的图片文件名（跳过临时文件），返回 { name, num, size, abs }。 */
export async function listChapterImages(dir) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    if (name.startsWith('.') || name.startsWith('~')) continue;
    const ext = path.extname(name).toLowerCase();
    if (IMAGE_EXTS.indexOf(ext) < 0) continue;
    const m = /^(\d{1,6})/.exec(name);
    if (!m) continue;
    const abs = path.join(dir, name);
    let size = 0;
    try { size = (await fsp.stat(abs)).size; } catch (e) { continue; }
    out.push({ name: name, num: Number(m[1]), size: size, abs: abs });
  }
  return out;
}

/** 章节目录是否"已完成"（有章节元数据且至少 1 张非空图片）。 */
export async function isChapterComplete(dir) {
  try {
    const st = await fsp.stat(path.join(dir, MSG_CHAPTER_META));
    if (!st.isFile()) return false;
  } catch (e) {
    return false;
  }
  const imgs = await listChapterImages(dir);
  return imgs.some(function (i) { return i.size > 0; });
}

/** 通过魔数判断图片真实格式，返回扩展名（识别不了返回空串）。 */
export function sniffImageExt(buf) {
  if (!buf || buf.length < 4) return '';
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.slice(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.length >= 12 && b.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return '';
}

/** 漫画是否已在库：扫描 downloadRoot 下所有 元数据.json 找到匹配 id。 */
export async function findComicDirById(root, comicId, options) {
  const o = options || {};
  const needle = String(comicId || '');
  if (!needle || !root) return null;
  let dirs = [];
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    const file = path.join(root, ent.name, MSG_COMIC_META);
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch (e) { continue; }
    if (text.indexOf(needle) < 0) continue;
    let obj = null;
    try { obj = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { continue; }
    if (obj && String(obj.id) === needle) return { dir: path.join(root, ent.name), meta: obj };
  }
  if (o.altTitle) {
    const guess = path.join(root, comicDirName(o.altTitle));
    try {
      const st = await fsp.stat(guess);
      if (st.isDirectory()) return { dir: guess, meta: null, byTitle: true };
    } catch (e) { /* 不存在 */ }
  }
  return null;
}

/** 磁盘可用空间（拿不到返回 null）。 */
export async function diskFreeBytes(dir) {
  try {
    const st = await fsp.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch (e) {
    return null;
  }
}
