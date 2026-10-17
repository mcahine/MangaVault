/* 漫库 MangaVault · 桥接脚本（隔离世界）：把主世界的请求转发给背景页 */
(function () {
  var BRIDGE_SRC = 'mv-desktop-bridge';
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.source !== BRIDGE_SRC || d.direction !== 'up') return;
    try {
      chrome.runtime.sendMessage({ kind: d.kind, payload: d.payload }, function (reply) {
        var err = chrome.runtime.lastError;
        window.postMessage({ source: BRIDGE_SRC, direction: 'down', id: d.id, ok: !err, data: reply && reply.data, error: err ? err.message : (reply && reply.error) }, '*');
      });
    } catch (e) {
      window.postMessage({ source: BRIDGE_SRC, direction: 'down', id: d.id, ok: false, error: String(e && e.message || e) }, '*');
    }
  });
})();
