import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";
import { darkColors, lightColors } from "../src/theme.ts";
import * as theme from "../src/theme.ts";
import { thinkingLabel } from "../src/reasoning.ts";

const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const content = (node) => typeof node === "string" ? node : Array.isArray(node) ? node.map(content).join("") : node?.props ? content(node.props.children) : "";
const settle = async () => { for (let index = 0; index < 3; index++) await new Promise((resolve) => setImmediate(resolve)); };
function hooks() {
  const slots = []; let cursor = 0, effects = [];
  const changed = (old, next) => !old || next.some((value, index) => value !== old[index]);
  return { react: {
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (next) => { slots[index] = next; }]; },
    useEffect(callback, dependencies) { const index = cursor++, previous = slots[index]; if (changed(previous?.dependencies, dependencies)) { slots[index] = { dependencies }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); }); } },
  }, render(callback) { cursor = 0; effects = []; const result = callback(); effects.forEach((effect) => effect()); return result; }, unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}
const model = { id: "choice", name: "我选的真实模型", model: "qwen-test", provider: "bailian", reasoning_levels: ["none", "high"], reasoning_labels: { high: "深度" } };
function harness({ colors = darkColors, request = async () => ({ items: [] }), ...initial } = {}) {
  const lifecycle = hooks(), exports = {}, actions = [];
  const props = { text: "草稿", onText: (value) => actions.push(["text", value]), onSend: () => actions.push("send"), onFiles: () => actions.push("files"), onModel: () => actions.push("model"), onReasoning: () => actions.push("reasoning"), onSearch: () => actions.push("search"), editable: true, canSend: true, busy: false, kind: "chat", onKind() {}, model, depth: "high", searchId: null, ...initial };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime, react: lifecycle.react, "./ChatTextEditor": { ChatTextEditor: "ChatTextEditor" }, "./BottomSheet": { BottomSheet: "BottomSheet" },
    "react-native": { ...Object.fromEntries(["ActivityIndicator", "Pressable", "ScrollView", "Text", "TextInput", "View"].map((name) => [name, name])), StyleSheet: { create: (styles) => styles } },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" }, "./api": { request }, "./BrandIcon": { BrandIcon: "BrandIcon" }, "./reasoning": { thinkingLabel }, "./theme": theme,
    "./ThemeProvider": { useTheme: () => ({ colors }), useThemedStyles: (factory) => factory(colors) },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/ConversationComposer.tsx", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, AbortController, setTimeout, require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; },
  });
  return { props, actions, render(next = {}) { Object.assign(props, next); return walk(lifecycle.render(() => exports.ConversationComposer(props))); }, unmount: lifecycle.unmount };
}
const control = (nodes, label) => nodes.find((node) => node.type === "Pressable" && node.props.accessibilityLabel?.startsWith(label));

test("expanded editing keeps the same draft and attachments, restores selection and never submits", async () => {
  const app = harness({ text: '长需求\n第二段', children: 'photo draft' });
  let nodes = app.render();
  nodes.find(n => n.type === 'TextInput').props.onSelectionChange({ nativeEvent: { selection: { start: 4, end: 6 } } });
  control(nodes, '展开编辑消息').props.onPress();
  nodes = app.render();
  const editor = nodes.find(n => n.type === 'ChatTextEditor');
  assert.deepEqual({ ...editor.props.initialSelection }, { start: 4, end: 6 });
  editor.props.onText('修改后的长需求');
  nodes = app.render({ text: '修改后的长需求' });
  assert.equal(nodes.find(n => n.type === 'ChatTextEditor').props.text, '修改后的长需求');
  const restored = [];
  nodes.find(n => n.type === 'TextInput').props.ref.current = { focus() {}, setNativeProps: value => restored.push(value) };
  editor.props.onSelection({ start: 2, end: 2 }); editor.props.onClose();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual({ ...restored[0].selection }, { start: 2, end: 2 });
  assert.ok(content(app.render()[0]).includes('photo draft')); assert.ok(!app.actions.includes('send')); app.unmount();
});

