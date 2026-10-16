import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ApiError } from "../src/api.ts";

const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const queued = (id = "source", extra = {}) => ({ id, message_id: `message-${id}`, conversation_id: "c1", kind: "chat", status: "queued", phase: "normal", started_at: null, cancel_requested: false, prompt: `Prompt ${id}`, created_at: "2026-10-15T00:00:00Z", ...extra });
const target = (id = "target", extra = {}) => queued(id, { status: "running", started_at: "2026-10-15T00:00:00Z", ...extra });

function hooks() {
  const slots = [], effects = []; let cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
  };
  return { react, render(fn) { cursor = 0; const result = fn(); effects.splice(0).forEach((effect) => effect()); return result; }, unmount() { slots.forEach((value) => value?.cleanup?.()); } };
}
function load(deps) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL("../src/useQueuedMessages.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, AbortController, require(id) { assert.ok(id in deps, id); return deps[id]; } });
  return exports;
}
function harness(post = async () => ({})) {
  const lifecycle = hooks(), calls = [], errors = []; let changed = 0;
  const { useQueuedMessages, getQueuedMessages } = load({ react: lifecycle.react,
    "./api": { ApiError, request: async (_connection, path, options) => { const call = { path, ...options }; calls.push(call); return post(call, calls.length); } },
    "./ui": { humanError: (error) => error.message },
  });
  const args = { connection: { url: "https://queue-fixture.invalid", token: "fixture" }, conversationId: "c1", runs: [queued()], running: target(), onChanged: () => changed++, onError: (message) => errors.push(message) };
  return { args, calls, errors, changed: () => changed, getQueuedMessages, render: () => lifecycle.render(() => useQueuedMessages(args)), unmount: lifecycle.unmount };
}

test("queue selection includes only ordinary unstarted chat inputs and keeps sorted attachments", () => {
  const app = harness();
  const image = { id: "image", mime_type: "image/png", name: "screen.png" };
  const accepted = [queued("later", { seq: 3 }), queued("first", { seq: 1, attachments: [image] })];
  const excluded = [
    queued("forwarded", { origin: "agent_message" }),
    queued("running", { status: "running" }), queued("task", { kind: "task" }),
    ...["approval", "input", "recovering"].map((phase) => queued(phase, { phase })),
    queued("started", { started_at: "2026-10-15T00:00:00Z" }), queued("unknown-start", { started_at: undefined }),
    queued("cancelled", { status: "cancelled" }), queued("cancelling", { cancel_requested: true }),
    queued("other-conversation", { conversation_id: "c2" }), queued("missing-message", { message_id: undefined }),
  ];
  const items = plain(app.getQueuedMessages([...accepted, ...excluded], "c1"));
  assert.deepEqual(items.map((item) => item.run.id), ["first", "later"]);
  assert.deepEqual(items[0].attachments, [image]); assert.equal(items[0].text, "Prompt first");
  assert.deepEqual(items[1].attachments, []);
  const byDate = app.getQueuedMessages([queued("newer", { created_at: "2026-10-16" }), queued("older", { created_at: "2026-10-14" })], "c1");
  assert.deepEqual(plain(byDate.map((item) => item.run.id)), ["older", "newer"]); app.unmount();
});

test("withdraw uses the guarded queued endpoint, stays visible pending, and hides only after success", async () => {
  const response = deferred(), app = harness(() => response.promise);
  const value = app.render(), item = value.items[0]; const sending = value.withdraw(item);
  assert.equal(app.render().items.length, 1); assert.equal(app.render().busyId, "source");
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].path, "/runs/source/queued/withdraw");
  assert.equal(app.calls[0].method, "POST"); assert.equal(app.calls[0].body, undefined);
  assert.ok(app.calls.every((call) => !call.path.endsWith("/cancel")));
  assert.equal(app.changed(), 0);
  response.resolve({}); await sending;
  assert.equal(app.render().items.length, 0); assert.equal(app.render().busyId, null);
  assert.equal(app.changed(), 1); app.unmount();
});

