# 团队协作规范（docs/team）

> 这个目录记录**谁在什么时候做了什么、边界在哪、证据是什么**。
> 接手别人工作时，先读对应的 task 文件，再读代码。

---

## 1. 角色与写入范围（write scope）

**同一时刻一个文件只能有一个写入者。** 范围重叠即为冲突，必须先协调。

| 成员 | 写入范围 | 说明 |
| --- | --- | --- |
| **lead** | src/core/** , src/server.mjs , src/modules/index.mjs , config.example.json , AGENT.md , docs/ARCHITECTURE.md | 框架层与集成，唯一合并者 |
| **shell-smith** | desktop/** , scripts/build-desktop.mjs , src/modules/desktop/** , assets/** , docs/DESKTOP.md | Windows exe 宿主与打包 |
| **ui-smith** | public/theme.css , public/app.js , public/index.html , public/modules/library.js , public/modules/reader.js , public/modules/settings.js , public/modules/about.js | 前端内核与视觉。**不含** download/vault/dedupe 的页面文件 |
| **dl-smith** | src/modules/download/** , public/modules/download.{js,css} , docs/DOWNLOAD_SOURCES.md , docs/modules/download.md , tests/download.test.mjs | 下载中心全部 |
| **lib-smith** | src/modules/library/** , scripts/normalize-library.mjs , scripts/scan-library.mjs , tests/library.test.mjs , docs/LIBRARY_FORMAT.md | 扫描器与库健全化 |
| **vault-smith** | src/modules/vault/** , public/modules/vault.{js,css} , tests/vault.test.mjs , docs/modules/vault.md | 管理台前后端 |
| **docs-qa** | README.md , docs/*.md（除上面已声明的） , docs/team/** , tests/integration.test.mjs , tests/ui-smoke.test.mjs , scripts/audit.mjs | 文档与交叉验收 |

## 2. 共享热点文件（只许一个人改）

| 文件 | 唯一写入者 | 别人要加东西怎么办 |
| --- | --- | --- |
| src/modules/index.mjs | lead | 发消息给 lead，说明模块 id 与路径 |
| src/core/config.mjs | lead | 发消息给 lead |
| public/app.js | ui-smith | 用**已有** ctx API；确需新增先发消息 |
| data/config.json | 运行时自动写入 | 测试用 MV_DATA_DIR 隔离，禁止手改仓库内该文件 |

## 3. 并行工作流

1. **先看任务书**：`docs/team/v3-taskbook.md` 找到自己的任务，确认写入范围。
2. **认领**：在任务板上把自己的任务置为 in_progress。
3. **只动自己范围内的文件**。发现必须改别人的文件 → 发消息，不要抢。
4. **自测**：跑自己模块的测试；`node tests/run-tests.mjs <模块名>`。
5. **落盘证据**：完成后把"命令 + 真实输出"写进自己的 task 文件。
6. **交回**：把结果用消息发给 lead，包含：改了什么文件、测试结果、未解决的缺口。

## 4. 接口冻结（v3 起生效，改动需 lead 批准）

### 4.1 模块契约（不变）

```js
export const meta = { id, name, description, order };
export async function register(app, ctx) { }   // 后端
export async function dispose() { }             // 可选
// 前端
export const meta = { id, name, order };
export async function mount(root, ctx) { }
```

### 4.2 返回约定（不变）

成功 `{ ok: true, ... }`；失败 `{ ok: false, error: "中文可读原因" }` + 非 2xx 状态码。

### 4.3 前端 ctx API（app.js 提供，v3 冻结）

| API | 作用 |
| --- | --- |
| ctx.el(tag, opts, children) | 建元素。opts 支持 class / text / style / on / attrs |
| ctx.get / post / put / del(url, body?) | fetch 封装，自动抛错并带中文 message |
| ctx.icon(name, size?) | 内置 SVG 图标 |
| ctx.toast(msg, kind?) | kind: ok / err / warn |
| ctx.modal({ title, body, foot, width }) | 返回 { close, foot } |
| ctx.confirm({ title, text, danger, okText }) | Promise<boolean> |
| ctx.empty(title, sub) | 空状态块 |
| ctx.loading(text) | 加载块 |
| ctx.fmt.num / bytes / date / ago | 格式化 |
| ctx.state.get(k, d) / set(k, v) | 会话级记忆 |
| ctx.virtualGrid({ container, items, minColWidth, rowHeight, gap, renderItem }) | 虚拟滚动网格，返回 { setItems, refresh, destroy, cols } |
| ctx.registerCommand({ id, title, run, keywords }) | 注册到 Ctrl+K 命令面板 |
| ctx.del(target, event, fn, opts) | 卸载时自动解绑事件 |
| ctx.desktop | { platform, available, version, openExternal(url), quit(), restart() } |

### 4.4 桌面桥（shell-smith 提供，后端）

| 路由 | 作用 |
| --- | --- |
| GET /api/desktop/info | { platform, appVersion, mode, exe, native } |
| POST /api/desktop/open-external { url } | 用系统默认程序打开（白名单 http/https/mailto） |
| POST /api/desktop/reveal { path } | 资源管理器定位文件（**限库根之内**且必须真实存在） |
| POST /api/desktop/pick-dir { title } | 原生选目录，返回绝对路径 |
| POST /api/desktop/quit | 退出整个应用 |
| GET /api/desktop/native/next | **宿主专用**：长轮询领取原生命令（带 pid/exe 心跳） |
| POST /api/desktop/native/result | **宿主专用**：回执 |

**契约细节（v3 裁决，lead 已批准）**

- **open-external 白名单为 http / https / mailto，允许外网。**
  理由：exe 是原生桌面应用，打开官网/帮助必须能出外网；回环限制对 exe 无安全价值。
  真正的风险在协议与注入，已处理：
  - 明确拒绝 file: / javascript: / data: / vbscript: 等可执行本地代码的协议
  - 拒绝含控制字符（CR/LF）的地址
  - 优先交给宿主（ShellExecute，不经过 cmd.exe）；仅宿主不在线时降级 cmd start，
    降级前必须过 isCmdSafeUrl（cmd.exe 会把 & | < > ^ % 当元字符，spawn 不转义）
- **reveal 只允许库根之内且真实存在的路径**（否则等于给任意本机程序一个全盘遍历器）。
  归属判定用 path.relative 而非字符串前缀（否则 C:\lib2 会被误判在 C:\lib 内）。
- **mode 取值**：webview2 = 跑在 exe 宿主里（native.attached=true）；web = 浏览器打开的页面。
- **错误码约定**：400 参数/协议非法 · 403 越权路径 · 404 库根内不存在 ·
  409 用户取消对话框（可预期结果）· 502 宿主执行失败 · 503 宿主不在线 ·
  504 宿主未回执。宿主不在线时一律给明确中文提示，**不用 500**。
- 原生能力由 C# 宿主执行，后端通过反向长轮询转交
  （状态机 src/modules/desktop/bridge.mjs，安全判定 src/modules/desktop/guard.mjs）。
  完整说明见 docs/DESKTOP.md。

## 5. 交付纪律

- **禁止口头声称完成**。必须给可复现命令与真实输出。
- 测试失败要如实报告，并说明是"实现错"还是"断言过时"。
- 破坏性操作必须 dry-run 优先 + 可回滚。
- 中断前把中间成果落盘到自己的 task 文件，方便接续。
