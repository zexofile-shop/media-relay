'use strict';
// POST /api/push: an admin sends a push notification to an FCM topic through FCM HTTP v1.
// Credentials come only from env: FCM_SERVICE_ACCOUNT (service-account JSON, or base64 of it).
const crypto = require('crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/firebase.messaging',
  'https://www.googleapis.com/auth/datastore',
];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_BODY_BYTES = 16 * 1024;
const TOPIC_RE = /^(all|class_([1-9]|1[0-2]))$/;
const DATA_KEY_RE = /^[A-Za-z0-9_\-.]{1,64}$/;
const RESERVED_DATA_KEYS = new Set(['from', 'notification', 'message_type']);

/** Parses the service-account env value: raw JSON or base64(JSON). Returns null when empty or unusable. */
function parseServiceAccount(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  if (!text) return null;
  if (!text.startsWith('{')) {
    try { text = Buffer.from(text, 'base64').toString('utf8').trim(); } catch (_) { return null; }
  }
  let sa;
  try { sa = JSON.parse(text); } catch (_) { return null; }
  if (!sa || typeof sa !== 'object') return null;
  const privateKey = typeof sa.private_key === 'string' ? sa.private_key.replace(/\\n/g, '\n') : '';
  if (!sa.client_email || !privateKey || !sa.project_id) return null;
  return { clientEmail: sa.client_email, privateKey, projectId: sa.project_id, tokenUri: sa.token_uri || TOKEN_URL };
}

const b64url = buf => Buffer.from(buf).toString('base64url');

/** Mints OAuth access tokens from a service account (JWT RS256 bearer grant) and caches them. */
class GoogleTokenSource {
  constructor({ sa, scopes = SCOPES, fetchImpl = globalThis.fetch, now = () => Date.now(), maxCacheMs = 50 * 60 * 1000 }) {
    this.sa = sa; this.scopes = scopes; this.fetch = fetchImpl; this.now = now; this.maxCacheMs = maxCacheMs;
    this.cached = null; // { token, until }
    this.inflight = null;
  }

  makeAssertion() {
    const iat = Math.floor(this.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = { iss: this.sa.clientEmail, scope: this.scopes.join(' '), aud: this.sa.tokenUri, iat, exp: iat + 3600 };
    const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), this.sa.privateKey);
    return `${unsigned}.${b64url(sig)}`;
  }

  async getToken() {
    if (this.cached && this.cached.until > this.now()) return this.cached.token;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: this.makeAssertion() });
      const r = await this.fetch(this.sa.tokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) {
        const e = new Error(`token_error: ${j.error_description || j.error || r.status}`);
        e.code = 'token_error';
        throw e;
      }
      const lifeMs = Math.max(60, Number(j.expires_in) || 3600) * 1000;
      this.cached = { token: j.access_token, until: this.now() + Math.min(this.maxCacheMs, lifeMs - 5 * 60 * 1000) };
      return j.access_token;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

/** Fixed one-minute windows per key (uid). */
class KeyedRateLimiter {
  constructor(perMin) { this.perMin = perMin; this.hits = new Map(); this.window = 0; }
  allow(key, now = Date.now()) {
    if (!this.perMin) return true;
    const win = Math.floor(now / 60000);
    if (win !== this.window) { this.window = win; this.hits.clear(); }
    const n = (this.hits.get(key) || 0) + 1;
    this.hits.set(key, n);
    return n <= this.perMin;
  }
}

/** Validates the request body. Returns { ok:true, msg } or { ok:false, error }. */
function validatePush(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: 'invalid_body' };
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const body = typeof b.body === 'string' ? b.body.trim() : '';
  if (!title || title.length > 100) return { ok: false, error: 'invalid_title' };
  if (!body || body.length > 500) return { ok: false, error: 'invalid_body_text' };
  const topic = typeof b.topic === 'string' ? b.topic.trim() : '';
  if (!TOPIC_RE.test(topic)) return { ok: false, error: 'invalid_topic' };
  let data;
  if (b.data !== undefined && b.data !== null) {
    if (typeof b.data !== 'object' || Array.isArray(b.data)) return { ok: false, error: 'invalid_data' };
    const entries = Object.entries(b.data);
    if (entries.length > 20) return { ok: false, error: 'invalid_data' };
    data = {};
    let total = 0;
    for (const [k, v] of entries) {
      if (!DATA_KEY_RE.test(k) || RESERVED_DATA_KEYS.has(k) || /^(google|gcm)/i.test(k)) return { ok: false, error: 'invalid_data' };
      if (typeof v !== 'string') return { ok: false, error: 'invalid_data' };
      total += k.length + v.length;
      data[k] = v;
    }
    if (total > 2048) return { ok: false, error: 'invalid_data' };
  }
  let image;
  if (b.image !== undefined && b.image !== null && b.image !== '') {
    if (typeof b.image !== 'string' || b.image.length > 1000) return { ok: false, error: 'invalid_image' };
    let u;
    try { u = new URL(b.image); } catch (_) { return { ok: false, error: 'invalid_image' }; }
    if (u.protocol !== 'https:') return { ok: false, error: 'invalid_image' };
    image = u.toString();
  }
  return { ok: true, msg: { title, body, topic, data, image } };
}

/** Builds the FCM HTTP v1 message object. */
function buildFcmMessage({ title, body, topic, data, image }, channelId) {
  const notification = { title, body };
  if (image) notification.image = image;
  const androidNotification = {};
  if (channelId) androidNotification.channel_id = channelId;
  if (image) androidNotification.image = image;
  const message = { topic, notification, android: { priority: 'HIGH' } };
  if (Object.keys(androidNotification).length) message.android.notification = androidNotification;
  if (data && Object.keys(data).length) message.data = data;
  return message;
}

