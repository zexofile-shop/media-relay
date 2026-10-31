'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startServer, request, get } = require('./helpers');
const { PushService, GoogleTokenSource, parseServiceAccount, validatePush, buildFcmMessage, SCOPES } = require('../src/push');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SA = { type: 'service_account', project_id: 'demo-proj', client_email: 'pusher@demo-proj.iam.gserviceaccount.com', private_key: PEM, token_uri: 'https://oauth2.googleapis.com/token' };
const SA_JSON = JSON.stringify(SA);

/** A fake network: Google token endpoint, Firestore admins/{email}, FCM send. Records every call. */
function fakeNet({ admins = [], fcmStatus = 200, firestoreStatus } = {}) {
  const calls = { token: [], firestore: [], fcm: [] };
  let n = 0;
  const fetchImpl = async (url, opts = {}) => {
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (url === 'https://oauth2.googleapis.com/token') {
      calls.token.push({ url, opts });
      return reply(200, { access_token: `tok-${++n}`, expires_in: 3599, token_type: 'Bearer' });
    }
    if (url.startsWith('https://firestore.googleapis.com/')) {
      calls.firestore.push({ url, opts });
      if (firestoreStatus) return reply(firestoreStatus, {});
      const email = decodeURIComponent(url.split('/admins/')[1]);
      return admins.includes(email) ? reply(200, { name: 'x', fields: {} }) : reply(404, { error: { status: 'NOT_FOUND' } });
    }
    if (url.startsWith('https://fcm.googleapis.com/')) {
      calls.fcm.push({ url, opts, body: JSON.parse(opts.body) });
      if (fcmStatus !== 200) return reply(fcmStatus, { error: { status: 'INVALID_ARGUMENT', message: 'bad' } });
      return reply(200, { name: 'projects/demo-proj/messages/123456' });
    }
    throw new Error('unexpected url ' + url);
  };
  return { fetchImpl, calls };
}

function makePush(net, extra = {}) {
  return new PushService({ serviceAccount: SA_JSON, ownerEmail: 'owner@x.com', channelId: 'chan_test_v1', ratePerMin: 20, fetchImpl: net.fetchImpl, ...extra });
}

const GOOD = { title: 'New lecture', body: 'Real Numbers is live', topic: 'all', data: { open: 'lectures' } };
const auth = t => ({ Authorization: `Bearer ${t}` });

test('push: no token -> 401, garbage token -> 401, nothing sent', async () => {
  const net = fakeNet();
  const s = await startServer({ push: makePush(net) });
  try {
    let r = await request(s.port, '/api/push', { method: 'POST', body: GOOD });
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(r.json, { ok: false, error: 'login_required' });
    r = await request(s.port, '/api/push', { method: 'POST', body: GOOD, headers: auth('garbage') });
    assert.strictEqual(r.status, 401);
    r = await request(s.port, '/api/push', { method: 'POST', body: GOOD, headers: { 'X-App-Key': 'whatever' } });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(net.calls.fcm.length, 0);
    assert.strictEqual(net.calls.token.length, 0);
  } finally { await s.close(); }
});

test('push: GET on /api/push -> 405', async () => {
  const s = await startServer({ push: makePush(fakeNet()) });
  try {
    const r = await request(s.port, '/api/push', { headers: auth('owner-token') });
    assert.strictEqual(r.status, 405);
  } finally { await s.close(); }
});

test('push: missing config -> 503 push_not_configured, server keeps serving', async () => {
  const push = new PushService({ serviceAccount: '', ownerEmail: 'owner@x.com' });
  assert.strictEqual(push.configured, false);
  const s = await startServer({ push });
  try {
    const r = await request(s.port, '/api/push', { method: 'POST', body: GOOD, headers: auth('owner-token') });
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(r.json, { ok: false, error: 'push_not_configured' });
    const h = await get(s.port, '/health');
    assert.strictEqual(h.status, 200);
  } finally { await s.close(); }
});

test('push: unparsable service account counts as not configured', async () => {
  assert.strictEqual(parseServiceAccount('not json at all'), null);
  assert.strictEqual(parseServiceAccount('{"project_id":"x"}'), null);
  assert.strictEqual(new PushService({ serviceAccount: '{broken' }).configured, false);
});

test('push: service account as raw JSON or base64', () => {
  const a = parseServiceAccount(SA_JSON);
  const b = parseServiceAccount(Buffer.from(SA_JSON).toString('base64'));
  assert.strictEqual(a.projectId, 'demo-proj');
  assert.deepStrictEqual(a, b);
  const escaped = parseServiceAccount(JSON.stringify({ ...SA, private_key: PEM.replace(/\n/g, '\\n') }));
  assert.strictEqual(escaped.privateKey, PEM);
});

