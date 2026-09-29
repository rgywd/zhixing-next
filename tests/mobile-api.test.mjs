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
  fileUploadRequest,
  MAX_FILE_BYTES,
} from "../src/api.ts";

test("file MIME cannot override the raw upload protocol in Expo fetch", async () => {
  const source = readFileSync(
    new URL(
      "../node_modules/expo/src/winter/fetch/RequestUtils.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const exported = {};
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    {
      exports: exported,
      require: () => ({ blobToArrayBufferAsync: (blob) => blob.arrayBuffer() }),
      Blob,
      ArrayBuffer,
      Uint8Array,
      URLSearchParams,
      ReadableStream,
      FormData,
      TextEncoder,
      Headers,
    },
  );
  const file = new Blob(["Cedar: 4, 7, 9"], { type: "text/plain" });
  const directFile = await exported.normalizeBodyInitAsync(file);
  assert.equal(directFile.overriddenHeaders[0][1], "text/plain");
  const request = await fileUploadRequest(
    { url: "https://example.com", token: "test" },
    file,
  );
  const normalized = await exported.normalizeBodyInitAsync(request.body);
  const headers = exported.overrideHeaders(
    exported.normalizeHeadersInit(request.headers),
    normalized.overriddenHeaders ?? [],
  );
  assert.equal(
    Object.fromEntries(headers)["Content-Type"],
    "application/octet-stream",
  );
  assert.equal(new TextDecoder().decode(normalized.body), "Cedar: 4, 7, 9");
  assert.equal(request.method, "PUT");
  assert.equal(request.redirect, "error");
  await assert.rejects(
    fileUploadRequest({ url: "https://example.com", token: "test" }, {
      size: MAX_FILE_BYTES + 1,
      bytes: () => assert.fail("oversized files must not be read"),
    }),
    /20 MiB/,
  );
});

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

test("image-only drafts preserve attachment IDs in immutable retries", () => {
  const image = { id: "image-one", name: "截图.png", path: "uploads/image-one/截图.png", mime_type: "image/png", size: 100, conversation_id: "chat" };
  const draft = { text: "", attachments: [image], pending: null };
  const payload = prepareMessage(draft, "queue", "chat", null, null, () => "message-with-image");
  assert.equal(payload.content, "");
  assert.deepEqual(payload.attachments, [image.id]);
  const restored = JSON.parse(JSON.stringify({ ...draft, pending: payload }));
  assert.deepEqual(prepareMessage(restored, "steer", "task", "other", "other", () => assert.fail("retry changed ID")), payload);
  assert.throws(() => prepareMessage({ text: "", pending: null }, "queue", "chat", null, null, () => "empty"));
});

test("shared composer permits attachment-only sends and freezes pending edits", () => {
  const exported = {};
  const element = (type, props) => ({ type, props });
  const native = Object.fromEntries(["ActivityIndicator", "Modal", "Pressable", "ScrollView", "Text", "TextInput", "View"].map((name) => [name, name]));
  const modules = {
    react: { useState: (value) => [value, () => {}] },
    "react/jsx-runtime": { jsx: element, jsxs: element },
    "react-native": { ...native, StyleSheet: { create: (styles) => styles } },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./Attachments": { Attachments: "Attachments" },
    "./ModelPicker": { ModelPicker: "ModelPicker", reasoningLabel: {} },
    "./SearchPicker": { SearchPicker: "SearchPicker" },
    "./ui": { Button: "Button", colors: {}, s: {} },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/ChatComposer.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports: exported, require: (name) => {
    assert.ok(modules[name], `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const walk = (node) => node?.props ? [node, ...[node.props.children].flat(Infinity).flatMap(walk)] : [];
  const attachments = [{ id: "screenshot", name: "截图.png", mime_type: "image/png" }];
  let sends = 0;
  const props = { name: "财务助手", draft: "", kind: "chat", busy: false, connection: {}, catalog: null, onSend: () => sends++, onRemoveAttachment: () => {} };
  for (const [state, disabled] of [[{}, true], [{ attachments }, false], [{ attachments, pending: true }, false], [{ attachments, busy: true }, true], [{ attachments, ready: false }, true]]) {
    const nodes = walk(exported.ChatComposer({ ...props, ...state }));
    const send = nodes.find((node) => node.props.accessibilityLabel === (state.pending ? "重试发送" : "发送消息"));
    assert.equal(send.props.disabled, disabled);
    if (!disabled) send.props.onPress();
    if (state.pending) {
      assert.equal(nodes.find((node) => node.type === "TextInput").props.editable, false);
      assert.equal(nodes.find((node) => node.type === "Attachments").props.remove, undefined);
    }
  }
  assert.equal(sends, 2);
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
