// ============================================================
//  漫库 MangaVault · 桌面 exe 自动自检（scripts/dev/desktop-selftest.mjs）
//
//  用法：
//    node scripts/dev/desktop-selftest.mjs
//    node scripts/dev/desktop-selftest.mjs --timeout=90000
//    node scripts/dev/desktop-selftest.mjs --exe=D:\somewhere\MangaVault.exe
//    node scripts/dev/desktop-selftest.mjs --keep         保留 trace 便于排查
//
//  它做什么：
//    1. 删掉旧的 dist/data/host-trace.txt，避免读到上一次的陈旧证据
//    2. **fire-and-forget 点火** exe（spawn 后立刻 unref，绝不 await / 绝不 spawnSync）
//    3. 轮询 trace 文件，直到出现 "DONE OK" 或超时（默认 60s）
//    4. 断言 12 条关键证据（含「SERVER-PID 对应的进程真的没了」的独立复核）
//    5. 打印逐条结果与总结，退出码 0 / 1
//
//  ★ 为什么必须 fire-and-forget：
//    exe 是 GUI 程序，会逃逸 DSH 后台作业的进程范围；如果在同一个 run_code 里
//    等待它结束，worker 会被连带杀掉，表现为「连接中断、终端停止」。
//    因此点火后必须立刻放手，只读它自己写下的证据文件。
//
//  ★ 为什么断言要读 trace 而不是读 stdout：
//    /target:winexe 是 Windows 子系统程序，没有控制台，stdout 拿不到任何东西。
//    trace 文件是唯一的证据来源，这也是宿主「启动即写 trace」的原因。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const D = '\u001b[90m', G = '\u001b[32m', R = '\u001b[31m', Y = '\u001b[33m', B = '\u001b[36m', N = '\u001b[0m';

/* ---------- 参数 ---------- */
function parseArgs(argv) {
  const a = Array.isArray(argv) ? argv : [];
  function val(name, dflt) {
    const hit = a.find(function (x) { return x.indexOf('--' + name + '=') === 0; });
    return hit ? hit.slice(name.length + 3) : dflt;
  }
  const t = parseInt(val('timeout', '60000'), 10);
  const dir = val('dir', path.join(ROOT, 'dist'));
  return {
    exe: path.resolve(val('exe', path.join(dir, 'MangaVault.exe'))),
    distDir: path.resolve(dir),
    timeoutMs: Number.isFinite(t) && t > 5000 ? t : 60000,
    keep: a.includes('--keep'),
    pollMs: 500
  };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }

/* ---------- 断言收集 ---------- */
function makeChecker() {
  const rows = [];
  return {
    rows: rows,
    /** 单条断言：返回是否通过 */
    ok: function (label, pass, detail) {
      rows.push({ label: label, pass: Boolean(pass), detail: detail || '' });
      return Boolean(pass);
    },
    /** 正则必须命中，命中时把匹配到的原文作为 detail */
    match: function (label, text, re, hint) {
      const m = re.exec(text);
      const detail = m ? ('命中：' + String(m[0]).slice(0, 90)) : (hint || ('未匹配 ' + re.source));
      return this.ok(label, Boolean(m), detail);
    },
    get passed() { return rows.filter(function (r) { return r.pass; }).length; },
    get failed() { return rows.filter(function (r) { return !r.pass; }).length; }
  };
}

/* ---------- 判断收尾标记（trace 每行都带 "NNN  " 毫秒前缀，必须容忍） ---------- */
const RE_DONE = /(^|\n)\s*\d+\s+DONE OK/;
function hasDone(text) { return RE_DONE.test(text); }

/* ---------- 判断 PID 是否还活着（零依赖） ---------- */
function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err && err.code === 'EPERM'; }   // EPERM = 存在但无权限，仍算活着
}

/* ---------- 兜底清理：超时后别把 GUI 留在屏幕上 ---------- */
function killQuietly(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { detached: true, stdio: 'ignore', windowsHide: true });
    tk.unref();
  } catch (e) { /* 兜底失败不影响判定 */ }
}

