import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import {
  DevicePermissionError,
  locationText,
  oneLocationFix,
  requireDevicePermission,
  scheduleCalendarEvent,
} from "../src/deviceCapabilityLogic.ts";

const granted = { granted: true, canAskAgain: true, status: "granted" };
const denied = { granted: false, canAskAgain: true, status: "denied" };
const blocked = { granted: false, canAskAgain: false, status: "denied" };
const now = 1800000000000;
const fix = (changes = {}) => ({
  coords: { latitude: 31.2304, longitude: 121.4737, accuracy: 12 },
  timestamp: now,
  ...changes,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function locationWatch() {
  let onFix;
  let onError;
  let removed = 0;
  let watched = 0;
  return {
    watch: async (success, failure) => {
      watched++;
      onFix = success;
      onError = failure;
      return { remove: () => removed++ };
    },
    emit: (value) => onFix(value),
    fail: () => onError("native error"),
    get removed() { return removed; },
    get watched() { return watched; },
  };
}

test("device permission requests only follow an explicit retryable denial", async () => {
  let prompts = 0;
  const request = async () => { prompts++; return granted; };
  assert.equal(await requireDevicePermission("定位", async () => granted, request), granted);
  assert.equal(prompts, 0);
  assert.equal(await requireDevicePermission("定位", async () => denied, request), granted);
  assert.equal(prompts, 1);
  await assert.rejects(requireDevicePermission("定位", async () => blocked, request), (error) => {
    assert.ok(error instanceof DevicePermissionError);
    assert.equal(error.settings, "app");
    assert.match(error.message, /系统设置/);
    return true;
  });
  assert.equal(prompts, 1);
  await assert.rejects(requireDevicePermission("通知", async () => denied, async () => denied), (error) => {
    assert.ok(error instanceof DevicePermissionError);
    assert.match(error.message, /未允许通知/);
    return true;
  });
});

test("one-shot location ignores invalid and stale readings then stops at its first fresh fix", async () => {
  const watcher = locationWatch();
  const result = oneLocationFix(watcher.watch, new AbortController().signal, 20000, () => now);
  let completed = false;
  void result.then(() => completed = true);
  await flush();
  for (const value of [
    fix({ coords: { latitude: NaN, longitude: 121, accuracy: 1 } }),
    fix({ coords: { latitude: 91, longitude: 121, accuracy: 1 } }),
    fix({ coords: { latitude: 31, longitude: -181, accuracy: 1 } }),
    fix({ timestamp: NaN }),
    fix({ timestamp: now - 30001 }),
    fix({ timestamp: now + 30001 }),
  ]) watcher.emit(value);
  await flush();
  assert.equal(completed, false);
  assert.equal(watcher.removed, 0);
  const current = fix();
  watcher.emit(current);
  assert.equal(await result, current);
  assert.equal(watcher.removed, 1);
  watcher.emit(fix({ timestamp: now + 1 }));
  watcher.fail();
  assert.equal(watcher.removed, 1);
});

test("location timeout removes the registered watcher and returns a usable retry error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const watcher = locationWatch();
  const result = oneLocationFix(watcher.watch, new AbortController().signal, 20000, () => now);
  const rejected = assert.rejects(result, /信号较好的地方重试/);
  await flush();
  t.mock.timers.tick(19999);
  assert.equal(watcher.removed, 0);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(watcher.removed, 1);
});

test("cancelled location never starts a watcher or leaves a running watcher behind", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const unused = locationWatch();
  await assert.rejects(oneLocationFix(unused.watch, cancelled.signal), /已取消定位/);
  await flush();
  assert.equal(unused.watched, 0);

  const controller = new AbortController();
  const watcher = locationWatch();
  const result = oneLocationFix(watcher.watch, controller.signal, 20000, () => now);
  const rejected = assert.rejects(result, /已取消定位/);
  await flush();
  controller.abort();
  await rejected;
  assert.equal(watcher.removed, 1);
  watcher.emit(fix());
  assert.equal(watcher.removed, 1);
});

