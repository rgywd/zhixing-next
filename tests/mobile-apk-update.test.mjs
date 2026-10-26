import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as updates from "../src/appUpdates.ts";

const code = ts.transpileModule(readFileSync(new URL("../src/apkUpdate.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
runInNewContext(code, { exports, AbortController, Error, Number, require(name) {
  assert.equal(name, "./appUpdates"); return updates;
} });
const { createApkUpdater, hasVerifiedApkMetadata } = exports;
const release = () => ({ version: "0.2.7", name: "知行", notes: "", url: `${updates.GITHUB_RELEASES_URL}/tag/v0.2.7`,
  apkUrl: `${updates.GITHUB_RELEASES_URL}/download/v0.2.7/zhixing-next-0.2.7-arm64.apk`, apkSha256: "a".repeat(64), apkSize: 100 });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(overrides = {}) {
  const events = [], states = [];
  const adapter = {
    async download(value, signal, progress) { events.push(["download", value.version]); progress(50, 100); return "file:///cache/zhixing-updates/download-fixture.apk"; },
    async remove(uri) { events.push(["remove", uri]); }, async canInstall() { events.push(["permission"]); return true; },
    async openSettings() { events.push(["settings"]); }, async install(uri, value) { events.push(["install", uri, value.apkSha256, value.apkSize, value.version]); }, ...overrides,
  };
  const updater = createApkUpdater(adapter, (state) => states.push(state));
  return { updater, adapter, events, states };
}

test("in-app download requires an official APK with exact size and SHA256 metadata", async () => {
  assert.equal(hasVerifiedApkMetadata(release()), true);
  for (const change of [{ apkUrl: "https://example.com/file.apk" }, { apkSha256: null }, { apkSha256: "md5:123" }, { apkSize: null }, { apkSize: 0 }, { apkSize: 1.5 }, { apkSize: 513 * 1024 * 1024 }]) {
    const value = { ...release(), ...change }, { updater, events, states } = setup();
    assert.equal(hasVerifiedApkMetadata(value), false);
    await updater.start(value); assert.equal(events.length, 0); assert.equal(states.at(-1).phase, "error");
  }
});

test("download progress leads to verified native handoff and never claims installation completed", async () => {
  const native = deferred(), { updater, events, states } = setup({ async install(...args) { events.push(["install", ...args]); await native.promise; } });
  const pending = updater.start(release());
  await new Promise(setImmediate);
  assert.equal(states.at(-1).phase, "verifying");
  assert.equal(events.some(([name]) => name === "remove"), false);
  assert.equal(await updater.cancel(), false);
  native.resolve(); await pending;
  assert.equal(states.at(-1).phase, "handed-off");
  assert.equal(events.at(-1)[0], "remove");
  assert.equal(events.filter(([name]) => name === "install").length, 1);
  assert.ok(states.some((state) => state.phase === "downloading" && state.written === 50));
  assert.equal(states.some((state) => state.phase === "installed"), false);
});

test("permission refusal retains the downloaded APK and retries without redownloading", async () => {
  let allowed = false;
  const { updater, events, states } = setup({ async canInstall() { return allowed; } });
  await updater.start(release()); assert.equal(states.at(-1).phase, "permission");
  assert.equal(events.some(([name]) => name === "install" || name === "remove"), false);
  await updater.openSettings(); assert.equal(events.at(-1)[0], "settings");
  await updater.install(); assert.equal(states.at(-1).phase, "permission");
  allowed = true; await updater.install();
  assert.equal(states.at(-1).phase, "handed-off");
  assert.equal(events.filter(([name]) => name === "download").length, 1);
  assert.equal(events.filter(([name]) => name === "install").length, 1);
});

test("cancel aborts the transfer; a late completion cannot install or overwrite a newer attempt", async () => {
  const old = deferred(); let oldProgress, signal, calls = 0;
  const { updater, events, states } = setup({ async download(value, selected, progress) {
    calls++; if (calls === 1) { signal = selected; oldProgress = progress; return old.promise; }
    return "file:///cache/zhixing-updates/download-new.apk";
  } });
  const pending = updater.start(release()); await updater.cancel(); assert.equal(signal.aborted, true);
  await updater.start(release()); assert.equal(states.at(-1).phase, "handed-off");
  oldProgress(99, 100); old.resolve("file:///cache/zhixing-updates/download-old.apk"); await pending;
  assert.equal(states.at(-1).phase, "handed-off");
  assert.equal(events.filter(([name]) => name === "install").length, 1);
  assert.ok(events.some(([name, uri]) => name === "remove" && uri.endsWith("download-old.apk")));
});

test("native hash, signature or package rejection cleans only the attempt and offers a fresh retry", async () => {
  let fail = true;
  const { updater, events, states } = setup({ async install() { if (fail) throw new Error("安装包签名不匹配，已停止安装。"); } });
  await updater.start(release()); assert.equal(states.at(-1).phase, "error"); assert.match(states.at(-1).message, /签名/);
  assert.equal(events.filter(([name]) => name === "remove").length, 1);
  fail = false; await updater.start(release()); assert.equal(states.at(-1).phase, "handed-off");
});

test("duplicate download and installation actions never open two installers", async () => {
  const download = deferred(); let count = 0;
  const { updater, events } = setup({ async download() { count++; return download.promise; } });
  const first = updater.start(release()); await updater.start(release());
  assert.equal(count, 1); download.resolve("file:///cache/zhixing-updates/download-only.apk"); await first;
  await updater.install(); assert.equal(events.filter(([name]) => name === "install").length, 1);
});

test("cancel from permission state clears the download and prevents later install", async () => {
  const { updater, events, states } = setup({ async canInstall() { return false; } });
  await updater.start(release()); assert.equal(states.at(-1).phase, "permission");
  assert.equal(await updater.cancel(), true); await updater.install();
  assert.equal(states.at(-1).phase, "cancelled");
  assert.equal(events.filter(([name]) => name === "remove").length, 1);
  assert.equal(events.some(([name]) => name === "install"), false);
});

test("late settings failure after cancellation cannot replace a new attempt", async () => {
  const settings = deferred(); let allowed = false;
  const { updater, states } = setup({ async canInstall() { return allowed; }, async openSettings() { await settings.promise; } });
  await updater.start(release());
  const opening = updater.openSettings(); await updater.cancel();
  allowed = true; await updater.start(release());
  settings.reject(new Error("late failure")); await opening;
  assert.equal(states.at(-1).phase, "handed-off");
});
