# v4 任务书 · 阅读器翻页方向修复 + 下载能力补全

> 本轮由 Lead 立稿。冻结的接口契约与文件所有权以本文为准；
> 与本文冲突的实现一律以本文为准，先改文档再改代码。

## 1. 本轮来源（用户原话）

1. 「收藏夹/排行榜/登录/断点续传 这些不是能通过下载器里逆向得到吗？」
2. 「还有突然发现在阅读漫画的时候上一页和下一页是反的」

---

## 2. 阅读器翻页方向（已完成，Lead 亲修）

### 2.1 根因

`public/modules/reader.js` 里有一个 `rtlStep(visual)`，把「舞台左/右」的空间语义
在 `rtl=true` 时反转，让日漫模式点左侧 = 前进。这本身对**没有图形的边缘点击区**是合理的，
但工具栏的「上一页 / 下一页」按钮和 ← → 方向键也走了同一个函数 —— 它们是有箭头图形的控件，
图形含义必须与动作一致。于是默认（`rtl=true`）下：

| 控件 | 修复前调用 | 修复前实际行为 | 修复后 |
|---|---|---|---|
| 上一页 ← | `rtlStep(1)` → `step(1)` | **下一页**（错） | `step(-1)` 上一页 |
| 下一页 → | `rtlStep(-1)` → `step(-1)` | **上一页**（错） | `step(1)` 下一页 |
| 方向键 ← | `rtlStep(1)` | **下一页**（错） | `step(-1)` 上一页 |
| 方向键 → | `rtlStep(-1)` | **上一页**（错） | `step(1)` 下一页 |
| 舞台左缘 | `rtlStep(1)` | 下一页 | `step(-1)` 上一页 |
| 舞台右缘 | `rtlStep(-1)` | 上一页 | `step(1)` 下一页 |

### 2.2 冻结约定（唯一真源）

- 「上一页 / 下一页」按钮、← → 键、舞台左右边缘：**一律按页码**。左 = 上一页（idx-1），右 = 下一页（idx+1）。任何地方都不反转。
- 阅读方向 `rtl` 只影响两件事：双页模式的左右页顺序（`render()` 里的 `row-reverse`），以及方向指示文案。
- 将来若要做「日漫反向点按」，必须新增独立开关，**不允许**再在翻页函数里把全局反转回去。
- 注释块已写在 `reader.js` 的翻页函数处，动它之前必须先读那段注释。

### 2.3 测试钩子（契约）

`reader.js` 的翻页控件一律带 `data-act`，测试不得使用 `nth-child`：

```
[data-act="prev-chapter"]  [data-act="prev-page"]  [data-act="page-num"]（input）
[data-act="page-total"]    [data-act="chapter-label"]
[data-act="next-page"]     [data-act="next-chapter"]
```

### 2.4 验收

- `node scripts/dev/reader-nav-check.mjs` —— 真实 headless 浏览器，日漫模式下断言点「下一页」页码 +1。
- 必须附**反证**：把 `next-page` 改回 `step(-1)` 时应 FAIL，恢复后 PASS。

---

## 3. 下载能力补全（4 条并行工作流）

### 3.1 冻结的接口契约

```
GET /api/download/leaderboard?tt=H24|D7|D30&ct=VC&page=1
  200 { ok:true, source:"picacomic", rankType:"H24", ct:"VC", page:1, pages:1, total:<n>, comics:[Comic...] }
  400 { ok:false, error:"中文原因" }                        参数非法
  400 { ok:false, code:"NOT_SUPPORTED", error:"中文原因" }   来源不支持
  401 { ok:false, error:"中文原因" }                        未登录 / 上游 401

GET /api/download/profile
  200 { ok:true, source:"picacomic", profile:{ id, name, email, avatar, level, exp, role } }
  401 { ok:false, error:"中文原因" }
```

`comics` 数组元素形状必须与 `GET /api/download/search` 完全一致 —— 前端复用同一个卡片渲染器。

### 3.2 文件所有权（并行纪律：一人一文件，禁止交叉）

| 工作流 | 独占文件 | 交付 |
|---|---|---|
| W1 路由 | `src/modules/download/index.mjs`、新建 `tests/download-routes.test.mjs` | leaderboard / profile 两条路由 + 测试 |
| W2 续传 | `src/modules/download/engine.mjs`、`tasks.mjs`、新建 `ledger.mjs`、`tests/download.test.mjs` | 逐页台账 + 真续传 |
| W3 前端 | `public/modules/download.js`、`public/theme.css` | 收藏夹 / 排行榜 / 我的 三个页签 |
| W4 测试 | 新建 `scripts/dev/reader-nav-check.mjs`、`scripts/dev/verify-all.mjs` | 翻页方向真实浏览器回归 |

### 3.3 断点续传的设计取舍

参考下载器（`_ref_downloader/picacomic-downloader-main/src-tauri/src/download_manager.rs:766`）的续传是：

```
// 如果图片已存在，则跳过下载
if user_format_path.exists() || gif_path.exists() { 跳过 }
```

即**只判断文件存在**，不校验字节数、不记录逐页状态，进程重启后无法区分「下完」与「下到一半」。
我们不复刻这个做法，改为逐页台账（`data/download/ledger/<taskId>.json`），命中条件 =
台账有记录 **且** 文件存在 **且** 字节数一致（响应带 Content-Length 时还要校验一致）。这是有意做的优化。

---

## 4. 参考下载器功能对账（26 个 command 全量）

接口层（`pica_client.rs`）与本项目 `sources/picacomic.mjs` **完全对齐**，没有遗漏：

| 参考下载器 | 本项目 | 状态 |
|---|---|---|
| `auth/sign-in` 登录 | `login()` | 已有 |
| `users/profile` | `profile()` | 适配器已有，**路由 W1 补** |
| `comics/advanced-search` | `search()` | 已有 |
| `comics/{id}` | `comic()` | 已有 |
| `comics/{id}/eps` | `chapters()` | 已有 |
| `comics/{id}/order/{o}/pages` | `pages()` | 已有 |
| `users/favourite?s=` | `favorites()` | 已有 |
| `comics/leaderboard?tt=&ct=VC` | `leaderboard()` | 适配器已有，**路由 W1 补** |
| 断点续传（文件存在即跳过） | 逐页台账 | **W2 优化** |
| `export_cbz` | `export.mjs` zip / cbz | 已有 |
| `export_pdf` | — | **缺，待评估** |
| `show_path_in_file_manager` | `/api/download/open-folder` | 已有 |
| `get_downloaded_comics` / `update_downloaded_comics` | update-check / update | 已有 |
| `download_all_favorites` | `/api/download/favorites/sync` | 已有 |
| `get_logs_dir_size` | `/api/download/tasks/:id/logs` | 已有 |
| `pause/resume/cancel_download_task` | 同名路由 | 已有 |

结论：**用户点名的 4 项里，登录与收藏夹后端早已存在**，缺的是排行榜/资料路由（W1）与三个前端页签（W3）；
断点续传是**规格升级**（W2），不是缺失。

## 5. 本轮不做

- PDF 导出（需要 PDF 封装器；JPEG 可走 /DCTDecode 零依赖直嵌，待评估工作量后再决定）。
- 哔咔真机联调：token 已失效（上游 401 / code 1005），本轮所有下载相关验证都是离线夹具，**不伪造真机成功**。
- `dist` 重建与 exe 自检：所有写入者停止后由 Lead 统一执行（见 v3 教训：`dist/` 只是 `src/` 的快照）。