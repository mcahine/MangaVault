#!/usr/bin/env node
/**
 * 管理台新能力 · 真浏览器验收（headless Edge + 原始 CDP，零依赖）。
 *
 * 验证目标（用户投诉的「功能没做全」对应的 6 组能力，全部有真实 DOM 断言）：
 *   1) 管理台 7 个新页签真的渲染出来、点得动
 *   2) 批量选择：勾选 2 部漫画后计数变成「已选 2 部」
 *   3) 批量打标签：预演按钮真的调 /api/vault/tags/assign 且带 dryRun=true，界面列出「会新建标签」
 *   4) 批量元数据 / 跨库搬迁 / 孤儿清理 / 审计与撤销 面板都渲染出可交互控件
 *   5) 审计日志表格真的渲染出行（时间/动作/对象/结果列）
 *   6) 全流程零 JS 报错（Runtime.exceptionThrown + console.error）
 *
 * 隔离原则：使用【独立数据目录】+ 自带示例库根 + 随机端口拉起服务，
 * 绝不连开发中的 8775，也绝不触碰用户真实漫画目录。
 *
 * 用法：node scripts/dev/vault-admin-ui-check.mjs [--keep]
 * 退出码：0 全通过 / 1 有失败 / 2 环境缺少浏览器
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

const PROJECT = path.resolve(import.meta.dirname, '..', '..');

function findBrowser() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
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
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('非 JSON 响应: ' + body.slice(0, 120))); } });
    }).on('error', reject);
  });
}

/** 取一个空闲端口（自己 listen(0) 后立刻释放；绝不占用 8775） */
function freePort() {
  return new Promise(function (resolve, reject) {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', function () {
      const port = srv.address().port;
      srv.close(function () { resolve(port); });
    });
  });
}

function waitForServer(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  return new Promise(function (resolve, reject) {
    (function tick() {
      getJson('http://127.0.0.1:' + port + '/api/ping')
        .then(function () { resolve(true); })
        .catch(function () {
          if (Date.now() > until) return reject(new Error('服务未在 ' + timeoutMs + 'ms 内就绪'));
          setTimeout(tick, 300);
        });
    })();
  });
}

/* ---------- 极简 CDP 客户端（与 ui-scroll-check.mjs 同一手法，不引依赖） ---------- */
function cdpConnect(wsUrl) {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error('当前 Node 无内置 WebSocket（需 Node 22+）');
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
      setTimeout(function () { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 20000);
    });
  }
  return { ready: ready, send: send, on: function (fn) { listeners.push(fn); }, close: function () { try { ws.close(); } catch (e) {} } };
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面脚本异常: ' + (r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)));
  return r.result ? r.result.value : undefined;
}

/** 在页面里按 data-act 点击（前端所有可点控件都带 data-act） */
function clickExpr(act, index) {
  const i = index === undefined ? 0 : index;
  return "(function(){ var ns = document.querySelectorAll('[data-act=\"" + act + "\"]'); if (ns.length <= " + i + ") return 'not-found(' + ns.length + ')'; ns[" + i + "].click(); return 'clicked'; })()";
}

async function waitFor(fn, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(200);
  }
  throw new Error('等待超时：' + label);
}

