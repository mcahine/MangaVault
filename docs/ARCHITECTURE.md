# 漫库架构说明

> 读者：要动框架层（`src/core/**`、`src/server.mjs`）或想搞清「程序是怎么跑起来的」的人。
> 面向使用者的说明在 [README.md](../README.md)；工程铁律与已知坑在 [AGENT.md](../AGENT.md)。

---

## 1. 为什么是零依赖 + 原生前端

- 目标机器上装 npm 依赖要联网、要编译，失败率高；而本项目需要的只是「列目录 + 读 JSON + 发文件」，Node 标准库完全够用；
- 原生前端（ESM + DOM 构造器）**没有构建步骤**，改完刷新即生效，也没有 CDN 依赖；
- 副作用是：**任何人都能用记事本改代码并立刻看到效果**，不需要工具链知识。

这条约束是硬性的：后端**不得** import 任何非 `node:` 前缀的裸模块名。

---

## 2. 进程模型

v3 的形态是**一个 exe 宿主 + 一个内部 Node 内核**，两者是父子进程：

```text
MangaVault.exe  (C# + WebView2 宿主：窗口 / 窗口记忆 / 生命周期；原生能力桥见 2.3)
   |
   +-- 启动时 spawn --> node.exe  app/src/server.mjs   (业务内核，无窗口)
   |                       +-- MV_DATA_DIR=<数据目录>、MV_DESKTOP=1
   |                       +-- 只监听 127.0.0.1:<port>
   |                       +-- 写 <数据目录>/server.lock.json + URL.txt
   |
   +-- WebView2 控件加载 http://127.0.0.1:<port>/  --> public/ 前端

关闭窗口 --> 宿主杀掉后端子进程 --> 不留孤儿 node 进程
```

| 角色 | 职责 | 说明 |
| --- | --- | --- |
| **exe 宿主** | 窗口、图标、最小尺寸、尺寸位置记忆、退出；并作为**原生能力执行者**响应后端的反向长轮询（外部程序 / 资源管理器定位 / 目录选择对话框） | 不包含任何业务逻辑 |
| **Node 内核** | 配置、HTTP、模块装配、扫描、下载、查重 | 不知道窗口的存在 |
| **WebView2** | 渲染 `public/` 前端 | 只与 `127.0.0.1` 通信 |

**进程生命周期**（源码模式 `node src/server.mjs` 时只有内核，没有宿主）：

```text
启动 -> loadConfig(true) -> 检查单实例锁 -> createApp -> 挂载模块
     -> listenWithFallback(port, 20)  <- 端口被占则 +1 重试
     -> 写 server.lock.json / URL.txt
     -> 等待 SIGINT / SIGTERM -> shutdown() -> 逐模块 dispose() -> exit
```

### 2.1 单实例保护

`src/server.mjs` 启动时读 `data/server.lock.json`（含 `pid` / `port` / `url`），做三重校验：

1. 锁文件存在且字段完整；
2. `process.kill(pid, 0)` 说明进程还活着（否则视为**陈旧锁**）；
3. `GET /api/ping` 返回 `name === 'MangaVault'`（否则端口上是别的服务）。

三条都过 → 打印已有地址并 `exit(0)`，**不起第二个实例**。这避免两个进程同时写 `data/*.json` 把索引写坏。

### 2.2 端口自动避让

目标端口被占用时依次 `+1` 重试（最多 20 次），只对 `EADDRINUSE` 重试，其它错误直接抛出。
真实地址写入 `data/URL.txt`，并打印到控制台（**不要假设端口一定是 8775**）。

### 2.3 当前实现状态（如实说明）

