'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, get } = require('./helpers');
const { Auth } = require('../src/auth');

const KEY = 'app-key-for-tests-0123456789abcdef';

test('APP_KEY access for the app (no user login)', async t => {
  const s = await startServer({ rateLimitPerMin: 0, appKey: KEY });
  t.after(() => s.close());

  await t.test('no key / wrong key -> 401 on list, item, sign', async () => {
    for (const p of ['/api/videos', '/api/videos/1', '/api/sign?msgId=1']) {
      assert.equal((await get(s.port, p)).status, 401, p);
      assert.equal((await get(s.port, p, { 'X-App-Key': 'wrong' })).status, 401, p + ' wrong key');
      assert.equal((await get(s.port, p + (p.includes('?') ? '&' : '?') + 'k=wrong')).status, 401, p + ' wrong k');
    }
  });

  await t.test('X-App-Key header -> list with every field and absolute signed URLs', async () => {
    const r = await get(s.port, '/api/videos', { 'X-App-Key': KEY, 'X-Forwarded-Proto': 'https', Host: 'relay.example.com' });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.count, 2);
    assert.equal(j.videos.length, 2);
    const v = j.videos[0];
    for (const k of ['msgId', 'title', 'caption', 'duration', 'size', 'width', 'height', 'mime', 'date', 'hasThumb', 'streamUrl', 'thumbUrl'])
      assert.ok(k in v, `field ${k}`);
    assert.equal(v.msgId, 1);
    assert.equal(v.title, 'Sample lecture_01_sample.mp4', 'title = first caption line');
    assert.equal(v.hasThumb, true);
    assert.match(v.streamUrl, /^https:\/\/relay\.example\.com\/stream\/1\?exp=\d+&u=app&sig=/);
    assert.match(v.thumbUrl, /^https:\/\/relay\.example\.com\/thumb\/1\?exp=\d+&u=app&sig=/);
    const exp = Number(new URL(v.streamUrl).searchParams.get('exp'));
    assert.ok(Math.abs(exp - (Date.now() / 1000 + 6 * 3600)) < 30, 'valid ~6h');
    // the signed links play with no headers at all
    const st = await get(s.port, v.streamUrl, { Range: 'bytes=0-999' });
    assert.equal(st.status, 206);
    assert.equal(st.body.length, 1000);
    const th = await get(s.port, v.thumbUrl);
    assert.equal(th.status, 200);
    assert.equal(th.body[0], 0xff);
  });

  await t.test('?k= query works on the API', async () => {
    const r = await get(s.port, `/api/videos?k=${KEY}`);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).count, 2);
  });

  await t.test('?q= filters by caption text (case-insensitive)', async () => {
    const one = JSON.parse((await get(s.port, '/api/videos?q=LECTURE_02', { 'X-App-Key': KEY })).body);
    assert.equal(one.count, 1);
    assert.equal(one.videos[0].msgId, 2);
    const none = JSON.parse((await get(s.port, '/api/videos?q=zzz-no-match', { 'X-App-Key': KEY })).body);
    assert.equal(none.count, 0);
    assert.deepEqual(none.videos, []);
  });

  await t.test('/api/videos/:id and /api/sign with the key', async () => {
    const item = await get(s.port, '/api/videos/2', { 'X-App-Key': KEY });
    assert.equal(item.status, 200);
    const v = JSON.parse(item.body);
    assert.equal(v.msgId, 2);
    assert.match(v.streamUrl, /^http:\/\/127\.0\.0\.1:\d+\/stream\/2\?/);
    assert.equal((await get(s.port, v.streamUrl, { Range: 'bytes=0-9' })).status, 206);
    const sg = JSON.parse((await get(s.port, '/api/sign?msgId=1', { 'X-App-Key': KEY })).body);
    assert.match(sg.url, /u=app/);
    assert.equal((await get(s.port, sg.url, { Range: 'bytes=0-9' })).status, 206);
    assert.equal((await get(s.port, '/api/videos/999', { 'X-App-Key': KEY })).status, 404);
  });

  await t.test('bare /stream and /thumb stay closed; ?k= does not open media; header does', async () => {
    assert.equal((await get(s.port, '/stream/1', { Range: 'bytes=0-9' })).status, 401);
    assert.equal((await get(s.port, '/thumb/1')).status, 401);
    assert.equal((await get(s.port, `/stream/1?k=${KEY}`, { Range: 'bytes=0-9' })).status, 401);
    assert.equal((await get(s.port, '/stream/1', { 'X-App-Key': KEY, Range: 'bytes=0-9' })).status, 206);
  });

  await t.test('Firebase token still works alongside the key', async () => {
    const r = await get(s.port, '/api/videos', { Authorization: 'Bearer good-token' });
    assert.equal(r.status, 200);
    assert.match(JSON.parse(r.body).videos[0].streamUrl, /u=student1/);
  });
});

test('without APP_KEY configured, any key is refused', async t => {
  const s = await startServer({ rateLimitPerMin: 0 });
  t.after(() => s.close());
  assert.equal((await get(s.port, '/api/videos', { 'X-App-Key': '' })).status, 401);
  assert.equal((await get(s.port, '/api/videos', { 'X-App-Key': 'anything' })).status, 401);
  assert.equal((await get(s.port, '/api/videos?k=undefined')).status, 401);
});

test('PUBLIC_BASE_URL overrides the request host', async t => {
  const s = await startServer({ rateLimitPerMin: 0, appKey: KEY, publicBaseUrl: 'https://cdn.example.org' });
  t.after(() => s.close());
  const v = JSON.parse((await get(s.port, '/api/videos', { 'X-App-Key': KEY, Host: 'evil.example' })).body).videos[0];
  assert.match(v.streamUrl, /^https:\/\/cdn\.example\.org\/stream\/1\?/);
});

test('checkAppKey is exact', () => {
  const a = new Auth({ mode: 'off', signSecret: 'x'.repeat(40), appKey: KEY });
  assert.equal(a.checkAppKey(KEY), true);
  assert.equal(a.checkAppKey(KEY + 'x'), false);
  assert.equal(a.checkAppKey(KEY.slice(0, -1)), false);
  assert.equal(a.checkAppKey(''), false);
  assert.equal(a.checkAppKey(null), false);
  const b = new Auth({ mode: 'off', signSecret: 'x'.repeat(40) });
  assert.equal(b.checkAppKey(KEY), false);
});
