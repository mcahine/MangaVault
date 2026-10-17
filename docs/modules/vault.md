# 管理台模块（vault）

> 归属：vault-smith ｜ 后端：`src/modules/vault/` ｜ 前端：`public/modules/vault.js` + `public/modules/vault.css`
> 职责：**加工层**——在 library 建立的只读索引之上，提供标签体系、元数据编辑、批量整理、文件校验修复、回收站、统计与备份恢复。
> 一句话：**它不读图、不下载、不查重，只负责"把已经躺在库里的漫画整理好"，且所有会动磁盘的操作都可预演、可还原。**

---

## 1. 它解决什么问题

library 模块只回答"库里有什么"（列目录 + 建索引 + 阅读），但用户真正需要的是**管理**：

| 真实痛点 | vault 的答案 |
|---|---|
| 元数据里没有标签，196 部漫画无法按"純愛/全彩/作者"筛选 | 自动派生标签（7 条规则）+ 手动覆盖层，不动原始 `元数据.json` 也能组织 |
| 「先期漫画」没有 `元数据.json`，无法被任何筛选命中 | 目录兜底扫描 + `来源:手工收录` / `根:先期漫画` 派生标签 |
| 目录名带首尾空格、全角空格、非法字符，同作品命名不统一 | 批量重命名（**先 dry-run 出计划**，确认后执行） |
| 下载中断留下 0 字节坏图 / 缺章节元数据 / 序号断档 | 文件校验 + 一键修复安全项 |
| 想删一部又怕删错 | 回收站（移动而非删除）+ 可还原 + 永久删除需 `confirm=DELETE` |
| 想按体积/作者/阅读时长看库的整体状况 | 统计接口 + 阅读时长记录 + 重复候选（只列不删） |
| 改配置改坏了索引 / 误删标签 | 备份与恢复（保留最近 10 份） |

**分工边界**（避免读者以为功能重复）：

| 模块 | 管什么 | 与 vault 的边界 |
|---|---|---|
| **library**（Lead） | 扫描库根、建 `data/library-index.json` 索引、列表/详情/封面、阅读进度、收藏 | vault **只读**它的索引；vault 改完元数据后调 `POST /api/library/refresh-single` 让它刷新单本 |
| **reader**（Lead） | 实际翻页阅读、阅读模式 | vault 只**记录**阅读时长（`POST /api/vault/reading-time`），不参与渲染 |
| **download**（download-smith） | 从哔咔搜索并下载入库 | vault 把下载好的产物当普通漫画管理；**导出打包复用 download 的能力，vault 不重复造** |
| **dedupe**（dedupe-smith） | 感知哈希指纹级查重、缩略图比对、删除/还原决策 | vault 的 `/api/vault/duplicates` 是**标题/目录名的启发式候选**（廉价、只列不删），精确去重请用 dedupe |

---

## 2. 接口一览（统一前缀 `/api/vault`）

> 下表从 `src/modules/vault/index.mjs` 的 `app.get/post/put/del` 与 `meta.help` 逐条抄录。`meta.help` 另附一览字符串（供 `GET /api/system/info` 展示）。

### 2.1 状态与目录视图

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/api/vault/state` | — | `{ok, roots[{id,name,path,enabled}], catalog{comics,indexed,extra,scannedAt}, tags, shelves, deriveSettings}` | 模块总状态；前端顶栏副标题用它 |
| GET | `/api/vault/comics` | `q, root, tag, page, size` | `{ok, total, page, size, pages, items[]}` | 目录视图清单。`size` 上限 500。每项带 `rootName` + `autoTags[]{name,source,color}` + `overlay` |
| POST | `/api/vault/refresh` | — | `{ok, message}` | 让目录视图缓存失效，下次请求重新读取 |
| GET | `/api/vault/health` | — | `{ok, catalog{total,indexed,extra}, tags{total,unused}, comicsWithoutTags, roots}` | 体检：多少部漫画一个有效标签都没有 |

### 2.2 标签

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/api/vault/tags` | — | `{ok, tags[], settings, updatedAt}` | 标签注册表全量 |
| POST | `/api/vault/tags` | body `{name,aliases,color,group,description}` | `{ok, tag, created, message, status}` | 新建；**同名（归一化后）直接复用已有标签**，`created:false`，HTTP 200 |
| PUT | `/api/vault/tags` | body `{id\|name, name, aliases, color, group, description, keepAlias}` | `{ok, tag, message}` | 改名/别名/颜色(red\|pink\|blue\|cyan\|yellow)/分组/描述。改名会**迁移覆盖层引用**并把旧名保留为别名（`keepAlias:false` 可关） |
| DELETE | `/api/vault/tags` | query `id`（或 body `{id}`），`keepOverlay=1` | `{ok, removed, cleaned, message}` | 删除标签；默认**清理覆盖层里对它的引用**（`cleaned` 条） |
| POST | `/api/vault/tags/delete` | body `{id\|ref, keepOverlay}` | `{ok, removed, cleaned, message}` | 同上（给不方便发 DELETE 的客户端） |
| POST | `/api/vault/tags/merge` | body `{from, to}` | `{ok, from, to, moved, tags, message}` | 合并 A→B：迁移覆盖层引用、A 的名字与别名并入 B 的别名、删除 A。**不能与自身合并** |
| POST | `/api/vault/tags/assign` | body `{comicIds[], add[], remove[], note}` | `{ok, affected, created[], overlay, message}` | 批量打标/去标。`add` 里未登记的标签**自动建**（返回在 `created`） |
| POST | `/api/vault/tags/settings` | body `{derive, skipUnknownTeam, rules{7 键}}` | `{ok, settings, message}` | 派生规则开关，见第 3 节 |
| GET | `/api/vault/tags/stats` | — | `{ok, stats{total, registered, derived, unused[], maxCount, comicCount, bytes, roots, settings, tags[]}}` | 每个标签（含派生的"虚拟标签"）的出现数/体积/按根分布 |
| GET | `/api/vault/tags/export` | — | `{ok, payload{app,kind,version,exportedAt,settings,tags}}` | 导出标签 JSON |
| POST | `/api/vault/tags/import` | body `{payload\|tags, mode:'skip'\|'overwrite'\|'rename'}` | `{ok, result{mode,added,updated,skipped,renamed,errors[]}, tags, message}` | 导入；默认 `skip` |
| GET | `/api/vault/tag/:id/comics` | 路径 `:id`（id 或名字），`page, size` | `{ok, tag, total, page, size, items[]}` | 标签反查；`size` 上限 300。不在当前库的条目回 `rootName:'(不在当前库)'` |

