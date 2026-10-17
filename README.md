# 漫库 MangaVault

> 把散落在磁盘上的漫画目录，变成**可检索、可阅读、可整理、可下载**的私人图书馆。
> Windows 桌面应用：**零第三方运行时依赖**（纯 Node.js ESM + 原生前端，无构建步骤、无 npm 依赖树），服务只监听 `127.0.0.1`。
>
> 版本：**v3** ｜ 视觉主题 **RISOPRINT · 深夜制本所**（见 [docs/UI_GUIDELINE.md](docs/UI_GUIDELINE.md)）
> 文档总入口：**[docs/INDEX.md](docs/INDEX.md)**（30 秒找到任何东西）

---

## 这是什么

一个**本地的**漫画中枢。它不提供、不托管、不分发任何漫画内容 —— 你把自己的漫画目录挂载成「库根」，它负责：

| 能力 | 说明 |
| --- | --- |
| **管理** | 多库根扫描索引、元数据编辑、标签体系、批量整理、回收站、备份 |
| **阅读** | 单页/双页/条漫、日漫从右往左、缩略图条、阅读进度与时长 |
| **下载** | 对接哔咔（PicACG）：搜索 / 收藏夹 / 章节下载 / 断点续传 / 导出（**需自备 token**，详见下文） |
| **查重** | SHA-256 字节查重 + 像素指纹全库比对 + 人工审核 + 安全删除/还原 |

**它只认格式，不认来源。** 只要磁盘上的目录符合 [docs/LIBRARY_FORMAT.md](docs/LIBRARY_FORMAT.md)，加进配置就能被完整管理 —— 新增一个漫画来源 = 新增一条配置，不改一行代码。

### 当前实测规模

| 项 | 值 |
| --- | --- |
| 漫画 | **249 部**（2 个库根：哔咔下载库 196 部 / 先期漫画 53 部） |
| 章节 | 1,265 话 |
| 图片 | 68,026 张 |
| 占用 | **26.5 GB** |
| 全库扫描 | 约 17 秒（本机 SSD） |

---

## 怎么装

### 前置条件

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | **Windows 10 / 11（x64）** | 桌面宿主是 Windows 专有的 x64 PE（machine `0x8664`） |
| Node.js | **>= 20.11**（实测 v24.18.0） | 源码模式必需；绿色版用 `--with-node` 构建时会把 `node.exe` 打进 `dist\node\`，目标机器就不用装了 |
| WebView2 Runtime | Win11 自带；Win10 可能需要装 | exe 宿主用它渲染界面 |
| 构建工具 | **系统自带的 `csc.exe`**（.NET Framework 4.x） | 只有「自己构建 exe」才需要；用现成 `dist\` 则不用 |
| 浏览器 | 任意现代浏览器 | 只有源码模式（方式 B）时才需要，用来访问界面 |

本项目**不需要** `npm install`，仓库里**没有**第三方依赖。

### 方式 A · 绿色版 exe（推荐）

**构建**：

```powershell
node scripts/build-desktop.mjs              # 产出 dist\（需要本机已装 Node.js）
node scripts/build-desktop.mjs --with-node  # 额外把 node.exe 打进 dist\node\，做免安装包
node scripts/build-desktop.mjs --clean      # 先清空 dist\ 再构建
node scripts/build-desktop.mjs --out=D:\dist   # 换输出目录
```

构建使用**系统自带的 C# 编译器**（`csc.exe`，.NET Framework 4.x），不需要 Visual Studio，也不装任何 npm 包。
构建脚本会校验产物是 **x64 PE**（machine `0x8664`），并把编译器路径、体积、SHA256 记进 `dist\build-info.json`。

**运行**：双击 `dist\MangaVault.exe`。

**产物结构**：

```text
dist\
  MangaVault.exe                        桌面宿主（C# + WebView2）
  Microsoft.Web.WebView2.Core.dll       托管 DLL —— 必须与 exe 同目录
  Microsoft.Web.WebView2.WinForms.dll   托管 DLL —— 必须与 exe 同目录
  WebView2Loader.dll                    原生加载器 —— 必须与 exe 同目录
  icon.ico                              窗口/任务栏图标
  build-info.json                       构建清单（编译器等、PE machine、SHA256）
  app\                                  后端与前端代码树
    src\          后端（模块、core、server.mjs）
    public\       前端（index.html、theme.css、app.js、modules\）
    package.json
    config.example.json
  node\node.exe                         （仅 --with-node 时存在）
  data\                                 数据目录（首次运行自动创建，见下文）
