import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";
import * as api from "../src/api.ts";
import { availablePreference } from "../src/providerEditing.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function hooks() {
  const slots = [], effects = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(effect, deps) {
      const index = cursor++, old = slots[index];
      if (!old || deps.some((value, i) => value !== old.deps[i])) {
        slots[index] = { deps };
        effects.push(() => { old?.cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
    useCallback(callback, deps) {
      const index = cursor++, old = slots[index];
      if (!old || deps.some((value, i) => value !== old.deps[i])) slots[index] = { deps, callback };
      return slots[index].callback;
    },
  };
  return { react, render(callback) { cursor = 0; const value = callback(); effects.splice(0).forEach((effect) => effect()); return value; },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}
function load(name, dependencies, suffix = "") {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8") + suffix, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, AbortController, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, require: (id) => {
    assert.ok(id in dependencies, `Unexpected dependency: ${id}`); return dependencies[id];
  } });
  return exports;
}
function welcomeHarness({ stored = new Map(), read, write } = {}) {
  const lifecycle = hooks(), reads = [], writes = [];
  const { useWelcomeDraft } = load("useWelcomeDraft.ts", { react: lifecycle.react,
    "@react-native-async-storage/async-storage": { __esModule: true, default: {
      getItem: async (key) => { reads.push(key); return read ? read(key, reads.length) : stored.get(key) ?? null; },
      setItem: async (key, value) => { writes.push({ key, value }); if (write) await write(key, value, writes.length); stored.set(key, value); },
    } },
  });
  return { render: (url = "https://one.example") => lifecycle.render(() => useWelcomeDraft(url)), stored, reads, writes, unmount: lifecycle.unmount };
}

test("welcome text and each send choice survive remount and stay isolated by server", async () => {
  const app = welcomeHarness(); app.render(); await settle();
  const value = app.render();
  value.setText("Draft before first conversation"); value.setKind("task");
  value.setModel("chat", "chat-model"); value.setModel("task", "task-model");
  value.setEffort("chat", "low"); value.setEffort("task", "high"); value.setSearch("search");
  await settle(); const expected = plain(app.render().value); app.unmount();
  const restored = welcomeHarness({ stored: app.stored }); restored.render(); await settle();
  assert.deepEqual(plain(restored.render().value), expected); restored.unmount();
  const different = welcomeHarness({ stored: app.stored }); different.render("https://two.example"); await settle();
  assert.equal(different.render("https://two.example").value.text, ""); different.unmount();
});

test("welcome read failure cannot overwrite old text and retry safely applies a queued life prompt", async () => {
  const saved = JSON.stringify({ text: "Already writing", kind: "task" });
  const app = welcomeHarness({ read: async (_key, attempt) => { if (attempt === 1) throw new Error("read unavailable"); return saved; } });
  app.render(); await settle(); let value = app.render();
  assert.equal(value.ready, false); assert.ok(value.error);
  value.setText((old) => old.trim() ? old : "Life suggestion");
  await settle(); assert.equal(app.writes.length, 0);
  value.retry(); app.render(); await settle(); value = app.render();
  assert.equal(value.ready, true); assert.equal(value.value.text, "Already writing");
  assert.equal(value.value.kind, "task"); assert.equal(value.error, ""); app.unmount();
});

test("welcome write failures keep in-memory text and explicit retry saves it without rereading", async () => {
  const app = welcomeHarness({ write: async (_key, _value, attempt) => { if (attempt === 1) throw new Error("disk busy"); } });
  app.render(); await settle(); app.render().setText("Keep this"); await settle();
  const value = app.render(); assert.equal(value.value.text, "Keep this"); assert.ok(value.error);
  value.retry(); await settle(); assert.equal(app.render().error, "");
  assert.equal(app.reads.length, 1); assert.equal(JSON.parse([...app.stored.values()][0]).text, "Keep this"); app.unmount();
});

