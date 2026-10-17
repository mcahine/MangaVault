# 下载源适配器契约（DOWNLOAD_SOURCES）

> 目标：**新增一个下载源 = 新增一个文件 + register 一行**，不改动任何业务路由。
> 实现真源：`src/modules/download/sources/types.mjs`（结构定义）与 `sources/index.mjs`（注册表）。
> 这份文档与它们必须保持一致；改代码就要改这里。

---

## 1. 目录与分层

```
src/modules/download/
├── api.mjs                通用 HTTP 链路：签名算法、重试退避、代理 CONNECT 隧道、chunked 解码、二进制下载
├── sources/
│   ├── types.mjs          契约：JSDoc 结构定义 + NotSupportedError + 能力常量
│   ├── index.mjs          注册表：register / unregister / get / has / list / listIds / defaultSource
│   │                      + 工厂表 registerFactory / hasFactory / createInstance（按依赖重建实例）
│   └── picacomic.mjs      哔咔适配器：唯一的接口语义（路径、请求体、字段映射）
├── index.mjs              路由层：只依赖注册表返回的适配器，不认识任何具体来源
├── engine.mjs             下载引擎：消费适配器契约（comic / pages(All) / download / coverUrl）
└── tasks.mjs              任务队列：把默认源 + getSource(sourceId) 注入引擎
```

分层原则：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| `api.mjs` | 怎么把请求发出去（签名/重试/代理/二进制） | 任何具体接口路径 |
| `sources/<id>.mjs` | 调哪个路径、发什么体、字段怎么映射成 Comic/Chapter/Page | HTTP 细节 |
| `download/index.mjs` | `/api/download/*` 路由、配置、任务与本地库比对 | 来源专有字段（需要时读 `comic.raw`） |
| `download/engine.mjs` | 落盘结构、断点续传、并发限速；只认统一 Comic/Chapter/Page | 任何来源的字段名与请求路径 |

消费契约的三条规则（实现见 `download/index.mjs` 与 `download/engine.mjs`）：

1. **取源**：`sourceId` 来自查询串 `?sourceId=` 或 JSON body 的 `sourceId`（别名 `source`），缺省用默认源。
   路由用 `pickSource(c, capability)` 统一取源并在取源时断言能力；未注册的源与缺能力的源都返回
   `400 {ok:false, error:中文}`，**不会**落成 500，也不会漏出 `xxx is not a function` 这类英文错。
2. **断言能力**：路由调 `requireCapability(source, name)`；适配器内部遇到不支持的取值也抛 `NotSupportedError`，
   两者都由 `replySourceError()` 统一降级成 400 + 中文。
3. **可选能力要有兜底**：只有 `chaptersAll` / `favoritesAll` / `pagesAll` 是可选能力，
   上层（`chaptersAllOf` / `favoritesAllOf` / 引擎的 `chapterImageUrls`）在缺失时会用必备的
   `chapters` / `favorites` / `pages` 自己翻页，所以可选能力只是省一次往返，缺了也能用。

---

## 2. 统一结构

完整 JSDoc 在 `sources/types.mjs`。要点：

### Comic

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 来源内的稳定标识 |
| title / author | string | 标题、作者 |
| cover | string | 封面直链，拿不到时空串 |
| tags / categories | string[] | 标签、分类 |
| description / chineseTeam | string | 简介、汉化组 |
| pagesCount / chapterCount | number | 总页数、章节数（未知为 0） |
| likes / views | number | 喜欢数、浏览数 |
| finished | boolean | 是否完结 |
| createdAt / updatedAt | string \| null | ISO 时间 |
| raw | object | **来源原始对象**，来源专有字段一律从这里取，不要在统一结构上挂私有字段 |

### Chapter

`chapterId` / `chapterTitle` / `order` / `updatedAt` / `images` / `raw`。
`order` 是下载目录排序的唯一依据，必须与来源的章节序号一致。

### Page

`index`（1 起始页序）/ `url`（图片直链）/ `raw`。
单页请求时 `index` 是页内序号；`pagesAll()` 会重排为整章连续序号。

### PagedResult

`{ page, pages, total, docs }`。**`docs` 恒为数组，`pages` 至少为 1**（上游缺省时按契约归一）。

### Profile

`id` / `name` / `email` / `avatar` / `level` / `exp` / `role` / `raw`。

---

## 3. 适配器接口

必备（`REQUIRED_CAPABILITIES`，缺了要在调用时抛 `NotSupportedError`）：

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| login | `(credentials:{email,password}, options)` | 返回 `{ token, user, raw }` |
| search | `(keyword, { page, sort, categories })` | 返回 `PagedResult<Comic>` |
| comic | `(comicId, options)` | 返回 `Comic` |
| chapters | `(comicId, { page })` | 返回 `PagedResult<Chapter>` |
| pages | `(comicId, order, { page })` | 返回 `PagedResult<Page>` |
| favorites | `({ page, sort })` | 返回 `PagedResult<Comic>` |
| leaderboard | `({ rankType, ct })` | 返回 `PagedResult<Comic>`（不分页的上游 pages=1） |
| profile | `(options)` | 返回 `Profile` |

可选（`CAPABILITIES` 里的扩展能力，有就实现）：

