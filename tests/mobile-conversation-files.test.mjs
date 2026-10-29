import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as model from "../src/conversationFiles.ts";
import * as theme from "../src/theme.ts";

const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
const file = (id, name, extra = {}) => ({ id, name, type: "file", bytes: 0, ...extra });
const presented = (seq, name, version, extra = {}) => file(`presented:${seq}:0`, name, { sourcePath: name, delivery: { seq, index: 0, version }, ...extra });
const row = (id, role, attachments) => ({ id, role, parts: [], attachments, events: [], active: false });

function hooks() {
  const slots = []; let cursor = 0, effects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((item, i) => item !== b[i]);
  return {
    react: {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
      useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
      useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (changed(old?.deps, deps)) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
      useMemo(fn, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    },
    render(fn) { cursor = 0; effects = []; const result = fn(); effects.forEach((effect) => effect()); return result; },
  };
}

function load(filename, dependencies) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${filename}`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (name) => { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; } });
  return exports;
}

test("only the active version's assistant deliveries are listed, without repeats", () => {
  const rows = [
    row("user:1", "user", [file("upload-1", "我的上传.pdf")]),
    row("turn:1", "assistant", [presented(3, "旧版方案.md", "version-a"), presented(4, "方案.md", "version-b"),
      file("image-1", "示意图.png", { type: "image" })]),
    row("turn:2", "assistant", [file("artifact-1", "清单.csv"), presented(7, "方案.md", "version-b", { description: "第二版，含用量" })]),
  ];
  const files = model.conversationFiles(rows, "version-b");
  assert.deepEqual(files.map(item => item.file.name), ["方案.md", "清单.csv"]);
  assert.equal(files.length, 2, "the same delivered path appears once");
  assert.equal(files[0].file.description, "第二版，含用量", "the newest delivery replaces the earlier card");
  assert.equal(files.some(item => ["我的上传.pdf", "旧版方案.md", "示意图.png"].includes(item.file.name)), false);
  assert.equal(model.conversationFileKey(files[0].file), "path:方案.md");
  assert.equal(model.conversationFileKey(files[1].file), "file:artifact-1");
});

test("deliveries without version metadata stay visible and blank names are ignored", () => {
  const files = model.conversationFiles([row("turn:1", "assistant", [
    file("artifact-1", "周报.md"),
    file("empty", "   "),
    { id: "no-name", type: "file", bytes: 4 },
  ])], "version-b");
  assert.deepEqual(files.map(item => item.file.name), ["周报.md"]);
  assert.deepEqual(model.conversationFiles([]), []);
});

test("filename search matches Chinese names and ignores Latin case", () => {
  const files = model.conversationFiles([
    row("turn:1", "assistant", [presented(1, "采购清单.md", "v"), presented(2, "Weekly-Plan.CSV", "v")]),
    row("turn:2", "assistant", [presented(3, "四人份 方案.md", "v")]),
  ], "v");
  assert.deepEqual(files.map(item => item.file.name), ["四人份 方案.md", "Weekly-Plan.CSV", "采购清单.md"]);
  assert.deepEqual(model.searchConversationFiles(files, "清单").map(item => item.file.name), ["采购清单.md"]);
  assert.deepEqual(model.searchConversationFiles(files, "方案").map(item => item.file.name), ["四人份 方案.md"]);
  assert.deepEqual(model.searchConversationFiles(files, "weekly").map(item => item.file.name), ["Weekly-Plan.CSV"]);
  assert.deepEqual(model.searchConversationFiles(files, "  CSV  ").map(item => item.file.name), ["Weekly-Plan.CSV"]);
  assert.equal(model.searchConversationFiles(files, "").length, 3);
  assert.deepEqual(model.searchConversationFiles(files, "采购清单.csv"), []);
  assert.deepEqual(model.searchConversationFiles(files, "不存在的文件"), []);
});

test("the sheet separates loading, no-file and no-match states and keeps open and share working", async () => {
  const life = hooks(), opened = [], shared = [];
  const { ConversationFilesSheet } = load("ConversationFilesSheet.tsx", {
    react: life.react, "react/jsx-runtime": jsx,
    "react-native": { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View" },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./BottomSheet": { BottomSheet: "BottomSheet" }, "./ChatFileCard": { ChatFileCard: "ChatFileCard" },
    "./conversationFiles": model,
    "./ui": { useUi: () => ({ s: {}, colors: theme.darkColors }), Empty: "Empty", ActionLink: "ActionLink" },
    "./theme": theme,
  });
  const dismissed = [];
  const props = { visible: true, ready: true, files: [], onOpen: (value) => opened.push(value),
    onShare: async (value) => { shared.push(value); }, onDismiss: () => dismissed.push("dismiss"), onClose() {} };
  const render = () => walk(life.render(() => ConversationFilesSheet(props)));

  let nodes = render();
  assert.equal(nodes.find(node => node.type === "BottomSheet").props.title, "本对话文件");
  assert.equal(nodes.find(node => node.type === "Empty").props.title, "本对话还没有交付文件");
  assert.equal(nodes.some(node => node.props?.accessibilityLabel === "搜索文件名"), false, "no search box without files");

  props.files = model.conversationFiles([row("turn:1", "assistant", [
    presented(1, "采购清单.md", "v"), presented(2, "Weekly-Plan.CSV", "v"),
  ])], "v");
  nodes = render();
  assert.equal(nodes.find(node => node.type === "BottomSheet").props.subtitle, "已交付 2 个文件");
  assert.equal(nodes.filter(node => node.type === "ChatFileCard").length, 2);
  const searchBox = () => render().find(node => node.props?.accessibilityLabel === "搜索文件名");
  assert.equal(searchBox().props.value, "");

  searchBox().props.onChangeText("WEEKLY");
  nodes = render();
  assert.equal(nodes.filter(node => node.type === "ChatFileCard").length, 1);
  assert.equal(nodes.find(node => node.type === "ChatFileCard").props.file.name, "Weekly-Plan.CSV");
  nodes.find(node => node.type === "ChatFileCard").props.onOpen();
  nodes.find(node => node.type === "ChatFileCard").props.onShare(); await settle();
  assert.deepEqual(opened.map(value => value.name), ["Weekly-Plan.CSV"]);
  assert.deepEqual(shared.map(value => value.name), ["Weekly-Plan.CSV"]);
  assert.equal(render().find(node => node.type === "ChatFileCard").props.busy, false, "a finished share releases the card");
  render().find(node => node.type === "BottomSheet").props.onDismiss();
  assert.deepEqual(dismissed, ["dismiss"], "the sheet reports the end of its native dismissal");

  searchBox().props.onChangeText("  方案  ");
  nodes = render();
  assert.equal(nodes.find(node => node.type === "Empty").props.title, "没有匹配的文件");
  assert.equal(nodes.some(node => node.type === "ChatFileCard"), false, "an unmatched query hides every file");

  searchBox().props.onChangeText("没有这个文件");
  nodes = render();
  assert.equal(nodes.find(node => node.type === "Empty").props.title, "没有匹配的文件");
  assert.match(nodes.find(node => node.type === "Empty").props.children, /没有这个文件/);
  nodes.find(node => node.type === "ActionLink" && node.props.children === "清空搜索").props.onPress();
  assert.equal(searchBox().props.value, "");
  assert.equal(render().filter(node => node.type === "ChatFileCard").length, 2);

  searchBox().props.onChangeText("清单");
  assert.equal(render().filter(node => node.type === "ChatFileCard").length, 1);
  render().find(node => node.type === "BottomSheet").props.onClose();
  assert.equal(searchBox().props.value, "", "closing the sheet clears the query");

  props.files = []; props.ready = false; nodes = render();
  assert.match(nodes.find(node => node.type === "Text").props.children, /正在读取对话文件/);
});

test("a failed share stays visible in the sheet, blocks repeat taps and retries with the same query", async () => {
  const life = hooks(), attempts = [];
  let fail;
  const { ConversationFilesSheet } = load("ConversationFilesSheet.tsx", {
    react: life.react, "react/jsx-runtime": jsx,
    "react-native": { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View" },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./BottomSheet": { BottomSheet: "BottomSheet" }, "./ChatFileCard": { ChatFileCard: "ChatFileCard" },
    "./conversationFiles": model,
    "./ui": { useUi: () => ({ s: {}, colors: theme.lightColors }), Empty: "Empty", ActionLink: "ActionLink", humanError: (error) => error.message },
    "./theme": theme,
  });
  const props = { visible: true, ready: true,
    files: model.conversationFiles([row("turn:1", "assistant", [presented(1, "采购清单.md", "v"), presented(2, "Weekly-Plan.CSV", "v")])], "v"),
    onOpen() {}, onClose() {},
    onShare: (file) => { attempts.push(file.name); return new Promise((_resolve, reject) => { fail = reject; }); } };
  const render = () => walk(life.render(() => ConversationFilesSheet(props)));
  const card = () => render().find(node => node.type === "ChatFileCard");
  const alert = () => { const node = render().find(item => item.props?.accessibilityRole === "alert"); return node ? [].concat(node.props.children).join("") : ""; };
  const retry = () => render().find(node => node.type === "ActionLink" && node.props.children === "重试分享");

  render().find(node => node.props?.accessibilityLabel === "搜索文件名").props.onChangeText("清单");
  assert.equal(render().filter(node => node.type === "ChatFileCard").length, 1);
  card().props.onShare(); await settle();
  assert.deepEqual(attempts, ["采购清单.md"]);
  assert.equal(card().props.busy, true, "the card cannot start a second share while one is preparing");
  card().props.onShare(); card().props.onShare(); await settle();
  assert.deepEqual(attempts, ["采购清单.md"], "repeat taps do not start another download");
  assert.match([].concat(render().map(node => node.props?.children).flat()).join(""), /正在准备「采购清单.md」/);

  fail(new Error("文件下载失败（503）")); await settle();
  assert.equal(alert(), "分享未完成：文件下载失败（503）");
  assert.equal(card().props.busy, false, "the card is usable again after the failure");
  assert.equal(render().find(node => node.props?.accessibilityLabel === "搜索文件名").props.value, "清单", "the search stays applied");

  retry().props.onPress(); await settle();
  assert.deepEqual(attempts, ["采购清单.md", "采购清单.md"]);
  fail(new Error("仍然失败")); await settle();
  assert.equal(alert(), "分享未完成：仍然失败");
  assert.equal(render().filter(node => node.type === "ChatFileCard").length, 1, "the filtered list keeps the same result");

  render().find(node => node.type === "BottomSheet").props.onClose();
  assert.equal(alert(), "", "closing the sheet clears the share failure");
});

test("the preview reports its native dismissal once on each platform", () => {
  for (const platform of ["android", "ios"]) {
    const life = hooks(), dismissed = [];
    const { ResourcePreview } = load("ResourcePreview.tsx", {
      react: life.react, "react/jsx-runtime": jsx,
      "react-native": { ActivityIndicator: "ActivityIndicator", Image: "Image", Modal: "Modal", Platform: { OS: platform },
        Pressable: "Pressable", StyleSheet: { create: (value) => value, hairlineWidth: 1 }, Text: "Text", View: "View", ScrollView: "ScrollView" },
      "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
      "./api": { request: async () => ({}) }, "./MessageBody": { MessageBody: "MessageBody" },
      "./resources": { shareResource: async () => {} },
      "./ThemeProvider": { useThemedStyles: (factory) => factory(theme.lightColors) },
      "./theme": theme,
      "./ui": { useUi: () => ({ s: {}, colors: theme.lightColors }), ActionLink: "ActionLink", IconAction: "IconAction", humanError: (error) => error.message },
    });
    const props = { connection: { url: "https://example.test", token: "token" }, resource: null, onClose() {}, onDismiss: () => dismissed.push("dismiss") };
    const render = () => walk(life.render(() => ResourcePreview(props)));
    render();
    assert.deepEqual(dismissed, [], `${platform} does not report a dismissal before anything opened`);
    props.resource = { id: "r1", name: "report.pdf", mime_type: "application/pdf", size: 2048 };
    render();
    assert.deepEqual(dismissed, [], `${platform} stays open while the resource is visible`);
    props.resource = null;
    const nodes = render();
    if (platform === "ios") {
      assert.deepEqual(dismissed, [], "iOS reports only after the native modal finishes dismissing");
      nodes.find(node => node.type === "Modal").props.onDismiss();
    }
    assert.deepEqual(dismissed, ["dismiss"], `${platform} reports exactly one dismissal`);
    render();
    assert.deepEqual(dismissed, ["dismiss"], "later renders do not report again");
  }
});
