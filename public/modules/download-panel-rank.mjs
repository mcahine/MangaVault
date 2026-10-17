/**
 * 排行榜页签：日 / 周 / 月榜切换 + 榜单卡片。
 *
 * 从 mount() 闭包里搬出来的代码：el / api / ctx / state 原本都是 mount 的同作用域变量，
 * 这里由参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeRankPanel(ctx, state, deps) {
  const el = deps.el;
  const api = deps.api;
  const { makeComicBoard, makeChipGroup, textOf, errorMessage, isNotSupported, CARD_BATCH, RANK_LABELS } = deps.s;

  /* 骨架容器由装配层传入：页签内容整体挂到 mount 建好的那个 div 上。 */
  const leaderboardPanel = deps.panel;

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

  return {
    buildLeaderboardPanel: buildLeaderboardPanel,
    loadLeaderboard: loadLeaderboard,
    setLeaderboardNotice: setLeaderboardNotice,
    rankLabelOf: rankLabelOf
  };
}
