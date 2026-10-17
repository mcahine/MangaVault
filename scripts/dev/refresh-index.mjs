#!/usr/bin/env node
/** 触发一次全库重扫，让新写入的元数据（如"先期漫画"53 部的规范化标题）在索引里生效。
 *  安全性：扫描是纯读操作，只写数据目录里的 library-index.json。
 *  只用自己 spawn 的子进程，绝不按进程名杀。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = Number(process.env.MV_REFRESH_PORT || 8903);
const DATA = process.env.MV_REFRESH_DATA || path.join(process.env.LOCALAPPDATA || '', 'MangaVault');

function req(method, url) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method, timeout: 30000 }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    r.on('error', reject);
    r.on('timeout', function () { r.destroy(new Error('timeout')); });
    r.end();
  });
}

const idxFile = path.join(DATA, 'library-index.json');
console.log('数据目录: ' + DATA);
let before = null;
try { before = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch (e) { console.log('  (读不到旧索引: ' + e.message + ')'); }
if (before) {
  console.log('  旧索引 scannedAt=' + before.scannedAt + ' 漫画数=' + (before.comics ? before.comics.length : '?'));
  const early = (before.comics || []).filter(function (c) { return c.root === 'early'; });
  const odd = early.filter(function (c) { return /（[0-9a-fA-F]{8}）/.test(c.title); });
  console.log('  early 条目=' + early.length + '，标题仍带技术后缀的=' + odd.length);
}

const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
  cwd: ROOT, stdio: 'ignore',
  env: Object.assign({}, process.env, { MV_DATA_DIR: DATA, MV_PORT: String(PORT) })
});

try {
  const until = Date.now() + 40000;
  let ready = false;
  while (Date.now() < until) {
    try { const p = await req('GET', 'http://127.0.0.1:' + PORT + '/api/ping'); if (p.status === 200) { ready = true; break; } } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 400); });
  }
  if (!ready) throw new Error('服务没起来（可能端口被占，试试 MV_REFRESH_PORT=8905）');
  console.log('  服务就绪，触发扫描…');
  const s = await req('POST', 'http://127.0.0.1:' + PORT + '/api/library/scan');
  console.log('  扫描已触发: status=' + s.status);

  // 轮询索引文件的 scannedAt 变化 + 内容稳定
  const deadline = Date.now() + 240000;
  let last = before ? before.scannedAt : null;
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 2500); });
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch (e) { continue; }
    if (cur.scannedAt && cur.scannedAt !== last) { last = cur.scannedAt; stable = 0; }
    else if (cur.scannedAt === last && cur.comics && cur.comics.length) { stable++; if (stable >= 3) { report(cur); break; } }
  }
} catch (e) {
  console.log('失败: ' + e.message);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch (e) {}
  await new Promise(function (r) { setTimeout(r, 600); });
}

function report(cur) {
  console.log('');
  console.log('=== 重扫后 ===');
  console.log('scannedAt=' + cur.scannedAt);
  console.log('漫画数=' + cur.comics.length + '  章节=' + cur.stats.chapters + '  图片=' + cur.stats.images + '  有元数据=' + cur.stats.withMeta);
  const early = cur.comics.filter(function (c) { return c.root === 'early'; });
  console.log('early 条目=' + early.length + '  有元数据=' + early.filter(function (c) { return c.hasMeta; }).length);
  const odd = early.filter(function (c) { return /（[0-9a-fA-F]{8}）/.test(c.title); });
  console.log('early 标题仍带技术后缀=' + odd.length);
  early.slice(0, 5).forEach(function (c) { console.log('   - ' + c.title + '  (' + c.images + ' 图, meta=' + c.hasMeta + ')'); });
}
