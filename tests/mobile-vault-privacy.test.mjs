import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const SENTINEL = "TEST_ONLY_NATIVE_PRIVACY_SECRET";
const settle = async () => { for (let index = 0; index < 3; index++) await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness(os = "android", behavior = {}) {
  const calls = [], guarded = new Set(); let switcher = false;
  async function native(action, key) {
    calls.push([action, key]);
    await behavior[action]?.(key);
    if (action === "prevent") guarded.add(key);
    if (action === "allow") guarded.delete(key);
    if (action === "blur") switcher = true;
    if (action === "unblur") switcher = false;
  }
  const dependencies = {
    "react-native": { Platform: { OS: os } },
    "expo-screen-capture": {
      preventScreenCaptureAsync: (key) => native("prevent", key),
      allowScreenCaptureAsync: (key) => native("allow", key),
      enableAppSwitcherProtectionAsync: () => native("blur"),
      disableAppSwitcherProtectionAsync: () => native("unblur"),
    },
  };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/vaultPrivacy.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Error, Promise, Set,
    require(name) { assert.ok(name in dependencies, `Unexpected privacy dependency: ${name}`); return dependencies[name]; },
  });
  return { ...exports, calls, behavior, guarded, get switcher() { return switcher; } };
}
async function rejectsSafely(action) {
  await assert.rejects(action, (error) => {
    assert.match(error.message, /密码库|隐私|保护/);
    assert.doesNotMatch(`${String(error)}\n${error.stack ?? ""}`, new RegExp(SENTINEL));
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("a delayed acquisition and release finish before a newer owner can acquire its guard", async () => {
  const pendingPrevent = deferred(), pendingAllow = deferred();
  const app = harness("android", { prevent: (key) => key === "old" ? pendingPrevent.promise : undefined, allow: (key) => key === "old" ? pendingAllow.promise : undefined });
  const first = app.acquireVaultPrivacy("old"), release = app.releaseVaultPrivacy("old"), next = app.acquireVaultPrivacy("new");
  await settle(); assert.deepEqual(app.calls, [["prevent", "old"]]);
  pendingPrevent.resolve(); await first; await settle();
  assert.deepEqual(app.calls, [["prevent", "old"], ["allow", "old"]]);
  assert.equal(app.guarded.has("new"), false);
  pendingAllow.resolve(); await Promise.all([release, next]);
  assert.deepEqual(app.calls, [["prevent", "old"], ["allow", "old"], ["prevent", "new"]]);
  assert.deepEqual([...app.guarded], ["new"]);
  await settle(); assert.deepEqual([...app.guarded], ["new"], "no late old cleanup can disable the newer owner");
});

test("iOS acquisition, old unmount and new acquisition keep the final switcher guard active", async () => {
  const pendingPrevent = deferred();
  const app = harness("ios", { prevent: (key) => key === "old" ? pendingPrevent.promise : undefined });
  const first = app.acquireVaultPrivacy("old"), release = app.releaseVaultPrivacy("old"), next = app.acquireVaultPrivacy("new");
  await settle(); assert.deepEqual(app.calls, [["prevent", "old"]]);
  pendingPrevent.resolve(); await Promise.all([first, release, next]);
  assert.deepEqual(app.calls, [["prevent", "old"], ["blur", undefined], ["allow", "old"], ["unblur", undefined], ["prevent", "new"], ["blur", undefined]]);
  assert.equal(app.switcher, true); assert.deepEqual([...app.guarded], ["new"]);
});

test("iOS multiple owners retain switcher privacy until the last owner releases", async () => {
  const app = harness("ios");
  await app.acquireVaultPrivacy("one"); await app.acquireVaultPrivacy("two");
  assert.equal(app.switcher, true); assert.equal(app.guarded.size, 2);
  await app.releaseVaultPrivacy("one");
  assert.equal(app.switcher, true); assert.deepEqual([...app.guarded], ["two"]);
  assert.equal(app.calls.some(([kind]) => kind === "unblur"), false);
  await app.releaseVaultPrivacy("unregistered");
  assert.equal(app.switcher, true); assert.equal(app.calls.some(([kind]) => kind === "unblur"), false);
  await app.releaseVaultPrivacy("two");
  assert.equal(app.switcher, false); assert.equal(app.guarded.size, 0);
  assert.equal(app.calls.filter(([kind]) => kind === "unblur").length, 1);
});

test("acquiring the same owner is idempotent and Android never calls the iOS-only switcher APIs", async () => {
  const app = harness();
  await app.acquireVaultPrivacy("one"); await app.acquireVaultPrivacy("one");
  assert.deepEqual(app.calls, [["prevent", "one"]]);
  await app.releaseVaultPrivacy("one");
  assert.deepEqual(app.calls, [["prevent", "one"], ["allow", "one"]]);
});

test("prevent failures reject with a safe message and do not poison a later acquisition retry", async () => {
  let fail = true;
  const app = harness("android", { prevent() { if (fail) throw new Error(SENTINEL); } });
  await rejectsSafely(app.acquireVaultPrivacy("owner"));
  assert.deepEqual(app.calls, [["prevent", "owner"], ["allow", "owner"]]);
  assert.equal(app.guarded.size, 0);
  fail = false; await app.acquireVaultPrivacy("owner");
  assert.deepEqual([...app.guarded], ["owner"]);
  assert.equal(app.calls.filter(([kind]) => kind === "prevent").length, 2);
});

test("iOS blur failures reject without becoming an acquired owner and can retry after cleanup", async () => {
  let fail = true;
  const app = harness("ios", { blur() { if (fail) throw new Error(SENTINEL); } });
  await rejectsSafely(app.acquireVaultPrivacy("owner"));
  assert.deepEqual(app.calls, [["prevent", "owner"], ["blur", undefined], ["allow", "owner"]]);
  assert.equal(app.guarded.size, 0);
  fail = false; await app.acquireVaultPrivacy("owner");
  assert.equal(app.switcher, true); assert.deepEqual([...app.guarded], ["owner"]);
});

test("a failed owner and rollback cannot leak native error content or remove another owner's iOS privacy", async () => {
  const app = harness("ios"); await app.acquireVaultPrivacy("existing");
  app.behavior.blur = () => { throw new Error(SENTINEL); };
  app.behavior.allow = (key) => { if (key === "failed") throw new Error(`${SENTINEL}:cleanup`); };
  await rejectsSafely(app.acquireVaultPrivacy("failed"));
  assert.equal(app.guarded.has("existing"), true); assert.equal(app.switcher, true);
  assert.equal(app.calls.some(([kind]) => kind === "unblur"), false);
  app.behavior.blur = undefined; app.behavior.allow = undefined;
  await app.acquireVaultPrivacy("failed"); await app.releaseVaultPrivacy("failed");
  assert.equal(app.switcher, true); assert.equal(app.guarded.has("existing"), true);
  await app.releaseVaultPrivacy("existing"); assert.equal(app.switcher, false);
});

test("release allow failures never expose native messages and the queue still allows a fresh guarded session", async () => {
  const app = harness(); await app.acquireVaultPrivacy("owner");
  app.behavior.allow = () => { throw new Error(SENTINEL); };
  await rejectsSafely(app.releaseVaultPrivacy("owner"));
  assert.equal(app.guarded.has("owner"), true);
  app.behavior.allow = undefined;
  await app.acquireVaultPrivacy("owner"); await app.releaseVaultPrivacy("owner");
  assert.equal(app.guarded.size, 0);
});

test("iOS switcher release failures have safe errors and never prevent a later guarded acquisition", async () => {
  const app = harness("ios"); await app.acquireVaultPrivacy("owner");
  app.behavior.unblur = () => { throw new Error(SENTINEL); };
  await rejectsSafely(app.releaseVaultPrivacy("owner"));
  assert.equal(app.switcher, true);
  app.behavior.unblur = undefined;
  await app.acquireVaultPrivacy("next"); assert.equal(app.switcher, true);
  await app.releaseVaultPrivacy("next"); assert.equal(app.switcher, false);
});
