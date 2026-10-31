# media-relay

A small Node.js server that streams video files from a Telegram channel over HTTP.

- HTTP Range requests (seek / skip forward works in any player)
- 1 MB chunk cache on disk with LRU eviction (`CACHE_DIR`, `CACHE_MAX_GB`)
- The app authenticates with an app key (`X-App-Key`), users with a Firebase ID token; media is served via short-lived HMAC signed URLs
- Per-IP rate limit
- Works with a normal Telegram user account (session string); a bot token is an optional fallback

## Endpoints

| Path | What |
| --- | --- |
| `GET /health` | status, including `telegram`: `connected`, `connecting`, `not configured` or `error: ...` |
| `GET /api/videos` | list of videos (auth). Each item: `msgId, title, caption, duration, size, width, height, mime, date, hasThumb` plus absolute signed `streamUrl` / `thumbUrl` valid 6 h. Optional `?q=` filters by caption text |
| `GET /api/videos/:msgId` | one video, same shape (auth) |
| `GET /api/sign?msgId=N` | signed stream URL for one video (auth) |
| `GET /stream/:msgId` | the video, with Range support (auth or signed URL) |
| `GET /thumb/:msgId` | thumbnail (auth or signed URL) |
| `POST /api/push` | send a push notification to an FCM topic (admins only, see below) |

Auth on `/api/*`: header `X-App-Key: <APP_KEY>` (or `?k=`), or `Authorization: Bearer <Firebase ID token>` (or `?token=`).
`/stream` and `/thumb` need a signed URL (or one of those headers); the bare URL is not downloadable.

## Settings (environment variables)

| Name | Meaning |
| --- | --- |
| `TG_API_ID`, `TG_API_HASH` | from https://my.telegram.org |
| `TG_SESSION` | session string of the Telegram account. Telethon/GramJS StringSession (starts with `1`) or a Pyrogram session string (converted automatically). Empty = server boots without Telegram. |
| `CHANNEL_ID` or `CHANNEL_TITLE` | the channel: numeric id (`-100...`) or its exact title (resolved at startup; the id is logged) |
| `FIREBASE_PROJECT_ID` | Firebase project whose ID tokens are accepted |
| `SIGNING_SECRET` | random string, 32+ characters, for signed URLs |
| `APP_KEY` | optional: shared key the app sends as `X-App-Key` to use the API without a user login |
| `PUBLIC_BASE_URL` | optional: base for signed links (default: the request's host, https behind a proxy) |
| `CACHE_DIR` | default `/tmp/cache` |
| `CACHE_MAX_GB` | default `1` |
| `PORT` | default `8080` (Render sets it) |
| `RATE_LIMIT_PER_MIN` | default `600` per IP |
| `FCM_SERVICE_ACCOUNT` | push: the Firebase service-account key JSON (or base64 of it). Unset = `/api/push` answers 503 `push_not_configured` |
| `OWNER_EMAIL` | push: this signed-in email is always allowed to send |
| `ADMIN_ORIGINS` | push: comma list of browser origins allowed to call `/api/push` (CORS) |
| `PUSH_CHANNEL_ID` | push: Android notification channel id set on each message |
| `PUSH_RATE_PER_MIN` | push: sends per user per minute, default `20` |

The account must be a member of the channel. Keep `TG_SESSION` secret: it gives full access to the account.

## Push notifications

`POST /api/push` with `Authorization: Bearer <Firebase ID token>` and a JSON body:

```
{ "title": "max 100 chars", "body": "max 500 chars", "topic": "all" | "class_1" ... "class_12",
  "data": { "open": "..." },            // optional, string values only
  "image": "https://..." }               // optional
```

The caller must be an admin: their email equals `OWNER_EMAIL`, or the Firestore document `admins/{email}` exists.
The server reads Firestore and sends through FCM HTTP v1 with OAuth tokens minted from `FCM_SERVICE_ACCOUNT`
(scopes `firebase.messaging` and `datastore`, cached ~50 min). Android priority is high.
Answers `{ "ok": true, "messageId": "projects/.../messages/..." }` or `{ "ok": false, "error": "..." }`
(401 `login_required`, 403 `not_admin`, 400 validation, 429 rate limit, 503 `push_not_configured`, 502 FCM error).

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