test("slow welcome autosaves keep the latest text and all batched choices in order", async () => {
  const slow = deferred();
  const app = welcomeHarness({ write: async (_key, _value, attempt) => { if (attempt === 1) await slow.promise; } });
  app.render(); await settle(); const value = app.render();
  value.setText("First"); value.setText("Latest"); value.setModel("task", "model"); value.setEffort("task", "high");
  await settle(); assert.equal(app.writes.length, 1);
  slow.resolve(); await settle();
  const saved = JSON.parse([...app.stored.values()][0]);
  assert.equal(saved.text, "Latest"); assert.equal(saved.models.task, "model"); assert.equal(saved.efforts.task, "high"); app.unmount();
});

test("consuming welcome text waits for durable clearing and preserves text changed during handoff", async () => {
  const slow = deferred();
  const app = welcomeHarness({ write: async (_key, _value, attempt) => { if (attempt === 2) await slow.promise; } });
  app.render(); await settle(); app.render().setText("Sending"); await settle();
  let finished = false;
  const transfer = app.render().consumeText("Sending").then(() => { finished = true; }); await settle();
  assert.equal(finished, false); assert.equal(JSON.parse([...app.stored.values()][0]).text, "Sending");
  app.render().setText("Next topic"); slow.resolve(); await transfer; await settle();
  assert.equal(app.render().value.text, "Next topic"); assert.equal(JSON.parse([...app.stored.values()][0]).text, "Next topic");
  await app.render().consumeText("Old topic"); assert.equal(app.render().value.text, "Next topic"); app.unmount();
});

test("a newer unsaved welcome edit cannot bypass the durable first-message handoff", async () => {
  const app = welcomeHarness({ write: async (_key, _value, attempt) => { if (attempt === 2 || attempt === 3) throw new Error("disk busy"); } });
  app.render(); await settle(); app.render().setText("Original request"); await settle();
  app.render().setText("New location context"); await settle();
  assert.equal(JSON.parse([...app.stored.values()][0]).text, "Original request");
  await assert.rejects(app.render().consumeText("Original request"), /disk busy/);
  assert.equal(app.render().value.text, "New location context");
  await app.render().consumeText("Original request");
  assert.equal(JSON.parse([...app.stored.values()][0]).text, "New location context"); app.unmount();
});

function chatHarness({ initial = { text: "hello", pending: null }, read, post, clear } = {}) {
  const lifecycle = hooks(), requests = [], writes = [], clears = [], confirmation = [];
  let stored = plain(initial), history = [], readCount = 0, sequence = 0;
  const sync = () => {};
  const { useChat } = load("useChat.ts", {
    react: lifecycle.react,
    "react-native": { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, Alert: { alert: (_title, _body, actions) => confirmation.push(actions) } },
    "expo-crypto": { randomUUID: () => `message-${++sequence}` },
    "expo-speech": { stop: async () => {} },
    "./ConnectionStatus": { useSyncStatus: () => sync },
    "./ui": { humanError: (error) => error.message },
    "./storage": {
      draftKey: () => "draft",
      readDraft: async () => read ? read(++readCount) : plain(stored),
      saveDraft: async (_key, next) => { writes.push(plain(next)); stored = plain(next); },
      clearDraft: async (_key, id) => { clears.push(id); if (clear) await clear(id); if (stored.pending?.id === id) stored = { text: "", pending: null }; },
    },
    "./api": { ...api, request: async (_connection, path, options) => {
      requests.push({ path, ...options });
      if (options?.method === "POST") return post ? post(options.body) : { message: receipt(options.body), run: { id: "run", status: "queued" } };
      return { items: path.includes("/messages?") ? history : [], next_cursor: null, previous_cursor: null };
    } },
  });
  const args = { connection: { url: "https://example.test", token: "test" }, conversation: { id: "conversation" }, onRefresh() {} };
  return { render: () => lifecycle.render(() => useChat(args)), requests, writes, clears, stored: () => stored,
    history: (items) => { history = items; }, editPending: () => confirmation.at(-1).find((choice) => choice.onPress).onPress(), unmount: lifecycle.unmount };
}
const receipt = (input, extra = {}) => ({ ...input, attachments: (input.attachments ?? []).map((id) => ({ id })), role: "user", conversation_id: "conversation", status: "accepted", seq: 1, run_id: "run", ...extra });
const pending = { id: "saved-message", content: "hello", intent: "queue", kind: "chat" };

