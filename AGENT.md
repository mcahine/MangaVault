# AGENT.md — 漫库 MangaVault 工程入口

> 这份文件是**给人和 AI 协作者的第一入口**。接手本项目前先读它，再读 `docs/`。
> 读者假设：你会写 TypeScript/JavaScript，但完全不了解本项目的来历。

---

## 1. 这是什么

漫库（MangaVault）是一个**本地漫画中枢**：把散落在磁盘上的漫画目录，变成可检索、可阅读、可整理、可下载的私人图书馆。

交付形态是一个 **Windows 桌面应用**：双击 `MangaVault.exe` 启动，窗口由 C# + WebView2 宿主提供，
界面与业务逻辑由内置的纯 Node.js 服务 + 原生前端渲染。**不是网页，不是浏览器标签页。**

核心设计约束（不要破坏）：

1. **零第三方运行时依赖**：业务代码只用 `node:` 内置模块与相对路径导入。没有 npm 依赖树，没有构建步骤。
2. **代码与数据分离**：漫画数据、索引、配置、日志**永远不属于代码仓库**。见第 4 节。
3. **格式即接口**：只要磁盘上的目录符合 `docs/LIBRARY_FORMAT.md` 的约定，系统就必须能识别。
   代码**不得**绑定任何特定漫画来源。
4. **一切可验证**：任何功能都要有可复现的测试或验收脚本，禁止口头声称"已完成"。

---

## 2. 目录结构

```
MangaVault/
├── AGENT.md                    本项目入口（你正在读）
├── README.md                   面向使用者的说明
├── LICENSE                     MIT
├── package.json                只放脚本与元信息，无 dependencies
├── config.example.json         配置模板（提交进仓库）
├── desktop/                    桌面宿主：C# 宿主源码、WebView2 引用库、构建脚本
├── dist/                       【构建产物】MangaVault.exe 绿色包（不进仓库）
├── src/
│   ├── server.mjs              进程入口：配置、HTTP、模块装配、单实例锁
│   ├── core/                   框架层：http / config / store / log / roots / util …
│   └── modules/                业务模块，每个模块一个目录
│       ├── index.mjs           模块注册表（唯一挂载点）
│       ├── library/            漫画库：扫描、索引、封面、筛选
│       ├── reader/             阅读器：图片流、进度、书签
│       ├── vault/              管理台：元数据、重命名、回收站、备份、校验
│       ├── download/           下载中心：登录、搜索、收藏、排行、任务、导出
│       └── dedupe/             查重台：字节查重 + 像素指纹 + 审核删除
├── public/                     前端资源（原生 ESM，无打包器）
│   ├── index.html
│   ├── theme.css               RISOPRINT 视觉系统（唯一真源）
│   ├── app.js                  前端内核：路由、状态、命令面板、启动自检
│   ├── ui.mjs                  DOM 组件层：icon / el / toast / modal / 对话框
│   ├── grid.mjs                虚拟滚动网格（只渲染可视区行）
│   └── modules/                与后端模块一一对应的前端页面（大页面按页签再拆）
├── docs/                       全部文档，见第 7 节
├── scripts/                    开发/运维脚本（tidy、audit、构建、verify-all）
├── tests/                      测试，只有 *.test.mjs
└── data/                       【运行时数据，不进仓库】配置、索引、日志、缓存
```

仓库根目录**不应出现**漫画数据目录。它们通过配置挂载，见第 4 节。

---

## 3. 快速开始

```powershell
cd MangaVault
node src/server.mjs                 # 开发模式，前台跑，Ctrl+C 退出
node tests/run-tests.mjs            # 跑全部测试
node scripts/build-desktop.mjs      # 构建桌面 exe 到 dist/
node scripts/tidy.mjs               # 工程卫生检查
```

启动后控制台会打印实际端口（默认 8775，被占用则 +1 递增）。端口与访问地址也会写入 `data/URL.txt`。

---

## 4. 铁律：代码与数据分离

这是本项目最重要的一条架构约束。**违反它等于重构失败。**

### 4.1 什么属于代码

`src/`、`public/`、`desktop/`、`docs/`、`tests/`、`scripts/`、`package.json`、`config.example.json`、`AGENT.md`、`README.md`、`LICENSE`。

这些文件里**不得**出现任何用户机器上的绝对路径，也不得出现特定漫画目录名。

### 4.2 什么属于数据

全部落在 `data/`（或用户指定的数据目录）与用户自己的漫画目录：

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 运行配置 | `config.json` | 首次启动自动从 `config.example.json` 生成 |
| 库根注册表 | `config.json` 的 `libraryRoots` | 指向用户的漫画目录 |
| 漫画索引 | `library-index.json` | 扫描产物，可随时重建（2.3 MB 量级） |
| 阅读进度 | `library-progress.json` | 阅读位置与已读章节 |
| 标签与书架 | `vault-tags.json` / `vault-shelves.json` | 标签别名、合并、颜色也在其中 |
| 漫画标签映射 | `vault-comic-tags.json` | 每部漫画的手动标签 |
| 下载任务 | `download-tasks.json` | 含断点续传进度 |
| 查重产物 | `dedupe/` | 指纹库与缩略图缓存 |
| 备份 | `backups/` | 管理台产出的元数据备份 |
| 日志 | `mangavault.log` | 8 MB 轮转 |
| 回收站 | `vault-trash/` + `vault-trash.json` | 可还原 |
| 窗口记忆 | `desktop-window.json` | 桌面端尺寸与位置 |
| 运行时坐标 | `URL.txt` / `server.lock.json` | 实际访问地址与单实例锁 |

> 表中路径均相对于**数据目录**。数据目录本身不在代码仓库内，见 4.3。

### 4.3 数据目录如何确定

优先级从高到低（实现见 `src/core/config.mjs` 的 `dataDir()`）：

