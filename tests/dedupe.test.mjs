// tests/dedupe.test.mjs — 查重模块离线单测（全部在 os.tmpdir() 里造样本，不碰用户文件）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeJoin } from '../src/core/util.mjs';
import { discoverUnits, buildLibraryIndex, byteDedupeUnits, makeShaCache, judgeOf, judgeCoverage, recordOf } from '../src/modules/dedupe/engine/scan.mjs';
import { grayStats, zMadOf, SD_FLOOR, RESCUE_THRESH, RESCUE_MIN, COV_FULL } from '../src/modules/dedupe/engine/match.mjs';
import { madOf } from '../src/modules/dedupe/engine/fpio.mjs';
import { fileURLToPath } from 'node:url';
import { validateDeleteRequest, executeDelete, shellExe, CONFIRM_WORD } from '../src/modules/dedupe/engine/delete.mjs';
import { resolvePaths } from '../src/modules/dedupe/engine/paths.mjs';
import { setDecision, readDecisions, statsOf } from '../src/modules/dedupe/engine/store.mjs';
import { createApp } from '../src/core/http.mjs';
import { createLogger } from '../src/core/log.mjs';

export const name = '查重模块';

/** 仓库根目录（源码契约断言用）。 */
const pathRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 造一个假图片文件（字节查重只做 SHA-256，不需要真的可解码）。 */
function fakeJpg(file, marker) {
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(String(marker).repeat(24), 'utf8')]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

