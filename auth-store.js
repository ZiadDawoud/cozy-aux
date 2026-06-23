import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { db, saveDb } from "./db.js";

const d1AccountId = (process.env.CLOUDFLARE_ACCOUNT_ID || process.env.D1_ACCOUNT_ID || "").trim();
const d1DatabaseId = (process.env.CLOUDFLARE_D1_DATABASE_ID || process.env.D1_DATABASE_ID || "").trim();
const d1ApiToken = (process.env.CLOUDFLARE_D1_API_TOKEN || process.env.D1_API_TOKEN || "").trim();

export const usingD1 = Boolean(d1AccountId && d1DatabaseId && d1ApiToken);

function now() {
  return Date.now();
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt).hash, "hex");
  const expected = Buffer.from(expectedHash || "", "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    handle: user.username || user.handle,
    username: user.username || user.handle,
    displayName: user.displayName || user.display_name,
    friendCode: user.friendCode || user.friend_code,
    createdAt: user.createdAt || user.created_at
  };
}

function canonicalFriendship(userId, friendId) {
  return [userId, friendId].sort();
}

async function d1Query(sql, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${d1AccountId}/d1/database/${d1DatabaseId}/query`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${d1ApiToken}`
      },
      body: JSON.stringify({ sql, params })
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success || body.result?.some((result) => !result.success)) {
    const apiMessage =
      body.errors?.[0]?.message ||
      body.result?.find((result) => !result.success)?.error ||
      "Cloudflare D1 query failed.";
    const error = new Error(apiMessage);
    error.status = response.status || 500;
    throw error;
  }
  return body.result?.[0]?.results || [];
}

async function initD1() {
  await d1Query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      friend_code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS friendships (
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id)
    );
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL,
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      dismissed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_invites_to_user ON invites(to_user_id, dismissed_at);
  `);
}

let initPromise = null;

export async function initAuthStore() {
  if (!usingD1) return;
  initPromise ||= initD1();
  await initPromise;
}

function makeFriendCodeJson() {
  let code = "";
  do {
    code = randomBytes(3).toString("hex").toUpperCase();
  } while (db().users.some((user) => (user.friendCode || user.friend_code) === code));
  return code;
}

async function makeFriendCodeD1() {
  let code = "";
  do {
    code = randomBytes(3).toString("hex").toUpperCase();
  } while ((await d1Query("SELECT id FROM users WHERE friend_code = ? LIMIT 1", [code])).length);
  return code;
}

export async function findUserByToken(token) {
  if (!token) return null;
  if (usingD1) {
    await initAuthStore();
    const rows = await d1Query(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ?
       LIMIT 1`,
      [token]
    );
    if (rows[0]) {
      await d1Query("UPDATE sessions SET last_seen_at = ? WHERE token = ?", [now(), token]);
    }
    return publicUser(rows[0]);
  }
  const user = db().users.find((candidate) => candidate.authToken === token);
  return publicUser(user);
}

