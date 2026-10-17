# 查重模块（dedupe）

> 归属：dedupe-smith ｜ 代码：`src/modules/dedupe/**`、`public/modules/dedupe.js(.css)` ｜ 测试：`tests/dedupe.test.mjs`
> 来源：从 `picacg处理/查重模块/` 整体迁移（scan / match / build-fp / thumbs / covers / delete），
> **算法与判定口径原样保留**，只把路径、端口、配置改为从 `ctx.config.dedupe` 注入；`picacg处理/` 只读，不再写入。

## 1. 产物与写入范围

所有产物只写 `data/dedupe/` 下（`ctx.dataDir` 由 server 注入，支持 `MV_DATA_DIR` 隔离）：

| 路径 | 内容 |
|---|---|
| `data/dedupe/scan-latest.json` | 最新扫描结果（单元列表 + 汇总 + 参数，前端列表/统计的唯一数据源） |
| `data/dedupe/hash-result.json` | 逐文件明细（每个单元的全部图片、字节命中表、候选章节），供像素阶段与详情弹窗使用 |
| `data/dedupe/tmp/fp-lib/` | 库侧 32x32 灰度指纹 `<md5(dir)>.bin` + `index.json` |
| `data/dedupe/tmp/fp-dup/` | 查重单元侧指纹 `<md5(unitId)>.bin` |
| `data/dedupe/thumbs/<md5(unitId)>/<dup|lib>/` | 320px 缩略图缓存（按需生成） |
| `data/dedupe/decisions.json` | 人工决策 `{ [unitId]: { verdict: keep|delete|pending, note, updatedAt } }` |
| `data/dedupe/delete-log.jsonl` | 每次删除操作一行（含 mode / 目标路径 / 隔离落点 / 成败），还原据此找回原路径 |
| `data/dedupe/已确认删除/` | 隔离区（`mode=quarantine` 的目标目录） |
| `data/dedupe/state.json` | 上次扫描时间 / 阶段 / 降级原因 / 上次结果摘要（重启后 `GET /state` 仍有值） |

指纹二进制格式（与迁移前一致）：`int32 条数` + 每条 `{ int32 名字字节数, UTF8 名字, int32 宽, int32 高, 1024 字节灰度 }`（256 字节头 + 32x32 灰度）。

## 2. 配置（`ctx.config.dedupe`）

| 键 | 默认 | 说明 |
|---|---|---|
| `scanRoot` | `''` | 查重目录（要比对、可能要删的那一侧）。空则扫描接口返回 400 |
| `libRoot` | 退回 `libraryRoot` | 漫画库目录（比对基准）。为空时库索引为空，全部单元判为「未找到」 |
| `pixelThreshold` | `8` | 灰度平均绝对误差（MAD）阈值，`<=` 视为像素一致 |
| `thumbCount` | `6` | 每个单元参与缩略图对比的样本张数 |
| `pixelReview` | `true` | 关闭后只做 SHA-256 字节查重，跳过像素阶段 |

每次请求都会 `ctx.reloadConfig()`，所以设置页改了目录立刻生效（`GET /state` 也回显当前解析到的绝对路径）。

## 3. REST 接口

