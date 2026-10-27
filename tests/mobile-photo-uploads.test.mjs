import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import * as api from "../src/api.ts";
import { lightColors, radius, space } from "../src/theme.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
const photo = (name, extra = {}) => ({ uri: `file:///cache/${name}`, fileName: name, name, mimeType: "image/jpeg", width: 1200, height: 900, ...extra });
const picked = (...assets) => ({ canceled: false, assets });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function load(file, dependencies, globals = {}) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, AbortController, encodeURIComponent, ...globals, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return exports;
}

function mount(overrides = {}) {
  let cursor = 0, dirty = false, sequence = 0;
  const state = [], effects = [], timers = new Map(), calls = [], picks = [], attaches = [];
  const props = { connection: { url: "https://example.test/assistant", token: "fixture-only" }, conversationId: "chat", canAttach: true, attachmentIds: [],
    close() {}, async attach(resource) { attaches.push(resource); props.attachmentIds.push(resource.id); }, ...overrides.props };
  const slot = (initial) => { const index = cursor++; if (!(index in state)) state[index] = initial; return index; };
  class File {
    constructor(uri) { this.uri = uri; this.size = overrides.size?.(uri) ?? 1024; }
    async bytes() { return new Uint8Array([1, 2, 3]); }
  }
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) { const index = slot(initial); return [state[index], (next) => { state[index] = typeof next === "function" ? next(state[index]) : next; dirty = true; }]; },
      useRef(initial) { return state[slot({ current: initial })]; },
      useEffect(effect, deps) { const index = slot(undefined); if (!state[index] || deps.some((v, i) => v !== state[index].deps[i])) { state[index]?.cleanup?.(); state[index] = { deps }; effects.push(() => { state[index].cleanup = effect(); }); } },
    },
    "react-native": { ...Object.fromEntries(["Text", "View", "Image"].map((key) => [key, key])), StyleSheet: { create: (v) => v } },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "./ui": { useUi: () => ({ s: {} }), humanError: (e) => e.message,
      ...Object.fromEntries(["ActionLink", "Button", "CardHeader", "Empty", "IconAction", "PageScrollView", "SheetHeader"].map((key) => [key, key])) },
    "./ThemeProvider": { useThemedStyles: (factory) => factory(lightColors) }, "./theme": { space, radius },
    "expo-crypto": { randomUUID: () => `upload-${++sequence}` }, "expo-sharing": {},
    "expo-file-system": { File },
    "expo-image-picker": { UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" }, async launchImageLibraryAsync(options) { picks.push({ source: "photos", options }); return overrides.pick?.() ?? { canceled: true, assets: null }; } },
    "expo-document-picker": { async getDocumentAsync(options) { picks.push({ source: "files", options }); return overrides.pick?.() ?? { canceled: true, assets: null }; } },
    "./photoUploads": { preparePhoto: overrides.prepare ?? (async (asset) => ({ uri: asset.uri, name: asset.fileName, size: 1024, image: true })) },
    "./api": { ...api, request: async (_connection, path) => { calls.push({ path }); return { items: [], truncated: false }; } },
    "expo/fetch": { fetch: async (url, options) => {
      const call = { url, ...options }; calls.push(call);
      const response = overrides.upload?.(call); if (response) return response;
      const parsed = new URL(url), id = parsed.pathname.split("/").at(-1);
      return { ok: true, json: async () => ({ id, name: parsed.searchParams.get("filename"), mime_type: "image/jpeg" }) };
    } },
  };
  const { FilesPanel } = load("FilesPanel.tsx", dependencies, { setTimeout: (fn) => { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id) });
  function render() {
    let nodes, attempts = 0;
    do {
      cursor = 0; dirty = false; nodes = [];
      function walk(node) { if (!node || typeof node !== "object") return; if (Array.isArray(node)) return node.forEach(walk); nodes.push(node); walk(node.props?.children); }
      walk(FilesPanel(props)); while (effects.length) effects.shift()(); assert.ok(++attempts < 10);
    } while (dirty);
    return nodes;
  }
  const control = (name) => render().find((node) => node.props.children === name || node.props.label === name);
  render();
  return { props, calls, picks, attaches, render, control, uploads: () => calls.filter((call) => call.method === "PUT"),
    async press(name) { const node = control(name); assert.ok(node, name); assert.ok(!node.props.disabled, `${name} enabled`); node.props.onPress(); await settle(); render(); },
    unmount() { state.forEach((item) => item?.cleanup?.()); }, timers };
}

test("file picker cancel is harmless and duplicate opens are blocked", async () => {
  const result = deferred(); const app = mount({ pick: () => result.promise, props: { attachmentIds: ["existing"] } });
  const choose = app.control("选择手机文件"); choose.props.onPress(); choose.props.onPress();
  assert.equal(app.picks.length, 1);
  assert.deepEqual(plain(app.picks[0].options), { copyToCacheDirectory: true, multiple: true });
  result.resolve({ canceled: true, assets: null }); await settle();
  assert.equal(app.control("选择手机文件").props.disabled, false); assert.equal(app.uploads().length, 0); assert.equal(app.attaches.length, 0);
  app.unmount();
});

