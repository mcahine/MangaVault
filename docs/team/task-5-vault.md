# v2 任务书 · vault 模块（task-5）
> 项目根：C:\Users\D-001\Desktop\黄漫\MangaVault ｜ 先读 docs/MODULE_CONTRACT.md 与 docs/UI_GUIDELINE.md

## 你的任务：新建 vault 模块 —— 标签系统做完善 + 把管理系统功能做全
用户原话：「把标签系统做完善」「对管理系统功能没有做全，希望能够把管理系统的功能做全」「管理系统包括 先期漫画/」。
**分工**：library 模块（Lead 所有）负责索引/列表/阅读/封面；你负责**加工层**——标签、元数据编辑、批量操作、校验、回收站、统计、导出导入。不要重实现 library 已有能力，也不要改它的文件。

### 写入范围（只有这些）
src/modules/vault/**、public/modules/vault.js、public/modules/vault.css、tests/vault.test.mjs、docs/modules/vault.md，数据文件 data/vault-*.json、data/vault-trash/**

### A. 标签系统（重点，要做透）
1. 模型：data/vault-tags.json = {tags:[{id,name,aliases:[],color:'red|pink|blue|cyan|yellow',group,description,createdAt}],updatedAt}；data/vault-comic-tags.json = { [comicId]: {add:[],remove:[],note:''} }（覆盖层，不改原始元数据）
2. **有效标签 = 自动标签 ∪ 覆盖层**：自动标签从元数据派生（tags / categories / 作者:xx / 汉化:xx / 根:哔咔下载库|先期漫画 / 话数:单话|多话 / 无元数据的标 来源:手工收录）；派生规则写进文档且可开关
3. 标签 CRUD：新建/改名/删除/合并（A→B，同时迁移覆盖层与别名）/别名（搜索归一化）/颜色/分组/描述
4. POST /api/vault/tags/assign {comicIds:[], add:[], remove:[]} 批量打标去标；GET /api/vault/tag/:id/comics?page&size 反查
5. GET /api/vault/tags/stats：出现次数、覆盖漫画数、总体积、按根分布、未被使用的标签
6. GET /api/vault/search?tags=a,b&mode=and|or&exclude=x&author=&root=&hasMeta=&minPages=&sort=；**保存为书架** POST/GET/DELETE /api/vault/shelves（名字+查询条件，可分组）
7. 标签导出/导入 JSON（merge 策略 skip/overwrite/rename）

### B. 管理功能补全（每项都要接口 + 前端入口）
1. **元数据编辑** POST /api/vault/comic/:id/meta → 改写该漫画 元数据.json（先备份 元数据.json.bak，原子写；无元数据的可新建）；改完刷新索引（通知 library 扫描）
2. **批量操作** POST /api/vault/batch {action, comicIds, options}：
   - rename-dirs 目录规范化（首尾空格/非法字符/全角空格/统一「N 标题」）—— **先 dry-run 出计划，确认后才执行**
   - move-to-root 库根之间移动（safeJoin + ownerRootOf 校验，跨盘则复制后删）
   - trash 移入 data/vault-trash/<时间戳>/...（保留原相对路径信息，可还原）、restore 还原、purge 永久删除（需 confirm:'DELETE'）
   - cover 替换/生成 cover.jpg；normalize-chapters 章节目录补零/重排 order
3. **文件校验** GET /api/vault/verify?root=&comicId= → 0 字节文件、图片头尾损坏（前 4 字节 + 尾部 EOI）、序号断档、章节元数据缺失/字段缺失、cover 缺失、目录名非法字符、超长路径；POST /api/vault/verify/fix 一键修复（重建 章节元数据.json、重排序号、生成缺失 cover）
4. **重复检测** GET /api/vault/duplicates → 同 id、标题归一化相同、目录名近似（包含关系/编辑距离）的候选组 + 置信度；只列不删
5. **统计** GET /api/vault/stats（总体积/按根/按标签/按作者 Top、体积排行、无标签漫画、单话 vs 多话、最近修改）+ POST /api/vault/reading-time {comicId,seconds} + GET /api/vault/reading-stats
6. **备份/恢复** POST /api/vault/backup → 把 data/library-index.json + 进度 + 收藏 + 标签 打包到 data/backups/（保留最近 10 份）；POST /api/vault/restore {file}（需 confirm）
7. **导出** POST /api/vault/export {comicIds, mode:'copy'|'zip', outDir}（若 download 模块已有导出能力则复用，文档写明分工，不要重复造）

### C. 前端（UI_GUIDELINE v2）
public/modules/vault.js + vault.css（类名前缀 mv-vault-）：页签 = **标签墙 / 批量操作 / 校验修复 / 回收站 / 统计 / 书架**。
标签云（大小=漫画数、颜色=标签色）+ 点选组合筛选 + 批量打标；批量操作要有 dry-run 预览与二次确认；回收站列出可还原项；列表虚拟滚动/分页；全部 v2 视觉（网点、切角、印章、台账行）。

### D. 测试（离线，临时目录）
覆盖：标签归一化与合并、别名搜索、有效标签计算（含自动标签规则）、批量 rename 计划生成（临时目录造样本，**不动真实文件**）、trash→restore 往返、校验器能发现 0 字节/断档/缺章节元数据、元数据编辑的备份与原子写、书架条件序列化。
docs/modules/vault.md：接口表、标签模型与派生规则、批量操作安全设计、校验项清单、与 library/download 的分工。

### E. 纪律
不新增 npm 依赖；不用反引号模板字符串；tests/ 下只允许 *.test.mjs；冒烟测试用 $env:MV_DATA_DIR 隔离目录，别动 Lead 的 8775 实例。

