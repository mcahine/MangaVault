/**
 * 管理台公共件：错误框 / 等待态 / 装料按钮 / 选料器 / 刷新与载入 / 排版小件。
 *
 * 从 mount() 闭包里搬出来的代码：el / ctx / S / host 原本都是 mount 的同作用域变量，
 * 这里由参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeVaultKit(ctx, S, deps) {
  const el = deps.el;

  function setSub(text) { const n = document.getElementById('mvVaultSub'); if (n) n.textContent = text; }
  function errBox(err, retry) {
    const msg = String((err && err.message) || err || '未知错误');
    const kids = [ctx.icon('alert'), el('span', { class: 'grow', text: msg })];
    if (retry) {
      kids.push(el('button', { class: 'btn btn-sm', dataset: { act: 'retry' }, on: { click: function () { retry(); } } }, [ctx.icon('refresh'), el('span', { text: '重试' })]));
    }
    return el('div', { class: 'alert alert-err' }, kids);
  }
  function waiting(text) {
    return el('div', { class: 'empty' }, [el('div', { class: 'spinner spinner-lg' }), el('div', { class: 'small', text: text || '正在处理…' })]);
  }
  function okBox(text) {
    return el('div', { class: 'alert alert-ok' }, [ctx.icon('check'), el('span', { class: 'grow', text: text })]);
  }
  function parseCsv(raw) {
    return String(raw || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function sigOf(ids, extra) {
    return JSON.stringify([ids.slice().sort(), extra]);
  }
  const FIELD_LABEL = { title: '标题', author: '作者', chineseTeam: '汉化组', description: '简介', tags: '标签', categories: '分类' };
  function diffRow(d) {
    return el('div', { class: 'row gap-8', style: { alignItems: 'center' } }, [
      el('span', { class: 'label-mono', style: { minWidth: '78px' }, text: FIELD_LABEL[d.field] || d.field }),
      el('div', { class: 'mv-vault-diff grow' }, [
        el('span', { class: 'from ellipsis', text: d.from === '' || d.from === undefined ? '(空)' : String(d.from) }),
        ctx.icon('arrow-right'),
        el('span', { class: 'to ellipsis', text: d.to === '' || d.to === undefined ? '(空)' : String(d.to) })
      ])
    ]);
  }
  function downloadJson(fileName, payload) {
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000);
  }
  async function refresh() {
    try {
      const st = await ctx.get('/api/vault/state');
      S.roots = st.roots || [];
      S.tags = (await ctx.get('/api/vault/tags')).tags || [];
      setSub('目录 ' + ((st.catalog && st.catalog.comics) || 0) + ' 部 · 标签 ' + S.tags.length + ' 个 · 书架 ' + st.shelves + ' 个 · 库根 ' + S.roots.length + ' 个');
      return true;
    } catch (err) {
      setSub('读取失败：' + err.message);
      return false;
    }
  }
  async function loadComics() {
    const r = await ctx.get('/api/vault/comics?size=300');
    S.comics = r.items || [];
    S.loadError = null;
    return S.comics;
  }
  async function reloadComicsQuiet() {
    try { await loadComics(); }
    catch (err) { S.comics = []; S.loadError = err; }
  }
  function selectedIds() { return Array.from(S.sel); }
  function makePicker(opts) {
    const o = opts || {};
    const info = el('span', { class: 'label-mono', dataset: { act: 'pick-count' }, text: '已选 0 部' });
    const search = el('input', { class: 'input', placeholder: '按标题 / 作者筛选…', style: { maxWidth: '220px' }, dataset: { act: 'pick-search' } });
    const list = el('div', { class: 'col gap-6', style: { maxHeight: '320px', overflow: 'auto' } });

    function filtered() {
      const kw = search.value.trim().toLowerCase();
      if (!kw) return S.comics;
      return S.comics.filter(function (c) {
        return String(c.title || '').toLowerCase().indexOf(kw) >= 0 || String(c.author || '').toLowerCase().indexOf(kw) >= 0;
      });
    }

    function redraw() {
      info.textContent = '已选 ' + S.sel.size + ' 部';
      list.textContent = '';
      if (S.loadError) { list.appendChild(errBox(S.loadError, reload)); return; }
      const items = filtered();
      if (!items.length) { list.appendChild(el('div', { class: 'small muted', text: S.comics.length ? '没有匹配的漫画' : '目录里还没有漫画，先去「漫画库」扫描一次' })); return; }
      for (const c of items.slice(0, 300)) {
        const on = S.sel.has(c.id);
        list.appendChild(el('div', { class: 'panel row gap-10', style: { padding: '7px 10px', alignItems: 'center' } }, [
          el('div', {
            class: 'checkbox' + (on ? ' on' : ''),
            dataset: { act: 'pick-comic', id: c.id },
            title: on ? '取消选择' : '选择',
            on: { click: function () { if (S.sel.has(c.id)) S.sel.delete(c.id); else S.sel.add(c.id); redraw(); } }
          }),
          el('div', { class: 'col grow', style: { minWidth: 0 } }, [
            el('div', { class: 'ellipsis', style: { fontWeight: '600', fontSize: '12.5px' }, text: c.title }),
            el('div', { class: 'label-mono', text: (c.rootName || '未知库根') + ' · ' + (c.images === null || c.images === undefined ? '未统计' : c.images + ' 图') + (c.hasMeta ? '' : ' · 无元数据') })
          ])
        ]));
      }
    }

    async function reload() {
      S.loadError = null;
      list.textContent = '';
      list.appendChild(waiting('正在读取目录…'));
      await reloadComicsQuiet();
      redraw();
    }

    function pickAll() {
      for (const c of filtered()) S.sel.add(c.id);
      redraw();
    }

    const box = el('div', { class: 'col gap-8' }, [
      el('div', { class: 'toolbar', style: { marginBottom: '0' } }, [
        ctx.icon('list'),
        search,
        el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'pick-all' }, on: { click: pickAll } }, [el('span', { text: '全选（当前筛选）' })]),
        el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'pick-clear' }, on: { click: function () { S.sel.clear(); redraw(); } } }, [el('span', { text: '清空选择' })]),
        el('div', { class: 'grow' }),
        info
      ]),
      el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { class: 'grow', text: o.hint || '勾选漫画后执行批量操作；选择在「标签墙 / 批量元数据 / 跨库搬迁」之间共享。' })]),
      list
    ]);
    search.addEventListener('input', redraw);

    return { node: box, redraw: redraw, reload: reload, search: search };
  }
  function colorOf(c) {
    return ({ red: 'var(--red)', pink: 'var(--pink)', blue: 'var(--blue)', cyan: 'var(--cyan)', yellow: 'var(--yellow)' })[c] || 'var(--paper-dim)';
  }
  function statCell(v, l, color) {
    return el('div', { class: 'stat' }, [el('div', { class: 'stat-value', style: { color: color }, text: v }), el('div', { class: 'stat-label', text: l })]);
  }
  function fld(label, node) {
    return el('div', { class: 'field' }, [el('label', { class: 'label', text: label }), node]);
  }
  function row(k, v) {
    return el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: k }), el('span', { class: 'd' }), el('span', { class: 'v', text: String(v) })]);
  }

  return {
    setSub: setSub,
    errBox: errBox,
    waiting: waiting,
    okBox: okBox,
    parseCsv: parseCsv,
    sigOf: sigOf,
    diffRow: diffRow,
    downloadJson: downloadJson,
    refresh: refresh,
    loadComics: loadComics,
    reloadComicsQuiet: reloadComicsQuiet,
    selectedIds: selectedIds,
    makePicker: makePicker,
    colorOf: colorOf,
    statCell: statCell,
    fld: fld,
    row: row
  };
}
