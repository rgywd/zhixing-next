import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { ApiError, mergeById } from "../src/api.ts";
import { lightColors, layout, radius, space, typography } from "../src/theme.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const connection = { url: "https://example.test/assistant", token: "test-only" };
const memory = (id, content = `记忆 ${id}`) => ({ id, content });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(props = {}, module = "MemoryPanel") {
  let cursor = 0, dirty = false, timerId = 0, nodes = [];
  const slots = [], effects = [], timers = new Map(), calls = [], alerts = [], backs = [];
  const input = { connection, onBack: () => backs.push(true), ...props };
  const slot = (initial) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return index; };
  const changed = (old, next) => !old || old.length !== next.length || next.some((value, index) => value !== old[index]);
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) { const index = slot(typeof initial === "function" ? initial() : initial); return [slots[index], (next) => { const value = typeof next === "function" ? next(slots[index]) : next; if (value !== slots[index]) { slots[index] = value; dirty = true; } }]; },
      useRef(value) { return slots[slot({ current: value })]; },
      useEffect(effect, deps) { const index = slot(undefined); if (changed(slots[index]?.deps, deps)) { slots[index]?.cleanup?.(); slots[index] = { deps }; effects.push(() => { slots[index].cleanup = effect(); }); } },
    },
    "react-native": {
      ...Object.fromEntries(["ActivityIndicator", "KeyboardAvoidingView", "Modal", "Pressable", "Text", "TextInput", "View", "ScrollView"].map((key) => [key, key])),
      StyleSheet: { create: (styles) => styles }, Platform: { OS: "android" },
      Alert: { alert: (...args) => alerts.push(args) },
      Animated: { View: "AnimatedView", Value: class { setValue() {} }, timing: () => ({ start() {} }) },
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./theme": { layout, radius, space, typography },
    "./ThemeProvider": { useThemedStyles: (factory) => factory(lightColors) },
    "./ui": { useUi: () => ({ s: {}, colors: lightColors }), humanError: (error) => error.message,
      ...Object.fromEntries(["ActionLink", "Button", "Empty", "Field", "IconAction"].map((key) => [key, key])) },
    "./api": { ApiError, mergeById, request: (_connection, path, options) => { const task = deferred(); calls.push({ path, options, ...task }); return task.promise; } },
    "./MemoryPanel": { MemoryPanel: "MemoryPanel" },
  };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${module}.tsx`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, AbortController, encodeURIComponent,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    require: (key) => { assert.ok(key in dependencies, key); return dependencies[key]; },
  });
  function render() {
    let attempts = 0;
    do {
      cursor = 0; dirty = false; nodes = [];
      const walk = (node) => { if (!node || typeof node !== "object") return; if (Array.isArray(node)) return node.forEach(walk); nodes.push(node); walk(node.props?.children); };
      walk(exports[module](input));
      while (effects.length) effects.shift()();
      assert.ok(++attempts < 10, "render settled");
    } while (dirty);
    return nodes;
  }
  render();
  return { render, calls, alerts, backs,
    fireTimers() { const queued = [...timers.values()]; timers.clear(); queued.forEach((callback) => callback()); },
    unmount() { slots.forEach((value) => value?.cleanup?.()); },
  };
}
const find = (page, predicate) => page.render().find(predicate);
const text = (value) => (node) => node.props?.children === value;
const label = (value) => (node) => node.props?.accessibilityLabel === value || node.props?.label === value;
const results = (page) => page.render().filter((node) => node.props?.label?.startsWith("操作记忆："));
async function loaded(items, extra = {}) {
  const page = mount(extra); page.fireTimers();
  page.calls[0].resolve({ items, next_cursor: null }); await settle();
  return page;
}
function expand(page, content) { find(page, label(`操作记忆：${content}`)).props.onPress(); }

test("memory loading failure can retry without presenting an unverified empty collection", async () => {
  const page = mount();
  assert.ok(find(page, label("正在加载记忆")));
  assert.ok(!find(page, (node) => node.type === "Empty"));
  page.fireTimers(); page.calls[0].reject(new Error("连接中断")); await settle();
  assert.ok(find(page, text("连接中断")));
  find(page, text("重新加载记忆")).props.onPress(); page.render(); page.fireTimers();
  page.calls[1].resolve({ items: [], next_cursor: null }); await settle();
  assert.equal(find(page, (node) => node.type === "Empty").props.title, "还没有整理出记忆");
});

test("global memory search rejects stale pages and pagination retry preserves the active query and cursor", async () => {
  const page = mount(); page.fireTimers();
  find(page, label("搜索全部记忆")).props.onChangeText(" 工作 100%_ "); page.render(); page.fireTimers();
  assert.equal(page.calls[0].options.signal.aborted, true);
  assert.ok(page.calls[1].path.includes(`query=${encodeURIComponent("工作 100%_")}`));
  page.calls[1].resolve({ items: [memory("new")], next_cursor: "105" }); await settle();
  page.calls[0].resolve({ items: [memory("stale")], next_cursor: null }); await settle();
  assert.deepEqual(results(page).map((node) => node.props.label), ["操作记忆：记忆 new"]);
  find(page, text("查看更多记忆")).props.onPress();
  assert.match(page.calls[2].path, /cursor=105$/);
  page.calls[2].reject(new Error("下一页未加载")); await settle();
  assert.equal(results(page).length, 1);
  find(page, text("重新加载记忆")).props.onPress();
  assert.equal(page.calls[3].path, page.calls[2].path);
  find(page, label("搜索全部记忆")).props.onChangeText("其他"); page.render(); page.fireTimers();
  assert.equal(page.calls[3].options.signal.aborted, true);
  page.calls[3].resolve({ items: [memory("stale-more")], next_cursor: null });
  page.calls[4].resolve({ items: [], next_cursor: null }); await settle();
  assert.equal(results(page).length, 0);
  assert.equal(find(page, (node) => node.type === "Empty").props.title, "没有找到相关记忆");
});

test("failed memory corrections retain text and serialize saving against stale edit, search and forget callbacks", async () => {
  const page = await loaded([memory("one", "喜欢红茶"), memory("two")]);
  expand(page, "喜欢红茶");
  const oldForget = find(page, text("忘记")).props.onPress;
  const oldSearch = find(page, label("搜索全部记忆")).props.onChangeText;
  find(page, text("纠正")).props.onPress();
  const change = find(page, label("纠正记忆")).props.onChangeText;
  change("  改为喜欢绿茶  ");
  const save = find(page, text("保存纠正")).props.onPress;
  save(); save(); oldForget(); oldSearch("不应切换"); change("不应覆盖已提交的内容");
  assert.equal(page.calls.length, 2);
  assert.equal(page.alerts.length, 0);
  assert.equal(page.calls[1].options.method, "PATCH");
  assert.equal(page.calls[1].options.body.content, "改为喜欢绿茶");
  assert.equal(find(page, label("搜索全部记忆")).props.value, "");
  assert.equal(find(page, label("搜索全部记忆")).props.editable, false);
  page.calls[1].reject(new Error("保存未确认")); await settle();
  assert.equal(find(page, label("纠正记忆")).props.value, "  改为喜欢绿茶  ");
  assert.ok(find(page, text("保存未确认")));
  find(page, text("重试保存")).props.onPress();
  assert.equal(page.calls[2].path, page.calls[1].path);
  assert.equal(page.calls[2].options.body.content, page.calls[1].options.body.content);
  page.calls[2].resolve(memory("one", "改为喜欢绿茶")); await settle();
  assert.ok(find(page, text("改为喜欢绿茶")));
  assert.ok(find(page, text("记忆已纠正")));
  assert.equal(find(page, label("搜索全部记忆")).props.editable, true);
});

test("saving a correction reruns an active search without losing its keyword", async () => {
  const page = await loaded([]);
  find(page, label("搜索全部记忆")).props.onChangeText("红茶"); page.render(); page.fireTimers();
  page.calls[1].resolve({ items: [memory("one", "喜欢红茶")], next_cursor: null }); await settle();
  expand(page, "喜欢红茶"); find(page, text("纠正")).props.onPress();
  find(page, label("纠正记忆")).props.onChangeText("喜欢绿茶");
  find(page, text("保存纠正")).props.onPress(); page.calls[2].resolve(memory("one", "喜欢绿茶")); await settle();
  page.render(); page.fireTimers();
  assert.equal(find(page, label("搜索全部记忆")).props.value, "红茶");
  assert.equal(page.calls[3].path, page.calls[1].path);
  page.calls[3].resolve({ items: [], next_cursor: null }); await settle();
  assert.equal(results(page).length, 0);
  assert.equal(find(page, (node) => node.type === "Empty").props.title, "没有找到相关记忆");
});

test("forget retry converges only for a confirmed missing memory and leaves authorization failures visible", async () => {
  const page = await loaded([memory("one")]); expand(page, "记忆 one");
  find(page, text("忘记")).props.onPress();
  assert.equal(page.calls.length, 1);
  page.alerts[0][2].find((action) => action.text === "忘记").onPress();
  page.calls[1].reject(new Error("结果未知")); await settle();
  assert.equal(results(page).length, 1);
  find(page, text("重试忘记")).props.onPress();
  page.calls[2].reject(new ApiError("凭证无效", "unauthorized", 401)); await settle();
  assert.equal(results(page).length, 1);
  assert.ok(find(page, text("凭证无效")));
  find(page, text("重试忘记")).props.onPress();
  page.calls[3].reject(new ApiError("Resource not found", "not_found", 404)); await settle();
  assert.equal(results(page).length, 0);
  assert.ok(find(page, text("已忘记这条记忆")));
});

test("memory leave guard retains unsaved changes and blocks exit until a pending correction settles", async () => {
  const leaveGuardRef = { current: null }, left = [];
  const page = await loaded([memory("one")], { leaveGuardRef }); expand(page, "记忆 one");
  find(page, text("纠正")).props.onPress(); find(page, label("纠正记忆")).props.onChangeText("还未保存"); page.render();
  leaveGuardRef.current(() => left.push(true));
  assert.equal(left.length, 0);
  assert.equal(page.alerts[0][0], "还有未保存的纠正");
  assert.equal(find(page, label("纠正记忆")).props.value, "还未保存");
  find(page, text("保存纠正")).props.onPress();
  leaveGuardRef.current(() => left.push(true));
  assert.equal(page.alerts.length, 1);
  assert.equal(left.length, 0);
  page.calls[1].reject(new Error("保存失败")); await settle(); page.render();
  leaveGuardRef.current(() => left.push(true));
  page.alerts[1][2].find((action) => action.text === "放弃修改").onPress();
  assert.equal(left.length, 1);
  page.unmount(); assert.equal(leaveGuardRef.current, null);
});

test("drawer system back and backdrop both use the memory leave guard", () => {
  const closed = [], attempts = [];
  const page = mount({ visible: true, name: "知行", conversations: [], onClose: () => closed.push(true) }, "AiDrawer");
  find(page, label("记忆")).props.onPress();
  const panel = find(page, (node) => node.type === "MemoryPanel");
  panel.props.leaveGuardRef.current = (leave) => attempts.push(leave);
  find(page, (node) => node.type === "Modal").props.onRequestClose();
  find(page, label("关闭侧边栏")).props.onPress();
  assert.equal(attempts.length, 2);
  assert.equal(closed.length, 0);
  attempts[1]();
  assert.equal(closed.length, 1);
  assert.ok(!find(page, (node) => node.type === "MemoryPanel"));
});
