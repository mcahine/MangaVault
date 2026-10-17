# 桌面模块（desktop）

> 归属：desktop-smith ｜ 后端：`src/modules/desktop/index.mjs` ｜ 启动器：`desktop/app.mjs` + `desktop/lib.mjs` + `desktop/sysinfo.mjs` + `desktop/log.mjs`
> 外壳：`desktop/shell/`（Edge/Chrome 扩展，注入主世界）｜ 入口：`启动漫库.vbs` ｜ 图标：`assets/icon.ico` / `assets/icon.png`
> 职责：把「本地 127.0.0.1 的网页」变成**桌面窗口**——拉起内核、用 Edge/Chrome 的 App 模式开独立窗口、记忆窗口尺寸位置、关窗即退出；并暴露一组本机能力接口（形态信息、窗口上报、重启/退出、白名单外链、开机自启、日志尾部）。
> 一句话：**服务端只管本机能力，窗口本体由 `desktop/app.mjs` 拉起。**

---

## 1. 它解决什么问题

| 真实痛点 | desktop 的答案 |
|---|---|
| 产品是"网页"，打开要输地址、有地址栏和标签页，不像应用 | 用 Edge/Chrome 的 **`--app=URL` 模式**开独立窗口（无地址栏/标签页、独立任务栏图标） |
| 每次启动窗口都是默认大小、跑偏到屏幕角落 | `data/desktop-window.json` **记忆尺寸与位置**，首次运行按主屏工作区居中 |
| 双击 `.bat` 会闪黑框，用户以为卡死 | `启动漫库.vbs` 用 `shell.Run(cmd, 0, True)` **隐藏窗口**启动，全量日志写 `data/desktop.log` |
| 内核崩了要手动重启 | 启动器自带**最多 N 次自动重启**（`--restarts`，默认 3）；另有退出码 **66** 表示"请求重启内核"，由 vbs 外层循环拉起（最多 5 次） |
| 关掉窗口内核还偷偷跑着 | 窗口关闭后由启动器**收掉自己起的内核**（`taskkill /PID … /T`）；也可 `--keep-alive` 保留 |
| 页面上想点外链，又怕被 file:// 或外网钓鱼 | `POST /api/desktop/open-external` **白名单**只允许 `http/https` + 回环地址 |
| 想让漫库开机自启 | `POST /api/desktop/autostart` 写/删 `HKCU\\…\\Run\MangaVault`（默认关闭） |

**形态声明**：后端 `meta` 里写死 `SHELL = { form:'desktop', shell:'edge-app', launcher:'desktop/app.mjs' }`。页面按 `<html data-platform="desktop">` 渲染，该属性由扩展内容脚本 `shim.js` 在 `document_start` 注入。

---

## 2. 接口一览（统一前缀 `/api/desktop`）

> 下表从 `src/modules/desktop/index.mjs` 的 `app.get/post` 与 `meta.help` 逐条抄录。全部 `app.get` / `app.post`，**没有 PUT/DELETE**。

| # | 方法 | 路径 | 参数 | 返回 | 说明 |
|---:|---|---|---|---|---|
| 1 | GET | `/api/desktop/state` | — | `{ok, form, shell, launcher, version, pid, platform, node, dataDir, projectRoot, uptimeMs, port, window, windowFile, keepAlive, servedByLauncher, quitting, canRestart, canQuit, tray{available,enabled}, lastWindowReport, time}` | 桌面形态自检。`canRestart/canQuit` 恒为 `true`；`tray.available` = 是否 Win32，`tray.enabled` 当前恒为 `false`（未自动启用托盘） |
| 2 | POST | `/api/desktop/window` | body `{width\|outerWidth\|innerWidth, height\|outerHeight\|innerHeight, x\|screenX, y\|screenY, innerWidth, innerHeight, source}` | `{ok, window{width,height,x?,y?,innerWidth?,innerHeight?,updatedAt,firstSeenAt,source}, file}` | 页面侧上报窗口几何。校验失败 → **400**（中文原因）。缺 `x/y` 时**沿用上一次的位置** |
| 3 | POST | `/api/desktop/restart` | query `confirm`（必须 `=1`） | `{ok, restarting:true, marker, hint}` | 写重启标记 `data/desktop-restart.request`，400ms 后给自己发 `SIGTERM`。缺/错 confirm → **400** |
| 4 | POST | `/api/desktop/quit` | query `confirm`（必须 `=1`） | `{ok, quitting:true, pid}` | 置 `quitting=true`，300ms 后给自己发 `SIGTERM`（触发 server 的优雅关闭）。缺/错 confirm → **400** |
| 5 | POST | `/api/desktop/open-external` | body `{url}` | `{ok, opened, via:'cmd start'}` | 用系统默认浏览器打开。**只允许 `http/https` + 回环主机**（`127.0.0.1`/`localhost`/`::1`，任意端口）；拒绝 `file://`、外网域名、`javascript:`、UNC 路径 → 400 |
| 6 | POST | `/api/desktop/autostart` | body `{enabled}`（布尔，或 `'true'/'false'/'1'/'0'`） | `{ok, enabled, command, registry}` | 开机自启开关。非 Win32 → 400「开机自启目前只支持 Windows」；`enabled` 非布尔 → 400。写/删后**回查注册表**再返回真实状态 |
| 7 | GET | `/api/desktop/logs` | query `lines`（默认 200，上限 500） | `{ok, lines, maxLines:500, logs[{file,bytes,lines,text,error?}]}` | 读 `data/mangavault.log` 与 `data/desktop.log` 的**尾部** N 行；文件不存在不报错，该块 `bytes:0, lines:0, text:''`, `error:'读取失败或文件不存在'` |

