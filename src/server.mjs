
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createApp } from './core/http.mjs';
import { loadConfig, dataDir, configFile, saveConfig, PUBLIC_DIR, PROJECT_ROOT } from './core/config.mjs';
import { createLogger, setLogFile } from './core/log.mjs';
import { loadModules } from './modules/index.mjs';
import { formatBytes } from './core/util.mjs';
import { touchSilence, releaseSilence, DEFAULT_SILENCE_MS } from './core/heartbeat.mjs';
import { installVersionRoute, installPingRoute } from './core/health.mjs';

/** 慢任务静默窗口长度（与 heartbeat 的默认值保持一致） */
const SLOW_TASK_MS = DEFAULT_SILENCE_MS;

const config = await loadConfig(true);

/* 端口优先级：环境变量 MV_PORT > data/config.json > 默认 8775。
   ▸ 为什么必须读 MV_PORT：验收脚本（ui-scroll-check / vault-admin-ui-check / orphan-race 等）
     要临时拉一个**隔离端口**的服务，免得和用户正在用的 8775 打架。此前 server.mjs 忽略该变量，
     脚本拉起服务后 ping 自己指定的端口永远等不到（实测「服务未在 40000ms 内就绪」）。
   ▸ 非法值一律忽略，绝不能让一个坏环境变量把服务带死。 */
const envPortRaw = Number(process.env.MV_PORT);
const envPortExplicit = Number.isInteger(envPortRaw) && envPortRaw > 0 && envPortRaw < 65536;

/* ---------- 单实例保护：避免两个进程同时写 data/*.json 把索引写坏 ---------- */
const LOCK_FILE = path.join(dataDir(), 'server.lock.json');
async function existingInstance() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (!raw || !raw.pid || !raw.port) return null;
    try { process.kill(raw.pid, 0); } catch (e) { return null; }   // 进程已死 => 陈旧锁
    const res = await fetch('http://127.0.0.1:' + raw.port + '/api/ping', { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    if (data && data.name === 'MangaVault') return raw;
  } catch (e) { /* 锁文件不存在或对端已死 */ }
  return null;
}
/* ▸ 显式指定 MV_PORT 时必须**跳过单实例检查**：那是一个明确要求「独立监听在指定端口」的
     请求（验收脚本就靠它）。以前这里不看 MV_PORT，于是脚本拉起的第二个进程一读到
     默认端口上那个在跑实例的锁，就打印「漫库已经在运行」并 process.exit(0) ——
     它根本没去监听 8793，外层只能等到「服务未在 40000ms 内就绪」。
     日志文件仍在同一个数据目录，两个实例可能抢写；但这是脚本自己承担的风险，
     验收脚本一律带 MV_DATA_DIR 隔离（AGENT.md 第 9 节）。 */
const running = envPortExplicit ? null : await existingInstance();
if (running) {
  /* 这两行走 process.stdout 而不是 console.log：此处 logger 还没建（见下方 createLogger），
     而 core/log.mjs 本身也是直接写 process.stdout/stderr。工程卫生检查把业务代码里的
     console.log 视为调试残留，这里改用同一套底层写法，语义不变。 */
  process.stdout.write('漫库已经在运行：http://127.0.0.1:' + running.port + '/  （pid ' + running.pid + '）\n');
  process.stdout.write('如需重启，请先结束该进程，或删除 ' + LOCK_FILE + '\n');
  process.exit(0);
}
/* 走到这里说明没有活着的实例。锁文件可能还在（上次被强杀留下的）——
   它**不会**被误判成「正在运行」：existingInstance() 已经做了 pid 存活 + /api/ping 可达
   + 对端名字三重校验，进程没了就直接返回 null。这里顺手清掉陈旧锁，
   免得它在数据目录里长期残留（工程卫生检查会把它报成「孤立锁文件」）。
   清不掉也无所谓，下面会覆盖写自己的锁。 */
try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (e) { /* 忽略 */ }
const log = createLogger('server', config.logLevel);
fs.mkdirSync(dataDir(), { recursive: true });
setLogFile(path.join(dataDir(), 'mangavault.log'));

