import assert from "node:assert/strict";
import { cacheHarness } from "./helpers/local-cache.mjs";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";
import * as api from "../src/api.ts";
import * as theme from "../src/theme.ts";
import * as permissions from "../src/dshPermissions.ts";
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
  dependencies = { "./dshPermissions": permissions, "./localCache": cacheHarness(), "./usePhotoPicker": { usePhotoPicker: () => ({ pick() {}, picking: false }) }, "./PhotoAttachments": { DraftAttachments: "DraftAttachments" }, "./ChatTextEditor": { ChatTextEditor: "ChatTextEditor" }, "./BottomSheet": { BottomSheet: "BottomSheet" }, ...dependencies };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${filename}`, import.meta.url), "utf8") + suffix, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, AbortController, Error, Date, encodeURIComponent, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require(name) { if (name === "./useSessionData") return load("useSessionData.ts", dependencies); if (name.startsWith("../assets/")) return name; assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; },
  });
  return exports;
}
function appHarness({ connected = true, modelPage = { items: [], roles: { chat: null } }, serviceStatus = { model_ready: true, worker_online: true }, failStatus = false, failModels = false, chosenModelId = null } = {}) {
  const lifecycle = hooks(), calls = [], reminderVersions = [], toggled = [], backHandlers = new Set(); let uuid = 0, reminderOpen = () => {}, keyboardVisible = false, keyboardDismisses = 0;
  const sync = () => {};
  const conversations = [null, "finance", "health"].map((agent_id) => ({ id: `${agent_id ?? "main"}-history`, title: `${agent_id ?? "main"} history`, agent_id, model_id: null, reasoning_effort: null, project_id: null, updated_at: "2028-06-02T10:00:00Z" }));
  const preferences = { pins: [{ kind: "project", id: "legacy-project", title: "旧项目" }, { kind: "conversation", id: "finance-history", title: "财务历史" }], visited: [{ kind: "project", id: "legacy-project", title: "旧项目" }], opened: { "project:legacy-project": "2028-06-02T11:00:00Z" } };
  const welcome = { value: { text: "hello", kind: "task", models: { chat: chosenModelId, task: null }, efforts: { chat: null, task: null }, searchId: null }, ready: true, error: "", consumeText: async () => {}, retry() {}, setText(next) { welcome.value.text = typeof next === "function" ? next(welcome.value.text) : next; }, setKind() {}, setSearch() {}, setModel() {}, setEffort() {} };
  const native = { ...Object.fromEntries(["ActivityIndicator", "Image", "KeyboardAvoidingView", "Modal", "Pressable", "Text", "View"].map((name) => [name, name])), StyleSheet: { create: (value) => value }, Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, BackHandler: { addEventListener: (_event, callback) => { backHandlers.add(callback); return { remove: () => backHandlers.delete(callback) }; } }, Keyboard: { isVisible: () => keyboardVisible, dismiss() { keyboardVisible = false; keyboardDismisses++; }, addListener: () => ({ remove() {} }) } };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime, react: lifecycle.react, "react-native": native,
    "react-native-safe-area-context": { SafeAreaProvider: "SafeAreaProvider", SafeAreaView: "SafeAreaView" }, "expo-status-bar": { StatusBar: "StatusBar" }, "expo-crypto": { randomUUID: () => `message-${++uuid}` }, "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./theme": theme, "./providerEditing": { availablePreference }, "./ui": { useUi: () => ({ s: {}, colors: theme.lightColors }), humanError: (error) => error.message, ...Object.fromEntries(["BackLink", "Button", "PageScrollView", "PageHeading", "IconAction"].map((name) => [name, name])) },
    "./ConnectionStatus": { useSyncStatus: () => sync, ConnectionStatusProvider: "ConnectionStatusProvider", ServiceStatusNotice: "ServiceStatusNotice" },
    "./useHomePreferences": { useHomePreferences: () => ({ preferences, ready: true, opened() {}, toggle: (target) => toggled.push(target), retry() {} }) }, "./useWelcomeDraft": { useWelcomeDraft: () => welcome }, "./homeEntries": { targetKey },
    "./useHealthReminders": { useHealthReminders(_connection, revision, onOpen) { reminderVersions.push(revision); reminderOpen = onOpen; } }, "./storage": { draftKey: () => "draft", saveDraft: async () => {}, clearDraft: async () => {} },
    "./api": { ...api, request: async (_connection, path, options) => {
      calls.push({ path, ...options });
      if (path === "/status") { if (failStatus) throw new Error("status unavailable"); return { runtime: "dsh", ...serviceStatus }; }
      if (path === "/assistant") return { name: "知行" };
      if (path === "/models") { if (failModels) throw new Error("models unavailable"); return modelPage; }
      if (path === "/agents") return { items: ["finance", "health"].map((id) => ({ id, name: id === "finance" ? "财务助手" : "健康助手", model_id: null })) };
      if (path === "/conversations" && options?.method === "POST") {
        const created = { ...options.body, id: `${options.body.agent_id ?? "main"}-created`, model_id: null, reasoning_effort: null };
        conversations.push(created); return created;
      }
      if (path.startsWith("/conversations/") && !path.includes("?") && !path.endsWith("/messages")) return conversations.find((item) => path === `/conversations/${item.id}`) ?? { id: "loaded", agent_id: null };
      if (path.endsWith("/messages")) return {};
      if (path.startsWith("/conversations")) return { items: conversations, next_cursor: null, previous_cursor: null };
      return { items: [], next_cursor: null, previous_cursor: null };
    } },
  };
  for (const name of ["ThemeProvider", "AppearanceControl", "AgentChatHeader", "ConversationMenu", "Notice", "ChatPanel", "BottomSheet", "DshChatPanel", "AiHome", "AiDrawer", "FinanceDashboard", "HealthPage", "LifeSummary", "LifePanel", "ConstructionPage", "ResourcesPanel", "ModelsPanel", "ProvidersPanel", "ResourcePreview", "OverviewPanels", "SettingsPanel", "SettingsHome", "PasswordVaultPanel", "ChatSettingsPanel", "SearchPicker", "AgentsPanel", "DeviceCapabilitiesPanel"]) dependencies[`./${name}`] = Object.fromEntries([name, "NoticeProvider", "HomePanel", "ConstructionPage", "ConnectionSettingsPanel", "PersonaSettingsPanel", "DshHostSettings"].map((key) => [key, key]));
  dependencies["./chatPreferences"] = { ChatPreferencesProvider: "ChatPreferencesProvider" };
  dependencies["./useDshSettings"] = { useDshSettings: () => ({ snapshot: null, refresh() {}, select() {} }) };
  dependencies["./ThemeProvider"].useThemedStyles = (factory) => factory(theme.lightColors);
  dependencies["./TodayHomePanel"] = { TodayHomePanel: "HomePanel" };
  dependencies["./useTodayDeviceContext"] = { useTodayDeviceContext() { return {}; } };
  const exported = load("AssistantApp.tsx", dependencies, "\nexport { ConnectedSession, DisconnectedShell, BottomTabs };\n");
  const props = { connection: { url: "https://example.test", token: "test" }, onConnect() {}, onDisconnect() {}, connectionError: "" };
  const render = () => walk(lifecycle.render(() => (connected ? exported.ConnectedSession : exported.DisconnectedShell)(props)));
  return { render, calls, preferences, welcome, reminderVersions, toggled, notification() { reminderOpen(); }, keyboard(visible) { keyboardVisible = visible; }, get keyboardDismisses() { return keyboardDismisses; }, tabsVisible() { return render().some((item) => item.type === exported.BottomTabs); }, back() { return [...backHandlers].at(-1)?.(); }, renderTabs() { const node = render().find((item) => item.type === exported.BottomTabs); assert.ok(node, "bottom navigation visible"); return walk(exported.BottomTabs(node.props)); }, unmount: lifecycle.unmount };
}
const find = (app, name) => app.render().find((node) => node.type === name);

test("DSH uses the existing shell with its own renderer and host settings", async () => {
  const app = appHarness({ serviceStatus: { runtime: "dsh", model_ready: true, worker_online: true } });
  app.render(); await settle();
  find(app, "HomePanel").props.onOpenConversation("main-history"); await settle();
  assert.ok(find(app, "DshChatPanel")); assert.equal(app.render().some(n => n.type === "ChatPanel"), false);
  assert.ok(find(app, "AgentChatHeader"));
  find(app, "AiDrawer").props.onExit();
  app.renderTabs().find(node => node.props.accessibilityLabel === "设置").props.onPress();
  find(app, "SettingsHome").props.onOpen("host");
  assert.ok(find(app, "DshHostSettings")); assert.equal(find(app, "ProvidersPanel"), undefined);
  app.unmount();
});

test("native conversations keep their renderer when the status request fails", async () => {
  const app = appHarness({ failStatus: true });
  app.render(); await settle();
  find(app, "HomePanel").props.onOpenConversation("main-history"); await settle();
  assert.ok(find(app, "DshChatPanel"));
  assert.equal(app.render().some(n => n.type === "ChatPanel"), false);
  app.unmount();
});

test("welcome permission is applied when creating the conversation, before the first message", async () => {
  const app = appHarness({ modelPage: { items: [{ id: 'model', name: 'DeepSeek', ready: true, reasoning_levels: [] }], roles: { chat: 'model' } },
    serviceStatus: { model_ready: true, worker_online: true, permissions: { current: 'workspace-write', options: ['read-only', 'workspace-write', 'danger-full-access'] } } });
  app.render(); await settle();
  app.renderTabs().find(node => node.props.accessibilityLabel === '知行').props.onPress();
  app.welcome.value.permission = 'read-only';
  const home = find(app, 'AiHome');
  assert.equal(home.props.permissions.current, 'read-only');
  assert.equal(find(app, 'AgentChatHeader').props.modelName, 'DeepSeek');
  home.props.onSend(); await settle();
  const creation = app.calls.findIndex(call => call.path === '/conversations' && call.method === 'POST');
  const message = app.calls.findIndex(call => call.path.endsWith('/messages') && call.method === 'POST');
  assert.equal(app.calls[creation].body.permission, 'read-only');
  assert.ok(message > creation); app.unmount();
});

test("local password vault stays available without a server and owns its private return path", async () => {
  for (const connected of [true, false]) {
    const app = appHarness({ connected }); app.render(); await settle();
    app.renderTabs().find((node) => node.props.accessibilityLabel === "设置").props.onPress();
    find(app, "SettingsHome").props.onOpen("vault");
    const vault = find(app, "PasswordVaultPanel"); assert.ok(vault);
    assert.equal(app.tabsVisible(), false);
    assert.equal(find(app, "BackLink"), undefined, "the panel owns lock-before-exit and keyboard handling");
    assert.equal(app.back(), false, "the parent must leave back handling to the private panel");
    assert.ok(find(app, "PasswordVaultPanel"));
    vault.props.onBack(); assert.ok(find(app, "SettingsHome")); assert.equal(app.tabsVisible(), true);
    assert.equal(app.calls.some((call) => call.method === "POST"), false);
    if (!connected) assert.equal(app.calls.length, 0, "local access must not depend on the service");
    app.unmount();
  }
});

test("settings groups password management in the toolbox", () => {
  const opened = [];
  const { SettingsHome } = load("SettingsHome.tsx", {
    "react/jsx-runtime": jsxRuntime, "./AppearanceControl": { AppearanceControl: "AppearanceControl" },
    "./AppUpdateSettings": { AppUpdateSettings: "AppUpdateSettings" },
    "./ui": Object.fromEntries(["ActionRow", "PageHero", "PageScrollView", "SettingsGroup"].map((name) => [name, name])),
  });
  const nodes = walk(SettingsHome({ onOpen: (destination) => opened.push(destination) }));
  const toolbox = nodes.find((node) => node.type === "SettingsGroup" && node.props.title === "工具箱");
  assert.ok(toolbox);
  const row = walk(toolbox).find((node) => node.type === "ActionRow" && node.props.title === "密码管理");
  row.props.onPress(); assert.deepEqual(opened, ["vault"]);
  assert.deepEqual(nodes.filter((node) => node.type === "SettingsGroup").map((node) => node.props.title), ["通用", "工具箱", "模型与服务", "数据与连接"]);
});

function openLifeService(app, service) {
  find(app, "HomePanel").props.onLife();
  const life = find(app, "LifePanel"); assert.ok(life, "life overview opens first");
  life.props[service === "finance" ? "onFinance" : "onHealth"]();
}

test("chat preferences are available locally and each agent can open them and return to its conversation", async () => {
  const offline = appHarness({ connected: false }); offline.render();
  offline.renderTabs().find((node) => node.props.accessibilityLabel === "设置").props.onPress();
  find(offline, "SettingsHome").props.onOpen("chat");
  assert.ok(find(offline, "ChatSettingsPanel")); assert.equal(offline.tabsVisible(), false);
  assert.equal(offline.back(), true); assert.ok(find(offline, "SettingsHome")); assert.deepEqual(offline.calls, []); offline.unmount();
  for (const agent of ["finance", "health"]) {
    const app = appHarness(); app.render(); await settle(); openLifeService(app, agent);
    find(app, agent === "finance" ? "FinanceDashboard" : "HealthPage").props.onChat(); await settle();
    const id = find(app, "DshChatPanel").props.conversation.id;
    find(app, "DshChatPanel").props.onMessageOptions(); assert.equal(find(app, "DshChatPanel").props.settingsOpen, true);
    find(app, "DshChatPanel").props.onSettingsClose(); assert.equal(find(app, "DshChatPanel").props.conversation.id, id); assert.equal(find(app, "DshChatPanel").props.settingsOpen, false);
    assert.equal(app.calls.some((call) => call.method === "POST"), false); app.unmount();
  }
});

test("life services open their own agent chats and return to the exact service before life", async () => {
  for (const [pageName, agent] of [["FinanceDashboard", "finance"], ["HealthPage", "health"]]) {
    const app = appHarness(); app.render(); await settle(); openLifeService(app, agent);
    const service = find(app, pageName); assert.ok(service); assert.equal(app.tabsVisible(), false);
    service.props.onChat(); await settle();
    const chat = find(app, "DshChatPanel"); assert.equal(chat.props.conversation.agent_id, agent); assert.equal(chat.props.conversation.id, `${agent}-history`);
    assert.equal(app.tabsVisible(), false);
    find(app, "AiDrawer").props.onExit();
    assert.ok(find(app, pageName));
    find(app, pageName).props.onChat(); await settle(); assert.ok(find(app, "DshChatPanel"));
    assert.equal(app.back(), true); assert.ok(find(app, pageName));
    find(app, pageName).props.onBack(); assert.ok(find(app, "LifePanel")); assert.equal(app.tabsVisible(), true);
    assert.equal(app.calls.some((call) => call.method === "POST"), false, "opening an existing agent does not send a message or create a service record");
    assert.equal(app.welcome.value.text, "hello");
    app.unmount();
  }
});

test("a service prompt starts the correct child agent and returns to the originating life service", async () => {
  const app = appHarness(); app.render(); await settle(); openLifeService(app, "health");
  find(app, "HealthPage").props.onChat("请按当前饮食约定推荐下一餐"); await settle();
  const create = app.calls.find((call) => call.path === "/conversations" && call.method === "POST");
  assert.equal(create.body.agent_id, "health"); assert.equal(create.body.project_id, null);
  const message = app.calls.find((call) => call.path === "/conversations/health-created/messages");
  assert.equal(message.body.kind, "chat"); assert.equal(message.body.content, "请按当前饮食约定推荐下一餐");
  assert.equal(find(app, "DshChatPanel").props.conversation.agent_id, "health");
  app.back(); assert.ok(find(app, "HealthPage")); app.back(); assert.ok(find(app, "LifePanel")); app.unmount();
});

test("bottom navigation restores life and uses the former work destination for construction", async () => {
  const app = appHarness(); app.render(); await settle();
  const tabs = app.renderTabs().filter((node) => node.props?.accessibilityRole === "tab" || node.props?.accessibilityRole === "button");
  assert.deepEqual(tabs.map((node) => node.props.accessibilityLabel), ["首页", "生活", "知行", "施工中", "设置"]);
  tabs.find((node) => node.props.accessibilityLabel === "生活").props.onPress(); assert.ok(find(app, "LifePanel"));
  app.renderTabs().find((node) => node.props.accessibilityLabel === "施工中").props.onPress(); assert.ok(find(app, "ConstructionPage"));
  assert.equal(find(app, "HealthPage"), undefined); assert.equal(find(app, "FinanceDashboard"), undefined);
  assert.equal(app.back(), true); assert.ok(find(app, "HomePanel"));
  find(app, "HomePanel").props.onWork(); assert.ok(find(app, "ConstructionPage"));
  app.unmount();
});

test("Android back dismisses the keyboard before leaving a life service, then returns through life and home", async () => {
  const app = appHarness(); app.render(); await settle(); openLifeService(app, "finance");
  app.keyboard(true); assert.equal(app.back(), true); assert.equal(app.keyboardDismisses, 1); assert.ok(find(app, "FinanceDashboard"));
  assert.equal(app.back(), true); assert.ok(find(app, "LifePanel"));
  assert.equal(app.back(), true); assert.ok(find(app, "HomePanel")); assert.equal(app.back(), false);
  app.unmount();
});

test("notification clicks open health inside life and retain the life return path", async () => {
  const app = appHarness(); app.render(); await settle(); find(app, "HomePanel").props.onWork();
  app.notification(); assert.ok(find(app, "HealthPage")); assert.equal(app.tabsVisible(), false);
  find(app, "HealthPage").props.onChat(); await settle(); assert.ok(find(app, "DshChatPanel")); app.back(); assert.ok(find(app, "HealthPage"));
  app.back(); assert.ok(find(app, "LifePanel")); app.unmount();
});

test("life topic prompts append to the welcome draft without creating or sending a conversation", async () => {
  const app = appHarness(); app.render(); await settle(); find(app, "HomePanel").props.onLife();
  find(app, "LifePanel").props.onChat("帮我规划这次出行：");
  const ai = find(app, "AiHome"); assert.ok(ai); assert.match(ai.props.draft, /hello/); assert.match(ai.props.draft, /帮我规划这次出行：/);
  assert.equal(app.calls.filter((call) => call.method === "POST").length, 0);
  app.back(); assert.ok(find(app, "LifePanel")); app.unmount();
});

test("disconnected navigation exposes life services and construction before connection", () => {
  const app = appHarness({ connected: false }); app.render();
  const labels = () => app.renderTabs().filter((node) => node.props?.accessibilityRole === "tab" || node.props?.accessibilityRole === "button");
  assert.deepEqual(labels().map((node) => node.props.accessibilityLabel), ["首页", "生活", "知行", "施工中", "设置"]);
  find(app, "HomePanel").props.onWork(); assert.ok(find(app, "ConstructionPage"));
  labels().find((node) => node.props.accessibilityLabel === "生活").props.onPress(); assert.ok(find(app, "LifePanel"));
  for (const action of ["onFinance", "onHealth"]) {
    find(app, "LifePanel").props[action](); assert.equal(app.tabsVisible(), false);
    const connect = app.render().find((node) => node.type === "Button"); assert.ok(connect, "service offers a connection action");
    assert.equal(app.back(), true); assert.ok(find(app, "LifePanel"));
  }
  find(app, "LifePanel").props.onFinance();
  app.render().find((node) => node.type === "Button").props.onPress(); assert.ok(find(app, "ConnectionSettingsPanel"));
  app.keyboard(true); app.back(); assert.equal(app.keyboardDismisses, 1); assert.ok(find(app, "ConnectionSettingsPanel"));
  app.back(); assert.ok(find(app, "SettingsHome")); app.unmount();
});

test("legacy project pins and visits do not produce an unopenable home entry", async () => {
  const app = appHarness(); app.render(); await settle(); const home = find(app, "HomePanel").props;
  assert.equal(home.preferences.pins.some((item) => item.kind === "project"), false);
  const entries = homeEntries(home.conversations, home.projects ?? [], home.resources ?? [], home.preferences);
  assert.equal(entries.recent.some((item) => item.kind === "project"), false);
  assert.equal(entries.pins.some((item) => item.kind === "conversation"), true);
  assert.equal(app.preferences.pins.some((item) => item.kind === "project"), true, "legacy saved data is retained");
  app.unmount();
});

test("today home appends its prepared prompt to the existing main draft without creating or sending", async () => {
  const app = appHarness(); app.render(); await settle();
  const home = find(app, "HomePanel").props;
  assert.equal(home.promptReady, true);
  home.onPrompt("今天的手机信息与想法");
  assert.ok(find(app, "AiHome"));
  assert.equal(app.welcome.value.text, "hello\n\n今天的手机信息与想法");
  assert.equal(app.calls.some((call) => call.method === "POST"), false);
  app.back(); app.welcome.ready = false;
  const locked = find(app, "HomePanel").props;
  assert.equal(locked.promptReady, false);
  locked.onPrompt("不能覆盖未读取草稿");
  assert.ok(find(app, "HomePanel"));
  assert.equal(app.welcome.value.text, "hello\n\n今天的手机信息与想法");
  app.unmount();
});

test("home service cards retain the life return path when reusing the same finance chat", async () => {
  const app = appHarness(); app.render(); await settle();
  find(app, "HomePanel").props.onOpenConversation("finance-history"); await settle(); assert.ok(find(app, "DshChatPanel"));
  app.back(); find(app, "HomePanel").props.onFinance();
  const finance = find(app, "FinanceDashboard"); assert.ok(finance); assert.equal(app.tabsVisible(), false);
  finance.props.onChat(); await settle(); assert.equal(find(app, "DshChatPanel").props.conversation.id, "finance-history");
  app.back(); assert.ok(find(app, "FinanceDashboard"));
  find(app, "FinanceDashboard").props.onBack(); assert.ok(find(app, "LifePanel"));
  app.back(); find(app, "HomePanel").props.onHealth();
  assert.ok(find(app, "HealthPage")); app.back(); assert.ok(find(app, "LifePanel"));
  app.back(); find(app, "HomePanel").props.onOpenConversation("finance-history"); await settle(); assert.ok(find(app, "DshChatPanel"));
  app.back(); assert.ok(find(app, "HomePanel"), "a previous life visit cannot become the recent conversation's return destination");
  assert.equal(app.calls.some((call) => call.method === "POST"), false);
  app.unmount();
});

test("home finance card offers connection settings before a service connection exists", () => {
  const app = appHarness({ connected: false }); app.render();
  find(app, "HomePanel").props.onFinance();
  app.render().find((node) => node.type === "Button").props.onPress();
  assert.ok(find(app, "ConnectionSettingsPanel")); assert.equal(find(app, "FinanceDashboard"), undefined);
  assert.equal(app.calls.length, 0); app.unmount();
});

test("welcome always starts chat even when a previous installation saved task mode", async () => {
  const app = appHarness(); app.render(); await settle(); app.renderTabs().find((node) => node.props.accessibilityLabel === "知行").props.onPress();
  assert.equal(find(app, "AiHome").props.kind, "chat"); find(app, "AiHome").props.onSend(); await settle();
  const sent = app.calls.find((call) => call.path.endsWith("/messages")); assert.equal(sent.body.kind, "chat"); app.unmount();
});

test("welcome, main and child conversations share one header with the correct identity and actions", async () => {
  const app = appHarness(); app.render(); await settle();
  app.renderTabs().find((node) => node.props.accessibilityLabel === "知行").props.onPress();
  const header = () => {
    const headers = app.render().filter((node) => node.type === "AgentChatHeader");
    assert.equal(headers.length, 1); return headers[0].props;
  };
  assert.equal(header().title, "知行"); assert.equal(header().subtitle, "随时聊聊，把事情做成");
  assert.equal(typeof header().status, "string"); assert.equal(header().onPin, undefined);
  header().onMenu(); assert.equal(find(app, "AiDrawer").props.visible, true);
  find(app, "AiDrawer").props.onClose(); assert.equal(find(app, "AiDrawer").props.visible, false);
  find(app, "AiDrawer").props.onExit(); assert.ok(find(app, "HomePanel"));
  for (const [agent, title] of [[null, "知行"], ["finance", "财务助手"], ["health", "健康助手"]]) {
    const id = `${agent ?? "main"}-history`;
    find(app, "HomePanel").props.onOpenConversation(id); await settle();
    assert.equal(find(app, "DshChatPanel").props.conversation.id, id);
    assert.equal(header().title, title); assert.equal(header().subtitle, `${agent ?? "main"} history`);
    assert.equal(header().status, undefined, "a conversation must not inherit the welcome readiness badge");
    header().onOptions(); assert.equal(find(app, "ConversationMenu").props.title, `${agent ?? "main"} history`);
    find(app, "ConversationMenu").props.onClose();
    header().onMenu(); assert.equal(find(app, "AiDrawer").props.visible, true);
    find(app, "AiDrawer").props.onClose(); find(app, "AiDrawer").props.onExit(); assert.ok(find(app, "HomePanel"));
  }
  assert.equal(app.calls.some((call) => call.method === "POST"), false);
  app.unmount();
});

test("a child header creates one empty conversation for the current agent and retains the service return path", async () => {
  for (const [agent, pageName] of [["finance", "FinanceDashboard"], ["health", "HealthPage"]]) {
    const app = appHarness(); app.render(); await settle(); openLifeService(app, agent);
    find(app, pageName).props.onChat(); await settle();
    assert.equal(find(app, "DshChatPanel").props.conversation.id, `${agent}-history`);
    const header = find(app, "AgentChatHeader");
    header.props.onNew(); header.props.onNew(); await settle();
    const created = app.calls.filter((call) => call.method === "POST");
    assert.equal(created.length, 1, "repeated taps must not start multiple conversations or send a message");
    assert.equal(created[0].path, "/conversations"); assert.equal(created[0].body.agent_id, agent); assert.equal(created[0].body.project_id, null);
    const chat = find(app, "DshChatPanel"); assert.equal(chat.props.conversation.id, `${agent}-created`); assert.equal(chat.props.conversation.agent_id, agent);
    assert.equal(find(app, "AiHome"), undefined);
    assert.equal(app.welcome.value.text, "hello", "starting a child conversation preserves the main agent draft");
    assert.equal(find(app, "AgentChatHeader").props.status, undefined);
    find(app, "AiDrawer").props.onExit(); assert.ok(find(app, pageName));
    app.back(); assert.ok(find(app, "LifePanel")); app.unmount();
  }
});

test("new from the welcome or a main conversation returns to the preserved main draft without posting", async () => {
  for (const current of ["welcome", "main"]) {
    const app = appHarness(); app.render(); await settle();
    const home = find(app, "HomePanel");
    if (current === "welcome") app.renderTabs().find((node) => node.props.accessibilityLabel === "知行").props.onPress();
    else { home.props.onOpenConversation("main-history"); await settle(); assert.ok(find(app, "DshChatPanel")); }
    find(app, "AgentChatHeader").props.onNew(); await settle();
    assert.equal(find(app, "AiHome").props.draft, "hello"); assert.equal(app.render().some(n => n.type === "ChatPanel"), false);
    assert.equal(find(app, "AgentChatHeader").props.onPin, undefined);
    assert.equal(app.calls.some((call) => call.method === "POST"), false);
    find(app, "AiDrawer").props.onExit(); assert.ok(find(app, "HomePanel")); app.unmount();
  }
});

test("the shared header keeps the topic prominent, with assistant and model underneath", () => {
  for (const colors of [theme.lightColors, theme.darkColors]) {
    const actions = [];
    const { AgentChatHeader } = load("AgentChatHeader.tsx", {
      "react/jsx-runtime": jsxRuntime,
      "react-native": { View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: value => value, hairlineWidth: 1 } },
      "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
      "./ThemeProvider": { useThemedStyles: factory => factory(colors) }, "./theme": theme,
      "./ui": { useUi: () => ({ colors }) },
    });
    const props = { title: "知行", subtitle: "研究插件并整理接入方案", modelName: "DeepSeek-V4.1-Flash", onMenu() {}, onNew() {}, onClose() {}, onOptions: () => actions.push("options") };
    const nodes = walk(AgentChatHeader(props));
    assert.equal(nodes.find(n => n.props?.accessibilityRole === 'header').props.children, props.subtitle);
    assert.ok(nodes.some(n => n.type === 'Text' && n.props.children === '知行：DeepSeek-V4.1-Flash'));
    assert.ok(nodes.some(n => n.props?.accessibilityLabel?.includes('当前模型DeepSeek-V4.1-Flash，知行')));
    nodes.find(n => n.props?.accessibilityLabel === '对话菜单').props.onPress();
    assert.deepEqual(actions, ['options']);
    assert.equal(nodes.some(n => n.type === 'Modal' || n.type === 'BottomSheet'), false);
  }
});

 test("the conversation box routes search and share to the current chat and removes only an acknowledged deletion", async () => {
  const app = appHarness(); app.render(); await settle();
  find(app, "HomePanel").props.onOpenConversation("main-history"); await settle();
  const open = () => { find(app, "AgentChatHeader").props.onOptions(); return find(app, "ConversationMenu").props; };
  let menu = open(); assert.equal(menu.title, 'main history'); assert.equal(menu.existing, true);
  menu.onSearch(); assert.equal(find(app, 'DshChatPanel').props.menuAction.type, 'search');
  menu.onShare(); assert.equal(find(app, 'DshChatPanel').props.menuAction.type, 'share');
  const deleted = menu.onDelete(); assert.ok(find(app, 'DshChatPanel')); await deleted; await settle();
  assert.ok(find(app, 'AiHome')); assert.equal(find(app, 'AiDrawer').props.conversations.some(chat => chat.id === 'main-history'), false);
  assert.ok(app.calls.some(call => call.method === 'DELETE' && call.path === '/conversations/main-history'));
  app.unmount();
});

test("every welcome suggestion keeps chat mode and the composer exposes no task switch", () => {
  const lifecycle = hooks(), kinds = [], prompts = [];
  const native = { ...Object.fromEntries(["View", "Text", "TextInput", "Pressable", "ScrollView", "ActivityIndicator"].map((name) => [name, name])), StyleSheet: { create: (value) => value } };
  const dependencies = { "react/jsx-runtime": jsxRuntime, react: lifecycle.react, "react-native": native, "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" }, "./theme": theme, "./ui": { useUi: () => ({ s: {}, colors: theme.lightColors }), ActionLink: "ActionLink" }, "./ThemeProvider": { useThemedStyles: (factory) => factory(theme.lightColors) }, "./api": {}, "./ConversationComposer": { ConversationComposer: "ConversationComposer" }, "./ReasoningPicker": { ReasoningPicker: "ReasoningPicker" }, "./PermissionPicker": { PermissionPicker: "PermissionPicker" }, "./ModelPicker": { ModelPicker: "ModelPicker" }, "./SearchPicker": { SearchPicker: "SearchPicker" } };
  const { AiHome } = load("AiHome.tsx", dependencies);
  const props = { name: "知行", draft: "", kind: "chat", busy: false, connection: {}, catalog: null, modelId: null, effort: null, onDraft: (text) => prompts.push(text), onKind: (kind) => kinds.push(kind), onSend() {}, onFiles() {}, onModelId() {}, onEffort() {}, onSearchProviderId() {} };
  const nodes = walk(lifecycle.render(() => AiHome(props)));
  nodes.filter((node) => node.type === "Pressable" && node.props.accessibilityRole === "button").forEach((node) => node.props.onPress());
  assert.equal(kinds.length, 4); assert.ok(kinds.every((kind) => kind === "chat")); assert.equal(prompts.length, 4);
  const composerLife = hooks();
  const { ConversationComposer } = load("ConversationComposer.tsx", { ...dependencies, react: composerLife.react, "./ThemeProvider": { useTheme: () => ({ colors: theme.lightColors }), useThemedStyles: (factory) => factory(theme.lightColors) }, "./api": { request: async () => ({ items: [] }) }, "./BrandIcon": { BrandIcon: "BrandIcon" }, "./reasoning": { thinkingLabel: () => "默认" } });
  const composer = nodes.find((node) => node.type === "ConversationComposer");
  const controls = walk(composerLife.render(() => ConversationComposer(composer.props))).filter((node) => node.type === "Pressable");
  assert.equal(controls.some((node) => /任务|切换模式/.test(node.props.accessibilityLabel)), false);
});

test("native chat changes refresh the finance and health surfaces and local reminders", async () => {
  const app = appHarness(); app.render(); await settle(); openLifeService(app, "health");
  assert.equal(find(app, "HealthPage").props.refreshKey, 0);
  find(app, "HealthPage").props.onChat(); await settle();
  find(app, "DshChatPanel").props.onRefresh(); app.render();
  assert.equal(app.reminderVersions.at(-1), 1);
  app.back(); assert.equal(find(app, "HealthPage").props.refreshKey, 1);
  app.unmount();
});


test("welcome readiness follows the service, selected model, and latest sync instead of a fixed badge", async () => {
  const modelPage = { items: [{ id: "ready-model", name: "Actual model", ready: true, reasoning_levels: [] }], roles: { chat: "ready-model" } };
  for (const [options, expected] of [
    [{ modelPage }, "待命中"],
    [{ modelPage, serviceStatus: { model_ready: true, worker_online: false } }, "服务离线"],
    [{ modelPage, serviceStatus: { model_ready: false, worker_online: true } }, "未就绪"],
    [{ modelPage: { ...modelPage, items: [{ ...modelPage.items[0], ready: false }] } }, "未就绪"],
    [{ modelPage, failStatus: true }, "重新连接"],
    [{ modelPage, failModels: true }, "重新连接"],
    [{ modelPage, chosenModelId: "ready-model", serviceStatus: { model_ready: false, worker_online: true } }, "待命中"],
  ]) {
    const app = appHarness(options);
    app.render(); app.renderTabs().find((node) => node.props.accessibilityLabel === "知行").props.onPress();
    assert.equal(find(app, "AgentChatHeader").props.status, "连接中");
    await settle();
    assert.equal(find(app, "AgentChatHeader").props.status, expected);
    app.unmount();
  }
});
