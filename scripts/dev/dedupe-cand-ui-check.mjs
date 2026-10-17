#!/usr/bin/env node
/**
 * 查重「候选复核 -> 确认重复 -> 执行删除」全链路真浏览器验收。
 *
 * 为什么需要它：用户报过「在网页端执行删除没成功」和「删了还在候选页」。
 * 接口级测试能证明后端回写，但证明不了**用户在页面上点完之后列表真的少一张** ——
 * 这条链上前后端各有一段过滤/兜底逻辑，只有真实浏览器能把它们串起来。
 *
 * 安全性：全程在 %TEMP% 下的隔离数据目录里跑，dedupe.scanRoot 指向临时目录，
 * 待删的是本脚本自己造的 4 字节假图片，**绝不碰用户的真实漫画**。
 *
 * 用法：node scripts/dev/dedupe-cand-ui-check.mjs
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

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () { const p = s.address().port; s.close(function () { resolve(p); }); });
  });
}

function getJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('非 JSON 响应: ' + body.slice(0, 120))); } });
    }).on('error', reject);
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

/* ---------- 极简 CDP 客户端（不引 npm 依赖） ---------- */
function cdpConnect(wsUrl) {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error('当前 Node 无内置 WebSocket（需 Node 22+）');
  const ws = new WebSocketCtor(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', function (ev) {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
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
  return { ready: ready, send: send, close: function () { try { ws.close(); } catch (e) {} } };
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面脚本异常: ' + (r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)));
  return r.result ? r.result.value : undefined;
}

/* 端口交给浏览器自己挑（--remote-debugging-port=0），再从 user-data-dir 的
   DevToolsActivePort 读实际值。不许 `9433 + random(200)` 自己猜：那个范围与
   ui-scroll / reader-nav 等 CDP 脚本重叠，机器上有残留无头浏览器时会撞车，
   表现为偶发的「浏览器调试端口未就绪」。 */
async function debugPort(browser, userDataDir) {
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=0', '--user-data-dir=' + userDataDir, 'about:blank'
  ], { stdio: 'ignore', detached: false });
  globalThis.__mvCandBrowser = proc;
  const devtoolsFile = path.join(userDataDir, 'DevToolsActivePort');
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error('浏览器进程提前退出（exitCode=' + proc.exitCode + '）');
    try {
      const text = await fsp.readFile(devtoolsFile, 'utf8');
      const port = Number(String(text).split(/\r?\n/)[0]);
      if (port) { await getJson('http://127.0.0.1:' + port + '/json/version'); return port; }
    } catch (e) { /* 文件还没写出来，或端口还没起来 */ }
    await sleep(300);
  }
  throw new Error('浏览器调试端口未就绪（DevToolsActivePort 读不到）');
}

/* ---------- 隔离数据准备 ---------- */
async function buildIsolation() {
  const live = path.join(process.env.LOCALAPPDATA || '', 'MangaVault');
  const iso = path.join(os.tmpdir(), 'mv-cand-ui-' + Date.now());
  const dataDir = path.join(iso, 'data');
  const scanRoot = path.join(iso, 'dup');
  await fsp.mkdir(path.join(dataDir, 'dedupe'), { recursive: true });
  await fsp.mkdir(scanRoot, { recursive: true });

  const cfg = JSON.parse(await fsp.readFile(path.join(live, 'config.json'), 'utf8'));
  if (!cfg.dedupe) cfg.dedupe = {};
  cfg.dedupe.scanRoot = scanRoot;
  await fsp.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

  await fsp.copyFile(path.join(live, 'library-index.json'), path.join(dataDir, 'library-index.json'));

  const fast = JSON.parse(await fsp.readFile(path.join(live, 'dedupe', 'scan-fast.json'), 'utf8'));
  const real = (fast.units || []).slice(0, 2);
  if (!real.length) throw new Error('真实 scan-fast.json 里一个候选都没有，无法验收');
  // 真数据里的候选数会随用户的增删变化（用户把重复都删干净后就只剩 1 个，甚至 0 个）。
  // 这个脚本验的是「候选能标记、能删除、删完列表立刻少一个」的**交互链路**，
  // 不依赖真数据的条数——所以只有 1 个候选时，就地克隆一份到隔离目录里凑够两个
  // （真实数据一个字节都不动，隔离根是 %TEMP% 下的临时目录）。
  const picked = real.slice();
  if (picked.length === 1) {
    const clone = JSON.parse(JSON.stringify(real[0]));
    const seg = String(clone.id).split('/');
    seg[0] = seg[0] + '【验收副本】';
    clone.id = seg.join('/');
    clone.name = (clone.name || '') + '（副本）';
    picked.push(clone);
  }
  fast.units = picked;
  fast.查重 = Object.assign({}, fast.查重, { 单元数: picked.length });
  await fsp.writeFile(path.join(dataDir, 'dedupe', 'scan-fast.json'), JSON.stringify(fast, null, 2), 'utf8');

  const latest = { generatedAt: new Date().toISOString(), stage: 'pixel', 单元数: picked.length, units: picked };
  await fsp.writeFile(path.join(dataDir, 'dedupe', 'scan-latest.json'), JSON.stringify(latest, null, 2), 'utf8');
  await fsp.writeFile(path.join(dataDir, 'dedupe', 'decisions.json'), JSON.stringify({}, null, 2), 'utf8');

  const jpgHead = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
  for (const u of picked) {
    const dir = path.join(scanRoot, u.id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '00000001.jpg'), jpgHead);
  }
  return { iso: iso, dataDir: dataDir, scanRoot: scanRoot, picked: picked };
}