| 方法 | 说明 |
| --- | --- |
| chaptersAll | 自动翻页取全部章节，按 order 升序 |
| pagesAll | 自动翻页取整章图片直链，index 连续 |
| favoritesAll | 自动翻页取收藏，带 maxPages 上限保护 |
| download | `(url)` 返回 `{ buffer, contentType }` |
| coverUrl | 把来源自己的封面描述对象转成直链 |

`options.signal` 为 `AbortSignal`，适配器必须在翻页循环里检查它。

---

## 4. 错误约定

| 情形 | 抛什么 | 默认中文消息 |
| --- | --- | --- |
| 注册表里没有这个 sourceId | 普通 `Error`（由路由 `pickSource` 捕获成 400） | 未知的下载源：xxx（已注册：…） |
| 来源根本不支持该能力 | `NotSupportedError`（`code='NOT_SUPPORTED'`，带 `sourceId` / `capability`） | 该下载源不支持此能力 |
| 能力存在但参数取值超出范围 | 普通 `Error` | 例：搜索排序只支持 dd/da/ld/vd，收到：zz |
| 上游返回错误 | 沿用 `api.mjs` 的 `PicaError`（含 HTTP 状态码与中文翻译） | — |

上层用 `requireCapability(source, name)` 做前置断言，用 `instanceof NotSupportedError` 区分「不支持」与「调用失败」。

---

## 5. 接入一个新下载源的步骤

1. 新建 `sources/<id>.mjs`，导出 `create<Id>Source(options)` 工厂与 `export default` 默认实例。
   - `options.client` 可复用外部客户端；`options.config` / `options.log` / `options.transport` / `options.fetchImpl` 透传给底层。
   - `options.transport` 是离线单测的注入点：给一个假传输就能断言请求路径与请求体。
2. 在文件内实现 `toComic` / `toChapter` / `toPage` 之类的映射函数，把来源字段收敛到统一结构，原始对象挂到 `raw`。
3. 在 `sources/index.mjs` 里 `import` 并 `register()`（注册默认实例）；
   若路由层要按 `ctx.config` 活读配置重建实例，再补一行 `registerFactory(meta.id, create<Id>Source)`，
   这样 `createInstance(id, options)` 就能把 `config / log / client / transport` 注入进去。
   给 `meta.capabilities` 如实填写已实现的能力。
4. 没实现的能力不要写空函数——直接不导出，让 `requireCapability` 抛 `NotSupportedError`。
5. 补一份离线单测：注入假 transport，断言路径/请求体/字段映射；**不要打真实网络**。
6. 是否需要改路由？只有当新来源带来**新的用户可见行为**时才改；仅仅换来源不需要动路由 ——
   前端只要带上 `?sourceId=<新源>`（或登录/配置页把它写进请求 body）就能切过去。
7. 下载链路同样不需要改：建任务时路由会把 `sourceId` 记进任务，引擎用 `getSource(sourceId)` 取回该源；
   源没了就退回默认源并在任务日志里说明。没有 `getSource` 注入时引擎一律用默认源。

---

## 6. 哔咔（picacomic）适配器的事实

已核实的真实接口（与 `_ref_downloader/picacomic-downloader-main/src-tauri/src/pica_client.rs` 一致）：

| 能力 | 请求 |
| --- | --- |
| login | `POST auth/sign-in`（**不带 authorization**，否则过期 token 会导致无法登录） |
| search | `POST comics/advanced-search?page=N`，体 `{ keyword, sort, categories }` |
| comic | `GET comics/{id}` |
| chapters | `GET comics/{id}/eps?page=N` |
| pages | `GET comics/{id}/order/{order}/pages?page=N` |
| favorites | `GET users/favourite?s=dd\|da&page=N` |
| leaderboard | `GET comics/leaderboard?tt=H24\|D7\|D30&ct=VC` |
| profile | `GET users/profile` |

已知边界：

- 排行榜**一次返回全榜，上游不分页**，所以统一分页里 `pages` 固定为 1。
- 哔咔只提供综合榜，`ct` 传 `VC` 以外的值抛 `NotSupportedError`（能力缺失，不是参数错误）。
- 收藏排序只支持 `dd`（最新）/ `da`（最早）；搜索排序另支持 `ld`（最多喜欢）/ `vd`（最多浏览）。
- 搜索/收藏/排行榜的 doc 字段名不完全一致（`likesCount` vs `likes_count` vs `totalLikes`），映射函数已做兼容。
- 章节图片直链由 `fileServer + /static/ + path` 拼成；封面 `thumb.path` 的前两段是 service/signature，只取最后一段文件名。

注册、找回密码等尚未纳入契约的动作，可暂时通过适配器暴露的 `source.client.raw(...)` 走底层客户端；
后续把它们收进契约时，要在 `CAPABILITIES`、本文件与 `types.mjs` 三处同步。

---

## 7. 边界

- 适配器**不做**磁盘写入、不做断点续传、不碰任务队列——那是 `download/engine.mjs` 与 `tasks.mjs` 的职责。
- 适配器**不做**本地库比对——那是路由层用 `core/library-index.mjs` 干的事。
- 适配器**不缓存**响应；缓存策略放在上层，避免来源之间行为不一致。
- 适配器**不认识**本地路径与任务状态；引擎也**不认识**来源字段名 —— 两边唯一的交汇就是这里的统一结构。
- 契约外动作（注册、找回密码）暂时只走 `source.client.raw(...)`；`api.mjs` 客户端除 `raw()` 与 `download()` 外**不再有**接口级方法，
  所以不会出现第二份接口实现。
