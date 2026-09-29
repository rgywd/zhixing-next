import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

function loadUiModule(name, dependencies) {
  const exports = {};
  const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  return exports;
}

const theme = loadUiModule("theme.ts", {});
const ui = loadUiModule("ui.tsx", {
  "./theme": theme,
  "react/jsx-runtime": jsxRuntime,
  "react-native": { ScrollView: "ScrollView", Pressable: "Pressable", Text: "Text", View: "View", useWindowDimensions: () => ({ width: 320 }), StyleSheet: { create: (styles) => styles } },
  "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
});

test("shared page scrolling preserves caller behavior and only reserves tab space on main pages", () => {
  const onScroll = () => {};
  const main = ui.PageScrollView({ tabs: true, onScroll });
  const child = ui.PageScrollView({ keyboardShouldPersistTaps: "always", contentContainerStyle: { paddingBottom: 20 } });
  const style = (element) => Object.assign({}, ...element.props.contentContainerStyle.filter(Boolean));
  assert.equal(main.props.onScroll, onScroll);
  assert.equal(main.props.keyboardShouldPersistTaps, "handled");
  assert.equal(child.props.keyboardShouldPersistTaps, "always");
  assert.ok(style(main).paddingBottom > style(child).paddingBottom);
  assert.equal(style(child).paddingBottom, 20);
});

test("shared controls preserve action callbacks, disabled state and accessible names", () => {
  let calls = 0;
  const onPress = () => { calls += 1; };
  const button = ui.Button({ children: "保存", disabled: true, onPress });
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.accessibilityState.disabled, true);
  const row = ui.ActionRow({ icon: "folder-outline", title: "项目", onPress });
  const tile = ui.ServiceTile({ icon: "leaf-outline", title: "生活", description: "日常服务", onPress, accessibilityLabel: "打开生活" });
  assert.equal(row.props.accessibilityRole, "button");
  assert.equal(row.props.accessibilityLabel, "项目");
  assert.equal(tile.props.accessibilityLabel, "打开生活");
  row.props.onPress();
  tile.props.onPress();
  assert.equal(calls, 2);
  assert.equal(ui.BackLink({ label: "工具箱", onPress }).props.accessibilityLabel, "返回工具箱");
  const icon = ui.IconAction({ icon: "refresh-outline", label: "刷新文件", disabled: true, onPress });
  assert.equal(icon.props.accessibilityLabel, "刷新文件");
  assert.equal(icon.props.accessibilityState.disabled, true);
  const link = ui.ActionLink({ icon: "add", children: "创建项目", onPress });
  assert.equal(link.props.accessibilityRole, "button");
  link.props.onPress();
  assert.equal(calls, 3);
});
