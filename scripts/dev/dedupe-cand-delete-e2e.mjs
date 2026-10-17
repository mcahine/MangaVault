// scripts/dev/dedupe-cand-delete-e2e.mjs —— 候选复核 × 删除 一致性验收（隔离副本，不碰真实数据）。
// 复现用户可见的毛病：「确认重复并删除后，候选复核里那张卡片还在」。
// 做法：把真实的 scan-fast.json / library-index.json 复制到隔离数据目录，查重根换成隔离目录，
// 再走真实 HTTP 路由：读候选 -> 三选确认重复 -> 执行删除 -> 再读候选，断言它消失。
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/core/http.mjs';
import { createLogger } from '../../src/core/log.mjs';
import * as mod from '../../src/modules/dedupe/index.mjs';

/* process.env 在某些受控环境里是空对象 —— 没有兜底时 path.join(undefined, 'MangaVault')
   会拼出相对路径 'MangaVault'，一旦后面 rm/mkdir 就落到仓库根里。 */
const LOCAL = process.env.LOCALAPPDATA || os.homedir();
const REAL = path.join(LOCAL, 'MangaVault');
const dir = path.join(os.tmpdir(), 'mv-cand-delete-e2e');
await fsp.rm(dir, { recursive: true, force: true });
await fsp.mkdir(path.join(dir, 'dedupe'), { recursive: true });
const scanRoot = path.join(dir, '查重根');
await fsp.mkdir(scanRoot, { recursive: true });
process.env.MV_DATA_DIR = dir;

let pass = 0; let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('[通过] ' + msg + (extra === undefined ? '' : ' ' + extra)); }
  else { fail++; console.log('[失败] ' + msg + (extra === undefined ? '' : ' ' + extra)); }
}

// 1) 隔离数据目录：真实配置（库根只读） + 隔离查重根
const rawCfg = JSON.parse(await fsp.readFile(path.join(REAL, 'config.json'), 'utf8'));
rawCfg.dedupe = Object.assign({}, rawCfg.dedupe || {}, { scanRoot: scanRoot });
await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify(rawCfg, null, 2), 'utf8');

// 2) 把真实库索引与快速查重结果搬过来（只读复制，原件不动）
for (const f of ['library-index.json', path.join('dedupe', 'scan-fast.json')]) {
  await fsp.copyFile(path.join(REAL, f), path.join(dir, f));
}
const fast = JSON.parse(await fsp.readFile(path.join(dir, 'dedupe', 'scan-fast.json'), 'utf8'));
const fastUnits = fast.units || [];
ok(fastUnits.length > 0, '隔离副本里有快速查重结果', fastUnits.length + ' 个单元');

