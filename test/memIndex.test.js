'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChunkCache } = require('../src/chunkCache');
const { MockSource } = require('../src/sources/mockSource');

test('in-memory index fallback: miss, hit, eviction', async () => {
  const VIDEO_DIR = path.join(__dirname, '..', 'sample_videos');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memidx-'));
  const source = new MockSource({ dir: VIDEO_DIR });
  const cache = new ChunkCache({ dir, maxBytes: 3 * 1048576, source, readAhead: 0, forceMemoryIndex: true });
  assert.equal(cache.indexType, 'memory');
  const meta = await cache.getMeta(1);
  const a = await cache.getChunk(1, 0, meta);
  const b = await cache.getChunk(1, 0, meta);
  assert.ok(a.equals(b));
  assert.equal(source.calls.getChunk, 1);
  for (let i = 1; i < 6; i++) await cache.getChunk(1, i, meta);
  assert.ok(cache.totalBytes <= 3 * 1048576, 'evicted down to the limit');
  assert.ok(cache.info().chunks <= 3);
  cache.close();
});
