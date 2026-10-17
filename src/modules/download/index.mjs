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
import { registerRoutes as registerRoutes_account } from './routes-account.mjs';
import { registerRoutes as registerRoutes_leaderboard } from './routes-leaderboard.mjs';
import { registerRoutes as registerRoutes_status } from './routes-status.mjs';
import { registerRoutes as registerRoutes_search } from './routes-search.mjs';
import { registerRoutes as registerRoutes_favorites } from './routes-favorites.mjs';
import { registerRoutes as registerRoutes_update } from './routes-update.mjs';
import { registerRoutes as registerRoutes_tasks } from './routes-tasks.mjs';
import { registerRoutes as registerRoutes_export } from './routes-export.mjs';
import { registerRoutes as registerRoutes_files } from './routes-files.mjs';

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
  /* ================= 路由装配 ================= */
  /* 路由实体已按分节拆到 routes-*.mjs：每个文件导出 registerRoutes(app, s)，
     只解构自己真正用到的共享绑定，路由体与原闭包内实现逐字节一致。
     这里一次性组装上下文，避免每个文件各自拼一份可能不一致的入参。 */
  const routeCtx = {
    app: app, ctx: ctx,
    proxyCache: proxyCache,
    currentProxy: currentProxy,
    defaultSource: defaultSource,
    cfg: cfg,
    picaCfg: picaCfg,
    root: root,
    paths: paths,
    tokenInfo: tokenInfo,
    requireToken: requireToken,
    requestedSourceId: requestedSourceId,
    pickSource: pickSource,
    replyPickedError: replyPickedError,
    chaptersAllOf: chaptersAllOf,
    favoritesAllOf: favoritesAllOf,
    replySourceError: replySourceError,
    rawClientOf: rawClientOf,
    taskComicOf: taskComicOf,
    coverPathOf: coverPathOf,
    exportDir: exportDir,
    localComic: localComic,
    stateText: stateText,
    engine: engine,
    hub: hub,
    sse: sse,
    tasks: tasks,
    exports: exports,
    logger: logger,
    rootPath: rootPath,
    accountCheck: accountCheck
  };

  registerRoutes_account(app, routeCtx);   // 登录 / 账号
  registerRoutes_leaderboard(app, routeCtx);   // 排行榜 / 账号资料
  registerRoutes_status(app, routeCtx);   // 状态 / 代理 / 配置
  registerRoutes_search(app, routeCtx);   // 搜索 / 详情
  registerRoutes_favorites(app, routeCtx);   // 收藏夹
  registerRoutes_update(app, routeCtx);   // 已下载漫画更新
  registerRoutes_tasks(app, routeCtx);   // 任务
  registerRoutes_export(app, routeCtx);   // 导出
  registerRoutes_files(app, routeCtx);   // SSE / 文件 / 目录

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
