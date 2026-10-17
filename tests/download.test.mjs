import { DEFAULTS } from '../src/core/config.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

import { createPicaClient, createSignature, signPath, imageUrlOf, coverUrlOf, decodeChunked, rawHttpRequest, PICA_DIGEST_KEY, PICA_NONCE, PICA_API_KEY, PICA_USER_AGENT } from '../src/modules/download/api.mjs';
import { createPicacomicSource } from '../src/modules/download/sources/picacomic.mjs';
import { createPaths, extOfFormat, sniffImageExt, pad3 } from '../src/modules/download/paths.mjs';
import { buildComicMetadata, buildChapterMetadata, createLimiter, createSpeedometer, extForImage, hasImage, swapDir, atomicWriteJson } from '../src/modules/download/engine.mjs';
import * as ledger from '../src/modules/download/ledger.mjs';
import { indexLibrary, chapterStats, chapterDone, isInside } from '../src/modules/download/comic.mjs';
import { safeTmpDir } from '../src/core/util.mjs';

export const name = '下载模块（全离线）';

/* ---------------- 测试替身 ---------------- */

/**
 * 带重试的目录删除。
 * Windows 上文件句柄释放滞后，递归 rm 常见 EBUSY/EPERM/ENOTEMPTY；
 * 用例清理一律走它，最多 5 次、200ms 起线性退避，最后一次仍失败才抛。
 */
async function rmWithRetry(target, tries) {
  const max = Math.max(1, Number(tries) || 5);
  let last = null;
  for (let i = 0; i < max; i++) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return true;
    } catch (err) {
      last = err;
      const code = err && err.code;
      const retriable = ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES', 'EMFILE'].indexOf(code) >= 0;
      if (!retriable) throw err;
      if (i < max - 1) await new Promise(function (r) { setTimeout(r, 200 * (i + 1)); });
    }
  }
  throw last;
}

/** 造一个 fetch 风格的响应。 */
function mockResponse(status, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const map = Object.create(null);
  for (const k of Object.keys(headers || {})) map[k.toLowerCase()] = String(headers[k]);
  return {
    status: status,
    ok: status >= 200 && status < 300,
    headers: { get: function (k) { return map[String(k).toLowerCase()] || null; } },
    async text() { return buf.toString('utf8'); },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }
  };
}

/** 一张最小的合法 JPEG（魔数 + 尾巴），用于校验扩展名与落盘。 */
// 图片体积默认 > 512B：引擎会把过小文件判为坏图并重下，测试里必须避开这个阈值
function fakeJpeg(size) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const body = Buffer.alloc(Math.max(8, (size || 1024) - head.length - 2), 0x11);
  return Buffer.concat([head, body, Buffer.from([0xff, 0xd9])]);
}
function fakePng(size) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(Math.max(4, (size || 1024) - head.length), 0x22)]);
}
function fakeGif(size) {
  return Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(Math.max(4, (size || 1024) - 6), 0x33)]);
}

/** 把假源里的章节对象转成统一 Chapter（来源原始字段挂在 raw 上，和真实适配器一致）。 */
function fakeChapterOf(ch) {
  return {
    chapterId: String(ch._id || ch.id || ''),
    chapterTitle: ch.title || ('第 ' + ch.order + ' 话'),
    order: Number(ch.order || 0),
    updatedAt: ch.updated_at || ch.updatedAt || null,
    images: Number(ch.pagesCount || 0),
    raw: ch
  };
}

/**
 * 造一个完全内存的「下载源适配器」替身（契约见 src/modules/download/sources/types.mjs）。
 * 引擎与路由层只认契约方法，所以替身也必须长成适配器的样子：
 *   comic / chapters / chaptersAll / pagesAll / download / coverUrl …
 * pages: { [order]: imageCount }；第 failIndexes 张图会持续失败。
 */
function makeFakeClient(options) {
  const o = options || {};
  const calls = { search: 0, comic: 0, chapters: 0, pages: 0, images: 0, imageUrls: [], downloaded: [], byIndex: {} };
  const fails = new Set(o.failIndexes || []);
  const chapters = o.chapters || [{ _id: 'c1', title: '第1話', order: 1 }];
  const cover = 'https://img.test/cover.jpg';
  const thumb = { originalName: 'c.jpg', path: 'a/b/c.jpg', fileServer: 'https://img.test' };
  return {
    calls: calls,
    meta: { id: 'fake', name: '测试源', capabilities: ['search', 'comic', 'chapters', 'pages', 'favorites', 'profile', 'download', 'cover'] },
    signature: createSignature,
    coverUrl: function () { return cover; },
    async search(keyword, options2) {
      calls.search++;
      return {
        page: 1, pages: 1, total: 1,
        docs: [{
          id: 'comic1', title: '测试漫画', author: '作者甲', cover: cover, tags: ['t1'], categories: [],
          description: '', chineseTeam: '', pagesCount: 0, chapterCount: chapters.length,
          likes: 12, views: 0, finished: false, createdAt: null, updatedAt: null, raw: {}
        }]
      };
    },
    async comic(comicId) {
      calls.comic++;
      if (o.comicFails) throw new Error('详情接口挂了');
      return {
        id: String(comicId), title: '测试漫画', author: '作者甲', cover: cover,
        tags: ['标签A'], categories: ['短篇'], description: '简介', chineseTeam: '汉化组',
        pagesCount: 0, chapterCount: chapters.length, likes: 7, views: 99, finished: true,
        createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-02-01T00:00:00Z',
        // 统一结构没建模的来源专有字段（thumb / creator）放在 raw 里
        raw: {
          _id: String(comicId), title: '测试漫画', author: '作者甲', pagesCount: 0, epsCount: chapters.length,
          finished: true, categories: ['短篇'], tags: ['标签A'], likesCount: 7, viewsCount: 99,
          description: '简介', chineseTeam: '汉化组',
          createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-02-01T00:00:00Z',
          thumb: thumb, creator: { _id: 'u1', name: 'UP主', level: 3 }
        }
      };
    },
    async chapters() { calls.chapters++; return { page: 1, pages: 1, total: chapters.length, docs: chapters.map(fakeChapterOf) }; },
    async chaptersAll() { calls.chapters++; return chapters.map(fakeChapterOf); },
    async pagesAll(comicId, order) {
      calls.pages++;
      const n = (o.pages && o.pages[order]) || 3;
      const out = [];
      for (let i = 1; i <= n; i++) out.push({ index: i, url: 'https://img.test/static/c' + order + '/' + i + '.jpg', raw: {} });
      calls.imageUrls = calls.imageUrls.concat(out.map(function (p) { return p.url; }));
      return out;
    },
    async download(url, options2) {
      calls.images++;
      calls.downloaded.push(url);
      const signal = (options2 || {}).signal;
      const m = /\/(\d+)\.jpg$/.exec(url);
      const idx = m ? Number(m[1]) : 0;
      if (fails.has(idx)) throw new Error('模拟单图永远失败');
      if (o.slowMs) await new Promise(function (r) { setTimeout(r, o.slowMs); });
      if (signal && signal.aborted) throw new Error('已取消');
      const kind = (o.imageKind && o.imageKind[idx]) || 'jpg';
      let buf = fakeJpeg(1024);
      let contentType = 'image/jpeg';
      if (kind === 'png') { buf = fakePng(1024); contentType = 'image/png'; }
      else if (kind === 'gif') { buf = fakeGif(1024); contentType = 'image/gif'; }
      else if (kind === 'empty') { buf = Buffer.alloc(0); contentType = ''; }
      // 响应声明的 Content-Length：默认与实收一致。
      // wrongLengthFirst / wrongLengthAlways 用来造「声明与实收不符」的重试与死信用例。
      let declared = buf.length;
      if (o.wrongLengthAlways && o.wrongLengthAlways[idx] !== undefined) declared = Number(o.wrongLengthAlways[idx]);
      if (o.wrongLengthFirst && o.wrongLengthFirst[idx] !== undefined) {
        const seen = calls.byIndex[idx] || 0;
        calls.byIndex[idx] = seen + 1;
        if (seen === 0) declared = Number(o.wrongLengthFirst[idx]);
      }
      return { buffer: buf, contentType: contentType, contentLength: declared };
    }
  };
}

