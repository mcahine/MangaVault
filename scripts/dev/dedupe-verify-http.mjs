// 查重模块 HTTP 验收脚本（只读 + 无害写入；绝不触发真实删除）
// 用法: node scripts/dev/dedupe-verify-http.mjs http://127.0.0.1:8775
const base = (process.argv[2] || 'http://127.0.0.1:8776').replace(/\/$/, '');
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('FAIL  ' + label + (extra ? '  ->  ' + JSON.stringify(extra) : '')); }
}
async function req(method, p, body) {
  const init = { method: method, headers: {} };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return { status: res.status, data: data, text: text, type: res.headers.get('content-type') };
}

const st = await req('GET', '/api/dedupe/state');
ok(st.status === 200 && st.data.ok === true, 'GET /api/dedupe/state 200 + ok:true', st.data);
ok(st.data.configured === true, 'state.configured = true（读到了真实配置）');
ok(Boolean(st.data.scanRoot) && Boolean(st.data.libRoot), 'state 返回 scanRoot / libRoot');
ok(st.data.python && st.data.python.pillow === true, 'state.python.pillow = true（像素能力可用）');
ok(Array.isArray(st.data.stages) && st.data.stages.length === 4, 'state.stages 四段');

const list = await req('GET', '/api/dedupe/units?page=1&size=3');
ok(list.status === 200 && list.data.ok === true, 'GET /api/dedupe/units 200', list.data);
ok(list.data.units.length === 3 && list.data.size === 3, '分页生效（size=3 返回 3 条）');
ok(list.data.total > 0, '单元总数 > 0', list.data.total);
const u0 = list.data.units[0];
ok(Boolean(u0.id && u0.judge && u0.badge), '单元含 id/judge/badge');
ok(typeof u0.dupCount === 'number' && typeof u0.dupBytes === 'number', '单元含张数与体积');
ok(u0.decision && u0.decision.verdict === 'pending', '未决策单元默认 pending');
console.log('      顶部统计:', JSON.stringify(list.data.stats.byVerdict), '可清理', list.data.stats.reclaimableBytes);

const fv = await req('GET', '/api/dedupe/units?verdict=' + encodeURIComponent(u0.judge) + '&page=1&size=5');
ok(fv.status === 200 && fv.data.units.every(function (u) { return u.judge === u0.judge; }), 'verdict 筛选生效');
const bad = await req('GET', '/api/dedupe/units?verdict=乱写');
ok(bad.status === 400 && bad.data.ok === false, '未知判定类型 -> 400 + ok:false', bad.data);
const q = await req('GET', '/api/dedupe/units?q=' + encodeURIComponent(u0.name.slice(0, 4)) + '&size=5');
ok(q.status === 200 && q.data.total > 0, 'q 关键字搜索有结果');

const detail = await req('GET', '/api/dedupe/unit/' + encodeURIComponent(u0.id));
ok(detail.status === 200 && detail.data.ok === true, 'GET /api/dedupe/unit/:id 200', detail.data);
ok(Array.isArray(detail.data.pairs) && detail.data.pairs.length === detail.data.dupFiles.length, 'pairs 覆盖全部本单元图片');
const notFound = await req('GET', '/api/dedupe/unit/' + encodeURIComponent('不存在的单元xx'));
ok(notFound.status === 404 && notFound.data.ok === false, '未知单元 -> 404 + ok:false');

