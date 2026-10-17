import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sanitizeDirName, galleryIdOf, listComicDirs, probeUnit, buildMeta,
  parseArgs, main, rollback
} from '../scripts/normalize-dir.mjs';
import { normalizeTitle } from '../scripts/normalize-library.mjs';

export const name = 'normalize-dir 库格式正规化';

/** 临时目录（os.tmpdir() 在 run_code 里可能是相对路径，这里统一绝对化） */
function tmpRoot(tag) {
  return path.join(path.resolve(os.tmpdir()), 'mv-norm-test-' + tag + '-' + process.pid + '-' + Date.now());
}

/** 造一个单元：images 张假图 + junk 个杂物 */
async function makeUnit(root, name, images, junk, subdirs) {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  for (let i = 1; i <= images; i++) {
    await fsp.writeFile(path.join(dir, String(i).padStart(8, '0') + '.jpg'), 'IMG' + i);
  }
  for (const j of junk || []) await fsp.writeFile(path.join(dir, j), 'junk');
  for (const sd of subdirs || []) {
    await fsp.mkdir(path.join(dir, sd), { recursive: true });
    await fsp.writeFile(path.join(dir, sd, '001.jpg'), 'sub');
  }
  return dir;
}

/** 安静执行：脚本主流程会 console.log 计划，测试里不需要这份噪声 */
async function quiet(fn) {
  const old = console.log;
  const oldErr = console.error;
  console.log = function () {};
  console.error = function () {};
  try { return await fn(); } finally { console.log = old; console.error = oldErr; }
}

