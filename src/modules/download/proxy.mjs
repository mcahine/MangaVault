import { execFile } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

/**
 * 代理模式解析：none / system / manual（外加兼容旧字段 picacomic.proxy）。
 *   none   → 不走代理
 *   system → 读 Windows 注册表 HKCU\...\Internet Settings 的 ProxyEnable/ProxyServer
 *   manual → 用 proxyHost/proxyPort 拼
 * 返回 { url, mode, source, detail }，url 为空表示直连。
 */

/** 从注册表查询字符串里解析出代理地址（支持 "127.0.0.1:7897" 与 "http=...;https=..." 形态）。 */
export function parseSystemProxy(raw) {
  if (!raw || typeof raw !== 'object') return '';
  if (Number(raw.ProxyEnable) !== 1) return '';
  const server = String(raw.ProxyServer || '').trim();
  if (!server) return '';
  if (server.indexOf('=') < 0) return normalizeProxyUrl(server);
  const parts = server.split(';');
  const map = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    map[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim();
  }
  return normalizeProxyUrl(map.https || map.http || map.socks || '');
}

/** 补全成 http://host:port 形式。 */
export function normalizeProxyUrl(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  s = s.replace(/^"|"$/g, '');
  if (s.indexOf('://') < 0) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!u.hostname) return '';
    if (!u.port) u.port = u.protocol === 'https:' ? '443' : '80';
    return u.protocol + '//' + u.hostname + ':' + u.port;
  } catch (e) {
    return '';
  }
}

/** 读取 Windows 系统代理（非 Windows 或查询失败返回空）。 */
export function readSystemProxy() {
  return new Promise(function (resolve) {
    if (process.platform !== 'win32') { resolve(''); return; }
    const args = ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'];
    execFile('reg', args, { windowsHide: true, timeout: 5000 }, function (err, stdout) {
      if (err || !stdout) { resolve(''); return; }
      const out = {};
      const lines = String(stdout).split(/\r?\n/);
      for (const line of lines) {
        const m = /^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL)\s+REG_\w+\s+(.*)$/.exec(line);
        if (m) out[m[1]] = m[2].trim();
      }
      resolve(parseSystemProxy(out));
    });
  });
}

/** 解析当前生效的代理配置。 */
export async function resolveProxy(picaConfig) {
  const cfg = picaConfig || {};
  const mode = String(cfg.proxyMode || (cfg.proxy ? 'manual' : 'none')).toLowerCase();
  if (mode === 'none' || mode === 'off' || mode === 'direct') {
    return { url: '', mode: 'none', source: '配置为不使用代理', detail: '' };
  }
  if (mode === 'system') {
    const url = await readSystemProxy();
    return {
      url: url, mode: 'system',
      source: 'Windows 系统代理',
      detail: url ? ('已读取系统代理 ' + url) : '系统未启用代理，将直连'
    };
  }
  // manual：优先 proxyHost/proxyPort，其次旧的 proxy 字段
  const host = String(cfg.proxyHost || '').trim();
  const port = String(cfg.proxyPort || '').trim();
  if (host) {
    const url = normalizeProxyUrl(host + ':' + (port || '80'));
    return { url: url, mode: 'manual', source: '手动配置', detail: '使用 ' + url };
  }
  const legacy = normalizeProxyUrl(cfg.proxy || '');
  return {
    url: legacy, mode: legacy ? 'manual' : 'none',
    source: legacy ? '手动配置（picacomic.proxy 兼容字段）' : '未配置代理',
    detail: legacy ? ('使用 ' + legacy) : '将直连哔咔接口'
  };
}

/**
 * TCP/TLS 连通性测试：直连或经代理 CONNECT 隧道访问目标。
 * target 形如 { host, port, tls }，默认测 apiBase 的主机。
 */
export function testConnection(options) {
  const o = options || {};
  const host = String(o.host || 'picaapi.picacomic.com');
  const port = Number(o.port || (o.tls === false ? 80 : 443));
  const useTls = o.tls !== false;
  const proxy = o.proxy ? normalizeProxyUrl(o.proxy) : '';
  const timeoutMs = Number(o.timeoutMs || 8000);
  const startedAt = Date.now();
  return new Promise(function (resolve) {
    let socket = null;
    let settled = false;
    const timer = setTimeout(function () { finish(false, '连接超时（' + timeoutMs + 'ms）'); }, timeoutMs);
    if (timer.unref) timer.unref();

    function finish(ok, message, extra) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (socket) socket.destroy(); } catch (e) { /* ignore */ }
      resolve(Object.assign({
        ok: ok, message: message, host: host, port: port, tls: useTls,
        proxy: proxy || null, elapsedMs: Date.now() - startedAt
      }, extra || {}));
    }

    if (!proxy) {
      const s = useTls ? tls.connect({ host: host, port: port, servername: host }) : net.connect({ host: host, port: port });
      socket = s;
      s.once(useTls ? 'secureConnect' : 'connect', function () { finish(true, '直连成功（' + host + ':' + port + '）'); });
      s.once('error', function (err) { finish(false, '直连失败：' + (err && err.message ? err.message : err)); });
      return;
    }

    const pu = new URL(proxy);
    const ps = net.connect({ host: pu.hostname, port: Number(pu.port) || 80 });
    socket = ps;
    let head = '';
    ps.once('connect', function () {
      ps.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n\r\n');
    });
    ps.once('error', function (err) { finish(false, '连接代理失败：' + (err && err.message ? err.message : err)); });
    ps.on('data', function (chunk) {
      head += chunk.toString('latin1');
      if (head.indexOf('\r\n\r\n') < 0) return;
      const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(head.split('\r\n')[0] || '');
      const code = m ? Number(m[1]) : 0;
      if (code !== 200) { finish(false, '代理拒绝隧道（HTTP ' + code + '）'); return; }
      ps.removeAllListeners('data');
      if (!useTls) { finish(true, '经代理连通成功（' + proxy + ' → ' + host + ':' + port + '）'); return; }
      const secure = tls.connect({ socket: ps, servername: host }, function () { finish(true, '经代理连通成功（' + proxy + ' → ' + host + ':' + port + '）'); });
      secure.once('error', function (err) { finish(false, 'TLS 握手失败：' + (err && err.message ? err.message : err)); });
    });
  });
}
