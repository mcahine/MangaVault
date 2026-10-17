// engine/paths.mjs — 查重模块的路径/配置解析（v2：多库根）。
// 所有产物只写 data/dedupe/ 下，禁止写回 picacg处理/。
import path from 'node:path';
import crypto from 'node:crypto';
import { roots as coreRoots } from '../../../core/roots.mjs';

const DEDUPE_DIR_NAME = 'dedupe';
export const QUARANTINE_DIR_NAME = '已确认删除';
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif|bmp|avif)$/i;

/** 目录名的稳定短键（与原实现一致：md5(路径) 前 16 位）。 */
export function keyOf(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex').slice(0, 16);
}

/** 是否图片扩展名。 */
export function isImageName(name) { return IMAGE_EXT_RE.test(String(name)); }

/** 封面类文件名（漫画目录直属的 cover.jpg 不算章节内容）。 */
export function isCoverName(name) { return /^cover\./i.test(String(name)); }

/**
 * 规范化单个库根条目：支持「字符串 id」「字符串路径」「{id,name,path}」三种写法。
 * 能对上 config.libraryRoots 的条目时沿用它的 id/name。
 */
function normalizeLibRoot(entry, index, coreList) {
  if (!entry) return null;
  const isStr = typeof entry === 'string';
  const obj = isStr ? {} : entry;
  const ref = isStr ? entry : '';
  const byId = (obj.id && coreList.find(function (r) { return r.id === obj.id; }))
    || (ref && coreList.find(function (r) { return r.id === ref; }))
    || null;
  const rawPath = String(obj.path || (ref && !byId ? ref : '') || (byId ? byId.path : '')).trim();
  if (!rawPath) return null;
  const abs = path.resolve(rawPath);
  const byPath = byId || coreList.find(function (r) { return r.path === abs; }) || null;
  return {
    id: String(obj.id || (byPath && byPath.id) || 'root' + (index + 1)),
    name: String(obj.name || (byPath && byPath.name) || path.basename(abs) || ('库 ' + (index + 1))),
    path: abs
  };
}

/**
 * dedupe 比对用的库根数组。优先级：
 *   config.dedupe.libRoots（数组，条目可为 id / 路径 / 对象）
 *   > config.libraryRoots（经 src/core/roots.mjs 规范化，只取 enabled）
 *   > 旧单值 config.dedupe.libRoot / config.libraryRoot（兼容 v1）
 */
export function resolveLibRoots(config, dedupeCfg) {
  const coreList = coreRoots(config || {});
  const raw = (dedupeCfg && Array.isArray(dedupeCfg.libRoots)) ? dedupeCfg.libRoots : null;
  const out = [];
  const seen = new Set();
  if (raw && raw.length) {
    for (let i = 0; i < raw.length; i++) {
      const r = normalizeLibRoot(raw[i], i, coreList);
      if (!r || seen.has(r.path)) continue;
      seen.add(r.path);
      out.push(r);
    }
  } else if (coreList.length) {
    for (const r of coreList) {
      if (r.enabled === false || seen.has(r.path)) continue;
      seen.add(r.path);
      out.push({ id: r.id, name: r.name, path: r.path });
    }
  }
  if (!out.length) {
    const legacy = String((dedupeCfg && dedupeCfg.libRoot) || (config && config.libraryRoot) || '').trim();
    if (legacy) out.push({ id: 'root1', name: path.basename(path.resolve(legacy)) || '漫画库', path: path.resolve(legacy) });
  }
  // 保证 id 唯一、name 非空
  const used = new Set();
  for (let i = 0; i < out.length; i++) {
    const base = String(out[i].id || ('root' + (i + 1))).replace(/[^A-Za-z0-9_-]/g, '') || ('root' + (i + 1));
    let id = base;
    let n = 2;
    while (used.has(id)) { id = base + '-' + n; n++; }
    used.add(id);
    out[i].id = id;
    if (!out[i].name) out[i].name = path.basename(out[i].path) || id;
  }
  return out;
}

