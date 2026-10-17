#!/usr/bin/env node
/**
 * 下载中心「收藏夹 / 排行榜 / 我的」真浏览器验证（无头 Edge + CDP，零第三方依赖）。
 *
 * 做法：
 *   1. 用 safeTmpDir() 造隔离数据目录，写一份 config.json（随机端口 + 指向本机假上游）；
 *   2. 起一个假哔咔上游（node:http），提供 favourite / leaderboard / profile / sign-in；
 *   3. 起真实后端 node src/server.mjs（MV_DATA_DIR 指向隔离目录），从 stdout 读实际端口；
 *   4. 起无头 Edge（--remote-debugging-port=0，从 user-data-dir 的 DevToolsActivePort 读端口）；
 *   5. 依次点四个页签，断言 DOM 里出现卡片 / 登录表单 / 资料，并断言没有 JS 报错、没有一次性渲染几百个节点。
 *
 * 断言纪律（踩过的坑）：
 *   · 卡片计数一律限定在**当前可见面板**（.mv-dl-panel:not(.hidden)）内。
 *     页签只是给面板加 .hidden，隐藏面板的卡片还在 DOM 里，
 *     用全局 .comic-card 计数会把收藏夹的隐藏卡片算成排行榜的成绩（假绿）。
 *   · clickByText 只认叶子节点或 chip/button 类控件，且必须是完整匹配；
 *     否则会被「换个周期（日榜 / 周榜 / 月榜）再看看」这种说明文案抢走点击。
 *
 * 用法：
 *   node scripts/dev/download-tabs-check.mjs [--keep] [--search] [--headful]
 *   --keep     保留临时目录（排查用）
 *   --search   额外跑一遍「搜索」页签（会走假上游 advanced-search）
 *   --headful  有头模式（本机肉眼复核）
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { safeTmpDir } from '../../src/core/util.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXAMPLE_CONFIG = path.join(PROJECT_ROOT, 'config.example.json');
const TOKEN = 'mv-check-token';
const FAV_TOTAL = 42;
const RANK_TOTAL = 30;
/** 一页上游给 30 条，前端首屏只挂 24 条（客户端分批），点一下补到 30。 */
const PAGE_SIZE = 30;
const CARD_BATCH = 24;

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

function arg(name, dflt) {
  const hit = process.argv.slice(2).find(function (a) { return a.startsWith('--' + name + '='); });
  if (hit) return hit.split('=').slice(1).join('=');
  return process.argv.includes('--' + name) ? '1' : dflt;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function log(tag, text) { console.log('[' + tag + '] ' + text); }

function findBrowser() {
  for (const c of BROWSERS) { if (fs.existsSync(c)) return c; }
  return null;
}

function randomPort() { return 20000 + Math.floor(Math.random() * 30000); }

function getJson(url) {
  return new Promise(function (resolve, reject) {
    const req = http.get(url, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { reject(new Error('非 JSON 响应(' + res.statusCode + ')：' + body.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, function () { req.destroy(new Error('请求超时')); });
  });
}

async function waitForHttp(url, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try { await getJson(url); return true; }
    catch (e) { last = e; await sleep(250); }
  }
  throw new Error((label || url) + ' 在 ' + timeoutMs + 'ms 内未就绪：' + (last && last.message));
}

/* ------------------------- 假哔咔上游 ------------------------- */

/** 造一批可预测的漫画 doc（形状与真上游一致，路由会映射成统一 Comic）。 */
function makeDocs(count, prefix, tag) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    out.push({
      _id: prefix + i,
      title: '假漫画 ' + i + '（' + tag + '）',
      author: '假作者 ' + ((i % 5) + 1),
      tags: ['純愛', 'RISO'],
      categories: ['同人'],
      epsCount: 10 + i,
      likesCount: 100 * i,
      totalViews: 1000 * i,
      finished: i % 2 === 0,
      thumb: { fileServer: 'https://img.local', path: 'a/b/' + prefix + i + '.jpg' }
    });
  }
  return out;
}

/**
 * 排行榜元素形状以参考下载器为准：
 * _ref_downloader/.../responses/get_rank_resp_data.rs 里
 *   GetRankRespData { comics: Vec<ComicInRankRespData> }
 * —— comics 是**数组**（不是 {docs:[...]} 对象），字段名是 totalLikes / totalViews /
 * pagesCount / epsCount / categories / tags / thumb。
 * 写错形状会让适配器读到空列表，排行榜整条链路静默变成 0 条。
 */
function makeRankDocs(count, tag) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    out.push({
      _id: 'rank-' + i,
      title: '假漫画 ' + i + '（' + tag + '）',
      author: '假作者 ' + ((i % 5) + 1),
      totalViews: 1000 * i,
      totalLikes: 100 * i,
      pagesCount: 200 + i,
      epsCount: 10 + i,
      finished: i % 2 === 0,
      categories: ['同人'],
      tags: ['純愛', 'RISO'],
      thumb: { fileServer: 'https://img.local', path: 'a/b/rank-' + i + '.jpg' },
      leaderboardCount: i,
      viewsCount: 1000 * i
    });
  }
  return out;
}

