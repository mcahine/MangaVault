# 桌面宿主（DESKTOP）

> 漫库的交付形态是 **Windows 原生 exe**：双击 MangaVault.exe 启动，窗口由 C# + WebView2 提供，
> 界面与业务逻辑由**内置的纯 Node 后端** + 原生前端渲染。
> 它**不是网页**，也不是「浏览器加了个壳」。本文件说明怎么构建、产物长什么样、宿主怎么工作、
> 原生能力怎么调，以及**自动化验证为什么要按现在这种方式做**（这里踩过坑，后来人务必先读第 6 节）。

---

## 1. 一句话架构

```
MangaVault.exe (C# / .NET Framework 4.x / WinForms + WebView2)
   │  ① 选一个空闲端口 → ② 隐藏窗口启动 node src/server.mjs → ③ 轮询 /api/ping 直到通过
   │  ④ 创建 WebView2 环境 → ⑤ 导航到 http://127.0.0.1:<port>/ → ⑥ 窗口即应用
   │
   ├─ 后端子进程（node.exe）  ← Job Object + Kill + taskkill /T /F 三重回收，绝不留孤儿
   └─ 反向长轮询 /api/desktop/native/next ← 领取「原生能力」命令并执行后回执
```

关键点：**原生能力（弹目录框、开资源管理器）只有 C# 宿主能做**，Node 后端做不了。
所以后端把宿主当成一个「反向长轮询的工人」，细节见第 5 节。

---

## 2. 构建

```powershell
cd MangaVault

node scripts/build-desktop.mjs                 # 产出 dist/
node scripts/build-desktop.mjs --clean         # 先清空 dist/ 再构建（推荐）
node scripts/build-desktop.mjs --with-node     # 额外把 node.exe 打进 dist/node/（绿色免安装包）
node scripts/build-desktop.mjs --out=D:\dist   # 换输出目录
```

零 npm 依赖：**不执行任何 npm install**，只用 node 内置模块 + 系统自带的 C# 编译器。

### 2.1 编译工具链

| 用途 | 位置 | 说明 |
| --- | --- | --- |
| C# 编译器 | C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe | **系统自带**，无需 Visual Studio。构建脚本自动探测 |
| WebView2 托管 DLL | desktop/refs/Microsoft.Web.WebView2.Core.dll、.WinForms.dll | 随代码发布（来自 NuGet 包 Microsoft.Web.WebView2），只作**编译期引用** |
| WebView2 原生加载器 | desktop/refs/WebView2Loader.dll | 同上，来自 build/native/x64/ |
| WebView2 运行时 | 用户机器上的 Evergreen Runtime | 实测 155.0.4283.45；Win10/11 通常已随 Edge 预装 |

> **NuGet 不是运行时依赖**。DLL 只是被拷进 desktop/refs/ 当作编译引用与产物载荷，
> 系统运行时不需要 NuGet、不需要 .NET SDK、不需要联网。

### 2.2 构建脚本会做的校验（防止静默出错）

1. 编译器 / 源码 / 三个 DLL 是否齐全 → 缺一个就**直接失败**并给中文原因
2. 编译后读 **PE 头**确认 Machine == 0x8664（x64）—— 架构不对会在 32 位机器上莫名起不来
3. 打印每个产物的字节数与 MangaVault.exe 的 sha256 前 16 位
4. 写 dist/build-info.json 供后续追溯
5. **输出目录安全闸门**（assertSafeOutputDir）：--clean 会递归删目录，属破坏性操作，
   删之前必须证明目标「确实是个构件目录」：
   必须是绝对路径、不能是文件系统根、不能是仓库根或其祖先。
   否则 --out=. 或 --out=C:\ 会把源码甚至整个盘删掉。已实测拒绝生效：

   <<F>>
   node scripts/build-desktop.mjs --out=.
   ✗ 拒绝把仓库根目录或其上级当作输出目录（--out 请指向一个构件目录）：C:\...\MangaVault   (exit 1)
   node scripts/build-desktop.mjs --out=C:\
   ✗ 拒绝把文件系统根目录当作输出目录：C:\                                                (exit 1)
   <<F>>

### 2.3 必须带 /codepage:65001

源码是 **UTF-8 无 BOM**，且含大量中文字面量（窗口标题、错误文案）。
不加 /codepage:65001 时 csc 会按系统 ANSI 解析，**界面上的中文全部变乱码**。
构建脚本已固定加上，改脚本时不要删。

