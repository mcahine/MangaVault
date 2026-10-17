/* 漫库 MangaVault · 桌面外壳桥（主世界内容脚本，document_start 注入）
 * 职责：
 *  1) 给 <html> 打 data-platform="desktop"，让页面按桌面形态渲染
 *  2) 上报窗口几何到 POST /api/desktop/window（供启动器记忆尺寸/位置）
 *  3) 只读接口兜底：桌面模块尚未挂载时，由扩展背景页代为回答 /api/desktop/state，
 *     避免页面出现 404 报错
 */
(function () {
  var BRIDGE_SRC = 'mv-desktop-bridge';
  var reported = '';

  function markPlatform() {
    var html = document.documentElement;
    if (!html) return false;
    html.setAttribute('data-platform', 'desktop');
    return true;
  }

  function geometry() {
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenX: window.screenX,
      screenY: window.screenY,
      devicePixelRatio: window.devicePixelRatio
    };
  }

  function askBridge(kind, payload) {
    return new Promise(function (resolve) {
      var id = 'mv-' + Math.random().toString(36).slice(2) + '-' + Date.now();
      var timer = setTimeout(function () {
        window.removeEventListener('message', onReply);
        resolve(null);
      }, 1500);
      function onReply(ev) {
        var d = ev.data;
        if (!d || d.source !== BRIDGE_SRC || d.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onReply);
        resolve(d);
      }
      window.addEventListener('message', onReply);
      window.postMessage({ source: BRIDGE_SRC, direction: 'up', id: id, kind: kind, payload: payload || {} }, '*');
    });
  }

  /* 最小化时 screenX/screenY 在 Windows 上是 -32000，上报它会把窗口记忆写到屏幕外。
     宁可不上报位置（后端保留旧值/自动居中），也不要把用户窗口弄丢。 */
  function minimized() {
    try {
      if (document.hidden) return true;
      if (window.screenX <= -30000 || window.screenY <= -30000) return true;
      if (window.outerWidth <= 0 || window.outerHeight <= 0) return true;
    } catch (e) { /* 读不到就按未最小化处理 */ }
    return false;
  }

  function report(force) {
    var g = geometry();
    // 用窗口外框尺寸做记忆（App 模式无浏览器 chrome，外框≈可用窗口）
    var w = Math.max(g.outerWidth || 0, g.innerWidth || 0);
    var h = Math.max(g.outerHeight || 0, g.innerHeight || 0);
    var body = { width: w, height: h, innerWidth: g.innerWidth, innerHeight: g.innerHeight, source: 'page' };
    var min = minimized();
    if (!min) { body.x = g.screenX; body.y = g.screenY; }
    body.minimized = min;
    var key = body.width + 'x' + body.height + '@' + (min ? 'min' : body.x + ',' + body.y);
    if (!force && key === reported) return;
    reported = key;
    try {
      window.fetch('/api/desktop/window', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (res) {
        if (!res || !res.ok) throw new Error('backend');
        return res.json();
      }).catch(function () {
        // 后端桌面模块未挂载：交给扩展背景页落盘（写到 data/desktop-window.json）
        askBridge('report-window', body);
      });
    } catch (e) { askBridge('report-window', body); }
  }

  /* ---------- 只读接口兜底 ---------- */
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = '';
      try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) { url = ''; }
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var p = origFetch(input, init);
      var isDesktopState = method === 'GET' && url.indexOf('/api/desktop/state') !== -1;
      if (!isDesktopState) return p;
      return p.then(function (res) {
        if (res.status !== 404) return res;
        return askBridge('desktop-state').then(function (reply) {
          if (!reply || !reply.ok) return res;
          return new Response(JSON.stringify(reply.data), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
        });
      });
    };
  }

  /* ---------- 启动 ---------- */
  if (!markPlatform()) {
    var mo = new MutationObserver(function () { if (markPlatform()) mo.disconnect(); });
    mo.observe(document, { childList: true, subtree: true });
  }
  window.addEventListener('DOMContentLoaded', function () { markPlatform(); report(true); });
  window.addEventListener('load', function () { report(true); });
  window.addEventListener('resize', function () { clearTimeout(report._t); report._t = setTimeout(function () { report(false); }, 400); });
  setInterval(function () { report(false); }, 20000);
})();
