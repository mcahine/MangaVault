# 漫库 v2 · 视觉与交互规范（冻结版，所有页面的唯一依据）

> **主题名：RISOPRINT · 深夜制本所**
> 灵感来自丝网印刷（Riso）、同人志装帧、漫画分格与网点纸。
> **明确排除**（上一版被用户点名"AI 风味太强"）：玻璃拟态、极光渐变、大半径模糊阴影、胶囊圆角、紫→青渐变、居中大标题+副标题的落地页套路。

---

## 0. 一句话标准

> 打开界面应该像翻开一本**手工印制的同人志**：墨黑底、纸白字、网点纹理、硬边投影、套印错位的标题、编号小标、红色印章。
> **不是**打开一个 AI 生成的 SaaS 面板。

---

## 1. 印色板（只能从这 10 个色里取，禁止渐变背景）

| Token | 值 | 用途 |
|---|---|---|
| `--ink` | `#14131a` | 主底（墨黑） |
| `--ink-2` | `#1b1a22` | 面板底 |
| `--ink-3` | `#23212b` | 抬升/输入框底 |
| `--paper` | `#f2ece1` | 主字色（纸白） |
| `--paper-dim` | `#cfc7b8` | 次级字 |
| `--mute` | `#8d8678` | 三级字/说明 |
| `--red` | `#ff4b3e` | **主强调（RISO 朱红）** |
| `--pink` | `#ff4fa3` | 荧光粉（收藏/心跳态） |
| `--blue` | `#4a63e7` | RISO 蓝（链接/信息） |
| `--cyan` | `#2ed3c6` | 青（成功/在线） |
| `--yellow` | `#ffc93c` | 黄（警告/高亮） |
| `--line` | `rgba(242,236,225,.16)` | 分隔线 |
| `--line-2` | `rgba(242,236,225,.34)` | 强调边框 |

**允许的"渐变"只有一种**：`repeating-linear-gradient` 做的**斜纹/网点**（印刷底纹），且透明度 < 8%。

---

## 2. 八条硬性手法（每个页面至少用上 5 条）

1. **网点（halftone）**：`.halftone` = `background-image: radial-gradient(currentColor 1px, transparent 1.2px); background-size: 6px 6px;` 用于封面悬浮层、空态、区块角落、进度条底纹。
2. **套印错位**：标题用 `.misprint` = `text-shadow: 2px 2px 0 var(--red);` 或双伪元素红蓝各偏 2px。**只用于大标题**。
3. **切角**：`.cut` = `clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px));`（卡片/按钮/弹窗）。
4. **硬投影（零模糊）**：`box-shadow: 4px 4px 0 rgba(0,0,0,.6)`，强调态用 `4px 4px 0 var(--red)`。**禁止 blur 类阴影**。
5. **2px 实线边框**：`border: 2px solid var(--line)`，hover/选中用 `var(--line-2)` 或印色。
6. **竖排品牌**：侧栏品牌用 `writing-mode: vertical-rl; letter-spacing: .3em;`。
7. **编号小标**：区块标题一律 `01 — 漫画库` 形式（`.label-mono`：等宽大写 + `letter-spacing:.16em` + `--mute`）。
8. **印章**：`.stamp` = 红底纸白字、2px 边框、`transform: rotate(-2deg)`，用于来源/状态标记（如 `已在库` `已下载` `降级`）。

动效：`120–160ms cubic-bezier(.2,.8,.2,1)`，位移 2px、颜色/边框变化为主。
**禁止**：`backdrop-filter: blur()`、`filter: blur()`、`transform: scale(.97)` 这类"软"反馈。

---

## 3. 字体

```css
--font-display: Georgia, "Songti SC", "宋体", "SimSun", serif;   /* 大标题/大数字：印刷感衬线 */
--font-body: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
--font-mono: "Cascadia Mono", Consolas, ui-monospace, monospace;   /* 标签/编号/数字 */
```
- 大数字（统计值）用 `--font-display` + `font-variant-numeric: tabular-nums`，**不要**用渐变文字。
- 小标签用 `--font-mono` + `text-transform: uppercase` + 字距 `.14em`。
- 中文标题可 `font-weight: 700`；避免无衬线大字居中当 Hero。

---

## 4. 类名契约（v2 · 冻结）

