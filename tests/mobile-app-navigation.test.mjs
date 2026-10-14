import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";
import * as api from "../src/api.ts";
import * as theme from "../src/theme.ts";
import { availablePreference } from "../src/providerEditing.ts";
import { homeEntries, targetKey } from "../src/homeEntries.ts";

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
function hooks() {
  const slots = []; let cursor = 0; let effects = [];
  const changed = (a, b) => !a || a.length !== b.length || b.some((item, i) => item !== a[i]);
  return { react: {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (changed(old?.deps, deps)) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
    useCallback(fn, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { deps, fn }; return slots[i].fn; },
  }, render(fn) { cursor = 0; effects = []; const result = fn(); effects.forEach((effect) => effect()); return result; }, unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}
function load(filename, dependencies, suffix = "") {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${filename}`, import.meta.url), "utf8") + suffix, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, AbortController, Error, Date, encodeURIComponent, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require(name) { if (name.startsWith("../assets/")) return name; assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; },
  });
  return exports;
}
function appHarness() {
  const lifecycle = hooks(), calls = [], reminderVersions = [], backHandlers = new Set(); let uuid = 0;
  const sync = () => {};
  const conversations = ["finance", "health"].map((agent_id) => ({ id: `${agent_id}-history`, title: `${agent_id} history`, agent_id, model_id: null, reasoning_effort: null, project_id: null, updated_at: "2028-06-02T10:00:00Z" }));
  const preferences = { pins: [{ kind: "project", id: "legacy-project", title: "旧项目" }, { kind: "conversation", id: "finance-history", title: "财务历史" }], visited: [{ kind: "project", id: "legacy-project", title: "旧项目" }], opened: { "project:legacy-project": "2028-06-02T11:00:00Z" } };
  const welcome = { value: { text: "hello", kind: "task", models: { chat: null, task: null }, efforts: { chat: null, task: null }, searchId: null }, ready: true, error: "", consumeText: async () => {}, retry() {}, setText() {}, setKind() {}, setSearch() {}, setModel() {}, setEffort() {} };
  const native = { ...Object.fromEntries(["ActivityIndicator", "Image", "KeyboardAvoidingView", "Modal", "Pressable", "Text", "View"].map((name) => [name, name])), Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, BackHandler: { addEventListener: (_event, callback) => { backHandlers.add(callback); return { remove: () => backHandlers.delete(callback) }; } }, Keyboard: { isVisible: () => false, dismiss() {}, addListener: () => ({ remove() {} }) } };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime, react: lifecycle.react, "react-native": native,
    "react-native-safe-area-context": { SafeAreaProvider: "SafeAreaProvider", SafeAreaView: "SafeAreaView" }, "expo-status-bar": { StatusBar: "StatusBar" }, "expo-crypto": { randomUUID: () => `message-${++uuid}` }, "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./providerEditing": { availablePreference }, "./ui": { useUi: () => ({ s: {}, colors: theme.lightColors }), humanError: (error) => error.message },
    "./ConnectionStatus": { useSyncStatus: () => sync, ConnectionStatusProvider: "ConnectionStatusProvider", ServiceStatusNotice: "ServiceStatusNotice" },
    "./useHomePreferences": { useHomePreferences: () => ({ preferences, ready: true, opened() {}, toggle() {}, retry() {} }) }, "./useWelcomeDraft": { useWelcomeDraft: () => welcome }, "./homeEntries": { targetKey },
    "./useHealthReminders": { useHealthReminders(_connection, revision) { reminderVersions.push(revision); } }, "./storage": { draftKey: () => "draft", saveDraft: async () => {}, clearDraft: async () => {} },
    "./api": { ...api, request: async (_connection, path, options) => {
      calls.push({ path, ...options });
      if (path === "/status") return { model_ready: true, worker_online: true };
      if (path === "/assistant") return { name: "知行" };
      if (path === "/models") return { items: [], roles: { chat: null } };
      if (path === "/agents") return { items: ["finance", "health"].map((id) => ({ id, name: id === "finance" ? "财务助手" : "健康助手", model_id: null })) };
      if (path === "/conversations" && options?.method === "POST") return { ...options.body, id: `${options.body.agent_id}-created`, model_id: null, reasoning_effort: null };
      if (path.startsWith("/conversations/") && !path.includes("?") && !path.endsWith("/messages")) return conversations.find((item) => path === `/conversations/${item.id}`) ?? { id: "loaded", agent_id: null };
      if (path.endsWith("/messages")) return {};
      if (path.startsWith("/conversations")) return { items: conversations, next_cursor: null, previous_cursor: null };
      return { items: [], next_cursor: null, previous_cursor: null };
    } },
  };
  for (const name of ["ThemeProvider", "AppearanceControl", "Notice", "ChatPanel", "AiHome", "AiDrawer", "FinanceDashboard", "HealthPage", "LifeSummary", "ResourcesPanel", "ModelsPanel", "ProvidersPanel", "ResourcePreview", "OverviewPanels", "SettingsPanel", "SettingsHome", "SearchPicker", "AgentsPanel", "DeviceCapabilitiesPanel"]) dependencies[`./${name}`] = Object.fromEntries([name, "NoticeProvider", "HomePanel", "ConnectionSettingsPanel", "PersonaSettingsPanel"].map((key) => [key, key]));
  const exported = load("AssistantApp.tsx", dependencies, "\nexport { ConnectedSession, BottomTabs };\n");
  const props = { connection: { url: "https://example.test", token: "test" }, onConnect() {}, onDisconnect() {}, connectionError: "" };
  const render = () => walk(lifecycle.render(() => exported.ConnectedSession(props)));
  return { render, calls, preferences, welcome, reminderVersions, back() { return [...backHandlers].at(-1)?.(); }, renderTabs() { const node = render().find((item) => item.type === exported.BottomTabs); assert.ok(node, "bottom navigation visible"); return walk(exported.BottomTabs(node.props)); }, unmount: lifecycle.unmount };
}
const find = (app, name) => app.render().find((node) => node.type === name);

test("home finance and health entries open their dedicated pages, agent chats, and return to the right service", async () => {
  for (const [entry, pageName, agent] of [["onLife", "FinanceDashboard", "finance"], ["onWork", "HealthPage", "health"]]) {
    const app = appHarness(); app.render(); await settle();
    find(app, "HomePanel").props[entry]();
    const service = find(app, pageName); assert.ok(service);
    service.props.onChat(); await settle();
    const chat = find(app, "ChatPanel"); assert.equal(chat.props.conversation.agent_id, agent); assert.equal(chat.props.initialKind, "chat");
    assert.equal(app.render().some((node) => typeof node.type === "function" && node.type.name === "BottomTabs"), false);
    app.render().find((node) => node.props?.accessibilityLabel === "返回上一页").props.onPress();
    assert.ok(find(app, pageName));
    find(app, pageName).props.onChat(); await settle(); assert.ok(find(app, "ChatPanel"));
    assert.equal(app.back(), true); assert.ok(find(app, pageName));
    assert.equal(app.calls.filter((call) => call.path === "/conversations" && call.method === "POST").length, 0);
    app.unmount();
  }
});

test("a service prompt starts the correct child agent and posts a chat request before returning to the service", async () => {
  const app = appHarness(); app.render(); await settle(); find(app, "HomePanel").props.onWork();
  find(app, "HealthPage").props.onChat("请按当前饮食约定推荐下一餐"); await settle();
  const create = app.calls.find((call) => call.path === "/conversations" && call.method === "POST");
  assert.equal(create.body.agent_id, "health"); assert.equal(create.body.project_id, null);
  const message = app.calls.find((call) => call.path === "/conversations/health-created/messages");
  assert.equal(message.body.kind, "chat"); assert.equal(message.body.content, "请按当前饮食约定推荐下一餐");
  assert.equal(find(app, "ChatPanel").props.conversation.agent_id, "health");
  app.back(); assert.ok(find(app, "HealthPage")); app.unmount();
});

test("the bottom navigation has finance and health and exposes no work or task destination", async () => {
  const app = appHarness(); app.render(); await settle();
  const tabs = app.renderTabs().filter((node) => node.props?.accessibilityRole === "tab" || node.props?.accessibilityRole === "button");
  assert.deepEqual(tabs.map((node) => node.props.accessibilityLabel), ["首页", "财务", "知行", "健康", "设置"]);
  tabs.find((node) => node.props.accessibilityLabel === "财务").props.onPress(); assert.ok(find(app, "FinanceDashboard"));
  app.renderTabs().find((node) => node.props.accessibilityLabel === "健康").props.onPress(); assert.ok(find(app, "HealthPage"));
  app.unmount();
});

test("legacy project pins and visits do not produce an unopenable home entry", async () => {
  const app = appHarness(); app.render(); await settle(); const home = find(app, "HomePanel").props;
  assert.equal(home.preferences.pins.some((item) => item.kind === "project"), false);
  const entries = homeEntries(home.conversations, home.projects ?? [], home.resources, home.preferences);
  assert.equal(entries.recent.some((item) => item.kind === "project"), false);
  assert.equal(entries.pins.some((item) => item.kind === "conversation"), true);
  assert.equal(app.preferences.pins.some((item) => item.kind === "project"), true, "legacy saved data is retained");
  app.unmount();
});

test("welcome always starts chat even when a previous installation saved task mode", async () => {
  const app = appHarness(); app.render(); await settle(); find(app, "HomePanel").props.onChat();
  assert.equal(find(app, "AiHome").props.kind, "chat"); find(app, "AiHome").props.onSend(); await settle();
  const sent = app.calls.find((call) => call.path.endsWith("/messages")); assert.equal(sent.body.kind, "chat"); app.unmount();
});

test("every welcome suggestion keeps chat mode and the composer exposes no task switch", () => {
  const lifecycle = hooks(), kinds = [], prompts = [];
  const native = { ...Object.fromEntries(["View", "Text", "TextInput", "Pressable", "ScrollView", "ActivityIndicator"].map((name) => [name, name])), StyleSheet: { create: (value) => value } };
  const dependencies = { "react/jsx-runtime": jsxRuntime, react: lifecycle.react, "react-native": native, "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" }, "./theme": theme, "./ui": { useUi: () => ({ s: {}, colors: theme.lightColors }), ActionLink: "ActionLink" }, "./ThemeProvider": { useThemedStyles: (factory) => factory(theme.lightColors) }, "./api": {}, "./ConversationComposer": { ConversationComposer: "ConversationComposer" }, "./ReasoningPicker": { ReasoningPicker: "ReasoningPicker" }, "./ModelPicker": { ModelPicker: "ModelPicker" }, "./SearchPicker": { SearchPicker: "SearchPicker" } };
  const { AiHome } = load("AiHome.tsx", dependencies);
  const props = { name: "知行", draft: "", kind: "chat", busy: false, connection: {}, catalog: null, modelId: null, effort: null, onDraft: (text) => prompts.push(text), onKind: (kind) => kinds.push(kind), onSend() {}, onFiles() {}, onModelId() {}, onEffort() {}, onSearchProviderId() {} };
  const nodes = walk(lifecycle.render(() => AiHome(props)));
  nodes.filter((node) => node.type === "Pressable" && node.props.accessibilityRole === "button").forEach((node) => node.props.onPress());
  assert.equal(kinds.length, 6); assert.ok(kinds.every((kind) => kind === "chat")); assert.equal(prompts.length, 6);
  const composerLife = hooks();
  const { ConversationComposer } = load("ConversationComposer.tsx", { ...dependencies, react: composerLife.react, "./ThemeProvider": { useTheme: () => ({ colors: theme.lightColors }), useThemedStyles: (factory) => factory(theme.lightColors) }, "./api": { request: async () => ({ items: [] }) }, "./BrandIcon": { BrandIcon: "BrandIcon" }, "./reasoning": { thinkingLabel: () => "默认" } });
  const composer = nodes.find((node) => node.type === "ConversationComposer");
  const controls = walk(composerLife.render(() => ConversationComposer(composer.props))).filter((node) => node.type === "Pressable");
  assert.equal(controls.some((node) => /任务|切换模式/.test(node.props.accessibilityLabel)), false);
});

test("chat completion refreshes service data and reminders immediately while ordinary polling does not replan", async () => {
  const app = appHarness(); app.render(); await settle(); find(app, "HomePanel").props.onWork();
  assert.equal(find(app, "HealthPage").props.refreshKey, 0);
  find(app, "HealthPage").props.onChat(); await settle();
  const chat = () => find(app, "ChatPanel");
  const run = (id, status) => ({ id, conversation_id: "health-history", status, kind: "chat" });
  chat().props.onRefresh(); app.render();
  assert.equal(app.reminderVersions.at(-1), 0, "sending or refreshing a chat does not imply a saved meal");
  chat().props.onRunsChanged([run("meal-run", "running")]); app.render(); assert.equal(app.reminderVersions.at(-1), 0);
  chat().props.onRunsChanged([run("meal-run", "completed")]); app.render(); assert.equal(app.reminderVersions.at(-1), 1);
  chat().props.onRunsChanged([run("meal-run", "completed")]); app.render(); assert.equal(app.reminderVersions.at(-1), 1);
  chat().props.onRunsChanged([run("partly-saved", "failed"), run("cancel-after-write", "cancelled")]); app.render();
  assert.equal(app.reminderVersions.at(-1), 2, "a terminal batch triggers one latest-data sync even after partial failure");
  chat().props.onRunsChanged([run("partly-saved", "running")]); app.render();
  chat().props.onRunsChanged([run("partly-saved", "failed")]); app.render(); assert.equal(app.reminderVersions.at(-1), 3, "a resumed run can complete service writes before failing again");
  app.back(); assert.equal(find(app, "HealthPage").props.refreshKey, 3);
  find(app, "HealthPage").props.onChat(); await settle();
  chat().props.onRunsChanged([run("meal-run", "completed")]); app.render(); assert.equal(app.reminderVersions.at(-1), 3, "opening the same saved chat does not reschedule old completion receipts");
  app.unmount();
});
