import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { oneLocationFix } from "../src/deviceCapabilityLogic.ts";

function load(file, dependencies) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, AbortController, Date, Set, Map, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (name) => { assert.ok(name in dependencies, name); const value = dependencies[name]; if (value instanceof Error) throw value; return value; } });
  return exports;
}
const flush = async () => { for (let n = 0; n < 5; n++) await new Promise((yes) => setImmediate(yes)); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const granted = { granted: true, canAskAgain: true };
const denied = { granted: false, canAskAgain: true };
const blocked = { granted: false, canAskAgain: false };
const baseNow = new Date(2026, 9, 15, 12).getTime();
const place = { label: "测试地区", latitude: 31, longitude: 121, accuracy: 14, timestamp: baseNow, mocked: false, networkAvailable: true };
const weather = { temperature: 20, condition: "晴", fetchedAt: baseNow };
const event = { id: "event1", title: "测试日程", startDate: new Date(baseNow).toISOString(), endDate: new Date(baseNow + 3600000).toISOString(), allDay: false, location: "" };

function calendarHarness({ os = "android", checked = true, requested = "granted", calendars = [], records = [] } = {}) {
  const calls = [];
  const calendar = {
    EntityTypes: { EVENT: "event" }, AttendeeStatus: { DECLINED: "declined" },
    getCalendars: async (type) => { calls.push(["calendars", type]); return calendars; },
    listEvents: async (...args) => { calls.push(["events", ...args]); return records; },
    getCalendarPermissions: async (...args) => { calls.push(["ios-check", ...args]); return { ...granted, status: "granted" }; },
    requestCalendarPermissions: async (...args) => { calls.push(["ios-request", ...args]); return { ...granted, status: "granted" }; },
  };
  const legacy = { openEventInCalendarAsync: async (...args) => { calls.push(["open", ...args]); } };
  const exports = load("todayCalendar", {
    "react-native": { Platform: { OS: os }, PermissionsAndroid: {
      PERMISSIONS: { READ_CALENDAR: "READ_CALENDAR" }, RESULTS: { GRANTED: "granted", NEVER_ASK_AGAIN: "never_ask_again" },
      check: async (...args) => { calls.push(["check", ...args]); return checked; },
      request: async (...args) => { calls.push(["request", ...args]); return requested; },
    } }, "expo-calendar": calendar, "expo-calendar/legacy": legacy,
  });
  return { ...exports, calls, calendar, legacy };
}
const calendarHelpers = calendarHarness();
function controllerHarness(overrides = {}, stored = null) {
  let now = baseNow;
  const calls = [];
  const deps = {
    now: () => now,
    getPreferences: async () => stored,
    setPreferences: async (value) => { calls.push(["save", value]); stored = value; },
    locationPermission: async (request) => { calls.push(["location-permission", request]); return granted; },
    calendarPermission: async (request) => { calls.push(["calendar-permission", request]); return granted; },
    readPlace: async (signal) => { calls.push(["location", signal]); return place; },
    readCalendar: async (time, signal) => { calls.push(["calendar", time, signal]); return [event]; },
    weather: async (value, signal) => { calls.push(["weather", value, signal]); return weather; },
    networkLocation: async () => { calls.push(["network"]); },
    openEvent: async (value) => { calls.push(["open", value]); },
    ...overrides,
  };
  const exports = load("useTodayDeviceContext", {
    react: {}, "react-native": {}, "@react-native-async-storage/async-storage": {},
    "./todayCalendar": calendarHelpers, "./todayLocation": {}, "./todayWeather": {},
  });
  const controller = new exports.TodayDeviceController(deps);
  return { controller, deps, calls, exports, time: (value) => { now = value; }, stored: () => stored,
    start: async () => { controller.setVisibility(true); await controller.initialize(); await flush(); } };
}
const enabled = JSON.stringify({ locationEnabled: true, calendarEnabled: true });

test("first Home visit reads switches without permission prompts, location, calendar, or network", async () => {
  const app = controllerHarness(); await app.start();
  assert.equal(app.controller.snapshot.preferencesReady, true);
  assert.equal(app.controller.snapshot.locationEnabled, false);
  assert.equal(app.controller.snapshot.calendarEnabled, false);
  assert.deepEqual(app.calls, []);
});

test("switch parser accepts only booleans and never returns persisted coordinates or appointments", () => {
  const { exports } = controllerHarness();
  const value = exports.parseTodayPreferences('{"locationEnabled":true,"calendarEnabled":false,"latitude":31,"events":["private"]}');
  assert.equal(JSON.stringify(value), '{"locationEnabled":true,"calendarEnabled":false}');
  for (const bad of ["{}", "[]", "null", '{"locationEnabled":"true","calendarEnabled":false}']) assert.throws(() => exports.parseTodayPreferences(bad));
});

test("location and calendar opt in separately, only booleans are stored, disable removes private data", async () => {
  const app = controllerHarness(); await app.start(); await app.controller.enableLocation();
  assert.equal(app.controller.snapshot.locationState, "ready");
  assert.equal(app.calls.filter(([name]) => name === "calendar").length, 0);
  assert.deepEqual(JSON.parse(app.stored()), { locationEnabled: true, calendarEnabled: false });
  await app.controller.enableCalendar();
  assert.equal(app.controller.snapshot.events.length, 1);
  app.controller.disableLocation(); app.controller.disableCalendar(); await flush();
  assert.equal(app.controller.snapshot.place, null); assert.equal(app.controller.snapshot.weather, null);
  assert.equal(app.controller.snapshot.events.length, 0);
  assert.deepEqual(JSON.parse(app.stored()), { locationEnabled: false, calendarEnabled: false });
  for (const [, value] of app.calls.filter(([name]) => name === "save")) assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ["calendarEnabled", "locationEnabled"]);
});

