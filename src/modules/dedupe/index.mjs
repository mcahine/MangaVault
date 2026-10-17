// 查重模块（dedupe-smith）：扫描 / 指纹 / 多库根像素比对 / 人工审核 / 删除执行。
// 契约见 docs/MODULE_CONTRACT.md；所有产物只写 data/dedupe/ 下。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../core/log.mjs';
import { dataDir } from '../../core/config.mjs';
import { safeJoin, ensureDir, atomicWriteJson, readJson } from '../../core/util.mjs';
import { probeRoots } from '../../core/roots.mjs';
import { resolvePaths, insideRoot, isPlainFileName, isSafeRelPath, isImageName, ownerOf, relInRoot } from './engine/paths.mjs';
import { naturalCompare } from '../../core/util.mjs';
import { probePython, degradeReason } from './engine/py.mjs';
import { createRunner, STAGES, STAGE_LABEL } from './engine/runner.mjs';
import { readScan, writeScan, readHash, readDecisions, setDecision, statsOf, readState, readDeleteLog } from './engine/store.mjs';
import { validateDeleteRequest, executeDelete, restoreQuarantine, listQuarantine, shellExe, DELETE_MODES } from './engine/delete.mjs';
import { ensureThumb } from './engine/thumbs.mjs';
import { generateCovers } from './engine/covers.mjs';
import { withHeartbeat } from '../../core/heartbeat.mjs';

/* 视图辅助（views.mjs）与删除回写（delete-apply.mjs）从本文件拆出，这里只做装配。 */
import {
  fastFileOf, dirOk, numOrNull, candidatesFromFast, score01, roughNorm, roughTitleScore,
  thumbUrlOf, libSampleOf, firstDupImageOf, samplesOf
} from './views.mjs';
import { makeApplyDeleteToScan } from './delete-apply.mjs';


export const meta = {
  id: 'dedupe',
  name: '查重',
  description: '扫描查重目录，与多库根漫画库做 SHA-256 字节查重和 32x32 像素比对，人工审核后删除',
  order: 40,
  help: [
    'GET  /api/dedupe/state',
    'POST /api/dedupe/scan',
    'GET  /api/dedupe/scan/events',
    'POST /api/dedupe/scan/abort',
    'GET  /api/dedupe/units?libRoot=<id>&deleted=1',  // deleted=1 才包含「已删除」单元
    'GET  /api/dedupe/candidates',
    'GET  /api/dedupe/unit/:id',
    'GET  /api/dedupe/thumb?unit=<id>&side=lib&root=<id>&name=<相对根路径>',
    'POST /api/dedupe/decision',
    'POST /api/dedupe/delete',
    'POST /api/dedupe/restore',
    'GET  /api/dedupe/stats'
  ]
};

export const VERDICTS = ['完全重复', '同图不同编码', '部分重复', '未找到'];
// 'deleted' 由「执行删除」后的回写登记（表示磁盘上已经删掉了），用户界面上不可手动选择。
const DECISION_VERDICTS = ['keep', 'delete', 'pending', 'deleted'];

let runner = null;
let logger = null;
let moduleCtx = null;

/**
 * 每次请求都重新读取合并配置，保证设置页改了查重/库根立刻生效。
 * 注意：请求上下文 c 上没有 config/dataDir，只能用 register(app, ctx) 捕获的那个。
 */
async function pathsOf() {
  const base = moduleCtx || {};
  let cfg = base.config;
  try { if (typeof base.reloadConfig === 'function') cfg = await base.reloadConfig(); } catch (e) { cfg = base.config; }
  const dir = base.dataDir || dataDir();
  return resolvePaths(cfg, dir);
}

/** 在最近一次扫描结果里找单元。 */
function findUnit(scan, id) {
  if (!scan || !Array.isArray(scan.units)) return null;
  return scan.units.find(function (u) { return u.id === id; }) || null;
}

/*
  在「完整扫描」和「快速查重」两边一起找单元。
  为什么必须两边都找：候选复核页的卡片来自 scan-fast.json，而缩略图路由原先只认
  scan-latest.json —— 用户只跑过快速查重时，候选卡片张张都是「图片读取失败」，
  整个候选复核就废了（这不是报错，是静默降级，最容易被放过）。
  两边 id 口径一致；完整扫描优先，因为它带 hits 等更全的字段。
*/
async function findUnitAny(paths, id, knownScan) {
  const scan = knownScan || await readScan(paths);
  const hit = findUnit(scan, id);
  if (hit) return hit;
  let fast = null;
  try { fast = await readJson(fastFileOf(paths), null); } catch (e) { fast = null; }
  const list = (fast && Array.isArray(fast.units)) ? fast.units : [];
  return list.find(function (u) { return u && u.id === id; }) || null;
}

