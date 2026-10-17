import { makeVaultKit } from './vault-kit.mjs';
import { makeTagsTabs } from './vault-tabs-tags.mjs';
import { makeMetaTabs } from './vault-tabs-meta.mjs';
import { makeMoveTabs } from './vault-tabs-move.mjs';
import { makeAuditTabs } from './vault-tabs-audit.mjs';
import { makeMiscTabs } from './vault-tabs-misc.mjs';

export const meta = { id: 'vault', name: '管理台', order: 30 };

/**
 * 管理台前端（RISOPRINT 体系）。
 *
 * 与后端 src/modules/vault/index.mjs 的路由一一对应；破坏性操作一律「先预演 → 用户确认 → 执行 → 可撤销」：
 *   标签墙     批量加/删标签（POST /api/vault/tags/assign，先传 dryRun:true 预演）
 *   批量元数据 作者 / 汉化组 / 简介 / 标签 / 分类（/api/vault/meta/plan → /api/vault/meta/batch）
 *   导出导入   /api/vault/meta/export（下载 JSON 文件）→ /api/vault/meta/import（先预演条数再确认）
 *   跨库搬迁   /api/vault/move/plan（展示重名冲突、跨盘、目标路径）→ /api/vault/move
 *   孤儿清理   /api/vault/orphans（扫描即预演）→ /api/vault/orphans/clean（二次确认 + 输入 CLEAN）
 *   审计与撤销 /api/vault/audit · /api/vault/audit/undoable · /api/vault/audit/undo · /api/vault/audit/archive/:id
 *
 * 约定：
 *   - 接口失败一律显示中文错误 + 「重试」按钮，**绝不静默退化成空数据**；
 *   - 所有可点控件带 data-act（与阅读器同一约定），测试不得用 nth-child 定位；
 *   - 不用模板字符串 / 两空格缩进 / 单引号 / 中文注释与文案。
 */
