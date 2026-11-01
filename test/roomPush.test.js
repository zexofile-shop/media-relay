'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startServer, request } = require('./helpers');
const { PushService } = require('../src/push');
const { RoomPush, fsFields } = require('../src/roomPush');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({ type: 'service_account', project_id: 'demo-proj', client_email: 'p@demo-proj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' });

const ts = ms => ({ timestampValue: new Date(ms).toISOString() });
/** Fake Google: token, Firestore docs (path -> fields), FCM. */
function fakeNet(docs) {
  const calls = { fs: [], fcm: [] };
  const fetchImpl = async (url, opts = {}) => {
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (url === 'https://oauth2.googleapis.com/token') return reply(200, { access_token: 'tok', expires_in: 3599 });
    if (url.startsWith('https://firestore.googleapis.com/')) {
      const p = decodeURIComponent(url.split('/documents/')[1]);
      calls.fs.push(p);
      return docs[p] ? reply(200, { name: p, fields: docs[p] }) : reply(404, {});
    }
    if (url.startsWith('https://fcm.googleapis.com/')) { calls.fcm.push(JSON.parse(opts.body)); return reply(200, { name: 'projects/demo-proj/messages/1' }); }
    throw new Error('unexpected ' + url);
  };
  return { fetchImpl, calls };
}
const NOW = Date.parse('2026-11-01T10:00:00Z');
function setup(docs, extra = {}) {
  const net = fakeNet(docs);
  const push = new PushService({ serviceAccount: SA, fetchImpl: net.fetchImpl, now: () => NOW });
  const roomPush = new RoomPush({ push, now: () => NOW, roomGapMs: 0, ...extra });
  return { net, roomPush };
}
const baseDocs = () => ({
  'app_config/community': {},
  'batches/b1': { title: { stringValue: 'Astra Series' } },
  'batches/b1/chat/m1': { uid: { stringValue: 'student1' }, name: { stringValue: 'Ravi' }, text: { stringValue: 'Kal ka test kis chapter se hai bhai? ' + 'x'.repeat(100) }, createdAt: ts(NOW - 5000) },
  'batches/b1/chat/m2': { uid: { stringValue: 'someone' }, name: { stringValue: 'X' }, text: { stringValue: 'hi' }, createdAt: ts(NOW - 5000) },
  'batches/b1/chat/old': { uid: { stringValue: 'student1' }, name: { stringValue: 'Ravi' }, text: { stringValue: 'old' }, createdAt: ts(NOW - 3600000) },
});
const auth = t => ({ Authorization: `Bearer ${t}` });

test('room-push: login required, bad body refused, nothing sent', async () => {
  const { net, roomPush } = setup(baseDocs());
  const s = await startServer({ roomPush });
  try {
    let r = await request(s.port, '/api/room-push', { method: 'POST', body: { room: 'b1', msg: 'm1' } });
    assert.strictEqual(r.status, 401);
    r = await request(s.port, '/api/room-push', { method: 'POST', body: { room: 'b/1', msg: 'm1' }, headers: auth('good-token') });
    assert.strictEqual(r.status, 400);
    r = await request(s.port, '/api/room-push', { headers: auth('good-token') });
    assert.strictEqual(r.status, 405);
    assert.strictEqual(net.calls.fcm.length, 0);
  } finally { await s.close(); }
});

test('room-push: own fresh message -> one data-only topic push with collapse key, text clipped to 80', async () => {
  const { net, roomPush } = setup(baseDocs());
  const s = await startServer({ roomPush });
  try {
    const r = await request(s.port, '/api/room-push', { method: 'POST', body: { room: 'b1', msg: 'm1' }, headers: auth('good-token') });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(net.calls.fcm.length, 1);
    const m = net.calls.fcm[0].message;
    assert.strictEqual(m.topic, 'chat_b1');
    assert.strictEqual(m.notification, undefined);
    assert.strictEqual(m.android.collapse_key, 'chat_b1');
    assert.strictEqual(m.android.priority, 'HIGH');
    assert.strictEqual(m.data.title, 'Astra Series');
    assert.strictEqual(m.data.uid, 'student1');
    assert.strictEqual(m.data.kind, 'chat');
    assert.ok(m.data.text.length <= 80);
    assert.ok(m.data.body.startsWith('Ravi: Kal ka test'));
    // same message again -> no second push
    const r2 = await request(s.port, '/api/room-push', { method: 'POST', body: { room: 'b1', msg: 'm1' }, headers: auth('good-token') });
    assert.strictEqual(r2.json.skipped, 'duplicate');
    assert.strictEqual(net.calls.fcm.length, 1);
  } finally { await s.close(); }
});

