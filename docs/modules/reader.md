# 阅读器模块（reader）

> 后端：`src/modules/reader/index.mjs`（209 行） ｜ 前端：`public/modules/reader.js`（650 行）+ `public/modules/reader.css`
> 职责：**把章节变成可翻的图片流**——章节数据、图片尺寸预取、阅读偏好、阅读进度。
> 一句话：**它只负责渲染与手感，不拥有任何数据**；索引归 library，进度文件与 library 共用，阅读时长归 vault。

---

## 1. 它解决什么问题

| 真实痛点 | reader 的答案 |
|---|---|
| 条漫一边滚一边跳，滚到哪卡到哪 | 后端 `/sizes` 预读图片头拿宽高，前端给占位块写 `aspect-ratio`，**解码前布局就定好** |
| 翻一页就同时发起十几个请求，当前页反而最慢 | 预加载队列按「离当前页距离」排序 + 并发上限 `PRELOAD_MAX = 4` |
| 日漫要从右往左翻 | `rtl` 偏好，方向键语义随之反向（真源见 `docs/team/v4-taskbook.md`） |
| 每次换章都要重新等 | 相邻章节预取（`/neighbors`）+ `preloadGen` 代次隔离，旧章回包不会污染新章 |
| 看到一半退出，下次要手动找 | 进度自动写回（节流），library 的「继续阅读」直接读它 |
| 想看又不想被顶栏挡 | 翻页条默认淡出（2.8 秒），可锁定常显；顶栏另有 `autoHideBar` 偏好 |

**分工边界**：

| 模块 | 管什么 | 与 reader 的边界 |
|---|---|---|
| **library** | 索引、封面、正文图二进制（`/api/library/image`） | reader **只拿 URL**，图片请求全打到 library 的接口 |
| **vault** | 标签、阅读时长统计 | reader 退出时 `POST /api/vault/reading-time`，vault 没就绪时静默忽略 |
| **app.js** | 路由、DOM 组件、全局快捷键框架 | reader 自己接管键盘（`onKey`），因为翻页语义与全局不同 |

---

## 2. 接口一览（统一前缀 `/api/reader`）

