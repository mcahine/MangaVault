import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

/**
 * 哔咔（PicACG）HTTP 链路。
 *
 * 职责边界（见 docs/DOWNLOAD_SOURCES.md §1）：
 *   本文件只回答「怎么把请求发出去」—— 签名、重试退避、代理 CONNECT 隧道、chunked 解码、二进制下载；
 *   具体接口路径与字段映射全部在 sources/picacomic.mjs。
 *   所以客户端只暴露两个方法：raw()（唯一请求入口）与 download()（二进制）。
 *
 * 签名算法（与 lanyeeee/picacomic-downloader 的 src-tauri/src/pica_client.rs 一致）：
 *   data      = lowercase(path + time + nonce + method + apiKey)   // path 不含 query
 *   signature = HMAC-SHA256(DIGEST_KEY, data) 的小写 hex
 * 注意：这不是"裸 sha256"，必须带 DIGEST_KEY 这个固定盐，否则服务端一律 401。
 * 请求头里时间戳字段名是 time（不是 timestamp）。
 *
 * 依赖注入：fetchImpl / transport 可替换，方便离线单测。
 */

export const PICA_API_KEY = 'C69BAF41DA5ABD1FFEDC6D2FEA56B';
export const PICA_NONCE = 'ptxdhmjzqtnrtwndhbxcpkjamb33w837';
export const PICA_DIGEST_KEY = '~d}$Q7$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn';
/**
 * 哔咔要求的客户端标识。
 *
 * 必须是 okhttp/3.8.1（与上游安卓客户端的真实发包一致）。
 * 踩坑记录：曾写成较新的 okhttp/3.12.13 —— 公开接口（如排行榜）照样 200，
 * 但**任何带 authorization 的接口**一律回 401 {"error":"1005"}，看起来像 token 失效，
 * 实际是 UA 触发了上游的风控。实测对照（同一 token、同一签名）：
 *   okhttp/3.8.1  -> 200 拿到用户资料
 *   okhttp/3.12.13 -> 401 1005
 * 见 docs/team/dedupe-diagnosis.md 同批排查与 tests/download.test.mjs 的回归断言。
 */
export const PICA_USER_AGENT = 'okhttp/3.8.1';
export const PICA_ACCEPT = 'application/vnd.picacomic.com.v1+json';

/** 上游/客户端错误：status 为 HTTP 状态码（0 表示网络层错误）。 */
export class PicaError extends Error {
  constructor(message, status, path) {
    super(message);
    this.name = 'PicaError';
    this.status = status || 0;
    this.path = path || '';
  }
}

/** 生成签名串；抽出来单独导出便于单测断言。 */
export function createSignature(path, method, time, options) {
  const o = options || {};
  const apiKey = o.apiKey || PICA_API_KEY;
  const nonce = o.nonce || PICA_NONCE;
  const digestKey = o.digestKey || PICA_DIGEST_KEY;
  const data = signPath(path) + String(time) + String(nonce) + String(method).toUpperCase() + String(apiKey);
  return crypto.createHmac('sha256', digestKey).update(data.toLowerCase()).digest('hex');
}

/**
 * 取出用于签名的路径：只去掉前导斜杠，**必须保留 query**。
 *
 * ★ 这里踩过大坑，改之前先读完：
 *   哔咔的签名原文是 path + time + nonce + METHOD + apiKey 整串小写，
 *   而 path 是**含 query 的完整请求路径**（参考实现 pica_client.rs:429 的
 *   create_signature 收到的就是 `comics/leaderboard?tt=H24&ct=VC`）。
 *   本函数曾把 '?' 之后整段剥掉再签名 —— 于是所有**带 query 的端点**
 *   （排行榜 / 搜索 / 收藏 / 漫画列表 / 章节列表）签名全错，上游却**不报错**：
 *   HTTP 200 + `{"code":200,"message":"success"}`（41 字节，没有 data）。
 *   不带 query 的端点（users/profile、categories）不受影响，所以极容易被
 *   误判成「排行榜接口数据结构变了」。实测对照（同一 token、同一代理）：
 *     comics/leaderboard?tt=H24&ct=VC  剥 query → 41 字节无 data
 *                                      含 query → 37968 字节真实 data
 *   见 tests/download.test.mjs 的回归断言与 AGENT.md §11。
 */
