#!/usr/bin/env node

/**
 * normalize-library.mjs —— 漫画库健全化（把 C 级裸本升到 B/A 级）
 *
 * 库格式契约见 docs/LIBRARY_FORMAT.md 第 3、5 节。本脚本做三件事：
 *   1) 从目录名解析标题（去掉整理工具留下的十六进制技术后缀）
 *   2) 生成 <漫画目录>/元数据.json（id / title / pagesCount / chapterInfos）
 *   3) 封面：不生成 cover.jpg（封面接口会自动回落到首章首图，无需生成）
 *
 * 铁律：
 *   - 只跑 node: 内置模块，零第三方依赖
 *   - 不用模板字符串，一律单引号拼接
 *   - 默认 dry-run，只打印计划，绝不写盘
 *   - --apply 前先把将改动的文件备份到 <数据目录>/normalize-backup/<时间戳>/
 *   - 幂等：已有元数据且未加 --force 则跳过
 *   - 绝不生成 cover.jpg：/api/library/cover 已自动回落到首章首图，生成封面纯属多余
 *
 * 用法：
 *   node scripts/normalize-library.mjs --root=early
 *   node scripts/normalize-library.mjs --root=early --limit=3 --apply --yes
 *   node scripts/normalize-library.mjs --root=early --apply --force          # 覆盖已有元数据
 *   node scripts/normalize-library.mjs --root=early --data-dir=D:\mv-data     # 指定数据目录
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, dataDir } from '../src/core/config.mjs';
import { roots, rootById } from '../src/core/roots.mjs';
import { IMAGE_EXT, naturalCompare, shortHash, readJson, ensureDir } from '../src/core/util.mjs';

const META_FILE = '元数据.json';
const COVER_RE = /^cover\.(jpg|jpeg|png|webp)$/i;

/* ------------------------------------------------------------------ *
 * 标题规范化（导出以便测试）
 * ------------------------------------------------------------------ */

/**
 * 去掉目录名末尾的「技术后缀」：括号里是纯十六进制且长度 >= 8。
 * 语义标注（单行本 / 中国翻訳 / 哔咔版 …）不在十六进制字符集内，天然保留。
 * 允许连续出现多个技术后缀。同时支持全角（）与半角 ()。
 */
export function normalizeTitle(rawName) {
  let name = String(rawName == null ? '' : rawName).trim();
  const suffix = /[\s]*[（(]\s*[0-9a-fA-F]{8,16}\s*[)）][\s]*$/;
  /* 循环剥离：例如「作品（deadbeef）（cafebabe）」两个后缀都要去掉 */
  while (suffix.test(name)) name = name.replace(suffix, '');
  /* 折叠连续空格（含全角空格）并去首尾 */
  name = name.replace(/[\u3000\s]+/g, ' ').trim();
  return name;
}

/**
 * 漫画稳定 id：与扫描器一致，取目录名短哈希。
 * 同一个目录反复跑结果完全一致，不随标题改动、不随时间变化。
 */
export function comicId(dirName) {
  return 'd-' + shortHash(dirName, 12);
}

/* ------------------------------------------------------------------ *
 * 目录探测（与 src/modules/library/scanner.mjs 的识别规则保持一致）
 * ------------------------------------------------------------------ */

/** 列出目录内的文件（可选只看图片），过滤点文件，自然序排序 */
async function listFiles(dir, onlyImage) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return []; }
  return entries
    .filter(function (e) {
      if (!e.isFile() || e.name.startsWith('.')) return false;
      if (!onlyImage) return true;
      return IMAGE_EXT.has(path.extname(e.name).toLowerCase());
    })
    .map(function (e) { return e.name; })
    .sort(naturalCompare);
}

