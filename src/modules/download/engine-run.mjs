import fsp from 'node:fs/promises';
import path from 'node:path';
import { listChapterImages, isChapterComplete, MSG_COMIC_META } from './paths.mjs';
import { read as readLedger, recordPage as recordLedgerPage, remove as removeLedger } from './ledger.mjs';
import {
  num, runPool, sleep, coverUrlOfComic, chapterImageUrls, createSpeedometer, clone,
  rmWithRetry, atomicWriteJson, chapterPageRecord, pageRecordUsable, declaredLengthOf,
  swapDir, buildComicMetadata, buildChapterMetadata, hasImage, listSuspiciousImages, extForImage
} from './engine-util.mjs';

/**
 * 下载执行层：一个任务从开始到结束的全过程（漫画详情 → 逐章下载 → 元数据落盘）。
 *
 * 从 engine.mjs 拆出。这两个函数只依赖传入的 task 对象与共享上下文 s（日志、限速器、
 * 台账助手等），不读写引擎的队列状态（activeCount / disposed / pumpScheduled 全在 engine.mjs），
 * 所以可以整段搬出而不改变任何一行逻辑。
 *
 * runTask(task, s) / downloadChapter(task, section, ctx2, s)
 */
  async function runTask(task, s) {
    const { log, running, pica, paths, sourceOf, persist, patch, emitSafe, view, addLog, configuredExt, throttleGlobal, taskImgLimiter, chapterLimiter } = s;
    if (task.state === 'canceled') return;
    const pc = pica();
    const pp = paths();
    const src = sourceOf(task);
    const controller = new AbortController();
    running.set(task.id, { controller: controller });
    const limiter = chapterLimiter();
    const speedo = createSpeedometer();
    const startedAt = Date.now();
    let lastEmit = 0;
    let doneCount = 0;
    let errorCount = 0;
    let bytes = 0;

    function progress(force, event) {
      task.speed = speedo.speed();
      task.bytes = bytes;
      const now = Date.now();
      if (force || now - lastEmit > 320) {
        lastEmit = now;
        persist(task);
        emitSafe(event || 'progress', { taskId: task.id, ...view(task) });
      }
    }

    patch(task, { state: 'running', error: null, speed: 0 }, 'state', { taskId: task.id, state: 'running' });
    emitSafe('progress', { taskId: task.id, ...view(task) });
    log.info('开始下载《' + task.title + '》共 ' + task.sections.length + ' 章');

    try {
      let comic = task.comic ? clone(task.comic) : null;
      // 统一 Comic 有 cover，来源原始对象有 thumb：两者都没有才需要重新拉详情
      if (!comic || (!comic.cover && !comic.thumb)) {
        try {
          comic = await src.comic(task.comicId, { signal: controller.signal });
          task.comic = comic;
        } catch (err) {
          if (controller.signal.aborted) throw err;
          // 详情拿不到不致命：老任务里可能已经带了标题信息
          addLog(task, 'warn', '获取漫画详情失败：' + err.message);
          log.warn('获取《' + task.title + '》详情失败：' + err.message);
        }
      }

      // 1) 先落盘元数据（结构与库一致），让 library 模块能立刻扫到
      const metaDir = pp.comicDir(task.title);
      const tempComicDir = pp.comicTempDir(task.title);

      /** 写元数据：pagesCount 用实际下载到的图片数（拿不准时按已知总数兜底）。 */
      async function writeComicMeta() {
        const filled = task.sections.map(function (s) {
          return { chapterId: s.chapterId, chapterTitle: s.title, order: s.order, total: s.total || 0 };
        });
        const comicMeta = buildComicMetadata(comic || { id: task.comicId, title: task.title, author: task.author }, filled, { format: 'reference' });
        const file = path.join(metaDir, MSG_COMIC_META);
        try {
          await fsp.mkdir(metaDir, { recursive: true });
          await atomicWriteJson(file, comicMeta);
        } catch (err) {
          // 正式目录写不进去时退回临时目录，任务照常继续；但原因必须留在任务日志里，不能静默吞掉
          addLog(task, 'warn', '正式目录写入元数据失败，已退回临时目录：' + (err && err.message ? err.message : err));
          // 临时目录只做一次兜底落盘，随即清理：它是漫画目录的「同级」目录（<漫画目录>.tmp-<pid>），
          // library 永远扫不到它，留着只会变成永久残渣 —— 实测把 <漫画目录>/元数据.json 造成目录、
          // 强制原子写的 rename 失败后，这个 .tmp- 目录会一直留在下载根下，没有任何代码路径会删它。
          // 兜底失败的原因已经写进任务日志，不需要靠目录留痕，所以写完就删。
          try {
            await fsp.mkdir(tempComicDir, { recursive: true });
            await atomicWriteJson(path.join(tempComicDir, MSG_COMIC_META), comicMeta);
          } finally {
            try { await rmWithRetry(tempComicDir, 5); } catch (e) { /* 清理失败不掩盖原错误 */ }
          }
        }
        return comicMeta;
      }
      await writeComicMeta();

      // 2) 封面（缺失才下，失败仅记日志）
      if (pc.shouldDownloadCover !== false) {
        const coverUrl = coverUrlOfComic(src, comic);
        if (coverUrl) {
          const coverFile = path.join(metaDir, 'cover.jpg');
          let need = true;
          try {
            const st = await fsp.stat(coverFile);
            need = !(st.isFile() && st.size > 0);
          } catch (e) { need = true; }
          if (need) {
            try {
              const dl = await src.download(coverUrl, { signal: controller.signal });
              if (!dl || !dl.buffer || !dl.buffer.length) throw new Error('封面内容为空');
              await fsp.mkdir(metaDir, { recursive: true });
              const tmp = coverFile + '.tmp-' + process.pid;
              try {
                await fsp.writeFile(tmp, dl.buffer);
                await fsp.rename(tmp, coverFile);
              } catch (err2) {
                // 半截封面必须清掉：rename 失败时它会永久留在漫画目录里（实测把 cover.jpg 造成目录
                // 强制 EPERM 后必现 1 个 .tmp- 残渣），而「漫画目录里不许有 .tmp- 残留」是测试和运维都在看的硬约束
                try { await rmWithRetry(tmp, 5); } catch (e2) { /* 清理失败不掩盖原错误 */ }
                throw err2;
              }
              bytes += dl.buffer.length;
              addLog(task, 'info', '封面已下载');
            } catch (err) {
              addLog(task, 'warn', '封面下载失败（不影响章节）：' + err.message);
              log.warn('《' + task.title + '》封面下载失败：' + err.message);
            }
          }
        }
      }

      // 3) 逐章节（章级并发 + 章间隔）
      const pending = task.sections.filter(function (s) { return s.state !== 'done'; });
      await runPool(pending, Math.max(1, num(pc.chapterConcurrency, 2)), async function (section) {
        if (task.state === 'canceled' || task.state === 'paused' || controller.signal.aborted) return;
        await limiter();
        if (task.state === 'canceled' || task.state === 'paused' || controller.signal.aborted) return;
        const result = await downloadChapter(task, section, { controller: controller, speedo: speedo, onBytes: function (n) { bytes += n; speedo.add(n); progress(false); } }, s);
        if (result.ok) doneCount++;
        else if (result.canceled) return;
        else errorCount++;
        addLog(task, result.ok ? 'info' : 'error', '章节 ' + section.order + ' ' + (section.title || '') + (result.ok ? ' 完成' : ' 失败：' + section.error));
        try { await writeComicMeta(); } catch (e) { /* 元数据刷新失败不打断下载 */ }
        progress(true);
      });

      if (task.state === 'canceled' || controller.signal.aborted) {
        addLog(task, 'warn', '任务已取消');
        persist(task);
        emitSafe('state', { taskId: task.id, state: task.state });
        return;
      }

      // 4) 收尾
      // 先把最终元数据写完，再改任务状态：state 一旦对外是 done/error，磁盘就必须已经是最终状态。
      // 反过来（先 patch 状态再写元数据）时，轮询到 done 的调用方会读到还在写入中的 .tmp- 临时文件。
      try { await writeComicMeta(); } catch (e) {
        // 不改变任务结果（图与封面都已落盘），但必须留下痕迹：以前这里静默吞掉，
        // 于是「元数据没定稿却报 done」在事后完全无据可查，只能靠猜。
        addLog(task, 'warn', '最终元数据刷新失败（任务结果不受影响）：' + (e && e.message ? e.message : e));
      }
      const left = task.sections.filter(function (s) { return s.state !== 'done' && s.state !== 'skipped'; });
      if (left.length) {
        const detail = left.filter(function (s) { return s.error; }).slice(0, 2).map(function (s) { return '第 ' + s.order + ' 话：' + s.error; }).join('；');
        const message = '有 ' + left.length + ' 个章节未完成（' + left.slice(0, 4).map(function (s) { return s.order; }).join('、') + (left.length > 4 ? ' 等' : '') + '）'
          + (detail ? '，具体：' + detail : '')
          + '。已下载的图片都保留在磁盘，点「继续」只补缺的部分';
        patch(task, { state: 'error', error: message }, 'error', { taskId: task.id, message: message });
      } else {
        // 任务已完成：逐页台账不再有续传价值，删掉以免 data/ 无限膨胀（图片本身留在磁盘上）。
        // 必须**先删台账、再置 done**：一看到 done 的观察者（前端、测试、外部脚本）会立刻
        // 断言「台账已清」，反过来写就会出现「状态已是 done 但台账还在」的窗口，机器忙时必现。
        try { await removeLedger(task.id); } catch (e) { /* 台账清理失败不影响任务结果 */ }
        patch(task, { state: 'done', error: null }, 'state', { taskId: task.id, state: 'done' });
        addLog(task, 'info', '全部章节下载完成，用时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒');
      }
      progress(true, task.state === 'error' ? 'error' : 'done');
      emitSafe(task.state === 'error' ? 'error' : 'done', { taskId: task.id, ...view(task) });
      log.info('《' + task.title + '》下载结束：' + task.state + '（成功 ' + doneCount + ' / 失败 ' + errorCount + '）');
    } finally {
      task.speed = 0;
      running.delete(task.id);
      persist(task);
    }
  }

  /**
 * 台账命中后把文件「补进本次的临时目录」：
 * 进程重启后临时目录名带 pid（<章节目录>.tmp-<pid>），上次留下的文件路径与本次不同，
 * 但内容已被台账证明完整 —— 复制过来即可，绝不重新发请求。返回是否可用。
 */
