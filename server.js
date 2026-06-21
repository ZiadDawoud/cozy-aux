import http from "node:http";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { db, loadDb, saveDb } from "./db.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`;
const youtubeApiKey = process.env.YOUTUBE_API_KEY || "";
const youtubeRegionCode = process.env.YOUTUBE_REGION_CODE || "US";
const r2AccountId = (process.env.R2_ACCOUNT_ID || "").trim();
const r2AccessKeyId = (process.env.R2_ACCESS_KEY_ID || "").trim();
const r2SecretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
const r2Bucket = (process.env.R2_BUCKET || "cozy-aux-media").trim();
const r2PublicBaseUrl = (process.env.R2_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 3 * 1024 * 1024 * 1024);

const rooms = new Map();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function makeRoomCode() {
  let code = "";
  do {
    code = randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code) || db().rooms.some((room) => room.code === code && !room.endedAt));
  return code;
}

function roomSnapshot(room) {
  return {
    code: room.code,
    ownerUserId: room.ownerUserId,
    createdAt: room.createdAt,
    endedAt: room.endedAt || null,
    auxHolderId: room.auxHolderId,
    participants: [...room.participants.values()],
    playback: room.playback,
    messages: room.messages
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    handle: user.handle,
    displayName: user.displayName,
    friendCode: user.friendCode,
    createdAt: user.createdAt
  };
}