/** 列出子目录，跳过 . 与 _ 开头（放杂物用），自然序排序 */
async function listDirs(dir) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return []; }
  return entries
    .filter(function (e) { return e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'); })
    .map(function (e) { return e.name; })
    .sort(naturalCompare);
}

function parseOrder(name, fallbackIndex) {
  const m = /^(\d+)/.exec(String(name).trim());
  if (m) return parseInt(m[1], 10);
  return fallbackIndex + 1;
}

function stripOrder(name) {
  return String(name).replace(/^\s*\d+[\s._-]*/, '').trim() || String(name).trim();
}

/**
 * 探测一部漫画的图片与章节结构。
 * @returns {Promise<{topImages:string[], chapters:Array<{order:number,title:string,dir:string,images:string[]}>, images:number, hasCover:boolean, coverName:string|null}>}
 */
export async function probeComic(comicDir) {
  const topFiles = await listFiles(comicDir, false);
  const coverName = topFiles.find(function (n) { return COVER_RE.test(n); }) || null;
  /* cover.jpg 是封面不是正文，绝不能因为它存在就把整本漫画当成单章 */
  const topImages = topFiles.filter(function (n) {
    return IMAGE_EXT.has(path.extname(n).toLowerCase()) && n !== coverName;
  });

  const subDirs = await listDirs(comicDir);
  const chapters = [];

  for (let i = 0; i < subDirs.length; i++) {
    const sub = subDirs[i];
    const subPath = path.join(comicDir, sub);
    const subImages = await listFiles(subPath, true);
    if (subImages.length > 0) {
      chapters.push({ order: parseOrder(sub, i), title: stripOrder(sub), dir: sub, images: subImages });
      continue;
    }
    /* 再深一层（旧结构：<漫画>/<分类>/<章节>/图片） */
    const subSubs = await listDirs(subPath);
    for (let j = 0; j < subSubs.length; j++) {
      const deep = subSubs[j];
      const deepImages = await listFiles(path.join(subPath, deep), true);
      if (!deepImages.length) continue;
      chapters.push({
        order: parseOrder(deep, chapters.length),
        title: stripOrder(deep),
        dir: sub + '/' + deep,
        images: deepImages
      });
    }
  }

  const withImages = chapters.filter(function (c) { return c.images.length > 0; });

  /* 没有任何「含图子目录」时才把顶层散图当正文（单章结构） */
  if (withImages.length === 0 && topImages.length > 0) {
    withImages.length = 0;
    withImages.push({ order: 1, title: '第1話', dir: '.', images: topImages });
  }

  /* order 去重并保证递增，避免元数据里出现重复 order（扫描器按 order 匹配章节标题） */
  for (let i = 0; i < withImages.length; i++) withImages[i].order = i + 1;

  const images = withImages.reduce(function (n, c) { return n + c.images.length; }, 0);
  return {
    topImages: topImages,
    chapters: withImages,
    images: images,
    hasCover: Boolean(coverName),
    coverName: coverName
  };
}

/** 依据探测结果拼出契约里要求的元数据对象 */
export function buildMetadata(dirName, probe) {
  return {
    id: comicId(dirName),
    title: normalizeTitle(dirName),
    pagesCount: probe.images,
    chapterInfos: probe.chapters.map(function (c, i) {
      return {
        chapterId: 'd-' + shortHash(dirName + '/' + c.dir, 12),
        chapterTitle: c.title,
        order: c.order || (i + 1)
      };
    })
  };
}

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const out = {
    root: null, apply: false, yes: false, force: false, limit: 0,
    dataDir: null, renameDir: false, json: false, help: false
  };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i]);
    if (a === '--apply') out.apply = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--force') out.force = true;
    else if (a === '--rename-dir') out.renameDir = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--root=')) out.root = a.slice(7);
    else if (a.startsWith('--limit=')) out.limit = Math.max(0, parseInt(a.slice(8), 10) || 0);
    else if (a.startsWith('--data-dir=')) out.dataDir = a.slice(11);
    else if (a === '--root' || a === '--limit' || a === '--data-dir') {
      const v = list[i + 1];
      i++;
      if (a === '--root') out.root = v == null ? null : String(v);
      else if (a === '--limit') out.limit = Math.max(0, parseInt(v, 10) || 0);
      else out.dataDir = v == null ? null : String(v);
    } else {
      throw new Error('未知参数：' + a + '（用 --help 查看用法）');
    }
  }
  if (out.dataDir) out.dataDir = path.resolve(out.dataDir);
  return out;
}