test("reentry and foreground obey weather 15 minute/calendar 1 minute throttles and never reprompt", async () => {
  const app = controllerHarness({}, enabled); await app.start();
  const count = (name) => app.calls.filter(([value]) => name === value).length;
  assert.equal(count("location"), 1); assert.equal(count("calendar"), 1);
  app.controller.setVisibility(false); app.controller.setVisibility(true); await flush();
  assert.equal(count("location"), 1); assert.equal(count("calendar"), 1);
  app.time(baseNow + 60000); app.controller.setForeground(false); app.controller.setForeground(true); await flush();
  assert.equal(count("location"), 1); assert.equal(count("calendar"), 2);
  app.time(baseNow + 900000); app.controller.tick(); await flush();
  assert.equal(count("location"), 2); assert.equal(count("calendar"), 3);
  assert.ok(app.calls.filter(([name]) => name.endsWith("permission")).every(([, request]) => request === false));
});

test("permission revocation within throttle clears coordinates, weather and events immediately", async () => {
  const app = controllerHarness({}, enabled); await app.start();
  app.deps.locationPermission = async () => blocked; app.deps.calendarPermission = async () => denied;
  app.controller.tick(); await flush();
  const value = app.controller.snapshot;
  assert.equal(value.place, null); assert.equal(value.weather, null); assert.equal(value.events.length, 0);
  assert.equal(value.locationState, "blocked"); assert.equal(value.calendarState, "denied");
});

test("explicit denial/never ask again is represented without making data requests", async () => {
  const app = controllerHarness({ locationPermission: async () => blocked, calendarPermission: async () => denied }); await app.start();
  await app.controller.enableLocation(); await app.controller.enableCalendar();
  assert.equal(app.controller.snapshot.locationState, "blocked"); assert.match(app.controller.snapshot.locationError, /系统设置/);
  assert.equal(app.controller.snapshot.calendarState, "denied");
  assert.equal(app.calls.filter(([name]) => ["location", "calendar", "weather"].includes(name)).length, 0);
});

test("leaving Home aborts GPS and ignores a late fix; background aborts weather and ignores its late response", async () => {
  const latePlace = deferred(); let gpsSignal;
  const app = controllerHarness({ readPlace: (signal) => { gpsSignal = signal; return latePlace.promise; } }, enabled); await app.start();
  app.controller.setVisibility(false); assert.equal(gpsSignal.aborted, true);
  latePlace.resolve(place); await flush();
  assert.equal(app.controller.snapshot.place, null); assert.equal(app.calls.filter(([name]) => name === "weather").length, 0);
  const lateWeather = deferred(); let weatherSignal;
  app.deps.readPlace = async () => place;
  app.deps.weather = (_value, signal) => { weatherSignal = signal; return lateWeather.promise; };
  app.controller.setVisibility(true); await flush();
  app.controller.setForeground(false); assert.equal(weatherSignal.aborted, true);
  lateWeather.resolve(weather); await flush();
  assert.equal(app.controller.snapshot.weather, null);
});

