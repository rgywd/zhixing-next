import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { checkGitHubUpdate, compareVersions, createAppUpdateChecker, GITHUB_LATEST_RELEASE_API, GITHUB_RELEASES_URL, GITHUB_UPDATE_MANIFEST, isReleaseLink, readReleaseResponse, UPDATE_API_TIMEOUT_MS, UPDATE_CACHE_KEY, UPDATE_CACHE_TTL_MS, UPDATE_MANIFEST_TIMEOUT_MS } from "../src/appUpdates.ts";

const release = (version = "0.3.0", extras = {}) => ({ tag_name: `v${version}`, draft: false, prerelease: false,
  name: `知行 Next ${version}`, body: "修复与改进", html_url: `${GITHUB_RELEASES_URL}/tag/v${version}`,
  assets: [{ name: `zhixing-next-${version}-arm64.apk`, state: "uploaded", size: 42,
    browser_download_url: `${GITHUB_RELEASES_URL}/download/v${version}/zhixing-next-${version}-arm64.apk`, digest: `sha256:${"ab".repeat(32)}` }], ...extras });
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
  assert.equal(next.release.apkSize, 42); assert.equal(next.release.apkSha256, "ab".repeat(32));
  for (const installed of ["0.3.0", "0.4.0"]) assert.equal(readReleaseResponse(release(), installed).kind, "current");
  assert.equal(readReleaseResponse(release("0.3.0"), "0.3.0-preview.1").kind, "available");
  for (const metadata of [{ draft: true }, { prerelease: true }, { tag_name: "v0.3.0-preview.1" }]) assert.equal(readReleaseResponse(release("0.3.0", metadata), "0.2.2").kind, "unpublished");
  for (const asset of [null, { state: "new" }, { size: 0 }, { name: "zhixing-next-0.3.0-x86_64.apk" }, { browser_download_url: "https://evil.example/download.apk" }, { browser_download_url: `${GITHUB_RELEASES_URL}/download/v0.2.9/zhixing-next-0.3.0-arm64.apk` }]) {
    const value = release(); value.assets = asset ? [{ ...value.assets[0], ...asset }] : [];
    const result = readReleaseResponse(value, "0.2.2"); assert.equal(result.kind, "pending"); assert.equal(result.release.apkUrl, null);
    assert.equal(result.release.apkSize, null); assert.equal(result.release.apkSha256, null);
  }
});

