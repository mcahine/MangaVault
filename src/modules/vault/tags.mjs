
import { shortHash } from '../../core/util.mjs';
import { labelOf } from '../../core/roots.mjs';
import { tagStore, overlayStore, ensureShape, touchTags, touchOverlay, COLORS, DERIVE_RULE_KEYS, defaultRules } from './storage.mjs';
import { deriveAutoTags } from './derive.mjs';
import { normKey, tidySpaces } from './paths.mjs';
import { loadCatalog, hydrateComic } from './catalog.mjs';

/* ============================ 标签注册表 ============================ */

export function listTags() { ensureShape(); return tagStore().data.tags; }

export function tagById(id) {
  return listTags().find(function (t) { return t.id === String(id); }) || null;
}

/** 按 id / 名字 / 别名 找标签 */
export function findTagRef(ref) {
  const key = normKey(ref);
  if (!key) return null;
  const list = listTags();
  for (const t of list) if (t.id === String(ref)) return t;
  for (const t of list) if (normKey(t.name) === key) return t;
  for (const t of list) if (t.aliases.some(function (a) { return normKey(a) === key; })) return t;
  return null;
}

export function defaultColor(name) {
  const h = parseInt(shortHash(normKey(name), 6), 16) || 0;
  return COLORS[h % COLORS.length];
}

function uniqueId(base) {
  const list = listTags();
  let id = base;
  let n = 2;
  while (list.some(function (t) { return t.id === id; })) { id = base + '-' + n; n++; }
  return id;
}

