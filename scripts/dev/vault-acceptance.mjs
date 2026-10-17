/**
 * vault 破坏性操作验收（隔离样本）。
 * 用 Node 写而不是 PowerShell：原生 UTF-8，没有引号/编码地狱。
 * 绝不触碰真实漫画：全程把库根指向 %TEMP% 的样本，结束时恢复。
 * 运行：node scripts/dev/vault-acceptance.mjs
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';

const BASE = process.env.MV_BASE || 'http://127.0.0.1:8775';
const SRC_CH = 'C:\\Users\\D-001\\Desktop\\黄漫\\picacg漫画\\和歌酱今天也很腹黑\\1 第1話';
const lines = [];
function say(m) { lines.push(m); console.log(m); }
function ok(cond, m) { say((cond ? '  OK   ' : '  FAIL ') + m); return cond; }

async function api(p, opts) {
  const o = opts || {};
  const init = { method: o.method || (o.body ? 'POST' : 'GET'), headers: {} };
  if (o.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
  const res = await fetch(BASE + p, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data: data };
}

let pass = 0, fail = 0;
function check(cond, m) { if (ok(cond, m)) pass++; else fail++; }

const tmp = path.join(os.tmpdir(), 'mv-vault-acc-' + process.pid);
const rootA = path.join(tmp, 'libA');
const rootB = path.join(tmp, 'libB');
let origRoots = null;

try {
  await fsp.rm(tmp, { recursive: true, force: true });
  const c1 = path.join(rootA, '测试漫画 一');
  await fsp.mkdir(path.join(c1, '1 第1話'), { recursive: true });
  await fsp.mkdir(path.join(c1, '2 第2話'), { recursive: true });
  await fsp.writeFile(path.join(c1, '元数据.json'), JSON.stringify({ id: 'vtest0000000000000000001', title: '测试漫画 一', author: '某作者', tags: ['純愛'], chapterInfos: [] }), 'utf8');
  await fsp.copyFile(path.join(SRC_CH, '001.jpg'), path.join(c1, '1 第1話', '001.jpg'));
  await fsp.copyFile(path.join(SRC_CH, '002.jpg'), path.join(c1, '1 第1話', '002.jpg'));
  await fsp.copyFile(path.join(SRC_CH, '003.jpg'), path.join(c1, '2 第2話', '001.jpg'));
  await fsp.writeFile(path.join(c1, '2 第2話', '002.jpg'), Buffer.alloc(0));   // 故意 0 字节
  const c2 = path.join(rootB, ' 脏 名字 测试 ');                                // 首尾空格 + 双空格
  await fsp.mkdir(c2, { recursive: true });
  await fsp.copyFile(path.join(SRC_CH, '004.jpg'), path.join(c2, '001.jpg'));
  say('[1] 样本就绪：A=1 部（含 0 字节坏图 + 缺章节元数据），B=1 部（目录名不规范）');

  // 切库根到样本
  const cfg = await api('/api/config');
  origRoots = cfg.data.config.libraryRoots;
  const setRoots = await api('/api/config', { body: { libraryRoots: [
    { id: 'ta', name: '样本A', path: rootA, enabled: true },
    { id: 'tb', name: '样本B', path: rootB, enabled: true }
  ] } });
  check(setRoots.ok, '[2] 切换到样本库根');

  await api('/api/library/scan', { body: {} });
  for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 500)); const s = await api('/api/library/state'); if (!s.data.scanning) break; }

  const cv = await api('/api/vault/comics?size=50');
  const comics = cv.data.items || [];
  check(comics.length === 2, '[3] vault 目录视图随库根立即刷新（期望 2 部，实际 ' + comics.length + '）');
  const id1 = (comics.find(c => c.dir.includes('测试漫画')) || {}).id;
  const id2 = (comics.find(c => c.dir.includes('脏')) || {}).id;
  say('    id1=' + id1 + '  id2=' + id2);

  const tagName = '验收标签_' + process.pid;
  const nt = await api('/api/vault/tags', { body: { name: tagName, color: 'red' } });
  check(nt.ok && nt.data.tag, '[4] 新建标签 -> ' + nt.data.message);

  const as = await api('/api/vault/tags/assign', { body: { comicIds: [id1], add: [tagName, '另一个标签'], remove: [] } });
  check(as.ok, '[5] 批量打标 -> affected=' + as.data.affected + ' 新建=' + (as.data.created || []).length);

  const rc = await api('/api/vault/tag/' + encodeURIComponent(tagName) + '/comics');
  check(rc.ok && rc.data.total === 1, '[6] 标签反查 -> ' + rc.data.total + ' 部，首条 ' + ((rc.data.items || [])[0] || {}).title);

  const me = await api('/api/vault/comic/' + encodeURIComponent(id1) + '/meta', { body: { author: '改过的作者', tags: ['純愛', '新增标签'] } });
  check(me.ok, '[7] 元数据编辑 -> ' + me.data.message);
  check(await fsp.stat(path.join(c1, '元数据.json.bak')).then(() => true).catch(() => false), '[7b] 原元数据已备份为 元数据.json.bak');

  const vf = await api('/api/vault/verify?limit=50');
  const V = vf.data.result;
  check(V && V.scanned >= 1, '[8] 文件校验 -> 检查 ' + V.scanned + ' 部，问题 ' + V.problemComics + ' 部（严重 ' + V.high + ' / 中等 ' + V.mid + '）');
  check(V.high >= 1, '[8b] 检出 0 字节坏图：' + JSON.stringify(V.byCode));
  check(V.byCode['no-chapter-meta'] >= 1, '[8c] 检出缺章节元数据');

  const fx = await api('/api/vault/verify/fix', { body: { confirm: true } });
  check(fx.ok, '[9] 一键修复 -> ' + fx.data.message);
  check(await fsp.stat(path.join(c1, '1 第1話', '章节元数据.json')).then(() => true).catch(() => false), '[9b] 章节元数据已补齐');

  const plan = await api('/api/vault/batch', { body: { action: 'rename-dirs', comicIds: [id2], options: { confirm: false } } });
  const P = plan.data.plan;
  check(plan.ok && P.count >= 1, '[10] 重命名预演 -> ' + P.count + ' 项，目标 "' + (P.plan[0] || {}).to + '"');
  check(await fsp.stat(c2).then(() => true).catch(() => false), '[10b] 预演不动磁盘（原目录仍在）');

  // 真正执行重命名
  const ren = await api('/api/vault/batch', { body: { action: 'rename-dirs', comicIds: [id2], options: { confirm: true } } });
  check(ren.ok && ren.data.result.renamed >= 1, '[11] 执行重命名 -> 成功 ' + ren.data.result.renamed + ' 项');
  const c2new = path.join(rootB, '脏 名字 测试');
  check(await fsp.stat(c2new).then(() => true).catch(() => false), '[11b] 目录已规范化（首尾/重复空格已清理）');

  // 回收站往返
  const tr = await api('/api/vault/trash', { body: { comicIds: [id1], note: '验收' } });
  check(tr.ok && tr.data.result.moved === 1, '[12] 移入回收站 -> ' + tr.data.message);
  check(!(await fsp.stat(c1).then(() => true).catch(() => false)), '[12b] 原目录已移走');
  const tl = await api('/api/vault/trash');
  check(tl.data.trash.count >= 1, '[13] 回收站 -> ' + tl.data.trash.count + ' 条 / ' + (tl.data.trash.bytes / 1024).toFixed(1) + ' KB');
  const item = tl.data.trash.items.find(x => x.dir.includes('测试漫画'));
  const rs = await api('/api/vault/trash/restore', { body: { ids: [item.trashPath] } });
  check(rs.ok && rs.data.result.restored === 1, '[14] 还原 -> ' + rs.data.message);
  check(await fsp.stat(c1).then(() => true).catch(() => false), '[14b] 已还原到原位');

  // 备份
  const bk = await api('/api/vault/backup', { body: { note: '验收' } });
  check(bk.ok, '[15] 备份 -> ' + bk.data.message);
  const bl = await api('/api/vault/backup');
  check(bl.data.count >= 1, '[15b] 备份列表 ' + bl.data.count + ' 份');

  // 统计
  const st = (await api('/api/vault/stats')).data.stats;
  check(st.comics === 2, '[16] 统计 -> ' + st.comics + ' 部 / ' + st.bytesText + ' / 无元数据 ' + st.noMeta);

  // 拒绝路径
  const r1 = await api('/api/vault/trash/purge', { body: { ids: ['x'], confirm: 'NO' } });
  check(r1.status === 400, '[17] 拒绝 confirm != DELETE -> HTTP ' + r1.status + '（' + (r1.data.error || '') + '）');
  const r2 = await api('/api/vault/batch', { body: { action: 'rm-rf', comicIds: [id1] } });
  check(r2.status === 400, '[18] 拒绝未知 action -> HTTP ' + r2.status);
  const r3 = await api('/api/vault/batch', { body: { action: 'rename-dirs', comicIds: [], options: { confirm: true } } });
  check(r3.status === 400, '[19] 拒绝空 comicIds 的批量重命名（防误操作全库）-> HTTP ' + r3.status);
  const r4 = await api('/api/vault/comic/' + encodeURIComponent(id1) + '/meta', { body: { title: 'x' } });
  check(r4.ok, '[20] 元数据写入仍正常（控制组）');

  // 清理测试标签
  await api('/api/vault/tags?id=' + encodeURIComponent(nt.data.tag.id), { method: 'DELETE' });
  say('[21] 测试标签已清理');

} catch (err) {
  fail++;
  say('  EXCEPTION ' + (err && err.stack || err));
} finally {
  if (origRoots) {
    await api('/api/config', { body: { libraryRoots: origRoots } });
    await api('/api/library/scan', { body: {} });
    for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 500)); const s = await api('/api/library/state'); if (!s.data.scanning) break; }
    const back = await api('/api/vault/state');
    say('[22] 库根已复原 -> 目录 ' + back.data.catalog.comics + ' 部');
  }
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

say('');
say('验收结果：通过 ' + pass + ' / 失败 ' + fail);
/* 日志必须落到「数据目录」，绝不能落到 process.cwd()/data ——
   验收脚本一律由 verify-all 以 cwd=仓库根 拉起，写 cwd 就是在仓库里凭空造出 data/，
   而本项目的铁律是「代码与数据分离、仓库内不得有运行时数据」。
   历史上的仓库 data/ 里那 81.7 MB 就是这么攒出来的。 */
try {
  const { dataPath } = await import('../../src/core/config.mjs');
  const logFile = dataPath('vault-acceptance.log');
  await fsp.mkdir(path.dirname(logFile), { recursive: true });
  await fsp.writeFile(logFile, lines.join('\n') + '\n', 'utf8');
} catch (e) { /* 忽略 */ }
process.exit(fail ? 1 : 0);
