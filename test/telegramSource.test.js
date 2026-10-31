'use strict';
// Exercises the REAL TelegramSource code against a fake GramJS client (no network, no credentials):
// message -> metadata mapping, 1 MB-aligned upload.getFile offsets/limits, FILE_MIGRATE to another DC,
// expired file references, and the bot-mode id scan used to list the channel.
const test = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramSource, messageToMeta, rawChannelId } = require('../src/sources/telegramSource');

const SIZE = 5 * 1048576 + 1234;
const fileBytes = Buffer.alloc(SIZE); for (let i = 0; i < SIZE; i++) fileBytes[i] = (i * 7) & 255;

function doc(ref = 'ref1', dcId = 4) {
  return new Api.Document({
    id: bigInt(555), accessHash: bigInt(777), fileReference: Buffer.from(ref), date: 0, mimeType: 'video/mp4',
    size: bigInt(SIZE), dcId, thumbs: [new Api.PhotoSize({ type: 'm', w: 320, h: 180, size: 1000 })],
    attributes: [new Api.DocumentAttributeVideo({ duration: 3600, w: 1280, h: 720, supportsStreaming: true }), new Api.DocumentAttributeFilename({ fileName: 'Physics_L1.mp4' })],
  });
}
function msg(id, ref, text = 'Physics Lecture 1\nKinematics') {
  return new Api.Message({ id, peerId: new Api.PeerChannel({ channelId: bigInt(1) }), date: 1700000000, message: text, media: new Api.MessageMediaDocument({ document: doc(ref) }) });
}

function fakeClient({ messages, migrateOnce = false, expireRefOnce = false }) {
  const log = { getFile: [], getMessages: 0, senders: [] };
  let migrated = !migrateOnce, refExpired = !expireRefOnce, refVersion = 1;
  const handle = req => {
    if (req.className === 'channels.GetMessages') {
      log.getMessages++;
      return new Api.messages.ChannelMessages({ pts: 0, count: 0, chats: [], users: [], topics: [],
        messages: req.id.map(i => { const m = messages[i.id]; return m ? (m === 'video' ? msg(i.id, `ref${refVersion}`) : m) : new Api.MessageEmpty({ id: i.id }); }) });
    }
    if (req.className === 'upload.GetFile') {
      const off = Number(req.offset.toString());
      log.getFile.push({ off, limit: req.limit, ref: req.location.fileReference.toString(), thumb: req.location.thumbSize });
      if (!refExpired && req.location.fileReference.toString() === 'ref1') { refExpired = true; refVersion = 2; throw Object.assign(new Error('FILE_REFERENCE_EXPIRED'), { errorMessage: 'FILE_REFERENCE_EXPIRED' }); }
      // Telegram rules: offset % 4096 == 0, limit % 4096 == 0, 1MB % limit == 0, no 1 MB border crossing
      assert.equal(off % 4096, 0); assert.equal(req.limit % 4096, 0); assert.equal(1048576 % req.limit, 0);
      assert.equal(Math.floor(off / 1048576), Math.floor((off + req.limit - 1) / 1048576));
      if (req.location.thumbSize) return new Api.upload.File({ type: new Api.storage.FileJpeg(), mtime: 0, bytes: Buffer.from([0xff, 0xd8, 0xff]) });
      return new Api.upload.File({ type: new Api.storage.FileMp4(), mtime: 0, bytes: fileBytes.subarray(off, off + req.limit) });
    }
    throw new Error('unexpected ' + req.className);
  };
  return {
    log,
    session: { dcId: 2 },
    connected: true,
    async invoke(req) { return handle(req); },
    async getSender(dc) { log.senders.push(dc); return { dcId: dc }; },
    async invokeWithSender(req, sender) {
      if (!migrated) { migrated = true; throw Object.assign(new Error('FILE_MIGRATE_5'), { errorMessage: 'FILE_MIGRATE_5', newDc: 5 }); }
      return handle(req);
    },
  };
}

