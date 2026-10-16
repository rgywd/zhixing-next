import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as api from "../src/api.ts";
import * as live from "../src/liveRun.ts";
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const run = (id = "r1", status = "running") => ({ id, conversation_id: "c1", kind: "chat", status, result: null, phase: "normal", created_at: "2026-10-15T00:00:00Z", cancel_requested: false });
const event = (seq, type, data = {}, run_id = "r1") => ({ seq, type, data, run_id, created_at: "2026-10-15T00:00:00Z" });
const reset = (seq = 1, stream_id = "s1", run_id = "r1") => event(seq, "assistant.reset", { stream_id }, run_id);
const snapshot = (seq, text, extra = {}) => event(seq, "assistant.snapshot", { stream_id: "s1", message_id: "m1", text, ...extra });

test("snapshots replace text across replay and out-of-order pages without duplicating tokens", () => {
  let value = live.mergeLiveRunEvents(live.newLiveRun("r1"), [snapshot(3, "Hello world"), reset(), snapshot(2, "Hello")]);
  assert.equal(live.liveRunView(run(), value, []).content, "Hello world");
  value = live.mergeLiveRunEvents(value, [snapshot(2, "Hello"), snapshot(3, "Hello world"), snapshot(4, "Hello world!")]);
  assert.equal(live.liveRunView(run(), value, []).content, "Hello world!");
  assert.equal(value.cursor, 4);
});
test("run and stream identities isolate retries; reasoning is only actual model text", () => {
  let value = live.mergeLiveRunEvents(live.newLiveRun("r1"), [reset(), snapshot(2, "Old attempt"), event(3, "reasoning.snapshot", { stream_id: "s1", message_id: "m1", text: "Actual reasoning" })]);
  assert.equal(live.liveRunView(run(), value, []).reasoning, "Actual reasoning");
  value = live.mergeLiveRunEvents(value, [reset(4, "s2"), snapshot(5, "Late old stream"), event(6, "assistant.snapshot", { stream_id: "s2", message_id: "m2", text: "New attempt" }), event(99, "assistant.snapshot", { stream_id: "s2", message_id: "m3", text: "Other run" }, "r2")]);
  const view = live.liveRunView(run(), value, []);
  assert.equal(view.content, "New attempt"); assert.equal(view.reasoning, ""); assert.equal(value.cursor, 6);
  assert.equal(live.liveRunView(run("r2"), value, []).content, "");
});
test("tool-only progress is visible and stores no raw arguments, results or metadata", () => {
  const secret = "fictional-private-tool-value";
  let value = live.mergeLiveRunEvents(live.newLiveRun("r1"), [event(1, "tool", { tool: "web_search", tool_call_id: "call-1", status: "started", args: { token: secret }, output: secret, metadata: { trace: secret } })]);
  assert.deepEqual(value.tools, [{ id: "call-1", name: "web_search", status: "started" }]);
  assert.ok(live.liveRunView(run(), value, [])); assert.equal(value.segments.length, 0);
  value = live.mergeLiveRunEvents(value, [event(2, "tool", { tool: "web_search", tool_call_id: "call-1", status: "completed", output: secret }), event(3, "tool", { tool: "not a safe name\n" + secret, status: "started" })]);
  assert.equal(value.tools.length, 1); assert.equal(value.tools[0].status, "completed");
  assert.ok(!JSON.stringify(value).includes(secret));
});
test("final persisted message suppresses live answer without discarding real reasoning or tools", () => {
  const value = live.mergeLiveRunEvents(live.newLiveRun("r1"), [reset(), snapshot(2, "partial"), event(3, "reasoning.snapshot", { stream_id: "s1", message_id: "m1", text: "Actual thought" }), event(4, "completed")]);
  const completed = { ...run("r1", "completed"), result: "Final answer" };
  assert.equal(live.liveRunView(completed, value, []).content, "Final answer");
  const persisted = [{ role: "assistant", run_id: "r1", content: "Final answer" }];
  assert.equal(live.liveRunView(completed, value, persisted).content, "");
  assert.equal(live.liveRunView(completed, value, persisted).reasoning, "Actual thought");
  assert.equal(live.liveRunView(completed, live.newLiveRun("r1"), persisted), null);
});
test("malformed snapshots cannot inject huge or cross-run data and unsupported events still advance cursor", () => {
  const value = live.mergeLiveRunEvents(live.newLiveRun("r1"), [reset(), snapshot(2, "x".repeat(65537)), snapshot(3, { body: "invalid" }), event(4, "private.trace", { token: "fictional-secret" }), event(NaN, "assistant.reset", { stream_id: "bad" })]);
  assert.equal(value.cursor, 4); assert.equal(value.segments.length, 0); assert.ok(!JSON.stringify(value).includes("fictional-secret"));
});

