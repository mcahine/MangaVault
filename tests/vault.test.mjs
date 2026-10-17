import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';

export const name = '管理台（标签/批量元数据/搬迁/孤儿/审计）';

/* vault 的存储是惰性创建的（依赖 dataDir() 读 MV_DATA_DIR），
   所以必须在 import 之前把环境变量设好，并且**重新 import**（带缓存破坏参数）
   才能真正隔离到临时目录。 */
async function freshModules(dir) {
  process.env.MV_DATA_DIR = dir;
  const bust = '?t=' + Date.now() + Math.random();
  const base = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'modules', 'vault')).href;
  return {
    storage: await import(base + '/storage.mjs' + bust),
    tags: await import(base + '/tags.mjs' + bust),
    paths: await import(base + '/paths.mjs' + bust),
    derive: await import(base + '/derive.mjs' + bust),
    catalog: await import(base + '/catalog.mjs' + bust)
  };
}

/** 造一个带 2 个库根的假配置 */
function makeCfg(rootA, rootB) {
  return {
    libraryRoot: rootA,
    libraryRoots: [
      { id: 'a', name: '库A', path: rootA, enabled: true },
      { id: 'b', name: '库B', path: rootB, enabled: true }
    ]
  };
}

/** 造样本漫画目录：meta=true 时写 元数据.json，chapters 指定章节目录名与图片数 */
async function makeComic(rootPath, dirName, meta, chapters) {
  const dir = path.join(rootPath, dirName);
  await fsp.mkdir(dir, { recursive: true });
  if (meta) await fsp.writeFile(path.join(dir, '元数据.json'), JSON.stringify(meta), 'utf8');
  for (const ch of (chapters || [])) {
    const chDir = path.join(dir, ch.dir);
    await fsp.mkdir(chDir, { recursive: true });
    for (let i = 1; i <= ch.count; i++) {
      await fsp.writeFile(path.join(chDir, String(i).padStart(3, '0') + '.jpg'), 'x'.repeat(600));
    }
  }
  return dir;
}

/* ============================================================================
   下面是新后端能力的**真 HTTP 测试**（meta-batch / orphan / undo / audit / move）。

   为什么必须起子进程：run-tests.mjs 把所有用例文件放在同一个 Node 进程里顺序执行，
   integration.test.mjs（字母序在我之前）已经把 src 的模块实例加载过一次，
   JsonStore 在构造时就把 dataDir() 固化成了它自己的临时目录 —— 同进程里再 register()
   会把数据写到那个已经删掉的目录，出现串味。
   因此这里 spawn 一个**独立的 node 进程**，从启动那一刻就把 MV_DATA_DIR 指向新临时目录，
   模块图完全干净；所有破坏性操作（搬迁/孤儿清理/撤销）都在这个临时目录里做，
   绝不触碰真实漫画目录。父进程只通过 127.0.0.1:<随机端口> 发 HTTP 请求。
   ============================================================================ */

/** 子进程启动脚本：挂 library + vault，监听 0 端口，把端口写进信号文件 */
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
  "  const log = createLogger('vaulthttp', 'error');",
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

/** 造样本漫画；flat=true 时图片直接躺在漫画目录（L0/L1 形态） */
async function makeComicDir(root, dirName, meta, count, flat) {
  const dir = path.join(root, dirName);
  await fsp.mkdir(dir, { recursive: true });
  if (meta) await fsp.writeFile(path.join(dir, '元数据.json'), JSON.stringify(meta, null, 2), 'utf8');
  const target = flat ? dir : path.join(dir, '1 第一话');
  await fsp.mkdir(target, { recursive: true });
  const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const tail = Buffer.from([0xFF, 0xD9]);
  for (let i = 1; i <= count; i++) {
    const body = Buffer.alloc(900, i);
    await fsp.writeFile(path.join(target, String(i).padStart(3, '0') + '.jpg'), Buffer.concat([head, body, tail]));
  }
  return dir;
}

async function waitForSignal(file, child, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const text = await fsp.readFile(file, 'utf8');
      return JSON.parse(text);
    } catch (e) { /* 还没写出来 */ }
    if (child.exitCode !== null) return { ok: false, error: '子进程提前退出（exitCode=' + child.exitCode + '）' };
    await new Promise(function (r) { setTimeout(r, 150); });
  }
  return { ok: false, error: '等待子进程就绪超时（' + timeoutMs + 'ms）' };
}

/** 等库重扫**真正落到索引文件**上：直接轮询「幽灵条目是否消失」。
   不能只看 /api/library/state 的 scannedAt —— library 的内存值会先更新，
   而 JSON 落盘走 400ms 防抖，此刻读索引文件仍可能是旧的（实测抢跑过两次）。 */
