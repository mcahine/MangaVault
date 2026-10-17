
import path from 'node:path';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const name = '前端页面模块（加载+挂载）';

/* ============================================================
   最小 DOM 桩 + 假 ctx：在 Node 里真的执行每个页面的 mount()。
   目的不是替代浏览器，而是抓出「页面一挂载就抛异常」这类错误
   （比如访问 undefined 的属性、写错事件名、约定不符）。
   ============================================================ */

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, dataset: {}, children: [], attributes: {},
    textContent: '', innerHTML: '', value: '', className: '', disabled: false, title: '', src: '',
    appendChild: function (c) { node.children.push(c); return c; },
    removeChild: function (c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); },
    remove: function () { if (node.parentNode) node.parentNode.removeChild(node); },
    addEventListener: function () {}, removeEventListener: function () {},
    setAttribute: function (k, v) { node.attributes[k] = v; }, getAttribute: function (k) { return node.attributes[k] === undefined ? null : node.attributes[k]; },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    classList: {
      _s: {},
      add: function (c) { this._s[c] = true; }, remove: function (c) { delete this._s[c]; },
      toggle: function (c, on) { if (on === undefined) { if (this._s[c]) delete this._s[c]; else this._s[c] = true; } else if (on) this._s[c] = true; else delete this._s[c]; },
      contains: function (c) { return Boolean(this._s[c]); }
    },
    focus: function () {}, blur: function () {}, select: function () {},
    scrollIntoView: function () {}, requestFullscreen: function () { return Promise.resolve(); },
    parentNode: null
  };
  const origAppend = node.appendChild;
  node.appendChild = function (c) { c.parentNode = node; return origAppend(c); };
  return node;
}

/** 与 public/app.js 的 el() 行为一致的最小实现 */
function el(tag, props, children) {
  const node = makeNode(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v === null || v === undefined || v === false) continue;
      if (key === 'class' || key === 'className') node.className = v;
      else if (key === 'text') node.textContent = String(v);
      else if (key === 'html') node.innerHTML = v;
      else if (key === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (key === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
      else if (key === 'on' && typeof v === 'object') { for (const ev of Object.keys(v)) node.addEventListener(ev, v[ev]); }
      else node[key] = v;
    }
  }
  appendAll(node, children);
  return node;
}

function appendAll(node, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) { for (const c of children) appendAll(node, c); return; }
  if (children && typeof children === 'object' && typeof children.appendChild === 'function') { node.appendChild(children); return; }
  const text = makeNode('span');
  text.textContent = String(children);
  node.appendChild(text);
}

function installStubs() {
  const body = makeNode('body');
  globalThis.document = {
    createElement: function (t) { return makeNode(t); },
    createElementNS: function (ns, t) { return makeNode(t); },
    createTextNode: function () { return makeNode('text'); },
    body: body, documentElement: makeNode('html'),
    getElementById: function () { return makeNode('div'); },
    addEventListener: function () {}, removeEventListener: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    fullscreenElement: null, exitFullscreen: function () { return Promise.resolve(); }, readyState: 'complete'
  };
  globalThis.window = { addEventListener: function () {}, location: { hash: '' }, __MV_INFO__: null };
  globalThis.location = { hash: '' };
  globalThis.EventSource = function () { this.close = function () {}; this.addEventListener = function () {}; this.onmessage = null; this.onerror = null; };
  globalThis.Image = function () {};
  globalThis.requestAnimationFrame = function () { return 0; };
  globalThis.IntersectionObserver = function () { this.observe = function () {}; this.disconnect = function () {}; };
  globalThis.fetch = function () { return Promise.reject(new Error('测试环境禁止联网')); };
  return body;
}

