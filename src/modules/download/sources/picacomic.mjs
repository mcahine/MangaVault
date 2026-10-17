import { createPicaClient, PicaError, signPath, imageUrlOf, coverUrlOf, PICA_USER_AGENT } from '../api.mjs';
import { notSupported, SEARCH_SORTS, FAVORITE_SORTS, RANK_TYPES } from './types.mjs';

/**
 * 哔咔（PicACG）下载源适配器。
 *
 * 职责边界：本文件只放「哔咔接口语义」—— 请求路径、请求体、响应字段到统一 Comic/Chapter/Page 的映射。
 * 签名算法、重试退避、代理 CONNECT 隧道、二进制下载等通用链路留在 ../api.mjs 的 createPicaClient 里复用，
 * 保证 HTTP 层只有一份实现（行为与 v2 完全一致）。
 *
 * 已核实的真实接口（与 _ref_downloader/picacomic-downloader-main 的 src-tauri/src/pica_client.rs 一致）：
 *   POST comics/advanced-search?page=N            body { keyword, sort, categories }
 *   GET  comics/{id}
 *   GET  comics/{id}/eps?page=N
 *   GET  comics/{id}/order/{order}/pages?page=N
 *   GET  users/favourite?s=dd|da&page=N
 *   GET  comics/leaderboard?tt=H24|D7|D30&ct=VC
 *   GET  users/profile
 *   POST auth/sign-in
 */

export const SOURCE_ID = 'picacomic';

/** 默认上游：不填则用官方域名（与 api.mjs 的默认值一致）。 */
export const DEFAULT_API_BASE = 'https://picaapi.picacomic.com';

function enc(v) {
  return encodeURIComponent(String(v));
}

function toInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number(dflt || 0);
}

/** 页码归一：非法值一律回到第 1 页。 */
function pageNum(v) {
  return Math.max(1, toInt(v, 1));
}

/**
 * 上游分页容器 -> 统一分页。
 * 注意：统一契约里 pages 至少为 1（上游缺失时 v2 默认给 0，这里按契约归一为 1）。
 */
function pageOf(container, page, mapper) {
  const src = container || {};
  const docs = Array.isArray(src.docs) ? src.docs : [];
  return {
    page: toInt(src.page, page || 1),
    pages: Math.max(1, toInt(src.pages, 1)),
    total: toInt(src.total, docs.length),
    docs: mapper ? docs.map(mapper) : docs
  };
}

/**
 * 上游漫画对象 -> 统一 Comic。
 * @param {object} d 上游 doc（搜索 / 收藏 / 排行榜 / 详情都复用这个映射）
 * @returns {object} Comic
 */
export function toComic(d) {
  const o = d || {};
  const raw = o;
  return {
    id: String(o._id || o.id || ''),
    title: o.title || '',
    author: o.author || '',
    cover: coverUrlOf(o.thumb),
    tags: Array.isArray(o.tags) ? o.tags.slice() : [],
    categories: Array.isArray(o.categories) ? o.categories.slice() : [],
    description: o.description || '',
    chineseTeam: o.chineseTeam || o.chinese_team || '',
    pagesCount: toInt(o.pagesCount, 0),
    chapterCount: toInt(o.epsCount !== undefined ? o.epsCount : o.eps_count, 0),
    likes: toInt(o.likesCount !== undefined ? o.likesCount : o.totalLikes, 0),
    views: toInt(o.totalViews !== undefined ? o.totalViews : o.viewsCount, 0),
    finished: Boolean(o.finished),
    createdAt: o.created_at || o.createdAt || null,
    updatedAt: o.updated_at || o.updatedAt || null,
    raw: raw
  };
}

/**
 * 上游章节对象 -> 统一 Chapter。
 * @param {object} ch
 * @returns {object} Chapter
 */
