'use strict';
// Disk chunk cache: every 1 MB piece of a video is saved as a file, indexed in SQLite
// (size, last access, hits). Least-recently-used chunks are deleted when the cache
// grows past CACHE_MAX_GB. Concurrent requests for the same chunk share ONE Telegram fetch.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
let Database = null;
try { Database = require('better-sqlite3'); } catch (err) { Database = null; } // falls back to an in-memory index
const { withTelegramRetry, Semaphore } = require('./retry');

const CHUNK_SIZE = 1024 * 1024; // 1 MB, aligned with Telegram's upload.getFile rules


// In-memory replacement for the SQLite index (used when better-sqlite3 cannot load).
// The chunk files stay on disk; only the index lives in memory (it starts empty on each boot).
class MemIndex {
  constructor() { this.chunks = new Map(); this.files = new Map(); }
  _k(m, i) { return `${m}:${i}`; }
  build() {
    const self = this;
    const st = f => ({ get: f, run: f, all: f });
    return {
      get: st((m, i) => { const r = self.chunks.get(self._k(m, i)); return r ? { size: r.size } : undefined; }),
      touch: st((now, m, i) => { const r = self.chunks.get(self._k(m, i)); if (r) { r.last_access = now; r.hits++; } }),
      put: st((m, i, size, created, last) => { self.chunks.set(self._k(m, i), { msg_id: m, idx: i, size, created, last_access: last, hits: 0 }); }),
      del: st((m, i) => { self.chunks.delete(self._k(m, i)); }),
      oldest: st(n => [...self.chunks.values()].sort((a, b) => a.last_access - b.last_access || a.created - b.created).slice(0, n).map(r => ({ msg_id: r.msg_id, idx: r.idx, size: r.size }))),
      total: st(() => { let bytes = 0; for (const r of self.chunks.values()) bytes += r.size; return { bytes, n: self.chunks.size }; }),
      byMsg: st(m => [...self.chunks.values()].filter(r => r.msg_id === m).map(r => ({ idx: r.idx }))),
      delMsg: st(m => { for (const [k, r] of self.chunks) if (r.msg_id === m) self.chunks.delete(k); }),
      getFile: st(m => self.files.get(m)),
      putFile: st(o => { self.files.set(o.msgId, { msg_id: o.msgId, doc_id: o.docId, size: o.size, mime: o.mime, duration: o.duration, width: o.width, height: o.height,
        title: o.title, caption: o.caption, file_name: o.fileName, has_thumb: o.hasThumb, date: o.date, updated: o.updated }); }),
      top: st(() => {
        const g = new Map();
        for (const r of self.chunks.values()) {
          const e = g.get(r.msg_id) || { msg_id: r.msg_id, chunks: 0, bytes: 0, hits: 0, last: 0 };
          e.chunks++; e.bytes += r.size; e.hits += r.hits; e.last = Math.max(e.last, r.last_access); g.set(r.msg_id, e);
        }
        return [...g.values()].sort((a, b) => b.last - a.last).slice(0, 50);
      }),
    };
  }
}

