# 下载模块（download）

> 归属：download-smith ｜ 代码：`src/modules/download/` ｜ 前端：`public/modules/download.js` + `public/modules/download.css`
> 职责：搜索哔咔（PicACG）漫画 → 建下载任务 → 并发下载 → 按现有库结构落盘 → 被 library 模块直接索引。

---

## 1. 接口一览（统一前缀 `/api/download`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/state` | 模块状态：token 是否可用（只回 hasToken/tokenPreview）、下载根目录、磁盘可用空间、并发参数、在跑/排队任务数、SSE 连接数 |
| GET | `/search?q=&page=` | 搜索漫画，返回 id/title/author/cover/tags/章节数/是否已在库（`inLibrary`/`localDir`） |
| GET | `/comic/:id` | 漫画详情 + 全量章节（含每章 `downloaded/complete/images/bytes`） |
| GET | `/comic/:id/chapters` | 只回章节列表与本地扫描结果（`?title=` 可跳过详情请求） |
| POST | `/tasks` | 建任务 `{comicId, title?, chapters?:[order...]}`；不传 chapters = 全部。已在库/已有任务会 `reused:true` 复用而不重复下载 |
| GET | `/tasks` | 任务列表（含 percent/speed/etaMs/章节级进度）+ 汇总 stats |
| GET | `/tasks/:id` | 单任务详情 |
| POST | `/tasks/:id/pause` | 暂停：停止取新图，等在途请求自然结束（不硬杀，不留半截文件） |
| POST | `/tasks/:id/resume` | 继续：断点续传，已存在的图片全部跳过 |
| POST | `/tasks/:id/cancel` | 取消：置 canceled + abort 在途请求，清理 .part 临时文件 |
| DELETE | `/tasks/:id` | 删除任务记录（磁盘上已下载的图片保留） |
| GET | `/events` | SSE：`state`（首次推送全量任务）/ `progress` / `done` / `error`，data 含 taskId + 章节级进度 |
| GET | `/cover?path=` | 代理本地封面/图片（path 必须 safeJoin 在 downloadRoot 内） |
| POST | `/open-folder` | 资源管理器打开目录，body `{comicId}` / `{taskId}` / `{comicTitle}`，缺省打开根目录 |
| GET | `/token-check` | 调 `users/profile` 校验 token 是否有效（5 秒内结果缓存） |

所有响应：成功 `{ok:true,...}`，失败 `{ok:false,error:'中文原因'}`（HTTP 状态码同步给出 400/401/404/409/502）。

### 下载源参数（sourceId）

需要访问上游的路由都认 `sourceId`（查询串 `?sourceId=` 或 JSON body 的 `sourceId`，别名 `source`），缺省是默认源 `picacomic`。
路由层自己**不认识任何具体来源**：它从注册表取适配器 → 用 `requireCapability` 断言本次需要的能力 → 消费统一的 Comic/Chapter/Page。

- 未注册的源 → `400 {ok:false, error:'未知的下载源：xxx（已注册：…）'}`
- 能力缺失（适配器没实现，或适配器内部抛 `NotSupportedError`）→ `400 {ok:false, error:'该下载源不支持此能力…'}`
  **不会**变成 500，也不会漏出英文 JS 报错。
- 下载任务会记下建单时的 `sourceId`（落在 `download-tasks.json`，不出现在任务视图里，响应结构不变），
  续传/重试仍走同一个源；该源已被注销时自动退回默认源，并把原因写进任务日志。

契约、接入步骤与能力清单见 [`docs/DOWNLOAD_SOURCES.md`](../DOWNLOAD_SOURCES.md)：**新增一个下载源不需要改这里的任何路由**。

---

## 2. 签名算法（**已按上游源码交叉验证**）

> 参考实现：`lanyeeee/picacomic-downloader` 的 `src-tauri/src/pica_client.rs`。
> 项目文档里曾写成「裸 sha256」，实测**必须**用 HMAC-SHA256 且要带固定盐 `DIGEST_KEY`，否则上游一律 401。