export function signPath(path) {
  return String(path || '').replace(/^\/+/, '');
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function exMessage(err) {
  if (!err) return '未知错误';
  if (err.code === 'ABORT_ERR' || err.name === 'AbortError') return '请求超时或被取消';
  return err.message || String(err);
}

/** 把上游响应/异常翻译成中文原因。 */
/**
 * 把上游响应翻译成中文原因。
 *
 * ★ 必须优先读哔咔的**业务错误码**（body 里的 error 字段），不能只看 HTTP 状态码：
 *   哔咔在 HTTP 400/401 里塞的是业务码，1001（accept 头不合法）/1003（签名错）/
 *   1005（鉴权失败）**都会伴随 401**。早先这里只按 status===401 判断，一律输出
 *   「token 无效或已过期」—— 排查时被这句话带偏过好几轮（明明签名错了却让人去换 token）。
 */
export function translateError(status, bodyText, path) {
  const raw = String(bodyText || '');
  const snippet = raw.replace(/\s+/g, ' ').slice(0, 160);
  const suffix = snippet ? '（' + snippet + '）' : '';
  let biz = '';
  try {
    const j = JSON.parse(raw);
    if (j && j.error) biz = String(j.error);
  } catch (e) { /* 非 JSON 就走状态码分支 */ }

  const BIZ = {
    '1001': '哔咔拒绝了请求头（accept 格式不合法），多半是客户端版本头对不上',
    '1002': '哔咔拒绝了 api-key，请检查客户端常量是否被改动',
    '1003': '哔咔拒绝了签名（signature 校验失败），本机时间偏差过大时也会这样',
    '1005': '哔咔鉴权失败：token 无效、已过期，或账号已在别处退出',
    '1008': '哔咔拒绝了这次请求：账号被封禁或无权访问'
  };
  if (biz && BIZ[biz]) return BIZ[biz] + suffix;
  if (biz) return '哔咔返回错误码 ' + biz + suffix;

  if (status === 404) return '漫画或章节不存在（可能已被删除）' + suffix;
  if (status === 429) return '请求过于频繁被哔咔限流，请调大下载间隔后重试' + suffix;
  if (status >= 500) return '哔咔服务端错误 HTTP ' + status + '，稍后重试' + suffix;
  if (status === 401 || status === 403) return '哔咔鉴权失败（HTTP ' + status + '），请到「设置」里更新 token' + suffix;
  if (status > 0) return '哔咔接口返回 HTTP ' + status + suffix;
  return '网络请求失败：' + snippet;
}

/* ------------------------------------------------------------------ *
 * 原始 HTTP 传输层（支持 http 代理 CONNECT 隧道）
 * ------------------------------------------------------------------ */

export class RawHttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'RawHttpError';
    this.status = status || 0;
    this.body = body || '';
  }
}

