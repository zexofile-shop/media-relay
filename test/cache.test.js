'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, get } = require('./helpers');
const AUTH = { Authorization: 'Bearer good-token' };
const MB = 1048576;

test('cache miss then hit (no second Telegram fetch), hits counted in SQLite', async t => {
  const s = await startServer();
  t.after(() => s.close());
  const range = { ...AUTH, Range: `bytes=0-${3 * MB - 1}` };
  let r = await get(s.port, '/stream/1', range);
  assert.equal(r.status, 206);
  assert.equal(s.source.calls.getChunk, 3, 'first play fetches chunks 0,1,2');
  const firstBody = r.body;
  r = await get(s.port, '/stream/1', range);
  assert.equal(s.source.calls.getChunk, 3, 'second play served from disk cache');
  assert.ok(r.body.equals(firstBody));
  const info = s.cache.info();
  assert.equal(info.chunks, 3);
  assert.equal(info.misses, 3);
  assert.equal(info.hits, 3);
  const row = s.cache.db.prepare('SELECT hits, size FROM chunks WHERE msg_id=1 AND idx=0').get();
  assert.equal(row.hits, 1);
  assert.equal(row.size, MB);
  assert.ok(fs.existsSync(path.join(s.dir, 'chunks', '1', '0.bin')));
});

test('cache survives a restart (index + files on disk)', async () => {
  const { ChunkCache } = require('../src/chunkCache');
  const { MockSource } = require('../src/sources/mockSource');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgstream-restart-'));
  const src = new MockSource({ dir: path.join(__dirname, '..', 'sample_videos') });
  const meta = await src.getMeta(1);
  let c = new ChunkCache({ dir, maxBytes: 1e9, source: src, readAhead: 0 });
  await c.getChunk(1, 4, meta);
  c.close();
  c = new ChunkCache({ dir, maxBytes: 1e9, source: src, readAhead: 0 });
  assert.equal(c.totalBytes, MB);
  await c.getChunk(1, 4, meta);
  assert.equal(src.calls.getChunk, 1);
  c.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LRU eviction keeps the cache under CACHE_MAX', async t => {
  const s = await startServer({ maxBytes: 3 * MB });
  t.after(() => s.close());
  const r = await get(s.port, '/stream/1', { ...AUTH, Range: `bytes=0-${6 * MB - 1}` });
  assert.equal(r.status, 206);
  const info = s.cache.info();
  assert.ok(info.bytes <= 3 * MB, `cache bytes ${info.bytes} must be <= ${3 * MB}`);
  assert.ok(info.evicted >= 3, `evicted ${info.evicted}`);
  // the oldest chunks went first, the newest stayed
  assert.equal(s.cache.has(1, 0), false);
  assert.equal(s.cache.has(1, 5), true);
  assert.equal(fs.existsSync(path.join(s.dir, 'chunks', '1', '0.bin')), false, 'evicted chunk file deleted');
  // touching a chunk makes it "recent": play chunk 3 again, then add 2 new chunks; 3 must survive, 4 goes
  await get(s.port, '/stream/1', { ...AUTH, Range: `bytes=${3 * MB}-${3 * MB + 10}` });
  await get(s.port, '/stream/1', { ...AUTH, Range: `bytes=${8 * MB}-${10 * MB - 1}` });
  assert.equal(s.cache.has(1, 3), true, 'recently used chunk kept');
  assert.equal(s.cache.has(1, 4), false, 'least recently used chunk evicted');
  assert.ok(s.cache.info().bytes <= 3 * MB);
});

test('concurrent requests for the same chunk -> ONE source fetch', async t => {
  const s = await startServer({ delayMs: 300 });
  t.after(() => s.close());
  const reqs = Array.from({ length: 10 }, () => get(s.port, '/stream/1', { ...AUTH, Range: 'bytes=2097152-2097251' }));
  const res = await Promise.all(reqs);
  for (const r of res) { assert.equal(r.status, 206); assert.equal(r.body.length, 100); }
  assert.equal(s.source.chunkCalls.get('1:2'), 1, 'chunk 2 fetched once');
  assert.equal(s.source.calls.getChunk, 1);
  assert.equal(s.cache.info().dedupedWaits, 9);
});

test('read-ahead warms the next chunks', async t => {
  const s = await startServer({ readAhead: 3 });
  t.after(() => s.close());
  await get(s.port, '/stream/1', { ...AUTH, Range: 'bytes=0-1000' });
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual([0, 1, 2, 3].map(i => s.cache.has(1, i)), [true, true, true, true]);
  assert.equal(s.cache.has(1, 4), false);
});

test('FLOOD_WAIT: waits the seconds Telegram asks, then succeeds', async t => {
  const waits = [];
  const s = await startServer({ sleep: async ms => { waits.push(ms); } });
  t.after(() => s.close());
  const flood = Object.assign(new Error('A wait of 7 seconds is required'), { errorMessage: 'FLOOD', seconds: 7 });
  s.source.failNext.push(flood);
  const r = await get(s.port, '/stream/1', { ...AUTH, Range: 'bytes=0-99' });
  assert.equal(r.status, 206);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 7000 && waits[0] < 8000, `waited ${waits[0]}ms`);
});

test('network drop: retried with backoff, then served', async t => {
  const waits = [];
  const s = await startServer({ sleep: async ms => { waits.push(ms); } });
  t.after(() => s.close());
  s.source.failNext.push(new Error('Cannot send requests while disconnected'));
  s.source.failNext.push(Object.assign(new Error('TIMEOUT'), { errorMessage: 'TIMEOUT' }));
  const r = await get(s.port, '/stream/1', { ...AUTH, Range: 'bytes=0-99' });
  assert.equal(r.status, 206);
  assert.deepEqual(waits, [1000, 2000]);
});

test('a hard Telegram error becomes a clean 502 (no half response)', async t => {
  const s = await startServer();
  t.after(() => s.close());
  s.source.failNext.push(Object.assign(new Error('CHANNEL_PRIVATE'), { errorMessage: 'CHANNEL_PRIVATE' }));
  const r = await get(s.port, '/stream/1', { ...AUTH, Range: 'bytes=0-99' });
  assert.equal(r.status, 502);
  assert.equal(JSON.parse(r.body).error, 'telegram_error');
});
