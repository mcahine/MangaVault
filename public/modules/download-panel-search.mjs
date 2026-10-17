/**
 * 搜索入库页签：搜索框 / 结果网格 / 分页 / 章节详情弹窗。
 *
 * 从 mount() 闭包里搬出来的代码：el / api / ctx / state 原本都是 mount 的同作用域变量，
 * 这里由参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeSearchPanel(ctx, state, deps) {
  const el = deps.el;
  const api = deps.api;
  const { loadingBox, errorBox, comicCard, coverNode } = deps.s;
  const switchTab = deps.switchTab;

  /* 骨架容器由装配层传入：页签内容整体挂到 mount 建好的那个 div 上。 */
  const searchPanel = deps.panel;

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

  return {
    buildSearchPanel: buildSearchPanel,
    doSearch: doSearch,
    renderResults: renderResults,
    openComic: openComic,
    grid: grid,
    searchInput: searchInput,
    searchStatus: searchStatus,
    searchBtn: searchBtn,
    pager: pager
  };
}
