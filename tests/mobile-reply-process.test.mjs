import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { ApiError } from "../src/api.ts";
import * as live from "../src/liveRun.ts";
import { conversationReplyRows, isPendingReply, replyRowKey } from "../src/replyProcess.ts";

const settle = async () => { for (let count = 0; count < 4; count++) await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const run = (id = "r1", status = "running", extra = {}) => ({ id, status, conversation_id: "c1", kind: "chat", phase: "normal", started_at: "2026-10-16T01:00:00Z", result: null, created_at: "2026-10-16T01:00:00Z", ...extra });
const part = (id, type, text) => ({ id, type, text, stream_id: "s1", message_id: id, seq: 2 });
const process = (id = "r1", status = "running", extra = {}) => ({ run_id: id, status, cursor: 2, stream_id: "s1", phase: "normal", parts: [part(`s1:${id}:text`, "text", `Answer ${id}`)], final_message_id: null, final_part_id: null, truncated: false, ...extra });
const event = (seq, type, data = {}, run_id = "r1") => ({ seq, type, data, run_id, created_at: "2026-10-16T01:00:00Z" });

function hooks() {
  const slots = [], effects = []; let cursor = 0;
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(effect, deps) { const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, offset) => value !== previous.deps[offset])) { slots[index] = { deps }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); }); } },
  };
  return { react, render(fn) { cursor = 0; const value = fn(); effects.splice(0).forEach((effect) => effect()); return value; }, unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}
function harness({ projection, events, stream } = {}) {
  const lifecycle = hooks(), calls = [], streams = [], timers = new Map(), listeners = new Set(); let timerId = 0, done = 0;
  const processes = new Map([["r1", process()]]);
  const appState = { currentState: "active", addEventListener(_name, callback) { listeners.add(callback); return { remove: () => listeners.delete(callback) }; } };
  const args = { connection: { url: "https://reply-fixture.invalid", token: "fixture-token" }, conversationId: "c1", ids: ["r1"], runs: [run()] };
  class DisplayStreamUnavailable extends Error {}
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL("../src/useReplyProcesses.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dependencies = { react: lifecycle.react, "react-native": { AppState: appState }, "./liveRun": live,
    "./api": { ApiError, request: async (connection, path, options = {}) => {
      const call = { connection, path, ...options }; calls.push(call);
      if (path.includes("/reply-processes?")) {
        if (projection) return projection(call, calls.filter((item) => item.path.includes("/reply-processes?")).length, processes);
        const query = new URL(`https://fixture.invalid${path}`).searchParams;
        return { items: query.getAll("run_ids").map((id) => processes.get(id)).filter(Boolean) };
      }
      assert.match(path, /\/runs\/[^/]+\/events\?/);
      return events ? events(call) : { items: [], next_cursor: null };
    } },
    "./replyTransport": { DisplayStreamUnavailable, readDisplayStream: (connection, id, after, signal, accept) => {
      const pending = deferred(), item = { connection, id, after, signal, accept, ...pending }; streams.push(item);
      return stream ? stream(item, streams.length, DisplayStreamUnavailable) : pending.promise;
    } },
  };
  runInNewContext(source, { exports, AbortController, setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id), require(id) { assert.ok(id in dependencies, id); return dependencies[id]; } });
  const render = () => lifecycle.render(() => exports.useReplyProcesses(args.connection, args.conversationId, args.ids, args.runs, () => done++));
  const publish = () => { for (const [id, timer] of [...timers]) if (timer.delay === 48) { timers.delete(id); timer.fn(); } };
  const flush = async () => { await settle(); publish(); const value = render(); await settle(); return value; };
  return { args, calls, streams, timers, processes, done: () => done, render, flush, unmount: lifecycle.unmount,
    async ready() { render(); return flush(); },
    async timer(delay) { const entry = [...timers].find(([, value]) => value.delay === delay); assert.ok(entry, `expected timer ${delay}`); timers.delete(entry[0]); entry[1].fn(); return flush(); },
    setAppState(value) { appState.currentState = value; [...listeners].forEach((listener) => listener(value)); },
  };
}