test("a watcher registration that finishes after cancellation is removed immediately", async () => {
  const registered = deferred();
  const controller = new AbortController();
  let removed = 0;
  const result = oneLocationFix(() => registered.promise, controller.signal, 20000, () => now);
  const rejected = assert.rejects(result, /已取消定位/);
  await flush();
  controller.abort();
  await rejected;
  registered.resolve({ remove: () => removed++ });
  await flush();
  assert.equal(removed, 1);
});

test("a fix arriving before native registration completes still releases the watcher", async () => {
  const registered = deferred();
  let removed = 0;
  const expected = fix();
  const result = oneLocationFix((onFix) => {
    onFix(expected);
    return registered.promise;
  }, new AbortController().signal, 20000, () => now);
  assert.equal(await result, expected);
  registered.resolve({ remove: () => removed++ });
  await flush();
  assert.equal(removed, 1);
});

test("native location failure and registration rejection settle once and clear work", async () => {
  const watcher = locationWatch();
  const result = oneLocationFix(watcher.watch, new AbortController().signal, 20000, () => now);
  const rejected = assert.rejects(result, /检查定位服务/);
  await flush();
  watcher.fail();
  await rejected;
  assert.equal(watcher.removed, 1);
  watcher.emit(fix());
  assert.equal(watcher.removed, 1);

  const registrationError = new Error("registration failed");
  await assert.rejects(oneLocationFix(async () => { throw registrationError; }, new AbortController().signal), (error) => error === registrationError);
});

test("location text discloses mock readings and never invents unknown accuracy", () => {
  assert.match(locationText(fix({ mocked: true })), /模拟位置/);
  assert.match(locationText(fix()), /纬度 31\.230400，经度 121\.473700/);
  assert.match(locationText(fix({ coords: { latitude: 31, longitude: 121, accuracy: 12.1 } })), /约 13 米/);
  for (const accuracy of [null, NaN, -1]) {
    const text = locationText(fix({ coords: { latitude: 31, longitude: 121, accuracy } }));
    assert.match(text, /精度未知/);
    assert.doesNotMatch(text, /约 .* 米/);
  }
  assert.doesNotMatch(locationText(fix()), /模拟位置/);
});

test("calendar export preserves the schedule instant without inventing duration or recurrence", () => {
  const schedule = {
    prompt: "  提醒我整理会议记录\n附上昨天的结论。  ",
    next_run_at: "2026-10-01T10:30:00+08:00",
    interval_seconds: 86400,
  };
  const before = structuredClone(schedule);
  const event = scheduleCalendarEvent(schedule);
  assert.equal(event.title, "提醒我整理会议记录");
  assert.equal(event.startDate.toISOString(), "2026-10-01T02:30:00.000Z");
  assert.equal(event.endDate.getTime(), event.startDate.getTime());
  assert.match(event.notes, /附上昨天的结论/);
  assert.match(event.notes, /重复规则请在系统日历中设置/);
  assert.equal(event.recurrenceRule, undefined);
  assert.deepEqual(schedule, before);
  const oneTime = scheduleCalendarEvent({ ...schedule, interval_seconds: null });
  assert.doesNotMatch(oneTime.notes, /重复规则/);
  assert.equal(oneTime.endDate.getTime(), oneTime.startDate.getTime());
});

test("calendar export rejects missing content and invalid time and keeps Unicode titles intact", () => {
  const schedule = { prompt: "安排会议", next_run_at: "2026-10-01T02:30:00Z", interval_seconds: null };
  assert.throws(() => scheduleCalendarEvent({ ...schedule, next_run_at: "not a date" }), /计划时间无效/);
  assert.throws(() => scheduleCalendarEvent({ ...schedule, prompt: " \n\t " }), /计划内容为空/);
  assert.equal(scheduleCalendarEvent({ ...schedule, prompt: "📅".repeat(61) }).title, "📅".repeat(60));
});

