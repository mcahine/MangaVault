# 漫库 MangaVault · 模块契约（所有 Agent 必须遵守）

> 工程根目录：`C:\Users\D-001\Desktop\黄漫\MangaVault`
> 运行：`node src/server.mjs`（端口 8770，只监听 127.0.0.1）
> 测试：`node tests/run-tests.mjs`
> 技术栈：**Node.js 20+ / 纯 ESM / 零第三方依赖 / 原生前端（无构建步骤）**
> 代码风格：不用模板字符串反引号（避免跨 Agent 转义事故），用字符串拼接；2 空格缩进；每个函数写中文注释；所有 IO 都要 try/catch。

---

## 1. 目录与写入范围（严禁越界）

| 路径 | 归属 | 说明 |
|---|---|---|
| `src/core/**` | **Lead only** | 配置、HTTP 微框架、工具、日志、存储。其他 Agent 只读 |
| `src/server.mjs`、`src/modules/index.mjs` | **Lead only** | 只读 |
| `src/modules/library/**`、`src/modules/reader/**` | **Lead only** | 只读 |
| `src/modules/download/**` | download-smith | 下载模块（破坏性写） |
| `src/modules/dedupe/**` | dedupe-smith | 查重模块（破坏性写） |
| `public/theme.css`、`public/app.js`、`public/index.html` | **Lead only** | 只读，禁止修改 |
| `public/modules/download.js`、`public/modules/download.css` | download-smith | 下载页面前端 |
| `public/modules/dedupe.js`、`public/modules/dedupe.css` | dedupe-smith | 查重页面前端 |
| `tests/<你的模块>.test.mjs` | 各自 | 单测 |
| `docs/modules/<模块>.md` | 各自 | 模块说明（接口/算法/边界） |
| `data/<模块>-*.json` | 各自 | 运行时状态，文件名带模块前缀 |

**公共依赖（只读）**：`src/core/http.mjs`（微框架）、`src/core/util.mjs`（工具）、`src/core/config.mjs`（配置，注意用 `dataDir()` 惰性函数而不是 DATA_DIR 常量）、`src/core/store.mjs`（JSON 持久化）、`src/core/log.mjs`、`src/core/library-index.mjs`（库索引只读视图，mtime 缓存）、`src/core/reading-progress.mjs`（阅读进度统一读写）、`src/core/roots.mjs`（**多库根**）。

### 多库根（v2 新增，所有涉及"库目录"的模块都必须走它）

漫画库不再是单一路径，而是**库根数组**：`config.libraryRoots = [{id,name,path,enabled}]`，
当前为 `picacg`（哔咔下载库，196 部）+ `early`（先期漫画，53 部 / 5937 图 / 2.28GB，图片直接躺在漫画目录、无 元数据.json）。

```js
import { roots, activeRoots, rootById, rootByPath, ownerRootOf, labelOf, probeRoots } from '../../core/roots.mjs';
- roots(cfg)         // 规范化数组（含 enabled），兼容旧单值 libraryRoot
- activeRoots(cfg)   // 仅启用的
- ownerRootOf(cfg, absPath)  // 某绝对路径属于哪个根（做 safeJoin 基准 / 删除校验）
- labelOf(cfg, id)   // 中文名，UI 显示
- probeRoots(cfg)    // 异步体检：是否存在 / 目录数
```
**硬性要求**：任何"库目录"相关的路径校验，基准根必须来自 `ownerRootOf`/`roots`，禁止再硬编码 `ctx.config.libraryRoot`（可回退，但优先数组）。

---

## 0. v2 视觉与交互规范（必读）

见 [docs/UI_GUIDELINE.md](./UI_GUIDELINE.md)：**RISOPRINT · 深夜制本所** 主题。
旧版那套「玻璃拟态 + 极光渐变 + 紫青渐变」已被用户点名"AI 风味太强"，**禁止再使用**：
不得出现 `backdrop-filter`、`filter: blur()`、多色渐变背景、胶囊圆角、渐变文字、大模糊阴影。
统一改用：网点纹理、套印错位标题、切角(`.cut`)、硬投影、2px 实线边框、编号小标、红色印章。
**类名契约（v2）已冻结在 UI_GUIDELINE 第 4 节，页面只用其中的类。**

---

## 0.1 桌面端形态（v2）

产品不再是"网页"，而是 **桌面窗口**（Edge/Chrome App 模式）。页面按 `<html data-platform="desktop">` 渲染，
基准窗口 1440×900，不做移动端适配，但 1024 宽不能崩。必须支持 `Ctrl+K` 命令面板、`Ctrl+1..9` 切页、`Esc` 关浮层。