```
data      = lowercase( path + time + nonce + METHOD + apiKey )     // path 不含 query，前导斜杠要去掉
signature = HMAC-SHA256(DIGEST_KEY, data) 的小写 hex
```

固定常量（`api.mjs` 导出，可用 config 覆盖）：

| 常量 | 值 |
|---|---|
| `PICA_API_KEY` | `C69BAF41DA5ABD1FFEDC6D2FEA56B` |
| `PICA_NONCE` | `ptxdhmjzqtnrtwndhbxcpkjamb33w837` |
| `PICA_DIGEST_KEY` | `~d}$Q7$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV\`:<>M7pddUBL5n|0/*Cn` |

请求头（时间戳字段名是 **time**，不是 timestamp）：

```
api-key, accept: application/vnd.picacomic.com.v1+json, app-channel: 2, time, nonce,
app-version, app-uuid, app-platform, app-build-version, Content-Type: application/json; charset=UTF-8,
User-Agent: okhttp/3.12.13, signature, image-quality: original, authorization: <token>
```

单测里直接断言 `createSignature(path, method, time)` 的 hex，且验证「带不带 `?page=2` 结果一致」。

### 主要接口路径
- `POST /comics/advanced-search?page=N`，body `{keyword, sort:'dd', categories:[]}` → `data.comics.docs[]`
- `GET /comics/{id}` → `data.comic`
- `GET /comics/{id}/eps?page=N` → `data.eps.docs[]`（`_id/title/order/updated_at`）
- `GET /comics/{id}/order/{order}/pages?page=N` → `data.pages.docs[].media`
- `GET /users/profile`（校验 token）

> 上表这些路径的实现**全部**在 `src/modules/download/sources/picacomic.mjs`（适配器）。
> `api.mjs` 只保留通用 HTTP 链路（`raw()` 请求 + `download()` 二进制），原先重复的第二套接口实现已删除，
> 避免两处漂移；点赞 / 推荐等无调用方的方法一并删掉，需要时再按契约加回适配器。

### 图片直链
```
图片： media.fileServer + '/static/' + media.path          // path 里的 \\ 统一改 /
封面： thumb.fileServer + '/static/' + service + '/' + signature + '/' + 文件名
       （service/signature 是 thumb.path 的前两段，最后一段是文件名）
```

---

## 3. 目录结构规范（与现有库同构，library 扫完立刻可读）

```
<downloadRoot>/
  <comic_title>/                         # sanitizeName 后的标题
    元数据.json
    cover.jpg
    <order> <chapter_title>/             # 由 config.picacomic.dirFmt 决定（默认 '{order} {chapter_title}'）
      章节元数据.json
      001.jpg  002.jpg  003.jpg …        # 三位补零；扩展名由 downloadFormat 决定（Jpeg/Webp/Png）
```

- `元数据.json`：`id/title/author/pagesCount/chapterInfos[{chapterId,chapterTitle,order}]/chapterCount/finished/categories/tags/description/likesCount/viewsCount/createdAt/updatedAt/chineseTeam/thumb/creator`。默认写 **reference 格式**（字段与 picacomic-downloader 产物完全一致，不含本地路径字段）；`buildComicMetadata(..., {format:'rich'})` 可切到"保留上游原始字段"。
- `pagesCount` 取该漫画实际下载到的图片总数（章节跑完即刷新一次，任务结束再刷新一次）。
- `章节元数据.json`：`{chapterId, chapterTitle, order}`。全部图片就位后才写，写完立即原子替换目录。
- 目标目录名一律 `sanitizeName()` 清洗；写入前用 `isInside(downloadRoot, dir)` 校验，越界直接拒绝。

---

## 4. 并发 / 限速

| 层级 | 参数 | 默认 | 说明 |
|---|---|---|---|
| 任务 | `picacomic.maxConcurrentTasks` | 2 | 同时在跑的任务数上限，其余排队（全局硬上限 2） |
| 章节 | `chapterConcurrency` | 2 | 同一任务内并发的章节数 |
| 章节 | `chapterIntervalMs` | 8000 | 相邻章节**开始**的最小间隔（兼容老配置 `chapterDownloadIntervalSec`，单位秒） |
| 图片 | `imgConcurrency` | 12 | 同一任务内并发的图片数 |
| 图片 | `imgIntervalMs` | 2500 | 相邻图片**发起**的最小间隔（兼容 `imgDownloadIntervalSec`） |

