'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { Writable } = require('stream');
const { startServer, request } = require('./helpers');
const { UploadService, safeName, uniqueName, qualityName, MAX_FILE_BYTES } = require('../src/upload');

const auth = t => ({ Authorization: `Bearer ${t}` });
const PDF = n => Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(n - 9)]);
const MP4 = n => { const b = crypto.randomBytes(n); b.write('\0\0\0\x20ftypisom', 0, 'latin1'); return b; };

/** Fake GitHub: releases, assets, uploads (bytes hashed, never kept), workflow dispatch. */
function fakeGitHub({ existing = [], releases = { 'books-up': 11 }, uploadStatus = 201, failAfter, dispatchStatus = 204, runs = [] } = {}) {
  const st = { releases: { ...releases }, assets: existing.map((a, i) => ({ id: 100 + i, state: 'uploaded', ...a })), uploads: [], created: [], deleted: [], dispatches: [], apiCalls: 0, maxWriteHeld: 0 };
  let nextId = 500;
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    st.apiCalls++;
    const u = new URL(url); const p = u.pathname; const method = opts.method || 'GET';
    assert.match(opts.headers.Authorization, /^Bearer gh-token$/);
    let m;
    if ((m = /^\/repos\/o\/r\/releases\/tags\/(.+)$/.exec(p))) { const id = st.releases[decodeURIComponent(m[1])]; return id ? reply(200, { id }) : reply(404, { message: 'Not Found' }); }
    if (p === '/repos/o/r/releases' && method === 'POST') { const b = JSON.parse(opts.body); const id = nextId++; st.releases[b.tag_name] = id; st.created.push(b.tag_name); return reply(201, { id }); }
    if ((m = /^\/repos\/o\/r\/releases\/(\d+)\/assets$/.exec(p))) { const rid = +m[1]; return reply(200, st.assets.filter(a => (a.release || 11) === rid)); }
    if ((m = /^\/repos\/o\/r\/releases\/assets\/(\d+)$/.exec(p)) && method === 'DELETE') { st.deleted.push(+m[1]); st.assets = st.assets.filter(a => a.id !== +m[1]); return reply(204); }
    if ((m = /^\/repos\/o\/r\/actions\/workflows\/([^/]+)\/dispatches$/.exec(p))) { st.dispatches.push({ wf: m[1], ...JSON.parse(opts.body) }); return reply(dispatchStatus); }
    if (/\/actions\/workflows\/[^/]+\/runs$/.test(p)) return reply(200, { workflow_runs: runs });
    return reply(404, {});
  };
  const uploadImpl = (url, headers) => {
    const u = new URL(url); const rid = +/releases\/(\d+)\/assets/.exec(u.pathname)[1]; const name = u.searchParams.get('name');
    const size = +headers['Content-Length']; const hash = crypto.createHash('sha256'); let got = 0;
    const rec = { name, size, type: headers['Content-Type'], got: 0, sha: null, aborted: false };
    st.uploads.push(rec);
    const asset = { id: nextId++, name, state: 'starter', release: rid, size };
    st.assets.push(asset);
    let resolve, reject; const done = new Promise((a, b) => { resolve = a; reject = b; }); done.catch(() => {});
    const stream = new Writable({ highWaterMark: 64 * 1024, write(chunk, _e, cb) {
      got += chunk.length; rec.got = got; hash.update(chunk);
      if (failAfter && got > failAfter) { cb(); reject(Object.assign(new Error('GitHub answered 500'), { code: 'github_upload_failed' })); return; }
      setImmediate(cb);
    }, final(cb) {
      rec.sha = hash.digest('hex'); cb();
      if (got !== size) return reject(new Error('length mismatch'));
      if (uploadStatus !== 201) return reject(Object.assign(new Error(`GitHub answered ${uploadStatus}`), { code: 'github_upload_failed' }));
      asset.state = 'uploaded';
      resolve({ id: asset.id, name, size: got, state: 'uploaded', browser_download_url: `https://github.com/o/r/releases/download/tag/${name}` });
    } });
    return { stream, done, abort() { rec.aborted = true; stream.destroy(); reject(Object.assign(new Error('aborted'), { code: 'aborted' })); } };
  };
  return { st, fetchImpl, uploadImpl };
}

