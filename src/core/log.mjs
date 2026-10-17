
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const COLORS = { debug: '\u001b[90m', info: '\u001b[36m', warn: '\u001b[33m', error: '\u001b[31m' };
const RESET = '\u001b[0m';

let logFile = null;
let consoleBroken = false;   // 控制台管道已断（父进程退出/重定向被关）时置位，避免每行都抛异常
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export function setLogFile(file) {
  logFile = file || null;
  if (!logFile) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // 简单轮转：单个日志超过 8MB 就滚动到 .1，避免长时间运行堆出上百 MB
  try {
    const st = fs.statSync(logFile);
    if (st.size > MAX_LOG_BYTES) fs.renameSync(logFile, logFile + '.1');
  } catch (e) { /* 首次运行没有文件 */ }
}

export function createLogger(scope, level) {
  const min = LEVELS[level] || LEVELS.info;

  function write(levelName, args) {
    if (LEVELS[levelName] < min) return;
    const msg = args
      .map(function (a) {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') {
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }
        return String(a);
      })
      .join(' ');
    const stamp = new Date().toISOString().slice(11, 23);
    const line = stamp + ' ' + levelName.toUpperCase().padEnd(5) + ' [' + scope + '] ' + msg;
    const colored = (COLORS[levelName] || '') + line + RESET;
    if (!consoleBroken) {
      try {
        if (levelName === 'error' || levelName === 'warn') process.stderr.write(colored + '\n');
        else process.stdout.write(colored + '\n');
      } catch (e) {
        // 典型场景：以管道方式启动后被父进程放弃，写入抛 EPIPE。
        // 这里必须吞掉并永久静音控制台，否则异常→打日志→再异常会刷爆日志文件（曾出现 80MB+）。
        consoleBroken = true;
      }
    }
    if (logFile) {
      try { fs.appendFileSync(logFile, line + '\n'); } catch (e) { /* ignore */ }
    }
  }

  return {
    scope: scope,
    debug: function () { write('debug', Array.from(arguments)); },
    info: function () { write('info', Array.from(arguments)); },
    warn: function () { write('warn', Array.from(arguments)); },
    error: function () { write('error', Array.from(arguments)); },
    child: function (sub) { return createLogger(scope + ':' + sub, level); }
  };
}
