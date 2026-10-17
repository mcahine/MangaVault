# 先期漫画库规范化执行报告（T4 · 第二步：对真实「先期漫画」执行 apply）

> 执行时间：2026-10-14 22:14:28 ~ 22:14:43（本地时间）  
> 库根：`early`（先期漫画）→ `C:\Users\D-001\Desktop\黄漫\先期漫画`  
> 数据目录：`C:\Users\D-001\AppData\Local\MangaVault`  
> 脚本：`scripts/normalize-library.mjs`（本轮仅改封面提示文案，逻辑零改动）  
> 授权：lead 明确授权对真实数据执行 `--apply`；铁律「绝不删图片、绝不改目录名」。

---

## 0. 一句话结论

53 部「先期漫画」全部写入 `元数据.json`（0 失败、0 备份），**图片 5937 张一张未动、53 个目录名一个未改**；
幂等复跑 53 部全部「跳过」、写入 0；本轮**没有生成任何 `cover.jpg`**（也不需要生成，见第 6 节）。

| 判据 | 结果 |
| --- | --- |
| 有 `元数据.json` 的部数 | 0 → **53**（期望 53） |
| 图片总数 | 5937 → **5937**（完全不变） |
| 一级目录数 | 53 → **53**（完全不变） |
| 图片清单指纹 sha256 | 前 `25caed33ff5e1af8…` = 后 `25caed33ff5e1af8…`（**逐字节一致**） |
| 目录名集合 | 前后完全一致，差异 `[]` |
| 幂等复跑 | 53 部全「跳过」，写入 0，失败 0 |

---

## 1. 授权边界与「无破坏行为」的核查

### 1.1 脚本静态扫描：有没有删除 / 改名？

对 `scripts/normalize-library.mjs` 全量 grep（`rmSync|rm(|unlink|rmdir|rename|move|copyFile|writeFile|mkdir|ensureDir`）结果：

| 调用 | 位置 | 实际作用 |
| --- | --- | --- |
| `fsp.copyFile` | L241 | 只把**已存在的旧 `元数据.json`** 复制进备份目录 |
| `fsp.writeFile` | L343 | 只写 `<漫画目录>/元数据.json` |
| `ensureDir` | L240 | 只在备份目录内建父目录 |
| **无** `rmSync` / `rmdir` / `unlink` / `rename` / 任何 move | — | **脚本不存在删除、移动、重命名文件或目录的调用** |

两条补充事实：

1. `--rename-dir` 是**死参数**：L191 解析、L221 写进 `--help`，但全脚本从未使用它。即使误传也不会改目录名。
2. `--cover-only` 只出现在 `docs/team/v3-taskbook.md` L268，脚本**未实现**；实测传它会立即报错退出（见第 10 节）。

### 1.2 未授权目标（哔咔库）是否被牵连？

本轮三条命令全部只带 `--root=early`，脚本只会遍历该库根的 `root.path`。实证：

```
扫描 C:\Users\D-001\Desktop\黄漫\picacg漫画 全部 64,783 个文件
在 apply 时间窗（>= 2026-10-14 22:14:00）内被修改的文件数 = 0
```

---

## 2. 执行的命令

```powershell
cd C:\Users\D-001\Desktop\黄漫\MangaVault
node scripts/normalize-library.mjs --root=early --limit=3          # ① dry-run 预演
node scripts/normalize-library.mjs --root=early --apply --yes      # ② 真正写盘（53 部）
node scripts/normalize-library.mjs --root=early --apply --yes      # ③ 幂等复跑
```

### ① dry-run（`--limit=3`）实测输出

