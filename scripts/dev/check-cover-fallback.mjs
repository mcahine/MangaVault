#!/usr/bin/env node
/** 封面回落验证：用隔离数据目录起服务，确认裸形态库的封面真的能取到。
 *  只杀自己 spawn 的子进程，绝不按进程名杀（曾误杀宿主）。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = 8901;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-cover-'));

function get(url, binary) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, type: res.headers['content-type'], body: binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8') });
      });
    }).on('error', reject);
  });
}

const cfg = {
  port: PORT, host: "127.0.0.1", logLevel: "error",
  libraryRoots: [
    { id: "picacg", name: "picacg", path: "C:/Users/D-001/Desktop/黄漫/picacg漫画", enabled: true },
    { id: "early", name: "early", path: "C:/Users/D-001/Desktop/黄漫/先期漫画", enabled: true }
  ]
};
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(cfg, null, 2));

/* 复用真实索引，省去一次全库扫描（cover 是请求时计算的，修复立即生效）*/
const REAL_DATA = process.env.MV_REAL_DATA || path.join(process.env.LOCALAPPDATA || '', 'MangaVault');
const realIndex = path.join(REAL_DATA, 'library-index.json');
if (fs.existsSync(realIndex)) {
  fs.copyFileSync(realIndex, path.join(DATA, 'library-index.json'));
  console.log('  已复用真实索引: ' + realIndex);
} else {
  console.log('  未找到真实索引: ' + realIndex);
}

const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
  cwd: ROOT, stdio: "ignore",
  env: Object.assign({}, process.env, { MV_DATA_DIR: DATA })
});

let failed = 0;
function check(name, pass, detail) {
  console.log((pass ? "  PASS " : "  FAIL ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!pass) failed++;
}

try {
  const until = Date.now() + 45000;
  let ready = false;
  while (Date.now() < until) {
    try { const p = await get("http://127.0.0.1:" + PORT + "/api/ping"); if (p.status === 200) { ready = true; break; } } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 400); });
  }
  check("服务在 45s 内就绪", ready, "port=" + PORT);
  if (!ready) throw new Error("服务没起来");

  const list = await get("http://127.0.0.1:" + PORT + "/api/library/comics?root=early&size=60");
  const j = JSON.parse(list.body);
  console.log("  早期库总数=" + j.total + "，本页=" + j.items.length);
  const withCover = j.items.filter(function (x) { return x.cover; });
  check("裸形态库的漫画被标记为有封面", withCover.length > 0, withCover.length + "/" + j.items.length + " 部");
  const noMeta = j.items.filter(function (x) { return !x.hasMeta; });
  check("本页含无元数据的裸本（正是问题场景）", noMeta.length > 0, noMeta.length + " 部无元数据");

  const sample = withCover[0];
  if (sample) {
    const cov = await get("http://127.0.0.1:" + PORT + "/api/library/cover/" + encodeURIComponent(sample.id), true);
    check("封面接口返回 200", cov.status === 200, "status=" + cov.status);
    check("封面确实是图片", /^image\//.test(String(cov.type)), "type=" + cov.type);
    check("封面有实际字节", cov.body.length > 1000, cov.body.length + " bytes");
    const isJpg = cov.body[0] === 0xFF && cov.body[1] === 0xD8;
    const isPng = cov.body[0] === 0x89 && cov.body[1] === 0x50;
    check("是合法 JPEG/PNG 魔数", isJpg || isPng, isJpg ? "JPEG" : (isPng ? "PNG" : "unknown"));
    console.log("  样例：" + sample.title + "  images=" + sample.images);
  }
} catch (e) {
  check("整体流程", false, e.message);
} finally {
  try { child.kill(); } catch (e) {}
  await new Promise(function (r) { setTimeout(r, 600); });
  try { await fsp.rm(DATA, { recursive: true, force: true }); } catch (e) {
    await new Promise(function (r) { setTimeout(r, 300); });
    try { await fsp.rm(DATA, { recursive: true, force: true }); } catch (e2) {}
  }
}

console.log(failed ? ("结果: " + failed + " 条失败") : "结果: 全部通过");
process.exit(failed ? 1 : 0);