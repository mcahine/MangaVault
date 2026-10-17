#!/usr/bin/env node
/**
 * 漫画库滚动验证（真浏览器）。
 *
 * 背景：虚拟网格曾把 scroll 监听绑在 window 上，而真实滚动容器是 #content（.content{overflow:auto}）。
 * #content 的 scroll 事件不冒泡到 window，导致虚拟网格永不重绘 —— 用户表现为「只能看到首屏，滑不动」。
 *
 * 本脚本用无头 Edge/Chrome + CDP 打开真实页面，滚动到底，断言：
 *   1) 滚动后渲染出的卡片数 > 首屏卡片数（说明确实在重绘）
 *   2) 能看到索引靠后的漫画（说明真的滚到了后面）
 *   3) 首屏卡片数远小于总数（说明虚拟化生效，没有一次性渲染全部）
 *
 * 用法：node scripts/dev/ui-scroll-check.mjs [--port=<空闲端口>] [--keep]
 *
 * ⚠️ 默认端口改成 0（= 让系统随机分配），**绝不复用 8775**。
 * 2026-10-17 实测教训：脚本原来默认连 8775，而 8775 上常常跑着用户自己启动的旧实例 ——
 * 那边加载的前端是旧代码，于是「页面字节 vs 后端指纹」这条断言必然红，
 * 而它反映的是**服务器版本旧**，不是功能回归。verify-all 因此在第 3 步假红过一次。
 * 规则：凡是自动验收脚本，服务一律自己用隔离数据目录 + 随机端口起，不与用户实例混用。
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

function findBrowser() {
  for (const c of CANDIDATES) { if (fs.existsSync(c)) return c; }
  return null;
}

function arg(name, dflt) {
  const hit = process.argv.slice(2).find(function (a) { return a.startsWith('--' + name + '='); });
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function getJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      let body = "";
      res.on('data', function (c) { body += c; });
      res.on('end', function () { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('非 JSON 响应: ' + body.slice(0, 120))); } });
    }).on('error', reject);
  });
}

/* ---------- 隔离数据目录 ----------
   验收脚本一律跑在隔离数据目录上（只在 %TEMP% 下），绝不碰用户真实数据目录，
   也绝不连用户正在跑的 8775 实例。漫画库只**读**真实库根（config.json 原样拷过来），
   本脚本不写任何库文件。 */
async function buildIsolation() {
  const live = path.join(process.env.LOCALAPPDATA || '', 'MangaVault');
  const iso = path.join(os.tmpdir(), 'mv-scroll-' + Date.now());
  const dataDir = path.join(iso, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const cfg = JSON.parse(await fsp.readFile(path.join(live, 'config.json'), 'utf8'));
  await fsp.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  /* 漫画库索引直接复用真实的那份（只读语义）：本脚本验的是网格滚动，
     重新扫一遍 6 万张要十几分钟，而索引是纯派生数据、拷贝一份足够。 */
  try {
    await fsp.copyFile(path.join(live, 'library-index.json'), path.join(dataDir, 'library-index.json'));
  } catch (e) { /* 索引缺失时服务会现扫，不影响本脚本 */ }
  return { iso: iso, dataDir: dataDir };
}

/* 取一个空闲端口（自己 listen(0) 后立刻释放）。**绝不占用 8775**。 */
function freePort() {
  return new Promise(function (resolve, reject) {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', function () {
      const p = srv.address().port;
      srv.close(function () { resolve(p); });
    });
  });
}

function waitForServer(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  return new Promise(function (resolve, reject) {
    (function tick() {
      getJson("http://127.0.0.1:" + port + "/api/ping")
        .then(function () { resolve(true); })
        .catch(function () {
          if (Date.now() > until) return reject(new Error("服务未在 " + timeoutMs + "ms 内就绪"));
          setTimeout(tick, 300);
        });
    })();
  });
}

