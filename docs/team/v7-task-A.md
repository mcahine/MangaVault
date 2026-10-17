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
1. 新建 src/modules/dedupe/engine/prefilter.mjs
2. 新建 tests/prefilter.test.mjs

### prefilter.mjs 必须导出的接口（严格按此签名，其它人在依赖它）

export const DEFAULT_TITLE_THRESHOLD = 0.35;
export const DEFAULT_PAGE_TOLERANCE = 0.05;
export const DEFAULT_MAX_CANDIDATES = 40;

export function normTitle(s)  —— 标题归一化：全角转半角、去空白与标点、转小写
export function diceCoefficient(a, b)  —— Dice 二元组相似度 0..1；两边都短于 2 字符时相等为 1 否则 0
export function comicPages(comic)  —— 库漫画总页数：累加 comic.chapters[].count（缺失时回退 images 数组长度）
export function prefilterUnits(units, comics, opts)

prefilterUnits 参数与返回：
  units  = [{ id, files: [文件名] }]  （查重侧单元）
  comics = [{ id, title, dir, chapters }]  （库漫画索引 == library-index.json 的 comics 数组）
  opts   = { titleThreshold, pageTolerance, maxCandidates }
  返回 { candidates, stats }
    candidates = [{ unitId, unitPages, matches: [{ libId, libTitle, libPages, titleScore, pageDiff, pageDiffRatio, reasons }] }]
    stats = { units, unitsWithCandidate, pairs, omittedUnits }
  规则：标题分 >= titleThreshold 且 |页差| <= max(3, ceil(unitPages * pageTolerance)) 才成为候选；
  matches 按 titleScore 降序，最多 maxCandidates 个；没有任何候选的单元不进 candidates 数组。
  reasons 是中文标签数组，例如 [标题] [页数]。
  stats.units = 输入单元总数；unitsWithCandidate = candidates.length；pairs = 所有 matches 之和；
  omittedUnits = 因为有候选但超过 maxCandidates 被截断的单元数。

### 已实测的标定数据（你的实现必须复现）
真实数据：140 个查重单元、266 部库漫画。T=0.35 / 页容差 5% 时应有 13 个单元有候选、13 个候选对，
且以下 5 个已知重复单元全部命中（标题相似度用 diceCoefficient 计算，误差允许 ±0.01）：
1. 「世界の終わりックス」をしよう（67 页）→ 库标题含 来做一场「世界终焉的爱」吧，分约 0.686
2. ～シスタークレアと淫らな秘密と噂の催眠アプリ～ フルカラー 総集編（85 页）→ シスタークレアと淫らな秘密と噂の催眠アプリ，约 0.833
3. ごちそうさま（194 页）→ ごちそうさま 謝謝招待 無修正，约 0.588
4. ジト目メイドさんとラブラブえっち（29 页）→ 同名，1.0
5. スマートグラスのラブアシストアプリを使って絶頂カウントえっち（26 页）→ 同名，1.0

### tests/prefilter.test.mjs 必须包含
- normTitle：全角转半角、去全角空格、去标点、小写
- diceCoefficient：相同为 1、完全不同为 0，并用上面 5 对真实字符串断言 0.686 / 0.833 / 0.588 / 1.0
- comicPages：累加 chapters[].count；chapters 缺失时回退 images.length；空对象为 0
- prefilterUnits：标题达标但页数不达标 → 不是候选；页数达标但标题不达标 → 不是候选；两者都达标 → 是候选
- 阈值边界：恰好等于 titleThreshold 应算命中（>= 语义）
- maxCandidates 截断与 omittedUnits 计数
- 用真实那 5 对字符串做断言：5 对全部产生候选

跑 node tests/run-tests.mjs prefilter 必须全绿。完成后回报：文件路径、导出清单、测试通过数、你没有做到的部分。
绝对不要改 engine/pipeline.mjs、engine/runner.mjs、index.mjs、public/ 下任何文件 —— 别人正在同时改它们。