test("existing conversation draft read failure retries in place without allowing writes first", async () => {
  const app = chatHarness({ read: async (attempt) => { if (attempt === 1) throw new Error("temporarily locked"); return { text: "Restored", pending: null }; } });
  app.render(); await settle(); let value = app.render();
  assert.equal(value.draftReady, false); assert.ok(value.draftLoadError);
  await value.send(); assert.equal(app.writes.length, 0);
  value.retryDraft(); app.render(); await settle(); value = app.render();
  assert.equal(value.draftReady, true); assert.equal(value.draft.text, "Restored"); assert.equal(value.draftLoadError, ""); app.unmount();
});

test("persisting pending alone never acknowledges a message; the same user receipt does", async () => {
  const app = chatHarness({ initial: { text: "hello", pending } }); app.render(); await settle();
  assert.equal(app.render().draft.pending.id, pending.id); assert.equal(app.clears.length, 0);
  app.history([receipt(pending)]); app.render().refresh.current(); await settle(); app.render(); await settle();
  assert.equal(app.render().draft.pending, null); assert.equal(app.render().draft.text, "");
  assert.equal(app.stored().pending, null); assert.equal(app.requests.filter((item) => item.method === "POST").length, 0); app.unmount();
});

test("unrelated, mismatched and assistant messages do not acknowledge the pending draft", async () => {
  for (const extra of [{ id: "other" }, { conversation_id: "other" }, { role: "assistant" }, { content: "different" }, { attachments: [{ id: "other-file" }] }]) {
    const app = chatHarness({ initial: { text: "hello", pending } }); app.history([receipt(pending, extra)]);
    app.render(); await settle(); app.render(); await settle();
    assert.equal(app.render().draft.pending.id, pending.id); assert.equal(app.clears.length, 0); app.unmount();
  }
});

test("rapid send taps share a synchronous lock and retries reuse the saved ID", async () => {
  const first = deferred(); let attempts = 0;
  const app = chatHarness({ post: async (body) => { if (++attempts === 1) return first.promise; return { message: receipt(body), run: { id: "run" } }; } });
  app.render(); await settle(); const value = app.render();
  const a = value.send(), b = value.send(); await settle();
  assert.equal(app.requests.filter((item) => item.method === "POST").length, 1);
  first.reject(new Error("response lost")); await Promise.all([a, b]);
  const id = app.render().draft.pending.id; await app.render().send();
  assert.deepEqual(app.requests.filter((item) => item.method === "POST").map((item) => item.body.id), [id, id]); app.unmount();
});

test("a polled receipt resolves a lost response and a later POST timeout does not restore its error", async () => {
  const response = deferred(); const app = chatHarness({ post: () => response.promise });
  app.render(); await settle(); const sending = app.render().send(); await settle();
  const payload = app.stored().pending; app.history([receipt(payload)]); app.render().refresh.current();
  await settle(); app.render(); await settle(); assert.equal(app.render().draft.pending, null);
  response.reject(new Error("late response timeout")); await sending;
  assert.equal(app.render().error, ""); assert.equal(app.render().busy, false); app.unmount();
});

test("a late receipt cannot clear a replacement draft while conditional storage cleanup is pending", async () => {
  const cleanup = deferred(); const app = chatHarness({ initial: { text: "hello", pending }, clear: () => cleanup.promise });
  app.history([receipt(pending)]); app.render(); await settle(); app.render(); await settle();
  app.render().abandonPending(); app.editPending(); await settle();
  await app.render().updateDraft({ text: "New draft", pending: null }); cleanup.resolve(); await settle();
  assert.equal(app.render().draft.text, "New draft"); assert.equal(app.stored().text, "New draft"); app.unmount();
});