function cleanAliases(value, selfName) {
  const out = [];
  const seen = new Set([normKey(selfName)]);
  for (const a of (Array.isArray(value) ? value : [])) {
    const name = tidySpaces(a);
    const key = normKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** 新建标签；名字重复时直接返回已有标签（idempotent，便于批量打标顺带建标签） */
export function createTag(input) {
  const name = tidySpaces((input && input.name) || '');
  if (!name) throw Object.assign(new Error('标签名不能为空'), { statusCode: 400 });
  const exist = findTagRef(name);
  if (exist) return { tag: exist, created: false };
  const now = new Date().toISOString();
  const tag = {
    id: uniqueId('tg-' + shortHash(name, 8)),
    name: name,
    aliases: cleanAliases(input.aliases, name),
    color: COLORS.indexOf(input.color) >= 0 ? input.color : defaultColor(name),
    group: tidySpaces(input.group) || '未分组',
    description: tidySpaces(input.description) || '',
    createdAt: now, updatedAt: now
  };
  listTags().push(tag);
  touchTags();
  return { tag: tag, created: true };
}

/** 改名/别名/颜色/分组/描述；改名会同步迁移覆盖层引用并保留旧名为别名 */
export function updateTag(input) {
  const tag = input && input.id ? tagById(input.id) : findTagRef((input && input.name) || input.ref || '');
  if (!tag) throw Object.assign(new Error('标签不存在'), { statusCode: 404 });
  const oldName = tag.name;
  let renamed = false;
  if (input.name !== undefined) {
    const name = tidySpaces(input.name);
    if (!name) throw Object.assign(new Error('标签名不能为空'), { statusCode: 400 });
    if (normKey(name) !== normKey(oldName)) {
      const clash = findTagRef(name);
      if (clash && clash.id !== tag.id) throw Object.assign(new Error('已存在同名标签：' + clash.name + '，请改用合并'), { statusCode: 409 });
      tag.name = name;
      renamed = true;
      if (input.keepAlias !== false) {
        const aliases = tag.aliases.filter(function (a) { return normKey(a) !== normKey(oldName); });
        aliases.push(oldName);
        tag.aliases = cleanAliases(aliases, name);
      }
    }
  }
  if (input.aliases !== undefined) tag.aliases = cleanAliases(input.aliases, tag.name);
  if (input.color !== undefined && COLORS.indexOf(input.color) >= 0) tag.color = input.color;
  if (input.group !== undefined) tag.group = tidySpaces(input.group) || '未分组';
  if (input.description !== undefined) tag.description = tidySpaces(input.description);
  tag.updatedAt = new Date().toISOString();
  let migrated = 0;
  if (renamed) migrated = migrateOverlay(oldName, tag.name);
  touchTags();
  return { tag: tag, renamed: renamed, migrated: migrated };
}

export function deleteTag(input) {
  const tag = input && input.id ? tagById(input.id) : findTagRef((input && input.ref) || '');
  if (!tag) throw Object.assign(new Error('标签不存在'), { statusCode: 404 });
  const list = listTags();
  const idx = list.indexOf(tag);
  if (idx >= 0) list.splice(idx, 1);
  let cleaned = 0;
  if (!input || input.keepOverlay !== true) cleaned = dropOverlayRefs([tag.name].concat(tag.aliases));
  touchTags();
  return { deleted: tag.name, cleaned: cleaned };
}

/** 合并 A -> B：迁移覆盖层引用，A 的名字与别名并入 B 的别名，删除 A */
export function mergeTags(input) {
  const from = tagById(input.from) || findTagRef(input.from);
  const to = tagById(input.to) || findTagRef(input.to);
  if (!from) throw Object.assign(new Error('待合并的标签不存在'), { statusCode: 404 });
  if (!to) throw Object.assign(new Error('目标标签不存在，请先新建'), { statusCode: 404 });
  if (from.id === to.id) throw Object.assign(new Error('不能与自身合并'), { statusCode: 400 });
  const refs = [from.name].concat(from.aliases);
  const migrated = migrateOverlay(from.name, to.name, from.aliases);
  to.aliases = cleanAliases(to.aliases.concat(refs), to.name);
  to.updatedAt = new Date().toISOString();
  const list = listTags();
  const idx = list.indexOf(from);
  if (idx >= 0) list.splice(idx, 1);
  touchTags();
  return { from: from.name, to: to.name, migrated: migrated };
}

/** 覆盖层里把 oldName（及其别名）替换成 newName；返回改动数 */
function migrateOverlay(oldName, newName, oldAliases) {
  const keys = new Set([normKey(oldName)].concat((oldAliases || []).map(normKey)));
  const overlay = overlayStore().data.overlay;
  let changed = 0;
  for (const id of Object.keys(overlay)) {
    const o = overlay[id];
    for (const field of ['add', 'remove']) {
      const next = [];
      const seen = new Set();
      for (const name of o[field]) {
        const mapped = keys.has(normKey(name)) ? newName : name;
        const k = normKey(mapped);
        if (!k || seen.has(k)) { changed++; continue; }
        seen.add(k);
        if (mapped !== name) changed++;
        next.push(mapped);
      }
      o[field] = next;
    }
  }
  if (changed) touchOverlay();
  return changed;
}

/** 从覆盖层里彻底移除这些引用（删除标签时用） */
function dropOverlayRefs(names) {
  const keys = new Set(names.map(normKey));
  const overlay = overlayStore().data.overlay;
  let changed = 0;
  for (const id of Object.keys(overlay)) {
    for (const field of ['add', 'remove']) {
      const next = overlay[id][field].filter(function (n) { return !keys.has(normKey(n)); });
      if (next.length !== overlay[id][field].length) { changed++; overlay[id][field] = next; }
    }
    if (!overlay[id].add.length && !overlay[id].remove.length && !overlay[id].note) delete overlay[id];
  }
  if (changed) touchOverlay();
  return changed;
}

export function setDeriveSettings(patch) {
  ensureShape();
  const s = tagStore().data.settings;
  if (patch.derive !== undefined) s.derive = Boolean(patch.derive);
  if (patch.skipUnknownTeam !== undefined) s.skipUnknownTeam = Boolean(patch.skipUnknownTeam);
  if (patch.rules && typeof patch.rules === 'object') {
    for (const k of DERIVE_RULE_KEYS) if (patch.rules[k] !== undefined) s.rules[k] = Boolean(patch.rules[k]);
  }
  if (!s.rules) s.rules = defaultRules();
  touchTags();
  return s;
}

/* ============================ 有效标签 ============================ */

/** 一次请求内复用：注册表索引 + 覆盖层 + 派生设置 */
export function makeTagEnv() {
  ensureShape();
  const data = tagStore().data;
  const byKey = new Map();
  const byId = new Map();
  for (const t of data.tags) {
    byId.set(t.id, t);
    const k = normKey(t.name);
    if (!byKey.has(k)) byKey.set(k, t);
    for (const a of t.aliases) { const ak = normKey(a); if (!byKey.has(ak)) byKey.set(ak, t); }
  }
  return { settings: data.settings, tags: data.tags, overlay: overlayStore().data.overlay, byKey: byKey, byId: byId };
}

/**
 * 有效标签 = 自动派生标签 ∪ 覆盖层 add，再去掉覆盖层 remove（add 优先于 remove）。
 * 返回统一结构：{ name, key, color, group, tagId, source:'auto'|'manual'|'both' }
 */
export function effectiveTags(comic, cfg, env) {
  const e = env || makeTagEnv();
  const map = new Map();
  const addOne = function (rawName, source, group) {
    const name = tidySpaces(rawName);
    const key = normKey(name);
    if (!key) return;
    const reg = e.byKey.get(key) || null;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, {
        name: reg ? reg.name : name, key: key,
        color: reg ? reg.color : defaultColor(name), group: reg ? reg.group : (group || '未登记'),
        tagId: reg ? reg.id : null, source: source
      });
      return;
    }
    if (reg && !cur.tagId) { cur.tagId = reg.id; cur.color = reg.color; cur.group = reg.group; }
    if (cur.source !== source) cur.source = 'both';
  };
  for (const a of deriveAutoTags(comic, cfg, e.settings)) addOne(a.name, 'auto', a.group);
  const ov = e.overlay[comic.id];
  if (ov) {
    for (const n of ov.remove) map.delete(normKey(n));
    for (const n of ov.add) addOne(n, 'manual');
  }
  return Array.from(map.values());
}

