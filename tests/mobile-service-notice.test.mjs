import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { ApiError } from "../src/api.ts";
import * as health from "../src/syncHealth.ts";

function screen() {
  const slots = [], effects = [], shows = [], notices = new Map();
  let cursor = 0, now = 0;
  const controls = { show: (notice) => { shows.push(notice); notices.set(notice.id, notice); return notice.id; }, dismiss: (id) => notices.delete(id) };
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useId() { const index = cursor++; return slots[index] ??= `status-${index}`; },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        slots[index] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
    useMemo(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) slots[index] = { deps, value: callback() };
      return slots[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
  };
  const dependencies = { react, "react/jsx-runtime": jsxRuntime, "./api": { ApiError }, "./syncHealth": health, "./Notice": { useNotice: () => controls } };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/ConnectionStatus.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Date: { now: () => now }, setInterval: () => 1, clearInterval() {}, require: (name) => {
    assert.ok(name in dependencies, name); return dependencies[name];
  } });
  const render = (component, props) => { cursor = 0; const tree = component(props); effects.splice(0).forEach((effect) => effect()); return tree; };
  return { shows, notices, controls, exports, render, time: (value) => { now = value; }, close: () => { for (const id of notices.keys()) controls.dismiss(id); },
    unmount: () => slots.forEach((slot) => slot?.cleanup?.()) };
}
const online = { model_ready: true, worker_online: true };
const offline = { model_ready: true, worker_online: false };

test("execution service status floats without layout and does not return after closing identical polls", () => {
  const app = screen();
  assert.equal(app.render(app.exports.ServiceStatusNotice, { status: offline }), null);
  assert.equal(app.shows.length, 1); assert.equal(app.notices.size, 1);
  assert.equal(app.shows[0].duration, null);
  assert.doesNotMatch(app.shows[0].message, /worker/);
  for (let count = 0; count < 4; count++) app.render(app.exports.ServiceStatusNotice, { status: { ...offline } });
  assert.equal(app.shows.length, 1);
  app.close(); app.render(app.exports.ServiceStatusNotice, { status: { ...offline } });
  assert.equal(app.notices.size, 0); assert.equal(app.shows.length, 1);
  app.unmount();
});

test("service recovery removes its notice and a later outage is a new notice; unmount cleans up", () => {
  const app = screen();
  app.render(app.exports.ServiceStatusNotice, { status: offline });
  app.render(app.exports.ServiceStatusNotice, { status: online }); assert.equal(app.notices.size, 0);
  app.render(app.exports.ServiceStatusNotice, { status: offline }); assert.equal(app.shows.length, 2);
  app.unmount(); assert.equal(app.notices.size, 0);
});

test("missing model configuration updates the floating message once and healthy or unknown status clears it", () => {
  const app = screen();
  app.render(app.exports.ServiceStatusNotice, { status: null }); assert.equal(app.shows.length, 0);
  app.render(app.exports.ServiceStatusNotice, { status: { model_ready: false, worker_online: false } });
  assert.match(app.shows.at(-1).message, /模型尚未配置/);
  app.close(); app.render(app.exports.ServiceStatusNotice, { status: { model_ready: false, worker_online: true } });
  assert.equal(app.shows.length, 1); assert.equal(app.notices.size, 0);
  app.render(app.exports.ServiceStatusNotice, { status: offline });
  assert.equal(app.shows.length, 2); assert.match(app.shows.at(-1).message, /执行服务暂时离线/);
  app.render(app.exports.ServiceStatusNotice, { status: online }); assert.equal(app.notices.size, 0);
  app.render(app.exports.ServiceStatusNotice, { status: offline });
  app.render(app.exports.ServiceStatusNotice, { status: null }); assert.equal(app.notices.size, 0);
  app.unmount();
});

test("network polling notices also stay dismissed until recovery and a fresh failure period", () => {
  const app = screen(), render = () => app.render(app.exports.ConnectionStatusProvider, { children: "page" });
  const report = render().props.value.report;
  for (const time of [0, 10000, 20000]) { app.time(time); report("messages", new Error("offline")); render(); }
  assert.equal(app.shows.length, 1); app.close();
  app.time(30000); report("messages", new Error("offline")); render();
  assert.equal(app.notices.size, 0); assert.equal(app.shows.length, 1);
  report("messages"); render();
  for (const time of [40000, 50000, 60000]) { app.time(time); report("messages", new Error("offline")); render(); }
  assert.equal(app.notices.size, 1); assert.equal(app.shows.length, 2);
  app.unmount(); assert.equal(app.notices.size, 0);
});
