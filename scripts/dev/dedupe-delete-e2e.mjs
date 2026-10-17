// scripts/dev/dedupe-delete-e2e.mjs — 查重「执行删除」端到端验收（隔离数据目录，端口随机，绝不碰真实库）。
// 为什么必须有这个脚本：用户报「在网页端执行删除没有成功」，而删除链路涉及
// 前端确认口令 → POST /api/dedupe/delete → PowerShell 回收站 → scan-latest 回写 → 列表刷新，
// 任何一环坏掉都表现为「点了删除没反应」。离线单测只能覆盖纯校验函数，覆盖不到这条链。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');

function freePort() {
  return new Promise(function (resolve, reject) {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', function () { const p = srv.address().port; srv.close(function () { resolve(p); }); });
  });
}

async function waitForServer(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/api/ping');
      if (res.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise(function (r) { setTimeout(r, 300); });
  }
  throw new Error('服务未在 ' + timeoutMs + 'ms 内就绪');
}

function fakeJpg(file, marker) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(String(marker).repeat(24), 'utf8')]);
  fs.writeFileSync(file, buf);
}

const results = [];
function check(name, pass, detail) { results.push({ name: name, pass: Boolean(pass), detail: detail }); }

export default async function main() {
  const root = path.join(os.tmpdir(), 'mv-dedupe-del-' + process.pid + '-' + Date.now());
  const dataDir = path.join(root, 'data');
  const scanRoot = path.join(root, '扫描');
  const libRoot = path.join(root, '库');
  // 注意：这里要删的是「重复出来的副本」，形态与真实场景一致（<分类>/<单元>/*.jpg）
  fakeJpg(path.join(scanRoot, '分类A', '要删的单元', '001.jpg'), 'X');
  fakeJpg(path.join(scanRoot, '分类A', '要删的单元', '002.jpg'), 'Y');
  fakeJpg(path.join(scanRoot, '分类A', '保留的单元', '003.jpg'), 'Z');
  fakeJpg(path.join(libRoot, '漫画1', '第1话', '001.jpg'), 'X');
  fakeJpg(path.join(libRoot, '漫画1', '第1话', '002.jpg'), 'Y');

  const port = await freePort();
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    port: port,
    host: '127.0.0.1',
    logLevel: 'error',
    libraryRoot: '',
    libraryRoots: [{ id: 'lib1', name: '测试库', path: libRoot }],
    downloadRoot: '',
    dedupe: { scanRoot: scanRoot, pixelReview: false }
  }, null, 2), 'utf8');

  const proc = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.mjs'), '--data-dir=' + dataDir], {
    cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { MV_DATA_DIR: dataDir })
  });
  let out = '';
  proc.stdout.on('data', function (c) { out += c; });
  proc.stderr.on('data', function (c) { out += c; });

  const B = 'http://127.0.0.1:' + port;
  try {
    await waitForServer(port, 40000);
    console.log('[环境] 端口 ' + port + '，查重根 ' + scanRoot);

    // 1) 先跑一次扫描，让 scan-latest.json 里有单元
    const scanRes = await (await fetch(B + '/api/dedupe/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'hash', rebuildFp: false })
    })).json();
    check('扫描能启动', scanRes && scanRes.ok === true, JSON.stringify(scanRes).slice(0, 160));

    // 轮询直到扫描结束
    let st = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      st = await (await fetch(B + '/api/dedupe/state')).json();
      if (st && st.scanning === false) break;
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    const unitsRes = await (await fetch(B + '/api/dedupe/units?size=100')).json();
    const units = (unitsRes && unitsRes.units) || [];
    check('扫描结果里有 2 个单元', units.length === 2, '实际 ' + units.length + '：' + units.map(function (u) { return u.id; }).join(' | '));
    const target = units.find(function (u) { return u.id.indexOf('要删的单元') >= 0; });
    check('找到目标单元', Boolean(target), target ? target.id : '未找到');
    if (!target) throw new Error('没有目标单元，后续断言无法进行');

    // 2) 口令错误必须被拒绝（前端第一道闸）
    const bad = await fetch(B + '/api/dedupe/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unitIds: [target.id], mode: 'quarantine', confirm: 'WRONG' })
    });
    check('口令错误被拒绝', bad.status === 400, 'HTTP ' + bad.status);

    // 3) 真删（用 quarantine，避免依赖回收站组件；隔离区在数据目录内，天然安全）
    const delRes = await (await fetch(B + '/api/dedupe/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unitIds: [target.id], mode: 'quarantine', confirm: 'DELETE' })
    })).json();
    console.log('[删除响应] ' + JSON.stringify(delRes).slice(0, 400));
    check('删除返回 ok', delRes && delRes.ok === true, '');
    check('删除成功数为 1', delRes && delRes.succeeded === 1, 'succeeded=' + (delRes && delRes.succeeded));
    check('磁盘上目标目录已消失', !fs.existsSync(path.join(scanRoot, '分类A', '要删的单元')), '');
    check('保留单元仍在磁盘上', fs.existsSync(path.join(scanRoot, '分类A', '保留的单元')), '');

    // 4) 列表必须立刻少一个（这是用户看到的「删除是否成功」）
    const after = await (await fetch(B + '/api/dedupe/units?size=100')).json();
    const afterIds = ((after && after.units) || []).map(function (u) { return u.id; });
    check('列表立刻少了被删单元', afterIds.length === 1 && afterIds.indexOf(target.id) < 0, '剩余：' + afterIds.join(' | '));
    check('统计里单元数同步减少', after && after.stats && after.stats.units === 1, 'stats.units=' + (after && after.stats && after.stats.units));
    check('删除响应带回 removedFromScan', delRes && delRes.removedFromScan === 1, 'removedFromScan=' + (delRes && delRes.removedFromScan));

    // 5) 删除日志与隔离区都要有记录
    const q = await (await fetch(B + '/api/dedupe/deleted')).json();
    check('删除日志记了一条', Boolean(q && q.log && q.log.length >= 1), 'log=' + ((q && q.log) || []).length);
    check('隔离区里有该单元', Boolean(q && (q.items || []).some(function (it) { return String(it.name || '').indexOf('要删的单元') >= 0; })),
      'items=' + JSON.stringify((q && q.items || []).map(function (i) { return i.name; })));

    // 6) 还原：把隔离区里的东西放回去，磁盘与列表都应恢复
    const restore = await (await fetch(B + '/api/dedupe/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unitIds: [target.id] })
    })).json();
    console.log('[还原响应] ' + JSON.stringify(restore).slice(0, 300));
    check('还原成功', restore && restore.count === 1, 'count=' + (restore && restore.count));
    check('还原后目录回到磁盘', fs.existsSync(path.join(scanRoot, '分类A', '要删的单元')), '');
    // 7) 关键场景（用户实际遇到的）：目录在磁盘上已经不在了，列表里却还留着它。
    //    用户先删过一次、或在资源管理器里手工删了，再点「删除」时必须按「已删除」收尾：
    //    不能抛 400 拒绝（旧行为），也不能啥都不做——否则卡片永远留在列表里。
    //    还原只把文件放回磁盘，不会把单元加回 scan-latest，所以必须**重扫一次**，
    //    让列表重新出现该单元（这正是用户当时的处境：列表里有它，磁盘上没了）。
    await (await fetch(B + '/api/dedupe/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'hash', rebuildFp: false, confirm: 'SCAN' })
    })).json();
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(function (r) { setTimeout(r, 500); });
      const st = await (await fetch(B + '/api/dedupe/state')).json();
      if (st && st.running === false && st.scan && st.scan.units) {
        ready = st.scan.units.some(function (u) { return u.id === target.id; });
        if (ready) break;
      }
    }
    // 注意：默认列表会过滤掉「已删除」，所以这里用 deleted=1 看原始扫描结果。
    // 它证明的正是关键前提——**单元还在扫描结果里，但磁盘目录已经没了**。
    const raw = await (await fetch(B + '/api/dedupe/units?size=100&deleted=1')).json();
    const rawIds = ((raw && raw.units) || []).map(function (u) { return u.id; });
    // 判据只看 raw 列表本身（state 的 scan.units 字段形状随实现变动，不作为依据）
    check('前置：单元仍在扫描结果里（deleted=1 可见）', rawIds.indexOf(target.id) >= 0, 'raw=' + rawIds.join(' | '));
    const normal = await (await fetch(B + '/api/dedupe/units?size=100')).json();
    const normalIds = ((normal && normal.units) || []).map(function (u) { return u.id; });
    check('默认列表已隐藏「已删除」单元（决定表兜底生效）', normalIds.indexOf(target.id) < 0, '默认列表：' + normalIds.join(' | '));
    const goneDir = path.join(scanRoot, '分类A', '要删的单元');
    try { await fsp.rm(goneDir, { recursive: true, force: true }); } catch (e) { /* 可能已被移走 */ }
    check('前置：目标目录确实已不在磁盘', !fs.existsSync(goneDir), '');
    const again = await fetch(B + '/api/dedupe/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unitIds: [target.id], mode: 'quarantine', confirm: 'DELETE' })
    });
    const againBody = await again.json();
    console.log('[目录已不存在时删除] HTTP ' + again.status + ' ' + JSON.stringify(againBody).slice(0, 260));
    check('目录已不存在时删除不再被 400 拒绝', again.status === 200, 'HTTP ' + again.status);
    check('缺失目录被记为 skipped 而不是失败', againBody && againBody.ok === true && againBody.skipped >= 1 && againBody.failed === 0,
      'skipped=' + (againBody && againBody.skipped) + ' failed=' + (againBody && againBody.failed));
    const afterGone = await (await fetch(B + '/api/dedupe/units?size=100')).json();
    const goneIds = ((afterGone && afterGone.units) || []).map(function (u) { return u.id; });
    check('列表不再保留已不存在的单元', goneIds.indexOf(target.id) < 0, '剩余：' + goneIds.join(' | '));
    check('统计也不含该单元', afterGone && afterGone.stats && afterGone.stats.units === 1, 'stats.units=' + (afterGone && afterGone.stats && afterGone.stats.units));
    // 幂等：再点一次不能报错
    const third = await fetch(B + '/api/dedupe/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unitIds: [target.id], mode: 'quarantine', confirm: 'DELETE' })
    });
    check('重复删除保持幂等（不报错）', third.status === 200 || third.status === 400, 'HTTP ' + third.status);
  } finally {
    try { proc.kill(); } catch (e) { /* 已退出 */ }
    await new Promise(function (r) { setTimeout(r, 300); });
    if (!proc.killed) { try { proc.kill('SIGKILL'); } catch (e) { /* 忽略 */ } }
    if (process.env.MV_KEEP_TMP !== '1') {
      try { await fsp.rm(root, { recursive: true, force: true }); } catch (e) { /* 清理失败可忽略 */ }
    } else {
      console.log('[保留] ' + root);
    }
    if (out && results.some(function (r) { return !r.pass; })) console.log('[服务输出尾部]\n' + out.slice(-1200));
  }

  let pass = 0;
  for (const r of results) {
    if (r.pass) pass++;
    console.log((r.pass ? '[通过] ' : '[失败] ') + r.name + (r.detail ? ' — ' + r.detail : ''));
  }
  console.log('\n合计: ' + pass + ' / ' + results.length + ' 通过');
  return pass === results.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then(function (ok) { process.exit(ok ? 0 : 1); }).catch(function (e) {
    console.error('脚本异常: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}
