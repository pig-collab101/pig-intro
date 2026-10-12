// 과학 퀴즈 사이트 – 퀴즈 주고받기 API (Vercel 서버리스 함수 + Vercel Blob 저장소)
// GET                         → { quizzes:[정답 뺀 목록], stats:{id:[푼사람, 맞힌사람]} }
// GET ?me=1                   → { solved:{id:{ok,pick}}, me:{랭킹 한 줄} }   (로그인 필요)
// GET ?rank=1                 → { rank:[{sub,name,score,correct,tries,made,received}] }
// POST {action:'create', cat, lv, q, choices[], answer, explain} → 퀴즈 내기 (lv 1=브론즈5 … 30=루비1)
// POST {action:'solve', id, pick}  → 퀴즈 풀기 (1인 1회, 내 퀴즈는 못 품) → {correct, answer, explain}
// POST {action:'report', id}       → 퀴즈 신고
// POST {action:'ban'|'unban', name} → 관리자 추방/해제
// POST {action:'rankdel', sub}     → 관리자: 랭킹에서 지우기
// DELETE ?id=X                     → 퀴즈 삭제 (본인 퀴즈, 또는 관리자)
//
// 퀴즈 = 개별 불변 파일 sci/q/<id>.json, 읽기용 집계 sci/quizzes.json (등록/삭제 때만 재생성)
// 풀이 잠금 = sci/a/<id>__<유저해시>.json (allowOverwrite:false 로 1인 1회 보장)
// 풀이 기록 = sci/r/<유저해시>/<id>_<맞음1|0>_<고른번호>_<얻은점수>_<이름hex>.json  (경로에 정보를 담아 list() 만으로 집계)
// 집계 = sci/stats.json { stats:{id:[도전,정답]}, users:{유저해시:{name,correct,tries}}, hidden:[] } — 풀이 때마다 list() 로 새로 만듦
// (Blob 공개 URL 은 최대 60초 늦게 반영되므로 공용 파일을 읽고-고쳐-쓰는 방식은 쓰지 않음)
// 랭킹 제외 = sci/hide/<유저해시>.json

const crypto = require('crypto');
const { put, list, del, head } = require('@vercel/blob');
const { verifySession, isAdmin, isBanned, banName, unbanName, blobBase, blobStoreId } = require('./auth');

const AGG_PATH = 'sci/quizzes.json';
const Q_DIR = 'sci/q/';
const A_DIR = 'sci/a/';
const R_DIR = 'sci/r/';
const HIDE_DIR = 'sci/hide/';
const REP_DIR = 'sci/rep/';
const STATS_PATH = 'sci/stats.json';
const CATS = ['물리', '화학', '생명과학', '지구과학', '기타'];
const MAX_SHOW = 200;

// 맞히면 난이도 점수: 브론즈5 = 5점, 한 단계 오를 때마다 +1 (루비1 = 34점). 난이도 없는 예전 퀴즈 = 5점
const MAX_LV = 30;
function quizPoints(q) { return q && q.lv >= 1 && q.lv <= MAX_LV ? q.lv + 4 : 5; }
const PTS_MADE = 5;
const PTS_RECEIVED = 1;

function subHash(sub) {
  return crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 40);
}
function hex(s) { return Buffer.from(String(s), 'utf8').toString('hex'); }
function unhex(h) { try { return Buffer.from(h, 'hex').toString('utf8'); } catch (e) { return ''; } }
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
  return { id: q.id, sub: q.sub, name: q.name, cat: q.cat, lv: q.lv || 0, q: q.q, choices: q.choices, time: q.time };
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

