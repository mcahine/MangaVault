// ============================================================
//  漫库 MangaVault · 桌面启动器（零依赖）
//  职责：探测已有内核 -> 没有就起内核 -> 用 Edge/Chrome 的 App 模式开独立窗口
//        -> 记忆窗口尺寸位置 -> 窗口关闭即退出（可 --keep-alive）
//  用法：node desktop/app.mjs [--keep-alive] [--no-window] [--width 1440] [--height 900]
// ============================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { loadConfig, dataDir, PROJECT_ROOT } from '../src/core/config.mjs';
import { sleep } from '../src/core/util.mjs';
import { logger } from './log.mjs';
import { readWindowSync, writeWindow, buildAppArgs, BASE_WINDOW, MIN_WINDOW, centerOf } from './lib.mjs';
import {
  readLockSync, probeInstance, waitForServer, processAlive,
  findBrowserSync, screenSize, listAppWindowProcesses, appWindowProbe, waitWindowClosed,
  debugPortFor, cdpTargets, cdpProbe, waitForCdpTarget, waitForCdpClosed, normalizeUrl
} from './sysinfo.mjs';
export { readLockSync, probeInstance, waitForServer, processAlive, findBrowserSync, screenSize, listAppWindowProcesses, waitWindowClosed, debugPortFor, cdpTargets, waitForCdpTarget, waitForCdpClosed, normalizeUrl, writeWindow, readWindowSync, buildAppArgs, BASE_WINDOW, MIN_WINDOW, centerOf };

const log = logger('desktop');
const NODE = process.execPath;
/** 退出码 66：请求「重启内核」，由 启动漫库.vbs 的外层循环负责真正重启 */
export const RESTART_EXIT = 66;

/* ---------- 路径约定（全部落在 data/ 下，避免污染用户目录） ---------- */
export function paths() {
  const data = dataDir();
  return {
    projectRoot: PROJECT_ROOT,
    dataDir: data,
    lockFile: path.join(data, 'server.lock.json'),
    windowFile: path.join(data, 'desktop-window.json'),
    profileDir: path.join(data, 'desktop-profile'),
    shellDir: path.join(PROJECT_ROOT, 'desktop', 'shell'),
    serverFile: path.join(PROJECT_ROOT, 'src', 'server.mjs'),
    logFile: path.join(data, 'mangavault.log'),
    serverFlag: path.join(data, 'desktop-server-owner.json')
  };
}

/** 解析命令行：--keep-alive / --no-window / --width N / --height N / --restarts N */
export function parseArgs(argv) {
  const a = Array.isArray(argv) ? argv : [];
  function num(name, dflt) {
    const i = a.indexOf(name);
    if (i === -1 || i + 1 >= a.length) return dflt;
    const n = parseInt(a[i + 1], 10);
    return Number.isFinite(n) ? n : dflt;
  }
  return {
    keepAlive: a.includes('--keep-alive') || a.includes('--window-only'),
    windowOnly: a.includes('--window-only'),
    noWindow: a.includes('--no-window'),
    width: num('--width', 0),
    height: num('--height', 0),
    maxRestarts: num('--restarts', 3),
    smoke: num('--smoke-seconds', 0)
  };
}

/**
 * 单实例防护：同一时刻只允许一个启动器负责「开窗 + 等窗关闭」。
 * 历史事故：用户连点两次（日志里 22:47:59 与 22:48:01 各一条链路），两个启动器都开窗、
 * 都进入等窗循环，进程树里堆着 2 个 node + 2 个 wscript + 两套 msedge，用户看到的是「点了没反应」。
 * 用「文件存在 + 持有者进程存活」判定；持有者已死（崩溃/被强杀）则自动接管。
 */
async function acquireLaunchGuard(file) {
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), argv: process.argv.slice(2) });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    let handle = null;
    try {
      handle = await fsp.open(file, 'wx');
      await handle.writeFile(payload, 'utf8');
      await handle.close();
      return { ok: true };
    } catch (e) {
      if (handle) { try { await handle.close(); } catch (e2) { /* ignore */ } }
      // 非「文件已存在」的错误（磁盘只读等）不阻塞启动，降级放行
      if (!e || e.code !== 'EEXIST') return { ok: true, degraded: String((e && e.code) || e) };
      let owner = null;
      try { owner = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e2) { owner = null; }
      if (owner && owner.pid) {
        const alive = await processAlive(owner.pid);
        if (alive) return { ok: false, owner: owner };
      }
      // 陈旧守卫：清理后立刻重试
      try { await fsp.rm(file, { force: true }); } catch (e3) { /* ignore */ }
      await sleep(200);
    }
  }
  return { ok: false, owner: null, reason: 'timeout' };
}

