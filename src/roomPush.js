'use strict';
// POST /api/room-push: a signed-in member asks for a push about the message they just posted in a room.
// The server re-reads the message with the service account (it must exist, belong to the caller and be fresh),
// checks the room-push switch in the config doc, then sends ONE data-only FCM message to the room's topic with a
// collapse key per room (many messages = one updating notification on the phone). The app draws the notification
// (channel, skip own uid, skip when that room is open). Paths are configurable by env; defaults are generic.


const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function fsValue(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('nullValue' in v) return null;
  return undefined;
}
function fsFields(doc) {
  const out = {};
  const f = (doc && doc.fields) || {};
  for (const k of Object.keys(f)) out[k] = fsValue(f[k]);
  return out;
}
function fill(tpl, room, msg) { return tpl.replace('{room}', room).replace('{msg}', msg || ''); }
function clip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

class RoomPush {
  /**
   * @param {object} o
   * @param {import('./push').PushService} o.push configured PushService (service account + token source + fetch)
   */
  constructor({ push, configDoc = 'app_config/community', switchField = 'chatPushEnabled', msgPath = 'batches/{room}/chat/{msg}',
    roomDoc = 'batches/{room}', titleField = 'title', topicPrefix = 'chat_', ratePerMin = 6, roomGapMs = 2000, maxAgeMs = 3 * 60 * 1000, now, log } = {}) {
    this.push = push; this.log = log;
    this.configDoc = configDoc; this.switchField = switchField; this.msgPath = msgPath; this.roomDoc = roomDoc; this.titleField = titleField;
    this.topicPrefix = topicPrefix; this.roomGapMs = roomGapMs; this.maxAgeMs = maxAgeMs;
    this.now = now || (() => push.now());
    const { KeyedRateLimiter } = require('./push');
    this.limiter = new KeyedRateLimiter(ratePerMin);
    this.cfgCache = null; this.titleCache = new Map(); this.lastRoom = new Map(); this.sent = new Map();
  }
  get configured() { return this.push.configured; }

  async getDoc(path) {
    const token = await this.push.tokens.getToken();
    const segs = path.split('/').map(encodeURIComponent).join('/');
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.push.sa.projectId)}/databases/(default)/documents/${segs}`;
    const r = await this.push.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) return null;
    if (r.status !== 200) { const e = new Error(`read_failed: ${r.status}`); e.code = 'read_failed'; throw e; }
    return fsFields(await r.json());
  }

  async enabled() {
    const t = this.now();
    if (this.cfgCache && this.cfgCache.until > t) return this.cfgCache.on;
    const d = (await this.getDoc(this.configDoc)) || {};
    const on = d.enabled !== false && d[this.switchField] !== false;
    this.cfgCache = { on, until: t + 60 * 1000 };
    return on;
  }

  async title(room) {
    const t = this.now();
    const hit = this.titleCache.get(room);
    if (hit && hit.until > t) return hit.title;
    const d = (await this.getDoc(fill(this.roomDoc, room))) || {};
    const title = clip(d[this.titleField] || '', 60);
    if (this.titleCache.size > 500) this.titleCache.clear();
    this.titleCache.set(room, { title, until: t + 10 * 60 * 1000 });
    return title;
  }

  /** -> { status, body } */
  async handle(user, body) {
    const room = body && body.room, msg = body && body.msg;
    if (typeof room !== 'string' || !ID_RE.test(room) || typeof msg !== 'string' || !ID_RE.test(msg)) return { status: 400, body: { ok: false, error: 'bad_request' } };
    if (!this.limiter.allow(user.uid, this.now())) return { status: 429, body: { ok: false, error: 'too_many_requests' } };
    if (!this.configured) return { status: 503, body: { ok: false, error: 'push_not_configured' } };
    const key = `${room}/${msg}`;
    if (this.sent.has(key)) return { status: 200, body: { ok: true, skipped: 'duplicate' } };
    let on, m;
    try {
      on = await this.enabled();
      if (!on) return { status: 200, body: { ok: true, skipped: 'off' } };
      m = await this.getDoc(fill(this.msgPath, room, msg));
    } catch (err) {
      this.log && this.log.warn(`room-push: read failed: ${err.message}`);
      return { status: 502, body: { ok: false, error: 'read_failed' } };
    }
    if (!m || m.uid !== user.uid || typeof m.text !== 'string') return { status: 404, body: { ok: false, error: 'not_found' } };
    const at = typeof m.createdAt === 'number' ? m.createdAt : 0;
    if (!at || this.now() - at > this.maxAgeMs) return { status: 409, body: { ok: false, error: 'too_old' } };
    const t = this.now();
    if (this.sent.size > 2000) this.sent.clear();
    this.sent.set(key, t);
    const last = this.lastRoom.get(room) || 0;
    if (t - last < this.roomGapMs) return { status: 200, body: { ok: true, skipped: 'room_busy' } };
    this.lastRoom.set(room, t);
    if (this.lastRoom.size > 2000) this.lastRoom.clear();
    let title = '';
    try { title = await this.title(room); } catch (_) { title = ''; }
    const name = clip(m.name || '', 40);
    const text = clip(m.text, 80);
    const topic = this.topicPrefix + room;
    const out = await this.sendData(topic, room, {
      kind: 'chat', room, msg, uid: user.uid, name, text, title,
      body: name ? `${name}: ${text}` : text, open: `chat:${room}`, at: String(at),
    });
    if (!out.ok) this.log && this.log.warn(`room-push: send failed: ${out.error}`);
    return { status: out.ok ? 200 : 502, body: out };
  }

  async sendData(topic, room, data) {
    const token = await this.push.tokens.getToken();
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.push.sa.projectId)}/messages:send`;
    const message = { topic, data, android: { priority: 'HIGH', collapse_key: `${this.topicPrefix}${room}`, ttl: '3600s' } };
    const r = await this.push.fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.name) return { ok: false, error: `fcm_error: ${String((j.error && (j.error.status || j.error.message)) || `http_${r.status}`).slice(0, 200)}` };
    return { ok: true, messageId: j.name };
  }
}

async function handleRoomPush(req, res, { roomPush, auth, send }) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });
  const h = req.headers['authorization'] || '';
  const mm = /^Bearer\s+(.+)$/i.exec(h);
  const user = mm ? await auth.verifyUser(mm[1].trim()) : null;   // also refuses blocked accounts
  if (!user) { if (!req.complete) req.resume(); return send(res, 401, { ok: false, error: 'login_required' }); }
  const { readJsonBody } = require('./push');
  const parsed = await readJsonBody(req, 2048);
  if (parsed.error) return send(res, parsed.error === 'body_too_large' ? 413 : 400, { ok: false, error: parsed.error });
  let out;
  try { out = await roomPush.handle(user, parsed.value); } catch (err) {
    out = { status: 502, body: { ok: false, error: err.code === 'token_error' ? 'token_error' : 'send_failed' } };
  }
  const extra = out.status === 429 ? { 'Retry-After': '60' } : undefined;
  return send(res, out.status, out.body, extra);
}

module.exports = { RoomPush, handleRoomPush, fsFields };
