/* 漫库 MangaVault · 扩展背景页：主世界桥的落盘代理
 * 主世界 fetch /api/desktop/window 失败时，代它把窗口几何交给本地内核落盘。
 * 只允许本机回环地址，拒绝 file:// 与外部域名。
 */

var ALLOW = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i;

function localBase() {
  return location.origin && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(location.origin) ? location.origin : '';
}

function submit(body) {
  var base = localBase();
  if (!base) return Promise.resolve({ ok: false, error: '非本机页面，不落盘' });
  return fetch(base + '/api/desktop/window', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
    .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var url = (sender.tab && sender.tab.url) || '';
  if (!ALLOW.test(url)) { sendResponse({ ok: false, error: '来源不允许' }); return false; }
  if (!msg || typeof msg !== 'object') { sendResponse({ ok: false, error: '空消息' }); return false; }
  if (msg.kind === 'report-window') {
    submit(msg.payload).then(sendResponse);
    return true;
  }
  if (msg.kind === 'desktop-state') {
    sendResponse({
      ok: true,
      data: {
        ok: true,
        form: 'desktop',
        shell: 'edge-app',
        version: '1.0.0',
        source: 'extension-fallback',
        canQuit: false,
        note: '本地内核尚未挂载桌面模块，此状态由扩展兜底返回'
      }
    });
    return false;
  }
  sendResponse({ ok: false, error: '未知消息' });
  return false;
});
