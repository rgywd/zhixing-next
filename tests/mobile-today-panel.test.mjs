import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import * as logic from "../src/todayHomeLogic.ts";
import * as weather from "../src/todayWeather.ts";

const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children), ...walk(node.props?.action)];
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
const action = (page, title) => page.nodes.find((node) => node.type === "CardHeader" && node.props.title === title).props.action;
const textContent = (node) => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(textContent).join("") : textContent(node?.props?.children ?? "");
function panel(overrides = {}, propOverrides = {}) {
  const calls = [], notices = [];
  const linking = { openURL: async (url) => { calls.push(["openURL", url]); } };
  const snapshot = { now: Date.now(), place: null, weather: null, events: [], locationEnabled: false, calendarEnabled: false, preferencesReady: true, locationState: "idle", calendarState: "idle", weatherState: "idle", locationError: "", calendarError: "", weatherError: "", preferenceError: "", ...overrides };
  const device = { snapshot, ...Object.fromEntries(["enableLocation", "refreshLocation", "disableLocation", "enableCalendar", "refreshCalendar", "disableCalendar", "openEvent", "retryPreferences", "cancelLocation", "enableNetworkLocation"].map((name) => [name, async (...args) => { calls.push([name, ...args]); }])) };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime, react: { useState: (initial) => [initial, () => {}] }, "react-native": { Linking: linking, ScrollView: "ScrollView", Text: "Text", View: "View" },
    "./BottomSheet": { BottomSheet: "BottomSheet" }, "./OverviewPanels": { HomePanel: "HomePanel" },
    "./useTodayServices": { useTodayServices: () => ({ finance: { data: null, loading: false, error: "" }, health: { data: null, loading: false, error: "" } }) },
    "./todayHomeLogic": logic, "./todayWeather": weather, "./deviceCapabilities": { openDeviceSettings: async (target) => { calls.push(["settings", target]); } },
    "./ui": { useUi: () => ({ s: {} }), humanError: (error) => error.message, ActionLink: "ActionLink", CardHeader: "CardHeader", IconAction: "IconAction" },
    "./Notice": { useNotice: () => ({ show: (notice) => notices.push(notice) }) },
  };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/TodayHomePanel.tsx", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, Date, Promise, require(name) { assert.ok(name in dependencies, name); return dependencies[name]; } });
  const props = { connection: { url: "https://example.test", token: "not-real" }, device, conversations: [], onChat() {}, onOpenConversation() {}, onLife() {}, onWork() {}, promptReady: true, onPrompt: (text) => calls.push(["prompt", text]), ...propOverrides };
  const nodes = walk(exports.TodayHomePanel(props));
  return { calls, notices, device, linking, nodes, home: nodes.find((node) => node.type === "HomePanel") };
}

test("explicit retry after permission denial requests authorization again instead of a silent refresh", async () => {
  for (const state of ["denied", "blocked"]) {
    const page = panel({ locationEnabled: true, calendarEnabled: true, locationState: state, calendarState: state });
    assert.equal(action(page, "位置与天气").props.label, "重新允许位置与天气");
    assert.equal(action(page, "手机日历").props.label, "重新允许读取日程");
    assert.deepEqual(page.calls, []);
    action(page, "位置与天气").props.onPress();
    action(page, "手机日历").props.onPress();
    await settle();
    assert.deepEqual(page.calls.map(([name]) => name), ["enableLocation", "enableCalendar"]);
  }
});

test("already authorized controls refresh without prompting and unread preferences lock enable actions", async () => {
  const page = panel({ locationEnabled: true, calendarEnabled: true, locationState: "ready", calendarState: "ready" });
  assert.equal(action(page, "位置与天气").props.label, "刷新位置与天气");
  assert.equal(action(page, "手机日历").props.label, "刷新今日日程");
  action(page, "位置与天气").props.onPress();
  action(page, "手机日历").props.onPress();
  await settle();
  assert.deepEqual(page.calls.map(([name]) => name), ["refreshLocation", "refreshCalendar"]);
  const unread = panel({ preferencesReady: false });
  assert.ok(action(unread, "位置与天气").props.disabled);
  assert.ok(action(unread, "手机日历").props.disabled);
  assert.deepEqual(unread.calls, []);
});