```

> ⚠️ **那三个 DLL 必须和 exe 放在同一目录**。少任何一个，宿主会在 JIT Main 阶段找不到类型，
> 表现为**进程静默秒退、不弹任何错误**。这是本项目踩过的最难查的一个坑。

**首次运行会发生什么**：

| 行为 | 说明 |
| --- | --- |
| **自选端口** | 从 8775 起找第一个空闲端口（被占用则递增），不写死端口 |
| **拉起后端** | exe 自己 spawn `app\src\server.mjs`（通过 `MV_DATA_DIR` 指向数据目录、`MV_DESKTOP=1` 标记形态），并等 `/api/ping` 通过 |
| **数据目录** | 默认 `dist\data\`（**便携模式**：数据跟着程序走）。传 `--data-dir=DIR` 可改为任意位置 |
| **窗口** | 标题「漫库 MangaVault」，最小尺寸 **1024×640** |
| **窗口记忆** | 尺寸与位置记在数据目录的 `window.json`，下次启动还原（越界或缺失则主屏居中） |
| **写地址** | 数据目录的 `URL.txt` 里是本次的真实访问地址 |
| **关闭窗口 = 退出应用** | 宿主会同时收掉自己拉起的 node 后端，不留孤儿进程 |
| **首次使用** | 数据目录里的 `config.json` 从 `app\config.example.json` 播种；库根默认是空的，需要你自己去「设置 → 库根」添加 |

**exe 自检（可复现验证）**：

```powershell
node scripts/dev/desktop-selftest.mjs
```

它让 exe 用 `--selftest` 自己跑一遍并退出，然后读它写下的 `dist\data\host-trace.txt` 断言 12 条证据
（后端被拉起、`/api/ping` 通过、WebView2 环境就绪、窗口显示、页面真实渲染、关闭后无孤儿 node 等）。

| 依赖 | 说明 |
| --- | --- |
| Node.js | 不打包 `node.exe` 时，目标机器需要有 Node.js 20+；用 `--with-node` 构建则免安装 |
| WebView2 Runtime | Win11 自带；Win10 可能需要单独安装 |

**原生能力**：exe 宿主既是窗口，也是「本机能力执行者」。后端通过**反向长轮询**（`/api/desktop/native/next` ↔ `/result`）把命令转交给宿主执行，因此界面上的操作能真正调用系统对话框与资源管理器：

| 能力 | 路由 |
| --- | --- |
| 桌面形态与宿主信息 | `GET /api/desktop/info` |
| 用系统默认程序打开链接 | `POST /api/desktop/open-external`（白名单 `http` / `https` / `mailto`） |
| 资源管理器定位文件/目录 | `POST /api/desktop/reveal`（**限库根以内**） |
| 原生选目录对话框 | `POST /api/desktop/pick-dir` |
| 退出应用 | `POST /api/desktop/quit` |

> 宿主未在运行时，这些接口会明确返回「宿主未连接」，而不是静默失败。

### 方式 B · 源码运行（开发 / 排障）

```powershell
cd MangaVault
node src/server.mjs          # 启动本地内核，控制台会打印真实地址
```

启动后打开控制台给出的地址（默认 `http://127.0.0.1:8775/`）即可。

仓库里还留有 v2 时代的三个便捷入口，**它们不是 v3 的交付形态**，仅在没有 exe 时作为替代：

