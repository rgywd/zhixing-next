import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { mergeById } from "../src/api.ts";
import { lightColors, layout, radius, space } from "../src/theme.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const connection = { url: "https://example.test/assistant", token: "test-only" };
const file = (id, name = `${id}.txt`) => ({ id, name, path: name, mime_type: "text/plain", size: 1234, conversation_id: `chat-${id}` });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mount(module, name, props, extra = {}) {
  let cursor = 0, dirty = false, timerId = 0, nodes = [];
  const slots = [], effects = [], timers = new Map(), calls = [], downloads = [];
  const slot = (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return index; };
  const changed = (old, next) => !old || old.length !== next.length || next.some((value, i) => value !== old[i]);
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) { const index = slot(typeof initial === "function" ? initial() : initial); return [slots[index], (next) => { const value = typeof next === "function" ? next(slots[index]) : next; if (value !== slots[index]) { slots[index] = value; dirty = true; } }]; },
      useRef(value) { return slots[slot({ current: value })]; },
      useMemo(factory, deps) { const index = slot(undefined); if (changed(slots[index]?.deps, deps)) slots[index] = { deps, value: factory() }; return slots[index].value; },
      useEffect(effect, deps) { const index = slot(undefined); if (changed(slots[index]?.deps, deps)) { slots[index]?.cleanup?.(); slots[index] = { deps }; effects.push(() => { slots[index].cleanup = effect(); }); } },
    },
    "react-native": Object.fromEntries(["ActivityIndicator", "Image", "Modal", "Pressable", "Text", "TextInput", "View", "ScrollView"].map((key) => [key, key])),
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./theme": { layout, radius, space },
    "./ThemeProvider": { useThemedStyles: (factory) => factory(lightColors) },
    "./ui": { useUi: () => ({ s: {}, colors: lightColors }), humanError: (error) => error.message,
      ...Object.fromEntries(["ActionLink", "Empty", "IconAction", "PageHeading", "PageScrollView", "SheetHeader"].map((key) => [key, key])) },
    "./api": { mergeById, request: (_connection, path, options) => { const task = deferred(); calls.push({ path, options, ...task }); return task.promise; } },
    "./resources": { shareResource: async (...args) => { downloads.push(args); } },
    "./ResourcePreview": { ResourceImage: "ResourceImage", ResourcePreview: "ResourcePreview", resourceDetail: (item) => `${item.size} B` },
    ...extra,
  };
  dependencies["react-native"].StyleSheet = { create: (styles) => styles, absoluteFill: {}, absoluteFillObject: {} };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${module}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, AbortController, encodeURIComponent,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    require: (key) => { assert.ok(key in dependencies, key); return dependencies[key]; },
  });
  function render() {
    let attempts = 0;
    do {
      cursor = 0; dirty = false; nodes = [];
      const walk = (node) => { if (!node || typeof node !== "object") return; if (Array.isArray(node)) return node.forEach(walk); nodes.push(node); walk(node.props?.children); };
      walk(exports[name](props));
      while (effects.length) effects.shift()();
      assert.ok(++attempts < 10, "render settled");
    } while (dirty);
    return nodes;
  }
  function fireTimers() { const queued = [...timers.values()]; timers.clear(); queued.forEach((callback) => callback()); }
  render();
  return { render, fireTimers, calls, downloads, exports, unmount() { slots.forEach((value) => value?.cleanup?.()); } };
}
const find = (page, predicate) => page.render().find(predicate);
const text = (value) => (node) => node.props?.children === value;
const label = (value) => (node) => node.props?.accessibilityLabel === value || node.props?.label === value;
const results = (page) => page.render().filter((node) => node.props?.accessibilityLabel?.startsWith("查看资料 "));

