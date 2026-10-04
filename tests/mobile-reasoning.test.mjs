import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import * as reasoning from "../src/reasoning.ts";

function renderPicker(model, selected, onSelect) {
  const exports = {};
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: { useState: (value) => [value, () => {}] },
    "react-native": { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View", StyleSheet: { create: (styles) => styles } },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./ui": { useUi: () => ({ s: {}, colors: {} }), humanError: (e) => e.message },
    "./ThemeProvider": { useThemedStyles: (factory) => factory({}) },
    "./theme": { radius: {}, space: {}, typography: {} },
    "./reasoning": reasoning,
    "./BottomSheet": { BottomSheet: "BottomSheet" },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/ReasoningPicker.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  const nodes = [];
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    nodes.push(node); walk(node.props?.children);
  }
  walk(exports.ReasoningPicker({ visible: true, model, selected, onSelect, onClose() {} }));
  return nodes;
}

test("binary models show enabled and disabled and submit the supported wire value", async () => {
  const model = { name: "GLM 4.7", reasoning_kind: "toggle", reasoning_levels: ["auto", "none", "high"], reasoning_labels: { high: "开启" }, default_reasoning_effort: null };
  let submitted;
  const nodes = renderPicker(model, "high", async (value) => { submitted = value; });
  const choices = nodes.filter((node) => node.props.accessibilityLabel?.startsWith("思考深度"));
  assert.deepEqual(choices.map((node) => node.props.accessibilityLabel), ["思考深度关闭", "思考深度开启"]);
  assert.equal(choices[1].props.accessibilityState.checked, true);
  assert.ok(nodes.some((node) => node.props.children === "开启模型思考"));
  choices[0].props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted, "none");
});

test("Gemini cannot offer off when absent from catalog and budgets are described honestly", () => {
  const model = { name: "Gemini Pro", reasoning_kind: "gemini_level", reasoning_levels: ["auto", "low", "high"], default_reasoning_effort: null };
  const nodes = renderPicker(model, "low", async () => {});
  assert.equal(nodes.some((node) => node.props.accessibilityLabel === "思考深度关闭"), false);
  assert.equal(reasoning.thinkingDescription({ reasoning_kind: "qwen_budget" }, "high"), "限制思考预算为 16,384 token");
  assert.match(reasoning.thinkingDescription(model, "minimal"), /不保证完全关闭/);
});

test("extended and legacy model catalogs retain readable effort labels", () => {
  assert.equal(reasoning.thinkingLabel(undefined, "max"), "最高");
  assert.equal(reasoning.thinkingLabel({ reasoning_levels: ["high"] }, "high"), "高");
});