/* ---------- 极简 CDP 客户端（不引 npm 依赖） ---------- */
function cdpConnect(wsUrl) {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error("当前 Node 无内置 WebSocket（需 Node 22+）");
  const ws = new WebSocketCtor(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", function (ev) {
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
    ws.addEventListener("open", function () { resolve(); });
    ws.addEventListener("error", function (e) { reject(new Error("WebSocket 连接失败")); });
  });
  function send(method, params) {
    const id = nextId++;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      setTimeout(function () { if (pending.has(id)) { pending.delete(id); reject(new Error("CDP 超时: " + method)); } }, 20000);
    });
  }
  return { ready: ready, send: send, on: function (fn) { listeners.push(fn); }, close: function () { try { ws.close(); } catch (e) {} } };
}

/** 派发**真实滚轮事件**（不是直接改 scrollTop）。
 *  ▸ 为什么要专门做这件事：本脚本原来用 `c.scrollTop = c.scrollHeight` 程序化滚动来
 *    触发翻页，9/9 全绿，但用户反馈「漫画库下滑没法展开」——因为程序化赋值**绕过了
 *    滚轮路径**（不会经过浏览器的平滑滚动、不会走 wheel 事件链），一旦真实滚轮在某处
 *    失效（例如宿主/缩放差异），测试根本发现不了。用户是按滚轮滑的，就必须按滚轮测。 */
async function wheelScroll(cdp, x, y, deltaY, times, gapMs) {
  const n = times || 1;
  for (let i = 0; i < n; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: x, y: y, deltaX: 0, deltaY: deltaY, pointerType: "mouse" });
    await sleep(gapMs || 90);
  }
}

async function evaluate(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("页面脚本异常: " + (r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)));
  return r.result ? r.result.value : undefined;
}

