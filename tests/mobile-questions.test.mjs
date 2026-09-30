import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { ApiError } from "../src/api.ts";

function screen(fail = false) {
  const state = [], calls = [];
  let cursor = 0, mounted = false, refreshed = 0;
  const exports = {};
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }]; },
      useRef(value) { return { current: value }; },
      useEffect(effect) { if (!mounted) { mounted = true; effect(); } },
    },
    "react-native": { View: "View", Text: "Text", TextInput: "TextInput" },
    "./ConnectionStatus": { useSyncStatus: () => () => {} },
    "./ui": { Button: "Button", CardHeader: "CardHeader", useUi: () => ({ s: {} }), humanError: e => e.message },
    "./api": { ApiError, request: async (_connection, path, options) => {
      calls.push({ path, options });
      if (options?.method === "POST") { if (fail) throw new Error("回答未送达"); return {}; }
      return { items: [{ id: "q1", question: "交付格式？", options: ["PDF", "DOCX"] }] };
    } },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/QuestionCards.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: name => dependencies[name], AbortController, setInterval: () => 1, clearInterval() {} });
  function render() {
    cursor = 0;
    const nodes = [];
    const walk = node => { if (!node || typeof node !== "object") return; if (Array.isArray(node)) return node.forEach(walk); nodes.push(node); walk(node.props?.children); };
    walk(exports.QuestionCards({ connection: { url: "https://example.com", token: "test" }, runId: "r1", onChanged: () => { refreshed++; } }));
    return nodes;
  }
  render();
  return { render, calls, refreshed: () => refreshed };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("question choice is not sent until the user submits and custom text is accepted", async () => {
  const page = screen();
  await settle();
  assert.equal(page.calls.filter(c => c.options?.method === "POST").length, 0);
  page.render().find(n => n.props.children === "PDF").props.onPress();
  assert.equal(page.calls.filter(c => c.options?.method === "POST").length, 0);
  page.render().find(n => n.type === "TextInput").props.onChangeText("  请用 DOCX  ");
  page.render().find(n => n.props.children === "回答并继续").props.onPress();
  await settle();
  const sent = page.calls.find(c => c.options?.method === "POST");
  assert.equal(sent.path, "/input-requests/q1/answer");
  assert.equal(sent.options.body.answer, "请用 DOCX");
  assert.equal(page.refreshed(), 1);
  assert.ok(!page.render().some(n => n.type === "TextInput"));
});

test("failed answer keeps the draft and does not claim the task resumed", async () => {
  const page = screen(true);
  await settle();
  page.render().find(n => n.type === "TextInput").props.onChangeText("PDF");
  page.render().find(n => n.props.children === "回答并继续").props.onPress();
  await settle();
  assert.equal(page.refreshed(), 0);
  assert.equal(page.render().find(n => n.type === "TextInput").props.value, "PDF");
  assert.ok(page.render().some(n => n.props.children === "回答未送达"));
});