```
漫库健全化 · DRY-RUN（只预览，不写盘）
库根：early（先期漫画） -> C:\Users\D-001\Desktop\黄漫\先期漫画
数据目录：C:\Users\D-001\AppData\Local\MangaVault
漫画目录：3 部（--limit=3）

[1/3] 计划  3D作品集（619dde41）
       标题："3D作品集（619dde41）" -> "3D作品集"
       正文：146 图 / 1 章（无封面）
       元数据：id=d-a74a8d3b3034  pagesCount=146  chapterInfos=1
       未生成 cover.jpg：封面由 /api/library/cover 自动回落到首章首图，无需生成
[2/3] 计划  500日元援交
       标题："500日元援交"（无需改动）
       正文：269 图 / 1 章（无封面）
       元数据：id=d-360e943c8f1c  pagesCount=269  chapterInfos=1
       未生成 cover.jpg：封面由 /api/library/cover 自动回落到首章首图，无需生成
[3/3] 计划  百合的盛开
       标题："百合的盛开"（无需改动）
       正文：201 图 / 1 章（无封面）
       元数据：id=d-8fc7fa0aa9e8  pagesCount=201  chapterInfos=1
       未生成 cover.jpg：封面由 /api/library/cover 自动回落到首章首图，无需生成

—— 小结 ——
将对 3 部写 元数据.json，跳过 0 部，失败 0 部
其中标题规范化的有 1 部
封面：未生成 cover.jpg（由 /api/library/cover 自动回落到首章首图），本轮 0 部生成封面
这是 dry-run，未写任何文件。加 --apply 才会真正写入。
```

> 复核实证：dry-run 之后磁盘上 `元数据.json` 数仍为 **0**，一级目录数仍为 **53** —— dry-run 确实零写盘。

### ② 真实 apply 的小结（完整日志见 `%LOCALAPPDATA%\MangaVault\normalize-apply-first.log`）

```
漫库健全化 · APPLY（会写盘）
库根：early（先期漫画） -> C:\Users\D-001\Desktop\黄漫\先期漫画
数据目录：C:\Users\D-001\AppData\Local\MangaVault
漫画目录：53 部
备份目录：C:\Users\D-001\AppData\Local\MangaVault\normalize-backup\20261014-221428-458（仅当有旧文件需要保留时才会创建）
...（逐部 53 行输出，每部均为「已写入 <目录>\元数据.json」）...

—— 小结 ——
将对 53 部写 元数据.json，跳过 0 部，失败 0 部
其中标题规范化的有 3 部
封面：未生成 cover.jpg（由 /api/library/cover 自动回落到首章首图），本轮 0 部生成封面
已写入 53 个 元数据.json，备份 0 个旧文件
```

进程退出码 `0`，stderr 为空。

---

## 3. 前后对比表（核心证据）

| 指标 | 执行前 | 执行后 | 判定 |
| --- | ---: | ---: | --- |
| 一级目录（丛书）数 | 53 | 53 | ✅ 不变 |
| 含 `元数据.json` 的目录数 | 0 | 53 | ✅ 达到期望 53 |
| 图片总数（不含 cover） | 5937 | 5937 | ✅ **完全不变** |
| 全部文件总数 | 5937 | 5990 | ✅ 差额 = +53，恰好是新增的 53 个 `元数据.json` |
| `cover.*` 文件数 | 0 | 0 | ✅ 本轮未生成封面 |
| 图片清单指纹 sha256 | `25caed33ff5e1af82d9a82c73c034fe97012689a0534fc1dd0d36c429d6b708e` | 同左，**逐字符一致** | ✅ |
| 目录名集合 | （53 个） | （53 个） | ✅ 差异 `[]`，未改名 |
| 逐目录图片数 | — | — | ✅ 53/53 全部一致 |

原始实测数据落盘留存：

- `%LOCALAPPDATA%\MangaVault\normalize-census-before.json`（执行前全量普查，含每目录图片数与指纹）
- `%LOCALAPPDATA%\MangaVault\normalize-census-after.json`（执行后同一口径普查）
- `%LOCALAPPDATA%\MangaVault\normalize-apply-first.log` / `normalize-apply-second.log`（两次 apply 的完整 stdout）

---

## 4. 图片总数不变 + 目录未改名的证据

### 4.1 指纹法（比计数更强）

把「相对路径 + 字节大小」按字典序拼成清单取 sha256：

