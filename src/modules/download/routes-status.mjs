/**
 * 下载模块路由：状态 / 代理 / 配置。
 *
 * 从 index.mjs 的 register() 闭包里拆出来，路由体逻辑与原实现逐字节一致；
 * 共享闭包状态由 index.mjs 组装成上下文对象传入，避免把 register 再撑回上千行。
 */

import * as auth from './auth.mjs';
import fsp from 'node:fs/promises';
import { createPaths, extOfFormat, findComicDirById } from './paths.mjs';
import { diskFree, isInside, chapterStats, scanChapterStates, coverUrlFor } from './comic.mjs';
import { resolveProxy, testConnection } from './proxy.mjs';
import { roots, activeRoots, ownerRootOf, probeRoots, labelOf } from '../../core/roots.mjs';

export function registerRoutes(app, s) {
  const { ctx, cfg, currentProxy, exportDir, picaCfg, root, tokenInfo, exports, hub, sse, tasks } = s;

  /* ================= 状态 / 代理 / 配置 ================= */

  app.get('/api/download/state', async function (c) {
    try {
      const r = root();
      let rootExists = false;
      try { rootExists = (await fsp.stat(r)).isDirectory(); } catch (e) { rootExists = false; }
      const free = r ? await diskFree(r) : null;
      const st = tasks.status();
      const proxy = await currentProxy();
      const acct = await auth.loadAccount();
      const rr = await probeRoots(cfg());
      c.json({
        ok: true,
        ...tokenInfo(),
        downloadRoot: r,
        rootExists: rootExists,
        freeBytes: free,
        format: picaCfg().downloadFormat || 'Jpeg',
        ext: extOfFormat(picaCfg().downloadFormat || 'Jpeg'),
        dirFmt: picaCfg().dirFmt || '{comic_title}/{order} {chapter_title}',
        apiBase: picaCfg().apiBase || 'https://picaapi.picacomic.com',
        proxy: proxy.url || null,
        proxyInfo: proxy,
        exportDir: await exportDir(),
        roots: rr,
        libraryRoots: rr.map(function (x) { return { id: x.id, name: x.name, dirs: x.dirs, enabled: x.enabled }; }),
        account: acct.account || null,
        tokenOk: Boolean(acct.tokenOk),
        concurrency: {
          chapterConcurrency: Number(picaCfg().chapterConcurrency || 2),
          chapterIntervalMs: Number(picaCfg().chapterIntervalMs === undefined ? (picaCfg().chapterDownloadIntervalSec || 0) * 1000 : picaCfg().chapterIntervalMs),
          imgConcurrency: Number(picaCfg().imgConcurrency || 8),
          imgIntervalMs: Number(picaCfg().imgIntervalMs === undefined ? (picaCfg().imgDownloadIntervalSec || 0) * 1000 : picaCfg().imgIntervalMs),
          maxConcurrentTasks: Number(picaCfg().maxConcurrentTasks || 2),
          retryTimes: Number(picaCfg().retryTimes || 3),
          globalSpeedLimitKb: Number(picaCfg().globalSpeedLimitKb || 0)
        },
        runningTasks: st.runningTasks,
        queuedTasks: st.queuedTasks,
        totalTasks: st.totalTasks,
        exportBusy: exports.isBusy(),
        serverStartedAt: (tasks.store.data && tasks.store.data.serverStartedAt) || null,
        sseClients: sse.clientCount(),
        sseStats: sse.stats()
      });
    } catch (err) {
      c.error(500, '读取下载模块状态失败：' + (err && err.message ? err.message : err));
    }
  });

  app.get('/api/download/proxy-test', async function (c) {
    try {
      const proxy = await currentProxy();
      const apiBase = String(picaCfg().apiBase || 'https://picaapi.picacomic.com');
      let host = 'picaapi.picacomic.com';
      let port = 443;
      let tlsOk = true;
      try {
        const u = new URL(apiBase);
        host = u.hostname;
        port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
        tlsOk = u.protocol === 'https:';
      } catch (e) { /* 用默认 */ }
      const result = await testConnection({ host: host, port: port, tls: tlsOk, proxy: proxy.url, timeoutMs: 8000 });
      c.json({ ok: true, proxy: proxy, result: result });
    } catch (err) {
      c.error(502, '代理测试失败：' + (err && err.message ? err.message : err));
    }
  });

  /** 热更新下载相关配置（写回 config.json，立即生效）。 */
  app.post('/api/download/config', async function (c) {
    const body = c.body && typeof c.body === 'object' ? c.body : {};
    const patch = {};
    const errors = [];
    function numField(key, min, max) {
      if (body[key] === undefined || body[key] === '') return;
      const v = Number(body[key]);
      if (!Number.isFinite(v) || v < min || v > max) { errors.push(key + ' 需要在 ' + min + '~' + max + ' 之间'); return; }
      patch[key] = Math.round(v);
    }
    numField('chapterConcurrency', 1, 16);
    numField('imgConcurrency', 1, 64);
    numField('chapterIntervalMs', 0, 600000);
    numField('imgIntervalMs', 0, 600000);
    numField('retryTimes', 0, 10);
    numField('timeoutMs', 3000, 300000);
    numField('maxConcurrentTasks', 1, 4);
    numField('globalSpeedLimitKb', 0, 1024 * 100);
    if (body.downloadFormat !== undefined) {
      const fmt = String(body.downloadFormat);
      if (['Jpeg', 'Webp', 'Png', 'Original'].indexOf(fmt) < 0) errors.push('downloadFormat 只能是 Jpeg/Webp/Png/Original');
      else patch.downloadFormat = fmt;
    }
    if (body.dirFmt !== undefined) {
      const fmt = String(body.dirFmt);
      if (!fmt || fmt.length > 200 || fmt.indexOf('..') >= 0) errors.push('dirFmt 不合法');
      else patch.dirFmt = fmt;
    }
    if (body.shouldDownloadCover !== undefined) patch.shouldDownloadCover = Boolean(body.shouldDownloadCover);
    if (body.proxyMode !== undefined) {
      const m = String(body.proxyMode);
      if (['none', 'system', 'manual'].indexOf(m) < 0) errors.push('proxyMode 只能是 none/system/manual');
      else patch.proxyMode = m;
    }
    if (body.proxyHost !== undefined) patch.proxyHost = String(body.proxyHost).trim().slice(0, 120);
    if (body.proxyPort !== undefined) {
      const p = Number(body.proxyPort);
      if (!Number.isFinite(p) || (p < 0 || p > 65535)) errors.push('proxyPort 不合法');
      else patch.proxyPort = Math.round(p);
    }
    if (body.exportDir !== undefined) patch.exportDir = String(body.exportDir).trim().slice(0, 400);
    if (errors.length) { c.error(400, '配置未通过校验：' + errors.join('；')); return; }
    if (!Object.keys(patch).length) { c.error(400, '没有需要更新的配置项'); return; }
    try {
      await ctx.saveConfig({ picacomic: patch });
      hub.send('config', { changed: Object.keys(patch), at: new Date().toISOString() });
      c.json({ ok: true, changed: patch, message: '配置已保存并即时生效' });
    } catch (err) {
      c.error(500, '保存配置失败：' + (err && err.message ? err.message : err));
    }
  });
}
