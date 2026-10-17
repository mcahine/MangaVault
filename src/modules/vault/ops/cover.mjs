
import path from 'node:path';
import fsp from 'node:fs/promises';
import { safeJoin, IMAGE_EXT, naturalCompare } from '../../../core/util.mjs';
import { loadCatalog, invalidateCatalog } from '../catalog.mjs';
import { COVER_NAMES, comicAbs, requireInsideRoot, relOfRoot } from '../paths.mjs';
import { bad, needComic } from './_shared.mjs';

/* ---------------- 05 封面替换 ---------------- */
export async function setCover(cfg, comicId, opts) {
  const o = opts || {};
  const cat = await loadCatalog(cfg);
  const c = needComic(cfg, cat, comicId);
  const abs = comicAbs(cfg, c);
  requireInsideRoot(cfg, abs, '漫画目录');
  const destName = COVER_NAMES[0];
  const dest = path.join(abs, destName);

  let source = null;
  if (o.file) {
    // 只允许指向该漫画目录内的图片，杜绝任意文件读取
    if (!IMAGE_EXT.has(path.extname(String(o.file)).toLowerCase())) throw bad(400, '不是支持的图片格式');
    const cand = safeJoin(abs, o.file);
    await fsp.stat(cand).catch(function () { throw bad(404, '图片不存在：' + o.file); });
    source = cand;
  } else {
    // 未指定就取第一章第一张
    const ch = (c.chapters || []).find(function (x) { return x.count > 0; });
    if (!ch) throw bad(400, '这本漫画没有可用图片，无法生成封面');
    const dir = ch.dir === '.' ? abs : path.join(abs, ch.dir);
    const first = (await fsp.readdir(dir).catch(function () { return []; }))
      .filter(function (n) { return IMAGE_EXT.has(path.extname(n).toLowerCase()); })
      .sort(naturalCompare)[0];
    if (!first) throw bad(400, '章节内没有图片');
    source = path.join(dir, first);
  }
  if (path.resolve(source) !== path.resolve(dest)) {
    await fsp.copyFile(source, dest + '.tmp');
    await fsp.rename(dest + '.tmp', dest);
  }
  invalidateCatalog();
  return { comicId: c.id, cover: destName, source: path.basename(source), abs: relOfRoot(requireInsideRoot(cfg, abs, '漫画目录'), dest) };
}