async function waitGhostGone(api) {
  let last = null;
  for (let i = 0; i < 60; i++) {
    const o = await api('/api/vault/orphans');
    last = o.data;
    if (last && last.counts && last.counts.indexOnly === 0) return last;
    await new Promise(function (r) { setTimeout(r, 200); });
  }
  return last;
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

async function runHttpSection(t) {
  const box = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-vault-http-'));
  const dataDir = path.join(box, 'data');
  const libC = path.join(box, 'libC');
  const libD = path.join(box, 'libD');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(libC, { recursive: true });
  await fsp.mkdir(libD, { recursive: true });

  /* 样本：库C 三本（含一本无元数据），库D 一本；另有一本待搬迁 */
  await makeComicDir(libC, '甲漫画', { id: 'c-a', title: '甲漫画', author: '原甲', tags: ['旧标签'] }, 2, false);
  await makeComicDir(libC, '乙图集', null, 3, true);
  await makeComicDir(libD, '丙漫画', { id: 'c-c', title: '丙漫画', author: '原丙' }, 1, false);
  await makeComicDir(libC, '待搬迁', { id: 'c-d', title: '待搬迁' }, 1, false);
  /* 幽灵条目：索引里有、磁盘上没有（改名/删除后没重扫的典型形态） */
  await fsp.writeFile(path.join(dataDir, 'library-index.json'), JSON.stringify({
    version: 1, scannedAt: new Date().toISOString(), root: libC, stats: {},
    comics: [{ id: 'ghost-x', dir: '幽灵漫画', title: '幽灵漫画', images: 3, bytes: 900, hasMeta: false }]
  }), 'utf8');

  const signalFile = path.join(box, 'signal.json');
  const srvFile = path.join(box, 'srv.mjs');
  await fsp.writeFile(srvFile, CHILD_SRC, 'utf8');
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const rootsJson = JSON.stringify([
    { id: 'c', name: '库C', path: libC, enabled: true },
    { id: 'd', name: '库D', path: libD, enabled: true }
  ]);
  const child = spawn(process.execPath, [srvFile, projectRoot, rootsJson, signalFile], {
    stdio: 'ignore',
    env: Object.assign({}, process.env, { MV_DATA_DIR: dataDir })
  });

  try {
    const sig = await waitForSignal(signalFile, child, 30000);
    if (!sig || !sig.ok) {
      t.ok(false, '子进程内服务启动失败：' + ((sig && sig.error) || '未收到就绪信号'));
      return;
    }
    t.ok(true, '隔离子进程内服务就绪（临时数据目录 + 随机端口 ' + sig.port + '）');

    /* 用 node:http 而不是全局 fetch：ui-smoke.test.mjs 会把 globalThis.fetch 换成
       「测试环境禁止联网」的桩（它防的是前端模块偷偷联网），而测试文件按字母序执行、
       vault 排在 ui-smoke 之后 —— 用 fetch 会直接抛「测试环境禁止联网」。
       单独跑 vault 时看不出来，只有跑全量才暴露（已踩过）。 */
    function api(p, opts) {
      const o = opts || {};
      const payload = o.body === undefined ? null : JSON.stringify(o.body);
      return new Promise(function (resolve, reject) {
        const headers = {};
        if (payload !== null) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = http.request({ host: '127.0.0.1', port: sig.port, path: p, method: o.method || 'GET', headers: headers }, function (res) {
          const chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () {
            const text = Buffer.concat(chunks).toString('utf8');
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 200) }; }
            resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: data });
          });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
      });
    }

    const cA = 'c-a';
    const cC = 'c-c';
    const cD = 'c-d';

    /* ---------- 1. 服务与目录清单 ---------- */
    const state = await api('/api/vault/state');
    t.ok(state.ok && state.data.ok === true, 'GET /api/vault/state 返回 ok');
    const list = await api('/api/vault/comics?size=100');
    t.ok(list.ok && list.data.total >= 4, 'GET /api/vault/comics 至少 4 部（实际 ' + list.data.total + '）');
    const yi = list.data.items.find(function (x) { return x.title === '乙图集'; });
    t.ok(Boolean(yi && yi.id), '无元数据的漫画也有 id（目录兜底条目）');

    /* ---------- 2. 批量标签：dryRun 预演 → 执行 → 回读覆盖层 ---------- */
    const tagDry = await api('/api/vault/tags/assign', { method: 'POST', body: { comicIds: [cA], add: ['预演新标签'], dryRun: true } });
    t.ok(tagDry.ok && tagDry.data.dryRun === true, 'POST /api/vault/tags/assign 带 dryRun 返回预演');
    t.ok((tagDry.data.plan.willCreateTags || []).indexOf('预演新标签') >= 0, '预演列出「会新建的标签」');
    t.eq(tagDry.data.plan.count, 1, '预演命中 1 部漫画');
    const tagDryEmpty = await api('/api/vault/tags/assign', { method: 'POST', body: { add: ['x'], dryRun: true } });
    t.eq(tagDryEmpty.data.plan.count, 0, '未勾选时预演命中 0 部');
    t.ok(/勾选/.test(tagDryEmpty.data.plan.note || ''), '未勾选时预演给中文提示');
    const tagNoIds = await api('/api/vault/tags/assign', { method: 'POST', body: { add: ['x'] } });
    t.eq(tagNoIds.status, 400, '未勾选就执行 → HTTP 400');
    t.ok(/请先勾选漫画/.test(tagNoIds.data.error || ''), '未勾选错误信息是中文可读原因');
    const tagNoNames = await api('/api/vault/tags/assign', { method: 'POST', body: { comicIds: [cA] } });
    t.eq(tagNoNames.status, 400, '没填标签就执行 → HTTP 400');
    t.ok(/添加或移除/.test(tagNoNames.data.error || ''), '没填标签错误信息是中文');
    const tagGo = await api('/api/vault/tags/assign', { method: 'POST', body: { comicIds: [cA, cC], add: ['实测新标签'], remove: ['旧标签'] } });
    t.ok(tagGo.ok && tagGo.data.affected === 2, '批量打标命中 2 部（affected=2）');
    t.ok(Boolean(tagGo.data.auditId), '批量打标返回审计编号');
    t.eq(tagGo.data.reversible, true, '批量打标标记为可撤销');
    const afterTag = await api('/api/vault/comics?size=100');
    const rowA = afterTag.data.items.find(function (x) { return x.id === cA; });
    t.ok(Boolean(rowA && rowA.overlay && (rowA.overlay.add || []).indexOf('实测新标签') >= 0), '覆盖层记录了新增标签');
    t.ok(Boolean(rowA && rowA.overlay && (rowA.overlay.remove || []).indexOf('旧标签') >= 0), '覆盖层记录了移除标签');

    /* ---------- 3. 批量元数据：plan → batch → 落盘 → 幂等 ---------- */
    const metaPlan = await api('/api/vault/meta/plan', { method: 'POST', body: { comicIds: [cA, cC], patch: { author: '批量作者', chineseTeam: '批量汉化组' } } });
    t.ok(metaPlan.ok && metaPlan.data.plan.count === 2, 'POST /api/vault/meta/plan 预演 2 部');
    t.ok((metaPlan.data.plan.items[0].diff || []).some(function (d) { return d.field === 'author'; }), '预演差异里包含 author 字段');
    t.eq(metaPlan.data.plan.items[0].next.author, '批量作者', '预演给出修改后的值');
    const metaNoField = await api('/api/vault/meta/plan', { method: 'POST', body: { comicIds: [cA], patch: {} } });
    t.eq(metaNoField.status, 400, '空补丁 → HTTP 400');
    t.ok(/没有要修改的字段/.test(metaNoField.data.error || ''), '空补丁错误信息是中文');
    const metaBadType = await api('/api/vault/meta/plan', { method: 'POST', body: { comicIds: [cA], patch: { author: 123 } } });
    t.eq(metaBadType.status, 400, 'author 传数字 → HTTP 400');
    t.ok(/必须是字符串/.test(metaBadType.data.error || ''), '类型错误信息是中文');
    const metaNoIds = await api('/api/vault/meta/plan', { method: 'POST', body: { patch: { author: 'x' } } });
    t.eq(metaNoIds.status, 400, '没选漫画 → HTTP 400');
    t.ok(/至少一部漫画/.test(metaNoIds.data.error || ''), '没选漫画错误信息是中文');
    const metaBadMode = await api('/api/vault/meta/plan', { method: 'POST', body: { comicIds: [cA], patch: { tags: { mode: 'nope', values: ['x'] } } } });
    t.eq(metaBadMode.status, 400, '数组字段非法 mode → HTTP 400');
    t.ok(/merge \/ set \/ remove/.test(metaBadMode.data.error || ''), '非法 mode 错误信息是中文');
    const metaDry = await api('/api/vault/meta/batch', { method: 'POST', body: { comicIds: [cA], patch: { author: '批量作者' } } });
    t.ok(metaDry.ok && metaDry.data.dryRun === true, 'POST /api/vault/meta/batch 不带 confirm → 只预演');
    const metaGo = await api('/api/vault/meta/batch', { method: 'POST', body: { comicIds: [cA, cC], patch: { author: '批量作者', chineseTeam: '批量汉化组' }, confirm: true } });
    t.ok(metaGo.ok && metaGo.data.result.appliedCount === 2, 'meta/batch 实际修改 2 部');
    t.ok(Boolean(metaGo.data.auditId), 'meta/batch 返回审计编号');
    const metaOnDisk = JSON.parse(await fsp.readFile(path.join(libC, '甲漫画', '元数据.json'), 'utf8'));
    t.eq(metaOnDisk.author, '批量作者', '磁盘 元数据.json 的 author 已更新');
    t.eq(metaOnDisk.chineseTeam, '批量汉化组', '磁盘 元数据.json 的 chineseTeam 已更新');
    t.ok(await exists(path.join(libC, '甲漫画', '元数据.json.bak')), '原文件已备份为 元数据.json.bak');
    const metaAgain = await api('/api/vault/meta/plan', { method: 'POST', body: { comicIds: [cA, cC], patch: { author: '批量作者' } } });
    t.eq(metaAgain.data.plan.count, 0, '写入相同值再次预演 → 0 部待改（幂等）');
    t.eq(metaAgain.data.plan.unchangedCount, 2, '同值预演标出 2 部无变化');
    const metaMerge = await api('/api/vault/meta/plan', { method: 'POST', body: { comicIds: [cA], patch: { tags: { mode: 'merge', values: ['数组标签'] } } } });
    t.ok(metaMerge.ok && metaMerge.data.plan.count === 1, '数组字段 merge 模式可预演');

    /* ---------- 4. 元数据导出 / 导入 ---------- */
    const exp = await api('/api/vault/meta/export');
    t.ok(exp.ok && exp.data.payload.count >= 4, 'GET /api/vault/meta/export 导出全库（≥4 部）');
    t.eq(exp.data.payload.kind, 'vault-comic-meta', '导出载荷带 kind 标识可识别');
    const expOne = await api('/api/vault/meta/export?comicIds=' + encodeURIComponent(cA));
    t.eq(expOne.data.count, 1, '按 comicIds 导出只含 1 部');
    t.ok((expOne.data.payload.comics[0] || {}).meta && expOne.data.payload.comics[0].meta.author === '批量作者', '导出带上磁盘原始 元数据.json');
    const payload = JSON.parse(JSON.stringify(exp.data.payload));
    const target = payload.comics.find(function (x) { return x.comicId === cA; });
    target.author = '导入作者';
    const impDry = await api('/api/vault/meta/import', { method: 'POST', body: { payload: payload } });
    t.ok(impDry.ok && impDry.data.dryRun === true, 'POST /api/vault/meta/import 不带 confirm → 只预演');
    t.ok(impDry.data.plan.count >= 1, '导入预演报出将变更的条数');
    t.ok(Array.isArray(impDry.data.plan.unmatched), '导入预演给出匹配不上的条目列表');
    const impBad = await api('/api/vault/meta/import', { method: 'POST', body: { payload: { notComics: [] } } });
    t.eq(impBad.status, 400, '非法导入载荷 → HTTP 400');
    t.ok(/导入内容必须是/.test(impBad.data.error || ''), '非法导入错误信息是中文');
    const impGo = await api('/api/vault/meta/import', { method: 'POST', body: { payload: payload, confirm: true } });
    t.ok(impGo.ok && impGo.data.result.imported >= 1, 'meta/import 确认后真的导入');
    t.ok(Boolean(impGo.data.auditId), 'meta/import 返回审计编号');
    const metaImported = JSON.parse(await fsp.readFile(path.join(libC, '甲漫画', '元数据.json'), 'utf8'));
    t.eq(metaImported.author, '导入作者', '导入后磁盘 author 变为导入值');

    /* ---------- 5. 审计日志：查询 / 归档 / 边界 ---------- */
    const aud = await api('/api/vault/audit?limit=40');
    t.ok(aud.ok && aud.data.total >= 3, 'GET /api/vault/audit 已记录 ≥3 条（实际 ' + aud.data.total + '）');
    t.ok(Array.isArray(aud.data.actions) && aud.data.actions.length >= 10, '审计接口给出可选动作清单');
    const first = aud.data.items[0];
    t.ok(Boolean(first && first.at && first.actionLabel && first.status), '审计条目含 时间/动作名/结果 三要素');
    t.eq(aud.data.page, 1, '审计日志默认第 1 页');
    const audFilter = await api('/api/vault/audit?action=meta-edit');
    t.ok(audFilter.ok && audFilter.data.items.length >= 1 && audFilter.data.items.every(function (e) { return e.action === 'meta-edit'; }), '按 action=meta-edit 筛选只返回该动作');
    const audPage = await api('/api/vault/audit?limit=2');
    t.eq(audPage.data.items.length, 2, 'limit=2 时每页返回 2 条');
    const arch = await api('/api/vault/audit/archive/' + encodeURIComponent(metaGo.data.auditId));
    t.ok(arch.ok && arch.data.archive && arch.data.archive.json, 'GET /api/vault/audit/archive/:id 取回归档 JSON');
    t.eq(arch.data.archive.json.author, '原甲', '归档里保存的是修改前的旧内容');
    const archMissing = await api('/api/vault/audit/archive/no-such-entry');
    t.eq(archMissing.status, 404, '归档不存在 → HTTP 404');
    t.ok(/审计记录不存在/.test(archMissing.data.error || ''), '归档 404 错误信息是中文');
    const undNow = await api('/api/vault/audit/undoable');
    t.ok(undNow.ok && undNow.data.undoable && undNow.data.undoable.action === 'meta-import', '导入后「最近可撤销」指向 meta-import');
    const undoNoConfirm = await api('/api/vault/audit/undo', { method: 'POST', body: { entryId: metaGo.data.auditId } });
    t.eq(undoNoConfirm.status, 400, '撤销不带 confirm → HTTP 400');
    t.ok(/confirm=true/.test(undoNoConfirm.data.error || ''), '撤销 400 提示需要 confirm');
    const undoImport = await api('/api/vault/audit/undo', { method: 'POST', body: { entryId: impGo.data.auditId, confirm: true } });
    t.ok(undoImport.ok && undoImport.data.result.restored >= 1, '撤销导入至少还原 1 部（其余为新建元数据，如实报失败）');
    t.ok(Array.isArray(undoImport.data.result.failed), '撤销结果带失败明细列表');
    const metaUndone = JSON.parse(await fsp.readFile(path.join(libC, '甲漫画', '元数据.json'), 'utf8'));
    t.eq(metaUndone.author, '批量作者', '撤销导入后磁盘 author 回退到导入前的值');

    /* ---------- 6. 跨库根搬迁：预演（含重名冲突）→ 执行 → 撤销 ---------- */
    const moveOne = await api('/api/vault/move/plan', { method: 'POST', body: { comicIds: [cD], targetRootId: 'd' } });
    t.ok(moveOne.ok && moveOne.data.plan.count === 1, 'POST /api/vault/move/plan 预演 1 部');
    t.eq(moveOne.data.plan.targetRoot.name, '库D', '预演给出目标库根中文名');
    t.eq(moveOne.data.plan.items[0].to, libD, '预演给出目标绝对路径');
    t.eq(moveOne.data.plan.conflictCount, 0, '无重名时冲突数为 0');
    t.eq(moveOne.data.plan.crossDeviceCount, 0, '同一磁盘时跨盘数为 0');
    const moveBadRoot = await api('/api/vault/move/plan', { method: 'POST', body: { comicIds: [cD], targetRootId: 'zzz' } });
    t.eq(moveBadRoot.status, 404, '目标库根不存在 → HTTP 404');
    t.ok(/目标库根不存在/.test(moveBadRoot.data.error || ''), '目标库根不存在错误信息是中文');
    const moveNoIds = await api('/api/vault/move/plan', { method: 'POST', body: { targetRootId: 'd' } });
    t.eq(moveNoIds.status, 400, '搬迁没选漫画 → HTTP 400');
    t.ok(/请选择要搬迁的漫画/.test(moveNoIds.data.error || ''), '搬迁没选漫画错误信息是中文');
    const moveSame = await api('/api/vault/move/plan', { method: 'POST', body: { comicIds: [cC], targetRootId: 'd' } });
    t.eq(moveSame.data.plan.count, 0, '已经在目标库根的漫画不进计划');
    t.ok((moveSame.data.plan.skipped || []).some(function (x) { return /已经在目标库根/.test(x.reason); }), '跳过原因写明「已经在目标库根」');
    await makeComicDir(libD, '待搬迁', { id: 'dup-x', title: '重名占位' }, 1, false);
    const moveConflict = await api('/api/vault/move/plan', { method: 'POST', body: { comicIds: [cD], targetRootId: 'd', collision: 'error' } });
    t.eq(moveConflict.data.plan.count, 0, 'error 策略下重名项不进计划');
    t.ok((moveConflict.data.plan.skipped || []).some(function (x) { return /目标库里已有同名目录/.test(x.reason); }), 'error 策略给出重名中文原因');
    const moveRename = await api('/api/vault/move/plan', { method: 'POST', body: { comicIds: [cD], targetRootId: 'd', collision: 'rename' } });
    t.ok(moveRename.ok && moveRename.data.plan.count === 1, 'rename 策略下重名项进入计划');
    t.eq(moveRename.data.plan.conflictCount, 1, 'rename 策略标出 1 条重名');
    t.ok(moveRename.data.plan.items[0].destDir !== '待搬迁', 'rename 策略给出不冲突的新目录名');
    const moveGo = await api('/api/vault/move', { method: 'POST', body: { comicIds: [cD], targetRootId: 'd', collision: 'rename', confirm: true } });
    t.ok(moveGo.ok && moveGo.data.result.moved === 1, 'POST /api/vault/move 执行搬迁 1 部');
    t.ok(Boolean(moveGo.data.auditId), '搬迁返回审计编号');
    t.eq(moveGo.data.reversible, true, '搬迁标记为可撤销');
    t.ok(!(await exists(path.join(libC, '待搬迁'))), '搬迁后源目录已不存在');
    t.ok(await exists(path.join(libD, moveRename.data.plan.items[0].destDir)), '搬迁后目标目录已就位（自动改名）');
    const undoMove = await api('/api/vault/audit/undo', { method: 'POST', body: { entryId: moveGo.data.auditId, confirm: true } });
    t.ok(undoMove.ok && undoMove.data.result.restored === 1, '撤销搬迁还原 1 部（自动改名场景也必须还原）');
    t.ok(await exists(path.join(libC, '待搬迁')), '撤销后目录回到原库根');
    t.ok(!(await exists(path.join(libD, moveRename.data.plan.items[0].destDir))), '撤销后目标目录已撤走');
    const undoTwice = await api('/api/vault/audit/undo', { method: 'POST', body: { entryId: moveGo.data.auditId, confirm: true } });
    t.eq(undoTwice.status, 409, '对已撤销的操作再撤销 → HTTP 409');
    t.ok(/已经撤销过/.test(undoTwice.data.error || ''), '重复撤销错误信息是中文');
    const undoUnknown = await api('/api/vault/audit/undo', { method: 'POST', body: { entryId: 'no-such-entry', confirm: true } });
    t.eq(undoUnknown.status, 404, '撤销不存在的记录 → HTTP 404');
    t.ok(/没有可撤销的操作/.test(undoUnknown.data.error || ''), '撤销 404 错误信息是中文');

    /* ---------- 7. 孤儿清理（磁盘孤立 / 幽灵条目） ---------- */
    const orph = await api('/api/vault/orphans');
    t.ok(orph.ok && orph.data.counts.indexOnly === 1, 'GET /api/vault/orphans 报出 1 条幽灵条目（索引有磁盘无）');
    t.ok(Boolean(orph.data.indexScannedAt), 'orphans 附带当前索引的扫描时间（用于判断重扫是否真的发生）');
    t.ok(orph.data.counts.diskOnly >= 4, 'orphans 报出磁盘孤立目录（实际 ' + orph.data.counts.diskOnly + ' 部）');
    t.eq(orph.data.counts.total, orph.data.counts.diskOnly + orph.data.counts.indexOnly + orph.data.counts.trashMissing, '总数等于三类之和');
    t.ok((orph.data.indexOnly || []).some(function (x) { return x.dir === '幽灵漫画'; }), '幽灵条目明细含目录名');
    t.ok((orph.data.diskOnly || []).every(function (x) { return x.kind === 'disk-only'; }), '磁盘孤立条目带 kind 标记');
    const cleanDry = await api('/api/vault/orphans/clean', { method: 'POST', body: {} });
    t.ok(cleanDry.ok && cleanDry.data.dryRun === true, 'POST /api/vault/orphans/clean 不带 confirm → 只预演');
    t.eq(cleanDry.data.preview.counts.indexOnly, 1, '清理预演里能看到那 1 条幽灵条目');
    const cleanGo = await api('/api/vault/orphans/clean', { method: 'POST', body: { confirm: true, parts: { diskOnly: false, indexOnly: true, trashMissing: false } } });
    t.ok(cleanGo.ok && cleanGo.data.result.applied === true, '孤儿清理确认后执行');
    t.eq(cleanGo.data.reversible, false, '孤儿清理按设计标记为不可撤销');
    t.ok(Boolean(cleanGo.data.auditId), '孤儿清理返回审计编号');
    t.ok((cleanGo.data.result.report.backups || []).length >= 1, '处理幽灵条目之前先备份了索引文件');
    t.eq(cleanGo.data.result.report.diskOnly, null, '本次只勾了幽灵条目，磁盘孤立目录没被移动');
    t.eq((cleanGo.data.result.report.errors || []).length, 0, '幽灵条目处理没有报错（真的触发了重扫）');
    t.ok(await exists(path.join(dataDir, 'backups', (cleanGo.data.result.report.backups || [])[0] || 'x')), '索引备份文件真的落在 backups 目录里');
    const orphAfter = await waitGhostGone(api);
    t.ok(Boolean(orphAfter && orphAfter.counts), '重扫结果真的写到索引文件（轮询到幽灵条目消失）');
    /* 诊断输出（保留在日志里，便于失败时定位重扫到底有没有落地） */
    const libState = await api('/api/library/state');
    t.log('诊断 library.state: scanning=' + (libState.data && libState.data.scanning) + ' scannedAt=' + (libState.data && libState.data.scannedAt) + ' 索引漫画数=' + ((libState.data && libState.data.stats && libState.data.stats.comics)));
    const idxRaw = JSON.parse(await fsp.readFile(path.join(dataDir, 'library-index.json'), 'utf8'));
    t.log('诊断 索引文件: ' + idxRaw.comics.length + ' 条 → ' + JSON.stringify(idxRaw.comics.map(function (c) { return c.dir + '@' + c.root; })));
    t.log('诊断 磁盘孤立: ' + JSON.stringify((orphAfter.diskOnly || []).map(function (x) { return x.dir + '@' + x.rootId; })));
    t.log('诊断 幽灵条目: ' + JSON.stringify((orphAfter.indexOnly || []).map(function (x) { return x.dir; })));
    t.log('诊断 子进程端口=' + sig.port + ' clean.report.indexOnly=' + JSON.stringify(cleanGo.data.result.report.indexOnly));
    let p8775 = '未监听';
    try { const rr = await fetch('http://127.0.0.1:8775/api/ping'); p8775 = 'HTTP ' + rr.status; } catch (e) { p8775 = '连接失败'; }
    t.log('诊断 8775 端口探测: ' + p8775);
    const logText = await fsp.readFile(path.join(dataDir, 'mangavault.log'), 'utf8').catch(function () { return ''; });
    t.log('诊断 子进程日志尾部: ' + logText.split('\n').slice(-6).join(' | '));
    t.eq(orphAfter.counts.indexOnly, 0, '重扫后幽灵条目归零');
    t.eq(orphAfter.counts.total, 0, '重扫后不再有孤儿（磁盘与索引一致）');
    /* 回归：两个库根出现同名目录（库C/待搬迁 与 库D/待搬迁）时不得算成
       「重复条目 + 错误库根归属 + 磁盘孤立」—— 修 catalog.mjs 之前实测：
       目录视图 3 条（1 条被错误归到库C、1 条真身被误判「磁盘孤立」），
       孤儿清理一执行就会把正常漫画移进回收站。 */
    const sameList = await api('/api/vault/comics?size=100');
    const sameRows = sameList.data.items.filter(function (x) { return x.dir === '待搬迁'; });
    t.eq(sameRows.length, 2, '两库根同名目录各算一条（不重复、不丢失）');
    t.eq(Array.from(new Set(sameRows.map(function (x) { return x.rootId; }))).sort().join(','), 'c,d', '同名目录分别归属正确的库根');
    t.ok(sameRows.every(function (x) { return x.indexed === true; }), '两库根同名目录都进了索引（不再误报磁盘孤立）');
    const cleanEmpty = await api('/api/vault/orphans/clean', { method: 'POST', body: { confirm: true, parts: { diskOnly: false, trashMissing: false } } });
    t.ok(cleanEmpty.ok && cleanEmpty.data.result.applied === false, '没有孤儿时清理是空操作（不谎报成功）');
    t.eq(cleanEmpty.data.result.reason, 'empty', '空操作给出 reason=empty');
    const undoNonReversible = await api('/api/vault/audit/undo', { method: 'POST', body: { entryId: cleanGo.data.auditId, confirm: true } });
    t.eq(undoNonReversible.status, 409, '撤销不可撤销的孤儿清理 → HTTP 409');
    t.ok(/不可撤销/.test(undoNonReversible.data.error || ''), '不可撤销提示是中文');
    const undFinal = await api('/api/vault/audit/undoable');
    t.ok(undFinal.ok && /可撤销/.test(undFinal.data.message || ''), 'undoable 接口给出中文说明文案');
    const audFinal = await api('/api/vault/audit?limit=100');
    t.ok(audFinal.data.total >= 7, '全部流程结束后审计日志 ≥7 条（实际 ' + audFinal.data.total + '）');
    t.ok(audFinal.data.items.some(function (e) { return e.action === 'undo'; }), '撤销动作本身也被记入审计');
    t.log('审计动作序列（旧→新）：' + audFinal.data.items.map(function (e) { return e.action; }).reverse().join(' → '));
  } finally {
    await stopChild(child);
    await fsp.rm(box, { recursive: true, force: true }).catch(function () {});
  }
}