test("disabled calendar and unmounted controller cannot accept late native events or preferences", async () => {
  const pending = deferred(); let calendarSignal;
  const app = controllerHarness({ readCalendar: (_now, signal) => { calendarSignal = signal; return pending.promise; } }, enabled); await app.start();
  app.controller.disableCalendar(); assert.equal(calendarSignal.aborted, true);
  pending.resolve([event]); await flush(); assert.equal(app.controller.snapshot.events.length, 0);
  const read = deferred(); const gone = controllerHarness({ getPreferences: () => read.promise });
  const task = gone.controller.initialize(); gone.controller.dispose(); read.resolve(enabled); await task;
  assert.equal(gone.controller.snapshot.preferencesReady, false);
});

test("minute tick updates clock and midnight refreshes even within normal calendar throttle", async () => {
  const app = controllerHarness({}, enabled);
  const before = new Date(2026, 9, 15, 23, 59, 50).getTime(); app.time(before); await app.start();
  const after = before + 20000; app.time(after); app.controller.tick(); await flush();
  assert.equal(app.controller.snapshot.now, after);
  assert.equal(app.calls.filter(([name]) => name === "calendar").length, 2);
});

test("calendar response crossing midnight is dropped rather than labelled today", async () => {
  const result = deferred(); const app = controllerHarness({ readCalendar: () => result.promise }, enabled);
  const before = new Date(2026, 9, 15, 23, 59, 50).getTime(); app.time(before); await app.start();
  app.time(before + 20000); result.resolve([event]); await flush();
  assert.equal(app.controller.snapshot.events.length, 0); assert.equal(app.controller.snapshot.calendarState, "idle");
});

test("storage failure blocks implicit capability access and supports retry without overwriting old values", async () => {
  let fail = true; const app = controllerHarness({ getPreferences: async () => { if (fail) throw new Error("disk"); return enabled; } });
  await app.start(); assert.equal(app.controller.snapshot.preferencesReady, false); assert.match(app.controller.snapshot.preferenceError, /读取/);
  await app.controller.enableLocation(); assert.deepEqual(app.calls, []);
  fail = false; app.controller.retryPreferences(); await flush(); assert.equal(app.controller.snapshot.preferencesReady, true);
  assert.equal(app.calls.some(([name]) => name === "save"), false);
});

test("failed switch save stays actionable and retry serializes the latest booleans", async () => {
  let fail = true; const values = [];
  const app = controllerHarness({ setPreferences: async (value) => { if (fail) throw new Error("disk"); values.push(value); } });
  await app.start(); await app.controller.enableLocation(); assert.match(app.controller.snapshot.preferenceError, /保存/);
  app.controller.disableLocation(); fail = false; app.controller.retryPreferences(); await flush();
  assert.equal(app.controller.snapshot.preferenceError, "");
  assert.equal(values.at(-1), '{"locationEnabled":false,"calendarEnabled":false}');
});

test("optional network accuracy denial keeps pure GPS and never marks WiFi positioning successful", async () => {
  const app = controllerHarness({ networkLocation: async () => { throw new Error("denied"); } }, enabled); await app.start();
  await app.controller.enableNetworkLocation();
  assert.equal(app.controller.snapshot.locationState, "ready"); assert.equal(app.controller.snapshot.place, place);
  assert.match(app.controller.snapshot.locationError, /仍可尝试 GPS/); assert.doesNotMatch(app.controller.snapshot.locationError, /成功/);
});

test("open event accepts only a currently displayed authorized event and never writes appointments", async () => {
  const app = controllerHarness({}, enabled); await app.start();
  await app.controller.openEvent({ ...event, id: "unlisted" }); assert.equal(app.calls.filter(([name]) => name === "open").length, 0);
  await app.controller.openEvent(event); assert.equal(app.calls.filter(([name]) => name === "open").length, 1);
  app.deps.calendarPermission = async () => denied; await app.controller.openEvent(event);
  assert.equal(app.calls.filter(([name]) => name === "open").length, 1); assert.equal(app.controller.snapshot.events.length, 0);
});

