// 생태계 3D – 로그인 + 동물 뽑기 + 생애 기록 + 랭킹 API (Vercel 서버리스 + Vercel Blob)
// 계정은 2026 비행기 슈팅(api/sky.js)과 같은 계정을 씀 (sky/u/<이름해시>.json, 같은 비밀번호 규칙·같은 토큰)
//
// POST { action, ... }   (로그인 후에는 Authorization: Bearer <토큰>)
//   signup / login {name, pw}  → {token, name, profile}
//   profile                    → {profile}
//   start                      → {ticket, species}     서버가 희귀도 확률로 동물을 뽑음 (고를 수 없음)
//   finish {ticket, secs, hunts, grazes, corpses, babies, grown, missions} → {score, profile, newBest, newSpeciesBest, newDex}
// GET ?rank=all | ?rank=dex | ?rank=<종번호>  → {list:[{name, score, sp}]}   (30초 캐시)
//
// 생애 기록 = 사건 파일 eco/e/<유저해시>/<순번6자리>.json  (allowOverwrite:false → 같은 표로 두 번 기록 불가)
// 랭킹 = 자기 최고를 깰 때만 빈 파일 하나. 정보는 경로에:
//   eco/r/all/<9999999999-점수>_<종3>_<유저해시8>_<이름hex>.json
//   eco/r/s<종>/...   (동물별)      eco/r/dex/<9999999999-도감수>_000_...  (도감 완성)

const crypto = require('crypto');
const { put, head, list } = require('@vercel/blob');
const SPECIES = require('./_eco_species.json');   // [[이름, 희귀도, 천적 수], ...] — eco_species.js 순서와 같음

