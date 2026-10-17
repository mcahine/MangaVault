/* ===========================================================
   漫库 MangaVault · 下载模块前端（装配层）
   五个页签：搜索入库 / 收藏夹 / 排行榜 / 我的 / 下载任务；实时进度走 SSE。
   页签实现分别在 download-panel-*.mjs，公共件在 download-share.mjs；
   本文件只负责：骨架 DOM、页签切换、SSE 订阅与生命周期。
   只使用 theme.css 已有类 + mv- 前缀自定义类。
   =========================================================== */
import { makeDownloadShare } from './download-share.mjs';
import { makeSearchPanel } from './download-panel-search.mjs';
import { makeFavoritesPanel } from './download-panel-favorites.mjs';
import { makeRankPanel } from './download-panel-rank.mjs';
import { makeAccountPanel } from './download-panel-account.mjs';
import { makeTaskPanel } from './download-panel-tasks.mjs';

export const meta = { id: 'download', name: '下载', order: 30 };

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
  /* 每个面板都带 mv-dl-panel：切换页签只是给它加 .hidden，卡片仍然留在 DOM 里。
     断言卡片数量时必须写 `.mv-dl-panel:not(.hidden) .comic-card`，
     否则数到的是隐藏面板里的卡片 —— 曾经让「排行榜渲染出卡片」假绿。 */
  const rootCard = el('div', { class: 'card card-pad mv-dl-root' });
  const tokenWarn = el('div', { class: 'alert alert-warn hidden' }, [
    el('div', { class: 'col gap-6' }, [
      el('div', { style: { fontWeight: '650' }, text: '未配置哔咔 token' }),
      el('div', { class: 'small', text: '搜索与下载都需要 token。请到左侧「设置」页填写哔咔 token 后再回来。' })
    ])
  ]);


  /* 每个面板都带 mv-dl-panel：切换页签只是给它加 .hidden，卡片仍然留在 DOM 里。
     断言卡片数量时必须写 `.mv-dl-panel:not(.hidden) .comic-card`，
     否则数到的是隐藏面板里的卡片 —— 曾经让「排行榜渲染出卡片」假绿。 */
  const tabChips = el('div', { class: 'row gap-6 mv-dl-tabs' });
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

  /* ---------------- 页签装配 ---------------- */
  /* 装配顺序有讲究：公共件里的 makeComicBoard/comicCard 要向各页签要内容，
     所以先建 share（openComic 用延迟钩子在调用时才取），再建各页签。 */
  const shareDeps = { el: el, api: api };
  const share = makeDownloadShare(ctx, state, shareDeps);
  const searchTab = makeSearchPanel(ctx, state, { el: el, api: api, switchTab: switchTab, s: share, panel: searchPanel });
  const favTab = makeFavoritesPanel(ctx, state, { el: el, api: api, s: share, panel: favoritesPanel });
  const rankTab = makeRankPanel(ctx, state, { el: el, api: api, s: share, panel: leaderboardPanel });
  const accountTab = makeAccountPanel(ctx, state, { el: el, api: api, refreshInfo: function () { return refreshInfo(); }, s: share, panel: accountPanel });
  const taskTab = makeTaskPanel(ctx, state, {
    el: el, api: api, refreshInfo: function () { return refreshInfo(); }, s: share, panel: taskPanel, chip: taskChip,
    renderAccount: accountTab.renderAccount, ensureProfileLoaded: accountTab.ensureProfileLoaded
  });
  shareDeps.openComic = searchTab.openComic;

  const makeComicBoard = share.makeComicBoard;
  const makeChipGroup = share.makeChipGroup;
  const textOf = share.textOf;
  const errorMessage = share.errorMessage;
  const isNotSupported = share.isNotSupported;
  const errorBox = share.errorBox;
  const loadingBox = share.loadingBox;
  const coverNode = share.coverNode;
  const comicCard = share.comicCard;
  const CARD_BATCH = share.CARD_BATCH;
  const RANK_LABELS = share.RANK_LABELS;
  const FAVORITE_SORTS = share.FAVORITE_SORTS;

  const buildSearchPanel = searchTab.buildSearchPanel;
  const doSearch = searchTab.doSearch;
  const renderResults = searchTab.renderResults;
  const openComic = searchTab.openComic;
  const buildFavoritesPanel = favTab.buildFavoritesPanel;
  const loadFavorites = favTab.loadFavorites;
  const buildLeaderboardPanel = rankTab.buildLeaderboardPanel;
  const loadLeaderboard = rankTab.loadLeaderboard;
  const buildAccountPanel = accountTab.buildAccountPanel;
  const loadAccountTab = accountTab.loadAccountTab;
  const ensureProfileLoaded = accountTab.ensureProfileLoaded;
  const renderAccount = accountTab.renderAccount;
  const buildTaskPanel = taskTab.buildTaskPanel;
  const loadTasks = taskTab.loadTasks;
  const renderTasks = taskTab.renderTasks;
  const applyProgress = taskTab.applyProgress;
  const setSseLabel = taskTab.setSseLabel;
  const onAccountEvent = taskTab.onAccountEvent;
  const updateTabBadge = taskTab.updateTabBadge;

  /* ---------------- 页签切换 ---------------- */
  /* onShow 由 switchTab 无参调用；不包一层的话 reset 是 undefined，
     而 loadFavorites 里 startPage = reset ? 1 : favoritesPage + 1，
     于是首次进页签直接从第 2 页开始拉 —— 必须显式传 reset=true。 */
  const TABS = [
    { id: 'search', chip: searchChip, panel: searchPanel, onShow: null },
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