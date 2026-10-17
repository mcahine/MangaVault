/* 查重模块前端 · 决策与删除（人在环的落盘与执行）
   候选三选落盘、把决策同步进主列表、读取候选列表，以及「执行删除…」整条链路。
   原本都在 mount() 闭包里，靠 ctx / st 工作；搬出来后由 makeDecideFlow(ctx, st, deps)
   的参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。 */

export function makeDecideFlow(ctx, st, deps) {
  /* 渲染入口与共享件统一由装配层注入，避免这里再各自 import 一遍。 */
  const P = deps.parts;
  const renderStats = deps.renderStats;
  const renderList = deps.renderList;
  const renderPager = deps.renderPager;
  const renderCandidates = deps.cand.renderCandidates;
  const loadCandidates = deps.cand.loadCandidates;
  const load = deps.load;
  const candWrap = deps.candWrap;

  /* 人类可读标签在这两条链路上反复用，先取好别名（与原来的全局名一致）。 */
  const MODES = P.MODES;
  const CAND_STATE_TEXT = P.CAND_STATE_TEXT;
  const unitLabel = P.unitLabel;
  const decisionOf = P.decisionOf;

  /* 决策落盘是异步的。用户点完「确认重复（可删）」后**马上**点「执行删除…」时，
     弹窗会在决策还没落盘的情况下读候选数据，于是「下一步」按钮因为「当前页没有
     标记为待删除的单元」而禁用 —— 真浏览器验收实测复现（next=disabled）。
     这里保存挂起的落盘任务，openDelete 先 await 它，保证读到的永远是落盘之后的状态。 */
  let pendingDecision = null;

  /** 人工三选：复用现成 POST /api/dedupe/decision（参数形状不变：unitId + verdict）。 */
  async function decideCand(item, verdict) {
    const task = doDecide(item, verdict);
    pendingDecision = task;
    try {
      return await task;
    } finally {
      if (pendingDecision === task) pendingDecision = null;
    }
  }

  async function doDecide(item, verdict) {
    if (st.busy) return;
    const u = item.unit || {};
    st.busy = true;
    try {
      const note = verdict === 'delete' ? '人在环复核：确认重复（可删）'
        : verdict === 'keep' ? '人在环复核：不是重复'
          : '人在环复核：拿不准';
      const res = await ctx.post('/api/dedupe/decision', { unitId: u.id, verdict: verdict, note: note });
      item.decision = verdict;
      u.decision = Object.assign({}, u.decision, { verdict: verdict });
      /* 同步进主列表缓存：主列表（scan-latest）与候选页（scan-fast）是两份数据，
         不一起标注的话主列表卡片仍显示「未定」，用户会以为没生效。 */
      syncDecisionToMainList(u.id, verdict);
      if (res.stats) renderStats(res.stats);
      if (st.candData) renderCandidates(st.candData);
      ctx.toast('已标记「' + (CAND_STATE_TEXT[verdict] || verdict) + '」：' + unitLabel(u), verdict === 'delete' ? 'warn' : 'ok');
    } catch (err) {
      ctx.toast('决策保存失败：' + err.message, 'err');
    } finally {
      st.busy = false;
    }
  }

  /** 把决策同步进主列表缓存（st.data.units）中同 id 的单元。 */
  function syncDecisionToMainList(unitId, verdict) {
    if (!st.data || !Array.isArray(st.data.units)) return;
    const target = st.data.units.find(function (x) { return x.id === unitId; });
    if (!target) return; // 快速模式命中的单元可能不在完整扫描结果里，属正常
    target.decision = Object.assign({}, target.decision, { verdict: verdict });
    renderList(st.data);
    renderPager(st.data);
  }

  async function openDelete() {
    // 先等上一次决策真正落盘，否则会把「刚标记的那一个」漏掉（见 pendingDecision 注释）。
    if (pendingDecision) { try { await pendingDecision; } catch (e) { /* 失败已在 doDecide 里 toast */ } }
    /* 「待删除」要从**两处**收敛：完整扫描列表（st.data）与候选复核（st.candData）。
       候选复核读的是快速查重的 scan-fast.json，而「执行删除…」原来只从主列表取 ——
       用户很可能只跑过快速查重（十几秒），在候选页确认重复后打开删除弹窗只会看到
       「当前页没有标记为待删除的单元」且按钮禁用，**整条链路走不到删除**。
       这是真浏览器验收（scripts/dev/dedupe-cand-ui-check.mjs）抓到的真实断链。 */
    const byId = new Map();
    const units = (st.data && st.data.units) || [];
    for (const u of units) { if (decisionOf(u) === 'delete') byId.set(u.id, u); }
    const cands = (st.candData && st.candData.candidates) || [];
    for (const it of cands) {
      const cu = it.unit || {};
      const dv = it.decision || (cu.decision && cu.decision.verdict) || 'pending';
      if (dv !== 'delete' || !cu.id) continue;
      // 主列表里没有这个单元时补一条最小可用记录（删除只需要 id，列表只展示名字与体积）。
      if (!byId.has(cu.id)) byId.set(cu.id, { id: cu.id, name: cu.name || cu.id, dupBytes: cu.dupBytes || 0 });
    }
    const marked = Array.from(byId.values());
    const picked = new Set(marked.map(function (u) { return u.id; }));
    const mode = { id: 'recycle' };
    const rows = ctx.el('div', { class: 'mv-del-list' });
    const modeBox = ctx.el('div', { class: 'col gap-6' });

    for (const m of MODES) {
      const radio = ctx.el('input', { type: 'radio', name: 'mv-del-mode', value: m.id });
      radio.checked = m.id === 'recycle';
      ctx.on(radio, 'change', function () { if (radio.checked) mode.id = m.id; });
      modeBox.appendChild(ctx.el('label', { class: 'row', style: { gap: '8px', cursor: 'pointer' } }, [
        radio,
        ctx.el('div', { class: 'col' }, [
          ctx.el('div', { text: m.label + (m.id === 'recycle' ? '（默认）' : '') }),
          ctx.el('div', { class: 'small muted', text: m.hint })
        ])
      ]));
    }

    if (!marked.length) {
      rows.appendChild(ctx.el('div', { class: 'small muted', text: '当前页没有标记为「待删除」的单元。请先在卡片上点「删除」标记。' }));
    } else {
      for (const u of marked) {
        const cb = ctx.el('input', { type: 'checkbox' });
        cb.checked = true;
        ctx.on(cb, 'change', function () { if (cb.checked) picked.add(u.id); else picked.delete(u.id); });
        rows.appendChild(ctx.el('div', { class: 'mv-del-row' }, [cb, ctx.el('span', { class: 'grow', text: unitLabel(u) }), ctx.el('span', { class: 'muted small', text: ctx.fmt.bytes(u.dupBytes || 0) })]));
      }
    }

    const cancel = ctx.el('button', { class: 'btn btn-ghost', text: '取消' });
    const go = ctx.el('button', { class: 'btn btn-danger', text: '下一步：输入 DELETE' });
    go.disabled = !picked.size;
    const m = ctx.modal({
      title: '执行删除',
      body: ctx.el('div', { class: 'col gap-10' }, [
        ctx.el('div', { class: 'alert alert-err' }, [ctx.icon('alert'), ctx.el('span', { text: '删除会真实作用于磁盘，请确认单元内容后再继续。' })]),
        ctx.el('div', { class: 'section-title', text: '删除方式' }),
        modeBox,
        ctx.el('div', { class: 'section-title', text: '待删除单元（' + picked.size + '）' }),
        rows
      ]),
      foot: [cancel, go]
    });
    ctx.on(cancel, 'click', function () { m.close(); });
    ctx.on(go, 'click', function () {
      const ids = Array.from(picked);
      if (!ids.length) { ctx.toast('没有选择要删除的单元', 'warn'); return; }
      m.close();
      void submitDelete(ids, mode.id);
    });
  }

  async function submitDelete(unitIds, mode) {
    const typed = await ctx.prompt('将删除 ' + unitIds.length + ' 个单元（方式：' + mode + '）。请输入 DELETE 后按回车以确认：', '');
    if (typed === null) return;
    if (String(typed).trim().toUpperCase() !== 'DELETE') { ctx.toast('确认口令不正确，已取消删除', 'err'); return; }
    try {
      const res = await ctx.post('/api/dedupe/delete', { unitIds: unitIds, mode: mode, confirm: typed });
      const gap = res.succeeded - (res.removedFromScan || 0);
      if (res.failed) ctx.toast('删除完成：成功 ' + res.succeeded + ' 个，失败 ' + res.failed + ' 个', 'warn', 6000);
      else if (gap > 0) ctx.toast('已删除 ' + res.succeeded + ' 个单元，但列表只摘除 ' + res.removedFromScan + ' 个（回写扫描结果异常，请重扫）', 'warn', 8000);
      else ctx.toast('已删除 ' + res.succeeded + ' 个单元（' + res.mode + '）', 'ok', 6000);
      // 删除后必须重新拉列表：留在原来的页码上会看到「空的一页」，
      // 因为被删的单元已经从这一页消失了。回到第 1 页是最符合直觉的落点。
      st.page = 1;
      await load();
      // 候选面板开着时也要跟着刷新：它的数据源是 scan-fast.json，
      // 不重拉就会留着刚删掉的那张卡片，用户以为「删了还在」。
      if (!candWrap.classList.contains('hidden')) await loadCandidates();
    } catch (err) {
      ctx.toast('删除失败：' + err.message, 'err', 7000);
    }
  }

  return {
    decideCand: decideCand,
    doDecide: doDecide,
    openDelete: openDelete
  };
}