/** 记录「内核是我起的」标记，供重启循环与异常收尾时判断该不该收掉内核 */
async function writeOwnerFlag(file, info) {
  try { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, JSON.stringify(info, null, 2), 'utf8'); } catch (e) { /* 标记失败不影响主流程 */ }
}

/**
 * 起内核：fork src/server.mjs。
 *
 * **两个条件缺一不可，都是实测出来的**（矩阵实验，三种组合各跑一次）：
 *   detached:false + ignore  → 内核死    （随父进程树被连带终止）
 *   detached:true  + pipe    → 内核死    （父进程一退管道即断，内核下次写日志 EPIPE 自杀）
 *   detached:true  + 文件    → **内核存活，/api/ping 200**
 *
 * 曾经的写法是 detached:false + pipe，两个坑全踩：长任务扫描把 CPU 打满 → 启动器误判
 * 「窗口已关闭」→ 启动器 process.exit → 内核被连带杀死，而内核日志里干干净净、一条错都没有，
 * 用户看到的就是「点一下重新扫描，程序就崩了」。
 *
 * 内核日志本来就自己写 data/mangavault.log，这里再把控制台输出落到 data/kernel-console.log，
 * 保证管道断开不可能影响内核（用文件句柄而不是管道）。
 */
function spawnServer(serverFile, data, extraEnv) {
  let fd = null;
  try { fd = fs.openSync(path.join(data, 'kernel-console.log'), 'a'); } catch (e) { fd = null; }
  const child = spawn(NODE, [serverFile], {
    cwd: PROJECT_ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd === null ? 'ignore' : fd, fd === null ? 'ignore' : fd],
    env: Object.assign({}, process.env, { MV_DATA_DIR: data, MV_DESKTOP: '1' }, extraEnv || {})
  });
  // 子进程已持有句柄，父进程这份立刻关掉，避免句柄泄漏
  if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  // 脱离进程树，父进程退出不再连带杀死内核；正常退出仍由 shutdownServer 的 taskkill /PID 负责
  try { child.unref(); } catch (e) { /* ignore */ }
  return child;
}

/** 拉起 App 窗口（分离进程，关窗不影响启动器退出判断） */
export function openWindow(browser, url, win, shellDir, extraArgs) {
  const args = buildAppArgs({
    url: url,
    width: win.width,
    height: win.height,
    x: win.x,
    y: win.y,
    profileDir: paths().profileDir,
    extensionDir: fs.existsSync(shellDir) ? shellDir : null
  }).concat(extraArgs || []);
  const child = spawn(browser.exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { child: child, args: args, exe: browser.exe };
}

/** 读取/初始化窗口记忆（首次运行按主屏居中） */
export async function loadWindow(file, overrides) {
  const o = overrides || {};
  const screen = await screenSize();
  const win = readWindowSync(file, screen.width, screen.height);
  if (Number.isFinite(o.width) && o.width > 0) win.width = o.width;
  if (Number.isFinite(o.height) && o.height > 0) win.height = o.height;
  const hasPos = Number.isFinite(win.x) && Number.isFinite(win.y);
  if (!hasPos) {
    const c = centerOf(win.width, win.height, screen.width, screen.height);
    win.x = c.x;
    win.y = c.y;
  }
  return win;
}

async function pingPort(port, timeoutMs) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/ping', { signal: AbortSignal.timeout(timeoutMs || 1500) });
    const data = await res.json();
    return data && data.name === 'MangaVault' ? data : null;
  } catch (e) { return null; }
}

async function waitForDesiredPort(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const data = await pingPort(port, 1200);
    if (data) return true;
    await sleep(400);
  }
  return false;
}

async function waitForLock(lockFile, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const lock = readLockSync(lockFile);
    if (lock && lock.port) return lock;
    await sleep(250);
  }
  return null;
}

/**
 * 冒烟自检：跑 ms 毫秒后汇总一份「实测证据」——
 * 窗口进程、CDP 页面目标、窗口记忆文件内容、页面上报时间。
 */