test("resource list distinguishes initial loading, failed retry and a verified empty library", async () => {
  const page = mount("ResourcesPanel.tsx", "ResourcesPanel", { connection });
  assert.ok(find(page, label("正在加载资料")));
  assert.ok(!find(page, (node) => node.type === "Empty"));
  page.fireTimers();
  assert.match(page.calls[0].path, /latest=true/);
  page.calls[0].reject(new Error("连接中断")); await settle();
  assert.ok(find(page, text("连接中断")));
  assert.ok(!find(page, (node) => node.type === "Empty"));
  find(page, text("重新加载")).props.onPress(); page.render(); page.fireTimers();
  assert.ok(find(page, label("正在加载资料")));
  page.calls[1].resolve({ items: [], next_cursor: null, previous_cursor: null }); await settle();
  assert.equal(find(page, (node) => node.type === "Empty").props.title, "还没有资料");
  page.unmount();
});

test("global resource search cancels stale pages and keeps its query while loading older matches", async () => {
  const opened = [];
  const page = mount("ResourcesPanel.tsx", "ResourcesPanel", { connection, onOpenConversation: (id) => opened.push(id) });
  page.fireTimers();
  find(page, label("搜索全部资料")).props.onChangeText("行程 report"); page.render(); page.fireTimers();
  assert.equal(page.calls[0].options.signal.aborted, true);
  assert.match(page.calls[1].path, new RegExp(`query=${encodeURIComponent("行程 report")}&latest=true`));
  page.calls[1].resolve({ items: [file("old"), file("new")], previous_cursor: "9", next_cursor: null }); await settle();
  page.calls[0].resolve({ items: [file("stale")], previous_cursor: null }); await settle();
  assert.deepEqual(results(page).map((node) => node.props.accessibilityLabel), ["查看资料 new.txt", "查看资料 old.txt"]);
  find(page, label("打开 new.txt 的来源对话")).props.onPress();
  assert.deepEqual(opened, ["chat-new"]);
  find(page, label("查看资料 new.txt")).props.onPress();
  assert.equal(find(page, (node) => node.type === "ResourcePreview").props.resource.id, "new");
  find(page, label("下载分享 new.txt")).props.onPress(); await settle();
  assert.equal(page.downloads[0][1].id, "new");
  find(page, text("查看更多资料")).props.onPress();
  assert.match(page.calls[2].path, /before=9$/);
  assert.ok(page.calls[2].path.includes(`query=${encodeURIComponent("行程 report")}`));
  page.calls[2].reject(new Error("较早资料暂未加载")); await settle();
  assert.equal(results(page).length, 2);
  find(page, text("重新加载")).props.onPress();
  assert.equal(page.calls[3].path, page.calls[2].path);
  find(page, label("搜索全部资料")).props.onChangeText("新搜索"); page.render(); page.fireTimers();
  assert.equal(page.calls[3].options.signal.aborted, true);
  page.calls[3].resolve({ items: [file("stale-older")], previous_cursor: null });
  page.calls[4].resolve({ items: [], previous_cursor: null }); await settle();
  assert.equal(results(page).length, 0);
  assert.equal(find(page, (node) => node.type === "Empty").props.title, "没有找到相关资料");
  page.unmount();
});

test("resource images expose failed or timed-out loading and retry without dropping authorization", () => {
  const resource = { ...file("picture", "screen.png"), mime_type: "image/png" };
  const page = mount("ResourcePreview.tsx", "ResourceImage", { connection, resource });
  assert.ok(find(page, label("正在加载图片 screen.png")));
  const initial = find(page, (node) => node.type === "Image");
  assert.equal(initial.props.source[0].headers.Authorization, "Bearer test-only");
  initial.props.onError();
  const retry = find(page, label("重试加载图片 screen.png"));
  let stopped = false;
  retry.props.onPress({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  const next = find(page, (node) => node.type === "Image");
  assert.notEqual(next.props.source[0].uri, initial.props.source[0].uri);
  assert.equal(next.props.source[0].headers.Authorization, "Bearer test-only");
  next.props.onLoad();
  page.fireTimers();
  assert.ok(!find(page, label("重试加载图片 screen.png")));
  assert.ok(!find(page, label("正在加载图片 screen.png")));
  page.unmount();

  const stalled = mount("ResourcePreview.tsx", "ResourceImage", { connection, resource });
  stalled.fireTimers();
  assert.ok(find(stalled, label("重试加载图片 screen.png")));
  stalled.unmount();
});