限速器是「预约式」的：`createLimiter(ms)` 只保证相邻两次取号间隔 ≥ ms，取号后各 worker 并行发请求，所以并发度不会被限速器压成串行（比 core 的链式 `createRateLimiter` 更适合放进并发池）。

---

## 5. 重试与失败处理

- **API 层**（`api.mjs`）：单次请求可超时 abort（`timeoutMs`，默认 30s）；`retryTimes`（默认 3）内对 **429 / 5xx / 网络错误** 做指数退避 + 抖动重试；4xx（401/403/404）直接失败并翻译成中文：
  - 401/403 → 「哔咔 token 无效或已过期，请到「设置」里更新 token」
  - 429 → 「请求过于频繁被哔咔限流，请调大下载间隔后重试」
  - 5xx → 「哔咔服务端错误 HTTP 5xx，稍后重试」
  - 网络 → 「无法连接哔咔接口：…（可能需要配置代理）」
- **图片层**：单图失败按 `retryTimes` 重试，仍失败则**记入任务日志（死信）并继续下一张**，不会终止章节或任务。
- **章节层**：整个章节失败只把该章节标 `error`，任务收尾时为 `error` 状态并给出可读原因（含缺图数与具体章节），已下好的图片保留在磁盘。
- **坏图自愈**：章节开始时把 < 512B 的图片判为坏图删除重下，避免「永远缺图」。
- **原子写**：所有 JSON 先写 `.tmp-<pid>-<序号>` 再 rename，且同一目标文件的写入在进程内**串行**（并发下载时每个章节完成都会刷新同一份 `元数据.json`，
  临时文件名共用会互相搬走文件，rename 目标争用会 EBUSY/EPERM —— 两者都会在目录里留下 `.tmp-` 残渣）；图片先写 `.part-<pid>` 再 rename；章节整体用「临时目录 → rename → 删旧目录」替换，半成品不会污染库。
- **状态与磁盘一致**：任务改成 `done`/`error` 之前先把最终 `元数据.json` 写完，所以「看到任务完成」就等于「磁盘已是最终状态」
  （旧实现顺序相反，轮询到 done 时可能刚好读到还在写入中的 `.tmp-` 文件）。

---

## 6. 断点续传语义

1. **已完成的章节**（有 `章节元数据.json` 且至少有 1 张图）→ 直接跳过，连图片列表都不重新下。
2. **不完整的章节** → 取图片列表后逐序号检查，**同时看临时目录和正式目录**，已存在且大小 > 0 的图片直接跳过（只补缺图）。
3. 续传前会把正式目录里已有的图片补进临时目录，全齐后整体原子替换 → 不会丢图。
4. 缺图时把已下好的图片**复制**到正式目录留底（临时目录保留），下次继续只补缺口。
5. 服务重启：`data/download-tasks.json` 里 `running/queued` 的任务统一标记为 `paused`，`error` 提示「服务重启导致中断，可点继续断点续传」，点继续即从缺口补。
6. 取消：停止取新任务 + abort 在途请求 + 清理 `.part` 文件；paused 则等在途请求自然结束。

---

## 7. 前端（public/modules/download.js）

两个页签（`.chip` 切换）：

1. **搜索入库**：搜索框回车即搜（loading 态）、`.grid.grid-cards` 结果卡片（`.comic-card`+`.cover-wrap`/`.cover`），展示封面/标题/作者/标签/章节数，已在库显示 `.badge-ok`『已在库』并提供「打开目录」；点卡片开 `ctx.modal` 详情：章节多选（本地已存在标『已存在』且默认不勾选，另有「只选缺的/全选/全不选」），底部「加入下载队列」。
2. **下载任务**：任务卡片含 `.progress` 进度条、状态 badge、速度、剩余时间、已完成/总章节、暂停/继续/取消/删除/打开目录，空态用 `.empty`；进度由 `ctx.sse('/api/download/events')` 实时推送（只更新对应卡片，不轮询轰炸；SSE 断开时 15 秒兜底轮询）。
3. 顶部：下载根目录 + 「打开根目录」+ token 状态，未配置 token 用 `.alert-warn` 提示去设置页。
4. 页签徽标显示进行中任务数；所有请求失败都有中文 toast。
5. 模块 CSS 由模块自己注入（`<link id="mv-dl-style">`），自定义类全部 `mv-` 前缀，未改 theme.css。