function buildTargetUrl(baseUrl, path) {
  const rel = String(path || '');
  // 图片/封面下载传进来的就是**完整 URL**，而 baseUrl 是空串。
  // 旧实现无条件拼成 '/https://...' 再 new URL() —— 直接抛 "Invalid URL"，
  // 于是「配置了代理时，所有图片下载必然失败」。无代理走的是全局 fetch 分支，
  // 不受影响，所以这个 bug 只在开了代理的机器上出现（本机正是如此）。
  if (/^https?:\/\//i.test(rel)) return new URL(rel);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return new URL(base + (rel.startsWith('/') ? rel : '/' + rel));
}

function defaultPort(u) {
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

function serializeRequest(u, method, headers, bodyBuffer, proxyUrl) {
  const lines = [];
  lines.push(String(method).toUpperCase() + ' ' + (u.pathname || '/') + (u.search || '') + ' HTTP/1.1');
  const hostHeader = u.host;
  const head = Object.assign({}, headers);
  head.Host = hostHeader;
  head.Connection = 'close';
  head['Accept-Encoding'] = 'identity';
  head['Content-Length'] = String(bodyBuffer ? bodyBuffer.length : 0);
  if (proxyUrl) {
    const s = proxyUrl.protocol + '//' + proxyUrl.host;
    head['Proxy-Connection'] = 'close';
    if (s) head['X-Proxy-Url'] = s;
  }
  for (const k of Object.keys(head)) {
    const v = head[k];
    if (v === undefined || v === null) continue;
    lines.push(k + ': ' + v);
  }
  lines.push('');
  lines.push('');
  const headText = lines.join('\r\n');
  const headBuf = Buffer.from(headText, 'latin1');
  if (!bodyBuffer || !bodyBuffer.length) return headBuf;
  return Buffer.concat([headBuf, bodyBuffer]);
}

function startTunnel(proxyUrl, targetHost, targetPort, timeoutMs, targetTls) {
  return new Promise(function (resolve, reject) {
    const isTls = proxyUrl.protocol === 'https:';
    const opts = { host: proxyUrl.hostname, port: defaultPort(proxyUrl) };
    const socket = isTls ? tls.connect(Object.assign({ servername: proxyUrl.hostname }, opts)) : net.connect(opts);
    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (e) { /* ignore */ }
      reject(new Error('连接代理 ' + proxyUrl.host + ' 超时'));
    }, timeoutMs || 8000);
    if (timer.unref) timer.unref();

    function onData(chunk) {
      const text = chunk.toString('latin1');
      const idx = text.indexOf('\r\n\r\n');
      if (idx < 0 && text.length < 4096) return; // 头部还没收完
      clearTimeout(timer);
      if (done) return;
      done = true;
      socket.removeListener('data', onData);
      const firstLine = text.split('\r\n')[0] || '';
      const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(firstLine);
      const code = m ? Number(m[1]) : 0;
      if (code !== 200) {
        try { socket.destroy(); } catch (e) { /* ignore */ }
        reject(new Error('代理拒绝建立隧道（HTTP ' + code + '）'));
        return;
      }
      if (targetTls) {
        // 隧道已建立：如果目标站是 https，需要再叠加一层 TLS（与代理本身是否 https 无关）
        const secure = tls.connect({ socket: socket, servername: targetHost }, function () {
          clearTimeout(timer);
          resolve(secure);
        });
        secure.once('error', function (err) {
          clearTimeout(timer);
          if (done) return;
          done = true;
          reject(new Error('与 ' + targetHost + ' 建立 TLS 失败：' + exMessage(err)));
        });
      } else {
        resolve(socket);
      }
    }

    socket.once(isTls ? 'secureConnect' : 'connect', function () {
      socket.write('CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\nHost: ' + targetHost + ':' + targetPort + '\r\n\r\n');
      socket.on('data', onData);
    });
    socket.once('error', function (err) {
      clearTimeout(timer);
      if (done) return;
      done = true;
      reject(new Error('连接代理失败：' + exMessage(err)));
    });
  });
}

/** 极简 HTTP/1.1 请求（可选代理隧道），返回 { status, headers, body(Buffer) }。 */
/**
 * 单跳 HTTP 请求：发一次请求、拿回响应（**不跟随重定向**）。
 * 对外的入口是下面的 rawHttpRequest()，它负责跟随 3xx。
 */