function hooks() {
  const slots = [], effects = []; let cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
    useCallback(callback, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) slots[i] = { callback, deps }; return slots[i].callback; },
  };
  return { react, render(fn) { cursor = 0; const result = fn(); effects.splice(0).forEach((f) => f()); return result; }, unmount() { slots.forEach((v) => v?.cleanup?.()); } };
}
function load(file, deps, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(code, { exports, AbortController, setTimeout, clearTimeout, ...globals, require(id) { assert.ok(id in deps, id); return deps[id]; } }); return exports;
}
function harness({ initial = { text: "", pending: null }, preference = "queue", preferenceReady = true, read, events = async () => ({ items: [], next_cursor: null }) } = {}) {
  const lifecycle = hooks(), calls = [], timers = new Map(), listeners = new Set(); let sequence = 0, stored = plain(initial), currentRuns = [run()], messages = [];
  const appState = { currentState: "active", addEventListener(_name, f) { listeners.add(f); return { remove: () => listeners.delete(f) }; } };
  const later = (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; };
  const sync = () => {};
  const args = { connection: { url: "https://fixture.test", token: "fictional" }, conversation: { id: "c1" }, onRefresh() {}, defaultIntent: preference, defaultIntentReady: preferenceReady };
  const { useChat } = load("useChat.ts", {
    react: lifecycle.react, "react-native": { AppState: appState, Alert: { alert() {} } }, "expo-crypto": { randomUUID: () => `out-${++sequence}` }, "expo-speech": { stop: async () => {} },
    "./liveRun": live, "./ConnectionStatus": { useSyncStatus: () => sync }, "./ui": { humanError: (e) => e.message },
    "./storage": { draftKey: (url, id) => `${url}:${id}`, readDraft: async () => plain(stored), saveDraft: async (_key, value) => { stored = plain(value); }, clearDraft: async () => { stored = { text: "", pending: null }; } },
    "./api": { ...api, request: async (connection, path, options = {}) => {
      const call = { connection, path, ...options }; calls.push(call);
      if (path.includes("/events?")) return events(call);
      const overridden = read?.(call); if (overridden) return overridden;
      if (options.method === "POST") return { message: { ...options.body, role: "user", conversation_id: args.conversation.id, seq: 1 }, run: run("new", "queued") };
      return { items: path.includes("/messages?") ? messages : path.includes("status=running") ? currentRuns.filter((v) => v.status === "running") : currentRuns, next_cursor: null, previous_cursor: null };
    } },
  }, { setTimeout: later, clearTimeout: (id) => timers.delete(id), setInterval: later, clearInterval: (id) => timers.delete(id) });
  const render = () => lifecycle.render(() => useChat(args));
  return { render, calls, args, timers, stored: () => stored, unmount: lifecycle.unmount,
    async ready() { render(); await settle(); render(); await settle(); return render(); },
    setRuns(value) { currentRuns = value; }, setMessages(value) { messages = value; },
    setAppState(state) { appState.currentState = state; [...listeners].forEach((f) => f(state)); },
    async timer(ms) { const entry = [...timers].find(([, v]) => v.ms === ms); assert.ok(entry, `timer ${ms}`); timers.delete(entry[0]); entry[1].fn(); await settle(); return render(); },
  };
}
test("event pages catch up at 100ms then poll at 800ms; reconnect replays after the retained cursor", async () => {
  let attempt = 0;
  const app = harness({ events: async ({ path }) => {
    attempt++;
    if (attempt === 1) return { items: [reset(), snapshot(2, "First")], next_cursor: "2" };
    assert.match(path, /after=2/);
    if (attempt === 2) throw new Error("disconnected");
    return { items: [snapshot(2, "First"), snapshot(3, "First second")], next_cursor: null };
  } });
  let value = await app.ready(); assert.equal(value.liveRun.content, "First");
  value = await app.timer(100); assert.equal(value.liveRun.connectionIssue, true); assert.equal(value.liveRun.content, "First");
  value = await app.timer(800); assert.equal(value.liveRun.content, "First second"); assert.equal(value.liveRun.connectionIssue, false); app.unmount();
});
test("background and unmount abort event requests and ignore transports that resolve late", async () => {
  const pending = deferred(); let eventCalls = 0;
  const app = harness({ events: () => { eventCalls++; return eventCalls === 1 ? pending.promise : Promise.resolve({ items: [reset(), snapshot(2, "Resumed")], next_cursor: null }); } });
  await app.ready(); const first = app.calls.find((v) => v.path.includes("/events?"));
  app.setAppState("background"); assert.equal(first.signal.aborted, true);
  pending.resolve({ items: [reset(), snapshot(2, "Late background")], next_cursor: null }); await settle();
  assert.equal(app.render().liveRun.content, "");
  app.setAppState("active"); await settle(); assert.equal(app.render().liveRun.content, "Resumed");
  app.unmount(); assert.equal(app.timers.size, 0);
});
test("changing run or connection aborts old requests and cannot leak the old stream", async () => {
  const pending = deferred();
  const app = harness({ events: ({ path }) => path.includes("/r1/") ? pending.promise : Promise.resolve({ items: [reset(4, "s2", "r2"), event(5, "assistant.snapshot", { stream_id: "s2", message_id: "m2", text: "Second run" }, "r2")], next_cursor: null }) });
  await app.ready(); const old = app.calls.find((v) => v.path.includes("/events?"));
  app.setRuns([run("r2")]); app.render().refresh.current(); await settle(); app.render(); await settle();
  assert.equal(old.signal.aborted, true); pending.resolve({ items: [reset(), snapshot(2, "Old run")], next_cursor: null }); await settle();
  assert.equal(app.render().liveRun.content, "Second run");
  app.args.connection = { url: "https://other-fixture.test", token: "fictional-other" };
  assert.equal(app.render().liveRun, null); await settle(); app.unmount();
});
test("persisting the final message removes only the streaming duplicate", async () => {
  const app = harness({ events: async () => ({ items: [reset(), snapshot(2, "Partial")], next_cursor: null }) });
  let value = await app.ready(); assert.equal(value.liveRun.content, "Partial");
  app.setRuns([{ ...run("r1", "completed"), result: "Final" }]); app.setMessages([{ id: "answer", role: "assistant", run_id: "r1", conversation_id: "c1", content: "Final", seq: 2 }]);
  value.refresh.current(); await settle(); value = app.render(); assert.equal(value.liveRun, null); assert.equal(value.messages[0].content, "Final"); app.unmount();
});
test("reentering a completed conversation replays actual metadata without rendering another final answer", async () => {
  const items = [reset(), snapshot(2, "Final"), event(3, "reasoning.snapshot", { stream_id: "s1", message_id: "m1", text: "Actual thought" }), event(4, "tool", { tool: "web_search", tool_call_id: "call", status: "completed" }), event(5, "completed")];
  for (let entry = 0; entry < 2; entry++) {
    const app = harness({ events: async () => ({ items, next_cursor: null }) });
    app.setRuns([{ ...run("r1", "completed"), result: "Final" }]);
    app.setMessages([{ id: "answer", role: "assistant", run_id: "r1", conversation_id: "c1", content: "Final", seq: 2 }]);
    const value = await app.ready();
    assert.equal(value.liveRun.content, ""); assert.equal(value.liveRun.reasoning, "Actual thought"); assert.equal(value.liveRun.tools.length, 1);
    assert.ok(![...app.timers.values()].some((timer) => timer.ms === 800)); app.unmount();
  }
});
test("resuming the same interrupted run keeps polling through empty pages before fresh model output", async () => {
  let calls = 0, restarted = false;
  const app = harness({ events: async ({ path }) => {
    calls++;
    if (calls === 1) return { items: [reset(), snapshot(2, "Before interruption"), event(3, "interrupted")], next_cursor: null };
    assert.match(path, /after=3/);
    return { items: restarted ? [reset(4, "s2"), event(5, "assistant.snapshot", { stream_id: "s2", message_id: "m2", text: "Resumed reply" })] : [], next_cursor: null };
  } });
  app.setRuns([run("r1", "interrupted")]); let value = await app.ready();
  assert.equal(value.liveRun.content, "Before interruption");
  assert.ok(![...app.timers.values()].some((timer) => timer.ms === 800));
  app.setRuns([{ ...run("r1", "queued"), phase: "recovering" }]); value.refresh.current(); await settle(); value = app.render(); await settle();
  assert.ok([...app.timers.values()].some((timer) => timer.ms === 800), "queued recovery must keep polling even when its event page is still empty");
  app.setRuns([run("r1")]); value.refresh.current(); await settle(); app.render(); await settle();
  restarted = true; value = await app.timer(800);
  assert.equal(value.liveRun.run.id, "r1"); assert.equal(value.liveRun.content, "Resumed reply"); app.unmount();
});
test("a new queued follow-up does not hide the queue head waiting for approval or input", async () => {
  for (const phase of ["approval", "input"]) {
    const head = { ...run("r1", "queued"), phase };
    const app = harness({ events: async ({ path }) => ({ items: path.includes("/r1/") ? [reset(), event(2, "reasoning.snapshot", { stream_id: "s1", message_id: "m1", text: "Actual head reasoning" }), event(3, "tool", { tool: "write_text_file", tool_call_id: "call", status: "started" }), event(4, "paused", { reason: phase })] : [], next_cursor: null }) });
    app.setRuns([head]); let value = await app.ready(); assert.equal(value.liveRun.run.id, "r1");
    app.setRuns([head, run("r2", "queued")]); value.refresh.current(); await settle(); value = app.render(); await settle(); value = app.render();
    assert.equal(value.pendingRuns[0].id, "r1"); assert.equal(value.liveRun.run.id, "r1");
    assert.equal(value.liveRun.reasoning, "Actual head reasoning"); assert.equal(value.liveRun.tools[0].id, "call"); app.unmount();
  }
});
test("background cancels incomplete history batches and late unmounted event responses are ignored", async () => {
  const pendingHistory = deferred(); let first = true;
  const app = harness({ read: ({ path }) => { if (first && path.includes("/messages?")) { first = false; return pendingHistory.promise; } } });
  app.render(); await settle(); const historyCall = app.calls.find((v) => v.path.includes("/messages?"));
  app.setAppState("inactive"); assert.equal(historyCall.signal.aborted, true);
  pendingHistory.resolve({ items: [{ id: "late", conversation_id: "c1", role: "assistant", run_id: "r1", seq: 2, content: "Late history" }], next_cursor: null });
  await settle(); assert.equal(app.render().messages.length, 0); app.unmount();
  const pendingEvent = deferred(), leaving = harness({ events: () => pendingEvent.promise });
  await leaving.ready(); const call = leaving.calls.find((v) => v.path.includes("/events?")); leaving.unmount(); assert.equal(call.signal.aborted, true);
  pendingEvent.resolve({ items: [reset(), snapshot(2, "Late unmounted")], next_cursor: null }); await settle();
  assert.equal(leaving.render().liveRun.content, "");
});
test("steer binds when typing begins and a finished target never silently becomes a newer run", async () => {
  const app = harness({ preference: "steer" }); let value = await app.ready();
  await value.updateDraft({ text: "Additional detail", pending: null }); value = app.render();
  assert.equal(value.intent, "steer"); assert.equal(value.target, "r1"); assert.equal(app.stored().delivery.target_run_id, "r1");
  app.setRuns([run("r2")]); value.refresh.current(); await settle(); value = app.render();
  await value.send(); value = app.render(); assert.match(value.error, /原目标已经结束/); assert.equal(app.calls.filter((v) => v.method === "POST").length, 0);
  value.setIntent("queue"); value.setTarget(null); value = app.render(); await value.send();
  assert.equal(app.calls.find((v) => v.method === "POST").body.intent, "queue"); app.unmount();
});
test("idle drafts remain queued when another run starts and pending retry ignores preference readiness", async () => {
  const idle = harness({ preference: "steer" }); idle.setRuns([]); let value = await idle.ready();
  await value.updateDraft({ text: "Idle draft", pending: null }); idle.setRuns([run()]); value.refresh.current(); await settle(); value = idle.render(); await value.send();
  assert.equal(idle.calls.find((v) => v.method === "POST").body.intent, "queue"); idle.unmount();
  const pending = { id: "immutable", content: "Pending", kind: "chat", intent: "steer", target_run_id: "ended" };
  const retry = harness({ initial: { text: "Pending", pending }, preference: "queue", preferenceReady: false }); value = await retry.ready(); await value.send({ model_id: "ignored" });
  assert.deepEqual(plain(retry.calls.find((v) => v.method === "POST").body), pending); retry.unmount();
  const blocked = harness({ initial: { text: "New draft", pending: null }, preferenceReady: false }); value = await blocked.ready(); await value.send();
  assert.equal(blocked.calls.filter((v) => v.method === "POST").length, 0); blocked.unmount();
});
test("attachment-only steer binds its initial target and that binding survives draft restoration", async () => {
  const app = harness({ preference: "steer" }); let value = await app.ready();
  await value.updateDraft({ text: "", attachments: [{ id: "fixture-file" }], pending: null });
  const saved = app.stored(); value = app.render(); await value.send({ model_id: "not-for-steer" });
  const posted = app.calls.find((v) => v.method === "POST").body;
  assert.equal(posted.intent, "steer"); assert.equal(posted.target_run_id, "r1"); assert.deepEqual(plain(posted.attachments), ["fixture-file"]); assert.equal(posted.model_id, undefined); app.unmount();
  const restored = harness({ initial: saved, preference: "queue" }); restored.setRuns([run("r2")]); value = await restored.ready();
  assert.equal(value.target, "r1"); await value.send(); assert.equal(restored.calls.filter((v) => v.method === "POST").length, 0); assert.match(restored.render().error, /原目标已经结束/); restored.unmount();
});
test("legacy text and text begun before preferences load stay queued after the default becomes steer", async () => {
  const legacy = harness({ initial: { text: "Legacy unsent text", pending: null }, preference: "steer" });
  let value = await legacy.ready(); assert.equal(value.intent, "queue"); await value.send();
  assert.equal(legacy.calls.find((v) => v.method === "POST").body.intent, "queue"); legacy.unmount();
  const reading = harness({ preference: "steer", preferenceReady: false }); value = await reading.ready();
  await value.updateDraft({ text: "Typed while reading preferences", pending: null }); value = reading.render();
  assert.equal(value.intent, "queue"); await value.send(); assert.equal(reading.calls.filter((v) => v.method === "POST").length, 0);
  reading.args.defaultIntentReady = true; value = reading.render(); assert.equal(value.intent, "queue"); await value.send();
  const posted = reading.calls.find((v) => v.method === "POST").body;
  assert.equal(posted.intent, "queue"); assert.equal(posted.target_run_id, undefined); reading.unmount();
});