async function restoreLedgerPage(rec, tmpDir, index, cfgExt, p) {
  const src = String(rec.file);
  const ext = String(path.extname(src) || '').replace(/^\./, '') || cfgExt || 'jpg';
  const dest = p.imageFile(tmpDir, index, ext);
  try {
    if (path.resolve(dest) !== path.resolve(src)) {
      await fsp.mkdir(tmpDir, { recursive: true });
      await fsp.copyFile(src, dest);
    }
  } catch (err) {
    return false;
  }
  try {
    const st = await fsp.stat(dest);
    return st.isFile() && st.size === num(rec.bytes, 0) && st.size > 0;
  } catch (err) {
    return false;
  }
}

/**
 * 记一页台账。台账写入失败绝不能把已经落盘的图片判成失败，
 * 所以这里全部吞掉异常，只往任务日志里写一条中文原因。
 */
async function recordLedgerPageSafe(task, section, item, dest, bytes2) {
  try {
    await recordLedgerPage(task.id, {
      comicId: task.comicId,
      chapterOrder: section.order,
      title: section.title,
      total: section.total,
      index: item.index,
      file: dest,
      bytes: bytes2,
      url: item.url
    });
  } catch (err) {
    addLog(task, 'warn', '逐页台账写入失败（不影响下载）：' + (err && err.message ? err.message : err));
  }
}