function parseOrigins(s) {
  return String(s || '').split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
}

class PushService {
  /**
   * @param {object} o
   * @param {string} o.serviceAccount raw env value (JSON or base64)
   * @param {string} o.ownerEmail email that is always an admin
   * @param {string} o.channelId Android notification channel id
   * @param {number} o.ratePerMin sends per uid per minute
   */
  constructor({ serviceAccount, ownerEmail = '', channelId = '', ratePerMin = 20, fetchImpl = globalThis.fetch, now = () => Date.now(), log } = {}) {
    this.sa = parseServiceAccount(serviceAccount);
    this.ownerEmail = String(ownerEmail || '').trim().toLowerCase();
    this.channelId = String(channelId || '').trim();
    this.fetch = fetchImpl; this.now = now; this.log = log;
    this.limiter = new KeyedRateLimiter(ratePerMin);
    this.tokens = this.sa ? new GoogleTokenSource({ sa: this.sa, fetchImpl, now }) : null;
    this.adminCache = new Map(); // email -> { admin, until }
    if (serviceAccount && !this.sa && log) log.warn('FCM_SERVICE_ACCOUNT is set but could not be parsed (expect the JSON or base64 of it): push disabled.');
  }

  get configured() { return !!this.sa; }

  async isAdmin(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return false;
    if (this.ownerEmail && e === this.ownerEmail) return true;
    if (!this.configured) return false;
    const hit = this.adminCache.get(e);
    if (hit && hit.until > this.now()) return hit.admin;
    const token = await this.tokens.getToken();
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.sa.projectId)}/databases/(default)/documents/admins/${encodeURIComponent(e)}`;
    const r = await this.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    let admin;
    if (r.status === 200) admin = true;
    else if (r.status === 404) admin = false;
    else { const err = new Error(`admin_check_failed: ${r.status}`); err.code = 'admin_check_failed'; throw err; }
    if (this.adminCache.size > 1000) this.adminCache.clear();
    this.adminCache.set(e, { admin, until: this.now() + 60 * 1000 });
    return admin;
  }

  async send(msg) {
    const token = await this.tokens.getToken();
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.sa.projectId)}/messages:send`;
    const r = await this.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: buildFcmMessage(msg, this.channelId) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.name) {
      const detail = (j.error && (j.error.status || j.error.message)) || `http_${r.status}`;
      return { ok: false, error: `fcm_error: ${String(detail).slice(0, 200)}` };
    }
    return { ok: true, messageId: j.name };
  }
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise(resolve => {
    let size = 0; const bufs = []; let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    req.on('data', d => {
      size += d.length;
      if (size > limit) { finish({ error: 'body_too_large' }); req.resume(); return; }
      bufs.push(d);
    });
    req.on('end', () => {
      if (done) return;
      try { finish({ value: JSON.parse(Buffer.concat(bufs).toString('utf8') || 'null') }); } catch (_) { finish({ error: 'invalid_json' }); }
    });
    req.on('error', () => finish({ error: 'invalid_json' }));
  });
}

/**
 * Handles /api/push (POST + CORS preflight). Returns true when it handled the request.
 * send(res, status, body, headers) is the app's JSON writer; auth is the app's Auth.
 */
async function handlePush(req, res, { push, auth, adminOrigins, send, log }) {
  const origin = String(req.headers['origin'] || '').replace(/\/+$/, '');
  const cors = {};
  if (origin && adminOrigins.includes(origin)) {
    cors['Access-Control-Allow-Origin'] = origin;
    cors['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    cors['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    cors['Access-Control-Max-Age'] = '600';
  }
  cors['Vary'] = 'Origin';
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' }, cors);

  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const user = m ? await auth.verifyUser(m[1].trim()) : null;
  if (!user) return send(res, 401, { ok: false, error: 'login_required' }, cors);
  if (!push.limiter.allow(user.uid, push.now())) return send(res, 429, { ok: false, error: 'too_many_requests' }, { ...cors, 'Retry-After': '60' });
  if (!push.configured) return send(res, 503, { ok: false, error: 'push_not_configured' }, cors);
  if (!user.email || user.emailVerified === false) return send(res, 403, { ok: false, error: 'not_admin' }, cors);

  let admin;
  try { admin = await push.isAdmin(user.email); } catch (err) {
    log && log.warn(`push: admin check failed: ${err.message}`);
    return send(res, 502, { ok: false, error: 'admin_check_failed' }, cors);
  }
  if (!admin) return send(res, 403, { ok: false, error: 'not_admin' }, cors);

  const parsed = await readJsonBody(req);
  if (parsed.error) return send(res, parsed.error === 'body_too_large' ? 413 : 400, { ok: false, error: parsed.error }, cors);
  const v = validatePush(parsed.value);
  if (!v.ok) return send(res, 400, { ok: false, error: v.error }, cors);

  let out;
  try { out = await push.send(v.msg); } catch (err) {
    log && log.warn(`push: send failed: ${err.message}`);
    out = { ok: false, error: err.code === 'token_error' ? 'token_error' : 'send_failed' };
  }
  if (out.ok) log && log.info(`push: sent to ${v.msg.topic} by ${user.uid} (${out.messageId})`);
  return send(res, out.ok ? 200 : 502, out, cors);
}

module.exports = { PushService, GoogleTokenSource, KeyedRateLimiter, parseServiceAccount, validatePush, buildFcmMessage, parseOrigins, handlePush, readJsonBody, SCOPES };