test("an original queue pending request settles from the same promoted message receipt without resubmission", async () => {
  const pending = { id: "original-id", content: "Keep original content", intent: "queue", kind: "chat", attachments: ["image", "document"] };
  const initial = { text: pending.content, pending, attachments: [{ id: "image" }, { id: "document" }] };
  const app = harness({ initial });
  app.setMessages([{ id: pending.id, conversation_id: "c1", role: "user", content: pending.content,
    intent: "steer", submitted_intent: "queue", run_id: "target-reply", seq: 3, status: "accepted",
    attachments: [{ id: "document" }, { id: "image" }] }]);
  const value = await app.ready();
  assert.equal(value.draft.pending, null); assert.equal(value.draft.text, ""); assert.equal(app.stored().pending, null);
  assert.equal(app.calls.filter((call) => call.method === "POST").length, 0); app.unmount();
});

test("promoted receipts with mismatched original identity, content, intent or attachments never clear pending", async () => {
  const pending = { id: "original-id", content: "Keep original content", intent: "queue", kind: "chat", attachments: ["image"] };
  const receipt = { id: pending.id, conversation_id: "c1", role: "user", content: pending.content,
    intent: "steer", submitted_intent: "queue", run_id: "target-reply", seq: 3, status: "accepted", attachments: [{ id: "image" }] };
  for (const mismatch of [{ id: "another-id" }, { conversation_id: "c2" }, { role: "assistant" }, { content: "Changed" },
    { submitted_intent: undefined }, { submitted_intent: "steer" }, { attachments: [] }, { attachments: [{ id: "another-image" }] }]) {
    const app = harness({ initial: { text: pending.content, pending, attachments: [{ id: "image" }] } });
    app.setMessages([{ ...receipt, ...mismatch }]); const value = await app.ready();
    assert.equal(value.draft.pending.id, pending.id); assert.deepEqual(plain(app.stored().pending), pending);
    assert.equal(app.calls.filter((call) => call.method === "POST").length, 0); app.unmount();
  }
});

