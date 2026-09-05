// 성경 사이트 – 성경 읽기 진도표 API (로그인한 본인만)
// GET                    → { read: { "<책 순번>": { at } } }
// POST {index, checked}  → 그 책의 읽음 여부 저장/해제
//
// 유저별 파일 bible/read/<sub해시>.json = { "0": {at}, "5": {at}, ... }  (책 순번을 키로)

const crypto = require('crypto');
const { put } = require('@vercel/blob');
const { verifySession, blobBase, blobStoreId } = require('./auth');

const DIR = 'bible/read/';
const BOOK_COUNT = 73;

function fileFor(sub) {
  return DIR + crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 40) + '.json';
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

module.exports = async (req, res) => {
  if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }
  const sess = verifySession(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }

  try {
    if (req.method === 'GET') {
      const read = await load(sess.sub);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ read: read });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const idx = Math.floor(Number(body.index));
      if (!isFinite(idx) || idx < 0 || idx >= BOOK_COUNT) { res.status(400).json({ error: 'bad-index' }); return; }
      const read = await load(sess.sub);
      if (body.checked) read[idx] = { at: new Date().toISOString() };
      else delete read[idx];
      await save(sess.sub, read);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, read: read });
      return;
    }

    res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
