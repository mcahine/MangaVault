#!/usr/bin/env node
/**
 * 孤儿清理 × 库扫描 竞态探针（管理台审计 · task-17）。
 *
 * 背景：vault 测试日志里出现过
 *   clean.report.indexOnly = {"scanning":true,"roots":["库C","库D"],...,"ghostCount":1}
 * 也就是说「孤儿清理」报告自己**把库重扫踢起来之后、扫描还在跑（scanning=true）时**，
 * 同一次清理里的后续步骤（磁盘孤立目录 → 移入回收站）仍在继续执行。
 *
 * 本脚本要回答的问题只有一个：
 *   当库扫描正在进行时执行孤儿清理，会不会把**正常漫画**判成「磁盘孤立」而移进回收站？
 *
 * 做法（每一轮都是全新隔离环境，绝不碰真实漫画目录）：
 *
 *   A 段「索引热 + 扫描进行中」：
 *      先正常扫描一次让索引与磁盘一致，再触发重扫，在 scanning=true 时立刻清理。
 *      —— 复现测试日志里那条 scanning=true 的报告。
 *
 *   B 段「索引缺失 + 扫描进行中」（**决定性场景**）：
 *      索引文件不存在（新库根刚加好 / 首次扫描还没落盘），磁盘上是 150 部正常漫画。
 *      此刻 POST /api/library/scan，并在 scanning=true 时调 /api/vault/orphans/clean。
 *      判定「磁盘孤立」的依据是 loadCatalog 的目录兜底（索引里没有 → indexed=false），
 *      所以索引为空时**全部正常漫画都是「磁盘孤立」**，会被成批移进回收站。
 *
 * 逐轮核对：
 *   · 有没有正常漫画被移进回收站（判定「不安全」的唯一硬标准）
 *   · 磁盘上还剩几部正常漫画 / 回收站里有几部
 *   · 索引被写坏没（JSON 可解析 + 条数是否合理）
 *   · 幽灵条目处理是否留了索引备份
 *
 * 结论口径：
 *   安全         = 任何一轮都没有正常漫画被判孤立
 *   不安全       = 出现「正常漫画 → 回收站」且可稳定复现
 *   无法验证     = 没抢到竞态窗口 / 环境起不来（**不算安全**）
 *
 * 用法：node scripts/dev/vault-orphan-race-check.mjs [--rounds=10] [--comics=60] [--pages=30]
 * 退出码：全部轮次安全 0；出现数据风险 1；环境不满足 2。
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ARGS = process.argv.slice(2);
function arg(name, dflt) {
  const hit = ARGS.find(function (a) { return a.indexOf('--' + name + '=') === 0; });
  return hit ? hit.slice(name.length + 3) : dflt;
}
const ROUNDS = Math.max(1, Number(arg('rounds', '10')) || 10);
const COMICS = Math.max(10, Number(arg('comics', '60')) || 60);
const IMAGES_PER_COMIC = Math.max(1, Number(arg('images', '60')) || 60);
/* 扫描拖长用的「大图」：每张 512 KB，放大「扫描进行中」的时间窗 */
const BIG_IMAGE_BYTES = Math.max(0, Number(arg('bigbytes', String(512 * 1024))) || 0);

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