function nativeCapabilities({ permission = granted, afterRequest = granted, importance = 3, servicesEnabled = true, os = "android", readLocationPermission, requestLocationPermission, watchPosition, initialAppState = "active" } = {}) {
  const calls = [];
  let currentPermission = permission;
  const appListeners = new Set();
  const appState = {
    currentState: initialAppState,
    addEventListener: (_event, listener) => {
      appListeners.add(listener);
      return { remove: () => appListeners.delete(listener) };
    },
  };
  const notifications = {
    AndroidImportance: { NONE: 0, DEFAULT: 3 },
    getPermissionsAsync: async () => { calls.push("notification-check"); return currentPermission; },
    requestPermissionsAsync: async () => { calls.push("notification-prompt"); currentPermission = afterRequest; return currentPermission; },
    getNotificationChannelAsync: async () => { calls.push("channel-check"); return { importance }; },
    setNotificationChannelAsync: async () => { calls.push("channel-create"); },
    setNotificationHandler: () => { calls.push("notification-handler"); },
    scheduleNotificationAsync: async (body) => { calls.push({ notification: body }); return "notification-id"; },
  };
  const location = {
    Accuracy: { High: 4 },
    getForegroundPermissionsAsync: async () => { calls.push("location-check"); return readLocationPermission ? readLocationPermission() : currentPermission; },
    requestForegroundPermissionsAsync: async () => { calls.push("location-prompt"); currentPermission = requestLocationPermission ? await requestLocationPermission() : afterRequest; return currentPermission; },
    hasServicesEnabledAsync: async () => { calls.push("location-services"); return servicesEnabled; },
    watchPositionAsync: async (...args) => {
      calls.push("location-watch");
      if (watchPosition) return watchPosition(...args);
      assert.fail("no watcher expected in this scenario");
    },
  };
  const exported = {};
  const dependencies = {
    "react-native": { AppState: appState, Platform: { OS: os }, Linking: {} },
    "expo-location": location,
    "expo-notifications": notifications,
    "./deviceCapabilityLogic": { DevicePermissionError, oneLocationFix, requireDevicePermission },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/deviceCapabilities.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: exported,
    setTimeout,
    clearTimeout,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  return {
    calls, ...exported,
    setAppState: (state) => { appState.currentState = state; for (const listener of appListeners) listener(state); },
    get appListeners() { return appListeners.size; },
  };
}

test("reading native capability state never prompts or starts a location watcher", async () => {
  const device = nativeCapabilities({ permission: denied });
  assert.equal((await device.notificationState()).granted, false);
  assert.equal((await device.locationState()).granted, false);
  assert.equal(device.calls.some((call) => typeof call === "string" && /prompt|watch|create/.test(call)), false);
});

test("notification setup creates its Android channel before prompting and sends after permission", async () => {
  const device = nativeCapabilities({ permission: denied });
  assert.equal(await device.sendTestNotification(), "notification-id");
  assert.ok(device.calls.indexOf("channel-create") < device.calls.indexOf("notification-prompt"));
  const sent = device.calls.filter((call) => call.notification);
  assert.equal(sent.length, 1);
  assert.ok(device.calls.indexOf("notification-prompt") < device.calls.indexOf(sent[0]));
  assert.ok(sent[0].notification.content.title);
  assert.ok(sent[0].notification.content.body);
});

test("blocked Android permission or notification channel prevents delivery", async () => {
  const permissionBlocked = nativeCapabilities({ permission: blocked });
  await assert.rejects(permissionBlocked.sendTestNotification(), DevicePermissionError);
  assert.equal(permissionBlocked.calls.includes("notification-prompt"), false);
  assert.equal(permissionBlocked.calls.some((call) => call.notification), false);

  const channelBlocked = nativeCapabilities({ importance: 0 });
  await assert.rejects(channelBlocked.sendTestNotification(), (error) => error instanceof DevicePermissionError && /渠道已关闭/.test(error.message));
  assert.equal(channelBlocked.calls.some((call) => call.notification), false);

  const permissionDenied = nativeCapabilities({ permission: denied, afterRequest: denied });
  await assert.rejects(permissionDenied.sendTestNotification(), DevicePermissionError);
  assert.equal(permissionDenied.calls.some((call) => call.notification), false);
});

test("globally disabled Android notifications override a contradictory granted flag", async () => {
  const contradictory = { granted: true, canAskAgain: true, status: "denied" };
  const device = nativeCapabilities({ permission: contradictory });
  const state = await device.notificationState();
  assert.equal(state.granted, false);
  assert.equal(state.canAskAgain, false);
  await assert.rejects(device.sendTestNotification(), (error) => {
    assert.ok(error instanceof DevicePermissionError);
    assert.equal(error.settings, "app");
    assert.match(error.message, /系统设置/);
    return true;
  });
  assert.equal(device.calls.includes("notification-prompt"), false);
  assert.equal(device.calls.some((call) => call.notification), false);

  const prompted = nativeCapabilities({ permission: denied, afterRequest: contradictory });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(prompted.sendTestNotification(), (error) => error instanceof DevicePermissionError && /系统设置/.test(error.message));
  }
  assert.equal(prompted.calls.filter((call) => call === "notification-prompt").length, 1);
  assert.equal(prompted.calls.some((call) => call.notification), false);
});

