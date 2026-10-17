import fsp from 'node:fs/promises';
import path from 'node:path';

import { createApp } from '../src/core/http.mjs';
import { createLogger } from '../src/core/log.mjs';
import { safeTmpDir } from '../src/core/util.mjs';
import { PICA_API_KEY } from '../src/modules/download/api.mjs';
import { createPicacomicSource } from '../src/modules/download/sources/picacomic.mjs';
import * as sources from '../src/modules/download/sources/index.mjs';

export const name = '下载路由（排行榜 / 账号资料）';

/* 仓库根：路由文件都从 src/modules/download 下读，用 import.meta.url 拼（中文目录不能走 URL.pathname）。 */
const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 本用例只测新增的两个只读路由：GET /api/download/leaderboard 与 GET /api/download/profile。
 * 全程离线：真 HTTP + listen(0) 随机端口 + 假 transport，绝不打真实网络，也不碰 8775。
 * 临时目录一律走 src/core/util.mjs 的 safeTmpDir()（os.tmpdir() 在 DSH 进程内会返回相对路径）。
 */

/** 带重试的目录删除：Windows 文件句柄释放滞后，递归 rm 常见 EBUSY/EPERM/ENOTEMPTY。 */
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

/** 上游榜单里的漫画对象（哔咔真字段名：epsCount / likesCount / thumb）。 */
function leaderDoc(id, title) {
  return {
    _id: id,
    title: title,
    author: '作者' + id,
    epsCount: 5,
    likesCount: 9,
    totalViews: 100,
    finished: false,
    tags: ['标签1', '标签2'],
    categories: ['分类1'],
    thumb: { path: 'a/b/' + id + '.jpg', fileServer: 'https://img.picacomic.com' }
  };
}

