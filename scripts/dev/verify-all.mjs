#!/usr/bin/env node
/**
 * 漫库 MangaVault · 一键验收（T6a）
 *
 *   node scripts/dev/verify-all.mjs            # 跑完全部验收并汇总
 *   node scripts/dev/verify-all.mjs --strict   # 把 SKIP 也视为失败（CI 用）
 *   node scripts/dev/verify-all.mjs --no-server   # 不自动拉起服务（只复用已在跑的）
 *   node scripts/dev/verify-all.mjs --only=tidy   # 只跑某一项（调试用）
 *
 * 顺序（由轻到重，GUI 放最后）：
 *   1  tests/run-tests.mjs                       单元 + 集成
 *   2  scripts/dev/vault-acceptance.mjs          vault 破坏性操作验收（需要 8775 有服务）
 *   3  scripts/dev/ui-scroll-check.mjs          真浏览器滚动检查（服务没起会自己拉）
 *   4  scripts/dev/desktop-selftest.mjs         exe 全链路自检（自己 detached 点火，我们只等退出码）
 *   5  scripts/dev/desktop-launch-check.mjs     桌面启动器验收（屏幕外窗口/退出留痕/单实例，隔离数据目录）
 *   5  scripts/tidy.mjs                         工程卫生（**参考分，不计入退出码**）
 *
 * 设计要点：
 *   - 任一项失败都继续跑下一项，一次拿到全景；只有单项超时才强杀该项后继续。
 *   - 子进程输出默认走 stdio=pipe；若受限沙箱下抛 EPERM，自动降级为「文件重定向」再读回来。
 *   - 临时日志一律放 os.tmpdir()，绝不用 process.env.TEMP（DSH 环境可能没有它，
 *     path.join(undefined,'x') 会拼出相对路径 undefined\x 落进项目根）。拼接前断言绝对路径。
 *   - 本脚本不 spawn GUI：desktop-selftest 自己 detached 点火，我们只等它的退出码。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = 8775;
const ARGS = process.argv.slice(2);
const STRICT = ARGS.includes('--strict');
const NO_SERVER = ARGS.includes('--no-server');
const ONLY = (ARGS.find(function (a) { return a.indexOf('--only=') === 0; }) || '').slice(7);
const TTY = Boolean(process.stdout.isTTY);
const C = TTY
  ? { g: '\u001b[32m', r: '\u001b[31m', y: '\u001b[33m', d: '\u001b[90m', b: '\u001b[36m', n: '\u001b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', n: '' };

/* 临时日志目录：必须是绝对路径，且不能依赖 process.env.TEMP */
const LOG_DIR = path.join(os.tmpdir(), 'mv-verify-all-' + process.pid);
if (!path.isAbsolute(LOG_DIR)) {
  console.error('[致命] 临时目录不是绝对路径：' + LOG_DIR);
  process.exit(2);
}
try { fs.mkdirSync(LOG_DIR, { recursive: true }); }
catch (e) { console.error('[致命] 无法创建临时目录 ' + LOG_DIR + '：' + e.message); process.exit(2); }

/* ---------------- 工具 ---------------- */

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }
function stripAnsi(s) { return String(s || '').replace(/\u001b\[[0-9;]*m/g, ''); }

/** 终端显示宽度：中文/全角算 2 列，保证表格对齐 */
function width(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd))) ? 2 : 1;
  }
  return w;
}
function pad(s, n) {
  const text = String(s);
  const w = width(text);
  return w >= n ? text : text + ' '.repeat(n - w);
}
/** 挑出真正有用的失败行：优先断言失败行（✗ / → / EXCEPTION），退化为末尾非空行 */
function failLines(text, limit) {
  const all = stripAnsi(text).split(/\r?\n/);
  const hits = all.filter(function (l) { return /✗|^\s*→|EXCEPTION|FAIL\b/.test(l); });
  const pool = hits.length ? hits : all.filter(function (l) { return l.trim(); });
  return pool.slice(-(limit || 4)).map(function (l) { return l.trim().slice(0, 160); });
}

