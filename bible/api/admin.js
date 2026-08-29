// 성경 사이트 – 관리자 전용 조회 API (신고 목록 / 차단 목록)
// GET  (Authorization: Bearer <관리자 세션토큰>)  → { reports:[...], banned:[...] }
//   reports: 글 단위로 묶은 신고 [{ postId, postText, postName, postSub, count, reporters:[이름...], last }]
// 추방/해제·삭제는 /api/nanum 으로 처리.

const { list } = require('@vercel/blob');
const { verifySession, isAdmin, blobStoreId, listBanned } = require('./auth');

const REP_DIR = 'bible/rep/';

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method-not-allowed' }); return; }
  if (!blobStoreId()) { res.status(503).json({ error: 'no-db' }); return; }

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const sess = verifySession(token);
  if (!sess) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (!isAdmin(sess)) { res.status(403).json({ error: 'not-admin' }); return; }

  try {
    let repBlobs = [];
    try { repBlobs = (await list({ prefix: REP_DIR, limit: 1000 })).blobs || []; } catch (e) { repBlobs = []; }

    const raw = await Promise.all(repBlobs.map(async (b) => {
      try { const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' }); return r.ok ? await r.json() : null; }
      catch (e) { return null; }
    }));

    const byPost = {};
    raw.filter(Boolean).forEach((rep) => {
      const k = rep.postId;
      if (!byPost[k]) {
        byPost[k] = {
          postId: k, postText: rep.postText || '', postName: rep.postName || '', postSub: rep.postSub || '',
          count: 0, reporters: [], last: '',
        };
      }
      byPost[k].count += 1;
      if (rep.by && byPost[k].reporters.indexOf(rep.by) < 0) byPost[k].reporters.push(rep.by);
      if (String(rep.at || '') > byPost[k].last) byPost[k].last = String(rep.at || '');
    });

    const reports = Object.values(byPost).sort((a, b) => String(b.last).localeCompare(String(a.last)));
    const banned = await listBanned();

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ reports: reports, banned: banned });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