/** 下载单个章节：先补缺图，再原子替换目录并写章节元数据。 */
  async function downloadChapter(task, section, ctx2, s) {
    const { log, pica, paths, sourceOf, persist, patch, emitSafe, view, addLog, configuredExt, throttleGlobal, taskImgLimiter, chapterLimiter } = s;
    const c = ctx2 || {};
    const controller = c.controller;
    const signal = controller ? controller.signal : undefined;
    const p = paths();
    const src = sourceOf(task);   // 章节级也要认任务记录的 sourceId
    const ch = { chapterId: section.chapterId, chapterTitle: section.title, order: section.order };
    const finalDir = p.chapterDir(task.title, ch, { comicId: task.comicId, author: task.author });
    const tmpDir = p.chapterTempDir(task.title, ch, { comicId: task.comicId, author: task.author });

    section.state = 'running';
    section.error = null;
    if (!finalDir.startsWith(p.root())) {
      section.state = 'error';
      section.error = '目标路径越界，已拒绝写入';
      return { ok: false, canceled: false };
    }

    let urls;
    try {
      urls = await chapterImageUrls(src, task.comicId, section.order, signal);
    } catch (err) {
      if (signal && signal.aborted) { section.state = 'pending'; return { ok: false, canceled: true }; }
      section.state = 'error';
      section.error = '获取图片列表失败：' + err.message;
      return { ok: false, canceled: false };
    }
    if (!urls.length) {
      section.state = 'error';
      section.error = '该章节没有可下载的图片';
      return { ok: false, canceled: false };
    }
    section.total = urls.length;

    // 已完成的章节直接跳过（断点续传/重复下载都走这里）
    if (await isChapterComplete(finalDir)) {
      section.state = 'done';
      section.done = urls.length;
      section.failed = 0;
      return { ok: true, canceled: false };
    }

    if (typeof src.download !== 'function') {
      section.state = 'error';
      section.error = '该下载源不支持图片下载（缺少 download 能力）';
      return { ok: false, canceled: false };
    }

    try { await fsp.mkdir(tmpDir, { recursive: true }); } catch (e) { /* 可能已存在 */ }
    const cfgExt = configuredExt();

    // 小于 512B 的图片基本是坏图：删掉重下（避免「永远缺图」）
    for (const dir of [tmpDir, finalDir]) {
      const bad = await listSuspiciousImages(dir, cfgExt, { minSize: 512 });
      for (const n of bad) {
        try { await fsp.rm(path.join(dir, ('000' + String(n)).slice(-3)) + '.' + cfgExt, { force: true }); } catch (e) { /* ignore */ }
        addLog(task, 'warn', '图片 ' + n + ' 体积过小（疑似坏图），已删除重下');
      }
    }

    let done = 0;
    let failed = 0;
    let ledgerHits = 0;

    // 逐页台账：章开始时读一次，之后每页都先按台账判断，避免多余的目录扫描与 HTTP 请求。
    // 读失败/文件损坏都会被 ledger 内部兜成空台账，这里再兜一层，绝不让它打断下载。
    let ledgerDoc = null;
    try { ledgerDoc = await readLedger(task.id); } catch (e) { ledgerDoc = null; }

    await runPool(urls.map(function (u, i) { return { url: u, index: i + 1 }; }), Math.max(1, num(pica().imgConcurrency, 8)), async function (item) {
      if (task.state === 'canceled' || task.state === 'paused' || (signal && signal.aborted)) return;
      // 1) 台账优先：有该页记录、文件还在、字节数一致 → 直接跳过 HTTP（真正的断点续传）
      const rec = chapterPageRecord(ledgerDoc, section.order, item.index);
      if (rec) {
        if (await pageRecordUsable(rec)) {
          const restored = await restoreLedgerPage(rec, tmpDir, item.index, cfgExt, p);
          if (restored) {
            ledgerHits++;
            task.ledgerHits = num(task.ledgerHits, 0) + 1;
            done++;
            section.done = done;
            return;
          }
        } else {
          // 记录对不上磁盘（文件被删/被截断/字节数不符）：按未命中处理，重新下载
          addLog(task, 'warn', '图片 ' + item.index + ' 的台账记录与磁盘不符，重新下载');
        }
      }
      // 2) 台账没命中时退回老办法：临时目录与正式目录里已有该页就跳过（支持「只补缺图」）
      const hitTmp = await hasImage(tmpDir, item.index, cfgExt);
      const hitFinal = await hasImage(finalDir, item.index, cfgExt);
      if (hitTmp || hitFinal) {
        done++;
        section.done = done;
        return;
      }
      await taskImgLimiter(task)();
      if (task.state === 'canceled' || task.state === 'paused' || (signal && signal.aborted)) return;
      let attempt = 0;
      const maxTries = Math.max(1, num(pica().retryTimes, 3));
      while (true) {
        try {
          const dl = await src.download(item.url, { signal: signal });
          const buf = dl && dl.buffer;
          if (!buf || !buf.length) throw new Error('图片内容为空');
          // 上游声明了 Content-Length 就必须对得上：对不上按失败重试（半截文件绝不能进正式目录）
          const declared = declaredLengthOf(dl);
          if (declared > 0 && declared !== buf.length) {
            throw new Error('图片字节数与 Content-Length 不一致（声明 ' + declared + ' 字节，实收 ' + buf.length + ' 字节）');
          }
          const ext = extForImage(buf, cfgExt);
          const dest = p.imageFile(tmpDir, item.index, ext);
          const tmp = dest + '.part-' + process.pid;
          await fsp.writeFile(tmp, buf);
          await fsp.rename(tmp, dest);
          // 落盘成功才记账：台账只描述磁盘上真实存在、字节数确定的页
          await recordLedgerPageSafe(task, section, item, dest, buf.length);
          done++;
          section.done = done;
          if (c.onBytes) c.onBytes(buf.length);
          await throttleGlobal(buf.length);
          return;
        } catch (err) {
          if (signal && signal.aborted) return;
          if (task.state === 'canceled' || task.state === 'paused') return;
          attempt++;
          if (attempt >= maxTries) {
            failed++;
            section.failed = failed;
            addLog(task, 'warn', '图片 ' + item.index + ' 下载失败（已记入死信，继续下一张）：' + err.message);
            return;
          }
          await sleep(Math.min(8000, 500 * Math.pow(2, attempt - 1)));
        }
      }
    });

    section.done = done;
    section.failed = failed;
    if (ledgerHits > 0) {
      addLog(task, 'info', '章节 ' + section.order + '：逐页台账命中 ' + ledgerHits + ' 页，未重复发起请求');
    }

    if (task.state === 'canceled') {
      section.state = 'pending';
      return { ok: false, canceled: true };
    }

    // 有缺图：把已下好的图片「复制」到正式目录留底（临时目录里也保留一份），下次续传直接补缺
    if (done < urls.length) {
      section.state = 'error';
      section.error = '缺 ' + (urls.length - done) + ' 张图片（' + done + '/' + urls.length + '），可稍后继续补全';
      try {
        await fsp.mkdir(finalDir, { recursive: true });
        const existing = await listChapterImages(tmpDir);
        for (const f of existing) {
          if (f.size <= 0) continue;
          const dest = path.join(finalDir, f.name);
          try {
            const st = await fsp.stat(dest);
            if (st.size > 0) continue;
          } catch (e) { /* 目标不存在 */ }
          try { await fsp.copyFile(f.abs, dest); } catch (e) { /* 单个文件失败不影响整体 */ }
        }
      } catch (e) { /* ignore */ }
      return { ok: false, canceled: false };
    }

    // 全部到齐：把正式目录里已有的图片补进临时目录，再整体原子替换
    try {
      const inFinal = await listChapterImages(finalDir);
      for (const f of inFinal) {
        if (f.size <= 0) continue;
        const dest = path.join(tmpDir, f.name);
        let skip = false;
        try { skip = (await fsp.stat(dest)).size > 0; } catch (e) { skip = false; }
        if (skip) continue;
        try { await fsp.copyFile(f.abs, dest); } catch (e) { /* 单个文件失败不影响整体 */ }
      }
    } catch (e) { /* ignore */ }

    // 全部到齐：写章节元数据 + 原子替换目录
    try {
      await atomicWriteJson(path.join(tmpDir, '章节元数据.json'), buildChapterMetadata(ch));
      await swapDir(tmpDir, finalDir);
    } catch (err) {
      section.state = 'error';
      section.error = '写盘失败：' + err.message;
      return { ok: false, canceled: false };
    }
    section.state = 'done';
    return { ok: true, canceled: false };
  }



export { runTask, downloadChapter };
