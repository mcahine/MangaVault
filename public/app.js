/* ===========================================================================
   漫库 MangaVault v2 · 前端外壳（Lead 所有，其他 Agent 只读）
   职责：路由 / 导航 / 命令面板 / ctx 工具集（含虚拟滚动）/ 页面模块加载
   设计依据：docs/UI_GUIDELINE.md（RISOPRINT · 深夜制本所）
   =========================================================================== */

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4a1 1 0 0 1 1-1h9.6a2 2 0 0 1 1.4.6l7.8 7.8a2 2 0 0 1 0 2.8z"/><path d="M7.5 7.5h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h6z"/>',
  heart: '<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z"/>',
  'chevron-left': '<path d="M15 18l-6-6 6-6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'folder-open': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 9h18l-2 9a2 2 0 0 1-2 1.6H5A2 2 0 0 1 3 18z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="1"/><circle cx="8.5" cy="8.5" r="1.3"/><path d="M21 15l-5-5L5 21"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5"/><path d="M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  star: '<path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/><path d="M11 8v6M8 11h6"/>',
  'zoom-out': '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/><path d="M8 11h6"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M16 21v-3a2 2 0 0 1 2-2h3M8 21v-3a2 2 0 0 0-2-2H3"/>',
  'arrow-left': '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>',
  'hard-drive': '<path d="M22 12H2"/><path d="M5.5 5h13l3.5 7v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5z"/><path d="M6 16h.01M10 16h.01"/>',
  sparkles: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.4 8.4-8 9.9C7.4 20.4 4 17 4 12V6z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  upload: '<path d="M12 21V9"/><path d="M7 13l5-5 5 5"/><path d="M5 4h14"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  sort: '<path d="M7 4v16"/><path d="M3 8l4-4 4 4"/><path d="M17 20V4"/><path d="M13 16l4 4 4-4"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="1"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  wand: '<path d="M15 4V2M15 22v-2M4.9 4.9L3.5 3.5M20.5 20.5l-1.4-1.4M4 15H2M22 15h-2"/><path d="M11 11l9 9"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3 18a9 9 0 1 1 18 0"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="1"/><path d="M8 21h8M12 17v4"/>',
  power: '<path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
  command: '<path d="M9 3a3 3 0 1 1-3 3v12a3 3 0 1 1 3-3h12a3 3 0 1 1-3-3V6a3 3 0 1 1-3 3H9z"/>',
  scissors: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M20 4L8.1 15.9M20 20L8.1 8.1"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  pencil: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 4l4 4"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3"/><path d="M8 14h8v7H8z"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  pin: '<path d="M9 3h6"/><path d="M12 3v8"/><path d="M7 11h10l1.5 4H5.5z"/><path d="M12 15v6"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="9" r="1.2"/><circle cx="9.5" cy="15" r="1.2"/>'
};

export function icon(name, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
  svg.innerHTML = ICONS[name] || ICONS.info;
  return svg;
}

export function el(tag, props, children) {
  const node = document.createElement(tag);
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
      else if (key in node) { try { node[key] = v; } catch (e) { node.setAttribute(key, v); } }
      else node.setAttribute(key, v);
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) { for (const c of children) append(node, c); return; }
  if (children instanceof Node) { node.appendChild(children); return; }
  node.appendChild(document.createTextNode(String(children)));
}

const fmt = {
  bytes: function (n) {
    n = Number(n) || 0;
    if (n <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n = n / 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(n < 10 ? 2 : 1)) + ' ' + u[i];
  },
  num: function (n) {
    const v = Number(n) || 0;
    if (v >= 100000000) return (v / 100000000).toFixed(1) + ' 亿';
    if (v >= 10000) return (v / 10000).toFixed(1) + ' 万';
    return String(v);
  },
  date: function (v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    const p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  },
  dur: function (ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
  },
  pct: function (a, b) { return Math.max(0, Math.min(100, Math.round(((Number(a) || 0) / Math.max(1, Number(b) || 1)) * 100))); }
};