async function main() {
  const browser = findBrowser();
  if (!browser) { console.error('[跳过] 未找到 Edge/Chrome，无法做真浏览器验证'); process.exit(2); }

  const box = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-vaultui-'));
  const dataDir = path.join(box, 'data');
  const rootA = path.join(box, '示例库A');
  const rootB = path.join(box, '示例库B');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(rootA, { recursive: true });
  await fsp.mkdir(rootB, { recursive: true });

  const HEAD = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const TAIL = Buffer.from([0xFF, 0xD9]);
  async function makeComic(root, dir, title, count) {
    const ch = path.join(root, dir, '1 第一话');
    await fsp.mkdir(ch, { recursive: true });
    await fsp.writeFile(path.join(root, dir, '元数据.json'), JSON.stringify({ id: 'ui-' + dir, title: title, author: '样例作者' }, null, 2), 'utf8');
    for (let i = 1; i <= count; i++) {
      await fsp.writeFile(path.join(ch, String(i).padStart(3, '0') + '.jpg'), Buffer.concat([HEAD, Buffer.alloc(700, i), TAIL]));
    }
  }
  await makeComic(rootA, '样例甲', '样例漫画甲', 2);
  await makeComic(rootA, '样例乙', '样例漫画乙', 2);
  await makeComic(rootA, '样例丙', '样例漫画丙', 2);
  await makeComic(rootB, '样例丁', '样例漫画丁', 2);

  const port = await freePort();
  console.log('[环境] 独立数据目录 ' + dataDir);
  console.log('[环境] 示例库根 ' + rootA + ' / ' + rootB);
  console.log('[环境] 服务端口 ' + port + '（不使用 8775）');

  /* 端口来自 data/config.json（server.mjs 没有 MV_PORT 支持，实测它直接忽略该变量）。
     先在独立数据目录里写一份配置：用临时端口、libraryRoots 显式置空，
     避免读到开发机配置里指向真实漫画目录的库根。 */
  await fsp.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    port: port,
    host: '127.0.0.1',
    logLevel: 'error',
    libraryRoot: '',
    libraryRoots: [],
    downloadRoot: '',
    dedupe: {}
  }, null, 2), 'utf8');

  const serverProc = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.mjs'), '--data-dir=' + dataDir], {
    cwd: PROJECT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      MV_DATA_DIR: dataDir
    })
  });
  let serverOut = '';
  serverProc.stdout.on('data', function (c) { serverOut += c; });
  serverProc.stderr.on('data', function (c) { serverOut += c; });

  let browserProc = null;
  const consoleErrors = [];
  const pageErrors = [];
  const results = [];
  function check(name, pass, detail) { results.push({ name: name, pass: Boolean(pass), detail: detail }); }

  try {
    await waitForServer(port, 40000);
    console.log('[准备] 服务已就绪（隔离数据目录，端口 ' + port + '）');

    /* 走真实的配置写接口把示例库根写进去（只影响本次独立数据目录） */
    const cfgPost = await fetch('http://127.0.0.1:' + port + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        libraryRoot: rootA,
        libraryRoots: [
          { id: 'uiA', name: '示例库A', path: rootA, enabled: true },
          { id: 'uiB', name: '示例库B', path: rootB, enabled: true }
        ]
      })
    });
    console.log('[准备] 写入库根：HTTP ' + cfgPost.status);
    const scan = await fetch('http://127.0.0.1:' + port + '/api/library/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const scanBody = await scan.json().catch(function () { return null; });
    console.log('[准备] 扫描启动：' + JSON.stringify(scanBody));
    await waitFor(async function () {
      const st = await (await fetch('http://127.0.0.1:' + port + '/api/library/state')).json();
      return st && st.scanning === false && st.scannedAt;
    }, 30000, '首次库扫描完成');
    const vstate = await (await fetch('http://127.0.0.1:' + port + '/api/vault/state')).json();
    console.log('[准备] 管理台看到的目录：' + vstate.catalog.comics + ' 部 / 库根 ' + vstate.roots.length + ' 个');

    /* 启动无头浏览器 */
    const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-vaultui-prof-'));
    const dbgPort = await freePort();
    browserProc = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=' + dbgPort,
      '--user-data-dir=' + userDataDir,
      'about:blank'
    ], { stdio: 'ignore', detached: false });

    let list = null;
    await waitFor(async function () {
      try { list = await getJson('http://127.0.0.1:' + dbgPort + '/json/list'); return Boolean(list && list.length); }
      catch (e) { return false; }
    }, 25000, '浏览器调试端口就绪');

    const page = list.find(function (t) { return t.type === 'page'; }) || list[0];
    const cdp = cdpConnect(page.webSocketDebuggerUrl);
    await cdp.ready;
    cdp.on(function (msg) {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params && msg.params.exceptionDetails;
        pageErrors.push(String((d && (d.text || (d.exception && d.exception.description))) || '未知异常'));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
        consoleErrors.push((msg.params.args || []).map(function (a) { return String(a.value || a.description || ''); }).join(' '));
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    const base = 'http://127.0.0.1:' + port + '/';

    /* ---------- 1. 打开管理台 ---------- */
    await cdp.send('Page.navigate', { url: base + '#/vault' });
    await sleep(2500);
    await waitFor(async function () { return (await evaluate(cdp, "document.querySelectorAll('.tab[data-tab]').length")) >= 11; }, 15000, '管理台页签渲染');
    const tabCount = await evaluate(cdp, "document.querySelectorAll('.tab[data-tab]').length");
    check('管理台渲染出 11 个页签', tabCount === 11, 'tabCount=' + tabCount);
    const title = await evaluate(cdp, "(document.querySelector('.page-title')||{}).textContent || ''");
    check('页面标题是「管理台」', /管理台/.test(title), 'title=' + title);

    /* ---------- 2. 标签墙 + 批量选择 ---------- */
    await waitFor(async function () { return (await evaluate(cdp, "document.querySelectorAll('[data-act=\"pick-comic\"]').length")) > 0; }, 15000, '标签墙漫画清单渲染');
    const pickCount = await evaluate(cdp, "document.querySelectorAll('[data-act=\"pick-comic\"]').length");
    check('标签墙列出可勾选的漫画', pickCount >= 3, '可勾选项=' + pickCount);
    await evaluate(cdp, clickExpr('pick-comic', 0));
    await evaluate(cdp, clickExpr('pick-comic', 1));
    await sleep(300);
    const selText = await evaluate(cdp, "(document.querySelector('[data-act=\"pick-count\"]')||{}).textContent || ''");
    check('勾选 2 部后计数变成「已选 2 部」', /已选\s*2\s*部/.test(selText), '计数文案=' + selText);
    const checked = await evaluate(cdp, "document.querySelectorAll('[data-act=\"pick-comic\"].checkbox.on').length");
    check('勾选态真的画在复选框中', checked === 2, 'on 复选框=' + checked);

    /* ---------- 3. 批量打标签：预演走 dryRun ---------- */
    const hasAddInput = await evaluate(cdp, "!!document.querySelector('[data-act=\"tag-add-input\"]')");
    check('标签墙有批量加标签输入框', hasAddInput === true, 'tag-add-input=' + hasAddInput);
    await evaluate(cdp, "(function(){ var i = document.querySelector('[data-act=\"tag-add-input\"]'); i.value = 'CDP预演标签'; return i.value; })()");
    await evaluate(cdp, "(function(){ var i = document.querySelector('[data-act=\"tag-remove-input\"]'); i.value = '要移除的标签'; return i.value; })()");
    await evaluate(cdp, clickExpr('tag-plan'));
    await waitFor(async function () {
      const t = await evaluate(cdp, "(document.querySelector('[data-act=\"tag-plan-out\"]')||{}).innerText || ''");
      return /命中漫画/.test(t);
    }, 20000, '标签预演结果渲染（命中漫画）');
    const tagOut = await evaluate(cdp, "(document.querySelector('[data-act=\"tag-plan-out\"]')||{}).innerText || ''");
    check('预演面板列出「会新建标签」', /CDP预演标签/.test(tagOut), '预演文本=' + tagOut.replace(/\s+/g, ' ').slice(0, 160));
    check('预演面板显示命中漫画数', /命中漫画/.test(tagOut), '含「命中漫画」=' + /命中漫画/.test(tagOut));
    const hasApplyBtn = await evaluate(cdp, "!!document.querySelector('[data-act=\"tag-apply-plan\"]')");
    check('预演后出现「确认执行」按钮（二次确认入口）', hasApplyBtn === true, 'tag-apply-plan=' + hasApplyBtn);

    /* ---------- 4. 批量元数据页签 ---------- */
    await evaluate(cdp, clickExpr('vault-tab', 1));
    await sleep(900);
    await waitFor(async function () { return (await evaluate(cdp, "document.querySelectorAll('[data-act=\"meta-author\"]').length")) > 0; }, 15000, '批量元数据面板渲染');
    check('批量元数据面板渲染出作者输入框', true, 'meta-author 存在');
    check('批量元数据面板有预演按钮', (await evaluate(cdp, "!!document.querySelector('[data-act=\"meta-plan\"]')")) === true, 'meta-plan');
    check('批量元数据面板有导出/导入控件', (await evaluate(cdp, "!!document.querySelector('[data-act=\"meta-export-all\"]') && !!document.querySelector('[data-act=\"meta-import-file\"]')")) === true, 'export+import');
    const metaPicked = await evaluate(cdp, "document.querySelectorAll('[data-act=\"pick-comic\"].checkbox.on').length");
    check('选择在页签之间共享（勾选态保持）', metaPicked === 2, '保持勾选=' + metaPicked);
    await evaluate(cdp, "(function(){ var i = document.querySelector('[data-act=\"meta-author\"]'); i.value = 'CDP 作者'; return i.value; })()");
    await evaluate(cdp, clickExpr('meta-plan'));
    await waitFor(async function () {
      const stat = await evaluate(cdp, "(document.querySelector('[data-act=\"meta-plan-out\"] .stat-row')||{}).innerText || ''");
      return /将修改/.test(stat);
    }, 20000, '元数据预演结果渲染（统计行）');
    const metaOut = await evaluate(cdp, "(document.querySelector('[data-act=\"meta-plan-out\"]')||{}).innerText || ''");
    check('元数据预演列出将修改的漫画与字段差异', /将修改/.test(metaOut) && /作者/.test(metaOut), '预演文本=' + metaOut.replace(/\s+/g, ' ').slice(0, 160));

    /* ---------- 5. 跨库搬迁页签 ---------- */
    await evaluate(cdp, clickExpr('vault-tab', 2));
    await sleep(900);
    await waitFor(async function () { return (await evaluate(cdp, "!!document.querySelector('[data-act=\"move-target\"]')")); }, 15000, '搬迁面板渲染');
    const moveOpts = await evaluate(cdp, "document.querySelectorAll('[data-act=\"move-target\"] option').length");
    check('搬迁面板列出可选目标库根', moveOpts >= 2, '目标库根选项=' + moveOpts);
    if (moveOpts < 2) console.log('[提示] 目标库根只有 ' + moveOpts + ' 个：配置写接口没把示例库B 写进本次运行配置');
    check('搬迁面板有重名策略选择', (await evaluate(cdp, "!!document.querySelector('[data-act=\"move-collision\"]')")) === true, 'move-collision');
    await evaluate(cdp, clickExpr('move-plan'));
    /* move-out 容器在「正在预演搬迁…」阶段就已存在，只等容器出现会抢跑；
       这里等真正的结果元素：统计行 + 目标路径台账行。 */
    await waitFor(async function () {
      const stat = await evaluate(cdp, "(document.querySelector('[data-act=\"move-out\"] .stat-row')||{}).innerText || ''");
      const ledger = await evaluate(cdp, "(document.querySelector('[data-act=\"move-out\"] .ledger')||{}).innerText || ''");
      return /将搬迁/.test(stat) && /目标路径/.test(ledger);
    }, 20000, '搬迁预演结果渲染（统计行 + 目标路径）');
    const moveOut = await evaluate(cdp, "(document.querySelector('[data-act=\"move-out\"]')||{}).innerText || ''");
    check('搬迁预演显示目标路径与统计', /目标路径/.test(moveOut) && /将搬迁/.test(moveOut), '预演文本=' + moveOut.replace(/\s+/g, ' ').slice(0, 160));

    /* ---------- 6. 孤儿清理页签 ---------- */
    await evaluate(cdp, clickExpr('vault-tab', 3));
    await sleep(900);
    await waitFor(async function () { return (await evaluate(cdp, "!!document.querySelector('[data-act=\"orphan-scan\"]')")); }, 15000, '孤儿清理面板渲染');
    check('孤儿清理面板有扫描（=预演）与清理按钮', (await evaluate(cdp, "!!document.querySelector('[data-act=\"orphan-scan\"]') && !!document.querySelector('[data-act=\"orphan-clean\"]')")) === true, 'scan+clean');
    const partsCount = await evaluate(cdp, "document.querySelectorAll('[data-act^=\"orphan-part-\"]').length");
    check('孤儿清理可按三类分别选择范围', partsCount === 3, '范围开关=' + partsCount);
    await evaluate(cdp, clickExpr('orphan-scan'));
    await waitFor(async function () {
      const t = await evaluate(cdp, "(document.querySelector('[data-act=\"orphan-out\"]')||{}).innerText || ''");
      return /磁盘孤立|可清理合计/.test(t);
    }, 20000, '孤儿扫描结果渲染');
    const orphOut = await evaluate(cdp, "(document.querySelector('[data-act=\"orphan-out\"]')||{}).innerText || ''");
    check('孤儿扫描结果给出三类计数', /磁盘孤立/.test(orphOut) && /幽灵条目/.test(orphOut) && /回收站失联/.test(orphOut), '扫描文本=' + orphOut.replace(/\s+/g, ' ').slice(0, 160));

    /* ---------- 6.5 真做一次可撤销写操作 + 一次预演，让审计面板有真实数据 ---------- */
    const tagApply = await fetch('http://127.0.0.1:' + port + '/api/vault/tags/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comicIds: ['ui-样例甲'], add: ['CDP实测标签'], note: '真浏览器验收写入' })
    });
    const tagApplyBody = await tagApply.json().catch(function () { return null; });
    console.log('[准备] 批量打标签写入：HTTP ' + tagApply.status + ' ' + JSON.stringify(tagApplyBody && tagApplyBody.message));
    const tagPreview = await fetch('http://127.0.0.1:' + port + '/api/vault/tags/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comicIds: ['ui-样例甲'], add: ['CDP仅预演'], dryRun: true })
    });
    const tagPreviewBody = await tagPreview.json().catch(function () { return null; });
    console.log('[准备] 批量打标签预演：HTTP ' + tagPreview.status + ' ' + JSON.stringify(tagPreviewBody && tagPreviewBody.message));

    /* ---------- 7. 审计与撤销面板 ---------- */
    await evaluate(cdp, clickExpr('vault-tab', 4));
    await sleep(900);
    await waitFor(async function () { return (await evaluate(cdp, "!!document.querySelector('[data-act=\"audit-list\"]')")); }, 15000, '审计表格渲染');
    check('审计面板渲染出可撤销面板', (await evaluate(cdp, "!!document.querySelector('[data-act=\"audit-undoable\"]')")) === true, 'audit-undoable');
    check('审计面板有动作筛选与刷新', (await evaluate(cdp, "!!document.querySelector('[data-act=\"audit-action-filter\"]') && !!document.querySelector('[data-act=\"audit-refresh\"]')")) === true, 'filter+refresh');
    const headers = await evaluate(cdp, "Array.prototype.map.call(document.querySelectorAll('[data-act=\"audit-list\"] thead th'), function (t) { return t.textContent; }).join('/')");
    check('审计表格表头含 时间/动作/对象/结果', /时间/.test(headers) && /动作/.test(headers) && /对象/.test(headers) && /结果/.test(headers), '表头=' + headers);
    const rowCount = await evaluate(cdp, "document.querySelectorAll('[data-act=\"audit-list\"] tbody tr').length");
    check('审计表格渲染出真实写入行', rowCount >= 1, '行数=' + rowCount);
    check('预演不落审计（1 次写入 + 1 次预演 → 恰好 1 条）', rowCount === 1, '行数=' + rowCount + '，预演 HTTP ' + tagPreview.status);
    const undoBoxText = await evaluate(cdp, "(document.querySelector('[data-act=\"audit-undoable\"]')||{}).innerText || ''");
    check('可撤销面板显示动作或空态说明', /动作|没有可撤销/.test(undoBoxText), '面板文本=' + undoBoxText.replace(/\s+/g, ' ').slice(0, 140));

    /* ---------- 8. 零 JS 报错 ---------- */
    check('页面无未捕获异常（Runtime.exceptionThrown）', pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '无');
    check('页面无 console.error', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '无');

    let failed = 0;
    console.log('');
    console.log('══ 管理台真浏览器断言（headless Edge + CDP） ══');
    for (const r of results) {
      console.log((r.pass ? '  ✓ ' : '  ✗ ') + r.name + '  (' + r.detail + ')');
      if (!r.pass) failed++;
    }
    console.log('');
    console.log('结果: ' + (results.length - failed) + '/' + results.length + ' 通过');
    process.exitCode = failed ? 1 : 0;
    if (!arg('keep', '')) cdp.close();
  } catch (err) {
    console.error('[失败] ' + (err && err.message));
    if (serverOut) console.error('--- 服务端输出 ---\n' + serverOut.slice(-2500));
    process.exitCode = 1;
  } finally {
    if (browserProc) { try { browserProc.kill(); } catch (e) { /* 已退出 */ } }
    if (serverProc) { try { serverProc.kill(); } catch (e) { /* 已退出 */ } }
    await sleep(300);
    await fsp.rm(box, { recursive: true, force: true }).catch(function () {});
  }
}

main().catch(function (err) {
  console.error('[失败] ' + (err && err.message));
  process.exit(1);
});