### 保留（改样式不改名，页面不用动结构也能焕新）
```
.shell .sidebar .side-nav .nav-item(.active) .nav-ico .nav-txt .nav-badge .main .topbar .topbar-title .topbar-sub
.content .page .page-head .page-title .page-sub .toolbar .section-title .divider
.card .card-pad .panel .hoverable .grid .grid-cards .row .col .between .center .wrap .grow .muted .small .mono
.gap-6 .gap-8 .gap-10 .gap-12 .gap-16 .hidden .nowrap .ellipsis .scroll-y .sticky-top
.btn .btn-primary .btn-ghost .btn-danger .btn-success .btn-sm .btn-icon .btn-block
.input .select .textarea .field .label .hint .searchbox .switch(.on) .checkbox(.on)
.badge .badge-ok .badge-warn .badge-err .badge-accent .tag .chip(.active) .kbd
.stat .stat-row .stat-value .stat-label .comic-card .cover-wrap .cover .cover-overlay .cover-badges .comic-body .comic-title .comic-author
.progress .progress-track .progress-bar .empty .empty-title .spinner .spinner-lg .skeleton
.toast-wrap .toast(.toast-ok/.toast-err/.toast-warn/.toast-info) .modal-mask .modal(.wide) .modal-head .modal-title .modal-body .modal-foot
.table .alert(.alert-warn/.alert-err/.alert-ok/.alert-info) .selectable.selected
.reader-root .reader-bar .reader-stage .reader-page .reader-spread .reader-webtoon .reader-nav .reader-pagebar .reader-strip .reader-thumb(.cur)
```

### 新增（v2 特色件）
| 类 | 作用 |
|---|---|
| `.cut` | 切角（clip-path） |
| `.stamp` | 红色印章标记 |
| `.halftone` | 网点纹理叠加 |
| `.misprint` | 套印错位标题阴影 |
| `.rule` | 粗细双线分隔（1px + 3px） |
| `.label-mono` | 等宽大写小标签 |
| `.num` | 衬线大数字（tabular-nums） |
| `.ledger` / `.ledger-row` | 信息台账行（点线分隔 + mono 值） |
| `.tabbar` / `.tab(.active)` | 页签条（粗底边） |
| `.stripe` | 斜纹底纹 |
| `.tilt` | `rotate(-.6deg)` 手作感 |
| `.frame` | 2px 外框 + 硬投影的"装帧框" |
| `.riso-red .riso-blue .riso-pink .riso-cyan .riso-yellow` | 前景色工具类 |
| `.toolgrid` | 工具箱栅格（比 .grid 更密，用于操作面板） |

**页面自定义样式**：必须放各自的 `public/modules/<id>.css`，类名统一 `mv-<id>-*` 前缀；**禁止修改 theme.css**。

---

## 5. 桌面端约定（v2 开始不再是"网页"）

- 产品形态：**桌面窗口**（Edge/Chrome App 模式，独立窗口、无地址栏/标签页、独立任务栏图标、窗口尺寸与位置记忆）。服务仍是本地 127.0.0.1，仅作内核。
- `<html data-platform="desktop">` 由外壳设置；页面**不要**写"在浏览器中打开"之类的文案。
- 基准窗口 **1440×900**；**不需要移动端适配**，但 1024 宽不能布局崩坏。
- 必须支持：`Ctrl+K` 命令面板、`Ctrl+1..9` 切页、`Esc` 关闭浮层、`F11/Enter` 阅读器全屏。
- 关闭窗口 = 退出应用（desktop 层负责），页面不要自己 `window.close()`。

---

## 6. 性能红线（"流畅好用"的具体标准）

1. 网格/列表 **> 200 项必须虚拟滚动**（只渲染可视区 + 缓冲），列表页滚动必须稳定 60fps。
2. 封面一律 `loading="lazy" decoding="async"`；同一屏最多 60 张封面。
3. 任何点击/请求 **100ms 内必须有视觉反馈**（按钮按下态、骨架屏、spinner）。
4. 禁止一次插入 500+ DOM 节点；批量渲染用 `DocumentFragment`。
5. 长任务（扫描/下载/导出/校验）一律后台 + SSE 进度，**不阻塞 UI**。
6. 首屏可交互 < 800ms（本地）。

---

## 7. 交付前自检

```powershell
node --check public/modules/<id>.js
node tests/run-tests.mjs <id>          # 必须全绿
node tests/run-tests.mjs ui            # 页面契约 + mount 冒烟
```
并在报告里贴出：改了哪些文件、用了哪 5 条手法、性能措施、遗留问题。
