// engine/delete.mjs — 删除执行器：前置校验、回收站/隔离/永久删除、还原、删除日志。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ensureDir } from '../../../core/util.mjs';
import { insideRoot, QUARANTINE_DIR_NAME } from './paths.mjs';
import { SCRIPT_DIR } from './py.mjs';
import { appendDeleteLog, readDeleteLog } from './store.mjs';

export const DELETE_MODES = ['recycle', 'quarantine', 'permanent'];
export const CONFIRM_WORD = 'DELETE';
export const DEFAULT_MODE = 'recycle';

function bad(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

let shellCache = null;

/** 优先用 pwsh（PowerShell 7），没有就退回 powershell.exe。 */
export function shellExe() {
  if (shellCache) return shellCache;
  for (const cand of ['pwsh', 'powershell.exe', 'powershell']) {
    try {
      const r = spawnSync(cand, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
      if (!r.error && r.status === 0) { shellCache = cand; return cand; }
    } catch (e) { /* 换下一个候选 */ }
  }
  shellCache = '';
  return null;
}

/**
 * 删除前置校验（纯函数，便于离线单测）：
 *  - confirm 必须等于 DELETE（忽略大小写与首尾空白）
 *  - unitIds 必须非空，且每个都出现在最近一次扫描结果里
 *  - 记录路径必须严格等于 scanRoot/<id>，且位于 scanRoot 之内（不允许删除 scanRoot 本身）
 *  - mode 必须是 recycle / quarantine / permanent 之一（缺省 recycle）
 * 返回 { ids, paths, mode }；不合法时抛 400。
 */
export function validateDeleteRequest(input) {
  const i = input || {};
  const confirm = String(i.confirm == null ? '' : i.confirm).trim().toUpperCase();
  if (confirm !== CONFIRM_WORD) throw bad('确认口令不正确（需输入 ' + CONFIRM_WORD + '）');
  const mode = i.mode === undefined || i.mode === null || i.mode === '' ? DEFAULT_MODE : String(i.mode);
  if (!DELETE_MODES.includes(mode)) throw bad('未知删除方式: ' + mode + '（可选 recycle / quarantine / permanent）');
  const scanRoot = i.scanRoot ? path.resolve(i.scanRoot) : '';
  if (!scanRoot) throw bad('未配置查重目录，拒绝删除');
  const unitIds = Array.isArray(i.unitIds) ? i.unitIds : [];
  if (!unitIds.length) throw bad('没有选择要删除的单元');
  const folders = Array.isArray(i.folders) ? i.folders : [];
  const byId = new Map();
  for (const f of folders) if (f && f.id) byId.set(f.id, f);
  const ids = [];
  const targets = [];
  for (const raw of unitIds) {
    const id = String(raw == null ? '' : raw);
    if (!id) throw bad('单元 ID 为空');
    const rec = byId.get(id);
    if (!rec) throw bad('未找到单元（不在最近一次扫描结果里）: ' + id);
    const resolved = path.resolve(String(rec.dupDir || ''));
    const expected = path.resolve(path.join(scanRoot, id));
    if (!rec.dupDir) throw bad('单元缺少目录信息，拒绝删除: ' + id);
    if (resolved === scanRoot) throw bad('不允许删除查重根目录本身');
    if (resolved !== expected) throw bad('路径越界，已拒绝: ' + rec.dupDir);
    if (!insideRoot(scanRoot, resolved)) throw bad('路径越界，已拒绝: ' + rec.dupDir);
    ids.push(id);
    targets.push({ id: id, path: resolved });
  }
  return { ids: ids, targets: targets, mode: mode };
}

/** 执行删除（调用 engine/scripts/delete.ps1，数组传参）。 */
export async function executeDelete(paths, opts) {
  const o = opts || {};
  const check = validateDeleteRequest({
    confirm: o.confirm,
    mode: o.mode,
    unitIds: o.unitIds,
    folders: o.folders,
    scanRoot: paths.scanRoot
  });
  const shell = shellExe();
  if (!shell) throw Object.assign(new Error('未找到 PowerShell（pwsh / powershell.exe），无法执行删除'), { statusCode: 500 });
  await ensureDir(paths.tmp);
  const listFile = path.join(paths.tmp, 'delete-list-' + Date.now() + '.json');
  // 执行前先真实探测每个目标目录是否存在。
  // 目的有二：① 目录在扫描后被人工删掉/移走时，脚本会逐条报失败，用户只能看到一句
  // 「删除失败」却不知道原因；这里提前给出「目录已不存在」的准确原因。② 扫描期间被移走的
  // 单元若不区分「不存在」与「真失败」，回写 scan-latest 时会把失败项当成已删而误剔。
  // allowMissing 为 true 时（孤儿清理等场景）跳过缺失项并可整体成功，不再直接拒绝。
  const existed = [];
  for (const t of check.targets) {
    let isDir = false;
    try { const st = await fsp.stat(t.path); isDir = st.isDirectory(); } catch (e) { isDir = false; }
    existed.push(isDir);
  }
  const missing = check.targets.filter(function (t, i) { return !existed[i]; });
  if (missing.length && o.allowMissing !== true) {
    throw bad('有 ' + missing.length + ' 个单元目录已不存在（可能已被删除或移动）：' + missing.map(function (t) { return t.id; }).join('、'));
  }
  const active = check.targets.filter(function (t, i) { return existed[i]; });
  const skipped = check.targets.filter(function (t, i) { return !existed[i]; }).map(function (t) {
    return { id: t.id, path: t.path, ok: true, skipped: true, target: '', error: '目录已不存在，已跳过' };
  });
  try {
    await fsp.writeFile(listFile, JSON.stringify({ ids: active.map(function (t) { return t.id; }), paths: active.map(function (t) { return t.path; }), requestedAt: new Date().toISOString() }), 'utf8');
  } catch (e) {
    throw Object.assign(new Error('写删除清单失败: ' + (e && e.message ? e.message : e)), { statusCode: 500 });
  }
  const args = ['-NoProfile', '-NonInteractive', '-File', path.join(SCRIPT_DIR, 'delete.ps1'),
    '-ListFile', listFile, '-Mode', check.mode, '-Root', paths.scanRoot];
  if (check.mode === 'quarantine') {
    await ensureDir(paths.quarantine);
    args.push('-QuarantineDir', paths.quarantine);
  }
  const res = await new Promise(function (resolve) {
    let child = null;
    try { child = spawn(shell, args, { windowsHide: true }); }
    catch (err) { resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) }); return; }
    let out = '';
    let errText = '';
    child.stdout.on('data', function (b) { out += b.toString('utf8'); });
    child.stderr.on('data', function (b) { errText += b.toString('utf8'); });
    child.on('error', function (err) { resolve({ code: -1, stdout: out, stderr: String(err && err.message || err) }); });
    child.on('close', function (code) { resolve({ code: code === null ? -1 : code, stdout: out, stderr: errText }); });
  });

  let result = null;
  try { result = JSON.parse((await fsp.readFile(listFile + '.result.json', 'utf8')).replace(/^\uFEFF/, '')); } catch (e) { result = null; }
  const targetByIdPath = new Map(active.map(function (t) { return [path.resolve(t.path), t.id]; }));
  const results = skipped.slice();
  if (result && Array.isArray(result.results)) {
    for (const r of result.results) {
      results.push({
        id: targetByIdPath.get(path.resolve(String(r.path || ''))) || '',
        path: r.path,
        ok: r.ok === true,
        skipped: false,
        target: r.target || '',
        error: r.error || ''
      });
    }
  }
  const time = new Date().toISOString();
  /** 真正删掉的（脚本报 ok 且不是跳过项）；skipped 单独计数，避免「成功数」虚高。 */
  function reallyOk(r) { return r.ok && r.skipped !== true; }
  const entry = {
    time: time, mode: check.mode, ids: check.ids,
    paths: active.map(function (t) { return t.path; }),
    ok: results.filter(reallyOk).length,
    failed: results.filter(function (r) { return !r.ok; }).length,
    skipped: results.filter(function (r) { return r.skipped === true; }).map(function (r) { return r.id; }),
    skippedTotal: results.filter(function (r) { return r.skipped === true; }).length,
    results: results,
    stdout: String(res.stdout || '').trim().slice(-500),
    stderr: String(res.stderr || '').trim().slice(-500)
  };
  await appendDeleteLog(paths, entry);
  try { await fsp.unlink(listFile); } catch (e) { /* 清理失败可忽略 */ }
  if (!result && !results.length) {
    throw Object.assign(new Error('删除脚本未返回结果（退出码 ' + res.code + '）：' + entry.stderr), { statusCode: 500, detail: entry });
  }
  return entry;
}

