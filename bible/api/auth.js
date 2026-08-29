// 성경 사이트 – Google 로그인 검증 + 자체 세션 토큰 발급 (Vercel 서버리스 함수)
// POST { credential }  (credential = Google Identity Services 가 준 ID 토큰 JWT)
//   → Google 에 직접 검증을 맡기고(aud/iss 확인), 통과하면 30일짜리 서명 세션 토큰을 돌려줘요.
// 세션 토큰 형식:  base64url(payload JSON) + "." + base64url(HMAC-SHA256(payload, SECRET))

const crypto = require('crypto');

const SESSION_TTL = 30 * 24 * 60 * 60; // 30일 (초)
const ALLOWED_ISS = ['accounts.google.com', 'https://accounts.google.com'];

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  // 전용 시크릿이 없으면, 서버에만 존재하는(페이지에 안 실리는) 안정적인 값들을 조합해서 씀
  const parts = [
    process.env.BLOB_WEBHOOK_PUBLIC_KEY,
    process.env.BLOB_STORE_ID,
    process.env.VERCEL_PROJECT_ID,
    process.env.VERCEL_GIT_REPO_ID
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

// 다른 함수(bible-nanum)에서도 쓰라고 export
function verifySession(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const expect = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch (e) { return null; }
  if (!payload || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

async function verifyGoogleIdToken(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  if (!clientId) throw new Error('no-client-id');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) throw new Error('bad-token');
  const info = await r.json();
  if (info.aud !== clientId) throw new Error('aud-mismatch');
  if (ALLOWED_ISS.indexOf(info.iss) < 0) throw new Error('iss-mismatch');
  if (info.exp && Number(info.exp) * 1000 < Date.now()) throw new Error('expired');
  return info;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }
  try {
    const body = req.body || {};
    const credential = String(body.credential || '');
    if (!credential) { res.status(400).json({ error: 'no-credential' }); return; }

    const info = await verifyGoogleIdToken(credential);
    const now = Math.floor(Date.now() / 1000);
    const user = {
      sub: String(info.sub || ''),
      name: String(info.name || info.given_name || '사용자').slice(0, 40),
      email: String(info.email || '').slice(0, 120),
      picture: String(info.picture || '').slice(0, 400)
    };
    const exp = now + SESSION_TTL;
    const token = sign({ sub: user.sub, name: user.name, picture: user.picture, email: user.email, iat: now, exp });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ token, exp, user });
  } catch (e) {
    const msg = String((e && e.message) || e);
    const code = (msg === 'no-client-id') ? 503 : 401;
    res.status(code).json({ error: msg });
  }
};

module.exports.verifySession = verifySession;