class ChunkCache {
  /**
   * @param {object} o
   * @param {string} o.dir           cache folder
   * @param {number} o.maxBytes      evict above this
   * @param {object} o.source        { getMeta(msgId), getChunk(msgId, idx, meta), getThumb(msgId), list() }
   */
  constructor({ dir, maxBytes, source, log, readAhead = 3, concurrency = 3, maxFloodWaitSec = 300, sleep, metaTtlMs = 10 * 60 * 1000, forceMemoryIndex = false }) {
    this.dir = dir;
    this.chunkDir = path.join(dir, 'chunks');
    this.thumbDir = path.join(dir, 'thumbs');
    fs.mkdirSync(this.chunkDir, { recursive: true });
    fs.mkdirSync(this.thumbDir, { recursive: true });
    this.maxBytes = maxBytes;
    this.source = source;
    this.log = log || { debug() {}, info() {}, warn() {}, error() {} };
    this.readAhead = readAhead;
    this.sem = new Semaphore(concurrency);
    this.maxFloodWaitSec = maxFloodWaitSec;
    this.sleep = sleep;
    this.metaTtlMs = metaTtlMs;
    this.inflight = new Map();      // "msg:idx" -> Promise<Buffer>
    this.metaInflight = new Map();
    this.metaMem = new Map();       // msgId -> { meta, at }
    this.stats = { hits: 0, misses: 0, fetched: 0, evicted: 0, dedupedWaits: 0, prefetches: 0 };

    let useSqlite = !!Database && !forceMemoryIndex;
    if (useSqlite) {
      try {
        this.db = new Database(path.join(dir, 'index.sqlite'));
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS chunks (
            msg_id INTEGER NOT NULL, idx INTEGER NOT NULL, size INTEGER NOT NULL,
            created INTEGER NOT NULL, last_access INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (msg_id, idx));
          CREATE INDEX IF NOT EXISTS chunks_lru ON chunks(last_access);
          CREATE TABLE IF NOT EXISTS files (
            msg_id INTEGER PRIMARY KEY, doc_id TEXT, size INTEGER, mime TEXT, duration REAL,
            width INTEGER, height INTEGER, title TEXT, caption TEXT, file_name TEXT,
            has_thumb INTEGER, date INTEGER, updated INTEGER);
        `);
        this.q = {
          get: this.db.prepare('SELECT size FROM chunks WHERE msg_id=? AND idx=?'),
          touch: this.db.prepare('UPDATE chunks SET last_access=?, hits=hits+1 WHERE msg_id=? AND idx=?'),
          put: this.db.prepare('INSERT OR REPLACE INTO chunks (msg_id, idx, size, created, last_access, hits) VALUES (?,?,?,?,?,0)'),
          del: this.db.prepare('DELETE FROM chunks WHERE msg_id=? AND idx=?'),
          oldest: this.db.prepare('SELECT msg_id, idx, size FROM chunks ORDER BY last_access ASC, created ASC LIMIT ?'),
          total: this.db.prepare('SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS n FROM chunks'),
          byMsg: this.db.prepare('SELECT idx FROM chunks WHERE msg_id=?'),
          delMsg: this.db.prepare('DELETE FROM chunks WHERE msg_id=?'),
          getFile: this.db.prepare('SELECT * FROM files WHERE msg_id=?'),
          putFile: this.db.prepare(`INSERT OR REPLACE INTO files (msg_id, doc_id, size, mime, duration, width, height, title, caption, file_name, has_thumb, date, updated)
                                    VALUES (@msgId, @docId, @size, @mime, @duration, @width, @height, @title, @caption, @fileName, @hasThumb, @date, @updated)`),
          top: this.db.prepare('SELECT msg_id, COUNT(*) AS chunks, SUM(size) AS bytes, SUM(hits) AS hits, MAX(last_access) AS last FROM chunks GROUP BY msg_id ORDER BY last DESC LIMIT 50'),
        };
      } catch (err) {
        this.log.warn(`cache: SQLite index unavailable (${err.message}); using in-memory index`);
        useSqlite = false;
      }
    } else if (!forceMemoryIndex) this.log.warn('cache: better-sqlite3 not available; using in-memory index');
    if (!useSqlite) {
      // old chunk files from a previous run are unknown to a fresh in-memory index: clear them
      try { fs.rmSync(this.chunkDir, { recursive: true, force: true }); fs.mkdirSync(this.chunkDir, { recursive: true }); } catch (_) {}
      this.db = { transaction: fn => fn, close() {} };
      this.q = new MemIndex().build();
    }
    this.indexType = useSqlite ? 'sqlite' : 'memory';
    const t = this.q.total.get();
    this.totalBytes = t.bytes;
    this.log.info(`cache: ${t.n} chunks, ${(t.bytes / 1048576).toFixed(1)} MB on disk, limit ${(maxBytes / 1073741824).toFixed(2)} GB`);
  }

  chunkPath(msgId, idx) { return path.join(this.chunkDir, String(msgId), `${idx}.bin`); }
  thumbPath(msgId) { return path.join(this.thumbDir, `${msgId}.jpg`); }
  chunkCount(meta) { return Math.ceil(meta.size / CHUNK_SIZE); }
  expectedLen(meta, idx) { return Math.min(CHUNK_SIZE, meta.size - idx * CHUNK_SIZE); }

  _retry(fn, what) {
    return withTelegramRetry(fn, { log: this.log, what, maxFloodWaitSec: this.maxFloodWaitSec, sleep: this.sleep,
      onDisconnect: () => this.source.reconnect && this.source.reconnect() });
  }

  // ---------- metadata ----------
  rememberMeta(meta) {
    if (!meta) return;
    const prev = this.q.getFile.get(meta.msgId);
    if (prev && prev.doc_id && meta.docId && String(prev.doc_id) !== String(meta.docId)) {
      this.log.info(`msg ${meta.msgId}: video was replaced in Telegram, dropping its old cached chunks`);
      this.purgeMessage(meta.msgId);
    }
    this.q.putFile.run({
      msgId: meta.msgId, docId: meta.docId ? String(meta.docId) : null, size: meta.size, mime: meta.mime,
      duration: meta.duration ?? null, width: meta.width ?? null, height: meta.height ?? null,
      title: meta.title ?? null, caption: meta.caption ?? null, fileName: meta.fileName ?? null,
      hasThumb: meta.hasThumb ? 1 : 0, date: meta.date ?? null, updated: Date.now(),
    });
    this.metaMem.set(meta.msgId, { meta, at: Date.now() });
  }

  async getMeta(msgId) {
    const mem = this.metaMem.get(msgId);
    if (mem && Date.now() - mem.at < this.metaTtlMs) return mem.meta;
    if (this.metaInflight.has(msgId)) return this.metaInflight.get(msgId);
    const p = (async () => {
      try {
        const meta = await this.sem.run(() => this._retry(() => this.source.getMeta(msgId), `meta ${msgId}`));
        if (meta) this.rememberMeta(meta); else this.metaMem.delete(msgId);
        return meta || null;
      } catch (err) {
        // Telegram down? Fall back to what we saved last time so cached videos still play.
        const row = this.q.getFile.get(msgId);
        if (row) {
          this.log.warn(`meta ${msgId}: Telegram error (${err.errorMessage || err.message}), using saved info`);
          return rowToMeta(row);
        }
        throw err;
      } finally { this.metaInflight.delete(msgId); }
    })();
    this.metaInflight.set(msgId, p);
    return p;
  }

  // ---------- chunks ----------
  has(msgId, idx) { return !!this.q.get.get(msgId, idx); }

  async getChunk(msgId, idx, meta) {
    const row = this.q.get.get(msgId, idx);
    if (row) {
      try {
        const buf = await fsp.readFile(this.chunkPath(msgId, idx));
        if (buf.length === row.size) {
          this.q.touch.run(Date.now(), msgId, idx);
          this.stats.hits++;
          return buf;
        }
      } catch (_) { /* file vanished: fetch again */ }
      this._forget(msgId, idx, row.size);
    }
    const key = `${msgId}:${idx}`;
    const running = this.inflight.get(key);
    if (running) { this.stats.dedupedWaits++; return running; }
    this.stats.misses++;
    const p = this._fetchAndStore(msgId, idx, meta).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async _fetchAndStore(msgId, idx, meta) {
    const want = this.expectedLen(meta, idx);
    if (want <= 0) throw Object.assign(new Error(`chunk ${idx} is past the end of msg ${msgId}`), { status: 416 });
    const t0 = Date.now();
    let buf = await this.sem.run(() => this._retry(() => this.source.getChunk(msgId, idx, meta), `chunk ${msgId}#${idx}`));
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length > want) buf = buf.subarray(0, want);
    if (buf.length < want) throw new Error(`chunk ${msgId}#${idx}: got ${buf.length} bytes, expected ${want}`);
    this.stats.fetched++;
    this.log.debug(`fetched ${msgId}#${idx} (${buf.length} B) in ${Date.now() - t0}ms`);
    try {
      const file = this.chunkPath(msgId, idx);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, file);
      const now = Date.now();
      const prev = this.q.get.get(msgId, idx);
      this.q.put.run(msgId, idx, buf.length, now, now);
      this.totalBytes += buf.length - (prev ? prev.size : 0);
      this.evictIfNeeded(`${msgId}:${idx}`);
    } catch (err) {
      this.log.warn(`could not save chunk ${msgId}#${idx} to disk: ${err.message}`); // still serve it
    }
    return buf;
  }