| 脚本 | 作用 |
| --- | --- |
| `启动漫库.bat` | 前台启动（可看日志、退出码可见），排障时用 |
| `启动漫库.vbs` | 隐藏窗口启动（无黑框），并负责「重启内核」（退出码 66）的外层循环 |
| `打开漫库.bat` | 已在运行时只开窗口，没在运行就完整启动一次 |

这三者都基于 `desktop/app.mjs`（Node 启动器 + Edge/Chrome `--app=` 窗口），也就是 v3 要替换掉的 v2 方案。

### 首次使用

1. 启动后进入 **设置 → 库根**，把你的漫画目录添加为库根（可加多个）。
2. 到 **漫画库** 点「扫描库」，等待索引建立。
3. 如果某个目录是「图片直接躺在里面」的裸形态，它依然能被识别；想让信息更完整，见 [docs/LIBRARY_FORMAT.md](docs/LIBRARY_FORMAT.md) 的健全度分级。

---

## 怎么用

### 界面速览

| 页面 | 你能做什么 |
| --- | --- |
| **漫画库** | 浏览/搜索/筛选/排序、收藏、查看库体检、继续阅读 |
| **阅读器** | 单页/双页/条漫切换、适应高度/宽度/原始、日漫方向、缩略图条、进度与时长 |
| **下载** | 登录哔咔、搜索、收藏夹、建下载任务、暂停/恢复/取消、断点续传、导出 ZIP/CBZ |
| **管理台** | 标签墙、批量整理、校验修复、回收站、统计、书架、备份 |
| **查重** | 扫描重复内容、人工审核、安全删除/还原 |
| **设置** | 库根、端口、代理、下载并发与格式、库体检 |
| **关于** | 版本、路径、模块状态、快捷键 |

### 快捷键

| 键 | 作用 |
| --- | --- |
| `Ctrl+K` | 命令面板（模糊搜索页面与操作） |
| `Ctrl+1…9` | 切换页面 |
| `Ctrl+R` | 重新加载当前页 |
| `/` | 聚焦搜索框 |
| `←` `→` | 阅读器翻页（**随日漫方向自动反向**） |
| `空格` | 阅读器下一页 |
| `M` / `F` / `R` / `T` | 模式 / 适应 / 方向 / 缩略图 |
| `Enter` | 阅读器全屏 |
| `Esc` | 关闭浮层 / 退出阅读 |

---

## 库根与格式契约

**库根**是一份目录清单，写在数据目录的 `config.json` 里：

```jsonc
"libraryRoots": [
  { "id": "picacg", "name": "哔咔下载库", "path": "C:/comics/picacg", "enabled": true },
  { "id": "early",  "name": "先期漫画",   "path": "C:/comics/early",  "enabled": true }
]
```

- 库根下的**一级子目录**就是一部漫画，这是系统的最小管理单元。
- 以 `.` 或 `_` 开头的一级子目录会被跳过（留给你放杂物）。
- 支持四种形态：L2 规范形态 / L1 多章无语义 / L0 裸形态 / L1+ 深一层兼容。
- **缺元数据不会导致拒绝识别**：信息越少功能越少，但永远能扫描和阅读。

完整规范（字段表、章节结构、封面优先级、健全度分级 A/B/C/D、标题规范化规则、接入新来源的步骤）见
**[docs/LIBRARY_FORMAT.md](docs/LIBRARY_FORMAT.md)** —— 那是数据与代码之间唯一的接口定义。

---

## 下载能力（如实说明）

下载功能对接哔咔（PicACG），**需要你自己的账号 token**，本项目不提供、不内置任何账号。