统一响应约定：成功 `{ok:true,…}`，失败 `{ok:false,error:'中文原因'}`，HTTP 状态码同步给出 400/404/500。

### 2.1 未挂路由的内部纯函数（导出供离线单测）

`src/modules/desktop/index.mjs` 还导出 `windowPayload / tailLines / autostartCommand / autostartQueryArgs / autostartAddArgs / autostartDeleteArgs / externalOpenCommand / resolveExternalUrl / mergeWindowReport / parseAutostart / parseLines / readAutostart / setAutostart`，以及 `_internals` 汇总对象（额外含 `windowFile / logFile / desktopLogFile / shellState / checkConfirm / BASE_WINDOW / buildAppArgs / sanitizeWindow / sleep`）。这些是**给测试直接引用**的，不是 HTTP 接口。

---

## 3. 数据模型与文件位置

### 3.1 `data/desktop-window.json`（窗口记忆）

```json
{
  "width": 1366,
  "height": 768,
  "x": 30,
  "y": 40,
  "innerWidth": 1200,
  "innerHeight": 700,
  "updatedAt": "2026-10-14T08:48:50.000Z",
  "firstSeenAt": "2026-10-14T08:40:00.000Z",
  "source": "page",
  "lastUrl": "http://127.0.0.1:8770/",
  "browser": "Edge",
  "debugPort": 9243
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `width` / `height` | 页面上报 → `sanitizeWindow` | 取 `outerWidth/outerHeight`（App 模式无浏览器 chrome，外框≈可用窗口）。**下限 1024×640**，> 16000 判为坏数据 |
| `x` / `y` | 页面上报 | 缺省时沿用旧值；仍然没有则按主屏工作区**居中** |
| `innerWidth` / `innerHeight` | 页面上报 | 单独保留，不参与校验 |
| `source` | 请求体 | 页面上报为 `'page'`；未给则默认 `'page'` |
| `firstSeenAt` | 后端 | 首次写入时生成，后续保留原值 |
| `lastUrl` / `browser` / `debugPort` | **`desktop/app.mjs`** 打开窗口后写入 | 页面上报不会写这三个 |
| `updatedAt` | 后端 | 每次写入刷新 |

写入路径：`path.join(dataDir(), 'desktop-window.json')`。用 `writeWindow()` **原子写**（先写 `<file>.tmp-<pid>` 再 `rename`，避免断电写坏）。

读取路径：`readWindowSync(file, screenW, screenH)` —— 文件缺失/坏 JSON 都**不抛错**，回退基准 `1440×900` 并居中（会剥掉 BOM）。

### 3.2 `data/desktop-shell.json`（外壳台账）

```json
{
  "lastWindowReport": { "at": "ISO", "width": 1366, "height": 768, "x": 30, "y": 40, "source": "page" }
}
```

- 由 `noteWindowReport()` 在每次成功的窗口上报后写入（元信息**失败不影响几何落盘**）。
- `/api/desktop/state` 的 `keepAlive` / `servedByLauncher` 分别读 `shell.keepAlive` / `shell.launcherPid`。**这两个键在本次审查的代码里没有任何写入点**（启动器只写 `data/desktop-server-owner.json`，不写这个文件）—— 因此它们目前恒为 `false`。**未验证**是预留字段还是遗漏。

### 3.3 数据目录下的其它文件

| 路径 | 谁写 | 说明 |
|---|---|---|
| `data/server.lock.json` | `src/server.mjs` | 内核锁：`{pid, port, url}`。启动器据此探测"是否已有内核在跑"，托盘脚本也读它拿 URL |
| `data/desktop-server-owner.json` | `desktop/app.mjs` | 「内核是我起的」标记：`{pid, port, startedAt, by:'desktop/app.mjs'}` |
| `data/desktop-restart.request` | `POST /api/desktop/restart` | 重启标记：`{at, pid, by:'api'}`。vbs 在正常退出时删除它，避免下次启动误判 |
| `data/mangavault.log` | `src/core/log.mjs` | 服务日志。`GET /api/desktop/logs` 读它 |
| `data/desktop.log` | `desktop/log.mjs` | 启动器日志。内核的 stdout/stderr 也会被冒泡成 `[内核] …` 行写进来 |
| `data/desktop-profile/` | Edge/Chrome | **独立 user-data-dir**，见 3.4 |

### 3.4 独立 user-data-dir 位置

```text
data/desktop-profile/
```

由 `desktop/app.mjs` 的 `paths().profileDir` 给出，通过 `--user-data-dir=<绝对路径>` 传给浏览器。要点：

- **必须独立**：不能复用用户日常浏览器的 profile，否则会污染用户的书签/登录态，也无法保证窗口尺寸参数生效（用户的浏览器实例可能已经在跑）。
- 该目录同时是**进程归属判定依据**：`listAppWindowProcesses(profileDir)` 用 PowerShell `Get-CimInstance Win32_Process` 抓出命令行里含该路径的 `msedge.exe`/`chrome.exe`，从而知道"窗口是不是我们的"。
- 调试端口由它**稳定派生**：`debugPortFor(dir)` 对规范化后的小写绝对路径做 `h*31+charCode` 哈希，再 `9210 + (h % 90)`，落在 **9210–9299**。同一份数据目录永远同端口（单测断言了 `debugPortFor(TMP) === debugPortFor(TMP + '/')`）。
- 单测通过 `MV_DATA_DIR` 把整个 `data/` 指到临时目录，因此测试**绝不会碰真实 profile**。

### 3.5 开机自启注册表项

| 项 | 值 |
|---|---|
| 位置 | `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run` |
| 值名 | `MangaVault` |
| 类型 | `REG_SZ` |
| 数据 | `wscript.exe "<项目根>\\启动漫库.vbs"` |

对应命令（全部用 `execFile('reg', args)` 参数数组传参，**不拼 shell 字符串**）：

| 操作 | reg 参数 |
|---|---|
| 查询 | `query HKCU\\…\\Run /v MangaVault` |
| 写入 | `add HKCU\\…\\Run /v MangaVault /t REG_SZ /d <command> /f` |
| 删除 | `delete HKCU\\…\\Run /v MangaVault /f` |

- **默认关闭**：只有调用 `autostart {enabled:true}` 才写；`enabled:false` 走删除。
- 写/删之后**一定回查注册表**再返回：删除后仍读到 → `{ok:false, error:'删除注册表项失败：…'}`；写入后读不到 → `{ok:false, error:'写入注册表失败：…'}`（返回真实状态而不是"我发出去了所以成功"）。
- 读出的命令行用 `/REG_SZ\s+([^\r\n]+)/i` 提取。
- `readAutostart(run)` / `setAutostart(enabled, root, run)` 的 `run` 参数**可注入**，所以单测用假 `reg` 执行器验证参数拼装，**完全不碰真实注册表**。

---

## 4. 安全设计

### 4.1 路径

| 关注点 | 做法 |
|---|---|
| 所有落盘路径 | `dataDir()` **惰性求值**（尊重 `MV_DATA_DIR`）。`windowFile() / logFile() / desktopLogFile()` 都是函数而不是模块级常量——否则单测会把路径钉死在真实 `data/` |
| 窗口记忆写入 | `writeWindow()` **原子写**：`<file>.tmp-<pid>` → `rename`，同名临时文件带 pid |
| 读取健壮 | `readWindowSync`、`shellState()`、`readLockSync` 全部 `try/catch` 兜底，坏文件不抛错 |
| 外部命令 | `spawn` / `execFile` 一律**参数数组**传参：`spawn('cmd', ['/c','start','',url])`、`execFile('reg', args)`、`execFile('taskkill', ['/PID',pid,'/T'])`、`runner('powershell', ['-NoProfile','-NonInteractive','-Command', ps])`。不拼 shell 字符串，杜绝注入 |

### 4.2 外链白名单（`validateLocalUrl`）

唯一的"能把外部程序拉起来"的入口，因此规则最严：

1. 必须是合法 URL（`new URL` 能解析），空串/乱串直接拒；
2. protocol 必须是 `http:` 或 `https:` —— 拒绝 `file://`（否则能执行 `file:///C:/Windows/System32/calc.exe`）、`javascript:`；
3. hostname 必须是 `127.0.0.1` / `localhost` / `::1` / `[::1]` 之一 —— 拒绝外网域名（含 `evil.example.com`）与 UNC 路径（`\\\\server\\share\\a.exe` 不是合法 URL，也会被拒）；
4. **端口不限**（允许任何本机端口，因为内核可能顺延端口）；
5. 通过后统一 `u.toString()` 规范化再交给 `cmd /c start ""`。

