import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { checkGitHubUpdate, compareVersions, GITHUB_LATEST_RELEASE_API, GITHUB_RELEASES_URL, isReleaseLink, readReleaseResponse } from "../src/appUpdates.ts";

const release = (version = "0.3.0", extras = {}) => ({ tag_name: `v${version}`, draft: false, prerelease: false,
  name: `知行 Next ${version}`, body: "修复与改进", html_url: `${GITHUB_RELEASES_URL}/tag/v${version}`,
  assets: [{ name: `zhixing-next-${version}-arm64.apk`, state: "uploaded", size: 42,
    browser_download_url: `${GITHUB_RELEASES_URL}/download/v${version}/zhixing-next-${version}-arm64.apk` }], ...extras });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("updates use SemVer precedence including numeric minor versions and prereleases", () => {
  for (const [a, b, comparison] of [["v0.10.0", "0.9.9", 1], ["1.0.0", "0.99.99", 1], ["0.2.2", "0.2.2", 0], ["0.2.1", "0.2.2", -1],
    ["1.0.0", "1.0.0-preview.1", 1], ["1.0.0-rc.10", "1.0.0-rc.2", 1], ["1.0.0-1", "1.0.0-alpha", -1], ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0+build.2", "1.0.0+build.1", 0], ["1.0.0-9999999999999999999", "1.0.0-9999999999999999998", 1]]) assert.equal(compareVersions(a, b), comparison, `${a} versus ${b}`);
  for (const invalid of ["01.2.3", "1.2", "1.2.3.4", "1.2.3-01", "1.2.3-", " 1.2.3", "1.2.3\n", "9007199254740992.0.0", "garbage"]) assert.equal(compareVersions(invalid, "1.0.0"), null, invalid);
});

test("only a newer stable release with a complete matching ARM64 APK offers an update", () => {
  const next = readReleaseResponse(release("0.10.0"), "0.9.0");
  assert.equal(next.kind, "available"); assert.match(next.release.apkUrl, /\/v0\.10\.0\/zhixing-next-0\.10\.0-arm64\.apk$/);
  for (const installed of ["0.3.0", "0.4.0"]) assert.equal(readReleaseResponse(release(), installed).kind, "current");
  assert.equal(readReleaseResponse(release("0.3.0"), "0.3.0-preview.1").kind, "available");
  for (const metadata of [{ draft: true }, { prerelease: true }, { tag_name: "v0.3.0-preview.1" }]) assert.equal(readReleaseResponse(release("0.3.0", metadata), "0.2.2").kind, "unpublished");
  for (const asset of [null, { state: "new" }, { size: 0 }, { name: "zhixing-next-0.3.0-x86_64.apk" }, { browser_download_url: "https://evil.example/download.apk" }, { browser_download_url: `${GITHUB_RELEASES_URL}/download/v0.2.9/zhixing-next-0.3.0-arm64.apk` }]) {
    const value = release(); value.assets = asset ? [{ ...value.assets[0], ...asset }] : [];
    const result = readReleaseResponse(value, "0.2.2"); assert.equal(result.kind, "pending"); assert.equal(result.release.apkUrl, null);
  }
});

test("malformed release information fails explicitly instead of claiming up to date", () => {
  for (const value of [null, [], {}, release("banana"), release("0.3.0", { draft: "false" }), release("0.3.0", { assets: null }),
    release("0.3.0", { html_url: "https://evil.example/releases/tag/v0.3.0" }), release("0.3.0", { html_url: `${GITHUB_RELEASES_URL}/tag/v0.2.9` })]) assert.throws(() => readReleaseResponse(value, "0.2.2"));
  assert.throws(() => readReleaseResponse(release(), "unknown"), /当前版本/);
  const bounded = readReleaseResponse(release("0.3.0", { body: "x".repeat(20000) }), "0.2.2"); assert.equal(bounded.release.notes.length, 12000);
});

test("release links are HTTPS and stay inside this repository's release paths", () => {
  for (const url of [GITHUB_RELEASES_URL, `${GITHUB_RELEASES_URL}/tag/v0.3.0`, release().assets[0].browser_download_url]) assert.equal(isReleaseLink(url), true);
  for (const url of ["http://github.com/rgywd/zhixing-next/releases", "https://github.com.evil.example/rgywd/zhixing-next/releases", "https://user:secret@github.com/rgywd/zhixing-next/releases", "https://github.com:8443/rgywd/zhixing-next/releases", "https://github.com/rgywd/other/releases", `${GITHUB_RELEASES_URL}/tag/v0.3.0?redirect=bad`, `${GITHUB_RELEASES_URL}/tag/v0.3.0#bad`, `${GITHUB_RELEASES_URL}/tag/%2e%2e`, `${GITHUB_RELEASES_URL}/download/v0.3.0/file.exe`, "file:///tmp/test.apk"]) assert.equal(isReleaseLink(url), false, url);
});

test("checking calls only the public latest release endpoint without service credentials", async () => {
  const calls = [];
  const result = await checkGitHubUpdate("0.2.2", undefined, async (...args) => { calls.push(args); return new Response(JSON.stringify(release())); });
  assert.equal(result.kind, "available"); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], GITHUB_LATEST_RELEASE_API); assert.deepEqual(calls[0][1].headers, { Accept: "application/vnd.github+json" });
  assert.equal(calls[0][1].credentials, "omit"); assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test("404 means no formal release; rate limits, HTTP, JSON and network errors remain errors", async () => {
  assert.deepEqual(await checkGitHubUpdate("0.2.2", undefined, async () => new Response("", { status: 404 })), { kind: "unpublished" });
  for (const code of [403, 429]) await assert.rejects(checkGitHubUpdate("0.2.2", undefined, async () => new Response("", { status: code })), /限制访问/);
  await assert.rejects(checkGitHubUpdate("0.2.2", undefined, async () => new Response("", { status: 500 })), /500/);
  await assert.rejects(checkGitHubUpdate("0.2.2", undefined, async () => new Response("invalid-json")), /未能获取/);
  await assert.rejects(checkGitHubUpdate("0.2.2", undefined, async () => { throw new TypeError("network failed"); }), /网络/);
});

test("aborting checks cancels the public request and ignores a late response", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(checkGitHubUpdate("0.2.2", controller.signal, async () => { calls++; }), { name: "AbortError" }); assert.equal(calls, 0);
  const active = new AbortController(), response = deferred(); let requestSignal;
  const checking = checkGitHubUpdate("0.2.2", active.signal, async (_url, options) => { requestSignal = options.signal; return response.promise; });
  active.abort(); assert.equal(requestSignal.aborted, true); response.resolve(new Response(JSON.stringify(release())));
  await assert.rejects(checking, { name: "AbortError" });
});

test("a 15 second timeout aborts the request and never accepts a late response as current", async () => {
  const exports = {}; let expire, cleared = false, signal;
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/appUpdates.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, URL, AbortController, Error, setTimeout(callback, duration) { assert.equal(duration, 15000); expire = callback; return 1; }, clearTimeout() { cleared = true; } });
  const response = deferred();
  const checking = exports.checkGitHubUpdate("0.2.2", undefined, async (_url, options) => { signal = options.signal; return response.promise; });
  expire(); assert.equal(signal.aborted, true);
  await assert.rejects(checking, /超时/); assert.equal(cleared, true);
  response.resolve(new Response(JSON.stringify(release("0.2.2"))));
});