const SALT = 'sky2026-salt';          // sky.js 와 같아야 같은 계정으로 로그인됨
const USER_DIR = 'sky/u/';
const EVENT_DIR = 'eco/e/';
const RANK_DIR = 'eco/r/';
const SESSION_TTL = 60 * 24 * 60 * 60;
const TICKET_TTL = 6 * 60 * 60;
const RARITY_PCT = [['전설', 1.5], ['영웅', 6.5], ['희귀', 22], ['일반', 70]];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nameHash = (name) => sha(String(name).toLowerCase()).slice(0, 40);
const hashPw = (name, pw) => sha(name.toLowerCase() + ':' + pw + ':' + SALT);
function secret() { return process.env.SESSION_SECRET || process.env.BLOB_READ_WRITE_TOKEN || 'sky2026-fallback'; }
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function sign(obj) {
  const body = b64url(JSON.stringify(obj));
  return body + '.' + b64url(crypto.createHmac('sha256', secret()).update(body).digest());
}
function verify(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const expect = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  try { if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null; }
  catch (e) { return null; }
  let p;
  try { p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (e) { return null; }
  if (!p || !p.exp || p.exp * 1000 < Date.now()) return null;
  return p;
}

async function readUser(name) {
  let meta;
  try { meta = await head(USER_DIR + nameHash(name) + '.json'); } catch (e) { return null; }
  try {
    const r = await fetch(meta.url + '?t=' + Date.now(), { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

// ---- 점수: 클라이언트(eco3d.html scoreOf)와 같은 공식 ----
// 천적이 많은 약한 동물일수록 1초당 점수가 큼 (모기 3분 ≈ 사자 10분)
const survivalMult = (sp) => Math.min(6, 1 + 0.4 * SPECIES[sp][2]);
function scoreOf(sp, r) {
  return Math.floor(r.secs * 10 * survivalMult(sp)) + r.hunts * 40 + r.grazes * 2 + r.corpses * 20 +
    r.babies * 150 + (r.grown ? 100 : 0) + r.missions * 200;
}

// ---- 생애 기록 ----
async function loadEvents(h) {
  let blobs = [], cursor;
  do {
    const r = await list({ prefix: EVENT_DIR + h + '/', limit: 1000, cursor });
    blobs = blobs.concat(r.blobs || []);
    cursor = r.hasMore ? r.cursor : null;
  } while (cursor);
  let maxSeq = -1;
  const evs = await Promise.all(blobs.map(async (b) => {
    const m = /\/(\d{6})\.json$/.exec(b.pathname);
    if (!m) return null;
    const seq = +m[1];
    if (seq > maxSeq) maxSeq = seq;
    try {
      const r = await fetch(b.url, { cache: 'force-cache' });   // 사건 파일은 안 바뀜
      if (!r.ok) return null;
      const d = await r.json(); d.seq = seq; return d;
    } catch (e) { return null; }
  }));
  return { evs: evs.filter(Boolean), maxSeq };
}
function summarize(evs) {
  const p = { plays: 0, best: 0, total: 0, dex: {} };
  const tickets = new Set();
  evs.sort((a, b) => a.seq - b.seq).forEach((e) => {
    if (e.k !== 'life') return;
    p.plays++; p.total += e.score; tickets.add(e.t0);
    if (e.score > p.best) p.best = e.score;
    const d = p.dex[e.sp] || (p.dex[e.sp] = { plays: 0, best: 0, secs: 0, hunts: 0 });
    d.plays++; d.hunts += e.hunts;
    if (e.score > d.best) d.best = e.score;
    if (e.secs > d.secs) d.secs = e.secs;
  });
  return { p, tickets };
}
async function addEvent(h, makeEvent) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { evs, maxSeq } = await loadEvents(h);
    const st = summarize(evs);
    const ev = makeEvent(st);
    if (ev.error) return ev;
    const seq = maxSeq + 1 + attempt;
    try {
      await put(EVENT_DIR + h + '/' + String(seq).padStart(6, '0') + '.json', JSON.stringify(ev), {
        access: 'public', addRandomSuffix: false, allowOverwrite: false,
        contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 31536000,
      });
    } catch (e) { continue; }
    ev.seq = seq;
    return { ev, before: st.p, after: summarize(evs.concat([ev])).p };
  }
  return { error: 'busy' };
}

// ---- 랭킹 ----
function rankPath(board, score, sp, h, name) {
  return RANK_DIR + board + '/' + String(9999999999 - score).padStart(10, '0') + '_' + String(sp).padStart(3, '0') + '_' +
    h.slice(0, 8) + '_' + Buffer.from(name, 'utf8').toString('hex') + '.json';
}
async function writeRank(board, score, sp, h, name) {
  try {
    await put(rankPath(board, score, sp, h, name), '{}', {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json', cacheControlMaxAge: 31536000,
    });
  } catch (e) { /* 랭킹 기록 실패는 무시 (생애 기록은 이미 저장됨) */ }
}
async function readRank(board) {
  const r = await list({ prefix: RANK_DIR + board + '/', limit: 400 });
  const seen = new Set(), out = [];
  for (const b of r.blobs || []) {
    const m = /\/(\d{10})_(\d{3})_([0-9a-f]{8})_([0-9a-f]+)\.json$/.exec(b.pathname);
    if (!m || seen.has(m[3])) continue;     // 한 사람은 최고 기록 하나만
    seen.add(m[3]);
    out.push({ name: Buffer.from(m[4], 'hex').toString('utf8'), score: 9999999999 - +m[1], sp: +m[2] });
    if (out.length >= 100) break;
  }
  return out;
}

function drawSpecies() {
  let roll = crypto.randomInt(0, 1000000) / 10000;
  for (const [r, pct] of RARITY_PCT) {
    roll -= pct;
    if (roll < 0 || r === '일반') {
      const idx = SPECIES.map((s, i) => s[1] === r ? i : -1).filter(i => i >= 0);
      return idx[crypto.randomInt(0, idx.length)];
    }
  }
}
const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 12);
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || 0));

