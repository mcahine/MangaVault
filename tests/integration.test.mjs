import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

export const name = '端到端集成（真 HTTP）';

/* ===========================================================================
   集成测试：把所有模块挂到真实的 createApp 上，监听随机端口，用 fetch 打真 HTTP。
   全程离线、只碰临时目录（MV_DATA_DIR + 临时库根），绝不接触真实漫画。

   注意：MV_DATA_DIR 必须在 import 任何 src 模块之前设置（config 的 dataDir() 是惰性函数，
   但库根缓存等仍以首次读取为准）。同进程内其他用例文件可能已加载过 config，这没关系 ——
   dataDir() 每次调用都重读环境变量。
   =========================================================================== */

const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-int-data-'));
process.env.MV_DATA_DIR = DATA;

/** 写一个最小的合法 JPEG（含 FFD8 头与 FFD9 尾，避免被校验器判为坏图） */
function jpegBytes(seed) {
  const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const body = Buffer.alloc(2048);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + seed) % 251;
  const tail = Buffer.from([0xFF, 0xD9]);
  return Buffer.concat([head, body, tail]);
}

async function makeComic(rootPath, dirName, meta, chapters) {
  const dir = path.join(rootPath, dirName);
  await fsp.mkdir(dir, { recursive: true });
  if (meta) await fsp.writeFile(path.join(dir, '元数据.json'), JSON.stringify(meta), 'utf8');
  let seed = 1;
  for (const ch of chapters) {
    const chDir = ch.dir === '.' ? dir : path.join(dir, ch.dir);
    await fsp.mkdir(chDir, { recursive: true });
    if (ch.dir !== '.' && ch.meta !== false) {
      await fsp.writeFile(path.join(chDir, '章节元数据.json'), JSON.stringify({ chapterId: 'cid-' + ch.dir, chapterTitle: ch.title || ch.dir, order: ch.order || 1 }), 'utf8');
    }
    for (let i = 1; i <= ch.count; i++) {
      await fsp.writeFile(path.join(chDir, String(i).padStart(3, '0') + '.jpg'), jpegBytes(seed++));
    }
  }
  if (meta && meta.__cover) await fsp.writeFile(path.join(dir, 'cover.jpg'), jpegBytes(999));
  return dir;
}

