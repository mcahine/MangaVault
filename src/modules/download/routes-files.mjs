/**
 * 下载模块路由：SSE / 文件 / 目录。
 *
 * 从 index.mjs 的 register() 闭包里拆出来，路由体逻辑与原实现逐字节一致；
 * 共享闭包状态由 index.mjs 组装成上下文对象传入，避免把 register 再撑回上千行。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { diskFree, isInside, chapterStats, scanChapterStates, coverUrlFor } from './comic.mjs';
import { roots, activeRoots, ownerRootOf, probeRoots, labelOf } from '../../core/roots.mjs';
import { safeJoin } from '../../core/util.mjs';
import { spawn } from 'node:child_process';

export function registerRoutes(app, s) {
  const { ctx, cfg, currentProxy, exports, hub, localComic, paths, pickSource, replyPickedError, replySourceError, requireToken, root, sse, tasks, tokenInfo } = s;

  /* ================= SSE / 文件 / 目录 ================= */

  app.get('/api/download/events', function (c) {
    const conn = c.sse();
    const send = function (event, data) {
      if (conn.closed) return;
      conn.send(event, data);
    };
    const acct = tokenInfo();
    conn.send('state', { tasks: tasks.list(), stats: tasks.status(), account: acct });
    const off = sse.subscribe(function (event, payload) { send(event, payload); });
    conn.onClose(off);
  });

  /* 远程封面的小缓存：前端一屏可能有几十张卡，拖动/切页会重复请求同一个 URL。
     缓存 10 分钟、最多 300 条，避免每次都穿代理回源，也不至于把内存撑爆。 */
  const remoteCoverCache = new Map();
  const REMOTE_COVER_TTL = 10 * 60 * 1000;

  /** 哔咔图片 CDN 的域名白名单：只允许从这些域回源，避免这个路由被当成任意代理。 */
  function isAllowedImageHost(host) {
    const h = String(host || '').toLowerCase();
    const allow = ['picacomic.com', 'picacomiccn.com', 'picacgz.com'];
    return allow.some(function (suffix) { return h === suffix || h.endsWith('.' + suffix); });
  }

  app.get('/api/download/cover', async function (c) {
    const target = String(c.query('path', '') || '');
    if (!target) { c.error(400, '缺少 path 参数'); return; }

    /* 远程封面：排行榜 / 搜索 / 收藏的卡片用的是哔咔 CDN 直链（thumb），
       后端没有先把它们落盘，所以这里必须**由后端经代理取回再转发**。
       前端拿不到代理，直连 CDN 只会得到裂图 —— 这正是「排行榜卡片全是占位图」的原因。 */
    if (/^https?:\/\//i.test(target)) {
      let imgUrl = null;
      try { imgUrl = new URL(target); } catch (e) { c.error(400, '封面地址非法'); return; }
      if (!isAllowedImageHost(imgUrl.hostname)) { c.error(400, '封面域名不在允许列表内，已拒绝'); return; }
      const hit = remoteCoverCache.get(target);
      if (hit && Date.now() - hit.at < REMOTE_COVER_TTL) {
        c.res.statusCode = 200;
        c.res.setHeader('Content-Type', hit.type || 'image/jpeg');
        c.res.setHeader('Cache-Control', 'private, max-age=3600');
        c.res.end(hit.buf);
        return;
      }
      const picked = pickSource(c, 'download');
      if (!picked.source) { replyPickedError(c, picked); return; }
      await currentProxy();
      try {
        const dl = await picked.source.download(target, {});
        if (!dl || !dl.buffer || !dl.buffer.length) { c.error(502, '封面内容为空'); return; }
        if (remoteCoverCache.size >= 300) remoteCoverCache.delete(remoteCoverCache.keys().next().value);
        remoteCoverCache.set(target, { at: Date.now(), buf: dl.buffer, type: dl.contentType || 'image/jpeg' });
        c.res.statusCode = 200;
        c.res.setHeader('Content-Type', dl.contentType || 'image/jpeg');
        c.res.setHeader('Cache-Control', 'private, max-age=3600');
        c.res.end(dl.buffer);
      } catch (err) {
        c.error(502, '取封面失败：' + (err && err.message ? err.message : String(err)));
      }
      return;
    }

    const abs = path.resolve(target);
    const r = root();
    const owner = ownerRootOf(cfg(), abs);
    if (!isInside(abs, abs)) { c.error(400, '图片路径非法'); return; }
    if (!owner && !(r && isInside(r, abs))) { c.error(400, '图片路径越界，已拒绝'); return; }
    await c.file(abs, { cacheSeconds: 3600 });
  });

  app.post('/api/download/open-folder', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    let dir = '';
    if (body.taskId) {
      const t = tasks.get(body.taskId);
      if (!t) { c.error(404, '任务不存在'); return; }
      dir = t.dir || paths().comicDir(t.title);
    } else if (body.exportId) {
      const job = await exports.get(body.exportId);
      if (!job) { c.error(404, '导出任务不存在'); return; }
      dir = job.outPath ? path.dirname(job.outPath) : '';
    } else if (body.path) {
      dir = path.resolve(String(body.path));
    } else if (body.comicId) {
      const local = await localComic(String(body.comicId), body.title ? String(body.title) : '');
      if (local) dir = local.dir;
      else dir = paths().comicDir(String(body.title || body.comicId));
    } else if (body.comicTitle) {
      dir = paths().comicDir(String(body.comicTitle));
    } else {
      dir = root();
    }
    if (!dir) { c.error(400, '没有可打开的目录'); return; }
    // 基准根：库根（多根）优先，其次下载根；必须是已存在目录
    const owner = ownerRootOf(cfg(), dir);
    const base = owner ? owner.path : root();
    if (!base) { c.error(400, '未配置库根/下载根，无法校验路径'); return; }
    try {
      dir = safeJoin(base, path.relative(base, dir));
    } catch (err) {
      c.error(400, '路径越界，已拒绝打开');
      return;
    }
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) { c.error(404, '不是目录：' + dir); return; }
    } catch (e) {
      c.error(404, '目录不存在（可能还没开始下载）：' + dir);
      return;
    }
    try {
      await new Promise(function (resolve, reject) {
        const p = spawn('explorer', [dir], { detached: true, stdio: 'ignore' });
        p.once('error', reject);
        p.once('spawn', function () { if (p.unref) p.unref(); resolve(true); });
      });
      c.json({ ok: true, dir: dir, message: '已在资源管理器中打开：' + dir });
    } catch (err) {
      c.error(500, '打开目录失败：' + (err && err.message ? err.message : err));
    }
  });

  /**
   * 手动设置哔咔 token：POST /api/download/token { token, verify? }
   * 为什么需要它：登录接口要求账号密码，而哔咔 App 抓到的 JWT 是最直接的凭据；
   * 之前前端「设置」页只有一句「请到下载页填写 token」，下载页却根本没有输入框 ——
   * 两个页面互相指路，用户无从下手。这里给出唯一入口，并在保存前**真校验一次**，
   * 避免把一个错的 token 存进配置（那会让后续所有请求都以 401 失败）。
   */
  app.post('/api/download/token', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const raw = String(body.token || '').trim();
    if (!raw) { c.error(400, '请粘贴哔咔 token'); return; }
    if (raw.length < 40 || raw.indexOf('.') < 0) { c.error(400, '这个不像哔咔 token（应是三段式 JWT，长度通常 200+）'); return; }
    const verify = body.verify !== false;
    await ctx.saveConfig({ picacomic: { token: raw } });
    if (!verify) { c.json({ ok: true, verified: false, message: 'token 已保存（未校验）', ...tokenInfo() }); return; }
    const picked = pickSource(c, 'profile');
    if (!picked.source) { c.error(400, picked.error); return; }
    await currentProxy();
    try {
      const profile = await picked.source.profile();
      const account = auth.normalizeProfile(profile.raw || profile);
      await auth.saveAccount(account, true);
      hub.send('account', { status: 'login', ...tokenInfo(), account: account });
      c.json({ ok: true, verified: true, message: 'token 有效，已登录为 ' + (account.name || account.email || account.id), account: account, ...tokenInfo() });
    } catch (err) {
      await ctx.saveConfig({ picacomic: { token: '' } });
      await auth.clearAccount();
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      const why = status === 401 || status === 403
        ? 'token 无效或已过期'
        : (err && err.message ? err.message : '连不上哔咔');
      c.error(status === 401 || status === 403 ? 401 : 502, 'token 未保存：' + why);
    }
  });

  app.get('/api/download/token-check', async function (c) {
    if (!requireToken(c)) return;
    const picked = pickSource(c, 'profile');
    if (!picked.source) { c.error(400, picked.error); return; }
    await currentProxy();
    try {
      const profile = await picked.source.profile();
      const account = auth.normalizeProfile(profile.raw || profile);
      await auth.saveAccount(account, true);
      c.json({ ok: true, message: 'token 有效', account: account, ...tokenInfo() });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      if (status === 401 || status === 403) {
        await ctx.saveConfig({ picacomic: { token: '' } });
        await auth.clearAccount();
        hub.send('account', { status: 'expired', ...tokenInfo(), account: null });
        c.error(401, '登录已过期，请重新登录');
        return;
      }
      c.error(502, err && err.message ? err.message : 'token 校验失败');
    }
  });
}
