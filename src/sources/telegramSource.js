'use strict';
// Real Telegram source over MTProto (GramJS). Works as a BOT (bot is admin of the private
// channel) or as a USER account (StringSession made once with `node login.js`).
// Interface (same as the mock): start(), list(), getMeta(msgId), getChunk(msgId, idx, meta), getThumb(msgId)

const fs = require('fs');
const path = require('path');
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { normalizeSession } = require('../sessionString');

const CHUNK_SIZE = 1024 * 1024;

function rawChannelId(channelId) {
  // Accept -1001234567890, 1234567890 or "-100…" strings.
  const s = String(channelId).trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`CHANNEL_ID must be a number like -1001234567890 (got "${s}")`);
  return s.startsWith('-100') ? s.slice(4) : s.replace(/^-/, '');
}

function messageToMeta(msg) {
  if (!msg || msg.className === 'MessageEmpty' || !msg.media) return null;
  const doc = msg.media.document;
  if (!doc || doc.className !== 'Document') return null;
  const attrs = doc.attributes || [];
  const video = attrs.find(a => a.className === 'DocumentAttributeVideo');
  const fname = attrs.find(a => a.className === 'DocumentAttributeFilename');
  const mime = doc.mimeType || 'application/octet-stream';
  if (!mime.startsWith('video/') && !video) return null;
  const text = (msg.message || '').trim();
  const fileName = fname ? fname.fileName : null;
  const title = (text.split('\n')[0] || '').slice(0, 200) || (fileName ? fileName.replace(/\.[^.]+$/, '') : `Lecture ${msg.id}`);
  const thumbs = (doc.thumbs || []).filter(t => t.className === 'PhotoSize' || t.className === 'PhotoSizeProgressive');
  return {
    msgId: msg.id,
    docId: doc.id.toString(),
    size: Number(doc.size.toString()),
    mime: mime.startsWith('video/') ? mime : 'video/mp4',
    duration: video ? Number(video.duration) : null,
    width: video ? video.w : null,
    height: video ? video.h : null,
    supportsStreaming: video ? !!video.supportsStreaming : false,
    title, caption: text, fileName,
    hasThumb: thumbs.length > 0,
    date: msg.date || null,
  };
}

