import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { prepareSchedule } from "../src/api.ts";
import * as form from "../src/scheduleForm.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const conversation = (id) => ({ id, title: `对话 ${id}`, updated_at: "2098-01-01T00:00:00Z", project_id: null, agent_id: null, model_id: null, reasoning_effort: null, blocked: false });
const savedDraft = (extra = {}) => ({ prompt: "整理资料", time: "2099-02-03 09:30", interval: "", pending: null, ...extra });
function nodesOf(element) {
  const nodes = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    nodes.push(node);
    walk(node.props?.children);
    walk(node.props?.action);
  }
  walk(element);
  return nodes;
}
function load(name, dependencies) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return exports;
}
function screen({ saved = savedDraft(), schedules = [], failures = 0 } = {}) {
  const state = [];
  let cursor = 0;
  let mounted = false;
  let storage = saved;
  let confirmation;
  let ids = 0;
  let failCount = failures;
  const calls = [], notices = [], opened = [], changes = [], calendar = [];
  const props = {
    connection: { url: "https://example.com", token: "test" }, schedules,
    conversation: conversation("a"), conversations: [conversation("a"), conversation("b")],
    conversationName: (id) => `对话 ${id}`, onRefresh() {}, onChanged: (item) => changes.push(item),
    hasMore: false, loadMore() {}, hasMoreConversations: true, onLoadMoreConversations() {},
    onOpenConversation: (id) => opened.push(id),
  };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) { const slot = cursor++; if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial; return [state[slot], (next) => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }]; },
      useRef(initial) { const slot = cursor++; if (!(slot in state)) state[slot] = { current: initial }; return state[slot]; },
      useEffect(effect) { if (!mounted) { mounted = true; effect(); } },
    },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", Platform: { OS: "android" }, StyleSheet: { create: (styles) => styles }, Alert: { alert: (_a, _b, options) => { confirmation = options[1].onPress; } } },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "expo-crypto": { randomUUID: () => `request-${++ids}` },
    "./api": { prepareSchedule, request: async (_connection, path, options) => { calls.push({ path, options }); if (failCount-- > 0) throw new Error("请求超时"); return { ...options.body, enabled: true, last_run_id: null }; } },
    "./storage": { readPlanDraft: async () => storage, savePlanDraft: async (_url, value) => { storage = value; }, clearPlanDraft: async (_url, id, empty) => { if (storage.pending?.id === id) storage = empty; } },
    "./deviceCapabilities": { openSystemCalendar: async (event) => { calendar.push(event); return "已返回知行，请在日历中确认是否保存。"; } },
    "./deviceCapabilityLogic": { scheduleCalendarEvent: (schedule) => ({ title: schedule.prompt, startDate: schedule.next_run_at }) },
    "./Notice": { useNotice: () => ({ show: (notice) => notices.push(notice) }) },
    "./SchedulePickers": { ScheduleConversationPicker: "ScheduleConversationPicker", ScheduleDatePicker: "ScheduleDatePicker" },
    "./scheduleForm": form,
    "./theme": { space: { sm: 8 } },
    "./ui": { useUi: () => ({ s: {}, colors: {} }), ActionLink: "ActionLink", Button: "Button", Empty: "Empty", Field: "Field", IconAction: "IconAction", PageHeading: "PageHeading", PageScrollView: "PageScrollView", StatusPill: "StatusPill", humanError: (error) => error.message, timeLabel: (value) => value },
  };
  const module = load("SchedulesPanel.tsx", dependencies);
  function render() { cursor = 0; return nodesOf(module.SchedulesPanel(props)); }
  render();
  return { render, props, calls, notices, opened, changes, calendar, stored: () => storage, confirm: () => confirmation() };
}
const find = (page, type, match = () => true) => page.render().find((node) => node.type === type && match(node.props));
const press = (page, label) => find(page, "Pressable", (p) => p.accessibilityLabel === label).props.onPress();
const submit = (page) => find(page, "Button").props.onPress();

test("schedule creation selects its result conversation in place and preserves interval semantics", async () => {
  const page = screen(); await settle();
  press(page, "选择结果对话");
  const chooser = find(page, "ScheduleConversationPicker");
  assert.equal(chooser.props.hasMore, true);
  chooser.props.onSelect("b");
  press(page, "重复每天");
  assert.equal(page.stored().conversation_id, "b");
  submit(page); await settle();
  const payload = page.calls[0].options.body;
  assert.equal(payload.conversation_id, "b");
  assert.equal(payload.interval_seconds, 86400);
  assert.equal(payload.next_run_at, new Date(2099, 1, 3, 9, 30).toISOString());
  assert.equal(page.changes.length, 1);
  assert.equal(page.stored().pending, null);
  assert.match(page.notices[0].message, /对话 b/);
  page.notices[0].action.onPress();
  assert.deepEqual(page.opened, ["b"]);
});

