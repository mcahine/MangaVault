// 漫库 MangaVault · 桌面端纯函数层
// 这里只放「输入 -> 输出」的纯逻辑：窗口记忆、命令行拼装、白名单校验、开机自启命令拼装。
// 之所以单独成文件：桌面启动器（desktop/app.mjs）与后端模块（src/modules/desktop/index.mjs）
// 都要用同一套规则，抽出来才能离线单测（不启动浏览器、不写注册表）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 基准窗口尺寸（UI_GUIDELINE 第 5 节：基准 1440x900） */
export const BASE_WINDOW = { width: 1440, height: 900 };
/** 窗口过小会让侧栏 + 内容区挤成一团，做下限保护 */
export const MIN_WINDOW = { width: 1024, height: 640 };
/** 窗口坐标的合理范围（屏幕不会有 ±2 万像素）。用于挡掉 Windows 最小化窗口上报的 -32000 */
export const POS_LIMIT = 20000;
/** 开机自启注册表项名 */
export const AUTOSTART_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const AUTOSTART_NAME = 'MangaVault';

/** 取整数，非法返回 null（导出供后端模块复用同一套语义） */
export function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** 坐标是否落在合理范围内（null / 非有限值 / 越界都算不合理） */
export function posInRange(v) {
  return v !== null && v !== undefined && Number.isFinite(v) && Math.abs(v) <= POS_LIMIT;
}

/**
 * 校验并规范化页面侧上报的窗口信息。
 * 返回 { ok:true, value } 或 { ok:false, error:'中文原因' }。
 * width/height 至少要有其一，位置允许缺省（缺省时保留旧值/自动居中）。
 */
export function sanitizeWindow(input, base) {
  const src = input && typeof input === 'object' ? input : null;
  if (!src) return { ok: false, error: '缺少窗口信息' };
  const w = toInt(src.width);
  const h = toInt(src.height);
  const x = toInt(src.x);
  const y = toInt(src.y);
  if (w === null && h === null) return { ok: false, error: '缺少窗口宽高（width / height）' };
  const prev = base && typeof base === 'object' ? base : {};
  const width = w === null ? (toInt(prev.width) || BASE_WINDOW.width) : w;
  const height = h === null ? (toInt(prev.height) || BASE_WINDOW.height) : h;
  // 语义：偏小的尺寸一律抬到窗口下限（浏览器允许用户把窗口拖得很小，不该当成坏数据）；
  // 只有大到明显异常（> 16000，超过任何常见显示器）才判为坏数据。
  if (width > 16000) return { ok: false, error: '窗口宽度超出合理范围（最大 16000）' };
  if (height > 16000) return { ok: false, error: '窗口高度超出合理范围（最大 16000）' };
  // 位置也必须范围校验：Windows 上最小化窗口的 screenX/screenY 返回 -32000，
  // 原样记下就会在下次启动拼出 --window-position=-32000,-32000，窗口开在屏幕外，
  // 用户看不见 → 不会去关它 → 启动器一直等 → 再双击又开一个屏外窗口（历史事故）。
  // 越界一律丢弃，交给 readWindowSync / loadWindow 走「自动居中」。
  const rawX = x === null ? toInt(prev.x) : x;
  const rawY = y === null ? toInt(prev.y) : y;
  const out = {
    width: Math.max(MIN_WINDOW.width, width),
    height: Math.max(MIN_WINDOW.height, height),
    x: posInRange(rawX) ? rawX : null,
    y: posInRange(rawY) ? rawY : null,
    updatedAt: new Date().toISOString()
  };
  if (out.x === null) delete out.x;
  if (out.y === null) delete out.y;
  return { ok: true, value: out };
}

