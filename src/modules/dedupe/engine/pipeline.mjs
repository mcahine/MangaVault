// engine/pipeline.mjs — 扫描流水线三段：hash（单元发现+字节查重）/ pixel（全库像素搜索）/ thumbs（缩略图）。
// v2：库侧为多库根（paths.libRoots），每段都通过 report(frac, phase, current, total, message) 上报真实进度。
import path from 'node:path';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { probePython, degradeReason } from './py.mjs';
import { keyOf, isCoverName, ensureDirs, insideRoot, ownerOf, relInRoot } from './paths.mjs';
import { buildLibraryIndex, discoverUnits, byteDedupeUnits, makeShaCache, recordOf, VERDICTS, abortError } from './scan.mjs';
import { collectLibJobs, collectDupJobs, buildFingerprints, imagesIn } from './build-fp.mjs';
import { readScan, writeScan, readHash, writeHash } from './store.mjs';
import { generateThumbs, thumbPathOf } from './thumbs.mjs';
import { runPixelStage, grayStats, zMadOf } from './match.mjs';
import { readSet, readIndex, coarseOf, FP_GRAY_BYTES } from './fpio.mjs';
import { prefilterUnits } from './prefilter.mjs';
import { readLibraryIndex } from '../../../core/library-index.mjs';
import { atomicWriteJson } from '../../../core/util.mjs';

