仓库 C:\Users\D-001\Desktop\黄漫\MangaVault（MangaVault，Node ESM，零第三方运行时依赖）。

★ 铁律（违反即返工）：
- 只用 node: 内置模块与相对路径 import，绝不引入任何 npm 包。
- 禁止模板字符串，字符串拼接用单引号加号。
- 两空格缩进，中文注释与中文 UI 文案。
- 测试只写在 tests/*.test.mjs；HTTP 测试必须 listen(0) 随机端口，绝不用 8775。
- 绝不按进程名杀进程（只按记录的 PID）。
- 临时脚本写 scripts/dev/tmp-*.mjs，跑完自己删掉。
- 测试没过就说没过，禁止伪造结论；完成后如实报告哪些通过、哪些没通过、哪些没来得及做。

已批准规划：docs/team/dedupe-v7-fast-plan.md（先读它）。

## 你的任务（只写这两个文件，别碰别的）
1. src/modules/dedupe/engine/pipeline.mjs
2. src/modules/dedupe/engine/runner.mjs

目标：新增快速查重模式，不新建全库指纹，只给候选单元 / 候选库章节建指纹，然后只比候选对。

### 依赖的接口（由另一位同事正在实现，签名已冻结，你按此调用即可）
import { prefilterUnits, DEFAULT_TITLE_THRESHOLD, DEFAULT_PAGE_TOLERANCE } from './prefilter.mjs';
prefilterUnits(units, comics, opts) 返回 { candidates: [{unitId, unitPages, matches:[{libId, libTitle, libPages, titleScore, pageDiff, pageDiffRatio, reasons}]}], stats }
如果该文件暂时不存在，你仍然按此签名写代码；不要自己实现它。

### 需要做的改动
1. pipeline.mjs 新增导出 runFastStage(paths, report, ctx)：
   - 读库索引（复用 buildLibraryIndex / 现有共享索引机制，见 runHashStage 第 48 行用法）
   - discoverUnits 得到查重单元（复用现成函数）
   - 用 prefilterUnits 得到候选
   - 报告中文进度，例如：预筛完成：140 个单元 → 13 个候选（跳过 127 个）
   - 只为候选库章节 + 候选查重单元建指纹（不要 collectLibJobs 取全部库根）
   - 只对候选对做像素比对，绝不能退化成全库扫
   - 结果写入 scan-fast.json；store.mjs 不归你改，所以请用 fsp 直接读写 paths 下的文件（注意 paths 里已有的目录字段），并在回报里说明你用的文件名与字段
   - 返回 { units, summary, stats }，与现有 runPixelStage 的返回形状保持一致，供 index.mjs 透传
2. runner.mjs 的 STAGES 增加 fast；STAGE_LABEL 增加 fast: 快速查重（元数据预筛）；STAGE_WEIGHTS 增加 fast: { fast: 1 }；
   并且 run() 里在 stage === fast 时调用 runFastStage。
   注意 runHashStage / runPixelStageFull / runThumbsStage 的现有行为一行都不能改。

### 硬性约束
- 4 物理核 / 8 逻辑核，空闲内存约 1.5GB —— 峰值内存要可控。
- 长任务必须走 withHeartbeat（现成机制，见 runner.mjs 第 6 行 import）。
- 中止（signal.aborted）必须在每个阶段边界都能立刻生效。
- 绝不改现有两种模式的语义。

完成后：node tests/run-tests.mjs dedupe 与 node tests/run-tests.mjs 都要跑，报告实际通过数。
如实回报哪些做完、哪些没做完、有无回归。不要伪造。
不要改 index.mjs、public/ 下文件、engine/prefilter.mjs、engine/match.mjs、engine/store.mjs。