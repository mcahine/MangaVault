// engine/py.mjs — Python 调用层：数组传参 spawn、逐行进度、可中止、优雅降级。
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const PY_DIR = path.join(import.meta.dirname, 'python');
export const SCRIPT_DIR = path.join(import.meta.dirname, 'scripts');

let exeCache = null;
let probeCache = null;

/** 探测可用的 Python 解释器：python -> py -> python3。都不可用返回 null。 */
export function pythonExe() {
  if (exeCache !== null) return exeCache || null;
  for (const cand of ['python', 'py', 'python3']) {
    try {
      const r = spawnSync(cand, ['-c', 'print(1)'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      if (!r.error && r.status === 0) { exeCache = cand; return cand; }
    } catch (e) { /* 换下一个候选 */ }
  }
  exeCache = '';
  return null;
}

/**
 * 探测 Python + Pillow 能力（结果缓存，force 时重测）。
 * 返回 { available, exe, pillow, pillowVersion, reason }。
 */
export function probePython(force) {
  if (probeCache && !force) return probeCache;
  const exe = pythonExe();
  if (!exe) {
    probeCache = { available: false, exe: '', pillow: false, pillowVersion: '', reason: '未检测到 Python 解释器（python / py / python3 均不可用）' };
    return probeCache;
  }
  try {
    const r = spawnSync(exe, ['-c', 'import PIL;print(PIL.__version__)'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const out = String((r.stdout || '') + (r.stderr || '')).trim();
    if (!r.error && r.status === 0 && /^[0-9]/.test(out)) {
      probeCache = { available: true, exe: exe, pillow: true, pillowVersion: out.split(/\r?\n/)[0].trim(), reason: '' };
    } else {
      probeCache = { available: true, exe: exe, pillow: false, pillowVersion: '', reason: 'Python 可用但缺少 Pillow（执行 python -m pip install Pillow 后重试）' };
    }
  } catch (e) {
    probeCache = { available: true, exe: exe, pillow: false, pillowVersion: '', reason: 'Pillow 检测失败: ' + (e && e.message ? e.message : e) };
  }
  return probeCache;
}

/** 本机是否具备像素级比对能力。 */
export function hasPillow() {
  return probePython().pillow === true;
}

/** 降级原因（无降级时返回空串）。 */
export function degradeReason() {
  const p = probePython();
  if (!p.available) return (p.reason || '未检测到 Python') + '，已降级为纯 SHA-256 字节查重';
  if (!p.pillow) return (p.reason || '缺少 Pillow') + '，已降级为纯 SHA-256 字节查重';
  return '';
}

/** 按脚本名取 python 脚本绝对路径。 */
export function script(name) { return path.join(PY_DIR, name); }

/**
 * 运行 Python 脚本（数组传参，不拼 shell 字符串）。绝不抛错。
 * opts: { cwd, env, onLine(line), onChild(child), maxKeep, timeoutMs, onCancel(registerKiller) }
 * 返回 { ok, code, stdout, stderr, error, killed }。
 */
export function runPython(exe, args, opts) {
  const o = opts || {};
  return new Promise(function (resolve) {
    let child = null;
    try {
      child = spawn(exe, args, {
        cwd: o.cwd || process.cwd(),
        windowsHide: true,
        // 管道下 Windows Python 默认用 cp936 编码输出，会导致中文 JSON/日志乱码甚至 UnicodeEncodeError；强制 UTF-8。
        env: Object.assign({ PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, process.env, o.env || {})
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: String(err && err.message || err), killed: false });
      return;
    }
    if (typeof o.onChild === 'function') { try { o.onChild(child); } catch (e) { /* 忽略回调异常 */ } }

    const keep = Math.max(4096, o.maxKeep || 200000);
    let tailOut = '';
    let errText = '';
    let bufOut = '';
    let bufErr = '';
    let settled = false;
    let killed = false;
    let timer = null;

    function kill() {
      killed = true;
      try { child.kill('SIGKILL'); } catch (e) { /* 进程可能已退出 */ }
    }
    function emitLines(text) {
      if (typeof o.onLine !== 'function') return;
      const parts = text.split(/\r?\n/);
      for (const line of parts) { try { o.onLine(line); } catch (e) { /* 忽略 */ } }
    }
    function finish(payload) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const out = tailOut.length > keep ? tailOut.slice(-keep) : tailOut;
      resolve(Object.assign({ killed: killed, stdout: out, stderr: errText.slice(-keep) }, payload));
    }

    child.stdout.on('data', function (b) {
      const text = b.toString('utf8');
      tailOut += text;
      if (tailOut.length > keep * 2) tailOut = tailOut.slice(-keep);
      bufOut += text;
      const parts = bufOut.split(/\r?\n/);
      bufOut = parts.pop();
      if (typeof o.onLine === 'function') { for (const line of parts) { try { o.onLine(line); } catch (e) { /* 忽略 */ } } }
    });
    child.stderr.on('data', function (b) {
      const text = b.toString('utf8');
      errText += text;
      if (errText.length > 400000) errText = errText.slice(-keep);
      bufErr += text;
      const parts = bufErr.split(/\r?\n/);
      bufErr = parts.pop();
      if (typeof o.onLine === 'function') { for (const line of parts) { try { o.onLine('[stderr] ' + line); } catch (e) { /* 忽略 */ } } }
    });
    child.on('error', function (err) {
      finish({ ok: false, code: -1, error: String(err && err.message || err), stdout: '' });
    });
    child.on('close', function (code) {
      if (bufOut) emitLines(bufOut);
      finish({ ok: code === 0 && !killed, code: code === null ? -1 : code, error: killed ? '任务已中止' : '' });
    });
    if (o.timeoutMs) { timer = setTimeout(kill, o.timeoutMs); }
    if (typeof o.onCancel === 'function') { try { o.onCancel(kill); } catch (e) { /* 忽略 */ } }
  });
}
