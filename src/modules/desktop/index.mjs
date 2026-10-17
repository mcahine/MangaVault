// ============================================================
//  漫库 MangaVault · 桌面模块（src/modules/desktop）
//  后端负责「桌面外壳需要的本机能力」：
//    · 形态信息（/api/desktop/info）
//    · 窗口记忆（/api/desktop/window）
//    · 原生能力桥（/api/desktop/{open-external,reveal,pick-dir,quit,native/*}）
//    · 开机自启、启动日志
//
//  ★ 原生能力的真实执行者在 C# 宿主（MangaVault.exe）里，后端弹不出系统对话框。
//    因此这里用「反向长轮询」把命令转交给宿主，状态机在 ./bridge.mjs，
//    安全判定（协议白名单 / 路径必须落在库根内）在 ./guard.mjs。
//
//  ★ 兼容：v2 的 desktop-shell 外壳（desktop/app.mjs + Edge --app）仍可用，
//    但 v3 的正交形态是 WebView2 宿主，无需任何浏览器扩展。
// ============================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { dataDir } from '../../core/config.mjs';
import { JsonStore } from '../../core/store.mjs';
import { sleep } from '../../core/util.mjs';
import { roots } from '../../core/roots.mjs';
import { createBridge, parseHostResult } from './bridge.mjs';
import { validateExternalUrl, validateRevealPath, validatePickedDir, isCmdSafeUrl, EXTERNAL_PROTOCOLS } from './guard.mjs';
import { sanitizeWindow, writeWindow, readWindowSync, checkConfirm, validateLocalUrl, buildAppArgs, posInRange, toInt, BASE_WINDOW, AUTOSTART_KEY, AUTOSTART_NAME } from '../../../desktop/lib.mjs';

export const meta = {
  id: 'desktop',
  name: '桌面',
  description: '桌面外壳接口：形态/窗口记忆/退出/外部打开/原生能力/开机自启/日志',
  order: 5,
  /* nav:false = 只提供能力、不进侧边栏。
     这个模块**不能卸载**：exe 宿主的原生桥（长轮询 /api/desktop/native/*）、
     窗口记忆、退出、开机自启都靠它。但它是给宿主用的，不是给人点的页面 ——
     直接访问 #/desktop 仍可用，只是不再占据导航。 */
  nav: false,
  help: [
    'GET  /api/desktop/state',
    'GET  /api/desktop/info',
    'POST /api/desktop/window',
    'POST /api/desktop/restart?confirm=1',
    'POST /api/desktop/quit?confirm=1',
    'POST /api/desktop/open-external {url}',
    'POST /api/desktop/reveal {path}',
    'POST /api/desktop/pick-dir {title}',
    'GET  /api/desktop/native/next?timeout=N   (宿主长轮询)',
    'POST /api/desktop/native/result {id,result} (宿主回执)',
    'POST /api/desktop/autostart {enabled}',
    'GET  /api/desktop/logs?lines=N'
  ]
};

const APP_VERSION = '1.0.0';
const SHELL = { form: 'desktop', shell: 'webview2', launcher: 'MangaVault.exe' };
const MAX_LOG_LINES = 500;
let store = null;
let serverRef = null;
let ctxRef = null;
let quitting = false;
/** 原生能力桥（宿主长轮询 + 命令队列）。惰性创建，便于单测重置。 */
let bridge = null;
/** 宿主是否为「本进程拉起的 exe」：v2 的 Node 启动器没有 exe，靠 --desktop-exe 传入 */
let hostExe = process.env.MV_DESKTOP_EXE || null;

/** 取桥实例（首次访问时创建） */
function getBridge() {
  if (!bridge) bridge = createBridge({});
  return bridge;
}

/**
 * 真实打开外部链接的动作，默认走 cmd start。
 * 单测通过 _setExternalOpener 注入一个假实现 —— 否则每跑一次测试
 * 都会真的弹出系统浏览器（甚至访问测试里写的那个域名），这既慢又脏。
 */
