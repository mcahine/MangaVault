/* 查重模块前端 · 弹窗（逐张对照 / 隔离区还原）
   两个弹窗原本在 mount() 闭包里，靠 ctx / st / load 工作；搬出来后由
   makeDedupeDialogs(ctx, deps) 的参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。 */

export function makeDedupeDialogs(ctx, deps) {
  /* 缩略图与小件来自公共件；load 用来在还原后刷新主列表。 */
  const thumbUrl = deps.parts.thumbUrl;
  const unitLabel = deps.parts.unitLabel;
  const badgeOf = deps.parts.badgeOf;
  const decisionOf = deps.parts.decisionOf;
  const DECISION_TEXT = deps.parts.DECISION_TEXT;
  const load = deps.load;

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

  return {
    openDetail: openDetail,
    openQuarantine: openQuarantine
  };
}