function startFakeUpstream() {
  const seen = [];
  const server = http.createServer(function (req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    seen.push(req.method + ' ' + u.pathname + (u.search || ''));
    let chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      let body = null;
      if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { body = null; } }
      const page = Math.max(1, Number(u.searchParams.get('page') || 1));
      const sort = u.searchParams.get('s') || 'dd';
      let data = null;
      if (u.pathname === '/auth/sign-in') {
        data = { token: TOKEN, user: { _id: 'u-1', name: '验收账号', email: (body && body.email) || 'check@example.com', level: 7, exp: 320, role: 'member', avatar: { fileServer: 'https://img.local', path: 'a/b/avatar.jpg' } } };
      } else if (u.pathname === '/users/favourite') {
        // 第一页给满 30 条，用来验证「先渲染 24 条，点加载更多再补」，第二页 12 条
        const all = makeDocs(FAV_TOTAL, 'fav-', sort === 'da' ? '最早' : '最新');
        const from = (page - 1) * PAGE_SIZE;
        // 收藏夹真实形状：docs 挂在 container.comics 下（适配器读 d.comics.docs）
        data = { comics: { docs: all.slice(from, from + PAGE_SIZE), total: all.length, pages: Math.ceil(all.length / PAGE_SIZE), page: page } };
      } else if (u.pathname === '/comics/leaderboard') {
        const tt = u.searchParams.get('tt') || 'H24';
        // 真实形状：comics 是数组，且上游不分页（一次给全榜）
        data = { comics: makeRankDocs(RANK_TOTAL, tt) };
      } else if (u.pathname === '/users/profile') {
        data = { user: { _id: 'u-1', name: '验收账号', email: 'check@example.com', level: 7, exp: 320, role: 'member', avatar: { fileServer: 'https://img.local', path: 'a/b/avatar.jpg' } } };
      } else if (u.pathname === '/comics/advanced-search') {
        data = { comics: { docs: makeDocs(3, 'search-', '搜索'), total: 3, pages: 1, page: 1 } };
      }
      if (data === null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: '假上游没有这个接口：' + u.pathname }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 200, message: 'ok', data: data }));
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () { resolve({ server: server, port: server.address().port, seen: seen }); });
  });
}

/* ------------------------- 极简 CDP 客户端 ------------------------- */

function cdpConnect(wsUrl) {
  const ws = new globalThis.WebSocket(wsUrl);
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
    ws.addEventListener('error', function () { reject(new Error('CDP WebSocket 连接失败')); });
  });
  function send(method, params) {
    const id = nextId++;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      setTimeout(function () { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 25000);
    });
  }
  return { ready: ready, send: send, on: function (fn) { listeners.push(fn); }, close: function () { try { ws.close(); } catch (e) { /* ignore */ } } };
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面脚本异常: ' + (r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)));
  return r.result ? r.result.value : undefined;
}

/* ------------------------- 主流程 ------------------------- */

