// I.S.K 모임 사이트 – 모임 소개 + 이번 목표 + 작전 기록 + 멤버 명부
// GET                       → { site:{...}, mission:{title,text,due,progress,started,by,updated}|null, ops:[...], members:[{name,joined,role}] }
// POST {fullName,motto,about,goals,rules,founded} → 소개 수정 (관리자만, 관리자 한 명만 쓰므로 단일 파일 덮어쓰기)
// POST {action:'mission', title,text,due,progress,started?} → 이번 목표 정하기 (관리자만, 소개와 따로 isk/mission.json)
// POST {action:'mission', clear:true}             → 이번 목표 내리기
// POST {action:'op', title,text,due,progress,started,status,result,members,endMission} → 작전 기록 남기기 (관리자만)
//      endMission:true 면 이번 목표도 내림. status: done(완료) | stopped(중단)
// POST {action:'opdel', id}                       → 작전 기록 지우기 (관리자만)
//
// 작전 기록 = 불변 개별 파일 isk/ops/<15자리ts>-<rand>.json → list() 로 isk/ops.json 재생성 (쓰고 지울 때만)

const { put, del, list } = require('@vercel/blob');
const { verifySession, isAdmin, blobBase, blobStoreId, MEMBERS_PATH } = require('./auth');

const SITE_PATH = 'isk/site.json';
const MISSION_PATH = 'isk/mission.json';
const OPS_DIR = 'isk/ops/';
const OPS_PATH = 'isk/ops.json';
const FIELDS = { fullName: 60, motto: 80, about: 2000, goals: 1000, rules: 1000, founded: 20 };
const MISSION_FIELDS = { title: 60, text: 1000, due: 10 };
const MAX_OP_MEMBERS = 100;

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max);
}
function cleanIso(v) {
  const t = Date.parse(String(v || ''));
  return isFinite(t) ? new Date(t).toISOString() : '';
}

async function loadJson(path, fallback) {
  const base = blobBase();
  if (!base) return fallback;
  try {
    const r = await fetch(`${base}/${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch (e) { return fallback; }
}

// 작전 기록 파일들로 isk/ops.json 을 다시 만듦. opts: { ensure, excludeId } — list() 반영 지연 대비
async function rebuildOps(opts) {
  opts = opts || {};
  let blobs = [];
  try {
    let cursor;
    do {
      const r = await list({ prefix: OPS_DIR, limit: 1000, cursor: cursor });
      blobs = blobs.concat(r.blobs || []);
      cursor = r.hasMore ? r.cursor : null;
    } while (cursor);
  } catch (e) { return null; }
  const items = await Promise.all(blobs.map(async (b) => {
    try { const r = await fetch(b.url, { cache: 'force-cache' }); return r.ok ? await r.json() : null; }
    catch (e) { return null; }
  }));
  let ops = items.filter(Boolean);
  if (opts.excludeId) ops = ops.filter((o) => o.id !== opts.excludeId);
  if (opts.ensure && !ops.some((o) => o.id === opts.ensure.id)) ops.push(opts.ensure);
  ops.sort((a, b) => String(b.ended || '').localeCompare(String(a.ended || '')));
  try {
    await put(OPS_PATH, JSON.stringify(ops), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
    });
  } catch (e) { /* 다음에 쓸 때 복구됨 */ }
  return ops;
}

module.exports = async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET') {
      const site = await loadJson(SITE_PATH, {});
      const members = await loadJson(MEMBERS_PATH, []);
      const mission = await loadJson(MISSION_PATH, null);
      const ops = await loadJson(OPS_PATH, []);
      res.status(200).json({
        site: site && typeof site === 'object' ? site : {},
        mission: mission && mission.title ? mission : null,
        ops: Array.isArray(ops) ? ops : [],
        members: Array.isArray(members) ? members : [],
      });
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }
    if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }

    const sess = verifySession(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!isAdmin(sess)) { res.status(403).json({ error: 'not-admin' }); return; }

    const body = req.body || {};

    if (body.action === 'mission') {
      if (body.clear) {
        try { await del(MISSION_PATH); } catch (e) { /* 이미 없음 */ }
        res.status(200).json({ ok: true, mission: null });
        return;
      }
      const mission = {};
      Object.keys(MISSION_FIELDS).forEach((k) => { mission[k] = cleanText(body[k], MISSION_FIELDS[k]); });
      if (!mission.title) { res.status(400).json({ error: 'no-title' }); return; }
      if (mission.due && !/^\d{4}-\d{2}-\d{2}$/.test(mission.due)) mission.due = '';
      mission.progress = Math.max(0, Math.min(100, Math.round(Number(body.progress) || 0)));
      mission.by = String(sess.name || '');
      mission.updated = new Date().toISOString();
      // 시작 시각: 고칠 때는 처음 정한 시각을 유지 (작전 기간 계산용)
      mission.started = cleanIso(body.started) || mission.updated;
      await put(MISSION_PATH, JSON.stringify(mission), {
        access: 'public', addRandomSuffix: false, allowOverwrite: true,
        contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
      });
      res.status(200).json({ ok: true, mission: mission });
      return;
    }

    if (body.action === 'op') {
      const op = {};
      Object.keys(MISSION_FIELDS).forEach((k) => { op[k] = cleanText(body[k], MISSION_FIELDS[k]); });
      if (!op.title) { res.status(400).json({ error: 'no-title' }); return; }
      if (op.due && !/^\d{4}-\d{2}-\d{2}$/.test(op.due)) op.due = '';
      op.id = String(Date.now()).padStart(15, '0') + '-' + Math.random().toString(36).slice(2, 8);
      op.status = body.status === 'stopped' ? 'stopped' : 'done';
      op.progress = Math.max(0, Math.min(100, Math.round(Number(body.progress) || 0)));
      op.result = cleanText(body.result, 1500);
      op.members = Array.isArray(body.members)
        ? Array.from(new Set(body.members.map((n) => cleanText(n, 16).replace(/\s+/g, ' ')).filter((n) => n.length >= 2))).slice(0, MAX_OP_MEMBERS)
        : [];
      op.ended = new Date().toISOString();
      op.started = cleanIso(body.started) || '';
      op.by = String(sess.name || '');
      await put(OPS_DIR + op.id + '.json', JSON.stringify(op), {
        access: 'public', addRandomSuffix: false, allowOverwrite: false,
        contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 31536000,
      });
      if (body.endMission) { try { await del(MISSION_PATH); } catch (e) { /* 이미 없음 */ } }
      const ops = await rebuildOps({ ensure: op });
      res.status(200).json({ ok: true, op: op, ops: ops || undefined, mission: body.endMission ? null : undefined });
      return;
    }

    if (body.action === 'opdel') {
      const id = String(body.id || '').replace(/[^0-9a-z-]/gi, '').slice(0, 40);
      if (!id) { res.status(400).json({ error: 'no-id' }); return; }
      try { await del(OPS_DIR + id + '.json'); } catch (e) { /* 이미 없음 */ }
      const ops = await rebuildOps({ excludeId: id });
      res.status(200).json({ ok: true, ops: ops || undefined });
      return;
    }

    const site = {};
    Object.keys(FIELDS).forEach((k) => { site[k] = cleanText(body[k], FIELDS[k]); });
    site.updated = new Date().toISOString();
    await put(SITE_PATH, JSON.stringify(site), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
    });
    res.status(200).json({ ok: true, site: site });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
