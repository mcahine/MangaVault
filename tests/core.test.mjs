
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

export const name = '核心工具与存储';

export default async function (t) {
  const util = await import('../src/core/util.mjs');
  const { JsonStore } = await import('../src/core/store.mjs');

  /* safeJoin：目录穿越必须被拒 */
  const root = 'C:\\fake\\root';
  t.ok(util.safeJoin(root, 'a/b.jpg').endsWith(path.join('a', 'b.jpg')), 'safeJoin 正常拼接');
  await t.throwsAsync(async function () { util.safeJoin(root, '../../../etc/passwd'); }, /越界/, '上跳越界被拒');
  await t.throwsAsync(async function () { util.safeJoin(root, 'a/../../x'); }, /越界/, '相对越界被拒');
  t.ok(util.safeJoin(root, '/abs/path.jpg').startsWith(path.resolve(root)), '绝对路径被拉回根内');

  /* 文件名清洗 */
  t.eq(util.sanitizeName('a<b>:c|d?.jpg'), 'a_b__c_d_.jpg', '非法字符替换');
  t.eq(util.sanitizeName('   '), 'untitled', '空名字兜底');
  t.eq(util.sanitizeName('第1話　妹'), '第1話　妹', '中日文全角保留');

  /* 自然排序：1,2,10 而不是 1,10,2 */
  const arr = ['10 第10話', '2 第2話', '1 第1話'].sort(util.naturalCompare);
  t.deepEq(arr, ['1 第1話', '2 第2話', '10 第10話'], '章节自然排序');

  /* 并发池 */
  let live = 0;
  let peak = 0;
  const out = await util.pool([1, 2, 3, 4, 5, 6, 7, 8], 3, async function (n) {
    live++; peak = Math.max(peak, live);
    await util.sleep(12);
    live--;
    return n * 2;
  });
  t.deepEq(out, [2, 4, 6, 8, 10, 12, 14, 16], '并发池结果顺序稳定');
  t.ok(peak <= 3, '并发上限被遵守（peak=' + peak + '）');

  /* 限速器 */
  const limit = util.createRateLimiter(20);
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) await limit();
  t.ok(Date.now() - t0 >= 40, '限速器生效（>=40ms）');

  /* 字节格式化 */
  t.eq(util.formatBytes(0), '0 B', 'formatBytes 0');
  t.eq(util.formatBytes(1536), '1.50 KB', 'formatBytes 1.5KB');
  t.eq(util.formatBytes(26 * 1024 * 1024 * 1024), '26.0 GB', 'formatBytes 26GB');

  /* ---------- safeTmpDir：临时目录必须是绝对路径（真实踩坑加固） ---------- */

  /* 1) 正常环境：返回绝对路径，且目录真的建出来了 */
  const safe = util.safeTmpDir('mv-core-safe');
  t.ok(path.isAbsolute(safe), 'safeTmpDir 返回绝对路径（' + safe + '）');
  t.ok(await exists(safe), 'safeTmpDir 真的创建了目录');
  await fsp.rm(safe, { recursive: true, force: true });

  /*
   * 2) 模拟异常环境：全部候选都不是绝对路径。
   *    这正是 DSH run_code 内联执行时的真实情形 ——
   *    process.env 为空 => os.tmpdir() 返回相对路径 'undefined\\temp'。
   *    函数必须**抛错**，绝不能返回相对路径（那就等于把脏目录写进 cwd）。
   */
  let threw = false;
  let returnedRel = null;
  try {
    const bad = util.safeTmpDir('mv-core-bad', ['undefined\\temp', 'temp', '', null, undefined]);
    if (!path.isAbsolute(bad)) returnedRel = bad;
  } catch (e) {
    threw = true;
    t.ok(/绝对临时目录/.test(String(e && e.message)), 'safeTmpDir 抛错时给出中文原因：' + String(e && e.message).slice(0, 60));
  }
  t.ok(threw, '候选全是相对路径时 safeTmpDir 抛错（而不是静默返回）');
  t.eq(returnedRel, null, 'safeTmpDir 绝不返回相对路径');

  /* 3) 真实环境的 os.tmpdir() 若本身是相对路径，函数也不能被它带偏 */
  const realTmp = os.tmpdir();
  if (!path.isAbsolute(realTmp)) {
    const rescued = util.safeTmpDir('mv-core-rescue', [realTmp, 'C:\\Windows\\Temp']);
    t.ok(path.isAbsolute(rescued), '真实 os.tmpdir() 是相对路径（' + realTmp + '）时，安全回退到绝对候选');
    await fsp.rm(rescued, { recursive: true, force: true });
  } else {
    t.ok(true, '本环境 os.tmpdir() 正常返回绝对路径：' + realTmp);
  }

  /* 4) 候选里的前缀非法字符被清洗，不产生越界目录 */
  const dirty = util.safeTmpDir('糟糕 前缀/带\\斜杠');
  t.ok(path.isAbsolute(dirty), 'safeTmpDir 清洗非法前缀后仍是绝对路径');
  t.ok(path.basename(dirty).indexOf('/') < 0 && path.basename(dirty).indexOf('\\') < 0, '目录名里不含路径分隔符');
  await fsp.rm(dirty, { recursive: true, force: true });

  /* JsonStore：标记脏才落盘 + 原子写 */
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-core-'));
  const store = new JsonStore(path.join(dir, 'x.json'), { a: 1 });
  await store.flush();
  t.ok(!(await exists(path.join(dir, 'x.json'))), '未标脏时不写盘');
  store.data.a = 2;
  store.markDirty();
  await store.flush();
  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'x.json'), 'utf8'));
  t.eq(raw.a, 2, '标脏后落盘');
  const leftover = (await fsp.readdir(dir)).filter(function (f) { return f.includes('.tmp-'); });
  t.eq(leftover.length, 0, '原子写不残留临时文件');
  await fsp.rm(dir, { recursive: true, force: true });
}

async function exists(p) { try { await fsp.stat(p); return true; } catch (e) { return false; } }