test("compact header icons keep first-use consent explicit and omit removed management actions", async () => {
  const page = panel();
  for (const title of ["位置与天气", "手机日历"]) {
    assert.equal(action(page, title).type, "IconAction");
    assert.equal(action(page, title).props.icon, "refresh-outline");
    assert.equal(action(page, title).props.disabled, false);
  }
  assert.equal(action(page, "位置与天气").props.label, "启用位置与天气");
  assert.equal(action(page, "手机日历").props.label, "读取今日日程");
  assert.deepEqual(page.calls, []);
  action(page, "位置与天气").props.onPress();
  action(page, "手机日历").props.onPress();
  await settle();
  assert.deepEqual(page.calls.map(([name]) => name), ["enableLocation", "enableCalendar"]);

  for (const state of [{}, { locationEnabled: true, calendarEnabled: true }, { locationState: "loading", weatherState: "loading" }]) {
    const current = panel(state);
    assert.equal(current.nodes.filter((node) => node.type === "IconAction").length, 2);
    const text = current.nodes.filter((node) => node.type === "Text" || node.type === "ActionLink").map((node) => node.props.children).flat().join("");
    assert.doesNotMatch(text, /断开手机日历|停止位置天气|取消更新|增强网络辅助定位|天气数据来源|关闭以上开关/);
    assert.equal(current.nodes.filter((node) => node.type === "Button").length, 0);
  }
});

test("loading is visible and disables only the active domain refresh", () => {
  const location = panel({ locationEnabled: true, locationState: "ready", weatherState: "loading" });
  assert.equal(action(location, "位置与天气").props.disabled, true);
  assert.equal(action(location, "位置与天气").props.label, "位置与天气正在更新");
  assert.equal(action(location, "手机日历").props.disabled, false);
  assert.equal(location.nodes.find((node) => node.type === "CardHeader" && node.props.title === "位置与天气").props.description, "正在更新位置与天气");
  const calendar = panel({ calendarEnabled: true, calendarState: "loading" });
  assert.equal(action(calendar, "手机日历").props.disabled, true);
  assert.equal(action(calendar, "手机日历").props.label, "正在读取今日日程");
  assert.equal(action(calendar, "位置与天气").props.disabled, false);
});

test("permission and location-service recovery remain available and failures surface", async () => {
  for (const [locationError, target] of [["定位权限已关闭", "app"], ["请打开定位服务", "location"]]) {
    const page = panel({ locationEnabled: true, locationState: "blocked", locationError, calendarEnabled: true, calendarState: "blocked", calendarError: "日历权限已关闭" });
    const alerts = page.nodes.filter((node) => node.props?.accessibilityRole === "alert").map((node) => node.props.children);
    assert.ok(alerts.includes(locationError));
    assert.ok(alerts.includes("日历权限已关闭"));
    page.nodes.find((node) => node.type === "ActionLink" && node.props.children === "打开定位设置").props.onPress();
    page.nodes.find((node) => node.type === "ActionLink" && node.props.children === "打开日历权限设置").props.onPress();
    await settle();
    assert.deepEqual(page.calls, [["settings", target], ["settings", undefined]]);
  }
  const retry = panel({ locationEnabled: true, locationState: "error", locationError: "定位暂不可用" });
  retry.device.refreshLocation = async () => { throw new Error("暂时无法刷新"); };
  action(retry, "位置与天气").props.onPress();
  await settle();
  assert.equal(retry.notices.at(-1).message, "暂时无法刷新");
});

test("preference recovery and minimal weather privacy remain available without auto actions", async () => {
  const page = panel({ preferencesReady: false, preferenceError: "设置暂时无法读取" });
  assert.ok(page.nodes.some((node) => node.props?.accessibilityRole === "alert" && node.props.children === "设置暂时无法读取"));
  page.nodes.find((node) => node.type === "ActionLink" && node.props.children === "重新读取设置").props.onPress();
  await settle();
  assert.deepEqual(page.calls, [["retryPreferences"]]);
  const text = page.nodes.filter((node) => node.type === "Text").map(textContent).join("");
  assert.match(text, /发送聊天后分享给知行/);
  assert.match(text, /Open-Meteo.*约 1 公里/);
});

test("weather attribution stays inside the existing privacy text and handles link failure", async () => {
  const page = panel();
  const link = page.nodes.find((node) => node.props?.accessibilityRole === "link");
  assert.equal(link.type, "Text");
  assert.equal(link.props.children, "Open-Meteo");
  assert.equal(link.props.accessibilityLabel, "打开 Open-Meteo");
  assert.ok(page.nodes.some((node) => node.type === "Text" && Array.isArray(node.props.children) && node.props.children.includes(link)));
  link.props.onPress();
  await settle();
  assert.deepEqual(page.calls, [["openURL", weather.TODAY_WEATHER_URL]]);
  page.linking.openURL = async () => { throw new Error("无法打开天气网站"); };
  link.props.onPress();
  await settle();
  assert.equal(page.notices.at(-1).message, "无法打开天气网站");
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
