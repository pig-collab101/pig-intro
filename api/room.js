// 체스메이커 온라인 대결방 API (Vercel 서버리스 함수 + Vercel Blob 저장소)
// 방 하나를 여러 개의 독립된 파일로 나눠서 저장해요 (meta/guest/hostpicks/guestpicks/state).
// 이렇게 하면 호스트와 게스트가 거의 동시에 글을 써도 서로 지우는 일이 없어요!
// GET  ?code=XXXX        → 방 정보 (5개 파일을 합쳐서 돌려줌)
// POST {action:'create'} → 방 만들기 (코드 발급)
// POST {action:'join'}   → 코드로 참가
// POST {action:'picks'}  → 내가 고른 기물 올리기
// POST {action:'state'}  → 게임 상태 올리기 (턴이 바뀔 때마다)

const { put } = require('@vercel/blob');

const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 헷갈리는 0/O, 1/I/L 제외
const dir = code => `chessmaker/rooms/${code}`;

// 저장소 공개 주소를 토큰에서 뽑아내요 (vercel_blob_rw_<스토어ID>_<비밀>)
// 이렇게 하면 읽을 때 비싼 list() 대신 공개 URL을 바로 가져와서 작업 횟수를 크게 아껴요.
function blobBase() {
  const m = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([^_]+)_/);
  return m ? `https://${m[1].toLowerCase()}.public.blob.vercel-storage.com` : '';
}

function randCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

async function loadJSON(path) {
  const base = blobBase();
  if (!base) return null;
  const r = await fetch(`${base}/${path}?v=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) return null; // 404 = 아직 없는 파일
  try { return await r.json(); } catch (e) { return null; }
}
function saveJSON(path, obj) {
  return put(path, JSON.stringify(obj), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
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

async function loadFullRoom(code) {
  const [meta, guest, hostPicks, guestPicks, stateFile] = await Promise.all([
    loadJSON(`${dir(code)}/meta.json`),
    loadJSON(`${dir(code)}/guest.json`),
    loadJSON(`${dir(code)}/hostpicks.json`),
    loadJSON(`${dir(code)}/guestpicks.json`),
    loadJSON(`${dir(code)}/state.json`),
  ]);
  if (!meta) return null;
  return {
    code, createdAt: meta.createdAt,
    shape: meta.shape, material: meta.material, hostName: meta.hostName,
    guestName: guest ? guest.guestName : null,
    hostPicks: hostPicks ? hostPicks.picks : null, hostDefs: hostPicks ? hostPicks.defs : null,
    guestPicks: guestPicks ? guestPicks.picks : null, guestDefs: guestPicks ? guestPicks.defs : null,
    state: stateFile ? stateFile.state : null, seq: stateFile ? stateFile.seq : 0,
  };
}

module.exports = async (req, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) { res.status(503).json({ error: 'no-db' }); return; }
  try {
    if (req.method === 'GET') {
      const code = String(req.query.code || '').toUpperCase().slice(0, 8);
      if (!code) { res.status(400).json({ error: 'no-code' }); return; }
      const room = await loadFullRoom(code);
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
        exists = !!(await loadJSON(`${dir(code)}/meta.json`));
      }
      if (exists) { res.status(500).json({ error: 'code-gen-failed' }); return; }
      const meta = {
        createdAt: Date.now(),
        shape: String(body.shape || 'square').slice(0, 20),
        material: String(body.material || 'wood').slice(0, 20),
        hostName: String(body.name || '플레이어').slice(0, 12),
      };
      await saveJSON(`${dir(code)}/meta.json`, meta);
      res.status(200).json({
        code, createdAt: meta.createdAt, shape: meta.shape, material: meta.material,
        hostName: meta.hostName, guestName: null,
        hostPicks: null, hostDefs: null, guestPicks: null, guestDefs: null, state: null, seq: 0,
      });
      return;
    }

    const code = String(body.code || '').toUpperCase().slice(0, 8);
    if (!code) { res.status(400).json({ error: 'no-code' }); return; }
    const meta = await loadJSON(`${dir(code)}/meta.json`);
    if (!meta) { res.status(404).json({ error: 'not-found' }); return; }

    if (body.action === 'join') {
      const name = String(body.name || '플레이어').slice(0, 12);
      const guest = await loadJSON(`${dir(code)}/guest.json`);
      if (guest && guest.guestName && guest.guestName !== name) { res.status(409).json({ error: 'full' }); return; }
      await saveJSON(`${dir(code)}/guest.json`, { guestName: name });
      const room = await loadFullRoom(code);
      res.status(200).json(room);
      return;
    }

    if (body.action === 'picks') {
      const seat = body.seat === 1 ? 1 : 0;
      const picks = (Array.isArray(body.picks) ? body.picks : []).slice(0, 4).map(String);
      const defs = (Array.isArray(body.defs) ? body.defs : []).slice(0, 4).map(cleanDef).filter(Boolean);
      if (picks.length === 0) { res.status(400).json({ error: 'no-picks' }); return; }
      await saveJSON(`${dir(code)}/${seat === 0 ? 'hostpicks' : 'guestpicks'}.json`, { picks, defs });
      const room = await loadFullRoom(code);
      res.status(200).json(room);
      return;
    }

    if (body.action === 'state') {
      const seq = Number(body.seq) || 0;
      if (body.state && typeof body.state === 'object') {
        await saveJSON(`${dir(code)}/state.json`, { state: body.state, seq });
      }
      res.status(200).json({ ok: true, seq });
      return;
    }

    res.status(400).json({ error: 'bad-request' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
