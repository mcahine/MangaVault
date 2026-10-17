/**
 * 漫库 MangaVault · 独立静态审计器（零依赖）
 *
 *   node scripts/audit.mjs            # 审计并写出 docs/AUDIT.md
 *   node scripts/audit.mjs --stdout   # 只打印，不写文件
 *
 * 只读：本脚本不修改任何业务代码，只产出报告。发现问题由 QA 上报 Lead / 对应 owner。
 *
 * 启发式口径（已知局限，报告里会如实标注）：
 *   - 路由体用花括号配对粗略切分，不做 AST 解析：路径拼接/IO 检查按「同一行」判定，
 *     多行拼接可能漏报；try/catch 判定按整个 handler 体。
 *   - 只把「同句出现请求参数 + path.join」列为高危，避免误报（索引里的字段不是请求参数）。
 *   - 「有 await 无 try/catch」是设计允许的（框架统一兜底），只统计不扣分。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const OUT_FILE = path.join(PROJECT_ROOT, 'docs', 'AUDIT.md');
const STDOUT_ONLY = process.argv.includes('--stdout');
const SKIP_DIRS = new Set(['node_modules', '.git', '.idea', '.vscode', '.cache']);

const findings = [];
/** 登记审计发现 */
function add(cat, sev, rel, line, message, owner) {
  findings.push({ cat: cat, sev: sev, rel: rel, line: line || 0, message: message, owner: owner || ownerOf(rel) });
}
function relOf(abs) { return path.relative(PROJECT_ROOT, abs).split(path.sep).join('/'); }
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } }

async function walk(dir, out) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(abs, out);
    else if (ent.isFile()) {
      let st = null;
      try { st = await fsp.stat(abs); } catch (e) { continue; }
      out.push({ abs: abs, rel: relOf(abs), size: st.size });
    }
  }
  return out;
}

/** 归属哪个 Agent 负责修 */
function ownerOf(rel) {
  if (rel.indexOf('src/modules/download') === 0 || rel.indexOf('public/modules/download') === 0) return 'download-smith';
  if (rel.indexOf('src/modules/dedupe') === 0 || rel.indexOf('public/modules/dedupe') === 0) return 'dedupe-smith';
  if (rel.indexOf('desktop/') === 0 || rel.indexOf('src/modules/desktop') === 0 || rel.indexOf('assets/') === 0) return 'desktop-smith';
  if (rel.indexOf('src/modules/vault') === 0 || rel.indexOf('public/modules/vault') === 0) return 'vault-keeper';
  if (rel.indexOf('scripts/') === 0 || rel.indexOf('tests/integration') === 0) return 'qa-smith';
  return 'Lead';
}
function ownerOfEndpoint(p) {
  if (p.indexOf('/api/download') === 0) return 'download-smith';
  if (p.indexOf('/api/dedupe') === 0) return 'dedupe-smith';
  if (p.indexOf('/api/vault') === 0) return 'vault-keeper';
  if (p.indexOf('/api/desktop') === 0) return 'desktop-smith';
  return 'Lead';
}

/** 按归属分组 */
function groupOf(rel) {
  const p = rel.split('/');
  if (p[0] === 'src' && p[1] === 'modules' && p[2]) return 'src/modules/' + p[2];
  if (p[0] === 'src' && p[1] === 'core') return 'src/core';
  if (rel === 'src/server.mjs' || rel === 'src/modules/index.mjs') return 'src（入口）';
  if (p[0] === 'src') return 'src（其他）';
  if (p[0] === 'public' && p[1] === 'modules' && p[2]) return 'public/modules/' + p[2];
  if (p[0] === 'public') return 'public（外壳）';
  if (p[0] === 'tests') return 'tests';
  if (p[0] === 'scripts') return 'scripts';
  if (p[0] === 'desktop') return 'desktop';
  if (p[0] === 'docs') return 'docs';
  if (p[0] === 'assets') return 'assets';
  if (p[0] === 'data') return 'data';
  return '（根目录）';
}

/** 粗略提取花括号块（用于分析 handler 体） */
function blockAfter(text, start) {
  const open = text.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}
function lineOf(text, idx) { return text.slice(0, idx).split('\n').length; }

/* ==================== 1. 文件清单 ==================== */