test("location service denial and cancellation never leave a native watch running", async () => {
  const disabled = nativeCapabilities({ servicesEnabled: false });
  await assert.rejects(disabled.currentLocation(new AbortController().signal), (error) => {
    assert.ok(error instanceof DevicePermissionError);
    assert.equal(error.settings, "location");
    return true;
  });
  assert.equal(disabled.calls.includes("location-watch"), false);

  const cancelled = new AbortController();
  cancelled.abort();
  const device = nativeCapabilities({ permission: denied });
  await assert.rejects(device.currentLocation(cancelled.signal), /已取消定位/);
  assert.equal(device.calls.includes("location-prompt"), false);
  assert.equal(device.calls.includes("location-watch"), false);
});

test("cancelling while a location permission read is pending suppresses a later prompt", async () => {
  const permission = deferred();
  const controller = new AbortController();
  const device = nativeCapabilities({ readLocationPermission: () => permission.promise });
  const result = device.currentLocation(controller.signal);
  const rejected = assert.rejects(result, /已取消定位/);
  await flush();
  assert.equal(device.calls.includes("location-check"), true);
  controller.abort();
  permission.resolve(denied);
  await rejected;
  assert.equal(device.calls.includes("location-prompt"), false);
  assert.equal(device.calls.includes("location-watch"), false);
});

test("location permission dialog can pause the app and resumes watching only after active", async () => {
  const permission = deferred();
  const controller = new AbortController();
  let removed = 0;
  let watchStarted = 0;
  const expected = fix({ timestamp: Date.now() });
  const device = nativeCapabilities({
    permission: denied,
    requestLocationPermission: () => { device.setAppState("background"); return permission.promise; },
    watchPosition: (_options, onFix) => { onFix(expected); return { remove: () => removed++ }; },
  });
  const result = device.currentLocation(controller.signal, () => watchStarted++);
  await flush();
  assert.equal(device.calls.includes("location-prompt"), true);
  permission.resolve(granted);
  await flush();
  assert.equal(controller.signal.aborted, false);
  assert.equal(watchStarted, 0);
  assert.equal(device.calls.includes("location-watch"), false);
  device.setAppState("active");
  assert.equal(await result, expected);
  await flush();
  assert.equal(watchStarted, 1);
  assert.equal(removed, 1);
  assert.equal(device.appListeners, 0);
});

test("cancelling while location waits for active clears the listener without starting native work", async () => {
  const controller = new AbortController();
  const device = nativeCapabilities({ initialAppState: "background" });
  const result = device.currentLocation(controller.signal);
  const rejected = assert.rejects(result, /已取消定位/);
  await flush();
  controller.abort();
  await rejected;
  device.setAppState("active");
  await flush();
  assert.equal(device.calls.includes("location-watch"), false);
  assert.equal(device.appListeners, 0);
});

test("location cannot wait indefinitely for active and never starts a watcher after timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const device = nativeCapabilities({ initialAppState: "background" });
  const result = device.currentLocation(new AbortController().signal);
  const rejected = assert.rejects(result, /返回知行/);
  await flush();
  t.mock.timers.tick(20000);
  await rejected;
  device.setAppState("active");
  await flush();
  assert.equal(device.calls.includes("location-watch"), false);
  assert.equal(device.appListeners, 0);
});

