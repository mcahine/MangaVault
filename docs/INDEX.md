# 文档总入口 · INDEX

> 这份索引**按「我想做什么」组织**，不按目录。30 秒内找到你要的东西。
> 如果你是第一次接手这个项目 → 先读 **[AGENT.md](../AGENT.md)**，再回来按需跳转。

---

## 0. 三条最常走的路

| 我想…… | 去哪 |
| --- | --- |
| **用起来**（怎么装、怎么用、怎么卸载） | [README.md](../README.md) |
| **先看看长什么样** | [README.md](../README.md) 的「界面速览」；原图在 [screenshots/](screenshots/) |
| **改代码**（约定、铁律、模块怎么加） | [AGENT.md](../AGENT.md) → [MODULE_CONTRACT.md](MODULE_CONTRACT.md) |
| **搞不懂某处为什么这样设计** | [ARCHITECTURE.md](ARCHITECTURE.md) |

---

## 1. 按「我想做什么」导航

### 我想用这个软件

| 我想…… | 去哪 |
| --- | --- |
| 安装、首次启动、添加库根 | [README.md](../README.md) 的「怎么装」 |
| 学会界面各页面怎么用 | [README.md](../README.md) 的「怎么用」 |
| 知道数据都存在哪、怎么备份 | [README.md](../README.md) 的「文件位置」「数据备份」 |
| 解决某个报错 | [README.md](../README.md) 的「常见问题」 |
| 干净卸载 | [README.md](../README.md) 的「卸载」 |

### 我想接入自己的漫画

| 我想…… | 去哪 |
| --- | --- |
| 搞懂「库根 / 漫画 / 章节」到底是什么 | [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md) 第 1 节 |
| 知道我的目录算不算合法形态 | [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md) 第 2 节（L2/L1/L0/L1+ 四种形态） |
| 写 `元数据.json` / `章节元数据.json` | [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md) 第 3 节 |
| 让封面正常显示 | [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md) 第 3.3 节（优先级） |
| 知道自己的库「健全度」是 A/B/C/D 哪一级、缺什么 | [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md) 第 5 节 |
| 把乱糟糟的目录名规范化、补元数据与封面 | [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md) 第 5.1 节；执行报告见 `docs/NORMALIZE_REPORT.md` |
| 加一个全新的漫画来源 | [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md) 第 6 节（5 步，不改代码） |

### 我想写/改代码

| 我想…… | 去哪 |
| --- | --- |
| 了解工程铁律与已知坑 | [AGENT.md](../AGENT.md) |
| 加一个新模块（后端或前端） | [MODULE_CONTRACT.md](MODULE_CONTRACT.md) |
| 知道 `ctx` 里有什么、返回约定是什么 | [MODULE_CONTRACT.md](MODULE_CONTRACT.md) |
| 知道进程怎么起、请求怎么走、数据怎么流 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 知道代码与数据怎么分离、数据目录怎么定 | [ARCHITECTURE.md](ARCHITECTURE.md) 的数据/代码分离一节 |
| 写测试 | [MODULE_CONTRACT.md](MODULE_CONTRACT.md) 的测试契约 + [AGENT.md](../AGENT.md) 第 9 节 |

### 我想动界面 / 视觉

| 我想…… | 去哪 |
| --- | --- |
| 知道 RISOPRINT 主题的规则与禁用项 | [UI_GUIDELINE.md](UI_GUIDELINE.md) |
| 查有哪些现成的 CSS 类可用 | [UI_GUIDELINE.md](UI_GUIDELINE.md) 第 4 节（类名契约，已冻结） |
| 改某个具体页面 | 对应的模块文档（见下面「模块文档」表） |

### 我想动某个具体模块

| 模块 | 文档 | 一句话 |
| --- | --- | --- |
| 漫画库（扫描/索引/列表/封面） | [modules/library.md](modules/library.md) | 库的只读视图与扫描器 |
| 阅读器 | [modules/reader.md](modules/reader.md) | 翻页、进度、模式、尺寸预取 |
| 管理台 | [modules/vault.md](modules/vault.md) | 标签体系、批量整理、校验、回收站、备份 |
| 下载中心 | [modules/download.md](modules/download.md) | 哔咔登录、搜索、任务、导出 |
| 下载源适配器 | [DOWNLOAD_SOURCES.md](DOWNLOAD_SOURCES.md) | 怎么接一个新的下载源 |
| 查重台 | [modules/dedupe.md](modules/dedupe.md) | 字节查重 + 像素指纹 + 审核删除 |
| 桌面宿主 | [DESKTOP.md](DESKTOP.md) | exe 宿主、构建、打包、发布 |

