'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { MockSource } = require('../src/sources/mockSource');
const { ChunkCache } = require('../src/chunkCache');
const { Auth } = require('../src/auth');
const { createApp } = require('../src/app');
const { createLogger } = require('../src/log');

const VIDEO_DIR = path.join(__dirname, '..', 'sample_videos');
const VIDEO = path.join(VIDEO_DIR, 'lecture_01_sample.mp4');
const SECRET = 'test-secret-test-secret-test-secret-0123456789';

function ensureSample() {
  if (!fs.existsSync(VIDEO)) throw new Error('Run `npm run make-sample` first (needs ffmpeg) to create sample_videos/lecture_01_sample.mp4');
}

async function startServer(opts = {}) {
  ensureSample();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgstream-'));
  const log = createLogger(process.env.TEST_LOG || 'silent');
  const source = opts.source || new MockSource({ dir: VIDEO_DIR, delayMs: opts.delayMs || 0 });
  const cache = new ChunkCache({ dir, maxBytes: opts.maxBytes || 10 * 1024 ** 3, source, log, readAhead: opts.readAhead ?? 0,
    concurrency: opts.concurrency || 3, sleep: opts.sleep });
  const auth = new Auth({ mode: opts.authMode || 'firebase', signSecret: SECRET, signTtlSec: opts.signTtlSec || 6 * 3600, log, appKey: opts.appKey,
    verifyIdToken: async t => {
      if (t === 'good-token') return { uid: 'student1', email: 's@x.com', exp: Date.now() / 1000 + 3600 };
      if (t === 'owner-token') return { uid: 'owner1', email: 'Owner@X.com', email_verified: true, exp: Date.now() / 1000 + 3600 };
      if (t === 'unverified-token') return { uid: 'u2', email: 'owner@x.com', email_verified: false, exp: Date.now() / 1000 + 3600 };
      throw new Error('auth/argument-error');
    } });
  const config = { publicBaseUrl: opts.publicBaseUrl || '', trustProxy: true, rateLimitPerMin: opts.rateLimitPerMin || 0, listTtlSec: 300, corsOrigin: '', adminKey: 'adm', adminOrigins: opts.adminOrigins || '' };
  const server = createApp({ config, source, cache, auth, log, push: opts.push, uploads: opts.uploads });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port, source, cache, auth, server, dir,
    async close() { await new Promise(r => server.close(r)); server.closeAllConnections?.(); cache.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function request(port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const hdrs = { ...headers };
    if (data !== null) { hdrs['Content-Type'] = hdrs['Content-Type'] || 'application/json'; hdrs['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: hdrs, agent: false }, res => {
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(bufs);
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

function get(port, p, headers = {}, method = 'GET') {
  if (/^https?:\/\//.test(p)) { const u = new URL(p); p = u.pathname + u.search; }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, res => {
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { startServer, get, request, VIDEO, VIDEO_DIR, SECRET };