test("Android calendar permission reads/requests only READ_CALENDAR, including permanent denial", async () => {
  const app = calendarHarness({ checked: false, requested: "never_ask_again" });
  assert.equal((await app.todayCalendarPermission()).granted, false);
  assert.equal(app.calls.filter(([name]) => name === "request").length, 0);
  const result = await app.todayCalendarPermission(true);
  assert.equal(result.canAskAgain, false);
  assert.ok(app.calls.every(([, permission]) => permission === "READ_CALENDAR"));
});

test("iOS uses SDK57 full-access calendar check/request rather than deprecated Async APIs", async () => {
  const app = calendarHarness({ os: "ios" }); await app.todayCalendarPermission(); await app.todayCalendarPermission(true);
  assert.deepEqual(app.calls, [["ios-check", false], ["ios-request", false]]);
});

test("today events include ongoing/multiday/all-day and zero-duration, excluding midnight boundaries and cancellations", () => {
  const app = calendarHarness(); const { start, end } = app.todayWindow(baseNow);
  const record = (id, from, to, changes = {}) => ({ id, title: id, startDate: new Date(from), endDate: new Date(to), allDay: false, ...changes });
  const records = [record("ongoing", baseNow - 3600000, baseNow + 3600000), record("multiday", start.getTime() - 86400000, end.getTime() + 86400000),
    record("all-day", start, end, { allDay: true }), record("zero", baseNow, baseNow),
    record("ended-yesterday", start.getTime() - 3600000, start), record("tomorrow", end, end.getTime() + 1000),
    record("cancelled", baseNow, baseNow + 1000, { status: "canceled" }), record("invalid", NaN, baseNow),
    record("ongoing", baseNow - 3600000, baseNow + 3600000)];
  const result = app.selectTodayEvents(records, baseNow);
  assert.equal(JSON.stringify(result.map((value) => value.id)), '["all-day","multiday","ongoing","zero"]');
});

test("Android UTC all-day dates normalize to local midnight without dropping today's appointment", () => {
  const app = calendarHarness(); const local = new Date(baseNow);
  const utc = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
  const result = app.selectTodayEvents([{ id: "all", startDate: new Date(utc), endDate: new Date(utc + 86400000), allDay: true }], baseNow, true);
  assert.equal(result.length, 1); assert.equal(new Date(result[0].startDate).getHours(), 0);
});

test("no calendars is a ready empty result; hidden, cancelled and self-declined meetings are excluded using new API", async () => {
  const empty = calendarHarness(); assert.equal((await empty.readTodayCalendar(baseNow, new AbortController().signal)).length, 0);
  assert.equal(empty.calls.some(([name]) => name === "events"), false);
  const record = (id, people = [], changes = {}) => ({ id, calendarId: "cal", title: id, startDate: event.startDate, endDate: event.endDate,
    allDay: false, getAttendees: async () => people, ...changes });
  const app = calendarHarness({ calendars: [{ id: "cal", ownerAccount: "me@example.invalid" }, { id: "hidden", isVisible: false }], records: [
    record("self-no", [{ email: "ME@example.invalid", status: "declined" }]),
    record("other-no", [{ email: "other@example.invalid", status: "declined" }]),
    record("ios-no", [{ isCurrentUser: true, status: "declined" }]), record("cancel", [], { status: "canceled" })] });
  const result = await app.readTodayCalendar(baseNow, new AbortController().signal);
  assert.equal(JSON.stringify(result.map((value) => value.id)), '["other-no"]');
  const call = app.calls.find(([name]) => name === "events"); assert.equal(call[1].length, 1);
  const window = app.todayWindow(baseNow); assert.equal(call[2].getTime(), window.start.getTime()); assert.equal(call[3].getTime(), window.end.getTime());
});

test("calendar cancellation discards late native data and system viewer is read-only", async () => {
  const pending = deferred(), app = calendarHarness({ calendars: [{ id: "cal" }] });
  app.calendar.listEvents = () => pending.promise;
  const abort = new AbortController(); const task = app.readTodayCalendar(baseNow, abort.signal);
  await flush(); abort.abort(); pending.resolve([]); await assert.rejects(task, /取消/);
  await app.openTodayCalendarEvent(event);
  const call = app.calls.find(([name]) => name === "open");
  assert.equal(call[1].id, event.id); assert.equal(call[2].allowsEditing, false); assert.equal(call[2].startNewActivityTask, false);
});

