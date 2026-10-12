// 2026 비행기 슈팅 – 로그인 + 코인 + 기체 튜닝 API (Vercel 서버리스 + Vercel Blob)
// POST { action, ... }   (로그인 후에는 Authorization: Bearer <토큰>)
//   signup / login {name, pw}        → {token, wallet}
//   wallet                           → {wallet}
//   start  {plane}                   → {ticket}            게임 시작 표 (코인 부정 방지)
//   finish {ticket, score, stage, clear} → {earned, wallet}
//   tune   {plane, stat}             → {cost, wallet}      능력치 1단계 올리기
// GET ?rank=all | ?rank=<기체번호>     → {list:[{name, score, plane, clear}]}  랭킹 (30초 캐시)
//
// 계정 = sky/u/<이름해시>.json  (head()로 존재 확인)
// 지갑 = 사건 파일 sky/e/<유저해시>/<순번6자리>.json  (allowOverwrite:false, 내용은 안 바뀜)
//   순번만 경로에 있어서 동시에 두 번 써도 같은 순번은 하나만 성공 → 코인 이중 사용 불가.
//   하나의 지갑 JSON 을 고쳐 쓰면 CDN 지연(최대 60초) 때문에 코인이 사라질 수 있어서 이렇게 함.
// 랭킹 = 자기 최고기록을 깰 때만 빈 파일 하나 기록. 정보는 전부 경로에 들어 있음:
//   sky/r/all/<9999999999-점수>_<기체>_<클리어>_<유저해시8>_<이름hex>.json
//   sky/r/p<기체>/...  (기체별 랭킹)
//   list() 는 경로 순서(=점수 높은 순)로 돌려줘서 파일을 열어 볼 필요가 없음.

const crypto = require('crypto');
const { put, head, list } = require('@vercel/blob');

const SALT = 'sky2026-salt';
const USER_DIR = 'sky/u/';
const EVENT_DIR = 'sky/e/';
const RANK_DIR = 'sky/r/';
const SESSION_TTL = 60 * 24 * 60 * 60;   // 60일
const TICKET_TTL = 3 * 60 * 60;          // 3시간
const START_COINS = 100;
const PLANE_COUNT = 68;
const MAX_TUNE = 3;                       // 능력치마다 최대 +3
const TUNE_COST = [40, 100, 200];         // +1, +2, +3 가격
const MAX_EARN = 800;                     // 한 판 최대 코인

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

// ---- 지갑: 사건 파일을 모두 읽어서 계산 ----
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
      // 사건 파일은 절대 바뀌지 않으니 캐시된 내용을 써도 됨
      const r = await fetch(b.url, { cache: 'force-cache' });
      if (!r.ok) return null;
      const d = await r.json(); d.seq = seq; return d;
    } catch (e) { return null; }
  }));
  return { evs: evs.filter(Boolean), maxSeq };
}
function summarize(evs) {
  const w = { coins: START_COINS, tune: {}, best: {}, clear: {}, plays: 0, earned: 0 };
  const tickets = new Set();
  evs.sort((a, b) => a.seq - b.seq).forEach((e) => {
    if (e.k === 'earn') {
      w.coins += e.coins; w.earned += e.coins; w.plays++;
      if (!(w.best[e.p] >= e.score)) w.best[e.p] = e.score;
      if (e.clear) w.clear[e.p] = 1;
      tickets.add(e.t0);
    } else if (e.k === 'tune') {
      w.coins -= e.cost;
      const t = w.tune[e.p] || (w.tune[e.p] = [0, 0, 0, 0, 0]);
      t[e.s]++;
    }
  });
  return { w, tickets };
}
async function wallet(h) {
  const { evs, maxSeq } = await loadEvents(h);
  const { w, tickets } = summarize(evs);
  return { w, tickets, maxSeq, evs };
}
// 다음 순번에 사건 기록 (같은 순번이 이미 있으면 다시 읽고 재시도)
async function addEvent(h, makeEvent) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const st = await wallet(h);
    const ev = makeEvent(st);
    if (ev.error) return ev;
    const seq = st.maxSeq + 1 + attempt;
    try {
      await put(EVENT_DIR + h + '/' + String(seq).padStart(6, '0') + '.json', JSON.stringify(ev), {
        access: 'public', addRandomSuffix: false, allowOverwrite: false,
        contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 31536000,
      });
    } catch (e) { continue; }
    ev.seq = seq;
    const { w } = summarize(st.evs.concat([ev]));
    return { ev, w };
  }
  return { error: 'busy' };
}