### 2.3 搜索与书架

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/api/vault/search` | `tags, mode('and'\|'or'), exclude, author, root, hasMeta, minPages, sort, q, page, size, fav` | `{ok, total, page, size, query, items[]}` | 组合筛选。`sort`：`title`(默认)/`size`/`pages`/`recent`/`author`/`tagcount`。`q` 搜标题+作者+简介 |
| GET | `/api/vault/shelves` | — | `{ok, shelves[]}` | 书架列表（**存的是查询条件，不是快照**） |
| POST | `/api/vault/shelves` | body `{id?, name, group?, query, note?}` | `{ok, shelf, shelves, message}` | 保存/更新书架；同名或同 id 视为更新。`name` 为空 → 400 |
| DELETE | `/api/vault/shelves` | query `id` | `{ok, removed, message}` | 删除书架；缺 `id` → 400 |

### 2.4 元数据编辑

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| POST | `/api/vault/comic/:id/meta` | 路径 `:id`；body `{title,author,description,chineseTeam,tags[],categories[]}` | `{ok, result{id,dir,file,backup,meta}, message}` | 改写该漫画目录下的 `元数据.json`。写前把原文件备份为 `元数据.json.bak`，用 `atomicWriteJson` 原子替换。写后异步通知 library 刷新单本（失败只 warn，不影响写入结果） |

### 2.5 批量操作

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/api/vault/batch/plan` | `comicIds`（逗号分隔，留空=全库） | `{ok, plan{count, plan[], affectedComics}}` | 重命名计划预览 |
| POST | `/api/vault/batch` | body `{action, comicIds[], options}` | 见下 | `action` 四种，见下表 |

`POST /api/vault/batch` 的 action：

| action | options | 行为 | 返回 |
|---|---|---|---|
| `rename-dirs` | `{confirm}` | `confirm:true` 才执行；否则只返回计划。**空 comicIds + confirm 会 400**（防误操作全库） | dry-run：`{ok, action, dryRun:true, plan, message}`；执行：`{ok, action, result{applied,renamed,failed[],details[]}, message}` |
| `normalize-chapters` | `{confirm}` | 复用 `applyRename`，把章节目录统一为「NN 标题」并补零 | 同上结构 |
| `move-to-root` | `{targetRootId, confirm}` | 库根之间搬动；**跨盘符自动 `fsp.cp` 递归复制后 `fsp.rm`**，同盘走 `rename` | `{ok, action, result{applied,dryRun,moved,failed[],details[]}, message}` |
| `cover` | `{file}` | 为每部漫画设置 `cover.jpg`。`file` 为空则取首章第一张；指定时必须落在该漫画目录内 | `{ok, action, result[], message}` |
| `trash` | — | **未实现**。源码 `default` 分支返回 400，提示支持 `rename-dirs / move-to-root / cover / normalize-chapters / trash`，但 `switch` 里没有 `case 'trash'`。移入回收站请用 `POST /api/vault/trash` | 400 |

> 注意：前端 `public/modules/vault.js` 的「移入回收站」按钮**不经过 /batch**，而是直接调 `POST /api/vault/trash`（源码里有一行占位请求，随即被覆盖）。

### 2.6 回收站

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/api/vault/trash` | — | `{ok, trash{items[], count, bytes}}` | 列表（倒序）。每项带 `exists`（回收站里文件是否还在） |
| POST | `/api/vault/trash` | body `{comicIds[], note}` | `{ok, result{moved, failed[], batch, items[]}, message}` | 把漫画目录**移动**到 `data/vault-trash/<批次>/`（按库根 id 分箱），记录原 `rootId`/`dir`/`trashPath` |
| POST | `/api/vault/trash/restore` | body `{ids[]\|trashPaths[]}` | `{ok, result{restored, failed[], items[]}, message}` | 还原到原位；**原位置被占用时不覆盖**，记 `failed` |
| POST | `/api/vault/trash/purge` | body `{ids[], confirm}` | `{ok, result{purged, failed[], items[]}, message}` | 永久删除。`confirm` 必须等于 `DELETE`，否则 400。删除前校验路径不越出回收站根 |

### 2.7 校验与修复

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/api/vault/verify` | `comicId, root, limit`（默认 400，夹在 1–2000） | `{ok, result{scanned,total,problemComics,high,mid,low,byCode,reports[]}}` | 文件校验。检查项见第 5 节 |
| POST | `/api/vault/verify/fix` | body `{comicId?, confirm}` | `{ok, result{applied,dryRun,count,actions[]}, message}` | 一键修复**安全项**：补 `章节元数据.json`、生成缺失 `cover.jpg`。`confirm !== true` 时只预演 |

