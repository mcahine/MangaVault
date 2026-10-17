export const meta = { id: 'vault', name: '管理台', order: 30 };

/**
 * 管理台前端（RISOPRINT 体系）。
 *
 * 与后端 src/modules/vault/index.mjs 的路由一一对应；破坏性操作一律「先预演 → 用户确认 → 执行 → 可撤销」：
 *   标签墙     批量加/删标签（POST /api/vault/tags/assign，先传 dryRun:true 预演）
 *   批量元数据 作者 / 汉化组 / 简介 / 标签 / 分类（/api/vault/meta/plan → /api/vault/meta/batch）
 *   导出导入   /api/vault/meta/export（下载 JSON 文件）→ /api/vault/meta/import（先预演条数再确认）
 *   跨库搬迁   /api/vault/move/plan（展示重名冲突、跨盘、目标路径）→ /api/vault/move
 *   孤儿清理   /api/vault/orphans（扫描即预演）→ /api/vault/orphans/clean（二次确认 + 输入 CLEAN）
 *   审计与撤销 /api/vault/audit · /api/vault/audit/undoable · /api/vault/audit/undo · /api/vault/audit/archive/:id
 *
 * 约定：
 *   - 接口失败一律显示中文错误 + 「重试」按钮，**绝不静默退化成空数据**；
 *   - 所有可点控件带 data-act（与阅读器同一约定），测试不得用 nth-child 定位；
 *   - 不用模板字符串 / 两空格缩进 / 单引号 / 中文注释与文案。
 */