```
执行前 sha256 = 25caed33ff5e1af82d9a82c73c034fe97012689a0534fc1dd0d36c429d6b708e
执行后 sha256 = 25caed33ff5e1af82d9a82c73c034fe97012689a0534fc1dd0d36c429d6b708e
→ 完全一致
```

意味着 5937 张图片的**相对位置、文件名、字节数**全部未变 —— 不是「数量恰好相同」，而是「就是同一批文件」。

### 4.2 逐目录比对

```
逐目录图片数不一致的: 无（53/53 全部一致）
目录名集合是否完全一致（未改名）: true  (53 vs 53)
目录名差异: []
```

### 4.3 新增文件只有 53 个 元数据.json

执行后遍历全库，**非图片文件**只有这 53 个（即 <漫画目录>/元数据.json），没有任何其它新文件：

```
3D作品集（619dde41）/元数据.json
500日元援交/元数据.json
Cosplay写真集（5b547a0a）/元数据.json
ONESHOT 1/元数据.json
ONESHOT 2/元数据.json
ONESHOT 3/元数据.json
コスプレ撮影会とコスプレイヤー/元数据.json
ミツカ CG集（60d1511f）/元数据.json
不知火舞/元数据.json
从今天起当个坏孩子/元数据.json
优等生婊子/元数据.json
保健室/元数据.json
修女克蕾雅（单图）/元数据.json
借宿/元数据.json
催眠で家族でHなちゅーばー生活/元数据.json
入学银帕/元数据.json
公交女高/元数据.json
前后辈（单行本）/元数据.json
午后的图书馆/元数据.json
发情的魔眼/元数据.json
可爱的女孩子们/元数据.json
吞云吐雾的辣妹/元数据.json
吸血鬼/元数据.json
吸血鬼兄妹/元数据.json
地雷女/元数据.json
...（共 53 个，完整清单见 normalize-census-after.json 的 nonImageFiles 字段）
```

---

## 5. 目录实际变化样例（含标题规范化前后）

53 部里只有 **3 部**的标题发生了规范化（都是去掉十六进制技术后缀），另外 50 部目录名本身已是干净标题、仅新增元数据。

| # | 目录名（未改动） | 标题 前 → 后 | pagesCount | 章数 | 生成文件 |
| --- | --- | --- | ---: | ---: | --- |
| 1 | `3D作品集（619dde41）` | `3D作品集（619dde41）` → **`3D作品集`** | 146 | 1 | `元数据.json` |
| 2 | `Cosplay写真集（5b547a0a）` | `Cosplay写真集（5b547a0a）` → **`Cosplay写真集`** | 40 | 1 | `元数据.json` |
| 3 | `ミツカ CG集（60d1511f）` | `ミツカ CG集（60d1511f）` → **`ミツカ CG集`** | 27 | 1 | `元数据.json` |
| 4 | `500日元援交` | `500日元援交` → 不变 | 269 | 1 | `元数据.json` |
| 5 | `萝莉合集` | `萝莉合集` → 不变 | 214 | **9** | `元数据.json` |
| 6 | `萝莉（单行本）` | `萝莉（单行本）` → 不变（✅ 语义标注「单行本」被正确保留） | 220 | 1 | `元数据.json` |

### 样例详录（磁盘实际内容）

**① `3D作品集（619dde41）/元数据.json`（190 字节）** —— 目录名未动，标题已剥掉 `（619dde41）`：

```json
{
  "id": "d-a74a8d3b3034",
  "title": "3D作品集",
  "pagesCount": 146,
  "chapterInfos": [
    { "chapterId": "d-ecd31c215747", "chapterTitle": "第1話", "order": 1 }
  ]
}
```

**② `Cosplay写真集（5b547a0a）/元数据.json`（194 字节）**：

```json
{ "id": "d-51dd27ec295d", "title": "Cosplay写真集", "pagesCount": 40,
  "chapterInfos": [ { "chapterId": "d-584dff0342f2", "chapterTitle": "第1話", "order": 1 } ] }
```

