import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { JsonStore } from '../../core/store.mjs';
import { readJson, atomicWriteJson } from '../../core/util.mjs';
import { dataDir } from '../../core/config.mjs';

/**
 * 登录态与账号缓存。
 *
 * 安全说明（写清楚，不假装是加密）：
 *   remember 保存的密码用 AES-256-GCM 加密，但密钥由本机信息派生并硬编码在同一份代码里，
 *   任何能读到本文件的人都能解出来 —— 所以它只是「可逆混淆」，防的是误看，不防有心的本机程序。
 *   文件里也写了同样的提示。仅绑定 127.0.0.1，不对外。
 */

const CREDS_FILE = 'download-credentials.json';
const ACCOUNT_FILE = 'download-account.json';

const NOTE = '本文件保存哔咔登录信息（本机明文可解：AES-256-GCM + 本机派生密钥，仅作可逆混淆，不是安全加密）。服务只监听 127.0.0.1，请勿把此文件复制到其它机器。';

/** 派生本机密钥（同一台机器稳定，换机就解不开，属于预期行为）。 */
function deriveKey() {
  const seed = [os.hostname(), os.platform(), os.arch(), os.userInfo && (os.userInfo().username || '')].join('|');
  return crypto.createHash('sha256').update('mangavault-download-remember::' + seed).digest();
}

/** 混淆（可逆）：AES-256-GCM，返回 base64(iv|tag|cipher)。 */
export function obfuscate(plain) {
  const text = String(plain === undefined || plain === null ? '' : plain);
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString('base64');
}

/** 反混淆；解不开返回空串（换机器/文件被改）。 */
export function deobfuscate(payload) {
  try {
    const raw = Buffer.from(String(payload || ''), 'base64');
    if (raw.length < 29) return '';
    const iv = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const data = raw.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

let credsStore = null;
let accountStore = null;

/** 凭据存储（惰性创建，便于单测用 MV_DATA_DIR 指到临时目录）。 */
export function creds() {
  if (!credsStore) credsStore = new JsonStore(CREDS_FILE, { note: NOTE, credentials: [] });
  return credsStore;
}

/** 账号缓存存储。 */
export function account() {
  if (!accountStore) accountStore = new JsonStore(ACCOUNT_FILE, { account: null, tokenCheckedAt: null, tokenOk: false });
  return accountStore;
}

/** 重置缓存（单测/切换数据目录时用）。 */
export function resetStores() {
  credsStore = null;
  accountStore = null;
}

export async function loadCreds() {
  const s = creds();
  await s.load();
  if (!s.data || typeof s.data !== 'object') s.data = { note: NOTE, credentials: [] };
  if (!Array.isArray(s.data.credentials)) s.data.credentials = [];
  if (!s.data.note) s.data.note = NOTE;
  return s.data;
}

/** 记住某个账号的密码（可逆混淆）。 */
export async function rememberCredential(email, password) {
  const data = await loadCreds();
  const key = String(email || '').trim();
  if (!key) throw new Error('邮箱不能为空');
  const list = data.credentials.filter(function (c) { return c.email !== key; });
  list.push({ email: key, password: obfuscate(password), savedAt: new Date().toISOString() });
  data.credentials = list;
  creds().markDirty();
  await creds().flush();
  return { email: key, hasPassword: true };
}

/** 读取记住的密码（没有返回空串）。 */
export async function recallCredential(email) {
  const data = await loadCreds();
  const key = String(email || '').trim();
  const hit = data.credentials.filter(function (c) { return c.email === key; })[0];
  if (!hit) return '';
  return deobfuscate(hit.password);
}

/** 列出记住的账号（只回 email 与是否有密码，不回密码）。 */
export async function listCredentials() {
  const data = await loadCreds();
  return data.credentials.map(function (c) {
    return { email: c.email, hasPassword: Boolean(c.password), savedAt: c.savedAt || null };
  });
}

/** 删除记住的账号。 */
export async function forgetCredential(email) {
  const data = await loadCreds();
  if (email) {
    data.credentials = data.credentials.filter(function (c) { return c.email !== String(email).trim(); });
  } else {
    data.credentials = [];
  }
  creds().markDirty();
  await creds().flush();
  return listCredentials();
}

/* ---------------- 账号缓存 ---------------- */

export async function loadAccount() {
  const s = account();
  await s.load();
  if (!s.data || typeof s.data !== 'object') s.data = { account: null, tokenCheckedAt: null, tokenOk: false };
  return s.data;
}

/**
 * 写入账号信息（登录/校验成功后调用）。
 * 形参**不能**叫 account：它会遮蔽模块级的 account() 访问器，
 * 让下面的 account().markDirty() 变成「把对象当函数调用」，
 * 抛 TypeError: account is not a function —— 登录路由因此 502（已踩过一次）。
 */
export async function saveAccount(profile, tokenOk) {
  const data = await loadAccount();
  data.account = profile || null;
  data.tokenCheckedAt = new Date().toISOString();
  data.tokenOk = tokenOk !== false;
  account().markDirty();
  await account().flush();
  return data.account;
}

/** 只更新时间戳（定期校验）。 */
export async function touchAccountCheck(tokenOk) {
  const data = await loadAccount();
  data.tokenCheckedAt = new Date().toISOString();
  data.tokenOk = Boolean(tokenOk);
  account().markDirty();
  await account().flush();
  return data;
}

/** 清空账号缓存与 token。 */
export async function clearAccount() {
  const data = await loadAccount();
  data.account = null;
  data.tokenCheckedAt = null;
  data.tokenOk = false;
  account().markDirty();
  await account().flush();
  return true;
}

/** 是否需要向上游重新校验（默认 10 分钟）。 */
export function needsRefresh(data, ttlMs) {
  const ttl = Number(ttlMs || 600000);
  if (!data || !data.tokenCheckedAt) return true;
  const ts = Date.parse(data.tokenCheckedAt);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > ttl;
}

/** 把 /users/profile 的响应规整成前端用的账号信息。 */
export function normalizeProfile(raw) {
  const u = (raw && raw.user) || raw || {};
  const avatar = u.avatar || {};
  return {
    id: String(u._id || u.id || ''),
    name: String(u.name || ''),
    email: String(u.email || ''),
    title: String(u.title || ''),
    level: Number(u.level || 0),
    exp: Number(u.exp || 0),
    role: String(u.role || ''),
    slogan: String(u.slogan || ''),
    gender: String(u.gender || ''),
    avatar: {
      path: String(avatar.path || ''),
      fileServer: String(avatar.fileServer || avatar.file_server || '')
    },
    characters: Array.isArray(u.characters) ? u.characters.slice(0, 8) : []
  };
}

export { NOTE as CREDENTIALS_NOTE };
