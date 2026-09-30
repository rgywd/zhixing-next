import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { darkColors, lightColors, layout, radius, space, typography } from "../src/theme.ts";

function screen() {
  const slots = [];
  const timers = new Map();
  const cleanup = [];
  let cursor = 0, mounted = false, timerId = 0;
  let colors = lightColors;
  const exports = {};
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      createContext: () => ({ Provider: "Provider" }),
      useContext: () => undefined,
      useState(initial) {
        const slot = cursor++;
        if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
        return [slots[slot], (next) => { slots[slot] = typeof next === "function" ? next(slots[slot]) : next; }];
      },
      useRef(initial) { const slot = cursor++; return slots[slot] ??= { current: initial }; },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useEffect(effect) { if (!mounted) cleanup.push(effect()); },
    },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: (styles) => styles, hairlineWidth: 0.5 } },
    "@react-native-vector-icons/ionicons": { Ionicons: "Ionicons" },
    "./ThemeProvider": { useTheme: () => ({ colors }), useThemedStyles: (factory) => factory(colors) },
    "./theme": { layout, radius, space, typography },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/Notice.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const child = { type: "Page", props: { draft: "unfinished" } };
  function render() { cursor = 0; const tree = exports.NoticeProvider({ children: child }); mounted = true; return tree; }
  const controls = render().props.value;
  function visible() { const overlay = render().props.children.props.children[1]; return overlay ? exports.FloatingNotice(overlay.props.children.props) : null; }
  return { exports, controls, render, visible, timers, child, cleanup: () => cleanup.forEach((fn) => fn?.()), theme: (value) => { colors = value; } };
}

test("persistent status survives a transient notice and keyed updates replace the old timer", () => {
  const page = screen();
  page.controls.show({ id: "sync", message: "offline", duration: null });
  assert.equal(page.timers.size, 0);
  page.controls.show({ id: "save", message: "saved" });
  assert.equal([...page.timers.values()][0].delay, 4000);
  page.controls.show({ id: "save", message: "saved again", duration: 1000 });
  assert.equal(page.timers.size, 1);
  assert.equal(page.visible().props.children[1].props.children, "saved again");
  [...page.timers.values()][0].fn();
  assert.equal(page.visible().props.children[1].props.children, "offline");
  page.controls.dismiss("sync");
  assert.equal(page.visible(), null);
});

test("notice arrival and dismissal preserve the page, with actions and accessible close controls", () => {
  const page = screen();
  let retried = 0;
  page.controls.show({ message: "offline", duration: null, action: { label: "Reconnect", icon: "refresh-outline", onPress: () => retried++ } });
  const root = page.render().props.children;
  assert.equal(root.props.children[0], page.child);
  assert.equal(root.props.children[1].props.style.position, "absolute");
  assert.equal(root.props.children[1].props.pointerEvents, "box-none");
  const notice = page.visible();
  notice.props.children[2].props.onPress();
  assert.equal(retried, 1);
  assert.equal(notice.props.children[3].props.accessibilityLabel, "关闭提示");
  notice.props.children[3].props.onPress();
  assert.equal(page.visible(), null);
  assert.equal(page.render().props.children.props.children[0], page.child);
  page.controls.show({ message: "uploading", dismissible: false });
  assert.equal(page.visible().props.children[3], null);
  page.cleanup();
  assert.equal(page.timers.size, 0);
});

test("notice text, surface and status icon follow both themes without limiting text wrapping", () => {
  const page = screen();
  for (const palette of [lightColors, darkColors]) {
    page.theme(palette);
    const notice = page.exports.FloatingNotice({ message: "sync unavailable", tone: "warning" });
    assert.equal(notice.props.style.backgroundColor, palette.surfaceRaised);
    assert.equal(notice.props.children[0].props.color, palette.amber);
    assert.equal(notice.props.children[1].props.style[1].color, palette.amber);
    assert.equal(notice.props.children[1].props.numberOfLines, undefined);
    assert.equal(notice.props.accessibilityLiveRegion, "polite");
  }
});
