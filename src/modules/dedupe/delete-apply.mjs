// 删除执行后回写扫描结果：把已删除的单元从 scan-latest.json / scan-fast.json 里摘掉。
// 从 index.mjs 拆出。写成工厂以保留原来的 log 依赖，判定与回写顺序逐字不变。
import { readScan, writeScan, setDecision } from './engine/store.mjs';
import { atomicWriteJson, readJson } from '../../core/util.mjs';
import { fastFileOf } from './views.mjs';

/** 收一个 log（模块 logger），返回 applyDeleteToScan(paths, entry)。 */
export function makeApplyDeleteToScan(log) {
  return function applyDeleteToScan(paths, entry) { return applyDelete(paths, entry, log); };
}
/**
 * 把「已删除」的单元从最近一次扫描结果里剔除，并把它们的扫描单元 id 登记进决策表。
 * 背景（真因）：删除只作用于磁盘，scan-latest.json 不动，于是列表、统计、可清理体积
 * 全都停留在删除前，用户点完删除看不到任何变化。这里做最小回写：
 *  - 只按 id 摘除，不重算判定（重算是 20 分钟的全量活，不该塞进一次删除请求里）；
 *  - 决策登记为 `deleted`（写入前必须让 store 白名单接受它），列表与统计据此再兜底一层过滤，
 *    这样即使 scan 文件没写成功（磁盘满 / 文件被占用），单元也不会再出现在前端；
 *  - 先写 scan-latest.json 再写决策标记：决策是「让删除可见」的兜底，不能因为写失败而丢；
 *  - 回写失败不能吞：删除本身已经成功，但回写失败必须让调用方知道（返回 removedFromScan=0）。
 * 返回真正被摘除的 id 列表。
 */
async function applyDelete(paths, entry, log) {
  // 注意包含 skipped：skipped 只表示「目录已不在磁盘上」（= 早就删掉了），
  // 它同样必须从列表和统计里摘除，否则用户看到的就是「删了还在」。
  const doneIds = (entry.results || []).filter(function (r) { return r.ok === true && r.id; })
    .map(function (r) { return r.id; });
  if (!doneIds.length) return [];
  const gone = new Set(doneIds);
  let removed = [];
  try {
    const scan = await readScan(paths);
    if (scan && Array.isArray(scan.units)) {
      const before = scan.units.length;
      scan.units = scan.units.filter(function (u) { return !gone.has(u.id); });
      removed = doneIds.filter(function (id) { return scan.units.every(function (u) { return u.id !== id; }); });
      const removedCount = before - scan.units.length;
      if (removedCount > 0) {
        if (scan.单元数 != null) scan.单元数 = Math.max(0, Number(scan.单元数) - removedCount);
        if (scan.库 && scan.库.按根 && Array.isArray(scan.库.按根)) {
          const stillByRoot = new Map();
          for (const u of scan.units) stillByRoot.set(u.libRootId || '', (stillByRoot.get(u.libRootId || '') || 0) + 1);
          for (const r of scan.库.按根) r.单元数 = stillByRoot.get(r.id) || 0;
        }
        if (scan.汇总 && typeof scan.汇总 === 'object' && scan.汇总.单元数 != null) {
          scan.汇总.单元数 = Math.max(0, Number(scan.汇总.单元数) - removedCount);
        }
        // 删除回写的 ids 是「按 id 累加」的审计字段：多次删除不能互相覆盖，
        // 否则 scan 文件里只能看到最后一次删掉的 id。
        const prevIds = Array.isArray(scan.删除回写 && scan.删除回写.ids) ? scan.删除回写.ids : [];
        scan.删除回写 = { time: entry.time, count: removedCount, ids: Array.from(new Set(prevIds.concat(removed))) };
        // 先写 scan-latest.json（列表的真实来源），写成功后才登记决策标记。
        await writeScan(paths, scan);
        log.warn('删除回写扫描结果: 摘除 ' + removedCount + ' 个单元');
      }
    }
    for (const id of doneIds) { try { await setDecision(paths, id, 'deleted', '已执行删除（' + entry.mode + '）'); } catch (e) { log.error('登记已删除标记失败: ' + id + ' — ' + (e && e.message ? e.message : e)); } }
  // 同步回写快速查重结果。
  // 真因（用户可见的毛病）：候选复核读的是 scan-fast.json，而删除只回写 scan-latest.json，
  // 于是「确认重复 → 删除成功」之后候选页里那张卡片原样留着，用户看到的就是「删了还在」。
  // 只摘除 id、不动判定，失败不抛（真正的删除已经成功，决策标记才是可见性兜底）。
  try {
    const ff = fastFileOf(paths);
    const fastDoc = await readJson(ff, null);
    if (fastDoc && Array.isArray(fastDoc.units)) {
      const before = fastDoc.units.length;
      fastDoc.units = fastDoc.units.filter(function (u) { return !gone.has(u && u.id); });
      const dropped = before - fastDoc.units.length;
      if (dropped > 0) {
        if (fastDoc.查重 && fastDoc.查重.单元数 != null) fastDoc.查重.单元数 = Math.max(0, Number(fastDoc.查重.单元数) - dropped);
        if (fastDoc.汇总 && fastDoc.汇总.单元数 != null) fastDoc.汇总.单元数 = Math.max(0, Number(fastDoc.汇总.单元数) - dropped);
        await atomicWriteJson(ff, fastDoc);
        log.warn('删除回写快速查重结果: 摘除 ' + dropped + ' 个单元');
      }
    }
  } catch (e) {
    log.error('删除回写快速查重结果失败: ' + (e && e.message ? e.message : e));
  }
  } catch (e) {
    log.error('删除回写扫描结果失败: ' + (e && e.message ? e.message : e));
    return [];
  }
  return removed;
}