### 2.8 重复、统计、阅读时长

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/api/vault/duplicates` | — | `{ok, result{groups[], count, totalComics}}` | 启发式重复候选，最多 200 组。见第 6 节限制 |
| GET | `/api/vault/stats` | — | `{ok, stats{comics,images,bytes,bytesText,noMeta,withMeta,single,multi,byRoot,topAuthors,biggest,reading}}` | 全库统计 |
| POST | `/api/vault/reading-time` | body `{comicId, seconds}` | `{ok, comicId, seconds, totalSeconds, comicSeconds}` | 累加阅读时长。`seconds` 被夹到 **1–7200**。缺 `comicId` → 400 |
| GET | `/api/vault/reading-stats` | — | `{ok, stats{totalSeconds,totalText,totalOpens,comics[≤50],days[最近30天]}}` | 阅读时长排行与日曲线 |

### 2.9 备份与恢复

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/api/vault/backup` | — | `{ok, dir, items[]{file,bytes,mtime}, count}` | 备份列表（倒序） |
| POST | `/api/vault/backup` | body `{note}` | `{ok, result{file,bytes,kept,dropped}, message}` | 打包 7 个 JSON 到 `data/backups/backup-<时间戳>.json`，**只保留最近 10 份** |
| POST | `/api/vault/backup/restore` | body `{file, confirm}` | `{ok, result{restored[],count,from,createdAt}, message}` | `confirm` 必须等于 `RESTORE`，否则 400；文件名必须是 `backup-*.json`（basename 校验，防路径穿越）。恢复后重新 `loadStores()` |

---

## 3. 数据模型

### 3.1 存储文件（全部在 `data/` 下，惰性创建于 `storage.mjs`）

| 文件 | 形状 | 说明 |
|---|---|---|
| `data/vault-tags.json` | `{version, updatedAt, settings, tags[]}` | 标签注册表 + 派生设置 |
| `data/vault-comic-tags.json` | `{version, updatedAt, overlay: { [comicId]: {add[], remove[], note} }}` | **覆盖层**，不动漫画的 `元数据.json` |
| `data/vault-shelves.json` | `{version, updatedAt, shelves[]}` | 书架（保存的是查询条件） |
| `data/vault-reading.json` | `{version, updatedAt, totalSeconds, totalOpens, byComic{}, days{}}` | 阅读时长 |
| `data/vault-trash.json` | `{version, updatedAt, items[]}` | 回收站台账 |
| `data/vault-trash/<批次>/` | 目录 | 真正的漫画目录（这批被移动过来的原始字节） |

### 3.2 标签注册表 `vault-tags.json`

```json
{
  "version": 1,
  "updatedAt": "2026-10-14T08:48:50.000Z",
  "settings": {
    "derive": true,
    "skipUnknownTeam": true,
    "rules": { "metaTags": true, "categories": true, "author": true, "chineseTeam": true, "root": true, "chapterCount": true, "manualSource": true }
  },
  "tags": [
    {
      "id": "tg-a1b2c3d4",
      "name": "純愛",
      "aliases": ["纯爱", "junai"],
      "color": "red",
      "group": "未分组",
      "description": "",
      "createdAt": "…", "updatedAt": "…"
    }
  ]
}
```

要点：

- `id` = `tg-` + `shortHash(名字, 8)`，冲突时依次加 `-2`、`-3`。
- `color` 只能取 `red | pink | blue | cyan | yellow`（`storage.COLORS`）。非法值回落到 `COLORS[0]`；新建未指定时按名字哈希 `defaultColor(name)` 选色。
- `aliases` 与 `name` 都能被 `findTagRef` 反查，**大小写不敏感、全角半角归一**（`normKey`）。`cleanAliases` 会剔除与自身同名的别名并去重。
- `group` 缺省 `未分组`。
- 新建同名标签是**幂等**的：直接返回已有标签（`created:false`），便于"边筛边打标"。

### 3.3 覆盖层 `vault-comic-tags.json`

```json
{
  "version": 1, "updatedAt": "…",
  "overlay": {
    "<comicId>": { "add": ["手动标签"], "remove": ["純愛"], "note": "为什么这样标" }
  }
}
```

- 覆盖层是**逐漫画的增删指令**，不复制整个标签集合，因此元数据变更/重新扫描后依然有效。
- `note` 可参与搜索（`/api/vault/search?……` 的 `note` 关键字）。
- 三步都为空（`add`/`remove`/`note`）时，该条目会被整条删除，避免文件膨胀。
- 删除标签（默认）或合并标签时，会**同步迁移/清理**覆盖层里的对应引用，不留悬挂。

### 3.4 有效标签 = 自动派生 ∪ 覆盖层

这是整个标签系统的核心规则（`tags.mjs: effectiveTags`）：

```
有效标签 = 自动派生标签 ∪ 覆盖层 add  −  覆盖层 remove      （add 优先于 remove）
```

实现顺序（顺序很重要）：

1. 先把 7 条派生规则产出的标签放进 map；
2. 覆盖层的 `remove` 逐个从 map 删掉（可以抵消掉自动标签）；
3. 覆盖层的 `add` 再放进去 —— 所以**同名标签既在 add 又在 remove 时，add 赢**。

每个结果统一为 `{ name, key, color, group, tagId, source }`：

