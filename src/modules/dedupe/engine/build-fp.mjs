// engine/build-fp.mjs — 全库/查重单元 32x32 灰度指纹索引（驱动 python/build-fp.py）。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_EXT, ensureDir } from '../../../core/util.mjs';
import { keyOf, isCoverName } from './paths.mjs';
import { normalizeRootList } from './scan.mjs';
import { probePython, pythonExe, runPython, script } from './py.mjs';

const COMIC_META = '元数据.json';
const CHAPTER_META = '章节元数据.json';

/** 读取小 JSON，失败返回 null。 */
async function readJsonSafe(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    if (!text.trim()) return null;
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) { return null; }
}

/** 列出目录下直接包含的图片文件名（原 build-fp.py 的排序与扩展名口径）。快速查重也复用这个口径。 */
export async function imagesIn(dir) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return []; }
  return entries
    .filter(function (e) { return e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()); })
    .map(function (e) { return e.name; })
    .sort();
}

/**
 * 收集库侧指纹任务与 index.json 内容（多库根）。
 * index 条目带 rootId/rootName/rootPath，像素阶段据此定位缩略图基准根。
 * 兼容「目录即章节」：漫画目录没有 元数据.json 却直接含（非 cover.*）图片时，漫画目录本身是一个章节。
 */
export async function collectLibJobs(libRoots, fpLib, onProgress, signal) {
  const list = normalizeRootList(libRoots);
  const jobs = [];
  const index = [];
  for (let ri = 0; ri < list.length; ri++) {
    const root = list[ri];
    if (signal && signal.aborted) throw Object.assign(new Error('任务已中止'), { aborted: true });
    let comics = [];
    try { comics = (await fsp.readdir(root.path, { withFileTypes: true })).filter(function (e) { return e.isDirectory(); }).map(function (e) { return e.name; }).sort(); }
    catch (e) { comics = []; }
    for (const comic of comics) {
      const cdir = path.join(root.path, comic);
      const meta = await readJsonSafe(path.join(cdir, COMIC_META));
      const direct = (await imagesIn(cdir)).filter(function (n) { return !isCoverName(n); });
      const chapters = [];
      if (!meta && direct.length) {
        chapters.push({ dir: cdir, title: (meta && meta.title) || comic, files: direct });
      } else {
        let subs = [];
        try { subs = (await fsp.readdir(cdir, { withFileTypes: true })).filter(function (e) { return e.isDirectory(); }).map(function (e) { return e.name; }).sort(); }
        catch (e) { subs = []; }
        for (const sub of subs) {
          const sdir = path.join(cdir, sub);
          const files = await imagesIn(sdir);
          if (!files.length) continue;
          const cm = await readJsonSafe(path.join(sdir, CHAPTER_META));
          chapters.push({ dir: sdir, title: (cm && cm.chapterTitle) || sub, files: files });
        }
      }
      for (const ch of chapters) {
        const k = keyOf(ch.dir);
        jobs.push(['lib', k, ch.dir, ch.files, path.join(fpLib, k + '.bin')]);
        index.push({
          key: k, dir: ch.dir, comic: comic, title: ch.title, count: ch.files.length,
          rootId: root.id, rootName: root.name, rootPath: root.path
        });
      }
    }
    if (onProgress) onProgress((ri + 1) / list.length, root.name);
  }
  return { jobs: jobs, index: index };
}

/**
 * 收集查重单元侧指纹任务（key = md5(单元所在目录)，与 match 阶段对应）。
 *
 * 为什么按 dir 而不是按 u.id 算 key：库格式正规化会改变单元 id（裸本 <标题> 会变成
 * <标题>/1 第1話），但指纹描述的是「这个目录下这几张图」，与 id 无关。按 id 算 key 的话，
 * 整理后 key 全变 —— build-fp.py 的增量签名只认 mtime + 总字节 + 张数，于是所有指纹被判定
 * 「还是要重建」，12 万张图平白重解一遍（约 5 分钟）。按 dir 算 key 则 id 变了指纹照样命中。
 *
 * 用绝对路径（而不是相对路径）是刻意的：相对路径会随「从哪个根往里看」而变，绝对路径不会。
 * 代价是 data/dedupe/tmp/fp-dup 下会残留 id 旧口径的 .bin（无害缓存，可手工清理）。
 */
