// engine/prefilter.mjs — 快速查重的零成本预筛（v7）。
// 目的：不做全库指纹、不做全库像素比对，只用两条「零成本」元数据信号把候选对缩到几十个，
//       再交给人眼并排看抽样图判定。这是为了根治「漫画多了查重慢得要死、量大还要崩」的痛点：
//       全库指纹（6.3 万张约 7.6 分钟）与全库比对是固定重税，与查重单元数无关。
//
// 两条信号：
//   信号 A 标题模糊匹配 —— 归一化（全角转半角 / 去空白 / 去标点符号 / 小写）后算 Dice 二元组系数。
//   信号 B 页数接近   —— 查重侧 files.length，库侧累加 comic.chapters[].count。
//
// 实测标定（本机真实数据：140 个查重单元 / 266 部库漫画）：
//   标题>=0.35 且 页差<=5%  ->  13 个候选单元 / 13 个候选对，5 组已知肉眼重复 100% 命中（工作量降 91%）。
//   标题>=0.6  且 页差<=5%  ->  只有 11 个候选，已知重复掉到 4/5（阈值过高会漏）。
//   已知 5 对的最大页差是 7 页（ごちそうさま 194 vs 187 = 3.6%），故 5% 容差安全。
//
// 已排除的方案（勿再试）：按图片尺寸(w,h,size)预筛。实测同一张图的不同转码分辨率完全不同
// （ごちそうさま dup 侧 1439x2048 / lib 侧 1025x1500，尺寸集合交集为 0），对「重编码」场景彻底失明。

/** 标题相似度阈值：低于此值不算候选（实测 0.35 是「不漏已知重复」的下限）。 */
export const DEFAULT_TITLE_THRESHOLD = 0.35;
/** 页数容差：相对查重侧页数的比例（实测 5% 覆盖全部已知重复，最大实际差 3.6%）。 */
export const DEFAULT_PAGE_TOLERANCE = 0.05;
/** 单个单元最多保留多少个候选库作品，防止同名作品极多时爆炸。 */
export const DEFAULT_MAX_CANDIDATES = 40;
/** 页数容差的绝对下限：页数少时 5% 会小于 1 页，必须给一个兜底。 */
const MIN_PAGE_SLACK = 3;

/**
 * 标题归一化：全角转半角 -> 去掉空白 -> 去掉标点与符号 -> 转小写。
 * 为什么必须做：同一部作品在库内与查重目录里的标题差异几乎总是「全角/半角、空格、标点、大小写」，
 * 不归一化会让 Dice 系数直接掉到 0.3 以下，已知重复全部漏掉。
 */
export function normTitle(s) {
  let out = String(s === null || s === undefined ? '' : s);
  // 全角 ASCII（U+FF01..U+FF5E）整体右移 0xFEE0 变成半角；全角空格单独处理。
  let half = '';
  for (let i = 0; i < out.length; i++) {
    const code = out.charCodeAt(i);
    if (code === 0x3000) half += ' ';
    else if (code >= 0xFF01 && code <= 0xFF5E) half += String.fromCharCode(code - 0xFEE0);
    else half += out[i];
  }
  out = half;
  out = out.replace(/\s+/g, '');
  out = out.replace(/[\p{P}\p{S}]/gu, '');
  return out.toLowerCase();
}

/**
 * 取「作品的标题」——单元 id 是「相对查重根的路径」，规范形态（库格式 L2）下带章节后缀，
 * 拿它整串算相似度会被章节名稀释（实测：「1924536-[…] [Digital]/1 第1話」 vs 库里的
 * 同名作品，Dice 从 1.0 掉到 0.5 附近），已知重复会被阈值挡在门外。
 * 判据与 discoverUnits 生成 id 的口径一致：目录直属 元数据.json 时 id = <漫画>/<章节>，
 * 取第一段即作品名。裸形态（id 只有目录名）取不到斜杠，原样返回。
 */
