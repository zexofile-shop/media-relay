'use strict';
// Reads settings from .env (or real environment variables) once, with safe defaults.
const path = require('path');
try { require('dotenv').config({ quiet: true }); } catch (_) { /* dotenv optional */ }

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}
function str(name, def = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? def : String(v).trim();
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function loadConfig(overrides = {}) {
  const dataDir = path.resolve(str('DATA_DIR', './data'));
  const cfg = {
    port: num('PORT', 8080),
    host: str('HOST', '0.0.0.0'),
    publicBaseUrl: str('PUBLIC_BASE_URL', '').replace(/\/+$/, ''),
    trustProxy: bool('TRUST_PROXY', true),
    logLevel: str('LOG_LEVEL', 'info'),

    // where videos come from: "telegram" (real) or "mock" (local mp4 folder, for testing)
    source: str('SOURCE', 'telegram'),
    mockVideoDir: path.resolve(str('MOCK_VIDEO_DIR', './sample_videos')),

    // Telegram
    apiId: num('TG_API_ID', num('API_ID', 0)),
    apiHash: str('TG_API_HASH', str('API_HASH')),
    botToken: str('BOT_TOKEN'),
    tgSession: str('TG_SESSION'),
    sessionFile: path.resolve(str('SESSION_FILE', path.join(dataDir, 'session.txt'))),
    channelId: str('CHANNEL_ID'),
    channelTitle: str('CHANNEL_TITLE'),
    tgConcurrency: num('TG_CONCURRENCY', 3),
    tgPartSize: num('TG_PART_SIZE', 512 * 1024),
    maxFloodWaitSec: num('MAX_FLOOD_WAIT_SEC', 300),
    listTtlSec: num('LIST_TTL_SEC', 300),
    botScanEmptyBatches: num('BOT_SCAN_EMPTY_BATCHES', 3),
    botScanMaxId: num('BOT_SCAN_MAX_ID', 20000),

    // cache
    dataDir,
    cacheDir: path.resolve(str('CACHE_DIR', '/tmp/cache')),
    cacheMaxGb: num('CACHE_MAX_GB', 1),
    readAhead: num('READ_AHEAD_CHUNKS', 3),

    // security
    authMode: str('AUTH_MODE', 'firebase'), // firebase | off (off = ONLY for local testing)
    firebaseProjectId: str('FIREBASE_PROJECT_ID'),
    signSecret: str('SIGNING_SECRET', str('SIGN_SECRET')),
    signTtlSec: num('SIGN_TTL_SEC', 6 * 3600),
    adminKey: str('ADMIN_KEY'),
    corsOrigin: str('CORS_ORIGIN', ''),
    rateLimitPerMin: num('RATE_LIMIT_PER_MIN', 600),
  };
  return Object.assign(cfg, overrides);
}

module.exports = { loadConfig };