// 3) 在隔离查重根下为前两个候选建真实目录（删除只动隔离区）
// 真数据里的候选数会随用户的增删变化（用户把确认过的重复删干净后就只剩 1 个）。
// 本脚本验的是「删除一致性」的链路，不依赖真数据条数——不足两个时在隔离副本里
// 克隆一份凑够两个，真实数据一个字节都不动。
const fastForPicks = fastUnits.slice();
if (fastForPicks.length === 1) {
  const clone = JSON.parse(JSON.stringify(fastForPicks[0]));
  const seg = String(clone.id).split('/');
  seg[0] = seg[0] + '【验收副本】';
  clone.id = seg.join('/');
  clone.name = (clone.name || '') + '（副本）';
  fastForPicks.push(clone);
  fast.units = fastForPicks;
  fast.查重 = Object.assign({}, fast.查重, { 单元数: fastForPicks.length });
  fast.汇总 = Object.assign({}, fast.汇总, { 单元数: fastForPicks.length });
  await fsp.writeFile(path.join(dir, 'dedupe', 'scan-fast.json'), JSON.stringify(fast, null, 2), 'utf8');
}
const picks = fastForPicks.slice(0, 2).map(function (u) { return u.id; });
for (const id of picks) {
  await fsp.mkdir(path.join(scanRoot, id), { recursive: true });
  await fsp.writeFile(path.join(scanRoot, id, '00000001.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
}
ok(picks.length === 2, '已为 2 个候选准备了隔离目录', picks.join(' / ').slice(0, 60));

// 4) 起真实实例（随机端口，不碰 8775）
const log = createLogger('cand-e2e');
const app = createApp({ log: log, accessLog: false });
const cfg = await (await import('../../src/core/config.mjs')).loadConfig(true);
const ctx = {
  config: cfg, log: log, projectRoot: path.resolve(import.meta.dirname, '../..'),
  dataDir: dir, publicDir: path.resolve(import.meta.dirname, '../..', 'public'),
  moduleId: 'dedupe', moduleMeta: {}, reloadConfig: async function () { return cfg; }, saveConfig: async function () {}
};
await mod.register(app, ctx);
const server = app.createServer();
await new Promise(function (res) { server.listen(0, '127.0.0.1', res); });
const port = server.address().port;

async function api(method, p, body) {
  const res = await fetch('http://127.0.0.1:' + port + p, {
    method: method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json: json, text: text };
}

try {
  const c1 = await api('GET', '/api/dedupe/candidates');
  const ids1 = ((c1.json && c1.json.candidates) || []).map(function (x) { return x.unit.id; });
  ok(c1.status === 200 && ids1.length === picks.length, '候选接口返回全部候选（都还没删）', '候选 ' + ids1.length + ' / 待删 ' + picks.length + ' / 真数据 ' + fastUnits.length);
  ok(picks.every(function (id) { return ids1.indexOf(id) >= 0; }), '两个待删候选都在列表里');
  ok(c1.json.hiddenDeleted === 0, '此时没有已删除单元被隐藏', 'hiddenDeleted=' + c1.json.hiddenDeleted);

  const target = picks[0];
  const d = await api('POST', '/api/dedupe/decision', { unitId: target, verdict: 'delete' });
  ok(d.status === 200 && d.json.ok === true, '三选「确认重复（可删）」落盘', 'status=' + d.status);

  const del = await api('POST', '/api/dedupe/delete', { unitIds: [target], mode: 'quarantine', confirm: 'DELETE' });
  ok(del.status === 200 && del.json && del.json.ok === true, '执行删除成功', 'succeeded=' + (del.json && del.json.succeeded) + ' skipped=' + (del.json && del.json.skipped));
  const gone = !(await fsp.stat(path.join(scanRoot, target)).then(function () { return true; }).catch(function () { return false; }));
  ok(gone, '隔离查重根里的该目录确实没了');

  const c2 = await api('GET', '/api/dedupe/candidates');
  const ids2 = ((c2.json && c2.json.candidates) || []).map(function (x) { return x.unit.id; });
  ok(ids2.indexOf(target) < 0, '删除后候选列表里不再出现该单元（用户点完就消失）');
  ok(ids2.length === ids1.length - 1, '候选数只少了被删的那一个', ids1.length + ' -> ' + ids2.length);
  ok(ids2.indexOf(picks[1]) >= 0, '另一个候选不受影响');

  // 隔离区里必须能找回来（删除是可还原的，不是永久删除）
  // 隔离区按「单元 id 的末段目录名」存放（删除链路把整个目录移进去），
  // 所以匹配要用 id 的最后一段，不能拿整条相对路径去比。
  const q = await api('GET', '/api/dedupe/deleted');
  const qItems = (q.json && (q.json.items || q.json.deleted || q.json.entries)) || [];
  const qNames = qItems.map(function (x) { return x && (x.name || x.id); });
  const targetTail = String(target).split('/').pop();
  const restored = qNames.some(function (n) { return String(n) === targetTail || String(n).indexOf(targetTail) >= 0; });
  ok(q.status === 200 && restored, '隔离区里能看到它（可还原）', '隔离区 ' + qNames.length + ' 项：' + JSON.stringify(qNames.slice(0, 3)));

  // 兜底路径：scan-fast.json 里仍留着它、只有决策表标了 deleted 时，候选页也绝不能显示。
  // 覆盖「回写失败 / 文件不同步 / 旧版本遗留」的可见性兜底。
  const mark = await api('POST', '/api/dedupe/decision', { unitId: picks[1], verdict: 'deleted' });
  ok(mark.status === 200 && mark.json.ok === true, '可直接登记「已删除」标记（模拟回写失败的时代遗留）', 'status=' + mark.status);
  const c3 = await api('GET', '/api/dedupe/candidates');
  const ids3 = ((c3.json && c3.json.candidates) || []).map(function (x) { return x.unit.id; });
  ok(ids3.indexOf(picks[1]) < 0, '只有决策标记、文件未回写时，候选页也不显示它（兜底生效）');
  ok(c3.json.hiddenDeleted === 1, '接口如实报告被隐藏的已删除单元数', 'hiddenDeleted=' + c3.json.hiddenDeleted);
} finally {
  server.close();
}

console.log('');
console.log('合计: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
setTimeout(function () { process.exit(process.exitCode); }, 800);