test('push: owner email (case-insensitive) is admin without a Firestore read; FCM message shape', async () => {
  const net = fakeNet();
  const s = await startServer({ push: makePush(net) });
  try {
    const r = await request(s.port, '/api/push', { method: 'POST', body: { ...GOOD, topic: 'class_10', image: 'https://img.example/a.png' }, headers: auth('owner-token') });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: true, messageId: 'projects/demo-proj/messages/123456' });
    assert.strictEqual(net.calls.firestore.length, 0);
    assert.strictEqual(net.calls.fcm.length, 1);
    const call = net.calls.fcm[0];
    assert.strictEqual(call.url, 'https://fcm.googleapis.com/v1/projects/demo-proj/messages:send');
    assert.strictEqual(call.opts.headers.Authorization, 'Bearer tok-1');
    const m = call.body.message;
    assert.strictEqual(m.topic, 'class_10');
    assert.deepStrictEqual(m.notification, { title: 'New lecture', body: 'Real Numbers is live', image: 'https://img.example/a.png' });
    assert.strictEqual(m.android.priority, 'HIGH');
    assert.strictEqual(m.android.notification.channel_id, 'chan_test_v1');
    assert.deepStrictEqual(m.data, { open: 'lectures' });
  } finally { await s.close(); }
});

test('push: admin check reads admins/{email} in Firestore', async () => {
  const net = fakeNet({ admins: ['s@x.com'] });
  const s = await startServer({ push: makePush(net) });
  try {
    const r = await request(s.port, '/api/push', { method: 'POST', body: GOOD, headers: auth('good-token') });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(net.calls.firestore.length, 1);
    assert.strictEqual(net.calls.firestore[0].url, 'https://firestore.googleapis.com/v1/projects/demo-proj/databases/(default)/documents/admins/s%40x.com');
    assert.match(net.calls.firestore[0].opts.headers.Authorization, /^Bearer tok-/);
  } finally { await s.close(); }
});

test('push: signed-in non-admin -> 403 not_admin; unverified email -> 403; Firestore error -> 502', async () => {
  const net = fakeNet({ admins: [] });
  const s = await startServer({ push: makePush(net) });
  try {
    let r = await request(s.port, '/api/push', { method: 'POST', body: GOOD, headers: auth('good-token') });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.json, { ok: false, error: 'not_admin' });
    r = await request(s.port, '/api/push', { method: 'POST', body: GOOD, headers: auth('unverified-token') });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(net.calls.fcm.length, 0);
  } finally { await s.close(); }
  const net2 = fakeNet({ firestoreStatus: 500 });
  const s2 = await startServer({ push: makePush(net2) });
  try {
    const r = await request(s2.port, '/api/push', { method: 'POST', body: GOOD, headers: auth('good-token') });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.error, 'admin_check_failed');
  } finally { await s2.close(); }
});

test('push: validation rejects bad bodies with 400', async () => {
  const net = fakeNet();
  const s = await startServer({ push: makePush(net) });
  const cases = [
    [{ ...GOOD, title: '' }, 'invalid_title'],
    [{ ...GOOD, title: 'x'.repeat(101) }, 'invalid_title'],
    [{ ...GOOD, body: 'y'.repeat(501) }, 'invalid_body_text'],
    [{ ...GOOD, topic: 'class_13' }, 'invalid_topic'],
    [{ ...GOOD, topic: 'class_0' }, 'invalid_topic'],
    [{ ...GOOD, topic: 'everyone' }, 'invalid_topic'],
    [{ ...GOOD, data: { open: 5 } }, 'invalid_data'],
    [{ ...GOOD, data: ['open'] }, 'invalid_data'],
    [{ ...GOOD, data: { from: 'x' } }, 'invalid_data'],
    [{ ...GOOD, image: 'http://insecure.example/a.png' }, 'invalid_image'],
    [{ ...GOOD, image: 'not a url' }, 'invalid_image'],
  ];
  try {
    for (const [body, error] of cases) {
      const r = await request(s.port, '/api/push', { method: 'POST', body, headers: auth('owner-token') });
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.deepStrictEqual(r.json, { ok: false, error });
    }
    const bad = await request(s.port, '/api/push', { method: 'POST', body: '{not json', headers: auth('owner-token') });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.error, 'invalid_json');
    const big = await request(s.port, '/api/push', { method: 'POST', body: { ...GOOD, pad: 'z'.repeat(20000) }, headers: auth('owner-token') });
    assert.strictEqual(big.status, 413);
    assert.strictEqual(net.calls.fcm.length, 0);
  } finally { await s.close(); }
  for (const t of ['all', 'class_1', 'class_9', 'class_12']) assert.strictEqual(validatePush({ ...GOOD, topic: t }).ok, true);
});

