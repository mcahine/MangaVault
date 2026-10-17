/* ===========================================================================
   漫库 MangaVault v2 · 前端外壳（Lead 所有，其他 Agent 只读）
   职责：路由 / 导航 / 命令面板 / ctx 工具集 / 页面模块加载
   基础件在 ui.mjs（图标 / el / fmt / Toast / 对话框），虚拟滚动在 grid.mjs。
   设计依据：docs/UI_GUIDELINE.md（RISOPRINT · 深夜制本所）
   =========================================================================== */
import { icon, el, fmt, toast, modal, confirmDialog, promptDialog } from './ui.mjs';
import { virtualGrid } from './grid.mjs';

/* ---------- 状态与清理 ---------- */
const stateMap = new Map();
const cleanups = [];
let currentModule = null;
let pageLoadSeq = 0;

function registerCleanup(fn) { if (typeof fn === 'function') cleanups.push(fn); }
function runCleanups() {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try { fn(); } catch (e) { console.warn('cleanup 失败', e); }
  }
}

async function api(path, opts) {
  const o = opts || {};
  const init = { method: o.method || (o.body ? 'POST' : 'GET'), headers: {} };
  if (o.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(o.body);
  }
  if (o.signal) init.signal = o.signal;
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new Error('无法连接本地服务：' + (err && err.message ? err.message : err));
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { ok: false, error: text.slice(0, 300) }; }
  if (!res.ok || (data && data.ok === false)) {
    const msg = (data && data.error) || ('请求失败 HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function on(target, event, fn, opts) {
  target.addEventListener(event, fn, opts);
  registerCleanup(function () { target.removeEventListener(event, fn, opts); });
}

function sse(path, handlers) {
  const h = handlers || {};
  const es = new EventSource(path);
  es.onmessage = function (ev) { if (h.onEvent) h.onEvent('message', safeParse(ev.data), ev); };
  es.onerror = function () { if (h.onError) h.onError(); };
  const named = ['progress', 'done', 'error', 'log', 'state', 'account', 'task'];
  for (const name of named) {
    es.addEventListener(name, function (ev) { if (h.onEvent) h.onEvent(name, safeParse(ev.data), ev); });
  }
  registerCleanup(function () { try { es.close(); } catch (e) {} });
  return { close: function () { try { es.close(); } catch (e) {} } };
}

function safeParse(text) { try { return JSON.parse(text); } catch (e) { return text; } }

/* ---------- 桌面集成 ---------- */
let desktopInfo = { platform: 'desktop', available: false };
async function openExternal(url) {
  if (desktopInfo.available) {
    try { await api('/api/desktop/open-external', { method: 'POST', body: { url: url } }); return true; } catch (e) { /* 落到兜底 */ }
  }
  window.open(url, '_blank', 'noopener');
  return true;
}

/* 关闭窗口前确认（桌面端窗口被关闭 = 退出应用） */
function installDesktopGuards() {
  document.documentElement.dataset.platform = 'desktop';
  document.addEventListener('click', function (e) {
    const a = e.target && e.target.closest ? e.target.closest('a[href^="http"]') : null;
    if (!a) return;
    e.preventDefault();
    openExternal(a.href);
  });
}

/* ---------- 命令面板 ---------- */
let commands = [];
function registerCommand(cmd) { commands.push(cmd); }
function openCommandPalette() {
  const input = el('input', { class: 'cmdk-input', placeholder: '输入命令或页面名…（↑↓ 选择，Enter 执行，Esc 关闭）' });
  const list = el('div', { class: 'cmdk-list' });
  const box = el('div', { class: 'cmdk-box' }, [input, list]);
  const mask = el('div', { class: 'cmdk', on: { mousedown: function (e) { if (e.target === mask) close(); } } }, [box]);
  let filtered = commands.slice();
  let cursor = 0;
  function close() { mask.remove(); document.removeEventListener('keydown', onKey, true); }
  function draw() {
    list.textContent = '';
    filtered.slice(0, 40).forEach(function (c, i) {
      const row = el('div', { class: 'cmdk-item' + (i === cursor ? ' cur' : ''), on: { click: function () { run(c); } } }, [
        icon(c.icon || 'arrow-right'),
        el('div', { class: 'col', style: { minWidth: 0 } }, [
          el('div', { text: c.title }),
          c.sub ? el('div', { class: 'small muted', text: c.sub }) : null
        ]),
        c.key ? el('span', { class: 'kbd k', text: c.key }) : null
      ]);
      list.appendChild(row);
    });
    if (!filtered.length) list.appendChild(el('div', { class: 'cmdk-item muted', text: '没有匹配的命令' }));
  }
  function run(c) { close(); try { c.run(); } catch (e) { toast('命令执行失败：' + e.message, 'err'); } }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(filtered.length - 1, cursor + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[cursor]) run(filtered[cursor]); }
  }
  input.addEventListener('input', function () {
    const q = input.value.trim().toLowerCase();
    filtered = commands.filter(function (c) {
      return !q || (c.title + ' ' + (c.sub || '') + ' ' + (c.keywords || '')).toLowerCase().includes(q);
    });
    cursor = 0;
    draw();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(mask);
  setTimeout(function () { input.focus(); }, 20);
  draw();
}

/* ---------- 路由 ---------- */
const LOCAL_PAGES = [
  { id: 'settings', name: '设置', description: '路径 / 账号 / 多库根 / 模块', order: 80 },
  { id: 'about', name: '关于', description: '系统信息与来源', order: 90 }
];
let serverModules = [];
let navItems = [];

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const parts = raw.split('?');
  const id = parts[0] || 'library';
  const qs = new URLSearchParams(parts[1] || '');
  const params = {};
  qs.forEach(function (v, k) { params[k] = v; });
  return { id: id, params: params };
}

