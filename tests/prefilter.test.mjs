// tests/prefilter.test.mjs — 快速查重预筛（engine/prefilter.mjs）的回归防线。
// 关键：用**真实**的 5 组肉眼确认重复作品标题做断言，而不是编造的字符串。
import {
  DEFAULT_TITLE_THRESHOLD, DEFAULT_PAGE_TOLERANCE, DEFAULT_MAX_CANDIDATES,
  normTitle, diceCoefficient, comicPages, comicChapterPages, prefilterUnits, comicTitleOfUnit
} from '../src/modules/dedupe/engine/prefilter.mjs';

export const name = '查重预筛（快速模式）';

// 真实数据（取自 %LOCALAPPDATA%/MangaVault/library-index.json 与 dedupe/hash-result.json）
const P1_dup = '「世界の終わりックス」をしよう';
const P1_lib = '「世界の終わりックス」をしよう | 来做一场「世界终焉的爱」吧';
const P2_dup = '～シスタークレアと淫らな秘密と噂の催眠アプリ～ フルカラー 総集編';
const P2_lib = 'シスタークレアと淫らな秘密と噂の催眠アプリ';
const P3_dup = 'ごちそうさま';
const P3_lib = 'ごちそうさま 謝謝招待 無修正';
const P4 = 'ジト目メイドさんとラブラブえっち';
const P5 = 'スマートグラスのラブアシストアプリを使って絶頂カウントえっち';

function pages(n) { return new Array(n).fill('x.jpg'); }

