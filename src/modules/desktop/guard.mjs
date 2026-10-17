// ============================================================
//  漫库 MangaVault · 桌面桥路径策略（src/modules/desktop/guard.mjs）
//
//  这里放「原生能力」的安全判定，全部是纯函数（可离线单测，不碰网络/进程）。
//  单独成文件的理由：这些规则是安全边界，必须能被逐条断言，
//  而不是埋在路由处理器里靠「看起来没问题」过关。
//
//  安全模型：
//    · open-external —— 只允许 http / https / mailto。绝不允许 file:、javascript:、
//      data:、vbscript: 等可以借「用系统默认程序打开」执行本地代码的协议。
//    · reveal —— 只允许定位**库根以内**且**真实存在**的路径。
//      否则前端（或任何能访问本机端口的程序）就能拿它遍历整个磁盘。
// ============================================================

import path from 'node:path';

/** 允许交给系统默认程序打开的协议（小写，不含冒号） */
export const EXTERNAL_PROTOCOLS = ['http', 'https', 'mailto'];

/** 是否按不区分大小写比较（Windows 语义）；单测可显式覆盖 */
function caseInsensitiveOf(opts) {
  if (opts && typeof opts.caseInsensitive === 'boolean') return opts.caseInsensitive;
  return process.platform === 'win32';
}

/**
 * 校验「用系统默认程序打开」的 URL。
 * 返回 { ok:true, value } 或 { ok:false, error:'中文原因' }。
 */
export function validateExternalUrl(raw) {
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!text) return { ok: false, error: '缺少 url 参数' };
  /* 控制字符（含 CR/LF）可以拿来把参数拆成两条命令，必须先挡掉 */
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return { ok: false, error: 'url 含有非法控制字符' };
  }
  let u = null;
  try { u = new URL(text); }
  catch (e) { return { ok: false, error: 'url 不是合法地址' }; }
  const scheme = String(u.protocol || '').replace(':', '').toLowerCase();
  if (EXTERNAL_PROTOCOLS.indexOf(scheme) < 0) {
    return { ok: false, error: '出于安全考虑，只允许打开 http / https / mailto 链接' };
  }
  if (scheme !== 'mailto' && !u.hostname) return { ok: false, error: 'url 缺少主机名' };
  return { ok: true, value: u.toString() };
}

/**
 * 判断 URL 能否安全地交给 `cmd /c start`（仅在「宿主不在线」的降级路径上用）。
 *
 * 为什么需要这一条：cmd.exe 会把 & | < > ^ % 当成自己的元字符，
 * 而 Node 的 spawn（未开 shell）只做引号转义、不转义这些字符，
 * 因此 http://x/?a&calc 这类链接会被 cmd 拆成两条命令 —— 这是真实的命令注入面。
 * 宿主路径用 ShellExecute，不经过 cmd，所以不受影响。
 */
export function isCmdSafeUrl(url) {
  const text = String(url === null || url === undefined ? '' : url);
  if (/[&|<>^%"!`]/.test(text)) {
    return { ok: false, error: '该链接含有命令行特殊字符，无法安全打开（请改用桌面版）' };
  }
  return { ok: true, value: text };
}

/**
 * 校验「资源管理器定位」的路径：必须真实存在，且落在给定库根之内。
 * roots: [{ id, name, path }]，来自 src/core/roots.mjs
 * 返回 { ok:true, value:{ path, kind, root } } 或 { ok:false, error }
 */
export function validateRevealPath(raw, roots, opts) {
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!text) return { ok: false, error: '缺少 path 参数' };
  if (text.indexOf('\u0000') >= 0) return { ok: false, error: '路径含有非法字符' };

  let abs;
  try { abs = path.resolve(text); }
  catch (e) { return { ok: false, error: '路径无法解析' }; }

  const list = Array.isArray(roots) ? roots.filter(function (r) { return r && r.path; }) : [];
  if (!list.length) {
    return { ok: false, error: '还没有配置任何漫画库根，无法定位文件' };
  }
  const ci = caseInsensitiveOf(opts);
  const hit = findOwnerRoot(abs, list, ci);
  if (!hit) {
    /* 刻意不把候选库根路径回显给调用方，避免变成目录结构探测工具 */
    return { ok: false, error: '出于安全考虑，只允许定位漫画库根之内的文件' };
  }
  return { ok: true, value: { path: abs, root: hit, kind: null } };
}

/** 找出 absPath 属于哪个库根（取最长的匹配根，处理嵌套库根） */
export function findOwnerRoot(absPath, roots, caseInsensitive) {
  const target = norm(absPath, caseInsensitive);
  let best = null;
  for (const r of roots) {
    if (!r || !r.path) continue;
    const rootAbs = norm(path.resolve(String(r.path)), caseInsensitive);
    if (!isInside(target, rootAbs)) continue;
    if (!best || rootAbs.length > best.abs.length) best = { root: r, abs: rootAbs };
  }
  return best ? best.root : null;
}

function norm(p, ci) {
  const s = path.resolve(String(p));
  return ci ? s.toLowerCase() : s;
}

/** target 是否等于 base 或在 base 之内（两者都必须是已规范化的绝对路径） */
function isInside(target, base) {
  if (target === base) return true;
  const rel = path.relative(base, target);
  if (!rel) return false;
  if (path.isAbsolute(rel)) return false;
  if (rel === '..') return false;
  if (rel.startsWith('..' + path.sep)) return false;
  return true;
}

/**
 * 校验「原生选目录」的返回路径：只要求是绝对路径且真实存在。
 * 选目录的结果是用户在系统对话框里亲自选的，不受库根限制（可能要新增一个库根）。
 */
export function validatePickedDir(raw) {
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!text) return { ok: false, error: '用户取消了目录选择' };
  if (text.indexOf('\u0000') >= 0) return { ok: false, error: '路径含有非法字符' };
  let abs;
  try { abs = path.resolve(text); }
  catch (e) { return { ok: false, error: '路径无法解析' }; }
  if (!path.isAbsolute(abs)) return { ok: false, error: '选中的不是绝对路径' };
  return { ok: true, value: abs };
}
