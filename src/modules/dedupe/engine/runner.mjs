// engine/runner.mjs — 扫描任务编排：单飞、阶段权重进度、SSE 广播、中止、状态持久化。
import { clamp } from '../../../core/util.mjs';
import { probePython, degradeReason } from './py.mjs';
import { runHashStage, runPixelStageFull, runThumbsStage, runFastStage } from './pipeline.mjs';
import { readScan, readState, writeState, readDecisions, statsOf } from './store.mjs';
import { withHeartbeat } from '../../../core/heartbeat.mjs';

// fast 放在最前：它是用户日常最常用的模式（元数据预筛 + 候选章节比对，秒级~一分钟）
// 界面上的「快速查重」按钮就是它；错误信息里的可选阶段清单也按这个顺序展示。
export const STAGES = ['fast', 'full', 'hash', 'pixel', 'thumbs'];
/** 各阶段在总进度里的权重（full = hash 35% + pixel 45% + thumbs 20%）。 */
export const STAGE_WEIGHTS = {
  full: { hash: 0.35, pixel: 0.45, thumbs: 0.20 },
  hash: { hash: 1 },
  pixel: { pixel: 1 },
  thumbs: { thumbs: 1 },
  fast: { fast: 1 }
};

export const STAGE_LABEL = {
  fast: '快速查重（元数据预筛）',
  full: '完整扫描',
  hash: '哈希扫描',
  pixel: '深度比对（全库像素）',
  thumbs: '生成缩略图'
};

