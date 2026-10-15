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
