'use strict';
// USER mode only: one-time Telegram login. Asks phone, code and 2FA password in this terminal,
// then saves the session to SESSION_FILE (default data/session.txt). Not needed in BOT mode.
// Usage: node login.js
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { loadConfig } = require('./src/config');

(async () => {
  const cfg = loadConfig();
  if (!cfg.apiId || !cfg.apiHash) { console.error('Fill TG_API_ID and TG_API_HASH in .env first (from https://my.telegram.org).'); process.exit(1); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => rl.question(q);
  const client = new TelegramClient(new StringSession(''), cfg.apiId, cfg.apiHash, { connectionRetries: 5 });
  client.setLogLevel('error');
  await client.start({
    phoneNumber: () => ask('Phone number with country code (e.g. +9198xxxxxxx): '),
    phoneCode: () => ask('Login code Telegram sent you (check the Telegram app): '),
    password: () => ask('2-Step Verification password (just press Enter if none): '),
    onError: err => console.error('Error:', err.message),
  });
  const session = client.session.save();
  fs.mkdirSync(path.dirname(cfg.sessionFile), { recursive: true });
  fs.writeFileSync(cfg.sessionFile, session, { mode: 0o600 });
  const me = await client.getMe();
  console.log(`\nLogged in as ${me.firstName || ''} (@${me.username || me.id}).`);
  console.log(`Session saved to ${cfg.sessionFile} (keep this file secret: it is like a password).`);
  console.log('Now run: node tools/channel-id.js   (to see your channel id)   then: npm start');
  rl.close();
  await client.disconnect();
  process.exit(0);
})().catch(err => { console.error('Login failed:', err.message); process.exit(1); });
