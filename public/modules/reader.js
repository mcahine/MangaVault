
export const meta = { id: 'reader', name: '阅读器', order: 20 };

const HINTS = [
  ['← →', '上一页 / 下一页'],
  ['空格', '下一页'],
  ['M', '切换单页/双页/条漫'],
  ['F', '适应高度/宽度/原始'],
  ['T', '缩略图条'],
  ['L', '锁定/解锁翻页条（默认不锁定，鼠标停一会儿自动隐藏）'],
  ['R', '切换日漫/西漫（双页左右页顺序）'],
  ['Enter', '全屏'],
  ['Esc', '退出阅读']
];

export async function mount(root, ctx) {
  const el = ctx.el;
  const comicId = ctx.params.comic || ctx.state.get('reader.comic', '');
  if (!comicId) {
    ctx.title('阅读器', '从漫画库选一本开始阅读');
    root.appendChild(el('div', { class: 'page' }, [
      ctx.empty('还没有选择漫画', '去「漫画库」点任意一本的「阅读」按钮'),
      el('div', { class: 'row center' }, [el('button', { class: 'btn btn-primary', on: { click: function () { ctx.navigate('#/library'); } } }, [ctx.icon('library'), el('span', { text: '打开漫画库' })])])
    ]));
    return;
  }

  let prefs = { mode: 'single', fit: 'height', rtl: true, bg: 'auto', preload: 3, autoHideBar: true, barLock: false };
  try { prefs = Object.assign(prefs, (await ctx.get('/api/reader/prefs')).prefs); } catch (e) {}

  const S = {
    comic: null, chapter: null, pages: [], chapters: [], idx: 0,
    mode: prefs.mode, fit: prefs.fit, rtl: prefs.rtl, preload: prefs.preload,
    zoom: 1, stripOpen: false, barHidden: false, loading: false, finished: false,
    // 每页的原始宽高（来自 /api/reader/sizes，文件头解析），用于给占位元素定比例
    sizes: [],
    // 翻页条：barLock=false（默认）时鼠标不动 HIDE_AFTER_MS 就淡出；true 时常显
    barLock: prefs.barLock === true, barVisible: true
  };
  let saveTimer = null;
  let hideTimer = null;
  /* 预加载调度器：一次最多 PRELOAD_MAX 个请求在飞。以前是「翻一页就同时发起
     最多 16 个 new Image()」，带宽被远处的图抢光，当前页反而要等 —— 用户感受到的
     就是「滚到哪卡到哪」。改成按「离当前页距离」排队、有并发上限、已加载过的记下来
     不再重复请求。 */
  const PRELOAD_MAX = 4;
  const preloadDone = new Set();
  const preloadBusy = new Set();
  /* 章节载入序号：尺寸请求是并行的、可能后到。没有这个令牌的话，
     快速切章时旧章节的尺寸会覆盖新章节的，占位高度整片错。 */
  let chapterSeq = 0;
  /* 预加载代次：preloadDone/preloadBusy 是按页码索引的，而换章后页码从 0 重来。
     没有代次的话，旧章还在飞的图片回来后会把新章同页码标记成「已加载」，
     甚至把旧章的图插进新章的占位块 —— 表现为「换章后有几页空白或串页」。 */
  let preloadGen = 0;
  /* 翻页条自动淡出的等待时长。太长（看不到反馈）、太短（刚移开就消失）都不好，
     2800ms 是「读完一页抬起头」的观感；鼠标一动立刻回来。 */
  const HIDE_AFTER_MS = 2800;

  /* ---------- DOM ---------- */
  const titleNode = el('div', { class: 'nowrap ellipsis', style: { fontWeight: '650', maxWidth: '38vw' }, text: '加载中…' });
  const subNode = el('div', { class: 'small muted nowrap', text: '' });
  const chapterSelect = el('select', { class: 'select', style: { width: '190px' } });
  const modeBtn = el('button', { class: 'btn btn-sm btn-ghost', title: '切换阅读模式（M）', text: '' });
  const fitBtn = el('button', { class: 'btn btn-sm btn-ghost', title: '切换适应方式（F）', text: '' });
  const rtlBtn = el('button', { class: 'btn btn-sm btn-ghost', title: '切换阅读方向（R）', text: '' });
  const stripBtn = el('button', { class: 'btn btn-sm btn-ghost', title: '缩略图（T）' }, [ctx.icon('list'), el('span', { text: '缩略图' })]);
  const lockBtn = el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'bar-lock' }, title: '锁定翻页条（保持常显）', on: { click: function () { toggleBarLock(); } } }, [ctx.icon('pin')]);
  const fsBtn = el('button', { class: 'btn btn-sm btn-ghost', title: '全屏（Enter）' }, [ctx.icon('maximize')]);
  const helpBtn = el('button', { class: 'btn btn-sm btn-ghost', title: '快捷键' }, [ctx.icon('info')]);
  const backBtn = el('button', { class: 'btn btn-sm btn-ghost', on: { click: function () { exit(); } } }, [ctx.icon('arrow-left'), el('span', { text: '书架' })]);

  const bar = el('div', { class: 'reader-bar' }, [
    backBtn,
    el('div', { class: 'col grow', style: { minWidth: 0 } }, [titleNode, subNode]),
    chapterSelect, modeBtn, fitBtn, rtlBtn, stripBtn, lockBtn, helpBtn, fsBtn,
    el('button', { class: 'btn btn-icon btn-sm btn-ghost', title: '关闭（Esc）', on: { click: function () { exit(); } } }, [ctx.icon('x')])
  ]);

  const stage = el('div', { class: 'reader-stage fit-height' });
  const navLeft = el('div', { class: 'reader-nav left', title: '上一页（舞台左缘）', on: { click: function () { step(-1); } } });
  const navRight = el('div', { class: 'reader-nav right', title: '下一页（舞台右缘）', on: { click: function () { step(1); } } });
  /* 每个翻页控件都挂 data-act，供 scripts/dev/reader-nav-check.mjs 稳定选取；
     不要用 nth-child 定位，图标/顺序调整会静默失效。 */
  const pageInput = el('input', { class: 'input', dataset: { act: 'page-num' }, style: { width: '58px', height: '26px', textAlign: 'center', padding: '0 4px' }, value: '1' });
  const totalNode = el('span', { class: 'muted', dataset: { act: 'page-total' }, text: '/ 0' });
  const chapterLabel = el('span', { class: 'stamp nowrap', dataset: { act: 'chapter-label' }, text: '' });
  const prevChBtn = el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'prev-chapter' }, title: '上一话', on: { click: function () { gotoChapter(-1); } } }, [ctx.icon('chevron-left')]);
  const nextChBtn = el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'next-chapter' }, title: '下一话', on: { click: function () { gotoChapter(1); } } }, [ctx.icon('chevron-right')]);
  const prevPageBtn = el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'prev-page' }, title: '上一页（←）', on: { click: function () { step(-1); } } }, [ctx.icon('arrow-left')]);
  const nextPageBtn = el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'next-page' }, title: '下一页（→）', on: { click: function () { step(1); } } }, [ctx.icon('arrow-right')]);
  const pagebar = el('div', { class: 'reader-pagebar', dataset: { act: 'reader-pagebar' } }, [
    prevChBtn, prevPageBtn, pageInput, totalNode, chapterLabel, nextPageBtn, nextChBtn
  ]);
  const strip = el('div', { class: 'reader-strip' });
  const stripInner = el('div', { class: 'reader-strip-inner' });
  strip.appendChild(stripInner);

  const shellNode = el('div', { class: 'reader-root', tabIndex: '-1' }, [bar, el('div', { style: { position: 'relative', flex: '1', minHeight: 0, display: 'flex', flexDirection: 'column' } }, [stage, navLeft, navRight, pagebar]), strip]);
  document.body.appendChild(shellNode);

  // 阅读时长统计：每秒累计，退出时上报（vault 模块提供接口，未就绪时静默忽略）
  let readSeconds = 0;
  const tick = setInterval(function () { readSeconds++; }, 1000);
  ctx.registerCleanup(function () {
    clearInterval(tick);
    try { shellNode.remove(); } catch (e) {}
    saveProgress(true);
    if (readSeconds >= 5) ctx.post('/api/vault/reading-time', { comicId: comicId, seconds: readSeconds }).catch(function () {});
  });

  /* ---------- 数据 ---------- */
  async function loadChapter(order, startIndex) {
    if (S.loading) return;
    S.loading = true;
    stage.textContent = '';
    stage.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'spinner spinner-lg' }), el('div', { class: 'small', text: '正在载入章节…' })]));
    try {
      const q = new URLSearchParams({ comic: comicId });
      if (order) q.set('order', String(order));
      // 图片尺寸只读文件头（64KB），和章节数据并行取；失败不影响阅读，只是没有占位比例
      const seq = ++chapterSeq;
      const sizesPromise = ctx.get('/api/reader/sizes?' + q.toString()).then(function (x) { return (x && x.sizes) || []; }).catch(function () { return []; });
      const r = await ctx.get('/api/reader/chapter?' + q.toString());
      S.comic = r.comic;
      S.chapter = r.chapter;
      S.pages = r.pages;
      S.chapters = r.chapters;
      S.sizes = [];
      S.idx = Math.max(0, Math.min(S.pages.length - 1, Number(startIndex) || 0));
      // 换章：旧章的「已加载 / 在飞」记录全部作废（页码会从 0 重来）
      preloadGen++;
      preloadDone.clear();
      preloadBusy.clear();
      ctx.state.set('reader.comic', comicId);
      ctx.title(r.comic.title, '第 ' + r.chapter.order + ' 话 · ' + r.chapter.title);
      titleNode.textContent = r.comic.title;
      subNode.textContent = '第 ' + r.chapter.order + ' 话 · ' + r.chapter.title + ' · 共 ' + r.chapter.count + ' 页';
      buildChapterSelect();
      buildStrip();
      render();
      sizesPromise.then(function (list) {
        if (seq !== chapterSeq) return;   // 已经切到别的章节了，这份尺寸作废
        S.sizes = list || [];
        applySizes();
      });
    } catch (err) {
      stage.textContent = '';
      stage.appendChild(el('div', { class: 'alert alert-err', style: { margin: '40px' } }, [el('span', { text: '载入失败：' + err.message })]));
      ctx.toast('章节载入失败：' + err.message, 'err');
    } finally {
      S.loading = false;
    }
  }

  function buildChapterSelect() {
    chapterSelect.textContent = '';
    for (const ch of S.chapters) {
      chapterSelect.appendChild(el('option', { value: String(ch.order), text: '第 ' + ch.order + ' 话 · ' + ch.title + '（' + ch.count + '页）' }));
    }
    chapterSelect.value = String(S.chapter.order);
  }

  function buildStrip() {
    stripInner.textContent = '';
    for (let i = 0; i < S.pages.length; i++) {
      const img = el('img', { class: 'reader-thumb', loading: 'lazy', src: S.pages[i].url, title: '第 ' + (i + 1) + ' 页' });
      (function (n) { img.addEventListener('click', function () { goto(n); }); })(i);
      stripInner.appendChild(img);
    }
  }

  /* ---------- 渲染 ---------- */
  function render() {
    const total = S.pages.length;
    pageInput.value = String(total ? S.idx + 1 : 0);
    totalNode.textContent = '/ ' + total;
    chapterLabel.textContent = '第 ' + S.chapter.order + ' 话';
    document.title = S.comic.title + ' · 第 ' + S.chapter.order + ' 话 — 漫库';
    modeBtn.textContent = ({ single: '单页', spread: '双页', webtoon: '条漫' })[S.mode];
    fitBtn.textContent = ({ height: '适应高度', width: '适应宽度', original: '原始尺寸' })[S.fit];
    rtlBtn.textContent = S.rtl ? '日漫 →←' : '西漫 ←→';
    syncLockBtn();
    stage.className = 'reader-stage fit-' + S.fit + ' mode-' + S.mode;
    stage.textContent = '';
    if (!total) {
      stage.appendChild(ctx.empty('这一话没有图片', '可能下载不完整，去下载模块补一下'));
      return;
    }
    if (S.mode === 'webtoon') {
      const wrap = el('div', { class: 'reader-webtoon' });
      // 只挂「等高占位块」，图片按预加载队列在后台到达后原地替换（不改变布局高度）
      for (let i = 0; i < total; i++) {
        if (S.pages[i]) S.pages[i].shown = false;   // 占位块是本次渲染新建的，上次的「已回填」标记必须作废
        wrap.appendChild(holderNode(i));
      }
      stage.appendChild(wrap);
      requestAnimationFrame(function () { scrollToPage(S.idx, true); });
      trackWebtoon();
      /* 切模式 / 切适应方式都会重跑 render()，而 preloadDone 记的是「这张图请求过了」
         （在单页/双页模式下也照样预取过）。不回填的话 startLoad() 会因为「已加载」直接
         返回，新占位块永远等不到 swapIn —— 用户看到的就是「一切到条漫就卡住，非刷新不可」。 */
      fillLoaded();
      preload();
    } else if (S.mode === 'spread') {
      const left = S.rtl ? S.idx + 1 : S.idx;
      const right = S.rtl ? S.idx : S.idx + 1;
      const spread = el('div', { class: 'reader-spread' });
      if (left < total) spread.appendChild(pageImg(left));
      if (right < total) spread.appendChild(pageImg(right));
      if (S.rtl) spread.style.flexDirection = 'row-reverse';
      stage.appendChild(spread);
    } else {
      stage.appendChild(pageImg(S.idx));
    }
    preload();
    updateStripSelection();
    saveProgress();
  }

  function pageImg(i) {
    const img = el('img', { class: 'reader-page', src: S.pages[i].url, alt: '第 ' + (i + 1) + ' 页', dataset: { idx: String(i) } });
    const s = S.sizes && S.sizes[i];
    // 单页/双页也写宽高：舞台是 grid + place-items:center，先给比例能让首图出现前就摆好位置
    if (s && s.w > 0 && s.h > 0) { img.setAttribute('width', String(s.w)); img.setAttribute('height', String(s.h)); }
    if (S.zoom !== 1) img.style.transform = 'scale(' + S.zoom + ')';
    return img;
  }

  /* ---------- 占位与预加载调度 ----------
     条漫的流畅度取决于两件事：
       1) 布局必须在图片到达之前就确定 —— 否则每加载一张就把后面所有内容重新挤一遍，
          表现就是「边滚边跳、滚到哪卡到哪」；
       2) 图片请求要按「离当前页多远」排队 —— 以前翻一页就同时丢出最多 16 个请求，
          带宽被远处的图抢光，当前页反而要等。
     占位块 + 有并发上限的队列分别解决这两点。 */
  const PH_RATIO = 1.42;   // 比例未知时的兜底（多数单行本是 1200x1700 上下）
  let preloadWanted = [];

  function ratioOf(i) {
    const s = S.sizes && S.sizes[i];
    if (s && s.w > 0 && s.h > 0) return s.h / s.w;
    return PH_RATIO;
  }

  /** 占位高度 = 显示宽度 × 高宽比；宽度取舞台实测宽度，尽量贴近 <img> 的最终盒子。 */
  function phHeight(i) {
    let w = 0;
    try { w = stage.clientWidth || 0; } catch (e) { w = 0; }
    if (w < 40) w = 900;
    const s = S.sizes && S.sizes[i];
    if (S.fit === 'original') w = (s && s.w > 0 ? s.w : w);
    else if (S.fit !== 'width') w = Math.min(w, 900);
    return Math.max(80, Math.round(w * ratioOf(i)));
  }

  function webtoonImgStyle() {
    if (S.fit === 'width') return { width: '100%' };
    if (S.fit === 'original') return { width: 'auto', maxWidth: 'none' };
    return { width: '100%', maxWidth: '900px' };
  }

  function holderNode(i) {
    return el('div', { class: 'reader-ph', dataset: { idx: String(i) }, style: { height: phHeight(i) + 'px' } }, [
      el('div', { class: 'reader-ph-num', text: String(i + 1) })
    ]);
  }

  /** 图片解码完成 → 用等高的 <img> 原地替换占位块，位置不会跳。 */
  function swapIn(i) {
    const p = S.pages[i];
    if (!p || p.shown || !p.img) return;
    const ph = stage.querySelector('.reader-ph[data-idx="' + i + '"]');
    if (!ph) return;
    p.shown = true;
    const fig = el('img', { class: 'reader-img', src: p.url, alt: '第 ' + (i + 1) + ' 页', dataset: { idx: String(i) }, style: webtoonImgStyle() });
    fig.addEventListener('load', function () { ph.classList.add('ready'); });
    ph.textContent = '';
    ph.appendChild(fig);
    if (fig.complete) ph.classList.add('ready');
  }

  /** 把「已经加载完成」但当前没有对应 DOM 的页回填进占位块。
      render() 每次都会清空舞台重建占位块，而 preloadDone 是跨渲染保留的 ——
      少了这一步，切模式/切适应方式后已加载的页不会再被 startLoad 触发 swapIn。 */
  function fillLoaded() {
    for (let i = 0; i < S.pages.length; i++) {
      const p = S.pages[i];
      if (!p || p.shown || !p.img) continue;
      if (!preloadDone.has(i)) continue;
      if (p.img.complete && p.img.naturalWidth > 0) swapIn(i);
    }
  }

  function startLoad(i) {
    if (i < 0 || i >= S.pages.length) return;
    if (preloadDone.has(i) || preloadBusy.has(i)) return;
    preloadBusy.add(i);
    const gen = preloadGen;
    const im = new Image();
    const finish = function () {
      if (gen !== preloadGen) return;   // 已经换章了，这次请求的结果整体作废
      preloadBusy.delete(i);
      preloadDone.add(i);
      const p = S.pages[i];
      if (p && p.img === im) swapIn(i);
      pumpPreload();
    };
    im.onload = finish;
    im.onerror = finish;
    im.src = S.pages[i].url;
    S.pages[i].img = im;
  }

  function pumpPreload() {
    while (preloadBusy.size < PRELOAD_MAX) {
      let pick = -1;
      for (let k = 0; k < preloadWanted.length; k++) {
        const i = preloadWanted[k];
        if (i >= 0 && i < S.pages.length && !preloadDone.has(i) && !preloadBusy.has(i)) { pick = i; break; }
      }
      if (pick < 0) return;
      startLoad(pick);
    }
  }

  /** 按「离当前页距离」由近到远重排预加载队列（当前页永远排第一）。 */
  function queueAround(idx) {
    const total = S.pages.length;
    if (!total) return;
    const n = Math.max(0, Math.min(6, Number(S.preload) || 0));
    const jump = S.mode === 'spread' ? 2 : 1;
    const want = [idx];
    for (let k = 1; k <= n; k++) { want.push(idx + jump * k); want.push(idx - jump * k); }
    preloadWanted = want.filter(function (i) { return i >= 0 && i < total; });
    pumpPreload();
  }

  function preload() { queueAround(S.idx); }

  /** 尺寸晚到 → 更新占位高度（条漫）或补写宽高属性（单页/双页），并重排队列 */
  function applySizes() {
    if (S.mode === 'webtoon') {
      const phs = stage.querySelectorAll('.reader-ph');
      for (let k = 0; k < phs.length; k++) {
        const node = phs[k];
        const n = Number(node.dataset.idx);
        if (isNaN(n)) continue;
        if (S.pages[n] && S.pages[n].shown) continue;
        node.style.height = phHeight(n) + 'px';
      }
      queueAround(S.idx);
      return;
    }
    // 单页/双页：尺寸是异步到的，首帧渲染时还没有比例。这里只补属性，不重排（避免闪一下）。
    const imgs = stage.querySelectorAll('.reader-page');
    for (let k = 0; k < imgs.length; k++) {
      const n = Number(imgs[k].dataset.idx);
      if (isNaN(n)) continue;
      const s = S.sizes && S.sizes[n];
      if (!s || !(s.w > 0) || !(s.h > 0)) continue;
      imgs[k].setAttribute('width', String(s.w));
      imgs[k].setAttribute('height', String(s.h));
    }
  }

  function updateStripSelection() {
    const thumbs = stripInner.children;
    for (let i = 0; i < thumbs.length; i++) thumbs[i].classList.toggle('cur', i === S.idx);
    const cur = thumbs[S.idx];
    if (cur && S.stripOpen) cur.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  /* ---------- 条漫的「当前页」跟踪 ----------
     条漫没有翻页动作，只有滚动，当前页只能由滚动位置反推。
     历史坑（用户报「条漫加载不出来」）：这里原来用 IntersectionObserver +
     threshold:[0.4,0.75] 观察占位块。占位块按整页高度撑开（实测 1979px），而舞台
     视口只有 762px —— 一个块最多只能露出 762/1979 = 38.5%，永远达不到 0.4 的阈值，
     回调一次都不触发。于是 S.idx 永远停在 0，预加载队列永远停在最初几页，往下滚
     只能看到一片灰底占位块。改用滚动位置直接判定：页面能被滚到多长，就一定算得出
     当前页，与单页高度无关。 */
  let scrollRaf = 0;
  let scrollBound = false;

  function currentPageByScroll() {
    const wrap = stage.querySelector('.reader-webtoon');
    if (!wrap) return -1;
    const mid = stage.getBoundingClientRect().top + stage.clientHeight * 0.25;   // 以视口上方 1/4 处为判定线，更接近「用户正在看的那一页」
    const nodes = wrap.children;
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i].getBoundingClientRect();
      if (r.top <= mid && r.bottom > mid) return i;
    }
    return -1;
  }

  function onStageScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      if (S.mode !== 'webtoon') return;
      const n = currentPageByScroll();
      if (n < 0) return;
      if (n !== S.idx) {
        S.idx = n;
        pageInput.value = String(n + 1);
        updateStripSelection();
        saveProgress();
      }
      /* 滚到哪就把预加载队列挪到哪。不重排的话 preloadWanted 永远停在初始那几页。 */
      queueAround(n);
    });
  }

  function trackWebtoon() {
    if (scrollBound) return;
    scrollBound = true;
    ctx.on(stage, 'scroll', onStageScroll);
  }

  function scrollToPage(n, instant) {
    const wrap = stage.querySelector('.reader-webtoon');
    const target = wrap && wrap.children[n];
    if (target) target.scrollIntoView({ block: 'start', behavior: instant ? 'auto' : 'smooth' });
  }

  /* ---------- 翻页 ---------- */
  function goto(n) {
    onMove();
    const total = S.pages.length;
    if (!total) return;
    if (n < 0) {
      const prev = prevChapter();
      if (prev) { loadChapter(prev.order, 1e9); return; }
      ctx.toast('已经是第一话了', 'info');
      n = 0;
    }
    if (n >= total) {
      const nx = nextChapter();
      if (nx) { loadChapter(nx.order, 0); return; }
      ctx.toast('已经是最后一话了', 'info');
      n = total - 1;
    }
    S.idx = n;
    if (S.mode === 'webtoon') {
      scrollToPage(S.idx);
      pageInput.value = String(S.idx + 1);
      updateStripSelection(); saveProgress();
      preload();   // 条漫不重渲染，必须在这里把预加载队列挪到新页附近
    } else {
      render();
    }
  }

  function step(delta) {
    const d = S.mode === 'spread' ? delta * 2 : delta;
    goto(S.idx + d);
  }

  /* ---------- 翻页方向（曾经的 bug 现场，动这里之前先读完） ----------
     历史：这里原来有个 rtlStep(visual)，rtl=true 时把「左侧」反转成「前进」。
     问题在于工具栏的「上一页 / 下一页」按钮和 ← → 键也走了它，于是日漫模式
     （rtl 默认 true）下点「下一页」实际回到上一页 —— 用户报障「上一页和下一页是反的」。

     现在统一约定（唯一真源）：
       · 「上一页 / 下一页」按钮、← → 键、舞台左右边缘 —— 一律按页码：
         左 = 上一页（idx-1），右 = 下一页（idx+1），任何地方都不反转。
       · 阅读方向 rtl 只影响两件事：双页模式的左右页顺序（见 render()），
         以及方向指示文案（rtlBtn）。
     将来若要做「日漫反向点按」，请新增独立开关，不要在这里把全局翻回去。 */

  function prevChapter() { const i = S.chapters.findIndex(function (x) { return x.order === S.chapter.order; }); return i > 0 ? S.chapters[i - 1] : null; }
  function nextChapter() { const i = S.chapters.findIndex(function (x) { return x.order === S.chapter.order; }); return i >= 0 && i < S.chapters.length - 1 ? S.chapters[i + 1] : null; }

  function gotoChapter(dir) {
    const ch = dir < 0 ? prevChapter() : nextChapter();
    if (!ch) { ctx.toast(dir < 0 ? '已经是第一话了' : '已经是最后一话了', 'info'); return; }
    loadChapter(ch.order, 0);
  }

  /* ---------- 进度 ---------- */
  function saveProgress(immediate) {
    if (!S.comic || !S.chapter) return;
    if (saveTimer) clearTimeout(saveTimer);
    const payload = { comicId: S.comic.id, chapter: S.chapter.order, index: S.idx };
    const send = function () {
      ctx.post('/api/reader/progress', payload).catch(function () {});
    };
    if (immediate) send();
    else saveTimer = setTimeout(send, 1200);
  }

  async function savePrefs(patch) {
    Object.assign(S, patch);
    try { await ctx.post('/api/reader/prefs', patch); } catch (e) {}
  }

  /* ---------- 交互 ---------- */
  function cycleMode() {
    const order = ['single', 'spread', 'webtoon'];
    S.mode = order[(order.indexOf(S.mode) + 1) % order.length];
    if (S.mode === 'spread' && S.idx % 2 === 1) S.idx = Math.max(0, S.idx - 1);
    savePrefs({ mode: S.mode });
    render();
    ctx.toast('阅读模式：' + ({ single: '单页', spread: '双页', webtoon: '条漫' })[S.mode], 'info');
  }

  function cycleFit() {
    const order = ['height', 'width', 'original'];
    S.fit = order[(order.indexOf(S.fit) + 1) % order.length];
    savePrefs({ fit: S.fit });
    render();
  }

  function cycleRtl() {
    S.rtl = !S.rtl;
    savePrefs({ rtl: S.rtl });
    render();
    ctx.toast(S.rtl ? '阅读方向：日漫（从右往左）' : '阅读方向：西漫（从左往右）', 'info');
  }

  function toggleStrip() {
    S.stripOpen = !S.stripOpen;
    strip.classList.toggle('open', S.stripOpen);
    if (S.stripOpen) updateStripSelection();
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) { shellNode.requestFullscreen().catch(function () {}); }
    else { document.exitFullscreen().catch(function () {}); }
  }

  function showHelp() {
    ctx.modal({
      title: '阅读器快捷键',
      body: el('div', { class: 'col gap-8' }, HINTS.map(function (h) {
        return el('div', { class: 'row between gap-12' }, [el('span', { class: 'kbd', text: h[0] }), el('span', { class: 'small muted', text: h[1] })]);
      }))
    });
  }

  function exit() {
    saveProgress(true);
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    ctx.navigate('#/library');
  }

  function onKey(e) {
    onMove();
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) {
      if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
      return;
    }
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'a') { step(-1); e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'd') { step(1); e.preventDefault(); }
    else if (k === ' ' || k === 'ArrowDown' || k === 'PageDown') { step(1); e.preventDefault(); }
    else if (k === 'ArrowUp' || k === 'PageUp') { step(-1); e.preventDefault(); }
    else if (k === 'Home') { goto(0); }
    else if (k === 'End') { goto(S.pages.length - 1); }
    else if (k === 'm' || k === 'M') cycleMode();
    else if (k === 'f' || k === 'F') cycleFit();
    else if (k === 'r' || k === 'R') cycleRtl();
    else if (k === 't' || k === 'T') toggleStrip();
    else if (k === 'l' || k === 'L') toggleBarLock();
    else if (k === 'Enter') toggleFullscreen();
    else if (k === 'Escape') exit();
    else if (k === '+' || k === '=') { S.zoom = Math.min(3, S.zoom + 0.15); render(); }
    else if (k === '-') { S.zoom = Math.max(0.4, S.zoom - 0.15); render(); }
  }

  function onWheel(e) {
    if (e.ctrlKey) { e.preventDefault(); S.zoom = Math.max(0.4, Math.min(3, S.zoom + (e.deltaY > 0 ? -0.1 : 0.1))); const img = stage.querySelector('.reader-page'); if (img) img.style.transform = 'scale(' + S.zoom + ')'; }
  }

  /* ---------- 顶栏 / 翻页条的显隐 ----------
     用户诉求（原文）：「不到这个位置就不显示这个条，可以锁定，但是默认不锁定」。
     语义：
       · 默认不锁定 —— 鼠标停了一会儿（HIDE_AFTER_MS）翻页条淡出；鼠标一动、按任意键、
         翻页或切章都立刻回来。淡出只降透明度 + 关掉指针事件，**不改变布局**，
         所以不会像 display:none 那样让舞台尺寸抖一下。
       · 锁定（barLock=true）—— 翻页条任何情况下都常显。
     顶栏另有既有偏好 autoHideBar 控制（默认开），两者共用同一个计时器，
     避免出现「顶栏回来了、翻页条还没回来」的错位观感。 */

  function setBarVisible(on) {
    S.barVisible = on;
    if (on) {
      shellNode.classList.remove('bar-hidden');
      bar.classList.remove('auto-hide');
      pagebar.classList.remove('auto-hide');
    } else {
      shellNode.classList.add('bar-hidden');
      pagebar.classList.add('auto-hide');
      if (prefs.autoHideBar) bar.classList.add('auto-hide');
    }
  }

  function onMove() {
    setBarVisible(true);
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (S.barLock || S.stripOpen) return;
      // 顶栏是否自动隐藏由既有偏好 autoHideBar 决定；翻页条总是自动淡出（除非锁定）
      pagebar.classList.add('auto-hide');
      if (prefs.autoHideBar) bar.classList.add('auto-hide');
    }, HIDE_AFTER_MS);
  }

  function syncLockBtn() {
    lockBtn.classList.toggle('lock-on', S.barLock);
    lockBtn.title = S.barLock ? '翻页条已锁定（点击解锁，恢复自动隐藏）' : '锁定翻页条（保持常显）';
  }

  function toggleBarLock() {
    S.barLock = !S.barLock;
    syncLockBtn();
    if (S.barLock) { if (hideTimer) clearTimeout(hideTimer); setBarVisible(true); }
    else { onMove(); }
    savePrefs({ barLock: S.barLock });
    ctx.toast(S.barLock ? '翻页条已锁定（常显）' : '翻页条已解锁（自动隐藏）', 'info');
  }

  ctx.on(document, 'keydown', onKey);
  ctx.on(stage, 'wheel', onWheel, { passive: false });
  ctx.on(shellNode, 'mousemove', onMove);
  // 窗口/舞台宽度变了，占位高度必须跟着重算，否则条漫的滚动位置会整体偏掉
  let reflowTimer = null;
  ctx.on(window, 'resize', function () {
    if (S.mode !== 'webtoon') return;
    if (reflowTimer) clearTimeout(reflowTimer);
    reflowTimer = setTimeout(function () { reflowTimer = null; applySizes(); }, 150);
  });
  pageInput.addEventListener('change', function () { goto(Math.max(0, Math.min(S.pages.length - 1, Number(pageInput.value) - 1))); });
  chapterSelect.addEventListener('change', function () { loadChapter(Number(chapterSelect.value), 0); });
  modeBtn.addEventListener('click', cycleMode);
  fitBtn.addEventListener('click', cycleFit);
  rtlBtn.addEventListener('click', cycleRtl);
  stripBtn.addEventListener('click', toggleStrip);
  fsBtn.addEventListener('click', toggleFullscreen);
  helpBtn.addEventListener('click', showHelp);
  ctx.registerCleanup(function () { if (hideTimer) clearTimeout(hideTimer); if (saveTimer) clearTimeout(saveTimer); if (scrollRaf) cancelAnimationFrame(scrollRaf); if (reflowTimer) clearTimeout(reflowTimer); });

  await loadChapter(ctx.params.order ? Number(ctx.params.order) : undefined, ctx.params.index ? Number(ctx.params.index) : 0);
  shellNode.focus();
  syncLockBtn();
  if (S.barLock) setBarVisible(true); else setTimeout(onMove, 100);
}

export function unmount() {}
