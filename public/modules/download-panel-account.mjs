/**
 * 「我的」页签：登录表单 / 账号资料卡 / 登出。
 *
 * 从 mount() 闭包里搬出来的代码：el / api / ctx / state 原本都是 mount 的同作用域变量，
 * 这里由参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeAccountPanel(ctx, state, deps) {
  const el = deps.el;
  const api = deps.api;
  const { loadingBox, errorBox, textOf, errorMessage, isAuthError, isCoverUrl } = deps.s;
  const refreshInfo = deps.refreshInfo;

  /* 骨架容器由装配层传入：页签内容整体挂到 mount 建好的那个 div 上。 */
  const accountPanel = deps.panel;

  /* ---------------- 我的（登录 / 资料） ---------------- */
  const accountStatus = el('div', { class: 'small muted mv-dl-account-status', text: '' });
  let accountGrid = null;

  function buildAccountPanel() {
    accountPanel.textContent = '';
    accountPanel.appendChild(el('div', { class: 'col gap-6' }, [
      el('div', { class: 'section-title', text: '我的账号' }),
      accountStatus
    ]));
    accountGrid = el('div', { class: 'col gap-14' });
    accountPanel.appendChild(accountGrid);
  }

  async function loadAccount() {
    state.accountLoading = true;
    renderAccount('');
    let note = '';
    let errText = '';
    try {
      const r = await api('/api/download/account');
      const account = r && r.account ? r.account : null;
      state.account = account;
      state.remembered = Array.isArray(r && r.remembered) ? r.remembered : [];
      if (account && !state.loginEmail) state.loginEmail = textOf(account.email);
      note = textOf(r && r.message);
    } catch (err) {
      state.account = null;
      state.profileError = '';
      errText = errorMessage(err, '登录状态读取失败');
      ctx.toast('登录状态读取失败：' + errText, 'err');
    } finally {
      /* 必须先清掉 loading 标志、再渲染一次。
         曾经写成「在 try 里 renderAccount()，finally 里只清标志」——
         render 时 accountLoading 还是 true，于是面板永远停在「正在读取登录状态…」，
         登录表单永远不出现。收尾方式与 loadProfile() 保持一致。 */
      state.accountLoading = false;
      renderAccount(errText);
    }
    if (!state.account && note) ctx.toast(note, 'warn');
  }

  /** 「我的」页签进入逻辑：先确认登录态，再确保资料已经拉过。 */
  async function loadAccountTab() {
    await loadAccount();
    ensureProfileLoaded();
  }

  /**
   * 已登录但还没有资料时补拉一次；已有资料或正在拉就不重复发请求。
   * 为什么需要它：登录态可能是由 SSE 账号事件补上的（后端 login 会 hub.send('account')），
   * 那条路径只更新 state.account 并重绘，不会去拉资料 —— 于是界面停在
   * 「登录后点「重新获取」即可向哔咔拉取账号资料。」，用户看到的是「登录成功却没有资料」。
   */
  function ensureProfileLoaded() {
    if (!state.account) return;
    if (state.profile || state.profileLoading) return;
    loadProfile();
  }

  function renderAccount(errorText) {
    if (!accountGrid) return;
    accountGrid.textContent = '';
    if (state.accountLoading) { accountGrid.appendChild(loadingBox('正在读取登录状态…')); return; }
    if (errorText) {
      accountGrid.appendChild(errorBox('登录状态读取失败', errorText, loadAccount));
      accountGrid.appendChild(renderLoginForm());
      return;
    }
    if (!state.account) {
      accountStatus.textContent = '未登录：登录后可同步收藏夹与账号资料';
      accountGrid.appendChild(renderLoginForm());
      return;
    }
    accountStatus.textContent = '已登录' + (state.remembered && state.remembered.length ? ' · 已记住 ' + state.remembered.length + ' 个账号' : '');
    accountGrid.appendChild(renderProfileCard());
    accountGrid.appendChild(renderProfileSection());
  }

  function fieldRow(label, node) {
    return el('div', { class: 'col gap-4 mv-dl-field' }, [el('div', { class: 'label', text: label }), node]);
  }

  function renderLoginForm() {
    const hint = state.remembered && state.remembered.length
      ? '也可以直接使用已记住的账号：' + state.remembered.join('、')
      : '账号信息只用于登录哔咔，保存在本机数据目录，不会上传到别处。';
    const emailInput = el('input', {
      class: 'input', type: 'text', autocomplete: 'username', placeholder: '哔咔邮箱 / 用户名', value: textOf(state.loginEmail)
    });
    const passInput = el('input', {
      class: 'input', type: 'password', autocomplete: 'current-password', placeholder: '哔咔密码'
    });
    const submitBtn = el('button', { class: 'btn btn-primary', disabled: state.loggingIn }, [ctx.icon('user'), el('span', { text: state.loggingIn ? '登录中…' : '登录' })]);
    const form = el('form', { class: 'card card-pad mv-dl-login', on: { submit: function (e) { if (e && e.preventDefault) e.preventDefault(); doLogin(); } } }, [
      el('div', { class: 'section-title', text: '登录哔咔账号' }),
      el('div', { class: 'mv-dl-login-grid' }, [
        fieldRow('邮箱 / 用户名', emailInput),
        fieldRow('密码', passInput)
      ]),
      el('div', { class: 'row gap-8 center wrap mv-dl-login-act' }, [
        submitBtn,
        el('span', { class: 'small muted grow', text: hint })
      ])
    ]);

    async function doLogin() {
      if (state.loggingIn) return;
      const email = emailInput.value.trim();
      const password = passInput.value;
      if (!email) { ctx.toast('请输入邮箱 / 用户名', 'warn'); emailInput.focus(); return; }
      if (!password) { ctx.toast('请输入密码', 'warn'); passInput.focus(); return; }
      state.loginEmail = email;
      state.loggingIn = true;
      submitBtn.disabled = true;
      submitBtn.textContent = '';
      submitBtn.appendChild(ctx.icon('user'));
      submitBtn.appendChild(el('span', { text: '登录中…' }));
      try {
        const r = await ctx.post('/api/download/login', { email: email, password: password });
        passInput.value = '';
        state.loginPassword = '';
        state.account = (r && r.account) || state.account || null;
        state.profile = null;
        state.profileError = '';
        ctx.toast(textOf(r && r.message) || '登录成功', 'ok');
        renderAccount('');
        refreshInfo();
        loadProfile();
      } catch (err) {
        const message = errorMessage(err, '登录失败');
        ctx.toast('登录失败：' + message, 'err');
        accountStatus.textContent = '登录失败：' + message;
        renderAccount('');
        accountStatus.textContent = '登录失败：' + message;
      } finally {
        state.loggingIn = false;
        submitBtn.disabled = false;
      }
    }

    return form;
  }

  function renderProfileSection() {
    const wrap = el('div', { class: 'col gap-10' }, [
      el('div', { class: 'row between gap-10 wrap' }, [
        el('div', { class: 'section-title', text: '账号资料' }),
        el('button', { class: 'btn btn-sm btn-ghost', on: { click: loadProfile } }, [ctx.icon('refresh'), el('span', { text: '重新获取' })])
      ])
    ]);
    if (state.profileLoading) wrap.appendChild(loadingBox('正在获取账号资料…'));
    else if (state.profileError) wrap.appendChild(errorBox('资料获取失败', state.profileError, loadProfile));
    else if (state.profile) wrap.appendChild(renderProfileDetail(state.profile));
    else wrap.appendChild(el('div', { class: 'small muted', text: '登录后点「重新获取」即可向哔咔拉取账号资料。' }));
    return wrap;
  }

  function avatarNode(profile) {
    const name = textOf(profile && (profile.name || profile.email));
    const url = textOf(profile && profile.avatar);
    const box = el('div', { class: 'mv-dl-avatar' });
    // 同一坑：头像地址同样是站内绝对路径 /api/download/cover?path=...（没有字面 '//'），
    // 用 indexOf('//') 判断会让头像永远是首字占位块。统一走 isCoverUrl。
    if (isCoverUrl(url)) {
      const img = el('img', { class: 'mv-dl-avatar-img', src: url, alt: name || '头像' });
      img.addEventListener('error', function () { img.remove(); box.appendChild(avatarFallback(name)); });
      box.appendChild(img);
    } else {
      box.appendChild(avatarFallback(name));
    }
    return box;
  }

  function avatarFallback(name) {
    return el('div', { class: 'mv-dl-avatar-fallback', text: String(name || '漫').slice(0, 1) });
  }

  /** 账号资料卡：头像 + 昵称 + 等级 / 经验（头像地址由后端 profile.avatar 给）。 */
  function renderProfileCard() {
    const profile = state.profile || state.account || {};
    const displayName = textOf(profile.name) || '（未返回昵称）';
    const level = Number(profile.level || 0);
    const exp = Number(profile.exp || 0);
    const expMax = Math.max(100, exp);
    return el('div', { class: 'card card-pad mv-dl-profile' }, [
      el('div', { class: 'row gap-14 wrap' }, [
        avatarNode(profile),
        el('div', { class: 'col gap-6 grow', style: { minWidth: '220px' } }, [
          el('div', { class: 'row gap-8 center wrap' }, [
            el('div', { class: 'mv-dl-profile-name', text: displayName }),
            el('span', { class: 'badge badge-accent', text: 'Lv ' + level }),
            profile.role ? el('span', { class: 'badge', text: '角色 ' + textOf(profile.role) }) : null,
            profile.id ? el('span', { class: 'badge', text: 'ID ' + textOf(profile.id) }) : null
          ]),
          profile.email ? el('div', { class: 'small muted', text: '邮箱：' + textOf(profile.email) }) : null,
          el('div', { class: 'col gap-4' }, [
            el('div', { class: 'row between gap-8 small muted' }, [
              el('span', { text: '经验值' }),
              el('span', { class: 'mono', text: String(exp) })
            ]),
            el('div', { class: 'progress' }, [el('i', { style: { width: ctx.fmt.pct(exp, expMax) + '%' } })]),
            el('div', { class: 'small muted', text: '经验进度按当前经验估算，仅供参考' })
          ])
        ]),
        el('div', { class: 'row gap-6 wrap' }, [
          el('button', { class: 'btn btn-sm btn-ghost', on: { click: loadProfile } }, [ctx.icon('refresh'), el('span', { text: '刷新资料' })]),
          el('button', { class: 'btn btn-sm btn-danger', on: { click: doLogout } }, [ctx.icon('power'), el('span', { text: '退出登录' })])
        ])
      ])
    ]);
  }

  /** 契约字段表：有值才显示，字段缺失显示「未返回」。 */
  function renderProfileDetail(profile) {
    const rows = [
      ['昵称', textOf(profile.name)],
      ['邮箱', textOf(profile.email)],
      ['用户 ID', textOf(profile.id)],
      ['等级', profile.level === undefined ? '' : String(profile.level)],
      ['经验值', profile.exp === undefined ? '' : String(profile.exp)],
      /* 哔咔不返回 role（实测缺字段），但会返回 title（头衔，例如「萌新」）与 verified。
         把有值的那个显示出来，比一律显示「未返回」有用。 */
      ['头衔', textOf(profile.title) || textOf(profile.role)],
      ['认证', profile.verified ? '已认证' : '未认证']
    ];
    const list = el('div', { class: 'ledger mv-dl-ledger' });
    for (const r of rows) {
      list.appendChild(el('div', { class: 'ledger-row' }, [
        el('span', { class: 'k', text: r[0] }),
        el('span', { class: 'd' }),
        el('span', { class: 'v', text: r[1] || '未返回' })
      ]));
    }
    return list;
  }

  async function loadProfile() {
    if (!state.account) return;
    state.profileLoading = true;
    state.profileError = '';
    renderAccount('');
    try {
      const r = await api('/api/download/profile');
      state.profile = (r && r.profile) || null;
      state.profileError = '';
      if (!state.profile) ctx.toast('接口没有返回 profile 字段', 'warn');
    } catch (err) {
      if (isAuthError(err)) {
        state.account = null;
        state.profile = null;
        state.profileError = '';
        const message = errorMessage(err, '登录已过期，请重新登录');
        ctx.toast(message, 'warn');
        renderAccount('');
        accountStatus.textContent = '登录已过期：' + message;
        return;
      }
      const message = errorMessage(err, '账号资料获取失败');
      state.profileError = message;
      ctx.toast('账号资料获取失败：' + message, 'err');
    } finally {
      /* 必须先清 profileLoading 再渲染，否则面板会一直停在「正在获取账号资料…」。
         与 loadAccount() 的收尾方式一致；这里曾被改成 if (false) + 空 try/finally 的调试版，
         结果错误分支整个失效（异常直接冒泡），已恢复。 */
      state.profileLoading = false;
      renderAccount('');
    }
  }

  async function doLogout() {
    const ok = await ctx.confirm('退出登录后收藏夹与账号资料将不可用，已下载的文件不受影响。', { title: '退出登录', okText: '退出登录' });
    if (!ok) return;
    try {
      const r = await ctx.post('/api/download/logout', {});
      ctx.toast(textOf(r && r.message) || '已退出登录', 'ok');
    } catch (err) {
      ctx.toast('退出登录失败：' + err.message, 'err');
      return;
    }
    state.account = null;
    state.profile = null;
    state.profileError = '';
    state.remembered = [];
    state.loginEmail = '';
    state.loginPassword = '';
    renderAccount('');
    refreshInfo();
  }

  return {
    buildAccountPanel: buildAccountPanel,
    loadAccount: loadAccount,
    loadAccountTab: loadAccountTab,
    ensureProfileLoaded: ensureProfileLoaded,
    renderAccount: renderAccount
  };
}
