import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as theme from "../src/theme.ts";
import * as api from "../src/api.ts";
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const photo = (id) => ({ id, uri: `file:///documents/chat-photos/${id}/original.jpg`, name: "Screenshot_20261027_192109.jpg", width: 800, height: 600 });
function deferred() { let resolve; const promise = new Promise((done) => resolve = done); return { promise, resolve }; }
function load(file, dependencies) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, encodeURIComponent, require(name) { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return exports;
}
function hooks() {
  const slots = []; let cursor = 0, effects = [], dirty = false;
  return { react: {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(callback, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = callback(); }); } },
  }, render(fn) { let value; do { cursor = 0; dirty = false; effects = []; value = fn(); effects.forEach((f) => f()); } while (dirty); return value; }, unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}
function pickerHarness({ choose, keep = (asset, id) => ({ ...photo(id), uri: asset.uri }) } = {}) {
  const lifecycle = hooks(), calls = [], saved = [], discarded = [], errors = []; let serial = 0;
  const { usePhotoPicker } = load("usePhotoPicker.ts", { react: lifecycle.react, "expo-crypto": { randomUUID: () => `p${++serial}` },
    "expo-image-picker": { UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" }, launchImageLibraryAsync: async (options) => { calls.push(options); return choose(); } },
    "./chatPhotos": { keepDraftPhoto: keep, discardDraftPhotos: (items) => discarded.push(...items) }, "./ui": { humanError: (e) => e.message } });
  const props = { scope: "chat", ids: [], locked: false, add: async (items) => saved.push(...items), onError: (error) => errors.push(error) };
  return { props, calls, saved, discarded, errors, render: () => lifecycle.render(() => usePhotoPicker(props)), unmount: lifecycle.unmount };
}
test("native photo selection uses the remaining slots and immediately adds all images to the draft without upload", async () => {
  const app = pickerHarness({ choose: () => ({ canceled: false, assets: [{ uri: "file:///one" }, { uri: "file:///two" }] }) }); app.props.ids = ["old"];
  await app.render().pick(); assert.deepEqual(plain(app.calls[0]), { mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 7, orderedSelection: true, allowsEditing: false, quality: 1, preferredAssetRepresentationMode: "compatible" });
  assert.deepEqual(app.saved.map((p) => p.uri), ["file:///one", "file:///two"]); assert.equal(app.render().picking, false); app.unmount();
});
test("DSH photo selection leaves attachment admission to the host", async () => {
  const app = pickerHarness({ choose: () => ({ canceled: false, assets: Array.from({ length: 10 }, (_, i) => ({ uri: `file:///image${i}` })) }) });
  app.props.maxAttachments = null;
  app.props.ids = Array.from({ length: 8 }, (_, i) => String(i));
  await app.render().pick();
  assert.equal(app.calls[0].selectionLimit, undefined);
  assert.equal(app.saved.length, 10); assert.equal(app.errors.length, 0); app.unmount();
});
test("cancel, duplicate opens and a late picker result after changing conversations never alter another draft", async () => {
  const result = deferred(), app = pickerHarness({ choose: () => result.promise }); const first = app.render().pick(), duplicate = app.render().pick();
  assert.equal(app.calls.length, 1); app.props.scope = "other"; app.render(); result.resolve({ canceled: false, assets: [{ uri: "old" }] }); await first; await duplicate;
  assert.equal(app.saved.length, 0); app.unmount();
  const cancelled = pickerHarness({ choose: () => ({ canceled: true, assets: null }) }); await cancelled.render().pick(); assert.equal(cancelled.saved.length, 0); assert.equal(cancelled.errors.length, 0); cancelled.unmount();
});
test("overflow is rejected before copying, while a bad image preserves other valid selected photos", async () => {
  const app = pickerHarness({ choose: () => ({ canceled: false, assets: [{ uri: "bad" }, { uri: "good" }] }), keep: (asset, id) => { if (asset.uri === "bad") throw new Error("cannot read"); return photo(id); } });
  app.props.ids = Array.from({ length: 7 }, (_, i) => `${i}`); await app.render().pick(); assert.equal(app.saved.length, 0); assert.match(app.errors[0], /最多 8/);
  app.props.ids = []; await app.render().pick(); assert.equal(app.saved.length, 1); assert.match(app.errors[1], /1 张照片未能加入/); app.unmount();
});
function transport() {
  const files = new Map([["file:///cache/IMG.heic", [1,2]], ["file:///converted.jpg", [4,5,6]]]), puts = [], saves = [], removed = [];
  const uri = (parts) => parts.map((part) => typeof part === "string" ? part : part.uri).reduce((base, part) => base ? base.replace(/\/$/, "") + "/" + part.replace(/^\//, "") : part, "");
  class File { constructor(...parts) { this.uri = uri(parts); } get size() { return files.get(this.uri)?.length ?? 0; } get exists() { return files.has(this.uri); } async copy(to) { await settle(); if (!files.has(this.uri)) throw new Error("missing"); files.set(to.uri, [...files.get(this.uri)]); } delete() { files.delete(this.uri); } async bytes() { return Uint8Array.from(files.get(this.uri)); } }
  class Directory { constructor(...parts) { this.uri = uri(parts); } create() {} get exists() { return [...files.keys()].some((key) => key.startsWith(this.uri + "/")); } delete() { removed.push(this.uri); for (const key of files.keys()) if (key.startsWith(this.uri + "/")) files.delete(key); } }
  const code = load("chatPhotos.ts", { "expo-file-system": { File, Directory, Paths: { document: "file:///documents" } }, "./api": api,
    "./photoUploads": { preparePhoto: async () => ({ uri: "file:///converted.jpg", name: "IMG.jpg", size: 3 }) },
    "expo/fetch": { fetch: async (url, options) => { puts.push({ url, ...options }); if (puts.length === 1) throw new Error("receipt lost"); return { ok: true, json: async () => ({ id: "p1", conversation_id: "c1", mime_type: "image/jpeg" }) }; } } });
  return { ...code, files, puts, saves, removed, save: async (value) => saves.push(plain(value)) };
}
test("photo copies persist outside picker cache; conversion is saved before PUT and retry uses identical bytes and ID", async () => {
  const app = transport(), selected = await app.keepDraftPhoto({ uri: "file:///cache/IMG.heic", fileName: "IMG.heic", width: 800, height: 600 }, "p1");
  app.files.delete("file:///cache/IMG.heic"); assert.ok(app.files.has(selected.uri));
  const connection = { url: "https://example.test", token: "fixture" }, signal = new AbortController().signal;
  await assert.rejects(app.sendDraftPhoto(connection, "c1", selected, app.save, signal), /receipt lost/);
  assert.equal(app.saves.length, 1); assert.ok(app.files.has(app.saves[0].prepared.uri)); app.files.delete("file:///converted.jpg");
  const result = await app.sendDraftPhoto(connection, "c1", app.saves[0], app.save, signal); assert.equal(result.resource.id, "p1");
  assert.equal(app.puts[0].url, app.puts[1].url); assert.deepEqual([...app.puts[1].body], [4,5,6]);
  assert.equal(app.puts[1].headers.Authorization, "Bearer fixture"); assert.equal(app.puts[1].redirect, "error");
  await app.sendDraftPhoto(connection, "c1", result, app.save, signal); assert.equal(app.puts.length, 2);
  app.discardDraftPhotos([{ ...selected, uri: "file:///album/original.jpg" }]); assert.equal(app.removed.length, 0);
  app.discardDraftPhotos([selected]); assert.equal(app.files.has(selected.uri), false);
});
const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
test("draft thumbnails show only pictures with a top-right remove target and open a gallery, in either theme", () => {
  for (const colors of [theme.lightColors, theme.darkColors]) {
    const lifecycle = hooks(), removed = [];
    const { DraftAttachments } = load("PhotoAttachments.tsx", { "react/jsx-runtime": jsx, react: lifecycle.react,
      "react-native": { ...Object.fromEntries(["ActivityIndicator", "FlatList", "Image", "Modal", "Pressable", "ScrollView", "Text", "View"].map((name) => [name,name])), StyleSheet: { create: (v) => v, absoluteFill: {} }, useWindowDimensions: () => ({ width: 320 }) },
      "expo-status-bar": { StatusBar: "StatusBar" }, "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" }, "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
      "./ResourcePreview": { ResourceImage: "ResourceImage", ResourcePreview: "ResourcePreview" }, "./resources": {}, "./ThemeProvider": { useThemedStyles: (f) => f(colors) }, "./theme": theme, "./ui": { useUi: () => ({ colors, s: {} }) } });
    const render = () => walk(lifecycle.render(() => DraftAttachments({ connection: {}, photos: [photo("p1"),photo("p2")], removePhoto: (id) => removed.push(id) })));
    let nodes = render(); assert.equal(nodes.some((node) => node.type === "Text"), false, "no filename or remove row");
    const remove = nodes.find((node) => node.props.accessibilityLabel === "移除第 1 张照片"); assert.equal(remove.props.style.top, 0); assert.equal(remove.props.style.right, 0); assert.equal(remove.props.style.width, 44);
    remove.props.onPress(); assert.deepEqual(removed, ["p1"]);
    nodes.find((node) => node.props.accessibilityLabel === "预览第 2 张照片").props.onPress(); nodes = render();
    assert.equal(nodes.find((node) => node.type?.name === "PhotoViewer").props.selectedId, "p2"); lifecycle.unmount();
  }
});