function normalizeHandle(handle) {
  return String(handle || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

function makeFriendCode() {
  let code = "";
  do {
    code = randomBytes(3).toString("hex").toUpperCase();
  } while (db().users.some((user) => user.friendCode === code));
  return code;
}

function findUserByToken(req) {
  const token = req.headers["x-auth-token"];
  if (!token) return null;
  return db().users.find((user) => user.authToken === token) || null;
}

function requireUser(req, res) {
  const user = findUserByToken(req);
  if (!user) badRequest(res, "Create or sign in to a profile first.", 401);
  return user;
}

function areFriends(userId, friendId) {
  return db().friendships.some(
    (friendship) =>
      (friendship.userId === userId && friendship.friendId === friendId) ||
      (friendship.userId === friendId && friendship.friendId === userId)
  );
}

function userFriends(userId) {
  return db()
    .friendships.filter(
      (friendship) => friendship.userId === userId || friendship.friendId === userId
    )
    .map((friendship) =>
      publicUser(
        db().users.find((user) =>
          user.id === (friendship.userId === userId ? friendship.friendId : friendship.userId)
        )
      )
    )
    .filter(Boolean);
}

function invitedRoomSummaries(userId) {
  return db()
    .invites.filter((invite) => invite.toUserId === userId && !invite.dismissedAt)
    .map((invite) => {
      const room = db().rooms.find((savedRoom) => savedRoom.code === invite.roomCode);
      const from = db().users.find((user) => user.id === invite.fromUserId);
      if (!room || room.endedAt) return null;
      return {
        roomCode: room.code,
        invitedAt: invite.createdAt,
        from: publicUser(from)
      };
    })
    .filter(Boolean);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function badRequest(res, message, status = 400) {
  sendJson(res, status, { error: message });
}

function storageConfigured() {
  return Boolean(r2AccountId && r2AccessKeyId && r2SecretAccessKey && r2Bucket && r2PublicBaseUrl);
}

function r2HostName() {
  return `${r2AccountId}.r2.cloudflarestorage.com`;
}

function storageDebug() {
  let publicBaseHost = "";
  try {
    publicBaseHost = r2PublicBaseUrl ? new URL(r2PublicBaseUrl).host : "";
  } catch {
    publicBaseHost = "invalid-url";
  }
  return {
    configured: storageConfigured(),
    accountIdSet: Boolean(r2AccountId),
    accountIdLooksValid: /^[a-f0-9]{32}$/i.test(r2AccountId),
    accessKeyIdSet: Boolean(r2AccessKeyId),
    secretAccessKeySet: Boolean(r2SecretAccessKey),
    bucket: r2Bucket || null,
    publicBaseUrlSet: Boolean(r2PublicBaseUrl),
    publicBaseHost,
    r2ApiHost: r2AccountId ? r2HostName() : null
  };
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function signR2Request({ method, objectPath = "", queryParams = {}, signedHeaders, headers, expiresSec = 900 }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const hostName = r2HostName();
  const path = objectPath ? `/${objectPath.split("/").map(awsEncode).join("/")}` : "";
  const canonicalUri = `/${awsEncode(r2Bucket)}${path}`;
  const query = {
    ...queryParams,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${r2AccessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSec),
    "X-Amz-SignedHeaders": signedHeaders
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${awsEncode(key)}=${awsEncode(query[key])}`)
    .join("&");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}\n`)
    .join("");
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD"
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");
  const dateKey = hmac(`AWS4${r2SecretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  return `https://${hostName}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function signR2Upload({ objectPath, contentType, expiresSec = 900 }) {
  return signR2Request({
    method: "PUT",
    objectPath,
    signedHeaders: "content-type;host",
    headers: {
      "content-type": contentType,
      host: r2HostName()
    },
    expiresSec
  });
}

function uploadExtension(fileName, contentType) {
  const nameExtension = String(fileName || "").match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
  if (nameExtension) return nameExtension;
  if (contentType === "audio/mpeg") return ".mp3";
  if (contentType === "audio/mp4") return ".m4a";
  if (contentType === "video/mp4") return ".mp4";
  if (contentType === "video/webm") return ".webm";
  return "";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function mediaTypeForPath(path) {
  const extension = extname(path).toLowerCase();
  if ([".mp4", ".webm"].includes(extension)) return "video";
  if ([".mp3", ".m4a", ".wav", ".ogg"].includes(extension)) return "audio";
  return "";
}

function titleFromPath(path) {
  const fileName = path.split("/").pop() || "Saved media";
  let decoded = fileName;
  try {
    decoded = decodeURIComponent(fileName);
  } catch {
    decoded = fileName;
  }
  return decoded.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

async function listR2Media() {
  const listUrl = signR2Request({
    method: "GET",
    queryParams: { "list-type": "2", "max-keys": "100" },
    signedHeaders: "host",
    headers: {
      host: r2HostName()
    }
  });
  let response;
  try {
    response = await fetch(listUrl);
  } catch (error) {
    const detail = error.cause?.message || error.message || "network error";
    const next = new Error(`Could not reach Cloudflare R2 at ${r2HostName()}. Check R2_ACCOUNT_ID. Detail: ${detail}.`);
    next.status = 502;
    throw next;
  }
  const xml = await response.text();
  if (!response.ok) {
    const details = xml.match(/<Message>([\s\S]*?)<\/Message>/)?.[1] || xml.match(/<Code>([\s\S]*?)<\/Code>/)?.[1] || "";
    const error = new Error(
      `Could not load the R2 media library. R2 returned ${response.status}${details ? `: ${decodeXml(details)}` : ""}.`
    );
    error.status = response.status;
    throw error;
  }
  const publicBase = r2PublicBaseUrl;
  return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)]
    .map((match) => {
      const block = match[1];
      const path = decodeXml(block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] || "");
      const mediaType = mediaTypeForPath(path);
      if (!path || !mediaType) return null;
      const sizeBytes = Number(block.match(/<Size>(\d+)<\/Size>/)?.[1] || 0);
      return {
        provider: "r2",
        mediaType,
        path,
        url: `${publicBase}/${path.split("/").map(awsEncode).join("/")}`,
        title: titleFromPath(path),
        sourceLabel: mediaType === "video" ? "Saved video" : "Saved audio",
        fileName: path.split("/").pop() || path,
        sizeBytes,
        mimeType: mediaType === "video" ? "video/mp4" : "audio/mpeg",
        thumbnailUrl: ""
      };
    })
    .filter(Boolean);
}

function encodeWebSocketFrame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload]);
  }
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function acceptWebSocket(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n")
  );
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function broadcast(room, event, payload = roomSnapshot(room)) {
  const data = JSON.stringify(payload);
  const message = `event: ${event}\ndata: ${data}\n\n`;
  for (const client of room.clients) {
    try {
      client.write(message);
    } catch {
      room.clients.delete(client);
    }
  }
  const socketMessage = encodeWebSocketFrame(JSON.stringify({ event, data: payload }));
  for (const socket of room.sockets) {
    try {
      socket.write(socketMessage);
    } catch {
      room.sockets.delete(socket);
      socket.destroy();
    }
  }
}

function getRoom(code) {
  return rooms.get(String(code || "").toUpperCase());
}

function touchParticipant(room, participantId, patch = {}) {
  const existing = room.participants.get(participantId);
  if (!existing) return null;
  const updated = { ...existing, ...patch, lastSeenAt: Date.now() };
  room.participants.set(participantId, updated);
  return updated;
}

function persistRoom(room) {
  const snapshot = roomSnapshot(room);
  const index = db().rooms.findIndex((savedRoom) => savedRoom.code === room.code);
  if (index >= 0) db().rooms[index] = snapshot;
  else db().rooms.push(snapshot);
  return saveDb();
}

function runtimeRoomFromRecord(record) {
  const room = {
    ...record,
    endedAt: record.endedAt || null,
    participants: new Map(
      (record.participants || []).map((participant) => [
        participant.id,
        { ...participant, online: false }
      ])
    ),
    clients: new Set(),
    sockets: new Set(),
    connections: new Map(),
    messages: record.messages || [],
    playback: record.playback || {
      media: null,
      isPlaying: false,
      positionSec: 0,
      startedAt: null,
      updatedAt: Date.now(),
      updatedBy: record.auxHolderId
    }
  };
  return room;
}

function createRoom(hostName, participantId, ownerUser) {
  const code = makeRoomCode();
  const host = {
    id: participantId,
    userId: ownerUser?.id || null,
    name: hostName || "Host",
    online: false,
    joinedAt: Date.now(),
    lastSeenAt: Date.now()
  };
  const room = {
    code,
    ownerUserId: ownerUser?.id || null,
    createdAt: Date.now(),
    endedAt: null,
    auxHolderId: participantId,
    participants: new Map([[participantId, host]]),
    clients: new Set(),
    sockets: new Set(),
    connections: new Map(),
    messages: [],
    playback: {
      media: null,
      isPlaying: false,
      positionSec: 0,
      startedAt: null,
      updatedAt: Date.now(),
      updatedBy: participantId
    }
  };
  rooms.set(code, room);
  persistRoom(room);
  return room;
}

function assertAux(room, participantId, command) {
  if (room.auxHolderId !== participantId) {
    return `${command} is only available to the current aux holder.`;
  }
  return null;
}

async function fetchYouTubeMeta(videoId) {
  const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const response = await fetch(
    `https://www.youtube.com/oembed?${new URLSearchParams({
      url: videoUrl,
      format: "json"
    })}`
  );
  if (!response.ok) return null;
  const data = await response.json();
  return {
    title: data.title || "YouTube link",
    authorName: data.author_name || "",
    thumbnailUrl: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  };
}

async function searchYouTube(query) {
  if (!youtubeApiKey) {
    const error = new Error("Add YOUTUBE_API_KEY on the server to enable YouTube search.");
    error.status = 501;
    throw error;
  }
  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",
      maxResults: "8",
      safeSearch: "moderate",
      videoEmbeddable: "true",
      regionCode: youtubeRegionCode,
      key: youtubeApiKey
    })}`
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || "YouTube search failed.");
    error.status = response.status;
    throw error;
  }
  return (data.items || [])
    .filter((item) => item.id?.videoId)
    .map((item) => ({
      provider: "youtube",
      videoId: item.id.videoId,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      title: item.snippet?.title || "YouTube result",
      authorName: item.snippet?.channelTitle || "",
      sourceLabel: "YouTube",
      thumbnailUrl:
        item.snippet?.thumbnails?.medium?.url ||
        item.snippet?.thumbnails?.default?.url ||
        `https://i.ytimg.com/vi/${item.id.videoId}/hqdefault.jpg`
    }));
}

