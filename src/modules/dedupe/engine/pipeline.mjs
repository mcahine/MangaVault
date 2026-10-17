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
import { summaryOf } from './summary.mjs';
import { generateThumbs, thumbPathOf } from './thumbs.mjs';
import { runPixelStage } from './pixel-search.mjs';


function num(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

/* summaryOf 实现移到了 summary.mjs（pipeline 与 pipeline-fast 共用，放在这里会形成循环 import），
   这里重导出保持调用方路径不变。 */
export { summaryOf } from './summary.mjs';

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

/* 快速查重（人在环）整套实现已拆到 pipeline-fast.mjs；这里重导出，调用方路径不变。 */
export {
  runFastStage, MAX_FAST_CHAPTERS, MAX_FAST_SAMPLES,
  computeCoverageOf, loadCandidateFingerprints, isCandidateWorth, buildFastSamples
} from './pipeline-fast.mjs';
