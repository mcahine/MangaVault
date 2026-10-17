#!/usr/bin/env node

/**
 * normalize-dir.mjs —— 把任意「裸目录」整理成库格式（L0 裸形态 -> L2 规范形态）
 *
 * 背景：从别处收来的同人本常常是 `<名字>/00000001.jpg` 这种扁平形态（契约里的 L0），
 * 系统能读，但没有元数据、没有章节结构、目录名还带着整理工具的技术前缀，
 * 和下载器产出的 `<标题>/1 第1話/` 形态不一致。本脚本把它对齐：
 *
 *   1) 目录名 -> normalizeTitle()（去掉 EHViewer 画廊号前缀与末尾十六进制技术后缀）
 *   2) 把图片整体搬进 `<漫画目录>/1 第1話/`（改名时用一次 rename 搬整个目录，不复制图片）
 *   3) 写 元数据.json 与 章节元数据.json
 *   4) 非图片杂物（.ehviewer / .thumb / .txt …）移进备份目录（移动，不删除）
 *
 * 铁律：
 *   - 只跑 node: 内置模块，零第三方依赖；单引号拼接，两空格缩进
 *   - 默认 dry-run，只打印计划，绝不写盘；--apply 才动手
 *   - --apply 前先写 manifest.json（改名对照表 + 杂物去向），任何一步都能照着回滚
 *   - 幂等：已规范（有 元数据.json 且有含图的章节目录）的单元直接跳过
 *   - 目标目录已存在则拒绝该单元（绝不覆盖别人的目录）
 *   - 绝不生成 cover.jpg（/api/library/cover 会自动回落到首章首图）
 *   - 绝不做内容识别、绝不重命名图片文件本身
 *
 * 用法：
 *   node scripts/normalize-dir.mjs --dir='C:\path\to\裸目录'                  # 只预览
 *   node scripts/normalize-dir.mjs --dir='...' --apply                       # 真写盘
 *   node scripts/normalize-dir.mjs --dir='...' --keep-name                   # 不改目录名，只建章节结构
 *   node scripts/normalize-dir.mjs --dir='...' --limit=3 --json              # 试跑几部
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_EXT, naturalCompare, shortHash, ensureDir } from '../src/core/util.mjs';
import { dataDir } from '../src/core/config.mjs';
import { normalizeTitle } from './normalize-library.mjs';

const META_FILE = '元数据.json';
const CHAPTER_META_FILE = '章节元数据.json';
const DEFAULT_CHAPTER_DIR = '1 第1話';

/** Windows 非法字符替换表（目录名里出现就换成全角下划线） */
const ILLEGAL_RE = /[<>:"/\\|?*]/g;

/** 清洗成合法目录名：非法字符替换、去首尾空白与结尾的点 */
export function sanitizeDirName(name) {
  let s = String(name == null ? '' : name).replace(ILLEGAL_RE, '_');
  s = s.replace(/[\u3000\s]+/g, ' ').trim();
  s = s.replace(/[. ]+$/g, '');
  return s;
}

/** EHViewer 画廊号前缀，如 `1924536-[作者] 标题` -> 1924536 */
export function galleryIdOf(name) {
  const m = /^(\d{5,12})[-_\s]+/.exec(String(name == null ? '' : name).trim());
  return m ? m[1] : null;
}

async function readDirSafe(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return []; }
}

/** 列出子目录（跳过 . 与 _ 开头，与库扫描器口径一致），自然序 */
export async function listComicDirs(root) {
  const entries = await readDirSafe(root);
  return entries
    .filter(function (e) { return e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'); })
    .map(function (e) { return e.name; })
    .sort(naturalCompare);
}

/**
 * 探测单个单元：正文图片、杂物、章节结构现状。全是只读操作。
 * @returns {Promise<{images:string[], junk:string[], subDirs:string[], chapterDirs:string[], hasMeta:boolean}>}
 */
export async function probeUnit(comicDir) {
  const entries = await readDirSafe(comicDir);
  const images = [];
  const junk = [];
  const subDirs = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && !e.name.startsWith('_')) subDirs.push(e.name);
      continue;
    }
    if (!e.isFile()) continue;
    if (e.name === META_FILE || e.name === CHAPTER_META_FILE) continue;
    if (IMAGE_EXT.has(path.extname(e.name).toLowerCase())) images.push(e.name);
    else junk.push(e.name);
  }
  images.sort(naturalCompare);
  junk.sort(naturalCompare);
  subDirs.sort(naturalCompare);
  const chapterDirs = [];
  for (const d of subDirs) {
    const sub = await readDirSafe(path.join(comicDir, d));
    const n = sub.filter(function (e) { return e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()); }).length;
    if (n > 0) chapterDirs.push(d);
  }
  let hasMeta = false;
  try { const st = await fsp.stat(path.join(comicDir, META_FILE)); hasMeta = st.isFile(); } catch (e) { hasMeta = false; }
  return { images: images, junk: junk, subDirs: subDirs, chapterDirs: chapterDirs, hasMeta: hasMeta };
}