test("Android-only capabilities reject other platforms before invoking native APIs", async () => {
  const device = nativeCapabilities({ os: "ios" });
  await assert.rejects(device.notificationState(), /仅支持安卓/);
  await assert.rejects(device.currentLocation(new AbortController().signal), /仅支持安卓/);
  assert.deepEqual(device.calls, []);
});

const walk = (node) => node?.props ? [node, ...[node.props.children].flat(Infinity).flatMap(walk)] : [];

function locationPanel() {
  const result = deferred();
  const notices = [];
  const states = [];
  const refs = [];
  const effects = [];
  let stateIndex = 0;
  let refIndex = 0;
  let mounted = false;
  let appListener;
  let requestSignal;
  let onWatchStart;
  const appState = {
    currentState: "active",
    addEventListener: (_event, listener) => { appListener = listener; return { remove() {} }; },
  };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState: (initial) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value) => states[index] = typeof value === "function" ? value(states[index]) : value];
      },
      useRef: (initial) => { const index = refIndex++; return refs[index] ??= { current: initial }; },
      useCallback: (callback) => callback,
      useEffect: (effect) => { if (!mounted) effects.push(effect); },
      useId: () => "location-panel-notice",
    },
    "react-native": { AppState: appState, Platform: { OS: "android" }, Text: "Text", View: "View" },
    "./deviceCapabilities": {
      notificationState: async () => granted,
      locationState: async () => ({ ...granted, servicesEnabled: true }),
      currentLocation: (signal, start) => { requestSignal = signal; onWatchStart = start; return result.promise; },
    },
    "./deviceCapabilityLogic": { DevicePermissionError, locationText },
    "./Notice": { useNotice: () => ({ show: (notice) => notices.push(notice), dismiss() {} }) },
    "./ui": {
      useUi: () => ({ s: {} }), humanError: String,
      ...Object.fromEntries(["ActionLink", "Button", "CardHeader", "PageHeading", "PageScrollView"].map((name) => [name, name])),
    },
  };
  const exported = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/DeviceCapabilitiesPanel.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports: exported, AbortController, require: (name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  const render = () => {
    stateIndex = 0; refIndex = 0;
    const nodes = walk(exported.DeviceCapabilitiesPanel({ onUseLocation() {} }));
    if (!mounted) { mounted = true; for (const effect of effects) effect(); }
    return nodes;
  };
  render();
  return {
    render, notices, resolve: result.resolve,
    startWatching: () => { assert.equal(typeof onWatchStart, "function"); onWatchStart(); },
    get signal() { return requestSignal; },
    active: () => { appState.currentState = "active"; appListener("active"); },
    background: (emit = true) => { appState.currentState = "background"; if (emit) appListener("background"); },
  };
}

test("a location completion racing cancellation or background never restores a usable location", async () => {
  for (const cancellation of ["cancel", "background", "background-before-event"]) {
    const panel = locationPanel();
    await flush();
    panel.render().find((node) => node.type === "Button" && node.props.children === "获取当前位置").props.onPress();
    const busy = panel.render();
    panel.resolve(fix());
    if (cancellation === "cancel") busy.find((node) => node.props.children === "取消定位").props.onPress();
    else panel.background(cancellation === "background");
    await flush();
    const after = panel.render();
    assert.equal(after.some((node) => node.props.children === "带入对话"), false, cancellation);
    assert.equal(panel.notices.some((notice) => notice.message === "已获取这一次位置。"), false, cancellation);
    assert.ok(panel.notices.some((notice) => /已取消定位/.test(notice.message)), cancellation);
  }
});

test("location permission dialog background keeps the request alive while real watch background cancels", async () => {
  const panel = locationPanel();
  await flush();
  panel.render().find((node) => node.type === "Button" && node.props.children === "获取当前位置").props.onPress();
  panel.background();
  assert.equal(panel.signal.aborted, false);
  panel.active();
  panel.startWatching();
  panel.background();
  assert.equal(panel.signal.aborted, true);
  panel.resolve(fix());
  await flush();
  assert.equal(panel.render().some((node) => node.props.children === "带入对话"), false);
  assert.equal(panel.notices.some((notice) => notice.message === "已获取这一次位置。"), false);
});
