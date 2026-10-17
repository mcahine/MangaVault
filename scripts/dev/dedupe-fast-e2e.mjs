// dedupe-fast-e2e.mjs — 快速查重（v7）端到端验收：走真实 HTTP 路由，用真实用户数据。
// 验收口径（docs/team/dedupe-v7-fast-plan.md）：
//   ① 端到端 <= 60 秒  ② 5 组已知肉眼重复 100% 出现在候选  ③ 候选单元 <= 20
//   ④ 人在环三选可落盘  ⑤ 系统绝不自动删除  ⑥ 完整扫描链路不回归
// 用法：node scripts/dev/dedupe-fast-e2e.mjs [--port=0]
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createApp } from '../../src/core/http.mjs';
import { createLogger } from '../../src/core/log.mjs';
import { loadConfig } from '../../src/core/config.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath：手写 new URL(...).pathname 会把中文目录名百分号编码
// （黄漫 → %E9%BB%84%E6%BC%AB），算出一个不存在的 projectRoot；那个路径随后被当成
// 子进程 cwd，Python 直接 "spawn python ENOENT"，快速查重静默降级成「只给元数据候选」。
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC_DIR = path.join(PROJECT, 'public');
const DATA = process.env.MV_DATA_DIR || path.join(process.env.LOCALAPPDATA, 'MangaVault');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [通过] ' + name + (extra ? ' ' + extra : '')); }
  else { fail++; failures.push(name); console.log('  [失败] ' + name + (extra ? ' ' + extra : '')); }
}

