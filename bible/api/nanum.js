// 성경 사이트 – 나눔마당 게시판 API (Vercel 서버리스 함수 + Vercel Blob 저장소)
// GET  → 나눔 글 목록 (최신순). 집계 파일 하나만 읽음 (작업 횟수 0, 최대 60초 지연 가능)
// POST → 새 글 등록. Authorization: Bearer <세션토큰> 필요.  body { text, verseRef }
//        글마다 개별 불변 파일로 저장(유실 없음) → list()로 집계 파일 재생성
//
// 개별 파일 방식을 쓰는 이유: Vercel Blob 공개 URL은 최소 60초 캐시라서
// "읽고-고치고-쓰기"를 하면 60초 안에 올라온 다른 글을 덮어써 유실될 수 있음.
// 글을 각각 파일로 쓰면 절대 유실 안 됨. list()는 글 쓸 때만 호출(빈도 낮음).

const { put, list, del } = require('@vercel/blob');
const { verifySession } = require('./auth');

const AGG_PATH = 'bible/nanum.json';   // 읽기용 집계 파일
const POST_DIR = 'bible/n/';           // 글 개별 파일 폴더
const MAX_SHOW = 80;                   // 화면에 보여줄 최근 글 수
const MAX_TEXT = 300;

function blobStoreId() {
  const m = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([^_]+)_/);
  if (m) return m[1];
  return (process.env.BLOB_STORE_ID || '').replace(/^store_/, '');
}
function blobBase() {
  const id = blobStoreId();
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : '';
}

// 읽기용 집계 파일 (싸다: 공개 URL 1회, 과금 작업 0). 최대 60초 지연 가능.
async function loadAgg() {
  const base = blobBase();
  if (!base) return [];
  try {
    const r = await fetch(`${base}/${AGG_PATH}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch (e) { return []; }
}

// 개별 글 파일들을 모아 집계 파일을 다시 만듦 (POST 때만 호출)
async function rebuildAgg() {
  let blobs = [];
  try {
    const out = await list({ prefix: POST_DIR, limit: 1000 });
    blobs = out.blobs || [];
  } catch (e) { return null; }

  // 최신 파일이 뒤에 오도록 pathname(=시간 기반 id) 정렬 → 뒤에서 MAX_SHOW개
  blobs.sort((a, b) => (a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0));
  const recent = blobs.slice(-MAX_SHOW);

  const items = await Promise.all(recent.map(async (b) => {
    try {
      const r = await fetch(b.url, { cache: 'force-cache' }); // 개별 파일은 불변 → 캐시 OK
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }));

  const posts = items
    .filter(Boolean)
    .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))
    .slice(0, MAX_SHOW);

  try {
    await put(AGG_PATH, JSON.stringify(posts), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
    });
  } catch (e) { /* 집계 저장 실패는 치명적 아님 — 다음 글 등록 때 복구됨 */ }

  return posts;
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const posts = await loadAgg();
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(posts.slice(0, MAX_SHOW));
      return;
    }

    if (req.method !== 'POST' && req.method !== 'DELETE') { res.status(405).json({ error: 'method-not-allowed' }); return; }
    if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }

    const auth = String(req.headers.authorization || '');
    const token = auth.replace(/^Bearer\s+/i, '');
    const sess = verifySession(token);
    if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }

    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '').slice(0, 40);
      if (!id) { res.status(400).json({ error: 'no-id' }); return; }
      const agg = await loadAgg();
      const target = agg.find(function (p) { return p.id === id; });
      if (!target) { res.status(404).json({ error: 'not-found' }); return; }
      if (target.sub !== sess.sub) { res.status(403).json({ error: 'not-yours' }); return; }
      try { await del(POST_DIR + id + '.json'); } catch (e) { /* 이미 없어도 진행 */ }
      let posts = await rebuildAgg();
      if (!posts) posts = agg.filter(function (p) { return p.id !== id; });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, posts: posts.slice(0, MAX_SHOW) });
      return;
    }

    const body = req.body || {};
    const text = String(body.text == null ? '' : body.text).slice(0, MAX_TEXT).trim();
    const verseRef = clean(body.verseRef, 40);
    if (text.length < 1) { res.status(400).json({ error: 'empty' }); return; }

    const now = Date.now();
    // pathname 이 시간순 정렬되도록 고정폭 숫자 + 랜덤
    const id = String(now).padStart(15, '0') + '-' + Math.random().toString(36).slice(2, 8);
    const post = {
      id: id,
      sub: String(sess.sub || ''),
      name: clean(sess.name, 40) || '익명',
      verseRef: verseRef,
      text: text,
      time: new Date(now).toISOString(),
    };

    try {
      await put(POST_DIR + id + '.json', JSON.stringify(post), {
        access: 'public', addRandomSuffix: false, allowOverwrite: false,
        contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 31536000,
      });
    } catch (e) {
      res.status(500).json({ error: 'save-failed' });
      return;
    }

    let posts = await rebuildAgg();
    if (!posts) {
      // list() 실패 시: 기존 집계 + 방금 글로 응답 (개별 파일은 이미 저장됨)
      posts = [post].concat(await loadAgg()).slice(0, MAX_SHOW);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, posts: posts.slice(0, MAX_SHOW) });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
