# T7 · 数据/代码分离（lead 交付）

状态：**已完成并验证**

---

## 1. 交付内容

### 1.1 数据目录迁出代码仓库

`src/core/config.mjs` 重写，数据目录按优先级解析：

| 优先级 | 来源 | 用途 |
| --- | --- | --- |
| 1 | `MV_DATA_DIR` 环境变量 | 测试、多实例隔离 |
| 2 | `--data-dir=<path>` | 便携模式 |
| 3 | `MV_PORTABLE=1` → 项目内 `data/` | 绿色版 |
| 4 | `%LOCALAPPDATA%\MangaVault` | 默认（安装模式） |

实测：

```
PROJECT_ROOT=C:\Users\D-001\Desktop\黄漫\MangaVault
dataDir=C:\Users\D-001\AppData\Local\MangaVault
configFile=C:\Users\D-001\AppData\Local\MangaVault\config.json
INSIDE_PROJECT=false
```

### 1.2 配置模板机制

- `config.example.json` 随代码发布（含 `//` 注释键，说明每个字段）。
- 首次启动自动拷到数据目录成为 `config.json`。
- `loadConfig()` 用 `stripComments()` 剥掉 `//` 键，避免污染运行时配置。
- 配置对象仍**原地更新**（`applyInPlace`），保持模块引用稳定。

### 1.3 数据迁移（用户既有数据已保全）

原 `MangaVault/data/` 内容已完整复制到 `%LOCALAPPDATA%\MangaVault\`，含：
`library-index.json`（2,352,766 字节）、`vault-tags.json`、`library-progress.json`、
`download-tasks.json`、`dedupe/`、`backups/`、`vault-trash/` 等。
仓库根的 `config.json`（1,706 字节，v2 真配置）也已迁入数据目录。

### 1.4 归档 picacg处理

`picacg处理/` → `_archive/picacg处理/`，并写 `_archive/README.md` 说明每项能力迁移到了哪里。
**未删除任何用户文件。**

### 1.5 工程卫生

`.gitignore` 覆盖 `data/`、`config.json`、`dist/`、`node_modules`、日志、临时文件。

---

## 2. 修掉的一个真 bug（重要教训）

### 症状

首次实现里我给 `dataDir()` 加了缓存：

```js
let dataDirResolved = null;
export function dataDir() {
  if (dataDirResolved) return dataDirResolved;   // ← 这里是 bug
  if (process.env.MV_DATA_DIR) { dataDirResolved = path.resolve(process.env.MV_DATA_DIR); return dataDirResolved; }
  ...
}
```

### 后果

同一个进程里多个测试会**先后设置不同的 `MV_DATA_DIR`** 做隔离。
一旦首次结果被缓存，后续测试就读到前一个测试的目录 ——

实测表现（全量 476 通过 / 8 失败）：

```
✗ desktop · profile 目录落在数据目录内 | 实际=…\AppData\Local\MangaVault\desktop-profile 期望=…\Temp\mv-desktop-test-…\desktop-profile
✗ desktop · 窗口记忆文件路径正确  | 实际=…\AppData\Local\MangaVault\desktop-window.json 期望=…\Temp\…
✗ reader  · 索引不存在时返回空列表   | 实际=[集成测试残留的索引] 期望=[]
```

### 修法

只缓存「默认路径」这一支；显式指定的目录**每次重新求值**：

```js
let defaultDataDirCache = null;

export function dataDir() {
  if (process.env.MV_DATA_DIR) return path.resolve(process.env.MV_DATA_DIR);  // 不缓存
  const cli = cliDataDir();
  if (cli) return cli;                                                        // 不缓存
  if (process.env.MV_PORTABLE === '1') return path.join(PROJECT_ROOT, 'data');
  if (defaultDataDirCache) return defaultDataDirCache;
  ...
}
```

### 结果

```
修复前: 476 通过 / 8 失败
修复后: 495 通过 / 1 失败     (desktop 85/0, reader 16/0)
```

### 教训（已写入 AGENT.md）

> **可被外部覆盖的配置读取函数不要做无条件缓存。**
> 要么完全惰性，要么只缓存"没有外部覆盖时的默认值"这一支。
> 缓存跨越了"调用方可能改变输入"的边界，就是潜伏的串味 bug。

---

## 3. 剩余

- `reader.test.mjs` 与 `desktop.test.mjs` 现在都全绿，说明污染已根除。
- download 剩 1 条「没有残留临时目录」失败，属 dl-smith 正在改动的文件，已转达。
