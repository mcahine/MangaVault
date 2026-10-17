# 漫画库模块（library）

> 后端：`src/modules/library/`（`index.mjs` 488 行 + `scanner.mjs` 288 行） ｜ 前端：`public/modules/library.js`
> 职责：**只读的库视图**——扫描库根、建索引、列表/搜索/筛选、详情、封面与图片服务、收藏、阅读进度。
> 一句话：**它回答「库里有什么」，但不改磁盘上的任何内容**；加工整理归 vault，翻页渲染归 reader，下载归 download。

---

## 1. 它解决什么问题

用户手上是一堆来源各异、命名混乱、有的带元数据有的只有裸图片的目录。library 的职责是把它们变成**一个可检索的统一视图**，而不是要求用户先整理好：

| 真实痛点 | library 的答案 |
|---|---|
| 漫画散在多个磁盘目录 | 多库根（`config.libraryRoots[]`），一次扫描合并成一个索引 |
| 目录命名不统一、缺 `元数据.json` | 缺元数据不拒绝识别，标题兜底用目录名（见 `docs/LIBRARY_FORMAT.md`） |
| 三种目录形态（L2/L1/L0）混在一起 | 扫描器按「含图子目录即是章节」判定，裸形态把顶层图当单章 |
| 七万多张图不可能全发给前端 | 索引里存图片名清单，列表接口只回轻量字段（`light()`），图片按需单张请求 |
| 想按标签/作者/体积筛 | `/api/library/facets` 预聚合 + `/api/library/comics` 组合过滤 |
| 大库首屏要等很久 | 分页 + 前端虚拟网格；扫描走 SSE 推送进度 |

**分工边界**：

| 模块 | 管什么 | 与 library 的边界 |
|---|---|---|
| **reader** | 翻页、阅读模式、预加载 | reader 每次请求都通过 `readLibraryIndex()` 读最新索引，**不缓存内存快照** |
| **vault** | 标签体系、元数据编辑、整理、回收站 | vault 只读索引；改完元数据后调 `POST /api/library/refresh-single` 让 library 刷新单本 |
| **download** | 从上游下载并落盘 | 下载产物按库格式写进库根，**不会自动重扫**，需用户点一次「扫描库」 |
| **dedupe** | 指纹级查重、隔离删除 | 查重自己扫描，不依赖索引；删完后由 dedupe 侧回写 `scan-latest.json` |

---

## 2. 接口一览（统一前缀 `/api/library`）

> 下表从 `src/modules/library/index.mjs` 的 `app.get/post/del` 逐条抄录。所有响应成功 `{ok:true,...}`，失败 `{ok:false,error:'中文原因'}` 并配 400/404/409/500。

### 2.1 状态与库根

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/state` | — | `{ok,scanning,progress,roots[],scannedAt,stats,byRoot,bytesText}` | 模块总状态。`roots[]` 来自 `probeRoots()`，每项 `{id,name,path,enabled,exists,dirs,error}` |
| GET | `/roots` | — | `{ok,roots[]}` | 同上，只回库根 |
| POST | `/roots` | body `{path,name?,id?,enabled?}` | `{ok,roots[],message}` | 新增/更新库根。`path` 必须是**已存在的目录**（`path.resolve` 后 stat），否则 400。写回 `config.libraryRoots` 后重载配置 |
| DELETE | `/roots?id=` | query `id` | `{ok,roots[],message}` | 移除库根登记，**磁盘文件不删**。id 不存在 → 404 |

> 库根的 id 一旦生成就不变（`upsertRoot` 里 `Object.assign(..., { id: list[idx].id })`），因为索引条目的 `root` 字段引用它。

### 2.2 扫描

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| POST | `/scan` | body `{root?}` | `{ok,scanning:true,roots:[名字]}` | 触发全库扫描（或指定单根）。**单飞**：已在扫描 → 409「已在扫描中，请稍候」。没有启用的库根 → 400 |
| GET | `/scan/events` | — | SSE | 事件 `state` / `progress` / `done` / `error`。`progress` 形如 `{phase,current,total,message,root}` |
| POST | `/refresh-single` | body `{comicId}` | `{ok,comic,message}` | 只重扫一部漫画并原地替换索引条目 + 重算 `stats`/`byRoot`。vault 改元数据、download 下完一章后调它 |

扫描是**后台异步**的：`POST /scan` 立刻返回，工作在 `(async function(){...})()` 里跑，进度通过 SSE 广播。
扫描期间事件循环会被占满，`/api/ping` 可能连续超时——所以整段包在 `withHeartbeat()` 里（`src/core/heartbeat.mjs`），桌面宿主的看护看到「我在忙」就不会误判后端已死而关窗口。

### 2.3 列表与详情

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/comics` | `q,sort,tag,author,root,fav,hasMeta,minImages,page,size` | `{ok,total,page,size,pages,items[]}` | 组合过滤 + 分页。`size` 上限 300（默认 60） |
| GET | `/comic/:id` | — | `{ok,comic{...chapters[]}}` | 详情。`comic` 在 `light()` 基础上多 `description/categories/thumb/creator/favorite/progress/rootPath/chapters[]` |
| GET | `/facets` | — | `{ok,facets{tags,authors,categories},byRoot,stats}` | 预聚合的标签/作者/分类计数（扫描时算好存在索引里） |
| GET | `/stats` | — | `{ok,stats,scannedAt,roots,byRoot,recent[],biggest[],facets,issues}` | 「统计」页用。`issues` 含 `noMeta`/`empty` 的计数与各前 30 条 |
| GET | `/health` | — | `{ok,roots,indexed,byRoot,noMeta[],empty[],duplicatedTitles[]}` | 「体检」：库根可读性、缺元数据、空漫画、重名作品 |
| GET | `/random` | `root?` | `{ok,comic}` | 随机一部（只挑 `images>0` 的）。库空 → 404 |

