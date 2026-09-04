// 성경 사이트 – 나눔마당 게시판 API (Vercel 서버리스 함수 + Vercel Blob 저장소)
// GET                        → 나눔 글 목록 (최신순, 집계 파일 1회 읽기)
// GET ?meta=1                → { likes:{id:수}, comments:{id:수}, mine:[내가 좋아요한 id] }
// GET ?comments=<id>         → { comments:[...] }  특정 글의 댓글
// POST {text,verseRef}       → 새 글 등록 (로그인 필요, 차단된 사용자 불가)
// POST {action:'report', id} → 글 신고
// POST {action:'like', id}   → 좋아요 토글
// POST {action:'comment', id, text} → 댓글 달기
// POST {action:'ban'|'unban', name} → 관리자 추방/해제
// DELETE ?id=X               → 글 삭제 (본인 글, 또는 관리자)
// DELETE ?comment=<id>&cid=<cid> → 댓글 삭제 (본인 댓글, 또는 관리자)

const { put, list, del, head } = require('@vercel/blob');
const { verifySession, isAdmin, isBanned, banName, unbanName, blobBase, blobStoreId } = require('./auth');

const AGG_PATH = 'bible/nanum.json';
const POST_DIR = 'bible/n/';
const REP_DIR = 'bible/rep/';
const LIKES_PATH = 'bible/likes.json';        // { postId: [sub, ...] }
const CMT_DIR = 'bible/cmt/';                  // <postId>.json = [ {id, sub, name, text, time} ]
const CMTCOUNT_PATH = 'bible/cmtcount.json';   // { postId: n }
const MAX_SHOW = 80;
const MAX_TEXT = 300;
const MAX_CMT_TEXT = 200;
const MAX_CMT_PER_POST = 200;

async function loadObj(path) {
  const base = blobBase();
  if (!base) return {};
  try {
    const r = await fetch(`${base}/${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return {};
    const d = await r.json();
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch (e) { return {}; }
}
async function loadArr(path) {
  const base = blobBase();
  if (!base) return [];
  try {
    const r = await fetch(`${base}/${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch (e) { return []; }
}
function saveJson(path, data) {
  return put(path, JSON.stringify(data), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
  });
}

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
// opts: { excludeId: 방금 지운 글 id (list 반영 지연 대비), ensurePost: 방금 올린 글 객체 }
async function rebuildAgg(opts) {
  opts = opts || {};
  let blobs = [];
  try {
    blobs = (await list({ prefix: POST_DIR, limit: 1000 })).blobs || [];
  } catch (e) { return null; }

  blobs.sort((a, b) => (a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0));
  const recent = blobs.slice(-(MAX_SHOW + 5));

  const items = await Promise.all(recent.map(async (b) => {
    try {
      const r = await fetch(b.url, { cache: 'force-cache' });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }));

  let posts = items.filter(Boolean);
  if (opts.excludeId) posts = posts.filter((p) => p.id !== opts.excludeId);
  if (opts.ensurePost && !posts.some((p) => p.id === opts.ensurePost.id)) posts.push(opts.ensurePost);

  posts = posts
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
      const q = req.query || {};
      // 좋아요/댓글 수 + 내가 누른 좋아요
      if (q.meta === '1') {
        const likesMap = await loadObj(LIKES_PATH);
        const cmtCount = await loadObj(CMTCOUNT_PATH);
        const likes = {};
        Object.keys(likesMap).forEach((k) => { likes[k] = Array.isArray(likesMap[k]) ? likesMap[k].length : 0; });
        let mine = [];
        const sess0 = verifySession(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        if (sess0) mine = Object.keys(likesMap).filter((k) => Array.isArray(likesMap[k]) && likesMap[k].indexOf(sess0.sub) >= 0);
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ likes: likes, comments: cmtCount, mine: mine });
        return;
      }
      // 특정 글의 댓글 목록
      if (q.comments) {
        const cid = String(q.comments).slice(0, 40);
        const arr = await loadArr(CMT_DIR + cid + '.json');
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ comments: arr.slice(-MAX_CMT_PER_POST) });
        return;
      }
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

    // ---- 댓글 삭제 ----
    if (req.method === 'DELETE' && req.query && req.query.comment) {
      const pid = String(req.query.comment).slice(0, 40);
      const cid = String(req.query.cid || '').slice(0, 40);
      if (!pid || !cid) { res.status(400).json({ error: 'no-id' }); return; }
      const arr = await loadArr(CMT_DIR + pid + '.json');
      const tgt = arr.find((c) => c.id === cid);
      if (!tgt) { res.status(404).json({ error: 'not-found' }); return; }
      if (!admin && tgt.sub !== sess.sub) { res.status(403).json({ error: 'not-yours' }); return; }
      const next = arr.filter((c) => c.id !== cid);
      await saveJson(CMT_DIR + pid + '.json', next);
      const cc = await loadObj(CMTCOUNT_PATH); cc[pid] = next.length; await saveJson(CMTCOUNT_PATH, cc);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, comments: next });
      return;
    }

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
      try {
        await del(CMT_DIR + id + '.json').catch(() => {});
        const lk = await loadObj(LIKES_PATH); if (lk[id]) { delete lk[id]; await saveJson(LIKES_PATH, lk); }
        const cc = await loadObj(CMTCOUNT_PATH); if (cc[id] != null) { delete cc[id]; await saveJson(CMTCOUNT_PATH, cc); }
      } catch (e) { /* 무시 */ }
      let posts = await rebuildAgg({ excludeId: id });
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

    // ---- 좋아요 토글 ----
    if (body.action === 'like') {
      const id = String(body.id || '').slice(0, 40);
      if (!id) { res.status(400).json({ error: 'no-id' }); return; }
      const lk = await loadObj(LIKES_PATH);
      let arr = Array.isArray(lk[id]) ? lk[id] : [];
      const had = arr.indexOf(sess.sub) >= 0;
      arr = had ? arr.filter((s) => s !== sess.sub) : arr.concat([sess.sub]);
      lk[id] = arr;
      await saveJson(LIKES_PATH, lk);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, count: arr.length, liked: !had });
      return;
    }

    // ---- 댓글 달기 ----
    if (body.action === 'comment') {
      if (await isBanned(sess.name)) { res.status(403).json({ error: 'banned' }); return; }
      const id = String(body.id || '').slice(0, 40);
      const text = clean(body.text, MAX_CMT_TEXT);
      if (!id) { res.status(400).json({ error: 'no-id' }); return; }
      if (text.length < 1) { res.status(400).json({ error: 'empty' }); return; }
      const arr = await loadArr(CMT_DIR + id + '.json');
      const last = arr[arr.length - 1];
      if (last && last.sub === sess.sub && last.text === text) { res.status(200).json({ ok: true, comments: arr }); return; }
      arr.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        sub: String(sess.sub || ''), name: clean(sess.name, 40) || '익명',
        text: text, time: new Date().toISOString(),
      });
      const next = arr.slice(-MAX_CMT_PER_POST);
      await saveJson(CMT_DIR + id + '.json', next);
      const cc = await loadObj(CMTCOUNT_PATH); cc[id] = next.length; await saveJson(CMTCOUNT_PATH, cc);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, comments: next });
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

    let posts = await rebuildAgg({ ensurePost: post });
    if (!posts) posts = [post].concat(await loadAgg()).slice(0, MAX_SHOW);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, posts: posts.slice(0, MAX_SHOW) });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