1. 环境变量 `MV_DATA_DIR`（测试与多实例用）
2. 命令行 `--data-dir=<path>`
3. 环境变量 `MV_PORTABLE=1` → 项目内 `data/`（绿色便携）
4. `%LOCALAPPDATA%\MangaVault\`（安装模式，默认）

> ⚠️ **`MV_DATA_DIR` 与 `--data-dir` 必须每次重新求值，绝不缓存。**
> 同一个进程里多个测试会先后换目录；一旦缓存首次结果，后续测试就读到上一个测试的数据（曾导致 desktop/reader 测试串味）。
> 只允许缓存「默认路径」这一支。

### 4.4 漫画来源如何接入

系统**不认识**"哔咔漫画"或"先期漫画"这种概念，只认识**库根**与**格式**。

```jsonc
// data/config.json
"libraryRoots": [
  { "id": "picacg", "name": "哔咔下载库", "path": "D:/comics/picacg", "enabled": true },
  { "id": "early",  "name": "先期漫画",   "path": "D:/comics/early",  "enabled": true }
]
```

只要某个目录满足 `docs/LIBRARY_FORMAT.md`，加进 `libraryRoots` 就能被扫描、阅读、整理。
**新增一个漫画来源 = 新增一条配置，不改一行代码。**

---

## 5. 库格式契约

完整规范见 **[`docs/LIBRARY_FORMAT.md`](docs/LIBRARY_FORMAT.md)**。要点：

漫画 = 库根下的**一级子目录**。它有两种合法形态：

- **规范形态（L2）**：目录含 `元数据.json` + `cover.jpg`，章节在子目录里。信息最全。
- **裸形态（L0/L1）**：目录里直接是图片（或只有若干子目录图片）。无元数据也能用。

系统必须**宽容对待缺元数据**：能用就扫描，缺什么补什么，绝不因为缺元数据而拒绝识别。
这就是"先期漫画"目录能立刻可用的原因，也是 `scripts/normalize-library.mjs` 的价值所在。

---

## 6. 模块契约

完整规范见 **[`docs/MODULE_CONTRACT.md`](docs/MODULE_CONTRACT.md)**。

后端模块：

```js
export const meta = { id: "example", name: "示例", description: "…", order: 50 };
export async function register(app, ctx) { app.get("/api/example/ping", function (c) { c.json({ ok: true }); }); }
export async function dispose() { /* 可选：清理定时器/子进程 */ }
```

前端模块：

```js
export const meta = { id: "example", name: "示例", order: 50 };
export async function mount(root, ctx) { /* 往 root 里渲染 */ }
```

接口返回约定：成功 `{ ok: true, ... }`，失败 `{ ok: false, error: "中文可读原因" }` 并配 HTTP 状态码。
错误信息面向用户，一律中文，不要抛英文栈。

---

## 7. 文档地图

| 文件 | 内容 | 什么时候读 |
| --- | --- | --- |
| `AGENT.md` | 本项目入口、约定、铁律 | 第一次接手 |
| `docs/INDEX.md` | 按"我想做什么"组织的总导航 | 不知道该看哪份 |
| `README.md` | 面向使用者的功能说明与排错 | 想知道"怎么用" |
| `docs/ARCHITECTURE.md` | 进程模型、请求生命周期、数据流 | 要动框架层 |
| `docs/MODULE_CONTRACT.md` | 模块怎么写、ctx 有什么、测试怎么写 | 要加/改模块 |
| `docs/LIBRARY_FORMAT.md` | 库格式契约（磁盘布局与元数据） | 要接入新漫画来源 |
| `docs/UI_GUIDELINE.md` | RISOPRINT 视觉规范（唯一真源） | 要动界面 |
| `docs/DESKTOP.md` | 桌面宿主、构建、打包、发布 | 要动 exe |
| `docs/DOWNLOAD_SOURCES.md` | 下载器适配器契约（如何接新下载源） | 要加下载源 |
| `docs/modules/*.md` | 每个模块的接口与实现要点 | 要改某个模块 |
| `docs/AUDIT.md` | 最近一次审计结论与已知缺口 | 想知道哪里薄弱 |
| `docs/team/*.md` | 团队任务书与分工记录 | 要接续他人工作 |
| `LICENSE` | MIT 许可证（第三方素材的许可见 README 与 `docs/modules/download.md`） | 想再分发 |

---

## 8. 编码约定

- **ESM only**，`.mjs`（后端）与 `.js`（前端，浏览器原生 ESM）。
- **两空格缩进**，单引号，语句结尾加分号。
- **注释与用户可见文案一律中文**；变量名用英文。
- **不要写模板字符串**。本项目历史上出现过被转义符破坏的提交，统一改用字符串拼接。
- 后端**不要** `import` 任何非 `node:` 前缀的裸模块名。
- 前端**不要**引入 CDN 脚本、字体、图标库；图标走 `public/app.js` 的 `icon()`。
- 破坏性文件操作（删除/移动/覆盖）必须：先 `plan` 预演 → 用户确认 → 执行 → 可回滚。

---

## 9. 测试与验收

```powershell
node tests/run-tests.mjs                     # 全量单元/集成测试
node tests/run-tests.mjs vault                # 只跑某个模块（按子串匹配）
node scripts/dev/vault-acceptance.mjs         # 管理台破坏性操作验收（隔离样本）
```

规则：

1. `tests/` 下只放 `*.test.mjs`，每个文件导出 `export const name` 与 `export async function run(t)`。
2. 测试**绝不触碰用户真实漫画**。统一用 `os.tmpdir()` 造样本；需要隔离数据目录时设置 `MV_DATA_DIR`。
3. 破坏性验收脚本必须在 `finally` 里复原被改动的配置与目录。
4. 交付前必须跑全量测试并贴出真实输出。**测试没过就说没过，不要伪造。**

---

## 10. 团队协作

多人/多智能体并行时：

1. **先分区再动手**：每个任务声明 `write_scopes`（工作区相对路径前缀），重叠即冲突。
2. 共享热点文件（`src/modules/index.mjs`、`data/config.json`、`src/core/config.mjs`）**只由一人改**，其他人通过消息请求。
3. 任务书落盘到 `docs/team/task-<n>-<name>.md`，含：目标、写入范围、接口契约、验收标准、不得触碰的边界。
4. 完成后必须给出**可复现证据**（命令 + 真实输出），而不是"已完成"。
5. 交错失败时优先落盘中间成果，方便交接续跑。

---

## 11. 已知坑（踩过的）

- `saveConfig` 必须**原地更新**配置对象，不能替换引用，否则已注册模块会一直读旧值。
- 索引条目要校验磁盘目录仍存在，否则重命名后会出现"幽灵条目"重复计数。
- 日志写入要防 EPIPE：控制台断开后 `console.log` 会抛异常，处理不当造成死循环刷盘。
- 内联 `<svg>` 只有 `viewBox` 没有宽高会按 300×150 渲染，必须由 CSS 约束尺寸。
- 扫描时不要把 `cover.jpg` 当成正文图，否则整部漫画会塌缩成 1 话。
- 前端请求的 `size` 参数不要超过后端上限（`/api/library/comics` 上限 300）。
- 全屏布局用 grid 时，**必须显式写 `grid-template-rows: minmax(0, 1fr)`**；只写 `1fr` 会被内容撑开，导致子元素 `overflow:auto` 永远没有滚动条。
- 自定义虚拟滚动/懒加载时，**必须把 scroll 监听绑到真实滚动祖先**，不要想当然绑 `window`（容器内 scroll 不冒泡）。
- 这类问题**必须用真浏览器断言**（`clientHeight < scrollHeight`、`scrollTop` 真的变化）才能发现；肉眼看「好像有滚动条」会漏诊。
- **可被外部覆盖的配置读取函数不要做无条件缓存**，要么完全惰性，要么只缓存「无外部覆盖时的默认值」。
- 长任务中断后必须先把中间成果落盘，再接续；上下文过长时应把发现写成文档交给别人，而不是自己硬写到底。
- **带图形的控件不能复用「空间语义」的函数**：阅读器曾把「舞台左/右」的左右反转逻辑（日漫模式点左侧=前进）同时用在有箭头图标的翻页按钮和方向键上，导致默认模式下点「下一页」实际回到上一页。无图形的边缘点击区/滑动可以有方向反转，**有图形的控件一律按字面语义**。
- **`dist/` 只是 `src/` 某一时刻的快照，不会自动同步**：曾出现源码已修好、但 `dist/app/` 落后 6 小时，交付的 exe 里装的是旧逻辑。诊断代码前先确认读的是 `src` 还是构建产物；改完必须重建并核对 sha256。可用 `node scripts/dev/dist-consistency.mjs` 一键比对。
- **「有值时覆盖、缺省时兜底」的取值函数，不能让「本对象上不存在的键」参与判断**：`api.mjs` 的 `pick()` 曾在 config 是普通对象时用 `o[key]`（通常 undefined）覆盖掉从 config 读到的值 —— 表现为「配置里明明有 proxy，请求却直连」，被墙后只报 `fetch failed`，极难定位。判据要用 `hasOwnProperty`，不能用 `!== undefined` 配合 `else`。
- **不要把上游的业务错误码压成一句笼统的话**：哔咔把 `1001`(accept 头非法) / `1003`(签名错) / `1005`(鉴权失败) 都塞在 HTTP 400/401 里；`translateError()` 原先只看 status===401 就一律输出「token 无效或已过期」，导致排查时一路去换 token，而真实原因是别的。翻译错误时必须**优先解析响应体里的业务码**。
- **形参名不能遮蔽模块级同名的访问器函数**：`auth.mjs` 的 `saveAccount` 形参曾叫 `account`，遮蔽了模块级 `account()`，导致函数内 `account().markDirty()` 变成「把对象当函数调用」抛 `TypeError`，登录路由返回 502。前端表现是「登录表单点了没反应、一直转圈」——**登录从 v2 起其实从未成功过**。写形参前先确认模块内没有同名函数。
- **测试文件之间会互相污染全局对象**：`ui-smoke.test.mjs` 会把 `globalThis.fetch` 换成「测试环境禁止联网」的桩（那是它防前端模块偷偷联网的手段），而测试文件按字母序执行、`vault.test.mjs` 排在它之后 —— 后者用 `fetch` 跟自己的子进程通信，就会直接抛错。**单独跑某个文件是绿的，跑全量才炸**。需要跟本地服务通信的测试一律用 `node:http`，不要用会被别人替换掉的全局 `fetch`。
- **`IntersectionObserver` 的 `threshold` 是「目标自身面积占比」，目标比视口大得多时该阈值永远达不到**：条漫当前页跟踪曾用 `threshold:[0.4,0.75]` 观察整页高的占位块（实测块高 1979px、视口 762px，单块最多露出 38.5%）→ 回调一次都不触发 → 页码恒为 1、预加载队列不跟着滚动走 → 用户报「条漫模式加载不出来」。**判定「滚到第几页」应该用滚动位置反推（`getBoundingClientRect` 与视口判定线求交），这跟单个元素多高无关。**
- **懒加载改造会把「以前靠全量 DOM 蒙混过去」的失效暴露成硬故障**：条漫原来一次性把整章 `<img>` 全塞进 DOM，所以「当前页识别不到」只表现为进度/缩略图高亮不准；改成「按需挂载 + 占位块」后，同一个缺陷立刻变成「整章只加载前几页、往下滚全是灰块」。**改渲染策略前，先把依赖「旧策略副作用」的逻辑逐条重验。**
- **滚动驱动的东西必须同时接「滚动事件」和「翻页动作」**：`goto()` 走 `scrollToPage` 不会触发 `scroll` 事件驱动的那条路径（在无头环境滚动是瞬移、事件也可能被 rAF 合并掉），所以 `goto` 里要显式再排一次队列。**只测一条入口会漏掉另一条。**
- **验收夹具的规模必须能触发被测机制**：条漫滚动加载坏了很久却一路全绿，因为夹具只有 6 页而用例把 `preload` 设成了 6 —— **全部页一次进队列，滚动跟踪根本没参与**。凡是「按需/增量/阈值」类机制，夹具规模与参数必须刻意制造出「机制生效与不生效会得到不同结果」的边界。
- **新写的回归断言必须做敏感度验证（证明它真能红）**：加完断言后要临时把实现改回旧逻辑（或像本次那样用 CDP 注入掐掉 `scroll` 监听）跑一遍，确认断言确实失败。**只证明「现在是绿的」等于没证明。**
- **统计型断言必须限定在「当前可见容器」内**：`document.querySelectorAll(".comic-card")` 会把隐藏面板（只加了 `.hidden`、节点仍在 DOM）里的卡片也数进去，于是「排行榜渲染出 24 张卡」实际数的是收藏夹的卡片。这类**假绿比 FAIL 更危险**，因为它让流水线全绿而功能是空的。

---

- **`User-Agent` 是哔咔的风控变量，必须逐字节照抄上游客户端**：本项目曾把 UA 写成 `okhttp/3.12.13`。后果极具误导性——**公开接口**（`comics/leaderboard`）照样 200，**任何带 `authorization` 的接口**一律回 `401 {"error":"1005"}`。实测对照（同一 token、同一签名、同一代理）：`okhttp/3.8.1` → 200 拿到用户资料；`okhttp/3.12.13` → 401/1005。排查时曾被 `1005` 误导到「token 失效」，连着换了好几个 token。结论：改 UA / app-* 系列头之前先读 `_ref_downloader/.../pica_client.rs` 的 `pica_request()`，那里是唯一真源。
- **配置模板里写死的「默认值」会成为污染源**：`config.mjs` 的 `DEFAULTS.picacomic.apiKey` 曾写死一个 **64 位伪造串**（真值是 **29 位**的 `C69BAF41DA5ABD1FFEDC6D2FEA56B`，逐字节照抄 `pica_client.rs:28`）。因为 `loadConfig` 会把 `DEFAULTS` 与用户配置 `deepMerge`，这个假值被当成默认值合并进每个用户的配置，再由 `pick('apiKey')` 优先读取 → 每个请求都带错 key。**凡是「随配置合并的默认值」，都不能写可能与真值冲突的占位串**；敏感常量应留空串、由代码常量兜底，并加自愈（见 `loadConfig` 的 `if (merged.picacomic.apiKey && String(...) !== 'C69BAF41DA5ABD1FFEDC6D2FEA56B') merged.picacomic.apiKey = '';` —— 判据是**与真值直接比较**，不是数长度：真值本身就不是 32 位，用长度判断会误伤）。
- **签名原文里的 path 必须保留 query**：哔咔的签名是 `HMAC-SHA256(DIGEST_KEY, lowercase(path + time + nonce + METHOD + apiKey))`，其中 `path` 是**含 query 的完整请求路径**（参考实现 `pica_client.rs:429` 的 `create_signature` 收到的是 `comics/leaderboard?tt=H24&ct=VC`）。本项目 `api.mjs` 的 `signPath()` 曾把 `?` 之后整段剥掉再签名 —— 后果**极其隐蔽**：所有带 query 的端点（排行榜 / 搜索 / 收藏 / 漫画列表 / 章节列表）签名全错，而上游**不返回任何错误**，只回 `HTTP 200 {"code":200,"message":"success"}`（41 字节，**没有 data**）；不带 query 的端点（`users/profile`、`categories`）完全正常，所以第一反应永远是「排行榜接口的数据结构变了」。实测对照（同一 token、同一代理）：`comics/leaderboard?tt=H24&ct=VC` 剥 query → 41 字节无 data；含 query → 37968 字节真实 data。**判据：任何「200 + 空 success 包」都先怀疑签名原文，再怀疑数据结构。**
- **绝对 URL 不能被 baseUrl 拼接**：`api.mjs` 的 `buildTargetUrl(baseUrl, path)` 曾无条件执行 `new URL(base + '/' + rel)`。图片下载传进来的是**完整 URL**、`baseUrl` 是空串，于是拼成 `/https://...` 并抛 `Invalid URL` —— 表现为「**开了代理的机器上，封面与漫画图片全部下载失败**」，而无代理走的是全局 fetch 分支（不经过这里），所以只在配了代理的环境复现（本机正是）。凡是「可能是相对路径、也可能是绝对 URL」的入参，先判 `/^https?:\/\//` 再决定拼不拼。
- **传输层必须跟随 3xx**：哔咔图片 CDN 对签名路径先回 **301**，真正图片在 Location。不跟随重定向时拿到的是 **194 字节 nginx HTML 错误页**，而 301 < 400 不会被判失败 —— 于是「图片"下载成功"但存进去的是 HTML」。参考实现 `pica_client.rs` 用 reqwest 默认客户端（默认跟随 10 跳）。注意：**注入的自定义 transport 也要套同一层重定向跟随**，否则测试覆盖不到 3xx 分支、生产与测试行为分叉。
- **前端不能用 `url.indexOf('//') > 0` 判断「封面地址可用」**：本站封面代理地址是 `/api/download/cover?path=https%3A%2F%2F...`（内层 URL 被 `encodeURIComponent` 编码成 `%2F%2F`），字面上没有连续的 `//`，于是**所有卡片永远走占位分支**，搜索 / 收藏 / 排行榜三处一律只显示「首字占位块」。判据要认绝对地址与站内绝对路径两种形态。
- **「跨渲染保留的状态集合」与「每次重建的 DOM」混合使用，会把「已处理过」误当成「已渲染」**：阅读器的 `preloadDone` 语义是「这类图请求过了」（跨模式切换保留），而条漫每次切模式 / 切适应方式都会 `stage.textContent=''` 重建占位块。新块建好后 `startLoad(i)` 因 `preloadDone.has(i)` 直接 return，永远等不到 `swapIn` → **切一次模式就白屏，只有整页刷新才恢复**（用户原话：「切换条漫时卡住，非得再刷新一遍才行；切换适应宽度/高度/原始尺寸也一样」）。判据：**只要「请求层状态」与「渲染层 DOM」的生命周期不同，重建 DOM 后必须主动回填已就绪的数据**（`fillLoaded()`），重绑监听也必须配 `if (bound) return;` 守卫。
- **同一份数据有多个入口时，只修被报障的那一个入口等于没修**：条漫加载坏了修好「滚动」这条入口后，用户立刻复报「一进条漫就白屏」—— 因为还有「点按钮切模式」这条入口同样触发重建。**修复一处症状后，必须把所有能到达同一状态的入口列出来逐个验证**（本项目至少四条：滚动、翻页按钮、切模式、切适应方式）。
- **「切换类操作」的验收必须包含「切换后立刻可用」，而不是只验「首次进入可用」**：reader-nav-check 此前 24 条全绿却漏掉整个白屏 bug，因为全部断言都在「一进页面」的状态上做。凡是有模式/视图切换的功能，验收至少要覆盖 **进入 → 切换 N 次 → 每次切换后关键内容仍在** 这条序列。
- **浏览器拿不到后端代理**：哔咔 CDN 直链不能在 `<img src>` 里直接用（被墙 → 裂图）。封面、头像都必须由后端经代理取回再转发（`/api/download/cover` 支持远程 URL + 域名白名单 + 10 分钟内存缓存）。只把封面拼成直链而没做后端转发，就等于「卡片永远裂图」。
- **别把「公开接口能通」当成「鉴权链路没问题」**：签名/代理/时钟任意一项错都会让公开接口先炸，但反过来公开接口全绿并不代表带 token 的接口能通（UA 就是典型反例）。诊断时**必须把「无登录接口」与「带登录接口」各跑一遍**，用同一 token 做对照实验，才能把变量逐一定位。
- **「后端忙」会被误判成「后端死了」**：桌面宿主（`desktop/host/Program.cs` 的 `WatchdogTick`）每 3 秒 `GET /api/ping`，连续 `PING_MAX_FAILS=4` 次拿不到就 `Dump("SERVERDEAD")` 直接收摊 —— 而 Node 后端在查重指纹构建 / 全库重扫里是**单线程忙**（一段长时间不 await 的同步循环把事件循环占满），ping 必然超时。用户看到的就是「**跑查重时桌面窗口自己关掉了**」。修法：长任务开始写 `backend-silence.json`（`src/core/heartbeat.mjs`，绝对时间戳 `until`），宿主 `BackendBusy()` 读到有效窗口即跳过死亡判定，响应结束 `releaseSilence()` 把窗口收窄到 1 秒。**两条铁律**：① 进程真退出（`ServerHasExited()`）必须无条件收摊，不能让静默窗口留下一个没有后端的空白外壳；② 只读接口绝不声明静默，否则会掩盖真死。验收看 `node scripts/dev/host-busy-check.mjs`（13 条）与 `tests/heartbeat.test.mjs`（30 条）。
- **Python 子进程拿不到模块级全局变量，必须把状态随任务参数传进去**：`engine/python/build-fp.py` 的增量跳过判据原来读模块级 `SIGS`。Windows 的 `ProcessPoolExecutor` 用 spawn 起子进程，子进程拿到的是**全新的空模块副本**，`SIGS` 在子进程里永远是空的 —— 于是跳过判据恒不成立，**每次扫描都全量重算 6 万张图**，而表面上一切正常（不报错、结果也对，只是永远不省时间）。修法：当前签名 `sig` 与上次落盘签名 `prev` 两个字段随任务元组一起传参（`dump(job)` 里解包 `kind, k, d, files, out, sig, prev`，见 `build-fp.py:65`），主进程统一算好 `job_sig(d, files)`（`build-fp.py:142`）。**凡是 ProcessPoolExecutor 的 worker，都不许依赖模块级全局状态，一律走参数。**
- **Python 3.11 在 Windows 上设 `max_tasks_per_child` 会让进程池挂死**：`build-fp.py` 曾用 `ProcessPoolExecutor(..., max_tasks_per_child=20)`。全量构建**精确卡在 6 workers × 40 tasks = 241 个文件处**（把值从 20 调到 40 后，卡点随之移动到 6×40=240），16 个 python 进程 CPU 增量全为 0，输出文件最后写入时间凝固 27 分钟以上 —— 属 CPython gh-105829 一类「回收 worker 时死锁」的问题。修法：**直接删掉 `max_tasks_per_child`**，每个批次本来就 `with ProcessPoolExecutor(...)` 重建进程池，worker 生命周期由 `FP_BATCH` 天然限制。诊断教训：判断「卡住」必须看**进程 CPU 增量**，只看输出文件数不再增长会把「慢」和「死锁」混为一谈。
- **测 JPEG 解码耗时必须显式 `im.load()`**：JPEG 是惰性解码，`Image.open(p)` 只读文件头，真正的解码发生在第一次像素访问（`convert()` / `resize()`）。不显式 `load()` 时耗时会被算到后面的步骤上 —— 本项目就曾因此**误判是 `convert('L')` 占了 25ms**，真实归属是 `open` 4.21ms + `load()` 22.81ms + `convert(L)` 0.09ms + resize 极小。给解码性能下结论前，先 `draft()` 再 `im.load()`。
- **承诺提速前先测目标目录里 progressive JPEG 的占比**：`im.draft('L', (n,n))` 只在 **baseline** JPEG 上有 1/2、1/4、1/8 的跳过收益。实测本库 68% 的 JPEG 是 progressive，draft 对 progressive 只有 **2.19x**（load 96.8ms → 44.1ms），对 baseline 才有 **3.72x**（68.8ms → 18.5ms）。按「所有 JPEG 都能靠 draft 大幅加速」外推，会把规划目标定到这台机器根本达不到的数字。
- **worker_threads 共享大只读数组要用 SharedArrayBuffer，但别忽略主线程那一份**：像素比对把库侧指纹（63395 张 ≈ 68MB 的 gray + coarse）放进 `SharedArrayBuffer` 只读共享，避免每个线程各拷一份。**注意主线程与 SAB 会同时占内存**；本机空闲内存仅 1.5GB，加 worker 之前先确认余量。
- **串行与并行两条路径必须复用同一个打分函数**：`engine/pixel-worker.mjs` 不许自己抄一份算法 —— 它把库侧大数组换成 SAB 视图后**直接调用 `match.mjs` 的 `pixelCompareUnit`**（`pixel-worker.mjs:28`），因此并行与单线程结果天然一致。两份实现必然随时间漂移，而「并行结果和单线程不一样」这类 bug 极难发现。
- **「忙」与「死」这两个信号要在看护之前就分开**：长任务（查重全库指纹、vault 全库重扫）必须边走边声明自己在忙，否则看护程序只能看到「ping 不通」这一个布尔量，把任何长任务都判成死亡。做**任何**提速前先确认这条兜底链路是通的，否则任务再快也会被看护程序腰斩。
- **含中文的 .bat 必须存成 GBK/cp936 无 BOM**：cmd.exe 读取批处理**行**时用的是**启动时**的控制台码页（本机 OEM 936）。若文件是 UTF-8，这个「字节→再解码」过程有损，会把一行拆成「前缀 + 后半当成命令」，报出 `'xxx' is not recognized as an internal or external command`，而上一行还会整个消失。实测：UTF-8 + `chcp 65001` ✗｜**UTF-8 带 BOM 更糟**（首行变 `\ufeff@echo off` 直接报错）✗｜`chcp` 挪位置 ✗｜**GBK/cp936 无 BOM ✓**｜UTF-16 ✗。**坑中之坑**：在 pwsh（控制台码页 65001）里跑觉得「没问题」，双击才炸 —— 验证必须在**新建的 cmd 控制台**里做。
- **Pillow 解码会释放 GIL —— 图像批量处理该用线程池，不是进程池**：`build-fp.py` 原本用 `ProcessPoolExecutor`。改用 `ThreadPoolExecutor` 后，库侧（jpg 为主）**2.08x → 3.45x**、查重侧（webp 为主）**2.70x → 3.70x**（交替 A/B 取中位数）。真实全量：库侧 14.14 分钟 → **7.60 分钟**（1.86x），dup 侧 7.41 分钟 → **4.67 分钟**（1.59x），且 1236 个指纹文件**逐字节一致**。原因是 libjpeg-turbo / libwebp 在解码期间释放 GIL，线程真能并行，还省掉了进程池每批建池与 pickle 传参的开销。**结论不能凭直觉：先用小样本把两者 A/B 一次再选并发模型。**
- **改用线程池后，临时文件名只带 pid 会互相覆盖**：`build-fp.py` 原来写 `tmp = out + ".tmp" + str(os.getpid())`，在进程池里安全（一进程一任务），换成线程池后同进程内多个线程共享 pid，会写到同一个临时文件上互相踩。修法：`tmp = out + ".tmp" + str(os.getpid()) + "_" + str(threading.get_ident())`（`build-fp.py:74`）。**任何「pid 唯一」的隐含假设，在从进程换到线程时都会失效。**
- **并发批次的错误恢复不能整批重跑，否则统计虚高**：线程（进程）池抛错时若 `for job in batch` 全部重做，已结算的任务会被重复计数。修法：用 `settled` 记录本批已成功结算数，失败后只补做 `batch[settled:]`（`build-fp.py:167` 起）。
- **「样本外推得出的硬件天花板」必须先验证并发模型**：本项目曾据「单线程 27ms × 6 万张 ÷ 4 物理核 ≈ 7~9.5 分钟」断言「≤6 分钟在 4 物理核上不可达」，并写进了报告。该推算隐含「只能靠多进程并行」这一错误前提 —— 换成线程池后库侧直接到 **7.60 分钟**。**下「不可达」这类结论前，先把并发模型的选项都试一遍。**
- **外推必须用交替 A/B + 中位数**：首次测速时我把基准与其它作业并发跑，得到「6 进程 4.5s、8 进程 6.0s」这类互相矛盾的数；改成「同一样本、两种方案轮流跑 5 轮取中位数」后才稳定（线程池 5.01s vs 进程池 7.34s）。**抽样外推的方差常常大于方案之间的真实差异。**
- **指纹的增量跳过判据只认「mtime + 总字节 + 张数」，所以「只为候选章节建指纹」必须 `force: true`**：v7 快速查重会把**同一个 key**（`keyOf(章节绝对路径)`）的 `.bin` 从「整章 300 张」重写成「候选章节的若干张」，三要素全变、签名也就变了 —— 但只要有**任何**路径没走 force，就会读到上一次整章留下的旧指纹，`chapter.start/count` 与实际缓冲对不上，逐张比对**静默错位**（不抛错、结果全错）。`buildFingerprints(..., { force: true, only: '' })` 不是优化项，是正确性前提。
- **「过滤集合为空」必须显式 return，否则 `if (set.size && !set.has(x)) continue` 会退化成全量**：`pipeline.mjs` 的 `loadCandidateFingerprints` 原先写 `if (wanted.size && !wanted.has(...)) continue`，本意是「没点名就不过滤」；但空候选列表意味着「这次一个候选都没有」，代码却因此把**整库 1236 个指纹全读进来**（约 19 分钟的重税）—— 恰好是快速查重要消灭的东西，而且因为它「跑得通」所以极难发现。修法：`if (!wanted.size) return null;` 放在读 index 之后、循环之前。**凡是「空集合 = 不过滤」的写法，都要问一句「空集合的真语义是不是应该提前返回」。**
- **手搓的「同形对象」必须与真实工厂逐字段对齐**：快速查重的测试里自造了一份库指纹视图（chapters/names/gray），跑起来 `TypeError: Cannot read properties of undefined (reading '0')` —— 因为 `zMadOf` 还会读 `lib.linv[i]` / `lib.lnrm[i]`（平坦页判据），而手搓对象没这两个数组。**测试替身越「像」，越要直接复用真实构造函数或真实装载路径**（本项目后来的做法：用合成 `.bin` + 真实 `loadCandidateFingerprints` 装载，只把磁盘 I/O 换成临时目录）。
- **验收断言不能把「用户已确认删除的项」算失败**：v7 e2e 里 5 组已知重复有 2 组的单元目录早被用户删除并移出磁盘，它们**永远不可能**再出现在候选里。按「5 组都必须命中」写死会把绿测成红。正确写法是先探测目录是否还在磁盘（`dirExistsIn(scanRoot, id)`），不在就打印「[跳过] 该单元目录已从磁盘删除」，并另外断言「仍在磁盘上的已知重复组 >= N」。**验收脚本要能区分「功能没做到」与「前提已不存在」。**
- **拼项目根路径必须用 `fileURLToPath(import.meta.url)`，不能用 `new URL(...).pathname`**：本项目仓库在中文目录（`黄漫`）下，`.pathname` 会把中文百分号编码成 `%E9%BB%84%E6%BC%AB`，算出一个**不存在**的 projectRoot。它作为子进程 cwd 传下去后，Python 报 `spawn python ENOENT`，快速查重**静默降级**成「只给元数据候选」——功能看起来「跑了」，实际有 2/5 的已知重复消失。**中文路径 + 子进程 cwd 是这类 bug 的高发组合。**
- **指纹缓存目录必须按用途隔离，构建脚本是「无条件写」的**：`build-fp.py:278` 每次运行都会把本次任务的 `index` 写进 `<libFp>/index.json`，而完整扫描判断「要不要重建」只有一个条件 —— `existsSync(fpLib/index.json)`（`pipeline.mjs:162`）。所以任何「只为一部分章节建指纹」的新流程（如 v7 快速查重），只要复用了真实 `paths.fpLib`，就会把 1236 条的索引覆盖成十几条；**下一次完整扫描会以为指纹齐全而跳过重建，静默退化成只比那十几章** —— 不报错、不降级、结果错。修法：另起 `dedupe/tmp/fp-fast-lib` / `fp-fast-dup`，真实目录只读。**凡是「缓存目录 + 无条件覆盖」的组合，都要先问「谁还会读这个目录、凭什么判断它有效」。**
- **库根字段要按真实数据取，别照着「看起来更合理」的字段名写**：`library-index.json` 里每部漫画存的是 `root`（根 id 字符串，如 `picacg`），**不是** `rootId`；`rootId` 这个更符合直觉的名字存在但从来是空。据此写 `rootById.get(comic.rootId)` 会让**非首个库根的作品全部定位失败**，而且是静默失败（图片零命中、判定「未找到」）。修法：`rootById.get(comic.rootId || comic.root || '')`。**用字段前先对真实数据点数一遍，别信字段名的语义。**

- **同一个功能拆成两份产物文件时，写入方必须成对回写，否则会出现「删了还在」**：v7 快速查重把结果写 `scan-fast.json`（不与完整扫描的 `scan-latest.json` 互相覆盖，这是刻意设计），但删除只回写 `scan-latest.json` → 用户在候选页点「确认重复并删除」后，那张卡片**原样留着**、还能再点一次。修法：`applyDeleteToScan` 里两份文件都按 id 摘除（`src/modules/dedupe/index.mjs`）。**两个文件各有各的读者时，「只更新我这一份」是最容易漏的一致性洞。**
- **「候选来自哪份结果」要按功能面合并，不要按实现面选一份**：候选页原本只读 `scan-fast.json`，于是**先跑过完整扫描（13 分钟）**的用户打开候选页是空的 —— 命中就在 `scan-latest.json` 里。改法：候选 = 快速结果 ∪ 完整扫描里 judge !== '未找到' 的单元（按 id 去重，快速优先，因为它带 matches）。**用户不会按你的实现顺序操作。**
- **「只认一份结果」的校验会把另一条链路整条堵死**：`POST /api/dedupe/decision` 原来只认 `findUnit(scan-latest, id)`，快速模式的候选不在里面 → 三选一律 400；`POST /api/dedupe/delete` 原来 `if (!scan) 400` → 从没跑过完整扫描的用户点删除直接失败。**新增一条结果链路时，要把所有「读结果」的接口都点一遍，看它们认不认新来源。**
- **删除目标路径必须现拼，不能沿用结果文件里存的旧路径**：快速项若直接沿用 `scan-fast.json` 里的 `dupDir`，在用户换过 `scanRoot` 之后会报 `路径越界，已拒绝: C:\Users\D-001\Desktop\发布\哔咔\…`（那份文件是别的根下生成的）。修法：一律 `path.join(paths.scanRoot, id)` 现拼。**结果文件是快照，不是可信来源。**

- **「待删除」这类聚合视图要从所有产生决策的入口收敛，不能只认一条链路**：查重页有两套数据 —— 完整扫描列表（`scan-latest.json`）与候选复核（`scan-fast.json`）。「执行删除…」原来只从主列表 `st.data.units` 里挑 `decision === 'delete'`，于是**只跑过快速查重的用户**（十几秒那条路径）在候选页确认重复后打开删除弹窗，看到的是「当前页没有标记为待删除的单元」且按钮禁用 —— 整条链路走不到删除。修法：按 id 合并两处来源（候选侧只需 `{id, name, dupBytes}`）。**多入口产生同一语义时，读取方必须全部枚举一遍，否则必然有一条入口是死的。**
- **静态断言 + 接口断言都不等于「用户点得动」**：这个断链在接口级 e2e（15 条断言）与全量单测（1250 条）里全绿，因为后端两处都能改；只有真浏览器脚本 `scripts/dev/dedupe-cand-ui-check.mjs` 按用户路径点「候选复核 → 确认重复（可删）→ 执行删除…」才把它顶出来。**任何带多步 UI 的新链路，都要补一条真点击验收，放行按钮是否 `disabled` 是必查项。**
- **最小化窗口会上报坐标 -32000，把它记进「窗口位置记忆」就等于下次把窗口开在屏幕外**：`desktop/shell/shim.js` 的 `report()` 每 20 秒上报一次 `{x:screenX, y:screenY}`，Windows 上最小化窗口的 `screenX/screenY` 正是 **-32000**；`desktop/lib.mjs` 的 `sanitizeWindow` 原来**只校验宽高**（<=16000），x/y 直接 `toInt` 原样通过，于是 `-32000,-32000` 被当成合法位置写进 `desktop-window.json`，下次启动原样拼成 `--window-position=-32000,-32000`。**用户看到的是「双击后一闪就没了 / 启动不了」**，而窗口其实存在、可见、只是完全在屏幕外（实测 pid 2400 title 漫库 rect(-32000,-32000) 1920x1027 IsIconic=False）。修法三层：① `lib.mjs` 新增 `POS_LIMIT = 20000` 与 `posInRange(v)`，`sanitizeWindow` 越界一律丢成 null（交给自动居中），`buildAppArgs` 不满足范围就不拼 `--window-position`；② `shim.js` 最小化时不带 x/y 上报（`body.minimized = min`）；③ `src/modules/desktop/index.mjs` 的 `mergeWindowReport` 回落旧值时同样用 `posInRange` 过滤。**凡是「从浏览器读回来再落盘再回放」的几何量，都必须做范围校验**，否则一次异常读数会被永久固化。
- **探测「窗口是否已关闭」的循环必须有失败上限，while(true) 会把启动器永久挂住**：`desktop/sysinfo.mjs` 的 `waitWindowClosed` 与 `waitForCdpClosed` 第二段原来都是 `while (true) { ... if (!probe.ok) continue; ... }`。只要 PowerShell/CIM 持续超时（CPU 打满时必然如此）或调试端口消失后探测永远失败，函数**永不返回** —— 用户原话「那个桌面窗口怎么没清除掉」正是这个。实测第三个启动器 pid 11532 在窗口早已关闭的情况下永久挂住不退。修法：两处都加 `failLimit`（`waitWindowClosed` 默认 8、`waitForCdpClosed` 默认 6），连续失败达上限即返回 false / unsupported。**任何「等某个外部状态消失」的循环都要有失败上限与明确的失败返回值。**
- **「探测失败」不等于「目标已消失」**：`desktop/sysinfo.mjs` 的 `waitForCdpClosed` / `listAppWindowProcesses` 曾把命令超时、输出为空一律当成「窗口已关闭」，于是关窗判定提前成立、内核被收掉，用户看到「刚开就崩」。修法：`cdpProbe()` / `appWindowProbe()` 返回 `{ok, list}`，`ok=false` 表示**探测本身失败**（命令超时、坏 JSON、空输出都算失败），只有「探测成功且目标确实不在」且连续 `requiredMisses`（默认 2）次才算 closed；`probeMs` 放宽到 6000。**三态（成功 / 失败 / 空）必须分清，二值判断必然误判。**
- **启动器崩溃必须留痕，否则用户只能看到「一闪」**：`desktop/app.mjs` 原来在任何失败路径上都不写退出码（`process.exit(code)` 直接走人），而 `启动漫库.vbs` 只看退出码 66。修法：新增 `recordExit(code, extra)` 把 `{code, at, pid, argv, result}` 写进 `data/desktop-exit.json`，`mainWithRestarts` 的成功 / 请求重启 / 放弃重试三条路径都落痕，并 `log.info` 打出退出码。**「没有日志」和「没有崩溃」在用户眼里是同一件事**，所以每条退出路径都要有可读凭据。
- **双击 .bat 会开出两套启动器，必须加单实例守卫**：用户在 22:47:59 与 22:48:01 双击两次（间隔 2 秒）→ 2 个 wscript + **2 个并发 desktop/app.mjs**，两个都发现内核已在跑、都开了一个窗口，然后都卡在等窗口关闭上。修法：`desktop/app.mjs` 新增 `acquireLaunchGuard(dataDir/desktop-launcher.lock)` —— 用 `fsp.open(file, wx)` 独占创建，EEXIST 时读 `{pid}` 并用 `processAlive` 判活：活着就退出（日志「已有一个漫库启动器在运行」），已死则删掉陈旧锁重试；非 EEXIST 错误（磁盘只读等）降级放行。**只在需要开窗时启用**（--no-window 与冒烟自检允许多实例）。**「用户不会等前一次启动结束再点第二次」是默认前提。**
- **桌面日志必须用本地时间，否则跨日志对不上事故时刻**：`desktop/log.mjs` 原用 `new Date().toISOString().slice(11,23)`（UTC），而 mangavault.log 用本地时间 —— 同一次事故在 desktop.log 里写成 14:48、在别处是 22:48，导致我把尾部那些 --window-only 报错误判成本次崩溃的痕迹（实际是更早的尝试）。修法：改成 getHours()/getMinutes()/getSeconds()/getMilliseconds() 本地拼接。**同一台机器上的多份日志必须共用同一时间锚。**
- **自检 / 冒烟路径必须 try/finally 收内核**：`desktop/app.mjs` 的 `if (opts.smoke > 0)` 段原来直接 await shutdownServer(...) 然后在异常时跳过。结果是自检一抛错就留下一个 detached 内核占着端口，反复跑自动化验收会堆出一串孤儿内核（实测泄漏 pid 13820 听 8776、36528 听 8777、19932 听 8778，均已按 PID 终止）。修法：整段包 try/finally，finally 里 if (owned) 再收。**任何「自己点火」的验收脚本都要保证异常路径也灭火，且验收脚本跑完必须回查一遍端口与进程。**
- **`taskkill` 不带 `/F` 杀不掉 detached 的无窗口 node 内核，`shutdownServer` 因此从来没成功过**：`desktop/app.mjs:255` 的 `shutdownServer()` 原来执行 `taskkill /PID <pid> /T`。实测回 **255**：`ERROR: The process with PID <pid> (child process of PID <ppid>) could not be terminated. Reason: This process can only be terminated forcefully (with /F option).`，进程照旧存活；而回调函数**忽略退出码**，日志照样打「正在停止内核…」并 `resolve(true)` —— 于是**没有任何信号表明失败**。用户能看到的现象是「窗口关了、程序还在跑，端口一直被占」：后端是 `detached: true` 的独立进程（当初就是为了让内核不随启动器一起死），下次双击只会 `probeInstance()` 复用旧内核（换了代码/改了配置全都不生效），反复跑自动化验收还会堆出一串孤儿内核（实测泄漏 8776 / 8777 / 8778 / 8779 各一个）。修法：`execFile('taskkill', ['/PID', String(lock.pid), '/T', '/F'], ...)`。**凡是「杀进程」的调用都必须核对退出码，并把「进程真的没了」写成断言**（`scripts/dev/desktop-launch-check.mjs` 现在会读内核锁并 `processAlive(lock.pid)` 断言其为非存活）。
- **「点完固定等 N 秒再快照」是假红制造机，UI 断言必须轮询到条件成立**：`scripts/dev/dedupe-cand-ui-check.mjs` 原来一连串 `await sleep(2600)` / `sleep(900)` / `sleep(4000)`，然后一次性取快照断言。实测出现过两种假红：①`yes:0`（面板还没渲染完）；②`before=2 after=2`（删除还没落盘）—— 而同一脚本里**更晚**的「隔离目录里那个单元目录真的没了」却通过了，两条断言自相矛盾即证明是时序问题而非功能回归。改成 `waitSnap(pred, timeoutMs, label)`（每 400ms 重新取快照、超时打印最后快照）后稳定。配套两条：①**渲染没出来要直接 throw**，别让它污染后续断言（`yes:0` 会连锁产生 5 条假红）；②**目标要从事发元素现场取**（`button.closest('.mv-card').querySelector('.mv-card-title')`），不能假定它是 `titles[0]` —— 候选顺序会变。**UI 断言测的是「最终会变成什么」，不是「N 秒后是什么」。**
- **CDP 验收脚本的调试端口必须让浏览器自己挑，不许 `93xx + random(200)` 猜**：`scripts/dev/ui-scroll-check.mjs`（原 `9333 + random(200)`）、`reader-nav-check.mjs`（同）、`dedupe-cand-ui-check.mjs`（原 `9433 + random(200)`）各自猜端口，范围还互相重叠；机器上有残留无头浏览器时会撞上已占用的端口，表现为**偶发的**「浏览器调试端口未就绪」——实测 verify-all 第 3 步出现过一次 25.4s 的假失败，单独重跑又是 13/13。正确做法（`download-tabs-check.mjs` 早就这么做了）：`--remote-debugging-port=0` 让浏览器自己选，再从 `<user-data-dir>/DevToolsActivePort` 首行读实际端口。`tests/desktop.test.mjs` 已加契约断言：四个脚本都必须含 `--remote-debugging-port=0` 与 `DevToolsActivePort`，且不得出现 `remote-debugging-port=' +` 这种拼接。

- **单元 id 的口径必须对「嵌套形态」保持唯一，否则会静默互相覆盖**：库格式正规化（`scripts/normalize-library.mjs`）把查重目录从 L0 裸形态（图片直接躺在漫画目录下）变成 L2 嵌套形态（`<漫画>/<序> 第1話/图片`）。此时若 id 仍只取目录名，**同一部漫画的每一章都叫「1 第1話」**，95 个单元互相覆盖，指纹文件、人工决策、删除目标全部串台（实测 id 唯一性 = false）。修法：`discoverUnits`（`scan.mjs:379`）用相对路径做 id —— **有斜杠就整串用，没有才退回目录名**。副作用是列表里显示的是相对路径而不是漂亮名字，但那正是不串台的原因。
- **遇到「看起来更聪明的判据」先用真实数据探针验证它会命中哪些分支**：上一条我一开始改成了「这一层是否位于某个带 元数据.json 的漫画目录之下」（想在「分类/<标题>/<章节>/」这种裸布局里保持目录名口径）。实测直接**反了**：95 个正规化单元全部退回目录名口径、id 唯一性仍然是 false —— 因为「直接含图的目录」判断在最深层就 `return` 了，`hasComicMeta` 那一步根本走不到。同时它还把既有测试（`tests/dedupe.test.mjs:54` 期望 `分类A/完全重复` 这种带分类前缀的 id）打红。**判据越绕越要先跑真实样本，别在脑子里推演。**
- **标题相似度不能拿整条单元 id 去算**：`engine/prefilter.mjs:155` 的 `prefilterUnits` 用 `normTitle(comicTitleOfUnit(u.id))` 取 id 第一段。若直接对整条 id 算 Dice，「/1 第1話」这段公共后缀会把分数严重稀释 —— 实测 95 个正规化单元**全部 0 候选**（把 `ごちそうさま/1 第1話` 与库侧 `ごちそうさま 謝謝招待 無修正` 的 Dice 从 0.588 压到阈值 0.35 以下）。**凡是参与相似度计算的字符串，先确认它只含被比较的语义，不含路径/编号等公共噪声。**
- **指纹缓存的 key 要按目录定位，不能按会变的 id**：`build-fp.mjs` 的 `collectDupJobs` 改用 `keyOf(u.dir || u.id)`，读取侧（`match.mjs` 串行分支、`pixel-worker.mjs`、`pipeline.mjs` 快速模式）三处同步改。理由：指纹描述的是「这个目录下这几张图」，而 `build-fp.py` 的增量签名只认 mtime + 总字节 + 张数 —— **id 一变（正规化改名）整批缓存就会被判「必须重建」**，12 万张图白跑约 5 分钟。绝对路径不随「从哪个根看」而变，相对路径会。
- **合法 id 从「纯文件名」放宽成「安全相对路径」时，所有校验点都要一起放宽**：正规化后 `POST /api/dedupe/delete` 原来 `if (id.indexOf('/') >= 0) continue` 会**把快速查重查出来的重复一个都删不掉**（id 形如 `<漫画>/1 第1話`）；`GET /api/dedupe/thumb` 的 dup 侧原来用 `isPlainFileName(name)` 会**让所有嵌套单元的左半边图 404**（换成 `isSafeRelPath`，越界仍由 `safeJoin` 兜底）。**一次口径放宽要 grep 出全部同类校验点，改完整条链路。**
- **单元 id 变成相对路径后，界面必须另算「显示名」**：id 升成 `<漫画>/1 第1話` 解决了串台，但 `name` 仍是章节目录名（「1 第1話」），列表 / 候选卡片 / 删除确认弹窗里会同时出现一屏「1 第1話」，用户根本认不出删的是哪一部。修法：前端加 `unitLabel(u)`（`public/modules/dedupe.js:55`）—— id 有斜杠时显示「作品名 · 章节名」，否则退回 name。**id 是机器用的稳定标识，展示层要单独算，别直接把它当名字用。**
- **验收断言不许钉死真实数据的条数**：`scripts/dev/dedupe-fast-e2e.mjs` 原来写「仍在磁盘上的已知重复组 >= 3」、`dedupe-cand-ui-check.mjs` 原来写「候选取前 2 个，不足就抛错」。用户会陆续把确认过的重复删掉，**这些断言会随着功能的正常使用而变红**（实测 5 组全被删完后整条验收报错，而它反映的恰恰是删干净了）。修法：有几组验几组、0 组时改写断言为「已删除的组不得再出现在候选里」；候选不足时在 **隔离目录**里克隆一份副本凑数，真数据一个字节不动。**断言要测行为，不要测样本存量。**

- **共享缓存「先推进检查时间再 await」会漏出过期快照，且只在并发时暴露**：`src/core/library-index.mjs` 的 `readLibraryIndex` 原在 `await fsp.stat()` **之前**写 `cache.checkedAt = now`。于是「第一个请求正在读盘、第二个请求进来」时会走 800ms 短路，直接拿到上一次的快照 —— 索引刚建好时那次就是**空快照**。阅读器同时请求 `/api/reader/chapter` 与 `/api/reader/sizes`，正好撞上：偶发「漫画不存在：xxx」，重试一次又好了。修法：`let inFlight = null` 让并发请求**共享同一次读取**（`if (inFlight) return inFlight;`，`finally` 里清空）。**带 TTL/节流的共享缓存，时间戳必须在真正取到数据之后推进；并发去重与「先标记后取数」是互斥的两种写法。**
- **同一份数据被两个并发请求读取时，新增的第二个请求会替你把潜伏竞态踩出来**：这个 bug 在阅读器只发一个章节请求时几年都没暴露，我加的尺寸请求一上线就必现。**给老链路加并行请求前，先确认被并行访问的缓存/单例是否可重入。**
- **异步补数据的响应必须带「发起时的章节令牌」**：`public/modules/reader.js` 里尺寸请求与章节请求并行发出，尺寸可能**后到**。快速切章时旧章的尺寸会覆盖新章的，占位高度整片错。修法：`let chapterSeq = 0`，请求前 `const seq = ++chapterSeq`，回来时 `if (seq !== chapterSeq) return`。**任何「请求 A 的数据用来补请求 B 的界面」的地方，都要有这个令牌。**
- **按页码索引的预加载状态在换章后必须整体作废**：`preloadDone` / `preloadBusy` 是按页码 `i` 存的，而换章后页码从 0 重来。旧章还在飞的图片回来后会把新章同页码标成「已加载」，甚至把旧章的图插进新章的占位块（表现为「换章后有几页空白或串页」）。修法：`let preloadGen = 0`，`startLoad` 记下发起时的 `gen`，回调里 `if (gen !== preloadGen) return`；换章时 `preloadGen++` 并 `clear()` 两个集合。**按「位置」索引的缓存，在位置空间被复用（换页/换章/换列表）时必须绑定一个代次。**
- **「自己挑端口的老代码」是偶发假红之源，凡验收脚本一律交给系统**：本仓库四个 CDP 脚本曾各自 `93xx + random(200)` 猜调试端口、范围还重叠，机器上有残留无头浏览器就撞车，表现为**偶发**的「调试端口未就绪」。统一改为 `--remote-debugging-port=0` + 读 `<user-data-dir>/DevToolsActivePort` 首行（`download-tabs-check.mjs` 早已这么做），并在 `tests/desktop.test.mjs` 加契约断言守住。**同一类「取随机资源」的写法一旦在多处复制，就要用一条契约测试把它们钉在同一标准上。**
- **验收脚本不许复用用户正在运行的实例**：`scripts/dev/ui-scroll-check.mjs` 原来默认 `--port=8775`、verify-all 也显式传 `--port=8775`。而 8775 上常年跑着**用户自己启动的旧版服务** —— 那边加载的是旧前端，于是「页面实际字节 vs 后端报的前端指纹」这条断言必然红（实测 `want=23be09c4 got=5aafa00c`），看起来像功能回归，实际只是**服务器版本旧**；verify-all 因此整轮 13/1 假失败。修法：脚本自己 `freePort()` + 隔离 `MV_DATA_DIR`（配置与库索引从真实目录拷一份只读副本，绝不写用户数据），并在源码里显式拒绝 8775；`tests/desktop.test.mjs` 加契约断言守住。**「服务版本」和「代码版本」是两个变量，验收必须把它们钉死在同一个进程里。**
- **验收断言不要依赖「某条别的分支没被走到」这种偶然事实**：`scripts/dev/desktop-launch-check.mjs` 原来断言日志里必须有 `窗口参数：...--window-size=1280,800`。它在单跑时必绿，在 `verify-all` 里偶发红 —— 真因是启动器发现「同数据目录已经有 App 窗口」（`sameTarget` 分支）时**根本不会开窗**，也就不打那一行。断言测的是「这次有没有走开窗分支」，不是「尺寸有没有被保住」。改成两条稳定的：①窗口记忆写回时 `width/height` 仍是 1280x800（尺寸被保住的**直接**证据）；②**若**本次确实开窗，则参数行必须带该尺寸。**断言要盯着被测属性本身，别用「日志里出现了 X」代理它 —— 日志会随无关分支的有无而变。**
- **验收脚本写 `process.cwd()` 就是在仓库里凭空造 `data/`**：`scripts/dev/verify-all.mjs` 的 `spawnPiped` / `spawnFileRedirect` / `spawn(...,{cwd:ROOT})` 一律以**仓库根**为 cwd 拉起子脚本，而 `scripts/dev/vault-acceptance.mjs` 结尾原来写 `fsp.writeFile(path.join(process.cwd(), 'data', 'vault-acceptance.log'), ...)` —— 每跑一次总验收就往仓库里造一个 `data/`，日积月累攒到 **81.74MB / 573 文件**（其中 data/desktop-profile 的 Edge 缓存 78.13MB）。这是**违反「代码与数据分离」铁律**的活污染源，不只是历史垃圾。修法：改成 `const { dataPath } = await import('../../src/core/config.mjs'); const logFile = dataPath('vault-acceptance.log');`，交给唯一权威来源解析。**清理存量只能治标，必须同时堵住产生存量的那条写路径。**（实测：清理后重跑 `node scripts/dev/vault-acceptance.mjs`，仓库 data/ 只剩 .gitkeep，日志落到 %LOCALAPPDATA%/MangaVault/vault-acceptance.log。）
- **扫描器逐行调用「整文件级」的状态机函数，会把注释里的内容当成代码**：`scripts/tidy.mjs` 的 `stripComments(text)`(:109) 靠 `let inBlock = false` 跨行跟踪块注释状态，而调用处写成 `stripQuoted(stripComments(line))` —— **逐行**调用让每行的 `inBlock` 都从 false 重新开始，于是多行块注释内部的字符被当作真代码。这正是 `src/modules/download/api.mjs:69` 那条「模板字符串」误报的成因（那行在 60-75 行的块注释里，内容是「HTTP 200 + 反引号包裹的 JSON」加「（41 字节，没有 data）」）。修法：先取整文件剥离后的行数组，再逐行 `stripQuoted`。**任何带跨行状态的解析函数，调用点必须与它的状态粒度一致**；否则「扫描器报的问题」会变成伪造的待办。
- **`path.join(process.env.X, 名字)` 在环境变量为空时会拼出相对路径，落进当前工作目录**：实测 `path.join(undefined, 'MangaVault')` 得到的就是相对路径字符串 `MangaVault`（不是绝对路径、也不报错），随后任何 `mkdir`/`rm` 都会作用到 cwd 下的同名目录。本仓库的 cwd 就是仓库根，所以这类写法是**潜在的仓库内写入**。已修三处：`scripts/dev/dedupe-cand-delete-e2e.mjs:12`（改成 `const LOCAL = process.env.LOCALAPPDATA || os.homedir();`）、`tests/vault.test.mjs` 与 `scripts/dev/vault-orphan-race-check.mjs` 的 `CHILD_SRC` 子进程脚本（改成 `const dataDirEnv = process.env.MV_DATA_DIR || os.tmpdir();`）。**凡是把环境变量直接喂给 `path.join` 的地方，都要给一个绝对路径兜底。**
- **「扫描器的窗口宽度」不等于「代码没有守卫」，改代码去迎合扫描器只会增加伪守卫**：tidy 的路径安全规则是「删除类 API 的目标是非字面量变量，且**前 5 行**窗口内出现 `isAbsolute|safeJoin|insideRoot|startsWith|ownerRootOf` 才算有守卫」。实测剩下 12 条 low **全部已有真实守卫，只是守卫在 5 行窗口之外**（如 `src/modules/vault/ops/undo.mjs:25` 的 `fsp.rm(fromAbs)`，其守卫 `const abs = safeJoin(root.path, it.dir)`(:150) 与 `if (!(await exists(abs)))`(:151) 在调用点上方更远处；`src/modules/download/ledger.mjs:343` 的 `ledgerPath(taskId)`(:84) 走 `sanitizeName` 已杜绝穿越）。**判定为「不修」，并把这个结论写进文档**，避免下一轮又把这些翻出来重审一遍。
- **拆分大文件时，「函数体逐字节不变 + 顶部解构共享上下文」是最安全的做法，但它有唯一一个硬风险：漏 import**：把一个巨型闭包拆成 `routes-*.mjs` / `*-parts.mjs` 时，最省事的做法是让新文件顶部 `const { a, b, c } = s;` 解构共享绑定，函数体一个字都不改（连缩进都不动，原 mount 内就是 2 空格基准）。这样逻辑零风险，**全部风险集中在「我解构的名单是否完整」**。实测踩过两次：`engine.mjs` 拆出后漏掉 `extOfFormat`（4 条下载断言立刻红，`任务下载完成 | 实际="error"`），`vault-parts` 拆出后 TDZ 顺序错（`Cannot access 'refresh' before initialization`）。**这里绝不能靠肉眼核名单 —— 用脚本对新文件里出现的每个裸标识符去原文件比对，或用 `node --check` + 真实跑测试来兜底；`node --check` 只查语法，查不出漏解构（那是运行期 ReferenceError）。**
- **切片前必须从 git 基线重新取原文，并且逐行 dump 边界行核对**：拆分时我两次把切片索引算错——`dedupe/index.mjs` 整体偏 7 行切出重复片段、`routes-files.mjs` 多切了 register 的收尾 `}` 导致 `SyntaxError: Unexpected token '}'`。根因是「读到的文件已经被上一次失败的重写污染过」，而我用的是**累计偏移量**。可靠流程：`git show <基线commit>:<path> > __base.mjs`，再 `console.log(n + '|' + lines[n-1])` 逐条打印候选边界（起始行、结束行、上一行的结尾、下一行的开头），确认四件事都对上才切。**永远不要用「上次切到第 N 行，这次大概在第 N±k 行」这种推算。**
- **`run_code` 里写长文档/长脚本，引号嵌套是最常见的翻车点**：用单引号字符串写含 `'` 的中文 markdown 会触发 `Expected ',', got 'string literal'`；用反引号写含 `${}` 的内容会被当成插值；PowerShell 内联命令里的嵌套引号几乎必坏。可靠做法：①长文档用**双引号字符串数组 + `.join(NL)`**（`const NL = String.fromCharCode(10)`），需要单引号时用 `String.fromCharCode(39)` 拼接；②PowerShell 诊断脚本写成 `.ps1` 文件再执行，不要内联；③`.concat([...])` 链式里任一参数为 `undefined` 会报 `Cannot read properties of undefined (reading 'concat')`，宁可写成多个 `.push()`。
- **解构共享上下文时，最容易漏的是「只在次要分支里才用到的绑定」，因为主流程全绿**：`routes-account.mjs` / `routes-files.mjs` / `routes-status.mjs` 三个文件都漏解构 `ctx`，而它们用 `ctx.saveConfig()` 的地方全是**失败/清理分支**（退出登录、清 token、保存代理）—— 登录、搜索、排行榜、下载这些主路径一条都不碰它，所以单元测试 1428 条全绿、真浏览器下载页签 **37/38**（只红最后那条「整个流程没有 JS 报错」）。同类还有 `download-panel-tasks.mjs` 的 `taskChip`（只在 `updateTabBadge()` 里用，而它只由 SSE `state` 事件触发）。**判据：拆分后必须对每个新文件里出现的裸标识符做一次静态比对（见上一条），不能靠测试兜底 —— 测试只覆盖它跑过的分支。**
- **「整个流程没有 JS 报错」这类汇总断言必须把异常的真实描述打出来，否则它只是红灯不给坐标**：`download-tabs-check.mjs` 原来写 `jsErrors.push('未捕获异常: ' + (d.text || ...))`，而 `Runtime.exceptionThrown` 的 `params.exceptionDetails.text` 内容就是一句 `Uncaught`，真正的 `ReferenceError: xxx is not defined` 在 `exceptionDetails.exception.description` 里（带 message + stack）。表现是折腾了三轮只能看到「未捕获异常: Uncaught」。**取异常文本的顺序必须是 `exception.description || exception.value || exceptionDetails.text`。**
- **CDP 脚本的「失败现场」必须在 catch 分支也能打出来**：`download-tabs-check.mjs` 的 `pageLogs` 只在**正常走完**时打印，而超时抛错走 `main().catch` —— 页面日志（我插的 `DBG`、`console.error`）全丢，只剩一句「等待超时」。修法：`globalThis.__mvPageLogs = pageLogs` 让 catch 分支也能取到，并**打印尾部而不是头部**（前 40 条全是首屏的 400 噪声）。**任何「攒起来最后统一打印」的诊断信息，都要确认它在异常路径上也真的会被打印。**

## 12. 许可与内容声明

本项目是**本地文件管理工具**，不提供、不托管、不分发任何漫画内容，也不内置任何破解或绕过能力。
所有内容由使用者自行获取并存放于自有磁盘。下载能力只对接使用者自己的账号与合法来源。
