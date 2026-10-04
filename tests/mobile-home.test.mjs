import assert from "node:assert/strict";
import { test } from "node:test";
import { homeEntries, parseHomePreferences, toggleHomePin, recordHomeOpen } from "../src/homeEntries.ts";

test("home pins keep a stable user order while recent entries mix actual conversations and files", () => {
  let prefs = parseHomePreferences(null);
  const old = { kind: "conversation", id: "old", title: "旧名称" };
  prefs = toggleHomePin(prefs, old);
  prefs = toggleHomePin(prefs, { kind: "project", id: "work", title: "项目" });
  const conversations = [{ id: "old", title: "更新名称", updated_at: "2026-10-01T12:00:00Z" }, { id: "new", title: "新对话", updated_at: "2026-10-04T12:00:00Z" }];
  const files = [{ id: "file", name: "清单", created_at: "2026-10-03T12:00:00+00:00" }];
  let result = homeEntries(conversations, [{ id: "work", name: "项目" }], files, prefs);
  assert.deepEqual(result.pins.map((item) => item.id), ["old", "work"]);
  assert.equal(result.pins[0].title, "更新名称");
  assert.deepEqual(result.recent.map((item) => item.id), ["new", "file", "old"]);
  prefs = recordHomeOpen(prefs, old, "2026-10-05T12:00:00.000Z");
  result = homeEntries(conversations, [], files, prefs);
  assert.equal(result.recent[0].id, "old");
  assert.equal(homeEntries([], [], [], parseHomePreferences(JSON.stringify(prefs))).recent[0].id, "old");
  assert.deepEqual(result.pins.map((item) => item.id), ["old", "work"]);
  assert.equal(result.pins[1].title, "项目"); // unloaded project remains reachable by id
  assert.equal(result.recent.filter((item) => item.id === "old").length, 1);
  assert.deepEqual(toggleHomePin(prefs, old).pins.map((item) => item.id), ["work"]);
});

test("home preferences reject invalid references, deduplicate pins and bound local recent history", () => {
  let prefs = parseHomePreferences(JSON.stringify({ pins: [null, { kind: "bad", id: "a", title: "x" }, { kind: "project", id: "a", title: "first" }, { kind: "project", id: "a", title: "latest" }], opened: { broken: "not-a-time", okay: "2026-10-04T00:00:00Z" } }));
  assert.equal(prefs.pins.length, 1);
  assert.deepEqual(Object.keys(prefs.opened), ["okay"]);
  for (let index = 0; index < 110; index++) prefs = recordHomeOpen(prefs, { kind: "conversation", id: String(index), title: String(index) }, new Date(Date.UTC(2026, 9, 4, 0, index)).toISOString());
  assert.equal(Object.keys(prefs.opened).length, 100);
  assert.ok(prefs.opened["conversation:109"]);
  assert.equal(prefs.opened["conversation:0"], undefined);
});