  /** Warm the next few chunks in the background so playback does not stall. */
  prefetch(msgId, idx, meta, count = this.readAhead) {
    const last = this.chunkCount(meta) - 1;
    for (let i = idx + 1; i <= Math.min(last, idx + count); i++) {
      if (this.sem.busy) return;
      if (this.inflight.has(`${msgId}:${i}`) || this.q.get.get(msgId, i)) continue;
      this.stats.prefetches++;
      this.getChunk(msgId, i, meta).catch(err => this.log.debug(`prefetch ${msgId}#${i} failed: ${err.message}`));
    }
  }

  _forget(msgId, idx, size) {
    this.q.del.run(msgId, idx);
    this.totalBytes -= size;
    fsp.unlink(this.chunkPath(msgId, idx)).catch(() => {});
  }

  evictIfNeeded(keepKey) {
    if (this.totalBytes <= this.maxBytes) return;
    const target = this.maxBytes * 0.9; // free a little extra so we do not evict on every write
    let freed = 0;
    while (this.totalBytes > target) {
      const rows = this.q.oldest.all(256);
      const victims = rows.filter(r => `${r.msg_id}:${r.idx}` !== keepKey);
      if (!victims.length) break;
      const tx = this.db.transaction(list => {
        for (const r of list) {
          if (this.totalBytes <= target) break;
          this.q.del.run(r.msg_id, r.idx);
          this.totalBytes -= r.size;
          freed += r.size;
          this.stats.evicted++;
          try { fs.unlinkSync(this.chunkPath(r.msg_id, r.idx)); } catch (_) {}
        }
      });
      tx(victims);
      if (victims.length < 256 && this.totalBytes > target) break;
    }
    if (freed) this.log.info(`cache: evicted ${(freed / 1048576).toFixed(1)} MB (LRU), now ${(this.totalBytes / 1048576).toFixed(1)} MB`);
  }

