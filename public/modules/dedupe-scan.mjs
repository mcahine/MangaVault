/* 查重模块前端 · 扫描与控制
   快速查重按钮态、扫描进度条、启动 / 中止。原本都在 mount() 闭包里，靠 ctx / st 与
   进度条容器工作；搬出来后由 makeScanControl(ctx, st, deps) 的参数逐字提供，
   函数体一行未改（2 空格基准缩进保持不变）。 */

export function makeScanControl(ctx, st, deps) {
  /* 进度条与按钮全部由装配层建好后传进来。 */
  const progressBar = deps.progressBar;
  const progressText = deps.progressText;
  const progressMsg = deps.progressMsg;
  const progressWrap = deps.progressWrap;
  const candNote = deps.candNote;
  const candHost = deps.candHost;
  const candWrap = deps.candWrap;
  const btnFast = deps.btnFast;
  const btnRescan = deps.btnRescan;
  const btnPixel = deps.btnPixel;
  const btnFp = deps.btnFp;
  const btnAbort = deps.btnAbort;

  /** 快速查重进行中：禁用按钮并提示，避免用户重复点。 */
  function setFastPending(on) {
    st.fastPending = Boolean(on);
    btnFast.disabled = st.fastPending || st.scanning;
    candNote.textContent = st.fastPending ? '快速查重进行中，完成后会自动刷新候选…' : candNote.textContent;
  }

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

  return {
    setFastPending: setFastPending,
    startFastScan: startFastScan,
    setScanning: setScanning,
    renderProgress: renderProgress,
    startScan: startScan,
    doAbort: doAbort
  };
}