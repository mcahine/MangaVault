# v3 任务书

> 背景：v2 已交付但用户验收不通过，提出 6 条问题。v3 的目标是**真正把它们解决**。
> 每条任务都写明：现状 / 目标 / 写入范围 / 验收标准 / 边界。

---

## 用户提出的 6 条问题（原文要点）

1. **桌面端要"字面意义的 exe 软件"，不是 web 端。**
2. **漫画库没法下滑看见更多漫画**（展开/滚动坏了）。
3. **桌面外壳不对**：它被做成了"页面里的一个模块"，而用户要的是 web → 桌面的**整体迁移**。
4. **下载功能缺很多**：收藏夹、排行榜、登录、断点续传……还要求做成**方便继续迁移其他下载器的模块**。
5. **picacg处理/ 没必要保留**；**先期漫画/ 要做成像 picacg漫画/ 那样健全**。
6. **管理台没做好**；工程方面欠缺（文档、AGENT.md、团队文档、井井有条、数据与代码分离）。

---

## 任务总览

| 编号 | 任务 | 负责 | 写入范围 |
| --- | --- | --- | --- |
| T1 | Windows exe 宿主与打包 | shell-smith | desktop/** , scripts/build-desktop.mjs , src/modules/desktop/** , assets/** |
| T2 | 前端内核修复 + 去模块化 + 视觉 | ui-smith | public/（见团队规范，不含 download/vault/dedupe 页面） |
| T3 | 下载中心 v3（登录/收藏/排行/续传/适配器） | dl-smith | src/modules/download/** , public/modules/download.* , tests/download.test.mjs |
| T4 | 先期漫画健全化 + 扫描器增强 | lib-smith | src/modules/library/** , scripts/normalize-library.mjs , tests/library.test.mjs |
| T5 | 管理台补全 | vault-smith | src/modules/vault/** , public/modules/vault.* , tests/vault.test.mjs |
| T6 | 文档工程 + 交叉验收 | docs-qa | README.md , docs/** , tests/integration.test.mjs |
| T7 | 数据/代码分离 + 归档 + 集成（lead） | lead | src/core/** , src/server.mjs , src/modules/index.mjs |

---

## T1 · Windows exe 宿主与打包（shell-smith）

### 现状

v2 的"桌面端"只是 `src/modules/desktop/` 这个**页面内模块** + 用 Edge `--app=` 模式开窗口。
用户明确否定了这个方案：要的是**双击运行的原生 exe 程序**，不是浏览器外壳。

### 已完成的可行性验证（不要重新探索，直接用）

lead 已经用系统自带编译器打通并**跑出真实证据**，链路如下：

- 编译器：`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（系统自带，无需 Visual Studio）
- 运行时：WebView2 Runtime 已安装（实测 155.0.4283.45）
- SDK：从 NuGet 取 `Microsoft.Web.WebView2` 托管 DLL（`Microsoft.Web.WebView2.Core.dll`、`Microsoft.Web.WebView2.WinForms.dll`）
- 原生加载器：`build/native/x64/WebView2Loader.dll` 必须与 exe 同目录

**踩过的坑（必须遵守）**：

1. **托管的 WebView2 DLL 必须拷到 exe 同目录**，否则 CLR 在 JIT Main 时找不到类型，进程**静默秒退、无任何报错**。
2. 自查方式：宿主在启动最初就把 trace 写进 `selftest.txt`，不要等出错才写。
3. 参考实现：`_spike/wv2host/Program.cs`（可用，含 selftest 模式）。

### 目标

产出 `MangaVault.exe`：

1. **双击即用**：exe 启动 → 拉起内置 Node 后端（隐藏窗口）→ 等待 `/api/ping` 通过 → WebView2 打开界面。
2. **单文件优先**：把 Node 运行时（`node.exe`，88 MB）与后端源码一起放进 `dist/`，做成**免安装绿色包**；
   若无法内联，则 `dist/` 目录结构为 `MangaVault.exe` + `node/node.exe` + `app/*.mjs` + `public/` + `WebView2Loader.dll`。
   提供 `scripts/build-desktop.mjs` 一键产出。
3. **窗口即应用**：标题「漫库」、图标、最小尺寸 1024×640、尺寸位置记忆（存 `data/window.json`）、
   关闭窗口 = 退出并**杀掉后端子进程**（不得留孤儿 node）。
4. **原生能力**（走 `src/modules/desktop/` 的 HTTP 桥，前端调）：
   - 系统默认程序打开外部链接（**白名单 http/https/mailto**，拒绝其他协议）
   - 资源管理器定位文件（`/select,` 参数）
   - 原生目录选择对话框（用于添加库根）
   - 退出应用
5. **不要**再把桌面功能做成一个前端页面模块。`public/modules/desktop.js` 应被删除，导航里去掉了。

### 验收标准

```powershell
node scripts/build-desktop.mjs                 # 产出 dist/MangaVault.exe，退出码 0
node scripts/dev/desktop-selftest.mjs          # 自动跑 exe selftest，断言 trace 关键行
```

selftest 必须证明（写进 `tests/desktop.test.mjs`）：

- exe 进程启动后 **自己** 拉起了 node 后端（`SERVER-PID` 非空）
- 后端 `/api/ping` 返回 200（`PORT` 非 0）
- WebView2 环境创建成功（`ENV-OK version=...`）
- 窗口真正显示（`SHOWN`）
- 关闭时后端子进程被回收（无孤儿 node）

### 边界

- 不引入 npm 依赖。WebView2 的 NuGet 包只用于**获取托管 DLL**，不把 NuGet 变成运行时依赖。
- 不修改 `public/`（那是 ui-smith 的范围）。
- 不修改 `src/core/**`、`src/modules/index.mjs`（lead 的范围）。需要改就说。
- GUI 进程会逃逸 DSH 的后台作业范围：**验证时用 `--selftest` 模式让 exe 自己退出**，
  并把证据写文件，不要用前台等待。

---

## T2 · 前端内核修复 + 去模块化 + 视觉（ui-smith）

### 现状与根因

**(a) 漫画库滚不动、看不到更多漫画。**

真实原因在 `public/app.js` 的 `virtualGrid()`：

- 它只监听 `window` 的 `scroll`（第 369 行），**且从不监听真正的滚动容器**。
- 实际滚动发生在 `main.content`（`theme.css` 第 146 行 `.content { overflow: auto }`），
  `#content` 上滚动的 `scroll` 事件**不冒泡到 window**，虚拟网格因此永远不重绘 → 只显示首屏。
- 同时 `library.js` 的触底翻页也绑在 `document.getElementById("content")`，与虚拟网格的滚动源不一致。

**修复要求**：

1. 找出真正的滚动祖先（`findScroller()` 已有逻辑），把 `scroll` 监听**绑到该元素**（用 `{ passive: true }`），
   而不是只绑 window；容器变化时要能重新绑定。
2. 用 `ResizeObserver` + 滚动双触发重绘；确保 `paint()` 里的 `rel` 计算对"滚动容器不是 window"这一情形正确。
3. **写一个真实的浏览器验证**：用 CDP 或 `--headless` 打开页面，滚动到底部，断言渲染出的卡片数 > 首屏数，
   并且**能看到最后一页的漫画**。不能只靠肉眼。

**(b) 桌面端被做成了页面模块，用户要的是整体迁移。**

- 删除 `public/modules/desktop.js`，从导航移除。
- `app.js` 里 `ctx.desktop` 改为调用 T1 的 HTTP 桥（`/api/desktop/info` 等），**不再依赖页面模块**。
- 设置页里"桌面"相关的项改为调用桥接接口（选目录用原生对话框）。
- `<html data-platform="desktop">` 的判据改为桥返回的 `mode`，而不是靠 UA。

**(c) 视觉不能有 AI 风味。**

保持 v2 已定的 RISOPRINT 方向，但**补齐"炫酷"与"细节"**：

- 漫画卡片：悬停时套印错位（misprint）幅度、硬投影位移、网点密度变化要**有物理感**。
- 加载骨架用网点而不是灰块。
- 空状态/错误态要有排版感（竖排标签、编号、校色条）。
- **禁止**：`backdrop-filter`、`filter: blur`、多色渐变、药丸圆角、渐变文字。
- 新增视觉元素必须先写进 `docs/UI_GUIDELINE.md`（那是唯一真源，与 docs-qa 协调）。

### 验收标准

```powershell
node tests/run-tests.mjs ui-smoke      # 结构断言
node scripts/dev/ui-scroll-check.mjs   # 真浏览器滚动验证（新增）
```

### 边界

- 不改 `public/modules/{download,vault,dedupe}.js`（各有其主）。
- 不改任何后端。
- `ctx` API 已冻结（见团队规范 4.3）。要新增 API 先发消息给 lead。

---

## T3 · 下载中心 v3（dl-smith）

### 现状

已有登录/搜索/收藏同步/增量更新/导出/代理/任务队列（37 条路由，120 条断言）。
但**用户看参考项目截图后指出仍缺**：

| 缺失 | 参考项目对应 |
| --- | --- |
| **排行榜** | `comics/leaderboard?tt={H24,D7,D30}&ct=VC` |
| **收藏夹浏览** | `users/favourite?s={dd,da}&page={page}`（现有同步≠可浏览） |
| **断点续传** | 图片级续传：已下载的图要跳过，任务重启后接着下 |
| **用户资料** | `users/profile`（现有登录但没展示账号） |
| **高级搜索** | `comics/advanced-search?page=` + 排序（dd/da/ld/vd）+ 分类筛选 |
| **下载单个章节 / 整本 / 收藏夹批量** | 对应参考的 `create_download_task` / `download_comic` / `download_all_favorites` |
| **暂停/恢复/取消任务** | 已有路由，需确认前端真的接了 |
| **已下载漫画列表与更新检测** | `get_downloaded_comics` / `update_downloaded_comics` |
| **在资源管理器中显示** | `show_path_in_file_manager` |

### 参考项目的真实接口（已从 zip 中读出，直接用）

```
GET  comics/advanced-search?page={page}
GET  comics/{comic_id}
GET  comics/{comic_id}/eps?page={page}
GET  comics/{comic_id}/order/{order}/pages?page={page}
GET  users/favourite?s={dd|da}&page={page}
GET  comics/leaderboard?tt={H24|D7|D30}&ct=VC
```

签名（已在 v2 验证可用）：`HMAC-SHA256(DIGEST_KEY, lowercase(path + time + nonce + METHOD + apiKey))`，请求头带 `time`。

### 目标

**1) 补齐上面表格中的全部能力**（后端路由 + 前端界面）。

**2) 断点续传要真做，不是摆设**：

- 每张图片下载完成即记录到 `data/download/<taskId>.json` 的 `pages: { "001.jpg": {done:true,bytes:n} }`
- 任务恢复时**跳过已完成页**，只补缺的
- 已存在但**大小为 0 或与 Content-Length 不符**的文件视为未完成，重新下
- 任务可从"暂停"或"进程重启"两种状态恢复

**3) 下载器适配器契约（这是用户说的"方便后续迁移其他下载器"）**：

新增 `src/modules/download/sources/` 目录，定义统一适配器接口：

```js
// sources/<id>.mjs
export const meta = { id: "picacomic", name: "哔咔", needsLogin: true };
export default {
  meta,
  async login(ctx, creds) { /* 返回 { token, profile } */ },
  async search(ctx, query, opts) { /* 返回 { items, page, pages } */ },
  async comic(ctx, id) { /* 返回统一 Comic 结构 */ },
  async chapters(ctx, id) { /* 返回 Chapter[] */ },
  async pages(ctx, comicId, order) { /* 返回可直接下载的图片 URL 列表 */ },
  async favorites(ctx, opts) { /* 可选：不支持则 throw NotSupported */ },
  async leaderboard(ctx, opts) { /* 可选 */ },
  async profile(ctx) { /* 可选 */ }
};
```

- 统一结构 `Comic` / `Chapter` 定义在 `sources/types.mjs` 并用 JSDoc 标注字段
- 现有哔咔实现搬进 `sources/picacomic.mjs`，**行为不变**
- `index.mjs` 通过 `sourceId` 参数路由；默认 `picacomic`
- 不支持的能力抛 `NotSupported`，路由返回 `{ ok:false, error:"该下载源不支持…" }` 而不是 500
- 契约文档写进 `docs/DOWNLOAD_SOURCES.md`，含**新增一个下载源的完整步骤与最小示例**

### 验收标准

```powershell
node tests/run-tests.mjs download        # 原有 120 条不得退化
```

新增断言（**全部离线**，用本地起的假 HTTP 服务器模拟哔咔 API）：

- 断点续传：模拟下到第 3 张中断 → 恢复 → 只请求缺失的图（断言请求次数）
- 0 字节文件被识别为未完成并重下
- 排行榜/收藏夹解析（用固定 JSON 样本）
- 适配器注册与 NotSupported 降级
- 未登录时调用需登录接口 → 明确中文错误，而不是崩溃

### 边界

- **不要真的联网测试**（token 已失效）。用本地假服务器。
- 不改 `public/app.js`（ui-smith 的范围）；只改 `public/modules/download.{js,css}`。
- 不伪造"下载成功"的验证结论。上游不可用就如实写在文档里。

---

## T4 · 先期漫画健全化 + 扫描器增强（lib-smith）

### 现状（实测）

`先期漫画/` 有 **53 部**作品、5,937 张图、2.28 GB：

- **0 部**有 `元数据.json`
- **0 部**有 `cover.jpg`
- 只有 **2 部**有子目录，其余 **51 部**图片直接躺在漫画目录下（L0 裸形态）
- 目录名带技术后缀，如 `3D作品集（619dde41）`、`ミツカ CG集（60d1511f）`、`Cosplay写真集（5b547a0a）`

对比 `picacg漫画/`：全部有 `元数据.json` + `cover.jpg` + 章节子目录。

### 目标

**1) 扫描器增强（`src/modules/library/scanner.mjs`）**

- 新增**健全度分级** A/B/C/D，写进每部漫画的 `health` 字段（规则见 `docs/LIBRARY_FORMAT.md` 第 5 节）
- 扫描结果里给出 `stats.byHealth` 统计
- 裸形态（L0）要在 `chapters[0].title` 上用「第1話」而不是目录名
- 保持对 v2 已有结构的完全兼容（`picacg漫画/` 的 196 部不能变差）

**2) 规范化脚本 `scripts/normalize-library.mjs`**

```powershell
node scripts/normalize-library.mjs --root=early              # 预演，只打印计划
node scripts/normalize-library.mjs --root=early --apply      # 真正执行
node scripts/normalize-library.mjs --root=early --apply --cover-only   # 只补封面
```

必须做到：

- 解析目录名 → 干净标题（去掉 `（8-16 位十六进制）` 技术后缀，保留 `（单行本）` 这类语义标注）
- 生成 `元数据.json`：`id` / `title` / `pagesCount` / `chapterInfos` / `createdAt`
  - `id` 用稳定哈希（同名目录重复跑结果一致）
  - **不得覆盖已有元数据**，除非 `--force`
- 生成 `cover.jpg`：取第一张图，等比缩放到宽 600，JPEG 质量 82
  - **纯 Node 实现**（`node:zlib` + 手写 JPEG 编码，或复用 v2 已有的图片工具）；**不得引入 npm 依赖**
- 全程**幂等**：跑第二遍不应产生变化
- `--apply` 前必须打印将写入的文件数并要求确认（非交互时用 `--yes`）
- **可回滚**：写入前把原文件备份到 `data/normalize-backup/<时间戳>/`

**3) 真跑一次并出报告**

对 `先期漫画/` 实际执行 `--apply`，产出：

- 之前/之后的健全度对比表
- 至少 5 个目录的**实际变化样例**（原目录名 → 新标题，新增文件清单）
- 落盘到 `docs/NORMALIZE_REPORT.md`

### 验收标准

```powershell
node tests/run-tests.mjs library
```

新增断言（全部在 `os.tmpdir()` 造样本）：

- L0/L1/L1+/L2 四种形态都能正确识别，章节数与图片数正确
- 健全度分级正确（A/B/C/D）
- 标题规范化：`3D作品集（619dde41）` → `3D作品集`；`萝莉（单行本）` **保持不变**
- 幂等：连续跑两次 normalize，第二次无变化
- `--force` 才覆盖已有元数据
- 封面生成：产物是合法 JPEG 且宽度 600

### 边界

- **先期漫画是用户的真实数据**。`--apply` 前必须备份；脚本必须幂等；不得删任何图片。
- 不改 `picacg漫画/`。
- 不改前端；健全度展示由 ui-smith 接（把字段名告诉他就行）。

---

## T5 · 管理台补全（vault-smith）

### 现状

v2 已有：元数据编辑、重命名预演/执行、移动到其它库根、回收站、封面设置、
校验修复、重复检测、统计、阅读时长、备份恢复。28 项破坏性验收全绿。

**用户说"管理台没有做好"**，需要从**完整性、可用性、工程性**三方面补：

### 目标

**1) 功能缺口补齐**

- **批量标签编辑**：给选中的 N 部加/删标签（现有标签系统要打通）
- **批量元数据修正**：作者统一、汉化组统一、分类统一
- **导出/导入元数据**（JSON），支持跨机器迁移
- **库根维度的批量搬迁**：把选中的漫画从 early 移到 picacg（含进度校验与回滚）
- **空目录/孤儿文件清理**：扫描并清理 0 图片的漫画目录
- **操作历史**：所有破坏性操作留审计日志（`data/vault-audit.jsonl`），可查看、可撤销最近一步

**2) 可用性**

- 每个危险操作：**预演结果用表格展示**（将改动什么、影响几部、体积变化），确认按钮需输入 `DELETE` 或勾选二次确认
- 长操作（校验/备份/搬迁）走**进度流**（SSE），可取消
- 失败项**逐条列出原因**，不是笼统"部分失败"

**3) 工程性**

- `src/modules/vault/` 内部按职责拆清晰：`ops/` 下每个能力一个文件（现在 `ops.mjs` 已 28 KB）
- 对外路由保持不变（避免破坏前端与其他文档）

### 验收标准

```powershell
node tests/run-tests.mjs vault
node scripts/dev/vault-acceptance.mjs      # 现有 28 项必须继续全绿
```

新增断言：批量加标签 → 标签系统可见；导出→清空→导入 往返一致；
审计日志记录了每一次破坏性操作；搬迁后原位置消失、目标位置存在、索引更新。

### 边界

- **只动 vault 相关文件**。标签引擎在 `src/modules/vault/tags.mjs`（属于你）。
- 破坏性操作必须 dry-run 优先 + 可回滚；测试必须隔离（`MV_DATA_DIR`）。
- 绝不触碰真实漫画（除 T4 那次规范化外，任何人不得改用户数据）。

---

## T6 · 文档工程 + 交叉验收（docs-qa）

### 目标

**1) README.md 重写为 v3**：

- 首屏讲清"这是什么、怎么装、怎么用"
- 桌面 exe 的安装与使用（替换掉 v2 的"启动漫库.vbs"叙述）
- 库根与格式契约（指向 `docs/LIBRARY_FORMAT.md`）
- 下载能力现状与**如实说明**（需要用户自己的 token）
- 常见问题、文件位置、数据备份、卸载

**2) 文档补齐与互检**：

- `docs/ARCHITECTURE.md` 更新（进程模型、exe 宿主、请求生命周期）
- `docs/DESKTOP.md` 更新（T1 的实际实现）
- 检查**所有**文档之间的引用是否还有效，删除过时描述
- 建立 `docs/INDEX.md`：一份能让人 30 秒找到任何东西的导航

**3) 交叉验收（你要当"敌方 QA"）**：

- 写 `tests/integration.test.mjs` 的 v3 部分：真起服务、真发 HTTP、覆盖每个模块至少 3 条主路径
- 写 `scripts/dev/verify-all.mjs`：一条命令跑完全部测试 + 桌面 selftest + 卫生检查，输出汇总
- **主动找茬**：对每个成员交付的功能，尝试用边界输入打穿（空值、超长、非法路径、并发）
- 找到的问题写进 `docs/AUDIT.md`，**每条都要有复现命令**

**4) 工程卫生**：

- `scripts/tidy.mjs` 扩展：检查无 npm 依赖、无绝对路径泄漏、无遗留调试输出、目录命名规范
- 确保仓库内**没有漫画数据**、没有临时文件、`data/` 被 gitignore

### 边界

- **只写文档与测试**，不改业务代码。发现 bug 报告给对应负责人或 lead。
- 不删别人的文档；改前先读。

---

## T7 · 数据/代码分离 + 归档 + 集成（lead）

1. **数据目录迁出仓库**：默认数据目录改为 `%LOCALAPPDATA%\MangaVault`，
   支持 `MV_DATA_DIR` 与 `--data-dir`；仓库内 `data/` 只作为开发默认并被 gitignore；
   首次启动从 `config.example.json` 生成配置。
2. **模块注册表收口**：`src/modules/index.mjs` 只由 lead 改。
3. **归档 `picacg处理/`**：里面的查重模块能力已迁入 `src/modules/dedupe/`，
   原目录移入 `_archive/` 并写 `README` 说明"能力已迁移到哪里"，**不删除用户文件**。
4. **最终集成**：全量测试 + exe 真机 + 文档齐备性检查 + 交付说明。

---

## 全局验收（交付前必须全绿）

```powershell
node tests/run-tests.mjs                       # 全部单元/集成测试
node scripts/dev/vault-acceptance.mjs          # 管理台破坏性验收
node scripts/dev/desktop-selftest.mjs          # exe 真机自检
node scripts/dev/verify-all.mjs                # 汇总
node scripts/tidy.mjs                          # 卫生检查
```

并且：仓库内无漫画数据、无绝对路径泄漏、无 `node_modules`、`AGENT.md` 与 `docs/INDEX.md` 可用。
