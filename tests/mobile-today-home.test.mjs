import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import * as theme from "../src/theme.ts";
import * as homeEntries from "../src/homeEntries.ts";

const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
function runtime() {
  const slots = []; let cursor = 0;
  return { react: { useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; } }, render(fn) { cursor = 0; return walk(fn()); } };
}
function load(filename, dependencies) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${filename}.tsx`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, Date, Intl, Number, Map, require(key) { assert.ok(key in dependencies, `Unexpected dependency: ${key}`); return dependencies[key]; } });
  return exports;
}
function dependencies(lifecycle) {
  return { "react/jsx-runtime": jsxRuntime, react: lifecycle.react, "react-native": { ...Object.fromEntries(["Pressable", "Text", "TextInput", "View", "ScrollView"].map((key) => [key, key])), StyleSheet: { hairlineWidth: 0.5, create: (value) => value } }, "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" }, "./theme": theme, "./ThemeProvider": { useThemedStyles: (factory) => factory(theme.darkColors) }, "./AppearanceControl": { AppearanceControl: "AppearanceControl" }, "./ui": { useUi: () => ({ s: {}, colors: theme.darkColors }), ...Object.fromEntries(["ActionLink", "ActionRow", "CardHeader", "IconAction", "Field", "PageHero", "PageScrollView"].map((key) => [key, key])), timeLabel: (value) => value }, "./BottomSheet": { BottomSheet: "BottomSheet" }, "./homeEntries": homeEntries, "./TodayHomeView": { TodayHomeView: "TodayHomeView" } };
}
function fixture() {
  const finance = { value: "¥2,318.50", badge: "还有余量", tone: "gold", detail: "按当前预算安排", footerLabel: "已用 25%", footerValue: "本月额度", progress: 0.25 };
  return { dateLabel: "1月2日 周四", clockLabel: "14:20", locationLabel: "当前位置尚未连接", weatherLabel: "天气读取失败", weatherIcon: "cloudy-outline", contextBusy: false, contextHint: "可重新连接位置天气。", statusLabel: "服务暂不可用", statusTone: "neutral", briefing: "先从已知安排开始，给下一件事留出时间。", calendar: { month: "1月", day: "2", title: "日历未授权", description: "可按需连接系统日历。", badge: "权限待开启", hasEvent: false }, finance, health: { value: "已记录 1 餐", badge: "仅代表已记内容", tone: "neutral", detail: "没有记录的餐次仍未知", footerLabel: "当日步数", footerValue: "未记录", progress: null } };
}
function todayHarness(overrides = {}) {
  const lifecycle = runtime(), calls = []; const loaded = load("TodayHomeView", dependencies(lifecycle));
  const props = { today: fixture(), promptReady: true, manageReady: true, ...Object.fromEntries(["Settings", "Calendar", "Prompt", "Finance", "Health", "Manage"].map((key) => [`on${key}`, (...args) => calls.push([key, ...args])])), ...overrides };
  return { ...loaded, calls, props, render: () => lifecycle.render(() => loaded.TodayHomeView(props)) };
}
const text = (nodes) => nodes.filter((node) => node.type === "Text").map((node) => [node.props.children].flat(Infinity).filter((value) => typeof value === "string" || typeof value === "number").join("")).join(" ");

test("the unconnected Today view derives the date and keeps services, location, weather, and calendar unknown", () => {
  const app = todayHarness(); const empty = app.emptyTodayView(new Date(2031, 0, 2, 14, 20));
  assert.equal(empty.calendar.month, "1月"); assert.equal(empty.calendar.day, "2"); assert.match(empty.dateLabel, /1月2日/);
  assert.equal(empty.finance.progress, null); assert.equal(empty.health.progress, null);
  const nodes = todayHarness({ today: undefined }).render(); const allText = text(nodes);
  assert.match(allText, /位置未连接/); assert.match(allText, /天气未连接/); assert.match(allText, /还未连接日历/);
  assert.equal(nodes.some((node) => node.props.accessibilityRole === "progressbar"), false);
  assert.ok(!/21°C|杭州|达标|80%|8k|会议/.test(allText));
});

test("Today renders actual service values and a known finance progress without health adherence inference", () => {
  const app = todayHarness(); const nodes = app.render(); const allText = text(nodes);
  assert.match(allText, /¥2,318\.50/); assert.match(allText, /已记录 1 餐/); assert.match(allText, /服务暂不可用/);
  assert.match(allText, /天气读取失败/); assert.match(allText, /日历未授权/);
  const bars = nodes.filter((node) => node.props.accessibilityRole === "progressbar");
  assert.equal(bars.length, 1); assert.equal(bars[0].props.accessibilityValue.now, 25);
  assert.equal(nodes.filter((node) => node.type === "AppearanceControl").length, 1);
});

test("Today prompts forward typed text once and never overwrite an Agent draft or auto-send", () => {
  const app = todayHarness();
  app.render().find((node) => node.type === "TextInput").props.onChangeText("  先处理账单，再准备午餐  ");
  app.render().find((node) => node.props.accessibilityLabel === "开始梳理今日安排").props.onPress();
  assert.deepEqual(app.calls, [["Prompt", "先处理账单，再准备午餐"]]);
  assert.equal(app.render().find((node) => node.type === "TextInput").props.value, "");
  app.render().find((node) => node.props.accessibilityLabel === "开始梳理今日安排").props.onPress();
  assert.match(app.calls[1][1], /1月2日 周四 14:20/); assert.match(app.calls[1][1], /没有已确认/);
  assert.equal(app.calls.length, 2);
});

test("draft readiness locks the Today input and start action", () => {
  const locked = todayHarness({ promptReady: false }); const nodes = locked.render();
  assert.equal(nodes.find((node) => node.type === "TextInput").props.editable, false);
  const action = nodes.find((node) => node.props.accessibilityLabel === "开始梳理今日安排");
  assert.equal(action.props.disabled, true); action.props.onPress();
  assert.deepEqual(locked.calls, []);
});

test("Today context, calendar, service modules, and management keep distinct callbacks", () => {
  const app = todayHarness(); const nodes = app.render();
  for (const label of ["今日位置、天气与日历设置", "连接或查看系统日历", "打开财务", "打开健康", "整理常用"]) nodes.find((node) => node.props.accessibilityLabel === label).props.onPress();
  assert.deepEqual(app.calls.map(([kind]) => kind), ["Settings", "Calendar", "Finance", "Health", "Manage"]);
});

test("Home keeps pin management, existing targets, recent resource callbacks, and an actual visible count", () => {
  const lifecycle = runtime(), calls = []; const { HomePanel } = load("OverviewPanels", dependencies(lifecycle));
  const props = { conversations: [{ id: "conversation", title: "已有对话", updated_at: "2031-01-02T12:00:00Z" }], resources: [{ id: "resource", name: "已有资料", created_at: "2031-01-02T13:00:00Z" }], preferences: { pins: [{ kind: "conversation", id: "conversation", title: "已有对话" }], visited: [], opened: {} }, preferencesReady: true, onLife() {}, onWork() {}, onOpenConversation: (id) => calls.push(["conversation", id]), onOpenResource: (id) => calls.push(["resource", id]), onResources: () => calls.push(["resources"]), onTogglePin: (item) => calls.push(["toggle", item.id]) };
  const render = () => lifecycle.render(() => HomePanel(props)); let nodes = render();
  assert.match(text(nodes), /2 条记录/);
  nodes.find((node) => node.type === "ActionRow" && node.props.title === "已有对话").props.onPress();
  nodes.find((node) => node.type === "ActionRow" && node.props.title === "已有资料").props.onPress();
  nodes.find((node) => node.type === "ActionLink" && node.props.children === "资源库").props.onPress();
  nodes.find((node) => node.type === "TodayHomeView").props.onManage(); nodes = render();
  assert.equal(nodes.find((node) => node.type === "BottomSheet").props.visible, true);
  nodes.find((node) => node.type === "IconAction" && node.props.label === "取消固定：已有对话").props.onPress();
  assert.deepEqual(calls, [["conversation", "conversation"], ["resource", "resource"], ["resources"], ["toggle", "conversation"]]);
});

test("long module values and calendar content remain available for narrow-screen wrapping", () => {
  const today = fixture(); today.finance.value = "¥123,456,789.00"; today.calendar.title = "较长但真实的日程标题应该完整换行展示";
  const nodes = todayHarness({ today }).render();
  for (const value of [today.finance.value, today.calendar.title]) { const label = nodes.find((node) => node.type === "Text" && node.props.children === value); assert.ok(label); assert.equal(label.props.numberOfLines, undefined); }
  const module = nodes.find((node) => node.props.accessibilityLabel === "打开财务"); const style = module.props.style({ pressed: false })[0];
  assert.equal(style.minWidth, 0); assert.equal(style.flexGrow, 1); assert.match(style.width, /%$/);
});
