import { digestStringAsync, CryptoDigestAlgorithm, randomUUID } from "expo-crypto";
import { openDatabaseAsync } from "expo-sqlite";
import type { Connection, Message } from "./api";
import { initializeCache, readSnapshot, writeSnapshot, type CacheDatabase } from "./cacheStore";

let database: Promise<CacheDatabase> | undefined;
function openCache() {
  if (!database) database = openDatabaseAsync("zhixing-read-cache-v1.db")
    .then(async (db) => { await initializeCache(db); return db; })
    .catch((error: unknown) => { database = undefined; throw error; });
  return database;
}

// Credentials are only used in memory to derive an opaque namespace, never stored in SQLite.
let lastScope: { identity: string; digest: Promise<string> } | undefined;
function scopeFor(connection: Connection) {
  const identity = JSON.stringify([connection.url.replace(/\/+$/, ""), connection.token]);
  if (lastScope?.identity !== identity) lastScope = { identity, digest: digestStringAsync(CryptoDigestAlgorithm.SHA256, identity) };
  return lastScope.digest;
}
let revision = 0;
const epoch = randomUUID();
// Request order, independent of phone clock changes. A fresh process starts a new epoch.
export function cacheRevision() { return ++revision; }
export async function readCache<T>(connection: Connection, name: string): Promise<T | null> {
  try {
    const [db, scope] = await Promise.all([openCache(), scopeFor(connection)]);
    return await readSnapshot<T>(db, scope, name);
  } catch { return null; } // A cache failure must not prevent a live read.
}
export async function writeCache(connection: Connection, name: string, value: unknown, version = cacheRevision()) {
  const [db, scope] = await Promise.all([openCache(), scopeFor(connection)]);
  await writeSnapshot(db, scope, name, value, version, epoch);
}

export type CachedChat = { messages: Message[]; previous: string | null; cursor: number };
export function validCachedChat(value: CachedChat | null, conversationId: string): value is CachedChat {
  return !!value && Number.isSafeInteger(value.cursor) && value.cursor >= 0 && Array.isArray(value.messages) && (value.previous === null || typeof value.previous === "string") &&
    value.messages.every((item) => item && item.conversation_id === conversationId && typeof item.id === "string" &&
      typeof item.content === "string" && Number.isSafeInteger(item.seq) && item.seq > 0);
}

// Callers supply the business period: finance month or health date.
export function serviceCacheKey(scope: string) { return `service:${scope}`; }
