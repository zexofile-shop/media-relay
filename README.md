# media-relay

A small Node.js server that streams video files from a Telegram channel over HTTP.

- HTTP Range requests (seek / skip forward works in any player)
- 1 MB chunk cache on disk with LRU eviction (`CACHE_DIR`, `CACHE_MAX_GB`)
- Users authenticate with a Firebase ID token, or use short-lived HMAC signed URLs
- Per-IP rate limit
- Works with a normal Telegram user account (session string); a bot token is an optional fallback

## Endpoints

| Path | What |
| --- | --- |
| `GET /health` | status, including `telegram`: `connected`, `connecting`, `not configured` or `error: ...` |
| `GET /api/videos` | list of videos in the channel (auth) |
| `GET /api/sign?msgId=N` | signed stream URL for one video (auth) |
| `GET /stream/:msgId` | the video, with Range support (auth or signed URL) |
| `GET /thumb/:msgId` | thumbnail (auth or signed URL) |

Auth: `Authorization: Bearer <Firebase ID token>` (or `?token=`).

## Settings (environment variables)

| Name | Meaning |
| --- | --- |
| `TG_API_ID`, `TG_API_HASH` | from https://my.telegram.org |
| `TG_SESSION` | session string of the Telegram account. Telethon/GramJS StringSession (starts with `1`) or a Pyrogram session string (converted automatically). Empty = server boots without Telegram. |
| `CHANNEL_ID` or `CHANNEL_TITLE` | the channel: numeric id (`-100...`) or its exact title (resolved at startup; the id is logged) |
| `FIREBASE_PROJECT_ID` | Firebase project whose ID tokens are accepted |
| `SIGNING_SECRET` | random string, 32+ characters, for signed URLs |
| `CACHE_DIR` | default `/tmp/cache` |
| `CACHE_MAX_GB` | default `1` |
| `PORT` | default `8080` (Render sets it) |
| `RATE_LIMIT_PER_MIN` | default `600` per IP |

The account must be a member of the channel. Keep `TG_SESSION` secret: it gives full access to the account.

## Deploy on Render

`render.yaml` describes a free web service. Or: New > Web Service > this repo, build `npm install`, start `node server.js`, health check `/health`, then set the variables above under Environment. After saving `TG_SESSION`, the service restarts and `/health` should show `"telegram":"connected"`.

Free instances sleep after ~15 minutes without traffic, and the cache in `/tmp` is cleared on restart.

## Local

```
npm install
cp .env.example .env    # fill it in
node server.js
```

Tests: `npm run make-sample` (needs ffmpeg), then `npm test`.

`node login.js` creates a session interactively (phone + code) if you do not have one.
