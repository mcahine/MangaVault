/* 查重模块前端 · 候选复核面板（人在环）
   快速查重跑完后的「候选复核」区块：候选卡片列表 + 拉取候选。
   报告体原本在 mount() 闭包里，靠 ctx / st 工作；搬出来后由 makeCandPanel(ctx, st, deps)
   的参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。 */

export function makeCandPanel(ctx, st, deps) {
  /* 候选区块的三个容器由装配层（mount）建好后传进来。 */
  const candCount = deps.candCount;
  const candNote = deps.candNote;
  const candHost = deps.candHost;
  const candWrap = deps.candWrap;
  const renderCandItem = deps.renderCandItem;

  function renderCandidates(d) {
    candHost.textContent = '';
    const all = (d && Array.isArray(d.candidates)) ? d.candidates : [];
    // 后端已按「已删除」过滤（GET /api/dedupe/candidates），这里再兜底一次：
    // 候选读的是 scan-fast.json，删除只回写 scan-latest.json，两文件不同步时
    // 已删单元会残留在候选页里（用户看到的「删了还在」）。
    const items = all.filter(function (it) {
      const u = (it && it.unit) || {};
      const dv = (u.decision && u.decision.verdict) || (it && it.decision) || '';
      return dv !== 'deleted';
    });
    const hiddenDel = all.length - items.length;
    candCount.textContent = '共 ' + items.length + ' 个候选单元' + (hiddenDel > 0 ? '（已删除 ' + hiddenDel + ' 个不显示）' : '');
    const info = d && d.fastInfo;
    const bits = [];
    if (d && d.fastFile) bits.push('数据源 ' + d.fastFile);
    if (d && d.fastAt) bits.push('生成于 ' + ctx.fmt.date(d.fastAt));
    if (info) {
      bits.push('预筛 ' + (info['单元数'] || 0) + ' 个单元 -> ' + (info['有候选单元数'] || 0) + ' 个候选');
      bits.push(info['像素证据'] ? '像素证据可用' : '仅元数据（无像素证据）');
    }
    candNote.textContent = items.length ? bits.join(' · ') : '';
    if (items.length && d && d.fastDegraded) {
      ctx.toast('本轮快速查重降级：' + (d.fastDegradeReason || '像素证据不可用') + '，请以抽样图人工判定为准', 'warn', 8000);
    }
    if (!items.length) {
      candHost.appendChild(ctx.el('div', { class: 'empty' }, [
        ctx.icon('search'),
        ctx.el('div', { class: 'empty-title', text: '还没有候选' }),
        ctx.el('div', { class: 'small', text: d && d.fastAvailable === false ? '先点「快速查重」做元数据预筛（读 data/dedupe/scan-fast.json）' : '快速结果里没有候选单元，或文件还没生成' })
      ]));
      return;
    }
    for (const it of items) candHost.appendChild(renderCandItem(it));
  }

  async function loadCandidates() {
    candWrap.classList.remove('hidden');
    candHost.textContent = '';
    candHost.appendChild(ctx.el('div', { class: 'empty' }, [
      ctx.el('div', { class: 'spinner spinner-lg' }), ctx.el('div', { class: 'small', text: '正在读取候选…' })
    ]));
    try {
      const d = await ctx.get('/api/dedupe/candidates');
      st.candData = d;
      renderCandidates(d);
      return d;
    } catch (err) {
      candHost.textContent = '';
      candHost.appendChild(ctx.el('div', { class: 'alert alert-err' }, [
        ctx.icon('alert'),
        ctx.el('div', { class: 'col gap-6' }, [
          ctx.el('div', { style: { fontWeight: '650' }, text: '读取候选失败' }),
          ctx.el('div', { class: 'mono small', text: err.message })
        ])
      ]));
      ctx.toast('读取候选失败：' + err.message, 'err');
      return null;
    }
  }

  return {
    renderCandidates: renderCandidates,
    loadCandidates: loadCandidates
  };
}