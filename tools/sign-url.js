'use strict';
// Print a signed, time-limited stream URL (for testing in VLC / a browser without the app).
// Usage: node tools/sign-url.js <msgId> [hours]
const { loadConfig } = require('../src/config');
const { Auth } = require('../src/auth');
const cfg = loadConfig();
const id = Number(process.argv[2]);
const hours = Number(process.argv[3] || 6);
if (!id) { console.error('Usage: node tools/sign-url.js <msgId> [hours]'); process.exit(1); }
const auth = new Auth({ mode: 'off', signSecret: cfg.signSecret });
const s = auth.sign('stream', id, 'admin', Math.round(hours * 3600));
const base = cfg.publicBaseUrl || `http://${cfg.host}:${cfg.port}`;
console.log(`${base}/stream/${id}?exp=${s.exp}&u=${s.u}&sig=${s.sig}`);