export async function mount(root, ctx) {
  const el = ctx.el;
  ctx.title('管理台', '标签 · 批量元数据 · 搬迁 · 孤儿 · 审计');

  const S = {
    tab: ctx.state.get('vault.tab', 'tags'),
    comics: [],
    tags: [],
    roots: [],
    sel: new Set(),
    loadError: null,
    // 预演签名：输入或选择一变，旧的预演就作废，必须重新预演才能执行
    tagPlanSig: '',
    metaPlanSig: '',
    movePlanSig: '',
    auditPage: 1,
    auditAction: ''
  };
  const host = el('div');

  const TABS = [
    ['tags', '标签墙', 'tag'],
    ['meta', '批量元数据', 'pencil'],
    ['move', '跨库搬迁', 'arrow-right'],
    ['orphans', '孤儿清理', 'alert'],
    ['audit', '审计与撤销', 'clock'],
    ['batch', '批量整理', 'scissors'],
    ['verify', '校验修复', 'shield'],
    ['trash', '回收站', 'archive'],
    ['stats', '统计', 'gauge'],
    ['shelves', '书架', 'bookmark'],
    ['backup', '备份', 'database']
  ];

  const tabbar = el('div', { class: 'tabbar' }, TABS.map(function (t) {
    return el('div', {
      class: 'tab' + (S.tab === t[0] ? ' active' : ''),
      dataset: { tab: t[0], act: 'vault-tab' },
      on: { click: function () { switchTab(t[0]); } }
    }, [ctx.icon(t[2]), el('span', { text: t[1] })]);
  }));

  root.appendChild(el('div', { class: 'page' }, [
    el('div', { class: 'page-head' }, [
      el('div', { class: 'col' }, [
        el('h2', { class: 'page-title misprint', text: '管理台' }),
        el('div', { class: 'page-sub', id: 'mvVaultSub', text: '正在读取库目录…' })
      ]),
      el('div', { class: 'row gap-6' }, [
        el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'vault-refresh' }, on: { click: refresh }, title: '重新读取目录与标签' }, [ctx.icon('refresh'), el('span', { text: '刷新' })]),
        el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'vault-quick-verify' }, on: { click: runVerifyQuick } }, [ctx.icon('shield'), el('span', { text: '快速体检' })])
      ])
    ]),
    tabbar,
    host
  ]));

  function switchTab(tab) {
    S.tab = tab;
    ctx.state.set('vault.tab', tab);
    const tabs = tabbar.querySelectorAll('.tab');
    for (const t of tabs) t.classList.toggle('active', t.dataset.tab === tab);
    render();
  }

  function setSub(text) { const n = document.getElementById('mvVaultSub'); if (n) n.textContent = text; }

  /* ================= 通用件 ================= */

  /** 错误提示 + 重试按钮：任何接口失败都走这里，不伪造空数据 */
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

  /** 逗号（含全角）分隔转数组 */
  function parseCsv(raw) {
    return String(raw || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /** 预演签名：ids 排序 + 参数序列化，用于判断「用户看到的预演」是否还对应当前输入 */
  function sigOf(ids, extra) {
    return JSON.stringify([ids.slice().sort(), extra]);
  }

  const FIELD_LABEL = { title: '标题', author: '作者', chineseTeam: '汉化组', description: '简介', tags: '标签', categories: '分类' };

  /** 单条字段差异：旧值（划掉）→ 新值 */
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

  /** 浏览器端落盘一个 JSON 文件（零依赖，不用 CDN） */
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

  /** 载入清单失败时不吞错：把错误挂在 S.loadError 上，交给 picker 显示 + 重试 */
  async function reloadComicsQuiet() {
    try { await loadComics(); }
    catch (err) { S.comics = []; S.loadError = err; }
  }

  function selectedIds() { return Array.from(S.sel); }

  /**
   * 通用选料器：勾选多部漫画。
   * 选择在「标签墙 / 批量元数据 / 跨库搬迁」三个页签之间共享（同一个 S.sel）。
   */
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

  /* ================= 标签墙（含批量标签编辑） ================= */
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

  function colorOf(c) {
    return ({ red: 'var(--red)', pink: 'var(--pink)', blue: 'var(--blue)', cyan: 'var(--cyan)', yellow: 'var(--yellow)' })[c] || 'var(--paper-dim)';
  }

  function statCell(v, l, color) {
    return el('div', { class: 'stat' }, [el('div', { class: 'stat-value', style: { color: color }, text: v }), el('div', { class: 'stat-label', text: l })]);
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

  /* ================= 批量元数据（改 / 导出 / 导入） ================= */
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

  /* ================= 跨库根批量搬迁 ================= */
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

  /* ================= 孤儿清理 ================= */
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

  /* ================= 审计日志 + 撤销 ================= */
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

  /* ================= 批量整理 ================= */
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

  /* ================= 校验修复 ================= */
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

  const CODE_LABEL = { zero: '0 字节文件', tiny: '文件过小', header: '图片头异常', truncated: 'JPEG 截断', gap: '序号断档', 'no-chapter-meta': '缺章节元数据', 'chapter-meta-field': '章节元数据缺字段', 'no-cover': '缺封面', 'no-meta': '缺元数据', dirname: '目录名不规范' };
  const ACTION_LABEL = { 'write-chapter-meta': '补章节元数据', 'make-cover': '生成封面' };

  /* ================= 回收站 ================= */
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

  /* ================= 统计 ================= */
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

  /* ================= 书架 ================= */
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

  /* ================= 备份 ================= */
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

  /* ================= 单部元数据编辑 ================= */
  function editMeta(c) {
    const title = el('input', { class: 'input', value: c.title || '' });
    const author = el('input', { class: 'input', value: c.author || '' });
    const team = el('input', { class: 'input', value: c.chineseTeam || '' });
    const tags = el('input', { class: 'input', value: (c.tags || []).join(', '), placeholder: '逗号分隔' });
    const cats = el('input', { class: 'input', value: (c.categories || []).join(', '), placeholder: '逗号分隔' });
    const desc = el('textarea', { class: 'textarea', value: c.description || '' });
    const m = ctx.modal({
      title: '编辑元数据 · ' + c.title,
      body: el('div', { class: 'col gap-10' }, [
        el('div', { class: 'alert alert-warn' }, [ctx.icon('alert'), el('span', { class: 'grow', text: '会写入该漫画目录下的 元数据.json（原文件自动备份为 元数据.json.bak）。' })]),
        fld('标题', title), fld('作者', author), fld('汉化组', team),
        fld('标签', tags), fld('分类', cats), fld('简介', desc)
      ])
    });
    m.foot.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', on: { click: function () { m.close(); } } }));
    m.foot.appendChild(el('button', { class: 'btn btn-primary', text: '保存', on: { click: async function () {
      try {
        const r = await ctx.post('/api/vault/comic/' + encodeURIComponent(c.id) + '/meta', {
          title: title.value.trim(), author: author.value.trim(), chineseTeam: team.value.trim(),
          tags: parseCsv(tags.value), categories: parseCsv(cats.value), description: desc.value
        });
        ctx.toast(r.message, 'ok');
        m.close();
        invalidate();
        switchTab(S.tab);
      } catch (err) { ctx.toast('保存失败：' + err.message, 'err'); }
    } } }));
  }

  function fld(label, node) {
    return el('div', { class: 'field' }, [el('label', { class: 'label', text: label }), node]);
  }

  function invalidate() { ctx.post('/api/vault/refresh', {}).catch(function () {}); }

  function row(k, v) {
    return el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: k }), el('span', { class: 'd' }), el('span', { class: 'v', text: String(v) })]);
  }

  async function runVerifyQuick() { switchTab('verify'); }

  async function render() {
    switch (S.tab) {
      case 'tags': return renderTags();
      case 'meta': return renderMeta();
      case 'move': return renderMove();
      case 'orphans': return renderOrphans();
      case 'audit': return renderAudit();
      case 'batch': return renderBatch();
      case 'verify': return renderVerify();
      case 'trash': return renderTrash();
      case 'stats': return renderStats();
      case 'shelves': return renderShelves();
      case 'backup': return renderBackup();
      default: return renderTags();
    }
  }

  await refresh();
  await render();
}
