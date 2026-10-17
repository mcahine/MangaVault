# 本轮修复进度（Lead 直接执行）

> ⚠️ **本文档于 2026-10-16 00:04 被误清空后重建。**
> 原因为 Lead 执行一次误操作：本想在文件末尾追加内容，却用 `write` 传了空字符串，把 196 行正文整份截断为 0 字节。
> 该目录不是 git 仓库、无备份、无编辑器暂存，**原文不可恢复**。
> 下面是按当时的实测记录重建的版本：登录/缓存/桌面/滑动条/查重的结论同时保留在
> `AGENT.md` §11、`docs/team/t3-results.md`、`docs/team/dedupe-v6-plan.md`、`docs/team/note-scroll-rootcause.md` 里，可交叉核对。
> 教训：**向已有文件追加内容必须用 edit 锚定末行，绝不能对已有文件用 write 空内容。**

---

## 已完成并验证

### ① 登录失败 —— 真凶是两处污染，已修复并端到端验证通过

**根因 1：User-Agent 写错，触发哔咔风控。**
- 代码里写的是 `okhttp/3.12.13`，哔咔要求 `okhttp/3.8.1`（参考实现 `pica_client.rs:85` 为唯一真源）。
- 后果极具误导性：**公开接口**（`comics/leaderboard`）照样 200，**任何带 `authorization` 的接口**一律 `401 {"error":"1005"}`。
- 实测对照（同一 token、同一签名、同一 7897 代理）：

| 组合 | User-Agent | app-uuid | 结果 |
| --- | --- | --- | --- |
| A | okhttp/3.8.1 | defaultUuid | ✅ 200（真实账号 D-_） |
| B | okhttp/3.8.1 | 真 UUID | ✅ 200 |
| C | okhttp/3.12.13 | defaultUuid | ❌ 401/1005 |
| D | okhttp/3.12.13 | 真 UUID | ❌ 401/1005 |

→ 结论：**只有 UA 是变量**，app-uuid 无关。
→ 修法：`src/modules/download/api.mjs` 的 `PICA_USER_AGENT` 改为 `okhttp/3.8.1`，并附长注释记录本坑。

**根因 2：apiKey 被污染成伪造值。**
- 配置模板里曾写死一个 64 位伪造串，随 `deepMerge` 进了用户 `config.json`。
- 而官方真值 `C69BAF41DA5ABD1FFEDC6D2FEA56B` 是 **29 位**（不是 32）。
- 修法：`src/core/config.mjs` 的 `DEFAULTS.picacomic.apiKey` 改为空串（留空交回代码常量兜底）；`loadConfig()` 增加污染自愈（与真值不一致即清空）。

**端到端验证**（走真实 HTTP 路由 + 真实 7897 代理）：

```
POST /api/download/token  → 200 {"ok":true,"verified":true,"account":{"id":"601ce8e31735a48c8a30d648","name":"D-_",...,"title":"萌新","level":1,"exp":40}}
GET  /api/download/profile → 200 账号=D-_
GET  /api/download/proxy-test → 200 {"proxy":{"url":"http://127.0.0.1:7897","mode":"manual"},"result":{"ok":true,...}}
```

**附带修复**：`users/profile` 实测只返回 `_id,birthday,email,gender,name,title,verified,exp,level,characters,created_at,isPunched` —— **没有 avatar、没有 role**。
适配器改为 avatar 缺失回空串，并把 `title`（头衔，实测「萌新」）与 `verified` 一并带出；前端资料表把「角色」改成「头衔」，新增「认证」一行。

---

### ② 前端被持久缓存（解释了「桌面还在」与「滑动条没了」）

运行中实例的 `/api/modules` 早已返回 `desktop(nav:false)`、磁盘 app.js 与线上一致，但用户屏幕上仍有「桌面」导航、且旧 library.js 仍在使用 → **旧前端被缓存**。

**缓存漏洞的两处 bug 叠加**（`src/core/http.mjs`）：
1. 静态匹配处写 `serveFile(ctx, abs, { fallbackIndex: st.fallbackIndex })` —— **把 st 上的 `cacheSeconds: 0` 整个丢了**。
2. 即使传进来，原逻辑 `if (cacheSeconds > 0) setHeader('Cache-Control', ...)` —— **`cacheSeconds<=0` 时一个缓存头都不发**，浏览器退化成启发式缓存（按 Last-Modified 猜有效期）。

**修法**：选项全量透传 `Object.assign({}, st, {...})`；分支改为 `>0` 发 `private, max-age=N`，否则显式发 `no-store, no-cache, must-revalidate` + `Pragma: no-cache` + `Expires: 0`（ETag/Last-Modified/304 协商保留）。
实测 `/`、`/app.js`、`/modules/*.js`、`/theme.css`、`/modules/download.js` 全部 `no-store`，带 `If-None-Match` 仍返回 304。

---

### ③ 桌面组件从「页面模块」彻底移除

用户定位（原话）：「**不是 exe 显示桌面，是前端不加桌面这个组件，桌面端本来就是一种环境**」。

把模块拆成两类（`src/modules/index.mjs`）：
- `page: true` —— 前端页面模块，出现在 `/api/modules`，前端据此生成侧栏并动态 import；每个必须在 `public/modules/<id>.js` 有实现。
- `page: false` —— 能力模块，只往后端挂路由，前端看不到。

`MODULE_SPECS` 现状：library/reader/vault/download/dedupe 均 `page: true`；`{ id: 'desktop', path: './desktop/index.mjs', page: false }`。
`/api/modules` 改为 `loadedModules.filter(m => m.page !== false)`。
**实测**：页面模块 = `library, reader, vault, download, dedupe`（**无 desktop**）；`/api/desktop/state` 仍 200（exe 原生桥保持可用）；`/modules/desktop.js` 返回 404（符合预期）。
注：`src/modules/desktop/index.mjs` 仍保留 `meta.nav = false` 作为第二道防线，模块本身不能卸载（exe 宿主的长轮询 `/api/desktop/native/*`、窗口记忆、退出、开机自启都靠它）。

---

### ④ 滑动条「没了」的真相：滚动条一直存在，只是几乎看不见

真浏览器实测（headless Edge + CDP，1440×900）：`#content` 的 `overflowY: auto`、`scrollHeight 6743 > clientHeight 844`、`offsetW 1226 - clientW 1214 = 12`（**滚动条确实占 12px**）。
→ 根因是**配色对比度为零**：thumb `#2c2a36`(--ink-4) 叠在 track `#1b1a22`(--ink-2) 上，深色叠深色。

