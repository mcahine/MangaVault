# v3 进度看板（任何人接手先读这里）

状态分三档：✅ 已验收 / 🟡 已落盘未验收 / ⬜ 未开始

---

## ⚠️ 运维教训 A：run_code 进程内 os.tmpdir() 会返回相对路径「undefined\temp」

本会话多次「连接中断、终端停止」，根因是：在 run_code 里用 Start-Process 启动了 GUI 程序（MangaVault.exe）。
GUI 进程会逃逸 DSH 后台作业的进程范围，导致 worker 被连带杀掉，表现为连接断开、终端停止。

正确做法：
- 验证 exe 时让 exe 自己退出（--selftest 模式），用 fire-and-forget 点火，然后**另起一次调用**读证据文件。
- 或用 pwsh 的 run_in_background: true 点火，绝不在同一个 run_code 里等待它。
- 最稳的是只读取 exe 自己写下的 trace 文件，不重复启动它。

---

## ⚠️ 运维教训 B：run_code 进程内 os.tmpdir() 会返回相对路径 `undefined\temp`

> **这条纠正了 lead 的最初诊断（我原以为是 `process.env.TEMP` 拼错），实际根因更隐蔽。**

在 `run_code` 的 Node 进程内实测（`Object.keys(process.env).length === 0`）：

```
process.env.TEMP        = undefined
os.tmpdir()             = "undefined\temp"            <- 不是 undefined，是个「看似正常」的相对路径
path.isAbsolute(tmpdir) = false
path.join(os.tmpdir(),"x") = "undefined\temp\x"       -> 落到 process.cwd() 之下
```

**所以「一律用 `os.tmpdir()`」这条规矩在 run_code 里并不成立** —— 它自己就是坑。

对照：pwsh 里 fork 出的 node 环境是完整的（108 个 env 键，`os.tmpdir()` 正常返回 `C:\Users\D-001\AppData\Local\Temp`）。
**只有直接在 run_code 进程内经 Node API 算临时路径才会踩到**；仓库测试平时在 pwsh 下跑没问题。

正确写法（见 `docs/ARCHITECTURE.md` §9.1 的 `safeTmpDir()`）：候选依次回退 + `path.isAbsolute` 断言 + 拿不到就抛错，绝不静默落盘。

