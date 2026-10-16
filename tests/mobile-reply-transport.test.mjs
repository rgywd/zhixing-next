import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
const event = (seq = 1, text = "正文 😀") => ({ seq, run_id: "run/a b", type: "assistant.snapshot", data: { stream_id: "s", message_id: "m", text }, created_at: "now" });
const frame = (type, value, id) => `${id == null ? "" : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
const finish = (extra = {}) => frame("done", { run_id: "run/a b", status: "completed", cursor: 3, ...extra });
const connection = { url: "https://isolated.invalid/assistant/", token: "synthetic-token" };

function load(fetcher = async () => { throw new Error("unexpected fetch"); }) {
  const exports = {}, timers = new Map(), requests = []; let sequence = 0;
  const code = ts.transpileModule(readFileSync(new URL("../src/replyTransport.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, AbortController, TextDecoder,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(id) {
      if (id === "expo/fetch") return { fetch: async (url, options) => { requests.push({ url, ...options }); return fetcher(url, options); } };
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  return { ...exports, timers, requests };
}
function response(chunks, { status = 200, contentType = "text/event-stream", emptyBody = false, read, cancel } = {}) {
  let at = 0, cancelled = 0;
  const reader = { async read() { return read ? read(at++) : at < chunks.length ? { value: chunks[at++], done: false } : { done: true }; },
    async cancel() { cancelled++; await cancel?.(); } };
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": contentType }), body: emptyBody ? null : { getReader: () => reader }, cancelled: () => cancelled };
}
const bytes = (text) => new TextEncoder().encode(text);

// Parser tests deliberately split lines, CRLF pairs and frame boundaries independently.
test("SSE parser preserves multiline data, Chinese and emoji across arbitrary string chunks", () => {
  const transport = load(), received = [];
  const parse = transport.displayFrameParser((item) => received.push(plain(item)));
  const wire = ': heartbeat\r\nid: 7\r\nevent: display\r\ndata: {"text":\r\ndata: "中文😀"}\r\n\r\n';
  for (const character of wire.split("")) parse(character);
  assert.deepEqual(received, [{ event: "display", id: "7", data: '{"text":\n"中文😀"}' }]);
});
test("SSE comments and empty frames do not dispatch; incomplete EOF is never applied", () => {
  const received = [], parse = load().displayFrameParser((item) => received.push(plain(item)));
  parse(": heartbeat\n\n\nevent: display\ndata: unfinished", true);
  assert.deepEqual(received, []);
  parse("data: complete\n\n");
  assert.deepEqual(received, [{ event: "message", id: "", data: "complete" }]);
});
test("SSE parser accepts a large network chunk containing individually bounded complete frames", () => {
  let received = 0;
  const parse = load().displayFrameParser(() => received++);
  const one = `event: display\ndata: ${"x".repeat(20_000)}\n\n`;
  parse(one.repeat(60));
  assert.equal(received, 60);
});
test("SSE parser bounds one unfinished line and a multiline frame accumulated across chunks", () => {
  assert.throws(() => load().displayFrameParser(() => {})("x".repeat(1_048_577)), /过长/);
  const parse = load().displayFrameParser(() => {});
  assert.throws(() => { for (let i = 0; i < 60; i++) parse(`data: ${"x".repeat(20_000)}\n`); }, /过长/);
});

test("stream uses authenticated encoded route, decodes split UTF-8 and releases its reader after done", async () => {
  const wire = frame("display", event(), 1) + frame("cursor", { cursor: 2 }, 2) + finish();
  const encoded = bytes(wire), chunks = Array.from(encoded, (byte) => new Uint8Array([byte]));
  const incoming = response(chunks), transport = load(async () => incoming), accepted = [];
  await transport.readDisplayStream(connection, "run/a b", 9, new AbortController().signal, (value) => accepted.push(plain(value)));
  assert.equal(transport.requests[0].url, "https://isolated.invalid/assistant/v1/runs/run%2Fa%20b/display-stream?after=9");
  assert.equal(transport.requests[0].headers.Authorization, "Bearer synthetic-token");
  assert.equal(transport.requests[0].headers.Accept, "text/event-stream");
  assert.equal(transport.requests[0].redirect, "error");
  assert.deepEqual(accepted, [event(), { cursor: 2 }, { done: true, status: "completed", cursor: 3 }]);
  assert.equal(incoming.cancelled(), 1); assert.equal(transport.timers.size, 0);
  assert.equal(transport.requests[0].signal.aborted, true);
});

test("unsupported route, missing native stream and non-SSE responses explicitly request polling fallback", async () => {
  for (const options of [{ status: 404 }, { status: 405 }, { status: 501 }, { emptyBody: true }, { contentType: "text/html" }]) {
    const transport = load(async () => response([], options));
    await assert.rejects(transport.readDisplayStream(connection, "run/a b", 0, new AbortController().signal, () => {}), (error) => error instanceof transport.DisplayStreamUnavailable);
    assert.equal(transport.timers.size, 0);
  }
});
test("auth/server errors are not misreported as unsupported-stream fallback", async () => {
  for (const status of [401, 403, 429, 503]) {
    const transport = load(async () => response([], { status }));
    await assert.rejects(transport.readDisplayStream(connection, "run/a b", 0, new AbortController().signal, () => {}), (error) => !(error instanceof transport.DisplayStreamUnavailable) && error.message.includes(String(status)));
    assert.equal(transport.timers.size, 0);
  }
});
test("socket EOF before terminal receipt is an interruption and still cancels the reader", async () => {
  const incoming = response([bytes(frame("display", event(), 1))]), transport = load(async () => incoming), accepted = [];
  await assert.rejects(transport.readDisplayStream(connection, "run/a b", 0, new AbortController().signal, (value) => accepted.push(plain(value))), /中断/);
  assert.deepEqual(accepted, [event()]); assert.equal(incoming.cancelled(), 1); assert.equal(transport.timers.size, 0);
});
test("foreign display frames and unsafe sequence numbers never enter this run", async () => {
  const wire = frame("display", { ...event(), run_id: "foreign" }) + frame("display", { ...event(), seq: 2 ** 60 }) + finish();
  const transport = load(async () => response([bytes(wire)])), accepted = [];
  await transport.readDisplayStream(connection, "run/a b", 0, new AbortController().signal, (value) => accepted.push(plain(value)));
  assert.deepEqual(accepted, [{ done: true, status: "completed", cursor: 3 }]);
});
test("foreign or non-terminal done frames cannot terminate a run", async () => {
  const wire = finish({ run_id: "foreign" }) + finish({ status: "running" }) + finish({ status: "invented" }) + finish();
  const transport = load(async () => response([bytes(wire)])), accepted = [];
  await transport.readDisplayStream(connection, "run/a b", 0, new AbortController().signal, (value) => accepted.push(plain(value)));
  assert.deepEqual(accepted, [{ done: true, status: "completed", cursor: 3 }]);
});
test("aborting during a native read ignores late bytes and removes timeout/listener resources", async () => {
  const pending = deferred(), incoming = response([], { read: () => pending.promise });
  const transport = load(async () => incoming), accepted = [], controller = new AbortController();
  const reading = transport.readDisplayStream(connection, "run/a b", 0, controller.signal, (value) => accepted.push(plain(value)));
  await settle(); controller.abort(); pending.resolve({ done: false, value: bytes(frame("display", event(), 1) + finish()) });
  await reading;
  assert.deepEqual(accepted, []); assert.equal(incoming.cancelled(), 1); assert.equal(transport.timers.size, 0);
});
test("pre-aborted signals never consume response frames", async () => {
  const incoming = response([bytes(frame("display", event(), 1) + finish())]), transport = load(async () => incoming), accepted = [];
  const controller = new AbortController(); controller.abort();
  await transport.readDisplayStream(connection, "run/a b", 0, controller.signal, (value) => accepted.push(value));
  assert.deepEqual(accepted, []); assert.equal(transport.requests[0].signal.aborted, true); assert.equal(transport.timers.size, 0);
});
test("malformed JSON fails closed and cleans reader while preserving original input ownership", async () => {
  const incoming = response([bytes('event: display\ndata: not JSON\n\n')]), transport = load(async () => incoming);
  await assert.rejects(transport.readDisplayStream(connection, "run/a b", 0, new AbortController().signal, () => {}));
  assert.equal(incoming.cancelled(), 1); assert.equal(transport.timers.size, 0);
  assert.equal(transport.requests.length, 1); assert.equal(transport.requests[0].method, undefined);
});
