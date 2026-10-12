// 과학 퀴즈 사이트 – 코인 & 상점 API
// 상품 종류(slot): bg 배경 · title 칭호 · color 이름 색 · icon 아이콘 · frame 퀴즈 카드 테두리 · effect 정답 효과
// GET                          → { items:[{id,type,name,price,grade,value,css}], looks:{소문자이름:{name,title,color,icon,frame}} }
// GET  (로그인)                → + { coins, earned, spent, owned:[id], equipped:{slot:id} }
// POST {action:'buy', id}      → 구매
// POST {action:'equip', slot, id} → 적용 (id '' = 해제)
// POST {action:'gift', name, amount} → 관리자: 코인 지급 (음수면 회수)
//
// 코인 = 내 점수(랭킹 점수) + 가입 보너스 30 + 관리자 지급 − 산 배경 가격 합
// 구매 = sci/buy/<유저해시>/<순번4자리>.json = {id, price} (allowOverwrite:false)
//   순번은 지금까지 산 개수. 경로가 순번뿐이라 동시에 여러 개를 사도 같은 순번은 하나만 성공하고,
//   list() 가 늦게 반영돼 개수를 적게 세도 이미 있는 순번과 부딪쳐 실패 → 코인 초과 사용 불가
// 지급 = sci/gift/<유저해시>/<시각>_<금액>.json
// 적용 = sci/eq/<유저해시>/<시각>_<slot>_<id|none>_<이름hex>.json (내용 없음, 불변) — 같은 slot 은 가장 최근 것이 유효.
//   남들에게 보이는 꾸미기(칭호·이름색·아이콘·테두리)는 적용할 때마다 list() 로 sci/looks.json 을 새로 만듦

const { put, del } = require('@vercel/blob');
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
// 칭호: [id, 칭호, 가격]
const TITLES = [
  ['t01', '호기심 많은', 20], ['t02', '꼬마 과학자', 30], ['t03', '실험 조수', 40], ['t04', '관찰왕', 50], ['t05', '질문 대장', 60],
  ['t06', '비커 마스터', 100], ['t07', '현미경 탐험가', 120], ['t08', '별 관측자', 150], ['t09', '화학 마법사', 180], ['t10', '공룡 박사', 200],
  ['t11', '원소 수집가', 300], ['t12', '중력 조종사', 350], ['t13', 'DNA 해커', 400], ['t14', '번개 연구원', 450],
  ['t15', '우주 비행사', 700], ['t16', '블랙홀 탐사대', 850], ['t17', '양자 도약자', 1000],
  ['t18', '노벨상 후보', 1800], ['t19', '천재 과학자', 2500], ['t20', '우주의 지배자', 6000],
];
// 이름 색: [id, 이름, 가격, 색 또는 그라데이션]
const COLORS = [
  ['c01', '하늘색', 30, '#1e90ff'], ['c02', '잎사귀 초록', 30, '#1f9d55'], ['c03', '노을 주황', 40, '#f07c1b'],
  ['c04', '자수정 보라', 50, '#8b4dff'], ['c05', '장미 빨강', 60, '#e0245e'],
  ['c06', '바다 그라데이션', 150, 'linear-gradient(90deg,#00b4fc,#1f5fd6)'], ['c07', '불꽃 그라데이션', 180, 'linear-gradient(90deg,#ff9a00,#ff2d55)'],
  ['c08', '황금', 400, 'linear-gradient(90deg,#c99400,#ffd84d,#c99400)'], ['c09', '오로라', 450, 'linear-gradient(90deg,#1fbf8f,#6a4cff,#00b4fc)'],
  ['c10', '플라스마', 800, 'linear-gradient(90deg,#b14dff,#ff4dd2)'], ['c11', '은하', 1200, 'linear-gradient(90deg,#5b7cff,#c86bff,#ff6b9e)'],
  ['c12', '무지개', 3000, 'linear-gradient(90deg,#ff5a5a,#ffb347,#e6c200,#3fbf5a,#3f8cff,#8a5bff)'],
];
// 아이콘: [id, 이름, 가격, 이모지]
const ICONS = [
  ['i01', '시험관', 20, '🧪'], ['i02', '현미경', 20, '🔬'], ['i03', '새싹', 25, '🌱'], ['i04', '자석', 30, '🧲'], ['i05', '물방울', 30, '💧'],
  ['i06', '개구리', 40, '🐸'], ['i07', '나비', 50, '🦋'], ['i08', '화산', 60, '🌋'],
  ['i09', '망원경', 100, '🔭'], ['i10', 'DNA', 120, '🧬'], ['i11', '플라스크', 150, '⚗️'], ['i12', '공룡', 180, '🦕'], ['i13', '번개', 200, '⚡'],
  ['i14', '토성', 300, '🪐'], ['i15', '은하', 400, '🌌'], ['i16', '혜성', 450, '☄️'],
  ['i17', '로켓', 700, '🚀'], ['i18', 'UFO', 900, '🛸'], ['i19', '다이아몬드', 2000, '💎'], ['i20', '초신성', 4000, '🌟'],
];
// 퀴즈 카드 테두리: [id, 이름, 가격, 테두리 그라데이션]
const FRAMES = [
  ['f01', '하늘 테두리', 60, 'linear-gradient(135deg,#7fd3ff,#1479b8)'], ['f02', '새싹 테두리', 60, 'linear-gradient(135deg,#9be15d,#00a86b)'],
  ['f03', '노을 테두리', 150, 'linear-gradient(135deg,#ffb46b,#d9576b)'], ['f04', '바다 테두리', 150, 'linear-gradient(135deg,#00e1ff,#2a63ff)'],
  ['f05', '황금 테두리', 450, 'linear-gradient(135deg,#fff1b8,#e6b422,#a87c00,#ffe680)'], ['f06', '오로라 테두리', 800, 'linear-gradient(135deg,#1fbf8f,#6a4cff,#00b4fc)'],
  ['f07', '다이아 테두리', 1800, 'linear-gradient(135deg,#b3f0ff,#3fa9f5,#ffffff,#7fe7ff)'], ['f08', '루비 테두리', 3500, 'linear-gradient(135deg,#ff0062,#ff7a3d,#ff0062)'],
];
// 정답 효과: [id, 이름, 가격, 떨어지는 것들 ('confetti' = 색종이)]
const EFFECTS = [
  ['e01', '색종이', 50, 'confetti'], ['e02', '반짝이는 별', 120, '⭐ ✨ 🌟'], ['e03', '하트', 120, '💖 💗 💕'],
  ['e04', '원자 폭발', 300, '⚛️ 🧪 ⚗️ 🧬'], ['e05', '로켓 발사', 700, '🚀 ✨ 🌠'], ['e06', '우주 대폭발', 2000, '🌟 💥 🪐 ☄️ 🌌'],
];

