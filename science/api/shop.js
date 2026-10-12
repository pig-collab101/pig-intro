// 과학 퀴즈 사이트 – 코인 & 배경 상점 API
// GET                          → { items:[{id,name,price,grade,css}] }  (로그인 안 해도 됨)
// GET  (로그인)                → + { coins, earned, spent, owned:[id], equipped }
// POST {action:'buy', id}      → 배경 구매
// POST {action:'equip', id}    → 배경 적용 ('' = 기본 배경)
// POST {action:'gift', name, amount} → 관리자: 코인 지급 (음수면 회수)
//
// 코인 = 내 점수(랭킹 점수) + 가입 보너스 30 + 관리자 지급 − 산 배경 가격 합
// 구매 = sci/buy/<유저해시>/<순번4자리>_<배경id>.json (allowOverwrite:false)
//   순번은 지금까지 산 개수. list() 가 늦게 반영돼 개수를 적게 세면 이미 있는 순번과 부딪쳐 실패 → 코인 초과 사용 불가
// 지급 = sci/gift/<유저해시>/<시각>_<금액>.json, 적용 중 배경 = sci/eq/<유저해시>.json

const { put } = require('@vercel/blob');
const { verifySession, isAdmin, isBanned, blobStoreId, blobBase } = require('./auth');
const { computeMe, subHash, listAll } = require('./quiz');

const BUY_DIR = 'sci/buy/';
const GIFT_DIR = 'sci/gift/';
const EQ_DIR = 'sci/eq/';
const START_COINS = 30;

const STARS = 'radial-gradient(1px 1px at 10% 20%,#fff 50%,transparent 51%) 0 0/160px 160px,' +
  'radial-gradient(1px 1px at 60% 70%,#fff 50%,transparent 51%) 0 0/160px 160px,' +
  'radial-gradient(1.5px 1.5px at 35% 85%,#fff 50%,transparent 51%) 0 0/220px 220px,' +
  'radial-gradient(1px 1px at 85% 35%,#d8f0ff 50%,transparent 51%) 0 0/190px 190px,' +
  'radial-gradient(1.5px 1.5px at 50% 10%,#fff 50%,transparent 51%) 0 0/260px 260px';