function rawHttpRequestOnce(options) {
  const o = options || {};
  const u = buildTargetUrl(o.baseUrl, o.path);
  const method = o.method || 'GET';
  const bodyBuffer = o.body ? Buffer.from(o.body) : null;
  const timeoutMs = o.timeoutMs || 30000;
  const signal = o.signal;
  const proxy = o.proxy ? new URL(String(o.proxy)) : null;

  return new Promise(function (resolve, reject) {
    let settled = false;
    let socket = null;
    let timer = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      try { if (socket) socket.destroy(); } catch (e) { /* ignore */ }
      reject(err);
    }
    function done(res) {
      if (settled) return;
      settled = true;
      cleanup();
      try { if (socket) socket.destroy(); } catch (e) { /* ignore */ }
      resolve(res);
    }
    function onAbort() { fail(new RawHttpError('请求被取消', 0, '')); }

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(function () { fail(new RawHttpError('请求超时（' + timeoutMs + 'ms）', 0, '')); }, timeoutMs);
    if (timer.unref) timer.unref();

    const targetPort = defaultPort(u);
    const connectPromise = proxy
      ? startTunnel(proxy, u.hostname, targetPort, timeoutMs, u.protocol === 'https:')
      : new Promise(function (res, rej) {
          const s = u.protocol === 'https:' ? tls.connect({ host: u.hostname, port: targetPort, servername: u.hostname }) : net.connect({ host: u.hostname, port: targetPort });
          s.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', function () { res(s); });
          s.once('error', rej);
        });

    connectPromise.then(function (s) {
      if (settled) { try { s.destroy(); } catch (e) { /* ignore */ } return; }
      socket = s;
      socket.on('error', function (err) { fail(new RawHttpError('网络错误：' + exMessage(err), 0, '')); });
      let buf = Buffer.alloc(0);
      let headerEnd = -1;
      let headerText = '';
      let status = 0;
      let headers = {};
      let contentLength = -1;
      let chunked = false;
      let bodyBytes = [];
      let bodyLen = 0;

      socket.on('data', function (chunk) {
        buf = Buffer.concat([buf, chunk]);
        if (headerEnd < 0) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx < 0) {
            if (buf.length > 65536) fail(new RawHttpError('响应头过大', 0, ''));
            return;
          }
          headerEnd = idx + 4;
          headerText = buf.slice(0, idx).toString('latin1');
          const lines = headerText.split('\r\n');
          const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0] || '');
          status = m ? Number(m[1]) : 0;
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            const p = line.indexOf(':');
            if (p <= 0) continue;
            const k = line.slice(0, p).trim().toLowerCase();
            const v = line.slice(p + 1).trim();
            headers[k] = headers[k] ? headers[k] + ', ' + v : v;
          }
          contentLength = headers['content-length'] === undefined ? -1 : parseInt(headers['content-length'], 10);
          chunked = /chunked/i.test(headers['transfer-encoding'] || '');
          buf = buf.slice(headerEnd);
        }
        if (headerEnd >= 0) {
          bodyBytes.push(buf);
          bodyLen += buf.length;
          buf = Buffer.alloc(0);
          if (!chunked && contentLength >= 0 && bodyLen >= contentLength) {
            finishBody();
          } else if (!chunked && contentLength < 0) {
            // 没有长度也没有分块：只能等连接关闭
          }
        }
      });
      socket.on('end', function () { if (headerEnd >= 0) finishBody(); else fail(new RawHttpError('连接被提前关闭', 0, '')); });
      socket.on('close', function () { if (headerEnd >= 0 && !settled) finishBody(); });

      function finishBody() {
        if (settled) return;
        let raw = Buffer.concat(bodyBytes);
        if (chunked) raw = decodeChunked(raw);
        if (contentLength >= 0) raw = raw.slice(0, contentLength);
        done({ status: status, headers: headers, body: raw, headerText: headerText });
      }

      socket.write(serializeRequest(u, method, o.headers || {}, bodyBuffer, proxy));
      if (method === 'HEAD') { /* 无 body */ }
    }).catch(function (err) {
      fail(err instanceof RawHttpError ? err : new RawHttpError('连接失败：' + exMessage(err), 0, ''));
    });
  });
}

/**
 * 给任意传输实现套上「自动跟随 3xx 重定向」。
 *
 * ★ 为什么必须跟随：哔咔的图片 CDN（storage-b.picacomic.com）对 static/ 下的
 *   签名路径会先回 **301 Moved Permanently**，真正的图片在 Location 指向的地址。
 *   传输层若不跟随，拿到的是 **194 字节的 nginx HTML 错误页**（状态码 301 < 400
 *   所以不会被当成失败），于是「下载封面/漫画图片全部存成 HTML」。
 *   参考实现 pica_client.rs 用的是 reqwest 默认客户端（默认跟随最多 10 跳），所以它没这个问题。
 *   本机实测：修复前 download 返回 194 字节 text/html；修复后是 226282 字节 image/jpeg。
 *
 * 内置传输与单测注入的假传输都要套这一层，否则「注入 transport 时重定向不跟随」，
 * 测试覆盖不到真实链路、生产又只在没注入时才正确。
 *
 * @param {Function} send 单跳发送函数 (options) => Promise<{status, headers, body|text}>
 */