| 方法 | 路径 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/prefs` | — | `{ok,prefs{mode,fit,rtl,gap,bg,preload,autoHideBar,barLock}}` | 阅读偏好。读时永远「默认值 + 存盘值」合并，新增字段对老配置安全 |
| POST | `/prefs` | body 上述任意键 | `{ok,prefs}` | **只接受 `DEFAULTS` 里已有的键**（白名单，防止写垃圾）。`preload` 夹到 0–10 |
| GET | `/chapter` | `comic,order?` | `{ok,comic,chapter,pages[],chapters[],index,total}` | 一次拿齐：图片清单 + 上下章 + 全章节列表。`order` 缺省取第一话 |
| GET | `/neighbors` | `comic,order` | `{ok,current,prev,next,index,total}` | 只回相邻章节（预取用，省一次全量请求） |
| GET | `/sizes` | `comic,order?` | `{ok,count,sizes[]}` | 每张图的宽高，认不出的位是 `null`。**不要过滤 null**，否则与前端的页码对不齐 |
| POST | `/progress` | body `{comicId,chapter,index}` | `{ok,progress}` | 写进度。与 library **共用** `src/core/reading-progress.mjs` |
| GET | `/health` | — | `{ok,...}` | 索引与章节完整性体检 |

`pages[]` 每项是 `{index, name, url}`，`url` 形如 `/api/library/image?comic=ID&order=3&file=001.jpg`。

`DEFAULTS` 常量（`src/modules/reader/index.mjs`）：

| 键 | 默认 | 取值 |
|---|---|---|
| `mode` | `single` | `single` / `spread`（双页）/ `webtoon`（条漫） |
| `fit` | `height` | `height` / `width` / `original` |
| `rtl` | `true` | 日漫默认从右往左 |
| `gap` | `0` | 页间距（px） |
| `bg` | `auto` | `auto` / `black` / `white` / `gray` |
| `preload` | `3` | 0–10 |
| `autoHideBar` | `true` | 顶栏是否自动隐藏 |
| `barLock` | `false` | **翻页条**是否锁定常显 |

> ⚠️ 加偏好键必须**同时改两处**：后端 `DEFAULTS`（否则 `POST /prefs` 的白名单把它丢掉）和前端 `public/modules/reader.js` 里的 `prefs` 初始对象（否则首帧渲染读不到）。历史上 `barLock` 就因为只改了一处，功能上线了但保存永远不生效。

---

## 3. 图片尺寸预取（`src/core/image-size.mjs`）

这是「不卡顿」的地基。

**为什么需要**：`<img>` 不写宽高时，浏览器要等图片下载完并解码才知道尺寸，每加载一张就把后面内容重新挤一遍——条漫里就是「边滚边跳」。

**怎么做**：只读文件头部（`HEAD_BYTES = 64KB`，认不出再补读到 `HEAD_BYTES_BIG = 256KB`）解析宽高，支持的容器：

| 容器 | 解析方式 |
|---|---|
| PNG | 8 字节签名 + `IHDR` 的宽(4BE) 高(4BE) |
| GIF | `GIF8` + 宽(2LE) 高(2LE) |
| WebP | `RIFF....WEBP` + `VP8 `（关键帧头 0x9D 0x01 0x2A 后 14bit）/ `VP8L` / `VP8X` |
| JPEG | 扫 `SOF0/1/2/9/10/14…` 段（**含 progressive**） |

`readImageSizes(files, {concurrency})` 默认并发 16（夹在 1–32），认不出的位返回 `null`。

**缓存**：`/sizes` 结果按「漫画id:章节order:图片数」缓存在内存 `sizeCache`（`SIZE_CACHE_MAX = 32`，LRU 淘汰最旧），因为图片本身不会变。

> 缓存键里带 `ch.images.length` 是有意的：章节里图片增删后张数变了，键就变了，不会拿到旧尺寸。

---

## 4. 前端（`public/modules/reader.js`）

导出 `meta`（`id: reader`、`name: 阅读器`、`order: 20`）、`mount(root, ctx)`、`unmount()`。

### 4.1 三种模式与布局

- `single` / `spread`：图片按 `fit` 缩放居中，`spread` 两页并排（`rtl` 时左右互换）。
- `webtoon`：图片竖向连续排列，**每张都套一个等高占位块**（`holderNode(i)` 用尺寸算出 `aspect-ratio`），加载完原地替换（`swapIn(i)`），不改变总高度。

### 4.2 预加载调度

| 机制 | 位置 | 作用 |
|---|---|---|
| `PRELOAD_MAX = 4` | 常量 | 同时在飞的请求上限 |
| `preloadDone` / `preloadBusy` | Set | 已加载 / 加载中的页码，避免重复请求 |
| `preloadGen` | 递增整数 | **换章代次**。旧章还在飞的图回包时代次不匹配就丢弃，否则会串页 |
| `chapterSeq` | 递增整数 | **尺寸请求代次**。快速切章时旧章的 `/sizes` 后到不会覆盖新章 |
| `fillLoaded()` | 函数 | 重建 DOM 后把已加载的图**直接插回去**，没有它会白屏（见 4.5） |

### 4.3 当前页判定（条漫）

`currentPageByScroll()` + `onStageScroll()`（rAF 节流）**用滚动位置反推当前页**，不用 IntersectionObserver。

> 为什么：占位块高 1979px 而视口只有 762px，只能露出 38.5%，`threshold: [0.4, 0.75]` 的观察器**永远不会触发**——回调不触发，页码就永远停在第一页。凡是「元素比视口大」的场景，可见比例阈值都靠不住。

### 4.4 翻页条显隐

用户原话：「不到这个位置就不显示这个条，可以锁定，但是默认不锁定」。语义：

- **默认不锁定**：鼠标静止 `HIDE_AFTER_MS = 2800`ms 后翻页条淡出；鼠标一动、按任意键、翻页或切章立刻回来。
- **锁定**（`barLock = true`）：任何情况下常显。图钉按钮 `data-act` 为 `bar-lock`，快捷键 `L`。
- 淡出**只降透明度 + 关指针事件，不改布局**，避免像 `display:none` 那样让舞台尺寸抖一下。
- 顶栏是否自动隐藏由既有偏好 `autoHideBar` 决定；两者**共用同一个计时器**，否则会出现「顶栏回来了、翻页条还没回来」的错位观感。

> 坑：`setBarVisible(true)` 里必须同时移除顶栏的 `auto-hide` 类。曾漏掉这一句，顶栏保持 `pointer-events:none`，锁定按钮点都点不动。

### 4.5 三个已修的白屏 / 卡死缺陷（改这块前必读）

1. **`preloadDone` 跨渲染保留而 DOM 每次重建** → 切模式 / 切适应方式后 `startLoad` 直接 return，永远等不到 `swapIn`，白屏，必须刷新。修：重建时作废已显示集合，并新增 `fillLoaded()` 把已加载的图直接填回。
2. **`preloadDone` / `preloadBusy` 按页码索引，而换章后页码从 0 重来** → 旧章回包把新章同页码标成「已加载」，表现为换章后几页空白或串页。修：`preloadGen` 代次。
3. **只用可见比例阈值判当前页** → 元素比视口高时永不触发。修：滚动位置反推。

### 4.6 快捷键（`onKey`）

| 键 | 作用 |
|---|---|
| `←` / `a` | 上一页（`rtl` 时语义反向） |
| `→` / `d` | 下一页 |
| `空格` / `↓` / `PageDown` | 下一页 |
| `↑` / `PageUp` | 上一页 |
| `Home` / `End` | 首页 / 末页 |
| `m` / `f` / `r` / `t` | 模式 / 适应 / 方向 / 缩略图条 |
| `l` | **锁定 / 解锁翻页条** |
| `Enter` | 全屏 |
| `Esc` | 退出阅读（回 `#/library`） |
| `+` / `-` | 缩放 0.4–3.0 |
| `Ctrl+滚轮` | 缩放 |