async function routeApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/users") {
    const body = await readJson(req);
    const displayName = String(body.displayName || "").trim().slice(0, 40);
    const handle = normalizeHandle(body.handle || displayName);
    if (!displayName) return badRequest(res, "Choose a display name.");
    if (!/^[a-z0-9_]{3,24}$/.test(handle)) {
      return badRequest(res, "Handle must be 3-24 characters using letters, numbers, or underscores.");
    }
    if (db().users.some((user) => user.handle === handle)) {
      return badRequest(res, "That handle is already taken.");
    }
    const now = Date.now();
    const user = {
      id: randomUUID(),
      authToken: randomBytes(24).toString("hex"),
      displayName,
      handle,
      friendCode: makeFriendCode(),
      createdAt: now
    };
    db().users.push(user);
    await saveDb();
    return sendJson(res, 201, { user: publicUser(user), authToken: user.authToken });
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = findUserByToken(req);
    if (!user) return sendJson(res, 200, { user: null, friends: [], invites: [], rooms: [] });
    const ownedActiveRooms = db()
      .rooms.filter((room) => !room.endedAt && room.ownerUserId === user.id)
      .map((room) => ({ code: room.code, createdAt: room.createdAt }));
    return sendJson(res, 200, {
      user: publicUser(user),
      friends: userFriends(user.id),
      invites: invitedRoomSummaries(user.id),
      rooms: ownedActiveRooms
    });
  }

  if (req.method === "POST" && url.pathname === "/api/friends") {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    const lookup = String(body.lookup || "").trim();
    const normalized = normalizeHandle(lookup);
    const friend = db().users.find(
      (candidate) =>
        candidate.id !== user.id &&
        (candidate.handle === normalized || candidate.friendCode === lookup.toUpperCase())
    );
    if (!friend) return badRequest(res, "No profile found with that handle or friend code.", 404);
    if (!areFriends(user.id, friend.id)) {
      db().friendships.push({ userId: user.id, friendId: friend.id, createdAt: Date.now() });
      await saveDb();
    }
    return sendJson(res, 200, { friends: userFriends(user.id) });
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    const participantId = body.participantId || randomUUID();
    const room = createRoom(body.name || user.displayName, participantId, user);
    await persistRoom(room);
    return sendJson(res, 201, { participantId, room: roomSnapshot(room) });
  }

  if (req.method === "GET" && url.pathname === "/api/youtube/meta") {
    const videoId = url.searchParams.get("videoId");
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId || "")) {
      return badRequest(res, "Invalid YouTube video ID.");
    }
    const meta = await fetchYouTubeMeta(videoId).catch(() => null);
    return sendJson(res, 200, {
      meta: meta || {
        title: "YouTube link",
        authorName: "",
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/youtube/search") {
    const query = String(url.searchParams.get("q") || "").trim();
    if (query.length < 2) return badRequest(res, "Search for at least 2 characters.");
    try {
      return sendJson(res, 200, { results: await searchYouTube(query.slice(0, 120)) });
    } catch (error) {
      return badRequest(res, error.message || "YouTube search failed.", error.status || 500);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/storage/config") {
    const configured = storageConfigured();
    return sendJson(res, 200, {
      configured,
      storage: configured
        ? {
            provider: "r2",
            bucket: r2Bucket,
            maxUploadBytes
          }
        : null
    });
  }

  if (req.method === "GET" && url.pathname === "/api/storage/debug") {
    return sendJson(res, 200, storageDebug());
  }

  if (req.method === "GET" && url.pathname === "/api/storage/library") {
    if (!storageConfigured()) return sendJson(res, 200, { media: [] });
    try {
      return sendJson(res, 200, { media: await listR2Media() });
    } catch (error) {
      return badRequest(res, error.message || "Could not load the media library.", error.status || 500);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/storage/upload-url") {
    if (!storageConfigured()) return badRequest(res, "Add Cloudflare R2 environment variables first.", 501);
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    const room = getRoom(body.roomCode);
    if (!room || room.endedAt) return badRequest(res, "Room not found.", 404);
    const participant = room.participants.get(body.participantId);
    if (!participant || participant.userId !== user.id) return badRequest(res, "Participant not in room.", 403);
    const error = assertAux(room, body.participantId, "Uploading media");
    if (error) return badRequest(res, error, 403);

    const fileName = String(body.fileName || "upload").slice(0, 180);
    const contentType = String(body.contentType || "application/octet-stream").slice(0, 120);
    const sizeBytes = Number(body.sizeBytes || 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return badRequest(res, "Choose a valid media file.");
    if (sizeBytes > maxUploadBytes) {
      return badRequest(res, `File is too large. Limit is ${Math.floor(maxUploadBytes / 1024 / 1024)} MB.`);
    }
    const extension = uploadExtension(fileName, contentType);
    if (![".mp3", ".m4a", ".wav", ".ogg", ".mp4", ".webm"].includes(extension)) {
      return badRequest(res, "Choose an MP3, M4A, WAV, OGG, MP4, or WebM file.");
    }

    const objectPath = `${room.code}/${randomUUID()}${extension}`;
    const publicBase = r2PublicBaseUrl;
    return sendJson(res, 200, {
      upload: {
        method: "PUT",
        url: signR2Upload({ objectPath, contentType }),
        headers: { "content-type": contentType },
        objectPath,
        publicUrl: `${publicBase}/${objectPath}`
      }
    });
  }

  const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-F0-9]{6})\/join$/);
  if (req.method === "POST" && joinMatch) {
    const room = getRoom(joinMatch[1]);
    if (!room || room.endedAt) return badRequest(res, "Room not found.", 404);
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    const participantId = body.participantId || randomUUID();
    if (!room.participants.has(participantId) && room.participants.size >= 3) {
      return badRequest(res, "Room is full.", 409);
    }
    const existing = room.participants.get(participantId);
    room.participants.set(participantId, {
      id: participantId,
      joinedAt: existing?.joinedAt || Date.now(),
      lastSeenAt: Date.now(),
      online: (room.connections.get(participantId) || 0) > 0,
      userId: user.id,
      name: body.name || existing?.name || user.displayName || "Listener"
    });
    await persistRoom(room);
    broadcast(room, "room");
    return sendJson(res, 200, { participantId, room: roomSnapshot(room) });
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-F0-9]{6})$/);
  if (req.method === "GET" && roomMatch) {
    const room = getRoom(roomMatch[1]);
    if (!room || room.endedAt) return badRequest(res, "Room not found.", 404);
    return sendJson(res, 200, { room: roomSnapshot(room) });
  }

  const inviteMatch = url.pathname.match(/^\/api\/rooms\/([A-F0-9]{6})\/invites$/);
  if (req.method === "POST" && inviteMatch) {
    const room = getRoom(inviteMatch[1]);
    if (!room || room.endedAt) return badRequest(res, "Room not found.", 404);
    const user = requireUser(req, res);
    if (!user) return;
    if (room.ownerUserId !== user.id) return badRequest(res, "Only the room owner can invite friends.", 403);
    const body = await readJson(req);
    const friend = db().users.find((candidate) => candidate.id === body.friendId);
    if (!friend || !areFriends(user.id, friend.id)) {
      return badRequest(res, "That person is not in your friends list.", 403);
    }
    const alreadyInvited = db().invites.some(
      (invite) => invite.roomCode === room.code && invite.toUserId === friend.id && !invite.dismissedAt
    );
    if (!alreadyInvited) {
      db().invites.push({
        id: randomUUID(),
        roomCode: room.code,
        fromUserId: user.id,
        toUserId: friend.id,
        createdAt: Date.now()
      });
      await saveDb();
    }
    return sendJson(res, 200, { invites: invitedRoomSummaries(friend.id) });
  }

  const endRoomMatch = url.pathname.match(/^\/api\/rooms\/([A-F0-9]{6})\/end$/);
  if (req.method === "POST" && endRoomMatch) {
    const room = getRoom(endRoomMatch[1]);
    if (!room || room.endedAt) return badRequest(res, "Room not found.", 404);
    const user = requireUser(req, res);
    if (!user) return;
    if (room.ownerUserId !== user.id) return badRequest(res, "Only the room owner can end this room.", 403);
    room.endedAt = Date.now();
    room.playback = { ...room.playback, isPlaying: false, startedAt: null, updatedAt: Date.now() };
    await persistRoom(room);
    broadcast(room, "room-ended", roomSnapshot(room));
    rooms.delete(room.code);
    return sendJson(res, 200, { ended: true });
  }

  const eventsMatch = url.pathname.match(/^\/api\/rooms\/([A-F0-9]{6})\/events$/);
  if (req.method === "GET" && eventsMatch) {
    const room = getRoom(eventsMatch[1]);
    if (!room || room.endedAt) {
      res.writeHead(404);
      return res.end();
    }
    const participantId = url.searchParams.get("participantId");
    if (participantId) {
      room.connections.set(participantId, (room.connections.get(participantId) || 0) + 1);
      touchParticipant(room, participantId, { online: true });
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    room.clients.add(res);
    res.write(`event: room\ndata: ${JSON.stringify(roomSnapshot(room))}\n\n`);
    broadcast(room, "presence");
    req.on("close", () => {
      room.clients.delete(res);
      if (!participantId) return;
      const nextCount = Math.max(0, (room.connections.get(participantId) || 1) - 1);
      if (nextCount === 0) {
        room.connections.delete(participantId);
        touchParticipant(room, participantId, { online: false });
      } else {
        room.connections.set(participantId, nextCount);
      }
      broadcast(room, "presence");
    });
    return;
  }

  const commandMatch = url.pathname.match(/^\/api\/rooms\/([A-F0-9]{6})\/commands$/);
  if (req.method === "POST" && commandMatch) {
    const room = getRoom(commandMatch[1]);
    if (!room || room.endedAt) return badRequest(res, "Room not found.", 404);
    const body = await readJson(req);
    const participantId = body.participantId;
    if (!room.participants.has(participantId)) return badRequest(res, "Participant not in room.", 403);
    touchParticipant(room, participantId);

    const now = Date.now();
    if (body.type === "play") {
      const positionSec =
        typeof body.positionSec === "number"
          ? body.positionSec
          : typeof body.positionMs === "number"
            ? body.positionMs / 1000
            : room.playback.positionSec || 0;
      room.playback = {
        ...room.playback,
        isPlaying: true,
        startedAt: now - positionSec * 1000,
        updatedAt: now,
        updatedBy: participantId
      };
    } else if (body.type === "pause") {
      const positionSec =
        typeof body.positionSec === "number"
          ? body.positionSec
          : typeof body.positionMs === "number"
            ? body.positionMs / 1000
          : room.playback.startedAt
            ? (now - room.playback.startedAt) / 1000
            : room.playback.positionSec;
      room.playback = {
        ...room.playback,
        isPlaying: false,
        positionSec: Math.max(0, positionSec),
        startedAt: null,
        updatedAt: now,
        updatedBy: participantId
      };
    } else if (body.type === "media-change" || body.type === "track-change") {
      const error = assertAux(room, participantId, "Changing media");
      if (error) return badRequest(res, error, 403);
      if (!["youtube", "r2"].includes(body.media?.provider)) {
        return badRequest(res, "Choose a valid media source.");
      }
      if (body.media?.provider === "youtube" && !body.media?.videoId) {
        return badRequest(res, "Paste a valid YouTube link.");
      }
      if (body.media?.provider === "r2" && !body.media?.url) {
        return badRequest(res, "Upload a valid R2 media file.");
      }
      room.playback = {
        media: body.media,
        isPlaying: true,
        positionSec: 0,
        startedAt: now,
        updatedAt: now,
        updatedBy: participantId
      };
    } else if (body.type === "seek") {
      const error = assertAux(room, participantId, "Seeking");
      if (error) return badRequest(res, error, 403);
      const positionSec = Math.max(
        0,
        typeof body.positionSec === "number" ? body.positionSec : Number(body.positionMs || 0) / 1000
      );
      room.playback = {
        ...room.playback,
        positionSec,
        startedAt: room.playback.isPlaying ? now - positionSec * 1000 : null,
        updatedAt: now,
        updatedBy: participantId
      };
    } else if (body.type === "aux-transfer") {
      const error = assertAux(room, participantId, "Passing aux");
      if (error) return badRequest(res, error, 403);
      if (!room.participants.has(body.toParticipantId)) {
        return badRequest(res, "That participant is not in the room.", 404);
      }
      const from = room.participants.get(participantId);
      const to = room.participants.get(body.toParticipantId);
      room.auxHolderId = body.toParticipantId;
      room.messages = [
        ...room.messages,
        {
          id: randomUUID(),
          participantId: "system",
          name: "Cozy Aux",
          text: `${from?.name || "Someone"} passed aux to ${to?.name || "someone"}.`,
          sentAt: now,
          system: true
        }
      ].slice(-100);
    } else if (body.type === "chat-send") {
      const text = String(body.text || "").trim().slice(0, 500);
      if (!text) return badRequest(res, "Message cannot be empty.");
      const participant = room.participants.get(participantId);
      room.messages = [
        ...room.messages,
        {
          id: randomUUID(),
          participantId,
          name: participant?.name || "Listener",
          text,
          sentAt: now
        }
      ].slice(-100);
    } else {
      return badRequest(res, "Unknown command.");
    }

    await persistRoom(room);
    broadcast(room, body.type);
    return sendJson(res, 200, { room: roomSnapshot(room) });
  }

  return false;
}

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    const body = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": mime[".html"] });
    res.end(body);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      const handled = await routeApi(req, res, url);
      if (handled === false) badRequest(res, "Not found.", 404);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Server error." });
  }
});

