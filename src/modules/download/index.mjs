import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createLogger } from '../../core/log.mjs';
import { safeJoin } from '../../core/util.mjs';
import * as sources from './sources/index.mjs';
import { createPaths, extOfFormat, findComicDirById } from './paths.mjs';
import { createTasks } from './tasks.mjs';
import { createSseHub } from './sse.mjs';
import { diskFree, isInside, chapterStats, scanChapterStates, coverUrlFor } from './comic.mjs';
import { findComicById, findByDir, listComics } from '../../core/library-index.mjs';
import { roots, activeRoots, ownerRootOf, probeRoots, labelOf } from '../../core/roots.mjs';
import { resolveProxy, testConnection } from './proxy.mjs';
import { createExportQueue } from './export-queue.mjs';
import * as auth from './auth.mjs';

/**
 * 下载模块 v2：内置登录 + 搜索/收藏/更新/下载/导出 全链路。
 * 所有对外接口统一 /api/download/*，成功 {ok:true,...}，失败 {ok:false,error:'中文原因'}。
 */

export const meta = {
  id: 'download',
  name: '下载',
  description: '哔咔登录、搜索、收藏同步、并发下载与导出',
  order: 30,
  help: [
    'POST /api/download/login',
    'POST /api/download/logout',
    'POST /api/download/register',
    'GET  /api/download/account',
    'GET  /api/download/state',
    'GET  /api/download/search?q=&page=',
    'GET  /api/download/comic/:id',
    'GET  /api/download/comic/:id/chapters',
    'GET  /api/download/favorites?page=',
    'POST /api/download/favorites/sync',
    'GET  /api/download/leaderboard?tt=&ct=&page=',
    'GET  /api/download/profile',
    'POST /api/download/update-check',
    'POST /api/download/update',
    'POST /api/download/tasks',
    'GET  /api/download/tasks',
    'POST /api/download/tasks/bulk',
    'POST /api/download/tasks/clear-done',
    'GET  /api/download/tasks/:id',
    'GET  /api/download/tasks/:id/failures',
    'POST /api/download/tasks/:id/retry',
    'POST /api/download/tasks/:id/pause',
    'POST /api/download/tasks/:id/resume',
    'POST /api/download/tasks/:id/cancel',
    'DEL  /api/download/tasks/:id',
    'POST /api/download/export',
    'GET  /api/download/exports',
    'POST /api/download/export/:id/remove',
    'GET  /api/download/proxy-test',
    'POST /api/download/config',
    'GET  /api/download/events',
    'GET  /api/download/cover?path=',
    'POST /api/download/open-folder'
  ]
};

let engine = null;
let hub = null;
let sse = null;
let tasks = null;
let exports = null;
let logger = null;
let rootPath = '';
let accountCheck = { at: 0 };