const all = await walk(PROJECT_ROOT, []);
const inventory = new Map();
for (const f of all) {
  const g = groupOf(f.rel);
  if (!inventory.has(g)) inventory.set(g, []);
  inventory.get(g).push(f);
}
const inventoryRows = [];
for (const entry of inventory) {
  const g = entry[0], list = entry[1];
  let lines = 0, biggest = { rel: '-', lines: 0 };
  for (const f of list) {
    const n = /\.(mjs|js|cjs|css|html)$/i.test(f.rel) ? readText(f.abs).split('\n').length : 0;
    lines += n;
    if (n > biggest.lines) biggest = { rel: f.rel, lines: n };
  }
  inventoryRows.push({ group: g, files: list.length, lines: lines, biggest: biggest });
}
inventoryRows.sort(function (a, b) { return b.lines - a.lines; });

/* ==================== 2. 路由 / 安全 / 健壮性 / 性能 ==================== */

const routeRows = [];
const srcFiles = all.filter(function (f) { return /\.(mjs|js)$/i.test(f.rel) && f.rel.indexOf('src/') === 0; });
const ROUTE_RE = /\bapp\.(get|post|put|del|all)\(\s*['"]([^'"]+)['"]/g;
for (const f of srcFiles) {
  const text = readText(f.abs);
  if (!text) continue;
  let m;
  ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(text)) !== null) {
    routeRows.push({
      rel: f.rel, line: lineOf(text, m.index),
      method: m[1].toUpperCase().replace('DEL', 'DELETE'),
      pattern: m[2],
      body: blockAfter(text, m.index + m[0].length)
    });
  }
}