export async function createUser({ username, displayName, password }) {
  const normalized = normalizeUsername(username);
  if (!displayName) throw new Error("Choose a display name.");
  if (!/^[a-z0-9_]{3,24}$/.test(normalized)) {
    throw new Error("Username must be 3-24 characters using letters, numbers, or underscores.");
  }
  if (String(password || "").length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const createdAt = now();
  const id = randomUUID();
  const token = randomBytes(24).toString("hex");
  const { salt, hash } = hashPassword(password);

  if (usingD1) {
    await initAuthStore();
    const existing = await d1Query("SELECT id FROM users WHERE username = ? LIMIT 1", [normalized]);
    if (existing.length) throw new Error("That username is already taken.");
    const friendCode = await makeFriendCodeD1();
    await d1Query(
      `INSERT INTO users (id, username, display_name, password_hash, password_salt, friend_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, normalized, displayName, hash, salt, friendCode, createdAt]
    );
    await d1Query("INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)", [
      token,
      id,
      createdAt,
      createdAt
    ]);
    return {
      user: publicUser({ id, username: normalized, displayName, friendCode, createdAt }),
      authToken: token
    };
  }

  if (db().users.some((user) => (user.username || user.handle) === normalized)) {
    throw new Error("That username is already taken.");
  }
  const user = {
    id,
    authToken: token,
    username: normalized,
    handle: normalized,
    displayName,
    passwordHash: hash,
    passwordSalt: salt,
    friendCode: makeFriendCodeJson(),
    createdAt
  };
  db().users.push(user);
  await saveDb();
  return { user: publicUser(user), authToken: token };
}

export async function loginUser({ username, password }) {
  const normalized = normalizeUsername(username);
  if (usingD1) {
    await initAuthStore();
    const rows = await d1Query("SELECT * FROM users WHERE username = ? LIMIT 1", [normalized]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      throw new Error("Username or password is incorrect.");
    }
    const token = randomBytes(24).toString("hex");
    await d1Query("INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)", [
      token,
      user.id,
      now(),
      now()
    ]);
    return { user: publicUser(user), authToken: token };
  }

  const user = db().users.find((candidate) => (candidate.username || candidate.handle) === normalized);
  if (!user?.passwordHash || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    throw new Error("Username or password is incorrect.");
  }
  user.authToken = randomBytes(24).toString("hex");
  await saveDb();
  return { user: publicUser(user), authToken: user.authToken };
}

export async function userFriends(userId) {
  if (usingD1) {
    await initAuthStore();
    const rows = await d1Query(
      `SELECT users.* FROM friendships
       JOIN users ON users.id = CASE
         WHEN friendships.user_id = ? THEN friendships.friend_id
         ELSE friendships.user_id
       END
       WHERE friendships.user_id = ? OR friendships.friend_id = ?
       ORDER BY users.display_name`,
      [userId, userId, userId]
    );
    return rows.map(publicUser);
  }
  return db()
    .friendships.filter((friendship) => friendship.userId === userId || friendship.friendId === userId)
    .map((friendship) =>
      publicUser(
        db().users.find((user) =>
          user.id === (friendship.userId === userId ? friendship.friendId : friendship.userId)
        )
      )
    )
    .filter(Boolean);
}

export async function areFriends(userId, friendId) {
  if (usingD1) {
    await initAuthStore();
    const [first, second] = canonicalFriendship(userId, friendId);
    const rows = await d1Query("SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ? LIMIT 1", [
      first,
      second
    ]);
    return Boolean(rows.length);
  }
  return db().friendships.some(
    (friendship) =>
      (friendship.userId === userId && friendship.friendId === friendId) ||
      (friendship.userId === friendId && friendship.friendId === userId)
  );
}

export async function findUserByLookup(lookup, currentUserId) {
  const normalized = normalizeUsername(lookup);
  const code = String(lookup || "").trim().toUpperCase();
  if (usingD1) {
    await initAuthStore();
    const rows = await d1Query(
      "SELECT * FROM users WHERE id != ? AND (username = ? OR friend_code = ?) LIMIT 1",
      [currentUserId, normalized, code]
    );
    return publicUser(rows[0]);
  }
  return publicUser(
    db().users.find(
      (candidate) =>
        candidate.id !== currentUserId &&
        ((candidate.username || candidate.handle) === normalized || candidate.friendCode === code)
    )
  );
}

export async function findUserById(userId) {
  if (usingD1) {
    await initAuthStore();
    const rows = await d1Query("SELECT * FROM users WHERE id = ? LIMIT 1", [userId]);
    return publicUser(rows[0]);
  }
  return publicUser(db().users.find((user) => user.id === userId));
}

export async function addFriendship(userId, friendId) {
  if (usingD1) {
    await initAuthStore();
    const [first, second] = canonicalFriendship(userId, friendId);
    await d1Query("INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)", [
      first,
      second,
      now()
    ]);
    return;
  }
  if (!(await areFriends(userId, friendId))) {
    db().friendships.push({ userId, friendId, createdAt: now() });
    await saveDb();
  }
}

export async function invitedRoomSummaries(userId, rooms = []) {
  const activeRoomByCode = new Map(rooms.filter((room) => !room.endedAt).map((room) => [room.code, room]));
  if (usingD1) {
    await initAuthStore();
    const rows = await d1Query(
      `SELECT invites.room_code, invites.created_at, users.id, users.username, users.display_name, users.friend_code, users.created_at AS user_created_at
       FROM invites
       JOIN users ON users.id = invites.from_user_id
       WHERE invites.to_user_id = ? AND invites.dismissed_at IS NULL
       ORDER BY invites.created_at DESC`,
      [userId]
    );
    return rows
      .filter((row) => activeRoomByCode.has(row.room_code))
      .map((row) => ({
        roomCode: row.room_code,
        invitedAt: row.created_at,
        from: publicUser({
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          friendCode: row.friend_code,
          createdAt: row.user_created_at
        })
      }));
  }
  return db()
    .invites.filter((invite) => invite.toUserId === userId && !invite.dismissedAt)
    .map((invite) => {
      const room = activeRoomByCode.get(invite.roomCode);
      const from = db().users.find((user) => user.id === invite.fromUserId);
      if (!room) return null;
      return {
        roomCode: room.code,
        invitedAt: invite.createdAt,
        from: publicUser(from)
      };
    })
    .filter(Boolean);
}

export async function inviteFriend({ roomCode, fromUserId, toUserId }) {
  if (usingD1) {
    await initAuthStore();
    const existing = await d1Query(
      "SELECT id FROM invites WHERE room_code = ? AND to_user_id = ? AND dismissed_at IS NULL LIMIT 1",
      [roomCode, toUserId]
    );
    if (!existing.length) {
      await d1Query(
        "INSERT INTO invites (id, room_code, from_user_id, to_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
        [randomUUID(), roomCode, fromUserId, toUserId, now()]
      );
    }
    return;
  }
  const alreadyInvited = db().invites.some(
    (invite) => invite.roomCode === roomCode && invite.toUserId === toUserId && !invite.dismissedAt
  );
  if (!alreadyInvited) {
    db().invites.push({
      id: randomUUID(),
      roomCode,
      fromUserId,
      toUserId,
      createdAt: now()
    });
    await saveDb();
  }
}
