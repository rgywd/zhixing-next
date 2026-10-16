import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import * as theme from "../src/theme.ts";
import * as steerableRun from "../src/steerableRun.ts";

const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const text = (node) => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : node?.props ? text(node.props.children) : "";
const image = { id: "image", name: "截图.png", mime_type: "image/png", path: "data/image.png", size: 100, conversation_id: "chat" };
const file = { ...image, id: "pdf", name: "账单.pdf", mime_type: "application/pdf" };
const item = (id, body = "等当前回复后处理", attachments = []) => ({ run: { id, created_at: "2026-10-15", status: "queued", phase: "normal" }, text: body, attachments });
const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness({ colors = theme.darkColors, ...initial } = {}) {
  const slots = []; let cursor = 0, effects = [];
  const react = {
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = initial; return [slots[id], (next) => { slots[id] = typeof next === "function" ? next(slots[id]) : next; }]; },
    useEffect(callback, dependencies) { const id = cursor++, previous = slots[id]; if (!previous || dependencies.some((value, index) => value !== previous[index])) { slots[id] = dependencies; effects.push(callback); } },
  };
  const exports = {}, actions = [];
  const props = { connection: { url: "https://example.test", token: "disposable" }, items: [item("one")], running: { id: "active", status: "running", cancel_requested: false }, busyId: null, error: "", onWithdraw: async (queued) => actions.push(["withdraw", queued]), onSteer: async (queued) => actions.push(["steer", queued]), onOpenRun: (id) => actions.push(["detail", id]), ...initial };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime, react,
    "react-native": { ...Object.fromEntries(["ActivityIndicator", "Pressable", "ScrollView", "Text", "View"].map((name) => [name, name])), StyleSheet: { create: (styles) => styles } },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./theme": theme,
    "./ThemeProvider": { useThemedStyles: (factory) => factory(colors) },
    "./ui": { useUi: () => ({ s: {}, colors }), ActionLink: "ActionLink", Button: "Button", timeLabel: String },
    "./Attachments": { Attachments: "Attachments" }, "./ResourcePreview": { ResourceImage: "ResourceImage" }, "./BottomSheet": { BottomSheet: "BottomSheet" },
    "./steerableRun": steerableRun,
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/QueuedMessages.tsx", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; },
  });
  return { props, actions, render(next = {}) { Object.assign(props, next); cursor = 0; effects = []; const result = exports.QueuedMessages(props); effects.forEach((effect) => effect()); return { root: result, nodes: walk(result) }; } };
}
const control = (nodes, label) => nodes.find((node) => node.type === "Pressable" && node.props.accessibilityLabel?.startsWith(label));
const sheet = (nodes) => nodes.find((node) => node.type === "BottomSheet");

test("an empty queue has no strip, sheet or reserved UI", () => {
  const app = harness({ items: [] });
  assert.equal(app.render().root, null);
});

test("long and multiline queued text stays a single compact ellipsis row in both themes", () => {
  for (const colors of [theme.lightColors, theme.darkColors]) {
    const body = "等当前回复结束，\n再处理这个包含很多细节的长消息。".repeat(12);
    const app = harness({ colors, items: [item("one", body)] });
    const { nodes } = app.render();
    const bar = nodes.find((node) => node.props?.testID === "queued-message-strip");
    assert.equal(bar.props.style.flexWrap, "nowrap");
    assert.equal(bar.props.style.backgroundColor, colors.neutral);
    assert.equal(bar.props.style.borderColor, colors.line);
    assert.equal(bar.props.style.elevation, 5);
    const summary = control(nodes, "查看待发送消息");
    assert.equal(summary.props.style.flex, 1);
    assert.equal(summary.props.style.minWidth, 0);
    const preview = walk(summary).find((node) => node.type === "Text");
    assert.equal(preview.props.numberOfLines, 1);
    assert.equal(preview.props.ellipsizeMode, "tail");
    assert.doesNotMatch(text(preview), /\n/);
    assert.equal(preview.props.style.minWidth, 0);
    for (const label of ["查看待发送消息", "将待发送消息引导", "撤回这条", "更多待发送消息"]) assert.ok(control(nodes, label).props.style[0]?.minHeight >= 44 || control(nodes, label).props.style.minHeight >= 44);
    assert.equal(sheet(nodes).props.visible, false);
  }
});

test("image messages use the authenticated shared thumbnail and preserve every attachment in details", () => {
  const queued = item("one", "", [file, image]);
  const app = harness({ items: [queued] });
  let { nodes } = app.render();
  const thumb = nodes.find((node) => node.type === "ResourceImage");
  assert.equal(thumb.props.connection, app.props.connection);
  assert.equal(thumb.props.resource, image);
  assert.equal(thumb.props.style.width, 26);
  assert.match(text(control(nodes, "查看待发送消息")), /2 个附件/);
  control(nodes, "查看待发送消息").props.onPress();
  nodes = app.render().nodes;
  assert.equal(sheet(nodes).props.visible, true);
  assert.equal(sheet(nodes).props.title, "待发送消息");
  assert.equal(walk(sheet(nodes)).find((node) => node.type === "Attachments").props.items, queued.attachments);
  const onlyFile = app.render({ items: [item("pdf-only", "", [file])] }).nodes;
  assert.equal(onlyFile.some((node) => node.type === "ResourceImage"), false);
});

