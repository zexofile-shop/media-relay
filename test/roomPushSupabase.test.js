'use strict';
// v5.18 hybrid: room-push for messages stored on Supabase, read with the sender's own token (RLS decides).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { PushService } = require('../src/push');
const { RoomPush } = require('../src/roomPush');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({ type: 'service_account', project_id: 'demo-proj', client_email: 'p@demo-proj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' });
const NOW = Date.parse('2026-11-02T10:00:00Z');
function setup(rows, extra = {}) {
  const calls = { sb: [], fcm: [] };
  const fetchImpl = async (url, opts = {}) => {
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (url === 'https://oauth2.googleapis.com/token') return reply(200, { access_token: 'tok', expires_in: 3599 });
    if (url.startsWith('https://firestore.googleapis.com/')) {
      const p = decodeURIComponent(url.split('/documents/')[1]);
      return p === 'batches/b1' ? reply(200, { name: p, fields: { title: { stringValue: 'Astra Series' } } }) : p === 'app_config/community' ? reply(200, { name: p, fields: {} }) : reply(404, {});
    }
    if (url.startsWith('https://ref.supabase.co/rest/v1/chat_messages')) { calls.sb.push({ url, headers: opts.headers }); return opts.headers.Authorization === 'Bearer good' ? reply(200, rows) : reply(401, { message: 'JWT expired' }); }
    if (url.startsWith('https://fcm.googleapis.com/')) { calls.fcm.push(JSON.parse(opts.body)); return reply(200, { name: 'x' }); }
    throw new Error('unexpected ' + url);
  };
  const push = new PushService({ serviceAccount: SA, fetchImpl, now: () => NOW });
  return { calls, rp: new RoomPush({ push, now: () => NOW, roomGapMs: 0, supabaseUrl: 'https://ref.supabase.co/', supabaseKey: 'anon', fetchImpl, ...extra }) };
}
const row = (o = {}) => [{ uid: 'student1', name: 'Ravi', text: 'Kal ka test?', created_at: new Date(NOW - 4000).toISOString(), ...o }];

test('supabase message: read with the sender token, one push sent', async () => {
  const { calls, rp } = setup(row());
  const r = await rp.handle({ uid: 'student1', token: 'good' }, { room: 'b1', msg: '6b1f2c4e-0000-4000-8000-000000000001', backend: 'supabase' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(calls.sb.length, 1);
  assert.match(calls.sb[0].url, /chat_messages\?select=uid,name,text,created_at&id=eq\.6b1f2c4e-0000-4000-8000-000000000001&batch_id=eq\.b1&limit=1$/);
  assert.strictEqual(calls.sb[0].headers.apikey, 'anon');
  assert.strictEqual(calls.fcm.length, 1);
  assert.strictEqual(calls.fcm[0].message.topic, 'chat_b1');
});
test('supabase message: someone else\'s, stale, unreadable or not configured -> no push', async () => {
  let s = setup(row({ uid: 'other' }));
  assert.strictEqual((await s.rp.handle({ uid: 'student1', token: 'good' }, { room: 'b1', msg: 'm1', backend: 'supabase' })).status, 404);
  s = setup(row({ created_at: new Date(NOW - 3600e3).toISOString() }));
  assert.strictEqual((await s.rp.handle({ uid: 'student1', token: 'good' }, { room: 'b1', msg: 'm1', backend: 'supabase' })).status, 409);
  s = setup(row());
  assert.strictEqual((await s.rp.handle({ uid: 'student1', token: 'bad' }, { room: 'b1', msg: 'm1', backend: 'supabase' })).status, 502);
  s = setup([]);
  assert.strictEqual((await s.rp.handle({ uid: 'student1', token: 'good' }, { room: 'b1', msg: 'm1', backend: 'supabase' })).status, 404);
  s = setup(row(), { supabaseUrl: '' });
  assert.strictEqual((await s.rp.handle({ uid: 'student1', token: 'good' }, { room: 'b1', msg: 'm1', backend: 'supabase' })).status, 503);
  assert.strictEqual(s.calls.fcm.length, 0);
});