// [id, 이름, 가격, 배경 CSS]
const ITEMS = [
  // 브론즈급
  ['b01', '맑은 하늘', 20, 'linear-gradient(180deg,#bfe6ff,#eaf6ff)'],
  ['b02', '민트 비커', 20, 'linear-gradient(135deg,#c9f7e4,#e9fff6)'],
  ['b03', '레몬 산성', 25, 'linear-gradient(135deg,#fff3a0,#fffbe0)'],
  ['b04', '라벤더 결정', 25, 'linear-gradient(135deg,#e3d7ff,#f5f0ff)'],
  ['b05', '복숭아 노을', 30, 'linear-gradient(180deg,#ffd3b8,#fff0e6)'],
  ['b06', '모눈종이', 35, 'linear-gradient(#cfe0ee 1px,transparent 1px) 0 0/24px 24px,linear-gradient(90deg,#cfe0ee 1px,transparent 1px) 0 0/24px 24px,#f8fbff'],
  ['b07', '실험 노트', 40, 'repeating-linear-gradient(180deg,#fffdf4 0 27px,#c9dcf0 27px 28px)'],
  ['b08', '물방울', 45, 'radial-gradient(circle at 20% 30%,#a9d8ff 0 6px,transparent 7px) 0 0/60px 60px,radial-gradient(circle at 70% 70%,#cbe9ff 0 4px,transparent 5px) 0 0/60px 60px,#eef8ff'],
  ['b09', '새싹', 50, 'linear-gradient(160deg,#d8f5c4,#f3ffe9)'],
  ['b10', '분자 점무늬', 60, 'radial-gradient(#8fb8de 1.5px,transparent 2px) 0 0/18px 18px,#f2f7fc'],
  // 실버급
  ['s01', '깊은 바다', 80, 'linear-gradient(180deg,#5fc3e4,#1e5f8c)'],
  ['s02', '숲속 광합성', 90, 'linear-gradient(160deg,#6cb87a,#1f5e3a)'],
  ['s03', '사막 지층', 100, 'repeating-linear-gradient(180deg,#e9c48a 0 40px,#d9a866 40px 70px,#c78f50 70px 90px)'],
  ['s04', '가을 단풍', 110, 'linear-gradient(135deg,#f6a04d,#c4452f)'],
  ['s05', '꿀벌 줄무늬', 120, 'repeating-linear-gradient(45deg,#ffd54a 0 22px,#ffe680 22px 44px)'],
  ['s06', '비 오는 날', 130, 'repeating-linear-gradient(105deg,rgba(255,255,255,.25) 0 1px,transparent 1px 14px),linear-gradient(180deg,#7b93a8,#3f5568)'],
  ['s07', '산호초', 150, 'linear-gradient(135deg,#ff8a80,#ffb199 50%,#4fc3c7)'],
  ['s08', '무지개 스펙트럼', 160, 'linear-gradient(90deg,#ff6b6b,#ffb347,#ffe66d,#7bd88f,#5ab0ff,#8a7dff,#c77dff)'],
  ['s09', '음파', 180, 'repeating-radial-gradient(circle at 50% 120%,#9fd3ff 0 10px,#c9e7ff 10px 20px)'],
  ['s10', '빙하', 200, 'linear-gradient(160deg,#e0f7ff,#9fd8f0 60%,#6bb7d6)'],
  // 골드급
  ['g01', '노을 지평선', 250, 'linear-gradient(180deg,#2b2d6e 0%,#d9576b 55%,#ffb46b 80%,#ffe0a3)'],
  ['g02', '화산 용암', 280, 'radial-gradient(ellipse at 50% 110%,#ffb300 0,#ff5a1f 25%,#8b1a10 55%,#2a0b07 80%)'],
  ['g03', '바닷속 햇살', 300, 'repeating-linear-gradient(100deg,rgba(255,255,255,.12) 0 30px,transparent 30px 90px),linear-gradient(180deg,#1aa3c9,#06375e)'],
  ['g04', '주기율표', 330, 'linear-gradient(#fff 2px,transparent 2px) 0 0/40px 40px,linear-gradient(90deg,#fff 2px,transparent 2px) 0 0/40px 40px,linear-gradient(135deg,#ffcf8a,#8fd3ff,#c3a6ff)'],
  ['g05', '현미경 속 세포', 360, 'radial-gradient(circle at 30% 40%,#2f8a4c 0 4%,transparent 5%) 0 0/120px 120px,radial-gradient(circle at 30% 40%,#bff0c6 0 14%,transparent 15%) 0 0/120px 120px,radial-gradient(circle at 75% 70%,#d9f7c0 0 10%,transparent 11%) 0 0/120px 120px,#e8fbe9'],
  ['g06', '자기장', 400, 'repeating-radial-gradient(ellipse at 0 50%,transparent 0 18px,rgba(90,130,255,.5) 18px 20px),repeating-radial-gradient(ellipse at 100% 50%,transparent 0 18px,rgba(255,100,100,.5) 18px 20px),#f4f6ff'],
  ['g07', '황금비', 430, 'conic-gradient(from 0deg at 30% 60%,#f8d66d,#c99a2e,#f8d66d,#fff1b8,#f8d66d)'],
  ['g08', '오로라', 460, 'linear-gradient(180deg,#05101f 0%,#0c3b3a 40%,#1fbf8f 60%,#6a4cff 80%,#05101f)'],
  // 플래티넘급
  ['p01', '은하수', 600, STARS + ',linear-gradient(120deg,#0b0f2e,#2a1f5c 50%,#0b0f2e)'],
  ['p02', '성운', 680, STARS + ',radial-gradient(ellipse at 30% 40%,rgba(255,80,180,.55),transparent 50%),radial-gradient(ellipse at 70% 60%,rgba(80,160,255,.55),transparent 55%),#0a0820'],
  ['p03', '토성 고리', 760, STARS + ',radial-gradient(circle at 50% 55%,#e8c27a 0 11%,transparent 11.5%),radial-gradient(ellipse 60% 14% at 50% 55%,transparent 60%,rgba(240,210,150,.7) 62%,transparent 70%),#0d1028'],
  ['p04', '블랙홀', 850, STARS + ',radial-gradient(circle at 50% 50%,#000 0 8%,#ff9d2e 9%,#ff5e1a 11%,rgba(120,40,10,.6) 18%,transparent 35%),#050510'],
  ['p05', 'DNA 이중나선', 920, 'repeating-linear-gradient(60deg,rgba(100,220,255,.35) 0 4px,transparent 4px 40px),repeating-linear-gradient(-60deg,rgba(255,110,200,.35) 0 4px,transparent 4px 40px),linear-gradient(135deg,#0f1b3d,#2b1450)'],
  ['p06', '플라스마', 1000, 'repeating-conic-gradient(from 0deg at 50% 50%,rgba(170,120,255,.25) 0 4deg,transparent 4deg 18deg),radial-gradient(circle,#ffffff 0,#b48bff 8%,#3a1a7a 40%,#0c0420 75%)'],
  // 다이아몬드급
  ['d01', '우주에서 본 지구', 1300, 'radial-gradient(circle at 50% 120%,#7fd3ff 0 38%,#1b66c9 45%,#0a2a66 52%,transparent 53%),' + STARS + ',#02040f'],
  ['d02', '초신성', 1500, 'repeating-conic-gradient(from 0deg at 50% 50%,rgba(255,255,255,.08) 0 2deg,transparent 2deg 12deg),radial-gradient(circle,#fff 0,#ffe27a 6%,#ff7a3d 16%,#c81d6b 30%,#3a0b4a 55%,#05020d 80%)'],
  ['d03', '양자 격자', 1700, 'radial-gradient(circle,#7df9ff 0 2px,transparent 3px) 0 0/30px 30px,linear-gradient(rgba(125,249,255,.15) 1px,transparent 1px) 0 0/30px 30px,linear-gradient(90deg,rgba(125,249,255,.15) 1px,transparent 1px) 0 0/30px 30px,linear-gradient(135deg,#020b1f,#0b2a4a)'],
  ['d04', '다이아몬드 결정', 2000, 'repeating-linear-gradient(60deg,rgba(255,255,255,.22) 0 2px,transparent 2px 46px),repeating-linear-gradient(-60deg,rgba(255,255,255,.22) 0 2px,transparent 2px 46px),linear-gradient(135deg,#7fe7ff,#3fa9f5 50%,#b3f0ff)'],
  // 루비급
  ['r01', '루비 성운', 3000, STARS + ',radial-gradient(ellipse at 40% 40%,rgba(255,0,98,.7),transparent 55%),radial-gradient(ellipse at 70% 70%,rgba(255,120,60,.45),transparent 50%),#12020a'],
  ['r02', '빅뱅', 5000, 'repeating-conic-gradient(from 0deg at 50% 50%,rgba(255,255,255,.12) 0 1deg,transparent 1deg 7deg),radial-gradient(circle at 50% 50%,#fff 0,#fff6c2 4%,#ffb3e6 10%,#9b6bff 22%,#2a63ff 36%,#081040 55%,#000 75%)'],
];
const GRADE = { b: 1, s: 2, g: 3, p: 4, d: 5, r: 6 };
const CATALOG = ITEMS.map((it) => ({ id: it[0], name: it[1], price: it[2], grade: GRADE[it[0][0]], css: it[3] }));
const BY_ID = {};
CATALOG.forEach((it) => { BY_ID[it.id] = it; });

