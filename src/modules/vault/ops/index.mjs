
/**
 * 管理操作层统一出口。
 * 原 ops.mjs 按能力拆到 ops/ 下，此文件保持对外 18 个导出名与顺序完全不变，
 * 路由层（src/modules/vault/index.mjs）只需把 './ops.mjs' 换成 './ops/index.mjs'。
 */
export { editMeta } from './meta.mjs';
export { planRename, applyRename } from './rename.mjs';
export { moveToRoot } from './move.mjs';
export { trashComics, listTrash, restoreTrash, purgeTrash } from './trash.mjs';
export { setCover } from './cover.mjs';
export { verifyComics, fixComics } from './verify.mjs';
export { duplicates } from './dupe.mjs';
export { stats, readingTime, readingStats } from './stats.mjs';
export { makeBackup, listBackups, restoreBackup } from './backup.mjs';

/* v4 新增：批量元数据、孤儿清理、撤销。
   barrel 是「管理操作层」的唯一出口，新增 ops 模块必须在这里转出，
   否则路由层 import 会直接抛 does not provide an export named —— 模块整体注册失败，
   表现为 /api/vault/* 全挂，但页面上看不出来（v4 真的踩到过）。 */
export { normalizeMetaPatch, planBatchMeta, applyBatchMeta, exportMetaPayload, importMetaPayload } from './meta-batch.mjs';
export { scanOrphans, triggerRescan, cleanOrphans, orphanBackupDir } from './orphan.mjs';
export { canUndo, undoLast, readArchive } from './undo.mjs';
