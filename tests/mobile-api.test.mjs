import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  normalizeServerUrl,
  mergeById,
  parseLocalTime,
  prepareMessage,
  prepareSchedule,
  safeDownloadName,
  request,
  ApiError,
} from "../src/api.ts";

test("connection URLs never leak credentials or permit remote cleartext", () => {
  assert.equal(
    normalizeServerUrl(" https://example.com/ "),
    "https://example.com",
  );
  assert.equal(
    normalizeServerUrl("http://10.0.2.2:8000", true),
    "http://10.0.2.2:8000",
  );
  for (const url of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
    "file:///tmp",
    "http://localhost:8000",
  ])
    assert.throws(() => normalizeServerUrl(url));
});
test("incremental message pages replace changed receipts without duplicates", () => {
  assert.deepEqual(
    mergeById(
      [{ id: "a", status: "accepted" }],
      [
        { id: "a", status: "applied" },
        { id: "b", status: "accepted" },
      ],
    ),
    [
      { id: "a", status: "applied" },
      { id: "b", status: "accepted" },
    ],
  );
});
test("schedule date parser rejects rollover and accepts local future time", () => {
  assert.throws(() => parseLocalTime("2099-02-30 10:00"));
  assert.throws(() => parseLocalTime("2099-12-01 25:00"));
  assert.throws(() => parseLocalTime("yesterday"));
  const result = new Date(parseLocalTime("2099-12-01 10:30"));
  assert.equal(result.getHours(), 10);
  assert.equal(result.getMinutes(), 30);
});
test("pending requests survive reload and never silently retarget a steer", () => {
  const original = prepareMessage(
    { text: " 调整范围 ", pending: null },
    "steer",
    "task",
    "run-a",
    "run-a",
    () => "message-a",
  );
  const restored = JSON.parse(
    JSON.stringify({ text: "调整范围", pending: original }),
  );
  assert.deepEqual(
    prepareMessage(restored, "queue", "chat", "run-b", "run-b", () => {
      throw new Error("must not allocate another ID");
    }),
    original,
  );
  assert.throws(() =>
    prepareMessage(
      { text: "调整范围", pending: null },
      "steer",
      "task",
      "run-a",
      "run-b",
      () => "message-b",
    ),
  );
});
test("download names cannot escape their unique cache directory", () => {
  assert.equal(safeDownloadName("../../report.pdf"), ".._.._report.pdf");
  assert.equal(safeDownloadName(".."), "artifact");
  assert.equal(safeDownloadName(""), "artifact");
});
test("schedule retry after due time preserves persisted ID, time and original conversation", () => {
  const pending = {
    id: "plan-a",
    conversation_id: "conversation-a",
    prompt: "整理资料",
    next_run_at: "2001-01-01T00:00:00Z",
    interval_seconds: null,
  };
  const restored = JSON.parse(
    JSON.stringify({
      prompt: "整理资料",
      time: "2001-01-01 08:00",
      interval: "",
      pending,
    }),
  );
  assert.deepEqual(
    prepareSchedule(restored, "conversation-b", () => {
      throw new Error("must reuse persisted ID");
    }),
    pending,
  );
  assert.throws(() =>
    prepareSchedule(
      { ...restored, pending: null },
      "conversation-b",
      () => "plan-b",
    ),
  );
});
test("retry sends the exact stable message ID and surfaces stale steer rejection", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(options.body);
    assert.equal(options.headers.Authorization, "Bearer service-only");
    assert.equal(options.redirect, "error");
    return {
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: "stale_run", message: "目标运行已结束" },
      }),
    };
  };
  try {
    const body = {
      id: "stable-id",
      content: "改变范围",
      intent: "steer",
      kind: "task",
      target_run_id: "original-run",
    };
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        request(
          { url: "https://example.com", token: "service-only" },
          "/conversations/c/messages",
          { method: "POST", body },
        ),
        (error) => error instanceof ApiError && error.code === "stale_run",
      );
    assert.equal(bodies[0], bodies[1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("draft autosaves stay ordered and a late old receipt cannot clear a newer request", async () => {
  const saved = new Map();
  const memoryStore = {
    getItem: async (key) => saved.get(key) ?? null,
    setItem: async (key, value) => {
      await Promise.resolve();
      saved.set(key, value);
    },
  };
  const source = readFileSync(
    new URL("../src/storage.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exported = {};
  runInNewContext(compiled, {
    exports: exported,
    require: (name) =>
      name === "@react-native-async-storage/async-storage"
        ? { __esModule: true, default: memoryStore }
        : {},
  });
  const one = { text: "first", pending: { id: "message-one" } };
  const two = { text: "second", pending: { id: "message-two" } };
  await Promise.all([
    exported.saveDraft("chat", one),
    exported.saveDraft("chat", two),
  ]);
  await exported.clearDraft("chat", "message-one");
  assert.deepEqual(JSON.parse(saved.get("chat")), two);
  await exported.clearDraft("chat", "message-two");
  assert.deepEqual(JSON.parse(saved.get("chat")), { text: "", pending: null });
  const plan = {
    prompt: "report",
    time: "2099-01-01 09:00",
    interval: "",
    pending: { id: "schedule-one" },
  };
  await exported.savePlanDraft("https://assistant.example", plan);
  assert.equal(
    (await exported.readPlanDraft("https://assistant.example")).pending.id,
    "schedule-one",
  );
  assert.equal(await exported.readPlanDraft("https://other.example"), null);
});