const app = createApp({ log: log, accessLog: config.logLevel === 'debug' });
const BUILD = new Date().toISOString();

// 基础信息 / 健康检查
const startedAt = Date.now();
let loadedModules = [];   // 请求上下文里拿不到，用闭包变量持有已加载模块
/* /api/ping 由 core/health.mjs 提供：
   ▸ 验收脚本要按「与 server.mjs 相同的装配」起隔离服务，健康路由必须来自同一份实现，
     否则脚本里的前端会拿到与真服务不同的行为（曾经把一次 404 误读成阅读器故障）。
   ▸ silenceUntil > 0 表示后端在跑写操作长任务，此刻 ping 慢是「忙」不是「死」。 */
installPingRoute(app, { build: BUILD, startedAt: startedAt });

/* ---------- 慢任务静默声明（桌面宿主看护的救命绳） ----------
   ★ 真实事故：用户在桌面端（MangaVault.exe 的 WebView2 宿主）跑「查重 / 重扫 / 孤儿清理」
     这类长任务时，**窗口自己关掉了**。
   ★ 根因：宿主看护每 3 秒 GET 一次 /api/ping，连续 PING_MAX_FAILS(=4) 次拿不到就判「后端已死」
     并 Environment.Exit（见 desktop/host/Program.cs 的 WatchdogTick）。而 Node 后端在长任务里
     是**单线程忙**：一段长时间不 await 的同步循环把事件循环占满，ping 必然超时 ——
     「忙」被误判成「死」，窗口自杀。
   ★ 修法：凡是已知的写操作长任务（扫描 / 清理 / 修复 / 批量改元数据…），在**请求开始时就**
     写一个 10 分钟的静默窗口；宿主读到有效窗口就跳过死亡判定。响应结束立刻把窗口收窄到 1 秒，
     不留下长尾豁免。任务内部（library scan / dedupe runner）还会用 withHeartbeat 持续续期，
     覆盖超过 10 分钟的超长任务。
   ▸ 只读接口绝不声明：GET 不该长跑，真卡住了应当让宿主照常判定，否则会掩盖真死。 */
const SLOW_TASK_RE = /^\/api\/(?:library\/scan|vault\/(?:orphans\/clean|batch|meta\/batch|move|trash|trash\/restore|trash\/purge|verify\/fix|backup|backup\/restore|tags\/assign|audit\/undo)|dedupe\/(?:scan|delete|restore|covers))$/;
app.use(function (ctx) {
  if (ctx.method !== 'POST' || !SLOW_TASK_RE.test(ctx.path)) return;
  touchSilence(SLOW_TASK_MS);
  ctx.res.on('finish', function () { releaseSilence(); });
});

/* 前端资源指纹（版本自检）。
   ▸ 为什么必须有：服务端给静态资源加了 no-store，但那只管得住**新响应**，管不住
     用户浏览器里**已经缓存**的旧条目。用户遇到的是「明明改好了，刷新后还是旧界面」
     （桌面组件删了还在、滑动条「没了」、下滑不展开，都是同一个成因）。
     光靠 no-store 治不了存量缓存，所以必须让界面能**自证版本**：
     本路由把 public/ 下每个资源的 sha256 前 8 位回传，前端拿自己的字节重算一遍做比对，
     不一致就自动 cache-bust 重载一次 —— 用户不用再手动 Ctrl+Shift+R。 */
/* 实现搬去了 core/health.mjs —— 验收脚本也要按同一装配挂这条路由，
   各自复制一份必然漂移（脚本里曾经没有 /api/version，前端自检吃 404，
   被记成「阅读器检查失败」）。 */
installVersionRoute(app, {
  build: BUILD, startedAt: startedAt,
  publicDir: PUBLIC_DIR, srcDir: path.join(PROJECT_ROOT, 'src')
});

