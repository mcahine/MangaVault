// 漫库 MangaVault · 桌面端单测（全离线：不启动浏览器、不写注册表、不碰真实 data/）
// 跑法：node tests/run-tests.mjs desktop

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const name = '桌面端';

/* 把数据目录指到临时目录（必需在任何 config 读取之前设置） */
const TMP = path.join(os.tmpdir(), 'mv-desktop-test-' + process.pid);
process.env.MV_DATA_DIR = TMP;

const lib = await import('../desktop/lib.mjs');
const sys = await import('../desktop/sysinfo.mjs');
const dm = await import('../src/modules/desktop/index.mjs');
const bridgeMod = await import('../src/modules/desktop/bridge.mjs');
const guard = await import('../src/modules/desktop/guard.mjs');
const { createApp } = await import('../src/core/http.mjs');

/** 极简 HTTP 客户端（零依赖，只够本测试用） */
function request(port, method, p, body) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = require$http().request({
      host: '127.0.0.1', port: port, path: p, method: method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let httpMod = null;
function require$http() {
  if (!httpMod) throw new Error('http 模块未初始化');
  return httpMod;
}

const silentLog = { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, child: function () { return silentLog; } };

export default async function (t) {
  httpMod = await import('node:http');
  await fsp.mkdir(TMP, { recursive: true });

  /* ---------- 1. App 窗口参数拼装 ---------- */
  const winFile = path.join(TMP, 'desktop-window.json');
  const args = lib.buildAppArgs({
    url: 'http://127.0.0.1:8775/', width: 1440, height: 900, x: 240, y: 75,
    profileDir: path.join(TMP, 'desktop-profile'), extensionDir: path.join(root$(), 'desktop', 'shell')
  });
  t.ok(args[0] === '--app=http://127.0.0.1:8775/', '第一个参数是 --app=<url>');
  t.ok(args.indexOf('--window-size=1440,900') !== -1, '包含 --window-size=1440,900');
  t.ok(args.indexOf('--window-position=240,75') !== -1, '包含 --window-position=240,75');
  t.ok(args.some(function (a) { return a.startsWith('--user-data-dir=') && a.indexOf('desktop-profile') !== -1; }), '包含独立 user-data-dir');
  t.ok(args.indexOf('--no-first-run') !== -1 && args.indexOf('--no-default-browser-check') !== -1, '包含 --no-first-run / --no-default-browser-check');
  t.ok(args.indexOf('--load-extension=' + path.join(root$(), 'desktop', 'shell')) !== -1, '包含桌面外壳扩展目录');
  const shortArgs = lib.buildAppArgs({ url: 'http://127.0.0.1:1/', width: 100, height: 100 });
  t.ok(shortArgs.indexOf('--window-position=0,0') === -1, '缺少位置时不写 --window-position');
  t.ok(shortArgs.indexOf('--window-size=1024,640') !== -1, '宽高过小时被抬到下限 1024x640');
  const tinyArgs = lib.buildAppArgs({ url: 'http://127.0.0.1:1/', width: 'abc', height: '' });
  t.ok(tinyArgs.indexOf('--window-size=1440,900') !== -1, '宽高非法（非数字）时回退基准尺寸 1440x900');

  /* ---------- 2. 窗口记忆读写 ---------- */
  t.deepEq(lib.centerOf(1440, 900, 1920, 1040), { x: 240, y: 70 }, '居中计算正确');
  const centered = lib.readWindowSync(winFile, 1920, 1040);
  t.eq(centered.width, 1440, '无记忆文件时宽度用基准值');
  t.eq(centered.height, 900, '无记忆文件时高度用基准值');
  t.ok(Number.isFinite(centered.x) && Number.isFinite(centered.y), '无记忆文件时自动居中');

  await lib.writeWindow(winFile, { width: 1280, height: 800, x: 11, y: 22, source: 'page' });
  const back = lib.readWindowSync(winFile, 1920, 1040);
  t.eq(back.width, 1280, '窗口宽度已持久化');
  t.eq(back.height, 800, '窗口高度已持久化');
  t.eq(back.x, 11, '窗口 X 已持久化');
  t.eq(back.y, 22, '窗口 Y 已持久化');

  await fsp.writeFile(winFile, '{ 这不是 JSON', 'utf8');
  const recovered = lib.readWindowSync(winFile, 1920, 1040);
  t.eq(recovered.width, 1440, '记忆文件损坏时回退基准宽度（不抛错）');

  const clamped = lib.sanitizeWindow({ width: 300, height: 200 }, null);
  t.ok(clamped.ok && clamped.value.width === 1024 && clamped.value.height === 640, 'sanitizeWindow 把过小窗口抬到下限 1024x640');
  t.ok(!lib.sanitizeWindow({ width: 99999, height: 900 }, null).ok, 'sanitizeWindow 拒绝荒谬超大宽度');
  t.eq(lib.sanitizeWindow({ width: 5000, height: 4000 }, null).value.width, 5000, 'sanitizeWindow 保留合法大尺寸');
  t.ok(!lib.sanitizeWindow({}, null).ok, '缺少宽高时校验失败');
  t.ok(!lib.sanitizeWindow(null, null).ok, '空 body 时校验失败');

  /* ---------- 3. open-external 白名单 ---------- */
  t.ok(lib.validateLocalUrl('http://127.0.0.1:8775/api/ping').ok, '允许 http 回环地址');
  t.ok(lib.validateLocalUrl('https://localhost/x').ok, '允许 https localhost');
  t.ok(!lib.validateLocalUrl('file:///C:/Windows/System32/calc.exe').ok, '拒绝 file://');
  t.ok(!lib.validateLocalUrl('http://evil.example.com/').ok, '拒绝外网域名');
  t.ok(!lib.validateLocalUrl('javascript:alert(1)').ok, '拒绝 javascript: 协议');
  t.ok(!lib.validateLocalUrl('\\\\server\\share\\a.exe').ok, '拒绝 UNC 路径');
  t.ok(!lib.validateLocalUrl('').ok, '空 url 被拒绝');
  const cfg = await import('../src/core/config.mjs');
  await cfg.loadConfig(true);
  t.ok(lib.validateLocalUrl('http://127.0.0.1:' + (cfg.DEFAULTS.port + 5) + '/api/x').ok, '允许任意本机端口');

  /* ---------- 4. confirm 校验 ---------- */
  t.ok(lib.checkConfirm('1', '1').ok, 'confirm=1 通过');
  t.ok(!lib.checkConfirm(null, '1').ok, '缺少 confirm 被拒绝');
  t.ok(!lib.checkConfirm('0', '1').ok, 'confirm=0 被拒绝');
  t.ok(!lib.checkConfirm('yes', '1').ok, 'confirm=yes 被拒绝');

  /* ---------- 5. autostart 命令拼装（注入执行器，不碰注册表） ---------- */
  const rootDir = root$();
  t.eq(dm.autostartCommand(rootDir), 'wscript.exe "' + path.join(rootDir, '启动漫库.vbs') + '"', '自启动命令行 = wscript + vbs 绝对路径');
  t.deepEq(dm.autostartQueryArgs(), ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'MangaVault'], '注册表查询参数正确');
  const addArgs = dm.autostartAddArgs('wscript.exe "x.vbs"');
  t.eq(addArgs[0], 'add', '写入动作是 add');
  t.ok(addArgs.indexOf('/f') !== -1 && addArgs.indexOf('REG_SZ') !== -1, '写入带 /f 与 REG_SZ');
  t.deepEq(dm.autostartDeleteArgs(), ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'MangaVault', '/f'], '删除参数正确');
  const calls = [];
  const fakeReg = async function (a) {
    calls.push(a.join(' '));
    return { code: 0, stdout: 'REG_SZ        wscript.exe "' + path.join(rootDir, '启动漫库.vbs') + '"', stderr: '' };
  };
  const on = await dm._internals.readAutostart(fakeReg);
  t.ok(on.enabled && on.command.indexOf('启动漫库.vbs') !== -1, '读到已启用的注册表项');
  const off = await dm._internals.readAutostart(function () { return Promise.resolve({ code: 1, stdout: '', stderr: '错误: 系统找不到指定的注册表项' }); });
  t.ok(!off.enabled, '没有注册表项时返回 enabled=false');
  const setRes = await dm._internals.setAutostart(true, rootDir, fakeReg);
  t.ok(setRes.ok && setRes.enabled, '开启自启：返回真实状态 enabled=true');
  t.ok(calls.some(function (c) { return /^add /.test(c); }), '开启自启调用的是 reg add：' + JSON.stringify(calls));
  const delCalls = [];
  const fakeDel = async function (a) { delCalls.push(a.join(' ')); return { code: 0, stdout: '', stderr: '' }; };
  const offRes = await dm._internals.setAutostart(false, rootDir, fakeDel);
  t.ok(offRes.ok && offRes.enabled === false, '关闭自启：调用 reg delete 且状态为 false');
  t.ok(delCalls.some(function (c) { return /^delete /.test(c); }), '关闭自启调用的是 reg delete：' + JSON.stringify(delCalls));
  t.ok(!dm._internals.parseAutostart({ enabled: 'maybe' }).ok, 'enabled 非布尔时被拒绝');
  t.ok(dm._internals.parseAutostart({ enabled: 'true' }).value === true, 'enabled="true" 解析为 true');

  /* ---------- 6. 日志行数上限 ---------- */
  t.eq(dm._internals.parseLines(null), 200, '未传 lines 时默认 200 行');
  t.eq(dm._internals.parseLines('9999'), 500, 'lines 上限 500');
  t.eq(dm._internals.parseLines('abc'), 200, 'lines 非法时回退 200');
  t.eq(dm.tailLines('a\nb\nc\nd\n', 2).join(','), 'c,d', 'tailLines 取最后两行');

  /* ---------- 7. 后端接口（真实 HTTP，隔离数据目录） ---------- */
  const app = createApp({ log: silentLog, accessLog: false });
  const ctx = {
    config: cfg.DEFAULTS,
    log: silentLog,
    projectRoot: rootDir,
    dataDir: TMP,
    publicDir: path.join(rootDir, 'public'),
    moduleId: 'desktop',
    moduleMeta: dm.meta,
    reloadConfig: function () { return cfg.loadConfig(true); },
    saveConfig: async function () { return cfg.loadConfig(true); }
  };
  /* 库根指向 TMP：reveal 的「必须在库根内」这条边界才有东西可测 */
  const ROOT_A = path.join(TMP, 'lib-a');
  const ROOT_B = path.join(TMP, 'lib-b');
  const OUTSIDE = path.join(TMP, 'outside');
  for (const d of [ROOT_A, ROOT_B, OUTSIDE]) await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(path.join(ROOT_A, 'sample.jpg'), 'not-a-real-jpeg', 'utf8');
  ctx.config.libraryRoots = [
    { id: 'a', name: '库A', path: ROOT_A, enabled: true },
    { id: 'b', name: '库B', path: ROOT_B, enabled: true }
  ];
  /* 关键：注入假的「打开外部链接」实现。不注入的话每跑一次测试就会真的弹出系统浏览器。 */
  const opened = [];
  dm._setExternalOpener(function (url) { opened.push(url); });
  await dm.register(app, ctx);
  const server = app.createServer();
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  t.log('测试用 HTTP 端口 ' + port + '，数据目录 ' + TMP);

  const state = await request(port, 'GET', '/api/desktop/state');
  t.eq(state.status, 200, 'GET /api/desktop/state 返回 200');
  t.eq(state.json.form, 'desktop', 'state.form = desktop');
  t.ok(state.json.pid === process.pid, 'state.pid = 当前进程');
  t.ok(state.json.canQuit === true && state.json.canRestart === true, 'state 声明可退出/可重启');
  t.ok(state.json.window && state.json.window.width >= 1024, 'state 带窗口记忆');

  const badWin = await request(port, 'POST', '/api/desktop/window', { foo: 1 });
  t.eq(badWin.status, 400, 'POST /api/desktop/window 缺参数返回 400');
  t.ok(badWin.json && badWin.json.ok === false && /宽高/.test(badWin.json.error), '400 原因是中文的缺宽高说明');

  const okWin = await request(port, 'POST', '/api/desktop/window', { width: 1366, height: 768, x: 30, y: 40, source: 'page' });
  t.eq(okWin.status, 200, 'POST /api/desktop/window 正常参数返回 200');
  t.eq(okWin.json.window.width, 1366, '返回落盘的宽度');
  const persisted = lib.readWindowSync(path.join(TMP, 'desktop-window.json'), 1920, 1040);
  t.eq(persisted.width, 1366, '页面上报的宽度已写入 data/desktop-window.json');
  t.eq(persisted.y, 40, '页面上报的 Y 已写入');

  const altWin = await request(port, 'POST', '/api/desktop/window', { innerWidth: 1200, innerHeight: 700, screenX: 5, screenY: 6 });
  t.eq(altWin.status, 200, 'POST /api/desktop/window 支持 innerWidth/screenX 命名');
  t.eq(altWin.json.window.width, 1200, 'innerWidth 被采纳为窗口宽度');

  const noConfirm = await request(port, 'POST', '/api/desktop/quit', {});
  t.eq(noConfirm.status, 400, 'POST /api/desktop/quit 缺 confirm 返回 400');
  const noConfirm2 = await request(port, 'POST', '/api/desktop/restart', {});
  t.eq(noConfirm2.status, 400, 'POST /api/desktop/restart 缺 confirm 返回 400');

  /* ---------- 7b. open-external 白名单（v3 契约：http / https / mailto） ---------- */
  const extBad = await request(port, 'POST', '/api/desktop/open-external', { url: 'file:///C:/Windows/System32/calc.exe' });
  t.eq(extBad.status, 400, 'open-external 拒绝 file://（400）');
  const extJs = await request(port, 'POST', '/api/desktop/open-external', { url: 'javascript:alert(1)' });
  t.eq(extJs.status, 400, 'open-external 拒绝 javascript:（400）');
  const extData = await request(port, 'POST', '/api/desktop/open-external', { url: 'data:text/html,<script>x</script>' });
  t.eq(extData.status, 400, 'open-external 拒绝 data:（400）');
  const extMissing = await request(port, 'POST', '/api/desktop/open-external', {});
  t.eq(extMissing.status, 400, 'open-external 缺 url 返回 400');
  const extOk = await request(port, 'POST', '/api/desktop/open-external', { url: 'https://example.com/docs' });
  t.eq(extOk.status, 200, 'open-external 允许 https 外网地址（v3 契约）');
  t.ok(opened.indexOf('https://example.com/docs') !== -1, '真的把 https 地址交给了系统打开（已注入，未弹浏览器）');
  const extMail = await request(port, 'POST', '/api/desktop/open-external', { url: 'mailto:a@b.com' });
  t.eq(extMail.status, 200, 'open-external 允许 mailto');
  const extInject = await request(port, 'POST', '/api/desktop/open-external', { url: 'https://x/' + String.fromCharCode(38) + 'calc' });
  t.eq(extInject.status, 200, '注入字符在「已注入打开器」路径下不经过 cmd（200）');

  /* ---------- 7c. 纯函数：guard 协议与路径边界 ---------- */
  t.ok(guard.validateExternalUrl('http://127.0.0.1:8775/x').ok, 'guard 允许 http');
  t.ok(guard.validateExternalUrl('mailto:a@b.com').ok, 'guard 允许 mailto');
  t.ok(!guard.validateExternalUrl('vbscript:msgbox(1)').ok, 'guard 拒绝 vbscript:');
  t.ok(!guard.validateExternalUrl('https://a.com/' + String.fromCharCode(13, 10) + 'calc').ok, 'guard 拒绝含 CRLF 的地址');
  t.ok(!guard.isCmdSafeUrl('https://a/?x' + String.fromCharCode(38) + 'calc').ok, 'isCmdSafeUrl 拒绝 & 注入');
  t.ok(guard.isCmdSafeUrl('https://a/?x=1').ok, 'isCmdSafeUrl 放行普通地址');

  const rootsForGuard = [{ id: 'a', name: 'A', path: ROOT_A }, { id: 'b', name: 'B', path: ROOT_B }];
  t.ok(guard.validateRevealPath(path.join(ROOT_A, 'sample.jpg'), rootsForGuard).ok, 'guard 允许库根内的文件');
  t.ok(guard.validateRevealPath(ROOT_A, rootsForGuard).ok, 'guard 允许库根本身');
  t.eq(guard.validateRevealPath(path.join(ROOT_A, 'sample.jpg'), rootsForGuard).value.root.id, 'a', 'guard 认出所属库根');
  t.ok(!guard.validateRevealPath(OUTSIDE, rootsForGuard).ok, 'guard 拒绝库根之外的路径');
  t.ok(!guard.validateRevealPath('C:\\Windows\\System32', rootsForGuard).ok, 'guard 拒绝系统目录');
  t.ok(!guard.validateRevealPath(path.join(ROOT_A, '..', 'outside'), rootsForGuard).ok, 'guard 拒绝 .. 逃逸');
  t.ok(!guard.validateRevealPath(path.join(ROOT_B, '..', 'lib-a'), rootsForGuard).ok === false, 'guard 对嵌套名字不做前缀误判');
  t.ok(!guard.validateRevealPath('', rootsForGuard).ok, 'guard 拒绝空路径');
  t.ok(!guard.validateRevealPath(ROOT_A, []).ok, 'guard 在没有任何库根时拒绝');
  t.ok(guard.validateRevealPath(path.join(ROOT_A, 'sample.jpg'), rootsForGuard, { caseInsensitive: true }).ok, '大小写不敏感模式仍可识别（Windows 语义）');

  /* ---------- 7d. /api/desktop/info ---------- */
  const info = await request(port, 'GET', '/api/desktop/info');
  t.eq(info.status, 200, 'GET /api/desktop/info 返回 200');
  t.eq(info.json.mode, 'web', '没有宿主时 info.mode = web');
  t.eq(info.json.exe, null, '没有宿主时 info.exe = null');
  t.ok(info.json.native && info.json.native.attached === false, 'info.native.attached = false');
  t.deepEq(info.json.native.protocols, ['http', 'https', 'mailto'], 'info 公布的白名单是 http/https/mailto');

  /* ---------- 7e. reveal / pick-dir 在「宿主不在线」时的明确中文降级 ---------- */
  const revNoHost = await request(port, 'POST', '/api/desktop/reveal', { path: path.join(ROOT_A, 'sample.jpg') });
  t.eq(revNoHost.status, 503, '宿主不在线时 reveal 返回 503（不是 500）');
  t.ok(/桌面宿主/.test(revNoHost.json.error), 'reveal 的降级原因是中文可读的');
  const revOutside = await request(port, 'POST', '/api/desktop/reveal', { path: OUTSIDE });
  t.eq(revOutside.status, 403, 'reveal 拒绝库根之外的路径（403）');
  const revMissing = await request(port, 'POST', '/api/desktop/reveal', { path: path.join(ROOT_A, 'nope.jpg') });
  t.eq(revMissing.status, 404, 'reveal 对库根内不存在的路径返回 404');
  const revEmpty = await request(port, 'POST', '/api/desktop/reveal', {});
  t.eq(revEmpty.status, 403, 'reveal 缺 path 返回 403');
  const pickNoHost = await request(port, 'POST', '/api/desktop/pick-dir', { title: '选一个目录' });
  t.eq(pickNoHost.status, 503, '宿主不在线时 pick-dir 返回 503');
  t.ok(/目录选择|宿主/.test(pickNoHost.json.error), 'pick-dir 的降级原因是中文可读的');
  const pickLong = await request(port, 'POST', '/api/desktop/pick-dir', { title: 'x'.repeat(500) });
  t.eq(pickLong.status, 400, 'pick-dir 拒绝超长标题（400）');

  /* ---------- 7f. 宿主长轮询 + 回执的端到端闭环（离线） ---------- */
  /* 起一个真实的长轮询请求，模拟宿主；同时从另一个请求提交 pick-dir。
     这条链路是原生能力能工作的关键，必须在无 GUI 的情况下被证明。 */
  const longPoll = request(port, 'GET', '/api/desktop/native/next?pid=4242&timeout=8000');
  await new Promise(function (r) { setTimeout(r, 120); });
  const pickTask = request(port, 'POST', '/api/desktop/pick-dir', { title: '请选择漫画库根' });
  const polled = await longPoll;
  t.eq(polled.status, 200, '宿主长轮询返回 200');
  t.eq(polled.json.kind, 'pick-dir', '长轮询领到了 pick-dir 命令');
  t.ok(polled.json.id && typeof polled.json.id === 'string', '命令带 id');
  t.eq(polled.json.title, '请选择漫画库根', '命令带上了标题参数');

  const info2 = await request(port, 'GET', '/api/desktop/info');
  t.eq(info2.json.mode, 'webview2', '宿主心跳后 info.mode 变成 webview2');
  t.ok(info2.json.native.attached === true, '宿主心跳后 native.attached = true');

  const CHOSEN = path.join(TMP, 'chosen-dir');
  await fsp.mkdir(CHOSEN, { recursive: true });
  const ack = await request(port, 'POST', '/api/desktop/native/result', {
    id: polled.json.id,
    result: JSON.stringify({ ok: true, path: CHOSEN })
  });
  t.eq(ack.status, 200, '宿主回执被接受（200）');
  const picked = await pickTask;
  t.eq(picked.status, 200, 'pick-dir 拿到宿主回执后返回 200');
  t.eq(picked.json.path, CHOSEN, 'pick-dir 返回宿主选中的绝对路径');

  /* 用户取消 -> 409 而不是 500 */
  const lp2 = request(port, 'GET', '/api/desktop/native/next?timeout=8000');
  await new Promise(function (r) { setTimeout(r, 120); });
  const pick2 = request(port, 'POST', '/api/desktop/pick-dir', {});
  const polled2 = await lp2;
  await request(port, 'POST', '/api/desktop/native/result', { id: polled2.json.id, result: JSON.stringify({ ok: false, error: '用户取消了目录选择' }) });
  const cancelled = await pick2;
  t.eq(cancelled.status, 409, '用户取消目录选择 -> 409（前端可区分，不当成服务器错误）');

  /* 宿主报错 -> 502 */
  const lp3 = request(port, 'GET', '/api/desktop/native/next?timeout=8000');
  await new Promise(function (r) { setTimeout(r, 120); });
  const pick3 = request(port, 'POST', '/api/desktop/pick-dir', {});
  const polled3 = await lp3;
  await request(port, 'POST', '/api/desktop/native/result', { id: polled3.json.id, result: JSON.stringify({ ok: false, error: '打开目录选择对话框失败：拒绝访问' }) });
  const hostErr = await pick3;
  t.eq(hostErr.status, 502, '宿主执行失败 -> 502');
  t.ok(/拒绝访问/.test(hostErr.json.error), '502 把宿主的原因透传给前端');

  const ackBad = await request(port, 'POST', '/api/desktop/native/result', { id: 'not-a-real-id', result: '{}' });
  t.eq(ackBad.status, 404, '回执一个不存在的命令 -> 404');
  const ackNoId = await request(port, 'POST', '/api/desktop/native/result', { result: '{}' });
  t.eq(ackNoId.status, 400, '回执缺 id -> 400');

  /* reveal 在宿主在线时也能闭环（并且真的把库根内路径发出去） */
  const lp4 = request(port, 'GET', '/api/desktop/native/next?timeout=8000');
  await new Promise(function (r) { setTimeout(r, 120); });
  const revTask = request(port, 'POST', '/api/desktop/reveal', { path: path.join(ROOT_A, 'sample.jpg') });
  const polled4 = await lp4;
  t.eq(polled4.json.kind, 'reveal', '长轮询领到了 reveal 命令');
  await request(port, 'POST', '/api/desktop/native/result', { id: polled4.json.id, result: JSON.stringify({ ok: true, path: polled4.json.path }) });
  const revealed = await revTask;
  t.eq(revealed.status, 200, 'reveal 在宿主在线时返回 200');
  t.eq(revealed.json.kind, 'file', 'reveal 汇报目标是文件');
  t.eq(revealed.json.root.id, 'a', 'reveal 汇报所属库根');

  /* 长轮询无命令时应超时返回 kind=null，而不是挂死 */
  const startedPoll = Date.now();
  const emptyPoll = await request(port, 'GET', '/api/desktop/native/next?timeout=600');
  t.eq(emptyPoll.status, 200, '无命令时长轮询正常返回 200');
  t.eq(emptyPoll.json.kind, null, '无命令时 kind = null（宿主据此重连）');
  t.ok(Date.now() - startedPoll >= 500, '长轮询确实挂起到了 timeout 而不是立刻返回');

  /* ---------- 7g. 桥状态机纯单测（不经过 HTTP） ---------- */
  const b = bridgeMod.createBridge({ pollMs: 100 });
  t.ok(!b.attached(), '新建桥：宿主未连接');
  b.noteHost({ pid: 1, exe: 'X:/MangaVault.exe' });
  t.ok(b.attached(), '心跳后宿主在线');
  t.eq(b.status().host.pid, 1, '桥记录宿主 pid');
  const r1 = bridgeMod.parseHostResult('{"ok":true,"path":"C:/x"}');
  t.ok(r1.ok && r1.value.path === 'C:/x', 'parseHostResult 解析成功结果');
  const r2 = bridgeMod.parseHostResult('{"ok":false,"error":"拒绝访问"}');
  t.ok(!r2.ok && r2.error === '拒绝访问', 'parseHostResult 透传宿主错误');
  const r3 = bridgeMod.parseHostResult('不是 JSON');
  t.ok(!r3.ok, 'parseHostResult 对非 JSON 返回失败');
  const r4 = bridgeMod.parseHostResult('');
  t.ok(!r4.ok && /空/.test(r4.error), 'parseHostResult 对空结果给出中文原因');
  b.dispose('测试');
  t.ok(!b.poll(50).then(function () { return true; }) ? false : true, 'dispose 后 poll 仍可安全调用（不抛错）');

  const b2 = bridgeMod.createBridge({ pollMs: 50 });
  b2.noteHost({ pid: 2 });
  const waitCmd = b2.poll(50);
  const submitted = b2.submit('reveal', { path: 'X:/y' }, 1000);
  const gotCmd = await waitCmd;
  t.eq(gotCmd.kind, 'reveal', 'submit 与已挂起的 poll 直接对接（无需排队）');
  b2.resolve(gotCmd.id, '{"ok":true}');
  const done = await submitted;
  /* 成功形状是 { ok:true, result }（result = 宿主回执原文的字符串） */
  t.ok(done.ok && done.result === '{"ok":true}', 'resolve 把回执交回 submit');
  t.ok(!('value' in done), 'submit 的成功结果用 result 字段，不叫 value（避免和 parseHostResult 混淆）');

  const b3 = bridgeMod.createBridge({ pollMs: 50 });
  const t3 = b3.submit('pick-dir', {}, 120);
  const timedOut = await t3;
  t.ok(!timedOut.ok && timedOut.timeout === true, 'submit 超时 -> timeout=true（不会永远挂住）');
  t.ok(/超时/.test(timedOut.error), 'submit 超时给出中文原因');

  const b4 = bridgeMod.createBridge({ pollMs: 50 });
  const t4 = b4.submit('quit', {}, 5000);
  b4.dispose('宿主退出');
  const disposed = await t4;
  t.ok(!disposed.ok && /宿主/.test(disposed.error), 'dispose 唤醒悬挂请求并给中文原因');

  const autoBad = await request(port, 'POST', '/api/desktop/autostart', { enabled: 'maybe' });
  t.eq(autoBad.status, 400, 'autostart 非布尔 enabled 返回 400（不会碰注册表）');

  await fsp.writeFile(path.join(TMP, 'mangavault.log'), Array.from({ length: 600 }, function (_, i) { return 'line ' + (i + 1); }).join('\n'), 'utf8');
  const logs = await request(port, 'GET', '/api/desktop/logs?lines=9999');
  t.eq(logs.status, 200, 'GET /api/desktop/logs 返回 200');
  t.eq(logs.json.lines, 500, 'lines 参数被夹到 500');
  t.eq(logs.json.logs[0].lines, 500, '返回最后 500 行');
  t.ok(/line 600/.test(logs.json.logs[0].text) && !/line 1\n/.test(logs.json.logs[0].text), '日志是尾部而不是头部');

  await new Promise(function (r) { server.close(r); });

  /* ---------- 8. 关闭超时保护：quit 带 confirm 会真的触发 SIGTERM，因此不在这里测 ---------- */
  t.log('注意：POST /api/desktop/quit?confirm=1 会真的给当前进程发 SIGTERM，端到端验证放在桌面启动器冒烟里');

  /* ---------- 9. 浏览器探测与 CDP 解析 ---------- */
  const browser = sys.findBrowserSync();
  t.ok(browser === null || (browser.exe && fs.existsSync(browser.exe)), 'findBrowserSync 返回真实存在的浏览器路径或 null');
  if (browser) t.log('本机浏览器：' + browser.name + ' -> ' + browser.exe);
  const fakeCdp = JSON.stringify([
    { id: 'a', type: 'page', title: '漫库', url: 'http://127.0.0.1:8775/' },
    { id: 'b', type: 'service_worker', title: 'sw', url: 'chrome-extension://x/bg.js' }
  ]);
  const parsed = sys.parseCdpJson(fakeCdp);
  t.eq(parsed.length, 1, 'parseCdpJson 只保留 page 类型目标');
  t.eq(sys.parseCdpJson('not json').length, 0, 'parseCdpJson 对坏数据返回空数组');
  t.eq(sys.normalizeUrl('http://127.0.0.1:8775/#/library'), 'http://127.0.0.1:8775/', 'normalizeUrl 去掉 hash');
  t.ok(Number.isFinite(sys.debugPortFor(TMP)) && sys.debugPortFor(TMP) >= 9210 && sys.debugPortFor(TMP) < 9300, '调试端口落在 9210-9299');
  t.eq(sys.debugPortFor(TMP), sys.debugPortFor(TMP + '/'), '同一数据目录端口稳定');

  /* ---------- 9b. 崩溃修复回归：探测失败不得被当成「窗口已关闭」 ---------- */
  // 背景：长任务扫描把 CPU 打满时 PowerShell 探测会超时，旧实现把「探测失败」等同于
  // 「窗口已关闭」，于是启动器退出并收掉内核 → 用户看到「点重新扫描程序就崩了」。
  const srcInfo = fs.readFileSync(path.join(root$(), 'desktop', 'sysinfo.mjs'), 'utf8');
  const srcApp = fs.readFileSync(path.join(root$(), 'desktop', 'app.mjs'), 'utf8');
  t.ok(typeof sys.cdpProbe === 'function', 'sysinfo 暴露 cdpProbe（区分探测失败与目标为空）');
  t.ok(typeof sys.appWindowProbe === 'function', 'sysinfo 暴露 appWindowProbe（区分探测失败与无窗口）');
  // 注入一个必然失败的 exec：探测必须报 ok=false，而不是「列表为空」
  const failExec = function (cmd, args, opts, cb) {
    const done = typeof opts === 'function' ? opts : cb;
    done(new Error('模拟 PowerShell 超时'), '', '');
  };
  const badCdp = await sys.cdpProbe(9299, failExec, 500);
  t.eq(badCdp.ok, false, 'cdpProbe 探测失败时 ok=false（不是「没有目标」）');
  t.eq(badCdp.list.length, 0, 'cdpProbe 探测失败时 list 为空');
  const probeFail = await sys.appWindowProbe('C:/nonexistent-profile', failExec);
  t.eq(probeFail.ok, false, 'appWindowProbe 探测失败时 ok=false（不是「没有窗口进程」）');
  // 注入一个成功的 exec：必须报 ok=true 且能解析出窗口进程
  const okJson = JSON.stringify([{ ProcessId: 1234, Name: 'msedge.exe', CommandLine: 'msedge --user-data-dir=C:\\x\\desktop-profile' }]);
  const okExec = function (cmd, args, opts, cb) {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, okJson, '');
  };
  const goodWin = await sys.appWindowProbe('C:/x/desktop-profile', okExec);
  t.eq(goodWin.ok, true, 'appWindowProbe 探测成功时 ok=true');
  t.eq(goodWin.list.length, 1, 'appWindowProbe 命中同 profile 的窗口进程');
  // 坏 JSON：属于探测失败，不能当成「没有窗口」（否则会误收内核）
  const badJsonExec = function (cmd, args, opts, cb) {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, '这不是 JSON', '');
  };
  const broken = await sys.appWindowProbe('C:/x/desktop-profile', badJsonExec);
  t.eq(broken.ok, false, 'appWindowProbe 解析失败时 ok=false（不当成「没有窗口」）');
  // 源码契约：内核必须脱离进程树 + 不能用管道（两者缺一内核就会随启动器死亡）
  t.ok(srcApp.indexOf('detached: true') >= 0, 'spawnServer 用 detached:true 让内核脱离启动器进程树');
  t.ok(srcApp.indexOf('child.unref()') >= 0, 'spawnServer 调 unref 放弃对内核的引用');
  t.ok(srcApp.indexOf('kernel-console.log') >= 0, '内核控制台输出落文件（管道断开会让内核 EPIPE 自杀）');
  t.ok(srcApp.indexOf("stdio: ['ignore', 'pipe', 'pipe']") < 0, 'spawnServer 不再用 stdio 管道');
  t.ok(srcInfo.indexOf('requiredMisses') >= 0, 'waitForCdpClosed 要求连续多次命中才判定关窗');
  t.ok(srcInfo.indexOf('探测失败 ≠ 窗口关闭') >= 0 || srcInfo.indexOf('不能据此判断窗口状态') >= 0, 'waitForCdpClosed 明确区分探测失败与关窗');
  t.ok(srcApp.indexOf('窗口进程探测失败') >= 0, '收尾守卫在探测失败时保留内核而不是收掉');

  /* ---------- 10. 启动器参数解析 ---------- */
  const appMod = await import('../desktop/app.mjs');
  const parsedArgs = appMod.parseArgs(['--keep-alive', '--width', '1500', '--restarts', '5']);
  t.ok(parsedArgs.keepAlive && parsedArgs.width === 1500 && parsedArgs.maxRestarts === 5, '启动器参数解析正确');
  t.ok(appMod.parseArgs(['--window-only']).keepAlive, '--window-only 隐式 keep-alive');
  t.eq(appMod.paths().profileDir, path.join(TMP, 'desktop-profile'), 'profile 目录落在数据目录内');
  t.eq(appMod.paths().windowFile, path.join(TMP, 'desktop-window.json'), '窗口记忆文件路径正确');

  /* ---------- 11. 窗口开到屏幕外 / 窗口清不掉 的回归断言 ---------- */
  // 背景（实测事故）：Windows 上最小化窗口的 screenX/screenY 是 -32000，页面外壳每 20 秒上报一次，
  // 启动器把 -32000 当合法位置存进窗口记忆，下次启动就拼出 --window-position=-32000,-32000，
  // 窗口开在屏幕外 → 用户看不见 → 不去关它 → 启动器永远等 → 再双击又开一个屏外窗口。
  t.eq(lib.POS_LIMIT, 20000, '坐标合理范围上限是 20000');
  t.ok(lib.posInRange(0) && lib.posInRange(-19999) && lib.posInRange(19999), 'posInRange 接受屏内坐标');
  t.ok(!lib.posInRange(-32000), 'posInRange 拒绝 Windows 最小化窗口上报的 -32000');
  t.ok(!lib.posInRange(null) && !lib.posInRange(undefined) && !lib.posInRange(NaN), 'posInRange 拒绝空值与非数字');
  t.ok(!lib.posInRange(20001) && !lib.posInRange(-20001), 'posInRange 拒绝越界坐标');

  const offscreen = lib.sanitizeWindow({ width: 1920, height: 1027, x: -32000, y: -32000 }, null);
  t.ok(offscreen.ok, 'sanitizeWindow 对「尺寸合法但位置越界」的上报仍然成功（尺寸要保住）');
  t.eq(offscreen.value.width, 1920, '越界位置不影响宽度落盘');
  t.eq(offscreen.value.x, undefined, '越界位置被丢弃（x 不下发）');
  t.eq(offscreen.value.y, undefined, '越界位置被丢弃（y 不下发）');
  const onscreen = lib.sanitizeWindow({ width: 1920, height: 1027, x: 120, y: 60 }, null);
  t.eq(onscreen.value.x, 120, '屏内位置正常保留 x');
  t.eq(onscreen.value.y, 60, '屏内位置正常保留 y');

  const offArgs = lib.buildAppArgs({ url: 'http://127.0.0.1:8775/', width: 1920, height: 1027, x: -32000, y: -32000 });
  t.ok(offArgs.indexOf('--window-position=-32000,-32000') === -1, 'buildAppArgs 不再拼出屏外的 --window-position');
  t.ok(offArgs.every(function (a) { return a.indexOf('--window-position') !== 0; }), '位置越界时干脆不给 --window-position（让浏览器自己选）');
  const halfArgs = lib.buildAppArgs({ url: 'http://127.0.0.1:8775/', width: 1440, height: 900, x: 100, y: -32000 });
  t.ok(halfArgs.every(function (a) { return a.indexOf('--window-position') !== 0; }), '位置必须成对合法，只合法一个就不拼');

  // 后端回落旧值时也必须过范围校验，否则等于把 -32000 重新写回窗口记忆
  const merged = dm.mergeWindowReport({ width: 1366, height: 768 }, { width: 1366, height: 768, x: -32000, y: -32000 });
  t.ok(merged.ok, 'mergeWindowReport 正常返回');
  t.eq(merged.value.x, undefined, '回落的旧 x 若越界则丢弃（不把 -32000 写回记忆）');
  const mergedOk = dm.mergeWindowReport({ width: 1366, height: 768 }, { width: 1366, height: 768, x: 30, y: 40 });
  t.eq(mergedOk.value.x, 30, '回落的旧 x 合法时保留');

  /* CDP 脚本的调试端口必须交给浏览器自己挑（--remote-debugging-port=0 + 读
     DevToolsActivePort），不许 `9333 + random(200)` 自己猜：那个范围被多个脚本共用，
     机器上有残留无头浏览器时会撞车 → 偶发的「浏览器调试端口未就绪」假失败
     （实测 verify-all 第 3 步的一次 25.4s 失败）。 */
  for (const name of ['ui-scroll-check.mjs', 'reader-nav-check.mjs', 'download-tabs-check.mjs', 'dedupe-cand-ui-check.mjs']) {
    const src = fs.readFileSync(path.join(root$(), 'scripts', 'dev', name), 'utf8');
    t.ok(src.indexOf('--remote-debugging-port=0') >= 0, name + ' 用 --remote-debugging-port=0 让浏览器自选端口');
    t.ok(src.indexOf('DevToolsActivePort') >= 0, name + ' 从 DevToolsActivePort 读实际调试端口');
    t.ok(!/remote-debugging-port=' \+/.test(src), name + ' 不再拼接自己猜的端口号');
  }

  /* 验收脚本**不许连用户的 8775 实例**。实测教训（2026-10-17 verify-all 第 3 步假红）：
     ui-scroll-check.mjs 默认 --port=8775，而 8775 上跑着用户自己启动的旧版服务 ——
     那边加载的是旧前端，「页面字节 vs 后端指纹」这条断言必然红，看起来像功能回归，
     实际只是服务器版本旧。规则：CDP 验收脚本一律自建隔离数据目录 + 随机端口。 */
  const scrollSrc = fs.readFileSync(path.join(root$(), 'scripts', 'dev', 'ui-scroll-check.mjs'), 'utf8');
  t.ok(scrollSrc.indexOf('MV_DATA_DIR') >= 0, 'ui-scroll-check 跑在隔离数据目录上（不碰用户数据目录）');
  t.ok(scrollSrc.indexOf('function freePort()') >= 0, 'ui-scroll-check 自己取空闲端口');
  t.ok(/realPort === 8775/.test(scrollSrc), 'ui-scroll-check 显式拒绝占用 8775');
  t.ok(scrollSrc.indexOf('const port = arg(\"port\", \"8775\")') < 0, 'ui-scroll-check 不再默认连 8775');
  /* verify-all 也不许显式传 --port=8775 给它 */
  const verifyAllSrc = fs.readFileSync(path.join(root$(), 'scripts', 'dev', 'verify-all.mjs'), 'utf8');
  const scrollLine = verifyAllSrc.split(/\r?\n/).find(function (l) { return l.indexOf('ui-scroll-check.mjs') >= 0 && l.indexOf('cmd:') >= 0; }) || '';
  t.ok(scrollLine.indexOf('--port=') < 0, 'verify-all 调用 ui-scroll-check 时不传固定端口');

  // 探测循环必须有界：旧实现是 while(true) + 探测失败 continue，只要 PowerShell 一直超时
  // 就永远不返回，启动器进程退不掉 —— 用户原话「那个桌面窗口怎么没清除掉」。
  t.ok(srcInfo.indexOf('failStreak') >= 0 && srcInfo.indexOf('failLimit') >= 0, 'waitWindowClosed 用 failStreak/failLimit 给探测循环加界');
  const bounded = (srcInfo.match(/failStreak >= failLimit/g) || []).length;
  t.eq(bounded, 2, 'waitWindowClosed 与 waitForCdpClosed 两处等待循环都加了失败上限');

  // 崩溃留痕：用户报「一启动就崩溃」时，退出码必须能在磁盘上查到
  t.ok(srcApp.indexOf('desktop-exit.json') >= 0, '启动器把退出码落盘到 data/desktop-exit.json');
  t.ok(srcApp.indexOf('recordExit') >= 0, '启动器有 recordExit 落痕函数');
  // 单实例防护：连点两次不应开两个窗口、留两套进程
  t.ok(srcApp.indexOf('desktop-launcher.lock') >= 0, '启动器有单实例守卫文件');
  t.ok(srcApp.indexOf('acquireLaunchGuard') >= 0, '启动器有 acquireLaunchGuard 单实例检查');
  t.ok(srcApp.indexOf('已有一个漫库启动器在运行') >= 0, '重复启动时明确告知并直接退出');

  // 收内核必须带 /F：不带 /F 时 taskkill 对 detached 的无窗口 node 回 255
  // 「can only be terminated forcefully」，进程不死 —— 表现为「窗口关了程序还在跑」。
  t.ok(srcApp.indexOf("'/PID', String(lock.pid), '/T', '/F'") >= 0, 'shutdownServer 的 taskkill 带 /F（否则内核杀不掉）');
  t.ok(/taskkill'\s*,\s*\['\/PID'[^\]]*\/F'/.test(srcApp), 'taskkill 调用形态正确（PID + /T + /F）');

  const srcLog = fs.readFileSync(path.join(root$(), 'desktop', 'log.mjs'), 'utf8');
  t.ok(srcLog.indexOf('toISOString().slice(11') < 0, '启动器日志时间戳不再用 UTC（与 mangavault.log 同一时间锚）');
  t.ok(srcLog.indexOf('getHours()') >= 0, '启动器日志时间戳改用本地时间');

  const srcShim = fs.readFileSync(path.join(root$(), 'desktop', 'shell', 'shim.js'), 'utf8');
  t.ok(srcShim.indexOf('function minimized()') >= 0, '页面外壳能识别「最小化」状态');
  t.ok(srcShim.indexOf('body.minimized = min') >= 0, '页面外壳把 minimized 标记随几何一起上报');
  t.ok(srcShim.indexOf("if (!min) { body.x = g.screenX; body.y = g.screenY; }") >= 0, '最小化时不上报 screenX/screenY');

  /* ---------- 收尾：清掉临时目录 ---------- */
  try { await fsp.rm(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  t.log('临时数据目录已清理：' + TMP);
}

/** 工程根（本测试文件在 tests/ 下） */
function root$() {
  return path.resolve(import.meta.dirname, '..');
}
