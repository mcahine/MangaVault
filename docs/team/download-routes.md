# 下载模块：排行榜 / 账号资料 只读路由（download-routes）

> 任务：补全下载模块缺失的两个只读路由 `GET /api/download/leaderboard` 与 `GET /api/download/profile`。
> 结论：两条路由已实现并通过 75 条离线断言；全量套件中的失败项来自同事正在并行编辑的 `tests/download.test.mjs`，与本任务无关（证据见第 4 节）。

---

## 1. 写入范围

| 类型 | 文件 |
| --- | --- |
| 修改 | `src/modules/download/index.mjs`（1295 → 1407 行，仅新增，未删改既有路由行为） |
| 新增 | `tests/download-routes.test.mjs` |
| 新增 | `docs/team/download-routes.md`（本报告） |

**未触碰**：`src/modules/download/engine.mjs`、`tasks.mjs`、`sources/**`、`public/**`、其它测试文件、其它文档。

---

## 2. 交付内容

### 2.1 两条路由

| 路由 | 走的能力 | 成功 | 失败 |
| --- | --- | --- | --- |
| `GET /api/download/leaderboard?tt=H24\|D7\|D30&ct=VC&page=1` | `leaderboard` | `200 {ok:true,source,rankType,ct,page,pages,total,comics:[...]}` | tt 非法 400；ct 非 VC 400 + `code:NOT_SUPPORTED`；未登录/上游 401 → 401；其它 502 |
| `GET /api/download/profile` | `profile` | `200 {ok:true,source,profile:{id,name,email,avatar,level,exp,role}}` | 未登录/上游 401 → 401；其它 502 |

关键实现约束（逐条对照任务书）：

1. **按注册表取源**：两条路由都只用 `pickSource(c, capability)`（内部 `sources.get` / `requireCapability`），
   `index.mjs` 里没有任何 `import .../sources/picacomic.mjs`，满足「换来源不改代码」铁律。
   测试组 8 用一个临时注册的 `lb-fake` 源证明换源真的生效且完全不打哔咔上游。
2. **NotSupportedError 单独降级**：`ct` 非 VC 由适配器抛 `NotSupportedError`，路由经 `replySourceError()` →
   `400 {ok:false, code:'NOT_SUPPORTED', error:'中文原因'}`；能力缺失（源没声明 `leaderboard`）经 `replyKnown` → 同样带 `code`。
   绝不会落成 500，也不会漏出英文栈。
3. **comics 元素与 search 同形**：逐字复制 `/api/download/search` 的元素字面量
   （`id/title/author/cover/tags(≤8)/categories(≤6)/chapterCount/likes/finished/inLibrary/localDir/rootName`）；
   测试里用真实 `/api/download/search` 的返回做基准，断言两者 **字段集合完全相同**。
4. **风格一致**：`app.get(path, async function (c) {...})`、成功 `c.json({ok:true,...})`、失败 `c.error(状态码, 中文)`、
   2 空格缩进、单引号、无模板字符串（已 grep 确认两文件反引号出现 0 次）、注释与文案全中文。

### 2.2 `index.mjs` 的改动点（全部在本文件内，均为新增/加字段）

| # | 位置 | 改动 | 影响面 |
| --- | --- | --- | --- |
| 1 | `meta.help` | 增 `GET /api/download/leaderboard?tt=&ct=&page=` 与 `GET /api/download/profile` 两行 | 仅帮助清单 |
| 2 | `pickSource()` | 失败结果**增加** `code` 字段（成功时为空串） | 既有调用方只读 `.source/.error`，不受影响 |
| 3 | 新增 `replyPickedError()` | 取源失败统一 400；`NOT_SUPPORTED` 时补 `code` | 仅新路由使用 |
| 4 | `replySourceError()` | 降级 400 时**增加** `code:'NOT_SUPPORTED'` | 既有路由多一个附加字段，`ok/error/状态码` 不变（既有断言仍绿） |

### 2.3 参数与边界

- `tt`：先于登录校验检查，非法立即 400，且**不打上游**；缺省 `H24`（与适配器默认一致）。合法值取自注册表导出的 `RANK_TYPES`，不另写一份常量。
- `ct`：缺省 `VC`；非 `VC` 不在路由层硬判，而是交给适配器抛 `NotSupportedError`（来源无关于路由），符合能力层适配器的既有语义。
- `page`：沿用既有风格 `Math.max(1, c.queryInt('page', 1))`；哔咔榜单上游不分页，适配器固定回 `pages:1`，响应回显适配器的 `page`。
- `profile` 为**只读**：不写 `config`、不写账号缓存，只暴露契约约定的七个字段（`raw` 不外传）。

### 2.4 测试文件 `tests/download-routes.test.mjs`

沿用 `tests/download.test.mjs` 的既有手法：真 HTTP + `listen(0)` 随机端口 + 假 `transport`（零出网），
`sources.registerFactory('picacomic', ...)` 注入假链路，`finally` 里还原工厂、`resetStores()`、还原 `MV_DATA_DIR`、清理临时目录。
临时目录走 `src/core/util.mjs` 的 `safeTmpDir()`（没用 `os.tmpdir()`）。

共 **75 条断言 / 8 组**：

