
import { createLogger } from '../core/log.mjs';

/**
 * 模块注册表。
 * 每个子模块导出：
 *   export const meta = { id, name, description, order }
 *   export async function register(app, ctx)   // 挂载路由/任务
 *   export async function dispose()            // 可选：优雅退出
 * 模块只允许写自己目录下的文件与 data/ 下自己命名的文件。
 */
/*
 * 模块分两类：
 *   page: true  —— 前端页面模块，会出现在 /api/modules 里，前端据此生成侧栏并动态 import。
 *                 每个页面模块必须在 public/modules/<id>.js 有一份实现，否则前端会报
 *                 「Failed to fetch dynamically imported module」。
 *   page: false —— 能力模块，只往后端挂路由，前端不该看到它，也没有对应的 public 文件。
 *
 * desktop 属于第二类：它是**宿主环境**（exe 的原生桥、窗口记忆、退出、开机自启），
 * 不是给人点的页面。此前它被当成页面模块注册，前端就去找 public/modules/desktop.js ——
 * 那个文件根本不存在（已随页面一起删掉），于是侧栏出现「桌面」并加载失败。
 * 现在把它从页面列表里摘出去：路由照常注册（桥必须活着），但不出现在 /api/modules。
 */
const MODULE_SPECS = [
  { id: 'library', path: './library/index.mjs', page: true },
  { id: 'reader', path: './reader/index.mjs', page: true },
  { id: 'vault', path: './vault/index.mjs', page: true },
  { id: 'download', path: './download/index.mjs', page: true },
  { id: 'dedupe', path: './dedupe/index.mjs', page: true },
  { id: 'desktop', path: './desktop/index.mjs', page: false }
];

export async function loadModules(app, ctx) {
  const log = createLogger('modules', ctx.config.logLevel);
  const loaded = [];
  for (const spec of MODULE_SPECS) {
    try {
      const mod = await import(spec.path);
      const meta = Object.assign({ id: spec.id, name: spec.id }, mod.meta || {});
      if (typeof mod.register === 'function') {
        await mod.register(app, Object.assign({}, ctx, { moduleId: spec.id, moduleMeta: meta }));
      }
      loaded.push({ id: spec.id, name: meta.name, ok: true, page: spec.page !== false, meta: meta, controller: mod });
      log.info('已加载模块 ' + spec.id + ' (' + meta.name + ')');
    } catch (err) {
      log.error('模块 ' + spec.id + ' 加载失败: ' + (err && err.message));
      loaded.push({ id: spec.id, name: spec.id, ok: false, page: spec.page !== false, error: String(err && err.message), controller: null });
    }
  }
  ctx.modules = loaded;
  return loaded;
}
