// 과학 퀴즈 사이트 – 퀴즈 주고받기 API (Vercel 서버리스 함수 + Vercel Blob 저장소)
// GET                         → { quizzes:[정답 뺀 목록], stats:{id:[푼사람, 맞힌사람]} }
// GET ?me=1                   → { solved:{id:{ok,pick,at}} }   (로그인 필요)
// GET ?rank=1                 → { rank:[{sub,name,score,correct,tries,made,received}] }
// POST {action:'create', cat, q, choices[], answer, explain} → 퀴즈 내기
// POST {action:'solve', id, pick}  → 퀴즈 풀기 (1인 1회, 내 퀴즈는 못 품) → {correct, answer, explain}
// POST {action:'report', id}       → 퀴즈 신고
// POST {action:'ban'|'unban', name} → 관리자 추방/해제
// POST {action:'rankdel', sub}     → 관리자: 랭킹에서 지우기
// DELETE ?id=X                     → 퀴즈 삭제 (본인 퀴즈, 또는 관리자)
//
// 퀴즈 = 개별 불변 파일 sci/q/<id>.json, 읽기용 집계 sci/quizzes.json (등록/삭제 때만 재생성)
// 풀이 = sci/a/<id>__<유저해시>.json (allowOverwrite:false 로 1인 1회 보장)
// 내 기록 = sci/s/<유저해시>.json, 랭킹 = sci/rank.json (내 기록에서 다시 계산해 덮어써서 자가 복구)

const crypto = require('crypto');
const { put, list, del, head } = require('@vercel/blob');
const { verifySession, isAdmin, isBanned, banName, unbanName, blobBase, blobStoreId } = require('./auth');

const AGG_PATH = 'sci/quizzes.json';
const Q_DIR = 'sci/q/';
const A_DIR = 'sci/a/';
const S_DIR = 'sci/s/';
const REP_DIR = 'sci/rep/';
const RANK_PATH = 'sci/rank.json';
const STAT_PATH = 'sci/qstat.json';
const CATS = ['물리', '화학', '생명과학', '지구과학', '기타'];
const MAX_SHOW = 200;

const PTS_CORRECT = 10;
const PTS_MADE = 5;
const PTS_RECEIVED = 1;