/* 子进程：挂 library + vault 两个模块，listen(0) 随机端口（绝不占 8775） */
const CHILD_SRC = [
  "import path from 'node:path';",
  "import fsp from 'node:fs/promises';",
  "import os from 'node:os';",
  "import { pathToFileURL } from 'node:url';",
  "",
  "const args = process.argv.slice(2);",
  "const projectRoot = args[0];",
  "const rootsJson = args[1];",
  "const signalFile = args[2];",
  "",
  "function load(rel) { return import(pathToFileURL(path.join(projectRoot, rel)).href); }",
  "",
  "try {",
  "  const { createApp } = await load('src/core/http.mjs');",
  "  const { loadConfig } = await load('src/core/config.mjs');",
  "  const { createLogger, setLogFile } = await load('src/core/log.mjs');",
  "  const dataDirEnv = process.env.MV_DATA_DIR || os.tmpdir();",
  "  setLogFile(path.join(dataDirEnv, 'mangavault.log'));",
  "  const config = await loadConfig(true);",
  "  config.libraryRoots = JSON.parse(rootsJson);",
  "  config.libraryRoot = config.libraryRoots[0].path;",
  "  config.logLevel = 'error';",
  "  const log = createLogger('orphanrace', 'error');",
  "  const app = createApp({ log: log, accessLog: false });",
  "  const base = {",
  "    config: config, log: log, projectRoot: projectRoot, dataDir: dataDirEnv,",
  "    publicDir: path.join(projectRoot, 'public'), moduleId: 'test', moduleMeta: {},",
  "    reloadConfig: async function () { return loadConfig(true); },",
  "    saveConfig: async function () { return config; }",
  "  };",
  "  const ids = ['library', 'vault'];",
  "  for (const id of ids) {",
  "    const mod = await load('src/modules/' + id + '/index.mjs');",
  "    await mod.register(app, Object.assign({}, base, { moduleId: id }));",
  "  }",
  "  const server = app.createServer();",
  "  await new Promise(function (resolve, reject) { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });",
  "  const port = server.address().port;",
  "  config.port = port;",
  "  await fsp.writeFile(signalFile, JSON.stringify({ ok: true, port: port }), 'utf8');",
  "} catch (err) {",
  "  await fsp.writeFile(signalFile, JSON.stringify({ ok: false, error: String((err && err.stack) || err) }), 'utf8').catch(function () {});",
  "  process.exit(1);",
  "}"
].join('\n');

async function exists(p) {
  return fsp.stat(p).then(function () { return true; }).catch(function () { return false; });
}

/** 等子进程写出就绪信号 */
async function waitForSignal(file, child, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { /* 还没写 */ }
    if (child.exitCode !== null) return { ok: false, error: '子进程提前退出（exitCode=' + child.exitCode + '）' };
    await sleep(120);
  }
  return { ok: false, error: '等待子进程就绪超时（' + timeoutMs + 'ms）' };
}

/** 只按自己记下来的 PID 结束子进程（禁止按进程名杀 node） */
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try { child.kill(); } catch (e) { /* 已退出 */ }
  await new Promise(function (resolve) {
    let done = false;
    const finish = function () { if (!done) { done = true; resolve(); } };
    child.once('exit', finish);
    setTimeout(finish, 4000);
  });
}

/** 合法 JPEG 内容（首尾标记齐全），size 控制单张体积 */
function jpegBytes(size) {
  const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const tail = Buffer.from([0xFF, 0xD9]);
  const body = Buffer.alloc(Math.max(1, size - head.length - tail.length), 0x41);
  return Buffer.concat([head, body, tail]);
}

/** 造一部正常漫画：元数据.json + 一个章节目录 + N 张图 */
async function makeComic(root, dirName, id, title, imageCount, imageBytes) {
  const dir = path.join(root, dirName);
  const chDir = path.join(dir, '1 第一话');
  await fsp.mkdir(chDir, { recursive: true });
  await fsp.writeFile(path.join(dir, '元数据.json'), JSON.stringify({ id: id, title: title, author: '审计样本' }, null, 2), 'utf8');
  const buf = jpegBytes(imageBytes);
  for (let i = 1; i <= imageCount; i++) {
    await fsp.writeFile(path.join(chDir, String(i).padStart(3, '0') + '.jpg'), buf);
  }
  return dir;
}

