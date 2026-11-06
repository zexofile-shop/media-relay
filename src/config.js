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
    appKey: str('APP_KEY'),
    adminKey: str('ADMIN_KEY'),
    corsOrigin: str('CORS_ORIGIN', ''),
    rateLimitPerMin: num('RATE_LIMIT_PER_MIN', 600),

    // push notifications (POST /api/push)
    fcmServiceAccount: str('FCM_SERVICE_ACCOUNT'), // service-account JSON, or base64 of it; unset = push disabled
    ownerEmail: str('OWNER_EMAIL'),
    adminOrigins: str('ADMIN_ORIGINS'), // comma list of origins allowed to call /api/push from a browser
    pushChannelId: str('PUSH_CHANNEL_ID'),
    pushRatePerMin: num('PUSH_RATE_PER_MIN', 20),
    // member room pushes (POST /api/room-push); all optional, generic defaults
    roomPushConfigDoc: str('ROOM_PUSH_CONFIG_DOC', 'app_config/community'),
    roomPushSwitch: str('ROOM_PUSH_SWITCH', 'chatPushEnabled'),
    roomPushMsgPath: str('ROOM_PUSH_MSG_PATH', 'batches/{room}/chat/{msg}'),
    roomPushRoomDoc: str('ROOM_PUSH_ROOM_DOC', 'batches/{room}'),
    roomPushTitleField: str('ROOM_PUSH_TITLE_FIELD', 'title'),
    roomPushTopicPrefix: str('ROOM_PUSH_TOPIC_PREFIX', 'chat_'),
    roomPushRatePerMin: num('ROOM_PUSH_RATE_PER_MIN', 6),
    // v5.18 hybrid: chat messages on Supabase (public URL + public anon/publishable key; no secret key here)
    supabaseUrl: str('SUPABASE_URL', ''),
    supabaseKey: str('SUPABASE_PUBLIC_KEY', ''),

    // admin image uploads (POST /api/img) -> imgbb; the key lives only here (env), never in the panel
    imgbbKey: str('IMGBB_KEY'),
    imgbbMaxBytes: num('IMGBB_MAX_BYTES', 10 * 1024 * 1024),
    imgbbRatePerMin: num('IMGBB_RATE_PER_MIN', 30),

    // admin uploads (/api/upload): files go into GitHub release assets
    uploadToken: str('GITHUB_UPLOAD_TOKEN'),          // fine-grained token: Contents (and Actions) read/write on UPLOAD_REPO only
    uploadRepo: str('UPLOAD_REPO'),                   // owner/name
    uploadReleasePdf: str('UPLOAD_RELEASE_PDF'),      // release tag for PDFs (created if missing)
    uploadReleaseVideo: str('UPLOAD_RELEASE_VIDEO'),  // release tag for videos (created if missing)
    uploadQualityWorkflow: str('UPLOAD_QUALITY_WORKFLOW'), // workflow file in UPLOAD_REPO that makes 720p/480p/360p copies
    uploadHlsWorkflow: str('UPLOAD_HLS_WORKFLOW', 'lecture-hls.yml'), // videos become locked HLS (720/480/360p) on R2 via this workflow ('off' = old MP4 copies)
    uploadHlsBase: str('UPLOAD_HLS_BASE', 'https://pub-10df8dcbea28417faa1136efd9fa3c26.r2.dev'), // public base of the lectures bucket
    uploadWorkflowRef: str('UPLOAD_WORKFLOW_REF', 'main'),
    uploadReleaseParts: str('UPLOAD_RELEASE_PARTS', 'upload-parts'), // temporary part assets of big uploads (joined by the workflow)
  };
  return Object.assign(cfg, overrides);
}

module.exports = { loadConfig };