---

## 2. 后端模块契约

文件：`src/modules/<id>/index.mjs`，必须导出：

```js
export const meta = {
  id: 'download',                 // 唯一 id，与目录同名
  name: '下载',                    // 侧边栏显示名
  description: '一句话说明',
  order: 30,
  help: ['GET /api/download/tasks', '...']   // 供 /api/system/info 展示
};

// app: 微框架实例；ctx: 见下
export async function register(app, ctx) { /* 挂路由、恢复任务、订阅事件 */ }

// 可选：进程退出时清理（关闭定时器/等待写盘）
export async function dispose() {}
```

### 2.1 ctx（register 第二参数）

```js
ctx = {
  config,                 // 全量配置对象（含 ctx.config.libraryRoot / downloadRoot / picacomic / dedupe）
  log,                    // createLogger('server') 实例：log.info/warn/error/debug
  projectRoot, dataDir, publicDir,
  reloadConfig(), saveConfig(patch),
  moduleId, moduleMeta
}
```

### 2.2 app（微框架）

```js
app.get('/api/download/tasks', handler)      // 路径参数：'/api/download/tasks/:id'
app.post(...) / app.put(...) / app.del(...)  // del = DELETE
app.static(dir, prefix)                      // 每个模块不要用，Lead 已挂 public/
```

handler 收到单参数 `ctx`（请求上下文）：

```js
ctx.json(data, status?)         // 统一返回 JSON；成功约定：{ ok: true, ... }；失败：{ ok: false, error: '人话原因' }
ctx.text(str, status?, type?)
ctx.error(status, '原因')        // 等价 ctx.json({ok:false,error}, status)
ctx.throwError(400, '参数不合法') // 抛出，由框架兜底成 JSON 错误（抛出前不要写响应）
ctx.query(name, dflt) / ctx.queryInt(name, dflt)
ctx.params.id
ctx.body                        // 已解析的 JSON / 表单 / 文本，可能为 null
ctx.rawBody                     // Buffer
ctx.file(absPath, { downloadName, contentType, cacheSeconds })  // 支持 Range/ETag/304/中文名下载
ctx.sse()                       // SSE 长连接：{ send(event, data), comment(), onClose(fn), close(), closed }
ctx.req / ctx.res / ctx.method / ctx.path
```

### 2.3 硬性约束

1. **路径安全**：任何由请求参数拼出来的文件路径，必须用 `safeJoin(root, rel)`（src/core/util.mjs）拼，越界自动 400。
2. **不阻塞事件循环**：重活（扫描/下载/指纹）放异步任务 + 并发池（`pool(items, limit, worker)`），进度通过 SSE 推。
3. **单飞（Single-flight）**：同一时刻只允许一个扫描/下载任务，重复触发返回 `{ ok:false, error:'已有任务在运行' }`（409）。
4. **外部命令**：调用 PowerShell 用 `import { spawn } from 'node:child_process'`，参数数组传参（不要拼 shell 字符串），并在 dispose 里 kill。
5. **状态持久化**：用 `new JsonStore('download-tasks.json', {})`（后缀 `.markDirty()` 落盘）。
6. **图片/大文件**：一律 `ctx.file()`，不要自己读进内存。
7. **不要新增 npm 依赖**；不要修改 `src/core`、`public/app.js`、`public/theme.css`、其他模块目录。
8. **所有对外文案用中文**，错误信息要说人话（"漫画 ID 不存在"，不要 "undefined is not a function"）。

---

## 3. 前端页面模块契约

文件：`public/modules/<id>.js`（ESM，无构建）。必须导出：

```js
export const meta = { id: 'download', name: '下载', order: 30 };
export async function mount(root, ctx) {            // root: 已清空的容器 div
  ctx.title('下载中心', '搜索哔咔漫画并入库');        // 设置顶栏标题/副标题
  // 渲染页面…
  ctx.registerCleanup(function () { /* 关定时器、断开 EventSource */ });
}
export function unmount() {}                        // 可选
```

### 3.1 前端 ctx API（已实现，直接用，别造轮子）