全部挂 `/api/dedupe/*`；成功一律 `{ok:true,...}`，失败 `{ok:false,error:'中文原因'}`。

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/state` | — | 是否在跑、当前进度、上次扫描时间、配置路径、统计、Python/Pillow 能力、可选阶段与删除方式 |
| POST | `/scan` | `{stage?:'full'|'hash'|'pixel'|'thumbs', rebuildFp?:bool}` | 启动扫描（**单飞**：已在跑返回 409） |
| GET | `/scan/events` | — | SSE：`event: state`（接入即回放当前状态）/`progress`/`done`/`error`，data 含 `stage/phase/current/total/percent/message` |
| POST | `/scan/abort` | — | 中止：置中止位 + SIGKILL 所有 Python 子进程（通常 1~3 秒内停） |
| GET | `/units` | `page`(1) `size`(24,≤200) `verdict`(判定) `q`(关键字) `decided`(1/0) | 分页 + 筛选列表（含人工决策与统计） |
| GET | `/unit/:id` | — | 单元详情：`unit` / `dupFiles`(全部本单元图片) / `libFiles`(库章节图片) / `pairs`(逐张对应：`{dup,lib,exact,mad}`) |
| GET | `/thumb` | `unit` `side=dup\|lib` `name` `full=1` | 缩略图（缓存，缺 Pillow 时退回原图）/ `full=1` 返回原图；**safeJoin + 目录归属双重校验** |
| POST | `/decision` | `{unitId, verdict:'keep'\|'delete'\|'pending', note?}` | 人工决策落 `decisions.json`（每次原子落盘） |
| POST | `/delete` | `{unitIds:[...], mode:'recycle'\|'quarantine'\|'permanent', confirm:'DELETE'}` | 执行删除（见第 6 节校验） |
| POST | `/restore` | `{unitIds?:[...]}` | 从隔离区还原（缺省还原全部可还原项，按 `delete-log` 记录的原路径放回） |
| GET | `/deleted` | — | 隔离区目录内容 + 最近 50 条删除日志 |
| GET | `/stats` | — | 单元数 / 各判定数量 / 决策数 / 可清理体积 |
| POST | `/covers` | — | 生成联络表（各单元首图拼图，产物在 `data/dedupe/tmp/id-covers.jpg`） |

## 4. 算法（与迁移前一致）

### 4.1 比对单元发现
递归遍历 `scanRoot`，**凡是「直接含图片的目录」就是一个比对单元并停止下钻**；只含子目录的目录不算单元。
单元 `id` = 相对 `scanRoot` 的路径（`/` 分隔），`name` = 末段，`category` = 第一段（根目录下记 `(根目录)`）。

### 4.2 库章节映射
优先复用 Lead 的 `data/library-index.json`（经 `src/core/library-index.mjs` 的 mtime 缓存读取）拿漫画/章节/`chapterId`/图片名；
该索引缺失或 `root` 与 `libRoot` 不一致时，退回实时目录遍历（口径同原 `scan.mjs`）。
共享索引里没有单张体积，所以仍对每张库图 `stat` 一次（并发 32）建立「体积 → 候选」倒排表；stat 失败（文件已删）的条目直接跳过。
`scan-latest.json` 的 `库.索引来源` 会标明本次用的是 `library-index` 还是 `目录遍历`。

### 4.3 SHA-256 字节查重
只对「与库内某张图体积相同」的本单元图片计算 SHA-256（流式，不整块读入内存），命中即 `exact`。
候选章节推断顺序：① 单元名是 24 位十六进制且命中库 `chapterId` → `章节ID`；② 字节内容命中张数最多 → `内容命中`；
③ 体积近似投票 ≥ `max(3, ceil(张数×15%))` → `体积近似`（注意：投票按「候选图片对」累计，与原实现一致）。

### 4.4 32x32 灰度像素比对
Python(Pillow) 把每张图转灰度并 LANCZOS 缩放到 32x32（1024 字节），JS 侧做两级匹配：
1. **粗筛**：8x8 块（每块 4x4 均值）平均绝对差，超过 `64*14` 直接丢弃；
2. **精算**：对候选算 1024 字节 MAD，取最小者。
`pixel` 阶段流程：抽样最多 8 张做**全库**搜索投票定位候选章节 → 候选章节内逐张精算 → 仍未命中的再**穷尽**全库找最像一张。
另记录 MAD 直方图（<2/<4/<8/<16/<32/≥32）与 `farCount`，用于证明「库内确实没有」。

### 4.5 判定口径（`judgeOf`）
```
matched = exactCount + pixelCount（pixelCount 只数 MAD <= 阈值 的）
matched === total  ->  exact === total ? '完全重复' : '同图不同编码'
matched / total >= 0.3  -> '部分重复'
否则                -> '未找到'
```
命中率 < 30% 视为库内没有（零星命中多来自空白页/扉页巧合）。判定为「未找到」时前端不展示「最接近」的库内图，避免误读。

### 4.6 进度权重（真实进度）
| 阶段 | 权重 | 段内细分 |
|---|---|---|
| hash | 0.35 | 索引库 0~0.15 / 发现单元 0.15~0.30 / 字节查重 0.30~1.00（按单元数） |
| pixel | 0.45 | 指纹 0~0.25（按 Python 的 `PROGRESS n/total`）/ 全库搜索 0.25~1.00（按单元数） |
| thumbs | 0.20 | 按 Python 的 `PROGRESS n/total` |

`stage=hash|pixel|thumbs` 时该段权重归一为 1；`pixel` 阶段发现缺 `hash-result.json` 会先跑一次 hash（占该段 0~0.30）。
进度全部来自真实计数（单元数 / Python 上报的完成数），发现单元阶段 `total=0` 表示未知，只上报已发现数量。

## 5. 降级策略（没有 Pillow）

`py.mjs` 用 `spawn('python'|'py'|'python3', [...args])` **数组传参**（不拼 shell 字符串），并强制 `PYTHONIOENCODING=utf-8`（否则管道下中文输出按 cp936 编码会乱码）。
每次 spawn 前探测 `python -c "import PIL"`：
- 缺 Python 或缺 Pillow：跳过 `pixel` / `thumbs`（以及 `covers`），**继续完成 SHA-256 字节查重**；
- 降级原因写进 `scan-latest.json.degradeReason`，`GET /state` 与 `/units` 都会回给前端，前端用 `.alert-warn` 明示；
- 缩略图接口拿不到缩略图时退回原图，前端仍能看图（只是流量大）；
- Python 脚本以退出码 3 + `NO_PIL` 明确失败，不会被当成正常完成。

## 6. 删除的安全边界

`validateDeleteRequest()`（纯函数，单测覆盖）依次校验：
1. `confirm` 去空白转大写后必须等于 `DELETE`（大小写与首尾空白不敏感，与原实现一致）；
2. `mode` 必须是 `recycle` / `quarantine` / `permanent`，缺省 `recycle`；
3. `scanRoot` 必须已配置；`unitIds` 非空；
4. 每个 `unitId` 必须出现在**最近一次扫描结果**里；
5. 记录路径必须 `=== path.resolve(join(scanRoot, id))`、必须位于 `scanRoot` 内，且**不允许等于 `scanRoot` 本身**。

执行层再兜一层：`delete.ps1` 收到 `-Root`，用 `Test-WithinRoot` 复核后才动文件；每个目标单独 try/catch，
结果写回 `<listFile>.result.json` 并追加到 `delete-log.jsonl`；`quarantine` 落点原名冲突时追加时间戳+随机数，还原时按日志里的 `target` 移回原路径。
前端要求手输 `DELETE` 后才提交。

## 7. 前端（`public/modules/dedupe.js`）

- `meta = { id:'dedupe', name:'查重', order:40 }`；`mount(root, ctx)` 用 `ctx.el` 渲染，样式只用 theme.css 已有类 + `dedupe.css` 的 `mv-` 前缀类（按需注入 `<link id="mv-dedupe-style">`）。
- 顶部 `.stat-row/.stat` 六张卡：单元总数 / 完全重复 / 同图不同编码 / 部分重复 / 未找到 / 可清理体积（附待删除体积）。
- 工具条：重新扫描（full）、深度比对（仅像素）、重建全库指纹（pixel+rebuildFp，先弹确认）、中止、隔离区、执行删除…；下方 chip 判定筛选 + 「只看有决策」+ 关键字搜索（Enter 或 350ms 防抖）。
- `.grid.grid-cards` 单元卡：本单元首图 ↔ 库内对应章节首图并排，判定 badge（`.badge-err/.badge-warn/.badge-accent/.badge-ok`）、命中张数/总张数、体积、`查看详情`/`删除`/`保留`；点卡片开 `ctx.modal` 逐张大图对照（← → / 缩略图条切换，`full=1` 取原图）。
- 决策即时 `POST /decision` 并在卡片上显示「已保留 / 待删除 / 未定」。
- `ctx.sse('/api/dedupe/scan/events')` 驱动 `.progress` 进度条与阶段文字；`done` 后 toast 汇报「重复单元 N 个 / 可清理 X / 耗时 Y」，`error` 与请求失败一律 toast。
- 空态 `.empty`、错误态 `.alert-err`、降级 `.alert-warn`。

> 注意：外壳 `modal()` 只在传了非空 `foot` 时才渲染 `.modal-foot`，因此 `ctx.confirm` 的按钮目前不会落地（download/library 同样受影响）。
> 本模块的确认框改为把按钮直接放进 `opts.foot`（`askConfirm`），不依赖 `ctx.confirm`；`ctx.prompt`（输入 DELETE）本身可用（Enter 提交）。

## 8. 测试

`tests/dedupe.test.mjs`（**离线**，全部在 `os.tmpdir()` 造样本，用假字节当 jpg，不写真用户数据、不真删文件）：

| 覆盖 | 断言要点 |
|---|---|
| (a) 单元发现 | 4 个「直接含图片」单元被识别、id 为相对路径、只含子目录的目录不算单元 |
| (b) SHA-256 判定 | 完全重复 / 部分重复（1/3 ≥ 30%）/ 未找到；`candSrc`；`needPixel`；30% 边界 |
| (c) safeJoin | `..` 与绝对路径越界必须抛出 |
| (d) 删除前置校验 | confirm 非 DELETE、空 ids、未知/越界 unitId、未知 mode 一律拒绝；合法请求目标路径 = `scanRoot/<id>` 且校验阶段不动文件 |
| (e) 决策持久化 | keep/delete/pending 落盘、备注、updatedAt、非法 verdict 不覆盖旧值、产物在 data/dedupe 内 |

运行：`node tests/run-tests.mjs dedupe`（当前 59 通过 / 0 失败）。

## 9. dev 脚本（不在 tests/ 下，不参与 Runner）

| 文件 | 用途 |
|---|---|
| `src/modules/dedupe/dev/gen.py` + `dev/e2e.mjs` | 用 Pillow 造真图（JPEG 在查重侧、同图 PNG 在库侧），跑完整 `full` 流水线并打印每段进度与判定，验证「同图不同编码」与缩略图 |
| `src/modules/dedupe/dev/verify-http.mjs` | 对已启动实例跑 35 项 HTTP 验收（含越界/口令/未知单元等拒绝路径，**不执行真实删除**） |

## 10. 已知限制

1. 复用 `library-index.json` 时，若库在索引生成后新增了章节，需先让 library 模块重扫才能被查重看到（共享索引是 mtime 缓存，不感知磁盘变化）；反向（文件被删）会因 `stat` 失败自动跳过，不报错。
2. `hash-result.json` 只有「字节命中」是逐张完整的；像素结果只对 `thumbCount` 个样本落进 `scan-latest.json`，详情弹窗里非样本图片显示为「库内没有对应图片」（与原实现一致）。
3. 字节命中若落在**非主章节**的库章节里，缩略图按主章节目录取相对名，取不到时退回文件名（可能 404，前端显示「图片读取失败」）。
4. 全库像素搜索是 O(单元图片数 × 库图片数) 的 CPU 活；`recycle` 依赖 PowerShell + `Microsoft.VisualBasic`（pwsh 7 已内置）。
5. `permanent` 不可恢复；`quarantine` 还原依赖 `delete-log.jsonl`，手工删掉日志后无法自动定位原路径。
