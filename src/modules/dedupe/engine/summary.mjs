// engine/summary.mjs — 扫描结果的数量汇总。
// 独立成文件是为了打断循环依赖：pipeline.mjs 与 pipeline-fast.mjs 都要用它，
// 而两者之间已经是「pipeline 重导出 pipeline-fast」的单向关系，再反向 import 就成环了。
import { VERDICTS } from './scan.mjs';

/** 汇总各判定数量。 */
export function summaryOf(units) {
  const out = {};
  for (const v of VERDICTS) out[v] = 0;
  out['字节一致图片数'] = 0;
  out['像素一致图片数'] = 0;
  for (const u of units) {
    if (out[u.judge] === undefined) out[u.judge] = 0;
    out[u.judge]++;
    out['字节一致图片数'] += u.exactCount || 0;
    out['像素一致图片数'] += u.pixelCount || 0;
  }
  return out;
}
