/* ===========================================================================
   漫库 MangaVault v2 · 前端 UI 原语（图标 / 元素构造 / 排版格式化 / Toast / 对话框）
   与业务无关的基础件，被外壳 app.js 与虚拟滚动 grid.mjs 共用。
   设计依据：docs/UI_GUIDELINE.md（RISOPRINT · 深夜制本所）
   =========================================================================== */

export const ICONS = {
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

export function append(node, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) { for (const c of children) append(node, c); return; }
  if (children instanceof Node) { node.appendChild(children); return; }
  node.appendChild(document.createTextNode(String(children)));
}

export const fmt = {
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
export function toast(msg, type, ms) {
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
export function modal(opts) {
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

export function confirmDialog(msg, opts) {
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

export function promptDialog(msg, dflt, opts) {
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