/** 组装元数据（与 docs/LIBRARY_FORMAT.md 第 3 节一致） */
export function buildMeta(originalName, title, probe, galleryId) {
  const chapterTitle = '第1話';
  const meta = {
    id: 'd-' + shortHash(originalName, 12),
    title: title,
    pagesCount: probe.images.length,
    chapterInfos: [{
      chapterId: 'd-' + shortHash(originalName + '/' + DEFAULT_CHAPTER_DIR, 12),
      chapterTitle: chapterTitle,
      order: 1
    }]
  };
  /* 来源画廊号是整理工具留下的、可追溯的原始标识；契约允许未知字段，保留它不碍事 */
  if (galleryId) meta.galleryId = galleryId;
  return meta;
}

/** 参数解析 */
export function parseArgs(argv) {
  const out = { dir: null, apply: false, renameDir: false, json: false, limit: 0, junkDir: null, rollback: null, help: false };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i]);
    if (a === '--apply') out.apply = true;
    else if (a === '--rename-dir') out.renameDir = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--rollback=')) out.rollback = a.slice(11);
    else if (a === '--rollback') { out.rollback = list[i + 1] == null ? null : String(list[i + 1]); i++; }
    else if (a.startsWith('--dir=')) out.dir = a.slice(6);
    else if (a.startsWith('--limit=')) out.limit = Math.max(0, parseInt(a.slice(8), 10) || 0);
    else if (a.startsWith('--junk-dir=')) out.junkDir = a.slice(11);
    else if (a === '--dir' || a === '--limit' || a === '--junk-dir') {
      const v = list[i + 1];
      i++;
      if (a === '--dir') out.dir = v == null ? null : String(v);
      else if (a === '--limit') out.limit = Math.max(0, parseInt(v, 10) || 0);
      else out.junkDir = v == null ? null : String(v);
    } else {
      throw new Error('未知参数：' + a + '（用 --help 查看用法）');
    }
  }
  return out;
}

export const USAGE = [
  '用法：node scripts/normalize-dir.mjs --dir=<目录> [选项]',
  '',
  '选项：',
  '  --dir=<path>       必填，要整理的目录（其一级子目录就是一部漫画）',
  '  --apply            真正写盘；缺省 dry-run，只打印计划',
  '  --rename-dir       额外把目录名也改成「标题」（默认只改元数据标题，目录名不动）',
  '  --limit=N          只处理前 N 部（自然序），用于试跑',
  '  --junk-dir=<path>  杂物备份根目录（缺省 <数据目录>/normalize-backup/）',
  '  --rollback=<file>  按 manifest.json 回滚上一次整理（把结构还原成裸形态）',
  '  --json             以 JSON 打印计划，便于机器消费',
  '  --help             显示本帮助'
].join('\n');

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function makeStamp(d) {
  const p = function (n, w) { return String(n).padStart(w || 2, '0'); };
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + p(d.getMilliseconds(), 3);
}

/** 目录是否为空（用于回滚时收拾干净） */
async function isEmptyDir(dir) {
  try { const es = await fsp.readdir(dir); return es.length === 0; } catch (e) { return true; }
}

/**
 * 按 manifest.json 回滚一次整理：
 *   1) 杂物从备份目录搬回原位
 *   2) 章节目录里的图片搬回漫画目录顶层，删掉两个元数据文件（它们是本脚本新建的）
 *   3) 若当时改了目录名，再把目录名改回去
 * 幂等：已经回滚过的目录会因找不到新结构而报告 skipped。
 */
