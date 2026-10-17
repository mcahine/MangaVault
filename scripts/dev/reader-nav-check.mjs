#!/usr/bin/env node
/**
 * 阅读器翻页方向 · 真实浏览器回归（reader-nav-check）
 *
 * 背景（真 bug，已由 Lead 修复）：
 *   public/modules/reader.js 原本有 rtlStep(visual)：rtl=true（日漫，默认）时把「舞台左侧」
 *   反转成「下一页」。工具栏的「上一页 / 下一页」按钮与 ← → 键也走了它，于是日漫模式下
 *   点「下一页」实际回到上一页 —— 用户报障「上一页和下一页是反的」。
 *   现在统一为：按钮 / 方向键 / 舞台左右边缘一律按页码，左 = 上一页，右 = 下一页；
 *   rtl 只影响双页模式的左右页顺序与方向指示文案。
 *
 * 本脚本全程零第三方依赖（只用 node: 内置模块 + 相对路径导入，无构建步骤）：
 *   1. safeTmpDir() 造隔离数据目录 + 临时漫画库（1 部 / 2 话 / 每话 6 页 / 合法 JPEG）；
 *   2. 按 src/server.mjs 的同一套装配（createApp + loadModules + static）起真实服务，
 *      端口用 listen(0) 交给系统随机分配，绝不占用 8775；
 *   3. 调 POST /api/library/scan 建索引，确认 /api/library 能搜到夹具；
 *   4. 起真实 headless Edge + 原始 CDP，打开 #/reader?comic=<id>；
 *   5. 在**日漫模式（rtl 默认 true）**下断言按钮与方向键的翻页方向 —— bug 只在此前提下暴露。
 *
 * 断言清单（每条打印 PASS/FAIL 与实测值）：
 *   1  夹具加载成功：第 1 话 6 页、翻页控件齐全、首页图真实解码
 *   2  日漫模式前置条件成立（prefs.rtl=true 且方向按钮显示日漫）
 *   3  初始页码 = 1
 *   4  点「下一页」→ 页码 2（本次 bug 的核心断言）
 *   5  再点「上一页」→ 回到 1
 *   6  第 1 页点「上一页」不跳到第 2 页
 *   7  按 ArrowRight → 页码 2（键盘与按钮同向）
 *   8  按 ArrowLeft → 回到 1
 *   9  全程无未捕获异常、无 console error
 *
 * 用法：
 *   node scripts/dev/reader-nav-check.mjs
 *   node scripts/dev/reader-nav-check.mjs --keep             保留临时目录，便于事后排查
 *   node scripts/dev/reader-nav-check.mjs --browser=<exe路径> 指定浏览器
 *
 * 退出码：全 PASS 0；任一 FAIL 1；找不到浏览器 2。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { safeTmpDir } from '../../src/core/util.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURE_ID = 'reader-nav-fixture';
const FIXTURE_COMIC = '翻页方向夹具';
const FIXTURE_CHAPTERS = 2;
const FIXTURE_PAGES = 6;
const READY_TIMEOUT_MS = 30000;
const CLICK_WAIT_MS = 260;
const KEY_WAIT_MS = 320;

/** 1×1 合法 JPEG（基线，含完整量化表与 Huffman 表）：只有几百字节，浏览器能真实解码 */
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

/** 页面侧小工具：内部只用双引号，避免嵌套转义；控件一律按 [data-act] 选取，不用 nth-child */
const PAGE_HELPER = '(function () {'
  + ' function q(act) { var list = document.querySelectorAll("[data-act]"); for (var i = 0; i < list.length; i++) { if (list[i].getAttribute("data-act") === act) return list[i]; } return null; }'
  + ' function num(act) { var n = q(act); return n ? String(n.value) : null; }'
  + ' function text(act) { var n = q(act); return n ? String(n.textContent || "").trim() : null; }'
  + ' function box(act) { var n = q(act); if (!n) return null; var r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }'
  + ' window.__mvNav = { q: q, num: num, text: text, box: box };'
  + ' return "ok";'
  + ' })()';

/** 进程级资源：统一在 cleanup() 里收尾 */
const STATE = { tmp: null, keep: false, server: null, browserProc: null, cdp: null };
let EXIT = 0;

/* ---------- 通用小工具 ---------- */

function arg(name, dflt) {
  for (const a of process.argv.slice(2)) {
    if (a === '--' + name) return '1';
    if (a.indexOf('--' + name + '=') === 0) return a.slice(name.length + 3);
  }
  return dflt;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function findBrowser() {
  for (const p of BROWSERS) { if (fs.existsSync(p)) return p; }
  return null;
}

function getJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + '：' + body.slice(0, 120))); return; }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('非 JSON 响应：' + body.slice(0, 120))); }
      });
    }).on('error', reject);
  });
}

