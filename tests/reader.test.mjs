
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import http from 'node:http';

/** 拼大端 16 位 / 32 位，用来手工构造图片头（测试只关心头，不需要真图片） */
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }

export const name = '索引读取与阅读进度';

export default async function (t) {
  // 必须在 import 之前设置：DATA_DIR 在模块加载时求值
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-reader-'));
  process.env.MV_DATA_DIR = dir;

  const { readLibraryIndex, findComicById, findByDir, listComics } = await import('../src/core/library-index.mjs');
  const { saveProgress, readProgress, continueList } = await import('../src/core/reading-progress.mjs');

  /* 空索引时不炸 */
  const empty = await readLibraryIndex(true);
  t.deepEq(empty.comics, [], '索引不存在时返回空列表');
  t.eq(await findComicById('nope'), null, '找不到漫画返回 null');

  /* 写索引 -> 带 mtime 缓存也要能读到更新 */
  const idxFile = path.join(dir, 'library-index.json');
  await fsp.writeFile(idxFile, JSON.stringify({ version: 1, scannedAt: 'now', stats: { comics: 2 }, comics: [
    { id: 'c00000000000000000000001', dir: '甲漫画', title: '甲漫画', chapters: [], images: 10, chapterCount: 1 },
    { id: 'c00000000000000000000002', dir: '乙漫画', title: '乙漫画', chapters: [], images: 20, chapterCount: 1 }
  ] }), 'utf8');
  const idx = await readLibraryIndex(true);
  t.eq(idx.comics.length, 2, '读到 2 部漫画');
  t.eq((await findComicById('c00000000000000000000002')).title, '乙漫画', '按 id 查找');
  t.eq((await findByDir('甲漫画')).id, 'c00000000000000000000001', '按目录名查找（下载模块据此判断已在库）');

  // 扫描覆盖后必须能读到新数据（这是曾经导致「漫画不存在」的 bug）
  await new Promise(function (r) { setTimeout(r, 20); });
  await fsp.writeFile(idxFile, JSON.stringify({ version: 1, comics: [{ id: 'c00000000000000000000003', dir: '丙漫画', title: '丙漫画', chapters: [], images: 5, chapterCount: 1 }] }), 'utf8');
  await new Promise(function (r) { setTimeout(r, 850); });   // 越过 800ms 的 mtime 检查窗口
  const idx2 = await readLibraryIndex(true);
  t.eq(idx2.comics.length, 1, '索引更新后可读到新内容（不缓存陈旧快照）');
  t.eq((await listComics())[0].title, '丙漫画', 'listComics 走最新索引');

  /* 阅读进度：读-写-继续阅读 */
  const saved = await saveProgress({ comicId: 'c00000000000000000000003', title: '丙漫画', chapter: 2, chapterTitle: '第2話', index: 4, totalImages: 50 });
  t.eq(saved.chapter, 2, '进度章节写入');
  t.eq(saved.chapterRead, 5, '已读页数 = index+1');
  const again = await saveProgress({ comicId: 'c00000000000000000000003', chapter: 3, index: 1 });
  t.eq(again.chapter, 3, '再次写入更新章节');
  t.eq(again.chapterRead, 5, 'chapterRead 取历史最大值不回退');
  t.eq(again.title, '丙漫画', '未传 title 时保留原值');
  const all = await readProgress();
  t.eq(Object.keys(all).length, 1, '进度文件里有 1 条记录');
  const cont = await continueList(5);
  t.eq(cont.length, 1, '继续阅读列表');
  t.eq(cont[0].comicId, 'c00000000000000000000003', '继续阅读返回最新记录');
  await t.throwsAsync(async function () { await saveProgress({ chapter: 1 }); }, /缺少 comicId/, '缺 comicId 时抛错');

  /* ---------- 图片头部尺寸解析（阅读器占位高度的地基） ---------- */
  const { sizeFromBuffer, readImageSizes } = await import('../src/core/image-size.mjs');
  t.eq(sizeFromBuffer(Buffer.alloc(4)), null, '头部太短时返回 null（不抛错）');
  t.eq(sizeFromBuffer(Buffer.from('not an image at all, just text')), null, '认不出的内容返回 null');
  t.deepEq(sizeFromBuffer(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), u32(1234), u32(5678)
  ])), { w: 1234, h: 5678 }, 'PNG 从 IHDR 读宽高');
  const gif = Buffer.alloc(16);
  Buffer.from('GIF89a').copy(gif, 0); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(240, 8);
  t.deepEq(sizeFromBuffer(gif), { w: 320, h: 240 }, 'GIF 从逻辑屏读宽高');
  // JPEG：FFD8 + SOF0（段长 0x11 / 精度 8 / 高 40 / 宽 60）
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]), u16(40), u16(60),
    Buffer.from([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]), Buffer.from([0xff, 0xd9])]);
  t.deepEq(sizeFromBuffer(jpg), { w: 60, h: 40 }, 'JPEG 从 SOF0 读宽高（高在前宽在后，别搞反）');
  // SOF 前面先来一段 APP0/COM/DHT，仍要能扫到
  const jpgDeep = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14),
    Buffer.from([0xff, 0xc4, 0x00, 0x08]), Buffer.alloc(6), jpg.subarray(2)]);
  t.deepEq(sizeFromBuffer(jpgDeep), { w: 60, h: 40 }, 'JPEG 中间夹了别的段也能扫到 SOF');
  t.eq(sizeFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 7])), null, '进了扫描数据（SOS）就不再找 SOF');
  t.eq(sizeFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x02])), null, '只有 DHT（0xC4）不能被当成 SOF');
  const vp8 = Buffer.alloc(34); Buffer.from('RIFF').copy(vp8, 0); Buffer.from('WEBP').copy(vp8, 8); Buffer.from('VP8 ').copy(vp8, 12);
  vp8[23] = 0x9d; vp8[24] = 0x01; vp8[25] = 0x2a; vp8.writeUInt16LE(640, 26); vp8.writeUInt16LE(480, 28);
  t.deepEq(sizeFromBuffer(vp8), { w: 640, h: 480 }, 'WebP VP8 关键帧读宽高');
  const vp8l = Buffer.alloc(34); Buffer.from('RIFF').copy(vp8l, 0); Buffer.from('WEBP').copy(vp8l, 8); Buffer.from('VP8L').copy(vp8l, 12);
  vp8l[20] = 0x2f;
  // 无损格式的宽高是 14 位、跨字节拼出来的，构造 300x200 验证位序
  const w14 = 300 - 1, h14 = 200 - 1;
  vp8l[21] = w14 & 0xff; vp8l[22] = ((w14 >> 8) & 0x3f) | ((h14 & 0x03) << 6); vp8l[23] = (h14 >> 2) & 0xff; vp8l[24] = (h14 >> 10) & 0x0f;
  t.deepEq(sizeFromBuffer(vp8l), { w: 300, h: 200 }, 'WebP VP8L 读位拼接的宽高');
  const vp8x = Buffer.alloc(34); Buffer.from('RIFF').copy(vp8x, 0); Buffer.from('WEBP').copy(vp8x, 8); Buffer.from('VP8X').copy(vp8x, 12);
  vp8x[24] = (500 - 1) & 0xff; vp8x[25] = ((500 - 1) >> 8) & 0xff; vp8x[26] = ((500 - 1) >> 16) & 0xff;
  vp8x[27] = (700 - 1) & 0xff; vp8x[28] = ((700 - 1) >> 8) & 0xff; vp8x[29] = ((700 - 1) >> 16) & 0xff;
  t.deepEq(sizeFromBuffer(vp8x), { w: 500, h: 700 }, 'WebP VP8X 读画布宽高（存的是值-1）');
  t.eq(await readImageSizes([{ name: 'x', abs: path.join(dir, '不存在.jpg') }]).then(function (a) { return a[0]; }), null, '文件不存在时单个位返回 null 而不是抛错');
  t.eq((await readImageSizes([])).length, 0, '空数组返回空数组');

  /* ---------- /api/reader/sizes：顺序必须与页码一一对应 ---------- */
  const sizeRoot = path.join(dir, '尺寸库');
  const sizeChDir = path.join(sizeRoot, '尺寸漫画', '1 第1話');
  await fsp.mkdir(sizeChDir, { recursive: true });
  await fsp.writeFile(path.join(sizeChDir, '001.png'), Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), u32(3), u32(5)
  ]));
  await fsp.writeFile(path.join(sizeChDir, '002.jpg'), jpg);
  await fsp.writeFile(path.join(sizeChDir, '003.jpg'), Buffer.from('这不是图片，只是一段文字，用来验证坏文件不会打乱顺序'));
  await fsp.writeFile(path.join(sizeRoot, '尺寸漫画', '元数据.json'), JSON.stringify({
    id: 'dddddddddddddddddddddddd', title: '尺寸漫画', chapterInfos: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }]
  }), 'utf8');
  await fsp.writeFile(path.join(sizeChDir, '章节元数据.json'), JSON.stringify({ chapterId: 'c1', chapterTitle: '第1話', order: 1 }), 'utf8');
  const { createApp } = await import('../src/core/http.mjs');
  const { loadConfig } = await import('../src/core/config.mjs');
  const { scanLibrary } = await import('../src/modules/library/scanner.mjs');
  const cfg = await loadConfig(true);
  cfg.libraryRoots = [{ id: 'sz', name: '尺寸库', path: sizeRoot, enabled: true }];
  cfg.libraryRoot = sizeRoot;
  const scanned = await scanLibrary(sizeRoot, null);
  await fsp.writeFile(idxFile, JSON.stringify({ version: 1, comics: scanned.comics, stats: scanned.stats }), 'utf8');
  // readLibraryIndex 有 800ms 检查窗口 + mtime/size 相同的复用，刚写完必须强制刷一次，
  // 否则这里会读到上面「丙漫画」那份旧索引，sizes 路由就会 404。
  await readLibraryIndex(true);
  const app = createApp({ log: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {} }, accessLog: false });
  const readerMod = await import('../src/modules/reader/index.mjs');
  await readerMod.register(app, {
    config: cfg, log: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {} },
    projectRoot: sizeRoot, dataDir: dir, moduleId: 'reader', moduleMeta: readerMod.meta,
    reloadConfig: function () { return cfg; }, saveConfig: function () {}
  });
  const server = app.createServer();
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  const getJson = function (p) {
    return new Promise(function (resolve, reject) {
      http.get({ host: '127.0.0.1', port: port, path: p }, function (res2) {
        let s = '';
        res2.on('data', function (d) { s += d; });
        res2.on('end', function () { resolve({ code: res2.statusCode, body: JSON.parse(s) }); });
      }).on('error', reject);
    });
  };
  const szComic = scanned.comics[0];
  const sz1 = await getJson('/api/reader/sizes?comic=' + szComic.id + '&order=1');
  t.eq(sz1.code, 200, 'GET /api/reader/sizes 返回 200');
  t.eq(sz1.body.count, 3, 'count = 本章图片张数');
  t.eq(sz1.body.sizes.length, 3, '尺寸数组长度与张数一致（坏文件也不能被过滤掉）');
  t.deepEq(sz1.body.sizes[0], { w: 3, h: 5 }, '第 1 张（PNG）尺寸与文件名顺序对应');
  t.deepEq(sz1.body.sizes[1], { w: 60, h: 40 }, '第 2 张（JPEG）尺寸与文件名顺序对应');
  t.eq(sz1.body.sizes[2], null, '坏图片占位为 null，不打乱后面页的对应关系');
  t.eq((await getJson('/api/reader/sizes?comic=' + szComic.id + '&order=99')).code, 404, '章节不存在返回 404');
  t.eq((await getJson('/api/reader/sizes?comic=nope&order=1')).code, 404, '漫画不存在返回 404');
  await new Promise(function (r) { server.close(r); });
  /* ---------- 前端契约（静态断言：这些关键字消失就说明功能被删了） ---------- */
  // 必须用 fileURLToPath：本仓库路径含中文（黄漫），.pathname 会百分号编码算出不存在的路径
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const readSrc = async function (p) { try { return await fsp.readFile(path.join(repoRoot, p), 'utf8'); } catch (e) { return ''; } };
  const readerSrc = await readSrc('public/modules/reader.js');
  const themeSrc = await readSrc('public/theme.css');
  const backendSrc = await readSrc('src/modules/reader/index.mjs');
  t.ok(readerSrc.length > 1000, '读到 reader.js 源码（静态断言有依据）');
  // 翻页条：默认不锁定 + 可切换 + 有稳定选择器
  t.ok(readerSrc.indexOf('barLock: false') >= 0, '阅读器偏好默认 barLock=false（默认不锁定）');
  t.ok(readerSrc.indexOf('function toggleBarLock') >= 0, '有 toggleBarLock 切换函数');
  t.ok(readerSrc.indexOf('dataset: { act: \'bar-lock\' }') >= 0, '锁定按钮带 data-act=bar-lock（验收脚本据此定位，别改成 nth-child）');
  t.ok(readerSrc.indexOf("pagebar.classList.add('auto-hide')") >= 0, '未锁定时翻页条会淡出');
  t.ok(readerSrc.indexOf('if (S.barLock || S.stripOpen) return;') >= 0, '锁定（或缩略图条打开）时到点不淡出');
  t.ok(readerSrc.indexOf('if (S.barLock) { if (hideTimer) clearTimeout(hideTimer); setBarVisible(true); }') >= 0, '勾选锁定后立即恢复可见并取消计时器');
  t.ok(themeSrc.indexOf('.reader-pagebar.auto-hide') >= 0, '翻页条有 auto-hide 样式（透明度归零，不是 display:none）');
  t.ok(themeSrc.indexOf('opacity: 0; pointer-events: none;') >= 0, 'auto-hide 用透明度 + 关闭指针事件，避免布局抖动');
  // 条漫占位 + 预加载调度
  t.ok(readerSrc.indexOf('function holderNode') >= 0 && readerSrc.indexOf('reader-ph') >= 0, '条漫用等高占位块（不是直接堆 <img>）');
  t.ok(readerSrc.indexOf('function queueAround') >= 0 && readerSrc.indexOf('function pumpPreload') >= 0, '预加载按「离当前页距离」排队且有并发泵');
  t.ok(readerSrc.indexOf('const PRELOAD_MAX = 4;') >= 0, '预加载有并发上限（以前一次丢 16 个请求）');
  t.ok(readerSrc.indexOf('preloadDone.has(i)') >= 0, '已加载过的页不重复请求');
  t.ok(themeSrc.indexOf('.reader-ph {') >= 0 && themeSrc.indexOf('.reader-img') >= 0, '占位块与真图样式都在');
  t.ok(readerSrc.indexOf("imgs[k].setAttribute('width'") >= 0 || readerSrc.indexOf("img.setAttribute('width'") >= 0, '单页/双页也写 width/height');
  t.ok(readerSrc.indexOf('let chapterSeq = 0;') >= 0 && readerSrc.indexOf('if (seq !== chapterSeq) return;') >= 0,
    '尺寸请求带章节令牌（快速切章时旧章节的尺寸不得覆盖新章节）');
  t.ok(readerSrc.indexOf('let preloadGen = 0;') >= 0 && readerSrc.indexOf('if (gen !== preloadGen) return;') >= 0,
    '预加载带代次（换章后旧章在飞的图片不得污染新章页码）');
  t.ok(readerSrc.indexOf('preloadDone.clear();') >= 0 && readerSrc.indexOf('preloadBusy.clear();') >= 0,
    '换章时清空已加载/在飞记录（页码从 0 重来）');
  // 条漫「当前页」跟踪 —— 用户报障「条漫模式加载不出来」的现场
  // 旧实现用 IntersectionObserver + threshold:[0.4,0.75] 判当前页。占位块按整页高度撑开，
  // 单块高度超过视口 2.5 倍时最多只能露出不到 40%，回调永远不触发 → 页码恒为 1、
  // 预加载队列不跟着滚动走 → 往下滚全是灰底占位块。
  t.ok(readerSrc.indexOf('new IntersectionObserver') < 0 && readerSrc.indexOf('function observeWebtoon') < 0,
    '条漫当前页不得用 IntersectionObserver 阈值判定（阈值 0.4 在块高 > 2.5×视口时永不触发）');
  t.ok(readerSrc.indexOf('function currentPageByScroll') >= 0 && readerSrc.indexOf('function onStageScroll') >= 0 && readerSrc.indexOf('function trackWebtoon') >= 0,
    '条漫当前页由滚动位置反推（currentPageByScroll / onStageScroll / trackWebtoon）');
  t.ok(readerSrc.indexOf("ctx.on(stage, 'scroll', onStageScroll)") >= 0,
    'scroll 监听必须挂在舞台节点上（条漫唯一的驱动来源）');
  t.ok(readerSrc.indexOf('queueAround(n);') >= 0,
    '滚动时必须重排预加载队列，否则队列永远停在初始那几页');
  t.ok(readerSrc.indexOf('if (scrollBound) return;') >= 0,
    '滚动监听只绑一次（render 会被反复调用，重复绑定会把 scroll 处理放大到 N 份）');
  /* ---------- 切模式 / 切适应方式后必须仍出图（用户复报 m05101） ----------
     现象：单页↔双页没问题，一旦切到条漫就只剩灰底占位块，非得整页刷新；
     切换适应宽度/高度/原始尺寸同样白屏一次。
     根因：render() 切模式或切适应方式时 stage.textContent='' 重建 DOM，而 preloadDone
     是跨渲染保留的「这张图请求过」集合（单页/双页也预取过同页码），新占位块建好后
     startLoad(i) 因 preloadDone.has(i) 直接 return，永远等不到 swapIn —— 只有刷新
     （preloadDone 随模块重新初始化）才恢复。 */
  t.ok(readerSrc.indexOf('function fillLoaded') >= 0 && readerSrc.indexOf('fillLoaded();') >= 0,
    '渲染后必须回填已解码的图（fillLoaded），否则切模式/切适应方式后条漫全是占位块');
  t.ok(readerSrc.indexOf('S.pages[i].shown = false;') >= 0,
    '重建占位块时要作废旧的回填标记（shown），否则新块不会被回填');
  t.ok(readerSrc.indexOf('p.shown') >= 0 && readerSrc.indexOf('p.img.complete') >= 0,
    'fillLoaded 必须只回填「已请求且已解码」的页');
  // 后端契约
  t.ok(backendSrc.indexOf('barLock: false') >= 0, '后端 DEFAULTS 收录 barLock（否则 POST /api/reader/prefs 会被白名单丢掉）');
  t.ok(backendSrc.indexOf("'/api/reader/sizes'") >= 0, '后端有 /api/reader/sizes 路由');
  /* ---------- 并发读索引不得拿到过期快照（阅读器「漫画不存在」的真根因） ----------
     现象：阅读器同时请求 /api/reader/chapter 与 /api/reader/sizes，索引刚建好时偶发
     「漫画不存在：xxx」，重试一次又好了。原因是 checkedAt 在 await 之前推进，
     第二个并发请求走了 800ms 短路，拿到的是上一次的空快照。 */
  const { readLibraryIndex: readIdx } = await import('../src/core/library-index.mjs');
  // 真实复现路径：换一个新的数据目录（模块级缓存随之复位为空快照），刚写完索引的
  // 那一刻同时来两个请求 —— 正是阅读器「章节数据 + 图片尺寸」并行发出的那一刻。
  // 旧实现里 checkedAt 在 await 之前推进，第二个请求于 800ms 窗口内直接返回空快照，
  // 表现就是偶发「漫画不存在」，重试一次又好了。
  const raceDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-index-race-'));
  const prevDataDir = process.env.MV_DATA_DIR;
  process.env.MV_DATA_DIR = raceDir;
  await fsp.writeFile(path.join(raceDir, 'library-index.json'), JSON.stringify({ version: 1, scannedAt: 'race', comics: [
    { id: 'eeeeeeeeeeeeeeeeeeeeeeee', dir: '并发漫画', title: '并发漫画', chapters: [], images: 7, chapterCount: 1 }
  ] }), 'utf8');
  const settled = await Promise.all(Array.from({ length: 6 }, function () { return readIdx(); }));
  t.ok(settled.every(function (d) { return d.comics.length === 1 && d.comics[0].id === 'eeeeeeeeeeeeeeeeeeeeeeee'; }),
    '新数据目录首读 + 并发：6 个请求全部拿到索引内容（没有谁读到空/过期快照）');
  const one = await readIdx();
  t.eq(one.comics.length, 1, '并发之后单次读仍是同一份内容');
  if (prevDataDir === undefined) delete process.env.MV_DATA_DIR; else process.env.MV_DATA_DIR = prevDataDir;
  await fsp.rm(raceDir, { recursive: true, force: true });
  delete process.env.MV_DATA_DIR;
  await fsp.rm(dir, { recursive: true, force: true });
}
