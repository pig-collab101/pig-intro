// 성경 사이트 – 나눔마당 게시판 API (Vercel 서버리스 함수 + Vercel Blob 저장소)
// GET  → 나눔 글 목록 (최신순)
// POST → 새 글 등록. 반드시 Authorization: Bearer <세션토큰> 필요 (Google 로그인 사용자만)
//        body { text, verseRef }

const { put } = require('@vercel/blob');
const { verifySession } = require('./auth');

const PATH = 'bible/nanum.json';
const MAX_POSTS = 200;
const MAX_TEXT = 300;

// 저장소 ID를 구해요. RW 토큰(vercel_blob_rw_<id>_<secret>) 또는 BLOB_STORE_ID(store_<id>) 둘 다 지원.
function blobStoreId() {
  const m = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([^_]+)_/);
  if (m) return m[1];
  const sid = process.env.BLOB_STORE_ID || '';
  return sid.replace(/^store_/, '');
}

// 저장소 공개 주소 (list() 대신 공개 URL 직접 읽기 → 작업 횟수 절약)
function blobBase() {
  const id = blobStoreId();
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : '';
}

// 쓰기 가능 여부: RW 토큰이 있거나, OIDC(Vercel 배포 환경) + BLOB_STORE_ID 조합이면 OK
function canWrite() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN));
}

async function load() {
  const base = blobBase();
  if (!base) return [];
  try {
    const r = await fetch(`${base}/${PATH}?v=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function save(posts) {
  return put(PATH, JSON.stringify(posts), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const posts = await load();
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(posts.slice(0, MAX_POSTS));
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }
    if (!canWrite()) { res.status(503).json({ error: 'no-db' }); return; }

    const auth = String(req.headers.authorization || '');
    const token = auth.replace(/^Bearer\s+/i, '');
    const sess = verifySession(token);
    if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }

    const body = req.body || {};
    const text = String(body.text == null ? '' : body.text).slice(0, MAX_TEXT).trim();
    const verseRef = clean(body.verseRef, 40);
    if (text.length < 1) { res.status(400).json({ error: 'empty' }); return; }

    const posts = await load();

    // 같은 사람이 5초 안에 도배하는 것 방지
    const last = posts.find(p => p.sub === sess.sub);
    if (last && last.time && Date.now() - new Date(last.time).getTime() < 5000) {
      res.status(429).json({ error: 'too-fast' });
      return;
    }

    const post = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      sub: String(sess.sub || ''),
      name: clean(sess.name, 40) || '익명',
      picture: clean(sess.picture, 400),
      verseRef,
      text,
      time: new Date().toISOString(),
    };

    const next = [post].concat(posts).slice(0, MAX_POSTS);
    await save(next);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, posts: next.slice(0, MAX_POSTS) });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
