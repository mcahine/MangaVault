# v2 任务书 · 下载模块（task-4）
> 项目根：C:\Users\D-001\Desktop\黄漫\MangaVault ｜ 先读 docs/MODULE_CONTRACT.md 与 docs/UI_GUIDELINE.md

## 你的任务：下载模块 v2 —— 内置登录 + 把 picacomic-downloader 能用的功能补齐并优化
你上一轮已交付搜索/下载/断点续传主干（120 断言全绿）。本轮用户要求：**内置登录模块**、**把参考项目里能用的功能都加上但要优化**、**按 v2 视觉重做界面**。

### A. 内置登录（本轮最高优先级）
1. POST /api/download/login {email, password, remember?} → 调上游 /auth/sign-in（body {email,password}，走你已实现的 HMAC 签名客户端）→ 拿到 token 后 ctx.saveConfig({picacomic:{token}}) 持久化，并拉 /users/profile 缓存到 data/download-account.json（昵称/等级/经验/头像/称号）；token 只回 hasToken 与预览，**绝不回传完整 token**
2. POST /api/download/logout → 清 token 与账号缓存
3. POST /api/download/register {email,password,name,inviteCode?} → 调 /auth/register（上游可能已关闭注册，失败要如实回中文原因）
4. GET /api/download/account → 账号信息 + token 有效性（10 分钟缓存，不要每次请求都打上游）
5. remember:true 时把邮箱密码存 data/download-credentials.json（**文件内写字段说明：本机明文、仅 127.0.0.1 可用**；接口默认只回 email 与 hasPassword）。做一层可逆混淆即可，**不要在文档里假装是加密**
6. token 失效自动清理 + 统一中文提示；登录成功后 SSE 广播 event: account 让前端刷新

### B. 对照 lanyeeee/picacomic-downloader 补齐（能用的都要，但要优化）
- **收藏夹同步**：GET /users/favorites?page=N 分页 → POST /api/download/favorites/sync {addAll?} 一键入队（已在本地跳过）；前端「收藏」页签
- **已下载漫画更新**：POST /api/download/update-check → 扫本地已存在漫画 → 拉上游章节比对 → 列出「有新章节」→ 一键增量下载新章节（不重下已有）
- **导出**：POST /api/download/export {comicIds, format:'zip'|'cbz'|'folder', outDir} —— 零依赖手写 ZIP（stored 或 zlib deflate + 正确中央目录/CRC32；CBZ 即换扩展名；folder 直接复制）。配置 picacomic.exportDir
- **代理模式**：picacomic.proxyMode: 'none'|'system'|'manual'；system 读 Windows 系统代理（reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" 解析 ProxyEnable/ProxyServer），manual 用 proxyHost/proxyPort；加 POST /api/download/proxy-test 连通性测试
- **下载格式**：Jpeg/Webp/Png/Original（Original 保留上游原扩展名）
- **运行时可变并发**：章/图并发与间隔、失败重试、可选全局限速 KB/s；POST /api/download/config 热更新（写回 config.json）
- **任务增强**：优先级、批量暂停/继续/取消/清空已完成、失败项一键重试（GET /api/download/tasks/:id/failures）、磁盘空间预检（不足直接拒绝 + 中文原因）、下载日志 tail
- 本地已下载按目录+章节判定，已完成章节默认跳过；封面/图片重命名/dirFmt 保持可配置

### C. 优化（用户点名「流畅好用」）
- SSE 节流：每 500ms 合并推送，按 taskId 分组，不要每张图推一次
- 前端任务列表 > 50 条虚拟滚动；章节弹窗 > 200 章分页/虚拟化
- 所有异步操作 100ms 内有视觉反馈；错误统一 toast + 中文；搜索防抖 300ms；封面 loading=lazy decoding=async

### D. 前端重做（UI_GUIDELINE v2）
页签：**登录 / 搜索入库 / 下载任务 / 收藏 / 导出**。用 .tabbar+.tab、.ledger、.stamp、.cut、.halftone、.label-mono、.num 等 v2 类，去掉全部玻璃拟态。登录页要有独立「未登录」空态与本机安全提示。

### E. 测试与文档
tests/download.test.mjs 扩到覆盖：登录请求体与签名头、token 保存与不回传、注销清空、收藏分页合并、更新检测增量、ZIP 打包（校验中央目录/CRC32/中文文件名，用临时目录解出字节比对）、三种代理模式解析、SSE 节流合并、配置热更新校验。全部离线 mock fetch，**不真连上游**。
docs/modules/download.md 更新接口表 + 登录时序 + 功能对照表（实现了哪些 / 上游不支持哪些 / 故意不做哪些）。

### F. 实测与纪律
- 用隔离实例真连一次上游（config 里 picacomic.proxy 已指向本机 Clash http://127.0.0.1:7897）验证**登录错误路径**：错误邮箱密码必须回中文 401，不能是英文异常；贴 curl 证据。**不要伪造登录成功**。
- 多库根：漫画库现在有 picacg（哔咔下载库）+ early（先期漫画）两个根，用 src/core/roots.mjs，不要硬编码 ctx.config.libraryRoot。
- 写入范围：src/modules/download/**、public/modules/download.js、public/modules/download.css、tests/download.test.mjs、docs/modules/download.md。**不要改他人文件**。
- 不新增 npm 依赖；不用反引号模板字符串；tests/ 下只允许 *.test.mjs。
- 服务：node src/server.mjs（8775，单实例锁）。冒烟测试用 $env:MV_DATA_DIR="$env:TEMP\mv-dl2"; node src/server.mjs，测完 kill，别动 Lead 的实例、别改 port。

