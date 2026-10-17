/* ===========================================================
   漫库 MangaVault · 下载模块前端
   四个页签：搜索入库 / 收藏夹 / 排行榜 / 我的；实时进度走 SSE。
   只使用 theme.css 已有类 + mv- 前缀自定义类。
   =========================================================== */

export const meta = { id: 'download', name: '下载', order: 30 };

const STATE_TEXT = {
  queued: '排队中', running: '下载中', paused: '已暂停', done: '已完成',
  error: '有错误', canceled: '已取消', removed: '已删除', pending: '待下载'
};
const STATE_BADGE = {
  queued: 'badge', running: 'badge badge-accent', paused: 'badge badge-warn',
  done: 'badge badge-ok', error: 'badge badge-err', canceled: 'badge', pending: 'badge'
};

/** 卡片分批渲染：首屏只挂这么多，其余按「加载更多」追加，避免一次 append 几百个节点。 */
const CARD_BATCH = 24;
/** 排行榜周期（与后端契约 tt 取值一致）。 */
const RANK_LABELS = [['H24', '日榜'], ['D7', '周榜'], ['D30', '月榜']];
/** 收藏排序（与后端契约 sort 取值一致）。 */
const FAVORITE_SORTS = [['dd', '最新收藏'], ['da', '最早收藏']];