// ---- 랭킹 ----
function rankPath(board, score, plane, clear, h, name) {
  const inv = String(9999999999 - score).padStart(10, '0');
  return RANK_DIR + board + '/' + inv + '_' + String(plane).padStart(2, '0') + '_' + (clear ? 1 : 0) + '_' +
    h.slice(0, 8) + '_' + Buffer.from(name, 'utf8').toString('hex') + '.json';
}
async function writeRank(board, score, plane, clear, h, name) {
  try {
    await put(rankPath(board, score, plane, clear, h, name), '{}', {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json', cacheControlMaxAge: 31536000,
    });
  } catch (e) { /* 랭킹 기록 실패는 무시 (코인은 이미 저장됨) */ }
}
async function readRank(board) {
  const r = await list({ prefix: RANK_DIR + board + '/', limit: 400 });
  const seen = new Set(), out = [];
  for (const b of r.blobs || []) {
    const m = /\/(\d{10})_(\d{2})_([01])_([0-9a-f]{8})_([0-9a-f]+)\.json$/.exec(b.pathname);
    if (!m || seen.has(m[4])) continue;     // 한 사람은 최고 기록 하나만
    seen.add(m[4]);
    out.push({ name: Buffer.from(m[5], 'hex').toString('utf8'), score: 9999999999 - +m[1], plane: +m[2], clear: m[3] === '1' });
    if (out.length >= 100) break;
  }
  return out;
}

const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 12);

module.exports = async (req, res) => {
  if (req.method === 'GET' && req.query && req.query.rank != null) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) { res.status(503).json({ error: 'no-db' }); return; }
    const q = String(req.query.rank);
    const plane = parseInt(q, 10);
    const board = q === 'all' ? 'all' : (plane >= 0 && plane < PLANE_COUNT ? 'p' + plane : null);
    if (!board) { res.status(400).json({ error: 'bad-board' }); return; }
    try {
      const listOut = await readRank(board);
      // 여러 사람이 동시에 봐도 30초 동안은 저장소에 다시 안 물어봄 (작업 횟수 절약)
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

    // ---- 가입 / 로그인 ----
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
      const { w } = await wallet(sub);
      res.status(200).json({ token, name: display, wallet: w });
      return;
    }

    const sess = verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!sess || sess.k !== 's') { res.status(401).json({ error: 'unauthorized' }); return; }
    const h = sess.sub;

    if (action === 'wallet') {
      const { w } = await wallet(h);
      res.status(200).json({ wallet: w });
      return;
    }

    if (action === 'start') {
      const plane = parseInt(body.plane, 10);
      if (!(plane >= 0 && plane < PLANE_COUNT)) { res.status(400).json({ error: 'bad-plane' }); return; }
      const t0 = Date.now();
      res.status(200).json({ ticket: sign({ k: 't', sub: h, p: plane, t0, exp: now + TICKET_TTL }) });
      return;
    }

    if (action === 'finish') {
      const t = verify(String(body.ticket || ''));
      if (!t || t.k !== 't' || t.sub !== h) { res.status(400).json({ error: 'bad-ticket' }); return; }
      const secs = (Date.now() - t.t0) / 1000;
      const clear = !!body.clear;
      const stage = Math.max(0, Math.min(2, parseInt(body.stage, 10) || 0));
      const cleared = clear ? 3 : stage;            // 깬 스테이지 수
      // 걸린 시간에 비해 너무 높은 점수는 깎음
      const score = Math.max(0, Math.min(parseInt(body.score, 10) || 0, Math.floor(secs * 6000), 5000000));
      let coins = Math.floor(score / 5000) + cleared * 30 + (clear ? 100 : 0);
      coins = Math.max(0, Math.min(coins, Math.floor(secs * 1.5), MAX_EARN));
      let prevAll = 0, prevPlane = 0;
      const r = await addEvent(h, (st) => {
        if (st.tickets.has(t.t0)) return { error: 'used' };
        prevAll = Math.max(0, ...Object.values(st.w.best));
        prevPlane = st.w.best[t.p] || 0;
        return { k: 'earn', p: t.p, coins, score, clear: clear && secs > 120 ? 1 : 0, t0: t.t0, at: new Date().toISOString() };
      });
      if (r.error) { res.status(r.error === 'used' ? 409 : 503).json({ error: r.error }); return; }
      // 자기 최고 기록을 깼을 때만 랭킹에 올림
      const rc = r.ev.clear;
      await Promise.all([
        score > prevAll ? writeRank('all', score, t.p, rc, h, sess.name) : null,
        score > prevPlane ? writeRank('p' + t.p, score, t.p, rc, h, sess.name) : null,
      ]);
      res.status(200).json({ earned: coins, wallet: r.w, newBest: score > prevAll, newPlaneBest: score > prevPlane });
      return;
    }

    if (action === 'tune') {
      const plane = parseInt(body.plane, 10), stat = parseInt(body.stat, 10);
      if (!(plane >= 0 && plane < PLANE_COUNT) || !(stat >= 0 && stat < 5)) { res.status(400).json({ error: 'bad-arg' }); return; }
      let cost = 0;
      const r = await addEvent(h, (st) => {
        const lv = (st.w.tune[plane] || [0, 0, 0, 0, 0])[stat];
        if (lv >= MAX_TUNE) return { error: 'max' };
        cost = TUNE_COST[lv];
        if (st.w.coins < cost) return { error: 'no-coins' };
        return { k: 'tune', p: plane, s: stat, cost, at: new Date().toISOString() };
      });
      if (r.error) { res.status(r.error === 'busy' ? 503 : 400).json({ error: r.error }); return; }
      res.status(200).json({ cost, wallet: r.w });
      return;
    }

    res.status(400).json({ error: 'bad-action' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