/** 单元列表用的精简结构（含多根标识）。 */
function compactUnit(u, decisions) {
  const d = (decisions && decisions[u.id]) || null;
  return {
    id: u.id, name: u.name, category: u.category, comic: u.comic, chapter: u.chapter, chapterTitle: u.chapterTitle,
    judge: u.judge, matchBy: u.matchBy,
    libRootId: u.libRootId || '', libRootName: u.libRootName || '',
    libDirRel: u.libDirRel || '', libFirst: u.libFirst || '',
    dupCount: u.dupCount, libCount: u.libCount, dupBytes: u.dupBytes, dupMB: u.dupMB,
    exactCount: u.exactCount, pixelCount: u.pixelCount, missingCount: u.missingCount, matchRatio: u.matchRatio,
    samples: u.samples || [], hitChapters: u.hitChapters || [],
    dupDir: u.dupDir, libDir: u.libDir,
    coverage: u.coverage || null,
    maxMad: u.maxMad, madHist: u.madHist, farCount: u.farCount,
    checkedImages: u.checkedImages, scoredImages: u.scoredImages, filteredOut: u.filteredOut,
    decision: d ? { verdict: d.verdict || 'pending', note: d.note || '', updatedAt: d.updatedAt || '' } : { verdict: 'pending', note: '', updatedAt: '' }
  };
}

/**
 * 单元是否已被登记为「已删除」。
 * 判据只看 decisions[id].verdict —— judge 字段（完全重复 / 同图不同编码 …）是扫描时的
 * 查重判定，删除并不会、也不该改写它；决定列表可见性的是「已删除标记」。
 */
export function isDeletedUnit(unit, decisions) {
  const d = unit && decisions ? decisions[unit.id] : null;
  return Boolean(d && d.verdict === 'deleted');
}

/** 剔除已删除单元：列表与统计必须走同一口径，否则「列表少了、统计没少」。 */
export function visibleUnits(units, decisions) {
  return (Array.isArray(units) ? units : []).filter(function (u) { return !isDeletedUnit(u, decisions); });
}

/** 统计用的扫描副本：已删除单元不计入（列表已经不含它们了）。 */
function scanForStats(scan, decisions) {
  if (!scan || !Array.isArray(scan.units)) return scan;
  const units = visibleUnits(scan.units, decisions);
  if (units.length === scan.units.length) return scan;
  return Object.assign({}, scan, { units: units });
}

/** 库根（比对用）+ 体检（存在性/目录数），供 /state 与 /units 用。 */
/* probeRoots 结果短缓存。
   为什么需要：状态接口每次请求都会调它，而它要对每个库根做 stat + readdir。
   扫描期间前端每隔一两秒轮询一次，重活叠加会把事件循环和 libuv 线程池挤满，
   实测出现「state 请求超时」，界面看进度条就像卡死。库根目录数量 2 秒内不会变，
   缓存 2 秒既不影响「新建库根立刻可见」，又让轮询变得极轻。 */
let rootsCache = { key: '', at: 0, value: [] };

async function rootsInfo(paths, cfg) {
  const key = (paths.libRoots || []).map(function (r) { return r.id + '|' + r.path; }).join(',');
  if (rootsCache.key === key && Date.now() - rootsCache.at < 2000) return rootsCache.value;
  let probed = [];
  try { probed = await probeRoots(cfg || {}); } catch (e) { probed = []; }
  const inUse = new Set((paths.libRoots || []).map(function (r) { return r.id; }));
  const probeById = new Map(probed.map(function (r) { return [r.id, r]; }));
  const result = (paths.libRoots || []).map(function (r) {
    const p = probeById.get(r.id) || {};
    return { id: r.id, name: r.name, path: r.path, inUse: true, exists: p.exists !== false, dirs: p.dirs || 0, error: p.error || null };
  }).concat(probed.filter(function (r) { return !inUse.has(r.id); }).map(function (r) {
    return { id: r.id, name: r.name, path: r.path, inUse: false, enabled: r.enabled !== false, exists: r.exists, dirs: r.dirs, error: r.error };
  }));
  rootsCache = { key: key, at: Date.now(), value: result };
  return result;
}

