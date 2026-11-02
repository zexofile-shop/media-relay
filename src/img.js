'use strict';
// Admin image uploads -> imgbb (the API key stays on the server, env IMGBB_KEY).
//
//   GET  /api/img/config        public: is it set up? limits (also wakes a sleeping server)
//   POST /api/img?name=<x>      raw image bytes (Content-Type image/jpeg|png|webp|gif), max IMGBB_MAX_BYTES (10 MB)
//                               needs: Origin in ADMIN_ORIGINS + "Authorization: Bearer <Firebase ID token>" of an admin
//                               -> 200 { ok, url, display_url, delete_url, id, width, height, size, host: "imgbb" }
//
// The admin check is the same one /api/upload uses (UploadService.isStaff: OWNER_EMAIL, else admins/{email} in Firestore).

const IMG_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const DEFAULT_MAX = 10 * 1024 * 1024;
const IMGBB_URL = 'https://api.imgbb.com/1/upload';

function sniffType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return '';
}

function cleanName(s) {
  const n = String(s || '').replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return n || 'image';
}

class ImgbbService {
  constructor({ key, maxBytes, ratePerMin, fetchImpl, now, log } = {}) {
    this.key = String(key || '').trim();
    this.maxBytes = maxBytes || DEFAULT_MAX;
    this.ratePerMin = ratePerMin ?? 30;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.now = now || Date.now;
    this.log = log;
    this.hits = new Map(); this.window = 0;
  }
  get configured() { return !!this.key; }
  publicConfig() { return { ok: true, configured: this.configured, host: 'imgbb', maxBytes: this.maxBytes, types: Object.keys(IMG_TYPES) }; }
  allow(uid) {
    if (!this.ratePerMin) return true;
    const win = Math.floor(this.now() / 60000);
    if (win !== this.window) { this.window = win; this.hits.clear(); }
    const n = (this.hits.get(uid) || 0) + 1; this.hits.set(uid, n);
    return n <= this.ratePerMin;
  }
  /** Sends bytes to imgbb. Returns { status, body }. The key never appears in a reply or a log line. */
  async upload(buf, name) {
    const form = new URLSearchParams();
    form.set('key', this.key);
    form.set('image', buf.toString('base64'));
    form.set('name', name);
    let r, j = null;
    try {
      r = await this.fetch(IMGBB_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.timeout(60000) });
      j = await r.json().catch(() => null);
    } catch (err) {
      this.log && this.log.warn(`img: imgbb unreachable: ${err.name}`);
      return { status: 502, body: { ok: false, error: 'imgbb_unreachable' } };
    }
    const d = j && j.data;
    if (!r.ok || !j || !j.success || !d || !/^https:\/\//.test(String(d.url || ''))) {
      const words = j && j.error && typeof j.error.message === 'string' ? j.error.message.replace(this.key, '***').slice(0, 200) : '';
      this.log && this.log.warn(`img: imgbb answered ${r.status}${words ? ': ' + words : ''}`);
      return { status: 502, body: { ok: false, error: 'imgbb_failed', status: r.status, words } };
    }
    return { status: 200, body: { ok: true, host: 'imgbb', url: d.url, display_url: d.display_url || d.url, delete_url: d.delete_url || '', id: d.id || '',
      width: Number(d.width) || 0, height: Number(d.height) || 0, size: Number(d.size) || buf.length } };
  }
}

function readCapped(req, max) {
  return new Promise(resolve => {
    const bufs = []; let n = 0; let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    req.on('data', d => {
      if (done) return;
      n += d.length;
      if (n > max) { finish({ error: 'too_big' }); req.resume(); return; }
      bufs.push(d);
    });
    req.on('end', () => finish({ value: Buffer.concat(bufs) }));
    req.on('error', () => finish({ error: 'read_failed' }));
    req.on('aborted', () => finish({ error: 'read_failed' }));
  });
}

async function handleImg(req, res, url, { imgbb, uploads, auth, adminOrigins, send, log }) {
  const origin = String(req.headers['origin'] || '').replace(/\/+$/, '');
  const allowed = !!origin && adminOrigins.includes(origin);
  const cors = { Vary: 'Origin' };
  if (allowed) {
    cors['Access-Control-Allow-Origin'] = origin;
    cors['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    cors['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    cors['Access-Control-Max-Age'] = '600';
  }
  const reply = (status, body) => send(res, status, body, cors);
  const drain = () => { if (!req.complete) req.resume(); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const p = url.pathname.replace(/\/+$/, '');

  if (p === '/api/img/config' && req.method === 'GET') return reply(imgbb.configured ? 200 : 503, imgbb.configured ? imgbb.publicConfig() : { ...imgbb.publicConfig(), ok: false, error: 'img_not_configured' });
  if (p !== '/api/img') { drain(); return reply(404, { ok: false, error: 'not_found' }); }
  if (req.method !== 'POST') { drain(); return reply(405, { ok: false, error: 'method_not_allowed' }); }
  if (!allowed) { drain(); return reply(403, { ok: false, error: 'origin_not_allowed' }); }

  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  const idToken = m ? m[1].trim() : '';
  const user = idToken ? await auth.verifyUser(idToken) : null;
  if (!user) { drain(); return reply(401, { ok: false, error: 'login_required' }); }
  let staff;
  try { staff = await uploads.isStaff(user, idToken); } catch (err) {
    log && log.warn(`img: admin check failed: ${err.message}`);
    drain(); return reply(502, { ok: false, error: 'admin_check_failed' });
  }
  if (!staff) { drain(); return reply(403, { ok: false, error: 'not_admin' }); }
  if (!imgbb.configured) { drain(); return reply(503, { ok: false, error: 'img_not_configured' }); }
  if (!imgbb.allow(user.uid)) { drain(); return send(res, 429, { ok: false, error: 'too_many_requests' }, { ...cors, 'Retry-After': '60' }); }

  const type = String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
  if (!IMG_TYPES[type]) { drain(); return reply(415, { ok: false, error: 'not_image' }); }
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > imgbb.maxBytes) { drain(); return reply(413, { ok: false, error: 'too_big', maxBytes: imgbb.maxBytes }); }
  const body = await readCapped(req, imgbb.maxBytes);
  if (body.error === 'too_big') return reply(413, { ok: false, error: 'too_big', maxBytes: imgbb.maxBytes });
  if (body.error) return reply(400, { ok: false, error: body.error });
  if (!body.value.length) return reply(400, { ok: false, error: 'empty' });
  const real = sniffType(body.value);
  if (!real) return reply(415, { ok: false, error: 'not_image' });

  const name = cleanName(url.searchParams.get('name'));
  const out = await imgbb.upload(body.value, name);
  if (out.body.ok) log && log.info(`img: ${user.uid} uploaded ${body.value.length} B -> ${out.body.url}`);
  return reply(out.status, out.body);
}

module.exports = { ImgbbService, handleImg, sniffType, cleanName, IMG_TYPES };