function num(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

/** 汇总各判定数量。 */
export function summaryOf(units) {
  const out = {};
  for (const v of VERDICTS) out[v] = 0;
  out['字节一致图片数'] = 0;
  out['像素一致图片数'] = 0;
  for (const u of units) {
    if (out[u.judge] === undefined) out[u.judge] = 0;
    out[u.judge]++;
    out['字节一致图片数'] += u.exactCount || 0;
    out['像素一致图片数'] += u.pixelCount || 0;
  }
  return out;
}

/** 库根数组 -> 给人看的标签列表。 */
function rootLabels(libRoots) {
  return (libRoots || []).map(function (r) { return r.name + '(' + r.path + ')'; }).join(' + ');
}

/**
 * 阶段 1：hash —— 索引多库根(0~0.15) / 递归发现单元(0.15~0.30) / SHA-256 字节查重(0.30~1.00)。
 * 产出 data/dedupe/scan-latest.json + data/dedupe/hash-result.json。
 */
export async function runHashStage(paths, report, ctx) {
  await ensureDirs(paths);
  if (!paths.scanRoot) throw Object.assign(new Error('未配置查重目录（ctx.config.dedupe.scanRoot）'), { statusCode: 400 });
  try { const st = await fsp.stat(paths.scanRoot); if (!st.isDirectory()) throw new Error('not dir'); }
  catch (e) { throw Object.assign(new Error('查重目录不存在或不可访问: ' + paths.scanRoot), { statusCode: 400 }); }
  if (!paths.libRoots || !paths.libRoots.length) throw Object.assign(new Error('未配置漫画库根（config.libraryRoots）'), { statusCode: 400 });

  report(0.0, '索引漫画库', 0, 0, '比对库根：' + rootLabels(paths.libRoots));
  const lib = await buildLibraryIndex(paths.libRoots, function (frac, label) {
    report(0.15 * frac, '索引漫画库', num(Math.round(frac * 1000), 0), 1000, '已索引: ' + label);
  }, { useSharedIndex: true, signal: ctx && ctx.signal });

  report(0.15, '发现比对单元', 0, 0, '递归查找「直接含图片的目录」…');
  const units = await discoverUnits(paths.scanRoot, function (n, rel) {
    report(0.15, '发现比对单元', n, 0, '已发现 ' + n + ' 个单元: ' + rel);
  }, ctx && ctx.signal);
  const dupImages = units.reduce(function (s, u) { return s + u.files.length; }, 0);
  const dupBytes = units.reduce(function (s, u) { return s + (u.bytes || 0); }, 0);
  report(0.30, '字节查重', 0, units.length, '共 ' + units.length + ' 个单元 / ' + dupImages + ' 张图，开始 SHA-256 比对');

  const pixelReview = ctx && ctx.pixelReview !== false;
  const dedup = await byteDedupeUnits(units, lib, {
    shaCache: makeShaCache(),
    pixelReview: pixelReview,
    hashConcurrency: num(ctx && ctx.hashConcurrency, 8),
    signal: ctx && ctx.signal,
    onProgress: function (frac) {
      const done = Math.round(frac * units.length);
      report(0.30 + 0.70 * frac, '字节查重', done, units.length, '已比对 ' + done + '/' + units.length + ' 个单元');
    }
  });

  const records = units.map(function (u) {
    return recordOf(u, {
      thumbCount: paths.thumbCount,
      pixelThreshold: paths.pixelThreshold,
      libRoots: paths.libRoots,
      libDir: u.cand ? u.cand.dir : '',
      libRootId: u.cand ? (u.cand.rootId || '') : '',
      libRootName: u.cand ? (u.cand.rootName || '') : '',
      matchBy: u.candSrc || '',
      pixelCount: 0,
      pixelMap: null
    });
  });
  const generatedAt = new Date().toISOString();
  const degraded = !probePython().pillow;
  const scan = {
    generatedAt: generatedAt,
    stage: 'hash',
    库: {
      漫画数: lib.comics.length, 章节数: lib.chapters.length, 图片数: lib.libImages,
      索引来源: lib.source || '',
      根数: paths.libRoots.length,
      按根: lib.byRoot || []
    },
    查重: { 单元数: units.length, 图片数: dupImages, 总字节: dupBytes, 总MB: Math.round((dupBytes / 1048576) * 10) / 10 },
    汇总: summaryOf(records),
    参数: {
      阈值: paths.pixelThreshold, 缩略图数量: paths.thumbCount, 像素复核: pixelReview,
      查重目录: paths.scanRoot, 库根: paths.libRoots.map(function (r) { return { id: r.id, name: r.name, path: r.path }; })
    },
    degraded: degraded,
    degradeReason: degraded ? degradeReason() : '',
    深度比对时间: null,
    units: records
  };
  await writeScan(paths, scan);

  // hash-result：exact 存绝对路径（多根下唯一），pixel 阶段据此定位候选章节与缩略图基准根
  const details = units.map(function (u) {
    const exact = {};
    for (const entry of u.exact.entries()) exact[entry[0]] = entry[1];
    return {
      id: u.id, dir: u.dir, files: u.files, bytes: u.bytes, candSrc: u.candSrc,
      exact: exact,
      nonExact: u.nonExact,
      candDir: u.cand ? u.cand.dir : '',
      candRootId: u.cand ? (u.cand.rootId || '') : '',
      candComic: u.cand ? u.cand.comic.name : '',
      candTitle: u.cand ? u.cand.chapterTitle : ''
    };
  });
  await writeHash(paths, { generatedAt: generatedAt, 库: scan.库, 查重: scan.查重, units: details });
  return { scan: scan, hash: { units: details }, exactTotal: dedup.exactTotal, needPixel: dedup.needPixel.length };
}

/**
 * 阶段 2：pixel —— 重建/增量指纹(0~0.25) / 全库像素搜索(0.25~1.00)。
 * 若缺 hash-result.json，会先跑一次 hash（占用本段 0~0.30 的进度）。
 */
export async function runPixelStageFull(paths, report, ctx) {
  await ensureDirs(paths);
  const o = ctx || {};
  let hash = await readHash(paths);
  let prev = await readScan(paths);
  let hashSpan = 1;
  if (!hash || !hash.units) {
    hashSpan = 0.30;
    report(0, '准备', 0, 0, '缺少 hash-result.json，先执行字节查重…');
    const res = await runHashStage(paths, function (frac, phase, cur, total, msg) { report(hashSpan * frac, phase, cur, total, msg); }, o);
    hash = res.hash;
    prev = res.scan;
  }
  const base = function (frac) { return hashSpan + (1 - hashSpan) * frac; };

  const probe = probePython();
  if (!probe.pillow) {
    const reason = degradeReason();
    report(1, '像素比对', 0, 0, '已降级：' + reason);
    if (prev) {
      prev.degraded = true;
      prev.degradeReason = reason;
      await writeScan(paths, prev);
    }
    return { scan: prev, degraded: true, reason: reason, stats: null };
  }

  const indexExists = existsSync(path.join(paths.fpLib, 'index.json'));
  const force = o.rebuildFp === true || !indexExists;
  // 首次扫描要逐张解码全库（约 6 万张、几分钟），必须写清楚在做什么、要等多久，
  // 否则用户会以为「卡住了」而放弃 —— 这正是之前「查重没招」的观感来源。
  report(base(0), '指纹索引', 0, 0, force ? '重建全部库根指纹（约 6 万张图，视机器需数分钟，请勿关闭）…' : '增量补齐指纹缓存…');
  const libJobs = await collectLibJobs(paths.libRoots, paths.fpLib, function (frac, label) {
    report(base(0.12 * frac), '指纹索引', num(Math.round(frac * 1000), 0), 1000, '登记章节: ' + label);
  }, o.signal);
  const dupJobs = collectDupJobs((hash.units || []).map(function (u) { return { id: u.id, dir: u.dir, files: u.files }; }), paths.fpDup);
  // 注意：collectDupJobs 按 u.dir 算 key；hash-result.json 里的 dir 是绝对路径，所以
  // 库格式升级（id 变了）之后指纹照样命中，不会白白重解十几万张图。
  const jobs = force ? libJobs.jobs.concat(dupJobs) : dupJobs;
  const fpRes = await buildFingerprints(paths, jobs, libJobs.index, {
    force: force,
    only: force ? '' : 'dup',
    cwd: o.cwd,
    onChild: o.onChild,
    onCancel: o.onCancel,
    onProgress: function (done, total) {
      const frac = total ? done / total : 0;
      report(base(0.12 + 0.13 * frac), '指纹索引', done, total, '指纹 ' + done + '/' + total);
    }
  });
  if (!fpRes.ok) {
    if (fpRes.degraded) {
      if (prev) { prev.degraded = true; prev.degradeReason = fpRes.reason; await writeScan(paths, prev); }
      report(1, '指纹索引', 0, 0, '已降级：' + fpRes.reason);
      return { scan: prev, degraded: true, reason: fpRes.reason, stats: null };
    }
    throw Object.assign(new Error(fpRes.reason || '指纹生成失败'), { statusCode: 500 });
  }

  report(base(0.25), '全库像素搜索', 0, (hash.units || []).length, '载入全部库根指纹并开始逐单元比对…');
  const prevById = new Map(((prev && prev.units) || []).map(function (u) { return [u.id, u]; }));
  const res = await runPixelStage(paths, {
    hash: hash,
    prevById: prevById,
    libRoots: paths.libRoots,
    pixelThreshold: paths.pixelThreshold,
    thumbCount: paths.thumbCount,
    signal: o.signal,
    // 必须把 onCancel 透传下去：像素比对现在跑在 worker_threads 里，
    // runner 的 killer 只有注册到 worker 上，用户点「中止」才能 terminate 掉它们
    onCancel: o.onCancel,
    onChild: o.onChild,
    onLog: o.onLog,
    onProgress: function (i, total, id) {
      const frac = total ? i / total : 0;
      // 并行时不需要把单元 id 拼进文案（会留下「已比对 12/140 个单元: 」这种空尾巴）
      const msg = id
        ? '已比对 ' + i + '/' + total + ' 个单元: ' + id
        : '已比对 ' + i + '/' + total + ' 个单元';
      report(base(0.25 + 0.75 * frac), '全库像素搜索', i, total, msg);
    }
  });
  const scan = {
    generatedAt: (prev && prev.generatedAt) || new Date().toISOString(),
    stage: 'pixel',
    深度比对时间: new Date().toISOString(),
    库: (prev && prev.库) || hash.库,
    查重: (prev && prev.查重) || hash.查重,
    汇总: res.summary,
    参数: (prev && prev.参数) || { 阈值: paths.pixelThreshold, 缩略图数量: paths.thumbCount, 查重目录: paths.scanRoot },
    degraded: false,
    degradeReason: '',
    searchStats: res.stats,
    units: res.units
  };
  await writeScan(paths, scan);
  return { scan: scan, degraded: false, reason: '', stats: res.stats, summary: res.summary };
}

/** 从扫描结果收集缩略图任务（samples 的首图对比；lib 侧按根解析绝对路径）。 */
export function collectThumbTasks(paths, scan) {
  const tasks = [];
  const seen = new Set();
  const rootById = new Map((paths.libRoots || []).map(function (r) { return [r.id, r]; }));
  for (const u of ((scan && scan.units) || [])) {
    if (!u.dupDir) continue;
    for (const s of (u.samples || [])) {
      const dupSrc = path.join(u.dupDir, s.dup);
      const dupDst = thumbPathOf(paths, u.id, 'dup', s.dup);
      if (!seen.has(dupDst) && insideRoot(paths.scanRoot, dupSrc)) { seen.add(dupDst); tasks.push({ src: dupSrc, dst: dupDst, size: 320 }); }
      if (s.lib && s.root) {
        const root = rootById.get(s.root);
        if (!root) continue;
        const libSrc = path.join(root.path, s.lib);
        const libDst = thumbPathOf(paths, u.id, 'lib', s.lib);
        if (!seen.has(libDst) && insideRoot(root.path, libSrc)) { seen.add(libDst); tasks.push({ src: libSrc, dst: libDst, size: 320 }); }
      }
    }
    // 库侧首图（卡片对比用），保证即便 samples 里没有 lib 也有图
    if (u.libRootId && u.libFirst) {
      const root = rootById.get(u.libRootId);
      if (root) {
        const src = path.join(root.path, u.libFirst);
        const dst = thumbPathOf(paths, u.id, 'lib', u.libFirst);
        if (!seen.has(dst) && insideRoot(root.path, src)) { seen.add(dst); tasks.push({ src: src, dst: dst, size: 320 }); }
      }
    }
  }
  return tasks;
}

/** 阶段 3：thumbs —— 为样本图生成 320px 缩略图（0~1）。 */
export async function runThumbsStage(paths, report, ctx) {
  await ensureDirs(paths);
  const o = ctx || {};
  const scan = await readScan(paths);
  if (!scan || !scan.units || !scan.units.length) throw Object.assign(new Error('还没有扫描结果，请先执行扫描'), { statusCode: 400 });
  const tasks = collectThumbTasks(paths, scan);
  report(0, '生成缩略图', 0, tasks.length, '待生成 ' + tasks.length + ' 张缩略图');
  const res = await generateThumbs(paths, tasks, {
    cwd: o.cwd,
    onChild: o.onChild,
    onCancel: o.onCancel,
    onProgress: function (done, total) {
      const frac = total ? done / total : 0;
      report(frac, '生成缩略图', done, total, '缩略图 ' + done + '/' + total);
    }
  });
  return { thumbs: res, tasks: tasks.length, scan: scan };
}

/**
 * 阶段：fast —— 快速查重（v7）。用零成本元数据预筛把候选对缩到几十个，
 * 只为候选章节 / 候选单元建指纹、只比候选章节，落盘 scan-fast.json（**绝不覆盖 scan-latest.json**）。
 *
 * 为什么需要它（用户原话「漫画多了后查重慢得要死，而且量大还要崩溃」）：
 * 完整扫描要为每个单元和 6.3 万张库图各比一遍，是固定重税（库侧指纹 7.6 分钟 + 查重侧 4.7 分钟），
 * 与单元数无关；而用户真正要做的是「找出对得上的，抽样交人眼判定」。
 *
 * 三级漏斗（每级只处理上一级的幸存者）：
 *   级 1 标题模糊 + 页数接近 —— 零成本，不读任何图片（engine/prefilter.mjs）
 *   级 2 只为「候选单元 + 候选章节」建指纹 —— 复用签名跳过，二次几乎免费
 *   级 3 只比候选章节 —— 绝不退化成全库扫
 * 然后交给人眼并排看抽样图判定。**系统绝不自动删除。**
 *
 * 与完整扫描的取舍：标题被改得面目全非的重复只有完整扫描抓得到，故两种模式并存。
 */
export async function runFastStage(paths, report, ctx) {
  await ensureDirs(paths);
  const o = ctx || {};
  const signal = o.signal || null;
  if (!paths.scanRoot) throw Object.assign(new Error('未配置查重目录（config.dedupe.scanRoot）'), { statusCode: 400 });
  try { const st = await fsp.stat(paths.scanRoot); if (!st.isDirectory()) throw new Error('not dir'); }
  catch (e) { throw Object.assign(new Error('查重目录不存在或不可访问: ' + paths.scanRoot), { statusCode: 400 }); }
  if (!paths.libRoots || !paths.libRoots.length) throw Object.assign(new Error('未配置漫画库根（config.libraryRoots）'), { statusCode: 400 });
  if (signal && signal.aborted) throw abortError();

  report(0.02, '读取漫画库索引', 0, 1, '读取 data/library-index.json…');
  let idx = null;
  try { idx = await readLibraryIndex(); } catch (e) { idx = null; }
  if (!idx || !Array.isArray(idx.comics) || !idx.comics.length) {
    throw Object.assign(new Error('漫画库索引为空，无法快速查重（请先在「漫画库」页扫描一次建立索引）'), { statusCode: 400 });
  }

  report(0.06, '发现比对单元', 0, 0, '递归查找「直接含图片的目录」…');
  const units = await discoverUnits(paths.scanRoot, function (n, rel) {
    report(0.06, '发现比对单元', n, 0, '已发现 ' + n + ' 个单元: ' + rel);
  }, signal);
  report(0.15, '元数据预筛', 0, units.length, '标题模糊 + 页数接近（零成本，不读图片）…');

  const cfgs = (o.config && o.config.dedupe) || {};
  const pfCfg = cfgs.prefilter || {};
  const pf = prefilterUnits(units, idx.comics, {
    titleThreshold: pfCfg.titleThreshold,
    pageTolerance: pfCfg.pageTolerance,
    maxCandidates: pfCfg.maxCandidates
  });
  if (signal && signal.aborted) throw abortError();
  report(0.18, '元数据预筛', pf.stats.units, pf.stats.units,
    '预筛完成：' + pf.stats.units + ' 个单元 → ' + pf.candidates.length + ' 个候选单元 / '
    + pf.stats.pairs + ' 个候选对（跳过 ' + Math.max(0, pf.stats.units - pf.candidates.length) + ' 个）');

  const filesById = new Map();
  const dirById = new Map();
  for (const u of units) { filesById.set(u.id, u.files.slice()); dirById.set(u.id, u.dir); }

  // 候选库作品 -> 候选章节。全部走 library-index.json 的结构，**不做任何目录遍历、不解码任何图片**。
  const rootById = new Map();
  for (const r of paths.libRoots) rootById.set(r.id, r);
  const idxRootByPath = new Map();
  for (const r of (idx.roots || [])) { if (r && r.path) idxRootByPath.set(path.resolve(String(r.path)), r); }
  function comicDirOf(comic) {
    const rel = String(comic.dir || comic.rel || comic.title || '');
    if (path.isAbsolute(rel)) return rel;
    // 共享索引里 comic.root 存的是根 id（如 picacg），不是路径，两者都要试；
    // 否则非首个库根的作品会被拼到首个根下，章节文件一个都找不到（该作品的候选被静默漏掉）。
    const r = rootById.get(String(comic.rootId || comic.root || ''));
    if (r) return path.join(r.path, rel);
    const abs = String(comic.root || '');
    if (path.isAbsolute(abs)) return path.join(abs, rel);
    return path.join(paths.libRoots[0].path, rel);
  }

  const chapters = [];
  const chapterByKey = new Map();
  const plan = [];
  for (const cand of pf.candidates) {
    const items = [];
    const matches = [];
    for (const m of cand.matches) {
      const comic = idx.comics.find(function (c) { return String(c.id) === String(m.libId); });
      if (!comic) continue;
      const cdir = comicDirOf(comic);
      const own0 = ownerOf(paths.libRoots, cdir);
      matches.push({
        libId: String(m.libId), libTitle: String(m.libTitle),
        libPages: m.libPages, titleScore: m.titleScore, pageDiff: m.pageDiff,
        pageDiffRatio: m.pageDiffRatio, reasons: m.reasons || [],
        libRootId: own0 ? own0.id : String(comic.rootId || ''),
        libRootName: own0 ? own0.name : String(comic.rootName || '')
      });
      const sub = (comic.chapters || []).slice().sort(function (a, b) { return chapterOrder(a) - chapterOrder(b); });
      for (const ch of sub) {
        const sdir = ch && ch.dir ? path.join(cdir, String(ch.dir)) : cdir;
        const count = (ch && Array.isArray(ch.images) ? ch.images.length : 0) || Number(ch && ch.count) || 0;
        if (!count) continue;
        const key = keyOf(sdir);
        let rec = chapterByKey.get(key);
        if (!rec) {
          const own = ownerOf(paths.libRoots, sdir);
          const fallbackRoot = rootById.get(String(comic.rootId || ''));
          rec = {
            key: key, dir: sdir, count: count,
            comic: comic.title || comic.dir || '', title: (ch && ch.title) || (ch && ch.dir) || '',
            rootId: own ? own.id : String(comic.rootId || ''),
            rootName: own ? own.name : String(comic.rootName || ''),
            rootPath: own ? own.path : (fallbackRoot ? fallbackRoot.path : paths.libRoots[0].path),
            files: null
          };
          chapterByKey.set(key, rec);
          chapters.push(rec);
        }
        items.push(rec);
      }
    }
    if (items.length) plan.push({ unitId: cand.unitId, unitPages: cand.unitPages, items: items, matches: matches });
  }

  // 级 2：只为候选建指纹。
  // 必须 force：指纹签名只认「mtime + 总字节 + 张数」，而只为候选章节建指纹会让同一个 .bin 的
  // 张数变少；不重算就会读到「整章全部图片」的旧指纹，候选区间的下标全部错位。
  //
  // 必须用独立目录：build-fp.py 无条件把本次的 index.json 写进 <libFp>/index.json，
  // 若直接写 paths.fpLib，完整扫描的库指纹索引就被「只含候选章节」的索引覆盖；
  // 之后 runPixelStageFull 只看 existsSync(fpLib/index.json) 就判定「库指纹还在」而跳过重建，
  // 于是完整扫描静默退化成「只比候选章节」。隔离后两条链路的指纹互不干扰。
  const fastFpLib = path.join(paths.tmp, 'fp-fast-lib');
  const fastFpDup = path.join(paths.tmp, 'fp-fast-dup');
  const fastPaths = Object.assign({}, paths, { fpLib: fastFpLib, fpDup: fastFpDup });
  const py = probePython();
  let pixelReady = false;
  const libJobs = [];
  const libIndex = [];
  const dupRecords = [];
  if (py.available && py.pillow && chapters.length) {
    report(0.20, '候选指纹', 0, chapters.length + plan.length, '为 ' + chapters.length + ' 个候选章节 / ' + plan.length + ' 个候选单元建指纹…');
    for (const rec of chapters) {
      let files = [];
      try { files = (await imagesIn(rec.dir)).filter(function (n) { return !isCoverName(n); }); } catch (e) { files = []; }
      rec.files = files;
      if (!files.length) continue;
      libJobs.push(['lib', rec.key, rec.dir, files, path.join(fastFpLib, rec.key + '.bin')]);
      libIndex.push({ key: rec.key, dir: rec.dir, comic: rec.comic, title: rec.title, count: files.length, rootId: rec.rootId, rootName: rec.rootName, rootPath: rec.rootPath });
    }
    for (const p of plan) {
      const files = filesById.get(p.unitId) || [];
      if (!files.length) continue;
      dupRecords.push({
        id: p.unitId, dir: dirById.get(p.unitId) || '', files: files, bytes: 0, candSrc: '元数据预筛',
        exact: {}, nonExact: files, candDir: p.items.length ? p.items[0].dir : '',
        candRootId: '', candComic: '', candTitle: ''
      });
    }
    const dupJobs = collectDupJobs(dupRecords, fastFpDup);
    const fpRes = await buildFingerprints(fastPaths, libJobs.concat(dupJobs), libIndex, {
      force: true, only: '', cwd: o.cwd, onChild: o.onChild, onCancel: o.onCancel,
      onProgress: function (done, total, msg) {
        if (!total) return;
        report(0.20 + 0.16 * Math.min(1, done / total), '候选指纹', done, total, msg || ('指纹 ' + done + '/' + total));
      }
    });
    pixelReady = fpRes.ok === true;
    if (!pixelReady) {
      const why = fpRes.reason || '指纹构建失败';
      report(0.36, '候选指纹', 1, 1, '像素证据不可用（' + why + '），改为只给元数据候选');
      if (o.onLog) { try { o.onLog('快速查重降级：' + why); } catch (e) { /* 忽略 */ } }
    }
  }

  const libView = pixelReady ? loadCandidateFingerprints(fastPaths, chapters.map(function (c) { return c.dir; }), libJobs.length || chapters.length) : null;
  const threshold = paths.pixelThreshold;

  // 字节级证据：只在「候选章节」这一小块库上做 SHA-256 完全比对（复用 byteDedupeUnits 的同口径），
  // 对上就是「完全重复」。完整扫描这步要哈希 6.3 万张库图，这里只哈希候选章节的几百张。
  const exactById = new Map();
  let exactTotal = 0;
  if (plan.length) {
    const mini = await buildCandidateLib(chapters);
    if (mini.libImages.length) {
      const byteUnits = [];
      for (const p of plan) {
        const files = filesById.get(p.unitId) || [];
        if (!files.length) continue;
        byteUnits.push({ id: p.unitId, name: p.unitId, dir: dirById.get(p.unitId) || '', files: files });
      }
      await byteDedupeUnits(byteUnits, mini, {
        shaCache: makeShaCache(), pixelReview: false,
        hashConcurrency: o.hashConcurrency || 4, signal: signal
      });
      for (const bu of byteUnits) exactById.set(bu.id, bu.exact || new Map());
    }
  }

  // 级 3：只比候选章节（绝不退化成全库扫）
  const outUnits = [];
  for (let pi = 0; pi < plan.length; pi++) {
    if (signal && signal.aborted) throw abortError();
    const p = plan[pi];
    const u = units.find(function (x) { return x.id === p.unitId; }) || { id: p.unitId, name: p.unitId, category: '', dir: dirById.get(p.unitId) || '', files: [], bytes: 0 };
    const files = filesById.get(p.unitId) || [];
    if (!files.length) continue;
    // 指纹按单元所在目录定位（与 collectDupJobs 同口径）
    const fpUnitDir = dirById.get(p.unitId) || p.unitId;
    const fp = pixelReady ? readSet(path.join(fastFpDup, keyOf(fpUnitDir) + '.bin')) : null;
    const fpFiles = fp && fp.names.length ? fp.names.map(function (x) { return x.name; }) : files;
    const rows = [];
    for (const rec of p.items) {
      let cover = null;
      // 没有指纹视图或该单元的指纹文件缺失时 cover 保持 null：让下面的粗校验兜底能生效，
      // 也让判定退回「待人工复核」而不是谎报「未找到」。
      if (libView && fp) {
        const ci = libView.chapters.findIndex(function (c) { return path.resolve(String(c.dir)) === path.resolve(rec.dir); });
        if (ci >= 0) cover = computeCoverageOf(libView, fpFiles, fp, libView.chapters[ci], threshold);
      }
      // 无像素证据时的零成本兜底：读章节元数据 json 比对文件名（不解码图片）
      let titleMatch = null;
      if (!cover) {
        const want = await chapterBaseNames(rec.dir);
        if (want.length) {
          let hit = 0;
          for (const n of files) if (want.indexOf(baseNameOf(n)) >= 0) hit++;
          titleMatch = hit / files.length;
        }
      }
      rows.push({ rec: rec, cover: cover, titleMatch: titleMatch });
    }
    rows.sort(function (a, b) {
      const av = a.cover ? a.cover.cov : -1;
      const bv = b.cover ? b.cover.cov : -1;
      if (av !== bv) return bv - av;
      const am = a.titleMatch === null ? -1 : a.titleMatch;
      const bm = b.titleMatch === null ? -1 : b.titleMatch;
      return bm - am;
    });
    const best = rows.length ? rows[0] : null;
    const worth = rows.filter(function (r) { return isCandidateWorth(r.cover ? r.cover.cov : null, r.titleMatch); });
    // 有像素证据时只保留「真的比得上」的候选；没证据时全部留给人眼看（界面会写明降级原因）
    const hasProof = pixelReady && Boolean(fp);
    if (hasProof && !worth.length) continue;
    const keepRows = (worth.length ? worth : rows).slice(0, MAX_FAST_CHAPTERS);
    const pixels = best && best.cover ? best.cover.pixel : 0;
    // 字节一致与像素一致不重复计数（与完整扫描的 recordOf 同口径）
    const exactMap = exactById.get(p.unitId) || null;
    const exactCount = exactMap ? exactMap.size : 0;
    let exactInPixel = 0;
    if (exactMap && best && best.cover && best.cover.pairs) {
      for (const n of exactMap.keys()) if (best.cover.pairs[n]) exactInPixel++;
    }
    const pixelOnly = Math.max(0, pixels - exactInPixel);
    const matched = exactCount + pixelOnly;
    const coverageRatio = files.length ? matched / files.length : 0;
    exactTotal += exactCount;
    // 字节证据本身就是铁证：即使像素链路降级，也能落「完全重复」而不是含糊的「待人工复核」
    let judge = '待人工复核';
    if (hasProof || exactCount > 0) {
      if (files.length > 0 && exactCount >= files.length) judge = '完全重复';
      else if (coverageRatio >= 0.9) judge = '同图不同编码';
      else if (coverageRatio >= 0.3) judge = '部分重复';
      else judge = '未找到';
    }
    const own = best ? ownerOf(paths.libRoots, best.rec.dir) : null;
    const libRel = best ? (own ? relInRoot(own.path, best.rec.dir) : relInRoot(best.rec.rootPath, best.rec.dir)) : '';
    const libComic = best ? (libRel ? libRel.split('/')[0] : '') : '';
    const rec = {
      id: u.id, name: u.name, category: u.category || '',
      comic: best ? (libComic || best.rec.comic) : '',
      chapter: best ? best.rec.key : '',
      chapterTitle: best ? best.rec.title : '',
      matchBy: '元数据预筛 + 候选章节像素',
      libRootId: best ? best.rec.rootId : '',
      libRootName: best ? best.rec.rootName : '',
      libDirRel: best ? (path.relative(best.rec.rootPath, best.rec.dir) || '').split(path.sep).join('/') : '',
      libFirst: '',
      unitPages: files.length,
      dupCount: files.length,
      libCount: best ? best.rec.count : 0,
      dupBytes: u.bytes || 0,
      dupMB: Math.round(((u.bytes || 0) / 1048576) * 10) / 10,
      exactCount: exactCount,
      pixelCount: pixelOnly,
      missingCount: Math.max(0, files.length - matched),
      matchRatio: Math.round(coverageRatio * 1000) / 1000,
      scatterHits: 0,
      judge: judge,
      coverage: best && best.cover ? best.cover : null,
      samples: markExactSamples(buildFastSamples(libView, fp, fpFiles, best, files, threshold, paths.thumbCount), exactMap, paths.libRoots),
      dupDir: dirById.get(p.unitId) || '',
      libDir: best ? best.rec.dir : '',
      maxMad: null, madHist: null, farCount: 0,
      checkedImages: files.length, scoredImages: pixels, filteredOut: Math.max(0, files.length - pixels),
      candSrc: '元数据预筛',
      matches: p.matches,
      fast: {
        mode: 'fast', pixelReady: pixelReady, unitPages: files.length,
        chapters: keepRows.map(function (r) {
          return {
            key: r.rec.key, dir: r.rec.dir, comic: r.rec.comic, title: r.rec.title,
            rootId: r.rec.rootId, rootName: r.rec.rootName, count: r.rec.count,
            cov: r.cover ? Math.round(r.cover.cov * 1000) / 1000 : null,
            pixel: r.cover ? r.cover.pixel : null,
            titleMatch: r.titleMatch === null ? null : Math.round(r.titleMatch * 1000) / 1000
          };
        }),
        chapterTotal: rows.length
      }
    };
    outUnits.push(rec);
    if (o.onProgress) o.onProgress(pi + 1, plan.length, u.id);
    report(0.36 + 0.62 * ((pi + 1) / plan.length), '候选比对', pi + 1, plan.length, '已比对 ' + (pi + 1) + '/' + plan.length + ' 个候选单元');
    await sleep(0);
  }

  const fast = {
    generatedAt: new Date().toISOString(),
    stage: 'fast',
    mode: 'fast',
    库: {
      漫画数: idx.comics.length,
      索引来源: 'library-index',
      按根: paths.libRoots.map(function (r) {
        return { id: r.id, name: r.name, path: r.path, comics: idx.comics.filter(function (c) { return String(c.rootId || '') === r.id; }).length };
      })
    },
    查重: {
      单元数: units.length,
      图片数: units.reduce(function (s, u) { return s + u.files.length; }, 0),
      总字节: units.reduce(function (s, u) { return s + (u.bytes || 0); }, 0),
      总MB: Math.round((units.reduce(function (s, u) { return s + (u.bytes || 0); }, 0) / 1048576) * 10) / 10
    },
    预筛: {
      阈值: {
        标题: pfCfg.titleThreshold === undefined ? 0.35 : Number(pfCfg.titleThreshold),
        页数容差: pfCfg.pageTolerance === undefined ? 0.05 : Number(pfCfg.pageTolerance)
      },
      单元数: pf.stats.units,
      有候选单元数: pf.stats.unitsWithCandidate,
      候选对数: pf.stats.pairs,
      截断单元数: pf.stats.omittedUnits,
      候选章节数: chapters.length,
      像素证据: pixelReady,
      字节一致图片数: exactTotal
    },
    汇总: summaryOf(outUnits),
    参数: {
      阈值: paths.pixelThreshold, 缩略图数量: paths.thumbCount,
      查重目录: paths.scanRoot,
      库根: paths.libRoots.map(function (r) { return { id: r.id, name: r.name, path: r.path }; })
    },
    degraded: !pixelReady,
    degradeReason: pixelReady ? '' : '像素证据不可用（缺少 Python/Pillow 或指纹构建失败），本轮只给元数据候选，请以抽样图人工判定为准',
    units: outUnits
  };
  const fastFile = path.join(paths.root, 'scan-fast.json');
  await atomicWriteJson(fastFile, fast);
  fast.savedTo = fastFile;
  return {
    // 任务书冻结形状：{ units, summary, stats }，与 runPixelStage 一致，供 index.mjs 透传；
    // scan / fastFile 一并带上，方便 runner 与验收脚本直接取落盘产物。
    units: outUnits, summary: fast.汇总,
    stats: {
      units: outUnits.length, candidates: plan.length, libChapters: chapters.length,
      pixelReady: pixelReady, exactImages: exactTotal
    },
    scan: fast, fastFile: fastFile
  };
}

// ---------- 快速模式内部件 ----------

/**
 * 把候选章节拼成 byteDedupeUnits 需要的迷你库视图。
 * 只有候选章节的 sizeIdx —— 哈希比对绝不会碰到候选之外的库图（这正是快速模式的前提）。
 */
async function buildCandidateLib(chapters) {
  const sizeIdx = new Map();
  const libImages = [];
  const byRoot = new Map();
  for (const rec of chapters) {
    const files = rec.files || [];
    if (!files.length) continue;
    const comic = {
      dir: path.dirname(rec.dir), name: rec.comic, title: rec.comic,
      rootId: rec.rootId, rootName: rec.rootName, rootPath: rec.rootPath
    };
    const ch = {
      dir: rec.dir, name: path.basename(rec.dir), comic: comic, chapterId: '',
      chapterTitle: rec.title, order: null, files: files.slice(), fileSet: new Set(files)
    };
    for (const n of files) {
      const abs = path.join(rec.dir, n);
      let size = 0;
      try { size = (await fsp.stat(abs)).size; } catch (e) { size = 0; }
      const arr = sizeIdx.get(size) || [];
      arr.push({ abs: abs, ch: ch });
      sizeIdx.set(size, arr);
      libImages.push(abs);
    }
    byRoot.set(rec.rootId, (byRoot.get(rec.rootId) || 0) + files.length);
  }
  return { chapterById: new Map(), sizeIdx: sizeIdx, libImages: libImages, byRoot: byRoot, source: 'fast-candidates' };
}

/** 抽样图里把「字节级完全一致」的页标出来（exact=true / mad=0，lib 换成命中图相对库根的路径）。 */
function markExactSamples(samples, exactMap, libRoots) {
  if (!exactMap || !exactMap.size) return samples;
  for (const s of samples) {
    const abs = exactMap.get(s.dup);
    if (!abs) continue;
    s.exact = true;
    s.mad = 0;
    const own = ownerOf(libRoots, abs);
    if (own) { s.lib = relInRoot(own.path, abs); s.root = own.id; }
  }
  return samples;
}

/** 快速模式最多给界面展示多少个候选章节（防止同名作品几十个时界面爆炸）。 */
export const MAX_FAST_CHAPTERS = 12;
/** 候选单元最多保留多少张抽样图（用户实际要在界面上并排看的数量）。 */
export const MAX_FAST_SAMPLES = 6;
/** 平坦页下限：低于它视为平坦页，z 归一化会把噪声放大（与 engine/match.mjs 的 SD_FLOOR 一致）。 */
const SD_FLOOR = 8;

/** 让出事件循环（重活之间必须把 SSE 进度推出去）。 */
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/** 四舍五入到两位小数（与 engine/match.mjs 的 round2 同口径）。 */
function round2(v) { return Math.round(Number(v) * 100) / 100; }

/** 取文件名的自然序号前缀（00000001.webp -> 1）；取不到返回 -1。 */
function fileSeqOf(name) {
  const m = /^(\d{1,9})/.exec(String(name || ''));
  return m ? Number(m[1]) : -1;
}

/** 去掉扩展名的基名（章节元数据里的文件名与实际文件名的对应口径）。 */
function baseNameOf(file) { return String(file || '').replace(/\.[^.]+$/, ''); }

/** 章节排序：优先元数据 order（可能缺失），缺失时排到最后按目录名顺序。 */
function chapterOrder(ch) {
  const n = Number(ch && ch.order);
  return Number.isFinite(n) ? n : 1e9;
}

/** 库侧 z 归一化预算；sd 低于 SD_FLOOR 时返回 0（zMadOf 内部据此退回 raw MAD）。 */
function invOf(sd) { return sd < SD_FLOOR ? 0 : 1 / sd; }

/** 按自然序号排序（缺序号的排到最后，同序号按名字）；返回新数组。 */
function sortBySeq(list) {
  return list.slice().sort(function (a, b) {
    const x = fileSeqOf(a); const y = fileSeqOf(b);
    if (x < 0 && y < 0) return a < b ? -1 : (a > b ? 1 : 0);
    if (x < 0) return 1;
    if (y < 0) return -1;
    if (x !== y) return x - y;
    return a < b ? -1 : 1;
  });
}

/**
 * 读章节元数据 json（只读文本，**不解码任何图片**），返回章节内文件的「基名」集合。
 * 用途：快速模式拿不到像素证据时的兜底信号（文件名粗校验），零成本。
 */
async function chapterBaseNames(dir) {
  const out = [];
  try {
    const text = await fsp.readFile(path.join(dir, '章节元数据.json'), 'utf8');
    const meta = JSON.parse(text.replace(/^\uFEFF/, ''));
    const imgs = meta && (meta.images || meta.图片);
    if (Array.isArray(imgs)) {
      for (const it of imgs) {
        const n = typeof it === 'string' ? it : (it && (it.name || it.文件名));
        if (n) out.push(baseNameOf(n));
      }
    }
  } catch (e) { /* 没有章节元数据就是空 */ }
  return out;
}

/**
 * 只读一章的指纹，按「自然序号相邻」把库侧图与查重侧图配对，算 z-MAD。
 * 返回 { total, pixel, cov, pairs, count }；缺指纹或章节不在指纹索引里返回 cov=0。
 *
 * 为什么按「序号相邻」而不是「文件名相同」：实测同一部作品的两次转码连文件名都不一样
 * （查重侧 00000001.webp ↔ 库侧 001.jpg），且库侧常多一张封面导致整段错位一位；
 * 所以配对只能靠页面位置，不能靠文件名。
 */
export function computeCoverageOf(lib, files, fp, chapter, threshold) {
  const cover = { total: files ? files.length : 0, exact: 0, pixel: 0, cov: 0, pairs: {}, count: chapter ? chapter.count : 0 };
  if (!lib || !fp || !chapter || !chapter.count) return cover;
  const libArr = [];
  for (let i = 0; i < chapter.count; i++) {
    const name = lib.names[chapter.start + i];
    if (name === undefined) continue;
    libArr.push({ name: String(name), seq: fileSeqOf(name), libIdx: chapter.start + i });
  }
  libArr.sort(function (a, b) {
    if (a.seq < 0 && b.seq < 0) return a.name < b.name ? -1 : 1;
    if (a.seq < 0) return 1;
    if (b.seq < 0) return -1;
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.name < b.name ? -1 : 1;
  });
  const dupArr = sortBySeq(files || []);
  let hits = 0;
  for (let i = 0; i < dupArr.length; i++) {
    const l = libArr[i];
    if (!l) continue;                                  // 查重侧比库侧多的尾部页：没有配对对象
    const qoff = fp.offsets.get(dupArr[i]);
    if (qoff === undefined) continue;
    const qs = grayStats(fp.buf, qoff);
    const mad = zMadOf(lib, fp.buf, qoff, qs.m, invOf(qs.sd), l.libIdx);
    if (mad > threshold) continue;
    hits++;
    cover.pairs[dupArr[i]] = { n: l.libIdx, mad: round2(mad) };
  }
  cover.pixel = hits;
  cover.cov = cover.total ? hits / cover.total : 0;
  return cover;
}

/**
 * 为一组候选章节装载**只读指纹视图**。返回结构与 engine/match.mjs 的
 * loadLibraryFingerprints 同形（chapters/names/N/gray/…），便于直接复用 zMadOf / grayStats。
 * 只装载候选章节的 .bin（index 是主进程写进去的，只含候选），**绝不碰全库 1236 个指纹文件**。
 *
 * 注意：wantedDirs 为空时必须返回 null 而不是「不过滤」。早先写成 `if (wanted.size && !wanted.has(...)) continue`，
 * 空列表会让过滤条件整体失效 → 把整库 1236 个指纹全读进来（约 19 分钟的重税），恰好是快速查重要消灭的东西。
 */
export function loadCandidateFingerprints(paths, wantedDirs, _hint) {
  const index = readIndex(paths.fpLib);
  if (!index || !index.length) return null;
  const wanted = new Set((wantedDirs || []).map(function (d) { return path.resolve(String(d)); }));
  if (!wanted.size) return null;
  const chapters = [];
  const names = [];
  const chOf = [];
  const grayParts = [];
  for (const c of index) {
    if (!wanted.has(path.resolve(String(c.dir || '')))) continue;
    const set = readSet(path.join(paths.fpLib, c.key + '.bin'));
    if (!set) continue;
    const ci = chapters.length;
    chapters.push({
      key: c.key, dir: c.dir, comic: c.comic, title: c.title,
      rootId: c.rootId || '', rootName: c.rootName || '', rootPath: c.rootPath || '',
      start: names.length, count: 0
    });
    for (const item of set.names) {
      const off = set.offsets.get(item.name);
      if (off === undefined) continue;
      names.push(item.name);
      chOf.push(ci);
      grayParts.push(set.buf.subarray(off, off + FP_GRAY_BYTES));
    }
    chapters[ci].count = names.length - chapters[ci].start;
  }
  const N = names.length;
  if (!N) return null;
  const gray = Buffer.concat(grayParts, N * FP_GRAY_BYTES);
  const coarse = new Uint8Array(N * 64);
  for (let i = 0; i < N; i++) coarse.set(coarseOf(gray, i * FP_GRAY_BYTES), i * 64);
  const lmean = new Float32Array(N);
  const lsd = new Float32Array(N);
  const linv = new Float32Array(N);
  const lnrm = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const st = grayStats(gray, i * FP_GRAY_BYTES);
    const iv = invOf(st.sd);
    lmean[i] = st.m; lsd[i] = st.sd; linv[i] = iv; lnrm[i] = st.m * iv;
  }
  return { chapters: chapters, names: names, chOf: chOf, gray: gray, coarse: coarse, lmean: lmean, lsd: lsd, linv: linv, lnrm: lnrm, N: N, map: null };
}

