// ============================================================
//  漫库 MangaVault · 长任务心跳（src/core/heartbeat.mjs）
//
//  ★ 背景（真实事故）：桌面端（MangaVault.exe 的 WebView2 宿主）在用户执行
//    「查重 / 重扫 / 孤儿清理」这类长任务时**自己关掉了窗口**。根因是宿主的看护
//    只做一个动作：GET /api/ping，连续 PING_MAX_FAILS(=4) 次拿不到就判定
//    「后端已死」，直接 Environment.Exit —— 于是外壳消失。
//
//    而 Node 后端在长任务期间是**单线程忙**：查重指纹构建、vault 全库重扫都是
//    一段长时间不 await 的同步循环，事件循环被占满，/api/ping 自然超时。
//    也就是说：「忙」被误判成了「死」。
//
//  ★ 修法：让后端在**开始长任务时**写一个「静默窗口」文件，声明
//    「我到 <until> 为止都在忙，ping 不通是正常的，别收摊」。
//    宿主读这个文件，窗口内不做死亡判定。任务结束时不删除文件也没关系 ——
//    文件里的 until 是绝对时间戳，过点即自然失效，不会留下永久豁免。
//
//  零第三方依赖；Windows 上「删除已打开的文件」会抛 EPERM，所以这里只写不删。
// ============================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './config.mjs';

/** 静默窗口文件名（与 desktop/host/Program.cs 里的 SILENCE_FILE 必须是同一个名字） */
export const SILENCE_FILE = 'backend-silence.json';
/** 窗口默认长度：10 分钟。任务还会不断续期，所以这只是一个「单步最长耗时」的上限。 */
export const DEFAULT_SILENCE_MS = 10 * 60 * 1000;
/** 同一进程内两次真正落盘的最小间隔（任务循环里会高频调用，避免把磁盘写穿） */
const WRITE_THROTTLE_MS = 5000;

/** 静默窗口文件的绝对路径；dataDir 可能抛错（未初始化），故用 try 兜底。 */
export function silenceFile() {
  try { return path.join(dataDir(), SILENCE_FILE); } catch (e) { return ''; }
}

/** 从时间戳算出一个带 until 的静默窗口对象（纯函数，便于离线单测）。 */
export function silenceDue(nowMs, ms) {
  const span = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_SILENCE_MS;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return { until: now + span, untilIso: new Date(now + span).toISOString(), ms: span, startedAt: new Date(now).toISOString() };
}

/** 判断某个静默窗口在 nowMs 时是否仍然有效（纯函数）。 */
export function silenceActive(state, nowMs) {
  if (!state || typeof state !== 'object') return false;
  const until = Number(state.until);
  if (!Number.isFinite(until) || until <= 0) return false;
  return until > (Number.isFinite(nowMs) ? nowMs : Date.now());
}

/* ---------- 进程内节流状态 ---------- */
let lastWriteAt = 0;
let lastValue = 0;
let writeChain = Promise.resolve();

/**
 * 写一个 until = now + ms 的静默窗口（同步版，可在同步循环里安全调用）。
 * 节流：同一进程内 5 秒最多真正落一次盘；但**首次调用必定立即落盘**。
 */
export function touchSilence(ms) {
  const span = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_SILENCE_MS;
  const now = Date.now();
  if (now - lastWriteAt < WRITE_THROTTLE_MS) return false;
  lastWriteAt = now;
  lastValue = now + span;
  const file = silenceFile();
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(silenceDue(now, span)), 'utf8');
    return true;
  } catch (e) { return false; }
}

/**
 * 立刻把静默窗口收窄到 1 秒（绕过 5 秒节流）。
 * 任务/请求结束时调用：让宿主尽快恢复「正常看护」，不留下长尾豁免。
 */
export function releaseSilence() {
  lastWriteAt = 0;
  return touchSilence(1000);
}

/** 异步版：等上一次写完再写（并发任务同时续期时不会互相截断）。 */
export function touchSilenceAsync(ms) {
  writeChain = writeChain.then(function () { return touchSilence(ms); }, function () { return touchSilence(ms); });
  return writeChain;
}

/** 当前静默窗口的有效截止时间戳（0 = 没有窗口）。 */
export function currentSilenceUntil() {
  try {
    const raw = fs.readFileSync(silenceFile(), 'utf8');
    const st = JSON.parse(raw);
    return silenceActive(st, Date.now()) ? Number(st.until) : 0;
  } catch (e) { return 0; }
}

/**
 * 把一段长任务包在心跳里：开跑前先立窗口，运行期间每过 stepMs 续期一次。
 * @param {Function} fn 要执行的长任务（返回 Promise）
 * @param {Object} opts { ms, stepMs, label, log }
 */
export async function withHeartbeat(fn, opts) {
  const o = opts || {};
  const ms = Number.isFinite(o.ms) && o.ms > 0 ? o.ms : DEFAULT_SILENCE_MS;
  const stepMs = Number.isFinite(o.stepMs) && o.stepMs > 0 ? o.stepMs : 30000;
  const log = o.log || null;
  touchSilence(ms);
  const note = o.label ? '（' + o.label + '）' : '';
  if (log && log.info) log.info('进入长任务静默窗口' + note + '：后端在 ' + Math.round(ms / 1000) + 's 内保持存活声明');
  const timer = setInterval(function () { touchSilence(ms); }, stepMs);
  if (timer.unref) timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    // 任务结束时主动缩短窗口：让宿主尽快恢复「正常看护」。
    // 不删除文件（Windows 上删除正被宿主读取的文件会 EPERM），只把 until 拉近。
    releaseSilence();
  }
}

/** 仅供测试：重置进程内节流状态，让下一次 touchSilence 必定落盘。 */
export function _resetHeartbeatThrottle() { lastWriteAt = 0; lastValue = 0; }
