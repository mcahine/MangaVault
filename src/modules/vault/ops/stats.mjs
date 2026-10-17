
import { loadCatalog, findComic } from '../catalog.mjs';
import { tidySpaces } from '../paths.mjs';
import { readingStore, touchReading, flushAll } from '../storage.mjs';

/* ---------------- 09 统计 ---------------- */
export async function stats(cfg) {
  const cat = await loadCatalog(cfg);
  const byRoot = {}, byAuthor = new Map();
  let bytes = 0, images = 0, noMeta = 0, single = 0, multi = 0;
  for (const c of cat.items) {
    const k = c.rootId || 'unknown';
    byRoot[k] = byRoot[k] || { id: k, name: c.rootName || k, comics: 0, images: 0, bytes: 0 };
    byRoot[k].comics++; byRoot[k].images += c.images; byRoot[k].bytes += c.bytes;
    bytes += c.bytes; images += c.images;
    if (!c.hasMeta) noMeta++;
    if (c.chapterCount <= 1) single++; else multi++;
    const a = tidySpaces(c.author || '') || '未知作者';
    byAuthor.set(a, (byAuthor.get(a) || 0) + 1);
  }
  const rs = readingStore().data;
  return {
    comics: cat.items.length, images: images, bytes: bytes, bytesText: fmtBytes(bytes),
    noMeta: noMeta, withMeta: cat.items.length - noMeta, single: single, multi: multi,
    byRoot: byRoot,
    topAuthors: Array.from(byAuthor.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 20).map(function (e) { return { name: e[0], count: e[1] }; }),
    biggest: cat.items.slice().sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 10).map(function (c) { return { id: c.id, title: c.title, bytes: c.bytes, images: c.images, rootName: c.rootName }; }),
    reading: { totalSeconds: rs.totalSeconds || 0, totalOpens: rs.totalOpens || 0, comics: Object.keys(rs.byComic || {}).length, days: Object.keys(rs.days || {}).length }
  };
}

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n = n / 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n < 10 ? 2 : 1)) + ' ' + u[i];
}

export async function readingTime(comicId, seconds) {
  const s = Math.max(1, Math.min(7200, Number(seconds) || 0));
  const st = readingStore();
  const day = new Date().toISOString().slice(0, 10);
  st.data.totalSeconds = (st.data.totalSeconds || 0) + s;
  st.data.totalOpens = (st.data.totalOpens || 0) + 1;
  st.data.byComic = st.data.byComic || {};
  const cur = st.data.byComic[comicId] || { seconds: 0, opens: 0, lastAt: null };
  cur.seconds += s;
  cur.opens += 1;
  cur.lastAt = new Date().toISOString();
  st.data.byComic[comicId] = cur;
  st.data.days = st.data.days || {};
  st.data.days[day] = (st.data.days[day] || 0) + s;
  touchReading();
  await flushAll();
  return { comicId: comicId, seconds: s, totalSeconds: st.data.totalSeconds, comicSeconds: cur.seconds };
}

export async function readingStats(cfg) {
  const rs = readingStore().data;
  const cat = await loadCatalog(cfg);
  const rows = Object.keys(rs.byComic || {}).map(function (id) {
    const c = findComic(cat, id);
    return { comicId: id, title: c ? c.title : '(已不在库)', seconds: rs.byComic[id].seconds, opens: rs.byComic[id].opens, lastAt: rs.byComic[id].lastAt, rootName: c ? c.rootName : '' };
  }).sort(function (a, b) { return b.seconds - a.seconds; });
  const days = Object.keys(rs.days || {}).sort().map(function (d) { return { day: d, seconds: rs.days[d] }; });
  return { totalSeconds: rs.totalSeconds || 0, totalText: fmtDur(rs.totalSeconds || 0), totalOpens: rs.totalOpens || 0, comics: rows.slice(0, 50), days: days.slice(-30) };
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟';
  return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
}