```js
ctx.el(tag, props?, children?)   // DOM 构造器：el('div', {class:'card card-pad'}, [ el('div',{text:'hi'}) ])
                                 // props: class / text / html / style{}/ dataset{} / on:{click:fn} / 其余作为属性或属性名
ctx.api(path, opts?)             // async，自动 JSON + 抛错（error.message 是后端中文原因）；opts: {method, body}
ctx.get(path) / ctx.post(path, body)
ctx.toast(msg, type?)            // type: 'ok'|'err'|'warn'|'info'
ctx.confirm(msg, opts?)          // async -> boolean；opts:{title, danger:true, okText}
ctx.prompt(msg, dflt?)           // async -> string|null
ctx.modal(opts)                  // -> { close, body, foot, el }；opts:{title, body(node), foot(nodes), wide}
                                 // 注意：.modal-foot 恒存在，可在返回后继续往 ctx.modal(...).foot 里 append 按钮
ctx.icon(name, size?)            // 返回 SVG 元素；name 见下
ctx.fmt.bytes(n) / ctx.fmt.num(n) / ctx.fmt.date(iso) / ctx.fmt.dur(ms)
ctx.on(target, event, fn)        // 自动登记，卸载时统一移除
ctx.registerCleanup(fn)
ctx.state.get(key, dflt) / ctx.state.set(key, value)   // 跨页面内存态
ctx.navigate(hash)               // 例：ctx.navigate('#/reader?comic=xxx')
ctx.params                       // 当前 hash 的查询参数对象（只读快照）
ctx.sse(path, handlers)          // 打开 SSE：handlers={ onEvent(event,data) }，返回 { close() }，自动注册清理
```

图标名：`grid, library, download, search, layers, settings, book, heart, chevron-left, chevron-right, x, check, trash, refresh, play, plus, folder, image, alert, info, clock, star, list, zoom-in, zoom-out, maximize, minimize, arrow-left, arrow-right, hard-drive, sparkles, shield, tag, user, eye, upload, filter, sort, external, copy, bookmark, wand, gauge, terminal`

### 3.2 前端硬性约束

1. **只用 theme.css 里已有的类**（需要新样式就写进你自己的 `public/modules/<id>.css`，用 `mv-` 前缀避免撞车；不要改 theme.css）。
2. 不要引入任何 CDN/第三方 JS。不要用 `innerHTML` 拼接用户数据（用 `ctx.el` + `text`）。
3. 所有异步操作要有 loading 态（`.spinner`）与失败 toast；列表空态用 `.empty` 组件。
4. 页面容器结构：`ctx.el('div',{class:'page'}, [...]) `，标题区用 `.page-head + .page-title + .page-sub`，工具条 `.toolbar`。
5. 中文文案，键盘可达（Enter 提交、Esc 关闭），数字/字节用 `ctx.fmt`。
6. 页面必须在**无数据/后端报错**时也能正常显示（显示 `.alert-err` 或 `.empty`）。

---

## 4. 测试契约

文件：`tests/<id>.test.mjs`：

```js
export const name = '下载模块';           // 必需
export default async function (t) {       // 必需：默认导出 async 函数
  t.ok(cond, '说明');
  t.eq(actual, expected, '说明');
  t.deepEq(actual, expected, '说明');
  await t.throwsAsync(async () => { ... }, /关键字/, '说明');
  t.log('附加信息');
}
```
运行：`node tests/run-tests.mjs`（跑全部）或 `node tests/run-tests.mjs download`（按名字过滤）。
**测试必须离线可跑、不写用户数据目录、不真的去下载；用临时目录（`os.tmpdir()`）验证。**

---

## 5. 系统集成点（必须对接）

- **入库闭环**：下载模块把漫画落到 `ctx.config.downloadRoot`，目录结构必须与现有库一致：
  `<comic_title>/元数据.json`、`<comic_title>/cover.jpg`、`<comic_title>/<order> <chapter_title>/章节元数据.json`、章节目录内 `001.jpg`（三位序号，按 config.picacomic.downloadFormat 决定扩展名）。
  这样 Lead 的 library 模块扫描后**立刻可见、可读**。
- **查重闭环**：dedupe 模块扫描 `ctx.config.dedupe.scanRoot`，与 `ctx.config.dedupe.libRoot`（=漫画库）比对。
- **配置**：新增配置一律从 `ctx.config` 读，默认值在模块内兜底；需要持久化就用 `ctx.saveConfig({...})`。

---

## 6. 交付前自检清单（每个 Agent 必须跑）

```powershell
node --check src/modules/<id>/index.mjs
node --check public/modules/<id>.js
node tests/run-tests.mjs <id>
node -e "import('./src/modules/<id>/index.mjs').then(m=>console.log(Object.keys(m)))"
```
并且**必须**用 `read` 工具读一遍 `src/core/http.mjs` 与 `src/core/util.mjs` 确认 API 用法，不要凭猜测写。
