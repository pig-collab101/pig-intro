// 성경 사이트 – 말씀 게임 점수 랭킹 API
// POST {game, score}  (로그인 필요) → 그 게임의 개인 최고점 갱신 + 랭킹 집계 재생성
// GET  ?game=<키>     → 그 게임 상위 20명 [{name, score}]  (누구나 조회)
// GET                 → 전체 게임 랭킹 { game: [...] }
//
// 유저별 파일 bible/gs/<sub해시>.json = { name, scores: { game: best } }
// 읽기용 집계 bible/ranking.json = { game: [ {name, score} ... 상위 20 ] }

const crypto = require('crypto');
const { put, list } = require('@vercel/blob');
const { verifySession, blobBase, blobStoreId } = require('./auth');

const DIR = 'bible/gs/';
const RANK_PATH = 'bible/ranking.json';
const GAMES = ['cho', 'speed', 'order', 'who', 'parable', 'number', 'prayer'];
const TOP = 20;

function fileFor(sub) {
  return DIR + crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 40) + '.json';
}

async function loadJson(url) {
  try { const r = await fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' }); return r.ok ? await r.json() : null; }
  catch (e) { return null; }
}
async function loadUser(sub) {
  const base = blobBase();
  if (!base) return null;
  const d = await loadJson(`${base}/${fileFor(sub)}`);
  return (d && typeof d === 'object') ? d : null;
}
function saveUser(sub, obj) {
  return put(fileFor(sub), JSON.stringify(obj), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
  });
}
async function loadRanking() {
  const base = blobBase();
  if (!base) return {};
  const d = await loadJson(`${base}/${RANK_PATH}`);
  return (d && typeof d === 'object') ? d : {};
}
async function rebuildRanking() {
  let blobs = [];
  try { blobs = (await list({ prefix: DIR, limit: 5000 })).blobs || []; } catch (e) { return null; }
  const users = await Promise.all(blobs.map(function (b) { return loadJson(b.url); }));
  const out = {};
  GAMES.forEach(function (g) { out[g] = []; });
  users.filter(Boolean).forEach(function (u) {
    if (!u.name || !u.scores) return;
    GAMES.forEach(function (g) {
      if (typeof u.scores[g] === 'number') out[g].push({ name: String(u.name).slice(0, 16), score: u.scores[g] });
    });
  });
  GAMES.forEach(function (g) {
    out[g].sort(function (a, b) { return b.score - a.score; });
    out[g] = out[g].slice(0, TOP);
  });
  try {
    await put(RANK_PATH, JSON.stringify(out), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
    });
  } catch (e) { /* 다음 제출 때 복구 */ }
  return out;
}

module.exports = async (req, res) => {
  if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }

  try {
    if (req.method === 'GET') {
      const rank = await loadRanking();
      const g = req.query && req.query.game;
      res.setHeader('Cache-Control', 'public, max-age=30');
      res.status(200).json(g ? { game: g, list: rank[g] || [] } : rank);
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }

    const sess = verifySession(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }

    const body = req.body || {};
    const game = String(body.game || '');
    const score = Math.floor(Number(body.score));
    if (GAMES.indexOf(game) < 0) { res.status(400).json({ error: 'bad-game' }); return; }
    if (!isFinite(score) || score < 0 || score > 100000) { res.status(400).json({ error: 'bad-score' }); return; }

    const u = (await loadUser(sess.sub)) || { name: '', scores: {} };
    u.name = String(sess.name || u.name || '익명').slice(0, 16);
    if (!u.scores || typeof u.scores !== 'object') u.scores = {};

    let updated = false;
    if (typeof u.scores[game] !== 'number' || score > u.scores[game]) {
      u.scores[game] = score;
      updated = true;
      await saveUser(sess.sub, u);
    }

    let rank = null;
    if (updated) rank = await rebuildRanking();

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, updated: updated, best: u.scores[game], ranking: rank });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
