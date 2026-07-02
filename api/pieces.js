// 체스메이커 온라인 기물 공유 API (Vercel 서버리스 함수)
// 저장소: Vercel 대시보드 → Storage → Upstash Redis 를 연결하면 자동으로 작동해요.
// DB가 없으면 503을 돌려주고, 게임은 알아서 오프라인 모드(localStorage)로 동작합니다.

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmds) {
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return r.json(); // [{result:...}, ...]
}

module.exports = async (req, res) => {
  if (!URL_ || !TOKEN) { res.status(503).json({ error: 'no-db' }); return; }
  try {
    if (req.method === 'GET') {
      // 모든 공유 기물을 선택 횟수 많은 순으로
      const [h, z] = await redis([
        ['HGETALL', 'cm:pieces'],
        ['ZRANGE', 'cm:picks', 0, -1, 'REV', 'WITHSCORES'],
      ]);
      const map = {};
      const arr = h.result || [];
      for (let i = 0; i < arr.length; i += 2) { try { map[arr[i]] = JSON.parse(arr[i + 1]); } catch (e) {} }
      const out = [];
      const zr = z.result || [];
      for (let i = 0; i < zr.length; i += 2) {
        const p = map[zr[i]];
        if (p) { p.cnt = +zr[i + 1]; out.push(p); }
      }
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
        await redis([
          ['HSET', 'cm:pieces', clean.id, JSON.stringify(clean)],
          ['ZADD', 'cm:picks', 'NX', 0, clean.id],
        ]);
        res.status(200).json({ ok: true });

      } else if (body.action === 'pick' && Array.isArray(body.ids)) {
        const ids = body.ids.slice(0, 8).map(String);
        if (ids.length) await redis(ids.map(id => ['ZINCRBY', 'cm:picks', 1, id]));
        res.status(200).json({ ok: true });

      } else res.status(400).json({ error: 'bad-request' });

    } else res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