/** 列出隔离区内容（孤立文件也一并报告，便于人工处理）。 */
export async function listQuarantine(paths) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(paths.quarantine, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const e of entries) {
    const abs = path.join(paths.quarantine, e.name);
    let size = 0;
    if (e.isDirectory()) {
      try { const files = await fsp.readdir(abs); size = files.length; } catch (err) { size = 0; }
    }
    out.push({ name: e.name, path: abs, isDir: e.isDirectory(), count: size });
  }
  return out;
}

/**
 * 从隔离区还原：读删除日志找到最近一次 quarantine 的落点，移回原路径。
 * 返回 { restored: [{id, ok, from, to, error}] }。
 */
export async function restoreQuarantine(paths, opts) {
  const o = opts || {};
  const unitIds = Array.isArray(o.unitIds) ? o.unitIds.map(String) : [];
  const ids = unitIds.length ? unitIds : null;
  const log = await readDeleteLog(paths, 2000);
  const wanted = ids ? new Set(ids) : null;
  const restored = [];
  const seen = new Set();
  for (const entry of log) {
    if (entry.mode !== 'quarantine') continue;
    for (const r of (entry.results || [])) {
      if (!r.ok || !r.target) continue;
      if (wanted && !wanted.has(r.id)) continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const to = r.path;
      const from = r.target;
      try {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(from, to);
        restored.push({ id: r.id, ok: true, from: from, to: to, error: '' });
      } catch (e) {
        restored.push({ id: r.id, ok: false, from: from, to: to, error: String(e && e.message ? e.message : e) });
      }
    }
  }
  return { restored: restored, quarantineDir: path.join(paths.root, QUARANTINE_DIR_NAME) };
}