test("completed replies restore independent reasoning and tools, and newly visible history hydrates once", async () => {
  const app = harness();
  app.processes.set("r1", process("r1", "completed", { final_message_id: "answer-1", final_part_id: "answer-part-1", parts: [part("thought-1", "reasoning", "Thought one"), { id: "tool-1", type: "tool", name: "query_finance", status: "completed", seq: 3 }, part("answer-part-1", "text", "Answer one")] }));
  app.processes.set("r2", process("r2", "completed", { final_message_id: "answer-2", final_part_id: "answer-part-2", parts: [part("thought-2", "reasoning", "Thought two"), part("answer-part-2", "text", "Answer two")] }));
  app.args.runs = [run("r1", "completed"), run("r2", "completed")];
  let records = await app.ready(); assert.equal(records.r1.buffer.parts[0].text, "Thought one"); assert.equal(records.r1.finalProjection, true);
  assert.equal(records.r2, undefined); assert.equal(app.streams.length, 0);
  app.args.ids = ["r1", "r2", "r2"]; app.render(); records = await app.flush();
  assert.equal(records.r1.buffer.parts[0].text, "Thought one"); assert.equal(records.r2.buffer.parts[0].text, "Thought two");
  assert.equal(records.r1.finalPartId, "answer-part-1"); assert.equal(records.r2.finalPartId, "answer-part-2");
  assert.match(app.calls[1].path, /run_ids=r2/); assert.ok(!app.calls[1].path.includes("run_ids=r1"));
  app.args.ids = ["r2"]; app.render(); await app.flush(); assert.equal(app.calls.length, 2); app.unmount();
});

test("SSE done refreshes the durable terminal projection and final part identity", async () => {
  const app = harness(); let records = await app.ready(); assert.equal(records.r1.status, "running"); assert.equal(app.streams.length, 1);
  const active = app.streams[0];
  app.processes.set("r1", process("r1", "completed", { cursor: 8, final_message_id: "answer-1", final_part_id: "s1:final:text", parts: [part("s1:final:text", "text", "Durable final")] }));
  active.accept({ done: true, status: "completed", cursor: 7 }); active.resolve(); records = await app.flush();
  assert.equal(records.r1.status, "completed"); assert.equal(records.r1.finalProjection, true); assert.equal(records.r1.finalPartId, "s1:final:text");
  assert.equal(records.r1.buffer.parts[0].text, "Durable final"); assert.equal(records.r1.buffer.cursor, 8); assert.equal(app.done(), 1);
  assert.equal(app.calls.filter((call) => call.path.includes("/reply-processes?")).length, 2); app.unmount();
});

test("list status arriving before SSE done aborts the old stream and still hydrates completion", async () => {
  const app = harness(); await app.ready(); const old = app.streams[0];
  app.processes.set("r1", process("r1", "completed", { cursor: 9, final_message_id: "answer", final_part_id: "durable", parts: [part("durable", "text", "Final from stored projection")] }));
  app.args.runs = [run("r1", "completed", { result: "Final from stored projection" })]; app.render(); assert.equal(old.signal.aborted, true);
  let records = await app.flush(); assert.equal(records.r1.status, "completed"); assert.equal(records.r1.finalPartId, "durable"); assert.equal(records.r1.finalProjection, true);
  old.accept(event(99, "assistant.snapshot", { stream_id: "s1", message_id: "old", text: "Late stale text" })); old.resolve(); records = await app.flush();
  assert.equal(records.r1.buffer.cursor, 9); assert.ok(!JSON.stringify(records).includes("Late stale text")); assert.equal(app.streams.length, 1); app.unmount();
});

