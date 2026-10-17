import { createLogger } from '../../core/log.mjs';
import { createEngine } from './engine.mjs';
import { prune as pruneLedgers } from './ledger.mjs';

/**
 * 下载任务队列：持久化（JsonStore('download-tasks.json')）+ SSE 事件广播。
 * 服务重启后，未完成任务统一标记为 paused，提示可续传。
 */

const STORE_FILE = 'download-tasks.json';

/** 事件中心：SSE 订阅 / 广播。 */
export function createEventHub() {
  const listeners = new Set();
  return {
    subscribe: function (fn) {
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    },
    size: function () { return listeners.size; },
    send: function (event, payload) {
      for (const fn of listeners) {
        try { fn(event, payload); } catch (e) { /* 单个订阅者异常不能影响别人 */ }
      }
    }
  };
}

/**
 * 创建任务存储与管理器。
 * options: { source, getSource(sourceId), getConfig(), log }
 *   source 是默认下载源适配器；getSource 让引擎按任务记录的 sourceId 换源（可选）。
 */
export async function createTasks(options) {
  const o = options || {};
  const log = o.log || createLogger('download', 'info');
  const getConfig = o.getConfig || function () { return {}; };
  const hub = createEventHub();
  const store = new (await import('../../core/store.mjs')).JsonStore(STORE_FILE, { tasks: [], serverStartedAt: new Date().toISOString() });
  await store.load();
  if (!store.data || typeof store.data !== 'object') store.data = { tasks: [] };
  if (!Array.isArray(store.data.tasks)) store.data.tasks = [];

  let flushing = Promise.resolve();
  function persist() {
    store.markDirty();
    flushing = store.flush().catch(function (e) { log.warn('任务状态落盘失败: ' + (e && e.message)); });
    return flushing;
  }

  // 任务存储接口（注入给 engine）
  const taskStore = {
    all: function () { return store.data.tasks || []; },
    save: function (task) { persist(); },
    remove: function (id) {
      store.data.tasks = (store.data.tasks || []).filter(function (t) { return String(t.id) !== String(id); });
      persist();
    }
  };

  const engine = createEngine({
    source: o.source,
    getSource: o.getSource,
    log: log,
    getConfig: getConfig,
    store: taskStore,
    emit: function (event, payload) { hub.send(event, payload); }
  });

  // 启动清理：超过 30 天的逐页台账直接删掉，避免 data/download/ledger 无限膨胀。
  // 这里 await 而不是放任后台跑：否则测试进程结束时还挂着未完成的异步删除，
  // 也会和紧接着的首次台账写入抢同一个目录。
  try {
    const cleaned = await pruneLedgers(30);
    if (cleaned.removed > 0) log.info('已清理 ' + cleaned.removed + ' 份超过 30 天的下载台账');
  } catch (e) {
    log.warn('清理过期下载台账失败：' + (e && e.message ? e.message : e));
  }

  // 恢复上次未完成的任务：running/queued → paused
  store.data.serverStartedAt = new Date().toISOString();
  engine.hydrateAll(store.data.tasks);
  const revived = (store.data.tasks || []).filter(function (t) { return t.state === 'paused' && t.error; }).length;
  persist();

  return {
    engine: engine,
    hub: hub,
    store: store,
    get: function (id) { return engine.get(id); },
    list: function () { return engine.list(); },
    status: function () { return engine.status(); },
    pause: function (id) { return engine.pause(id); },
    resume: function (id) { return engine.resume(id); },
    cancel: function (id) { return engine.cancel(id); },
    remove: function (id) { return engine.remove(id); },
    failures: function (id) { return engine.failures(id); },
    retryFailures: function (id) { return engine.retryFailures(id); },
    bulk: function (action, ids) { return engine.bulk(action, ids); },
    clearDone: function () { return engine.clearDone(); },
    setPriority: function (id, priority) { return engine.setPriority(id, priority); },
    flush: function () { return persist(); },
    revivedCount: function () { return revived; },
    /** 关闭：等在途请求结束（取消会中止请求，不会留半截文件）。 */
    dispose: function () { engine.dispose(); return flushing; }
  };
}


