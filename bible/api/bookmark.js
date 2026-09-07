// 성경 사이트 – 구절 즐겨찾기 API (로그인한 본인만)
// GET                 → { items: [ {id, ref, source, subtitle, date, at} ... ] }  (최신순)
// POST {ref, source, subtitle, date} → 즐겨찾기 추가
// DELETE ?id=         → 즐겨찾기 삭제
//
// 유저별 파일 bible/bookmark/<sub해시>.json = 배열

const crypto = require('crypto');
const { put } = require('@vercel/blob');
const { verifySession, blobBase, blobStoreId } = require('./auth');

const DIR = 'bible/bookmark/';
const MAX_ITEMS = 300;

function fileFor(sub) {
  return DIR + crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 40) + '.json';
}
async function load(sub) {
  const base = blobBase();
  if (!base) return [];
  try {
    const r = await fetch(`${base}/${fileFor(sub)}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch (e) { return []; }
}
function save(sub, arr) {
  return put(fileFor(sub), JSON.stringify(arr), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
  });
}
function clean(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

module.exports = async (req, res) => {
  if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }
  const sess = verifySession(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }

  try {
    if (req.method === 'GET') {
      const items = await load(sess.sub);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ items: items.slice().reverse() });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const ref = clean(body.ref, 60);
      if (!ref) { res.status(400).json({ error: 'no-ref' }); return; }
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ref: ref,
        source: clean(body.source, 40),
        subtitle: clean(body.subtitle, 200),
        date: clean(body.date, 20),
        at: new Date().toISOString(),
      };
      const items = await load(sess.sub);
      if (items.some((x) => x.ref === ref)) { res.status(200).json({ ok: true, items: items.slice().reverse(), duplicate: true }); return; }
      items.push(item);
      const trimmed = items.slice(-MAX_ITEMS);
      await save(sess.sub, trimmed);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, items: trimmed.slice().reverse() });
      return;
    }

    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '');
      if (!id) { res.status(400).json({ error: 'no-id' }); return; }
      const items = await load(sess.sub);
      const next = items.filter((x) => x.id !== id);
      await save(sess.sub, next);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, items: next.slice().reverse() });
      return;
    }

    res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