const GRADE = { b: 1, s: 2, g: 3, p: 4, d: 5, r: 6 };
function gradeOf(price) { return price <= 60 ? 1 : price <= 200 ? 2 : price <= 460 ? 3 : price <= 1000 ? 4 : price <= 2500 ? 5 : 6; }
const CATALOG = ITEMS.map((it) => ({ id: it[0], type: 'bg', name: it[1], price: it[2], grade: GRADE[it[0][0]], value: it[3], css: it[3] }))
  .concat(TITLES.map((it) => ({ id: it[0], type: 'title', name: it[1], price: it[2], grade: gradeOf(it[2]), value: it[1] })))
  .concat(COLORS.map((it) => ({ id: it[0], type: 'color', name: it[1], price: it[2], grade: gradeOf(it[2]), value: it[3] })))
  .concat(ICONS.map((it) => ({ id: it[0], type: 'icon', name: it[1], price: it[2], grade: gradeOf(it[2]), value: it[3] })))
  .concat(FRAMES.map((it) => ({ id: it[0], type: 'frame', name: it[1], price: it[2], grade: gradeOf(it[2]), value: it[3] })))
  .concat(EFFECTS.map((it) => ({ id: it[0], type: 'effect', name: it[1], price: it[2], grade: gradeOf(it[2]), value: it[3] })));
const BY_ID = {};
CATALOG.forEach((it) => { BY_ID[it.id] = it; });
const SLOTS = ['bg', 'title', 'color', 'icon', 'frame', 'effect'];
const PUBLIC_SLOTS = ['title', 'color', 'icon', 'frame'];
const LOOKS_PATH = 'sci/looks.json';