### 4.3 为什么重启/退出要 `confirm=1`

`/restart` 与 `/quit` 会让**当前进程发 SIGTERM 给自己**，一次误触发意味着服务中断（正在跑的扫描/下载全没）。所以：

- `checkConfirm(q, '1')` 要求**显式**带 `confirm=1`，缺失/为 `0`/`yes` 一律 **400**「危险操作需要 confirm=1 确认参数」；
- 页面/托盘的任何按钮都必须自己拼上 `?confirm=1`，杜绝"随便一个 `fetch` 就把服务打掉"，也顺带阻断跨站 `POST` 误触发（无 CORS 凭据的简单请求拿不到 `ok`）；
- `restart` 额外写 `desktop-restart.request` 标记，好让外层 vbs 或服务脚本知道"这次退出是用户要求的重启，不是崩溃"。

### 4.4 关窗即退出的三重判定

启动器不假设浏览器一定支持远程调试，因此按优先级降级：

1. **CDP 目标消失**（首选）：轮询 `http://127.0.0.1:<debugPort>/json/list`，先前曾看到过该 URL 的 page 目标、之后消失 → `'closed'`。
2. **CDP 不可用** → `'unsupported'`（连续 3 次拿不到列表且从未见过端口）。
3. **进程探测兜底**：`waitWindowClosed(profileDir)` 用 PowerShell 找命令行含 profile 路径的浏览器进程，先等到"出现过"再等到"消失"。