export default async function (t) {
  const tmp = safeTmpDir('mvdl-routes');
  const lib = path.join(tmp, 'lib');
  await fsp.mkdir(lib, { recursive: true });
  const prevDataDir = process.env.MV_DATA_DIR;
  process.env.MV_DATA_DIR = path.join(tmp, 'data');
  await fsp.mkdir(process.env.MV_DATA_DIR, { recursive: true });

  // 上游应答开关：单测用它模拟上游 401，不联网也能验证失败路径
  const upstream = { leaderboardStatus: 200, profileStatus: 200 };

  /** 假 transport 的应答：按路径回一份合法的哔咔响应。 */
  function fakeReply(req) {
    const p = String((req && req.path) || '');
    if (p.indexOf('comics/leaderboard') >= 0) {
      if (upstream.leaderboardStatus !== 200) {
        return { status: upstream.leaderboardStatus, text: JSON.stringify({ code: 401, message: 'unauthorized' }) };
      }
      return { status: 200, text: JSON.stringify({ code: 200, message: 'ok', data: { comics: [leaderDoc('lb1', '榜首漫画'), leaderDoc('lb2', '第二名漫画')] } }) };
    }
    if (p.indexOf('users/profile') >= 0) {
      if (upstream.profileStatus !== 200) {
        return { status: upstream.profileStatus, text: JSON.stringify({ code: 401, message: 'unauthorized' }) };
      }
      return { status: 200, text: JSON.stringify({ code: 200, message: 'ok', data: { user: { _id: 'u-1', name: '测试用户', email: 'user@test.local', avatar: { path: 'a/b/avatar.jpg', fileServer: 'https://img.picacomic.com' }, level: 3, exp: 120, role: 'user', title: '萌新', verified: true, slogan: '来源专有字段不外传' } } }) };
    }
    if (p.indexOf('comics/advanced-search') >= 0) {
      // 搜索只作为「卡片元素形状」的基准
      return { status: 200, text: JSON.stringify({ code: 200, message: 'ok', data: { comics: { total: 1, pages: 1, page: 1, docs: [{ _id: 'x9', title: '上游漫画', author: 'A', epsCount: 2, likesCount: 3, tags: ['t'], categories: ['c'], thumb: { path: 'a/b/c.jpg', fileServer: 'https://img.picacomic.com' } }] } } }) };
    }
    // 图片 CDN 行为：签名路径先回 301，Location 指向真实文件 —— 与哔咔 storage-b 一致。
    // 域名必须落在 /api/download/cover 的白名单内（picacomic.com 及其子域）。
    if (p.indexOf('https://cdn.picacomic.com/') === 0) {
      return { status: 200, headers: { 'content-type': 'image/jpeg' }, body: Buffer.from('JPEGDATA') };
    }
    if (p.indexOf('https://img.picacomic.com/') === 0) {
      return { status: 301, headers: { location: 'https://cdn.picacomic.com/real.jpg' }, body: Buffer.from('') };
    }
    return { status: 200, text: JSON.stringify({ code: 200, message: 'ok', data: {} }) };
  }

  const seen = [];
  /* 必须**快照**而不是存引用：重定向跟随会就地改写同一个请求对象的 path，
     直接 push(req) 会得到「两跳记录指向同一对象、第一跳被改写成第二跳地址」的假象。 */
  const routeTransport = async function (req) {
    seen.push(Object.assign({}, req, { headers: Object.assign({}, req.headers) }));
    return fakeReply(req);
  };
  const app = createApp({ log: createLogger('dlroutes', 'error'), accessLog: false });
  const routeCfg = {
    downloadRoot: lib, libraryRoot: lib, libraryRoots: [], logLevel: 'error',
    picacomic: { apiBase: 'https://picaapi.picacomic.com', apiKey: PICA_API_KEY, token: 'tok-routes', retries: 0, timeoutMs: 3000, dirFmt: '{comic_title}/{order} {chapter_title}', downloadFormat: 'Jpeg' }
  };
  const routeCtx = {
    config: routeCfg,
    log: createLogger('dlroutes', 'error'),
    projectRoot: path.resolve(import.meta.dirname, '..'),
    dataDir: process.env.MV_DATA_DIR,
    publicDir: path.resolve(import.meta.dirname, '../public'),
    moduleId: 'download',
    moduleMeta: {},
    reloadConfig: async function () { return routeCfg; },
    saveConfig: async function (patch) { Object.assign(routeCfg, patch || {}); return routeCfg; }
  };

  let server = null;
  let downloadMod = null;
  try {
    // 用假 transport 重建默认源：路由层拿到的适配器就走这条假链路
    sources.registerFactory('picacomic', function (options) {
      return createPicacomicSource(Object.assign({}, options, { transport: routeTransport }));
    });
    downloadMod = await import('../src/modules/download/index.mjs');
    await downloadMod.register(app, routeCtx);
    server = app.createServer();
    await new Promise(function (res, rej) { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    const base = 'http://127.0.0.1:' + server.address().port;
    async function api(p, opts) {
      const o2 = opts || {};
      const init = { method: o2.method || 'GET', headers: {} };
      if (o2.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o2.body); }
      const res = await fetch(base + p, init);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
      return { status: res.status, data: data };
    }

    // ===== 组 1：正常榜单 =====
    seen.length = 0;
    const lb = await api('/api/download/leaderboard?tt=H24&ct=VC&page=1');
    t.eq(lb.status, 200, '排行榜正常返回 200');
    t.eq(lb.data.ok, true, '排行榜 ok:true');
    t.eq(lb.data.source, 'picacomic', 'source 来自注册表里的源 id');
    t.eq(lb.data.rankType, 'H24', 'rankType 回显 H24');
    t.eq(lb.data.ct, 'VC', 'ct 回显 VC');
    t.eq(lb.data.page, 1, 'page 为 1');
    t.eq(lb.data.pages, 1, '排行榜不分页，pages 固定为 1');
    t.eq(lb.data.total, 2, 'total 为榜单条数');
    t.eq(Array.isArray(lb.data.comics), true, 'comics 是数组');
    t.eq(lb.data.comics.length, 2, 'comics 返回 2 部');
    t.eq(lb.data.comics[0].id, 'lb1', '榜首 id 来自统一 Comic');
    t.eq(lb.data.comics[0].title, '榜首漫画', '榜首标题来自统一 Comic');
    t.eq(lb.data.comics[0].author, '作者lb1', '作者来自统一 Comic');
    t.eq(lb.data.comics[0].chapterCount, 5, 'chapterCount 由统一字段 chapterCount 映射');
    t.eq(lb.data.comics[0].likes, 9, 'likes 由统一字段 likes 映射');
    t.deepEq(lb.data.comics[0].tags, ['标签1', '标签2'], 'tags 透传');
    t.deepEq(lb.data.comics[0].categories, ['分类1'], 'categories 透传');
    t.eq(lb.data.comics[0].finished, false, 'finished 透传');
    t.eq(lb.data.comics[0].inLibrary, false, '未入库时 inLibrary 为 false');
    t.eq(lb.data.comics[0].localDir, null, '未入库时 localDir 为 null');
    t.eq(lb.data.comics[0].rootName, null, '未入库时 rootName 为 null');
    t.ok(String(lb.data.comics[0].cover).indexOf('/api/download/cover?path=') === 0, '封面转成本地封面代理地址');
    t.eq(seen.length, 1, '榜单只向上游发一次请求');
    t.eq(seen[0].path, 'comics/leaderboard?tt=H24&ct=VC', '上游路径与契约逐字一致');
    t.eq(seen[0].headers.authorization, 'tok-routes', '榜单请求带上 authorization token');

    // ===== 组 1b：远程封面代理（排行榜卡片用的 CDN 直链必须由后端经代理取回） =====
    // 三个真缺陷的回归防线（合并成一条链路验证）：
    //   ① buildTargetUrl 曾把完整 URL 拼成 '/https://...' → 抛 Invalid URL；
    //   ② 传输层曾不跟随 301 → 存下 194 字节 HTML 错误页；
    //   ③ /api/download/cover 曾只认本地路径 → 前端直连 CDN 得到裂图。
    seen.length = 0;
    const coverRes = await fetch(base + '/api/download/cover?path=' + encodeURIComponent('https://img.picacomic.com/static/a/b/c.jpg'));
    t.eq(coverRes.status, 200, '远程封面经后端代理返回 200');
    t.eq(coverRes.headers.get('content-type'), 'image/jpeg', '远程封面回图片类型（不是 text/html 错误页）');
    const coverBuf = Buffer.from(await coverRes.arrayBuffer());
    t.eq(coverBuf.toString('utf8'), 'JPEGDATA', '远程封面内容是真实图片字节（说明 301 被跟随了）');
    t.ok(seen.length >= 2, '封面链路至少两次上游请求（首次 301 + 跟随后的真实请求）');
    t.eq(seen[0].path, 'https://img.picacomic.com/static/a/b/c.jpg', '第一次按完整 URL 请求（不被 baseUrl 拼接破坏）');
    t.eq(seen[1].path, 'https://cdn.picacomic.com/real.jpg', '跟随 Location 到新地址');
    const coverAgain = await fetch(base + '/api/download/cover?path=' + encodeURIComponent('https://img.picacomic.com/static/a/b/c.jpg'));
    t.eq(coverAgain.status, 200, '重复请求封面仍 200（命中短缓存）');
    t.eq(Buffer.from(await coverAgain.arrayBuffer()).toString('utf8'), 'JPEGDATA', '重复请求内容一致');
    // 域名白名单：不能让这个路由变成任意代理
    const badHost = await api('/api/download/cover?path=' + encodeURIComponent('https://evil.example.com/x.jpg'));
    t.eq(badHost.status, 400, '非哔咔域名的远程封面被 400 拒绝（避免变成开放代理）');

    // comics 元素形状必须与 search 的元素完全一致（前端复用同一个卡片渲染器）
    const sRes = await api('/api/download/search?q=abc');
    t.eq(sRes.status, 200, '搜索路由正常，作为形状基准');
    t.deepEq(Object.keys(lb.data.comics[0]).sort(), Object.keys(sRes.data.items[0]).sort(), 'comics 元素字段与 search 元素逐字同形');

    // ===== 组 2：tt=D7 与上游路径 =====
    seen.length = 0;
    const lb7 = await api('/api/download/leaderboard?tt=D7&ct=VC');
    t.eq(lb7.status, 200, 'tt=D7 正常返回 200');
    t.eq(lb7.data.rankType, 'D7', 'rankType 回显 D7');
    t.eq(seen[0].path, 'comics/leaderboard?tt=D7&ct=VC', 'tt=D7 时上游路径正确');

    // ===== 组 3：tt 非法 = 400 =====
    seen.length = 0;
    const badTt = await api('/api/download/leaderboard?tt=ZZZ');
    t.eq(badTt.status, 400, 'tt 非法返回 400');
    t.eq(badTt.data.ok, false, 'tt 非法 ok:false');
    t.ok(/H24\/D7\/D30/.test(String(badTt.data.error)) && /ZZZ/.test(String(badTt.data.error)), 'tt 非法错误说明可选值与实际值：' + badTt.data.error);
    t.eq(seen.length, 0, 'tt 非法时根本不打上游');

    // ===== 组 4：ct 非 VC = NOT_SUPPORTED =====
    seen.length = 0;
    const badCt = await api('/api/download/leaderboard?tt=H24&ct=HC');
    t.eq(badCt.status, 400, 'ct 非 VC 返回 400 而不是 500');
    t.eq(badCt.data.ok, false, 'ct 非 VC ok:false');
    t.eq(badCt.data.code, 'NOT_SUPPORTED', 'ct 非 VC 带机器可读的 code=NOT_SUPPORTED');
    t.ok(/不支持/.test(String(badCt.data.error)), 'ct 非 VC 错误是中文可读原因：' + badCt.data.error);
    t.eq(seen.length, 0, 'ct 非 VC 在适配器内就被拒绝，不打上游');

    // ===== 组 5：未登录 = 401 =====
    routeCfg.picacomic.token = '';
    const noToken = await api('/api/download/leaderboard?tt=H24&ct=VC');
    t.eq(noToken.status, 401, '未登录看榜单返回 401');
    t.eq(noToken.data.ok, false, '未登录看榜单 ok:false');
    t.ok(/未登录/.test(String(noToken.data.error)), '未登录看榜单错误是中文：' + noToken.data.error);
    const noTokenProfile = await api('/api/download/profile');
    t.eq(noTokenProfile.status, 401, '未登录读资料返回 401');
    t.ok(/未登录/.test(String(noTokenProfile.data.error)), '未登录读资料错误是中文：' + noTokenProfile.data.error);
    routeCfg.picacomic.token = 'tok-routes';

    // ===== 组 6：上游 401 也回 401 =====
    upstream.profileStatus = 401;
    const upProfile = await api('/api/download/profile');
    t.eq(upProfile.status, 401, '上游 profile 401 时路由回 401');
    t.eq(upProfile.data.ok, false, '上游 profile 401 时 ok:false');
    t.ok(/重新登录/.test(String(upProfile.data.error)), '上游 profile 401 错误是中文可读原因：' + upProfile.data.error);
    upstream.profileStatus = 200;
    upstream.leaderboardStatus = 401;
    const upLb = await api('/api/download/leaderboard?tt=H24&ct=VC');
    t.eq(upLb.status, 401, '上游榜单 401 时路由回 401');
    t.ok(/重新登录/.test(String(upLb.data.error)), '上游榜单 401 错误是中文可读原因：' + upLb.data.error);
    upstream.leaderboardStatus = 200;

    // ===== 组 7：账号资料正常返回 =====
    seen.length = 0;
    const pf = await api('/api/download/profile');
    t.eq(pf.status, 200, '账号资料正常返回 200');
    t.eq(pf.data.ok, true, '账号资料 ok:true');
    t.eq(pf.data.source, 'picacomic', '账号资料 source 正确');
    t.eq(pf.data.profile.id, 'u-1', 'profile.id 来自统一 Profile');
    t.eq(pf.data.profile.name, '测试用户', 'profile.name 来自统一 Profile');
    t.eq(pf.data.profile.email, 'user@test.local', 'profile.email 来自统一 Profile');
    // 头像必须转成**站内封面代理地址**：前端拿不到代理，直连哔咔 CDN 只会得到裂图。
t.ok(String(pf.data.profile.avatar).indexOf('/api/download/cover?path=') === 0, 'profile.avatar 转成本地封面代理地址');
t.ok(String(pf.data.profile.avatar).indexOf(encodeURIComponent('https://img.picacomic.com/static/a/b/avatar.jpg')) > 0, '代理地址里带着哔咔 CDN 原始直链');
    t.eq(pf.data.profile.level, 3, 'profile.level 是数字');
    t.eq(pf.data.profile.exp, 120, 'profile.exp 是数字');
    t.eq(pf.data.profile.role, 'user', 'profile.role 透传');
    t.deepEq(Object.keys(pf.data.profile).sort(), ['avatar', 'email', 'exp', 'id', 'level', 'name', 'role', 'title', 'verified'], 'profile 暴露契约约定的字段（含哔咔真正返回的 title / verified）');
    t.eq(pf.data.profile.title, '萌新', '头衔 title 透传（哔咔没有 role 字段，title 才是真实有值的）');
    t.eq(pf.data.profile.verified, true, '认证状态 verified 透传');
    t.eq(seen.length, 1, '资料只向上游发一次请求');
    t.eq(seen[0].path, 'users/profile', '资料上游路径与契约逐字一致');

    // ===== 组 8：路由按注册表换源，不 import 任何具体来源 =====
    const seenBefore = seen.length;
    sources.register({
      meta: { id: 'lb-fake', name: '假榜源', capabilities: ['leaderboard', 'profile'] },
      async leaderboard(opts) {
        return {
          page: 1, pages: 1, total: 1, rankType: String((opts || {}).rankType || 'H24'), ct: 'VC',
          docs: [{ id: 'fk1', title: '假源榜首 ' + String((opts || {}).rankType || ''), author: '假作者', cover: '', tags: [], categories: [], description: '', chineseTeam: '', pagesCount: 0, chapterCount: 1, likes: 0, views: 0, finished: false, createdAt: null, updatedAt: null, raw: {} }]
        };
      },
      async profile() {
        return { id: 'fk-u', name: '假源用户', email: 'fk@test', avatar: '', level: 1, exp: 2, role: 'user', raw: {} };
      }
    });
    const fakeLb = await api('/api/download/leaderboard?tt=D30&ct=VC&sourceId=lb-fake');
    t.eq(fakeLb.status, 200, '指定 sourceId 时该源被真正调用');
    t.eq(fakeLb.data.source, 'lb-fake', '响应 source 回填被选中的源 id');
    t.eq(fakeLb.data.rankType, 'D30', 'rankType 透传给被选中的源并回显');
    t.eq(fakeLb.data.comics[0].title, '假源榜首 D30', '榜单内容来自被指定的源');
    t.eq(seen.length, seenBefore, '换源后完全不打哔咔上游');
    const fakePf = await api('/api/download/profile?sourceId=lb-fake');
    t.eq(fakePf.status, 200, '资料路由同样按 sourceId 换源');
    t.eq(fakePf.data.profile.name, '假源用户', '资料内容来自被指定的源');

    // 能力缺失：源声明了能力清单但没有 leaderboard → requireCapability 抛 NotSupportedError → 400 + code
    sources.register({ meta: { id: 'lb-stub', name: '缺榜能力源', capabilities: ['profile'] }, async profile() { return {}; } });
    const stubLb = await api('/api/download/leaderboard?tt=H24&ct=VC&sourceId=lb-stub');
    t.eq(stubLb.status, 400, '源未声明 leaderboard 能力时返回 400 而不是 500');
    t.eq(stubLb.data.ok, false, '能力缺失 ok:false');
    t.eq(stubLb.data.code, 'NOT_SUPPORTED', '能力缺失同样带 code=NOT_SUPPORTED');
    t.ok(/不支持/.test(String(stubLb.data.error)), '能力缺失错误是中文：' + stubLb.data.error);

    // 未知源：400 中文，不是 500
    const unknown = await api('/api/download/leaderboard?tt=H24&ct=VC&sourceId=nope');
    t.eq(unknown.status, 400, '未知 sourceId 返回 400');
    t.ok(/未知的下载源/.test(String(unknown.data.error)), '未知源错误是中文：' + unknown.data.error);
  } finally {
    if (server) await new Promise(function (r) { server.close(r); });
    if (downloadMod && typeof downloadMod.dispose === 'function') { try { await downloadMod.dispose(); } catch (e) { /* 忽略 */ } }
    sources.unregister('lb-fake');
    sources.unregister('lb-stub');
    // 还原内置工厂：其它测试文件必须拿回真哔咔适配器
    sources.registerFactory('picacomic', createPicacomicSource);
    try {
      const authMod = await import('../src/modules/download/auth.mjs');
      if (typeof authMod.resetStores === 'function') authMod.resetStores();
    } catch (e) { /* 忽略 */ }
    if (prevDataDir === undefined) delete process.env.MV_DATA_DIR;
    else process.env.MV_DATA_DIR = prevDataDir;
    try { await rmWithRetry(tmp); } catch (e) { t.log('临时目录清理失败（不影响断言）：' + tmp + ' → ' + (e && e.code)); }
  }
  t.log('排行榜/账号资料路由用例全部离线完成，未访问真实网络');

  await runSplitContract(t);
}

/* ================= 拆分契约：路由文件必须解构自己用到的共享绑定 ================= */
/*
 * 为什么需要这条：routes-*.mjs 是从 index.mjs 的 register() 闭包里切出来的，
 * 共享绑定靠文件顶部 `const { a, b } = s;` 逐字提供。漏解构的后果是**运行期 ReferenceError**，
 * 而 `node --check` 只查语法、查不出来；测试也只覆盖它真正跑过的分支。
 * 实测三个文件都漏了 `ctx`（只在「退出登录 / 清 token / 存代理」这些失败分支里用），
 * 单测 1428 条全绿、真浏览器只有最后那条「整个流程没有 JS 报错」变红。
 */
export async function runSplitContract(t) {
  const dlDir = path.join(ROOT, 'src', 'modules', 'download');
  const indexSrc = await fsp.readFile(path.join(dlDir, 'index.mjs'), 'utf8');

  /* 1) 从 index.mjs 的 routeCtx 里取出「共享绑定」名单。 */
  const ctxBlock = (indexSrc.match(/const routeCtx = \{([\s\S]*?)\n  \};/) || [])[1] || '';
  const shared = [];
  for (const m of ctxBlock.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) shared.push(m[1]);
  t.ok(shared.length >= 20, 'routeCtx 解析出共享绑定 ' + shared.length + ' 个（应 >= 20）');
  t.ok(shared.indexOf('ctx') >= 0, 'routeCtx 名单里含 ctx');

  /* 2) 逐个路由文件核对：凡是「以 KEY. / KEY( 形式被使用」的共享键，都必须在解构名单里。 */
  const files = (await fsp.readdir(dlDir)).filter(function (f) { return /^routes-[\w-]+\.mjs$/.test(f); });
  t.ok(files.length >= 9, 'routes-*.mjs 文件数 = ' + files.length + '（应 >= 9）');
  for (const f of files) {
    const raw = await fsp.readFile(path.join(dlDir, f), 'utf8');
    const src = stripForContract(raw);
    const destructured = new Set();
    /* 工厂形参（app、s）本来就在作用域内，不需要解构；漏掉它们会误报。 */
    const pm = src.match(/export function registerRoutes\s*\(([^)]*)\)/);
    if (pm) for (const part of pm[1].split(',')) { const k = part.trim(); if (k) destructured.add(k); }
    const dm = src.match(/const\s*\{([^}]*)\}\s*=\s*s;/);
    if (dm) for (const part of dm[1].split(',')) { const k = part.trim(); if (k) destructured.add(k); }
    const missing = [];
    for (const key of shared) {
      const esc = key.replace(/\$/g, '\\$');
      const used = new RegExp('(^|[^\\w$.])' + esc + '\\s*[.(]').test(src);
      if (used && !destructured.has(key)) missing.push(key);
    }
    t.eq(missing.join(','), '', f + ' 用到的共享绑定都已解构（漏了：' + (missing.join(',') || '无') + '）');
  }
}

/** 去掉注释与字符串字面量：注释里的名字、字符串里的文案都不算「使用」。 */
function stripForContract(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < src.length && src[i] !== String.fromCharCode(10)) i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

