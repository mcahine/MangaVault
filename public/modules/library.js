export const meta = { id: 'library', name: '漫画库', order: 10 };

export async function mount(root, ctx) {
  const el = ctx.el;
  const S = {
    q: ctx.params.q || ctx.state.get('library.q', '') || '',
    sort: ctx.state.get('library.sort', 'title'),
    tag: ctx.params.tag || '',
    root: ctx.params.root || '',
    fav: ctx.params.fav === '1',
    hasMeta: '',
    minImages: 0,
    density: ctx.state.get('library.density', 168),
    page: 1,
    size: 120,
    total: 0,
    pages: 1,
    items: [],
    stats: null,
    byRoot: {},
    roots: [],
    facets: null,
    scanning: false,
    loading: false,
    loadingMore: false
  };
  ctx.title('漫画库', '多库根本地漫画索引');
  let vg = null;

  /* ---------------- 结构 ---------------- */
  const statsRow = el('div', { class: 'stat-row' });
  const rootBar = el('div', { class: 'row wrap gap-6', style: { marginBottom: '10px' } });
  const scanBar = el('div', { class: 'card card-pad hidden', style: { marginBottom: '12px' } });
  const continueWrap = el('div', { style: { marginBottom: '14px' } });
  const searchInput = el('input', { class: 'input', value: S.q, placeholder: '搜索标题 / 作者 / 汉化组 / 标签…   支持排除词 -催眠', autocomplete: 'off' });
  const sortSelect = el('select', { class: 'select', style: { width: '124px' } }, [
    o('title', '标题'), o('recent', '最近改动'), o('size', '体积'), o('pages', '页数'), o('chapters', '话数'),
    o('likes', '点赞'), o('views', '浏览'), o('author', '作者'), o('random', '随机')
  ]);
  sortSelect.value = S.sort;
  const favChip = el('div', { class: 'chip', on: { click: toggleFav } }, [ctx.icon('heart'), el('span', { text: '收藏' })]);
  const metaChip = el('div', { class: 'chip', on: { click: cycleMeta } }, [el('span', { text: '元数据：全部' })]);
  const sizeSelect = el('select', { class: 'select', style: { width: '104px' } }, [
    o('120', '每页 120'), o('240', '每页 240'), o('400', '每页 400')
  ]);
  const densitySelect = el('select', { class: 'select', style: { width: '116px' } }, [
    o('140', '密铺 6 列'), o('168', '标准 5 列'), o('210', '大图 4 列')
  ]);
  const tagBar = el('div', { class: 'row wrap gap-6', style: { marginBottom: '12px' } });
  const gridHost = el('div', { style: { minHeight: '200px' } });
  const footInfo = el('div', { class: 'row between gap-12 wrap', style: { marginTop: '16px', paddingTop: '10px', borderTop: '2px solid var(--line)' } });

  const scanBtn = el('button', { class: 'btn btn-primary', on: { click: startScan } }, [ctx.icon('refresh'), el('span', { text: '扫描库' })]);
  const healthBtn = el('button', { class: 'btn btn-ghost', on: { click: openHealth } }, [ctx.icon('shield'), el('span', { text: '体检' })]);
  const randomBtn = el('button', { class: 'btn btn-ghost', on: { click: openRandom } }, [ctx.icon('sparkles'), el('span', { text: '随机' })]);
  const cmdBtn = el('button', { class: 'btn btn-ghost', title: '命令面板（Ctrl+K）', on: { click: function () { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })); } } }, [ctx.icon('command'), el('span', { text: 'Ctrl+K' })]);

  root.appendChild(el('div', { class: 'page' }, [
    el('div', { class: 'page-head' }, [
      el('div', { class: 'col' }, [
        el('h2', { class: 'page-title misprint', text: '漫画库' }),
        el('div', { class: 'page-sub', text: '本地索引 · 多库根 · 直接阅读' })
      ]),
      el('div', { class: 'row gap-6 wrap' }, [healthBtn, randomBtn, cmdBtn, scanBtn])
    ]),
    statsRow,
    el('div', { style: { height: '12px' } }),
    scanBar,
    rootBar,
    continueWrap,
    el('div', { class: 'toolbar' }, [
      el('div', { class: 'searchbox' }, [ctx.icon('search'), searchInput]),
      sortSelect, sizeSelect, densitySelect, favChip, metaChip,
      el('div', { class: 'grow' })
    ]),
    tagBar,
    gridHost,
    footInfo
  ]));

  function o(v, t) { return el('option', { value: v, text: t }); }

  /* ---------------- 数据 ---------------- */
  async function loadOverview() {
    try {
      const st = await ctx.get('/api/library/stats');
      S.stats = st.stats || {};
      S.byRoot = st.byRoot || {};
      S.roots = st.roots || [];
      S.facets = st.facets || { tags: [], authors: [] };
      renderStats(st);
      renderRoots();
      renderTags();
      renderContinue();
    } catch (err) {
      statsRow.textContent = '';
      statsRow.appendChild(el('div', { class: 'alert alert-err', style: { margin: '10px' } }, [ctx.icon('alert'), el('span', { text: '统计加载失败：' + err.message })]));
    }
  }

  function renderStats(st) {
    statsRow.textContent = '';
    const s = S.stats || {};
    const cells = [
      ['部', s.comics || 0, 'var(--red)'],
      ['话', s.chapters || 0, 'var(--paper)'],
      ['张', ctx.fmt.num(s.images || 0), 'var(--cyan)'],
      ['占用', ctx.fmt.bytes(s.bytes || 0), 'var(--yellow)'],
      ['缺元数据', (s.withMeta === undefined ? 0 : (s.comics - s.withMeta)) || 0, 'var(--pink)']
    ];
    for (const c of cells) {
      statsRow.appendChild(el('div', { class: 'stat' }, [
        el('div', { class: 'stat-value', style: { color: c[2] }, text: String(c[1]) }),
        el('div', { class: 'stat-label', text: c[0] })
      ]));
    }
    const scanned = el('div', { class: 'small muted', style: { marginTop: '8px' } }, [
      el('span', { text: '索引时间 ' + ctx.fmt.date(st.scannedAt) + '　·　' }),
      el('span', { text: S.roots.map(function (r) { return r.name + ' ' + (S.byRoot[r.id] ? S.byRoot[r.id].comics : 0) + ' 部'; }).join('　·　') })
    ]);
    statsRow.appendChild(el('div', { class: 'ledger', style: { gridColumn: '1 / -1', background: 'var(--ink-2)', padding: '10px 12px' } }, [
      el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: '索引时间' }), el('span', { class: 'd' }), el('span', { class: 'v', text: ctx.fmt.date(st.scannedAt) })]),
      el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: '库根' }), el('span', { class: 'd' }), el('span', { class: 'v', text: S.roots.map(function (r) { return r.name + ' ' + ((S.byRoot[r.id] || {}).comics || 0) + ' 部'; }).join('   |   ') })]),
      el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: '空目录' }), el('span', { class: 'd' }), el('span', { class: 'v', text: (st.issues ? st.issues.empty : 0) + ' 部' })])
    ]));
  }

  function renderRoots() {
    rootBar.textContent = '';
    rootBar.appendChild(el('span', { class: 'label-mono', text: '库根' }));
    const all = el('div', { class: 'chip' + (S.root === '' ? ' active' : ''), on: { click: function () { S.root = ''; S.page = 1; renderRoots(); reload(); } } }, [
      el('span', { text: '全部' }), el('span', { class: 'muted', text: String((S.stats || {}).comics || 0) })
    ]);
    rootBar.appendChild(all);
    for (const r of S.roots) {
      const cnt = (S.byRoot[r.id] || {}).comics || 0;
      const chip = el('div', {
        class: 'chip' + (S.root === r.id ? ' active' : ''),
        title: r.path,
        on: { click: function () { S.root = S.root === r.id ? '' : r.id; S.page = 1; renderRoots(); reload(); } }
      }, [ctx.icon('hard-drive'), el('span', { text: r.name }), el('span', { class: 'muted', text: String(cnt) })]);
      rootBar.appendChild(chip);
    }
    if (S.tag) {
      rootBar.appendChild(el('div', { class: 'chip active', on: { click: function () { S.tag = ''; renderRoots(); renderTags(); reload(); } } }, [ctx.icon('tag'), el('span', { text: S.tag }), ctx.icon('x')]));
    }
  }

  function renderTags() {
    tagBar.textContent = '';
    const tags = ((S.facets && S.facets.tags) || []).slice(0, 22);
    if (!tags.length) return;
    tagBar.appendChild(el('span', { class: 'label-mono', text: '热门标签' }));
    for (const t of tags) {
      tagBar.appendChild(el('div', {
        class: 'chip' + (S.tag === t.name ? ' active' : ''),
        on: { click: function () { S.tag = S.tag === t.name ? '' : t.name; S.page = 1; renderTags(); renderRoots(); reload(); } }
      }, [el('span', { text: t.name }), el('span', { class: 'muted', text: String(t.count) })]));
    }
  }

  async function renderContinue() {
    try {
      const r = await ctx.get('/api/library/continue');
      continueWrap.textContent = '';
      if (!r.items || !r.items.length) return;
      const strip = el('div', { class: 'row gap-10', style: { overflowX: 'auto', paddingBottom: '6px' } });
      for (const it of r.items) {
        const p = it.progress;
        strip.appendChild(el('div', {
          class: 'card card-pad hoverable', style: { minWidth: '238px', cursor: 'pointer' },
          on: { click: function () { openReader(it.comic.id, p.chapter, p.index); } }
        }, [
          el('div', { class: 'row gap-10' }, [
            coverNode(it.comic, { width: '44px', height: '60px' }),
            el('div', { class: 'col grow', style: { minWidth: 0 } }, [
              el('div', { class: 'ellipsis', style: { fontWeight: '600', fontSize: '12.5px' }, text: it.comic.title }),
              el('div', { class: 'label-mono', text: '第 ' + p.chapter + ' 话 · 第 ' + (p.index + 1) + ' 页' }),
              el('div', { class: 'progress', style: { marginTop: '5px' } }, [el('i', { style: { width: Math.max(3, ctx.fmt.pct(p.chapterRead || 0, it.comic.images)) + '%' } })])
            ])
          ])
        ]));
      }
      continueWrap.appendChild(el('div', { class: 'section-title', text: '继续阅读' }));
      continueWrap.appendChild(strip);
    } catch (e) { /* 非关键 */ }
  }

  /* ---------------- 列表 / 虚拟滚动 ---------------- */
  async function reload() {
    if (S.loading) return;
    S.loading = true;
    try {
      const params = new URLSearchParams({ page: String(S.page), size: String(S.size), sort: S.sort });
      if (S.q) params.set('q', S.q);
      if (S.tag) params.set('tag', S.tag);
      if (S.root) params.set('root', S.root);
      if (S.fav) params.set('fav', '1');
      if (S.hasMeta) params.set('hasMeta', S.hasMeta);
      if (S.minImages) params.set('minImages', String(S.minImages));
      const r = await ctx.get('/api/library/comics?' + params.toString());
      S.total = r.total;
      S.pages = r.pages;
      S.items = r.items;
      renderGrid();
      renderFoot();
      if (!r.items.length) {
        gridHost.textContent = '';
        gridHost.appendChild(ctx.empty('没有匹配的漫画', '试试换关键字、清掉标签筛选，或点右上「扫描库」重建索引'));
      }
    } catch (err) {
      ctx.toast('漫画列表加载失败：' + err.message, 'err');
      gridHost.textContent = '';
      gridHost.appendChild(el('div', { class: 'alert alert-err' }, [ctx.icon('alert'), el('span', { text: err.message })]));
    } finally {
      S.loading = false;
    }
  }

  /* ---------------- 翻页：双通道（触底自动 + 显式按钮） ----------------
     ▸ 为什么必须两条通道：原来只有「滚到底自动加载」，而触底判定依赖容器高度与
       滚动事件的细节；一旦在某个浏览器/缩放/宿主里失效，用户就彻底没辙，且界面
       上**没有任何提示**（他只会看到「下滑不展开」）。所以：
         · 触底自动加载 —— 保留，作为顺滑路径；
         · 页脚常驻「加载更多（已显示 N / 共 M 部）」—— 兜底，永远点得动；
         · 加载中 / 到底 / 失败三态都有明确文案，不再静默。
       多通道同时触发用 S.loading / S.loadingMore 互斥，避免并发翻页把 items 冲乱。 */
  function pageInfo() {
    return { shown: S.items.length, total: S.total, page: S.page, loadedAll: S.total > 0 && S.items.length >= S.total };
  }

  function renderFoot() {
    footInfo.textContent = '';
    const info = pageInfo();
    footInfo.appendChild(el('div', { class: 'small muted' }, [
      el('span', { class: 'num', text: String(info.total) }),
      el('span', { text: ' 部匹配' + (info.loadedAll ? '（已全部加载）' : '（已显示 ' + info.shown + ' 部）') })
    ]));
    footInfo.appendChild(el('div', { class: 'row gap-6' }, [
      el('span', { class: 'label-mono', text: '共 ' + (S.pages || 1) + ' 页' })
    ]));
    if (S.loadingMore) {
      footInfo.appendChild(el('div', { class: 'row gap-6' }, [el('span', { class: 'spinner' }), el('span', { class: 'small muted', text: '正在加载更多…' })]));
      return;
    }
    if (info.loadedAll) {
      footInfo.appendChild(el('div', { class: 'small muted', text: '已经到底了' }));
      return;
    }
    footInfo.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm mv-lib-more',
      title: '加载下一页（滚到底也会自动加载，这里是不依赖滚动的兜底入口）',
      on: { click: function () { loadMore(); } }
    }, [ctx.icon('chevron-down'), el('span', { text: '加载更多（已显示 ' + info.shown + ' / 共 ' + info.total + ' 部）' })]));
  }

  /** 追加下一页。触底自动与「加载更多」按钮共用这一条路径，避免两处逻辑漂移。 */
  async function loadMore() {
    if (S.loading || S.loadingMore) return false;
    if (S.total > 0 && S.items.length >= S.total) return false;
    S.loadingMore = true;
    renderFoot();
    try {
      const r = await ctx.get('/api/library/comics?' + buildQuery(S.page + 1));
      S.page++;
      S.pages = r.pages;
      S.items = S.items.concat(r.items || []);
      if (r.total) S.total = r.total;
      renderGrid();
      return true;
    } catch (err) {
      ctx.toast('加载更多失败：' + err.message, 'err');
      return false;
    } finally {
      S.loadingMore = false;
      renderFoot();
    }
  }

  function renderGrid() {
    if (window.__mvNoVirtual) { renderGridPlain(); return; }
    if (!vg) {
      vg = ctx.virtualGrid({
        container: gridHost,
        items: S.items,
        minColWidth: S.density,
        rowHeight: Math.round(S.density * 1.42) + 60,
        gap: 12,
        renderItem: function (c) { return comicCard(c); }
      });
      return;
    }
    vg.setItems(S.items, function (c) { return comicCard(c); });
  }

  function renderGridPlain() {
    gridHost.textContent = '';
    const g = el('div', { class: 'grid grid-cards' });
    S.items.forEach(function (c) { g.appendChild(comicCard(c)); });
    gridHost.appendChild(g);
  }

  function coverNode(comic, size) {
    const wrap = el('div', {
      class: 'cover-wrap',
      style: size ? { width: size.width, height: size.height, aspectRatio: 'auto', flex: 'none', border: '2px solid var(--line)' } : { flex: '1', aspectRatio: 'auto' }
    });
    if (comic.cover) {
      const img = el('img', { class: 'cover', loading: 'lazy', decoding: 'async', src: '/api/library/cover/' + encodeURIComponent(comic.id), alt: comic.title });
      img.addEventListener('error', function () { img.remove(); wrap.appendChild(placeholder(comic)); });
      wrap.appendChild(img);
    } else {
      wrap.appendChild(placeholder(comic));
    }
    return wrap;
  }

  function placeholder(comic) {
    return el('div', { class: 'row center', style: { width: '100%', height: '100%', background: 'var(--ink-3)', color: 'var(--mute)', fontFamily: 'var(--font-display)', fontSize: '24px', fontWeight: '700' }, text: String(comic.title || '?').slice(0, 1) });
  }

  function comicCard(c) {
    const pct = c.progress ? Math.max(2, Math.min(100, c.progress.percent)) : 0;
    return el('div', { class: 'comic-card', style: { height: '100%' } }, [
      el('div', { class: 'cover-wrap', on: { click: function () { openDetail(c); } } }, [
        coverNode(c).firstChild ? coverNode(c).firstChild : el('div'),
        el('div', { class: 'cover-badges' }, [
          el('span', { class: 'stamp', text: String(c.chapterCount) + ' 话' }),
          c.favorite ? el('span', { class: 'stamp stamp-pink', text: '收藏' }) : (c.hasMeta ? null : el('span', { class: 'stamp stamp-yellow', text: '无元数据' }))
        ]),
        el('div', { class: 'cover-overlay' }, [
          el('div', { class: 'row gap-6' }, [
            el('button', { class: 'btn btn-primary btn-sm grow', on: { click: function (e) { e.stopPropagation(); openReader(c.id, c.progress ? c.progress.chapter : undefined, c.progress ? c.progress.index : 0); } } }, [ctx.icon('play'), el('span', { text: c.progress ? '继续' : '阅读' })]),
            el('button', { class: 'btn btn-icon btn-sm', title: '收藏', on: { click: function (e) { e.stopPropagation(); toggleFavorite(c); } } }, [ctx.icon('heart')])
          ]),
          el('div', { class: 'label-mono', text: (c.rootName || '') + '　' + ctx.fmt.bytes(c.bytes) })
        ])
      ]),
      el('div', { class: 'comic-body' }, [
        el('div', { class: 'comic-title', title: c.title, text: c.title }),
        el('div', { class: 'comic-author', text: c.author || (c.chineseTeam || '未知作者') }),
        pct ? el('div', { class: 'progress-track', style: { marginTop: '3px' } }, [el('i', { class: 'progress-bar', style: { width: pct + '%' } })]) : null
      ])
    ]);
  }

  /* ---------------- 详情 ---------------- */
  async function openDetail(c) {
    let d = null;
    try { d = (await ctx.get('/api/library/comic/' + encodeURIComponent(c.id))).comic; }
    catch (err) { ctx.toast('详情加载失败：' + err.message, 'err'); return; }

    const body = el('div', { class: 'col gap-14' });
    const m = ctx.modal({ title: d.title, wide: true, body: body });
    const readBtn = el('button', { class: 'btn btn-primary', on: { click: function () { m.close(); openReader(d.id, d.progress ? d.progress.chapter : undefined, d.progress ? d.progress.index : 0); } } }, [ctx.icon('play'), el('span', { text: d.progress ? '继续阅读（第 ' + d.progress.chapter + ' 话）' : '开始阅读' })]);
    const folderBtn = el('button', { class: 'btn btn-ghost', on: { click: function () { openFolder(d.id); } } }, [ctx.icon('folder-open'), el('span', { text: '打开文件夹' })]);
    const favBtn = el('button', { class: 'btn btn-ghost', on: { click: async function () { await toggleFavorite(d); m.close(); openDetail(d); } } }, [ctx.icon('heart'), el('span', { text: d.favorite ? '取消收藏' : '收藏' })]);
    const copyBtn = el('button', { class: 'btn btn-ghost', on: { click: function () { copyText(d.rootPath ? d.rootPath + '\\\\' + d.dir : d.dir); } } }, [ctx.icon('copy'), el('span', { text: '复制路径' })]);
    body.appendChild(el('div', { class: 'row gap-14', style: { alignItems: 'flex-start' } }, [
      el('div', { style: { width: '182px', flex: 'none' } }, [coverNode(c)]),
      el('div', { class: 'col grow gap-8', style: { minWidth: 0 } }, [
        el('div', { class: 'row gap-6 wrap' }, [
          el('span', { class: 'stamp', text: (d.rootName || '?') }),
          el('span', { class: 'badge badge-accent', text: d.chapterCount + ' 话' }),
          el('span', { class: 'badge', text: ctx.fmt.num(d.images) + ' 张' }),
          el('span', { class: 'badge', text: ctx.fmt.bytes(d.bytes) }),
          d.likes ? el('span', { class: 'badge', text: '♥ ' + ctx.fmt.num(d.likes) }) : null,
          d.hasMeta ? el('span', { class: 'badge badge-ok', text: '元数据完整' }) : el('span', { class: 'badge badge-warn', text: '缺元数据' })
        ]),
        el('div', { class: 'ledger' }, [
          row('作者', d.author || '未知'),
          row('汉化', d.chineseTeam || '—'),
          row('目录', d.dir),
          row('更新', ctx.fmt.date(d.updatedAt)),
          row('入库', ctx.fmt.date(d.createdAt))
        ]),
        el('div', { class: 'row wrap gap-6' }, (d.tags || []).concat(d.categories || []).slice(0, 18).map(function (t) {
          return el('span', { class: 'tag', text: t, style: { cursor: 'pointer' }, on: { click: function () { m.close(); S.tag = t; S.page = 1; reload(); renderTags(); } } });
        })),
        d.description ? el('div', { class: 'small muted', style: { whiteSpace: 'pre-wrap', maxHeight: '110px', overflow: 'auto', borderLeft: '3px solid var(--line)', paddingLeft: '9px' }, text: d.description }) : null
      ])
    ]));

    const chapList = el('div', { class: 'col', style: { maxHeight: '300px', overflow: 'auto' } });
    for (const ch of d.chapters) {
      chapList.appendChild(el('div', {
        class: 'ledger-row', style: { cursor: 'pointer', padding: '7px 6px' },
        on: { click: function () { m.close(); openReader(d.id, ch.order, 0); }, mouseenter: function (e) { e.currentTarget.style.background = 'var(--ink-3)'; }, mouseleave: function (e) { e.currentTarget.style.background = ''; } }
      }, [
        el('span', { class: 'k', text: '第 ' + ch.order + ' 话' }),
        el('span', { class: 'grow', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: ch.title }),
        el('span', { class: 'v', text: ch.count + ' 页  ' + ch.bytesText }),
        ctx.icon('chevron-right')
      ]));
    }
    body.appendChild(el('div', { class: 'section-title', text: '章节 · ' + d.chapters.length }));
    body.appendChild(chapList);
    m.foot.appendChild(copyBtn);
    m.foot.appendChild(folderBtn);
    m.foot.appendChild(favBtn);
    m.foot.appendChild(el('div', { class: 'grow' }));
    m.foot.appendChild(readBtn);
  }

  function row(k, v) {
    return el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: k }), el('span', { class: 'd' }), el('span', { class: 'v', text: String(v) })]);
  }

  /* ---------------- 操作 ---------------- */
  async function toggleFavorite(c) {
    try {
      const r = await ctx.post('/api/library/marks', { id: c.id, favorite: !c.favorite });
      c.favorite = r.favorite;
      ctx.toast(r.favorite ? '已收藏' : '已取消收藏', 'ok');
      reload();
      renderContinue();
    } catch (err) { ctx.toast('操作失败：' + err.message, 'err'); }
  }

  function toggleFav() {
    S.fav = !S.fav;
    favChip.classList.toggle('active', S.fav);
    S.page = 1; reload();
  }

  function cycleMeta() {
    const order = ['', '1', '0'];
    S.hasMeta = order[(order.indexOf(S.hasMeta) + 1) % order.length];
    const label = S.hasMeta === '' ? '全部' : (S.hasMeta === '1' ? '仅有元数据' : '仅缺元数据');
    metaChip.textContent = '';
    metaChip.appendChild(el('span', { text: '元数据：' + label }));
    metaChip.classList.toggle('active', S.hasMeta !== '');
    S.page = 1; reload();
  }

  async function openRandom() {
    try { const r = await ctx.get('/api/library/random' + (S.root ? '?root=' + encodeURIComponent(S.root) : '')); openDetail(r.comic); }
    catch (err) { ctx.toast('随机失败：' + err.message, 'err'); }
  }

  async function openFolder(comicId) {
    try { const r = await ctx.post('/api/download/open-folder', { comicId: comicId }); ctx.toast(r.message || '已在资源管理器中打开', 'ok'); }
    catch (err) { ctx.toast('打开文件夹失败：' + err.message, 'warn'); }
  }

  async function openHealth() {
    try {
      const r = await ctx.get('/api/library/health');
      const body = el('div', { class: 'col gap-12' }, [
        el('div', { class: 'ledger' }, [
          row('已索引', r.indexed + ' 部'),
          row('库根', (r.roots || []).map(function (x) { return x.name + '(' + x.dirs + ' 目录)'; }).join('  |  ')),
          row('按根分布', Object.keys(r.byRoot || {}).map(function (k) { return k + ' ' + r.byRoot[k].comics + ' 部'; }).join('  |  ') || '—')
        ]),
        block('缺元数据（' + (r.noMeta || []).length + '）', r.noMeta),
        block('空目录（' + (r.empty || []).length + '）', r.empty),
        block('重名标题（' + (r.duplicatedTitles || []).length + '）', r.duplicatedTitles)
      ]);
      ctx.modal({ title: '库体检', wide: true, body: body });
    } catch (err) { ctx.toast('体检失败：' + err.message, 'err'); }
  }

  function block(title, list) {
    return el('div', { class: 'col gap-6' }, [
      el('div', { class: 'section-title', text: title }),
      (list && list.length)
        ? el('div', { class: 'mono small muted', style: { maxHeight: '120px', overflow: 'auto', whiteSpace: 'pre-wrap' }, text: list.join('\n') })
        : el('div', { class: 'small muted', text: '无' })
    ]);
  }

  function copyText(text) {
    try {
      navigator.clipboard.writeText(text).then(function () { ctx.toast('已复制：' + text, 'ok'); }, function () { ctx.toast('复制失败', 'warn'); });
    } catch (e) { ctx.toast('复制失败：' + e.message, 'warn'); }
  }

  function openReader(comicId, order, index) {
    const p = new URLSearchParams({ comic: comicId });
    if (order) p.set('order', String(order));
    if (index) p.set('index', String(index));
    ctx.navigate('#/reader?' + p.toString());
  }

  /* ---------------- 扫描 ---------------- */
  async function startScan() {
    if (S.scanning) { ctx.toast('正在扫描中…', 'warn'); return; }
    S.scanning = true;
    scanBtn.disabled = true;
    scanBar.classList.remove('hidden');
    scanBar.textContent = '';
    const bar = el('i', { style: { width: '0%' } });
    scanBar.appendChild(el('div', { class: 'row between gap-10 wrap', style: { marginBottom: '7px' } }, [
      el('div', { class: 'row gap-8' }, [el('span', { class: 'spinner' }), el('span', { id: 'mvScanMsg', text: '准备扫描…' })]),
      el('span', { class: 'label-mono', id: 'mvScanPhase', text: '' })
    ]));
    scanBar.appendChild(el('div', { class: 'progress' }, [bar]));
    try { await ctx.post('/api/library/scan', {}); }
    catch (err) { ctx.toast('启动扫描失败：' + err.message, 'err'); finishScan(); }
  }

  function finishScan() { S.scanning = false; scanBtn.disabled = false; }

  ctx.sse('/api/library/scan/events', {
    onEvent: function (event, data) {
      if (event === 'state') {
        if (data && data.scanning) { S.scanning = true; scanBtn.disabled = true; scanBar.classList.remove('hidden'); }
        return;
      }
      if (event === 'progress' && data) {
        const bar = scanBar.querySelector('.progress > i');
        if (bar) bar.style.width = Math.max(3, data.total > 1 ? Math.round((data.current / data.total) * 100) : 10) + '%';
        const msg = scanBar.querySelector('#mvScanMsg');
        if (msg) msg.textContent = data.message || '';
        const ph = scanBar.querySelector('#mvScanPhase');
        if (ph) ph.textContent = ({ start: '启动', list: '列目录', scan: '解析', facets: '统计' })[data.phase] || data.phase || '';
      } else if (event === 'done') {
        finishScan();
        const bar = scanBar.querySelector('.progress > i');
        if (bar) bar.style.width = '100%';
        const msg = scanBar.querySelector('#mvScanMsg');
        if (msg && data && data.stats) msg.textContent = '完成：' + data.stats.comics + ' 部 / ' + ctx.fmt.num(data.stats.images) + ' 张 / ' + ctx.fmt.bytes(data.stats.bytes);
        ctx.toast('扫描完成：' + (data && data.stats ? data.stats.comics : '?') + ' 部漫画', 'ok');
        setTimeout(function () { scanBar.classList.add('hidden'); }, 2600);
        loadOverview(); S.page = 1; reload();
      } else if (event === 'error') {
        const m = data && typeof data === 'object' ? data.message : null;
        if (!m) return;
        finishScan();
        ctx.toast('扫描失败：' + m, 'err');
      }
    }
  });

  /* ---------------- 事件 ---------------- */
  let timer = null;
  searchInput.addEventListener('input', function () {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      S.q = searchInput.value.trim();
      ctx.state.set('library.q', S.q);
      S.page = 1; reload();
    }, 300);
  });
  sortSelect.addEventListener('change', function () { S.sort = sortSelect.value; ctx.state.set('library.sort', S.sort); S.page = 1; reload(); });
  sizeSelect.addEventListener('change', function () { S.size = Number(sizeSelect.value); S.page = 1; reload(); });
  densitySelect.addEventListener('change', function () { S.density = Number(densitySelect.value); ctx.state.set('library.density', S.density); if (vg) { vg.destroy(); vg = null; } renderGrid(); });
  ctx.on(document, 'keydown', function (e) {
    if (e.key === '/' && document.activeElement !== searchInput) { e.preventDefault(); searchInput.focus(); }
  });
  /* 触底自动翻页：阈值放宽到 400px，并且**同时挂在 #content 与 window 上** ——
     不同浏览器/宿主下滚动祖先可能是文档本身，只挂 #content 会漏（#content 的
     scroll 事件不冒泡到 window，两者必须各挂一次）。真正的兜底是页脚那个常驻按钮。 */
  const scrollHost = document.getElementById('content') || window;
  ctx.on(scrollHost, 'scroll', function (e) {
    const t = e.target;
    const top = (t && typeof t.scrollTop === 'number') ? t.scrollTop : (window.scrollY || 0);
    const clientH = (t && t.clientHeight) || window.innerHeight || 0;
    const scrollH = (t && t.scrollHeight) || document.documentElement.scrollHeight || 0;
    if (top + clientH < scrollH - 400) return;
    loadMore();
  }, { passive: true });

  function buildQuery(page) {
    const params = new URLSearchParams({ page: String(page), size: String(S.size), sort: S.sort });
    if (S.q) params.set('q', S.q);
    if (S.tag) params.set('tag', S.tag);
    if (S.root) params.set('root', S.root);
    if (S.fav) params.set('fav', '1');
    if (S.hasMeta) params.set('hasMeta', S.hasMeta);
    return params.toString();
  }

  sizeSelect.value = String(S.size);
  densitySelect.value = String(S.density);
  await Promise.all([loadOverview(), reload()]);
}