/* ---------------- 子进程执行（pipe 优先，EPERM 降级文件重定向） ---------------- */

function spawnPiped(cmd, args, timeoutMs) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT, timeout: timeoutMs, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
  return { status: r.status, signal: r.signal, error: r.error, out: String(r.stdout || '') + String(r.stderr || '') };
}

function spawnFileRedirect(cmd, args, timeoutMs, logFile) {
  const fd = fs.openSync(logFile, 'w');
  try {
    const r = spawnSync(cmd, args, { cwd: ROOT, timeout: timeoutMs, windowsHide: true, stdio: ['ignore', fd, fd] });
    let out = '';
    try { out = fs.readFileSync(logFile, 'utf8'); } catch (e) { out = ''; }
    return { status: r.status, signal: r.signal, error: r.error, out: out };
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

/** 跑一条命令，返回 { status, timedOut, mode, out } */
function runCommand(cmd, args, timeoutMs, key) {
  const logFile = path.join(LOG_DIR, key + '.log');
  let res = null;
  let mode = 'pipe';
  try {
    res = spawnPiped(cmd, args, timeoutMs);
    if (res.error && res.error.code === 'EPERM') {
      mode = 'file';
      res = spawnFileRedirect(cmd, args, timeoutMs, logFile);
    }
  } catch (err) {
    res = { status: null, signal: null, error: err, out: String(err && err.message) };
    try { mode = 'file'; res = spawnFileRedirect(cmd, args, timeoutMs, logFile); } catch (e2) { /* 保留原错误 */ }
  }
  const timedOut = Boolean(res.error && (res.error.code === 'ETIMEDOUT' || /timed?s?out/i.test(String(res.error.message))));
  try { fs.writeFileSync(logFile, stripAnsi(res.out || ''), 'utf8'); } catch (e) { /* ignore */ }
  return { status: res.status, timedOut: timedOut, mode: mode, out: res.out || '', logFile: logFile };
}

async function ping() {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/ping', { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch (e) { return false; }
}

/* ---------------- 服务复用 / 拉起 ---------------- */

let ownedServerPid = 0;
async function ensureServer() {
  if (await ping()) return { ok: true, owned: false };
  if (NO_SERVER) return { ok: false, owned: false, why: '未运行且 --no-server' };
  let child = null;
  try {
    child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true
    });
    child.unref();
  } catch (e) { return { ok: false, owned: false, why: '拉起失败：' + e.message }; }
  ownedServerPid = child.pid || 0;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    if (await ping()) return { ok: true, owned: true };
  }
  return { ok: false, owned: true, why: '40s 内 /api/ping 未就绪' };
}

function killOwnedServer() {
  if (!ownedServerPid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(ownedServerPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-ownedServerPid, 'SIGKILL');
    }
  } catch (e) { /* ignore */ }
  ownedServerPid = 0;
}

/* ---------------- 验收项定义 ---------------- */

function existsScript(rel) { return exists(path.join(ROOT, rel)); }

