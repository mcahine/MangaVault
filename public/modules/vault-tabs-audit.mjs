/**
 * 审计与撤销页签 + 批量整理页签。
 *
 * 从 mount() 闭包里搬出来的代码：el / ctx / S / host 原本都是 mount 的同作用域变量，
 * 这里由参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeAuditTabs(ctx, S, deps) {
  const el = deps.el;
  const host = deps.host;
  const { errBox, waiting, okBox, parseCsv, refresh, row } = deps.k;

  async function renderAudit() {
    host.textContent = '';
    host.appendChild(waiting('正在读取审计日志…'));
    const AUDIT_ACTIONS = [
      ['', '全部动作'], ['rename', '重命名目录'], ['move-to-root', '跨库根搬迁'], ['meta-edit', '修改元数据'],
      ['tag-assign', '批量打标签'], ['meta-import', '导入元数据'], ['orphan-clean', '孤儿清理'],
      ['trash-applied', '移入回收站'], ['trash-restored', '从回收站还原'], ['trash-purge', '永久删除'], ['undo', '撤销']
    ];
    const actionSel = el('select', { class: 'select', style: { width: '170px' }, dataset: { act: 'audit-action-filter' } }, AUDIT_ACTIONS.map(function (a) {
      return el('option', { value: a[0], text: a[1] });
    }));

    let data = null, und = null;
    try {
      data = await ctx.get('/api/vault/audit?page=' + S.auditPage + '&limit=40&action=' + encodeURIComponent(S.auditAction));
      und = (await ctx.get('/api/vault/audit/undoable')).undoable || null;
    } catch (err) { host.textContent = ''; host.appendChild(errBox(err, renderAudit)); return; }

    host.textContent = '';
    actionSel.value = S.auditAction;

    /* 可撤销面板（专用接口 /api/vault/audit/undoable，缺失时回退到列表里带的那条） */
    const undo = und || data.undoable;
    const undoBox = el('div', { class: 'card card-pad col gap-8', dataset: { act: 'audit-undoable' } }, [
      el('div', { class: 'section-title', text: '01 — 最近可撤销' }),
      undo
        ? el('div', { class: 'ledger' }, [
          row('动作', undo.actionLabel || undo.action),
          row('对象', undo.message || ''),
          row('时间', ctx.fmt.date(undo.at)),
          row('影响', JSON.stringify(undo.counts || {}))
        ])
        : el('div', { class: 'small muted', text: '当前没有可撤销的操作（破坏性操作执行后会出现在这里）' }),
      undo ? el('button', { class: 'btn btn-danger', dataset: { act: 'audit-undo' }, on: { click: doUndo } }, [ctx.icon('rotate'), el('span', { text: '撤销这次操作' })]) : null
    ]);
    host.appendChild(el('div', { class: 'section-title', text: '审计日志 · 共 ' + data.total + ' 条' }));
    host.appendChild(el('div', { class: 'toolbar' }, [
      actionSel,
      el('button', { class: 'btn btn-sm', dataset: { act: 'audit-refresh' }, on: { click: function () { S.auditAction = actionSel.value; S.auditPage = 1; renderAudit(); } } }, [ctx.icon('refresh'), el('span', { text: '刷新' })]),
      el('div', { class: 'grow' }),
      el('span', { class: 'label-mono', text: '归档目录 ' + data.dir })
    ]));
    host.appendChild(undoBox);

    const table = el('table', { class: 'table', dataset: { act: 'audit-list' } }, [
      el('thead', {}, [el('tr', {}, ['时间', '动作', '对象', '结果', '影响', '操作'].map(function (h) { return el('th', { text: h }); }))]),
      el('tbody', {}, (data.items || []).map(function (e) {
        const resultLabel = e.status === 'undone' ? '已撤销' : e.status === 'failed' ? '失败' : '已完成';
        const badge = e.status === 'undone' ? 'badge-warn' : e.status === 'failed' ? 'badge-err' : 'badge-ok';
        const canArchive = Boolean(e.details && Array.isArray(e.details.items) && e.details.items.some(function (x) { return x.blob; }));
        return el('tr', {}, [
          el('td', { class: 'mono small', text: ctx.fmt.date(e.at) }),
          el('td', { text: e.actionLabel || e.action }),
          el('td', { class: 'ellipsis', style: { maxWidth: '300px' }, text: e.target || e.message || '' }),
          el('td', {}, [el('span', { class: 'badge ' + badge, text: resultLabel }), e.reversible ? el('span', { class: 'badge badge-accent', text: '可撤销' }) : null]),
          el('td', { class: 'mono small', text: JSON.stringify(e.counts || {}) }),
          el('td', {}, [
            canArchive ? el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'audit-view-archive', id: e.id }, on: { click: function () { viewArchive(e.id); } } }, [ctx.icon('eye'), el('span', { text: '查看原内容' })]) : el('span', { class: 'small muted', text: '—' })
          ])
        ]);
      }))
    ]);
    host.appendChild(table);

    host.appendChild(el('div', { class: 'toolbar', style: { marginTop: '10px' } }, [
      el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'audit-prev' }, disabled: data.page <= 1, on: { click: function () { S.auditPage = Math.max(1, data.page - 1); renderAudit(); } } }, [ctx.icon('chevron-left'), el('span', { text: '上一页' })]),
      el('span', { class: 'label-mono', text: '第 ' + data.page + ' / ' + data.pages + ' 页' }),
      el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'audit-next' }, disabled: data.page >= data.pages, on: { click: function () { S.auditPage = data.page + 1; renderAudit(); } } }, [el('span', { text: '下一页' }), ctx.icon('chevron-right')])
    ]));

    async function doUndo() {
      if (!undo) return;
      const okGo = await ctx.confirm('撤销「' + (undo.actionLabel || undo.action) + '」？\n\n' + (undo.message || '') + '\n\n撤销本身也会写一条审计记录。', { danger: true, okText: '撤销' });
      if (!okGo) return;
      try {
        const r = await ctx.post('/api/vault/audit/undo', { entryId: undo.id, confirm: true });
        ctx.toast(r.message, 'ok');
        await refresh();
        renderAudit();
      } catch (err) { ctx.toast('撤销失败：' + err.message, 'err'); }
    }

    async function viewArchive(entryId) {
      try {
        const r = await ctx.get('/api/vault/audit/archive/' + encodeURIComponent(entryId));
        const a = r.archive || {};
        const body = el('div', { class: 'col gap-8' }, [
          el('div', { class: 'ledger' }, [row('目录', a.dir || ''), row('归档文件', a.blob || ''), row('字节', String(a.bytes || 0))]),
          a.json
            ? el('pre', { class: 'mono small', style: { whiteSpace: 'pre-wrap', maxHeight: '50vh', overflow: 'auto' }, text: JSON.stringify(a.json, null, 2) })
            : el('pre', { class: 'mono small', style: { whiteSpace: 'pre-wrap', maxHeight: '50vh', overflow: 'auto' }, text: String(a.text || '') })
        ]);
        ctx.modal({ title: '归档原内容 · ' + (a.dir || entryId), wide: true, body: body });
      } catch (err) { ctx.toast('读取归档失败：' + err.message, 'err'); }
    }
  }
  async function renderBatch() {
    host.textContent = '';
    host.appendChild(el('div', { class: 'alert alert-warn' }, [ctx.icon('alert'), el('span', { class: 'grow', text: '所有批量操作都会先出「预演计划」，确认后才真正动磁盘。重命名只做规范化，不会丢失文件。' })]));
    host.appendChild(el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { class: 'grow', text: '跨库根搬迁已升级到独立页签「跨库搬迁」：带重名冲突预演、跨盘提示与一键撤销，本页不再提供。' })]));

    const idsInput = el('input', { class: 'input', placeholder: '留空=全库；或填 comicId（逗号分隔）' });
    const out = el('div', { class: 'col gap-8', style: { marginTop: '12px' } });

    const actions = [
      ['rename-dirs', '规范化目录名', 'scissors', '去首尾空格 / 全角空格 / 非法字符，统一「序 标题」'],
      ['normalize-chapters', '重排章节目录', 'sort', '章节目录统一为「N 标题」并补零'],
      ['trash', '移入回收站', 'trash', '安全移除，可随时还原（不永久删除）']
    ];
    host.appendChild(el('div', { class: 'section-title', text: '选择操作' }));
    host.appendChild(el('div', { class: 'toolgrid' }, actions.map(function (a) {
      return el('button', { class: 'btn', title: a[3], dataset: { act: 'batch-' + a[0] }, on: { click: function () { runBatch(a[0], idsInput, out); } } }, [ctx.icon(a[2]), el('span', { text: a[1] })]);
    })));
    host.appendChild(el('div', { class: 'row gap-8 wrap', style: { marginTop: '12px' } }, [el('span', { class: 'label-mono', text: '范围' }), el('div', { class: 'grow' }, [idsInput])]));
    host.appendChild(el('div', { class: 'rule' }));
    host.appendChild(out);
  }
  async function runBatch(action, idsInput, out) {
    const ids = parseCsv(idsInput.value);
    out.textContent = '';
    out.appendChild(waiting('正在计算…'));
    try {
      let r;
      if (action === 'trash') {
        if (!ids.length) { out.textContent = ''; out.appendChild(errBox(new Error('移入回收站必须明确 comicIds（防误操作全库）'), function () { runBatch(action, idsInput, out); })); return; }
        const ok = await ctx.confirm('把 ' + ids.length + ' 部漫画移入回收站？\n\n不会永久删除，随时可在「回收站」还原。', { danger: true, okText: '移入回收站' });
        if (!ok) { out.textContent = ''; return; }
        r = await ctx.post('/api/vault/batch', { action: 'trash', comicIds: ids, note: '从批量整理移入' });
        out.textContent = '';
        out.appendChild(okBox(r.message));
        ctx.toast(r.message, 'ok');
        refresh();
        return;
      }
      r = await ctx.post('/api/vault/batch', { action: action, comicIds: ids, options: {} });
      out.textContent = '';

      if (r.dryRun && r.plan) {
        const plan = r.plan;
        out.appendChild(el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { class: 'grow', text: '预演：将改动 ' + plan.count + ' 项，涉及 ' + plan.affectedComics + ' 部漫画。确认后执行。' })]));
        const tbl = el('div', { class: 'col gap-4', style: { maxHeight: '300px', overflow: 'auto' } });
        for (const p of (plan.plan || []).slice(0, 200)) {
          tbl.appendChild(el('div', { class: 'ledger-row', title: p.reason }, [
            el('span', { class: 'k', text: p.type === 'comic-dir' ? '目录' : '章节' }),
            el('span', { class: 'ellipsis grow', text: p.from }),
            ctx.icon('arrow-right'),
            el('span', { class: 'ellipsis', style: { maxWidth: '34%' }, text: p.to })
          ]));
        }
        out.appendChild(tbl);
        if (plan.count) {
          out.appendChild(el('button', {
            class: 'btn btn-primary', style: { marginTop: '10px' },
            on: { click: async function () {
              const ok = await ctx.confirm('确认执行 ' + plan.count + ' 项改动？\n\n建议先做一次备份（「备份」页签）。', { danger: true, okText: '执行' });
              if (!ok) return;
              try {
                const r2 = await ctx.post('/api/vault/batch', { action: action, comicIds: ids, options: { confirm: true } });
                ctx.toast('已执行', 'ok');
                out.textContent = '';
                const res = r2.result || {};
                out.appendChild(okBox(r2.message || '执行完成'));
                out.appendChild(el('div', { class: 'ledger' }, [
                  row('成功', String(res.renamed !== undefined ? res.renamed : (res.moved || 0))),
                  row('失败', String((res.failed || []).length))
                ]));
                if ((res.failed || []).length) {
                  out.appendChild(el('div', { class: 'mono small muted', style: { maxHeight: '140px', overflow: 'auto', whiteSpace: 'pre-wrap' }, text: res.failed.map(function (f) { return (f.from || f.dir) + ' -> ' + (f.error || ''); }).join('\n') }));
                }
                refresh();
              } catch (e) { ctx.toast('执行失败：' + e.message, 'err'); }
            } }
          }, [ctx.icon('check'), el('span', { text: '确认执行 ' + plan.count + ' 项' })]));
        }
      } else {
        out.appendChild(okBox(r.message || '完成'));
        const res = r.result || {};
        out.appendChild(el('div', { class: 'ledger' }, [
          row('移动/重命名', String(res.renamed !== undefined ? res.renamed : (res.moved || 0))),
          row('失败', String((res.failed || []).length))
        ]));
        if ((res.failed || []).length) {
          out.appendChild(el('div', { class: 'mono small muted', style: { maxHeight: '140px', overflow: 'auto', whiteSpace: 'pre-wrap' }, text: res.failed.map(function (f) { return (f.from || f.dir) + ' -> ' + (f.error || ''); }).join('\n') }));
        }
        ctx.toast(r.message || '完成', 'ok');
        refresh();
      }
    } catch (err) {
      out.textContent = '';
      out.appendChild(errBox(err, function () { runBatch(action, idsInput, out); }));
    }
  }

  return {
    renderAudit: renderAudit,
    renderBatch: renderBatch
  };
}
