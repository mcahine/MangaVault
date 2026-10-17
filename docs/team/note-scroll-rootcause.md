# v3 现场笔记 · 漫画库滚动的真正根因

> 由 lead 在 v3 中断恢复后实测得出。**接手前必读**，别再重复排查。

## 用户症状

漫画库只能看到首屏（120 张卡片），往下滑不动，看不到更多漫画。

## 实测证据（真浏览器 + CDP）

工具：`scripts/dev/ui-scroll-check.mjs`（lead 已写好，已跑通，可直接用）

```
[首屏] 卡片数=120 总匹配=249
[滚动容器] {"id":"content","overflowY":"auto","scrollHeight":6878,"clientHeight":6878}
[滚到底] scrollTop=0 卡片数=120
```

注意 `clientHeight === scrollHeight === 6878`：**#content 根本没有产生滚动条**，
给它设 `scrollTop` 也纹丝不动（scrollTop 恒为 0）。

## 根因：CSS 高度链断裂（不是事件绑定问题）

`public/theme.css` 第 80 行：

```css
.shell { display: grid; grid-template-columns: var(--sidebar-w) 1fr; height: 100vh; padding-top: 4px; }
```

`.shell` 是 grid 容器，但**没有声明 `grid-template-rows`**，于是只有一条隐式行、高度为 `auto`。
`.main { height: 100% }` 的百分比就解析成"跟随内容高度"，而不是"撑满可视区"。
结果：`.content { flex: 1; overflow: auto }` 的父链没有任何一处被约束高度，
容器被内容撑到 6878px，永远没有溢出 → 没有滚动条 → 滚不动。

## 修法（一行级）

```css
.shell {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  grid-template-rows: minmax(0, 1fr);   /* ← 关键：显式约束行高并允许收缩 */
  height: 100vh;
  padding-top: 4px;
}
.main { min-height: 0; }                   /* ← 让 flex 子项也允许被压缩 */
```

> `minmax(0, 1fr)` 而不是 `1fr`：`1fr` 的最小尺寸是 `auto`，仍会被内容撑开；`minmax(0, 1fr)` 才允许收缩。

## lead 已经做完的部分（不要重复）

1. `public/app.js` 的 `virtualGrid()` 已改为**绑定真实滚动祖先**（`findScroller()`），
   并加了 `MutationObserver` 在容器变化时重绑。这个改动是对的，保留。
   （原来只绑 `window`，而 `#content` 的 scroll 不冒泡到 window —— 这是**第二层**问题，
   高度链修好后它同样会发作，所以两处都要修。）
2. `scripts/dev/ui-scroll-check.mjs` 已可用，断言 6 条，含"容器可滚动""scrollTop 真的变了"。

## 验收

```powershell
node scripts/dev/ui-scroll-check.mjs --port=8775
```

修好后应当看到 `clientHeight < scrollHeight`，且 `scrollTop` 能变到几千。6/6 通过。