| 项 | 现状 |
| --- | --- |
| token | **必须由你自行配置**（下载页登录，或写入配置） |
| 有效性 | 在 `GET /api/download/state` 中以 `tokenOk` 字段如实返回 |
| 本机实测 | token **已失效**（`tokenOk: false`）—— 搜索/详情会返回「token 无效或已过期」，请重新登录 |
| 网络 | 本机**直连上游会超时**，需要在设置里配置 HTTP 代理（当前配置指向 `http://127.0.0.1:7897`） |
| 代理协议 | 只支持 HTTP 代理（内置 CONNECT 隧道）；**不支持 socks5** |
| **已有**的能力 | 登录/注册/找回密码、账号资料、搜索、漫画详情、章节列表、**收藏夹浏览与同步**、增量更新检测、建下载任务（单章/整本/批量）、任务暂停/恢复/取消/优先级、**断点续传**（已存在的图片跳过，0 字节视为未完成重下）、失败清单与重试、导出 ZIP/CBZ、代理检测 |
| **尚未提供**的能力 | **排行榜**（Taskbook T3 待补）、图片级续传进度落盘（当前按文件大小判断完成度） |
| 不支持的 | 任何上游写操作（评论/点赞/充值等）；不做图片转码 |
| 落盘 | 按 [docs/LIBRARY_FORMAT.md](docs/LIBRARY_FORMAT.md) 的规范结构写入下载根目录，下载完可被漫画库直接索引 |

**重要**：下载完成后**不会自动重扫索引**（避免下载中途反复扫库）。去「漫画库」点一次「扫描库」即可看到新内容。

---

## 文件位置

### 数据目录（你的数据都在这）

按优先级从高到低确定：

