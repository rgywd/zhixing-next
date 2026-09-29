import assert from "node:assert/strict";
import { test } from "node:test";
import { failedSync, syncNotice, SYNC_GRACE_MS } from "../src/syncHealth.ts";

test("brief polling failures stay silent and recovery starts a fresh grace period", () => {
  let failure = failedSync(undefined, undefined, 0);
  failure = failedSync(failure, undefined, 2500);
  assert.equal(syncNotice([failure], 8000), null);
  assert.equal(syncNotice([], 9000), null);
  failure = failedSync(undefined, undefined, 20000);
  assert.equal(syncNotice([failure], 24000), null);
});

test("persistent failures need both elapsed grace and repeated attempts; auth errors are immediate", () => {
  const once = failedSync(undefined, 503, 0);
  assert.equal(syncNotice([once], 60000), null);
  const repeated = failedSync(failedSync(once, 503, 1000), 503, 2000);
  assert.equal(syncNotice([repeated], SYNC_GRACE_MS - 1), null);
  assert.ok(syncNotice([repeated], SYNC_GRACE_MS));
  assert.match(syncNotice([failedSync(undefined, 401, 0)], 0), /凭证/);
  assert.match(syncNotice([failedSync(undefined, 403, 0)], 0), /凭证/);
});

test("multiple failing readers yield one notice until every failing source recovers", () => {
  const a = { since: 0, attempts: 4, status: 503 };
  const b = { since: 1000, attempts: 3 };
  assert.equal(syncNotice([a, b], 20000), syncNotice([b], 20000));
  assert.equal(syncNotice([], 20000), null);
});