test("guide binds an explicit running target and never cancels or resubmits the user message", async () => {
  const app = harness(); const value = app.render(); await value.steer(value.items[0]);
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].path, "/runs/source/queued/steer");
  assert.deepEqual(plain(app.calls[0].body), { target_run_id: "target" });
  assert.equal(app.calls[0].method, "POST"); assert.equal(app.render().items.length, 0); app.unmount();
});

test("a lost response retries the identical target even if another reply becomes current", async () => {
  const app = harness(async (_call, count) => { if (count === 1) throw new Error("response lost"); return {}; });
  let value = app.render(); await assert.rejects(value.steer(value.items[0]), /response lost/);
  assert.equal(app.render().items.length, 1); assert.ok(app.render().error);
  app.args.running = target("later-target"); value = app.render(); await value.steer(value.items[0]);
  assert.deepEqual(app.calls.map((call) => plain(call.body)), [{ target_run_id: "target" }, { target_run_id: "target" }]);
  assert.ok(app.calls.every((call) => call.path === "/runs/source/queued/steer"));
  assert.equal(app.render().items.length, 0); app.unmount();
});

test("synchronous busy lock prevents repeated taps and competing source actions", async () => {
  const response = deferred(), app = harness(() => response.promise);
  app.args.runs.push(queued("second"));
  const value = app.render(), first = value.steer(value.items[0]);
  await Promise.all([value.steer(value.items[0]), value.withdraw(value.items[0]), value.withdraw(value.items[1])]);
  assert.equal(app.calls.length, 1); assert.equal(app.render().busyId, "source");
  response.resolve({}); await first; assert.equal(app.render().busyId, null); app.unmount();
});

test("a 409 keeps the queue input, refreshes server state and reports the conflict", async () => {
  const app = harness(async () => { throw new ApiError("already claimed", "stale_queue", 409); });
  const value = app.render(); await assert.rejects(value.withdraw(value.items[0]), /already claimed/);
  assert.equal(app.render().items.length, 1); assert.equal(app.render().busyId, null);
  assert.match(app.render().error, /已开始|队列|already claimed/); assert.deepEqual(app.errors, [app.render().error]);
  assert.equal(app.changed(), 1); assert.equal(app.calls.length, 1); app.unmount();
});

test("guide does nothing without an eligible current target or for an item from another conversation", async () => {
  for (const running of [null, target("foreign", { conversation_id: "c2" }), target("cancelled", { cancel_requested: true }), target("finished", { status: "completed" })]) {
    const app = harness(); app.args.running = running;
    const value = app.render(); await value.steer(value.items[0]); assert.equal(app.calls.length, 0); app.unmount();
  }
  const app = harness(), value = app.render(); await value.withdraw({ run: queued("foreign", { conversation_id: "c2" }), text: "", attachments: [] });
  assert.equal(app.calls.length, 0); app.unmount();
});

for (const change of ["conversation", "connection", "unmount"]) {
  test(`${change} aborts pending actions and ignores their late successful response`, async () => {
    const response = deferred(), app = harness(() => response.promise);
    const value = app.render(), sending = value.withdraw(value.items[0]);
    if (change === "conversation") { app.args.conversationId = "c2"; app.args.runs = [queued("new", { conversation_id: "c2" })]; app.render(); }
    else if (change === "connection") { app.args.connection = { url: "https://another-fixture.invalid", token: "fixture-other" }; app.render(); }
    else app.unmount();
    assert.equal(app.calls[0].signal.aborted, true);
    response.resolve({}); await sending; await settle();
    assert.equal(app.changed(), 0); assert.deepEqual(app.errors, []);
    if (change !== "unmount") { const current = app.render(); assert.equal(current.busyId, null); assert.equal(current.error, ""); assert.equal(current.items.length, 1); app.unmount(); }
  });
}

test("an aborted action cannot surface a late rejection into another conversation", async () => {
  const response = deferred(), app = harness(() => response.promise);
  const value = app.render(), sending = value.steer(value.items[0]);
  app.args.conversationId = "c2"; app.render(); response.reject(new Error("late old failure"));
  await sending; assert.equal(app.render().error, ""); assert.deepEqual(app.errors, []); assert.equal(app.changed(), 0); app.unmount();
});