test("a timeout while JSON is pending rejects immediately even when body parsing ignores abort", async () => {
  const exports = {}; let expire, cleared = false, signal;
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/appUpdates.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, URL, AbortController, Error, setTimeout(callback, duration) { assert.equal(duration, 15000); expire = callback; return 1; }, clearTimeout() { cleared = true; } });
  const payload = deferred(), parsing = deferred();
  const checking = exports.checkGitHubUpdate("0.2.2", undefined, async (_url, options) => { signal = options.signal; return { ok: true, status: 200, json() { parsing.resolve(); return payload.promise; } }; });
  await parsing.promise; expire(); assert.equal(signal.aborted, true);
  await assert.rejects(checking, /超时/); assert.equal(cleared, true);
  payload.resolve(release("0.2.2"));
});

function hookHarness({ read, open = async () => {} } = {}) {
  const slots = []; let cursor = 0, effects = [], writes = 0;
  const calls = [], opened = [];
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value) => { writes++; slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++; if (!slots[i]) { slots[i] = { deps }; effects.push(() => { slots[i].cleanup = effect(); }); } },
  };
  const exports = {};
  const dependencies = { react, "react-native": { Linking: { openURL: async (url) => { opened.push(url); await open(url); } } },
    "./appUpdates": { isReleaseLink, checkGitHubUpdate: async (version, signal) => { calls.push({ version, signal }); return read ? read(version, signal) : readReleaseResponse(release(), version); } } };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/useAppUpdate.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, AbortController, Error, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return { calls, opened, writes: () => writes, render() { cursor = 0; effects = []; const value = exports.useAppUpdate("0.2.2"); effects.forEach((effect) => effect()); return value; }, unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}

test("the update hook is manual, prevents double checks and retries a real failure", async () => {
  const response = deferred(); let failed = true;
  const app = hookHarness({ read: () => failed ? response.promise : readReleaseResponse(release(), "0.2.2") });
  assert.equal(app.render().state.status, "idle"); assert.equal(app.calls.length, 0);
  const value = app.render(), first = value.check(); await value.check();
  assert.equal(app.calls.length, 1); assert.equal(app.render().state.status, "checking"); assert.equal(app.render().visible, true);
  response.reject(new Error("网络不可用")); await first; assert.equal(app.render().state.status, "error");
  failed = false; await app.render().check(); assert.equal(app.render().state.result.kind, "available"); assert.equal(app.calls.length, 2); app.unmount();
});

