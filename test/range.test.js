'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { startServer, get, VIDEO } = require('./helpers');
const { parseRange } = require('../src/range');

const AUTH = { Authorization: 'Bearer good-token' };
const file = fs.readFileSync(VIDEO);
const SIZE = file.length;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

test('parseRange unit cases', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=95-500', 100), { start: 95, end: 99 });
  assert.deepEqual(parseRange('bytes=0-9,20-29', 100), { start: 0, end: 9 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=50-10', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
  assert.equal(parseRange('items=0-1', 100), null);
});

test('HTTP range requests', async t => {
  const s = await startServer();
  t.after(() => s.close());

  await t.test('no Range -> 200 full file, identical bytes', async () => {
    const r = await get(s.port, '/stream/1', AUTH);
    assert.equal(r.status, 200);
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.headers['content-type'], 'video/mp4');
    assert.equal(Number(r.headers['content-length']), SIZE);
    assert.equal(sha(r.body), sha(file));
  });

  await t.test('start: bytes=0-99', async () => {
    const r = await get(s.port, '/stream/1', { ...AUTH, Range: 'bytes=0-99' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], `bytes 0-99/${SIZE}`);
    assert.equal(Number(r.headers['content-length']), 100);
    assert.deepEqual(r.body, file.subarray(0, 100));
  });

  await t.test('middle, crossing 1 MB chunk borders', async () => {
    const a = 1048000, b = 3 * 1048576 + 123;
    const r = await get(s.port, '/stream/1', { ...AUTH, Range: `bytes=${a}-${b}` });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], `bytes ${a}-${b}/${SIZE}`);
    assert.equal(r.body.length, b - a + 1);
    assert.ok(r.body.equals(file.subarray(a, b + 1)));
  });

  await t.test('end: suffix bytes=-500 and clamped end', async () => {
    let r = await get(s.port, '/stream/1', { ...AUTH, Range: 'bytes=-500' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], `bytes ${SIZE - 500}-${SIZE - 1}/${SIZE}`);
    assert.ok(r.body.equals(file.subarray(SIZE - 500)));
    r = await get(s.port, '/stream/1', { ...AUTH, Range: `bytes=${SIZE - 10}-${SIZE + 1000}` });
    assert.equal(r.status, 206);
    assert.equal(r.body.length, 10);
    assert.ok(r.body.equals(file.subarray(SIZE - 10)));
  });

  await t.test('open-ended bytes=5000000- (what ExoPlayer sends after a seek)', async () => {
    const r = await get(s.port, '/stream/1', { ...AUTH, Range: 'bytes=5000000-' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], `bytes 5000000-${SIZE - 1}/${SIZE}`);
    assert.equal(r.body.length, SIZE - 5000000);
    assert.ok(r.body.equals(file.subarray(5000000)));
  });

  await t.test('past the end -> 416 with bytes */size', async () => {
    const r = await get(s.port, '/stream/1', { ...AUTH, Range: `bytes=${SIZE}-` });
    assert.equal(r.status, 416);
    assert.equal(r.headers['content-range'], `bytes */${SIZE}`);
  });

  await t.test('HEAD gives length + ranges, no body', async () => {
    const r = await get(s.port, '/stream/1', AUTH, 'HEAD');
    assert.equal(r.status, 200);
    assert.equal(Number(r.headers['content-length']), SIZE);
    assert.equal(r.body.length, 0);
  });

  await t.test('unknown video -> 404', async () => {
    const r = await get(s.port, '/stream/999', AUTH);
    assert.equal(r.status, 404);
  });

  await t.test('only the chunks a range needs are fetched from the source', async () => {
    const s2 = await startServer();
    try {
      const r = await get(s2.port, '/stream/1', { ...AUTH, Range: `bytes=${10 * 1048576 + 5}-${11 * 1048576 + 10}` });
      assert.equal(r.status, 206);
      assert.deepEqual([...s2.source.chunkCalls.keys()].sort(), ['1:10', '1:11']);
    } finally { await s2.close(); }
  });

  await t.test('client hanging up mid-stream does not crash the server', async () => {
    await new Promise(resolve => {
      const req = require('http').get({ host: '127.0.0.1', port: s.port, path: '/stream/1', headers: AUTH, agent: false }, res => {
        res.once('data', () => { req.destroy(); setTimeout(resolve, 200); });
      });
      req.on('error', () => {});
    });
    const r = await get(s.port, '/health');
    assert.equal(r.status, 200);
  });
});
