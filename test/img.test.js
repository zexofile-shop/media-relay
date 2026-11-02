'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { startServer } = require('./helpers');
const { ImgbbService, sniffType, cleanName } = require('../src/img');

const ORIGIN = 'https://admin.example';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const KEY = 'k'.repeat(32);

function fakeImgbb(over = {}) {
  const calls = [];
  const fetchImpl = async (u, opts) => {
    calls.push({ u, opts, form: new URLSearchParams(opts.body) });
    if (over.fail) return { ok: false, status: 400, json: async () => ({ success: false, error: { message: 'Invalid API v1 key.', code: 100 } }) };
    return { ok: true, status: 200, json: async () => ({ success: true, status: 200, data: { id: 'abc', url: 'https://i.ibb.co/x/t.png', display_url: 'https://i.ibb.co/y/t.png', delete_url: 'https://ibb.co/abc/del', width: 4, height: 4, size: 72 } }) };
  };
  const svc = new ImgbbService({ key: over.key === undefined ? KEY : over.key, maxBytes: over.maxBytes || 1024, ratePerMin: over.rate ?? 30, fetchImpl });
  return { svc, calls };
}
const staff = { isStaff: async (u) => String(u.email || '').toLowerCase() === 'owner@x.com' && u.emailVerified !== false };

function post(port, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers }; if (body) h['Content-Length'] = body.length;
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: h, agent: false }, res => {
      const b = []; res.on('data', d => b.push(d)); res.on('end', () => { const s = Buffer.concat(b).toString(); let json = null; try { json = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, json, text: s }); });
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
const ok = { Origin: ORIGIN, Authorization: 'Bearer owner-token', 'Content-Type': 'image/png' };

test('img: admin upload from an allowed origin goes to imgbb; key only in the form, never in the reply', async () => {
  const { svc, calls } = fakeImgbb();
  const s = await startServer({ imgbb: svc, uploads: staff, adminOrigins: ORIGIN });
  try {
    const r = await post(s.port, '/api/img?name=Book%20Cover!.png', { headers: ok, body: PNG });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.url, 'https://i.ibb.co/x/t.png');
    assert.strictEqual(r.json.display_url, 'https://i.ibb.co/y/t.png');
    assert.strictEqual(r.json.delete_url, 'https://ibb.co/abc/del');
    assert.strictEqual(r.headers['access-control-allow-origin'], ORIGIN);
    assert.ok(!r.text.includes(KEY));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].u, 'https://api.imgbb.com/1/upload');
    assert.strictEqual(calls[0].form.get('key'), KEY);
    assert.strictEqual(calls[0].form.get('name'), 'book-cover');
    assert.deepStrictEqual(Buffer.from(calls[0].form.get('image'), 'base64'), PNG);
  } finally { await s.close(); }
});

test('img: refusals (no token, bad token, student, unverified, wrong origin, no origin) never reach imgbb', async () => {
  const { svc, calls } = fakeImgbb();
  const s = await startServer({ imgbb: svc, uploads: staff, adminOrigins: ORIGIN });
  try {
    const cases = [
      [{ ...ok, Authorization: undefined }, 401, 'login_required'],
      [{ ...ok, Authorization: 'Bearer nope' }, 401, 'login_required'],
      [{ ...ok, Authorization: 'Bearer good-token' }, 403, 'not_admin'],
      [{ ...ok, Authorization: 'Bearer unverified-token' }, 403, 'not_admin'],
      [{ ...ok, Origin: 'https://evil.example' }, 403, 'origin_not_allowed'],
      [{ ...ok, Origin: undefined }, 403, 'origin_not_allowed'],
    ];
    for (const [h, st, err] of cases) {
      const hh = {}; for (const [k, v] of Object.entries(h)) if (v !== undefined) hh[k] = v;
      const r = await post(s.port, '/api/img?name=x', { headers: hh, body: PNG });
      assert.strictEqual(r.status, st, JSON.stringify(h)); assert.strictEqual(r.json.error, err);
    }
    assert.strictEqual(calls.length, 0);
  } finally { await s.close(); }
});

