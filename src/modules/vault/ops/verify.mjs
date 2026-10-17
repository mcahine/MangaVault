
import path from 'node:path';
import fsp from 'node:fs/promises';
import { readJson, atomicWriteJson, IMAGE_EXT, naturalCompare } from '../../../core/util.mjs';
import { rootById } from '../../../core/roots.mjs';
import { loadCatalog, invalidateCatalog } from '../catalog.mjs';
import { CHAPTER_META_FILE, COVER_NAMES, comicAbs, requireInsideRoot, dirNameIssues, parseOrderPrefix } from '../paths.mjs';
import { needComic } from './_shared.mjs';
import { setCover } from './cover.mjs';

/* ---------------- 06 文件校验 ---------------- */
async function checkImage(file) {
  const issues = [];
  const st = await fsp.stat(file).catch(function () { return null; });
  if (!st) return [{ level: 'high', code: 'missing', message: '文件读取失败' }];
  if (st.size === 0) issues.push({ level: 'high', code: 'zero', message: '0 字节文件' });
  if (st.size > 0 && st.size < 200) issues.push({ level: 'mid', code: 'tiny', message: '文件过小（' + st.size + ' 字节），疑似坏图' });
  if (st.size > 16) {
    const fh = await fsp.open(file, 'r');
    try {
      const head = Buffer.alloc(4);
      await fh.read(head, 0, 4, 0);
      const isJpg = head[0] === 0xFF && head[1] === 0xD8;
      const isPng = head[0] === 0x89 && head[1] === 0x50;
      const isWebp = head.toString('ascii', 0, 4) === 'RIFF';
      if (!isJpg && !isPng && !isWebp) issues.push({ level: 'high', code: 'header', message: '文件头不是常见图片格式（前 4 字节 ' + head.toString('hex') + '）' });
      if (isJpg) {
        const tail = Buffer.alloc(2);
        await fh.read(tail, 0, 2, st.size - 2);
        if (!(tail[0] === 0xFF && tail[1] === 0xD9)) issues.push({ level: 'mid', code: 'truncated', message: 'JPEG 缺少结束标记 FFD9，可能下载不完整' });
      }
    } finally { await fh.close(); }
  }
  return issues;
}

export async function verifyComics(cfg, opts) {
  const o = opts || {};
  const cat = await loadCatalog(cfg);
  const list = o.comicId ? [needComic(cfg, cat, o.comicId)] : (o.rootId ? cat.items.filter(function (c) { return c.rootId === o.rootId; }) : cat.items);
  const limit = Math.max(1, Math.min(2000, Number(o.limit) || 400));
  const reports = [];
  let scanned = 0;

  for (const c of list) {
    if (scanned >= limit) break;
    scanned++;
    const abs = comicAbs(cfg, c);
    const findings = [];
    const root = rootById(cfg, c.rootId);
    const push = function (f) { findings.push(Object.assign({ comicId: c.id, dir: c.dir, title: c.title }, f)); };

    // 元数据
    if (!c.hasMeta) push({ level: 'low', code: 'no-meta', message: '缺少 元数据.json（不影响阅读）' });
    if (dirNameIssues(c.dir).length) push({ level: 'mid', code: 'dirname', message: '目录名不规范：' + dirNameIssues(c.dir).join('、') });

    // 封面
    const hasCover = (await Promise.all(COVER_NAMES.map(function (n) { return fsp.stat(path.join(abs, n)).then(function () { return true; }).catch(function () { return false; }); }))).some(Boolean);
    if (!hasCover) push({ level: 'low', code: 'no-cover', message: '缺少 cover.jpg（阅读器会用首章首图兜底）' });

    // 章节
    for (const ch of (c.chapters || [])) {
      if (!ch.count) continue;
      const chDir = ch.dir === '.' ? abs : path.join(abs, ch.dir);
      if (ch.dir !== '.') {
        const cm = await readJson(path.join(chDir, CHAPTER_META_FILE), null);
        if (!cm) push({ level: 'mid', code: 'no-chapter-meta', message: '章节缺少 章节元数据.json：' + ch.dir });
        else if (!cm.chapterId) push({ level: 'low', code: 'chapter-meta-field', message: '章节元数据缺 chapterId：' + ch.dir });
      }
      const names = (await fsp.readdir(chDir).catch(function () { return []; }))
        .filter(function (n) { return IMAGE_EXT.has(path.extname(n).toLowerCase()); })
        .sort(naturalCompare);
      const orders = names.map(function (n) { return parseOrderPrefix(n); }).filter(function (x) { return x !== null; });
      const uniq = Array.from(new Set(orders)).sort(function (a, b) { return a - b; });
      for (let i = 1; i < uniq.length; i++) {
        if (uniq[i] !== uniq[i - 1] + 1) {
          push({ level: 'mid', code: 'gap', message: '序号断档：' + ch.dir + ' 从 ' + uniq[i - 1] + ' 跳到 ' + uniq[i] });
          break;
        }
      }
      for (const n of names.slice(0, 400)) {
        const issues = await checkImage(path.join(chDir, n));
        for (const it of issues) push({ level: it.level, code: it.code, message: ch.dir + '/' + n + '：' + it.message, file: ch.dir + '/' + n });
      }
    }
    if (findings.length) reports.push({ comicId: c.id, title: c.title, dir: c.dir, rootId: c.rootId, rootName: root ? root.name : '', findings: findings });
  }

  const byCode = {};
  let high = 0, mid = 0, low = 0;
  for (const r of reports) for (const f of r.findings) {
    byCode[f.code] = (byCode[f.code] || 0) + 1;
    if (f.level === 'high') high++; else if (f.level === 'mid') mid++; else low++;
  }
  return { scanned: scanned, total: list.length, problemComics: reports.length, high: high, mid: mid, low: low, byCode: byCode, reports: reports };
}

/* ---------------- 07 一键修复（只做安全项） ---------------- */
export async function fixComics(cfg, opts) {
  const o = opts || {};
  const dry = o.confirm !== true;
  const cat = await loadCatalog(cfg);
  const list = o.comicId ? [needComic(cfg, cat, o.comicId)] : cat.items;
  const actions = [];
  for (const c of list) {
    const abs = comicAbs(cfg, c);
    try { requireInsideRoot(cfg, abs, '漫画目录'); } catch (e) { continue; }
    for (const ch of (c.chapters || [])) {
      if (!ch.count || ch.dir === '.') continue;
      const chDir = path.join(abs, ch.dir);
      const cmFile = path.join(chDir, CHAPTER_META_FILE);
      const cm = await readJson(cmFile, null);
      if (!cm) {
        actions.push({ type: 'write-chapter-meta', comicId: c.id, dir: c.dir, chapter: ch.dir });
        if (!dry) {
          await atomicWriteJson(cmFile, { chapterId: ch.chapterId || null, chapterTitle: ch.title || ch.dir, order: Number(ch.order) || parseOrderPrefix(ch.dir) || 1 });
        }
      }
    }
    const hasCover = (await Promise.all(COVER_NAMES.map(function (n) { return fsp.stat(path.join(abs, n)).then(function () { return true; }).catch(function () { return false; }); }))).some(Boolean);
    if (!hasCover) {
      actions.push({ type: 'make-cover', comicId: c.id, dir: c.dir });
      if (!dry) { try { await setCover(cfg, c.id, {}); } catch (e) { /* 没有图片就跳过 */ } }
    }
  }
  if (!dry) invalidateCatalog();
  return { applied: !dry, dryRun: dry, count: actions.length, actions: actions };
}
