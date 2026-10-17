// engine/store.mjs — 状态读写（全部落在 data/dedupe/ 下；每次写都原子落盘，不用防抖，避免丢最后一次决策）。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, readJson, atomicWriteJson } from '../../../core/util.mjs';

export async function readScan(paths) { return readJson(paths.scanFile, null); }
export async function writeScan(paths, scan) { await atomicWriteJson(paths.scanFile, scan); return scan; }

export async function readHash(paths) { return readJson(paths.hashFile, null); }
export async function writeHash(paths, hash) { await atomicWriteJson(paths.hashFile, hash); return hash; }

export async function readDecisions(paths) {
  const raw = await readJson(paths.decisionFile, {});
  return raw && typeof raw === 'object' ? raw : {};
}

/** 写一条人工决策（keep/delete/pending + note）。 */
export async function setDecision(paths, unitId, verdict, note) {
  const decisions = await readDecisions(paths);
  const prev = decisions[unitId] || {};
  // 'deleted' 由「执行删除」成功后回写（磁盘上已经删掉了）。它必须能被真正落盘：
  // 旧白名单只有 keep/delete/pending，于是 setDecision(id, 'deleted') 会被静默降级成
  // 上一次的 'delete'，列表中永远没有「已删除」标记，也就永远过滤不掉 —— 这是
  // 「删了之后列表还在」的根因之一。deleted 与 keep/delete/pending 同级，同样受白名单校验。
  const allowed = ['keep', 'delete', 'pending', 'deleted'];
  decisions[unitId] = {
    verdict: allowed.includes(verdict) ? verdict : (prev.verdict || 'pending'),
    note: note === undefined ? (prev.note || '') : String(note).slice(0, 500),
    updatedAt: new Date().toISOString()
  };
  await ensureDir(paths.root);
  await atomicWriteJson(paths.decisionFile, decisions);
  return decisions[unitId];
}

export async function readState(paths) { return readJson(paths.stateFile, {}); }
export async function writeState(paths, state) { await atomicWriteJson(paths.stateFile, state); return state; }

/** 追加一条删除日志（jsonl）。 */
export async function appendDeleteLog(paths, entry) {
  try {
    await ensureDir(paths.root);
    await fsp.appendFile(paths.deleteLog, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch (e) { return false; }
}

/** 读取删除日志（倒序，默认最近 200 条）。 */
export async function readDeleteLog(paths, limit) {
  let text = '';
  try { text = await fsp.readFile(paths.deleteLog, 'utf8'); } catch (e) { return []; }
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (e) { /* 跳过坏行 */ }
  }
  out.reverse();
  return out.slice(0, Number(limit) || 200);
}

/** 由扫描结果汇总统计（单元数 / 各类判定 / 可清理体积）。 */
export function statsOf(scan, decisions) {
  const units = (scan && scan.units) || [];
  const dec = decisions || {};
  let bytes = 0;
  let images = 0;
  const counts = { '完全重复': 0, '同图不同编码': 0, '部分重复': 0, '未找到': 0 };
  let keep = 0;
  let toDelete = 0;
  let pending = 0;
  let markedBytes = 0;
  for (const u of units) {
    counts[u.judge] = (counts[u.judge] || 0) + 1;
    bytes += u.dupBytes || 0;
    images += u.dupCount || 0;
    const verdict = (dec[u.id] && dec[u.id].verdict) || 'pending';
    if (verdict === 'keep') keep++;
    else if (verdict === 'delete') { toDelete++; markedBytes += u.dupBytes || 0; }
    else pending++;
  }
  return {
    units: units.length,
    images: images,
    totalBytes: bytes,
    byVerdict: counts,
    decisions: { keep: keep, delete: toDelete, pending: pending },
    reclaimableBytes: bytes,
    markedBytes: markedBytes,
    generatedAt: (scan && scan.generatedAt) || null
  };
}
