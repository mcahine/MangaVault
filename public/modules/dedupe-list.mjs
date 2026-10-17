/* 查重模块前端 · 列表与统计渲染
   统计卡、列表卡片、翻页、加载态。原本都在 mount() 闭包里，靠 ctx / st 与几个
   回调工作；搬出来后由 makeListPanel(ctx, st, deps) 的参数逐字提供，
   函数体一行未改（2 空格基准缩进保持不变）。 */

export function makeListPanel(ctx, st, deps) {
  /* 容器由装配层（mount）建好后传进来。 */
  const statRow = deps.statRow;
  const listHost = deps.listHost;
  const pager = deps.pager;
  /* 卡片上要回调「标记决策」与「逐张对照」，具体实现在数据层与弹窗层，这里只收函数。 */
  const decide = deps.decide;
  const openDetail = deps.openDetail;
  const load = deps.load;
  /* 公共件出口取别名，保持原函数体里的裸名字可用。 */
  const P = deps.parts;
  const DECISION_TEXT = P.DECISION_TEXT;
  const badgeOf = P.badgeOf;
  const unitLabel = P.unitLabel;
  const thumbUrl = P.thumbUrl;
  const decisionOf = P.decisionOf;
  const sideBox = P.sideBox;

  function statCard(label, value, sub) {
    return ctx.el('div', { class: 'card stat' }, [
      ctx.el('div', { class: 'stat-value', text: String(value) }),
      ctx.el('div', { class: 'stat-label', text: label }),
      sub ? ctx.el('div', { class: 'mv-stat-sub', text: sub }) : null
    ]);
  }

  function renderStats(s) {
    statRow.textContent = '';
    const stats = s || { units: 0, images: 0, byVerdict: {}, reclaimableBytes: 0, markedBytes: 0 };
    const bv = stats.byVerdict || {};
    statRow.appendChild(statCard('单元总数', ctx.fmt.num(stats.units || 0), '图片 ' + ctx.fmt.num(stats.images || 0) + ' 张'));
    statRow.appendChild(statCard('完全重复', ctx.fmt.num(bv['完全重复'] || 0), '字节完全一致'));
    statRow.appendChild(statCard('同图不同编码', ctx.fmt.num(bv['同图不同编码'] || 0), '像素一致编码不同'));
    statRow.appendChild(statCard('部分重复', ctx.fmt.num(bv['部分重复'] || 0), '命中率 ≥ 30%'));
    statRow.appendChild(statCard('未找到', ctx.fmt.num(bv['未找到'] || 0), '库内没有'));
    statRow.appendChild(statCard('可清理体积', ctx.fmt.bytes(stats.reclaimableBytes || 0), '待删除 ' + ctx.fmt.bytes(stats.markedBytes || 0)));
  }

  function renderCard(u) {
    const dec = decisionOf(u);
    const cls = 'card mv-card mv-decided' + (dec === 'keep' ? ' mv-decided-keep' : dec === 'delete' ? ' mv-decided-delete' : '');
    const card = ctx.el('div', { class: cls });
    const first = (u.samples || [])[0] || null;
    const libSample = (u.samples || []).find(function (s) { return s.lib; }) || null;
    const dupUrl = first ? thumbUrl(u.id, 'dup', first.dup) : '';
    const libUrl = u.libDir && libSample ? thumbUrl(u.id, 'lib', libSample.lib, false, libSample.root || u.libRootId) : '';
    card.appendChild(ctx.el('div', { class: 'mv-card-pair' }, [
      sideBox(dupUrl, '本单元'),
      sideBox(libUrl, u.comic ? '库内 · ' + u.comic : '库内')
    ]));
    card.appendChild(ctx.el('div', { class: 'mv-card-body' }, [
      ctx.el('div', { class: 'mv-card-title ellipsis', title: u.id, text: unitLabel(u) }),
      ctx.el('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, [
        ctx.el('span', { class: 'badge ' + badgeOf(u.judge), text: u.judge }),
        ctx.el('span', { class: 'badge' + (dec === 'pending' ? '' : ' badge-accent'), text: DECISION_TEXT[dec] })
      ]),
      ctx.el('div', { class: 'mv-card-meta' }, [
        ctx.el('span', { text: '命中 ' + (u.exactCount + u.pixelCount) + '/' + u.dupCount + ' 张' }),
        ctx.el('span', { text: ctx.fmt.bytes(u.dupBytes || 0) }),
        u.maxMad != null ? ctx.el('span', { text: '最大误差 ' + u.maxMad }) : null
      ]),
      u.chapterTitle ? ctx.el('div', { class: 'mv-card-meta ellipsis' }, [ctx.el('span', { text: '→ ' + u.chapterTitle })]) : null
    ]));
    const btnDetail = ctx.el('button', { class: 'btn btn-sm', text: '查看详情' });
    const btnDel = ctx.el('button', { class: 'btn btn-sm ' + (dec === 'delete' ? 'btn-danger' : 'btn-ghost'), text: '删除' });
    const btnKeep = ctx.el('button', { class: 'btn btn-sm ' + (dec === 'keep' ? 'btn-success' : 'btn-ghost'), text: '保留' });
    card.appendChild(ctx.el('div', { class: 'mv-card-actions' }, [btnDetail, btnDel, btnKeep]));
    ctx.on(card, 'click', function (e) { if (!e.target.closest('button')) openDetail(u); });
    ctx.on(btnDetail, 'click', function (e) { e.stopPropagation(); openDetail(u); });
    ctx.on(btnDel, 'click', function (e) { e.stopPropagation(); decide(u, 'delete'); });
    ctx.on(btnKeep, 'click', function (e) { e.stopPropagation(); decide(u, 'keep'); });
    return card;
  }

  function renderList(data) {
    listHost.textContent = '';
    if (data && data.degraded) {
      listHost.appendChild(ctx.el('div', { class: 'alert alert-warn' }, [
        ctx.icon('alert'),
        ctx.el('span', { text: '像素级能力不可用，当前只有 SHA-256 字节查重结果。原因：' + (data.degradeReason || '未知') })
      ]));
    }
    // 后端已按「已删除」过滤（GET /api/dedupe/units 默认排除），这里再兜底一次：
    // 万一拿到的是删除前的旧响应或旧扫描缓存，也不会去请求已经 404 的缩略图。
    const units = ((data && data.units) || []).filter(function (u) { return decisionOf(u) !== 'deleted'; });
    if (!units.length) {
      const hasScan = Boolean(data && data.scanAt);
      listHost.appendChild(ctx.el('div', { class: 'empty' }, [
        ctx.icon(hasScan ? 'search' : 'layers'),
        ctx.el('div', { class: 'empty-title', text: hasScan ? '没有符合筛选条件的单元' : '还没有扫描结果' }),
        ctx.el('div', { class: 'small', text: hasScan ? '试试切换判定筛选或清空关键字' : '点击「重新扫描」开始与漫画库比对' })
      ]));
      return;
    }
    const grid = ctx.el('div', { class: 'grid grid-cards' });
    for (const u of units) grid.appendChild(renderCard(u));
    listHost.appendChild(grid);
  }

  function renderPager(data) {
    pager.textContent = '';
    if (!data) return;
    pager.appendChild(ctx.el('div', { class: 'small muted', text: '共 ' + data.total + ' 个单元 · 第 ' + data.page + '/' + data.pages + ' 页' }));
    const prev = ctx.el('button', { class: 'btn btn-sm', text: '上一页' });
    const next = ctx.el('button', { class: 'btn btn-sm', text: '下一页' });
    prev.disabled = data.page <= 1;
    next.disabled = data.page >= data.pages;
    ctx.on(prev, 'click', function () { if (st.page > 1) { st.page--; load(); } });
    ctx.on(next, 'click', function () { if (st.page < data.pages) { st.page++; load(); } });
    pager.appendChild(ctx.el('div', { class: 'row', style: { gap: '8px' } }, [prev, next]));
  }

  function renderLoading() {
    listHost.textContent = '';
    listHost.appendChild(ctx.el('div', { class: 'empty' }, [
      ctx.el('div', { class: 'spinner spinner-lg' }), ctx.el('div', { class: 'small', text: '正在加载…' })
    ]));
  }

  return {
    renderStats: renderStats,
    renderCard: renderCard,
    renderList: renderList,
    renderPager: renderPager,
    renderLoading: renderLoading
  };
}