test("legacy live entry point delegates to the shared reply renderer without duplicating a committed answer", () => {
  const { LiveRunView } = load("LiveRunView.tsx", { "react/jsx-runtime": jsx, "./ReplyContent": { ReplyContent: "ReplyContent" } });
  const buffer = live.mergeLiveRunEvents(live.newLiveRun("r1"), [reset(), snapshot(2, "Partial answer"),
    event(3, "reasoning.snapshot", { stream_id: "s1", message_id: "m1", text: "Actual thought" })]);
  const running = LiveRunView({ value: live.liveRunView(run(), buffer, []) });
  assert.equal(running.type, "ReplyContent"); assert.equal(running.props.active, true);
  assert.equal(running.props.finalText, "Partial answer"); assert.equal(running.props.parts.length, 2);
  const persisted = [{ role: "assistant", run_id: "r1", content: "Final answer" }];
  const completed = LiveRunView({ value: live.liveRunView({ ...run("r1", "completed"), result: "Final answer" }, buffer, persisted) });
  assert.equal(completed.props.finalText, undefined); assert.deepEqual(completed.props.parts.map((part) => part.type), ["reasoning"]);
  for (const status of ["failed", "cancelled", "interrupted"]) {
    const ended = LiveRunView({ value: live.liveRunView({ ...run("r1", status), phase: "recovering", cancel_requested: true }, buffer, []) });
    assert.equal(ended.props.status, status); assert.equal(ended.props.active, false); assert.equal(ended.props.finalText, "Partial answer");
  }
  assert.equal(LiveRunView({ value: null }), null);
});
