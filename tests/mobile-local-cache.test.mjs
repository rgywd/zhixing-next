import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as api from "../src/api.ts";
import { cacheHarness } from "./helpers/local-cache.mjs";

const connection = { url: "https://fixture.test", token: "private-test-token" };
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };
const plain = (value) => JSON.parse(JSON.stringify(value));

test("SQLite survives reopening with large chat history, isolates credentials, and rejects late overwrites", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zhixing-cache-"));
  try {
    const filename = join(directory, "cache.db");
    let cache = cacheHarness(filename);
    const snapshot = { messages: [{ content: "离线已有内容".repeat(400000) }], previous: "100" };
    await cache.writeCache(connection, "chat:c1:latest", snapshot, 200);
    await cache.writeCache(connection, "chat:c1:latest", { messages: [] }, 100);
    cache.close(); cache = cacheHarness(filename);
    assert.deepEqual(plain(await cache.readCache(connection, "chat:c1:latest")), snapshot);
    for (const other of [{ ...connection, token: "other-account" }, { ...connection, url: "https://other.test" }]) {
      assert.equal(await cache.readCache(other, "chat:c1:latest"), null);
    }
    assert.equal((await cache.readCache({ ...connection, url: `${connection.url}/` }, "chat:c1:latest")).previous, "100");
    const rows = cache.db.prepare("SELECT scope, name FROM snapshots").all();
    assert.doesNotMatch(JSON.stringify(rows), /private-test-token|https:/);
    await cache.writeCache(connection, "chat:c1:latest", { messages: [], previous: null }, 1);
    assert.equal((await cache.readCache(connection, "chat:c1:latest")).previous, null);
    cache.db.prepare("UPDATE snapshots SET value = ?").run("broken JSON");
    assert.equal(await cache.readCache(connection, "chat:c1:latest"), null);
    cache.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function hooks() {
  const slots = []; let cursor = 0, effects = [];
  const changed = (a, b) => !a || b.some((v, i) => v !== a[i]);
  return {
    react: {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
      useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
      useCallback(fn, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
      useEffect(fn, deps) { const i = cursor++, previous = slots[i]; if (changed(previous?.deps, deps)) { slots[i] = { deps }; effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); }); } },
    },
    render(fn) { cursor = 0; effects = []; const result = fn(); effects.forEach((effect) => effect()); return result; },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}
function session(cache, request) {
  const lifecycle = hooks(), calls = [], listeners = new Set(), intervals = new Set(), reports = [], exports = {};
  const report = (error) => reports.push(error);
  const deps = {
    react: lifecycle.react,
    "react-native": { AppState: { currentState: "active", addEventListener(_name, fn) { listeners.add(fn); return { remove: () => listeners.delete(fn) }; } } },
    "./api": { ...api, request: async (_connection, path, options) => { calls.push({ path, options }); return request(path); } },
    "./ConnectionStatus": { useSyncStatus: () => report }, "./localCache": cache,
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/useSessionData.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, AbortController, setInterval: (fn) => { intervals.add(fn); return fn; }, clearInterval: (fn) => intervals.delete(fn), require: (id) => { assert.ok(id in deps, id); return deps[id]; } });
  const render = () => lifecycle.render(() => exports.useSessionData(connection));
  return { render, reports, calls, intervals, listeners, unmount: lifecycle.unmount,
    async ready() { render(); await settle(); render(); await settle(); return render(); } };
}
const conversation = { id: "c1", title: "已缓存会话", agent_id: null, updated_at: "2026-10-28" };
function response(path) {
  if (path === "/status") return { runtime: "dsh", worker_online: true, model_ready: true };
  if (path === "/assistant") return { name: "知行", persona: "test" };
  if (path === "/models") return { items: [] };
  if (path === "/conversations/c1") return conversation;
  return { items: path.startsWith("/conversations") ? [conversation] : [], previous_cursor: "older", next_cursor: null };
}

test("session restores conversation list before a blocked network read; offline failures preserve it", async () => {
  const cache = cacheHarness();
  const online = session(cache, response); assert.equal((await online.ready()).conversations[0].title, "已缓存会话"); online.unmount();
  let reject;
  const unavailable = new Promise((_resolve, no) => { reject = no; });
  const offline = session(cache, () => unavailable);
  let value = await offline.ready();
  assert.equal(value.conversations[0].id, "c1"); assert.equal(value.loading, false);
  assert.equal(value.assistant.name, "知行"); assert.equal(value.status, null);
  reject(new Error("offline")); await settle(); value = offline.render();
  assert.equal(value.conversations[0].id, "c1"); assert.equal(value.lastSyncFailed, true);
  offline.unmount(); assert.equal(offline.intervals.size, 0); assert.equal(offline.listeners.size, 0);
});
test("DSH outlet selection survives offline restore without claiming the host is online", async () => {
  const cache = cacheHarness();
  const online = session(cache, path => path === "/status" ? { runtime: "dsh", worker_online: true, model_ready: true } : response(path));
  assert.equal((await online.ready()).runtime, "dsh"); online.unmount();
  const offline = session(cache, async () => { throw new Error("offline"); });
  const value = await offline.ready();
  assert.equal(value.runtime, "dsh"); assert.equal(value.status, null); assert.equal(value.lastSyncFailed, true);
  offline.unmount();
});

test("a failed ancillary endpoint does not suppress a new conversation or overwrite the last good section", async () => {
  const cache = cacheHarness();
  const first = session(cache, response); await first.ready(); first.unmount();
  const next = session(cache, (path) => {
    if (path === "/assistant") throw new Error("temporarily unavailable");
    if (path.startsWith("/conversations?")) return { items: [{ ...conversation, id: "c2", title: "新会话" }], previous_cursor: "c1" };
    return response(path);
  });
  const value = await next.ready();
  assert.deepEqual(value.conversations.map((item) => item.id), ["c1", "c2"]);
  assert.equal(value.assistant.name, "知行"); assert.equal(value.lastSyncFailed, true);
  next.unmount();
});

test("unmount during cache restoration never starts requests or accepts a late snapshot", async () => {
  let resolve;
  const pending = new Promise((yes) => { resolve = yes; });
  const app = session({ readCache: () => pending, writeCache: async () => {} }, response);
  app.render(); app.unmount(); resolve({ conversations: [conversation], agents: [], recentResources: [] }); await settle();
  assert.equal(app.calls.length, 0); assert.equal(app.intervals.size, 0); assert.equal(app.listeners.size, 0);
});