若一直探测不到窗口进程，按「窗口已关闭」处理（宁可多关一次内核，也不留幽灵进程）。
收尾时若发现**仍有窗口进程存活**，则**保留内核**（源码注释：「内核保持运行以免读数丢失」）。

### 4.5 单实例与端口顺延

- 启动时先 `probeInstance(lockFile)`：锁文件存在 + 进程活着（`process.kill(pid, 0)`）+ `GET /api/ping` 返回 `name==='MangaVault'` → 复用已有内核，**不再起第二个**。
- 配置端口（默认 8770，`desktop/app.mjs` 里 `cfg.port || 8770`）被非漫库服务占用时，**`src/server.mjs` 自己顺延端口**，启动器只警告不干预，随后读锁文件拿到真实端口。
- 陈旧锁文件（pid 已不存在）会被识别并警告，然后重新起内核。
- 开窗前再查一次 CDP：如果同数据目录已有指向同一 URL 的 App 窗口，**不重复开窗**。

---

## 5. 已验证行为

### 5.1 单测 `tests/desktop.test.mjs` —— **85 条断言，10 组**

文件头声明「全离线：不启动浏览器、不写注册表、不碰真实 `data/`」。跑法 `node tests/run-tests.mjs desktop`。断言构成：`t.ok` 44 + `t.eq` 38 + `t.deepEq` 3 = **85**；另有 5 处 `t.log` 信息输出（不计断言）。