test("closing or unmounting aborts checks and late responses never replace a newer result", async () => {
  const old = deferred(); let count = 0;
  const app = hookHarness({ read: () => ++count === 1 ? old.promise : readReleaseResponse(release("0.4.0"), "0.2.2") });
  const pending = app.render().check(); app.render().close(); assert.equal(app.calls[0].signal.aborted, true);
  await app.render().check(); old.resolve(readReleaseResponse(release("0.3.0"), "0.2.2")); await pending;
  assert.equal(app.render().state.result.release.version, "0.4.0");
  const last = deferred(), second = hookHarness({ read: () => last.promise });
  const active = second.render().check(); second.unmount(); const writes = second.writes(); assert.equal(second.calls[0].signal.aborted, true);
  last.resolve(readReleaseResponse(release(), "0.2.2")); await active; assert.equal(second.writes(), writes); app.unmount();
});

test("opening downloads is an explicit safe browser action and failures remain visible", async () => {
  const result = deferred(), app = hookHarness({ open: () => result.promise });
  const value = app.render(), url = release().assets[0].browser_download_url;
  const opening = value.openLink(url); await value.openLink(url); assert.equal(app.opened.length, 1); assert.equal(app.render().opening, true);
  result.reject(new Error("no browser")); await opening; assert.match(app.render().linkError, /未能打开浏览器/); assert.equal(app.render().opening, false);
  await app.render().openLink("https://evil.example/test.apk"); assert.equal(app.opened.length, 1); assert.match(app.render().linkError, /无效/);
  app.unmount();
});

test("a browser failure after the sheet closes cannot leak into the next check", async () => {
  const pending = deferred(), app = hookHarness({ open: () => pending.promise });
  const opening = app.render().openLink(GITHUB_RELEASES_URL); app.render().close(); await app.render().check();
  pending.reject(new Error("late failure")); await opening; assert.equal(app.render().linkError, ""); assert.equal(app.render().state.result.kind, "available"); app.unmount();
});

const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
function updateScreen(state, os = "android") {
  const calls = [], exports = {}, updater = { visible: true, state, opening: false, linkError: "", check() { calls.push("check"); }, close() { calls.push("close"); }, openLink(url) { calls.push(url); } };
  const dependencies = { "react/jsx-runtime": jsxRuntime, "react-native": { ActivityIndicator: "ActivityIndicator", Platform: { OS: os }, ScrollView: "ScrollView", Text: "Text", View: "View" },
    "../package.json": { version: "0.2.2" }, "./BottomSheet": { BottomSheet: "BottomSheet" }, "./appUpdates": { GITHUB_RELEASES_URL }, "./useAppUpdate": { useAppUpdate: () => updater },
    "./ui": { useUi: () => ({ s: {}, colors: {} }), ...Object.fromEntries(["ActionRow", "Button", "SettingsGroup"].map((key) => [key, key])) } };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/AppUpdateSettings.tsx", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return { calls, nodes: walk(exports.AppUpdateSettings()) };
}

test("settings results provide only relevant update and retry actions", () => {
  const checking = updateScreen({ status: "checking" });
  assert.equal(checking.nodes.find((node) => node.type === "ActionRow").props.disabled, true);
  assert.equal(checking.nodes.filter((node) => node.type === "Button").length, 0);
  const available = updateScreen({ status: "done", result: readReleaseResponse(release(), "0.2.2") });
  available.nodes.find((node) => node.type === "Button" && node.props.children === "下载 Android 安装包").props.onPress();
  assert.equal(available.calls[0], release().assets[0].browser_download_url);
  const ios = updateScreen({ status: "done", result: readReleaseResponse(release(), "0.2.2") }, "ios");
  assert.equal(ios.nodes.some((node) => node.type === "Button" && node.props.children === "下载 Android 安装包"), false);
  for (const state of [{ status: "error", error: "断网" }, { status: "done", result: { kind: "unpublished" } }, { status: "done", result: readReleaseResponse(release("0.3.0", { assets: [] }), "0.2.2") }]) {
    const page = updateScreen(state); assert.ok(page.nodes.find((node) => node.type === "Button" && node.props.children === "重新检查"));
    assert.equal(page.nodes.some((node) => node.type === "Button" && node.props.children === "下载 Android 安装包"), false);
  }
});

test("the update setting stays local and the displayed version matches native configuration", () => {
  const source = readFileSync(new URL("../src/SettingsHome.tsx", import.meta.url), "utf8");
  assert.match(source, /<AppUpdateSettings \/>/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")), app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, app.expo.version);
  assert.doesNotMatch(readFileSync(new URL("../src/appUpdates.ts", import.meta.url), "utf8"), /from ["']\.\/api/);
});
