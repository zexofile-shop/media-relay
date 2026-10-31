'use strict';
// media-relay: streams videos from a Telegram channel over HTTP with Range support and a chunk cache.
// Start: `node server.js` (settings come from environment variables or a local .env file)
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('./src/config');
const { createLogger } = require('./src/log');
const { ChunkCache } = require('./src/chunkCache');
const { Auth } = require('./src/auth');
const { createApp } = require('./src/app');

// Placeholder used until Telegram is configured / connected: the server still boots and /health reports why.
class PendingSource {
  constructor(state) { this.state = state; }
  get mode() { return 'telegram'; }
  get connected() { return false; }
  get status() { return this.state; }
  _fail() { const e = new Error(`telegram ${this.state}`); e.status = 503; e.notReady = true; throw e; }
  async list() { this._fail(); }
  async getMeta() { this._fail(); }
  async getChunk() { this._fail(); }
  async getThumb() { this._fail(); }
}

// Forwards to the real source once it is up; until then to a PendingSource.
function makeSwitchingSource(initial) {
  const holder = { current: initial };
  const proxy = new Proxy({}, {
    get(_, prop) {
      if (prop === '__setTarget') return t => { holder.current = t; };
      if (prop === 'onNewPost') return holder.onNewPost;
      const v = holder.current[prop];
      return typeof v === 'function' ? v.bind(holder.current) : v;
    },
    set(_, prop, value) {
      if (prop === 'onNewPost') { holder.onNewPost = value; if (holder.current) holder.current.onNewPost = value; return true; }
      holder.current[prop] = value; return true;
    },
  });
  return { proxy, setTarget: t => { t.onNewPost = holder.onNewPost; holder.current = t; } };
}

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  if (!config.signSecret || config.signSecret.length < 32) {
    config.signSecret = crypto.randomBytes(32).toString('hex');
    log.warn('SIGNING_SECRET is missing or shorter than 32 characters: using a random one for this run (signed links break on restart). Set SIGNING_SECRET.');
  }
  if (config.authMode === 'firebase' && !config.firebaseProjectId) log.warn('FIREBASE_PROJECT_ID is not set: user tokens cannot be verified.');
  const auth = new Auth({ mode: config.authMode, projectId: config.firebaseProjectId, signSecret: config.signSecret, signTtlSec: config.signTtlSec, log });

  let source; let switcher = null;
  if (config.source === 'mock') {
    const { MockSource } = require('./src/sources/mockSource');
    source = new MockSource({ dir: config.mockVideoDir, log });
    await source.start();
  } else if (!config.tgSession && !config.botToken) {
    log.warn('telegram: not configured (TG_SESSION is empty). The server runs; set TG_SESSION and restart.');
    source = new PendingSource('not configured');
  } else {
    switcher = makeSwitchingSource(new PendingSource('connecting'));
    source = switcher.proxy;
  }

  const cache = new ChunkCache({
    dir: config.cacheDir, maxBytes: config.cacheMaxGb * 1024 ** 3, source, log,
    readAhead: config.readAhead, concurrency: config.tgConcurrency, maxFloodWaitSec: config.maxFloodWaitSec,
  });
  if (config.authMode === 'off') log.warn('AUTH_MODE=off: anyone can watch. Use this ONLY for local testing.');

  const server = createApp({ config, source, cache, auth, log });
  server.listen(config.port, config.host, () => log.info(`media-relay listening on http://${config.host}:${config.port}`));

  if (switcher) {
    // Connect in the background, retrying, so a bad network or session never stops the HTTP server.
    const { TelegramSource } = require('./src/sources/telegramSource');
    let attempt = 0;
    const connect = async () => {
      attempt++;
      const slow = setTimeout(() => { if (!source.connected) switcher.setTarget(new PendingSource('connecting (slow: check TG_SESSION, TG_API_ID, TG_API_HASH)')); }, 60000);
      slow.unref();
      try {
        const tg = new TelegramSource({
          apiId: config.apiId, apiHash: config.apiHash, botToken: config.botToken,
          session: config.tgSession, sessionFile: config.botToken ? path.join(config.dataDir, 'bot_session.txt') : null,
          channelId: config.channelId, channelTitle: config.channelTitle, partSize: config.tgPartSize, log,
          scanEmptyBatches: config.botScanEmptyBatches, scanMaxId: config.botScanMaxId,
        });
        await tg.start();
        clearTimeout(slow);
        switcher.setTarget(tg);
        log.info('telegram: connected');
      } catch (err) {
        clearTimeout(slow);
        const msg = String((err && err.message) || err).slice(0, 200);
        switcher.setTarget(new PendingSource(`error: ${msg}`));
        const wait = Math.min(300, 15 * attempt);
        log.error(`telegram: start failed (${msg}); retrying in ${wait}s`);
        setTimeout(connect, wait * 1000).unref();
      }
    };
    connect();
  }

  const shutdown = async sig => {
    log.info(`${sig}: shutting down`);
    server.close();
    try { await source.stop?.(); } catch (_) {}
    cache.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', err => log.error('unhandled:', err && (err.message || err)));
}

main().catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
