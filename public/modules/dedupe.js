/* 查重模块前端（dedupe-smith）· 装配层
   本文件只负责：骨架 DOM、事件绑定、SSE 订阅与生命周期。
   渲染件在 dedupe-parts / dedupe-list / dedupe-cand，决策删除在 dedupe-decide，
   弹窗在 dedupe-dialogs，扫描控制在 dedupe-scan，数据加载在 dedupe-data。
   只使用 theme.css 已有类 + 本模块 dedupe.css 的 mv- 前缀类；全部经 ctx API 渲染。 */

import { makeDedupeParts } from './dedupe-parts.mjs';
import { makeListPanel } from './dedupe-list.mjs';
import { makeCandPanel } from './dedupe-cand.mjs';
import { makeDataFlow } from './dedupe-data.mjs';
import { makeDecideFlow } from './dedupe-decide.mjs';
import { makeDedupeDialogs } from './dedupe-dialogs.mjs';
import { makeScanControl } from './dedupe-scan.mjs';

export const meta = { id: 'dedupe', name: '查重', order: 40 };

function ensureStyle() {
  if (document.getElementById('mv-dedupe-style')) return;
  const link = document.createElement('link');
  link.id = 'mv-dedupe-style';
  link.rel = 'stylesheet';
  link.href = '/modules/dedupe.css';
  document.head.appendChild(link);
}

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

  /* ---------------- 装配 ---------------- */
  /* 装配顺序：公共件 → 列表 → 候选 → 数据 → 决策 → 弹窗 → 扫描控制。
     彼此有回环引用的地方一律用箭头函数包一层（延迟到调用时才取），
     否则这里会撞上 const 的 TDZ：列表卡片要调决策、决策要调列表渲染。 */
  const parts = makeDedupeParts(ctx, {
    decideCand: function (item, verdict) { return decideFlow.decideCand(item, verdict); }
  });

  chipRow.appendChild(ctx.el('span', { class: 'small muted', text: '判定：' }));
  for (const c of parts.VERDICT_CHIPS) {
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

  const list = makeListPanel(ctx, st, {
    statRow: statRow, listHost: listHost, pager: pager, parts: parts,
    decide: function (u, v) { return data.decide(u, v); },
    openDetail: function (u) { return dialogs.openDetail(u); },
    load: function () { return data.load(); }
  });
  const renderStats = list.renderStats;
  const renderList = list.renderList;
  const renderPager = list.renderPager;
  const renderLoading = list.renderLoading;

  const cand = makeCandPanel(ctx, st, {
    candCount: candCount, candNote: candNote, candHost: candHost, candWrap: candWrap,
    renderCandItem: parts.renderCandItem
  });
  const loadCandidates = cand.loadCandidates;
  const renderCandidates = cand.renderCandidates;

  const data = makeDataFlow(ctx, st, {
    listHost: listHost, parts: parts,
    renderStats: renderStats, renderList: renderList,
    renderPager: renderPager, renderLoading: renderLoading
  });
  const load = data.load;
  const decide = data.decide;

  const decideFlow = makeDecideFlow(ctx, st, {
    parts: parts, cand: cand, candWrap: candWrap,
    renderStats: renderStats, renderList: renderList, renderPager: renderPager,
    load: function () { return data.load(); }
  });
  const decideCand = decideFlow.decideCand;
  const openDelete = decideFlow.openDelete;

  const dialogs = makeDedupeDialogs(ctx, {
    parts: parts, load: function () { return data.load(); }
  });
  const openDetail = dialogs.openDetail;
  const openQuarantine = dialogs.openQuarantine;

  const scan = makeScanControl(ctx, st, {
    progressBar: progressBar, progressText: progressText, progressMsg: progressMsg,
    progressWrap: progressWrap, candNote: candNote, candHost: candHost, candWrap: candWrap,
    btnFast: btnFast, btnRescan: btnRescan, btnPixel: btnPixel, btnFp: btnFp, btnAbort: btnAbort
  });
  const setFastPending = scan.setFastPending;
  const startFastScan = scan.startFastScan;
  const setScanning = scan.setScanning;
  const renderProgress = scan.renderProgress;
  const startScan = scan.startScan;
  const doAbort = scan.doAbort;


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