/* ---------- 主流程 ---------- */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const traceFile = path.join(opts.distDir, 'data', 'host-trace.txt');

  console.log(B + '══ 漫库桌面 exe 自检 ══' + N);
  console.log(D + '  exe   ：' + opts.exe + N);
  console.log(D + '  trace ：' + traceFile + N);
  console.log(D + '  超时  ：' + opts.timeoutMs + 'ms' + N);
  console.log('');

  if (!exists(opts.exe)) {
    console.log(R + '  ✗ 找不到 exe：' + opts.exe + N);
    console.log(D + '    先跑：node scripts/build-desktop.mjs' + N);
    return 1;
  }

  /* 1. 清掉旧 trace，避免把上一次的证据当成这一次的 */
  try {
    if (exists(traceFile)) { fs.unlinkSync(traceFile); console.log(D + '  已删除旧 trace' + N); }
  } catch (e) {
    console.log(R + '  ✗ 无法删除旧 trace：' + e.message + N);
    return 1;
  }

  /* 2. fire-and-forget 点火 —— spawn 后立刻放手，绝不 await 进程结束 */
  let child = null;
  try {
    child = spawn(opts.exe, ['--selftest'], {
      cwd: opts.distDir,
      detached: true,          // 脱离本进程的进程组，避免 GUI 连带影响 worker
      stdio: 'ignore',         // winexe 没有控制台，也不该等着收它的输出
      windowsHide: false
    });
    child.unref();             // 关键：不再持有它，事件循环不被它拖住
  } catch (err) {
    console.log(R + '  ✗ 点火失败：' + (err && err.message) + N);
    return 1;
  }
  const hostPid = child && child.pid ? child.pid : 0;
  console.log(D + '  已点火 host pid=' + hostPid + '（fire-and-forget，不等待）' + N);
  console.log('');

  /* 3. 轮询 trace，等 DONE 出现 */
  const deadline = Date.now() + opts.timeoutMs;
  let text = '';
  let sawDone = false;
  while (Date.now() < deadline) {
    text = readText(traceFile);
    if (hasDone(text)) { sawDone = true; break; }
    if (hostPid > 0 && !pidAlive(hostPid) && !hasDone(text)) {
      // 宿主已经退出却没写 DONE：多半是在 Main 里静默死掉了，不必再等
      await sleep(600);
      text = readText(traceFile);
      break;
    }
    await sleep(opts.pollMs);
  }
  text = readText(traceFile);
  if (hasDone(text)) sawDone = true;

  /* 4. 断言 */
  const c = makeChecker();
  const lines = text;

  c.ok('trace 文件已生成且非空（启动即留痕）',
    lines.length > 0,
    lines.length > 0 ? (lines.split(/\r?\n/).length + ' 行 / ' + lines.length + ' 字节') : '文件为空或不存在：' + traceFile);

  c.match('BOOT 行存在（进程真的跑起来了）', lines, /BOOT pid=\d+ selftest=True/);

  let port = 0;
  const pm = /PORT-CHOSEN (\d+)/.exec(lines);
  if (pm) port = parseInt(pm[1], 10);
  c.ok('PORT-CHOSEN 端口非 0（选定可用端口）', port > 0, port > 0 ? ('端口 ' + port) : '未解析到端口');

  let serverPid = 0;
  const sm = /SERVER-PID (\d+)/.exec(lines);
  if (sm) serverPid = parseInt(sm[1], 10);
  c.ok('SERVER-PID 非空（exe 自己拉起了 node 后端）', serverPid > 0, serverPid > 0 ? ('后端子进程 pid ' + serverPid) : '未解析到后端 pid');

  c.match('BOOT-PING True（/api/ping 通过）', lines, /BOOT-PING True/);

  c.match('SHOWN（窗口真实显示）', lines, /(^|\n)\s*\d*\s*SHOWN\b/);

  c.match('ENV-OK version=（WebView2 环境创建成功）', lines, /ENV-OK version=\d+\.\d+/);

  c.match('WV2-READY（WebView2 控件就绪）', lines, /WV2-READY/);

  c.match('NAVCOMPLETE ok=True（页面导航成功）', lines, /NAVCOMPLETE ok=True/);

  // 注意：ExecuteScriptAsync 返回的是「被 JSON 编码过的字符串」，内层引号在 trace 里是 \" 形式，
  // 所以这里不能写死 "title":"漫库 MangaVault"，必须容忍反斜杠转义。
  c.match('SCRIPT 探针证明页面真实渲染出漫库界面', lines, /SCRIPT [^\n]*title[^\n]*漫库 MangaVault/);

  /* 这一条是本自检里最硬的证据：不只看字符串，而是独立复核那个 pid 真的不存在了 */
  const aliveLine = /SERVER-ALIVE-AFTER-KILL False/.test(lines);
  const orphan = serverPid > 0 && pidAlive(serverPid);
  c.ok('关闭后无孤儿 node（SERVER-ALIVE-AFTER-KILL False 且 pid 已消失）',
    aliveLine && !orphan,
    'trace 声明=' + aliveLine + '，独立复核 pid ' + serverPid + ' 存活=' + orphan);

  /* 原生能力桥：证明 exe -> 后端队列 -> 命令下发 -> 执行 -> 回执 整条链路真的通了 */
  c.match('BRIDGE-ATTACHED true（宿主心跳被后端认到，mode=webview2）', lines, /BRIDGE-ATTACHED True mode=webview2/);
  c.match('BRIDGE-CANCEL-OK True（用户取消目录选择 -> 409 + 中文原因，而不是 500）', lines, /BRIDGE-CANCEL-OK True/);
  c.match('BRIDGE-PROBE-RESULT True（原生能力桥往返自检通过）', lines, /BRIDGE-PROBE-RESULT True/);

  c.ok('SHUTDOWN OK + DONE OK（正常收尾）',
    /SHUTDOWN OK/.test(lines) && /DONE OK/.test(lines),
    'SHUTDOWN=' + /SHUTDOWN OK/.test(lines) + ' DONE=' + /DONE OK/.test(lines));

  /* DONE 后面不能是 BRIDGEFAIL —— 桥探测失败时必须让整个自检失败 */
  c.ok('收尾状态是 OK 而不是 BRIDGEFAIL',
    /DONE OK/.test(lines) && !/DONE BRIDGEFAIL/.test(lines),
    /DONE BRIDGEFAIL/.test(lines) ? '桥探测失败：DONE BRIDGEFAIL' : 'DONE OK');

  /* 5. 输出结果 */
  console.log(B + '── 断言结果 ──' + N);
  c.rows.forEach(function (r, i) {
    const tag = r.pass ? (G + '✓' + N) : (R + '✗' + N);
    console.log('  ' + tag + ' ' + String(i + 1).padStart(2, ' ') + '. ' + r.label);
    if (r.detail) console.log('        ' + D + r.detail + N);
  });
  console.log('');

  const ok = c.failed === 0 && sawDone;
  if (!ok) {
    console.log(Y + '── trace 尾部（排障用） ──' + N);
    const tail = text.split(/\r?\n/).filter(function (l) { return l.trim() && l.indexOf('SNAP ') !== 0; }).slice(-25);
    if (!tail.length) console.log(D + '  (trace 为空)' + N);
    for (const l of tail) console.log(D + '  ' + l + N);
    console.log('');
  }

  console.log('总结: ' + (ok ? G : R) + c.passed + ' 通过 / ' + c.failed + ' 失败' + N +
    (sawDone ? '' : Y + '  ·  未见到 DONE（可能超时）' + N));

  /* 6. 收尾：超时或失败时别把 GUI 留在屏幕上 */
  if (!ok) {
    if (hostPid > 0 && pidAlive(hostPid)) { killQuietly(hostPid); console.log(D + '  已兜底结束宿主进程 ' + hostPid + N); }
    if (orphan) { killQuietly(serverPid); console.log(Y + '  发现孤儿后端 ' + serverPid + '，已结束' + N); }
  }
  if (!opts.keep && ok) {
    try { if (exists(traceFile)) fs.unlinkSync(traceFile); } catch (e) { /* 清理失败无所谓 */ }
  }
  if (opts.keep) console.log(D + '  --keep：保留 trace ' + traceFile + N);

  console.log(ok ? (G + '结果：桌面 exe 全链路自检通过' + N) : (R + '结果：桌面 exe 自检失败' + N));
  return ok ? 0 : 1;
}

process.exit(await main());
