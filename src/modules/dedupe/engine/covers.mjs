// engine/covers.mjs — 联络表（把各单元首图拼成一张总览图），驱动 python/covers.py。
import path from 'node:path';
import { probePython, pythonExe, runPython, script } from './py.mjs';

/**
 * 生成联络表。
 * opts: { hexOnly, cols, cell:[w,h], onProgress, outName }
 * 返回 { ok, path, count, degraded, reason }。
 */
export async function generateCovers(paths, opts) {
  const o = opts || {};
  const probe = probePython();
  if (!probe.available || !probe.pillow) {
    return { ok: false, path: '', count: 0, degraded: true, reason: probe.reason || '缺少 Python/Pillow，联络表已跳过' };
  }
  if (!paths.scanRoot) return { ok: false, path: '', count: 0, degraded: false, reason: '未配置查重目录' };
  const out = path.join(paths.tmp, o.outName || 'id-covers.jpg');
  const specFile = path.join(paths.tmp, 'covers-spec-' + process.pid + '-' + Date.now() + '.json');
  const spec = { scanRoot: paths.scanRoot, out: out, cols: o.cols || 3, cell: o.cell || [460, 650], hexOnly: o.hexOnly !== false };
  const fsp = await import('node:fs/promises');
  try {
    await fsp.mkdir(paths.tmp, { recursive: true });
    await fsp.writeFile(specFile, JSON.stringify(spec), 'utf8');
  } catch (e) {
    return { ok: false, path: '', count: 0, degraded: false, reason: '写联络表任务失败: ' + (e && e.message ? e.message : e) };
  }
  const res = await runPython(probe.exe || pythonExe(), [script('covers.py'), specFile], {
    cwd: o.cwd,
    onCancel: o.onCancel,
    onLine: function (line) {
      const m = /^PROGRESS (\d+) (\d+)/.exec(line);
      if (m && o.onProgress) o.onProgress(Number(m[1]), Number(m[2]));
    }
  });
  try { await fsp.unlink(specFile); } catch (e) { /* 清理失败可忽略 */ }
  let parsed = null;
  try { parsed = JSON.parse(String(res.stdout || '').trim().split(/\r?\n/).pop() || 'null'); } catch (e) { parsed = null; }
  if (!res.ok || !parsed) {
    return { ok: false, path: '', count: 0, degraded: /NO_PIL/.test(res.stderr || ''), reason: '联络表生成失败：' + String(res.stderr || '').slice(-200) };
  }
  return { ok: true, path: parsed.out || out, count: parsed.count || 0, degraded: false, reason: '' };
}
