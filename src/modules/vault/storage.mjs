
import { JsonStore } from '../../core/store.mjs';

export const COLORS = ['red', 'pink', 'blue', 'cyan', 'yellow'];
export const DERIVE_RULE_KEYS = ['metaTags', 'categories', 'author', 'chineseTeam', 'root', 'chapterCount', 'manualSource'];

export function defaultRules() {
  const out = {};
  for (const k of DERIVE_RULE_KEYS) out[k] = true;
  return out;
}

function tagsShape() {
  return { version: 1, updatedAt: null, settings: { derive: true, skipUnknownTeam: true, rules: defaultRules() }, tags: [] };
}

let created = false;
const box = {};

/**
 * 存储是惰性创建的：dataDir() 依赖 MV_DATA_DIR，必须在进程启动/测试设好环境变量后再 new，
 * 因此这里不能写成模块级常量。
 */
function init() {
  if (created) return box;
  created = true;
  box.tags = new JsonStore('vault-tags.json', tagsShape());
  box.overlay = new JsonStore('vault-comic-tags.json', { version: 1, updatedAt: null, overlay: {} });
  box.shelves = new JsonStore('vault-shelves.json', { version: 1, updatedAt: null, shelves: [] });
  box.reading = new JsonStore('vault-reading.json', { version: 1, updatedAt: null, totalSeconds: 0, totalOpens: 0, byComic: {}, days: {} });
  box.trash = new JsonStore('vault-trash.json', { version: 1, updatedAt: null, items: [] });
  box.audit = new JsonStore('vault-audit.json', { version: 1, updatedAt: null, entries: [] });
  return box;
}

export function tagStore() { return init().tags; }
export function overlayStore() { return init().overlay; }
export function shelfStore() { return init().shelves; }
export function readingStore() { return init().reading; }
export function trashStore() { return init().trash; }
export function auditStore() { return init().audit; }
export function allStores() { const b = init(); return [b.tags, b.overlay, b.shelves, b.reading, b.trash, b.audit]; }

/** 补齐缺字段，兼容手改过的文件 */
export function ensureShape() {
  const b = init();
  const td = b.tags.data;
  if (!Array.isArray(td.tags)) td.tags = [];
  if (!td.settings || typeof td.settings !== 'object') td.settings = tagsShape().settings;
  if (td.settings.derive === undefined) td.settings.derive = true;
  if (td.settings.skipUnknownTeam === undefined) td.settings.skipUnknownTeam = true;
  if (!td.settings.rules || typeof td.settings.rules !== 'object') td.settings.rules = defaultRules();
  for (const k of DERIVE_RULE_KEYS) if (td.settings.rules[k] === undefined) td.settings.rules[k] = true;
  for (const t of td.tags) {
    if (!Array.isArray(t.aliases)) t.aliases = [];
    if (typeof t.group !== 'string' || !t.group) t.group = '未分组';
    if (COLORS.indexOf(t.color) < 0) t.color = COLORS[0];
    if (typeof t.description !== 'string') t.description = '';
  }
  const ov = b.overlay.data;
  if (!ov.overlay || typeof ov.overlay !== 'object') ov.overlay = {};
  for (const id of Object.keys(ov.overlay)) {
    const o = ov.overlay[id];
    if (!o || typeof o !== 'object') { ov.overlay[id] = { add: [], remove: [], note: '' }; continue; }
    if (!Array.isArray(o.add)) o.add = [];
    if (!Array.isArray(o.remove)) o.remove = [];
    if (typeof o.note !== 'string') o.note = '';
  }
  if (!Array.isArray(b.shelves.data.shelves)) b.shelves.data.shelves = [];
  if (!Array.isArray(b.trash.data.items)) b.trash.data.items = [];
  if (!Array.isArray(b.audit.data.entries)) b.audit.data.entries = [];
  const rd = b.reading.data;
  if (!rd.byComic || typeof rd.byComic !== 'object') rd.byComic = {};
  if (!rd.days || typeof rd.days !== 'object') rd.days = {};
  rd.totalSeconds = Number(rd.totalSeconds) || 0;
  rd.totalOpens = Number(rd.totalOpens) || 0;
  return b;
}

/** 载入全部 vault 数据文件（模块 register 时调用一次） */
export async function loadStores() {
  const b = init();
  for (const key of Object.keys(b)) {
    try { await b[key].load(); } catch (e) { /* 文件不存在/损坏：用默认值 */ }
  }
  ensureShape();
  return b;
}

function touch(store) { store.data.updatedAt = new Date().toISOString(); store.markDirty(); }
export function touchTags() { return touch(tagStore()); }
export function touchOverlay() { return touch(overlayStore()); }
export function touchShelves() { return touch(shelfStore()); }
export function touchReading() { return touch(readingStore()); }
export function touchTrash() { return touch(trashStore()); }
export function touchAudit() { return touch(auditStore()); }

/** 立刻落盘（不依赖 400ms 防抖），接口写操作后调用，保证刷新页面能看到 */
export async function flushAll() {
  const b = init();
  for (const key of Object.keys(b)) {
    try { await b[key].flush(); } catch (e) { /* 落盘失败不阻断响应 */ }
  }
}
