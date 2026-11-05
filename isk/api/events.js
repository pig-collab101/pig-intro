// I.S.K 모임 사이트 – 모임 일정 + 참석/불참
// GET                                         → { events:[{id,title,date,time,place,memo,by,created,yes:[이름],no:[이름]}] } (날짜순)
// POST {action:'create', title,date,time,place,memo} → 일정 올리기 (관리자만)
// POST {action:'delete', id}                  → 일정 지우기 (관리자만, 참석 응답도 같이)
// POST {action:'rsvp', id, ans:'yes'|'no'|'none'} → 참석/불참/취소 (로그인 멤버)
//
// 저장은 불변 개별 파일 (공용 JSON 을 읽고-고쳐-쓰면 CDN 지연으로 유실됨):
//   일정 isk/ev/<15자리ts>-<rand>.json
//   응답 isk/rsvp/<일정id>/<sub hex>__<yes|no>__<이름 hex>.json  (사람당 1개, 바꾸면 예전 것 지움)
//   집계 isk/events.json ← 쓰고 지울 때만 list() 로 다시 만듦

const { put, list, del } = require('@vercel/blob');
const { verifySession, isAdmin, isBanned, blobBase, blobStoreId } = require('./auth');

const EV_DIR = 'isk/ev/';
const RSVP_DIR = 'isk/rsvp/';
const AGG_PATH = 'isk/events.json';

function clean(s, max) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanBody(s, max) { return String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim().slice(0, max); }
function safeId(s) { return String(s || '').replace(/[^0-9a-z-]/gi, '').slice(0, 40); }
function hexOf(s) { return Buffer.from(String(s), 'utf8').toString('hex'); }
function unhex(h) { try { return /^[0-9a-f]+$/.test(h) ? Buffer.from(h, 'hex').toString('utf8') : ''; } catch (e) { return ''; } }

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

// 일정 + 응답 파일로 집계를 다시 만듦
// opts: { ensure: 방금 만든 일정, excludeId: 방금 지운 일정, rsvp: {id, sub, name, ans} 방금 바꾼 응답 } — list() 반영 지연 대비
async function rebuild(opts) {
  opts = opts || {};
  let eb, rb;
  try { eb = await listAll(EV_DIR); rb = await listAll(RSVP_DIR); } catch (e) { return null; }
  const items = await Promise.all(eb.map(async (b) => {
    try { const r = await fetch(b.url, { cache: 'force-cache' }); return r.ok ? await r.json() : null; }
    catch (e) { return null; }
  }));
  let evs = items.filter(Boolean);
  if (opts.excludeId) evs = evs.filter((e) => e.id !== opts.excludeId);
  if (opts.ensure && !evs.some((e) => e.id === opts.ensure.id)) evs.push(opts.ensure);

  // 일정별 { sub: {ans, name} }
  const ans = {};
  rb.forEach((b) => {
    const m = b.pathname.slice(RSVP_DIR.length).match(/^([0-9a-z-]+)\/([0-9a-f]+)__(yes|no)__([0-9a-f]+)\.json$/);
    if (!m) return;
    const sub = unhex(m[2]);
    (ans[m[1]] = ans[m[1]] || {})[sub] = { ans: m[3], name: unhex(m[4]) };
  });
  if (opts.rsvp) {
    const a = (ans[opts.rsvp.id] = ans[opts.rsvp.id] || {});
    if (opts.rsvp.ans === 'none') delete a[opts.rsvp.sub];
    else a[opts.rsvp.sub] = { ans: opts.rsvp.ans, name: opts.rsvp.name };
  }

  evs = evs.map((e) => {
    const a = ans[e.id] || {};
    const yes = [], no = [];
    Object.keys(a).forEach((sub) => { (a[sub].ans === 'yes' ? yes : no).push(a[sub].name); });
    return Object.assign({}, e, { yes: yes, no: no });
  }).sort((x, y) => (x.date + ' ' + (x.time || '')).localeCompare(y.date + ' ' + (y.time || '')));

  try {
    await put(AGG_PATH, JSON.stringify(evs), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
    });
  } catch (e) { /* 다음에 쓸 때 복구됨 */ }
  return evs;
}

module.exports = async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET') { res.status(200).json({ events: await loadAgg() }); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }
    if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }

    const sess = verifySession(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }
    const admin = isAdmin(sess);
    const body = req.body || {};

    if (body.action === 'create') {
      if (!admin) { res.status(403).json({ error: 'not-admin' }); return; }
      const ev = {
        id: String(Date.now()).padStart(15, '0') + '-' + Math.random().toString(36).slice(2, 8),
        title: clean(body.title, 60), date: clean(body.date, 10), time: clean(body.time, 5),
        place: clean(body.place, 80), memo: cleanBody(body.memo, 1000),
        by: String(sess.name || ''), created: new Date().toISOString(),
      };
      if (!ev.title) { res.status(400).json({ error: 'no-title' }); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) { res.status(400).json({ error: 'bad-date' }); return; }
      if (ev.time && !/^\d{2}:\d{2}$/.test(ev.time)) ev.time = '';
      await put(EV_DIR + ev.id + '.json', JSON.stringify(ev), {
        access: 'public', addRandomSuffix: false, allowOverwrite: false,
        contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 31536000,
      });
      const evs = await rebuild({ ensure: ev });
      res.status(200).json({ ok: true, event: ev, events: evs || undefined });
      return;
    }

    if (body.action === 'delete') {
      if (!admin) { res.status(403).json({ error: 'not-admin' }); return; }
      const id = safeId(body.id);
      if (!id) { res.status(400).json({ error: 'no-id' }); return; }
      try { await del(EV_DIR + id + '.json'); } catch (e) { /* 이미 없음 */ }
      try { const rb = await listAll(RSVP_DIR + id + '/'); if (rb.length) await del(rb.map((b) => b.url)); } catch (e) { /* 무시 */ }
      const evs = await rebuild({ excludeId: id });
      res.status(200).json({ ok: true, events: evs || undefined });
      return;
    }

    if (body.action === 'rsvp') {
      if (await isBanned(sess.name)) { res.status(403).json({ error: 'banned' }); return; }
      const id = safeId(body.id);
      const a = ['yes', 'no', 'none'].indexOf(body.ans) >= 0 ? body.ans : 'none';
      if (!id) { res.status(400).json({ error: 'no-id' }); return; }
      if (!(await loadAgg()).some((e) => e.id === id)) {
        // 집계가 아직 안 따라왔을 수도 있으니 파일로 한 번 더 확인
        try { const r = await list({ prefix: EV_DIR + id + '.json', limit: 1 }); if (!(r.blobs || []).length) { res.status(404).json({ error: 'not-found' }); return; } }
        catch (e) { res.status(404).json({ error: 'not-found' }); return; }
      }
      const prefix = RSVP_DIR + id + '/' + hexOf(sess.sub) + '__';
      try { const old = (await list({ prefix: prefix, limit: 10 })).blobs || []; if (old.length) await del(old.map((b) => b.url)); } catch (e) { /* 무시 */ }
      const name = clean(sess.name, 40);
      if (a !== 'none') {
        await put(prefix + a + '__' + hexOf(name) + '.json', '{}', {
          access: 'public', addRandomSuffix: false, allowOverwrite: true,
          contentType: 'application/json; charset=utf-8',
        });
      }
      const evs = await rebuild({ rsvp: { id: id, sub: String(sess.sub), name: name, ans: a } });
      res.status(200).json({ ok: true, events: evs || undefined });
      return;
    }

    res.status(400).json({ error: 'bad-action' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