export default async function (t) {
  // ---------- 1. 标定出来的常量 ----------
  t.eq(DEFAULT_TITLE_THRESHOLD, 0.35, '默认标题阈值应为实测标定值 0.35');
  t.eq(DEFAULT_PAGE_TOLERANCE, 0.05, '默认页数容差应为实测标定值 5%');
  t.eq(DEFAULT_MAX_CANDIDATES, 40, '默认候选上限 40');

  // ---------- 2. normTitle ----------
  t.eq(normTitle('ＡＢＣ１２３'), 'abc123', '全角字母数字应转半角');
  t.eq(normTitle('ごちそう　さま'), 'ごちそうさま', '全角空格应去掉');
  t.eq(normTitle('ごちそう さま'), 'ごちそうさま', '半角空白应去掉');
  t.eq(normTitle('「世界の終わりックス」をしよう'), '世界の終わりックスをしよう', '中文书名号应去掉');
  t.eq(normTitle('A | B'), 'ab', '竖线与空白应去掉');
  t.eq(normTitle('～シスタークレア～'), 'シスタークレア', '波浪号应去掉');
  t.eq(normTitle('a-b_c.d'), 'abcd', '连字符/下划线/点应去掉');
  t.eq(normTitle('Hello World'), 'helloworld', '应转小写');
  t.eq(normTitle(''), '', '空串安全');
  t.eq(normTitle(null), '', 'null 安全');
  t.eq(normTitle(undefined), '', 'undefined 安全');
  // 归一化后的真实标题必须更接近，这是预筛能生效的前提
  t.ok(diceCoefficient(normTitle(P3_dup), normTitle(P3_lib)) > diceCoefficient(P3_dup, P3_lib),
    '归一化必须让 ごちそうさま 与 ごちそうさま 謝謝招待 無修正 更接近');

  // ---------- 3. diceCoefficient 基础性质 ----------
  t.eq(diceCoefficient('abc', 'abc'), 1, '相同为 1');
  t.eq(diceCoefficient('abc', 'xyz'), 0, '完全不同为 0');
  t.eq(diceCoefficient('', 'abc'), 0, '空串为 0');
  t.eq(diceCoefficient('a', 'b'), 0, '单字符不同为 0');
  t.eq(diceCoefficient('a', 'a'), 1, '单字符相同为 1');
  t.eq(diceCoefficient('abcd', 'abce'), diceCoefficient('abce', 'abcd'), '对称性');
  const mid = diceCoefficient('abcdef', 'abcxyz');
  t.ok(mid > 0 && mid < 1, '部分相同应落在 (0,1)，实测 ' + mid);

  // ---------- 4. 真实 5 组的相似度必须复现标定值 ----------
  const cal = [
    [P1_dup, P1_lib, 0.686],
    [P2_dup, P2_lib, 0.833],
    [P3_dup, P3_lib, 0.588],
    [P4, P4, 1.0],
    [P5, P5, 1.0]
  ];
  for (const c of cal) {
    const got = diceCoefficient(normTitle(c[0]), normTitle(c[1]));
    t.ok(Math.abs(got - c[2]) <= 0.01,
      c[0] + ' vs ' + c[1] + ' 期望 ' + c[2] + '（±0.01）实测 ' + got.toFixed(4));
  }
  for (const c of cal) {
    const got = diceCoefficient(normTitle(c[0]), normTitle(c[1]));
    t.ok(got >= DEFAULT_TITLE_THRESHOLD, c[0] + ' 相似度 ' + got.toFixed(3) + ' 低于阈值，会让已知重复漏网');
  }

  // ---------- 5. comicPages ----------
  t.eq(comicPages({ chapters: [{ count: 3 }, { count: 4 }] }), 7, '累加 chapters[].count');
  t.eq(comicPages({ chapters: [{ count: 5 }], pagesCount: 5 }), 5, '一致时取章节累加');
  t.eq(comicPages({ chapters: [{ images: ['a', 'b'] }, { count: 3 }] }), 5, '章节缺 count 时回退 images.length');
  t.eq(comicPages({ images: ['a', 'b', 'c'] }), 3, '无 chapters 时回退 images');
  t.eq(comicPages({ pagesCount: 9 }), 9, '最后回退 pagesCount');
  t.eq(comicPages({}), 0, '空对象为 0');
  t.eq(comicPages(null), 0, 'null 为 0');
  // 真实数据里有 16 部 pagesCount 与章节累加不一致，必须选章节累加
  t.eq(comicPages({ pagesCount: 2826, chapters: [{ count: 2000 }, { count: 904 }] }), 2904,
    '不一致时必须用章节累加（[無修正] 加濑大辉总集篇 真实值 2826 vs 2904）');
  t.eq(comicPages({ pagesCount: 5445, chapters: [{ count: 5999 }] }), 5999,
    '不一致时必须用章节累加（和歌酱今天很腹黑 真实值 5445 vs 5999）');

  // ---------- 6. 两条信号各自都能独立否决 ----------
  const one = function (id, n, libTitle, libPages) {
    return prefilterUnits([{ id: id, files: pages(n) }], [{ id: 'c1', title: libTitle, chapters: [{ count: libPages }] }], {});
  };
  t.eq(one('作品甲', 10, '作品甲', 500).candidates.length, 0, '标题达标但页数不达标 -> 不是候选');
  t.eq(one('完全不同的标题', 10, '毫不相干的作品名', 10).candidates.length, 0, '页数达标但标题不达标 -> 不是候选');
  const hit = one('作品甲', 10, '作品甲', 11);
  t.eq(hit.candidates.length, 1, '两信号都达标 -> 是候选');
  t.eq(hit.candidates[0].unitId, '作品甲', 'candidate.unitId');
  t.eq(hit.candidates[0].unitPages, 10, 'candidate.unitPages');
  const mm = hit.candidates[0].matches[0];
  t.eq(mm.libId, 'c1', 'match.libId');
  t.eq(mm.libTitle, '作品甲', 'match.libTitle');
  t.eq(mm.libPages, 11, 'match.libPages');
  t.eq(mm.titleScore, 1, 'match.titleScore');
  t.eq(mm.pageDiff, -1, 'match.pageDiff');
  t.deepEq(mm.reasons, ['标题', '页数'], 'match.reasons 应为中文标签');
  t.ok(typeof mm.pageDiffRatio === 'number', 'match.pageDiffRatio 应为数字');

  // ---------- 7. 阈值边界必须是 >= 语义 ----------
  const score = diceCoefficient(normTitle('abcd'), normTitle('abce'));
  const at = prefilterUnits([{ id: 'abcd', files: pages(5) }], [{ id: 'c1', title: 'abce', chapters: [{ count: 5 }] }], { titleThreshold: score });
  t.eq(at.candidates.length, 1, '恰好等于阈值必须命中（>= 语义）');
  const above = prefilterUnits([{ id: 'abcd', files: pages(5) }], [{ id: 'c1', title: 'abce', chapters: [{ count: 5 }] }], { titleThreshold: score + 0.0001 });
  t.eq(above.candidates.length, 0, '略高于阈值必须不命中');

  // ---------- 8. 页数容差的 MIN_PAGE_SLACK=3 绝对兜底 ----------
  t.eq(one('作品甲', 2, '作品甲', 5).candidates.length, 1, '页差 3 应在 3 页兜底容差内');
  t.eq(one('作品甲', 2, '作品甲', 6).candidates.length, 0, '页差 4 应被挡掉');

  // ---------- 9. matches 必须按 titleScore 降序 ----------
  const many = prefilterUnits([{ id: '作品甲', files: pages(10) }], [
    { id: 'c1', title: '作品甲 乙', chapters: [{ count: 10 }] },
    { id: 'c2', title: '作品甲', chapters: [{ count: 10 }] },
    { id: 'c3', title: '作品甲丙丁戊', chapters: [{ count: 10 }] }
  ], {});
  t.eq(many.candidates.length, 1, '应产生 1 个候选单元');
  const sc = many.candidates[0].matches.map(function (m) { return m.titleScore; });
  let desc = true;
  for (let i = 1; i < sc.length; i++) if (sc[i - 1] < sc[i]) desc = false;
  t.ok(desc, 'matches 必须降序，实测 ' + JSON.stringify(sc));
  t.eq(many.candidates[0].matches[0].libId, 'c2', '最高分必须是最像的 c2');

  // ---------- 10. maxCandidates 截断与 omittedUnits ----------
  const libs = [];
  for (let i = 0; i < 5; i++) libs.push({ id: 'c' + i, title: '作品甲', chapters: [{ count: 10 }] });
  const cut = prefilterUnits([{ id: '作品甲', files: pages(10) }], libs, { maxCandidates: 2 });
  t.eq(cut.candidates[0].matches.length, 2, '必须截断到 2 个');
  t.eq(cut.stats.omittedUnits, 1, '被截断的单元数应计入 omittedUnits');
  t.eq(cut.stats.pairs, 2, 'pairs 只算保留下来的');
  const full = prefilterUnits([{ id: '作品甲', files: pages(10) }], libs, { maxCandidates: 40 });
  t.eq(full.stats.omittedUnits, 0, '不超限时 omittedUnits 为 0');
  t.eq(full.stats.pairs, 5, '不超限时 pairs 为 5');

  // ---------- 11. stats.units 是输入单元总数 ----------
  // 注意：这里刻意用**没有共同二元组**的标题。中文短标题只要共用一个二字词就能到 0.35
  // （实测 '有候选' 与 '没候选甲' 共用 '候选' -> 2*1/5 = 0.4 >= 0.35 会被判为候选），
  // 这是短标题下阈值偏宽松的固有特性，靠页数信号与「人在环」兜底，不要靠调高阈值解决（会漏真实重复）。
  const st = prefilterUnits([
    { id: 'AAA甲甲甲甲甲', files: pages(10) },
    { id: 'BBB乙乙乙乙乙', files: pages(10) },
    { id: 'CCC丙丙丙丙丙', files: pages(10) }
  ], [{ id: 'c1', title: 'AAA甲甲甲甲甲', chapters: [{ count: 10 }] }], {});
  t.eq(st.stats.units, 3, 'stats.units 应为输入总数');
  t.eq(st.stats.unitsWithCandidate, 1, 'stats.unitsWithCandidate');
  t.eq(st.stats.pairs, 1, 'stats.pairs');

  // ---------- 12. 真实 5 组必须全部产生候选（本文件的核心断言） ----------
  const units = [
    { id: P1_dup, files: pages(67) },
    { id: P2_dup, files: pages(85) },
    { id: P3_dup, files: pages(194) },
    { id: P4, files: pages(29) },
    { id: P5, files: pages(26) },
    // 故意取两个毫无共同二元的标题，保证不产生多余候选
    { id: 'ZZZ甲甲甲甲甲', files: pages(50) }
  ];
  const comics = [
    { id: 'L1', title: P1_lib, chapters: [{ count: 69 }] },
    { id: 'L2', title: P2_lib, chapters: [{ count: 85 }] },
    { id: 'L3', title: P3_lib, chapters: [{ count: 187 }] },
    { id: 'L4', title: P4, chapters: [{ count: 30 }] },
    { id: 'L5', title: P5, chapters: [{ count: 26 }] },
    { id: 'L9', title: 'YYY乙乙乙乙乙', chapters: [{ count: 50 }] }
  ];
  const real = prefilterUnits(units, comics, {});
  const byUnit = new Map(real.candidates.map(function (c) { return [c.unitId, c]; }));
  const expect = [[P1_dup, 'L1'], [P2_dup, 'L2'], [P3_dup, 'L3'], [P4, 'L4'], [P5, 'L5']];
  for (const e of expect) {
    const c = byUnit.get(e[0]);
    t.ok(!!c, '已知重复 ' + e[0] + ' 必须产生候选，实际没有');
    if (c) {
      const ids = c.matches.map(function (m) { return m.libId; });
      t.ok(ids.indexOf(e[1]) >= 0, e[0] + ' 的候选里必须含 ' + e[1] + '，实测 ' + JSON.stringify(ids));
    }
  }
  t.ok(!byUnit.has('ZZZ甲甲甲甲甲'), '不相关作品不应产生候选');
  t.eq(real.stats.unitsWithCandidate, 5, '恰好 5 个单元有候选（工作量从 140 降到 5）');
  t.eq(real.stats.units, 6, 'stats.units 应为 6');
  t.eq(real.stats.pairs, 5, '5 个候选对');

  // ---------- 13. 真实规模性能（零成本信号必须远快于 1 秒） ----------
  const u140 = [], c266 = [];
  for (let i = 0; i < 140; i++) u140.push({ id: '单元' + i, files: pages(20 + i) });
  for (let i = 0; i < 266; i++) c266.push({ id: 'c' + i, title: '作品' + i, chapters: [{ count: 20 + i }] });
  const t0 = Date.now();
  const big = prefilterUnits(u140, c266, {});
  const ms = Date.now() - t0;
  t.ok(ms < 1000, '140×266=37240 次比较耗时 ' + ms + 'ms，应远小于 1 秒');
  t.eq(big.stats.units, 140, 'stats.units 应为 140');
  t.ok(big.stats.pairs <= 140 * 266, 'pairs 不超过全组合数');

  // ---------- 14. 空输入不炸 ----------
  t.eq(prefilterUnits([], [], {}).candidates.length, 0, '空输入');
  t.eq(prefilterUnits(null, null, {}).candidates.length, 0, 'null 输入');
  t.eq(prefilterUnits([], null, {}).stats.units, 0, '库为 null 时 stats.units 应为 0');
  t.eq(prefilterUnits([{ id: 'x', files: ['a.jpg'] }], [], {}).candidates.length, 0, '库为空时不产生候选');

  // ---------- 15. comicTitleOfUnit：单元 id 带章节路径时必须取回作品名 ----------
  // 背景：库格式正规化后，查重侧的单元 id 变成「<漫画目录>/1 第1話」。
  // 若拿整个 id 去算 Dice，标题会被「/1 第1話」这段公共垃圾严重稀释，
  // 已确认的重复作品会一个候选都选不出来（实测 95 个单元全部 0 候选）。
  t.eq(comicTitleOfUnit(P3_dup + '/1 第1話'), P3_dup, '带章节后缀的 id 必须切回作品名');
  t.eq(comicTitleOfUnit(P3_dup), P3_dup, '不带斜杠的 id 原样返回');
  t.eq(comicTitleOfUnit('A/B/C'), 'A', '多层路径取第一段');
  t.eq(comicTitleOfUnit(''), '', '空串返回空串');
  t.eq(comicTitleOfUnit(null), '', 'null 返回空串');
  // 前导斜杠刻意不切（切了会得到空标题，反而让整条链路静默失效），原样返回更安全
  t.eq(comicTitleOfUnit('/开头就是斜杠'), '/开头就是斜杠', '异常前导斜杠原样返回，不切成空串');
  // 端到端：正规化后的 id 形态必须能选出候选
  const normUnits = [
    { id: P3_dup + '/1 第1話', files: pages(194) },
    { id: P4 + '/1 第1話', files: pages(29) }
  ];
  const normReal = prefilterUnits(normUnits, comics, {});
  t.eq(normReal.stats.unitsWithCandidate, 2, '正规化 id 的 2 个单元都应产生候选');
  const n3 = normReal.candidates.find(function (c) { return c.unitId === P3_dup + '/1 第1話'; });
  t.ok(n3 && n3.matches.map(function (m) { return m.libId; }).indexOf('L3') >= 0,
    '正规化 id 的 ごちそうさま 必须命中库侧 L3');
  // 回归：带章节段与不带章节段算出来的标题分必须完全相同
  t.eq(comicTitleOfUnit(P4 + '/1 第1話'), P4, 'id 切段后与裸标题一致');
  // ---------- 16. 章节页数信号：正规化库（<漫画>/<序> 第N話/）下查重单元是**单章节** ----------
  // 背景（真实事故）：库被正规化成 L2 嵌套形态后，查重单元 id 与目录都是「<漫画>/1 第1話」，
  // unitPages 只有该章 6~10 页，而库侧 comicPages 是整部作品 36~500 页。
  // 只拿「单元页数 vs 作品总页数」比，5% 容差必然全灭 —— 实测 95 个单元 0 候选、
  // 演示库 12 个单元 0 候选，而人工看是明显重复。必须叠加「与最接近的章节页数比」。
  const l2comic = { id: 'L2A', title: '星海邮差', chapters: [{ count: 8 }, { count: 8 }, { count: 8 }, { count: 8 }, { count: 8 }] };
  t.eq(comicChapterPages(l2comic).length, 5, 'comicChapterPages 应返回每章页数');
  t.deepEq(comicChapterPages({ chapters: [{ images: ['a', 'b'] }, { count: 3 }] }), [2, 3],
    'comicChapterPages 与 comicPages 同口径：缺 count 时回落 images.length');
  t.deepEq(comicChapterPages({}), [], '无 chapters 时返回空数组');
  t.deepEq(comicChapterPages(null), [], 'null 安全');

  const chHit = prefilterUnits([{ id: '星海邮差 汉化版/1 序', files: pages(8) }], [l2comic], {});
  t.eq(chHit.candidates.length, 1, '单章节单元（8 页）与作品总页数（40）对不上，但命中章页数 -> 必须仍是候选');
  const chM = chHit.candidates[0].matches[0];
  t.eq(chM.libId, 'L2A', '命中的是同一部作品');
  t.eq(chM.pageDiff, 0, 'pageDiff 报的是「与最像那个章节」的差，不是与总页数的差');
  t.deepEq(chM.reasons, ['标题', '章节页数'], '只有章节页数命中时 reasons 必须如实标注，界面才不会误显示为「总页数一致」');

  // 章节页数也不能无脑放行：所有章节都对不上时必须否决
  const chMiss = prefilterUnits([{ id: '星海邮差 汉化版/1 序', files: pages(8) }],
    [{ id: 'L2B', title: '星海邮差', chapters: [{ count: 20 }, { count: 21 }] }], {});
  t.eq(chMiss.candidates.length, 0, '章节页数全部偏离（差 12 页 > 3 页兜底）必须否决');

  // 裸形态（作品没有 chapters，只有 pagesCount/images）行为必须与以前一致
  const bareHit = prefilterUnits([{ id: '作品甲', files: pages(10) }], [{ id: 'B1', title: '作品甲', pagesCount: 11 }], {});
  t.eq(bareHit.candidates.length, 1, '裸形态仍按总页数判定，且 reasons 是「页数」');
  t.deepEq(bareHit.candidates[0].matches[0].reasons, ['标题', '页数'], '裸形态 reasons 不变');

  // 总页数命中时不能被章节信号改写（否则 pageDiff 语义会随数据形态漂移）
  const totHit = prefilterUnits([{ id: '星海邮差', files: pages(40) }], [l2comic], {});
  t.eq(totHit.candidates[0].matches[0].pageDiff, 0, '总页数 40 与作品 40 一致时 pageDiff=0');
  t.deepEq(totHit.candidates[0].matches[0].reasons, ['标题', '页数'], '两者都满足时优先报「页数」');
}