export async function smokeReport(p, url, debugPort, windowInfo, ms) {
  const started = Date.now();
  let pageReport = null;
  let targets = [];
  let procs = [];
  const deadline = started + Math.max(2000, ms || 12000);
  while (Date.now() < deadline) {
    const win = readWindowSync(p.windowFile, 1920, 1080);
    if (win && win.source === 'page') pageReport = win;
    targets = await cdpTargets(debugPort, null, 2500);
    procs = await listAppWindowProcesses(p.profileDir);
    if (pageReport && targets.length) break;
    await sleep(1000);
  }
  const finalWin = readWindowSync(p.windowFile, 1920, 1080);
  return {
    /** 记录数据目录，便于确认没有污染真实 data/ */
    dataDir: p.dataDir,
    url: url,
    debugPort: debugPort,
    waitedMs: Date.now() - started,
    appProcesses: procs.length,
    appProcessArgs: procs.length ? procs[0].commandLine : null,
    cdpPageTargets: targets.map(function (t) { return { title: t.title, url: t.url }; }),
    windowFile: finalWin,
    windowInfo: windowInfo
  };
}
/**
 * 主流程。返回退出码：0 正常退出，66 请求重启内核（外层循环处理），1 失败。
 * opts.window = false 时只保证内核在跑（用于端到端冒烟测试）。
 */