| `source` | 含义 |
|---|---|
| `auto` | 只由派生规则产生 |
| `manual` | 只由覆盖层产生（注册表里可能没登记，`tagId:null`、`group:'未登记'`，颜色按名字哈希） |
| `both` | 派生与覆盖层都有 |

`name` 若在注册表里登记过（按 name 或 alias 命中），展示用注册表的正式名、颜色、分组。

### 3.5 派生规则（`derive.mjs`，7 条规则键）

开关：`rules[k] !== false` 且总开关 `settings.derive !== false`。键名即 `storage.DERIVE_RULE_KEYS`。

| # | 规则键 | 产出 | 说明 |
|---|---|---|---|
| 1 | `metaTags` | 元数据 `tags` 原样 | 直接取自 `元数据.json` 的 `tags` |
| 2 | `categories` | 元数据 `categories` 原样 | 直接取自 `元数据.json` 的 `categories` |
| 3 | `author` | `作者:<author>` | 作者非空时 |
| 4 | `chineseTeam` | `汉化:<chineseTeam>` | `skipUnknownTeam`（默认 true）为真时，跳过 `不明/未知/无/none/unknown/n\/a/-/—/?` 这类占位值 |
| 5 | `root` | `根:<库根中文名>` | 名字来自 `roots.labelOf`，如 `根:哔咔下载库` / `根:先期漫画` |
| 6 | `chapterCount` | `话数:单话` / `话数:多话` | `chapterCount > 1` 为多话，否则单话 |
| 7 | `manualSource` | `来源:手工收录` | 仅当 `hasMeta === false`（没有 `元数据.json`，如先期漫画） |

派生是**纯函数**（`deriveAutoTags(comic, cfg, settings)`），可离线单测；同一部漫画内按 `normKey` 去重。

### 3.6 书架 `vault-shelves.json`

```json
{
  "version": 1, "updatedAt": "…",
  "shelves": [
    { "id": "shelf-a1b2c3", "name": "全彩短篇", "group": "", "note": "",
      "query": { "tags": "純愛,全彩", "mode": "and", "author": "", "root": "" },
      "createdAt": "…", "updatedAt": "…" }
  ]
}
```

- **书架保存的是查询条件而不是快照**：打开时实时走 `/api/vault/search`，所以库变了结果自动跟着变（前端有 `.alert-info` 明确告知）。
- 保存时若名字或 id 命中已有书架则视为更新，保留原 `createdAt`。
- `id` 生成规则 `shelf-<6 位随机 base36>`。

### 3.7 阅读时长 `vault-reading.json`

```json
{
  "version": 1, "updatedAt": "…",
  "totalSeconds": 0, "totalOpens": 0,
  "byComic": { "<comicId>": { "seconds": 0, "opens": 0, "lastAt": "ISO" } },
  "days": { "2026-10-14": 0 }
}
```

- `POST /api/vault/reading-time` 每次上报把 `seconds` 夹到 **1–7200**，同时累加 `totalSeconds`、`totalOpens`、`byComic[comicId]`、`days[今天]`。
- `reading-stats` 按累计秒数倒序取前 50 部；`days` 取最近 30 天。已不在库的漫画标题显示为 `(已不在库)`。

### 3.8 回收站 `vault-trash.json` + `data/vault-trash/`

```json
{
  "version": 1, "updatedAt": "…",
  "items": [
    { "comicId": "…", "title": "…", "rootId": "picacg", "dir": "原名目录",
      "bytes": 1431600, "images": 42,
      "trashPath": "20261014-164850-ab12/picacg/原名目录",
      "batch": "20261014-164850-ab12", "at": "ISO", "note": "验收" }
  ]
}
```

- 批次目录名 = `stamp()` + `-<4 位随机 base36>`（如 `20261014-164850-ab12`），批次内按 `rootId` 分箱。
- `trashPath` 相对 `data/vault-trash/`，用于还原/删除时重新定位。
- `GET /api/vault/trash` 会逐条 `stat` 真实文件，回填 `exists`；前端对 `exists:false` 的条目**禁用还原按钮**并显示"文件已丢失"。

### 3.9 备份包 `data/backups/backup-<时间戳>.json`

```json
{
  "version": 1, "createdAt": "ISO", "note": "",
  "files": {
    "library-index.json": {…}, "library-progress.json": {…}, "library-marks.json": {…},
    "vault-tags.json": {…}, "vault-comic-tags.json": {…}, "vault-shelves.json": {…},
    "vault-reading.json": {…}
  }
}
```

- 共 **7 个文件**。读不到的文件（如还没生成）写 `null`，恢复时跳过。
- 保留最近 **10 份**（`BACKUP_KEEP = 10`），超出的按文件名排序（即时间顺序）删最早的。

### 3.10 目录视图的数据来源（`catalog.mjs`）

vault 的"管理对象清单"不是自己扫盘的：

1. 主数据源是 library 写出的 `data/library-index.json`；
2. 对每个启用的库根**再做一次轻量目录兜底**：只读顶层目录名 + `元数据.json`，补出 `indexed:false` 的最小条目（这就是"先期漫画"这类无元数据/未收录根也能被管理的原因）；
3. 图片体积/章节结构这类重字段**延迟 hydrate**（`hydrateComic`），避免每次请求都全盘 `stat`；
4. 缓存 4 秒（`CACHE_MS = 4000`），缓存键包含**库根签名**（`id:path:enabled` 列表）——库根一改立刻失效。

**陈旧索引清理**：索引里有、磁盘上已不存在的条目会被丢弃（`staleIndexEntries`）。曾实测"改名后索引旧条目 + 磁盘新目录"被算成两条（2 部变 3 部），这是当时的真实 bug，已有回归单测。只有在**所有根都读不到**（如整根离线）时才保守沿用索引条目。