module.exports = async (req, res) => {
  if (req.method === 'GET' && req.query && req.query.rank != null) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) { res.status(503).json({ error: 'no-db' }); return; }
    const q = String(req.query.rank), n = parseInt(q, 10);
    const board = q === 'all' || q === 'dex' ? q : (n >= 0 && n < SPECIES.length && String(n) === q ? 's' + n : null);
    if (!board) { res.status(400).json({ error: 'bad-board' }); return; }
    try {
      const listOut = await readRank(board);
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
      res.status(200).json({ list: listOut });
    } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }
  if (!process.env.BLOB_READ_WRITE_TOKEN) { res.status(503).json({ error: 'no-db' }); return; }
  try {
    const body = req.body || {};
    const action = String(body.action || '');
    const now = Math.floor(Date.now() / 1000);

    // ---- 가입 / 로그인 (sky.js 와 같은 계정 파일) ----
    if (action === 'signup' || action === 'login') {
      const name = cleanName(body.name), pw = String(body.pw == null ? '' : body.pw);
      if (name.length < 2) { res.status(400).json({ error: 'bad-name' }); return; }
      if (pw.length < 4 || pw.length > 40) { res.status(400).json({ error: 'bad-pw' }); return; }
      let display = name;
      if (action === 'signup') {
        if (await readUser(name)) { res.status(409).json({ error: 'exists' }); return; }
        try {
          await put(USER_DIR + nameHash(name) + '.json', JSON.stringify({ name, hash: hashPw(name, pw), created: new Date().toISOString() }), {
            access: 'public', addRandomSuffix: false, allowOverwrite: false,
            contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
          });
        } catch (e) { res.status(409).json({ error: 'exists' }); return; }
      } else {
        const u = await readUser(name);
        if (!u || u.hash !== hashPw(name, pw)) { res.status(401).json({ error: 'wrong' }); return; }
        display = u.name || name;
      }
      const sub = nameHash(name);
      const token = sign({ k: 's', sub, name: display, iat: now, exp: now + SESSION_TTL });
      const { evs } = await loadEvents(sub);
      res.status(200).json({ token, name: display, profile: summarize(evs).p });
      return;
    }

    const sess = verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!sess || sess.k !== 's') { res.status(401).json({ error: 'unauthorized' }); return; }
    const h = sess.sub;

    if (action === 'profile') {
      const { evs } = await loadEvents(h);
      res.status(200).json({ name: sess.name, profile: summarize(evs).p });
      return;
    }

    if (action === 'start') {
      const sp = drawSpecies();
      res.status(200).json({ species: SPECIES[sp][0], ticket: sign({ k: 'e', sub: h, sp, t0: Date.now(), exp: now + TICKET_TTL }) });
      return;
    }

    if (action === 'finish') {
      const t = verify(String(body.ticket || ''));
      if (!t || t.k !== 'e' || t.sub !== h) { res.status(400).json({ error: 'bad-ticket' }); return; }
      // 서버가 잰 시간보다 오래 살았다고 할 수 없음, 시간에 비해 너무 많은 활동은 잘라냄
      const secs = Math.min(int(body.secs, 0, 86400), Math.floor((Date.now() - t.t0) / 1000));
      const r = {
        secs,
        hunts: int(body.hunts, 0, Math.floor(secs / 3)),
        grazes: int(body.grazes, 0, Math.floor(secs / 1.2)),
        corpses: int(body.corpses, 0, Math.floor(secs / 2)),
        babies: int(body.babies, 0, Math.floor(secs / 40)),
        grown: body.grown && secs >= 60 ? 1 : 0,
        missions: int(body.missions, 0, Math.min(3, Math.floor(secs / 20))),
      };
      const score = scoreOf(t.sp, r);
      const out = await addEvent(h, (st) => {
        if (st.tickets.has(t.t0)) return { error: 'used' };
        return Object.assign({ k: 'life', sp: t.sp, score, t0: t.t0, at: new Date().toISOString() }, r);
      });
      if (out.error) { res.status(out.error === 'used' ? 409 : 503).json({ error: out.error }); return; }
      const { before, after } = out;
      const prevSp = (before.dex[t.sp] || {}).best || 0;
      const dexBefore = Object.keys(before.dex).length, dexAfter = Object.keys(after.dex).length;
      await Promise.all([
        score > before.best ? writeRank('all', score, t.sp, h, sess.name) : null,
        score > prevSp ? writeRank('s' + t.sp, score, t.sp, h, sess.name) : null,
        dexAfter > dexBefore ? writeRank('dex', dexAfter, 0, h, sess.name) : null,
      ]);
      res.status(200).json({ score, parts: r, profile: after, newBest: score > before.best, newSpeciesBest: score > prevSp, newDex: dexAfter > dexBefore });
      return;
    }

    res.status(400).json({ error: 'bad-action' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
