# T2 交付 · 漫画库滚动修复（已验收）

状态：**已完成并真浏览器验证通过（6/6）**
负责：lead（根因定位 + CSS 修复 + 验证脚本），ui-smith 接手剩余前端工作

---

## 1. 根因（两层，都要修）

### 第一层：CSS 高度链断裂（主因，决定「能不能滚」）

`public/theme.css` 原第 80 行：

```css
.shell { display: grid; grid-template-columns: var(--sidebar-w) 1fr; height: 100vh; padding-top: 4px; }
```

`.shell` 是 grid 容器但没有 `grid-template-rows`，隐式行高为 `auto`，
于是 `.main { height: 100% }` 解析成"跟随内容高度"而不是"撑满可视区"，
`.content { flex: 1; overflow: auto; min-height: 0 }` 的父链无人约束高度 → 容器被内容撑到 6878px → **永远没有滚动条**。

修复：

```css
.shell {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  grid-template-rows: minmax(0, 1fr);   /* 关键：显式约束行高并允许收缩 */
  height: 100vh;
  padding-top: 4px;
}
.main { display: flex; flex-direction: column; min-width: 0; height: 100%; min-height: 0; }
```

> 用 `minmax(0, 1fr)` 而不是 `1fr`：`1fr` 的最小尺寸是 `auto`，行仍会被内容撑开。这是最容易写错的一处。

### 第二层：虚拟网格监听错对象（决定「滚动后有没有重绘」）

`public/app.js` 的 `virtualGrid()` 原实现只监听 `window` 的 `scroll`。
但真实滚动容器是 `#content`（`.content { overflow: auto }`），
**容器内的 scroll 事件不冒泡到 window**，所以即便高度链修好、容器能滚了，虚拟网格依旧不会重绘。

修复：新增 `bindScroller()`，把监听绑到 `findScroller()` 找到的真实滚动祖先，
并用 `MutationObserver` 在容器被替换时重绑；`destroy()` 里对称解绑。

---

## 2. 验收证据（真浏览器 + CDP）

工具：`scripts/dev/ui-scroll-check.mjs`（零依赖，用无头 Edge/Chrome 的 CDP，6 条断言）

```powershell
node scripts/dev/ui-scroll-check.mjs --port=8775
```

**修复前**：

```
[首屏] 卡片数=120 总匹配=249
[滚动容器] {"id":"content","overflowY":"auto","scrollHeight":6878,"clientHeight":6878}
[滚到底] scrollTop=0 卡片数=120
结果: 4/6 通过
```

> 注意 `clientHeight === scrollHeight`：容器压根没滚动条，`scrollTop` 恒为 0。

**修复后**：

```
[首屏] 卡片数=30 总匹配=249
[滚动容器] {"id":"content","overflowY":"auto","scrollHeight":6878,"clientHeight":844}
[滚到底] scrollTop=6034 卡片数=54
[底部再滚] scrollTop=12876/13720 卡片数=27
  ✓ 滚动容器是 #content 且可滚动
  ✓ 首屏确实渲染了卡片
  ✓ 虚拟化生效（首屏卡片数 < 总数）
  ✓ 滚动到底后 scrollTop 真的变了
  ✓ 滚动触发了重绘（卡片仍在渲染）
  ✓ 底部继续滚动有效
结果: 6/6 通过
```

关键对比：`clientHeight 844 < scrollHeight 6878`（可滚），`scrollTop 0 → 6034 → 12876`（滑得动），
卡片数 `30 → 54 → 27`（每屏重绘，不是一次性 249 张）。

---

## 3. 剩余工作（交给 ui-smith）

1. `public/modules/desktop.js` 删除并从导航移除（桌面功能不该是页面模块）。
2. `app.js` 的 `ctx.desktop` 改走 HTTP 桥 `/api/desktop/*`（等 shell-smith 的 T1）。
3. 视觉细节加强（`docs/UI_GUIDELINE.md` 是唯一真源；禁 backdrop-filter / blur / 多色渐变 / 药丸圆角 / 渐变文字）。

## 4. 教训（写进 AGENT.md 第 11 节）

- 全屏布局用 `grid` 时，**必须显式写 `grid-template-rows: minmax(0, 1fr)`**，只写 `1fr` 会被内容撑开。
- 自定义虚拟滚动/懒加载时，**必须绑真实滚动祖先**，不要想当然绑 `window`（容器内 scroll 不冒泡）。
- 这类问题**必须用真浏览器断言**（`clientHeight < scrollHeight`、`scrollTop` 真的变化）才能发现，肉眼看"好像有滚动条"会漏诊。
