import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { dateInZone, localReminderTime, planHealthReminders } from "../src/reminderPlan.ts";

const now = new Date("2026-10-14T02:00:00Z");
const settings = { revision: 2, enabled: true, timezone: "Asia/Shanghai", slots: [
  { id: "lunch", time: "12:00", meal_type: "lunch", kind: "meal" },
  { id: "dinner", time: "18:00", meal_type: "dinner", kind: "meal" },
  { id: "review", time: "20:00", meal_type: "other", kind: "review" },
], quiet_start: "22:00", quiet_end: "07:00", max_per_day: 3, paused_dates: [] };

test("meal reminders use the agreed wall time and skip nonexistent daylight-saving times", () => {
  assert.equal(localReminderTime("2026-10-14", "12:00", "Asia/Shanghai").toISOString(), "2026-10-14T04:00:00.000Z");
  assert.equal(localReminderTime("2026-03-08", "02:30", "America/New_York"), null);
  assert.equal(localReminderTime("2026-03-09", "02:30", "America/New_York").toISOString(), "2026-03-09T06:30:00.000Z");
  assert.equal(dateInZone(new Date("2026-10-13T23:30:00Z"), "Asia/Shanghai"), "2026-10-14");
});

test("recording lunch suppresses its reminder without suppressing other meals or treating missing data as skipped", () => {
  const all = planHealthReminders(settings, [], now, "scope", 2);
  assert.equal(all.length, 6);
  const recorded = [{ id: "meal", occurred_at: "2026-10-14T11:30:00+08:00", meal_type: "lunch", status: "recorded" }];
  const plan = planHealthReminders(settings, recorded, now, "scope", 2);
  assert.equal(plan.length, 5);
  assert.ok(!plan.some((item) => item.day === "2026-10-14" && item.slotId === "lunch"));
  assert.ok(plan.some((item) => item.day === "2026-10-15" && item.slotId === "lunch"));
  assert.ok(plan.some((item) => item.day === "2026-10-14" && item.kind === "review"));
});

test("quiet hours, today pause, cap and elapsed slots cannot produce catch-up notification bursts", () => {
  const plan = planHealthReminders({ ...settings, paused_dates: ["2026-10-14"], max_per_day: 1, quiet_start: "11:00", quiet_end: "13:00" }, [], now, "scope", 2);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].day, "2026-10-15");
  assert.equal(plan[0].slotId, "dinner");
  const late = planHealthReminders(settings, [], new Date("2026-10-14T13:00:00Z"), "scope", 1);
  assert.equal(late.length, 0);
  assert.equal(planHealthReminders({ ...settings, enabled: false }, [], now, "scope").length, 0);
});

test("foreground re-sync cannot replenish the notification cap after the first slot elapsed", () => {
  const capped = { ...settings, max_per_day: 1 };
  assert.equal(planHealthReminders(capped, [], new Date("2026-10-14T03:00:00Z"), "scope", 1).length, 1);
  assert.equal(planHealthReminders(capped, [], new Date("2026-10-14T05:00:00Z"), "scope", 1).length, 0);
  assert.equal(planHealthReminders(capped, [], new Date("2026-10-14T11:00:00Z"), "scope", 1).length, 0);
});

function device() {
  const scheduled = new Map(), storage = new Map(), created = [], cancelled = [];
  let lost = false;
  const notifications = {
    AndroidImportance: { DEFAULT: 3, NONE: 0 }, SchedulableTriggerInputTypes: { DATE: "date" },
    getPermissionsAsync: async () => ({ granted: true, status: "granted" }),
    getAllScheduledNotificationsAsync: async () => [...scheduled.values()],
    setNotificationChannelAsync: async () => {}, getNotificationChannelAsync: async () => ({ importance: 3 }),
    cancelScheduledNotificationAsync: async (id) => { cancelled.push(id); scheduled.delete(id); },
    scheduleNotificationAsync: async (item) => { created.push(item.identifier); scheduled.set(item.identifier, item); if (lost) { lost = false; throw new Error("response lost after scheduling"); } return item.identifier; },
  };
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL("../src/healthNotifications.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now.getTime()])); } }
  const dependencies = {
    "expo-notifications": notifications,
    "expo-crypto": { CryptoDigestAlgorithm: { SHA256: "sha256" }, digestStringAsync: async (_kind, value) => createHash("sha256").update(value).digest("hex") },
    "react-native": { Platform: { OS: "android" } },
    "@react-native-async-storage/async-storage": { __esModule: true, default: { getItem: async (key) => storage.get(key) ?? null, setItem: async (key, value) => storage.set(key, value) } },
    "./reminderPlan": { dateInZone, planHealthReminders },
  };
  runInNewContext(source, { exports, Date: Clock, Intl, Map, Set, Promise, require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return { ...exports, scheduled, created, cancelled, loseNext: () => { lost = true; } };
}

test("real scheduling reconciliation retries a lost receipt without duplicating device notifications", async () => {
  const app = device(), summary = { reminders: settings, meals: [] };
  app.loseNext();
  await assert.rejects(app.syncHealthNotifications("scope", summary), /response lost/);
  await app.syncHealthNotifications("scope", summary);
  assert.equal(app.created.length, 42);
  assert.equal(app.scheduled.size, 42);
  await app.syncHealthNotifications("scope", summary);
  assert.equal(app.created.length, 42);
  await app.syncHealthNotifications("scope", { ...summary, reminders: { ...settings, enabled: false, revision: 3 } });
  assert.equal(app.scheduled.size, 0);
});

test("today pause persists offline and resync preserves tomorrow's reminders", async () => {
  const app = device(), connection = { url: "https://example.test", token: "synthetic-only" };
  const scope = await app.notificationScope(connection), summary = { reminders: settings, meals: [] };
  await app.syncHealthNotifications(scope, summary);
  await app.pauseHealthNotificationsForToday(connection);
  assert.equal(app.scheduled.size, 39);
  assert.ok([...app.scheduled.values()].every((item) => item.content.data.day !== "2026-10-14"));
  await app.syncHealthNotifications(scope, summary);
  assert.equal(app.scheduled.size, 39);
  await app.cancelHealthNotifications(scope);
  assert.equal(app.scheduled.size, 0);
});
