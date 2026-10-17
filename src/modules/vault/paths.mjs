
import path from 'node:path';
import { roots } from '../../core/roots.mjs';

export const META_FILE = '元数据.json';
export const META_BAK = '元数据.json.bak';
export const CHAPTER_META_FILE = '章节元数据.json';
export const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'];

const ILLEGAL_RE = /[<>:"/\\|?*\u0000-\u001f]/;
const ILLEGAL_ALL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** 全角 ASCII 与全角空格转半角；中文标点与汉字不动 */
export function toHalfWidth(s) {
  const text = String(s == null ? '' : s);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else out += text[i];
  }
  return out;
}

/** 匹配/归一化 key：半角化 + NFKC + 折叠空白 + 小写 */
export function normKey(s) {
  return toHalfWidth(s).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 展示用：半角化 + 去首尾空白 + 折叠内部空白 */
export function tidySpaces(s) {
  return toHalfWidth(s).replace(/\s+/g, ' ').trim();
}

/** 目录名清洗：非法字符、首尾点与空格、超长截断 */
export function sanitizeDirName(raw, fallback) {
  let out = tidySpaces(raw).replace(ILLEGAL_ALL, '_');
  out = out.replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  if (!out) out = tidySpaces(fallback) || 'untitled';
  if (out.length > 100) out = out.slice(0, 100).replace(/[. ]+$/, '');
  return out;
}

/** 目录名是否含有问题时的问题清单（只报告，不改名） */
export function dirNameIssues(name) {
  const out = [];
  const s = String(name == null ? '' : name);
  if (!s) return ['名称为空'];
  if (ILLEGAL_RE.test(s)) out.push('含非法字符');
  if (/^[. ]/.test(s)) out.push('以点或空格开头');
  if (/[. ]$/.test(s)) out.push('以点或空格结尾');
  if (/\u3000/.test(s)) out.push('含全角空格');
  if (/\s{2,}/.test(s)) out.push('含连续空白');
  if (s.length > 100) out.push('名称超过 100 字');
  if (RESERVED_RE.test(s)) out.push('Windows 保留名');
  return out;
}

/** 解析目录名前导序号：'03 第3話' -> { order:3, title:'第3話' }；无序号返回 null */
export function parseOrderPrefix(name) {
  const s = String(name == null ? '' : name).trim();
  const m = /^(\d{1,4})\s*[._\-、]?\s*(.*)$/.exec(s);
  if (!m) return null;
  const title = tidySpaces(m[2]);
  return { order: parseInt(m[1], 10), title: title || s };
}

/** 章节目录名：统一 'NN 标题'，width 为补零位数 */
export function chapterDirName(order, title, width) {
  const w = Math.max(2, Number(width) || 2);
  const n = String(Math.max(1, Number(order) || 1)).padStart(w, '0');
  return n + ' ' + sanitizeDirName(title, '未命名章节');
}

/** 漫画所属库根配置（优先 rootId，其次 root 路径，最后回退第一个根） */
export function comicRoot(cfg, comic) {
  const list = roots(cfg);
  if (comic && comic.rootId) {
    const hit = list.find(function (x) { return x.id === comic.rootId; });
    if (hit) return hit;
  }
  if (comic && comic.root) {
    const abs = path.resolve(String(comic.root));
    const hit2 = list.find(function (x) { return x.path === abs; });
    if (hit2) return hit2;
  }
  return list[0] || null;
}

/** 漫画目录绝对路径 */
export function comicAbs(cfg, comic) {
  const r = comicRoot(cfg, comic);
  if (!r || !comic) return null;
  return path.join(r.path, String(comic.dir || ''));
}

/** 某绝对路径属于哪个库根（越界返回 null），用于所有写操作的基准校验 */
export function insideRoot(cfg, absPath) {
  const target = path.resolve(String(absPath || ''));
  let best = null;
  for (const r of roots(cfg)) {
    const rel = path.relative(r.path, target);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (!best || r.path.length > best.path.length) best = r;
    }
  }
  return best;
}

/** 校验一个路径确实落在某个库根内，返回该根；否则抛 400 */
export function requireInsideRoot(cfg, absPath, what) {
  const r = insideRoot(cfg, absPath);
  if (!r) {
    throw Object.assign(new Error((what || '路径') + '不在任何库根内，拒绝操作：' + absPath), { statusCode: 400 });
  }
  return r;
}

/** 相对库根的路径（用于展示与回收站） */
export function relOfRoot(root, absPath) {
  return path.relative(root.path, path.resolve(String(absPath || ''))).split(path.sep).join('/');
}

/** 生成文件名安全的时间戳：20260101-120000 */
export function stamp(now) {
  const d = now ? new Date(now) : new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