export async function mount(root, ctx) {
  const el = ctx.el;
  const api = ctx.api;
  const state = {
    tab: ctx.state.get('download.tab', 'search') || 'search',
    page: 1,
    pages: 1,
    total: 0,
    items: [],
    searching: false,
    tasks: [],
    stats: null,
    info: null,
    busy: {},
    sseOk: false,
    favoritesSort: ctx.state.get('download.favoritesSort', 'dd') || 'dd',
    favoritesItems: [],
    favoritesTotal: 0,
    favoritesPages: 1,
    favoritesPage: 1,
    favoritesLoading: false,
    favoritesLoaded: false,
    favoritesError: '',
    rankType: ctx.state.get('download.rankType', 'H24') || 'H24',
    leaderboardItems: [],
    leaderboardTotal: 0,
    leaderboardNotice: '',
    leaderboardLoading: false,
    leaderboardLoaded: false,
    leaderboardError: '',
    account: null,
    accountLoading: false,
    remembered: [],
    loginEmail: '',
    loginPassword: '',
    loggingIn: false,
    profile: null,
    profileLoading: false,
    profileError: ''
  };

  ctx.title('下载中心', '搜索哔咔漫画并下载入库');
  ensureStyles();

  /* ---------------- 骨架 ---------------- */
  const rootCard = el('div', { class: 'card card-pad mv-dl-root' });
  const tokenWarn = el('div', { class: 'alert alert-warn hidden' }, [
    el('div', { class: 'col gap-6' }, [
      el('div', { style: { fontWeight: '650' }, text: '未配置哔咔 token' }),
      el('div', { class: 'small', text: '搜索与下载都需要 token。请到左侧「设置」页填写哔咔 token 后再回来。' })
    ])
  ]);

  /* 页签容器带专用类：面板里也有 .chip（排序 / 周期），测试必须限定范围，
     否则「下载页有 5 个页签」会数到 10 个。 */
  const tabChips = el('div', { class: 'row gap-6 mv-dl-tabs' });
  /* 每个面板都带 mv-dl-panel：切换页签只是给它加 .hidden，卡片仍然留在 DOM 里。
     断言卡片数量时必须写 `.mv-dl-panel:not(.hidden) .comic-card`，
     否则数到的是隐藏面板里的卡片 —— 曾经让「排行榜渲染出卡片」假绿。 */
  const searchPanel = el('div', { class: 'col gap-14 mv-dl-panel' });
  const favoritesPanel = el('div', { class: 'col gap-14 hidden mv-dl-panel' });
  const leaderboardPanel = el('div', { class: 'col gap-14 hidden mv-dl-panel' });
  const accountPanel = el('div', { class: 'col gap-14 hidden mv-dl-panel' });
  const taskPanel = el('div', { class: 'col gap-14 hidden mv-dl-panel' });

  root.appendChild(el('div', { class: 'col gap-14' }, [
    rootCard, tokenWarn, tabChips, searchPanel, favoritesPanel, leaderboardPanel, accountPanel, taskPanel
  ]));

  function makeChip(id, label, withBadge) {
    const b = el('span', { class: 'muted', text: '' });
    const node = el('div', {
      class: 'chip' + (state.tab === id ? ' active' : ''),
      on: { click: function () { switchTab(id); } }
    }, [el('span', { text: label }), withBadge ? b : null]);
    node.__badge = b;
    return node;
  }
  const searchChip = makeChip('search', '搜索入库', false);
  const favoritesChip = makeChip('favorites', '收藏夹', false);
  const leaderboardChip = makeChip('leaderboard', '排行榜', false);
  const accountChip = makeChip('account', '我的', false);
  const taskChip = makeChip('tasks', '下载任务', true);
  tabChips.appendChild(searchChip);
  tabChips.appendChild(favoritesChip);
  tabChips.appendChild(leaderboardChip);
  tabChips.appendChild(accountChip);
  tabChips.appendChild(taskChip);

  /* 页签 id -> 面板与按钮，切换逻辑只写一遍。 */
  const TABS = [
    { id: 'search', chip: searchChip, panel: searchPanel, onShow: null },
    /* onShow 由 switchTab 无参调用；不包一层的话 reset 是 undefined，
       而 loadFavorites 里 startPage = reset ? 1 : favoritesPage + 1，
       于是首次进页签直接从第 2 页开始拉 —— 必须显式传 reset=true。 */
    { id: 'favorites', chip: favoritesChip, panel: favoritesPanel, onShow: function () { loadFavorites(true); } },
    { id: 'leaderboard', chip: leaderboardChip, panel: leaderboardPanel, onShow: loadLeaderboard },
    { id: 'account', chip: accountChip, panel: accountPanel, onShow: loadAccountTab },
    { id: 'tasks', chip: taskChip, panel: taskPanel, onShow: loadTasks }
  ];

  function switchTab(id) {
    state.tab = id;
    ctx.state.set('download.tab', id);
    for (const t of TABS) {
      t.chip.classList.toggle('active', t.id === id);
      t.panel.classList.toggle('hidden', t.id !== id);
    }
    const cur = TABS.filter(function (t) { return t.id === id; })[0];
    if (cur && typeof cur.onShow === 'function') cur.onShow();
  }

  /* ---------------- 顶部：根目录 / token ---------------- */
  function renderRoot() {
    rootCard.textContent = '';
    const info = state.info || {};
    const free = info.freeBytes === null || info.freeBytes === undefined ? '未知' : ctx.fmt.bytes(info.freeBytes);
    rootCard.appendChild(el('div', { class: 'row between gap-12 wrap' }, [
      el('div', { class: 'col gap-4 grow', style: { minWidth: '260px' } }, [
        el('div', { class: 'row gap-8 center' }, [
          el('span', { style: { color: 'var(--accent-2)', display: 'inline-flex' } }, [ctx.icon('hard-drive')]),
          el('div', { style: { fontWeight: '650' }, text: '下载根目录' })
        ]),
        el('div', { class: 'small mono muted', style: { wordBreak: 'break-all' }, text: info.downloadRoot || '（未配置）' })
      ]),
      el('div', { class: 'row gap-6 wrap' }, [
        el('span', { class: 'badge', text: '可用空间 ' + free }),
        el('span', { class: 'badge', text: '格式 ' + String(info.format || 'Jpeg') }),
        el('span', { class: 'badge', text: '在跑 ' + (info.runningTasks || 0) + ' / 并发上限 ' + ((info.concurrency && info.concurrency.maxConcurrentTasks) || 2) }),
        info.proxy ? el('span', { class: 'badge badge-accent', text: '代理已启用' }) : null,
        info.hasToken
          ? el('span', { class: 'badge badge-ok', text: 'token 已配置' })
          : el('span', { class: 'badge badge-err', text: 'token 未配置' })
      ]),
      el('div', { class: 'row gap-6' }, [
        el('button', { class: 'btn btn-sm', on: { click: openRootFolder } }, [ctx.icon('folder'), el('span', { text: '打开根目录' })]),
        el('button', { class: 'btn btn-sm btn-ghost', on: { click: checkToken } }, [ctx.icon('shield'), el('span', { text: '检查 token' })]),
        el('button', { class: 'btn btn-sm btn-ghost', on: { click: refreshInfo } }, [ctx.icon('refresh'), el('span', { text: '刷新' })])
      ])
    ]));
    tokenWarn.classList.toggle('hidden', Boolean(info.hasToken));
  }

  async function refreshInfo() {
    try {
      state.info = await api('/api/download/state');
      renderRoot();
    } catch (err) {
      state.info = state.info || {};
      renderRoot();
      ctx.toast('下载模块状态获取失败：' + err.message, 'err');
    }
  }

  async function checkToken() {
    try {
      const r = await api('/api/download/token-check');
      ctx.toast(r.message || 'token 有效', 'ok');
      refreshInfo();
    } catch (err) {
      /* 校验失败时不要只说「失败」——直接给出去处（设置页有粘贴框），否则用户会像无头苍蝇。 */
      const msg = String(err && err.message || '');
      const needNew = /鉴权|token|1005|未登录|过期|无效/i.test(msg);
      ctx.toast('token 校验失败：' + msg, 'err');
      if (!needNew) return;
      const go = await ctx.confirm(
        msg + '\n\n要现在去「设置 · 哔咔账号」粘贴一个新的 token 吗？（在哔咔 App 里抓到的 JWT）',
        { title: 'token 需要更新', okText: '去设置' }
      );
      if (go) ctx.navigate('#/settings');
    }
  }

  async function openRootFolder() {
    try {
      const r = await ctx.post('/api/download/open-folder', {});
      ctx.toast(r.message || '已打开下载根目录', 'ok');
    } catch (err) {
      ctx.toast('打开根目录失败：' + err.message, 'err');
    }
  }

  /* ---------------- 共用：排版小工具 ---------------- */
  function textOf(v) {
    return v === undefined || v === null || v === '' ? '' : String(v);
  }

  function plural(n, unit) {
    return String(Number(n) || 0) + ' ' + unit;
  }

  /** 卡片副标题：能拿到什么就说什么，字段缺失不显示空壳。 */
  function comicSub(item) {
    const parts = [];
    if (textOf(item && item.author)) parts.push('作者 ' + item.author);
    if (item && item.chapterCount) parts.push(plural(item.chapterCount, '章'));
    if (item && item.likes) parts.push('♥ ' + ctx.fmt.num(item.likes));
    if (item && item.inLibrary) parts.push('已在库');
    return parts.join(' · ');
  }

  /** 中文可读的请求失败原因：优先用后端给的 error，再按 HTTP 状态码兜底。 */
  function errorMessage(err, fallback) {
    const msg = textOf(err && err.message ? err.message : err);
    const status = err && err.status ? Number(err.status) : 0;
    if (status === 404) return '接口还没就绪（HTTP 404）—— 该功能的后端路由可能尚未合入' + (msg ? '：' + msg : '');
    if (status === 401) return (msg || '未登录或登录已过期') + '（请在「我的」页签登录）';
    if (status >= 500) return '本地服务出错（HTTP ' + status + '）' + (msg ? '：' + msg : '');
    if (status === 0 && !msg) return fallback;
    return msg || fallback;
  }

  /** 接口返回 { code:'NOT_SUPPORTED' } 时的中文提示。 */
  function isNotSupported(err) {
    const data = err && err.data;
    return Boolean(err && err.status === 400 && data && data.code === 'NOT_SUPPORTED');
  }

  function isAuthError(err) {
    if (!err) return false;
    if (err.status === 401) return true;
    return /未登录|token 已失效|登录已过期|token 无效/.test(textOf(err.message));
  }

  /** 统一的「加载中」占位。 */
  function loadingBox(text) {
    return el('div', { class: 'empty' }, [el('div', { class: 'spinner spinner-lg' }), el('div', { class: 'small', text: text })]);
  }

  /** 统一的失败块：中文原因 + 重试按钮。 */
  function errorBox(title, message, onRetry) {
    const box = el('div', { class: 'alert alert-err mv-dl-error' }, [
      el('div', { class: 'col gap-6 grow' }, [
        el('div', { style: { fontWeight: '650' }, text: title }),
        el('div', { class: 'small', text: message })
      ]),
      el('button', { class: 'btn btn-sm btn-ghost', on: { click: onRetry } }, [ctx.icon('refresh'), el('span', { text: '重试' })])
    ]);
    return box;
  }

  /**
   * 漫画卡片列表：分批挂载 + 加载更多 + 加载中 / 失败重试 / 空态。
   * 搜索、收藏夹、排行榜共用同一份卡片渲染器（comicCard）。
   */
  function makeComicBoard(options) {
    const o = options || {};
    const grid = el('div', { class: 'grid grid-cards' });
    const moreWrap = el('div', { class: 'row center mv-dl-more' });
    let items = [];
    let shown = 0;
    let onMore = null;
    /* 「服务端还有下一页」与「本地还有没渲染完的」是两件事，必须分开：
       上游一页给 30 条而首屏只挂 24 条，所以先本地点一下补到 30（appendBatch），
       本页补完（shown === items.length）才轮到「加载下一页」去翻服务端。
       两套分批混成一步就会出现：点加载更多 → 先补到 30 → 又拉第 2 页 → set() 从头重渲染 → 卡片回到 24。 */
    let serverMore = false;

    function renderMore() {
      moreWrap.textContent = '';
      const batch = o.batch || CARD_BATCH;
      if (items.length && shown < items.length) {
        const label = o.moreText ? o.moreText(items.length - shown) : '加载更多（还有 ' + (items.length - shown) + ' 部）';
        moreWrap.appendChild(el('button', {
          class: 'btn btn-ghost btn-sm',
          /* 只补本地尚未挂载的条目，不碰服务端分页 */
          on: { click: function () { appendBatch(batch); } }
        }, [ctx.icon('chevron-down'), el('span', { text: label })]));
        return;
      }
      if (serverMore && typeof onMore === 'function') {
        moreWrap.appendChild(el('button', {
          class: 'btn btn-ghost btn-sm',
          /* 本地都排完了，这时才去翻服务端下一页 */
          on: { click: function () { onMore(); } }
        }, [ctx.icon('chevron-down'), el('span', { text: '加载下一页' })]));
      }
    }

    function appendBatch(n) {
      const end = Math.min(items.length, shown + Math.max(1, n || CARD_BATCH));
      for (let i = shown; i < end; i++) grid.appendChild(comicCard(items[i]));
      shown = end;
      renderMore();
    }

    function clearGrid() {
      grid.textContent = '';
      moreWrap.textContent = '';
      shown = 0;
    }

    return {
      grid: grid,
      moreWrap: moreWrap,
      /** 用一批数据从头渲染。 */
      set: function (list, next) {
        items = Array.isArray(list) ? list : [];
        onMore = typeof next === 'function' ? next : null;
        clearGrid();
        if (!items.length) return;
        appendBatch(o.batch || CARD_BATCH);
      },
      /** 追加一批数据（翻页后调用），只对本次新增的项继续分批。 */
      add: function (list, next) {
        const more = Array.isArray(list) ? list : [];
        if (typeof next === 'function') onMore = next;
        if (!more.length) return;
        const from = items.length;
        items = items.concat(more);
        const end = Math.min(items.length, from + (o.batch || CARD_BATCH));
        for (let i = shown; i < end; i++) grid.appendChild(comicCard(items[i]));
        shown = end;
        renderMore();
      },
      showLoading: function (text) { clearGrid(); grid.appendChild(loadingBox(text)); },
      showError: function (title, message, onRetry) { clearGrid(); grid.appendChild(errorBox(title, message, onRetry)); },
      showEmpty: function (title, desc) { clearGrid(); grid.appendChild(ctx.empty(title, desc)); },
      /** 同步「服务端还有下一页」；调用方在拿到 page / pages 后设置。 */
      setServerMore: function (v) { serverMore = Boolean(v); renderMore(); },
      clear: clearGrid,
      count: function () { return items.length; },
      shown: function () { return shown; }
    };
  }

  /** RISOPRINT 风格的分段切换（用 chip 表达，不用胶囊圆角）。 */
  function makeChipGroup(options) {
    const o = options || {};
    const wrap = el('div', { class: 'row gap-6' });
    const nodes = [];
    let current = o.value;
    function paint() {
      for (const n of nodes) n.classList.toggle('active', n.__value === current);
    }
    for (const pair of o.options) {
      const node = el('div', {
        class: 'chip' + (pair[0] === current ? ' active' : ''),
        title: o.title || '',
        on: { click: function () { if (pair[0] === current) return; current = pair[0]; paint(); o.onChange(pair[0]); } }
      }, [el('span', { text: pair[1] })]);
      node.__value = pair[0];
      nodes.push(node);
      wrap.appendChild(node);
    }
    return {
      el: wrap,
      set: function (v) { current = v; paint(); },
      value: function () { return current; }
    };
  }

  /* ---------------- 搜索入库 ---------------- */
  const searchInput = el('input', {
    class: 'input', type: 'text', placeholder: '输入关键字后回车搜索（作者名 / 作品名）', autocomplete: 'off'
  });
  const searchBtn = el('button', { class: 'btn btn-primary', on: { click: function () { doSearch(true); } } }, [
    ctx.icon('search'), el('span', { text: '搜索' })
  ]);
  const searchStatus = el('div', { class: 'small muted', text: '' });
  const grid = el('div', { class: 'grid grid-cards' });
  const pager = el('div', { class: 'row center gap-10' });

  function buildSearchPanel() {
    searchPanel.textContent = '';
    searchPanel.appendChild(el('div', { class: 'col gap-6' }, [
      el('div', { class: 'section-title', text: '搜索哔咔漫画' }),
      searchStatus
    ]));
    searchPanel.appendChild(el('div', { class: 'toolbar' }, [
      el('div', { class: 'searchbox grow' }, [ctx.icon('search'), searchInput]),
      searchBtn
    ]));
    searchPanel.appendChild(grid);
    searchPanel.appendChild(pager);
    searchPanel.appendChild(el('div', { class: 'small muted', text: '提示：已在库的作品显示「已在库」标记；点卡片可查看章节并选择要补下的章节。' }));
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(true); }
    });
  }

  async function doSearch(reset) {
    const q = searchInput.value.trim();
    if (!q) { ctx.toast('请输入搜索关键字', 'warn'); return; }
    if (state.searching) return;
    state.searching = true;
    if (reset) state.page = 1;
    grid.textContent = '';
    grid.appendChild(loadingBox('正在搜索…'));
    searchStatus.textContent = '搜索中：' + q;
    searchBtn.disabled = true;
    try {
      const r = await api('/api/download/search?q=' + encodeURIComponent(q) + '&page=' + state.page);
      state.items = r.items || [];
      state.pages = r.pages || 1;
      state.total = r.total || 0;
      renderResults(r);
      searchStatus.textContent = '共 ' + state.total + ' 条结果 · 第 ' + (r.page || state.page) + ' / ' + state.pages + ' 页';
    } catch (err) {
      grid.textContent = '';
      grid.appendChild(el('div', { class: 'alert alert-err' }, [el('div', { class: 'col gap-6' }, [
        el('div', { style: { fontWeight: '650' }, text: '搜索失败' }),
        el('div', { class: 'small', text: err.message })
      ])]));
      searchStatus.textContent = '';
      ctx.toast('搜索失败：' + err.message, 'err');
    } finally {
      state.searching = false;
      searchBtn.disabled = false;
    }
  }

  function renderResults() {
    grid.textContent = '';
    if (!state.items.length) {
      grid.appendChild(ctx.empty('没有搜索结果', '换个关键字再试试'));
      pager.textContent = '';
      return;
    }
    for (const item of state.items) grid.appendChild(comicCard(item));
    pager.textContent = '';
    pager.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm', disabled: state.page <= 1,
      on: { click: function () { if (state.page > 1) { state.page--; doSearch(false); } } }
    }, [ctx.icon('chevron-left'), el('span', { text: '上一页' })]));
    pager.appendChild(el('span', { class: 'small muted', text: state.page + ' / ' + state.pages }));
    pager.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm', disabled: state.page >= state.pages,
      on: { click: function () { if (state.page < state.pages) { state.page++; doSearch(false); } } }
    }, [el('span', { text: '下一页' }), ctx.icon('chevron-right')]));
  }

  function coverPlaceholder(title) {
    return el('div', {
      style: { width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: 'linear-gradient(150deg,#1d2432,#0e1117)', color: 'var(--txt-3)', fontSize: '22px', fontWeight: '700' },
      text: String(title || '?').slice(0, 1)
    });
  }

  /* 判断「这是个能加载的封面地址」。
     ★ 不能用 url.indexOf('//') > 0 这种土办法：我们自己的封面代理地址形如
       /api/download/cover?path=https%3A%2F%2F...（内层 URL 被 encodeURIComponent 编码成 %2F%2F），
       字面上根本没有连续的 '//'，于是**所有卡片永远走占位分支**，
       搜索/收藏/排行榜三处一律只能看到「首字占位块」——表现为「封面全是占位图」。
       这里改成认绝对地址（http/https/协议相对）与站内绝对路径两种形态。 */
  function isCoverUrl(url) {
    const s = String(url || '');
    return /^https?:\/\//i.test(s) || /^\/\//.test(s) || /^\//.test(s);
  }

  function coverNode(title, url, onClick) {
    const wrap = el('div', { class: 'cover-wrap', on: onClick ? { click: onClick } : null });
    if (isCoverUrl(url)) {
      const img = el('img', { class: 'cover', loading: 'lazy', src: url, alt: title || '' });
      img.addEventListener('error', function () { img.remove(); wrap.appendChild(coverPlaceholder(title)); });
      wrap.appendChild(img);
    } else {
      wrap.appendChild(coverPlaceholder(title));
    }
    return wrap;
  }

  /** 唯一的漫画卡片渲染器：搜索 / 收藏夹 / 排行榜共用（契约要求形状一致）。 */
  function comicCard(item) {
    return el('div', { class: 'comic-card hoverable' }, [
      coverNode(item.title, item.cover, function () { openComic(item); }),
      el('div', { class: 'comic-body' }, [
        el('div', { class: 'comic-title', title: item.title, text: item.title || '(无标题)' }),
        el('div', { class: 'comic-author ellipsis', text: item.author || '未知作者' }),
        el('div', { class: 'row wrap gap-6', style: { marginTop: '4px' } }, [
          item.inLibrary
            ? el('span', { class: 'badge badge-ok', text: '已在库' })
            : el('span', { class: 'badge', text: (item.chapterCount || 0) + ' 章' }),
          item.finished ? el('span', { class: 'badge', text: '已完结' }) : null,
          item.likes ? el('span', { class: 'badge', text: '♥ ' + ctx.fmt.num(item.likes) }) : null
        ]),
        el('div', { class: 'row wrap gap-6', style: { marginTop: '4px' } }, (item.tags || []).slice(0, 4).map(function (t) {
          return el('span', { class: 'tag', text: t });
        })),
        el('div', { class: 'row gap-6', style: { marginTop: '8px' } }, [
          el('button', { class: 'btn btn-sm grow', on: { click: function (e) { e.stopPropagation(); openComic(item); } } }, [
            ctx.icon('list'), el('span', { text: '选择章节' })
          ]),
          item.inLibrary
            ? el('button', { class: 'btn btn-sm btn-ghost', title: '打开目录', on: { click: function (e) { e.stopPropagation(); openFolder(item); } } }, [ctx.icon('folder')])
            : null
        ])
      ])
    ]);
  }

  async function openFolder(item) {
    try {
      const r = await ctx.post('/api/download/open-folder', { comicId: item.id, title: item.title });
      ctx.toast(r.message || '已打开目录', 'ok');
    } catch (err) {
      ctx.toast('打开目录失败：' + err.message, 'err');
    }
  }

  /* ---------------- 收藏夹 ---------------- */
  const favoritesStatus = el('div', { class: 'small muted mv-dl-fav-status', text: '' });
  const favoritesBoard = makeComicBoard({ batch: CARD_BATCH });
  const favoritesSortGroup = makeChipGroup({
    value: state.favoritesSort,
    options: FAVORITE_SORTS,
    title: '收藏排序',
    onChange: function (v) {
      state.favoritesSort = v;
      ctx.state.set('download.favoritesSort', v);
      loadFavorites(true);
    }
  });
  const favoritesRefreshBtn = el('button', { class: 'btn btn-sm btn-ghost', on: { click: function () { loadFavorites(true); } } }, [
    ctx.icon('refresh'), el('span', { text: '刷新' })
  ]);

  function buildFavoritesPanel() {
    favoritesPanel.textContent = '';
    favoritesPanel.appendChild(el('div', { class: 'toolbar' }, [
      el('div', { class: 'section-title grow', text: '我的收藏' }),
      el('span', { class: 'small muted', text: '排序' }),
      favoritesSortGroup.el,
      favoritesRefreshBtn
    ]));
    favoritesPanel.appendChild(favoritesStatus);
    favoritesPanel.appendChild(favoritesBoard.grid);
    favoritesPanel.appendChild(favoritesBoard.moreWrap);
    favoritesPanel.appendChild(el('div', { class: 'small muted', text: '提示：收藏夹读取的是哔咔账号里的收藏；点卡片可查看章节并选择要补下的章节。' }));
  }

  async function loadFavorites(reset) {
    if (state.favoritesLoading) return;
    const startPage = reset ? 1 : state.favoritesPage + 1;
    state.favoritesLoading = true;
    state.favoritesError = '';
    favoritesRefreshBtn.disabled = true;
    if (reset) {
      state.favoritesItems = [];
      state.favoritesTotal = 0;
      favoritesBoard.showLoading('正在读取收藏夹…');
    } else {
      favoritesBoard.moreWrap.textContent = '';
    }
    favoritesStatus.textContent = '排序：' + (state.favoritesSort === 'da' ? '最早收藏' : '最新收藏') + ' · 读取第 ' + startPage + ' 页…';
    try {
      const r = await api('/api/download/favorites?sort=' + encodeURIComponent(state.favoritesSort) + '&page=' + startPage);
      const list = Array.isArray(r.items) ? r.items : [];
      state.favoritesPage = Number(r.page || startPage);
      state.favoritesPages = Math.max(1, Number(r.pages || 1));
      state.favoritesTotal = Number(r.total || list.length);
      state.favoritesLoaded = true;
      /* reset（首次进页签 / 换排序）才 set() 从头渲染；翻页必须 add() 追加。
         曾经翻页走 set()，把已经渲染的 30 张打回 24 张（客户端分批与服务端分页打架）。 */
      if (reset) {
        state.favoritesItems = list.slice();
        favoritesBoard.set(state.favoritesItems, reloadFavoritesMore);
      } else {
        state.favoritesItems = state.favoritesItems.concat(list);
        favoritesBoard.add(list, reloadFavoritesMore);
      }
      if (!state.favoritesItems.length) {
        favoritesBoard.showEmpty('收藏夹是空的', '在哔咔 App 里收藏漫画后回到这里刷新');
        favoritesBoard.setServerMore(false);
        favoritesStatus.textContent = '';
        return;
      }
      /* 本地已渲染完但还有下一页时，按钮才会变成「加载下一页」。 */
      favoritesBoard.setServerMore(state.favoritesPage < state.favoritesPages);
      const shownText = '已显示 ' + favoritesBoard.shown() + ' / ' + state.favoritesItems.length + ' 部';
      const totalText = state.favoritesTotal ? ' · 共 ' + state.favoritesTotal + ' 部' : '';
      const pageText = ' · 第 ' + state.favoritesPage + ' / ' + state.favoritesPages + ' 页';
      favoritesStatus.textContent = shownText + totalText + pageText;
    } catch (err) {
      const message = errorMessage(err, '收藏夹读取失败');
      state.favoritesError = message;
      favoritesStatus.textContent = '';
      if (reset || !state.favoritesItems.length) {
        favoritesBoard.showError('收藏夹读取失败', message, function () { loadFavorites(true); });
      } else {
        favoritesBoard.moreWrap.textContent = '';
        favoritesBoard.moreWrap.appendChild(errorBox('加载更多失败', message, function () { loadFavorites(false); }));
      }
      ctx.toast('收藏夹读取失败：' + message, 'err');
    } finally {
      state.favoritesLoading = false;
      favoritesRefreshBtn.disabled = false;
    }
  }

  /** 「加载更多」：本页已排完就翻下一页，否则继续排当前已取回的条目。 */
  function reloadFavoritesMore() {
    if (state.favoritesPage < state.favoritesPages) loadFavorites(false);
  }

  /* ---------------- 排行榜 ---------------- */
  const leaderboardStatus = el('div', { class: 'small muted mv-dl-rank-status', text: '' });
  const leaderboardNotice = el('div', { class: 'alert alert-info hidden' });
  const leaderboardBoard = makeComicBoard({ batch: CARD_BATCH });
  const rankGroup = makeChipGroup({
    value: state.rankType,
    options: RANK_LABELS,
    title: '榜单周期',
    onChange: function (v) {
      state.rankType = v;
      ctx.state.set('download.rankType', v);
      loadLeaderboard();
    }
  });

  function buildLeaderboardPanel() {
    leaderboardPanel.textContent = '';
    leaderboardPanel.appendChild(el('div', { class: 'toolbar' }, [
      el('div', { class: 'section-title grow', text: '哔咔排行榜' }),
      el('span', { class: 'small muted', text: '周期' }),
      rankGroup.el
    ]));
    leaderboardPanel.appendChild(leaderboardNotice);
    leaderboardPanel.appendChild(leaderboardStatus);
    leaderboardPanel.appendChild(leaderboardBoard.grid);
    leaderboardPanel.appendChild(leaderboardBoard.moreWrap);
  }

  function setLeaderboardNotice(text) {
    leaderboardNotice.textContent = '';
    state.leaderboardNotice = textOf(text);
    if (!state.leaderboardNotice) { leaderboardNotice.classList.add('hidden'); return; }
    leaderboardNotice.classList.remove('hidden');
    leaderboardNotice.appendChild(ctx.icon('info'));
    leaderboardNotice.appendChild(el('div', { class: 'small', text: state.leaderboardNotice }));
  }

  async function loadLeaderboard() {
    if (state.leaderboardLoading) return;
    state.leaderboardLoading = true;
    state.leaderboardError = '';
    setLeaderboardNotice('');
    leaderboardStatus.textContent = '';
    leaderboardBoard.showLoading('正在读取排行榜…');
    try {
      const r = await api('/api/download/leaderboard?tt=' + encodeURIComponent(state.rankType) + '&ct=VC&page=1');
      const list = Array.isArray(r.comics) ? r.comics : [];
      state.leaderboardItems = list.slice();
      state.leaderboardTotal = Number(r.total || list.length);
      state.leaderboardLoaded = true;
      if (!list.length) {
        leaderboardBoard.showEmpty('这个榜单暂时没有内容', '换个周期（日榜 / 周榜 / 月榜）再看看');
        return;
      }
      /* 排行榜上游一次给全榜（pages 固定 1），所以只有本地分批，没有服务端下一页。 */
      leaderboardBoard.set(state.leaderboardItems, null);
      leaderboardBoard.setServerMore(false);
      const label = rankLabelOf(state.rankType);
      leaderboardStatus.textContent = label + ' · 共 ' + state.leaderboardTotal + ' 部 · 已显示 ' + leaderboardBoard.shown();
    } catch (err) {
      if (isNotSupported(err)) {
        const message = textOf(err.message) || '当前下载源不提供排行榜接口';
        state.leaderboardError = message;
        setLeaderboardNotice('暂不支持：' + message);
        leaderboardBoard.showEmpty('该来源不支持排行榜', '请到「设置」里换一个支持排行榜的下载源');
        return;
      }
      const message = errorMessage(err, '排行榜读取失败');
      state.leaderboardError = message;
      leaderboardBoard.showError('排行榜读取失败', message, loadLeaderboard);
      ctx.toast('排行榜读取失败：' + message, 'err');
    } finally {
      state.leaderboardLoading = false;
    }
  }

  function rankLabelOf(v) {
    const hit = RANK_LABELS.filter(function (p) { return p[0] === v; })[0];
    return hit ? hit[1] : String(v || '');
  }

  /* ---------------- 我的（登录 / 资料） ---------------- */
  const accountStatus = el('div', { class: 'small muted mv-dl-account-status', text: '' });
  let accountGrid = null;

  function buildAccountPanel() {
    accountPanel.textContent = '';
    accountPanel.appendChild(el('div', { class: 'col gap-6' }, [
      el('div', { class: 'section-title', text: '我的账号' }),
      accountStatus
    ]));
    accountGrid = el('div', { class: 'col gap-14' });
    accountPanel.appendChild(accountGrid);
  }

  async function loadAccount() {
    state.accountLoading = true;
    renderAccount('');
    let note = '';
    let errText = '';
    try {
      const r = await api('/api/download/account');
      const account = r && r.account ? r.account : null;
      state.account = account;
      state.remembered = Array.isArray(r && r.remembered) ? r.remembered : [];
      if (account && !state.loginEmail) state.loginEmail = textOf(account.email);
      note = textOf(r && r.message);
    } catch (err) {
      state.account = null;
      state.profileError = '';
      errText = errorMessage(err, '登录状态读取失败');
      ctx.toast('登录状态读取失败：' + errText, 'err');
    } finally {
      /* 必须先清掉 loading 标志、再渲染一次。
         曾经写成「在 try 里 renderAccount()，finally 里只清标志」——
         render 时 accountLoading 还是 true，于是面板永远停在「正在读取登录状态…」，
         登录表单永远不出现。收尾方式与 loadProfile() 保持一致。 */
      state.accountLoading = false;
      renderAccount(errText);
    }
    if (!state.account && note) ctx.toast(note, 'warn');
  }

  /** 「我的」页签进入逻辑：先确认登录态，再确保资料已经拉过。 */
  async function loadAccountTab() {
    await loadAccount();
    ensureProfileLoaded();
  }

  /**
   * 已登录但还没有资料时补拉一次；已有资料或正在拉就不重复发请求。
   * 为什么需要它：登录态可能是由 SSE 账号事件补上的（后端 login 会 hub.send('account')），
   * 那条路径只更新 state.account 并重绘，不会去拉资料 —— 于是界面停在
   * 「登录后点「重新获取」即可向哔咔拉取账号资料。」，用户看到的是「登录成功却没有资料」。
   */
  function ensureProfileLoaded() {
    if (!state.account) return;
    if (state.profile || state.profileLoading) return;
    loadProfile();
  }

  function renderAccount(errorText) {
    if (!accountGrid) return;
    accountGrid.textContent = '';
    if (state.accountLoading) { accountGrid.appendChild(loadingBox('正在读取登录状态…')); return; }
    if (errorText) {
      accountGrid.appendChild(errorBox('登录状态读取失败', errorText, loadAccount));
      accountGrid.appendChild(renderLoginForm());
      return;
    }
    if (!state.account) {
      accountStatus.textContent = '未登录：登录后可同步收藏夹与账号资料';
      accountGrid.appendChild(renderLoginForm());
      return;
    }
    accountStatus.textContent = '已登录' + (state.remembered && state.remembered.length ? ' · 已记住 ' + state.remembered.length + ' 个账号' : '');
    accountGrid.appendChild(renderProfileCard());
    accountGrid.appendChild(renderProfileSection());
  }

  function fieldRow(label, node) {
    return el('div', { class: 'col gap-4 mv-dl-field' }, [el('div', { class: 'label', text: label }), node]);
  }

  function renderLoginForm() {
    const hint = state.remembered && state.remembered.length
      ? '也可以直接使用已记住的账号：' + state.remembered.join('、')
      : '账号信息只用于登录哔咔，保存在本机数据目录，不会上传到别处。';
    const emailInput = el('input', {
      class: 'input', type: 'text', autocomplete: 'username', placeholder: '哔咔邮箱 / 用户名', value: textOf(state.loginEmail)
    });
    const passInput = el('input', {
      class: 'input', type: 'password', autocomplete: 'current-password', placeholder: '哔咔密码'
    });
    const submitBtn = el('button', { class: 'btn btn-primary', disabled: state.loggingIn }, [ctx.icon('user'), el('span', { text: state.loggingIn ? '登录中…' : '登录' })]);
    const form = el('form', { class: 'card card-pad mv-dl-login', on: { submit: function (e) { if (e && e.preventDefault) e.preventDefault(); doLogin(); } } }, [
      el('div', { class: 'section-title', text: '登录哔咔账号' }),
      el('div', { class: 'mv-dl-login-grid' }, [
        fieldRow('邮箱 / 用户名', emailInput),
        fieldRow('密码', passInput)
      ]),
      el('div', { class: 'row gap-8 center wrap mv-dl-login-act' }, [
        submitBtn,
        el('span', { class: 'small muted grow', text: hint })
      ])
    ]);

    async function doLogin() {
      if (state.loggingIn) return;
      const email = emailInput.value.trim();
      const password = passInput.value;
      if (!email) { ctx.toast('请输入邮箱 / 用户名', 'warn'); emailInput.focus(); return; }
      if (!password) { ctx.toast('请输入密码', 'warn'); passInput.focus(); return; }
      state.loginEmail = email;
      state.loggingIn = true;
      submitBtn.disabled = true;
      submitBtn.textContent = '';
      submitBtn.appendChild(ctx.icon('user'));
      submitBtn.appendChild(el('span', { text: '登录中…' }));
      try {
        const r = await ctx.post('/api/download/login', { email: email, password: password });
        passInput.value = '';
        state.loginPassword = '';
        state.account = (r && r.account) || state.account || null;
        state.profile = null;
        state.profileError = '';
        ctx.toast(textOf(r && r.message) || '登录成功', 'ok');
        renderAccount('');
        refreshInfo();
        loadProfile();
      } catch (err) {
        const message = errorMessage(err, '登录失败');
        ctx.toast('登录失败：' + message, 'err');
        accountStatus.textContent = '登录失败：' + message;
        renderAccount('');
        accountStatus.textContent = '登录失败：' + message;
      } finally {
        state.loggingIn = false;
        submitBtn.disabled = false;
      }
    }

    return form;
  }

  function renderProfileSection() {
    const wrap = el('div', { class: 'col gap-10' }, [
      el('div', { class: 'row between gap-10 wrap' }, [
        el('div', { class: 'section-title', text: '账号资料' }),
        el('button', { class: 'btn btn-sm btn-ghost', on: { click: loadProfile } }, [ctx.icon('refresh'), el('span', { text: '重新获取' })])
      ])
    ]);
    if (state.profileLoading) wrap.appendChild(loadingBox('正在获取账号资料…'));
    else if (state.profileError) wrap.appendChild(errorBox('资料获取失败', state.profileError, loadProfile));
    else if (state.profile) wrap.appendChild(renderProfileDetail(state.profile));
    else wrap.appendChild(el('div', { class: 'small muted', text: '登录后点「重新获取」即可向哔咔拉取账号资料。' }));
    return wrap;
  }

  function avatarNode(profile) {
    const name = textOf(profile && (profile.name || profile.email));
    const url = textOf(profile && profile.avatar);
    const box = el('div', { class: 'mv-dl-avatar' });
    // 同一坑：头像地址同样是站内绝对路径 /api/download/cover?path=...（没有字面 '//'），
    // 用 indexOf('//') 判断会让头像永远是首字占位块。统一走 isCoverUrl。
    if (isCoverUrl(url)) {
      const img = el('img', { class: 'mv-dl-avatar-img', src: url, alt: name || '头像' });
      img.addEventListener('error', function () { img.remove(); box.appendChild(avatarFallback(name)); });
      box.appendChild(img);
    } else {
      box.appendChild(avatarFallback(name));
    }
    return box;
  }

  function avatarFallback(name) {
    return el('div', { class: 'mv-dl-avatar-fallback', text: String(name || '漫').slice(0, 1) });
  }

  /** 账号资料卡：头像 + 昵称 + 等级 / 经验（头像地址由后端 profile.avatar 给）。 */
  function renderProfileCard() {
    const profile = state.profile || state.account || {};
    const displayName = textOf(profile.name) || '（未返回昵称）';
    const level = Number(profile.level || 0);
    const exp = Number(profile.exp || 0);
    const expMax = Math.max(100, exp);
    return el('div', { class: 'card card-pad mv-dl-profile' }, [
      el('div', { class: 'row gap-14 wrap' }, [
        avatarNode(profile),
        el('div', { class: 'col gap-6 grow', style: { minWidth: '220px' } }, [
          el('div', { class: 'row gap-8 center wrap' }, [
            el('div', { class: 'mv-dl-profile-name', text: displayName }),
            el('span', { class: 'badge badge-accent', text: 'Lv ' + level }),
            profile.role ? el('span', { class: 'badge', text: '角色 ' + textOf(profile.role) }) : null,
            profile.id ? el('span', { class: 'badge', text: 'ID ' + textOf(profile.id) }) : null
          ]),
          profile.email ? el('div', { class: 'small muted', text: '邮箱：' + textOf(profile.email) }) : null,
          el('div', { class: 'col gap-4' }, [
            el('div', { class: 'row between gap-8 small muted' }, [
              el('span', { text: '经验值' }),
              el('span', { class: 'mono', text: String(exp) })
            ]),
            el('div', { class: 'progress' }, [el('i', { style: { width: ctx.fmt.pct(exp, expMax) + '%' } })]),
            el('div', { class: 'small muted', text: '经验进度按当前经验估算，仅供参考' })
          ])
        ]),
        el('div', { class: 'row gap-6 wrap' }, [
          el('button', { class: 'btn btn-sm btn-ghost', on: { click: loadProfile } }, [ctx.icon('refresh'), el('span', { text: '刷新资料' })]),
          el('button', { class: 'btn btn-sm btn-danger', on: { click: doLogout } }, [ctx.icon('power'), el('span', { text: '退出登录' })])
        ])
      ])
    ]);
  }

  /** 契约字段表：有值才显示，字段缺失显示「未返回」。 */
  function renderProfileDetail(profile) {
    const rows = [
      ['昵称', textOf(profile.name)],
      ['邮箱', textOf(profile.email)],
      ['用户 ID', textOf(profile.id)],
      ['等级', profile.level === undefined ? '' : String(profile.level)],
      ['经验值', profile.exp === undefined ? '' : String(profile.exp)],
      /* 哔咔不返回 role（实测缺字段），但会返回 title（头衔，例如「萌新」）与 verified。
         把有值的那个显示出来，比一律显示「未返回」有用。 */
      ['头衔', textOf(profile.title) || textOf(profile.role)],
      ['认证', profile.verified ? '已认证' : '未认证']
    ];
    const list = el('div', { class: 'ledger mv-dl-ledger' });
    for (const r of rows) {
      list.appendChild(el('div', { class: 'ledger-row' }, [
        el('span', { class: 'k', text: r[0] }),
        el('span', { class: 'd' }),
        el('span', { class: 'v', text: r[1] || '未返回' })
      ]));
    }
    return list;
  }

  async function loadProfile() {
    if (!state.account) return;
    state.profileLoading = true;
    state.profileError = '';
    renderAccount('');
    try {
      const r = await api('/api/download/profile');
      state.profile = (r && r.profile) || null;
      state.profileError = '';
      if (!state.profile) ctx.toast('接口没有返回 profile 字段', 'warn');
    } catch (err) {
      if (isAuthError(err)) {
        state.account = null;
        state.profile = null;
        state.profileError = '';
        const message = errorMessage(err, '登录已过期，请重新登录');
        ctx.toast(message, 'warn');
        renderAccount('');
        accountStatus.textContent = '登录已过期：' + message;
        return;
      }
      const message = errorMessage(err, '账号资料获取失败');
      state.profileError = message;
      ctx.toast('账号资料获取失败：' + message, 'err');
    } finally {
      /* 必须先清 profileLoading 再渲染，否则面板会一直停在「正在获取账号资料…」。
         与 loadAccount() 的收尾方式一致；这里曾被改成 if (false) + 空 try/finally 的调试版，
         结果错误分支整个失效（异常直接冒泡），已恢复。 */
      state.profileLoading = false;
      renderAccount('');
    }
  }

  async function doLogout() {
    const ok = await ctx.confirm('退出登录后收藏夹与账号资料将不可用，已下载的文件不受影响。', { title: '退出登录', okText: '退出登录' });
    if (!ok) return;
    try {
      const r = await ctx.post('/api/download/logout', {});
      ctx.toast(textOf(r && r.message) || '已退出登录', 'ok');
    } catch (err) {
      ctx.toast('退出登录失败：' + err.message, 'err');
      return;
    }
    state.account = null;
    state.profile = null;
    state.profileError = '';
    state.remembered = [];
    state.loginEmail = '';
    state.loginPassword = '';
    renderAccount('');
    refreshInfo();
  }

  /* ---------------- 详情弹窗（章节多选） ---------------- */
  async function openComic(item) {
    const body = el('div', { class: 'col gap-12' });
    const m = ctx.modal({ title: item.title || '漫画详情', wide: true, body: body, foot: [] });
    body.appendChild(el('div', { class: 'row center gap-10' }, [el('div', { class: 'spinner' }), el('span', { class: 'small', text: '正在获取详情与章节…' })]));
    let detail = null;
    try {
      detail = await api('/api/download/comic/' + encodeURIComponent(item.id) + '?title=' + encodeURIComponent(item.title || ''));
    } catch (err) {
      body.textContent = '';
      body.appendChild(el('div', { class: 'alert alert-err' }, [el('div', { class: 'col gap-6' }, [
        el('div', { style: { fontWeight: '650' }, text: '详情获取失败' }),
        el('div', { class: 'small', text: err.message })
      ])]));
      ctx.toast('详情获取失败：' + err.message, 'err');
      return;
    }
    const comic = detail.comic || {};
    const chapters = detail.chapters || [];
    body.textContent = '';

    body.appendChild(el('div', { class: 'row gap-14', style: { alignItems: 'flex-start' } }, [
      el('div', { style: { width: '160px', flex: 'none', borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--line)' } }, [coverNode(item.title, comic.cover || item.cover)]),
      el('div', { class: 'col gap-6 grow', style: { minWidth: 0 } }, [
        el('div', { class: 'row wrap gap-6' }, [
          el('span', { class: 'badge badge-accent', text: chapters.length + ' 章' }),
          el('span', { class: 'badge', text: ctx.fmt.num(comic.likesCount || 0) + ' 赞' }),
          el('span', { class: 'badge', text: '浏览 ' + ctx.fmt.num(comic.viewsCount || 0) }),
          comic.finished ? el('span', { class: 'badge badge-ok', text: '已完结' }) : el('span', { class: 'badge badge-warn', text: '连载中' }),
          comic.inLibrary ? el('span', { class: 'badge badge-ok', text: '已在库' }) : null
        ]),
        el('div', { class: 'small', text: '作者：' + (comic.author || '未知') + (comic.chineseTeam ? '　汉化：' + comic.chineseTeam : '') }),
        el('div', { class: 'small muted', style: { wordBreak: 'break-all' }, text: '落盘目录：' + (comic.localDir || '(尚未下载)') }),
        el('div', { class: 'row wrap gap-6' }, (comic.tags || []).concat(comic.categories || []).slice(0, 14).map(function (t) { return el('span', { class: 'tag', text: t }); })),
        comic.description ? el('div', { class: 'small muted', style: { maxHeight: '80px', overflow: 'auto', whiteSpace: 'pre-wrap' }, text: comic.description }) : null
      ])
    ]));

    const selected = {};
    for (const ch of chapters) selected[ch.order] = !ch.downloaded;

    const listWrap = el('div', { class: 'col gap-6 mv-dl-chapters' });
    const counter = el('span', { class: 'small muted', text: '' });

    function updateCounter() {
      const n = Object.keys(selected).filter(function (k) { return selected[k]; }).length;
      counter.textContent = '已选 ' + n + ' / ' + chapters.length + ' 章';
    }

    for (const ch of chapters) {
      const cb = el('input', { class: 'mv-dl-cb', type: 'checkbox', checked: Boolean(selected[ch.order]) });
      cb.addEventListener('change', function () { selected[ch.order] = cb.checked; updateCounter(); });
      const badge = ch.complete
        ? el('span', { class: 'badge badge-ok', text: '已存在' })
        : (ch.downloaded ? el('span', { class: 'badge badge-warn', text: '不完整 ' + ch.images + ' 张' }) : el('span', { class: 'badge', text: '未下载' }));
      listWrap.appendChild(el('div', { class: 'row between gap-10 mv-dl-chapter' }, [
        el('div', { class: 'row gap-8 grow', style: { minWidth: 0 } }, [
          cb,
          el('span', { class: 'muted small', style: { minWidth: '56px' }, text: '第 ' + ch.order + ' 话' }),
          el('span', { class: 'ellipsis', text: ch.chapterTitle })
        ]),
        badge
      ]));
    }
    updateCounter();

    function refreshBoxes() {
      const boxes = listWrap.querySelectorAll('input.mv-dl-cb');
      chapters.forEach(function (ch, i) { if (boxes[i]) boxes[i].checked = Boolean(selected[ch.order]); });
      updateCounter();
    }

    const missingBtn = el('button', { class: 'btn btn-sm btn-ghost', on: { click: function () { for (const ch of chapters) selected[ch.order] = !ch.complete; refreshBoxes(); } } }, [el('span', { text: '只选缺的' })]);
    const allBtn = el('button', { class: 'btn btn-sm btn-ghost', on: { click: function () { for (const ch of chapters) selected[ch.order] = true; refreshBoxes(); } } }, [el('span', { text: '全选' })]);
    const noneBtn = el('button', { class: 'btn btn-sm btn-ghost', on: { click: function () { for (const ch of chapters) selected[ch.order] = false; refreshBoxes(); } } }, [el('span', { text: '全不选' })]);

    body.appendChild(el('div', { class: 'row between gap-10 wrap' }, [
      el('div', { class: 'section-title', text: '选择章节（本地已存在的默认不勾选）' }),
      el('div', { class: 'row gap-6' }, [missingBtn, allBtn, noneBtn])
    ]));
    body.appendChild(listWrap);
    body.appendChild(counter);

    const foot = m.el.querySelector('.modal-foot') || el('div', { class: 'modal-foot' });
    const addBtn = el('button', { class: 'btn btn-primary', on: { click: onSubmit } }, [ctx.icon('download'), el('span', { text: '加入下载队列' })]);
    foot.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', on: { click: function () { m.close(); } } }));
    foot.appendChild(el('div', { class: 'grow' }));
    foot.appendChild(addBtn);

    async function onSubmit() {
      const picked = chapters.filter(function (ch) { return selected[ch.order]; }).map(function (ch) { return ch.order; });
      if (!picked.length) { ctx.toast('请至少选择一个章节', 'warn'); return; }
      addBtn.disabled = true;
      try {
        const r = await ctx.post('/api/download/tasks', { comicId: item.id, title: item.title, chapters: picked });
        m.close();
        if (r.reused) ctx.toast(r.message || '已复用已有任务', 'info');
        else ctx.toast('已加入下载队列：' + ((r.task && r.task.title) || item.title), 'ok');
        switchTab('tasks');
      } catch (err) {
        ctx.toast('加入队列失败：' + err.message, 'err');
      } finally {
        addBtn.disabled = false;
      }
    }
  }

  /* ---------------- 下载任务 ---------------- */
  const taskStats = el('div', { class: 'stat-row card', style: { marginBottom: '4px' } });
  const taskList = el('div', { class: 'col gap-10' });
  const taskBar = el('div', { class: 'toolbar' });

  function buildTaskPanel() {
    taskPanel.textContent = '';
    taskBar.textContent = '';
    taskBar.appendChild(el('div', { class: 'section-title grow', text: '下载任务' }));
    taskBar.appendChild(el('span', { class: 'small muted', id: 'mvDlSse', text: '实时连接：连接中…' }));
    taskBar.appendChild(el('button', { class: 'btn btn-sm btn-ghost', on: { click: loadTasks } }, [ctx.icon('refresh'), el('span', { text: '刷新' })]));
    taskPanel.appendChild(taskBar);
    taskPanel.appendChild(taskStats);
    taskPanel.appendChild(taskList);
  }

  async function loadTasks() {
    try {
      const r = await api('/api/download/tasks');
      state.tasks = r.tasks || [];
      state.stats = r.stats || null;
      renderTasks();
      updateTabBadge();
    } catch (err) {
      taskList.textContent = '';
      taskList.appendChild(errorBox('任务列表加载失败', errorMessage(err, '任务列表加载失败'), loadTasks));
      ctx.toast('任务列表加载失败：' + err.message, 'err');
    }
  }

  function updateTabBadge() {
    const active = state.tasks.filter(function (t) { return t.state === 'running' || t.state === 'queued'; }).length;
    if (taskChip.__badge) taskChip.__badge.textContent = active ? String(active) : (state.tasks.length ? String(state.tasks.length) : '');
  }

  function renderTasks() {
    taskList.textContent = '';
    const s = state.stats || {};
    taskStats.textContent = '';
    const cells = [
      { v: s.total || 0, l: '任务总数' },
      { v: s.running || 0, l: '下载中' },
      { v: s.queued || 0, l: '排队中' },
      { v: s.done || 0, l: '已完成' },
      { v: (s.error || 0) + (s.paused || 0), l: '需处理' }
    ];
    for (const c of cells) {
      taskStats.appendChild(el('div', { class: 'card stat' }, [
        el('div', { class: 'stat-value', text: String(c.v) }),
        el('div', { class: 'stat-label', text: c.l })
      ]));
    }
    if (!state.tasks.length) {
      taskList.appendChild(ctx.empty('还没有下载任务', '到「搜索入库」里搜一本漫画开始下载'));
      return;
    }
    for (const t of state.tasks) taskList.appendChild(taskCard(t));
  }

  function taskCard(t) {
    const bar = el('i', { class: 'progress-bar', style: { width: Math.max(0, Math.min(100, t.percent || 0)) + '%' } });
    const canPause = t.state === 'running' || t.state === 'queued';
    const canResume = t.state === 'paused' || t.state === 'error' || t.state === 'canceled';
    const canCancel = t.state === 'running' || t.state === 'queued' || t.state === 'paused';
    return el('div', { class: 'card card-pad mv-dl-task', dataset: { id: t.id } }, [
      el('div', { class: 'row between gap-12 wrap' }, [
        el('div', { class: 'col gap-4 grow', style: { minWidth: '220px' } }, [
          el('div', { class: 'row gap-8 center' }, [
            el('div', { style: { fontWeight: '650' }, text: t.title || t.comicId }),
            el('span', { class: STATE_BADGE[t.state] || 'badge', text: STATE_TEXT[t.state] || t.state })
          ]),
          el('div', { class: 'small muted ellipsis mv-dl-taskline', text: taskLine(t) })
        ]),
        el('div', { class: 'row gap-6 wrap' }, [
          t.state === 'running' ? el('span', { class: 'badge', text: ctx.fmt.bytes(t.speed || 0) + '/s' }) : null,
          t.state === 'running' && t.etaMs ? el('span', { class: 'badge', text: '剩余约 ' + ctx.fmt.dur(t.etaMs) }) : null,
          el('span', { class: 'badge', text: ctx.fmt.bytes(t.bytes || 0) })
        ]),
        el('div', { class: 'row gap-6' }, [
          canPause ? el('button', { class: 'btn btn-sm', title: '暂停', on: { click: function () { taskAction(t.id, 'pause'); } } }, [ctx.icon('minimize'), el('span', { text: '暂停' })]) : null,
          canResume ? el('button', { class: 'btn btn-sm btn-primary', title: '继续（断点续传）', on: { click: function () { taskAction(t.id, 'resume'); } } }, [ctx.icon('play'), el('span', { text: '继续' })]) : null,
          canCancel ? el('button', { class: 'btn btn-sm btn-ghost', title: '取消', on: { click: function () { taskAction(t.id, 'cancel'); } } }, [ctx.icon('x'), el('span', { text: '取消' })]) : null,
          el('button', { class: 'btn btn-sm btn-ghost', title: '打开目录', on: { click: function () { openTaskFolder(t.id); } } }, [ctx.icon('folder')]),
          el('button', { class: 'btn btn-sm btn-ghost btn-danger', title: '删除任务', on: { click: function () { removeTask(t); } } }, [ctx.icon('trash')])
        ])
      ]),
      el('div', { class: 'progress progress-track', style: { marginTop: '10px' } }, [bar]),
      el('div', { class: 'row between gap-10 small muted', style: { marginTop: '6px' } }, [
        el('span', { text: (t.percent || 0) + '%' }),
        el('span', { class: 'ellipsis', text: t.dir || '' })
      ]),
      t.error ? el('div', { class: 'alert alert-err', style: { marginTop: '8px' } }, [el('span', { class: 'small', text: t.error })]) : null,
      t.logs && t.logs.length ? el('details', { class: 'mv-dl-logs' }, [
        el('summary', { class: 'small muted', text: '任务日志（' + t.logs.length + '）' }),
        el('div', { class: 'col gap-2 small mono muted', style: { maxHeight: '140px', overflow: 'auto', marginTop: '4px' } }, t.logs.slice(-12).map(function (l) {
          return el('div', { text: '[' + (l.level || 'info') + '] ' + (l.message || '') });
        }))
      ]) : null
    ]);
  }

  function taskLine(t) {
    return (t.author ? '作者：' + t.author + '　' : '')
      + '章节 ' + (t.finishedChapters || 0) + '/' + (t.chapterCount || 0)
      + '　图片 ' + (t.done || 0) + '/' + (t.total || 0)
      + (t.failed ? '　失败 ' + t.failed : '');
  }

  async function taskAction(id, action) {
    if (state.busy[id]) return;
    state.busy[id] = true;
    try {
      const r = await ctx.post('/api/download/tasks/' + encodeURIComponent(id) + '/' + action, {});
      ctx.toast(r.message || '操作成功', 'ok');
      await loadTasks();
      refreshInfo();
    } catch (err) {
      const label = action === 'pause' ? '暂停' : (action === 'resume' ? '继续' : '取消');
      ctx.toast(label + '失败：' + err.message, 'err');
    } finally {
      state.busy[id] = false;
    }
  }

  async function removeTask(t) {
    const ok = await ctx.confirm('删除任务「' + (t.title || t.id) + '」？\n已下载到磁盘的图片不会被删除。', { title: '删除任务', okText: '删除' });
    if (!ok) return;
    try {
      await api('/api/download/tasks/' + encodeURIComponent(t.id), { method: 'DELETE' });
      ctx.toast('任务已删除', 'ok');
      await loadTasks();
    } catch (err) {
      ctx.toast('删除失败：' + err.message, 'err');
    }
  }

  async function openTaskFolder(id) {
    try {
      const r = await ctx.post('/api/download/open-folder', { taskId: id });
      ctx.toast(r.message || '已打开目录', 'ok');
    } catch (err) {
      ctx.toast('打开目录失败：' + err.message, 'err');
    }
  }

  /** SSE 进度：只更新对应卡片，不整页重绘。 */
  function applyProgress(data) {
    if (!data || !data.taskId) return;
    const known = state.tasks.filter(function (t) { return t.id === data.taskId; })[0];
    if (!known) {
      state.tasks.unshift(data);
      renderTasks();
      return;
    }
    Object.assign(known, data);
    const node = taskList.querySelector('.mv-dl-task[data-id="' + data.taskId + '"]');
    if (!node) { renderTasks(); return; }
    const bar = node.querySelector('.progress-bar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, data.percent || 0)) + '%';
    const line = node.querySelector('.mv-dl-taskline');
    if (line) line.textContent = taskLine(data);
    updateTabBadge();
  }

  function setSseLabel(ok) {
    state.sseOk = ok;
    const node = taskBar.querySelector('#mvDlSse');
    if (node) node.textContent = ok ? '实时连接：已连接' : '实时连接：已断开（可点刷新）';
  }

  /* ---------------- SSE：账号事件同步登录态 ---------------- */
  function onAccountEvent(data) {
    if (!data || !data.status) return;
    if (data.status === 'loginfo' || data.status === 'login') {
      state.account = data.account || state.account;
      renderAccount('');
      refreshInfo();
      /* 账号状态变了就确保资料跟上，否则「我的」会停在未拉取资料的提示上。 */
      ensureProfileLoaded();
    } else if (data.status === 'logout' || data.status === 'expired') {
      state.account = null;
      state.profile = null;
      state.profileError = '';
      renderAccount('');
      refreshInfo();
    }
  }

  /* ---------------- 初始化 ---------------- */
  buildSearchPanel();
  buildFavoritesPanel();
  buildLeaderboardPanel();
  buildAccountPanel();
  buildTaskPanel();
  await refreshInfo();
  renderAccount('');
  switchTab(state.tab);
  loadTasks();

  ctx.sse('/api/download/events', {
    onEvent: function (event, data) {
      if (event === 'state' && data && data.tasks) {
        setSseLabel(true);
        state.tasks = data.tasks;
        state.stats = data.stats || state.stats;
        renderTasks();
        updateTabBadge();
        return;
      }
      if (event === 'progress') { setSseLabel(true); applyProgress(data); return; }
      if (event === 'account') { setSseLabel(true); onAccountEvent(data); return; }
      if (event === 'done') {
        setSseLabel(true);
        ctx.toast('下载完成：' + ((data && data.title) || ''), 'ok');
        loadTasks();
        return;
      }
      if (event === 'error') {
        setSseLabel(true);
        if (data && data.message) ctx.toast('下载出错：' + data.message, 'err');
        loadTasks();
      }
    },
    onError: function () { setSseLabel(false); }
  });

  // 兜底轮询：SSE 断开时仍有刷新
  const timer = setInterval(function () { if (!state.sseOk) loadTasks(); }, 15000);
  ctx.registerCleanup(function () { clearInterval(timer); });
}

export function unmount() {}

/** 按需注入本模块样式（外壳只加载了 theme.css，模块 CSS 由模块自己挂）。 */
function ensureStyles() {
  if (document.getElementById('mv-dl-style')) return;
  const link = document.createElement('link');
  link.id = 'mv-dl-style';
  link.rel = 'stylesheet';
  link.href = '/modules/download.css';
  document.head.appendChild(link);
}
