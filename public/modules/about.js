export const meta = { id: 'about', name: '关于', order: 90 };

export async function mount(root, ctx) {
  const el = ctx.el;
  ctx.title('关于漫库', '架构 / 来源 / 边界');
  let sys = null;
  try { sys = await ctx.get('/api/system/info'); } catch (e) { /* 离线也能看 */ }
  const mods = (sys && sys.modules) || [];

  const sources = [
    ['查重子模块', '拆解自本机 picacg处理/查重模块：单元发现 · SHA-256 字节查重 · 32×32 灰度指纹全库像素搜索 · 人工审核台 · 安全删除/还原', 'layers'],
    ['下载子模块', '复刻 github.com/lanyeeee/picacomic-downloader：登录 · 搜索 · 收藏同步 · 章节并发下载 · 断点续传 · 导出 ZIP/CBZ · 代理模式', 'download'],
    ['漫画库 / 阅读器 / vault', '漫库自研：多库根索引 · 封面与图片服务 · 日漫从右往左阅读 · 标签体系 · 批量整理 · 校验修复 · 回收站', 'book']
  ];
  const boundaries = [
    '服务只监听 127.0.0.1，不对外网开放；桌面窗口只是本地内核的壳',
    '所有由请求参数拼出的路径都过 safeJoin / ownerRootOf，越界一律 400',
    '图片接口要求文件名属于该章节清单，杜绝任意文件读取',
    '哔咔 token 只存后端，前端仅拿到 hasToken 与预览串',
    '删除类操作必须明确确认（查重需手输 DELETE），默认进隔离目录 / 回收站，可还原',
    '零第三方依赖：全项目只 import Node 标准库与相对路径'
  ];
  const keys = [
    ['Ctrl+K', '命令面板'], ['Ctrl+1…9', '切换模块'], ['Ctrl+R', '重新加载当前页'],
    ['/', '聚焦搜索框'], ['Esc', '关闭浮层 / 退出阅读'],
    ['← →', '阅读器翻页（随日漫方向自动反向）'], ['空格', '下一页'],
    ['M / F / R / T', '模式 / 适应 / 方向 / 缩略图'], ['Enter', '全屏']
  ];

  root.appendChild(el('div', { class: 'page' }, [
    el('div', { class: 'page-head' }, [
      el('div', { class: 'col' }, [
        el('h2', { class: 'page-title misprint', text: '漫库 MangaVault' }),
        el('div', { class: 'page-sub', text: '本地漫画中枢 · 管理 / 阅读 / 下载 / 查重 · 零第三方依赖' })
      ]),
      el('div', { class: 'row gap-6' }, [el('span', { class: 'stamp', text: 'v2 RISOPRINT' })])
    ]),
    el('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' } }, [
      el('div', { class: 'card card-pad col gap-8' }, [
        el('div', { class: 'section-title', text: '01 — 模块来源' }),
        el('div', { class: 'col gap-8' }, sources.map(function (s) {
          return el('div', { class: 'row gap-10', style: { alignItems: 'flex-start' } }, [
            el('span', { class: 'riso-red', style: { marginTop: '2px' } }, [ctx.icon(s[2])]),
            el('div', { class: 'col' }, [el('div', { style: { fontWeight: '650' }, text: s[0] }), el('div', { class: 'small muted', text: s[1] })])
          ]);
        }))
      ]),
      el('div', { class: 'card card-pad col gap-8' }, [
        el('div', { class: 'section-title', text: '02 — 运行信息' }),
        el('div', { class: 'ledger' }, [
          kv('版本', '1.0.0'), kv('Node', sys ? sys.node : '—'), kv('平台', sys ? sys.platform : '—'),
          kv('进程', sys ? sys.pid : '—'), kv('启动于', ctx.fmt.date(sys ? sys.startedAt : null)),
          kv('运行时长', ctx.fmt.dur(sys ? sys.uptimeMs : 0)),
          kv('配置', sys ? sys.configFile : '—'), kv('数据', sys ? sys.dataDir : '—')
        ]),
        el('div', { class: 'rule' }),
        el('div', { class: 'section-title', text: '模块' }),
        el('div', { class: 'col gap-6' }, mods.map(function (m) {
          return el('div', { class: 'col gap-4' }, [
            el('div', { class: 'row between gap-8' }, [
              el('div', { class: 'row gap-8' }, [
                el('span', { class: 'badge ' + (m.ok ? 'badge-ok' : 'badge-err'), text: m.ok ? 'ok' : 'err' }),
                el('span', { text: m.name || m.id })
              ]),
              el('span', { class: 'label-mono', text: (m.routes && m.routes.length ? m.routes.length + ' 接口' : '') })
            ]),
            m.error ? el('div', { class: 'small riso-red', text: m.error }) : null,
            (m.routes && m.routes.length) ? el('div', { class: 'mono small muted', style: { maxHeight: '76px', overflow: 'auto', whiteSpace: 'pre-wrap' }, text: m.routes.join('\n') }) : null
          ]);
        }))
      ]),
      el('div', { class: 'card card-pad col gap-8' }, [
        el('div', { class: 'section-title', text: '03 — 安全边界' }),
        el('div', { class: 'col gap-6' }, boundaries.map(function (t) {
          return el('div', { class: 'row gap-6', style: { alignItems: 'flex-start' } }, [
            el('span', { class: 'riso-cyan', style: { marginTop: '2px' } }, [ctx.icon('check')]),
            el('span', { class: 'small muted', text: t })
          ]);
        }))
      ]),
      el('div', { class: 'card card-pad col gap-8' }, [
        el('div', { class: 'section-title', text: '04 — 快捷键' }),
        el('div', { class: 'ledger' }, keys.map(function (k) {
          return el('div', { class: 'ledger-row' }, [el('span', { class: 'kbd', text: k[0] }), el('span', { class: 'd' }), el('span', { class: 'v', text: k[1] })]);
        }))
      ])
    ]),
    el('div', { class: 'alert alert-info', style: { marginTop: '14px' } }, [
      ctx.icon('info'),
      el('span', { text: '仅供个人本地资料管理使用；请遵守你所在地区的法律法规与内容平台条款。' })
    ])
  ]));

  function kv(k, v) {
    return el('div', { class: 'ledger-row' }, [el('span', { class: 'k', text: k }), el('span', { class: 'd' }), el('span', { class: 'v ellipsis', text: String(v === undefined || v === null ? '—' : v) })]);
  }
}