---

## 4. 安全设计

### 4.1 路径必须落在库根内

| 机制 | 位置 | 作用 |
|---|---|---|
| `requireInsideRoot(cfg, absPath, what)` | `paths.mjs` | 绝对路径必须落在某个库根内，否则抛 **400**「<what>不在任何库根内，拒绝操作：<path>」 |
| `insideRoot(cfg, absPath)` | `paths.mjs` | 返回所属根（多个根嵌套时取**路径最长**的那个），越界返回 `null` |
| `ownerRootOf(cfg, absPath)` | `src/core/roots.mjs` | 契约指定的**多库根统一入口**；vault 的 `insideRoot` 与之同构 |
| `safeJoin(root, rel)` | `src/core/util.mjs` | 拼接请求参数来的相对路径，越界自动 400 |
| `relOfRoot(root, absPath)` | `paths.mjs` | 回显给前端时统一用 `/` 分隔的相对路径 |

具体落点：

- `editMeta`：`comicAbs` → `requireInsideRoot(…,'漫画目录')` 之后才碰文件。
- `applyRename` / `moveToRoot`：源与目标**各自**校验一次。
- `trashComics` / `restoreTrash`：写前校验漫画目录；还原时用 `safeJoin(root.path, it.dir)`。
- `purgeTrash`：删除前要求 `path.resolve(abs).startsWith(path.resolve(trashRootDir()))`，越界记 `failed: '路径越界'` 而不是删。
- `setCover`：`file` 必须在该漫画目录内（`safeJoin(abs, o.file)`），且扩展名必须在 `IMAGE_EXT` 里。

### 4.2 破坏性操作为什么要 dry-run

会改磁盘的操作统一遵循「**默认只预演，`confirm` 才落地**」：

| 操作 | 预演触发条件 | 落地条件 |
|---|---|---|
| 批量重命名 `rename-dirs` / `normalize-chapters` | `options.confirm !== true`（或未传 options） | `options.confirm === true` |
| 库根搬动 `move-to-root` | 同上 | 同上 |
| 一键修复 `verify/fix` | `confirm !== true` → `{dryRun:true, actions[]}` | `confirm === true` |

理由：重命名/搬动是**不可逆的文件系统改名**，且一次能影响全库。预演返回完整的 `from → to` 清单和 `reason`，前端把它渲染成台账行让用户逐条看，并提示"建议先做一次备份"。`applyRename` 执行时还会逐项 `stat` 目标，**目标已存在就跳过并记入 `failed`**，绝不覆盖。

### 4.3 删除为什么要 confirm 文本

普通 `confirm:true` 只能防误点，防不住**脚本/Ctrl+V 式误触发**，也防不住"我把危险接口当普通接口调了"。所以两个最危险的接口要求**手打确认词**：

| 接口 | 确认词 | 校验位置 |
|---|---|---|
| `POST /api/vault/trash/purge` | `confirm='DELETE'`（大小写不敏感，会 `trim().toUpperCase()`） | `ops.purgeTrash`，不匹配 → 400「永久删除需要 confirm=DELETE」 |
| `POST /api/vault/backup/restore` | `confirm='RESTORE'` | `ops.restoreBackup`，不匹配 → 400「恢复备份需要 confirm=RESTORE」 |

前端 `public/modules/vault.js` 在发请求前再走 **双层 UI**：先 `ctx.confirm()`（危险样式），再用 `ctx.prompt()` 让用户手打 `DELETE` / `RESTORE`，不匹配就本地取消、请求根本不发。另外批量重命名在 `confirm:true` 且 `comicIds` 为空时直接 **400**（源码注释：「避免误操作全库」）。

### 4.4 回收站如何还原

1. **移入**：`fsp.rename` 把 `<root>/<dir>` 搬到 `data/vault-trash/<批次>/<rootId>/<sanitizeDirName(dir)>`（同盘 rename，瞬时且不复制字节）。台账记录 `rootId` + 原 `dir` + `trashPath`。
2. **列取**：逐条 `stat` 回收站里的真实路径，回填 `exists`。
3. **还原**：`path.join(trashRootDir(), it.trashPath)` → `safeJoin(root.path, it.dir)`。
   - 库根已不存在 → `failed:'库根已不存在：<id>'`，条目**保留**在台账里；
   - 原位置已被占用 → `failed:'原位置已被占用，未覆盖'`，条目**保留**；
   - 成功 → 从台账移除，返回在 `items` 里；
   - `ids` 为空 = 还原全部。
4. **永久删除**：需 `confirm='DELETE'`；逐条校验路径不越界后 `fsp.rm(recursive)`，成功的从台账移除，失败的保留并记原因。

**关键性质**：还原失败时条目**永远留在台账**，不会出现"数据在回收站但账上没有"的孤儿状态。

---

## 5. 文件校验项（`ops.verifyComics`）

| code | 严重度 | 触发条件 |
|---|---|---|
| `missing` | high | 图片 `stat` 失败（读取不到） |
| `zero` | high | 0 字节文件 |
| `tiny` | mid | `0 < size < 200` 字节，疑似坏图 |
| `header` | high | 前 4 字节既不是 JPEG(`FFD8`)、PNG(`8950`)、也不是 WebP(`RIFF`) |
| `truncated` | mid | JPEG 末两字节不是 `FFD9`，可能下载不完整 |
| `gap` | mid | 章节内图片序号断档（如从 3 跳到 5） |
| `no-chapter-meta` | mid | 章节目录缺 `章节元数据.json` |
| `chapter-meta-field` | low | 章节元数据缺 `chapterId` |
| `no-cover` | low | 缺 `cover.jpg`（阅读器会用首章首图兜底） |
| `no-meta` | low | 缺 `元数据.json`（不影响阅读） |
| `dirname` | mid | 目录名不规范（非法字符 / 首尾点或空格 / 全角空格 / 连续空白 / 超 100 字 / Windows 保留名） |

