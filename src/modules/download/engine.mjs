import { createPaths, extOfFormat } from './paths.mjs';
import { remove as removeLedger, setLogger as setLedgerLogger } from './ledger.mjs';
import {
  str, num, sleep, createLimiter, createSpeedometer, rmWithRetry, atomicWriteJson,
  chapterPageRecord, pageRecordUsable, declaredLengthOf, swapDir,
  buildComicMetadata, buildChapterMetadata, normalizeChapter,
  hasImage, listSuspiciousImages, extForImage
} from './engine-util.mjs';
import { runTask as runTaskImpl } from './engine-run.mjs';

/* 公开 API 保持不变：原先从 engine.mjs 取这些函数的调用方无需改动。 */
export {
  createLimiter, createSpeedometer, rmWithRetry, atomicWriteJson,
  chapterPageRecord, pageRecordUsable, declaredLengthOf, swapDir,
  buildComicMetadata, buildChapterMetadata, normalizeChapter,
  hasImage, listSuspiciousImages, extForImage
} from './engine-util.mjs';

/**
 * 下载引擎：把一部漫画的若干章节下载到 downloadRoot 下，结构与现有库同构。
 * 全部依赖注入（source / store / emit / config / log）：
 *   source 是下载源适配器（sources/types.mjs 的契约），引擎只认 Comic/Chapter/Page 统一结构，
 *   不 import 任何具体来源、也不认识哔咔的字段名。
 *
 * options: { source, store, emit(event,payload), getConfig(), log, patchTask(taskId, patch, event, payload) }
 *   source 必填：下载源适配器（统一契约见 sources/types.mjs）。
 */
