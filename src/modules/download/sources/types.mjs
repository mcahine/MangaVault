/**
 * 下载源适配器契约（唯一真源）。
 *
 * 目标：下载模块只依赖这一份统一的 Comic / Chapter / Page 结构，
 * 新增一个下载源 = 在 sources/ 下新增一个文件并 register()，不改动任何业务路由。
 *
 * 约定：
 *   1. 每个下载源导出一个适配器对象（SourceAdapter），字段见本文件末尾的 typedef。
 *   2. 所有方法失败时抛 Error，message 必须是中文可读原因，不抛英文栈。
 *   3. 适配器没实现的能力，调用时必须抛 NotSupportedError（默认中文消息：该下载源不支持此能力）。
 *   4. 文档 docs/DOWNLOAD_SOURCES.md 与本文件必须保持一致；改这里就要改那里。
 */

/**
 * 能力缺失错误：某下载源不支持被调用的能力。
 * 与普通 Error 的区别是带结构化上下文（code / sourceId / capability），
 * 上层可以据此把「不支持」和「调用失败」分开处理。
 */
export class NotSupportedError extends Error {
  /**
   * @param {string} [message] 面向用户的中文原因，缺省为「该下载源不支持此能力」
   * @param {{sourceId?:string, capability?:string, detail?:string}} [info] 上下文
   */
  constructor(message, info) {
    super(message || '该下载源不支持此能力');
    this.name = 'NotSupportedError';
    this.code = 'NOT_SUPPORTED';
    const i = info || {};
    this.sourceId = i.sourceId ? String(i.sourceId) : '';
    this.capability = i.capability ? String(i.capability) : '';
    this.detail = i.detail ? String(i.detail) : '';
  }
}

/**
 * 造一个「不支持」错误。
 * @param {string} capability 能力名，见 CAPABILITIES
 * @param {{sourceId?:string, detail?:string}} [info]
 * @returns {NotSupportedError}
 */
export function notSupported(capability, info) {
  const i = info || {};
  const detail = i.detail ? '：' + String(i.detail) : '';
  return new NotSupportedError('该下载源不支持此能力' + detail, {
    sourceId: i.sourceId || '',
    capability: capability || '',
    detail: i.detail || ''
  });
}

/**
 * 断言适配器声明了某个能力，否则抛 NotSupportedError。
 * @param {object} source 适配器对象
 * @param {string} capability 能力名
 * @returns {boolean} 恒为 true
 */
export function requireCapability(source, capability) {
  const caps = (source && source.meta && source.meta.capabilities) || [];
  if (caps.indexOf(String(capability)) < 0) {
    throw notSupported(capability, { sourceId: source && source.meta ? source.meta.id : '' });
  }
  return true;
}

/** 契约里的全部能力名。前 8 个是必备能力，后 2 个可选。 */
export const CAPABILITIES = [
  'login', 'search', 'comic', 'chapters', 'pages', 'favorites', 'leaderboard', 'profile',
  'download', 'cover'
];

/** 每个下载源都必须实现的能力（缺了就要在调用时抛 NotSupportedError）。 */
export const REQUIRED_CAPABILITIES = [
  'login', 'search', 'comic', 'chapters', 'pages', 'favorites', 'leaderboard', 'profile'
];

/** 搜索排序取值：dd=最新 / da=最早 / ld=最多喜欢 / vd=最多浏览。 */
export const SEARCH_SORTS = ['dd', 'da', 'ld', 'vd'];

/** 收藏夹排序取值：dd=最新收藏 / da=最早收藏。 */
export const FAVORITE_SORTS = ['dd', 'da'];

/** 排行榜周期取值：H24=日榜 / D7=周榜 / D30=月榜。 */
export const RANK_TYPES = ['H24', 'D7', 'D30'];

/**
 * 空分页结果（统一形状：docs 恒为数组，pages 至少为 1）。
 * @param {number} [page]
 * @returns {{page:number, pages:number, total:number, docs:any[]}}
 */
export function emptyPage(page) {
  return { page: Number(page) || 1, pages: 1, total: 0, docs: [] };
}

/* ------------------------------------------------------------------ *
 * 结构定义（仅 JSDoc，无运行时代码）
 * ------------------------------------------------------------------ */