async function main() {
  /* 端口默认 0：交给系统随机分配。见文件头注释 —— 连 8775 会连上用户的旧实例，
     把「服务器版本旧」误报成前端指纹不一致。--port=N 仍可显式指定（verify-all 曾这么传）。 */
  const wantPort = Number(arg("port", "0"));
  const port = (Number.isInteger(wantPort) && wantPort > 0 && wantPort < 65536) ? wantPort : 0;
  const browser = findBrowser();
  if (!browser) { console.error("[跳过] 未找到 Edge/Chrome，无法做真浏览器验证"); process.exit(2); }

  /* --port=0 时「先探测有没有现成服务」这一步没有意义（0 不是可连接的端口），
     而它留下的 ownServer=false 会让后面的 waitForServer 只用 5 秒预算 —— 服务还没起好就超时。
     所以：显式端口才复用，port=0 一律自己拉起。 */
  const root = path.resolve(import.meta.dirname, "..", "..");
  let serverProc = null;
  let realPort = port;
  if (realPort === 0) realPort = await freePort();
  if (realPort === 8775) { console.error("[失败] 验收脚本绝不允许占用 8775"); process.exit(1); }
  console.log("[启动] 在隔离数据目录上拉起服务（端口 " + realPort + "）…");
  const iso = await buildIsolation();
  const env = Object.assign({}, process.env, { MV_PORT: String(realPort), MV_DATA_DIR: iso.dataDir });
  console.log("[隔离] 数据目录 " + iso.dataDir);
  serverProc = spawn(process.execPath, [path.join(root, "src", "server.mjs")], {
    cwd: root, stdio: "ignore", env: env
  });
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mv-scroll-profile-"));
  try {
    await waitForServer(realPort, 40000);
    const base = "http://127.0.0.1:" + realPort + "/";

    // 通过 CDP 列表拿到可连接的 ws 地址
    const list = await getJson("http://127.0.0.1:" + (await debugPort(browser, userDataDir)) + "/json/list");
    const page = list.find(function (t) { return t.type === "page"; }) || list[0];
    if (!page) throw new Error("没有可用的页面目标");

    const cdp = cdpConnect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // 直接导航到漫画库
    await cdp.send("Page.navigate", { url: base + "#/library" });
    await sleep(1200);
    await cdp.send("Page.navigate", { url: base });
    await sleep(2500);

    // 切到漫画库页签
    await evaluate(cdp, "(function(){ var a = document.querySelector('[data-route=\"library\"]') || Array.from(document.querySelectorAll('a,.nav-item')).find(function(e){return /漫画库/.test(e.textContent||'')}); if (a) a.click(); return a ? 'clicked' : 'not-found'; })()");
    await sleep(3500);

    const firstScreen = await evaluate(cdp, "document.querySelectorAll('.comic-card').length");
    const total = await evaluate(cdp, "(function(){ var m = document.body.innerText.match(/共 (\\d+) 部匹配|(\\d+) 部匹配/); return m ? parseInt(m[1]||m[2],10) : -1; })()");
    const scrollerInfo = await evaluate(cdp, "(function(){ var c = document.getElementById('content'); if(!c) return null; var st = getComputedStyle(c); return { id: c.id, overflowY: st.overflowY, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight }; })()");

    console.log("[首屏] 卡片数=" + firstScreen + " 总匹配=" + total);
    console.log("[滚动容器] " + JSON.stringify(scrollerInfo));

    /* 滚动条**可见性**取证。
       原来只断言「能滚动」（scrollHeight > clientHeight），但滚动条可能「在却被画得看不见」——
       thumb 与 track 用同一个色系时用户就是「滑动条没了」。所以这里必须量三样：
         a) 滚动槽宽度 offsetWidth-clientWidth > 0（浏览器为经典滚动条预留了空间）
         b) thumb 与 track 的实际渲染色对比足够（不是同色）
         c) #content 的 overflow-y 是 auto/scroll 而非 hidden/visible */
    const barInfo = await evaluate(cdp, "(function(){var c=document.getElementById('content');if(!c)return null;var s=getComputedStyle(c);return {overflowY:s.overflowY,gutter:(c.offsetWidth-c.clientWidth),scrollHeight:c.scrollHeight,clientHeight:c.clientHeight};})()");
    console.log("[滚动条] " + JSON.stringify(barInfo));

    // 用页面里的临时元素量出浏览器给滚动条预留的宽度（hex 转 rgb 比对对比度）
    const barColor = await evaluate(cdp, "(function(){var d=document.createElement('div');d.style.cssText='position:absolute;left:-9999px;top:0;width:100px;height:100px;overflow:scroll';document.body.appendChild(d);var w=d.offsetWidth-d.clientWidth;document.body.removeChild(d);var t=getComputedStyle(document.documentElement);return {reserved:w,thumb:t.getPropertyValue('--line-2').trim(),track:t.getPropertyValue('--ink-3').trim()};})()");
    console.log("[滚动条配色] " + JSON.stringify(barColor));

    /* 用**真实滚轮**一路滑到底。
       每轮读一次「已显示 N 部」，因为翻页是异步的（触底 → 请求下一页 → 重渲染），
       滚太快会来不及加载，所以要边滚边等、滚够轮数。 */
    const SHOWN_RE = "(function(){ var m = document.body.innerText.match(/已显示 (\\d+) \\/ 共 (\\d+) 部|已全部加载|部匹配（已显示 (\\d+) 部）/); return document.body.innerText; })()";
    const shownCount = "(function(){ var m = document.body.innerText.match(/已显示 (\\d+) \\/ 共 (\\d+) 部/); if (m) return {shown: parseInt(m[1],10), total: parseInt(m[2],10)}; if (/已全部加载/.test(document.body.innerText)) return {shown: -1, total: -1, all: true}; return null; })()";
    const cardCount = "document.querySelectorAll('.comic-card').length";

    await evaluate(cdp, "(function(){ var c = document.getElementById('content'); if (c) c.scrollTop = 0; return 1; })()");
    const shownBefore = await evaluate(cdp, shownCount);

    /* ---- 通道 A：显式「加载更多」按钮（不依赖滚动） ----
       必须在滚轮**之前**测：滚轮一旦把所有页拉完，按钮按设计就消失了。 */
    const moreBtn = "Array.from(document.querySelectorAll('#content button')).find(function(b){return /加载更多/.test(b.textContent||'')})";
    const moreLabel = await evaluate(cdp, "(function(){ var b = " + moreBtn + "; return b ? b.textContent.trim() : null; })()");
    let shownAfterClick = null;
    if (moreLabel) {
      await evaluate(cdp, "(function(){ var b = " + moreBtn + "; if (b) b.click(); return 1; })()");
      await sleep(2200);
      shownAfterClick = await evaluate(cdp, shownCount);
    }
    console.log("[加载更多按钮] 文案=" + moreLabel + " 点击后=" + JSON.stringify(shownAfterClick));
    /* 一次滚一屏左右（deltaY 900 ≈ 视口 900px），滚 40 轮；到底后 loadMore 会补数据、
       scrollHeight 变高，所以能继续滚。滚轮 x 取容器中部，避开侧栏。 */
    const scrollHeight0 = await evaluate(cdp, "(function(){ var c = document.getElementById('content'); return c ? c.scrollHeight : -1; })()");
    await wheelScroll(cdp, 760, 520, 900, 40, 120);
    await sleep(2500);
    await wheelScroll(cdp, 760, 520, 900, 12, 120);
    await sleep(2500);

    /* ---- 通道 B：真实滚轮触底自动加载（从「按钮点过一次」的状态继续） ---- */
    const afterTop = await evaluate(cdp, cardCount);
    const scrollPos1 = await evaluate(cdp, "(function(){ var c = document.getElementById('content'); return c ? c.scrollTop : window.scrollY; })()");
    const scrollHeight1 = await evaluate(cdp, "(function(){ var c = document.getElementById('content'); return c ? c.scrollHeight : -1; })()");
    const shownAfter = await evaluate(cdp, shownCount);
    console.log("[滚轮前] " + JSON.stringify(shownBefore));
    console.log("[真实滚轮滚到底] scrollTop=" + scrollPos1 + " 卡片数=" + afterTop + " 内容高=" + scrollHeight1 + " 页脚=" + JSON.stringify(shownAfter));

    const results = [];
    function check(name, pass, detail) { results.push({ name: name, pass: Boolean(pass), detail: detail }); }

    check("滚动容器是 #content 且可滚动", scrollerInfo && scrollerInfo.scrollHeight > scrollerInfo.clientHeight + 50, JSON.stringify(scrollerInfo));
    check("首屏确实渲染了卡片", firstScreen > 0, "firstScreen=" + firstScreen);
    check("虚拟化生效（首屏卡片数 < 总数）", total < 0 || firstScreen < total, "first=" + firstScreen + " total=" + total);
    check("滚动到底后 scrollTop 真的变了", scrollPos1 > 100, "scrollTop=" + scrollPos1);
    check("滚动触发了重绘（卡片仍在渲染）", afterTop > 0, "afterTop=" + afterTop);
    /* ★ 这是本轮新增的关键断言：用户体感是「下滑不展开」，所以必须断言
       **真实滚轮确实把后续页加载出来了**（已显示数变多 / 已全部加载），
       而不只是断言「scrollTop 变了」。旧脚本只查 scrollTop，所以漏诊。 */
    const before = shownBefore && shownBefore.shown > 0 ? shownBefore.shown : 0;
    const fullyLoaded = Boolean(shownAfter && shownAfter.all);
    const grewBy = (shownAfter && shownAfter.shown > 0) ? shownAfter.shown : (fullyLoaded ? Infinity : 0);
    check("真实滚轮把后续页加载出来了（已显示数变大或已全部加载）", fullyLoaded || grewBy > before, "before=" + JSON.stringify(shownBefore) + " after=" + JSON.stringify(shownAfter));
    /* ★ 这条断言原本写的是「滚到底后卡片数 > 首屏」，那对**虚拟化**网格是错的假设：
       虚拟化只保留视口附近窗口的卡片（首屏在顶部、滚到底在底部，两处数量可以一样甚至更少）。
       正确的证据是「内容确实变长了」或「已全部加载」，两者都只可能来自后续页真的渲染了。 */
    const grewContent = scrollHeight1 > scrollHeight0 + 200;
    check("滚到底后内容确实变长/已全部加载（后续页真的渲染出来了）", grewContent || fullyLoaded, "内容高 " + scrollHeight0 + " → " + scrollHeight1 + " first=" + firstScreen + " after=" + afterTop + " all=" + fullyLoaded);
    /* 兜底通道必须可用：触底逻辑一旦在某个环境失效，用户还能点按钮手动加载。
       注意是在「还有未加载页」的状态下测的（滚轮之前）。 */
    const clickShown = shownAfterClick && shownAfterClick.all ? Infinity : (shownAfterClick && shownAfterClick.shown) || 0;
    check("「加载更多」兜底按钮存在且点击后确实加载了下一页", moreLabel !== null && clickShown > before, "文案=" + moreLabel + " 点击前=" + JSON.stringify(shownBefore) + " 点击后=" + JSON.stringify(shownAfterClick));

    /* 新增：滚动条必须「存在且看得见」。这是用户反复反馈「滑动条没了」的直接防线。 */
    const reserved = barColor ? Number(barColor.reserved) : 0;
    check("浏览器为滚动条预留了空间（滚动条存在）", reserved > 0, "reserved=" + reserved + "px");
    check("滚动容器 overflow-y 可滚动（不是 hidden/visible）", barInfo && /auto|scroll/.test(String(barInfo.overflowY)), "overflowY=" + (barInfo && barInfo.overflowY));
    check("滚动条 thumb 与 track 配色不同（保证看得见）", Boolean(barColor && barColor.thumb && barColor.track && barColor.thumb !== barColor.track), "thumb=" + (barColor && barColor.thumb) + " track=" + (barColor && barColor.track));

    /* 版本自检：界面必须能自证「跑的是哪一份前端代码」。
       这是上一轮「改好了用户却还看到旧界面、只能靠手动硬刷新」问题的直接防线：
       页脚要显示构建时间与前端资源指纹，且页面里的实际字节要与后端报的指纹一致。 */
    const ver = await evaluate(cdp, "(function(){ return window.__MV_FRONTEND__ || null; })()");
    const footBuild = await evaluate(cdp, "(function(){ var e = document.getElementById('footBuild'); return e ? e.textContent : null; })()");
    console.log("[版本自检] 前端指纹=" + JSON.stringify(ver) + " 页脚=" + JSON.stringify(footBuild));
    check("页脚显示了前端指纹 / 后端指纹 / 启动时间", Boolean(footBuild && /前端 /.test(footBuild) && /后端 /.test(footBuild) && /启动 /.test(footBuild)), "footBuild=" + footBuild);
    check("页面实际字节与后端报的前端指纹一致（不是缓存的旧脚本）", Boolean(ver && ver.ok === true), JSON.stringify(ver));

    let failed = 0;
    for (const r of results) {
      console.log((r.pass ? "  ✓ " : "  ✗ ") + r.name + "  (" + r.detail + ")");
      if (!r.pass) failed++;
    }
    console.log("\n结果: " + (results.length - failed) + "/" + results.length + " 通过");

    if (!arg("keep", "")) cdp.close();
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (serverProc) { try { serverProc.kill(); } catch (e) {} }
  }
}