function navigate(hash) {
  if (location.hash === hash) { render(); return; }
  location.hash = hash;
}

const PAGE_ICON = { library: 'library', reader: 'book', download: 'download', dedupe: 'layers', vault: 'tag', settings: 'settings', about: 'info' };

function buildNav() {
  const items = [];
  for (const m of serverModules) {
    /* 只提供后端能力、不给人点的模块（meta.nav === false，例如 desktop 原生桥）不进导航。 */
    if (m.nav === false) continue;
    items.push({ id: m.id, name: m.name || m.id, ok: m.ok, order: m.order || 50, description: m.description });
  }
  for (const p of LOCAL_PAGES) items.push({ id: p.id, name: p.name, ok: true, order: p.order, description: p.description });
  items.sort(function (a, b) { return (a.order - b.order) || a.id.localeCompare(b.id); });
  navItems = items;
  const nav = document.getElementById('nav');
  nav.textContent = '';
  nav.appendChild(el('div', { class: 'side-group', text: '书库' }));
  let section = '书库';
  items.forEach(function (it, i) {
    if (i === 3 && section === '书库') { section = '工具'; nav.appendChild(el('div', { class: 'side-group', text: '工具' })); }
    const node = el('div', { class: 'nav-item', dataset: { id: it.id }, title: (it.description || it.name) + '  Ctrl+' + (i + 1) }, [
      el('span', { class: 'nav-ico' }, [icon(PAGE_ICON[it.id] || 'grid')]),
      el('span', { class: 'nav-txt', text: it.name }),
      it.ok === false ? el('span', { class: 'nav-badge', text: '!' }) : null
    ]);
    node.addEventListener('click', function () { navigate('#/' + it.id); });
    nav.appendChild(node);
  });
  return items;
}

function markNav(id) {
  const nodes = document.querySelectorAll('.nav-item');
  for (const n of nodes) n.classList.toggle('active', n.dataset.id === id);
}

function setTitle(main, sub) {
  document.getElementById('topTitle').textContent = main || '漫库';
  document.getElementById('topSub').textContent = sub || '';
}
function setSub(sub) { document.getElementById('topSub').textContent = sub || ''; }