test('push: FCM failure -> {ok:false,error}', async () => {
  const net = fakeNet({ fcmStatus: 400 });
  const s = await startServer({ push: makePush(net) });
  try {
    const r = await request(s.port, '/api/push', { method: 'POST', body: GOOD, headers: auth('owner-token') });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.ok, false);
    assert.match(r.json.error, /^fcm_error: INVALID_ARGUMENT/);
  } finally { await s.close(); }
});

test('push: access token is a valid RS256 JWT grant, cached ~50 min, refreshed after', async () => {
  const net = fakeNet();
  let now = Date.parse('2026-10-31T12:00:00Z');
  const ts = new GoogleTokenSource({ sa: parseServiceAccount(SA_JSON), fetchImpl: net.fetchImpl, now: () => now });
  const [t1, t2] = await Promise.all([ts.getToken(), ts.getToken()]); // concurrent callers share one request
  assert.strictEqual(t1, 'tok-1');
  assert.strictEqual(t2, 'tok-1');
  now += 49 * 60 * 1000;
  assert.strictEqual(await ts.getToken(), 'tok-1');
  assert.strictEqual(net.calls.token.length, 1);
  now += 2 * 60 * 1000; // 51 min after minting
  assert.strictEqual(await ts.getToken(), 'tok-2');
  assert.strictEqual(net.calls.token.length, 2);

  const form = new URLSearchParams(net.calls.token[0].opts.body);
  assert.strictEqual(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, c, sig] = form.get('assertion').split('.');
  assert.deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.strictEqual(claims.iss, SA.client_email);
  assert.strictEqual(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.strictEqual(claims.exp - claims.iat, 3600);
  assert.deepStrictEqual(claims.scope.split(' ').sort(), [...SCOPES].sort());
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/firebase.messaging'));
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/datastore'));
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url')));
});

test('push: several sends reuse one token; admin lookups are cached briefly', async () => {
  const net = fakeNet({ admins: ['s@x.com'] });
  const s = await startServer({ push: makePush(net) });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await request(s.port, '/api/push', { method: 'POST', body: GOOD, headers: auth('good-token') });
      assert.strictEqual(r.status, 200);
    }
    assert.strictEqual(net.calls.token.length, 1);
    assert.strictEqual(net.calls.firestore.length, 1);
    assert.strictEqual(net.calls.fcm.length, 3);
  } finally { await s.close(); }
});

test('push: rate limit per uid -> 429 after 20 a minute', async () => {
  const net = fakeNet();
  const s = await startServer({ push: makePush(net) });
  try {
    for (let i = 0; i < 20; i++) {
      const r = await request(s.port, '/api/push', { method: 'POST', body: GOOD, headers: auth('owner-token') });
      assert.strictEqual(r.status, 200);
    }
    const r = await request(s.port, '/api/push', { method: 'POST', body: GOOD, headers: auth('owner-token') });
    assert.strictEqual(r.status, 429);
    assert.deepStrictEqual(r.json, { ok: false, error: 'too_many_requests' });
    assert.strictEqual(net.calls.fcm.length, 20);
  } finally { await s.close(); }
});

test('push: CORS only for ADMIN_ORIGINS', async () => {
  const s = await startServer({ push: makePush(fakeNet()), adminOrigins: 'https://admin.example, https://other.example/' });
  try {
    let r = await request(s.port, '/api/push', { method: 'OPTIONS', headers: { Origin: 'https://admin.example', 'Access-Control-Request-Method': 'POST' } });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers['access-control-allow-origin'], 'https://admin.example');
    assert.match(r.headers['access-control-allow-headers'], /Authorization/);
    assert.match(r.headers['access-control-allow-methods'], /POST/);
    r = await request(s.port, '/api/push', { method: 'OPTIONS', headers: { Origin: 'https://other.example' } });
    assert.strictEqual(r.headers['access-control-allow-origin'], 'https://other.example');
    r = await request(s.port, '/api/push', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
    r = await request(s.port, '/api/push', { method: 'POST', body: GOOD, headers: { Origin: 'https://admin.example' } });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.headers['access-control-allow-origin'], 'https://admin.example'); // browser can read the error
  } finally { await s.close(); }
});

test('push: other paths still refuse POST (405) and /api/videos still needs auth', async () => {
  const s = await startServer({ push: makePush(fakeNet()) });
  try {
    let r = await request(s.port, '/api/videos', { method: 'POST', body: {} });
    assert.strictEqual(r.status, 405);
    r = await request(s.port, '/api/videos');
    assert.strictEqual(r.status, 401);
  } finally { await s.close(); }
});

test('push: buildFcmMessage without channel/image/data stays minimal', () => {
  const m = buildFcmMessage({ title: 'a', body: 'b', topic: 'all' }, '');
  assert.deepStrictEqual(m, { topic: 'all', notification: { title: 'a', body: 'b' }, android: { priority: 'HIGH' } });
});
