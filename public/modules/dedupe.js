/* 查重模块前端（dedupe-smith）
   只使用 theme.css 已有类 + 本模块 dedupe.css 的 mv- 前缀类；全部经 ctx API 渲染。 */

export const meta = { id: 'dedupe', name: '查重', order: 40 };

// 「待人工复核」是快速查重专用的判定：拿不到像素证据时，判定权完全交给用户
//（系统绝不自动判重复、绝不自动删除）。它不出现在完整扫描的筛选条里。
const VERDICT_CHIPS = [
  { id: '', label: '全部' },
  { id: '完全重复', label: '完全重复', badge: 'badge-err' },
  { id: '同图不同编码', label: '同图不同编码', badge: 'badge-warn' },
  { id: '部分重复', label: '部分重复', badge: 'badge-accent' },
  { id: '未找到', label: '未找到', badge: 'badge-ok' },
  // 快速查重专用的判定：像素证据缺失时判定权完全交给用户
  { id: '待人工复核', label: '待人工复核', badge: 'badge-warn' }
];

const MODES = [
  { id: 'recycle', label: '移入回收站', hint: '可从系统回收站还原（默认，最安全）' },
  { id: 'quarantine', label: '移动到隔离区', hint: '移到 data/dedupe/已确认删除/，之后可一键还原' },
  { id: 'permanent', label: '永久删除', hint: '直接从磁盘删除，无法恢复' }
];

// deleted 由后端在「执行删除」成功后回写（磁盘上已经没了），不提供手动选择。
const DECISION_TEXT = { keep: '已保留', delete: '待删除', pending: '未定', deleted: '已删除' };
// 候选复核里的三选文案（keep=不是重复 / delete=确认重复可删 / pending=拿不准）
const CAND_STATE_TEXT = { keep: '已判：不是重复', delete: '已判：确认重复（可删）', pending: '拿不准（待定）', deleted: '已删除' };

function ensureStyle() {
  if (document.getElementById('mv-dedupe-style')) return;
  const link = document.createElement('link');
  link.id = 'mv-dedupe-style';
  link.rel = 'stylesheet';
  link.href = '/modules/dedupe.css';
  document.head.appendChild(link);
}

function badgeOf(verdict) {
  for (const c of VERDICT_CHIPS) if (c.id === verdict) return c.badge || 'badge';
  return 'badge';
}

/**
 * 缩略图地址。
 * root 是「相对哪个库根」的基准：库侧图片在多库根下用「根 id + 相对根的路径」寻址，
 * 不带 root 时后端只能退回到「命中章节目录 + 单段文件名」的旧寻址方式，
 * 一旦该图属于非首个库根就会 404 —— 表现为卡片右半边永远是「图片读取失败」。
 */
/**
 * 单元的显示名。
 * 库格式正规化（L0 裸形态 → L2 嵌套形态）之后，单元的 name 变成了章节目录名（「1 第1話」），
 * 而同一部漫画的每一章都叫这个，直接显示的话用户在候选页根本看不出是哪部作品，
 * 删除弹窗里也分不清是哪一章。id 是相对查重根的路径，第一段才是作品。
 */
function unitLabel(u) {
  const id = String((u && u.id) || '');
  const name = String((u && u.name) || '');
  if (id.indexOf('/') >= 0) {
    const head = id.split('/')[0];
    return head && name && head !== name ? head + ' · ' + name : (head || name || id);
  }
  return name || id;
}

function thumbUrl(id, side, name, full, root) {
  const qs = new URLSearchParams();
  qs.set('unit', id);
  qs.set('side', side);
  qs.set('name', name);
  if (full) qs.set('full', '1');
  if (side === 'lib' && root) qs.set('root', root);
  return '/api/dedupe/thumb?' + qs.toString();
}

function decisionOf(u) { return (u && u.decision && u.decision.verdict) || 'pending'; }

/**
 * 自带确认框。
 * 不能用 ctx.confirm：外壳 modal() 只在 foot 非空时才渲染 .modal-foot，
 * confirmDialog 把按钮挂到了脱离文档的 div 上（download/library 也一样受影响），按钮点不到。
 * 这里把按钮直接交给 opts.foot，外壳就会正确渲染。
 */
function askConfirm(ctx, message, opts) {
  const o = opts || {};
  return new Promise(function (resolve) {
    let settled = false;
    function finish(v) { if (settled) return; settled = true; m.close(); resolve(v); }
    const cancel = ctx.el('button', { class: 'btn btn-ghost', text: o.cancelText || '取消' });
    const ok = ctx.el('button', { class: 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary'), text: o.okText || '确定' });
    const m = ctx.modal({
      title: o.title || '请确认',
      onClose: function () { if (!settled) { settled = true; resolve(false); } },
      body: ctx.el('div', { class: 'col gap-10' }, [
        ctx.el('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.6' }, text: message }),
        o.danger ? ctx.el('div', { class: 'alert alert-err' }, [ctx.el('span', { text: '此操作不可撤销，请谨慎。' })]) : null
      ]),
      foot: [cancel, ok]
    });
    ctx.on(cancel, 'click', function () { finish(false); });
    ctx.on(ok, 'click', function () { finish(true); });
    ok.focus();
  });
}

