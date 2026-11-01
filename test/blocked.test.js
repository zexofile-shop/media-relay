'use strict';
// Blocked accounts (blocked/{uid} in the database): refused on the API and on their signed links.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Auth } = require('../src/auth');

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
function make(blocked, calls) {
  return new Auth({
    mode: 'firebase', signSecret: SECRET, blockTtlMs: 0,
    verifyIdToken: async t => {
      if (t === 'tok-a') return { uid: 'a', email: 'a@x.com', exp: Date.now() / 1000 + 3600 };
      if (t === 'tok-b') return { uid: 'b', email: 'b@x.com', exp: Date.now() / 1000 + 3600 };
      throw new Error('bad');
    },
    isBlocked: async (uid, token) => { calls && calls.push([uid, token]); return blocked.has(uid) ? true : (blocked.has('?' + uid) ? null : false); },
  });
}
const req = (h = {}) => ({ headers: h });

test('a blocked account is refused at once, even with a cached token', async () => {
  const blocked = new Set(); const calls = [];
  const auth = make(blocked, calls);
  assert.equal((await auth.verifyUser('tok-a')).uid, 'a');
  blocked.add('a');
  assert.equal(await auth.verifyUser('tok-a'), null);          // cached token, re-checked
  assert.equal((await auth.verifyUser('tok-b')).uid, 'b');     // others unaffected
  assert.deepEqual(calls[0], ['a', 'tok-a']);                   // checked with the caller's own token
});

test('signed links of a blocked account stop working', async () => {
  const blocked = new Set();
  const auth = make(blocked);
  await auth.verifyUser('tok-a');                               // the app fetched its list (signed links issued)
  const p = auth.sign('stream', '7', 'a');
  const url = new URL(`http://x/stream/7?exp=${p.exp}&u=${p.u}&sig=${p.sig}`);
  assert.equal((await auth.allowMedia('stream', '7', req(), url)).ok, true);
  blocked.add('a');
  const r = await auth.allowMedia('stream', '7', req(), url);
  assert.equal(r.ok, false); assert.equal(r.status, 403); assert.equal(r.error, 'blocked');
});

test('unknown answer (offline / error) does not lock anyone out; a blocked answer is remembered', async () => {
  const blocked = new Set(['?a']);
  const auth = make(blocked);
  assert.equal((await auth.verifyUser('tok-a')).uid, 'a');
  blocked.add('a'); assert.equal(await auth.verifyUser('tok-a'), null);
  blocked.delete('a');                                          // check now fails -> remembered "blocked" (10 min)
  assert.equal(await auth.verifyUser('tok-a'), null);
});

test('links of an account never seen by this server stay valid (no token to check with)', async () => {
  const auth = make(new Set(['z']));
  const p = auth.sign('stream', '1', 'z');
  const url = new URL(`http://x/stream/1?exp=${p.exp}&u=z&sig=${p.sig}`);
  assert.equal((await auth.allowMedia('stream', '1', req(), url)).ok, true);
});
