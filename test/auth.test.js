'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, get } = require('./helpers');

test('auth and signed URLs', async t => {
  const s = await startServer({ rateLimitPerMin: 0 });
  t.after(() => s.close());

  await t.test('/health is open', async () => {
    const r = await get(s.port, '/health');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).ok, true);
  });
  await t.test('no token -> 401 on stream, list, sign, thumb', async () => {
    for (const p of ['/stream/1', '/api/videos', '/api/sign?msgId=1', '/thumb/1']) {
      const r = await get(s.port, p);
      assert.equal(r.status, 401, p);
    }
  });
  await t.test('bad token -> 401', async () => {
    assert.equal((await get(s.port, '/stream/1', { Authorization: 'Bearer nope' })).status, 401);
    assert.equal((await get(s.port, '/stream/1?token=nope')).status, 401);
  });
  await t.test('good Firebase token (header or ?token=) -> allowed', async () => {
    assert.equal((await get(s.port, '/stream/1', { Authorization: 'Bearer good-token', Range: 'bytes=0-9' })).status, 206);
    assert.equal((await get(s.port, '/stream/1?token=good-token', { Range: 'bytes=0-9' })).status, 206);
  });
  await t.test('/api/videos lists videos with signed stream + thumb URLs', async () => {
    const r = await get(s.port, '/api/videos', { Authorization: 'Bearer good-token' });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.count, 2);
    const v = j.videos[0];
    assert.equal(v.msgId, 1);
    assert.equal(v.mime, 'video/mp4');
    assert.equal(v.duration, 60);
    assert.ok(v.size > 19e6);
    assert.match(v.streamUrl, /^http:\/\/127\.0\.0\.1:\d+\/stream\/1\?exp=\d+&u=student1&sig=/);
    assert.match(v.thumbUrl, /^http:\/\/127\.0\.0\.1:\d+\/thumb\/1\?exp=/);
    const th = await get(s.port, v.thumbUrl);
    assert.equal(th.status, 200);
    assert.equal(th.headers['content-type'], 'image/jpeg');
    assert.equal(th.body[0], 0xff); // JPEG magic
    const st = await get(s.port, v.streamUrl, { Range: 'bytes=0-9' });
    assert.equal(st.status, 206, 'signed URL works with no headers');
  });
  await t.test('/api/sign -> URL valid without headers', async () => {
    const r = await get(s.port, '/api/sign?msgId=1', { Authorization: 'Bearer good-token' });
    const j = JSON.parse(r.body);
    assert.ok(j.exp - Date.now() / 1000 > 6 * 3600 - 10);
    assert.equal((await get(s.port, j.url, { Range: 'bytes=0-9' })).status, 206);
  });
  await t.test('expired signed URL -> 403 link_expired', async () => {
    const sg = s.auth.sign('stream', 1, 'student1', 3600, Date.now() - 2 * 3600 * 1000);
    const r = await get(s.port, `/stream/1?exp=${sg.exp}&u=${sg.u}&sig=${sg.sig}`);
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.body).error, 'link_expired');
  });
  await t.test('tampered signature, changed exp, or another video id -> 403', async () => {
    const sg = s.auth.sign('stream', 1, 'student1');
    assert.equal((await get(s.port, `/stream/1?exp=${sg.exp}&u=${sg.u}&sig=${sg.sig.slice(0, -2)}xx`)).status, 403);
    assert.equal((await get(s.port, `/stream/1?exp=${sg.exp + 999999}&u=${sg.u}&sig=${sg.sig}`)).status, 403);
    assert.equal((await get(s.port, `/stream/2?exp=${sg.exp}&u=${sg.u}&sig=${sg.sig}`)).status, 403);
    assert.equal((await get(s.port, `/thumb/1?exp=${sg.exp}&u=${sg.u}&sig=${sg.sig}`)).status, 403, 'stream signature cannot open thumb');
  });
  await t.test('admin stats need ADMIN key', async () => {
    assert.equal((await get(s.port, '/api/stats')).status, 403);
    assert.equal((await get(s.port, '/api/stats', { 'X-Admin-Key': 'adm' })).status, 200);
  });
  await t.test('CORS is off by default', async () => {
    const r = await get(s.port, '/health', { Origin: 'https://evil.example' });
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });
});

test('per-IP rate limit -> 429', async t => {
  const s = await startServer({ rateLimitPerMin: 5 });
  t.after(() => s.close());
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await get(s.port, '/api/videos', { Authorization: 'Bearer good-token', 'X-Forwarded-For': '9.9.9.9' })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  const other = await get(s.port, '/api/videos', { Authorization: 'Bearer good-token', 'X-Forwarded-For': '8.8.8.8' });
  assert.equal(other.status, 200, 'another IP is not blocked');
});

test('real firebase-admin verifier rejects junk and forged tokens (wiring check)', async () => {
  const { Auth } = require('../src/auth');
  const a = new Auth({ mode: 'firebase', projectId: 'demo-project-123', signSecret: 'x'.repeat(40) });
  assert.equal(await a.verifyUser('not-a-jwt'), null);
  // a JWT signed with a random key, claiming to be from the project
  const crypto = require('crypto');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'fake', typ: 'JWT' });
  const body = b64({ iss: 'https://securetoken.google.com/demo-project-123', aud: 'demo-project-123', sub: 'x', iat: now, exp: now + 3600, auth_time: now });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  assert.equal(await a.verifyUser(`${head}.${body}.${sig}`), null);
});