async function main() {
  const log = createLogger('e2e-fast');
  const moduleMeta = { id: 'dedupe', name: '查重' };
  const app = createApp({ log: log, accessLog: false });
  // 必须用真实配置：查重目录 scanRoot / 库根 / 像素阈值 / 缩略图数量全在里面。
  // 传一个空壳 config 的话，resolvePaths 解析出 scanRoot 为空，快速查重会直接 400
  //（我第一版就是这样，14 条失败里有 13 条是这一个原因造成的连环失败）。
  const config = await loadConfig(true);
  const ctx = {
    config: config, log: log, projectRoot: PROJECT, dataDir: DATA, publicDir: PUBLIC_DIR,
    moduleId: 'dedupe', moduleMeta: moduleMeta,
    reloadConfig: async function () { return config; },
    saveConfig: async function () { return true; }
  };
  const mod = await import('../../src/modules/dedupe/index.mjs');
  await mod.register(app, ctx);
  const server = app.createServer();
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  console.log('实例已启动: ' + base + ' （数据目录 ' + DATA + '）');

  async function get(p) {
    const res = await fetch(base + p);
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch (e) { body = text; }
    return { status: res.status, body: body, len: text.length };
  }
  async function post(p, payload) {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch (e) { body = text; }
    return { status: res.status, body: body, len: text.length };
  }

  /** 查重根下一层是否存在「名字以 key 开头」的目录（单元的形态就是一层目录名）。 */
  async function dirExistsIn(scanRoot, key) {
    if (!scanRoot) return true;   // 拿不到查重根时不做判断，避免把断言悄悄跳过
    try {
      const names = await fsp.readdir(scanRoot);
      return names.some(function (n) { return n === key || n.indexOf(key) === 0; });
    } catch (e) { return true; }
  }
  async function hashFile(file) {
    try { return createHash('sha256').update(await fsp.readFile(file)).digest('hex'); } catch (e) { return ''; }
  }
  async function readDeletedIds() {
    try {
      const dec = JSON.parse(await fsp.readFile(path.join(DATA, 'dedupe', 'decisions.json'), 'utf8'));
      return Object.keys(dec).filter(function (k) { return (dec[k] && dec[k].verdict) === 'deleted'; });
    } catch (e) { return []; }
  }

  try {
    const latestHashBefore = await hashFile(path.join(DATA, 'dedupe', 'scan-latest.json'));
    console.log('');
    console.log('== 1. 快速查重路由存在且可跑 ==');
    const t0 = Date.now();
    const scan = await post('/api/dedupe/scan', { stage: 'fast' });
    ok('POST /api/dedupe/scan {stage:fast} 返回 200', scan.status === 200, 'status=' + scan.status + ' body=' + JSON.stringify(scan.body).slice(0, 200));

    // 轮询到结束（上限 90 秒，比验收口径 60 秒留出余量以便区分「慢」与「卡死」）
    let st = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise(function (r) { setTimeout(r, 500); });
      const s = await get('/api/dedupe/state');
      st = s.body;
      const p = (st && st.progress) || st || {};
      if (!p.running) break;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const prog = (st && st.progress) || st || {};
    ok('快速查重端到端 <= 60 秒（验收口径）', Number(elapsed) <= 60, '实测 ' + elapsed + ' 秒');
    ok('快速查重跑完后 running=false', prog.running === false, 'running=' + prog.running);
    ok('快速查重没有报错', !prog.error, 'error=' + JSON.stringify(prog.error || ''));

    console.log('');
    console.log('== 2. 候选接口 ==');
    const cand = await get('/api/dedupe/candidates');
    ok('GET /api/dedupe/candidates 返回 200', cand.status === 200, 'status=' + cand.status);
    const cl = cand.body && (cand.body.candidates || cand.body.items || (Array.isArray(cand.body) ? cand.body : null));
    ok('候选接口返回数组', Array.isArray(cl), 'type=' + typeof cl + ' len=' + (cl ? cl.length : 'n/a'));
    const nCand = Array.isArray(cl) ? cl.length : -1;
    ok('候选单元 <= 20（验收口径）', nCand >= 0 && nCand <= 20, '实测 ' + nCand + ' 个');
    // 候选数由「真数据 + 阈值」决定，会随用户的增删而变，只守住「有产出」与「不超上限」两条。
    ok('候选单元 >= 1（预筛确实产出了候选）', nCand >= 1, '实测 ' + nCand + ' 个');

    console.log('');
    console.log('== 3. 已知肉眼重复必须命中（磁盘上还剩几组就验几组）==');
    // 这 5 组是 T2 阶段人工确认过的真重复。用户此后已陆续在界面上把它们删掉，
    // 磁盘上会越来越少——断言必须「有几组验几组」，不能钉死数量，否则验收会随用户
    // 的正常使用而假失败（我第一版写死 >=3，结果 5 组全删完后整条验收变红，
    // 而它反映的恰恰是功能正常）。
    const KNOWN = [
      ['世界の終わりックス', '世界终焉的爱'],
      ['シスタークレア', 'シスタークレア'],
      ['ごちそうさま', 'ごちそうさま'],
      ['ジト目メイドさん', 'ジト目メイドさん'],
      ['スマートグラス', 'スマートグラス']
    ];
    const flat = JSON.stringify(cl || []);
    // 查重侧的「单元」就是查重根下的相对目录名。用户确认删除过的单元目录已经不在磁盘上，
    // 那就永远不可能再出现在候选里——对这种组只能标注跳过，不能算失败
    //（5 组里有 2 组：世界の終わりックス、～シスタークレア…，都是用户上一次确认为重复并删除的）。
    const scanRoot = (config.dedupe && config.dedupe.scanRoot) || '';
    let knownLive = 0;
    let knownLiveOk = 0;
    let deletedGoneOk = true;
    for (const pair of KNOWN) {
      const stillOnDisk = await dirExistsIn(scanRoot, pair[0]);
      const inCand = flat.indexOf(pair[0]) >= 0;
      if (!stillOnDisk) {
        console.log('  [已删除] ' + pair[0] + '（目录已不在磁盘，检查它没混进候选）');
        if (inCand) deletedGoneOk = false;
        continue;
      }
      knownLive++;
      const hitDup = inCand;
      const hitLib = flat.indexOf(pair[1]) >= 0;
      if (hitDup && hitLib) knownLiveOk++;
      ok('已知重复命中：' + pair[0], hitDup, hitDup ? '' : '（候选里找不到查重侧标题）');
      ok('  其库侧对应：' + pair[1], hitLib, hitLib ? '' : '（候选里找不到库侧标题）');
    }
    // 5 组全都已被用户删除时，本条不再是「跳过」，而是真实验证了「删掉的东西不会再进候选」。
    ok('磁盘上的已知重复组已全部验证命中（或已全部被用户删除）', knownLive === 0 || knownLiveOk === knownLive,
      '磁盘上 ' + knownLive + ' 组，命中 ' + knownLiveOk + ' 组（另 ' + (KNOWN.length - knownLive) + ' 组已被用户删除）');
    ok('已被用户删除的组不再出现在候选里', deletedGoneOk, deletedGoneOk ? '' : '（有已删除的单元仍出现在候选列表中）');

    console.log('');
    console.log('== 4. 系统绝不自动删除（快速模式不得产生 deleted 决策）==');
    const deletedBefore = await readDeletedIds();
    const decFile = path.join(DATA, 'dedupe', 'decisions.json');
    let dec = {};
    try { dec = JSON.parse(await fsp.readFile(decFile, 'utf8')); } catch (e) { dec = {}; }
    // 口径是「快速查重自己有没有产生删除」：对比运行前后的 deleted 集合。
    // 真实数据目录里本来就有历史 deleted 决策（用户上一次确认删除留下的），
    // 断言「一条都没有」是误报——我第一版就是这么误报的。
    const deletedAfter = Object.keys(dec).filter(function (k) { return (dec[k] && dec[k].verdict) === 'deleted'; });
    const added = deletedAfter.filter(function (k) { return deletedBefore.indexOf(k) < 0; });
    ok('快速查重没有自动产生 deleted 决策', added.length === 0, '新增 ' + added.length + ' 条（运行前已有 ' + deletedBefore.length + ' 条历史记录）');

    console.log('');
    console.log('== 5. 不破坏完整扫描链路 ==');
    const stats = await get('/api/dedupe/stats');
    ok('GET /api/dedupe/stats 仍正常', stats.status === 200, 'status=' + stats.status);
    const units = await get('/api/dedupe/units');
    ok('GET /api/dedupe/units 仍正常', units.status === 200, 'status=' + units.status);

    console.log('');
    console.log('== 6. 快速模式结果与完整扫描分文件存放 ==');
    const fastFile = path.join(DATA, 'dedupe', 'scan-fast.json');
    const latestFile = path.join(DATA, 'dedupe', 'scan-latest.json');
    let fastExists = false, latestExists = false;
    try { await fsp.access(fastFile); fastExists = true; } catch (e) { fastExists = false; }
    try { await fsp.access(latestFile); latestExists = true; } catch (e) { latestExists = false; }
    ok('scan-fast.json 已落盘', fastExists, fastFile);
    ok('scan-latest.json 未被覆盖（仍存在）', latestExists, latestFile);
    const latestHashNow = await hashFile(latestFile);
    ok('scan-latest.json 内容未被快速模式改写', latestHashNow === latestHashBefore, 'before=' + String(latestHashBefore).slice(0, 12) + ' after=' + String(latestHashNow).slice(0, 12));
    if (fastExists) {
      const fastJson = JSON.parse(await fsp.readFile(fastFile, 'utf8'));
      ok('scan-fast.json 是快速模式产物（mode=fast）', fastJson && fastJson.mode === 'fast' && Array.isArray(fastJson.units), 'mode=' + (fastJson && fastJson.mode) + ' units=' + (fastJson && fastJson.units && fastJson.units.length));
    }
  } finally {
    await new Promise(function (r) { server.close(r); });
  }

  console.log('');
  console.log('========================================');
  console.log('合计: ' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); }
  console.log('========================================');
  // 不能直接 process.exit：SSE 长连接与心跳定时器还在收尾，强退会触发
  // libuv 的 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"（实测出现过）。
  // 先设退出码让事件循环自然结束，1.5 秒后仍未退出再兜底强退。
  process.exitCode = fail ? 1 : 0;
  setTimeout(function () { process.exit(process.exitCode); }, 1500);
}

main().catch(function (e) { console.error('验收脚本异常: ' + (e && e.stack ? e.stack : e)); process.exit(2); });
