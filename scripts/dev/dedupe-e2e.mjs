// dedupe-e2e.mjs — 查重引擎端到端验证：真图片 -> hash -> pixel -> thumbs
// 用法：node scripts/dev/dedupe-e2e.mjs（自造样本，不碰真实漫画）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const ENGINE = new URL('../../src/modules/dedupe/engine/', import.meta.url);
const { createRunner } = await import(new URL('runner.mjs', ENGINE).href);
const { resolvePaths } = await import(new URL('paths.mjs', ENGINE).href);
const { readScan } = await import(new URL('store.mjs', ENGINE).href);

const root = path.join(os.tmpdir(), 'mv-e2e-' + Date.now());
const genFile = path.join(root, 'gen.py');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(genFile, fs.readFileSync(new URL('./dedupe-gen.py', import.meta.url), 'utf8'), 'utf8');
const g = spawnSync('python', [genFile, root], { encoding: 'utf8' });
console.log('生成样本:', g.status, (g.stdout || '').trim(), (g.stderr || '').trim().slice(0, 300));

const dataDir = path.join(root, 'data');
const config = { logLevel: 'warn', dedupe: { scanRoot: path.join(root, 'scan'), libRoot: path.join(root, 'lib'), pixelThreshold: 8, thumbCount: 6, pixelReview: true } };
const paths = resolvePaths(config, dataDir);
const runner = createRunner({ getPaths: () => resolvePaths(config, dataDir), cwd: process.cwd(), log: { info() {}, warn() {}, error(m) { console.log('LOG-ERR', m); }, debug() {} } });

const events = [];
const client = { closed: false, send(e, d) { events.push([e, d]); }, onClose() {} };
runner.addClient(client);

const done = new Promise(function (resolve) {
  const iv = setInterval(function () {
    const last = events[events.length - 1];
    if (last && (last[0] === 'done' || last[0] === 'error')) { clearInterval(iv); resolve(last); }
  }, 120);
  setTimeout(function () { clearInterval(iv); resolve(['timeout', null]); }, 180000);
});

console.log('启动 full 扫描…');
const started = await runner.start({ stage: 'full' });
console.log('start ->', JSON.stringify(started));
const [ev, payload] = await done;
console.log('最终事件:', ev);
console.log('结果:', JSON.stringify(payload && { ok: payload.ok, stage: payload.stage, summary: payload.summary, degraded: payload.degraded, elapsedMs: payload.elapsedMs, reclaimable: payload.reclaimable, duplicateUnits: payload.duplicateUnits, error: payload.error }, null, 1));

const progress = events.filter(function (e) { return e[0] === 'progress'; });
console.log('progress 事件数:', progress.length);
for (const p of progress.filter(function (e, i) { return i % Math.max(1, Math.floor(progress.length / 8)) === 0; })) {
  const d = p[1];
  console.log('  [' + String(d.percent).padStart(3) + '%] ' + d.stage + '/' + d.phase + ' ' + d.current + '/' + d.total + ' ' + d.message);
}

const scan = await readScan(paths);
console.log('scan.units:');
for (const u of (scan.units || [])) {
  console.log('  ' + u.id + ' | ' + u.judge + ' | exact=' + u.exactCount + ' pixel=' + u.pixelCount + '/' + u.dupCount + ' | lib=' + (u.comic || '-') + '::' + (u.chapterTitle || '-') + ' | maxMad=' + u.maxMad + ' | matchBy=' + u.matchBy);
}
console.log('汇总:', JSON.stringify(scan.汇总));
console.log('库:', JSON.stringify(scan.库), '查重:', JSON.stringify(scan.查重));
const thumbDir = path.join(dataDir, 'dedupe', 'thumbs');
let thumbCount = 0;
for (const dir of fs.readdirSync(thumbDir)) { thumbCount += fs.readdirSync(path.join(thumbDir, dir, 'dup')).length; }
console.log('缩略图 dup 侧数量:', thumbCount);
console.log('fp-lib index:', fs.existsSync(path.join(dataDir, 'dedupe', 'tmp', 'fp-lib', 'index.json')));
console.log('样本目录:', root);