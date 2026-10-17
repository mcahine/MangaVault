// 漫库 MangaVault · 桌面端辅助：进程探测 / 服务等待 / 屏幕尺寸 / 浏览器定位 / 打开窗后窗进程追踪
// 全部逻辑都可以离线单测（探测类函数接受注入的 exec 函数）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { sleep } from '../src/core/util.mjs';

/** 进程是否还活着（Windows 下用 tasklist /FI，零依赖）；exec 可注入以便离线单测 */
export function processAlive(pid, exec) {
  const runner = exec || execFile;
  return new Promise(function (resolve) {
    runner('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 }, function (err, stdout) {
      const text = String(stdout || '');
      if (!text) return resolve(false);
      // 没有匹配进程时输出中文/英文的「无任务」提示，不会带引号包裹的 PID
      resolve(text.indexOf('"' + pid + '"') !== -1);
    });
  });
}

/** 轮询 GET /api/ping，直到返回 MangaVault 或超时；返回 { ok, port, data } */
export async function waitForServer(preferredPort, options) {
  const o = options || {};
  const maxTries = o.maxTries || 60;
  const intervalMs = o.intervalMs || 400;
  const tries = Math.min(maxTries, 6);
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch('http://127.0.0.1:' + preferredPort + '/api/ping', { signal: AbortSignal.timeout(1200) });
        const data = await res.json();
        if (data && data.name === 'MangaVault') return { ok: true, port: preferredPort, data: data };
      } catch (e) { /* 还没起来 */ }
      await sleep(intervalMs);
    }
  }
  return { ok: false, port: preferredPort, data: null };
}

/** 读服务锁文件（data/server.lock.json），失败返回 null */
export function readLockSync(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || !raw.pid || !raw.port) return null;
    return raw;
  } catch (e) { return null; }
}