test("download integrity metadata comes only from the matching uploaded APK", () => {
  for (const digest of [undefined, null, "", "ab".repeat(32), `sha512:${"ab".repeat(32)}`, `sha256:${"ab".repeat(31)}`, `sha256:${"zz".repeat(32)}`, `sha256:${"ab".repeat(32)}\n`]) {
    const value = release(); value.assets[0].digest = digest;
    value.assets.push({ ...value.assets[0], name: "unrelated.apk", digest: `sha256:${"cd".repeat(32)}` });
    const result = readReleaseResponse(value, "0.2.2");
    assert.equal(result.kind, "available"); assert.equal(result.release.apkSha256, null); assert.equal(result.release.apkSize, 42);
  }
  const uppercase = release(); uppercase.assets[0].digest = `sha256:${"AB".repeat(32)}`;
  assert.equal(readReleaseResponse(uppercase, "0.2.2").release.apkSha256, "ab".repeat(32));
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

test("checking uses the official manifest first without consuming REST quota or sending credentials", async () => {
  const calls = [];
  const result = await checkGitHubUpdate("0.2.2", undefined, async (...args) => { calls.push(args); return new Response(JSON.stringify(release())); });
  assert.equal(result.kind, "available"); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], GITHUB_UPDATE_MANIFEST); assert.deepEqual(calls[0][1].headers, { Accept: "application/json" });
  assert.equal(calls[0][1].credentials, "omit"); assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test("manifest failures automatically fall back to the public API with explicit application headers", async () => {
  for (const failure of [403, 429, 500, 404, "network", "invalid-json", "invalid-release"]) {
    const calls = [];
    const result = await checkGitHubUpdate("0.2.2", undefined, async (url, options) => {
      calls.push([url, options]);
      if (url === GITHUB_LATEST_RELEASE_API) return new Response(JSON.stringify(release()));
      if (typeof failure === "number") return new Response("", { status: failure });
      if (failure === "network") throw new TypeError("offline");
      return new Response(failure === "invalid-json" ? "nope" : JSON.stringify(release("0.3.0", { html_url: "https://evil.example" })));
    });
    assert.equal(result.kind, "available"); assert.equal(calls.length, 2);
    assert.equal(calls[0][0], GITHUB_UPDATE_MANIFEST); assert.equal(calls[1][0], GITHUB_LATEST_RELEASE_API);
    assert.deepEqual(calls[1][1].headers, { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Zhixing-Next-App-Updates" });
    assert.equal(calls[1][1].credentials, "omit"); assert.equal("Authorization" in calls[1][1].headers, false);
  }
});

test("no release needs both official sources to agree; total failures do not claim current", async () => {
  assert.deepEqual(await checkGitHubUpdate("0.2.2", undefined, async () => new Response("", { status: 404 })), { kind: "unpublished" });
  for (const code of [403, 429]) await assert.rejects(checkGitHubUpdate("0.2.2", undefined, async () => new Response("", { status: code })), /拒绝访问|限制请求频率/);
  await assert.rejects(checkGitHubUpdate("0.2.2", undefined, async () => new Response("", { status: 500 })), /500/);
  await assert.rejects(checkGitHubUpdate("0.2.2", undefined, async () => new Response("invalid-json")), /未能获取/);
  await assert.rejects(checkGitHubUpdate("0.2.2", undefined, async () => { throw new TypeError("network failed"); }), /网络/);
  await assert.rejects(checkGitHubUpdate("0.2.2", undefined, async (url) => new Response("", { status: url === GITHUB_LATEST_RELEASE_API ? 403 : 404 })), /官方更新清单.*未找到[\s\S]*GitHub API.*拒绝访问/);
});

test("both source failures remain visible and HTTP403 alone is not called a rate limit", async () => {
  await assert.rejects(checkGitHubUpdate("0.2.2", undefined, async (url) => {
    if (url === GITHUB_UPDATE_MANIFEST) throw new TypeError("network failure");
    return new Response("", { status: 403, headers: { "x-ratelimit-remaining": "20" } });
  }), (error) => /官方更新清单.*网络/.test(error.message) && /GitHub API.*拒绝访问（403）/.test(error.message) && !/限制请求频率/.test(error.message));
  await assert.rejects(checkGitHubUpdate("0.2.2", undefined, async (url) => {
    if (url === GITHUB_UPDATE_MANIFEST) return new Response("not-json");
    return new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
  }), /官方更新清单.*未能获取[\s\S]*GitHub API.*限制请求频率/);
});

test("the fallback applies the same official release and APK validation", async () => {
  for (const extras of [{ html_url: "https://evil.example/releases" }, { assets: [] }, { assets: [{ ...release().assets[0], browser_download_url: "https://evil.example/app.apk" }] }]) {
    const fetcher = async (url) => url === GITHUB_UPDATE_MANIFEST ? new Response("", { status: 429 }) : new Response(JSON.stringify(release("0.3.0", extras)));
    if (extras.html_url) await assert.rejects(checkGitHubUpdate("0.2.2", undefined, fetcher));
    else { const result = await checkGitHubUpdate("0.2.2", undefined, fetcher); assert.equal(result.kind, "pending"); assert.equal(result.release.apkUrl, null); }
  }
});

test("aborting checks cancels requests, skips fallback and ignores late responses", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(checkGitHubUpdate("0.2.2", controller.signal, async () => { calls++; }), { name: "AbortError" }); assert.equal(calls, 0);
  const active = new AbortController(), response = deferred(); let requestSignal;
  const checking = checkGitHubUpdate("0.2.2", active.signal, async (_url, options) => { calls++; requestSignal = options.signal; return response.promise; });
  active.abort(); assert.equal(requestSignal.aborted, true);
  await assert.rejects(checking, { name: "AbortError" }); assert.equal(calls, 1);
  response.resolve(new Response(JSON.stringify(release())));
});

function timedUpdates() {
  const exports = {}, timers = [];
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/appUpdates.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, URL, AbortController, Error, setTimeout(callback, duration) { const timer = { callback, duration, cleared: false }; timers.push(timer); return timer; }, clearTimeout(timer) { timer.cleared = true; } });
  return { exports, timers };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("manifest timeout leaves a separate full deadline for a successful API fallback", async () => {
  const { exports, timers } = timedUpdates(), old = deferred(), calls = [];
  const checking = exports.checkGitHubUpdate("0.2.2", undefined, async (url, options) => {
    calls.push({ url, signal: options.signal });
    return url === GITHUB_UPDATE_MANIFEST ? old.promise : new Response(JSON.stringify(release()));
  });
  assert.equal(timers[0].duration, UPDATE_MANIFEST_TIMEOUT_MS); timers[0].callback(); await settle();
  assert.equal(calls[0].signal.aborted, true); assert.equal(timers[1].duration, UPDATE_API_TIMEOUT_MS);
  assert.equal((await checking).kind, "available"); assert.ok(timers.every((timer) => timer.cleared));
  old.resolve(new Response(JSON.stringify(release("0.2.2"))));
});

test("body parsing timeouts advance to fallback and reject after both independent deadlines", async () => {
  const { exports, timers } = timedUpdates(), bodies = [deferred(), deferred()], calls = [];
  const checking = exports.checkGitHubUpdate("0.2.2", undefined, async (url, options) => {
    const index = calls.length; calls.push({ url, signal: options.signal });
    return { ok: true, status: 200, json: () => bodies[index].promise };
  });
  await settle(); timers[0].callback(); await settle(); assert.equal(calls.length, 2);
  timers[1].callback(); await assert.rejects(checking, /超时/);
  assert.ok(calls.every((call) => call.signal.aborted)); assert.ok(timers.every((timer) => timer.cleared));
  bodies.forEach((body) => body.resolve(release("0.2.2")));
});

function updateStore(raw = null) {
  const entries = new Map(raw === null ? [] : [[UPDATE_CACHE_KEY, raw]]);
  return { entries, reads: 0, writes: 0, async getItem(key) { this.reads++; return entries.get(key) ?? null; }, async setItem(key, value) { this.writes++; entries.set(key, value); } };
}
const timeStart = 1_800_000_000_000;

test("successful checks persist only verified bounded public metadata and survive a restart offline", async () => {
  let now = timeStart, calls = 0; const store = updateStore();
  const first = createAppUpdateChecker(store, async () => { calls++; return new Response(JSON.stringify(release("0.3.0", { ignored_secret: "never-cache-this" }))); }, () => now);
  const live = await first.check("0.2.2"); assert.equal(live.source, "network"); assert.equal(live.cacheSaved, true);
  assert.equal(store.writes, 1); assert.doesNotMatch(store.entries.get(UPDATE_CACHE_KEY), /never-cache-this/);
  now += UPDATE_CACHE_TTL_MS + 1;
  const restarted = createAppUpdateChecker(store, async () => { calls++; throw new TypeError("offline"); }, () => now);
  const saved = await restarted.check("0.2.2"); assert.equal(saved.source, "cache"); assert.equal(saved.offline, true);
  assert.equal(saved.verifiedAt, timeStart); assert.equal(saved.result.release.apkUrl, release().assets[0].browser_download_url); assert.equal(calls, 3);
  assert.equal(saved.result.release.apkSize, 42); assert.equal(saved.result.release.apkSha256, "ab".repeat(32));
  assert.equal(JSON.parse(store.entries.get(UPDATE_CACHE_KEY)).release.assets[0].digest, `sha256:${"ab".repeat(32)}`);
  const upgraded = await restarted.check("0.3.0"); assert.equal(upgraded.result.kind, "current"); assert.equal(upgraded.source, "cache");
});

test("recent cache avoids repeated REST quota use; forced checks and expired TTL revalidate", async () => {
  let now = timeStart, calls = 0, version = "0.3.0"; const store = updateStore();
  const fetcher = async () => { calls++; return new Response(JSON.stringify(release(version))); };
  const checker = createAppUpdateChecker(store, fetcher, () => now);
  await checker.check("0.2.2"); now += 5000;
  const recent = await checker.check("0.2.2"); assert.equal(recent.source, "cache"); assert.equal(recent.offline, false); assert.equal(calls, 1);
  const restarted = createAppUpdateChecker(store, fetcher, () => now); await restarted.check("0.2.2"); assert.equal(calls, 1);
  version = "0.4.0"; const forced = await checker.check("0.2.2", undefined, true); assert.equal(forced.result.release.version, "0.4.0"); assert.equal(calls, 2);
  now += UPDATE_CACHE_TTL_MS + 1; await checker.check("0.2.2"); assert.equal(calls, 3);
});

test("API cooldown survives restart and forced checks still fetch the official manifest", async () => {
  let now = timeStart, manifestOnline = false; const calls = [], store = updateStore();
  const fetcher = async (url) => { calls.push(url);
    if (url === GITHUB_LATEST_RELEASE_API) return new Response("", { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((timeStart + 3_600_000) / 1000) } });
    if (!manifestOnline) throw new TypeError("manifest temporarily offline");
    return new Response(JSON.stringify(release())); };
  const first = createAppUpdateChecker(store, fetcher, () => now); await assert.rejects(first.check("0.2.2"), /限制请求频率/);
  manifestOnline = true;
  const restarted = createAppUpdateChecker(store, fetcher, () => now); await restarted.check("0.2.2", undefined, true);
  assert.deepEqual(calls, [GITHUB_UPDATE_MANIFEST, GITHUB_LATEST_RELEASE_API, GITHUB_UPDATE_MANIFEST]);
  now += 3_600_001; manifestOnline = false; await restarted.check("0.2.2", undefined, true);
  assert.equal(calls[4], GITHUB_LATEST_RELEASE_API);
});

test("first-install rate limits can recover after restart without a previously cached release", async () => {
  const store = updateStore(); let online = false; const calls = [];
  const fetcher = async (url) => { calls.push(url); if (url === GITHUB_LATEST_RELEASE_API) return new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }); if (!online) throw new Error("offline"); return new Response(JSON.stringify(release())); };
  await assert.rejects(createAppUpdateChecker(store, fetcher, () => timeStart).check("0.2.2"));
  online = true; const checked = await createAppUpdateChecker(store, fetcher, () => timeStart + 1).check("0.2.2");
  assert.equal(checked.result.kind, "available"); assert.deepEqual(calls, [GITHUB_UPDATE_MANIFEST, GITHUB_LATEST_RELEASE_API, GITHUB_UPDATE_MANIFEST]);
});