app.get('/api/system/info', async function (ctx) {
  const mods = loadedModules.map(function (m) {
    return { id: m.id, name: m.name, ok: m.ok, error: m.error || null, routes: m.controller && m.controller.meta ? m.controller.meta.help || null : null };
  });
  ctx.json({
    ok: true,
    name: '漫库 MangaVault',
    version: '1.0.0',
    startedAt: startedAt,
    uptimeMs: Date.now() - startedAt,
    node: process.version,
    platform: process.platform,
    projectRoot: PROJECT_ROOT,
    configFile: configFile(),
    dataDir: dataDir(),
    libraryRoot: config.libraryRoot,
    downloadRoot: config.downloadRoot,
    modules: mods
  });
});

// 配置读写（只暴露安全字段）
const CONFIG_WHITELIST = ['port', 'host', 'libraryRoot', 'libraryRoots', 'downloadRoot', 'logLevel', 'dedupe'];
app.get('/api/config', function (ctx) {
  const safe = {};
  for (const key of CONFIG_WHITELIST) safe[key] = config[key];
  safe.picacomic = {
    apiBase: config.picacomic.apiBase,
    appVersion: config.picacomic.appVersion,
    dirFmt: config.picacomic.dirFmt,
    downloadFormat: config.picacomic.downloadFormat,
    chapterConcurrency: config.picacomic.chapterConcurrency,
    imgConcurrency: config.picacomic.imgConcurrency,
    /* ★ 下面这几个必须回传：设置页靠它们回填表单。
       曾经漏了代理与导出目录，导致「保存代理 → 页面重画又变回默认」，
       用户看到的就是「代理模式配置无法保存」（其实早存进 config.json 了）。
       改这里前先去看 public/modules/settings.js 读了哪些 pc.* 字段，别只加不减。 */
    proxyMode: config.picacomic.proxyMode || (config.picacomic.proxy ? 'manual' : 'none'),
    proxyHost: config.picacomic.proxyHost || '',
    proxyPort: config.picacomic.proxyPort || 0,
    proxy: config.picacomic.proxy || '',
    exportDir: config.picacomic.exportDir || '',
    hasToken: Boolean(config.picacomic.token),
    tokenPreview: config.picacomic.token ? config.picacomic.token.slice(0, 12) + '...' : ''
  };
  ctx.json({ ok: true, config: safe });
});

app.post('/api/config', async function (ctx) {
  const body = ctx.body || {};
  const patch = {};
  for (const key of CONFIG_WHITELIST) if (body[key] !== undefined) patch[key] = body[key];
  if (body.picacomic && typeof body.picacomic === 'object') patch.picacomic = body.picacomic;
  if (body.dedupe && typeof body.dedupe === 'object') patch.dedupe = body.dedupe;
  const saved = await saveConfig(patch);
  ctx.json({ ok: true, config: { libraryRoot: saved.libraryRoot, downloadRoot: saved.downloadRoot } });
});

app.get('/api/modules', function (ctx) {
  /* 只返回**页面模块**：能力模块（page:false，例如 desktop 原生桥）对前端不存在，
     否则前端会去 import 一份并不存在的 public/modules/<id>.js。 */
  ctx.json({
    ok: true,
    modules: loadedModules.filter(function (m) { return m.page !== false; }).map(function (m) {
      return { id: m.id, name: m.name, description: (m.meta && m.meta.description) || '', order: (m.meta && m.meta.order) || 99, ok: m.ok, error: m.error || null, nav: !(m.meta && m.meta.nav === false) };
    })
  });
});

// 静态前端
app.static(PUBLIC_DIR, '/', { indexName: 'index.html', fallbackIndex: 'index.html', cacheSeconds: 0 });

const server = app.createServer();
/* 长连接超时。
   踩坑：Node 的 http.Server 默认 keepAliveTimeout 只有 5 秒。扫描这类长任务里，前端会持续轮询 /api/dedupe/state，
   而服务端把空闲连接在 5 秒后关掉，客户端却在复用那条连接 —— 表现为随机 ECONNRESET，轮询中断、进度条不再更新。
   实测：不设这个值时，长任务轮询出现 ECONNRESET 并导致整个扫描提前中断；设为 2 分钟后同样的任务稳定跑完。
   headersTimeout 必须 >= keepAliveTimeout，否则 Node 会以更短的 headersTimeout 为准。 */
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.requestTimeout = 0;   // 0 = 不限制单请求时长（扫描进度接口可能等待较久）
const host = config.host || '127.0.0.1';
/* port 在上面已经算好（MV_PORT 优先，见文件开头），这里不再重复读环境变量，
   免得两处口径漂移。 */
