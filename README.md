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
| `GET /api/upload/config` | public: whether uploads are set up (503 `upload_not_configured` if not), size limit, chunk size |
| `POST /api/upload/start` … | admin uploads into GitHub release assets (see below) |

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
| `GITHUB_UPLOAD_TOKEN` | uploads: fine-grained GitHub token limited to `UPLOAD_REPO`, Contents read/write (+ Actions read/write for quality copies). Unset = uploads answer 503 `upload_not_configured` |
| `UPLOAD_REPO` | uploads: `owner/name` of the repo whose releases hold the files |
| `UPLOAD_RELEASE_PDF`, `UPLOAD_RELEASE_VIDEO` | uploads: release tags for PDFs and MP4 videos (created if missing) |
| `UPLOAD_QUALITY_WORKFLOW` | uploads, optional: workflow file in `UPLOAD_REPO` (see `tools/video-qualities.yml`) that makes 720p/480p/360p copies |
| `UPLOAD_WORKFLOW_REF` | uploads, optional: branch the workflow runs on, default `main` |
| `UPLOAD_RELEASE_PARTS` | uploads, optional: release tag for the temporary parts of big uploads, default `upload-parts` |

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

## Member room pushes

`POST /api/room-push` with `Authorization: Bearer <Firebase ID token>` and `{ "room": "<roomId>", "msg": "<messageId>" }`,
sent by the app right after a member's message is saved. The server re-reads the message with the service account
(`ROOM_PUSH_MSG_PATH`, default `batches/{room}/chat/{msg}`): it must exist, belong to the caller and be under 3 minutes old.
The switch `ROOM_PUSH_SWITCH` (default `chatPushEnabled`) in `ROOM_PUSH_CONFIG_DOC` (default `app_config/community`) must
not be `false` (cached 60 s). Then ONE data-only FCM message goes to topic `ROOM_PUSH_TOPIC_PREFIX + room`
(default `chat_<room>`) with `android.collapse_key` per room and high priority; data keys: `kind=chat, room, msg, uid,
name, text (max 80), title (room title from ROOM_PUSH_ROOM_DOC / ROOM_PUSH_TITLE_FIELD, cached 10 min), body, open, at`.
The app draws the notification itself (skips its own uid, muted rooms and the room on screen).
Limits: `ROOM_PUSH_RATE_PER_MIN` per user (default 6), one push per room per 2 s, each message once.
Answers 200 `{ok:true, messageId}` or `{ok:true, skipped: "off"|"duplicate"|"room_busy"}`; 401 `login_required`
(also blocked accounts), 400 `bad_request`, 404 `not_found` (missing or someone else's message), 409 `too_old`,
429, 502 `read_failed`/FCM error, 503 `push_not_configured` (no `FCM_SERVICE_ACCOUNT`).

## Uploads (admins)

Signed-in staff (`OWNER_EMAIL`, or a Firestore `admins/{email}` document — read with the service account when
`FCM_SERVICE_ACCOUNT` is set, otherwise with the caller's own ID token and `FIREBASE_PROJECT_ID`) can upload a PDF or an
MP4 straight into a GitHub release asset. Bytes are piped to `uploads.github.com` as they arrive: nothing is written to
disk and memory stays at one chunk, whatever the file size (limit just under 2 GiB, GitHub's per-asset limit).

Resumable, for phones on flaky networks:

```
POST   /api/upload/start   {kind:"pdf"|"video", name, size, type}   -> {id, name, chunkSize, url}
PUT    /api/upload/chunk?id=..&offset=N   (raw bytes, at most chunkSize)  -> {received} ... last one: {done:true, url, name, size}
GET    /api/upload/status?id=..        -> {received, done, url?}   (after a dropped connection: resume from `received`)
DELETE /api/upload/session?id=..       cancel
```

A wrong offset answers 409 with `received`.

Two modes, chosen by size (`mode` in the start answer):
- `stream` (files up to 32 MB, or when no workflow is set): one upstream request to GitHub stays open across the chunks.
  GitHub drops an upload connection that sits idle for a short while, so a long network stall fails the upload (410)
  and it starts again from zero.
- `parts` (bigger files; needs `UPLOAD_QUALITY_WORKFLOW` and Actions permission): each chunk (16 MB, sent with its exact
  length) is its own small asset `up-<id>.0000.part` on the release `UPLOAD_RELEASE_PARTS` (default `upload-parts`).
  A failed part is just sent again (503 `part_retry`), and a stall costs nothing. After the last part the workflow joins
  the parts into the final asset, checks the size and deletes the parts; the last chunk answers `assembling: true` and
  `/api/upload/status` turns `done` with the `url` once the joined file is on the release (about a minute or two).
One-shot alternative: `POST /api/upload?kind=pdf&name=x` with the whole file as the body (`curl --data-binary @x.pdf`).

Names are made safe (`A-Z a-z 0-9 . _ -`); a name already on the release gets `-2`, `-3`… The first bytes are checked
(`%PDF-` / MP4 `ftyp`). The answer's `url` is the asset's public `browser_download_url`.

Quality copies (optional): put `tools/video-qualities.yml` into `UPLOAD_REPO` as `.github/workflows/<file>` and set
`UPLOAD_QUALITY_WORKFLOW=<file>`. `POST /api/upload/qualities {name}` starts it for an uploaded video (needs Actions
read/write on the token); `GET /api/upload/qualities?name=` answers `{status: not_started|running|ready|partial|failed, urls}`.
The copies are `<name>_720p.mp4`, `_480p.mp4`, `_360p.mp4` on the same release.

Import (zero bytes through this server): `POST /api/upload/import {url, name?}` hands a direct https MP4 link to the
workflow, which downloads it inside GitHub Actions, puts it on the video release and makes the quality copies.
`GET /api/upload/import?name=` answers like the qualities status, with `original` set once the file is on the release.

Bandwidth: every byte uploaded through this server leaves it once (to GitHub) and counts as outbound bandwidth on the
host. Import does not.

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