export default async function (t) {
  /* ---- (a) 目录名清洗 ---- */
  t.eq(sanitizeDirName('标题: 副标题'), '标题_ 副标题', '半角冒号是 Windows 非法字符，替换成下划线');
  t.eq(sanitizeDirName('a  b\\c/d'), 'a b_c_d', '反斜杠与斜杠也替换');
  t.eq(sanitizeDirName('  空格  很多\u3000全角  '), '空格 很多 全角', '折叠连续空白（含全角空格）并去首尾');
  t.eq(sanitizeDirName('结尾有点...'), '结尾有点', '去掉结尾的点（Windows 不允许以点结尾）');
  t.eq(sanitizeDirName('正常标题♥️ 2'), '正常标题♥️ 2', '合法字符与表情原样保留');

  /* ---- (b) 画廊号前缀 ---- */
  t.eq(galleryIdOf('1924536-[作者] 标题'), '1924536', '识别 7 位画廊号前缀');
  t.eq(galleryIdOf('12345-标题'), '12345', '5 位也认');
  t.eq(galleryIdOf('1234-标题'), null, '4 位不认（避免把年份当画廊号）');
  t.eq(galleryIdOf('清楚ビッチな巫女先輩'), null, '没有前缀返回 null');
  t.eq(galleryIdOf('JB-001 作品'), null, '字母前缀不当画廊号');

  /* ---- (c) 标题规范化复用 normalize-library 的口径 ---- */
  t.eq(normalizeTitle('标题（deadbeef）'), '标题', '末尾十六进制技术后缀被剥掉');
  t.eq(normalizeTitle('标题（单行本）'), '标题（单行本）', '有语义的括号标注保留');

  /* ---- (d) probeUnit 分类 ---- */
  const root1 = tmpRoot('probe');
  try {
    await makeUnit(root1, '裸本', 5, ['.ehviewer', '.thumb', '防失联.txt']);
    await makeUnit(root1, '已规范', 0, [], ['1 第1話']);
    await fsp.writeFile(path.join(root1, '已规范', '元数据.json'), '{}');
    await makeUnit(root1, '混合', 3, ['.ehviewer'], ['2 第2話']);
    await makeUnit(root1, '空目录', 0, ['.thumb']);
    await fsp.mkdir(path.join(root1, '_杂物'), { recursive: true });
    const names = await listComicDirs(root1);
    /* naturalCompare 用 Intl.Collator('zh')，中文按拼音排序，不是笔画/编码序 */
    t.deepEq(names, ['混合', '空目录', '裸本', '已规范'], '一级子目录按拼音自然序、跳过下划线开头');

    const p1 = await probeUnit(path.join(root1, '裸本'));
    t.eq(p1.images.length, 5, '裸本探到 5 张图');
    t.eq(p1.junk.length, 3, '裸本探到 3 个杂物');
    t.deepEq(p1.junk, ['.ehviewer', '.thumb', '防失联.txt'], '杂物列表（目录内自然序）');
    t.eq(p1.chapterDirs.length, 0, '裸本没有含图章节目录');
    t.eq(p1.hasMeta, false, '裸本没有元数据');

    const p2 = await probeUnit(path.join(root1, '已规范'));
    t.eq(p2.images.length, 0, '已规范：顶层无散图');
    t.eq(p2.chapterDirs.length, 1, '已规范：一个含图章节目录');
    t.eq(p2.hasMeta, true, '已规范：有元数据');

    const p3 = await probeUnit(path.join(root1, '混合'));
    t.eq(p3.images.length, 3, '混合形态顶层仍有 3 张图');
    t.eq(p3.chapterDirs.length, 1, '混合形态也有章节目录');

    /* ---- (e) buildMeta 形状 ---- */
    const meta = buildMeta('1924536-[作者] 标题', '标题', p1, '1924536');
    t.ok(/^d-[0-9a-f]{12}$/.test(meta.id), 'id 形如 d-<12位十六进制>（与扫描器口径一致）');
    t.eq(meta.title, '标题', 'title 用清洗后的标题');
    t.eq(meta.pagesCount, 5, 'pagesCount = 顶层图片数');
    t.eq(meta.chapterInfos.length, 1, '单章：一条 chapterInfo');
    t.eq(meta.chapterInfos[0].order, 1, 'chapterInfo.order = 1');
    t.eq(meta.chapterInfos[0].chapterTitle, '第1話', 'chapterInfo.chapterTitle = 第1話');
    t.ok(/^d-[0-9a-f]{12}$/.test(meta.chapterInfos[0].chapterId), 'chapterId 也是短哈希');
    t.ok(meta.id !== meta.chapterInfos[0].chapterId, '漫画 id 与章节 id 不同');
    t.eq(meta.galleryId, '1924536', '来源画廊号被保留（契约允许未知字段）');
    const meta2 = buildMeta('标题', '标题', p1, null);
    t.eq(meta2.galleryId, undefined, '没有画廊号时不写该字段');

    /* ---- (f) 参数解析 ---- */
    const a1 = parseArgs(['--dir=C:/x', '--apply', '--limit=3', '--rename-dir']);
    t.eq(a1.dir, 'C:/x', '解析 --dir=VALUE');
    t.eq(a1.apply, true, '解析 --apply');
    t.eq(a1.limit, 3, '解析 --limit');
    t.eq(a1.renameDir, true, '解析 --rename-dir');
    t.eq(parseArgs([]).renameDir, false, '默认不改目录名');
    await t.throwsAsync(async function () { parseArgs(['--nope']); }, /未知参数/, '未知参数报错');
  } finally { await fsp.rm(root1, { recursive: true, force: true }); }

  /* ---- (g) 端到端：apply 后结构正确、幂等、可回滚 ---- */
  const root2 = tmpRoot('apply');
  const junkDir = tmpRoot('junk');
  try {
    await makeUnit(root2, '1924536-[作者] 裸本', 4, ['.ehviewer', '防失联.txt']);
    await makeUnit(root2, '已规范本', 0, [], ['1 第1話']);
    await fsp.writeFile(path.join(root2, '已规范本', '元数据.json'), JSON.stringify({ id: 'keep-me', title: '已规范本' }));
    await fsp.writeFile(path.join(root2, '1924536-[作者] 裸本', '说明.txt'), 'x');

    const code = await quiet(function () { return main(['--dir=' + root2, '--apply', '--junk-dir=' + junkDir]); });
    t.eq(code, 0, 'apply 退出码 0');

    const top = await fsp.readdir(root2);
    t.deepEq(top.sort(), ['1924536-[作者] 裸本', '已规范本'], '目录名未被改动（默认不改名）');

    const unit = path.join(root2, '1924536-[作者] 裸本');
    const topFiles = await fsp.readdir(unit);
    t.deepEq(topFiles.sort(), ['1 第1話', '元数据.json'], '裸本已变成规范形态（顶层只剩章节目录与元数据）');
    const chFiles = await fsp.readdir(path.join(unit, '1 第1話'));
    t.eq(chFiles.filter(function (n) { return n.endsWith('.jpg'); }).length, 4, '4 张图全部搬进章节目录');
    t.ok(chFiles.indexOf('章节元数据.json') >= 0, '章节目录里有 章节元数据.json');

    const meta = JSON.parse(await fsp.readFile(path.join(unit, '元数据.json'), 'utf8'));
    t.eq(meta.pagesCount, 4, '元数据 pagesCount = 4');
    t.eq(meta.title, '1924536-[作者] 裸本', '标题保留画廊号前缀（不猜后缀）');
    t.eq(meta.galleryId, '1924536', '画廊号写进元数据便于追溯');
    const cm = JSON.parse(await fsp.readFile(path.join(unit, '1 第1話', '章节元数据.json'), 'utf8'));
    t.eq(cm.chapterId, meta.chapterInfos[0].chapterId, '章节元数据的 chapterId 与漫画元数据一致');
    t.eq(cm.chapterTitle, '第1話', '章节标题 = 第1話');

    /* 已规范的单元不能被二次改动 */
    const keepMeta = JSON.parse(await fsp.readFile(path.join(root2, '已规范本', '元数据.json'), 'utf8'));
    t.eq(keepMeta.id, 'keep-me', '已规范单元的元数据原样保留（跳过）');

    /* 杂物进了备份，且带完整路径 */
    const junkFiles = [];
    async function walk(d) {
      const es = await fsp.readdir(d, { withFileTypes: true });
      for (const e of es) { if (e.isDirectory()) await walk(path.join(d, e.name)); else junkFiles.push(e.name); }
    }
    await walk(path.join(junkDir, 'junk'));
    t.deepEq(junkFiles.sort(), ['.ehviewer', '说明.txt', '防失联.txt'].sort(), '3 个杂物都进了备份目录');

    /* ---- (h) 幂等：第二次跑全部跳过 ---- */
    /* 扫描器按「目录名 + 目录 mtime」缓存，等一秒确保 mtime 真的变了 */
    await new Promise(function (r) { setTimeout(r, 1100); });
    const before = await fsp.readdir(unit);
    await quiet(function () { return main(['--dir=' + root2, '--apply', '--junk-dir=' + junkDir]); });
    const after = await fsp.readdir(unit);
    t.deepEq(after.sort(), before.sort(), '重复 apply 不产生新结构');
    const metaAgain = JSON.parse(await fsp.readFile(path.join(unit, '元数据.json'), 'utf8'));
    t.eq(metaAgain.id, meta.id, '重复 apply 的 id 稳定');

    /* ---- (i) 回滚：还原成裸形态 ---- */
    /* 每次 apply 都落一份带时间戳的对照表，所以后面那次幂等 apply 也会新增一份；取最早的那份——
       幂等那次所有单元都是 skip，按它回滚不会做任何事 */
    const mfName = (await fsp.readdir(junkDir)).filter(function (n) { return /^manifest-\d{8}-\d{6}-\d{3}\.json$/.test(n); }).sort();
    t.ok(mfName.length >= 1, 'apply 落带时间戳的 manifest-<时间>.json 回滚对照表（实测 ' + mfName.length + ' 份）');
    const manifestFile = path.join(junkDir, mfName[0]);
    const rc = await quiet(function () { return rollback(manifestFile); });
    t.eq(rc, 0, '回滚退出码 0');
    const backFiles = (await fsp.readdir(unit)).sort();
    t.eq(backFiles.filter(function (n) { return n.endsWith('.jpg'); }).length, 4, '4 张图回到漫画目录顶层');
    t.ok(backFiles.indexOf('元数据.json') < 0, '回滚后漫画目录没有 元数据.json');
    t.ok(backFiles.indexOf('1 第1話') < 0, '回滚后章节目录已删除');
    t.ok(backFiles.indexOf('.ehviewer') >= 0 && backFiles.indexOf('防失联.txt') >= 0, '回滚后杂物回到原位');

    const keepMeta2 = JSON.parse(await fsp.readFile(path.join(root2, '已规范本', '元数据.json'), 'utf8'));
    t.eq(keepMeta2.id, 'keep-me', '回滚不动原本就规范的单元');

    /* 回滚幂等：再回滚一次不报错、不改结构 */
    const rc2 = await quiet(function () { return rollback(manifestFile); });
    t.eq(rc2, 0, '重复回滚不报错');
    t.eq((await fsp.readdir(unit)).filter(function (n) { return n.endsWith('.jpg'); }).length, 4, '重复回滚后图片仍在顶层');

    /* ---- (j) 改名模式（--rename-dir）：清洗后的名字与冲突让路 ---- */
    /* Windows 不允许目录名带 ':'，所以用「连续空格」这种合法但需要折叠的名字测改名 */
    await makeUnit(root2, 'B  目标名', 2, []);
    await makeUnit(root2, 'A 目标名', 2, []);
    const code3 = await quiet(function () { return main(['--dir=' + root2, '--apply', '--rename-dir', '--junk-dir=' + junkDir]); });
    t.eq(code3, 0, '改名模式退出码 0');
    const top3 = (await fsp.readdir(root2)).sort();
    t.ok(top3.indexOf('B 目标名') >= 0, '连续空格被折叠，目录名被改到清洗后的名字');
    t.ok(top3.indexOf('A 目标名') >= 0, '正常目录名不改');
    const renamed = path.join(root2, 'B 目标名');
    t.ok(fs.existsSync(path.join(renamed, '1 第1話')) && fs.existsSync(path.join(renamed, '元数据.json')), '改名后结构仍完整');
  } finally {
    await fsp.rm(root2, { recursive: true, force: true });
    await fsp.rm(junkDir, { recursive: true, force: true });
  }
}