function makeEngineCfg(root, extra) {
  return {
    downloadRoot: root,
    libraryRoot: root,
    picacomic: Object.assign({
      apiBase: 'https://picaapi.picacomic.com', apiKey: PICA_API_KEY, token: 'x', proxy: null,
      downloadFormat: 'Jpeg', dirFmt: '{comic_title}/{order} {chapter_title}',
      chapterConcurrency: 2, chapterIntervalMs: 0, imgConcurrency: 4, imgIntervalMs: 0,
      retryTimes: 2, timeoutMs: 5000, shouldDownloadCover: true, maxConcurrentTasks: 2
    }, extra || {})
  };
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

/** 三位补零的图片绝对路径（与 paths.mjs 的命名规范一致）。 */
function pageFile(dir, n) {
  return path.join(dir, ('000' + String(n)).slice(-3) + '.jpg');
}

/** 文件是否存在（断言用，不抛）。 */
async function exists(file) {
  try { await fsp.stat(file); return true; } catch (e) { return false; }
}

/** 等任务跑到终态（done / error / canceled），最多 tries 轮。 */
async function waitTask(engine, taskId, tries) {
  const max = Number(tries) || 400;
  for (let i = 0; i < max; i++) {
    const v = engine.get(taskId);
    if (!v) return null;
    if (v.state === 'done' || v.state === 'error' || v.state === 'canceled') return v;
    await new Promise(function (r) { setTimeout(r, 40); });
  }
  return engine.get(taskId);
}

/* ---------------- 用例 ---------------- */

export default async function (t) {
  // 本文件全程隔离数据目录：逐页台账写在 data/download/ledger 下，
  // 不能让测试产生的台账落进用户真实数据目录（AGENT.md 第 9 节）。
  const prevDataDir0 = process.env.MV_DATA_DIR;
  const ledgerDataDir = safeTmpDir('mvdl-data-');
  process.env.MV_DATA_DIR = ledgerDataDir;

  // ===== 组 1：签名算法 =====
  const time = '1700000000';
  const expectSig = crypto.createHmac('sha256', PICA_DIGEST_KEY).update(('comics/advanced-search' + time + PICA_NONCE + 'POST' + PICA_API_KEY).toLowerCase()).digest('hex');
  t.eq(createSignature('comics/advanced-search', 'POST', time), expectSig, '签名 = HMAC-SHA256(DIGEST_KEY, lowercase(path+time+nonce+method+apiKey))');

  // 回归：UA 与 apiKey 必须是哔咔认的「真值」。
  // 踩坑记录：UA 曾写成 okhttp/3.12.13 —— 公开接口照样 200，但任何带 authorization 的接口
  // 一律 401/1005，看起来像 token 失效，实际是 UA 触发的风控。实测 3.8.1 与 3.12.13 的差别就是 200 与 1005。
  t.eq(PICA_USER_AGENT, 'okhttp/3.8.1', 'User-Agent 必须是哔咔要求的 okhttp/3.8.1');
  t.eq(PICA_API_KEY, 'C69BAF41DA5ABD1FFEDC6D2FEA56B', 'apiKey 必须是官方真值（64 位是历史伪造串）');
  t.eq(PICA_API_KEY.length, 29, 'apiKey 是官方 29 位值（C69BAF41DA5ABD1FFEDC6D2FEA56B，与参考实现逐字节一致）');
  t.ok(PICA_API_KEY.length !== 64, 'apiKey 不能是 64 位的历史伪造串（配置模板曾写死它并被合并进用户配置）');
  t.eq(DEFAULTS.picacomic.apiKey, '', '配置模板不得再写死 apiKey（留空交回代码常量兜底）');
  // 回归（重大坑）：签名原文里的 path **必须保留 query**。
  // 参考实现 pica_client.rs:429 的 create_signature 收到的就是含 query 的完整路径
  // （如 comics/leaderboard?tt=H24&ct=VC）。我们曾把 '?' 之后剥掉再签名 —— 于是所有
  // 带 query 的端点（排行榜/搜索/收藏/漫画列表/章节列表）签名全错，而上游**不报错**：
  // HTTP 200 + {"code":200,"message":"success"}（41 字节，没有 data）。
  // 不带 query 的端点（users/profile、categories）不受影响，极容易被误判成「接口数据结构变了」。
  // 实测对照（同一 token、同一代理）：comics/leaderboard?tt=H24&ct=VC
  //   剥 query → 41 字节无 data；含 query → 37968 字节真实 data。
  const qPath = 'comics/advanced-search?page=2';
  const expectSigQ = crypto.createHmac('sha256', PICA_DIGEST_KEY).update((qPath + time + PICA_NONCE + 'POST' + PICA_API_KEY).toLowerCase()).digest('hex');
  t.eq(createSignature(qPath, 'POST', time), expectSigQ, '签名原文保留 query（含 ?page=2）');
  t.ok(createSignature(qPath, 'POST', time) !== expectSig, '带 query 与不带 query 的签名必须不同（历史 bug 曾让两者相同）');
  t.eq(signPath('/comics/x/chapters?a=1'), 'comics/x/chapters?a=1', 'signPath 只去前导斜杠，必须保留 query');
  t.eq(signPath('comics/x'), 'comics/x', 'signPath 对已无前导斜杠的路径原样返回');
  t.ok(createSignature('comics/advanced-search', 'POST', time) !== createSignature('comics/advanced-search', 'GET', time), 'method 参与签名');
  t.eq(extOfFormat('Jpeg'), 'jpg', 'downloadFormat=Jpeg → .jpg');
  t.eq(extOfFormat('Webp'), 'webp', 'downloadFormat=Webp → .webp');
  t.eq(extOfFormat('Png'), 'png', 'downloadFormat=Png → .png');
  t.eq(pad3(7), '007', '图片序号三位补零');
  t.eq(pad3(1234), '1234', '序号超过三位不截断');

  // ===== 组 2：HTTP 层请求头 / 路径 / 图片地址拼接 =====
  const seen = [];
  const fakeFetch = async function (url, init) {
    seen.push({ url: url, init: init });
    const u = String(url);
    if (u.indexOf('/comics/advanced-search') >= 0) {
      return mockResponse(200, { code: 200, message: 'ok', data: { comics: { total: 1, pages: 1, page: 1, docs: [{ _id: 'x1', title: 'T' }] } } });
    }
    if (u.indexOf('/comics/x1/eps') >= 0) {
      return mockResponse(200, { code: 200, message: 'ok', data: { eps: { total: 1, pages: 1, page: 1, docs: [{ _id: 'ch1', title: '第1話', order: 1 }] } } });
    }
    if (u.indexOf('/order/1/pages') >= 0) {
      return mockResponse(200, { code: 200, message: 'ok', data: { pages: { total: 1, pages: 1, page: 1, docs: [{ _id: 'p1', media: { path: 'tobeimg/aa/bb/x.jpg', fileServer: 'https://storage-b.picacomic.com' } }] } } });
    }
    return mockResponse(404, 'not found');
  };
  const httpCfg = function () { return { apiBase: 'https://picaapi.picacomic.com', apiKey: PICA_API_KEY, token: 'tok-123', retries: 0, timeoutMs: 3000, appUuid: 'uuid-1' }; };
  const srcHttp = createPicacomicSource({ config: httpCfg, fetchImpl: fakeFetch });
  const searchResp = await srcHttp.search('abc', { page: 2 });
  t.eq(searchResp.total, 1, '搜索解析 data.comics（统一分页 total）');
  t.eq(seen.length, 1, '搜索只发一次请求');
  const req = seen[0];
  t.ok(String(req.url).indexOf('comics/advanced-search?page=2') > 0, '搜索路径带 ?page=2');
  t.eq(req.init.method, 'POST', '搜索用 POST');
  t.eq(req.init.headers['api-key'], PICA_API_KEY, '带 api-key 头');
  t.eq(req.init.headers.nonce, PICA_NONCE, '带 nonce 头');
  t.eq(req.init.headers['app-build-version'], '44', '带 app-build-version 头');
  t.eq(req.init.headers['app-platform'], 'android', '带 app-platform 头');
  t.ok(/^okhttp\//.test(req.init.headers['User-Agent']), 'User-Agent 形如 okhttp/x');
  t.eq(req.init.headers.time, String(Math.floor(Date.now() / 1000)), '时间戳字段名是 time 且为当前秒');
  t.ok(req.init.headers.signature === createSignature('comics/advanced-search?page=2', 'POST', req.init.headers.time), 'signature 按含 ?page=2 的完整路径计算');
  t.eq(JSON.parse(req.init.body).keyword, 'abc', 'POST body 带 keyword');
  t.eq(JSON.parse(req.init.body).sort, 'dd', 'POST body 带 sort=dd');
  const chaptersAll = await srcHttp.chaptersAll('x1');
  t.eq(chaptersAll.length, 1, 'chaptersAll 解析 data.eps.docs');
  t.eq(chaptersAll[0].chapterTitle, '第1話', '章节映射到统一 Chapter（chapterTitle/order）');
  const pageList = await srcHttp.pagesAll('x1', 1);
  t.eq(pageList[0].url, 'https://storage-b.picacomic.com/static/tobeimg/aa/bb/x.jpg', '图片地址 = fileServer + /static/ + path');
  t.eq(pageList[0].index, 1, 'pagesAll 的 index 从 1 开始');
  t.eq(imageUrlOf({ path: 'a\\b/c.jpg', fileServer: 'https://s.test/' }), 'https://s.test/static/a/b/c.jpg', '反斜杠与多余斜杠被规整');
  t.eq(coverUrlOf({ path: 'tobeimg/SIG/rs:fill:300:400:0/g:sm/file.jpg', fileServer: 'https://storage-b.picacomic.com' }), 'https://storage-b.picacomic.com/static/tobeimg/SIG/file.jpg', '封面取 service/signature/最后一节');
  t.eq(seen.length, 3, '四次调用只产生 3 次真实请求（章节只翻一页）');

  // 401 → 中文错误
  const errCfg = function () { return { apiBase: 'https://x.test', apiKey: 'k', token: 't', retries: 0, timeoutMs: 2000 }; };
  const src401 = createPicacomicSource({
    config: errCfg,
    fetchImpl: async function () { return mockResponse(401, { code: 401, error: '1005', message: 'unauthorized' }); }
  });
  /* 业务码必须被区分开：哔咔把 1001/1003/1005 都塞在 HTTP 401/400 里，
     只按状态码翻译会把「签名错」「请求头不合法」统统说成「token 无效」——
     排查时会被这句话带偏（真踩过）。这里逐个钉死。 */
  await t.throwsAsync(async function () { await src401.profile(); }, /鉴权失败[\s\S]*1005|token 无效/, '1005 翻译成鉴权失败（提到 token）');
  const src1001 = createPicacomicSource({
    config: errCfg,
    fetchImpl: async function () { return mockResponse(401, { code: 401, error: '1001', message: 'the format of accept header is invalid' }); }
  });
  await t.throwsAsync(async function () { await src1001.profile(); }, /请求头/, '1001 翻译成请求头问题（不能诬赖 token）');
  const src1003 = createPicacomicSource({
    config: errCfg,
    fetchImpl: async function () { return mockResponse(401, { code: 401, error: '1003', message: 'signature invalid' }); }
  });
  await t.throwsAsync(async function () { await src1003.profile(); }, /签名/, '1003 翻译成签名问题（不能诬赖 token）');
  const srcNoBiz = createPicacomicSource({
    config: errCfg,
    fetchImpl: async function () { return mockResponse(401, 'not json at all'); }
  });
  await t.throwsAsync(async function () { await srcNoBiz.profile(); }, /鉴权失败/, '无业务码的裸 401 仍翻译成鉴权失败');
  const src500 = createPicacomicSource({
    config: errCfg,
    fetchImpl: async function () { return mockResponse(500, 'boom'); }
  });
  await t.throwsAsync(async function () { await src500.comic('a'); }, /哔咔服务端错误 HTTP 500/, '5xx 翻译成中文');

  // 429 重试：第 1 次 429，第 2 次成功
  let attempts = 0;
  const srcRetry = createPicacomicSource({
    config: function () { return { apiBase: 'https://x.test', apiKey: 'k', token: 't', retries: 2, timeoutMs: 2000 }; },
    fetchImpl: async function () {
      attempts++;
      if (attempts === 1) return mockResponse(429, 'slow down');
      return mockResponse(200, { code: 200, message: 'ok', data: { user: { name: 'u' } } });
    }
  });
  const prof = await srcRetry.profile();
  t.eq(attempts, 2, '429 后自动重试并成功');
  t.eq(prof.raw.name, 'u', '重试后拿到 data（统一 Profile.raw = 上游 user）');

  // 单次请求内超时 abort → 中文超时错误
  const srcTimeout = createPicacomicSource({
    config: function () { return { apiBase: 'https://x.test', apiKey: 'k', token: 't', retries: 0, timeoutMs: 120 }; },
    fetchImpl: function (url, init) {
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () { resolve(mockResponse(200, { code: 200, message: 'ok', data: {} })); }, 3000);
        if (init && init.signal) init.signal.addEventListener('abort', function () { clearTimeout(timer); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      });
    }
  });
  await t.throwsAsync(async function () { await srcTimeout.profile(); }, /请求超时/, '超时被 abort 并报中文超时');

  // ===== 组 3：chunked 解码 + 内置隧道 HTTP 客户端（本地回环，不出网） =====
  const chunkedBody = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n';
  const decoded = decodeChunked(Buffer.from(chunkedBody.split('\r\n\r\n').slice(1).join('\r\n\r\n'), 'latin1'));
  t.eq(decoded.toString('utf8'), 'hello world', 'chunked 响应正确解码');

  const server = http.createServer(function (req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url, ua: req.headers['user-agent'], sig: req.headers.signature }));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  const raw = await rawHttpRequest({ baseUrl: 'http://127.0.0.1:' + port, path: '/a/b?c=1', method: 'GET', headers: { 'User-Agent': 'okhttp/3.12.13', signature: 'SIG' }, timeoutMs: 5000 });
  t.eq(raw.status, 200, '内置 HTTP 客户端拿到 200');
  const rawJson = JSON.parse(raw.body.toString('utf8'));
  t.eq(rawJson.path, '/a/b?c=1', '内置客户端保留 query');
  // 本用例验证的是「调用方显式传入的头不被覆盖」，所以期望值就是上面传入的那个。
  // 哔咔要求的 3.8.1 由 api.mjs 的 PICA_USER_AGENT 默认值保证，见下方常量断言。
  t.eq(rawJson.ua, 'okhttp/3.12.13', '调用方显式传入的 User-Agent 被原样带上（不被默认值覆盖）');
  t.eq(rawJson.sig, 'SIG', '内置客户端带上 signature');
  await new Promise(function (r) { server.close(r); });

  // ===== 组 4：目录结构 + 断点续传（用临时目录，全程 mock） =====
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mvdl-'));
  const root = path.join(tmp, 'lib');
  await fsp.mkdir(root, { recursive: true });
  const fake = makeFakeClient({ pages: { 1: 4, 2: 3 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }, { _id: 'c2', title: '第2話', order: 2 }] });
  const cfg1 = makeEngineCfg(root);
  const { createEngine } = await import('../src/modules/download/engine.mjs');
  const saved = [];
  const engine1 = createEngine({
    source: fake, log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return cfg1; },
    store: { save: function (task) { saved.push(task.state); }, remove: function () {} },
    emit: function () {}
  });
  const task1 = await engine1.createTask({
    comicId: 'comic1', title: '测试漫画', author: '作者甲',
    chapters: [
      { chapterId: 'c1', chapterTitle: '第1話', order: 1 },
      { chapterId: 'c2', chapterTitle: '第2話', order: 2 }
    ]
  });
  engine1.enqueue(task1);
  // 等任务结束
  for (let i = 0; i < 200; i++) {
    const v = engine1.get(task1.id);
    if (v.state === 'done' || v.state === 'error') break;
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  const done1 = engine1.get(task1.id);
  t.eq(done1.state, 'done', '任务下载完成');
  t.eq(done1.total, 7, '总图片数 = 4 + 3');
  t.eq(done1.done, 7, '完成图片数 = 7');
  t.eq(done1.chapterCount, 2, '章节数 = 2');

  const comicDir = path.join(root, '测试漫画');
  const meta = await readJson(path.join(comicDir, '元数据.json'));
  t.eq(meta.id, 'comic1', '元数据.json 带 id');
  t.eq(meta.title, '测试漫画', '元数据.json 带 title');
  t.eq(meta.author, '作者甲', '元数据.json 带 author');
  t.eq(meta.pagesCount, 7, '元数据.json pagesCount = 实际图片总数');
  t.deepEq(meta.chapterInfos, [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }, { chapterId: 'c2', chapterTitle: '第2話', order: 2 }], '元数据.json chapterInfos 同构');
  t.eq(meta.chapterCount, 2, '元数据.json chapterCount');
  t.eq(meta.chineseTeam, '汉化组', '元数据.json 带 chineseTeam');
  t.ok(meta.tags.indexOf('标签A') >= 0, '元数据.json 带 tags');
  t.eq(meta.likesCount, 7, '元数据.json likesCount 保留原始数字');
  t.eq(meta.createdAt, '2020-01-01T00:00:00Z', '元数据.json createdAt 原样');
  t.ok(!Object.prototype.hasOwnProperty.call(meta, 'comic_download_dir'), '元数据.json 不写本地路径字段');
  t.ok((await fsp.stat(path.join(comicDir, 'cover.jpg'))).size > 0, 'cover.jpg 已落盘');

  const chDir1 = path.join(comicDir, '1 第1話');
  const chDir2 = path.join(comicDir, '2 第2話');
  const imgs1 = (await fsp.readdir(chDir1)).filter(function (f) { return f.endsWith('.jpg'); }).sort();
  t.deepEq(imgs1, ['001.jpg', '002.jpg', '003.jpg', '004.jpg'], '章节目录内 001.jpg 三位补零命名');
  const chMeta = await readJson(path.join(chDir1, '章节元数据.json'));
  t.deepEq(chMeta, { chapterId: 'c1', chapterTitle: '第1話', order: 1 }, '章节元数据.json 只有三个字段');
  t.ok((await fsp.stat(path.join(chDir2, '003.jpg'))).size > 0, '第二章也完整落盘');
  const leftover = (await fsp.readdir(comicDir)).filter(function (f) { return f.indexOf('.tmp-') >= 0; });
  t.eq(leftover.length, 0, '没有残留临时目录');

  // 断点续传：第二次跑同一个任务，图片数不应增加
  const before = fake.calls.images;
  const engine2 = createEngine({
    source: fake, log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return cfg1; },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const task2 = await engine2.createTask({
    comicId: 'comic1', title: '测试漫画', author: '作者甲',
    chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }, { chapterId: 'c2', chapterTitle: '第2話', order: 2 }]
  });
  engine2.enqueue(task2);
  for (let i = 0; i < 200; i++) {
    const v = engine2.get(task2.id);
    if (v.state === 'done' || v.state === 'error') break;
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  t.eq(fake.calls.images, before, '已完成的章节不重复下载任何图片（断点续传）');
  t.eq(engine2.get(task2.id).state, 'done', '重复任务直接判定完成');

  // ===== 组 5：单图失败 → 死信 + 任务仍继续；只补缺图 =====
  const tmp2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'mvdl2-'));
  const root2 = path.join(tmp2, 'lib');
  await fsp.mkdir(root2, { recursive: true });
  const fakeFail = makeFakeClient({ pages: { 1: 3 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }], failIndexes: [2] });
  const cfg2 = makeEngineCfg(root2, { retryTimes: 1 });
  const engine3 = createEngine({
    source: fakeFail, log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return cfg2; },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const task3 = await engine3.createTask({ comicId: 'comic1', title: '失败漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engine3.enqueue(task3);
  for (let i = 0; i < 200; i++) {
    const v = engine3.get(task3.id);
    if (v.state === 'done' || v.state === 'error') break;
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  const done3 = engine3.get(task3.id);
  t.eq(done3.state, 'error', '有缺图时任务标记 error 而不是 done');
  t.eq(done3.failed, 1, '失败图片计入死信数');
  t.eq(done3.done, 2, '成功的图片仍然保留（2/3）');
  t.ok(String(done3.error).indexOf('缺') >= 0, '错误信息可读（提到缺图）');
  const dir3 = path.join(root2, '失败漫画', '1 第1話');
  const kept = (await fsp.readdir(dir3)).filter(function (f2) { return f2.endsWith('.jpg'); }).sort();
  t.deepEq(kept, ['001.jpg', '003.jpg'], '缺图模式下已下好的图片复制到正式目录留底');
  // 目录里可能混有文件级临时残渣（例如 元数据.json.tmp-*），这里只数「章节临时目录」，
  // 并把残渣名打进断言消息，避免失败时只有「实际=2」这种无法定位的提示。
  const tmpEntries = (await fsp.readdir(path.join(root2, '失败漫画'))).filter(function (f2) { return f2.indexOf('.tmp-') >= 0; });
  const tmpDirs = [];
  const tmpStrays = [];
  for (const name of tmpEntries) {
    let isDir = false;
    try { isDir = (await fsp.stat(path.join(root2, '失败漫画', name))).isDirectory(); } catch (e) { isDir = false; }
    if (isDir) tmpDirs.push(name); else tmpStrays.push(name);
  }
  t.eq(tmpDirs.length, 1, '缺图时保留章节临时目录（下次续传直接补缺）');
  t.eq(tmpStrays.length, 0, '不留任何文件级 .tmp- 残渣' + (tmpStrays.length ? '：' + tmpStrays.join('、') : ''));
  const tmpKept = (await fsp.readdir(path.join(root2, '失败漫画', tmpDirs[0]))).filter(function (f2) { return f2.endsWith('.jpg'); }).sort();
  t.deepEq(tmpKept, ['001.jpg', '003.jpg'], '临时目录里同样保留已下好的图片');

  // 只补缺图：把 002 修好后继续，只下那 1 张
  // 失败后：已下好的图片被挪到正式目录保留
  fakeFail.calls.images = 0;
  fakeFail.calls.downloaded = [];
  const engine4 = createEngine({
    source: fakeFail, log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return cfg2; },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const task4 = await engine4.createTask({ comicId: 'comic1', title: '失败漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engine4.enqueue(task4);
  for (let i = 0; i < 200; i++) {
    const v = engine4.get(task4.id);
    if (v.state === 'done' || v.state === 'error') break;
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  const refetched = fakeFail.calls.downloaded.filter(function (u) { return u.indexOf('/1.jpg') >= 0 || u.indexOf('/3.jpg') >= 0; });
  t.eq(refetched.length, 0, '续传不重下已存在的图片（001/003 未被再次请求）');
  t.ok(fakeFail.calls.downloaded.every(function (u) { return u.indexOf('/2.jpg') >= 0; }), '续传只请求缺失的第 2 张');
  t.eq(engine4.get(task4.id).state, 'error', '仍有坏图时仍是 error');

  // 正式目录与临时目录各有一半图片时，续传要合并两边再原子替换
  const tmpMerge = await fsp.mkdtemp(path.join(os.tmpdir(), 'mvdl-merge-'));
  const rootM = path.join(tmpMerge, 'lib');
  const chM = path.join(rootM, '合并漫画', '1 第1話');
  await fsp.mkdir(chM + '.tmp-' + process.pid, { recursive: true });
  await fsp.mkdir(chM, { recursive: true });
  await fsp.writeFile(path.join(chM + '.tmp-' + process.pid, '001.jpg'), fakeJpeg(1024));
  await fsp.writeFile(path.join(chM + '.tmp-' + process.pid, '003.jpg'), fakeJpeg(1024));
  await fsp.writeFile(path.join(chM, '002.jpg'), fakeJpeg(1024));
  const fakeMerge = makeFakeClient({ pages: { 1: 4 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }] });
  const engineM = createEngine({
    source: fakeMerge, log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return makeEngineCfg(rootM, { imgConcurrency: 2, retryTimes: 1 }); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const taskM = await engineM.createTask({ comicId: 'comic1', title: '合并漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineM.enqueue(taskM);
  for (let i = 0; i < 200; i++) {
    const v = engineM.get(taskM.id);
    if (v.state === 'done' || v.state === 'error') break;
    await new Promise(function (r2) { setTimeout(r2, 50); });
  }
  const mergedFiles = (await fsp.readdir(chM)).filter(function (f2) { return f2.endsWith('.jpg'); }).sort();
  t.deepEq(mergedFiles, ['001.jpg', '002.jpg', '003.jpg', '004.jpg'], '续传合并临时目录 + 正式目录里的全部图片');
  const mergeImgs = fakeMerge.calls.downloaded.filter(function (u) { return u.indexOf('/static/') >= 0; });
  t.eq(mergeImgs.length, 1, '只下载真正缺失的那 1 张（封面另算）');
  t.ok(mergeImgs[0].indexOf('/4.jpg') >= 0, '缺的是第 4 张');
  await rmWithRetry(tmpMerge);

  // ===== 组 6：扩展名映射（GIF 保留、config 决定普通图） =====
  t.eq(sniffImageExt(fakeJpeg(1024)), 'jpg', '魔数识别 JPEG');
  t.eq(sniffImageExt(fakePng(16)), 'png', '魔数识别 PNG');
  t.eq(sniffImageExt(fakeGif(16)), 'gif', '魔数识别 GIF');
  t.eq(extForImage(fakeGif(16), 'jpg'), 'gif', 'GIF 永远保存为 gif（零依赖不能转码）');
  t.eq(extForImage(fakePng(16), 'webp'), 'webp', '普通图跟随 downloadFormat=Webp');
  t.eq(extForImage(fakePng(16), 'png'), 'png', '普通图跟随 downloadFormat=Png');

  const tmp3 = await fsp.mkdtemp(path.join(os.tmpdir(), 'mvdl3-'));
  const root3 = path.join(tmp3, 'lib');
  await fsp.mkdir(root3, { recursive: true });
  const fakeMix = makeFakeClient({ pages: { 1: 3 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }], imageKind: { 1: 'png', 2: 'gif', 3: 'jpg' } });
  const cfg3 = makeEngineCfg(root3, { downloadFormat: 'Png' });
  const engine5 = createEngine({
    source: fakeMix, log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return cfg3; }, store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const task5 = await engine5.createTask({ comicId: 'comic1', title: '混合格式', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engine5.enqueue(task5);
  for (let i = 0; i < 200; i++) {
    const v = engine5.get(task5.id);
    if (v.state === 'done' || v.state === 'error') break;
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  const mixFiles = (await fsp.readdir(path.join(root3, '混合格式', '1 第1話'))).filter(function (f) { return f.indexOf('.json') < 0; }).sort();
  t.deepEq(mixFiles, ['001.png', '002.gif', '003.png'], '扩展名：普通图按配置、GIF 单独保留');
  t.eq(engine5.get(task5.id).state, 'done', '混合格式任务完成');

  // 空图片内容 → 不算成功
  const tmp4 = await fsp.mkdtemp(path.join(os.tmpdir(), 'mvdl4-'));
  const root4 = path.join(tmp4, 'lib');
  await fsp.mkdir(root4, { recursive: true });
  const fakeEmpty = makeFakeClient({ pages: { 1: 2 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }], imageKind: { 1: 'empty' } });
  const engine6 = createEngine({
    source: fakeEmpty, log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return makeEngineCfg(root4, { retryTimes: 1 }); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const task6 = await engine6.createTask({ comicId: 'comic1', title: '空图漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engine6.enqueue(task6);
  for (let i = 0; i < 200; i++) {
    const v = engine6.get(task6.id);
    if (v.state === 'done' || v.state === 'error') break;
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  t.eq(engine6.get(task6.id).state, 'error', '空图片内容视为失败');
  t.eq(engine6.get(task6.id).failed, 1, '空图片计入死信');

  // ===== 组 7：库扫描 / 已在库识别 / 大小校验 =====
  const idx = await indexLibrary(root);
  t.eq(idx.byId.size, 1, 'indexLibrary 按 元数据.json 的 id 建索引');
  t.ok(idx.byId.has('comic1'), '索引里有 comic1');
  t.ok(idx.titles.has('测试漫画'), '索引里有目录名');
  t.eq((await chapterStats(chDir1)).count, 4, 'chapterStats 统计图片数');
  t.eq(await chapterDone(chDir1), true, '有章节元数据的目录判定为已完成');
  const emptyDir = path.join(root, '空目录漫画');
  await fsp.mkdir(path.join(emptyDir, '1 第1話'), { recursive: true });
  t.eq(await chapterDone(path.join(emptyDir, '1 第1話')), false, '空目录不算已完成');

  // 大小 0 的图片视为不存在（断点续传会重下）
  const zeroDir = path.join(tmp, 'zero');
  await fsp.mkdir(zeroDir, { recursive: true });
  await fsp.writeFile(path.join(zeroDir, '001.jpg'), Buffer.alloc(0));
  t.eq(await hasImage(zeroDir, 1, 'jpg'), false, '大小为 0 的图片不算已下载');
  await fsp.writeFile(path.join(zeroDir, '001.jpg'), fakeJpeg(20));
  t.eq(await hasImage(zeroDir, 1, 'jpg'), true, '有内容的图片算已下载');
  await fsp.writeFile(path.join(zeroDir, '002.gif'), fakeGif(20));
  t.eq(await hasImage(zeroDir, 2, 'jpg'), true, '扩展名不同也能识别（gif 保留）');

  // swapDir 原子替换
  const a = path.join(tmp, 'swap-a');
  const b = path.join(tmp, 'swap-b');
  await fsp.mkdir(a, { recursive: true });
  await fsp.mkdir(b, { recursive: true });
  await fsp.writeFile(path.join(a, 'old.txt'), 'old');
  await fsp.writeFile(path.join(b, 'new.txt'), 'new');
  await swapDir(b, a);
  t.deepEq((await fsp.readdir(a)).sort(), ['new.txt'], 'swapDir 用新目录替换旧目录');
  await new Promise(function (r) { setTimeout(r, 120); });

  t.eq(isInside(root, path.join(root, 'x')), true, 'isInside 允许 root 内路径');
  t.eq(isInside(root, path.join(tmp, 'outside')), false, 'isInside 拒绝越界路径');
  t.eq(await chapterStats(path.join(tmp, 'not-exist')).then(function (s) { return s.count; }), 0, '不存在的目录返回 0 而不是抛错');

  // ===== 组 8：限速器 / 速度计 / 并发上限 / 暂停取消 =====
  const limiter = createLimiter(60);
  const N = 4;
  const limT0 = Date.now();
  for (let i = 0; i < N; i++) await limiter();
  const total = Date.now() - limT0;
  // 不能断言「相邻两次观测间隔 >= 60ms」：acquire 返回后到 Date.now() 之间可能被调度延迟，
  // 观测间隔会变成 gap - 延迟（实测出现过 38ms）。限速器真正保证的是**预约位**相隔 gap，
  // 因此 N 次取号的总耗时下界 (N-1)*gap 不受调度噪声影响；而限速器失效时该值接近 0。
  t.ok(total >= (N - 1) * 60 - 5, 'createLimiter ' + N + ' 次取号总耗时 >= ' + ((N - 1) * 60) + 'ms（实测 ' + total + 'ms）');

  const speedo = createSpeedometer();
  speedo.add(1000);
  await new Promise(function (r) { setTimeout(r, 2100); });
  speedo.add(1000);
  t.ok(speedo.speed() > 0, '速度计能算出正速度');

  // 全局并发任务数 <= 2
  const tmp5 = await fsp.mkdtemp(path.join(os.tmpdir(), 'mvdl5-'));
  const root5 = path.join(tmp5, 'lib');
  await fsp.mkdir(root5, { recursive: true });
  const fakeSlow = makeFakeClient({ pages: { 1: 3 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }], slowMs: 60 });
  let concurrentSeen = 0;
  const engine7 = createEngine({
    source: fakeSlow, log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return makeEngineCfg(root5, { imgConcurrency: 2, chapterConcurrency: 1 }); },
    store: { save: function () {}, remove: function () {} },
    emit: function () { concurrentSeen = Math.max(concurrentSeen, engine7.status().runningTasks); }
  });
  const t7a = await engine7.createTask({ comicId: 'comic1', title: '并发A', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  const t7b = await engine7.createTask({ comicId: 'comic1', title: '并发B', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  const t7c = await engine7.createTask({ comicId: 'comic1', title: '并发C', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engine7.enqueue(t7a); engine7.enqueue(t7b); engine7.enqueue(t7c);
  for (let i = 0; i < 400; i++) {
    const all = [t7a, t7b, t7c].map(function (x) { return engine7.get(x.id).state; });
    if (all.every(function (s) { return s === 'done' || s === 'error' || s === 'canceled'; })) break;
    await new Promise(function (r) { setTimeout(r, 40); });
  }
  t.ok(concurrentSeen <= 2, '同时在跑的任务数不超过 2（实测 ' + concurrentSeen + '）');
  t.eq(engine7.status().totalTasks, 3, '三个任务都在队列里');

  // 取消：立刻停止取新任务
  const tmp6 = await fsp.mkdtemp(path.join(os.tmpdir(), 'mvdl6-'));
  const root6 = path.join(tmp6, 'lib');
  await fsp.mkdir(root6, { recursive: true });
  const fakeCancel = makeFakeClient({ pages: { 1: 8 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }], slowMs: 120 });
  const engine8 = createEngine({
    source: fakeCancel, log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return makeEngineCfg(root6, { imgConcurrency: 1, retryTimes: 1 }); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const task8 = await engine8.createTask({ comicId: 'comic1', title: '取消漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engine8.enqueue(task8);
  await new Promise(function (r) { setTimeout(r, 200); });
  await engine8.cancel(task8.id);
  const imagesAtCancel = fakeCancel.calls.images;
  t.eq(engine8.get(task8.id).state, 'canceled', '取消后任务状态为 canceled');
  await new Promise(function (r) { setTimeout(r, 500); });
  t.ok(fakeCancel.calls.images <= imagesAtCancel + 1, '取消后不再发起新的图片下载（在途最多收尾一张）');
  const cancelDir = path.join(root6, '取消漫画');
  let cancelLeftover = [];
  try { cancelLeftover = (await fsp.readdir(cancelDir)).filter(function (f) { return f.indexOf('.part-') >= 0; }); } catch (e) { cancelLeftover = []; }
  t.eq(cancelLeftover.length, 0, '取消后没有半截 .part 文件');

  // 暂停 / 继续 / 删除
  const tmp7 = await fsp.mkdtemp(path.join(os.tmpdir(), 'mvdl7-'));
  const root7 = path.join(tmp7, 'lib');
  await fsp.mkdir(root7, { recursive: true });
  const fakePause = makeFakeClient({ pages: { 1: 5 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }], slowMs: 60 });
  const engine9 = createEngine({
    source: fakePause, log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return makeEngineCfg(root7, { imgConcurrency: 1, retryTimes: 1 }); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const task9 = await engine9.createTask({ comicId: 'comic1', title: '暂停漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engine9.enqueue(task9);
  await new Promise(function (r) { setTimeout(r, 150); });
  await engine9.pause(task9.id);
  t.eq(engine9.get(task9.id).state, 'paused', '暂停生效');
  await new Promise(function (r) { setTimeout(r, 400); });
  const pausedImages = fakePause.calls.images;
  await new Promise(function (r) { setTimeout(r, 300); });
  // 与取消用例同一口径：暂停语义是「停止取新图，等在途请求自然结束」，
  // 所以采样窗口里最多再落一张（imgConcurrency=1）。若暂停真的失效，剩下 4 张会继续下，断言照样抓得住；
  // 不用严格相等是因为高负载下那唯一一张在途图片可能刚好跨过采样点（曾导致整轮回归偶发翻红）。
  t.ok(fakePause.calls.images <= pausedImages + 1, '暂停后不再继续下载图片（在途最多收尾一张，实测 ' + (fakePause.calls.images - pausedImages) + ' 张）');
  await engine9.resume(task9.id);
  // 注意：resume 之后任务先回到 queued，必须等到真正跑完再断言
  for (let i = 0; i < 400; i++) {
    const s = engine9.get(task9.id).state;
    if (s === 'done' || s === 'error') break;
    await new Promise(function (r) { setTimeout(r, 40); });
  }
  await new Promise(function (r) { setTimeout(r, 150); });
  t.eq(engine9.get(task9.id).state, 'done', '继续后补全并完成（断点续传）');
  const resumedFiles = (await fsp.readdir(path.join(root7, '暂停漫画', '1 第1話'))).filter(function (f) { return f.endsWith('.jpg'); });
  t.eq(resumedFiles.length, 5, '继续后章节图片齐全');
  await engine9.remove(task9.id);
  t.eq(engine9.get(task9.id), null, '删除任务后查不到');
  await t.throwsAsync(async function () { await engine9.pause(task9.id); }, /任务不存在/, '操作不存在的任务报中文错误');

  // ===== 组 9：任务清单/持久化/重启恢复 =====
  const tmp8 = await fsp.mkdtemp(path.join(os.tmpdir(), 'mvdl8-'));
  const root8 = path.join(tmp8, 'lib');
  await fsp.mkdir(root8, { recursive: true });
  const persisted = { tasks: [] };
  const engineA = createEngine({
    source: makeFakeClient({ pages: { 1: 2 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }], slowMs: 200 }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return makeEngineCfg(root8); },
    store: {
      save: function (task) {
        const i = persisted.tasks.findIndex(function (x) { return x.id === task.id; });
        const copy = JSON.parse(JSON.stringify(task));
        if (i < 0) persisted.tasks.push(copy); else persisted.tasks[i] = copy;
      },
      remove: function (id) { persisted.tasks = persisted.tasks.filter(function (x) { return x.id !== id; }); }
    },
    emit: function () {}
  });
  const taskA = await engineA.createTask({ comicId: 'c1', title: '重启漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineA.enqueue(taskA);
  await new Promise(function (r) { setTimeout(r, 120); });
  t.ok(persisted.tasks.length >= 1, '任务状态被持久化');
  const snapshot = persisted.tasks[0];
  t.ok(['queued', 'running'].indexOf(snapshot.state) >= 0, '快照里状态是 queued/running');

  // 模拟重启：running/queued → paused
  const engineB = createEngine({
    source: makeFakeClient({ pages: { 1: 2 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }] }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: function () { return makeEngineCfg(root8); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  engineB.hydrateAll(persisted.tasks);
  const revived = engineB.get(taskA.id);
  t.eq(revived.state, 'paused', '重启后未完成任务被标记为 paused');
  t.ok(String(revived.error).indexOf('重启') >= 0 || String(revived.error).indexOf('继续') >= 0, '重启后给出可续传的提示');
  const listA = engineB.list();
  t.eq(listA.length, 1, 'list() 返回所有任务');
  t.ok(typeof listA[0].percent === 'number', 'list() 视图带 percent');
  engineA.dispose();
  engineB.dispose();

  // ===== 组 10：纯函数（元数据构造 / 时间戳） =====
  const built = buildComicMetadata({ id: 'x', title: 't', author: 'a', thumbs: 1 }, [
    { chapterId: 'c2', chapterTitle: '二', order: 2 },
    { chapterId: 'c1', chapterTitle: '一', order: 1 }
  ], { format: 'reference' });
  t.deepEq(built.chapterInfos.map(function (c2) { return c2.order; }), [1, 2], '元数据章节按 order 排序');
  t.eq(built.chapterCount, 2, '缺 epsCount 时用章节数兜底');
  t.eq(buildChapterMetadata({ _id: 'c9', title: '九', order: 9 }).chapterId, 'c9', '章节元数据兼容 _id/title');
  t.eq(buildChapterMetadata({ _id: 'c9', title: '九', order: 9 }).chapterTitle, '九', '章节元数据取 title');

  // 写盘异常里不允许出现未处理 rejection：验证原子写
  const aj = path.join(tmp, 'a.json');
  await atomicWriteJson(aj, { k: 1 });
  t.eq((await readJson(aj)).k, 1, 'atomicWriteJson 落盘正确');
  t.ok(!(await fsp.readdir(tmp)).some(function (f) { return f.indexOf('a.json.tmp-') === 0; }), '原子写不留下临时文件');

  // ===== 组 11：下载源注册表（契约） =====
  const sources = await import('../src/modules/download/sources/index.mjs');
  const { notSupported } = await import('../src/modules/download/sources/types.mjs');
  const picacomic = sources.get('picacomic');
  t.eq(picacomic.meta.id, 'picacomic', 'get(picacomic) 拿到哔咔适配器');
  t.eq(picacomic.meta.name, '哔咔漫画', '适配器带中文显示名');
  t.eq(sources.REQUIRED_CAPABILITIES.length, 8, '必备能力共 8 项');
  const capMissing = [];
  for (const cap of sources.REQUIRED_CAPABILITIES) {
    if (picacomic.meta.capabilities.indexOf(cap) < 0) capMissing.push(cap + '(未声明)');
    if (typeof picacomic[cap] !== 'function') capMissing.push(cap + '(未实现)');
  }
  t.eq(capMissing.length, 0, '8 个必备能力都已声明且已实现' + (capMissing.length ? '：缺 ' + capMissing.join('、') : ''));
  t.eq(sources.get().meta.id, 'picacomic', '省略 sourceId 时返回默认源');
  let unknownMsg = '';
  try { sources.get('nope'); } catch (err) { unknownMsg = err && err.message ? err.message : String(err); }
  t.ok(/未知的下载源：nope/.test(unknownMsg) && /picacomic/.test(unknownMsg), 'get 未知源抛中文错误并列出已注册源：' + unknownMsg);
  t.ok(sources.has('picacomic') && !sources.has('nope'), 'has() 区分已注册与未注册');

  // ===== 组 12：路由层接适配器（真 HTTP + 假 transport，全程不出网） =====
  const routeTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mvdl-route-'));
  const routeRoot = path.join(routeTmp, 'lib');
  await fsp.mkdir(routeRoot, { recursive: true });
  const prevDataDir = process.env.MV_DATA_DIR;
  process.env.MV_DATA_DIR = path.join(routeTmp, 'data');
  await fsp.mkdir(process.env.MV_DATA_DIR, { recursive: true });

  /** 假 transport 的应答：按路径回一份合法的哔咔响应（不联网）。 */
  function fakeReply(req) {
    const p = String((req && req.path) || '');
    if (p.indexOf('comics/advanced-search') >= 0) {
      return { status: 200, text: JSON.stringify({ code: 200, message: 'ok', data: { comics: { total: 1, pages: 1, page: 1, docs: [{ _id: 'x9', title: '上游漫画', author: 'A', epsCount: 2, likesCount: 3, tags: ['t'], categories: ['c'], thumb: { path: 'a/b/c.jpg', fileServer: 'https://img.test' } }] } } }) };
    }
    if (p.indexOf('/eps') >= 0) {
      return { status: 200, text: JSON.stringify({ code: 200, message: 'ok', data: { eps: { total: 1, pages: 1, page: 1, docs: [{ _id: 'ch1', title: '第1話', order: 1 }] } } }) };
    }
    return { status: 200, text: JSON.stringify({ code: 200, message: 'ok', data: {} }) };
  }

  const routeSeen = [];
  const routeTransport = async function (req) { routeSeen.push(req); return fakeReply(req); };
  const { createApp } = await import('../src/core/http.mjs');
  const { createLogger } = await import('../src/core/log.mjs');
  const app = createApp({ log: createLogger('dlroute', 'error'), accessLog: false });
  const routeCfg = {
    downloadRoot: routeRoot, libraryRoot: routeRoot, libraryRoots: [], logLevel: 'error',
    picacomic: { apiBase: 'https://picaapi.picacomic.com', apiKey: PICA_API_KEY, token: 'tok-route', retries: 0, timeoutMs: 3000, dirFmt: '{comic_title}/{order} {chapter_title}', downloadFormat: 'Jpeg' }
  };
  const routeCtx = {
    config: routeCfg,
    log: createLogger('dlroute', 'error'),
    projectRoot: path.resolve(import.meta.dirname, '..'),
    dataDir: process.env.MV_DATA_DIR,
    publicDir: path.resolve(import.meta.dirname, '../public'),
    moduleId: 'download',
    moduleMeta: {},
    reloadConfig: async function () { return routeCfg; },
    saveConfig: async function (patch) { Object.assign(routeCfg, patch || {}); return routeCfg; }
  };

  let routeServer = null;
  try {
    // 用假 transport 重建默认源实例：路由层拿到的适配器就走这条假链路
    sources.registerFactory('picacomic', function (options) {
      return createPicacomicSource(Object.assign({}, options, { transport: routeTransport }));
    });
    const downloadMod = await import('../src/modules/download/index.mjs');
    await downloadMod.register(app, routeCtx);
    routeServer = app.createServer();
    await new Promise(function (res, rej) { routeServer.once('error', rej); routeServer.listen(0, '127.0.0.1', res); });
    const routeBase = 'http://127.0.0.1:' + routeServer.address().port;
    async function api(p, opts) {
      const o2 = opts || {};
      const init = { method: o2.method || 'GET', headers: {} };
      if (o2.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o2.body); }
      const res = await fetch(routeBase + p, init);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
      return { status: res.status, data: data };
    }

    routeSeen.length = 0;
    const searchRes = await api('/api/download/search?q=abc&page=2');
    t.eq(searchRes.status, 200, '搜索路由接适配器后依然 200');
    t.eq(searchRes.data.ok, true, '搜索响应 ok:true');
    t.eq(searchRes.data.items.length, 1, '搜索返回 1 条');
    t.eq(searchRes.data.items[0].id, 'x9', '结果 id 来自适配器统一 Comic');
    t.eq(searchRes.data.items[0].title, '上游漫画', '结果标题来自统一 Comic');
    t.eq(searchRes.data.items[0].chapterCount, 2, 'chapterCount 由统一字段 chapterCount 映射');
    t.eq(searchRes.data.items[0].likes, 3, 'likes 由统一字段 likes 映射');
    t.ok(String(searchRes.data.items[0].cover).indexOf('/api/download/cover?path=') === 0, '封面仍转成本地封面代理地址');
    t.eq(routeSeen.length, 1, '搜索只向上游发一次请求（不多发详情/章节）');

    // 旧实现（改造前的直接客户端调用）作为对照基准：同一个假 transport 下逐字比对
    const legacySeen = [];
    const legacyClient = createPicaClient({
      config: function () { return routeCfg.picacomic; },
      transport: async function (req) { legacySeen.push(req); return fakeReply(req); }
    });
    await legacyClient.raw('POST', 'comics/advanced-search?page=2', { keyword: 'abc', sort: 'dd', categories: [] });
    const got = routeSeen[0];
    const want = legacySeen[0];
    const volatile = function (h) { const c2 = Object.assign({}, h); delete c2.time; delete c2.signature; return c2; };
    t.eq(got.method, want.method, '路由发出的请求方法与改造前逐字一致');
    t.eq(got.path, want.path, '路由发出的请求路径与改造前逐字一致');
    t.eq(got.baseUrl, want.baseUrl, 'baseUrl 与改造前逐字一致');
    t.eq(got.body, want.body, '请求体与改造前逐字一致');
    t.deepEq(volatile(got.headers), volatile(want.headers), '请求头（除 time/signature）与改造前逐字一致');
    t.eq(got.path, 'comics/advanced-search?page=2', '搜索路径带 ?page=2');
    t.deepEq(JSON.parse(got.body), { keyword: 'abc', sort: 'dd', categories: [] }, '搜索请求体 = {keyword,sort:dd,categories:[]}');
    t.eq(got.headers.authorization, 'tok-route', '带 authorization token');
    t.eq(got.headers.signature, createSignature('comics/advanced-search?page=2', 'POST', got.headers.time), '签名按含 query 的路径计算');

    // 未知下载源：400 + 中文，不是 500
    const unknownRes = await api('/api/download/search?q=a&sourceId=nope');
    t.eq(unknownRes.status, 400, '未知 sourceId 返回 400（不是 500）');
    t.eq(unknownRes.data.ok, false, '未知 sourceId 响应 ok:false');
    t.ok(/未知的下载源/.test(String(unknownRes.data.error)), '未知源错误是中文：' + unknownRes.data.error);

    // 能力缺失：声明了能力清单但没有 search → requireCapability 抛 NotSupportedError → 400 中文
    sources.register({ meta: { id: 'stub', name: '缺能力源', capabilities: ['comic'] }, async comic() { return {}; } });
    const stubRes = await api('/api/download/search?q=a&sourceId=stub');
    t.eq(stubRes.status, 400, '源未声明 search 能力时返回 400（不是 500）');
    t.eq(stubRes.data.ok, false, '能力缺失响应 ok:false');
    t.ok(/不支持/.test(String(stubRes.data.error)), '能力缺失错误是中文：' + stubRes.data.error);

    // 适配器内部抛 NotSupportedError 也要降级成 400 中文
    sources.register({ meta: { id: 'halfstub', name: '半成品源', capabilities: ['search'] }, async search() { throw notSupported('search', { sourceId: 'halfstub', detail: '上游未开放搜索' }); } });
    const halfRes = await api('/api/download/search?q=a&sourceId=halfstub');
    t.eq(halfRes.status, 400, 'NotSupportedError 降级成 400 而不是 500');
    t.eq(halfRes.data.ok, false, 'NotSupportedError 响应 ok:false');
    t.ok(/不支持/.test(String(halfRes.data.error)) && /上游未开放搜索/.test(String(halfRes.data.error)), '降级消息保留中文细节：' + halfRes.data.error);

    // 真·换源：另一个已注册的源被真正调用，且完全不打哔咔上游
    const seenBeforeFake = routeSeen.length;
    sources.register({
      meta: { id: 'fakesrc', name: '假源', capabilities: ['search'] },
      async search(keyword) {
        return { page: 1, pages: 1, total: 1, docs: [{ id: 'fx1', title: '来自假源 ' + keyword, author: '假作者', cover: '', tags: [], categories: [], description: '', chineseTeam: '', pagesCount: 0, chapterCount: 1, likes: 0, views: 0, finished: false, createdAt: null, updatedAt: null, raw: {} }] };
      }
    });
    const fakeRes = await api('/api/download/search?q=zz&sourceId=fakesrc');
    t.eq(fakeRes.status, 200, '指定 sourceId 时该源被真正调用');
    t.eq(fakeRes.data.items[0].title, '来自假源 zz', '响应内容来自被指定的源');
    t.eq(routeSeen.length, seenBeforeFake, '用别的源时不会去打哔咔上游');

    // body 里的 sourceId 同样生效（POST 路由）
    const viaBody = await api('/api/download/update-check', { method: 'POST', body: { sourceId: 'nope' } });
    t.eq(viaBody.status, 400, 'body 里的 sourceId 同样被识别（未知源 → 400）');
    t.ok(/未知的下载源/.test(String(viaBody.data.error)), 'body 传来的未知源也是中文错误：' + viaBody.data.error);

    await downloadMod.dispose();
  } finally {
    if (routeServer) await new Promise(function (r) { routeServer.close(r); });
    sources.unregister('stub');
    sources.unregister('halfstub');
    sources.unregister('fakesrc');
    // 还原内置工厂：后续用例/其它测试文件必须拿回真哔咔适配器
    sources.registerFactory('picacomic', createPicacomicSource);
    const authMod = await import('../src/modules/download/auth.mjs');
    authMod.resetStores();
    if (prevDataDir === undefined) delete process.env.MV_DATA_DIR;
    else process.env.MV_DATA_DIR = prevDataDir;
  }

  // ===== 组 13：任务记 sourceId → 引擎按任务换源 =====
  const altTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mvdl-alt-'));
  const altRoot = path.join(altTmp, 'lib');
  await fsp.mkdir(altRoot, { recursive: true });
  const altCalls = { comic: 0, images: 0 };
  const altSource = {
    meta: { id: 'alt', name: '备用源', capabilities: ['comic', 'chapters', 'pages', 'download'] },
    async comic(comicId) {
      altCalls.comic++;
      return { id: String(comicId), title: '备用源漫画', author: '', cover: '', tags: [], categories: [], description: '', chineseTeam: '', pagesCount: 0, chapterCount: 1, likes: 0, views: 0, finished: false, createdAt: null, updatedAt: null, raw: {} };
    },
    async pagesAll(comicId, order) { return [{ index: 1, url: 'https://alt.test/1.jpg', raw: {} }]; },
    async download(url) { altCalls.images++; return { buffer: fakeJpeg(1024), contentType: 'image/jpeg' }; }
  };
  function getSourceOf(id) { if (id === 'alt') return altSource; throw new Error('未知的下载源：' + id); }
  const quietLog = { info: function () {}, warn: function () {}, error: function () {}, debug: function () {} };
  const defaultFake = makeFakeClient({ pages: { 1: 1 } });
  const engineAlt = createEngine({
    source: defaultFake, getSource: getSourceOf, log: quietLog,
    getConfig: function () { return makeEngineCfg(altRoot); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const taskAlt = await engineAlt.createTask({ comicId: 'c-alt', sourceId: 'alt', title: '换源漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineAlt.enqueue(taskAlt);
  for (let i = 0; i < 200; i++) {
    const v = engineAlt.get(taskAlt.id);
    if (v.state === 'done' || v.state === 'error') break;
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  t.eq(engineAlt.get(taskAlt.id).state, 'done', '任务记录的 sourceId 生效：换源后仍能跑完');
  t.eq(altCalls.comic, 1, '详情走 alt 源');
  t.eq(altCalls.images, 1, '图片下载走 alt 源');
  t.eq(defaultFake.calls.comic + defaultFake.calls.images + defaultFake.calls.pages, 0, '默认源完全没被碰到');

  const engineGone = createEngine({
    source: defaultFake, getSource: getSourceOf, log: quietLog,
    getConfig: function () { return makeEngineCfg(altRoot); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const taskGone = await engineGone.createTask({ comicId: 'comic1', sourceId: 'gone', title: '退回默认源', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineGone.enqueue(taskGone);
  for (let i = 0; i < 200; i++) {
    const v = engineGone.get(taskGone.id);
    if (v.state === 'done' || v.state === 'error') break;
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  t.eq(engineGone.get(taskGone.id).state, 'done', 'sourceId 不可用时退回默认源并把任务跑完');
  t.ok(defaultFake.calls.comic >= 1 && defaultFake.calls.images >= 1, '退回默认源后确实用了默认源');
  const goneLogs = engineGone.get(taskGone.id).logs.map(function (l) { return l.message; }).join(' ');
  t.ok(goneLogs.indexOf('已不可用') >= 0, '任务日志里写明了换源原因：' + goneLogs.slice(0, 80));

  await rmWithRetry(altTmp);
  await rmWithRetry(routeTmp);

  // ===== 组 14：逐页台账（真·断点续传） =====
  const ledgerRoot = path.join(ledgerDataDir, 'download', 'ledger');

  // --- 14.1 台账基础：路径 / 写读往返 / 单章 / 汇总 / 损坏不炸 / remove / prune ---
  const ledgerId = 'dl-ledger-basic';
  t.eq(ledger.ledgerPath(ledgerId), path.join(ledgerRoot, ledgerId + '.json'), '台账路径 = data/download/ledger/<taskId>.json');
  const emptyDoc = await ledger.read('dl-ledger-never-written', { fresh: true });
  t.deepEq(Object.keys(emptyDoc.chapters), [], '读不存在的台账返回空台账（不抛异常）');
  t.eq(emptyDoc.version, 1, '空台账版本号为 1');
  await ledger.recordPage(ledgerId, { comicId: 'comic-led', chapterOrder: 1, title: '第1話', total: 3, index: 1, file: pageFile(path.join(ledgerDataDir, 'staged'), 1), bytes: 111, url: 'u1' });
  await ledger.recordPage(ledgerId, { comicId: 'comic-led', chapterOrder: 1, title: '第1話', total: 3, index: 2, file: pageFile(path.join(ledgerDataDir, 'staged'), 2), bytes: 222, url: 'u2' });
  const doc1 = await ledger.read(ledgerId, { fresh: true });
  t.eq(doc1.taskId, ledgerId, '台账记下 taskId');
  t.eq(doc1.comicId, 'comic-led', '台账记下 comicId');
  t.eq(doc1.chapters['1'].title, '第1話', '台账记下章节标题');
  t.eq(Object.keys(doc1.chapters['1'].pages).length, 2, 'recordPage 逐页累积（不互相覆盖）');
  t.eq(doc1.chapters['1'].pages['2'].bytes, 222, '台账记录保留字节数');
  t.eq(doc1.chapters['1'].pages['2'].file, pageFile(path.join(ledgerDataDir, 'staged'), 2), '台账记录保留文件路径');
  t.ok(typeof doc1.chapters['1'].pages['2'].at === 'string' && doc1.chapters['1'].pages['2'].at.length > 0, '台账记录带落盘时间');
  const chLedger1 = await ledger.readChapter(ledgerId, 1);
  t.eq(chLedger1.title, '第1話', 'readChapter 返回章节标题');
  t.eq(chLedger1.total, 3, 'readChapter 返回总页数');
  t.eq(await ledger.readChapter(ledgerId, 9), null, 'readChapter 对没有记录的章节返回 null');
  const stats1 = await ledger.stats(ledgerId);
  t.eq(stats1.pages, 2, 'stats 统计页数');
  t.eq(stats1.bytes, 333, 'stats 统计已记录字节数');
  t.eq(stats1.comicId, 'comic-led', 'stats 带 comicId');
  // 并发写同一个台账：必须串行且一条不丢
  const concId = 'dl-ledger-conc';
  await Promise.all(Array.from({ length: 20 }, function (x, i) {
    return ledger.recordPage(concId, { chapterOrder: 2, title: '并发章', total: 20, index: i + 1, file: pageFile(path.join(ledgerDataDir, 'conc'), i + 1), bytes: 10 + i, url: 'u' + (i + 1) });
  }));
  const concDoc = await ledger.read(concId, { fresh: true });
  t.eq(Object.keys(concDoc.chapters['2'].pages).length, 20, '20 条并发 recordPage 全部落盘（同 taskId 写串行）');
  t.eq(concDoc.chapters['2'].pages['20'].bytes, 29, '并发写入的每条记录字节数正确');
  t.deepEq(concDoc.chapters['2'].pages['1'], { file: pageFile(path.join(ledgerDataDir, 'conc'), 1), bytes: 10, url: 'u1', at: concDoc.chapters['2'].pages['1'].at }, '并发写入的字段完整');
  // 损坏的台账：返回空台账 + 一条中文日志，绝不抛
  await fsp.mkdir(path.dirname(ledger.ledgerPath('dl-ledger-broken')), { recursive: true });
  await fsp.writeFile(ledger.ledgerPath('dl-ledger-broken'), '{ 这不是 JSON', 'utf8');
  ledger.clearLogs();
  const brokenDoc = await ledger.read('dl-ledger-broken', { fresh: true });
  t.eq(Object.keys(brokenDoc.chapters).length, 0, '台账 JSON 损坏时读成空台账（不抛异常）');
  t.ok(ledger.recentLogs().some(function (l) { return l.level === 'warn' && l.message.indexOf('损坏') >= 0; }), '台账损坏留下一条中文可读日志');
  // remove：文件真的没了，再读为空
  await ledger.remove(ledgerId);
  t.eq(await exists(ledger.ledgerPath(ledgerId)), false, 'remove 删掉台账文件');
  t.deepEq(Object.keys((await ledger.read(ledgerId, { fresh: true })).chapters), [], 'remove 后再读是空台账');
  // prune：超过 30 天的删、当天的留
  await ledger.write('dl-ledger-old', { version: 1, taskId: 'dl-ledger-old', chapters: {} });
  await ledger.write('dl-ledger-fresh', { version: 1, taskId: 'dl-ledger-fresh', chapters: {} });
  const oldStamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await fsp.utimes(ledger.ledgerPath('dl-ledger-old'), oldStamp, oldStamp);
  const pruned = await ledger.prune(30);
  t.ok(pruned.files.indexOf('dl-ledger-old.json') >= 0, 'prune(30) 删除 40 天前的台账（实测删除 ' + pruned.removed + ' 份）');
  t.eq(await exists(ledger.ledgerPath('dl-ledger-old')), false, 'prune 后旧台账文件真的不在了');
  t.eq(await exists(ledger.ledgerPath('dl-ledger-fresh')), true, 'prune(30) 保留当天的台账');

  // --- 14.2 台账命中跳过 HTTP（关键收益的决定性证据） ---
  // 手工伪装「上一次进程留下的章节目录」：目录名带别的 pid，扫目录的老逻辑只看 <章节目录>.tmp-<本进程pid>，
  // 永远看不到它；能指回这些文件的只有逐页台账。因此「HTTP 请求数为 0」只能由台账解释。
  const tmpLedger = safeTmpDir('mvdl-ledger-hit-');
  const rootLedger = path.join(tmpLedger, 'lib');
  const foreignDir = path.join(rootLedger, '台账漫画', '1 第1話.tmp-999999');
  await fsp.mkdir(foreignDir, { recursive: true });
  await fsp.writeFile(pageFile(foreignDir, 1), fakeJpeg(1024));
  await fsp.writeFile(pageFile(foreignDir, 2), fakeJpeg(1024));
  const hitId = 'dl-ledger-hit-' + Date.now().toString(36);
  await ledger.recordPage(hitId, { comicId: 'comic-led', chapterOrder: 1, title: '第1話', total: 3, index: 1, file: pageFile(foreignDir, 1), bytes: 1024, url: 'https://img.test/static/c1/1.jpg' });
  await ledger.recordPage(hitId, { comicId: 'comic-led', chapterOrder: 1, title: '第1話', total: 3, index: 2, file: pageFile(foreignDir, 2), bytes: 1024, url: 'https://img.test/static/c1/2.jpg' });
  const fakeLedger = makeFakeClient({ pages: { 1: 3 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }] });
  const engineLedger = createEngine({
    source: fakeLedger, log: quietLog,
    getConfig: function () { return makeEngineCfg(rootLedger); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const taskLedger = await engineLedger.createTask({ id: hitId, comicId: 'comic-led', title: '台账漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineLedger.enqueue(taskLedger);
  const ledDone = await waitTask(engineLedger, hitId);
  const ledStatic = fakeLedger.calls.downloaded.filter(function (u) { return u.indexOf('/static/') >= 0; });
  t.eq(ledDone.state, 'done', '台账命中的任务正常完成');
  t.eq(ledDone.ledgerHits, 2, '两页由逐页台账命中，未发起 HTTP 请求');
  t.eq(ledStatic.length, 1, '只对台账里没有的第 3 页发起 HTTP 请求');
  t.ok(ledStatic[0].indexOf('/3.jpg') >= 0, '请求的正是缺失的第 3 页');
  t.eq(ledDone.done, 3, '台账命中 + 实下，三页都算完成');
  t.deepEq((await fsp.readdir(path.join(rootLedger, '台账漫画', '1 第1話'))).filter(function (x) { return x.endsWith('.jpg'); }).sort(), ['001.jpg', '002.jpg', '003.jpg'], '台账命中的页被补进本次章节目录，章节完整');
  t.eq(await exists(pageFile(foreignDir, 1)), true, '台账命中的源文件是复制而不是搬走');
  t.ok(ledDone.logs.some(function (l) { return l.message.indexOf('台账命中') >= 0; }), '任务日志写明台账命中的页数');
  t.eq(await exists(ledger.ledgerPath(hitId)), false, '任务完成后清理对应台账（避免 data/ 膨胀）');
  await rmWithRetry(tmpLedger);

  // --- 14.3 台账记录与磁盘对不上（字节数不符 / 文件没了）→ 必须重下 ---
  const tmpSize = safeTmpDir('mvdl-ledger-size-');
  const rootSize = path.join(tmpSize, 'lib');
  const sizeDir = path.join(rootSize, '字节漫画', '1 第1話.tmp-999998');
  await fsp.mkdir(sizeDir, { recursive: true });
  await fsp.writeFile(pageFile(sizeDir, 1), fakeJpeg(700));
  const sizeId = 'dl-ledger-size-' + Date.now().toString(36);
  // 第 1 页：台账说 1024 字节，磁盘只剩 700 字节（半截文件）
  await ledger.recordPage(sizeId, { comicId: 'comic-size', chapterOrder: 1, title: '第1話', total: 2, index: 1, file: pageFile(sizeDir, 1), bytes: 1024, url: 'https://img.test/static/c1/1.jpg' });
  // 第 2 页：台账有记录但文件根本不存在
  await ledger.recordPage(sizeId, { comicId: 'comic-size', chapterOrder: 1, title: '第1話', total: 2, index: 2, file: pageFile(path.join(rootSize, '已经不在了'), 2), bytes: 1024, url: 'https://img.test/static/c1/2.jpg' });
  const fakeSize = makeFakeClient({ pages: { 1: 2 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }] });
  const engineSize = createEngine({
    source: fakeSize, log: quietLog,
    getConfig: function () { return makeEngineCfg(rootSize); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const taskSize = await engineSize.createTask({ id: sizeId, comicId: 'comic-size', title: '字节漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineSize.enqueue(taskSize);
  const sizeDone = await waitTask(engineSize, sizeId);
  const sizeStatic = fakeSize.calls.downloaded.filter(function (u) { return u.indexOf('/static/') >= 0; });
  t.eq(sizeStatic.length, 2, '字节数不符与文件缺失的页都重新下载');
  t.eq(sizeDone.ledgerHits, 0, '对不上的台账记录不算命中');
  t.eq(sizeDone.state, 'done', '重下后任务完成');
  t.eq((await fsp.stat(path.join(rootSize, '字节漫画', '1 第1話', '001.jpg'))).size, 1024, '重下后落盘的是完整图片');
  t.ok(sizeDone.logs.some(function (l) { return l.message.indexOf('台账记录与磁盘不符') >= 0; }), '对不上时留下中文日志');
  await rmWithRetry(tmpSize);

  // --- 14.4 Content-Length 与实收不符 → 视为失败并重试；一直不符则记死信 ---
  const tmpLen = safeTmpDir('mvdl-ledger-len-');
  const rootLen = path.join(tmpLen, 'lib');
  const lenId = 'dl-ledger-len-' + Date.now().toString(36);
  const fakeLen = makeFakeClient({ pages: { 1: 1 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }], wrongLengthFirst: { 1: 999 } });
  const engineLen = createEngine({
    source: fakeLen, log: quietLog,
    getConfig: function () { return makeEngineCfg(rootLen, { retryTimes: 3 }); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const taskLen = await engineLen.createTask({ id: lenId, comicId: 'comic-len', title: '长度漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineLen.enqueue(taskLen);
  const lenDone = await waitTask(engineLen, lenId);
  const lenStatic = fakeLen.calls.downloaded.filter(function (u) { return u.indexOf('/static/') >= 0; });
  t.eq(lenStatic.length, 2, 'Content-Length 不符时重试（共 2 次请求）');
  t.eq(lenDone.state, 'done', 'Content-Length 修正后任务完成');
  t.eq((await fsp.stat(path.join(rootLen, '长度漫画', '1 第1話', '001.jpg'))).size, 1024, '重试成功后落盘图片完整');
  await rmWithRetry(tmpLen);

  const tmpLenBad = safeTmpDir('mvdl-ledger-lenbad-');
  const rootLenBad = path.join(tmpLenBad, 'lib');
  const lenBadId = 'dl-ledger-lenbad-' + Date.now().toString(36);
  const fakeLenBad = makeFakeClient({ pages: { 1: 1 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }], wrongLengthAlways: { 1: 999 } });
  const engineLenBad = createEngine({
    source: fakeLenBad, log: quietLog,
    getConfig: function () { return makeEngineCfg(rootLenBad, { retryTimes: 2 }); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const taskLenBad = await engineLenBad.createTask({ id: lenBadId, comicId: 'comic-len', title: '坏长度漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineLenBad.enqueue(taskLenBad);
  const lenBadDone = await waitTask(engineLenBad, lenBadId);
  t.eq(lenBadDone.state, 'error', 'Content-Length 一直不符 → 任务报 error 而不是 done');
  t.eq(lenBadDone.failed, 1, 'Content-Length 不符计入死信');
  t.eq(await exists(path.join(rootLenBad, '坏长度漫画', '1 第1話', '001.jpg')), false, '声明与实收不符的图片绝不落盘');
  t.ok(lenBadDone.logs.some(function (l) { return String(l.message).indexOf('Content-Length') >= 0; }), '死信日志写明了 Content-Length 不符');
  await rmWithRetry(tmpLenBad);

  // --- 14.5 模拟进程重启：同一 taskId 重新 runTask，已下载页不再发 HTTP ---
  const tmpRestart = safeTmpDir('mvdl-ledger-restart-');
  const rootRestart = path.join(tmpRestart, 'lib');
  const restartId = 'dl-ledger-restart-' + Date.now().toString(36);
  const cfgRestart = makeEngineCfg(rootRestart, { imgConcurrency: 1, retryTimes: 1 });
  const engineA2 = createEngine({
    source: makeFakeClient({ pages: { 1: 4 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }], failIndexes: [4] }),
    log: quietLog, getConfig: function () { return cfgRestart; },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const taskA2 = await engineA2.createTask({ id: restartId, comicId: 'comic-rs', title: '重启漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineA2.enqueue(taskA2);
  const firstRun = await waitTask(engineA2, restartId);
  t.eq(firstRun.state, 'error', '第一轮：第 4 页持续失败 → 任务 error（可续传）');
  t.eq(firstRun.done, 3, '第一轮下好 3 页');
  const rsChapter = await ledger.readChapter(restartId, 1);
  t.eq(Object.keys(rsChapter.pages).length, 3, '第一轮逐页记下 3 条台账');
  t.ok(String(rsChapter.pages['3'].file).length > 0 && rsChapter.pages['3'].bytes > 0, '台账记录带文件路径与字节数');
  engineA2.dispose();
  // 重启：新引擎、同一 taskId、同一目标目录，只把第 4 页修好
  const fakeRestartB = makeFakeClient({ pages: { 1: 4 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }] });
  const engineB2 = createEngine({
    source: fakeRestartB, log: quietLog, getConfig: function () { return cfgRestart; },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const taskB2 = await engineB2.createTask({ id: restartId, comicId: 'comic-rs', title: '重启漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineB2.enqueue(taskB2);
  const secondRun = await waitTask(engineB2, restartId);
  const rsStatic = fakeRestartB.calls.downloaded.filter(function (u) { return u.indexOf('/static/') >= 0; });
  t.eq(secondRun.state, 'done', '重启后补全并完成');
  t.eq(rsStatic.length, 1, '重启后只发 1 次图片请求（已下载页不再发起 HTTP）');
  t.ok(rsStatic[0].indexOf('/4.jpg') >= 0, '请求的正是第一轮缺的第 4 页');
  t.eq(secondRun.ledgerHits, 3, '重启后 3 页由逐页台账命中（不是靠扫目录碰运气）');
  t.eq(secondRun.done, 4, '重启后 4 页齐全');
  t.deepEq((await fsp.readdir(path.join(rootRestart, '重启漫画', '1 第1話'))).filter(function (x) { return x.endsWith('.jpg'); }).sort(), ['001.jpg', '002.jpg', '003.jpg', '004.jpg'], '重启后章节图片完整');
  await rmWithRetry(tmpRestart);

  // --- 14.6 remove 之后不再命中；删除任务 / clear-done 都会清理台账 ---
  const tmpRemove = safeTmpDir('mvdl-ledger-remove-');
  const rootRemove = path.join(tmpRemove, 'lib');
  const keepDir = path.join(rootRemove, '删除漫画', '1 第1話.tmp-999997');
  await fsp.mkdir(keepDir, { recursive: true });
  await fsp.writeFile(pageFile(keepDir, 1), fakeJpeg(1024));
  const removeId = 'dl-ledger-remove-' + Date.now().toString(36);
  await ledger.recordPage(removeId, { comicId: 'comic-rm', chapterOrder: 1, title: '第1話', total: 1, index: 1, file: pageFile(keepDir, 1), bytes: 1024, url: 'https://img.test/static/c1/1.jpg' });
  t.eq(await exists(ledger.ledgerPath(removeId)), true, 'remove 之前台账确实写到了磁盘');
  await ledger.remove(removeId);
  t.deepEq(Object.keys((await ledger.read(removeId, { fresh: true })).chapters), [], 'remove 之后台账读成空');
  const fakeRemove = makeFakeClient({ pages: { 1: 1 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }] });
  const engineRemove = createEngine({
    source: fakeRemove, log: quietLog,
    getConfig: function () { return makeEngineCfg(rootRemove); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const taskRemove = await engineRemove.createTask({ id: removeId, comicId: 'comic-rm', title: '删除漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineRemove.enqueue(taskRemove);
  const removeDone = await waitTask(engineRemove, removeId);
  t.eq(fakeRemove.calls.downloaded.filter(function (u) { return u.indexOf('/static/') >= 0; }).length, 1, 'remove 后不再命中台账：该页重新下载');
  t.eq(removeDone.ledgerHits, 0, 'remove 后台账命中数为 0');
  // 引擎删除任务（DELETE /api/download/tasks/:id 走的路径）必须同步清台账
  const delId = 'dl-ledger-del-' + Date.now().toString(36);
  await ledger.recordPage(delId, { chapterOrder: 1, title: '待删章', total: 1, index: 1, file: pageFile(keepDir, 1), bytes: 1024, url: 'https://img.test/static/c1/1.jpg' });
  t.eq(await exists(ledger.ledgerPath(delId)), true, '待删任务的台账已存在');
  const engineDel = createEngine({
    source: makeFakeClient({ pages: { 1: 1 } }), log: quietLog,
    getConfig: function () { return makeEngineCfg(rootRemove); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  await engineDel.createTask({ id: delId, comicId: 'comic-del', title: '待删漫画', chapters: [{ chapterId: 'c1', chapterTitle: '待删章', order: 1 }] });
  await engineDel.remove(delId);
  t.eq(await exists(ledger.ledgerPath(delId)), false, '删除任务时同步清理对应台账');
  await rmWithRetry(tmpRemove);

  // 清空已完成任务（clear-done）也要清台账
  const tmpClear = safeTmpDir('mvdl-ledger-clear-');
  const rootClear = path.join(tmpClear, 'lib');
  const clearId = 'dl-ledger-clear-' + Date.now().toString(36);
  const engineClear = createEngine({
    source: makeFakeClient({ pages: { 1: 1 }, chapters: [{ _id: 'c1', title: '第1話', order: 1 }] }),
    log: quietLog, getConfig: function () { return makeEngineCfg(rootClear); },
    store: { save: function () {}, remove: function () {} }, emit: function () {}
  });
  const taskClear = await engineClear.createTask({ id: clearId, comicId: 'comic-clear', title: '清空漫画', chapters: [{ chapterId: 'c1', chapterTitle: '第1話', order: 1 }] });
  engineClear.enqueue(taskClear);
  await waitTask(engineClear, clearId);
  // 完成后台账本就已被清掉，这里手工再造一份，验证 clear-done 同样会清
  await ledger.recordPage(clearId, { chapterOrder: 1, title: '第1話', total: 1, index: 1, file: pageFile(keepDir, 1), bytes: 1024, url: 'u' });
  t.eq(await exists(ledger.ledgerPath(clearId)), true, 'clear-done 之前台账存在');
  const cleared = await engineClear.clearDone();
  t.eq(cleared.removed, 1, 'clear-done 清掉 1 条已完成任务');
  t.eq(await exists(ledger.ledgerPath(clearId)), false, 'clear-done 同步清理对应台账');
  await rmWithRetry(tmpClear);

  // --- 14.7 启动清理：createTasks 起来时 prune 掉超过 30 天的台账 ---
  const oldLedgerId = 'dl-ledger-startup-old';
  const freshLedgerId = 'dl-ledger-startup-fresh';
  await ledger.write(oldLedgerId, { version: 1, taskId: oldLedgerId, chapters: {} });
  await ledger.write(freshLedgerId, { version: 1, taskId: freshLedgerId, chapters: {} });
  await fsp.utimes(ledger.ledgerPath(oldLedgerId), oldStamp, oldStamp);
  const startupTmp = safeTmpDir('mvdl-ledger-startup-');
  const createTasksMod = await import('../src/modules/download/tasks.mjs');
  const tasksHandle = await createTasksMod.createTasks({
    source: makeFakeClient({}), log: quietLog,
    getConfig: function () { return makeEngineCfg(path.join(startupTmp, 'lib')); }
  });
  t.eq(await exists(ledger.ledgerPath(oldLedgerId)), false, '启动时 prune 清掉超过 30 天的台账');
  t.eq(await exists(ledger.ledgerPath(freshLedgerId)), true, '启动时 prune 保留当天的台账');
  t.eq(tasksHandle.list().length, 0, '启动时没有待恢复任务（数据目录是隔离的）');
  await tasksHandle.dispose();
  await rmWithRetry(startupTmp);

  // 清理
  for (const d of [tmp, tmp2, tmp3, tmp4, tmp5, tmp6, tmp7, tmp8]) {
    try { await rmWithRetry(d); } catch (e) { t.log('清理失败（不影响断言）：' + d + ' → ' + e.code); }
  }
  // 还原数据目录并清掉本文件产生的临时数据（含逐页台账）
  if (prevDataDir0 === undefined) delete process.env.MV_DATA_DIR;
  else process.env.MV_DATA_DIR = prevDataDir0;
  try { await rmWithRetry(ledgerDataDir); } catch (e) { t.log('清理失败（不影响断言）：' + ledgerDataDir + ' → ' + e.code); }
  t.log('全部用例离线完成，未访问真实网络');
}
