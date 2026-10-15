import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness({ initial = null, read, save } = {}) {
  const slots = []; let cursor = 0, effects = [], stored = initial;
  const writes = [];
  const changed = (a, b) => !a || a.length !== b.length || b.some((v, i) => v !== a[i]);
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(callback, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { callback, deps }; return slots[i].callback; },
    useEffect(callback, deps) { const i = cursor++, old = slots[i]; if (changed(old?.deps, deps)) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = callback(); }); } },
  };
  const exports = {};
  const dependencies = { "react/jsx-runtime": jsxRuntime, react,
    "@react-native-async-storage/async-storage": { __esModule: true, default: {
      getItem: async () => read ? read() : stored,
      setItem: async (key, value) => { writes.push([key, value]); if (save) await save(value); stored = value; },
    } },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/chatPreferences.tsx", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: (name) => dependencies[name] });
  return { exports, writes, stored: () => stored,
    render() { cursor = 0; effects = []; const result = exports.ChatPreferencesProvider({ children: null }); effects.forEach((effect) => effect()); return result.props.value; },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test("chat preferences default only when missing and restore a saved steer mode", async () => {
  for (const [initial, expected] of [[null, "queue"], ["queue", "queue"], ["steer", "steer"]]) {
    const app = harness({ initial }); assert.equal(app.render().ready, false); await settle();
    const value = app.render(); assert.equal(value.ready, true); assert.equal(value.defaultIntent, expected);
    assert.deepEqual(app.writes, []); app.unmount();
  }
});

test("unreadable or unknown chat preferences stay locked without replacing the stored mode", async () => {
  for (const options of [{ initial: "unknown-format" }, { initial: "steer", read: async () => { throw new Error("storage unavailable"); } }]) {
    const app = harness(options); app.render(); await settle();
    const value = app.render(); assert.equal(value.ready, false); assert.match(value.error, /未能读取/);
    await value.setDefaultIntent("queue"); assert.deepEqual(app.writes, []); assert.equal(app.stored(), options.initial);
    app.unmount();
  }
});

test("retry can read the original preference after a transient storage failure", async () => {
  let failed = true;
  const app = harness({ initial: "steer", read: async () => { if (failed) throw new Error("not ready"); return "steer"; } });
  app.render(); await settle(); assert.equal(app.render().ready, false);
  failed = false; app.render().retry(); app.render(); await settle();
  assert.equal(app.render().defaultIntent, "steer"); assert.equal(app.render().ready, true); assert.equal(app.render().error, "");
  assert.deepEqual(app.writes, []); app.unmount();
});

test("saving holds the old selection until persisted and prevents overlapping writes", async () => {
  const save = deferred(), app = harness({ save: () => save.promise });
  app.render(); await settle(); const first = app.render(); const pending = first.setDefaultIntent("steer");
  assert.equal(app.render().saving, true); assert.equal(app.render().defaultIntent, "queue");
  await first.setDefaultIntent("steer"); assert.equal(app.writes.length, 1);
  save.resolve(); await pending;
  assert.equal(app.render().defaultIntent, "steer"); assert.equal(app.stored(), "steer"); assert.equal(app.render().saving, false);
  app.unmount();
});

test("failed preference writes keep the prior persisted and displayed behavior", async () => {
  const app = harness({ initial: "steer", save: async () => { throw new Error("disk full"); } });
  app.render(); await settle(); await assert.rejects(app.render().setDefaultIntent("queue"));
  const value = app.render(); assert.equal(value.defaultIntent, "steer"); assert.equal(value.ready, true); assert.equal(value.saving, false);
  assert.equal(app.stored(), "steer"); assert.match(value.error, /仍使用原来的/); app.unmount();
});

test("late preference reads never update an unmounted provider", async () => {
  const read = deferred(), app = harness({ read: () => read.promise });
  app.render(); app.unmount(); read.resolve("steer"); await settle();
  assert.equal(app.render().ready, false); assert.equal(app.render().defaultIntent, "queue"); assert.deepEqual(app.writes, []);
});
