# 参与贡献

## 先读这三份

1. [AGENT.md](AGENT.md) —— 工程铁律（零第三方依赖、禁模板字符串、2 空格缩进、中文注释、测试只写 `tests/*.test.mjs`）
2. [docs/MODULE_CONTRACT.md](docs/MODULE_CONTRACT.md) —— 模块契约（`meta` / `register` / `dispose` 的形状）
3. [docs/INDEX.md](docs/INDEX.md) —— 按模块查接口、数据结构与已知坑

## 环境

- Node.js **>= 20.11**（实测 v24.18.0）。不需要 `npm install`，仓库里没有第三方依赖。
- 只想改前端/后端：任意现代浏览器即可。
- 要构建桌面 exe：Windows x64 + 系统自带 `csc.exe`（.NET Framework 4.x）+ WebView2 Runtime。

## 基线

```powershell
node tests/run-tests.mjs        # 应当 1440 通过 / 0 失败
node scripts/tidy.mjs           # 工程卫生（目前 69/100，高危 0）
```

改动前先跑一次建立基线，改动后再跑一次。**测试没过就说没过，不要调断言迁就实现。**

## 硬约束（PR 会被这几条卡住）

| 约束 | 说明 |
| --- | --- |
| 零第三方运行时依赖 | 只用 `node:` 标准库与相对路径。`package.json` 不许出现 `dependencies` / `devDependencies` |
| 禁模板字符串 | 统一单引号 `+` 拼接（历史原因，见 AGENT.md 第 8 节） |
| 2 空格缩进 | 不用 Tab |
| 中文注释与界面文案 | 注释说明**为什么**，不复述代码在做什么 |
| 测试只写 `tests/*.test.mjs` | 导出 `name` 与 `default async (t) => {}`；`listen(0)` 随机端口，**禁用 8775** |
| 数据/代码分离 | 运行期数据一律走 `dataPath()`，绝不落进仓库 |

## 提交

- 提交信息说**根因**，不只说现象。「修了崩溃」没有价值，「探测超时被当成窗口关闭，改为连续两次确认」才有。
- 涉及桌面宿主时，改完要 `node scripts/build-desktop.mjs --clean --out=dist`，并确认 `dist` 与源码一致。
- 新增行为要有断言，且断言要真的触发那个机制 —— 典型反例：把预加载数量配得比页数还大，于是「预加载路径」根本没被跑到，测试全绿但功能是坏的。

## 不要提交

哔咔 token、代理密码、你自己漫画库的绝对路径、任何漫画图片。`.gitignore` 已挡住大部分，但请自己再搜一遍。
