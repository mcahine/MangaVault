/**
 * 下载任务页签：任务卡 / 进度增量 / 暂停继续取消 / 账号事件。
 *
 * 从 mount() 闭包里搬出来的代码：el / api / ctx / state 原本都是 mount 的同作用域变量，
 * 这里由参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeTaskPanel(ctx, state, deps) {
  const el = deps.el;
  const api = deps.api;
  const { errorMessage, errorBox, STATE_TEXT, STATE_BADGE } = deps.s;
  /* renderAccount / ensureProfileLoaded 由「我的」页签提供，装配时经 deps 注入：
     它们是 account 面板的出口，共享件（share）里并没有这两个，写进 deps.s 会是 undefined。 */
  const renderAccount = deps.renderAccount;
  const ensureProfileLoaded = deps.ensureProfileLoaded;
  const refreshInfo = deps.refreshInfo;
  /* 页签 chip 由装配层创建（badge 角标挂在它上面），这里只读它，用来更新任务数角标。 */
  const taskChip = deps.chip;

  /* 骨架容器由装配层传入：页签内容整体挂到 mount 建好的那个 div 上。 */
  const taskPanel = deps.panel;

  /* ---------------- 下载任务 ---------------- */
  const taskStats = el('div', { class: 'stat-row card', style: { marginBottom: '4px' } });
  const taskList = el('div', { class: 'col gap-10' });
  const taskBar = el('div', { class: 'toolbar' });

  function buildTaskPanel() {
    taskPanel.textContent = '';
    taskBar.textContent = '';
    taskBar.appendChild(el('div', { class: 'section-title grow', text: '下载任务' }));
    taskBar.appendChild(el('span', { class: 'small muted', id: 'mvDlSse', text: '实时连接：连接中…' }));
    taskBar.appendChild(el('button', { class: 'btn btn-sm btn-ghost', on: { click: loadTasks } }, [ctx.icon('refresh'), el('span', { text: '刷新' })]));
    taskPanel.appendChild(taskBar);
    taskPanel.appendChild(taskStats);
    taskPanel.appendChild(taskList);
  }

  async function loadTasks() {
    try {
      const r = await api('/api/download/tasks');
      state.tasks = r.tasks || [];
      state.stats = r.stats || null;
      renderTasks();
      updateTabBadge();
    } catch (err) {
      taskList.textContent = '';
      taskList.appendChild(errorBox('任务列表加载失败', errorMessage(err, '任务列表加载失败'), loadTasks));
      ctx.toast('任务列表加载失败：' + err.message, 'err');
    }
  }

  function updateTabBadge() {
    const active = state.tasks.filter(function (t) { return t.state === 'running' || t.state === 'queued'; }).length;
    if (taskChip.__badge) taskChip.__badge.textContent = active ? String(active) : (state.tasks.length ? String(state.tasks.length) : '');
  }

  function renderTasks() {
    taskList.textContent = '';
    const s = state.stats || {};
    taskStats.textContent = '';
    const cells = [
      { v: s.total || 0, l: '任务总数' },
      { v: s.running || 0, l: '下载中' },
      { v: s.queued || 0, l: '排队中' },
      { v: s.done || 0, l: '已完成' },
      { v: (s.error || 0) + (s.paused || 0), l: '需处理' }
    ];
    for (const c of cells) {
      taskStats.appendChild(el('div', { class: 'card stat' }, [
        el('div', { class: 'stat-value', text: String(c.v) }),
        el('div', { class: 'stat-label', text: c.l })
      ]));
    }
    if (!state.tasks.length) {
      taskList.appendChild(ctx.empty('还没有下载任务', '到「搜索入库」里搜一本漫画开始下载'));
      return;
    }
    for (const t of state.tasks) taskList.appendChild(taskCard(t));
  }

  function taskCard(t) {
    const bar = el('i', { class: 'progress-bar', style: { width: Math.max(0, Math.min(100, t.percent || 0)) + '%' } });
    const canPause = t.state === 'running' || t.state === 'queued';
    const canResume = t.state === 'paused' || t.state === 'error' || t.state === 'canceled';
    const canCancel = t.state === 'running' || t.state === 'queued' || t.state === 'paused';
    return el('div', { class: 'card card-pad mv-dl-task', dataset: { id: t.id } }, [
      el('div', { class: 'row between gap-12 wrap' }, [
        el('div', { class: 'col gap-4 grow', style: { minWidth: '220px' } }, [
          el('div', { class: 'row gap-8 center' }, [
            el('div', { style: { fontWeight: '650' }, text: t.title || t.comicId }),
            el('span', { class: STATE_BADGE[t.state] || 'badge', text: STATE_TEXT[t.state] || t.state })
          ]),
          el('div', { class: 'small muted ellipsis mv-dl-taskline', text: taskLine(t) })
        ]),
        el('div', { class: 'row gap-6 wrap' }, [
          t.state === 'running' ? el('span', { class: 'badge', text: ctx.fmt.bytes(t.speed || 0) + '/s' }) : null,
          t.state === 'running' && t.etaMs ? el('span', { class: 'badge', text: '剩余约 ' + ctx.fmt.dur(t.etaMs) }) : null,
          el('span', { class: 'badge', text: ctx.fmt.bytes(t.bytes || 0) })
        ]),
        el('div', { class: 'row gap-6' }, [
          canPause ? el('button', { class: 'btn btn-sm', title: '暂停', on: { click: function () { taskAction(t.id, 'pause'); } } }, [ctx.icon('minimize'), el('span', { text: '暂停' })]) : null,
          canResume ? el('button', { class: 'btn btn-sm btn-primary', title: '继续（断点续传）', on: { click: function () { taskAction(t.id, 'resume'); } } }, [ctx.icon('play'), el('span', { text: '继续' })]) : null,
          canCancel ? el('button', { class: 'btn btn-sm btn-ghost', title: '取消', on: { click: function () { taskAction(t.id, 'cancel'); } } }, [ctx.icon('x'), el('span', { text: '取消' })]) : null,
          el('button', { class: 'btn btn-sm btn-ghost', title: '打开目录', on: { click: function () { openTaskFolder(t.id); } } }, [ctx.icon('folder')]),
          el('button', { class: 'btn btn-sm btn-ghost btn-danger', title: '删除任务', on: { click: function () { removeTask(t); } } }, [ctx.icon('trash')])
        ])
      ]),
      el('div', { class: 'progress progress-track', style: { marginTop: '10px' } }, [bar]),
      el('div', { class: 'row between gap-10 small muted', style: { marginTop: '6px' } }, [
        el('span', { text: (t.percent || 0) + '%' }),
        el('span', { class: 'ellipsis', text: t.dir || '' })
      ]),
      t.error ? el('div', { class: 'alert alert-err', style: { marginTop: '8px' } }, [el('span', { class: 'small', text: t.error })]) : null,
      t.logs && t.logs.length ? el('details', { class: 'mv-dl-logs' }, [
        el('summary', { class: 'small muted', text: '任务日志（' + t.logs.length + '）' }),
        el('div', { class: 'col gap-2 small mono muted', style: { maxHeight: '140px', overflow: 'auto', marginTop: '4px' } }, t.logs.slice(-12).map(function (l) {
          return el('div', { text: '[' + (l.level || 'info') + '] ' + (l.message || '') });
        }))
      ]) : null
    ]);
  }

  function taskLine(t) {
    return (t.author ? '作者：' + t.author + '　' : '')
      + '章节 ' + (t.finishedChapters || 0) + '/' + (t.chapterCount || 0)
      + '　图片 ' + (t.done || 0) + '/' + (t.total || 0)
      + (t.failed ? '　失败 ' + t.failed : '');
  }

  async function taskAction(id, action) {
    if (state.busy[id]) return;
    state.busy[id] = true;
    try {
      const r = await ctx.post('/api/download/tasks/' + encodeURIComponent(id) + '/' + action, {});
      ctx.toast(r.message || '操作成功', 'ok');
      await loadTasks();
      refreshInfo();
    } catch (err) {
      const label = action === 'pause' ? '暂停' : (action === 'resume' ? '继续' : '取消');
      ctx.toast(label + '失败：' + err.message, 'err');
    } finally {
      state.busy[id] = false;
    }
  }

  async function removeTask(t) {
    const ok = await ctx.confirm('删除任务「' + (t.title || t.id) + '」？\n已下载到磁盘的图片不会被删除。', { title: '删除任务', okText: '删除' });
    if (!ok) return;
    try {
      await api('/api/download/tasks/' + encodeURIComponent(t.id), { method: 'DELETE' });
      ctx.toast('任务已删除', 'ok');
      await loadTasks();
    } catch (err) {
      ctx.toast('删除失败：' + err.message, 'err');
    }
  }

  async function openTaskFolder(id) {
    try {
      const r = await ctx.post('/api/download/open-folder', { taskId: id });
      ctx.toast(r.message || '已打开目录', 'ok');
    } catch (err) {
      ctx.toast('打开目录失败：' + err.message, 'err');
    }
  }

  /** SSE 进度：只更新对应卡片，不整页重绘。 */
  function applyProgress(data) {
    if (!data || !data.taskId) return;
    const known = state.tasks.filter(function (t) { return t.id === data.taskId; })[0];
    if (!known) {
      state.tasks.unshift(data);
      renderTasks();
      return;
    }
    Object.assign(known, data);
    const node = taskList.querySelector('.mv-dl-task[data-id="' + data.taskId + '"]');
    if (!node) { renderTasks(); return; }
    const bar = node.querySelector('.progress-bar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, data.percent || 0)) + '%';
    const line = node.querySelector('.mv-dl-taskline');
    if (line) line.textContent = taskLine(data);
    updateTabBadge();
  }

  function setSseLabel(ok) {
    state.sseOk = ok;
    const node = taskBar.querySelector('#mvDlSse');
    if (node) node.textContent = ok ? '实时连接：已连接' : '实时连接：已断开（可点刷新）';
  }

  /* ---------------- SSE：账号事件同步登录态 ---------------- */
  function onAccountEvent(data) {
    if (!data || !data.status) return;
    if (data.status === 'loginfo' || data.status === 'login') {
      state.account = data.account || state.account;
      renderAccount('');
      refreshInfo();
      /* 账号状态变了就确保资料跟上，否则「我的」会停在未拉取资料的提示上。 */
      ensureProfileLoaded();
    } else if (data.status === 'logout' || data.status === 'expired') {
      state.account = null;
      state.profile = null;
      state.profileError = '';
      renderAccount('');
      refreshInfo();
    }
  }

  return {
    buildTaskPanel: buildTaskPanel,
    loadTasks: loadTasks,
    updateTabBadge: updateTabBadge,
    renderTasks: renderTasks,
    applyProgress: applyProgress,
    setSseLabel: setSseLabel,
    onAccountEvent: onAccountEvent,
    taskBar: taskBar,
    taskList: taskList,
    taskStats: taskStats
  };
}