async function main() {
  const keep = arg('keep', '') === '1';
  const headful = arg('headful', '') === '1';
  const withSearch = arg('search', '') === '1';
  const browserExe = findBrowser();
  if (!browserExe) { console.error('[跳过] 未找到 Edge/Chrome，无法做真浏览器验证'); process.exit(2); }
  if (typeof globalThis.WebSocket !== 'function') { console.error('[跳过] 当前 Node 无内置 WebSocket（需 Node 22+）'); process.exit(2); }

  const dir = safeTmpDir('mv-dl-tabs');
  const dataDir = path.join(dir, 'data');
  const libDir = path.join(dir, 'library');
  const dlDir = path.join(dir, 'downloads');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(libDir, { recursive: true });
  await fsp.mkdir(dlDir, { recursive: true });
  log('准备', '临时目录 ' + dir);

  const fake = await startFakeUpstream();
  log('假上游', 'http://127.0.0.1:' + fake.port + '/');

  // 隔离配置：随机端口（绝不占用 8775）+ 指向假上游 + 一个假 token
  const cfg = JSON.parse(await fsp.readFile(EXAMPLE_CONFIG, 'utf8'));
  const port = randomPort();
  cfg.port = port;
  cfg.host = '127.0.0.1';
  cfg.logLevel = 'warn';
  cfg.libraryRoot = libDir;
  cfg.libraryRoots = [{ id: 'tmp', name: '验收库', path: libDir, enabled: true }];
  cfg.downloadRoot = dlDir;
  cfg.picacomic.apiBase = 'http://127.0.0.1:' + fake.port;
  cfg.picacomic.token = TOKEN;
  cfg.picacomic.retries = 0;
  cfg.picacomic.timeoutMs = 8000;
  await fsp.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

  let serverProc = null;
  let browserProc = null;
  let cdp = null;
  const jsErrors = [];
  const pageLogs = [];
globalThis.__mvPageLogs = pageLogs;
  const results = [];
  const traces = [];
  /* 失败时也要能看见已经跑过的检查项：main() 中途抛错会跳过下面的报告段，
     所以把 results / traces 挂到 globalThis，由 main().catch 兜底打印。
     本次排查就是靠它才定位到「登录 502」的根因，别删。 */
  globalThis.__mvResults = results;
  globalThis.__mvDebugTrace = traces;

  function check(name, pass, detail) {
    results.push({ name: name, pass: Boolean(pass), detail: String(detail === undefined ? '' : detail) });
  }
  function trace(text) { traces.push(String(text)); }

  try {
    serverProc = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'server.mjs')], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { MV_DATA_DIR: dataDir })
    });
    let out = '';
    serverProc.stdout.on('data', function (c) { out += c; });
    serverProc.stderr.on('data', function (c) { out += c; });

    // 端口可能避让：优先读 stdout 的「已启动 -> http://127.0.0.1:PORT/」，
    // 拿不到就按「首选端口 + 最多 20 次避让」逐个探 /api/ping（比依赖日志输出稳）。
    const baseUrl = await (async function () {
      const until = Date.now() + 60000;
      let next = 0;
      while (Date.now() < until) {
        const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
        if (m) return 'http://127.0.0.1:' + m[1] + '/';
        if (serverProc.exitCode !== null) throw new Error('后端进程提前退出（code=' + serverProc.exitCode + '）：' + out.slice(-400));
        if (next < 20 && Date.now() > until - 45000) {
          const candidate = 'http://127.0.0.1:' + (port + next) + '/';
          next++;
          try {
            const ping = await getJson(candidate + 'api/ping');
            if (ping.data && ping.data.name === 'MangaVault') return candidate;
          } catch (e) { /* 这个端口还不是后端 */ }
        }
        await sleep(250);
      }
      throw new Error('等待后端端口超时（首选 ' + port + '），输出：' + out.slice(-400));
    })();
    log('后端', baseUrl);
    await waitForHttp(baseUrl + 'api/ping', 15000, '后端 /api/ping');
    check('后端在随机端口就绪（未占用 8775）', true, baseUrl);

    // 数据是否真的打到假上游（证明接口链路通）
    const favApi = await getJson(baseUrl + 'api/download/favorites?sort=dd&page=1');
    check('GET /api/download/favorites 走通真实路由', favApi.status === 200 && favApi.data && favApi.data.ok === true, 'status=' + favApi.status + ' total=' + (favApi.data && favApi.data.total));

    const lb = await getJson(baseUrl + 'api/download/leaderboard?tt=H24&ct=VC&page=1');
    const lbOk = lb.status === 200 && lb.data && lb.data.ok === true && Array.isArray(lb.data.comics);
    check('GET /api/download/leaderboard 已合入并可用', lbOk, 'status=' + lb.status + ' total=' + (lb.data && lb.data.total) + ' comics=' + ((lb.data && lb.data.comics && lb.data.comics.length) || 0));
    /* 上游形状写错时这里会静默变成 0 条：必须断言条数，不能只看 Array.isArray。 */
    check('排行榜上游返回 ' + RANK_TOTAL + ' 条（comics 是数组，形状与参考下载器一致）',
      lbOk && lb.data.comics.length === RANK_TOTAL, 'comics=' + ((lb.data && lb.data.comics && lb.data.comics.length) || 0));

    const pf = await getJson(baseUrl + 'api/download/profile');
    const pfOk = pf.status === 200 && pf.data && pf.data.ok === true && Boolean(pf.data.profile);
    check('GET /api/download/profile 已合入并可用', pfOk, 'status=' + pf.status + ' body=' + JSON.stringify(pf.data).slice(0, 160));

    // ---- 起无头浏览器 ----
    const browserDataDir = path.join(dir, 'edge');
    await fsp.mkdir(browserDataDir, { recursive: true });
    const browserArgs = [
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--remote-debugging-port=0',
      '--user-data-dir=' + browserDataDir,
      'about:blank'
    ];
    if (!headful) browserArgs.unshift('--headless=new');
    browserProc = spawn(browserExe, browserArgs, { stdio: 'ignore' });

    // --remote-debugging-port=0：从 user-data-dir 的 DevToolsActivePort 读实际端口
    const devtoolsFile = path.join(browserDataDir, 'DevToolsActivePort');
    let cdpPort = 0;
    const untilDev = Date.now() + 25000;
    while (Date.now() < untilDev) {
      try {
        const text = await fsp.readFile(devtoolsFile, 'utf8');
        cdpPort = Number(String(text).split(/\r?\n/)[0]);
        if (cdpPort) break;
      } catch (e) { /* 还没写出来 */ }
      await sleep(250);
    }
    if (!cdpPort) throw new Error('浏览器调试端口未就绪（DevToolsActivePort 读不到）');
    const list = await getJson('http://127.0.0.1:' + cdpPort + '/json/list');
    const page = (list.data || []).find(function (t) { return t.type === 'page'; }) || (list.data || [])[0];
    if (!page) throw new Error('没有可连接的页面目标');

    cdp = cdpConnect(page.webSocketDebuggerUrl);
    await cdp.ready;

    /* 网络证据：登录这类「前端只看到一句中文错误」的问题，必须能拿到
       真实请求方法 / 状态码 / 响应体，否则只能猜。 */
    const netById = new Map();
    const apiResponses = [];
    const apiBodies = [];
    const bodyWatch = new Map();
    let lastBody = null;

    cdp.on(function (msg) {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const type = msg.params && msg.params.type;
        const args = (msg.params && msg.params.args) || [];
        const txt = args.map(function (a) { return a.value === undefined ? (a.description || a.type) : String(a.value); }).join(' ');
        pageLogs.push(type + ': ' + txt);
        if (type === 'error') jsErrors.push('console.error: ' + txt);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params && msg.params.exceptionDetails;
        /* 先取 exception.description（带 message + stack），d.text 只有一句 "Uncaught"，
           单独用它会把所有未捕获异常都变成无法定位的同一句话。 */
        const ex = d && d.exception;
        const detail = (ex && (ex.description || ex.value)) || (d && d.text) || 'unknown';
        jsErrors.push('未捕获异常: ' + String(detail).split('\n').slice(0, 3).join(' / '));
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params && msg.params.entry;
        if (e && e.level === 'error') pageLogs.push('log-error: ' + e.text);
      } else if (msg.method === 'Network.requestWillBeSent') {
        const p = msg.params || {};
        const req = p.request || {};
        netById.set(p.requestId, { method: req.method || '', url: String(req.url || '') });
      } else if (msg.method === 'Network.responseReceived') {
        const p = msg.params || {};
        const req = netById.get(p.requestId) || { method: '', url: '' };
        const url = String((p.response && p.response.url) || req.url || '');
        if (url.indexOf('/api/download/') >= 0) {
          /* baseUrl 自带结尾斜杠，直接 replace 会得到不带前导斜杠的路径，
             后面用 indexOf('/api/download/...') 过滤就会全部漏掉 —— 用 slice 补回来。 */
          const pathOnly = '/' + url.slice(baseUrl.length);
          apiResponses.push({ method: req.method, status: (p.response && p.response.status) || 0, path: pathOnly });
          /* 顺带把响应体也抓下来：登录/资料这类问题只靠状态码说不清。 */
          bodyWatch.set(p.requestId, pathOnly);
        }
      } else if (msg.method === 'Network.loadingFinished') {
        const p = msg.params || {};
        const watchPath = bodyWatch.get(p.requestId);
        if (watchPath) {
          bodyWatch.delete(p.requestId);
          void (async function () {
            let text = '(空响应体)';
            try {
              const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
              text = b && b.body ? String(b.body).slice(0, 400) : '(空响应体)';
            } catch (e) { text = '(取响应体失败：' + e.message + ')'; }
            apiBodies.push({ path: watchPath, body: text });
            if (watchPath.indexOf('/api/download/login') >= 0) lastBody = text;
          })();
        }
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    /* 只点叶子节点或 chip/button 类控件，且必须完整匹配 —— 防止点到
       「换个周期（日榜 / 周榜 / 月榜）再看看」这类说明文案的祖先节点。 */
    function clickByText(text) {
      return evaluate(cdp, '(function(){ var t = ' + JSON.stringify(text) + ';'
        + ' function depthOf(n){ var d = 0; while (n && n.parentElement) { d++; n = n.parentElement; } return d; }'
        + ' var all = Array.prototype.slice.call(document.querySelectorAll(".chip, .tab, button, span, div, a, label"));'
        + ' var hit = all.filter(function(n){'
        + '   if ((n.textContent || "").trim() !== t) return false;'
        + '   var isLeaf = n.children.length === 0;'
        + '   var isCtl = Boolean(n.classList) && (n.classList.contains("chip") || n.classList.contains("tab") || n.tagName === "BUTTON");'
        + '   return isLeaf || isCtl;'
        + ' }).sort(function(a, b){ return depthOf(b) - depthOf(a); })[0];'
        + ' if (!hit) return "not-found"; hit.click(); return "clicked"; })()');
    }
    /* 卡片计数只看当前可见面板：隐藏面板里的卡片不算数。 */
    const VISIBLE_CARDS = 'document.querySelectorAll(".mv-dl-panel:not(.hidden) .comic-card").length';
    function cardCount() { return evaluate(cdp, VISIBLE_CARDS); }
    function visibleCardsExpr() { return '(function(){ var n = ' + VISIBLE_CARDS + '; return n > 0 ? n : 0; })()'; }
    function clickPanelBtnByText(text) {
      return evaluate(cdp, '(function(){ var t = ' + JSON.stringify(text) + ';'
        + ' var bs = Array.prototype.slice.call(document.querySelectorAll(".mv-dl-panel:not(.hidden) button"));'
        + ' var hit = bs.filter(function(b){ return (b.textContent||"").indexOf(t) >= 0; })[0];'
        + ' if (!hit) return "not-found"; hit.click(); return "clicked"; })()');
    }
    function moreLabels() {
      return evaluate(cdp, 'Array.prototype.slice.call(document.querySelectorAll(".mv-dl-panel:not(.hidden) .mv-dl-more button")).map(function(b){return (b.textContent||"").trim();})');
    }
    async function waitFor(expr, timeoutMs, label) {
      const until = Date.now() + (timeoutMs || 15000);
      let last = null;
      while (Date.now() < until) {
        last = await evaluate(cdp, expr);
        if (last) return last;
        await sleep(200);
      }
      throw new Error('等待超时：' + (label || expr) + '（最后取值 ' + JSON.stringify(last) + '）');
    }

    await cdp.send('Page.navigate', { url: baseUrl + '#/download' });
    await sleep(1500);
    await waitFor('Boolean(document.querySelector("#content .card"))', 20000, '下载页挂载');
    await sleep(1200);

    const chipTexts = await evaluate(cdp, 'Array.prototype.slice.call(document.querySelectorAll(".mv-dl-tabs .chip")).map(function(c){return (c.textContent||"").trim();})');
    check('下载页有 5 个页签（搜索入库/收藏夹/排行榜/我的/下载任务）',
      Array.isArray(chipTexts) && chipTexts.length === 5 && chipTexts.indexOf('收藏夹') >= 0 && chipTexts.indexOf('排行榜') >= 0 && chipTexts.indexOf('我的') >= 0,
      JSON.stringify(chipTexts));
    check('每个页签面板都带 mv-dl-panel（卡片计数能限定在可见面板内）',
      (await evaluate(cdp, 'document.querySelectorAll(".mv-dl-panel").length')) === 5,
      '面板数=' + (await evaluate(cdp, 'document.querySelectorAll(".mv-dl-panel").length')));

    // ---- 收藏夹 ----
    check('点击「收藏夹」页签', (await clickByText('收藏夹')) === 'clicked', 'chip 命中');
    let favCards = 0;
    try {
      favCards = await waitFor(visibleCardsExpr(), 20000, '收藏夹卡片');
    } catch (e) {
      trace('收藏夹现场：' + await evaluate(cdp, '(function(){' +
        ' var s = (document.getElementById("content") || document.body).textContent || "";' +
        ' return ("错误块: " + (document.querySelector(".mv-dl-error") ? document.querySelector(".mv-dl-error").textContent.replace(/\\s+/g, " ") : "无") + " | 空态: " + (document.querySelector(".empty-title") ? document.querySelector(".empty-title").textContent : "无") + " | 正文节选: " + s.slice(0, 240)); })()'));
      throw e;
    }
    const firstScreenCards = await cardCount();
    check('收藏夹渲染出卡片', firstScreenCards > 0, '首屏卡片数=' + firstScreenCards);
    log('收藏夹诊断', JSON.stringify({
      cards: firstScreenCards,
      status: await evaluate(cdp, '(function(){ var e = document.querySelector(".mv-dl-fav-status"); return e ? e.textContent.trim() : "(无)"; })()'),
      moreButtons: await moreLabels(),
      upstream: fake.seen.filter(function (s) { return s.indexOf("/users/favourite") >= 0; })
    }));
    check('批量渲染生效：首屏 24 张（不是一次 append 30 张）', firstScreenCards === CARD_BATCH, '首屏=' + firstScreenCards + ' 实际返回 ' + PAGE_SIZE);
    const moreHit = await clickPanelBtnByText('加载更多');
    await sleep(600);
    const afterMore = await cardCount();
    check('点「加载更多」补出当前页剩余卡片（本地分批，24 → 30）', moreHit === 'clicked' && afterMore === PAGE_SIZE, '点击=' + moreHit + ' 之后=' + afterMore);
    /* 本页补完后按钮应变成「加载下一页」，且此时还没请求第 2 页（本地分批与服务端分页不混成一步）。 */
    const labelAfterMore = (await moreLabels())[0] || '';
    check('本地补完后按钮变成「加载下一页」，且尚未请求第 2 页',
      labelAfterMore.indexOf('加载下一页') >= 0 && !fake.seen.some(function (s) { return s.indexOf('/users/favourite') >= 0 && s.indexOf('page=2') >= 0; }),
      '按钮=' + JSON.stringify(labelAfterMore) + ' 上游=' + JSON.stringify(fake.seen.filter(function (s) { return s.indexOf('/users/favourite') >= 0; })));
    const morePageHit = await clickPanelBtnByText('加载下一页');
    await sleep(1500);
    const afterPage = await cardCount();
    check('再点「加载下一页」翻服务端第 2 页（42 张，不是被打回 24）', morePageHit === 'clicked' && afterPage === FAV_TOTAL, '点击=' + morePageHit + ' 之后=' + afterPage);
    const favStatus = await evaluate(cdp, '(function(){ var e = document.querySelector(".mv-dl-fav-status"); return e ? e.textContent.trim() : ""; })()');
    check('收藏夹有状态文案（已显示 N / 共 M）', /已显示/.test(String(favStatus)), String(favStatus));
    // 排序切换：换成「最早收藏」后仍在假上游命中 s=da
    await clickByText('最早收藏');
    await sleep(1500);
    const favAfterSort = await cardCount();
    check('切换排序后重新拉取并渲染（重置回首屏 ' + CARD_BATCH + ' 张）', favAfterSort === CARD_BATCH, 'da 排序后卡片数=' + favAfterSort);
    check('假上游收到 s=da 的收藏请求', fake.seen.some(function (s) { return s.indexOf('/users/favourite') >= 0 && s.indexOf('s=da') >= 0; }), fake.seen.filter(function (s) { return s.indexOf('/users/favourite') >= 0; }).slice(-3).join(' | '));
    log('排序诊断', JSON.stringify({
      cards: favAfterSort,
      status: await evaluate(cdp, '(function(){ var e = document.querySelector(".mv-dl-fav-status"); return e ? e.textContent.trim() : "(无)"; })()'),
      upstream: fake.seen.filter(function (s) { return s.indexOf("/users/favourite") >= 0; })
    }));

    // ---- 排行榜 ----
    check('点击「排行榜」页签', (await clickByText('排行榜')) === 'clicked', 'chip 命中');
    const rankCards = await waitFor(visibleCardsExpr(), 20000, '排行榜卡片');
    const rankFirst = await cardCount();
    check('排行榜渲染出卡片（可见面板内计数，不是收藏夹隐藏卡片）', rankFirst > 0, '首屏卡片数=' + rankFirst);
    check('排行榜也是批量渲染（首屏 24 张）', rankFirst === CARD_BATCH, '首屏=' + rankFirst + ' 上游返回 ' + RANK_TOTAL);
    check('排行榜卡片来自排行榜请求（榜单标题唯一）',
      (await evaluate(cdp, 'document.querySelectorAll(".mv-dl-panel:not(.hidden) .comic-title").length')) === rankFirst,
      '标题数=' + (await evaluate(cdp, 'document.querySelectorAll(".mv-dl-panel:not(.hidden) .comic-title").length')));
    check('排行榜状态文案显示共 ' + RANK_TOTAL + ' 部',
      (await evaluate(cdp, '(function(){ var e = document.querySelector(".mv-dl-rank-status"); return e ? e.textContent.trim() : ""; })()')).indexOf('共 ' + RANK_TOTAL) >= 0,
      await evaluate(cdp, '(function(){ var e = document.querySelector(".mv-dl-rank-status"); return e ? e.textContent.trim() : "(无)"; })()'));
    const rankMoreHit = await clickPanelBtnByText('加载更多');
    await sleep(600);
    const rankAfterMore = await cardCount();
    const rankMoreLeft = (await moreLabels()).length;
    check('排行榜点「加载更多」补到 ' + RANK_TOTAL + ' 张，然后按钮消失（只有一页）',
      rankMoreHit === 'clicked' && rankAfterMore === RANK_TOTAL && rankMoreLeft === 0,
      '点击=' + rankMoreHit + ' 卡片=' + rankAfterMore + ' 剩余按钮=' + rankMoreLeft);
    await clickByText('周榜');
    await sleep(1600);
    const rankWeek = await cardCount();
    check('切到「周榜」后重新拉取（tt=D7）',
      rankWeek === CARD_BATCH && fake.seen.some(function (s) { return s.indexOf('/comics/leaderboard') >= 0 && s.indexOf('tt=D7') >= 0; }),
      '卡片=' + rankWeek + ' | 上游请求=' + fake.seen.filter(function (s) { return s.indexOf('leaderboard') >= 0; }).join(' | '));
    log('周期诊断', JSON.stringify({
      cards: rankWeek,
      status: await evaluate(cdp, '(function(){ var e = document.querySelector(".mv-dl-rank-status"); return e ? e.textContent.trim() : "(无)"; })()'),
      upstream: fake.seen.filter(function (s) { return s.indexOf("leaderboard") >= 0; })
    }));

    // ---- 我的（已登录 → 退出 → 重新登录） ----
    check('点击「我的」页签', (await clickByText('我的')) === 'clicked', 'chip 命中');
    /* 隔离配置里带了 token（favorites / leaderboard 都要用它），所以进页签时就是**已登录**态：
       账号路由会拿这个 token 去上游校验，校验通过就直接显示资料卡。
       真正的「未登录」态放在下面点「退出登录」之后验证 —— 那时 token 才被清掉。 */
    const alreadyIn = await waitFor('Boolean(document.querySelector(".mv-dl-profile-name"))', 20000, '资料卡（配置带 token → 已登录）');
    log('账号诊断', JSON.stringify({
      loginForm: await evaluate(cdp, 'Boolean(document.querySelector(".mv-dl-login"))'),
      profileName: await evaluate(cdp, '(function(){ var e = document.querySelector(".mv-dl-profile-name"); return e ? e.textContent.trim() : ""; })()'),
      accountStatus: await evaluate(cdp, '(function(){ var e = document.querySelector(".mv-dl-account-status"); return e ? e.textContent.trim() : "(无)"; })()')
    }));
    check('配置里已有 token 时直接显示资料卡（不强制重新登录）', Boolean(alreadyIn), '找到 .mv-dl-profile-name');
    check('已登录时不再显示登录表单', (await evaluate(cdp, 'Boolean(document.querySelector(".mv-dl-login"))')) === false, '登录表单缺席');
    /* 资料明细表（.mv-dl-ledger）按现有设计是「按需拉取」：进页签只显示资料卡，
       点「重新获取」才会调 GET /api/download/profile 并把契约字段表铺出来。 */
    const reloadHit = await clickPanelBtnByText('重新获取');
    const ledger0 = await waitFor('(function(){ var e = document.querySelector(".mv-dl-ledger"); return e ? e.textContent.replace(/\s+/g," ").trim() : ""; })()', 15000, '资料明细（点重新获取后）');
    check('点「重新获取」后资料明细含等级 / 经验 / 邮箱（契约字段）', reloadHit === 'clicked' && /等级/.test(String(ledger0)) && /经验值/.test(String(ledger0)) && /check@example.com/.test(String(ledger0)), '点击=' + reloadHit + ' 明细=' + String(ledger0).slice(0, 200));
    const avatar = await evaluate(cdp, 'Boolean(document.querySelector(".mv-dl-avatar"))');
    check('资料卡显示头像位', Boolean(avatar), '找到 .mv-dl-avatar');
    check('假上游收到 /users/profile 请求（账号校验走真实上游链路）', fake.seen.some(function (s) { return s.indexOf('/users/profile') >= 0; }), fake.seen.filter(function (s) { return s.indexOf('profile') >= 0; }).join(' | '));

    // ---- 退出登录，回到真正的未登录态 ----
    const loggedOut = await evaluate(cdp, '(async function(){'
      + ' var b = Array.prototype.slice.call(document.querySelectorAll("button")).filter(function(x){return /退出登录/.test(x.textContent||"");})[0];'
      + ' if (!b) return "no-button"; b.click();'
      + ' await new Promise(function(r){setTimeout(r,400);});'
      + ' var ok = Array.prototype.slice.call(document.querySelectorAll(".modal-foot button")).filter(function(x){return /退出登录/.test(x.textContent||"");})[0];'
      + ' if (!ok) return "no-confirm"; ok.click(); return "confirmed"; })()');
    log('退出点击结果', String(loggedOut));
    const backToLogin = await waitFor('Boolean(document.querySelector(".mv-dl-login"))', 15000, '退出后回到登录表单');
    check('退出登录后回到未登录态（重新出现登录表单）', loggedOut === 'confirmed' && Boolean(backToLogin), '确认=' + loggedOut);
    const inputs = await evaluate(cdp, '(function(){ return Array.prototype.slice.call(document.querySelectorAll(".mv-dl-login input")).map(function(i){return i.type;}); })()');
    check('未登录时登录表单有邮箱与密码两个输入框', Array.isArray(inputs) && inputs.indexOf('password') >= 0 && inputs.length >= 2, JSON.stringify(inputs));

    // ---- 重新登录：这一条正是故障单里「登录后不显示资料卡」的回归断言 ----
    const loginOk = await evaluate(cdp, '(async function(){'
      + ' var ins = document.querySelectorAll(".mv-dl-login input");'
      + ' ins[0].value = "check@example.com";'
      + ' ins[1].value = "secret";'
      + ' var bs = Array.prototype.slice.call(document.querySelectorAll(".mv-dl-login button"));'
      + ' var hit = bs.filter(function(b){ return /登录/.test(b.textContent||""); })[0];'
      + ' if (!hit) return "no-button";'
      + ' hit.click();'
      + ' return "clicked"; })()');
    check('提交登录表单', loginOk === 'clicked', String(loginOk));
    await sleep(1800);
    /* 登录诊断：请求本身成没成、响应体、页面状态，一次全倒出来。
       （「登录请求失败 / state.account 没被设置 / loadProfile 没被调用」三选一，靠这段区分。） */
    const loginApi = apiResponses.filter(function (r) { return r.path.indexOf('/api/download/login') >= 0; });
    const loginAttempt = loginApi[loginApi.length - 1] || null;
    const loginDiagnosis = {
      request: loginAttempt || '(没捕获到登录请求)',
      responseBody: lastBody,
      loginFormStillThere: await evaluate(cdp, 'Boolean(document.querySelector(".mv-dl-login"))'),
      accountStatus: await evaluate(cdp, '(function(){ var e = document.querySelector(".mv-dl-account-status"); return e ? e.textContent.trim() : "(无)"; })()'),
      profileName: await evaluate(cdp, '(function(){ var e = document.querySelector(".mv-dl-profile-name"); return e ? e.textContent.trim() : ""; })()'),
      jsErrors: jsErrors.slice(0, 3)
    };
    log('登录诊断', JSON.stringify(loginDiagnosis));
    trace('登录诊断：' + JSON.stringify(loginDiagnosis));
    check('POST /api/download/login 返回 200 且响应体带 account',
      Boolean(loginAttempt && loginAttempt.status === 200 && String(lastBody || '').indexOf('"account"') >= 0),
      loginAttempt ? ('status=' + loginAttempt.status + ' body=' + String(lastBody).slice(0, 220)) : '没有捕获到登录请求');
    const profileName = await waitFor('(function(){ var e = document.querySelector(".mv-dl-profile-name"); return e ? e.textContent.trim() : ""; })()', 20000, '资料卡昵称');
    check('登录后显示资料（昵称来自 GET /api/download/profile）', String(profileName).indexOf('验收账号') >= 0, '昵称=' + profileName);
    log('重登录诊断', JSON.stringify({
      panelText: await evaluate(cdp, '(function(){ var p = document.querySelector(".mv-dl-panel:not(.hidden)"); return p ? p.textContent.slice(0, 300) : "(无面板)"; })()'),
      toasts: await evaluate(cdp, '(function(){ var t = document.getElementById("toasts"); return t ? t.textContent.slice(0, 200) : "(无)"; })()'),
      profileApi: apiResponses.filter(function (r) { return r.path.indexOf("/profile") >= 0; }),
      ledgerCount: await evaluate(cdp, 'document.querySelectorAll(".mv-dl-ledger").length'),
      bodies: apiBodies.filter(function (b) { return b.path.indexOf("profile") >= 0; }),
      profileTrace: await evaluate(cdp, 'window.__mvProfileTrace || []')
    }));
    /* 登录成功后前端会自己调 loadProfile()，明细表应该**不需要再点**就出现。 */
    const profileDetail = await waitFor('(function(){ var e = document.querySelector(".mv-dl-ledger"); return e ? e.textContent.replace(/\s+/g," ").trim() : ""; })()', 15000, '重新登录后的资料明细');
    check('重新登录后资料明细自动出现且完整（等级 / 经验 / 邮箱）', /等级/.test(String(profileDetail)) && /经验值/.test(String(profileDetail)) && /check@example.com/.test(String(profileDetail)), String(profileDetail).slice(0, 200));
    const profileHits = fake.seen.filter(function (s) { return s.indexOf('/users/profile') >= 0; }).length;
    check('重新登录后假上游再次收到 /users/profile 请求', profileHits >= 2, '上游 profile 请求数=' + profileHits);

    // ---- 可选：搜索页签 ----
    if (withSearch) {
      await clickByText('搜索入库');
      await sleep(300);
      await evaluate(cdp, '(function(){ var i = document.querySelector("#content .searchbox input"); i.value = "纯爱"; var k = new KeyboardEvent("keydown", { key: "Enter", bubbles: true }); i.dispatchEvent(k); return true; })()');
      const sCards = await waitFor(visibleCardsExpr(), 20000, '搜索卡片');
      check('搜索页签仍可用（复用同一卡片渲染器）', sCards > 0, '卡片数=' + sCards);
    }

    check('整个流程没有 JS 报错', jsErrors.length === 0, jsErrors.length ? jsErrors.join(' || ').slice(0, 600) : '无 console.error / 未捕获异常');
    check('假上游确实被访问过（证明是真实接口链路，不是假数据兜底）', fake.seen.length > 0, '共 ' + fake.seen.length + ' 次请求');
  } finally {
    if (cdp) cdp.close();
    if (browserProc) { try { browserProc.kill(); } catch (e) { /* ignore */ } }
    if (serverProc) { try { serverProc.kill(); } catch (e) { /* ignore */ } }
    try { fake.server.close(); } catch (e) { /* ignore */ }
    await sleep(400);
    if (!keep) { try { await fsp.rm(dir, { recursive: true, force: true }); } catch (e) { await sleep(600); try { await fsp.rm(dir, { recursive: true, force: true }); } catch (e2) { /* ignore */ } } }
    else log('保留', dir);
  }

  let failed = 0;
  console.log('');
  console.log('══ 下载中心页签真浏览器验证 ══');
  for (const r of results) {
    console.log((r.pass ? '  ✓ ' : '  ✗ ') + r.name + '  (' + r.detail + ')');
    if (!r.pass) failed++;
  }
  if (pageLogs.length) {
    console.log('');
    console.log('页面日志（最多 10 条）：');
    for (const l of pageLogs.slice(0, 10)) console.log('  · ' + l.slice(0, 200));
  }
  console.log('');
  console.log('结果: ' + (results.length - failed) + '/' + results.length + ' 通过');
  process.exitCode = failed ? 1 : 0;
}

main().catch(function (err) {
  console.error('[失败] ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err));
  const partial = globalThis.__mvResults || [];
  if (partial.length) {
    let bad = 0;
    console.error('--- 中断前已跑过的检查（' + partial.length + ' 项）---');
    for (const r of partial) {
      if (!r.pass) bad++;
      console.error((r.pass ? '  ✓ ' : '  ✗ ') + r.name + '  (' + r.detail + ')');
    }
    console.error('其中失败 ' + bad + ' 项');
  }
  /* 失败时同样把页面日志倒出来：超时类失败的证据全在页面里（DBG / console.error）。 */
  const pl = globalThis.__mvPageLogs || [];
  if (pl.length) {
    console.error('--- 页面日志（' + pl.length + ' 条，最多 40）---');
    /* 打印**最后** 40 条：最早的日志通常是页面首屏的 400 噪声，失败现场在后面。 */
    for (const l of pl.slice(-40)) console.error('  · ' + String(l).slice(0, 220));
  }
  const traces = globalThis.__mvDebugTrace || [];
  if (traces.length) {
    console.error('--- 失败现场 ---');
    for (const t of traces) console.error(t);
  }
  process.exitCode = 1;
});