test("only actual rate limit evidence creates a persisted API cooldown", async () => {
  const message = JSON.stringify({ message: "You have exceeded a secondary rate limit. private-detail-never-display" });
  for (const response of [
    () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    () => new Response("", { status: 403, headers: { "retry-after": "120" } }),
    () => new Response("", { status: 429 }),
    () => new Response(message, { status: 403, headers: { "content-type": "application/json", "content-length": String(message.length) } }),
  ]) {
    const store = updateStore(), calls = [];
    const fetcher = async (url) => { calls.push(url); if (url === GITHUB_UPDATE_MANIFEST) throw new TypeError("offline"); return response(); };
    await assert.rejects(createAppUpdateChecker(store, fetcher, () => timeStart).check("0.2.2"), (error) => /限制请求频率/.test(error.message) && !/private-detail/.test(error.message));
    assert.ok(JSON.parse(store.entries.get(UPDATE_CACHE_KEY)).apiRetryAt > timeStart);
    await assert.rejects(createAppUpdateChecker(store, fetcher, () => timeStart + 1).check("0.2.2"), /官方更新清单.*网络[\s\S]*GitHub API.*冷却期/);
    assert.deepEqual(calls, [GITHUB_UPDATE_MANIFEST, GITHUB_LATEST_RELEASE_API, GITHUB_UPDATE_MANIFEST]);
  }
  const store = updateStore(), calls = [];
  const fetcher = async (url) => { calls.push(url); if (url === GITHUB_UPDATE_MANIFEST) throw new TypeError("offline");
    return new Response("", { status: 403, headers: { "x-ratelimit-remaining": "20", "retry-after": "invalid" } }); };
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(createAppUpdateChecker(store, fetcher, () => timeStart).check("0.2.2"), /拒绝访问（403）/);
  assert.equal(JSON.parse(store.entries.get(UPDATE_CACHE_KEY)).apiRetryAt, 0);
  assert.equal(calls.filter((url) => url === GITHUB_LATEST_RELEASE_API).length, 2);
});