export async function rollback(manifestFile) {
  let manifest = null;
  try { manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8')); }
  catch (err) { console.error('读不到回滚对照表：' + manifestFile + ' —— ' + ((err && err.message) || err)); return 2; }
  const root = manifest.root;
  console.log('漫库格式正规化 · 回滚');
  console.log('对照表：' + manifestFile);
  console.log('目标目录：' + root);
  console.log('');
  let done = 0;
  let skipped = 0;
  let failed = 0;
  for (const u of manifest.units || []) {
    if (u.action !== 'converted' || u.ok !== true) { skipped++; continue; }
    const newAbs = path.join(root, u.target);
    const chapterAbs = path.join(newAbs, DEFAULT_CHAPTER_DIR);
    try {
      const chapterFiles = (await readDirSafe(chapterAbs)).filter(function (e) {
        return e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase());
      }).map(function (e) { return e.name; });
      if (!chapterFiles.length && u.target === u.old) { skipped++; continue; }
      for (const f of chapterFiles) await fsp.rename(path.join(chapterAbs, f), path.join(newAbs, f));
      for (const f of [META_FILE, CHAPTER_META_FILE]) {
        try { await fsp.unlink(path.join(chapterAbs, f)); } catch (e) { /* 不在就算了 */ }
        try { await fsp.unlink(path.join(newAbs, f)); } catch (e) { /* 不在就算了 */ }
      }
      if (await isEmptyDir(chapterAbs)) { try { await fsp.rmdir(chapterAbs); } catch (e) { /* 忽略 */ } }
      /* 杂物搬回原位（改名过的先回退目录名，再放杂物） */
      const backAbs = path.join(root, u.old);
      if (u.target !== u.old) {
        try { await fsp.rename(newAbs, backAbs); } catch (e) { /* 目标名已被占用等，保留现状 */ }
      }
      for (const j of u.junk || []) {
        try { await fsp.rename(j.to, path.join(backAbs, j.from)); } catch (e) { /* 忽略 */ }
      }
      done++;
    } catch (err) {
      failed++;
      console.log('  回滚失败 ' + u.target + '：' + ((err && err.message) || err));
    }
  }
  console.log('已回滚 ' + done + ' 部，跳过 ' + skipped + ' 部，失败 ' + failed + ' 部');
  return failed > 0 ? 1 : 0;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (args.rollback) return await rollback(args.rollback);
  if (!args.dir) { console.error('缺少 --dir=<目录>' + String.fromCharCode(10, 10) + USAGE); return 2; }
  const root = path.resolve(args.dir);
  let st = null;
  try { st = await fsp.stat(root); } catch (e) { st = null; }
  if (!st || !st.isDirectory()) { console.error('目录不可读：' + root); return 2; }

  let names = await listComicDirs(root);
  if (args.limit > 0) names = names.slice(0, args.limit);
  const taken = new Set((await listComicDirs(root)));

  const stamp = makeStamp(new Date());
  const backupRoot = args.junkDir ? path.resolve(args.junkDir) : path.join(dataDir(), 'normalize-backup', stamp);

  console.log('漫库格式正规化 · ' + (args.apply ? 'APPLY（会写盘）' : 'DRY-RUN（只预览，不写盘）'));
  console.log('目标目录：' + root);
  console.log('单元数：' + names.length + '（跳过 . 与 _ 开头的目录）');
  console.log('改名：' + (args.renameDir ? '开启（--rename-dir，目录名会变）' : '关闭（默认不动目录名，只写结构与元数据）'));
  if (args.apply) console.log('备份目录：' + backupRoot);
  console.log('');

  const plan = [];
  const used = new Set();
  for (const name of names) {
    const comicDir = path.join(root, name);
    const probe = await probeUnit(comicDir);
    const galleryId = galleryIdOf(name);
    let title = sanitizeDirName(normalizeTitle(name));
    const item = { old: name, title: title, galleryId: galleryId, pages: probe.images.length, junk: probe.junk, action: '', reason: '' };

    if (probe.images.length === 0 && probe.chapterDirs.length === 0) {
      item.action = 'empty';
      item.reason = '没有图片，跳过';
      plan.push(item);
      continue;
    }
    if (probe.chapterDirs.length > 0 && probe.hasMeta) {
      item.action = 'skip';
      item.reason = '已是规范形态（有 元数据.json 与含图章节目录）';
      item.target = name;
      plan.push(item);
      continue;
    }
    if (probe.images.length === 0) {
      item.action = 'skip';
      item.reason = '图片都在子目录里（非裸形态），本脚本不动';
      item.target = name;
      plan.push(item);
      continue;
    }

    /* 目录名默认不动：改目录名会改变单元身份（查重结果、历史决策都按目录名索引） */
    item.title = title || name;
    if (!args.renameDir) title = name;
    if (!title) title = name;
    /* 目标目录已存在（不是自己）则让路，绝不覆盖 */
    if (title !== name && (taken.has(title) || used.has(title))) {
      item.action = 'conflict';
      item.reason = '目标目录名已被占用：' + title;
      item.target = name;
      plan.push(item);
      continue;
    }
    used.add(title);
    item.target = title;
    item.action = 'convert';
    item.chapters = 1;
    plan.push(item);
  }

  const byAction = {};
  for (const p of plan) byAction[p.action] = (byAction[p.action] || 0) + 1;

  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const tag = p.action === 'convert' ? (args.apply ? '处理' : '计划') : (p.action === 'skip' ? '跳过' : p.action === 'conflict' ? '冲突' : '空');
    console.log('[' + (i + 1) + '/' + plan.length + '] ' + tag + '  ' + p.old);
    if (p.action !== 'convert') { console.log('       ' + p.reason); continue; }
    if (p.target !== p.old) console.log('       目录："' + p.old + '" -> "' + p.target + '"');
    console.log('       标题：' + p.title + '（' + p.pages + ' 图 -> ' + DEFAULT_CHAPTER_DIR + '/）');
    console.log('       杂物：' + (p.junk.length ? p.junk.length + ' 个（' + p.junk.slice(0, 4).join(', ') + (p.junk.length > 4 ? ' …' : '') + '）' : '无'));
  }

  console.log('');
  console.log('—— 小结 ——');
  console.log('计划整理 ' + (byAction.convert || 0) + ' 部，跳过 ' + (byAction.skip || 0) + ' 部，冲突 ' + (byAction.conflict || 0) + ' 部，空 ' + (byAction.empty || 0) + ' 部');
  console.log('涉及图片 ' + plan.filter(function (p) { return p.action === 'convert'; }).reduce(function (n, p) { return n + p.pages; }, 0) + ' 张，杂物 ' + plan.filter(function (p) { return p.action === 'convert'; }).reduce(function (n, p) { return n + p.junk.length; }, 0) + ' 个');

  if (!args.apply) {
    console.log('这是 dry-run，未写任何文件。加 --apply 才会真正写入。');
  } else {
    await ensureDir(backupRoot);
    const manifest = { at: new Date().toISOString(), stamp: stamp, root: root, renameDir: args.renameDir, backupRoot: backupRoot, units: [] };
    let done = 0;
    let failed = 0;
    for (const p of plan) {
      if (p.action !== 'convert') { manifest.units.push({ old: p.old, target: p.target, action: p.action, junk: [] }); continue; }
      const rec = { old: p.old, target: p.target, action: 'converted', junk: [] };
      try {
        const oldAbs = path.join(root, p.old);
        const newAbs = path.join(root, p.target);
        const chapterAbs = path.join(newAbs, DEFAULT_CHAPTER_DIR);
        if (p.target === p.old) {
          await ensureDir(chapterAbs);
          for (const f of p.junk) {
            const dest = path.join(backupRoot, 'junk', p.old, f);
            await ensureDir(path.dirname(dest));
            await fsp.rename(path.join(oldAbs, f), dest);
            rec.junk.push({ from: f, to: dest });
          }
          const names2 = (await readDirSafe(oldAbs)).filter(function (e) {
            return e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase());
          }).map(function (e) { return e.name; });
          for (const f of names2) await fsp.rename(path.join(oldAbs, f), path.join(chapterAbs, f));
        } else {
          await ensureDir(newAbs);
          await fsp.rename(oldAbs, chapterAbs);
          for (const f of p.junk) {
            const dest = path.join(backupRoot, 'junk', p.old, f);
            await ensureDir(path.dirname(dest));
            await fsp.rename(path.join(chapterAbs, f), dest);
            rec.junk.push({ from: f, to: dest });
          }
        }
        const probe = { images: new Array(p.pages) };
        const meta = buildMeta(p.old, p.title, probe, p.galleryId);
        await fsp.writeFile(path.join(newAbs, META_FILE), JSON.stringify(meta, null, 2) + String.fromCharCode(10), 'utf8');
        await fsp.writeFile(path.join(chapterAbs, CHAPTER_META_FILE), JSON.stringify({
          chapterId: meta.chapterInfos[0].chapterId,
          chapterTitle: '第1話',
          order: 1
        }, null, 2) + String.fromCharCode(10), 'utf8');
        done++;
        rec.ok = true;
      } catch (err) {
        failed++;
        rec.ok = false;
        rec.error = String((err && err.message) || err);
      }
      manifest.units.push(rec);
    }
    /* 每次运行一份独立对照表：重复 --apply 时第二次会写同一路径，把首次的回滚记录覆盖掉 */
    const manifestFile = path.join(backupRoot, 'manifest-' + stamp + '.json');
    await fsp.writeFile(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
    console.log('已整理 ' + done + ' 部，失败 ' + failed + ' 部');
    console.log('回滚对照表：' + manifestFile);
  }

  if (args.json) console.log(JSON.stringify({ apply: args.apply, root: root, backupRoot: args.apply ? backupRoot : null, plan: plan }, null, 2));
  return 0;
}

/* 直接执行时才跑主流程；被 import 时（测试）只导出函数 */
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = path.resolve(import.meta.filename);
if (invoked && invoked === selfPath) {
  main(process.argv.slice(2)).then(function (code) {
    process.exitCode = code;
  }).catch(function (err) {
    console.error('正规化失败：' + ((err && err.message) || err));
    if (err && err.stack) console.error(err.stack);
    process.exitCode = 1;
  });
}