test("schedule form passes conversation paging status into its open picker", async () => {
  const page = screen(); await settle();
  press(page, "选择结果对话");
  page.props.conversationLoading = true;
  page.props.conversationError = "稍后再试";
  const chooser = find(page, "ScheduleConversationPicker");
  assert.equal(chooser.props.visible, true);
  assert.equal(chooser.props.loading, true);
  assert.equal(chooser.props.error, "稍后再试");
});

test("failed creation locks every editable field and retries the exact durable payload", async () => {
  const page = screen({ failures: 1 }); await settle();
  submit(page); await settle();
  const original = page.calls[0].options.body;
  page.props.conversation = conversation("different");
  assert.ok(page.render().filter((node) => node.type === "Field").every((node) => node.props.editable === false));
  assert.equal(find(page, "Pressable", (p) => p.accessibilityLabel === "选择结果对话").props.disabled, true);
  // Even a stale callback cannot change a request that has already been persisted.
  find(page, "Field", (p) => p.label === "到时要做什么").props.onChangeText("changed");
  submit(page); await settle();
  assert.deepEqual(page.calls[1].options.body, original);
  assert.equal(page.calls[1].options.body.id, "request-1");
  assert.equal(page.calls[1].options.body.conversation_id, "a");
});

test("reopened pending schedules keep original expired time and destination without generating another ID", async () => {
  const payload = { id: "persisted", conversation_id: "b", prompt: "原计划", next_run_at: "2000-01-01T01:00:00Z", interval_seconds: 600 };
  const page = screen({ saved: savedDraft({ pending: payload, conversation_id: "a", prompt: "stale" }) }); await settle();
  assert.equal(find(page, "Field", (p) => p.label === "到时要做什么").props.value, "原计划");
  submit(page); await settle();
  assert.deepEqual(page.calls[0].options.body, payload);
});

test("rapid submission sends once and custom blank intervals remain editable instead of becoming one-off", async () => {
  const page = screen(); await settle();
  press(page, "重复自定");
  find(page, "Field", (p) => p.label === "间隔分钟").props.onChangeText("");
  assert.ok(find(page, "Field", (p) => p.label === "间隔分钟"));
  assert.equal(page.stored().repeat_mode, "custom");
  const restored = screen({ saved: page.stored() }); await settle();
  assert.ok(find(restored, "Field", (p) => p.label === "间隔分钟"));
  submit(page); await settle();
  assert.equal(page.calls.length, 0);
  assert.ok(page.render().some((node) => node.props?.accessibilityRole === "alert"));
  find(page, "Field", (p) => p.label === "间隔分钟").props.onChangeText("30");
  const send = find(page, "Button").props.onPress;
  send(); send(); await settle();
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].options.body.interval_seconds, 1800);
});

test("date selection updates only the date and weekly shortcuts remain fixed seven-day intervals", async () => {
  const page = screen(); await settle();
  find(page, "ActionLink", (p) => p.icon === "calendar-outline").props.onPress();
  find(page, "ScheduleDatePicker").props.onSelect("2099-04-12");
  assert.equal(find(page, "Field", (p) => p.label === "时间").props.value, "09:30");
  find(page, "Field", (p) => p.label === "时间").props.onChangeText("16:45");
  press(page, "重复每周");
  submit(page); await settle();
  assert.equal(page.calls[0].options.body.interval_seconds, 604800);
  assert.equal(page.calls[0].options.body.next_run_at, new Date(2099, 3, 12, 16, 45).toISOString());
});

test("triggered one-off plans differ from paused plans and open results without exposing run IDs", async () => {
  const base = { id: "plan", prompt: "整理", conversation_id: "b", next_run_at: "2099-02-03T01:30:00Z", enabled: false, last_run_id: "secret-run-id", interval_seconds: null };
  const page = screen({ saved: null, schedules: [base] }); await settle();
  assert.equal(find(page, "StatusPill").props.children, "一次已触发");
  assert.ok(!find(page, "ActionLink", (p) => p.children === "启用"));
  assert.ok(!JSON.stringify(page.render()).includes("secret-run-id"));
  find(page, "ActionLink", (p) => p.children === "查看结果").props.onPress();
  assert.deepEqual(page.opened, ["b"]);
  find(page, "ActionLink", (p) => p.children === "将本次时间带入日历").props.onPress(); await settle();
  assert.equal(page.calendar[0].startDate, base.next_run_at);
  assert.match(page.notices[0].message, /是否保存/);
  const paused = screen({ saved: null, schedules: [{ ...base, interval_seconds: 86400 }] }); await settle();
  assert.equal(find(paused, "StatusPill").props.children, "已暂停");
  assert.ok(find(paused, "ActionLink", (p) => p.children === "启用"));
});

