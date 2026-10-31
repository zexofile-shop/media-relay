'use strict';
// Turns TG_SESSION into a GramJS StringSession string.
// Accepts: a Telethon/GramJS StringSession (starts with "1"), or a Pyrogram session string
// (v2: dc_id, api_id, test_mode, auth_key, user_id, is_bot; v1: dc_id, test_mode, auth_key, user_id, is_bot).
// Never log the session or the key.

// Telegram production data centers (port 443).
const DC_IPS = {
  1: '149.154.175.53',
  2: '149.154.167.51',
  3: '149.154.175.100',
  4: '149.154.167.91',
  5: '91.108.56.130',
};

function b64urlDecode(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Buffer.from(t, 'base64');
}

// Pyrogram v2 layout ">BI?256sQ?" = 1+4+1+256+8+1 = 271 bytes.
// Pyrogram v1 layout ">B?256sI?"  = 1+1+256+4+1 = 263 bytes (old, 32-bit user id).
// Pyrogram v1 64-bit ">B?256sQ?"  = 1+1+256+8+1 = 267 bytes.
function parsePyrogram(str) {
  const b = b64urlDecode(str.trim());
  if (b.length === 271) {
    return { format: 'pyrogram-v2', dcId: b.readUInt8(0), apiId: b.readUInt32BE(1), testMode: !!b[5], authKey: b.subarray(6, 262), userId: b.readBigUInt64BE(262), isBot: !!b[270] };
  }
  if (b.length === 263) {
    return { format: 'pyrogram-v1', dcId: b.readUInt8(0), testMode: !!b[1], authKey: b.subarray(2, 258), userId: BigInt(b.readUInt32BE(258)), isBot: !!b[262] };
  }
  if (b.length === 267) {
    return { format: 'pyrogram-v1', dcId: b.readUInt8(0), testMode: !!b[1], authKey: b.subarray(2, 258), userId: b.readBigUInt64BE(258), isBot: !!b[266] };
  }
  throw new Error(`TG_SESSION is not a known session format (decoded ${b.length} bytes)`);
}

// GramJS / Telethon StringSession: "1" + base64( dc_id(1) + ip(4 or 16 bytes) + port(2, BE) + auth_key(256) ).
// GramJS also accepts the ip as a utf-8 string with a 2-byte length prefix; we use the Telethon packed form.
function buildStringSession(dcId, ip, port, authKey) {
  if (!authKey || authKey.length !== 256) throw new Error('auth key must be 256 bytes');
  const ipBytes = Buffer.from(ip.split('.').map(Number));
  const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port, 0);
  const raw = Buffer.concat([Buffer.from([dcId]), ipBytes, portBuf, Buffer.from(authKey)]);
  return '1' + raw.toString('base64');
}

/** Returns { session, format, dcId, testMode } — session is a GramJS StringSession string ('' if empty). */
function normalizeSession(input) {
  const s = (input || '').trim();
  if (!s) return { session: '', format: 'empty' };
  if (s.startsWith('1')) {
    // Telethon/GramJS: version "1" + standard base64 of 263 (IPv4) or 275 (IPv6) bytes.
    try {
      const body = Buffer.from(s.slice(1), 'base64');
      if (body.length === 263 || body.length === 275) return { session: s, format: 'stringsession', dcId: body[0] };
    } catch (_) { /* fall through to pyrogram */ }
  }
  const p = parsePyrogram(s);
  if (p.testMode) throw new Error('TG_SESSION is a Telegram TEST server session; a normal account session is needed');
  const ip = DC_IPS[p.dcId];
  if (!ip) throw new Error(`TG_SESSION has unknown data center ${p.dcId}`);
  return { session: buildStringSession(p.dcId, ip, 443, p.authKey), format: p.format, dcId: p.dcId, isBot: p.isBot, apiId: p.apiId };
}

module.exports = { normalizeSession, parsePyrogram, buildStringSession, DC_IPS };
