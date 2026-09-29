import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { ApiError } from "../src/api.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function screen({ management = true, failMutation = false } = {}) {
  const state = [];
  let cursor = 0;
  let mounted = false;
  let confirmation;
  let closed = 0;
  const selected = [];
  const removed = [];
  const calls = [];
  const exports = {};
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) {
        const slot = cursor++;
        if (!(slot in state)) state[slot] = initial;
        return [state[slot], (next) => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }];
      },
      useEffect(effect) { if (!mounted) { mounted = true; effect(); } },
    },
    "react-native": {
      View: "View", Text: "Text", ScrollView: "ScrollView", Pressable: "Pressable", Switch: "Switch",
      StyleSheet: { create: (styles) => styles },
      Alert: { alert: (_title, _description, choices) => { confirmation = choices.find((choice) => choice.style === "destructive").onPress; } },
    },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./BottomSheet": { BottomSheet: "BottomSheet" },
    "./BrandIcon": { BrandIcon: "BrandIcon" },
    "./ThemeProvider": { useThemedStyles: (factory) => factory({}) },
    "./theme": { radius: {}, space: {}, typography: {} },
    "./ui": { useUi: () => ({ s: {}, colors: {} }), ActionLink: "ActionLink", Button: "Button", Field: "Field", IconAction: "IconAction", colors: {}, s: {}, humanError: (error) => error.message },
    "./api": {
      ApiError,
      request: async (_connection, path, options) => {
        calls.push({ path, options });
        if (options?.method) {
          if (failMutation) throw new Error("保存失败，请重试");
          if (options.method === "POST") return { id: "added", kind: "brave", name: "My Search" };
          return {};
        }
        return { items: [{ id: "existing", name: "Existing", kind: "tavily" }] };
      },
    },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/SearchPicker.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  function render() {
    cursor = 0;
    const nodes = [];
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      nodes.push(node);
      walk(node.props?.children);
    }
    walk(exports.SearchPicker({ visible: true, management, connection: { url: "https://example.com", token: "test" }, selectedId: "existing",
      onSelect: (id) => selected.push(id), onRemoved: (id) => removed.push(id), onClose: () => { closed += 1; } }));
    return nodes;
  }
  render();
  return { render, selected, removed, calls, closed: () => closed, confirm: () => confirmation() };
}
function startAdding(page) {
  page.render().find((node) => node.props.accessibilityLabel === "添加搜索服务").props.onPress();
  page.render().find((node) => node.type === "Field" && node.props.label === "名称").props.onChangeText("My Search");
  page.render().find((node) => node.type === "Field" && node.props.secureTextEntry).props.onChangeText("local-test-key");
  page.render().find((node) => node.type === "Button").props.onPress();
}

test("adding a service in settings preserves the chat selection and stays in management", async () => {
  const page = screen();
  await settle();
  assert.ok(!page.render().some((node) => node.type === "Switch"));
  startAdding(page);
  await settle();
  assert.equal(page.calls.find((call) => call.options?.method === "POST").options.body.api_key, "local-test-key");
  assert.deepEqual(page.selected, []);
  assert.equal(page.closed(), 0);
  assert.ok(page.render().some((node) => node.props.label === "移除 My Search"));
  assert.ok(!page.render().some((node) => node.props.secureTextEntry));
});

test("adding from the chat picker still selects the service and closes the picker", async () => {
  const page = screen({ management: false });
  await settle();
  startAdding(page);
  await settle();
  assert.deepEqual(page.selected, ["added"]);
  assert.equal(page.closed(), 1);
});

test("a failed search service save keeps the form without changing selection", async () => {
  const page = screen({ failMutation: true });
  await settle();
  startAdding(page);
  await settle();
  assert.deepEqual(page.selected, []);
  assert.equal(page.closed(), 0);
  assert.ok(page.render().some((node) => node.props.accessibilityRole === "alert"));
  assert.equal(page.render().find((node) => node.props.secureTextEntry).props.value, "local-test-key");
});

test("search removal clears selected references only after confirmation and a successful response", async () => {
  for (const failMutation of [false, true]) {
    const page = screen({ failMutation });
    await settle();
    page.render().find((node) => node.props.label === "移除 Existing").props.onPress();
    assert.equal(page.calls.filter((call) => call.options?.method === "DELETE").length, 0);
    page.confirm();
    await settle();
    assert.equal(page.calls.find((call) => call.options?.method === "DELETE").path, "/search/providers/existing");
    assert.deepEqual(page.selected, failMutation ? [] : [null]);
    assert.deepEqual(page.removed, failMutation ? [] : ["existing"]);
    assert.equal(page.render().some((node) => node.props.label === "移除 Existing"), failMutation);
  }
});
