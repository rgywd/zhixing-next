import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import * as theme from "../src/theme.ts";

const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
function harness(overrides = {}) {
  const slots = [], calls = [], exports = {}; let cursor = 0;
  const native = { ...Object.fromEntries(["View", "Text", "ScrollView", "Pressable"].map((key) => [key, key])), StyleSheet: { hairlineWidth: 0.5, create: (value) => value } };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: { useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next) => { slots[i] = next; }]; } },
    "react-native": native,
    "./ui": { useUi: () => ({ s: {}, colors: theme.darkColors }), ActionLink: "ActionLink" },
    "./ThemeProvider": { useThemedStyles: (factory) => factory(theme.darkColors) },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    ...Object.fromEntries(["ConversationComposer", "ReasoningPicker", "ModelPicker", "SearchPicker"].map((key) => [`./${key}`, { [key]: key }])),
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/AiHome.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require(key) { assert.ok(key in dependencies, `Unexpected dependency: ${key}`); return dependencies[key]; } });
  const props = {
    name: "知行", draft: "我先写了一半", kind: "task", busy: false, draftReady: true,
    connection: { url: "https://test.invalid", token: "test" }, catalog: { roles: { chat: "chat-model", task: "task-model" }, items: [{ id: "chat-model", name: "Chat" }, { id: "task-model", name: "Task" }] }, modelId: null, effort: null, searchProviderId: null,
    ...Object.fromEntries(["Draft", "Kind", "ModelId", "Effort", "SearchProviderId", "Files", "Send", "RetryDraft"].map((key) => [`on${key}`, (...args) => calls.push([key, ...args])])),
    ...overrides,
  };
  return { calls, props, render() { cursor = 0; const tree = exports.AiHome(props); return { tree, nodes: walk(tree) }; } };
}

test("welcome actions append to an existing draft, keep chat mode, and never auto-send", () => {
  const app = harness();
  const actions = app.render().nodes.filter((node) => node.type === "Pressable" && node.props.accessibilityRole === "button");
  assert.deepEqual(actions.map((node) => node.props.accessibilityLabel), ["☕ 规划今日节奏", "🎯 明确执行要点", "理清思路", "看看开销", "读懂资料", "聊聊近况", "饮食与生活建议"]);
  for (const action of actions) action.props.onPress();
  const drafts = app.calls.filter(([kind]) => kind === "Draft");
  assert.equal(drafts.length, 7);
  assert.ok(drafts.every(([, text]) => text.startsWith("我先写了一半\n\n")));
  assert.ok(app.calls.filter(([kind]) => kind === "Kind").every(([, value]) => value === "chat"));
  assert.equal(app.calls.some(([kind]) => kind === "Send"), false);
});

test("welcome locks every entry and composer mutation while busy or waiting for its draft", async () => {
  for (const state of [{ busy: true }, { draftReady: false }]) {
    const app = harness(state); const { nodes } = app.render();
    const entries = nodes.filter((node) => node.type === "Pressable");
    assert.ok(entries.every((node) => node.props.disabled && node.props.accessibilityState.disabled));
    for (const entry of entries) entry.props.onPress();
    const composer = nodes.find((node) => node.type === "ConversationComposer");
    assert.equal(composer.props.editable, false); assert.equal(composer.props.canSend, false);
    composer.props.onText("replace"); composer.props.onSend(); composer.props.onFiles(); composer.props.onKind("task");
    await nodes.find((node) => node.type === "ModelPicker").props.onSelect("task-model");
    await nodes.find((node) => node.type === "ReasoningPicker").props.onSelect("high");
    nodes.find((node) => node.type === "SearchPicker").props.onSelect("search");
    assert.deepEqual(app.calls, []);
  }
});

test("welcome composer stays outside the scroll body and uses chat defaults despite legacy task state", () => {
  const { tree, nodes } = harness().render();
  const scroll = nodes.find((node) => node.type === "ScrollView");
  const composer = nodes.find((node) => node.type === "ConversationComposer");
  assert.ok(tree.props.children.includes(composer));
  assert.equal(walk(scroll).includes(composer), false);
  assert.equal(composer.props.appearance, "welcome"); assert.equal(composer.props.kind, "chat");
  assert.equal(composer.props.model.id, "chat-model");
  const picker = nodes.find((node) => node.type === "ModelPicker");
  assert.equal(picker.props.selectedId, "chat-model"); assert.equal(picker.props.title, "选择聊天模型");
});

test("welcome keeps draft recovery and model, reasoning, and search pickers working", async () => {
  const app = harness({ draftError: "本机草稿尚未读取", draftReady: false }); let page = app.render();
  const retry = page.nodes.find((node) => node.type === "ActionLink");
  assert.equal(retry.props.children, "重新读取草稿"); retry.props.onPress();
  assert.deepEqual(app.calls, [["RetryDraft"]]);
  app.props.draftReady = true;
  let composer = app.render().nodes.find((node) => node.type === "ConversationComposer");
  composer.props.onModel(); composer.props.onReasoning(); composer.props.onSearch();
  page = app.render();
  assert.equal(page.nodes.find((node) => node.type === "ModelPicker").props.visible, true);
  assert.equal(page.nodes.find((node) => node.type === "ReasoningPicker").props.visible, true);
  assert.equal(page.nodes.find((node) => node.type === "SearchPicker").props.visible, true);
  await page.nodes.find((node) => node.type === "ModelPicker").props.onSelect("new-model");
  await page.nodes.find((node) => node.type === "ReasoningPicker").props.onSelect("high");
  page.nodes.find((node) => node.type === "SearchPicker").props.onSelect("web");
  assert.deepEqual(app.calls.slice(1), [["ModelId", "new-model"], ["Effort", null], ["Effort", "high"], ["SearchProviderId", "web"]]);
});
