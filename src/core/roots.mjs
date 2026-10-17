
import path from 'node:path';
import fsp from 'node:fs/promises';

/**
 * 多库根（library roots）统一入口。
 *
 * 背景：漫画分散在多处 —— 哔咔下载库（picacg漫画）与早期收集（先期漫画），
 * 之前只有单一 libraryRoot，无法同时管理。本模块把配置里的库根数组规范化，
 * 供 library / vault / download / dedupe 共用。
 *
 * 配置形态（config.json）：
 *   "libraryRoots": [
 *     { "id": "picacg", "name": "哔咔下载库", "path": "D:\\...\\picacg漫画", "enabled": true },
 *     { "id": "early",  "name": "先期漫画",   "path": "D:\\...\\先期漫画" }
 *   ]
 * 兼容：若没有 libraryRoots，则回退到旧的单值 "libraryRoot"。
 */

const DEFAULT_NAME = '漫画库';

function normalizeEntry(raw, index) {
  if (!raw) return null;
  const obj = typeof raw === 'string' ? { path: raw } : raw;
  const p = String(obj.path || '').trim();
  if (!p) return null;
  const abs = path.resolve(p);
  return {
    id: String(obj.id || ('root' + (index + 1))).replace(/[^A-Za-z0-9_-]/g, ''),
    name: String(obj.name || DEFAULT_NAME + (index + 1)),
    path: abs,
    enabled: obj.enabled !== false
  };
}

/** 规范化后的库根数组（去重、保序、补 id/name） */
export function roots(config) {
  const cfg = config || {};
  const out = [];
  const seen = new Set();
  const push = function (raw, i) {
    const e = normalizeEntry(raw, i);
    if (!e || seen.has(e.path)) return;
    seen.add(e.path);
    out.push(e);
  };
  if (Array.isArray(cfg.libraryRoots)) cfg.libraryRoots.forEach(push);
  if (!out.length && cfg.libraryRoot) push(cfg.libraryRoot, 0);
  // id 去重
  const usedIds = new Set();
  for (const r of out) {
    let id = r.id || 'root';
    let n = 2;
    while (usedIds.has(id)) { id = r.id + '-' + n; n++; }
    usedIds.add(id);
    r.id = id;
  }
  return out;
}

/** 仅启用中的库根 */
export function activeRoots(config) {
  return roots(config).filter(function (r) { return r.enabled; });
}

export function rootById(config, id) {
  return roots(config).find(function (r) { return r.id === id; }) || null;
}

export function rootByPath(config, absPath) {
  const target = path.resolve(String(absPath || ''));
  return roots(config).find(function (r) { return r.path === target; }) || null;
}

/** 某个绝对路径落在哪个库根里（用于判定 safeJoin 的基准根） */
export function ownerRootOf(config, absPath) {
  const target = path.resolve(String(absPath || ''));
  let best = null;
  for (const r of roots(config)) {
    const rel = path.relative(r.path, target);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (!best || r.path.length > best.path.length) best = r;
    }
  }
  return best;
}

/** 中文标签（UI 显示用） */
export function labelOf(config, idOrPath) {
  const r = rootById(config, idOrPath) || rootByPath(config, idOrPath);
  return r ? r.name : String(idOrPath || '');
}

/** 检查每个库根的存在性/可读性/漫画目录数（设置页与体检用） */
export async function probeRoots(config) {
  const list = roots(config);
  const out = [];
  for (const r of list) {
    const item = { id: r.id, name: r.name, path: r.path, enabled: r.enabled, exists: false, dirs: 0, error: null };
    try {
      const st = await fsp.stat(r.path);
      item.exists = st.isDirectory();
      if (item.exists) {
        const entries = await fsp.readdir(r.path, { withFileTypes: true });
        item.dirs = entries.filter(function (e) { return e.isDirectory() && !e.name.startsWith('.'); }).length;
      }
    } catch (err) {
      item.error = err.code === 'ENOENT' ? '目录不存在' : String(err.message || err);
    }
    out.push(item);
  }
  return out;
}

/** 新增/更新库根（写回 config.json 的 libraryRoots） */
export function upsertRoot(config, entry) {
  const list = roots(config).slice();
  const abs = path.resolve(String(entry.path || ''));
  const idx = list.findIndex(function (r) { return r.path === abs || (entry.id && r.id === entry.id); });
  const next = { id: entry.id || undefined, name: entry.name, path: abs, enabled: entry.enabled !== false };
  if (idx >= 0) list[idx] = Object.assign({}, list[idx], next, { id: list[idx].id });
  else list.push(next);
  return list;
}

export function removeRoot(config, idOrPath) {
  const abs = path.resolve(String(idOrPath || ''));
  return roots(config).filter(function (r) { return r.id !== idOrPath && r.path !== abs; });
}
