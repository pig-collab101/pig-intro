// 성경 사이트 – 오늘의 말씀(매일미사 독서·복음 '출처'만) API
// GET → { date, dateText, title, color, readings: [{label, subtitle, source, ref}], source_url }
//
// 한국천주교주교회의 매일미사(missa.cbck.or.kr) 페이지에서 전례일과 독서/복음의 '출처(장·절)'만
// 뽑아서 보여줌. 성경 본문 전문은 저작권상 싣지 않고 매일미사 링크로 연결.
// 하루 한 번만 원본을 가져오도록 Blob(bible/liturgy/<날짜>.json)에 캐시.

const { put } = require('@vercel/blob');

const SRC_URL = 'https://missa.cbck.or.kr/DailyMissa';
const DIR = 'bible/liturgy/';

function blobStoreId() {
  const m = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([^_]+)_/);
  if (m) return m[1];
  return (process.env.BLOB_STORE_ID || '').replace(/^store_/, '');
}
function blobBase() {
  const id = blobStoreId();
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : '';
}
function kstDate() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function decode(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function stripTags(s) { return decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }

function parseReading(html, label) {
  const at = html.indexOf('<h4>' + label + '</h4>');
  if (at < 0) return null;
  const chunk = html.slice(at, at + 1800);
  const inc = chunk.match(/<span>\s*&lt;([\s\S]*?)&gt;\s*<\/span>/);
  const src = chunk.match(/<div>\s*([^<]{2,80}?)\s*<h5[^>]*class="[^"]*float-right[^"]*"[^>]*>\s*<span>\s*([^<]+?)\s*<\/span>/);
  if (!src) return null;
  return {
    label: label,
    subtitle: inc ? decode(inc[1]).replace(/\s+/g, ' ').trim() : '',
    source: decode(src[1]).replace(/^[▥✠○◎△▷\s]+/, '').replace(/\s+/g, ' ').trim(),
    ref: decode(src[2]).replace(/\s+/g, ' ').trim(),
  };
}

function parsePsalm(html) {
  // 화답송은 출처가 <h4> 안의 span 에 들어 있음: <h4>화답송<span class="float-right">시편 63(62),...(◎ ...)</span></h4>
  const m = html.match(/<h4>\s*화답송\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/h4>/);
  if (!m) return null;
  let ref = stripTags(m[1]).replace(/\([^)]*참조[^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (!ref) return null;
  return { label: '화답송', subtitle: '', source: '', ref: ref };
}

function parseMissa(html) {
  const t = html.match(/<h3 id="missa_title">([\s\S]*?)<\/h3>/);
  let title = t ? stripTags(t[1]) : '';
  let color = '';
  const cm = title.match(/^\[([^\]]+)\]\s*/);
  if (cm) { color = cm[1]; title = title.slice(cm[0].length).trim(); }

  const d = html.match(/<h2>\s*(\d{4}년[\s\S]*?)<\/h2>/);
  const dateText = d ? stripTags(d[1]) : '';

  const readings = [];
  const r1 = parseReading(html, '제1독서'); if (r1) readings.push(r1);
  const ps = parsePsalm(html); if (ps) readings.push(ps);
  const r2 = parseReading(html, '제2독서'); if (r2) readings.push(r2);
  const gs = parseReading(html, '복음'); if (gs) readings.push(gs);

  return { title: title, color: color, dateText: dateText, readings: readings };
}

async function loadCache(date) {
  const base = blobBase();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/${DIR}${date}.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    return (d && d.readings && d.readings.length) ? d : null;
  } catch (e) { return null; }
}
function saveCache(date, obj) {
  return put(DIR + date + '.json', JSON.stringify(obj), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 21600,
  }).catch(() => {});
}

module.exports = async (req, res) => {
  const date = kstDate();
  try {
    const cached = await loadCache(date);
    if (cached) {
      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.status(200).json(cached);
      return;
    }

    let html = '';
    try {
      const r = await fetch(SRC_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (bible-site)' } });
      if (r.ok) html = await r.text();
    } catch (e) { /* 아래에서 처리 */ }

    if (!html) {
      res.status(200).json({ date: date, unavailable: true, source_url: SRC_URL });
      return;
    }

    const parsed = parseMissa(html);
    const out = {
      date: date,
      dateText: parsed.dateText,
      title: parsed.title,
      color: parsed.color,
      readings: parsed.readings,
      source_url: SRC_URL,
    };

    if (out.readings.length && blobStoreId()) await saveCache(date, out);

    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.status(200).json(out.readings.length ? out : { date: date, unavailable: true, source_url: SRC_URL });
  } catch (e) {
    res.status(200).json({ date: date, unavailable: true, source_url: SRC_URL, error: String((e && e.message) || e) });
  }
};
