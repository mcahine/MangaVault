// 查重模块的前端视图辅助：把落盘结果整理成路由要回的形状。
// 从 index.mjs 拆出。全部是纯函数（只依赖传入的 paths 与对象），没有闭包状态。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson } from '../../core/util.mjs';

/*
  快速查重（stage=fast）的产物文件名。
  engine/paths.mjs 不归本任务改，所以这里按「与 scan-latest.json 同目录、同命名习惯」推出：
  data/dedupe/scan-fast.json。
*/
export function fastFileOf(paths) { return path.join(paths.root, 'scan-fast.json'); }

/** 目录存在性（/state 与 /candidates 共用）。 */
export async function dirOk(dir) {
  try { const st = await fsp.stat(dir); return st.isDirectory(); } catch (e) { return false; }
}

/** 数字宽容取值：非有限数一律 null（避免把 undefined 写成 0）。 */
export function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * 从快速模式的落盘结果里解析候选数组。
 * 容错是硬要求：文件不存在、JSON 坏、字段缺失或类型不对，一律退化成空数组，绝不抛错
 * （否则前端会拿到 500，用户看到的就成了「快速查重坏了」）。
 * 兼容三种形状：直接是数组 / {units:[...]} / {candidates:[...]}（另兼容中文键 候选）。
 */
export function candidatesFromFast(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'object') return [];
  const list = raw.units || raw.candidates || raw['候选'];
  return Array.isArray(list) ? list : [];
}

/** 打分宽容取值：接受 0.9 这种 0~1 小数，也接受 90 这种百分数；取不到返回 null。 */
export function score01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) return Math.round(n) / 100;
  return Math.max(0, Math.min(1, n));
}

/** 标题归一化（全角转半角、去空白与标点、转小写），与 prefilter 的口径保持一致。 */
export function roughNorm(s) {
  return String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
    .replace(/\u3000/g, ' ')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/*
  兜底标题相似度（2-gram Dice 系数，只在快速结果没给 titleScore 时用）。
  权威口径在同事 A 的 engine/prefilter.mjs；这里只保证界面上的「标题相似度」不会永远是空值。
*/
export function roughTitleScore(a, b) {
  const na = roughNorm(a);
  const nb = roughNorm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const grams = [];
  for (let i = 0; i + 1 < na.length; i++) grams.push(na.slice(i, i + 2));
  const pool = new Map();
  for (let i = 0; i + 1 < nb.length; i++) {
    const g = nb.slice(i, i + 2);
    pool.set(g, (pool.get(g) || 0) + 1);
  }
  let hit = 0;
  for (const g of grams) {
    const n = pool.get(g) || 0;
    if (n > 0) { hit++; pool.set(g, n - 1); }
  }
  return Math.round(((2 * hit) / (grams.length + (nb.length - 1))) * 1000) / 1000;
}

/** 与前端 dedupe.js 的 thumbUrl() 同一口径的缩略图地址（root 对多库根必需）。 */
export function thumbUrlOf(id, side, name, root) {
  const params = new URLSearchParams();
  params.set('unit', id);
  params.set('side', side);
  params.set('name', name);
  if (side === 'lib' && root) params.set('root', root);
  return '/api/dedupe/thumb?' + params.toString();
}

/**
 * 从单元记录里挑出第一张能并排显示的库侧抽样图。
 * samples 每项通常是 { dup, lib, root, exact, mad }；lib 是「相对某个库根的路径」。
 * 同时兼容快速模式可能写出的 libPath / libFile 等别名。
 */
export function libSampleOf(u) {
  const list = (u && Array.isArray(u.samples)) ? u.samples : [];
  for (const s of list) {
    const name = String((s && (s.lib || s.libPath || s.libFile)) || '');
    if (!name) continue;
    return {
      dup: String((s && s.dup) || ''),
      lib: name,
      root: String((s && (s.root || s.libRootId)) || ''),
      exact: Boolean(s && s.exact),
      mad: (s && s.mad != null) ? s.mad : null
    };
  }
  return null;
}

/**
 * dup 侧兜底首图：直接读单元目录，取自然序第一张图（文件名相对单元目录）。
 * 为什么需要它：库格式正规化之后，dup 侧单元目录下沉了一层（<漫画>/1 第1話），
 * 采样时记的文件名一律是「<序> <章节>/xxx.jpg」，一旦某条记录的 samples 缺 dup，
 * 候选卡片就会出现「左半边空白」，用户根本没法做「并排看图判定」。
 * 读盘失败（目录已删、权限）返回空串，绝不抛错。
 */
export async function firstDupImageOf(u) {
  const dir = String((u && u.dupDir) || '');
  if (!dir) return '';
  try {
    const names = await fsp.readdir(dir);
    const imgs = names.filter(function (n) { return isImageName(n); }).sort(naturalCompare);
    return imgs.length ? imgs[0] : '';
  } catch (e) { return ''; }
}

/**
 * 把单元上的全部抽样页映射成并排图（快速查重的 samples 是整章等距抽的多张）。
 * 只取第一张是错的：用户要的是「多抽几页并排看」，一张图不足以判断整部作品是不是重复。
 */
export function samplesOf(u, limit) {
  const list = (u && Array.isArray(u.samples)) ? u.samples : [];
  const out = [];
  const max = Number(limit) > 0 ? Number(limit) : 8;
  for (const s of list) {
    const dup = String((s && s.dup) || '');
    const lib = String((s && (s.lib || s.libPath || s.libFile)) || '');
    if (!dup && !lib) continue;
    out.push({
      dup: dup,
      lib: lib,
      root: String((s && (s.root || s.libRootId)) || ''),
      exact: Boolean(s && s.exact),
      mad: (s && s.mad != null) ? s.mad : null
    });
    if (out.length >= max) break;
  }
  return out;
}