/* ---------- Toast ---------- */
function toast(msg, type, ms) {
  const wrap = document.getElementById('toasts');
  const t = type || 'info';
  const iconName = t === 'ok' ? 'check' : t === 'err' ? 'alert' : t === 'warn' ? 'alert' : 'info';
  const color = t === 'ok' ? 'var(--cyan)' : t === 'err' ? 'var(--red)' : t === 'warn' ? 'var(--yellow)' : 'var(--blue)';
  const node = el('div', { class: 'toast toast-' + t }, [
    el('span', { class: 'row center', style: { color: color, flex: 'none' } }, [icon(iconName)]),
    el('div', { class: 'grow', style: { wordBreak: 'break-word' }, text: String(msg) })
  ]);
  wrap.appendChild(node);
  setTimeout(function () {
    node.classList.add('out');
    setTimeout(function () { node.remove(); }, 200);
  }, ms || (t === 'err' ? 5200 : 2800));
}

/* ---------- Modal ---------- */
function modal(opts) {
  const o = opts || {};
  const mask = el('div', { class: 'modal-mask' });
  const foot = [];
  const bodyNode = el('div', { class: 'modal-body' });
  append(bodyNode, o.body || []);
  function close() { mask.remove(); document.removeEventListener('keydown', onKey); if (o.onClose) o.onClose(); }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  const footNode = el('div', { class: 'modal-foot' }, foot);
  const box = el('div', { class: 'modal' + (o.wide ? ' wide' : '') }, [
    el('div', { class: 'modal-head' }, [
      el('div', { class: 'modal-title', text: o.title || '' }),
      el('button', { class: 'btn btn-icon btn-ghost btn-sm', on: { click: close }, title: '关闭（Esc）' }, [icon('x')])
    ]),
    bodyNode,
    footNode
  ]);
  if (o.foot && o.foot.length) append(footNode, o.foot);
  mask.appendChild(box);
  mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
  document.body.appendChild(mask);
  document.addEventListener('keydown', onKey);
  return { close: close, body: bodyNode, foot: footNode, el: box };
}

function confirmDialog(msg, opts) {
  const o = opts || {};
  return new Promise(function (resolve) {
    const m = modal({
      title: o.title || '请确认',
      body: el('div', { class: 'col gap-10' }, [
        el('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.6' }, text: msg }),
        o.danger ? el('div', { class: 'alert alert-err' }, [icon('alert'), el('span', { text: '此操作不可撤销，请谨慎。' })]) : null
      ]),
      foot: []
    });
    const okBtn = el('button', { class: 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary'), text: o.okText || '确定', on: { click: function () { m.close(); resolve(true); } } });
    const noBtn = el('button', { class: 'btn btn-ghost', text: o.cancelText || '取消', on: { click: function () { m.close(); resolve(false); } } });
    append(m.foot, [noBtn, okBtn]);
    setTimeout(function () { okBtn.focus(); }, 30);
  });
}

function promptDialog(msg, dflt, opts) {
  const o = opts || {};
  return new Promise(function (resolve) {
    const input = el('input', { class: 'input', value: dflt || '', placeholder: o.placeholder || '' });
    const m = modal({
      title: o.title || '请输入',
      body: el('div', { class: 'col gap-10' }, [
        el('div', { class: 'small', text: msg }),
        input
      ]),
      foot: []
    });
    const done = function (v) { m.close(); resolve(v); };
    const ok = el('button', { class: 'btn btn-primary', text: o.okText || '确定', on: { click: function () { done(input.value); } } });
    append(m.foot, [
      el('button', { class: 'btn btn-ghost', text: '取消', on: { click: function () { done(null); } } }),
      ok
    ]);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') done(input.value); });
    setTimeout(function () { input.focus(); input.select(); }, 30);
  });
}

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

/* ---------- 虚拟滚动网格 ----------
   只渲染可视区行，DOM 恒定在几十行内；适用于 200~10000 项的漫画网格。 */
