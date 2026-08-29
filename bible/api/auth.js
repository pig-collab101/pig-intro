// 성경 사이트 – 아이디/비밀번호 로그인 + 자체 세션 토큰 발급 (Vercel 서버리스 함수 + Vercel Blob)
// POST { action: 'signup' | 'login', name, pw }
//
// 계정을 유저별 개별 파일(bible/u/<해시>.json)로 저장.
//  - head() 는 강한 일관성 → 가입 시 중복 검사 정확, 가입 직후 로그인도 즉시 가능
//  - 개별 파일은 만들어진 뒤 안 바뀌므로 내용은 캐시돼도 안전
// 세션 토큰 형식:  base64url(payload JSON) + "." + base64url(HMAC-SHA256(payload, SECRET))

const crypto = require('crypto');
const { put, head } = require('@vercel/blob');

const SESSION_TTL = 60 * 24 * 60 * 60; // 60일 (초)
const PW_SALT = 'bible-2026-salt';
const USER_DIR = 'bible/u/';

// ---- Blob ----
function blobStoreId() {
  const m = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([^_]+)_/);
  if (m) return m[1];
  return (process.env.BLOB_STORE_ID || '').replace(/^store_/, '');
}
function userFile(name) {
  const k = crypto.createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 40);
  return USER_DIR + k + '.json';
}
async function readUser(name) {
  let meta;
  try { meta = await head(userFile(name)); }   // 없으면 throw → null
  catch (e) { return null; }
  try {
    const r = await fetch(meta.url + (meta.url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
function saveUser(name, obj) {
  return put(userFile(name), JSON.stringify(obj), {
    access: 'public', addRandomSuffix: false, allowOverwrite: false,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 31536000,
  });
}
function hashPw(name, pw) {
  return crypto.createHash('sha256').update(name.toLowerCase() + ':' + pw + ':' + PW_SALT).digest('hex');
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
    const action = body.action === 'signup' ? 'signup' : 'login';
    const name = cleanName(body.name);
    const pw = String(body.pw == null ? '' : body.pw);
    if (name.length < 2) { res.status(400).json({ error: 'bad-name' }); return; }
    if (pw.length < 4 || pw.length > 40) { res.status(400).json({ error: 'bad-pw' }); return; }

    const now = Math.floor(Date.now() / 1000);
    let displayName = name;

    if (action === 'signup') {
      if (await readUser(name)) { res.status(409).json({ error: 'exists' }); return; }
      try {
        await saveUser(name, { name: name, hash: hashPw(name, pw), created: new Date().toISOString() });
      } catch (e) {
        // allowOverwrite:false → 동시에 같은 아이디로 가입 시 두 번째는 여기로
        res.status(409).json({ error: 'exists' });
        return;
      }
    } else {
      const u = await readUser(name);
      if (!u || u.hash !== hashPw(name, pw)) { res.status(401).json({ error: 'wrong' }); return; }
      displayName = u.name || name;
    }

    const user = { sub: 'local:' + name.toLowerCase(), name: displayName };
    const exp = now + SESSION_TTL;
    const token = sign({ sub: user.sub, name: user.name, iat: now, exp: exp });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ token: token, exp: exp, user: user });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.verifySession = verifySession;
