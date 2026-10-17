# v4 进度看板（最终）

本轮起点：v3 交付后用户两条反馈 ——「收藏夹/排行榜/登录/断点续传不是能从下载器逆向出来吗」+「阅读时上一页和下一页是反的」。
冻结契约见 [v4-taskbook.md](v4-taskbook.md)。

## 一、单一验收入口

```
node scripts/dev/verify-all.mjs
```

覆盖 10 项：单元+集成测试 / vault 破坏性验收 / 浏览器滚动 / dist 一致性 / 阅读器翻页方向(真浏览器) /
下载页三页签(真浏览器) / 管理台(真浏览器) / 孤儿清理竞态探针 / exe 自检 / 工程卫生(参考)。

## 二、阅读器翻页方向（用户报障，已闭环）

根因：`public/modules/reader.js` 的 `rtlStep(visual)` 把「舞台左/右」的空间语义反转，
而**带箭头图形的**工具栏按钮与 ← → 键也走了它 → 默认日漫模式（rtl=true）下点「下一页」实际回上一页。

修复：按钮 / 方向键 / 舞台边缘一律按页码（左=上一页，右=下一页）；rtl 只影响双页左右页顺序。

**证据链**：

| 项目 | 结果 |
|---|---|
| `node scripts/dev/reader-nav-check.mjs` | **9/9 通过 · 退出码 0**（真实 headless Edge + 原始 CDP） |
| 核心断言 | `点「下一页」后页码 = 2` → 点前=1 点后=2 |
| 前置条件 | `日漫模式前置条件成立（rtl=true，这个 bug 只在此前提下暴露）` |
| **反证（Lead 亲测）** | 把 `next-page` 改回 `step(-1)` → **7/9 · 2 项 FAIL · 退出码 1**，核心断言报 `点前=1 点后=1` |
| **反证后还原** | `reader.js` sha256 `C2A007A4651FAEBC4ABDBF0BB529C8404320769597997F86404B2DDC82715D3D` 与反证前逐字节一致 |

## 三、下载能力补全

### 3.1 结论：用户点名的 4 项，实际缺失面与直觉不同

| 项目 | 真实情况 |
|---|---|
| 登录 | 后端**本就存在**；缺的是前端「我的」页签 |
| 收藏夹 | 后端**本就存在**；缺的是前端页签 |
| 排行榜 | 适配器已有 `leaderboard()`，**缺路由与前端页签** |
| 断点续传 | **不是缺失，是规格太低**：原来只是「文件存在即跳过」 |

参考下载器 26 个 command 全部对账过（见 v4-taskbook §4）。接口层与本项目适配器完全对齐；
唯一实质缺口是 `export_pdf`（我们只有 zip / cbz），本轮未做。

### 3.2 后端（已完成）

· 新增 `/api/download/leaderboard`、`/api/download/profile`，`tests/download-routes.test.mjs` **75 断言**。
· 逐页台账 `src/modules/download/ledger.mjs` + `engine.mjs` 接线，`tests/download.test.mjs` **238 断言**（原 169）。
  命中条件 = 台账有记录 且 文件存在 且 字节数一致（响应带 Content-Length 时校验一致）。
  参考下载器的续传只是 `download_manager.rs:766` 的「文件存在即跳过」，我们这是有意升级。

### 3.3 前端三页签（已完成）

真实浏览器验收 `scripts/dev/download-tabs-check.mjs` —— **38/38 通过 · 退出码 0**。

修掉的真 bug：

1. **`auth.mjs` 形参遮蔽访问器 → 登录从来没成功过**。
   `saveAccount(account, tokenOk)` 的形参 `account` 遮蔽了模块级 `account()`，
   函数内 `account().markDirty()` 变成「把对象当函数调用」→ TypeError → 登录路由 502。
   前端表现是「点登录没反应、一直转圈」，从 v2 起就存在。已改名为 `profile` 并加注释。
2. **`loadAccount` 卡在转圈**：在 `try` 里渲染（此时 `accountLoading` 仍为 true）、`finally` 只清标志不再渲染
   → 登录表单永远出不来。改为先清标志再渲染，与 `loadProfile` 收尾写法一致。
3. **后端收藏夹路由丢弃 `?sort=`**：`favorites({ page })` 没传 sort，适配器默认 dd
   → 界面点「最早收藏」看起来有反应，实际仍按最新收藏拉。已透传。