async function render() {
  const { id, params } = parseHash();
  if (currentModule && typeof currentModule.unmount === 'function') {
    try { currentModule.unmount(); } catch (e) { console.warn(e); }
  }
  runCleanups();
  const seq = ++pageLoadSeq;
  const content = document.getElementById('content');
  content.textContent = '';
  markNav(id);
  const box = el('div', { class: 'page' });
  content.appendChild(box);

  const navInfo = navItems.filter(function (n) { return n.id === id; })[0];
  if (!navInfo) { setTitle('未找到页面', '#' + id); box.appendChild(renderEmpty('该页面不存在', '在左侧选择模块，或按 Ctrl+K 搜索')); return; }
  box.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'spinner spinner-lg' }), el('div', { class: 'small', text: '正在加载 ' + navInfo.name + ' …' })]));

  const pageCtx = makeCtx(box, params, id);
  currentModule = null;
  let mod = null;
  try {
    mod = await import('./modules/' + id + '.js?v=' + Date.now());
  } catch (err) {
    box.textContent = '';
    setTitle(navInfo.name, '加载失败');
    box.appendChild(el('div', { class: 'alert alert-err' }, [
      el('div', { class: 'col gap-6' }, [
        el('div', { style: { fontWeight: '650' }, text: '页面模块 ' + id + ' 加载失败' }),
        el('div', { class: 'mono small', text: String(err && err.message || err) })
      ])
    ]));
    return;
  }
  if (seq !== pageLoadSeq) return;   // 期间又切页了，丢弃本次渲染
  currentModule = mod;
  box.textContent = '';
  try {
    await mod.mount(box, pageCtx);
  } catch (err) {
    console.error(err);
    box.textContent = '';
    box.appendChild(el('div', { class: 'alert alert-err' }, [
      el('div', { class: 'col gap-6' }, [
        el('div', { style: { fontWeight: '650' }, text: navInfo.name + ' 渲染失败' }),
        el('div', { class: 'mono small', text: String(err && err.stack || err).slice(0, 1200) })
      ])
    ]));
  }
}

function renderEmpty(title, sub) {
  return el('div', { class: 'empty' }, [icon('image'), el('div', { class: 'empty-title', text: title }), el('div', { class: 'small', text: sub || '' })]);
}

function makeCtx(root, params, id) {
  return {
    el: el,
    icon: icon,
    fmt: fmt,
    api: api,
    get: function (p) { return api(p); },
    post: function (p, body) { return api(p, { method: 'POST', body: body }); },
    del: function (p) { return api(p, { method: 'DELETE' }); },
    toast: toast,
    confirm: confirmDialog,
    prompt: promptDialog,
    modal: modal,
    on: on,
    sse: sse,
    virtualGrid: virtualGrid,
    registerCleanup: registerCleanup,
    registerCommand: registerCommand,
    openExternal: openExternal,
    title: setTitle,
    sub: setSub,
    navigate: navigate,
    params: params,
    pageId: id,
    desktop: desktopInfo,
    state: {
      get: function (k, dflt) { return stateMap.has(k) ? stateMap.get(k) : dflt; },
      set: function (k, v) { stateMap.set(k, v); }
    },
    empty: renderEmpty
  };
}

/* ---------- 前端资源指纹自检 ----------
   ▸ 为什么必须有：服务端已给静态资源发 no-store，但那只管得住**新响应**，管不住
     用户浏览器里**已经缓存**的旧条目。用户反复遇到的「改好了刷新还是旧界面」
     （桌面组件删了还在、滑动条「没了」、下滑加载不出下一页）都是同一个成因，
     每次都要教用户手动 Ctrl+Shift+R 是不合格的。
   ▸ 做法：自己重新下载一份 app.js（带一次性 query 绕开所有缓存）算 sha256，
     与后端 /api/version 报的指纹比对。不一致 = 本页正在跑旧字节 → 自动带
     cache-buster 重载一次。用 sessionStorage 记住「本次会话已重载过哪个版本」，
     避免无限刷新（万一前后端算哈希的口径真的不同，也只会重载一次）。 */
async function sha256Hex8(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  const u8 = new Uint8Array(d);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += ('0' + u8[i].toString(16)).slice(-2);
  return s.slice(0, 8);
}

