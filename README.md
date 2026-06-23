# Cozy Aux Prototype

A rough technical proof for private synchronized YouTube listening/watch rooms.

## What works

- Username/password accounts with cached browser sessions.
- Create/join rooms with a 6-character code.
- 2-3 participants per room.
- Server-sent room updates.
- Everyone can play/pause.
- Only the current aux holder can load links, seek, and pass aux.
- Shared YouTube and YouTube Music links.
- Cloudflare R2 uploads with progress and saved-media picker for local audio/video files.
- In-room YouTube search.
- Embedded YouTube player sync.
- Native uploaded-file player sync.
- YouTube title/thumbnail lookup.
- Room code and invite copying.
- Video and audio-focus display modes.
- Room chat.
- Invite-link join flow.
- Friends list and an inbox dropdown for room invites.
- Persisted active rooms, chat, playback, participants, and aux holder.
- Room owners can end rooms so they stop appearing as active.
- Online/offline presence.

## Run

```bash
npm start
```

Open `http://127.0.0.1:3000`.

## Deploy

Use a Node web-service host, not static hosting. This app needs the Node server for
rooms, chat, commands, and WebSockets.

Recommended starter deploy:

- Render Web Service
- Build command: `npm install`
- Start command: `npm start`
- Environment variable: `HOST=0.0.0.0`
- Shared Cloudflare environment variable:
  - `CLOUDFLARE_ACCOUNT_ID=<your Cloudflare account ID>`
- Optional environment variables for Cloudflare R2 uploads:
  - `R2_ACCESS_KEY_ID=<your R2 access key ID>`
  - `R2_SECRET_ACCESS_KEY=<your R2 secret access key>`
  - `R2_BUCKET=cozy-aux-media`
  - `R2_PUBLIC_BASE_URL=<your public bucket URL or custom domain>`
  - `MEDIA_LIBRARY=<optional JSON or comma-separated public media URLs>`
  - `MAX_UPLOAD_BYTES=3221225472`
- Optional environment variable for in-room search: `YOUTUBE_API_KEY=<your YouTube Data API key>`
- Optional environment variable for localized search: `YOUTUBE_REGION_CODE=US`
- Optional environment variables for Cloudflare D1 account storage:
  - `CLOUDFLARE_D1_DATABASE_ID=<your D1 database ID>`
  - `CLOUDFLARE_D1_API_TOKEN=<API token with D1 edit/query access>`

By default, the prototype stores rooms in `data/cozy-aux-db.json`. Accounts,
friends, sessions, and room invites use Cloudflare D1 when the D1 environment
variables are set; otherwise they fall back to the JSON file for local testing.
Render's filesystem can be reset by redeploys or instance replacement, so use D1
before testing accounts with friends.

`R2_ACCOUNT_ID` can still be set as an override, but if it is missing Cozy Aux
uses `CLOUDFLARE_ACCOUNT_ID` for R2 too.

Static hosts like GitHub Pages, Tiiny Host, and S3 will serve the HTML/CSS/JS, but
the room API and WebSocket routes will not work.

## Links

Paste a normal YouTube URL, YouTube Music URL, short `youtu.be` URL, embed URL, shorts URL,
or a raw 11-character YouTube video ID.

## YouTube Search

In-room search uses the official YouTube Data API. Create an API key in Google
Cloud, enable YouTube Data API v3, and set `YOUTUBE_API_KEY` on the server. If
the key is missing, paste-link loading still works.

## Accounts And D1

Create a Cloudflare D1 database and a Cloudflare API token that can query/edit
that D1 database. Set the D1 environment variables above on Render, then redeploy.
Cozy Aux creates the required tables on startup.

Passwords are stored as salted hashes. The browser stores only the session token
in `localStorage`, so users stay logged in until that token is cleared.

Room records are still stored in the local JSON prototype database for now; D1 is
used for users, sessions, friendships, and friend room invites.

## Cloudflare R2 Saved Media

Create a Cloudflare R2 bucket, for example `cozy-aux-media`, and enable public
access through an `r2.dev` public URL or a custom domain. Create an R2 API token
with object read/list access for that bucket, then set the R2 environment
variables above on Render.

Cozy Aux talks to R2 through the official AWS S3 SDK using R2's S3-compatible
API. The SDK handles bucket listing and presigned upload URLs.

For testing, upload media files to the R2 bucket from the Cloudflare dashboard.
Cozy Aux lists existing playable files from the bucket and lets the aux holder
pick one in the room. Supported formats are MP3, M4A, WAV, OGG, MP4, and WebM.

If bucket listing is not available, set `MEDIA_LIBRARY` on Render instead. The
simplest format is one public file URL per line:

```text
https://pub-example.r2.dev/movie.mp4
https://pub-example.r2.dev/song.mp3
```

For nicer titles, use JSON:

```json
[
  { "title": "Movie Night Test", "url": "https://pub-example.r2.dev/movie.mp4", "mediaType": "video" },
  { "title": "Study Mix", "url": "https://pub-example.r2.dev/song.mp3", "mediaType": "audio" }
]
```

Add CORS to the R2 bucket so browsers can upload and play media from your app:

```json
[
  {
    "AllowedOrigins": ["http://127.0.0.1:3000", "https://your-render-app.onrender.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3000
  }
]
```

## Prototype limits

- Room persistence is still a JSON prototype layer.
- Sync uses authoritative room timestamps and player commands, but there is no advanced drift smoothing yet.
- No queue, notifications, or real mobile app yet.