function withRedirects(send) {
  return async function (options) {
    const o = Object.assign({}, options || {});
    const maxHops = o.maxRedirects === undefined ? 5 : Math.max(0, Math.floor(Number(o.maxRedirects) || 0));
    for (let hop = 0; ; hop++) {
      const res = await send(o);
      const status = res && res.status;
      const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
      const loc = res && res.headers ? res.headers.location : '';
      if (!isRedirect || !loc || hop >= maxHops) return res;
      // 301/302/303 的语义是把请求方法降级成 GET（307/308 保持原方法）
      if (status !== 307 && status !== 308) {
        o.method = 'GET';
        o.body = null;
      }
      // Location 可能是相对地址，按当前目标补全
      o.path = new URL(String(loc), buildTargetUrl(o.baseUrl, o.path)).toString();
    }
  };
}

/** 带重定向跟随的内置 HTTP 请求（唯一对外入口）。 */
export const rawHttpRequest = withRedirects(rawHttpRequestOnce);

/** 解析 chunked 编码。 */
export function decodeChunked(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let lineEnd = buf.indexOf('\r\n', i);
    if (lineEnd < 0) break;
    const sizeLine = buf.slice(i, lineEnd).toString('latin1').split(';')[0].trim();
    const size = parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size < 0) break;
    i = lineEnd + 2;
    if (size === 0) break;
    out.push(buf.slice(i, i + size));
    i += size + 2;
  }
  return Buffer.concat(out);
}

/* ------------------------------------------------------------------ *
 * API 客户端
 * ------------------------------------------------------------------ */

/**
 * 创建哔咔 API 客户端。
 * @param {object} options { baseUrl, apiKey, nonce, digestKey, token, appVersion, appPlatform,
 *   appBuildVersion, appUuid, proxy, timeoutMs, retries, fetchImpl, transport, log }
 */
