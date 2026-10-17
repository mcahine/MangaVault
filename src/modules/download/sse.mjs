/**
 * SSE 节流中心：包一层 hub，把高频 progress 事件按 taskId 合并，每 500ms 最多推一次。
 * 用法：
 *   const sse = createSseHub(hub, { intervalMs: 500 });
 *   sse.subscribe(fn)            // SSE 连接从这里订阅（拿到的是节流后的事件）
 *   hub.send('progress', {...})  // 引擎照常每张图都会发，节流在这里吸收
 */

export const PROGRESS_INTERVAL_MS = 500;

export function createSseHub(hub, options) {
  const o = options || {};
  const interval = Number(o.intervalMs || PROGRESS_INTERVAL_MS);
  const clients = new Set();
  const pending = new Map(); // taskId -> payload
  const milestones = [];
  let timer = null;
  let disposed = false;
  let rawCount = 0;
  let pushedCount = 0;

  function deliver(event, payload) {
    pushedCount++;
    for (const fn of clients) {
      try { fn(event, payload); } catch (e) { /* 单个订阅者异常不能影响别人 */ }
    }
  }

  function flush() {
    timer = null;
    if (disposed) return;
    const batch = Array.from(pending.values());
    pending.clear();
    for (const m of milestones.splice(0, milestones.length)) deliver(m.event, m.payload);
    for (const payload of batch) deliver('progress', payload);
  }

  function schedule() {
    if (timer || disposed) return;
    timer = setTimeout(flush, interval);
    if (timer.unref) timer.unref();
  }

  const off = hub.subscribe(function (event, payload) {
    if (disposed) return;
    rawCount++;
    // 'state' 类事件不节流：它表达的是"任务状态变了"，延迟会让 UI 卡顿感
    if (event === 'progress' && payload && payload.taskId) {
      pending.set(String(payload.taskId), payload);
      schedule();
      return;
    }
    milestones.push({ event: event, payload: payload });
    schedule();
  });

  return {
    subscribe: function (fn) {
      clients.add(fn);
      return function () { clients.delete(fn); };
    },
    clientCount: function () { return clients.size; },
    /** 订阅者以外的人（比如日志）想拿原始流时用 */
    raw: hub,
    flushNow: flush,
    dispose: function () { disposed = true; off(); if (timer) clearTimeout(timer); timer = null; pending.clear(); milestones.length = 0; clients.clear(); },
    stats: function () { return { rawEvents: rawCount, pushedEvents: pushedCount, pendingTasks: pending.size, clients: clients.size }; }
  };
}