const walk = (node) => node?.props ? [node, ...[node.props.children].flat(Infinity).flatMap(walk)] : [];
function welcomeSendHarness({ failModel = false, post, saveDraft, consumeText, submit } = {}) {
  const lifecycle = hooks(), calls = [], sync = () => {};
  const conversation = { id: "created", title: "hello", agent_id: null, model_id: null, project_id: null };
  const welcome = { consumeText: consumeText ?? (async () => {}), value: { text: "hello", kind: "chat", models: { chat: "model", task: null }, efforts: { chat: null, task: null }, searchId: null }, ready: true, error: "", retry() {}, setText() {}, setKind() {}, setSearch() {}, setModel() {}, setEffort() {} };
  let modelFailures = failModel ? 1 : 0;
  const dependencies = {
    "react/jsx-runtime": jsxRuntime, react: lifecycle.react,
    "react-native": { ...Object.fromEntries(["ActivityIndicator", "Image", "KeyboardAvoidingView", "Modal", "Pressable", "Text", "View"].map((name) => [name, name])), Platform: { OS: "android" },
      AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, BackHandler: { addEventListener: () => ({ remove() {} }) }, Keyboard: { isVisible: () => false, addListener: () => ({ remove() {} }) } },
    "react-native-safe-area-context": { SafeAreaProvider: "SafeAreaProvider", SafeAreaView: "SafeAreaView" },
    "expo-status-bar": { StatusBar: "StatusBar" }, "expo-crypto": { randomUUID: () => "first-message" },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./providerEditing": { availablePreference },
    "./ui": { useUi: () => ({ s: {}, colors: {} }), humanError: (error) => error.message },
    "./ConnectionStatus": { useSyncStatus: () => sync, ConnectionStatusProvider: "ConnectionStatusProvider" },
    "./useHomePreferences": { useHomePreferences: () => ({ preferences: { pins: [], opened: {} }, ready: true, opened() {} }) },
    "./useWelcomeDraft": { useWelcomeDraft: () => welcome },
    "./homeEntries": { targetKey: (target) => `${target.kind}:${target.id}` },
    "./storage": { draftKey: () => "draft", saveDraft: saveDraft ?? (async () => {}), clearDraft: async () => {} },
    "./api": { ...api, request: async (_connection, path, options) => {
      calls.push({ path, ...options });
      if (path === "/conversations" && options?.method === "POST") return post ? post() : conversation;
      if (path.endsWith("/model")) { if (modelFailures-- > 0) throw new Error("model save failed"); return { ...conversation, model_id: "model" }; }
      if (path.endsWith("/messages")) return submit ? submit(options.body) : {};
      if (path === "/models") return { items: [{ id: "model", ready: true, reasoning_levels: [], name: "Model" }], roles: { chat: "model" } };
      if (path === "/assistant") return { name: "知行" };
      if (path === "/status") return { model_ready: true, worker_online: true };
      if (path === "/finance/observations") return { balances: [], recent: [] };
      return { items: [], next_cursor: null, previous_cursor: null };
    } },
  };
  for (const name of ["ThemeProvider", "AppearanceControl", "Notice", "ChatPanel", "AiHome", "AiDrawer", "BottomSheet", "FinancePage", "ResourcesPanel", "ModelsPanel", "ProvidersPanel", "ProjectsPanel", "ResourcePreview", "OverviewPanels", "LifePanel", "SchedulesPanel", "SettingsPanel", "SettingsHome", "SearchPicker", "AgentsPanel", "DeviceCapabilitiesPanel"]) {
    dependencies[`./${name}`] = Object.fromEntries([name, "NoticeProvider", "HomePanel", "WorkPanel", "ConnectionForm", "ConnectionSettingsPanel", "PersonaSettingsPanel"].map((component) => [component, component]));
  }
  const { ConnectedSession } = load("AssistantApp.tsx", dependencies, "\nexport { ConnectedSession };\n");
  const args = { connection: { url: "https://example.test", token: "test" }, onConnect() {}, onDisconnect() {}, connectionError: "" };
  const render = () => walk(lifecycle.render(() => ConnectedSession(args)));
  return { render, calls, welcome, unmount: lifecycle.unmount };
}