export function createPicaClient(options) {
  const o = options || {};
  const cfg = function () { return typeof o.config === 'function' ? o.config() : (o.config || o); };
  const log = o.log || null;
  const fetchImpl = o.fetchImpl || function () { return globalThis.fetch.apply(globalThis, arguments); };
  // 注入的 transport 也要套重定向跟随：否则单测覆盖不到 3xx 分支，生产与测试行为分叉。
  const transport = o.transport ? withRedirects(o.transport) : rawHttpRequest;

  function pick(key, dflt) {
    const c = cfg();
    /* 取值优先级（改之前先读懂，这里踩过坑）：
         1) 显式传在 options 上的同名字段（单测/自定义链路用它覆盖）
         2) options.config 里的字段（函数或普通对象都算）
         3) 默认值
       旧写法在 config 是「普通对象」时，会用 o[key]（通常是 undefined）把
       从 config 读到的值覆盖掉 —— 表现为「配置里明明有 proxy，请求却直连」
       （代理不生效 → 被墙 → fetch failed）。只有 config 传函数时才侥幸正确。 */
    const hasOpt = Object.prototype.hasOwnProperty.call(o, key) && o[key] !== undefined;
    let v = hasOpt ? o[key] : c[key];
    return v === undefined || v === null || v === '' ? dflt : v;
  }

  /** 单次请求（不含重试）。 */
  async function once(method, path, body, auth, signal) {
    const time = String(nowSeconds());
    const cleanPath = signPath(path);
    const apiKey = pick('apiKey', PICA_API_KEY);
    const nonce = pick('nonce', PICA_NONCE);
    const signature = createSignature(cleanPath, method, time, {
      apiKey: apiKey, nonce: nonce, digestKey: pick('digestKey', PICA_DIGEST_KEY)
    });
    // auth === false 表示不需要登录态：登录/注册/找回密码等接口必须不带（过期的）authorization 头，
    // 否则上游会直接 401，用户再也没法用新密码登回来。
    const token = auth === false ? '' : (auth === true ? (cfg().token || '') : (cfg().includeAuth === false ? '' : (cfg().token || '')));
    const headers = {
      'api-key': apiKey,
      accept: PICA_ACCEPT,
      'app-channel': '2',
      time: time,
      nonce: nonce,
      'app-version': pick('appVersion', '2.2.1.2.3.3'),
      'app-uuid': pick('appUuid', 'defaultUuid'),
      'app-platform': pick('appPlatform', 'android'),
      'app-build-version': String(pick('appBuildVersion', '44')),
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': pick('userAgent', PICA_USER_AGENT),
      signature: signature,
      'image-quality': 'original',
      authorization: token
    };
    const bodyText = body === undefined || body === null ? null : JSON.stringify(body);
    const timeoutMs = Number(pick('timeoutMs', 30000));
    const proxy = pick('proxy', null);
    const baseUrl = pick('apiBase', 'https://picaapi.picacomic.com');
    const fetchMethod = String(method).toUpperCase();

    // 显式注入 transport 时（单测/自定义链路）统一走它
    if (o.transport) {
      const res = await transport({ baseUrl: baseUrl, path: path, method: fetchMethod, headers: headers, body: bodyText, timeoutMs: timeoutMs, proxy: proxy, signal: signal, fetchImpl: fetchImpl });
      const text = typeof res.text === 'string' ? res.text : (res.body ? res.body.toString('utf8') : '');
      if (res.status >= 400) throw new PicaError(translateError(res.status, text, cleanPath), res.status, cleanPath);
      return { status: res.status, text: text };
    }

    // 默认用全局 fetch；有代理时改用内置隧道传输（Node 原生 fetch 不支持代理）
    if (proxy) {
      const res = await transport({ baseUrl: baseUrl, path: path, method: fetchMethod, headers: headers, body: bodyText, timeoutMs: timeoutMs, proxy: proxy, signal: signal, fetchImpl: fetchImpl });
      // transport 允许返回 { status, body:Buffer }（rawHttpRequest）或 { status, text:string }（单测替身）
      const text = typeof res.text === 'string' ? res.text : (res.body ? res.body.toString('utf8') : '');
      if (res.status >= 400) throw new PicaError(translateError(res.status, text, cleanPath), res.status, cleanPath);
      return { status: res.status, text: text };
    }

    const ac = new AbortController();
    let timedOut = false;
    const onOuterAbort = function () { ac.abort(); };
    if (signal) {
      if (signal.aborted) throw new PicaError('请求已取消', 0, cleanPath);
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = setTimeout(function () { timedOut = true; ac.abort(); }, timeoutMs);
    if (timer.unref) timer.unref();
    let res;
    try {
      res = await fetchImpl(buildTargetUrl(baseUrl, path).toString(), {
        method: fetchMethod, headers: headers, body: bodyText === null ? undefined : bodyText, signal: ac.signal
      });
    } catch (err) {
      if (timedOut) throw new PicaError('哔咔接口请求超时（' + timeoutMs + 'ms），可在设置里调大超时时间', 0, cleanPath);
      if (signal && signal.aborted) throw new PicaError('请求已取消', 0, cleanPath);
      throw new PicaError('无法连接哔咔接口：' + exMessage(err) + '（可能需要配置代理）', 0, cleanPath);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
    const text = await res.text().catch(function () { return ''; });
    if (res.status >= 400) throw new PicaError(translateError(res.status, text, cleanPath), res.status, cleanPath);
    return { status: res.status, text: text };
  }

  /** 带退避重试的请求；429/5xx/网络错误重试，4xx 直接失败。 */
  async function request(method, path, body, auth, signal) {
    const withAuth = auth === false || (auth && auth.auth === false) ? false : true;
    const retries = Math.max(0, Number(pick('retries', 3)));
    const cleanPath = signPath(path);
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal && signal.aborted) throw new PicaError('请求已取消', 0, cleanPath);
      try {
        const r = await once(method, path, body, withAuth, signal);
        let json = null;
        try { json = JSON.parse(r.text); } catch (e) { throw new PicaError('哔咔返回的不是合法 JSON：' + String(r.text).slice(0, 160), r.status, cleanPath); }
        if (json && json.code !== undefined && Number(json.code) !== 200) {
          const msg = json.message || json.error || ('code=' + json.code);
          throw new PicaError('哔咔接口报错：' + msg, Number(json.code) || 0, cleanPath);
        }
        return json;
      } catch (err) {
        last = err;
        const status = err instanceof PicaError ? err.status : 0;
        const retriable = status === 0 || status === 429 || status >= 500;
        if (!retriable || attempt === retries) break;
        const wait = Math.min(30000, Math.round(800 * Math.pow(2, attempt) + Math.random() * 250));
        if (log && log.warn) log.warn('哔咔请求失败将重试(' + (attempt + 1) + '/' + retries + ') ' + cleanPath + ' : ' + err.message + ' ，' + wait + 'ms 后重试');
        await sleep(wait);
      }
    }
    if (last instanceof PicaError) throw last;
    throw new PicaError('哔咔请求失败：' + exMessage(last), 0, cleanPath);
  }

  /** 取 data 字段。 */
  async function data(method, path, body, signal, withAuth) {
    const json = await request(method, path, body, withAuth === false ? false : true, signal);
    if (!json || json.data === undefined || json.data === null) {
      throw new PicaError('哔咔接口没有返回 data 字段', 0, signPath(path));
    }
    return json.data;
  }

  // 客户端只保留「通用 HTTP 链路」这一份实现：
  //   raw     —— 唯一请求入口（签名 / 重试退避 / 代理隧道都在里面）
  //   download —— 二进制下载（图片/封面），自带超时与代理
  // 具体接口语义（search / comic / chapters / favorites / profile / register / …）已整体
  // 搬到 sources/picacomic.mjs 的适配器，这里不再保留第二份，避免两处实现漂移。
  return {
    raw: request,

    /** 下载二进制（图片）：自带超时，返回 { buffer, contentType }。 */
    async download(url, signal) {
      const timeoutMs = Number(pick('imgTimeoutMs', 60000));
      const proxy = pick('proxy', null);
      const headers = { 'User-Agent': pick('userAgent', PICA_USER_AGENT), accept: 'image/*,*/*;q=0.8' };
      // 单测会注入自定义 transport（假上游），这里必须同样尊重它，否则测试里图片链路会去真联网。
      if (proxy || o.transport) {
        const res = await transport({ baseUrl: '', path: url, method: 'GET', headers: headers, timeoutMs: timeoutMs, proxy: proxy, signal: signal });
        if (res.status >= 400) throw new PicaError('下载图片失败 HTTP ' + res.status, res.status, url);
        return { buffer: res.body, contentType: res.headers['content-type'] || '' };
      }
      const ac = new AbortController();
      let timedOut = false;
      const onOuterAbort = function () { ac.abort(); };
      if (signal) {
        if (signal.aborted) throw new PicaError('下载已取消', 0, url);
        signal.addEventListener('abort', onOuterAbort, { once: true });
      }
      const timer = setTimeout(function () { timedOut = true; ac.abort(); }, timeoutMs);
      if (timer.unref) timer.unref();
      try {
        const res = await fetchImpl(url, { method: 'GET', headers: headers, signal: ac.signal });
        if (!res.ok) throw new PicaError('下载图片失败 HTTP ' + res.status, res.status, url);
        const buf = Buffer.from(await res.arrayBuffer());
        return { buffer: buf, contentType: (res.headers && res.headers.get ? res.headers.get('content-type') : '') || '' };
      } catch (err) {
        if (timedOut) throw new PicaError('下载图片超时（' + timeoutMs + 'ms）', 0, url);
        if (signal && signal.aborted) throw new PicaError('下载已取消', 0, url);
        if (err instanceof PicaError) throw err;
        throw new PicaError('下载图片失败：' + exMessage(err), 0, url);
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
      }
    }
  };
}

/** media/thumb → 图片直链。 */
export function imageUrlOf(media) {
  if (!media) return '';
  const server = String(media.fileServer || media.file_server || '').replace(/[\\/]+$/, '');
  let p = String(media.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!server || !p) return '';
  return server + '/static/' + p;
}

/** 封面直链：thumb.path 的前两段是 service/signature，最后一段是文件名。 */
export function coverUrlOf(thumb) {
  if (!thumb) return '';
  const server = String(thumb.fileServer || thumb.file_server || '').replace(/[\\/]+$/, '');
  let p = String(thumb.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = p.split('/');
  if (!server || parts.length < 3) {
    return imageUrlOf(thumb);
  }
  const service = parts[0];
  const signature = parts[1];
  const filename = parts[parts.length - 1];
  return server + '/static/' + service + '/' + signature + '/' + filename;
}
