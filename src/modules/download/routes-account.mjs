/**
 * 下载模块路由：登录 / 账号。
 *
 * 从 index.mjs 的 register() 闭包里拆出来，路由体逻辑与原实现逐字节一致；
 * 共享闭包状态由 index.mjs 组装成上下文对象传入，避免把 register 再撑回上千行。
 */

import * as auth from './auth.mjs';

export function registerRoutes(app, s) {
  const { ctx, currentProxy, pickSource, rawClientOf, replySourceError, tokenInfo, accountCheck, hub, logger } = s;

  /* ================= 登录 / 账号 ================= */

  app.post('/api/download/login', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const remember = body.remember === true || body.remember === 'true';
    if (!email) { c.error(400, '请输入邮箱/用户名'); return; }
    if (!password) { c.error(400, '请输入密码'); return; }
    await currentProxy();
    const picked = pickSource(c, 'login');
    if (!picked.source) { c.error(400, picked.error); return; }
    try {
      // 契约里的 login：内部就是 POST auth/sign-in 且不带 authorization（过期 token 不该挡住登录）
      const login = await picked.source.login({ email: email, password: password });
      const token = String(login.token || '');
      if (!token) { c.error(502, '登录响应里没有 token，可能是上游接口变更'); return; }
      await ctx.saveConfig({ picacomic: { token: token } });
      const account = auth.normalizeProfile(login.user || login.raw || {});
      await auth.saveAccount(account, true);
      if (remember) {
        try { await auth.rememberCredential(email, password); } catch (e) { logger.warn('保存登录信息失败：' + e.message); }
      } else {
        try { await auth.forgetCredential(email); } catch (e) { /* ignore */ }
      }
      accountCheck.at = Date.now();
      hub.send('account', { status: 'login', ...tokenInfo(), account: account });
      logger.info('哔咔登录成功：' + (account.name || email));
      c.json({ ok: true, message: '登录成功', ...tokenInfo(), account: account, remember: remember });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      let reason = '登录失败：' + (err && err.message ? err.message : err);
      if (status === 401) reason = '邮箱或密码不正确，或上游拒绝了本次登录（哔咔返回 401 unauthorized）';
      else if (status === 400) reason = '邮箱或密码格式不正确，请检查后重试';
      else if (status === 429) reason = '登录过于频繁，请稍后再试';
      logger.warn('登录失败：' + reason);
      c.error(status === 401 || status === 400 ? 401 : 502, reason);
    }
  });

  app.post('/api/download/logout', async function (c) {
    await ctx.saveConfig({ picacomic: { token: '' } });
    await auth.clearAccount();
    accountCheck.at = 0;
    hub.send('account', { status: 'logout', ...tokenInfo(), account: null });
    c.json({ ok: true, message: '已退出登录', ...tokenInfo() });
  });

  app.post('/api/download/register', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const name = String(body.name || '').trim();
    if (!email || !password || !name) { c.error(400, '请填写邮箱、密码与昵称'); return; }
    if (password.length < 6) { c.error(400, '密码至少 6 位'); return; }
    await currentProxy();
    const picked = pickSource(c);
    if (!picked.source) { c.error(400, picked.error); return; }
    try {
      // 注册尚未纳入契约：走适配器暴露的底层客户端，路径/请求体与改造前逐字一致
      const payload = { email: email, password: password, name: name };
      const invite = String(body.inviteCode === undefined || body.inviteCode === null ? '' : body.inviteCode);
      if (invite) payload.inviteCode = invite;
      const res = await rawClientOf(picked.source).raw('POST', 'auth/register', payload, false);
      const r = (res && res.data) || {};
      c.json({ ok: true, message: '注册请求已提交', data: r });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      let reason = '注册失败：' + (err && err.message ? err.message : err);
      if (status === 401 || status === 403) reason = '上游已关闭注册或需要邀请码（哔咔返回 ' + status + '），请到哔咔官方渠道注册后再回来登录';
      else if (status === 400) reason = '注册信息不符合要求（邮箱已占用或格式不合法）';
      c.error(status === 400 ? 400 : 502, reason);
    }
  });

  app.post('/api/download/forgot', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const email = String(body.email || '').trim();
    if (!email) { c.error(400, '请输入注册邮箱'); return; }
    await currentProxy();
    const picked = pickSource(c);
    if (!picked.source) { c.error(400, picked.error); return; }
    try {
      await rawClientOf(picked.source).raw('POST', 'auth/forgot-password', { email: email }, false);
      c.json({ ok: true, message: '重置邮件请求已提交，请检查邮箱' });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      c.error(502, status === 404 ? '上游没有提供找回密码接口，请到哔咔 App 内操作' : ('找回密码失败：' + (err && err.message ? err.message : err)));
    }
  });

  app.get('/api/download/account', async function (c) {
    const data = await auth.loadAccount();
    const info = tokenInfo();
    const out = {
      ok: true,
      ...info,
      account: data.account || null,
      tokenOk: Boolean(data.tokenOk),
      checkedAt: data.tokenCheckedAt || null,
      remembered: await auth.listCredentials(),
      credentialsNote: auth.CREDENTIALS_NOTE
    };
    // 10 分钟缓存：不每次打上游，但 token 变了要立刻校验
    if (!info.hasToken) { out.tokenOk = false; c.json(out); return; }
    if (!auth.needsRefresh(data, 600000) && Date.now() - accountCheck.at > 5000) { c.json(out); return; }
    accountCheck.at = Date.now();
    const picked = pickSource(c, 'profile');
    if (!picked.source) { c.error(400, picked.error); return; }
    try {
      await currentProxy();
      const profile = await picked.source.profile();
      // 账号缓存保留来源原始字段（slogan / gender / characters 不在统一契约里）
      const account = auth.normalizeProfile(profile.raw || profile);
      await auth.saveAccount(account, true);
      out.account = account;
      out.tokenOk = true;
      out.checkedAt = new Date().toISOString();
      c.json(out);
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      if (status === 401 || status === 403) {
        // token 失效：自动清理，避免前端一直拿着废 token 打上游
        await ctx.saveConfig({ picacomic: { token: '' } });
        await auth.clearAccount();
        hub.send('account', { status: 'expired', ...tokenInfo(), account: null });
        out.hasToken = false;
        out.tokenPreview = '';
        out.tokenOk = false;
        out.account = null;
        out.message = '登录已过期，请重新登录';
        c.json({ ok: true, ...out });
        return;
      }
      out.tokenOk = false;
      out.message = '账号校验失败：' + (err && err.message ? err.message : err);
      c.json(out);
    }
  });
}