/** 某绝对路径属于哪个库根（取最长匹配），找不到返回 null。 */
export function ownerOf(libRoots, absPath) {
  const list = libRoots || [];
  const target = path.resolve(String(absPath || ''));
  let best = null;
  for (const r of list) {
    const rel = path.relative(path.resolve(r.path), target);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (!best || String(r.path).length > String(best.path).length) best = r;
    }
  }
  return best;
}

/** 相对某个库根的路径（/ 分隔）；不在该根内返回空串。 */
export function relInRoot(rootOrPath, absPath) {
  if (!rootOrPath) return '';
  const base = path.resolve(typeof rootOrPath === 'string' ? rootOrPath : rootOrPath.path);
  const target = path.resolve(String(absPath || ''));
  if (base === target) return '';
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.split(path.sep).join('/');
}

/**
 * 由 ctx.config + dataDir 推出全套绝对路径。
 * dedupe 配置项：scanRoot / libRoots（libRoot 兼容） / pixelThreshold / thumbCount / pixelReview。
 */
export function resolvePaths(config, dataDir) {
  const cfg = (config && config.dedupe) || {};
  const root = path.resolve(path.join(dataDir, DEDUPE_DIR_NAME));
  const scanRaw = String(cfg.scanRoot || '').trim();
  const libRoots = resolveLibRoots(config, cfg);
  const thumbCount = Number(cfg.thumbCount || 6);
  const pixelThreshold = Number(cfg.pixelThreshold || 8);
  return {
    cfg: cfg,
    configured: Boolean(scanRaw),
    root: root,
    scanRoot: scanRaw ? path.resolve(scanRaw) : '',
    libRoots: libRoots,
    libRoot: libRoots.length ? libRoots[0].path : '',
    tmp: path.join(root, 'tmp'),
    fpLib: path.join(root, 'tmp', 'fp-lib'),
    fpDup: path.join(root, 'tmp', 'fp-dup'),
    thumbs: path.join(root, 'thumbs'),
    quarantine: path.join(root, QUARANTINE_DIR_NAME),
    scanFile: path.join(root, 'scan-latest.json'),
    hashFile: path.join(root, 'hash-result.json'),
    decisionFile: path.join(root, 'decisions.json'),
    deleteLog: path.join(root, 'delete-log.jsonl'),
    stateFile: path.join(root, 'state.json'),
    pixelThreshold: Number.isFinite(pixelThreshold) ? pixelThreshold : 8,
    thumbCount: Number.isFinite(thumbCount) && thumbCount > 0 ? Math.floor(thumbCount) : 6,
    pixelReview: cfg.pixelReview !== false
  };
}

/** 建立所有工作目录（幂等）。 */
export async function ensureDirs(p) {
  const fsp = await import('node:fs/promises');
  for (const dir of [p.root, p.tmp, p.fpLib, p.fpDup, p.thumbs]) {
    try { await fsp.mkdir(dir, { recursive: true }); } catch (e) { /* 交给调用方的 try/catch 兜底 */ }
  }
  return p;
}

/** 判断 target 是否位于 root 之内（含相等）。 */
export function insideRoot(root, target) {
  if (!root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 单段文件名校验：不允许分隔符、不允许 ..（用于 ?name= 的 dup 侧）。 */
export function isPlainFileName(name) {
  if (typeof name !== 'string' || !name.length || name.length > 240) return false;
  if (name.includes('..')) return false;
  if (/[\\/\u0000]/.test(name)) return false;
  return true;
}

/** 多段相对路径校验（多根下 lib 侧 name 允许子路径，仍禁止 .. 与绝对路径/盘符）。 */
export function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || !rel.length || rel.length > 400) return false;
  if (rel.includes('..') || rel.includes('\u0000')) return false;
  if (/^[\\/]/.test(rel)) return false;
  if (/^[A-Za-z]:/.test(rel)) return false;
  return true;
}