test("strip actions operate on the exact queued item and details can open its processing record", async () => {
  const queued = item("one", "完整文本\n第二行", [image]);
  const app = harness({ items: [queued] });
  let { nodes } = app.render();
  control(nodes, "将待发送消息引导").props.onPress();
  control(nodes, "撤回这条").props.onPress();
  await settle();
  assert.deepEqual(app.actions, [["steer", queued], ["withdraw", queued]]);
  control(nodes, "查看待发送消息").props.onPress();
  nodes = app.render().nodes;
  const body = walk(sheet(nodes)).find((node) => node.type === "Text" && node.props.selectable);
  assert.equal(body.props.children, queued.text);
  walk(sheet(nodes)).find((node) => node.type === "ActionLink" && node.props.children === "查看处理记录").props.onPress();
  assert.deepEqual(app.actions.at(-1), ["detail", "one"]);
  assert.equal(sheet(app.render().nodes).props.visible, false);
});

test("multiple queued messages open a list, select their full detail, and follow actual removals", () => {
  const first = item("one"), second = item("two", "我应该排在第二条");
  const app = harness({ items: [first, second] });
  let { nodes } = app.render();
  const more = control(nodes, "更多待发送消息");
  assert.equal(text(more), "+1");
  more.props.onPress();
  nodes = app.render().nodes;
  assert.equal(sheet(nodes).props.title, "等待发送 · 2 条");
  control(walk(sheet(nodes)), "查看待发送消息：我应该").props.onPress();
  nodes = app.render().nodes;
  assert.equal(sheet(nodes).props.title, "待发送消息");
  assert.match(text(sheet(nodes)), /我应该排在第二条/);
  app.render({ items: [first] });
  nodes = app.render().nodes;
  assert.equal(sheet(nodes).props.title, "等待发送 · 1 条");
  assert.equal(app.render({ items: [] }).root, null);
});

test("idle, cancelling and in-flight states disable mutations without hiding queue contents", () => {
  const app = harness();
  for (const state of [{ running: null, busyId: null }, { running: { id: "active", status: "running", cancel_requested: true }, busyId: null }, { running: { id: "active", status: "running", cancel_requested: false }, busyId: "one" }, { running: { id: "finished", status: "completed", cancel_requested: false }, busyId: null }]) {
    const { nodes } = app.render(state);
    assert.equal(control(nodes, "将待发送消息引导").props.disabled, true);
    assert.equal(control(nodes, "撤回这条").props.disabled, !!state.busyId);
    assert.ok(control(nodes, "查看待发送消息"));
    assert.equal(control(nodes, "更多待发送消息").props.disabled, undefined);
  }
  assert.ok(app.render({ busyId: "one" }).nodes.some((node) => node.type === "ActivityIndicator"));
});

test("the real queue component permits a waiting user reply and excludes other paused or internal replies", async () => {
  const app = harness({ running: { id: "waiting", status: "queued", phase: "agent_wait", cancel_requested: false } });
  let nodes = app.render().nodes;
  const guide = control(nodes, "将待发送消息引导");
  assert.equal(guide.props.disabled, false); guide.props.onPress(); await settle();
  assert.equal(app.actions[0][0], "steer");
  for (const candidate of [
    ...["approval", "input", "recovering", "normal"].map((phase) => ({ id: phase, status: "queued", phase })),
    { id: "internal", status: "running", origin: "agent_message" },
    { id: "internal-wait", status: "queued", phase: "agent_wait", origin: "agent_message" },
    { id: "cancel", status: "queued", phase: "agent_wait", cancel_requested: true },
  ]) {
    nodes = app.render({ running: candidate }).nodes;
    assert.equal(control(nodes, "将待发送消息引导").props.disabled, true);
  }
});

test("failed actions keep the original preview and provide the error plus the same retry actions", async () => {
  const queued = item("one", "不能丢失我的原文");
  const calls = [];
  const app = harness({ items: [queued], error: "该消息状态刚发生变化", onWithdraw: async (value) => { calls.push(value); throw new Error("still waiting"); } });
  let { nodes } = app.render();
  assert.match(text(control(nodes, "查看待发送消息")), /不能丢失我的原文/);
  assert.match(control(nodes, "查看待发送消息").props.accessibilityLabel, /操作未完成/);
  control(nodes, "查看待发送消息").props.onPress();
  nodes = app.render().nodes;
  assert.ok(walk(sheet(nodes)).some((node) => node.props?.accessibilityRole === "alert" && /操作未确认，请查看最新队列后重试/.test(text(node))));
  walk(sheet(nodes)).find((node) => node.type === "Button" && node.props.children === "撤回这条消息").props.onPress();
  await settle();
  assert.deepEqual(calls, [queued]);
  assert.match(text(control(app.render().nodes, "查看待发送消息")), /不能丢失我的原文/);
});