let externalOpener = null;
export function _setExternalOpener(fn) { externalOpener = typeof fn === 'function' ? fn : null; }

/** 执行一次外部打开；返回 { via } 或抛错 */
function performExternalOpen(url) {
  if (externalOpener) { externalOpener(url); return { via: 'injected' }; }
  const cmd = externalOpenCommand(url);
  const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { via: 'cmd start' };
}

/* ---------- 路径（惰性求值，尊重 MV_DATA_DIR，避免单测污染真实数据） ---------- */
function windowFile() { return path.join(dataDir(), 'desktop-window.json'); }
function logFile() { return path.join(dataDir(), 'mangavault.log'); }
function desktopLogFile() { return path.join(dataDir(), 'desktop.log'); }

/** 读桌面外壳持久状态（含启动器写入的形态信息） */
async function shellState() {
  try {
    if (!store) store = new JsonStore('desktop-shell.json', {});
    await store.load();
    return store.data || {};
  } catch (e) { return {}; }
}

/** 记录一次窗口上报的元信息（不含几何，几何写 desktop-window.json） */
async function noteWindowReport(info) {
  try {
    if (!store) store = new JsonStore('desktop-shell.json', {});
    await store.load();
    store.data.lastWindowReport = Object.assign({ at: new Date().toISOString() }, info);
    store.markDirty();
  } catch (e) { /* 元信息失败不影响几何落盘 */ }
}

/* ---------- 纯工具（导出供离线单测） ---------- */

