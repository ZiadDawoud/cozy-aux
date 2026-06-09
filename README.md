# Cozy Aux Prototype

A rough technical proof for private synchronized YouTube listening/watch rooms.

## What works

- Anonymous create/join rooms with a 6-character code.
- 2-3 participants per room.
- Server-sent room updates.
- Everyone can play/pause.
- Only the current aux holder can load links, seek, and pass aux.
- Shared YouTube and YouTube Music links.
- Embedded YouTube player sync.
- YouTube title/thumbnail lookup.
- Room code and invite copying.
- Video and audio-focus display modes.
- Room chat.
- Invite-link join flow.
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

Static hosts like GitHub Pages, Tiiny Host, and S3 will serve the HTML/CSS/JS, but
the room API and WebSocket routes will not work.

## Links

Paste a normal YouTube URL, YouTube Music URL, short `youtu.be` URL, embed URL, shorts URL,
or a raw 11-character YouTube video ID.

## Prototype limits

- Room state is in memory, so restarting the server clears everything.
- Sync uses authoritative room timestamps and YouTube player commands, but there is no advanced drift smoothing yet.
- No accounts, profiles, queue, or chat yet.
