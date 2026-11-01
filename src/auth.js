'use strict';
// Who may watch: the app (APP_KEY header), a signed-in app user (Firebase ID token), or a short-lived signed URL.
const crypto = require('crypto');

class Auth {
  constructor({ mode = 'firebase', projectId, signSecret, signTtlSec = 6 * 3600, verifyIdToken, appKey, log, isBlocked, blockTtlMs = 20 * 1000 }) {
    this.mode = mode;
    // Blocked accounts: blocked/{uid} exists in Firestore. Read with the caller's OWN ID token (the database rules
    // let an account read its own blocked doc), so no service-account key is needed. true / false / null (unknown).
    this.blockTtlMs = blockTtlMs;
    this.blockCache = new Map(); // uid -> { blocked, until }
    this.lastToken = new Map();  // uid -> { token, exp } (latest verified ID token, to re-check signed links)
    if (isBlocked) this._isBlocked = isBlocked;
    else if (mode === 'firebase' && projectId) {
      this._isBlocked = async (uid, token) => {
        const u = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/blocked/${encodeURIComponent(uid)}`;
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
        try {
          const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
          if (r.status === 200) return true;
          if (r.status === 404) return false;
          return null;
        } catch (e) { return null; } finally { clearTimeout(t); }
      };
    } else this._isBlocked = async () => false;
    this.appKey = appKey ? String(appKey) : '';
    this.log = log;
    this.signTtlSec = signTtlSec;
    if (!signSecret || signSecret.length < 32) throw new Error('SIGN_SECRET must be at least 32 random characters (run: openssl rand -hex 32)');
    this.secret = signSecret;
    this.tokenCache = new Map(); // sha256(token) -> { uid, email, until }
    if (verifyIdToken) this._verify = verifyIdToken;
    else if (mode === 'firebase') {
      // Verifying Firebase ID tokens needs only the project id (Google's public keys are fetched and cached).
      const { initializeApp, getApps } = require('firebase-admin/app');
      const { getAuth } = require('firebase-admin/auth');
      const app = getApps().find(a => a.name === 'media-relay') || initializeApp({ projectId }, 'media-relay');
      const auth = getAuth(app);
      this._verify = token => auth.verifyIdToken(token);
    }
  }

  static tokenFrom(req, url) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m) return m[1].trim();
    return url.searchParams.get('token') || null;
  }

  /** App key from header X-App-Key (or query k= when allowQuery). */
  static appKeyFrom(req, url, allowQuery = true) {
    const h = req.headers['x-app-key'];
    if (h) return String(h).trim();
    return allowQuery ? (url.searchParams.get('k') || null) : null;
  }

  /** true when APP_KEY is configured and the given key matches it (constant time). */
  checkAppKey(key) {
    if (!this.appKey || !key) return false;
    const a = crypto.createHash('sha256').update(String(key)).digest();
    const b = crypto.createHash('sha256').update(this.appKey).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** A caller of the API: the app (APP_KEY) or a signed-in user (Firebase ID token). */
  async verifyCaller(req, url) {
    if (this.checkAppKey(Auth.appKeyFrom(req, url, true))) return { uid: 'app', email: null };
    return this.verifyUser(Auth.tokenFrom(req, url));
  }

  async verifyUser(token) {
    if (this.mode === 'off') return { uid: 'dev', email: null };
    if (!token) return null;
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const hit = this.tokenCache.get(key);
    if (hit && hit.until > Date.now()) return (await this.blockedWith(hit.uid, token)) ? null : hit;
    try {
      const d = await this._verify(token);
      const user = { uid: d.uid || d.sub, email: d.email || null, emailVerified: d.email_verified !== false, until: Math.min((d.exp || 0) * 1000, Date.now() + 5 * 60 * 1000) };
      if (this.tokenCache.size > 5000) this.tokenCache.clear();
      this.tokenCache.set(key, user);
      this.lastToken.set(user.uid, { token, exp: (d.exp || 0) * 1000 });
      if (this.lastToken.size > 5000) this.lastToken.clear();
      if (await this.blockedWith(user.uid, token)) return null;
      return user;
    } catch (err) {
      this.log && this.log.debug(`token rejected: ${err.code || err.message}`);
      return null;
    }
  }

  /** Is [uid] blocked? Checked with [token] at most every blockTtlMs; a blocked answer is kept 10 minutes. */
  async blockedWith(uid, token) {
    if (!uid || uid === 'app' || uid === 'dev') return false;
    const now = Date.now();
    const c = this.blockCache.get(uid);
    if (c && c.until > now) return c.blocked;
    let b = null;
    try { b = await this._isBlocked(uid, token); } catch (e) { b = null; }
    if (b === null) return c ? c.blocked : false;   // unknown (offline / error): last answer, else allow
    if (this.blockCache.size > 5000) this.blockCache.clear();
    this.blockCache.set(uid, { blocked: b, until: now + (b ? 10 * 60 * 1000 : this.blockTtlMs) });
    if (b) this.log && this.log.info(`blocked account refused`);
    return b;
  }

  /** For a signed link of [uid]: blocked? Uses the cache, else re-checks with the account's latest unexpired token. */
  async uidBlocked(uid) {
    if (!uid || uid === 'app' || uid === 'dev') return false;
    const c = this.blockCache.get(uid);
    if (c && c.until > Date.now()) return c.blocked;
    const t = this.lastToken.get(uid);
    if (t && t.exp > Date.now() + 5000) return this.blockedWith(uid, t.token);
    return c ? c.blocked : false;
  }

  _mac(kind, id, exp, uid) {
    return crypto.createHmac('sha256', this.secret).update(`${kind}:${id}:${exp}:${uid || ''}`).digest('base64url');
  }

  /** Returns query params { exp, u, sig } that make /<kind>/<id> playable without headers until exp. */
  sign(kind, id, uid, ttlSec = this.signTtlSec, now = Date.now()) {
    const exp = Math.floor(now / 1000) + ttlSec;
    return { exp, u: uid || '', sig: this._mac(kind, id, exp, uid) };
  }

  /** 'ok' | 'expired' | 'bad' | 'none' */
  checkSigned(kind, id, url, now = Date.now()) {
    const sig = url.searchParams.get('sig');
    const exp = Number(url.searchParams.get('exp'));
    if (!sig) return 'none';
    if (!Number.isFinite(exp)) return 'bad';
    const good = this._mac(kind, id, exp, url.searchParams.get('u') || '');
    const a = Buffer.from(sig), b = Buffer.from(good);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'bad';
    if (exp * 1000 < now) return 'expired';
    return 'ok';
  }

  /** For /stream and /thumb: a valid signed URL, OR an X-App-Key header, OR a Firebase token. */
  async allowMedia(kind, id, req, url) {
    const s = this.checkSigned(kind, id, url);
    if (s === 'ok') {
      const u = url.searchParams.get('u') || null;
      if (await this.uidBlocked(u)) return { ok: false, status: 403, error: 'blocked' };
      return { ok: true, uid: u };
    }
    if (s === 'expired') return { ok: false, status: 403, error: 'link_expired' };
    if (s === 'bad') return { ok: false, status: 403, error: 'bad_signature' };
    // header only for media: a key in the query string would make a shareable bare URL
    if (this.checkAppKey(Auth.appKeyFrom(req, url, false))) return { ok: true, uid: 'app' };
    const user = await this.verifyUser(Auth.tokenFrom(req, url));
    if (user) return { ok: true, uid: user.uid };
    return { ok: false, status: 401, error: 'login_required' };
  }
}

class RateLimiter {
  constructor(perMin) { this.perMin = perMin; this.hits = new Map(); this.window = 0; }
  allow(ip, now = Date.now()) {
    if (!this.perMin) return true;
    const win = Math.floor(now / 60000);
    if (win !== this.window) { this.window = win; this.hits.clear(); }
    const n = (this.hits.get(ip) || 0) + 1;
    this.hits.set(ip, n);
    return n <= this.perMin;
  }
}

module.exports = { Auth, RateLimiter };
