import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import * as theme from "../src/theme.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const source = ts.transpileModule(readFileSync(new URL("../src/ThemeProvider.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function harness({ stored = null, system = "light", read, write } = {}) {
  let cursor = 0;
  const slots = [], effects = [], calls = [];
  let override = "unspecified";
  const native = {
    useColorScheme: () => override === "unspecified" ? system : override,
    Appearance: { setColorScheme(value) { override = value; calls.push(value); } },
  };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      createContext: () => ({ Provider: "Provider" }),
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
        return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
      },
      useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
      useMemo(fn, deps) {
        const index = cursor++;
        if (!slots[index] || deps.some((d, i) => d !== slots[index].deps[i])) slots[index] = { value: fn(), deps };
        return slots[index].value;
      },
      useCallback(fn, deps) { return this.useMemo(fn, deps); },
      useEffect(fn, deps) {
        const index = cursor++;
        if (!slots[index] || deps.some((d, i) => d !== slots[index].deps[i])) {
          const old = slots[index]; slots[index] = { deps };
          effects.push(() => { old?.cleanup?.(); slots[index].cleanup = fn(); });
        }
      },
    },
    "react-native": native,
    "@react-native-async-storage/async-storage": { __esModule: true, default: {
      getItem: read ?? (async () => stored),
      setItem: write ?? (async (_key, value) => { stored = value; }),
    } },
    "expo-system-ui": { setBackgroundColorAsync: async () => {} },
    "./theme": theme,
  };
  const exports = {};
  // Hooks are invoked as named exports, without a receiver.
  dependencies.react.useCallback = (fn, deps) => dependencies.react.useMemo(() => fn, deps);
  runInNewContext(source, { exports, require: (name) => dependencies[name] });
  return {
    render() { cursor = 0; const tree = exports.ThemeProvider({ children: "screen" }); effects.splice(0).forEach((fn) => fn()); return tree.props.value; },
    system(value) { system = value; },
    stored: () => stored,
    calls,
  };
}

test("saved appearance restores, persists, and can return to live system changes", async () => {
  const app = harness({ stored: "dark", system: "light" });
  assert.equal(app.render().ready, false);
  await settle();
  let value = app.render();
  assert.equal(value.mode, "dark");
  assert.equal(value.ready, true);
  assert.equal(app.calls.at(-1), "dark");
  value.setPreference("system"); app.render();
  assert.equal(app.render().mode, "light");
  assert.equal(app.calls.at(-1), "unspecified");
  app.system("dark");
  assert.equal(app.render().mode, "dark");
  await settle();
  assert.equal(app.stored(), "system");
  value = app.render(); value.setPreference("light"); app.render();
  app.system("dark");
  assert.equal(app.render().mode, "light");
});

test("rapid selections save in order and late loading cannot overwrite an explicit choice", async () => {
  let finishRead, finishFirst;
  const writes = [];
  const app = harness({ read: () => new Promise((resolve) => { finishRead = resolve; }), write: async (_key, value) => {
    writes.push(value);
    if (writes.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
  } });
  const value = app.render();
  value.setPreference("dark"); value.setPreference("light");
  finishRead("dark"); await settle();
  assert.equal(app.render().mode, "light");
  assert.deepEqual(writes, ["dark"]);
  finishFirst(); await settle();
  assert.deepEqual(writes, ["dark", "light"]);
});

test("corrupt preferences and storage failures leave appearance usable", async () => {
  const fallback = harness({ stored: "invalid", system: "dark" });
  fallback.render(); await settle();
  assert.equal(fallback.render().preference, "system");
  assert.equal(fallback.render().mode, "dark");
  const app = harness({ read: async () => { throw Error("read"); }, write: async () => { throw Error("write"); } });
  app.render(); await settle();
  const value = app.render();
  assert.equal(value.ready, true);
  assert.ok(value.error);
  value.setPreference("dark"); await settle();
  assert.equal(app.render().mode, "dark");
  assert.match(app.render().error, /未能保存/);
});

function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }

test("both palettes keep reading text and filled controls at AA contrast", () => {
  for (const colors of [theme.lightColors, theme.darkColors]) {
    for (const foreground of ["ink", "muted", "accent", "gold", "blue", "red", "green", "khaki"]) {
      for (const background of ["paper", "surface", "surfaceRaised"]) {
        assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, `${foreground} on ${background}`);
      }
    }
    for (const [fg, bg] of [["onPrimary", "primary"], ["onInk", "ink"], ["gold", "goldSoft"], ["accent", "pale"], ["blue", "blueSoft"], ["green", "greenSoft"]]) {
      assert.ok(contrast(colors[fg], colors[bg]) >= 4.5, `${fg} on ${bg}`);
    }
  }
});