async function checkFrontendFingerprint() {
  try {
    const v = await api('/api/version');
    const want = v && v.files ? v.files['app.js'] : null;
    if (!want) return;
    const res = await fetch('/app.js?mv_selfcheck=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const got = await sha256Hex8(await res.arrayBuffer());
    window.__MV_FRONTEND__ = { want: want, got: got, ok: got === want, frontend: v.frontend, backend: v.backend };
    if (got === want) return;
    if (sessionStorage.getItem('mv.frontendReloaded') === want) return;
    sessionStorage.setItem('mv.frontendReloaded', want);
    const u = new URL(location.href);
    u.searchParams.set('mv_fresh', String(Date.now()));
    location.replace(u.toString());
  } catch (e) { /* 自检失败不阻塞启动，用户仍可手动刷新 */ }
}

/* ---------- 状态栏 ---------- */
async function refreshFoot() {
  try {
    const info = await api('/api/system/info');
    /* 长任务进行中时明确写出来：用户看到的「界面卡住」其实常常是后端在跑重活，
       而不是坏了 —— 这一行能把两者区分开，避免误以为要重启。 */
    const online = window.__MV_ONLINE__ || {};
    const busyTag = online.busy ? ' · 长任务进行中' : '';
    document.getElementById('footDot').className = 'dot dot-ok';
    document.getElementById('footStatus').textContent = '服务正常 · ' + info.node + busyTag;
    const mods = info.modules || [];
    const bad = mods.filter(function (m) { return !m.ok; }).map(function (m) { return m.id; });
    document.getElementById('footStats').textContent = '模块 ' + mods.filter(function (m) { return m.ok; }).length + '/' + mods.length + ' 就绪' + (bad.length ? ' · 异常:' + bad.join(',') : '');
    /* 版本自检可见化：把「构建时间 + 前端资源指纹」写进页脚，用户一眼能看出
       自己跑的是哪一份代码，出问题时报这两个值即可精确定位（改完之后看不到
       新界面时，先看这里的指纹有没有变）。 */
    try {
      const v = await api('/api/version');
      const box = document.getElementById('footBuild');
      if (box) {
        const stamp = String(v.build || '').replace('T', ' ').slice(0, 19);
        const fOk = window.__MV_FRONTEND__ ? (window.__MV_FRONTEND__.ok ? '' : ' ⚠') : '';
        box.textContent = '前端 ' + String(v.frontend || '') + fOk + ' · 后端 ' + String(v.backend || '') + ' · 启动 ' + stamp;
        box.title = '前后端代码指纹 + 本次服务启动时刻。指纹 = 该目录下全部脚本按内容算的 sha256 前 8 位。' +
          '报问题时带上这一行即可精确定位版本；界面没更新时先看这里：前端指纹变了说明服务端已换新代码，' +
          '而你看到还是旧界面，说明浏览器缓存没断（本页会自动重载一次）。';
      }
    } catch (e) { /* 自检信息缺失不影响状态栏主体 */ }
    window.__MV_INFO__ = info;
  } catch (err) {
    document.getElementById('footDot').className = 'dot dot-err';
    document.getElementById('footStatus').textContent = '后端未响应';
    document.getElementById('footStats').textContent = String(err && err.message || err).slice(0, 48);
  }
}

/* ---------- 后端在线探针：区分「真的挂了」与「只是忙」 ----------
   ★ 为什么需要：桌面宿主（MangaVault.exe）的看护每 3 秒打一次 /api/ping，连续 4 次拿不到
     就判「后端已死」并直接退出 —— 而长任务（查重/重扫/孤儿清理）期间后端是**单线程忙**，
     ping 必然超时。后端已用 backend-silence.json 声明「我在忙」，宿主据此豁免；
     这个探针是**第二道证据**：把「本页面到后端的真实可达性」写进 window.__MV_ONLINE__，
     桌面自检可读，用户也能在界面上看到「后端正在跑长任务」而不是一片空白。 */
const HEALTH_INTERVAL_MS = 4000;
const HEALTH_MAX_FAILS = 3;
let healthFails = 0;
let healthBusy = false;
let healthWarned = false;

async function healthTick() {
  try {
    const res = await fetch('/api/ping?mv_hc=' + Date.now(), { cache: 'no-store' });
    const j = await res.json();
    if (!j || j.name !== 'MangaVault') throw new Error('响应不是漫库服务');
    healthFails = 0;
    healthBusy = Number(j.silenceUntil || 0) > Date.now();
    healthWarned = false;
    window.__MV_ONLINE__ = { ok: true, fails: 0, at: Date.now(), busy: healthBusy, pid: j.pid, uptimeMs: j.uptimeMs };
  } catch (err) {
    healthFails++;
    const ok = healthFails < HEALTH_MAX_FAILS;
    window.__MV_ONLINE__ = { ok: ok, fails: healthFails, at: Date.now(), busy: healthBusy, error: String(err && err.message || err) };
    if (!ok && !healthWarned) {
      healthWarned = true;
      toast(healthBusy ? '后端正在跑长任务，界面可能短暂卡顿（不必重启）' : '后端连续无响应，请查看 logs/ 或重启服务', healthBusy ? 'warn' : 'err');
    }
  }
}

function startHealthProbe() {
  healthTick();
  setInterval(healthTick, HEALTH_INTERVAL_MS);
}

/* ---------- 启动 ---------- */
function buildCommands() {
  commands = [];
  navItems.forEach(function (n, i) {
    registerCommand({ title: '前往 · ' + n.name, sub: n.description || '', icon: PAGE_ICON[n.id] || 'grid', key: 'Ctrl+' + (i + 1), keywords: n.id, run: function () { navigate('#/' + n.id); } });
  });
  registerCommand({ title: '扫描漫画库', sub: '重建全部库根的索引', icon: 'refresh', keywords: 'scan index 索引', run: function () { api('/api/library/scan', { method: 'POST', body: {} }).then(function () { toast('扫描已启动，去「漫画库」看进度', 'ok'); navigate('#/library'); }).catch(function (e) { toast('启动扫描失败：' + e.message, 'err'); }); } });
  registerCommand({ title: '随机一本', sub: '从库里随机挑一部开读', icon: 'sparkles', keywords: 'random 随机', run: function () { api('/api/library/random').then(function (r) { navigate('#/reader?comic=' + r.comic.id); }).catch(function (e) { toast('随机失败：' + e.message, 'err'); }); } });
  registerCommand({ title: '只看收藏', sub: '跳转到收藏筛选', icon: 'heart', keywords: 'fav 收藏', run: function () { navigate('#/library?fav=1'); } });
  registerCommand({ title: '查重台', sub: '扫描重复内容', icon: 'layers', keywords: 'dedupe 查重', run: function () { navigate('#/dedupe'); } });
  registerCommand({ title: '打开数据目录', sub: '索引 / 日志 / 任务状态', icon: 'folder', keywords: 'data 数据目录', run: function () { api('/api/desktop/open-external', { method: 'POST', body: { url: 'http://127.0.0.1/' } }).catch(function () {}); toast('数据目录：data/（见关于页）', 'info'); } });
  registerCommand({ title: '快捷键一览', sub: 'Ctrl+K 命令面板等', icon: 'keyboard', keywords: 'help 快捷键', run: showShortcuts });
  registerCommand({ title: '重新加载当前页', sub: '刷新数据与视图', icon: 'rotate', key: 'Ctrl+R', keywords: 'reload 刷新', run: function () { render(); } });
}

function showShortcuts() {
  const rows = [
    ['Ctrl+K', '命令面板'],
    ['Ctrl+1…9', '切换模块'],
    ['Ctrl+R', '重新加载当前页'],
    ['Esc', '关闭浮层 / 退出阅读'],
    ['← →', '阅读器翻页（随日漫方向）'],
    ['空格', '阅读器下一页'],
    ['M / F / R / T', '阅读器：模式 / 适应 / 方向 / 缩略图'],
    ['Enter', '阅读器全屏']
  ];
  modal({
    title: '快捷键',
    body: el('div', { class: 'ledger' }, rows.map(function (r) {
      return el('div', { class: 'ledger-row' }, [el('span', { class: 'kbd', text: r[0] }), el('span', { class: 'd' }), el('span', { class: 'v', text: r[1] })]);
    }))
  });
}

async function boot() {
  installDesktopGuards();
  document.getElementById('btnReload').appendChild(icon('refresh'));
  document.getElementById('btnReload').addEventListener('click', function () { render(); toast('已重新加载', 'ok'); });
  const gs = document.getElementById('globalSearch');
  gs.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    const q = gs.value.trim();
    if (!q) return;
    stateMap.set('library.q', q);
    navigate('#/library?q=' + encodeURIComponent(q));
  });
  try { desktopInfo = Object.assign(desktopInfo, (await api('/api/desktop/state'))); } catch (e) { /* 桌面模块还没就绪 */ }
  try {
    const mods = await api('/api/modules');
    serverModules = mods.modules || [];
  } catch (err) {
    serverModules = [];
    toast('模块列表获取失败：' + err.message, 'err');
  }
  buildNav();
  buildCommands();
  window.addEventListener('hashchange', render);
  document.addEventListener('keydown', function (e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openCommandPalette(); return; }
    if (mod && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); render(); return; }
    if (mod && /^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      if (navItems[idx]) { e.preventDefault(); navigate('#/' + navItems[idx].id); }
    }
  });
  startHealthProbe();
  await refreshFoot();
  await checkFrontendFingerprint();
  if (!location.hash) location.hash = '#/library';
  else render();
  setInterval(refreshFoot, 30000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();