/** 确认锁文件里的实例真的活着且是漫库：返回信息或 null */
export async function probeInstance(lockFile) {
  const lock = readLockSync(lockFile);
  if (!lock) return null;
  let alive = false;
  try { process.kill(lock.pid, 0); alive = true; } catch (e) { alive = false; }
  if (!alive) return null;
  try {
    const res = await fetch('http://127.0.0.1:' + lock.port + '/api/ping', { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    if (data && data.name === 'MangaVault') return { pid: lock.pid, port: lock.port, url: lock.url || ('http://127.0.0.1:' + lock.port + '/') };
  } catch (e) { /* 端口不通 */ }
  return null;
}

/** 候选浏览器路径（msedge 优先，Chrome 兜底） */
export function browserCandidates() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [
    { name: 'Edge', exe: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Edge', exe: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Edge', exe: local ? path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '' },
    { name: 'Chrome', exe: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Chrome', exe: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Chrome', exe: local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '' }
  ];
}

/** 找到第一个存在的浏览器可执行文件；没有就返回 null */
export function findBrowserSync(candidates) {
  const list = candidates || browserCandidates();
  for (const c of list) {
    if (!c.exe) continue;
    try { if (fs.existsSync(c.exe)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

/** 取主屏工作区尺寸（PowerShell + Screen.WorkingArea），失败回退 1920x1080 */
export function screenSize(exec) {
  const runner = exec || execFile;
  return new Promise(function (resolve) {
    const ps = 'Add-Type -AssemblyName System.Windows.Forms; $w=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; Write-Output ($w.Width.ToString() + "," + $w.Height.ToString())';
    runner('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }, function (err, stdout) {
      const m = /(\d+)\s*,\s*(\d+)/.exec(String(stdout || ''));
      if (!m) return resolve({ width: 1920, height: 1080 });
      resolve({ width: parseInt(m[1], 10), height: parseInt(m[2], 10) });
    });
  });
}

/**
 * 列出命令行里带某标记的浏览器进程。返回 { ok, list }。
 * **ok=false 表示这次探测失败**（PowerShell 超时 / 被 CPU 挤住），与「确实一个窗口进程都没有」
 * 有本质区别：调用方要是把 ok=false 当成「没窗口」并据此收掉内核，就会在长任务扫描时误杀后端。
 */
export function appWindowProbe(profileDir, exec) {
  const runner = exec || execFile;
  return new Promise(function (resolve) {
    const needle = path.resolve(profileDir).toLowerCase();
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\' or Name=\'chrome.exe\'" | ' +
      'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3';
    runner('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, function (err, stdout) {
      if (err) return resolve({ ok: false, list: [] });
      let arr = [];
      try {
        const parsed = JSON.parse(String(stdout || 'null'));
        arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      } catch (e) { return resolve({ ok: false, list: [] }); }
      const hits = arr.filter(function (p) {
        return p && p.CommandLine && String(p.CommandLine).toLowerCase().indexOf(needle) !== -1;
      });
      resolve({ ok: true, list: hits.map(function (p) { return { pid: p.ProcessId, name: p.Name, commandLine: p.CommandLine }; }) });
    });
  });
}

/** 列出窗口进程；拿不到时返回 []。需要区分「探测失败」的调用方请用 appWindowProbe */
export function listAppWindowProcesses(profileDir, exec) {
  return appWindowProbe(profileDir, exec).then(function (r) { return r.list; });
}

/**
 * 等待窗口进程消失（说明用户关了窗口）；返回 true=已关闭，false=探测一直失败。
 *
 * 第二段必须是**有界**的：历史事故里它写成 while(true) + 「探测失败就 continue」，
 * 于是只要 PowerShell 一直超时（或 CIM 服务卡住），这个函数永远不返回，
 * 启动器进程永远退不掉，用户看到的就是「窗口/程序清不掉」。
 * 连续 failLimit 次探测失败就返回 false，交给调用方按「拿不到信息」处理。
 */
export async function waitWindowClosed(profileDir, options) {
  const o = options || {};
  const pollMs = o.pollMs || 1500;
  const detectMs = o.detectMs || 15000;
  const failLimit = Math.max(1, o.failLimit || 8);
  const detectDeadline = Date.now() + detectMs;
  let seen = false;
  while (Date.now() < detectDeadline) {
    const probe = await appWindowProbe(profileDir);
    if (probe.ok && probe.list.length) { seen = true; break; }
    await sleep(pollMs);
  }
  if (!seen) return false;
  let failStreak = 0;
  while (true) {
    await sleep(pollMs);
    const probe = await appWindowProbe(profileDir);
    // 探测失败时**不能**判定「窗口已关闭」——长任务期间 PowerShell 探测很容易超时
    if (!probe.ok) {
      failStreak++;
      if (failStreak >= failLimit) return false;
      continue;
    }
    failStreak = 0;
    if (!probe.list.length) return true;
  }
}
/** 由数据目录派生固定的远程调试端口（9210-9299），同一份数据目录永远同端口 */
export function debugPortFor(dir) {
  const s = path.resolve(String(dir || '')).toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 9210 + (h % 90);
}

/**
 * 查询 CDP 目标：返回 { ok, list }。
 * ok=false 表示**这次探测本身失败**（端口没起来 / 命令超时 / PowerShell 被 CPU 打满拖垮）。
 * 必须与「探测成功但目标列表为空」严格区分 —— 混为一谈会把「探测失败」误判成「窗口已关闭」，
 * 这正是「一点重新扫描程序就崩」的根因：扫描把 CPU 打满 → 探测超时 → 误判关窗 → 启动器退出收掉内核。
 */
export function cdpProbe(port, exec, timeoutMs) {
  const runner = exec || execFile;
  const secs = Math.max(1, Math.round((timeoutMs || 2500) / 1000));
  return new Promise(function (resolve) {
    runner('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '(Invoke-WebRequest -UseBasicParsing -TimeoutSec ' + String(secs) + ' "http://127.0.0.1:' + port + '/json/list").Content'
    ], { windowsHide: true, timeout: (timeoutMs || 2500) + 1500, maxBuffer: 8 * 1024 * 1024 }, function (err, stdout) {
      if (err) return resolve({ ok: false, list: [] });
      const raw = String(stdout || '').trim();
      // 命令成功但输出为空：同样拿不到目标列表，按探测失败处理（不能当成「没有页面」）
      if (!raw) return resolve({ ok: false, list: [] });
      resolve({ ok: true, list: parseCdpJson(raw) });
    });
  });
}

/** 查询 CDP 目标列表；返回 [] 表示没拿到。需要区分「探测失败」时请直接用 cdpProbe */
export function cdpTargets(port, exec, timeoutMs) {
  return cdpProbe(port, exec, timeoutMs).then(function (r) { return r.list; });
}

/** 规范化 URL 便于比较（去掉末尾斜杠与 hash） */
export function normalizeUrl(u) {
  try {
    const x = new URL(String(u));
    let s = x.origin + x.pathname;
    if (s.endsWith('/') && x.pathname !== '/') s = s.replace(/\/+$/, '');
    return s;
  } catch (e) { return String(u || ''); }
}

/** 轮询 CDP，直到出现指向 url 的页面目标 */
export async function waitForCdpTarget(port, url, options) {
  const o = options || {};
  const deadline = Date.now() + (o.timeoutMs || 20000);
  const want = normalizeUrl(url);
  while (Date.now() < deadline) {
    const list = await cdpTargets(port, o.exec, 2500);
    const hit = list.find(function (t) { return normalizeUrl(t.url) === want; });
    if (hit) return hit;
    await sleep(o.intervalMs || 600);
  }
  return null;
}

/** 解析 CDP 返回的数组文本（供单测直接用） */
export function parseCdpJson(text) {
  try {
    const parsed = JSON.parse(String(text || 'null'));
    const arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    return arr.filter(function (t) { return t && t.type === 'page'; });
  } catch (e) { return []; }
}

/**
 * 轮询 CDP，直到该 url 的页面目标消失（= 用户关了窗口）。
 * 只有在「曾经连上过调试端口」之后才把持续缺席当成关窗，避免浏览器不支持 CDP 时误判。
 * 返回 'closed' | 'unsupported'（调用方自行退回进程探测）。
 */
export async function waitForCdpClosed(port, url, options) {
  const o = options || {};
  const intervalMs = o.intervalMs || 1200;
  const exploreMs = o.exploreMs || 20000;
  // 长任务（查重全库扫描）会把 CPU 打满，PowerShell 探测可能好几秒才回来；超时设太紧必然误判。
  const probeMs = o.probeMs || 6000;
  // 连续 N 次「探测成功且目标确实不在」才判定关窗，抵御单次抖动。
  const requiredMisses = Math.max(1, o.requiredMisses || 2);
  const want = normalizeUrl(url);
  let fails = 0;
  let misses = 0;
  let seenPort = false;
  const exploreDeadline = Date.now() + exploreMs;
  while (Date.now() < exploreDeadline) {
    await sleep(intervalMs);
    const probe = await cdpProbe(port, o.exec, probeMs);
    if (!probe.ok) {
      // 探测失败：拿不到任何信息，**不能据此判断窗口状态**，继续等
      fails++;
      if (fails >= 3 && !seenPort) return 'unsupported';
      continue;
    }
    fails = 0;
    seenPort = true;
    if (probe.list.find(function (t) { return normalizeUrl(t.url) === want; })) { misses = 0; continue; }
    misses++;
    if (misses >= requiredMisses) return 'closed';
  }
  if (!seenPort) return 'unsupported';
  // 同样必须有界：浏览器窗口关掉之后调试端口就没了，此后 cdpProbe 会**一直失败**，
  // 旧写法 `if (!probe.ok) continue;` 会在这里永久空转，启动器再也退不出去。
  const failLimit = Math.max(1, o.failLimit || 6);
  let failStreak = 0;
  while (true) {
    await sleep(intervalMs);
    const probe = await cdpProbe(port, o.exec, probeMs);
    // 探测失败 ≠ 窗口关闭。这里原来直接当「关窗」，扫描期间必然误判。
    if (!probe.ok) {
      failStreak++;
      if (failStreak >= failLimit) return 'unsupported';
      continue;
    }
    failStreak = 0;
    if (probe.list.find(function (t) { return normalizeUrl(t.url) === want; })) { misses = 0; continue; }
    misses++;
    if (misses >= requiredMisses) return 'closed';
  }
}