function postJson(url, body) {
  return new Promise(function (resolve, reject) {
    const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, function (res) {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { text += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error('非 JSON 响应：' + text.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** 轮询直到 fn() 返回真值；超时返回 false。轮询过程中的异常一律视为「还没就绪」。 */
async function waitUntil(fn, timeoutMs, intervalMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch (e) { /* 还没就绪，继续等 */ }
    await sleep(intervalMs || 250);
  }
  return false;
}

/* ---------- 极简 CDP 客户端（不引 npm 依赖） ---------- */
function cdpConnect(wsUrl) {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error('当前 Node 没有内置 WebSocket（需 Node 22+）');
  const ws = new WebSocketCtor(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', function (ev) {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) { for (const fn of listeners) fn(msg); }
  });
  const ready = new Promise(function (resolve, reject) {
    ws.addEventListener('open', function () { resolve(); });
    ws.addEventListener('error', function () { reject(new Error('WebSocket 连接失败')); });
  });
  function send(method, params) {
    const id = nextId++;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      setTimeout(function () { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时：' + method)); } }, 20000);
    });
  }
  return { ready: ready, send: send, on: function (fn) { listeners.push(fn); }, close: function () { try { ws.close(); } catch (e) { /* ignore */ } } };
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面脚本异常：' + (r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)));
  return r.result ? r.result.value : undefined;
}

async function readPage(cdp) { return evaluate(cdp, 'window.__mvNav.num("page-num")'); }
async function readChapter(cdp) { return evaluate(cdp, 'window.__mvNav.text("chapter-label")'); }

/** 用真实鼠标事件点某个 data-act 控件（不用 element.click()，尽量贴近真人操作） */
async function clickAct(cdp, act) {
  const box = await evaluate(cdp, 'window.__mvNav.box("' + act + '")');
  if (!box || !box.w || !box.h) throw new Error('控件不可点击（找不到或尺寸为 0）：[data-act="' + act + '"]');
  const ev = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ev.x, y: ev.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ev.x, y: ev.y, button: 'left', clickCount: 1 });
  await sleep(CLICK_WAIT_MS);
}

/** 派发真实键盘事件 */
async function pressKey(cdp, key, code, vk) {
  const base = { key: key, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  await sleep(KEY_WAIT_MS);
}

/* ---------- 夹具 ---------- */

/**
 * 造隔离数据目录 + 临时漫画库：1 部漫画 / 2 话 / 每话 6 页合法 JPEG。
 * 元数据.json 里写死 id，保证 comic id 稳定可预期（不依赖目录名哈希）。
 */
async function buildFixture(dataDir, libRoot) {
  const jpeg = Buffer.from(JPEG_B64, 'base64');
  const comicDir = path.join(libRoot, FIXTURE_COMIC);
  for (let i = 1; i <= FIXTURE_CHAPTERS; i++) {
    const chDir = path.join(comicDir, String(i) + ' 第' + i + '话');
    await fsp.mkdir(chDir, { recursive: true });
    for (let p = 1; p <= FIXTURE_PAGES; p++) {
      await fsp.writeFile(path.join(chDir, String(p).padStart(3, '0') + '.jpg'), jpeg);
    }
  }
  const meta = { id: FIXTURE_ID, title: FIXTURE_COMIC, author: 'W4 回归测试', tags: ['翻页方向回归'] };
  await fsp.writeFile(path.join(comicDir, '元数据.json'), JSON.stringify(meta, null, 2), 'utf8');
  await fsp.writeFile(path.join(comicDir, 'cover.jpg'), jpeg);

  const cfg = {
    '//': '本文件由 scripts/dev/reader-nav-check.mjs 生成，仅用于隔离验收；端口由 listen(0) 随机分配，与 8775 无关。',
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    libraryRoots: [{ id: 'nav', name: '翻页夹具库', path: libRoot, enabled: true }],
    libraryRoot: libRoot,
    downloadRoot: libRoot,
    dedupe: { libRoot: libRoot, scanRoot: libRoot }
  };
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  return comicDir;
}

/* ---------- 真实服务（与 src/server.mjs 同一套装配，只是端口交给系统分配） ---------- */

async function startService() {
  const httpMod = await import('../../src/core/http.mjs');
  const configMod = await import('../../src/core/config.mjs');
  const logMod = await import('../../src/core/log.mjs');
  const modulesMod = await import('../../src/modules/index.mjs');
  /* 健康/版本路由必须与 src/server.mjs 同一份实现。
     踩坑：原先这里手写 /api/ping 且完全没有 /api/version，而 T1 起前端 boot 会去
     GET /api/version 做版本自检 → 每次都是 404 → 本脚本被判「console error 有 2 条」，
     看起来像阅读器坏了，其实与阅读器无关。 */
  const healthMod = await import('../../src/core/health.mjs');

  const config = await configMod.loadConfig(true);
  const dir = configMod.dataDir();
  fs.mkdirSync(dir, { recursive: true });
  logMod.setLogFile(path.join(dir, 'mangavault.log'));
  const log = logMod.createLogger('reader-nav-check', config.logLevel);

  const app = httpMod.createApp({ log: log, accessLog: false });
  let loadedModules = [];
  const moduleList = function () {
    return loadedModules.map(function (m) {
      return { id: m.id, name: m.name, ok: m.ok, error: m.error || null, description: (m.meta && m.meta.description) || '', order: (m.meta && m.meta.order) || 99 };
    });
  };
  healthMod.installPingRoute(app, { build: 'reader-nav-check', startedAt: Date.now() });
  healthMod.installVersionRoute(app, { build: 'reader-nav-check', startedAt: Date.now(), publicDir: configMod.PUBLIC_DIR, srcDir: path.join(configMod.PROJECT_ROOT, 'src') });
  app.get('/api/modules', function (c) { c.json({ ok: true, modules: moduleList() }); });
  app.get('/api/system/info', function (c) {
    c.json({ ok: true, name: '漫库 MangaVault', node: process.version, platform: process.platform, dataDir: dir, projectRoot: configMod.PROJECT_ROOT, modules: moduleList() });
  });
  app.static(configMod.PUBLIC_DIR, '/', { indexName: 'index.html', fallbackIndex: 'index.html', cacheSeconds: 0 });

  const moduleCtx = {
    config: config, log: log, projectRoot: configMod.PROJECT_ROOT, dataDir: dir, publicDir: configMod.PUBLIC_DIR,
    reloadConfig: function () { return configMod.loadConfig(true); },
    saveConfig: function (patch) { return configMod.saveConfig(patch); }
  };
  loadedModules = await modulesMod.loadModules(app, moduleCtx);
  moduleCtx.modules = loadedModules;
  // 与 src/server.mjs 一致：单个模块挂掉只标红、不中断服务（否则别人的临时改动会拖死阅读器检查）
  const bad = loadedModules.filter(function (m) { return !m.ok; });
  if (bad.length) {
    console.log('[服务] 注意：模块加载失败（按 server.mjs 的约定只标红不中断）：' + bad.map(function (m) { return m.id + '（' + m.error + '）'; }).join('、'));
  }
  const missing = ['library', 'reader'].filter(function (id) {
    const m = loadedModules.find(function (x) { return x.id === id; });
    return !m || !m.ok;
  });
  if (missing.length) throw new Error('本检查依赖的模块未就绪：' + missing.join('、'));

  const server = app.createServer();
  const port = await new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () { resolve(server.address().port); });
  });
  return { server: server, port: port, modules: loadedModules };
}