### 我想做桌面端 / 打包

| 我想…… | 去哪 |
| --- | --- |
| 看懂桌面宿主架构（exe + WebView2） | [ARCHITECTURE.md](ARCHITECTURE.md) 第 2、10 节；[DESKTOP.md](DESKTOP.md) |
| 构建 exe | `node scripts/build-desktop.mjs`（可加 `--with-node` 打包 Node） |
| 验证 exe 真的能跑 | `node scripts/dev/desktop-selftest.mjs`（12 条证据，见 [ARCHITECTURE.md](ARCHITECTURE.md) 第 10 节） |
| 知道桌面桥提供哪些原生能力 | [README.md](../README.md) 的「方式 A」原生能力表；接口清单见 `src/modules/desktop/index.mjs` 的 `meta.help` |
| 了解历史（v2）桌面模块的实现与限制 | [modules/desktop.md](modules/desktop.md) |

### 我想知道项目现在什么状态

| 我想…… | 去哪 |
| --- | --- |
| 看最近一次审计结论与已知缺口 | [AUDIT.md](AUDIT.md) |
| 看任务分工与写入范围 | [team/README.md](team/README.md) |
| 看 v3 任务书（6 条用户问题） | [team/v3-taskbook.md](team/v3-taskbook.md) |
| 看 v4 任务书（翻页方向 bug + 下载能力补全 + 冻结接口契约） | [team/v4-taskbook.md](team/v4-taskbook.md) |
| **看当前进度**（谁做完了、卡在哪、每轮的验收证据） | [team/round-progress.md](team/round-progress.md) |
| 看 v7 快速查重的设计 | [team/dedupe-v7-fast-plan.md](team/dedupe-v7-fast-plan.md) |
| 看 v4 历史进度 | [team/v4-progress.md](team/v4-progress.md) |
| 看 v3 历史进度 | [team/v3-progress.md](team/v3-progress.md) |
| 看某个成员做了什么、证据是什么 | `docs/team/task-*.md`（例：[task-7-data-separation.md](team/task-7-data-separation.md)、[task-9-ui-scroll.md](team/task-9-ui-scroll.md)） |

---

## 2. 文档地图（按文件）

### 顶层

| 文件 | 内容 | 什么时候读 |
| --- | --- | --- |
| [AGENT.md](../AGENT.md) | 项目入口：这是什么、铁律、目录结构、编码约定、已知坑 | **第一次接手必读** |
| [README.md](../README.md) | 面向使用者：安装、使用、备份、卸载、FAQ | 想用起来 |
| [INDEX.md](INDEX.md) | 你正在读的这份 | 找不到东西时 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 参与方式、环境、基线命令、6 条硬约束、提交规范 | 想提 PR |
| [SECURITY.md](../SECURITY.md) | 处理哪些敏感数据、哪些行为**不算**漏洞、私密报告通道 | 发现安全问题 |
| [CHANGELOG.md](../CHANGELOG.md) | 对外可见的版本变化 | 想知道这版有什么 |
| [LICENSE](../LICENSE) | MIT | 想二次分发 |

### 契约类（改了会影响双方）

| 文件 | 内容 | 唯一真源？ |
| --- | --- | --- |
| [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md) | 磁盘布局、元数据字段、四种形态、健全度分级 | ✅ 数据与代码间的接口 |
| [MODULE_CONTRACT.md](MODULE_CONTRACT.md) | 模块怎么写、`ctx` 有什么、返回约定、测试契约 | ✅ 模块接口 |
| [UI_GUIDELINE.md](UI_GUIDELINE.md) | RISOPRINT 视觉规范、类名契约、禁用项 | ✅ 视觉唯一真源 |

### 架构与实现

| 文件 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 进程模型、exe 宿主、请求生命周期、数据流、代码与数据分离 |
| [DESKTOP.md](DESKTOP.md) | Windows exe 宿主：构建、打包、原生能力、发布 |
| [DOWNLOAD_SOURCES.md](DOWNLOAD_SOURCES.md) | 下载源适配器契约与新增步骤 |
| [NORMALIZE_REPORT.md](NORMALIZE_REPORT.md) | 先期漫画规范化前后对比与样例 |

### 模块文档

| 文件 | 模块 |
| --- | --- |
| [modules/library.md](modules/library.md) | 漫画库（扫描器、索引、列表） |
| [modules/reader.md](modules/reader.md) | 阅读器（章节、进度、尺寸预取、翻页条） |
| [modules/vault.md](modules/vault.md) | 管理台（标签、整理、校验、回收站、备份） |
| [modules/download.md](modules/download.md) | 下载中心 |
| [modules/dedupe.md](modules/dedupe.md) | 查重台 |
| [modules/desktop.md](modules/desktop.md) | 桌面模块（**v2 历史形态**：Node 启动器 + Edge `--app=` 窗口；v3 已改为 exe 宿主，见 [ARCHITECTURE.md](ARCHITECTURE.md)） |