/* 断言结果提到模块级：main 的 finally 里也要能打印（中途 throw 时）。 */
const results = [];
function check(name, pass, detail) { results.push({ name: name, pass: Boolean(pass), detail: String(detail == null ? '' : detail) }); }

async function main() {
  const browser = findBrowser();
  if (!browser) { console.error('[跳过] 未找到 Edge/Chrome'); process.exit(2); }

  const env = await buildIsolation();
  const root = path.resolve(import.meta.dirname, '..', '..');
  const port = await freePort();
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-cand-profile-'));

  const serverProc = spawn(process.execPath, [path.join(root, 'src', 'server.mjs')], {
    cwd: root, stdio: 'ignore',
    env: Object.assign({}, process.env, { MV_PORT: String(port), MV_DATA_DIR: env.dataDir })
  });

  try {
    await waitForServer(port, 40000);
    const base = 'http://127.0.0.1:' + port + '/';
    const dport = await debugPort(browser, userDataDir);
    const list = await getJson('http://127.0.0.1:' + dport + '/json/list');
    const page = list.find(function (t) { return t.type === 'page'; }) || list[0];
    if (!page) throw new Error('没有可用的页面目标');
    const cdp = cdpConnect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: base });
    await sleep(3000);

    const nav = await evaluate(cdp, "(function(){var n=Array.from(document.querySelectorAll('.nav-item')).find(function(e){return e.dataset.id==='dedupe';});if(!n)return 'no-nav';n.click();return 'ok';})()");
    await sleep(2500);
    check('能进入查重页', nav === 'ok', 'nav=' + nav);

    const openCand = await evaluate(cdp, "(function(){var b=Array.from(document.querySelectorAll('button')).find(function(x){return (x.textContent||'').trim()==='候选复核';});if(!b)return 'no-btn';b.click();return 'ok';})()");
    check('点「候选复核」能展开面板', openCand === 'ok', 'open=' + openCand);

    const snap = "(function(){var yes=Array.from(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').trim()==='确认重复（可删）';});var titles=Array.from(document.querySelectorAll('.mv-card-title')).map(function(e){return e.textContent;});return {yes:yes.length,titles:titles};})()";

    /* 等条件成立，不等固定秒数。
       实测教训：这里原来写死 await sleep(2600) / sleep(4000)，机器忙时面板还没渲染完
       或删除还没落盘就取了快照，于是出现 yes:0（面板空）与 before=2 after=2（删除未完成）
       两种假红 —— 而同一脚本里更晚的「隔离目录里那个单元目录真的没了」却是通过的，
       两条断言自相矛盾即证明是时序问题。UI 断言测「最终会变成什么」，一律轮询到条件成立或超时。 */
    async function waitSnap(pred, timeoutMs, label) {
      const until = Date.now() + timeoutMs;
      let s = await evaluate(cdp, snap);
      while (!pred(s) && Date.now() < until) { await sleep(400); s = await evaluate(cdp, snap); }
      if (!pred(s)) console.log('  [超时] 等待「' + label + '」未满足，最后快照 ' + JSON.stringify(s));
      return s;
    }

    const before = await waitSnap(function (s) { return s && s.yes >= 2; }, 30000, '候选卡片渲染出来');
    check('候选页渲染出候选卡片', before && before.yes >= 2, JSON.stringify(before));
    if (!before || before.yes < 2) throw new Error('候选卡片没能渲染出来，后续断言无意义');

    // 目标单元必须从「被点的那个按钮所属的卡片」里取，不能假定它是 titles[0]：
    // 候选顺序会随后端返回顺序变化，取错目标会让最后一条断言假红。
    const cl = await evaluate(cdp, "(function(){var b=Array.from(document.querySelectorAll('button')).find(function(x){return (x.textContent||'').trim()==='确认重复（可删）';});if(!b)return {r:'no'};var card=b.closest('.mv-card')||b.parentElement;var t=card?card.querySelector('.mv-card-title'):null;var title=t?t.textContent:'';b.click();return {r:'ok',title:title};})()");
    const clicked = cl && cl.r;
    const target = (cl && cl.title) || (before.titles.length ? before.titles[0] : '');
    check('点「确认重复（可删）」能落盘决策', clicked === 'ok', 'clicked=' + clicked);

    const openDel = await evaluate(cdp, "(function(){var b=Array.from(document.querySelectorAll('button')).find(function(x){return (x.textContent||'').indexOf('执行删除')>=0;});if(!b)return 'no';b.click();return 'ok';})()");
    check('能打开「执行删除」弹窗', openDel === 'ok', 'open=' + openDel);

    /* 同样要轮询：openDelete() 是 async（它先 await 决策落盘再建弹窗），
       固定等 900ms 在机器忙时来不及，实测拿到 next=no（弹窗还没建出来）。 */
    const nextExpr = "(function(){var b=Array.from(document.querySelectorAll('.modal-mask button')).find(function(x){return (x.textContent||'').indexOf('下一步')>=0;});if(!b)return 'no';if(b.disabled)return 'disabled';b.click();return 'ok';})()";
    let next = await evaluate(cdp, nextExpr);
    {
      const until = Date.now() + 20000;
      while (next === 'no' && Date.now() < until) { await sleep(400); next = await evaluate(cdp, nextExpr); }
    }
    check('待删除弹窗里有可提交的单元（含刚标记的那一个）', next === 'ok', 'next=' + next);

    const typed = await evaluate(cdp, "(function(){var ms=document.querySelectorAll('.modal-mask');if(!ms.length)return 'no-modal';var m=ms[ms.length-1];var inp=m.querySelector('input.input');if(!inp)return 'no-input';inp.value='DELETE';var ok=Array.from(m.querySelectorAll('.modal-foot button')).find(function(x){return (x.textContent||'').trim()==='确定';});if(!ok)return 'no-ok';ok.click();return 'ok';})()");
    check('输入 DELETE 后能提交删除', typed === 'ok', 'typed=' + typed);

    /* 等到「最终状态」而不是「只要少了一张」：删除后前端会先清空候选区并显示
       「正在读取候选…」spinner，此时 yes=0 —— 用 `yes < before.yes` 作判据会
       立刻停在这个瞬态上（实测 after=0 的假红）。判据要同时满足张数正好少一
       且被删单元确实不在了。 */
    const after = await waitSnap(function (s) {
      return s && s.yes === before.yes - 1 && s.titles.indexOf(target) < 0;
    }, 30000, '候选卡片正好少一张且被删单元已消失');
    check('删除后候选列表立刻少一个（不再停留在删除前）', after && before && after.yes === before.yes - 1, 'before=' + before.yes + ' after=' + (after && after.yes));
    check('被删单元不再出现在候选页', Boolean(after) && after.titles.indexOf(target) < 0, 'target=' + target + ' titles=' + JSON.stringify(after && after.titles.slice(0, 4)));

    const onDisk = [];
    for (const u of env.picked) onDisk.push(fs.existsSync(path.join(env.scanRoot, u.id)));
    check('隔离目录里那个单元目录真的没了', onDisk.filter(function (x) { return x; }).length === env.picked.length - 1, '存在情况=' + JSON.stringify(onDisk));

    cdp.close();
  } finally {
    try { serverProc.kill(); } catch (e) {}
    printResults();
  }
}


/* 结果打印放在 finally 里：中途 throw（例如候选卡片压根没渲染出来）时也要把
   已收集的断言打出来，否则日志里只剩一行 [失败]，看不出卡在哪一步。 */
let printed = false;
function printResults() {
  if (printed) return;
  printed = true;
  let failed = 0;
  for (const r of results) {
    console.log((r.pass ? '  ✓ ' : '  ✗ ') + r.name + '  (' + r.detail + ')');
    if (!r.pass) failed++;
  }
  console.log('');
  console.log('合计: ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败');
  process.exitCode = failed ? 1 : 0;
}

main().catch(function (err) {
  console.error('[失败] ' + (err && err.message));
  process.exit(1);
}).finally(function () {
  const p = globalThis.__mvCandBrowser;
  if (p) { try { p.kill(); } catch (e) {} }
});