export async function mount(root, ctx) {
  ensureStyle();
  ctx.title('查重台', '扫描查重目录，与漫画库比对后人工审核');

  const st = { page: 1, size: 24, verdict: '', q: '', decided: '', data: null, scanning: false, busy: false, candData: null, fastPending: false };

  const statRow = ctx.el('div', { class: 'stat-row' });
  const chipRow = ctx.el('div', { class: 'mv-dedupe-chips' });
  const searchInput = ctx.el('input', { class: 'input', placeholder: '搜索单元名 / 分类 / 章节…' });
  const searchbox = ctx.el('div', { class: 'searchbox', style: { maxWidth: '280px' } }, [ctx.icon('search'), searchInput]);
  const progressBar = ctx.el('i', { style: { width: '0%' } });
  const progressText = ctx.el('div', { class: 'mv-progress-head' });
  const progressMsg = ctx.el('div', { class: 'mv-progress-msg' });
  const progressWrap = ctx.el('div', { class: 'card mv-progress-wrap hidden' }, [
    ctx.el('div', { class: 'progress' }, [progressBar]), progressText, progressMsg
  ]);
  const listHost = ctx.el('div');
  const pager = ctx.el('div', { class: 'row between', style: { marginTop: '14px' } });

  /* 人在环候选复核区块：默认隐藏，点「快速查重」跑完或点「候选复核」后展开。
     数据来自 GET /api/dedupe/candidates（读快速模式的 scan-fast.json，文件不存在就是空列表）。 */
  const candCount = ctx.el('span', { class: 'muted small' });
  const candNote = ctx.el('div', { class: 'small muted' });
  const candHost = ctx.el('div');
  const btnCandReload = ctx.el('button', { class: 'btn btn-sm' }, [ctx.icon('refresh'), ctx.el('span', { text: '刷新候选' })]);
  const btnCandClose = ctx.el('button', { class: 'btn btn-sm btn-ghost' }, [ctx.icon('x'), ctx.el('span', { text: '收起' })]);
  const candWrap = ctx.el('div', { class: 'card col gap-10 hidden', style: { padding: '14px', marginBottom: '14px' } }, [
    ctx.el('div', { class: 'row between' }, [
      ctx.el('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } }, [
        ctx.el('div', { class: 'section-title', text: '候选复核（人在环）' }),
        candCount
      ]),
      ctx.el('div', { class: 'row', style: { gap: '6px' } }, [btnCandReload, btnCandClose])
    ]),
    candNote,
    candHost
  ]);

  const btnFast = ctx.el('button', { class: 'btn btn-primary', title: '只给「标题+页数」对得上的候选建指纹并比对，通常十几秒；完整扫描约 13 分钟' }, [ctx.icon('sparkles'), ctx.el('span', { text: '快速查重' })]);
  const btnRescan = ctx.el('button', { class: 'btn btn-primary', title: '全量：建全库指纹 + 像素比对 + 缩略图，本机约 13 分钟，且随漫画增多线性变长' }, [ctx.icon('refresh'), ctx.el('span', { text: '重新扫描（全量约 13 分钟）' })]);
  const btnCand = ctx.el('button', { class: 'btn' }, [ctx.icon('eye'), ctx.el('span', { text: '候选复核' })]);
  const btnPixel = ctx.el('button', { class: 'btn' }, [ctx.icon('layers'), ctx.el('span', { text: '深度比对（仅像素）' })]);
  const btnFp = ctx.el('button', { class: 'btn' }, [ctx.icon('wand'), ctx.el('span', { text: '重建全库指纹' })]);
  const btnAbort = ctx.el('button', { class: 'btn btn-danger' }, [ctx.icon('x'), ctx.el('span', { text: '中止' })]);
  const btnDelete = ctx.el('button', { class: 'btn btn-danger' }, [ctx.icon('trash'), ctx.el('span', { text: '执行删除…' })]);
  const btnQuar = ctx.el('button', { class: 'btn btn-ghost' }, [ctx.icon('folder'), ctx.el('span', { text: '隔离区' })]);
  btnAbort.disabled = true;

  const toolbar = ctx.el('div', { class: 'toolbar' }, [
    btnFast, btnRescan, btnCand, btnPixel, btnFp, btnAbort,
    ctx.el('div', { class: 'mv-dedupe-toolbar-right' }, [btnQuar, btnDelete])
  ]);

  chipRow.appendChild(ctx.el('span', { class: 'small muted', text: '判定：' }));
  for (const c of VERDICT_CHIPS) {
    chipRow.appendChild(ctx.el('div', { class: 'chip' + (c.id === '' ? ' active' : ''), text: c.label, dataset: { verdict: c.id } }));
  }
  const chipDecided = ctx.el('div', { class: 'chip', text: '只看有决策', dataset: { decided: '1' } });
  chipRow.appendChild(chipDecided);
  chipRow.appendChild(searchbox);

  root.appendChild(ctx.el('div', { class: 'page' }, [
    ctx.el('div', { class: 'page-head' }, [
      ctx.el('div', { class: 'page-title', text: '查重台' }),
      ctx.el('div', { class: 'page-sub', text: '扫描查重目录，与漫画库做字节/像素比对，人工确认后执行删除' })
    ]),
    statRow, progressWrap, candWrap, toolbar, chipRow, listHost, pager
  ]));

  // ================= 渲染 ==================
  function statCard(label, value, sub) {
    return ctx.el('div', { class: 'card stat' }, [
      ctx.el('div', { class: 'stat-value', text: String(value) }),
      ctx.el('div', { class: 'stat-label', text: label }),
      sub ? ctx.el('div', { class: 'mv-stat-sub', text: sub }) : null
    ]);
  }

  function renderStats(s) {
    statRow.textContent = '';
    const stats = s || { units: 0, images: 0, byVerdict: {}, reclaimableBytes: 0, markedBytes: 0 };
    const bv = stats.byVerdict || {};
    statRow.appendChild(statCard('单元总数', ctx.fmt.num(stats.units || 0), '图片 ' + ctx.fmt.num(stats.images || 0) + ' 张'));
    statRow.appendChild(statCard('完全重复', ctx.fmt.num(bv['完全重复'] || 0), '字节完全一致'));
    statRow.appendChild(statCard('同图不同编码', ctx.fmt.num(bv['同图不同编码'] || 0), '像素一致编码不同'));
    statRow.appendChild(statCard('部分重复', ctx.fmt.num(bv['部分重复'] || 0), '命中率 ≥ 30%'));
    statRow.appendChild(statCard('未找到', ctx.fmt.num(bv['未找到'] || 0), '库内没有'));
    statRow.appendChild(statCard('可清理体积', ctx.fmt.bytes(stats.reclaimableBytes || 0), '待删除 ' + ctx.fmt.bytes(stats.markedBytes || 0)));
  }

  function sideBox(url, label) {
    const box = ctx.el('div', { class: 'mv-side' });
    if (!url) {
      box.appendChild(ctx.el('div', { class: 'mv-side-empty' }, [ctx.icon('image'), ctx.el('span', { text: '无对应图片' })]));
    } else {
      const img = ctx.el('img', { src: url, alt: label, loading: 'lazy' });
      img.addEventListener('error', function () {
        img.remove();
        box.appendChild(ctx.el('div', { class: 'mv-side-empty' }, [ctx.icon('image'), ctx.el('span', { text: '图片读取失败' })]));
      });
      box.appendChild(img);
    }
    box.appendChild(ctx.el('span', { class: 'mv-side-tag', text: label }));
    return box;
  }

  function renderCard(u) {
    const dec = decisionOf(u);
    const cls = 'card mv-card mv-decided' + (dec === 'keep' ? ' mv-decided-keep' : dec === 'delete' ? ' mv-decided-delete' : '');
    const card = ctx.el('div', { class: cls });
    const first = (u.samples || [])[0] || null;
    const libSample = (u.samples || []).find(function (s) { return s.lib; }) || null;
    const dupUrl = first ? thumbUrl(u.id, 'dup', first.dup) : '';
    const libUrl = u.libDir && libSample ? thumbUrl(u.id, 'lib', libSample.lib, false, libSample.root || u.libRootId) : '';
    card.appendChild(ctx.el('div', { class: 'mv-card-pair' }, [
      sideBox(dupUrl, '本单元'),
      sideBox(libUrl, u.comic ? '库内 · ' + u.comic : '库内')
    ]));
    card.appendChild(ctx.el('div', { class: 'mv-card-body' }, [
      ctx.el('div', { class: 'mv-card-title ellipsis', title: u.id, text: unitLabel(u) }),
      ctx.el('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, [
        ctx.el('span', { class: 'badge ' + badgeOf(u.judge), text: u.judge }),
        ctx.el('span', { class: 'badge' + (dec === 'pending' ? '' : ' badge-accent'), text: DECISION_TEXT[dec] })
      ]),
      ctx.el('div', { class: 'mv-card-meta' }, [
        ctx.el('span', { text: '命中 ' + (u.exactCount + u.pixelCount) + '/' + u.dupCount + ' 张' }),
        ctx.el('span', { text: ctx.fmt.bytes(u.dupBytes || 0) }),
        u.maxMad != null ? ctx.el('span', { text: '最大误差 ' + u.maxMad }) : null
      ]),
      u.chapterTitle ? ctx.el('div', { class: 'mv-card-meta ellipsis' }, [ctx.el('span', { text: '→ ' + u.chapterTitle })]) : null
    ]));
    const btnDetail = ctx.el('button', { class: 'btn btn-sm', text: '查看详情' });
    const btnDel = ctx.el('button', { class: 'btn btn-sm ' + (dec === 'delete' ? 'btn-danger' : 'btn-ghost'), text: '删除' });
    const btnKeep = ctx.el('button', { class: 'btn btn-sm ' + (dec === 'keep' ? 'btn-success' : 'btn-ghost'), text: '保留' });
    card.appendChild(ctx.el('div', { class: 'mv-card-actions' }, [btnDetail, btnDel, btnKeep]));
    ctx.on(card, 'click', function (e) { if (!e.target.closest('button')) openDetail(u); });
    ctx.on(btnDetail, 'click', function (e) { e.stopPropagation(); openDetail(u); });
    ctx.on(btnDel, 'click', function (e) { e.stopPropagation(); decide(u, 'delete'); });
    ctx.on(btnKeep, 'click', function (e) { e.stopPropagation(); decide(u, 'keep'); });
    return card;
  }

  function renderList(data) {
    listHost.textContent = '';
    if (data && data.degraded) {
      listHost.appendChild(ctx.el('div', { class: 'alert alert-warn' }, [
        ctx.icon('alert'),
        ctx.el('span', { text: '像素级能力不可用，当前只有 SHA-256 字节查重结果。原因：' + (data.degradeReason || '未知') })
      ]));
    }
    // 后端已按「已删除」过滤（GET /api/dedupe/units 默认排除），这里再兜底一次：
    // 万一拿到的是删除前的旧响应或旧扫描缓存，也不会去请求已经 404 的缩略图。
    const units = ((data && data.units) || []).filter(function (u) { return decisionOf(u) !== 'deleted'; });
    if (!units.length) {
      const hasScan = Boolean(data && data.scanAt);
      listHost.appendChild(ctx.el('div', { class: 'empty' }, [
        ctx.icon(hasScan ? 'search' : 'layers'),
        ctx.el('div', { class: 'empty-title', text: hasScan ? '没有符合筛选条件的单元' : '还没有扫描结果' }),
        ctx.el('div', { class: 'small', text: hasScan ? '试试切换判定筛选或清空关键字' : '点击「重新扫描」开始与漫画库比对' })
      ]));
      return;
    }
    const grid = ctx.el('div', { class: 'grid grid-cards' });
    for (const u of units) grid.appendChild(renderCard(u));
    listHost.appendChild(grid);
  }

  function renderPager(data) {
    pager.textContent = '';
    if (!data) return;
    pager.appendChild(ctx.el('div', { class: 'small muted', text: '共 ' + data.total + ' 个单元 · 第 ' + data.page + '/' + data.pages + ' 页' }));
    const prev = ctx.el('button', { class: 'btn btn-sm', text: '上一页' });
    const next = ctx.el('button', { class: 'btn btn-sm', text: '下一页' });
    prev.disabled = data.page <= 1;
    next.disabled = data.page >= data.pages;
    ctx.on(prev, 'click', function () { if (st.page > 1) { st.page--; load(); } });
    ctx.on(next, 'click', function () { if (st.page < data.pages) { st.page++; load(); } });
    pager.appendChild(ctx.el('div', { class: 'row', style: { gap: '8px' } }, [prev, next]));
  }

  function renderLoading() {
    listHost.textContent = '';
    listHost.appendChild(ctx.el('div', { class: 'empty' }, [
      ctx.el('div', { class: 'spinner spinner-lg' }), ctx.el('div', { class: 'small', text: '正在加载…' })
    ]));
  }

  // ================= 候选复核（人在环） ==================
  /*
    用户原话：找到图片相似和对得上的，交给人眼进行对比，人眼观察抽样后图片对比，来判断是否进行删除。
    所以这里的流程是：快速查重（stage=fast）→ 候选列表 → 每个候选并排看抽样图 → 人工三选 →
    只有点「确认重复（可删）」才把单元标记成 delete（进删除候选），绝不自动删除。
  */

  /** 标题相似度显示成百分比；拿不到就显示 —。 */
  function scoreText(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return Math.round(Math.max(0, Math.min(1, n)) * 100) + '%';
  }

  /** 一页一页并排：左边查重侧、右边库侧。缩略图地址由后端给出（lib 侧自带 root）。 */
  function candPair(item, s, index) {
    const u = item.unit || {};
    const dupUrl = s.dupUrl || (s.dup ? thumbUrl(u.id, 'dup', s.dup) : '');
    const libUrl = s.libUrl || (s.lib ? thumbUrl(u.id, 'lib', s.lib, false, s.root || u.libRootId) : '');
    return ctx.el('div', { class: 'col gap-4', style: { minWidth: '0' } }, [
      ctx.el('div', { class: 'mv-card-pair' }, [
        sideBox(dupUrl, '查重侧 · 第 ' + (index + 1) + ' 张'),
        sideBox(libUrl, '库侧 · 第 ' + (index + 1) + ' 张')
      ]),
      ctx.el('div', { class: 'mv-card-meta' }, [
        ctx.el('span', { class: 'ellipsis', title: s.dup || '', text: s.dup || '（未记录文件名）' }),
        s.lib ? ctx.el('span', { class: 'ellipsis', title: s.lib, text: s.lib }) : null
      ])
    ]);
  }

  /** 单个候选：单元信息 + 每个候选库作品一行（标题 / 页数 / 相似度 / 抽样图 / 三个按钮）。 */
  function renderCandItem(item) {
    const u = item.unit || {};
    const card = ctx.el('div', { class: 'card col gap-10', style: { padding: '12px' } });
    const head = ctx.el('div', { class: 'row between wrap', style: { gap: '8px' } }, [
      ctx.el('div', { class: 'col gap-4', style: { minWidth: '0' } }, [
        ctx.el('div', { class: 'mv-card-title', title: u.id, text: unitLabel(u) }),
        ctx.el('div', { class: 'mv-card-meta' }, [
          ctx.el('span', { text: '本单元 ' + (item.unitPages || 0) + ' 页' }),
          u.category ? ctx.el('span', { text: '分类 ' + u.category }) : null,
          u.libRootName ? ctx.el('span', { text: '命中库根 ' + u.libRootName }) : null
        ])
      ]),
      ctx.el('div', { class: 'row wrap', style: { gap: '6px' } }, [
        item.judge ? ctx.el('span', { class: 'badge ' + badgeOf(item.judge), text: '判定 ' + item.judge }) : null,
        ctx.el('span', { class: 'badge' + (item.decision === 'delete' ? ' badge-err' : item.decision === 'keep' ? ' badge-ok' : ''), text: CAND_STATE_TEXT[item.decision] || CAND_STATE_TEXT.pending })
      ])
    ]);
    if (item.matchBy) card.appendChild(ctx.el('div', { class: 'small muted', text: '判定依据：' + item.matchBy }));
    card.appendChild(head);

    const matches = Array.isArray(item.matches) ? item.matches : [];
    if (!matches.length) {
      card.appendChild(ctx.el('div', { class: 'small muted', text: '该单元没有候选库作品（快速结果里 matches 为空）' }));
    }
    for (const m of matches) {
      const row = ctx.el('div', { class: 'col gap-8', style: { border: '1px solid var(--line)', borderRadius: 'var(--r)', padding: '10px' } });
      row.appendChild(ctx.el('div', { class: 'row between wrap', style: { gap: '8px' } }, [
        ctx.el('div', { class: 'col gap-4', style: { minWidth: '0' } }, [
          ctx.el('div', { class: 'mv-card-title', title: m.libTitle || m.libId, text: m.libTitle || m.libId }),
          ctx.el('div', { class: 'mv-card-meta' }, [
            ctx.el('span', { text: '库内 ' + (m.libPages == null ? '?' : m.libPages) + ' 页' }),
            ctx.el('span', { text: '页差 ' + (m.pageDiff == null ? '—' : m.pageDiff) }),
            m.libRootName ? ctx.el('span', { text: '库根 ' + m.libRootName }) : null
          ])
        ]),
        ctx.el('div', { class: 'row wrap', style: { gap: '6px' } }, [
          ctx.el('span', { class: 'badge badge-accent', text: '标题相似度 ' + scoreText(m.titleScore) }),
          ctx.el('span', { class: 'badge', text: '像素一致 ' + (u.exactCount || 0) + '/' + (u.dupCount || item.unitPages || 0) + ' 张' })
        ].concat((m.reasons || []).map(function (r) { return ctx.el('span', { class: 'badge', text: String(r) }); })))
      ]));

      const samples = Array.isArray(item.samples) ? item.samples : [];
      if (samples.length) {
        const grid = ctx.el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '8px' } });
        for (let i = 0; i < samples.length; i++) grid.appendChild(candPair(item, samples[i], i));
        row.appendChild(grid);
      } else {
        // 快速结果没给抽样图时，退回单元自己的 samples（全量扫描的字段），仍让用户看得到图。
        const fallback = (u.samples || []).slice(0, 6);
        if (fallback.length) {
          const grid2 = ctx.el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '8px' } });
          for (let i = 0; i < fallback.length; i++) {
            const s = fallback[i];
            grid2.appendChild(candPair(item, {
              dup: s.dup, lib: s.lib, root: s.root || u.libRootId,
              dupUrl: s.dup ? thumbUrl(u.id, 'dup', s.dup) : '',
              libUrl: s.lib ? thumbUrl(u.id, 'lib', s.lib, false, s.root || u.libRootId) : ''
            }, i));
          }
          row.appendChild(grid2);
        } else {
          row.appendChild(ctx.el('div', { class: 'small muted', text: '快速结果里没有抽样图，可在「深度比对」后查看逐张对照' }));
        }
      }

      const verdict = item.decision || 'pending';
      const btnYes = ctx.el('button', { class: 'btn btn-sm ' + (verdict === 'delete' ? 'btn-danger' : 'btn-ghost'), text: '确认重复（可删）' });
      const btnNo = ctx.el('button', { class: 'btn btn-sm ' + (verdict === 'keep' ? 'btn-success' : 'btn-ghost'), text: '不是重复' });
      const btnUnsure = ctx.el('button', { class: 'btn btn-sm ' + (verdict === 'pending' ? 'btn-primary' : 'btn-ghost'), text: '拿不准' });
      ctx.on(btnYes, 'click', function () { void decideCand(item, 'delete'); });
      ctx.on(btnNo, 'click', function () { void decideCand(item, 'keep'); });
      ctx.on(btnUnsure, 'click', function () { void decideCand(item, 'pending'); });
      row.appendChild(ctx.el('div', { class: 'row wrap', style: { gap: '6px' } }, [
        btnYes, btnNo, btnUnsure,
        ctx.el('span', { class: 'small muted', style: { alignSelf: 'center' }, text: '点「确认重复」才会进入删除候选，不会自动删除' })
      ]));
      card.appendChild(row);
    }
    return card;
  }

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

  /** 快速查重进行中：禁用按钮并提示，避免用户重复点。 */
  function setFastPending(on) {
    st.fastPending = Boolean(on);
    btnFast.disabled = st.fastPending || st.scanning;
    candNote.textContent = st.fastPending ? '快速查重进行中，完成后会自动刷新候选…' : candNote.textContent;
  }

  /** 启动快速查重（stage=fast，由 engine 侧实现），完成后自动拉候选。 */
  async function startFastScan() {
    candWrap.classList.remove('hidden');
    setFastPending(true);
    try {
      const res = await ctx.post('/api/dedupe/scan', { stage: 'fast' });
      ctx.toast('已启动 ' + (res.label || '快速查重') + '，完成后自动刷新候选', 'ok');
    } catch (err) {
      setFastPending(false);
      candHost.textContent = '';
      if (err.status === 409) {
        ctx.toast('已有扫描任务在运行，请先等待或点「中止」', 'warn', 5000);
      } else {
        // 后端还没上线 stage=fast 时就是这条分支：如实提示，不假装成功。
        candHost.appendChild(ctx.el('div', { class: 'alert alert-warn' }, [
          ctx.icon('alert'),
          ctx.el('div', { class: 'col gap-6' }, [
            ctx.el('div', { style: { fontWeight: '650' }, text: '快速查重启动失败' }),
            ctx.el('div', { class: 'mono small', text: err.message })
          ])
        ]));
        ctx.toast('快速查重启动失败：' + err.message, 'err', 6000);
      }
    }
  }

  // ================= 数据 ==================
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

  /** 人工决策实时写回后端（落 data/dedupe/decisions.json）。 */
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

  // ================= 详情弹窗（逐张对照） ==================
  async function openDetail(u) {
    let d = null;
    try { d = await ctx.get('/api/dedupe/unit/' + encodeURIComponent(u.id)); }
    catch (err) { ctx.toast('读取单元详情失败：' + err.message, 'err'); return; }
    const pairs = (d.pairs && d.pairs.length) ? d.pairs : (d.dupFiles || []).map(function (n) { return { dup: n, lib: '', exact: false, mad: null }; });
    if (!pairs.length) { ctx.toast('该单元没有可对照的图片', 'warn'); return; }
    let idx = 0;
    let closed = false;
    const leftImg = ctx.el('img', { class: 'mv-cmp-img', alt: '本单元图片' });
    const rightImg = ctx.el('img', { class: 'mv-cmp-img', alt: '库内对应图片' });
    const rightCap = ctx.el('div', { class: 'mv-cmp-cap' });
    const rightBox = ctx.el('div', { class: 'mv-cmp-box' }, [ctx.el('div', { class: 'small muted', text: '库内对应章节' }), rightImg, rightCap]);
    const leftCap = ctx.el('div', { class: 'mv-cmp-cap' });
    const counter = ctx.el('div', { class: 'small muted' });
    const strip = ctx.el('div', { class: 'mv-cmp-list' });
    const btnPrev = ctx.el('button', { class: 'btn btn-sm' }, [ctx.icon('chevron-left'), ctx.el('span', { text: '上一张' })]);
    const btnNext = ctx.el('button', { class: 'btn btn-sm' }, [ctx.el('span', { text: '下一张' }), ctx.icon('chevron-right')]);

    function show(i) {
      idx = Math.max(0, Math.min(pairs.length - 1, i));
      const p = pairs[idx];
      leftImg.src = thumbUrl(u.id, 'dup', p.dup, true);
      leftCap.textContent = p.dup + (p.exact ? '（字节完全一致）' : (p.mad != null ? '（像素误差 ' + p.mad + '）' : ''));
      if (p.lib) {
        rightImg.classList.remove('hidden');
        rightImg.src = thumbUrl(u.id, 'lib', p.lib, true, p.root || u.libRootId);
        rightCap.textContent = p.lib;
      } else {
        rightImg.classList.add('hidden');
        rightCap.textContent = '库内没有对应图片';
      }
      counter.textContent = '第 ' + (idx + 1) + '/' + pairs.length + ' 张';
      btnPrev.disabled = idx <= 0;
      btnNext.disabled = idx >= pairs.length - 1;
      const thumbs = strip.children;
      for (let k = 0; k < thumbs.length; k++) thumbs[k].classList.toggle('active', k === idx);
      if (thumbs[idx] && thumbs[idx].scrollIntoView) thumbs[idx].scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    for (let i = 0; i < pairs.length; i++) {
      const t = ctx.el('img', { class: 'mv-cmp-thumb', src: thumbUrl(u.id, 'dup', pairs[i].dup), alt: pairs[i].dup, loading: 'lazy' });
      ctx.on(t, 'click', function () { show(i); });
      strip.appendChild(t);
    }
    ctx.on(btnPrev, 'click', function () { show(idx - 1); });
    ctx.on(btnNext, 'click', function () { show(idx + 1); });
    ctx.on(document, 'keydown', function (e) {
      if (closed) return;
      if (e.key === 'ArrowLeft') { show(idx - 1); }
      else if (e.key === 'ArrowRight') { show(idx + 1); }
    });

    ctx.modal({
      title: '逐张对照 · ' + unitLabel(u), wide: true,
      onClose: function () { closed = true; },
      body: ctx.el('div', { class: 'mv-cmp' }, [
        ctx.el('div', { class: 'row wrap', style: { gap: '8px' } }, [
          ctx.el('span', { class: 'badge ' + badgeOf(u.judge), text: u.judge }),
          ctx.el('span', { class: 'badge', text: '命中 ' + (u.exactCount + u.pixelCount) + '/' + u.dupCount + ' 张' }),
          ctx.el('span', { class: 'badge', text: ctx.fmt.bytes(u.dupBytes || 0) }),
          ctx.el('span', { class: 'badge badge-accent', text: DECISION_TEXT[decisionOf(u)] })
        ]),
        ctx.el('div', { class: 'mv-cmp-bar' }, [btnPrev, counter, btnNext]),
        ctx.el('div', { class: 'mv-cmp-pair' }, [
          ctx.el('div', { class: 'mv-cmp-box' }, [ctx.el('div', { class: 'small muted', text: '本单元（查重目录）' }), leftImg, leftCap]),
          rightBox
        ]),
        ctx.el('div', { class: 'small muted', text: '全部图片（点击切换，← → 翻页）' }),
        strip
      ])
    });
    show(0);
  }

  // ================= 执行删除 ==================
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

  // ================= 隔离区 / 还原 ==================
  async function openQuarantine() {
    let d = null;
    try { d = await ctx.get('/api/dedupe/deleted'); }
    catch (err) { ctx.toast('读取隔离区失败：' + err.message, 'err'); return; }
    const quarantined = (d.log || []).filter(function (e) { return e.mode === 'quarantine'; });
    const body = ctx.el('div', { class: 'col gap-10' });
    body.appendChild(ctx.el('div', { class: 'small muted mono', text: d.quarantineDir || '' }));
    if (!quarantined.length) {
      body.appendChild(ctx.el('div', { class: 'empty' }, [ctx.icon('folder'), ctx.el('div', { class: 'empty-title', text: '隔离区是空的' })]));
    }
    for (const entry of quarantined) {
      for (const r of (entry.results || [])) {
        if (!r.ok) continue;
        const btn = ctx.el('button', { class: 'btn btn-sm', text: '还原' });
        ctx.on(btn, 'click', async function () {
          try {
            await ctx.post('/api/dedupe/restore', { unitIds: [r.id] });
            ctx.toast('已还原：' + (r.id || ''), 'ok');
            await load();
          } catch (err) { ctx.toast('还原失败：' + err.message, 'err'); }
        });
        body.appendChild(ctx.el('div', { class: 'mv-del-row' }, [
          ctx.el('span', { class: 'grow', text: (r.id || r.path) }),
          ctx.el('span', { class: 'muted small', text: ctx.fmt.date(entry.time) }),
          btn
        ]));
      }
    }
    ctx.modal({ title: '隔离区（已确认删除）', wide: true, body: body });
  }

  // ================= 扫描与控制 ==================
  function setScanning(on) {
    st.scanning = Boolean(on);
    btnFast.disabled = st.scanning || st.fastPending;
    btnRescan.disabled = st.scanning;
    btnPixel.disabled = st.scanning;
    btnFp.disabled = st.scanning;
    btnAbort.disabled = !st.scanning;
  }

  function renderProgress(d) {
    if (!d) return;
    const running = d.running !== false;
    if (!running && d.percent !== 100) { progressWrap.classList.add('hidden'); setScanning(false); return; }
    progressWrap.classList.remove('hidden');
    progressBar.style.width = Math.max(0, Math.min(100, Number(d.percent) || 0)) + '%';
    const stage = d.stageLabel || d.stage || '';
    const head = [stage, d.phase].filter(Boolean).join(' · ');
    progressText.textContent = head + '  ' + (Number(d.percent) || 0) + '%' + (d.total ? '（' + d.current + '/' + d.total + '）' : '');
    progressMsg.textContent = d.message || '';
    setScanning(running);
  }

  async function startScan(stage, rebuildFp) {
    try {
      const res = await ctx.post('/api/dedupe/scan', { stage: stage, rebuildFp: Boolean(rebuildFp) });
      setScanning(true);
      progressWrap.classList.remove('hidden');
      progressText.textContent = '正在启动：' + (res.label || stage);
      progressMsg.textContent = '';
      ctx.toast('已启动 ' + (res.label || stage), 'ok');
    } catch (err) {
      if (err.status === 409) ctx.toast('已有扫描任务在运行，请先等待或点「中止」', 'warn', 5000);
      else ctx.toast('启动扫描失败：' + err.message, 'err');
    }
  }

  async function doAbort() {
    try {
      const res = await ctx.post('/api/dedupe/scan/abort', {});
      ctx.toast(res.message || '已请求中止', res.aborted ? 'warn' : 'info');
    } catch (err) { ctx.toast('中止失败：' + err.message, 'err'); }
  }

  ctx.on(btnFast, 'click', function () { void startFastScan(); });
  ctx.on(btnCand, 'click', function () { void loadCandidates(); });
  ctx.on(btnCandReload, 'click', function () { void loadCandidates(); });
  ctx.on(btnCandClose, 'click', function () { candWrap.classList.add('hidden'); });
  ctx.on(btnRescan, 'click', function () { void startScan('full', false); });
  ctx.on(btnPixel, 'click', function () { void startScan('pixel', false); });
  ctx.on(btnAbort, 'click', function () { void doAbort(); });
  ctx.on(btnFp, 'click', async function () {
    const ok = await askConfirm(ctx, '重建全库指纹会重新解码漫画库里的所有图片（约 6 万张，视机器可能要几分钟），然后执行深度比对。继续？', { title: '重建全库指纹', okText: '开始重建' });
    if (ok) void startScan('pixel', true);
  });
  ctx.on(btnDelete, 'click', function () { void openDelete(); });
  ctx.on(btnQuar, 'click', function () { void openQuarantine(); });

  // 判定筛选 chip
  ctx.on(chipRow, 'click', function (e) {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip === chipDecided) {
      st.decided = st.decided ? '' : '1';
      chipDecided.classList.toggle('active', Boolean(st.decided));
    } else {
      st.verdict = chip.dataset.verdict || '';
      for (const c of chipRow.querySelectorAll('.chip')) {
        if (c !== chipDecided) c.classList.toggle('active', (c.dataset.verdict || '') === st.verdict);
      }
    }
    st.page = 1;
    load();
  });

  // 关键字搜索（Enter + 输入防抖）
  let searchTimer = null;
  ctx.on(searchInput, 'keydown', function (e) {
    if (e.key !== 'Enter') return;
    st.q = searchInput.value.trim();
    st.page = 1;
    load();
  });
  ctx.on(searchInput, 'input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      st.q = searchInput.value.trim();
      st.page = 1;
      load();
    }, 350);
  });
  ctx.registerCleanup(function () { if (searchTimer) clearTimeout(searchTimer); });

  // SSE 实时进度（ctx.sse 会自动登记清理）
  ctx.sse('/api/dedupe/scan/events', {
    onEvent: function (ev, data) {
      if (ev === 'progress' || ev === 'state') { renderProgress(data); return; }
      if (ev === 'error') {
        setScanning(false);
        progressWrap.classList.add('hidden');
        ctx.toast('扫描失败：' + ((data && data.error) || '未知原因'), 'err', 7000);
        load();
        return;
      }
      if (ev === 'done') {
        setScanning(false);
        progressBar.style.width = '100%';
        if (data && data.aborted) {
          progressWrap.classList.add('hidden');
          ctx.toast('扫描已中止', 'warn');
        } else {
          progressText.textContent = '扫描完成';
          const s = (data && data.summary) || {};
          const dup = (data && data.duplicateUnits != null)
            ? data.duplicateUnits
            : ((s['完全重复'] || 0) + (s['同图不同编码'] || 0) + (s['部分重复'] || 0));
          ctx.toast('扫描完成：重复单元 ' + dup + ' 个，可清理 ' + ctx.fmt.bytes((data && data.reclaimable) || 0)
            + '（耗时 ' + ctx.fmt.dur((data && data.elapsedMs) || 0) + '）', 'ok', 7000);
          if (data && data.degraded) ctx.toast('注意：' + (data.degradeReason || '像素比对已降级'), 'warn', 8000);
          setTimeout(function () { progressWrap.classList.add('hidden'); }, 2500);
        }
        load();
        // 快速查重跑完：自动把候选拉出来给人眼比对（其它阶段没有候选，不用动）。
        if (st.fastPending) {
          setFastPending(false);
          void loadCandidates();
        }
      }
    },
    onError: function () { /* 浏览器会自动重连，避免刷屏 */ }
  });

  // 首屏：若后端正在扫描，进度条立刻可见
  try {
    const s = await ctx.get('/api/dedupe/state');
    if (s && s.running) renderProgress(s.progress);
    else if (s && s.degraded) renderStats(null);
  } catch (err) { /* /state 失败不阻塞列表加载 */ }
  await load();
}

export function unmount() {}
