
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mimeOf } from './util.mjs';

/**
 * 极简 HTTP 微框架（零依赖）。
 *  - app.get/post/put/del(路径, 处理器)，路径支持 :param
 *  - app.static(目录, 前缀)
 *  - 上下文 ctx 提供 json/text/error/body/query/params/sse
 *  - 内置：Range、ETag、304、目录穿越防护、统一错误兜底
 */
export function createApp(options) {
  const opts = options || {};
  const log = opts.log || console;
  const routes = [];
  const statics = [];
  const middlewares = [];
  const MAX_BODY = opts.maxBodyBytes || 8 * 1024 * 1024;

  function compile(pattern) {
    const keys = [];
    const rx = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, function (m) { return '\\' + m; })
      .replace(/:([A-Za-z0-9_]+)/g, function (_, k) { keys.push(k); return '([^/]+)'; });
    return { rx: new RegExp('^' + rx + '/?$'), keys: keys };
  }

  function add(method, pattern, handler) {
    const c = compile(pattern);
    routes.push({ method: method, rx: c.rx, keys: c.keys, handler: handler, pattern: pattern });
    return api;
  }

  function readBody(req) {
    return new Promise(function (resolve, reject) {
      const chunks = [];
      let total = 0;
      req.on('data', function (c) {
        total += c.length;
        if (total > MAX_BODY) {
          reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', function () { resolve(Buffer.concat(chunks)); });
      req.on('error', reject);
    });
  }

  function makeContext(req, res, url) {
    const ctx = {
      req: req,
      res: res,
      url: url,
      method: req.method,
      path: url.pathname,
      params: {},
      query: function (key, dflt) {
        const v = url.searchParams.get(key);
        return v === null ? dflt : v;
      },
      queryInt: function (key, dflt) {
        const v = parseInt(url.searchParams.get(key), 10);
        return Number.isFinite(v) ? v : dflt;
      },
      body: null,
      rawBody: null,
      state: {},
      header: function (k, v) { res.setHeader(k, v); },
      status: function (code) { res.statusCode = code; return ctx; },
      json: function (data, code) {
        if (res.writableEnded) return;
        const text = JSON.stringify(data === undefined ? null : data);
        res.statusCode = code || res.statusCode || 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(text);
      },
      text: function (text, code, type) {
        if (res.writableEnded) return;
        res.statusCode = code || 200;
        res.setHeader('Content-Type', type || 'text/plain; charset=utf-8');
        res.end(String(text));
      },
      error: function (code, message, extra) {
        const payload = Object.assign({ ok: false, error: message }, extra || {});
        ctx.json(payload, code);
      },
      throwError: function (code, message) {
        throw Object.assign(new Error(message), { statusCode: code });
      },
      file: function (absPath, fileOpts) { return serveFile(ctx, absPath, fileOpts); },
      sse: function () { return openSSE(ctx); }
    };
    return ctx;
  }

  async function parseBody(ctx) {
    if (ctx.method === 'GET' || ctx.method === 'HEAD') return;
    const ctype = String(ctx.req.headers['content-type'] || '');
    const buf = await readBody(ctx.req);
    ctx.rawBody = buf;
    if (!buf.length) return;
    const text = buf.toString('utf8');
    if (ctype.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try { ctx.body = JSON.parse(text); } catch (e) { ctx.body = null; }
    } else if (ctype.includes('application/x-www-form-urlencoded')) {
      const obj = {};
      new URLSearchParams(text).forEach(function (v, k) { obj[k] = v; });
      ctx.body = obj;
    } else {
      ctx.body = text;
    }
  }

  async function dispatch(req, res) {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    const ctx = makeContext(req, res, url);
    const started = Date.now();
    try {
      await parseBody(ctx);
      for (const mw of middlewares) {
        const stop = await mw(ctx);
        if (stop === false || res.writableEnded) return;
      }
      let matchedPath = false;
      // HEAD 复用 GET 路由（serveFile 内部会省掉响应体，只回头部）
      const effectiveMethod = req.method === 'HEAD' ? 'GET' : req.method;
      for (const route of routes) {
        const m = route.rx.exec(url.pathname);
        if (!m) continue;
        matchedPath = true;
        if (route.method !== effectiveMethod && route.method !== '*') continue;
        for (let i = 0; i < route.keys.length; i++) ctx.params[route.keys[i]] = decodeURIComponent(m[i + 1]);
        await route.handler(ctx);
        return;
      }
      for (const st of statics) {
        if (!url.pathname.startsWith(st.prefix)) continue;
        const rel = decodeURIComponent(url.pathname.slice(st.prefix.length));
        const abs = path.resolve(st.dir, rel.replace(/^[\\/]+/, ''));
        if (!abs.startsWith(path.resolve(st.dir))) { ctx.error(400, '非法路径'); return; }
        // 把静态注册时的选项（indexName/fallbackIndex/cacheSeconds/contentType）真正透传下去。
        // 踩坑：原先只传 fallbackIndex，`cacheSeconds` 被丢掉 → 前端 JS 永远不带缓存头，
        // 浏览器走启发式缓存，旧 app.js/library.js 会一直生效（表现：改好的代码在界面上看不到）。
        const ok = await serveFile(ctx, abs, Object.assign({}, st, { fallbackIndex: st.fallbackIndex }));
        if (ok) return;
      }
      if (matchedPath) { ctx.error(405, '方法不允许'); return; }
      ctx.error(404, '未找到: ' + url.pathname);
    } catch (err) {
      const code = err && err.statusCode ? err.statusCode : 500;
      if (code >= 500) log.error(req.method + ' ' + req.url + ' ->', err);
      else log.warn(req.method + ' ' + req.url + ' -> ' + err.message);
      if (!res.writableEnded) {
        try { ctx.error(code, err && err.message ? err.message : '服务器内部错误'); } catch (e) { res.end(); }
      }
    } finally {
      if (opts.accessLog !== false && code500slow(res, started)) {
        log.info(req.method + ' ' + url.pathname + ' ' + res.statusCode + ' ' + (Date.now() - started) + 'ms');
      }
    }
  }

  function code500slow(res, started) {
    return res.statusCode >= 400 || Date.now() - started > 1500;
  }

  const api = {
    get: function (p, h) { return add('GET', p, h); },
    post: function (p, h) { return add('POST', p, h); },
    put: function (p, h) { return add('PUT', p, h); },
    del: function (p, h) { return add('DELETE', p, h); },
    all: function (p, h) { return add('*', p, h); },
    use: function (mw) { middlewares.push(mw); return api; },
    static: function (dir, prefix, extra) {
      statics.push(Object.assign({ dir: path.resolve(dir), prefix: prefix || '/' }, extra || {}));
      return api;
    },
    routes: function () { return routes.map(function (r) { return r.method + ' ' + r.pattern; }); },
    createServer: function () { return http.createServer(function (req, res) { dispatch(req, res); }); }
  };
  return api;
}

/** 静态 / 任意文件响应，支持 Range 与 ETag/304 缓存。返回是否已响应。 */
export async function serveFile(ctx, absPath, options) {
  const o = options || {};
  let st;
  try {
    st = await fsp.stat(absPath);
  } catch (e) {
    // 回退到默认页时同样保留缓存语义（前端 HTML 必须 no-store，否则入口页也被缓存住）。
    if (o.fallbackIndex) return serveFile(ctx, path.join(absPath, o.fallbackIndex), Object.assign({}, o, { fallbackIndex: null }));
    if (!o.silent) ctx.error(404, '文件不存在');
    return false;
  }
  if (st.isDirectory()) {
    const idx = path.join(absPath, o.indexName || 'index.html');
    try {
      const st2 = await fsp.stat(idx);
      if (st2.isFile()) return serveFile(ctx, idx, Object.assign({}, o, { fallbackIndex: null }));
    } catch (e) { /* fallthrough */ }
    ctx.error(404, '目录无默认页');
    return false;
  }

  const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
  ctx.res.setHeader('ETag', etag);
  ctx.res.setHeader('Last-Modified', new Date(st.mtimeMs).toUTCString());
  ctx.res.setHeader('Accept-Ranges', 'bytes');
  const cacheSeconds = o.cacheSeconds === undefined ? 86400 : o.cacheSeconds;
  if (cacheSeconds > 0) {
    ctx.res.setHeader('Cache-Control', 'private, max-age=' + cacheSeconds);
  } else {
    // cacheSeconds <= 0 表示「不要缓存」，必须**显式**发 no-store。
    // 只写 max-age=0 或干脆不发头都不够：浏览器会退化成启发式缓存（按 Last-Modified 猜一个有效期），
    // 于是被删掉的模块和已修复的脚本仍会从缓存里加载出来。前端资源一律走这条。
    ctx.res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    ctx.res.setHeader('Pragma', 'no-cache');
    ctx.res.setHeader('Expires', '0');
  }

  if (ctx.req.headers['if-none-match'] === etag) {
    ctx.res.statusCode = 304;
    ctx.res.end();
    return true;
  }

  const type = o.contentType || mimeOf(absPath);
  ctx.res.setHeader('Content-Type', type);
  if (o.downloadName) {
    const name = encodeURIComponent(o.downloadName);
    ctx.res.setHeader('Content-Disposition', 'attachment; filename="' + o.downloadName.replace(/"/g, '') + '"; filename*=UTF-8\'\'' + name);
  }

  const range = ctx.req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || isNaN(end) || start > end || start >= st.size) {
        ctx.res.statusCode = 416;
        ctx.res.setHeader('Content-Range', 'bytes */' + st.size);
        ctx.res.end();
        return true;
      }
      end = Math.min(end, st.size - 1);
      ctx.res.statusCode = 206;
      ctx.res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + st.size);
      ctx.res.setHeader('Content-Length', String(end - start + 1));
      if (ctx.method === 'HEAD') { ctx.res.end(); return true; }
      await pipeFile(absPath, ctx.res, start, end - start + 1);
      return true;
    }
  }

  ctx.res.statusCode = 200;
  ctx.res.setHeader('Content-Length', String(st.size));
  if (ctx.method === 'HEAD') { ctx.res.end(); return true; }
  await pipeFile(absPath, ctx.res, 0, st.size);
  return true;
}