test("older caches without a checksum remain readable without inventing download verification", async () => {
  const payload = release(); delete payload.assets[0].digest;
  const store = updateStore(JSON.stringify({ schema: 1, apiRetryAt: 0, verifiedAt: timeStart - 100, release: payload }));
  const checked = await createAppUpdateChecker(store, async () => { assert.fail("fresh cache should not fetch"); }, () => timeStart).check("0.2.2");
  assert.equal(checked.source, "cache"); assert.equal(checked.result.release.apkSize, 42);
  assert.equal(checked.result.release.apkSha256, null);
});

test("damaged, unsafe or future caches are ignored and valid network metadata replaces them", async () => {
  const record = (extras = {}) => JSON.stringify({ schema: 1, apiRetryAt: 0, verifiedAt: timeStart - 100, release: release(), ...extras });
  for (const raw of ["{", "[]", record({ schema: 2 }), record({ verifiedAt: timeStart + 100000 }), record({ verifiedAt: "yesterday" }), record({ release: release("0.3.0", { html_url: "https://evil.example" }) }), record({ release: release("0.3.0", { assets: [] }) })]) {
    let calls = 0;
    const checker = createAppUpdateChecker(updateStore(raw), async () => { calls++; return new Response(JSON.stringify(release("0.4.0"))); }, () => timeStart);
    const checked = await checker.check("0.2.2"); assert.equal(checked.source, "network"); assert.equal(checked.result.release.version, "0.4.0"); assert.equal(calls, 1);
  }
});