function makeUploads(gh, extra = {}) {
  return new UploadService({ token: 'gh-token', repo: 'o/r', pdfTag: 'books-up', videoTag: 'lectures-v1', qualityWorkflow: 'qualities.yml',
    ownerEmail: 'owner@x.com', projectId: 'p1', chunkSize: 256 * 1024, fetchImpl: extra.fetchImpl || gh.fetchImpl, uploadImpl: gh.uploadImpl, ...extra });
}

function put(port, p, buf, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'PUT', agent: false, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, ...headers } }, res => {
      const b = []; res.on('data', d => b.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(Buffer.concat(b).toString() || 'null') }));
    });
    req.on('error', reject); req.end(buf);
  });
}

async function uploadAll(port, file, { kind = 'pdf', name = 'My Book.pdf', type = 'application/pdf', token = 'owner-token', chunk = 256 * 1024 } = {}) {
  const st = await request(port, '/api/upload/start', { method: 'POST', headers: auth(token), body: { kind, name, size: file.length, type } });
  if (st.status !== 200) return { start: st };
  let off = 0, last;
  while (off < file.length) {
    last = await put(port, `/api/upload/chunk?id=${st.json.id}&offset=${off}`, file.subarray(off, off + chunk), auth(token));
    if (last.status !== 200) return { start: st, last };
    off = last.json.done ? file.length : last.json.received;
  }
  return { start: st, last };
}

test('upload: names are made safe and unique', () => {
  assert.strictEqual(safeName('Class 10 Science (Part 1).PDF', 'pdf'), 'Class-10-Science-Part-1.pdf');
  const up = '.'.repeat(2) + '/';
  assert.strictEqual(safeName(up + up + 'notes/file', 'pdf'), 'notes-file.pdf');
  assert.strictEqual(safeName('हिंदी', 'pdf'), 'book.pdf');
  assert.strictEqual(safeName('Real Numbers.mov', 'video'), 'Real-Numbers.mp4');
  assert.strictEqual(uniqueName('a.pdf', new Set(['a.pdf', 'a-2.pdf'])), 'a-3.pdf');
  assert.strictEqual(qualityName('Lec-1.mp4', '480p'), 'Lec-1_480p.mp4');
  assert.ok(MAX_FILE_BYTES < 2 * 1024 ** 3);
});

test('upload: config endpoint says 503 upload_not_configured when the token is missing; 401 before auth', async () => {
  const s = await startServer({ uploads: new UploadService({ token: '', repo: 'o/r', pdfTag: 'x' }) });
  try {
    let r = await request(s.port, '/api/upload/config');
    assert.strictEqual(r.status, 503); assert.strictEqual(r.json.error, 'upload_not_configured');
    r = await request(s.port, '/api/upload/start', { method: 'POST', body: { kind: 'pdf', name: 'a', size: 10 } });
    assert.strictEqual(r.status, 401); assert.strictEqual(r.json.error, 'login_required');
    r = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('garbage'), body: { kind: 'pdf', name: 'a', size: 10 } });
    assert.strictEqual(r.status, 401);
    r = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('owner-token'), body: { kind: 'pdf', name: 'a', size: 10 } });
    assert.strictEqual(r.status, 503); assert.strictEqual(r.json.error, 'upload_not_configured');
  } finally { await s.close(); }
});

test('upload: config endpoint when set up lists kinds and limits', async () => {
  const s = await startServer({ uploads: makeUploads(fakeGitHub()) });
  try {
    const r = await request(s.port, '/api/upload/config');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.kinds, ['pdf', 'video']);
    assert.deepStrictEqual(r.json.qualities, ['720p', '480p', '360p']);
    assert.strictEqual(r.json.chunkSize, 256 * 1024);
  } finally { await s.close(); }
});

