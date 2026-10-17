# v2 任务书 · 查重模块（task-6）
> 项目根：C:\Users\D-001\Desktop\黄漫\MangaVault ｜ 先读 docs/MODULE_CONTRACT.md 与 docs/UI_GUIDELINE.md

## 你的任务：查重模块 v2 —— 多库根适配 + 按新视觉重做 + 卫生
你上一轮交付很干净（59 断言全绿、35/35 HTTP 验收、真实 5937 图扫描）。本轮三件事：

### 1. 多库根适配（必做）
漫画库现在有两个根：picacg（哔咔下载库 196 部）与 early（先期漫画 53 部）。
用 src/core/roots.mjs（roots / activeRoots / rootById / ownerRootOf / probeRoots）改造：
- 查重比对库从单一 libRoot 扩展为**多根**：config.dedupe.libRoots（数组，缺省 = config 的 libraryRoots）+ 旧 libRoot 兼容
- 扫描结果每个单元标注命中章节所属根（libRootId / libRootName）；缩略图接口在多根下必须用 ownerRootOf 正确定位
- GET /api/dedupe/state 返回所有根的存在性与目录数（probeRoots）
- 单元列表支持 ?libRoot=id 筛选
**注意**：先期漫画的图片直接躺在漫画目录里（没有「1 第1話」子目录），章节映射要能处理「目录即章节」形态，不要漏匹配。

### 2. 视觉重做（UI_GUIDELINE v2）
public/modules/dedupe.js + dedupe.css 全部改到 v2：去掉玻璃拟态/渐变 → RISO 印刷风：网点对比图、切角卡片、硬投影、判定用印章 .stamp（完全重复=朱红、同图不同编码=黄、部分重复=蓝、未找到=纸白）、统计用 .num + .ledger、进度用硬边分段条。横向对比要一眼分辨「本单元 vs 库内」。

### 3. 项目卫生
- 清理 src/modules/dedupe/dev/**：保留一个最有价值的（建议 e2e）移到 scripts/dev/dedupe-e2e.mjs，其余删除
- 确认 tests/ 下只允许 *.test.mjs
- 删掉不再引用的旧代码/常量，docs 里画一张模块内文件依赖图

### 4. 验收
- node --check 全通过；node tests/run-tests.mjs dedupe 全绿，且**新增多根断言**（ownerRootOf 校验、目录即章节映射、按根筛选）
- 隔离实例（MV_DATA_DIR）用**真实样本**（%TEMP% 造一个小库根 + 一个小查重目录）跑：扫描 → 判定 → 决策 → 隔离删除 → 还原，贴逐步输出
- 用 msedge --headless --screenshot 截新的查重页一张图，确认符合 v2 规范（贴路径）

### 5. 纪律
写入范围：src/modules/dedupe/**、public/modules/dedupe.js、public/modules/dedupe.css、tests/dedupe.test.mjs、docs/modules/dedupe.md。不要改他人文件；不新增 npm 依赖；不用反引号模板字符串。冒烟测试用隔离数据目录，别动 Lead 的 8775 实例。