function virtualGrid(opts) {
  const o = opts || {};
  const container = o.container;
  const minCol = o.minColWidth || 158;
  const rowH = o.rowHeight || 250;
  const gap = o.gap === undefined ? 12 : o.gap;
  const overscan = o.overscan === undefined ? 2 : o.overscan;
  let items = o.items || [];
  let renderItem = o.renderItem;
  let cols = 1;
  let scroller = null;

  const viewport = el('div', { style: { position: 'relative', width: '100%' } });
  const spacer = el('div', { style: { width: '100%' } });
  const layer = el('div', { style: { position: 'absolute', top: '0', left: '0', right: '0' } });
  viewport.appendChild(spacer);
  viewport.appendChild(layer);
  container.textContent = '';
  container.appendChild(viewport);

  function findScroller() {
    let n = container.parentElement;
    while (n) {
      const st = getComputedStyle(n);
      if (/(auto|scroll)/.test(st.overflowY)) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function measure() {
    const width = viewport.clientWidth || container.clientWidth || 900;
    cols = Math.max(1, Math.floor((width + gap) / (minCol + gap)));
  }

  function paint(force) {
    if (!scroller) scroller = findScroller();
    const scrollTop = scroller === document.scrollingElement || scroller === document.documentElement
      ? (window.scrollY || scroller.scrollTop || 0)
      : scroller.scrollTop;
    const viewTop = scroller === document.scrollingElement || scroller === document.documentElement
      ? 0
      : scroller.getBoundingClientRect().top;
    const viewH = scroller.clientHeight || window.innerHeight;
    const rows = Math.ceil(items.length / cols);
    const totalH = rows * (rowH + gap);
    spacer.style.height = totalH + 'px';
    const offset = (scroller === document.scrollingElement ? viewport.getBoundingClientRect().top + scrollTop : viewport.offsetTop - scrollTop + viewport.getBoundingClientRect().top - viewTop);
    const rel = scroller === document.scrollingElement ? viewport.getBoundingClientRect().top : viewport.getBoundingClientRect().top - viewTop;
    const firstRow = Math.max(0, Math.floor((-rel) / (rowH + gap)) - overscan);
    const lastRow = Math.min(rows - 1, Math.ceil((viewH - rel) / (rowH + gap)) + overscan);
    const frag = document.createDocumentFragment();
    const startIdx = firstRow * cols;
    const endIdx = Math.min(items.length, (lastRow + 1) * cols);
    for (let i = startIdx; i < endIdx; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const cellW = 'calc((100% - ' + (gap * (cols - 1)) + 'px) / ' + cols + ')';
      const wrap = el('div', {
        style: {
          position: 'absolute',
          top: (row * (rowH + gap)) + 'px',
          left: 'calc(' + col + ' * ((100% - ' + (gap * (cols - 1)) + 'px) / ' + cols + ' + ' + gap + 'px))',
          width: cellW,
          height: rowH + 'px'
        }
      });
      try { wrap.appendChild(renderItem(items[i], i)); } catch (e) { console.warn('渲染项失败', e); }
      frag.appendChild(wrap);
    }
    layer.textContent = '';
    layer.appendChild(frag);
  }

  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; paint(); });
  }

  /* 滚动绑定的关键：真正的滚动容器是 .content，而不是 window。
     #content 上的 scroll 事件不会冒泡到 window，因此如果只绑 window，
     虚拟网格在容器内滚动时永远不会重绘 —— 表现为「只能看到首屏，滑不动」。
     这里把监听绑到实际滚动祖先，并在容器变化时重新绑定。 */
  let boundScroller = null;
  function bindScroller() {
    const next = findScroller();
    if (next === boundScroller) return;
    if (boundScroller) {
      boundScroller.removeEventListener('scroll', onScroll, { passive: true, capture: false });
    }
    boundScroller = next;
    if (boundScroller) {
      boundScroller.addEventListener('scroll', onScroll, { passive: true, capture: false });
    }
  }

  let ro = null;
  let mo = null;
  if (window.ResizeObserver) {
    // 观察 viewport 宽度变化（换列数），同时观察滚动容器尺寸变化（窗口缩放）
    ro = new ResizeObserver(function () { measure(); paint(true); });
    ro.observe(viewport);
  }
  if (window.MutationObserver) {
    // 容器被布局变化替换时重新绑定（例如切换页面、侧栏折叠）
    mo = new MutationObserver(function () {
      const cur = findScroller();
      if (cur !== boundScroller) { bindScroller(); paint(true); }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener('resize', onScroll, { passive: true });

  measure();
  bindScroller();
  renderSet(items, renderItem);
  function renderSet(nextItems, nextRender) {
    items = nextItems || [];
    if (nextRender) renderItem = nextRender;
    bindScroller();
    paint(true);
  }
  function destroy() {
    if (boundScroller) {
      boundScroller.removeEventListener('scroll', onScroll, { passive: true, capture: false });
      boundScroller = null;
    }
    window.removeEventListener('resize', onScroll, { passive: true });
    if (ro) ro.disconnect();
    if (mo) mo.disconnect();
    if (raf) cancelAnimationFrame(raf);
  }
  return { setItems: renderSet, refresh: function () { measure(); paint(true); }, destroy: destroy, get cols() { return cols; } };
}

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