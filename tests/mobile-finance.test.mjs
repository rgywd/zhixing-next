import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { availablePreference } from "../src/providerEditing.ts";
import { lightColors, darkColors, typography } from "../src/theme.ts";

function load(name, dependencies) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${name}.tsx`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (id) => {
    assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
    return dependencies[id];
  } });
  return exports;
}
const walk = (node) => node?.props ? [node, ...[node.props.children].flat(Infinity).flatMap(walk)] : [];
const native = Object.fromEntries(["ActivityIndicator", "FlatList", "Modal", "Pressable", "ScrollView", "Text", "View", "Image"].map((name) => [name, name]));
const catalog = { roles: { chat: "global", task: "global" }, items: ["global", "assigned", "chosen"].map((id) => ({ id, reasoning_levels: ["high"], default_reasoning_effort: "high" })) };

function chatHarness(state = {}) {
  const calls = [];
  const chat = {
    messages: [], pendingRuns: [], list: { current: null }, refresh: { current() {} }, nearBottomRef: { current: true },
    draft: { text: "", attachments: [], pending: null }, draftReady: true, kind: "chat", intent: "queue", busy: false,
    send: (body) => calls.push(body), setError() {}, setKind() {}, ...state,
  };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: { useState: (value) => [value, () => {}], useEffect() {}, useRef: (value) => ({ current: value }) },
    "react-native": { ...native, StyleSheet: { create: (styles) => styles } },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./providerEditing": { availablePreference },
    "./ThemeProvider": { useThemedStyles: (factory) => factory(darkColors) },
    "./ui": { useUi: () => ({ s: {}, colors: darkColors }), Button: "Button", Empty: "Empty", humanError: String, timeLabel: String },
    "./ConnectionStatus": {}, "./useChat": { useChat: () => chat },
    "./api": { request: async (_connection, path, options) => { calls.push({ path, ...options }); return options.body; } },
  };
  for (const name of ["MessageBody", "ConversationComposer", "ReasoningPicker", "ModelPicker", "Attachments", "ApprovalCards", "RunReport", "FilesPanel", "SearchPicker"]) dependencies[`./${name}`] = { [name]: name };
  const { ChatPanel } = load("ChatPanel", dependencies);
  return { calls, render: (props = {}) => walk(ChatPanel({ connection: {}, conversation: { id: "finance-chat", agent_id: "finance", model_id: null, reasoning_effort: null }, catalog, assistantName: "财务助手", onRefresh() {}, onConversationChanged() {}, ...props })) };
}

test("finance shares chat controls, inherits its assigned model, and persists a conversation choice", async () => {
  const app = chatHarness();
  const nodes = app.render({ agentModelId: "assigned", intro: "finance-summary" });
  const composer = nodes.find((node) => node.type === "ConversationComposer");
  assert.equal(composer.props.model.id, "assigned");
  for (const action of ["onModel", "onReasoning", "onSearch"]) assert.equal(typeof composer.props[action], "function");
  const list = nodes.find((node) => node.type === "FlatList");
  assert.ok(walk(list.props.ListHeaderComponent).some((node) => node.props.children?.includes?.("finance-summary")));
  assert.equal(list.props.ListEmptyComponent, null);
  const picker = nodes.find((node) => node.type === "ModelPicker");
  await picker.props.onSelect("chosen");
  assert.equal(app.calls[0].path, "/conversations/finance-chat/model");
  assert.equal(app.calls[0].body.model_id, "chosen");
});

test("finance attachment-only sends and pending retries keep edits and controls locked", () => {
  const attachments = [{ id: "screenshot" }];
  for (const state of [
    { draft: { text: "", attachments, pending: null } },
    { draft: { text: "", attachments, pending: { id: "retry" } } },
    { draft: { text: "", attachments, pending: null }, busy: true },
  ]) {
    const app = chatHarness(state);
    const nodes = app.render();
    const props = nodes.find((node) => node.type === "ConversationComposer").props;
    assert.equal(props.canSend, !state.busy);
    assert.equal(props.editable, !state.busy && !state.draft.pending);
    assert.equal(props.attachmentLocked, !!(state.busy || state.draft.pending));
    assert.equal(props.optionsLocked, !!(state.busy || state.draft.pending));
    assert.equal(typeof props.children.props.remove, state.busy || state.draft.pending ? "undefined" : "function");
    if (props.canSend) { props.onSend(); assert.equal(app.calls.length, 1); }
  }
});

test("finance keeps the return path and readable overview in light, dark and narrow layouts", () => {
  for (const [mode, colors, width] of [["light", lightColors, 420], ["dark", darkColors, 420], ["light", lightColors, 320]]) {
    const { FinancePage } = load("FinancePage", {
      "react/jsx-runtime": jsxRuntime,
      "react-native": { ...native, StyleSheet: { create: (styles) => styles }, useWindowDimensions: () => ({ width }) },
      "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
      "./ChatPanel": { ChatPanel: "ChatPanel" },
      "./ui": { useUi: () => ({ s: { card: { backgroundColor: colors.surfaceRaised } }, colors }), BackLink: "BackLink", CardHeader: "CardHeader" },
      "./ThemeProvider": { useTheme: () => ({ mode }), useThemedStyles: (factory) => factory(colors) },
      "./theme": { typography },
      "../assets/life-header-red.png": "header-art", "../assets/life-footer-red.png": "footer-art",
    });
    let back = 0;
    const nodes = walk(FinancePage({ connection: {}, conversation: {}, finance: { balances: [], recent: [] }, catalog, onBack: () => back++ }));
    nodes.find((node) => node.type === "BackLink").props.onPress();
    assert.equal(back, 1);
    assert.equal(nodes.some((node) => node.type === "Image"), mode === "light" && width >= 380);
    const chat = nodes.find((node) => node.type === "ChatPanel");
    assert.equal(chat.props.assistantName, "财务助手");
    const overview = chat.props.intro.type(chat.props.intro.props);
    const empty = walk(overview).find((node) => typeof node.type === "function");
    const emptyNodes = walk(empty.type(empty.props));
    assert.equal(emptyNodes.some((node) => node.type === "Image"), mode === "light");
    assert.equal(emptyNodes.find((node) => node.type === "Text").props.style.color, colors.muted);
  }
});
