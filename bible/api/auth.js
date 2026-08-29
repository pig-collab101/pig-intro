// 성경 사이트 – 아이디/비밀번호 로그인 + 자체 세션 토큰 발급 (Vercel 서버리스 함수 + Vercel Blob)
// POST { action: 'signup' | 'login', name, pw }
//   signup → 새 계정 생성 후 세션 토큰 발급
//   login  → 계정/비밀번호 확인 후 세션 토큰 발급
// 세션 토큰 형식:  base64url(payload JSON) + "." + base64url(HMAC-SHA256(payload, SECRET))

const crypto = require('crypto');
const { put } = require('@vercel/blob');

const SESSION_TTL = 60 * 24 * 60 * 60; // 60일 (초)
const USERS_PATH = 'bible/users.json';
const PW_SALT = 'bible-2026-salt';

// ---- Blob 저장소 (RW 토큰 또는 BLOB_STORE_ID + 배포 OIDC 헤더로 자동 인증) ----
function blobStoreId() {
  const m = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([^_]+)_/);
  if (m) return m[1];
  return (process.env.BLOB_STORE_ID || '').replace(/^store_/, '');
}
function blobBase() {
  const id = blobStoreId();
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : '';
}
async function loadUsers() {
  const base = blobBase();
  if (!base) return {};
  try {
    const r = await fetch(`${base}/${USERS_PATH}?v=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return {};
    const d = await r.json();
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch (e) { return {}; }
}
function saveUsers(db) {
  return put(USERS_PATH, JSON.stringify(db), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
  });
}
function hashPw(name, pw) {
  return crypto.createHash('sha256').update(name.toLowerCase() + ':' + pw + ':' + PW_SALT).digest('hex');
}

// ---- 세션 토큰 ----
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  // 전용 시크릿이 없으면 서버에만 존재하는(페이지에 안 실리는) 안정적인 값 조합
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
    const action = body.action === 'signup' ? 'signup' : 'login';
    const name = cleanName(body.name);
    const pw = String(body.pw == null ? '' : body.pw);
    if (name.length < 2) { res.status(400).json({ error: 'bad-name' }); return; }
    if (pw.length < 4 || pw.length > 40) { res.status(400).json({ error: 'bad-pw' }); return; }

    const db = await loadUsers();
    const key = name.toLowerCase();
    const now = Math.floor(Date.now() / 1000);

    if (action === 'signup') {
      if (db[key]) { res.status(409).json({ error: 'exists' }); return; }
      if (Object.keys(db).length >= 5000) { res.status(507).json({ error: 'full' }); return; }
      db[key] = { name: name, hash: hashPw(name, pw), created: new Date().toISOString() };
      await saveUsers(db);
    } else {
      const u = db[key];
      if (!u || u.hash !== hashPw(name, pw)) { res.status(401).json({ error: 'wrong' }); return; }
    }

    const user = { sub: 'local:' + key, name: db[key].name };
    const exp = now + SESSION_TTL;
    const token = sign({ sub: user.sub, name: user.name, iat: now, exp: exp });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ token: token, exp: exp, user: user });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.verifySession = verifySession;