/** 从请求体里取出窗口几何（页面侧可能用 outerWidth 或 width） */
export function windowPayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const pick = function () {
    for (let i = 0; i < arguments.length; i++) {
      const v = b[arguments[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
  return {
    width: pick('width', 'outerWidth', 'innerWidth'),
    height: pick('height', 'outerHeight', 'innerHeight'),
    x: pick('x', 'screenX'),
    y: pick('y', 'screenY'),
    innerWidth: pick('innerWidth'),
    innerHeight: pick('innerHeight'),
    source: pick('source') || 'page'
  };
}

/** tail 文本：取最后 n 行（不用把整个文件读进内存的判断留在这里，调用方负责上限） */
export function tailLines(text, n) {
  const lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const count = Math.max(1, n);
  return lines.slice(Math.max(0, lines.length - count));
}

/** 环境变量拼出的开机自启命令行：wscript.exe "<项目>\\启动漫库.vbs" */
export function autostartCommand(projectRoot) {
  const root = path.resolve(String(projectRoot || '.'));
  return 'wscript.exe "' + path.join(root, '启动漫库.vbs') + '"';
}

/** 注册表查询参数（纯数据，便于断言拼装是否正确） */
export function autostartQueryArgs() {
  return ['query', AUTOSTART_KEY, '/v', AUTOSTART_NAME];
}

/** 注册表写入参数 */
export function autostartAddArgs(command) {
  return ['add', AUTOSTART_KEY, '/v', AUTOSTART_NAME, '/t', 'REG_SZ', '/d', command, '/f'];
}

/** 注册表删除参数 */
export function autostartDeleteArgs() {
  return ['delete', AUTOSTART_KEY, '/v', AUTOSTART_NAME, '/f'];
}

/** 外部 URL 打开命令（Windows 用 cmd start，参数数组传参，不拼 shell 字符串） */
export function externalOpenCommand(url) {
  return { file: 'cmd', args: ['/c', 'start', '', url] };
};

/** 解析外部打开请求体：只允许 http/https + 本机回环 */
export function resolveExternalUrl(body) {
  const b = body && typeof body === 'object' ? body : {};
  const raw = b.url !== undefined ? b.url : (typeof body === 'string' ? body : '');
  return validateLocalUrl(raw);
}

/** 校验并合并窗口上报（返回 { ok, value } 或 { ok:false, error }） */
export function mergeWindowReport(raw, previous) {
  const res = sanitizeWindow(raw, previous);
  if (!res.ok) return res;
  const value = res.value;
  if (value.x === undefined || value.y === undefined) {
    const prev = previous || {};
    // 旧值也必须过范围校验：磁盘上可能残留着 -32000（最小化窗口上报过），
    // 回落它等于把窗口记忆重新写坏。越界就让 x/y 保持缺失，交给启动器自动居中。
    if (posInRange(toInt(prev.x))) value.x = prev.x;
    if (posInRange(toInt(prev.y))) value.y = prev.y;
  }
  value.source = raw && raw.source ? String(raw.source) : 'page';
  return { ok: true, value: value };
}

/** 解析 autostart 请求体：enabled 必须是布尔或 'true'/'false'/'1'/'0' */
export function parseAutostart(body) {
  const b = body && typeof body === 'object' ? body : {};
  const v = b.enabled;
  if (v === true || v === false) return { ok: true, value: v };
  if (v === 'true' || v === '1') return { ok: true, value: true };
  if (v === 'false' || v === '0') return { ok: true, value: false };
  return { ok: false, error: 'enabled 必须是布尔值（true/false）' };
}

/** 解析日志行数：默认 200，上限 500 */
export function parseLines(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(MAX_LOG_LINES, n);
}

/* ---------- Windows 能力封装 ---------- */

/** 执行 reg.exe，返回 { code, stdout, stderr } */
function runReg(args) {
  return new Promise(function (resolve) {
    execFile('reg', args, { windowsHide: true, timeout: 10000 }, function (err, stdout, stderr) {
      resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 查询注册表里实际的 MangaVault 开机自启值；未启用返回 { enabled:false }；run 可注入以便离线单测 */
export async function readAutostart(run) {
  const exec = run || runReg;
  const res = await exec(autostartQueryArgs());
  if (res.code !== 0) return { enabled: false, command: null, raw: res.stdout.trim() || res.stderr.trim() };
  const m = /REG_SZ\s+([^\r\n]+)/i.exec(res.stdout);
  const command = m ? m[1].trim() : null;
  return { enabled: Boolean(command), command: command, raw: res.stdout.trim() };
}

/** 设置开机自启；默认关闭语义由调用方给 enabled 决定；run 可注入以便离线单测 */
async function setAutostart(enabled, projectRoot, run) {
  const exec = run || runReg;
  if (!enabled) {
    const del = await exec(autostartDeleteArgs());
    const after = await readAutostart(exec);
    if (after.enabled) return { ok: false, error: '删除注册表项失败：' + (del.stderr.trim() || '未知原因') };
    return { ok: true, enabled: false, command: null };
  }
  const command = autostartCommand(projectRoot);
  const add = await exec(autostartAddArgs(command));
  const after = await readAutostart(exec);
  if (!after.enabled) return { ok: false, error: '写入注册表失败：' + (add.stderr.trim() || '未知原因') };
  return { ok: true, enabled: true, command: after.command || command };
}

/* ---------- 模块注册 ---------- */
export async function register(app, ctx) {
  ctxRef = ctx;
  serverRef = app.__server || null;
  try { store = new JsonStore('desktop-shell.json', {}); await store.load(); } catch (e) { store = null; }
  const log = ctx.log;

  /** GET /api/desktop/state —— 桌面形态自检 */
  app.get('/api/desktop/state', async function (c) {
    const shell = await shellState();
    const win = readWindowSync(windowFile(), 1920, 1080);
    const start = Date.now();
    c.json({
      ok: true,
      form: SHELL.form,
      shell: SHELL.shell,
      launcher: SHELL.launcher,
      version: '1.0.0',
      pid: process.pid,
      platform: process.platform,
      node: process.version,
      dataDir: dataDir(),
      projectRoot: ctx.projectRoot,
      uptimeMs: start - (ctxRef && ctxRef.startedAt ? ctxRef.startedAt : start),
      port: (c.req.socket && c.req.socket.localPort) || null,
      window: win,
      windowFile: windowFile(),
      keepAlive: Boolean(shell.keepAlive),
      servedByLauncher: Boolean(shell.launcherPid),
      quitting: quitting,
      canRestart: true,
      canQuit: true,
      tray: { available: process.platform === 'win32', enabled: false },
      lastWindowReport: shell.lastWindowReport || null,
      time: new Date().toISOString()
    });
  });

  /** POST /api/desktop/window —— 页面侧上报窗口尺寸位置 */
  app.post('/api/desktop/window', async function (c) {
    const raw = windowPayload(c.body);
    const prev = readWindowSync(windowFile(), 1920, 1080);
    const merged = mergeWindowReport(raw, prev);
    if (!merged.ok) return c.error(400, merged.error);
    const value = merged.value;
    if (raw.innerWidth !== undefined) value.innerWidth = parseInt(raw.innerWidth, 10) || null;
    if (raw.innerHeight !== undefined) value.innerHeight = parseInt(raw.innerHeight, 10) || null;
    value.firstSeenAt = prev && prev.firstSeenAt ? prev.firstSeenAt : new Date().toISOString();
    await writeWindow(windowFile(), value);
    await noteWindowReport({ width: value.width, height: value.height, x: value.x, y: value.y, source: value.source });
    c.json({ ok: true, window: value, file: windowFile() });
  });

  /** POST /api/desktop/restart?confirm=1 —— 请求重启（写重启标记，由启动器/服务脚本处理） */
  app.post('/api/desktop/restart', async function (c) {
    const ok = checkConfirm(c.query('confirm'), '1');
    if (!ok.ok) return c.error(400, ok.error);
    const marker = path.join(dataDir(), 'desktop-restart.request');
    try {
      await fsp.mkdir(dataDir(), { recursive: true });
      await fsp.writeFile(marker, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, by: 'api' }, null, 2), 'utf8');
    } catch (e) {
      return c.error(500, '写入重启标记失败：' + e.message);
    }
    log.warn('收到桌面重启请求，重启标记已写入 ' + marker);
    c.json({ ok: true, restarting: true, marker: marker, hint: '若内核由外部脚本托管，会由脚本重新拉起；否则请重启 启动漫库.vbs' });
    setTimeout(function () {
      try { process.kill(process.pid, 'SIGTERM'); } catch (e) { /* ignore */ }
    }, 400);
  });

  /** POST /api/desktop/quit?confirm=1 —— 优雅退出（触发 server 的 shutdown） */
  app.post('/api/desktop/quit', async function (c) {
    const ok = checkConfirm(c.query('confirm'), '1');
    if (!ok.ok) return c.error(400, ok.error);
    quitting = true;
    log.warn('收到桌面退出请求，正在优雅关闭…');
    c.json({ ok: true, quitting: true, pid: process.pid });
    setTimeout(function () {
      try { process.kill(process.pid, 'SIGTERM'); } catch (e) { /* ignore */ }
    }, 300);
  });

  /**
   * POST /api/desktop/open-external {url} —— 用系统默认程序打开链接
   * 白名单：http / https / mailto（v3 起统一到 docs/team/README.md 4.4 的契约）。
   * 优先交给宿主（ShellExecute，不经过 cmd.exe）；宿主不在线时降级为 cmd start，
   * 但要对 cmd 元字符做检查，避免命令注入。
   */
  app.post('/api/desktop/open-external', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const check = validateExternalUrl(body.url !== undefined ? body.url : c.body);
    if (!check.ok) return c.error(400, check.error);

    const b = getBridge();
    if (b.attached()) {
      const res = await b.submit('open-external', { url: check.value }, 15000);
      if (res.ok) {
        const parsed = parseHostResult(res.result);
        if (parsed.ok) return c.json({ ok: true, opened: check.value, via: 'host' });
        return c.error(502, parsed.error);
      }
      /* 宿主没回执也不能让用户白点：记录后继续走降级路径 */
      log.warn('宿主打开链接未回执：' + res.error);
    }

    /* 注入的实现（单测）不走 cmd，因此不受 cmd 元字符限制 */
    if (!externalOpener) {
      const safe = isCmdSafeUrl(check.value);
      if (!safe.ok) return c.error(400, safe.error);
    }
    try {
      const done = performExternalOpen(check.value);
      c.json({ ok: true, opened: check.value, via: done.via });
    } catch (e) {
      c.error(500, '调用系统默认程序失败：' + e.message);
    }
  });

  /** GET /api/desktop/info —— 桌面形态与宿主信息（前端据此判定 data-platform） */
  app.get('/api/desktop/info', function (c) {
    const b = getBridge();
    const st = b.status();
    c.json({
      ok: true,
      platform: process.platform,
      appVersion: APP_VERSION,
      /** mode=webview2 时前端可以放心用只属于 exe 的能力；web 表示只是浏览器里打开的页面 */
      mode: st.attached ? 'webview2' : 'web',
      exe: st.attached ? (st.host && st.host.exe ? st.host.exe : hostExe) : null,
      host: st.host,
      dataDir: dataDir(),
      native: {
        attached: st.attached,
        commands: ['open-external', 'reveal', 'pick-dir', 'quit'],
        protocols: EXTERNAL_PROTOCOLS
      },
      time: new Date().toISOString()
    });
  });

  /** POST /api/desktop/reveal {path} —— 资源管理器定位文件/目录（限库根内） */
  app.post('/api/desktop/reveal', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const guard = validateRevealPath(body.path, roots(ctx.config));
    if (!guard.ok) return c.error(403, guard.error);

    /* 存在性检查放在路由层（需要真实的磁盘状态；guard 只管前缀边界） */
    let stat = null;
    try { stat = await fsp.stat(guard.value.path); }
    catch (e) { return c.error(404, '路径不存在：' + guard.value.path); }

    const b = getBridge();
    if (!b.attached()) {
      return c.error(503, '桌面宿主（MangaVault.exe）没有在运行，无法调用资源管理器。请在 exe 里使用本功能。');
    }
    const res = await b.submit('reveal', { path: guard.value.path }, 15000);
    if (!res.ok) return c.error(res.timeout ? 504 : 502, res.error);
    const parsed = parseHostResult(res.result);
    if (!parsed.ok) return c.error(502, parsed.error);
    c.json({
      ok: true,
      path: guard.value.path,
      kind: stat.isDirectory() ? 'dir' : 'file',
      root: { id: guard.value.root.id, name: guard.value.root.name }
    });
  });

  /** POST /api/desktop/pick-dir {title} —— 原生选目录对话框（由宿主弹出） */
  app.post('/api/desktop/pick-dir', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const title = body.title === undefined || body.title === null ? '' : String(body.title);
    if (title.length > 200) return c.error(400, '标题过长（最多 200 字）');

    const b = getBridge();
    if (!b.attached()) {
      return c.error(503, '桌面宿主（MangaVault.exe）没有在运行，无法弹出系统目录选择框。请手动填写路径，或改用桌面版。');
    }
    /* 用户要亲自在对话框里点，给足 5 分钟；期间前端应显示「等待选择…」 */
    const res = await b.submit('pick-dir', { title: title }, 300000);
    if (!res.ok) return c.error(res.timeout ? 504 : 502, res.error);
    const parsed = parseHostResult(res.result);
    if (!parsed.ok) {
      /* 用户取消是可预期的正常结果，用 409 而不是 500，前端好区分 */
      if (/取消/.test(parsed.error)) return c.error(409, parsed.error);
      return c.error(502, parsed.error);
    }
    const picked = validatePickedDir(parsed.value.path);
    if (!picked.ok) return c.error(502, picked.error);
    c.json({ ok: true, path: picked.value });
  });

  /** GET /api/desktop/native/next —— 宿主的反向长轮询：领取一条命令 */
  app.get('/api/desktop/native/next', async function (c) {
    const b = getBridge();
    /* 宿主带上自己的信息即算一次心跳，后端据此判定「宿主在线」 */
    b.noteHost({ pid: c.queryInt('pid', null), exe: c.query('exe', hostExe) });
    const timeout = c.queryInt('timeout', 20000);
    const cmd = await b.poll(timeout);
    if (!cmd) return c.json({ ok: true, kind: null });
    c.json({
      ok: true,
      id: cmd.id,
      kind: cmd.kind,
      url: cmd.payload.url,
      path: cmd.payload.path,
      title: cmd.payload.title
    });
  });

  /** POST /api/desktop/native/result {id,result} —— 宿主回执 */
  app.post('/api/desktop/native/result', function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    if (!body.id) return c.error(400, '缺少命令 id');
    const ok = getBridge().resolve(String(body.id), body.result);
    if (!ok) return c.error(404, '没有找到这条待回执的命令（可能已超时）');
    c.json({ ok: true });
  });

  /** POST /api/desktop/autostart {enabled} —— 开机自启开关（默认关闭） */
  app.post('/api/desktop/autostart', async function (c) {
    const parsed = parseAutostart(c.body);
    if (!parsed.ok) return c.error(400, parsed.error);
    if (process.platform !== 'win32') return c.error(400, '开机自启目前只支持 Windows');
    const res = await setAutostart(parsed.value, ctx.projectRoot);
    if (!res.ok) return c.error(500, res.error);
    const current = await readAutostart();
    c.json({ ok: true, enabled: current.enabled, command: current.command, registry: AUTOSTART_KEY + '\\' + AUTOSTART_NAME });
  });

  /** GET /api/desktop/logs?lines=N —— 读取服务日志尾部 */
  app.get('/api/desktop/logs', async function (c) {
    const n = parseLines(c.query('lines', null));
    const files = [logFile(), desktopLogFile()];
    const chunks = [];
    for (const f of files) {
      try {
        const text = await fsp.readFile(f, 'utf8');
        const tail = tailLines(text, n).join('\n');
        chunks.push({ file: f, bytes: Buffer.byteLength(text, 'utf8'), lines: tailLines(text, n).length, text: tail });
      } catch (e) {
        chunks.push({ file: f, bytes: 0, lines: 0, text: '', error: '读取失败或文件不存在' });
      }
    }
    c.json({ ok: true, lines: n, maxLines: MAX_LOG_LINES, logs: chunks });
  });

  log.info('桌面模块已挂载（形态 ' + SHELL.form + '，窗口记忆 ' + windowFile() + '）');
}

/** 进程退出清理 */
export async function dispose() {
  try { if (bridge) bridge.dispose('漫库正在退出，原生能力已断开'); } catch (e) { /* ignore */ }
  try { if (store) await store.flush(); } catch (e) { /* ignore */ }
}

/** 供单测重置模块级状态（桥、宿主 exe、注入的打开动作） */
export function _reset() {
  if (bridge) bridge.dispose('测试重置');
  bridge = null;
  hostExe = process.env.MV_DESKTOP_EXE || null;
  externalOpener = null;
}

/* 供单测直接引用的内部实现 */
export const _internals = {
  windowFile: windowFile,
  logFile: logFile,
  desktopLogFile: desktopLogFile,
  shellState: shellState,
  mergeWindowReport: mergeWindowReport,
  windowPayload: windowPayload,
  tailLines: tailLines,
  autostartCommand: autostartCommand,
  autostartQueryArgs: autostartQueryArgs,
  autostartAddArgs: autostartAddArgs,
  autostartDeleteArgs: autostartDeleteArgs,
  resolveExternalUrl: resolveExternalUrl,
  parseAutostart: parseAutostart,
  parseLines: parseLines,
  checkConfirm: checkConfirm,
  externalOpenCommand: externalOpenCommand,
  readAutostart: readAutostart,
  setAutostart: setAutostart,
  BASE_WINDOW: BASE_WINDOW,
  buildAppArgs: buildAppArgs,
  sanitizeWindow: sanitizeWindow,
  sleep: sleep,
  getBridge: getBridge,
  performExternalOpen: performExternalOpen,
  APP_VERSION: APP_VERSION
};