---

## 3. dist 目录结构

```
dist/
├── MangaVault.exe                        原生宿主（约 72 KB）
├── Microsoft.Web.WebView2.Core.dll       托管 DLL ┐
├── Microsoft.Web.WebView2.WinForms.dll   托管 DLL ├ 必须与 exe 同目录（见 6.1）
├── WebView2Loader.dll                    原生加载器 ┘
├── icon.ico                              窗口/任务栏图标
├── build-info.json                       构建信息（见下）
├── node/node.exe                         可选，仅 --with-node 时有（约 88 MB）
├── app/                                  后端与前端
│   ├── src/                              业务代码
│   ├── public/                           前端资源
│   ├── desktop/                          ★ 必须打进来，见 3.1
│   ├── package.json
│   └── config.example.json
└── data/                                 运行时数据（首次启动自动生成）
    ├── window.json                       窗口尺寸位置记忆
    ├── host-trace.txt                    宿主 trace（排障用）
    ├── config.json  index.json  …        与普通运行一致
```

### 3.1 app/desktop/ 为什么必须打包

src/modules/desktop/index.mjs 会 import '../../../desktop/lib.mjs'
（窗口记忆、命令行拼装等纯函数层）。

**漏掉 dist/app/desktop/ 的后果非常隐蔽**：后端日志里只有一行
「模块 desktop 加载失败: Cannot find module ...」，
但**页面照常渲染、其它模块全部正常**，只是 /api/desktop/* 全部失效 ——
表现为「原生选目录点了没反应」。这是本项目真实踩过的坑，构建脚本已强制包含。
desktop/refs/（编译期 DLL）与 desktop/host/（C# 源码）不随包发布，构建时被过滤掉。

### 3.2 build-info.json 字段

| 字段 | 含义 |
| --- | --- |
| name / version | 应用名与版本 |
| builtAt | 构建时间（ISO） |
| csc | 实际使用的编译器绝对路径 |
| peMachine | "0x8664" 表示 x64 |
| exe.file / exe.bytes / exe.sha256_16 | 主程序文件名、字节数、sha256 前 16 位 |
| withNode | 是否内联了 Node 运行时 |
| appFiles | app/ 下的文件总数 |

---

## 4. 宿主进程模型

| 行为 | 实现 | 为什么这样做 |
| --- | --- | --- |
| **自选端口** | 从 8775 起 TcpListener 试绑 20 个端口，取第一个能绑的 | 避免和目标机器上已有服务打架；选了端口再启动后端，后端就不会顺延到别处 |
| **拉起后端** | Process.Start(node, "src/server.mjs")，CreateNoWindow=true，注入 MV_DATA_DIR / MV_DESKTOP=1 | 后端完全隐藏；数据目录由宿主决定，保证便携 |
| **等待就绪** | 轮询 GET /api/ping 直到响应含 MangaVault（上限 60s） | 不靠 sleep 猜时间；后端未就绪时不会白屏 |
| **单实例** | 后端自身的 data/server.lock.json + /api/ping 探测 | 复用既有机制，不重复造 |
| **窗口即应用** | 标题「漫库 MangaVault」、最小 1024×640、基准 1440×900 | 窗口就是产品，不是浏览器标签页 |
| **尺寸位置记忆** | data/window.json（width/height/x/y/maximized），写入用临时文件 + 改名（原子） | 下次打开回到原样；最大化时记 RestoreBounds，还原时不会跳成满屏尺寸 |
| **多显示器安全** | 恢复位置前检查该矩形与任一屏幕工作区交集 ≥ 160×100 | 显示器拔掉后窗口不会跑到看不见的地方 |
| **关窗 = 退出** | FormClosed → 收尾并 Exit | 不留后台幽灵进程 |
| **回收子进程** | ① Process.Kill() → ② taskkill /PID x /T /F 兜底 → ③ **Job Object**（KILL_ON_JOB_CLOSE） | 三重保险。宿主哪怕被强杀/崩溃，Job 句柄关闭时 Windows 会连坐杀掉 node |
| **后端死亡看护** | 每 1s 检查子进程是否退出 + 每 3s 探 /api/ping，连续 4 次失败就收摊 | 后端死了不该留一个空白外壳 |
| **外部链接** | target=_blank 被拦截，交给系统默认程序打开 | 不在应用窗口里再开窗口 |

### 4.1 窗口记忆的边界语义

- 小于下限（1024×640）的宽高一律**抬到下限**，不判为坏数据
- 大于 16000 判为坏数据 → 回退基准尺寸并居中
- 文件损坏 / 不是 JSON → 静默回退基准尺寸，**不抛错**

---

## 5. 原生能力

### 5.1 后端路由

| 路由 | 作用 | 成功返回 |
| --- | --- | --- |
| GET  /api/desktop/info | 形态信息 | { platform, appVersion, mode, exe, native:{attached,commands,protocols} } |
| POST /api/desktop/open-external {url} | 系统默认程序打开 | { ok:true, opened, via:"host" 或 "cmd start" } |
| POST /api/desktop/reveal {path} | 资源管理器定位 | { ok:true, path, kind:"file" 或 "dir", root:{id,name} } |
| POST /api/desktop/pick-dir {title} | 原生选目录 | { ok:true, path:"<绝对路径>" } |
| POST /api/desktop/quit?confirm=1 | 退出应用 | { ok:true, quitting:true } |
| GET  /api/desktop/native/next | **宿主编用**：领取命令 | { ok:true, id, kind, url?, path?, title? } |
| POST /api/desktop/native/result | **宿主编用**：回执 | { ok:true } |

mode 取值：**webview2** = 跑在 exe 宿主里（native.attached=true）；**web** = 只是浏览器打开的页面。

### 5.2 工作原理（反向长轮询）

后端**弹不出**系统对话框，只有 C# 宿主能。所以：

```
前端  --POST /api/desktop/pick-dir-->  后端：命令入队，请求挂起等回执
                                        ↑
宿主  --GET /api/desktop/native/next--  ← 长轮询取走命令（最多挂 20s，取不到就空手重连）
       执行 FolderBrowserDialog
宿主  --POST /api/desktop/native/result {id, result}-->  后端：唤醒挂起的前端请求
```

- 状态机在 src/modules/desktop/bridge.mjs，**纯逻辑、可离线单测**
- 宿主每次长轮询都带 pid / exe 作为**心跳**；后端据此判定 attached，
  心跳有效期 30s（hostTtlMs）—— 不做超时的话，「宿主已被杀」会被永远误判成「在线」
- 选目录前端会给足 5 分钟（用户要亲自去点），其余命令 15s 超时

### 5.3 安全白名单

**open-external** —— 只允许 http / https / mailto（src/modules/desktop/guard.mjs）。

> **允许外网地址是刻意设计，不要改回「只允许回环」。**（v3 裁决，已批准）
> v2 的 validateLocalUrl 只允许 127.0.0.1/localhost，但 exe 是**原生桌面应用**，
> 用户点「帮助 / 官网 / 项目主页」必须能出去；回环限制对 exe 场景没有安全价值。
> 真正的风险面是**协议**与**命令注入**，这两条都已经堵住（见下）。
> 本服务只监听 127.0.0.1，且打开动作需用户显式点击触发。

明确拒绝 file: / javascript: / data: / vbscript: 等协议：它们能借
「用系统默认程序打开」执行本地代码或脚本。同时拒绝含控制字符（CR/LF）的地址 ——
CR/LF 可以借参数拆分注入第二条命令。

打开优先交给宿主（走 ShellExecute，不经过 cmd.exe）。仅在宿主不在线时降级为
cmd /c start，且降级前必须通过 isCmdSafeUrl：
因为 cmd.exe 会把 & | < > ^ % 当成自己的元字符，而 Node 的 spawn（未开 shell）
不转义它们，http://x/?a&calc 会被拆成两条命令 —— 这是真实的命令注入面。

**reveal** —— 只允许定位**库根之内**且**真实存在**的路径。

- 否则任何能访问本机端口的程序都能拿它遍历整个磁盘
- 用 path.relative 判定归属，**不是**字符串前缀比较（否则 C:\lib2 会被误判为在 C:\lib 内）
- 嵌套库根时取最长的匹配根
- 拒绝时**不回显**候选库根路径，避免变成目录结构探测工具

### 5.4 错误码约定（前端可据此区分）

| 场景 | 状态码 |
| --- | --- |
| 协议不在白名单 / 参数非法 / 标题过长 | 400 |
| 路径不在库根内、缺少 path | 403 |
| 库根内路径不存在 | 404 |
| **宿主不在线** | 503 + 中文提示（不是 500） |
| **用户在对话框点了取消** | 409 + 「用户取消了目录选择」（可预期的正常结果） |
| 宿主执行失败 | 502，把宿主的中文原因透传 |
| 宿主迟迟不回执 | 504 |

宿主不在线时一律给**明确中文**降级提示（例如「桌面宿主（MangaVault.exe）没有在运行，
无法弹出系统目录选择框。请手动填写路径，或改用桌面版。」），绝不甩英文栈或裸 500。

---

## 6. 自动化验证（★ 后来人务必先读这一节）

```powershell
node scripts/dev/desktop-selftest.mjs                 # 自动点火 exe 自检并断言 16 条
node scripts/dev/desktop-selftest.mjs --keep          # 保留 trace 便于排查
node scripts/dev/desktop-selftest.mjs --timeout=90000
node tests/run-tests.mjs desktop                      # 后端路由离线单测（154 条）
```

### 6.1 坑一：托管 DLL 必须与 exe 同目录

Microsoft.Web.WebView2.Core.dll 与 Microsoft.Web.WebView2.WinForms.dll
**必须和 MangaVault.exe 放在同一目录**。

否则 CLR 在 JIT Main 时找不到类型，进程**静默秒退、无任何报错、无任何输出** ——
因为 winexe 连控制台都没有，异常也来不及写出来。这是本项目最难查的坑。

构建脚本已经把三个 DLL 拷到 exe 同级；**别手动搬动它们**。
自查手段就是宿主「**启动即写 trace**」：进程真的跑起来时 data/host-trace.txt 第一行就有 BOOT。

### 6.2 坑二：GUI 进程会逃逸父进程的作业范围

MangaVault.exe 是 GUI 程序。**在自动化框架里前台等它结束，会连带把 worker 杀掉**，
表现为「连接中断、终端停止运行」。

正确做法（desktop-selftest.mjs 已实现）：

```js
const child = spawn(exe, ['--selftest'], { detached: true, stdio: 'ignore', windowsHide: false });
child.unref();          // 立刻放手，绝不 await
// 然后只轮询读 trace 文件，等 "DONE OK" 或超时
```

配套要求：**让 exe 自己退出**。--selftest 模式就是为此存在的 ——
它在页面渲染完成后写快照、自己 Environment.Exit，退出码 0。
所以自动化**永远不要**用 spawnSync、也不要在同一个进程里等它。

### 6.3 坑三：trace 每行都带毫秒前缀

trace 形如：

```
    243  PORT-CHOSEN 8775
   3178  SCRIPT "{\"title\":\"漫库 MangaVault\",...}"
   3230  DONE OK
```

**行首有 NNN  （右对齐的毫秒数）**，所以 /^DONE OK/ 永远匹配不上，
脚本会一路空等到超时后才误报失败。正确的匹配要容忍前缀：/(^|\n)\s*\d+\s+DONE OK/。

### 6.4 坑四：ExecuteScriptAsync 不等待 Promise

CoreWebView2.ExecuteScriptAsync **不会 await 页面里的 JS Promise**。
往页面里注入一个 async IIFE，拿回来的是 Promise 序列化后的 "{}"，不是结果。

因此自检里的原生能力桥探测**走纯 HTTP**（TryGet / TryPostResp），
它同样能证明「后端队列 → 宿主轮询线程 → 执行 → 回执」整条链路，且不依赖页面 JS 语义。

### 6.5 坑五：CoreWebView2 成员只能在 UI 线程调用

在非 UI 线程碰 CoreWebView2 会抛
InvalidOperationException: CoreWebView2 members can only be accessed from the UI thread。

宿主里的写法：异步续体用
ContinueWith(..., TaskScheduler.FromCurrentSynchronizationContext()) 回到 UI 线程；
**绝不在 UI 线程上 .Result / .Wait()**（WebView2 的回调要回到 UI 线程，阻塞它会自我死锁）。
只有纯 HTTP / 纯计算才丢进 Task.Run。

> 参考实现 _spike/wv2host/Program.cs 正是栽在这条上：
> 它在 Form.Shown 里对 CreateAsync(...).Result 阻塞等待，实测**永远卡死在 ENV-OK 之后**，
> 进程不退出。本宿主全程不用阻塞等待，因此 --selftest 能正常收尾。

### 6.6 自检断言（16 条）

desktop-selftest.mjs 断言下列真实证据：

| # | 断言 | 证明了什么 |
| --- | --- | --- |
| 1 | trace 非空 | 进程真的启动了（启动即留痕） |
| 2 | BOOT pid=... selftest=True | Main 跑到了 |
| 3 | PORT-CHOSEN 端口非 0 | 自选端口成功 |
| 4 | SERVER-PID 非空 | **exe 自己拉起了 node 后端** |
| 5 | BOOT-PING True | /api/ping 通过 |
| 6 | SHOWN | 窗口真实显示 |
| 7 | ENV-OK version= | WebView2 运行时环境创建成功 |
| 8 | WV2-READY | WebView2 控件就绪 |
| 9 | NAVCOMPLETE ok=True | 页面导航成功 |
| 10 | SCRIPT ... "title":"漫库 MangaVault" | 页面**真的渲染出**了漫库界面 |
| 11 | SERVER-ALIVE-AFTER-KILL False + **独立复核 pid 已消失** | 关闭后无孤儿 node |
| 12 | BRIDGE-ATTACHED True mode=webview2 | 宿主心跳被后端认到 |
| 13 | BRIDGE-CANCEL-OK True | 取消选目录 → 409 + 中文原因（不是 500） |
| 14 | BRIDGE-PROBE-RESULT True | 原生能力桥**真实往返**成功 |
| 15 | SHUTDOWN OK + DONE OK | 正常收尾 |
| 16 | 收尾状态是 OK 而非 BRIDGEFAIL | 桥探测失败会让整个自检失败 |

第 11 条刻意做得比字符串断言更硬：除匹配 trace 声明外，还会拿解析出的 SERVER-PID
去 process.kill(pid, 0) **独立复核那个 pid 真的没了** —— 伪造 trace 骗不过这一条。

第 12–14 条是**真的走了一遍 HTTP**：宿主 POST /api/desktop/pick-dir，
命令经后端队列交给宿主自己的轮询线程，宿主执行后回执，最终拿到 409。
这条链路断了，自检就红。

---

## 7. 数据与路径

| 内容 | 位置 |
| --- | --- |
| 数据目录 | --data-dir= > MV_DATA_DIR > exe 同级 data/（便携）> %LOCALAPPDATA%\MangaVault\ |
| 窗口记忆 | <数据目录>/window.json |
| 宿主 trace | <数据目录>/host-trace.txt（超过 256 KB 自动重写） |
| WebView2 用户数据 | %LOCALAPPDATA%\MangaVault\webview（浏览器内核缓存，**不是**漫画数据） |

整个 dist/ 可以拷到任意位置直接运行（**绿色免安装**）。
要脱离「目标机器需装 Node.js」，构建时加 --with-node：
宿主会优先使用 dist/node/node.exe。

### 7.1 命令行参数

| 参数 | 作用 |
| --- | --- |
| --selftest | 自检模式：页面渲染完 + 桥探测完就写快照并自退出，退出码 0；**不弹任何对话框** |
| --selftest-ms=N | 自检整体超时（默认 40000） |
| --data-dir=<路径> | 指定数据目录 |
| --trace=<文件> | 指定 trace 文件路径 |

---

## 8. 与 v2 的关系

v2 的「桌面端」是 desktop/app.mjs + Edge --app= 开窗口，用户明确否定（要的是原生 exe）。
v3 起正交形态是 **WebView2 宿主 exe**。

desktop/app.mjs、desktop/sysinfo.mjs、desktop/shell/（浏览器扩展）等 v2 资产
**保留**以兼容既有脚本与测试，但**不再是主交付路径**；
public/modules/desktop.js 这个「把桌面做成页面模块」的产物已按任务书移除，
桌面状态改由 /api/desktop/info 提供。

---

## 9. 排障速查

| 现象 | 先查什么 |
| --- | --- |
| 双击 exe 闪一下就没了 | 托管 DLL 是否与 exe 同目录（6.1）；data/host-trace.txt 最后一行停在哪 |
| 窗口起来但白屏 | trace 里有没有 BOOT-PING True；app/src/server.mjs 是否存在 |
| 界面中文全是乱码 | 构建是否漏了 /codepage:65001（2.3） |
| 点「选目录」没反应 | app/desktop/ 是否被打进包（3.1）；/api/desktop/info 的 mode 是不是 webview2 |
| 自检永远等超时 | trace 匹配是否忘了毫秒前缀（6.3） |
| 自检把终端搞断 | 是不是在前台等 GUI 进程（6.2） |
| 关闭后还有 node 在跑 | 看 trace 的 SERVER-ALIVE-AFTER-KILL；正常应为 False |
