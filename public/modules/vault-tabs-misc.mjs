/**
 * 校验修复 / 回收站 / 统计 / 书架 / 备份五个页签。
 *
 * 从 mount() 闭包里搬出来的代码：el / ctx / S / host 原本都是 mount 的同作用域变量，
 * 这里由参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeMiscTabs(ctx, S, deps) {
  const el = deps.el;
  const host = deps.host;
  const { errBox, waiting, parseCsv, refresh, statCell, row } = deps.k;

  const CODE_LABEL = { zero: '0 字节文件', tiny: '文件过小', header: '图片头异常', truncated: 'JPEG 截断', gap: '序号断档', 'no-chapter-meta': '缺章节元数据', 'chapter-meta-field': '章节元数据缺字段', 'no-cover': '缺封面', 'no-meta': '缺元数据', dirname: '目录名不规范' };
  const ACTION_LABEL = { 'write-chapter-meta': '补章节元数据', 'make-cover': '生成封面' };
  async function renderVerify() {
    host.textContent = '';
    host.appendChild(el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn btn-primary', on: { click: function () { doVerify(false); } } }, [ctx.icon('shield'), el('span', { text: '开始校验' })]),
      el('button', { class: 'btn btn-ghost', on: { click: function () { doVerify(true); } } }, [ctx.icon('refresh'), el('span', { text: '全量校验（含图片字节）' })]),
      el('div', { class: 'grow' }),
      el('span', { class: 'label-mono', text: '检查：0 字节 / 图片头尾 / 序号断档 / 章节元数据 / 封面 / 目录名' })
    ]));
    const out = el('div', { class: 'col gap-8' });
    host.appendChild(out);

    async function doVerify(full) {
      out.textContent = '';
      out.appendChild(waiting('正在校验…（全量会逐张读图片头尾，可能需要一会儿）'));
      try {
        const r = (await ctx.get('/api/vault/verify?limit=' + (full ? 2000 : 200))).result;
        out.textContent = '';
        out.appendChild(el('div', { class: 'stat-row' }, [
          statCell(String(r.scanned), '已检查', 'var(--paper)'),
          statCell(String(r.problemComics), '有问题', 'var(--red)'),
          statCell(String(r.high), '严重', 'var(--red)'),
          statCell(String(r.mid), '中等', 'var(--yellow)'),
          statCell(String(r.low), '轻微', 'var(--muted)')
        ]));
        const codeRows = Object.keys(r.byCode).map(function (k) { return row(CODE_LABEL[k] || k, String(r.byCode[k])); });
        if (codeRows.length) {
          out.appendChild(el('div', { class: 'ledger', style: { marginTop: '12px' } }, codeRows));
        }
        if (!r.reports.length) { out.appendChild(el('div', { class: 'alert alert-ok' }, [ctx.icon('check'), el('span', { text: '没有发现问题，库里很干净。' })])); return; }

        out.appendChild(el('button', { class: 'btn btn-primary', style: { marginTop: '12px' }, on: { click: fixAll } }, [ctx.icon('wand'), el('span', { text: '一键修复安全项（补章节元数据 / 生成缺失封面）' })]));

        const list = el('div', { class: 'col gap-6', style: { maxHeight: '460px', overflow: 'auto', marginTop: '10px' } });
        for (const rep of r.reports) {
          const wrap = el('div', { class: 'card card-pad col gap-6' }, [
            el('div', { class: 'row between gap-8' }, [
              el('div', { class: 'row gap-8', style: { minWidth: 0 } }, [
                el('span', { class: 'stamp', text: String(rep.findings.length) + ' 项' }),
                el('span', { class: 'ellipsis', style: { fontWeight: '600' }, text: rep.title })
              ]),
              el('span', { class: 'label-mono', text: rep.rootName || '' })
            ]),
            el('div', { class: 'col gap-3' }, rep.findings.slice(0, 12).map(function (f) {
              const color = f.level === 'high' ? 'var(--red)' : f.level === 'mid' ? 'var(--yellow)' : 'var(--muted)';
              return el('div', { class: 'row gap-6', style: { alignItems: 'flex-start' } }, [
                el('span', { class: 'badge', style: { color: color, borderColor: color, flex: 'none' }, text: f.level === 'high' ? '严重' : f.level === 'mid' ? '中等' : '轻微' }),
                el('span', { class: 'small', text: f.message })
              ]);
            }))
          ]);
          list.appendChild(wrap);
        }
        out.appendChild(list);
      } catch (err) { out.textContent = ''; out.appendChild(errBox(err, function () { doVerify(full); })); }
    }

    async function fixAll() {
      try {
        const dry = await ctx.post('/api/vault/verify/fix', { confirm: false });
        if (!dry.result.count) { ctx.toast('没有可自动修复的项', 'info'); return; }
        const ok = await ctx.confirm('将修复 ' + dry.result.count + ' 项：\n\n' + dry.result.actions.slice(0, 12).map(function (a) { return '· ' + ACTION_LABEL[a.type] + ' — ' + a.dir; }).join('\n') + (dry.result.count > 12 ? '\n… 共 ' + dry.result.count + ' 项' : ''), { okText: '执行修复' });
        if (!ok) return;
        const r = await ctx.post('/api/vault/verify/fix', { confirm: true });
        ctx.toast(r.message, 'ok');
        refresh();
      } catch (err) { ctx.toast('修复失败：' + err.message, 'err'); }
    }
  }
  async function renderTrash() {
    host.textContent = '';
    let tr = null;
    try { tr = (await ctx.get('/api/vault/trash')).trash; }
    catch (err) { host.appendChild(errBox(err, renderTrash)); return; }

    host.appendChild(el('div', { class: 'stat-row', style: { marginBottom: '14px' } }, [
      statCell(String(tr.count), '回收站条目', 'var(--yellow)'),
      statCell(ctx.fmt.bytes(tr.bytes), '可回收空间', 'var(--cyan)')
    ]));

    if (!tr.items.length) {
      host.appendChild(ctx.empty('回收站是空的', '用「批量整理 → 移入回收站」可以把漫画安全移除到这里'));
      return;
    }

    const bar = el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn btn-success', on: { click: function () { doRestore(tr.items.map(function (x) { return x.trashPath; })); } } }, [ctx.icon('rotate'), el('span', { text: '全部还原' })]),
      el('button', { class: 'btn btn-danger', on: { click: function () { doPurge(tr.items.map(function (x) { return x.trashPath; })); } } }, [ctx.icon('trash'), el('span', { text: '全部永久删除' })])
    ]);
    host.appendChild(bar);

    const list = el('div', { class: 'col gap-6', style: { maxHeight: '520px', overflow: 'auto' } });
    for (const it of tr.items) {
      list.appendChild(el('div', { class: 'panel row gap-10', style: { padding: '8px 10px', alignItems: 'center', opacity: it.exists ? '1' : '.5' } }, [
        el('div', { class: 'col grow', style: { minWidth: 0 } }, [
          el('div', { class: 'ellipsis', style: { fontWeight: '600', fontSize: '12.5px' }, text: it.title || it.dir }),
          el('div', { class: 'label-mono', text: (it.rootId || '') + ' · ' + it.images + ' 图 · ' + ctx.fmt.bytes(it.bytes) + ' · ' + ctx.fmt.date(it.at) + (it.exists ? '' : ' · 文件已丢失') })
        ]),
        el('button', { class: 'btn btn-sm btn-success', disabled: !it.exists, on: { click: function () { doRestore([it.trashPath]); } } }, [ctx.icon('rotate'), el('span', { text: '还原' })]),
        el('button', { class: 'btn btn-sm btn-danger', on: { click: function () { doPurge([it.trashPath]); } } }, [ctx.icon('trash')])
      ]));
    }
    host.appendChild(list);

    async function doRestore(paths) {
      try {
        const r = await ctx.post('/api/vault/trash/restore', { ids: paths });
        ctx.toast(r.message, 'ok');
        refresh(); renderTrash();
      } catch (err) { ctx.toast('还原失败：' + err.message, 'err'); }
    }
    async function doPurge(paths) {
      const ok = await ctx.confirm('永久删除这 ' + paths.length + ' 个条目？\n\n会同时删掉回收站里的文件，无法恢复。', { danger: true, okText: '永久删除' });
      if (!ok) return;
      const input = await ctx.prompt('请输入 DELETE 以确认永久删除：', '', { title: '安全确认', okText: '执行' });
      if (String(input || '').trim().toUpperCase() !== 'DELETE') { ctx.toast('确认文本不正确，已取消', 'warn'); return; }
      try {
        const r = await ctx.post('/api/vault/trash/purge', { ids: paths, confirm: 'DELETE' });
        ctx.toast(r.message, 'ok');
        refresh(); renderTrash();
      } catch (err) { ctx.toast('删除失败：' + err.message, 'err'); }
    }
  }
  async function renderStats() {
    host.textContent = '';
    let st = null, rs = null, dup = null;
    try {
      st = (await ctx.get('/api/vault/stats')).stats;
      rs = (await ctx.get('/api/vault/reading-stats')).stats;
      dup = (await ctx.get('/api/vault/duplicates')).result;
    } catch (err) { host.appendChild(errBox(err, renderStats)); return; }

    host.appendChild(el('div', { class: 'stat-row', style: { marginBottom: '14px' } }, [
      statCell(String(st.comics), '漫画', 'var(--red)'),
      statCell(ctx.fmt.num(st.images), '图片', 'var(--paper)'),
      statCell(st.bytesText, '占用', 'var(--cyan)'),
      statCell(String(st.multi) + '/' + String(st.single), '多话/单话', 'var(--yellow)'),
      statCell(ctx.fmt.dur((rs.totalSeconds || 0) * 1000), '累计阅读', 'var(--pink)')
    ]));

    const col = el('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))' } });
    col.appendChild(el('div', { class: 'card card-pad col gap-8' }, [
      el('div', { class: 'section-title', text: '按库根' }),
      el('div', { class: 'ledger' }, Object.keys(st.byRoot).map(function (k) {
        const r = st.byRoot[k];
        return row(r.name + '（' + r.comics + ' 部）', ctx.fmt.bytes(r.bytes));
      }))
    ]));
    col.appendChild(el('div', { class: 'card card-pad col gap-8' }, [
      el('div', { class: 'section-title', text: '作者 Top 20' }),
      el('div', { class: 'ledger' }, st.topAuthors.map(function (a) { return row(a.name, String(a.count)); }))
    ]));
    col.appendChild(el('div', { class: 'card card-pad col gap-8' }, [
      el('div', { class: 'section-title', text: '体积 Top 10' }),
      el('div', { class: 'ledger' }, st.biggest.map(function (b) { return row(b.title, ctx.fmt.bytes(b.bytes)); }))
    ]));
    col.appendChild(el('div', { class: 'card card-pad col gap-8' }, [
      el('div', { class: 'section-title', text: '阅读时长 Top' }),
      el('div', { class: 'ledger' }, (rs.comics || []).slice(0, 12).map(function (r) { return row(r.title, ctx.fmt.dur(r.seconds * 1000)); }).concat([row('— 合计', rs.totalText || '0 秒')]))
    ]));
    col.appendChild(el('div', { class: 'card card-pad col gap-8' }, [
      el('div', { class: 'section-title', text: '重复候选（' + dup.count + ' 组）' }),
      dup.count ? el('div', { class: 'col gap-6', style: { maxHeight: '260px', overflow: 'auto' } }, dup.groups.slice(0, 40).map(function (g) {
        return el('div', { class: 'col gap-3', style: { paddingBottom: '6px', borderBottom: '1px dotted var(--line)' } }, [
          el('div', { class: 'row gap-6' }, [el('span', { class: 'stamp ' + (g.confidence > 0.9 ? '' : 'stamp-yellow'), text: Math.round(g.confidence * 100) + '%' }), el('span', { class: 'small muted', text: g.reason })]),
          el('div', { class: 'col' }, g.items.map(function (x) { return el('div', { class: 'mono small ellipsis', text: '· ' + x.rootName + ' / ' + x.dir + '（' + x.images + ' 图）' }); }))
        ]);
      })) : el('div', { class: 'small muted', text: '没有发现重复候选' })
    ]));
    host.appendChild(col);
  }
  async function renderShelves() {
    host.textContent = '';
    let s = null;
    try { s = (await ctx.get('/api/vault/shelves')).shelves || []; }
    catch (err) { host.appendChild(errBox(err, renderShelves)); return; }

    const name = el('input', { class: 'input', placeholder: '书架名，如「全彩短篇」', style: { maxWidth: '220px' } });
    const tagInput = el('input', { class: 'input', placeholder: '标签（逗号分隔，AND 关系）', style: { maxWidth: '260px' } });
    const authorInput = el('input', { class: 'input', placeholder: '作者（可选）', style: { maxWidth: '160px' } });
    const rootSel = el('select', { class: 'select', style: { width: '160px' } }, [el('option', { value: '', text: '全部库根' })].concat(S.roots.map(function (r) { return el('option', { value: r.id, text: r.name }); })));
    const saveBtn = el('button', { class: 'btn btn-primary', on: { click: save } }, [ctx.icon('save'), el('span', { text: '保存书架' })]);

    async function save() {
      const n = name.value.trim();
      if (!n) { ctx.toast('请填写书架名', 'warn'); return; }
      const query = {};
      const tags = parseCsv(tagInput.value);
      if (tags.length) { query.tags = tags.join(','); query.mode = 'and'; }
      if (authorInput.value.trim()) query.author = authorInput.value.trim();
      if (rootSel.value) query.root = rootSel.value;
      try {
        const r = await ctx.post('/api/vault/shelves', { name: n, query: query });
        ctx.toast(r.message, 'ok');
        name.value = ''; tagInput.value = ''; authorInput.value = '';
        refresh(); renderShelves();
      } catch (err) { ctx.toast('保存失败：' + err.message, 'err'); }
    }

    host.appendChild(el('div', { class: 'toolbar' }, [ctx.icon('bookmark'), name, tagInput, authorInput, rootSel, saveBtn]));
    host.appendChild(el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { class: 'grow', text: '书架保存的是查询条件（不是快照），点开时实时出结果。' })]));

    if (!s.length) { host.appendChild(ctx.empty('还没有书架', '填个名字和筛选条件，保存即可')); return; }

    const list = el('div', { class: 'col gap-8' });
    for (const sh of s) {
      list.appendChild(el('div', { class: 'card card-pad row gap-10', style: { alignItems: 'center' } }, [
        el('div', { class: 'col grow', style: { minWidth: 0 } }, [
          el('div', { style: { fontWeight: '650' }, text: sh.name }),
          el('div', { class: 'label-mono', text: Object.keys(sh.query || {}).map(function (k) { return k + '=' + sh.query[k]; }).join('  ·  ') || '无筛选条件' })
        ]),
        el('button', { class: 'btn btn-sm', on: { click: function () { openShelf(sh); } } }, [ctx.icon('eye'), el('span', { text: '打开' })]),
        el('button', { class: 'btn btn-sm btn-danger', on: { click: async function () {
          const ok = await ctx.confirm('删除书架「' + sh.name + '」？', { danger: true, okText: '删除' });
          if (!ok) return;
          try { await ctx.api('/api/vault/shelves?id=' + encodeURIComponent(sh.id), { method: 'DELETE' }); ctx.toast('已删除', 'ok'); renderShelves(); }
          catch (e) { ctx.toast('删除失败：' + e.message, 'err'); }
        } } }, [ctx.icon('trash')])
      ]));
    }
    host.appendChild(list);

    async function openShelf(sh) {
      const qs = new URLSearchParams(sh.query || {}).toString();
      try {
        const r = await ctx.get('/api/vault/search?' + qs);
        const body = el('div', { class: 'col gap-6', style: { maxHeight: '60vh', overflow: 'auto' } }, (r.items || []).map(function (c) {
          return el('div', { class: 'ledger-row' }, [
            el('span', { class: 'k', text: c.rootName || '' }),
            el('span', { class: 'ellipsis grow', text: c.title }),
            el('span', { class: 'v', text: c.images + ' 图' }),
            el('button', { class: 'btn btn-icon btn-sm btn-ghost', on: { click: function () { ctx.navigate('#/reader?comic=' + c.id); } } }, [ctx.icon('play')])
          ]);
        }));
        ctx.modal({ title: sh.name + ' · ' + r.total + ' 部', wide: true, body: body });
      } catch (err) { ctx.toast('打开失败：' + err.message, 'err'); }
    }
  }
  async function renderBackup() {
    host.textContent = '';
    let b = null;
    try { b = await ctx.get('/api/vault/backup'); }
    catch (err) { host.appendChild(errBox(err, renderBackup)); return; }

    host.appendChild(el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn btn-primary', on: { click: make } }, [ctx.icon('database'), el('span', { text: '立即备份' })]),
      el('div', { class: 'grow' }),
      el('span', { class: 'label-mono', text: '自动保留最近 10 份 · 存放 ' + b.dir })
    ]));
    host.appendChild(el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { class: 'grow', text: '备份包含：库索引、阅读进度、收藏、标签、覆盖层、书架、阅读时长。不含漫画图片本身。' })]));

    async function make() {
      try {
        const r = await ctx.post('/api/vault/backup', { note: '手动备份' });
        ctx.toast(r.message, 'ok');
        renderBackup();
      } catch (err) { ctx.toast('备份失败：' + err.message, 'err'); }
    }

    if (!b.items.length) { host.appendChild(ctx.empty('还没有备份', '点「立即备份」创建第一份')); return; }

    const list = el('div', { class: 'col gap-6' });
    for (const it of b.items) {
      list.appendChild(el('div', { class: 'panel row gap-10', style: { padding: '8px 10px', alignItems: 'center' } }, [
        ctx.icon('save'),
        el('div', { class: 'col grow', style: { minWidth: 0 } }, [
          el('div', { class: 'mono ellipsis', text: it.file }),
          el('div', { class: 'label-mono', text: ctx.fmt.bytes(it.bytes) + ' · ' + ctx.fmt.date(it.mtime) })
        ]),
        el('button', { class: 'btn btn-sm btn-danger', on: { click: function () { restore(it.file); } } }, [ctx.icon('rotate'), el('span', { text: '恢复' })])
      ]));
    }
    host.appendChild(list);

    async function restore(file) {
      const input = await ctx.prompt('恢复会用备份覆盖当前的索引/进度/标签数据。\n请输入 RESTORE 确认：', '', { title: '确认恢复', okText: '继续' });
      if (String(input || '').trim().toUpperCase() !== 'RESTORE') { ctx.toast('已取消', 'warn'); return; }
      try {
        const r = await ctx.post('/api/vault/backup/restore', { file: file, confirm: 'RESTORE' });
        ctx.toast(r.message, 'ok');
        refresh();
      } catch (err) { ctx.toast('恢复失败：' + err.message, 'err'); }
    }
  }

  return {
    renderVerify: renderVerify,
    renderTrash: renderTrash,
    renderStats: renderStats,
    renderShelves: renderShelves,
    renderBackup: renderBackup
  };
}
