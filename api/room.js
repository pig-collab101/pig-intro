// 체스메이커 온라인 대결방 API (Vercel 서버리스 함수 + Vercel Blob 저장소)
// 방 하나 = chessmaker/rooms/<코드>.json 파일 하나
// GET  ?code=XXXX        → 방 정보
// POST {action:'create'} → 방 만들기 (코드 발급)
// POST {action:'join'}   → 코드로 참가
// POST {action:'picks'}  → 내가 고른 기물 올리기
// POST {action:'state'}  → 게임 상태 올리기 (턴이 바뀔 때마다)

const { put, list } = require('@vercel/blob');

const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 헷갈리는 0/O, 1/I/L 제외
const roomPath = code => `chessmaker/rooms/${code}.json`;

function randCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

async function loadRoom(code) {
  const { blobs } = await list({ prefix: roomPath(code) });
  const b = blobs.find(x => x.pathname === roomPath(code));
  if (!b) return null;
  const r = await fetch(b.url + '?v=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}

function saveRoom(room) {
  return put(roomPath(room.code), JSON.stringify(room), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

function cleanDef(p) {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id || '').slice(0, 40);
  if (!id) return null;
  return {
    id,
    nm: String(p.nm || '?').slice(0, 12),
    emoji: String(p.emoji || '⭐').slice(0, 4),
    img: typeof p.img === 'string' && p.img.startsWith('data:image/') && p.img.length < 50000 ? p.img : null,
    moves: (Array.isArray(p.moves) ? p.moves : []).slice(0, 10).map(String),
    specials: (Array.isArray(p.specials) ? p.specials : []).slice(0, 10).map(String),
    ds: String(p.ds || '').slice(0, 300),
  };
}

module.exports = async (req, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) { res.status(503).json({ error: 'no-db' }); return; }
  try {
    if (req.method === 'GET') {
      const code = String(req.query.code || '').toUpperCase().slice(0, 8);
      if (!code) { res.status(400).json({ error: 'no-code' }); return; }
      const room = await loadRoom(code);
      if (!room) { res.status(404).json({ error: 'not-found' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(room);
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }
    const body = req.body || {};

    if (body.action === 'create') {
      let code, exists = true;
      for (let i = 0; i < 8 && exists; i++) {
        code = randCode(4);
        exists = !!(await loadRoom(code));
      }
      if (exists) { res.status(500).json({ error: 'code-gen-failed' }); return; }
      const room = {
        code, createdAt: Date.now(),
        shape: String(body.shape || 'square').slice(0, 20),
        material: String(body.material || 'wood').slice(0, 20),
        hostName: String(body.name || '플레이어').slice(0, 12),
        guestName: null,
        hostPicks: null, hostDefs: null,
        guestPicks: null, guestDefs: null,
        state: null, seq: 0,
      };
      await saveRoom(room);
      res.status(200).json(room);
      return;
    }

    const code = String(body.code || '').toUpperCase().slice(0, 8);
    if (!code) { res.status(400).json({ error: 'no-code' }); return; }
    const room = await loadRoom(code);
    if (!room) { res.status(404).json({ error: 'not-found' }); return; }

    if (body.action === 'join') {
      const name = String(body.name || '플레이어').slice(0, 12);
      if (room.guestName && room.guestName !== name) { res.status(409).json({ error: 'full' }); return; }
      room.guestName = name;
      await saveRoom(room);
      res.status(200).json(room);
      return;
    }

    if (body.action === 'picks') {
      const seat = body.seat === 1 ? 1 : 0;
      const picks = (Array.isArray(body.picks) ? body.picks : []).slice(0, 4).map(String);
      const defs = (Array.isArray(body.defs) ? body.defs : []).slice(0, 4).map(cleanDef).filter(Boolean);
      if (picks.length === 0) { res.status(400).json({ error: 'no-picks' }); return; }
      if (seat === 0) { room.hostPicks = picks; room.hostDefs = defs; }
      else { room.guestPicks = picks; room.guestDefs = defs; }
      await saveRoom(room);
      res.status(200).json(room);
      return;
    }

    if (body.action === 'state') {
      const seq = Number(body.seq) || 0;
      if (seq > (room.seq || 0) && body.state && typeof body.state === 'object') {
        room.state = body.state;
        room.seq = seq;
        await saveRoom(room);
      }
      res.status(200).json({ ok: true, seq: room.seq });
      return;
    }

    res.status(400).json({ error: 'bad-request' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