function saveJson(path, data) {
  return put(path, JSON.stringify(data), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
  });
}
async function loadEquip(h) {
  const base = blobBase();
  if (!base) return '';
  try {
    const r = await fetch(`${base}/${EQ_DIR}${h}.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return '';
    const d = await r.json();
    return d && BY_ID[d.id] ? d.id : '';
  } catch (e) { return ''; }
}

// 지갑: 번 코인 / 쓴 코인 / 가진 배경 / 구매 개수
async function wallet(sess) {
  const h = subHash(sess.sub);
  const [mine, buys, gifts] = await Promise.all([
    computeMe(sess),
    listAll(BUY_DIR + h + '/').catch(() => []),
    listAll(GIFT_DIR + h + '/').catch(() => []),
  ]);
  const owned = [];
  let spent = 0;
  buys.forEach((b) => {
    const m = /\/(\d{4})_([a-z0-9]+)\.json$/.exec(b.pathname);
    if (m && BY_ID[m[2]] && owned.indexOf(m[2]) < 0) { owned.push(m[2]); spent += BY_ID[m[2]].price; }
  });
  let gifted = 0;
  gifts.forEach((b) => {
    const m = /_(-?\d+)\.json$/.exec(b.pathname);
    if (m) gifted += +m[1];
  });
  const earned = (mine.me.score || 0) + START_COINS + gifted;
  return { h: h, earned: earned, spent: spent, coins: earned - spent, owned: owned, count: buys.length, score: mine.me.score || 0, gifted: gifted };
}

module.exports = async (req, res) => {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const sess = verifySession(token);
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET') {
      const out = { items: CATALOG, start: START_COINS };
      if (sess) {
        const w = await wallet(sess);
        Object.assign(out, { coins: w.coins, earned: w.earned, spent: w.spent, gifted: w.gifted, owned: w.owned, equipped: await loadEquip(w.h) });
      }
      res.status(200).json(out);
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }
    if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }
    if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body || {};

    // ---- 관리자: 코인 지급/회수 ----
    if (body.action === 'gift') {
      if (!isAdmin(sess)) { res.status(403).json({ error: 'not-admin' }); return; }
      const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
      const amount = parseInt(body.amount, 10);
      if (name.length < 2) { res.status(400).json({ error: 'bad-name' }); return; }
      if (!amount || Math.abs(amount) > 100000) { res.status(400).json({ error: 'bad-amount' }); return; }
      const h = subHash('local:' + name.toLowerCase());
      await put(GIFT_DIR + h + '/' + Date.now() + '_' + amount + '.json', JSON.stringify({ name: name, amount: amount, by: sess.name, at: new Date().toISOString() }), {
        access: 'public', addRandomSuffix: false, allowOverwrite: false,
        contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 31536000,
      });
      res.status(200).json({ ok: true });
      return;
    }

    if (await isBanned(sess.name)) { res.status(403).json({ error: 'banned' }); return; }

    // ---- 배경 적용 ----
    if (body.action === 'equip') {
      const id = String(body.id || '');
      const w = await wallet(sess);
      if (id && w.owned.indexOf(id) < 0) { res.status(400).json({ error: 'not-owned' }); return; }
      await saveJson(EQ_DIR + w.h + '.json', { id: id, at: new Date().toISOString() });
      res.status(200).json({ ok: true, equipped: id });
      return;
    }

    // ---- 배경 구매 ----
    if (body.action === 'buy') {
      const item = BY_ID[String(body.id || '')];
      if (!item) { res.status(404).json({ error: 'no-item' }); return; }
      const w = await wallet(sess);
      if (w.owned.indexOf(item.id) >= 0) { res.status(409).json({ error: 'owned' }); return; }
      if (w.coins < item.price) { res.status(400).json({ error: 'no-coins', coins: w.coins }); return; }
      const seq = String(w.count).padStart(4, '0');
      try {
        await put(BUY_DIR + w.h + '/' + seq + '_' + item.id + '.json', JSON.stringify({ id: item.id, price: item.price, at: new Date().toISOString() }), {
          access: 'public', addRandomSuffix: false, allowOverwrite: false,
          contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 31536000,
        });
      } catch (e) {
        // 같은 순번이 이미 있음 = 방금 다른 구매가 있었음 → 잠시 후 다시
        res.status(409).json({ error: 'retry' });
        return;
      }
      res.status(200).json({ ok: true, coins: w.coins - item.price, owned: w.owned.concat([item.id]) });
      return;
    }

    res.status(400).json({ error: 'bad-action' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
