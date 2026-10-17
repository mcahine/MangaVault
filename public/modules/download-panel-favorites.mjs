/**
 * 收藏夹页签：排序切换 / 分批加载 / 加载更多。
 *
 * 从 mount() 闭包里搬出来的代码：el / api / ctx / state 原本都是 mount 的同作用域变量，
 * 这里由参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeFavoritesPanel(ctx, state, deps) {
  const el = deps.el;
  const api = deps.api;
  const { makeComicBoard, makeChipGroup, errorMessage, errorBox, CARD_BATCH, FAVORITE_SORTS } = deps.s;

  /* 骨架容器由装配层传入：页签内容整体挂到 mount 建好的那个 div 上。 */
  const favoritesPanel = deps.panel;

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

  return {
    buildFavoritesPanel: buildFavoritesPanel,
    loadFavorites: loadFavorites,
    reloadFavoritesMore: reloadFavoritesMore
  };
}