function source(client, isBot = true) {
  const s = new TelegramSource({ client, channelId: '-1001234567890', botToken: isBot ? 'x' : '', log: { info() {}, warn() {} } });
  s.inputChannel = new Api.InputChannel({ channelId: bigInt(1234567890), accessHash: bigInt.zero });
  return s;
}

test('rawChannelId', () => {
  assert.equal(rawChannelId('-1001234567890'), '1234567890');
  assert.equal(rawChannelId('1234567890'), '1234567890');
  assert.throws(() => rawChannelId('@mychannel'));
});

test('messageToMeta maps a Telegram video message', () => {
  const m = messageToMeta(msg(42, 'r'));
  assert.equal(m.msgId, 42);
  assert.equal(m.size, SIZE);
  assert.equal(m.mime, 'video/mp4');
  assert.equal(m.duration, 3600);
  assert.equal(m.title, 'Physics Lecture 1');
  assert.equal(m.fileName, 'Physics_L1.mp4');
  assert.equal(m.hasThumb, true);
  assert.equal(m.docId, '555');
  assert.equal(messageToMeta(new Api.Message({ id: 1, peerId: new Api.PeerChannel({ channelId: bigInt(1) }), date: 0, message: 'text only' })), null);
});

test('getChunk: 1 MB aligned offsets, 512 KB parts, right bytes, last partial chunk', async () => {
  const c = fakeClient({ messages: { 10: 'video' } });
  const s = source(c);
  const b2 = await s.getChunk(10, 2);
  assert.ok(b2.equals(fileBytes.subarray(2 * 1048576, 3 * 1048576)));
  assert.deepEqual(c.log.getFile.map(g => [g.off, g.limit]), [[2097152, 524288], [2621440, 524288]]);
  const last = await s.getChunk(10, 5);
  assert.equal(last.length, 1234);
  assert.ok(last.equals(fileBytes.subarray(5 * 1048576)));
  assert.equal(c.log.getFile.length, 3, 'only one part needed for a 1234-byte tail');
});

test('file on another DC: uses that DC, follows FILE_MIGRATE', async () => {
  const c = fakeClient({ messages: { 10: 'video' }, migrateOnce: true });
  const s = source(c);
  const b = await s.getChunk(10, 0);
  assert.ok(b.equals(fileBytes.subarray(0, 1048576)));
  assert.ok(c.log.senders.includes(4), 'document dcId 4 used');
  assert.ok(c.log.senders.includes(5), 'migrated to DC 5');
});

test('expired file reference: re-reads the message and retries', async () => {
  const c = fakeClient({ messages: { 10: 'video' }, expireRefOnce: true });
  const s = source(c);
  const b = await s.getChunk(10, 1);
  assert.ok(b.equals(fileBytes.subarray(1048576, 2097152)));
  assert.equal(c.log.getMessages, 2);
  assert.ok(c.log.getFile.some(g => g.ref === 'ref2'));
});

test('bot-mode list scans message ids and keeps only videos', async () => {
  const text = new Api.Message({ id: 3, peerId: new Api.PeerChannel({ channelId: bigInt(1) }), date: 0, message: 'notice' });
  const c = fakeClient({ messages: { 2: 'video', 3: text, 150: 'video', 420: 'video' } });
  const s = source(c);
  s.scanEmptyBatches = 3;
  const list = await s.list();
  assert.deepEqual(list.map(v => v.msgId), [2, 150, 420]);
  assert.equal(c.log.getMessages, 8, 'ids 1..800 scanned: 5 batches up to 420 then 3 empty');
});

test('thumbnail download uses the thumb size type', async () => {
  const c = fakeClient({ messages: { 10: 'video' } });
  const s = source(c);
  const t = await s.getThumb(10);
  assert.equal(t[0], 0xff);
  assert.equal(c.log.getFile[0].thumb, 'm');
});
