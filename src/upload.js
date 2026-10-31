'use strict';
// Admin uploads: a file from the browser goes straight into a GitHub release asset.
//
//   GET    /api/upload/config               public: is upload set up? limits (also wakes a sleeping server)
//   POST   /api/upload/start                {kind, name, size, type} -> {id, name, chunkSize}   (admin)
//   PUT    /api/upload/chunk?id=&offset=     raw bytes; resumable: a wrong offset answers 409 {received}
//   GET    /api/upload/status?id=           {received, size, done, url}
//   DELETE /api/upload/session?id=          cancel
//   POST   /api/upload?kind=&name=          one-shot: the whole file as the body (curl / small files)
//   POST   /api/upload/qualities            {name} -> starts the quality-copy workflow for an uploaded video
//   GET    /api/upload/qualities?name=      {status, urls}
//
// Bytes are piped to uploads.github.com as they arrive (one open upstream request per upload with the
// final Content-Length), so memory stays at one chunk at most whatever the file size.
// Everything specific (repo, release tags, token, workflow file) comes from env.
const https = require('https');
const crypto = require('crypto');

const GIB = 1024 ** 3;
const MAX_FILE_BYTES = 2 * GIB - 16 * 1024 * 1024; // GitHub: each release asset must be under 2 GiB
const DEFAULT_CHUNK = 8 * 1024 * 1024;
const KINDS = {
  pdf: { ext: '.pdf', types: ['application/pdf'], sniff: b => b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-' },
  video: { ext: '.mp4', types: ['video/mp4'], sniff: b => b.length >= 8 && b.subarray(4, 8).toString('latin1') === 'ftyp' },
};
const QUALITIES = ['720p', '480p', '360p'];

/** A safe GitHub asset name: letters, digits, dot, dash, underscore; the kind's extension. */
function safeName(raw, kind) {
  const k = KINDS[kind];
  if (!k) return null;
  let n = String(raw || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  n = n.replace(/\.[A-Za-z0-9]{1,5}$/, '');            // drop any extension, we add the right one
  n = n.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  if (!n) n = kind === 'pdf' ? 'book' : 'lecture';
  return n.slice(0, 120) + k.ext;
}

/** name.pdf -> name-2.pdf, name-3.pdf ... until free. */
function uniqueName(name, taken) {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const base = name.slice(0, dot), ext = name.slice(dot);
  for (let i = 2; i < 10000; i++) {
    const c = `${base}-${i}${ext}`;
    if (!taken.has(c.toLowerCase())) return c;
  }
  return `${base}-${crypto.randomBytes(4).toString('hex')}${ext}`;
}

function qualityName(name, q) { return name.replace(/\.mp4$/i, '') + `_${q}.mp4`; }

class GitHubReleases {
  constructor({ token, repo, fetchImpl = globalThis.fetch, uploadImpl, apiBase = 'https://api.github.com', uploadBase = 'https://uploads.github.com' }) {
    this.token = token; this.repo = repo; this.fetch = fetchImpl;
    this.apiBase = apiBase; this.uploadBase = uploadBase;
    this.uploadImpl = uploadImpl || httpsUpload;
    this.releases = new Map(); // tag -> {id, at}
  }
  headers(extra = {}) {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'media-relay', ...extra };
  }
  async api(method, p, body) {
    const r = await this.fetch(`${this.apiBase}${p}`, { method, headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const text = r.status === 204 ? '' : await r.text().catch(() => '');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* not json */ }
    return { status: r.status, json };
  }
  async releaseId(tag, create = true) {
    const hit = this.releases.get(tag);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.id;
    let r = await this.api('GET', `/repos/${this.repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (r.status === 404 && create) {
      r = await this.api('POST', `/repos/${this.repo}/releases`, { tag_name: tag, name: tag, body: 'Files uploaded from the admin panel.' });
      if (r.status === 422) r = await this.api('GET', `/repos/${this.repo}/releases/tags/${encodeURIComponent(tag)}`); // created meanwhile
    }
    if (r.status === 401 || r.status === 403) throw codeErr('github_auth_failed', `GitHub refused the token (${r.status})`);
    if (!r.json || !r.json.id) throw codeErr('github_release_failed', `release ${tag}: http ${r.status}`);
    this.releases.set(tag, { id: r.json.id, at: Date.now() });
    return r.json.id;
  }
  async assets(releaseId) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const r = await this.api('GET', `/repos/${this.repo}/releases/${releaseId}/assets?per_page=100&page=${page}`);
      if (r.status !== 200 || !Array.isArray(r.json)) throw codeErr('github_release_failed', `assets: http ${r.status}`);
      out.push(...r.json);
      if (r.json.length < 100) break;
    }
    return out;
  }
  async deleteAsset(id) { return (await this.api('DELETE', `/repos/${this.repo}/releases/assets/${id}`)).status; }
  /** Opens the upstream upload. Returns {stream, done: Promise<asset>, abort()}. */
  openUpload(releaseId, name, type, size) {
    const url = `${this.uploadBase}/repos/${this.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    return this.uploadImpl(url, this.headers({ 'Content-Type': type, 'Content-Length': String(size) }));
  }
  downloadUrl(tag, name) { return `https://github.com/${this.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`; }
  async dispatch(workflow, ref, inputs) {
    const r = await this.api('POST', `/repos/${this.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs });
    return r;
  }
  async runs(workflow) {
    const r = await this.api('GET', `/repos/${this.repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=30&event=workflow_dispatch`);
    return r.status === 200 && r.json ? (r.json.workflow_runs || []) : [];
  }
}

function codeErr(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

/** Real upstream: one https request whose body we write as chunks arrive. */
function httpsUpload(url, headers) {
  const u = new URL(url);
  let req;
  const done = new Promise((resolve, reject) => {
    req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 0 }, res => {
      const bufs = [];
      res.on('data', d => { if (bufs.length < 200) bufs.push(d); });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(Buffer.concat(bufs).toString('utf8')); } catch (_) { /* */ }
        if (res.statusCode === 201 && json) resolve(json);
        else {
          const why = json && (json.errors && json.errors[0] && json.errors[0].code || json.message);
          reject(codeErr(res.statusCode === 422 ? 'name_taken' : 'github_upload_failed', `GitHub answered ${res.statusCode}${why ? ': ' + why : ''}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', err => reject(codeErr('github_upload_failed', err.message)));
  });
  done.catch(() => {});
  return { stream: req, done, abort: () => { try { req.destroy(new Error('aborted')); } catch (_) { /* */ } } };
}

class UploadService {
  /**
   * @param {object} o  token, repo ("owner/name"), pdfTag, videoTag, qualityWorkflow, workflowRef,
   *                    ownerEmail, projectId (Firebase, for the staff check with the caller's own token),
   *                    push (PushService: staff check through the service account when it is set)
   */
  constructor({ token = '', repo = '', pdfTag = '', videoTag = '', qualityWorkflow = '', workflowRef = 'main', chunkSize = DEFAULT_CHUNK,
    idleMs = 3 * 60 * 1000, maxSessionsPerUser = 2, maxSessions = 4, ownerEmail = '', projectId = '', push = null,
    fetchImpl = globalThis.fetch, uploadImpl, now = () => Date.now(), log } = {}) {
    this.repo = String(repo || '').trim();
    this.tags = { pdf: String(pdfTag || '').trim(), video: String(videoTag || '').trim() };
    this.gh = (token && /^[\w.-]+\/[\w.-]+$/.test(this.repo)) ? new GitHubReleases({ token: String(token).trim(), repo: this.repo, fetchImpl, uploadImpl }) : null;
    this.qualityWorkflow = String(qualityWorkflow || '').trim();
    this.workflowRef = workflowRef || 'main';
    this.chunkSize = chunkSize; this.idleMs = idleMs;
    this.maxSessionsPerUser = maxSessionsPerUser; this.maxSessions = maxSessions;
    this.ownerEmail = String(ownerEmail || '').trim().toLowerCase();
    this.projectId = String(projectId || '').trim();
    this.push = push; this.fetch = fetchImpl; this.now = now; this.log = log;
    this.sessions = new Map();
    this.staffCache = new Map();
    this.dispatchLimiter = new Map();
  }

  get configured() { return !!this.gh; }
  kindConfigured(kind) { return this.configured && !!this.tags[kind]; }
  publicConfig() {
    return { ok: true, configured: this.configured, kinds: Object.keys(KINDS).filter(k => this.kindConfigured(k)),
      maxBytes: MAX_FILE_BYTES, chunkSize: this.chunkSize, qualities: this.qualityWorkflow ? QUALITIES : [] };
  }

  /** Owner email, or a staff document admins/{email} (service account if set, else the caller's own ID token). */
  async isStaff(user, idToken) {
    const e = String(user.email || '').trim().toLowerCase();
    if (!e || user.emailVerified === false) return false;
    if (this.ownerEmail && e === this.ownerEmail) return true;
    if (this.push && this.push.configured) return this.push.isAdmin(e);
    const hit = this.staffCache.get(e);
    if (hit && hit.until > this.now()) return hit.staff;
    if (!this.projectId || !idToken) return false;
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/databases/(default)/documents/admins/${encodeURIComponent(e)}`;
    const r = await this.fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
    let staff;
    if (r.status === 200) staff = true;
    else if (r.status === 404 || r.status === 403) staff = false;
    else throw codeErr('admin_check_failed', `admin check: http ${r.status}`);
    if (this.staffCache.size > 1000) this.staffCache.clear();
    this.staffCache.set(e, { staff, until: this.now() + 60 * 1000 });
    return staff;
  }

  activeFor(uid) { let n = 0; for (const s of this.sessions.values()) if (s.uid === uid && s.state === 'open') n++; return n; }

  /** Validates and reserves a name; the upstream request opens with the first byte. */
  async start(user, { kind, name, size, type }) {
    if (!KINDS[kind]) return { status: 400, body: { ok: false, error: 'bad_kind' } };
    if (!this.kindConfigured(kind)) return { status: 503, body: { ok: false, error: 'upload_not_configured' } };
    size = Number(size);
    if (!Number.isSafeInteger(size) || size <= 0) return { status: 400, body: { ok: false, error: 'bad_size' } };
    if (size > MAX_FILE_BYTES) return { status: 413, body: { ok: false, error: 'file_too_large', maxBytes: MAX_FILE_BYTES } };
    const t = String(type || '').toLowerCase().split(';')[0].trim();
    if (t && !KINDS[kind].types.includes(t)) return { status: 415, body: { ok: false, error: 'wrong_type', expected: KINDS[kind].types[0] } };
    const base = safeName(name, kind);
    this.sweep();
    if (this.activeFor(user.uid) >= this.maxSessionsPerUser || this.sessions.size >= this.maxSessions) return { status: 429, body: { ok: false, error: 'too_many_uploads' } };

    const tag = this.tags[kind];
    const releaseId = await this.gh.releaseId(tag);
    const assets = await this.gh.assets(releaseId);
    // A broken earlier upload leaves an asset stuck in state "starter" that blocks its name: clear those.
    for (const a of assets) if (a.state && a.state !== 'uploaded' && a.name.toLowerCase() === base.toLowerCase()) await this.gh.deleteAsset(a.id).catch(() => {});
    const taken = new Set(assets.filter(a => a.state === 'uploaded' || !a.state).map(a => a.name.toLowerCase()));
    for (const s of this.sessions.values()) if (s.tag === tag && s.state !== 'failed') taken.add(s.name.toLowerCase());
    const finalName = uniqueName(base, taken);

    const id = crypto.randomBytes(12).toString('base64url');
    const s = { id, uid: user.uid, kind, tag, releaseId, name: finalName, size, type: KINDS[kind].types[0], received: 0,
      state: 'open', busy: false, up: null, result: null, error: null, touched: this.now(), timer: null, head: Buffer.alloc(0) };
    this.sessions.set(id, s);
    this.touch(s);
    this.log && this.log.info(`upload: start ${kind} ${finalName} (${size} bytes) by ${user.uid}`);
    return { status: 200, body: { ok: true, id, name: finalName, size, chunkSize: this.chunkSize, url: this.gh.downloadUrl(tag, finalName) } };
  }

  touch(s) {
    s.touched = this.now();
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { if (s.state === 'open' && !s.busy) this.fail(s, 'upload_timed_out'); }, this.idleMs);
    if (s.timer.unref) s.timer.unref();
  }

  sweep() {
    for (const [id, s] of this.sessions) {
      if (s.state !== 'open' && this.now() - s.touched > 30 * 60 * 1000) { clearTimeout(s.timer); this.sessions.delete(id); }
    }
  }

  fail(s, error) {
    if (s.state !== 'open') return;
    s.state = 'failed'; s.error = error; s.touched = this.now();
    clearTimeout(s.timer);
    if (s.up) { s.up.abort(); this.cleanupStarter(s).catch(() => {}); }
    this.log && this.log.warn(`upload: ${s.name} failed at ${s.received}/${s.size}: ${error}`);
  }

  async cleanupStarter(s) {
    await new Promise(r => setTimeout(r, 1500));
    const assets = await this.gh.assets(s.releaseId);
    for (const a of assets) if (a.name === s.name && a.state !== 'uploaded') await this.gh.deleteAsset(a.id);
  }

  status(s) {
    const b = { ok: s.state !== 'failed', id: s.id, name: s.name, size: s.size, received: s.received, done: s.state === 'done' };
    if (s.result) Object.assign(b, s.result);
    if (s.error) b.error = s.error;
    return b;
  }

  get(id, uid) { const s = this.sessions.get(String(id || '')); return s && s.uid === uid ? s : null; }

  /**
   * Pipes one request body into the upload at offset. Resolves {status, body}.
   * limit: max bytes this request may carry (chunk size; the whole file for the one-shot route).
   */
  chunk(s, req, offset, limit) {
    return new Promise(resolve => {
      const answer = (status, body) => { s.busy = false; this.touch(s); resolve({ status, body }); };
      if (s.state === 'done') { req.resume(); return resolve({ status: 200, body: this.status(s) }); }
      if (s.state === 'failed') { req.resume(); return resolve({ status: 410, body: this.status(s) }); }
      if (s.busy) { req.resume(); return resolve({ status: 409, body: { ok: false, error: 'busy', received: s.received } }); }
      if (offset !== s.received) { req.resume(); return resolve({ status: 409, body: { ok: false, error: 'offset_mismatch', received: s.received } }); }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && (declared > limit || s.received + declared > s.size)) { req.resume(); return resolve({ status: 413, body: { ok: false, error: 'chunk_too_large', received: s.received } }); }
      s.busy = true;
      let got = 0; let ended = false;
      const kind = KINDS[s.kind];

      let waiting = false;
      const write = (buf) => {
        if (s.received + buf.length > s.size) { this.fail(s, 'size_mismatch'); return false; }
        if (!s.up) {
          s.up = this.gh.openUpload(s.releaseId, s.name, s.type, s.size);
          s.up.done.catch(err => { if (s.state === 'open') { this.fail(s, 'github_upload_failed'); s.upstreamError = String(err.message).slice(0, 200); } });
        }
        s.received += buf.length; got += buf.length;
        const ok = s.up.stream.write(buf);
        if (!ok && !waiting) { waiting = true; req.pause(); s.up.stream.once('drain', () => { waiting = false; req.resume(); }); }
        return true;
      };

      req.on('data', d => {
        if (s.state !== 'open' || ended) return;
        if (got + d.length > limit) { ended = true; this.fail(s, 'chunk_too_large'); req.resume(); return answer(413, this.status(s)); }
        if (s.received < 16) {           // check the file's first bytes before anything goes to GitHub
          s.head = Buffer.concat([s.head, d]);
          if (s.head.length < 16 && s.received + s.head.length < s.size) return; // wait for more
          if (!kind.sniff(s.head)) { ended = true; this.fail(s, 'wrong_type'); req.resume(); return answer(415, { ok: false, error: 'wrong_type', expected: s.type }); }
          const h = s.head; s.head = Buffer.alloc(0); write(h); return;
        }
        write(d);
      });
      req.on('end', async () => {
        if (ended) return; ended = true;
        if (s.state !== 'open') return answer(410, this.status(s));
        if (s.head.length) { // the whole file was shorter than the sniff window
          if (!kind.sniff(s.head)) { this.fail(s, 'wrong_type'); return answer(415, { ok: false, error: 'wrong_type', expected: s.type }); }
          const h = s.head; s.head = Buffer.alloc(0); write(h);
        }
        if (s.received < s.size) return answer(200, { ok: true, received: s.received, size: s.size, done: false });
        s.up.stream.end();
        try {
          const asset = await s.up.done;
          s.state = 'done';
          s.result = { url: asset.browser_download_url || this.gh.downloadUrl(s.tag, asset.name || s.name), name: asset.name || s.name, size: asset.size || s.size };
          this.log && this.log.info(`upload: done ${s.result.name} (${s.result.size} bytes)`);
          return answer(200, this.status(s));
        } catch (err) {
          this.fail(s, err.code || 'github_upload_failed');
          s.error = err.code === 'name_taken' ? 'name_taken' : 'github_upload_failed';
          return answer(502, { ...this.status(s), detail: String(err.message).slice(0, 200) });
        }
      });
      const broken = () => {
        if (ended) return; ended = true;
        // The phone lost the connection mid-chunk: keep what reached GitHub; the client resumes from `received`.
        s.busy = false; this.touch(s);
        resolve({ status: 499, body: { ok: false, error: 'client_closed', received: s.received } });
      };
      req.on('aborted', broken);
      req.on('error', broken);
      req.on('close', () => { if (!ended && !req.complete) broken(); });
    });
  }

  cancel(s) { this.fail(s, 'cancelled'); return { status: 200, body: { ok: true, cancelled: true } }; }

  /** Quality copies: dispatch the workflow for an uploaded video asset. */
  async startQualities(user, name) {
    if (!this.kindConfigured('video') || !this.qualityWorkflow) return { status: 503, body: { ok: false, error: 'qualities_not_configured' } };
    const n = String(name || '');
    if (!/^[A-Za-z0-9._-]{1,140}\.mp4$/.test(n)) return { status: 400, body: { ok: false, error: 'bad_name' } };
    const last = this.dispatchLimiter.get(n) || 0;
    if (this.now() - last < 60 * 1000) return { status: 429, body: { ok: false, error: 'already_started' } };
    const tag = this.tags.video;
    const releaseId = await this.gh.releaseId(tag);
    const assets = await this.gh.assets(releaseId);
    const src = assets.find(a => a.name === n && a.state === 'uploaded');
    if (!src) return { status: 404, body: { ok: false, error: 'video_not_found' } };
    const r = await this.gh.dispatch(this.qualityWorkflow, this.workflowRef, { tag, name: n });
    if (r.status !== 204) {
      const error = r.status === 403 || r.status === 401 ? 'github_actions_permission' : r.status === 404 ? 'workflow_not_found' : 'dispatch_failed';
      return { status: 502, body: { ok: false, error, detail: `http ${r.status}` } };
    }
    this.dispatchLimiter.set(n, this.now());
    this.log && this.log.info(`upload: quality copies started for ${n} by ${user.uid}`);
    return { status: 202, body: { ok: true, started: true, name: n, expected: Object.fromEntries(QUALITIES.map(q => [q, this.gh.downloadUrl(tag, qualityName(n, q))])) } };
  }

  async qualityStatus(name) {
    if (!this.kindConfigured('video')) return { status: 503, body: { ok: false, error: 'upload_not_configured' } };
    const n = String(name || '');
    if (!/^[A-Za-z0-9._-]{1,140}\.mp4$/.test(n)) return { status: 400, body: { ok: false, error: 'bad_name' } };
    const tag = this.tags.video;
    const releaseId = await this.gh.releaseId(tag);
    const assets = await this.gh.assets(releaseId);
    const urls = {};
    for (const q of QUALITIES) {
      const a = assets.find(x => x.name === qualityName(n, q) && x.state === 'uploaded');
      if (a) urls[q] = a.browser_download_url || this.gh.downloadUrl(tag, a.name);
    }
    let run = null;
    if (this.qualityWorkflow) {
      const runs = await this.gh.runs(this.qualityWorkflow);
      const r = runs.find(x => String(x.display_title || x.name || '').includes(n));
      if (r) run = { status: r.status, conclusion: r.conclusion, url: r.html_url, startedAt: r.run_started_at || r.created_at };
    }
    const ready = QUALITIES.every(q => urls[q]);
    const status = ready ? 'ready' : run ? (run.status === 'completed' ? (run.conclusion === 'success' ? 'partial' : 'failed') : 'running') : 'not_started';
    return { status: 200, body: { ok: true, name: n, status, urls, run } };
  }
}

function readSmallJson(req, limit = 4096) {
  return new Promise(resolve => {
    let size = 0; const bufs = []; let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    req.on('data', d => { size += d.length; if (size > limit) { finish({ error: 'body_too_large' }); req.resume(); return; } bufs.push(d); });
    req.on('end', () => { try { finish({ value: JSON.parse(Buffer.concat(bufs).toString('utf8') || 'null') }); } catch (_) { finish({ error: 'invalid_json' }); } });
    req.on('error', () => finish({ error: 'invalid_json' }));
  });
}

/** Routes everything under /api/upload. Returns a promise; the response is always written. */
async function handleUpload(req, res, url, { uploads, auth, adminOrigins, send, log }) {
  const origin = String(req.headers['origin'] || '').replace(/\/+$/, '');
  const cors = { Vary: 'Origin' };
  if (origin && adminOrigins.includes(origin)) {
    cors['Access-Control-Allow-Origin'] = origin;
    cors['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    cors['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    cors['Access-Control-Max-Age'] = '600';
  }
  const reply = (status, body) => send(res, status, body, cors);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const p = url.pathname.replace(/\/+$/, '');
  const drain = () => { if (!req.complete) req.resume(); };

  if (p === '/api/upload/config' && req.method === 'GET') {
    const c = uploads.publicConfig();
    return reply(c.configured ? 200 : 503, c.configured ? c : { ...c, ok: false, error: 'upload_not_configured' });
  }

  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  const idToken = m ? m[1].trim() : '';
  const user = idToken ? await auth.verifyUser(idToken) : null;
  if (!user) { drain(); return reply(401, { ok: false, error: 'login_required' }); }
  if (!uploads.configured) { drain(); return reply(503, { ok: false, error: 'upload_not_configured' }); }
  let staff;
  try { staff = await uploads.isStaff(user, idToken); } catch (err) {
    log && log.warn(`upload: admin check failed: ${err.message}`);
    drain(); return reply(502, { ok: false, error: 'admin_check_failed' });
  }
  if (!staff) { drain(); return reply(403, { ok: false, error: 'not_admin' }); }

  try {
    if (p === '/api/upload/start' && req.method === 'POST') {
      const b = await readSmallJson(req);
      if (b.error || !b.value || typeof b.value !== 'object') return reply(400, { ok: false, error: b.error || 'invalid_json' });
      const r = await uploads.start(user, b.value);
      return reply(r.status, r.body);
    }
    if (p === '/api/upload/chunk' && (req.method === 'PUT' || req.method === 'POST')) {
      const s = uploads.get(url.searchParams.get('id'), user.uid);
      if (!s) { drain(); return reply(404, { ok: false, error: 'no_such_upload' }); }
      const offset = Number(url.searchParams.get('offset'));
      if (!Number.isSafeInteger(offset) || offset < 0) { drain(); return reply(400, { ok: false, error: 'bad_offset' }); }
      const r = await uploads.chunk(s, req, offset, uploads.chunkSize + 1024 * 1024);
      if (r.status === 499) { try { res.destroy(); } catch (_) { /* */ } return; } // the client is gone
      return reply(r.status, r.body);
    }
    if (p === '/api/upload/status' && req.method === 'GET') {
      const s = uploads.get(url.searchParams.get('id'), user.uid);
      if (!s) return reply(404, { ok: false, error: 'no_such_upload' });
      return reply(200, uploads.status(s));
    }
    if (p === '/api/upload/session' && req.method === 'DELETE') {
      const s = uploads.get(url.searchParams.get('id'), user.uid);
      if (!s) return reply(404, { ok: false, error: 'no_such_upload' });
      const r = uploads.cancel(s);
      return reply(r.status, r.body);
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const size = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(size) || size <= 0) { drain(); return reply(411, { ok: false, error: 'length_required' }); }
      const st = await uploads.start(user, { kind: url.searchParams.get('kind'), name: url.searchParams.get('name'), size, type: req.headers['content-type'] });
      if (st.status !== 200) { drain(); return reply(st.status, st.body); }
      const s = uploads.get(st.body.id, user.uid);
      const r = await uploads.chunk(s, req, 0, size);
      if (r.status === 499) { uploads.fail(s, 'client_closed'); try { res.destroy(); } catch (_) { /* */ } return; }
      if (r.status === 200 && !r.body.done) { uploads.fail(s, 'incomplete'); return reply(400, { ok: false, error: 'incomplete' }); }
      return reply(r.status, r.body);
    }
    if (p === '/api/upload/qualities' && req.method === 'POST') {
      const b = await readSmallJson(req);
      if (b.error || !b.value) return reply(400, { ok: false, error: b.error || 'invalid_json' });
      const r = await uploads.startQualities(user, b.value.name);
      return reply(r.status, r.body);
    }
    if (p === '/api/upload/qualities' && req.method === 'GET') {
      const r = await uploads.qualityStatus(url.searchParams.get('name'));
      return reply(r.status, r.body);
    }
  } catch (err) {
    log && log.warn(`upload: ${err.code || 'error'}: ${err.message}`);
    drain();
    return reply(502, { ok: false, error: err.code || 'upload_failed' });
  }
  drain();
  return reply(405, { ok: false, error: 'method_not_allowed' });
}

module.exports = { UploadService, GitHubReleases, handleUpload, safeName, uniqueName, qualityName, MAX_FILE_BYTES, KINDS, QUALITIES };
