// 성경 사이트 – 아이디/비밀번호 로그인 + 세션 토큰 + 관리자/차단 공용 헬퍼
// POST { action: 'signup' | 'login', name, pw }
//
// 계정 = 유저별 개별 파일 bible/u/<해시>.json  (head()로 강한 일관성 존재 검사)
// 차단 = bible/ban/<해시>.json                (있으면 로그인/가입 불가)
// 관리자 = 아이디 'adminpig1234' 딱 하나
// 세션 토큰:  base64url(payload JSON) + "." + base64url(HMAC-SHA256(payload, SECRET))

const crypto = require('crypto');
const { put, head, del, list } = require('@vercel/blob');

const SESSION_TTL = 60 * 24 * 60 * 60; // 60일 (초)
const PW_SALT = 'bible-2026-salt';
const USER_DIR = 'bible/u/';
const BAN_DIR = 'bible/ban/';
const ADMIN_NAME = 'adminpig1234';
const ADMIN_SUB = 'local:' + ADMIN_NAME;

// ---- Blob ----
function blobStoreId() {
  const m = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([^_]+)_/);
  if (m) return m[1];
  return (process.env.BLOB_STORE_ID || '').replace(/^store_/, '');
}
function blobBase() {
  const id = blobStoreId();
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : '';
}
function nameHash(name) {
  return crypto.createHash('sha256').update(String(name).toLowerCase()).digest('hex').slice(0, 40);
}
function userFile(name) { return USER_DIR + nameHash(name) + '.json'; }
function banFile(name) { return BAN_DIR + nameHash(name) + '.json'; }

async function readJsonBlob(pathname) {
  let meta;
  try { meta = await head(pathname); } catch (e) { return null; }
  try {
    const r = await fetch(meta.url + (meta.url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function readUser(name) { return readJsonBlob(userFile(name)); }
function saveUser(name, obj, overwrite) {
  return put(userFile(name), JSON.stringify(obj), {
    access: 'public', addRandomSuffix: false, allowOverwrite: !!overwrite,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
  });
}
function hashPw(name, pw) {
  return crypto.createHash('sha256').update(name.toLowerCase() + ':' + pw + ':' + PW_SALT).digest('hex');
}

// ---- 관리자 / 차단 ----
function isAdmin(sess) { return !!(sess && sess.sub === ADMIN_SUB); }

async function isBanned(name) {
  if (String(name).toLowerCase() === ADMIN_NAME) return false;
  try { await head(banFile(name)); return true; } catch (e) { return false; }
}
function banName(name, byName) {
  if (String(name).toLowerCase() === ADMIN_NAME) return Promise.resolve();
  return put(banFile(name), JSON.stringify({ name: String(name), by: String(byName || ''), at: new Date().toISOString() }), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
  });
}
function unbanName(name) { return del(banFile(name)); }
async function listBanned() {
  let blobs = [];
  try { blobs = (await list({ prefix: BAN_DIR, limit: 1000 })).blobs || []; } catch (e) { return []; }
  const items = await Promise.all(blobs.map(async (b) => {
    try { const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' }); return r.ok ? await r.json() : null; }
    catch (e) { return null; }
  }));
  return items.filter(Boolean).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

// ---- 세션 토큰 ----
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const parts = [
    process.env.BLOB_WEBHOOK_PUBLIC_KEY,
    process.env.BLOB_STORE_ID,
    process.env.VERCEL_PROJECT_ID,
    process.env.VERCEL_GIT_REPO_ID,
  ].filter(Boolean);
  return parts.length ? 'bible|' + parts.join('|') : 'bible-fallback-secret';
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sign(payloadObj) {
  const body = b64url(JSON.stringify(payloadObj));
  const mac = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  return body + '.' + mac;
}
function verifySession(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const expect = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  try {
    if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch (e) { return null; }
  let payload;
  try { payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch (e) { return null; }
  if (!payload || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function cleanName(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 16);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }
  if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }
  try {
    const body = req.body || {};
    const action = ['signup', 'login', 'changepw'].indexOf(body.action) >= 0 ? body.action : 'login';
    const name = cleanName(body.name);
    const pw = String(body.pw == null ? '' : body.pw);
    if (name.length < 2) { res.status(400).json({ error: 'bad-name' }); return; }
    if (pw.length < 4 || pw.length > 40) { res.status(400).json({ error: 'bad-pw' }); return; }

    if (await isBanned(name)) { res.status(403).json({ error: 'banned' }); return; }

    const now = Math.floor(Date.now() / 1000);
    let displayName = name;

    if (action === 'changepw') {
      const newpw = String(body.newpw == null ? '' : body.newpw);
      if (newpw.length < 4 || newpw.length > 40) { res.status(400).json({ error: 'bad-newpw' }); return; }
      const u = await readUser(name);
      if (!u || u.hash !== hashPw(name, pw)) { res.status(401).json({ error: 'wrong' }); return; }
      await saveUser(name, { name: u.name || name, hash: hashPw(name, newpw), created: u.created || new Date().toISOString() }, true);
      const user0 = { sub: 'local:' + name.toLowerCase(), name: u.name || name, admin: name.toLowerCase() === ADMIN_NAME };
      const exp0 = now + SESSION_TTL;
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ token: sign({ sub: user0.sub, name: user0.name, iat: now, exp: exp0 }), exp: exp0, user: user0 });
      return;
    }

    if (action === 'signup') {
      if (await readUser(name)) { res.status(409).json({ error: 'exists' }); return; }
      try {
        await saveUser(name, { name: name, hash: hashPw(name, pw), created: new Date().toISOString() });
      } catch (e) {
        res.status(409).json({ error: 'exists' });
        return;
      }
    } else {
      const u = await readUser(name);
      if (!u || u.hash !== hashPw(name, pw)) { res.status(401).json({ error: 'wrong' }); return; }
      displayName = u.name || name;
    }

    const user = { sub: 'local:' + name.toLowerCase(), name: displayName, admin: name.toLowerCase() === ADMIN_NAME };
    const exp = now + SESSION_TTL;
    const token = sign({ sub: user.sub, name: user.name, iat: now, exp: exp });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ token: token, exp: exp, user: user });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.verifySession = verifySession;
module.exports.isAdmin = isAdmin;
module.exports.isBanned = isBanned;
module.exports.banName = banName;
module.exports.unbanName = unbanName;
module.exports.listBanned = listBanned;
module.exports.blobStoreId = blobStoreId;
module.exports.blobBase = blobBase;
module.exports.ADMIN_SUB = ADMIN_SUB;
