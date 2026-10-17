/**
 * 漫库 MangaVault · 项目卫生工具（零依赖）
 *
 *   node scripts/tidy.mjs            # 默认 dry-run，只报告，不动任何文件
 *   node scripts/tidy.mjs --apply    # 只做「安全清理」：.tmp- 残留 / 死锁文件 / 验证截图 / 过期日志
 *   node scripts/tidy.mjs --json     # 机读输出（含卫生评分与全量发现）
 *   node scripts/tidy.mjs --strict   # 存在高危项时以退出码 1 结束（CI 用）
 *
 * 红线：--apply 绝不删除 src/ public/ docs/ tests/ desktop/ assets/ scripts/ 下的任何文件，
 *       也绝不触碰本项目根之外的用户漫画目录。
 *
 * 口径说明：
 *   - console.log 只查「业务代码」(src/ public/)，scripts/ 是开发工具，允许打印。
 *   - 单文件过大只对产品代码与测试计分（src/ public/ desktop/ tests/），scripts/ 是一次性工具。
 *   - 每个类别扣分上限 15，避免单一噪声类别把评分压死。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
/** 真实数据目录（v3 已迁到 %LOCALAPPDATA%\\MangaVault）：用于检查锁文件与索引体积 */
let REAL_DATA_DIR = path.join(PROJECT_ROOT, 'data');
try {
  const cfgMod = await import('../src/core/config.mjs');
  REAL_DATA_DIR = cfgMod.dataDir();
} catch (e) { /* 回退仓库 data/ */ }
if (!path.isAbsolute(REAL_DATA_DIR)) REAL_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const JSON_OUT = ARGS.includes('--json');
const STRICT = ARGS.includes('--strict');
const BT = String.fromCharCode(96);   // 反引号：项目约定禁止模板字符串

// 只扫「代码与工具」：data/ dist/ build/ _spike/ 是运行时数据与构建产物，
// 里面是 Edge profile / 截图 / 打包产物，按源码残留来报只会制造海量误报。
const SKIP_DIRS = new Set(['node_modules', '.git', '.idea', '.vscode', '.cache', 'data', 'dist', 'build', '_spike']);
// --apply 的硬边界：这些目录里的任何文件都不允许被删除
const PROTECTED_DIRS = new Set(['src', 'public', 'docs', 'tests', 'desktop', 'assets', 'scripts', 'data', 'dist', 'build', '_spike']);
const PRODUCT_DIRS = ['src', 'public', 'desktop', 'tests'];
const BIG_FILE_BYTES = 8 * 1024 * 1024;
const BIG_SOURCE_LINES = 300;
const OLD_LOG_DAYS = 30;
const CAT_CAP = 15;
const SEV_WEIGHT = { high: 6, mid: 3, low: 1 };
const INFO_CATS = new Set(['运行中实例', '仓库目录体积']);
const SELF_FILES = new Set(['scripts/tidy.mjs']);   // 工具自身内含匹配模式字样，跳过自检
/**
 * 合法的 process.env.TEMP/TMP 使用点：
 * src/core/util.mjs 的 safeTmpDir() 里，这些值是**候选**且逐个性过 path.isAbsolute()，
 * 正是这个陷阱的正确解法本身，不应被当成违规。
 */
const TEMP_ENV_ALLOWED = new Set([
  'src/core/util.mjs',   // safeTmpDir() 的候选链，是规则本身
  'scripts/tidy.mjs'     // 本工具的检查逻辑里含模式字符串，跳过自检
]);
/** 根目录下这些名字的条目 = 路径拼接失败的产物（process.env 为空时拼出来的） */
const POLLUTED_NAMES = new Set(['undefined', 'NaN', 'null']);

const findings = [];

/** 登记一条发现 */
function add(cat, sev, rel, message, extra) {
  findings.push(Object.assign({ cat: cat, sev: sev, rel: rel, message: message, fix: null, line: 0 }, extra || {}));
}

function relOf(abs) { return path.relative(PROJECT_ROOT, abs).split(path.sep).join('/'); }

function isBusiness(rel) { return rel.startsWith('src/') || rel.startsWith('public/'); }
function inProduct(rel) { return PRODUCT_DIRS.indexOf(rel.split('/')[0]) >= 0; }

