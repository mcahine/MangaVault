// ============================================================
//  scripts/dev/host-busy-check.mjs —— 「后端在忙 ≠ 后端已死」端到端验收
//
//  真实事故：用户在桌面端跑查重/重扫/孤儿清理时，窗口自己关掉了。
//  根因：宿主看护每 3 秒打一次 /api/ping，连续 4 次拿不到就判死并 Environment.Exit；
//        而 Node 后端在长任务里是单线程忙，ping 必然超时。
//
//  本脚本用**真实 HTTP**验证修复链的三段：
//    ① 空闲时 /api/ping 的 silenceUntil = 0（宿主会照常判定死亡 —— 不能拿豁免掩盖真死）
//    ② 长任务请求**发出后立刻**（还没返回）静默文件就已存在且指向未来
//    ③ 任务结束后窗口被收窄（不留长尾豁免）
//    ④ 宿主源码里的「忙」分支接管了死亡判定（静默存在 ⇒ 不累加 pingFails）
//    ⑤ 后端真死时绝不能有静默窗口（否则宿主永远不收摊，留一个空白外壳）
//
//  零第三方依赖；隔离数据目录 + 随机端口；绝不 spawn GUI，也绝不使用 8775。
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const PROJECT = path.resolve(import.meta.dirname, '..', '..');
const results = [];
function check(name, pass, detail) { results.push({ name: name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) }); }

function get(port, p) {
  return new Promise(function (resolve, reject) {
    const req = http.get({ host: '127.0.0.1', port: port, path: p, agent: false }, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: body }); });
    });
    req.on('error', reject);
    req.setTimeout(3000, function () { req.destroy(new Error('请求超时')); });
  });
}

function freePort() {
  return new Promise(function (resolve, reject) {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', function () {
      const p = srv.address().port;
      srv.close(function () { resolve(p); });
    });
    srv.on('error', reject);
  });
}

