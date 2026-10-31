'use strict';
// Find your private channel's CHANNEL_ID.
//  USER mode: prints every channel your account is in, with its id.
//  BOT mode : waits; post anything in the channel (bot must be admin) and the id is printed.
// Usage: node tools/channel-id.js
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { loadConfig } = require('../src/config');

(async () => {
  const cfg = loadConfig();
  const sessionFile = cfg.botToken ? path.join(cfg.dataDir, 'bot_session.txt') : cfg.sessionFile;
  const saved = cfg.tgSession || (fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8').trim() : '');
  const client = new TelegramClient(new StringSession(saved), cfg.apiId, cfg.apiHash, { connectionRetries: 5 });
  client.setLogLevel('error');
  if (cfg.botToken) {
    await client.start({ botAuthToken: cfg.botToken });
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, client.session.save(), { mode: 0o600 });
    console.log('Bot connected. Now post any message in your private channel (the bot must be an admin there)...');
    client.addEventHandler(ev => {
      const peer = ev.message.peerId;
      if (peer && peer.className === 'PeerChannel') {
        console.log(`\nCHANNEL_ID=-100${peer.channelId.toString()}\n(put this line in .env, then press Ctrl+C)`);
      }
    }, new NewMessage({}));
  } else {
    await client.connect();
    if (!(await client.checkAuthorization())) { console.error('Not logged in. Run: node login.js'); process.exit(1); }
    const dialogs = await client.getDialogs({ limit: 300 });
    console.log('Your channels:');
    for (const d of dialogs) if (d.isChannel && !d.isGroup) console.log(`  CHANNEL_ID=-100${d.entity.id.toString()}   ${d.title}`);
    await client.disconnect();
    process.exit(0);
  }
})().catch(err => { console.error(err.message); process.exit(1); });
