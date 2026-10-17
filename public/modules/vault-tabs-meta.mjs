/**
 * 批量元数据页签：批量改 / 导出 / 导入（先预演再执行）。
 *
 * 从 mount() 闭包里搬出来的代码：el / ctx / S / host 原本都是 mount 的同作用域变量，
 * 这里由参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeMetaTabs(ctx, S, deps) {
  const el = deps.el;
  const host = deps.host;
  const { errBox, waiting, okBox, parseCsv, sigOf, diffRow, downloadJson, refresh, reloadComicsQuiet, selectedIds, makePicker, statCell, fld, row } = deps.k;

  async function renderMeta() {
    host.textContent = '';
    host.appendChild(waiting('正在读取目录…'));
    await reloadComicsQuiet();
    host.textContent = '';

    host.appendChild(el('div', { class: 'alert alert-warn' }, [ctx.icon('alert'), el('span', { class: 'grow', text: '批量修改写的是每部漫画目录下的 元数据.json：后端会先写 元数据.json.bak 并把旧内容归档，可在「审计与撤销」一键撤销。批量不提供改标题（多部同名是事故），改标题请用清单里的单部编辑。' })]));

    const picker = makePicker({ hint: '勾选要一起修改的漫画；不勾选则预演会提示「请选择至少一部漫画」。' });
    host.appendChild(el('div', { class: 'section-title', text: '01 — 选择漫画' }));
    host.appendChild(picker.node);
    picker.redraw();

    const author = el('input', { class: 'input', placeholder: '留空 = 不改', dataset: { act: 'meta-author' } });
    const team = el('input', { class: 'input', placeholder: '留空 = 不改', dataset: { act: 'meta-team' } });
    const desc = el('textarea', { class: 'textarea', placeholder: '留空 = 不改', dataset: { act: 'meta-desc' } });
    const tagsMode = el('select', { class: 'select', style: { width: '150px' }, dataset: { act: 'meta-tags-mode' } }, [
      el('option', { value: 'merge', text: '标签 · 追加' }),
      el('option', { value: 'set', text: '标签 · 整体替换' }),
      el('option', { value: 'remove', text: '标签 · 移除' })
    ]);
    const tagsVal = el('input', { class: 'input', placeholder: '逗号分隔', dataset: { act: 'meta-tags-values' } });
    const catsMode = el('select', { class: 'select', style: { width: '150px' }, dataset: { act: 'meta-cats-mode' } }, [
      el('option', { value: 'merge', text: '分类 · 追加' }),
      el('option', { value: 'set', text: '分类 · 整体替换' }),
      el('option', { value: 'remove', text: '分类 · 移除' })
    ]);
    const catsVal = el('input', { class: 'input', placeholder: '逗号分隔', dataset: { act: 'meta-cats-values' } });
    const out = el('div', { class: 'col gap-8', dataset: { act: 'meta-plan-out' } });

    host.appendChild(el('div', { class: 'section-title', text: '02 — 要批量改成什么（后端支持 author / chineseTeam / description / tags / categories）' }));
    host.appendChild(el('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginBottom: '12px' } }, [
      el('div', { class: 'card card-pad col gap-10' }, [
        fld('作者 author', author),
        fld('汉化组 chineseTeam', team),
        fld('标签 tags', el('div', { class: 'row gap-6' }, [el('div', { style: { flex: 'none' } }, [tagsMode]), el('div', { class: 'grow' }, [tagsVal])]))
      ]),
      el('div', { class: 'card card-pad col gap-10' }, [
        fld('分类 categories', el('div', { class: 'row gap-6' }, [el('div', { style: { flex: 'none' } }, [catsMode]), el('div', { class: 'grow' }, [catsVal])])),
        fld('简介 description', desc)
      ])
    ]));
    host.appendChild(el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn', dataset: { act: 'meta-plan' }, on: { click: plan } }, [ctx.icon('eye'), el('span', { text: '预演（plan）' })]),
      el('button', { class: 'btn btn-primary', dataset: { act: 'meta-apply' }, on: { click: function () { apply(false); } } }, [ctx.icon('check'), el('span', { text: '执行' })])
    ]));
    host.appendChild(out);

    function buildPatch() {
      const p = {};
      if (author.value.trim()) p.author = author.value.trim();
      if (team.value.trim()) p.chineseTeam = team.value.trim();
      if (desc.value.trim()) p.description = desc.value;
      if (tagsVal.value.trim()) p.tags = { mode: tagsMode.value, values: parseCsv(tagsVal.value) };
      if (catsVal.value.trim()) p.categories = { mode: catsMode.value, values: parseCsv(catsVal.value) };
      return p;
    }
    function curSig() { return sigOf(selectedIds(), buildPatch()); }

    async function plan() {
      if (!S.sel.size) { ctx.toast('请先勾选漫画（批量改元数据必须明确范围）', 'warn'); return false; }
      const patch = buildPatch();
      if (!Object.keys(patch).length) { ctx.toast('请至少填写一个要修改的字段', 'warn'); return false; }
      out.textContent = '';
      out.appendChild(waiting('正在预演…'));
      try {
        const r = await ctx.post('/api/vault/meta/plan', { comicIds: selectedIds(), patch: patch });
        S.metaPlanSig = curSig();
        const pl = r.plan || {};
        out.textContent = '';
        out.appendChild(el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { class: 'grow', text: '预演（未写盘）：' + r.message })]));
        out.appendChild(el('div', { class: 'stat-row', style: { marginBottom: '10px' } }, [
          statCell(String(pl.count || 0), '将修改', 'var(--red)'),
          statCell(String(pl.unchangedCount || 0), '无变化', 'var(--muted)'),
          statCell(String(pl.missingCount || 0), '找不到', 'var(--yellow)'),
          statCell(String(pl.skippedCount || 0), '跳过', 'var(--muted)')
        ]));
        const list = el('div', { class: 'col gap-8', style: { maxHeight: '380px', overflow: 'auto' } });
        for (const it of (pl.items || [])) {
          list.appendChild(el('div', { class: 'panel card-pad col gap-6' }, [
            el('div', { class: 'row between gap-8' }, [
              el('div', { class: 'row gap-6', style: { minWidth: 0 } }, [
                el('span', { class: 'stamp' + (it.hasMeta ? '' : ' stamp-yellow'), text: it.hasMeta ? '有元数据' : '补建元数据' }),
                el('span', { class: 'ellipsis', style: { fontWeight: '600' }, text: it.title })
              ]),
              el('span', { class: 'label-mono', text: it.rootName || '' })
            ]),
            el('div', { class: 'col gap-3' }, (it.diff || []).map(diffRow))
          ]));
        }
        out.appendChild(list);
        if ((pl.unchanged || []).length) out.appendChild(el('div', { class: 'small muted', text: '无变化：' + pl.unchanged.map(function (x) { return x.title; }).join('、') }));
        if ((pl.missing || []).length) out.appendChild(el('div', { class: 'small muted', text: '找不到：' + pl.missing.map(function (x) { return x.comicId + '（' + x.reason + '）'; }).join('、') }));
        if ((pl.skipped || []).length) out.appendChild(el('div', { class: 'small muted', text: '跳过：' + pl.skipped.map(function (x) { return (x.dir || x.comicId) + '（' + x.reason + '）'; }).join('、') }));
        if (pl.count) {
          out.appendChild(el('button', {
            class: 'btn btn-primary', style: { marginTop: '8px' }, dataset: { act: 'meta-apply-plan' },
            on: { click: function () { apply(true); } }
          }, [ctx.icon('check'), el('span', { text: '确认执行（' + pl.count + ' 部）' })]));
        }
        return true;
      } catch (err) { out.textContent = ''; out.appendChild(errBox(err, plan)); return false; }
    }

    async function apply(fromPlan) {
      if (!S.sel.size) { ctx.toast('请先勾选漫画', 'warn'); return; }
      if (!Object.keys(buildPatch()).length) { ctx.toast('请至少填写一个要修改的字段', 'warn'); return; }
      if (!fromPlan || S.metaPlanSig !== curSig()) {
        const ok = await plan();
        if (ok) ctx.toast('已生成预演，确认无误后再点「执行」', 'info');
        return;
      }
      const okGo = await ctx.confirm('确认修改 ' + S.sel.size + ' 部漫画的元数据？\n\n每部原文件会备份为 元数据.json.bak，旧内容归档，可在「审计与撤销」一键撤销。', { danger: true, okText: '执行修改' });
      if (!okGo) return;
      out.textContent = '';
      out.appendChild(waiting('正在写入…'));
      try {
        const r = await ctx.post('/api/vault/meta/batch', { comicIds: selectedIds(), patch: buildPatch(), confirm: true });
        S.metaPlanSig = '';
        out.textContent = '';
        out.appendChild(okBox(r.message));
        out.appendChild(el('div', { class: 'ledger' }, [
          row('成功', String((r.result && r.result.appliedCount) || 0) + ' 部'),
          row('失败', String((r.result && r.result.failedCount) || 0) + ' 部'),
          row('审计编号', r.auditId || '—')
        ]));
        if (r.result && (r.result.failed || []).length) {
          out.appendChild(el('div', { class: 'mono small muted', style: { whiteSpace: 'pre-wrap' }, text: r.result.failed.map(function (f) { return (f.dir || '') + ' → ' + (f.error || ''); }).join('\n') }));
        }
        ctx.toast('已修改 ' + ((r.result && r.result.appliedCount) || 0) + ' 部元数据', 'ok');
        await refresh();
        await reloadComicsQuiet();
        picker.redraw();
      } catch (err) { out.textContent = ''; out.appendChild(errBox(err, function () { apply(true); })); }
    }

    /* ---- 导出 / 导入 ---- */
    const exportStatus = el('span', { class: 'label-mono', dataset: { act: 'meta-export-status' }, text: '未导出' });
    const exportOut = el('div', { class: 'col gap-6', dataset: { act: 'meta-export-out' } });
    const importOut = el('div', { class: 'col gap-6', dataset: { act: 'meta-import-out' } });
    const fileInput = el('input', { class: 'input', type: 'file', accept: '.json,application/json', style: { maxWidth: '320px' }, dataset: { act: 'meta-import-file' } });
    let pendingImport = null;

    host.appendChild(el('div', { class: 'section-title', text: '03 — 导出 / 导入元数据（JSON）' }));
    host.appendChild(el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn btn-sm', dataset: { act: 'meta-export-selected' }, on: { click: function () { doExport(selectedIds()); } } }, [ctx.icon('upload'), el('span', { text: '导出选中' })]),
      el('button', { class: 'btn btn-sm', dataset: { act: 'meta-export-all' }, on: { click: function () { doExport([]); } } }, [ctx.icon('upload'), el('span', { text: '导出全库' })]),
      el('span', { class: 'label-mono', text: '导入：' }),
      fileInput,
      exportStatus
    ]));
    host.appendChild(el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { class: 'grow', text: '导入会先预演：显示将变更的条数与匹配不上的条目，确认后才写入。匹配顺序：comicId → 库根名+目录名 → 标题。' })]));
    host.appendChild(exportOut);
    host.appendChild(importOut);

    async function doExport(ids) {
      exportStatus.textContent = '正在导出…';
      exportOut.textContent = '';
      try {
        const qs = ids && ids.length ? '?comicIds=' + encodeURIComponent(ids.join(',')) : '';
        const r = await ctx.get('/api/vault/meta/export' + qs);
        const name = 'mangavault-meta-' + String(Date.now()) + '.json';
        downloadJson(name, r.payload);
        exportStatus.textContent = '已导出 ' + (r.count || 0) + ' 部 → ' + name;
        ctx.toast('已导出 ' + (r.count || 0) + ' 部元数据', 'ok');
      } catch (err) {
        exportStatus.textContent = '导出失败';
        exportOut.textContent = '';
        exportOut.appendChild(errBox(err, function () { doExport(ids); }));
      }
    }

    async function previewImport(fileName, payload) {
      importOut.textContent = '';
      importOut.appendChild(waiting('正在预演导入…'));
      try {
        const r = await ctx.post('/api/vault/meta/import', { payload: payload, confirm: false });
        const pl = r.plan || {};
        importOut.textContent = '';
        importOut.appendChild(el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { class: 'grow', text: '预演（未写盘）：' + r.message })]));
        importOut.appendChild(el('div', { class: 'ledger' }, [
          row('文件', fileName || '(内存)'),
          row('将导入', String(pl.count || 0) + ' 部'),
          row('无变化', String(pl.unchangedCount || 0) + ' 部'),
          row('匹配不上', String((pl.unmatched || []).length) + ' 条'),
          row('无法处理', String((pl.invalid || []).length) + ' 条')
        ]));
        if ((pl.unmatched || []).length) {
          importOut.appendChild(el('div', { class: 'small muted', text: '匹配不上：' + pl.unmatched.slice(0, 20).map(function (x) { return (x.title || x.dir) + '（' + x.reason + '）'; }).join('、') }));
        }
        if (pl.count) {
          importOut.appendChild(el('button', {
            class: 'btn btn-primary', style: { marginTop: '8px' }, dataset: { act: 'meta-import-confirm' },
            on: { click: doImport }
          }, [ctx.icon('upload'), el('span', { text: '确认导入 ' + pl.count + ' 部' })]));
        }
      } catch (err) {
        importOut.textContent = '';
        importOut.appendChild(errBox(err, function () { if (pendingImport) previewImport(pendingImport.name, pendingImport.payload); }));
      }
    }

    fileInput.addEventListener('change', async function () {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      pendingImport = null;
      importOut.textContent = '';
      importOut.appendChild(waiting('正在读取文件…'));
      try {
        const text = await f.text();
        let payload = null;
        try { payload = JSON.parse(text); } catch (e) { throw new Error('文件不是合法 JSON：' + e.message); }
        pendingImport = { name: f.name, payload: payload };
        await previewImport(f.name, payload);
      } catch (err) {
        importOut.textContent = '';
        importOut.appendChild(errBox(err, function () { fileInput.value = ''; }));
      }
    });

    async function doImport() {
      if (!pendingImport) { ctx.toast('请先选择要导入的 JSON 文件', 'warn'); return; }
      const q = await ctx.post('/api/vault/meta/import', { payload: pendingImport.payload, confirm: false });
      const n = (q.plan && q.plan.count) || 0;
      const okGo = await ctx.confirm('确认导入并覆盖 ' + n + ' 部漫画的元数据？\n\n旧内容会备份为 元数据.json.bak 并可撤销。', { danger: true, okText: '确认导入' });
      if (!okGo) return;
      importOut.textContent = '';
      importOut.appendChild(waiting('正在导入…'));
      try {
        const r = await ctx.post('/api/vault/meta/import', { payload: pendingImport.payload, confirm: true });
        importOut.textContent = '';
        importOut.appendChild(okBox(r.message));
        importOut.appendChild(el('div', { class: 'ledger' }, [
          row('成功', String(r.result ? r.result.imported : 0) + ' 部'),
          row('失败', String(r.result ? r.result.failedCount : 0) + ' 部'),
          row('审计编号', r.auditId || '—')
        ]));
        pendingImport = null;
        fileInput.value = '';
        exportStatus.textContent = '导入完成';
        ctx.toast('已导入元数据', 'ok');
        await refresh();
        await reloadComicsQuiet();
        picker.redraw();
      } catch (err) { importOut.textContent = ''; importOut.appendChild(errBox(err, doImport)); }
    }
  }

  return {
    renderMeta: renderMeta
  };
}
