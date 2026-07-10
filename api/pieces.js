// 체스메이커 온라인 기물 공유 API (Vercel 서버리스 함수 + Vercel Blob 저장소)
// 프로젝트에 Blob 저장소가 연결되어 있으면(BLOB_READ_WRITE_TOKEN) 자동으로 작동해요.
// 없으면 503을 돌려주고, 게임은 알아서 오프라인 모드(localStorage)로 동작합니다.

const { put } = require('@vercel/blob');

const PATH = 'chessmaker/pieces.json';

// 저장소 공개 주소를 토큰에서 뽑아내요 (vercel_blob_rw_<스토어ID>_<비밀>)
// 읽을 때 비싼 list() 대신 공개 URL을 바로 가져와서 작업 횟수를 크게 아껴요.
function blobBase() {
  const m = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([^_]+)_/);
  return m ? `https://${m[1].toLowerCase()}.public.blob.vercel-storage.com` : '';
}

async function load() {
  const base = blobBase();
  if (!base) return {};
  // 캐시를 피하려고 매번 다른 주소로 읽어요
  const r = await fetch(`${base}/${PATH}?v=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) return {};
  try { return await r.json(); } catch (e) { return {}; }
}

function save(db) {
  return put(PATH, JSON.stringify(db), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

module.exports = async (req, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) { res.status(503).json({ error: 'no-db' }); return; }
  try {
    if (req.method === 'GET') {
      // 모든 공유 기물을 선택 횟수 많은 순으로
      const db = await load();
      const out = Object.values(db).sort((a, b) => (b.cnt || 0) - (a.cnt || 0));
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(out);

    } else if (req.method === 'POST') {
      const body = req.body || {};

      if (body.action === 'add' && body.piece && body.piece.id) {
        const p = body.piece;
        const clean = {
          id: String(p.id).slice(0, 40),
          nm: String(p.nm || '?').slice(0, 12),
          emoji: String(p.emoji || '⭐').slice(0, 4),
          img: typeof p.img === 'string' && p.img.startsWith('data:image/') && p.img.length < 50000 ? p.img : null,
          moves: (Array.isArray(p.moves) ? p.moves : []).slice(0, 10).map(String),
          specials: (Array.isArray(p.specials) ? p.specials : []).slice(0, 10).map(String),
          ds: String(p.ds || '').slice(0, 300),
        };
        if (clean.moves.length === 0) { res.status(400).json({ error: 'no-moves' }); return; }
        const db = await load();
        if (!db[clean.id] && Object.keys(db).length >= 500) { res.status(507).json({ error: 'full' }); return; }
        clean.cnt = db[clean.id] ? (db[clean.id].cnt || 0) : 0; // 선택 횟수는 서버 기록을 믿어요
        db[clean.id] = clean;
        await save(db);
        res.status(200).json({ ok: true });

      } else if (body.action === 'pick' && Array.isArray(body.ids)) {
        const db = await load();
        let changed = false;
        body.ids.slice(0, 8).forEach(id => {
          const p = db[String(id)];
          if (p) { p.cnt = (p.cnt || 0) + 1; changed = true; }
        });
        if (changed) await save(db);
        res.status(200).json({ ok: true });

      } else res.status(400).json({ error: 'bad-request' });

    } else res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