  purgeMessage(msgId) {
    for (const r of this.q.byMsg.all(msgId)) {
      try { fs.unlinkSync(this.chunkPath(msgId, r.idx)); } catch (_) {}
    }
    this.q.delMsg.run(msgId);
    this.totalBytes = this.q.total.get().bytes;
    try { fs.unlinkSync(this.thumbPath(msgId)); } catch (_) {}
  }

  // ---------- thumbnails ----------
  async getThumb(msgId) {
    const file = this.thumbPath(msgId);
    try { return await fsp.readFile(file); } catch (_) {}
    const key = `thumb:${msgId}`;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      const buf = await this.sem.run(() => this._retry(() => this.source.getThumb(msgId), `thumb ${msgId}`));
      if (buf && buf.length) await fsp.writeFile(file, buf).catch(() => {});
      return buf || null;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  info() {
    const t = this.q.total.get();
    return { chunks: t.n, bytes: t.bytes, maxBytes: this.maxBytes, ...this.stats, inflight: this.inflight.size };
  }
  perVideo() { return this.q.top.all(); }
  close() { try { this.db.close(); } catch (_) {} }
}

function rowToMeta(r) {
  return { msgId: r.msg_id, docId: r.doc_id, size: r.size, mime: r.mime, duration: r.duration, width: r.width, height: r.height,
    title: r.title, caption: r.caption, fileName: r.file_name, hasThumb: !!r.has_thumb, date: r.date };
}

module.exports = { ChunkCache, CHUNK_SIZE };
