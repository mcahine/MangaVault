// 漫库 MangaVault · 桌面启动器日志
// 双写：控制台（启动器一般由 vbs 隐藏启动，看不到）+ data/desktop.log（排障用）。
// 控制台写失败（管道断开 EPIPE）后永久静音，避免刷爆日志。

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../src/core/config.mjs';

let consoleBroken = false;

/** 创建启动器日志器 */
export function logger(scope) {
  function line(level, args) {
    const text = args.map(function (a) {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
      return String(a);
    }).join(' ');
    // 必须用**本地时间**：mangavault.log 与用户的直觉都是本地时间，
    // 原来用 toISOString()（UTC）会让同一份排障记录出现两套时间锚（历史踩坑）。
    const d = new Date();
    function p2(n) { return String(n).padStart(2, '0'); }
    const stamp = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    const out = stamp + ' ' + level.toUpperCase().padEnd(5) + ' [' + scope + '] ' + text;
    if (!consoleBroken) {
      try { process.stdout.write(out + '\n'); } catch (e) { consoleBroken = true; }
    }
    try {
      const file = path.join(dataDir(), 'desktop.log');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, out + '\n');
    } catch (e) { /* 日志写不进去不影响启动 */ }
  }
  return {
    info: function () { line('info', Array.from(arguments)); },
    warn: function () { line('warn', Array.from(arguments)); },
    error: function () { line('error', Array.from(arguments)); },
    debug: function () { line('debug', Array.from(arguments)); }
  };
}
