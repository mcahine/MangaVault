
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { readJson, atomicWriteJson } from './util.mjs';

/** 代码根目录（只读，不含用户数据） */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * 数据目录的确定顺序（从高到低）：
 *   1. 环境变量 MV_DATA_DIR      —— 测试与多实例用，绝不污染真实数据
 *   2. 命令行 --data-dir=<path>  —— 便携模式
 *   3. exe/仓库同级 data/        —— 便携优先：目录已存在就直接用
 *   4. %LOCALAPPDATA%/MangaVault —— 安装模式默认
 *
 * 必须惰性求值：若在模块加载时求值，同一进程内先导入的模块会把路径钉死。
 */
function cliDataDir() {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--data-dir=')) return path.resolve(a.slice(11));
  }
  return null;
}

/** 只缓存「默认路径」这一支；显式指定的目录必须每次重新求值 */
let defaultDataDirCache = null;

export function dataDir() {
  /* MV_DATA_DIR 与 --data-dir 优先级最高，且**必须每次求值、绝不缓存**。
     原因：同一个进程里多个测试会先后设置不同的 MV_DATA_DIR 做隔离，
     一旦把首次结果缓存下来，后续测试就读到上一个测试的目录 ——
     曾导致 desktop / reader 测试互相污染（读到别人的索引与窗口记忆）。 */
  if (process.env.MV_DATA_DIR) return path.resolve(process.env.MV_DATA_DIR);
  const cli = cliDataDir();
  if (cli) return cli;
  if (process.env.MV_PORTABLE === '1') return path.join(PROJECT_ROOT, 'data');
  if (defaultDataDirCache) return defaultDataDirCache;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  defaultDataDirCache = path.join(local, 'MangaVault');
  return defaultDataDirCache;
}

/** 让 dataDir() 重新求值（换数据目录时用；同时清空配置缓存） */
export function resetDataDir() { defaultDataDirCache = null; cached = null; }

/** 数据目录中的文件路径 */
export function dataPath() {
  const parts = Array.prototype.slice.call(arguments);
  return path.join.apply(path, [dataDir()].concat(parts));
}

/** 配置文件：一定在数据目录内，绝不写回代码目录 */
export function configFile() { return dataPath('config.json'); }

/** 配置模板（随代码发布） */
export const CONFIG_TEMPLATE = path.join(PROJECT_ROOT, 'config.example.json');

/** 兼容旧代码：CONFIG_FILE 曾指向仓库根 config.json */
export function legacyConfigFile() { return path.join(PROJECT_ROOT, 'config.json'); }

export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

export const DEFAULTS = {
  port: 8775,
  host: '127.0.0.1',
  libraryRoot: '',
  downloadRoot: '',
  logLevel: 'info',
  /** 多库根：{ id, name, path, enabled } */
  libraryRoots: [],
  /** 数据目录留空表示用默认规则，见 dataDir() */
  dataDir: '',
  picacomic: {
    apiBase: 'https://picaapi.picacomic.com',
    /**
     * 留空表示使用 src/modules/download/api.mjs 里的 PICA_API_KEY 真值。
     * 这里曾写死过一个 64 位伪造串，被当成「默认值」合并进用户配置后，
     * 每个请求都带着错的 api-key —— 与 UA 污染叠加，表现为登录恒失败。
     */
    apiKey: '',
    appVersion: '2.2.1.2.3.3',
    appPlatform: 'android',
    appBuildVersion: '44',
    appUuid: '',
    token: '',
    proxy: null,
    downloadFormat: 'Jpeg',
    dirFmt: '{comic_title}/{order} {chapter_title}',
    chapterConcurrency: 2,
    chapterIntervalMs: 8000,
    imgConcurrency: 12,
    imgIntervalMs: 2500,
    shouldDownloadCover: true,
    retryTimes: 3,
    timeoutMs: 30000
  },
  dedupe: {
    scanRoot: '',
    libRoot: '',
    pixelThreshold: 8,
    thumbCount: 6,
    pixelReview: true
  }
};