`sort` 取值：`title`(默认)/`size`/`pages`/`likes`/`views`/`recent`/`author`/`chapters`/`random`。中文标题用 `localeCompare(..., 'zh-Hans-CN', {numeric:true})` 排，避免「第10話」排在「第2話」前面。

`q` 的搜索规则（`search()` 函数）：按空格切成多个词，**所有词都要命中**（AND）；`-xxx` 是排除词。打分权重：标题完全相同 +100、标题包含 +40、作者 +24、标签 +14、汉化组 +8、目录名 +6、简介 +5。命中后按分数降序。

### 2.4 封面与图片

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/cover/:id` | — | 图片二进制 | 封面。优先级：目录内 `cover.jpg` → **首章首图兜底**。都没有 → 404「该漫画没有封面」。`cacheSeconds: 600` |
| GET | `/image` | `comic,order,file` | 图片二进制 | 正文图。三重校验：漫画存在 → 章节存在 → **文件名属于该章节的图片清单**。`cacheSeconds: 86400` |

> `/image` 的文件名白名单校验不是可选项：它挡掉「传 `../../config.json` 读任意文件」。改这里前先读 `AGENT.md` 的安全边界一节。
>
> `/cover/:id` 的「首章首图兜底」与 `light()` 里的 `cover` 字段必须**口径一致**：`hasCover()` 把「有正文图可回落」也算 true。曾经这里只认本地 `cover.jpg`，结果裸形态库（147 部「先期漫画」）整库显示占位块，前端连请求都不发。

### 2.5 收藏与进度

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/marks` | — | `{ok,favorites[],tags{}}` | 收藏 id 列表 + 逐本标签覆盖（`library-marks.json`） |
| POST | `/marks` | body `{id,favorite,tags?}` | `{ok,favorite,total}` | 收藏/取消。`favorite` 缺省 → 400 |
| GET | `/progress` | — | `{ok,progress{comicId:...}}` | 全量阅读进度（`library-progress.json`） |
| POST | `/progress` | body `{comicId,chapter,index}` | `{ok,progress}` | 写进度。与 reader 模块**共用同一份存储**（`src/core/reading-progress.mjs`），不要各存一份 |
| GET | `/continue` | — | `{ok,items[{progress,comic}]}` | 「继续阅读」，默认最近 12 条。索引里已不存在的条目会被过滤掉 |

---

## 3. 索引文件（`data/library-index.json`）

由 `scanner.mjs` 产出，由 `JsonStore('library-index.json', ...)` 持有。**可随时删掉重建**。

```jsonc
{
  "version": 2,
  "scannedAt": "2026-10-16T20:48:48.356Z",
  "roots": [ { "id": "picacg", "name": "哔咔下载库", "path": "...", "ok": true, "error": null, "dirs": 213 } ],
  "byRoot": { "picacg": { "id": "picacg", "name": "哔咔下载库", "comics": 213, "chapters": 1229, "images": 63044, "bytes": 26371057670 } },
  "stats": { "comics": 360, "chapters": 1384, "images": 74693, "bytes": 33750031512, "withMeta": 360, "empty": 0, "scanMs": 6437 },
  "facets": { "tags": [{"name": "純愛", "count": 42}], "authors": [], "categories": [] },
  "comics": []
}
```

单部漫画（`scanComic()` 的返回值）：

| 字段 | 说明 |
|---|---|
| `id` | 优先取 `元数据.json` 的 `id`，否则 `d-` + `shortHash(目录名, 12)` |
| `dir` | 漫画目录名（库根下的一级子目录） |
| `root` / `rootName` | 所属库根 id / 中文名。**老索引可能没有 `root`**，所有用它拼路径的地方都要有探测兜底（`basePathOf()`） |
| `rel` | 根内相对路径 `root/dir` |
| `title` | 优先 `元数据.json` 的 `title`，否则目录名 |
| `author/tags/categories/description/chineseTeam/likes/views/createdAt/updatedAt/thumb/creator` | 从 `元数据.json` 透传，缺失给空串或 0 |
| `pagesCount` | 元数据里的总页数，缺失时用实际图片数 |
| `hasMeta` | 有没有 `元数据.json` |
| `cover` | 目录内的封面文件名（`cover.jpg/jpeg/png/webp`），没有则 null |
| `coverRemote` | 元数据里的远程缩略图 URL（`fileServer + path`），没有则 null |
| `chapters[]` | `{order,title,chapterId,dir,images[],count,bytes}` |
| `chapterCount` / `images` / `bytes` | 章节数 / 图片总数 / 总字节 |
| `dirMtime` | 目录 mtime（「最近改动」排序用） |