| 部件 | 状态 |
| --- | --- |
| Node 内核（`src/server.mjs` + `src/modules/**`） | ✅ 已实现并运行 |
| 前端（`public/`） | ✅ 已实现 |
| **exe 宿主**（`desktop/host/Program.cs`，C# + WebView2） | ✅ **已实现并产出**：`dist/MangaVault.exe`，x64 PE（machine `0x8664`），构建脚本 `scripts/build-desktop.mjs` |
| 宿主 ↔ 后端 **原生能力桥**（`/api/desktop/native/next` · `/result`，状态机 `src/modules/desktop/bridge.mjs`、安全判定 `guard.mjs`） | ✅ 已实现（实测 `info` / `reveal` / `open-external` / `native/next` 均有正确响应与拒绝） |
| v2 的 Edge `--app=` 方案（`desktop/app.mjs` + `启动漫库.vbs`） | 仍保留，作为**无 exe 环境的过渡形态**；v3 已不推荐 |

本节描述的架构**主体已落地**；仍待办的项（独立验收、`docs/DESKTOP.md`）见 [team/v3-progress.md](team/v3-progress.md)。

---

## 3. 请求生命周期

```text
WebView2 / 浏览器 -> createApp().handler
  +-- parseBody（JSON / 表单 / 文本，上限 8 MB）
  +-- 中间件（当前为空）
  +-- 路由匹配（:param，HEAD 复用 GET）
  |    +-- ctx.json / ctx.file / ctx.sse
  +-- 静态托管 public/（/api/* 未命中不会落到静态）
```

`ctx.file()` 统一处理：`stat -> ETag/Last-Modified -> 304 -> Range(206) -> 流式写出 -> 客户端断开时销毁流`。
所以封面和正文图片都自带缓存协商与断点续传能力，前进后退不会重下。

**错误约定**：handler 抛出的错误由框架统一兜底成 `{ ok:false, error:'中文原因' }` + 对应状态码。
因此「有 `await` 但没 `try/catch`」是契约允许的；但**能给用户更好提示的地方应当显式捕获**。

---

## 4. 数据流

```text
磁盘（用户漫画目录）
   |  扫描（纯读）
   v
data/library-index.json  <-- 原子写（标脏 -> flush）
   |  只读视图（mtime 缓存）
   +--> library 模块   -> 列表 / 详情 / 封面 / 正文图
   +--> reader 模块    -> 章节图片流（并读写 data/library-progress.json）
   +--> vault 模块     -> 标签、统计、校验、批量整理（可写回漫画目录，dry-run 优先）
   +--> download 模块  -> 已在库识别（下载落盘后需手动重扫）
   +--> dedupe 模块    -> 与库比对的基准
```

**数据归属**：

| 数据 | 位置 | 谁写 |
| --- | --- | --- |
| 漫画本体 | 用户的库根目录 | 用户；vault 批量整理 / dedupe 删除会改（均可回滚） |
| 配置 | `data/config.json` | `src/core/config.mjs` |
| 索引 | `data/library-index.json` | library 模块（原子写） |
| 阅读进度 / 收藏 | `data/library-progress.json` / `library-marks.json` | `src/core/reading-progress.mjs` |
| 标签 / 覆盖层 / 书架 / 阅读时长 / 回收站 | `data/vault-*.json` + `data/vault-trash/` | vault 模块 |
| 下载任务 | `data/download-tasks.json` | download 模块 |
| 查重产物 | `data/dedupe/` | dedupe 模块 |
| 日志 | `data/mangavault.log` | `src/core/log.mjs`（轮转 + EPIPE 静音） |

### 4.1 扫描与索引

```text
scanLibrary(root)
  +-- 列库根目录（跳过 . 与 _ 前缀）
  +-- pool(8) 逐部解析 scanComic()
  |    +-- 读 元数据.json（id/title/author/tags/chapterInfos…）
  |    +-- 章节发现：含图子目录 -> 章节；否则下探一层（旧结构）；再否则「顶层直接放图」= 单章
  |    |   !! cover.jpg 绝不能被当作正文（曾导致 196 部全部退化成 1 话）
  |    +-- 逐文件 stat 汇总 count/bytes，图片名按自然序排序
  +-- 聚合 facets（标签/作者/分类 top-N）
  +-- 原子写 data/library-index.json
```