for (const change of ["conversation", "connection", "unmount"]) {
  test(`${change} aborts in-flight streaming and ignores late events and terminal replies`, async () => {
    const app = harness(); await app.ready(); const old = app.streams[0];
    if (change === "conversation") { app.args.conversationId = "c2"; app.args.ids = ["r2"]; app.args.runs = [run("r2", "running", { conversation_id: "c2" })]; app.processes.set("r2", process("r2")); app.render(); }
    else if (change === "connection") { app.args.connection = { url: "https://other-fixture.invalid", token: "other-fictional" }; app.args.ids = ["r2"]; app.args.runs = [run("r2")]; app.processes.set("r2", process("r2")); app.render(); }
    else app.unmount();
    assert.equal(old.signal.aborted, true);
    old.accept(event(99, "assistant.snapshot", { stream_id: "s1", message_id: "late", text: "Late old connection" })); old.accept({ done: true, status: "completed", cursor: 100 }); old.resolve();
    if (change !== "unmount") { const records = await app.flush(); assert.equal(records.r1, undefined); assert.equal(records.r2.buffer.parts[0].text, "Answer r2"); assert.ok(!JSON.stringify(records).includes("Late old connection")); app.unmount(); }
    else await settle();
    assert.equal(app.done(), 0);
  });
}

test("background aborts transport, ignores late output, and resumes from the retained cursor", async () => {
  const app = harness(); await app.ready(); const old = app.streams[0]; assert.equal(old.after, 2);
  app.setAppState("background"); assert.equal(old.signal.aborted, true);
  old.accept(event(80, "assistant.snapshot", { stream_id: "s1", message_id: "old", text: "Background stale text" })); old.resolve();
  let records = await app.flush(); assert.equal(records.r1.buffer.cursor, 2);
  app.processes.set("r1", process("r1", "running", { cursor: 5, parts: [part("updated", "text", "Resumed content")] }));
  app.setAppState("active"); records = await app.flush(); assert.equal(records.r1.buffer.cursor, 5); assert.equal(app.streams.at(-1).after, 5);
  assert.ok(!JSON.stringify(records).includes("Background stale text")); app.unmount();
});

test("404 compact endpoint uses the compatible event cursor and 400ms polling", async () => {
  let count = 0;
  const app = harness({ projection: async () => { throw new ApiError("legacy", "not_found", 404); }, events: async () => ({ items: ++count === 1 ? [event(1, "assistant.reset", { stream_id: "s1" }), event(2, "assistant.snapshot", { stream_id: "s1", message_id: "m1", text: "Legacy partial" })] : [event(3, "completed")], next_cursor: null }) });
  let records = await app.ready(); assert.equal(app.streams.length, 0); assert.equal(records.r1.buffer.parts[0].text, "Legacy partial");
  assert.ok([...app.timers.values()].some((timer) => timer.delay === 400)); records = await app.timer(400);
  assert.equal(records.r1.status, "completed"); assert.equal(app.done(), 1); assert.match(app.calls.at(-1).path, /after=2/); app.unmount();
});

for (const status of [401, 503]) {
  test(`${status} compact endpoint failures stay on a 5s retry without downgrading to event polling`, async () => {
    const app = harness({ projection: async () => { throw new ApiError("unavailable", "fixture_error", status); } });
    let records = await app.ready(); assert.equal(records.r1.buffer.connectionIssue, true); assert.equal(app.streams.length, 0);
    assert.equal(app.calls.length, 1); assert.ok(app.calls.every((call) => !call.path.includes("/events?")));
    assert.deepEqual([...app.timers.values()].map((timer) => timer.delay), [5000]);
    records = await app.timer(5000); assert.equal(records.r1.buffer.connectionIssue, true); assert.equal(app.calls.length, 2);
    assert.ok(app.calls.every((call) => !call.path.includes("/events?"))); app.unmount();
  });
}

test("an ordinary unstarted queue never starts a display stream or event polling", async () => {
  const app = harness(); app.args.runs = [run("r1", "queued", { started_at: null })]; app.processes.set("r1", process("r1", "queued", { parts: [], cursor: 0, stream_id: null }));
  const records = await app.ready(); assert.equal(records.r1.status, "queued"); assert.equal(app.streams.length, 0); assert.equal(app.calls.filter((call) => call.path.includes("/events?")).length, 0); app.unmount();
});