/** 假 ctx：把后端响应换成可预测的样例数据，覆盖契约里的所有方法 */
function makeCtx(params, record) {
  const responses = {
    '/api/library/stats': { ok: true, stats: { comics: 2, chapters: 3, images: 9, bytes: 1048576, withMeta: 2, empty: 0 }, scannedAt: '2026-01-01T00:00:00.000Z', facets: { tags: [{ name: '純愛', count: 2 }], authors: [], categories: [] }, issues: { noMeta: 0, empty: 0 } },
    '/api/library/continue': { ok: true, items: [{ progress: { comicId: 'c1', chapter: 2, index: 3, chapterRead: 4, percent: 12, updatedAt: '2026-01-01T00:00:00.000Z' }, comic: sampleComic() }] },
    '/api/library/comics': { ok: true, total: 1, page: 1, size: 48, pages: 1, items: [Object.assign(sampleComic(), { progress: null, favorite: false })] },
    '/api/library/facets': { ok: true, facets: { tags: [{ name: '純愛', count: 1 }], authors: [] }, stats: { comics: 1 } },
    '/api/library/health': { ok: true, root: 'X', indexed: 1, noMeta: [], empty: [], duplicatedTitles: [] },
    '/api/library/random': { ok: true, comic: sampleComic() },
    '/api/reader/prefs': { ok: true, prefs: { mode: 'single', fit: 'height', rtl: true, gap: 0, preload: 3, autoHideBar: true } },
    '/api/reader/chapter': {
      ok: true,
      comic: { id: 'c1', title: '样例漫画', author: '作者', dir: '样例漫画', cover: null, chapterCount: 2, images: 4, tags: ['純愛'] },
      chapter: { order: 1, title: '第1話', count: 2, dir: '1 第1話' },
      pages: [{ index: 0, name: '001.jpg', url: '/api/library/image?comic=c1&order=1&file=001.jpg' }, { index: 1, name: '002.jpg', url: '/api/library/image?comic=c1&order=1&file=002.jpg' }],
      chapters: [{ order: 1, title: '第1話', count: 2 }, { order: 2, title: '第2話', count: 2 }],
      prev: null, next: { order: 2, title: '第2話' }, index: 0, total: 2
    },
    '/api/reader/progress': { ok: true, progress: { chapter: 1, index: 0 } },
    '/api/download/state': { ok: true, hasToken: true, tokenPreview: 'abc...', downloadRoot: 'X', rootExists: true, freeBytes: 1024, format: 'Jpeg', ext: 'jpg', dirFmt: '{comic_title}/{order} {chapter_title}', apiBase: 'https://x', runningTasks: 0, queuedTasks: 0, totalTasks: 0, concurrency: {} },
    '/api/download/tasks': { ok: true, tasks: [], stats: { total: 0, running: 0, queued: 0, paused: 0, done: 0, error: 0, canceled: 0 } },
    '/api/dedupe/state': { ok: true, running: false, configured: true, paths: { scanRoot: 'X', libRoot: 'Y', root: 'Z' }, scan: null, python: { available: false }, stats: {} },
    '/api/dedupe/units': { ok: true, units: [], total: 0, page: 1, pages: 0 },
    '/api/dedupe/stats': { ok: true, stats: { units: 0, exact: 0, pixel: 0, partial: 0, missing: 0, bytes: 0, bytesText: '0 B' } },
    '/api/system/info': { ok: true, name: '漫库 MangaVault', version: '1.0.0', node: 'v24', platform: 'win32', pid: 1, projectRoot: 'X', configFile: 'X', dataDir: 'X', libraryRoot: 'X', downloadRoot: 'X', startedAt: Date.now(), uptimeMs: 1000, modules: [{ id: 'library', name: '漫画库', ok: true }] },
    '/api/config': { ok: true, config: { port: 8775, host: '127.0.0.1', libraryRoot: 'X', downloadRoot: 'Y', logLevel: 'info', dedupe: { scanRoot: 'A', libRoot: 'B', pixelThreshold: 8 }, picacomic: { apiBase: 'https://x', appVersion: '1', dirFmt: 'f', downloadFormat: 'Jpeg', chapterConcurrency: 2, imgConcurrency: 12, hasToken: true, tokenPreview: 'abc...' } } },
    '/api/modules': { ok: true, modules: [] }
  };
  function pick(p) {
    const key = String(p).split('?')[0];
    if (responses[key]) return JSON.parse(JSON.stringify(responses[key]));
    return { ok: true, items: [], tasks: [], units: [], comics: [], chapters: [], pages: [], stats: {}, total: 0, modules: [], config: {} };
  }
  return {
    el: el,
    icon: function (n, s) { return makeNode('svg'); },
    fmt: {
      bytes: function (n) { return String(n) + ' B'; },
      num: function (n) { return String(n); },
      date: function () { return '2026-01-01'; },
      dur: function () { return '1 秒'; }
    },
    api: async function (p) { record.calls.push(p); return pick(p); },
    get: async function (p) { record.calls.push(p); return pick(p); },
    post: async function (p, b) { record.calls.push(p); record.posts.push({ p: p, b: b }); return pick(p); },
    toast: function (m, t) { record.toasts.push([t || 'info', String(m)]); },
    confirm: async function () { return true; },
    prompt: async function () { return 'DELETE'; },
    modal: function (o) { record.modals.push(o && o.title); return { close: function () {}, body: makeNode('div'), el: makeNode('div') }; },
    on: function () {},
    sse: function (p) { record.calls.push('SSE ' + p); return { close: function () {} }; },
    registerCleanup: function () {},
    title: function (m, s) { record.titles.push([m, s]); },
    sub: function () {},
    navigate: function (h) { record.navigations.push(h); },
    params: params || {},
    pageId: 'x',
    state: { get: function (k, d) { return d; }, set: function () {} },
    empty: function (t, s) { return el('div', { class: 'empty' }, [el('div', { class: 'empty-title', text: t }), el('div', { text: s })]); }
  };
}