/** 递归遍历项目（只读） */
async function walk(dir, out) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.dirs.push(abs);
      await walk(abs, out);
    } else if (ent.isFile()) {
      let st = null;
      try { st = await fsp.stat(abs); } catch (e) { continue; }
      out.files.push({ abs: abs, rel: relOf(abs), size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

function readTextSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v = v / 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(v < 10 ? 2 : 1)) + ' ' + units[i];
}

/** 去掉单/双引号字符串内容，便于区分「模板字符串」与「字符串里的反引号」 */
function stripQuoted(line) {
  return line.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** 去掉注释（块注释与行注释），保持行号不变，避免注释里的反引号被误判成模板字符串 */
function stripComments(text) {
  let out = '';
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (inBlock) {
      if (ch === '*' && nx === '/') { inBlock = false; out += '  '; i++; }
      else out += (ch === '\n' ? '\n' : ' ');
      continue;
    }
    if (ch === '/' && nx === '*') { inBlock = true; out += '  '; i++; continue; }
    if (ch === '/' && nx === '/') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** 进程是否存活（用于判定孤立锁文件） */
function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/* ============================ 各类检查 ============================ */

function checkTmpResidue(all) {
  for (const f of all.files) {
    if (!/\.tmp-|\.tmp$/i.test(f.rel)) continue;
    add('临时残留', 'mid', f.rel, '遗留临时文件（' + fmtBytes(f.size) + '）', { fix: 'delete' });
  }
}

/** 仓库里的 data/ dist/ build/ _spike/ 只报体积：信息项、不计分、不清理（含 Edge profile，不计入源码残留） */
function checkRepoDirs() {
  const INFRA = ['data', 'dist', 'build', '_spike'];
  for (const name of INFRA) {
    const dir = path.join(PROJECT_ROOT, name);
    if (!fs.existsSync(dir)) continue;
    let files = 0, bytes = 0;
    const walkDir = function (d) {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        const abs = path.join(d, ent.name);
        if (ent.isDirectory()) walkDir(abs);
        else if (ent.isFile()) { files++; try { bytes += fs.statSync(abs).size; } catch (e) { /* ignore */ } }
      }
    };
    walkDir(dir);
    if (!files) continue;
    add('仓库目录体积', 'low', name + '/', name + '/ 含 ' + files + ' 个文件 / ' + fmtBytes(bytes) + '（运行时数据或构建产物，不计分、不清理）', {});
  }
}

function checkLock() {
  const lock = path.join(REAL_DATA_DIR, 'server.lock.json');
  if (!fs.existsSync(lock)) return;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (e) { raw = null; }
  const pid = raw && raw.pid;
  // 在数据目录（可能在 %LOCALAPPDATA%），不属于 --apply 的清理范围，只报告
  if (!pidAlive(pid)) {
    add('孤立锁文件', 'mid', '<数据目录>/server.lock.json', '记录 pid ' + (pid || '?') + ' 已不存在，是陈旧锁（会让启动误判「已在运行」）。重启一次服务即可清理。路径：' + lock, {});
  } else {
    add('运行中实例', 'low', '<数据目录>/server.lock.json', '服务正在运行（pid ' + pid + '）——不清理（信息项，不计分）', {});
  }
}

async function checkEmptyDirs(all) {
  for (const dir of all.dirs) {
    const rel = relOf(dir);
    if (rel === '') continue;
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch (e) { continue; }
    const kept = entries.filter(function (n) { return !SKIP_DIRS.has(n) && n !== '.gitkeep'; });
    if (kept.length === 0) add('空目录', 'low', rel + '/', entries.length ? '只含 .gitkeep' : '完全空的目录', {});
  }
}

function checkBigFiles(all) {
  for (const f of all.files) {
    if (f.size <= BIG_FILE_BYTES) continue;
    const sev = /\.log$/i.test(f.rel) ? 'high' : 'mid';
    add('大文件', sev, f.rel, fmtBytes(f.size) + ' 超过 8MB 阈值', {});
  }
  try {
    const st = fs.statSync(path.join(REAL_DATA_DIR, 'library-index.json'));
    const sev = st.size > 8 * 1024 * 1024 ? 'mid' : 'low';
    add('索引体积', sev, '<数据目录>/library-index.json', '漫画库索引 ' + fmtBytes(st.size) + '（含全部章节图片名，随库规模线性增长）', {});
  } catch (e) { /* 还没扫描过，没有索引 */ }
}

function checkLogsAge(all) {
  const cutoff = Date.now() - OLD_LOG_DAYS * 86400000;
  for (const f of all.files) {
    if (!/\.log(\.[0-9]+)?$/i.test(f.rel)) continue;
    if (f.mtimeMs < cutoff) {
      add('过期日志', 'low', f.rel, '最后写入 ' + new Date(f.mtimeMs).toISOString().slice(0, 10) + '，超过 ' + OLD_LOG_DAYS + ' 天', { fix: 'delete' });
    }
  }
}

function checkBackups(all) {
  const groups = new Map();
  for (const f of all.files) {
    if (!/\.(bak|old|orig|save)$/i.test(f.rel) && !/~$/.test(f.rel)) continue;
    const base = f.rel.replace(/\.(bak|old|orig|save)$/i, '').replace(/~$/, '');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(f);
  }
  for (const entry of groups) {
    const base = entry[0], list = entry[1];
    const bytes = list.reduce(function (n, f) { return n + f.size; }, 0);
    const sev = list.length >= 3 || bytes > 1024 * 1024 ? 'mid' : 'low';
    add('备份堆积', sev, base, list.length + ' 个备份副本（' + fmtBytes(bytes) + '）：' + list.map(function (f) { return path.basename(f.rel); }).join(', '), {});
  }
}

/** 项目卫生：tests/ 下只允许 *.test.mjs；一次性脚本必须放 scripts/dev/ */
function checkLayout(all) {
  for (const f of all.files) {
    const base = path.basename(f.rel);
    if (f.rel.startsWith('tests/') && !f.rel.endsWith('.test.mjs') && base !== 'run-tests.mjs') {
      add('测试目录卫生', 'high', f.rel, 'tests/ 下只允许 *.test.mjs（和运行器 run-tests.mjs），该文件不符合约定', {});
    }
    if (/^(src|public|tests|desktop)\/.*\/dev\//.test(f.rel)) {
      add('脚本归位', 'mid', f.rel, '一次性/开发脚本应放在 scripts/dev/ 而不是模块目录下', {});
    }
  }
}

function checkSourceHygiene(all) {
  const sources = all.files.filter(function (f) { return /\.(mjs|js|cjs)$/i.test(f.rel) && inProduct(f.rel); });
  for (const f of sources) {
    const text = readTextSafe(f.abs);
    if (!text) continue;
    const lines = text.split('\n');
    /* 注释必须先对**整个文件**剥离一次再按行取用。
       逐行调用 stripComments 时，它在每行开头都把 inBlock 重置为 false，
       于是「多行块注释」内部的代码字符（含反引号）会被当成真代码 ——
       这正是 src/modules/download/api.mjs 里那条「模板字符串」误报的成因。 */
    const codeLines = stripComments(text).split('\n');
    const selfFile = SELF_FILES.has(f.rel);
    if (!selfFile && lines.length > BIG_SOURCE_LINES) {
      add('单文件过大', 'mid', f.rel, lines.length + ' 行，超过 ' + BIG_SOURCE_LINES + ' 行，建议拆分', { line: lines.length });
    }
    const biz = isBusiness(f.rel);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (biz && /console\.log\s*\(/.test(line)) {
        add('console.log', 'low', f.rel, '业务代码里的调试输出：' + line.trim().slice(0, 70), { line: i + 1 });
      }
      if (!selfFile && /\b(TODO|FIXME|XXX|HACK)\b/.test(line)) {
        add('TODO/FIXME', 'low', f.rel, line.trim().slice(0, 80), { line: i + 1 });
      }
      if (biz) {
        const codeOnly = stripQuoted(codeLines[i] || '');
        const btIdx = codeOnly.indexOf(BT);
        if (btIdx >= 0) {
          // 只在「该出现字符串字面量的位置」判为模板字符串；
          // 字符类 /[&|<>^%"!`]/ 里的反引号前面是引号或 [，不会被误判
          const before = codeOnly.slice(0, btIdx).replace(/\s+$/, '');
          // 正则字符类里的反引号不是模板字符串（例：/[&|<>^%"!`]/）
          const insideCharClass = (before.match(/\[/g) || []).length > (before.match(/\]/g) || []).length;
          if (!insideCharClass && (before === '' || /[=(,:\[+!?&|>]$/.test(before) || /\breturn$/.test(before))) {
            add('模板字符串', 'mid', f.rel, '项目约定禁用反引号模板字符串（跨 Agent 转义事故）：' + line.trim().slice(0, 70), { line: i + 1 });
          }
        }
      }
    }
  }
}

function checkUnusedData(all) {
  const dataFiles = all.files.filter(function (f) { return f.rel.startsWith('data/') && f.rel.endsWith('.json'); });
  if (!dataFiles.length) return;
  const srcText = all.files
    .filter(function (f) { return /\.(mjs|js)$/i.test(f.rel) && (f.rel.startsWith('src/') || f.rel.startsWith('desktop/')); })
    .map(function (f) { return readTextSafe(f.abs); })
    .join('\n');
  for (const f of dataFiles) {
    const base = path.basename(f.rel);
    if (srcText.includes(base)) continue;
    if (/^(server\.lock|library-index|library-progress|library-marks)\.json$/.test(base)) continue;
    add('孤儿数据文件', 'mid', f.rel, '没有任何 src/ 代码引用该文件名，可能是历史残留（' + fmtBytes(f.size) + '）', {});
  }
}

function checkDependencies(all) {
  const sources = all.files.filter(function (f) {
    return /\.(mjs|js|cjs)$/i.test(f.rel) && /^(src|tests|scripts|desktop)\//.test(f.rel);
  });
  for (const f of sources) {
    const lines = readTextSafe(f.abs).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const specs = [];
      let m;
      const reFrom = /from\s+['"]([^'"]+)['"]/g;
      while ((m = reFrom.exec(line)) !== null) specs.push(m[1]);
      const reDyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((m = reDyn.exec(line)) !== null) specs.push(m[1]);
      const bm = /^\s*import\s+['"]([^'"]+)['"]/.exec(line);
      if (bm) specs.push(bm[1]);
      for (const s of specs) {
        if (s.startsWith('.') || s.startsWith('node:')) continue;
        add('零依赖红线', 'high', f.rel, '非 node: 且非相对路径的 import：' + s, { line: i + 1 });
      }
    }
  }
}

/**
 * 路径污染检查：
 *  1) 项目根出现名为 undefined / NaN / null 的条目 —— 这是路径拼接失败的铁证，高危。
 *  2) 源码里裸用 process.env.TEMP / process.env.TMP —— 该走 util.safeTmpDir()，警告。
 */
function checkPathPollution(all) {
  /* 1) 根目录污染 */
  for (const d of all.dirs) {
    if (path.dirname(d) !== PROJECT_ROOT) continue;
    const name = path.basename(d);
    if (POLLUTED_NAMES.has(name)) {
      /*
       * 只报告、不自动删：applyCleanup 只处理文件，而删整棵目录树风险更高。
       * 请人工确认后删除（确认它确实是拼接失败的产物，不是你自己建的同名目录）。
       */
      add('路径污染', 'high', relOf(d) + '/',
        '根目录出现名为「' + name + '」的目录：路径拼接时变量为 ' + name + '（常见于 process.env.TEMP/TMP 为空）。应立即人工删除，并改用 util.safeTmpDir() 取临时目录',
        {});
    }
  }
  for (const f of all.files) {
    if (path.dirname(f.abs) !== PROJECT_ROOT) continue;
    const name = path.basename(f.rel);
    if (POLLUTED_NAMES.has(name)) {
      add('路径污染', 'high', f.rel, '根目录出现名为「' + name + '」的文件：路径拼接失败产物', { fix: 'delete' });
    }
  }

  /* 2) 源码里裸用 process.env.TEMP / TMP */
  const sources = all.files.filter(function (f) {
    return /\.(mjs|js|cjs)$/i.test(f.rel) && /^(src|tests|scripts|desktop)\//.test(f.rel);
  });
  for (const f of sources) {
    if (TEMP_ENV_ALLOWED.has(f.rel)) continue;
    /* 先把注释整体抹掉再逐行匹配：单行块注释与多行块注释都不会误报 */
    const lines = stripComments(readTextSafe(f.abs)).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i];
      if (!/\bprocess\.env\.(TEMP|TMP)\b/.test(code)) continue;
      if (/\|\||\?\?/.test(code)) continue;   // 已有兜底链，不算裸用
      add('临时路径卫生', 'low', f.rel,
        '裸用 process.env.TEMP/TMP（process.env 可能为空对象）：' + code.trim().slice(0, 70) + ' —— 建议改用 util.safeTmpDir()',
        { line: i + 1 });
    }

    /* 3) 危险的递归删除：目标不是字面量时必须人工确认 */
    const text = readTextSafe(f.abs);
    const safeVars = new Set();
    let sm = null;
    const reSafeVar = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*os\.tmpdir\(\)/g;
    while ((sm = reSafeVar.exec(text)) !== null) safeVars.add(sm[1]);
    const reSafeJoin = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.join\(\s*([A-Za-z_$][\w$]*)/g;
    while ((sm = reSafeJoin.exec(text)) !== null) { if (safeVars.has(sm[2])) safeVars.add(sm[1]); }
    for (let i = 0; i < lines.length; i++) {
      const m = /(?:fs|fsp)\.(?:rm|rmdir|rmSync|rmdirSync)\(\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")/.exec(lines[i]);
      if (!m) continue;
      if (f.rel.startsWith('tests/')) continue;   // 测试的删除目标都是 os.tmpdir() 样本，噪音大
      const ctxWindow = lines.slice(Math.max(0, i - 5), i + 1).join(' ');
      if (/isAbsolute\(|safeJoin\(|insideRoot\(|startsWith\(|ownerRootOf\(/.test(ctxWindow)) continue;   // 上文已有校验
      const target = m[1];
      if (/^['"]/.test(target)) continue;      // 字面量
      if (safeVars.has(target)) continue;      // 源自 os.tmpdir() 的临时路径
      add('路径安全', 'low', f.rel,
        '删除目标是变量「' + target + '」：删前必须断言绝对路径、且不在仓库根或盘根之上',
        { line: i + 1 });
    }

    /* 4) path.join(process.env.X, …) 缺少 || / ?? 兜底 */
    for (let i = 0; i < lines.length; i++) {
      if (!/path\.join\(\s*process\.env\./.test(lines[i])) continue;
      const near = lines.slice(i, i + 3).join(' ');
      if (/\|\||\?\?/.test(near)) continue;
      add('路径安全', 'mid', f.rel,
        'path.join(process.env.X, …) 未见 || / ?? 兜底：process.env 为空时会拼出相对路径落进仓库根',
        { line: i + 1 });
    }
  }
}

/* ============================ 安全清理 ============================ */

function deletable(rel) { return !PROTECTED_DIRS.has(rel.split('/')[0]); }

async function applyCleanup() {
  const targets = findings.filter(function (f) { return f.fix === 'delete'; });
  let done = 0, skipped = 0, freed = 0;
  for (const f of targets) {
    const rel = (f.rel || '').replace(/\/$/, '');
    if (!rel || !deletable(rel)) { skipped++; continue; }
    const resolved = path.resolve(path.join(PROJECT_ROOT, rel));
    if (!resolved.startsWith(PROJECT_ROOT + path.sep)) { skipped++; continue; }
    let st = null;
    try { st = await fsp.stat(resolved); } catch (e) { skipped++; continue; }
    if (!st.isFile()) { skipped++; continue; }
    try {
      await fsp.unlink(resolved);
      done++;
      freed += st.size;
      process.stdout.write('  清理 ' + rel + '  (' + fmtBytes(st.size) + ')\n');
    } catch (e) {
      skipped++;
      process.stdout.write('  跳过 ' + rel + '  (' + (e && e.message) + ')\n');
    }
  }
  process.stdout.write('\n安全清理：删除 ' + done + ' 个文件，释放 ' + fmtBytes(freed) + '，跳过 ' + skipped + ' 个。\n');
}

/* ============================ 主流程 ============================ */

const all = await walk(PROJECT_ROOT, { files: [], dirs: [] });

checkTmpResidue(all);
checkRepoDirs();
checkLock();
await checkEmptyDirs(all);
checkBigFiles(all);
checkLogsAge(all);
checkBackups(all);
checkLayout(all);
checkSourceHygiene(all);
checkPathPollution(all);
checkUnusedData(all);
checkDependencies(all);

const CATS = ['零依赖红线', '测试目录卫生', '模板字符串', 'console.log', 'TODO/FIXME', '临时残留', '孤立锁文件', '仓库目录体积',
  '验证截图', '过期日志', '大文件', '索引体积', '备份堆积', '脚本归位', '空目录', '单文件过大', '孤儿数据文件', '运行中实例',
  '路径污染', '临时路径卫生', '路径安全'];

let penalty = 0;
const penaltyByCat = {};
for (const cat of CATS) {
  if (INFO_CATS.has(cat)) { penaltyByCat[cat] = 0; continue; }
  const raw = findings.filter(function (f) { return f.cat === cat; })
    .reduce(function (n, f) { return n + (SEV_WEIGHT[f.sev] || 1); }, 0);
  penaltyByCat[cat] = Math.min(raw, CAT_CAP);
  penalty += penaltyByCat[cat];
}
const score = Math.max(0, Math.min(100, 100 - penalty));
const grade = score >= 90 ? 'A（优秀）' : score >= 75 ? 'B（良好）' : score >= 60 ? 'C（及格）' : 'D（需要整治）';
const highCount = findings.filter(function (f) { return f.sev === 'high'; }).length;

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ score: score, grade: grade, penalty: penalty, penaltyByCat: penaltyByCat, findings: findings }, null, 2) + '\n');
} else {
  process.stdout.write('\n══ 漫库 MangaVault · 项目卫生报告 ══\n');
  process.stdout.write('根目录：' + PROJECT_ROOT + '\n');
  process.stdout.write('模式：' + (APPLY ? 'APPLY（安全清理）' : 'DRY-RUN（只报告）') + '\n');
  process.stdout.write('扫描：' + all.files.length + ' 个文件 / ' + all.dirs.length + ' 个目录\n');
  if (!findings.length) process.stdout.write('\n未发现问题，项目很干净。\n');
  for (const cat of CATS) {
    const catList = findings.filter(function (f) { return f.cat === cat; });
    if (!catList.length) continue;
    process.stdout.write('\n【' + cat + '】' + catList.length + ' 条（扣 ' + (penaltyByCat[cat] || 0) + ' 分）\n');
    const shown = catList.slice(0, 40);
    for (const f of shown) {
      const loc = f.line ? f.rel + ':' + f.line : f.rel;
      process.stdout.write('  [' + f.sev.toUpperCase() + '] ' + loc + '  ' + f.message + '\n');
    }
    if (catList.length > shown.length) process.stdout.write('  … 另有 ' + (catList.length - shown.length) + ' 条（--json 看全量）\n');
  }
  process.stdout.write('\n卫生评分：' + score + ' / 100  →  ' + grade + '\n');
  process.stdout.write('总扣分：' + penalty + '（高危 ' + highCount + ' / 中危 ' + findings.filter(function (f) { return f.sev === 'mid'; }).length + ' / 低危 ' + findings.filter(function (f) { return f.sev === 'low'; }).length + '，每类封顶 ' + CAT_CAP + ' 分）\n');
  if (APPLY) {
    process.stdout.write('\n── 执行安全清理 ──\n');
    await applyCleanup();
  } else {
    const fixable = findings.filter(function (f) { return f.fix === 'delete'; });
    process.stdout.write('\n可安全清理：' + fixable.length + ' 个文件。加 --apply 执行（只删临时残留/死锁/验证截图/过期日志）。\n');
  }
  process.stdout.write('\n');
}

process.exit(STRICT && highCount ? 1 : 0);