/**
 * 候选章节是否值得进入「候选复核」列表。
 * 有像素证据：cov >= 0.30（部分重复及以上）就算；
 * 没有像素证据：退化成「章节元数据文件名命中率 >= 0.5」。
 */
export function isCandidateWorth(cov, titleMatch) {
  if (cov !== null && cov !== undefined) return cov >= 0.3;
  if (titleMatch !== null && titleMatch !== undefined) return titleMatch >= 0.5;
  return false;
}

/**
 * 生成候选对的抽样图（查重侧 + 库侧并排）。
 * 抽样按整章等距取，保证覆盖全篇而不是固定看前几张；库侧取最佳章节的自然序第 i 张。
 * 每张带上该页的 z-MAD（有命中才有值），界面上直接显示「这一页有多像」。
 */
export function buildFastSamples(libView, fp, fpFiles, best, unitFiles, threshold, thumbCount) {
  const out = [];
  if (!best) return out;
  const rec = best.rec;
  let libNames = [];
  if (libView) {
    const ci = libView.chapters.findIndex(function (c) { return path.resolve(String(c.dir)) === path.resolve(rec.dir); });
    if (ci >= 0) {
      const c = libView.chapters[ci];
      for (let i = 0; i < c.count; i++) {
        const n = libView.names[c.start + i];
        if (n !== undefined) libNames.push(String(n));
      }
      libNames = sortBySeq(libNames);
    }
  }
  const q = sortBySeq(fpFiles && fpFiles.length ? fpFiles : unitFiles);
  const n = Math.max(1, Math.min(Number(thumbCount) || 6, MAX_FAST_SAMPLES, q.length));
  for (let i = 0; i < n; i++) {
    const qIdx = n === 1 ? 0 : Math.round((i * (q.length - 1)) / (n - 1));
    const lIdx = libNames.length ? (n === 1 ? 0 : Math.round((i * (libNames.length - 1)) / (n - 1))) : -1;
    const dupName = q[qIdx];
    const libName = lIdx >= 0 ? libNames[lIdx] : '';
    const hit = best.cover && best.cover.pairs ? best.cover.pairs[dupName] : null;
    out.push({
      dup: dupName || '',
      lib: libName ? relInRoot(rec.rootPath, path.join(rec.dir, libName)) : '',
      root: rec.rootId || '',
      exact: false,
      mad: hit ? hit.mad : null
    });
  }
  return out;
}
