# 漫库 MangaVault · v3 验收与缺陷报告（T6a / QA）

> 维护：qa-smith ｜ 快照时间：2026-10-14 22:21–22:25（同一份树多次复跑）
> 一键验收：`node scripts/dev/verify-all.mjs` ｜ 工程卫生：`node scripts/tidy.mjs`
>
> ⚠️ **本文件由 QA 手工维护。** `scripts/audit.mjs` 是 v2 期写的静态审计器，其自动生成的「文件清单/安全/多库根/视觉残留/文档一致性」章节口径已过期
> （当时还没有 vault / desktop / sources 等模块，多库根也尚未接线）。直接运行它会**用旧口径覆盖本文件**；要重跑请先备份本文件。

---

## 0. 快照状态（当前树是红的，勿当成已验收）

| 项目 | 命令 | 快照结果 |
|---|---|---|
| 全量单测 + 集成 | `node tests/run-tests.mjs` | ✗ **497 通过 / 9 失败**（仅 download 一套红） |
| 交互总验收 | `node scripts/dev/verify-all.mjs` | ✗ 会在第 1 项报 FAIL（即上面这条） |
| vault 破坏性验收 | `node scripts/dev/vault-acceptance.mjs` | ✓ 28 通过 / 0 失败 |
| 浏览器滚动检查 | `node scripts/dev/ui-scroll-check.mjs --port=8775` | ✓ 6/6 通过 |
| 桌面 exe 自检 | `node scripts/dev/desktop-selftest.mjs` | ✓ 16 通过 / 0 失败 |
| 工程卫生（参考分） | `node scripts/tidy.mjs` | ✓ 74/100（高危 0） |

**对照（同一台机器同一天）**：

1. 22:13 —— `verify-all` 因 **F1 偶发**在 download 上失败一次（119 通过 / 1 失败）；
2. 约 22:16 —— 立即复跑 `verify-all`，**全绿：4 通过 / 0 失败 / 0 跳过，退出码 0**（573 通过 / 0 失败）；
3. **22:21:03** —— `src/modules/download/engine.mjs` 被改动；
4. 22:21–22:25 —— download 套件转红并**稳定复现** 44/9（见 R-1）。

即：**第 3 步之后树就变红了**，第 2 步那次全绿不能代表当前状态。

---

## 1. R-1 [P1 · 当前稳定复现] download 套件 44/9：任务终态是 error，0 张图片落盘

**复现命令**

```powershell
node tests/run-tests.mjs download
```

**真实输出（连续 3 次一致）**

```
✗ FAIL  下载模块（全离线）   download.test.mjs  44 通过 / 9 失败 / ~1100ms
    → 任务下载完成 | 实际="error" 期望="done"
    → 总图片数 = 4 + 3 | 实际=0 期望=7
    → 完成图片数 = 7 | 实际=0 期望=7
    → 元数据.json pagesCount = 实际图片总数 | 实际=0 期望=7
    → 元数据.json 带 chineseTeam | 实际="" 期望="汉化组"
    → 元数据.json 带 tags
    → 元数据.json likesCount 保留原始数字 | 实际=0 期望=7
    → 元数据.json createdAt 原样 | 实际=null 期望="2020-01-01T00:00:00Z"
    → 用例异常: Error: ENOENT: no such file or directory, stat '...\mvdl-<id>\lib\测试漫画\cover.jpg'
总计: 44 通过 / 9 失败  ·  用例文件 0 通过 / 1 失败
```

**证据链 / 时间线**

| 时刻 | 事件 |
|---|---|
| 22:13 | `verify-all` 因 F1 偶发失败：download 119 通过 / **1 失败**（日志目录 `mv-verify-all-23804`） |
| ~22:16 | 复跑 `verify-all` **全绿**：4 通过 / 0 失败 / 退出码 0（573 通过 / 0 失败） |
| **22:21:03** | `src/modules/download/engine.mjs` 被修改（1097 行，此后未再变化） |
| 22:21–22:25 | `node tests/run-tests.mjs download` 连续 3 次 **44/9**；全量 497 通过 / 9 失败 |

**责任模块**：download-smith（`src/modules/download/**`）

**建议排查方向**（按嫌疑排序，均基于当前代码而非猜测）

1. 任务终态 `error` + 0 张图 + 失败发生在「元数据/封面」阶段之前 → 引擎在首个图片落盘前就抛了；
   最近改动的 `writeComicMeta()`（`engine.mjs:663-678`）与它引入的 `tempComicDir` 回退分支是首要嫌疑。
2. 若 `writeComicMeta()` 走了 `catch`，元数据被写进 `<comic>.tmp-<pid>` 这个**同级临时目录**，
   library 永远扫不到它 → 与「元数据字段全空 / pagesCount=0」的现象吻合。