| 组 | 条数 | 覆盖要点（逐条断言内容） |
|---|---:|---|
| 1 App 窗口参数拼装 | 9 | ① `args[0] === '--app=<url>'`；② 含 `--window-size=1440,900`；③ 含 `--window-position=240,75`；④ 含 `--user-data-dir=`…`desktop-profile`；⑤ 含 `--no-first-run` 与 `--no-default-browser-check`；⑥ 含 `--load-extension=<shell 目录>`；⑦ 缺位置时**不写** `--window-position`；⑧ 宽高过小被抬到下限 `1024×640`；⑨ 宽高非法（`'abc'`/空）回退基准 `1440×900` |
| 2 窗口记忆读写 | 14 | `deepEq centerOf(1440,900,1920,1040) === {x:240,y:70}`；无记忆文件时宽/高用基准值、自动居中；写后读回宽/高/x/y 全部持久化；**文件写成 `'{ 这不是 JSON'` 后仍回退基准宽度且不抛错**；`sanitizeWindow` 把 `300×200` 抬到 `1024×640`；拒绝 `99999` 宽；保留合法大尺寸 `5000×4000`；缺宽高失败；`null` body 失败 |
| 3 open-external 白名单 | 8 | 允许 `http://127.0.0.1:8775/api/ping`、允许 `https://localhost/x`、允许**任意本机端口**；拒绝 `file:///C:/Windows/System32/calc.exe`、拒绝 `http://evil.example.com/`、拒绝 `javascript:alert(1)`、拒绝 UNC `\\\\server\\share\\a.exe`、拒绝空 url |
| 4 confirm 校验 | 4 | `confirm=1` 通过；缺 `confirm`（null）拒绝；`confirm=0` 拒绝；`confirm=yes` 拒绝 |
| 5 autostart 命令拼装（注入执行器） | 13 | `autostartCommand(root)` 等于 `wscript.exe "<root>\\启动漫库.vbs"`；查询参数 `['query', HKCU…Run, '/v', 'MangaVault']`；`add` 动作、含 `/f` 与 `REG_SZ`；删除参数 `['delete', HKCU…Run, '/v', 'MangaVault', '/f']`；读到已启用项（`enabled` 且 command 含 vbs）；无注册表项时 `enabled=false`；**开启自启返回真实状态且确实调了 `reg add`**；**关闭自启确实调了 `reg delete` 且状态 false**；`enabled:'maybe'` 被拒；`enabled:'true'` 解析为 `true` |
| 6 日志行数上限 | 4 | 未传 `lines` 默认 200；`lines=9999` 夹到 500；`lines='abc'` 回退 200；`tailLines('a\nb\nc\nd\n', 2)` = `'c,d'` |
| 7 后端接口（真实 HTTP，隔离数据目录） | 23 | `createApp` 起真服务监听随机端口。`GET /state` → 200、`form==='desktop'`、`pid` 是当前进程、`canQuit&&canRestart`、带窗口记忆且宽度 ≥ 1024；`POST /window` 缺参数 → **400 且 error 是中文的缺宽高说明**；正常参数 → 200、返回落盘宽度、**`data/desktop-window.json` 里确实写了 `width` 与 `y`**；支持 `innerWidth/innerHeight/screenX/screenY` 命名且 `innerWidth` 被采纳；`POST /quit` 缺 confirm → 400；`POST /restart` 缺 confirm → 400；`open-external` 拒绝 `file://`/外网/缺 url 各 400；`autostart {enabled:'maybe'}` → 400（**不会碰注册表**）；写 600 行日志后 `GET /logs?lines=9999` → 200、`lines` 夹到 500、`logs[0].lines===500`、**内容是尾部（含 `line 600` 且不含首行 `line 1`）** |
| 8 关闭超时保护 | 0 | 只输出一条 `t.log` 说明：`POST /quit?confirm=1` 会真的给当前进程发 SIGTERM，**因此不在单测里测**，端到端放在启动器冒烟里。**这是有意留空，不是遗漏** |
| 9 浏览器探测与 CDP 解析 | 6 | `findBrowserSync()` 返回真实存在的浏览器路径或 `null`；`parseCdpJson` 只保留 `type==='page'`（2 条输入 → 1 条）；坏 JSON 返回空数组；`normalizeUrl` 去掉 hash（`…#/library` → `…/`）；`debugPortFor` 落在 **9210–9299**；同一目录（带/不带尾斜杠）端口稳定 |
| 10 启动器参数解析 | 4 | `parseArgs(['--keep-alive','--width','1500','--restarts','5'])` → `keepAlive && width===1500 && maxRestarts===5`；`--window-only` **隐式开启 keep-alive**；`paths().profileDir === <TMP>/desktop-profile`；`paths().windowFile === <TMP>/desktop-window.json` |

收尾会 `fsp.rm(TMP)` 清掉临时数据目录。

### 5.2 启动器冒烟自检（`--smoke-seconds N`）

不是单测，需要真实环境。`smokeReport()` 跑 N 毫秒后汇总一份「实测证据」并写入 `data/desktop.log`：