test("invalid network metadata never overwrites the last verified APK cache", async () => {
  const store = updateStore(); let valid = true;
  const checker = createAppUpdateChecker(store, async () => new Response(JSON.stringify(valid ? release() : release("0.4.0", { html_url: "https://evil.example" }))), () => timeStart);
  await checker.check("0.2.2"); const original = JSON.parse(store.entries.get(UPDATE_CACHE_KEY)); valid = false;
  const saved = await checker.check("0.2.2", undefined, true); assert.equal(saved.source, "cache"); assert.equal(saved.offline, true); assert.equal(saved.result.release.version, "0.3.0");
  assert.deepEqual(JSON.parse(store.entries.get(UPDATE_CACHE_KEY)).release, original.release);
});

test("duplicate incomplete assets cannot pollute an otherwise valid cached download", async () => {
  const store = updateStore(), payload = release(); payload.assets.unshift({ ...payload.assets[0], size: 0 });
  const checker = createAppUpdateChecker(store, async () => new Response(JSON.stringify(payload)), () => timeStart);
  await checker.check("0.2.2"); const cached = await checker.check("0.2.2");
  assert.equal(cached.result.kind, "available"); assert.equal(cached.source, "cache");
  assert.equal(JSON.parse(store.entries.get(UPDATE_CACHE_KEY)).release.assets[0].size, 42);
});

test("cache storage failures keep online updates usable", async () => {
  const store = { async getItem() { throw new Error("read failed"); }, async setItem() { throw new Error("write failed"); } };
  const checker = createAppUpdateChecker(store, async () => new Response(JSON.stringify(release())), () => timeStart);
  const checked = await checker.check("0.2.2");
  assert.equal(checked.result.kind, "available"); assert.equal(checked.cacheSaved, false);
  assert.equal((await checker.check("0.2.2")).cacheSaved, false);
});

test("concurrent checks share requests and cancelling one reader does not cancel the other", async () => {
  const response = deferred(), store = updateStore(); let calls = 0, requestSignal;
  const checker = createAppUpdateChecker(store, async (_url, options) => { calls++; requestSignal = options.signal; return response.promise; }, () => timeStart);
  const first = new AbortController(), second = new AbortController();
  const one = checker.check("0.2.2", first.signal), two = checker.check("0.2.2", second.signal);
  await settle(); first.abort(); await assert.rejects(one, { name: "AbortError" }); assert.equal(requestSignal.aborted, false); assert.equal(calls, 1);
  response.resolve(new Response(JSON.stringify(release()))); assert.equal((await two).result.kind, "available"); assert.equal(store.writes, 1);
});

