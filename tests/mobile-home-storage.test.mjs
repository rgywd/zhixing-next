import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as homeEntries from "../src/homeEntries.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const target = (id, kind = "conversation") => ({ kind, id, title: `Title ${id}` });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ stored = null, read, write } = {}) {
  let cursor = 0;
  const slots = [], effects = [], reads = [], writes = [];
  const dependencies = {
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
        return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
      },
      useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
      useEffect(effect, deps) {
        const index = cursor++;
        if (!slots[index] || deps.some((value, i) => value !== slots[index].deps[i])) {
          const old = slots[index]; slots[index] = { deps };
          effects.push(() => { old?.cleanup?.(); slots[index].cleanup = effect(); });
        }
      },
    },
    "./homeEntries": homeEntries,
    "@react-native-async-storage/async-storage": { __esModule: true, default: {
      getItem: async (key) => { reads.push(key); return read ? read(key, reads.length) : stored; },
      setItem: async (key, value) => {
        writes.push({ key, value: JSON.parse(value) });
        if (write) await write(key, value, writes.length);
        stored = value;
      },
    } },
  };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/useHomePreferences.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return {
    render() { cursor = 0; const value = exports.useHomePreferences("https://assistant.example.test/service"); effects.splice(0).forEach((effect) => effect()); return value; },
    stored: () => stored === null ? null : JSON.parse(stored),
    reads, writes,
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test("failed initial home preference reads cannot overwrite saved pins and retry restores them before writes", async () => {
  const retryRead = deferred();
  const saved = { pins: [target("saved")], opened: {} };
  const app = harness({ stored: JSON.stringify(saved), read: async (_key, attempt) => {
    if (attempt === 1) throw new Error("temporary storage failure");
    return retryRead.promise;
  } });
  const loading = app.render();
  assert.equal(loading.ready, false);
  loading.toggle(target("too-early")); loading.opened(target("too-early"));
  await settle();
  let value = app.render();
  assert.equal(value.ready, false);
  assert.ok(value.error);
  value.toggle(target("blocked")); value.opened(target("blocked"));
  await settle();
  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.stored().pins, saved.pins);

  value.retry(); value = app.render();
  assert.equal(value.ready, false);
  assert.equal(app.reads.length, 2);
  value.opened(target("still-loading"));
  retryRead.resolve(JSON.stringify(saved)); await settle();
  value = app.render();
  assert.equal(value.ready, true);
  assert.equal(value.error, "");
  assert.deepEqual(value.preferences.pins.map((item) => item.id), ["saved"]);
  assert.equal(app.writes.length, 0);
  value.toggle(target("new")); await settle();
  assert.deepEqual(app.stored().pins.map((item) => item.id), ["saved", "new"]);
  app.unmount();
});

test("rapid home pin and open actions use the latest state and serialize slow storage writes", async () => {
  const firstWrite = deferred();
  const app = harness({ write: async (_key, _value, attempt) => { if (attempt === 1) await firstWrite.promise; } });
  app.render(); await settle();
  const value = app.render();
  value.toggle(target("first"));
  value.opened(target("visited", "project"));
  value.toggle(target("second"));
  value.toggle(target("first"));
  assert.deepEqual(app.render().preferences.pins.map((item) => item.id), ["second"]);
  assert.ok(app.render().preferences.opened["project:visited"]);
  await settle();
  assert.equal(app.writes.length, 1);
  assert.deepEqual(app.writes[0].value.pins.map((item) => item.id), ["first"]);

  firstWrite.resolve(); await settle();
  assert.equal(app.writes.length, 4);
  assert.deepEqual(app.writes.map(({ value }) => value.pins.map((item) => item.id)), [["first"], ["first"], ["first", "second"], ["second"]]);
  assert.ok(!app.writes[0].value.opened["project:visited"]);
  for (const { value: snapshot } of app.writes.slice(1)) assert.ok(snapshot.opened["project:visited"]);
  assert.deepEqual(app.stored().pins.map((item) => item.id), ["second"]);
  assert.ok(app.stored().opened["project:visited"]);
  assert.equal(new Set(app.writes.map((item) => item.key)).size, 1);
  app.unmount();
});

test("a failed home preference write retains local changes and a later action retries the complete state", async () => {
  const app = harness({ write: async (_key, _value, attempt) => { if (attempt === 1) throw new Error("write failure"); } });
  app.render(); await settle();
  app.render().toggle(target("keep")); await settle();
  let value = app.render();
  assert.ok(value.error);
  assert.deepEqual(value.preferences.pins.map((item) => item.id), ["keep"]);
  value.opened(target("recent")); await settle();
  value = app.render();
  assert.equal(value.error, "");
  assert.deepEqual(app.stored().pins.map((item) => item.id), ["keep"]);
  assert.ok(app.stored().opened["conversation:recent"]);
  app.unmount();
});