const SAFE_SAME_LINE = /safeJoin|isInside|insideRoot|ownerRootOf/;
const SAFE_IN_BODY = /safeJoin|isInside|insideRoot|ownerRootOf/;
const REQ_DERIVED = /(?:c|ctx)\.(?:query|queryInt|params)\b|\b(?:body|payload|b)\.[A-Za-z_$]/;
let frameworkFallbackCount = 0;
for (const r of routeRows) {
  const bodyLines = r.body.split('\n');
  for (let i = 0; i < bodyLines.length; i++) {
    const ln = bodyLines[i];
    const absLine = r.line + i;
    if (/path\.join\(/.test(ln) && REQ_DERIVED.test(ln) && !SAFE_SAME_LINE.test(ln)) {
      add('安全', '高', r.rel, absLine, r.method + ' ' + r.pattern + ' 同一句里用请求参数拼路径，且未见 safeJoin（需人工确认）');
    }
  }
  if (/(?:c|ctx)\.file\(/.test(r.body) && REQ_DERIVED.test(r.body) && !SAFE_IN_BODY.test(r.body)) {
    add('安全', '高', r.rel, r.line, r.method + ' ' + r.pattern + ' serveFile 的路径由请求参数推导，整个 handler 未见 safeJoin/isInside/insideRoot（需人工确认）');
  }
  if (/\bnew\s+JsonStore\(/.test(r.body)) {
    add('健壮性', '高', r.rel, r.line, r.method + ' ' + r.pattern + ' 在请求处理器里 new JsonStore（每次请求新建存储实例）');
  }
  if ((/openSSE\(|c\.sse\(|ctx\.sse\(/.test(r.body)) && r.body.indexOf('onClose') < 0) {
    add('健壮性', '中', r.rel, r.line, r.method + ' ' + r.pattern + ' 开了 SSE 但没有 onClose 清理回调（断连可能泄漏）');
  }
  if (/await\s/.test(r.body) && !/try\s*\{/.test(r.body)) {
    frameworkFallbackCount++;
    if (/fsp\.|fs\.createReadStream|fs\.readFile|readJson\(|writeFile|unlink|rename/.test(r.body)) {
      add('健壮性', '低', r.rel, r.line, r.method + ' ' + r.pattern + ' 有文件系统 IO 但无 try/catch（依赖框架兜底 → 500，建议补中文原因）');
    }
  }
  if (r.method === 'GET' && /\.comics\b/.test(r.body) && !/\.slice\(/.test(r.body) && /\.map\(/.test(r.body)) {
    add('性能', '中', r.rel, r.line, r.method + ' ' + r.pattern + ' 对全量漫画数组 map 但未见分页 slice');
  }
  if (/pool\(/.test(r.body) && !/pool\([^)]*,\s*\d/.test(r.body)) {
    add('性能', '低', r.rel, r.line, r.method + ' ' + r.pattern + ' 调用了 pool() 但并发数不是字面量（确认上限）');
  }
}

/* --- 多库根迁移：硬编码单根 --- */
const rootsUsers = new Set();
for (const f of srcFiles) {
  if (/core\/roots\.mjs/.test(readText(f.abs))) rootsUsers.add(f.rel);
}
const ROOT_HARD = /(?:cfg|config|ctx\.config)\.libraryRoot\b/g;
for (const f of srcFiles) {
  if (f.rel === 'src/core/roots.mjs') continue;   // 它本身就是多库根实现
  const text = readText(f.abs);
  const migrated = rootsUsers.has(f.rel);
  let m;
  ROOT_HARD.lastIndex = 0;
  while ((m = ROOT_HARD.exec(text)) !== null) {
    const line = lineOf(text, m.index);
    if (f.rel === 'src/server.mjs') {
      add('多库根', '低', f.rel, line, '入口的兼容字段/启动日志仍用单根 libraryRoot（不影响可见性，建议同时输出各库根）');
    } else if (migrated) {
      add('多库根', '低', f.rel, line, '已迁移多库根，但仍有 libraryRoot 引用（多为旧配置/旧索引回退，建议确认是否必要）');
    } else {
      add('多库根', '高', f.rel, line, '未接 src/core/roots.mjs，仍以单根 libraryRoot 为基准（先期漫画将不可见）');
    }
  }
}

/* --- 定时器 unref --- */
for (const f of srcFiles) {
  const text = readText(f.abs);
  const re = /setInterval\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (text.slice(m.index, m.index + 500).indexOf('.unref(') < 0) {
      add('健壮性', '中', f.rel, lineOf(text, m.index), 'setInterval 未见 .unref()（可能阻止进程退出）');
    }
  }
}

/* --- fs 调用是否有 catch --- */
for (const f of srcFiles) {
  const text = readText(f.abs);
  const fsCalls = (text.match(/await\s+fsp\.|fsp\.\w+\(|fs\.\w+Sync\(/g) || []).length;
  const catches = (text.match(/catch\s*\(/g) || []).length;
  if (fsCalls >= 5 && catches === 0) {
    add('健壮性', '中', f.rel, 0, '有 ' + fsCalls + ' 处文件系统调用但 0 个 catch（IO 失败无兜底）');
  }
}

/* --- 每请求重读大文件 / 同步读 --- */
for (const f of srcFiles) {
  const lines = readText(f.abs).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('library-index.json') >= 0 && lines[i].indexOf('readJson') >= 0) {
      add('性能', '中', f.rel, i + 1, '直接读 library-index.json（应经 core/library-index.mjs 的 mtime 缓存视图）');
    }
    if (/readFileSync\(/.test(lines[i]) && /\bc\)|\(ctx\)|ctx\./.test(lines[i])) {
      add('性能', '低', f.rel, i + 1, '同步读文件出现在请求路径上');
    }
  }
}

/* ==================== 3. v1 视觉残留 ==================== */

const VISUAL_PATTERNS = [
  { re: /backdrop-filter/, sev: '高', name: 'backdrop-filter（玻璃拟态）' },
  { re: /filter\s*:\s*blur\(/, sev: '高', name: 'filter: blur()' },
  { re: /linear-gradient\(\s*1[0-9]{2}deg/, sev: '高', name: 'linear-gradient(1xxdeg) 多色渐变背景' },
  { re: /border-radius\s*:\s*999/, sev: '高', name: 'border-radius: 999px 胶囊圆角' },
  { re: /--grad-/, sev: '高', name: '--grad-* 渐变体系变量' },
  { re: /-webkit-backdrop/, sev: '高', name: '-webkit-backdrop-filter' },
  { re: /text-shadow[^;]*\d+px\s+\d+px\s+\d+px|box-shadow[^;]*\d+px\s+\d+px\s+\d+px\s+rgba/, sev: '中', name: '带模糊半径的阴影（v2 要硬投影 0 blur）' },
  { re: /scale\(0?\.[0-9]+\)/, sev: '低', name: 'transform: scale(.xx) 软反馈' }
];
/** 去掉注释（块注释与行注释），保持行号不变，避免注释里提到被禁项被误判 */
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
const visualFiles = all.filter(function (f) {
  return /\.(css|js|html|mjs)$/i.test(f.rel) && (f.rel.indexOf('public/') === 0 || f.rel.indexOf('src/') === 0);
});
for (const f of visualFiles) {
  const lines = stripComments(readText(f.abs)).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i];
    if (!code.trim()) continue;   // 注释已被替换成空白
    for (const p of VISUAL_PATTERNS) {
      if (!p.re.test(code)) continue;
      let sev = p.sev;
      let note = '';
      if (/linear-gradient/.test(code) && /transparent/.test(code) && /50%/.test(code)) {
        sev = '低';
        note = '（形似「用渐变画形状」而非背景渐变，请人工确认）';
      }
      add('v1 视觉残留', sev, f.rel, i + 1, p.name + note + '  →  ' + code.trim().slice(0, 90));
    }
  }
}

const V2_CLASSES = ['halftone', 'cut', 'stamp', 'misprint', 'label-mono', 'ledger', 'num', 'rule', 'tabbar', 'stripe', 'tilt', 'frame', 'toolgrid'];
const themeText = readText(path.join(PROJECT_ROOT, 'public', 'theme.css'));
const v2Info = V2_CLASSES.map(function (cls) {
  const defined = new RegExp('\\.' + cls.replace('-', '\\-') + '\\b').test(themeText);
  const usedBy = visualFiles.filter(function (f) {
    if (f.rel === 'public/theme.css') return false;
    return new RegExp('\\.' + cls.replace('-', '\\-') + '\\b').test(readText(f.abs));
  }).map(function (f) { return f.rel; });
  return { cls: cls, defined: defined, usedBy: usedBy };
});

/* ==================== 4. 文档一致性 ==================== */

function routeToRegex(pattern) {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, function (x) { return '\\' + x; });
  return new RegExp('^' + esc.replace(/\\:([A-Za-z0-9_]+)/g, '[^/]+') + '/?$');
}
const codePatterns = routeRows.map(function (r) { return r.pattern; }).filter(function (p, i, a) { return a.indexOf(p) === i; });
const codeRxs = codePatterns.map(routeToRegex);

// 只把「真正的接口文档」纳入一致性检查；docs/team/** 是任务书（写的是待实现目标）
const docFiles = all.filter(function (f) {
  return /\.md$/i.test(f.rel) && f.rel.indexOf('docs/team/') !== 0 && f.rel !== 'docs/AUDIT.md';
});
const docEndpoints = new Map();
for (const f of docFiles) {
  const text = readText(f.abs);
  let m;
  const re = /(GET|POST|PUT|DELETE|PATCH)\s+(\/api\/[A-Za-z0-9_\-\/:]+)/g;
  while ((m = re.exec(text)) !== null) {
    const key = m[1] + ' ' + m[2];
    if (!docEndpoints.has(key)) docEndpoints.set(key, f.rel);
  }
  const re2 = /['"`](\/api\/[A-Za-z0-9_\-]+\/[A-Za-z0-9_\-/:]+)['"`]/g;
  while ((m = re2.exec(text)) !== null) {
    const key = 'ANY ' + m[1];
    if (!docEndpoints.has(key)) docEndpoints.set(key, f.rel);
  }
}
const undocumented = [];
for (const entry of docEndpoints) {
  const key = entry[0], docFile = entry[1];
  const p = key.split(' ')[1];
  const hit = codeRxs.some(function (rx) { return rx.test(p); });
  if (!hit) {
    const mod = p.split('/')[2] || '';
    const moduleHasRoutes = codePatterns.some(function (cp) { return cp.indexOf('/api/' + mod + '/') === 0; });
    if (!moduleHasRoutes) add('文档一致性', '低', docFile, 0, '文档声明 ' + key + '，但 ' + mod + ' 模块尚未落地任何路由（任务在途）', ownerOfEndpoint(p));
    else add('文档一致性', '中', docFile, 0, '文档声明 ' + key + '，代码里找不到该路由（文档过期或未实现）', ownerOfEndpoint(p));
  }
}
for (const p of codePatterns) {
  const mentioned = Array.from(docEndpoints.keys()).some(function (k) { return k.split(' ')[1] === p; });
  if (!mentioned) undocumented.push(p);
}

/* ==================== 5. 去重 / 评分 ==================== */

const seenKey = new Set();
for (let i = findings.length - 1; i >= 0; i--) {
  const f = findings[i];
  const k = f.cat + '|' + f.rel + '|' + f.line + '|' + f.message;
  if (seenKey.has(k)) findings.splice(i, 1);
  else seenKey.add(k);
}

const SEV_WEIGHT = { '高': 6, '中': 3, '低': 1 };
const CAT_CAP = 18;
const cats = ['安全', '多库根', '健壮性', '性能', 'v1 视觉残留', '文档一致性'];
let penalty = 0;
const catStat = {};
for (const c of cats) {
  const list = findings.filter(function (f) { return f.cat === c; });
  const raw = list.reduce(function (n, f) { return n + (SEV_WEIGHT[f.sev] || 1); }, 0);
  catStat[c] = { count: list.length, penalty: Math.min(raw, CAT_CAP) };
  penalty += catStat[c].penalty;
}
const score = Math.max(0, Math.min(100, 100 - penalty));
const highList = findings.filter(function (f) { return f.sev === '高'; });
const midList = findings.filter(function (f) { return f.sev === '中'; });
const lowList = findings.filter(function (f) { return f.sev === '低'; });

function table(rows, emptyText) {
  const o = ['| 严重度 | 位置 | 问题 | 建议责任 |', '|---|---|---|---|'];
  if (!rows.length) { o.push('| — | — | ' + emptyText + ' | — |'); return o; }
  for (const f of rows) o.push('| ' + f.sev + ' | `' + f.rel + (f.line ? ':' + f.line : '') + '` | ' + f.message + ' | ' + f.owner + ' |');
  return o;
}

/* ==================== 6. 生成 Markdown ==================== */

const out = [];
out.push('# 漫库 MangaVault · 独立审计报告');
out.push('');
out.push('> 由 `node scripts/audit.mjs` 自动生成（只读静态审计，不修改任何业务代码）。');
out.push('> 生成时间：' + new Date().toISOString());
out.push('> 视觉基线：[`docs/UI_GUIDELINE.md`](./UI_GUIDELINE.md)（RISOPRINT · 深夜制本所）｜ 模块契约：[`docs/MODULE_CONTRACT.md`](./MODULE_CONTRACT.md)');
out.push('');
out.push('**审计评分：' + score + ' / 100**（扣分 ' + penalty + '）｜ 高 ' + highList.length + ' · 中 ' + midList.length + ' · 低 ' + lowList.length);
out.push('');
out.push('---');
out.push('');
out.push('## 1. 文件清单（按归属）');
out.push('');
out.push('| 归属 | 文件数 | 代码行数 | 最大文件 | 行数 |');
out.push('|---|---:|---:|---|---:|');
for (const r of inventoryRows) out.push('| `' + r.group + '` | ' + r.files + ' | ' + r.lines + ' | `' + r.biggest.rel + '` | ' + r.biggest.lines + ' |');
out.push('');
out.push('## 2. 安全');
out.push('');
out.push('规则：**同一句**里出现「请求参数（`c.query` / `c.params` / `body.*`）+ `path.join`」或「请求参数推导的路径 + `ctx.file`」，同句未见 `safeJoin` / `isInside` / `ownerRootOf` 即告警。');
out.push('');
for (const line of table(findings.filter(function (x) { return x.cat === '安全'; }), '未发现明显问题')) out.push(line);
out.push('');
out.push('## 3. 多库根迁移（v2）');
out.push('');
out.push('基线：`config.libraryRoots = [picacg, early]`；只要模块不接 `src/core/roots.mjs` 而以单根 `libraryRoot` 为基准，先期漫画 53 部就不可见 —— 判为**高**。');
out.push('');
for (const line of table(findings.filter(function (x) { return x.cat === '多库根'; }), '多库根迁移已完成，未见单根硬编码')) out.push(line);
out.push('');
out.push('## 4. 健壮性');
out.push('');
out.push('检查项：handler 内 `new JsonStore`、SSE `onClose` 清理、定时器 `unref()`、fs 调用错误处理。');
out.push('说明：「有 `await` 但无 `try/catch`」是契约允许的（`src/core/http.mjs` 统一兜底成人话错误），**只统计不扣分**：当前 ' + frameworkFallbackCount + ' 条路由依赖框架兜底。');
out.push('');
for (const line of table(findings.filter(function (x) { return x.cat === '健壮性'; }), '未发现明显问题')) out.push(line);
out.push('');
out.push('## 5. 性能');
out.push('');
out.push('检查项：一次性渲染大列表、无 pool 的批量 IO、每请求重读大文件、未节流的 SSE。');
out.push('');
for (const line of table(findings.filter(function (x) { return x.cat === '性能'; }), '未发现明显问题')) out.push(line);
out.push('');
out.push('## 6. v1 视觉残留（用户点名的「AI 风味」）');
out.push('');
out.push('匹配：`backdrop-filter` / `filter: blur()` / `linear-gradient(1xxdeg)` / `border-radius: 999` / `--grad-` / 带模糊半径的阴影 / `scale(.xx)`。注释行不算残留（说明文字里提到被禁项是正常的）。');
out.push('');
for (const line of table(findings.filter(function (x) { return x.cat === 'v1 视觉残留'; }), '未检出 v1 视觉残留')) out.push(line);
out.push('');
out.push('### 6.1 v2 特色件落地情况（信息项，不计分）');
out.push('');
out.push('| 类 | theme.css 已定义 | 页面引用 |');
out.push('|---|---|---|');
for (const v of v2Info) out.push('| `.' + v.cls + '` | ' + (v.defined ? '是' : '**否**') + ' | ' + (v.usedBy.length ? v.usedBy.join(', ') : '（无）') + ' |');
out.push('');
out.push('## 7. 文档一致性');
out.push('');
out.push('代码实际路由 **' + routeRows.length + '** 条；接口文档提及端点 **' + docEndpoints.size + '** 条。口径：只比对真实接口文档，`docs/team/**` 任务书不计入。');
out.push('');
for (const line of table(findings.filter(function (x) { return x.cat === '文档一致性'; }), '文档与代码路由一致')) out.push(line);
out.push('');
out.push('代码里有、文档未提及的路由（低优先，建议补文档）：');
out.push('');
if (!undocumented.length) out.push('- （无）');
else for (const p of undocumented) out.push('- `' + p + '`');
out.push('');
out.push('## 8. 问题总清单（按严重度排序）');
out.push('');
out.push('| # | 严重度 | 位置 | 问题 | 建议责任 |');
out.push('|---:|---|---|---|---|');
const sorted = findings.slice().sort(function (a, b) {
  const w = { '高': 0, '中': 1, '低': 2 };
  if (w[a.sev] !== w[b.sev]) return w[a.sev] - w[b.sev];
  return a.rel.localeCompare(b.rel) || a.line - b.line;
});
if (!sorted.length) out.push('| — | — | — | 未发现问题 | — |');
sorted.forEach(function (f, i) {
  out.push('| ' + (i + 1) + ' | ' + f.sev + ' | `' + f.rel + (f.line ? ':' + f.line : '') + '` | ' + f.message + ' | ' + f.owner + ' |');
});
out.push('');
out.push('## 9. 分类统计');
out.push('');
out.push('| 类别 | 条数 | 扣分 |');
out.push('|---|---:|---:|');
for (const c of cats) out.push('| ' + c + ' | ' + catStat[c].count + ' | ' + catStat[c].penalty + ' |');
out.push('');
out.push('---');
out.push('');
out.push('审计只报告、不改代码。修复请找上表「建议责任」列对应的 owner。');
out.push('');
const markdown = out.filter(function (x) { return x !== undefined; }).join('\n');

if (STDOUT_ONLY) {
  process.stdout.write(markdown);
} else {
  await fsp.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fsp.writeFile(OUT_FILE, markdown, 'utf8');
  process.stdout.write('审计完成：' + OUT_FILE + '\n');
  process.stdout.write('评分 ' + score + '/100 ｜ 高 ' + highList.length + ' · 中 ' + midList.length + ' · 低 ' + lowList.length + '\n');
  process.stdout.write('代码路由 ' + routeRows.length + ' 条 ｜ 文档端点 ' + docEndpoints.size + ' 条 ｜ 未文档化路由 ' + undocumented.length + ' 条\n');
  for (const c of cats) process.stdout.write('  ' + c + ': ' + catStat[c].count + ' 条 / 扣 ' + catStat[c].penalty + '\n');
}