export async function register(app, ctx) {
  moduleCtx = ctx;
  logger = createLogger('dedupe', ctx.config.logLevel);
  runner = createRunner({
    getPaths: function () { return pathsOf(); },
    cwd: ctx.projectRoot,
    log: logger,
    hashConcurrency: 8
  });
  const log = logger;

  // ---------- 状态 ----------
  app.get('/api/dedupe/state', async function (c) {
    const paths = await pathsOf();
    const scan = await readScan(paths);
    const decisions = await readDecisions(paths);
    const persisted = await readState(paths);
    const probe = probePython();
    const roots = await rootsInfo(paths, c.mvConfig || moduleCtx.config);
    c.json({
      ok: true,
      running: runner.running,
      progress: runner.progressPayload(),
      configured: paths.configured,
      scanRoot: paths.scanRoot,
      libRoots: paths.libRoots.map(function (r) { return { id: r.id, name: r.name, path: r.path }; }),
      libRoot: paths.libRoot,
      roots: roots,
      pixelThreshold: paths.pixelThreshold,
      thumbCount: paths.thumbCount,
      pixelReview: paths.pixelReview,
      dataDir: paths.root,
      quarantineDir: paths.quarantine,
      scanRootExists: paths.scanRoot ? await dirOk(paths.scanRoot) : false,
      libRootExists: paths.libRoots.some(function (r) { const p = roots.find(function (x) { return x.id === r.id; }); return p && p.exists; }),
      lib: (scan && scan.库) || null,
      lastScanAt: persisted.lastScanAt || (scan && scan.generatedAt) || '',
      lastStage: (scan && scan.stage) || '',
      deepMatchAt: (scan && scan.深度比对时间) || '',
      lastError: persisted.lastError || '',
      degraded: Boolean(scan && scan.degraded),
      degradeReason: (scan && scan.degradeReason) || degradeReason(),
      lastResult: persisted.lastResult || null,
      stats: scan ? statsOf(scanForStats(scan, decisions), decisions) : null,
      stages: STAGES.map(function (s) { return { id: s, label: STAGE_LABEL[s] }; }),
      deleteModes: DELETE_MODES,
      shell: shellExe() || '',
      python: { available: probe.available, exe: probe.exe, pillow: probe.pillow, pillowVersion: probe.pillowVersion, reason: probe.reason }
    });
  });


  /* 删除之后回写扫描结果（delete-apply.mjs 的工厂）。 */
  const applyDeleteToScan = makeApplyDeleteToScan(log);

  // ---------- 扫描 ----------
  app.post('/api/dedupe/scan', async function (c) {
    const body = c.body || {};
    const stage = body.stage === undefined || body.stage === null || body.stage === '' ? 'full' : String(body.stage);
    if (!STAGES.includes(stage)) c.throwError(400, '未知扫描阶段: ' + stage + '（可选 ' + STAGES.join(' / ') + '）');
    const paths = await pathsOf();
    if (!paths.scanRoot) c.throwError(400, '未配置查重目录（设置 → 查重 → scanRoot）');
    if (!paths.libRoots.length) c.throwError(400, '未配置漫画库根（设置 → 漫画库 → libraryRoots）');
    const started = await runner.start({ stage: stage, rebuildFp: body.rebuildFp === true });
    log.info('启动扫描: ' + stage + (body.rebuildFp ? ' (重建指纹)' : '') + ' 库根 ' + paths.libRoots.map(function (r) { return r.id; }).join(','));
    c.json({ ok: true, started: true, stage: started.stage, label: started.label });
  });

  app.get('/api/dedupe/scan/events', function (c) {
    const sse = c.sse();
    runner.addClient(sse);
  });

  app.post('/api/dedupe/scan/abort', function (c) {
    const aborted = runner.abort();
    c.json({ ok: true, aborted: aborted, message: aborted ? '已请求中止扫描' : '当前没有正在运行的扫描' });
  });

  // ---------- 单元列表 ----------
  app.get('/api/dedupe/units', async function (c) {
    const paths = await pathsOf();
    const scan = await readScan(paths);
    const decisions = await readDecisions(paths);
    const all = (scan && scan.units) || [];
    const verdict = String(c.query('verdict', '') || '').trim();
    if (verdict && verdict !== 'all' && !VERDICTS.includes(verdict)) c.throwError(400, '未知判定类型: ' + verdict);
    const libRoot = String(c.query('libRoot', '') || '').trim();
    if (libRoot && libRoot !== 'all' && !paths.libRoots.some(function (r) { return r.id === libRoot; })) {
      c.throwError(400, '未知库根: ' + libRoot);
    }
    const q = String(c.query('q', '') || '').trim().toLowerCase();
    const decided = String(c.query('decided', '') || '').trim().toLowerCase();
    const showDeleted = ['1', 'yes', 'true'].includes(String(c.query('deleted', '') || '').trim().toLowerCase());
    const page = Math.max(1, c.queryInt('page', 1));
    const size = Math.min(200, Math.max(1, c.queryInt('size', 24)));

    // 真因修复：已删除的单元必须默认不出现在列表里。
    // 它们可能仍在 scan.units 里（删除回写失败 / 扫描结果比删除新 / 旧版本写的 scan），
    // 只看「按 id 摘除」不足以让前端消失；这里再按决策标记过滤一层，
    // 于是一个单元无论走哪条路，只要被登记为 deleted 就一定不再渲染、不再请求缩略图。
    let list = showDeleted ? all.slice() : visibleUnits(all, decisions);
    if (verdict && verdict !== 'all') list = list.filter(function (u) { return u.judge === verdict; });
    if (libRoot && libRoot !== 'all') list = list.filter(function (u) { return u.libRootId === libRoot; });
    if (decided === '1' || decided === 'yes' || decided === 'true') list = list.filter(function (u) { const d = decisions[u.id]; return Boolean(d && d.verdict && d.verdict !== 'pending'); });
    if (decided === '0' || decided === 'no' || decided === 'false') list = list.filter(function (u) { const d = decisions[u.id]; return !(d && d.verdict && d.verdict !== 'pending'); });
    if (q) {
      list = list.filter(function (u) {
        const hay = (u.id + ' ' + u.name + ' ' + u.category + ' ' + (u.comic || '') + ' ' + (u.chapterTitle || '') + ' ' + (u.libRootName || '') + ' ' + u.judge).toLowerCase();
        return hay.includes(q);
      });
    }
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const start = (page - 1) * size;
    const slice = list.slice(start, start + size).map(function (u) { return compactUnit(u, decisions); });
    c.json({
      ok: true,
      total: total, page: page, size: size, pages: pages,
      units: slice,
      libRoots: paths.libRoots.map(function (r) { return { id: r.id, name: r.name, path: r.path }; }),
      byRoot: (scan && scan.库 && scan.库.按根) || null,
      scanAt: (scan && scan.generatedAt) || '',
      deepMatchAt: (scan && scan.深度比对时间) || '',
      degraded: Boolean(scan && scan.degraded),
      degradeReason: (scan && scan.degradeReason) || '',
      stats: scan ? statsOf(scanForStats(scan, decisions), decisions) : statsOf(null, decisions),
      filtered: { verdict: verdict || 'all', q: q, decided: decided || 'all', libRoot: libRoot || 'all' }
    });
  });

  // ---------- 人在环：快速查重候选 ----------
  /*
    候选复核视图的数据源。
    为什么单独一条路由：快速查重（stage=fast）只落盘元数据预筛结果，形状与 scan-latest.json
    不同，不能塞进 /units（那个接口读的是全量扫描结果，语义是「已比对过的单元」）。
    这里把候选整理成前端能直接渲染的形状：
      · unit  —— 候选单元（复用 compactUnit，字段与列表卡片完全一致）
      · matches —— 该单元的候选库作品（标题 / 页数 / 标题相似度 / 抽样图地址）
      · samples —— 候选单元侧与库侧的并排抽样图（thumb 地址，交给现成 /api/dedupe/thumb 出图）
    容错原则：scan-fast.json 不存在、坏 JSON、字段缺失或类型不对，一律返回空列表 + ok:true，
    绝不 500 —— 前端第一次进页面时该文件本来就不存在。
  */
  app.get('/api/dedupe/candidates', async function (c) {
    const paths = await pathsOf();
    const decisions = await readDecisions(paths);
    let fast = null;
    try { fast = await readJson(fastFileOf(paths), null); } catch (e) { fast = null; }
    const fullScan = await readScan(paths);
    /* 候选 = 快速查重结果（元数据预筛，秒级）∪ 完整扫描里「确实比对到内容」的单元。
       为什么要合并：用户可能先跑过完整扫描（约 13 分钟）并留下了 batch 命中结果，
       那时若只显示 scan-fast.json，候选复核页就是空的 —— 明明已经查出重复却没人眼复核入口。
       两边的单元 id 口径一致（都是查重根下的单层相对目录），按 id 去重，快速结果优先（它带 matches）。 */
    const raw = [];
    const rawIds = new Set();
    for (const cand of candidatesFromFast(fast)) {
      const uid = String(cand.unitId || cand.id || (cand.unit && cand.unit.id) || '');
      if (!uid || rawIds.has(uid)) continue;
      rawIds.add(uid);
      raw.push(cand);
    }
    for (const u of ((fullScan && fullScan.units) || [])) {
      if (!u || !u.id || rawIds.has(u.id)) continue;
      // 「未找到」不进候选复核：完整扫描已经明确说它比对不上了。
      if (u.judge === '未找到') continue;
      rawIds.add(u.id);
      raw.push(u);
    }
    const byId = new Map();
    for (const u of ((fullScan && fullScan.units) || [])) byId.set(u.id, u);

    const rootName = new Map();
    for (const r of (paths.libRoots || [])) rootName.set(r.id, r.name);

    const out = [];
    for (const cand of raw) {
      if (!cand || typeof cand !== 'object') continue;
      const unitId = String(cand.unitId || cand.id || '');
      if (!unitId) continue;
      const known = byId.get(unitId) || null;
      // 以快速结果为准，缺失字段用全量扫描里的同名单元补齐；两边都没有也能出卡片。
      const unit = Object.assign({}, known || {});
      unit.id = unitId;
      unit.name = String(cand.name || cand.title || unit.name || unitId);
      const unitPages = numOrNull(cand.unitPages != null ? cand.unitPages : (known && (known.dupCount || known.pages))) || 0;
      const samples = Array.isArray(cand.samples) ? cand.samples : (known && known.samples) || [];
      unit.samples = samples;
      unit.dupCount = unitPages;

      // 完整扫描的单元没有 matches 字段，用它的命中作品信息补一条，保证卡片上能看到「和谁重复」。
      const rawMatches = Array.isArray(cand.matches)
        ? cand.matches
        : (cand.comic ? [{ libId: cand.comic, libTitle: cand.comic, libPages: cand.libCount, titleScore: null, reasons: ['完整扫描'] }] : []);
      const matches = [];
      for (const m of rawMatches) {
        if (!m || typeof m !== 'object') continue;
        const libId = String(m.libId || m.id || '');
        const libTitle = String(m.libTitle || m.title || libId);
        if (!libId && !libTitle) continue;
        const score = score01(m.titleScore != null ? m.titleScore : m.score);
        const rootId = String(m.libRootId || m.root || '');
        matches.push({
          libId: libId,
          libTitle: libTitle,
          libPages: numOrNull(m.libPages != null ? m.libPages : m.pages),
          titleScore: score != null ? score : roughTitleScore(unit.name, libTitle),
          pageDiff: numOrNull(m.pageDiff),
          pageDiffRatio: numOrNull(m.pageDiffRatio),
          reasons: Array.isArray(m.reasons) ? m.reasons : [],
          libRootId: rootId,
          libRootName: String(m.libRootName || rootName.get(rootId) || '')
        });
      }
      out.push({ unit: compactUnit(unit, decisions), unitPages: unitPages, matches: matches });
    }

    // 抽样图地址：直接给出 /api/dedupe/thumb 的地址，前端 <img> 拿来就能用。
    // root 对多库根是必需的：库里同一张图在非首个根下，不带 root 会 404。
    for (const item of out) {
      const list = samplesOf(item.unit);
      const pairs = [];
      for (const s of list) {
        const root = s.root || item.unit.libRootId || '';
        pairs.push({
          dup: s.dup, lib: s.lib, root: root, mad: s.mad,
          dupUrl: s.dup ? thumbUrlOf(item.unit.id, 'dup', s.dup) : '',
          libUrl: s.lib ? thumbUrlOf(item.unit.id, 'lib', s.lib, root) : ''
        });
      }
      // 兜底：库格式正规化后 dup 侧文件名多了一层「<序> <章节>/」，samples 可能一条都取不出来，
      // 这时仍要给一张能看到图的配对，否则用户在候选复核里看到的是「没有可看的抽样图」，无法判定。
      // dup 侧退回「单元目录里的第一张图」，lib 侧仍用现成的 libSampleOf。
      if (!pairs.length) {
        const libS = libSampleOf(item.unit);
        const dupFallback = firstDupImageOf(item.unit);
        if (libS || dupFallback) {
          const root = (libS && libS.root) || item.unit.libRootId || '';
          const dupName = (libS && libS.dup) || dupFallback || '';
          pairs.push({
            dup: dupName, lib: libS ? libS.lib : '', root: root, mad: libS ? libS.mad : null,
            dupUrl: dupName ? thumbUrlOf(item.unit.id, 'dup', dupName) : '',
            libUrl: libS && libS.lib ? thumbUrlOf(item.unit.id, 'lib', libS.lib, root) : ''
          });
        }
      }
      item.samples = pairs;
      item.sampleCount = pairs.length;
      item.decision = (item.unit.decision && item.unit.decision.verdict) || 'pending';
      // 快速模式的判定（同图不同编码 / 部分重复 / 待人工复核）与扫描阶段一起给前端，
      // 界面据此写清「这一条是像素证据还是只靠标题页数」。
      item.judge = item.unit.judge || '';
      item.matchBy = item.unit.matchBy || '';
    }

    // 已删除的单元绝不能再出现在候选复核里。
    // 真因（用户可见的毛病）：候选读的是 scan-fast.json，而删除只回写 scan-latest.json，
    // 于是「确认重复 → 删除成功」之后，候选页里那张卡片仍原样留着（甚至还能被再点一次删除）。
    // 判据只看 decisions[id].verdict === 'deleted'，与 /units 的可见性口径完全一致。
    const visible = [];
    let hiddenDeleted = 0;
    for (const item of out) {
      const uid = item.unit && item.unit.id;
      if (isDeletedUnit({ id: uid }, decisions)) { hiddenDeleted++; continue; }
      visible.push(item);
    }

    c.json({
      ok: true,
      candidates: visible,
      total: visible.length,
      hiddenDeleted: hiddenDeleted,
      fastAvailable: Boolean(fast),
      fastAt: (fast && (fast.generatedAt || fast.time)) || '',
      // 预筛统计与「像素证据是否可用」：界面必须如实显示这一轮是「像素证据」还是
      // 「只靠标题页数的元数据候选」，否则用户会把元数据候选误当成像素级确认。
      fastInfo: fast ? (fast.预筛 || null) : null,
      fastDegraded: Boolean(fast && fast.degraded),
      fastDegradeReason: (fast && fast.degradeReason) || '',
      fastFile: fastFileOf(paths),
      libRoots: paths.libRoots.map(function (r) { return { id: r.id, name: r.name, path: r.path }; }),
      decisions: decisions
    });
  });

  // ---------- 单元详情 ----------
  app.get('/api/dedupe/unit/:id', async function (c) {
    const paths = await pathsOf();
    const scan = await readScan(paths);
    if (!scan) c.throwError(404, '还没有扫描结果，请先扫描');
    const id = c.params.id;
    // 同理：快速查重的候选也要能进详情（否则候选卡片的「并排看全图」永远打不开）。
    const rec = findUnit(scan, id) || await findUnitAny(paths, id, scan);
    if (!rec) c.throwError(404, '单元不存在（可能已被删除或重新扫描）: ' + id);
    const decisions = await readDecisions(paths);
    const hash = await readHash(paths);
    const detail = hash && Array.isArray(hash.units) ? hash.units.find(function (u) { return u.id === id; }) : null;
    const dupFiles = detail ? detail.files.slice() : (rec.samples || []).map(function (s) { return s.dup; });
    const libFiles = [];
    if (rec.libDir) {
      try {
        const { listImages } = await import('../../core/util.mjs');
        const imgs = await listImages(rec.libDir);
        for (const f of imgs) libFiles.push(f.name);
      } catch (e) { /* 库章节可能已被移动，忽略 */ }
    }
    const sampleBy = new Map();
    for (const s of (rec.samples || [])) sampleBy.set(s.dup, s);
    const exact = (detail && detail.exact) || {};
    const pairs = dupFiles.map(function (name) {
      const s = sampleBy.get(name);
      let lib = '';
      let root = '';
      if (exact[name]) {
        const own = ownerOf(paths.libRoots, exact[name]);
        if (own) { lib = relInRoot(own, exact[name]); root = own.id; }
        else lib = path.basename(String(exact[name]));
      } else if (s && s.lib) { lib = s.lib; root = s.root || ''; }
      return { dup: name, lib: lib, root: root, exact: Boolean(exact[name]), mad: s ? s.mad : null };
    });
    c.json({
      ok: true,
      unit: compactUnit(rec, decisions),
      dupFiles: dupFiles, libFiles: libFiles, pairs: pairs,
      libRoots: paths.libRoots.map(function (r) { return { id: r.id, name: r.name, path: r.path }; })
    });
  });

  // ---------- 缩略图 / 原图 ----------
  app.get('/api/dedupe/thumb', async function (c) {
    const paths = await pathsOf();
    const id = String(c.query('unit', '') || '');
    // 候选复核的卡片来自快速查重（scan-fast.json），只认 scan-latest.json 会让抽样图全部 404。
    const rec = await findUnitAny(paths, id);
    if (!rec) c.throwError(404, '单元不存在: ' + id);
    const side = c.query('side', 'dup') === 'lib' ? 'lib' : 'dup';
    const name = String(c.query('name', '') || '');
    let src = '';
    if (side === 'dup') {
      /* dup 侧也允许子路径：库格式正规化（L2）之后，查重单元是「<漫画>/<章节>」目录，
         图片名必须带「<序> <章节>/」前缀才能定位，用单段文件名口径会一律 400，
         候选复核的抽样图就永远显示「图片读取失败」。越界由 isSafeRelPath + safeJoin 拦住。 */
      if (!isSafeRelPath(name)) c.throwError(400, '非法文件名');
      if (!rec.dupDir || !paths.scanRoot) c.throwError(404, '该单元没有查重目录');
      if (!insideRoot(paths.scanRoot, rec.dupDir) || path.resolve(rec.dupDir) === path.resolve(paths.scanRoot)) c.throwError(400, '目录越界，已拒绝');
      try { src = safeJoin(rec.dupDir, name); } catch (e) { c.throwError(400, '非法路径'); }
    } else {
      // side=lib：多库根下 name 是「相对某一个根的路径」，root 参数指出基准根
      const rootId = String(c.query('root', '') || '');
      const rootRec = rootId ? paths.libRoots.find(function (r) { return r.id === rootId; }) : null;
      if (rootRec) {
        if (!isSafeRelPath(name)) c.throwError(400, '非法路径');
        try { src = safeJoin(rootRec.path, name); } catch (e) { c.throwError(400, '非法路径'); }
        if (path.resolve(src) === path.resolve(rootRec.path)) c.throwError(400, '非法路径');
      } else {
        // 兼容旧调用：不带 root 时按命中章节目录 + 单段文件名
        const own = ownerOf(paths.libRoots, rec.libDir);
        if (!own || !rec.libDir) c.throwError(404, '该单元没有库内对应目录');
        if (!isPlainFileName(name)) c.throwError(400, '非法文件名');
        if (!insideRoot(own.path, rec.libDir)) c.throwError(400, '目录越界，已拒绝');
        try { src = safeJoin(rec.libDir, name); } catch (e) { c.throwError(400, '非法路径'); }
      }
    }
    try { const st = await fsp.stat(src); if (!st.isFile()) c.throwError(404, '文件不存在'); }
    catch (e) { if (e && e.statusCode) throw e; c.throwError(404, '文件不存在'); }
    if (c.query('full', '') === '1') { c.file(src, { cacheSeconds: 3600 }); return; }
    let thumb = null;
    try { thumb = await ensureThumb(paths, id, side, src, name, { size: 320, cwd: ctx.projectRoot }); } catch (e) { thumb = null; }
    c.file(thumb || src, { cacheSeconds: 3600 });
  });

  // ---------- 人工决策 ----------
  app.post('/api/dedupe/decision', async function (c) {
    const paths = await pathsOf();
    const body = c.body || {};
    const unitId = String(body.unitId || body.id || '');
    if (!unitId) c.throwError(400, '缺少 unitId');
    const verdict = String(body.verdict === undefined || body.verdict === null || body.verdict === '' ? 'pending' : body.verdict);
    if (!DECISION_VERDICTS.includes(verdict)) c.throwError(400, '未知决策: ' + verdict + '（可选 keep / delete / pending）');
    const scan = await readScan(paths);
    // 快速查重的候选不属于 scan-latest.json（两个文件互不覆盖），
    // 若只认完整扫描，用户在候选复核里点三选会被 400 挡下。
    let known = Boolean(findUnit(scan, unitId));
    if (!known) {
      let fastDoc = null;
      try { fastDoc = await readJson(fastFileOf(paths), null); } catch (e) { fastDoc = null; }
      const list = fastDoc && Array.isArray(fastDoc.units) ? fastDoc.units : [];
      known = list.some(function (u) { return u && u.id === unitId; });
    }
    if (!known) c.throwError(400, '单元不在最近一次扫描结果里: ' + unitId);
    const decision = await setDecision(paths, unitId, verdict, body.note);
    const decisions = await readDecisions(paths);
    c.json({ ok: true, unitId: unitId, decision: decision, stats: scan ? statsOf(scan, decisions) : null });
  });

  // ---------- 执行删除 ----------
  app.post('/api/dedupe/delete', async function (c) {
    const paths = await pathsOf();
    const body = c.body || {};
    const scan = await readScan(paths);
    // 没有完整扫描结果时，替身是快速查重结果（scan-fast.json）。
    // 候选复核是快速模式的入口，用户在这里「确认重复」后直接删除 —— 若因为
    // 「还没跑过完整扫描」而拒绝，整个快速链路就断在最后一步。这里把它当成
    // 只有 id/name 的单元表用（删除只校验 id 与路径边界，不需要判定字段）。
    let fastDoc = null;
    try { fastDoc = await readJson(fastFileOf(paths), null); } catch (e) { fastDoc = null; }
    const hasFast = Boolean(fastDoc && Array.isArray(fastDoc.units) && fastDoc.units.length);
    if (!scan && !hasFast) c.throwError(400, '还没有扫描结果，无法删除');
    // 可删除集合 = 完整扫描的单元 ∪ 快速查重里「已确认重复」的单元。
    // 为什么必须加后半截：快速模式只落 scan-fast.json、**绝不覆盖 scan-latest.json**（两种模式
    // 结果分开，否则用户一进快速模式就把完整扫描结果冲掉了）。而删除校验只认 scan-latest 的单元，
    // 于是快速模式命中的单元「标记了却删不掉」，链路断在这里。
    // 只补「磁盘上真实存在、且 id 是查重根下单层相对目录」的项；不存在的一律不补（避免凭空校验）。
    const folders = scan && Array.isArray(scan.units) ? scan.units.slice() : [];
    if (hasFast) {
      for (const u of fastDoc.units) {
        const id = String((u && u.id) || '');
        if (!id) continue;
        /* 目录一律按「查重根 + 单元 id」重新拼，不用 scan-fast.json 里可能陈旧的 dupDir，
           路径越界校验仍会在 validateDeleteRequest 里复验。
           注意 id 可能是多段（库格式正规化后是「<漫画>/<章节>」，discoverUnits 对带 元数据.json
           的漫画目录刻意用相对路径做 id，否则同书多章会塌成同一个 id）—— 所以这里不能拒绝斜杠，
           带斜杠就按多段相对路径拼；拒绝它会让「快速查重查出来的重复一个都删不掉」。 */
        if (id.indexOf('\\') >= 0 || id === '..' || id.indexOf('../') === 0 || /^[A-Za-z]:/.test(id)) continue;
        const d = path.join(paths.scanRoot, id);
        folders.push({ id: id, name: (u && u.name) || id, dir: d, dupDir: d, dupCount: (u && u.dupCount) || 0, bytes: (u && u.bytes) || 0, judge: (u && u.judge) || '快速查重' });
      }
    }
    const knownIds = new Set(folders.map(function (f) { return f && f.id; }));
    const decisionsNow = await readDecisions(paths);
    for (const [uid, d] of Object.entries(decisionsNow || {})) {
      if (!d || d.verdict !== 'delete' || knownIds.has(uid)) continue;
      const id = String(uid);
      // 与上面同一口径：多段 id（正规化后的「<漫画>/<章节>」）必须支持，否则被标记为待删除的
      // 单元进不了可删除集合，执行删除时会被判成「没有标记为待删除的单元」。
      if (!id || id.indexOf('\\') >= 0 || id === '..' || id.indexOf('../') === 0 || /^[A-Za-z]:/.test(id)) continue;
      const dir = path.join(paths.scanRoot, id);
      let isDir = false;
      try { isDir = (await fsp.stat(dir)).isDirectory(); } catch (e) { isDir = false; }
      if (!isDir) continue;
      folders.push({ id: id, name: id, dir: dir, dupDir: dir, dupCount: 0, bytes: 0, judge: '快速查重' });
      knownIds.add(id);
    }
    const check = validateDeleteRequest({
      confirm: body.confirm,
      mode: body.mode,
      unitIds: body.unitIds,
      folders: folders,
      scanRoot: paths.scanRoot
    });
    const entry = await executeDelete(paths, {
      confirm: body.confirm, mode: body.mode, unitIds: body.unitIds, folders: folders,
      // 目录已不存在 ≠ 删除失败：说明它早就被删掉了（用户先删过一次、或在磁盘上手工删了），
      // 这时正确的语义是「按已删除收尾」——从列表摘除并登记 deleted，而不是抛 400。
      // 抛 400 会让用户点了删除却什么都不发生，列表里那个单元永远留着（旧行为就是这个毛病）。
      allowMissing: true
    });
    log.warn('执行删除(' + entry.mode + '): ' + entry.ids.length + ' 个单元，成功 ' + entry.ok
      + ' / 失败 ' + entry.failed + (entry.skippedTotal ? ' / 跳过 ' + entry.skippedTotal : ''));
    // 回写最近一次扫描结果：删掉的单元必须立刻从列表消失。
    // 不回写的老行为是「删除成功但列表还在」——用户点完删除，卡片不动、统计不变，
    // 只能靠手动重扫（约 20 分钟）才刷新，看起来就像「删除没成功」。
    const addedIds = await applyDeleteToScan(paths, entry);
    const decisions = await readDecisions(paths);
    const after = await readScan(paths);
    c.json({
      ok: true, mode: entry.mode, time: entry.time,
      requested: check.ids.length,
      succeeded: entry.ok, failed: entry.failed,
      skipped: entry.skippedTotal || 0, skippedIds: entry.skipped || [],
      removedFromScan: addedIds.length, decided: addedIds,
      results: entry.results,
      stdout: entry.stdout,
      stats: after ? statsOf(after, decisions) : null
    });
  });

  app.post('/api/dedupe/restore', async function (c) {
    const paths = await pathsOf();
    const body = c.body || {};
    const res = await restoreQuarantine(paths, { unitIds: body.unitIds });
    c.json({ ok: true, restored: res.restored, count: res.restored.filter(function (r) { return r.ok; }).length, quarantineDir: res.quarantineDir });
  });

  /**
   * 把「已删除」的单元从最近一次扫描结果里剔除，并把它们的扫描单元 id 登记进决策表。
   * 背景（真因）：删除只作用于磁盘，scan-latest.json 不动，于是列表、统计、可清理体积
   * 全都停留在删除前，用户点完删除看不到任何变化。这里做最小回写：
   *  - 只按 id 摘除，不重算判定（重算是 20 分钟的全量活，不该塞进一次删除请求里）；
   *  - 决策登记为 `deleted`（写入前必须让 store 白名单接受它），列表与统计据此再兜底一层过滤，
   *    这样即使 scan 文件没写成功（磁盘满 / 文件被占用），单元也不会再出现在前端；
   *  - 先写 scan-latest.json 再写决策标记：决策是「让删除可见」的兜底，不能因为写失败而丢；
   *  - 回写失败不能吞：删除本身已经成功，但回写失败必须让调用方知道（返回 removedFromScan=0）。
   * 返回真正被摘除的 id 列表。
   */

  app.get('/api/dedupe/deleted', async function (c) {
    const paths = await pathsOf();
    const items = await listQuarantine(paths);
    const log = await readDeleteLog(paths, 50);
    c.json({ ok: true, quarantineDir: paths.quarantine, items: items, log: log });
  });

  // ---------- 统计 ----------
  app.get('/api/dedupe/stats', async function (c) {
    const paths = await pathsOf();
    const scan = await readScan(paths);
    const decisions = await readDecisions(paths);
    const stats = statsOf(scanForStats(scan, decisions), decisions);
    c.json({
      ok: true, stats: stats,
      scanAt: (scan && scan.generatedAt) || '',
      deepMatchAt: (scan && scan.深度比对时间) || '',
      degraded: Boolean(scan && scan.degraded),
      degradeReason: (scan && scan.degradeReason) || '',
      libRoots: paths.libRoots.map(function (r) { return { id: r.id, name: r.name, path: r.path }; }),
      byRoot: (scan && scan.库 && scan.库.按根) || null,
      units: ((scan && scan.units) || []).length
    });
  });

  // ---------- 联络表（covers.py） ----------
  app.post('/api/dedupe/covers', async function (c) {
    const paths = await pathsOf();
    const res = await generateCovers(paths, { hexOnly: true, cwd: ctx.projectRoot });
    if (!res.ok) c.error(res.degraded ? 503 : 500, res.reason);
    c.json({ ok: true, path: res.path, count: res.count });
  });

  const p0 = resolvePaths(ctx.config, ctx.dataDir || dataDir());
  log.info('查重模块就绪，产物目录 ' + p0.root + '；比对库根 ' + p0.libRoots.map(function (r) { return r.id + ':' + r.path; }).join(' | '));
}

export async function dispose() {
  try { if (runner) runner.abort(); } catch (e) { /* 退出时忽略 */ }
  runner = null;
}
