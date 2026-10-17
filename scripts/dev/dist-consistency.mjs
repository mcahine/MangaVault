
/**
 * dist/app 与源码的一致性校验（零依赖）。
 *
 * 为什么需要它：`dist/` 只是 `src/` 在某一时刻的快照，构建脚本不会自动同步。
 * v3 真的踩过：源码里下载引擎已修好，`dist/app/` 却落后 6 小时，交付出去的 exe
 * 里装的是旧逻辑 —— 而且肉眼看不出来，因为 exe 照常启动、照常渲染。
 *
 * 用法：
 *   node scripts/dev/dist-consistency.mjs            # 校验 dist/
 *   node scripts/dev/dist-consistency.mjs --dist=out # 校验别的输出目录
 *   node scripts/dev/dist-consistency.mjs --brief    # 只输出结论
 *
 * 退出码：一致 0，有任何「缺失 / 过期 / 多余」则 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
function argOf(name, dflt) {
  const hit = argv.find(function (a) { return a === name || a.indexOf(name + "=") === 0; });
  if (!hit) return dflt;
  const eq = hit.indexOf("=");
  return eq < 0 ? true : hit.slice(eq + 1);
}
const DIST = path.resolve(ROOT, String(argOf("--dist", "dist")));
const APP = path.join(DIST, "app");
const BRIEF = Boolean(argOf("--brief", false));

const C_OK = "\u001b[32m", C_BAD = "\u001b[31m", C_WARN = "\u001b[33m", C_DIM = "\u001b[90m", C_OFF = "\u001b[0m";

/** 与 scripts/build-desktop.mjs 的 payload 必须保持一致：改了那边就要改这里。 */
const SKIP_TOP = ["refs", "host", "node_modules"];
const ROOT_FILES = ["package.json", "config.example.json"];

function walk(dir, base, out, skipTops) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (rel) {
      const top = rel.split(path.sep)[0];
      if (skipTops && skipTops.indexOf(top) >= 0) continue;
    }
    if (e.isDirectory()) walk(full, base, out, skipTops);
    else if (e.isFile()) out[rel] = full;
  }
  return out;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

if (!fs.existsSync(APP)) {
  console.log(C_BAD + "✗ 找不到 " + APP + C_OFF);
  console.log(C_DIM + "  先跑：node scripts/build-desktop.mjs --clean --out=dist" + C_OFF);
  process.exit(1);
}

const subtrees = [
  { name: "src", from: path.join(ROOT, "src"), to: path.join(APP, "src"), skipTops: null },
  { name: "public", from: path.join(ROOT, "public"), to: path.join(APP, "public"), skipTops: null },
  { name: "desktop", from: path.join(ROOT, "desktop"), to: path.join(APP, "desktop"), skipTops: SKIP_TOP }
];

const missing = [], stale = [], extra = [];
let checked = 0;

for (const st of subtrees) {
  if (!fs.existsSync(st.from)) { console.log(C_WARN + "· 跳过不存在的源码目录 " + st.name + C_OFF); continue; }
  const srcFiles = walk(st.from, st.from, {}, st.skipTops);
  const distFiles = fs.existsSync(st.to) ? walk(st.to, st.to, {}, st.skipTops) : {};
  for (const rel of Object.keys(srcFiles)) {
    checked++;
    const d = distFiles[rel];
    if (!d) { missing.push(st.name + "/" + rel); continue; }
    if (sha256(srcFiles[rel]) !== sha256(d)) stale.push(st.name + "/" + rel);
  }
  for (const rel of Object.keys(distFiles)) {
    if (!srcFiles[rel]) extra.push(st.name + "/" + rel);
  }
}

for (const f of ROOT_FILES) {
  const s = path.join(ROOT, f), d = path.join(APP, f);
  if (!fs.existsSync(s)) continue;
  checked++;
  if (!fs.existsSync(d)) { missing.push(f); continue; }
  if (sha256(s) !== sha256(d)) stale.push(f);
}

const bad = missing.length + stale.length + extra.length;

if (!BRIEF) {
  const exe = path.join(DIST, "MangaVault.exe");
  if (fs.existsSync(exe)) {
    const e = fs.statSync(exe);
    console.log(C_DIM + "exe   " + new Date(e.mtimeMs).toLocaleString() + "  " + e.size + " B" + C_OFF);
  }
  console.log(C_DIM + "源码 → " + APP + C_OFF);
  const label = { missing: "缺失（dist 里没有）", stale: "过期（内容与源码不一致）", extra: "多余（源码里没有）" };
  const groups = [["missing", missing], ["stale", stale], ["extra", extra]];
  for (const pair of groups) {
    const list = pair[1];
    if (!list.length) continue;
    console.log("");
    console.log(C_BAD + "✗ " + label[pair[0]] + "：" + list.length + " 个" + C_OFF);
    for (const x of list.slice(0, 40)) console.log("    " + x);
    if (list.length > 40) console.log(C_DIM + "    …还有 " + (list.length - 40) + " 个" + C_OFF);
  }
  console.log("");
}

if (bad === 0) {
  console.log(C_OK + "✓ dist 与源码一致（校验 " + checked + " 个文件）" + C_OFF);
  process.exit(0);
}
console.log(C_BAD + "✗ dist 与源码不一致：" + missing.length + " 缺失 / " + stale.length + " 过期 / " + extra.length + " 多余，共校验 " + checked + " 个文件" + C_OFF);
console.log(C_DIM + "  修复：node scripts/build-desktop.mjs --clean --out=dist" + C_OFF);
process.exit(1);