**③ `ミツカ CG集（60d1511f）/元数据.json`（191 字节）**：

```json
{ "id": "d-ed04a0df0feb", "title": "ミツカ CG集", "pagesCount": 27,
  "chapterInfos": [ { "chapterId": "d-9f787ef726b1", "chapterTitle": "第1話", "order": 1 } ] }
```

**④ `500日元援交/元数据.json`（192 字节）** —— 标题无需规范化的代表：

```json
{ "id": "d-360e943c8f1c", "title": "500日元援交", "pagesCount": 269,
  "chapterInfos": [ { "chapterId": "d-0b63b858547d", "chapterTitle": "第1話", "order": 1 } ] }
```

**⑤ `萝莉合集/元数据.json`（977 字节）** —— 全库唯一多章本，9 个子目录被如实识别为 9 章：

```json
{ "id": "d-8fc0c9045684", "title": "萝莉合集", "pagesCount": 214,
  "chapterInfos": [
    { "chapterId": "d-5abfec4bda90", "chapterTitle": "纯欲游戏女友",       "order": 1 },
    { "chapterId": "d-1b098308c958", "chapterTitle": "连接在屋檐下的思念", "order": 2 },
    { "chapterId": "d-bdee5df50cac", "chapterTitle": "娜娜跟小亚",         "order": 3 },
    { "chapterId": "d-fe741ae4368b", "chapterTitle": "奈奈和美美",         "order": 4 },
    { "chapterId": "d-c8b8be85d818", "chapterTitle": "无暇的爱",           "order": 5 },
    { "chapterId": "d-afb36c65d32c", "chapterTitle": "夏色",               "order": 6 },
    { "chapterId": "d-7002f043ddb2", "chapterTitle": "勇者与公主",         "order": 7 },
    { "chapterId": "d-e65080f28387", "chapterTitle": "早交",               "order": 8 },
    { "chapterId": "d-5e0a11e95ee9", "chapterTitle": "Cosplay女友",        "order": 9 }
  ] }
```

磁盘上 9 个子目录（自然序）：`Cosplay女友 / 勇者与公主 / 夏色 / 奈奈和美美 / 娜娜跟小亚 / 无暇的爱 / 早交 / 纯欲游戏女友 / 连接在屋檐下的思念` —— 集合与 9 条 `chapterInfos` 一一对应。

**⑥ `萝莉（单行本）/元数据.json`** —— 反例保护：`（单行本）` **不是**十六进制，未被剥离。

```json
{ "id": "d-a6194ea5f71d", "title": "萝莉（单行本）", "pagesCount": 220,
  "chapterInfos": [ { "chapterId": "d-…", "chapterTitle": "第1話", "order": 1 } ] }
```

---

## 6. 封面：本轮不生成 cover.jpg（文案已按裁决更正）

### 6.1 改了什么

按 lead 的裁决「不要实现 JPEG 封面编码器」，本轮**只改文案、不实现编码器**，共 5 处（`scripts/normalize-library.mjs`）：

| 行 | 改前 | 改后 |
| --- | --- | --- |
| L9（文件头） | `3) （待实现）取首图生成 cover.jpg` | `3) 封面：不生成 cover.jpg（封面接口会自动回落到首章首图，无需生成）` |
| L17（铁律） | `封面生成本轮只留明确桩，绝不写半成品` | `绝不生成 cover.jpg：/api/library/cover 已自动回落到首章首图，生成封面纯属多余` |
| L332（注释） | `/* ---- 封面：本轮只留桩，绝不写半成品 ---- */` | `/* ---- 封面：不生成，由 /api/library/cover 回落到首章首图 ---- */` |
| L334（逐部提示） | `封面生成未实现（TODO：取首图等比缩放到宽 600 / JPEG 质量 82），本轮跳过` | `未生成 cover.jpg：封面由 /api/library/cover 自动回落到首章首图，无需生成` |
| L363（小结） | `封面生成：未实现（桩），本轮 0 部生成封面` | `封面：未生成 cover.jpg（由 /api/library/cover 自动回落到首章首图），本轮 0 部生成封面` |

