'use strict';
// End-to-end check like a real player: starts server.js (SOURCE=mock) on a free port, then
// ffprobe reads the stream over HTTP, and ffmpeg SEEKS to 0:45 and grabs a frame.
// Usage: node tools/probe-test.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Auth } = require('../src/auth');

const root = path.join(__dirname, '..');
const port = 18000 + Math.floor(Math.random() * 1000);
const secret = 'probe-secret-'.padEnd(48, 'z');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
const out = path.join(root, 'test-output');
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env, SOURCE: 'mock', MOCK_VIDEO_DIR: path.join(root, 'sample_videos'), PORT: String(port), HOST: '127.0.0.1',
  DATA_DIR: data, SIGN_SECRET: secret, ADMIN_KEY: 'probe-admin', LOG_LEVEL: 'info', AUTH_MODE: 'firebase' };
const srv = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
srv.stdout.on('data', d => { logs += d; }); srv.stderr.on('data', d => { logs += d; });

const auth = new Auth({ mode: 'off', signSecret: secret });
const url = id => { const s = auth.sign('stream', id, 'probe'); return `http://127.0.0.1:${port}/stream/${id}?exp=${s.exp}&u=${s.u}&sig=${s.sig}`; };
const stats = () => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: '/api/stats', headers: { 'X-Admin-Key': 'probe-admin' } }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const run = (cmd, args) => execFileSync(cmd, args, { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

(async () => {
  for (let i = 0; i < 50 && !/listening/.test(logs); i++) await new Promise(r => setTimeout(r, 100));
  if (!/listening/.test(logs)) throw new Error('server did not start:\n' + logs);
  const results = [];

  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size,format_name:stream=codec_name,width,height', '-of', 'json', url(1)]));
  results.push(`ffprobe lecture 1 over HTTP: ${probe.format.format_name}, ${probe.format.duration}s, ${probe.format.size} bytes, streams: ${probe.streams.map(s => s.codec_name + (s.width ? ` ${s.width}x${s.height}` : '')).join(' + ')}`);
  const afterProbe = (await stats()).cache;
  results.push(`chunks fetched from source after ffprobe: ${afterProbe.fetched} of 20 (what ffprobe read + 3 MB read-ahead)`);

  const frame = path.join(out, 'seek_0m45s.jpg');
  run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-ss', '45', '-i', url(1), '-frames:v', '1', frame]);
  const afterSeek = (await stats()).cache;
  results.push(`ffmpeg -ss 45 grabbed a frame (${fs.statSync(frame).size} bytes) -> ${path.relative(root, frame)}; total chunks fetched now ${afterSeek.fetched}`);

  const probe2 = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', url(2)]));
  const frame2 = path.join(out, 'seek_moov_at_end_0m15s.jpg');
  run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-ss', '15', '-i', url(2), '-frames:v', '1', frame2]);
  results.push(`lecture 2 (moov atom at END, not faststart): ffprobe ${probe2.format.duration}s, seek to 0:15 ok (${fs.statSync(frame2).size} bytes)`);

  // full decode check of 5 seconds from the middle (proves bytes are intact)
  run('ffmpeg', ['-nostdin', '-v', 'error', '-ss', '20', '-t', '5', '-i', url(1), '-f', 'null', '-']);
  results.push('decoded 0:20-0:25 over HTTP with no decoder errors');
  const st = await stats();
  results.push(`cache: ${st.cache.chunks} chunks on disk, hits ${st.cache.hits}, misses ${st.cache.misses}, deduped ${st.cache.dedupedWaits}, prefetches ${st.cache.prefetches}`);
  console.log(results.map(r => '  ok  ' + r).join('\n'));
})().catch(err => { console.error('PROBE FAILED:', err.message, '\n', logs); process.exitCode = 1; })
  .finally(() => { srv.kill('SIGTERM'); setTimeout(() => fs.rmSync(data, { recursive: true, force: true }), 300); });
