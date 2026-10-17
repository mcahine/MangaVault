/* 虚拟滚动网格：只渲染可视区行，DOM 恒定在几十行内；适用于 200~10000 项的漫画网格。
   独立成文件是因为它有一段自洽的测量/回收逻辑，和外壳的路由/导航无关。 */
import { el } from './ui.mjs';

export function virtualGrid(opts) {
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