索引写入遵守 **「标脏 → flush」** 约定：`JsonStore.flush()` 在未标脏时直接返回，
因此赋值 `store.data = result` 之后必须 `store.markDirty()`（这条踩过坑，已写进单测）。

读取侧统一走 `core/library-index.mjs`（mtime 缓存）。任何模块都**不允许**把索引快照进自己的内存，
否则扫描完成后该模块会持续报「漫画不存在」。

格式契约（四种形态、元数据字段、健全度分级）见 [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md)。

---

## 5. 代码与数据分离

这是 v3 最重要的架构约束之一。**数据永不属于代码仓库。**

### 5.1 数据目录的确定顺序

由 `src/core/config.mjs` 的 `dataDir()` 决定，**惰性求值**（不能在模块加载时算：先被导入的模块会把路径钉死，这是真实踩过的坑）：

| 顺序 | 来源 | 场景 |
| --- | --- | --- |
| 1 | 环境变量 `MV_DATA_DIR` | 测试、多实例隔离 |
| 2 | 命令行 `--data-dir=<路径>` | 指定任意位置 |
| 3 | 环境变量 `MV_PORTABLE=1` → 程序同级 `data/` | 便携模式 |
| 4 | `%LOCALAPPDATA%\MangaVault\`（回退 `~/AppData/Local`） | **默认**，安装模式 |

相关导出：`dataDir()` / `dataPath(...parts)` / `configFile()` / `resetDataDir()`。

### 5.2 配置文件从模板生成

- 模板 `config.example.json` **随代码发布**（提交进仓库），里面不含任何用户数据，只有默认值与注释键（以 `//` 开头的键会被 `stripComments()` 过滤掉）。
- 首次启动时 `ensureConfigFile()` 把模板拷成数据目录里的 `config.json`；**之后改的是那份，不要改模板**。
- 配置文件**一定在数据目录内**，代码目录永不写入用户配置。

### 5.3 为什么这样设计

| 好处 | 说明 |
| --- | --- |
| 升级不丢数据 | 替换程序目录不会碰到数据目录 |
| 仓库干净 | 漫画、索引、日志、token 都不进版本库（`.gitignore` 已忽略 `data/`、`config.json`、`dist/`、`*.exe`） |
| 可多实例 | 换一个 `MV_DATA_DIR` 就是一套独立环境 |
| 可测试 | 单测把数据目录指向 `os.tmpdir()`，绝不污染真实数据 |
| 可便携 | 绿色包放在 U 盘上，`MV_PORTABLE=1` 就让数据跟着程序走 |

---

## 6. 模块隔离

| 关注点 | 做法 |
| --- | --- |
| 写冲突 | 每个模块只写自己的目录 + `data/<模块>-*.json`；索引与进度由共享模块串行写 |
| 越权 | 契约文件明确规定写入范围，Lead 只读审查 |
| 崩溃隔离 | `loadModules` 逐个 `try/catch`，单模块导入失败只标红不拖垮服务 |
| 前端隔离 | 外壳 `try/catch` 动态 import 页面模块，渲染失败只影响该页 |
| 契约 | [MODULE_CONTRACT.md](MODULE_CONTRACT.md)：统一 `{ok:true}` / `{ok:false,error:'人话'}`、统一 SSE 事件名、统一中文文案 |

模块注册表在 `src/modules/index.mjs`（**只由 Lead 改**）。当前装载 6 个模块：
`library` · `reader` · `vault` · `download` · `dedupe` · `desktop`。

---

## 7. 并发与限速

- 磁盘扫描：`pool(dirNames, 8)`；
- 下载：章级 `chapterConcurrency` + 章间隔、图级 `imgConcurrency` + 图间隔（预约式限速器，取号后各 worker 并行，不会被压成串行）；
- 全局任务并发 ≤ 2；
- 同名单飞（扫描/下载调度）重复触发返回 **409**，避免重复劳动与写冲突。

---

## 8. 安全设计