`dirNameIssues` 的问题清单也用于批量重命名的 `reason` 字段。`verify/fix` 只做两个**安全**动作：`write-chapter-meta`（补 `章节元数据.json`）与 `make-cover`（生成缺失封面）；它**不会**删文件、不会改目录名。

### 5.1 校验的抽样上限（重要）

图片字节校验（`checkImage`）**不是全量**：每章只取 `names.slice(0, 400)` 张（自然序前 400 张）。因此：

- 单章超过 400 张图时，第 401 张以后的坏图**不会被发现**；
- 接口 `limit` 参数限制的是**漫画部数**（默认 400，夹在 1–2000），不是图片数。

---

## 6. 已验证行为

### 6.1 破坏性操作验收：`scripts/dev/vault-acceptance.mjs` — **28 / 28 通过**

脚本全程把库根指向 `%TEMP%` 的隔离样本（2 个库根各 1 部，样本里故意埋了 0 字节坏图 + 缺章节元数据 + 不规范目录名），结束时恢复原库根并重新扫描。**绝不触碰真实漫画。**

本次运行的结论记录在 [vault-acceptance.log](../../data/vault-acceptance.log)（「通过 28 / 失败 0」）。

| # | 断言内容 | 结论 |
|---:|---|---|
| 1 | 样本就绪：A=1 部（含 0 字节坏图 + 缺章节元数据），B=1 部（目录名不规范） | 样本建立 |
| 2 | 切换到样本库根（`POST /api/config` 改 `libraryRoots`） | 通过 |
| 3 | **vault 目录视图随库根立即刷新**（期望 2 部，实际 2；此前真实 bug 是仍看到旧的 249/50 部） | 通过 |
| 4 | 新建标签（`POST /api/vault/tags`）→ 「已新建标签「验收标签_…」」 | 通过 |
| 5 | 批量打标（`tags/assign`，含一个未登记标签）→ `affected=1`，自动建标签 | 通过 |
| 6 | 标签反查（`GET /api/vault/tag/:name/comics`）→ 1 部 | 通过 |
| 7 | 元数据编辑（`POST /comic/:id/meta`）→ 「元数据已写入（原文件备份为 元数据.json.bak）」 | 通过 |
| 7b | 磁盘上确实存在 `元数据.json.bak` | 通过 |
| 8 | 文件校验（`GET /verify?limit=50`）→ 检查 2 部，问题 2 部（严重 1 / 中等 5） | 通过 |
| 8b | 检出 0 字节坏图：`{"no-meta":1,"dirname":1,"no-cover":2,"no-chapter-meta":2,"gap":2,"zero":1}` | 通过 |
| 8c | 检出缺章节元数据 | 通过 |
| 9 | 一键修复（`POST /verify/fix {confirm:true}`）→ 「已修复 4 项」 | 通过 |
| 9b | `1 第1話\章节元数据.json` 已补齐 | 通过 |
| 10 | 重命名**预演**（`POST /batch {action:'rename-dirs', options:{confirm:false}}`）→ 1 项，目标 `"脏 名字 测试"` | 通过 |
| 10b | **预演不动磁盘**（原目录 `" 脏 名字 测试 "` 仍在） | 通过 |
| 11 | 执行重命名（`confirm:true`）→ 成功 1 项 | 通过 |
| 11b | 目录已规范化：`" 脏 名字 测试 "` → `"脏 名字 测试"`（首尾/重复空格清理） | 通过 |
| 12 | 移入回收站（`POST /trash`）→ 「已移入回收站 1 部」 | 通过 |
| 12b | 原目录已从库根移走 | 通过 |
| 13 | 回收站列表（`GET /trash`）→ 1 条，`bytes` 正确 | 通过 |
| 14 | 还原（`POST /trash/restore {ids:[trashPath]}`）→ 「已还原 1 部」 | 通过 |
| 14b | 已还原到原位 | 通过 |
| 15 | 备份（`POST /backup`）→ 「已备份到 `backup-20261014-164850.json`（约 6 KB）」 | 通过 |
| 15b | 备份列表 `count >= 1`（该次运行 2 份） | 通过 |
| 16 | 统计（`GET /stats`）→ 2 部 / 1.37 MB / 无元数据 1 | 通过 |
| 17 | **拒绝** `confirm != 'DELETE'` 的永久删除 → HTTP 400「永久删除需要 confirm=DELETE」 | 通过 |
| 18 | **拒绝**未知 `action:'rm-rf'` → HTTP 400 | 通过 |
| 19 | **拒绝**空 `comicIds` 的批量重命名（防误操作全库）→ HTTP 400 | 通过 |
| 20 | 元数据写入仍正常（对照组，确认上面的拒绝没有把接口带坏） | 通过 |
| 21 | 测试标签已清理（`DELETE /api/vault/tags?id=…`） | 通过 |
| 22 | 库根已复原 → 目录 249 部 | 通过 |
| — | **合计** | **通过 28 / 失败 0** |