/* ---------- 索引扫描：确认 /api/library 能搜到夹具 ---------- */

async function scanAndFind(base) {
  await postJson(base + 'api/library/scan', { root: 'nav' });
  const done = await waitUntil(function () {
    return getJson(base + 'api/library/state').then(function (st) {
      return Boolean(st && st.scannedAt && !st.scanning);
    });
  }, READY_TIMEOUT_MS, 300);
  if (!done) throw new Error('索引扫描未在 ' + READY_TIMEOUT_MS + 'ms 内完成（/api/library/state 一直停留在 scanning）');

  const list = await getJson(base + 'api/library/comics?size=50');
  const hit = await getJson(base + 'api/library/comics?size=50&q=' + encodeURIComponent(FIXTURE_COMIC));
  const item = (list.items || []).find(function (c) { return c.id === FIXTURE_ID; });
  console.log('[索引] 库内总数=' + list.total + '  按标题搜索命中=' + (hit.items || []).length + ' 部  夹具 id=' + (item ? item.id : '未找到'));
  if (!item) throw new Error('夹具漫画没有出现在索引里（id=' + FIXTURE_ID + '，搜索命中 ' + (hit.items || []).length + ' 部）');
  if (item.chapterCount !== FIXTURE_CHAPTERS || item.images !== FIXTURE_CHAPTERS * FIXTURE_PAGES) {
    throw new Error('夹具结构不对：期望 ' + FIXTURE_CHAPTERS + ' 话 / ' + (FIXTURE_CHAPTERS * FIXTURE_PAGES) + ' 页，实际 ' + item.chapterCount + ' 话 / ' + item.images + ' 页');
  }
  return item;
}

/* ---------- 浏览器 ---------- */

function browserEnv() {
  const env = Object.assign({}, process.env);
  if (!env.SystemRoot) env.SystemRoot = 'C:/Windows';
  if (!env.TEMP && STATE.tmp) env.TEMP = STATE.tmp;
  if (!env.TMP) env.TMP = env.TEMP;
  return env;
}

async function launchBrowser(exe, profileDir) {
  /* 端口交给浏览器自己挑，再从 DevToolsActivePort 读实际值。
     原来用 `9333 + random(200)` 自己猜，与其它 CDP 脚本的端口范围重叠，
     机器上有残留无头浏览器时会撞车 → 「浏览器调试端口未就绪」偶发假失败。 */
  const proc = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    'about:blank'
  ], { stdio: 'ignore', detached: false, env: browserEnv() });

  const devtoolsFile = path.join(profileDir, 'DevToolsActivePort');
  const until = Date.now() + 25000;
  let page = null;
  let debugPort = 0;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error('浏览器进程提前退出（exitCode=' + proc.exitCode + '），可能是 --user-data-dir 不可用');
    try {
      const text = await fsp.readFile(devtoolsFile, 'utf8');
      debugPort = Number(String(text).split(/\r?\n/)[0]) || 0;
    } catch (e) { debugPort = 0; }
    if (debugPort) {
      try {
        const list = await getJson('http://127.0.0.1:' + debugPort + '/json/list');
        page = (list || []).find(function (t) { return t.type === 'page' && t.webSocketDebuggerUrl; }) || null;
        if (page) break;
      } catch (e) { /* 调试端口还没起来 */ }
    }
    await sleep(300);
  }
  if (!page) {
    try { proc.kill(); } catch (e) { /* ignore */ }
    throw new Error('浏览器调试端口 ' + debugPort + ' 未在 25s 内就绪');
  }
  return { proc: proc, wsUrl: page.webSocketDebuggerUrl, debugPort: debugPort };
}

/* ---------- 收尾 ---------- */

async function removeDirWithRetry(dir) {
  let last = null;
  for (let i = 0; i < 6; i++) {
    try { await fsp.rm(dir, { recursive: true, force: true }); return; }
    catch (e) { last = e; await sleep(900); }
  }
  const why = last ? (last.code || last.message) : '未知原因';
  console.warn('[清理] 临时目录删除失败（' + why + '），可手动清理：' + dir);
}