实际后果：曾产生 `MangaVault\undefined\temp\mv-docs-probe-*\`（已清），并留下一个孤儿 node 进程占着 8775（已 taskkill）。

---

## ⚠️ 运维教训 C：别在 run_code 里启动 GUI 进程

---

## ✅ 已完成并验收

### T2 · 漫画库滚动修复（用户第一诉求）

- 根因两层：① CSS 高度链断裂（.shell 缺 grid-template-rows: minmax(0,1fr)）② 虚拟网格只监听 window，而真实滚动容器是 #content
- 修复：public/theme.css 两处 + public/app.js 的 virtualGrid.bindScroller()
- 验收脚本：scripts/dev/ui-scroll-check.mjs（真浏览器 + CDP，6 条断言）
- 实测 6/6 通过：clientHeight 844 < scrollHeight 6878，scrollTop 0 -> 6034 -> 12876，卡片数 30 -> 54 -> 27
- 详情：docs/team/task-9-ui-scroll.md

### T7 · 数据/代码分离（lead）

- 数据目录默认迁到 %LOCALAPPDATA%\MangaVault（四级优先级：MV_DATA_DIR -> --data-dir -> MV_PORTABLE -> LOCALAPPDATA）
- config.example.json 模板 + 首启动播种 + stripComments() 剥注释键
- 既有数据（含 2.35 MB 索引）已完整迁移，未丢
- picacg处理/ 已归档到 _archive/picacg处理/ 并写说明 README
- 修掉一个真 bug：dataDir() 无条件缓存破坏 MV_DATA_DIR 动态性（导致 desktop/reader 测试串味）。全量 476/8 -> 495/1
- 详情：docs/team/task-7-data-separation.md

### T6b · 文档（docs-writer）

- README.md 重写为 v3（302 行）、docs/INDEX.md 新建（185 行）、docs/ARCHITECTURE.md 扩到 228 行
- 76 条内部链接 0 断链；如实标注 exe 尚不存在（当时确实没产出，未把未落地写成已完成）

---

## 🟡 已落盘，待独立验收

### T1 · Windows exe 宿主（shell-smith）—— ✅ 已完成并实测

> **更正 lead 此前的一个过度结论（重要）**：
> 我早期用 `_spike/wv2host/Program.cs` 做探针时，看到 trace 写到 `ENV-OK version=155.0.4283.45` 就宣布"决定性探针成功"。
> 实际上那条 trace **永远停在了 ENV-OK，再没写出 WV2-READY** —— 探针进程卡死、永不退出。
> 根因：参考实现在 `Form.Shown` 里用 `CoreWebView2Environment.CreateAsync(...).Result` **阻塞 UI 线程**，
> 而 WebView2 的回调需要回到 UI 线程 → 自我死锁。
> 所以当时被证明的只有「csc 能编译出 PE」「exe 能拉起 node 后端」「环境对象能创建」；
> **「WebView2 控件真正就绪并渲染出页面」当时并未被证明。**
> shell-smith 绕开阻塞（全程 async）后，才真正跑通到 `NAVCOMPLETE ok=True` + `SCRIPT title 漫库 MangaVault`。
> 教训：**看到中间步骤成功不等于端到端成功，必须等到终态标记（DONE OK）**。

产物：

- dist/MangaVault.exe —— 72,192 字节，PE 头 MZ，machine 0x8664（x64），SHA256 前 16 位 7cd53f16c3b42b4c
- dist/ 下已带 Microsoft.Web.WebView2.Core.dll(603,712B) / .WinForms.dll(38,488B) / WebView2Loader.dll(165,968B) / icon.ico
- dist/app/ 完整代码树（65 个文件，含 src + public + config.example.json）
- scripts/build-desktop.mjs（291 行）、desktop/host/Program.cs、desktop/refs/（3 个随代码发布的 DLL）
- dist/build-info.json 记录编译器路径、PE machine、sha256

exe 自检 trace 内容（lead 已直接读取确认）：

```
BOOT pid=19412 selftest=True
TITLE 漫库 MangaVault
PORT-CHOSEN 8776            <- exe 自己选端口（8775 被占则递增）
NODE C:\Program Files\nodejs\node.exe
SERVER-PID 16140            <- exe 自己拉起 node 后端子进程
BOOT-PING True              <- 后端 /api/ping 通过
WINDOW-RESTORE w=1440 h=900 x=center y=center max=False
SHOWN                       <- 窗口真实显示
ENV-OK version=155.0.4283.45  <- WebView2 运行时环境创建成功
WV2-READY
NAVIGATE http://127.0.0.1:8776/
NAVCOMPLETE ok=True status=Unknown
SCRIPT {"title":"漫库 MangaVault","ready":"complete","elems":42}  <- 页面真实渲染出 42 个元素
SHUTDOWN OK
SERVER-ALIVE-AFTER-KILL False  <- 关闭后无孤儿 node 进程
DONE OK
```

注意：dist/data/host-trace.txt 已被 lead 的一次误操作删除（那条命令想重跑 selftest 但连接断了）。
上面的 trace 内容在删除前已被完整读取并记录在此。重新生成它的方式见下。

全部完成：

- ✅ `scripts/dev/desktop-selftest.mjs`（251 行）—— **16/16 真实通过**，含对 SERVER-PID 的独立 `process.kill(pid,0)` 复核（伪造 trace 骗不过）
- ✅ `docs/DESKTOP.md`（358 行）
- ✅ 原生能力桥（`src/modules/desktop/bridge.mjs` + `guard.mjs`，新增 5 条路由，既有 7 条全保留）
- ✅ `public/modules/desktop.js` 本就不存在（v2 起桌面功能就没有独立前端页面文件），无需删除
- ✅ `tests/desktop.test.mjs` 85 → **154 条断言**

selftest 16 条全绿的关键几条：

```
✓ 4 SERVER-PID 20412（自己拉起 node）
✓ 8 WV2-READY                    <- 这一条是我早期探针从未到达的地方
✓ 9 NAVCOMPLETE ok=True
✓10 SCRIPT title 漫库 MangaVault
✓11 无孤儿 node（独立复核 pid 20412 存活=false）
✓12 BRIDGE-ATTACHED True mode=webview2
✓13 BRIDGE-CANCEL-OK True（取消选目录 → 409 + 中文）
✓14 BRIDGE-PROBE-RESULT True（原生桥真实往返）
```

### T1 挖出的三个真 bug

1. **打包漏了 `desktop/`**（最隐蔽）：`src/modules/desktop/index.mjs` 要 `import` 上层 `desktop/lib.mjs`，
   而原构建脚本只拷 `src/` 与 `public/` → dist 里「模块 desktop 加载失败」→ 所有 `/api/desktop/*` 静默失效。
   **页面照常渲染、其它模块全正常**，只测「HTTP 端口通不通」根本发现不了。靠新加的「原生桥真实往返探测」挖出来。
2. **`build-desktop.mjs --out` 未校验即可递归删除**：`--out=.` 或 `--out=C:\` 会删掉整个仓库/整个盘。
   已加 `assertSafeOutputDir()`（必须绝对路径、不能是文件系统根、不能是仓库根或其祖先），实测两种危险输入都被拒。
3. **参考实现 `_spike/wv2host/Program.cs` 自我死锁**（见上方更正说明），不要照抄它的 `Form.Shown` 写法。

### T1 契约冲突裁决（lead）

冲突：team README 4.4 写 open-external 白名单为 `http/https/mailto`，但 v2 实现只允许回环地址、且既有测试断言「拒绝外网」。

**裁决：采纳 shell-smith 的实现（允许外网 http/https/mailto）。** 理由：

- exe 是原生桌面应用，用户点「帮助 / 官网 / 项目主页」必须能打开外网，回环限制对 exe 无安全价值。
- 真正的风险不在「外网与否」，而在**协议与注入**：已严格拒绝 `file:` / `javascript:` / `data:` / `vbscript:`，
  拒绝含 CRLF 的地址，并对降级到 `cmd.exe` 的路径补了元字符（`& | < > ^ %`）注入防护 —— 这些才是要害。
- 该路由仅监听 `127.0.0.1`，且需要用户在前端显式点击才会触发。

已要求 shell-smith 同步更新 team README 4.4 与相关文档，消除契约与实现的不一致。

---

## ✅ v3 第二轮新增完成项

### 封面回落修复（lead）—— 一行修复，解决了"先期漫画全无封面"

`src/modules/library/index.mjs` 的 `light()` 原本把 `cover` 报成 `Boolean(c.cover || c.coverRemote)`。
但 `/api/library/cover/:id` **本来就有回落到首章首图**的逻辑（该文件 365-369 行）——
因为列表里 `cover=false`，前端连封面请求都不发，裸形态库整库显示占位块。

改为 `hasCover(c)`：本地 cover.jpg > 远程 thumb > 有正文图可回落。

**实测证据**（`scripts/dev/check-cover-fallback.mjs`，隔离数据目录 + 复用真实索引）：

```
早期库总数=53 本页=53
PASS 裸形态库的漫画被标记为有封面 (53/53 部)
PASS 本页含无元数据的裸本（正是问题场景） (53 部无元数据)
PASS 封面接口返回 200 (status=200)
PASS 封面确实是图片 (type=image/jpeg)
PASS 封面有实际字节 (281012 bytes)
PASS 是合法 JPEG/PNG 魔数 (JPEG)
样例：3D作品集（619dde41） images=146
结果: 全部通过
```

> **重要结论**：不需要写纯 Node JPEG 编码器。凡是"有正文图"的漫画，封面天然可得。
> 这条让 T4 里那句"封面生成未实现"的 TODO 直接作废（已通知改为准确文案）。

### T5 · 管理台 ops 拆分（vault-keeper）

`src/modules/vault/ops.mjs`（595 行）拆为 `ops/` 下 11 个文件，对外 18 个导出名与顺序不变，路由与逻辑零改动。

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| ops/_shared.mjs | 12 | bad / needComic |
| ops/index.mjs | 15 | 统一 re-export（18 名，原顺序） |
| ops/meta.mjs | 38 | editMeta |
| ops/rename.mjs | 64 | planRename / applyRename |
| ops/move.mjs | 53 | moveToRoot |
| ops/trash.mjs | 116 | trashComics / listTrash / restoreTrash / purgeTrash |
| ops/cover.mjs | 43 | setCover |
| ops/verify.mjs | 128 | verifyComics / fixComics |
| ops/dupe.mjs | 49 | duplicates |
| ops/stats.mjs | 75 | stats / readingTime / readingStats |
| ops/backup.mjs | 65 | makeBackup / listBackups / restoreBackup |

实测：`vault.test.mjs 54 通过 / 0 失败`；`vault-acceptance.mjs 28/28 通过`。

### T3 · 下载器适配器第一步（子代理）

- `sources/types.mjs`（186 行）：契约真源，JSDoc 定义 Comic/Chapter/Page/PagedResult/Profile，`NotSupportedError`，能力与排序常量
- `sources/picacomic.mjs`（354 行）：哔咔适配器，8 个必备能力 + 5 个可选；HTTP 层复用 `../api.mjs` 的 `createPicaClient`
- `sources/index.mjs`（93 行）：注册表 register/get/list/has，默认 picacomic
- `docs/DOWNLOAD_SOURCES.md`（156 行）：补上了 AGENT.md §7 早就引用却一直缺失的契约文档

离线差分探针最有价值的一条：同一个假 transport 下，旧 `createPicaClient` 与新适配器发出的
`method+path+body+baseUrl+请求头(除 time/signature)` **逐字一致**，覆盖 7 个接口。

### T4 · 先期漫画规范化脚本第一步（子代理）

`scripts/normalize-library.mjs`（389 行）：dry-run 优先、--apply 前备份、幂等（已有元数据跳过，--force 才覆盖）。

标题规范化实测 12/12：

```
3D作品集（619dde41）   -> 3D作品集
ロリ（单行本）          -> 不变（保留语义标注）
ミツカ CG集（60d1511f） -> ミツカ CG集
Cosplay写真集（5b547a0a）-> Cosplay写真集
```

临时拷贝上 dry-run / apply / 幂等复跑 / --force 备份四条路径全部跑通；真实扫描器复核新元数据被正确识别。

---

### T4 · 先期漫画健全化（已对真实库执行）

**53/53 写入 元数据.json**，并且有完整的无破坏证据：

| 指标 | 执行前 | 执行后 | 判定 |
| --- | ---: | ---: | --- |
| 一级目录数 | 53 | 53 | 不变 |
| 含 元数据.json | 0 | **53** | 达期望 |
| 图片总数 | 5937 | **5937** | ★完全不变 |
| 全部文件 | 5937 | 5990 | +53 恰为新增元数据 |
| 图片清单 sha256 | 25caed33… | 同左 | 逐字符一致 |

- **幂等**：第二次 `--apply --yes` 53 部全部「跳过」，写入 0；独立复核 mtime 证明未重写
- **无破坏**：脚本静态扫描无任何 `rmSync/rmdir/unlink/rename`；未授权目标（picacg 库）64,783 个文件在 apply 时间窗内被修改数 = **0**
- **标题规范化仅 3 部**：`3D作品集（619dde41）`→`3D作品集`、`Cosplay写真集（5b547a0a）`→`Cosplay写真集`、`ミツカ CG集（60d1511f）`→`ミツカ CG集`；语义标注正确保留（`萝莉（单行本）` 不变）
- 报告：`docs/NORMALIZE_REPORT.md`（414 行）

索引已重扫并核对：**picacg 213 + early 53 = 266**，磁盘与索引一致，early 标题技术后缀已全部清除。

### T6a · 验收脚本与审计（qa-smith）

- `scripts/dev/verify-all.mjs`（327 行）：一条命令跑 5 项，退出码 0 当且仅当无 FAIL/TIMEOUT
- 某次全绿实测（**注意：这是历史快照，当前树是红的，见下**）：

```
1 单元+集成测试   ✓ PASS 10.7s  573 通过/0 失败
2 vault 破坏性验收 ✓ PASS  7.0s   28/0
3 浏览器滚动检查   ✓ PASS 33.8s    6/6
4 桌面 exe 自检    ✓ PASS  2.8s   16/0
5 工程卫生(参考)   ✓ PASS  0.9s   74/100
总: 4 通过 / 0 失败 / 0 跳过 · 56.2s · 退出码 0
```

- `scripts/tidy.mjs` 修到 **74/100**：原先把 `data/` 里 Edge profile 的图片当源码残留报（145 条误报，评分 7/100），
  现在跳过 `data/` `dist/` `build/` `_spike/`，并**顺带修掉一个真实隐患：原 `--apply` 逻辑会删掉 Edge profile 里的 png**。
- `docs/AUDIT.md`（232 行）记录了 R-1/F1/F3 三条问题，**每条都带可复现命令**。

> qa-smith 还**主动撤回**了自己此前的一条错误判定（曾报「tests/download.test.mjs 泄漏 8 个临时目录，每跑一次 +8」；
> 实际是该文件末尾用 `for...of` 批量清理，按 `const x =` 检索会漏报）。TEMP 堆积是回归的**副产品**而非独立缺陷。
> 这种「自己找自己错并写进文档」的行为应当保持。

---

## ⚠️ 交付前必须做：重建 dist

实测发现 **`dist/` 是过期快照**：

| 文件 | src | dist/app | 一致 |
| --- | --- | --- | --- |
| download/engine.mjs | 10-14 **22:43** 46724B | 10-14 16:13 38171B | 否 |
| download/index.mjs | 10-14 22:28 58017B | 10-14 16:15 50363B | 否 |
| download/api.mjs | 10-14 22:24 23812B | 10-14 16:10 28574B | 否 |
| download/tasks.mjs | 10-14 22:21 3671B | 10-14 16:14 3510B | 否 |
| `dist/MangaVault.exe` | — | 构建于 **20:47** | 否 |

**后果**：当前 exe 里包的是**旧 download 模块**，既没有 T3 的适配器接入，
也带有已被修掉的「终态早于元数据定稿」时序问题。

**交付前必须**：

```powershell
cd MangaVault
node scripts/build-desktop.mjs --clean --out=dist
node scripts/dev/desktop-selftest.mjs      # 期望 16/16
```

> 教训：`dist/app` 只是 `src/` 的**某一时刻快照**，不会自动同步。
> 任何在构建之后对 `src/` 的改动，都要重新构建才能进入 exe。
> 建议把「dist 与 src 的 sha256 一致性校验」加进 `verify-all.mjs`，避免再出现「源码修好了但 exe 还是旧的」。

---

## ✅ 测试状态：全量 622 通过 / 0 失败

```
core 25 | dedupe 59 | desktop 154 | download 169 | integration 67
library 24 | reader 16 | ui-smoke 54 | vault 54
总计: 622 通过 / 0 失败  ·  用例文件 9 通过 / 0 失败
```

**稳定性（lead 亲跑，非转述）**：

```
node tests/run-tests.mjs download  × 15  →  15 次 exit=0 / 0 次失败
node tests/run-tests.mjs           ×  3  →   3 次 exit=0 / 0 次失败
```

> 改造前 download 约有 **8%** 概率红（偶发）。现连续 15 次全绿 —— 说明根因确实被消除，而不是被重试掩盖。

### 抖动被根除：两个真 bug（T3 子代理独立定位）

> 我先前把这条判为「Windows 句柄竞态 / 测试抖动」，**不准确**。子代理用离线探针逐条 trace，挖出两个真 bug。

**Bug A · 并发原子写同一份 `元数据.json`**

`atomicWriteJson` 的临时文件名共用 `.tmp-<pid>`：
- 先完成的 `rename` 会把后一次**正在写**的文件搬走 → `ENOENT`
- 两次 `rename` 争同一目标 → `EBUSY` / `EPERM`
- 旧代码于是掉进「写进临时目录」的兜底 → 漫画目录里留下 `测试漫画.tmp-<pid>` 残渣

修法：临时名加序号 + **同一目标文件的写入进程内串行**。
探针实测：**改造前 5 次并发必现 1 次失败；改造后 40 轮 0 复现。**

**Bug B · 状态与磁盘不一致（更隐蔽）**

`runTask` 先把任务 `patch(state:"done")`，**之后**才 `await` 最终 `writeComicMeta()`。
于是「轮询到 done」时，磁盘上可能还有正在写的 `.tmp-` 文件 —— 测试的「没有残留临时目录」踩的就是它。

探针逐条 trace 抓到的证据：`W 元数据.json.tmp-…-36` / `R …-36 → 元数据.json` **发生在 readdir 之后**。

修法：最终 `writeComicMeta()` 挪到 `patch` **之前** —— `done ⇒ 磁盘已终态`。
这不只是让测试过：**任务不该在元数据尚未落盘时就报告完成。**

### 稳定性实测（lead 亲跑）

```
node tests/run-tests.mjs download   × 15  →  通过 15 次 / 失败 0 次
```

改造前该用例约 **8%** 概率红；现连续 15 次全绿。

### F3 与一条新发现的残渣路径（第三个子代理，确定性复现）

| 问题 | 复现方式 | 修前 | 修后 |
| --- | --- | --- | --- |
| F3 · `comicTempDir` 永久残渣 | 把 `<漫画目录>/元数据.json` **预造成目录**，强制 rename 失败 | 生成永久残渣 `<下载根>/边界漫画.tmp-<pid>`（同级目录，library 永远扫不到，全项目无删除路径） | 两处 `.tmp-` 残渣均为 0 |
| **新发现** · `cover.jpg.tmp-<pid>` | 把 `cover.jpg` 预造成目录，强制 EPERM | 漫画目录里永久留下 `cover.jpg.tmp-<pid>` —— **正是「没有残留临时目录」这条断言计数的东西** | 为 0 |

修法：`writeComicMeta` 的 catch 兜底落盘改为 `try { 写 } finally { rmWithRetry(tempComicDir, 5) }`；
封面临时文件失败即 `rmWithRetry` 再原样抛出；最终元数据定稿失败由「静默吞掉」改为写进任务日志（任务结果不变，但下次可查）。

### 关于「8% 偶发」的归因更正（重要）

这轮出现了三份互相矛盾的说法，最终归因如下：

1. **我最初判为「Windows 句柄竞态 / 测试抖动」** —— 不准确。
2. **第二个子代理的推断是「终态早于元数据定稿」** —— 机制真实存在（正对照实验 **40/40 轮**能复现残渣，旧排序窗口实测 3–17ms），
   但当我把它写进任务书时，**src 里这个修法早已在位**；它描述的行号与 **`dist/app` 的旧副本**吻合 ——
   说明那段描述来自**已过期的打包产物**，不是 src。这是我的侦察失误。
3. **真凶是第一个子代理发现的 Bug A（`atomicWriteJson` 并发写同一份 `元数据.json`）** ——
   它的探针实测「改造前 5 次并发必现 1 次失败；改造后 40 轮 0 复现」，与 8% 量级吻合。

**所以：8% 的确是 Bug A 造成的，修在 22:33；我随后的 15 次连跑 15/15 全绿与之一致。**

第三个子代理**明确表示无法声称修好了那个 8%**（它修前修后各 15 次都复现不出）——
**这个坦诚是对的**，它只修了自己能确定性复现的 F3 与封面残渣。

> 教训：**诊断别人写的代码前，先确认读的是 src 还是过期构建产物。**
> `dist/` 是快照，不是源码；用它做证据会得出与当前代码不符的结论。

### 一处需要 lead 裁决的行为修正 —— 裁决：**保留修正**

子代理报告：路由现在把**含 `chapterTitle` 的统一 Chapter** 交给 `scanChapterStates`；
旧代码传的是上游原始对象（只有 `title`），而 `chapterDirName` 只认 `chapterTitle`，
于是章节目录名算成 `1`，导致 `/api/download/comic/:id` 的 `downloaded` / `complete` / `images` / `bytes`
**对已下载漫画恒为 false / 0**。

**裁决：保留修正。** 理由：key 不变、值从「错的」变成「对的」，这正是用户会看到的功能
（「这本下过没有」显示错误才是真 bug）。为「严格保持旧值」而保留一个恒错的字段，没有意义。

---

### 最后一条 EBUSY 的真凶（download-smith）

`engine.mjs` 的 `swapDir()` 里"旧目录清理"是 **fire-and-forget 的 `fsp.rm(backup)`（没 await）**，
测试紧接着 rm 整棵树时与它撞上 → Windows `EBUSY`。

改为 `await rmWithRetry(backup, 5)`（仍只记录不抛，目录替换本身已成功），并给所有清理点加了 EBUSY/EPERM 退避重试。

> 重要的是它**没有用重试掩盖真实缺陷**：排查确认 `src/modules/download/**` 里 `createWriteStream/createReadStream` 命中数为 **0**
> （引擎只用 `fsp.writeFile/rename/copyFile` 且全部 await），所以确实不是句柄泄漏，是删除竞态。
> 连跑 3 次均 169/0。

---

## 历史记录：回归过程（保留以记录演进，不再作为验收基准）

### 事故与恢复时间线

| 时刻 | 事件 |
| --- | --- |
| 22:16 | 全量 **573 / 0**，verify-all 全绿 |
| 22:21:03 | T3 改造改动 `engine.mjs`，引入回归 |
| — | download **44 / 9**，全量 **497 / 9** |
| — | 中途 **51 / 5** → **165 / 3** → **169 / 1** |
| 当前 | download **169 / 1**，全量 **622 / 1** |

### 真根因（由专职子代理独立定位，**推翻了 lead 的初始诊断**）

lead 起初猜是「适配器 `Comic.cover` 与 engine 契约未对齐」，**这是错的**。

真根因：`engine.mjs` 的 `downloadChapter()`（独立函数）里引用了 `runTask()` 作用域内的 `const src = sourceOf(task)`，
**跨作用域引用 → `ReferenceError: src is not defined`**，导致每章在取图片列表前就失败 → 0 张图落盘 + 任务终态 error。

真实报错全文（子代理用仓库外离线探针 + 假 source 才拿到，因为任务错误被吞了）：

```
TASK_ERROR="有 2 个章节未完成（1、2），具体：第 1 话：获取图片列表失败：src is not defined；
第 2 话：获取图片列表失败：src is not defined。已下载的图片都保留在磁盘，点「继续」只补缺的部分"
```

> 教训：**流程把异常吞成「任务失败」后，测试只能看到终态 error，必须能从任务记录里取出原始错误全文**，
> 否则定位会被表象（缺 cover.jpg）带偏。建议后续给任务记录加一个「原始错误栈」字段。

### 一个值得记住的协作判断

lead 曾授权「修不干净就回退接入」。子代理**拒绝执行回退**并给出理由：
另有一个代理正在**同一批文件上实时改代码**（用 mtime 秒级追踪证明了这一点），回退会覆盖对方的在飞工作。
它选择只读监控 + 独立定位根因，把判断权交回 lead。**这个处置是正确的。**

### 当前唯一失败

```
✗ 下载模块（全离线）  download.test.mjs  169 通过 / 1 失败
  → EBUSY: resource busy or locked,
    rmdir ...\Temp\mvdl-alt-...\lib\退回默认源
```

Windows 文件句柄释放滞后的经典竞态。已派 download-smith 收尾（清理加重试 + 排查 engine 是否有真实句柄泄漏）。

> ★ 重要口径变更：download 用例数已从 120 扩写到 **170**，
> 所以「全量 573」这个旧数字**已作废**，当前真实口径是 **622 / 1**。
> 任何还引用 573 的文档都要更新（`docs/team/v3-progress.md` 上文的历史快照保留以记录演进，但不再作为验收基准）。

---

## ⬜ 未开始 / 已缩范围

- T5 原始范围里的**批量标签编辑增强 / 批量元数据修正 / 元数据导出导入 / 跨库根批量搬迁 / 孤儿清理 / 审计日志与撤销**本轮未做
  （vault-keeper 按「只做第一步」完成拆分后停手，task-12 标 completed 的内容是「拆分完成」，需要时另开卡继续）。
- `--rename-dir` 是死参数；`--cover-only` 仅存在于任务书；`normalize-library.mjs` 暂无单测。



| 编号 | 任务 | 负责 |
| --- | --- | --- |
| T3 | 下载中心 v3：src/modules/download/sources/ 适配器契约 + 排行榜/收藏夹/断点续传 | download-smith |
| T4 | scripts/normalize-library.mjs 先期漫画健全化 | dedupe-smith |
| T5 | src/modules/vault/ops.mjs 拆分为 ops/ 目录 | vault-keeper |
| T6a | scripts/dev/verify-all.mjs + scripts/tidy.mjs 扩展 + 交叉验收 | qa-smith |

---

## 当前测试基线

```
node tests/run-tests.mjs
总计: 496 通过 / 0 失败  ·  用例文件 9 通过 / 0 失败
```

各模块：core 17 / dedupe 59 / desktop 85 / download 120 / integration 67 / library 24 / reader 16 / ui-smoke 54 / vault 54。

> 曾经出现的 8 条失败（desktop 6 + reader 2）是 `dataDir()` 缓存 bug 引起的测试串味，
> 已随 `MV_DATA_DIR` 改为每次求值而根除；download 的临时目录残留也已修。

---

## 关键事实（省得重新侦察）

- 工作目录：C:\Users\D-001\Desktop\黄漫；项目根：C:\Users\D-001\Desktop\黄漫\MangaVault
- 两个库根：picacg漫画（196 部，规范形态）+ 先期漫画（53 部，裸形态，0 元数据 0 封面）
- 参考项目解压于：_ref_downloader/picacomic-downloader-main/（Rust 后端在 src-tauri/src）
- WebView2 SDK 解压于：_spike/wv2/；可用的宿主参考实现：_spike/wv2host/Program.cs
- 编译器：C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe（系统自带，无需 VS）
- 队友上限 8 个；旧 v2 队员（desktop-smith / download-smith / dedupe-smith / vault-keeper / qa-smith / docs-writer）可复用