### 审计与团队

| 文件 | 内容 |
| --- | --- |
| [AUDIT.md](AUDIT.md) | 静态审计结论、已知缺口、每条带复现命令 |
| [team/README.md](team/README.md) | 角色与写入范围、共享热点文件、接口冻结表 |
| [team/round-progress.md](team/round-progress.md) | **最新进度看板**：按轮次记录每个需求的根因、改动与验收证据 |
| [team/v4-progress.md](team/v4-progress.md) | v4 进度看板：已完成 / 待验收 / 未开始三档 + 运维教训 + 测试基线 |
| [team/v3-progress.md](team/v3-progress.md) | v3 历史进度看板 |
| [team/v3-taskbook.md](team/v3-taskbook.md) | v3 全部任务的现状/目标/验收/边界 |
| [team/v4-taskbook.md](team/v4-taskbook.md) | **v4 冻结契约**：阅读器翻页方向唯一真源、leaderboard/profile 接口契约、5 条工作流文件所有权、参考下载器 26 命令对账表 |
| [team/task-7-data-separation.md](team/task-7-data-separation.md) | T7 数据/代码分离：四级优先级、模板播种、既有索引迁移 |
| [team/task-9-ui-scroll.md](team/task-9-ui-scroll.md) | T2 漫画库滚动修复：根因、改动、真浏览器验收证据 |
| `docs/team/task-*.md` | 其他成员的交付记录与证据（如 task-4 / 5 / 6、task-7-qa） |

---

## 3. 常用命令速查

```powershell
# 启动
node src/server.mjs                 # 开发模式，前台跑

# 测试
node tests/run-tests.mjs            # 全部
node tests/run-tests.mjs vault      # 只跑名字含 vault 的用例

# 质量
node scripts/audit.mjs              # 静态审计 → docs/AUDIT.md
node scripts/tidy.mjs               # 工程卫生检查（默认 dry-run）

# 桌面 exe
node scripts/build-desktop.mjs      # 构建 → dist\
node scripts/dev/desktop-selftest.mjs   # exe 自检（fire-and-forget，读 trace 断言 12 条）

# 验收
node scripts/dev/vault-acceptance.mjs   # 管理台破坏性验收（隔离样本）
node scripts/dev/ui-scroll-check.mjs    # 真浏览器验证列表滚动
```

> 提交前请跑 `tests/run-tests.mjs` 与 `scripts/tidy.mjs`；证据要贴**真实输出**，不要口头声称完成。

---

## 4. 关键概念速查

| 概念 | 一句话 | 详见 |
| --- | --- | --- |
| **库根（root）** | 一个漫画目录，登记在 `config.libraryRoots[]`，可以有任意多个 | [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md) §1 |
| **漫画（comic）** | 库根下的一级子目录，最小管理单元 | 同上 |
| **章节（chapter）** | 漫画目录下含图的子目录，或漫画目录本身（裸形态） | 同上 |
| **四种形态** | L2 规范 / L1 多章无语义 / L0 裸形态 / L1+ 深一层 | [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md) §2 |
| **健全度 A/B/C/D** | 告诉用户「这本还缺什么」，而不是拒绝服务 | [LIBRARY_FORMAT.md](LIBRARY_FORMAT.md) §5 |
| **有效标签** | 自动派生 ∪ 覆盖层（add 优先于 remove） | [modules/vault.md](modules/vault.md) §3.4 |
| **单飞（single-flight）** | 同一时刻只允许一个扫描/下载任务，重复触发 409 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **dry-run 优先** | 破坏性操作先出计划，确认后才落地 | [AGENT.md](../AGENT.md) §8 |
| **代码与数据分离** | 数据永不属于代码仓库，默认落在 `%LOCALAPPDATA%\MangaVault` | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **`MV_DATA_DIR`** | 把数据目录指向别处（测试/多实例隔离靠它） | [ARCHITECTURE.md](ARCHITECTURE.md) |

---

## 5. 维护这份索引

- 新增文档 → 在「文档地图」加一行，并在「按我想做什么」里找到对应意图。
- 文档改路径 → 记得回来改链接（仓库有交叉引用检查，断链会被报出来）。
- 写成 `代码体` 而不是链接的条目，表示**该文件尚未落地** —— 这是事实状态；等它交付后再改成链接和标题。
- 当前索引里**已没有**未落地条目；新增待办时请沿用同一约定。
