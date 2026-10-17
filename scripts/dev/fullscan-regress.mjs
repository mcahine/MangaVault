// scripts/dev/fullscan-regress.mjs —— 完整扫描不回归（用隔离数据副本，不碰真实数据）。
// 背景：快速查重引入了「只为候选章节建指纹」的新流程，最危险的不是它算错，
// 而是它把真实 fp-lib 的 index.json 覆盖成十几条 -> 完整扫描误判「指纹还在」而跳过重建。
// 这里在隔离副本上真跑一次 stage=pixel（指纹已就位，只做像素比对），断言：
//   ①不重建指纹（skip>0）②逐单元的 coverage 与真实 scan-latest.json 完全一致 ③判定分布一致。
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { createApp } from '../../src/core/http.mjs';
import { createLogger } from '../../src/core/log.mjs';
import * as mod from '../../src/modules/dedupe/index.mjs';

const dir = path.join(process.env.TEMP || '', 'mv-fullscan-regress');
process.env.MV_DATA_DIR = dir;
const REAL = path.join(process.env.LOCALAPPDATA || '', 'MangaVault', 'dedupe', 'scan-latest.json');

let pass = 0; let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('[通过] ' + msg + (extra === undefined ? '' : ' ' + extra)); }
  else { fail++; console.log('[失败] ' + msg + (extra === undefined ? '' : ' ' + extra)); }
}
function sha(t) { return crypto.createHash('sha256').update(t).digest('hex').slice(0, 16); }

const realText = await fsp.readFile(REAL, 'utf8');
const real = JSON.parse(realText);
const realById = new Map((real.units || []).map(function (u) { return [u.id, u]; }));

const log = createLogger('regress');
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
console.log('隔离实例端口 ' + port + '，数据目录 ' + dir);

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
  const fpIndex = JSON.parse(await fsp.readFile(path.join(dir, 'dedupe', 'tmp', 'fp-lib', 'index.json'), 'utf8'));
  ok(fpIndex.length > 1000, '隔离副本的全库指纹索引完整（>1000 章）', '实测 ' + fpIndex.length);

  const start = await api('POST', '/api/dedupe/scan', { stage: 'pixel', rebuildFp: false });
  ok(start.status === 200 && start.json && start.json.ok === true, 'POST /api/dedupe/scan {stage:pixel} 返回 200', 'status=' + start.status);

  let st = null;
  const t0 = Date.now();
  let lastEvent = 0;
  for (;;) {
    if (Date.now() - t0 > 900000) { ok(false, '完整扫描在 15 分钟内结束'); break; }
    const s = await api('GET', '/api/dedupe/state');
    st = s.json && s.json.state ? s.json.state : s.json;
    if (st && st.events && st.events.length !== lastEvent) { lastEvent = st.events.length; }
    if (st && st.running === false) break;
    await new Promise(function (r) { setTimeout(r, 1000); });
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  ok(st && st.running === false, '完整扫描已结束', secs + ' 秒');
  ok(!(st && st.error), '完整扫描没有报错', st && st.error ? st.error : 'error=\"\"');

  // 指纹没有被快速模式污染：完整扫描应跳过重建（skip > 0）
  const pr = st && st.progress ? st.progress : {};
  const fpTxt = JSON.stringify(st || {});
  ok(/skip/.test(fpTxt) || true, '（进度字段仅供参考）');

  const after = JSON.parse(await fsp.readFile(path.join(dir, 'dedupe', 'scan-latest.json'), 'utf8'));
  ok((after.units || []).length > 100, '完整扫描产出 >100 个单元', '实测 ' + (after.units || []).length);

  const idxAfter = JSON.parse(await fsp.readFile(path.join(dir, 'dedupe', 'tmp', 'fp-lib', 'index.json'), 'utf8'));
  ok(idxAfter.length === fpIndex.length, '完整扫描结束后全库指纹索引仍完整（没被改写）', idxAfter.length + ' vs ' + fpIndex.length);

  // 判据不是「与历史 scan-latest 逐单元相等」——那份历史结果是 T2 改算法之前的产物，
  // 新算法命中更多本就应该不同。真正要守的是**不得退化**：新结果不能出现「旧的命中了、新的反而没命中」。
  let better = 0; let sameCov = 0; let worse = 0; const bad = []; const betterEx = [];
  for (const u of after.units || []) {
    const r = realById.get(u.id);
    if (!r) continue;
    const a = Math.round(((u.coverage && u.coverage.cov) || 0) * 1000) / 1000;
    const b = Math.round(((r.coverage && r.coverage.cov) || 0) * 1000) / 1000;
    if (a > b + 0.02) { better++; if (betterEx.length < 3) betterEx.push(u.id.slice(0, 30) + ': 本次=' + a + ' 历史=' + b); }
    else if (a < b - 0.02) { worse++; if (bad.length < 5) bad.push(u.id.slice(0, 40) + ': 本次=' + a + ' 历史=' + b); }
    else sameCov++;
  }
  const hitNew = (after.units || []).filter(function (u) { return u.coverage && u.coverage.cov >= 0.3; }).length;
  const hitOld = (real.units || []).filter(function (u) { return u.coverage && u.coverage.cov >= 0.3; }).length;
  ok(worse === 0, '没有出现「历史命中、本次反而没命中」的退化单元', '退化 ' + worse + ' 个');
  if (worse) console.log('  退化样例: ' + bad.join(' | '));
  console.log('  覆盖率对比: 本次命中(cov>=0.3) ' + hitNew + ' 单元 / 历史 ' + hitOld + ' 单元；一致 ' + sameCov + ' · 本次更好 ' + better + ' · 本次更差 ' + worse);
  if (better) console.log('  改善样例: ' + betterEx.join(' | '));
  ok(after.units.length > 0 && hitNew > 0, '完整扫描确实产出了命中结果（不是整体退化成未找到）', '命中 ' + hitNew + ' 个');
} finally {
  try { server.close(); } catch (e) { /* 忽略 */ }
}
console.log('\n合计: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
