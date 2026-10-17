// engine/thumbs.mjs — 缩略图生成（驱动 python/thumbs.py，按需生成 + 批量预生成）。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../../../core/util.mjs';
import { keyOf } from './paths.mjs';
import { probePython, pythonExe, runPython, script } from './py.mjs';

export const THUMB_SIZE = 320;

/** 单元缩略图目录：data/dedupe/thumbs/<md5(unitId)>/<dup|lib>/。 */
export function thumbDir(paths, unitId, side) {
  return path.join(paths.thumbs, keyOf(unitId), side === 'lib' ? 'lib' : 'dup');
}

/**
 * 单张缩略图的落盘路径（统一扩展名 .jpg）。
 * 多库根下 lib 侧 name 是「相对根的路径」（可能带子目录），因此带上路径短哈希避免同名撞车；
 * dup 侧 name 仍是单段文件名，保持原样。
 */
export function thumbPathOf(paths, unitId, side, name) {
  const raw = String(name);
  const base = path.basename(raw).replace(/\.[^.]+$/, '') + '.jpg';
  const fileName = raw.includes('/') ? (keyOf(raw).slice(0, 8) + '-' + base) : base;
  return path.join(thumbDir(paths, unitId, side), fileName);
}

/**
 * 批量生成缩略图。
 * opts: { onProgress(done,total), onCancel(registerKiller), onChild }
 * 返回 { ok, degraded, reason, stats, generated }；绝不抛错。
 */
export async function generateThumbs(paths, tasks, opts) {
  const o = opts || {};
  if (!tasks || !tasks.length) return { ok: true, degraded: false, reason: '', stats: null, generated: 0 };
  const probe = probePython();
  if (!probe.available || !probe.pillow) {
    return { ok: false, degraded: true, reason: probe.reason || '缺少 Python/Pillow，缩略图已跳过（前端会退回原图）', stats: null, generated: 0 };
  }
  const specFile = path.join(paths.tmp, 'thumb-tasks-' + process.pid + '-' + Date.now() + '.json');
  try {
    await ensureDir(paths.tmp);
    await fsp.writeFile(specFile, JSON.stringify(tasks), 'utf8');
  } catch (e) {
    return { ok: false, degraded: false, reason: '写缩略图任务失败: ' + (e && e.message ? e.message : e), stats: null, generated: 0 };
  }
  let done = 0;
  let stats = null;
  const res = await runPython(probe.exe || pythonExe(), [script('thumbs.py'), specFile], {
    cwd: o.cwd,
    maxKeep: 300000,
    onChild: o.onChild,
    onCancel: o.onCancel,
    onLine: function (line) {
      const m = /^PROGRESS (\d+) (\d+)/.exec(line);
      if (m) { done = Number(m[1]); if (o.onProgress) o.onProgress(Number(m[1]), Number(m[2])); return; }
      const d = /^\{.*\}$/.exec(line.trim());
      if (d) { try { stats = JSON.parse(d[0]); } catch (e) { stats = null; } return; }
      if (o.onLog && line.trim()) o.onLog(line);
    }
  });
  try { await fsp.unlink(specFile); } catch (e) { /* 清理失败可忽略 */ }
  if (res.killed) return { ok: false, degraded: false, reason: '缩略图生成已中止', stats: stats, generated: done };
  if (/NO_PIL/.test(res.stderr || '')) return { ok: false, degraded: true, reason: 'Python 缺少 Pillow，缩略图已跳过', stats: stats, generated: done };
  return { ok: res.ok, degraded: false, reason: res.ok ? '' : '缩略图生成部分失败：' + String(res.stderr || '').slice(-200), stats: stats, generated: done };
}

/** 单张按需生成（缩略图接口用）；返回生成后的绝对路径，失败返回 null。 */
export async function ensureThumb(paths, unitId, side, srcAbs, name, opts) {
  const dst = thumbPathOf(paths, unitId, side, name);
  try { const st = await fsp.stat(dst); if (st.isFile() && st.size > 0) return dst; } catch (e) { /* 未缓存，继续生成 */ }
  const res = await generateThumbs(paths, [{ src: srcAbs, dst: dst, size: Number((opts && opts.size) || THUMB_SIZE) }], opts || {});
  if (!res.ok && res.degraded) return null;
  try { const st = await fsp.stat(dst); return st.isFile() && st.size > 0 ? dst : null; } catch (e) { return null; }
}