test('upload: chunked PDF reaches GitHub byte for byte and answers the download url', async () => {
  const gh = fakeGitHub();
  const s = await startServer({ uploads: makeUploads(gh) });
  try {
    const file = PDF(1024 * 1024 + 12345);
    const { start, last } = await uploadAll(s.port, file);
    assert.strictEqual(start.status, 200);
    assert.strictEqual(start.json.name, 'My-Book.pdf');
    assert.strictEqual(last.status, 200);
    assert.strictEqual(last.json.done, true);
    assert.strictEqual(last.json.url, 'https://github.com/o/r/releases/download/tag/My-Book.pdf');
    assert.strictEqual(last.json.size, file.length);
    assert.strictEqual(gh.st.uploads.length, 1);
    assert.strictEqual(gh.st.uploads[0].size, file.length);
    assert.strictEqual(gh.st.uploads[0].type, 'application/pdf');
    assert.strictEqual(gh.st.uploads[0].sha, crypto.createHash('sha256').update(file).digest('hex'));
  } finally { await s.close(); }
});

test('upload: a name already on the release gets a suffix; a stuck "starter" asset is cleared', async () => {
  const gh = fakeGitHub({ existing: [{ name: 'My-Book.pdf' }, { name: 'My-Book-2.pdf' }, { id: 77, name: 'Other.pdf', state: 'starter' }] });
  const s = await startServer({ uploads: makeUploads(gh) });
  try {
    let r = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('owner-token'), body: { kind: 'pdf', name: 'My Book', size: 100, type: 'application/pdf' } });
    assert.strictEqual(r.json.name, 'My-Book-3.pdf');
    r = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('owner-token'), body: { kind: 'pdf', name: 'Other.pdf', size: 100, type: 'application/pdf' } });
    assert.strictEqual(r.json.name, 'Other.pdf');
    assert.deepStrictEqual(gh.st.deleted, [77]);
  } finally { await s.close(); }
});

test('upload: video release is created when missing', async () => {
  const gh = fakeGitHub();
  const s = await startServer({ uploads: makeUploads(gh) });
  try {
    const file = MP4(300 * 1024);
    const { last } = await uploadAll(s.port, file, { kind: 'video', name: 'Real Numbers.mp4', type: 'video/mp4' });
    assert.strictEqual(last.json.done, true);
    assert.deepStrictEqual(gh.st.created, ['lectures-v1']);
    assert.strictEqual(gh.st.uploads[0].type, 'video/mp4');
  } finally { await s.close(); }
});

test('upload: validation (kind, size, type, too large)', async () => {
  const s = await startServer({ uploads: makeUploads(fakeGitHub()) });
  try {
    const st = body => request(s.port, '/api/upload/start', { method: 'POST', headers: auth('owner-token'), body });
    assert.strictEqual((await st({ kind: 'exe', name: 'a', size: 5 })).json.error, 'bad_kind');
    assert.strictEqual((await st({ kind: 'pdf', name: 'a', size: 0 })).json.error, 'bad_size');
    assert.strictEqual((await st({ kind: 'pdf', name: 'a', size: 'x' })).json.error, 'bad_size');
    let r = await st({ kind: 'pdf', name: 'a', size: 2 * 1024 ** 3 });
    assert.strictEqual(r.status, 413); assert.strictEqual(r.json.error, 'file_too_large');
    r = await st({ kind: 'pdf', name: 'a', size: 10, type: 'image/png' });
    assert.strictEqual(r.status, 415); assert.strictEqual(r.json.error, 'wrong_type');
    r = await st({ kind: 'video', name: 'a', size: 10, type: 'video/quicktime' });
    assert.strictEqual(r.status, 415);
    r = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('owner-token'), body: 'not json' });
    assert.strictEqual(r.status, 400);
  } finally { await s.close(); }
});

test('upload: file content is checked before anything goes to GitHub', async () => {
  const gh = fakeGitHub();
  const s = await startServer({ uploads: makeUploads(gh) });
  try {
    const fake = crypto.randomBytes(5000); // claims to be a PDF, is not
    const { last } = await uploadAll(s.port, fake);
    assert.strictEqual(last.status, 415); assert.strictEqual(last.json.error, 'wrong_type');
    assert.strictEqual(gh.st.uploads.length, 0);
  } finally { await s.close(); }
});