const sample = detail.data.pairs.find(function (p) { return p.dup; }) || { dup: detail.data.dupFiles[0] };
const thumb = await req('GET', '/api/dedupe/thumb?unit=' + encodeURIComponent(u0.id) + '&side=dup&name=' + encodeURIComponent(sample.dup));
ok(thumb.status === 200 && String(thumb.type || '').indexOf('image/') === 0, 'GET /api/dedupe/thumb 返回图片', thumb.type);
const full = await req('GET', '/api/dedupe/thumb?unit=' + encodeURIComponent(u0.id) + '&side=dup&name=' + encodeURIComponent(sample.dup) + '&full=1');
ok(full.status === 200, 'thumb?full=1 返回原图');
const trav = await req('GET', '/api/dedupe/thumb?unit=' + encodeURIComponent(u0.id) + '&side=dup&name=..%2F..%2Fconfig.json');
ok(trav.status === 400 || trav.status === 404, '越界文件名被拒绝（' + trav.status + '）', trav.data);
const trav2 = await req('GET', '/api/dedupe/thumb?unit=' + encodeURIComponent(u0.id) + '&side=dup&name=sub%2F001.jpg');
ok(trav2.status === 400 || trav2.status === 404, '带分隔符的文件名被拒绝（' + trav2.status + '）');

const dec = await req('POST', '/api/dedupe/decision', { unitId: u0.id, verdict: 'keep', note: '验收脚本写入' });
ok(dec.status === 200 && dec.data.ok === true && dec.data.decision.verdict === 'keep', 'POST /api/dedupe/decision 写回成功', dec.data);
const after = await req('GET', '/api/dedupe/unit/' + encodeURIComponent(u0.id));
ok(after.data.unit.decision.verdict === 'keep', '决策已持久化（重新读取仍为 keep）');
const decBad = await req('POST', '/api/dedupe/decision', { unitId: u0.id, verdict: 'hack' });
ok(decBad.status === 400 && decBad.data.ok === false, '非法 verdict -> 400');
const decUnknown = await req('POST', '/api/dedupe/decision', { unitId: '不存在xx', verdict: 'keep' });
ok(decUnknown.status === 400 && decUnknown.data.ok === false, '未知 unitId -> 400');

const delNoConfirm = await req('POST', '/api/dedupe/delete', { unitIds: [u0.id], mode: 'recycle', confirm: 'yes' });
ok(delNoConfirm.status === 400 && /确认口令/.test(delNoConfirm.data.error || ''), 'confirm 不是 DELETE -> 400 拒绝', delNoConfirm.data);
const delBadId = await req('POST', '/api/dedupe/delete', { unitIds: ['不存在的单元xx'], mode: 'recycle', confirm: 'DELETE' });
ok(delBadId.status === 400 && /未找到单元/.test(delBadId.data.error || ''), '越界/未知 unitId -> 400 拒绝', delBadId.data);
const delBadMode = await req('POST', '/api/dedupe/delete', { unitIds: [u0.id], mode: 'purge', confirm: 'DELETE' });
ok(delBadMode.status === 400 && /未知删除方式/.test(delBadMode.data.error || ''), '未知 mode -> 400 拒绝');
const delEmpty = await req('POST', '/api/dedupe/delete', { unitIds: [], confirm: 'DELETE' });
ok(delEmpty.status === 400, '空 unitIds -> 400 拒绝');
ok(true, '（真实删除未执行：避免动用户数据）');

const stats = await req('GET', '/api/dedupe/stats');
ok(stats.status === 200 && stats.data.ok === true && stats.data.stats.units > 0, 'GET /api/dedupe/stats 200', stats.data.stats);
ok(stats.data.stats.decisions.keep >= 1, '统计反映刚才的 keep 决策');

const q2 = await req('GET', '/api/dedupe/deleted');
ok(q2.status === 200 && q2.data.ok === true && Array.isArray(q2.data.items), 'GET /api/dedupe/deleted 200');
const restore = await req('POST', '/api/dedupe/restore', { unitIds: ['不存在的单元xx'] });
ok(restore.status === 200 && restore.data.count === 0, 'restore 对未知单元返回 0（无副作用）');
const covers = await req('POST', '/api/dedupe/covers');
ok(covers.status === 200 && covers.data.ok === true, 'POST /api/dedupe/covers 生成联络表', covers.data);
console.log('      联络表:', covers.data && covers.data.path, 'count=', covers.data && covers.data.count);

console.log('');
console.log('HTTP 验收: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