> 脚本另有一份等价的 PowerShell 版本 `scripts/dev/vault-acceptance.ps1`（作者注明"用 Node 写而不是 PowerShell：原生 UTF-8，没有引号/编码地狱"）。

### 6.2 单测：`tests/vault.test.mjs`

> ⚠️ 该文件在本次文档编写期间被**并行改动**（171 行 → 186 行）。下面写的是**改后**（我最后一次读到的版本）的实测数字，与验收脚本无关。

覆盖 **50 条断言**（`t.eq` 25 + `t.ok` 25，另含 4 条 `throwsAsync`），全部离线、数据目录指向 `os.tmpdir()`，6 组：

| 组 | 断言数 | 覆盖内容 |
|---|---:|---|
| 1 路径与命名工具 | 11 | `tidySpaces` 压首尾与重复空格 / 把全角空格当空白；`sanitizeDirName` 去首尾空格；`dirNameIssues` 识别首尾空格、正常名无问题；`parseOrderPrefix` 同时解析序号与标题、无序号返回 `null`；`chapterDirName` 默认补零 2 位与自定义宽度；`normKey` 全角与大小写归一 |
| 2 标签 CRUD / 合并 / 别名 | 8 | 新建返回 id；同名（空格归一）不重复创建并复用同一 id；别名反查、别名大小写不敏感；合并成功、被合并标签已移除、被合并的名字进入目标别名；`throwsAsync`：拒绝自身合并 / 更新不存在的标签 / 空标签名 |
| 3 自动派生标签 | 12 | 带元数据 `tags`、带作者标签、带库根标签；**每个派生标签都带 `group` 归类与归一化 `key`**；同一标签不重复派生；覆盖层记录 add/remove；有效标签包含 add、排除 remove；空 `comicIds` 报错；**删除标签后覆盖层引用被清理** |
| 4 目录视图 | 13 | 两个库根都被收录、`rootId` 分别正确；有元数据用元数据标题；**`hydrateComic` 后统计出章节图片数 / 章节数 / 体积**；单章形态（图片直接躺在目录）hydrate 后也能统计；**改名后仍是 2 部（陈旧索引条目被丢弃、不重复计数）**，旧目录名消失、新目录名出现；库根移除后不再返回该根条目 |
| 5 搜索与书架 | 2 | 书架能保存查询条件；查询条件可归一化 |
| 6 标签统计与导出导入 | 4 | 导出返回 `tags` 数组；导入成功；导入后标签数 +1；`skip` 策略下重复导入不新增 |

改动的方向（相对旧版）：`parseOrderPrefix` 改为断言对象、`chapterDirName` 默认宽度改为断言 `03 第3話`、派生标签新增 `group`/`key`/去重三条、目录视图把 `images` 断言挪到 `hydrateComic` 之后并补了 `rootId`/`chapterCount`/`bytes`、`throwsAsync` 由 5 条变 4 条。

---

## 7. 已知限制

| 限制 | 说明 |
|---|---|
| **图片字节校验是抽样上限** | 每章只检查自然序前 400 张（见 5.1）。超长章节的坏图可能漏检；`limit` 限制的是漫画部数而不是图片数 |
| **重复检测是启发式的，不是精确去重** | `/api/vault/duplicates` 只做两件事：① 标题归一化后完全相同（置信度 1.0，去掉括号/标点/空白）；② 目录名互相**包含**且两串都 ≥ 4 字符（置信度 0.6）。第二种是 O(n²) 两两比较，**只比较前 900 部**（`N = Math.min(items.length, 900)`），且最多返回 200 组。它不做哈希/感知哈希/逐字节比对，**只列不删**。真正的精确查重请用 dedupe 模块 |
| **备份不含图片本体** | 备份包只有 7 个 JSON（索引/进度/收藏/标签/覆盖层/书架/阅读时长），**没有漫画图片**。恢复也不能恢复图片 |
| **备份保留 10 份** | 超过 10 份按文件名（时间）顺序删最早的，且**没有逐份删除接口**——只能靠新备份滚动淘汰 |
| **恢复是"整文件覆盖"** | `backup/restore` 用备份里的文件内容整体覆盖 `data/` 下的对应文件，**不做合并、不先备份当前状态**。误恢复会丢掉当前标签/进度（需要先手动再备份一次） |
| **回收站与备份都在 `data/` 下** | 如果 `data/` 与漫画库不同盘，`trashComics` 的 `fsp.rename` 会**跨盘失败**（源码未做跨盘 `cp + rm` 兜底，这一点与 `moveToRoot` 不同）。回收站里是**副本**还是**移动**取决于是否同盘：同盘是移动（不占额外空间），跨盘会直接报错 |
| **`move-to-root` 先复制后删除，中途失败可能留下半份** | 跨盘路径走 `fsp.cp` → `fsp.rm`。如果在 `cp` 中途失败，源目录还在、目标目录可能残缺；`rm` 只在 `cp` 成功后执行，不会丢数据，但需要人工清理目标残留 |
| **`normalize-chapters` 复用 `applyRename`** | 它和 `rename-dirs` 实际调用同一个 `applyRename`，`planRename` 会同时规划漫画目录与章节目录。前端把两者做成不同按钮只是语义区分，**没有独立的章节 order 重排实现**（`chapterInfos` 里的 order 不参与改写） |
| **`batch` 的 `trash` action 未实现** | 源码 `switch` 里无 `case 'trash'`，走到 `default` 返回 400（错误提示里却写了支持 `trash`，文案与实现不一致）。前端已绕开，直接用 `POST /api/vault/trash` |
| **前端「快速体检」按钮未实现跳转后自动执行** | `runVerifyQuick` 只切到「校验修复」页签，用户还需手动点「开始校验」 |
| **`tags/stats` 的 `usedCount / unusedCount / derivedCount / manualCount` 未由后端提供** | 前端标签墙统计卡读了这些字段，但 `tagStats()` 实际只返回 `total / registered / derived / unused[] / maxCount / comicCount / bytes / roots / settings / tags[]`。因此那几个统计格会显示 `0` 或空 —— **未验证**是设计如此还是遗留缺口 |
| **阅读时长需要调用方主动上报** | vault 只在收到 `POST /api/vault/reading-time` 时累计；它不是计时器，也不会自动从 reader 拿数据 |
| **`/comics` 的 `tag` 过滤要求精确匹配** | 用 `effectiveNames(x).some(n => n.toLowerCase() === key)`，**不支持部分匹配**；模糊筛选用 `/api/vault/search` 的 `tags` 参数 |
| **搜索的 `q` 只覆盖标题/作者/简介** | 不含标签名，也不搜目录名（`/api/vault/comics` 的 `q` 才搜目录名）。`note` 关键字只匹配覆盖层的 `note` |
| **前端列表有截断** | 标签墙漫画清单最多渲染 300 条，标签云最多 260 个；这是前端渲染上限，不是数据上限 |