export function effectiveNames(comic, cfg, env) {
  return effectiveTags(comic, cfg, env).map(function (t) { return t.name; });
}

/* ============================ 打标 / 去标 ============================ */

/** 批量打标/去标：add 里未登记的标签会自动建（便于「边筛边打」） */
export function assignTags(cfg, comicIds, add, remove, note) {
  const ids = (Array.isArray(comicIds) ? comicIds : []).map(String).filter(Boolean);
  if (!ids.length) throw Object.assign(new Error('comicIds 不能为空'), { statusCode: 400 });
  if (!Array.isArray(add)) add = [];
  if (!Array.isArray(remove)) remove = [];
  if (note !== undefined && typeof note !== 'string') throw Object.assign(new Error('note 必须是字符串'), { statusCode: 400 });
  const created = [];
  const adds = [];
  for (const raw of add) {
    const name = tidySpaces(raw);
    if (!name) continue;
    const exist = findTagRef(name);
    if (!exist) { const r = createTag({ name: name }); created.push(r.tag.name); }
    adds.push(exist ? exist.name : name);
  }
  const removes = [];
  for (const raw of remove) {
    const name = tidySpaces(raw);
    if (!name) continue;
    const exist = findTagRef(name);
    removes.push(exist ? exist.name : name);
  }
  const addKeys = new Set(adds.map(normKey));
  const removeKeys = new Set(removes.map(normKey));
  const overlay = overlayStore().data.overlay;
  // 审计/撤销需要「改之前长什么样」：把每部漫画的覆盖层旧值深拷贝留存
  const before = {};
  for (const id of ids) {
    const old = overlay[id];
    before[id] = old ? JSON.parse(JSON.stringify(old)) : null;
  }
  let touched = 0;
  for (const id of ids) {
    const o = overlay[id] || { add: [], remove: [], note: '' };
    const curAdd = o.add.filter(function (n) { return !removeKeys.has(normKey(n)); });
    for (const n of adds) if (!curAdd.some(function (x) { return normKey(x) === normKey(n); })) curAdd.push(n);
    const curRemove = o.remove.filter(function (n) { return !addKeys.has(normKey(n)); });
    for (const n of removes) if (!curRemove.some(function (x) { return normKey(x) === normKey(n); })) curRemove.push(n);
    const next = { add: curAdd, remove: curRemove, note: note === undefined ? (o.note || '') : note };
    if (!next.add.length && !next.remove.length && !next.note) delete overlay[id];
    else overlay[id] = next;
    touched++;
  }
  touchOverlay();
  return { assigned: touched, added: adds, removed: removes, createdTags: created, comicIds: ids, before: before };
}

export function comicOverlay(comicId) {
  ensureShape();
  return overlayStore().data.overlay[String(comicId)] || { add: [], remove: [], note: '' };
}

/* ============================ 统计 / 反查 / 搜索 ============================ */

