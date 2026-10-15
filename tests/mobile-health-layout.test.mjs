import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const localTime = (date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const names = ["ServiceToolbar", "ServiceHeading", "ServiceCard", "ServiceSectionHeader", "ServiceMetric", "ServiceChatRow", "ServiceEmpty"];
function harness({ data = null, loading = false } = {}) {
  const slots = [], calls = [], exports = {}; let cursor = 0;
  const uiNames = ["ActionLink", "BackLink", "Button", "Field", "PageHeading", "PageScrollView", "StatusPill", "SwitchRow"];
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: { useCallback: (fn) => fn, useEffect: () => {}, useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; } },
    "react-native": Object.fromEntries(["ActivityIndicator", "Pressable", "Text", "View"].map((key) => [key, key])),
    "./healthNotifications": { pauseHealthNotificationsForToday: async () => {} },
    "./deviceCapabilities": { allowNotifications: async () => {} },
    "./Notice": { useNotice: () => ({ show() {} }) },
    "./serviceApi": { readHealthSummary: async () => data },
    "./serviceForms": { localDate, localTime, mealLabels: { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", snack: "加餐", other: "其他" }, useServiceSnapshot: () => ({ data, loading, error: "", reload() {} }), useServiceEditor: () => ({ visible: false, draft: null, ready: true, open: (...args) => calls.push(["editor", ...args]) }) },
    "./ui": { useUi: () => ({ s: {} }), ...Object.fromEntries(uiNames.map((key) => [key, key])) },
    "./ServicePrimitives": { useServiceStyles: () => ({}), ...Object.fromEntries(names.map((key) => [key, key])) },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/HealthPage.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, Date, Intl, encodeURIComponent, require(key) { assert.ok(key in dependencies, `Unexpected dependency: ${key}`); return dependencies[key]; } });
  return { calls, render() { cursor = 0; return walk(exports.HealthPage({ connection: { url: "https://test.invalid", token: "test" }, onBack: () => calls.push(["back"]), onChat: (prompt) => calls.push(["chat", prompt]) })); } };
}
function summary() {
  return { date: localDate(), profile: { activity_limitations: [], food_allergies: [] }, rules: [], all_rules: [], meals: [], weights: [], steps: [], recommendations: [], reminders: { enabled: false, slots: [], max_per_day: 3 }, review: { weight_trend: { count: 0, latest_kg: null, change_kg: null }, recent_choices: [] } };
}

test("health loading uses unknown metrics and never renders a false empty ledger", () => {
  const page = harness({ loading: true }).render();
  const metrics = page.filter((node) => node.type === "ServiceMetric");
  assert.equal(metrics.length, 4);
  assert.ok(metrics.every((node) => node.props.value === "读取中"));
  assert.equal(page.some((node) => node.type === "ServiceEmpty"), false);
  assert.equal(page.some((node) => node.type === "Text" && node.props.children === "0 餐"), false);
});

test("health indicators reflect actual records and only current unchosen recommendations", () => {
  const data = summary();
  data.rules = [{ id: "rule" }];
  data.meals = [{ id: "meal", meal_type: "lunch", occurred_at: `${data.date}T12:00:00+08:00`, status: "recorded", description: "午餐" }, { id: "skip", meal_type: "breakfast", occurred_at: `${data.date}T08:00:00+08:00`, status: "skipped", description: "" }];
  data.review.weight_trend = { count: 1, latest_kg: 81.4, last_date: data.date, change_kg: null };
  data.steps = [{ id: "later", measured_at: `${data.date}T17:00:00+08:00`, value: 0 }, { id: "earlier", measured_at: `${data.date}T09:00:00+08:00`, value: 200 }];
  const candidate = { target_date: data.date, meal_type: "dinner", status: "current", latest_feedback: null, options: [] };
  data.recommendations = [{ ...candidate, id: "ready" }, { ...candidate, id: "stale", status: "stale" }, { ...candidate, id: "chosen", latest_feedback: { action: "accepted" } }];
  const page = harness({ data }).render();
  const metrics = Object.fromEntries(page.filter((node) => node.type === "ServiceMetric").map((node) => [node.props.label, node.props.value]));
  assert.equal(metrics["有效饮食约定"], "1 条");
  assert.equal(metrics["最近体重"], "81.4 kg");
  assert.equal(metrics["当日步数"], "0 步");
  assert.equal(metrics["可用饮食建议"], "1 份");
  assert.ok(page.some((node) => node.type === "Text" && node.props.children === "1 餐"));
});

test("health toolbar navigates calendar days, returns to life, and keeps child tab spacing off", () => {
  const app = harness({ data: summary() }); let page = app.render();
  assert.equal(page.find((node) => node.type === "PageScrollView").props.tabs, false);
  let toolbar = page.find((node) => node.type === "ServiceToolbar"); const today = toolbar.props.period;
  toolbar.props.onPrevious(); page = app.render(); toolbar = page.find((node) => node.type === "ServiceToolbar");
  assert.notEqual(toolbar.props.period, today);
  toolbar.props.onNext(); assert.equal(app.render().find((node) => node.type === "ServiceToolbar").props.period, today);
  app.render().find((node) => node.type === "ServiceToolbar").props.onBack();
  assert.deepEqual(app.calls, [["back"]]);
});

test("the step summary uses measurement time across timezone offsets instead of adding repeated readings", () => {
  const data = summary();
  data.steps = [{ id: "early", measured_at: `${data.date}T17:00:00+08:00`, value: 200 }, { id: "late", measured_at: `${data.date}T10:00:00Z`, value: 350 }];
  const metric = harness({ data }).render().find((node) => node.type === "ServiceMetric" && node.props.label === "当日步数");
  assert.equal(metric.props.value, "350 步");
});

test("health empty records retain manual entry, next meal, and regular health chat", () => {
  const app = harness({ data: summary() }); const page = app.render();
  assert.ok(page.some((node) => node.type === "ServiceEmpty" && node.props.title === "还没有这一天的饮食记录"));
  page.find((node) => node.type === "ActionLink" && node.props.children === "记录饮食").props.onPress();
  page.find((node) => node.type === "ActionLink" && node.props.children === "记录体重").props.onPress();
  assert.equal(app.calls[0][1], "meal"); assert.equal(app.calls[0][2].description, "");
  assert.equal(app.calls[1][1], "weight"); assert.equal(app.calls[1][2].value, "");
  page.find((node) => node.type === "Button" && node.props.children === "聊聊下一餐").props.onPress();
  assert.match(app.calls[2][1], /使用健康工具读取依据/);
  page.find((node) => node.type === "ServiceChatRow" && node.props.title === "和健康助手聊聊").props.onPress();
  assert.deepEqual(app.calls[3], ["chat", undefined]);
});