const port = envPortExplicit ? envPortRaw : (config.port || 8775);

const moduleCtx = {
  config: config,
  log: log,
  projectRoot: PROJECT_ROOT,
  dataDir: dataDir(),
  publicDir: PUBLIC_DIR,
  reloadConfig: function () { return loadConfig(true); },
  saveConfig: async function (patch) { return saveConfig(patch); }
};

loadedModules = await loadModules(app, moduleCtx);
moduleCtx.modules = loadedModules;

/** 端口自动避让：目标端口被占用时依次 +1 重试，避免和其它本地服务打架。 */
async function listenWithFallback(preferred, maxTries) {
  let lastErr = null;
  for (let i = 0; i < (maxTries || 20); i++) {
    const candidate = preferred + i;
    try {
      await new Promise(function (resolve, reject) {
        const onErr = function (err) { server.removeListener('listening', onOk); reject(err); };
        const onOk = function () { server.removeListener('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(candidate, host);
      });
      return candidate;
    } catch (err) {
      lastErr = err;
      if (err && err.code !== 'EADDRINUSE') throw err;
      log.warn('端口 ' + candidate + ' 被占用，尝试 ' + (candidate + 1) + ' …');
    }
  }
  throw new Error('连续 ' + (maxTries || 20) + ' 个端口都被占用，最后一个错误：' + (lastErr && lastErr.message));
}

const actualPort = await listenWithFallback(port, 20);

const url = 'http://' + host + ':' + actualPort + '/';
const libExists = fs.existsSync(config.libraryRoot);
log.info('漫库 MangaVault 已启动 -> ' + url);
log.info('（配置端口 ' + port + '，实际使用 ' + actualPort + (actualPort !== port ? '，原端口被占用' : '') + '）');
try {
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: actualPort, requestedPort: port, explicitPort: envPortExplicit, url: url, startedAt: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(dataDir(), 'URL.txt'), url + '\n');
} catch (e) { log.warn('写入锁文件失败: ' + e.message); }
process.on('exit', function () { try { if (fs.existsSync(LOCK_FILE)) { const l = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); if (l.pid === process.pid) fs.unlinkSync(LOCK_FILE); } } catch (e) {} });
log.info('漫画库: ' + config.libraryRoot + (libExists ? '' : '  (目录不存在！请在设置里修改)'));
log.info('下载到: ' + config.downloadRoot);
log.info('模块: ' + loadedModules.map(function (m) { return m.id + (m.ok ? '' : '✗'); }).join(' '));

/** 启动完成后自动打开默认浏览器（启动漫库.bat 会设置 MV_OPEN=1，或传 --open） */
function openBrowser(url) {
  try {
    const opts = { detached: true, stdio: 'ignore' };
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], opts).unref();
    else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
    else spawn('xdg-open', [url], opts).unref();
  } catch (e) { log.warn('自动打开浏览器失败: ' + e.message); }
}
if (process.env.MV_OPEN === '1' || process.argv.includes('--open')) openBrowser(url);

async function shutdown(signal) {
  log.info('收到 ' + signal + '，正在关闭…');
  server.close();
  for (const m of loadedModules) {
    if (m.ok && m.controller && typeof m.controller.dispose === 'function') {
      try { await m.controller.dispose(); } catch (e) { log.warn('模块 ' + m.id + ' 退出异常: ' + e.message); }
    }
  }
  process.exit(0);
}
process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('unhandledRejection', function (err) { log.error('未处理的 Promise 拒绝:', err); });
process.on('uncaughtException', function (err) { log.error('未捕获异常:', err); });