const STEPS = [
  {
    key: 'tests', name: '单元+集成测试', timeoutMs: 300000, reference: false,
    cmd: [process.execPath, path.join('tests', 'run-tests.mjs')],
    skip: function () { return existsScript('tests/run-tests.mjs') ? null : 'tests/run-tests.mjs 不存在'; },
    summary: function (out) {
      const m = /总计:\s*(\S+)\s*通过\s*\/\s*(\S+)\s*失败/.exec(stripAnsi(out));
      return m ? (m[1] + ' 通过 / ' + m[2] + ' 失败') : '';
    }
  },
  {
    key: 'vault', name: 'vault 破坏性验收', timeoutMs: 240000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'vault-acceptance.mjs')],
    needsServer: true,
    skip: function () { return existsScript('scripts/dev/vault-acceptance.mjs') ? null : 'vault-acceptance.mjs 不存在'; },
    summary: function (out) {
      const m = /验收结果：通过\s*(\d+)\s*\/\s*失败\s*(\d+)/.exec(stripAnsi(out));
      return m ? (m[1] + ' 通过 / ' + m[2] + ' 失败') : '';
    }
  },
  {
    /* 不传 --port：脚本会自建隔离数据目录 + 随机端口。
       原来传 --port=8775 会连上用户正在运行的实例（那边是旧代码），
       于是「页面字节 vs 后端指纹」这条断言必然红 —— 反映的是服务器版本旧，不是功能回归。
       实测：2026-10-17 verify-all 第 3 步因此假红过一次。 */
    key: 'scroll', name: '浏览器滚动检查', timeoutMs: 300000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'ui-scroll-check.mjs')],
    skip: function () { return existsScript('scripts/dev/ui-scroll-check.mjs') ? null : 'ui-scroll-check.mjs 不存在'; },
    summary: function (out) {
      const m = /结果:\s*(\d+)\/(\d+)\s*通过/.exec(stripAnsi(out));
      return m ? (m[1] + '/' + m[2] + ' 通过') : '';
    }
  },
  {
    /* 「后端在忙 ≠ 后端已死」。对应用户事故：桌面端跑查重时窗口自己关掉。
       它自己在隔离目录里起随机端口的实例（不碰 8775），并核对宿主源码的忙分支。 */
    key: 'hostbusy', name: '桌面宿主忙闲判定', timeoutMs: 180000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'host-busy-check.mjs')],
    skip: function () { return existsScript('scripts/dev/host-busy-check.mjs') ? null : 'host-busy-check.mjs 不存在'; },
    summary: function (out) {
      const m = /结果:\s*(\d+)\/(\d+)\s*通过/.exec(stripAnsi(out));
      return m ? (m[1] + '/' + m[2] + ' 通过') : '';
    }
  },
  {
    /* dist 必须先校验：它是 src 的快照，不重建就会「源码修好了、exe 还是旧的」。
       放在 desktop 自检之前，避免拿过期 dist 去跑自检得出假通过。 */
    key: 'dist', name: 'dist 与源码一致', timeoutMs: 120000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'dist-consistency.mjs'), '--brief'],
    skip: function () { return existsScript('scripts/dev/dist-consistency.mjs') ? null : 'dist-consistency.mjs 不存在'; },
    summary: function (out) {
      const m = /校验\s*(\d+)\s*个文件/.exec(stripAnsi(out));
      return m ? ('已比对 ' + m[1] + ' 个文件') : '';
    }
  },
  {
    /* 候选复核 × 删除 一致性。对应用户可见的毛病：「确认重复并删除后，候选页那张卡片还在」。
       它在隔离副本里跑（复制真实 scan-fast.json，查重根换成隔离目录），只读真实数据。 */
    key: 'canddel', name: '候选复核删除一致性', timeoutMs: 120000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'dedupe-cand-delete-e2e.mjs')],
    skip: function () {
      if (!existsScript('scripts/dev/dedupe-cand-delete-e2e.mjs')) return 'dedupe-cand-delete-e2e.mjs 不存在';
      const la = process.env.LOCALAPPDATA || '';
      if (!la || !exists(path.join(la, 'MangaVault', 'dedupe', 'scan-fast.json'))) return '还没有快速查重结果（先跑一次快速查重）';
      return null;
    },
    summary: function (out) {
      const m = /合计:\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(stripAnsi(out));
      return m ? (m[1] + ' 通过 / ' + m[2] + ' 失败') : '';
    }
  },
  {
    /* 候选复核 -> 确认重复 -> 执行删除 的**真浏览器**全链路。
       接口级测试证明不了「用户点完之后列表真的少一张」；本脚本在隔离数据目录里
       用 CDP 真点三个按钮，抓到了「候选页确认重复后删除弹窗里没有该单元」的断链。 */
    key: 'candui', name: '候选复核删除(真浏览器)', timeoutMs: 180000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'dedupe-cand-ui-check.mjs')],
    skip: function () {
      if (!existsScript('scripts/dev/dedupe-cand-ui-check.mjs')) return 'dedupe-cand-ui-check.mjs 不存在';
      const la = process.env.LOCALAPPDATA || '';
      if (!la || !exists(path.join(la, 'MangaVault', 'dedupe', 'scan-fast.json'))) return '还没有快速查重结果（先跑一次快速查重）';
      return null;
    },
    summary: function (out) {
      const m = /合计:\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(stripAnsi(out));
      return m ? (m[1] + ' 通过 / ' + m[2] + ' 失败') : '';
    }
  },
  {
    /* 指纹索引自检。历史上真实数据的 fp-lib/index.json 被快速查重写成了十几条，
       而目录里躺着 1236 个 .bin —— 这会让完整扫描误判「指纹还在」而静默退化。
       这条把它钉住：索引条数必须与 .bin 数量一致。 */
    key: 'fpindex', name: '指纹索引自检', timeoutMs: 60000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'check-fp-lib-index.mjs')],
    skip: function () { return existsScript('scripts/dev/check-fp-lib-index.mjs') ? null : 'check-fp-lib-index.mjs 不存在'; },
    summary: function (out) {
      const m = /bin=(\d+) index条数=(\d+)/.exec(stripAnsi(out));
      return m ? ('指纹 ' + m[2] + ' / bin ' + m[1]) : '';
    }
  },
  {
    key: 'readernav', name: '阅读器翻页方向(真浏览器)', timeoutMs: 240000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'reader-nav-check.mjs')],
    skip: function () { return existsScript('scripts/dev/reader-nav-check.mjs') ? null : 'reader-nav-check.mjs 不存在'; },
    summary: function (out) {
      const m = /结果:\s*(\d+)\/(\d+)\s*通过/.exec(stripAnsi(out));
      return m ? (m[1] + '/' + m[2] + ' 通过') : '';
    }
  },
  {
    key: 'dltabs', name: '下载页三个页签(真浏览器)', timeoutMs: 240000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'download-tabs-check.mjs')],
    skip: function () { return existsScript('scripts/dev/download-tabs-check.mjs') ? null : 'download-tabs-check.mjs 不存在'; },
    summary: function (out) {
      const m = /结果:\s*(\d+)\/(\d+)\s*通过/.exec(stripAnsi(out));
      return m ? (m[1] + '/' + m[2] + ' 通过') : '';
    }
  },
  {
    key: 'vaultui', name: '管理台(真浏览器)', timeoutMs: 240000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'vault-admin-ui-check.mjs')],
    skip: function () { return existsScript('scripts/dev/vault-admin-ui-check.mjs') ? null : 'vault-admin-ui-check.mjs 不存在'; },
    summary: function (out) {
      const m = /结果:\s*(\d+)\/(\d+)\s*通过/.exec(stripAnsi(out));
      return m ? (m[1] + '/' + m[2] + ' 通过') : '';
    }
  },
  {
    /* 孤儿清理 × 库扫描 竞态探针。核心断言是「正常漫画被移入回收站 = 0 例」，
       它对应 cleanOrphans 的扫描守卫；守卫被删掉时这里会立刻变红。 */
    key: 'orphanrace', name: '孤儿清理竞态探针', timeoutMs: 300000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'vault-orphan-race-check.mjs'), '--rounds=2'],
    skip: function () { return existsScript('scripts/dev/vault-orphan-race-check.mjs') ? null : 'vault-orphan-race-check.mjs 不存在'; },
    summary: function (out) {
      const m = /正常漫画被移入回收站\s*:\s*(\d+)\s*例/.exec(stripAnsi(out));
      return m ? ('被误移入回收站 ' + m[1] + ' 例（应为 0）') : '';
    }
  },
  {
    key: 'desktop', name: '桌面 exe 自检', timeoutMs: 240000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'desktop-selftest.mjs')],
    skip: function () {
      if (!existsScript('scripts/dev/desktop-selftest.mjs')) return 'desktop-selftest.mjs 不存在';
      if (!exists(path.join(ROOT, 'dist', 'MangaVault.exe'))) return 'dist/MangaVault.exe 未构建（先跑 node scripts/build-desktop.mjs）';
      return null;
    },
    summary: function (out) {
      const m = /总结:\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(stripAnsi(out));
      return m ? (m[1] + ' 通过 / ' + m[2] + ' 失败') : '';
    }
  },
  {
    key: 'launcher', name: '桌面启动器验收', timeoutMs: 300000, reference: false,
    cmd: [process.execPath, path.join('scripts', 'dev', 'desktop-launch-check.mjs')],
    skip: function () { return existsScript('scripts/dev/desktop-launch-check.mjs') ? null : 'desktop-launch-check.mjs 不存在'; },
    summary: function (out) {
      const m = /总计：\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(stripAnsi(out));
      return m ? (m[1] + ' 通过 / ' + m[2] + ' 失败') : '';
    }
  },
  {
    key: 'tidy', name: '工程卫生(参考)', timeoutMs: 300000, reference: true,
    cmd: [process.execPath, path.join('scripts', 'tidy.mjs'), '--json'],
    skip: function () { return existsScript('scripts/tidy.mjs') ? null : 'tidy.mjs 不存在'; },
    summary: function (out) {
      try {
        const j = JSON.parse(out.slice(out.indexOf('{')));
        const hi = j.findings.filter(function (f) { return f.sev === 'high'; }).length;
        return '评分 ' + j.score + '/100，高危 ' + hi + ' 条';
      } catch (e) { return ''; }
    }
  }
];