test("streaming and persisted replies share one row identity and preserve message history", () => {
  const user = { id: "user", role: "user", conversation_id: "c1", run_id: "r1", seq: 1, content: "Question", status: "applied", intent: "queue" };
  const messages = [user]; const active = conversationReplyRows(messages, [run()], {}); assert.equal(active.length, 2); assert.equal(isPendingReply(active[1]), true);
  const final = { id: "persisted-answer", role: "assistant", conversation_id: "c1", run_id: "r1", seq: 2, content: "Answer", intent: "queue", status: "applied" };
  assert.equal(replyRowKey(active[1]), replyRowKey(final));
  const finished = conversationReplyRows([user, final], [run("r1", "completed", { result: "Answer" })], {});
  assert.deepEqual(finished, [user, final]); assert.equal(isPendingReply(final), false); assert.equal(replyRowKey(user), "user");
  assert.equal(replyRowKey({ ...final, origin: "assistant_task" }), "persisted-answer");
  assert.deepEqual(messages, [user], "input message array is never mutated");
});

test("cancelled unstarted queue has no invented assistant reply even with stale cached parts", () => {
  const message = { id: "queued-input", role: "user", run_id: "queue", seq: 5, content: "Pending question", intent: "queue", status: "rejected" };
  const cached = { queue: { buffer: live.hydrateLiveRun(process("queue", "running")), status: "running", finalPartId: null } };
  assert.deepEqual(conversationReplyRows([message], [run("queue", "cancelled", { started_at: null })], cached), [message]);
  assert.deepEqual(conversationReplyRows([message], [run("queue", "queued", { started_at: null })], cached), [message]);
  assert.deepEqual(conversationReplyRows([], [run()], {}), []);
});

for (const phase of ["approval", "input", "recovering"]) {
  test(`a started run paused for ${phase} keeps its own reply row and restores its process`, async () => {
    const paused = run("r1", "queued", { phase });
    const user = { id: "input", role: "user", run_id: "r1", conversation_id: "c1", seq: 1, content: "Question", intent: "queue", status: "applied" };
    const app = harness(); app.args.runs = [paused];
    app.processes.set("r1", process("r1", "queued", { phase, cursor: 4, parts: [part("reasoning", "reasoning", "Actual thought before pause"),
      { id: "tool:receipt", type: "tool", name: "record_meal", status: "started", seq: 3 }, part("before-pause", "text", "Need your decision before continuing")] }));
    const records = await app.ready();
    assert.equal(records.r1.buffer.parts[0].text, "Actual thought before pause"); assert.equal(records.r1.buffer.phase, phase);
    const rows = conversationReplyRows([user], [paused], records);
    assert.equal(rows.length, 2); assert.equal(rows[1].run_id, "r1"); assert.equal(replyRowKey(rows[1]), "reply:r1");
    assert.equal(app.streams.length, 1, "paused execution keeps receiving its eventual result"); app.unmount();
  });
}

test("a queued follow-up does not move an earlier reply when its durable final arrives", () => {
  const first = { id: "first-input", role: "user", run_id: "r1", conversation_id: "c1", seq: 1, content: "First question", intent: "queue", status: "applied" };
  const follow = { id: "queued-input", role: "user", run_id: "r2", conversation_id: "c1", seq: 2, content: "Follow-up question", intent: "queue", status: "accepted" };
  const final = { id: "durable-first", role: "assistant", run_id: "r1", conversation_id: "c1", seq: 3, content: "First answer", intent: "queue", status: "applied" };
  const queued = run("r2", "queued", { started_at: null });
  const streaming = conversationReplyRows([first, follow], [run(), queued], {});
  const finished = conversationReplyRows([first, follow, final], [run("r1", "completed", { result: "First answer" }), queued], {});
  assert.deepEqual(streaming.map(replyRowKey), ["first-input", "reply:r1", "queued-input"]);
  assert.deepEqual(finished.map(replyRowKey), streaming.map(replyRowKey));
  assert.equal(finished[1], final); assert.equal(finished.filter((message) => message.role === "assistant").length, 1);
  assert.deepEqual([first, follow, final].map((message) => message.seq), [1, 2, 3], "display grouping does not rewrite server message order");
});
