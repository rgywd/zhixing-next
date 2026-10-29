"""Compare the native plugin with the retired business API on isolated records.

Run from repository root: uv run --project backend python plugins/dsh-zhixing/tests/business-parity.py
Python is a migration/test dependency only, never a DSH runtime dependency.
"""
import itertools
import json
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from zhixing_next import finance_service as finance
from zhixing_next import health_service as health
from zhixing_next.config import Settings
from zhixing_next.finance_routes import create_router as finance_router
from zhixing_next.health_routes import create_router as health_router
from zhixing_next.store import Store, StoreError


def main():
    counter = itertools.count(1)
    finance.uuid4 = health.uuid4 = lambda: f"00000000-0000-4000-8000-{next(counter):012d}"
    finance._now = health._now = lambda: "2026-10-29T04:00:00+00:00"
    failures, count = [], 0
    with tempfile.TemporaryDirectory(prefix="zhixing-business-parity-") as temporary:
        root = Path(temporary)
        store = Store(Settings(data_dir=root / "data", workspace_root=root / "work"))
        app = FastAPI()
        app.include_router(finance_router(store), prefix="/v1")
        app.include_router(health_router(store), prefix="/v1")

        @app.exception_handler(StoreError)
        async def handle(_request, error):
            return JSONResponse({"error": error.message}, status_code=error.status)

        client = TestClient(app)
        node = subprocess.Popen(["node", str(Path(__file__).with_name("business-runner.mjs"))], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

        def compare(method, path, body=None):
            nonlocal count
            count += 1
            response = client.request(method, "/v1" + path, **({"json": body} if body is not None else {}))
            node.stdin.write(json.dumps({"method": method, "path": "/v1" + path, "body": body}) + "\n")
            node.stdin.flush()
            actual = json.loads(node.stdout.readline())
            expected = response.json()
            if response.status_code < 300:
                if actual.get("result") != expected:
                    failures.append({"step": count, "path": path, "expected": expected, "actual": actual})
            elif actual.get("status") != response.status_code:
                failures.append({"step": count, "path": path, "expected_status": response.status_code, "actual": actual})
            return expected

        def record(key, amount="10", **fields):
            return compare("POST", "/finance/transactions", {"idempotency_key": key, "kind": "expense", "amount": amount, "occurred_on": "2026-10-09", **fields})

        def summary(month="2026-10"):
            return compare("GET", f"/finance/summary?month={month}&as_of=2026-10-29")

        try:
            summary()
            compare("GET", "/health/summary?date=2026-10-29")
            budget = {"month": "2026-10", "idempotency_key": "budget", "expected_income": "12000", "savings_target": "6000", "daily_budget": "2500",
                      "commitments": [{"key": "rent", "label": "房租", "kind": "fixed", "amount": "5100", "every_months": 3, "anchor_month": "2026-10", "monthly_cost": "1700"}]}
            compare("PUT", "/finance/budget", budget)
            compare("PUT", "/finance/budget", budget)
            summary()
            summary("2026-11")
            paid = record("rent-paid", "5100", bucket="fixed", commitment_key="rent", coverage_start="2026-10", coverage_end="2026-12")
            summary()
            summary("2026-11")
            refund = record("refund", "100", kind="refund", related_transaction_id=paid["id"])
            summary()
            compare("PATCH", f'/finance/transactions/{paid["id"]}', {"idempotency_key": "change-rent", "amount": "5000", "expected_revision": 1})
            compare("DELETE", f'/finance/transactions/{paid["id"]}?idempotency_key=blocked-delete')
            compare("DELETE", f'/finance/transactions/{refund["id"]}?idempotency_key=refund-delete')
            summary()
            record("range", "230", date_precision="range", occurred_on=None, date_start="2026-09-01", date_end="2026-10-25")
            summary()
            record("month", "50", date_precision="month", occurred_on=None, date_start="2026-10")
            record("transfer", "4000", kind="transfer", note="公积金提取")
            record("invalid-income", "4000", kind="income", note="公积金提取")
            for amount in ["0", "-1", "NaN", "1000000000000", "1.001", "1e1"]:
                record("money-" + amount, amount)
            record("total", "500", entry_type="aggregate", period_start="2026-10-01", occurred_on="2026-10-20")
            record("included", "400", occurred_on="2026-10-15")
            summary()
            record("exceeds", "200", occurred_on="2026-10-17")
            summary()
            compare("PATCH", "/finance/budget", {"month": "2026-10", "idempotency_key": "budget-patch", "changes": {"savings_target": "5500"}})
            compare("PATCH", "/finance/budget", {"month": "2026-10", "idempotency_key": "budget-cover", "changes": {"coverage_start": "2026-10-01", "coverage_through": "2026-10-29"}})
            compare("PATCH", "/finance/budget", {"month": "2026-11", "idempotency_key": "nov-income", "recurring": False, "changes": {"expected_income": "13000"}})
            compare("PATCH", "/finance/budget", {"month": "2026-11", "idempotency_key": "nov-target", "changes": {"savings_target": "7000"}})
            summary("2026-11")
            summary("2026-12")
            batch_original = record("batch-original", "60", occurred_on="2026-10-25")
            operations = [{"operation": "delete", "transaction_id": batch_original["id"]}, {"operation": "create", "fields": {"kind": "expense", "amount": "20", "occurred_on": "2026-10-25"}}, {"operation": "create", "fields": {"kind": "expense", "amount": "40", "occurred_on": "2026-10-25"}}]
            compare("POST", "/finance/transactions/batch", {"idempotency_key": "split", "operations": operations})
            compare("GET", "/finance/transactions?month=2026-10")
            bad = record("bad-batch-original", "50")
            compare("POST", "/finance/transactions/batch", {"idempotency_key": "bad-split", "operations": [{"operation": "delete", "transaction_id": bad["id"]}, {"operation": "create", "fields": {"kind": "expense", "amount": "40", "occurred_on": "2026-10-09"}}]})
            summary()
            profile = compare("PUT", "/health/profile", {"revision": 0, "food_allergies": ["花生"], "activity_limitations": ["膝盖受伤"], "goals": ["规律饮食"]})
            compare("PUT", "/health/profile", {"revision": 0, "height_cm": 170})
            compare("PUT", "/health/profile", profile)
            compare("PUT", "/health/reminders", {"revision": 0, "enabled": True, "slots": [{"id": "lunch", "time": "12:00"}], "paused_dates": ["2026-10-30"]})
            compare("POST", "/health/rules", {"content": "建议减少奶茶", "origin": "assistant_proposal"})
            compare("POST", "/health/rules", {"content": "不吃香菜", "kind": "restriction", "excluded_terms": ["香菜"]})
            meal = compare("POST", "/health/meals", {"id": "meal-1", "occurred_at": "2026-10-29T12:30:00+08:00", "description": "鸡肉饭", "estimated_energy": {"minimum": 400, "maximum": 600, "basis": "份量估计"}})
            compare("POST", "/health/meals", {"id": "meal-1", "occurred_at": "2026-10-29T12:30:00+08:00", "description": "鸡肉饭", "estimated_energy": {"minimum": 400, "maximum": 600, "basis": "份量估计"}})
            compare("PUT", "/health/meals/meal-1", {"revision": meal["revision"], "occurred_at": "2026-10-29T12:30:00+08:00", "description": "鸡肉饭和青菜"})
            compare("POST", "/health/meals", {"occurred_at": "2026-10-29", "description": "未知时间"})
            for identifier, measured, value, unit in [("w1", "2026-10-28T08:00:00+08:00", 150, "lb"), ("w2", "2026-10-29T08:00:00+08:00", 68, "kg"), ("w3", "2026-10-29T09:00:00+08:00", 69, "kg")]:
                compare("POST", "/health/weights", {"id": identifier, "measured_at": measured, "value": value, "unit": unit})
            compare("POST", "/health/steps", {"id": "steps", "measured_at": "2026-10-29T18:00:00+08:00", "value": 4000})
            context = compare("GET", "/health/summary?date=2026-10-29")
            recommendation = {"id": "dinner", "context_revision": context["revision"], "target_date": "2026-10-29", "meal_type": "dinner", "options": [{"id": "rice", "title": "鸡肉饭", "description": "清淡鸡肉配蔬菜", "ingredients": ["鸡肉", "米饭", "青菜"]}]}
            compare("POST", "/health/recommendations", recommendation)
            compare("POST", "/health/recommendations/dinner/feedback", {"id": "choice", "action": "accepted", "option_id": "rice"})
            compare("GET", "/health/summary?date=2026-10-29")
            compare("POST", "/health/recommendations/dinner/feedback", {"id": "stale-choice", "action": "accepted", "option_id": "rice"})
            compare("DELETE", "/health/meals/meal-1?revision=1")
            compare("DELETE", "/health/meals/meal-1?revision=2")
            compare("GET", "/health/summary?date=2026-10-29")
        finally:
            node.stdin.close()
            node.wait(timeout=10)
    if failures:
        report = Path(tempfile.gettempdir()) / "zhixing-business-parity-failures.json"
        report.write_text(json.dumps(failures, ensure_ascii=False, indent=2))
        print(json.dumps({"checks": count, "failures": len(failures), "report": str(report), "steps": [f["step"] for f in failures]}))
        raise SystemExit(1)
    print(json.dumps({"checks": count, "matched": True}))


if __name__ == "__main__":
    main()
