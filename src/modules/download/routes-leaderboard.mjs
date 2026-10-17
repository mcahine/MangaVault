/**
 * 下载模块路由：排行榜 / 账号资料。
 *
 * 从 index.mjs 的 register() 闭包里拆出来，路由体逻辑与原实现逐字节一致；
 * 共享闭包状态由 index.mjs 组装成上下文对象传入，避免把 register 再撑回上千行。
 */

import * as sources from './sources/index.mjs';
import { diskFree, isInside, chapterStats, scanChapterStates, coverUrlFor } from './comic.mjs';

export function registerRoutes(app, s) {
  const { coverPathOf, currentProxy, localComic, pickSource, replyPickedError, replySourceError, requireToken } = s;

  /* ================= 排行榜 / 账号资料 ================= */

  /**
   * 排行榜：GET /api/download/leaderboard?tt=H24|D7|D30&ct=VC&page=N。
   * 哔咔上游一次返回全榜（不分页，pages 固定为 1），tt 取值统一由注册表的 RANK_TYPES 约束；
   * ct 只支持 VC，其余取值由适配器抛 NotSupportedError，这里降级成带 code=NOT_SUPPORTED 的 400。
   * comics 元素与 /api/download/search 的 element 逐字同形，前端复用同一个卡片渲染器。
   */
  app.get('/api/download/leaderboard', async function (c) {
    const tt = String(c.query('tt', '') || '').trim() || 'H24';
    const ct = String(c.query('ct', '') || '').trim() || 'VC';
    const page = Math.max(1, c.queryInt('page', 1));
    if (sources.RANK_TYPES.indexOf(tt) < 0) {
      c.error(400, '排行榜周期 tt 只支持 ' + sources.RANK_TYPES.join('/') + '，收到：' + tt);
      return;
    }
    if (!requireToken(c)) return;
    const picked = pickSource(c, 'leaderboard');
    if (!picked.source) { replyPickedError(c, picked); return; }
    await currentProxy();
    try {
      const data = await picked.source.leaderboard({ rankType: tt, ct: ct });
      const docs = Array.isArray(data.docs) ? data.docs : [];
      const comics = [];
      for (const d of docs) {
        const id = String(d.id || '');
        const cover = coverPathOf(d);
        const local = await localComic(id, d.title || '');
        comics.push({
          id: id,
          title: d.title || '',
          author: d.author || '',
          cover: cover,
          tags: (d.tags || []).slice(0, 8),
          categories: (d.categories || []).slice(0, 6),
          chapterCount: Number(d.chapterCount || 0),
          likes: Number(d.likes || 0),
          finished: Boolean(d.finished),
          inLibrary: Boolean(local),
          localDir: local ? local.dir : null,
          rootName: local ? local.rootName : null
        });
      }
      c.json({
        ok: true,
        source: picked.sourceId,
        rankType: String(data.rankType || tt),
        ct: String(data.ct || ct),
        page: Number(data.page || page),
        pages: Number(data.pages || 1),
        total: Number(data.total || comics.length),
        comics: comics
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      if (status === 401 || status === 403) { c.error(401, '登录已过期或 token 无效，请重新登录后再看排行榜'); return; }
      c.error(502, '获取排行榜失败：' + (err && err.message ? err.message : err));
    }
  });

  /**
   * 当前登录账号资料：GET /api/download/profile。
   * 只读路由，不写任何账号缓存；对外只暴露契约约定的七个字段（raw 不出去）。
   */
  app.get('/api/download/profile', async function (c) {
    if (!requireToken(c)) return;
    const picked = pickSource(c, 'profile');
    if (!picked.source) { replyPickedError(c, picked); return; }
    await currentProxy();
    try {
      const p = await picked.source.profile();
      c.json({
        ok: true,
        source: picked.sourceId,
        profile: {
          id: String(p.id || ''),
          name: p.name || '',
          email: p.email || '',
          // 头像同样是哔咔 CDN 直链，必须转成后端封面代理地址：
          // 前端（浏览器）拿不到代理，直连 CDN 只会得到裂图。与卡片封面同一条链路。
          avatar: p.avatar ? coverUrlFor(String(p.avatar)) : '',
          level: Number(p.level || 0),
          exp: Number(p.exp || 0),
          /* 哔咔没有 role 字段（实测未返回），真正有值的是头衔与认证状态，一并透传。 */
          role: p.role || '',
          title: p.title || '',
          verified: Boolean(p.verified)
        }
      });
    } catch (err) {
      if (replySourceError(c, err)) return;
      const status = err && err.status ? err.status : 0;
      if (status === 401 || status === 403) { c.error(401, '登录已过期或 token 无效，请重新登录'); return; }
      c.error(502, '读取账号资料失败：' + (err && err.message ? err.message : err));
    }
  });
}
