// ============================================================
//  漫库 MangaVault · 原生能力桥（src/modules/desktop/bridge.mjs）
//
//  问题：浏览器里的页面没法直接调「弹系统对话框 / 打开资源管理器」这类原生能力，
//        而这些能力只有 C# 宿主（MangaVault.exe）才有。后端是纯 Node，也弹不出对话框。
//
//  解法：把宿主当成一个「反向长轮询的工人」。
//    · 宿主启动后不停 GET /api/desktop/native/next（长轮询，挂 20 秒）
//    · 前端 POST /api/desktop/pick-dir 时，后端把这条命令塞进队列，
//      正在挂着的那个长轮询立刻把它吐给宿主
//    · 宿主执行完（比如用户在对话框里点了确定），POST /api/desktop/native/result 回执
//    · 后端把结果交回给还在等待的前端请求
//
//  这个文件只做「队列 + 等待者 + 在途命令」的状态机，不碰 HTTP、不碰文件系统，
//  因此可以完全离线单测（见 tests/desktop.test.mjs）。
//
//  ★ 为什么要 hostTtlMs：宿主可能被用户直接杀掉。若不做超时，
//    「宿主已死」会被永远当成「还在线」，前端就会一直等一个不会来的回执。
// ============================================================

/** 生成命令 id：时间戳 + 自增序列，进程内唯一即可（不需要全局唯一） */
function makeIdFactory() {
  let seq = 0;
  return function () {
    seq += 1;
    return 'c' + Date.now().toString(36) + '-' + seq.toString(36);
  };
}

/**
 * 创建一个原生能力桥。
 * opts.now       注入时钟（单测用）
 * opts.hostTtlMs 宿主心跳有效期，默认 30s
 * opts.pollMs    单次长轮询最长挂起时间，默认 20s
 */
export function createBridge(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const hostTtlMs = Number.isFinite(o.hostTtlMs) ? o.hostTtlMs : 30000;
  const maxPollMs = Number.isFinite(o.pollMs) ? o.pollMs : 20000;
  const nextId = makeIdFactory();

  /** 待宿主领取的命令（FIFO） */
  const queue = [];
  /** 已交给宿主、等待回执的命令 id -> { resolve, timer } */
  const inflight = new Map();
  /** 当前挂着的长轮询 */
  let waiter = null;
  /** 最近一次心跳的宿主信息 */
  let host = null;

  /** 宿主来长轮询时登记一次心跳 */
  function noteHost(info) {
    host = {
      pid: Number(info && info.pid) || null,
      exe: info && info.exe ? String(info.exe) : null,
      at: now()
    };
    return host;
  }

  /** 宿主是否在线（心跳没过期） */
  function attached() {
    if (!host) return false;
    return (now() - host.at) < hostTtlMs;
  }

  function status() {
    return {
      attached: attached(),
      host: attached() ? { pid: host.pid, exe: host.exe, lastSeenMs: now() - host.at } : null
    };
  }

  /** 完成一个等待者（把命令交出去或返回 null 让宿主重连） */
  function settleWaiter(cmd) {
    if (!waiter) return false;
    const w = waiter;
    waiter = null;
    if (w.timer) clearTimeout(w.timer);
    w.resolve(cmd);
    return true;
  }

  /**
   * 宿主长轮询：有命令立刻给，没有就挂着直到超时。
   * 返回命令对象或 null（null = 没有命令，宿主可立即再来一次）。
   */
  function poll(timeoutMs) {
    const wait = Math.max(0, Math.min(Number.isFinite(timeoutMs) ? timeoutMs : maxPollMs, maxPollMs));
    if (queue.length) return Promise.resolve(queue.shift());
    /* 同一时刻只允许一个挂起者：旧的先放回（返回 null 让它重连），避免命令发丢 */
    settleWaiter(null);
    return new Promise(function (resolve) {
      const entry = { resolve: resolve, timer: null };
      entry.timer = setTimeout(function () {
        if (waiter === entry) waiter = null;
        resolve(null);
      }, wait);
      if (entry.timer.unref) entry.timer.unref();
      waiter = entry;
    });
  }

  /**
   * 提交一条原生命令，等宿主的回执。
   * 返回 { ok:true, result } / { ok:false, error } / { ok:false, timeout:true, error }
   */
  function submit(kind, payload, timeoutMs) {
    const id = nextId();
    const cmd = { id: id, kind: String(kind), payload: payload || {} };
    return new Promise(function (resolve) {
      let settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        inflight.delete(id);
        resolve(value);
      }
      const ttl = Number.isFinite(timeoutMs) ? timeoutMs : 30000;
      const timer = setTimeout(function () {
        finish({ ok: false, timeout: true, error: '原生能力响应超时（宿主可能已关闭）' });
      }, ttl);
      if (timer.unref) timer.unref();
      inflight.set(id, { resolve: finish, timer: timer });
      /* 有挂着的长轮询就直接喂给它，否则排队等宿主下次来取 */
      if (!settleWaiter(cmd)) queue.push(cmd);
    });
  }

  /** 宿主回执 */
  function resolve(id, result) {
    const entry = inflight.get(String(id));
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    inflight.delete(String(id));
    /* 不直接调用 entry.resolve，让它走自己的幂等收口 */
    entry.resolve({ ok: true, result: result });
    return true;
  }

  /** 进程收尾：把还在等的请求全部唤醒，避免请求悬挂 */
  function dispose(reason) {
    const message = reason || '桌面宿主已退出，原生能力不可用';
    const waiting = Array.from(inflight.values());
    inflight.clear();
    queue.length = 0;
    settleWaiter(null);
    for (const entry of waiting) {
      if (entry.timer) clearTimeout(entry.timer);
      try { entry.resolve({ ok: false, error: message }); } catch (e) { /* 收尾阶段的异常一律吞掉 */ }
    }
  }

  return {
    noteHost: noteHost,
    status: status,
    attached: attached,
    poll: poll,
    submit: submit,
    resolve: resolve,
    dispose: dispose,
    /* 供单测观察内部状态，不要在生产代码里改它 */
    snapshot: function () {
      return { queued: queue.length, inflight: inflight.size, waiting: Boolean(waiter), host: host };
    }
  };
}

/* ============================================================
 *  结果解析：宿主回执里的 result 是一段 JSON **字符串**
 * ============================================================ */

/**
 * 把宿主回执解析成 { ok, value } 或 { ok:false, error }。
 * 宿主所有能力的返回值都形如 {"ok":true,...} 或 {"ok":false,"error":"中文原因"}。
 */
export function parseHostResult(raw) {
  if (raw === null || raw === undefined) return { ok: false, error: '宿主没有返回任何结果' };
  let obj = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return { ok: false, error: '宿主返回了空结果' };
    try { obj = JSON.parse(text); }
    catch (e) { return { ok: false, error: '宿主返回的内容不是合法 JSON：' + text.slice(0, 120) }; }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '宿主返回的内容不是对象' };
  if (obj.ok === false) return { ok: false, error: obj.error ? String(obj.error) : '宿主执行失败（未给出原因）' };
  return { ok: true, value: obj };
}
