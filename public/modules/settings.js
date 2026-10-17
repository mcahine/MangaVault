export const meta = { id: 'settings', name: '设置', order: 80 };

export async function mount(root, ctx) {
  const el = ctx.el;
  ctx.title('设置', '库根 / 账号 / 代理 / 查重 / 桌面');

  let cfg = null, sys = null, rootProbe = [];
  try {
    cfg = (await ctx.get('/api/config')).config;
    sys = await ctx.get('/api/system/info');
    const rr = await ctx.get('/api/library/roots');
    rootProbe = Array.isArray(rr.roots) ? rr.roots : [];
  } catch (err) {
    root.appendChild(el('div', { class: 'page' }, [el('div', { class: 'alert alert-err' }, [ctx.icon('alert'), el('span', { text: '配置读取失败：' + err.message })])]));
    return;
  }
  let pc = cfg.picacomic || {};
  const dd = cfg.dedupe || {};

  /* ---------------- 库根 ---------------- */
  const rootList = el('div', { class: 'col gap-8' });
  const newRootPath = el('input', { class: 'input', placeholder: 'C:\\漫画\\新目录' });
  const newRootName = el('input', { class: 'input', placeholder: '显示名（可留空）', style: { maxWidth: '190px' } });
  const addBtn = el('button', { class: 'btn btn-primary', on: { click: addRoot } }, [ctx.icon('plus'), el('span', { text: '添加库根' })]);

  function renderRoots() {
    rootList.textContent = '';
    if (!Array.isArray(rootProbe)) rootProbe = [];
    if (!rootProbe.length) {
      rootList.appendChild(el('div', { class: 'alert alert-warn' }, [ctx.icon('alert'), el('span', { text: '还没有任何库根，添加一个漫画目录后点「扫描库」。' })]));
      return;
    }
    for (const r of rootProbe) {
      const badge = !r.exists ? el('span', { class: 'stamp stamp-yellow', text: '目录不存在' }) : (r.error ? el('span', { class: 'stamp stamp-yellow', text: r.error }) : el('span', { class: 'stamp', text: r.dirs + ' 目录' }));
      rootList.appendChild(el('div', { class: 'card card-pad col gap-6' }, [
        el('div', { class: 'row between gap-10 wrap' }, [
          el('div', { class: 'row gap-8', style: { minWidth: 0 } }, [
            ctx.icon('hard-drive'),
            el('span', { style: { fontWeight: '650' }, text: r.name }),
            el('span', { class: 'badge', text: r.id }),
            badge
          ]),
          el('div', { class: 'row gap-6' }, [
            el('button', { class: 'btn btn-sm btn-ghost', on: { click: function () { scanOne(r); } } }, [ctx.icon('refresh'), el('span', { text: '扫描此根' })]),
            el('button', { class: 'btn btn-sm btn-danger', on: { click: function () { removeRoot(r); } } }, [ctx.icon('trash')])
          ])
        ]),
        el('div', { class: 'mono small muted ellipsis', title: r.path, text: r.path })
      ]));
    }
  }

  async function addRoot() {
    const p = newRootPath.value.trim();
    if (!p) { ctx.toast('请填写目录路径', 'warn'); return; }
    addBtn.disabled = true;
    try {
      const r = await ctx.post('/api/library/roots', { path: p, name: newRootName.value.trim() || undefined });
      rootProbe = r.roots;
      newRootPath.value = ''; newRootName.value = '';
      renderRoots();
      ctx.toast(r.message || '已添加库根', 'ok');
    } catch (err) { ctx.toast('添加失败：' + err.message, 'err'); }
    finally { addBtn.disabled = false; }
  }

  async function removeRoot(r) {
    const ok = await ctx.confirm('从索引中移除库根「' + r.name + '」？\n\n磁盘上的漫画文件不会被删除，只是不再索引它。', { danger: true, okText: '移除' });
    if (!ok) return;
    try {
      const res = await ctx.api('/api/library/roots?id=' + encodeURIComponent(r.id), { method: 'DELETE' });
      rootProbe = res.roots;
      renderRoots();
      ctx.toast(res.message || '已移除', 'ok');
    } catch (err) { ctx.toast('移除失败：' + err.message, 'err'); }
  }

  async function scanOne(r) {
    try {
      await ctx.post('/api/library/scan', { root: r.id });
      ctx.toast('已开始扫描：' + r.name, 'ok');
    } catch (err) { ctx.toast('启动失败：' + err.message, 'err'); }
  }

  /* ---------------- 表单字段 ---------------- */
  function fld(label, node, hint) {
    return el('div', { class: 'field' }, [el('label', { class: 'label', text: label }), node, hint ? el('div', { class: 'hint', text: hint }) : null]);
  }
  /* token 状态条：保存成功后由 reloadConfig() 就地更新，不必整页重载。 */
  const tokenState = el('div', { class: pc.hasToken ? 'alert alert-ok' : 'alert alert-warn' }, [
    ctx.icon(pc.hasToken ? 'check' : 'alert'),
    el('span', { text: pc.hasToken ? ('已配置 token：' + pc.tokenPreview) : '尚未登录，下载功能不可用。' })
  ]);

  /* 哔咔 token 输入：这是唯一入口。
     以前这里只有一个「去下载中心登录」按钮，而下载页写的是「请到设置页填写 token」——
     两个页面互相指路、谁都没有输入框，用户根本没法登录。 */
  const tokenInput = el('input', { class: 'input mono', type: 'text', placeholder: '粘贴哔咔 token（三段式 JWT）' });
  const tokenSaveBtn = el('button', { class: 'btn btn-sm btn-primary', on: { click: saveToken } }, [ctx.icon('shield'), el('span', { text: '保存并校验' })]);
  const tokenStatus = el('div', { class: 'small muted', text: '' });
  const tokenBtn = el('button', { class: 'btn btn-sm btn-ghost', on: { click: function () { ctx.navigate('#/download'); } } }, [ctx.icon('user'), el('span', { text: '去下载中心' })]);

  /** 只重拉配置状态（保存 token 后刷新「已配置 / 未登录」提示），不覆盖用户正在编辑的表单。 */
  async function reloadConfig() {
    try {
      const latest = (await ctx.get('/api/config')).config;
      pc = latest.picacomic || {};
      tokenState.textContent = pc.hasToken ? ('已配置 token：' + pc.tokenPreview) : '尚未登录，下载功能不可用。';
      tokenState.className = pc.hasToken ? 'alert alert-ok' : 'alert alert-warn';
    } catch (e) { /* 读不到就保持原样 */ }
  }

  async function saveToken() {
    const v = String(tokenInput.value || '').trim();
    if (!v) { ctx.toast('请先粘贴哔咔 token', 'warn'); tokenInput.focus(); return; }
    tokenSaveBtn.disabled = true;
    tokenStatus.textContent = '正在校验…';
    try {
      const r = await ctx.post('/api/download/token', { token: v });
      tokenInput.value = '';
      tokenStatus.textContent = r.message || 'token 已保存';
      ctx.toast(r.message || 'token 已保存', 'ok');
      await reloadConfig();
    } catch (err) {
      tokenStatus.textContent = '校验失败：' + err.message;
      ctx.toast('token 校验失败：' + err.message, 'err');
    } finally {
      tokenSaveBtn.disabled = false;
    }
  }
  const proxyMode = el('select', { class: 'select' }, [opt('none', '不使用代理'), opt('system', '跟随系统代理'), opt('manual', '手动指定')]);
  proxyMode.value = pc.proxyMode || (pc.proxy ? 'manual' : 'none');
  const proxyHost = el('input', { class: 'input', value: pc.proxyHost || (pc.proxy ? String(pc.proxy).replace(/^https?:\/\//, '').split(':')[0] : '127.0.0.1') });
  const proxyPort = el('input', { class: 'input', type: 'number', value: String(pc.proxyPort || 7897) });
  const fmtSel = el('select', { class: 'select' }, [opt('Jpeg', 'Jpeg（默认）'), opt('Webp', 'Webp'), opt('Png', 'Png'), opt('Original', 'Original（保留原格式）')]);
  fmtSel.value = pc.downloadFormat || 'Jpeg';
  const dirFmt = el('input', { class: 'input', value: pc.dirFmt || '{comic_title}/{order} {chapter_title}' });
  const chConc = el('input', { class: 'input', type: 'number', value: String(pc.chapterConcurrency || 2) });
  const imgConc = el('input', { class: 'input', type: 'number', value: String(pc.imgConcurrency || 12) });
  const exportDir = el('input', { class: 'input', value: pc.exportDir || '' , placeholder: '导出 ZIP/CBZ 的默认目录（可留空）' });
  const ddScan = el('input', { class: 'input', value: dd.scanRoot || '' });
  const ddThresh = el('input', { class: 'input', type: 'number', value: String(dd.pixelThreshold || 8) });
  const ddThumb = el('input', { class: 'input', type: 'number', value: String(dd.thumbCount || 6) });
  const autostart = el('div', { class: 'switch', title: '开机自动启动' });

  function opt(v, t) { return el('option', { value: v, text: t }); }

  async function refreshAutostart() {
    try {
      const st = await ctx.get('/api/desktop/state');
      autostart.classList.toggle('on', Boolean(st.autostart));
      autostart.dataset.on = st.autostart ? '1' : '0';
    } catch (e) { autostart.classList.add('hidden'); }
  }
  autostart.addEventListener('click', async function () {
    const next = autostart.dataset.on !== '1';
    try {
      const r = await ctx.post('/api/desktop/autostart', { enabled: next });
      autostart.dataset.on = r.enabled ? '1' : '0';
      autostart.classList.toggle('on', Boolean(r.enabled));
      ctx.toast(r.enabled ? '已开启开机自启' : '已关闭开机自启', 'ok');
    } catch (err) { ctx.toast('设置失败：' + err.message + '（桌面模块未就绪？）', 'warn'); }
  });

  const saveBtn = el('button', { class: 'btn btn-primary', on: { click: save } }, [ctx.icon('save'), el('span', { text: '保存配置' })]);
  const scanAllBtn = el('button', { class: 'btn', on: { click: async function () { try { await ctx.post('/api/library/scan', {}); ctx.toast('已开始全库扫描', 'ok'); } catch (e) { ctx.toast('启动失败：' + e.message, 'err'); } } } }, [ctx.icon('refresh'), el('span', { text: '扫描全部库根' })]);

  async function save() {
    saveBtn.disabled = true;
    try {
      await ctx.post('/api/config', {
        picacomic: {
          proxyMode: proxyMode.value,
          proxyHost: proxyHost.value.trim(),
          proxyPort: Number(proxyPort.value) || 7897,
          /* 非手动模式要发空串而不是 null：后端 core/config.mjs 的 deepMerge 把 null 当
             「本次不改动这一项」，发 null 会让旧的 proxy URL 永远留在 config.json 里。 */
          proxy: proxyMode.value === 'manual' ? ('http://' + proxyHost.value.trim() + ':' + (Number(proxyPort.value) || 7897)) : '',
          downloadFormat: fmtSel.value,
          dirFmt: dirFmt.value.trim(),
          chapterConcurrency: Math.max(1, Number(chConc.value) || 2),
          imgConcurrency: Math.max(1, Number(imgConc.value) || 12),
          exportDir: exportDir.value.trim() || null
        },
        dedupe: { scanRoot: ddScan.value.trim(), pixelThreshold: Number(ddThresh.value) || 8, thumbCount: Number(ddThumb.value) || 6 }
      });
      ctx.toast('配置已保存（部分参数需重启服务生效）', 'ok');
    } catch (err) { ctx.toast('保存失败：' + err.message, 'err'); }
    finally { saveBtn.disabled = false; }
  }

  const modules = (sys.modules || []).map(function (m) {
    return el('div', { class: 'ledger-row' }, [
      el('span', { class: 'k' }, [el('span', { class: 'badge ' + (m.ok ? 'badge-ok' : 'badge-err'), text: m.ok ? '就绪' : '异常' })]),
      el('span', { class: 'grow', text: (m.name || m.id) + '　' + m.id }),
      el('span', { class: 'v', text: m.routes && m.routes.length ? m.routes.length + ' 接口' : '—' })
    ]);
  });

  root.appendChild(el('div', { class: 'page' }, [
    el('div', { class: 'page-head' }, [
      el('div', {}, [el('h2', { class: 'page-title misprint', text: '设置' }), el('div', { class: 'page-sub', text: '写入 config.json' })]),
      el('div', { class: 'row gap-8' }, [scanAllBtn, saveBtn])
    ]),
    el('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' } }, [
      el('div', { class: 'card card-pad col gap-10' }, [
        el('div', { class: 'section-title', text: '01 — 库根管理' }),
        rootList,
        el('div', { class: 'rule' }),
        el('div', { class: 'row gap-6 wrap' }, [el('div', { class: 'grow', style: { minWidth: '220px' } }, [newRootPath]), newRootName, addBtn]),
        el('div', { class: 'hint', text: '先期漫画这类「图片直接躺在漫画目录」的收藏也能直接加进来；目录不会被改动。' })
      ]),
      el('div', { class: 'card card-pad col gap-10' }, [
        el('div', { class: 'section-title', text: '02 — 哔咔账号' }),
        tokenState,
        el('div', { class: 'row gap-8' }, [el('div', { class: 'grow' }, [tokenInput]), tokenSaveBtn, tokenBtn]),
        tokenStatus,
        el('div', { class: 'rule' }),
        fld('代理模式', proxyMode, '本机直连哔咔会超时，通常需要走 Clash 等本地代理'),
        el('div', { class: 'row gap-8' }, [el('div', { class: 'grow' }, [proxyHost]), el('div', { style: { width: '110px' } }, [proxyPort])]),
        fld('下载格式', fmtSel), fld('目录格式 dirFmt', dirFmt),
        el('div', { class: 'row gap-8' }, [fld('章并发', chConc), fld('图并发', imgConc)]),
        fld('导出目录', exportDir)
      ]),
      el('div', { class: 'card card-pad col gap-10' }, [
        el('div', { class: 'section-title', text: '03 — 查重' }),
        fld('待查目录', ddScan, '查重模块扫描这个目录里的「直接包含图片的文件夹」'),
        el('div', { class: 'row gap-8' }, [fld('像素阈值 MAD', ddThresh, '越小越严格，默认 8'), fld('缩略图张数', ddThumb)]),
        el('div', { class: 'alert alert-info' }, [ctx.icon('info'), el('span', { text: '比对库 = 全部启用的库根，不再单独配置。' })])
      ]),
      el('div', { class: 'card card-pad col gap-10' }, [
        el('div', { class: 'section-title', text: '04 — 桌面与运行' }),
        el('div', { class: 'row between gap-10' }, [el('span', { text: '开机自动启动漫库' }), autostart]),
        el('div', { class: 'rule' }),
        el('div', { class: 'ledger' }, [
          el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: '形态' }), el('span', { class: 'd' }), el('span', { class: 'v', text: 'desktop（App 窗口）' })]),
          el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: 'Node' }), el('span', { class: 'd' }), el('span', { class: 'v', text: sys.node })]),
          el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: '配置' }), el('span', { class: 'd' }), el('span', { class: 'v ellipsis', text: sys.configFile })]),
          el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: '数据' }), el('span', { class: 'd' }), el('span', { class: 'v ellipsis', text: sys.dataDir })]),
          el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: '运行时长' }), el('span', { class: 'd' }), el('span', { class: 'v', text: ctx.fmt.dur(sys.uptimeMs) })])
        ]),
        el('div', { class: 'rule' }),
        el('div', { class: 'section-title', text: '模块状态' }),
        el('div', { class: 'ledger' }, modules)
      ])
    ])
  ]));

  renderRoots();
  refreshAutostart();
}