3. 请在 `runTask()` 的 catch 里把 `task.error` 原文打到日志（现在测试只看到终态 `error`，看不到原因），
   否则每轮都要靠猜。

---

## 2. F1 [P2 · 偶发，未稳定复现] 「没有残留临时目录」断言曾失败一次

**现象（只出现过 1 次）**：在 `verify-all` 下跑全量时，`tests/download.test.mjs` 报

```
✗ FAIL  下载模块（全离线）  download.test.mjs  119 通过 / 1 失败 / 6656ms
    → 没有残留临时目录 | 实际=1 期望=0
```

当时的完整日志：`%TEMP%\mv-verify-all-23804\tests.log`（该目录是失败运行留下的，成功运行会自动清理日志目录）。

**复现命令与结论**

```powershell
node tests/run-tests.mjs download      # 之后多次复跑：120 通过 / 0 失败
node tests/run-tests.mjs               # 之后两次全量：573 通过 / 0 失败
```

**结论**：**偶发，未稳定复现**。三次复跑全绿，故不把它当作确定性缺陷；但在 Windows 上 merge/rename 与句柄时序确有偶发失败先例。

**建议根因方向**：`src/modules/download/engine.mjs` 的 `swapDir(tmpDir, finalDir)`（注释为「原子替换目录」）在
`fsp.rename(tmpDir, finalDir)` 抛错时，回滚了 `backup`，但**没有清理 `tmpDir`** → 章节临时目录 `<章节名>.tmp-<pid>` 会残留，
正好命中该断言（它在漫画目录里查名字含 `.tmp-` 的条目）。
建议：在 `swapDir` 的失败分支里 `fsp.rm(tmpDir, {recursive:true, force:true})` 兜底（清理失败也不要掩盖原错误），
把偶发变成「要么成功、要么可解释地失败」。

**责任模块**：download-smith

---

## 3. F3 [P3 · 静态确定] `comicTempDir` 只写不清理；`chapterTempDir` 只用 pid 命名

**复现命令**

```powershell
Select-String -Path src/modules/download/engine.mjs  -Pattern 'tempComicDir|comicTempDir'
Select-String -Path src/modules/download/paths.mjs  -Pattern 'TempDir|TMP_PREFIX'
```

**证据（当前行号）**

```
engine.mjs:661  const tempComicDir = pp.comicTempDir(task.title);
engine.mjs:674  await fsp.mkdir(tempComicDir, { recursive: true });        <- 只在 catch 分支
engine.mjs:675  await atomicWriteJson(path.join(tempComicDir, MSG_COMIC_META), comicMeta);
paths.mjs:75-77  function comicTempDir(title) { return comicDir(title) + TMP_PREFIX + process.pid; }
paths.mjs:71-73  function chapterTempDir(title, chapter, ctxInfo) { return chapterDir(...) + TMP_PREFIX + process.pid; }
```

**两个问题**

1. `tempComicDir` 全项目只在 `writeComicMeta()` 的 `catch` 分支里被**创建并写入**，
   没有任何 rename / rm 路径 → 一旦走到该分支，`<漫画目录>.tmp-<pid>` 就**永久残留**；
   而且元数据写在这个同级临时目录里，library **永远索引不到**这本漫画。
2. `chapterTempDir` / `comicTempDir` 只用 `process.pid` 做后缀，**同一进程内同名漫画并发下载会撞名**
   （当前靠下载单飞规避；一旦并发策略放宽，两个任务会把彼此的临时目录互相 rename/覆盖）。

**建议**：`writeComicMeta` 的 catch 里改用「写正式目录的临时文件名」而不是整目录回退；
或在 `runTask` 的 `finally` 里统一 `rm(tempComicDir)`；命名后缀加上任务 id 而不是只用 pid。

**责任模块**：download-smith

---

## 4. F2 撤回：QA 自我纠错（原判「测试泄漏临时目录」不成立）

我先前曾判定 `tests/download.test.mjs` 「8 个 `mkdtemp` 根从不删除、每跑一次 +8」，**该判定是错的，特此撤回**。

**错在哪**：我只检索了 `const d = ...` 形式的赋值，漏掉了它在文件末尾以 **`for...of` 绑定**做的统一清理：

```js
// tests/download.test.mjs:632-635 —— 8 个根全都在这里被删掉
// 清理
for (const d of [tmp, tmp2, tmp3, tmp4, tmp5, tmp6, tmp7, tmp8]) {
  try { await fsp.rm(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
```

**运行实测佐证**：测试**跑完全程（绿）**时，`%TEMP%\mvdl*` 目录数 before=11 / after=11，**净增 0**。