4. **`onShow: loadFavorites` 被无参调用**：`reset` 为 undefined，`startPage = favoritesPage + 1 = 2`
   → 首次进页签直接拉第 2 页。已显式传 `reset=true`。
5. **账号变化后不拉资料**：`doLogin` 里调了 `loadProfile()`，但登录态实际是由 SSE `account` 事件补上的，
   那条路径只重绘不拉取 → 界面停在「登录后点「重新获取」…」。已加 `ensureProfileLoaded()`，
   账号事件与「我的」页签进入都会补拉一次。

修掉的**假绿**（比失败更危险）：

· 检查脚本 `cardCount()` 数全局 `.comic-card`，而隐藏面板的卡片仍在 DOM 里
  → 「排行榜渲染出 24 张」数的其实是收藏夹的隐藏卡片。已给面板加 `mv-dl-panel`，计数限定到可见面板。
· 假上游排行榜响应写成 `{ comics: { docs: [...] } }`（对象），而适配器读 `Array.isArray(d.comics)`、
  参考下载器 Rust 定义是 `GetRankRespData { comics: Vec<ComicInRankRespData> }`（数组）
  → 排行榜链路实际是空的，空态文案「换个周期（日榜 / 周榜 / 月榜）」又骗过了 `clickByText`。

## 四、管理台补全

### 4.1 后端 6 组新能力（已完成）

`meta/plan`·`meta/batch`（批量改元数据）、`meta/export`·`meta/import`（元数据导出导入）、
`move/plan`·`move`（跨库根搬迁）、`orphans`·`orphans/clean`（孤儿清理）、
`audit`·`audit/undoable`·`audit/undo`·`audit/archive/:id`（审计日志 + 撤销）、`tags/assign`（批量标签，支持 dryRun）。
新增 `ops/meta-batch.mjs`、`ops/orphan.mjs`、`ops/undo.mjs`、`audit.mjs`。

### 4.2 前端（已完成）

`public/modules/vault.js` 重写为 11 个页签，6 组功能全部落地（预演 → 二次确认 → 执行 → 可撤销）。
真实浏览器验收 `scripts/dev/vault-admin-ui-check.mjs` —— **28/28 通过 · 退出码 0**，含
「预演不落审计」（1 次写入 + 1 次预演 → 恰好 1 条审计）、「选择跨页签共享」、「搬运预演显示重名策略与目标路径」等。

### 4.3 顺带发现并修掉的 4 个真实后端缺陷

| # | 位置 | 症状 | 严重度 |
|---|---|---|---|
| 1 | `ops/index.mjs`（barrel） | 新增 ops 模块没在 barrel 转出 → import 抛 `does not provide an export named` → **整个 vault 模块注册失败**，`/api/vault/*` 全挂但页面看不出来 | 高（功能全废） |
| 2 | `ops/undo.mjs` | 撤销「重名自动改名」的搬迁时用 `it.dir` 而非 `it.destDir` 定位 → 撤销失败 | 中 |
| 3 | `vault/catalog.mjs` | 两个库根出现同名目录时归属判错 → 幻影重复项 + 真实漫画被误判「磁盘孤立」→ **孤儿清理会把正常漫画移进回收站** | **数据破坏** |
| 4 | `core/util.mjs` | Windows 并发读时 `rename` 抛 EPERM → 库扫描静默不落盘（新索引只在内存里） | 高（静默丢数据） |

### 4.4 孤儿清理竞态：审计复现的「清空库根」缺陷（已修 + 已验证）

审计探针 `scripts/dev/vault-orphan-race-check.mjs` 复现：

```
B 段（索引缺失 = 新库根刚加好的真实形态）
  修复前：扫描进行中=true ｜ 磁盘孤立 150 ｜ report.diskOnly={"moved":150} ｜ 残留正常漫画 0/150
  修复后：清理 HTTP=409 ｜ report.diskOnly=null ｜ 误移入回收站 0 ｜ 残留正常漫画 150/150
```

根因：`cleanOrphans` 没有任何 scanning 守卫，而 `before` 快照来自 catalog 的目录兜底 ——
索引还没落盘时，「整个库根」和「磁盘孤立」长得一模一样。用户真实可触发：
设置页加库根 → 去管理台点孤儿清理 → 库根被搬空。

修复（三重护栏，纵深防御）：