export async function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  const p = paths();
  fs.mkdirSync(p.dataDir, { recursive: true });
  const cfg = await loadConfig(true);
  const desiredPort = cfg.port || 8770;

  // 单实例防护只在「真的要开窗」时才启用：--no-window / 冒烟自检属于测试与托管场景，
  // 允许多个并存（它们不抢窗口，也不会互相死等）。
  const guardFile = path.join(p.dataDir, 'desktop-launcher.lock');
  if (!opts.noWindow) {
    const guard = await acquireLaunchGuard(guardFile);
    if (!guard.ok) {
      const who = guard.owner && guard.owner.pid
        ? ('pid ' + guard.owner.pid + '，启动于 ' + (guard.owner.at || '未知'))
        : '另一个实例';
      log.warn('已有一个漫库启动器在运行（' + who + '），本次不重复开窗，直接退出');
      return 0;
    }
    if (guard.degraded) log.warn('启动器单实例锁不可用（' + guard.degraded + '），本次不做重复启动保护');
    // 正常退出与自己崩溃都尽量清掉守卫；被强杀时残留的陈旧守卫由下次启动自动接管
    process.once('exit', function () { try { fs.unlinkSync(guardFile); } catch (e) { /* ignore */ } });
  }

  function shutdownServer(reason) {
    return new Promise(function (resolve) {
      const lock = readLockSync(p.lockFile);
      if (!lock || !lock.pid) return resolve(false);
      log.info('正在停止内核 pid ' + lock.pid + '（' + reason + '）…');
      let done = false;
      // 必须带 /F：内核是 detached 的无窗口 node 进程，taskkill 不带 /F 实测回 255
      // 「This process can only be terminated forcefully (with /F option)」且进程不死。
      // 后果是「窗口关了、内核还在跑」：端口一直被占，下次启动只会复用旧内核
      // （改了配置/换了代码都不生效），反复跑自动化验收还会堆出一串孤儿内核。
      execFile('taskkill', ['/PID', String(lock.pid), '/T', '/F'], { windowsHide: true }, function () {
        if (done) return;
        done = true;
        resolve(true);
      });
      setTimeout(function () { if (!done) { done = true; resolve(false); } }, 5000);
    });
  }

  let child = null;
  let owned = false;
  const instance = await probeInstance(p.lockFile);
  if (instance) {
    log.info('检测到已在运行的内核：' + instance.url + ' （pid ' + instance.pid + '）');
  } else if (opts.windowOnly) {
    log.error('--window-only 模式下没有检测到运行中的内核，退出码 1');
    return 1;
  } else {
    // 配置端口上若已有一个「不是本漫库」的服务，server.mjs 会自行顺延端口，这里只提示不干预
    const foreign = await pingPort(desiredPort, 1000);
    if (foreign) log.warn('端口 ' + desiredPort + ' 上的服务响应异常，内核将自动顺延端口');
    const stale = readLockSync(p.lockFile);
    if (stale) log.warn('发现陈旧锁文件（pid ' + stale.pid + ' 已不存在），将重新启动内核');
    log.info('正在启动本地内核 ' + p.serverFile);
    child = spawnServer(p.serverFile, p.dataDir);
    child.on('exit', function (code) { log.warn('内核进程退出，退出码 ' + code); });
    const lock = await waitForLock(p.lockFile, 20000);
    if (!lock) { log.error('内核启动超时，请查看 ' + p.logFile); return 1; }
    const ready = await waitForServer(lock.port, { maxTries: 40, intervalMs: 300 });
    if (!ready.ok) { log.error('内核端口未就绪：' + lock.port); return 1; }
    owned = true;
    if (lock.port !== desiredPort) {
      log.warn('配置端口 ' + desiredPort + ' 被占用，内核顺延到 ' + lock.port);
      const again = await waitForDesiredPort(desiredPort, 4000);
      if (again) log.error('端口 ' + desiredPort + ' 上出现另一个漫库实例；本次仍使用 ' + lock.port);
    }
    await writeOwnerFlag(p.serverFlag, { pid: lock.pid, port: lock.port, startedAt: new Date().toISOString(), by: 'desktop/app.mjs' });
    log.info('内核已就绪：' + (lock.url || ('http://127.0.0.1:' + lock.port + '/')));
  }

  const aliveLock = readLockSync(p.lockFile);
  const port = (aliveLock && aliveLock.port) || (instance && instance.port) || desiredPort;
  const url = 'http://127.0.0.1:' + port + '/';

  /* ---------- 打开窗口 ---------- */
  const debugPort = debugPortFor(p.profileDir);
  const extraArgs = ['--remote-debugging-port=' + debugPort];
  let windowInfo = null;
  if (!opts.noWindow) {
    const win = await loadWindow(p.windowFile, { width: opts.width, height: opts.height });
    const browser = findBrowserSync();
    if (!browser) {
      log.error('没有找到 Microsoft Edge 或 Google Chrome，无法打开桌面窗口');
      if (owned) await shutdownServer('缺少浏览器');
      return 1;
    }
    const existingTargets = await cdpTargets(debugPort, null, 2500);
    const sameTarget = existingTargets.find(function (t) { return normalizeUrl(t.url) === normalizeUrl(url); });
    const before = await listAppWindowProcesses(p.profileDir);
    let opened = null;
    if (sameTarget) {
      log.info('检测到同数据目录已有 App 窗口（CDP pid ' + (sameTarget.id || '?') + '），不重复开窗');
    } else {
      opened = openWindow(browser, url, win, p.shellDir, extraArgs);
      log.info('已用 ' + browser.name + ' App 模式打开窗口：' + url);
      log.info('窗口参数：' + opened.args.join(' '));
    }
    const target = await waitForCdpTarget(debugPort, url, { timeoutMs: 20000, intervalMs: 600 });
    const after = await listAppWindowProcesses(p.profileDir);
    windowInfo = {
      url: url,
      browser: browser.name,
      exe: browser.exe,
      args: opened ? opened.args : null,
      debugPort: debugPort,
      cdpPort: existingTargets.length > 0 || Boolean(target),
      cdpTarget: target ? { id: target.id, title: target.title, url: target.url } : null,
      processesBefore: before.length,
      processesAfter: after.length,
      childPid: opened ? opened.child.pid : null
    };
    if (!target) log.warn('CDP 未确认到页面目标（可能无调试端口权限），改用进程探测');
    await writeWindow(p.windowFile, Object.assign({}, win, { updatedAt: new Date().toISOString(), lastUrl: url, browser: browser.name, debugPort: debugPort }));
  } else {
    log.info('--no-window：只保证内核在跑，不打开窗口');
  }

  /* ---------- 冒烟自检：跑固定秒数，打印实测证据后收尾 ---------- */
  if (opts.smoke > 0) {
    // 必须 try/finally：自检本身抛错（例如 CDP 读取失败）时，若不收尾就会把一个
    // detached 内核留在别的端口上，反复跑自动化验收会堆出一串孤儿内核（实测发生过）。
    try {
      const report = await smokeReport(p, url, debugPort, windowInfo, opts.smoke);
      log.info('冒烟自检结果：' + JSON.stringify(report, null, 2));
    } finally {
      if (owned) await shutdownServer('冒烟自检结束');
    }
    return 0;
  }

  /* ---------- 等窗口关闭 ---------- */
  if (!opts.noWindow) {
    const result = await waitForCdpClosed(debugPort, url, { intervalMs: 1200, exploreMs: 20000 });
    if (result === 'closed') {
      // 交叉复核：CDP 说目标没了，还要确认窗口进程真的都没了。
      // 历史日志里出现过「窗口已关闭（CDP 目标消失）」紧接着「仍有 12 个窗口进程存活」的
      // 自相矛盾记录，说明只信 CDP 会误判。
      const probe = await appWindowProbe(p.profileDir);
      if (!probe.ok || probe.list.length) {
        log.warn('CDP 报告目标消失，但窗口进程复核未通过（探测失败或仍有进程存活），继续等待');
        const closed2 = await waitWindowClosed(p.profileDir, { pollMs: 1500, detectMs: 20000 });
        log.info(closed2 ? '窗口已关闭（进程探测复核）' : '窗口仍在，继续运行');
      } else {
        log.info('窗口已关闭（CDP 目标消失 + 进程探测复核）');
      }
    } else {
      const closed = await waitWindowClosed(p.profileDir, { pollMs: 1500, detectMs: 20000 });
      if (!closed) {
        // 历史事故：CDP 目标探测不到（调试端口没起来 / 被占）时，旧实现直接按「窗口已关闭」
        // 处理，启动器随即退出并收掉内核，而窗口其实好端端开着，用户看到的是「刚开就崩」。
        // 这里补最后一道交叉复核：窗口进程还在（或探测不到但进程确实活着）就继续等。
        const last = await appWindowProbe(p.profileDir);
        if (!last.ok) {
          log.warn('未能探测到窗口进程（探测失败），为避免误杀内核，按「窗口仍开着」处理');
          const closed3 = await waitWindowClosed(p.profileDir, { pollMs: 1500, detectMs: 20000 });
          log.info(closed3 ? '窗口已关闭（进程探测复核）' : '窗口仍在，继续运行');
        } else if (last.list.length) {
          log.info('窗口已关闭（CDP 目标消失 + 进程探测复核）');
        } else {
          log.info('窗口已关闭（进程探测）');
        }
      } else {
        log.info('窗口已关闭（进程探测）');
      }
    }
  } else {
    log.info('--no-window：不做窗口生命周期等待');
  }

  /* ---------- 收尾 ---------- */
  if (opts.keepAlive) {
    const why = opts.windowOnly ? '--window-only（内核由别的实例托管）' : '--keep-alive';
    log.info(why + '：窗口已关闭，本地内核继续在 ' + url + ' 运行');
    return 0;
  }
  if (owned) {
    const probe = await appWindowProbe(p.profileDir);
    if (!probe.ok) {
      // 探测失败（长任务把 CPU 打满时 PowerShell 会超时）：**没有证据说明窗口关了**，
      // 宁可留着内核也不要误杀。这正是「点重新扫描就崩」的直接触发点。
      log.warn('窗口进程探测失败（可能正在跑长任务），无法确认窗口状态，保留内核运行');
    } else if (probe.list.length) {
      log.warn('仍有 ' + probe.list.length + ' 个窗口进程存活，内核保持运行以免读数丢失');
    } else {
      await shutdownServer('窗口关闭');
    }
  } else {
    log.info('内核由其它实例负责，保持运行');
  }
  return 0;
}

