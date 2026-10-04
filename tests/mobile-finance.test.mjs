import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { availablePreference } from "../src/providerEditing.ts";
import * as theme from "../src/theme.ts";
import { ApiError } from "../src/api.ts";

function load(name, dependencies, globals = {}) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${name}.tsx`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, AbortController, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, ...globals, require: (id) => {
    assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
    return dependencies[id];
  } });
  return exports;
}
const walk = (node) => node?.props ? [node, ...[node.props.children].flat(Infinity).flatMap(walk)] : [];
const text = (node) => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : node?.props ? text(node.props.children) : "";
const native = Object.fromEntries(["ActivityIndicator", "FlatList", "Modal", "Pressable", "ScrollView", "Text", "View", "Image"].map((name) => [name, name]));
const catalog = { roles: { chat: "global", task: "global" }, items: ["global", "assigned", "chosen"].map((id) => ({ id, name: `${id} model`, reasoning_levels: ["high"], default_reasoning_effort: "high" })) };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function hooks() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let rendering = false;
  let renderAgain = false;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (rendering && !Object.is(slots[index], next)) renderAgain = true;
        slots[index] = next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { deps, cleanup: effect() };
      });
    },
    useCallback(callback, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) slots[index] = { deps, callback };
      return slots[index].callback;
    },
  };
  return { react, render(component, props) {
    let result;
    do {
      cursor = 0; effects = []; renderAgain = false; rendering = true;
      result = component(props);
      rendering = false;
    } while (renderAgain);
    const pending = effects; effects = [];
    pending.forEach((effect) => effect());
    return result;
  } };
}

function chatHarness(state = {}, options = {}) {
  const calls = [];
  const hookInputs = [];
  const lifecycle = hooks();
  const sync = () => {};
  const chat = {
    messages: [], pendingRuns: [], list: { current: null }, refresh: { current() {} }, nearBottomRef: { current: true },
    draft: { text: "", attachments: [], pending: null }, draftReady: true, kind: "chat", intent: "queue", busy: false,
    send: (body) => calls.push(body), setError() {}, setKind() {}, ...state,
  };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: options.react ?? lifecycle.react,
    "react-native": { ...native, StyleSheet: { create: (styles) => styles } },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./providerEditing": { availablePreference },
    "./theme": theme,
    "./ThemeProvider": { useThemedStyles: (factory) => factory(theme.darkColors) },
    "./ui": { useUi: () => ({ s: {}, colors: theme.darkColors }), Button: "Button", Empty: "Empty", SheetHeader: "SheetHeader", humanError: (e) => e.message, timeLabel: String, runLabels: { running: "执行中", completed: "已完成", interrupted: "已中断" } },
    "./ConnectionStatus": { useSyncStatus: () => sync },
    "./useChat": { useChat: (input) => { hookInputs.push(input); return chat; } },
    "./api": { request: options.request ?? (async (_connection, path, options) => { calls.push({ path, ...options }); return options.body; }) },
  };
  for (const name of ["MessageBody", "ConversationComposer", "ReasoningPicker", "ModelPicker", "Attachments", "ApprovalCards", "RunReport", "FilesPanel", "SearchPicker"]) dependencies[`./${name}`] = { [name]: name };
  const { ChatPanel } = load("ChatPanel", dependencies, options.globals);
  const defaults = { connection: {}, conversation: { id: "finance-chat", agent_id: "finance", model_id: null, reasoning_effort: null }, catalog, assistantName: "财务助手", onRefresh() {}, onConversationChanged() {} };
  return { calls, hookInputs, lifecycle, render: (props = {}) => walk(lifecycle.render(ChatPanel, { ...defaults, ...props })) };
}

function financeHarness(colors = theme.lightColors) {
  const lifecycles = new Map();
  let active;
  const keyboard = new Map();
  const react = Object.fromEntries(["useState", "useRef", "useEffect", "useCallback"].map((name) => [name, (...args) => active.react[name](...args)]));
  const { FinancePage } = load("FinancePage", {
    "react/jsx-runtime": jsxRuntime, react,
    "react-native": { ...native, StyleSheet: { create: (styles) => styles, hairlineWidth: 1 }, Keyboard: { isVisible: () => false, addListener: (name, callback) => { keyboard.set(name, callback); return { remove() {} }; } } },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./ChatPanel": { ChatPanel: "ChatPanel" },
    "./ui": { useUi: () => ({ s: { muted: { color: colors.muted } }, colors }), IconAction: "IconAction", timeLabel: (value) => `记录于 ${value}` },
    "./ThemeProvider": { useThemedStyles: (factory) => factory(colors) },
    "./theme": theme,
  });
  function render(component, props) {
    if (!lifecycles.has(component)) lifecycles.set(component, hooks());
    active = lifecycles.get(component);
    return active.render(component, props);
  }
  const defaults = { connection: {}, conversation: { id: "finance", model_id: null }, finance: { balances: [], recent: [] }, catalog, onBack() {} };
  return { keyboard, render: (props = {}) => walk(render(FinancePage, { ...defaults, ...props })), child: (node) => render(node.type, node.props) };
}

function runDetailHarness(request, globals = {}) {
  let active;
  const react = Object.fromEntries(["useState", "useRef", "useEffect", "useCallback"].map((name) => [name, (...args) => active.react[name](...args)]));
  const app = chatHarness({ detail: "run-1" }, { react, request, globals });
  active = app.lifecycle;
  const entry = app.render().find((node) => typeof node.type === "function" && node.props.id === "run-1");
  const lifecycle = hooks();
  return () => { active = lifecycle; return walk(lifecycle.render(entry.type, entry.props)); };
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
  await nodes.find((node) => node.type === "ModelPicker").props.onSelect("chosen");
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
    const props = app.render().find((node) => node.type === "ConversationComposer").props;
    assert.equal(props.canSend, !state.busy);
    assert.equal(props.editable, !state.busy && !state.draft.pending);
    assert.equal(props.attachmentLocked, !!(state.busy || state.draft.pending));
    assert.equal(props.optionsLocked, !!(state.busy || state.draft.pending));
    assert.equal(typeof props.children.props.remove, state.busy || state.draft.pending ? "undefined" : "function");
    if (props.canSend) { props.onSend(); assert.equal(app.calls.length, 1); }
  }
});

test("finance forwards navigation and search targets, reflects the active model, and keeps empty guidance short", () => {
  for (const colors of [theme.lightColors, theme.darkColors]) {
    const app = financeHarness(colors);
    let back = 0;
    const handled = [];
    const props = { backLabel: "搜索结果", focusMessageSeq: 42, onBack: () => back++, onFocusHandled: (seq) => handled.push(seq), agentModelId: "assigned" };
    const nodes = app.render(props);
    nodes.find((node) => node.type === "IconAction").props.onPress();
    assert.equal(back, 1);
    assert.equal(nodes.find((node) => node.type === "IconAction").props.label, "返回搜索结果");
    assert.match(text(nodes), /assigned model/);
    const chat = nodes.find((node) => node.type === "ChatPanel");
    assert.equal(chat.props.focusMessageSeq, 42);
    chat.props.onFocusHandled(42);
    assert.deepEqual(handled, [42]);
    chat.props.onComposerContext({ conversationId: "finance", modelId: "chosen", kind: "task" });
    assert.match(text(app.render(props)), /任务 · chosen model/);
    const overview = app.child(chat.props.intro);
    assert.equal(overview.type, "Text");
    assert.equal(overview.props.style.color, colors.muted);
    assert.equal(nodes.some((node) => node.type === "Image"), false);
  }
});

test("finance overview expands records with notes and dates, then yields space when the keyboard opens", () => {
  const app = financeHarness();
  const record = (id, kind) => ({ id, kind, platform: "支付宝", amount: "30.00", note: `用途 ${id}`, created_at: "2026-10-04" });
  const props = { finance: { balances: [record("a", "balance"), record("b", "balance")], recent: [record("c", "expense"), record("d", "income")] } };
  const getChat = () => app.render(props).find((node) => node.type === "ChatPanel");
  let overview = app.child(getChat().props.intro);
  assert.equal(walk(overview).filter((node) => typeof node.type === "function").length, 2);
  const expand = walk(overview).find((node) => node.props.accessibilityLabel === "展开财务速览");
  expand.props.onPress();
  overview = app.child(getChat().props.intro);
  const rows = walk(overview).filter((node) => typeof node.type === "function");
  assert.equal(rows.length, 4);
  const expense = app.child(rows.find((node) => node.props.item.id === "c"));
  assert.match(text(expense), /用途 c/);
  assert.match(text(expense), /记录于 2026-10-04/);
  assert.match(text(expense), /−¥30.00/);
  app.keyboard.get("keyboardDidShow")();
  assert.equal(app.child(getChat().props.intro), null);
  app.keyboard.get("keyboardDidHide")();
  overview = app.child(getChat().props.intro);
  assert.equal(walk(overview).filter((node) => typeof node.type === "function").length, 2);
});

test("search focus is acknowledged only when visible and consuming the navigation target preserves its history window", () => {
  const handled = [];
  const timers = [];
  const scrolls = [];
  const messages = [{ seq: 42, id: "hit" }];
  const app = chatHarness({ messages, loading: false, list: { current: { scrollToIndex: (request) => scrolls.push(request) } } }, { globals: { setTimeout: (callback) => { timers.push(callback); return timers.length; }, clearTimeout() {} } });
  const props = { focusMessageSeq: 42, onFocusHandled: (seq) => handled.push(seq) };
  let list = app.render(props).find((node) => node.type === "FlatList");
  timers.shift()();
  assert.equal(scrolls.at(-1).index, 0);
  list.props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: { seq: 41 } }] });
  assert.deepEqual(handled, []);
  list.props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: { seq: 42 } }] });
  list.props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: { seq: 42 } }] });
  assert.deepEqual(handled, [42]);
  app.render({ ...props, focusMessageSeq: null });
  assert.equal(app.hookInputs.at(-1).focusMessageSeq, 42);
  messages.push({ seq: 61, id: "next-hit" });
  app.render({ ...props, focusMessageSeq: 61 });
  list = app.render({ ...props, focusMessageSeq: 61 }).find((node) => node.type === "FlatList");
  assert.equal(app.hookInputs.at(-1).focusMessageSeq, 61);
  timers.shift()();
  assert.equal(scrolls.at(-1).index, 1);
  list.props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: { seq: 61 } }] });
  assert.deepEqual(handled, [42, 61]);
  app.render({ ...props, focusMessageSeq: null });
  list = app.render({ ...props, focusMessageSeq: 61 }).find((node) => node.type === "FlatList");
  timers.shift()();
  assert.equal(scrolls.length, 3);
  list.props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: { seq: 61 } }] });
  assert.deepEqual(handled, [42, 61, 61]);
});

test("task details show formatted results and unique downloadable artifacts while keeping approvals and trace access", async () => {
  let active;
  const react = Object.fromEntries(["useState", "useRef", "useEffect", "useCallback"].map((name) => [name, (...args) => active.react[name](...args)]));
  const resource = { id: "file-1", name: "报告.md", path: "report.md", size: 100, mime_type: "text/markdown", conversation_id: "finance-chat" };
  const run = { id: "run-1", prompt: "整理报告", status: "running", result: "## 结论\n[来源](https://example.com)", cancel_requested: false };
  let cancelled = 0;
  const app = chatHarness({ detail: run.id, cancel: async () => { cancelled++; } }, { react, request: async (_connection, path) => path.includes("/events") ? { items: [
    { seq: 1, type: "artifact", data: { resource }, created_at: "today" },
    { seq: 2, type: "artifact", data: { resource }, created_at: "today" },
    { seq: 3, type: "artifact", data: { resource: { name: "broken" } }, created_at: "today" },
    { seq: 4, type: "operation", data: { tool: "read_text_file", state: "succeeded" }, created_at: "today" },
  ], next_cursor: null } : run });
  active = app.lifecycle;
  const entry = app.render().find((node) => typeof node.type === "function" && node.props.id === run.id);
  const detailLifecycle = hooks();
  const render = () => { active = detailLifecycle; return walk(detailLifecycle.render(entry.type, entry.props)); };
  render(); await settle();
  let nodes = render();
  assert.equal(nodes.find((node) => node.type === "MessageBody").props.children, run.result);
  assert.equal(nodes.find((node) => node.type === "Attachments").props.items.length, 1);
  assert.equal(nodes.find((node) => node.type === "Attachments").props.items[0].id, resource.id);
  assert.equal(nodes.find((node) => node.type === "ApprovalCards").props.runId, run.id);
  assert.doesNotMatch(text(nodes), /read_text_file/);
  nodes.find((node) => node.props.accessibilityLabel === "展开执行轨迹").props.onPress();
  nodes = render();
  assert.match(text(nodes), /read_text_file/);
  nodes.find((node) => node.type === "Button" && node.props.children === "取消这次运行").props.onPress();
  assert.equal(render().find((node) => node.props.children === "取消这次运行").props.disabled, true);
  await settle();
  assert.equal(cancelled, 1);
});

test("task details expose a local initial-load error and recover through their own retry action", async () => {
  let failing = true;
  const run = { id: "run-1", prompt: "整理报告", status: "completed", result: "报告已完成" };
  const render = runDetailHarness(async (_connection, path) => {
    if (failing) throw new Error("服务暂不可用");
    return path.includes("/events") ? { items: [], next_cursor: null } : run;
  });
  assert.ok(render().some((node) => node.type === "ActivityIndicator"));
  await settle();
  let nodes = render();
  assert.match(text(nodes), /任务暂时无法读取：服务暂不可用/);
  assert.ok(nodes.some((node) => node.props.accessibilityRole === "alert"));
  assert.equal(nodes.some((node) => node.type === "ActivityIndicator"), false);
  const retry = nodes.find((node) => node.type === "Button" && node.props.children === "重试读取任务");
  assert.equal(retry.props.disabled, false);
  failing = false;
  retry.props.onPress();
  assert.equal(render().find((node) => node.props.children === "重试读取任务").props.disabled, true);
  await settle();
  nodes = render();
  assert.equal(nodes.find((node) => node.type === "MessageBody").props.children, run.result);
  assert.doesNotMatch(text(nodes), /暂时无法读取|暂未更新/);
});

test("task results render before pending events and remain readable when event loading fails", async () => {
  let rejectEvents;
  let firstEvents = true;
  const pendingEvents = new Promise((_resolve, reject) => { rejectEvents = reject; });
  const resource = { id: "file-1", name: "报告.md", path: "report.md", size: 100, mime_type: "text/markdown", conversation_id: "finance-chat" };
  const run = { id: "run-1", prompt: "整理报告", status: "completed", result: "## 已有结果" };
  const render = runDetailHarness(async (_connection, path) => {
    if (!path.includes("/events")) return run;
    if (firstEvents) { firstEvents = false; return pendingEvents; }
    return { items: [{ seq: 1, type: "artifact", data: { resource } }], next_cursor: null };
  });
  render(); await settle();
  let nodes = render();
  assert.equal(nodes.find((node) => node.type === "MessageBody").props.children, run.result);
  assert.equal(nodes.some((node) => node.type === "ActivityIndicator"), false);
  rejectEvents(new Error("步骤读取失败"));
  await settle();
  nodes = render();
  assert.equal(nodes.find((node) => node.type === "MessageBody").props.children, run.result);
  assert.match(text(nodes), /步骤与交付文件暂未更新：步骤读取失败/);
  nodes.find((node) => node.props.accessibilityLabel === "展开执行轨迹").props.onPress();
  assert.doesNotMatch(text(render()), /尚无执行事件/);
  nodes.find((node) => node.type === "Button" && node.props.children === "重试读取步骤").props.onPress();
  await settle();
  nodes = render();
  assert.equal(nodes.find((node) => node.type === "Attachments").props.items[0].id, resource.id);
  assert.doesNotMatch(text(nodes), /步骤读取失败/);
});

test("collapsed run verification keeps blockers visible and reveals detailed usage on request", async () => {
  const lifecycle = hooks();
  const sync = () => {};
  const { RunReport } = load("RunReport", {
    "react/jsx-runtime": jsxRuntime, react: lifecycle.react,
    "react-native": native, "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./ConnectionStatus": { useSyncStatus: () => sync }, "./theme": theme,
    "./ui": { useUi: () => ({ s: {}, colors: theme.lightColors }) },
    "./api": { ApiError, request: async () => ({ steps: [{ id: "check", status: "blocked", description: "核验产物", evidence: { reason: "缺少输出文件" } }], usage: { model_attempts: 2, tool_calls: 1, input_tokens: 100, output_tokens: 20, unknown_usage: 0 } }) },
  });
  const props = { connection: {}, runId: "run" };
  const render = () => walk(lifecycle.render(RunReport, props));
  render(); await settle();
  let nodes = render();
  assert.match(text(nodes), /缺少输出文件/);
  assert.doesNotMatch(text(nodes), /输入 100/);
  nodes.find((node) => node.props.accessibilityLabel === "展开核对与用量").props.onPress();
  nodes = render();
  assert.match(text(nodes), /输入 100/);
  assert.match(text(nodes), /核验产物/);
});
