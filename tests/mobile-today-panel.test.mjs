import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import * as logic from "../src/todayHomeLogic.ts";
import * as weather from "../src/todayWeather.ts";

const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
function panel(overrides = {}, propOverrides = {}) {
  const calls = [], notices = [];
  const snapshot = { now: Date.now(), place: null, weather: null, events: [], locationEnabled: false, calendarEnabled: false, preferencesReady: true, locationState: "idle", calendarState: "idle", weatherState: "idle", locationError: "", calendarError: "", weatherError: "", preferenceError: "", ...overrides };
  const device = { snapshot, ...Object.fromEntries(["enableLocation", "refreshLocation", "disableLocation", "enableCalendar", "refreshCalendar", "disableCalendar", "openEvent", "retryPreferences", "cancelLocation", "enableNetworkLocation"].map((name) => [name, async (...args) => { calls.push([name, ...args]); }])) };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime, react: { useState: (initial) => [initial, () => {}] }, "react-native": { Linking: { openURL: async () => {} }, ScrollView: "ScrollView", Text: "Text", View: "View" },
    "./BottomSheet": { BottomSheet: "BottomSheet" }, "./OverviewPanels": { HomePanel: "HomePanel" },
    "./useTodayServices": { useTodayServices: () => ({ finance: { data: null, loading: false, error: "" }, health: { data: null, loading: false, error: "" } }) },
    "./todayHomeLogic": logic, "./todayWeather": weather, "./deviceCapabilities": { openDeviceSettings: async () => {} },
    "./ui": { useUi: () => ({ s: {} }), humanError: (error) => error.message, ActionLink: "ActionLink", Button: "Button", CardHeader: "CardHeader" },
    "./Notice": { useNotice: () => ({ show: (notice) => notices.push(notice) }) },
  };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/TodayHomePanel.tsx", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, Date, Promise, require(name) { assert.ok(name in dependencies, name); return dependencies[name]; } });
  const props = { connection: { url: "https://example.test", token: "not-real" }, device, conversations: [], onChat() {}, onOpenConversation() {}, onLife() {}, onWork() {}, promptReady: true, onPrompt: (text) => calls.push(["prompt", text]), ...propOverrides };
  const nodes = walk(exports.TodayHomePanel(props));
  return { calls, notices, device, nodes, home: nodes.find((node) => node.type === "HomePanel") };
}

test("explicit retry after permission denial requests authorization again instead of a silent refresh", async () => {
  for (const state of ["denied", "blocked"]) {
    const page = panel({ locationEnabled: true, calendarEnabled: true, locationState: state, calendarState: state });
    const buttons = page.nodes.filter((node) => node.type === "Button");
    buttons.find((node) => node.props.children === "重新允许位置与天气").props.onPress();
    buttons.find((node) => node.props.children === "重新允许读取日程").props.onPress();
    await settle();
    assert.deepEqual(page.calls.map(([name]) => name), ["enableLocation", "enableCalendar"]);
  }
});

test("already authorized controls refresh without prompting and unread preferences lock enable actions", async () => {
  const page = panel({ locationEnabled: true, calendarEnabled: true, locationState: "ready", calendarState: "ready" });
  page.nodes.find((node) => node.type === "Button" && node.props.children === "刷新位置与天气").props.onPress();
  page.nodes.find((node) => node.type === "Button" && node.props.children === "刷新今日日程").props.onPress();
  await settle();
  assert.deepEqual(page.calls.map(([name]) => name), ["refreshLocation", "refreshCalendar"]);
  assert.ok(panel({ preferencesReady: false }).nodes.filter((node) => node.type === "Button").every((node) => node.props.disabled));
});

test("home forwards device context only to a prepared editable draft and honors its readiness lock", () => {
  const page = panel(); page.home.props.onTodayPrompt("先帮我想一想");
  assert.equal(page.calls.length, 1); assert.equal(page.calls[0][0], "prompt");
  assert.match(page.calls[0][1], /^先帮我想一想/); assert.match(page.calls[0][1], /手机读取的今日信息/);
  const locked = panel({}, { promptReady: false }); locked.home.props.onTodayPrompt("不能覆盖");
  assert.deepEqual(locked.calls, []);
});

test("system calendar open errors surface through the shared notice", async () => {
  const now = Date.now(), event = { id: "fixture", title: "临时测试", startDate: new Date(now + 600000).toISOString(), endDate: new Date(now + 1200000).toISOString(), allDay: false, location: "" };
  const page = panel({ now, calendarEnabled: true, calendarState: "ready", events: [event] });
  page.device.openEvent = async () => { throw new Error("无法打开系统日历"); };
  page.home.props.onTodayCalendar(); await settle();
  assert.equal(page.notices.at(-1).message, "无法打开系统日历");
});