export default async function (t) {
  const root = path.join(os.tmpdir(), 'mv-dedupe-test-' + process.pid + '-' + Date.now());
  const scan = path.join(root, 'scan');
  const lib = path.join(root, 'lib');
  try {
    // ---------- 样本一：直接含图片的目录 / 只含子目录的目录 ----------
    fakeJpg(path.join(scan, '分类A', '完全重复', '001.jpg'), 'A');
    fakeJpg(path.join(scan, '分类A', '完全重复', '002.jpg'), 'B');
    fakeJpg(path.join(scan, '分类A', '部分重复', '001.jpg'), 'A');
    fakeJpg(path.join(scan, '分类A', '部分重复', '002.jpg'), 'C');
    fakeJpg(path.join(scan, '分类A', '部分重复', '003.jpg'), 'D');
    fakeJpg(path.join(scan, '分类A', '未找到', 'a.jpg'), 'C');
    fakeJpg(path.join(scan, '分类A', '未找到', 'b.jpg'), 'D');
    fakeJpg(path.join(scan, '分类B', '子目录', '嵌套单元', 'only.png'), 'E');
    // 库：漫画1/第1话 里有 A、B 两个字节
    fakeJpg(path.join(lib, '漫画1', '第1话', '001.jpg'), 'A');
    fakeJpg(path.join(lib, '漫画1', '第1话', '002.jpg'), 'B');
    fs.writeFileSync(path.join(lib, '漫画1', '元数据.json'), JSON.stringify({ id: 'c1', title: '漫画1' }), 'utf8');
    fs.writeFileSync(path.join(lib, '漫画1', '第1话', '章节元数据.json'), JSON.stringify({ chapterId: 'a'.repeat(24), chapterTitle: '第1话', order: 1 }), 'utf8');

    // ---------- (a) 单元发现 ----------
    const units = await discoverUnits(scan);
    const ids = units.map(function (u) { return u.id; }).sort();
    t.eq(units.length, 4, '(a) 应识别 4 个「直接含图片」的比对单元');
    t.deepEq(ids, ['分类A/完全重复', '分类A/未找到', '分类A/部分重复', '分类B/子目录/嵌套单元'].sort(), '(a) 单元 id 为相对路径');
    const nested = units.find(function (u) { return u.name === '嵌套单元'; });
    t.ok(nested && nested.category === '分类B', '(a) 分类取第一段路径');
    t.ok(nested && nested.files.length === 1 && nested.bytes > 0, '(a) 单元记录图片数与体积');
    const onlyChild = units.find(function (u) { return u.id === '分类A'; });
    t.ok(!onlyChild, '(a) 只含子目录、不直接含图片的目录不算单元');

    // ---------- (b) SHA-256 字节查重判定 ----------
    const libIndex = await buildLibraryIndex(lib);
    t.eq(libIndex.chapters.length, 1, '(b) 库索引识别 1 个章节');
    t.eq(libIndex.libImages, 2, '(b) 库索引识别 2 张图片');
    const dedup = await byteDedupeUnits(units, libIndex, { shaCache: makeShaCache(), pixelReview: true });
    const byId = new Map(units.map(function (u) { return [u.id, u]; }));
    t.eq(byId.get('分类A/完全重复').exact.size, 2, '(b) 完全重复单元 2 张字节命中');
    t.eq(byId.get('分类A/部分重复').exact.size, 1, '(b) 部分重复单元 1 张字节命中');
    t.eq(byId.get('分类A/未找到').exact.size, 0, '(b) 未找到单元 0 张字节命中');
    t.eq(byId.get('分类A/完全重复').nonExact.length, 0, '(b) 完全重复单元没有待像素复核图片');
    t.eq(byId.get('分类A/部分重复').candSrc, '内容命中', '(b) 候选章节由内容命中推断');
    t.eq(dedup.exactTotal, 3, '(b) 字节命中合计 3 张');
    // 注意：体积近似投票按「候选图片对」累计（与原实现一致），同尺寸样本会被判为候选
    const needIds = dedup.needPixel.map(function (u) { return u.id; });
    t.eq(needIds.length, 2, '(b) 有非字节命中且有候选章节的单元才需要像素复核');
    t.ok(needIds.indexOf('分类A/部分重复') >= 0 && needIds.indexOf('分类A/未找到') >= 0, '(b) 待复核单元包含部分重复与未找到');
    t.ok(needIds.indexOf('分类A/完全重复') < 0, '(b) 已全部字节命中的单元不再像素复核');

    const recFully = recordOf(byId.get('分类A/完全重复'), { pixelCount: 0, thumbCount: 6 });
    const recPart = recordOf(byId.get('分类A/部分重复'), { pixelCount: 0, thumbCount: 6 });
    const recNone = recordOf(byId.get('分类A/未找到'), { pixelCount: 0, thumbCount: 6 });
    t.eq(recFully.judge, '完全重复', '(b) 判定：完全重复');
    t.eq(recPart.judge, '部分重复', '(b) 判定：命中率 1/3 >= 30% -> 部分重复');
    t.eq(recNone.judge, '未找到', '(b) 判定：0 命中 -> 未找到');
    t.eq(recPart.exactCount, 1, '(b) 记录里 exactCount 正确');
    t.eq(recPart.matchRatio, 0.333, '(b) matchRatio 保留三位小数');
    t.ok(recFully.dupBytes > 0 && recFully.dupMB >= 0, '(b) 记录带体积');
    t.eq(recNone.samples[0].lib, '', '(b) 未找到时不展示「最接近」的库内图');

    // 判定边界：命中率恰好 30% 算部分重复，低于则未找到
    t.eq(judgeOf(10, 3, 0), '部分重复', '(b) 30% 边界 -> 部分重复');
    t.eq(judgeOf(10, 2, 0), '未找到', '(b) 20% -> 未找到');
    t.eq(judgeOf(4, 0, 4), '同图不同编码', '(b) 全像素命中 -> 同图不同编码');
    t.eq(judgeOf(0, 0, 0), '未找到', '(b) 空单元 -> 未找到');
    // ---------- (b2) 覆盖率判定口径（judgeCoverage）----------
    // 旧口径 judgeOf 看「全库命中总数/总数」，一次偶然命中就进分子；重编码让字节命中全灭时，
    // 唯一可靠证据是「绝大多数页都指向同一个库章节」，故像素阶段改用覆盖率口径。
    t.eq(judgeCoverage({ total: 10, exact: 10, cov: 1 }), '完全重复', '(b2) 全字节命中 -> 完全重复');
    t.eq(judgeCoverage({ total: 10, exact: 0, cov: 1 }), '同图不同编码', '(b2) 主章节 100% -> 同图不同编码');
    t.eq(judgeCoverage({ total: 100, exact: 0, cov: 0.9 }), '同图不同编码', '(b2) 覆盖率恰好 90% 算同一部作品');
    t.eq(judgeCoverage({ total: 100, exact: 1, cov: 0.95 }), '同图不同编码', '(b2) 1 张字节命中 + 95% 覆盖仍是同图不同编码');
    t.eq(judgeCoverage({ total: 100, exact: 0, cov: 0.3 }), '部分重复', '(b2) 覆盖率 30% 边界 -> 部分重复');
    t.eq(judgeCoverage({ total: 100, exact: 0, cov: 0.29 }), '未找到', '(b2) 覆盖率 29% -> 未找到');
    t.eq(judgeCoverage({ total: 100, exact: 5, cov: 0.1, globalRatio: 0.4 }), '部分重复', '(b2) 命中散布多章节：全局命中率 >= 30% -> 部分重复');
    t.eq(judgeCoverage({ total: 100, exact: 5, cov: 0.1, globalRatio: 0.2 }), '未找到', '(b2) 全局命中率 20% -> 未找到');
    t.eq(judgeCoverage({ total: 0, exact: 0, cov: 0 }), '未找到', '(b2) 空单元 -> 未找到');
    t.eq(judgeCoverage(null), '未找到', '(b2) 无覆盖率证据 -> 未找到');

    // ---------- (b3) z 归一化对亮度漂移免疫（这就是「查重没招」的根因回归）----------
    // 重编码 webp <-> jpg 会让整页亮度整体漂移；raw MAD 对这种漂移完全失明，
    // 惩罚经常比「两张无关图」还大，于是真图被 8x8 raw L1 粗筛提前排除。
    // 校准常量是实测标定出来的，改动前必须先跑真库回归（scripts/dev/tmp-t2-e2e.mjs 的思路）。
    t.eq(SD_FLOOR, 8, '(b3) 平坦页标准差下限 = 8');
    t.eq(RESCUE_THRESH, 2, '(b3) 救援阈值 = 2（比主阈值 8 紧 4 倍）');
    t.eq(RESCUE_MIN, 0.5, '(b3) 救援守卫：主章节覆盖率不到 50% 不救援');
    t.eq(COV_FULL, 0.9, '(b3) 同一部作品的覆盖率门槛 = 90%');
    t.ok(RESCUE_THRESH < 8, '(b3) 救援阈值必须比主阈值紧，否则假阳性爆炸');

    /** 造一张合成灰度图（1024 字节）与其 z 归一化参数。 */
    function synthLib(pat) {
      const gray = Buffer.alloc(1024);
      for (let k = 0; k < 1024; k++) gray[k] = pat(k);
      const linv = new Float32Array(1);
      const lnrm = new Float32Array(1);
      const st = grayStats(gray, 0);
      const iv = st.sd < SD_FLOOR ? 0 : 1 / st.sd;
      linv[0] = iv;
      lnrm[0] = st.m * iv;
      return { gray: gray, linv: linv, lnrm: lnrm, sd: st.sd, n: 1 };
    }
    // 基准图：均值约 79.5、标准差约 28.9（远高于 SD_FLOOR）
    const baseLib = synthLib(function (k) { return 30 + (k % 100); });
    t.ok(baseLib.sd > SD_FLOOR, '(b3) 基准图不是平坦图（sd=' + baseLib.sd.toFixed(1) + '）');
    const shiftBuf = Buffer.alloc(1024);
    const baseBuf = Buffer.alloc(1024);
    for (let k = 0; k < 1024; k++) {
      baseBuf[k] = 30 + (k % 100);
      // 仿重编码：整体提亮 + 对比度压缩（线性变换，z 归一化理论上完全抵消）
      shiftBuf[k] = Math.round(60 + (baseBuf[k] - 30) * 0.5);
    }
    const shiftQ = grayStats(shiftBuf, 0);
    const baseQ = grayStats(baseBuf, 0);
    const zSame = zMadOf(baseLib, baseBuf, 0, baseQ.m, 1 / baseQ.sd, 0);
    const zShift = zMadOf(baseLib, shiftBuf, 0, shiftQ.m, 1 / shiftQ.sd, 0);
    const rawShift = madOf(shiftBuf, 0, baseLib.gray, 0);
    t.ok(zSame < 0.01, '(b3) 同一张图 z-MAD 应为 0（实测 ' + zSame.toFixed(4) + '）');
    t.ok(zShift < 1, '(b3) 亮度漂移图的 z-MAD 应接近 0（实测 ' + zShift.toFixed(3) + '）');
    t.ok(rawShift > 10, '(b3) 同一张图的 raw MAD 因亮度漂移而很大（实测 ' + rawShift.toFixed(1) + '）');
    t.ok(rawShift > zShift * 10, '(b3) 关键回归：raw MAD 对亮度漂移失明，z-MAD 才能识别同一张图');
    // 无关图必须被 z-MAD 拉开距离
    const otherBuf = Buffer.alloc(1024);
    for (let k = 0; k < 1024; k++) otherBuf[k] = (k * 37) % 256;
    const zOther = zMadOf(baseLib, otherBuf, 0, grayStats(otherBuf, 0).m, 1 / grayStats(otherBuf, 0).sd, 0);
    t.ok(zOther > zShift, '(b3) 无关图的 z-MAD 必须大于亮度漂移的同一张图');

    // ---------- (b4) 平坦页退回 raw MAD ----------
    const flatLib = synthLib(function () { return 128; });
    t.eq(flatLib.sd, 0, '(b4) 纯色图标准差为 0');
    t.eq(flatLib.linv[0], 0, '(b4) 平坦页不参与 z 归一化（linv=0）');
    const flatQ = Buffer.alloc(1024);
    for (let k = 0; k < 1024; k++) flatQ[k] = 100;
    t.eq(zMadOf(flatLib, flatQ, 0, 100, 0, 0), 28, '(b4) 平坦页退回 raw MAD（|100-128|=28）');
    t.eq(zMadOf(flatLib, flatQ, 0, 100, 1 / 10, 0), 28, '(b4) 查询侧平坦（qiv=0）同样退回 raw MAD');

    // ---------- (b5) recordOf 的覆盖率证据 ----------
    const recCov = recordOf(byId.get('分类A/未找到'), {
      pixelCount: 2, cover: { total: 2, exact: 0, pixel: 2, rescue: 1, cov1: 0.5, cov: 1, globalRatio: 1 }
    });
    t.eq(recCov.judge, '同图不同编码', '(b5) 带 cover 时用覆盖率口径判定');
    t.ok(recCov.coverage && recCov.coverage.rescue === 1, '(b5) 记录里保留救援张数');
    t.eq(recCov.coverage.cov, 1, '(b5) 记录里保留最终覆盖率');
    const recNoCov = recordOf(byId.get('分类A/未找到'), { pixelCount: 2 });
    t.eq(recNoCov.judge, '同图不同编码', '(b5) 没有 cover 时退回旧口径（2/2 命中）');
    t.eq(recNoCov.coverage, null, '(b5) 无覆盖率证据时 coverage 为 null');

    // ---------- (b6) 源码契约 ----------
    const matchSrc = fs.readFileSync(path.join(pathRepo, 'src', 'modules', 'dedupe', 'engine', 'match.mjs'), 'utf8');
    // 像素比对本体已从 match.mjs 拆到 pixel-search.mjs，契约按「检索底层 + 比对本体」两份合起来断言
    const pixelSrc = fs.readFileSync(path.join(pathRepo, 'src', 'modules', 'dedupe', 'engine', 'pixel-search.mjs'), 'utf8');
    const pixelEngineSrc = matchSrc + pixelSrc;
    const scanSrc = fs.readFileSync(path.join(pathRepo, 'src', 'modules', 'dedupe', 'engine', 'scan.mjs'), 'utf8');
    t.ok(pixelEngineSrc.indexOf('const v = zMadOf(lib, buf, off, qm, qiv, i);') >= 0, '(b6) 精算必须用 z-MAD，不许退回 raw MAD');
    t.ok(matchSrc.indexOf('zMadOf') >= 0 && matchSrc.indexOf('searchZRange') >= 0, '(b6) match.mjs 暴露 z-MAD 搜索');
    t.ok(pixelEngineSrc.indexOf('judgeCoverage') >= 0, '(b6) 像素阶段必须走覆盖率口径');
    t.ok(pixelEngineSrc.indexOf('cover.cov1 >= RESCUE_MIN') >= 0, '(b6) 救援必须带 cov1 守卫');
    t.ok(scanSrc.indexOf('o.cover ? judgeCoverage(o.cover) : judgeOf') >= 0, '(b6) recordOf 按 cover 是否存在切换口径');
    t.log('(b) 判定边界与覆盖率口径断言完成');

    // ---------- (b7) 前端决策落盘竞态的产品侧契约 ----------
    // 真浏览器验收实测：点完「确认重复（可删）」后马上点「执行删除…」，弹窗会在决策
    // 还没落盘时读候选数据 → 「下一步」按钮被禁用（next=disabled）。修法是保存挂起的
    // 落盘任务、openDelete 先 await 它。这里是那两处的最小静态契约，防止被改回去。
    // 查重前端已按职责拆成多个文件（dedupe.js 只做装配），所以这里扫整个 public/modules/dedupe*.mjs，
    // 而不是钉死单个文件 —— 否则一次纯搬运就会让契约假红。
    const dedupeWebDir = path.join(pathRepo, 'public', 'modules');
    const webDedupe = fs.readdirSync(dedupeWebDir)
      .filter(function (n) { return /^dedupe.*\.m?js$/.test(n); })
      .sort()
      .map(function (n) { return fs.readFileSync(path.join(dedupeWebDir, n), 'utf8'); })
      .join('\n/* ---- 文件分隔 ---- */\n');
    t.ok(webDedupe.indexOf('let pendingDecision = null;') >= 0, '(b7) 前端保存挂起的决策落盘任务');
    t.ok(webDedupe.indexOf('pendingDecision = task;') >= 0, '(b7) decideCand 把落盘任务挂到 pendingDecision');
    t.ok(webDedupe.indexOf('if (pendingDecision) { try { await pendingDecision; }') >= 0,
      '(b7) openDelete 必须先 await 挂起的决策落盘（否则按钮会被误禁用）');
    t.ok(webDedupe.indexOf('async function doDecide(item, verdict)') >= 0, '(b7) 落盘逻辑拆到 doDecide');

    // ---------- (c) safeJoin 越界拒绝 ----------
    t.ok(safeJoin(scan, '分类A/完全重复/001.jpg').startsWith(path.resolve(scan)), '(c) 正常相对路径可拼');
    await t.throwsAsync(async function () { safeJoin(scan, '../../windows/win.ini'); }, /越界/, '(c) .. 越界必须拒绝');
    await t.throwsAsync(async function () { safeJoin(scan, path.resolve(lib, 'x.jpg')); }, /越界/, '(c) 绝对路径越界必须拒绝');
    t.log('(c) safeJoin 用于 /api/dedupe/thumb 的 unit/side/name 三层校验');

    // ---------- (d) 删除前置校验 ----------
    const folders = recordLike([
      { id: '分类A/完全重复', dupDir: path.join(scan, '分类A', '完全重复') },
      { id: '越界单元', dupDir: path.join(lib, '漫画1', '第1话') }
    ]);
    await t.throwsAsync(async function () {
      validateDeleteRequest({ confirm: 'yes', unitIds: ['分类A/完全重复'], folders: folders, scanRoot: scan });
    }, /确认口令/, '(d) confirm 不是 DELETE 必须拒绝');
    await t.throwsAsync(async function () {
      validateDeleteRequest({ confirm: 'DELETEX', unitIds: ['分类A/完全重复'], folders: folders, scanRoot: scan });
    }, /确认口令/, '(d) confirm 近似但不等于 DELETE 必须拒绝');
    await t.throwsAsync(async function () {
      validateDeleteRequest({ confirm: ' 删除 ', unitIds: ['分类A/完全重复'], folders: folders, scanRoot: scan });
    }, /确认口令/, '(d) 中文口令必须拒绝');
    await t.throwsAsync(async function () {
      validateDeleteRequest({ confirm: '', unitIds: ['分类A/完全重复'], folders: folders, scanRoot: scan });
    }, /确认口令/, '(d) confirm 为空必须拒绝');
    await t.throwsAsync(async function () {
      validateDeleteRequest({ confirm: CONFIRM_WORD, unitIds: [], folders: folders, scanRoot: scan });
    }, /没有选择/, '(d) 空 unitIds 必须拒绝');
    await t.throwsAsync(async function () {
      validateDeleteRequest({ confirm: CONFIRM_WORD, unitIds: ['不存在的单元'], folders: folders, scanRoot: scan });
    }, /未找到单元/, '(d) 不在最近一次扫描结果里的 unitId 必须拒绝');
    await t.throwsAsync(async function () {
      validateDeleteRequest({ confirm: CONFIRM_WORD, unitIds: ['越界单元'], folders: folders, scanRoot: scan });
    }, /越界/, '(d) 越界 unitId（目录不在 scanRoot 内）必须拒绝');
    await t.throwsAsync(async function () {
      validateDeleteRequest({ confirm: CONFIRM_WORD, unitIds: ['分类A/完全重复'], folders: folders, scanRoot: scan, mode: 'purge' });
    }, /未知删除方式/, '(d) 未知 mode 必须拒绝');
    // 大小写与首尾空白不敏感（与原实现一致：界面要求手输 DELETE）
    const okCheck = validateDeleteRequest({ confirm: ' delete ', unitIds: ['分类A/完全重复'], folders: folders, scanRoot: scan });
    t.eq(okCheck.mode, 'recycle', '(d) 缺省 mode = recycle');
    t.eq(okCheck.ids.length, 1, '(d) 合法请求返回 1 个目标');
    t.eq(okCheck.targets[0].path, path.resolve(path.join(scan, '分类A', '完全重复')), '(d) 目标路径 = scanRoot/<id>');
    t.ok(fs.existsSync(okCheck.targets[0].path), '(d) 校验通过后目录仍然存在（校验阶段绝不删文件）');

    // ---------- (e) 决策持久化 ----------
    const paths = resolvePaths({ dedupe: { scanRoot: scan, libRoot: lib } }, path.join(root, 'data'));
    t.eq(await readDecisions(paths), {}, '(e) 初始决策为空对象');
    await setDecision(paths, '分类A/完全重复', 'keep', '标题重复，保留');
    await setDecision(paths, '分类A/未找到', 'delete', '库内没有');
    await setDecision(paths, '分类A/部分重复', 'pending');
    const back = await readDecisions(paths);
    t.eq(back['分类A/完全重复'].verdict, 'keep', '(e) keep 决策落盘');
    t.eq(back['分类A/完全重复'].note, '标题重复，保留', '(e) 备注落盘');
    t.eq(back['分类A/未找到'].verdict, 'delete', '(e) delete 决策落盘');
    t.eq(back['分类A/部分重复'].verdict, 'pending', '(e) pending 决策落盘');
    t.ok(/^\d{4}-/.test(back['分类A/完全重复'].updatedAt), '(e) 记录 updatedAt 时间戳');
    // 非法 verdict 应保持原值
    await setDecision(paths, '分类A/完全重复', 'hack', '试图越权');
    const back2 = await readDecisions(paths);
    t.eq(back2['分类A/完全重复'].verdict, 'keep', '(e) 非法 verdict 不会覆盖已有决策');
    t.eq(back2['分类A/完全重复'].note, '试图越权', '(e) 备注仍可更新');
    // ---------- (e2) 「已删除」决策必须真的落盘（白名单回归）----------
    // 根因之一：setDecision 的白名单只有 keep / delete / pending，setDecision(id, 'deleted')
    // 会被**静默降级**成上一次的 verdict，于是列表里永远没有「已删除」标记，也就永远过滤不掉。
    // 用户症状：在查重页删掉一批漫画后列表里它们还在，前端还去请求已经 404 的缩略图。
    await setDecision(paths, '分类A/未找到', 'deleted', '已执行删除（recycle）');
    const backDel = await readDecisions(paths);
    t.eq(backDel['分类A/未找到'].verdict, 'deleted', '(e2) deleted 决策必须落盘（不能被静默降级成 delete）');
    t.eq(backDel['分类A/未找到'].note, '已执行删除（recycle）', '(e2) deleted 决策的备注落盘');
    await setDecision(paths, '分类A/未找到', 'delete');

    t.ok(fs.existsSync(paths.decisionFile), '(e) decisions.json 落在 data/dedupe 下');
    t.ok(paths.decisionFile.startsWith(path.resolve(path.join(root, 'data'))), '(e) 产物目录在 data/dedupe 内');

    // 统计口径
    const scanObj = { generatedAt: '2024-01-01T00:00:00.000Z', units: [recFully, recPart, recNone] };
    const st = statsOf(scanObj, back2);
    t.eq(st.units, 3, '(e) 统计单元数');
    t.eq(st.byVerdict['完全重复'], 1, '(e) 统计完全重复');
    t.eq(st.byVerdict['部分重复'], 1, '(e) 统计部分重复');
    t.eq(st.byVerdict['未找到'], 1, '(e) 统计未找到');
    t.eq(st.decisions.keep, 1, '(e) 统计已保留');
    t.eq(st.decisions.delete, 1, '(e) 统计待删除');
    t.ok(st.reclaimableBytes >= 0, '(e) 统计可清理体积');

    // ---------- (f) 删除执行器：目标目录消失时的语义 ----------
    // 背景（用户报「网页端执行删除没成功」）：扫描后目录被人工删掉/移走时，
    // 旧实现会把清单照旧交给 PowerShell，脚本逐条报失败，用户只看到一句「删除失败」。
    // 现在改为执行前真实探测：默认拒绝并给出准确原因，allowMissing 时按跳过处理。
    const delPaths = resolvePaths({ dedupe: { scanRoot: scan } }, path.join(root, 'data2'));
    const ghost = { id: '分类A/幽灵单元', dupDir: path.join(scan, '分类A', '幽灵单元') };
    t.ok(!fs.existsSync(ghost.dupDir), '(f) 前置：幽灵单元目录确实不存在');
    let ghostErr = null;
    try {
      await executeDelete(delPaths, {
        confirm: CONFIRM_WORD, mode: 'quarantine', unitIds: [ghost.id], folders: [ghost]
      });
    } catch (e) { ghostErr = e; }
    t.ok(ghostErr && /已不存在/.test(ghostErr.message), '(f) 目标目录不存在时必须拒绝并说明原因（而不是交给脚本逐条失败）');
    t.eq(ghostErr && ghostErr.statusCode, 400, '(f) 该拒绝是 400（请求问题，不是服务器错误）');

    if (shellExe()) {
      const skipEntry = await executeDelete(delPaths, {
        confirm: CONFIRM_WORD, mode: 'quarantine', unitIds: [ghost.id], folders: [ghost], allowMissing: true
      });
      t.eq(skipEntry.skippedTotal, 1, '(f) allowMissing 时缺失目标记入 skipped');
      t.eq(skipEntry.ok, 0, '(f) 跳过项不计入成功数（避免成功数虚高）');
      t.eq(skipEntry.failed, 0, '(f) 跳过项不算失败');
      t.eq(skipEntry.skipped[0], ghost.id, '(f) skipped 里带上单元 id，便于前端提示');
    } else {
      t.log('(f) 未找到 PowerShell，跳过 allowMissing 执行路径断言');
    }

    // ---------- (g) 真实 HTTP 路由：删除后 /api/dedupe/units 不再返回该单元 ----------
    // 背景（用户报「查重删除后前端仍展示已删除的漫画」）：磁盘已经删掉、缩略图全部 404
    // （GET /api/dedupe/thumb ... -> 文件不存在），但列表数据里单元还在，前端仍在渲染。
    // 离线函数断言覆盖不到这条链，这里起真服务走真路由（listen(0) 随机端口，绝不碰 8775）：
    //   扫描 -> 列表 -> 删除 -> 列表（必须不含）-> 直接读 scan-latest.json -> decisions.json
    const httpRoot = path.join(root, 'http');
    const httpScan = path.join(httpRoot, '扫描');
    const httpLib = path.join(httpRoot, '库');
    const httpData = path.join(httpRoot, 'data');
    fakeJpg(path.join(httpScan, '分类A', '要删的单元', '001.jpg'), 'H1');
    fakeJpg(path.join(httpScan, '分类A', '要删的单元', '002.jpg'), 'H2');
    fakeJpg(path.join(httpScan, '分类A', '保留的单元', '003.jpg'), 'H3');
    fakeJpg(path.join(httpLib, '漫画1', '第1话', '001.jpg'), 'H1');
    const httpPaths = resolvePaths({
      dedupe: { scanRoot: httpScan, libRoots: [{ id: 'lib1', name: '测试库', path: httpLib }], pixelReview: false }
    }, httpData);
    const httpCfg = {
      port: 0, logLevel: 'error',
      libraryRoots: [{ id: 'lib1', name: '测试库', path: httpLib, enabled: true }],
      dedupe: { scanRoot: httpScan, libRoots: [{ id: 'lib1', name: '测试库', path: httpLib }], pixelReview: false }
    };
    const dedupeMod = await import('../src/modules/dedupe/index.mjs');
    const app = createApp({ log: createLogger('dedupe-http-test', 'error'), accessLog: false });
    await dedupeMod.register(app, {
      config: httpCfg,
      log: createLogger('dedupe-http-test', 'error'),
      projectRoot: pathRepo,
      dataDir: httpData,
      moduleId: 'dedupe',
      reloadConfig: async function () { return httpCfg; },
      saveConfig: async function () { return httpCfg; }
    });
    const server = app.createServer();
    try {
      await new Promise(function (res, rej) { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
      const H = 'http://127.0.0.1:' + server.address().port;
      async function api(p, opts) {
        const o = opts || {};
        const init = { method: o.method || 'GET', headers: {} };
        if (o.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
        const res = await fetch(H + p, init);
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
        return { status: res.status, data: data, text: text };
      }

      // (g1) 扫描并等到单元列表就绪
      const scanStart = await api('/api/dedupe/scan', { method: 'POST', body: { stage: 'hash', rebuildFp: false } });
      t.ok(scanStart.status === 200 && scanStart.data && scanStart.data.ok === true, '(g1) POST /api/dedupe/scan 能启动哈希扫描');
      let first = null;
      const waitStart = Date.now();
      while (Date.now() - waitStart < 90000) {
        const r0 = await api('/api/dedupe/units?size=100');
        if (r0.data && Array.isArray(r0.data.units) && r0.data.units.length >= 2) { first = r0.data; break; }
        await new Promise(function (r) { setTimeout(r, 400); });
      }
      t.ok(Boolean(first), '(g1) 扫描完成后列表返回单元（超时 90s）');
      if (!first) throw new Error('扫描没有产出单元，后续 HTTP 断言无法进行');
      const firstIds = first.units.map(function (u) { return u.id; });
      t.eq(first.units.length, 2, '(g1) 扫描后列表有 2 个单元');
      const victim = first.units.find(function (u) { return u.id.indexOf('要删的单元') >= 0; });
      t.ok(Boolean(victim), '(g1) 列表里能找到要删的目标单元');

      // (g2) 删除前先确认 scan-latest.json 里确实有它（否则「删除后消失」可以靠它本来就不在来蒙混过关）
      const beforeRaw = JSON.parse(await fsp.readFile(httpPaths.scanFile, 'utf8'));
      t.ok(beforeRaw.units.some(function (u) { return u.id === victim.id; }), '(g2) 前置：删除前 scan-latest.json 里目标单元还在');

      // (g3) 执行删除（quarantine：隔离区在数据目录内，天然安全，不依赖回收站组件）
      const del = await api('/api/dedupe/delete', {
        method: 'POST', body: { unitIds: [victim.id], mode: 'quarantine', confirm: 'DELETE' }
      });
      t.ok(del.data && del.data.ok === true && del.data.succeeded === 1, '(g3) 删除接口成功删掉 1 个单元');
      t.eq(del.data && del.data.removedFromScan, 1, '(g3) 删除响应带回 removedFromScan=1');
      t.ok(!fs.existsSync(path.join(httpScan, '分类A', '要删的单元')), '(g3) 磁盘上目标目录确实已消失');

      // (g4) ★核心验收★ 删除后列表不再返回该单元（走真实 HTTP 路由）
      const after = (await api('/api/dedupe/units?size=100')).data;
      const afterIds = (after.units || []).map(function (u) { return u.id; });
      t.ok(afterIds.indexOf(victim.id) < 0, '(g4) ★删除后 /api/dedupe/units 不再返回该单元（实际剩余：' + afterIds.join(' | ') + '）');
      t.eq(afterIds.length, 1, '(g4) 删除后列表只剩 1 个单元');
      t.ok(afterIds[0].indexOf('保留的单元') >= 0, '(g4) 剩下的是未被删除的单元');
      t.eq(after.total, 1, '(g4) 删除后 total 同步减少');
      t.eq(after.stats && after.stats.units, 1, '(g4) 删除后 stats.units 同步减少');
      const stateAfter = (await api('/api/dedupe/state')).data;
      t.eq(stateAfter && stateAfter.stats && stateAfter.stats.units, 1, '(g4) /api/dedupe/state 的 stats.units 也同步减少');
      const statsAfter = (await api('/api/dedupe/stats')).data;
      t.eq(statsAfter && statsAfter.stats && statsAfter.stats.units, 1, '(g4) /api/dedupe/stats 的 stats.units 也同步减少');

      // (g5) 磁盘证据：scan-latest.json 真的被回写，decisions.json 里有 deleted 标记
      const afterRaw = JSON.parse(await fsp.readFile(httpPaths.scanFile, 'utf8'));
      t.ok(afterRaw.units.every(function (u) { return u.id !== victim.id; }), '(g5) scan-latest.json 的 units 里不再有该单元');
      t.ok(Boolean(afterRaw['删除回写']), '(g5) scan-latest.json 写入删除回写字段');
      t.ok(Boolean(afterRaw['删除回写'] && (afterRaw['删除回写'].ids || []).indexOf(victim.id) >= 0), '(g5) 删除回写里带上了被摘除的 id');
      const decAfter = await readDecisions(httpPaths);
      t.eq(decAfter[victim.id] && decAfter[victim.id].verdict, 'deleted', '(g5) decisions.json 里该单元标记为 deleted');

      // (g6) 已删单元的缩略图：路由不再把它当有效单元（用户日志里那批 404 的根源）
      const thumbRes = await fetch(H + '/api/dedupe/thumb?unit=' + encodeURIComponent(victim.id) + '&side=dup&name=001.jpg');
      t.eq(thumbRes.status, 404, '(g6) 已删单元的缩略图返回 404');
      const thumbText = await thumbRes.text();
      t.ok(thumbText.indexOf('单元不存在') >= 0, '(g6) 缩略图报「单元不存在」而不是「文件不存在」（说明单元已不在扫描结果里）');

      // (g7) deleted=1 的语义必须说清楚：它只放开「已删除标记」这一层过滤，
      //      并不能把已经从 scan-latest.json 里摘掉的单元变回来（数据源里本来就没有了）。
      //      真正依赖它兜底的是「回写失败、scan 里残留 + 决策标 deleted」的单元，见 (g8)。
      const withDeleted = (await api('/api/dedupe/units?size=100&deleted=1')).data;
      const withIds = (withDeleted.units || []).map(function (u) { return u.id; });
      t.ok(withIds.indexOf(victim.id) < 0, '(g7) 已被回写摘除的单元在 deleted=1 下也不出现（scan 里已无此单元）');
      t.eq(withDeleted.total, 1, '(g7) deleted=1 时 total 仍与可见单元数一致');
      const plainAgain = (await api('/api/dedupe/units?size=100')).data;
      t.ok((plainAgain.units || []).every(function (u) { return u.id !== victim.id; }), '(g7) 不带 deleted 时同样不返回该单元');

      // (g8) ★兜底口径★ 即使 scan-latest.json 里残留该单元（回写失败 / 旧扫描结果 / 文件被占用），
      //      只要决策标记是 deleted，列表也必须不返回它 —— 这条保证「删除一定看得见」。
      const residual = Object.assign({}, victim, { id: '分类A/残留单元', name: '残留单元' });
      const patched = Object.assign({}, afterRaw, { units: afterRaw.units.concat([residual]) });
      await fsp.writeFile(httpPaths.scanFile, JSON.stringify(patched), 'utf8');
      await setDecision(httpPaths, residual.id, 'deleted', '模拟回写失败后的残留');
      const residueList = (await api('/api/dedupe/units?size=100')).data;
      t.ok((residueList.units || []).every(function (u) { return u.id !== residual.id; }), '(g8) ★scan 里残留但已标记 deleted 的单元也不返回');
      t.eq(residueList.total, 1, '(g8) 残留单元不计入 total');
      t.eq(residueList.stats && residueList.stats.units, 1, '(g8) 残留单元不计入 stats.units');
      const residueOpen = (await api('/api/dedupe/units?size=100&deleted=1')).data;
      t.ok((residueOpen.units || []).some(function (u) { return u.id === residual.id; }), '(g8) 残留单元在 deleted=1 下可见（诊断）');

      // (g10) ★候选复核的抽样图★ 只跑过快速查重（scan-fast.json）时，缩略图路由也必须认得单元。
      //       用户只跑快速模式时，候选卡片会张张显示「图片读取失败」—— 这不是报错而是静默降级，
      //       前端看起来就是「查重坏了」，所以必须用断言钉住。
      const fastUnitDir = path.join(httpScan, '分类A', '快速单元');
      fakeJpg(path.join(fastUnitDir, '101.jpg'), 'H9');
      const fastDoc = {
        generatedAt: new Date().toISOString(), stage: 'fast',
        units: [{
          id: '分类A/快速单元', name: '快速单元', dupDir: fastUnitDir,
          samples: [{ dup: '101.jpg', lib: '', root: '', exact: false, mad: null }],
          matches: []
        }]
      };
      await fsp.mkdir(httpPaths.root, { recursive: true });
      await fsp.writeFile(path.join(httpPaths.root, 'scan-fast.json'), JSON.stringify(fastDoc), 'utf8');
      const fastThumb = await fetch(H + '/api/dedupe/thumb?unit=' + encodeURIComponent('分类A/快速单元') + '&side=dup&name=101.jpg');
      t.eq(fastThumb.status, 200, '(g10) ★只存在于 scan-fast.json 的单元，缩略图也能取到（200）');
      const fastBody = await fastThumb.arrayBuffer();
      // 夹具是极小的假 JPEG（几十字节），所以判据用「与原文件等长」而不是随便一个阈值。
      const fastSrcSize = (await fsp.stat(path.join(fastUnitDir, '101.jpg'))).size;
      t.ok(fastBody.byteLength === fastSrcSize, '(g10) 缩略图返回的正是该图的字节（' + fastBody.byteLength + 'B = 原图）');
      const fastDetail = await fetch(H + '/api/dedupe/unit/' + encodeURIComponent('分类A/快速单元'));
      t.eq(fastDetail.status, 200, '(g10) 快速单元也能打开详情（并排看全图的入口）');
      const fastCands = (await api('/api/dedupe/candidates')).data;
      const fastCand = (fastCands.candidates || []).find(function (x) { return (x.unit && x.unit.id) === '分类A/快速单元'; });
      t.ok(Boolean(fastCand), '(g10) 该单元出现在候选复核列表里');
      t.ok(Boolean(fastCand && (fastCand.samples || []).length), '(g10) 候选卡片带出了抽样图地址（不是空数组）');
      await fsp.rm(path.join(httpPaths.root, 'scan-fast.json'), { force: true });

      // (g9) 收尾：runner 是模块级单例，run-tests 又在同一个进程里按文件顺序跑，
      //      不主动中止就会带着后台扫描进入后面的用例（桌面端/集成）造成跨文件串扰。
      const aborted = await api('/api/dedupe/scan/abort', { method: 'POST', body: {} });
      t.ok(aborted.status === 200 && aborted.data && aborted.data.ok === true, '(g9) 用例结束前主动中止扫描，避免影响同进程后续用例');
      // 给 runner 一点时间把子进程收干净（abort 是异步的，不等它就可能留下句柄）
      await new Promise(function (r) { setTimeout(r, 800); });
    } finally {
      try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (e) { /* 忽略 */ }
      await new Promise(function (r) { server.close(function () { r(); }); });
    }

    t.log('样本目录: ' + root);
  } finally {
    // 清理本次测试造出来的临时样本（只在 os.tmpdir() 内）
    try { await fsp.rm(root, { recursive: true, force: true }); } catch (e) { t.log('临时目录清理失败: ' + e.message); }
  }
}

/** 只保留 id / dupDir 两个字段（模拟扫描结果 units 的必需字段）。 */
function recordLike(list) {
  const out = [];
  for (const item of list) out.push({ id: item.id, dupDir: item.dupDir });
  return out;
}