test("the shared default composer places real choices above the attachment, input and send row", () => {
  const app = harness(); const nodes = app.render();
  assert.match(content(nodes[0]), new RegExp(model.name));
  const options = nodes[0].props.children[0], editor = nodes[0].props.children[1];
  assert.ok(walk(options).includes(control(nodes, "选择聊天模型")));
  assert.ok(walk(options).includes(control(nodes, "思考深度")));
  assert.ok(walk(options).includes(control(nodes, "联网搜索")));
  assert.equal(walk(options).some((node) => node.type === "TextInput"), false);
  assert.ok(walk(editor).includes(control(nodes, "添加资料")));
  assert.ok(walk(editor).some((node) => node.type === "TextInput"));
  assert.ok(walk(editor).includes(control(nodes, "发送消息")));
  app.unmount();
});

test("shared controls show real model, reasoning and search states in one scrolling row and expose no fake microphone", () => {
  const app = harness(); const nodes = app.render();
  assert.match(content(control(nodes, "选择聊天模型")), /我选的真实模型/);
  assert.match(content(control(nodes, "思考深度")), /深度/);
  assert.equal(content(control(nodes, "联网搜索")), "联网搜索"); assert.match(control(nodes, "联网搜索").props.accessibilityLabel, /已关闭/);
  const options = nodes.find((node) => node.type === "ScrollView");
  assert.equal(options.props.horizontal, true);
  assert.equal(options.props.showsHorizontalScrollIndicator, false);
  assert.equal(options.props.keyboardShouldPersistTaps, "handled");
  assert.equal(options.props.contentContainerStyle.flexWrap, "nowrap");
  assert.equal(options.props.contentContainerStyle.flexDirection, "row");
  assert.ok(walk(options).filter((node) => node.type === "Text").every((node) => node.props.numberOfLines === 1));
  assert.equal(nodes.some((node) => /语音|录音|麦克风/.test(node.props?.accessibilityLabel ?? "")), false);
  for (const [label, action] of [["选择聊天模型", "model"], ["思考深度", "reasoning"], ["联网搜索", "search"], ["添加资料", "files"], ["发送消息", "send"]]) { control(nodes, label).props.onPress(); assert.equal(app.actions.at(-1), action); }
  app.unmount();
});

test("long real labels stay complete in an unshrinking horizontal row at narrow widths", async () => {
  const longModelName = "用户自定义的超长模型名称 · 完整版本标识 2026";
  const app = harness({ model: { ...model, name: longModelName }, searchId: "long", connection: { url: "https://example.test", token: "fixture" }, request: async () => ({ items: [{ id: "long", name: "我配置的长名称搜索供应商", kind: "brave" }] }) });
  app.render(); await settle();
  const nodes = app.render();
  const options = nodes.find((node) => node.type === "ScrollView");
  assert.equal(options.props.style.flexShrink, 0);
  const choices = walk(options).filter((node) => node.type === "Pressable");
  assert.equal(choices.length, 3);
  for (const choice of choices) {
    assert.equal(choice.props.style[0].flexShrink, 0);
    assert.ok(choice.props.style[0].minHeight >= 44);
    assert.ok(choice.props.style[0].minWidth >= 40);
    assert.equal(choice.props.style[0].maxWidth, undefined);
  }
  assert.match(content(control(nodes, "选择聊天模型")), new RegExp(longModelName));
  assert.match(content(control(nodes, "联网搜索")), /我配置的长名称搜索供应商/);
  app.unmount();
});

test("queued content floats above the model viewport without adding a persistent input row", () => {
  const app = harness({ floating: "queued preview" });
  const nodes = app.render();
  const anchor = nodes[0].props.children[0];
  const floating = anchor.props.children[0];
  assert.equal(anchor.props.style[0].position, "relative");
  assert.equal(anchor.props.style[1].paddingTop, 50);
  assert.equal(nodes[0].props.style[1].marginTop, -50);
  assert.equal(anchor.props.style[1].paddingTop + nodes[0].props.style[1].marginTop, 0);
  assert.equal(floating.props.style.position, "absolute");
  assert.equal(floating.props.style.top, 0);
  assert.equal(floating.props.style.bottom, undefined);
  assert.equal(floating.props.style.left, 0);
  assert.equal(floating.props.style.right, 0);
  assert.equal(floating.props.pointerEvents, "box-none");
  assert.equal(content(floating), "queued preview");
  assert.equal(anchor.props.children[1].type, "ScrollView");
  const empty = app.render({ floating: undefined });
  assert.equal(empty[0].props.children[0].props.children[0], null);
  assert.equal(empty[0].props.children.filter((node) => node && node.type !== "BottomSheet").length, 2);
  app.unmount();
});

