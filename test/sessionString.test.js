'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { normalizeSession, buildStringSession, DC_IPS } = require('../src/sessionString');
const { StringSession } = require('telegram/sessions');

function pyroV2({ dc = 4, apiId = 12345, test = false, key, userId = 777000111n, bot = false }) {
  const b = Buffer.alloc(271);
  b.writeUInt8(dc, 0); b.writeUInt32BE(apiId, 1); b[5] = test ? 1 : 0;
  key.copy(b, 6); b.writeBigUInt64BE(userId, 262); b[270] = bot ? 1 : 0;
  return b.toString('base64url');
}
function pyroV1({ dc = 2, key, userId = 123456, bot = false }) {
  const b = Buffer.alloc(263);
  b.writeUInt8(dc, 0); b[1] = 0; key.copy(b, 2); b.writeUInt32BE(userId, 258); b[262] = bot ? 1 : 0;
  return b.toString('base64url').replace(/=+$/, '');
}

function loadIntoGramjs(str) {
  const ss = new StringSession(str);
  return { dcId: ss.dcId, ip: ss.serverAddress, port: ss.port, key: ss._key };
}

test('empty session -> empty', () => {
  assert.deepStrictEqual(normalizeSession(''), { session: '', format: 'empty' });
  assert.strictEqual(normalizeSession('   ').session, '');
});

test('pyrogram v2 converts to a GramJS StringSession with the right DC, IP and key', () => {
  const key = crypto.randomBytes(256);
  const r = normalizeSession(pyroV2({ dc: 4, key }));
  assert.strictEqual(r.format, 'pyrogram-v2');
  assert.ok(r.session.startsWith('1'));
  const g = loadIntoGramjs(r.session);
  assert.strictEqual(g.dcId, 4);
  assert.strictEqual(g.ip, DC_IPS[4]);
  assert.strictEqual(g.port, 443);
  assert.ok(Buffer.compare(Buffer.from(g.key), key) === 0);
});

test('pyrogram v1 converts too', () => {
  const key = crypto.randomBytes(256);
  const r = normalizeSession(pyroV1({ dc: 5, key }));
  assert.strictEqual(r.format, 'pyrogram-v1');
  const g = loadIntoGramjs(r.session);
  assert.strictEqual(g.dcId, 5);
  assert.strictEqual(g.ip, DC_IPS[5]);
  assert.ok(Buffer.compare(Buffer.from(g.key), key) === 0);
});

test('a Telethon/GramJS StringSession passes through unchanged', () => {
  const key = crypto.randomBytes(256);
  const s = buildStringSession(2, DC_IPS[2], 443, key);
  const r = normalizeSession(s);
  assert.strictEqual(r.format, 'stringsession');
  assert.strictEqual(r.session, s);
  assert.strictEqual(loadIntoGramjs(s).dcId, 2);
});

test('garbage and test-server sessions are rejected', () => {
  assert.throws(() => normalizeSession('hello-world'));
  const key = crypto.randomBytes(256);
  assert.throws(() => normalizeSession(pyroV2({ key, test: true })), /TEST/);
});
