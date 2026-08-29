// 성경 사이트 – 나눔마당 게시판 API (Vercel 서버리스 함수 + Vercel Blob 저장소)
// GET               → 나눔 글 목록 (최신순). 집계 파일 하나만 읽음 (과금 작업 0, 최대 60초 지연)
// POST {text,verseRef}          → 새 글 등록 (로그인 필요, 차단된 사용자 불가)
// POST {action:'report', id}    → 글 신고 (로그인한 누구나)
// DELETE ?id=X                  → 글 삭제 (본인 글, 또는 관리자는 아무 글)
//
// 글마다 개별 불변 파일로 저장(유실 없음) → list()로 집계 파일 재생성. list()는 글 쓸 때만.

const { put, list, del, head } = require('@vercel/blob');
const { verifySession, isAdmin, isBanned, banName, unbanName, blobBase, blobStoreId } = require('./auth');

const AGG_PATH = 'bible/nanum.json';
const POST_DIR = 'bible/n/';
const REP_DIR = 'bible/rep/';
const MAX_SHOW = 80;
const MAX_TEXT = 300;

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

async function readPost(id) {
  try {
    const meta = await head(POST_DIR + id + '.json');
    const r = await fetch(meta.url + (meta.url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch (e) { /* 없음 */ }
  return null;
}

// 개별 글 파일들을 모아 집계 파일을 다시 만듦 (글 등록/삭제 때만 호출)
async function rebuildAgg() {
  let blobs = [];
  try {
    blobs = (await list({ prefix: POST_DIR, limit: 1000 })).blobs || [];
  } catch (e) { return null; }

  blobs.sort((a, b) => (a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0));
  const recent = blobs.slice(-MAX_SHOW);

  const items = await Promise.all(recent.map(async (b) => {
    try {
      const r = await fetch(b.url, { cache: 'force-cache' });
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
  } catch (e) { /* 다음 글 등록 때 복구됨 */ }

  return posts;
}

// 특정 글의 신고 파일들 삭제 (글이 지워질 때)
async function purgeReports(postId) {
  try {
    const blobs = (await list({ prefix: REP_DIR + postId + '__', limit: 1000 })).blobs || [];
    await Promise.all(blobs.map((b) => del(b.url).catch(() => {})));
  } catch (e) { /* 무시 */ }
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

    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const sess = verifySession(token);
    if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }
    const admin = isAdmin(sess);

    // ---- 글 삭제 ----
    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '').slice(0, 40);
      if (!id) { res.status(400).json({ error: 'no-id' }); return; }
      const target = await readPost(id);
      if (!target) {
        // 개별 파일이 이미 없으면 집계에서라도 지움 (관리자 정리용)
        if (admin) {
          let posts = await rebuildAgg();
          if (!posts) posts = (await loadAgg()).filter((p) => p.id !== id);
          res.status(200).json({ ok: true, posts: posts.slice(0, MAX_SHOW) });
          return;
        }
        res.status(404).json({ error: 'not-found' });
        return;
      }
      if (!admin && target.sub !== sess.sub) { res.status(403).json({ error: 'not-yours' }); return; }
      try { await del(POST_DIR + id + '.json'); } catch (e) { /* 이미 없어도 진행 */ }
      await purgeReports(id);
      let posts = await rebuildAgg();
      if (!posts) posts = (await loadAgg()).filter((p) => p.id !== id);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, posts: posts.slice(0, MAX_SHOW) });
      return;
    }

    // ---- 신고 ----
    const body = req.body || {};
    if (body.action === 'report') {
      const id = String(body.id || '').slice(0, 40);
      if (!id) { res.status(400).json({ error: 'no-id' }); return; }
      const target = await readPost(id);
      if (!target) { res.status(404).json({ error: 'not-found' }); return; }
      if (target.sub === sess.sub) { res.status(400).json({ error: 'own-post' }); return; }
      const repKey = REP_DIR + id + '__' + String(sess.sub).replace(/[^a-z0-9:_-]/gi, '') + '.json';
      try {
        await put(repKey, JSON.stringify({
          postId: id, postText: clean(target.text, 120), postName: target.name || '', postSub: target.sub || '',
          by: sess.name || '', bySub: sess.sub || '', at: new Date().toISOString(),
        }), {
          access: 'public', addRandomSuffix: false, allowOverwrite: true,
          contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
        });
      } catch (e) { res.status(500).json({ error: 'report-failed' }); return; }
      res.status(200).json({ ok: true });
      return;
    }

    // ---- 관리자: 추방 / 추방 해제 ----
    if (body.action === 'ban' || body.action === 'unban') {
      if (!admin) { res.status(403).json({ error: 'not-admin' }); return; }
      const targetName = clean(body.name, 16);
      if (targetName.length < 2) { res.status(400).json({ error: 'bad-name' }); return; }
      try {
        if (body.action === 'ban') await banName(targetName, sess.name);
        else await unbanName(targetName);
      } catch (e) { /* unban 은 없으면 throw — 무시 */ }
      res.status(200).json({ ok: true });
      return;
    }

    // ---- 새 글 등록 ----
    if (await isBanned(sess.name)) { res.status(403).json({ error: 'banned' }); return; }

    const text = String(body.text == null ? '' : body.text).slice(0, MAX_TEXT).trim();
    const verseRef = clean(body.verseRef, 40);
    if (text.length < 1) { res.status(400).json({ error: 'empty' }); return; }

    const now = Date.now();
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
    if (!posts) posts = [post].concat(await loadAgg()).slice(0, MAX_SHOW);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, posts: posts.slice(0, MAX_SHOW) });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