test("cancelling all readers discards late checks and a new check proceeds independently", async () => {
  const old = deferred(), controller = new AbortController(), store = updateStore(); let count = 0;
  const checker = createAppUpdateChecker(store, async () => ++count === 1 ? old.promise : new Response(JSON.stringify(release("0.4.0"))), () => timeStart);
  const one = checker.check("0.2.2", controller.signal); await settle(); controller.abort(); await assert.rejects(one, { name: "AbortError" });
  const next = await checker.check("0.2.2"); old.resolve(new Response(JSON.stringify(release("0.3.0")))); await settle();
  assert.equal(next.result.release.version, "0.4.0"); assert.equal(JSON.parse(store.entries.get(UPDATE_CACHE_KEY)).release.tag_name, "v0.4.0"); assert.equal(store.writes, 1);
});

test("cancelling during cache loading makes no network request or stale UI update", async () => {
  const loading = deferred(), controller = new AbortController(); let calls = 0;
  const checker = createAppUpdateChecker({ getItem: () => loading.promise, async setItem() { assert.fail("cancelled check must not save"); } }, async () => { calls++; return new Response(JSON.stringify(release())); }, () => timeStart);
  const checking = checker.check("0.2.2", controller.signal); controller.abort(); await assert.rejects(checking, { name: "AbortError" });
  loading.resolve(null); await settle(); assert.equal(calls, 0);
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
  const dependencies = { react, "@react-native-async-storage/async-storage": { default: {} }, "react-native": { Linking: { openURL: async (url) => { opened.push(url); await open(url); } } },
    "./appUpdates": { isReleaseLink, createAppUpdateChecker: () => ({ check: async (version, signal, force) => { calls.push({ version, signal, force }); const result = read ? await read(version, signal) : readReleaseResponse(release(), version); return { result, verifiedAt: timeStart, source: "network", offline: false, cacheSaved: true }; } }) } };
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
function updateScreen(state, os = "android", apkState = { phase: "idle" }) {
  if (state.status === "done") state = { verifiedAt: timeStart, source: "network", offline: false, cacheSaved: true, ...state };
  const calls = [], exports = {}, updater = { visible: true, state, opening: false, linkError: "", check(force) { calls.push(force ? "force-check" : "check"); }, close() { calls.push("close"); }, openLink(url) { calls.push(url); } };
  const apk = { state: apkState, start(release) { calls.push({ action: "apk-start", release }); },
    cancel() { calls.push("cancel-apk"); }, install() { calls.push("apk-install"); }, openSettings() { calls.push("apk-settings"); } };
  const dependencies = { "react/jsx-runtime": jsxRuntime, "react-native": { ActivityIndicator: "ActivityIndicator", Platform: { OS: os }, ScrollView: "ScrollView", Text: "Text", View: "View" },
    "../package.json": { version: "0.2.2" }, "./BottomSheet": { BottomSheet: "BottomSheet" }, "./appUpdates": { GITHUB_RELEASES_URL }, "./useAppUpdate": { useAppUpdate: () => updater },
    "./apkUpdate": { hasVerifiedApkMetadata: (value) => value.apkSha256 === "ab".repeat(32) && value.apkSize === 42 }, "./useApkUpdate": { useApkUpdate: () => apk },
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
  available.nodes.find((node) => node.type === "Button" && node.props.children === "下载并安装更新").props.onPress();
  assert.equal(available.calls[0].action, "apk-start");
  assert.deepEqual(available.calls[0].release, readReleaseResponse(release(), "0.2.2").release);
  assert.equal(available.calls.some((call) => typeof call === "string" && call.endsWith(".apk")), false);
  available.nodes.find((node) => node.type === "Button" && node.props.children === "查看 GitHub 发布页").props.onPress();
  assert.equal(available.calls[1], release().html_url);
  const ios = updateScreen({ status: "done", result: readReleaseResponse(release(), "0.2.2") }, "ios");
  assert.equal(ios.nodes.some((node) => node.type === "Button" && node.props.children === "下载并安装更新"), false);
  const current = updateScreen({ status: "done", result: readReleaseResponse(release("0.2.2"), "0.2.2") });
  assert.ok(current.nodes.find((node) => node.type === "Button" && node.props.children === "重新下载安装当前版本"));
  current.nodes.find((node) => node.type === "Button" && node.props.children === "重新检查").props.onPress();
  assert.deepEqual(current.calls, ["cancel-apk", "force-check"]);
  for (const state of [{ status: "error", error: "断网" }, { status: "done", result: { kind: "unpublished" } }, { status: "done", result: readReleaseResponse(release("0.3.0", { assets: [] }), "0.2.2") }]) {
    const page = updateScreen(state); assert.ok(page.nodes.find((node) => node.type === "Button" && node.props.children === "重新检查"));
    assert.equal(page.nodes.some((node) => node.type === "Button" && /下载安装|下载并安装/.test(node.props.children)), false);
  }
});

test("settings show permission recovery and cancellable download progress without opening a browser", () => {
  const state = { status: "done", result: readReleaseResponse(release(), "0.2.2") };
  const permission = updateScreen(state, "android", { phase: "permission" });
  permission.nodes.find((node) => node.type === "Button" && node.props.children === "打开安装权限设置").props.onPress();
  permission.nodes.find((node) => node.type === "Button" && node.props.children === "继续安装").props.onPress();
  assert.deepEqual(permission.calls, ["apk-settings", "apk-install"]);
  assert.equal(permission.nodes.some((node) => node.type === "Button" && node.props.children === "下载并安装更新"), false);
  permission.nodes.find((node) => node.type === "BottomSheet").props.onClose();
  assert.deepEqual(permission.calls.slice(2), ["cancel-apk", "close"]);
  const downloading = updateScreen(state, "android", { phase: "downloading", written: 21, total: 42 });
  const progress = downloading.nodes.find((node) => node.type === "Text" && node.props.accessibilityRole === "progressbar");
  assert.equal(progress.props.accessibilityValue.now, 21); assert.equal(progress.props.accessibilityValue.max, 42);
  assert.equal(downloading.nodes.some((node) => node.type === "Button" && node.props.children === "重新检查"), false);
  downloading.nodes.find((node) => node.type === "Button" && node.props.children === "取消下载").props.onPress();
  assert.deepEqual(downloading.calls, ["cancel-apk"]);
});

test("settings prevent dismissal during verification and never claim installer handoff completed installation", () => {
  const state = { status: "done", result: readReleaseResponse(release(), "0.2.2") };
  const verifying = updateScreen(state, "android", { phase: "verifying" });
  assert.equal(verifying.nodes.some((node) => node.type === "Button" && /取消下载|继续安装|下载并安装|重新检查/.test(node.props.children)), false);
  verifying.nodes.find((node) => node.type === "BottomSheet").props.onClose(); assert.deepEqual(verifying.calls, []);
  const handedOff = updateScreen(state, "android", { phase: "handed-off" });
  const text = handedOff.nodes.filter((node) => node.type === "Text").map((node) => JSON.stringify(node.props.children)).join(" ");
  assert.match(text, /已交给 Android 系统/); assert.match(text, /确认安装/); assert.doesNotMatch(text, /安装成功|更新成功/);
  const noDigest = release(); delete noDigest.assets[0].digest;
  const unverified = updateScreen({ status: "done", result: readReleaseResponse(noDigest, "0.2.2") });
  assert.equal(unverified.nodes.some((node) => node.type === "Button" && node.props.children === "下载并安装更新"), false);
  assert.match(unverified.nodes.filter((node) => node.type === "Text").map((node) => JSON.stringify(node.props.children)).join(" "), /缺少.*校验信息/);
});

test("cached results expose the verified APK and timestamp without claiming to be live latest", () => {
  for (const offline of [false, true]) {
    const page = updateScreen({ status: "done", source: "cache", verifiedAt: timeStart, offline, result: readReleaseResponse(release("0.2.2"), "0.2.2") });
    assert.equal(page.nodes.find((node) => node.type === "BottomSheet").props.title, "已保存版本 0.2.2");
    const text = page.nodes.filter((node) => node.type === "Text").map((node) => JSON.stringify(node.props.children)).join(" ");
    assert.match(text, /核验时间/); assert.match(text, /本机缓存/); assert.doesNotMatch(text, /当前版本无需更新/);
    if (offline) assert.match(text, /可能已有新版本/);
    assert.ok(page.nodes.find((node) => node.type === "Button" && node.props.children === "重新下载安装当前版本"));
  }
});

test("the update setting stays local and the displayed version matches native configuration", () => {
  const source = readFileSync(new URL("../src/SettingsHome.tsx", import.meta.url), "utf8");
  assert.match(source, /<AppUpdateSettings \/>/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")), app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, app.expo.version);
  assert.doesNotMatch(readFileSync(new URL("../src/appUpdates.ts", import.meta.url), "utf8"), /from ["']\.\/api/);
});