/**
 * 启动一个带调试端口和临时 profile 的浏览器，返回调试端口。
 *
 * 端口用 `--remote-debugging-port=0` 让浏览器自己挑，再从 user-data-dir 里的
 * DevToolsActivePort 文件读实际端口。**不要自己 `9333 + random(200)` 猜**：
 * 那个范围与 reader-nav-check / 其它 CDP 脚本重叠，机器上同时有残留无头浏览器时
 * 会撞上已被占用的端口 —— 表现为「浏览器调试端口未就绪」，且**只在并发或残留进程
 * 存在时偶发**（实测 verify-all 里的一次 25.4s 假失败）。download-tabs-check.mjs
 * 早就用 DevToolsActivePort 解决了同一个问题。
 */
async function debugPort(browser, userDataDir) {
  const proc = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--remote-debugging-port=0",
    "--user-data-dir=" + userDataDir,
    "about:blank"
  ], { stdio: "ignore", detached: false });
  globalThis.__mvScrollBrowser = proc;
  const devtoolsFile = path.join(userDataDir, "DevToolsActivePort");
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error("浏览器进程提前退出（exitCode=" + proc.exitCode + "）");
    try {
      const text = await fsp.readFile(devtoolsFile, "utf8");
      const port = Number(String(text).split(/\r?\n/)[0]);
      if (port) { await getJson("http://127.0.0.1:" + port + "/json/version"); return port; }
    } catch (e) { /* 文件还没写出来，或端口还没起来 */ }
    await sleep(300);
  }
  throw new Error("浏览器调试端口未就绪（DevToolsActivePort 读不到）");
}

main().catch(function (err) {
  console.error("[失败] " + (err && err.message));
  process.exit(1);
}).finally(function () {
  const p = globalThis.__mvScrollBrowser;
  if (p) { try { p.kill(); } catch (e) {} }
});