| 面 | 做法 |
| --- | --- |
| 网络暴露面 | 只监听 `127.0.0.1`，不对局域网/公网开放 |
| 路径穿越 | 请求参数拼出的路径一律过 `safeJoin` / `ownerRootOf` / `requireInsideRoot`，越界 400 |
| 任意文件读取 | 图片接口要求文件名属于该章节清单 |
| 凭据 | 哔咔 token 只存后端，前端只拿 `hasToken` + 预览串 |
| 破坏性操作 | dry-run 优先 → 确认 → 执行 → 可回滚；永久删除需明确确认文本 |
| 外链 | 桌面桥白名单 `http/https/mailto`，拒绝其它协议 |

---

## 9. 可测试性设计

- `MV_DATA_DIR` + **惰性 `dataDir()`**：单测可把数据目录指向临时目录；
- 测试运行器逐个用例文件收集断言，失败不中断其他文件；
- 所有网络/外部进程在测试里被替换或跳过，测试 **100% 离线**（用本地假服务器模拟上游）；
- 破坏性验收脚本在 `finally` 里复原被改动的配置与目录。

跑法见 [AGENT.md](../AGENT.md) 第 9 节，或直接 `node tests/run-tests.mjs`。

### 9.1 ⚠️ 临时目录必须校验绝对路径（真实踩坑）

**症状**：项目根下凭空出现 `undefined\temp\<前缀>-<时间戳>\` 垃圾目录。

**根因**：DSH 的 `run_code` 执行环境里 `process.env` 是**空对象**（`Object.keys(process.env).length === 0`），
不是完整继承的系统环境。于是：

```text
process.env.TEMP        === undefined
os.tmpdir()             === "undefined\\temp"      ← os.tmpdir() 本身就不可靠！
path.isAbsolute(tmpdir) === false
path.join(os.tmpdir(), "x") === "undefined\\temp\\x"   ← 相对路径
```

这个相对路径会落到 **`process.cwd()`** 之下（即项目目录），而不是系统临时目录。

> 注意：这条规则比「不要用 `process.env.TEMP`」更进一步 —— **`os.tmpdir()` 同样不可信**。
> 在 `pwsh` 里 fork 出的 node 环境是完整的（`process.env` 有 100+ 键，`os.tmpdir()` 正常），
> 所以仓库里的测试平时跑起来没问题；只有**直接在 `run_code` 进程内**算临时路径才会踩到。

**正确写法**（候选依次回退 + 绝对路径断言，拿不到就报错退出，绝不静默落盘）：

```js
import os from 'node:os';
import path from 'node:path';