function pipeFile(file, res, start, length) {
  return new Promise(function (resolve) {
    const stream = fs.createReadStream(file, { start: start, end: start + length - 1 });
    let settled = false;
    function done() { if (!settled) { settled = true; resolve(); } }
    stream.on('error', function () { try { res.destroy(); } catch (e) {} done(); });
    res.on('close', function () { try { stream.destroy(); } catch (e) {} done(); });
    stream.on('end', done);
    stream.pipe(res);
  });
}

/** Server-Sent Events：长连接推送下载/扫描进度。 */
export function openSSE(ctx) {
  const res = ctx.res;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': connected\n\n');
  const clients = [];
  const heartbeat = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
  if (heartbeat.unref) heartbeat.unref();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { res.end(); } catch (e) {}
    clients.forEach(function (fn) { try { fn(); } catch (e) {} });
  }
  res.on('close', close);
  return {
    send: function (event, data) {
      if (closed) return false;
      try {
        res.write('event: ' + event + '\n');
        res.write('data: ' + JSON.stringify(data === undefined ? null : data) + '\n\n');
        return true;
      } catch (e) { close(); return false; }
    },
    comment: function (text) { try { res.write(': ' + text + '\n\n'); } catch (e) { close(); } },
    onClose: function (fn) { clients.push(fn); },
    close: close,
    get closed() { return closed; }
  };
}