/** 单屏居中位置（不知道屏幕尺寸时按 1920x1080 估算，启动器可在 Windows 下覆盖） */
export function centerOf(width, height, screenW, screenH) {
  const sw = toInt(screenW) || 1920;
  const sh = toInt(screenH) || 1080;
  const w = toInt(width) || BASE_WINDOW.width;
  const h = toInt(height) || BASE_WINDOW.height;
  return { x: Math.max(0, Math.round((sw - w) / 2)), y: Math.max(0, Math.round((sh - h) / 2)) };
}

/** 读窗口记忆文件；坏文件/不存在都回退到基准尺寸并居中（不抛错） */
export function readWindowSync(file, screenW, screenH) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { raw = null; }
  const res = raw ? sanitizeWindow(raw, null) : { ok: false };
  const value = res.ok ? res.value : { width: BASE_WINDOW.width, height: BASE_WINDOW.height };
  if (value.x === undefined || value.y === undefined) {
    const c = centerOf(value.width, value.height, screenW, screenH);
    value.x = c.x;
    value.y = c.y;
  }
  return value;
}

/** 原子写窗口记忆文件（先写临时文件再改名，避免断电写坏） */
export async function writeWindow(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  return value;
}

/** 只允许 http/https，且必须是回环地址（本地内核），拒绝 file:// 与任何越界 URL */
export function validateLocalUrl(input) {
  const raw = String(input === null || input === undefined ? '' : input).trim();
  if (!raw) return { ok: false, error: '缺少 url 参数' };
  let u = null;
  try { u = new URL(raw); } catch (e) { return { ok: false, error: 'url 不是合法地址' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '只允许 http/https 地址' };
  const host = u.hostname.toLowerCase();
  const loop = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!loop) return { ok: false, error: '只允许打开本机地址（127.0.0.1/localhost）' };
  return { ok: true, value: u.toString() };
}

/** confirm 校验：必须显式带 confirm=1，否则拒绝（防止误点/CSRF 式误触发） */
export function checkConfirm(q, expected) {
  const want = expected === undefined ? '1' : String(expected);
  const got = q === null || q === undefined ? '' : String(q);
  if (got !== want) return { ok: false, error: '危险操作需要 confirm=1 确认参数' };
  return { ok: true };
}

/**
 * 拼装 Chromium App 模式命令行参数。
 * 顺序固定，便于单测与人工核对。
 * opts: { url, width, height, x, y, profileDir, extensionDir }
 */
export function buildAppArgs(opts) {
  const o = opts || {};
  // 与 sanitizeWindow 保持同一套语义：非法/缺失 -> 基准尺寸；偏小 -> 抬到窗口下限；
  // 荒谬超大（> 16000）也回退基准，避免拼出浏览器会拒绝的启动参数。
  const wRaw = toInt(o.width);
  const hRaw = toInt(o.height);
  const width = (wRaw === null || wRaw <= 0 || wRaw > 16000) ? BASE_WINDOW.width : Math.max(MIN_WINDOW.width, wRaw);
  const height = (hRaw === null || hRaw <= 0 || hRaw > 16000) ? BASE_WINDOW.height : Math.max(MIN_WINDOW.height, hRaw);
  const args = ['--app=' + String(o.url || 'about:blank')];
  args.push('--window-size=' + width + ',' + height);
  // 位置必须成对且都在合理范围内；越界（典型：最小化窗口上报的 -32000）一律不拼。
  // 宁可不给位置参数让浏览器自己选，也不能把窗口开到屏幕外。
  const px = toInt(o.x);
  const py = toInt(o.y);
  if (posInRange(px) && posInRange(py)) {
    args.push('--window-position=' + px + ',' + py);
  }
  if (o.profileDir) args.push('--user-data-dir=' + path.resolve(String(o.profileDir)));
  if (o.extensionDir) args.push('--load-extension=' + path.resolve(String(o.extensionDir)));
  args.push('--no-first-run');
  args.push('--no-default-browser-check');
  args.push('--disable-features=Translate,MediaRouter');
  args.push('--disable-session-crashed-bubble');
  args.push('--hide-crash-restore-bubble');
  args.push('--noerrdialogs');
  return args;
}