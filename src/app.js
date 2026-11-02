'use strict';
// HTTP layer: /health, /api/videos, /api/sign, /stream/:msgId (Range), /thumb/:msgId, /api/stats, POST /api/push, POST /api/room-push, POST /api/img
const http = require('http');
const { parseRange } = require('./range');
const { Auth, RateLimiter } = require('./auth');
const { CHUNK_SIZE } = require('./chunkCache');
const { PushService, handlePush, parseOrigins } = require('./push');
const { UploadService, handleUpload } = require('./upload');
const { RoomPush, handleRoomPush } = require('./roomPush');
const { ImgbbService, handleImg } = require('./img');

function createApp({ config, source, cache, auth, log, push, uploads, roomPush, imgbb }) {
  const limiter = new RateLimiter(config.rateLimitPerMin);
  const pushService = push || new PushService({ serviceAccount: config.fcmServiceAccount, ownerEmail: config.ownerEmail,
    channelId: config.pushChannelId, ratePerMin: config.pushRatePerMin ?? 20, log });
  const adminOrigins = parseOrigins(config.adminOrigins);
  const roomPushService = roomPush || new RoomPush({ push: pushService, configDoc: config.roomPushConfigDoc, switchField: config.roomPushSwitch,
    msgPath: config.roomPushMsgPath, roomDoc: config.roomPushRoomDoc, titleField: config.roomPushTitleField, topicPrefix: config.roomPushTopicPrefix,
    ratePerMin: config.roomPushRatePerMin ?? 6, supabaseUrl: config.supabaseUrl, supabaseKey: config.supabaseKey, log });
  const uploadService = uploads || new UploadService({ token: config.uploadToken, repo: config.uploadRepo, pdfTag: config.uploadReleasePdf,
    videoTag: config.uploadReleaseVideo, qualityWorkflow: config.uploadQualityWorkflow, workflowRef: config.uploadWorkflowRef, partsTag: config.uploadReleaseParts,
    ownerEmail: config.ownerEmail, projectId: config.firebaseProjectId, push: pushService, log });
  const imgbbService = imgbb || new ImgbbService({ key: config.imgbbKey, maxBytes: config.imgbbMaxBytes, ratePerMin: config.imgbbRatePerMin ?? 30, log });
  const started = Date.now();
  let listCache = null; // { at, videos }
  let listInflight = null;
  let lastForcedRefresh = 0;
  source.onNewPost = () => { listCache = null; }; // new upload in the channel -> refresh list next time

  // Absolute base for signed links: PUBLIC_BASE_URL if set, else the request's own host
  // (behind a proxy such as Render: X-Forwarded-Proto / X-Forwarded-Host).
  function baseFor(req) {
    if (config.publicBaseUrl) return config.publicBaseUrl;
    if (!req) return '';
    const first = v => (v ? String(v).split(',')[0].trim() : '');
    const xfProto = config.trustProxy ? first(req.headers['x-forwarded-proto']) : '';
    const xfHost = config.trustProxy ? first(req.headers['x-forwarded-host']) : '';
    const host = xfHost || first(req.headers['host']);
    if (!host || !/^[A-Za-z0-9.\-]+(:\d+)?$/.test(host)) return '';
    const proto = /^https?$/.test(xfProto) ? xfProto : (req.socket && req.socket.encrypted ? 'https' : 'http');
    return `${proto}://${host}`;
  }
  const signedUrl = (kind, id, uid, req) => {
    const s = auth.sign(kind, id, uid);
    return { url: `${baseFor(req)}/${kind}/${id}?exp=${s.exp}&u=${encodeURIComponent(s.u)}&sig=${s.sig}`, exp: s.exp };
  };
  const titleOf = m => {
    const first = String(m.caption || '').trim().split('\n')[0].trim();
    if (first) return first.slice(0, 200);
    if (m.fileName) return String(m.fileName).replace(/\.[^.]+$/, '');
    return m.title || `Lecture ${m.msgId}`;
  };
  const publicVideo = (m, uid, req) => {
    const stream = signedUrl('stream', m.msgId, uid, req);
    return {
      msgId: m.msgId, title: titleOf(m), caption: m.caption || '', fileName: m.fileName || null,
      duration: m.duration ?? null, size: m.size, width: m.width ?? null, height: m.height ?? null,
      mime: m.mime || 'video/mp4', date: m.date ?? null, hasThumb: !!m.hasThumb,
      streamUrl: stream.url,
      thumbUrl: m.hasThumb ? signedUrl('thumb', m.msgId, uid, req).url : null,
      expiresAt: stream.exp,
      streamUrlExpires: stream.exp,
    };
  };

  async function getList(force) {
    if (!force && listCache && Date.now() - listCache.at < config.listTtlSec * 1000) return listCache;
    if (listInflight) return listInflight;
    listInflight = (async () => {
      const videos = await cache._retry(() => source.list(), 'list videos');
      for (const v of videos) cache.rememberMeta(v);
      listCache = { at: Date.now(), videos };
      log.info(`list: ${videos.length} video(s) in channel`);
      return listCache;
    })().finally(() => { listInflight = null; });
    return listInflight;
  }

  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', ...headers });
    res.end(data);
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      if (xf) return String(xf).split(',')[0].trim();
      if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
    }
    return req.socket.remoteAddress || '?';
  }

  async function requireUser(req, res, url) {
    const user = await auth.verifyCaller(req, url);
    if (!user) { send(res, 401, { error: 'login_required' }); return null; }
    return user;
  }

  async function streamVideo(req, res, msgId, url) {
    const ok = await auth.allowMedia('stream', msgId, req, url);
    if (!ok.ok) return send(res, ok.status, { error: ok.error });
    const meta = await cache.getMeta(msgId);
    if (!meta) return send(res, 404, { error: 'not_found' });
    const size = meta.size;
    const range = parseRange(req.headers['range'], size);
    const common = {
      'Accept-Ranges': 'bytes',
      'Content-Type': meta.mime || 'video/mp4',
      'Cache-Control': 'private, max-age=3600',
      'ETag': `"${msgId}-${meta.docId || size}"`,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    };
    if (range === 'invalid') {
      res.writeHead(416, { ...common, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
      return res.end();
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = end - start + 1;

    // Fetch the first chunk BEFORE sending headers, so a Telegram error can still become a clean 502.
    const firstIdx = Math.floor(start / CHUNK_SIZE);
    const lastIdx = Math.floor(end / CHUNK_SIZE);
    let first = req.method === 'HEAD' ? null : await cache.getChunk(msgId, firstIdx, meta);

    const headers = { ...common, 'Content-Length': length };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();

    let closed = false;
    res.on('close', () => { closed = true; });
    log.debug(`stream ${msgId} ${start}-${end}/${size} uid=${ok.uid || '-'}`);
    try {
      for (let idx = firstIdx; idx <= lastIdx && !closed; idx++) {
        const buf = idx === firstIdx ? first : await cache.getChunk(msgId, idx, meta);
        first = null;
        cache.prefetch(msgId, idx, meta);
        const chunkStart = idx * CHUNK_SIZE;
        const from = Math.max(start, chunkStart) - chunkStart;
        const to = Math.min(end, chunkStart + buf.length - 1) - chunkStart + 1;
        if (!res.write(buf.subarray(from, to))) {
          await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.on('drain', done); res.on('close', done);
          });
        }
      }
      if (!closed) res.end();
    } catch (err) {
      log.warn(`stream ${msgId} stopped mid-way: ${err.errorMessage || err.message}`);
      res.destroy(err);
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    if (p === '/api/upload' || p.startsWith('/api/upload/')) {
      if (req.method !== 'OPTIONS' && !limiter.allow(clientIp(req))) { if (!req.complete) req.resume(); return send(res, 429, { ok: false, error: 'too_many_requests' }, { 'Retry-After': '60' }); }
      return handleUpload(req, res, url, { uploads: uploadService, auth, adminOrigins, send, log });
    }
    if (p === '/api/img' || p.startsWith('/api/img/')) {
      if (req.method !== 'OPTIONS' && !limiter.allow(clientIp(req))) { if (!req.complete) req.resume(); return send(res, 429, { ok: false, error: 'too_many_requests' }, { 'Retry-After': '60' }); }
      return handleImg(req, res, url, { imgbb: imgbbService, uploads: uploadService, auth, adminOrigins, send, log });
    }
    if (p === '/api/room-push') {
      if (!limiter.allow(clientIp(req))) { if (!req.complete) req.resume(); return send(res, 429, { ok: false, error: 'too_many_requests' }, { 'Retry-After': '60' }); }
      return handleRoomPush(req, res, { roomPush: roomPushService, auth, send });
    }
    if (p === '/api/push') {
      if (req.method !== 'OPTIONS' && !limiter.allow(clientIp(req))) return send(res, 429, { ok: false, error: 'too_many_requests' }, { 'Retry-After': '60' });
      return handlePush(req, res, { push: pushService, auth, adminOrigins, send, log });
    }
    if (config.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range, X-App-Key');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }
    if (p === '/health') {
      const telegram = source.mode === 'mock' ? 'mock' : (source.connected ? 'connected' : (source.status || 'disconnected'));
      return send(res, 200, { ok: true, telegram, source: source.mode, telegramConnected: !!source.connected, uptimeSec: Math.round((Date.now() - started) / 1000),
        cache: { chunks: cache.info().chunks, usedMB: Math.round(cache.totalBytes / 1048576), maxGB: +(cache.maxBytes / 1073741824).toFixed(2) } });
    }
    if (!limiter.allow(clientIp(req))) return send(res, 429, { error: 'too_many_requests' }, { 'Retry-After': '60' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });

    let m;
    if ((m = /^\/stream\/(\d+)$/.exec(p))) return streamVideo(req, res, Number(m[1]), url);

    if ((m = /^\/thumb\/(\d+)$/.exec(p))) {
      const id = Number(m[1]);
      const ok = await auth.allowMedia('thumb', id, req, url);
      if (!ok.ok) return send(res, ok.status, { error: ok.error });
      const buf = await cache.getThumb(id);
      if (!buf) return send(res, 404, { error: 'no_thumbnail' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }

    if (p === '/api/videos') {
      const user = await requireUser(req, res, url); if (!user) return;
      let force = url.searchParams.get('refresh') === '1' && Date.now() - lastForcedRefresh > 30000;
      if (force) lastForcedRefresh = Date.now();
      const list = await getList(force);
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      let videos = list.videos;
      if (q) videos = videos.filter(v => `${v.caption || ''}\n${v.title || ''}\n${v.fileName || ''}`.toLowerCase().includes(q));
      return send(res, 200, { count: videos.length, listedAt: list.at, linkTtlSec: auth.signTtlSec, videos: videos.map(v => publicVideo(v, user.uid, req)) });
    }

    if ((m = /^\/api\/videos\/(\d+)$/.exec(p))) {
      const user = await requireUser(req, res, url); if (!user) return;
      const meta = await cache.getMeta(Number(m[1]));
      if (!meta) return send(res, 404, { error: 'not_found' });
      return send(res, 200, publicVideo(meta, user.uid, req));
    }

    if (p === '/api/sign') {
      const user = await requireUser(req, res, url); if (!user) return;
      const id = Number(url.searchParams.get('msgId'));
      if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: 'msgId_required' });
      const meta = await cache.getMeta(id);
      if (!meta) return send(res, 404, { error: 'not_found' });
      const s = signedUrl('stream', id, user.uid, req);
      return send(res, 200, { msgId: id, url: s.url, streamUrl: s.url, exp: s.exp, thumbUrl: meta.hasThumb ? signedUrl('thumb', id, user.uid, req).url : null });
    }

    if (p === '/api/stats') {
      if (!config.adminKey || req.headers['x-admin-key'] !== config.adminKey) return send(res, 403, { error: 'admin_only' });
      return send(res, 200, { cache: cache.info(), videos: cache.perVideo() });
    }

    return send(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      const status = err.status || 502;
      log.error(`${req.method} ${req.url.split('?')[0]} -> ${status}: ${err.errorMessage || err.message}`);
      if (!res.headersSent) send(res, status, { error: status === 502 ? 'telegram_error' : 'error', detail: err.errorMessage || err.message });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 65000;
  server.requestTimeout = 0; // long video responses
  server.headersTimeout = 70000;
  return server;
}

module.exports = { createApp };
