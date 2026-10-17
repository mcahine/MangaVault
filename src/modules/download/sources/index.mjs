import picacomicSource, { createPicacomicSource } from './picacomic.mjs';

/**
 * 下载源注册表。
 *
 * 用法：新增下载源只需在这里 import 并 register()，路由层统一用 get(sourceId) 取适配器，
 * 不再出现任何 source 专有的 if / else。
 *
 * 约定：meta.id 必须小写英文且唯一；重复注册同 id 会覆盖（便于热替换与测试）。
 */

/** 默认下载源：不传 sourceId 时用它。 */
export const DEFAULT_SOURCE_ID = 'picacomic';

/** id -> 适配器。用 Map 保证注册顺序稳定可控。 */
const registry = new Map();

/**
 * id -> (options) => SourceAdapter 的工厂表。
 *
 * 为什么除单例之外还要存工厂：路由层挂载时要用「活读 ctx.config 的配置回调」重建默认源
 * （token / 代理 / 超时都随配置热更新），而 get() 只能拿回注册时造好的那个单例。
 * 有工厂的源用 createInstance(id, options) 造注入依赖的新实例；没工厂的源退回单例。
 */
const factories = new Map();

/** sourceId 归一：空值一律落到默认源。 */
function resolveId(sourceId) {
  return sourceId === undefined || sourceId === null || sourceId === '' ? DEFAULT_SOURCE_ID : String(sourceId);
}

/**
 * 注册一个下载源适配器。
 * @param {object} source 适配器对象，必须提供 meta.id / meta.name / meta.capabilities
 * @returns {object} 传入的适配器，便于链式使用
 */
export function register(source) {
  if (!source || typeof source !== 'object') throw new Error('注册下载源失败：适配器对象为空');
  if (!source.meta || !source.meta.id) throw new Error('注册下载源失败：适配器缺少 meta.id');
  const id = String(source.meta.id).trim();
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error('注册下载源失败：meta.id 只能是小写英文、数字、下划线或短横线，收到：' + id);
  if (!source.meta.name) throw new Error('注册下载源失败：适配器缺少 meta.name（' + id + '）');
  if (!Array.isArray(source.meta.capabilities)) throw new Error('注册下载源失败：适配器缺少 meta.capabilities（' + id + '）');
  registry.set(id, source);
  return source;
}

/**
 * 注销一个下载源（主要给测试与热替换用）。
 * @param {string} sourceId
 * @returns {boolean} 是否真的删掉了
 */
export function unregister(sourceId) {
  return registry.delete(String(sourceId));
}

/**
 * 取一个下载源。省略 sourceId 时返回默认源。
 * @param {string} [sourceId]
 * @returns {object} SourceAdapter
 */
export function get(sourceId) {
  const id = resolveId(sourceId);
  const source = registry.get(id);
  if (!source) {
    throw new Error('未知的下载源：' + id + '（已注册：' + listIds().join('、') + '）');
  }
  return source;
}

/**
 * 是否已注册某个下载源。
 * @param {string} sourceId
 * @returns {boolean}
 */
export function has(sourceId) {
  return registry.has(String(sourceId));
}

/**
 * 登记某下载源的工厂（可选）。没有工厂的源仍可用 register() 注册单例。
 * @param {string} sourceId
 * @param {(options:object) => object} factory
 * @returns {Function} 传入的工厂
 */
export function registerFactory(sourceId, factory) {
  const id = String(sourceId || '').trim();
  if (!id) throw new Error('注册下载源工厂失败：缺少 sourceId');
  if (typeof factory !== 'function') throw new Error('注册下载源工厂失败：factory 必须是函数（' + id + '）');
  factories.set(id, factory);
  return factory;
}

/**
 * 是否登记了工厂（无工厂时 createInstance 退回注册表单例）。
 * @param {string} sourceId
 * @returns {boolean}
 */
export function hasFactory(sourceId) {
  return factories.has(String(sourceId));
}

/**
 * 按 sourceId 造一个可注入外部依赖的适配器实例。
 * 有工厂走工厂（例如传入 config / log / client / transport），没有工厂就退回已注册的单例。
 * @param {string} [sourceId]
 * @param {object} [options] 透传给工厂
 * @returns {object} SourceAdapter
 */
export function createInstance(sourceId, options) {
  const id = resolveId(sourceId);
  const factory = factories.get(id);
  if (factory) return factory(options || {});
  return get(id);
}

/**
 * 全部已注册的适配器（按注册顺序）。
 * @returns {object[]}
 */
export function list() {
  return Array.from(registry.values());
}

/**
 * 全部已注册的下载源 id（按注册顺序）。
 * @returns {string[]}
 */
export function listIds() {
  return Array.from(registry.keys());
}

/**
 * 默认下载源适配器。
 * @returns {object} SourceAdapter
 */
export function defaultSource() {
  return get(DEFAULT_SOURCE_ID);
}

/* 内置源：哔咔。新增来源时在这里补一行 import + register + registerFactory。 */
register(picacomicSource);
registerFactory(picacomicSource.meta.id, createPicacomicSource);

export { NotSupportedError, notSupported, requireCapability, emptyPage, CAPABILITIES, REQUIRED_CAPABILITIES, SEARCH_SORTS, FAVORITE_SORTS, RANK_TYPES } from './types.mjs';
