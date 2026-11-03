// I.S.K 모임 사이트 – 게시판 API (공지 + 나눔마당, Vercel 서버리스 + Vercel Blob)
// GET                          → 글 목록 (최신순, 집계 파일 1회 읽기, 글마다 댓글 수 포함)
// GET ?comments=<id>           → { comments:[...] }  특정 글의 댓글
// POST {cat,title,text}        → 새 글 (로그인 필요, 차단 불가, cat 'notice' 는 관리자만, 'spot' = 교란종 발견 제보)
// POST {action:'comment', id, text} → 댓글 달기
// POST {action:'report', id}   → 글 신고
// POST {action:'ban'|'unban', name} → 관리자 추방/해제
// DELETE ?id=X                 → 글 삭제 (본인 글, 또는 관리자)
// DELETE ?comment=<id>&cid=<cid> → 댓글 삭제 (본인 댓글, 또는 관리자)
//
// 저장은 전부 불변 개별 파일 (공용 JSON 을 읽고-고쳐-쓰면 CDN 지연으로 유실됨):
//   글   isk/n/<15자리ts>-<rand>.json
//   댓글 isk/c/<글id>/<15자리ts>-<rand>.json
//   집계 isk/board.json  ← 글/댓글 쓰고 지울 때만 list() 로 다시 만듦

const crypto = require('crypto');
const { put, list, del, head } = require('@vercel/blob');
const { verifySession, isAdmin, isBanned, banName, unbanName, blobBase, blobStoreId } = require('./auth');

const AGG_PATH = 'isk/board.json';
const POST_DIR = 'isk/n/';
const CMT_DIR = 'isk/c/';
const REP_DIR = 'isk/rep/';
const CATS = ['notice', 'free', 'spot', 'question', 'review'];
const MAX_SHOW = 200;
const MAX_TITLE = 60;
const MAX_TEXT = 3000;
const MAX_CMT_TEXT = 300;

function clean(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanBody(s, max) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max);
}
function newId() {
  return String(Date.now()).padStart(15, '0') + '-' + Math.random().toString(36).slice(2, 8);
}
function safeId(s) { return String(s || '').replace(/[^0-9a-z-]/gi, '').slice(0, 40); }

async function listAll(prefix) {
  let blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: prefix, limit: 1000, cursor: cursor });
    blobs = blobs.concat(r.blobs || []);
    cursor = r.hasMore ? r.cursor : null;
  } while (cursor);
  return blobs;
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

async function readFile(pathname) {
  try {
    const meta = await head(pathname);
    const r = await fetch(meta.url + (meta.url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch (e) { /* 없음 */ }
  return null;
}

function putImmutable(pathname, obj) {
  return put(pathname, JSON.stringify(obj), {
    access: 'public', addRandomSuffix: false, allowOverwrite: false,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 31536000,
  });
}

// 개별 글 파일 + 댓글 파일 목록으로 집계 파일을 다시 만듦
// opts: { excludeId, ensurePost, cmtAdd:{pid,path}, cmtRemove:{pid,path} } — list() 반영 지연 대비
async function rebuildAgg(opts) {
  opts = opts || {};
  let blobs, cblobs;
  try {
    blobs = await listAll(POST_DIR);
    cblobs = await listAll(CMT_DIR);
  } catch (e) { return null; }

  const cmtPaths = new Set(cblobs.map((b) => b.pathname));
  if (opts.cmtAdd) cmtPaths.add(opts.cmtAdd.path);
  if (opts.cmtRemove) cmtPaths.delete(opts.cmtRemove.path);
  const counts = {};
  cmtPaths.forEach((p) => {
    const pid = p.slice(CMT_DIR.length).split('/')[0];
    counts[pid] = (counts[pid] || 0) + 1;
  });

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
    .map((p) => Object.assign({}, p, { cmt: counts[p.id] || 0 }))
    .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))
    .slice(0, MAX_SHOW);

  try {
    await put(AGG_PATH, JSON.stringify(posts), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
    });
  } catch (e) { /* 다음에 쓸 때 복구됨 */ }
  return posts;
}

// 특정 글의 댓글 목록 (opts 로 방금 쓴/지운 댓글 보정)
async function loadComments(pid, opts) {
  opts = opts || {};
  let blobs = [];
  try { blobs = await listAll(CMT_DIR + pid + '/'); } catch (e) { blobs = []; }
  const items = await Promise.all(blobs.map(async (b) => {
    try { const r = await fetch(b.url, { cache: 'force-cache' }); return r.ok ? await r.json() : null; }
    catch (e) { return null; }
  }));
  let arr = items.filter(Boolean);
  if (opts.excludeId) arr = arr.filter((c) => c.id !== opts.excludeId);
  if (opts.ensure && !arr.some((c) => c.id === opts.ensure.id)) arr.push(opts.ensure);
  return arr.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
}