**那 TEMP 里为什么会堆 `mvdl*`？** 因为**测试中途异常退出时到不了第 632 行的清理**。
也就是说，TEMP 里的堆积是 R-1（当前 download 回归）的**副产品**，不是独立的测试缺陷 —— **修好 R-1 后自然消失**。
验证命令：

```powershell
$t=[IO.Path]::GetTempPath(); $b=(Get-ChildItem $t -Directory -Filter 'mvdl*').Count
node tests/run-tests.mjs download
$a=(Get-ChildItem $t -Directory -Filter 'mvdl*').Count; "before=$b after=$a"   # 绿 → 相等；红（提前退出）→ 增长
```

> 教训（给后来人）：本仓库的测试用 `for...of` 循环做批量清理，**按 `const x =` 做静态检索会漏报**。
> 判断「有没有清理」要看「有没有任何删除路径引用该变量」，而不是匹配某一种赋值写法。

---

## 5. 已解决 / 已核实（避免重复排查）

> 以下三条由 **lead 实测核实**（非本 QA 独立复现），记录在此以免后来人重开一轮排查。

| # | 事项 | 结论与证据 |
|---|---|---|
| 5.1 | **先期漫画健全化** | 53/53 部写入 `元数据.json`；图片总数 5937 张**不变**；幂等已验证；**无删除、无改名** |
| 5.2 | **封面问题** | 根因不是取封面逻辑：`/api/library/cover/:id` 本就有「回落到首章首图」。真正原因是列表接口 `light()` 把 `cover` 报成 `false`，前端因此根本不发请求。修好后 early 库 **53/53 部 cover=true**；封面接口返回 200 / `image/jpeg` / 281012 bytes / JPEG 魔数正确 |
| 5.3 | **索引已重扫** | picacg 213 + early 53 = **266 部**，磁盘与索引一致；early 标题里的技术后缀已全部清除 |

---

## 6. 工程卫生现状（`node scripts/tidy.mjs`，74/100）

`tidy.mjs` 已按「只扫代码与工具」的口径改造：**跳过 `data/` `dist/` `build/` `_spike/`**（这些是运行时数据与构建产物，
此前把 Edge profile 里的图片当源码残留，制造了 145 条误报，评分被压到 7/100）。这四个目录同时加入 `--apply` 的硬边界，
`--apply` 永远不允许删除它们里面的任何文件。

当前主要扣分项：

| 类别 | 条数 | 说明 |
|---|---:|---|
| 单文件过大（>300 行） | 21 | `src/modules/download/index.mjs` 1138 行、`engine.mjs` 1010 行、`public/app.js` 726 行、`public/modules/vault.js` 660 行 |
| 路径安全 | 5 | 删除目标是非字面量变量，请各自 owner 确认「绝对路径 + 不在仓库根/盘根之上」 |
| 孤立锁文件 | 1 | 数据目录里有 pid 已死的 `server.lock.json`（重启一次服务即可清理，不在 `--apply` 范围） |
| console.log | 2 | `src/server.mjs:28-29` 的「已在运行」提示，属命令行正常输出，可保留 |
| 索引体积 | 1 | `<数据目录>/library-index.json` 约 2.3 MB |

**仓库目录体积（信息项，不计分）**：`data/` 573 文件 / 81.7 MB，`dist/` 88 文件 / 1.64 MB。

---

## 7. 口径与已知局限（读本报告前请先看）

1. **`scripts/audit.mjs` 的自动章节已过期**：它是 v2 期静态审计器，本轮未重跑；它一旦运行会覆盖本文件。
2. **本报告不是「黑盒功能验收」**：R-1 只陈述「测试红了」与可复现证据，根因方向是**基于代码的假设**，不是已证实的结论，
   请 download-smith 用真实日志确认后再定级。
3. `scripts/tidy.mjs` 的路径安全 / 删除目标检查是**正则启发式**：
   「删除目标是变量」只代表**需要人工确认**，不等于一定是缺陷；已尽量过滤 `os.tmpdir()` 来源与带校验上下文的场景。
4. 偶发问题（F1）在文档里明确标注为**未稳定复现**，请勿据此直接判定代码有 bug 或没有 bug。

---

## 8. 复现环境

```
项目根：C:\Users\D-001\Desktop\黄漫\MangaVault
Node  ：v24.18.0（Windows）
数据目录：%LOCALAPPDATA%\MangaVault（可用 MV_DATA_DIR 覆盖）
测试临时目录：os.tmpdir()  → %TEMP%
```

一键复跑全量验收：

```powershell
node scripts/dev/verify-all.mjs          # 会自己拉起 8775 服务、跑完自动关掉；退出码 0/1
node scripts/dev/verify-all.mjs --strict # SKIP 也算失败（CI 用）
node scripts/tidy.mjs                    # 工程卫生（只读；--apply 才清理，且只清临时残留/死锁/过期日志）
```
