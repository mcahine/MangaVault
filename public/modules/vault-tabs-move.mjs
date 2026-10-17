/**
 * 跨库根批量搬迁页签 + 孤儿清理页签。
 *
 * 从 mount() 闭包里搬出来的代码：el / ctx / S / host 原本都是 mount 的同作用域变量，
 * 这里由参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeMoveTabs(ctx, S, deps) {
  const el = deps.el;
  const host = deps.host;
  const { errBox, waiting, okBox, sigOf, refresh, reloadComicsQuiet, selectedIds, makePicker, statCell, row } = deps.k;

  async function renderMove() {
    host.textContent = '';
    host.appendChild(waiting('正在读取目录…'));
    await reloadComicsQuiet();
    host.textContent = '';

    host.appendChild(el('div', { class: 'alert alert-warn' }, [ctx.icon('alert'), el('span', { class: 'grow', text: '搬迁会真的移动磁盘目录（跨盘先复制再删源）。必须先「预演」看清重名冲突与目标路径，再确认执行；执行后可在「审计与撤销」撤销。' })]));

    const picker = makePicker({ hint: '勾选要从当前库根搬走的漫画。' });
    host.appendChild(el('div', { class: 'section-title', text: '01 — 选择漫画' }));
    host.appendChild(picker.node);
    picker.redraw();

    const roots = S.roots.length ? S.roots : [];
    const targetSel = el('select', { class: 'select', style: { width: '200px' }, dataset: { act: 'move-target' } }, roots.map(function (r) { return el('option', { value: r.id, text: r.name }); }));
    const collisionSel = el('select', { class: 'select', style: { width: '190px' }, dataset: { act: 'move-collision' } }, [
      el('option', { value: 'error', text: '重名时中止该项' }),
      el('option', { value: 'skip', text: '重名时跳过该项' }),
      el('option', { value: 'rename', text: '重名时自动改名' })
    ]);
    const out = el('div', { class: 'col gap-8', dataset: { act: 'move-out' } });

    host.appendChild(el('div', { class: 'section-title', text: '02 — 目标库根与重名策略' }));
    host.appendChild(el('div', { class: 'toolbar' }, [
      el('span', { class: 'label-mono', text: '目标库根' }), targetSel,
      el('span', { class: 'label-mono', text: '策略' }), collisionSel,
      el('button', { class: 'btn', dataset: { act: 'move-plan' }, on: { click: plan } }, [ctx.icon('eye'), el('span', { text: '预演（plan）' })]),
      el('button', { class: 'btn btn-primary', dataset: { act: 'move-apply' }, on: { click: function () { apply(false); } } }, [ctx.icon('arrow-right'), el('span', { text: '执行搬迁' })])
    ]));
    host.appendChild(out);

    function curSig() { return sigOf(selectedIds(), { target: targetSel.value, collision: collisionSel.value }); }

    async function plan() {
      if (!S.sel.size) { ctx.toast('请先勾选要搬迁的漫画', 'warn'); return false; }
      if (!targetSel.value) { ctx.toast('没有可选的库根，请先到「设置」添加库根', 'warn'); return false; }
      out.textContent = '';
      out.appendChild(waiting('正在预演搬迁…'));
      try {
        const r = await ctx.post('/api/vault/move/plan', { comicIds: selectedIds(), targetRootId: targetSel.value, collision: collisionSel.value });
        const pl = r.plan || {};
        S.movePlanSig = curSig();
        out.textContent = '';
        out.appendChild(el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { class: 'grow', text: '预演（未动磁盘）：' + r.message })]));
        out.appendChild(el('div', { class: 'stat-row', style: { marginBottom: '10px' } }, [
          statCell(String(pl.count || 0), '将搬迁', 'var(--red)'),
          statCell(String(pl.conflictCount || 0), '目标重名', 'var(--yellow)'),
          statCell(String(pl.crossDeviceCount || 0), '跨盘复制', 'var(--cyan)'),
          statCell(String((pl.skipped || []).length), '跳过', 'var(--muted)'),
          statCell(String((pl.missing || []).length), '找不到', 'var(--muted)')
        ]));
        out.appendChild(el('div', { class: 'ledger' }, [
          row('目标库根', (pl.targetRoot && pl.targetRoot.name) || '—'),
          row('目标路径', (pl.targetRoot && pl.targetRoot.path) || '—'),
          row('重名策略', pl.collision || collisionSel.value)
        ]));
        const list = el('div', { class: 'col gap-4', style: { maxHeight: '340px', overflow: 'auto', marginTop: '8px' } });
        for (const it of (pl.items || [])) {
          list.appendChild(el('div', { class: 'panel card-pad col gap-4' }, [
            el('div', { class: 'row gap-6' }, [
              el('span', { class: 'ellipsis grow', style: { fontWeight: '600' }, text: it.title }),
              it.crossDevice ? el('span', { class: 'stamp stamp-yellow', text: '跨盘复制' }) : null,
              it.destDir !== it.dir ? el('span', { class: 'stamp', text: '自动改名' }) : null
            ]),
            el('div', { class: 'mv-vault-diff' }, [
              el('span', { class: 'from ellipsis', text: it.from + '/' + it.dir }),
              ctx.icon('arrow-right'),
              el('span', { class: 'to ellipsis', text: it.to + '/' + it.destDir })
            ])
          ]));
        }
        out.appendChild(list);
        if ((pl.skipped || []).length) out.appendChild(el('div', { class: 'alert alert-warn' }, [ctx.icon('alert'), el('span', { class: 'grow', text: '会跳过：' + pl.skipped.map(function (x) { return (x.title || x.dir) + '（' + x.reason + '）'; }).join('；') })]));
        if ((pl.missing || []).length) out.appendChild(el('div', { class: 'small muted', text: '找不到：' + pl.missing.map(function (x) { return x.comicId + '（' + x.reason + '）'; }).join('、') }));
        if (pl.count) {
          out.appendChild(el('button', {
            class: 'btn btn-primary', style: { marginTop: '8px' }, dataset: { act: 'move-apply-plan' },
            on: { click: function () { apply(true); } }
          }, [ctx.icon('arrow-right'), el('span', { text: '确认搬迁 ' + pl.count + ' 部' })]));
        }
        return true;
      } catch (err) { out.textContent = ''; out.appendChild(errBox(err, plan)); return false; }
    }

    async function apply(fromPlan) {
      if (!S.sel.size) { ctx.toast('请先勾选要搬迁的漫画', 'warn'); return; }
      if (!targetSel.value) { ctx.toast('请选择目标库根', 'warn'); return; }
      if (!fromPlan || S.movePlanSig !== curSig()) {
        const ok = await plan();
        if (ok) ctx.toast('已生成预演，确认无误后再点「执行搬迁」', 'info');
        return;
      }
      const targetName = (S.roots.find(function (r) { return r.id === targetSel.value; }) || {}).name || targetSel.value;
      const okGo = await ctx.confirm('确认把 ' + S.sel.size + ' 部漫画搬到「' + targetName + '」？\n\n磁盘目录会被真实移动；执行后可在「审计与撤销」撤销。', { danger: true, okText: '执行搬迁' });
      if (!okGo) return;
      out.textContent = '';
      out.appendChild(waiting('正在搬迁（跨盘会先复制再删源，可能较慢）…'));
      try {
        const r = await ctx.post('/api/vault/move', { comicIds: selectedIds(), targetRootId: targetSel.value, collision: collisionSel.value, confirm: true });
        S.movePlanSig = '';
        out.textContent = '';
        out.appendChild(okBox(r.message));
        out.appendChild(el('div', { class: 'ledger' }, [
          row('已搬迁', String((r.result && r.result.moved) || 0) + ' 部'),
          row('失败', String((r.result && r.result.failedCount) || 0) + ' 部'),
          row('审计编号', r.auditId || '—')
        ]));
        if (r.result && (r.result.failed || []).length) {
          out.appendChild(el('div', { class: 'mono small muted', style: { whiteSpace: 'pre-wrap' }, text: r.result.failed.map(function (f) { return (f.dir || '') + ' → ' + (f.error || ''); }).join('\n') }));
        }
        ctx.toast('已搬迁 ' + ((r.result && r.result.moved) || 0) + ' 部', 'ok');
        await refresh();
        await reloadComicsQuiet();
        picker.redraw();
      } catch (err) { out.textContent = ''; out.appendChild(errBox(err, function () { apply(true); })); }
    }
  }
  async function renderOrphans() {
    host.textContent = '';
    const parts = { diskOnly: true, indexOnly: true, trashMissing: true };
    const out = el('div', { class: 'col gap-10', dataset: { act: 'orphan-out' } });

    const partsBox = el('div', { class: 'row wrap gap-12' }, [
      partToggle('磁盘有索引无（磁盘孤立目录）', 'orphan-part-disk', 'diskOnly'),
      partToggle('索引有磁盘无（幽灵条目）', 'orphan-part-index', 'indexOnly'),
      partToggle('回收站失联条目', 'orphan-part-trash', 'trashMissing')
    ]);

    function partToggle(label, act, key) {
      const box = el('div', { class: 'checkbox' + (parts[key] ? ' on' : ''), dataset: { act: act } });
      const labelNode = el('span', { class: 'small', text: label, on: { click: function () { parts[key] = !parts[key]; box.classList.toggle('on', parts[key]); } } });
      return el('div', { class: 'row gap-6' }, [box, labelNode]);
    }

    host.appendChild(el('div', { class: 'alert alert-warn' }, [ctx.icon('alert'), el('span', { class: 'grow', text: '清理策略（后端已实现，不假装能一键回滚）：幽灵条目 → 先备份索引文件再触发重扫；磁盘孤立目录 → 移入回收站（可还原）；回收站失联条目 → 只从清单里摘掉。整条审计标记为不可撤销，所以必须二次确认。' })]));
    host.appendChild(el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn', dataset: { act: 'orphan-scan' }, on: { click: scan } }, [ctx.icon('search'), el('span', { text: '扫描孤儿（=预演）' })]),
      el('button', { class: 'btn btn-danger', dataset: { act: 'orphan-clean' }, on: { click: clean } }, [ctx.icon('trash'), el('span', { text: '清理（需二次确认）' })])
    ]));
    host.appendChild(el('div', { class: 'section-title', text: '清理范围' }));
    host.appendChild(partsBox);
    host.appendChild(out);

    let lastScan = null;
    out.appendChild(waiting('点「扫描孤儿」开始（扫描即预演，会重扫目录）'));

    async function scan() {
      out.textContent = '';
      out.appendChild(waiting('正在扫描孤儿…'));
      try {
        const r = await ctx.get('/api/vault/orphans');
        lastScan = r;
        out.textContent = '';
        out.appendChild(el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { class: 'grow', text: r.message + '（扫描时间 ' + ctx.fmt.date(r.scannedAt) + '）' })]));
        out.appendChild(el('div', { class: 'stat-row', style: { marginBottom: '10px' } }, [
          statCell(String((r.counts && r.counts.diskOnly) || 0), '磁盘孤立', 'var(--red)'),
          statCell(String((r.counts && r.counts.indexOnly) || 0), '幽灵条目', 'var(--yellow)'),
          statCell(String((r.counts && r.counts.trashMissing) || 0), '回收站失联', 'var(--pink)'),
          statCell(String((r.counts && r.counts.total) || 0), '可清理合计', 'var(--cyan)')
        ]));
        out.appendChild(section('磁盘有索引无', (r.diskOnly || []).map(function (x) {
          return row(x.title || x.dir, (x.rootName || '') + ' · ' + (x.images || 0) + ' 图');
        })));
        out.appendChild(section('索引有磁盘无', (r.indexOnly || []).map(function (x) {
          return row(x.title || x.dir, '索引记录 · ' + (x.images || 0) + ' 图');
        })));
        out.appendChild(section('回收站失联', (r.trashMissing || []).map(function (x) {
          return row(x.title || x.dir, x.trashPath || '');
        })));
      } catch (err) { out.textContent = ''; out.appendChild(errBox(err, scan)); }
    }

    function section(title, rows) {
      return el('div', { class: 'card card-pad col gap-8' }, [
        el('div', { class: 'section-title', text: title + '（' + rows.length + '）' }),
        rows.length ? el('div', { class: 'ledger', style: { maxHeight: '220px', overflow: 'auto' } }, rows.slice(0, 200)) : el('div', { class: 'small muted', text: '无' })
      ]);
    }

    async function clean() {
      if (!lastScan) { ctx.toast('请先点「扫描孤儿」看清要清理什么', 'warn'); return; }
      const n = (lastScan.counts && lastScan.counts.total) || 0;
      if (!n) { ctx.toast('当前没有孤儿条目，无需清理', 'info'); return; }
      const okGo = await ctx.confirm(
        '将清理 ' + n + ' 条孤儿：\n\n· 磁盘孤立 ' + lastScan.counts.diskOnly + ' 部 → 移入回收站（可还原）\n· 幽灵条目 ' + lastScan.counts.indexOnly + ' 条 → 先备份索引再重扫\n· 回收站失联 ' + lastScan.counts.trashMissing + ' 条 → 只摘清单\n\n本条操作**不可一键撤销**。',
        { danger: true, okText: '继续' }
      );
      if (!okGo) return;
      const typed = await ctx.prompt('请输入 CLEAN 以确认清理（不可一键撤销）：', '', { title: '安全确认', okText: '执行清理' });
      if (String(typed || '').trim().toUpperCase() !== 'CLEAN') { ctx.toast('确认文本不正确，已取消', 'warn'); return; }
      out.textContent = '';
      out.appendChild(waiting('正在清理…'));
      try {
        const r = await ctx.post('/api/vault/orphans/clean', { confirm: true, parts: { diskOnly: parts.diskOnly, indexOnly: parts.indexOnly, trashMissing: parts.trashMissing }, note: '前端孤儿清理' });
        out.textContent = '';
        out.appendChild(el('div', { class: 'alert alert-ok' }, [ctx.icon('check'), el('span', { class: 'grow', text: r.message })]));
        out.appendChild(el('div', { class: 'ledger' }, [
          row('清理前', String((r.result && r.result.before && r.result.before.counts && r.result.before.counts.total) || n) + ' 条'),
          row('清理后', String((r.result && r.result.after && r.result.after.counts && r.result.after.counts.total) || 0) + ' 条'),
          row('索引备份', ((r.result && r.result.backups) || []).join('、') || '（本次未动索引）'),
          row('审计编号', r.auditId || '—'),
          row('可撤销', r.reversible ? '是' : '否（按设计）')
        ]));
        if (r.result && r.result.report && (r.result.report.errors || []).length) {
          out.appendChild(el('div', { class: 'alert alert-err' }, [ctx.icon('alert'), el('span', { class: 'grow', text: '部分步骤失败：' + r.result.report.errors.join('；') })]));
        }
        ctx.toast('孤儿清理完成', 'ok');
        lastScan = null;
        await refresh();
        await scan();
      } catch (err) { out.textContent = ''; out.appendChild(errBox(err, clean)); }
    }
  }

  return {
    renderMove: renderMove,
    renderOrphans: renderOrphans
  };
}