/** 注册表标签 + 派生出来的“虚拟标签”，都带上出现次数/体积/按根分布 */
export async function tagStats(cfg) {
  const cat = await loadCatalog(cfg);
  const env = makeTagEnv();
  const map = new Map();
  for (const t of env.tags) {
    map.set(normKey(t.name), { name: t.name, key: normKey(t.name), color: t.color, group: t.group, tagId: t.id, registered: true, count: 0, bytes: 0, indexCovered: 0, byRoot: {} });
  }
  for (const c of cat.items) {
    for (const t of effectiveTags(c, cfg, env)) {
      let e = map.get(t.key);
      if (!e) {
        e = { name: t.name, key: t.key, color: t.color, group: t.group, tagId: null, registered: false, count: 0, bytes: 0, indexCovered: 0, byRoot: {} };
        map.set(t.key, e);
      }
      e.count++;
      e.bytes += Number(c.bytes) || 0;
      if (c.indexed) e.indexCovered++;
      const rid = c.rootId || 'unknown';
      e.byRoot[rid] = (e.byRoot[rid] || 0) + 1;
    }
  }
  const tags = Array.from(map.values()).sort(function (a, b) {
    return (b.count - a.count) || a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  const unusedList = tags.filter(function (t) { return t.count === 0; });
  const usedList = tags.filter(function (t) { return t.count > 0; });
  // 手动覆盖（vault-comic-tags.json）里显式出现过的标签名，用于区分「人工管过的」与「纯自动派生」
  const manualKeys = new Set();
  try {
    const ov = overlayStore().data.overlay || {};
    for (const cid of Object.keys(ov)) {
      const rec = ov[cid] || {};
      for (const n of (rec.add || [])) manualKeys.add(normKey(n));
      for (const n of (rec.remove || [])) manualKeys.add(normKey(n));
    }
  } catch (e) { /* 覆盖层还没建 */ }
  const manualCount = tags.filter(function (t) { return manualKeys.has(t.key) || manualKeys.has(normKey(t.name)); }).length;
  return {
    total: tags.length,
    registered: env.tags.length,
    derived: tags.length - env.tags.length,
    // 下面这几个字段前端标签墙统计卡直接读，必须给全（曾经缺失导致统计卡显示 0）
    usedCount: usedList.length,
    unusedCount: unusedList.length,
    derivedCount: tags.length - env.tags.length,
    manualCount: manualCount,
    unused: unusedList.map(function (t) { return t.name; }),
    maxCount: tags.reduce(function (n, t) { return Math.max(n, t.count); }, 0),
    comicCount: cat.items.length,
    bytes: cat.items.reduce(function (n, c) { return n + (Number(c.bytes) || 0); }, 0),
    roots: cat.roots,
    settings: env.settings,
    tags: tags
  };
}

/** 反查：某个标签下的漫画 */
export async function tagComics(cfg, idOrName, page, size) {
  const tag = tagById(idOrName) || findTagRef(idOrName);
  const key = normKey(tag ? tag.name : idOrName);
  if (!key) throw Object.assign(new Error('标签不能为空'), { statusCode: 400 });
  const cat = await loadCatalog(cfg);
  const env = makeTagEnv();
  const rows = [];
  for (const c of cat.items) {
    const eff = effectiveTags(c, cfg, env);
    if (eff.some(function (t) { return t.key === key; })) rows.push({ comic: c, tags: eff });
  }
  rows.sort(function (a, b) { return String(a.comic.title).localeCompare(String(b.comic.title), 'zh-Hans-CN', { numeric: true }); });
  const total = rows.length;
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(200, Math.max(1, Number(size) || 60));
  return { tag: tag ? { id: tag.id, name: tag.name, color: tag.color, group: tag.group } : { id: null, name: String(idOrName), color: defaultColor(idOrName), group: '未登记' }, total: total, page: p, size: s, rows: rows.slice((p - 1) * s, p * s) };
}

function splitList(v) {
  if (Array.isArray(v)) return v.map(String).map(tidySpaces).filter(Boolean);
  return String(v == null ? '' : v).split(',').map(tidySpaces).filter(Boolean);
}

export function normalizeQuery(q) {
  const src = q || {};
  return {
    q: tidySpaces(src.q),
    tags: splitList(src.tags),
    exclude: splitList(src.exclude),
    mode: src.mode === 'or' ? 'or' : 'and',
    author: tidySpaces(src.author),
    root: tidySpaces(src.root),
    hasMeta: src.hasMeta === undefined || src.hasMeta === '' || src.hasMeta === null ? '' : (String(src.hasMeta) === '1' || src.hasMeta === true ? '1' : '0'),
    minPages: Math.max(0, Number(src.minPages) || 0),
    sort: src.sort || 'title',
    note: tidySpaces(src.note)
  };
}

export function sortRows(rows, sort) {
  const num = function (v) { return Number(v) || 0; };
  const arr = rows.slice();
  switch (sort) {
    case 'size': arr.sort(function (a, b) { return num(b.comic.bytes) - num(a.comic.bytes); }); break;
    case 'pages': arr.sort(function (a, b) { return num(b.comic.images) - num(a.comic.images); }); break;
    case 'recent': arr.sort(function (a, b) { return num(b.comic.dirMtime || b.comic.updatedAt) - num(a.comic.dirMtime || a.comic.updatedAt); }); break;
    case 'author': arr.sort(function (a, b) { return String(a.comic.author).localeCompare(String(b.comic.author), 'zh-Hans-CN'); }); break;
    case 'tagcount': arr.sort(function (a, b) { return b.tags.length - a.tags.length; }); break;
    case 'title':
    default: arr.sort(function (a, b) { return String(a.comic.title).localeCompare(String(b.comic.title), 'zh-Hans-CN', { numeric: true }); });
  }
  return arr;
}

/** 组合筛选：标签(and/or) + 排除 + 作者 + 库根 + 有无元数据 + 最少页数 + 备注关键字 + 标题关键字 */
export async function searchComics(cfg, rawQuery) {
  const q = normalizeQuery(rawQuery);
  const cat = await loadCatalog(cfg);
  const env = makeTagEnv();
  const wantKeys = q.tags.map(normKey).filter(Boolean);
  const excludeKeys = q.exclude.map(normKey).filter(Boolean);
  const authorKey = normKey(q.author);
  const noteKey = normKey(q.note);
  const textKey = normKey(q.q);
  const rows = [];
  for (const c of cat.items) {
    const eff = effectiveTags(c, cfg, env);
    const keys = new Set(eff.map(function (t) { return t.key; }));
    if (wantKeys.length) {
      const hits = wantKeys.map(function (k) { return keys.has(k); });
      const ok = q.mode === 'or' ? hits.some(Boolean) : hits.every(Boolean);
      if (!ok) continue;
    }
    if (excludeKeys.length && excludeKeys.some(function (k) { return keys.has(k); })) continue;
    if (authorKey && normKey(c.author).indexOf(authorKey) < 0) continue;
    if (q.root && c.rootId !== q.root && normKey(labelOf(cfg, c.rootId)) !== normKey(q.root)) continue;
    if (q.hasMeta !== '' && Boolean(c.hasMeta) !== (q.hasMeta === '1')) continue;
    if (q.minPages && (Number(c.images) || 0) < q.minPages) continue;
    const ov = env.overlay[c.id];
    if (noteKey && !(ov && normKey(ov.note).indexOf(noteKey) >= 0)) continue;
    if (textKey) {
      const hay = normKey([c.title, c.author, c.description].join(' '));
      if (hay.indexOf(textKey) < 0) continue;
    }
    rows.push({ comic: c, tags: eff });
  }
  return { query: q, total: rows.length, rows: sortRows(rows, q.sort), catalog: cat, env: env };
}

/* ============================ 导入 / 导出 ============================ */

export function exportTagsPayload() {
  ensureShape();
  const data = tagStore().data;
  return {
    app: 'MangaVault', kind: 'vault-tags', version: 1, exportedAt: new Date().toISOString(),
    settings: data.settings, tags: data.tags
  };
}

/** merge 策略：skip（保留已有）/ overwrite（用导入覆盖）/ rename（冲突改名后新增） */
export function importTags(payload, mode) {
  const m = (mode === 'overwrite' || mode === 'rename') ? mode : 'skip';
  const raw = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.tags) ? payload.tags : null);
  if (!raw) throw Object.assign(new Error('导入内容必须是标签数组或 { tags: [...] }'), { statusCode: 400 });
  const result = { mode: m, added: 0, updated: 0, skipped: 0, renamed: 0, errors: [] };
  for (const item of raw) {
    if (!item || typeof item !== 'object') { result.errors.push('忽略非法条目'); continue; }
    const name = tidySpaces(item.name);
    if (!name) { result.errors.push('忽略无名字的标签'); continue; }
    const exist = findTagRef(name);
    if (!exist) {
      createTag({ name: name, aliases: item.aliases, color: item.color, group: item.group, description: item.description });
      result.added++;
      continue;
    }
    if (m === 'skip') { result.skipped++; continue; }
    if (m === 'overwrite') {
      updateTag({ id: exist.id, name: name, aliases: item.aliases, keepAlias: false });
      if (COLORS.indexOf(item.color) >= 0) exist.color = item.color;
      if (item.group !== undefined) exist.group = tidySpaces(item.group) || exist.group;
      if (item.description !== undefined) exist.description = tidySpaces(item.description);
      exist.updatedAt = new Date().toISOString();
      result.updated++;
      continue;
    }
    let candidate = name;
    let n = 2;
    while (findTagRef(candidate)) { candidate = name + ' (' + n + ')'; n++; }
    createTag({ name: candidate, aliases: item.aliases, color: item.color, group: item.group, description: item.description });
    result.renamed++;
  }
  touchTags();
  return result;
}