/** 读取下载模块自己的配置（永远从 ctx.config 活读，热更新立即生效）。 */
export async function register(app, ctx) {
  logger = createLogger('download', ctx.config.logLevel);
  rootPath = resolveRoot(ctx);

  // 代理实时解析：picacomic.proxyMode/proxyHost/proxyPort，兼容旧的 proxy 字段
  let proxyCache = { key: '', value: { url: '', mode: 'none', source: '', detail: '' } };
  async function currentProxy() {
    const p = (ctx.config.picacomic || {});
    const key = [p.proxyMode, p.proxyHost, p.proxyPort, p.proxy, p.apiBase].join('|');
    if (proxyCache.key === key) return proxyCache.value;
    const value = await resolveProxy(p);
    proxyCache = { key: key, value: value };
    return value;
  }

  // 默认下载源：用注册表的工厂重建一个「活读 ctx.config」的实例，覆盖注册表里的默认单例。
  // 这样路由层不需要 import 任何来源实现，token / 代理 / 超时仍随配置热更新。
  const defaultSource = sources.createInstance(sources.DEFAULT_SOURCE_ID, {
    config: function () {
      // 每次取配置时把解析好的代理注入，让适配器内部（含图片下载）自动走代理
      const p = Object.assign({}, ctx.config.picacomic || {});
      p.proxy = proxyCache.value ? (proxyCache.value.url || null) : (p.proxy || null);
      return p;
    },
    log: logger
  });
  sources.register(defaultSource);

  /* 预热代理缓存。
     踩坑：上面 defaultSource 的 config 读取的是 proxyCache.value，而 proxyCache 初始是空 url。
     如果某个路由忘了先 await currentProxy()，那次请求就会以「无代理」直连哔咔 —— 表现为随机的 fetch failed，
     而下一个请求又正常，极难复现。这里启动时先解析一次，把缓存垫上；
     resolveProxy 在 none 模式下不发网络请求，开销可忽略。 */
  try { await currentProxy(); } catch (e) { /* 解析失败不阻塞启动，路由内会再解析并报错 */ }

  tasks = await createTasks({
    source: defaultSource,
    // 任务记了 sourceId 时按任务换源，查不到就由引擎退回默认源
    getSource: function (sourceId) { return sources.get(sourceId); },
    log: logger,
    getConfig: function () { return ctx.config; }
  });
  engine = tasks.engine;
  hub = tasks.hub;
  sse = createSseHub(hub, { intervalMs: 500 });

  exports = createExportQueue({
    log: logger,
    getConfig: function () { return ctx.config; },
    emit: function (event, payload) { hub.send(event, payload); }
  });

  if (tasks.revivedCount() > 0) {
    logger.warn('有 ' + tasks.revivedCount() + ' 个未完成下载任务已暂停，可在下载页继续（断点续传）');
  }

  function cfg() { return ctx.config || {}; }
  function picaCfg() { return cfg().picacomic || {}; }
  function root() { return resolveRoot(ctx); }
  function paths() {
    return createPaths({
      root: function () { return root(); },
      dirFmt: function () { return picaCfg().dirFmt || '{comic_title}/{order} {chapter_title}'; },
      format: function () { return picaCfg().downloadFormat || 'Jpeg'; }
    });
  }
  function tokenInfo() {
    const token = String(picaCfg().token || '');
    return {
      hasToken: Boolean(token),
      tokenPreview: token ? token.slice(0, 12) + '...' : '',
      message: token ? '已配置登录 token' : '未登录，请在上方登录页填写哔咔账号'
    };
  }
  function requireToken(c) {
    if (!tokenInfo().hasToken) {
      c.error(401, '未登录或 token 已失效，请先在「登录」页登录');
      return false;
    }
    return true;
  }

  /**
   * 本次请求指定的下载源：查询串 ?sourceId= 或 JSON body 的 sourceId / source 都认，缺省用默认源。
   * @param {object} c 请求上下文
   * @returns {string} sourceId（空串 = 用默认源）
   */
  function requestedSourceId(c) {
    let v = '';
    try {
      if (c && typeof c.query === 'function') v = c.query('sourceId', '') || c.query('source', '') || '';
    } catch (e) { /* 非 HTTP 上下文 */ }
    if (!v && c && c.body && typeof c.body === 'object') v = c.body.sourceId || c.body.source || '';
    return String(v || '').trim();
  }

  /**
   * 解析请求要用的下载源，并断言它声明了本次需要的能力。
   * 未注册的源与缺能力的源都不抛异常，返回 { source:null, error:中文 }，路由用 400 回绝。
   * @param {object} c 请求上下文
   * @param {string} [capability] 本路由需要的能力名（见 sources/types.mjs 的 CAPABILITIES）
   * @returns {{source:object|null, sourceId:string, error:string, code:string}}
   */
  function pickSource(c, capability) {
    const id = requestedSourceId(c);
    try {
      const source = sources.get(id || undefined);
      if (capability) sources.requireCapability(source, capability);
      return { source: source, sourceId: source.meta.id, error: '', code: '' };
    } catch (err) {
      // 能力缺失（NotSupportedError）带出 code，路由据此回机器可读的 NOT_SUPPORTED
      return {
        source: null,
        sourceId: id,
        error: err && err.message ? err.message : String(err),
        code: err && err.code ? String(err.code) : ''
      };
    }
  }

  /**
   * 取源失败的统一响应：未知源回 400 + 中文；来源不支持该能力时额外带 code=NOT_SUPPORTED。
   * @param {object} c 请求上下文
   * @param {{error:string, code:string}} picked pickSource 的失败结果
   */
  function replyPickedError(c, picked) {
    const extra = picked && picked.code === 'NOT_SUPPORTED' ? { code: 'NOT_SUPPORTED' } : undefined;
    c.error(400, picked && picked.error ? picked.error : '下载源不可用', extra);
  }

  /**
   * 取全部章节（契约语义）：优先用可选的 chaptersAll，否则用必备的 chapters 自己翻页。
   * 缺 chapters 能力时抛中文 NotSupportedError，由路由的 replySourceError 降级成 400。
   */
  async function chaptersAllOf(source, comicId) {
    if (typeof source.chaptersAll === 'function') return await source.chaptersAll(comicId);
    sources.requireCapability(source, 'chapters');
    const out = [];
    let page = 1;
    let pages = 1;
    do {
      const res = await source.chapters(comicId, { page: page });
      for (const ch of (res && res.docs) || []) out.push(ch);
      pages = Math.max(1, Number((res && res.pages) || 1));
      page++;
    } while (page <= pages);
    out.sort(function (a, b) { return Number(a.order || 0) - Number(b.order || 0); });
    return out;
  }

  /** 取全部收藏（契约语义）：优先用可选的 favoritesAll，否则用必备的 favorites 自己翻页。 */
  async function favoritesAllOf(source, options) {
    if (typeof source.favoritesAll === 'function') return await source.favoritesAll(options || {});
    sources.requireCapability(source, 'favorites');
    const maxPages = Math.max(1, Number((options || {}).maxPages || 30));
    const first = await source.favorites({ page: 1, sort: (options || {}).sort });
    const docs = (first && first.docs ? first.docs : []).slice();
    const pages = Math.min(maxPages, Math.max(1, Number((first && first.pages) || 1)));
    for (let page = 2; page <= pages; page++) {
      const more = await source.favorites({ page: page, sort: (options || {}).sort });
      for (const d of (more && more.docs) || []) docs.push(d);
    }
    return { total: Number((first && first.total) || docs.length), pages: pages, docs: docs };
  }

  /**
   * 把「下载源」层错误统一降级成 400 + { ok:false, error:中文 }：
   * 该源不支持这个能力（NotSupportedError）绝不应该表现成 500。
   * @returns {boolean} true 表示已经写过响应，上层不要再写
   */
  function replySourceError(c, err) {
    const notSupported = (err instanceof sources.NotSupportedError) || (err && err.code === 'NOT_SUPPORTED');
    if (!notSupported) return false;
    // 契约：来源不支持必须带机器可读的 code=NOT_SUPPORTED，前端据此走降级分支而不是当普通错误弹窗
    c.error(400, err && err.message ? err.message : '该下载源不支持此能力', { code: 'NOT_SUPPORTED' });
    return true;
  }

  /**
   * 契约外的来源专有动作（注册 / 找回密码）走适配器暴露的底层客户端。
   * 适配器没暴露 client 时抛中文「不支持」，由调用处的 catch 降级。
   */
  function rawClientOf(source) {
    if (!source || !source.client) {
      throw sources.notSupported('raw', { sourceId: source && source.meta ? source.meta.id : '' });
    }
    return source.client;
  }

  /** 任务里存来源原始对象（保真）：统一 Comic 未建模的字段（thumb / creator / …）由它兜底。 */
  function taskComicOf(comic) {
    if (!comic) return null;
    return comic.raw || comic;
  }

  /** 统一 Comic 的封面 → 本地封面代理地址（拿不到封面时给空串，与改造前一致）。 */
  function coverPathOf(comic) {
    const cover = comic && comic.cover ? String(comic.cover) : '';
    return cover ? coverUrlFor(cover) : '';
  }

  /** 导出目录：picacomic.exportDir > downloadRoot/_导出 */
  async function exportDir() {
    const p = String(picaCfg().exportDir || '').trim();
    if (p) return path.resolve(p);
    return path.join(root(), '_导出');
  }

  /**
   * 本地库查找：共享索引优先（多库根），索引没扫到就读盘兜底。
   */
  async function localComic(comicId, title) {
    const r = root();
    let dir = '';
    let localTitle = '';
    let fromIndex = false;
    try {
      const hit = (await findComicById(String(comicId))) || (title ? await findByDir(String(title)) : null);
      if (hit && hit.dir) {
        dir = path.isAbsolute(hit.dir) ? hit.dir : path.join(r || '', String(hit.dir));
        localTitle = hit.title || '';
        fromIndex = true;
      }
    } catch (e) { /* 索引不可用就退回扫盘 */ }
    if (!dir && r) {
      const scan = await findComicDirById(r, comicId, { altTitle: title });
      if (scan) {
        dir = scan.dir;
        localTitle = (scan.meta && scan.meta.title) || '';
      }
    }
    if (!dir) {
      // 多库根：用目录名在其它根里再找一次
      try {
        const hit2 = title ? await findByDir(String(title)) : null;
        if (hit2 && hit2.dir) {
          dir = path.isAbsolute(hit2.dir) ? hit2.dir : path.join(root() || '', String(hit2.dir));
          localTitle = hit2.title || '';
          fromIndex = true;
        }
      } catch (e) { /* ignore */ }
    }
    if (!dir) return null;
    const owner = ownerRootOf(cfg(), dir);
    if (r && !owner && !isInside(r, dir)) return null;
    let images = 0;
    let bytes = 0;
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const s = await chapterStats(path.join(dir, ent.name));
        images += s.count;
        bytes += s.bytes;
      }
    } catch (e) { /* ignore */ }
    return {
      comicId: String(comicId), dir: dir, fromIndex: fromIndex,
      rootId: owner ? owner.id : null,
      rootName: owner ? owner.name : labelOf(cfg(), dir),
      title: localTitle || title || path.basename(dir), images: images, bytes: bytes
    };
  }

  /** 找本地漫画目录（支持从库索引里的相对 dir 也解析）。 */
  async function resolveLocalDir(comicId, title) {
    const hit = await localComic(comicId, title);
    return hit ? hit.dir : '';
  }

  /** 磁盘占用统计（目录递归）。 */
  async function dirSize(dir) {
    let total = 0;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries = [];
      try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch (e) { continue; }
      for (const ent of entries) {
        const abs = path.join(cur, ent.name);
        if (ent.isDirectory()) { stack.push(abs); continue; }
        try { total += (await fsp.stat(abs)).size; } catch (e) { /* ignore */ }
      }
    }
    return total;
  }

  /* ================= 登录 / 账号 ================= */

  app.post('/api/download/login', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const remember = body.remember === true || body.remember === 'true';
    if (!email) { c.error(400, '请输入邮箱/用户名'); return; }
    if (!password) { c.error(400, '请输入密码'); return; }
    await currentProxy();
    const picked = pickSource(c, 'login');
    if (!picked.source) { c.error(400, picked.error); return; }
    try {
      // 契约里的 login：内部就是 POST auth/sign-in 且不带 authorization（过期 token 不该挡住登录）
      const login = await picked.source.login({ email: email, password: password });
      const token = String(login.token || '');
      if (!token) { c.error(502, '登录响应里没有 token，可能是上游接口变更'); return; }
      await ctx.saveConfig({ picacomic: { token: token } });
      const account = auth.normalizeProfile(login.user || login.raw || {});
      await auth.saveAccount(account, true);
      if (remember) {
        try { await auth.rememberCredential(email, password); } catch (e) { logger.warn('保存登录信息失败：' + e.message); }
      } else {
        try { await auth.forgetCredential(email); } catch (e) { /* ignore */ }
      }
      accountCheck.at = Date.now();
      hub.send('account', { status: 'login', ...tokenInfo(), account: account });
      logger.info('哔咔登录成功：' + (account.name || email));
      c.json({ ok: true, message: '登录成功', ...tokenInfo(), account: account, remember: remember });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      let reason = '登录失败：' + (err && err.message ? err.message : err);
      if (status === 401) reason = '邮箱或密码不正确，或上游拒绝了本次登录（哔咔返回 401 unauthorized）';
      else if (status === 400) reason = '邮箱或密码格式不正确，请检查后重试';
      else if (status === 429) reason = '登录过于频繁，请稍后再试';
      logger.warn('登录失败：' + reason);
      c.error(status === 401 || status === 400 ? 401 : 502, reason);
    }
  });

  app.post('/api/download/logout', async function (c) {
    await ctx.saveConfig({ picacomic: { token: '' } });
    await auth.clearAccount();
    accountCheck.at = 0;
    hub.send('account', { status: 'logout', ...tokenInfo(), account: null });
    c.json({ ok: true, message: '已退出登录', ...tokenInfo() });
  });

  app.post('/api/download/register', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const name = String(body.name || '').trim();
    if (!email || !password || !name) { c.error(400, '请填写邮箱、密码与昵称'); return; }
    if (password.length < 6) { c.error(400, '密码至少 6 位'); return; }
    await currentProxy();
    const picked = pickSource(c);
    if (!picked.source) { c.error(400, picked.error); return; }
    try {
      // 注册尚未纳入契约：走适配器暴露的底层客户端，路径/请求体与改造前逐字一致
      const payload = { email: email, password: password, name: name };
      const invite = String(body.inviteCode === undefined || body.inviteCode === null ? '' : body.inviteCode);
      if (invite) payload.inviteCode = invite;
      const res = await rawClientOf(picked.source).raw('POST', 'auth/register', payload, false);
      const r = (res && res.data) || {};
      c.json({ ok: true, message: '注册请求已提交', data: r });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      let reason = '注册失败：' + (err && err.message ? err.message : err);
      if (status === 401 || status === 403) reason = '上游已关闭注册或需要邀请码（哔咔返回 ' + status + '），请到哔咔官方渠道注册后再回来登录';
      else if (status === 400) reason = '注册信息不符合要求（邮箱已占用或格式不合法）';
      c.error(status === 400 ? 400 : 502, reason);
    }
  });

  app.post('/api/download/forgot', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const email = String(body.email || '').trim();
    if (!email) { c.error(400, '请输入注册邮箱'); return; }
    await currentProxy();
    const picked = pickSource(c);
    if (!picked.source) { c.error(400, picked.error); return; }
    try {
      await rawClientOf(picked.source).raw('POST', 'auth/forgot-password', { email: email }, false);
      c.json({ ok: true, message: '重置邮件请求已提交，请检查邮箱' });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      c.error(502, status === 404 ? '上游没有提供找回密码接口，请到哔咔 App 内操作' : ('找回密码失败：' + (err && err.message ? err.message : err)));
    }
  });

  app.get('/api/download/account', async function (c) {
    const data = await auth.loadAccount();
    const info = tokenInfo();
    const out = {
      ok: true,
      ...info,
      account: data.account || null,
      tokenOk: Boolean(data.tokenOk),
      checkedAt: data.tokenCheckedAt || null,
      remembered: await auth.listCredentials(),
      credentialsNote: auth.CREDENTIALS_NOTE
    };
    // 10 分钟缓存：不每次打上游，但 token 变了要立刻校验
    if (!info.hasToken) { out.tokenOk = false; c.json(out); return; }
    if (!auth.needsRefresh(data, 600000) && Date.now() - accountCheck.at > 5000) { c.json(out); return; }
    accountCheck.at = Date.now();
    const picked = pickSource(c, 'profile');
    if (!picked.source) { c.error(400, picked.error); return; }
    try {
      await currentProxy();
      const profile = await picked.source.profile();
      // 账号缓存保留来源原始字段（slogan / gender / characters 不在统一契约里）
      const account = auth.normalizeProfile(profile.raw || profile);
      await auth.saveAccount(account, true);
      out.account = account;
      out.tokenOk = true;
      out.checkedAt = new Date().toISOString();
      c.json(out);
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      if (status === 401 || status === 403) {
        // token 失效：自动清理，避免前端一直拿着废 token 打上游
        await ctx.saveConfig({ picacomic: { token: '' } });
        await auth.clearAccount();
        hub.send('account', { status: 'expired', ...tokenInfo(), account: null });
        out.hasToken = false;
        out.tokenPreview = '';
        out.tokenOk = false;
        out.account = null;
        out.message = '登录已过期，请重新登录';
        c.json({ ok: true, ...out });
        return;
      }
      out.tokenOk = false;
      out.message = '账号校验失败：' + (err && err.message ? err.message : err);
      c.json(out);
    }
  });

  /* ================= 排行榜 / 账号资料 ================= */

  /**
   * 排行榜：GET /api/download/leaderboard?tt=H24|D7|D30&ct=VC&page=N。
   * 哔咔上游一次返回全榜（不分页，pages 固定为 1），tt 取值统一由注册表的 RANK_TYPES 约束；
   * ct 只支持 VC，其余取值由适配器抛 NotSupportedError，这里降级成带 code=NOT_SUPPORTED 的 400。
   * comics 元素与 /api/download/search 的 element 逐字同形，前端复用同一个卡片渲染器。
   */
  app.get('/api/download/leaderboard', async function (c) {
    const tt = String(c.query('tt', '') || '').trim() || 'H24';
    const ct = String(c.query('ct', '') || '').trim() || 'VC';
    const page = Math.max(1, c.queryInt('page', 1));
    if (sources.RANK_TYPES.indexOf(tt) < 0) {
      c.error(400, '排行榜周期 tt 只支持 ' + sources.RANK_TYPES.join('/') + '，收到：' + tt);
      return;
    }
    if (!requireToken(c)) return;
    const picked = pickSource(c, 'leaderboard');
    if (!picked.source) { replyPickedError(c, picked); return; }
    await currentProxy();
    try {
      const data = await picked.source.leaderboard({ rankType: tt, ct: ct });
      const docs = Array.isArray(data.docs) ? data.docs : [];
      const comics = [];
      for (const d of docs) {
        const id = String(d.id || '');
        const cover = coverPathOf(d);
        const local = await localComic(id, d.title || '');
        comics.push({
          id: id,
          title: d.title || '',
          author: d.author || '',
          cover: cover,
          tags: (d.tags || []).slice(0, 8),
          categories: (d.categories || []).slice(0, 6),
          chapterCount: Number(d.chapterCount || 0),
          likes: Number(d.likes || 0),
          finished: Boolean(d.finished),
          inLibrary: Boolean(local),
          localDir: local ? local.dir : null,
          rootName: local ? local.rootName : null
        });
      }
      c.json({
        ok: true,
        source: picked.sourceId,
        rankType: String(data.rankType || tt),
        ct: String(data.ct || ct),
        page: Number(data.page || page),
        pages: Number(data.pages || 1),
        total: Number(data.total || comics.length),
        comics: comics
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      if (status === 401 || status === 403) { c.error(401, '登录已过期或 token 无效，请重新登录后再看排行榜'); return; }
      c.error(502, '获取排行榜失败：' + (err && err.message ? err.message : err));
    }
  });

  /**
   * 当前登录账号资料：GET /api/download/profile。
   * 只读路由，不写任何账号缓存；对外只暴露契约约定的七个字段（raw 不出去）。
   */
  app.get('/api/download/profile', async function (c) {
    if (!requireToken(c)) return;
    const picked = pickSource(c, 'profile');
    if (!picked.source) { replyPickedError(c, picked); return; }
    await currentProxy();
    try {
      const p = await picked.source.profile();
      c.json({
        ok: true,
        source: picked.sourceId,
        profile: {
          id: String(p.id || ''),
          name: p.name || '',
          email: p.email || '',
          // 头像同样是哔咔 CDN 直链，必须转成后端封面代理地址：
          // 前端（浏览器）拿不到代理，直连 CDN 只会得到裂图。与卡片封面同一条链路。
          avatar: p.avatar ? coverUrlFor(String(p.avatar)) : '',
          level: Number(p.level || 0),
          exp: Number(p.exp || 0),
          /* 哔咔没有 role 字段（实测未返回），真正有值的是头衔与认证状态，一并透传。 */
          role: p.role || '',
          title: p.title || '',
          verified: Boolean(p.verified)
        }
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      if (status === 401 || status === 403) { c.error(401, '登录已过期或 token 无效，请重新登录'); return; }
      c.error(502, '读取账号资料失败：' + (err && err.message ? err.message : err));
    }
  });

  /* ================= 状态 / 代理 / 配置 ================= */

  app.get('/api/download/state', async function (c) {
    try {
      const r = root();
      let rootExists = false;
      try { rootExists = (await fsp.stat(r)).isDirectory(); } catch (e) { rootExists = false; }
      const free = r ? await diskFree(r) : null;
      const st = tasks.status();
      const proxy = await currentProxy();
      const acct = await auth.loadAccount();
      const rr = await probeRoots(cfg());
      c.json({
        ok: true,
        ...tokenInfo(),
        downloadRoot: r,
        rootExists: rootExists,
        freeBytes: free,
        format: picaCfg().downloadFormat || 'Jpeg',
        ext: extOfFormat(picaCfg().downloadFormat || 'Jpeg'),
        dirFmt: picaCfg().dirFmt || '{comic_title}/{order} {chapter_title}',
        apiBase: picaCfg().apiBase || 'https://picaapi.picacomic.com',
        proxy: proxy.url || null,
        proxyInfo: proxy,
        exportDir: await exportDir(),
        roots: rr,
        libraryRoots: rr.map(function (x) { return { id: x.id, name: x.name, dirs: x.dirs, enabled: x.enabled }; }),
        account: acct.account || null,
        tokenOk: Boolean(acct.tokenOk),
        concurrency: {
          chapterConcurrency: Number(picaCfg().chapterConcurrency || 2),
          chapterIntervalMs: Number(picaCfg().chapterIntervalMs === undefined ? (picaCfg().chapterDownloadIntervalSec || 0) * 1000 : picaCfg().chapterIntervalMs),
          imgConcurrency: Number(picaCfg().imgConcurrency || 8),
          imgIntervalMs: Number(picaCfg().imgIntervalMs === undefined ? (picaCfg().imgDownloadIntervalSec || 0) * 1000 : picaCfg().imgIntervalMs),
          maxConcurrentTasks: Number(picaCfg().maxConcurrentTasks || 2),
          retryTimes: Number(picaCfg().retryTimes || 3),
          globalSpeedLimitKb: Number(picaCfg().globalSpeedLimitKb || 0)
        },
        runningTasks: st.runningTasks,
        queuedTasks: st.queuedTasks,
        totalTasks: st.totalTasks,
        exportBusy: exports.isBusy(),
        serverStartedAt: (tasks.store.data && tasks.store.data.serverStartedAt) || null,
        sseClients: sse.clientCount(),
        sseStats: sse.stats()
      });
    } catch (err) {
      c.error(500, '读取下载模块状态失败：' + (err && err.message ? err.message : err));
    }
  });

  app.get('/api/download/proxy-test', async function (c) {
    try {
      const proxy = await currentProxy();
      const apiBase = String(picaCfg().apiBase || 'https://picaapi.picacomic.com');
      let host = 'picaapi.picacomic.com';
      let port = 443;
      let tlsOk = true;
      try {
        const u = new URL(apiBase);
        host = u.hostname;
        port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
        tlsOk = u.protocol === 'https:';
      } catch (e) { /* 用默认 */ }
      const result = await testConnection({ host: host, port: port, tls: tlsOk, proxy: proxy.url, timeoutMs: 8000 });
      c.json({ ok: true, proxy: proxy, result: result });
    } catch (err) {
      c.error(502, '代理测试失败：' + (err && err.message ? err.message : err));
    }
  });

  /** 热更新下载相关配置（写回 config.json，立即生效）。 */
  app.post('/api/download/config', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const patch = {};
    const errors = [];
    function numField(key, min, max) {
      if (body[key] === undefined || body[key] === '') return;
      const v = Number(body[key]);
      if (!Number.isFinite(v) || v < min || v > max) { errors.push(key + ' 需要在 ' + min + '~' + max + ' 之间'); return; }
      patch[key] = Math.round(v);
    }
    numField('chapterConcurrency', 1, 16);
    numField('imgConcurrency', 1, 64);
    numField('chapterIntervalMs', 0, 600000);
    numField('imgIntervalMs', 0, 600000);
    numField('retryTimes', 0, 10);
    numField('timeoutMs', 3000, 300000);
    numField('maxConcurrentTasks', 1, 4);
    numField('globalSpeedLimitKb', 0, 1024 * 100);
    if (body.downloadFormat !== undefined) {
      const fmt = String(body.downloadFormat);
      if (['Jpeg', 'Webp', 'Png', 'Original'].indexOf(fmt) < 0) errors.push('downloadFormat 只能是 Jpeg/Webp/Png/Original');
      else patch.downloadFormat = fmt;
    }
    if (body.dirFmt !== undefined) {
      const fmt = String(body.dirFmt);
      if (!fmt || fmt.length > 200 || fmt.indexOf('..') >= 0) errors.push('dirFmt 不合法');
      else patch.dirFmt = fmt;
    }
    if (body.shouldDownloadCover !== undefined) patch.shouldDownloadCover = Boolean(body.shouldDownloadCover);
    if (body.proxyMode !== undefined) {
      const m = String(body.proxyMode);
      if (['none', 'system', 'manual'].indexOf(m) < 0) errors.push('proxyMode 只能是 none/system/manual');
      else patch.proxyMode = m;
    }
    if (body.proxyHost !== undefined) patch.proxyHost = String(body.proxyHost).trim().slice(0, 120);
    if (body.proxyPort !== undefined) {
      const p = Number(body.proxyPort);
      if (!Number.isFinite(p) || (p < 0 || p > 65535)) errors.push('proxyPort 不合法');
      else patch.proxyPort = Math.round(p);
    }
    if (body.exportDir !== undefined) patch.exportDir = String(body.exportDir).trim().slice(0, 400);
    if (errors.length) { c.error(400, '配置未通过校验：' + errors.join('；')); return; }
    if (!Object.keys(patch).length) { c.error(400, '没有需要更新的配置项'); return; }
    try {
      await ctx.saveConfig({ picacomic: patch });
      hub.send('config', { changed: Object.keys(patch), at: new Date().toISOString() });
      c.json({ ok: true, changed: patch, message: '配置已保存并即时生效' });
    } catch (err) {
      c.error(500, '保存配置失败：' + (err && err.message ? err.message : err));
    }
  });

  /* ================= 搜索 / 详情 ================= */

  app.get('/api/download/search', async function (c) {
    const q = String(c.query('q', '') || '').trim();
    const page = Math.max(1, c.queryInt('page', 1));
    if (!q) { c.error(400, '请输入搜索关键字'); return; }
    if (!requireToken(c)) return;
    const picked = pickSource(c, 'search');
    if (!picked.source) { c.error(400, picked.error); return; }
    await currentProxy();
    try {
      const data = await picked.source.search(q, { page: page });
      const docs = Array.isArray(data.docs) ? data.docs : [];
      const items = [];
      for (const d of docs) {
        const id = String(d.id || '');
        const cover = coverPathOf(d);
        const local = await localComic(id, d.title || '');
        items.push({
          id: id,
          title: d.title || '',
          author: d.author || '',
          cover: cover,
          tags: (d.tags || []).slice(0, 8),
          categories: (d.categories || []).slice(0, 6),
          chapterCount: Number(d.chapterCount || 0),
          likes: Number(d.likes || 0),
          finished: Boolean(d.finished),
          inLibrary: Boolean(local),
          localDir: local ? local.dir : null,
          rootName: local ? local.rootName : null
        });
      }
      c.json({
        ok: true, query: q,
        page: Number(data.page || page),
        pages: Number(data.pages || 1),
        total: Number(data.total || items.length),
        items: items
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '搜索失败：' + (err && err.message ? err.message : err));
    }
  });

  app.get('/api/download/comic/:id', async function (c) {
    if (!requireToken(c)) return;
    const id = String(c.params.id || '');
    const picked = pickSource(c, 'comic');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();
    try {
      const comic = await src.comic(id);
      const chapters = await chaptersAllOf(src, id);
      const p = paths();
      const title = comic.title || id;
      const states = await scanChapterStates(p.comicDir(title), chapters, p, { title: title, comicId: id });
      const local = await localComic(id, title);
      const chaptersOut = chapters.map(function (ch) {
        const s = states[String(ch.order)] || {};
        return {
          chapterId: String(ch.chapterId || ''),
          chapterTitle: ch.chapterTitle || ('第 ' + ch.order + ' 话'),
          order: Number(ch.order || 0),
          updatedAt: ch.updatedAt || null,
          downloaded: Boolean(s.exists),
          complete: Boolean(s.done),
          images: Number(s.images || 0),
          bytes: Number(s.bytes || 0)
        };
      });
      const downloadedChapters = chaptersOut.filter(function (x) { return x.complete || x.downloaded; }).length;
      c.json({
        ok: true,
        comic: {
          id: id, title: title, author: comic.author || '',
          cover: coverPathOf(comic),
          description: comic.description || '',
          tags: comic.tags || [], categories: comic.categories || [],
          pagesCount: Number(comic.pagesCount || 0),
          chapterCount: Number(comic.chapterCount || chapters.length),
          finished: Boolean(comic.finished),
          likesCount: Number(comic.likes || 0),
          viewsCount: Number(comic.views || 0),
          chineseTeam: comic.chineseTeam || '',
          createdAt: comic.createdAt || null, updatedAt: comic.updatedAt || null,
          inLibrary: Boolean(local), localDir: local ? local.dir : null,
          downloadedChapters: downloadedChapters
        },
        chapters: chaptersOut
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '获取漫画详情失败：' + (err && err.message ? err.message : err));
    }
  });

  app.get('/api/download/comic/:id/chapters', async function (c) {
    if (!requireToken(c)) return;
    const id = String(c.params.id || '');
    const picked = pickSource(c, 'comic');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();
    try {
      const qTitle = String(c.query('title', '') || '');
      let title = qTitle;
      if (!title) {
        const comic = await src.comic(id);
        title = comic.title || id;
      }
      const chapters = await chaptersAllOf(src, id);
      const p = paths();
      const states = await scanChapterStates(p.comicDir(title), chapters, p, { title: title, comicId: id });
      const items = chapters.map(function (ch) {
        const s = states[String(ch.order)] || {};
        return {
          chapterId: String(ch.chapterId || ''),
          chapterTitle: ch.chapterTitle || ('第 ' + ch.order + ' 话'),
          order: Number(ch.order || 0),
          downloaded: Boolean(s.exists), complete: Boolean(s.done),
          images: Number(s.images || 0), bytes: Number(s.bytes || 0), dir: s.dir || ''
        };
      });
      c.json({ ok: true, comicId: id, title: title, comicDir: p.comicDir(title), chapters: items });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '获取章节列表失败：' + (err && err.message ? err.message : err));
    }
  });

  /* ================= 收藏夹 ================= */

  app.get('/api/download/favorites', async function (c) {
    if (!requireToken(c)) return;
    const page = Math.max(1, c.queryInt('page', 1));
    /* 必须把前端传的 sort 透传给适配器：适配器对未传值默认 dd，
       漏传会让「点最早收藏仍按最新收藏拉取」——界面上完全看不出来，
       只有对比上游请求（s=dd / s=da）才发现。 */
    const sort = String(c.query('sort', 'dd') || 'dd');
    const picked = pickSource(c, 'favorites');
    if (!picked.source) { c.error(400, picked.error); return; }
    await currentProxy();
    try {
      const data = await picked.source.favorites({ page: page, sort: sort });
      const docs = Array.isArray(data.docs) ? data.docs : [];
      const items = [];
      for (const d of docs) {
        const id = String(d.id || '');
        const local = await localComic(id, d.title || '');
        items.push({
          id: id, title: d.title || '', author: d.author || '',
          cover: coverPathOf(d),
          tags: (d.tags || []).slice(0, 6),
          chapterCount: Number(d.chapterCount || 0),
          likes: Number(d.likes || 0),
          finished: Boolean(d.finished),
          inLibrary: Boolean(local), localDir: local ? local.dir : null
        });
      }
      c.json({ ok: true, page: Number(data.page || page), pages: Number(data.pages || 1), total: Number(data.total || items.length), items: items });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '获取收藏夹失败：' + (err && err.message ? err.message : err));
    }
  });

  app.post('/api/download/favorites/sync', async function (c) {
    if (!requireToken(c)) return;
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const comicIds = Array.isArray(body.comicIds) ? body.comicIds.map(String) : [];
    const takeAll = body.all === true || body.all === 'true';
    if (!comicIds.length && !takeAll) { c.error(400, '请指定要同步的漫画（comicIds）或勾选全部'); return; }
    const picked = pickSource(c, 'favorites');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();
    try {
      let docs = [];
      if (takeAll) {
        const fav = await favoritesAllOf(src, { maxPages: Math.max(1, Number(body.maxPages || 20)) });
        docs = fav.docs || [];
      } else {
        docs = comicIds.map(function (id) { return { _id: id }; });
      }
      const result = { queued: [], skipped: [], failed: [] };
      for (const d of docs) {
        const id = String(d.id || d._id || '');
        if (!id) continue;
        try {
          const local = await localComic(id, d.title || '');
          if (local) { result.skipped.push({ comicId: id, title: local.title, reason: '已在库' }); continue; }
          const dup = tasks.list().filter(function (t) { return String(t.comicId) === id && t.state !== 'done' && t.state !== 'canceled'; })[0];
          if (dup) { result.skipped.push({ comicId: id, title: dup.title, reason: '已有任务' }); continue; }
          const comic = await src.comic(id);
          const all = await chaptersAllOf(src, id);
          if (!all.length) { result.skipped.push({ comicId: id, title: comic.title, reason: '没有章节' }); continue; }
          const p = paths();
          const title = String(comic.title || id);
          const states = await scanChapterStates(p.comicDir(title), all, p, { title: title, comicId: id });
          const sections = all.map(function (ch) {
            return {
              chapterId: String(ch.chapterId || ''),
              chapterTitle: ch.chapterTitle || ('第 ' + ch.order + ' 话'),
              order: Number(ch.order || 0),
              alreadyDone: Boolean((states[String(ch.order)] || {}).done)
            };
          });
          const task = await engine.createTask({
            comicId: id, sourceId: src.meta.id, title: title, author: comic.author || '',
            cover: coverPathOf(comic),
            comic: taskComicOf(comic), chapters: sections, priority: Number(body.priority || 0)
          });
          engine.enqueue(task);
          result.queued.push({ comicId: id, taskId: task.id, title: title, chapters: sections.length });
        } catch (err) {
          result.failed.push({ comicId: id, error: err && err.message ? err.message : String(err) });
        }
      }
      hub.send('state', { tasks: tasks.list(), stats: tasks.status() });
      c.json({
        ok: true, ...result,
        message: '同步完成：入队 ' + result.queued.length + ' 部 / 跳过 ' + result.skipped.length + ' 部 / 失败 ' + result.failed.length + ' 部'
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '同步收藏夹失败：' + (err && err.message ? err.message : err));
    }
  });

  /* ================= 已下载漫画更新 ================= */

  app.post('/api/download/update-check', async function (c) {
    if (!requireToken(c)) return;
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const limit = Math.max(1, Math.min(200, Number(body.limit || 40)));
    const picked = pickSource(c, 'comic');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();
    try {
      const comics = (await listComics()).filter(function (x) { return x && x.id; });
      const targets = comics.slice(0, limit);
      const results = [];
      // 串行 + 小延迟：避免把上游打爆
      for (const comic of targets) {
        try {
          const chapters = await chaptersAllOf(src, comic.id);
          const localCount = Number(comic.chapters || comic.chapterCount || 0);
          const localOrders = Array.isArray(comic.chapterOrders) ? comic.chapterOrders : null;
          let newOnes;
          if (localOrders && localOrders.length) {
            const set = new Set(localOrders.map(String));
            newOnes = chapters.filter(function (ch) { return !set.has(String(ch.order)); });
          } else {
            // 没有明细时用章节数推断：上游比本地多出来的就是新的
            newOnes = chapters.length > localCount ? chapters.slice(localCount) : [];
          }
          results.push({
            comicId: comic.id,
            title: comic.title || '',
            dir: comic.dir || '',
            localChapters: localCount,
            remoteChapters: chapters.length,
            newChapters: newOnes.map(function (ch) { return { order: Number(ch.order || 0), title: ch.chapterTitle || '' }; })
          });
        } catch (err) {
          results.push({ comicId: comic.id, title: comic.title || '', error: err && err.message ? err.message : String(err) });
        }
      }
      const withNew = results.filter(function (r) { return r.newChapters && r.newChapters.length; });
      c.json({
        ok: true,
        checked: results.length,
        withUpdates: withNew.length,
        items: results,
        message: '检查 ' + results.length + ' 部，' + withNew.length + ' 部有新章节'
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '更新检测失败：' + (err && err.message ? err.message : err));
    }
  });

  app.post('/api/download/update', async function (c) {
    if (!requireToken(c)) return;
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const comicIds = Array.isArray(body.comicIds) ? body.comicIds.map(String) : [];
    if (!comicIds.length) { c.error(400, '请指定要更新的漫画'); return; }
    const picked = pickSource(c, 'comic');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();
    try {
      const queued = [];
      const skipped = [];
      for (const id of comicIds) {
        try {
          const local = await localComic(id, '');
          if (!local) { skipped.push({ comicId: id, reason: '本地没有这部漫画，请先下载' }); continue; }
          const chapters = await chaptersAllOf(src, id);
          const p = paths();
          const states = await scanChapterStates(local.dir, chapters, p, { title: local.title, comicId: id });
          const missing = chapters.filter(function (ch) { return !(states[String(ch.order)] || {}).done; });
          if (!missing.length) { skipped.push({ comicId: id, title: local.title, reason: '已是最新' }); continue; }
          const dup = tasks.list().filter(function (t) { return String(t.comicId) === id && t.state !== 'done' && t.state !== 'canceled'; })[0];
          if (dup) { skipped.push({ comicId: id, title: local.title, reason: '已有任务在跑' }); continue; }
          const comic = await src.comic(id);
          const task = await engine.createTask({
            comicId: id, sourceId: src.meta.id, title: local.title || comic.title, author: comic.author || '',
            cover: coverPathOf(comic),
            comic: taskComicOf(comic),
            chapters: missing.map(function (ch) {
              return { chapterId: String(ch.chapterId || ''), chapterTitle: ch.chapterTitle || ('第 ' + ch.order + ' 话'), order: Number(ch.order || 0) };
            }),
            priority: Number(body.priority || 1)
          });
          engine.enqueue(task);
          queued.push({ comicId: id, taskId: task.id, title: task.title, newChapters: missing.length });
        } catch (err) {
          skipped.push({ comicId: id, reason: err && err.message ? err.message : String(err) });
        }
      }
      c.json({ ok: true, queued: queued, skipped: skipped, message: '已入队 ' + queued.length + ' 部更新（只下新章节）' });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '增量更新失败：' + (err && err.message ? err.message : err));
    }
  });

  /* ================= 任务 ================= */

  app.post('/api/download/tasks', async function (c) {
    if (!requireToken(c)) return;
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const comicId = String(body.comicId || '').trim();
    if (!comicId) { c.error(400, '缺少 comicId 参数'); return; }
    if (comicId.length > 64) { c.error(400, 'comicId 不合法'); return; }
    if (!root()) { c.error(400, '未配置下载根目录，请到「设置」里填写'); return; }
    const picked = pickSource(c, 'comic');
    if (!picked.source) { c.error(400, picked.error); return; }
    const src = picked.source;
    await currentProxy();

    try {
      const title0 = String(body.title || '');
      const local = await localComic(comicId, title0);
      if (local) {
        c.json({ ok: true, reused: true, reason: 'already_in_library', message: '《' + (local.title || title0) + '》已在库中，无需重复下载', dir: local.dir, comicId: comicId });
        return;
      }
      const dup = tasks.list().filter(function (t) {
        return String(t.comicId) === comicId && t.state !== 'done' && t.state !== 'canceled';
      })[0];
      if (dup) {
        c.json({ ok: true, reused: true, reason: 'already_queued', message: '该漫画已有下载任务（' + stateText(dup.state) + '），已复用', task: dup });
        return;
      }
      const comic = await src.comic(comicId);
      const all = await chaptersAllOf(src, comicId);
      if (!all.length) { c.error(400, '该漫画没有可下载的章节'); return; }
      const wanted = Array.isArray(body.chapters) && body.chapters.length
        ? all.filter(function (ch) { return body.chapters.map(String).indexOf(String(ch.order)) >= 0; })
        : all;
      if (!wanted.length) { c.error(400, '选中的章节在漫画里不存在'); return; }

      // 磁盘空间预检：按「平均章节体积 × 待下章节」粗估，不足直接拒绝
      const p = paths();
      const title = String(body.title || comic.title || comicId);
      const states = await scanChapterStates(p.comicDir(title), wanted, p, { title: title, comicId: comicId });
      const sections = wanted.map(function (ch) {
        const s = states[String(ch.order)] || {};
        return {
          chapterId: String(ch.chapterId || ''),
          chapterTitle: ch.chapterTitle || ('第 ' + ch.order + ' 话'),
          order: Number(ch.order || 0),
          alreadyDone: Boolean(s.done)
        };
      });
      const toDownload = sections.filter(function (s) { return !s.alreadyDone; });
      const free = await diskFree(root());
      let avgChapter = 0;
      if (comic.pagesCount && comic.chapterCount) avgChapter = (Number(comic.pagesCount) / Math.max(1, Number(comic.chapterCount))) * 250 * 1024;
      else avgChapter = 30 * 250 * 1024;
      const expectBytes = Math.round(avgChapter * toDownload.length);
      if (free !== null && expectBytes > 0 && free - expectBytes < 512 * 1024 * 1024 && body.force !== true) {
        c.error(507, '磁盘空间不足：预计需要 ' + (expectBytes / 1048576).toFixed(1) + 'MB，当前可用 ' + (free / 1048576).toFixed(1) + 'MB（至少保留 512MB）。可清理后重试，或用 force:true 强制加入');
        return;
      }

      const task = await engine.createTask({
        comicId: comicId, sourceId: src.meta.id, title: title, author: comic.author || '',
        cover: coverPathOf(comic),
        comic: taskComicOf(comic), chapters: sections, priority: Number(body.priority || 0)
      });
      engine.enqueue(task);
      logger.info('新建下载任务 ' + task.id + '：《' + title + '》' + sections.length + ' 章');
      c.json({ ok: true, reused: false, task: tasks.get(task.id), expectBytes: expectBytes, freeBytes: free });
    } catch (err) {
      if (replySourceError(c, err)) return;
      c.error(err && err.status === 401 ? 401 : 502, '创建下载任务失败：' + (err && err.message ? err.message : err));
    }
  });

  app.get('/api/download/tasks', function (c) {
    const list = tasks.list();
    const st = tasks.status();
    c.json({
      ok: true,
      tasks: list,
      stats: {
        total: list.length,
        running: list.filter(function (t) { return t.state === 'running'; }).length,
        queued: list.filter(function (t) { return t.state === 'queued'; }).length,
        paused: list.filter(function (t) { return t.state === 'paused'; }).length,
        done: list.filter(function (t) { return t.state === 'done'; }).length,
        error: list.filter(function (t) { return t.state === 'error'; }).length,
        canceled: list.filter(function (t) { return t.state === 'canceled'; }).length,
        failedImages: list.reduce(function (a, t) { return a + Number(t.failed || 0); }, 0)
      },
      concurrency: st,
      sse: sse.stats()
    });
  });

  app.post('/api/download/tasks/bulk', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const action = String(body.action || '');
    if (['pause', 'resume', 'cancel', 'remove', 'retry'].indexOf(action) < 0) { c.error(400, '不支持的批量操作：' + action); return; }
    try {
      const r = await tasks.bulk(action, body.ids);
      c.json({ ok: true, ...r, message: '批量 ' + action + '：成功 ' + r.ok + '，失败 ' + r.failed.length });
    } catch (err) {
      c.error(400, err && err.message ? err.message : '批量操作失败');
    }
  });

  app.post('/api/download/tasks/clear-done', async function (c) {
    try {
      const r = await tasks.clearDone();
      hub.send('state', { tasks: tasks.list(), stats: tasks.status() });
      c.json({ ok: true, ...r, message: '已清理 ' + r.removed + ' 条已完成任务（磁盘文件保留）' });
    } catch (err) {
      c.error(400, err && err.message ? err.message : '清理失败');
    }
  });

  app.get('/api/download/tasks/:id', async function (c) {
    const t = tasks.get(c.params.id);
    if (!t) { c.error(404, '任务不存在'); return; }
    c.json({ ok: true, task: t, status: tasks.status() });
  });

  app.get('/api/download/tasks/:id/failures', async function (c) {
    try {
      const f = tasks.failures(c.params.id);
      c.json({ ok: true, ...f });
    } catch (err) { c.error(404, err && err.message ? err.message : '任务不存在'); }
  });

  app.post('/api/download/tasks/:id/retry', async function (c) {
    try {
      const t = await tasks.retryFailures(c.params.id);
      c.json({ ok: true, task: t, message: '已重新排队，只补失败与缺失的部分' });
    } catch (err) { c.error(400, err && err.message ? err.message : '重试失败'); }
  });

  app.post('/api/download/tasks/:id/priority', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    try {
      const t = tasks.setPriority(c.params.id, body.priority);
      c.json({ ok: true, task: t });
    } catch (err) { c.error(400, err && err.message ? err.message : '设置优先级失败'); }
  });

  app.post('/api/download/tasks/:id/pause', async function (c) {
    try {
      const t = await tasks.pause(c.params.id);
      c.json({ ok: true, task: t, message: '已暂停（等在途请求结束）' });
    } catch (err) { c.error(400, err && err.message ? err.message : '暂停失败'); }
  });

  app.post('/api/download/tasks/:id/resume', async function (c) {
    try {
      const t = await tasks.resume(c.params.id);
      c.json({ ok: true, task: t, message: '已继续，已存在的图片会自动跳过' });
    } catch (err) { c.error(400, err && err.message ? err.message : '继续失败'); }
  });

  app.post('/api/download/tasks/:id/cancel', async function (c) {
    try {
      const t = await tasks.cancel(c.params.id);
      c.json({ ok: true, task: t, message: '已取消' });
    } catch (err) { c.error(400, err && err.message ? err.message : '取消失败'); }
  });

  app.del('/api/download/tasks/:id', async function (c) {
    try {
      await tasks.remove(c.params.id);
      c.json({ ok: true, message: '任务已删除（已下载的文件保留在磁盘上）' });
    } catch (err) { c.error(400, err && err.message ? err.message : '删除失败'); }
  });

  /** 单任务日志 tail。 */
  app.get('/api/download/tasks/:id/logs', async function (c) {
    const t = tasks.get(c.params.id);
    if (!t) { c.error(404, '任务不存在'); return; }
    const limit = Math.max(1, Math.min(200, c.queryInt('limit', 40)));
    c.json({ ok: true, taskId: t.id, logs: (t.logs || []).slice(-limit) });
  });

  /* ================= 导出 ================= */

  app.post('/api/download/export', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const comicIds = Array.isArray(body.comicIds) ? body.comicIds.map(String) : [];
    if (!comicIds.length) { c.error(400, '请选择要导出的漫画'); return; }
    const format = ['zip', 'cbz', 'folder'].indexOf(String(body.format)) >= 0 ? String(body.format) : 'zip';
    try {
      let outDir = String(body.outDir || '').trim();
      outDir = outDir ? path.resolve(outDir) : await exportDir();
      const allowed = [root()].concat(activeRoots(cfg()).map(function (r) { return r.path; })).filter(Boolean);
      const owner = ownerRootOf(cfg(), outDir);
      // 导出目录允许在库根内，也允许是库根的同级目录（用户自选），但必须是绝对路径
      if (!path.isAbsolute(outDir)) { c.error(400, '导出目录必须是绝对路径'); return; }
      const items = [];
      const missing = [];
      for (const id of comicIds) {
        const local = await localComic(id, '');
        if (!local) { missing.push(id); continue; }
        items.push({ comicId: id, title: local.title, dir: local.dir });
      }
      if (!items.length) { c.error(404, '选中的漫画在本地都找不到，无法导出'); return; }
      const job = await exports.submit(items, { format: format, outDir: outDir, method: body.method === 'store' ? 'store' : 'deflate' });
      hub.send('state', { exportJob: job });
      c.json({ ok: true, job: job, missing: missing, message: '已开始导出 ' + items.length + ' 部到 ' + outDir + '（' + (format === 'folder' ? '复制目录' : format.toUpperCase()) + '）' });
    } catch (err) {
      c.error(400, err && err.message ? err.message : '导出失败');
    }
  });

  app.get('/api/download/exports', async function (c) {
    try {
      const list = await exports.list();
      c.json({ ok: true, jobs: list, busy: exports.isBusy(), queued: exports.queuedCount(), defaultDir: await exportDir() });
    } catch (err) {
      c.error(500, '读取导出记录失败：' + (err && err.message ? err.message : err));
    }
  });

  app.get('/api/download/export/:id', async function (c) {
    try {
      const job = await exports.get(c.params.id);
      if (!job) { c.error(404, '导出任务不存在'); return; }
      c.json({ ok: true, job: job });
    } catch (err) { c.error(500, '读取导出任务失败：' + (err && err.message ? err.message : err)); }
  });

  app.post('/api/download/export/:id/remove', async function (c) {
    try {
      await exports.remove(c.params.id);
      c.json({ ok: true, message: '导出记录已删除（文件保留）' });
    } catch (err) { c.error(400, err && err.message ? err.message : '删除导出记录失败'); }
  });

  /* ================= SSE / 文件 / 目录 ================= */

  app.get('/api/download/events', function (c) {
    const conn = c.sse();
    const send = function (event, data) {
      if (conn.closed) return;
      conn.send(event, data);
    };
    const acct = tokenInfo();
    conn.send('state', { tasks: tasks.list(), stats: tasks.status(), account: acct });
    const off = sse.subscribe(function (event, payload) { send(event, payload); });
    conn.onClose(off);
  });

  /* 远程封面的小缓存：前端一屏可能有几十张卡，拖动/切页会重复请求同一个 URL。
     缓存 10 分钟、最多 300 条，避免每次都穿代理回源，也不至于把内存撑爆。 */
  const remoteCoverCache = new Map();
  const REMOTE_COVER_TTL = 10 * 60 * 1000;

  /** 哔咔图片 CDN 的域名白名单：只允许从这些域回源，避免这个路由被当成任意代理。 */
  function isAllowedImageHost(host) {
    const h = String(host || '').toLowerCase();
    const allow = ['picacomic.com', 'picacomiccn.com', 'picacgz.com'];
    return allow.some(function (suffix) { return h === suffix || h.endsWith('.' + suffix); });
  }

  app.get('/api/download/cover', async function (c) {
    const target = String(c.query('path', '') || '');
    if (!target) { c.error(400, '缺少 path 参数'); return; }

    /* 远程封面：排行榜 / 搜索 / 收藏的卡片用的是哔咔 CDN 直链（thumb），
       后端没有先把它们落盘，所以这里必须**由后端经代理取回再转发**。
       前端拿不到代理，直连 CDN 只会得到裂图 —— 这正是「排行榜卡片全是占位图」的原因。 */
    if (/^https?:\/\//i.test(target)) {
      let imgUrl = null;
      try { imgUrl = new URL(target); } catch (e) { c.error(400, '封面地址非法'); return; }
      if (!isAllowedImageHost(imgUrl.hostname)) { c.error(400, '封面域名不在允许列表内，已拒绝'); return; }
      const hit = remoteCoverCache.get(target);
      if (hit && Date.now() - hit.at < REMOTE_COVER_TTL) {
        c.res.statusCode = 200;
        c.res.setHeader('Content-Type', hit.type || 'image/jpeg');
        c.res.setHeader('Cache-Control', 'private, max-age=3600');
        c.res.end(hit.buf);
        return;
      }
      const picked = pickSource(c, 'download');
      if (!picked.source) { replyPickedError(c, picked); return; }
      await currentProxy();
      try {
        const dl = await picked.source.download(target, {});
        if (!dl || !dl.buffer || !dl.buffer.length) { c.error(502, '封面内容为空'); return; }
        if (remoteCoverCache.size >= 300) remoteCoverCache.delete(remoteCoverCache.keys().next().value);
        remoteCoverCache.set(target, { at: Date.now(), buf: dl.buffer, type: dl.contentType || 'image/jpeg' });
        c.res.statusCode = 200;
        c.res.setHeader('Content-Type', dl.contentType || 'image/jpeg');
        c.res.setHeader('Cache-Control', 'private, max-age=3600');
        c.res.end(dl.buffer);
      } catch (err) {
        c.error(502, '取封面失败：' + (err && err.message ? err.message : String(err)));
      }
      return;
    }

    const abs = path.resolve(target);
    const r = root();
    const owner = ownerRootOf(cfg(), abs);
    if (!isInside(abs, abs)) { c.error(400, '图片路径非法'); return; }
    if (!owner && !(r && isInside(r, abs))) { c.error(400, '图片路径越界，已拒绝'); return; }
    await c.file(abs, { cacheSeconds: 3600 });
  });

  app.post('/api/download/open-folder', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    let dir = '';
    if (body.taskId) {
      const t = tasks.get(body.taskId);
      if (!t) { c.error(404, '任务不存在'); return; }
      dir = t.dir || paths().comicDir(t.title);
    } else if (body.exportId) {
      const job = await exports.get(body.exportId);
      if (!job) { c.error(404, '导出任务不存在'); return; }
      dir = job.outPath ? path.dirname(job.outPath) : '';
    } else if (body.path) {
      dir = path.resolve(String(body.path));
    } else if (body.comicId) {
      const local = await localComic(String(body.comicId), body.title ? String(body.title) : '');
      if (local) dir = local.dir;
      else dir = paths().comicDir(String(body.title || body.comicId));
    } else if (body.comicTitle) {
      dir = paths().comicDir(String(body.comicTitle));
    } else {
      dir = root();
    }
    if (!dir) { c.error(400, '没有可打开的目录'); return; }
    // 基准根：库根（多根）优先，其次下载根；必须是已存在目录
    const owner = ownerRootOf(cfg(), dir);
    const base = owner ? owner.path : root();
    if (!base) { c.error(400, '未配置库根/下载根，无法校验路径'); return; }
    try {
      dir = safeJoin(base, path.relative(base, dir));
    } catch (err) {
      c.error(400, '路径越界，已拒绝打开');
      return;
    }
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) { c.error(404, '不是目录：' + dir); return; }
    } catch (e) {
      c.error(404, '目录不存在（可能还没开始下载）：' + dir);
      return;
    }
    try {
      await new Promise(function (resolve, reject) {
        const p = spawn('explorer', [dir], { detached: true, stdio: 'ignore' });
        p.once('error', reject);
        p.once('spawn', function () { if (p.unref) p.unref(); resolve(true); });
      });
      c.json({ ok: true, dir: dir, message: '已在资源管理器中打开：' + dir });
    } catch (err) {
      c.error(500, '打开目录失败：' + (err && err.message ? err.message : err));
    }
  });

  /**
   * 手动设置哔咔 token：POST /api/download/token { token, verify? }
   * 为什么需要它：登录接口要求账号密码，而哔咔 App 抓到的 JWT 是最直接的凭据；
   * 之前前端「设置」页只有一句「请到下载页填写 token」，下载页却根本没有输入框 ——
   * 两个页面互相指路，用户无从下手。这里给出唯一入口，并在保存前**真校验一次**，
   * 避免把一个错的 token 存进配置（那会让后续所有请求都以 401 失败）。
   */
  app.post('/api/download/token', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const raw = String(body.token || '').trim();
    if (!raw) { c.error(400, '请粘贴哔咔 token'); return; }
    if (raw.length < 40 || raw.indexOf('.') < 0) { c.error(400, '这个不像哔咔 token（应是三段式 JWT，长度通常 200+）'); return; }
    const verify = body.verify !== false;
    await ctx.saveConfig({ picacomic: { token: raw } });
    if (!verify) { c.json({ ok: true, verified: false, message: 'token 已保存（未校验）', ...tokenInfo() }); return; }
    const picked = pickSource(c, 'profile');
    if (!picked.source) { c.error(400, picked.error); return; }
    await currentProxy();
    try {
      const profile = await picked.source.profile();
      const account = auth.normalizeProfile(profile.raw || profile);
      await auth.saveAccount(account, true);
      hub.send('account', { status: 'login', ...tokenInfo(), account: account });
      c.json({ ok: true, verified: true, message: 'token 有效，已登录为 ' + (account.name || account.email || account.id), account: account, ...tokenInfo() });
    } catch (err) {
      await ctx.saveConfig({ picacomic: { token: '' } });
      await auth.clearAccount();
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      const why = status === 401 || status === 403
        ? 'token 无效或已过期'
        : (err && err.message ? err.message : '连不上哔咔');
      c.error(status === 401 || status === 403 ? 401 : 502, 'token 未保存：' + why);
    }
  });

  app.get('/api/download/token-check', async function (c) {
    if (!requireToken(c)) return;
    const picked = pickSource(c, 'profile');
    if (!picked.source) { c.error(400, picked.error); return; }
    await currentProxy();
    try {
      const profile = await picked.source.profile();
      const account = auth.normalizeProfile(profile.raw || profile);
      await auth.saveAccount(account, true);
      c.json({ ok: true, message: 'token 有效', account: account, ...tokenInfo() });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      if (status === 401 || status === 403) {
        await ctx.saveConfig({ picacomic: { token: '' } });
        await auth.clearAccount();
        hub.send('account', { status: 'expired', ...tokenInfo(), account: null });
        c.error(401, '登录已过期，请重新登录');
        return;
      }
      c.error(502, err && err.message ? err.message : 'token 校验失败');
    }
  });

  logger.info('下载模块 v2 已就绪，落盘目录: ' + rootPath);
}

/** 解析下载根目录（多库根场景下仍以下载根为准）。 */
function resolveRoot(ctx) {
  const cfg = ctx.config || {};
  const r = String(cfg.downloadRoot || cfg.libraryRoot || '').trim();
  if (r) return r;
  const list = roots(cfg);
  return list.length ? list[0].path : '';
}

/** 状态中文名。 */
function stateText(state) {
  return ({
    queued: '排队中', running: '下载中', paused: '已暂停', done: '已完成',
    error: '有错误', canceled: '已取消'
  })[state] || state;
}

export async function dispose() {
  try { if (sse) sse.dispose(); } catch (e) { /* ignore */ }
  try { if (tasks) await tasks.dispose(); } catch (e) { /* ignore */ }
  engine = null;
  hub = null;
  sse = null;
  tasks = null;
  exports = null;
}
