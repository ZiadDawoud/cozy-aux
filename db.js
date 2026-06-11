import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const dbPath = process.env.DB_FILE || join(__dirname, "data", "cozy-aux-db.json");

const emptyDb = () => ({
  users: [],
  friendships: [],
  rooms: [],
  invites: []
});

let data = emptyDb();
let writeQueue = Promise.resolve();

export async function loadDb() {
  try {
    data = { ...emptyDb(), ...JSON.parse(await readFile(dbPath, "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    data = emptyDb();
    await saveDb();
  }
  return data;
}

export function db() {
  return data;
}

export function saveDb() {
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, `${JSON.stringify(data, null, 2)}\n`);
  });
  return writeQueue;
}

