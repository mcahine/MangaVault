// core/health.mjs — 健康与版本自检路由（src/server.mjs 与验收脚本共用同一套装配）
//
// ★ 为什么必须抽出来：T1 加的 /api/version 是前端「版本自检」的对照源
//   （前端重下 /app.js 算 sha256，与 files['app.js'] 比对，不一致就自动 cache-bust 重载）。
//   验收脚本（reader-nav-check 等）为了隔离会自己 createApp + loadModules + static 起一份服务，
//   它们若不带这条路由，前端每次自检都吃 404 —— 表现为「阅读器检查失败：console error 404」，
//   实际跟阅读器一点关系都没有。凡是「按 server.mjs 的同一套装配」起的服务，
//   健康/版本路由就必须来自这里，而不是各自复制一份。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentSilenceUntil } from './heartbeat.mjs';

/** 递归算目录下匹配文件的 sha256 前 8 位，键是相对路径（正斜杠）。 */
export function collectHashes(dir, extRe) {
  const out = {};
  (function walk(d, rel) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { return; }
    for (const n of names) {
      const abs = path.join(d, n);
      const r2 = rel ? rel + '/' + n : n;
      let st = null;
      try { st = fs.statSync(abs); } catch (e) { continue; }
      if (st.isDirectory()) { walk(abs, r2); continue; }
      if (!extRe.test(n)) continue;
      try { out[r2] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 8); } catch (e) { /* 读不了就跳过 */ }
    }
  })(dir, '');
  return out;
}

/** 把「文件 → 哈希」表合成一个总指纹。 */
export function fpOf(map) {
  return crypto.createHash('sha256')
    .update(Object.keys(map).sort().map(function (k) { return k + ':' + map[k]; }).join('|'))
    .digest('hex').slice(0, 8);
}

/**
 * 挂上 GET /api/version。
 * @param {object} app createApp 的返回值
 * @param {object} o { build, startedAt, publicDir, srcDir }
 * @returns {{frontend:string, backend:string, files:object}} 供调用方复用，避免重复算哈希
 */
export function installVersionRoute(app, o) {
  const opts = o || {};
  const files = collectHashes(opts.publicDir, /\.(js|css|html|svg)$/i);
  const frontend = fpOf(files);
  const backend = fpOf(collectHashes(opts.srcDir, /\.mjs$/i));
  app.get('/api/version', function (ctx) {
    ctx.json({
      ok: true, name: 'MangaVault', version: '1.0.0', pid: process.pid,
      build: opts.build || '', startedAt: opts.startedAt || 0, uptimeMs: Date.now() - (opts.startedAt || Date.now()),
      /* frontend = public/ 下全部脚本样式按内容算的哈希；backend = src/ 下全部 .mjs。
         两个指纹合起来才能唯一定位「你现在跑的是哪一份代码」——build 只表示服务启动时刻。 */
      frontend: frontend, backend: backend, files: files
    });
  });
  return { frontend: frontend, backend: backend, files: files };
}

/**
 * 挂上 GET /api/ping。
 * silenceUntil > 0 表示后端正在跑写操作长任务（扫描/清理/查重），
 * 此刻 ping 慢是「忙」不是「死」——桌面宿主看护读它来区分两者，而不是只靠沉默时长猜。
 */
export function installPingRoute(app, o) {
  const opts = o || {};
  app.get('/api/ping', function (ctx) {
    ctx.json({
      ok: true, name: 'MangaVault', version: '1.0.0', pid: process.pid,
      build: opts.build || '', uptimeMs: Date.now() - (opts.startedAt || Date.now()),
      silenceUntil: currentSilenceUntil()
    });
  });
}