test('upload: resumable: wrong offset answers 409 with what arrived; resend continues', async () => {
  const gh = fakeGitHub();
  const s = await startServer({ uploads: makeUploads(gh) });
  try {
    const file = PDF(600 * 1024); const C = 256 * 1024;
    const st = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('owner-token'), body: { kind: 'pdf', name: 'r.pdf', size: file.length, type: 'application/pdf' } });
    const id = st.json.id;
    let r = await put(s.port, `/api/upload/chunk?id=${id}&offset=0`, file.subarray(0, C), auth('owner-token'));
    assert.strictEqual(r.json.received, C);
    r = await put(s.port, `/api/upload/chunk?id=${id}&offset=0`, file.subarray(0, C), auth('owner-token')); // a retry of a chunk that did arrive
    assert.strictEqual(r.status, 409); assert.strictEqual(r.json.received, C);
    r = await request(s.port, `/api/upload/status?id=${id}`, { headers: auth('owner-token') });
    assert.strictEqual(r.json.received, C); assert.strictEqual(r.json.done, false);
    r = await put(s.port, `/api/upload/chunk?id=${id}&offset=${C}`, file.subarray(C, 2 * C), auth('owner-token'));
    r = await put(s.port, `/api/upload/chunk?id=${id}&offset=${2 * C}`, file.subarray(2 * C), auth('owner-token'));
    assert.strictEqual(r.json.done, true);
    assert.strictEqual(gh.st.uploads[0].sha, crypto.createHash('sha256').update(file).digest('hex'));
    r = await request(s.port, `/api/upload/status?id=${id}`, { headers: auth('owner-token') }); // the final answer is kept for a lost reply
    assert.strictEqual(r.json.done, true); assert.ok(r.json.url);
  } finally { await s.close(); }
});

test('upload: a connection dropped mid-chunk keeps the bytes that arrived and resumes from there', async () => {
  const gh = fakeGitHub();
  const s = await startServer({ uploads: makeUploads(gh) });
  try {
    const file = PDF(500 * 1024); const C = 256 * 1024;
    const st = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('owner-token'), body: { kind: 'pdf', name: 'drop.pdf', size: file.length, type: 'application/pdf' } });
    const id = st.json.id;
    // send half a chunk, then kill the socket
    await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: `/api/upload/chunk?id=${id}&offset=0`, method: 'PUT', agent: false, headers: { ...auth('owner-token'), 'Content-Length': C } });
      req.on('error', () => resolve());
      req.write(file.subarray(0, 100 * 1024), () => setTimeout(() => { req.destroy(); resolve(); }, 150));
    });
    await new Promise(r => setTimeout(r, 150));
    let r = await request(s.port, `/api/upload/status?id=${id}`, { headers: auth('owner-token') });
    const got = r.json.received;
    assert.ok(got > 0 && got <= 100 * 1024, `received ${got}`);
    let off = got;
    while (off < file.length) {
      r = await put(s.port, `/api/upload/chunk?id=${id}&offset=${off}`, file.subarray(off, off + C), auth('owner-token'));
      assert.strictEqual(r.status, 200);
      off = r.json.done ? file.length : r.json.received;
    }
    assert.strictEqual(gh.st.uploads[0].sha, crypto.createHash('sha256').update(file).digest('hex'));
  } finally { await s.close(); }
});

test('upload: GitHub failing mid-way answers 410/502 and clears the broken asset', async () => {
  const gh = fakeGitHub({ failAfter: 300 * 1024 });
  const s = await startServer({ uploads: makeUploads(gh) });
  try {
    const file = PDF(700 * 1024);
    const { last } = await uploadAll(s.port, file);
    assert.ok([410, 502].includes(last.status), `status ${last.status}`);
    assert.strictEqual(last.json.ok, false);
    await new Promise(r => setTimeout(r, 1800));
    assert.ok(gh.st.deleted.length >= 1);
  } finally { await s.close(); }
});