| 字段 | 含义 |
|---|---|
| `dataDir` | 记录数据目录，**用于确认没有污染真实 `data/`** |
| `url` / `debugPort` / `waitedMs` | 目标地址、调试端口、实际等待时长 |
| `appProcesses` / `appProcessArgs` | 命令行含该 profile 路径的浏览器进程数与首条命令行 |
| `cdpPageTargets` | CDP 报出的 page 目标（`{title,url}`） |
| `windowFile` / `windowInfo` | 落盘的窗口记忆、本次开窗参数与 CDP 确认结果 |

冒烟结束若内核由本次启动器所起，会 `shutdownServer('冒烟自检结束')`。
**本次文档编写期间未实际运行冒烟**（它是交互式/有副作用的环境验证）——冒烟结论标记为 **未验证**。

### 5.3 未覆盖的验证（如实记录）

| 项 | 状态 |
|---|---|
| `POST /quit?confirm=1` / `restart?confirm=1` 真的终止进程 | **未验证**（单测有意跳过；只有 confirm 校验与 SIGTERM 发送有代码审计） |
| `open-external` 真的拉起系统浏览器 | **未验证**（单测只验证白名单判定与 400 分支） |
| `autostart` 真的写/删真实注册表 | **未验证**（单测一律注入假执行器） |
| 窗口几何真的被记住并在下次启动生效 | **未验证**（单测验证了文件读写与参数拼装，未做跨进程重启） |
| CDP 关窗判定 | **未验证**（`parseCdpJson` / `debugPortFor` / `normalizeUrl` 有单测；`waitForCdpTarget` / `waitForCdpClosed` 未测） |
| 开机自启项在真实 Windows 登录后是否生效 | **未验证** |

---

## 6. 已知限制

### 6.1 App 模式 vs 真正 WebView2 原生壳的区别与升级路径

当前实现是 **Edge/Chrome 的 `--app=URL` 模式**，不是自己嵌 WebView2 的原生壳。差别：

| 维度 | 当前（App 模式 + 扩展注入） | 真正 WebView2 原生壳（`.exe` + .NET/C++） |
|---|---|---|
| 依赖 | 必须本机装了 Edge 或 Chrome（找不到浏览器时启动器报错并返回 1） | 随应用分发 WebView2 Runtime，或依赖系统预装 |
| 窗口外观 | 由浏览器控制：系统标题栏仍存在（不显示地址栏/标签页），**用户能拖动/最小化/最大化** | 完全可控：可做无边框、自绘标题栏、自定义最小化按钮 |
| 窗口尺寸 | `--window-size` 只在**启动那一刻**生效；用户拖动后需页面主动上报才能记住 | 可直接读/写窗口状态，实时同步 |
| 进程模型 | 独立进程 + **独立 `--user-data-dir`**；与用户日常浏览器隔离靠这个参数 | 单进程或宿主自管 WebView |
| 系统集成 | 托盘需要**额外**一个 PowerShell 进程（`desktop/tray.ps1`，默认不启用） | 托盘/全局快捷键/单实例锁/通知都是壳内原生能力 |
| 关窗判定 | 需要 CDP 或 PowerShell 进程探测**兜底**（三条降级路径） | 壳内 `window.on('close')`，精确 |
| 混合能力 | 需要浏览器**扩展**（`desktop/shell/`）才能注入 `data-platform`/上报几何/兜底接口 | 壳可直接 `AddScriptToExecuteOnDocumentCreated` |
| 分发 | 一个 `.vbs` + 一个快捷方式，**零安装、零依赖** | 需要打包与签名，用户要装东西 |
| 权限边界 | 受浏览器扩展沙箱约束（扩展 `permissions: []`，只能与本机回环通信） | 壳进程是完整原生权限 |

**升级路径**（按成本递增，都不需要改现有的 `/api/desktop/*` 契约）：