/* ---------------- 主流程 ---------------- */

const started = Date.now();
const results = [];
const selected = ONLY ? STEPS.filter(function (s) { return s.key === ONLY; }) : STEPS;

console.log(C.b + '══ 漫库 MangaVault · verify-all 一键验收 ══' + C.n);
console.log(C.d + '  根目录：' + ROOT + C.n);
console.log(C.d + '  端口  ：' + PORT + '  ｜ 日志：' + LOG_DIR + C.n);
console.log('');

let serverState = { ok: false, owned: false, why: '未尝试' };
if (selected.some(function (s) { return s.needsServer; })) {
  serverState = await ensureServer();
  if (serverState.ok) {
    console.log(C.d + '  [服务] ' + PORT + ' 就绪' + (serverState.owned ? '（本脚本拉起，结束后会关闭）' : '（复用已在运行的实例）') + C.n);
  } else {
    console.log(C.y + '  [服务] ' + PORT + ' 不可用：' + serverState.why + C.n);
  }
}

let serverKilled = false;
for (const step of selected) {
  const t0 = Date.now();
  let row = { key: step.key, name: step.name, status: 'PASS', detail: '', ms: 0, logFile: '', mode: 'pipe', reference: Boolean(step.reference) };

  const skipWhy = step.skip ? step.skip() : null;
  if (skipWhy) {
    row.status = 'SKIP';
    row.detail = skipWhy;
  } else if (step.needsServer && !serverState.ok) {
    row.status = 'SKIP';
    row.detail = '需要 ' + PORT + ' 上的服务：' + serverState.why;
  } else {
    process.stdout.write(C.d + '  ▸ 运行 ' + step.name + ' …' + C.n + '\n');
    const r = runCommand(step.cmd[0], step.cmd.slice(1), step.timeoutMs, step.key);
    row.mode = r.mode;
    row.logFile = r.logFile;
    if (r.timedOut) {
      row.status = 'TIMEOUT';
      row.detail = '超过 ' + Math.round(step.timeoutMs / 1000) + 's 未结束';
    } else if (r.status === 0) {
      row.status = 'PASS';
      row.detail = step.summary ? step.summary(r.out) : '';
    } else {
      row.status = 'FAIL';
      const s = step.summary ? step.summary(r.out) : '';
      row.detail = '退出码 ' + String(r.status) + (s ? ' ｜ ' + s : '');
      row.tail = failLines(r.out, 4);
    }
  }
  row.ms = Date.now() - t0;
  results.push(row);

  /* vault / scroll 跑完就关掉我们拉起的服务，免得干扰 desktop exe 的后端选端口 */
  if (!serverKilled && serverState.owned && !selected.slice(selected.indexOf(step) + 1).some(function (s) { return s.needsServer; })) {
    killOwnedServer();
    serverKilled = true;
    process.stdout.write(C.d + '  [服务] 已关闭本脚本拉起的实例' + C.n + '\n');
  }
}
if (serverState.owned && !serverKilled) killOwnedServer();