test('upload: only staff: owner email, else admins/{email} read with the caller\'s own token', async () => {
  const gh = fakeGitHub();
  const firestore = [];
  const fetchImpl = async (url, opts) => {
    if (url.startsWith('https://firestore.googleapis.com/')) {
      firestore.push({ url, auth: opts.headers.Authorization });
      return { ok: false, status: url.includes('s%40x.com') ? 200 : 404, text: async () => '{}', json: async () => ({}) };
    }
    return gh.fetchImpl(url, opts);
  };
  let s = await startServer({ uploads: makeUploads(gh, { fetchImpl }) });
  try {
    const body = { kind: 'pdf', name: 'a', size: 10, type: 'application/pdf' };
    let r = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('owner-token'), body });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(firestore.length, 0, 'owner needs no Firestore read');
    r = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('good-token'), body });
    assert.strictEqual(r.status, 200, 'staff doc exists');
    assert.strictEqual(firestore[0].auth, 'Bearer good-token');
    assert.match(firestore[0].url, /projects\/p1\/databases\/\(default\)\/documents\/admins\/s%40x\.com$/);
    r = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('unverified-token'), body });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.json.error, 'not_admin');
  } finally { await s.close(); }
  // a student (no admins doc) is refused
  const fetchNo = async (url, opts) => url.startsWith('https://firestore') ? { ok: false, status: 403, text: async () => '{}' } : gh.fetchImpl(url, opts);
  s = await startServer({ uploads: makeUploads(gh, { fetchImpl: fetchNo }) });
  try {
    const r = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('good-token'), body: { kind: 'pdf', name: 'a', size: 10 } });
    assert.strictEqual(r.status, 403);
  } finally { await s.close(); }
});

test('upload: another user cannot touch my upload session', async () => {
  const gh = fakeGitHub();
  const fetchImpl = async (url, opts) => url.startsWith('https://firestore') ? { ok: true, status: 200, text: async () => '{}' } : gh.fetchImpl(url, opts);
  const s = await startServer({ uploads: makeUploads(gh, { fetchImpl }) });
  try {
    const st = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('owner-token'), body: { kind: 'pdf', name: 'a', size: 10, type: 'application/pdf' } });
    const r = await put(s.port, `/api/upload/chunk?id=${st.json.id}&offset=0`, PDF(10), auth('good-token'));
    assert.strictEqual(r.status, 404);
  } finally { await s.close(); }
});

test('upload: one-shot POST /api/upload streams the whole body', async () => {
  const gh = fakeGitHub();
  const s = await startServer({ uploads: makeUploads(gh) });
  try {
    const file = PDF(900 * 1024);
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/upload?kind=pdf&name=One%20Shot', method: 'POST', agent: false, headers: { ...auth('owner-token'), 'Content-Type': 'application/pdf', 'Content-Length': file.length } }, res => {
        const b = []; res.on('data', d => b.push(d)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(b)) }));
      });
      req.on('error', reject); req.end(file);
    });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.name, 'One-Shot.pdf'); assert.strictEqual(r.json.done, true);
    assert.strictEqual(gh.st.uploads[0].sha, crypto.createHash('sha256').update(file).digest('hex'));
  } finally { await s.close(); }
});

test('upload: a chunk bigger than the chunk size is refused', async () => {
  const s = await startServer({ uploads: makeUploads(fakeGitHub()) });
  try {
    const file = PDF(3 * 1024 * 1024);
    const st = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('owner-token'), body: { kind: 'pdf', name: 'big', size: file.length, type: 'application/pdf' } });
    const r = await put(s.port, `/api/upload/chunk?id=${st.json.id}&offset=0`, file, auth('owner-token'));
    assert.strictEqual(r.status, 413);
  } finally { await s.close(); }
});