export function createEngine(options) {
  const o = options || {};
  const source = o.source;
  const log = o.log || { info: function () {}, warn: function () {}, error: function () {}, debug: function () {} };
  // 台账读写的问题（文件损坏/落盘失败）必须出现在同一个日志流里，否则只能靠猜
  setLedgerLogger(log);
  const emit = o.emit || function () {};
  const getConfig = o.getConfig || function () { return {}; };
  const tasks = new Map();
  const running = new Map(); // taskId -> { controller }
  const queue = [];
  let activeCount = 0;
  let disposed = false;
  let pumpScheduled = false;

  function pica() { return Object.assign({}, getConfig().picacomic || {}); }

  function paths() {
    const c = getConfig();
    const p = pica();
    return createPaths({
      root: function () { return c.downloadRoot || c.libraryRoot || '.'; },
      dirFmt: function () { return p.dirFmt || '{comic_title}/{order} {chapter_title}'; },
      format: function () { return p.downloadFormat || 'Jpeg'; }
    });
  }

  function configuredExt() {
    // Original：不转换、保留上游原扩展名（由魔数决定）
    if (String(pica().downloadFormat || '').toLowerCase() === 'original') return '';
    return extOfFormat(pica().downloadFormat || 'Jpeg');
  }

  /**
   * 全局下载限速（KB/s，0=不限）：按秒窗口记账，超了就让出时间。
   */
  const rateBucket = { windowStart: Date.now(), bytes: 0 };
  async function throttleGlobal(bytes) {
    const limitKb = num(pica().globalSpeedLimitKb, 0);
    if (!limitKb || limitKb <= 0 || !bytes) return;
    const limit = limitKb * 1024;
    const now = Date.now();
    if (now - rateBucket.windowStart > 1000) {
      rateBucket.windowStart = now;
      rateBucket.bytes = 0;
    }
    rateBucket.bytes += bytes;
    if (rateBucket.bytes > limit) {
      const wait = Math.min(3000, Math.round(((rateBucket.bytes - limit) / limit) * 1000));
      if (wait > 0) await sleep(wait);
      rateBucket.windowStart = Date.now();
      rateBucket.bytes = 0;
    }
  }

  // 每个任务一个图片限速器（同一任务内全局生效）
  const imgLimiters = new Map();
  function taskImgLimiter(task) {
    let l = imgLimiters.get(task.id);
    if (!l) {
      l = createLimiter(intervalMs('imgIntervalMs', 'imgDownloadIntervalSec'));
      imgLimiters.set(task.id, l);
    }
    return l;
  }

  function chapterLimiter() { return createLimiter(intervalMs('chapterIntervalMs', 'chapterDownloadIntervalSec')); }

  /**
   * 解析任务该用哪个下载源：任务记了 sourceId 就用它（可经 o.getSource 查出适配器），
   * 没记或该源已不可用时退回注入的默认源，并把原因写进任务日志（不打断下载）。
   */
  function sourceOf(task) {
    const id = task && task.sourceId ? String(task.sourceId) : '';
    if (!id || typeof o.getSource !== 'function') return source;
    try {
      return o.getSource(id) || source;
    } catch (err) {
      addLog(task, 'warn', '下载源 ' + id + ' 已不可用，改用默认源：' + (err && err.message ? err.message : err));
      return source;
    }
  }

  /** 章节/图片间隔：新配置用毫秒，老配置（picacomic-downloader）用秒，两个都认。 */
  function intervalMs(msKey, secKey) {
    const p = pica();
    if (p[msKey] !== undefined && p[msKey] !== null && p[msKey] !== '') return num(p[msKey], 0);
    if (p[secKey] !== undefined && p[secKey] !== null && p[secKey] !== '') return num(p[secKey], 0) * 1000;
    return 0;
  }

  function persist(task) {
    task.updatedAt = new Date().toISOString();
    if (o.store && typeof o.store.save === 'function') o.store.save(task);
  }

  function patch(task, changes, event, payload) {
    Object.assign(task, changes);
    task.updatedAt = new Date().toISOString();
    if (o.patchTask) o.patchTask(task.id, changes, event, payload);
    else if (o.store && typeof o.store.save === 'function') o.store.save(task);
  }

  function emitSafe(event, payload) {
    try { emit(event, payload); } catch (e) { /* 事件监听器异常不能影响下载 */ }
  }

  /** 任务公开视图（含聚合进度/速度/ETA）。 */
  function view(task) {
    const sections = (task.sections || []).map(function (s) {
      return { order: s.order, title: s.title, state: s.state, total: s.total, done: s.done, failed: s.failed, error: s.error || null };
    });
    const total = sections.reduce(function (a, s) { return a + (s.total || 0); }, 0);
    const done = sections.reduce(function (a, s) { return a + Math.min(s.done || 0, s.total || 0); }, 0);
    const failed = sections.reduce(function (a, s) { return a + (s.failed || 0); }, 0);
    const finishedChapters = sections.filter(function (s) { return s.state === 'done'; }).length;
    const totalChapters = sections.length;
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : (task.state === 'done' ? 100 : 0);
    const speed = task.speed || 0;
    const remain = Math.max(0, total - done);
    const etaMs = speed > 0 && remain > 0 ? Math.round((remain * avgBytes(task)) / speed) : null;
    return {
      id: task.id,
      comicId: task.comicId,
      title: task.title,
      author: task.author,
      cover: task.cover || '',
      state: task.state,
      dir: task.dir || '',
      chapters: sections,
      chapterCount: totalChapters,
      finishedChapters: finishedChapters,
      total: total,
      done: done,
      failed: failed,
      percent: percent,
      bytes: task.bytes || 0,
      speed: speed,
      etaMs: etaMs,
      // 由逐页台账命中、因而没有发 HTTP 请求的页数（断点续传的直接证据）
      ledgerHits: num(task.ledgerHits, 0),
      error: task.error || null,
      priority: num(task.priority, 0),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      logs: (task.logs || []).slice(-20)
    };
  }

  function avgBytes(task) {
    const done = (task.sections || []).reduce(function (a, s) { return a + (s.done || 0); }, 0);
    if (!done || !task.bytes) return 220 * 1024;
    return Math.max(30 * 1024, task.bytes / done);
  }

  function addLog(task, level, message) {
    if (!task.logs) task.logs = [];
    task.logs.push({ t: new Date().toISOString(), level: level || 'info', message: String(message) });
    if (task.logs.length > 200) task.logs.splice(0, task.logs.length - 200);
  }

  /* ---------------- 任务生命周期 ---------------- */

  function register(task) {
    const stored = Object.assign({}, task);
    stored.sections = (task.sections || []).map(function (s) { return Object.assign({}, s); });
    stored.logs = [];
    tasks.set(stored.id, stored);
    persist(stored);
    return stored;
  }

  function get(taskId) {
    const t = tasks.get(String(taskId));
    return t ? view(t) : null;
  }

  function list() {
    return Array.from(tasks.values()).map(view).sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  }

  function hydrate(saved) {
    const t = Object.assign({
      id: '', comicId: '', sourceId: '', title: '', author: '', cover: '',
      sections: [], state: 'paused', bytes: 0, speed: 0, logs: [], error: null, ledgerHits: 0
    }, saved || {});
    t.speed = 0;
    if (t.state === 'running' || t.state === 'queued') {
      t.state = 'paused';
      t.error = t.error || '服务重启导致中断，可点「继续」断点续传';
      addLog(t, 'warn', '服务重启，任务已暂停，可继续下载补全缺失图片');
    }
    t.sections = (t.sections || []).map(function (s) {
      return Object.assign({ order: 0, title: '', state: 'pending', total: 0, done: 0, failed: 0, error: null }, s);
    });
    for (const s of t.sections) {
      if (s.state === 'running') s.state = 'pending';
    }
    tasks.set(t.id, t);
    return t;
  }

  /** 入队：优先级大的先跑（同级按入队顺序）。 */
  function enqueue(task) {
    if (task.state === 'canceled') return;
    if (queue.indexOf(task.id) >= 0) return;
    task.state = 'queued';
    task.error = null;
    const prio = num(task.priority, 0);
    let idx = queue.length;
    for (let i = 0; i < queue.length; i++) {
      const other = tasks.get(queue[i]);
      if (num(other && other.priority, 0) < prio) { idx = i; break; }
    }
    queue.splice(idx, 0, task.id);
    persist(task);
    emitSafe('state', { taskId: task.id, state: task.state });
    schedulePump();
  }

  function schedulePump() {
    if (pumpScheduled || disposed) return;
    pumpScheduled = true;
    setTimeout(function () { pumpScheduled = false; pump().catch(function (e) { log.error('下载队列调度失败: ' + (e && e.message)); }); }, 10);
  }

  async function pump() {
    if (disposed) return;
    const max = Math.max(1, num(pica().maxConcurrentTasks, 2));
    while (activeCount < max && queue.length) {
      const id = queue.shift();
      const task = tasks.get(id);
      if (!task || task.state === 'canceled') continue;
      activeCount++;
      runTaskImpl(task, shared).catch(function (err) {
        log.error('下载任务 ' + id + ' 异常: ' + (err && err.message));
        const t = tasks.get(id);
        if (t && t.state !== 'canceled') {
          t.state = 'error';
          t.error = '任务异常：' + (err && err.message ? err.message : String(err));
          emitSafe('error', { taskId: id, message: t.error });
          persist(t);
        }
      }).finally(function () {
        activeCount--;
        schedulePump();
      });
    }
  }

  /** 创建任务（不发车）。 */
  async function createTask(input) {
    const inp = input || {};
    const task = {
      id: inp.id || ('dl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)),
      comicId: str(inp.comicId),
      sourceId: str(inp.sourceId),
      title: str(inp.title),
      author: str(inp.author),
      cover: str(inp.cover),
      dir: '',
      state: 'queued',
      bytes: 0,
      speed: 0,
      error: null,
      ledgerHits: 0,
      priority: num(inp.priority, 0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      comic: inp.comic || null,
      sections: (inp.chapters || []).map(function (ch) {
        return {
          order: num(ch.order, 0),
          title: str(ch.chapterTitle || ch.title),
          chapterId: str(ch.chapterId || ch.id),
          state: 'pending',
          total: 0,
          done: 0,
          failed: 0,
          error: null
        };
      }),
      logs: []
    };
    const p = paths();
    task.dir = p.comicDir(task.title);
    addLog(task, 'info', '任务已创建，共 ' + task.sections.length + ' 个章节');
    return register(task);
  }

  /* ---------------- 任务控制（暂停/继续/取消/删除） ---------------- */

  /* ---------------- 执行层（已拆到 engine-run.mjs） ---------------- */

  const shared = { log: log, running: running, pica: pica, paths: paths, sourceOf: sourceOf, persist: persist, patch: patch, emitSafe: emitSafe, view: view, addLog: addLog, configuredExt: configuredExt, throttleGlobal: throttleGlobal, taskImgLimiter: taskImgLimiter, chapterLimiter: chapterLimiter };

  async function pause(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    if (t.state === 'done' || t.state === 'canceled') throw new Error('任务已结束，无法暂停');
    if (!running.has(t.id)) {
      t.state = 'paused';
      emitSafe('state', { taskId: t.id, state: t.state });
      persist(t);
      return view(t);
    }
    t.state = 'paused';
    addLog(t, 'info', '用户暂停任务（等在途请求结束）');
    emitSafe('state', { taskId: t.id, state: t.state });
    persist(t);
    return view(t);
  }

  async function resume(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    if (t.state === 'running') return view(t);
    for (const s of t.sections) {
      if (s.state === 'error' || s.state === 'running') s.state = 'pending';
    }
    t.error = null;
    t.bytes = t.bytes || 0;
    addLog(t, 'info', '用户继续任务（已存在的图片会跳过）');
    enqueue(t);
    return view(t);
  }

  async function cancel(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    t.state = 'canceled';
    t.speed = 0;
    for (const s of t.sections) {
      if (s.state === 'running' || s.state === 'pending') s.state = 'pending';
    }
    addLog(t, 'warn', '用户取消任务');
    const r = running.get(t.id);
    if (r && r.controller) r.controller.abort();
    const qi = queue.indexOf(t.id);
    if (qi >= 0) queue.splice(qi, 1);
    emitSafe('state', { taskId: t.id, state: t.state });
    persist(t);
    return view(t);
  }

  async function remove(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    if (running.has(t.id)) await cancel(t.id);
    const qi = queue.indexOf(t.id);
    if (qi >= 0) queue.splice(qi, 1);
    tasks.delete(t.id);
    if (o.store && typeof o.store.remove === 'function') o.store.remove(t.id);
    // 任务被删（DELETE /api/download/tasks/:id 与 clear-done 都走这里）：台账一并清掉
    try { await removeLedger(t.id); } catch (e) { /* 台账清理失败不影响删除结果 */ }
    emitSafe('state', { taskId: t.id, state: 'removed' });
    return true;
  }

  /** 任务里失败图片的明细（供「一键重试失败项」用）。 */
  function failures(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    return {
      taskId: t.id,
      title: t.title,
      chapters: (t.sections || []).filter(function (s) { return num(s.failed, 0) > 0 || s.state === 'error'; }).map(function (s) {
        return { order: s.order, title: s.title, state: s.state, failed: num(s.failed, 0), total: num(s.total, 0), done: num(s.done, 0), error: s.error || null };
      })
    };
  }

  /** 只重试失败项：清空失败计数并把任务推回队列（已存在的图片会跳过）。 */
  async function retryFailures(taskId) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    const failedChapters = (t.sections || []).filter(function (s) { return num(s.failed, 0) > 0 || s.state === 'error' || s.state === 'pending'; });
    if (!failedChapters.length) throw new Error('该任务没有失败项');
    for (const s of failedChapters) {
      s.failed = 0;
      s.error = null;
      if (s.state === 'error' || s.state === 'running') s.state = 'pending';
    }
    t.error = null;
    addLog(t, 'info', '重试失败项：' + failedChapters.length + ' 个章节');
    enqueue(t);
    return view(t);
  }

  /** 批量操作：pause / resume / cancel / remove / retry。 */
  async function bulk(action, ids) {
    const list = Array.isArray(ids) && ids.length ? ids : Array.from(tasks.keys());
    const done = [];
    const failed = [];
    for (const id of list) {
      try {
        if (action === 'pause') await pause(id);
        else if (action === 'resume') await resume(id);
        else if (action === 'cancel') await cancel(id);
        else if (action === 'remove') await remove(id);
        else if (action === 'retry') await retryFailures(id);
        else throw new Error('不支持的批量操作：' + action);
        done.push(id);
      } catch (err) {
        failed.push({ id: id, error: err && err.message ? err.message : String(err) });
      }
    }
    return { action: action, ok: done.length, failed: failed };
  }

  /** 清空已完成的任务记录（不动磁盘文件）。 */
  async function clearDone() {
    const ids = Array.from(tasks.values()).filter(function (t) { return t.state === 'done'; }).map(function (t) { return t.id; });
    for (const id of ids) { await remove(id); }
    return { removed: ids.length };
  }

  /** 设置优先级。 */
  function setPriority(taskId, priority) {
    const t = tasks.get(String(taskId));
    if (!t) throw new Error('任务不存在');
    t.priority = num(priority, 0);
    persist(t);
    return view(t);
  }

  /** 当前正在执行的任务数。 */
  function runningCount() {
    return activeCount;
  }

  function status() {
    return {
      runningTasks: activeCount,
      queuedTasks: queue.length,
      totalTasks: tasks.size,
      maxConcurrentTasks: Math.max(1, num(pica().maxConcurrentTasks, 2))
    };
  }

  function hydrateAll(savedList) {
    for (const s of savedList || []) hydrate(s);
  }

  function dispose() {
    disposed = true;
    for (const r of running.values()) {
      if (r.controller) r.controller.abort();
    }
    running.clear();
    queue.length = 0;
  }

  return {
    createTask: createTask,
    enqueue: enqueue,
    get: get,
    list: list,
    view: view,
    hydrateAll: hydrateAll,
    hydrate: hydrate,
    pause: pause,
    resume: resume,
    cancel: cancel,
    remove: remove,
    status: status,
    failures: failures,
    retryFailures: retryFailures,
    bulk: bulk,
    clearDone: clearDone,
    setPriority: setPriority,
    runningCount: runningCount,
    paths: paths,
    buildComicMetadata: buildComicMetadata,
    dispose: dispose,
    rawTasks: function () { return tasks; }
  };
}