export function comicTitleOfUnit(id) {
  const s = String(id === null || id === undefined ? '' : id);
  const i = s.indexOf('/');
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * Dice 二元组系数（0..1）。用它而不是编辑距离：中文标题的「编辑距离」对长标题过于宽松，
 * 而 Dice 对「前缀相同、后缀不同」这类真实场景（如 ごちそうさま / ごちそうさま 謝謝招待 無修正）区分度更好。
 */
export function diceCoefficient(a, b) {
  const x = String(a === null || a === undefined ? '' : a);
  const y = String(b === null || b === undefined ? '' : b);
  // 空标题不构成证据：一律返回 0，否则所有空标题会互相匹配。
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const map = new Map();
  for (let i = 0; i + 1 < x.length; i++) {
    const g = x.slice(i, i + 2);
    map.set(g, (map.get(g) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i + 1 < y.length; i++) {
    const g = y.slice(i, i + 2);
    const n = map.get(g) || 0;
    if (n > 0) { map.set(g, n - 1); hit++; }
  }
  const total = (x.length - 1) + (y.length - 1);
  return total > 0 ? (2 * hit) / total : 0;
}

/**
 * 库漫画总页数：优先累加 chapters[].count。
 * 为什么不用 comic.pagesCount：实测 266 部里有 16 部两者不一致（和歌酱今天很腹黑 pagesCount=5445 而累加=5999，
 * 差 554 页；[無修正] 加濑大辉总集篇 pagesCount=2826 累加=2904）。用 pagesCount 会让这些大部头的页数信号失真。
 */
export function comicPages(comic) {
  if (!comic) return 0;
  const chapters = comic.chapters;
  if (Array.isArray(chapters) && chapters.length) {
    let sum = 0;
    for (const ch of chapters) {
      if (!ch) continue;
      const n = Number(ch.count);
      if (Number.isFinite(n) && n > 0) sum += n;
      else if (Array.isArray(ch.images)) sum += ch.images.length;
    }
    if (sum > 0) return sum;
  }
  if (Array.isArray(comic.images)) return comic.images.length;
  const pc = Number(comic.pagesCount);
  return Number.isFinite(pc) && pc > 0 ? pc : 0;
}

/** 查重单元页数：直接数图片文件名。 */
function unitPages(unit) {
  if (!unit) return 0;
  if (Array.isArray(unit.files)) return unit.files.length;
  const n = Number(unit.count);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 库漫画标题：优先 title，回落目录名。 */
function comicTitle(comic) {
  if (!comic) return '';
  const t = String(comic.title || '').trim();
  if (t) return t;
  return String(comic.dir || comic.rel || '').trim();
}

/**
 * 预筛：对每个查重单元找出「标题像 + 页数近」的库漫画。
 *
 * units  = [{ id, files, count? }]              查重单元
 * comics = [{ id, title, dir, chapters }]        库漫画（library-index.json 的 comics 数组）
 * opts   = { titleThreshold, pageTolerance, maxCandidates }
 * 返回 { candidates, stats }：
 *   candidates = [{ unitId, unitPages, matches: [{ libId, libTitle, libPages, titleScore, pageDiff, pageDiffRatio, reasons }] }]
 *   stats      = { units, unitsWithCandidate, pairs, omittedUnits }
 *
 * 只有「有候选」的单元才进 candidates；matches 按 titleScore 降序；reasons 是中文标签，供界面直接显示。
 */
export function prefilterUnits(units, comics, opts) {
  const o = opts || {};
  const titleThreshold = Number.isFinite(Number(o.titleThreshold)) ? Number(o.titleThreshold) : DEFAULT_TITLE_THRESHOLD;
  const pageTolerance = Number.isFinite(Number(o.pageTolerance)) ? Number(o.pageTolerance) : DEFAULT_PAGE_TOLERANCE;
  const maxCandidates = Number.isFinite(Number(o.maxCandidates)) && Number(o.maxCandidates) > 0
    ? Math.floor(Number(o.maxCandidates)) : DEFAULT_MAX_CANDIDATES;

  const list = Array.isArray(units) ? units : [];
  const lib = Array.isArray(comics) ? comics : [];
  // 标题归一化只做一次：库侧 266 条、单元侧 140 条，若对每个组合都归一化会白算几万次。
  const libNorm = lib.map(function (c) { return { comic: c, norm: normTitle(comicTitle(c)), pages: comicPages(c) }; });

  const candidates = [];
  let pairs = 0;
  let omittedUnits = 0;
  for (const u of list) {
    const up = unitPages(u);
    const uNorm = normTitle(comicTitleOfUnit(u && u.id));
    const slack = Math.max(MIN_PAGE_SLACK, Math.ceil(up * pageTolerance));
    const matches = [];
    for (const L of libNorm) {
      const score = diceCoefficient(uNorm, L.norm);
      if (score < titleThreshold) continue;
      const diff = up - L.pages;
      if (Math.abs(diff) > slack) continue;
      matches.push({
        libId: String((L.comic && L.comic.id) || ''),
        libTitle: comicTitle(L.comic),
        libPages: L.pages,
        titleScore: Math.round(score * 1000) / 1000,
        pageDiff: diff,
        pageDiffRatio: up > 0 ? Math.round((Math.abs(diff) / up) * 10000) / 10000 : 0,
        reasons: ['标题', '页数']
      });
    }
    if (!matches.length) continue;
    matches.sort(function (a, b) { return b.titleScore - a.titleScore; });
    let kept = matches;
    if (matches.length > maxCandidates) { kept = matches.slice(0, maxCandidates); omittedUnits++; }
    pairs += kept.length;
    candidates.push({
      unitId: String((u && u.id) || ''),
      unitPages: up,
      matches: kept
    });
  }
  return {
    candidates: candidates,
    stats: {
      units: list.length,
      unitsWithCandidate: candidates.length,
      pairs: pairs,
      omittedUnits: omittedUnits
    }
  };
}