| 组 | 内容 |
| --- | --- |
| 1 | 正常榜单：状态/ok/source/rankType/ct/page/pages/total/comics 长度与逐字段、封面代理地址、上游路径 `comics/leaderboard?tt=H24&ct=VC`、authorization、只发一次请求；并与 `/api/download/search` 做**元素字段集合完全一致**断言 |
| 2 | `tt=D7` 正常 + 上游路径正确 |
| 3 | `tt=ZZZ` → 400、`ok:false`、中文错误含可选值与实际值、**未打上游** |
| 4 | `ct=HC` → 400、`code:NOT_SUPPORTED`、中文含「不支持」、未打上游 |
| 5 | 未登录（token 置空）→ 榜单 401、资料 401，均中文 |
| 6 | 上游 401（假 transport 回 401）→ 榜单 401、资料 401，均中文 |
| 7 | 资料正常：七字段值 + **键集合恰为契约七字段** + 上游路径 `users/profile` + 只发一次请求 |
| 8 | 换源：`sourceId=lb-fake` 内容来自假源且不打哔咔；缺能力的 `lb-stub` → 400 + `code:NOT_SUPPORTED`；未知源 → 400 中文 |

---

## 3. 验收命令与实测输出

### 命令 1：`node tests/run-tests.mjs download-routes`

```text
══ 漫库 MangaVault 测试报告 ══
✓ PASS  下载路由（排行榜 / 账号资料）      download-routes.test.mjs  75 通过 / 0 失败 / 963ms
    · 排行榜/账号资料路由用例全部离线完成，未访问真实网络

总计: 75 通过 / 0 失败  ·  用例文件 1 通过 / 0 失败
```

新文件被 `tests/run-tests.mjs` 自动发现（它按 `tests/*.test.mjs` 全量 `readdirSync` 排序加载），无需注册。

### 命令 2：`node tests/run-tests.mjs`（全量）

本次运行实测（节选）：

```text
✓ PASS  核心工具与存储     core.test.mjs             25 通过 / 0 失败
✓ PASS  查重模块          dedupe.test.mjs           59 通过 / 0 失败
✓ PASS  桌面端            desktop.test.mjs         154 通过 / 0 失败
✓ PASS  下载路由（排行榜 / 账号资料）  download-routes.test.mjs  75 通过 / 0 失败
✗ FAIL  下载模块（全离线）   download.test.mjs        168 通过 / 1 失败
    → createLimiter 相邻两次至少间隔约 minIntervalMs（实测 133/0 ms）
✓ PASS  端到端集成（真 HTTP） integration.test.mjs     67 通过 / 0 失败
✓ PASS  漫画库扫描器        library.test.mjs          24 通过 / 0 失败
✓ PASS  索引读取与阅读进度   reader.test.mjs           16 通过 / 0 失败
✓ PASS  前端页面模块        ui-smoke.test.mjs         54 通过 / 0 失败
✓ PASS  管理台（标签与整理） vault.test.mjs           54 通过 / 0 失败

总计: 696 通过 / 1 失败  ·  用例文件 9 通过 / 1 失败
```

唯一的红点落在 `download.test.mjs`，原因与证据见下一节。**本任务新增的文件 75/0 全绿。**

---

## 4. 未解决项（如实说明）

### 4.1 全量套件里 `download.test.mjs` 的失败与本任务无关（需归口人处理）

`tests/download.test.mjs` 在本会话期间被**并行同事实时编辑**：我开工读取时该文件 **927 行**，收尾时已是 **1238 行**（`(Get-Content tests/download.test.mjs).Count`）。
期间它出现的失败项（同一文件、非我改动范围）：

```text
→ createLimiter 相邻两次至少间隔约 minIntervalMs（实测 154/0 ms）      ← 计时断言，偶发
→ 20 条并发 recordPage 全部落盘（同 taskId 写串行） | 实际=19 期望=20   ← 新增组（本会话新出现）
→ 用例异常: TypeError: Cannot read properties of undefined (reading 'at')
   at Module.default (.../tests/download.test.mjs:998:160)             ← 新增组（本会话新出现）
```

**决定性证据**：完全不加载我的测试文件、只跑既有文件

```powershell
node tests/run-tests.mjs download.test   # 文件名子串过滤，不会加载 download-routes.test.mjs
```

连跑两次均为 **186 通过 / 2 失败**，失败项就是上面的 `recordPage` 与第 998 行 `TypeError`；
更早一次同一命令也曾出现 `createLimiter …（实测 133/0 ms）`。
即：该文件在不经过我任何代码的情况下已经红。我未修改、也不会修改该文件（不在写入范围）。

### 4.2 文档同步

- `docs/DOWNLOAD_SOURCES.md`：**其中没有 HTTP 路由清单**（只有适配器方法表与结构定义），
  因此任务书第 6 条的「若有则同步」条件不成立，未改动该文件。
- `docs/modules/download.md` 的「1. 接口一览」目前还没有这两条新路由。该文件不在我的写入范围（另有同事在改），
  建议由它当前的归口人补上：

```text
GET  /api/download/leaderboard?tt=H24|D7|D30&ct=VC&page=1
GET  /api/download/profile
```

### 4.3 环境说明

- 测试全部 `listen(0)` 随机端口，未占用 8775；未启动 GUI 进程；未按进程名杀 node；未运行 `scripts/dev/verify-all.mjs`。
- 未安装任何 npm 依赖、未新增构建步骤。

---

## 5. 复现清单

```powershell
cd C:\Users\D-001\Desktop\黄漫\MangaVault
node tests/run-tests.mjs download-routes   # 期望：75 通过 / 0 失败
node --check src/modules/download/index.mjs
(Get-Content tests/download.test.mjs).Count # 若再变，说明同事仍在编辑
```