async function listAll(prefix) {
  let out = [], cursor;
  for (let i = 0; i < 20; i++) {
    const r = await list({ prefix: prefix, limit: 1000, cursor: cursor });
    out = out.concat(r.blobs || []);
    if (!r.hasMore) break;
    cursor = r.cursor;
  }
  return out;
}
// sci/r/<h>/<id>_<ok>_<pick>_<pts>_<namehex>.json → { h, id, ok, pick, pts, name }
// (점수 칸이 없는 예전 형식 <id>_<ok>_<pick>_<namehex> 도 읽음 — 맞았으면 10점)
function parseRecord(pathname) {
  const m = /^sci\/r\/([0-9a-f]+)\/([0-9a-z_-]+)\.json$/.exec(pathname);
  if (!m) return null;
  const parts = m[2].split('_');
  if (parts.length !== 4 && parts.length !== 5) return null;
  const ok = parts[1] === '1';
  const pts = parts.length === 5 ? (+parts[3] || 0) : (ok ? 10 : 0);
  return { h: m[1], id: parts[0], ok: ok, pick: +parts[2], pts: ok ? pts : 0, name: unhex(parts[parts.length - 1]) };
}
function recordPath(h, id, ok, pick, pts, name) {
  return R_DIR + h + '/' + id + '_' + (ok ? 1 : 0) + '_' + pick + '_' + pts + '_' + hex(name) + '.json';
}

// 풀이 기록 전체를 list() 로 모아 집계 파일을 다시 만듦 (풀이·랭킹제외 때만 호출)
// ensure: 방금 저장한 기록 (list 반영 지연 대비)
async function rebuildStats(ensure) {
  let recs = [], hidden = [];
  try {
    const [rb, hb] = await Promise.all([listAll(R_DIR), listAll(HIDE_DIR)]);
    recs = rb.map((b) => parseRecord(b.pathname)).filter(Boolean);
    hidden = hb.map((b) => b.pathname.slice(HIDE_DIR.length).replace(/\.json$/, ''));
  } catch (e) { return null; }
  if (ensure && !recs.some((r) => r.h === ensure.h && r.id === ensure.id)) recs.push(ensure);
  if (ensure && ensure.hide && hidden.indexOf(ensure.hide) < 0) hidden.push(ensure.hide);
  const stats = {}, users = {};
  recs.forEach((r) => {
    if (!r.id) return;
    const st = stats[r.id] || (stats[r.id] = [0, 0]);
    st[0] += 1; if (r.ok) st[1] += 1;
    const u = users[r.h] || (users[r.h] = { name: r.name, correct: 0, tries: 0, points: 0 });
    u.tries += 1; if (r.ok) { u.correct += 1; u.points += r.pts || 0; }
  });
  const data = { stats: stats, users: users, hidden: hidden, at: new Date().toISOString() };
  try { await saveJson(STATS_PATH, data); } catch (e) { /* 다음 풀이 때 복구 */ }
  return data;
}
async function loadStats() {
  const d = await loadObj(STATS_PATH);
  return { stats: d.stats || {}, users: d.users || {}, hidden: d.hidden || [] };
}