**修法**（`public/theme.css`）：track 提亮到 `--ink-3`(#23212b) + `border-left`；thumb 改用 `--line-2`(rgba(242,236,225,.34)) + `border: 2px solid var(--ink-3)` + `border-radius: 6px`；hover 变 `--red`；新增 `::-webkit-scrollbar-corner`。

**测试盲区修复**：`scripts/dev/ui-scroll-check.mjs` 从 6 条增到 **13 条**，新增真实滚轮事件、显式「加载更多」按钮通道、版本自检等断言 —— 它此前只验证「能滚」不验证「看得见」。

---

### ⑤ MV_PORT 契约（真缺陷）

`src/server.mjs` 原来只读 `config.port`，**完全忽略 `MV_PORT`** → 脚本用 `MV_PORT=8791` 拉起服务后去 ping 8791 永远超时。
**修法**：`const envPort = Number(process.env.MV_PORT); const port = Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : (config.port || 8775);`（优先级 MV_PORT > config.port > 8775）。
另：**显式 MV_PORT 时跳过单实例检查**（否则第二实例读到 8775 上运行中的锁就打印「漫库已经在运行」并 exit(0)，根本没监听目标端口）。

---

### ⑥ 排行榜/搜索/收藏 502 —— 签名丢 query

**根因**：`src/modules/download/api.mjs` 的 `signPath()` 曾把 query 剥掉再参与签名：

```
const i = s.indexOf('?'); const clean = i >= 0 ? s.slice(0, i) : s;   // 旧实现：剥掉 query
```

而参考实现 `pica_client.rs:429` 的 `create_signature(path, method, time)` 收到的是**含 query 的完整路径**（调用点 `pica_client.rs:379` 为 `format!("comics/leaderboard?tt={rank_type}&ct=VC")`）。
**为何难查**：上游对签名错误**不报错**，只回 `HTTP 200 {"code":200,"message":"success"}`（41 字节、无 data）。不带 query 的端点完全正常，第一反应永远是「接口结构变了」。

**修法**：`signPath()` 只去前导斜杠、**保留 query**。修复后排行榜 21751 字节 / 搜索 10909 字节 / 收藏 8216 字节，三个此前全灭的功能一并恢复。

---

### ⑦ 图片链路（封面/头像全裂图）

三个真缺陷：
1. `buildTargetUrl` 不接受绝对 URL → 配了代理的机器封面**必然全失败**（`Invalid URL`）。修法：先 `^https?://` 直接 `new URL(rel)`。
2. 传输层不跟随 3xx：哔咔图片 CDN 回 301，真图在 Location；不跟随就拿到 194 字节 HTML 且 301<400 不算失败 → **「下载成功但存的是 HTML」**。修法：`withRedirects(send)` 包装，301/302/303 降级 GET，307/308 保留方法。
3. 前端用 `url.indexOf('//') > 0` 判封面地址，而本站代理地址 `/api/download/cover?path=https%3A%2F%2F...` 字面没有连续 `//` → **所有卡片永走占位分支**。修法：新增 `isCoverUrl()` 认 `^https?://` / `^//` / `^/`。

附带：`/api/download/cover` 支持远程封面（后端经代理取回转发），带域名白名单 + 10 分钟内存缓存。

---

### ⑧ 长任务看护：桌面上跑查重不再自己关窗（T5）

**症状**：桌面宿主每 3 秒 `GET /api/ping`，连续 4 次拿不到就 `Dump("SERVERDEAD")` 收摊 —— 而查重指纹构建/全库重扫期间后端是**单线程忙**，ping 必然超时。用户看到「跑查重时桌面窗口自己关掉了」。

**修法**：新增 `src/core/heartbeat.mjs`（零依赖）。长任务开始写 `backend-silence.json`（绝对时间戳 `until`），宿主 `BackendBusy()` 读到有效窗口即跳过死亡判定，响应结束 `releaseSilence()` 把窗口收窄到 1 秒。
两条铁律：① 进程真退出（`ServerHasExited()`）必须无条件收摊；② 只读接口绝不声明静默，否则会掩盖真死。
验证：`tests/heartbeat.test.mjs` 32 条 + `scripts/dev/host-busy-check.mjs` 13 条。

---

### ⑨ T3 查重提速 · 收官（线程池改造，本轮最重要的性能改进）

| 链路 | 改造前 | 改造后 | 提速 | 目标 |
| --- | --- | --- | --- | --- |
| 全库指纹（lib，63395 张） | 14.14 分钟（进程池） | **7.60 分钟**（线程池 12） | **1.86x** | 目标 6 分钟，仍差 1.6 分 |
| 查重侧指纹（dup，12507 张） | 7.41 分钟（进程池） | **4.67 分钟**（线程池 12） | **1.59x** | 目标 2 分钟，仍差 2.7 分 |
| 像素比对（140 单元） | 154.1 秒（单线程外推） | **30.1 秒**（6 worker_threads + SAB） | **约 5x** | 目标 30 秒 ✓ |

**根因：并发模型选错了（不是硬件天花板）** —— Pillow 的 JPEG（libjpeg-turbo）/ WebP（libwebp）解码**在 C 层释放 GIL**，线程真能并行。
交替 A/B（同样本两方案轮流跑取中位数）：库侧进程池 2.08x → **线程池 3.45x**；查重侧 2.70x → **3.70x**。线程数扫描 **12 线程双侧最优**。
我此前断言「≤6 分钟在 4 物理核上不可达」并写进报告，**该结论已被实测推翻**（错误前提是「只能多进程并行」）。

**正确性闸门（比速度更重要）**：线程池产物与进程池产物**逐字节比对** —— 1236 个 `.bin` 指纹**全部相同（相同 1236 / 不同 0 / 缺失 0）**，`index.json` 亦相同。

**仍未达标的原因**（如实记录）：库侧 68% 的 JPEG 是 progressive（`draft` 只有 2.19x，baseline 有 3.72x）；dup 侧 12700 张里 8128 张是 webp（`draft` 对 webp 完全无效，单张 66.8ms）。

---

### ⑩ 查重删除后前端仍展示已删漫画（真因：删除请求被 400 拒绝）

**现场证据**（用户桌面端日志）：

```
POST /api/dedupe/delete -> 有 2 个单元目录已不存在（可能已被删除或移动）：「世界の終わりックス」をしよう、～シスタークレアと淫らな秘密と噂の催眠アプリ～ フルカラー 総集編
```

用户**先删成功过、目录已从磁盘消失**，再点删除必然撞上 `allowMissing` 守卫 → **HTTP 400，什么都没发生** → scan-latest 不回写 → 卡片永远留着 → 前端一直请求已不存在的缩略图（日志里满屏 `文件不存在`）。

**修法**（语义：目录已不存在 = 早就删掉了，按「已删除」收尾，不是报错）：
1. `src/modules/dedupe/index.mjs` 删除路由传 `allowMissing: true`。
2. `applyDeleteToScan` 的 `doneIds` **纳入 skipped**（原先排除 skipped，导致这类单元照样留在列表里）。
3. 新增 `GET /api/dedupe/units?deleted=1` 才包含已删单元；默认列表 + 前端第 214 行都过滤 `decision === 'deleted'`（双保险）。

**验证**：`scripts/dev/dedupe-delete-e2e.mjs` 扩到 **23/23 通过**，新增「目录已不存在时删除」：HTTP 200（不再 400）、`skipped=1 failed=0`、列表与统计都不再含该单元、重复删除幂等。

---

### ⑪ 「一点重新扫描程序就崩」——两条链路误判，不是 OOM

**关键证据：内核日志（`mangavault.log`，1154 行）里没有任何崩溃痕迹。** 全程只有一条 ERROR（08:27 模块加载失败，与本次无关）；扫描期间无异常、无 out of memory、无堆栈。Windows 事件日志也没有 node.exe 崩溃、没有资源耗尽（2004）。

**时间线**（决定性的 60 秒）：

```
14:47:57.743 [dedupe] 进入长任务静默窗口（完整扫描）
14:47:57.747 [dedupe] 启动扫描: full
14:48:15.950 [desktop] 窗口已关闭（CDP 目标消失）              ← 扫描开始仅 18 秒
14:48:20.172 WARN 仍有 12 个窗口进程存活，内核保持运行以免读数丢失  ← 自相矛盾：它自己发现窗口还活着
14:48:57.321 WARN 发现陈旧锁文件（pid 20004 已不存在），将重新启动内核
内核日志在 14:47:57 之后再无任何一行
```

**根因 A（误判关窗）**：`desktop/sysinfo.mjs` 把**探测失败**（PowerShell 超时，尤其在 CPU 被打满时）等同于**窗口已关闭**。启动器据此判定「用户关窗」→ 收尾 → `process.exit`。
**根因 B（内核随启动器一起死）**：`desktop/app.mjs` 的 `spawnServer` 用 `detached: false` + `stdio: ['ignore','pipe','pipe']`。矩阵实验：

| 组合 | 内核是否存活 |
| --- | --- |
| detached:false + ignore | ✗ 死（随父进程树连带终止） |
| detached:true + **pipe** | ✗ 死（父退出后管道断，内核下次写日志 EPIPE 自杀） |
| **detached:true + 文件句柄** | **✓ 存活，/api/ping 200** |

**修法**：
1. `sysinfo.mjs` 新增 `cdpProbe()` / `appWindowProbe()`，返回 `{ok, list}`，**严格区分「探测失败」与「目标确实为空」**；命令成功但输出为空也按失败处理。
2. `waitForCdpClosed` 探测失败一律 `continue`，并要求**连续 2 次**「探测成功且目标不在」才返回 `closed`；探测超时放宽到 6 秒。
3. `listAppWindowProcesses` / `waitWindowClosed` 同样区分失败。
4. `spawnServer` 改 `detached: true` + `child.unref()` + 控制台输出重定向到 `data/kernel-console.log`（文件句柄，不再用管道）。
5. 收尾守卫：探测失败时**保留内核**并告警，绝不因「探测不到」就收掉。
6. CDP 判 `closed` 后**再用进程探测交叉复核**。

**验证**：探测矩阵探针 5/5（超时/空输出均 `ok=false`；持续超时返回 `unsupported` 而非 `closed`；目标真不在才 `closed`）；真实启动器 E2E —— 杀掉启动器后**内核仍存活**、`/api/ping` 200；`tests/desktop.test.mjs` 新增 15 条 → **169 通过 / 0 失败**。

---

### ⑫ 启动漫库.bat：cmd 报错修复 + 精简

**报错**（用户原始输出）：

```
'掉它不影响漫库（内核由后台窗口托管）' is not recognized as an internal or external command,
operable program or batch file.
```

**真根因**：文件是 **UTF-8 无 BOM**，而双击时 cmd.exe 用的是**控制台启动码页 936** 去解码批处理行。这个「字节→再解码」有损，会把一行拆成「前缀 + 后半当命令」，前面几行还会整个消失。
**修法**：转成 **GBK/cp936 无 BOM** + `chcp 936`。（UTF-8 带 BOM 更糟：首行变 `\ufeff@echo off`。）
**坑中之坑**：在 pwsh（控制台码页恰好 65001）里测不出问题，**双击才炸** —— 验证必须在新建 cmd 控制台里做。

**精简**：25 行 → 20 行，去掉全部横幅/说明/排障文案/末尾 pause，新增 `启动漫库.vbs` 走无控制台启动（`start "" wscript.exe`），无 VBS 时回退 `node desktop\app.mjs`；Node 缺失分支保留（VBS 会无声失败，只有 .bat 能给中文提示）。
**同类审计**：全仓库 4 个 .bat，`_archive/picacg处理/` 下 3 个（启动查重模块/重建全库指纹/重新扫描）同样是 UTF-8 含中文，**已一并转为 GBK**（原文件留 `.bak-utf8`）。

---

## 当前基线（冻结态实测）

- `node tests/run-tests.mjs` → **1088 通过 / 0 失败**（12 文件）
- `node scripts/dev/dedupe-delete-e2e.mjs` → **23/23 通过**
- `node scripts/dev/verify-all.mjs` → **10 通过 / 0 失败 / 0 跳过，退出码 0**（用时 266.0s）
  - 单元+集成 1088/0 · vault 28/0 · 滚动 13/13 · 宿主忙闲 13/13 · dist 一致 98 文件 · 阅读器 9/9 · 下载页签 38/38 · 管理台 28/28 · 孤儿竞态 0 例 · exe 自检 16/0 · 工程卫生 61/100 高危 0（参考）
- dist 重建：`MangaVault.exe` 73 KB、app/ 98 文件、合计 1.9 MB

## v7 快速查重（已落地并验收）

用户诉求（m02969 原话）：「看看能不能通过减少查重工作量来加速查重速度，查重可以不用全量，找到图片相似和对得上的，交给人眼进行对比…你这又是像素级别对比，又是哈希检索，又是全库指纹，我漫画多了后查重慢得要死，而且量大还要崩溃」。
规划：`docs/team/dedupe-v7-fast-plan.md`（三级漏斗 + 人在环判定 + 系统绝不自动删除）。

**结论：快速查重端到端 14.0 秒（完整扫描约 13 分钟），候选 11 个，在磁盘上的已知重复 3/3 全部命中。**

| 指标 | 验收口径 | 实测 |
| --- | --- | --- |
| 端到端耗时 | ≤ 60 秒 | **14.0 秒** |
| 候选单元数 | ≤ 20 | **11 个** |
| 已知重复命中 | 全部 | **磁盘上 3/3**（另 2 组已被用户删除，正确跳过） |
| 是否自动删除 | 绝不 | 新增 deleted 决策 **0** 条 |
| 完整扫描回归 | 不回归 | `scan-latest.json` 内容 sha256 前后一致 |

两级数据分离：快速模式写 `scan-fast.json`，完整扫描写 `scan-latest.json`，**互不覆盖**。

### 落地的代码
- `src/modules/dedupe/engine/prefilter.mjs`（新）：标题 Dice 系数（≥0.35）+ 页数容差（≤5%，下限 3 页）双信号预筛。
- `src/modules/dedupe/engine/pipeline.mjs`：新增 `runFastStage`，以及 `computeCoverageOf`（**按自然序号配对**，库侧多一张封面错位一位也照样命中）、`loadCandidateFingerprints`（只读候选章节的 `.bin`）、`isCandidateWorth`、`buildFastSamples`（整章等距抽样）。
- `src/modules/dedupe/engine/runner.mjs`：`STAGES` 首位加 `fast`，`STAGE_LABEL.fast = '快速查重（元数据预筛）'`。
- `src/modules/dedupe/index.mjs`：`GET /api/dedupe/candidates` 返回候选 + 多张并排抽样图 + `fastInfo`/`fastDegraded`；`POST /api/dedupe/delete` 的可删除集合并入「快速查重里标记 delete 且磁盘上真实存在」的单元（否则快速模式命中的项会「标记了却删不掉」）。
- `public/modules/dedupe.js`：新增「快速查重」按钮与候选复核视图，判定徽章含快速模式专用的「待人工复核」；按钮上标出耗时预期。

### 本轮新修的两个真缺陷（都由测试/验收逼出来）
1. `loadCandidateFingerprints` 的 `if (wanted.size && !wanted.has(...)) continue`：**空候选列表会退化成「不过滤」= 读整库 1236 个指纹**（约 19 分钟的重税），正是 v7 要消灭的东西。修法 `if (!wanted.size) return null;`。
2. 测试替身缺 `linv/lnrm` 字段 → `zMadOf` 抛 `TypeError`。教训：测试对象必须与真实工厂逐字段对齐，或直接走真实装载路径。

### 验收命令
- `node scripts/dev/check-fp-lib-index.mjs` → 指纹索引自检通过（1236/1236）
- `node scripts/dev/dedupe-fast-e2e.mjs` → **22 通过 / 0 失败**（走真实 HTTP 路由 + 真实用户数据）
### 队友复核与两处连带修复（v7 收尾）

子代理 B（1dca59f3…）接手审计我先前写好的 `pipeline.mjs`/`runner.mjs`，报出两条**我漏掉的真缺陷**，我已逐条复核并保留：

1. **库根解析错**：`comicDirOf` 只认 `comic.rootId`，而真实 `library-index.json` 的 266/266 部漫画都**没有** `rootId`、只有 `root`（根 id 字符串）→ 非首个库根（`early` 先期漫画）的作品章节目录全部拼错、**图片零命中且被静默漏掉**。修法：`rootById.get(comic.rootId || comic.root || '')`。
2. **指纹目录未隔离（最严重）**：`build-fp.py` 第 278 行**无条件**把本次 index 写进 `<libFp>/index.json`，而完整扫描的重建判据只是 `existsSync(fpLib/index.json)`。快速模式直接写真实 `paths.fpLib` 会把 1236 条的索引覆盖成十几条 → 之后完整扫描误判「指纹还在」而跳过重建，**静默退化成只比候选章节**。修法：快速模式改用独立目录 `dedupe/tmp/fp-fast-lib` 与 `fp-fast-dup`，真实目录只读不写。

两处都不是「风格问题」，而是**会让结果静默错误**的缺陷，因此尽管它们出现在我先前写的代码里，也照样采纳并写进 `AGENT.md` §11。

**连带修复（已实测）**：真实 `%LOCALAPPDATA%\MangaVault\dedupe\tmp\fp-lib\index.json` 在本轮之前已被写成 **12 条**（目录里有 1236 个 `.bin`），属历史污染。为避免用户下次点「完整扫描」时白等或误判，新增两支脚本：

- `scripts/dev/check-fp-lib-index.mjs` —— 只读自检「索引条数 vs `.bin` 数量」，不一致即报失败（`fp-dup` 按设计没有索引，只报信息）。
- `scripts/dev/repair-fp-lib-index.mjs` —— 用项目自己的 `collectLibJobs()` 重新生成索引，**只重写 `index.json` 一个文件，1236 个 `.bin` 一个字节都不动**。

实测：修复前 `index 条数=12 / bin=1236` → 修复后 **`1236 / 1236` 一致**；自检输出「指纹索引自检通过」。

**完整扫描不回归（实测）**：新增 `scripts/dev/fullscan-regress.mjs`，在**隔离数据副本**（`%TEMP%\mv-fullscan-regress`，复制了 config / library-index / scan-latest / hash-result / decisions 与 1236+140 个指纹，79.8 MB）上真跑一次 `stage=pixel`：

| 断言 | 结果 |
| --- | --- |
| 隔离副本全库指纹索引完整 | 1236 章 ✓ |
| 扫描无报错、正常结束 | 265 秒、`error=""` ✓ |
| 产出单元数 | 140 ✓ |
| **扫描结束后指纹索引仍完整（未被改写）** | **1236 vs 1236 ✓**（这是隔离修复的关键证据） |
| 不得出现「历史命中、本次没命中」的退化 | 退化 0 个 ✓（历史 scan-latest 是 T2 改算法之前的产物，本次命中更多属正常） |
- `node tests/run-tests.mjs` → **1250 通过 / 0 失败**（14 文件）
- `node tests/run-tests.mjs dedupe-fast` → 44 通过 / 0 失败
- `node scripts/dev/verify-all.mjs` → **10 通过 / 0 失败 / 0 跳过，退出码 0**（298.7s）
  - 单元+集成 1250/0 · vault 28/0 · 滚动 13/13 · 宿主忙闲 13/13 · dist 一致 100 文件 · 阅读器 9/9 · 下载页签 38/38 · 管理台 28/28 · 孤儿竞态 0 例 · exe 自检 16/0 · 工程卫生 64/100 高危 0（参考）

## 已知缺口 / 未做

1. 全库指纹 7.60 分钟（目标 6）+ 查重侧 4.67 分钟（目标 2）**未达标**；根因是 progressive JPEG 与 webp 拿不到 `draft` 收益（详见 `docs/team/t3-results.md` §8）。**但日常已不必再跑完整扫描 —— 快速查重 14 秒即可覆盖「标题/页数对得上」的重复。**
2. `--with-node` 绿色包仍未在无 Node 机器上验证。
3. PDF 导出未做。
4. 工程卫生分数偏低，主要由超大文件拉低（`vault.js`、`download.js` 上千行）。
## 收尾补充（本轮）

- `scripts/dev/fullscan-regress.mjs` 判据修正为「不得退化」后重跑 → **9 通过 / 0 失败**（第二次 32 秒，指纹索引 1236/1236 未被改写；本次命中 cov>=0.3 的单元 40 个 vs 历史 0 个、退化 0 个）。
- `scripts/dev/verify-all.mjs` 新增第 6 项 **「指纹索引自检」**（`check-fp-lib-index.mjs`，60 秒超时），把「index.json 被覆盖」这个静默缺陷钉进常驻验收；总验收因此变成 11 项（+工程卫生参考项 = 12 行）。
## 候选复核 × 删除 一致性（真缺陷修复，已验收）

用户可见症状：**在候选页点「确认重复并删除」后，那张卡片还在**（甚至可再点一次删除）。

根因链：

1. v7 设计里快速查重写 `scan-fast.json`、完整扫描写 `scan-latest.json`，**互不覆盖**；而删除只回写 `scan-latest.json` → 候选页（读 scan-fast.json）看不到变化。
2. `POST /api/dedupe/decision` 只认 `findUnit(scan-latest, id)` → 快速模式候选点三选一律 400「单元不在最近一次扫描结果里」。
3. `POST /api/dedupe/delete` 原来 `if (!scan) 400` → 从没跑过完整扫描的用户点删除直接失败。
4. 候选页只读 `scan-fast.json` → **先跑完整扫描**（留下命中在 scan-latest.json）的用户，候选页是空的。

修复（`src/modules/dedupe/index.mjs` + `public/modules/dedupe.js`）：

- 候选 = 快速结果 ∪ 完整扫描里 `judge !== '未找到'` 的单元（按 id 去重，快速优先）；按 `isDeletedUnit` 过滤并如实返回 `hiddenDeleted`。
- `decision` 与 `delete` 两条路由都改为「完整扫描 ∪ 快速结果」双来源；快速项的删除路径一律 `path.join(paths.scanRoot, id)` 现拼（不沿用快照里的旧路径，否则换过 scanRoot 会「路径越界」）。
- `applyDeleteToScan` 同步回写 `scan-fast.json`；前端 `renderCandidates` 追加 `deleted` 过滤兜底、`submitDelete` 后刷新候选列表。

验收（全部实测）：

- `node scripts/dev/dedupe-cand-delete-e2e.mjs` → **15 通过 / 0 失败**（2.9s，隔离副本真删 + 真还原）。
- 真实数据只读核对：历史已删除 2 个单元**没有出现在候选页**；候选 42 = scan-fast 11 ∪ 完整扫描命中。
- `node tests/run-tests.mjs` → 1250 通过 / 0 失败（14 文件）。
- `verify-all` 新增第 12 项 key=`canddel`「候选复核删除一致性」（120 秒超时）→ 单跑 1 通过 / 0 失败。
### 真浏览器验收抓到的第二处断链（原接口级 e2e 漏诊）

新增 `scripts/dev/dedupe-cand-ui-check.mjs`：CDP 真浏览器按用户路径点击，全程在 `%TEMP%` 隔离数据目录里操作自造的 4 字节假图片，**不碰真实漫画**。

首跑 **5 通过 / 5 失败**，报出：候选页点「确认重复（可删）」落盘成功，但打开「执行删除…」弹窗后 `下一步：输入 DELETE` **按钮是 disabled**（文案「当前页没有标记为待删除的单元」）→ 删除链路根本走不到。

根因：`public/modules/dedupe.js` 的 `openDelete()` 只从主列表 `st.data.units` 里挑 `decisionOf(u) === 'delete'`，而**只跑过快速查重**（十几秒那条路径）的用户，决策落在候选页（`st.candData`，数据源 `scan-fast.json`），主列表里没有这个单元。

修复：`openDelete()` 改为按 id 合并 `st.data.units` 与 `st.candData.candidates` 两处来源；并新增 `syncDecisionToMainList(unitId, verdict)`，候选页做三选时同步标注主列表同 id 单元（否则主列表卡片仍显示「未定」）。

复跑 **10 通过 / 0 失败**，关键断言：候选卡片 2 张 → 确认重复 → 提交 DELETE → 候选列表 2→1、被删单元不再出现、隔离目录里该单元目录 `existsSync=false`。

已入册 verify-all「候选复核删除(真浏览器)」（key=`candui`，180 秒超时，实测 38.6s / 10 通过 / 0 失败）。

## 库格式正规化（C:\Users\D-001\Desktop\发布\哔咔 → L2 规范形态）

用户请求：「把 C:\Users\D-001\Desktop\发布\哔咔 里的漫画进行格式正规化」。该目录同时是配置里的 `dedupe.scanRoot`（查重根），属真实数据破坏性操作，按项目惯例先只读盘点 → dry-run → 报批 → 执行。

**盘点**：95 个顶层目录，全为 L0 裸形态（图片直接躺在漫画目录下），5920 张图 / 4.66 GB；31 部用 8 位零填充命名，64 部用 `TG@BGG_Home_0001.jpg` 风格；95/95 都带 `.ehviewer` / `.thumb` / `.txt` 等杂物；0 部有 元数据.json。

**执行**：`node scripts/normalize-dir.mjs --dir=... --apply`。结果：95 部全部转为 `元数据.json` + `<漫画>/1 第1話/图片` 的 L2 形态，失败 0 部，杂物全部移入备份目录（移动不删除），并留下 manifest 对照表可回滚。复跑 dry-run 95/95「跳过／已是规范形态」，幂等性确认。

### 正规化暴露的三处真缺陷（均已修复）

正规化把查重单元从「裸形态」变成「嵌套形态」，把一串只在嵌套形态下才成立的假设全打穿了：

1. **单元 id 在嵌套形态下互相覆盖**（`src/modules/dedupe/engine/scan.mjs:379`）
   章节目录是 `<漫画>/<序> 第1話/`，若 id 只取目录名，一部漫画的每一章都叫「1 第1話」。实测 95 个单元 id 唯一性 = **false**，指纹文件 / 人工决策 / 删除目标全部串台。修法：`const id = (rel && rel.indexOf('/') >= 0) ? rel : baseNameOf(rel);`。
   ▸ 我第一版改成了「祖先目录里有没有 元数据.json」这种更聪明的判据，**实测直接反了**（95 个单元全部退回目录名口径、唯一性仍为 false，因为「直接含图就 return」走不到那一层），同时打红既有测试 `tests/dedupe.test.mjs:54`。已回退为斜杠判据。
2. **预筛取整条 id 算标题相似度 → 95 个单元全部 0 候选**（`engine/prefilter.mjs:155`）
   `/1 第1話` 这段公共后缀把 Dice 严重稀释（`ごちそうさま` 与库侧 `ごちそうさま 謝謝招待 無修正` 从 0.588 压到阈值 0.35 以下）。修法：新增 `comicTitleOfUnit(id)` 取第一段。
3. **指纹缓存 key 按会变的 id 定位**（`engine/build-fp.mjs` 的 `collectDupJobs`）
   `build-fp.py` 的增量签名只认 mtime + 总字节 + 张数，id 一变（改名）整批缓存便被判「必须重建」，12 万张图白跑约 5 分钟。修法：改用 `keyOf(u.dir || u.id)`，读取侧三处（`match.mjs` 串行分支、`pixel-worker.mjs`、`pipeline.mjs` 快速模式）同步改。

### 连带放宽的两处校验（同一口径变更的下游）

- `POST /api/dedupe/delete` 原来 `if (id.indexOf('/') >= 0) continue` → **快速查重查出来的重复一个都删不掉**。改为禁 `..` / `../` 前缀 / 盘符 / 反斜杠越界。
- `GET /api/dedupe/thumb` 的 dup 侧原来用 `isPlainFileName(name)` → **所有嵌套单元的左半边抽样图 404**。改为 `isSafeRelPath(name)`，越界仍由 `safeJoin` 兜底。

### 修复后实测（真实数据）

| 项 | 结果 |
| --- | --- |
| 单元发现 | 95 个单元，**含斜杠 95 / 95，id 唯一性 true** |
| 快速查重预筛 | 有候选单元 1（即 `小悪魔ちゃんのこうげき！ 7/1 第1話` → 库侧 `姉ちゃんの友達`，judge=部分重复，cov 0.484） |
| 快速查重端到端 | **17 通过 / 0 失败** |
| 真浏览器候选删除链路 | **10 通过 / 0 失败** |
| 全量测试 | **1325 通过 / 0 失败**（15 文件） |

### 验收脚本的假失败修复（教训）

`dedupe-fast-e2e.mjs` 原写「仍在磁盘上的已知重复组 >= 3」、`dedupe-cand-ui-check.mjs` 原写「真实候选不足 2 个就抛错」。用户已把 T2 阶段确认过的 5 组重复**全部删掉**，于是这两条断言随功能的正常使用而变红。已改为「有几组验几组，0 组时断言『已删除的项不得再出现在候选里』」；UI 脚本在候选只有 1 个时在**隔离目录**里克隆一份副本凑数，真实数据一个字节不动。**断言要测行为，不要测样本存量。**

---



## verify-all 第 3 步假红：验收脚本连了用户的旧实例（2026-10-17）

现象：`node scripts/dev/verify-all.mjs` 第 3 步「浏览器滚动检查」45.7s 失败，12/13 —— 唯一红的是

```
✗ 页面实际字节与后端报的前端指纹一致（不是缓存的旧脚本）
  ({"want":"23be09c4","got":"5aafa00c","ok":false,"frontend":"b2a463c4","backend":"94267380"})
```

单独重跑同一脚本却是 13/13 通过 —— 典型的「只在某个环境下红」。

根因：`scripts/dev/ui-scroll-check.mjs` 默认 `--port=8775`，`verify-all.mjs` 也显式传 `--port=8775`；而 8775 上跑着**用户自己启动的旧实例**（pid 22728，2026-10-15 19:13 启动，加载的是旧前端）。页脚读到的 `frontend=b2a463c4` 就是那个旧版本，而脚本下载 `app.js` 算出的哈希是磁盘上的新版本 → 两者当然不一致。**这条断言其实是正确的，它准确指出了「服务器在跑旧代码」，只是被当成了功能回归。**

修法（三层，全部已落地）：

1. `ui-scroll-check.mjs`：`--port` 默认改为 `0` → 自己 `freePort()` 取空闲端口；起服务时带隔离 `MV_DATA_DIR`（新建 `buildIsolation()`：把真实 `config.json` 与 `library-index.json` 拷进 %TEMP% 下的隔离数据目录，**库数据只读**）；源码里显式 `if (realPort === 8775) { 报错退出 }`。
2. `verify-all.mjs`：调用该脚本时**不再传 `--port=`**，超时 240s → 300s。
3. `tests/desktop.test.mjs`：新增契约断言 —— 脚本必须含 `MV_DATA_DIR`、`function freePort()`、`realPort === 8775` 拒绝分支，不得再出现 `const port = arg("port", "8775")`；`verify-all.mjs` 调用行不得含 `--port=`。桌面测试 200 → **217 通过 / 0 失败**。

修完单跑：`node scripts/dev/ui-scroll-check.mjs` → **13/13 通过**，版本自检 `{"want":"5aafa00c","got":"5aafa00c","ok":true}`，隔离数据目录 `%TEMP%\mv-scroll-<ts>\data`。

**教训**：「服务版本」与「代码版本」是两个独立变量，自动验收必须把它们钉在同一个进程里；凡是验收脚本，一律自带隔离数据目录 + 随机端口，绝不连用户实例。


### 总验收第二轮：桌面启动器验收偶发红（16 → 17 条）

第二轮 verify-all 第 14 步「桌面启动器验收」15/1 失败，唯一红的是「屏幕外的记忆尺寸仍然沿用（1280x800）」。单跑同一脚本必绿。

根因：该断言写的是「日志里 `窗口参数：` 那一行必须含 `--window-size=1280,800`」，而启动器**发现同数据目录已经有 App 窗口时会走 `sameTarget` 分支、根本不开窗**（`desktop/app.mjs:325-327`），于是压根不打「窗口参数：」这一行 —— 断言测的其实是「这次有没有走开窗分支」这个与尺寸无关的偶然事实。

修法：改成两条盯着属性本身的断言 —— ①窗口记忆写回时 `width/height` 仍是 1280x800（尺寸被保住的直接证据）；②**若**本次确实开窗，则参数行必须带该尺寸（未开窗时跳过并打印原因）。启动器验收 **16 → 17 条，实测 17 通过 / 0 失败**。

## 阅读器：翻页条锁定 + 卡顿/预加载优化（用户 2026-10-17）

用户原话（m04591）：「给阅读器这个组件加个功能，不到这个位置就不显示这个条，可以锁定，但是默认不锁定」「阅读器还要优化下，提高阅读体验，漫画看的时候会卡顿，大概就是没有做好预加载吧」。

### 一、翻页条（.reader-pagebar）

| 行为 | 实现 |
| --- | --- |
| 默认不锁定 | `barLock: false` —— 前端偏好默认对象与后端 `src/modules/reader/index.mjs` 的 DEFAULTS **两处都要加**，否则 POST /api/reader/prefs 的白名单会丢掉它 |
| 鼠标不动就淡出 | `HIDE_AFTER_MS = 2800` → `pagebar.classList.add("auto-hide")`，只降透明度 + 关指针事件，**不改布局**（display:none 会让舞台尺寸抖一下） |
| 鼠标一动就回来 | 挂在 shellNode 的 mousemove 上；翻页（goto）与按任意键（onKey）也会唤回 |
| 可锁定 | 工具栏新增带 `data-act="bar-lock"` 的图钉按钮（`app.js` ICONS 新增 `pin`），快捷键 **L**；锁定后常显，状态经 POST /api/reader/prefs 落盘，刷新/重启保持 |
| 缩略图条打开时不淡出 | `if (S.barLock || S.stripOpen) return;` |
| 顶栏与翻页条同步 | 共用同一个计时器，避免「顶栏回来了、翻页条还没回来」的错位 |

**踩到的真缺陷**：重写 `onMove` 时 `setBarVisible(true)` 只 `classList.remove` 了 `shellNode.bar-hidden` 与 `pagebar.auto-hide`，**漏了顶栏自己的 `bar.auto-hide`** —— 顶栏那一层没有恢复 `pointer-events`，真实鼠标事件点不到锁定按钮（验收脚本报「点锁定后 locked=false」，人眼则会以为按钮没反应）。已补：恢复时同时 `bar.classList.remove("auto-hide")`，隐藏时按 `prefs.autoHideBar` 决定是否给顶栏加。

### 二、卡顿 / 预加载

**根因（两条叠加，都只在条漫模式）**：

1. **没有占位高度**：`render()` 原来一次性把整章所有 `<img>` 塞进 DOM 且不写 width/height。浏览器必须**下载并解码完**每张图才知道尺寸，于是每加载一张就把后面全部内容重新挤一遍 —— 这就是「边滚边跳、滚到哪卡到哪」。用户真实偏好 `reader-prefs.json` 里是 `mode: webtoon`，必然撞上。
2. **预加载没有并发上限、也不分远近**：原 `preload()` 一次双向发起最多 16 个 `new Image()`，带宽被远处的图抢光，当前页反而在等。

**修法**：

- 新增 `src/core/image-size.mjs`（零依赖）只读**文件头 64KB**（认不出补读到 256KB）解析宽高：JPEG（含 progressive，逐段扫到 SOF，排除 0xC4/0xC8/0xCC）、PNG、GIF、WebP（VP8 / VP8L / VP8X 三种变体，含 14 位跨字节位拼接）。
- 新增 `GET /api/reader/sizes?comic=&order=`，返回与页码**等长且顺序一致**的数组（读不到的位保持 `null`，**绝不过滤** —— 过滤会让后面所有页的对应关系整体错位）。按「漫画+章节」内存缓存（32 条上限）。`order` 缺省取第一话，与 `/api/reader/chapter` 同口径。
- 前端条漫改成「**等高占位块 + 原地替换**」：`holderNode(i)` 用解析比例 × 舞台宽度写死 `height`（带页码水印）；图片按队列到达后 `swapIn(i)` 用等高的 `<img class="reader-img">` 替换占位块里的内容，高度不变 → 滚动位置不跳。
- `preload()` 重写为队列调度：`queueAround(idx)` 按「离当前页距离」由近到远（当前页永远第一），`pumpPreload()` 维持最多 `PRELOAD_MAX = 4` 个在飞请求，`preloadDone` 去重。
- 单页/双页也把解析出的宽高写进 `<img>`；窗口 resize 会重算占位高度（150ms 防抖）。

### 三、过程中揪出的三个真缺陷（都不是本次新引入的）

1. **`readLibraryIndex` 的并发竞态（阅读器偶发「漫画不存在」的真根因）**：`src/core/library-index.mjs` 原在 `await fsp.stat()` **之前**就推进 `cache.checkedAt`。于是「第一个请求正在读盘、第二个请求进来」时走 800ms 短路，直接返回**上一次的快照**；索引刚建好那一刻那次就是空快照。阅读器只发一个章节请求时从未暴露，新加的尺寸请求一上线就必现。修法：`let inFlight = null` 让并发请求共享同一次读取。已在 `tests/reader.test.mjs` 加回归断言，并**把实现临时换回旧逻辑验证过这条断言真的会红**，再恢复修复版。
2. **`GET /api/reader/sizes` 缺省 order 会平白多出两个 404**：前端为了让尺寸与章节数据并行，首次加载不带 order；路由原来直接 404「章节不存在：0」——真实浏览器里表现为 `Log error=2 条 / 4xx=2 条`。
3. **`setBarVisible` 漏恢复顶栏**（见上）。

顺带补的两条竞态防护（都是这次新引入的并行请求带来的）：**尺寸令牌** `let chapterSeq = 0`（回来时 `if (seq !== chapterSeq) return`，否则快速切章时旧章尺寸会覆盖新章）、**预加载代次** `let preloadGen = 0`（`preloadDone`/`preloadBusy` 是按页码索引的，换章后页码从 0 重来，旧章在飞的图会把新章同页码标成「已加载」甚至串页；换章时 `preloadGen++` 并清空两个集合）。

### 四、验收

| 项 | 结果 |
| --- | --- |
| `node tests/run-tests.mjs reader` | **59 通过 / 0 失败**（图片头解析 4 种容器 + 坏数据；`/api/reader/sizes` 顺序对齐与 404；并发读索引回归；前端/后端静态契约 20 条） |
| `node scripts/dev/reader-nav-check.mjs`（真浏览器） | **20/20 通过，退出码 0**（原 9 条翻页方向 + 新增 11 条：初始可见 / 2.8 秒淡出 / 鼠标唤回 / 锁定常显 / 锁定落盘 / 刷新保持 / 解锁 / sizes 接口 / 6 个等高占位块且无裸 img / 占位高度 / 预加载全部替换并解码） |
| `node tests/run-tests.mjs`（全量） | **1412 通过 / 0 失败**（15 文件） |

## 桌面启动器崩溃（用户 2026-10-16 22:48 双击 启动漫库.bat）

用户原话：「启动漫库.bat 启动不了，一启动就崩溃，然后那个桌面窗口怎么没清除掉」。
只读侦察结论：`启动漫库.bat`（GBK / 447 字节）与 `启动漫库.vbs`（纯 ASCII / 1253 字节）本身都没有崩溃点；真正的病灶有五个。

| # | 病灶 | 证据 | 修复 |
| --- | --- | --- | --- |
| A | 窗口被记忆成屏幕外坐标 | `desktop-window.json` = `{x:-32000,y:-32000}`，命令行 `--window-position=-32000,-32000`，实测窗口 pid 2400 rect(-32000,-32000) 1920x1027 可见但完全在屏外 | `lib.mjs` 新增 `POS_LIMIT=20000` / `posInRange`，`sanitizeWindow` 越界丢成 null、`buildAppArgs` 不拼非法位置；`shim.js` 最小化时不再上报 x/y；`src/modules/desktop/index.mjs` 的 `mergeWindowReport` 同样过滤 |
| B | 桌面日志用 UTC，对不上事故时刻 | 22:48 的启动在 `desktop.log` 里记成 14:48 | `desktop/log.mjs` 改本地时间拼接 |
| C | 崩溃无留痕 | 任何失败路径都不写退出码，vbs 只看 66 | `app.mjs` 新增 `recordExit()` 写 `data/desktop-exit.json`，三条退出路径全落痕 |
| D | 关窗误判 | 「探测失败」被当作「窗口已关闭」，随即收内核 → 用户看到「刚开就崩」 | `sysinfo.mjs` 改 `cdpProbe()/appWindowProbe()` 三态返回 `{ok,list}`，要求连续 `requiredMisses` 次「探测成功且目标不在」 |
| E | **启动器/窗口清不掉** | `waitWindowClosed` 与 `waitForCdpClosed` 第二段都是无退出的 `while(true)`，探测持续失败即永久挂住（实测 pid 11532 窗口早已关闭仍不退） | 两处加 `failLimit`（8 / 6），连续失败达上限返回 false / unsupported |

附带修复：①`desktop/app.mjs` 新增 `acquireLaunchGuard(dataDir/desktop-launcher.lock)` 单实例守卫（用户 22:47:59 与 22:48:01 双击两次 → 2 个 wscript + 2 个并发启动器，各开一个窗口）；②冒烟自检段包 `try/finally` 收内核（此前自检抛错会留下 detached 内核，实测泄漏 pid 13820/36528/19932）；③`app.mjs` 等窗口关闭分支补 `appWindowProbe` 交叉复核。

### 验收（全部实测）

| 项 | 结果 |
| --- | --- |
| 启动器验收 `scripts/dev/desktop-launch-check.mjs`（新增，已进 verify-all） | **13 通过 / 0 失败** |
| 预置屏幕外记忆后启动参数 | 不再出现 `--window-position=-32000,-32000`；自动居中到 320,125 并写回记忆 |
| 桌面单测 `node tests/run-tests.mjs desktop` | **198 通过 / 0 失败**（新增约 29 条） |
| 全量测试 | **1354 通过 / 0 失败**（15 文件） |
| 现场自愈证据 | 用户真实 `desktop-window.json` 已从 `{x:-32000,y:-32000}` 变为 `{x:0,y:12}`；`desktop.log` 时间戳变本地时间 |

清理：用户两次双击留下的 3 个孤儿启动器（pid 35200 / 26836 / 11532）与 3 个 wscript（13408 / 31556 / 14148）已按精确 PID 终止（先核对命令行）；我自己的验收脚本泄漏的 2 个内核（13820 听 8776、36528 听 8777）同样按 PID 终止。**未按进程名杀任何进程。** 用户内核 pid 22728（8775）全程未动。

已知无关进程：pid 37356 是 `C:\Program Files (x86)\Python\python.exe -X utf8 server.py` 听 8780（10/14 启动，另一个项目），未动。

### 第六个病灶（收尾时又抓到）：`taskkill` 不带 `/F`，内核从来没被杀掉过

`desktop/app.mjs:255` 的 `shutdownServer()` 原来执行 `taskkill /PID <pid> /T`，**实测回 255**：`ERROR: The process with PID <pid> (child process of PID <ppid>) could not be terminated. Reason: This process can only be terminated forcefully (with /F option).` —— 进程照旧存活，而回调**忽略退出码**、照样打「正在停止内核…」并 `resolve(true)`，所以日志上完全看不出来。

用户能观察到的现象：「窗口关了，程序还在跑，端口一直被占」。后端本是 `detached: true` 的独立进程（设计上就是为了不随启动器一起死），于是下次双击只会 `probeInstance()` 复用旧内核 —— 改了代码、改了配置全都不生效；反复跑自动化验收还会堆出一串孤儿内核（实测 8776 / 8777 / 8778 / 8779 各泄漏一个）。

修法：`execFile('taskkill', ['/PID', String(lock.pid), '/T', '/F'], ...)`。验收加两条：`desktop-launch-check.mjs` 冒烟结束后读内核锁、断言 `processAlive(lock.pid) === false`；`tests/desktop.test.mjs` 断言源码里 taskkill 带 `/F`。**启动器验收 13 → 16 条，桌面单测 198 → 200 条。**

### 顺带修掉一处「假红」：候选删除 UI 验收的固定 sleep

`scripts/dev/dedupe-cand-ui-check.mjs` 原来靠 `sleep(2600)/sleep(900)/sleep(4000)` 等异步副作用，实测出现过两种假红：`yes:0`（面板没渲染完，连锁产生 5 条失败）与 `before=2 after=2`（删除没落盘）—— 而同一脚本里更晚的「隔离目录里那个单元目录真的没了」是通过的，自相矛盾即证明是时序问题。已改为 `waitSnap(pred, timeoutMs, label)` 轮询等待，并把「目标单元」改成从被点按钮所属卡片现场取（原来固定取 `titles[0]`，候选顺序变化时会取错）。**这解释了我之前看到的一次 verify-all 第 7 项 8/2 失败。**

### 又抓到一处偶发假失败：三个 CDP 脚本各自猜调试端口（第 3 步滚动检查）

修完上面那条后重跑 verify-all，**第 3 步「浏览器滚动检查」变成 25.4s 失败**（日志只有一行 `[失败] 浏览器调试端口未就绪`），而单独重跑同一脚本又是 **13/13 通过**。

根因：`ui-scroll-check.mjs` 用 `const port = 9333 + Math.floor(Math.random() * 200)` 自己猜端口，`reader-nav-check.mjs` 用**同一个范围**，`dedupe-cand-ui-check.mjs` 用 `9433 + random(200)` —— 范围互相重叠，机器上只要还有残留的无头浏览器占着其中一个端口，新起的浏览器就绑不上，而脚本只会盲等 25 秒然后报「调试端口未就绪」。`download-tabs-check.mjs` 早就用 `--remote-debugging-port=0` + 读 `<user-data-dir>/DevToolsActivePort` 解决了同一个问题。

修法（三个脚本统一）：启动参数改 `--remote-debugging-port=0`，再从 profile 目录的 `DevToolsActivePort` 首行读实际端口，同时加 `proc.exitCode !== null` 的提前退出检测。

回归防线（`tests/desktop.test.mjs` 新增 12 条）：`ui-scroll-check.mjs` / `reader-nav-check.mjs` / `download-tabs-check.mjs` / `dedupe-cand-ui-check.mjs` 四个脚本都必须含 `--remote-debugging-port=0` 与 `DevToolsActivePort`，且不得再出现 `remote-debugging-port=' +` 这种拼接。**这条契约测试当场就抓住了 `dedupe-cand-ui-check.mjs` 还没改**（3 条失败 → 修完 212/0）。

### 最终验收

`node scripts/dev/verify-all.mjs` → **14 通过 / 0 失败 / 0 跳过，退出码 0（305.4s）**：单元+集成 **1372/0** · vault 28/0 · 滚动 13/13 · 宿主忙闲 13/13 · dist 一致 100 文件 · 候选删除一致性 15/0 · 候选删除(真浏览器) 10/0 · 指纹索引 1236/1236 · 阅读器 9/9 · 下载页签 38/38 · 管理台 28/28 · 孤儿竞态 0 例 · exe 自检 16/0 · 启动器验收 16/0 · 工程卫生 64/100（参考）。

（2026-10-17 阅读器一轮之后的最终态）`node scripts/dev/verify-all.mjs` → **14 通过 / 0 失败 / 0 跳过，退出码 0（289.3s）**：单元+集成 **1420/0** · vault 28/0 · 滚动 **13/13** · 宿主忙闲 13/13 · dist 一致 **101 文件** · 候选删除一致性 15/0 · 候选删除(真浏览器) 10/0 · 指纹索引 1236/1236 · 阅读器 **20/20** · 下载页签 38/38 · 管理台 28/28 · 孤儿竞态 0 例 · exe 自检 16/0 · 启动器验收 **17/0** · 工程卫生 64/100（参考）。
## 阅读器：条漫模式「加载不出来」（用户 2026-10-17 复报）

用户原话：**「你这优化之后，我漫画都加载不出来了」「注意，是条漫模式加载不出来」**。

### 根因：条漫当前页跟踪的阈值永远达不到（真缺陷，不是加载失败）

上一轮把条漫改成「等高占位块 + 按需挂载」后，当前页仍然靠 `IntersectionObserver` + `threshold: [0.4, 0.75]` 判定。

| 量 | 实测值 |
| --- | --- |
| 占位块实高 | **1979px**（1200×1704 的图按舞台宽度铺满） |
| 舞台视口 | **762px** |
| 单块最大可见比例 | **762 / 1979 = 38.5%** |
| 观察器阈值 | **0.4** |

→ **回调一次都不触发**，`S.idx` 恒为 0，预加载队列永远停在最初那几页。改成按需挂载后，这个一直存在的缺陷从「只是页码/缩略图高亮不准」升级成「往下滚全是灰底占位块」。

隔离实例实测（真实数据，`MV_DATA_DIR` 隔离 + 真实库）：42 页的《上司の娘》只请求了 **4 张正文图**（`img:4 / ph:42`），滚动 4200 / 8400 / 12600px 后 `idx` 始终为 0、图数始终为 4。

### 修法

`public/modules/reader.js`：删掉 `observeWebtoon()`，改为滚动位置反推当前页 —— 这与单个元素多高无关。

- `currentPageByScroll()`：取舞台 `getBoundingClientRect().top + clientHeight * 0.25` 作判定线，遍历 `.reader-webtoon` 子节点求交，返回命中的页号；
- `onStageScroll()`：`requestAnimationFrame` 节流，更新 `S.idx` / 页码输入框 / 缩略图高亮 / 进度，并 **`queueAround(n)` 把预加载队列挪到当前页附近**；
- `trackWebtoon()`：用 `scrollBound` 保证 `scroll` 监听只绑一次（`render()` 会被反复调用）；
- `goto()` 的条漫分支额外显式 `preload()`（`scrollToPage` 不必然触发 `scroll` 事件）；
- cleanup 改为 `cancelAnimationFrame(scrollRaf)`（不再有 observer）。

实测修复后：滚到 6000px → 页码 1 → 4、正文图 4 → 7 张；逐页滚到底整章 6/6 全部替换。

### 回归防线（两层，都做过敏感度验证）

1. `tests/reader.test.mjs` 新增 5 条静态契约（64 通过 / 0 失败）：**不得再出现 `new IntersectionObserver` / `function observeWebtoon`**；必须有 `currentPageByScroll` / `onStageScroll` / `trackWebtoon`；`ctx.on(stage, 'scroll', onStageScroll)` 必须存在；`queueAround(n);` 必须存在；`if (scrollBound) return;` 必须存在。
2. `scripts/dev/reader-nav-check.mjs` 从 20 条增到 **24 条**，新增真浏览器段：把视口压到 300px 高（构造出「块高 900 > 2.5×视口 254」的几何，旧观察器在这种几何下必然失效）→ 断言初始只加载队列前几页、滚动后页码跟着走、逐页滚到底整章补齐。**24/24 通过**。

**敏感度验证（这一步不能省）**：用 `Page.addScriptToEvaluateOnNewDocument` 注入脚本把 `EventTarget.prototype.addEventListener` 的 `scroll` 分支掐掉，模拟旧实现的失效路径 —— 实测 `sc:0 / page:"1" / img:4`，**滚动后页码仍然停在 1、图数仍然 4**，证明这条断言确实抓得住这个 bug，不是假绿。

### 为什么之前 20/20 全绿却没抓到

夹具只有 6 页，而用例把 `preload` 设成了 **6** —— 6 页一次性全部进队列，**滚动跟踪根本没参与**。凡是「按需 / 增量 / 阈值」类机制，夹具规模与参数必须刻意制造出「机制生效与不生效会得到不同结果」的边界。

### 本轮另外两处「我自己写错的断言」（不是产品问题）

- 视口 420px 时块高 900px 只有 2.14 倍，断言 `blockH > stageH * 2.5` 差一点没过 → 视口改 300px；
- 断言「一次性跳到底能补齐整章」不成立 —— `preload=1` 时跳到哪就只补那一页前后各一张，中间页永远不会被访问到（这是队列的正确语义）→ 改为**先归零再逐页滚**（上一条断言已经滚到底，不归零会一步跳到最后）。

---

## 阅读器：切换模式 / 适应方式后白屏（用户 2026-10-17 复报，解决「另一半」）

用户原话要点：「修复了一半。切换条漫时单页、双页都没问题，但切到条漫就卡住，非得再刷新一遍才行；反复测试发现只要切换到条漫模式就没办法加载出画面；切换适应宽度 / 适应高度 / 原始尺寸，全部都在切换一次后加载不出画面来。」

### 根因（一个真缺陷）

| 环节 | 事实 |
| --- | --- |
| 重建 | `render()` 每次切模式（`cycleMode`）或切适应方式（`cycleFit`）都 `stage.textContent = ''` 重建 DOM |
| 保留 | `preloadDone` 是**跨渲染保留**的集合，语义是「这张图请求过了」（单页/双页也预取过同页码） |
| 冲突 | 新占位块建好后 `startLoad(i)` 里 `if (preloadDone.has(i) \|\| preloadBusy.has(i)) return;` 直接返回 |
| 结果 | 永远等不到 `swapIn(i)` → 条漫全是灰底占位块；**只有整页刷新**（`preloadDone` 随模块重新初始化）才恢复 |

复现（探针 `scripts/dev/tmp-rw3.mjs`，已删）：`ph:42 img:0 ready:0`，切适应方式后仍 `img:0`；图片响应 33 条、无异常无报错 —— 占位块建了，真图一张都没有。

### 修法（`public/modules/reader.js`）

1. `render()` 的 webtoon 分支：循环里先 `if (S.pages[i]) S.pages[i].shown = false;`（占位块是本次新建的，上次的回填标记必须作废）→ `wrap.appendChild(holderNode(i))`；`trackWebtoon();` 之后加 `fillLoaded();` 再 `preload();`。
2. 新增 `function fillLoaded()`（插在 `startLoad` 之前）：遍历页面，对「已请求（`preloadDone.has(i)`）且已解码（`p.img.complete && p.img.naturalWidth > 0`）」且当前没有 DOM 的页调 `swapIn(i)`。

修复后实测：切到条漫 `ph:42 img:6 ready:6`；再切适应方式仍 `img:6 ready:6`；图片响应 39 条、无异常。

### 回归防线

| 层 | 内容 | 结果 |
| --- | --- | --- |
| `tests/reader.test.mjs` | 新增 3 条静态契约：必须有 `function fillLoaded` + 调用点；重建占位块必须作废 `shown`；`fillLoaded` 必须同时判 `p.shown` 与 `p.img.complete` | 64 → **67 通过 / 0 失败** |
| `scripts/dev/reader-nav-check.mjs` | 24 → **28 条**：单页前置 → 连点两次模式按钮切到条漫 → 断言立刻有真图且已解码 ≥1；再点一次适应方式 → 断言真图与已解码仍 ≥1 | **28/28 通过** |

**敏感度验证**：把 `fillLoaded();` 调用注释掉重跑 → `结果: 26/28 通过 · 2 失败`，**恰好只有新加的两条变红**（`真图=0 已解码=0`），其余 26 条照常通过；随后用备份恢复并 `node --check` 通过。

### 为什么 24 条全绿却漏掉了整个白屏

全部断言都建立在「一进页面」的初始状态上。**凡是有模式 / 视图切换的功能，验收必须覆盖「进入 → 切换 N 次 → 每次切换后关键内容仍在」这条序列**，而不是只验首次进入。

## 项目卫生整理（用户 2026-10-17，m05177 / m05181）

用户原话（m05177）：「来整理下项目，现在需要保持项目的卫生干净」，（m05181）「从根目录开始弄起」。

### 一、先盘点再动手（用户数据不可逆，仓库不是 git 仓库）

**`Test-Path .git` = False** —— 本项目不是 git 仓库，删除没有版本历史可回滚，所以每一步都必须先备份。

| 项 | 体积 | 性质 | 处置 |
| --- | --- | --- | --- |
| 仓库 `data/` | **81.74MB / 573 文件 / 225 目录** | **活污染源**（每次跑总验收都重新生成） | 删内容、留 `.gitkeep` |
| 仓库根 `config.json` | 1.7KB | 过期误导（`legacyConfigFile()` 零调用点，真 legacy 读的是**上级**目录那份） | 删 |
| `dist/data/` | 2.8KB / 5 文件 | exe 自检快照，构建时会重新生成 | 删（构建后不存在） |
| `docs/team/*.png` × 6 | 2.87MB | 历史手工验收截图，全仓库零引用 | 删 |

**备份**：`C:\Users\D-001\Desktop\黄漫\_archive\hygiene-20261017-hygiene`（28 文件 / 6.48MB）= `repo-data/`（21）+ `repo-root-config.json` + `docs-team-png/`（6）。

**必须保留、不能碰的**：
- `data/.gitkeep` —— `scripts/tidy.mjs` 的 checkEmptyDirs 只在「只含 .gitkeep」时判为合法空目录；也是 `MV_PORTABLE=1` 便携模式的数据目录。
- **上级** `C:\Users\D-001\Desktop\黄漫\config.json` —— 被 `src/core/config.mjs:133 readLegacyConfig()` 真实读取，`loadConfig()` 有意借用它的 token / downloadDir / dirFmt。
- `desktop/refs/` 三个 WebView2 DLL —— `scripts/build-desktop.mjs` 编译期必需。
- `docs/` 顶层 9 个 md 与 `docs/modules/` —— 被 AGENT.md / README.md / INDEX.md 引用。

### 二、真正的根因：`process.cwd()` 写盘（不只是删存量）

`scripts/dev/vault-acceptance.mjs` 结尾原来写 `fsp.writeFile(path.join(process.cwd(), 'data', 'vault-acceptance.log'), ...)`。

而 `scripts/dev/verify-all.mjs` 的 `spawnPiped` / `spawnFileRedirect` **一律以仓库根为 cwd** 拉起子脚本 —— 于是每跑一次总验收，就在仓库里凭空造一个 `data/`。

**修法**：改为动态 import 数据目录的权威来源 ——

    const { dataPath } = await import('../../src/core/config.mjs');
    const logFile = dataPath('vault-acceptance.log');

**实测验证**：清理后重跑 `node scripts/dev/vault-acceptance.mjs` → **通过 28 / 失败 0**，仓库 `data/` 只剩 `.gitkeep`，日志落到 `%LOCALAPPDATA%\MangaVault\vault-acceptance.log`（1863B）。

### 三、工具自身的假阳性（修扫描器，不是改代码）

`scripts/tidy.mjs` 的 `stripComments(text)`(:109) 靠 `let inBlock = false` **跨行**跟踪块注释状态；而第 264 行写成 `stripQuoted(stripComments(line))` —— **逐行**调用使每行的 `inBlock` 都从 false 重新开始，多行块注释内部的字符于是被当作真代码。这就是 `src/modules/download/api.mjs:69` 那条「模板字符串」误报的成因（该行位于 60-75 行的块注释内）。

修法：先对**整个文件**剥离一次得到行数组 `stripComments(text).split(\n)`，循环里再 `stripQuoted(codeLines[i] || '')`。实测模板字符串 1 条 → **0 条**。

### 四、业务代码的 3 处真问题

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `src/server.mjs:47-48` | 两处 `console.log` 调试残留（此处 logger 尚未创建） | 改用 `process.stdout.write`，与 `src/core/log.mjs` 同一套底层写法，语义不变 |
| `scripts/dev/dedupe-cand-delete-e2e.mjs:12` | `path.join(process.env.LOCALAPPDATA, 'MangaVault')` 无兜底 | `const LOCAL = process.env.LOCALAPPDATA || os.homedir();` |
| `tests/vault.test.mjs` + `scripts/dev/vault-orphan-race-check.mjs` 的 `CHILD_SRC` | `path.join(process.env.MV_DATA_DIR, ...)` 无兜底 | `const dataDirEnv = process.env.MV_DATA_DIR || os.tmpdir();` |

**为什么必须兜底**：`path.join(undefined, 'MangaVault')` **不报错**，返回的是相对路径字符串 `MangaVault` —— 随后任何 `mkdir` / `rm` 都作用到 cwd（即仓库根）下的同名目录。

### 五、判定「不修」的 12 条 low 路径安全（扫描器窗口局限）

tidy 的规则是「删除类 API 的目标为非字面量变量，且**前 5 行**窗口内出现 `isAbsolute|safeJoin|insideRoot|startsWith|ownerRootOf` 才算有守卫」。实测这 12 条**全部已有真实守卫，只是守卫在 5 行窗口之外**：

- `src/modules/vault/ops/undo.mjs:25` 的 `fsp.rm(fromAbs)` —— 守卫 `const abs = safeJoin(root.path, it.dir)`(:150) 与 `if (!(await exists(abs)))`(:151) 在更上方；
- `src/modules/download/ledger.mjs:343` 的 `ledgerPath(taskId)`(:84) —— 内部走 `sanitizeName`，穿越已杜绝；`keyOf`(:135) 同源；
- 其余：`ops/backup.mjs:34`（dir 来自 `backupDir()`、d 来自 readdir 过滤）、`vault/audit.mjs:84`、`download/engine.mjs:153`(`rmWithRetry`) 与 `:985`、`desktop/app.mjs:91`、`scripts/build-desktop.mjs:172`、`scripts/normalize-dir.mjs:212`、`scripts/dev/download-tabs-check.mjs:648`、`scripts/dev/reader-nav-check.mjs:376`。

**结论**：改代码去迎合扫描器只会增加伪守卫，判定为不修，并把结论写进文档避免重复审计。

### 六、结果

| 指标 | 整理前 | 整理后 |
| --- | --- | --- |
| 工程卫生分（`node scripts/tidy.mjs`） | 64/100 C | **69/100 C** |
| 模板字符串误报 | 1 | **0** |
| `console.log` | 2 | **0** |
| 路径安全 mid | 5 | **0** |
| 仓库 `data/` | 81.74MB / 573 文件 | **1 文件（.gitkeep）** |
| `docs/team` 截图 | 6 张 / 2.87MB | **0** |
| 测试 | — | **1428 通过 / 0 失败（15 文件）** |

剩余的 15 分封顶项是 `单文件过大`（28 条）与 `路径安全 low`（12 条，见上），两项都是**结构性**的，不属于本轮「清理垃圾」的范围。


---

## 收尾：大文件拆分 + git 上传准备

> 用户原话（m05471）：「对于大文件进行拆除，然后准备在 @MangaVault/ 做好git，我要准备上传这个项目了。文档工作做好了来 总之就是给项目做好收尾」。

### 一、上传前密钥扫描（通过，可安全上传）

扫描 181 个源文件（排除 `dist/`），5 类高危模式：

| 模式 | 命中 | 结论 |
| --- | --- | --- |
| JWT `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9` | **0** | 无 token 泄露 |
| token 字段赋值 | **0** | — |
| password / passwd | **0** | — |
| `-----BEGIN` 私钥头 | **0** | — |
| 长 base64 串 | 2 处，**均无害** | `docs/modules/download.md:105` 是文档示例；`scripts/dev/reader-nav-check.mjs:55` 的 `JPEG_B64` 是 1x1 JPEG 夹具 |

### 二、git 初始化与基线

- `git version 2.47.1.windows.2`；`git init -b main`；身份 `mcahine <2947301431@qq.com>`。
- 设 `git config core.quotepath false`（否则 `git diff --name-only` 对中文文件名返回 bash 八进制转义串，PowerShell 解析不了）与 `core.autocrlf false`。
- **重写 `.gitignore`**（57 → 63 行，9 段）。关键修正：原来是 `data/`，会连 `data/.gitkeep` 一起忽略，改为 `data/*` + `!data/.gitkeep`；新增 `__pycache__/`、`*.pyc`、`scripts/dev/tmp-*`、`.env`、`*.pem`、`*.key`。
- 清理：删 `scripts/dev/tmp-tidy.json` 与 `src/modules/dedupe/engine/python/__pycache__/`。
- 基线 commit **`313213d`「chore: 收尾基线（拆分前快照）」192 文件**，暂存总量 3346.3KB。
- **`desktop/refs/` 三个 WebView2 DLL 保留进仓库**：`scripts/build-desktop.mjs:157-164` 编译期硬依赖，保留 = 克隆即可构建。因此 `.gitignore` **不能**写裸 `*.dll`（已补注释说明）。

### 三、9 个大文件拆分（全部完成，1440/0 全绿）

| 原文件 | 拆分前 | 拆分后 | 拆出的新文件 |
| --- | --- | --- | --- |
| `src/modules/download/index.mjs` | 1506 | **445** | 9 个路由文件：`routes-account` 156 / `routes-leaderboard` 111 / `routes-status` 141 / `routes-search` 145 / `routes-favorites` 111 / `routes-update` 113 / `routes-tasks` 193 / `routes-export` 67 / `routes-files` 200 |
| `src/modules/download/engine.mjs` | 1309 | **508** | `engine-util.mjs` 419（工具层）/ `engine-run.mjs` 431（`runTask` + `downloadChapter`） |
| `src/modules/dedupe/engine/pipeline.mjs` | 908 | **304** | `pipeline-fast.mjs` 621（全部快速查重实现） |
| `src/modules/dedupe/index.mjs` | 867 | **675** | `views.mjs` 148（11 个纯视图辅助）/ `delete-apply.mjs` 84（`makeApplyDeleteToScan` 工厂） |
| `src/modules/dedupe/engine/match.mjs` | 775 | **545** | `pixel-search.mjs`（z-MAD 检索层） |
| `public/app.js` | 822 | **472** | `ui.mjs` 221（DOM 组件层）/ `grid.mjs` 139（虚拟网格） |
| `public/modules/vault.js` | 1438 | **177** | `vault-kit.mjs` 175 + 5 个页签文件 `vault-tabs-tags` 180 / `-meta` 263 / `-move` 230 / `-audit` 209 / `-misc` 305 |
| `public/modules/download.js` | 1340 | **297** | `download-share.mjs` 291 + 5 个面板 `download-panel-search` / `-favorites` / `-rank` / `-account` / `-tasks` |
| `public/modules/dedupe.js` | 938 | **约 300** | `dedupe-parts` / `dedupe-cand` / `dedupe-data` / `dedupe-decide` / `dedupe-dialogs` / `dedupe-list` / `dedupe-scan`（7 个） |

拆分后规模：源文件 165 个 / 38982 行；**超 1000 行的只剩 `tests/download.test.mjs`（1284）**，`src` + `public` 里最大的业务文件是 `src/modules/dedupe/index.mjs`（675）。

**统一拆法（风险最低）**：把巨型闭包里的分节整体搬进新文件，新文件导出工厂 `makeXxx(ctx, state, deps)`，函数体**逐字节不变、连缩进都不动**（原 `mount` 内就是 2 空格基准）。这样不需要重写任何逻辑，风险只剩「解构名单是否完整」。

### 四、拆分踩的坑（已写进 AGENT.md 第 11 节）

1. **漏 import 是唯一硬风险**：`engine.mjs` 拆出后漏 `extOfFormat`（`engine.mjs:64 return extOfFormat(...)`）→ 4 条下载断言红；`vault-parts` 的 TDZ 顺序错 → `Cannot access 'refresh' before initialization`。`node --check` 只查语法，查不出漏解构（那是运行期 ReferenceError），**必须真跑测试**。
2. **不能用累计偏移量切片**：`dedupe/index.mjs` 整体偏 7 行、`routes-files.mjs` 多切了收尾 `}` → `SyntaxError`。可靠流程是 `git show <基线>:<path>` 取原文 + 逐行 dump 候选边界（起始行/结束行/上一行结尾/下一行开头）核对后再切。
3. **块结束探测不能按行重置括号深度**：`const rootCard = el(...)` 这类单行块里 `{` 与 `}` 同现，深度归零后又没有 `;` 结尾，会一路吞到下一个块。必须**跨行累计全文件括号深度**，`depth === 0 && 行以分号结尾` 才收。
4. **`run_code` 的引号嵌套**：单引号字符串里写中文含单引号会 `Expected ',', got 'string literal'`；长文档一律用双引号数组 + `.join(NL)`。

### 五、文档收尾

| 动作 | 结果 |
| --- | --- |
| 新建 `docs/modules/library.md` | 188 行：接口全表、索引结构、扫描规则、`inFlight` 修复、6 条已知坑 |
| 新建 `docs/modules/reader.md` | 163 行：接口全表、`DEFAULTS` 8 键、尺寸预取、预加载调度、翻页条、三个白屏缺陷、快捷键 |
| `docs/INDEX.md` | 8 处「尚未产出」死标注全部改成真实链接；新增 library / reader / v7-plan；**82 条相对链接 0 断链**（脚本实测） |
| `README.md` | ①版本 v3 → v1.0.0；②实测规模改成真实 `stats`（360 部 / 1384 话 / 74693 张 / 31.4 GB / 6.4 秒）；③删掉不存在的 `打开漫库.bat`，补 `创建桌面快捷方式.ps1` 与「bat 必须 GBK 编码」的告警；④token 的「本机已失效」改中性描述；⑤排行榜从「尚未提供」移到「已有」；⑥进度指向 → `round-progress.md` |
| `docs/ARCHITECTURE.md` | 2 处指向 v3-progress 的过时表述改为 round-progress，并去掉「仍待办」 |
| 新增 `LICENSE` | MIT，1080 字节 |
| `package.json` | 补 `license` / `author` / `keywords` / 4 个脚本（`audit` `tidy` `build:desktop` `verify`） |
| 全仓 md 链接体检 | 39 个 md / 108 条相对链接 → 修掉唯一断链（`docs/modules/vault.md` 里指向仓库 `data/` 的失效链接，改成数据目录说明） |

### 六、验收

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量测试 | `node tests/run-tests.mjs` | **1440 通过 / 0 失败（15 文件）** |
| dist 重建 + 一致性 | `node scripts/build-desktop.mjs --clean --out=dist` + `dist-consistency.mjs` | app 136 文件，**与源码一致** |
| md 链接完整性 | 自写脚本 | 39 md / 108 链接 / **0 断链** |
| 工程卫生 | `node scripts/tidy.mjs` | **69/100（C）**，高危 0 |
### 七、拆分解构回归（真缺陷，已修并加防回归测试）

拆分把 4 个巨型闭包切成 30+ 个新文件，共享状态靠文件顶部 `const { a, b } = s;` 提供。这套做法逻辑零风险，**唯一风险就是解构名单不完整**，而且它只在运行期炸（`node --check` 查不出）。本轮实际抓到 5 处：

| 文件 | 漏掉的绑定 | 谁在用 | 后果 |
| --- | --- | --- | --- |
| `src/modules/download/routes-account.mjs` | `ctx` | `ctx.saveConfig` 在 :30 / :55 / :140 | 登录存 token、退出清 token 全失败 |
| `src/modules/download/routes-files.mjs` | `ctx`、`root` | `ctx.saveConfig` 在 :154 / :166 / :191；`root()` 在 :82 / :109 / :114 | 保存导出目录失败；打开目录越界拒绝 |
| `src/modules/download/routes-status.mjs` | `ctx` | `ctx.saveConfig` 在 :134 | **保存代理配置失败**（用户此前报的「代理模式配置无法保存」同一条链路） |
| `public/modules/download.js` | `updateTabBadge` | SSE `state` 分支 | 下载任务角标不刷新 |
| `public/modules/download-panel-tasks.mjs` | `taskChip`（应由 `deps.chip` 传入） | `updateTabBadge()` 里 | 同上，且抛 `ReferenceError` |

共同特征：**都只在失败/次要分支里被用到**，主流程（登录成功、搜索、下载）一条都不碰 → 当时单元测试 1428 条全绿、真浏览器下载页签 37/38，只红最后那句「整个流程没有 JS 报错」。

**防回归**：`tests/download-routes.test.mjs` 新增 `runSplitContract(t)`（99 通过 / 0 失败）。做法是从 `index.mjs` 的 `const routeCtx = {...}` 正则取出共享绑定名单（31 个），对每个 `routes-*.mjs` 去注释去字符串后，检查「以 `KEY.` / `KEY(` 形式被使用的键」是否都在 `const {...} = s;` 里；工厂形参（`app`、`s`）从 `export function registerRoutes(app, s)` 里自动加白名单，否则会误报 9 条。

### 八、另一处真缺陷：台账清理与 done 状态存在竞态

`tests/download.test.mjs` 的「任务完成后清理对应台账（避免 data/ 膨胀）」在 verify-all 里偶发红（`实际=true 期望=false`），单独跑 3 次全绿。根因不是测试抖动，是**代码里的顺序问题**：`src/modules/download/engine-run.mjs` 原来先 `patch(task, { state: 'done' })` 再 `await removeLedger(task.id)`，于是「看到 done 的观察者断言台账已清」存在一个窗口，机器忙（verify-all 并行跑 15 个脚本）时窗口被撑开。修法：**先删台账、再置 done**，并在注释里写明理由。

### 九、最终验收（本轮实跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量测试 | `node tests/run-tests.mjs` | **1440 通过 / 0 失败（15 文件）** |
| 一键验收 | `node scripts/dev/verify-all.mjs` | **14 通过 / 0 失败 / 0 跳过，300.8s，退出码 0** |
| dist 重建 + 一致性 | `node scripts/build-desktop.mjs --clean --out=dist` + `dist-consistency.mjs` | app 136 文件，**与源码一致** |
| 工程卫生 | `node scripts/tidy.mjs` | **69/100（C）**，高危 0 |

分项：单元+集成 1440/0、vault 28/0、滚动 13/13、宿主忙闲 13/13、dist 136 文件、候选删除 15/0、候选删除真浏览器 10/0、指纹 1236/1236、阅读器 28/28、下载页签 38/38、管理台 28/28、孤儿误移 0 例、exe 自检 16/0、启动器 17/0。