test("native location reports mock, provider availability, unknown accuracy and removes native watcher", async () => {
  let removed = 0;
  const exports = load("todayLocation", { "react-native": { Platform: { OS: "android" } }, "./todayCalendar": calendarHelpers,
    "./deviceCapabilityLogic": { oneLocationFix }, "expo-location": {
      hasServicesEnabledAsync: async () => true, Accuracy: { High: 4 },
      watchPositionAsync: async (options, success) => { assert.equal(options.mayShowUserSettingsDialog, false);
        success({ coords: { latitude: 31, longitude: 121, accuracy: -1 }, timestamp: Date.now(), mocked: true }); return { remove: () => removed++ }; },
      getProviderStatusAsync: async () => ({ networkAvailable: false }), reverseGeocodeAsync: async () => [{ city: "测试市", district: "测试区" }],
    } });
  const result = await exports.readTodayPlace(new AbortController().signal);
  assert.equal(result.mocked, true); assert.equal(result.accuracy, null); assert.equal(result.networkAvailable, false); assert.equal(removed, 1);
});

test("permissions config allows calendar read while blocking write/background/WiFi scan", () => {
  const { expo } = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  assert.equal(expo.android.blockedPermissions.includes("android.permission.READ_CALENDAR"), false);
  for (const permission of ["WRITE_CALENDAR", "ACCESS_BACKGROUND_LOCATION", "FOREGROUND_SERVICE_LOCATION"]) assert.ok(expo.android.blockedPermissions.includes(`android.permission.${permission}`));
  assert.doesNotMatch(JSON.stringify(expo), /NEARBY_WIFI_DEVICES|ACCESS_WIFI_STATE|CHANGE_WIFI_STATE/);
  const calendar = expo.plugins.find((value) => Array.isArray(value) && value[0] === "expo-calendar")[1];
  assert.equal(calendar.writeOnlyAccess, false); assert.match(calendar.calendarPermission, /今天/);
});


test("calendar total deadline settles stuck native read and prevents follow-up attendee reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred(), app = calendarHarness({ calendars: [{ id: "cal" }] });
  let attendees = 0;
  app.calendar.listEvents = () => pending.promise;
  const task = app.readTodayCalendar(baseNow, new AbortController().signal);
  const rejected = assert.rejects(task, /读取超时/);
  await flush(); t.mock.timers.tick(10000); await rejected;
  pending.resolve([{ ...event, getAttendees: async () => { attendees++; return []; } }]);
  await flush(); assert.equal(attendees, 0);
});

test("new place never displays prior-place weather while the new weather request is in flight", async () => {
  const app = controllerHarness({}, enabled); await app.start();
  const nextWeather = deferred(); app.deps.readPlace = async () => ({ ...place, label: "另一个测试地区", latitude: 32 });
  app.deps.weather = () => nextWeather.promise;
  const task = app.controller.refreshLocation(true); await flush();
  assert.equal(app.controller.snapshot.place.latitude, 32); assert.equal(app.controller.snapshot.weather, null);
  nextWeather.resolve(weather); await task;
});

test("a user leaving before switch persistence finishes never opens a permission prompt", async () => {
  const saved = deferred(); let prompts = 0;
  const app = controllerHarness({ setPreferences: () => saved.promise, locationPermission: async () => { prompts++; return granted; } });
  await app.start(); const task = app.controller.enableLocation();
  app.controller.setVisibility(false); saved.resolve(); await task;
  assert.equal(prompts, 0);
});


test("calendar cancellation while its module loads never begins a native query", async () => {
  const app = calendarHarness({ calendars: [{ id: "cal" }] });
  const controller = new AbortController(); const task = app.readTodayCalendar(baseNow, controller.signal);
  controller.abort(); await assert.rejects(task, /取消/); await flush();
  assert.equal(app.calls.some(([name]) => name === "calendars"), false);
});

test("declining one recurring instance does not remove another instance sharing its event id", async () => {
  const later = baseNow + 3600000;
  const record = (time, people) => ({ ...event, id: "series", calendarId: "cal", startDate: new Date(time), endDate: new Date(time + 600000),
    getAttendees: async () => people });
  const app = calendarHarness({ calendars: [{ id: "cal", ownerAccount: "me@example.invalid" }], records: [
    record(baseNow, [{ email: "me@example.invalid", status: "declined" }]), record(later, [])] });
  const events = await app.readTodayCalendar(baseNow, new AbortController().signal);
  assert.equal(events.length, 1); assert.equal(events[0].startDate, new Date(later).toISOString());
});