async function purgePrefix(prefix) {
  try {
    const blobs = await listAll(prefix);
    await Promise.all(blobs.map((b) => del(b.url).catch(() => {})));
  } catch (e) { /* 무시 */ }
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      res.setHeader('Cache-Control', 'no-store');
      if (q.comments) {
        if (!blobStoreId()) { res.status(200).json({ comments: [] }); return; }
        res.status(200).json({ comments: await loadComments(safeId(q.comments)) });
        return;
      }
      res.status(200).json(await loadAgg());
      return;
    }

    if (req.method !== 'POST' && req.method !== 'DELETE') { res.status(405).json({ error: 'method-not-allowed' }); return; }
    if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }

    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const sess = verifySession(token);
    if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }
    const admin = isAdmin(sess);
    res.setHeader('Cache-Control', 'no-store');

    // ---- 댓글 삭제 ----
    if (req.method === 'DELETE' && req.query && req.query.comment) {
      const pid = safeId(req.query.comment);
      const cid = safeId(req.query.cid);
      if (!pid || !cid) { res.status(400).json({ error: 'no-id' }); return; }
      const path = CMT_DIR + pid + '/' + cid + '.json';
      const tgt = await readFile(path);
      if (!tgt) { res.status(404).json({ error: 'not-found' }); return; }
      if (!admin && tgt.sub !== sess.sub) { res.status(403).json({ error: 'not-yours' }); return; }
      try { await del(path); } catch (e) { /* 이미 없어도 진행 */ }
      const comments = await loadComments(pid, { excludeId: cid });
      const posts = await rebuildAgg({ cmtRemove: { pid: pid, path: path } });
      res.status(200).json({ ok: true, comments: comments, posts: posts || undefined });
      return;
    }

    // ---- 글 삭제 ----
    if (req.method === 'DELETE') {
      const id = safeId(req.query && req.query.id);
      if (!id) { res.status(400).json({ error: 'no-id' }); return; }
      const target = await readFile(POST_DIR + id + '.json');
      if (!target && !admin) { res.status(404).json({ error: 'not-found' }); return; }
      if (target && !admin && target.sub !== sess.sub) { res.status(403).json({ error: 'not-yours' }); return; }
      try { await del(POST_DIR + id + '.json'); } catch (e) { /* 이미 없어도 진행 */ }
      await purgePrefix(REP_DIR + id + '__');
      await purgePrefix(CMT_DIR + id + '/');
      let posts = await rebuildAgg({ excludeId: id });
      if (!posts) posts = (await loadAgg()).filter((p) => p.id !== id);
      res.status(200).json({ ok: true, posts: posts });
      return;
    }

    const body = req.body || {};

    // ---- 신고 ----
    if (body.action === 'report') {
      const id = safeId(body.id);
      const target = id && await readFile(POST_DIR + id + '.json');
      if (!target) { res.status(404).json({ error: 'not-found' }); return; }
      if (target.sub === sess.sub) { res.status(400).json({ error: 'own-post' }); return; }
      // 신고자별 1건 — 한글 아이디도 겹치지 않게 해시로
      const repKey = REP_DIR + id + '__' + crypto.createHash('sha256').update(String(sess.sub)).digest('hex').slice(0, 24) + '.json';
      try {
        await put(repKey, JSON.stringify({
          postId: id, postText: clean((target.title ? '[' + target.title + '] ' : '') + target.text, 120),
          postName: target.name || '', postSub: target.sub || '',
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

    if (await isBanned(sess.name)) { res.status(403).json({ error: 'banned' }); return; }

    // ---- 댓글 달기 ----
    if (body.action === 'comment') {
      const pid = safeId(body.id);
      const text = cleanBody(body.text, MAX_CMT_TEXT);
      if (!pid) { res.status(400).json({ error: 'no-id' }); return; }
      if (text.length < 1) { res.status(400).json({ error: 'empty' }); return; }
      try { await head(POST_DIR + pid + '.json'); } catch (e) { res.status(404).json({ error: 'not-found' }); return; }
      const cmt = {
        id: newId(), pid: pid, sub: String(sess.sub || ''), name: clean(sess.name, 40) || '익명',
        text: text, time: new Date().toISOString(),
      };
      const path = CMT_DIR + pid + '/' + cmt.id + '.json';
      try { await putImmutable(path, cmt); } catch (e) { res.status(500).json({ error: 'save-failed' }); return; }
      const comments = await loadComments(pid, { ensure: cmt });
      const posts = await rebuildAgg({ cmtAdd: { pid: pid, path: path } });
      res.status(200).json({ ok: true, comments: comments, posts: posts || undefined });
      return;
    }

    // ---- 새 글 ----
    const cat = CATS.indexOf(body.cat) >= 0 ? body.cat : 'free';
    if (cat === 'notice' && !admin) { res.status(403).json({ error: 'not-admin' }); return; }
    const title = clean(body.title, MAX_TITLE);
    const text = cleanBody(body.text, MAX_TEXT);
    if (title.length < 1) { res.status(400).json({ error: 'no-title' }); return; }
    if (text.length < 1) { res.status(400).json({ error: 'empty' }); return; }

    const post = {
      id: newId(), cat: cat, sub: String(sess.sub || ''), name: clean(sess.name, 40) || '익명',
      title: title, text: text, time: new Date().toISOString(),
    };
    try { await putImmutable(POST_DIR + post.id + '.json', post); }
    catch (e) { res.status(500).json({ error: 'save-failed' }); return; }

    let posts = await rebuildAgg({ ensurePost: post });
    if (!posts) posts = [Object.assign({ cmt: 0 }, post)].concat(await loadAgg()).slice(0, MAX_SHOW);
    res.status(200).json({ ok: true, posts: posts, post: post });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