`node --check scripts/normalize-library.mjs` → `SYNTAX-OK`。仍未生成任何 `cover.jpg`（前后 `cover.*` 文件数均为 0）。

### 6.2 为什么不需要生成

lead 已实证（见 `docs/team/v3-progress.md`）：`/api/library/cover/:id` 本身就有回落到首章首图的逻辑，此前是列表接口把 `cover` 报成 `false` 导致前端不发请求；修好后早期库 **53/53 部 `cover=true`**，封面接口返回 `200 / image/jpeg / 281012 bytes / JPEG 魔数正确`。
因此纯 Node JPEG 编码器属于**多余工程**，本脚本不再暗示「缺封面」。

---

## 7. 幂等证据

### 7.1 复跑输出（完整日志 `%LOCALAPPDATA%\MangaVault\normalize-apply-second.log`，67 行）

```
漫库健全化 · APPLY（会写盘）
库根：early（先期漫画） -> C:\Users\D-001\Desktop\黄漫\先期漫画
数据目录：C:\Users\D-001\AppData\Local\MangaVault
漫画目录：53 部
备份目录：C:\Users\D-001\AppData\Local\MangaVault\normalize-backup\20261014-221442-881（仅当有旧文件需要保留时才会创建）

[1/53] 跳过  3D作品集（619dde41） —— 已有元数据.json，未加 --force，跳过
[2/53] 跳过  500日元援交 —— 已有元数据.json，未加 --force，跳过
[3/53] 跳过  百合的盛开 —— 已有元数据.json，未加 --force，跳过
[4/53] 跳过  保健室 —— 已有元数据.json，未加 --force，跳过
...（[5/53] ~ [53/53] 全部为「跳过」，无一行「处理」）...

—— 小结 ——
将对 0 部写 元数据.json，跳过 53 部，失败 0 部
其中标题规范化的有 0 部
封面：未生成 cover.jpg（由 /api/library/cover 自动回落到首章首图），本轮 0 部生成封面
已写入 0 个 元数据.json，备份 0 个旧文件
```

文本断言：全文中「处理」出现 **0** 次，「跳过」出现 107 次（53 行 × 每行 2 次 + 小结 1 次）。退出码 `0`。

### 7.2 独立复核：第二次 apply 真的没碰文件吗

不只信 stdout，另查 53 个 `元数据.json` 的 mtime：

```
元数据.json 最早 mtime: 2026-10-14 22:14:28
元数据.json 最晚 mtime: 2026-10-14 22:14:29
第一次 apply 时间戳: 20261014-221428-458
第二次 apply 时间戳: 20261014-221442-881
→ 最晚 mtime 早于第二次 apply 起始: true
```

第二次 apply 期间（22:14:42 起）**没有任何一个元数据文件被重写**，幂等成立。

### 7.3 现态指纹（供后续复现比对）

53 份 `元数据.json` 的 sha256 排序后聚合指纹：

```
ea5d6af3f49eadca1bb8c3394e8364d261ef7b55cce6245358965d76c171e50a
```

---

## 8. 备份目录里到底有什么