test("calendar helpers preserve local dates across month, leap-year and year boundaries", () => {
  assert.equal(form.dateOffset(1, new Date(2026, 11, 31, 23, 59)), "2027-01-01");
  assert.equal(form.dateOffset(1, new Date(2028, 1, 28)), "2028-02-29");
  const leap = form.scheduleMonthDays(2028, 1).filter(Boolean);
  assert.equal(leap.length, 29);
  assert.equal(leap.at(-1), "2028-02-29");
  assert.equal(form.scheduleMonthDays(2027, 1).filter(Boolean).length, 28);
  assert.equal(form.scheduleDestination(savedDraft({ conversation_id: "b" }), "a"), "b");
  assert.equal(form.scheduleIntervalLabel(86400), "每天 · 每 24 小时");
});

test("time input gives an HH:mm correction without persisting an invalid request", async () => {
  const page = screen(); await settle();
  find(page, "Field", (p) => p.label === "时间").props.onChangeText("25:00");
  submit(page); await settle();
  assert.equal(page.calls.length, 0);
  assert.equal(page.stored().pending, null);
  assert.match(find(page, "Text", (p) => p.accessibilityRole === "alert").props.children, /HH:mm/);
});

function pickerScreen(name, props) {
  const state = [];
  let cursor = 0;
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: { useState(initial) { const slot = cursor++; if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial; return [state[slot], (next) => { state[slot] = next; }]; }, useEffect() {} },
    "react-native": { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View", StyleSheet: { create: (value) => value } },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./BottomSheet": { BottomSheet: "BottomSheet" },
    "./ui": { useUi: () => ({ s: {}, colors: {} }), ActionLink: "ActionLink", Field: "Field", IconAction: "IconAction" },
    "./scheduleForm": form,
    "./theme": { layout: { touchTarget: 44 }, radius: { small: 12 }, space: { md: 16, sm: 8 } },
  };
  const pickers = load("SchedulePickers.tsx", dependencies);
  return { props, render() { cursor = 0; return nodesOf(pickers[name](props)); } };
}

test("date picker navigates leap months", () => {
  const selected = [];
  const page = pickerScreen("ScheduleDatePicker", { visible: true, value: "2096-02-15", onSelect: (value) => selected.push(value), onClose() {} });
  let nodes = page.render();
  assert.equal(nodes.filter((node) => node.type === "Pressable").length, 29);
  nodes.find((node) => node.props?.accessibilityLabel === "选择日期 2096-02-29").props.onPress();
  assert.deepEqual(selected, ["2096-02-29"]);
  nodes.find((node) => node.type === "IconAction" && node.props.label === "下个月").props.onPress();
  nodes = page.render();
  assert.equal(nodes.filter((node) => node.type === "Pressable").length, 31);
  assert.equal(nodes[0].props.visible, true);
});

test("conversation picker retains filtering and allows retry after a visible loading failure", () => {
  let loaded = 0;
  const page = pickerScreen("ScheduleConversationPicker", { visible: true, conversations: [conversation("a"), conversation("b")], selectedId: "a", hasMore: true, onLoadMore: () => { loaded += 1; }, onSelect() {}, onClose() {} });
  find(page, "Field").props.onChangeText("unloaded");
  let nodes = page.render();
  assert.equal(nodes.filter((node) => node.type === "Pressable").length, 0);
  nodes.find((node) => node.type === "ActionLink").props.onPress();
  assert.equal(loaded, 1);

  page.props.loading = true;
  const busyAction = find(page, "ActionLink");
  assert.equal(busyAction.props.disabled, true);
  assert.equal(busyAction.props.children, "正在加载对话…");
  busyAction.props.onPress();
  assert.equal(loaded, 1);

  page.props.loading = false;
  page.props.error = "请求超时，请重试。";
  assert.equal(find(page, "Text", (p) => p.accessibilityRole === "alert").props.children, page.props.error);
  assert.equal(find(page, "Field").props.value, "unloaded");
  const retry = find(page, "ActionLink");
  assert.equal(retry.props.disabled, false);
  assert.equal(retry.props.children, "重试加载对话");
  retry.props.onPress();
  assert.equal(loaded, 2);

  page.props.loading = true;
  assert.equal(find(page, "Text", (p) => p.accessibilityRole === "alert"), undefined);
  page.props.loading = false;
  page.props.error = "";
  page.props.conversations.push(conversation("unloaded"));
  page.props.hasMore = false;
  assert.equal(find(page, "ActionLink"), undefined);
  assert.equal(page.render().filter((node) => node.type === "Pressable").length, 1);
  assert.equal(find(page, "Text", (p) => p.accessibilityRole === "alert"), undefined);
});
