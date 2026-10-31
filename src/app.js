'use strict';
// HTTP layer: /health, /api/videos, /api/sign, /stream/:msgId (Range), /thumb/:msgId, /api/stats
const http = require('http');
const { parseRange } = require('./range');
const { Auth, RateLimiter } = require('./auth');
const { CHUNK_SIZE } = require('./chunkCache');

function createApp({ config, source, cache, auth, log }) {
  const limiter = new RateLimiter(config.rateLimitPerMin);
  const started = Date.now();
  let listCache = null; // { at, videos }
  let listInflight = null;
  let lastForcedRefresh = 0;
  source.onNewPost = () => { listCache = null; }; // new upload in the channel -> refresh list next time

  const base = config.publicBaseUrl || '';
  const signedUrl = (kind, id, uid) => {
    const s = auth.sign(kind, id, uid);
    return { url: `${base}/${kind}/${id}?exp=${s.exp}&u=${encodeURIComponent(s.u)}&sig=${s.sig}`, exp: s.exp };
  };
  const publicVideo = (m, uid) => ({
    msgId: m.msgId, title: m.title, caption: m.caption, fileName: m.fileName,
    duration: m.duration, width: m.width, height: m.height, size: m.size, mime: m.mime, date: m.date,
    thumbUrl: m.hasThumb ? signedUrl('thumb', m.msgId, uid).url : null,
    streamUrl: signedUrl('stream', m.msgId, uid).url,
    streamUrlExpires: Math.floor(Date.now() / 1000) + auth.signTtlSec,
  });

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
    const user = await auth.verifyUser(Auth.tokenFrom(req, url));
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
    if (config.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range');
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
      return send(res, 200, { count: list.videos.length, listedAt: list.at, videos: list.videos.map(v => publicVideo(v, user.uid)) });
    }

    if ((m = /^\/api\/videos\/(\d+)$/.exec(p))) {
      const user = await requireUser(req, res, url); if (!user) return;
      const meta = await cache.getMeta(Number(m[1]));
      if (!meta) return send(res, 404, { error: 'not_found' });
      return send(res, 200, publicVideo(meta, user.uid));
    }

    if (p === '/api/sign') {
      const user = await requireUser(req, res, url); if (!user) return;
      const id = Number(url.searchParams.get('msgId'));
      if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: 'msgId_required' });
      const meta = await cache.getMeta(id);
      if (!meta) return send(res, 404, { error: 'not_found' });
      const s = signedUrl('stream', id, user.uid);
      return send(res, 200, { msgId: id, url: s.url, exp: s.exp, thumbUrl: meta.hasThumb ? signedUrl('thumb', id, user.uid).url : null });
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