class TelegramSource {
  constructor({ apiId, apiHash, botToken, session, sessionFile, channelId, channelTitle, partSize = 512 * 1024, log, client, scanEmptyBatches = 3, scanMaxId = 20000 }) {
    if (!client) {
      if (!apiId || !apiHash) throw new Error('TG_API_ID and TG_API_HASH are required (get them at https://my.telegram.org)');
      if (!channelId && !channelTitle) throw new Error('CHANNEL_ID or CHANNEL_TITLE is required');
    }
    this.channelTitle = channelTitle || '';
    this.apiId = Number(apiId); this.apiHash = apiHash; this.botToken = botToken;
    this.sessionFile = sessionFile;
    const rawSession = session || (sessionFile && fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8').trim() : '');
    const norm = normalizeSession(rawSession); // auto-detects Telethon/GramJS or Pyrogram strings
    this.session = norm.session;
    this.sessionFormat = norm.format;
    this.channelId = channelId;
    this.partSize = partSize;
    this.log = log || console;
    this.client = client || null;
    this.isBot = !!botToken;
    this.msgCache = new Map(); // msgId -> { msg, at }
    this.maxSeenId = 0;
    this.scanEmptyBatches = scanEmptyBatches;
    this.scanMaxId = scanMaxId;
    this.onNewPost = null;
  }

  get mode() { return this.isBot ? 'telegram-bot' : 'telegram-user'; }
  get connected() { return !!(this.client && this.client.connected); }

  async start() {
    if (!this.client) {
      this.client = new TelegramClient(new StringSession(this.session), this.apiId, this.apiHash, {
        connectionRetries: 1000000, // keep trying forever on network loss
        retryDelay: 2000,
        autoReconnect: true,
        floodSleepThreshold: 120, // GramJS sleeps by itself for FLOOD_WAIT up to 120 s
        requestRetries: 5,
        useWSS: false,
      });
      this.client.setLogLevel(process.env.GRAMJS_LOG || 'error');
    }
    if (this.isBot) {
      await this.client.start({ botAuthToken: this.botToken });
    } else {
      await this.client.connect();
      if (!(await this.client.checkAuthorization())) {
        throw new Error('Telegram USER session is missing or expired. Run: node login.js');
      }
    }
    this._saveSession();
    const me = await this.client.getMe();
    if (!this.isBot) this.log.info(`telegram: session format ${this.sessionFormat}`);
    this.log.info(`telegram: logged in as ${this.isBot ? 'bot' : 'user'} @${me.username || me.firstName || me.id}`);
    await this._resolveChannel();
    this.client.addEventHandler(ev => {
      const m = ev.message;
      if (m && m.id > this.maxSeenId) this.maxSeenId = m.id;
      if (this.onNewPost && messageToMeta(m)) this.onNewPost(m.id);
    }, new NewMessage({}));
  }

  _saveSession() {
    // Saving the session avoids logging in again on every restart (repeated bot logins cause FLOOD_WAIT).
    try {
      const s = this.client.session.save();
      if (s && this.sessionFile) {
        fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
        fs.writeFileSync(this.sessionFile, s, { mode: 0o600 });
      }
    } catch (err) { this.log.warn(`could not save Telegram session: ${err.message}`); }
  }

  async reconnect() {
    try {
      if (this.client && !this.client.connected) { this.log.warn('telegram: reconnecting'); await this.client.connect(); }
    } catch (err) { this.log.warn(`telegram reconnect failed: ${err.message}`); }
  }

  async _resolveChannel() {
    let chat;
    if (!this.channelId && this.channelTitle) {
      if (this.isBot) throw new Error('Bots cannot search dialogs: set CHANNEL_ID (-100...) instead of CHANNEL_TITLE');
      const dialogs = await this.client.getDialogs({ limit: 1000 });
      const want = this.channelTitle.trim();
      const hits = dialogs.filter(d => d.entity && d.entity.className === 'Channel' && (d.entity.title || '').trim() === want);
      if (!hits.length) throw new Error('No channel with exactly that CHANNEL_TITLE in this account\'s chats');
      if (hits.length > 1) this.log.warn(`telegram: ${hits.length} channels share that title; using the first. Set CHANNEL_ID to pick one.`);
      chat = hits[0].entity;
      this.channelId = `-100${chat.id.toString()}`;
      this.log.info(`telegram: CHANNEL_TITLE resolved to CHANNEL_ID=${this.channelId}`);
      this.inputChannel = new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash || bigInt.zero });
      this.log.info('telegram: channel ready');
      return;
    }
    const raw = rawChannelId(this.channelId);
    if (this.isBot) {
      // Bots may use access_hash 0 for channels they are a member of.
      const res = await this.client.invoke(new Api.channels.GetChannels({
        id: [new Api.InputChannel({ channelId: bigInt(raw), accessHash: bigInt.zero })],
      }));
      chat = res.chats[0];
    } else {
      try { chat = await this.client.getEntity(bigInt(`-100${raw}`)); }
      catch (_) {
        await this.client.getDialogs({ limit: 500 }); // fills the entity cache
        chat = await this.client.getEntity(bigInt(`-100${raw}`));
      }
    }
    if (!chat || chat.className === 'ChannelForbidden') throw new Error('Cannot open the channel. Is the bot/account an admin/member of it, and is CHANNEL_ID right?');
    this.inputChannel = new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash || bigInt.zero });
    this.log.info(`telegram: channel ${this.channelId} ready`);
  }

  async _getMessages(ids) {
    const res = await this.client.invoke(new Api.channels.GetMessages({
      channel: this.inputChannel,
      id: ids.map(id => new Api.InputMessageID({ id })),
    }));
    return res.messages || [];
  }

  async _getMessage(msgId, fresh = false) {
    const c = this.msgCache.get(msgId);
    if (!fresh && c && Date.now() - c.at < 30 * 60 * 1000) return c.msg;
    const [msg] = await this._getMessages([msgId]);
    if (!msg || msg.className === 'MessageEmpty') { this.msgCache.delete(msgId); return null; }
    this.msgCache.set(msgId, { msg, at: Date.now() });
    return msg;
  }

  async getMeta(msgId) {
    return messageToMeta(await this._getMessage(msgId));
  }

  async list() {
    const metas = [];
    if (!this.isBot) {
      // Users can read channel history directly.
      for await (const msg of this.client.iterMessages(this.inputChannel, { limit: 5000 })) {
        const meta = messageToMeta(msg);
        if (meta) { metas.push(meta); this.msgCache.set(msg.id, { msg, at: Date.now() }); }
        if (msg.id > this.maxSeenId) this.maxSeenId = msg.id;
      }
    } else {
      // Bots cannot read history; they CAN fetch messages by id. Scan ids in batches of 100
      // until several batches in a row are empty (and we are past the newest post we have seen).
      let empty = 0;
      for (let start = 1; start <= this.scanMaxId; start += 100) {
        const ids = Array.from({ length: 100 }, (_, i) => start + i);
        const msgs = await this._getMessages(ids);
        let any = false;
        for (const msg of msgs) {
          if (!msg || msg.className === 'MessageEmpty') continue;
          any = true;
          if (msg.id > this.maxSeenId) this.maxSeenId = msg.id;
          const meta = messageToMeta(msg);
          if (meta) { metas.push(meta); this.msgCache.set(msg.id, { msg, at: Date.now() }); }
        }
        empty = any ? 0 : empty + 1;
        if (empty >= this.scanEmptyBatches && start + 100 > this.maxSeenId) break;
      }
    }
    metas.sort((a, b) => a.msgId - b.msgId);
    return metas;
  }

  _location(doc, thumbSize = '') {
    return new Api.InputDocumentFileLocation({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize });
  }

  async _getFile(location, dcId, offset, limit) {
    let dc = dcId;
    for (let hop = 0; hop < 3; hop++) {
      try {
        const req = new Api.upload.GetFile({ location, offset: bigInt(offset), limit, precise: false, cdnSupported: false });
        const homeDc = this.client.session.dcId;
        const res = (!dc || dc === homeDc)
          ? await this.client.invoke(req)
          : await this.client.invokeWithSender(req, await this.client.getSender(dc));
        if (res.className === 'upload.FileCdnRedirect') throw new Error('Telegram sent a CDN redirect (not supported)');
        return res.bytes;
      } catch (err) {
        const m = /FILE_MIGRATE_(\d+)/.exec(err.errorMessage || err.message || '');
        if (err.newDc || m) { dc = err.newDc || Number(m[1]); continue; }
        throw err;
      }
    }
    throw new Error('FILE_MIGRATE loop');
  }

  async _withFreshRef(msgId, fn) {
    let msg = await this._getMessage(msgId);
    if (!msg) throw Object.assign(new Error(`message ${msgId} not found`), { status: 404 });
    try { return await fn(msg.media.document); }
    catch (err) {
      if (/FILE_REFERENCE_/.test(err.errorMessage || err.message || '')) {
        msg = await this._getMessage(msgId, true); // file references expire; get a new one
        if (!msg) throw Object.assign(new Error(`message ${msgId} not found`), { status: 404 });
        return fn(msg.media.document);
      }
      throw err;
    }
  }

  /** Bytes [idx*1MB, idx*1MB+1MB). Offsets stay 1 MB aligned; parts are 512 KB (1 MB % part == 0). */
  async getChunk(msgId, idx, meta) {
    return this._withFreshRef(msgId, async doc => {
      const size = Number(doc.size.toString());
      const start = idx * CHUNK_SIZE;
      const want = Math.min(CHUNK_SIZE, size - start);
      if (want <= 0) return Buffer.alloc(0);
      const parts = [];
      for (let off = start; off < start + want; off += this.partSize) {
        parts.push(this._getFile(this._location(doc), doc.dcId, off, this.partSize));
      }
      const bufs = await Promise.all(parts);
      return Buffer.concat(bufs).subarray(0, want);
    });
  }

  async getThumb(msgId) {
    return this._withFreshRef(msgId, async doc => {
      const thumbs = (doc.thumbs || []).filter(t => t.className === 'PhotoSize' || t.className === 'PhotoSizeProgressive');
      if (!thumbs.length) return null;
      const best = thumbs.reduce((a, b) => ((b.w * b.h) > (a.w * a.h) ? b : a));
      return this._getFile(this._location(doc, best.type), doc.dcId, 0, 512 * 1024);
    });
  }

  async stop() { try { await this.client.disconnect(); } catch (_) {} }
}

module.exports = { TelegramSource, messageToMeta, rawChannelId };
