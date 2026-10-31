'use strict';
// Mock "Telegram" for local testing: every .mp4 in a folder becomes a channel message
// (msgId 1, 2, 3… in file-name order). Same interface as TelegramSource.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');

const CHUNK_SIZE = 1024 * 1024;

class MockSource {
  constructor({ dir, files, delayMs = 0, log } = {}) {
    this.dir = dir;
    this.files = files || fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm|mov)$/i.test(f)).sort().map(f => path.join(dir, f));
    this.delayMs = delayMs;
    this.log = log;
    this.calls = { getChunk: 0, getMeta: 0, list: 0, getThumb: 0 };
    this.chunkCalls = new Map(); // "msg:idx" -> count
    this.failNext = []; // errors to throw on the next getChunk calls (for tests)
    this.metas = this.files.map((f, i) => this._meta(f, i + 1));
  }
  get mode() { return 'mock'; }
  get connected() { return true; }
  async start() { this.log && this.log.info(`mock source: ${this.files.length} video(s) from ${this.dir || 'list'}`); }

  _meta(file, msgId) {
    let duration = null, width = null, height = null;
    try {
      const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { timeout: 15000 }).toString();
      const j = JSON.parse(out);
      duration = Math.round(Number(j.format.duration)); width = j.streams[0].width; height = j.streams[0].height;
    } catch (_) { /* ffprobe optional */ }
    const name = path.basename(file);
    const thumb = file.replace(/\.[^.]+$/, '.jpg');
    return { msgId, docId: `mock-${msgId}-${fs.statSync(file).size}`, size: fs.statSync(file).size, mime: 'video/mp4', duration, width, height,
      title: name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), caption: `Sample ${name}`, fileName: name,
      hasThumb: fs.existsSync(thumb), date: Math.floor(fs.statSync(file).mtimeMs / 1000), _file: file, _thumb: thumb };
  }
  _clean(m) { if (!m) return null; const { _file, _thumb, ...rest } = m; return rest; }
  async _delay() { if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs)); }

  async list() { this.calls.list++; await this._delay(); return this.metas.map(m => this._clean(m)); }
  async getMeta(msgId) { this.calls.getMeta++; return this._clean(this.metas.find(m => m.msgId === msgId)); }

  async getChunk(msgId, idx) {
    this.calls.getChunk++;
    const key = `${msgId}:${idx}`;
    this.chunkCalls.set(key, (this.chunkCalls.get(key) || 0) + 1);
    if (this.failNext.length) throw this.failNext.shift();
    await this._delay();
    const m = this.metas.find(x => x.msgId === msgId);
    if (!m) throw Object.assign(new Error('not found'), { status: 404 });
    const fh = await fsp.open(m._file, 'r');
    try {
      const len = Math.max(0, Math.min(CHUNK_SIZE, m.size - idx * CHUNK_SIZE));
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, idx * CHUNK_SIZE);
      return buf;
    } finally { await fh.close(); }
  }

  async getThumb(msgId) {
    this.calls.getThumb++;
    const m = this.metas.find(x => x.msgId === msgId);
    return m && m.hasThumb ? fsp.readFile(m._thumb) : null;
  }
  async stop() {}
}

module.exports = { MockSource };