function subHash(sub) {
  return crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 40);
}
function clean(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}
function saveJson(path, data, maxAge) {
  return put(path, JSON.stringify(data), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: maxAge || 0,
  });
}
async function loadPath(path, fallback) {
  const base = blobBase();
  if (!base) return fallback;
  try {
    const r = await fetch(`${base}/${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch (e) { return fallback; }
}
async function loadObj(path) {
  const d = await loadPath(path, {});
  return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
}
async function loadAgg() {
  const d = await loadPath(AGG_PATH, []);
  return Array.isArray(d) ? d : [];
}
// head() 로 강한 일관성 읽기
async function readStrong(pathname) {
  try {
    const meta = await head(pathname);
    const r = await fetch(meta.url + (meta.url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch (e) { /* 없음 */ }
  return null;
}

// 정답·해설을 뺀 공개용 퀴즈
function publicQuiz(q) {
  return { id: q.id, sub: q.sub, name: q.name, cat: q.cat, q: q.q, choices: q.choices, time: q.time };
}

async function rebuildAgg(opts) {
  opts = opts || {};
  let blobs = [];
  try { blobs = (await list({ prefix: Q_DIR, limit: 1000 })).blobs || []; } catch (e) { return null; }
  blobs.sort((a, b) => (a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0));
  const recent = blobs.slice(-(MAX_SHOW + 5));
  const items = await Promise.all(recent.map(async (b) => {
    try { const r = await fetch(b.url, { cache: 'force-cache' }); return r.ok ? await r.json() : null; }
    catch (e) { return null; }
  }));
  let qs = items.filter(Boolean);
  if (opts.excludeId) qs = qs.filter((p) => p.id !== opts.excludeId);
  if (opts.ensure && !qs.some((p) => p.id === opts.ensure.id)) qs.push(opts.ensure);
  qs = qs.sort((a, b) => String(b.time || '').localeCompare(String(a.time || ''))).slice(0, MAX_SHOW);
  try { await saveJson(AGG_PATH, qs); } catch (e) { /* 다음 등록 때 복구 */ }
  return qs;
}

async function purgeReports(id) {
  try {
    const blobs = (await list({ prefix: REP_DIR + id + '__', limit: 1000 })).blobs || [];
    await Promise.all(blobs.map((b) => del(b.url).catch(() => {})));
  } catch (e) { /* 무시 */ }
}

async function buildRank() {
  const [rank, quizzes, stats] = await Promise.all([loadObj(RANK_PATH), loadAgg(), loadObj(STAT_PATH)]);
  const rows = {};
  function row(sub, name) {
    if (!rows[sub]) rows[sub] = { sub: sub, name: name || '', correct: 0, tries: 0, made: 0, received: 0 };
    if (name && !rows[sub].name) rows[sub].name = name;
    return rows[sub];
  }
  Object.keys(rank).forEach((sub) => {
    const e = rank[sub] || {};
    if (e.hidden) return;
    const r = row(sub, e.name);
    r.correct = e.correct || 0; r.tries = e.tries || 0;
  });
  quizzes.forEach((q) => {
    if (rank[q.sub] && rank[q.sub].hidden) return;
    const r = row(q.sub, q.name);
    r.made += 1;
    const st = stats[q.id];
    if (Array.isArray(st)) r.received += st[0] || 0;
  });
  return Object.values(rows)
    .map((r) => Object.assign(r, { score: r.correct * PTS_CORRECT + r.made * PTS_MADE + r.received * PTS_RECEIVED }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.correct - a.correct)
    .slice(0, 100);
}

module.exports = async (req, res) => {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const sess = verifySession(token);

    if (req.method === 'GET') {
      const q = req.query || {};
      res.setHeader('Cache-Control', 'no-store');
      if (q.rank === '1') { res.status(200).json({ rank: await buildRank() }); return; }
      if (q.me === '1') {
        if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }
        const mine = await readStrong(S_DIR + subHash(sess.sub) + '.json');
        res.status(200).json({ solved: (mine && mine.solved) || {} });
        return;
      }
      const [quizzes, stats] = await Promise.all([loadAgg(), loadObj(STAT_PATH)]);
      res.status(200).json({ quizzes: quizzes.slice(0, MAX_SHOW).map(publicQuiz), stats: stats });
      return;
    }

    if (req.method !== 'POST' && req.method !== 'DELETE') { res.status(405).json({ error: 'method-not-allowed' }); return; }
    if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }
    if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }
    const admin = isAdmin(sess);

    // ---- 퀴즈 삭제 ----
    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '').slice(0, 40);
      if (!id) { res.status(400).json({ error: 'no-id' }); return; }
      const target = await readStrong(Q_DIR + id + '.json');
      if (!target && !admin) { res.status(404).json({ error: 'not-found' }); return; }
      if (target && !admin && target.sub !== sess.sub) { res.status(403).json({ error: 'not-yours' }); return; }
      try { await del(Q_DIR + id + '.json'); } catch (e) { /* 이미 없음 */ }
      await purgeReports(id);
      let qs = await rebuildAgg({ excludeId: id });
      if (!qs) qs = (await loadAgg()).filter((p) => p.id !== id);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, quizzes: qs.map(publicQuiz) });
      return;
    }

    const body = req.body || {};
    const action = String(body.action || '');

    // ---- 관리자: 추방 / 해제 / 랭킹 삭제 ----
    if (action === 'ban' || action === 'unban') {
      if (!admin) { res.status(403).json({ error: 'not-admin' }); return; }
      const targetName = clean(body.name, 16);
      if (targetName.length < 2) { res.status(400).json({ error: 'bad-name' }); return; }
      try {
        if (action === 'ban') await banName(targetName, sess.name);
        else await unbanName(targetName);
      } catch (e) { /* unban 은 없으면 throw — 무시 */ }
      res.status(200).json({ ok: true });
      return;
    }
    if (action === 'rankdel') {
      if (!admin) { res.status(403).json({ error: 'not-admin' }); return; }
      const sub = clean(body.sub, 80);
      if (!sub) { res.status(400).json({ error: 'no-sub' }); return; }
      const rank = await loadObj(RANK_PATH);
      rank[sub] = Object.assign({}, rank[sub] || {}, { hidden: true });
      await saveJson(RANK_PATH, rank);
      res.status(200).json({ ok: true, rank: await buildRank() });
      return;
    }

    // ---- 신고 ----
    if (action === 'report') {
      const id = String(body.id || '').slice(0, 40);
      const target = id && await readStrong(Q_DIR + id + '.json');
      if (!target) { res.status(404).json({ error: 'not-found' }); return; }
      if (target.sub === sess.sub) { res.status(400).json({ error: 'own-quiz' }); return; }
      try {
        await saveJson(REP_DIR + id + '__' + subHash(sess.sub) + '.json', {
          postId: id, postText: clean(target.q, 120), postName: target.name || '', postSub: target.sub || '',
          by: sess.name || '', bySub: sess.sub || '', at: new Date().toISOString(),
        });
      } catch (e) { res.status(500).json({ error: 'report-failed' }); return; }
      res.status(200).json({ ok: true });
      return;
    }

    if (await isBanned(sess.name)) { res.status(403).json({ error: 'banned' }); return; }

    // ---- 퀴즈 풀기 ----
    if (action === 'solve') {
      const id = String(body.id || '').slice(0, 40);
      const pick = parseInt(body.pick, 10);
      const quiz = id && await readStrong(Q_DIR + id + '.json');
      if (!quiz) { res.status(404).json({ error: 'not-found' }); return; }
      if (quiz.sub === sess.sub) { res.status(400).json({ error: 'own-quiz' }); return; }
      if (!(pick >= 0 && pick < quiz.choices.length)) { res.status(400).json({ error: 'bad-pick' }); return; }
      const ok = pick === quiz.answer;
      const h = subHash(sess.sub);
      const at = new Date().toISOString();
      try {
        await put(A_DIR + id + '__' + h + '.json', JSON.stringify({ id: id, sub: sess.sub, pick: pick, ok: ok, at: at }), {
          access: 'public', addRandomSuffix: false, allowOverwrite: false,
          contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 31536000,
        });
      } catch (e) {
        // 이미 푼 퀴즈 → 처음 기록을 돌려줌
        const prev = await readStrong(A_DIR + id + '__' + h + '.json');
        res.status(409).json({ error: 'already', correct: !!(prev && prev.ok), pick: prev ? prev.pick : null, answer: quiz.answer, explain: quiz.explain || '' });
        return;
      }
      const mine = (await readStrong(S_DIR + h + '.json')) || { solved: {} };
      mine.solved = mine.solved || {};
      mine.solved[id] = { ok: ok, pick: pick, at: at };
      mine.name = sess.name;
      await saveJson(S_DIR + h + '.json', mine);

      const vals = Object.values(mine.solved);
      const [rank, stats] = await Promise.all([loadObj(RANK_PATH), loadObj(STAT_PATH)]);
      rank[sess.sub] = Object.assign({}, rank[sess.sub] || {}, {
        name: sess.name, tries: vals.length, correct: vals.filter((v) => v.ok).length,
      });
      const st = Array.isArray(stats[id]) ? stats[id] : [0, 0];
      stats[id] = [st[0] + 1, st[1] + (ok ? 1 : 0)];
      await Promise.all([saveJson(RANK_PATH, rank), saveJson(STAT_PATH, stats)]);

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, correct: ok, pick: pick, answer: quiz.answer, explain: quiz.explain || '', stat: stats[id] });
      return;
    }

    // ---- 퀴즈 내기 ----
    if (action === 'create') {
      const qText = clean(body.q, 200);
      const cat = CATS.indexOf(body.cat) >= 0 ? body.cat : '기타';
      const rawChoices = Array.isArray(body.choices) ? body.choices : [];
      const choices = rawChoices.map((c) => clean(c, 60)).filter((c) => c.length > 0);
      const answer = parseInt(body.answer, 10);
      const explain = clean(body.explain, 300);
      if (qText.length < 4) { res.status(400).json({ error: 'short-q' }); return; }
      if (choices.length < 2 || choices.length > 4 || choices.length !== rawChoices.length) { res.status(400).json({ error: 'bad-choices' }); return; }
      if (!(answer >= 0 && answer < choices.length)) { res.status(400).json({ error: 'bad-answer' }); return; }

      const now = Date.now();
      const id = String(now).padStart(15, '0') + '-' + Math.random().toString(36).slice(2, 8);
      const quiz = {
        id: id, sub: String(sess.sub), name: clean(sess.name, 40) || '익명',
        cat: cat, q: qText, choices: choices, answer: answer, explain: explain,
        time: new Date(now).toISOString(),
      };
      try {
        await put(Q_DIR + id + '.json', JSON.stringify(quiz), {
          access: 'public', addRandomSuffix: false, allowOverwrite: false,
          contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 31536000,
        });
      } catch (e) { res.status(500).json({ error: 'save-failed' }); return; }
      let qs = await rebuildAgg({ ensure: quiz });
      if (!qs) qs = [quiz].concat(await loadAgg());
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, quizzes: qs.slice(0, MAX_SHOW).map(publicQuiz) });
      return;
    }

    res.status(400).json({ error: 'bad-action' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