/** 调用一次接口 */
function makeApi(base) {
  return async function api(p, opts) {
    const o = opts || {};
    const init = { method: o.method || 'GET', headers: {} };
    if (o.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
    const res = await fetch(base + p, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, ok: res.ok, data: data };
  };
}

/* ---------------- B 段：索引缺失 + 扫描进行中（决定性场景） ----------------
 *
 * 这一段的判定不依赖时序运气：
 *   「磁盘孤立」= loadCatalog 的目录兜底条目（索引里没有这本 → indexed=false）。
 *   索引文件不存在时，磁盘上**每一部正常漫画**都是兜底条目 → 全是「磁盘孤立」。
 *   于是「扫描进行中 + 立刻孤儿清理」会把整个库移进回收站，而扫描随后落盘，
 *   索引记录的是一个**已经被清空**的库 —— 用户看到的是「我的漫画全没了」。
 *
 * 复现要点：不要先做基线扫描（那会让索引与磁盘一致，diskOnly=0）。
 */
async function staleIndexRound(n) {
  const box = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-orphanrace-stale-'));
  const dataDir = path.join(box, 'data');
  const libA = path.join(box, 'libA');
  const libB = path.join(box, 'libB');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(libA, { recursive: true });
  await fsp.mkdir(libB, { recursive: true });

  const expected = [];
  const half = Math.ceil(COMICS / 2);
  for (let i = 0; i < COMICS; i++) {
    const root = i < half ? libA : libB;
    const dirName = (i < half ? 'A' : 'B') + '-' + String(i).padStart(3, '0') + '-正常漫画';
    await makeComic(root, dirName, 'stale-' + i, '正常漫画 ' + i, IMAGES_PER_COMIC, i < 4 ? BIG_IMAGE_BYTES : 800);
    expected.push({ rootId: i < half ? 'a' : 'b', dir: dirName, title: '正常漫画 ' + i });
  }

  const signalFile = path.join(box, 'signal.json');
  const srvFile = path.join(box, 'srv.mjs');
  await fsp.writeFile(srvFile, CHILD_SRC, 'utf8');
  const rootsJson = JSON.stringify([
    { id: 'a', name: '库A', path: libA, enabled: true },
    { id: 'b', name: '库B', path: libB, enabled: true }
  ]);
  const child = spawn(process.execPath, [srvFile, PROJECT_ROOT, rootsJson, signalFile], {
    stdio: 'ignore',
    env: Object.assign({}, process.env, { MV_DATA_DIR: dataDir })
  });

  const out = { round: n, stage: 'B', box: box, dataDir: dataDir, libA: libA, libB: libB, expected: expected };
  try {
    const sig = await waitForSignal(signalFile, child, 30000);
    if (!sig || !sig.ok) { out.fatal = '子进程启动失败：' + ((sig && sig.error) || '无信号'); return out; }
    const base = 'http://127.0.0.1:' + sig.port;
    out.base = base;
    const api = makeApi(base);

    /* 刻意**不**做基线扫描：索引文件不存在 = 新库根刚加好的真实形态 */
    out.indexAbsentAtStart = !(await exists(path.join(dataDir, 'library-index.json')));
    if (!out.indexAbsentAtStart) { out.skipped = '索引文件意外存在，无法构造「索引缺失」场景'; return out; }

    /* 触发扫描，不等它结束 */
    const scan = await api('/api/library/scan', { method: 'POST', body: {} });
    out.scanStarted = Boolean(scan.ok && scan.data && scan.data.ok === true);
    let sawScanning = false;
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const st = await api('/api/library/state');
      if (st.data && st.data.scanning === true) { sawScanning = true; break; }
      if (st.data && st.data.scanning === false) break;
      await sleep(5);
    }
    out.sawScanning = sawScanning;
    if (!sawScanning) { out.skipped = '没抢到扫描进行中的窗口'; return out; }

    /* 此刻索引为空 → 磁盘上全部正常漫画都会被算成「磁盘孤立」 */
    const catNow = await api('/api/vault/comics?size=500');
    out.catalogAtCleanTotal = (catNow.data && catNow.data.total) || 0;
    out.catalogAtCleanDiskOnly = ((catNow.data && catNow.data.items) || []).filter(function (x) { return !x.indexed; }).length;

    const clean = await api('/api/vault/orphans/clean', { method: 'POST', body: { confirm: true, note: '竞态探针 B 段' } });
    out.cleanStatus = clean.status;
    const result = (clean.data && clean.data.result) || null;
    out.result = result;
    if (result) {
      out.beforeCounts = (result.before && result.before.counts) || null;
      out.beforeDiskOnly = ((result.before && result.before.diskOnly) || []).map(function (x) { return x.dir; });
      out.report = result.report || null;
      out.backups = result.backups || [];
    }

    const tr = await api('/api/vault/trash');
    const items = (tr.data && tr.data.trash && tr.data.trash.items) || [];
    out.trashItems = items.map(function (x) { return { dir: x.dir, title: x.title }; });
    const expectedDirs = new Set(expected.map(function (x) { return x.dir; }));
    out.wronglyTrashed = items.filter(function (x) { return expectedDirs.has(String(x.dir)); }).map(function (x) { return x.dir; });

    const onDiskA = await fsp.readdir(libA).catch(function () { return []; });
    const onDiskB = await fsp.readdir(libB).catch(function () { return []; });
    out.stillOnDisk = expected.filter(function (x) { return (x.rootId === 'a' ? onDiskA : onDiskB).indexOf(x.dir) >= 0; }).length;
    out.expectedCount = expected.length;

    /* 等扫描落盘，再看终态 */
    for (let i = 0; i < 600; i++) {
      const st = await api('/api/library/state');
      if (st.data && st.data.scanning === false) break;
      await sleep(100);
    }
    const finalTrash = await api('/api/vault/trash');
    const finalItems = (finalTrash.data && finalTrash.data.trash && finalTrash.data.trash.items) || [];
    out.finalTrashDirs = finalItems.map(function (x) { return x.dir; });
    out.finalWronglyTrashed = finalItems.filter(function (x) { return expectedDirs.has(String(x.dir)); }).map(function (x) { return x.dir; });
    const a2 = await fsp.readdir(libA).catch(function () { return []; });
    const b2 = await fsp.readdir(libB).catch(function () { return []; });
    out.finalStillOnDisk = expected.filter(function (x) { return (x.rootId === 'a' ? a2 : b2).indexOf(x.dir) >= 0; }).length;

    const idxFile = path.join(dataDir, 'library-index.json');
    out.indexExistsAfter = await exists(idxFile);
    if (out.indexExistsAfter) {
      try {
        const parsed = JSON.parse(await fsp.readFile(idxFile, 'utf8'));
        out.indexParsed = true;
        out.indexComicCount = Array.isArray(parsed.comics) ? parsed.comics.length : -1;
      } catch (e) { out.indexParsed = false; out.indexError = String(e && e.message); }
    }
    return out;
  } catch (err) {
    out.fatal = String((err && err.stack) || err);
    return out;
  } finally {
    await stopChild(child);
    try { await fsp.rm(box, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 句柄延迟 */ }
  }
}

/* ---------------- 单轮 ---------------- */

async function oneRound(n) {
  const box = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-orphanrace-'));
  const dataDir = path.join(box, 'data');
  const libA = path.join(box, 'libA');
  const libB = path.join(box, 'libB');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(libA, { recursive: true });
  await fsp.mkdir(libB, { recursive: true });

  /* 正常漫画：库A 与库B 各一半。它们全部是合法的、有元数据的漫画。 */
  const expected = [];
  const half = Math.ceil(COMICS / 2);
  for (let i = 0; i < COMICS; i++) {
    const root = i < half ? libA : libB;
    const dirName = (i < half ? 'A' : 'B') + '-' + String(i).padStart(3, '0') + '-正常漫画';
    await makeComic(root, dirName, 'race-' + i, '正常漫画 ' + i, IMAGES_PER_COMIC, i < 4 ? BIG_IMAGE_BYTES : 800);
    expected.push({ rootId: i < half ? 'a' : 'b', dir: dirName, title: '正常漫画 ' + i });
  }
  /* 真孤儿：磁盘上有目录、索引里没有（这就是「磁盘孤立」的正样本，清理它是对的） */
  await makeComic(libA, 'ZZ-真孤儿(磁盘孤立)', 'race-orphan', '真孤儿(磁盘孤立)', 2, 800);

  const signalFile = path.join(box, 'signal.json');
  const srvFile = path.join(box, 'srv.mjs');
  await fsp.writeFile(srvFile, CHILD_SRC, 'utf8');
  const rootsJson = JSON.stringify([
    { id: 'a', name: '库A', path: libA, enabled: true },
    { id: 'b', name: '库B', path: libB, enabled: true }
  ]);
  const child = spawn(process.execPath, [srvFile, PROJECT_ROOT, rootsJson, signalFile], {
    stdio: 'ignore',
    env: Object.assign({}, process.env, { MV_DATA_DIR: dataDir })
  });

  const out = { round: n, box: box, base: '', dataDir: dataDir, libA: libA, libB: libB, expected: expected };
  try {
    const sig = await waitForSignal(signalFile, child, 30000);
    if (!sig || !sig.ok) { out.fatal = '子进程启动失败：' + ((sig && sig.error) || '无信号'); return out; }
    const base = 'http://127.0.0.1:' + sig.port;
    out.base = base;
    const api = makeApi(base);

    /* ---- 1. 先正常扫描一次，让索引与磁盘一致（基线） ---- */
    const scan1 = await api('/api/library/scan', { method: 'POST', body: {} });
    if (!scan1.ok || !scan1.data || scan1.data.ok !== true) { out.fatal = '基线扫描未被接受：' + JSON.stringify(scan1.data); return out; }
    let ready = false;
    for (let i = 0; i < 400; i++) {
      const st = await api('/api/library/state');
      if (st.data && st.data.scanning === false && st.data.scannedAt) { ready = true; break; }
      await sleep(100);
    }
    if (!ready) { out.fatal = '基线扫描 40s 内未完成'; return out; }
    const list0 = await api('/api/vault/comics?size=500');
    out.baselineTotal = (list0.data && list0.data.total) || 0;
    out.baselineIndexed = ((list0.data && list0.data.items) || []).filter(function (x) { return x.indexed; }).length;
    if (out.baselineIndexed < COMICS) {
      /* 索引没覆盖全部样本（样本太大 / 扫描器上限）：这一轮不算数 */
      out.skipped = '基线索引只有 ' + out.baselineIndexed + ' 部，少于样本 ' + COMICS + ' 部，本轮跳过';
      return out;
    }

    /* ---- 2. 制造「扫描进行中」：大样本重扫，不等它结束 ---- */
    const rescan = await api('/api/library/scan', { method: 'POST', body: {} });
    out.scanStarted = Boolean(rescan.ok && rescan.data && rescan.data.ok === true);

    /* 抢在扫描还没结束时观测到 scanning=true —— 抢不到就说明这台机器太快，本轮不计入竞态统计 */
    let sawScanning = false;
    const observeUntil = Date.now() + 30000;
    while (Date.now() < observeUntil) {
      const st = await api('/api/library/state');
      if (st.data && st.data.scanning === true) { sawScanning = true; break; }
      if (st.data && st.data.scanning === false) break;
      await sleep(5);
    }
    out.sawScanning = sawScanning;
    if (!sawScanning) {
      out.skipped = '没能在扫描进行中抢到窗口（机器太快或样本太小），本轮不计入竞态统计';
      return out;
    }

    /* ---- 3. 关键一步：扫描进行中，立刻调孤儿清理 ---- */
    const t0 = Date.now();
    const clean = await api('/api/vault/orphans/clean', { method: 'POST', body: { confirm: true, note: '竞态探针' } });
    out.cleanMs = Date.now() - t0;
    out.cleanStatus = clean.status;
    out.cleanOk = Boolean(clean.ok && clean.data && clean.data.ok === true);
    const result = (clean.data && clean.data.result) || null;
    out.result = result;
    if (result) {
      out.report = result.report || null;
      /* 后端报告的「清理前」磁盘孤立清单 —— 用它和真实孤儿比对 */
      out.beforeDiskOnly = ((result.before && result.before.diskOnly) || []).map(function (x) { return x.dir; });
      out.beforeCounts = (result.before && result.before.counts) || null;
      /* 这一条是本审计的核心证据：清理报告是否承认当时扫描还在跑 */
      out.reportIndexOnlyScanning = Boolean(result.report && result.report.indexOnly && result.report.indexOnly.scanning === true);
      out.backups = result.backups || [];
    }

    /* ---- 4. 核对：哪些「正常漫画」被移进回收站了 ---- */
    const trash = await api('/api/vault/trash');
    const items = (trash.data && trash.data.trash && trash.data.trash.items) || [];
    out.trashItems = items.map(function (x) { return { dir: x.dir, title: x.title, rootId: x.rootId }; });

    /* 正常漫画 = 在 expected 名单里的目录名；任何一条出现在回收站里就是数据风险 */
    const expectedDirs = new Set(expected.map(function (x) { return x.dir; }));
    out.wronglyTrashed = items.filter(function (x) { return expectedDirs.has(String(x.dir)); }).map(function (x) { return x.dir; });
    out.orphanTrashed = items.filter(function (x) { return String(x.dir).indexOf('真孤儿') >= 0; }).map(function (x) { return x.dir; });

    /* ---- 5. 核对：磁盘上还剩几部正常漫画 ---- */
    const onDiskA = (await fsp.readdir(libA).catch(function () { return []; }));
    const onDiskB = (await fsp.readdir(libB).catch(function () { return []; }));
    const stillThere = expected.filter(function (x) {
      return (x.rootId === 'a' ? onDiskA : onDiskB).indexOf(x.dir) >= 0;
    }).length;
    out.stillOnDisk = stillThere;
    out.expectedCount = expected.length;

    /* ---- 6. 核对：索引有没有被写坏 ---- */
    const idxFile = path.join(dataDir, 'library-index.json');
    out.indexExistsAfter = await exists(idxFile);
    if (out.indexExistsAfter) {
      try {
        const parsed = JSON.parse(await fsp.readFile(idxFile, 'utf8'));
        out.indexParsed = true;
        out.indexComicCount = Array.isArray(parsed.comics) ? parsed.comics.length : -1;
      } catch (e) {
        out.indexParsed = false;
        out.indexError = String(e && e.message);
      }
    }
    /* 备份：幽灵条目处理前必须留一份索引备份 */
    out.indexBackupPresent = out.backups.length > 0;
    if (out.indexBackupPresent) {
      const bakPath = path.join(dataDir, 'backups', out.backups[0]);
      out.indexBackupExists = await exists(bakPath);
      out.indexBackupBytes = out.indexBackupExists ? (await fsp.stat(bakPath)).size : 0;
    } else {
      out.indexBackupExists = false;
    }

    /* ---- 7. 等这一轮的所有后台活动结束，再复核一次终态 ---- */
    for (let i = 0; i < 400; i++) {
      const st = await api('/api/library/state');
      if (st.data && st.data.scanning === false) break;
      await sleep(100);
    }
    const finalTrash = await api('/api/vault/trash');
    const finalItems = (finalTrash.data && finalTrash.data.trash && finalTrash.data.trash.items) || [];
    out.finalTrashDirs = finalItems.map(function (x) { return x.dir; });
    out.finalWronglyTrashed = finalItems.filter(function (x) { return expectedDirs.has(String(x.dir)); }).map(function (x) { return x.dir; });
    const onDiskA2 = (await fsp.readdir(libA).catch(function () { return []; }));
    const onDiskB2 = (await fsp.readdir(libB).catch(function () { return []; }));
    out.finalStillOnDisk = expected.filter(function (x) {
      return (x.rootId === 'a' ? onDiskA2 : onDiskB2).indexOf(x.dir) >= 0;
    }).length;
    return out;
  } catch (err) {
    out.fatal = String((err && err.stack) || err);
    return out;
  } finally {
    await stopChild(child);
    /* 只清理自己造的临时目录；失败也不影响结论（os.tmpdir 里的残留无副作用） */
    try { await fsp.rm(box, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 句柄延迟 */ }
  }
}

/* ---------------- 主流程 ---------------- */

function line(r) {
  if (r.fatal) return '环境失败：' + String(r.fatal).split('\n')[0];
  if (r.skipped) return '跳过：' + r.skipped;
  if (r.stage === 'B') {
    return '扫描进行中=' + r.sawScanning +
      ' ｜ 清理时目录视图=' + r.catalogAtCleanTotal + ' 部（磁盘孤立 ' + r.catalogAtCleanDiskOnly + '）' +
      ' ｜ 清理报告判定磁盘孤立=' + ((r.beforeCounts && r.beforeCounts.diskOnly) || 0) + ' 部' +
      ' ｜ 正常漫画被移入回收站=' + r.wronglyTrashed.length +
      ' ｜ 残留正常漫画=' + r.finalStillOnDisk + '/' + r.expectedCount;
  }
  return '扫描进行中=' + r.sawScanning +
    ' ｜ 清理报告声称当时在扫描=' + r.reportIndexOnlyScanning +
    ' ｜ 正常漫画被移入回收站=' + r.wronglyTrashed.length +
    ' ｜ 仍留在磁盘=' + r.finalStillOnDisk + '/' + r.expectedCount +
    ' ｜ 清理耗时=' + r.cleanMs + 'ms';
}

const started = Date.now();
console.log('══ 孤儿清理 × 库扫描 竞态探针 ══');
console.log('  轮次 ' + ROUNDS + ' ｜ 每轮样本 ' + COMICS + ' 部正常漫画 × ' + IMAGES_PER_COMIC + ' 图 ｜ 前 4 部大图 ' + Math.round(BIG_IMAGE_BYTES / 1024) + ' KB');
console.log('  隔离：os.tmpdir() 临时数据目录 + 临时库根（绝不触碰真实漫画目录）');
console.log('');

const rowsA = [];
console.log('── A 段：索引已与磁盘一致，扫描进行中执行孤儿清理 ──');
for (let i = 1; i <= ROUNDS; i++) {
  process.stdout.write('  ▸ A ' + i + '/' + ROUNDS + ' … ');
  const r = await oneRound(i);
  rowsA.push(r);
  console.log(line(r));
}

const rowsB = [];
console.log('');
console.log('── B 段：索引缺失（新库根刚加好），扫描进行中执行孤儿清理 ──');
for (let i = 1; i <= ROUNDS; i++) {
  process.stdout.write('  ▸ B ' + i + '/' + ROUNDS + ' … ');
  const r = await staleIndexRound(i);
  rowsB.push(r);
  console.log(line(r));
}

/* ---- 逐轮明细 ---- */
console.log('');
console.log('── 逐轮明细 ──');
for (const r of rowsA) {
  if (r.fatal || r.skipped) { console.log('  A' + r.round + '  ' + line(r)); continue; }
  console.log('  A' + r.round +
    '  扫描进行中=' + r.sawScanning +
    '  清理HTTP=' + r.cleanStatus +
    '  清理报告声称当时在扫描=' + r.reportIndexOnlyScanning +
    '  后端判定磁盘孤立=' + JSON.stringify(r.beforeDiskOnly || []) +
    '  误移入回收站=' + JSON.stringify(r.wronglyTrashed) +
    '  终态误移入=' + JSON.stringify(r.finalWronglyTrashed) +
    '  残留正常漫画=' + r.finalStillOnDisk + '/' + r.expectedCount +
    '  索引可解析=' + r.indexParsed + '(' + r.indexComicCount + ' 条)' +
    '  索引备份=' + (r.indexBackupExists ? r.indexBackupBytes + 'B' : '无'));
}
for (const r of rowsB) {
  if (r.fatal || r.skipped) { console.log('  B' + r.round + '  ' + line(r)); continue; }
  console.log('  B' + r.round +
    '  扫描进行中=' + r.sawScanning +
    '  索引缺失=' + r.indexAbsentAtStart +
    '  清理HTTP=' + r.cleanStatus +
    '  清理时目录视图=' + r.catalogAtCleanTotal + '(磁盘孤立 ' + r.catalogAtCleanDiskOnly + ')' +
    '  报告before.counts=' + JSON.stringify(r.beforeCounts) +
    '  报告report.diskOnly=' + JSON.stringify(r.report && r.report.diskOnly ? { moved: r.report.diskOnly.moved } : null) +
    '  误移入回收站=' + r.wronglyTrashed.length +
    '  终态误移入=' + r.finalWronglyTrashed.length +
    '  残留正常漫画=' + r.finalStillOnDisk + '/' + r.expectedCount +
    '  终态索引条数=' + r.indexComicCount);
}

/* ---- 判定 ---- */
function collect(rows) {
  const usable = rows.filter(function (r) { return !r.fatal && !r.skipped; });
  const wrongly = [];
  for (const r of usable) {
    const dirs = (r.finalWronglyTrashed && r.finalWronglyTrashed.length) ? r.finalWronglyTrashed : (r.wronglyTrashed || []);
    for (const d of dirs) wrongly.push({ stage: r.stage || 'A', round: r.round, dir: d });
  }
  return {
    usable: usable,
    envFailed: rows.filter(function (r) { return r.fatal; }),
    raced: usable.filter(function (r) { return r.sawScanning; }),
    wrongly: wrongly,
    indexBroken: usable.filter(function (r) { return r.indexExistsAfter && r.indexParsed === false; })
  };
}
const A = collect(rowsA);
const B = collect(rowsB);
const usable = A.usable.concat(B.usable);
const envFailed = A.envFailed.concat(B.envFailed);
const racedRounds = A.raced.length + B.raced.length;
const wrongly = A.wrongly.concat(B.wrongly);
const indexBroken = A.indexBroken.concat(B.indexBroken);
const indexShrunk = usable.filter(function (r) {
  return r.indexExistsAfter && Number.isFinite(r.indexComicCount) && r.indexComicCount + 1 < Number(r.baselineIndexed || 0);
});
/* 幽灵条目处理时没留索引备份 = 留退路的承诺没兑现 */
const missingBackup = usable.filter(function (r) {
  return r.beforeCounts && r.beforeCounts.indexOnly > 0 && r.report && r.report.indexOnly && r.indexBackupExists !== true;
});

console.log('');
console.log('── 结论证据 ──');
console.log('  可用轮次              : A ' + A.usable.length + ' / ' + ROUNDS + ' ｜ B ' + B.usable.length + ' / ' + ROUNDS);
console.log('  真正命中「扫描进行中」  : ' + racedRounds + ' 轮（A ' + A.raced.length + ' ｜ B ' + B.raced.length + '）');
console.log('  正常漫画被移入回收站    : ' + wrongly.length + ' 例' +
  (wrongly.length ? '（例：' + wrongly.slice(0, 3).map(function (x) { return x.stage + x.round + '/' + x.dir; }).join('、') + ' …）' : ''));
console.log('    · A 段（索引热）      : ' + A.wrongly.length + ' 例');
console.log('    · B 段（索引缺失）    : ' + B.wrongly.length + ' 例');
console.log('  索引被写坏(JSON 坏)     : ' + indexBroken.length + ' 例');
console.log('  索引条数明显缩水        : ' + indexShrunk.length + ' 例');
console.log('  幽灵清理缺索引备份      : ' + missingBackup.length + ' 例');
console.log('  环境失败轮次            : ' + envFailed.length + ' 例');

let exitCode = 0;
let verdict = '';
if (envFailed.length && !usable.length) {
  verdict = '无法验证：全部 ' + (ROUNDS * 2) + ' 轮环境都没跑起来';
  exitCode = 2;
} else if (wrongly.length || indexBroken.length) {
  verdict = '不安全：扫描进行中执行孤儿清理，会把正常漫画移入回收站（' + wrongly.length + ' 例，B 段' + B.wrongly.length + ' 例）';
  exitCode = 1;
} else if (!racedRounds) {
  verdict = '无法验证：没有任何一轮真正命中「扫描进行中」的窗口';
  exitCode = 2;
} else {
  verdict = '本轮未复现数据损失（A ' + A.raced.length + ' 轮 / B ' + B.raced.length + ' 轮命中扫描窗口）。'
    + '注意：这不等于后端有防护 —— 源码里 cleanOrphans 没有任何 scanning 守卫，见 docs/team/task-17-audit.md。';
  exitCode = 0;
}
console.log('');
console.log('  判定: ' + verdict);
console.log('  用时: ' + ((Date.now() - started) / 1000).toFixed(1) + 's  ·  退出码 ' + exitCode);
if (wrongly.length) {
  console.log('');
  console.log('  最小复现（B 段，人工核对用）：');
  console.log('    1) 建临时库根 A/B，放 N 部正常漫画（每部 元数据.json + 章节目录 + 图片）');
  console.log('    2) 确保临时数据目录里**没有** library-index.json（新库根刚加好的形态）');
  console.log('    3) 起服务（MV_DATA_DIR=<临时目录>），POST /api/library/scan');
  console.log('    4) 在 GET /api/library/state 返回 scanning=true 时，立刻');
  console.log('       POST /api/vault/orphans/clean {"confirm":true}');
  console.log('    5) GET /api/vault/trash —— 全部正常漫画已在回收站里，磁盘库根被清空');
  console.log('    命中条目数：' + wrongly.length + '（前 12 个）：' +
    wrongly.slice(0, 12).map(function (x) { return x.stage + x.round + '/' + x.dir; }).join('、'));
}
console.log('');
process.exit(exitCode);
