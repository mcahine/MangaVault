/**
 * 下载模块公共件（RISOPRINT 体系）。
 *
 * 搜索 / 收藏夹 / 排行榜 / 我的 / 下载任务五个页签共用同一套卡片外壳、失败态与排版小件。
 * 它们原本都在 mount() 闭包里，靠 el / api / ctx / state 工作；搬出来后由 makeDownloadShare(ctx, state, deps)
 * 的参数逐字提供，函数体一行未改（2 空格基准缩进保持不变）。
 */
export function makeDownloadShare(ctx, state, deps) {
  const el = deps.el;
  const api = deps.api;
  /* 详情弹窗 openComic 属于「搜索入库」页签，但卡片点击要用它。
     这里包一层延迟取值：装配时 deps.openComic 还没塞进来，调用时才读，
     避免为了一个回调把整个详情弹窗搬到公共层。 */
  function openComic(item) { return deps.openComic(item); }

  /** 任务状态的中文文案与徽章样式（与后端 state 取值一致）。 */
  const STATE_TEXT = {
    queued: '排队中', running: '下载中', paused: '已暂停', done: '已完成',
    error: '有错误', canceled: '已取消', removed: '已删除', pending: '待下载'
  };
  const STATE_BADGE = {
    queued: 'badge', running: 'badge badge-accent', paused: 'badge badge-warn',
    done: 'badge badge-ok', error: 'badge badge-err', canceled: 'badge', pending: 'badge'
  };

  /** 卡片分批渲染：首屏只挂这么多，其余按「加载更多」追加，避免一次 append 几百个节点。 */
  const CARD_BATCH = 24;
  /** 排行榜周期（与后端契约 tt 取值一致）。 */
  const RANK_LABELS = [['H24', '日榜'], ['D7', '周榜'], ['D30', '月榜']];
  /** 收藏排序（与后端契约 sort 取值一致）。 */
  const FAVORITE_SORTS = [['dd', '最新收藏'], ['da', '最早收藏']];

  /* ---------------- 共用：排版小工具 ---------------- */
  function textOf(v) {
    return v === undefined || v === null || v === '' ? '' : String(v);
  }

  function plural(n, unit) {
    return String(Number(n) || 0) + ' ' + unit;
  }

  /** 卡片副标题：能拿到什么就说什么，字段缺失不显示空壳。 */
  function comicSub(item) {
    const parts = [];
    if (textOf(item && item.author)) parts.push('作者 ' + item.author);
    if (item && item.chapterCount) parts.push(plural(item.chapterCount, '章'));
    if (item && item.likes) parts.push('♥ ' + ctx.fmt.num(item.likes));
    if (item && item.inLibrary) parts.push('已在库');
    return parts.join(' · ');
  }

  /** 中文可读的请求失败原因：优先用后端给的 error，再按 HTTP 状态码兜底。 */
  function errorMessage(err, fallback) {
    const msg = textOf(err && err.message ? err.message : err);
    const status = err && err.status ? Number(err.status) : 0;
    if (status === 404) return '接口还没就绪（HTTP 404）—— 该功能的后端路由可能尚未合入' + (msg ? '：' + msg : '');
    if (status === 401) return (msg || '未登录或登录已过期') + '（请在「我的」页签登录）';
    if (status >= 500) return '本地服务出错（HTTP ' + status + '）' + (msg ? '：' + msg : '');
    if (status === 0 && !msg) return fallback;
    return msg || fallback;
  }

  /** 接口返回 { code:'NOT_SUPPORTED' } 时的中文提示。 */
  function isNotSupported(err) {
    const data = err && err.data;
    return Boolean(err && err.status === 400 && data && data.code === 'NOT_SUPPORTED');
  }

  function isAuthError(err) {
    if (!err) return false;
    if (err.status === 401) return true;
    return /未登录|token 已失效|登录已过期|token 无效/.test(textOf(err.message));
  }

  /** 统一的「加载中」占位。 */
  function loadingBox(text) {
    return el('div', { class: 'empty' }, [el('div', { class: 'spinner spinner-lg' }), el('div', { class: 'small', text: text })]);
  }

  /** 统一的失败块：中文原因 + 重试按钮。 */
  function errorBox(title, message, onRetry) {
    const box = el('div', { class: 'alert alert-err mv-dl-error' }, [
      el('div', { class: 'col gap-6 grow' }, [
        el('div', { style: { fontWeight: '650' }, text: title }),
        el('div', { class: 'small', text: message })
      ]),
      el('button', { class: 'btn btn-sm btn-ghost', on: { click: onRetry } }, [ctx.icon('refresh'), el('span', { text: '重试' })])
    ]);
    return box;
  }

  /* ---------------- 卡片外壳（搜索 / 收藏夹 / 排行榜共用） ---------------- */
  /* 分批渲染器不直接绑定网格：网格由调用方建好后通过 setGrid() 注入，
     这样 mount 里可以先声明 const grid = ... 再调用 makeComicBoard，避免 TDZ。 */
  function makeComicBoard(options) {
    const o = options || {};
    const grid = el('div', { class: 'grid grid-cards' });
    const moreWrap = el('div', { class: 'row center mv-dl-more' });
    let items = [];
    let shown = 0;
    let onMore = null;
    /* 「服务端还有下一页」与「本地还有没渲染完的」是两件事，必须分开：
       上游一页给 30 条而首屏只挂 24 条，所以先本地点一下补到 30（appendBatch），
       本页补完（shown === items.length）才轮到「加载下一页」去翻服务端。
       两套分批混成一步就会出现：点加载更多 → 先补到 30 → 又拉第 2 页 → set() 从头重渲染 → 卡片回到 24。 */
    let serverMore = false;

    function renderMore() {
      moreWrap.textContent = '';
      const batch = o.batch || CARD_BATCH;
      if (items.length && shown < items.length) {
        const label = o.moreText ? o.moreText(items.length - shown) : '加载更多（还有 ' + (items.length - shown) + ' 部）';
        moreWrap.appendChild(el('button', {
          class: 'btn btn-ghost btn-sm',
          /* 只补本地尚未挂载的条目，不碰服务端分页 */
          on: { click: function () { appendBatch(batch); } }
        }, [ctx.icon('chevron-down'), el('span', { text: label })]));
        return;
      }
      if (serverMore && typeof onMore === 'function') {
        moreWrap.appendChild(el('button', {
          class: 'btn btn-ghost btn-sm',
          /* 本地都排完了，这时才去翻服务端下一页 */
          on: { click: function () { onMore(); } }
        }, [ctx.icon('chevron-down'), el('span', { text: '加载下一页' })]));
      }
    }

    function appendBatch(n) {
      const end = Math.min(items.length, shown + Math.max(1, n || CARD_BATCH));
      for (let i = shown; i < end; i++) grid.appendChild(comicCard(items[i]));
      shown = end;
      renderMore();
    }

    function clearGrid() {
      grid.textContent = '';
      moreWrap.textContent = '';
      shown = 0;
    }

    return {
      grid: grid,
      moreWrap: moreWrap,
      /** 用一批数据从头渲染。 */
      set: function (list, next) {
        items = Array.isArray(list) ? list : [];
        onMore = typeof next === 'function' ? next : null;
        clearGrid();
        if (!items.length) return;
        appendBatch(o.batch || CARD_BATCH);
      },
      /** 追加一批数据（翻页后调用），只对本次新增的项继续分批。 */
      add: function (list, next) {
        const more = Array.isArray(list) ? list : [];
        if (typeof next === 'function') onMore = next;
        if (!more.length) return;
        const from = items.length;
        items = items.concat(more);
        const end = Math.min(items.length, from + (o.batch || CARD_BATCH));
        for (let i = shown; i < end; i++) grid.appendChild(comicCard(items[i]));
        shown = end;
        renderMore();
      },
      showLoading: function (text) { clearGrid(); grid.appendChild(loadingBox(text)); },
      showError: function (title, message, onRetry) { clearGrid(); grid.appendChild(errorBox(title, message, onRetry)); },
      showEmpty: function (title, desc) { clearGrid(); grid.appendChild(ctx.empty(title, desc)); },
      /** 同步「服务端还有下一页」；调用方在拿到 page / pages 后设置。 */
      setServerMore: function (v) { serverMore = Boolean(v); renderMore(); },
      clear: clearGrid,
      count: function () { return items.length; },
      shown: function () { return shown; }
    };
  }

  /** RISOPRINT 风格的分段切换（用 chip 表达，不用胶囊圆角）。 */
  function makeChipGroup(options) {
    const o = options || {};
    const wrap = el('div', { class: 'row gap-6' });
    const nodes = [];
    let current = o.value;
    function paint() {
      for (const n of nodes) n.classList.toggle('active', n.__value === current);
    }
    for (const pair of o.options) {
      const node = el('div', {
        class: 'chip' + (pair[0] === current ? ' active' : ''),
        title: o.title || '',
        on: { click: function () { if (pair[0] === current) return; current = pair[0]; paint(); o.onChange(pair[0]); } }
      }, [el('span', { text: pair[1] })]);
      node.__value = pair[0];
      nodes.push(node);
      wrap.appendChild(node);
    }
    return {
      el: wrap,
      set: function (v) { current = v; paint(); },
      value: function () { return current; }
    };
  }

  /* ---------------- 封面与卡片 ---------------- */
  function coverPlaceholder(title) {
    return el('div', {
      style: { width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: 'linear-gradient(150deg,#1d2432,#0e1117)', color: 'var(--txt-3)', fontSize: '22px', fontWeight: '700' },
      text: String(title || '?').slice(0, 1)
    });
  }

  /* 判断「这是个能加载的封面地址」。
     ★ 不能用 url.indexOf('//') > 0 这种土办法：我们自己的封面代理地址形如
       /api/download/cover?path=https%3A%2F%2F...（内层 URL 被 encodeURIComponent 编码成 %2F%2F），
       字面上根本没有连续的 '//'，于是**所有卡片永远走占位分支**，
       搜索/收藏/排行榜三处一律只能看到「首字占位块」——表现为「封面全是占位图」。
       这里改成认绝对地址（http/https/协议相对）与站内绝对路径两种形态。 */
  function isCoverUrl(url) {
    const s = String(url || '');
    return /^https?:\/\//i.test(s) || /^\/\//.test(s) || /^\//.test(s);
  }

  function coverNode(title, url, onClick) {
    const wrap = el('div', { class: 'cover-wrap', on: onClick ? { click: onClick } : null });
    if (isCoverUrl(url)) {
      const img = el('img', { class: 'cover', loading: 'lazy', src: url, alt: title || '' });
      img.addEventListener('error', function () { img.remove(); wrap.appendChild(coverPlaceholder(title)); });
      wrap.appendChild(img);
    } else {
      wrap.appendChild(coverPlaceholder(title));
    }
    return wrap;
  }

  /** 唯一的漫画卡片渲染器：搜索 / 收藏夹 / 排行榜共用（契约要求形状一致）。 */
  function comicCard(item) {
    return el('div', { class: 'comic-card hoverable' }, [
      coverNode(item.title, item.cover, function () { openComic(item); }),
      el('div', { class: 'comic-body' }, [
        el('div', { class: 'comic-title', title: item.title, text: item.title || '(无标题)' }),
        el('div', { class: 'comic-author ellipsis', text: item.author || '未知作者' }),
        el('div', { class: 'row wrap gap-6', style: { marginTop: '4px' } }, [
          item.inLibrary
            ? el('span', { class: 'badge badge-ok', text: '已在库' })
            : el('span', { class: 'badge', text: (item.chapterCount || 0) + ' 章' }),
          item.finished ? el('span', { class: 'badge', text: '已完结' }) : null,
          item.likes ? el('span', { class: 'badge', text: '♥ ' + ctx.fmt.num(item.likes) }) : null
        ]),
        el('div', { class: 'row wrap gap-6', style: { marginTop: '4px' } }, (item.tags || []).slice(0, 4).map(function (t) {
          return el('span', { class: 'tag', text: t });
        })),
        el('div', { class: 'row gap-6', style: { marginTop: '8px' } }, [
          el('button', { class: 'btn btn-sm grow', on: { click: function (e) { e.stopPropagation(); openComic(item); } } }, [
            ctx.icon('list'), el('span', { text: '选择章节' })
          ]),
          item.inLibrary
            ? el('button', { class: 'btn btn-sm btn-ghost', title: '打开目录', on: { click: function (e) { e.stopPropagation(); openFolder(item); } } }, [ctx.icon('folder')])
            : null
        ])
      ])
    ]);
  }

  async function openFolder(item) {
    try {
      const r = await ctx.post('/api/download/open-folder', { comicId: item.id, title: item.title });
      ctx.toast(r.message || '已打开目录', 'ok');
    } catch (err) {
      ctx.toast('打开目录失败：' + err.message, 'err');
    }
  }

  return {
    textOf: textOf,
    plural: plural,
    comicSub: comicSub,
    errorMessage: errorMessage,
    isNotSupported: isNotSupported,
    isAuthError: isAuthError,
    loadingBox: loadingBox,
    errorBox: errorBox,
    coverPlaceholder: coverPlaceholder,
    isCoverUrl: isCoverUrl,
    coverNode: coverNode,
    comicCard: comicCard,
    openFolder: openFolder,
    makeComicBoard: makeComicBoard,
    makeChipGroup: makeChipGroup,
    STATE_TEXT: STATE_TEXT,
    STATE_BADGE: STATE_BADGE,
    CARD_BATCH: CARD_BATCH,
    RANK_LABELS: RANK_LABELS,
    FAVORITE_SORTS: FAVORITE_SORTS
  };
}