脚本打印的备份目录是 `C:\Users\D-001\AppData\Local\MangaVault\normalize-backup\<时间戳>\`。实测：

```
备份根 C:\Users\D-001\AppData\Local\MangaVault\normalize-backup 存在: false
条目总数: 0
```

**结论：备份目录根本没被创建，里面是空的（不存在）。** 原因是 53 部「先期漫画」在执行前全都是裸本、**没有任何旧 `元数据.json` 需要保留**，
脚本的 `ensureDir` 只在 `backupFile()` 内部调用，0 个待备份文件 → 0 次调用 → 0 个目录（日志里也写着「备份 0 个旧文件」）。
这是预期行为，不是缺失：只有 `--force` 覆盖旧元数据时才会真正产生备份文件。

数据目录下与本任务相关的产物（供追溯）：

| 文件 | 大小 | 说明 |
| --- | ---: | --- |
| `normalize-apply-first.log` | 22,120 B | 第一次（真实写入）完整 stdout |
| `normalize-apply-second.log` | 5,388 B | 第二次（幂等复跑）完整 stdout |
| `normalize-census-before.json` | 5,616 B | 执行前全量普查（53 目录、5937 图、指纹） |
| `normalize-census-after.json` | 8,188 B | 执行后全量普查（含 nonImageFiles 清单） |

---

## 9. 元数据合规校验（53/53 通过）

对全部 53 份 `元数据.json` 做独立校验（不依赖脚本自身逻辑，另写遍历复算）：

```
校验目录数: 53
含 元数据.json 且 JSON 合法: 53
pagesCount 与执行前实测图片数一致: 53/53
title !== 目录名（标题规范化）的: 3
章节数 > 1 的目录: 萝莉合集 -> 9 章 / 214 页
校验问题: 无（0 项）
```

校验项覆盖：`元数据.json` 存在性、JSON 可解析、四字段齐全（`id` / `title` / `pagesCount` / `chapterInfos`）、`id` 形如 `d-<12 位十六进制>`、
`chapterInfos.length` 与**磁盘独立复算**的章节数一致、`chapterId` 无重复、`order` 严格为 `1..n`、`pagesCount` 与**执行前实测**图片数一致。
全部符合 `docs/LIBRARY_FORMAT.md` §3.1 契约。

---

## 10. 缺口与后续建议

1. **索引未重建（唯一实质性缺口）**：`%LOCALAPPDATA%\MangaVault\library-index.json` 的 `scannedAt` 早于本次 apply，其中 `early` 条目的 `title` 仍是原始目录名（例如 `"title": "3D作品集（619dde41）"`）。
   新 `元数据.json` 要等**下一次重扫**才会在界面生效。本次未擅自重扫（超出「只新增 元数据.json」的授权范围，且会改写 2.4 MB 的索引）。
   建议：由 lead 在应用中触发一次重扫，或授权后跑 `scripts/scan-library.mjs`（若适用）。
2. **`--rename-dir` 是死参数**：`--help` 有、代码未实现。它写的是「额外把目录名里的技术后缀也改掉」，而本任务铁律是「绝不改目录名」。
   建议二选一：删除该参数与相关文档，或实现时明确加 `--apply` 双重确认。当前状态（静默无效）虽安全，但属于文档与实现不一致，容易误导。
3. **`--cover-only` 文档与实现不一致**：`docs/team/v3-taskbook.md` L268 写了 `--apply --cover-only`，实测直接报错 `未知参数：--cover-only`（退出码 1）。
   既然封面编码器已裁决不做，建议从任务书里删掉这一行，避免后人照抄失败。
4. **该脚本目前没有任何单元测试**：`tests/` 下无引用 `normalize-library` 的文件（`normalizeTitle` / `comicId` / `probeComic` 都是导出的纯函数，很容易补 `tests/normalize.test.mjs`）。
   本轮用真实数据 + 独立校验脚本代偿，但回归保护仍建议补上。
5. **`元数据.json` 之外的字段未补**：本轮只写契约四字段，没写作者/标签/封面引用等。裸本升到 B 级即可，升 A 级（封面）按裁决不做。

---

## 附：本报告所有数字的来源

| 数字 | 来源 |
| --- | --- |
| 53 / 0 / 5937 | 执行前普查程序实测（`normalize-census-before.json`） |
| 53 / 53 / 5937 / 5990 | 执行后普查程序实测（`normalize-census-after.json`） |
| 指纹 `25caed33…` / `ea5d6af3…` | 本机 Node `crypto.createHash('sha256')` 实算 |
| 64,783 文件 / 0 改动 | 对 `picacg漫画` 全树 stat 遍历实测 |
| 三次命令输出 | `%LOCALAPPDATA%\MangaVault\normalize-apply-*.log` 原样留存 |
