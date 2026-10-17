
import { labelOf } from '../../core/roots.mjs';
import { normKey, tidySpaces } from './paths.mjs';

const UNKNOWN_TEAM = /^(不明|未知|无|none|unknown|n\/a|-|—|\?)$/i;

/**
 * 自动标签派生（纯函数，可单测）。
 * 规则逐项开关见 storage.DERIVE_RULE_KEYS：
 *   metaTags     -> 元数据 tags 原样
 *   categories   -> 元数据 categories 原样
 *   author       -> 作者:xx
 *   chineseTeam  -> 汉化:xx（skipUnknownTeam 为真时跳过「不明/未知」这类占位值）
 *   root         -> 根:哔咔下载库 / 根:先期漫画（取 roots.labelOf）
 *   chapterCount -> 话数:单话 / 话数:多话
 *   manualSource -> 无元数据 => 来源:手工收录
 */
export function deriveAutoTags(comic, cfg, settings) {
  const st = settings || {};
  const rules = st.rules || {};
  const on = function (k) { return st.derive !== false && rules[k] !== false; };
  const out = [];
  const seen = new Set();
  const push = function (name, group) {
    const n = tidySpaces(name);
    if (!n) return;
    const key = normKey(n);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, key: key, group: group });
  };
  const c = comic || {};
  if (on('metaTags')) for (const t of (c.tags || [])) push(t, '元数据');
  if (on('categories')) for (const t of (c.categories || [])) push(t, '分类');
  if (on('author') && c.author) push('作者:' + tidySpaces(c.author), '作者');
  if (on('chineseTeam') && c.chineseTeam) {
    const team = tidySpaces(c.chineseTeam);
    const skip = st.skipUnknownTeam !== false;
    if (!(skip && UNKNOWN_TEAM.test(team))) push('汉化:' + team, '汉化');
  }
  if (on('root')) {
    const label = labelOf(cfg, c.rootId) || '';
    if (label) push('根:' + label, '库根');
  }
  if (on('chapterCount')) {
    const n = Number(c.chapterCount);
    push((n > 1 ? '话数:多话' : '话数:单话'), '话数');
  }
  if (on('manualSource') && !c.hasMeta) push('来源:手工收录', '来源');
  return out;
}
