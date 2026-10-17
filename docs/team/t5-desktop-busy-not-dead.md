# 桌面端「查重把窗口关掉」根因与修复（T5）

> 记录时间：2026-10-15 ｜ 状态：已修复并纳入一键验收

## 1. 用户报的现象

> 「桌面端查重还会给桌面干关闭了额」

即：在 MangaVault.exe（桌面端）里点「重新扫描 / 深度比对 / 重扫库」，跑到一半**窗口自己消失了**。

## 2. 根因（代码级证据）

宿主看护逻辑在 `desktop/host/Program.cs`：

| 位置 | 内容 |
| --- | --- |
| `Program.cs:58-59` | `PING_INTERVAL_MS = 3000`、`PING_MAX_FAILS = 4` |
| `Program.cs:171` | `bridgeTimer = new Timer(WatchdogTick, null, 1000, PING_INTERVAL_MS / 3)` —— 每 3 秒一次 |
| `Program.cs:674-708` | `WatchdogTick()`：进程没退出就 `TryGet("http://127.0.0.1:"+port+"/api/ping", 2000)`，**拿不到就 `pingFails++`，累计 4 次 → `Trace("SERVER-UNREACHABLE")` + `Dump("SERVERDEAD")`** |
| `Program.cs:930-945` | `TryGet` 是同步 `HttpWebRequest`，2 秒超时就返回 null —— 它只表示「这次没问到」，与进程死活无关 |

关键事实：**Node 后端在长任务期间是单线程忙**。查重指纹构建、vault 全库重扫都是一段长时间不 `await` 的同步循环，事件循环被占满 → `/api/ping` 必然超时 → 约 12 秒后宿主判定「后端已死」→ `Environment.Exit`。

**「忙」被误判成「死」，这就是窗口关闭的全部原因。** 与查重算法本身无关，与内存/崩溃都无关。

## 3. 修复（三段）

### 3.1 后端声明「我在忙」——`src/core/heartbeat.mjs`（新增，零依赖）

- 写 `<数据目录>/backend-silence.json`，内容 `{ until, untilIso, ms, startedAt }`，`until` 是**绝对时间戳**，过点即自然失效。
- `touchSilence(ms)`：同步、进程内 5 秒节流（`WRITE_THROTTLE_MS = 5000`），首次必定落盘 —— 长任务循环里可以放心高频调用。
- `releaseSilence()`：绕过节流，把 `until` 立刻拉近到 1 秒，不留长尾豁免。
- `withHeartbeat(fn, { ms, stepMs, label, log })`：开跑立窗口 + `setInterval` 续期 + `finally` 收窗口（**任务抛错也收**）。定时器 `unref()`，不阻止进程退出。
- `DEFAULT_SILENCE_MS = 10 分钟`（单步上限；超长任务靠续期覆盖）。
- 只写不删：Windows 上删除正被宿主读取的文件会抛 `EPERM`。

接点：
- `src/modules/dedupe/engine/runner.mjs` 的 `start()` 把 `run(stage, rebuildFp, paths)` 包进 `withHeartbeat`（最重的一环）。
- `src/modules/library/index.mjs` 的 `POST /api/library/scan` 把 `scanRoots(list, cb)` 包进 `withHeartbeat`。
- `src/modules/vault/index.mjs` 的 `orphans/clean`、`verify/fix`、`trash/purge` 三处包进 `withHeartbeat`。
- `src/server.mjs` 加**请求级**声明：中间件对 `SLOW_TASK_RE` 命中的 POST 在请求一开始就 `touchSilence(SLOW_TASK_MS)`，并在 `ctx.res.on('finish')` 调 `releaseSilence()`。兜住所有已识别的写操作长任务。
- `GET /api/ping` 新增 `silenceUntil` 字段，宿主与前端都能据此区分忙/死。

### 3.2 宿主看护放过「忙」——`desktop/host/Program.cs`

- 新增常量 `SILENCE_FILE = "backend-silence.json"`（与 heartbeat 导出值一致）与状态位 `silenceLogged`。
- 新增 `BackendBusy()`：读数据目录下的静默文件，`until > now(UTC ms)` 才算有效；窗口首次生效时 `Trace("SERVER-BUSY 静默窗口有效至 …")`，消失时复位 `silenceLogged`。
- 新增 `JsonLong(text, key, dflt)`（宿主自带的迷你 JSON 读取器原来只有 string/int/bool）。
- `WatchdogTick()` 里先取 `bool busy = BackendBusy();`，然后把原来的 `else { pingFails++ … }` 改成 **`else if (busy) { pingFails = 0; }`**。

两条铁律（都写进代码注释）：
1. **进程真退出必须无条件收摊**——`if (server != null && ServerHasExited())` 这段在忙判定**之前**，静默窗口绝不能盖住真死，否则会留下一个没有后端的空白外壳。
2. **只读接口绝不声明静默**——GET 卡住就是真卡住，掩盖它只会更难查。

### 3.3 前端第二道证据——`public/app.js`

- `startHealthProbe()`：每 4 秒 `GET /api/ping`，连续 3 次失败写 `window.__MV_ONLINE__ = { ok:false, fails, busy, error }`；恢复即置回。
- 页脚「服务正常 · Node 版本」在长任务期间追加 **「 · 长任务进行中」**（读 `__MV_ONLINE__.busy`），用户不会再以为「卡住 = 坏了要重启」。

## 4. 回归防线（两条，都在一键验收里）

| 防线 | 内容 | 条数 |
| --- | --- | --- |
| `tests/heartbeat.test.mjs` | `silenceDue`/`silenceActive` 边界（含到点即失效）、真实落盘、5 秒节流、`releaseSilence` 收窄、`withHeartbeat` 开窗/收窗/抛错也收窗；并**读 `Program.cs` 源码**断言契约（文件名一致、`bool busy = BackendBusy();` + `else if (busy)`、`ServerHasExited()` 在前、`/api/ping` 带回 `silenceUntil`） | 30 |
| `scripts/dev/host-busy-check.mjs` | 隔离数据目录 + 随机端口起真实实例，走真实 HTTP 验证：空闲 `silenceUntil=0` 且无文件 → 长任务期间窗口已落盘 → 结束后收窄且归零 → 窗口有效时 ping 仍 200 且带 `silenceUntil` → 宿主源码忙分支在死亡累加之前 | 13 |

两条都在 `scripts/dev/verify-all.mjs` 里（hostbusy 是第 4 步，在 dist 校验之前）。

## 5. 教训（已写入 AGENT.md §11）

- **报「忙」和报「死」是两个不同的信号，必须分开表达**。宿主只有一个「ping 通/不通」的布尔量时，任何长任务都会表现为「挂了」。凡是看护程序，都要有「我还在跑，只是没空回你」的显式通道。
- **兜底豁免必须自带过期时间**：`until` 用绝对时间戳而不是布尔标志，进程被强杀后不会再留下永久豁免。
- **豁免不能盖住真死**：`ServerHasExited()` 必须优先于忙判定。这条如果没有，用户会遇到更糟的症状——窗口留着但一片空白。
- **验收必须包含「空闲时没有豁免」这一条**，否则一个永远写 `until = now + 1 年` 的 bug 也能全绿。
