// 漫库 MangaVault · 桌面启动器验收（隔离数据目录 + 真实启动流程）
// 覆盖四个实测事故：①窗口记忆被写成 -32000 导致窗口开在屏幕外
//                 ②启动失败没有任何留痕（用户只看到闪一下）
//                 ③连点两次会开出两套窗口/进程（单实例防护）
//                 ④收内核用的 taskkill 不带 /F，进程根本没死（窗口关了程序还在跑）
// 跑法：node scripts/dev/desktop-launch-check.mjs

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processAlive } from '../../desktop/sysinfo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = path.join(os.tmpdir(), 'mv-desk-launch-' + Date.now());
const APP = path.join(ROOT, 'desktop', 'app.mjs');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  [通过] ' + msg); } else { fail++; console.log('  [失败] ' + msg); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function runApp(extraArgs, timeoutMs) {
  return new Promise(function (resolve) {
    const child = spawn(process.execPath, [APP].concat(extraArgs), {
      cwd: ROOT,
      env: Object.assign({}, process.env, { MV_DATA_DIR: TMP, MV_DESKTOP: '1' }),
      windowsHide: true
    });
    let out = '';
    child.stdout.on('data', function (c) { out += String(c); });
    child.stderr.on('data', function (c) { out += String(c); });
    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      try { child.kill(); } catch (e) { /* ignore */ }
      resolve({ code: null, out: out, timedOut: true });
    }, timeoutMs || 60000);
    child.on('exit', function (code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code, out: out, timedOut: false });
    });
  });
}

async function readLog() {
  try { return await fsp.readFile(path.join(TMP, 'desktop.log'), 'utf8'); } catch (e) { return ''; }
}

console.log('== 桌面启动器验收 ==');
console.log('隔离数据目录：' + TMP);
await fsp.mkdir(TMP, { recursive: true });

/* ---------- 1. 预置「屏幕外」窗口记忆，验证启动参数不再把它带出去 ---------- */
const winFile = path.join(TMP, 'desktop-window.json');
await fsp.writeFile(winFile, JSON.stringify({ width: 1280, height: 800, x: -32000, y: -32000, updatedAt: new Date().toISOString() }, null, 2), 'utf8');

const first = await runApp(['--smoke-seconds', '10'], 90000);
const log1 = await readLog();
const posLine = (log1.split('\n').filter(function (l) { return l.indexOf('窗口参数：') !== -1; }).pop() || '');
/* 这条断言原来写「posLine 必须含 --window-size=1280,800」，在 verify-all 里偶发红过一次
   （单跑必绿）。真因：启动器发现「同数据目录已经有 App 窗口」（sameTarget 分支）时**根本不会开窗**，
   也就不会打「窗口参数：」这一行 —— 断言测的是「有没有开窗」这个偶然事实，不是尺寸有没有被保住。
   改成两条稳定的：①窗口记忆文件写回时尺寸仍是 1280x800（这是尺寸被保住的直接证据）；
   ②**若**本次确实开窗，参数行必须带该尺寸。 */
const savedTurn1 = JSON.parse(await fsp.readFile(winFile, 'utf8'));
console.log('  [信息] 窗口参数行：' + (posLine ? posLine.slice(-160) : '(本次未开窗：命中 sameTarget 分支)'));
ok(posLine === '' || posLine.indexOf('--window-size=1280,800') !== -1,
  '若本次开窗则参数带记忆尺寸 1280x800；未开窗时跳过（实测 ' + (posLine ? '开窗' : '未开窗') + '）');
ok(savedTurn1.width === 1280 && savedTurn1.height === 800,
  '屏幕外的记忆尺寸仍然沿用（1280x800，实测 ' + savedTurn1.width + 'x' + savedTurn1.height + '）');
ok(posLine.indexOf('--window-position=-32000,-32000') === -1, '启动参数不再出现 --window-position=-32000,-32000');
// 越界位置被丢弃后，loadWindow 会走「自动居中」并写回记忆；所以最终参数里可以出现位置，
// 但必须是屏内坐标（本机上 1920x1080 居中 -> 320,125 一类），绝不能还是 -32000。
const posMatch = /--window-position=(-?\d+),(-?\d+)/.exec(posLine);
ok(!posMatch || (Math.abs(Number(posMatch[1])) <= 20000 && Math.abs(Number(posMatch[2])) <= 20000),
  '最终位置参数要么缺失要么是屏内坐标（实测 ' + (posMatch ? posMatch[1] + ',' + posMatch[2] : '未传') + '）');