---

## 8. 配置（全部从 ctx.config.picacomic 读，模块内兜底）

```json
{
  "picacomic": {
    "apiBase": "https://picaapi.picacomic.com",
    "token": "",                     // 只读，绝不回传前端
    "proxy": null,                   // 支持 http://127.0.0.1:7897（仅 http 代理）
    "downloadFormat": "Jpeg",
    "dirFmt": "{comic_title}/{order} {chapter_title}",
    "chapterConcurrency": 2, "chapterIntervalMs": 8000,
    "imgConcurrency": 12, "imgIntervalMs": 2500,
    "shouldDownloadCover": true, "retryTimes": 3, "timeoutMs": 30000,
    "maxConcurrentTasks": 2
  }
}
```

---

## 9. 测试（`tests/download.test.mjs`，全离线）

不联网：API 客户端用注入的 `fetchImpl` 替身，下载引擎用内存假客户端，落盘全部在 `os.tmpdir()`；只有隧道客户端跑本地回环 HTTP server。覆盖 **120 条断言**（10 组）：

1. 签名算法（HMAC/SHA256、query 不参与、method 参与、扩展名/补零映射）
2. HTTP 层请求头/路径/图片地址拼接、401/5xx 中文翻译、429 重试、超时 abort
3. chunked 解码 + 内置隧道 HTTP 客户端（本地回环）
4. 目录结构落盘（元数据字段同构、三位补零、封面、无残留临时目录）+ 断点续传不重复下载
5. 单图失败 → 死信 + 任务继续；「只补缺图」只请求缺失序号；临时目录保留
6. 扩展名映射（GIF 永远保留 gif、其余跟随 downloadFormat）、空图片内容判失败
7. 库扫描/已在库识别/大小为 0 的图片不算已下载/swapDir 原子替换/越界判断
8. 限速器间隔、速度计、全局并发任务数 ≤ 2、取消后不再发起请求、暂停/继续/删除
9. 任务持久化与重启恢复（running/queued → paused）
10. 元数据构造纯函数 + 原子写

```
node --check src/modules/download/index.mjs
node --check public/modules/download.js
node tests/run-tests.mjs download        # 120 通过 / 0 失败
```

---

## 10. 已知限制

- **不支持登录/注册/充值**：模块只用 `ctx.config.picacomic.token`，不提供账号密码接口（`signIn` 有封装但未挂路由）。token 过期只能去设置页更新。
- **代理只支持 http 代理**（按 CONNECT 隧道实现，Node 原生 fetch 不支持代理，因此带代理时走模块内置的极简 HTTP/1.1 客户端）；不支持 socks5。
- **不做图片转码**：零依赖，不引入图像库。`downloadFormat` 只决定文件扩展名，字节原样落盘；GIF 永远保留 `.gif`。因此「设为 Png 但上游给 JPEG」时，文件名与字节格式可能不一致——代价是保持零依赖与动图不坏。
- **网络环境**：本机对 `picaapi.picacomic.com` 直连不通（DNS 解析到 CDN IP，TCP 443 超时）；把 `picacomic.proxy` 设为本地代理后请求能真实到达上游（实测返回上游 JSON `{"code":401,"error":"1005","message":"unauthorized"}`）。**当前配置里的 token 已失效**，搜索/详情会返回「哔咔 token 无效或已过期」。签名算法本身经上游真实响应验证（错误签名同样 401，路径/Host/头结构均被上游接受）。
- **章节顺序**按上游 `order` 排序；若上游同一漫画存在重复 order，后写的会覆盖同名目录。
- `open-folder` 依赖 Windows 的 `explorer`，非 Windows 平台会失败并给出中文原因。
