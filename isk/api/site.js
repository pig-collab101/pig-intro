// I.S.K 모임 사이트 – 모임 소개 + 멤버 명부
// GET                       → { site:{fullName,motto,about,goals,rules,founded,updated}, members:[{name,joined}] }
// POST {fullName,motto,about,goals,rules,founded} → 소개 수정 (관리자만, 관리자 한 명만 쓰므로 단일 파일 덮어쓰기)

const { put } = require('@vercel/blob');
const { verifySession, isAdmin, blobBase, blobStoreId, MEMBERS_PATH } = require('./auth');

const SITE_PATH = 'isk/site.json';
const FIELDS = { fullName: 60, motto: 80, about: 2000, goals: 1000, rules: 1000, founded: 20 };

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
      res.status(200).json({
        site: site && typeof site === 'object' ? site : {},
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
    const site = {};
    Object.keys(FIELDS).forEach((k) => {
      site[k] = String(body[k] == null ? '' : body[k]).replace(/\r\n?/g, '\n').trim().slice(0, FIELDS[k]);
    });
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