1. **入口拒绝**：扫描进行中直接 409「漫画库正在扫描，请等扫描结束再清理孤儿」。
2. **按库根排除「尚未索引」**：某根一部都没进索引时（`byRoot` 汇总），它的 disk-only 判为「尚未索引」而非孤儿，跳过并在报告里说明。
3. **动手前复核**：执行前再取一次快照，disk-only 集合与之前不一致就中止磁盘清理。

## 五、当前基线（冻结态实测）

```
node tests/run-tests.mjs   →  888 通过 / 0 失败 · 10/10 文件全绿 · 退出码 0
  core 25 / dedupe 59 / desktop 154 / download-routes 75 / download 238
  / integration 67 / library 24 / reader 16 / ui-smoke 54 / vault 176

node scripts/dev/reader-nav-check.mjs      →  9/9  通过 · 退出码 0（另有反证）
node scripts/dev/download-tabs-check.mjs   →  38/38 通过 · 退出码 0
node scripts/dev/vault-admin-ui-check.mjs  →  28/28 通过 · 退出码 0
node scripts/dev/dist-consistency.mjs      →  dist 与源码一致（95 个文件）· 退出码 0
node scripts/dev/desktop-selftest.mjs      →  16/16 通过 · 退出码 0
node scripts/dev/verify-all.mjs            →  10 项 9 通过 / 0 失败 / 0 跳过 · 退出码 0（189s）
```

基线演进：v3 末 622 → 本轮中途 766 → **888**。exe：`dist/MangaVault.exe` sha256 `c2ed48d61cfd91cf`（本轮最终重建）。

## 六、本轮查出来的「假交付」风险

1. **`dist/` 不会自动同步**：`dist-consistency.mjs` 已能一键比对 dist/app 与 src 的 sha256，
   并已注册进 `verify-all.mjs`（排在 exe 自检之前，避免拿过期 dist 跑出自检假通过）。
2. **子代理中断会留下半成品，而且可能是「看起来很对」的半成品**：
   · 一条工作流的 barrel 转出缺失 → 整个 vault 模块注册失败；
   · 另一条把自己的插桩实验留在了 `loadProfile` 里（错误分支变成 `if (false)` 死代码 + `window.__mvProfileTrace`），
     排查时一度把矛头指向错误的地方。**接手别人的代码前先看有没有 `if (false)`、`__mv` 命名的调试残留**。
3. **假绿比 FAIL 更难发现**：全局选择器 + 隐藏面板 = 断言数对了但什么都没验。
4. **测试之间会互相污染全局对象**：`ui-smoke` 把 `globalThis.fetch` 换成禁止联网的桩，
   导致按字母序排在它后面的 `vault.test.mjs` 用 fetch 就炸 —— **单独跑绿、跑全量红**。已改用 `node:http`。
   教训：任何「全绿」都是快照，必须跑全量确认。

## 七、一条被证伪的「疑似缺陷」

工程卫生检查报 `<数据目录>/server.lock.json` 是陈旧锁，提示「会让启动误判已在运行」。
**查证结论：这是过度断言，不是缺陷。** `src/server.mjs` 的 `existingInstance()` 做了三重校验 ——
pid 存活（`process.kill(pid, 0)`）→ `/api/ping` 可达 → 对端返回 `name === MangaVault`；
进程已死就直接返回 null，陈旧锁不会阻断启动。实测：清掉锁后启动服务，`PING=200`，正常写入新锁。

顺手做成了自清理（启动时若发现陈旧锁就删掉），并在代码注释里写明「为什么它不是误判」，
免得后来者照着 linter 的提示去改一段本来就对的逻辑。

## 八、未做 / 已知缺口

· PDF 导出：参考下载器有 `export_pdf`，我们只有 zip / cbz。JPEG 可用 PDF 的 `/DCTDecode` 零依赖直嵌，待评估。
· 哔咔真机联调：token 已失效（上游 401 / code 1005），本轮所有下载验证均为离线夹具，**未伪造真机成功**。
· `--with-node` 绿色包未在无 Node 机器实测。
· `vault-orphan-race-check.mjs` 的 A 段（索引热场景）装配有问题，报「环境失败」；
  B 段足以证明护栏有效，A 段待修。
· 工程卫生评分 64/100（高危 0 条）：主要扣分来自「单文件过大」——本轮新增的
  `public/modules/vault.js`（1439 行）与 `public/modules/download.js`（1314 行）。属功能代价，后续可拆。