function safeTmpDir(prefix) {
  const candidates = [os.tmpdir(), process.env.TEMP, process.env.TMP, 'C:\\Windows\\Temp'];
  for (const base of candidates) {
    if (!base) continue;
    const p = path.join(base, prefix + '-' + Date.now());
    if (path.isAbsolute(p)) return p;          // 关键守卫
  }
  throw new Error('找不到可用的绝对临时目录');   // 宁可失败，不要写脏数据
}
```

**配套要求**：

1. 临时目录**用完必须清理**；Windows 文件句柄有释放延迟，`rm` 失败要 `sleep` 后重试一次。
2. 后台起的进程（如探测用的 `node src/server.mjs`）**必须在同一个流程里 kill**，
   否则会留下孤儿进程继续占端口 —— 本项目也真的踩过一次（一个探测实例占着 8775 不放）。
3. `.gitignore` 里有 `undefined/` 兜底，但那是**事后止损**，不能替代上面的守卫。

> 现存的 11 个测试/脚本文件都在用未加守卫的 `os.tmpdir()`。它们在 `pwsh` 下运行正常，
> 但**不应被直接搬进 `run_code` 进程内运行**。若要统一加固，建议加一个共享的 `safeTmpDir()` 工具函数。

---

## 10. 桌面宿主的进程模型与验证方式

### 10.1 进程模型

```text
MangaVault.exe  (C# + WebView2 宿主，--target:winexe，无控制台)
   |  1. 解析参数，第一件事就是写 trace（启动即留痕）
   |  2. PickFreePort(8775) 选第一个空闲端口
   |  3. spawn node app/src/server.mjs
   |     环境变量：MV_DATA_DIR=<数据目录>、MV_DESKTOP=1
   |  4. WaitForHttp 轮询 /api/ping 直到通过
   |  5. BuildWindow + WebView2 导航到 http://127.0.0.1:<port>/
   |  6. Watchdog 定时器：既看护后端存活，又长轮询原生能力桥
   v
关闭窗口 -> 收掉后端子进程 -> 不留孤儿 node（taskkill /PID <server-pid> /T）
```

| 决定 | 取值 |
| --- | --- |
| 数据目录 | 默认 `dist\data\`（便携，跟随程序）；`--data-dir=DIR` 可改 |
| 窗口标题 / 最小尺寸 | 「漫库 MangaVault」/ **1024×640** |
| 窗口记忆 | 数据目录的 `window.json`（越界或缺失则主屏居中） |
| 自检 trace | 数据目录的 `host-trace.txt`，超过 256 KB 自动重写 |
| WebView2 用户数据 | `%LOCALAPPDATA%\MangaVault\webview\`（**不随 `--data-dir` 走**，是宿主固定选的位置） |
| 收掉后端 | 先 `Kill()`，失败再兜底 `taskkill /PID <pid> /T /F`，最后确认进程真的没了 |

### 10.2 ⚠️ 运维教训：GUI 进程会逃逸父进程的作业范围

**这是本项目付出过真实代价才学到的规则。**

WebView2 宿主是 GUI 进程。它一旦被拉起，就**不再受父进程（DSH 后台作业）的进程范围约束**：
在 `run_code` 里前台等待它结束，会让 worker 被连带杀掉，表现为**连接中断、终端停止**。

**因此自动化验证必须遵守**：

1. **让 exe 自己退出**：以 `--selftest`（可配 `--selftest-ms=<毫秒>`，下限 5 秒）运行，它跑完整个链路后写入证据并自行收尾；
2. **证据写在文件里，不在 stdout 里**：`--target:winexe` 是 Windows 子系统程序，**没有控制台**，stdout 拿不到任何东西。唯一的证据来源是 `dist\data\host-trace.txt`；
3. **fire-and-forget 点火**：`spawn(...)` 后立刻 `child.unref()`，**绝不 await / 绝不 `spawnSync`**；
4. **另起一次调用读证据**：点火与读取分开，或轮询 trace 直到出现 `DONE OK`；
5. **不要在同一个 `run_code` 里等待 GUI 进程**；需要后台执行时用 `run_in_background: true` 点火。

> 现状：`dist/data/host-trace.txt` 曾被一次误操作（想重跑 selftest 但连接中断）删除，需要时用下面的命令重新生成。
> 依据见 [team/v3-progress.md](team/v3-progress.md) 的「运维教训」一节。

### 10.3 怎么跑（可复现）

```powershell
# 1) 构建（产出 dist\MangaVault.exe 与同目录的三个 WebView2 DLL）
node scripts/build-desktop.mjs

# 2) 让 exe 自检：fire-and-forget 点火，轮询 trace，断言 12 条证据
node scripts/dev/desktop-selftest.mjs
node scripts/dev/desktop-selftest.mjs --keep     # 保留 trace 便于排查
```

`desktop-selftest.mjs` 断言的 12 条证据（trace 关键词）：

| # | 证据 | 含义 |
|---:|---|---|
| 1 | trace 非空 | 启动即留痕 |
| 2 | `BOOT pid=… selftest=True` | 进程真的跑起来了 |
| 3 | `PORT-CHOSEN <n>` | 自选了可用端口 |
| 4 | `SERVER-PID <n>` | exe 自己拉起了 node 后端 |
| 5 | `BOOT-PING True` | 后端 `/api/ping` 通过 |
| 6 | `SHOWN` | 窗口真实显示 |
| 7 | `ENV-OK version=…` | WebView2 运行时环境创建成功 |
| 8 | `WV2-READY` | WebView2 控件就绪 |
| 9 | `NAVCOMPLETE ok=True` | 页面导航成功 |
| 10 | `SCRIPT {…"title":"漫库 MangaVault"…}` | 页面**真实渲染**出界面（不只是加载了 HTML） |
| 11 | `SERVER-ALIVE-AFTER-KILL False` **且独立复核该 pid 已消失** | 关闭后无孤儿 node —— 最硬的一条：不只看字符串，还独立探测进程 |
| 12 | `SHUTDOWN OK` + `DONE OK` | 正常收尾 |

### 10.4 最容易踩的坑：三个 DLL 必须与 exe 同目录

`Microsoft.Web.WebView2.Core.dll`、`Microsoft.Web.WebView2.WinForms.dll`、`WebView2Loader.dll`
**必须和 `MangaVault.exe` 放在同一目录**。少任何一个，CLR 会在 JIT `Main` 阶段找不到类型，
进程**静默秒退、不弹任何错误**。这也是宿主「启动第一件事就写 trace」的原因 —— 否则这种情况无从排查。

相关文件：

| 文件 | 作用 |
| --- | --- |
| `desktop/host/Program.cs` | 宿主源码（编译用系统自带的 `csc.exe`，无需 Visual Studio） |
| `desktop/refs/*.dll` | 随代码发布的 3 个 WebView2 引用库 |
| `scripts/build-desktop.mjs` | 构建脚本（校验 x64 PE、写 `build-info.json`） |
| `scripts/dev/desktop-selftest.mjs` | 自动自检（12 条断言） |
| `dist/build-info.json` | 构建清单：编译器路径、PE machine、exe 体积与 SHA256 |

### 10.5 原生能力桥：为什么是反向长轮询

**问题**：后端是纯 Node 进程，弹不出 Windows 系统对话框，也定位不了资源管理器窗口。
这些能力只有宿主（C#）有。但**前端调用的却是后端的 HTTP 接口** —— 中间需要一个转交机制。

**做法**：不让后端去连宿主（宿主是 GUI，没有固定端口也不好暴露），而是让**宿主主动长轮询**后端。

```text
前端  --POST /api/desktop/pick-dir-->  后端（把命令压入队列，挂起等待）
                                          ^
                            宿主 --GET /api/desktop/native/next-->（领到命令，弹原生对话框）
                            宿主 --POST /api/desktop/native/result-->（回执）
                                          v
前端  <--200 {ok:true, path:...}--  后端（把结果还给挂起的那个请求）
```

| 部件 | 文件 | 职责 |
| --- | --- | --- |
| 命令队列 / 状态机 | `src/modules/desktop/bridge.mjs` | 入队、长轮询挂起、回执唤醒、超时 |
| 安全判定 | `src/modules/desktop/guard.mjs` | 协议白名单、`reveal` 路径必须落在库根内且真实存在 |
| 宿主侧执行 | `desktop/host/Program.cs` | 轮询 `native/next`、真正调用系统 API、回 `native/result` |
| 固定路由 | `src/modules/desktop/index.mjs` | `info` / `open-external` / `reveal` / `pick-dir` / `quit` |

**安全边界**（都在 `guard.mjs`）：

- 外链只允许 `http` / `https` / `mailto` —— 拒绝 `file://`、`javascript:`、UNC 等；
- `reveal` 只允许定位**库根以内**且真实存在的路径 —— 越界返回 **403**；
- `GET /api/desktop/info` 会如实报告 `native.attached`：宿主没在跑时为 `false`，前端据此降级，而不是静默失败。

> 实测（隔离数据目录起服务后直接调接口）：`GET /api/desktop/info` 返回 `ok:true` 且带 `native.commands` 与白名单协议；
> `POST /api/desktop/reveal` 传库根外路径返回 **403**；`POST /api/desktop/open-external` 传 `file://` 返回 **400**；
> `GET /api/desktop/native/next?timeout=1` 返回 `{ok:true, kind:null}`（无命令时正常空轮询）。