function saveJson(path, data) {
  return put(path, JSON.stringify(data), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
  });
}
function hex(s) { return Buffer.from(String(s), 'utf8').toString('hex'); }
function unhex(h) { try { return Buffer.from(h, 'hex').toString('utf8'); } catch (e) { return ''; } }
// sci/eq/<h>/<ts>_<slot>_<id|none>_<namehex>.json
function parseEq(b) {
  const m = /^sci\/eq\/([0-9a-f]+)\/(\d+)_([a-z]+)_([a-z0-9]+)_([0-9a-f]*)\.json$/.exec(b.pathname);
  if (!m || SLOTS.indexOf(m[3]) < 0) return null;
  return { h: m[1], ts: +m[2], slot: m[3], id: m[4] === 'none' ? '' : m[4], name: unhex(m[5]), url: b.url };
}
// 기록 목록 → { h: { name, slot: {id, ts} } }  (slot 마다 가장 최근 것)
function latestEq(recs) {
  const out = {};
  recs.forEach((r) => {
    const u = out[r.h] || (out[r.h] = { name: r.name });
    if (!u[r.slot] || u[r.slot].ts < r.ts) { u[r.slot] = { id: r.id, ts: r.ts }; u.name = r.name || u.name; }
  });
  return out;
}
async function myEquipped(h) {
  const recs = (await listAll(EQ_DIR + h + '/').catch(() => [])).map(parseEq).filter(Boolean);
  const u = latestEq(recs)[h] || {};
  const eq = {};
  SLOTS.forEach((sl) => { eq[sl] = u[sl] && BY_ID[u[sl].id] ? u[sl].id : ''; });
  return { eq: eq, recs: recs };
}
// 모두의 공개 꾸미기 집계 (적용할 때만 다시 만듦). ensure = 방금 쓴 기록 (list 지연 대비)
async function rebuildLooks(ensure) {
  let recs;
  try { recs = (await listAll(EQ_DIR)).map(parseEq).filter(Boolean); } catch (e) { return; }
  if (ensure) recs.push(ensure);
  const latest = latestEq(recs);
  const looks = {};
  Object.keys(latest).forEach((h) => {
    const u = latest[h];
    const lk = { name: u.name };
    let any = false;
    PUBLIC_SLOTS.forEach((sl) => { if (u[sl] && u[sl].id && BY_ID[u[sl].id]) { lk[sl] = u[sl].id; any = true; } });
    if (any && u.name) looks[u.name.toLowerCase()] = lk;
  });
  try { await saveJson(LOOKS_PATH, looks); } catch (e) { /* 다음 적용 때 복구 */ }
}
async function loadLooks() {
  const base = blobBase();
  if (!base) return {};
  try {
    const r = await fetch(`${base}/${LOOKS_PATH}?t=${Date.now()}`, { cache: 'no-store' });
    return r.ok ? await r.json() : {};
  } catch (e) { return {}; }
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
  // 구매 파일은 바뀌지 않으므로 캐시된 내용을 그대로 읽어도 됨
  const recs = await Promise.all(buys.map(async (b) => {
    try { const r = await fetch(b.url, { cache: 'force-cache' }); return r.ok ? await r.json() : null; } catch (e) { return null; }
  }));
  recs.forEach((r) => {
    if (r && BY_ID[r.id] && owned.indexOf(r.id) < 0) { owned.push(r.id); spent += Number(r.price) || BY_ID[r.id].price; }
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
      const out = { items: CATALOG, start: START_COINS, looks: await loadLooks() };
      if (sess) {
        const w = await wallet(sess);
        const mine = await myEquipped(w.h);
        Object.assign(out, { coins: w.coins, earned: w.earned, spent: w.spent, gifted: w.gifted, owned: w.owned, equipped: mine.eq });
        // 내 꾸미기는 집계 지연 없이 내 기록 기준으로
        const lk = { name: sess.name };
        PUBLIC_SLOTS.forEach((sl) => { if (mine.eq[sl]) lk[sl] = mine.eq[sl]; });
        out.looks[String(sess.name).toLowerCase()] = lk;
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

    // ---- 적용 / 해제 ----
    if (body.action === 'equip') {
      const id = String(body.id || '');
      const item = BY_ID[id];
      const slot = item ? item.type : String(body.slot || 'bg');
      if (SLOTS.indexOf(slot) < 0) { res.status(400).json({ error: 'bad-slot' }); return; }
      const w = await wallet(sess);
      if (id && (!item || w.owned.indexOf(id) < 0)) { res.status(400).json({ error: 'not-owned' }); return; }
      const name = String(sess.name).slice(0, 16);
      const pathname = EQ_DIR + w.h + '/' + Date.now() + '_' + slot + '_' + (id || 'none') + '_' + hex(name) + '.json';
      await put(pathname, '1', {
        access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/plain', cacheControlMaxAge: 31536000,
      });
      const rec = parseEq({ pathname: pathname, url: '' });
      // 같은 slot 의 예전 기록 정리 (목록이 길어지지 않게)
      try {
        const old = (await myEquipped(w.h)).recs.filter((r) => r.slot === slot && r.ts < rec.ts && r.url);
        if (old.length) await del(old.map((r) => r.url));
      } catch (e) { /* 무시 */ }
      if (PUBLIC_SLOTS.indexOf(slot) >= 0) await rebuildLooks(rec);
      res.status(200).json({ ok: true, slot: slot, equipped: id });
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
        await put(BUY_DIR + w.h + '/' + seq + '.json', JSON.stringify({ id: item.id, price: item.price, at: new Date().toISOString() }), {
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