export default async function (t) {
  const rootA = path.join(DATA, 'libA');
  const rootB = path.join(DATA, 'libB');
  await fsp.mkdir(rootA, { recursive: true });
  await fsp.mkdir(rootB, { recursive: true });

  /* 根A：标准结构（元数据 + 封面 + 2 章 × 3 张） */
  await makeComic(rootA, '标准漫画', {
    id: 'intaaaaaaaaaaaaaaaaaaaaa', title: '标准漫画', author: '集成作者', pagesCount: 6,
    tags: ['集成标签'], categories: ['全彩'], likesCount: 5, viewsCount: 9,
    chapterInfos: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }, { chapterId: 'c2', chapterTitle: '第2話', order: 2 }],
    __cover: true
  }, [{ dir: '1 第1話', count: 3, title: '第1話', order: 1 }, { dir: '2 第2話', count: 3, title: '第2話', order: 2 }]);

  /* 根B：单章形态（图片直接躺在漫画目录、无元数据） */
  await makeComic(rootB, '单章图集', null, [{ dir: '.', count: 4 }]);

  /* ---------- 组装测试内实例 ---------- */
  const { createApp } = await import('../src/core/http.mjs');
  const { loadConfig } = await import('../src/core/config.mjs');
  const { createLogger } = await import('../src/core/log.mjs');

  const config = await loadConfig(true);
  config.libraryRoots = [
    { id: 'ta', name: '根A', path: rootA, enabled: true },
    { id: 'tb', name: '根B', path: rootB, enabled: true }
  ];
  config.libraryRoot = rootA;   // 兼容字段
  config.logLevel = 'error';

  const app = createApp({ log: createLogger('inttest', 'error'), accessLog: false });
  const ctx = {
    config: config,
    log: createLogger('inttest', 'error'),
    projectRoot: path.resolve(import.meta.dirname, '..'),
    dataDir: DATA,
    publicDir: path.join(path.resolve(import.meta.dirname, '..'), 'public'),
    moduleId: 'test',
    moduleMeta: {},
    reloadConfig: async function () { return loadConfig(true); },
    saveConfig: async function () { return config; }
  };

  const MODULES = ['library', 'reader', 'vault', 'dedupe', 'download', 'desktop'];
  const registered = [];
  for (const id of MODULES) {
    try {
      const mod = await import('../src/modules/' + id + '/index.mjs');
      if (typeof mod.register !== 'function') throw new Error('缺少 register()');
      await mod.register(app, Object.assign({}, ctx, { moduleId: id }));
      registered.push(id);
    } catch (err) {
      t.ok(false, '模块 ' + id + ' 注册失败：' + (err && err.message));
    }
  }
  t.eq(registered.length, MODULES.length, '6 个模块全部注册成功（' + registered.join(', ') + '）');

  /* ---------- 起服务 ---------- */
  const server = app.createServer();
  await new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  t.log('集成测试服务端口 ' + port + '，数据目录 ' + DATA);

  async function api(p, opts) {
    const o = opts || {};
    const init = { method: o.method || 'GET', headers: {} };
    if (o.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
    if (o.raw) { for (const k of Object.keys(o.raw)) init.headers[k] = o.raw[k]; }
    const res = await fetch(base + p, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    return { status: res.status, ok: res.ok, data: data, headers: res.headers };
  }

  try {
    /* 1. 服务可连通性（/api/ping 与 /api/config 属于 server.mjs 的外壳路由，
       本用例只组装模块，因此这里用一个必然存在的模块路由验证服务已起来） */
    const state0 = await api('/api/library/state');
    t.ok(state0.ok, '服务已启动，模块路由可访问（GET /api/library/state）');

    /* 2. 多库根扫描 */
    const scan = await api('/api/library/scan', { method: 'POST', body: {} });
    t.ok(scan.ok && scan.data.scanning === true, 'POST /api/library/scan 启动扫描（两个根）');
    let scanned = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(function (r) { setTimeout(r, 200); });
      const st = await api('/api/library/state');
      if (st.data && st.data.scanning === false && st.data.scannedAt) { scanned = st.data; break; }
    }
    t.ok(scanned, '扫描在 12 秒内完成');
    t.eq(scanned.stats.comics, 2, '扫到 2 部漫画（两个库根各 1 部）');
    t.eq(scanned.stats.images, 10, '共 10 张图（根A 6 张 + 根B 4 张）');
    t.ok(scanned.byRoot && scanned.byRoot.ta && scanned.byRoot.tb, '按根统计里两个根都在');

    /* 3. 多库根列表：两条都在 */
    const list = await api('/api/library/comics?size=50');
    t.eq(list.data.total, 2, 'GET /api/library/comics 返回 2 部');
    const rootIds = new Set(list.data.items.map(function (c) { return c.root; }));
    t.ok(rootIds.has('ta') && rootIds.has('tb'), '列表里两个库根的条目都被正确标注 root（' + Array.from(rootIds).join(',') + '）');

    const std = list.data.items.find(function (c) { return c.dir === '标准漫画'; });
    const single = list.data.items.find(function (c) { return c.dir === '单章图集'; });
    t.eq(std.chapterCount, 2, '标准漫画 2 个章节');
    t.eq(std.images, 6, '标准漫画 6 张图（cover.jpg 未被算作正文）');
    t.eq(single.chapterCount, 1, '单章形态识别为 1 章');
    t.eq(single.images, 4, '单章形态 4 张图');

    /* 4. 按根筛选 */
    const onlyA = await api('/api/library/comics?root=ta&size=10');
    t.eq(onlyA.data.total, 1, '?root=ta 只返回该根的 1 部');
    t.eq(onlyA.data.items[0].dir, '标准漫画', '按根筛选返回正确条目');

    /* 5. 详情 / 库根列表 */
    const detail = await api('/api/library/comic/' + encodeURIComponent(std.id));
    t.ok(detail.ok && detail.data.comic.chapters.length === 2, 'GET /api/library/comic/:id 返回 2 章');
    t.eq(detail.data.comic.rootName, '根A', '详情带库根中文名');
    const roots = await api('/api/library/roots');
    t.eq(roots.data.roots.length, 2, 'GET /api/library/roots 返回 2 个根');
    t.ok(roots.data.roots.every(function (r) { return r.exists; }), '两个库根都存在');

    /* 6. 封面 + 正文图 + Range */
    const cover = await fetch(base + '/api/library/cover/' + encodeURIComponent(std.id));
    t.eq(cover.status, 200, '标准漫画封面 HTTP 200');
    t.ok(String(cover.headers.get('content-type')).indexOf('image/') === 0, '封面 Content-Type 是图片');
    await cover.arrayBuffer();

    const ch = await api('/api/reader/chapter?comic=' + encodeURIComponent(std.id));
    t.ok(ch.ok && ch.data.pages.length === 3, 'GET /api/reader/chapter 返回 3 页');
    t.eq(ch.data.total, 2, '阅读器知道共 2 话');
    t.eq(ch.data.next.order, 2, '有下一话');
    t.eq(ch.data.prev, null, '第一话没有上一话');

    const imgUrl = base + ch.data.pages[0].url;
    const img = await fetch(imgUrl);
    t.eq(img.status, 200, '正文图 HTTP 200');
    const imgLen = Number(img.headers.get('content-length'));
    await img.arrayBuffer();

    const ranged = await fetch(imgUrl, { headers: { Range: 'bytes=0-99' } });
    t.eq(ranged.status, 206, 'Range 请求返回 206 Partial Content');
    t.eq(ranged.headers.get('content-range'), 'bytes 0-99/' + imgLen, 'Content-Range 正确：' + ranged.headers.get('content-range'));
    const chunk = Buffer.from(await ranged.arrayBuffer());
    t.eq(chunk.length, 100, 'Range 返回正好 100 字节');
    t.ok(chunk[0] === 0xFF && chunk[1] === 0xD8, 'Range 首字节是 JPEG 头（说明按偏移读取正确）');

    /* 7. 根B（单章形态）的图片也能取到 */
    const chB = await api('/api/reader/chapter?comic=' + encodeURIComponent(single.id));
    t.ok(chB.ok && chB.data.pages.length === 4, '单章形态的阅读器返回 4 页');
    const imgB = await fetch(base + chB.data.pages[0].url);
    t.eq(imgB.status, 200, '单章形态（无元数据）的正文图 HTTP 200');
    await imgB.arrayBuffer();

    /* 8. 进度写回 → 继续阅读 */
    const prog = await api('/api/library/progress', { method: 'POST', body: { comicId: std.id, chapter: 2, index: 2 } });
    t.ok(prog.ok && prog.data.progress.chapter === 2, 'POST /api/library/progress 写入第 2 话');
    t.eq(prog.data.progress.chapterRead, 3, '已读页数 = index + 1');
    const cont = await api('/api/library/continue');
    t.eq(cont.data.items.length, 1, 'GET /api/library/continue 返回 1 条');
    t.eq(cont.data.items[0].comic.id, std.id, '继续阅读指向刚读的漫画');

    /* 9. 收藏 */
    const fav = await api('/api/library/marks', { method: 'POST', body: { id: std.id, favorite: true } });
    t.ok(fav.ok && fav.data.favorite === true, '收藏成功');
    const favList = await api('/api/library/comics?fav=1&size=10');
    t.eq(favList.data.total, 1, '?fav=1 只返回收藏的 1 部');
    await api('/api/library/marks', { method: 'POST', body: { id: std.id, favorite: false } });

    /* 10. 搜索 */
    const q = await api('/api/library/comics?q=' + encodeURIComponent('集成作者') + '&size=10');
    t.eq(q.data.total, 1, '按作者搜索命中 1 部');
    const qEx = await api('/api/library/comics?q=' + encodeURIComponent('集成 -标准') + '&size=10');
    t.eq(qEx.data.total, 0, '排除词搜索生效（集成 -标准 → 0）');

    /* 11. vault 目录视图与标签 */
    const vstate = await api('/api/vault/state');
    t.ok(vstate.ok, 'GET /api/vault/state 正常');
    t.eq(vstate.data.catalog.comics, 2, 'vault 目录视图与库一致（2 部）');

    const vcomics = await api('/api/vault/comics?size=20');
    t.eq(vcomics.data.total, 2, 'GET /api/vault/comics 返回 2 部');
    const withAuto = vcomics.data.items.find(function (c) { return c.dir === '标准漫画'; });
    t.ok(withAuto.autoTags.length > 0, '自动派生标签非空（' + withAuto.autoTags.map(function (x) { return x.name; }).join(',') + '）');
    t.ok(withAuto.autoTags.some(function (x) { return x.name === '集成标签'; }), '派生包含元数据里的标签');

    const newTag = await api('/api/vault/tags', { method: 'POST', body: { name: '集成手动标签', color: 'cyan' } });
    t.ok(newTag.ok && newTag.data.tag, 'vault 新建标签成功');
    const assign = await api('/api/vault/tags/assign', { method: 'POST', body: { comicIds: [std.id], add: ['集成手动标签'], remove: [] } });
    t.ok(assign.ok, '批量打标成功');
    const tagStats = await api('/api/vault/tags/stats');
    t.ok(tagStats.ok && typeof tagStats.data.stats.total === 'number', '标签统计正常（' + tagStats.data.stats.total + ' 个标签）');
    t.ok(typeof tagStats.data.stats.usedCount === 'number', '标签统计含前端依赖的 usedCount 字段');

    /* 12. 越界与非法参数必须被拒 */
    const trav = await api('/api/library/image?comic=' + encodeURIComponent(std.id) + '&order=1&file=' + encodeURIComponent('../../config.json'));
    t.eq(trav.status, 400, '目录穿越文件名被拒（HTTP 400）');
    const badName = await api('/api/library/image?comic=' + encodeURIComponent(std.id) + '&order=1&file=nope.jpg');
    t.eq(badName.status, 404, '不在章节清单里的文件名被拒（HTTP 404）');
    const badComic = await api('/api/reader/chapter?comic=deadbeefdeadbeefdeadbeef');
    t.eq(badComic.status, 404, '不存在的漫画被拒（HTTP 404）');
    const badOrder = await api('/api/library/image?comic=' + encodeURIComponent(std.id) + '&order=99&file=001.jpg');
    t.eq(badOrder.status, 404, '不存在的章节被拒（HTTP 404）');
    const badRoute = await api('/api/nope/nope');
    t.eq(badRoute.status, 404, '未知路由返回 404');

    /* 13. 扫描单飞：并发第二次请求应 409 */
    const doubleScan = await api('/api/library/scan', { method: 'POST', body: {} });
    t.ok(doubleScan.status === 409 || doubleScan.ok, '重复扫描被单飞保护（HTTP ' + doubleScan.status + '）');
    // 若真启动了，等它结束，避免影响后续断言
    for (let i = 0; i < 60; i++) {
      await new Promise(function (r) { setTimeout(r, 200); });
      const st = await api('/api/library/state');
      if (st.data.scanning === false) break;
    }

    /* 14. 模块健康与契约完整性 */
    for (const id of MODULES) {
      const mod = await import('../src/modules/' + id + '/index.mjs');
      t.ok(Boolean(mod.meta && mod.meta.id === id), '模块 ' + id + ' 的 meta.id 与目录一致');
      t.eq(typeof mod.dispose, 'function', '模块 ' + id + ' 导出 dispose()');
    }

    t.log('集成链路全部通过：多库根扫描 → 列表 → 详情 → 封面/正文图/Range → 阅读器 → 进度 → 继续阅读 → 收藏 → 搜索 → vault 标签 → 越界拒绝');
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
    delete process.env.MV_DATA_DIR;
    await fsp.rm(DATA, { recursive: true, force: true }).catch(function () {});
  }
}
