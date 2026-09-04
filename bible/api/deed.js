// 성경 사이트 – 1일 1선행 기록 API (로그인한 본인만)
// GET               → { today, days: { "YYYY-MM-DD": { note, at, shared } } }
// GET ?feed=1       → { today, feed: [ { note, at } ] }  오늘 익명으로 함께 나눈 선행들
// POST {date?, note, share}  → 그 날짜(기본: 오늘) 선행 저장/수정. share=true 면 오늘분을 익명 피드에 함께 나눔
// DELETE ?date=     → 그 날짜 기록 삭제 (피드에서도 제거)
//
// 유저별 파일 bible/deed/<sub해시>.json + 익명 피드 bible/dfeed/<날짜>/<sub해시>.json

const crypto = require('crypto');
const { put, del, list } = require('@vercel/blob');
const { verifySession, blobBase, blobStoreId } = require('./auth');

const DIR = 'bible/deed/';
const FEED_DIR = 'bible/dfeed/';
const MAX_NOTE = 200;
const MAX_DAYS = 500;
const MAX_FEED = 60;

function h40(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 40); }
function fileFor(sub) { return DIR + h40(sub) + '.json'; }
function feedFile(date, sub) { return FEED_DIR + date + '/' + h40(sub) + '.json'; }
function kstToday() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime());
}

async function load(sub) {
  const base = blobBase();
  if (!base) return {};
  try {
    const r = await fetch(`${base}/${fileFor(sub)}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return {};
    const d = await r.json();
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch (e) { return {}; }
}
function save(sub, data) {
  return put(fileFor(sub), JSON.stringify(data), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
  });
}
function shareToFeed(date, sub, note) {
  return put(feedFile(date, sub), JSON.stringify({ note: note, at: new Date().toISOString() }), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
  }).catch(function () {});
}
function unshareFeed(date, sub) { return del(feedFile(date, sub)).catch(function () {}); }

async function loadFeed(date) {
  let blobs = [];
  try { blobs = (await list({ prefix: FEED_DIR + date + '/', limit: 500 })).blobs || []; } catch (e) { return []; }
  const items = await Promise.all(blobs.map(async function (b) {
    try { const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' }); return r.ok ? await r.json() : null; }
    catch (e) { return null; }
  }));
  return items.filter(Boolean)
    .filter(function (x) { return x.note; })
    .sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); })
    .slice(0, MAX_FEED);
}

module.exports = async (req, res) => {
  if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }
  const sess = verifySession(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }

  const today = kstToday();
  try {
    if (req.method === 'GET') {
      if (req.query && req.query.feed === '1') {
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ today: today, feed: await loadFeed(today) });
        return;
      }
      const days = await load(sess.sub);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ today: today, days: days });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const date = validDate(body.date) ? body.date : today;
      if (date > today) { res.status(400).json({ error: 'future' }); return; }
      const note = String(body.note == null ? '' : body.note).replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
      const share = !!body.share && date === today && note.length > 0;

      const days = await load(sess.sub);
      days[date] = { note: note, at: new Date().toISOString(), shared: share };
      const keys = Object.keys(days).sort();
      if (keys.length > MAX_DAYS) keys.slice(0, keys.length - MAX_DAYS).forEach(function (k) { delete days[k]; });
      await save(sess.sub, days);

      if (date === today) {
        if (share) await shareToFeed(today, sess.sub, note);
        else await unshareFeed(today, sess.sub);
      }

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, today: today, days: days });
      return;
    }

    if (req.method === 'DELETE') {
      const date = String((req.query && req.query.date) || '');
      if (!validDate(date)) { res.status(400).json({ error: 'bad-date' }); return; }
      const days = await load(sess.sub);
      delete days[date];
      await save(sess.sub, days);
      await unshareFeed(date, sess.sub);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, today: today, days: days });
      return;
    }

    res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
