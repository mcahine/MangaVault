/* 查重模块前端 · 数据加载
   拉取单元列表，以及把单个人工决策写回后端。
   原本都在 mount() 闭包里，靠 ctx / st 与渲染入口工作；搬出来后由
   makeDataFlow(ctx, st, deps) 的参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。 */

export function makeDataFlow(ctx, st, deps) {
  /* 列表渲染入口与容器由装配层注入。 */
  const listHost = deps.listHost;
  const renderStats = deps.renderStats;
  const renderList = deps.renderList;
  const renderPager = deps.renderPager;
  const renderLoading = deps.renderLoading;
  const DECISION_TEXT = deps.parts.DECISION_TEXT;
  const unitLabel = deps.parts.unitLabel;

  async function load() {
    renderLoading();
    try {
      const qs = new URLSearchParams();
      qs.set('page', String(st.page));
      qs.set('size', String(st.size));
      if (st.verdict) qs.set('verdict', st.verdict);
      if (st.q) qs.set('q', st.q);
      if (st.decided) qs.set('decided', st.decided);
      const data = await ctx.get('/api/dedupe/units?' + qs.toString());
      st.data = data;
      renderStats(data.stats);
      renderList(data);
      renderPager(data);
    } catch (err) {
      listHost.textContent = '';
      listHost.appendChild(ctx.el('div', { class: 'alert alert-err' }, [
        ctx.icon('alert'),
        ctx.el('div', { class: 'col gap-6' }, [
          ctx.el('div', { style: { fontWeight: '650' }, text: '加载查重列表失败' }),
          ctx.el('div', { class: 'mono small', text: err.message })
        ])
      ]));
      ctx.toast('加载失败：' + err.message, 'err');
    }
  }

  async function decide(u, verdict) {
    if (st.busy) return;
    st.busy = true;
    try {
      const res = await ctx.post('/api/dedupe/decision', { unitId: u.id, verdict: verdict });
      u.decision = res.decision;
      if (res.stats) renderStats(res.stats);
      if (st.data) { renderList(st.data); renderPager(st.data); }
      ctx.toast('已标记「' + DECISION_TEXT[verdict] + '」：' + unitLabel(u), verdict === 'delete' ? 'warn' : 'ok');
    } catch (err) {
      ctx.toast('决策保存失败：' + err.message, 'err');
    } finally {
      st.busy = false;
    }
  }

  return {
    load: load,
    decide: decide
  };
}