1. **保持现状**，只把 Windows 任务栏图标与跳转列表打磨好（`assets/icon.ico` 已含 256/128/64/48/32/16 内嵌 PNG，`创建桌面快捷方式.ps1` 已指向 `wscript.exe` + `启动漫库.vbs`）。
2. **默认启用托盘**：`desktop/tray.ps1` 已实现「打开漫库窗口 / 重启本地内核 / 打开日志目录 / 退出漫库」，只要在启动时拉起它即可；代价是任务栏会常驻一个 PowerShell 进程（脚本注释里写明了这一点，所以默认不自动启用）。相应的 `/api/desktop/state` 的 `tray.enabled` 需要从写死 `false` 改成真实探测。
3. **换成 WebView2 壳**：写一个薄的宿主（C# / C++ / 或 Node + 原生绑定），仍起 `src/server.mjs` 指向 `http://127.0.0.1:<port>/`，把现在由扩展（`shim.js`）做的事改成壳的 `AddScriptToExecuteOnDocumentCreated`（注入 `data-platform="desktop"`、上报几何、兜底 `/api/desktop/state`）。后端 7 个接口**无需改动**——它们本来就只依赖"有个进程能发 HTTP + 能写注册表"。
4. **彻底原生（Electron / Tauri 等）**：会让"零第三方依赖"这条工程约束失效（`docs/ARCHITECTURE.md` 第 1 节），必须作为一次有意识的取舍来评估。

### 6.2 其它限制

| 限制 | 说明 |
|---|---|
| **平台锁定 Windows** | 浏览器路径（`ProgramFiles`/`ProgramFiles(x86)`/`LOCALAPPDATA` 下的 Edge/Chrome）、`tasklist`/`taskkill`/`reg`/`Get-CimInstance`/`WScript.Shell`、`.vbs` 启动器、注册表自启，全部是 Windows 专有。`/autostart` 在非 Win32 直接 400 说明；其余功能会失败或退化 |
| **依赖本机浏览器** | 没装 Edge/Chrome → 「没有找到 Microsoft Edge 或 Google Chrome，无法打开桌面窗口」，且**会收掉自己起的内核**并返回退出码 1 |
| **托盘默认不启用** | `desktop/tray.ps1` 存在且功能完整，但没有任何自动拉起逻辑；`state.tray.enabled` 恒为 `false` |
| `keepAlive` / `servedByLauncher` 恒为 false | 见 3.2 —— 这两个字段的写入点缺失，**未验证**是否为预留 |
| **日志接口要全量读文件** | `GET /logs` 先把整个 `mangavault.log` / `desktop.log` 读进内存再切尾部。日志很大时内存与耗时都会涨（无大小上限、无增量读）。`tailLines` 的注释也说明"调用方负责上限"，而当前拆行是在全量读入之后 |
| **窗口记忆只在启动时生效** | `--window-size` / `--window-position` 是启动参数；用户拖动窗口后需要页面（`shim.js`：`load`/`resize`(400ms 去抖)/每 20 秒）上报，才被记下来 |
| **页面上报采用外框尺寸与外框坐标** | `shim.js` 取 `max(outerWidth, innerWidth)` 与外框坐标；多显示器/缩放（`devicePixelRatio`）场景未做校正 |
| **CDP 可能不可用** | 调试端口被占用、浏览器策略禁止、或浏览器不支持时，开窗确认与关窗判定都会退回"进程探测"；源码对此只 `warn` 不报错 |
| **重启依赖外部托管** | `/restart` 只写标记 + 自杀；**真正重新拉起内核靠 `启动漫库.vbs` 的外层循环**（最多 5 次）。若内核由别的脚本托管，提示里也写明了"否则请重启 `启动漫库.vbs`" |
| **自动重启上限** | 启动器 `--restarts`（默认 3）次连续失败后放弃并返回失败码；vbs 外层另有 5 次上限 |
| **扩展兜底能力有限** | `desktop/shell/bg.js` 的兜底 `/api/desktop/state` 只回形态信息，且 `canQuit:false`、带 `source:'extension-fallback'`；它**不能**替代后端——重启/退出/外链/自启都只有后端有 |
| **单冒烟窗口共用 profile** | 启动器用 CDP + `normalizeUrl` 去重，**只防重复开窗**，不做多窗口管理（多显示器同时开两个窗口的性能与记忆语义未定义） |

---

## 7. 与其它模块的分工