server.on("upgrade", (req, socket) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/ws\/rooms\/([A-F0-9]{6})$/);
    if (!match) {
      socket.destroy();
      return;
    }

    const room = getRoom(match[1]);
    const participantId = url.searchParams.get("participantId");
    if (!room || room.endedAt || !participantId || !room.participants.has(participantId)) {
      socket.destroy();
      return;
    }

    acceptWebSocket(req, socket);
    room.sockets.add(socket);
    room.connections.set(participantId, (room.connections.get(participantId) || 0) + 1);
    touchParticipant(room, participantId, { online: true });
    socket.write(encodeWebSocketFrame(JSON.stringify({ event: "room", data: roomSnapshot(room) })));
    broadcast(room, "presence");

    socket.on("data", (chunk) => {
      if ((chunk[0] & 0x0f) === 0x8) socket.end();
    });
    socket.on("close", () => {
      room.sockets.delete(socket);
      const nextCount = Math.max(0, (room.connections.get(participantId) || 1) - 1);
      if (nextCount === 0) {
        room.connections.delete(participantId);
        touchParticipant(room, participantId, { online: false });
      } else {
        room.connections.set(participantId, nextCount);
      }
      broadcast(room, "presence");
    });
    socket.on("error", () => {
      socket.destroy();
    });
  } catch {
    socket.destroy();
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the other server or run with PORT=3001.`);
    process.exit(1);
  }
  throw error;
});

await loadDb();
for (const record of db().rooms.filter((room) => !room.endedAt)) {
  rooms.set(record.code, runtimeRoomFromRecord(record));
}

server.listen(port, host, () => {
  console.log(`Cozy Aux prototype running at ${publicBaseUrl}`);
});
