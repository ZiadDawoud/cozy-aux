# Cozy Aux Prototype

A rough technical proof for private synchronized YouTube listening/watch rooms.

## What works

- Simple browser-saved profiles with handles and friend codes.
- Create/join rooms with a 6-character code.
- 2-3 participants per room.
- Server-sent room updates.
- Everyone can play/pause.
- Only the current aux holder can load links, seek, and pass aux.
- Shared YouTube and YouTube Music links.
- Cloudflare R2 saved-media picker for local audio/video files.
- In-room YouTube search.
- Embedded YouTube player sync.
- Native uploaded-file player sync.
- YouTube title/thumbnail lookup.
- Room code and invite copying.
- Video and audio-focus display modes.
- Room chat.
- Invite-link join flow.
- Friends list and room invites.
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
- Optional environment variables for Cloudflare R2 uploads:
  - `R2_ACCOUNT_ID=<your Cloudflare account ID>`
  - `R2_ACCESS_KEY_ID=<your R2 access key ID>`
  - `R2_SECRET_ACCESS_KEY=<your R2 secret access key>`
  - `R2_BUCKET=cozy-aux-media`
  - `R2_PUBLIC_BASE_URL=<your public bucket URL or custom domain>`
  - `MAX_UPLOAD_BYTES=3221225472`
- Optional environment variable for in-room search: `YOUTUBE_API_KEY=<your YouTube Data API key>`
- Optional environment variable for localized search: `YOUTUBE_REGION_CODE=US`

By default, the prototype stores data in `data/cozy-aux-db.json`. For a Render
starter test, that is enough to verify the product flow, but Render's filesystem
can be reset by redeploys or instance replacement. Before real users, replace the
JSON store with Postgres or another managed database.

Static hosts like GitHub Pages, Tiiny Host, and S3 will serve the HTML/CSS/JS, but
the room API and WebSocket routes will not work.

## Links

Paste a normal YouTube URL, YouTube Music URL, short `youtu.be` URL, embed URL, shorts URL,
or a raw 11-character YouTube video ID.

## YouTube Search

In-room search uses the official YouTube Data API. Create an API key in Google
Cloud, enable YouTube Data API v3, and set `YOUTUBE_API_KEY` on the server. If
the key is missing, paste-link loading still works.

## Cloudflare R2 Saved Media

Create a Cloudflare R2 bucket, for example `cozy-aux-media`, and enable public
access through an `r2.dev` public URL or a custom domain. Create an R2 API token
with object read/list access for that bucket, then set the R2 environment
variables above on Render.

For testing, upload media files to the R2 bucket from the Cloudflare dashboard.
Cozy Aux lists existing playable files from the bucket and lets the aux holder
pick one in the room. Supported formats are MP3, M4A, WAV, OGG, MP4, and WebM.

Add CORS to the R2 bucket so browsers can play media from your app:

```json
[
  {
    "AllowedOrigins": ["http://127.0.0.1:3000", "https://your-render-app.onrender.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3000
  }
]
```

## Prototype limits

- Accounts are passwordless browser profiles using a saved token.
- The JSON database is a prototype persistence layer, not a production database.
- Sync uses authoritative room timestamps and player commands, but there is no advanced drift smoothing yet.
- No queue, notifications, or real mobile app yet.
