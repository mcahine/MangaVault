
import { findComic } from '../catalog.mjs';

/** 抛带 HTTP 状态码的错误（框架会转成 JSON 错误） */
export function bad(code, msg) { return Object.assign(new Error(msg), { statusCode: code }); }

/** 按 id 取漫画，取不到抛 404（cfg 参数保留以兼容原调用） */
export function needComic(cfg, cat, id) {
  const c = findComic(cat, id);
  if (!c) throw bad(404, '漫画不存在：' + id);
  return c;
}
