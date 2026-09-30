import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import * as editing from "../src/providerEditing.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const provider = { id: "one", name: "百炼", protocol: "chat_completions", base_url: "https://example.com/v1", enabled: true, revision: 4, has_api_key: true, credential_source: "stored", models: [] };

function form(name, props) {
  const state = [];
  let cursor = 0;
  const exports = {};
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: { useState(initial) { const slot = cursor++; if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial; return [state[slot], (next) => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }]; } },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "./ModelPicker": { reasoningLabel: { auto: "自动", none: "关闭", low: "低", medium: "中", high: "高", xhigh: "极高" } },
    "./providerEditing": editing,
    "./ui": { useUi: () => ({ s: {}, colors: {} }), ActionLink: "ActionLink", Button: "Button", Field: "Field", SettingsGroup: "SettingsGroup", SwitchRow: "SwitchRow", humanError: (error) => error.message },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/ProviderForms.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, URL, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  function nodes() {
    cursor = 0;
    const result = [];
    function walk(node) {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      result.push(node); walk(node.props?.children);
    }
    walk(exports[name](props));
    return result;
  }
  return { nodes, field: (label) => nodes().find((item) => item.props.label === label), save: () => nodes().find((item) => item.type === "Button").props.onPress() };
}

test("provider blank key edits preserve credential and errors keep the unsubmitted replacement", async () => {
  const submitted = [];
  let failing = true;
  const page = form("ProviderForm", { provider, onSave: async (value) => { submitted.push(value); if (failing) throw new Error("保存失败"); } });
  page.field("替换 API 密钥").props.onChangeText("replacement");
  page.save(); await settle();
  assert.equal(page.field("替换 API 密钥").props.value, "replacement");
  assert.ok(page.nodes().some((node) => node.props.children === "保存失败"));
  failing = false;
  page.save(); await settle();
  assert.equal(page.field("替换 API 密钥").props.value, "");
  assert.equal(submitted[1].api_key, "replacement");
  page.field("供应商名称").props.onChangeText("新名称");
  page.save(); await settle();
  assert.equal(submitted[2].api_key, undefined);
  assert.equal(submitted[2].revision, 4);
});

test("explicit credential clear cannot submit a replacement key at the same time", async () => {
  let submitted;
  const page = form("ProviderForm", { provider, onSave: async (input) => { submitted = input; } });
  page.field("替换 API 密钥").props.onChangeText("discard-me");
  page.field("清除已保存密钥").props.onValueChange(true);
  page.save(); await settle();
  assert.equal(submitted.clear_api_key, true);
  assert.equal(submitted.api_key, undefined);
});

test("model editing preserves draft on failure and removes an unsupported default depth", async () => {
  const model = { model: "one", name: "One", enabled: true, image_input: false, reasoning_levels: ["high"], default_reasoning_effort: "high", temperature: null, timeout: 60, context_window: 32768 };
  let submitted;
  const page = form("ManagedModelForm", { protocol: "chat_completions", model, onSave: async (input) => { submitted = input; throw new Error("配置已更新"); } });
  page.nodes().find((item) => item.props.accessibilityLabel === "支持高思考").props.onPress();
  page.field("显示名称").props.onChangeText("自己的名字");
  page.save(); await settle();
  assert.equal(submitted.reasoning_effort, null);
  assert.equal(submitted.context_window, 32768);
  assert.equal(submitted.reasoning_levels.length, 0);
  assert.equal(page.field("显示名称").props.value, "自己的名字");
  assert.ok(page.nodes().some((item) => item.props.children === "配置已更新"));
});

test("provider addresses reject credential-bearing URLs and model search uses all keywords", () => {
  for (const url of ["http://public.example.com/v1", "https://key@example.com/v1", "https://example.com/?key=secret"]) {
    assert.throws(() => editing.providerInput(undefined, { name: "test", protocol: "responses", base_url: url, enabled: true }, "", false));
  }
  assert.equal(editing.matchesModel("  QWEN flash ", "Qwen 3.8", "qwen-flash"), true);
  assert.equal(editing.matchesModel("qwen flash", "qwen-max"), false);
  assert.equal(editing.modelInput().image_input, false);
  assert.equal(editing.modelInput().reasoning_levels.length, 0);
});

test("removed models and depths cannot stay in composer preferences", () => {
  const catalog = { roles: { chat: "new", task: "new" }, items: [{ id: "new", reasoning_levels: ["low"] }] };
  assert.deepEqual(editing.availablePreference(catalog, "chat", "deleted", "high"), { modelId: null, effort: null });
  assert.deepEqual(editing.availablePreference(catalog, "task", "new", "high"), { modelId: "new", effort: null });
  assert.deepEqual(editing.availablePreference(catalog, "chat", null, "low"), { modelId: null, effort: "low" });
});