test('room-push: someone else\'s message, missing or old message -> refused', async () => {
  const { net, roomPush } = setup(baseDocs());
  const s = await startServer({ roomPush });
  try {
    assert.strictEqual((await request(s.port, '/api/room-push', { method: 'POST', body: { room: 'b1', msg: 'm2' }, headers: auth('good-token') })).status, 404);
    assert.strictEqual((await request(s.port, '/api/room-push', { method: 'POST', body: { room: 'b1', msg: 'nope' }, headers: auth('good-token') })).status, 404);
    assert.strictEqual((await request(s.port, '/api/room-push', { method: 'POST', body: { room: 'b1', msg: 'old' }, headers: auth('good-token') })).status, 409);
    assert.strictEqual(net.calls.fcm.length, 0);
  } finally { await s.close(); }
});

test('room-push: switch off in the config doc -> skipped; not configured -> 503', async () => {
  const docs = baseDocs(); docs['app_config/community'] = { chatPushEnabled: { booleanValue: false } };
  const { net, roomPush } = setup(docs);
  const s = await startServer({ roomPush });
  try {
    const r = await request(s.port, '/api/room-push', { method: 'POST', body: { room: 'b1', msg: 'm1' }, headers: auth('good-token') });
    assert.strictEqual(r.json.skipped, 'off');
    assert.strictEqual(net.calls.fcm.length, 0);
  } finally { await s.close(); }
  const rp = new RoomPush({ push: new PushService({}) });
  const s2 = await startServer({ roomPush: rp });
  try {
    const r = await request(s2.port, '/api/room-push', { method: 'POST', body: { room: 'b1', msg: 'm1' }, headers: auth('good-token') });
    assert.strictEqual(r.status, 503);
  } finally { await s2.close(); }
});

test('room-push: per-user rate limit', async () => {
  const docs = baseDocs();
  for (let i = 0; i < 8; i++) docs[`batches/b1/chat/k${i}`] = { uid: { stringValue: 'student1' }, name: { stringValue: 'R' }, text: { stringValue: 't' }, createdAt: ts(NOW - 1000) };
  const { roomPush } = setup(docs, { ratePerMin: 3 });
  const s = await startServer({ roomPush });
  try {
    const st = [];
    for (let i = 0; i < 5; i++) st.push((await request(s.port, '/api/room-push', { method: 'POST', body: { room: 'b1', msg: `k${i}` }, headers: auth('good-token') })).status);
    assert.deepStrictEqual(st, [200, 200, 200, 429, 429]);
  } finally { await s.close(); }
});

test('room-push: busy room collapses (second push inside the gap is skipped)', async () => {
  const docs = baseDocs();
  docs['batches/b1/chat/k1'] = { uid: { stringValue: 'student1' }, name: { stringValue: 'R' }, text: { stringValue: 't' }, createdAt: ts(NOW - 1000) };
  const { net, roomPush } = setup(docs, { roomGapMs: 2000 });
  const r1 = await roomPush.handle({ uid: 'student1' }, { room: 'b1', msg: 'm1' });
  const r2 = await roomPush.handle({ uid: 'student1' }, { room: 'b1', msg: 'k1' });
  assert.strictEqual(r1.status, 200); assert.strictEqual(r2.body.skipped, 'room_busy');
  assert.strictEqual(net.calls.fcm.length, 1);
});

test('room-push: Firestore REST fields parse', () => {
  assert.deepStrictEqual(fsFields({ fields: { a: { stringValue: 'x' }, b: { booleanValue: false }, c: { integerValue: '3' } } }), { a: 'x', b: false, c: 3 });
});