/** 子进程是否真的退出了（Windows 下 kill() 是异步的，删 profile 前必须等它收干净） */
function hasExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

async function cleanup() {
  const st = STATE;
  if (st.cdp) { st.cdp.close(); st.cdp = null; }
  if (st.browserProc) {
    const proc = st.browserProc;
    st.browserProc = null;
    try { if (!hasExited(proc)) proc.kill(); } catch (e) { /* ignore */ }
    await waitUntil(function () { return hasExited(proc); }, 6000, 200);
  }
  if (st.server) {
    const srv = st.server;
    st.server = null;
    await new Promise(function (resolve) {
      let finished = false;
      const finish = function () { if (!finished) { finished = true; resolve(); } };
      try { srv.close(finish); } catch (e) { finish(); }
      if (typeof srv.closeAllConnections === 'function') { try { srv.closeAllConnections(); } catch (e) { /* ignore */ } }
      setTimeout(finish, 2000);
    });
  }
  if (st.tmp) {
    if (st.keep) console.log('[临时] 已保留（--keep）：' + st.tmp);
    else {
      // 浏览器退出后其子进程还会短暂持有 profile 目录，Windows 上要留出释放时间
      await sleep(1200);
      await removeDirWithRetry(st.tmp);
    }
  }
}

/* ---------- 主流程 ---------- */