---

## 8. 前端（`public/modules/vault.js`）

页签（`.tabbar` / `.tab`，当前页签存在 `ctx.state` 里，切页不丢）：**标签墙 / 批量整理 / 校验修复 / 回收站 / 统计 / 书架 / 备份**。

| 页签 | 关键交互 |
|---|---|
| 标签墙 | 标签云（字号 = 漫画数、颜色 = 标签色，点击弹反查 modal）；新建标签；勾选漫画 → 输入逗号分隔标签批量打标（前缀 `-` 表示移除）；「编辑元数据」按钮开 modal 编辑标题/作者/汉化组/标签/分类/简介，弹窗顶部明确提示会写 `元数据.json` 并自动备份 `.bak` |
| 批量整理 | 四个操作按钮（规范化目录名 / 重排章节目录 / 移动到其它库根 / 移入回收站）+ 范围输入 + 目标根选择。**先出预演台账 → 再 `ctx.confirm` 二次确认 → 才执行**；回收站按钮要求必须填 comicIds |
| 校验修复 | 「开始校验」（limit 200）与「全量校验（含图片字节）」（limit 2000）；结果用 `.stat-row` + `.ledger` + 逐部卡片（`.stamp` 显示问题项数、`.badge` 按严重度着色）；「一键修复安全项」先 dry-run 预览再确认 |
| 回收站 | 条目数 + 可回收空间统计；单条/全部还原、单条/全部永久删除（**confirm + 手打 DELETE 双层**）；`exists:false` 的条目灰显且禁用还原 |
| 统计 | 顶部 5 格统计；按库根 / 作者 Top 20 / 体积 Top 10 / 阅读时长 Top / 重复候选（`.stamp` 显示置信度百分比）五个卡片 |
| 书架 | 填名字 + 标签(AND) + 作者 + 库根 → 保存；打开书架走 `/api/vault/search` 弹 modal，可直接「▶ 阅读」跳 reader |
| 备份 | 立即备份；列表显示文件名/大小/时间 + 恢复按钮（**手打 RESTORE 确认**）；顶部告知"自动保留最近 10 份"与"不含漫画图片本身" |

视觉按 v2 RISOPRINT：`.misprint` 套印标题、`.label-mono` 编号小标、`.ledger/.ledger-row` 台账行、`.stamp` 印章、`.rule` 双线分隔、`.tabbar` 粗底边页签、`.toolgrid` 工具箱栅格。自定义样式在 `public/modules/vault.css`，类名 `mv-vault-*` 前缀，未改 `theme.css`。

---

## 9. 写操作清单（谁能改磁盘）

| 接口 | 是否改漫画目录 | 是否改 `data/` |
|---|---|---|
| `POST /comic/:id/meta` | 是（`元数据.json` + `.bak`） | 索引缓存失效 |
| `POST /batch rename-dirs` / `normalize-chapters` | 是（目录改名） | 索引缓存失效 |
| `POST /batch move-to-root` | 是（跨根搬动） | 索引缓存失效 |
| `POST /batch cover` | 是（写 `cover.jpg`） | 索引缓存失效 |
| `POST /trash` / `restore` | 是（移动到/移出回收站） | `vault-trash.json` |
| `POST /trash/purge` | 是（永久删除回收站内容） | `vault-trash.json` |
| `POST /verify/fix` | 是（补章节元数据 / 生成封面） | 索引缓存失效 |
| 标签/书架/设置/打标 | 否 | 对应 `vault-*.json` |
| `POST /backup` / `backup/restore` | 否 | `data/backups/` 与 7 个数据文件 |

每次 `register` 时 `loadStores()` 载入全部数据文件；每个写接口成功后立刻 `flushAll()`（不等 400ms 防抖），保证刷新页面能立刻看到。

---

## 10. 交付前自检

```powershell
node --check src/modules/vault/index.mjs
node --check public/modules/vault.js
node tests/run-tests.mjs vault        # 50 通过 / 0 失败
node scripts/dev/vault-acceptance.mjs # 28 通过 / 0 失败（需内核在 127.0.0.1:8775 运行）
```

验收脚本会临时改库根（`POST /api/config`），**只能在测试实例上跑**；它自带 `finally` 复原逻辑并会重新扫描。
