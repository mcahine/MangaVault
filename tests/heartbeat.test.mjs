// ============================================================
//  tests/heartbeat.test.mjs —— 长任务心跳（桌面宿主「忙≠死」的契约）
//
//  这个文件守护的是一条真实事故的修复：
//  用户在桌面端跑查重时窗口自己关掉，因为宿主把「后端忙到 ping 不通」误判成「后端已死」。
//  下面既测纯函数的边界，也测真实数据目录里的落盘行为（不碰用户真实数据）。
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = '长任务心跳（桌面宿主忙≠死）';

const mkTmp = function () {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-heartbeat-'));
  process.env.MV_DATA_DIR = d;      // dataDir() 每次求值且优先取它，不需要缓存清空
  return d;
};

export default async function (t) {
  const hb = await import('../src/core/heartbeat.mjs');
  const cfg = await import('../src/core/config.mjs');

  /* ---------- 纯函数：silenceDue ---------- */
  const due = hb.silenceDue(1000000, 60000);
  t.eq(due.until, 1060000, 'silenceDue 的 until = now + ms');
  t.eq(due.ms, 60000, 'silenceDue 回传窗口长度');
  t.ok(typeof due.untilIso === 'string' && due.untilIso.endsWith('Z'), 'untilIso 是可读的 ISO 时间');
  const bad = hb.silenceDue(1000000, -5);
  t.eq(bad.ms, hb.DEFAULT_SILENCE_MS, '非法 ms 回落到默认窗口');

  /* ---------- 纯函数：silenceActive ---------- */
  t.eq(hb.silenceActive({ until: 2000 }, 1000), true, '窗口内判定为有效');
  t.eq(hb.silenceActive({ until: 2000 }, 2000), false, '到点即失效（不留在边界上）');
  t.eq(hb.silenceActive({ until: 2000 }, 3000), false, '过期判定为无效');
  t.eq(hb.silenceActive(null, 1000), false, 'null 状态不算有效');
  t.eq(hb.silenceActive({ until: 'abc' }, 1000), false, '脏数据不算有效');

  /* ---------- 真实落盘：touchSilence + currentSilenceUntil ---------- */
  const dir = mkTmp();
  t.eq(hb.silenceFile(), path.join(dir, 'backend-silence.json'), '静默文件落在数据目录下（与宿主约定一致）');
  hb._resetHeartbeatThrottle();
  hb.touchSilence(60000);
  const raw = JSON.parse(fs.readFileSync(hb.silenceFile(), 'utf8'));
  t.ok(Number.isFinite(raw.until) && raw.until > Date.now(), 'touchSilence 真的写了未来的 until');
  t.ok(hb.currentSilenceUntil() > Date.now(), 'currentSilenceUntil 读到有效窗口');

  /* 节流：5 秒内第二次调用不落盘（避免长任务循环把磁盘写穿） */
  const before = fs.readFileSync(hb.silenceFile(), 'utf8');
  const wrote = hb.touchSilence(120000);
  t.eq(wrote, false, '节流期内不重复落盘');
  t.eq(fs.readFileSync(hb.silenceFile(), 'utf8'), before, '节流期内文件内容不变');

  /* releaseSilence 绕过节流，立刻把窗口收窄到 1 秒 */
  hb.releaseSilence();
  const after = JSON.parse(fs.readFileSync(hb.silenceFile(), 'utf8'));
  t.ok(after.until - Date.now() <= 1200, 'releaseSilence 把窗口收窄到 1 秒内（不留长尾豁免）');

  /* ---------- withHeartbeat：开跑立窗口 / 结束收窗口 ---------- */
  hb._resetHeartbeatThrottle();
  let insideUntil = 0;
  await hb.withHeartbeat(async function () {
    insideUntil = hb.currentSilenceUntil();
    return 'done';
  }, { ms: 60000, stepMs: 10, label: '测试任务' });
  t.ok(insideUntil > Date.now(), '任务执行期间窗口有效（宿主此时不会收摊）');
  t.ok(hb.currentSilenceUntil() - Date.now() <= 1200, '任务结束后窗口立刻收窄');

  /* 任务抛错也必须收窗口，否则错误会留下一个虚假的「还在忙」 */
  hb._resetHeartbeatThrottle();
  let threw = false;
  try {
    await hb.withHeartbeat(async function () { throw new Error('模拟失败'); }, { ms: 60000, stepMs: 10 });
  } catch (e) { threw = true; }
  t.eq(threw, true, 'withHeartbeat 不吞任务异常');
  t.ok(hb.currentSilenceUntil() - Date.now() <= 1200, '任务抛错后窗口同样被收窄');

  /* ---------- 与宿主 Program.cs 的契约：文件名 + 字段名必须对得上 ---------- */
  const host = fs.readFileSync(path.join(import.meta.dirname, '..', 'desktop', 'host', 'Program.cs'), 'utf8');
  t.ok(host.indexOf('SILENCE_FILE = "backend-silence.json"') >= 0, '宿主读的文件名与 heartbeat 导出的 SILENCE_FILE 一致');
  t.ok(host.indexOf('BackendBusy()') >= 0, '宿主的看护确实会查「后端在忙」');
  t.ok(host.indexOf('bool busy = BackendBusy();') >= 0 && host.indexOf('else if (busy)') >= 0, '「忙」分支接管了 ping 失败（不累加到死亡阈值）');
  t.ok(hb.SILENCE_FILE === 'backend-silence.json', 'SILENCE_FILE 常量本身没被改坏');

  /* ---------- 长任务路由必须声明静默（server.mjs 的中间件契约） ---------- */
  const server = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server.mjs'), 'utf8');
  t.ok(server.indexOf('library\\/scan') >= 0 && server.indexOf('SLOW_TASK_RE') >= 0, 'server.mjs 声明了慢任务路由清单');
  t.ok(server.indexOf('touchSilence(SLOW_TASK_MS)') >= 0, '慢任务开始即写静默窗口');
  t.ok(server.indexOf("ctx.res.on('finish'") >= 0, '响应结束立刻收窄窗口');
  t.ok(server.indexOf('installPingRoute(app') >= 0, 'server.mjs 的 /api/ping 走共享实现（验收脚本与真服务行为一致）');
  /* /api/ping 的实体搬去了 core/health.mjs —— 契约断言要跟着搬家，
     否则改一次实现就得到处找「谁还在断言旧字符串」。 */
  const health = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'core', 'health.mjs'), 'utf8');
  t.ok(health.indexOf('silenceUntil: currentSilenceUntil()') >= 0, '/api/ping 回传 silenceUntil 供宿主分辨忙与死');
  t.ok(health.indexOf('/api/version') >= 0 && health.indexOf('frontend') >= 0 && health.indexOf('backend') >= 0,
    'core/health.mjs 同时提供 /api/version（前端版本自检的对照源）');

  /* runner 与 library 扫描也要自己续期（覆盖超过单个窗口的超长任务） */
  const runner = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'modules', 'dedupe', 'engine', 'runner.mjs'), 'utf8');
  t.ok(runner.indexOf('withHeartbeat') >= 0, '查重 runner 用 withHeartbeat 包住长任务');
  const libIdx = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'modules', 'library', 'index.mjs'), 'utf8');
  t.ok(libIdx.indexOf('withHeartbeat') >= 0, '漫画库扫描用 withHeartbeat 包住长任务');
  const vaultIdx = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'modules', 'vault', 'index.mjs'), 'utf8');
  t.ok(vaultIdx.indexOf('withHeartbeat') >= 0, 'vault 长路由（孤儿清理等）声明了心跳');

  /* 临时目录收尾 */
  delete process.env.MV_DATA_DIR;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