test("the shared composer preserves attachments, hints, multiline edits, locked controls and pending retry", () => {
  for (const colors of [lightColors, darkColors]) {
    const app = harness({ colors, children: "attachment preview", hint: "queue hint", pending: true, attachmentLocked: true, optionsLocked: true, editable: false, canSend: false });
    const nodes = app.render(); assert.match(content(nodes[0]), /attachment preview/); assert.match(content(nodes[0]), /queue hint/);
    const input = nodes.find((node) => node.type === "TextInput"); assert.equal(input.props.value, "草稿"); assert.equal(input.props.multiline, true); assert.equal(input.props.maxLength, 20000); assert.equal(input.props.editable, false);
    for (const label of ["添加资料", "选择聊天模型", "思考深度", "联网搜索", "重试发送"]) assert.equal(control(nodes, label).props.disabled, true);
    const retry = app.render({ optionsLocked: false, attachmentLocked: false, editable: true, canSend: true }); control(retry, "重试发送").props.onPress(); assert.equal(app.actions.at(-1), "send");
    retry.find((node) => node.type === "TextInput").props.onChangeText("新输入"); assert.deepEqual(app.actions.at(-1), ["text", "新输入"]);
    const busy = app.render({ busy: true, canSend: false }); assert.ok(busy.some((node) => node.type === "ActivityIndicator")); app.unmount();
  }
});

test("reasoning controls reflect unsupported, auto and disabled depths", () => {
  const app = harness();
  const unavailable = app.render({ model: { ...model, reasoning_levels: [] } }); assert.equal(control(unavailable, "思考深度").props.disabled, true); assert.match(content(control(unavailable, "思考深度")), /不可调整/);
  const automatic = app.render({ model, depth: "auto" }); assert.match(content(control(automatic, "思考深度")), /自动/);
  const disabled = app.render({ depth: "none" }); assert.match(content(control(disabled, "思考深度")), /关闭/); assert.equal(control(disabled, "思考深度").props.disabled, false);
  app.unmount();
});

test("search provider labels never carry over across connections and late requests cannot restore an old provider", async () => {
  const calls = [], connectionA = { url: "https://a.example", token: "a" }, connectionB = { url: "https://b.example", token: "b" };
  const app = harness({ connection: connectionA, searchId: "same-id", request(connection, path, options) { return new Promise((resolve) => calls.push({ connection, path, options, resolve })); } });
  app.render(); calls[0].resolve({ items: [{ id: "same-id", name: "旧服务搜索", kind: "tavily" }] }); await settle(); assert.match(content(control(app.render(), "联网搜索")), /旧服务搜索/);
  const switching = app.render({ connection: connectionB }); assert.doesNotMatch(content(control(switching, "联网搜索")), /旧服务搜索/); assert.equal(calls[0].options.signal.aborted, true);
  calls[1].resolve({ items: [{ id: "same-id", name: "新服务搜索", kind: "brave" }] }); await settle(); assert.match(content(control(app.render(), "联网搜索")), /新服务搜索/);
  app.render({ searchId: "late" }); app.render({ searchId: null }); assert.equal(calls[2].options.signal.aborted, true);
  calls[2].resolve({ items: [{ id: "late", name: "不应出现的旧响应", kind: "tavily" }] }); await settle();
  const off = control(app.render(), "联网搜索"); assert.equal(content(off), "联网搜索"); assert.match(off.props.accessibilityLabel, /已关闭/); assert.doesNotMatch(content(off), /旧响应/); assert.equal(off.props.accessibilityState.selected, false); app.unmount();
});

test("the photo action opens the native picker only after its sheet is dismissed, without navigating to files", () => {
  let picked = 0; const app = harness({ onPhotos: () => picked++ });
  control(app.render(), "添加资料").props.onPress();
  let nodes = app.render(); assert.equal(nodes.find((node) => node.type === "BottomSheet").props.visible, true);
  control(nodes, "选择照片").props.onPress(); assert.equal(picked, 0);
  nodes = app.render(); const sheet = nodes.find((node) => node.type === "BottomSheet");
  assert.equal(sheet.props.visible, false); sheet.props.onDismiss(); sheet.props.onDismiss();
  assert.equal(picked, 1); assert.equal(app.actions.includes("files"), false); app.unmount();
});
