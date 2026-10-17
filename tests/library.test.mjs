
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

export const name = '漫画库扫描器';

/** 在临时目录里造一个「像真库一样」的漫画目录 */
async function makeComic(root, dirName, meta, chapters) {
  const dir = path.join(root, dirName);
  await fsp.mkdir(dir, { recursive: true });
  if (meta) await fsp.writeFile(path.join(dir, '元数据.json'), JSON.stringify(meta), 'utf8');
  if (meta && meta.__cover !== false) await fsp.writeFile(path.join(dir, 'cover.jpg'), 'COVERBYTES');
  for (const ch of chapters) {
    if (ch.dir === '.') {
      for (let i = 1; i <= ch.count; i++) {
        await fsp.writeFile(path.join(dir, String(i).padStart(3, '0') + '.jpg'), 'x'.repeat(10));
      }
      continue;
    }
    const chDir = path.join(dir, ch.dir);
    await fsp.mkdir(chDir, { recursive: true });
    if (ch.meta !== false) await fsp.writeFile(path.join(chDir, '章节元数据.json'), JSON.stringify({ chapterId: 'cid-' + ch.dir, chapterTitle: ch.title || ch.dir, order: ch.order || 1 }), 'utf8');
    for (let i = 1; i <= ch.count; i++) {
      await fsp.writeFile(path.join(chDir, String(i).padStart(3, '0') + '.jpg'), 'x'.repeat(10));
    }
  }
  return dir;
}

export default async function (t) {
  const { scanComic, scanLibrary } = await import('../src/modules/library/scanner.mjs');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-lib-'));

  // 1) 标准结构：cover.jpg + 2 章，每章 3 张 —— cover 绝不能被算成正文
  await makeComic(root, '标准漫画', {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa', title: '标准漫画', author: '作者A', pagesCount: 6,
    tags: ['巨乳', '純愛'], categories: ['全彩'], likesCount: 42, viewsCount: 100,
    chapterInfos: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }, { chapterId: 'c2', chapterTitle: '第2話', order: 2 }]
  }, [{ dir: '1 第1話', order: 1, title: '第1話', count: 3 }, { dir: '2 第2話', order: 2, title: '第2話', count: 3 }]);

  // 2) 旧结构：漫画/分类/章节/图片（深一层）
  await makeComic(root, '深层结构', null, [
    { dir: '上卷/01', order: 1, count: 2 },
    { dir: '上卷/02', order: 2, count: 2 }
  ]);

  // 3) 单章结构：图片直接躺在漫画目录里（无 cover）
  await makeComic(root, '单章图集', { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', title: '单章图集' }, [{ dir: '.', count: 4 }]);

  // 4) 空目录（应被登记为 0 图，供体检发现）
  await fsp.mkdir(path.join(root, '空目录'), { recursive: true });

  const progressEvents = [];
  const res = await scanLibrary(root, function (p) { progressEvents.push(p.phase); });

  t.eq(res.stats.comics, 4, '发现 4 个漫画目录');
  t.eq(res.stats.withMeta, 2, '2 部有元数据');
  t.eq(res.stats.empty, 1, '1 部空目录');
  t.ok(progressEvents.includes('list') && progressEvents.includes('scan'), '扫描过程有进度回调');

  const std = res.comics.find(function (c) { return c.dir === '标准漫画'; });
  t.ok(Boolean(std), '标准漫画被扫描到');
  t.eq(std.id, 'aaaaaaaaaaaaaaaaaaaaaaaa', '优先使用元数据里的 id');
  t.eq(std.author, '作者A', '作者字段映射');
  t.eq(std.likes, 42, '点赞字段映射');
  t.eq(std.chapterCount, 2, '标准漫画 2 个章节');
  t.eq(std.images, 6, '标准漫画正文 6 张（cover.jpg 不算正文）');
  t.eq(std.cover, 'cover.jpg', '识别出本地封面文件');
  t.eq(std.chapters[0].chapterId, 'c1', '章节 ID 来自元数据');
  t.eq(std.chapters[1].title, '第2話', '章节标题来自章节元数据');

  const deep = res.comics.find(function (c) { return c.dir === '深层结构'; });
  t.eq(deep.chapterCount, 2, '深层结构识别出 2 章');
  t.eq(deep.images, 4, '深层结构 4 张图');

  const single = res.comics.find(function (c) { return c.dir === '单章图集'; });
  t.eq(single.chapterCount, 1, '顶层直接放图 => 1 个虚拟章节');
  t.eq(single.images, 4, '单章图集 4 张图');
  t.eq(single.chapters[0].dir, '.', '虚拟章节 dir 为 .');

  const empty = res.comics.find(function (c) { return c.dir === '空目录'; });
  t.eq(empty.images, 0, '空目录 0 张图');

  /* 单目录扫描：不存在的目录返回 null 而不是抛错 */
  const missing = await scanComic(root, '不存在的目录');
  t.eq(missing, null, '扫描不存在的目录返回 null');

  /* 根目录不存在：不抛错，而是宽容跳过并在 roots 里如实报告（多库根场景下不能因为一个根掉线就整体失败） */
  const missingRoot = path.join(root, 'no-such-root');
  const res2 = await scanLibrary(missingRoot, null);
  t.eq(res2.stats.comics, 0, '不可读的库根不产出漫画');
  t.eq(res2.roots.length, 1, '不可读的库根仍出现在 roots 报告里');
  t.eq(res2.roots[0].ok, false, '不可读的库根标记为 ok=false');
  t.ok(/不存在/.test(res2.roots[0].error || ''), '不可读的库根给出中文原因：' + res2.roots[0].error);

  await fsp.rm(root, { recursive: true, force: true });
}