/** 创建一个扫描任务运行器（每个进程一个）。 */
export function createRunner(opts) {
  const o = opts || {};
  const clients = new Set();
  let job = null;
  const state = {
    running: false, stage: '', phase: '', current: 0, total: 0, percent: 0, message: '',
    startedAt: 0, finishedAt: 0, error: '', aborted: false,
    degraded: false, degradeReason: '', lastScanAt: '', lastResult: null
  };

  function broadcast(event, data) {
    for (const sse of clients) {
      try { if (!sse.closed) sse.send(event, data); } catch (e) { clients.delete(sse); }
    }
  }

  /** SSE 客户端接入：立刻回放当前状态，避免进度条从 0 开始。 */
  function addClient(sse) {
    clients.add(sse);
    try {
      sse.send('state', Object.assign({}, progressPayload(), { lastScanAt: state.lastScanAt }));
    } catch (e) { /* 客户端可能已断开 */ }
    if (typeof sse.onClose === 'function') sse.onClose(function () { clients.delete(sse); });
    return function () { clients.delete(sse); };
  }

  function progressPayload() {
    return {
      running: state.running, stage: state.stage, stageLabel: STAGE_LABEL[state.stage] || state.stage,
      phase: state.phase, current: state.current, total: state.total,
      percent: state.percent, message: state.message,
      degraded: state.degraded, degradeReason: state.degradeReason,
      startedAt: state.startedAt, finishedAt: state.finishedAt, aborted: state.aborted
    };
  }

  /** 把某阶段的 0..1 进度映射到总进度。 */
  function wrap(stage, base, span) {
    return function (frac, phase, current, total, message) {
      const f = clamp(Number(frac) || 0, 0, 1);
      state.stage = stage;
      state.phase = phase || '';
      state.current = Number(current) || 0;
      state.total = Number(total) || 0;
      state.percent = Math.round(clamp(base + span * f, 0, 1) * 100);
      state.message = message || phase || '';
      broadcast('progress', progressPayload());
    };
  }

  function onChild(child) {
    if (!job) return;
    job.children.push(child);
    if (job.aborted) { try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }
  }
  function onCancel(registerKiller) {
    if (!job) return;
    job.killers.push(registerKiller);
    if (job.aborted) { try { registerKiller(); } catch (e) { /* 忽略 */ } }
  }

  /** 中止当前任务：置位 + 杀掉所有子进程。返回是否有任务被中止。 */
  function abort() {
    if (!state.running || !job) return false;
    job.aborted = true;
    state.message = '正在中止…';
    broadcast('progress', progressPayload());
    for (const kill of job.killers) { try { kill(); } catch (e) { /* 忽略 */ } }
    for (const child of job.children) { try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }
    return true;
  }

  async function run(stage, rebuildFp, paths) {
    const started = Date.now();
    const weights = STAGE_WEIGHTS[stage] || STAGE_WEIGHTS.full;
    const ctx = {
      cwd: o.cwd,
      signal: job,
      onChild: onChild,
      onCancel: onCancel,
      // 透传日志：并行比对失败会静默降级成串行，没有日志就查不出真实缺陷
      onLog: o.log ? function (m) { try { o.log.warn(m); } catch (e) { /* 忽略 */ } } : null,
      rebuildFp: rebuildFp,
      pixelReview: paths.pixelReview !== false,
      hashConcurrency: o.hashConcurrency
    };
    const result = { stage: stage, rebuildFp: rebuildFp, degraded: false, degradeReason: '', summary: null };

    // 按权重顺序执行各段
    let base = 0;
    if (weights.fast) {
      if (job.aborted) throw abortError();
      const span = weights.fast;
      const r = await runFastStage(paths, wrap('fast', base, span), ctx);
      // runFastStage 的冻结返回形状是 { units, summary, stats }（与 runPixelStage 一致），
      // scan / fastFile 是额外带上的落盘产物；这里都做兜底，坏形状不至于把一次扫描打成 500。
      const fastScan = r.scan || null;
      const fastUnits = Array.isArray(r.units) ? r.units : (fastScan && fastScan.units) || [];
      result.fast = {
        units: fastUnits.length,
        candidates: r.stats ? (r.stats.candidates != null ? r.stats.candidates : r.stats.units) : 0,
        pixelReady: Boolean(r.stats && r.stats.pixelReady),
        file: r.fastFile || (fastScan && fastScan.savedTo) || ''
      };
      result.summary = r.summary || (fastScan && fastScan.汇总) || null;
      result.stats = r.stats || null;
      result.degraded = Boolean(fastScan && fastScan.degraded);
      result.degradeReason = (fastScan && fastScan.degradeReason) || '';
      result.elapsedMs = Date.now() - started;
      result.scanAt = fastScan ? fastScan.generatedAt : new Date().toISOString();
      return result;
    }
    if (weights.hash) {
      if (job.aborted) throw abortError();
      const span = weights.hash;
      const r = await runHashStage(paths, wrap('hash', base, span), ctx);
      result.hash = { units: r.scan.units.length, exactTotal: r.exactTotal, needPixel: r.needPixel };
      result.summary = r.scan.汇总;
      result.degraded = r.scan.degraded;
      result.degradeReason = r.scan.degradeReason;
      base += span;
    }
    if (weights.pixel) {
      if (job.aborted) throw abortError();
      const span = weights.pixel;
      // hash 段已跑过时 hash-result.json 一定存在，pixel 段内部不会重复跑 hash
      const r = await runPixelStageFull(paths, wrap('pixel', base, span), ctx);
      result.pixel = { stats: r.stats || null };
      result.degraded = r.degraded;
      result.degradeReason = r.reason || result.degradeReason;
      if (r.scan) result.summary = r.scan.汇总;
      base += span;
    }
    if (weights.thumbs) {
      if (job.aborted) throw abortError();
      const span = weights.thumbs;
      const r = await runThumbsStage(paths, wrap('thumbs', base, span), ctx);
      result.thumbs = { tasks: r.tasks, ok: r.thumbs.ok, degraded: r.thumbs.degraded, reason: r.thumbs.reason, stats: r.thumbs.stats };
      if (r.thumbs.degraded && !result.degraded) { result.degraded = true; result.degradeReason = r.thumbs.reason; }
      base += span;
    }

    const scan = await readScan(paths);
    const decisions = await readDecisions(paths);
    const stats = scan ? statsOf(scan, decisions) : null;
    result.summary = scan ? scan.汇总 : result.summary;
    result.elapsedMs = Date.now() - started;
    result.scanAt = scan ? scan.generatedAt : '';
    result.stats = stats;
    // 收益汇报：判定为重复的可清理体积
    result.reclaimable = stats ? stats.reclaimableBytes : 0;
    result.duplicateUnits = stats ? (stats.units - (stats.byVerdict['未找到'] || 0)) : 0;
    return result;
  }

  function abortError() { const e = new Error('任务已中止'); e.aborted = true; return e; }

  /** 启动一个扫描任务（单飞）。重复触发抛 409。 */
  async function start(body) {
    const b = body || {};
    const stage = STAGES.includes(b.stage) ? b.stage : 'full';
    if (state.running) throw Object.assign(new Error('已有扫描任务在运行，请先中止或等待完成'), { statusCode: 409 });
    const paths = await o.getPaths();
    job = { aborted: false, killers: [], children: [] };
    state.running = true;
    state.stage = stage;
    state.phase = '准备';
    state.current = 0;
    state.total = 0;
    state.percent = 0;
    state.message = '开始 ' + (STAGE_LABEL[stage] || stage);
    state.startedAt = Date.now();
    state.finishedAt = 0;
    state.error = '';
    state.aborted = false;
    state.degraded = !probePython().pillow;
    state.degradeReason = state.degraded ? degradeReason() : '';
    broadcast('progress', progressPayload());

    (async function () {
      try {
        // 查重是全应用最长的同步流水线（全库指纹构建可达 20 分钟），
        // 期间 /api/ping 必然超时；必须先声明「我在忙」，否则桌面宿主会误判后端已死并关窗口。
        const result = await withHeartbeat(function () {
          return run(stage, b.rebuildFp === true, paths);
        }, { label: STAGE_LABEL[stage] || '查重扫描', log: o.log });
        state.running = false;
        state.finishedAt = Date.now();
        state.percent = 100;
        state.phase = '完成';
        state.message = '扫描完成';
        state.lastScanAt = result.scanAt || new Date().toISOString();
        state.lastResult = result;
        state.degraded = result.degraded;
        state.degradeReason = result.degradeReason || '';
        await persist(paths, result);
        broadcast('done', Object.assign({ ok: true }, result, { percent: 100 }));
      } catch (err) {
        const aborted = job && job.aborted;
        state.running = false;
        state.finishedAt = Date.now();
        state.aborted = Boolean(aborted);
        if (aborted) {
          state.phase = '已中止';
          state.message = '任务已中止';
          broadcast('done', { ok: false, aborted: true, message: '任务已中止', percent: state.percent });
        } else {
          state.error = String(err && err.message ? err.message : err);
          state.phase = '失败';
          state.message = state.error;
          o.log && o.log.error && o.log.error('dedupe 扫描失败: ' + state.error);
          broadcast('error', { ok: false, error: state.error, percent: state.percent });
        }
        try { await persist(paths, null); } catch (e) { /* 忽略 */ }
      }
    })();
    return { started: true, stage: stage, label: STAGE_LABEL[stage] || stage };
  }

  /** 把最近一次结果写进 state.json，供重启后 GET /state 使用。 */
  async function persist(paths, result) {
    try {
      const prev = await readState(paths);
      await writeState(paths, {
        lastScanAt: state.lastScanAt || prev.lastScanAt || '',
        lastStage: state.stage,
        lastFinishedAt: state.finishedAt || prev.lastFinishedAt || 0,
        lastError: state.error || '',
        degraded: state.degraded,
        degradeReason: state.degradeReason || '',
        lastResult: result || prev.lastResult || null
      });
    } catch (e) { /* 状态落盘失败不应该影响主流程 */ }
  }

  return {
    addClient: addClient,
    start: start,
    abort: abort,
    progressPayload: progressPayload,
    get running() { return state.running; },
    get state() { return state; },
    clientCount: function () { return clients.size; }
  };
}
