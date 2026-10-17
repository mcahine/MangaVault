# T1 · Windows exe 宿主与打包（shell-smith）

状态：**已完成并通过真实自检**（16/16）+ 后端路由离线单测 154/0。

---

## 1. 交付物

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| scripts/build-desktop.mjs | 297 | 一键构建：编译宿主 + 拷 DLL + 打包 app/ + 校验 PE 架构 |
| desktop/host/Program.cs | 1100+ | C# 原生宿主（C# 5 / WinForms + WebView2，零第三方） |
| desktop/refs/*.dll | — | 3 个 WebView2 引用库（随代码发布，编译期引用，非运行时 npm 依赖） |
| scripts/dev/desktop-selftest.mjs | 251 | 自动点火 exe selftest 并断言 16 条 |
| src/modules/desktop/bridge.mjs | 191 | 原生能力桥状态机（队列/长轮询/在途命令），纯逻辑可离线单测 |
| src/modules/desktop/guard.mjs | 119 | 安全白名单（协议 / 路径边界），纯函数 |
| src/modules/desktop/index.mjs | 修改 | 新增 4 条路由，既有 7 条保持不变 |
| docs/DESKTOP.md | 358 | 构建 / 产物 / 进程模型 / 原生能力 / 验证原理 / 踩坑 |
| tests/desktop.test.mjs | 修改 | 85 → 154 条断言 |

产物：dist/MangaVault.exe（72.5 KB，PE 0x8664）+ 3 个 DLL + icon.ico + app/（含 src/public/desktop）+ build-info.json

---

## 2. 验收命令与真实输出

### 2.1 构建

```powershell
node scripts/build-desktop.mjs --clean
```

```
▸ 漫库桌面构建 → ...\dist
  ✓ 编译器 C:\WINDOWS\Microsoft.NET\Framework64\v4.0.30319\csc.exe
  ✓ 宿主源码 desktop/host/Program.cs (42.9 KB)
  ✓ WebView2 引用库 desktop/refs/ 齐全（3 个 DLL）
▸ 编译原生宿主（/target:winexe /platform:x64）
  ✓ MangaVault.exe 72.5 KB (sha256:25ccdc03493ba6e7)
  ✓ PE 架构校验通过：0x8664（x64）
▸ 拷贝 WebView2 运行时依赖到 exe 同目录
  ✓ Microsoft.Web.WebView2.Core.dll  589.6 KB
  ✓ Microsoft.Web.WebView2.WinForms.dll  37.6 KB
  ✓ WebView2Loader.dll  162.1 KB
  ✓ icon.ico  39.6 KB
▸ 拷贝后端与前端到 app/
  ✓ src/ → app/src/  49 个文件, 472.4 KB
  ✓ public/ → app/public/  14 个文件, 225.0 KB
  ✓ desktop/ → app/desktop/  10 个文件, 52.9 KB
  ✓ app/package.json  387 B
  ✓ app/config.example.json  1.4 KB
▸ 产物清单
    MangaVault.exe                          72.5 KB
    ...
    合计                                       1.7 MB
  ✓ 构建完成，用时 1.5s
```

### 2.2 桌面 exe 自检（16/16 真实通过）

```powershell
node scripts/dev/desktop-selftest.mjs
```

```
  已删除旧 trace
  已点火 host pid=34716（fire-and-forget，不等待）

── 断言结果 ──
  ✓  1. trace 文件已生成且非空（启动即留痕）        62 行 / 3175 字节
  ✓  2. BOOT 行存在（进程真的跑起来了）             命中：BOOT pid=34716 selftest=True
  ✓  3. PORT-CHOSEN 端口非 0（选定可用端口）        端口 8776
  ✓  4. SERVER-PID 非空（exe 自己拉起了 node 后端） 后端子进程 pid 20412
  ✓  5. BOOT-PING True（/api/ping 通过）
  ✓  6. SHOWN（窗口真实显示）
  ✓  7. ENV-OK version=（WebView2 环境创建成功）    命中：ENV-OK version=155.0
  ✓  8. WV2-READY（WebView2 控件就绪）
  ✓  9. NAVCOMPLETE ok=True（页面导航成功）
  ✓ 10. SCRIPT 探针证明页面真实渲染出漫库界面
  ✓ 11. 关闭后无孤儿 node  trace 声明=true，独立复核 pid 20412 存活=false
  ✓ 12. BRIDGE-ATTACHED true  命中：BRIDGE-ATTACHED True mode=webview2
  ✓ 13. BRIDGE-CANCEL-OK True（取消选目录 -> 409 + 中文原因）
  ✓ 14. BRIDGE-PROBE-RESULT True（原生能力桥往返自检通过）
  ✓ 15. SHUTDOWN OK + DONE OK
  ✓ 16. 收尾状态是 OK 而不是 BRIDGEFAIL

总结: 16 通过 / 0 失败
结果：桌面 exe 全链路自检通过
==========
selftest exit = 0
MangaVault.exe 残留 = 0
孤儿 node = []  count=0
trace 已清理 = True
```

### 2.3 后端路由单测

```powershell
node tests/run-tests.mjs desktop
```

```
✓ PASS  桌面端   desktop.test.mjs  154 通过 / 0 失败 / 1438ms
总计: 154 通过 / 0 失败
```

### 2.4 全量测试

```
总计: 564 通过 / 1 失败
唯一失败：download「没有残留临时目录 | 实际=1 期望=0」（进度板已记录的既存 Windows 句柄延迟 flake，非本次改动引入）
本次改动涉及的两个用例文件：desktop 154/0、integration 67/0
```

---

## 3. 过程中发现并修掉的真 bug（都影响了实际可用性）

### 3.1 打包漏了 desktop/ → dist 里所有 /api/desktop/* 全失效（严重）

构建脚本原本只拷 src/ 与 public/。但 src/modules/desktop/index.mjs 要
import '../../../desktop/lib.mjs'，导致 dist 里：
「模块 desktop 加载失败: Cannot find module ...dist\app\desktop\lib.mjs」。

**这个 bug 极其隐蔽**：页面照常渲染、其它模块全正常，只有原生能力静默失效。
是我为自检加的「原生能力桥真实往返探测」把它挖出来的 —— 只测 HTTP 端口开着根本发现不了。
修法：构建脚本把 desktop/ 一并打包（过滤掉 refs/ 与 host/）。

### 3.2 参考实现 _spike/wv2host/Program.cs 会永远卡死

它在 Form.Shown 里用 CreateAsync(...).Result 阻塞 UI 线程等待 WebView2 环境，
而 WebView2 的回调要回到 UI 线程 —— 自我死锁。实测 trace 停在 ENV-OK 之后，
进程永不退出。本实现全程不阻塞：一律
ContinueWith(..., TaskScheduler.FromCurrentSynchronizationContext())。

### 3.3 ExecuteScriptAsync 不等待 JS Promise

往页面注入 async IIFE，拿回来的是 Promise 序列化的 "{}"，不是结果。
已改为纯 HTTP 探测（同样能证明整条链路）。

### 3.4 CoreWebView2 成员只能在 UI 线程访问

把探测整个丢进 Task.Run 会抛
InvalidOperationException: CoreWebView2 members can only be accessed from the UI thread。
已改为「UI 线程做 WebView2 调用，阻塞 HTTP 丢线程池」。

### 3.5 其它

- csc 缺 /codepage:65001 → 中文界面全乱码
- 误加 /nostdlib+ → 连 System.Object 都找不到
- 漏声明 MAX_H → 编译报 CS0103
- 测试里 \r\n 被写成真实换行 → SyntaxError
- trace 带毫秒前缀导致 /^DONE OK/ 永不匹配 → 自检永远等超时后误报

---

## 4. 原生能力（后端路由）

| 路由 | 状态 | 说明 |
| --- | --- | --- |
| GET /api/desktop/info | 新增 | mode=webview2/web、exe、native.attached、白名单 |
| POST /api/desktop/open-external | 复核 | 白名单收窄到 http/https/mailto（原为仅回环），并补 cmd 注入防护 |
| POST /api/desktop/reveal | 新增 | 限库根内 + 真实存在；path.relative 判归属（非字符串前缀） |
| POST /api/desktop/pick-dir | 新增 | 宿主弹原生框；宿主不在线 → 503 中文提示 |
| POST /api/desktop/quit | 复核 | 既有行为不变 |
| GET /api/desktop/native/next | 新增 | 宿主编用：长轮询领命令 + 心跳 |
| POST /api/desktop/native/result | 新增 | 宿主编用：回执 |

既有 7 条路由（state/window/restart/quit/open-external/autostart/logs）**全部保留**。

### 4.1 一处需要 lead 知晓的契约变更

team README 4.4 规定 open-external 白名单是 http/https/mailto，
但 v2 实现（validateLocalUrl）只允许**回环地址**，且既有测试断言
「拒绝外网地址」。二者冲突。

我按 README 的冻结契约实现（允许 http/https/mailto 外网），并把测试断言
从「拒绝外网」改成「允许 https 外网 + 拒绝 file:/javascript:/data:」。
理由：exe 是原生应用，用户点「帮助/官网」必须能开外网；
且 v2 的回环限制对 exe 场景无安全价值（页面本身就是本机服务）。

**裁决结果（lead 已批准）：采纳本实现。**
已同步更新 docs/team/README.md §4.4，并在 docs/DESKTOP.md §5.3 显式标注
「允许外网是刻意设计，不要改回只允许回环」，避免后来人当成 bug 改回去。

---

## 5. 未解决的缺口

1. **自检需要 GUI 会话**。desktop-selftest.mjs 会在屏幕上短暂弹窗（自检模式下
   ShowInTaskbar=false、40×40 位置，但仍可见）。无头 CI 上跑不了 exe 自检，
   只能跑 desktop 单测（154 条，全离线）。
2. **dist/ 与 src/ 是快照关系**。代码改动后必须重跑 build-desktop.mjs，
   dist/app 不会自动同步。已在文档里写明。
3. **--with-node 绿色包未做端到端验证**。只验证了构建产物存在；
   未在一台没装 Node 的机器上实测。这一条如实标注为未验证。
4. ~~open-external 契约变更待 lead 确认~~ → **已裁决：采纳（允许外网）**，README §4.4 与 DESKTOP §5.3 已同步。
5. **本轮收尾状态**（2026-10 收尾）：
   - a) team README §4.4 已更新（补齐 native/* 两条路由、白名单裁决理由、reveal 边界、mode 取值、错误码约定）
   - b) dist/ 已用最新代码（--clean 重建）：exe 72.5 KB / sha256:0aa0e27ea2eebf9d / app 77 个文件；
        重建前用 sha256 比对确认 app/src/modules/desktop/{index,bridge,guard}.mjs 与源码一致
   - c) 最新一次：desktop 单测 154/0（exit 0）；desktop-selftest 16/0（exit 0）
