/* 查重模块前端 · 公共件
   查重台的判定常量、显示小件、候选复核卡片、并排抽样对都从这里出去。
   它们原本都在 mount() 闭包里，靠 ctx 工作；搬出来后由 makeDedupeParts(ctx, deps)
   的参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。 */

/* 删除方式三选：移入回收站（最安全）/ 移到隔离区 / 永久删除。 */
const MODES = [
{ id: 'recycle', label: '移入回收站', hint: '可从系统回收站还原（默认，最安全）' },
{ id: 'quarantine', label: '移动到隔离区', hint: '移到 data/dedupe/已确认删除/，之后可一键还原' },
{ id: 'permanent', label: '永久删除', hint: '直接从磁盘删除，无法恢复' }
];

/* 判定 chip 与徽标：badgeOf 只查 VERDICT_CHIPS，两者必须同住一个文件。 */
const VERDICT_CHIPS = [
{ id: '', label: '全部' },
{ id: '完全重复', label: '完全重复', badge: 'badge-err' },
{ id: '同图不同编码', label: '同图不同编码', badge: 'badge-warn' },
{ id: '部分重复', label: '部分重复', badge: 'badge-accent' },
{ id: '未找到', label: '未找到', badge: 'badge-ok' },
// 快速查重专用的判定：像素证据缺失时判定权完全交给用户
{ id: '待人工复核', label: '待人工复核', badge: 'badge-warn' }
];

// deleted 由后端在「执行删除」成功后回写（磁盘上已经没了），不提供手动选择。
const DECISION_TEXT = { keep: '已保留', delete: '待删除', pending: '未定', deleted: '已删除' };
// 候选复核里的三选文案（keep=不是重复 / delete=确认重复可删 / pending=拿不准）
const CAND_STATE_TEXT = { keep: '已判：不是重复', delete: '已判：确认重复（可删）', pending: '拿不准（待定）', deleted: '已删除' };

function badgeOf(verdict) {
for (const c of VERDICT_CHIPS) if (c.id === verdict) return c.badge || 'badge';
return 'badge';
}

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

/**
 * 缩略图地址。
 * root 是「相对哪个库根」的基准：库侧图片在多库根下用「根 id + 相对根的路径」寻址，
 * 不带 root 时后端只能退回到「命中章节目录 + 单段文件名」的旧寻址方式，
 * 一旦该图属于非首个库根就会 404 —— 表现为卡片右半边永远是「图片读取失败」。
 */

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

export function makeDedupeParts(ctx, deps) {
  /* 候选三选的落盘逻辑在决策层，装配顺序上晚于本文件，所以延迟到调用时才取。 */
  function decideCand(item, verdict) { return deps.decideCand(item, verdict); }

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

  return {
    MODES: MODES,
    VERDICT_CHIPS: VERDICT_CHIPS,
    DECISION_TEXT: DECISION_TEXT,
    CAND_STATE_TEXT: CAND_STATE_TEXT,
    badgeOf: badgeOf,
    unitLabel: unitLabel,
    thumbUrl: thumbUrl,
    decisionOf: decisionOf,
    sideBox: sideBox,
    scoreText: scoreText,
    candPair: candPair,
    renderCandItem: renderCandItem
  };
}