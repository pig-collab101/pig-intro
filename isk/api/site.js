// I.S.K 모임 사이트 – 모임 소개 + 이번 목표 + 멤버 명부
// GET                       → { site:{...}, mission:{title,text,due,progress,by,updated}|null, members:[{name,joined,role}] }
// POST {fullName,motto,about,goals,rules,founded} → 소개 수정 (관리자만, 관리자 한 명만 쓰므로 단일 파일 덮어쓰기)
// POST {action:'mission', title,text,due,progress} → 이번 목표 정하기 (관리자만, 소개와 따로 isk/mission.json)
// POST {action:'mission', clear:true}             → 이번 목표 내리기

const { put, del } = require('@vercel/blob');
const { verifySession, isAdmin, blobBase, blobStoreId, MEMBERS_PATH } = require('./auth');

const SITE_PATH = 'isk/site.json';
const MISSION_PATH = 'isk/mission.json';
const FIELDS = { fullName: 60, motto: 80, about: 2000, goals: 1000, rules: 1000, founded: 20 };
const MISSION_FIELDS = { title: 60, text: 1000, due: 10 };

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max);
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

module.exports = async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET') {
      const site = await loadJson(SITE_PATH, {});
      const members = await loadJson(MEMBERS_PATH, []);
      const mission = await loadJson(MISSION_PATH, null);
      res.status(200).json({
        site: site && typeof site === 'object' ? site : {},
        mission: mission && mission.title ? mission : null,
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
      await put(MISSION_PATH, JSON.stringify(mission), {
        access: 'public', addRandomSuffix: false, allowOverwrite: true,
        contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 0,
      });
      res.status(200).json({ ok: true, mission: mission });
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
