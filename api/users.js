// 체스메이커 로그인 + 승리 랭킹 API (Vercel 서버리스 함수 + Vercel Blob 저장소)
// GET  → 승리 랭킹 (승수 많은 순, 비밀번호는 절대 안 보여줘요)
// POST → {action:'signup'|'login'|'win', name, pw, result?}

const { put } = require('@vercel/blob');
const crypto = require('crypto');

const PATH = 'chessmaker/users.json';
const SALT = 'chessmaker-2026';

const hashPw = (name, pw) => crypto.createHash('sha256').update(name + ':' + pw + ':' + SALT).digest('hex');

// 저장소 공개 주소를 토큰에서 뽑아내요 (vercel_blob_rw_<스토어ID>_<비밀>)
// 읽을 때 비싼 list() 대신 공개 URL을 바로 가져와서 작업 횟수를 크게 아껴요.
function blobBase() {
  const m = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([^_]+)_/);
  return m ? `https://${m[1].toLowerCase()}.public.blob.vercel-storage.com` : '';
}

async function load() {
  const base = blobBase();
  if (!base) return {};
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
      const db = await load();
      const board = Object.values(db)
        .map(u => ({ name: u.name, wins: u.wins || 0, losses: u.losses || 0 }))
        .sort((a, b) => b.wins - a.wins || a.losses - b.losses)
        .slice(0, 100);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(board);
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 12);
    const pw = String(body.pw || '');
    if (name.length < 2) { res.status(400).json({ error: 'bad-name' }); return; }
    if (pw.length < 4 || pw.length > 30) { res.status(400).json({ error: 'bad-pw' }); return; }

    const db = await load();
    const key = name.toLowerCase();
    const user = db[key];

    if (body.action === 'signup') {
      if (user) { res.status(409).json({ error: 'exists' }); return; }
      if (Object.keys(db).length >= 2000) { res.status(507).json({ error: 'full' }); return; }
      db[key] = { name, hash: hashPw(name, pw), wins: 0, losses: 0 };
      await save(db);
      res.status(200).json({ ok: true, wins: 0, losses: 0 });
      return;
    }

    // login / win 은 계정 + 비밀번호 확인
    if (!user || user.hash !== hashPw(name, pw)) { res.status(401).json({ error: 'wrong' }); return; }

    if (body.action === 'login') {
      res.status(200).json({ ok: true, wins: user.wins || 0, losses: user.losses || 0 });
      return;
    }

    if (body.action === 'win') {
      if (body.result === 'win') user.wins = (user.wins || 0) + 1;
      else if (body.result === 'lose') user.losses = (user.losses || 0) + 1;
      else { res.status(400).json({ error: 'bad-result' }); return; }
      await save(db);
      res.status(200).json({ ok: true, wins: user.wins || 0, losses: user.losses || 0 });
      return;
    }

    res.status(400).json({ error: 'bad-request' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