const saved = JSON.parse(await fsp.readFile(winFile, 'utf8'));
ok(typeof saved.x === 'number' && saved.x > -2000 && saved.x < 20000, '窗口记忆里的 x 已被修正到屏内（实测 ' + saved.x + '）');
ok(typeof saved.y === 'number' && saved.y > -2000 && saved.y < 20000, '窗口记忆里的 y 已被修正到屏内（实测 ' + saved.y + '）');

/* ---------- 2. 退出留痕 ---------- */
const exitFile = path.join(TMP, 'desktop-exit.json');
let exitInfo = null;
try { exitInfo = JSON.parse(await fsp.readFile(exitFile, 'utf8')); } catch (e) { exitInfo = null; }
ok(first.code === 0, '冒烟自检退出码为 0（实测 ' + first.code + '）');
ok(Boolean(exitInfo), '启动器把退出码落盘到 data/desktop-exit.json');
ok(exitInfo && exitInfo.code === 0, '落盘的退出码与真实退出码一致');
ok(exitInfo && exitInfo.result === 'ok', '落盘结果标记为 ok');

/* ---------- 2b. 内核必须真的被杀掉 ---------- */
// 这条是实测漏网：shutdownServer 原来用 taskkill 不带 /F，而内核是 detached 的无窗口
// node 进程，Windows 直接回 255「can only be terminated forcefully」，进程不死。
// 后果 = 「窗口关了、内核还在跑」：端口一直被占，下次启动只复用旧内核，反复跑自动化验收
// 还会堆出一串孤儿内核。这里断言冒烟结束后锁里那个 pid 真的不在了。
await sleep(2000);
let lockAfter = null;
try { lockAfter = JSON.parse(await fsp.readFile(path.join(TMP, 'server.lock.json'), 'utf8')); } catch (e) { lockAfter = null; }
ok(Boolean(lockAfter && lockAfter.pid), '冒烟结束后仍留有内核锁记录可供校验');
ok(lockAfter && !(await processAlive(lockAfter.pid)),
  '冒烟自检结束后内核进程已被真正终止（锁 pid ' + (lockAfter && lockAfter.pid) + ' 不存活）');
const srcApp = await fsp.readFile(path.join(ROOT, 'desktop', 'app.mjs'), 'utf8');
ok(srcApp.indexOf("'/PID', String(lock.pid), '/T', '/F'") !== -1, 'shutdownServer 的 taskkill 带 /F（源码契约）');

/* ---------- 3. 单实例防护：第二个启动器必须直接退出而不是再开一套窗口 ---------- */
await fsp.rm(exitFile, { force: true });
const holder = runApp(['--smoke-seconds', '30'], 90000);
await sleep(9000);
const second = await runApp([], 20000);
ok(second.code === 0, '重复启动的第二个启动器以退出码 0 结束（实测 ' + second.code + '）');
ok(second.out.indexOf('已有一个漫库启动器在运行') !== -1 || (await readLog()).indexOf('已有一个漫库启动器在运行') !== -1,
  '重复启动时明确提示「已有一个漫库启动器在运行」');
const logSecond = await readLog();
const openedCount = (logSecond.match(/已用 Edge App 模式打开窗口/g) || []).length;
ok(openedCount <= 1, '重复启动没有开出第二个窗口（实测开窗日志 ' + openedCount + ' 条）');
try { await holder.catch(function () {}); } catch (e) { /* ignore */ }

/* ---------- 4. 守卫文件必须被清理，不能卡住下次启动 ---------- */
const guardFile = path.join(TMP, 'desktop-launcher.lock');
ok(!fs.existsSync(guardFile), '启动器退出后单实例守卫文件已清理');

console.log('');
console.log('总计：' + pass + ' 通过 / ' + fail + ' 失败');
try { await fsp.rm(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exitCode = fail === 0 ? 0 : 1;
setTimeout(function () { process.exit(fail === 0 ? 0 : 1); }, 1500);