test('upload: memory stays bounded while a large file streams (backpressure)', async () => {
  const gh = fakeGitHub();
  const s = await startServer({ uploads: makeUploads(gh, { chunkSize: 8 * 1024 * 1024 }) });
  try {
    const size = 64 * 1024 * 1024; const C = 8 * 1024 * 1024;
    const st = await request(s.port, '/api/upload/start', { method: 'POST', headers: auth('owner-token'), body: { kind: 'video', name: 'big', size, type: 'video/mp4' } });
    const base = process.memoryUsage().rss; let peak = 0;
    const piece = MP4(C);
    for (let off = 0; off < size; off += C) {
      const r = await put(s.port, `/api/upload/chunk?id=${st.json.id}&offset=${off}`, piece, auth('owner-token'));
      assert.strictEqual(r.status, 200);
      peak = Math.max(peak, process.memoryUsage().rss - base);
    }
    assert.strictEqual(gh.st.uploads[0].got, size);
    assert.ok(peak < 200 * 1024 * 1024, `rss grew ${peak}`);
  } finally { await s.close(); }
});

test('upload: CORS for admin origins on preflight and answers', async () => {
  const s = await startServer({ uploads: makeUploads(fakeGitHub()), adminOrigins: 'https://admin.example' });
  try {
    let r = await request(s.port, '/api/upload/chunk', { method: 'OPTIONS', headers: { Origin: 'https://admin.example' } });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers['access-control-allow-origin'], 'https://admin.example');
    assert.match(r.headers['access-control-allow-methods'], /PUT/);
    r = await request(s.port, '/api/upload/config', { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
  } finally { await s.close(); }
});

test('upload: quality copies: dispatch the workflow for an uploaded video and report status', async () => {
  const gh = fakeGitHub({ releases: { 'books-up': 11, 'lectures-v1': 12 }, existing: [{ name: 'Lec.mp4', release: 12 }, { name: 'Lec_720p.mp4', release: 12 }],
    runs: [{ display_title: 'qualities Lec.mp4', status: 'in_progress', conclusion: null, html_url: 'https://github.com/o/r/actions/runs/1' }] });
  const s = await startServer({ uploads: makeUploads(gh) });
  try {
    let r = await request(s.port, '/api/upload/qualities', { method: 'POST', headers: auth('owner-token'), body: { name: 'Nope.mp4' } });
    assert.strictEqual(r.status, 404);
    r = await request(s.port, '/api/upload/qualities', { method: 'POST', headers: auth('owner-token'), body: { name: '.'.repeat(2) + '/x.mp4' } });
    assert.strictEqual(r.status, 400);
    r = await request(s.port, '/api/upload/qualities', { method: 'POST', headers: auth('owner-token'), body: { name: 'Lec.mp4' } });
    assert.strictEqual(r.status, 202);
    assert.deepStrictEqual(gh.st.dispatches, [{ wf: 'qualities.yml', ref: 'main', inputs: { tag: 'lectures-v1', name: 'Lec.mp4' } }]);
    assert.strictEqual(r.json.expected['360p'], 'https://github.com/o/r/releases/download/lectures-v1/Lec_360p.mp4');
    r = await request(s.port, '/api/upload/qualities', { method: 'POST', headers: auth('owner-token'), body: { name: 'Lec.mp4' } });
    assert.strictEqual(r.status, 429);
    r = await request(s.port, '/api/upload/qualities?name=Lec.mp4', { headers: auth('owner-token') });
    assert.strictEqual(r.json.status, 'running');
    assert.deepStrictEqual(Object.keys(r.json.urls), ['720p']);
  } finally { await s.close(); }
});

test('upload: quality dispatch refused by GitHub says the token lacks Actions permission', async () => {
  const gh = fakeGitHub({ releases: { 'lectures-v1': 12 }, existing: [{ name: 'Lec.mp4', release: 12 }], dispatchStatus: 403 });
  const s = await startServer({ uploads: makeUploads(gh) });
  try {
    const r = await request(s.port, '/api/upload/qualities', { method: 'POST', headers: auth('owner-token'), body: { name: 'Lec.mp4' } });
    assert.strictEqual(r.status, 502); assert.strictEqual(r.json.error, 'github_actions_permission');
  } finally { await s.close(); }
});