// 전체 사용자 줄 (점수순). 랭킹은 앞 100명만, ?me=1 은 내 줄만 씀
function buildRank(quizzes, data) {
  const hidden = {};
  (data.hidden || []).forEach((h) => { hidden[h] = 1; });
  const rows = {};
  function row(name) {
    const sub = 'local:' + String(name).toLowerCase();
    const h = subHash(sub);
    if (hidden[h]) return null;
    return rows[h] || (rows[h] = { sub: sub, name: name, correct: 0, tries: 0, points: 0, made: 0, received: 0 });
  }
  Object.keys(data.users).forEach((h) => {
    const u = data.users[h];
    const r = row(u.name);
    if (r) { r.correct = u.correct; r.tries = u.tries; r.points = u.points != null ? u.points : u.correct * 10; }
  });
  quizzes.forEach((q) => {
    const r = row(q.name);
    if (!r) return;
    r.made += 1;
    const st = data.stats[q.id];
    if (Array.isArray(st)) r.received += st[0] || 0;
  });
  return Object.values(rows)
    .map((r) => Object.assign(r, { score: r.points + r.made * PTS_MADE + r.received * PTS_RECEIVED }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.correct - a.correct);
}

module.exports = async (req, res) => {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const sess = verifySession(token);

    if (req.method === 'GET') {
      const q = req.query || {};
      res.setHeader('Cache-Control', 'no-store');
      if (q.rank === '1') {
        const [quizzes, data] = await Promise.all([loadAgg(), loadStats()]);
        res.status(200).json({ rank: buildRank(quizzes, data).slice(0, 100) });
        return;
      }
      if (q.me === '1') {
        if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }
        const solved = {};
        const [mineList, quizzes, data] = await Promise.all([
          listAll(R_DIR + subHash(sess.sub) + '/').catch(() => []), loadAgg(), loadStats(),
        ]);
        mineList.forEach((b) => {
          const r = parseRecord(b.pathname);
          if (r) solved[r.id] = { ok: r.ok, pick: r.pick, pts: r.pts };
        });
        // 내 점수는 내 풀이 기록(list, 최신)으로 덮어써서 집계 지연 없이 보여줌
        const h = subHash(sess.sub);
        const vals = Object.values(solved);
        data.users[h] = { name: sess.name, tries: vals.length, correct: vals.filter((v) => v.ok).length, points: vals.reduce((a, v) => a + (v.pts || 0), 0) };
        const rows = buildRank(quizzes, data);
        const idx = rows.findIndex((r) => r.sub === sess.sub);
        const me = idx >= 0 ? Object.assign({ place: idx + 1 }, rows[idx]) : { sub: sess.sub, name: sess.name, score: 0, correct: 0, tries: 0, points: 0, made: 0, received: 0 };
        res.status(200).json({ solved: solved, me: me });
        return;
      }
      const [quizzes, data] = await Promise.all([loadAgg(), loadStats()]);
      res.status(200).json({ quizzes: quizzes.slice(0, MAX_SHOW).map(publicQuiz), stats: data.stats });
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
      await saveJson(HIDE_DIR + subHash(sub) + '.json', { sub: sub, by: sess.name, at: new Date().toISOString() });
      let data = await rebuildStats({ hide: subHash(sub) });
      if (!data) { data = await loadStats(); data.hidden.push(subHash(sub)); }
      res.status(200).json({ ok: true, rank: buildRank(await loadAgg(), data).slice(0, 100) });
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
        res.status(409).json({ error: 'already', correct: !!(prev && prev.ok), pick: prev ? prev.pick : null, pts: prev && prev.ok ? quizPoints(quiz) : 0, answer: quiz.answer, explain: quiz.explain || '' });
        return;
      }
      const name = clean(sess.name, 16);
      const pts = ok ? quizPoints(quiz) : 0;
      try {
        await put(recordPath(h, id, ok, pick, pts, name), '1', {
          access: 'public', addRandomSuffix: false, allowOverwrite: true,
          contentType: 'text/plain', cacheControlMaxAge: 31536000,
        });
      } catch (e) { /* 잠금 파일은 이미 있음 — 집계에서만 빠짐 */ }
      const data = await rebuildStats({ h: h, id: id, ok: ok, pick: pick, pts: pts, name: name });
      const stat = (data && data.stats[id]) || null;

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, correct: ok, pick: pick, pts: pts, answer: quiz.answer, explain: quiz.explain || '', stat: stat });
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
      // 난이도를 안 보내는 예전 화면(새로고침 전 탭)에서 낸 퀴즈는 '난이도 없음'(0)으로 받음
      const lv = body.lv == null || body.lv === '' ? 0 : parseInt(body.lv, 10);
      if (!(lv === 0 || (lv >= 1 && lv <= MAX_LV))) { res.status(400).json({ error: 'bad-lv' }); return; }
      if (qText.length < 4) { res.status(400).json({ error: 'short-q' }); return; }
      if (choices.length < 2 || choices.length > 4 || choices.length !== rawChoices.length) { res.status(400).json({ error: 'bad-choices' }); return; }
      if (!(answer >= 0 && answer < choices.length)) { res.status(400).json({ error: 'bad-answer' }); return; }

      const now = Date.now();
      const id = String(now).padStart(15, '0') + '-' + Math.random().toString(36).slice(2, 8);
      const quiz = {
        id: id, sub: String(sess.sub), name: clean(sess.name, 40) || '익명',
        cat: cat, lv: lv, q: qText, choices: choices, answer: answer, explain: explain,
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
