// ============================================================
//  漫库 MangaVault · 桌面构建脚本（scripts/build-desktop.mjs）
//
//  用法：
//    node scripts/build-desktop.mjs                 产出 dist/（不含 Node 运行时）
//    node scripts/build-desktop.mjs --with-node     额外把 node.exe 打进 dist/node/
//    node scripts/build-desktop.mjs --out=D:\dist   换输出目录
//    node scripts/build-desktop.mjs --clean         先清空输出目录再构建
//
//  产出结构（免安装绿色包）：
//    dist/
//      MangaVault.exe                原生宿主（C# + WebView2）
//      Microsoft.Web.WebView2.Core.dll      托管 DLL —— 必须与 exe 同目录
//      Microsoft.Web.WebView2.WinForms.dll  托管 DLL —— 必须与 exe 同目录
//      WebView2Loader.dll            原生加载器 —— 必须与 exe 同目录
//      icon.ico
//      app/                          后端与前端（src/ public/ package.json config.example.json）
//      node/node.exe                 可选，--with-node 时才有
//
//  ★ 零 npm 依赖：只用 node: 内置模块；编译器用系统自带的 csc.exe。
//  ★ 三个 WebView2 DLL 必须与 exe 同目录：否则 CLR 在 JIT Main 时找不到类型，
//    进程会「静默秒退且不报任何错」，这是本项目历史上最难查的坑。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const D = '\u001b[90m', G = '\u001b[32m', R = '\u001b[31m', Y = '\u001b[33m', B = '\u001b[36m', N = '\u001b[0m';

/* ---------- 参数 ---------- */
function parseArgs(argv) {
  const a = Array.isArray(argv) ? argv : [];
  function val(name) {
    const hit = a.find(function (x) { return x.indexOf(name + '=') === 0; });
    return hit ? hit.slice(name.length + 1) : null;
  }
  return {
    withNode: a.includes('--with-node'),
    clean: a.includes('--clean'),
    out: path.resolve(val('--out') || path.join(ROOT, 'dist'))
  };
}

/* ---------- 小工具 ---------- */
const log = {
  step: function (m) { console.log(B + '▸ ' + N + m); },
  ok: function (m) { console.log(G + '  ✓ ' + N + m); },
  warn: function (m) { console.log(Y + '  ! ' + N + m); },
  bad: function (m) { console.log(R + '  ✗ ' + N + m); },
  info: function (m) { console.log(D + '    ' + m + N); }
};

function die(message) {
  log.bad(message);
  process.exitCode = 1;
  throw new BuildError(message);
}

class BuildError extends Error {}

function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }
function sizeOf(p) { try { return fs.statSync(p).size; } catch (e) { return 0; } }

/**
 * 清理输出目录前的安全闸门。
 * --clean 会做递归删除，属于破坏性操作，删之前必须证明这个路径「确实是个构建输出目录」，
 * 否则一旦 --out 被传成 . 或 .. 之类，就会把源码甚至父目录删掉。
 * 规则：必须是绝对路径、不能是文件系统根、不能是仓库根或其祖先。
 */
function assertSafeOutputDir(dir) {
  const abs = path.resolve(String(dir || ''));
  if (!path.isAbsolute(abs)) die('输出目录不是绝对路径：' + dir);
  const parsed = path.parse(abs);
  if (abs === parsed.root) die('拒绝把文件系统根目录当作输出目录：' + abs);
  const relToRoot = path.relative(ROOT, abs);
  const isRepoRoot = relToRoot === '';
  const isAncestor = relToRoot.startsWith('..' + path.sep) || (relToRoot === '..');
  if (isRepoRoot || isAncestor) {
    die('拒绝把仓库根目录或其上级当作输出目录（--out 请指向一个构件目录）：' + abs);
  }
  return abs;
}

/** 人类可读字节数（与后端 fmt 无关，构建脚本自带一份，避免耦合） */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 递归统计目录里的文件数与总字节数 */
function treeStats(dir) {
  let files = 0, bytes = 0;
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { files++; bytes += sizeOf(full); }
    }
  }
  walk(dir);
  return { files: files, bytes: bytes };
}

function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
  catch (e) { return null; }
}

/** 找一个可用的 .NET Framework C# 编译器（系统自带，无需 Visual Studio） */
function findCsc() {
  const windir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const cands = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ];
  for (const c of cands) if (exists(c)) return c;
  return null;
}

/** 读 PE 头里的 Machine 字段：0x8664 = x64，0x014c = x86 */
function peMachine(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null;   // 'MZ'
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff + 6 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) return null;  // 'PE\0\0'
    return buf.readUInt16LE(peOff + 4);
  } catch (e) { return null; }
}