test('img: type and size limits', async () => {
  const { svc, calls } = fakeImgbb({ maxBytes: 100 });
  const s = await startServer({ imgbb: svc, uploads: staff, adminOrigins: ORIGIN });
  try {
    let r = await post(s.port, '/api/img', { headers: { ...ok, 'Content-Type': 'application/pdf' }, body: PNG });
    assert.strictEqual(r.status, 415); assert.strictEqual(r.json.error, 'not_image');
    r = await post(s.port, '/api/img', { headers: ok, body: Buffer.from('<svg onload=alert(1)></svg>') });
    assert.strictEqual(r.status, 415); assert.strictEqual(r.json.error, 'not_image');
    r = await post(s.port, '/api/img', { headers: ok, body: Buffer.concat([PNG, Buffer.alloc(200)]) });
    assert.strictEqual(r.status, 413); assert.strictEqual(r.json.error, 'too_big');
    r = await post(s.port, '/api/img', { headers: ok });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(calls.length, 0);
  } finally { await s.close(); }
});

test('img: CORS preflight, config, not configured, imgbb error, rate limit', async () => {
  const { svc } = fakeImgbb({ rate: 2 });
  const s = await startServer({ imgbb: svc, uploads: staff, adminOrigins: ORIGIN });
  try {
    const pre = await new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port: s.port, path: '/api/img', method: 'OPTIONS', headers: { Origin: ORIGIN }, agent: false }, res => { res.resume(); res.on('end', () => resolve(res)); }); q.on('error', reject); q.end(); });
    assert.strictEqual(pre.statusCode, 204); assert.strictEqual(pre.headers['access-control-allow-origin'], ORIGIN);
    const cfg = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: s.port, path: '/api/img/config' }, res => { const b = []; res.on('data', d => b.push(d)); res.on('end', () => resolve({ st: res.statusCode, j: JSON.parse(Buffer.concat(b)) })); }));
    assert.strictEqual(cfg.st, 200); assert.strictEqual(cfg.j.configured, true); assert.ok(!JSON.stringify(cfg.j).includes(KEY));
    assert.strictEqual((await post(s.port, '/api/img', { headers: ok, body: PNG })).status, 200);
    assert.strictEqual((await post(s.port, '/api/img', { headers: ok, body: PNG })).status, 200);
    assert.strictEqual((await post(s.port, '/api/img', { headers: ok, body: PNG })).status, 429);
  } finally { await s.close(); }
  const off = fakeImgbb({ key: '' });
  const s2 = await startServer({ imgbb: off.svc, uploads: staff, adminOrigins: ORIGIN });
  try { const r = await post(s2.port, '/api/img', { headers: ok, body: PNG }); assert.strictEqual(r.status, 503); assert.strictEqual(r.json.error, 'img_not_configured'); }
  finally { await s2.close(); }
  const bad = fakeImgbb({ fail: true });
  const s3 = await startServer({ imgbb: bad.svc, uploads: staff, adminOrigins: ORIGIN });
  try { const r = await post(s3.port, '/api/img', { headers: ok, body: PNG }); assert.strictEqual(r.status, 502); assert.strictEqual(r.json.error, 'imgbb_failed'); assert.ok(!r.text.includes(KEY)); }
  finally { await s3.close(); }
});

test('img: sniffType + cleanName', () => {
  assert.strictEqual(sniffType(PNG), 'image/png');
  assert.strictEqual(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.strictEqual(sniffType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.strictEqual(sniffType(Buffer.from('GIF89a..')), 'image/gif');
  assert.strictEqual(sniffType(Buffer.from('%PDF-1.4')), '');
  assert.strictEqual(cleanName('My Book (2).webp'), 'my-book-2');
  assert.strictEqual(cleanName(''), 'image');
});