export const USAGE = [
  '用法：node scripts/normalize-library.mjs --root=<库根id> [选项]',
  '',
  '选项：',
  '  --root=<id>        必填，config.libraryRoots 里的库根 id（如 early / picacg）',
  '  --apply            真正写盘；缺省是 dry-run，只打印计划',
  '  --yes              跳过确认（脚本非交互，显式声明意图用）',
  '  --force            已有元数据.json 也重新生成（旧的先备份）',
  '  --limit=N          只处理前 N 部（按标题自然序），用于试跑',
  '  --data-dir=<path>  指定数据目录（备份落在 <数据目录>/normalize-backup/）',
  '  --rename-dir       额外把目录名里的技术后缀也改掉（默认只改元数据标题）',
  '  --json             以 JSON 打印计划/结果，便于机器消费',
  '  --help             显示本帮助'
].join('\n');

/* ------------------------------------------------------------------ *
 * 备份
 * ------------------------------------------------------------------ */

function makeStamp(d) {
  const p = function (n, w) { return String(n).padStart(w || 2, '0'); };
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + p(d.getMilliseconds(), 3);
}

/** 把单个文件复制进备份目录，保留相对路径 */
async function backupFile(backupRoot, baseRoot, absFile) {
  const rel = path.relative(baseRoot, absFile);
  const dest = path.join(backupRoot, rel);
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(absFile, dest);
  return dest;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (!args.root) { console.error('缺少 --root=<库根id>\n\n' + USAGE); return 2; }

  const config = await loadConfig();
  const root = rootById(config, args.root);
  if (!root) {
    const names = roots(config).map(function (r) { return r.id; }).join(', ') || '（无）';
    console.error('找不到库根 id=' + args.root + '，已配置的库根：' + names);
    return 2;
  }

  let rootStat = null;
  try { rootStat = await fsp.stat(root.path); } catch (e) { rootStat = null; }
  if (!rootStat || !rootStat.isDirectory()) {
    console.error('库根目录不可读：' + root.path);
    return 2;
  }

  const entries = await fsp.readdir(root.path, { withFileTypes: true });
  let dirs = entries
    .filter(function (e) { return e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'); })
    .map(function (e) { return e.name; })
    .sort(naturalCompare);
  if (args.limit > 0) dirs = dirs.slice(0, args.limit);

  const ddir = args.dataDir || dataDir();
  const stamp = makeStamp(new Date());
  const backupRoot = path.join(ddir, 'normalize-backup', stamp);

  console.log('漫库健全化 · ' + (args.apply ? 'APPLY（会写盘）' : 'DRY-RUN（只预览，不写盘）'));
  console.log('库根：' + args.root + '（' + root.name + '） -> ' + root.path);
  console.log('数据目录：' + ddir);
  console.log('漫画目录：' + dirs.length + ' 部' + (args.limit > 0 ? '（--limit=' + args.limit + '）' : ''));
  if (args.apply) console.log('备份目录：' + backupRoot + '（仅当有旧文件需要保留时才会创建）');
  console.log('');

  const plan = [];
  let done = 0;
  let failed = 0;

  for (const dirName of dirs) {
    const comicDir = path.join(root.path, dirName);
    const metaPath = path.join(comicDir, META_FILE);
    let existing = null;
    try { await fsp.access(metaPath); existing = await readJson(metaPath, null); } catch (e) { existing = null; }

    const title = normalizeTitle(dirName);
    const item = { dir: dirName, title: title, skipped: false, wrote: false, backedUp: [], error: null };

    if (existing && !args.force) {
      item.skipped = true;
      item.reason = '已有元数据.json，未加 --force，跳过';
      plan.push(item);
      console.log('[' + ++done + '/' + dirs.length + '] 跳过  ' + dirName + ' —— ' + item.reason);
      continue;
    }

    let probe = null;
    try {
      probe = await probeComic(comicDir);
    } catch (err) {
      item.error = String((err && err.message) || err);
      failed++;
      plan.push(item);
      console.log('[' + ++done + '/' + dirs.length + '] 失败  ' + dirName + ' —— 目录探测出错：' + item.error);
      continue;
    }

    const meta = buildMetadata(dirName, probe);
    item.meta = meta;
    item.images = probe.images;
    item.chapters = probe.chapters.length;

    const titleChanged = title !== dirName;
    console.log('[' + ++done + '/' + dirs.length + '] ' + (args.apply ? '处理' : '计划') + '  ' + dirName);
    console.log('       标题：' + (titleChanged ? '"' + dirName + '" -> "' + title + '"' : '"' + title + '"（无需改动）'));
    console.log('       正文：' + probe.images + ' 图 / ' + probe.chapters.length + ' 章' +
      (probe.hasCover ? '（已有 ' + probe.coverName + '）' : '（无封面）'));
    console.log('       元数据：id=' + meta.id + '  pagesCount=' + meta.pagesCount +
      '  chapterInfos=' + meta.chapterInfos.length + (existing ? '（--force 覆盖已有' + META_FILE + '）' : ''));

    /* ---- 封面：不生成，由 /api/library/cover 回落到首章首图 ---- */
    if (!probe.hasCover) {
      console.log('       未生成 cover.jpg：封面由 /api/library/cover 自动回落到首章首图，无需生成');
    }

    if (args.apply) {
      try {
        if (existing) {
          item.backedUp.push(await backupFile(backupRoot, root.path, metaPath));
          console.log('       已备份旧元数据 -> ' + item.backedUp[item.backedUp.length - 1]);
        }
        await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
        item.wrote = true;
        console.log('       已写入 ' + metaPath);
      } catch (err) {
        item.error = String((err && err.message) || err);
        failed++;
        console.log('       写入失败：' + item.error);
      }
    }
    plan.push(item);
  }

  const toWrite = plan.filter(function (p) { return !p.skipped && !p.error; }).length;
  const skipped = plan.filter(function (p) { return p.skipped; }).length;
  const renamed = plan.filter(function (p) { return p.meta && p.meta.title !== p.dir; }).length;

  console.log('');
  console.log('—— 小结 ——');
  console.log('将对 ' + toWrite + ' 部写 ' + META_FILE + '，跳过 ' + skipped + ' 部，失败 ' + failed + ' 部');
  console.log('其中标题规范化的有 ' + renamed + ' 部');
  console.log('封面：未生成 cover.jpg（由 /api/library/cover 自动回落到首章首图），本轮 0 部生成封面');
  if (args.apply) {
    const wrote = plan.filter(function (p) { return p.wrote; }).length;
    const backedUp = plan.reduce(function (n, p) { return n + p.backedUp.length; }, 0);
    console.log('已写入 ' + wrote + ' 个 ' + META_FILE + '，备份 ' + backedUp + ' 个旧文件');
    if (backedUp > 0) console.log('备份目录：' + backupRoot + '（回滚：把里面文件按相对路径拷回库根即可）');
  } else {
    console.log('这是 dry-run，未写任何文件。加 --apply 才会真正写入。');
  }

  if (args.json) console.log(JSON.stringify({ apply: args.apply, root: args.root, backupRoot: args.apply ? backupRoot : null, plan: plan }, null, 2));
  return failed > 0 ? 1 : 0;
}

/* 直接执行时才跑主流程；被 import 时（测试）只导出函数 */
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = path.resolve(import.meta.filename);
if (invoked && invoked === selfPath) {
  main(process.argv.slice(2)).then(function (code) {
    process.exitCode = code;
  }).catch(function (err) {
    console.error('健全化失败：' + ((err && err.message) || err));
    if (err && err.stack) console.error(err.stack);
    process.exitCode = 1;
  });
}
