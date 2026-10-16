import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const exports = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/FinanceDashboard.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports, require() { return {}; } });
const { financeBudgetProgress } = exports;
const summary = (overrides = {}) => ({ budget: { daily_budget: null }, totals: { expense: "0.00", daily: "0.00" }, reservations: { total: "0.00" }, remaining: { total_spend_budget: null }, ...overrides });

test("unknown or nonpositive budget does not fabricate a progress percentage", () => {
  assert.equal(financeBudgetProgress(summary()), null);
  assert.equal(financeBudgetProgress(summary({ budget: { daily_budget: "0.00" } })), null);
  assert.equal(financeBudgetProgress(summary({ remaining: { total_spend_budget: "-100.00" } })), null);
});

test("daily-only limits use daily spending and exclude fixed reservations", () => {
  const progress = financeBudgetProgress(summary({ budget: { daily_budget: "1800.00" }, totals: { expense: "1200.00", daily: "300.00" }, reservations: { total: "800.00" } }));
  assert.equal(progress.basis, "daily"); assert.equal(progress.capacity, 1800); assert.equal(progress.spent, 300); assert.equal(progress.reserved, 0);
  assert.equal(progress.spentPercent, 300 / 1800 * 100); assert.equal(progress.reservedPercent, 0);
});

test("a tighter savings constraint includes actual spending and outstanding reservations once", () => {
  const progress = financeBudgetProgress(summary({ budget: { daily_budget: "3000.00" }, totals: { expense: "500.00", daily: "100.00" }, reservations: { total: "700.00" }, remaining: { total_spend_budget: "800.00" } }));
  assert.equal(progress.basis, "goal"); assert.equal(progress.capacity, 2000); assert.equal(progress.spent, 500); assert.equal(progress.reserved, 700);
  assert.equal(progress.spentPercent, 25); assert.equal(progress.reservedPercent, 35); assert.equal(progress.usedPercent, 60);
});

test("a tighter daily cap does not count unrelated fixed spending against that cap", () => {
  const progress = financeBudgetProgress(summary({ budget: { daily_budget: "1000.00" }, totals: { expense: "2500.00", daily: "200.00" }, reservations: { total: "500.00" }, remaining: { total_spend_budget: "3000.00" } }));
  assert.equal(progress.basis, "daily"); assert.equal(progress.capacity, 1000); assert.equal(progress.usedPercent, 20);
});

test("overspending clips visual occupancy while retaining its true spending amount", () => {
  const progress = financeBudgetProgress(summary({ budget: { daily_budget: "1000.00" }, totals: { expense: "2400.00", daily: "2400.00" } }));
  assert.equal(progress.spent, 2400); assert.equal(progress.usedPercent, 100); assert.equal(progress.reservedPercent, 0);
});

const service = {};
let payloads;
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/serviceApi.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: service, Set, Promise, encodeURIComponent, require() { return { request: async (_connection, path) => path.includes("summary") ? payloads.summary : payloads.records }; } });

test("date labels preserve month and uncertain ranges without pretending they occurred on the last day", () => {
  assert.equal(service.financeDateLabel({ occurred_on: "2028-06-30", date_precision: "month", date_start: "2028-06-01" }), "2028-06（日期待定）");
  assert.equal(service.financeDateLabel({ occurred_on: "2028-06-30", date_precision: "range", date_start: "2028-03-01", date_end: "2028-06-30" }), "2028-03-01 至 2028-06-30（区间）");
});

test("cross-month records appear once in the unallocated section and do not inflate month counts", async () => {
  const uncertain = { id: "range" }, allocated = { id: "day" };
  payloads = { summary: { unallocated: { items: [uncertain], count: 1 } }, records: { items: [uncertain, allocated], total: 2 } };
  const result = await service.readFinanceDashboard({}, "2028-06");
  assert.deepEqual(result.records.items, [allocated]);
  assert.equal(result.records.total, 1);
  assert.deepEqual(result.summary.unallocated.items, [uncertain]);
});