test("welcome rapid taps create one conversation even before React renders busy", async () => {
  const create = deferred(), app = welcomeSendHarness({ post: () => create.promise });
  app.render(); await settle(); app.render().find((node) => node.type === "HomePanel").props.onChat();
  const welcome = app.render().find((node) => node.type === "AiHome");
  welcome.props.onSend(); welcome.props.onSend(); await settle();
  assert.equal(app.calls.filter((call) => call.path === "/conversations" && call.method === "POST").length, 1);
  create.resolve({ id: "created", title: "hello", agent_id: null }); await settle(); app.unmount();
});

test("welcome retry reuses a received conversation when its subsequent model update fails", async () => {
  const app = welcomeSendHarness({ failModel: true }); app.render(); await settle();
  app.render().find((node) => node.type === "HomePanel").props.onChat();
  app.render().find((node) => node.type === "AiHome").props.onSend(); await settle();
  app.render().find((node) => node.type === "AiHome").props.onSend(); await settle();
  assert.equal(app.calls.filter((call) => call.path === "/conversations" && call.method === "POST").length, 1);
  assert.equal(app.calls.filter((call) => call.path.endsWith("/model")).length, 2);
  assert.equal(app.calls.filter((call) => call.path === "/conversations/created/messages").length, 1); app.unmount();
});

test("welcome cannot submit until both its original request and cleared welcome text are durable", async () => {
  const clear = deferred(), sent = deferred(), order = [];
  const app = welcomeSendHarness({ saveDraft: async () => { order.push("request-saved"); },
    consumeText: async () => { order.push("clearing"); await clear.promise; order.push("welcome-cleared"); },
    submit: () => { order.push("submitted"); return sent.promise; } });
  app.render(); await settle(); app.render().find((node) => node.type === "HomePanel").props.onChat();
  app.render().find((node) => node.type === "AiHome").props.onSend(); await settle();
  assert.deepEqual(order, ["request-saved", "clearing"]);
  assert.equal(app.calls.filter((call) => call.path.endsWith("/messages")).length, 0);
  clear.resolve(); await settle(); assert.deepEqual(order, ["request-saved", "clearing", "welcome-cleared", "submitted"]);
  // At the moment a process could disappear while waiting for the POST response,
  // the persisted welcome text is already gone and the original request is retained.
  app.unmount(); sent.reject(new Error("process ended")); await settle();
});

test("welcome clear failure stops first-message submission and retry can reset the created model to default", async () => {
  let attempt = 0;
  const app = welcomeSendHarness({ consumeText: async () => { if (++attempt === 1) throw new Error("storage unavailable"); } });
  app.render(); await settle(); app.render().find((node) => node.type === "HomePanel").props.onChat();
  app.render().find((node) => node.type === "AiHome").props.onSend(); await settle();
  assert.equal(app.calls.filter((call) => call.path.endsWith("/messages")).length, 0);
  app.welcome.value.models.chat = null;
  app.render().find((node) => node.type === "AiHome").props.onSend(); await settle();
  const modelCalls = app.calls.filter((call) => call.path.endsWith("/model"));
  assert.deepEqual(modelCalls.map((call) => call.body.model_id), ["model", null]);
  assert.equal(app.calls.filter((call) => call.path === "/conversations" && call.method === "POST").length, 1);
  assert.equal(app.calls.filter((call) => call.path.endsWith("/messages")).length, 1); app.unmount();
});