| 顺序 | 方式 | 用途 |
| --- | --- | --- |
| 1 | 环境变量 `MV_DATA_DIR` | 测试 / 多实例隔离 |
| 2 | 命令行 `--data-dir=<路径>` | 指定任意位置 |
| 3 | 环境变量 `MV_PORTABLE=1` → 程序同级 `data/` | 便携模式 |
| 4 | **`%LOCALAPPDATA%\MangaVault\`** | 默认（安装模式） |

**绿色版 exe 的实际情况**：宿主默认就走**便携模式** —— 数据落在 `dist\data\`（程序同级），
并以 `MV_DATA_DIR` 传给后端进程。想改到别处就启动时传 `--data-dir=<路径>`（例：`MangaVault.exe --data-dir=D:\MVdata`）。
直接跑 `node src/server.mjs`（方式 B）时，才按上表第 4 条落到 `%LOCALAPPDATA%\MangaVault\`。

数据目录里有什么：

| 文件 / 目录 | 内容 |
| --- | --- |
| `config.json` | 配置：库根、端口、代理、下载参数、查重阈值（首次启动从 `config.example.json` 生成） |
| `library-index.json` | 漫画索引（扫描产物，可随时重建） |
| `library-progress.json` / `library-marks.json` | 阅读进度、书签/收藏 |
| `vault-tags.json` / `vault-comic-tags.json` | 标签注册表、标签覆盖层 |
| `vault-shelves.json` / `vault-reading.json` / `vault-trash.json` | 书架、阅读时长、回收站台账 |
| `vault-trash/` | 回收站里的实际漫画目录（**移动**过来的，不是副本） |
| `download-tasks.json` | 下载任务状态（含断点续传进度） |
| `dedupe/` | 查重产物：扫描结果、指纹、缩略图、决策、隔离区 |
| `backups/` | 管理台备份包（默认保留最近 10 份） |
| `mangavault.log` | 服务日志 |
| `server.lock.json` / `URL.txt` | 单实例锁与当前访问地址 |
| `window.json` | 桌面窗口尺寸与位置记忆（仅 exe / 桌面模式） |
| `host-trace.txt` | exe 宿主的启动自检留痕（仅 `--selftest` 或排障时生成） |

> 代码与数据**严格分离**：数据目录里的一切都不属于代码仓库，升级/替换程序不会碰它们。
> 仓库内的 `data/` 只是开发默认，已被 `.gitignore` 忽略。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

### 程序位置

| 形态 | 位置 |
| --- | --- |
| 绿色版 | 你解压 `dist\` 的目录（程序同级 `data/` 可用便携模式） |
| 源码 | 仓库根目录；`src/` 后端、`public/` 前端、`desktop/` 宿主 |

---

## 数据备份

### 用管理台备份（推荐）

「管理台 → 备份 → 立即备份」会打包 **7 个 JSON** 到数据目录的 `backups/`：

库索引、阅读进度、收藏、标签注册表、标签覆盖层、书架、阅读时长。默认**自动保留最近 10 份**。

恢复：「管理台 → 备份」选一份 → 输入 `RESTORE` 确认。

> ⚠️ 备份**不含漫画图片本体**，也不含查重产物与下载任务。图片请自行用文件管理器/网盘备份。

### 手工备份整个数据目录

直接复制 `%LOCALAPPDATA%\MangaVault\`（或你的 `MV_DATA_DIR`）即可。
其中只有 `config.json` 与 `vault-*.json` / `library-*.json` 是真正需要保留的；
`library-index.json`、`dedupe/`、日志都可以删掉后重建。

### 漫画本体

漫画在你的库根目录里，**从未被复制或移动到数据目录**（唯一例外：管理台「回收站」与查重「隔离删除」会把目录移走，都可还原）。
备份漫画 = 备份你自己的库根目录。

---

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 端口不是 8775 | 正常：被占用会自动顺延（最多尝试 20 个），真实地址见控制台与 `data/URL.txt` |
| 提示「漫库已经在运行」 | 单实例保护生效。需要重启就结束该进程，或删除 `data/server.lock.json` |
| 漫画库是空的 | 设置页确认库根路径 → 漫画库点「扫描库」 |
| 改了库根但页面还是旧数据 | 配置是原地更新的，一般立刻生效；仍不对就 `Ctrl+R` 刷新 |
| 封面显示不出来 | 该目录没有 `cover.jpg`（阅读器会用首章首图兜底）；「漫画库 → 体检」或「管理台 → 校验」可查 |
| 下载报 401 | token 过期。到「下载」页重新登录（本机 token 目前就是失效状态） |
| 下载一直转圈/超时 | 本机直连上游不通，去设置配 HTTP 代理 |
| 下载完了漫画库看不到 | 设计如此：不会自动重扫，去「漫画库」点一次「扫描库」 |
| 查重没有缩略图 | 缺 Python + Pillow 时降级为纯 SHA-256 字节查重（页面会提示） |
| 要重建索引 | 删掉数据目录里的 `library-index.json`，重新扫描 |
| 数据误删了 | 「管理台 → 回收站」还原；或「管理台 → 备份」恢复 |
| 界面卡在加载 | 检查内核是否还活着（控制台/日志）；`Ctrl+R` 刷新当前页 |
| 想找回日志 | 数据目录的 `mangavault.log`（服务日志）；启动器日志在 `desktop.log` |
| 双击 exe **闪一下就没了**、没有任何报错 | 极可能是 `dist\` 里缺了 WebView2 的三个 DLL（托管 DLL ×2 + `WebView2Loader.dll`）。它们**必须与 exe 同目录**，缺一个就是静默秒退 |
| exe 起来了但页面是白的 | 看数据目录的 `host-trace.txt` 最后几行定位（`NAVFAIL` / `SCRIPT-FAIL` / `BOOT-TIMEOUT`） |
| `%LOCALAPPDATA%\MangaVault\` 里出现了 `webview` 目录 | 正常：那是 WebView2 的用户数据目录，由 exe 固定使用 LOCALAPPDATA，不跟随 `--data-dir`；想清理就删掉它 |

---

## 卸载

1. **关闭程序**（关窗口，或结束 `MangaVault.exe` / `node` 进程）。
2. **删除程序目录**：绿色版直接删 `dist\`；源码模式直接删仓库目录。
3. **按需删除数据目录**：
   - 绿色版 exe：`dist\data\`（在程序目录里，第 2 步已经一并删掉了）；
   - 源码模式：`%LOCALAPPDATA%\MangaVault\`，或你设置的 `--data-dir` / `MV_DATA_DIR`。
   ⚠️ 里面可能有回收站与备份 —— 删之前先确认不需要还原任何东西。
4. **删掉 WebView2 的用户数据**（可省，约几十 MB）：`%LOCALAPPDATA%\MangaVault\webview\`。
   注意这个目录**不随 `--data-dir` 走**，它由 exe 宿主固定选在 LOCALAPPDATA 下，所以删掉 `dist\` 不会带走它。
5. **你的漫画目录不受影响**，程序从未修改过库根下的结构（除你主动执行的整理/查重操作外）。

> 程序**不写注册表**（除你主动开启的「开机自启」项 `HKCU\...\Run\MangaVault`，关闭自启即删除）。
> 若曾开启自启，建议在卸载前先在设置里关掉。

---

## 安全边界

- 只监听 `127.0.0.1`，不对局域网/公网开放。
- 所有由请求参数拼出的文件路径都经过 `safeJoin` / `ownerRootOf` / `requireInsideRoot` 校验，越界一律 400。
- 图片接口要求文件名属于该章节的清单，杜绝任意文件读取。
- 哔咔 token 只存后端，前端只能拿到 `hasToken` 与预览串。
- 破坏性操作一律 **dry-run 优先**：先出计划、再确认、可还原；永久删除需明确确认文本（回收站 `DELETE` / 恢复 `RESTORE`）。
- 零第三方依赖：全项目只 import Node 标准库与相对路径。

---

## 开发与测试

```powershell
node src/server.mjs                 # 启动内核（开发模式）
node tests/run-tests.mjs            # 全量测试
node tests/run-tests.mjs vault      # 只跑名字含 vault 的用例
node scripts/build-desktop.mjs      # 构建桌面 exe → dist\
node scripts/dev/desktop-selftest.mjs  # 让 exe 自检并断言 trace（12 条证据）
node scripts/dev/ui-scroll-check.mjs   # 真浏览器验证列表滚动
node scripts/audit.mjs              # 静态审计 → docs/AUDIT.md
node scripts/tidy.mjs               # 工程卫生检查（默认 dry-run）
```

- 测试**全部离线**，在临时目录造样本，设 `MV_DATA_DIR` 隔离数据目录，**绝不触碰真实漫画**。
- ⚠️ **临时目录必须校验是绝对路径**：某些执行环境（如 DSH 的 `run_code`）里 `process.env` 是空对象，
  此时 `os.tmpdir()` 会返回**相对路径** `undefined\temp`，`path.join` 出来的目录会静默落进当前工作目录（本项目真的踩过一次）。
  正确写法：拿到候选路径后先 `path.isAbsolute()` 断言，不通过就依次回退（详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 第 9 节）。
- 贡献代码前请先读 [AGENT.md](AGENT.md)（工程铁律）与 [docs/MODULE_CONTRACT.md](docs/MODULE_CONTRACT.md)（模块契约）。
- 当前进度与被验收项见 [docs/team/v3-progress.md](docs/team/v3-progress.md)。
- ⚠️ **验证 GUI（exe）时不要在前台等它**：GUI 进程会逃逸后台作业范围。用 `desktop-selftest.mjs`（fire-and-forget 点火 + 只读 trace 文件），原理见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 来源与声明

- 下载能力拆解自 [lanyeeee/picacomic-downloader](https://github.com/lanyeeee/picacomic-downloader)，目录结构与签名算法保持兼容。
- 查重能力迁移自本机的 `picacg处理/查重模块`，判定口径完整保留。
- 本项目是**本地文件管理工具**，不提供、不托管、不分发任何漫画内容，也不内置任何破解或绕过能力。
- 所有内容由使用者自行获取并存放于自有磁盘；下载能力只对接使用者自己的账号与合法来源。请遵守你所在地区的法律法规与内容平台条款。