/** 剥掉模板里的 // 注释键，避免污染运行时配置 */
function stripComments(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k.startsWith('//')) continue;
    out[k] = stripComments(obj[k]);
  }
  return out;
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = Object.assign({}, base);
  for (const key of Object.keys(patch)) {
    out[key] = deepMerge(base[key], patch[key]);
  }
  return out;
}

/**
 * 兼容旧的 picacomic-downloader 配置：它把 token / 下载目录放在上一级目录的 config.json。
 * 只借用缺失字段，不改写对方文件。
 */
async function readLegacyConfig() {
  const legacyPath = path.join(path.dirname(PROJECT_ROOT), 'config.json');
  if (legacyPath === configFile()) return null;
  const raw = await readJson(legacyPath, null);
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

/**
 * 配置对象是**共享引用**：所有模块在 register 时拿到的 ctx.config 都指向同一个对象。
 * 因此更新配置时必须原地改写（而不是替换引用），否则改了库根等设置后，
 * 已注册的模块仍然读旧值 —— 曾导致「改了库根但管理台还是旧数据」。
 */
function applyInPlace(target, next) {
  for (const k of Object.keys(target)) if (!(k in next)) delete target[k];
  for (const k of Object.keys(next)) {
    const v = next[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      applyInPlace(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

let cached = null;

/** 首次启动时把 config.example.json 拷成 data/config.json，保证有模板可读 */
async function ensureConfigFile() {
  const file = configFile();
  try { await fsp.access(file); return; } catch (e) { /* 需要创建 */ }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let seed = {};
  try {
    const tpl = await fsp.readFile(CONFIG_TEMPLATE, 'utf8');
    seed = JSON.parse(tpl);
  } catch (e) { seed = {}; }
  await atomicWriteJson(file, seed);
}

export async function loadConfig(force) {
  if (cached && !force) return cached;
  await ensureConfigFile();
  const user = await readJson(configFile(), {});
  let merged = deepMerge(DEFAULTS, stripComments(user) || {});
  const legacy = await readLegacyConfig();
  if (legacy) {
    if (!merged.picacomic.token && legacy.token) merged.picacomic.token = legacy.token;
    if (!merged.libraryRoot && legacy.downloadDir) merged.libraryRoot = legacy.downloadDir;
    if (!merged.picacomic.dirFmt && legacy.dirFmt) merged.picacomic.dirFmt = legacy.dirFmt;
  }
  if (!merged.downloadRoot) merged.downloadRoot = merged.libraryRoot;
  if (!merged.dedupe.libRoot) merged.dedupe.libRoot = merged.libraryRoot;
  if (!merged.picacomic.appUuid) merged.picacomic.appUuid = 'mv-' + process.pid + '-' + Date.now().toString(36);
  // 历史污染自愈：早期模板里写死过一个 64 位伪造 apiKey，随 deepMerge 进了用户配置，
  // 导致所有请求带错 api-key（与 UA 污染叠加后表现为「登录怎么都不成功」）。
  // 官方真值是 **29 位** C69BAF41DA5ABD1FFEDC6D2FEA56B（与 _ref_downloader 的
  // pica_client.rs 逐字节一致），不是 32 位 —— 别照字面猜长度。
  // 这里只在值不是官方真值时清空，交回 api.mjs 的 PICA_API_KEY 常量兜底，用户无需手改配置。
  if (merged.picacomic.apiKey && String(merged.picacomic.apiKey) !== 'C69BAF41DA5ABD1FFEDC6D2FEA56B') merged.picacomic.apiKey = '';
  if (cached) return applyInPlace(cached, merged);
  cached = merged;
  return merged;
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = deepMerge(current, patch || {});
  applyInPlace(current, next);
  await atomicWriteJson(configFile(), current);
  cached = current;
  return current;
}

export function projectPath() {
  return { PROJECT_ROOT, CONFIG_FILE: configFile(), DATA_DIR: dataDir(), PUBLIC_DIR: PUBLIC_DIR };
}