export async function mount(root, ctx) {
  const el = ctx.el;
  ctx.title('管理台', '标签 · 批量元数据 · 搬迁 · 孤儿 · 审计');

  const S = {
    tab: ctx.state.get('vault.tab', 'tags'),
    comics: [],
    tags: [],
    roots: [],
    sel: new Set(),
    loadError: null,
    // 预演签名：输入或选择一变，旧的预演就作废，必须重新预演才能执行
    tagPlanSig: '',
    metaPlanSig: '',
    movePlanSig: '',
    auditPage: 1,
    auditAction: ''
  };
  const host = el('div');

  const TABS = [
    ['tags', '标签墙', 'tag'],
    ['meta', '批量元数据', 'pencil'],
    ['move', '跨库搬迁', 'arrow-right'],
    ['orphans', '孤儿清理', 'alert'],
    ['audit', '审计与撤销', 'clock'],
    ['batch', '批量整理', 'scissors'],
    ['verify', '校验修复', 'shield'],
    ['trash', '回收站', 'archive'],
    ['stats', '统计', 'gauge'],
    ['shelves', '书架', 'bookmark'],
    ['backup', '备份', 'database']
  ];


  function switchTab(tab) {
    S.tab = tab;
    ctx.state.set('vault.tab', tab);
    const tabs = tabbar.querySelectorAll('.tab');
    for (const t of tabs) t.classList.toggle('active', t.dataset.tab === tab);
    render();
  }


  /* 装配顺序有讲究：kit 里的 refresh 会调 setSub，makePicker 会调 errBox/waiting/reloadComicsQuiet/row ——
     它们都在 makeVaultKit 同一个函数作用域里，天然可互相调用；页签组通过 deps.k 拿 kit 的出口。 */
  const kit = makeVaultKit(ctx, S, { el: el });
  const tagsTab = makeTagsTabs(ctx, S, { el: el, host: host, k: kit });
  const metaTab = makeMetaTabs(ctx, S, { el: el, host: host, k: kit });
  const moveTab = makeMoveTabs(ctx, S, { el: el, host: host, k: kit });
  const auditTab = makeAuditTabs(ctx, S, { el: el, host: host, k: kit });
  const miscTab = makeMiscTabs(ctx, S, { el: el, host: host, k: kit });

  const refresh = kit.refresh;
  const errBox = kit.errBox;
  const waiting = kit.waiting;
  const okBox = kit.okBox;
  const parseCsv = kit.parseCsv;
  const sigOf = kit.sigOf;
  const downloadJson = kit.downloadJson;
  const loadComics = kit.loadComics;
  const reloadComicsQuiet = kit.reloadComicsQuiet;
  const selectedIds = kit.selectedIds;
  const makePicker = kit.makePicker;
  const colorOf = kit.colorOf;
  const statCell = kit.statCell;
  const fld = kit.fld;
  const showTagComics = tagsTab.showTagComics;
  const renderTags = tagsTab.renderTags;
  const renderMeta = metaTab.renderMeta;
  const renderMove = moveTab.renderMove;
  const renderOrphans = moveTab.renderOrphans;
  const renderAudit = auditTab.renderAudit;
  const renderBatch = auditTab.renderBatch;
  const renderVerify = miscTab.renderVerify;
  const renderTrash = miscTab.renderTrash;
  const renderStats = miscTab.renderStats;
  const renderShelves = miscTab.renderShelves;
  const renderBackup = miscTab.renderBackup;
  const tabbar = el('div', { class: 'tabbar' }, TABS.map(function (t) {
    return el('div', {
      class: 'tab' + (S.tab === t[0] ? ' active' : ''),
      dataset: { tab: t[0], act: 'vault-tab' },
      on: { click: function () { switchTab(t[0]); } }
    }, [ctx.icon(t[2]), el('span', { text: t[1] })]);
  }));

  root.appendChild(el('div', { class: 'page' }, [
    el('div', { class: 'page-head' }, [
      el('div', { class: 'col' }, [
        el('h2', { class: 'page-title misprint', text: '管理台' }),
        el('div', { class: 'page-sub', id: 'mvVaultSub', text: '正在读取库目录…' })
      ]),
      el('div', { class: 'row gap-6' }, [
        el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'vault-refresh' }, on: { click: refresh }, title: '重新读取目录与标签' }, [ctx.icon('refresh'), el('span', { text: '刷新' })]),
        el('button', { class: 'btn btn-sm btn-ghost', dataset: { act: 'vault-quick-verify' }, on: { click: runVerifyQuick } }, [ctx.icon('shield'), el('span', { text: '快速体检' })])
      ])
    ]),
    tabbar,
    host
  ]));


  function editMeta(c) {
    const title = el('input', { class: 'input', value: c.title || '' });
    const author = el('input', { class: 'input', value: c.author || '' });
    const team = el('input', { class: 'input', value: c.chineseTeam || '' });
    const tags = el('input', { class: 'input', value: (c.tags || []).join(', '), placeholder: '逗号分隔' });
    const cats = el('input', { class: 'input', value: (c.categories || []).join(', '), placeholder: '逗号分隔' });
    const desc = el('textarea', { class: 'textarea', value: c.description || '' });
    const m = ctx.modal({
      title: '编辑元数据 · ' + c.title,
      body: el('div', { class: 'col gap-10' }, [
        el('div', { class: 'alert alert-warn' }, [ctx.icon('alert'), el('span', { class: 'grow', text: '会写入该漫画目录下的 元数据.json（原文件自动备份为 元数据.json.bak）。' })]),
        fld('标题', title), fld('作者', author), fld('汉化组', team),
        fld('标签', tags), fld('分类', cats), fld('简介', desc)
      ])
    });
    m.foot.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', on: { click: function () { m.close(); } } }));
    m.foot.appendChild(el('button', { class: 'btn btn-primary', text: '保存', on: { click: async function () {
      try {
        const r = await ctx.post('/api/vault/comic/' + encodeURIComponent(c.id) + '/meta', {
          title: title.value.trim(), author: author.value.trim(), chineseTeam: team.value.trim(),
          tags: parseCsv(tags.value), categories: parseCsv(cats.value), description: desc.value
        });
        ctx.toast(r.message, 'ok');
        m.close();
        invalidate();
        switchTab(S.tab);
      } catch (err) { ctx.toast('保存失败：' + err.message, 'err'); }
    } } }));
  }

  function invalidate() { ctx.post('/api/vault/refresh', {}).catch(function () {}); }

  async function runVerifyQuick() { switchTab('verify'); }

  async function render() {
    switch (S.tab) {
      case 'tags': return renderTags();
      case 'meta': return renderMeta();
      case 'move': return renderMove();
      case 'orphans': return renderOrphans();
      case 'audit': return renderAudit();
      case 'batch': return renderBatch();
      case 'verify': return renderVerify();
      case 'trash': return renderTrash();
      case 'stats': return renderStats();
      case 'shelves': return renderShelves();
      case 'backup': return renderBackup();
      default: return renderTags();
    }
  }

  await refresh();
  await render();
}