test("file selection previews, removes and uploads files in order", async () => {
  const app = mount({ pick: () => picked(photo("first.jpg"), photo("remove.jpg"), photo("last.jpg")) });
  await app.press("选择手机文件"); assert.equal(app.render().filter((node) => node.type === "Image").length, 3);
  await app.press("移除 remove.jpg"); await app.press("上传 2 份并加入草稿");
  assert.deepEqual(app.attaches.map((item) => item.name), ["first.jpg", "last.jpg"]);
  assert.equal(app.render().filter((node) => node.type === "Image").length, 0);
  for (const call of app.uploads()) {
    assert.equal(call.headers.Authorization, "Bearer fixture-only"); assert.equal(call.headers["Content-Type"], "application/octet-stream");
    assert.equal(call.redirect, "error"); assert.deepEqual([...call.body], [1, 2, 3]); assert.match(call.url, /\/assistant\/v1\/conversations\/chat\/files\//);
  }
  assert.ok(app.control("已上传 2 份资料并加入消息草稿。回到对话即可发送。")); app.unmount();
});

test("partial failure continues the batch and retries only the failed upload with the same ID", async () => {
  let failures = 1;
  const app = mount({ pick: () => picked(photo("first.jpg"), photo("failed.jpg"), photo("last.jpg")),
    upload(call) { if (call.url.includes("failed.jpg") && failures-- > 0) return Promise.reject(new Error("网络中断")); } });
  await app.press("选择手机文件"); const send = app.control("上传 3 份并加入草稿"); send.props.onPress(); send.props.onPress(); await settle();
  assert.deepEqual(app.attaches.map((item) => item.name), ["first.jpg", "last.jpg"]); assert.equal(app.uploads().length, 3);
  assert.ok(app.control("网络中断")); await app.press("重试剩余资料");
  assert.equal(app.uploads().length, 4); assert.equal(app.uploads()[1].url, app.uploads()[3].url);
  assert.deepEqual(app.attaches.map((item) => item.name), ["first.jpg", "last.jpg", "failed.jpg"]); app.unmount();
});

test("uploaded receipt survives draft save failure and retry does not reupload or consume a second slot", async () => {
  let failures = 1; const attached = [];
  const app = mount({ pick: () => picked(photo("saved.jpg")), props: { attachmentIds: Array.from({ length: 7 }, (_, i) => `old-${i}`),
    async attach(resource) { app.props.attachmentIds = [...new Set([...app.props.attachmentIds, resource.id])]; if (failures-- > 0) throw new Error("草稿存储失败"); attached.push(resource); } } });
  await app.press("选择手机文件"); await app.press("上传 1 份并加入草稿");
  assert.ok(app.control("已上传，加入草稿失败：草稿存储失败")); assert.ok(!app.control("重试剩余资料").props.disabled);
  await app.press("重试剩余资料"); assert.equal(app.uploads().length, 1); assert.equal(attached.length, 1);
  assert.equal(app.control("选择手机文件").props.disabled, true); app.unmount();
});

test("file multiselect rejects an overflowing selection and skips oversized files individually", async () => {
  let assets = [{ uri: "file:///one.txt", name: "one.txt" }, { uri: "file:///huge.pdf", name: "huge.pdf" }];
  const app = mount({ pick: () => picked(...assets), props: { attachmentIds: Array.from({ length: 7 }, (_, i) => `old-${i}`) },
    size: (uri) => uri.includes("huge") ? api.MAX_FILE_BYTES + 1 : 1024 });
  await app.press("选择手机文件"); assert.equal(app.picks[0].options.multiple, true); assert.equal(app.picks[0].options.copyToCacheDirectory, true);
  assert.ok(app.control("每条消息最多 8 份资料，本次还可以选择 1 份，请减少后重新选择。")); assert.equal(app.uploads().length, 0);
  app.props.attachmentIds = []; await app.press("选择手机文件"); assert.ok(app.control("huge.pdf：单个文件最多 20 MiB，请选择较小的文件。"));
  await app.press("上传 1 份并加入草稿"); assert.equal(app.attaches[0].name, "one.txt");
  assets = [photo("locked.jpg")]; app.props.canAttach = false; assert.equal(app.control("选择手机文件").props.disabled, true); app.unmount();
});

test("file picker and read failures preserve usable selections", async () => {
  let denied = true;
  const app = mount({ pick() { if (denied) throw new Error("无法打开相册"); return picked(photo("bad.heic"), photo("good.jpg")); },
    size: (uri) => { if (uri.endsWith("bad.heic")) throw new Error("文件无法读取"); return 1024; } });
  await app.press("选择手机文件"); assert.ok(app.control("无法打开相册")); denied = false; await app.press("选择手机文件");
  assert.ok(app.control("bad.heic：文件无法读取")); await app.press("上传 1 份并加入草稿"); assert.equal(app.attaches[0].name, "good.jpg"); app.unmount();
});

test("closing during upload aborts transport, suppresses late attach and stops the remaining batch", async () => {
  const response = deferred(); const app = mount({ pick: () => picked(photo("first.jpg"), photo("second.jpg")), upload: () => response.promise });
  await app.press("选择手机文件"); await app.press("上传 2 份并加入草稿"); assert.equal(app.uploads().length, 1);
  app.unmount(); assert.equal(app.uploads()[0].signal.aborted, true);
  response.resolve({ ok: true, json: async () => ({ id: "late" }) }); await settle();
  assert.equal(app.attaches.length, 0); assert.equal(app.uploads().length, 1); assert.equal(app.timers.size, 0);
});

test("switching conversations ignores a late picker result and clears the old selection", async () => {
  const result = deferred(); const app = mount({ pick: () => result.promise });
  await app.press("选择手机文件"); app.props.conversationId = "another"; app.render(); result.resolve(picked(photo("old.jpg"))); await settle();
  assert.equal(app.render().filter((node) => node.type === "Image").length, 0); assert.equal(app.attaches.length, 0);
  assert.equal(app.control("选择手机文件").props.disabled, false); app.unmount();
});

test("a timed-out transport that resolves late cannot attach; retry retains the original upload ID", async () => {
  const response = deferred(); let first = true;
  const app = mount({ pick: () => picked(photo("timeout.jpg")), upload() { if (first) { first = false; return response.promise; } } });
  await app.press("选择手机文件"); await app.press("上传 1 份并加入草稿");
  [...app.timers.values()].forEach((timer) => timer()); assert.equal(app.uploads()[0].signal.aborted, true);
  response.resolve({ ok: true, json: async () => ({ id: "late" }) }); await settle(); assert.equal(app.attaches.length, 0);
  assert.ok(app.control("上传超时，请重试。")); await app.press("重试剩余资料");
  assert.equal(app.uploads()[0].url, app.uploads()[1].url); assert.equal(app.attaches.length, 1); app.unmount();
});

function photoHelper(sizes = {}) {
  const transforms = [];
  const { preparePhoto } = load("photoUploads.ts", {
    "./api": api, "expo-file-system": { File: class { constructor(uri) { this.size = sizes[uri] ?? 1024; } } },
    "expo-image-manipulator": { SaveFormat: { JPEG: "jpeg" }, ImageManipulator: { manipulate(uri) {
      const entry = { uri, released: 0 }; transforms.push(entry);
      return { resize: (size) => { entry.resize = size; }, release: () => entry.released++, renderAsync: async () => ({
        release: () => entry.released++, saveAsync: async (options) => { entry.options = options; return { uri: "file:///converted.jpg" }; },
      }) };
    } } },
  }); return { preparePhoto, transforms };
}

test("photo preparation keeps supported screenshots and fixes HEIC names for JPEG cache bytes", async () => {
  const app = photoHelper();
  const original = await app.preparePhoto(photo("screenshot.png"), "fallback.jpg"); assert.equal(original.uri, "file:///cache/screenshot.png"); assert.equal(original.name, "screenshot.png");
  const renamed = await app.preparePhoto(photo("IMG.HEIC", { uri: "file:///cache/converted.jpeg" }), "fallback.jpg"); assert.equal(renamed.name, "IMG.jpeg");
  const unnamed = await app.preparePhoto(photo("cache.png", { fileName: null }), "照片-unique.jpg"); assert.equal(unnamed.name, "照片-unique.png"); assert.equal(app.transforms.length, 0);
});

test("HEIC and high-resolution photos become supported bounded JPEGs and native buffers are released", async () => {
  const app = photoHelper();
  const converted = await app.preparePhoto(photo("IMG.HEIC"), "fallback.jpg"); assert.equal(converted.name, "IMG.jpg"); assert.equal(converted.uri, "file:///converted.jpg");
  await app.preparePhoto(photo("large.jpg", { width: 8000, height: 6000 }), "fallback.jpg");
  assert.deepEqual(plain(app.transforms[1].resize), { width: 4096 });
  for (const entry of app.transforms) { assert.deepEqual(plain(entry.options), { format: "jpeg", compress: 0.95 }); assert.equal(entry.released, 2); }
});

test("unreadable and still oversized prepared photos fail before any upload", async () => {
  const empty = photoHelper({ "file:///cache/empty.jpg": 0 }); await assert.rejects(empty.preparePhoto(photo("empty.jpg"), "fallback.jpg"), /无法读取/);
  const large = photoHelper({ "file:///cache/huge.jpg": api.MAX_FILE_BYTES + 1, "file:///converted.jpg": api.MAX_FILE_BYTES + 1 });
  await assert.rejects(large.preparePhoto(photo("huge.jpg"), "fallback.jpg"), /超过 20 MiB/); assert.equal(large.transforms[0].released, 2);
  assert.equal(large.transforms[0].resize, undefined, "never upscale an image just because its file is large");
});
