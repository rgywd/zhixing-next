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
let activeColors = theme.lightColors;
const ui = loadUiModule("ui.tsx", {
  "./theme": theme,
  "./ThemeProvider": { useTheme: () => ({ colors: activeColors, mode: activeColors === theme.darkColors ? "dark" : "light" }), useThemedStyles: (factory) => factory(activeColors) },
  "./AppearanceControl": { AppearanceControl: "AppearanceControl" },
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
  assert.equal(ui.BackLink({ label: "设置", onPress }).props.accessibilityLabel, "返回设置");
  const icon = ui.IconAction({ icon: "refresh-outline", label: "刷新文件", disabled: true, onPress });
  assert.equal(icon.props.accessibilityLabel, "刷新文件");
  assert.equal(icon.props.accessibilityState.disabled, true);
  const link = ui.ActionLink({ icon: "add", children: "创建项目", onPress });
  assert.equal(link.props.accessibilityRole, "button");
  link.props.onPress();
  assert.equal(calls, 3);
});


test("shared controls and surfaces change together without inverted button labels", () => {
  for (const palette of [theme.lightColors, theme.darkColors]) {
    activeColors = palette;
    const shared = ui.useUi();
    assert.equal(shared.s.root.backgroundColor, palette.paper);
    assert.equal(shared.s.input.backgroundColor, palette.surfaceRaised);
    assert.equal(shared.s.input.color, palette.ink);
    const group = ui.SettingsGroup({ title: "模型与服务", children: "rows" });
    assert.equal(group.props.children[1].props.style.backgroundColor, palette.surfaceRaised);
    assert.equal(group.props.children[0].props.style.color, palette.muted);
    const button = ui.Button({ children: "保存", onPress() {} });
    assert.equal(button.props.style({ pressed: false })[0].backgroundColor, palette.primary);
    const label = button.props.children.find((node) => node?.type === "Text");
    assert.equal(label.props.style[0].color, palette.onPrimary);
    assert.notEqual(label.props.style[0].color, palette.primary);
    assert.equal(ui.IconBadge({ name: "bulb", tone: "gold" }).props.children.props.color, palette.gold);
  }
  activeColors = theme.lightColors;
});

test("Markdown switches syntax highlighting as well as the surrounding reading surfaces", () => {
  const markdown = loadUiModule("MessageBody.tsx", {
    "react/jsx-runtime": jsxRuntime,
    "react-native": { Text: "Text" },
    "@ronradtke/react-native-markdown-display": { __esModule: true, default: "Markdown" },
    "./ThemeProvider": { useTheme: () => ({ mode: "dark" }), useThemedStyles: (factory) => factory(theme.darkColors) },
  });
  const body = markdown.MessageBody({ children: "```js\nconst value = 1;\n```" });
  assert.equal(body.props.colorScheme, "dark");
  assert.equal(body.props.style.fence_code.backgroundColor, theme.darkColors.surfaceRaised);
  assert.equal(body.props.style.fence_copy_text.color, theme.darkColors.muted);
  assert.equal(body.props.onLinkPress("https://example.com"), true);
  assert.equal(body.props.onLinkPress("javascript:alert(1)"), false);
});
