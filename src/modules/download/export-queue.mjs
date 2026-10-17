import fsp from 'node:fs/promises';
import path from 'node:path';
import { JsonStore } from '../../core/store.mjs';
import { collectComicFiles, zipComic, copyFolder, safeFileBase } from './export.mjs';

/**
 * 导出任务队列：后台跑，SSE 推进度。
 *  - zip / cbz：零依赖手写 ZIP（CBZ 只是换扩展名）
 *  - folder：直接复制目录
 * 任务记录持久化到 data/download-exports.json（保留最近 50 条）。
 */

const STORE_FILE = 'download-exports.json';

export function createExportQueue(options) {
  const o = options || {};
  const log = o.log || { info: function () {}, warn: function () {}, error: function () {} };
  const emit = o.emit || function () {};
  const getConfig = o.getConfig || function () { return {}; };
  const store = new JsonStore(STORE_FILE, { jobs: [] });
  let loaded = false;
  let seq = 0;

  /** 后台单飞：同一时刻只跑一个导出，避免把磁盘打满。 */
  let busy = false;
  const queue = [];

  async function ensureLoaded() {
    if (loaded) return;
    await store.load();
    if (!store.data || typeof store.data !== 'object') store.data = { jobs: [] };
    if (!Array.isArray(store.data.jobs)) store.data.jobs = [];
    loaded = true;
  }

  function persist() {
    store.markDirty();
    store.flush().catch(function (e) { log.warn('导出记录落盘失败: ' + (e && e.message)); });
  }

  function jobView(job) {
    return {
      id: job.id, comicId: job.comicId, title: job.title, name: job.name,
      format: job.format, state: job.state, progress: job.progress || 0,
      total: job.total || 0, files: job.files || 0, bytes: job.bytes || 0,
      outPath: job.outPath || '', error: job.error || null,
      createdAt: job.createdAt, updatedAt: job.updatedAt
    };
  }

  /**
   * 建导出任务。
   * items: [{ comicId, title, dir }]
   * opts: { format:'zip'|'cbz'|'folder', outDir, method:'deflate'|'store' }
   */
  async function submit(items, opts) {
    await ensureLoaded();
    const opt = opts || {};
    const format = ['zip', 'cbz', 'folder'].indexOf(String(opt.format)) >= 0 ? String(opt.format) : 'zip';
    const list = (items || []).filter(function (x) { return x && x.dir; });
    if (!list.length) throw new Error('没有可导出的漫画（目录不存在或未指定）');
    const outDir = String(opt.outDir || '');
    if (!outDir) throw new Error('未配置导出目录');
    await fsp.mkdir(outDir, { recursive: true });
    const job = {
      id: 'ex-' + Date.now().toString(36) + '-' + (++seq),
      format: format,
      outDir: outDir,
      method: opt.method === 'store' ? 'store' : 'deflate',
      items: list,
      state: 'queued',
      progress: 0,
      total: list.length,
      files: 0,
      bytes: 0,
      outPath: '',
      results: [],
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    // 落盘时不要把 items 里的绝对路径留着太久（本机用没问题，但保持精简）
    store.data.jobs.unshift(job);
    if (store.data.jobs.length > 50) store.data.jobs.length = 50;
    persist();
    queue.push(job.id);
    schedule();
    emit('export', { taskId: job.id, ...jobView(job) });
    return jobView(job);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () { scheduled = false; drain(); }, 5);
  }

  async function drain() {
    if (busy) return;
    const id = queue.shift();
    if (!id) return;
    const job = (store.data.jobs || []).filter(function (j) { return j.id === id; })[0];
    if (!job || job.state !== 'queued') { schedule(); return; }
    busy = true;
    try {
      await run(job);
    } catch (err) {
      job.state = 'error';
      job.error = '导出失败：' + (err && err.message ? err.message : err);
      job.updatedAt = new Date().toISOString();
      persist();
      emit('error', { taskId: job.id, message: job.error });
    } finally {
      busy = false;
      schedule();
    }
  }

  async function run(job) {
    job.state = 'running';
    job.updatedAt = new Date().toISOString();
    emit('export', { taskId: job.id, ...jobView(job) });
    const ext = job.format === 'folder' ? '' : ('.' + job.format);
    let index = 0;
    for (const item of job.items) {
      index++;
      const base = safeFileBase(item.title || item.comicId || ('comic-' + index), 'comic');
      if (job.format === 'folder') {
        const dest = path.join(job.outDir, base);
        const copied = await copyFolder(item.dir, dest, { overwrite: false });
        job.results.push({ comicId: item.comicId, title: item.title, path: copied.dir, files: copied.files });
        job.files += copied.files;
        // 估算体积
        try {
          const files = await collectComicFiles(copied.dir, { imagesOnly: false });
          for (const f of files) {
            try { job.bytes += (await fsp.stat(f.abs)).size; } catch (e) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }
      } else {
        const buf = await zipComic(item.dir, { method: job.method });
        const target = path.join(job.outDir, base + ext);
        const tmp = target + '.tmp-' + process.pid;
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, target);
        job.results.push({ comicId: item.comicId, title: item.title, path: target, files: 0, bytes: buf.length });
        job.bytes += buf.length;
      }
      job.progress = Math.round((index / job.items.length) * 100);
      job.outPath = job.results[job.results.length - 1].path;
      job.updatedAt = new Date().toISOString();
      persist();
      emit('progress', { taskId: job.id, ...jobView(job) });
    }
    job.state = 'done';
    job.progress = 100;
    job.updatedAt = new Date().toISOString();
    persist();
    log.info('导出完成：' + job.items.length + ' 部 → ' + job.outDir);
    emit('done', { taskId: job.id, ...jobView(job) });
  }

  async function listJobs() {
    await ensureLoaded();
    return (store.data.jobs || []).map(jobView);
  }

  async function getJob(id) {
    await ensureLoaded();
    const job = (store.data.jobs || []).filter(function (j) { return j.id === String(id); })[0];
    return job ? Object.assign({}, jobView(job), { results: job.results || [] }) : null;
  }

  async function removeJob(id) {
    await ensureLoaded();
    store.data.jobs = (store.data.jobs || []).filter(function (j) { return j.id !== String(id); });
    persist();
    return true;
  }

  return {
    submit: submit,
    list: listJobs,
    get: getJob,
    remove: removeJob,
    isBusy: function () { return busy; },
    queuedCount: function () { return queue.length; },
    store: store
  };
}