export function toChapter(ch) {
  const o = ch || {};
  const order = toInt(o.order, 0);
  return {
    chapterId: String(o._id || o.id || ''),
    chapterTitle: o.title || ('第 ' + order + ' 话'),
    order: order,
    updatedAt: o.updated_at || o.updatedAt || null,
    images: toInt(o.pagesCount, 0),
    raw: o
  };
}

/**
 * 上游图片对象 -> 统一 Page。
 * @param {object} doc 含 media 字段的页码文档
 * @param {number} index 1 起始页序
 * @returns {object} Page
 */
export function toPage(doc, index) {
  const o = doc || {};
  return {
    index: toInt(index, 1),
    url: imageUrlOf(o.media),
    raw: o
  };
}

/**
 * 账号资料映射。
 */
function toProfile(d) {
  const o = d || {};
  const u = o.user || o;
  return {
    id: String(u._id || u.id || ''),
    name: u.name || '',
    email: u.email || '',
    /* 头像：哔咔当前的 users/profile **不返回 avatar 字段**（实测字段只有
       _id/birthday/email/gender/name/title/verified/exp/level/characters/created_at/isPunched），
       参考实现的 UserProfileDetailRespData.avatar 带 #[serde(default)]，即上游不给也能解析。
       没有就返回空串，前端显示首字占位块 —— 不要为此去猜字段。
       真正站得住的是 title（勋章/头衔，实测 "萌新"）与 verified，下面一并带出来。 */
    avatar: u.avatar ? imageUrlOf(u.avatar) : '',
    title: u.title || '',
    verified: Boolean(u.verified),
    level: toInt(u.level, 0),
    exp: toInt(u.exp, 0),
    role: u.role || '',
    raw: u
  };
}

/**
 * 创建哔咔适配器实例。
 * @param {object} [options]
 * @param {object} [options.client] 复用外部已建好的 pica 客户端（路由层注入代理/占位配置时用）
 * @param {object|Function} [options.config] 透传给 createPicaClient 的配置（token / apiBase / proxy …）
 * @param {object} [options.log] 日志器，透传
 * @param {Function} [options.fetchImpl] 测试用：替换全局 fetch
 * @param {Function} [options.transport] 测试用：替换底层传输
 * @returns {object} SourceAdapter
 */