/**
 * 统一下载源元信息。
 * @typedef {object} SourceMeta
 * @property {string} id 下载源唯一标识，小写英文，例如 picacomic
 * @property {string} name 中文显示名，例如 哔咔漫画
 * @property {string} description 一句话说明
 * @property {string} [homepage] 上游站点
 * @property {string[]} capabilities 已实现的能力名，取值见 CAPABILITIES
 */

/**
 * 统一下载源适配器。
 * @typedef {object} SourceAdapter
 * @property {SourceMeta} meta 元信息（含 capabilities）
 * @property {(credentials:{email:string,password:string}, options?:{signal?:AbortSignal}) => Promise<{token:string,user:object|null,raw:object}>} login 登录，返回 token
 * @property {(keyword:string, options?:{page?:number,sort?:string,categories?:string[],signal?:AbortSignal}) => Promise<PagedResult<Comic>>} search 关键字搜索
 * @property {(comicId:string, options?:{signal?:AbortSignal}) => Promise<Comic>} comic 漫画详情
 * @property {(comicId:string, options?:{page?:number,signal?:AbortSignal}) => Promise<PagedResult<Chapter>>} chapters 章节目录（分页）
 * @property {(comicId:string, order:number, options?:{page?:number,signal?:AbortSignal}) => Promise<PagedResult<Page>>} pages 章节图片（分页）
 * @property {(options?:{page?:number,sort?:string,signal?:AbortSignal}) => Promise<PagedResult<Comic>>} favorites 收藏夹（分页）
 * @property {(options?:{rankType?:string,ct?:string,signal?:AbortSignal}) => Promise<PagedResult<Comic>>} leaderboard 排行榜
 * @property {(options?:{signal?:AbortSignal}) => Promise<Profile>} profile 当前账号资料
 * @property {(comicId:string, options?:{signal?:AbortSignal}) => Promise<Chapter[]>} [chaptersAll] 可选：自动翻页取全部章节
 * @property {(comicId:string, order:number, options?:{signal?:AbortSignal}) => Promise<Page[]>} [pagesAll] 可选：自动翻页取整章图片直链
 * @property {(url:string, options?:{signal?:AbortSignal}) => Promise<{buffer:Buffer,contentType:string}>} [download] 可选：下载二进制
 * @property {(thumb:object) => string} [coverUrl] 可选：把来源自己的封面描述对象转成直链
 */

/**
 * 统一漫画结构。
 * @typedef {object} Comic
 * @property {string} id 下载源内的稳定标识
 * @property {string} title 标题
 * @property {string} author 作者，缺省空串
 * @property {string} cover 封面直链，拿不到时空串
 * @property {string[]} tags 标签
 * @property {string[]} categories 分类
 * @property {string} description 简介
 * @property {string} chineseTeam 汉化组
 * @property {number} pagesCount 总页数，未知为 0
 * @property {number} chapterCount 章节数，未知为 0
 * @property {number} likes 喜欢数
 * @property {number} views 浏览数
 * @property {boolean} finished 是否完结
 * @property {string|null} createdAt ISO 时间或 null
 * @property {string|null} updatedAt ISO 时间或 null
 * @property {object} raw 来源原始对象（保真，路由层需要来源专有字段时用它）
 */

/**
 * 统一章节结构。
 * @typedef {object} Chapter
 * @property {string} chapterId 章节在来源内的标识
 * @property {string} chapterTitle 章节标题
 * @property {number} order 章节序号（下载目录排序用它）
 * @property {string|null} updatedAt ISO 时间或 null
 * @property {number} images 页数，来源不提供时为 0
 * @property {object} raw 来源原始对象
 */

/**
 * 统一图片结构。
 * @typedef {object} Page
 * @property {number} index 1 起始的页序（单页请求时是页内序号，pagesAll 会重排为整章连续序号）
 * @property {string} url 图片直链
 * @property {object} raw 来源原始对象
 */

/**
 * 统一分页结果。
 * @typedef {object} PagedResult
 * @property {number} page 当前页，从 1 开始
 * @property {number} pages 总页数，至少为 1
 * @property {number} total 总条数
 * @property {Array} docs 当前页的数据
 */

/**
 * 统一账号资料。
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} name 昵称
 * @property {string} email
 * @property {string} avatar 头像直链
 * @property {number} level
 * @property {number} exp
 * @property {string} role
 * @property {object} raw 来源原始对象
 */