/* ---------- 崩溃自动重启（最多 maxRestarts 次） ---------- */

/**
 * 把本次启动的退出码落到 data/desktop-exit.json。
 * 历史事故：启动失败只是「闪一下」，vbs 外层只看退出码 66，别的码没有任何地方记录，
 * 用户来报「一启动就崩溃」时完全无从下手。落痕是最低成本的排障入口。
 */
async function recordExit(code, extra) {
  try {
    const p = paths();
    await fsp.mkdir(p.dataDir, { recursive: true });
    await fsp.writeFile(path.join(p.dataDir, 'desktop-exit.json'), JSON.stringify(Object.assign({
      code: code,
      at: new Date().toISOString(),
      pid: process.pid,
      argv: process.argv.slice(2)
    }, extra || {}), null, 2), 'utf8');
  } catch (e) { /* 落痕失败不影响退出 */ }
}

async function mainWithRestarts(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  let attempt = 0;
  while (true) {
    let code = 1;
    try {
      code = await main(argv);
    } catch (err) {
      log.error('桌面启动器异常：' + (err && err.stack ? err.stack : String(err)));
      code = 1;
    }
    if (code === 0 || code === RESTART_EXIT) {
      await recordExit(code, { result: code === RESTART_EXIT ? 'restart-requested' : 'ok' });
      return code;
    }
    attempt++;
    if (attempt > Math.max(0, opts.maxRestarts)) {
      log.error('连续启动失败 ' + attempt + ' 次，放弃自动重启（退出码 ' + code + '）');
      await recordExit(code, { result: 'giveup', attempts: attempt });
      return code;
    }
    log.warn('启动失败，' + 2000 + 'ms 后第 ' + attempt + '/' + opts.maxRestarts + ' 次自动重启');
    await sleep(2000);
  }
}

// 直接运行入口
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const code = await mainWithRestarts(process.argv.slice(2));
  log.info('启动器退出，退出码 ' + code);
  process.exit(code);
}