export function createPicacomicSource(options) {
  const o = options || {};
  const log = o.log || null;
  const client = o.client || createPicaClient({
    config: o.config,
    log: log,
    fetchImpl: o.fetchImpl,
    transport: o.transport
  });

  /**
   * 发一次请求并取 data 字段。
   * 与 api.mjs 内部 data() 的行为一致：code 非 200 由 client.raw 抛 PicaError，
   * data 缺失时在这里补一条同样的中文错误（错误类型与消息都不变）。
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @param {AbortSignal} [signal]
   * @param {boolean} [withAuth] false 表示不带 authorization（登录等接口必须这样）
   */
  async function dataOf(method, path, body, signal, withAuth) {
    const json = await client.raw(method, path, body, withAuth === false ? false : true, signal);
    if (!json || json.data === undefined || json.data === null) {
      throw new PicaError('哔咔接口没有返回 data 字段', 0, signPath(path));
    }
    return json.data;
  }

  /** 登录：POST auth/sign-in（不带 authorization，避免用过期 token 去登录）。 */
  async function login(credentials, options2) {
    const c = credentials || {};
    const email = String(c.email || '');
    const password = String(c.password || '');
    if (!email || !password) throw new Error('登录需要邮箱与密码');
    const signal = (options2 || {}).signal;
    const d = await dataOf('POST', 'auth/sign-in', { email: email, password: password }, signal, false);
    return { token: String(d.token || ''), user: d.user || null, raw: d };
  }

  /** 搜索：POST comics/advanced-search?page=N（sort 缺省 dd，与 v2 请求体逐字一致）。 */
  async function search(keyword, options2) {
    const p = options2 || {};
    const page = pageNum(p.page);
    const sort = p.sort === undefined || p.sort === '' ? 'dd' : String(p.sort);
    if (SEARCH_SORTS.indexOf(sort) < 0) {
      throw new Error('搜索排序只支持 ' + SEARCH_SORTS.join('/') + '，收到：' + sort);
    }
    const categories = Array.isArray(p.categories) ? p.categories.map(String) : [];
    const body = { keyword: String(keyword || ''), sort: sort, categories: categories };
    const d = await dataOf('POST', 'comics/advanced-search?page=' + page, body, p.signal);
    return pageOf(d.comics, page, toComic);
  }

  /** 详情：GET comics/{id}。 */
  async function comic(comicId, options2) {
    const p = options2 || {};
    const id = String(comicId || '');
    if (!id) throw new Error('缺少漫画 id');
    const d = await dataOf('GET', 'comics/' + enc(id), undefined, p.signal);
    return toComic(d.comic || d);
  }

  /** 章节分页：GET comics/{id}/eps?page=N。 */
  async function chapters(comicId, options2) {
    const p = options2 || {};
    const id = String(comicId || '');
    if (!id) throw new Error('缺少漫画 id');
    const page = pageNum(p.page);
    const d = await dataOf('GET', 'comics/' + enc(id) + '/eps?page=' + page, undefined, p.signal);
    return pageOf(d.eps, page, toChapter);
  }

  /** 章节图片分页：GET comics/{id}/order/{order}/pages?page=N。 */
  async function pages(comicId, order, options2) {
    const p = options2 || {};
    const id = String(comicId || '');
    if (!id) throw new Error('缺少漫画 id');
    const page = pageNum(p.page);
    const ord = toInt(order, 1);
    const d = await dataOf('GET', 'comics/' + enc(id) + '/order/' + ord + '/pages?page=' + page, undefined, p.signal);
    return pageOf(d.pages, page, function (doc, i) { return toPage(doc, i + 1); });
  }

  /** 收藏夹分页：GET users/favourite?s=dd|da&page=N（sort 缺省 dd，与 v2 请求路径逐字一致）。 */
  async function favorites(options2) {
    const p = options2 || {};
    const page = pageNum(p.page);
    const sort = p.sort === undefined || p.sort === '' ? 'dd' : String(p.sort);
    if (FAVORITE_SORTS.indexOf(sort) < 0) {
      throw new Error('收藏排序只支持 ' + FAVORITE_SORTS.join('/') + '，收到：' + sort);
    }
    const d = await dataOf('GET', 'users/favourite?s=' + sort + '&page=' + page, undefined, p.signal);
    return pageOf(d.comics, page, toComic);
  }

  /**
   * 排行榜：GET comics/leaderboard?tt=H24|D7|D30&ct=VC。
   * 上游此接口一次返回全榜（不分页），所以统一分页里 pages 固定为 1。
   * 哔咔只提供综合榜，ct 传别的值属于能力缺失，抛 NotSupportedError。
   */
  async function leaderboard(options2) {
    const p = options2 || {};
    const tt = p.rankType === undefined || p.rankType === '' ? 'H24' : String(p.rankType);
    if (RANK_TYPES.indexOf(tt) < 0) {
      throw new Error('排行榜周期只支持 ' + RANK_TYPES.join('/') + '，收到：' + tt);
    }
    const ct = p.ct === undefined || p.ct === '' ? 'VC' : String(p.ct);
    if (ct !== 'VC') {
      throw notSupported('leaderboard', { sourceId: SOURCE_ID, detail: '哔咔排行榜只提供综合榜（ct=VC）' });
    }
    const d = await dataOf('GET', 'comics/leaderboard?tt=' + tt + '&ct=VC', undefined, p.signal);
    const docs = Array.isArray(d.comics) ? d.comics : [];
    return { page: 1, pages: 1, total: docs.length, docs: docs.map(toComic), rankType: tt, ct: 'VC' };
  }

  /** 账号资料：GET users/profile（也用于校验 token 是否有效）。 */
  async function profile(options2) {
    const p = options2 || {};
    const d = await dataOf('GET', 'users/profile', undefined, p.signal);
    return toProfile(d);
  }

  /* ---------- 可选能力（契约里的分页便捷方法与二进制下载） ---------- */

  /** 自动翻页取全部章节（按 order 升序）。 */
  async function chaptersAll(comicId, options2) {
    const p = options2 || {};
    const first = await chapters(comicId, { page: 1, signal: p.signal });
    const docs = first.docs.slice();
    for (let n = 2; n <= first.pages; n++) {
      if (p.signal && p.signal.aborted) break;
      const more = await chapters(comicId, { page: n, signal: p.signal });
      for (const d of more.docs) docs.push(d);
    }
    docs.sort(function (a, b) { return a.order - b.order; });
    return docs;
  }

  /** 自动翻页取整章图片直链（index 重排为整章连续序号）。 */
  async function pagesAll(comicId, order, options2) {
    const p = options2 || {};
    const first = await pages(comicId, order, { page: 1, signal: p.signal });
    const docs = first.docs.slice();
    for (let n = 2; n <= first.pages; n++) {
      if (p.signal && p.signal.aborted) break;
      const more = await pages(comicId, order, { page: n, signal: p.signal });
      for (const d of more.docs) docs.push(d);
    }
    return docs.map(function (d, i) {
      return { index: i + 1, url: d.url, raw: d.raw };
    });
  }

  /** 收藏夹全部漫画（带上限保护，避免上游 pages 异常时无限翻页）。 */
  async function favoritesAll(options2) {
    const p = options2 || {};
    const maxPages = Math.max(1, toInt(p.maxPages, 30));
    const first = await favorites({ page: 1, sort: p.sort, signal: p.signal });
    const docs = first.docs.slice();
    const pages = Math.min(maxPages, first.pages);
    for (let n = 2; n <= pages; n++) {
      if (p.signal && p.signal.aborted) break;
      const more = await favorites({ page: n, sort: p.sort, signal: p.signal });
      for (const d of more.docs) docs.push(d);
    }
    return { total: first.total || docs.length, pages: pages, docs: docs };
  }

  /** 下载二进制（图片）：复用 api.mjs 的超时与代理链路。 */
  async function download(url, options2) {
    return client.download(String(url || ''), (options2 || {}).signal);
  }

  /** 把来源自己的封面描述对象（thumb）转成直链，供路由层按需调用。 */
  function coverUrl(thumb) {
    return coverUrlOf(thumb);
  }

  return {
    meta: {
      id: SOURCE_ID,
      name: '哔咔漫画',
      description: '哔咔（PicACG）官方 App 接口，支持登录、搜索、收藏、排行榜与章节图片下载',
      homepage: DEFAULT_API_BASE,
      capabilities: ['login', 'search', 'comic', 'chapters', 'pages', 'favorites', 'leaderboard', 'profile', 'download', 'cover']
    },
    /** 暴露底层客户端，便于路由层做尚未纳入契约的动作（如注册、找回密码、自定义路径请求）。 */
    client: client,
    /** 图片下载用的 UA，与 api.mjs 保持一致。 */
    userAgent: PICA_USER_AGENT,
    login: login,
    search: search,
    comic: comic,
    chapters: chapters,
    pages: pages,
    favorites: favorites,
    leaderboard: leaderboard,
    profile: profile,
    chaptersAll: chaptersAll,
    pagesAll: pagesAll,
    favoritesAll: favoritesAll,
    download: download,
    coverUrl: coverUrl
  };
}

/** 默认实例：注册表直接使用它（无状态，配置由 client 的 config 回调活读）。 */
const picacomicSource = createPicacomicSource();

export default picacomicSource;