export function collectDupJobs(units, fpDup) {
  const jobs = [];
  for (const u of units) {
    if (!u.files || !u.files.length) continue;
    const k = keyOf(u.dir || u.id);
    jobs.push(['dup', k, u.dir, u.files.slice(), path.join(fpDup, k + '.bin')]);
  }
  return jobs;
}

/**
 * 驱动 python 建立指纹缓存。
 * opts: { specFile, force, only, onProgress(done,total,msg), onCancel(registerKiller), signal }
 * 返回 { ok, degraded, reason, stats, stdout }；绝不抛错。
 */
export async function runBuildFp(specFile, opts) {
  const o = opts || {};
  const probe = probePython();
  if (!probe.available || !probe.pillow) {
    return { ok: false, degraded: true, reason: probe.reason || '缺少 Python/Pillow', stats: null, stdout: '' };
  }
  const args = [script('build-fp.py'), specFile];
  if (o.force) args.push('--force');
  if (o.only) args.push('--only', o.only);
  let stats = null;
  const res = await runPython(probe.exe || pythonExe(), args, {
    cwd: o.cwd,
    maxKeep: 600000,
    onCancel: o.onCancel,
    onChild: o.onChild,
    onLine: function (line) {
      const m = /^PROGRESS (\d+) (\d+)/.exec(line);
      if (m && o.onProgress) { o.onProgress(Number(m[1]), Number(m[2])); return; }
      const d = /^DONE (.*)$/.exec(line);
      if (d) { try { stats = JSON.parse(d[1]); } catch (e) { stats = null; } return; }
      if (o.onLog) o.onLog(line);
    }
  });
  if (res.killed) return { ok: false, degraded: false, reason: '指纹生成已中止', stats: stats, stdout: res.stdout };
  if (/NO_PIL/.test(res.stderr || '')) return { ok: false, degraded: true, reason: 'Python 缺少 Pillow，已跳过像素级比对', stats: stats, stdout: res.stdout };
  // res.error 是 spawn 本身失败（例如 EPERM/E2BIG/找不到解释器）时的原因；
  // 只打印退出码会让用户看到「退出码 -1：」这种毫无信息量的报错（实测就这么发生了）。
  if (!res.ok) return { ok: false, degraded: false, reason: '指纹生成失败（退出码 ' + res.code + '）：' + String(res.error || res.stderr || '').slice(-300), stats: stats, stdout: res.stdout };
  return { ok: true, degraded: false, reason: '', stats: stats, stdout: res.stdout };
}

/** 把 spec 写到磁盘并调用 runBuildFp（spec 会落在 data/dedupe/tmp/ 下）。 */
export async function buildFingerprints(paths, jobs, index, opts) {
  const o = opts || {};
  const specFile = path.join(paths.tmp, 'fp-spec-' + process.pid + '-' + Date.now() + '.json');
  try {
    await ensureDir(paths.tmp);
    await ensureDir(paths.fpLib);
    await ensureDir(paths.fpDup);
    await fsp.writeFile(specFile, JSON.stringify({ libFp: paths.fpLib, dupFp: paths.fpDup, jobs: jobs, index: index }), 'utf8');
  } catch (e) {
    return { ok: false, degraded: false, reason: '写指纹任务文件失败: ' + (e && e.message ? e.message : e), stats: null };
  }
  const res = await runBuildFp(specFile, o);
  try { await fsp.unlink(specFile); } catch (e) { /* 临时文件清理失败可忽略 */ }
  return res;
}