### 3.1 扫描规则（`scanner.mjs`）

- **库根下的一级子目录**才是一部漫画；`.` 或 `_` 开头的跳过（留给用户放杂物）。
- **含图子目录 = 章节**。`order` 取目录名首段数字（`/^(\d+)/`），取不到就用序号；`title` 去掉数字前缀。
- **再深一层**（`<漫画>/<分类>/<章节>/图`）也能识别，兼容旧结构。
- **裸形态**：没有含图子目录时，把漫画目录顶层的图当单章，`dir` 记 `.`，`title` 兜底 `第1話`。
- **`cover.*` 不算正文图**，否则每部漫画都会凭空多出一页封面。
- 章节按 `order` 升序；扫描并发 `pool(jobs, 8, ...)`；单部解析失败只跳过它自己（`.catch(() => null)`），不让整次扫描失败。
- 单个库根不可读不会中断扫描，记进 `roots[].ok=false` + `error` 后继续下一个根。

---

## 4. 索引的读取（`src/core/library-index.mjs`）

**其他模块不许在启动时把索引读进内存快照**（会因为索引更新了读不到而报「漫画不存在」）。统一走这 6 个导出：

| 导出 | 用途 |
|---|---|
| `indexFilePath()` | 索引文件绝对路径 |
| `readLibraryIndex(force?)` | 带缓存读取。mtime+size 变了才重读；800ms 内短路；**并发请求共享同一次读盘**（`inFlight`） |
| `listComics()` | `idx.comics || []` |
| `findComicById(id)` / `findByDir(dirName)` | 单本查找（后者按目录名或标题匹配，download 判断「已在库」用它） |
| `indexSummary()` | `{scannedAt,root,stats,count}`，给「先扫描」提示用 |

> ⚠️ `inFlight` 不是性能优化，是**正确性修复**：以前 `checkedAt` 是在 `await` 之前推进的，第二个请求进来会走 800ms 短路拿到上一次的空快照。阅读器同时请求章节数据与图片尺寸，正好会撞上，表现为偶发「漫画不存在」、重试一次又好。

---

## 5. 前端（`public/modules/library.js`）

- 导出 `meta`（`id: library`、`name: 漫画库`、`order: 10`）与 `mount(root, ctx)`。
- 列表用 `virtualGrid`（`public/grid.mjs`）虚拟滚动；分页 `size` 默认 120（可选 120/240/400）。
- 「加载更多」有**双通道**：底部按钮 + 滚动触底自动加载（`loadMore()`）。改动滚动行为后必须跑 `node scripts/dev/ui-scroll-check.mjs`（真浏览器，13 条断言）。
- 密度切换（密铺 6 列 / 标准 5 列 / 大图 4 列）写进 `ctx.state` 的 `library.density`，刷新后保留。
- 扫描进度靠 `EventSource` 订阅 `/api/library/scan/events`，不要改成轮询。

---

## 6. 已知坑

1. **`size` 上限**：`/comics` 硬上限 300。想要全库必须翻页——别为了省事把上限调大，一张卡片一个 DOM 节点，会直接把浏览器拖死。
2. **`light()` 别删字段**：前端卡片依赖 `cover`/`progress`/`favorite`。给 `light()` 加字段安全，删字段会静默白块。
3. **`basePathOf()` 的探测兜底不能删**：老索引条目没有 `root` 字段，直接 `rootById(cfg, comic.root)` 会返回 null，拼出的路径全部错。
4. **扫描期间不要做别的重活**：扫描是 CPU 密集的，期间 `/api/ping` 会超时，靠 `withHeartbeat` 兜。它只在「扫描/下载/查重」这类长任务里需要，普通请求不要包。
5. **`refresh-single` 只刷新一部**：改了目录结构（增删章节）它会正确反映；但如果是**新增了一部漫画**，还得整库扫一次。
6. **收藏与标签覆盖都存在 `library-marks.json`**（`favorites[]` + `tags{}`），而 vault 的标签体系在 `vault-tags.json` / `vault-comic-tags.json`——两套不是同一份数据，别混。

---

## 7. 验证方式

```powershell
node tests/run-tests.mjs library    # 单元/集成：扫描规则、分页、搜索、封面兜底
node tests/run-tests.mjs            # 全量
node scripts/dev/ui-scroll-check.mjs   # 真浏览器验证列表滚动与加载更多
```

测试全部离线：在 `os.tmpdir()` 造样本目录，设 `MV_DATA_DIR` 隔离数据目录，**不触碰真实漫画**。