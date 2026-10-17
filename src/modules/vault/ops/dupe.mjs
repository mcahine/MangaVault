
import { loadCatalog } from '../catalog.mjs';

/* ---------------- 08 重复候选 ---------------- */
function normTitle(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\[\]【】「」『』《》<>]/g, '')
    .replace(/[!！?？.,，。、:：;；'"'"~～\-_—]/g, '');
}

export async function duplicates(cfg) {
  const cat = await loadCatalog(cfg);
  const groups = [];
  const byTitle = new Map();
  for (const c of cat.items) {
    const k = normTitle(c.title) || normTitle(c.dir);
    if (!k) continue;
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(c);
  }
  for (const [k, arr] of byTitle) {
    if (arr.length < 2) continue;
    groups.push({
      confidence: 1, reason: '标题完全一致（忽略标点/括号）', key: k,
      items: arr.map(function (c) { return { id: c.id, title: c.title, dir: c.dir, rootId: c.rootId, rootName: c.rootName, images: c.images, bytes: c.bytes, hasMeta: c.hasMeta }; })
    });
  }
  // 目录名包含关系（弱一些的相似）
  const items = cat.items;
  const N = Math.min(items.length, 900);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const a = normTitle(items[i].dir), b = normTitle(items[j].dir);
      if (!a || !b || a === b) continue;
      if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) {
        const key = 'inc:' + [a, b].sort().join('|');
        if (groups.some(function (g) { return g.key === key; })) continue;
        groups.push({
          confidence: 0.6, reason: '目录名互相包含，可能是同一作品的不同版本', key: key,
          items: [items[i], items[j]].map(function (c) { return { id: c.id, title: c.title, dir: c.dir, rootId: c.rootId, rootName: c.rootName, images: c.images, bytes: c.bytes, hasMeta: c.hasMeta }; })
        });
      }
    }
  }
  groups.sort(function (a, b) { return b.confidence - a.confidence; });
  return { groups: groups.slice(0, 200), count: Math.min(groups.length, 200), totalComics: cat.items.length };
}