| 模块 / 文件 | 管什么 | 边界 |
|---|---|---|
| `src/server.mjs`（Lead） | HTTP 内核、写 `data/server.lock.json`、端口顺延 | desktop 只**读**锁文件探测实例，不改它 |
| `public/app.js` / `theme.css`（Lead） | 页面外壳：路由、`Ctrl+K` 命令面板、`Ctrl+1..9` 切页 | desktop 不改；`app.js` 有「打开数据目录」命令，走的是 `/api/desktop/open-external` |
| `src/modules/library` / `reader` / `vault` / `download` / `dedupe` | 业务功能 | desktop **不含任何业务逻辑**，只提供"窗口 + 本机能力" |
| `desktop/app.mjs` | 启动器：探内核 → 起内核 → 开窗 → 等关窗 → 收尾 | 它 `fork` `src/server.mjs` 并透传 `MV_DATA_DIR` 与 `MV_DESKTOP=1` |
| `desktop/lib.mjs` | 纯函数：窗口校验/居中/原子写、URL 白名单、confirm 校验、命令行拼装 | 启动器与后端模块**共用**同一套规则，因此能离线单测 |
| `desktop/sysinfo.mjs` | 进程探测、服务等待、屏幕尺寸、浏览器定位、CDP | 探测类函数接受**注入的 exec**，可离线测 |
| `desktop/shell/`（扩展） | 主世界注入 `data-platform`、上报几何、404 兜底 | `permissions: []`；只与本机回环通信 |
| `启动漫库.vbs` | 无控制台启动 + 重启循环（退出码 66）+ 清理重启标记 | 它是用户双击的入口 |
| `创建桌面快捷方式.ps1` | 在桌面与开始菜单建 `.lnk`（指向 `wscript.exe` + vbs，图标 `assets/icon.ico`，工作目录=项目根） | 缺 `.ico` 时先调 `node desktop/make-icon.mjs`（零依赖手写 PNG/ICO）生成，再退到 `shell32.dll,13` |
| `desktop/tray.ps1` | 托盘：打开窗口 / 重启 / 打开日志目录 / 退出 | 读 `data/server.lock.json` 拿端口；**默认不自动启用** |

---

## 8. 启动流程（源码级）

```text
双击 启动漫库.vbs
  └─ wscript 隐藏运行 node desktop/app.mjs
       ├─ paths() 解析：data/lockFile, data/windowFile, data/desktop-profile, data/desktop.log …
       ├─ loadConfig(true) 取端口（默认 8770）
       ├─ probeInstance(lockFile)
       │    ├─ 活着 → 复用（log「检测到已在运行的内核」）
       │    └─ 不活 → spawnServer(src/server.mjs, MV_DATA_DIR=data, MV_DESKTOP=1)
       │         ├─ waitForLock(20s) 读 data/server.lock.json
       │         ├─ waitForServer(port) 轮询 GET /api/ping 直到 name==='MangaVault'
       │         └─ writeOwnerFlag(data/desktop-server-owner.json)
       ├─ loadWindow(data/desktop-window.json, {--width,--height})
       │    └─ 首次无记忆 → screenSize()（PowerShell 主屏工作区，失败回退 1920×1080）→ centerOf 居中
       ├─ cdpTargets(debugPort) 查同 URL 是否已开窗
       ├─ openWindow(browser, url, win, desktop/shell, ['--remote-debugging-port=<9210-9299>'])
       │    └─ buildAppArgs：--app / --window-size / --window-position / --user-data-dir / --load-extension / --no-first-run …
       ├─ waitForCdpTarget(20s) 确认页面目标
       ├─ writeWindow(windowFile, win + {lastUrl, browser, debugPort})
       ├─ waitForCdpClosed → 或 waitWindowClosed(profileDir)
       └─ 收尾：
            --keep-alive / --window-only → 内核继续跑
            窗口进程仍在 → 保留内核
            否则 taskkill /PID <pid> /T
```

命令行参数（`parseArgs`）：`--keep-alive`、`--window-only`（**隐式 keep-alive**）、`--no-window`（只保证内核在跑）、`--width N`、`--height N`、`--restarts N`（默认 3）、`--smoke-seconds N`（冒烟自检）。

退出码：`0` 正常退出 ｜ `66` 请求重启内核（`RESTART_EXIT`，由 vbs 外层循环处理）｜ `1` 启动失败。

---

## 9. 交付前自检

```powershell
node --check src/modules/desktop/index.mjs
node --check desktop/app.mjs
node --check desktop/lib.mjs
node --check desktop/sysinfo.mjs
node --check desktop/shell/shim.js
node --check desktop/shell/bg.js
node tests/run-tests.mjs desktop        # 85 通过 / 0 失败
```

> 注意：`desktop/shell/bridge.js` 是**扩展隔离世界**脚本，使用 `chrome.runtime`，不能指望它在 Node 里运行。
> 想真机验证窗口行为，用 `node desktop/app.mjs --smoke-seconds 15`（会在 `data/desktop.log` 留下 5.2 节那份实测证据），建议配合 `MV_DATA_DIR` 指向临时目录，别污染真实数据。