function sampleComic() {
  return { id: 'c1', dir: '样例漫画', title: '样例漫画', author: '作者', tags: ['純愛'], pagesCount: 4, chapterCount: 2, images: 4, bytes: 1048576, likes: 10, views: 20, cover: true, hasMeta: true, description: 'd', chineseTeam: '', createdAt: null, updatedAt: null, favorite: true, progress: { chapter: 1, index: 0, percent: 10 } };
}

export default async function (t) {
  const body = installStubs();
  const dir = path.resolve(import.meta.dirname, '..', 'public', 'modules');
  const files = (await fsp.readdir(dir)).filter(function (f) { return f.endsWith('.js'); }).sort();
  const expected = ['about', 'dedupe', 'download', 'library', 'reader', 'settings'];

  t.ok(files.length >= 6, '页面模块数量 ' + files.length);
  for (const id of expected) t.ok(files.includes(id + '.js'), '存在 ' + id + '.js');

  for (const file of files) {
    const id = file.replace(/\.js$/, '');
    let mod = null;
    try { mod = await import(pathToFileURL(path.join(dir, file)).href); }
    catch (err) { t.ok(false, file + ' 无法 import：' + (err && err.message)); continue; }

    t.eq(typeof mod.mount, 'function', file + ' 导出 mount()');
    t.ok(Boolean(mod.meta), file + ' 导出 meta');
    if (mod.meta) {
      t.eq(mod.meta.id, id, file + ' meta.id 与文件名一致');
      t.ok(typeof mod.meta.name === 'string' && mod.meta.name.length > 0, file + ' meta.name 非空');
      t.ok(typeof mod.meta.order === 'number', file + ' meta.order 为数字');
    }

    // 真正挂载一次：抓运行时异常
    const record = { calls: [], posts: [], toasts: [], modals: [], titles: [], navigations: [] };
    const params = id === 'reader' ? { comic: 'c1', order: '1' } : {};
    const root = makeNode('div');
    try {
      await mod.mount(root, makeCtx(params, record));
      // 阅读器是整屏浮层（挂到 document.body 而不是页面容器），其余页面挂在 root 上
      const rendered = id === 'reader' ? document.body.children.length : root.children.length;
      t.ok(rendered > 0, id + ' mount() 后渲染出了 DOM 节点');
    } catch (err) {
      t.ok(false, id + ' mount() 抛异常：' + (err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : err));
    }
    // 只读页面不该有写请求
    if (id !== 'settings' && id !== 'reader') {
      const writes = record.posts.filter(function (x) { return !/progress|prefs/.test(x.p); });
      t.eq(writes.length, 0, id + ' 只读页面不应有写请求（' + JSON.stringify(writes.map(function (x) { return x.p; })) + '）');
    }
  }
}