/* ---------- 主流程 ---------- */
async function build(opts) {
  const started = Date.now();
  /* never 允许输出目录解析到危险位置：无论是否 --clean 都先校验 */
  const DIST = assertSafeOutputDir(opts.out);
  const APP = path.join(DIST, 'app');

  log.step('漫库桌面构建 → ' + DIST);

  /* 1. 前置检查 */
  const csc = findCsc();
  if (!csc) die('找不到系统自带的 C# 编译器（csc.exe）。请确认已安装 .NET Framework 4.x。');
  log.ok('编译器 ' + csc);

  const hostSrc = path.join(ROOT, 'desktop', 'host', 'Program.cs');
  if (!exists(hostSrc)) die('缺少宿主源码 desktop/host/Program.cs');
  log.ok('宿主源码 desktop/host/Program.cs (' + fmtBytes(sizeOf(hostSrc)) + ')');

  const refs = path.join(ROOT, 'desktop', 'refs');
  const coreDll = path.join(refs, 'Microsoft.Web.WebView2.Core.dll');
  const winFormsDll = path.join(refs, 'Microsoft.Web.WebView2.WinForms.dll');
  const loaderDll = path.join(refs, 'WebView2Loader.dll');
  for (const d of [coreDll, winFormsDll, loaderDll]) {
    if (!exists(d)) die('缺少 WebView2 引用库：' + d + '\n    请把 NuGet Microsoft.Web.WebView2 的 DLL 放进 desktop/refs/（见 docs/DESKTOP.md）');
  }
  log.ok('WebView2 引用库 desktop/refs/ 齐全（3 个 DLL）');

  const icon = path.join(ROOT, 'assets', 'icon.ico');
  const hasIcon = exists(icon);

  /* 2. 准备输出目录（删之前先过安全闸门） */
  if (opts.clean && exists(DIST)) {
    assertSafeOutputDir(DIST);
    fs.rmSync(DIST, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(APP, { recursive: true });

  /* 3. 编译宿主 */
  log.step('编译原生宿主（/target:winexe /platform:x64）');
  const exePath = path.join(DIST, 'MangaVault.exe');
  const cscArgs = [
    '/nologo', '/noconfig',
    // /codepage:65001 是必需的：源码是 UTF-8 且无 BOM，不加这一项 csc 会按系统 ANSI
    // 解析，界面上的中文会全部变成乱码。
    '/codepage:65001',
    '/target:winexe', '/platform:x64', '/optimize+', '/debug-',
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:' + coreDll,
    '/reference:' + winFormsDll,
    '/out:' + exePath,
    hostSrc
  ];
  if (hasIcon) cscArgs.splice(cscArgs.length - 1, 0, '/win32icon:' + icon);

  const res = spawnSync(csc, cscArgs, { encoding: 'utf8', windowsHide: true, cwd: ROOT });
  const cscOut = String(res.stdout || '') + String(res.stderr || '');
  if (cscOut.trim()) cscOut.trim().split(/\r?\n/).forEach(function (l) { log.info(l); });
  if (res.status !== 0 || !exists(exePath)) {
    die('编译失败（csc 退出码 ' + res.status + '）' + (res.error ? '：' + res.error.message : ''));
  }
  const exeBytes = sizeOf(exePath);
  log.ok('MangaVault.exe ' + fmtBytes(exeBytes) + ' (sha256:' + sha256(exePath) + ')');

  const machine = peMachine(exePath);
  if (machine !== 0x8664) {
    die('产物架构不对：PE Machine=0x' + (machine === null ? '??' : machine.toString(16)) + '，期望 0x8664（x64）');
  }
  log.ok('PE 架构校验通过：0x8664（x64）');

  /* 4. 拷 WebView2 运行时依赖（必须与 exe 同目录） */
  log.step('拷贝 WebView2 运行时依赖到 exe 同目录');
  const runtimeDlls = [
    { from: coreDll, name: 'Microsoft.Web.WebView2.Core.dll' },
    { from: winFormsDll, name: 'Microsoft.Web.WebView2.WinForms.dll' },
    { from: loaderDll, name: 'WebView2Loader.dll' }
  ];
  for (const d of runtimeDlls) {
    fs.copyFileSync(d.from, path.join(DIST, d.name));
    log.ok(d.name + '  ' + fmtBytes(sizeOf(path.join(DIST, d.name))));
  }
  if (hasIcon) { fs.copyFileSync(icon, path.join(DIST, 'icon.ico')); log.ok('icon.ico  ' + fmtBytes(sizeOf(icon))); }

  /* 5. 拷后端与前端到 app/ */
  log.step('拷贝后端与前端到 app/');
  /* ★ desktop/ 必须一起打包：src/modules/desktop/index.mjs 会 import
       '../../../desktop/lib.mjs'（窗口记忆/命令行拼装等纯函数层）。
       漏掉它会导致「desktop 模块加载失败」，而这在页面上几乎看不出来 ——
       页面照常渲染，只有 /api/desktop/* 全部失效。已真实踩到过（原生能力桥全程不通）。
       refs/ 是编译期引用库（DLL），host/ 是宿主 C# 源码，都不属于运行时载荷。 */
  const payload = [
    { from: path.join(ROOT, 'src'), to: path.join(APP, 'src') },
    { from: path.join(ROOT, 'public'), to: path.join(APP, 'public') },
    {
      from: path.join(ROOT, 'desktop'),
      to: path.join(APP, 'desktop'),
      skip: function (src) {
        const rel = path.relative(path.join(ROOT, 'desktop'), src);
        const top = rel.split(path.sep)[0];
        return top !== 'refs' && top !== 'host' && top !== 'node_modules';
      }
    }
  ];
  for (const p of payload) {
    if (!exists(p.from)) die('缺少资源目录：' + p.from);
    fs.cpSync(p.from, p.to, { recursive: true, filter: p.skip });
    const st = treeStats(p.to);
    log.ok(path.basename(p.from) + '/ → app/' + path.basename(p.from) + '/  ' + st.files + ' 个文件, ' + fmtBytes(st.bytes));
  }
  for (const f of ['package.json', 'config.example.json']) {
    const s = path.join(ROOT, f);
    if (exists(s)) { fs.copyFileSync(s, path.join(APP, f)); log.ok('app/' + f + '  ' + fmtBytes(sizeOf(s))); }
    else log.warn('缺少 ' + f + '（跳过）');
  }

  /* 6. 可选：内联 Node 运行时 */
  let nodeCopied = null;
  if (opts.withNode) {
    log.step('内联 Node 运行时（--with-node）');
    const nodeExe = process.execPath;
    if (!exists(nodeExe)) die('找不到当前 Node 可执行文件：' + nodeExe);
    const nodeDir = path.join(DIST, 'node');
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.copyFileSync(nodeExe, path.join(nodeDir, 'node.exe'));
    nodeCopied = path.join(nodeDir, 'node.exe');
    log.ok('node/node.exe  ' + fmtBytes(sizeOf(nodeCopied)));
    log.info('注意：内联后宿主会优先使用 dist/node/node.exe，用户机器无需装 Node');
  } else {
    log.info('未内联 Node 运行时（需要绿色免安装包请加 --with-node）');
    log.info('宿主会依次找：dist/node/node.exe → 系统 nodejs 安装路径');
  }

  /* 7. 构建清单 */
  const info = {
    name: 'MangaVault',
    version: '1.0.0',
    builtAt: new Date().toISOString(),
    csc: csc,
    peMachine: '0x8664',
    exe: { file: 'MangaVault.exe', bytes: exeBytes, sha256_16: sha256(exePath) },
    withNode: Boolean(nodeCopied),
    appFiles: treeStats(APP).files
  };
  fs.writeFileSync(path.join(DIST, 'build-info.json'), JSON.stringify(info, null, 2), 'utf8');

  /* 8. 产物清单 */
  log.step('产物清单');
  const rows = [
    { name: 'MangaVault.exe', bytes: exeBytes },
    { name: 'Microsoft.Web.WebView2.Core.dll', bytes: sizeOf(path.join(DIST, 'Microsoft.Web.WebView2.Core.dll')) },
    { name: 'Microsoft.Web.WebView2.WinForms.dll', bytes: sizeOf(path.join(DIST, 'Microsoft.Web.WebView2.WinForms.dll')) },
    { name: 'WebView2Loader.dll', bytes: sizeOf(path.join(DIST, 'WebView2Loader.dll')) }
  ];
  if (exists(path.join(DIST, 'icon.ico'))) rows.push({ name: 'icon.ico', bytes: sizeOf(path.join(DIST, 'icon.ico')) });
  if (nodeCopied) rows.push({ name: 'node/node.exe', bytes: sizeOf(nodeCopied) });
  rows.push({ name: 'app/ (' + treeStats(APP).files + ' 个文件)', bytes: treeStats(APP).bytes });
  rows.push({ name: 'build-info.json', bytes: sizeOf(path.join(DIST, 'build-info.json')) });

  let total = 0;
  const width = rows.reduce(function (m, r) { return Math.max(m, r.name.length); }, 0);
  for (const r of rows) {
    total += r.bytes;
    console.log('    ' + r.name.padEnd(width) + '  ' + fmtBytes(r.bytes).padStart(10));
  }
  console.log('    ' + '-'.repeat(width + 12));
  console.log('    ' + '合计'.padEnd(width) + '  ' + fmtBytes(total).padStart(10));

  console.log('');
  log.ok('构建完成，用时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
  log.info('输出目录：' + DIST);
  log.info('绿色包用法：整个 dist/ 拷到任意位置，双击 MangaVault.exe' + (nodeCopied ? '' : '（目标机器需已装 Node.js 20+）'));
  return info;
}

/* ---------- 入口 ---------- */
async function main() {
  try {
    await build(parseArgs(process.argv.slice(2)));
    return 0;
  } catch (err) {
    if (!(err instanceof BuildError)) {
      log.bad('构建异常：' + (err && err.stack ? err.stack : String(err)));
    }
    return 1;
  }
}

export { assertSafeOutputDir };

/* 直接运行时才跑构建；被 import 时（单测）只导出纯函数 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main());
}