在 `INPUT` / `SELECT` / `TEXTAREA` 里输入时不劫持按键（只把 `Enter` / `Esc` 当作失焦）。

---

## 5. 已知坑

1. **`/sizes` 的 `order` 必须兜底**：前端为了「章节数据与尺寸并行」，首帧是不带 `order` 的。不兜底会平白多两个 404（历史上真发生过）。
2. **`/sizes` 不要过滤 `null`**：读不到尺寸的位要保持 `null` 占位，前端用默认比例兜底。过滤掉会让 `sizes[i]` 与第 i 页对不上。
3. **`readLibraryIndex()` 的 `inFlight` 并发去重不能删**（见 `docs/modules/library.md` 第 4 节）。阅读器同时请求章节与尺寸，是这条路径最容易踩中的场景。
4. **换章必须重置 `preloadGen` 与 `chapterSeq`**，并清空 `preloadDone` / `preloadBusy`。
5. **`unmount()` 是空实现**：清理靠 `ctx.registerCleanup()`（退出时清计时器、移除 DOM、存进度、上报阅读时长）。新增资源请挂到 cleanup 里，别指望 `unmount`。

---

## 6. 验证方式

```powershell
node tests/run-tests.mjs reader         # 单元/集成：偏好白名单、章节数据、尺寸解析
node scripts/dev/reader-nav-check.mjs   # 真浏览器 headless Edge + CDP，9 条翻页控件断言
```

> `reader-nav-check.mjs` 用 `data-act` 定位控件（`page-num` / `page-total` / `prev-chapter` / `next-chapter` / `prev-page` / `next-page` / `chapter-label` / `reader-pagebar` / `bar-lock`）。**不要**改用 `nth-child` 定位——图标顺序一变就静默失效。