async function main() {
  const browser = arg('browser', '') || findBrowser();
  STATE.keep = arg('keep', '') !== '';

  console.log('══ 阅读器翻页方向 · 真实浏览器回归 ══');
  console.log('  根目录：' + ROOT);
  if (!browser) {
    console.error('[跳过] 未找到 Edge/Chrome，无法做真浏览器验证（可用 --browser=<exe路径> 指定）');
    process.exit(2);
  }

  const tmp = safeTmpDir('mv-reader-nav');
  STATE.tmp = tmp;
  const dataDir = path.join(tmp, 'data');
  const libRoot = path.join(tmp, 'comics');
  const profileDir = path.join(tmp, 'profile');
  // MV_DATA_DIR 必须在 loadConfig() 之前设置；dataDir() 是惰性求值，不会缓存首次结果
  process.env.MV_DATA_DIR = dataDir;

  await buildFixture(dataDir, libRoot);
  console.log('[夹具] 数据目录=' + dataDir);
  console.log('[夹具] 漫画库=' + libRoot + '  漫画=' + FIXTURE_COMIC + '（' + FIXTURE_CHAPTERS + ' 话 × ' + FIXTURE_PAGES + ' 页）');

  const svc = await startService();
  STATE.server = svc.server;
  const base = 'http://127.0.0.1:' + svc.port + '/';
  console.log('[服务] 真实服务就绪（createApp + loadModules + static，端口 listen(0) 随机分配）：' + base);
  console.log('[服务] 已加载模块：' + svc.modules.map(function (m) { return m.id; }).join(' '));

  const item = await scanAndFind(base);
  console.log('[夹具] 索引条目：' + item.title + '  ' + item.chapterCount + ' 话 / ' + item.images + ' 页 / ' + item.bytes + ' 字节');

  const launched = await launchBrowser(browser, profileDir);
  STATE.browserProc = launched.proc;
  console.log('[浏览器] ' + browser);
  console.log('[浏览器] headless=new，调试端口=' + launched.debugPort + '，临时 profile=' + profileDir);

  const cdp = cdpConnect(launched.wsUrl);
  STATE.cdp = cdp;
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const exceptions = [];
  const logErrors = [];
  /* 404 只报「Failed to load resource」是查不出问题的：必须把 URL 记下来。
     实测踩坑：断言只写条数，跑挂了完全不知道缺哪个资源。 */
  const netFails = [];
  cdp.on(function (msg) {
    if (msg.method === 'Network.responseReceived') {
      const res = msg.params && msg.params.response;
      if (res && res.status >= 400) netFails.push(res.status + ' ' + String(res.url || '').slice(0, 200));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails;
      const line = (d && d.exception && (d.exception.description || d.exception.value)) || (d && d.text) || '未知异常';
      exceptions.push(String(line).slice(0, 160));
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params && msg.params.entry;
      if (e && e.level === 'error') logErrors.push(String(e.text || '').slice(0, 160));
    }
  });

  await cdp.send('Page.navigate', { url: base + '#/reader?comic=' + encodeURIComponent(FIXTURE_ID) });

  const hasControls = await waitUntil(function () {
    return evaluate(cdp, 'document.querySelectorAll("[data-act]").length > 0');
  }, READY_TIMEOUT_MS, 300);
  if (!hasControls) throw new Error('阅读器翻页控件未在 ' + READY_TIMEOUT_MS + 'ms 内出现，页面可能没渲染出来');
  await evaluate(cdp, PAGE_HELPER);

  const rendered = await waitUntil(function () {
    return evaluate(cdp, 'window.__mvNav.text("page-total") === "/ ' + FIXTURE_PAGES + '"');
  }, READY_TIMEOUT_MS, 300);
  if (!rendered) {
    const total = await evaluate(cdp, 'window.__mvNav.text("page-total")');
    const chapter = await evaluate(cdp, 'window.__mvNav.text("chapter-label")');
    const alert = await evaluate(cdp, '(function () { var a = document.querySelector(".alert-err"); return a ? String(a.textContent).slice(0, 200) : ""; })()');
    // 页面说「漫画不存在」，就从 Node 侧直接问同一台服务，区分「服务真没有」还是「前端传错 id」
    const chDirect = await getJson(base + 'api/reader/chapter?comic=' + encodeURIComponent(FIXTURE_ID) + '&order=1').catch(function (e) { return { err: String(e && e.message) }; });
    const libDirect = await getJson(base + 'api/library/comics?size=50').catch(function (e) { return { err: String(e && e.message) }; });
    console.log('[诊断] 直连 chapter=' + JSON.stringify(chDirect).slice(0, 200));
    console.log('[诊断] 直连 comics 总数=' + JSON.stringify(libDirect).slice(0, 200));
    // 把页面上的异常一起带出来，否则「没渲染」永远只能靠猜
    throw new Error('夹具章节没有渲染成 ' + FIXTURE_PAGES + ' 页（page-total=' + total + ' chapter-label=' + chapter + ' alert=' + alert + ' 异常=' + exceptions.join(' | ') + '）');
  }
  await waitUntil(function () {
    return evaluate(cdp, '(function () { var i = document.querySelector(".reader-page"); return Boolean(i && i.complete && i.naturalWidth > 0); })()');
  }, 10000, 200);

  /* ---------- 断言 ---------- */
  const results = [];
  function check(name, pass, detail) { results.push({ name: name, pass: Boolean(pass), detail: detail }); }

  const dom = await evaluate(cdp, '(function () { var q = window.__mvNav; var img = document.querySelector(".reader-page"); return { chapter: q.text("chapter-label"), total: q.text("page-total"), hasPrev: Boolean(q.q("prev-page")), hasNext: Boolean(q.q("next-page")), naturalWidth: img ? img.naturalWidth : 0 }; })()');
  check('夹具加载成功：第 1 话 ' + FIXTURE_PAGES + ' 页、翻页控件齐全、首页图真实解码',
    dom.chapter === '第 1 话' && dom.total === '/ ' + FIXTURE_PAGES && dom.hasPrev && dom.hasNext && dom.naturalWidth > 0,
    '章节=' + dom.chapter + ' 总数=' + dom.total + ' 首页图宽=' + dom.naturalWidth + 'px prev/next=' + (dom.hasPrev && dom.hasNext ? '有' : '缺') + ' 标题=' + item.title);

  const prefs = await getJson(base + 'api/reader/prefs');
  const rtlOn = Boolean(prefs && prefs.prefs && prefs.prefs.rtl === true);
  const rtlLabel = await evaluate(cdp, '(function () { var bs = document.querySelectorAll(".reader-bar button"); for (var i = 0; i < bs.length; i++) { var t = String(bs[i].textContent || "").trim(); if (t.indexOf("日漫") === 0 || t.indexOf("西漫") === 0) return t; } return ""; })()');
  check('日漫模式前置条件成立（rtl=true，这个 bug 只在此前提下暴露）',
    rtlOn && rtlLabel.indexOf('日漫') === 0,
    'GET /api/reader/prefs 的 rtl=' + rtlOn + '，方向按钮文案="' + rtlLabel + '"');

  const v0 = await readPage(cdp);
  check('初始页码 = 1', v0 === '1', '[data-act="page-num"] 的 value=' + v0);

  await clickAct(cdp, 'next-page');
  const v1 = await readPage(cdp);
  check('点「下一页」后页码 = 2（本次 bug 的核心断言）', v1 === '2', '点前=' + v0 + ' 点后=' + v1);

  await clickAct(cdp, 'prev-page');
  const v2 = await readPage(cdp);
  check('点「上一页」后从第 2 页回到 1', v1 === '2' && v2 === '1', '点前页码=' + v1 + ' 点后页码=' + v2);

  const chBefore = await readChapter(cdp);
  await clickAct(cdp, 'prev-page');
  const v3 = await readPage(cdp);
  const chAfter = await readChapter(cdp);
  check('第 1 页点「上一页」不跳到第 2 页', v3 !== '2' && (v3 === '1' || chAfter !== chBefore),
    '点前页码=' + v2 + ' 点后页码=' + v3 + ' 章节=' + chBefore + ' -> ' + chAfter);

  await pressKey(cdp, 'ArrowRight', 'ArrowRight', 39);
  const v4 = await readPage(cdp);
  check('按 ArrowRight 后页码 = 2（键盘与按钮同向）', v4 === '2', '按前=' + v3 + ' 按后=' + v4);

  await pressKey(cdp, 'ArrowLeft', 'ArrowLeft', 37);
  const v5 = await readPage(cdp);
  check('按 ArrowLeft 后从第 2 页回到 1', v4 === '2' && v5 === '1', '按前页码=' + v4 + ' 按后页码=' + v5);

  /* ---------- 翻页条：默认淡出 / 鼠标唤回 / 锁定常显 ---------- */
  const barState = function () {
    return evaluate(cdp, '(function () { var d = window.__mvNav.q("reader-pagebar"); if (!d) return null; var cs = getComputedStyle(d); return { opacity: cs.opacity, hideCls: d.className.indexOf("auto-hide") >= 0, locked: window.__mvNav.q("bar-lock").className.indexOf("lock-on") >= 0 }; })()');
  };
  const b0 = await barState();
  check('翻页条初始可见（刚进页面鼠标还没停）', b0 && b0.opacity === '1' && !b0.hideCls,
    'opacity=' + (b0 && b0.opacity) + ' auto-hide=' + (b0 && b0.hideCls));
  await sleep(3600);
  const b1 = await barState();
  check('默认不锁定：鼠标不动约 2.8 秒后翻页条自己淡出', b1 && b1.hideCls && b1.opacity === '0',
    'opacity=' + (b1 && b1.opacity) + ' auto-hide=' + (b1 && b1.hideCls));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 300, button: 'none' });
  await sleep(250);
  const b2 = await barState();
  check('鼠标一动翻页条立刻回来', b2 && !b2.hideCls && b2.opacity === '1',
    'opacity=' + (b2 && b2.opacity) + ' auto-hide=' + (b2 && b2.hideCls));
  await clickAct(cdp, 'bar-lock');
  await sleep(3600);
  const b3 = await barState();
  check('点锁定后翻页条常显（超过自动隐藏时长仍可见）', b3 && b3.locked && !b3.hideCls && b3.opacity === '1',
    'locked=' + (b3 && b3.locked) + ' opacity=' + (b3 && b3.opacity));
  const prefsLocked = await getJson(base + 'api/reader/prefs');
  check('锁定状态已落盘（POST /api/reader/prefs 的 barLock 生效）',
    Boolean(prefsLocked && prefsLocked.prefs && prefsLocked.prefs.barLock === true),
    'GET prefs.barLock=' + (prefsLocked && prefsLocked.prefs && prefsLocked.prefs.barLock));

  /* ---------- 刷新后保持 + 条漫等高占位 ---------- */
  // 条漫模式 + 预加载 6 页：让一本 6 页的夹具全部进队列，验证「占位块 → 真图原地替换」
  await postJson(base + 'api/reader/prefs', { preload: 6, mode: 'webtoon' });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(400);
  await cdp.send('Page.navigate', { url: base + '#/reader?comic=' + encodeURIComponent(FIXTURE_ID) });
  await waitUntil(function () { return evaluate(cdp, 'document.querySelectorAll("[data-act]").length > 0'); }, READY_TIMEOUT_MS, 300);
  await evaluate(cdp, PAGE_HELPER);
  await waitUntil(function () { return evaluate(cdp, 'window.__mvNav.text("page-total") === "/ ' + FIXTURE_PAGES + '"'); }, READY_TIMEOUT_MS, 300);
  const b4 = await barState();
  check('刷新后锁定态保持（翻页条仍然常显）', b4 && b4.locked && !b4.hideCls,
    'locked=' + (b4 && b4.locked) + ' auto-hide=' + (b4 && b4.hideCls));

  const sz = await getJson(base + 'api/reader/sizes?comic=' + encodeURIComponent(FIXTURE_ID) + '&order=1');
  check('GET /api/reader/sizes 返回每页尺寸（前端据此算占位高度）',
    Boolean(sz && sz.ok === true && Array.isArray(sz.sizes) && sz.sizes.length === FIXTURE_PAGES && sz.sizes[0] && sz.sizes[0].w > 0 && sz.sizes[0].h > 0),
    'count=' + (sz && sz.count) + ' sizes[0]=' + JSON.stringify(sz && sz.sizes && sz.sizes[0]));

  const ph0 = await evaluate(cdp, '(function () { var wrap = document.querySelector(".reader-webtoon"); var phs = wrap ? wrap.querySelectorAll(":scope > .reader-ph") : []; var direct = wrap ? wrap.querySelectorAll(":scope > img") : []; return { ph: phs.length, direct: direct.length, h0: phs.length ? phs[0].style.height : "" }; })()');
  check('条漫渲染成 ' + FIXTURE_PAGES + ' 个等高占位块（不是一次性堆 ' + FIXTURE_PAGES + ' 个裸 <img>）',
    ph0.ph === FIXTURE_PAGES && ph0.direct === 0,
    '占位块=' + ph0.ph + ' 直属裸图=' + ph0.direct + ' 首块高度=' + ph0.h0);
  check('占位高度已按图片真实比例算好', parseInt(ph0.h0, 10) >= 80, '首块高度=' + ph0.h0);

  const allIn = await waitUntil(function () {
    return evaluate(cdp, 'document.querySelectorAll(".reader-webtoon .reader-img").length >= ' + FIXTURE_PAGES);
  }, 15000, 250);
  const ph1 = await evaluate(cdp, '(function () { var imgs = document.querySelectorAll(".reader-webtoon .reader-img"); var ok = 0; for (var i = 0; i < imgs.length; i++) { if (imgs[i].complete && imgs[i].naturalWidth > 0) ok++; } return { img: imgs.length, decoded: ok }; })()');
  check('预加载队列把附近的图取回来并原地替换占位块（页数不重不漏）',
    allIn && ph1.img === FIXTURE_PAGES && ph1.decoded === FIXTURE_PAGES,
    '真图=' + ph1.img + ' 已解码=' + ph1.decoded);

  /* ---------- 条漫：滚动驱动加载（历史的「条漫加载不出来」回归） ----------
     背景：这里原来用 IntersectionObserver + threshold:[0.4,0.75] 判定「当前页」。
     占位块按整页高度撑开（真实漫画高宽比约 1.4），只要块高超过视口 2.5 倍，
     单个块最多只能露出不到 40%，回调就永远不触发 → 页码停在 1、预加载队列不跟着
     滚动走 → 往下滚全是灰底占位块。用户报障原话：「条漫模式加载不出来」。
     本用例主动把视口压矮，强制制造「块高 > 2.5×视口」的几何，旧实现必然失败。
     注意：不能只靠上面那段「6 页 preload=6」的检查 —— 那种配置下 6 页一次全进队列，
     滚动跟踪根本没参与，正是这个 bug 逃过验收的原因。 */
  await postJson(base + 'api/reader/prefs', { preload: 1, mode: 'webtoon' });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 300, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await cdp.send('Page.navigate', { url: base + '#/reader?comic=' + encodeURIComponent(FIXTURE_ID) });
  await waitUntil(function () { return evaluate(cdp, 'document.querySelectorAll(".reader-webtoon > .reader-ph").length === ' + FIXTURE_PAGES); }, READY_TIMEOUT_MS, 250);
  await evaluate(cdp, PAGE_HELPER);
  const geom = await evaluate(cdp, '(function () { var st = document.querySelector(".reader-stage"); var ph = document.querySelector(".reader-webtoon > .reader-ph"); return { stageH: st.clientHeight, blockH: ph ? ph.getBoundingClientRect().height : 0 }; })()');
  check('构造出「单个占位块高于视口 2.5 倍」的几何（旧观察器阈值 0.4 在这种几何下永不触发）',
    geom.blockH > geom.stageH * 2.5, '视口=' + geom.stageH + ' 块高=' + Math.round(geom.blockH));
  const SC_SNAP = '(function () { function q(a) { var l = document.querySelectorAll("[data-act]"); for (var i = 0; i < l.length; i++) { if (l[i].getAttribute("data-act") === a) return l[i]; } return null; } var st = document.querySelector(".reader-stage"); return { page: String(q("page-num").value), img: document.querySelectorAll(".reader-webtoon .reader-img").length, scrollTop: st.scrollTop, scrollH: st.scrollHeight }; })()';
  const sc0 = await evaluate(cdp, SC_SNAP);
  check('初始只加载队列里的前几页（不是一次全量）', sc0.img < FIXTURE_PAGES && sc0.page === '1', '初始真图=' + sc0.img + ' 页码=' + sc0.page + ' 可滚高度=' + sc0.scrollH);
  await evaluate(cdp, '(function () { var st = document.querySelector(".reader-stage"); st.scrollTop = st.scrollHeight; return st.scrollTop; })()');
  const advanced = await waitUntil(function () {
    return evaluate(cdp, '(function () { function q(a) { var l = document.querySelectorAll("[data-act]"); for (var i = 0; i < l.length; i++) { if (l[i].getAttribute("data-act") === a) return l[i]; } return null; } return String(q("page-num").value) !== "1" && document.querySelectorAll(".reader-webtoon .reader-img").length > 2; })()');
  }, 20000, 300);
  const sc1 = await evaluate(cdp, SC_SNAP);
  check('滚动后「当前页」跟着走（历史 bug：观察器回调不触发，页码永远停在 1）',
    advanced, '滚到 ' + Math.round(sc1.scrollTop) + '/' + sc1.scrollH + ' 后 页码=' + sc1.page + ' 真图=' + sc1.img);
  // 逐页往下滚（真实阅读方式）：每经过一页，队列就把那一页附近的图补上。
  // 不用「一次性跳到底」断言整章补齐 —— preload 只有 1 时，跳到底只会补当前页前后
  // 各一页，中间页永远不会被访问到（这是队列的正确语义，不是 bug）。
  // 先回到顶部：上一条断言已经滚到底了，不归零的话会一步跳到最后，中间页永远访问不到
  await evaluate(cdp, '(function () { var st = document.querySelector(".reader-stage"); st.scrollTop = 0; return st.scrollTop; })()');
  await sleep(900);
  let sc2 = null;
  for (let k = 0; k < FIXTURE_PAGES * 4; k++) {
    sc2 = await evaluate(cdp, SC_SNAP);
    if (sc2.img >= FIXTURE_PAGES) break;
    await evaluate(cdp, '(function () { var st = document.querySelector(".reader-stage"); st.scrollTop = st.scrollTop + st.scrollHeight / ' + FIXTURE_PAGES + '; return st.scrollTop; })()');
    await sleep(900);
  }
  sc2 = await evaluate(cdp, SC_SNAP);
  check('逐页往下滚能把整章补齐（占位块全部被真图替换）', Boolean(sc2 && sc2.img === FIXTURE_PAGES),
    '真图=' + (sc2 && sc2.img) + '/' + FIXTURE_PAGES + ' 页码=' + (sc2 && sc2.page));
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  /* ---------- 切模式 / 切适应方式后必须仍能出图 ----------
     用户复报：「切换条漫时卡住，非得再刷新一遍才行；切换适应宽度/高度/原始尺寸也一样」。
     根因：render() 每次切模式或切适应方式都会 stage.textContent='' 重建 DOM，而 preloadDone
     是跨渲染保留的「这张图请求过了」记录。新占位块建好后 startLoad() 因「已加载」直接返回，
     永远等不到 swapIn → 条漫里全是灰底占位块，只有整页刷新（preloadDone 随模块重新初始化）
     才能恢复。修法是 render() 建完占位块后调 fillLoaded() 回填已解码的图。 */
  await postJson(base + 'api/reader/prefs', { preload: 3, mode: 'single' });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await cdp.send('Page.navigate', { url: base + '#/reader?comic=' + encodeURIComponent(FIXTURE_ID) });
  await waitUntil(function () { return evaluate(cdp, 'document.querySelectorAll("[data-act]").length > 0'); }, READY_TIMEOUT_MS, 300);
  await evaluate(cdp, PAGE_HELPER);
  const singleOk = await waitUntil(function () { return evaluate(cdp, "document.querySelectorAll('.reader-page').length >= 1"); }, READY_TIMEOUT_MS, 250);
  const singleCount = await evaluate(cdp, "document.querySelectorAll('.reader-page').length");
  check('切模式用例前置：单页模式正常出图', singleOk, '单页图数=' + singleCount);

  const clickBar = "(function (t) { var b = document.querySelectorAll('.reader-bar button'); for (var i = 0; i < b.length; i++) { if ((b[i].title || '').indexOf(t) === 0) { b[i].click(); return 'ok'; } } return 'no-btn'; })";
  const BTN_MODE = String.fromCharCode(34) + '切换阅读模式' + String.fromCharCode(34);
  const BTN_FIT = String.fromCharCode(34) + '切换适应方式' + String.fromCharCode(34);
  const clickMode = clickBar + '(' + BTN_MODE + ')';
  const clickFit = clickBar + '(' + BTN_FIT + ')';
  const m1 = await evaluate(cdp, clickMode);
  await sleep(1200);
  const m2 = await evaluate(cdp, clickMode);
  await sleep(1200);
  const stageCls = await evaluate(cdp, "document.querySelector('.reader-stage').className");
  check('连点两次模式按钮切到条漫（前置）', m1 === 'ok' && m2 === 'ok' && String(stageCls).indexOf('mode-webtoon') >= 0, '阶段=' + stageCls);

  const switched = await waitUntil(function () { return evaluate(cdp, "document.querySelectorAll('.reader-img').length >= 1"); }, 12000, 300);
  const swSnap = await evaluate(cdp, "(function () { var l = document.querySelectorAll('.reader-img'); var ok = 0; for (var i = 0; i < l.length; i++) { if (l[i].complete && l[i].naturalWidth > 0) ok++; } return { ph: document.querySelectorAll('.reader-ph').length, img: l.length, decoded: ok }; })()");
  check('切到条漫后立刻有真图（历史 bug：切换后必须刷新才出图）', Boolean(switched && swSnap.img >= 1 && swSnap.decoded >= 1),
    '占位块=' + swSnap.ph + ' 真图=' + swSnap.img + ' 已解码=' + swSnap.decoded);

  const f1 = await evaluate(cdp, clickFit);
  await sleep(1500);
  const fitSnap = await evaluate(cdp, "(function () { var l = document.querySelectorAll('.reader-img'); var ok = 0; for (var i = 0; i < l.length; i++) { if (l[i].complete && l[i].naturalWidth > 0) ok++; } return { img: l.length, decoded: ok }; })()");
  check('切适应方式后条漫仍保持出图（历史 bug：切一次就白屏）', f1 === 'ok' && fitSnap.img >= 1 && fitSnap.decoded >= 1,
    '真图=' + fitSnap.img + ' 已解码=' + fitSnap.decoded);

  /* 还原：解锁 + 回到单页，别把锁定态留给之后的人工使用 */
  await clickAct(cdp, 'bar-lock');
  const after = await getJson(base + 'api/reader/prefs');
  check('再次点击可解锁（barLock 回到 false）',
    Boolean(after && after.prefs && after.prefs.barLock === false),
    'GET prefs.barLock=' + (after && after.prefs && after.prefs.barLock));
  const noise = exceptions.concat(logErrors).concat(netFails.map(function (s) { return 'HTTP ' + s; }));
  check('全程无未捕获异常 / console error / 4xx 资源', exceptions.length === 0 && logErrors.length === 0 && netFails.length === 0,
    'Runtime.exceptionThrown=' + exceptions.length + ' 条，Log error=' + logErrors.length + ' 条，4xx=' + netFails.length + ' 条' + (noise.length ? '：' + noise.join(' | ') : ''));

  /* ---------- 结果 ---------- */
  const passed = results.filter(function (r) { return r.pass; }).length;
  const failed = results.length - passed;
  console.log('[翻页] 初始=' + v0 + ' -> next-page=' + v1 + ' -> prev-page=' + v2 + ' -> 第1页prev-page=' + v3 + ' -> ArrowRight=' + v4 + ' -> ArrowLeft=' + v5);
  console.log('[控制台] Runtime.exceptionThrown=' + exceptions.length + ' 条，Log error=' + logErrors.length + ' 条，4xx=' + netFails.length + ' 条');
  if (netFails.length) console.log('[4xx] ' + netFails.join(' | '));
  console.log('');
  for (const r of results) {
    console.log('  ' + (r.pass ? '✓ PASS' : '✗ FAIL') + '  ' + r.name + '  (' + r.detail + ')');
  }
  console.log('');
  console.log('结果: ' + passed + '/' + results.length + ' 通过' + (failed ? ' · ' + failed + ' 失败' : ''));
  console.log('退出码: ' + (failed ? '1' : '0'));
  if (failed) EXIT = 1;
}

main().catch(function (err) {
  console.error('[失败] ' + (err && err.message));
  EXIT = 1;
}).finally(function () {
  return cleanup();
}).finally(function () {
  process.exit(EXIT);
});