async function waitForServer(port, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await get(port, '/api/ping'); if (r.status === 200) return; } catch (e) { /* 继续等 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('服务未在 ' + timeoutMs + 'ms 内就绪');
    await new Promise(function (r) { setTimeout(r, 250); });
  }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-hostbusy-'));
const silenceFile = path.join(dataDir, 'backend-silence.json');
const port = await freePort();
console.log('[环境] 独立数据目录 ' + dataDir);
console.log('[环境] 服务端口 ' + port + '（不使用 8775）');

fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  port: port, host: '127.0.0.1', logLevel: 'error',
  libraryRoot: '', libraryRoots: [], downloadRoot: '', dedupe: {}
}, null, 2), 'utf8');

const serverProc = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.mjs'), '--data-dir=' + dataDir], {
  cwd: PROJECT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: Object.assign({}, process.env, { MV_DATA_DIR: dataDir })
});
let serverOut = '';
serverProc.stdout.on('data', function (c) { serverOut += c; });
serverProc.stderr.on('data', function (c) { serverOut += c; });

try {
  await waitForServer(port, 40000);
  console.log('[准备] 服务已就绪（隔离数据目录，端口 ' + port + '）');

  /* ---------- ① 空闲：不能有任何静默豁免 ---------- */
  fs.rmSync(silenceFile, { force: true });
  const ping0 = JSON.parse((await get(port, '/api/ping')).body);
  check('空闲时 /api/ping 报告 silenceUntil=0', ping0.silenceUntil === 0, 'silenceUntil=' + ping0.silenceUntil);
  check('空闲时磁盘上没有静默文件', !fs.existsSync(silenceFile), fs.existsSync(silenceFile) ? '文件存在' : '文件不存在');

  /* ---------- ② 长任务发出即声明（用孤儿清理预演，它走 withHeartbeat） ---------- */
  const started = Date.now();
  const postP = new Promise(function (resolve, reject) {
    const payload = JSON.stringify({ confirm: false });
    const req = http.request({ host: '127.0.0.1', port: port, path: '/api/vault/orphans/clean', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, agent: false },
      function (res) {
        let body = '';
        res.on('data', function (c) { body += c; });
        res.on('end', function () { resolve({ status: res.statusCode, body: body, ms: Date.now() - started }); });
      });
    req.on('error', reject);
    req.end(payload);
  });

  /* 请求刚发出后轮询磁盘：静默文件必须在**响应返回之前**就出现（否则长任务期间仍会被判死） */
  let sawSilenceDuring = false;
  let seenUntil = 0;
  while (Date.now() - started < 3000) {
    if (fs.existsSync(silenceFile)) {
      try {
        const st = JSON.parse(fs.readFileSync(silenceFile, 'utf8'));
        if (Number(st.until) > Date.now()) { sawSilenceDuring = true; seenUntil = Number(st.until); }
      } catch (e) { /* 半写状态，继续 */ }
    }
    if (sawSilenceDuring) break;
    await new Promise(function (r) { setTimeout(r, 25); });
  }
  check('长任务期间静默窗口已落盘且指向未来', sawSilenceDuring, 'until=' + seenUntil);

  const post = await postP;
  check('孤儿清理预演返回 200', post.status === 200, 'status=' + post.status + ' ms=' + post.ms);


  /* ---------- ③ 结束后收窄 ----------
     等满 1.3 秒：releaseSilence 把窗口收窄到 1 秒，等它自然过期后
     /api/ping 必须回到 0 —— 否则宿主会永久豁免死亡判定，留一个没有后端的空白外壳。 */
  await new Promise(function (r) { setTimeout(r, 1300); });
  let afterUntil = 0;
  if (fs.existsSync(silenceFile)) {
    try { afterUntil = Number(JSON.parse(fs.readFileSync(silenceFile, 'utf8')).until); } catch (e) { afterUntil = 0; }
  }
  const remaining = afterUntil - Date.now();
  check('任务结束后窗口已被收窄（不等于原来的 10 分钟）', remaining <= 1200, '剩余 ' + remaining + 'ms');
  const ping1 = JSON.parse((await get(port, '/api/ping')).body);
  check('窗口过期后 /api/ping 的 silenceUntil 归零（不留永久豁免）', ping1.silenceUntil === 0, 'silenceUntil=' + ping1.silenceUntil);

  /* ---------- ③b 窗口有效期间，ping 仍要能应答并带上 silenceUntil（宿主据此区分忙与死） ---------- */
  fs.rmSync(silenceFile, { force: true });
  const hbMod = await import('../../src/core/heartbeat.mjs');
  process.env.MV_DATA_DIR = dataDir;
  hbMod._resetHeartbeatThrottle();
  hbMod.touchSilence(60000);
  const pingBusy = JSON.parse((await get(port, '/api/ping')).body);
  check('静默窗口有效时 /api/ping 仍 200 且回传 silenceUntil>0', pingBusy.ok === true && pingBusy.silenceUntil > Date.now(), 'silenceUntil=' + pingBusy.silenceUntil);
  hbMod.releaseSilence();
  await new Promise(function (r) { setTimeout(r, 1300); });
  const pingBack = JSON.parse((await get(port, '/api/ping')).body);
  check('手动释放后窗口立刻失效', pingBack.silenceUntil === 0, 'silenceUntil=' + pingBack.silenceUntil);

  /* ---------- ④ 宿主源码：忙分支真的接管了死亡判定 ---------- */
  const host = fs.readFileSync(path.join(PROJECT, 'desktop', 'host', 'Program.cs'), 'utf8');
  check('宿主读的文件名与后端写入的一致', host.indexOf('SILENCE_FILE = "backend-silence.json"') >= 0, '');
  check('宿主有 BackendBusy() 判定', host.indexOf('private static bool BackendBusy()') >= 0, '');
  check('「忙」分支在死亡累加之前接管', host.indexOf('bool busy = BackendBusy();') >= 0 && host.indexOf('else if (busy)') >= 0, '');
  check('进程真退出仍然无条件收摊（不掩盖真死）',
    /ServerHasExited\(\)\)\s*\{[^}]*Dump\("SERVERDEAD"\)/.test(host), '');

  /* ---------- ⑤ 真死绝不能有静默窗口 ---------- */
  fs.rmSync(silenceFile, { force: true });
  check('静默文件不存在时 BackendBusy 语义为 false（宿主会照常判死）',
    !fs.existsSync(silenceFile), '');

} finally {
  try { serverProc.kill(); } catch (e) { /* 忽略 */ }
  await new Promise(function (r) { setTimeout(r, 300); });
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

const pass = results.filter(function (r) { return r.pass; }).length;
console.log('');
for (const r of results) console.log((r.pass ? '  [通过] ' : '  [失败] ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('');
console.log('结果: ' + pass + '/' + results.length + ' 通过');
if (serverOut.trim() && pass < results.length) console.log('[服务日志尾部] ' + serverOut.trim().split('\n').slice(-8).join(' | '));
process.exit(pass === results.length ? 0 : 1);