export default async function (t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-vault-test-'));
  const rootA = path.join(dir, 'libA');
  const rootB = path.join(dir, 'libB');
  await fsp.mkdir(rootA, { recursive: true });
  await fsp.mkdir(rootB, { recursive: true });
  const cfg = makeCfg(rootA, rootB);

  const M = await freshModules(dir);
  const { tidySpaces, sanitizeDirName, dirNameIssues, parseOrderPrefix, chapterDirName, normKey } = M.paths;
  const { deriveAutoTags } = M.derive;
  const T = M.tags;

  /* ---------- 1. 路径与命名工具 ---------- */
  t.eq(tidySpaces('  a   b  '), 'a b', 'tidySpaces 压掉首尾与重复空格');
  t.eq(tidySpaces('a\u3000b'), 'a b', 'tidySpaces 把全角空格也算空白');
  t.eq(sanitizeDirName(' 名字 ', 'x'), '名字', 'sanitizeDirName 去首尾空格');
  t.ok(dirNameIssues(' 脏 名字 ').length > 0, 'dirNameIssues 能发现首尾空格');
  t.eq(dirNameIssues('正常名字').length, 0, '正常目录名无问题');
  const parsed = parseOrderPrefix('07 第7話');
  t.eq(parsed.order, 7, 'parseOrderPrefix 解析出序号');
  t.eq(parsed.title, '第7話', 'parseOrderPrefix 同时给出标题');
  t.eq(parseOrderPrefix('无序号'), null, '无序号返回 null');
  const chd = chapterDirName(3, '第3話');
  t.eq(chd, '03 第3話', 'chapterDirName 默认补零到 2 位（' + chd + '）');
  t.eq(chapterDirName(3, '第3話', 3), '003 第3話', 'chapterDirName 支持自定义补零宽度');
  t.eq(normKey('Ａ Ｂ'), normKey('a b'), 'normKey 全角与大小写归一化');

  /* ---------- 2. 标签 CRUD / 合并 / 别名 ---------- */
  const created = T.createTag({ name: '純愛', color: 'red' });
  t.ok(created.created && created.tag.id, '新建标签返回 id');
  const dup = T.createTag({ name: '  純愛 ' });
  t.ok(!dup.created, '同名标签不重复创建（空格归一）');
  t.eq(dup.tag.id, created.tag.id, '复用同一个标签');

  T.updateTag({ id: created.tag.id, aliases: ['纯爱', 'junai'] });
  t.eq(T.findTagRef('纯爱').id, created.tag.id, '别名能反查到标签');
  t.eq(T.findTagRef('JUNAI').id, created.tag.id, '别名大小写不敏感');

  const second = T.createTag({ name: '巨乳', color: 'blue' }).tag;
  const merged = T.mergeTags({ from: second.id, to: created.tag.id });
  t.ok(merged, '合并标签成功');
  t.ok(!T.tagById(second.id), '被合并的标签已移除');
  t.ok(T.tagById(created.tag.id).aliases.indexOf('巨乳') !== -1, '被合并的名字进入目标标签别名');
  await t.throwsAsync(async function () { T.mergeTags({ from: created.tag.id, to: created.tag.id }); }, /不能与自身合并/, '拒绝与自身合并');
  await t.throwsAsync(async function () { T.updateTag({ id: 'nope', name: 'x' }); }, /标签不存在/, '更新不存在的标签报错');
  await t.throwsAsync(async function () { T.createTag({ name: '   ' }); }, /标签名不能为空/, '空标签名报错');

  /* ---------- 3. 自动派生标签 ---------- */
  const comic = {
    id: 'c1', dir: '样本', title: '样本', author: '某作者', chineseTeam: '某汉化组',
    tags: ['純愛', '全彩'], categories: ['短篇'], hasMeta: true, chapterCount: 3, rootId: 'a', rootName: '库A'
  };
  const auto = deriveAutoTags(comic, cfg, { derive: true, skipUnknownTeam: false, rules: { metaTags: true, categories: true, author: true, chineseTeam: true, root: true, chapterCount: true, manualSource: true } });
  const names = auto.map(function (x) { return x.name; });
  t.ok(names.indexOf('純愛') !== -1, '派生：带上元数据里的 tags');
  t.ok(names.some(function (n) { return n.indexOf('作者') !== -1; }), '派生：带作者标签');
  t.ok(names.some(function (n) { return n.indexOf('库A') !== -1; }), '派生：带库根标签');
  t.ok(auto.every(function (x) { return typeof x.group === 'string' && x.group.length > 0; }), '派生标签都带 group 归类（' + Array.from(new Set(auto.map(function (x) { return x.group; }))).join('/') + '）');
  t.ok(auto.every(function (x) { return typeof x.key === 'string'; }), '派生标签都带归一化 key（便于去重）');
  t.eq(auto.filter(function (x) { return x.key === '純愛'; }).length, 1, '同一标签不会重复派生');

  /* 覆盖层：有效标签 = 自动 ∪ 覆盖层（含 remove 抵消） */
  const assigned = T.assignTags(cfg, ['c1'], ['手动标签'], ['純愛'], '测试');
  t.ok(assigned, '批量打标成功');
  const overlay = T.comicOverlay('c1');
  t.ok(overlay.add.indexOf('手动标签') !== -1, '覆盖层记录了 add');
  t.ok(overlay.remove.indexOf('純愛') !== -1, '覆盖层记录了 remove');
  const eff = T.effectiveNames(comic, cfg, T.makeTagEnv());
  t.ok(eff.indexOf('手动标签') !== -1, '有效标签包含覆盖层新增');
  t.ok(eff.indexOf('純愛') === -1, '有效标签已排除被 remove 的自动标签');
  await t.throwsAsync(async function () { T.assignTags(cfg, [], ['x'], []); }, /comicIds 不能为空/, '空 comicIds 报错');

  /* 删除标签会清理覆盖层引用 */
  const tmpTag = T.createTag({ name: '待删除' }).tag;
  T.assignTags(cfg, ['c1'], ['待删除'], []);
  T.deleteTag({ id: tmpTag.id });
  t.ok(T.comicOverlay('c1').add.indexOf('待删除') === -1, '删除标签后覆盖层引用被清理');

  /* ---------- 4. 目录视图：多库根 + 陈旧索引清理 ---------- */
  const { loadCatalog, invalidateCatalog } = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'modules', 'vault', 'catalog.mjs')).href + '?t=' + Date.now());
  await makeComic(rootA, '甲漫画', { id: 'cid-a1', title: '甲漫画', tags: ['純愛'] }, [{ dir: '1 第一话', count: 2 }]);
  await makeComic(rootB, '乙图集', null, [{ dir: '.', count: 3 }]);
  invalidateCatalog();
  const cat1 = await loadCatalog(cfg);
  t.eq(cat1.items.length, 2, '两个库根的漫画都被收录');
  const rootsSeen = new Set(cat1.items.map(function (c) { return c.rootId; }));
  t.ok(rootsSeen.has('a') && rootsSeen.has('b'), '条目带正确的 rootId（a 与 b 都有）');
  const jia = cat1.items.find(function (c) { return c.dir === '甲漫画'; });
  t.eq(jia.title, '甲漫画', '有元数据时用元数据标题');
  t.eq(jia.rootId, 'a', '甲漫画归属库根 a');
  const yiRaw = cat1.items.find(function (c) { return c.dir === '乙图集'; });
  t.eq(yiRaw.rootId, 'b', '乙图集归属库根 b');

  // 目录兜底条目是延迟 hydrate 的（避免每次请求全盘 stat）；这里显式 hydrate 后再断言图片数
  const { hydrateComic } = M.catalog;
  const jiaH = await hydrateComic(cfg, Object.assign({}, jia));
  t.eq(jiaH.images, 2, 'hydrate 后统计出章节图片数');
  t.eq(jiaH.chapterCount, 1, 'hydrate 后统计出章节数');
  t.ok(jiaH.bytes > 0, 'hydrate 后统计出体积');
  const yiH = await hydrateComic(cfg, Object.assign({}, yiRaw));
  t.eq(yiH.images, 3, '单章形态（图片直接躺在目录）hydrate 后也能统计图片数');

  /* 关键回归：目录被改名后，索引陈旧不应导致重复计数
     （真实 bug：改名后「索引旧条目」+「磁盘新目录」被算成两条） */
  await fsp.rename(path.join(rootB, '乙图集'), path.join(rootB, '乙图集改名'));
  invalidateCatalog();
  const cat2 = await loadCatalog(cfg, { force: true });
  t.eq(cat2.items.length, 2, '改名后仍是 2 部（陈旧索引条目被丢弃，不重复计数）');
  t.ok(!cat2.items.some(function (c) { return c.dir === '乙图集'; }), '旧目录名不再出现在目录视图');
  t.ok(cat2.items.some(function (c) { return c.dir === '乙图集改名'; }), '新目录名已出现');

  /* 库根变化必须让缓存立刻失效 */
  const cfg2 = makeCfg(rootA, path.join(dir, 'no-such-root'));
  const cat3 = await loadCatalog(cfg2);
  t.ok(cat3.items.every(function (c) { return c.rootId !== 'b'; }), '库根被移除后不再返回该根条目');

  /* ---------- 5. 搜索与书架条件 ---------- */
  const shelves = M.storage.shelfStore();
  shelves.data.shelves = [{ id: 's1', name: '测试书架', query: { tags: '純愛', mode: 'and' } }];
  t.eq(shelves.data.shelves[0].name, '测试书架', '书架能保存查询条件');
  const q = T.normalizeQuery({ tags: '純愛,全彩', mode: 'and', exclude: 'NTR' });
  t.ok(q && typeof q === 'object', '查询条件可归一化');

  /* ---------- 6. 标签统计与导出导入 ---------- */
  const payload = T.exportTagsPayload();
  t.ok(payload && Array.isArray(payload.tags), '标签导出返回 tags 数组');
  const before = T.listTags().length;
  const imported = T.importTags({ tags: [{ name: '导入的新标签', color: 'cyan', aliases: [] }] }, 'skip');
  t.ok(imported, '标签导入成功');
  t.eq(T.listTags().length, before + 1, '导入后标签数 +1');
  T.importTags({ tags: [{ name: '导入的新标签' }] }, 'skip');
  t.eq(T.listTags().length, before + 1, 'skip 策略下重复导入不新增');

  const legacyAssertions = t.passed + t.failed;

  delete process.env.MV_DATA_DIR;
  await fsp.rm(dir, { recursive: true, force: true });

  /* ---------- 7. 新后端能力的真 HTTP 测试（隔离子进程 + 临时数据目录） ---------- */
  await runHttpSection(t);
  t.log('旧有断言 ' + legacyAssertions + ' 条；本次用例合计 ' + (t.passed + t.failed) + ' 条');
}