/* ---------------- 汇总表 ---------------- */

const SYM_PLAIN = { PASS: '✓ PASS', FAIL: '✗ FAIL', TIMEOUT: '⏱ TIMEOUT', SKIP: '– SKIP' };
const SYM_COLOR = { PASS: C.g, FAIL: C.r, TIMEOUT: C.y, SKIP: C.d };
console.log('');
console.log(C.b + '── 验收汇总 ──' + C.n);
console.log(C.d + pad('#', 3) + pad('项目', 20) + pad('结果', 12) + pad('耗时', 9) + '摘要' + C.n);
results.forEach(function (r, i) {
  const sym = SYM_PLAIN[r.status] || r.status;
  let line = pad(String(i + 1), 3) + pad(r.name, 20) + (SYM_COLOR[r.status] || '') + pad(sym, 11) + C.n + pad((r.ms / 1000).toFixed(1) + 's', 9) + r.detail;
  if (r.reference) line += C.d + '  (参考，不计入退出码)' + C.n;
  console.log(line);
  if (r.tail && r.tail.length) {
    for (const l of r.tail) console.log(C.d + '    │ ' + l.slice(0, 150) + C.n);
  }
});

const counted = results.filter(function (r) { return !r.reference; });
const passed = counted.filter(function (r) { return r.status === 'PASS'; }).length;
const failed = counted.filter(function (r) { return r.status === 'FAIL' || r.status === 'TIMEOUT'; }).length;
const skipped = counted.filter(function (r) { return r.status === 'SKIP'; }).length;
const secs = ((Date.now() - started) / 1000).toFixed(1);
const exitCode = (failed > 0 || (STRICT && skipped > 0)) ? 1 : 0;

console.log('');
console.log('  总: ' + (failed ? C.r : C.g) + passed + ' 通过' + C.n + ' / ' +
  (failed ? C.r : C.d) + failed + ' 失败' + C.n + ' / ' + C.d + skipped + ' 跳过' + C.n +
  '  ·  用时 ' + secs + 's  ·  退出码 ' + exitCode + (STRICT ? '（--strict）' : ''));

const needLogs = results.filter(function (r) { return r.status === 'FAIL' || r.status === 'TIMEOUT'; });
if (needLogs.length) {
  console.log('');
  console.log(C.d + '  完整日志：' + C.n);
  for (const r of needLogs) console.log(C.d + '    ' + r.logFile + C.n);
} else {
  try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (e) { /* 句柄延迟，留着无妨 */ }
}
if (results.some(function (r) { return r.mode === 'file'; })) {
  console.log(C.y + '  提示：本沙箱下 pipe 被拒，已自动降级为文件重定向收集输出。' + C.n);
}
console.log('');
process.exit(exitCode);