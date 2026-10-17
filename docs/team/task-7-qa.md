# v2 任务书 · 质量守门人（task-7）
> 项目根：C:\Users\D-001\Desktop\黄漫\MangaVault ｜ 先读 docs/MODULE_CONTRACT.md 与 docs/UI_GUIDELINE.md

## 你的任务：项目卫生 + 独立审计 + 端到端集成测试（不写业务代码）
用户明确要求「保持项目卫生」「流畅好用」。你不修改任何业务模块，只写工具/测试/审计报告，把问题**报告给 Lead 或对应 owner**。

### 写入范围（只有这些）
scripts/**、tests/integration.test.mjs、docs/AUDIT.md、.gitignore（可补充）

### 1. scripts/tidy.mjs（卫生工具，零依赖）
--dry-run（默认）与 --apply；扫描并报告：
- 临时残留：**/*.tmp-*、data/*.png（验证截图）、孤立 data/server.lock.json（pid 已死）、空目录
- 大文件：> 8MB 的日志、data/library-index.json 体积、重复备份
- 源码卫生：业务代码里的 console.log、TODO/FIXME、未使用的 data/*.json、> 300 行的单文件、.bak 堆积
- 依赖卫生：全项目不应出现非 node: 且非相对路径的 import（零依赖红线），扫描并列违规
--apply 只做**安全清理**（.tmp- 残留、死锁文件、> 30 天日志、验证截图），**任何源码与用户漫画绝不动**

### 2. scripts/audit.mjs → 生成 docs/AUDIT.md
静态审计输出表格：
- 文件清单（按模块：文件数/行数/最大文件）
- **安全**：请求参数拼路径处是否都过 safeJoin / ownerRootOf；列出可疑的 path.join(...ctx.query) 位置（文件:行号）
- **健壮性**：async handler 是否有 try/catch 或抛给框架；fs 调用是否都有错误处理；SSE 断连是否清理；定时器是否 unref
- **性能**：一次性渲染大列表、无 pool 的批量 IO、每请求重读大文件、未节流的 SSE
- **v1 视觉残留**：grep backdrop-filter | filter:\s*blur | linear-gradient(1[0-9]{2}deg | border-radius:\s*999 | --grad- 并列出文件:行号（用户点名要消灭的「AI 风味」）
- **文档一致性**：文档写的接口是否都能在代码里找到（抓 app.get/post/del('...') 与 docs 表对比）
每条给：文件:行号 + 严重度（高/中/低）+ 建议责任模块。**发现问题不要自己改，写进报告并 send_message 通知 Lead。**

### 3. tests/integration.test.mjs（端到端，离线）
在 os.tmpdir() 造多根样本（一个根有元数据+多章节、一个根是「图片直接躺在漫画目录」的单章形态），然后：
- 直接 import createApp + 各模块 register，用假 ctx（config 指向临时根、MV_DATA_DIR 指向临时目录）组测试内实例，app.createServer() + 随机端口 + Node 原生 fetch 打真实 HTTP
- 断言链路：多根扫描 → /api/library/comics 含两个根 → 详情 → 图片 200 → Range 206 → /api/reader/chapter → 进度写回 → /api/library/continue → 越界 400 → 模块 dispose 不崩
- 全程不联网、不写用户数据；失败给可读中文断言信息

### 4. .gitignore 补充（data/、日志、验证截图、临时目录）

### 5. 验收
- node scripts/tidy.mjs（dry-run）与 node scripts/audit.mjs 都跑通并产出 docs/AUDIT.md
- node tests/run-tests.mjs integration 全绿，且真的走 HTTP（不是只 import）
- 报告给出**当前项目卫生评分 + Top 10 问题清单**（文件:行号 + 严重度），并 send_message 给 lead

### 6. 关于 v1→v2 并行
其他队友正在把界面改到 docs/UI_GUIDELINE.md 的 v2 规范；你审计 v1 残留时**以该文件为准**，发现残留写进报告与通知，不要直接改他人文件。

