import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { ApiError } from "../src/api.ts";
import * as theme from "../src/theme.ts";

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
function hooks() {
  const values = []; let cursor = 0; let effects = [];
  const changed = (a, b) => !a || a.length !== b.length || b.some((value, i) => value !== a[i]);
  return { react: {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === "function" ? initial() : initial; return [values[i], (next) => { values[i] = typeof next === "function" ? next(values[i]) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; },
    useEffect(effect, deps) { const i = cursor++; if (changed(values[i]?.deps, deps)) { values[i]?.cleanup?.(); values[i] = { deps }; effects.push(() => { values[i].cleanup = effect(); }); } },
    useCallback(fn, deps) { const i = cursor++; if (changed(values[i]?.deps, deps)) values[i] = { deps, fn }; return values[i].fn; },
  }, render(fn) { cursor = 0; effects = []; const result = fn(); effects.forEach((effect) => effect()); return result; },
  unmount() { values.forEach((value) => value?.cleanup?.()); } };
}
function load(name, dependencies) {
  const exports = {};
  const extension = ["FinanceDashboard", "HealthPage"].includes(name) ? "tsx" : "ts";
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${name}.${extension}`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, Date, Intl, Number, Error, encodeURIComponent, Promise, console,
    require(key) { assert.ok(key in dependencies, `mock ${key}`); return dependencies[key]; },
  });
  return exports;
}
let uuid = 0;
function setup(mutate = async () => ({})) {
  const storage = new Map(); let lifecycle = hooks();
  const forms = load("serviceForms", {
    react: Object.fromEntries(["useState", "useRef", "useEffect", "useCallback"].map((name) => [name, (...args) => lifecycle.react[name](...args)])),
    "@react-native-async-storage/async-storage": { __esModule: true, default: { getItem: async (key) => { if (storage.failRead) throw new Error("storage unreadable"); return storage.get(key) ?? null; }, setItem: async (key, value) => { storage.set(key, value); } } },
    "expo-crypto": { randomUUID: () => `request-${++uuid}` }, "./api": { ApiError }, "./serviceApi": { mutateService: mutate },
  });
  return { forms, storage, render: (fn) => lifecycle.render(fn), remount() { lifecycle.unmount(); lifecycle = hooks(); } };
}
const connection = { url: "https://service.test", token: "test" };
const ui = { useUi: () => ({ s: {}, colors: theme.darkColors }), ...Object.fromEntries(["ActionLink", "BackLink", "Button", "CardHeader", "Empty", "Field", "PageHeading", "PageHero", "PageScrollView", "StatusPill", "SwitchRow"].map((key) => [key, key])) };
const primitives = { useServiceStyles: () => ({}), ...Object.fromEntries(["ServiceToolbar", "ServiceHeading", "ServiceCard", "ServiceSectionHeader", "ServiceMetric", "ServiceChatRow", "ServiceEmpty"].map((key) => [key, key])) };
const design = { "./ServicePrimitives": primitives, "./ThemeProvider": { useThemedStyles: (factory) => factory(theme.darkColors) }, "./theme": theme, "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" } };
function pages(forms) {
  const dependencies = {
    ...design, "react/jsx-runtime": jsxRuntime, react: {}, "react-native": { StyleSheet: { create: (value) => value } }, "./api": {}, "./Notice": {}, "./serviceApi": {}, "./serviceForms": forms, "./ui": ui,
    "./deviceCapabilities": { allowNotifications: async () => {} }, "./healthNotifications": { pauseHealthNotificationsForToday: async () => {} },
  };
  return { ...load("FinanceDashboard", dependencies), ...load("HealthPage", dependencies) };
}
const draft = (kind, fields, context = {}) => ({ kind, fields, context, id: "stable-request", pending: null });

test("service date parsing preserves local calendar days and rejects normalization and ambiguous money", () => {
  const { forms } = setup();
  assert.equal(forms.validDate("2028-02-29"), true);
  assert.equal(forms.validDate("2027-02-29"), false);
  assert.throws(() => forms.localTimestamp("2027-02-29", "12:00"), /日期/);
  assert.throws(() => forms.localTimestamp("2028-02-29", "24:00"), /时间/);
  const stamp = forms.localTimestamp("2028-02-29", "00:15");
  assert.match(stamp, /^2028-02-29T00:15:00[+-]\d{2}:\d{2}$/);
  assert.equal(forms.moneyInput("", "收入", true), null);
  assert.equal(forms.moneyInput("12.30", "金额"), "12.30");
  for (const amount of ["1e3", "-2", "1,200", "12.345", "NaN"]) assert.throws(() => forms.moneyInput(amount, "金额"));
});

test("finance budget saves month scope, optional amounts, and preserves matching commitment identities", () => {
  const { forms } = setup(); const { buildFinanceMutation } = pages(forms);
  const mutation = buildFinanceMutation(draft("budget", { month: "2028-06", income: "", savings: "7000", daily: "2400", recurring: "no", commitments: "租住 | 1700 | 固定\n设备 | 500 | 大件", from: "", through: "" }, { budget: { commitments: [{ key: "rent-key", label: "租住", amount: "1600", kind: "fixed" }] } }));
  assert.equal(mutation.path, "/finance/budget"); assert.equal(mutation.body.recurring, false);
  assert.equal(mutation.body.expected_income, null); assert.equal(mutation.body.commitments[0].key, "rent-key");
  assert.equal(mutation.body.idempotency_key, "stable-request");
  assert.throws(() => buildFinanceMutation(draft("budget", { month: "2028-13" })), /月份/);
});

test("finance correction preserves revision and sends refunds against the original transaction", () => {
  const { forms } = setup(); const { buildFinanceMutation } = pages(forms);
  const fields = { kind: "refund", amount: "12", date: "2028-06-02", bucket: "daily", category: "餐饮", note: "退差价", related: "expense-original", commitment: "" };
  const change = buildFinanceMutation(draft("transaction", fields, { record: { id: "refund-id", revision: 4 } }));
  assert.equal(change.method, "PATCH"); assert.equal(change.body.expected_revision, 4); assert.equal(change.body.related_transaction_id, "expense-original");
  assert.throws(() => buildFinanceMutation(draft("transaction", { ...fields, related: "" })), /原消费/);
});

test("health rules distinguish a single day, ongoing requirements, and proposed rules accepted explicitly", () => {
  const { forms } = setup(); const { buildHealthMutation } = pages(forms);
  const fields = { content: "晚餐先选蔬菜", kind: "guideline", status: "active", scope: "once", from: "2028-06-02", until: "", excluded_terms: "" };
  const once = buildHealthMutation(draft("rule", fields));
  assert.equal(once.body.effective_from, "2028-06-02"); assert.equal(once.body.effective_until, "2028-06-02");
  const accepted = buildHealthMutation(draft("rule", { ...fields, scope: "ongoing" }, { record: { id: "proposed-rule", revision: 3, origin: "assistant_proposal" } }));
  assert.equal(accepted.body.effective_from, null); assert.equal(accepted.body.effective_until, null);
  assert.equal(accepted.body.confirmed, true); assert.equal(accepted.body.origin, "assistant_proposal"); assert.equal(accepted.body.revision, 3);
});

test("health actual meals, recommendation feedback, zero steps, and edits stay separate", () => {
  const { forms } = setup(); const { buildHealthMutation } = pages(forms);
  const meal = buildHealthMutation(draft("meal", { date: "2028-06-02", time: "12:10", meal_type: "lunch", description: "鱼和蔬菜", portion: "半碗饭", status: "recorded", note: "" }, { recommendation_id: "choice-1" }));
  assert.equal(meal.path, "/health/meals"); assert.equal(meal.body.recommendation_id, "choice-1"); assert.match(meal.body.occurred_at, /^2028-06-02/);
  const feedback = buildHealthMutation(draft("feedback", { action: "replaced", note: "今天只有外卖", option_id: "" }, { recommendation: { id: "choice-1" } }));
  assert.equal(feedback.path, "/health/recommendations/choice-1/feedback"); assert.equal(feedback.body.action, "replaced"); assert.equal(feedback.body.description, undefined);
  const steps = buildHealthMutation(draft("steps", { date: "2028-06-02", time: "12:10", value: "0", note: "" }));
  assert.equal(steps.body.value, 0);
  assert.throws(() => buildHealthMutation(draft("weight", { date: "2028-06-02", time: "12:10", value: "0", note: "", unit: "kg" })), /正数/);
});

test("reminder form validates quiet hours and keeps the existing tone and slot identities", () => {
  const { forms } = setup(); const { buildHealthMutation } = pages(forms);
  const fields = { enabled: "yes", timezone: "Asia/Shanghai", slots: "12:00 午餐\n20:30 回顾", quiet_start: "22:00", quiet_end: "07:00", max_per_day: "2", paused_dates: "2028-06-03" };
  const mutation = buildHealthMutation(draft("reminders", fields, { reminders: { revision: 2, tone: "简短", slots: [{ id: "lunch-slot", time: "12:00", meal_type: "lunch", kind: "meal" }] } }));
  assert.equal(mutation.body.slots[0].id, "lunch-slot"); assert.equal(mutation.body.tone, "简短"); assert.equal(mutation.body.revision, 2);
  assert.throws(() => buildHealthMutation(draft("reminders", { ...fields, quiet_end: "" }, { reminders: { slots: [] } })), /一起/);
  assert.throws(() => buildHealthMutation(draft("reminders", { ...fields, max_per_day: "13" }, { reminders: { slots: [] } })), /12/);
});

test("an uncertain save is persisted, survives remount, and retries exactly once without accepting new input", async () => {
  const calls = [], saved = []; let first = true; let unlock;
  const pending = new Promise((resolve) => { unlock = resolve; });
  const app = setup(async (_connection, mutation) => { calls.push(mutation); if (first) { first = false; await pending; throw new Error("网络中断"); } return { id: "record" }; });
  const render = () => app.render(() => app.forms.useServiceEditor(connection, "finance", (value) => saved.push(value)));
  render(); await settle();
  render().open("transaction", { amount: "18" });
  const build = (value) => ({ path: "/finance/transactions", method: "POST", body: { idempotency_key: value.id, amount: value.fields.amount } });
  const sending = render().submit(build);
  render().submit(() => assert.fail("double tap"));
  await settle(); assert.equal(calls.length, 1); unlock(); await sending;
  assert.equal(render().locked, true); assert.equal(render().draft.fields.amount, "18");
  render().set("amount", "99"); assert.equal(render().draft.fields.amount, "18");
  app.remount(); render(); await settle();
  assert.equal(render().visible, false); assert.equal(render().draft.fields.amount, "18");
  render().resume(); assert.equal(render().visible, true);
  await render().submit(() => assert.fail("must replay saved payload"));
  assert.equal(calls.length, 2); assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), JSON.parse(JSON.stringify(calls[1])));
  assert.equal(saved.length, 1); assert.equal(render().draft, null);
});

test("validation or permission failure preserves editable input and never posts a mutation", async () => {
  const calls = []; const app = setup(async (_connection, mutation) => { calls.push(mutation); throw new ApiError("金额无效", "invalid", 422); });
  const render = () => app.render(() => app.forms.useServiceEditor(connection, "health", () => assert.fail("not saved")));
  render(); await settle(); render().open("reminders", { enabled: "yes", slots: "12:00 午餐" });
  await render().submit(() => ({ path: "/health/reminders", method: "PUT" }), async () => { throw new Error("请在系统设置打开通知"); });
  assert.equal(calls.length, 0); assert.equal(render().locked, false); assert.match(render().error, /系统设置/);
  await render().submit(() => ({ path: "/health/reminders", method: "PUT" }));
  assert.equal(calls.length, 1); assert.equal(render().locked, false); assert.equal(render().draft.fields.slots, "12:00 午餐");
  render().set("slots", "13:00 午餐"); assert.equal(render().draft.fields.slots, "13:00 午餐");
});

test("untouched new forms do not become recoverable drafts just because their defaults are populated", async () => {
  for (const [kind, fields, context] of [
    ["meal", { date: "2028-06-02", time: "12:10", meal_type: "lunch", status: "recorded", description: "", portion: "", note: "" }, {}],
    ["weight", { date: "2028-06-02", time: "12:10", value: "", unit: "kg", note: "" }, {}],
    ["profile", { height_cm: "181", activity_limitations: "原有限制", food_allergies: "", preferences: "", goals: "" }, { profile: { revision: 3 } }],
  ]) {
    const app = setup(), notices = [], key = `zhixing.service-draft.v1:${encodeURIComponent(connection.url)}:health`;
    const render = () => app.render(() => app.forms.useServiceEditor(connection, "health", () => {}, () => notices.push("recovered")));
    render(); await settle(); render().open(kind, fields, context); render().close(); await settle();
    assert.equal(render().draft, null, kind); assert.equal(render().visible, false); assert.equal(JSON.parse(app.storage.get(key)), null); assert.equal(notices.length, 0);
    app.remount(); render(); await settle(); assert.equal(render().draft, null); assert.equal(notices.length, 0);
  }
});

test("a changed draft prompts once, remains available, and does not interrupt the overview on reentry", async () => {
  const app = setup(), notices = [], key = `zhixing.service-draft.v1:${encodeURIComponent(connection.url)}:health`;
  const render = () => app.render(() => app.forms.useServiceEditor(connection, "health", () => {}, () => notices.push("recovered")));
  render(); await settle(); render().open("meal", { description: "", date: "2028-06-02", time: "12:10" });
  render().set("description", "尚未提交的午餐"); const id = render().draft.id;
  render().close(); await settle(); assert.equal(render().visible, false); assert.equal(notices.length, 1);
  assert.equal(JSON.parse(app.storage.get(key)).fields.description, "尚未提交的午餐");
  render().resume(); assert.equal(render().visible, true); render().close(); await settle(); assert.equal(notices.length, 1);
  app.remount(); render(); await settle(); assert.equal(render().visible, false); assert.equal(render().draft.id, id); assert.equal(notices.length, 1);
  render().open("weight", { value: "" }); assert.equal(render().visible, true); assert.equal(render().draft.kind, "meal", "ordinary entry still resumes the retained draft");
  render().discard(); await settle(); assert.equal(render().draft, null);
  render().open("weight", { value: "" }); render().set("value", "81"); render().close(); await settle(); assert.equal(notices.length, 2, "a new draft can notify again");
});

test("legacy drafts recover once without automatic navigation or field loss", async () => {
  const app = setup(), notices = [], key = `zhixing.service-draft.v1:${encodeURIComponent(connection.url)}:health`;
  app.storage.set(key, JSON.stringify(draft("meal", { description: "旧版本未提交内容" })));
  const render = () => app.render(() => app.forms.useServiceEditor(connection, "health", () => {}, () => notices.push("recovered")));
  render(); await settle(); assert.equal(render().ready, true); assert.equal(render().visible, false); assert.equal(notices.length, 1);
  assert.equal(render().draft.fields.description, "旧版本未提交内容"); render().resume(); render().close(); await settle();
  assert.notEqual(render().draft, null, "legacy drafts without a baseline are retained conservatively");
  app.remount(); render(); await settle(); assert.equal(render().visible, false); assert.equal(notices.length, 1);
  assert.equal(render().draft.fields.description, "旧版本未提交内容");
});

test("valid zero steps, skipped meals and clearing an existing restriction remain recoverable changes", async () => {
  for (const [kind, fields, changes, context] of [
    ["steps", { value: "", date: "2028-06-02" }, { value: "0" }, {}],
    ["meal", { description: "", status: "recorded" }, { status: "skipped" }, {}],
    ["profile", { activity_limitations: "旧限制" }, { activity_limitations: "" }, { profile: { revision: 3 } }],
    ["meal", { description: "建议中的餐食", portion: "" }, { portion: "一碗" }, { recommendation_id: "recommendation-original" }],
  ]) {
    const app = setup(), notices = [];
    const render = () => app.render(() => app.forms.useServiceEditor(connection, "health", () => {}, () => notices.push("recovered")));
    render(); await settle(); render().open(kind, fields, context);
    for (const [field, value] of Object.entries(changes)) render().set(field, value);
    render().close(); await settle(); assert.notEqual(render().draft, null, kind); assert.equal(notices.length, 1);
    app.remount(); render(); await settle();
    for (const [field, value] of Object.entries(changes)) assert.equal(render().draft.fields[field], value);
    if (context.recommendation_id) assert.equal(render().draft.context.recommendation_id, context.recommendation_id);
  }
});

test("an untouched pending request survives closing and reentry even when its fields equal the initial baseline", async () => {
  const calls = [], notices = []; const app = setup(async (_connection, mutation) => { calls.push(mutation); throw new Error("响应丢失"); });
  const render = () => app.render(() => app.forms.useServiceEditor(connection, "finance", () => {}, () => notices.push("recovered")));
  render(); await settle(); render().open("transaction", { amount: "18", date: "2028-06-02" });
  await render().submit((source) => ({ path: "/finance/transactions", method: "POST", body: { idempotency_key: source.id, amount: source.fields.amount } }));
  render().close(); await settle(); const pending = JSON.parse(JSON.stringify(render().draft.pending));
  assert.equal(render().locked, true); assert.equal(notices.length, 1);
  app.remount(); render(); await settle(); assert.equal(render().visible, false); assert.equal(render().locked, true); assert.equal(notices.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(render().draft.pending)), pending);
  await render().submit(() => assert.fail("pending payload must not be rebuilt")); assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), pending);
});

test("cached service data remains visible when a fresh connection fails", async () => {
  const app = setup(); let fail = false;
  const read = async () => { if (fail) throw new Error("离线"); return { month: "2028-06", total: "32" }; };
  const render = () => app.render(() => app.forms.useServiceSnapshot(connection, "finance:2028-06", read));
  render(); await settle(); assert.equal(render().data.total, "32");
  fail = true; await render().reload(); assert.equal(render().data.total, "32"); assert.match(render().error, /离线/);
  app.remount(); render(); await settle(); assert.equal(render().data.total, "32"); assert.match(render().error, /离线/);
});

function walk(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(walk);
  return [node, ...walk(node.props?.children)];
}
function screen(name, data, editing = null, { visible = Boolean(editing), ready = true, serviceEditor } = {}) {
  const opened = [], saved = [], backs = [], notices = [], recovery = [];
  const editor = serviceEditor ?? { draft: editing, visible, busy: false, ready, locked: false, error: "", storageError: "", open: (...args) => opened.push(args), close: () => backs.push(true), resume() { editor.visible = true; }, discard() {}, set() {}, submit: (...args) => saved.push(args) };
  const lifecycle = hooks(); const actual = setup().forms;
  const component = load(name, {
    ...design, "react/jsx-runtime": jsxRuntime, react: lifecycle.react,
    "react-native": { StyleSheet: { create: (value) => value }, View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", BackHandler: { addEventListener: (_event, callback) => { backs.push(callback); return { remove() {} }; } } },
    "./api": {}, "./Notice": { useNotice: () => ({ show: (notice) => notices.push(notice), dismiss() {} }) }, "./serviceApi": { readFinanceDashboard() {}, readHealthSummary() {} },
    "./serviceForms": { ...actual, useServiceEditor: (_connection, _service, _saved, onRecovery) => { recovery.push(onRecovery); return editor; }, useServiceSnapshot: () => ({ data, loading: false, error: "", reload() {} }) }, "./ui": ui,
    "./deviceCapabilities": { allowNotifications: async () => {} }, "./healthNotifications": { pauseHealthNotificationsForToday: async () => {} },
  })[name];
  const chats = [];
  const render = () => walk(lifecycle.render(() => component({ connection, onChat: (prompt) => chats.push(prompt) })));
  const nodes = render();
  return { nodes, render, opened, saved, backs, chats, editor, notices, recovery };
}
function healthData(recommendations = []) {
  return { date: "2028-06-02", profile: { revision: 0, height_cm: null, activity_limitations: [], food_allergies: [], food_exclusions: [], preferences: [], goals: [] }, rules: [], all_rules: [], meals: [], weights: [], steps: [], recommendations, reminders: { revision: 0, enabled: false, slots: [], timezone: "Asia/Shanghai", max_per_day: 3, paused_dates: [], quiet_start: null, quiet_end: null }, review: { weight_trend: { count: 0, latest_kg: null, change_kg: null }, recent_choices: [] } };
}
function financeData(items = []) {
  return { summary: { month: "2028-06", budget: { month: "2028-06", recurring: false, revision: 0, expected_income: null, savings_target: null, daily_budget: null, commitments: [] }, totals: { income: "0.00", expense: "0.00", net: "0.00", daily: "0.00", fixed: "0.00", one_time: "0.00", refund: "0.00", transfer: "0.00" }, reservations: { fixed: "0.00", one_time: "0.00", total: "0.00" }, remaining: { daily_budget: null, total_spend_budget: null, savings_target_headroom: null }, projection: { income: null, expense: null, savings: null, assumptions: [] }, daily_average: { amount: null, days: null, from: null, through: null, basis: "unknown" }, coverage: { recorded_days: 0, from: null, through: null, complete: false, gaps: [] } }, records: { total: items.length, items } };
}
test("health empty state starts manual records without personal numeric defaults or a model", () => {
  const page = screen("HealthPage", healthData());
  assert.ok(page.nodes.some((node) => node.type === "PageScrollView" && node.props.tabs));
  assert.ok(page.nodes.some((node) => node.type === "ServiceEmpty" && node.props.title === "还没有这一天的饮食记录"));
  page.nodes.find((node) => node.type === "ActionLink" && node.props.children === "记录饮食").props.onPress();
  assert.equal(page.opened[0][0], "meal"); assert.equal(page.opened[0][1].description, "");
  page.nodes.find((node) => node.type === "ActionLink" && node.props.children === "记录体重").props.onPress();
  assert.equal(page.opened[1][0], "weight"); assert.equal(page.opened[1][1].value, "");
  assert.equal(page.chats.length, 0);
});

test("finance record actions open an unprefilled agent even before the manual draft is ready", () => {
  for (const ready of [false, true]) {
    for (const data of [null, financeData()]) {
      const page = screen("FinanceDashboard", data, null, { ready });
      const primary = page.nodes.find((node) => node.type === "Button" && node.props.children === "记一笔收支");
      assert.ok(primary); assert.equal(Boolean(primary.props.disabled), false); primary.props.onPress();
      const empty = page.nodes.find((node) => node.type === "ServiceEmpty");
      const actions = walk(empty.props.children).filter((node) => node.type === "Button" || node.type === "ActionLink");
      assert.equal(actions.length, 1); assert.equal(actions[0].props.children, "和知行记一笔");
      assert.equal(Boolean(actions[0].props.disabled), false); actions[0].props.onPress();
      assert.deepEqual(page.chats, [undefined, undefined], "recording actions supply neither a prompt nor an automatic message");
      assert.equal(page.nodes.some((node) => node.type === "ServiceChatRow"), false);
      assert.equal(page.nodes.find((node) => node.type === "ActionLink" && node.props.children === "手动补记").props.disabled, !ready);
      page.render(); page.render(); assert.equal(page.opened.length, 0); assert.equal(page.saved.length, 0);
    }
  }
});

test("manual finance entry remains available with blank actual amounts", () => {
  const page = screen("FinanceDashboard", financeData());
  const manual = page.nodes.find((node) => node.type === "ActionLink" && node.props.children === "手动补记");
  assert.equal(manual.props.disabled, false); manual.props.onPress();
  assert.equal(page.opened.length, 1); assert.equal(page.opened[0][0], "transaction");
  assert.equal(page.opened[0][1].kind, "expense"); assert.equal(page.opened[0][1].amount, "");
  assert.equal(page.opened[0][2].record, null); assert.equal(page.saved.length, 0); assert.equal(page.chats.length, 0);
});

test("finance AI entry leaves retained edits untouched and manual entry resumes their exact draft", async () => {
  for (const pending of [null, { method: "POST", path: "/finance/transactions", body: { idempotency_key: "stable-request", amount: "18.00", kind: "expense" } }]) {
    const calls = [], app = setup(async (_connection, mutation) => calls.push(mutation));
    const key = `zhixing.service-draft.v1:${encodeURIComponent(connection.url)}:finance`;
    const retained = { ...draft("transaction", { kind: "expense", amount: "18.00", date: "2028-06-02", bucket: "daily", category: "餐饮", note: "旧版本未提交的晚饭", commitment: "", related: "" }, { record: null, commitments: [] }), pending };
    app.storage.set(key, JSON.stringify(retained));
    const renderEditor = () => app.render(() => app.forms.useServiceEditor(connection, "finance", () => assert.fail("entry must not save")));
    renderEditor(); await settle(); const restored = renderEditor(); assert.equal(restored.visible, false);
    const page = screen("FinanceDashboard", financeData(), null, { serviceEditor: restored });
    page.nodes.find((node) => node.type === "Button" && node.props.children === "记一笔收支").props.onPress();
    assert.deepEqual(page.chats, [undefined]); assert.equal(renderEditor().visible, false);
    assert.deepEqual(JSON.parse(JSON.stringify(renderEditor().draft)), retained);
    page.nodes.find((node) => node.type === "ActionLink" && node.props.children === "手动补记").props.onPress();
    const resumed = renderEditor(); assert.equal(resumed.visible, true); assert.equal(resumed.locked, Boolean(pending));
    assert.deepEqual(JSON.parse(JSON.stringify(resumed.draft)), retained, "manual entry cannot replace an existing edit or uncertain request");
    const form = screen("FinanceDashboard", financeData(), null, { serviceEditor: resumed });
    assert.equal(form.nodes.find((node) => node.type === "Field" && node.props.label === "金额（元）").props.value, "18.00");
    assert.ok(form.nodes.some((node) => node.type === "Button" && node.props.children === (pending ? "重试原请求" : "保存")));
    assert.equal(calls.length, 0);
  }
});

test("service form uses shared fields and Android back returns to the overview while preserving its draft", () => {
  const page = screen("HealthPage", healthData(), draft("meal", { date: "2028-06-02", time: "12:10", meal_type: "lunch", description: "未提交的午饭", portion: "", status: "recorded", note: "" }));
  assert.equal(page.nodes.find((node) => node.type === "Field" && node.props.label === "吃了什么").props.value, "未提交的午饭");
  assert.ok(page.nodes.some((node) => node.type === "PageScrollView" && node.props.tabs));
  const back = page.backs.find((entry) => typeof entry === "function");
  assert.equal(back(), true); assert.equal(page.editor.draft.fields.description, "未提交的午饭");
  assert.ok(page.nodes.some((node) => node.type === "Button" && node.props.children === "保存"));
});

test("health and finance use a temporary recovery action instead of a permanent overview button", () => {
  for (const [name, data] of [["HealthPage", healthData()], ["FinanceDashboard", null]]) {
    const editing = draft(name === "HealthPage" ? "meal" : "transaction", { description: "保留的内容", amount: "18", kind: "expense", date: "2028-06-02", bucket: "daily", category: "", note: "", commitment: "", related: "" }, { record: null, commitments: [] });
    const page = screen(name, data, editing, { visible: false });
    assert.equal(page.nodes.some((node) => node.type === "Button" && node.props.children === "继续尚未完成的编辑"), false);
    assert.equal(typeof page.recovery.at(-1), "function"); page.recovery.at(-1)(page.editor.resume);
    const notice = page.notices.at(-1); assert.equal(notice.duration, 6000); assert.equal(notice.action.label, "继续编辑");
    notice.action.onPress(); assert.equal(page.editor.visible, true); assert.ok(page.render().some((node) => node.type === "Button" && node.props.children === "保存"));
  }
});

test("a recommendation adoption opens feedback instead of silently recording a meal", () => {
  const { forms } = setup(); const today = forms.localDate();
  const recommendation = { id: "suggestion", target_date: today, meal_type: "lunch", status: "current", context: "依据当前规范", latest_feedback: null, options: [{ id: "fish", title: "鱼和蔬菜", description: "家常清蒸", portion: "按平常份量", ingredients: [], substitutions: [], reason: "符合约定", note: "" }] };
  const page = screen("HealthPage", healthData([recommendation]));
  page.nodes.find((node) => node.type === "ActionLink" && node.props.children === "采纳这个").props.onPress();
  assert.equal(page.opened[0][0], "feedback"); assert.equal(page.opened[0][1].action, "accepted"); assert.equal(page.opened[0][1].option_id, "fish");
  const stale = screen("HealthPage", healthData([{ ...recommendation, status: "stale" }]));
  assert.equal(stale.nodes.find((node) => node.type === "ActionLink" && node.props.children === "采纳这个").props.disabled, true);
});

test("a draft read failure cannot overwrite an earlier unsent record and retry restores it", async () => {
  const app = setup(); const key = `zhixing.service-draft.v1:${encodeURIComponent(connection.url)}:health`;
  app.storage.set(key, JSON.stringify(draft("meal", { description: "先前的饮食草稿" })));
  app.storage.failRead = true;
  const render = () => app.render(() => app.forms.useServiceEditor(connection, "health", () => {}));
  render(); await settle(); assert.equal(render().ready, false);
  render().open("weight", { value: "" }); await settle();
  assert.equal(JSON.parse(app.storage.get(key)).kind, "meal");
  app.storage.failRead = false; render().retryRead(); render(); await settle();
  assert.equal(render().ready, true); assert.equal(render().draft.fields.description, "先前的饮食草稿");
});

test("recommendation safety notes and candidates stay visible while reasoning expands on demand and prior choices stay historical", () => {
  const { forms } = setup();
  const context = "这是较长的推荐依据，只有用户主动打开时才展示。";
  const note = "下单前确认过敏原和交叉接触。";
  const recommendation = { id: "history-choice", target_date: forms.localDate(), meal_type: "dinner", status: "stale", context, note, latest_feedback: { action: "accepted", note: "家里方便做" }, options: [{ id: "dish", title: "清蒸鱼配蔬菜", description: "搭配合适份量米饭", portion: "按饥饱感调整", substitutions: [], note: "", reason: "" }] };
  const page = screen("HealthPage", healthData([recommendation]));
  const textNode = (nodes, text) => nodes.findIndex((node) => node.type === "Text" && node.props.children === text);
  assert.ok(textNode(page.nodes, note) >= 0);
  assert.ok(textNode(page.nodes, note) < textNode(page.nodes, "清蒸鱼配蔬菜"));
  assert.equal(textNode(page.nodes, context), -1);
  assert.ok(page.nodes.some((node) => node.type === "StatusPill" && node.props.children === "历史选择 · 已采纳"));
  assert.equal(page.nodes.some((node) => node.type === "ActionLink" && node.props.children === "更新建议"), false);
  page.nodes.find((node) => node.type === "ActionLink" && node.props.children === "查看建议依据").props.onPress();
  const expanded = page.render(); assert.ok(textNode(expanded, context) >= 0);
  expanded.find((node) => node.type === "ActionLink" && node.props.children === "收起建议依据").props.onPress();
  assert.equal(textNode(page.render(), context), -1);
});


test("editing another budget field preserves quarterly coverage and income schedule", () => {
  const { forms } = setup(); const { buildFinanceMutation } = pages(forms);
  const commitment = { key: "rent-cycle", label: "租住", amount: "4800.00", kind: "fixed", every_months: 3, anchor_month: "2028-03", due_day: 8, monthly_cost: "1600.00", paid_through: "2028-05" };
  const income_schedule = { rule: "last_business_day", calendar_basis: "weekdays_only" };
  const previous = { revision: 3, source_month: "2028-03", commitments: [commitment], income_schedule };
  const fields = { month: "2028-06", income: "15000", savings: "7000", daily: "", recurring: "yes", commitments: "租住 | 4800 | 固定", from: "", through: "" };
  const unchanged = buildFinanceMutation(draft("budget", fields, { budget: previous }));
  assert.equal(unchanged.body.commitments[0].every_months, 3);
  assert.equal(unchanged.body.commitments[0].paid_through, "2028-05");
  assert.equal(unchanged.body.commitments[0].monthly_cost, "1600.00");
  assert.deepEqual(unchanged.body.income_schedule, income_schedule);
  const changed = buildFinanceMutation(draft("budget", { ...fields, commitments: "租住 | 5100 | 固定" }, { budget: previous }));
  assert.equal(changed.body.commitments[0].every_months, 3);
  assert.equal(changed.body.commitments[0].monthly_cost, undefined);
});

test("unrelated correction preserves uncertain transaction range and payment coverage", () => {
  const { forms } = setup(); const { buildFinanceMutation } = pages(forms);
  const record = { id: "uncertain", revision: 2, occurred_on: "2028-06-30", date_precision: "range", date_start: "2028-03-01", date_end: "2028-06-30", coverage_start: "2028-06", coverage_end: "2028-08" };
  const fields = { kind: "expense", amount: "4800", date: record.occurred_on, bucket: "fixed", category: "租住", note: "已付", commitment: "rent-cycle", related: "" };
  const change = buildFinanceMutation(draft("transaction", fields, { record }));
  assert.equal(change.body.date_precision, "range");
  assert.equal(change.body.date_start, "2028-03-01");
  assert.equal(change.body.coverage_end, "2028-08");
});
