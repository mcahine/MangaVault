/**
 * 标签墙页签（标签云 + 批量加删标签）与单标签漫画清单。
 *
 * 从 mount() 闭包里搬出来的代码：el / ctx / S / host 原本都是 mount 的同作用域变量，
 * 这里由参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeTagsTabs(ctx, S, deps) {
  const el = deps.el;
  const host = deps.host;
  const { errBox, waiting, okBox, parseCsv, sigOf, refresh, reloadComicsQuiet, selectedIds, makePicker, colorOf, statCell, row } = deps.k;

  async function renderTags() {
    host.textContent = '';
    host.appendChild(waiting('正在统计标签与目录…'));
    let ts = null;
    try { ts = (await ctx.get('/api/vault/tags/stats')).stats; }
    catch (err) { host.textContent = ''; host.appendChild(errBox(err, renderTags)); return; }
    await reloadComicsQuiet();

    host.textContent = '';
    const tags = (ts && ts.tags) || [];

    /* 新建标签 */
    const search = el('input', { class: 'input', placeholder: '筛选标签名…', style: { maxWidth: '240px' } });
    const newName = el('input', { class: 'input', placeholder: '新标签名', style: { maxWidth: '170px' } });
    const newColor = el('select', { class: 'select', style: { width: '104px' } }, ['red', 'pink', 'blue', 'cyan', 'yellow'].map(function (c) { return el('option', { value: c, text: c }); }));
    const addBtn = el('button', { class: 'btn btn-primary btn-sm', on: { click: createTag } }, [ctx.icon('plus'), el('span', { text: '新建标签' })]);
    host.appendChild(el('div', { class: 'toolbar' }, [ctx.icon('tag'), search, el('div', { class: 'grow' }), newName, newColor, addBtn]));

    if (ts) {
      host.appendChild(el('div', { class: 'stat-row', style: { marginBottom: '14px' } }, [
        statCell(String(tags.length), '标签总数', 'var(--red)'),
        statCell(String(ts.usedCount || 0), '在用标签', 'var(--cyan)'),
        statCell(String(ts.unusedCount || 0), '未使用', 'var(--yellow)'),
        statCell(String(ts.derivedCount || 0), '自动派生', 'var(--pink)'),
        statCell(String(ts.manualCount || 0), '手动覆盖', 'var(--paper)')
      ]));
    }

    /* 标签云 */
    const cloud = el('div', { class: 'row wrap gap-6', style: { marginBottom: '18px', minHeight: '44px' } });
    const maxCount = tags.reduce(function (m, t) { return Math.max(m, t.count || 0); }, 1);
    const drawCloud = function (filter) {
      cloud.textContent = '';
      const list = tags.filter(function (t) { return !filter || t.name.toLowerCase().includes(filter); });
      if (!list.length) { cloud.appendChild(el('div', { class: 'small muted', text: '没有匹配的标签' })); return; }
      for (const t of list.slice(0, 260)) {
        const scale = 0.86 + (Math.min(t.count || 0, maxCount) / maxCount) * 0.5;
        cloud.appendChild(el('div', {
          class: 'chip', title: (t.count || 0) + ' 部 · 来源 ' + (t.sources || []).join('/') + '（点击反查）',
          style: { fontSize: Math.round(12 * scale) + 'px' },
          on: { click: function () { showTagComics(t.name); } }
        }, [
          el('span', { style: { color: colorOf(t.color), fontWeight: '700' }, text: t.name }),
          el('span', { class: 'muted', text: String(t.count || 0) })
        ]));
      }
    };
    drawCloud('');
    search.addEventListener('input', function () { drawCloud(search.value.trim().toLowerCase()); });
    host.appendChild(el('div', { class: 'section-title', text: '01 — 标签云 · 字号=漫画数，点击反查' }));
    host.appendChild(cloud);

    /* 漫画清单（多选） */
    const picker = makePicker({ hint: '勾选要一起打标签的漫画；选择在「批量元数据 / 跨库搬迁」之间共享。' });
    host.appendChild(el('div', { class: 'section-title', text: '02 — 勾选漫画' }));
    host.appendChild(picker.node);

    /* 批量标签编辑：预演 → 确认执行 */
    const addInput = el('input', { class: 'input', placeholder: '要添加的标签（逗号分隔）', style: { maxWidth: '260px' }, dataset: { act: 'tag-add-input' } });
    const removeInput = el('input', { class: 'input', placeholder: '要移除的标签（逗号分隔）', style: { maxWidth: '260px' }, dataset: { act: 'tag-remove-input' } });
    const out = el('div', { class: 'col gap-8', dataset: { act: 'tag-plan-out' } });

    host.appendChild(el('div', { class: 'section-title', text: '03 — 批量加 / 删标签（先预演）' }));
    host.appendChild(el('div', { class: 'toolbar' }, [
      ctx.icon('tag'), addInput, removeInput,
      el('button', { class: 'btn btn-sm', dataset: { act: 'tag-plan' }, on: { click: plan } }, [ctx.icon('eye'), el('span', { text: '预演（dryRun）' })]),
      el('button', { class: 'btn btn-sm btn-primary', dataset: { act: 'tag-apply' }, on: { click: function () { apply(false); } } }, [ctx.icon('check'), el('span', { text: '执行' })])
    ]));
    host.appendChild(out);

    function parts() {
      return { add: parseCsv(addInput.value).filter(function (x) { return x.indexOf('-') !== 0; }), remove: parseCsv(removeInput.value) };
    }
    function curSig() { return sigOf(selectedIds(), parts()); }

    async function plan() {
      if (!S.sel.size) { ctx.toast('请先勾选漫画', 'warn'); return false; }
      const p = parts();
      if (!p.add.length && !p.remove.length) { ctx.toast('请填写要添加或移除的标签（移除写在右边输入框）', 'warn'); return false; }
      out.textContent = '';
      out.appendChild(waiting('正在预演…'));
      try {
        const r = await ctx.post('/api/vault/tags/assign', { comicIds: selectedIds(), add: p.add, remove: p.remove, dryRun: true });
        S.tagPlanSig = curSig();
        const pl = r.plan || {};
        out.textContent = '';
        out.appendChild(el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { class: 'grow', text: '预演（未写盘）：' + r.message })]));
        out.appendChild(el('div', { class: 'ledger' }, [
          row('命中漫画', String(pl.count || 0) + ' 部'),
          row('将添加', (pl.add || []).join('、') || '—'),
          row('将移除', (pl.remove || []).join('、') || '—'),
          row('复用已有标签', (pl.existingTags || []).join('、') || '—'),
          row('会新建标签', (pl.willCreateTags || []).join('、') || '无')
        ]));
        if (pl.note) out.appendChild(el('div', { class: 'alert alert-warn' }, [ctx.icon('alert'), el('span', { text: pl.note })]));
        if (pl.count) {
          out.appendChild(el('button', {
            class: 'btn btn-primary', style: { marginTop: '8px' }, dataset: { act: 'tag-apply-plan' },
            on: { click: function () { apply(true); } }
          }, [ctx.icon('check'), el('span', { text: '确认执行（' + pl.count + ' 部）' })]));
        }
        return true;
      } catch (err) { out.textContent = ''; out.appendChild(errBox(err, plan)); return false; }
    }

    async function apply(fromPlan) {
      if (!S.sel.size) { ctx.toast('请先勾选漫画', 'warn'); return; }
      const p = parts();
      if (!p.add.length && !p.remove.length) { ctx.toast('请填写要添加或移除的标签', 'warn'); return; }
      if (!fromPlan || S.tagPlanSig !== curSig()) {
        const ok = await plan();
        if (ok) ctx.toast('已生成预演，确认无误后再点「执行」', 'info');
        return;
      }
      const okGo = await ctx.confirm(
        '确认对 ' + S.sel.size + ' 部漫画执行标签变更？\n\n添加：' + (p.add.join('、') || '无') + '\n移除：' + (p.remove.join('、') || '无') + '\n\n写入后可在「审计与撤销」一键撤销。',
        { okText: '执行' }
      );
      if (!okGo) return;
      out.textContent = '';
      out.appendChild(waiting('正在写入…'));
      try {
        const r = await ctx.post('/api/vault/tags/assign', { comicIds: selectedIds(), add: p.add, remove: p.remove });
        S.tagPlanSig = '';
        addInput.value = '';
        removeInput.value = '';
        out.textContent = '';
        out.appendChild(okBox(r.message + (r.reversible ? '（可在「审计与撤销」撤销，编号 ' + r.auditId + '）' : '')));
        if ((r.created || []).length) out.appendChild(el('div', { class: 'small muted', text: '新建标签：' + r.created.map(function (t) { return t.name || t; }).join('、') }));
        ctx.toast('已更新 ' + r.affected + ' 部漫画的标签', 'ok');
        await refresh();
        await reloadComicsQuiet();
        picker.redraw();
      } catch (err) { out.textContent = ''; out.appendChild(errBox(err, function () { apply(true); })); }
    }

    picker.redraw();

    async function createTag() {
      const name = newName.value.trim();
      if (!name) { ctx.toast('请输入标签名', 'warn'); return; }
      try {
        const r = await ctx.post('/api/vault/tags', { name: name, color: newColor.value });
        ctx.toast(r.message, 'ok');
        newName.value = '';
        await refresh();
        renderTags();
      } catch (err) { ctx.toast('新建失败：' + err.message, 'err'); }
    }
  }
  async function showTagComics(tagName) {
    try {
      const r = await ctx.get('/api/vault/tag/' + encodeURIComponent(tagName) + '/comics?size=200');
      const body = el('div', { class: 'col gap-6' }, (r.items || []).map(function (c) {
        return el('div', { class: 'ledger-row' }, [
          el('span', { class: 'k', text: c.rootName || '' }),
          el('span', { class: 'ellipsis grow', text: c.title }),
          el('span', { class: 'v', text: c.images + ' 图' })
        ]);
      }));
      ctx.modal({ title: '标签「' + tagName + '」· ' + r.total + ' 部', wide: true, body: body });
    } catch (err) { ctx.toast('查询失败：' + err.message, 'err'); }
  }

  return {
    renderTags: renderTags,
    showTagComics: showTagComics
  };
}
