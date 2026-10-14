"""Business regressions: records, budget math, unknown coverage and retry receipts."""

import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from zhixing_next.config import Settings
from zhixing_next.finance_routes import create_router
from zhixing_next.finance_service import FinanceService, migrate
from zhixing_next.finance_tools import create_finance_service_tools
from zhixing_next.store import Store, StoreError


@pytest.fixture
def store(tmp_path):
    value = Store(Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work"))
    with value._connection(write=True) as db:
        migrate(db)
    return value


@pytest.fixture
def service(store):
    return FinanceService(store)


def record(service, key, amount="10.00", **kwargs):
    return service.create_transaction(
        idempotency_key=key,
        kind=kwargs.pop("kind", "expense"),
        amount=amount,
        occurred_on=kwargs.pop("occurred_on", "2026-04-09"),
        **kwargs,
    )


def budget(service, key="budget", **kwargs):
    return service.set_budget(
        month=kwargs.pop("month", "2026-04"),
        idempotency_key=key,
        expected_income=kwargs.pop("expected_income", "12000"),
        savings_target=kwargs.pop("savings_target", "6000"),
        daily_budget=kwargs.pop("daily_budget", "1800"),
        commitments=kwargs.pop(
            "commitments",
            [
                {"key": "rent", "label": "住房", "amount": "1500", "kind": "fixed"},
                {"key": "device", "label": "设备", "amount": "500", "kind": "one_time"},
            ],
        ),
        **kwargs,
    )


def test_migration_is_reentrant_and_leaves_legacy_observations_alone(store):
    conversation = store.create_conversation("老账目")
    store.record_finance_observation(
        kind="income",
        platform="账户",
        amount="13.00",
        note="旧观察",
        conversation_id=conversation["id"],
    )
    with store._connection(write=True) as db:
        migrate(db)
        migrate(db)
    assert FinanceService(store).summary(month="2026-04")["totals"]["income"] == "0.00"
    assert len(store.list_finance_observations()["recent"]) == 1


def test_partial_setup_allows_records_but_never_claims_projection(service):
    record(service, "lunch", "32")
    summary = service.summary(month="2026-04", as_of="2026-04-10")
    assert summary["totals"]["expense"] == "32.00"
    assert summary["projection"]["savings"] is None
    assert summary["remaining"]["daily_budget"] is None
    assert not summary["coverage"]["complete"]
    assert "record_coverage_not_confirmed" in summary["coverage"]["gaps"]


def test_month_uses_business_date_full_summary_not_recent_page(service):
    for number in range(125):
        record(service, f"small-{number}", "1", occurred_on="2026-04-01")
    record(service, "backfill", "99", occurred_on="2026-03-31")
    assert len(service.list_transactions(month="2026-04")["items"]) == 50
    assert service.list_transactions(month="2026-04")["total"] == 125
    assert service.summary(month="2026-04")["totals"]["expense"] == "125.00"
    assert service.summary(month="2026-03")["totals"]["expense"] == "99.00"


def test_received_income_offsets_expected_and_commitments_offset_paid(service):
    budget(service)
    record(service, "salary", "12000", kind="income")
    record(service, "rent-paid", "1500", bucket="fixed", commitment_key="rent")
    record(service, "device-paid", "500", bucket="one_time", commitment_key="device")
    record(service, "daily", "300")
    result = service.summary(month="2026-04", as_of="2026-04-10")
    assert result["projection"]["income"] == "12000.00"
    assert result["projection"]["expected_income_remaining"] == "0.00"
    assert result["reservations"]["total"] == "0.00"
    assert result["remaining"]["total_spend_budget"] == "3700.00"
    assert result["remaining"]["daily_budget"] == "1500.00"
    assert result["projection"]["expense"] == "3800.00"
    assert result["projection"]["savings"] == "8200.00"


def test_unplanned_large_expense_reduces_remaining_and_transfers_do_not(service):
    budget(service, daily_budget="5000")
    record(service, "unexpected", "4500", bucket="one_time")
    record(service, "card", "900", kind="transfer")
    result = service.summary(month="2026-04")
    assert result["totals"]["expense"] == "4500.00"
    assert result["totals"]["daily"] == "0.00"
    assert result["totals"]["transfer"] == "900.00"
    assert result["remaining"]["daily_budget"] == "-500.00"


def test_refund_links_original_bucket_and_corrections_recompute(service):
    purchase = record(service, "purchase", "90", bucket="one_time")
    refund = record(service, "refund", "30", kind="refund", related_transaction_id=purchase["id"])
    assert refund["bucket"] == "one_time"
    result = service.summary(month="2026-04")
    assert result["totals"]["expense"] == "60.00"
    assert result["totals"]["one_time"] == "60.00"
    service.update_transaction(
        purchase["id"], idempotency_key="correct", bucket="daily", amount="100"
    )
    result = service.summary(month="2026-04")
    assert result["totals"]["daily"] == "70.00"
    assert result["totals"]["one_time"] == "0.00"
    with pytest.raises(StoreError):
        service.update_transaction(purchase["id"], idempotency_key="less-than-refund", amount="20")
    with pytest.raises(StoreError):
        record(service, "over-refund", "80", kind="refund", related_transaction_id=purchase["id"])
    with pytest.raises(StoreError):
        service.delete_transaction(purchase["id"], idempotency_key="delete-original")


def test_refund_timing_counts_in_its_actual_month(service):
    purchase = record(service, "march", "80", occurred_on="2026-03-31")
    record(service, "april-refund", "25", kind="refund", related_transaction_id=purchase["id"])
    assert service.summary(month="2026-03")["totals"]["expense"] == "80.00"
    assert service.summary(month="2026-04")["totals"]["expense"] == "-25.00"


def test_fixed_refund_reopens_only_unpaid_reservation(service):
    budget(service)
    purchase = record(service, "rent", "1500", bucket="fixed", commitment_key="rent")
    record(service, "rent-refund", "200", kind="refund", related_transaction_id=purchase["id"])
    result = service.summary(month="2026-04")
    assert result["reservations"]["fixed"] == "200.00"
    assert result["totals"]["fixed"] == "1300.00"
    assert result["remaining"]["total_spend_budget"] == "4000.00"


def test_default_budget_inherits_but_one_time_commitment_and_coverage_do_not(service):
    budget(service, coverage_start="2026-04-01", coverage_through="2026-04-10")
    inherited = service.get_budget("2026-05")
    assert inherited["source_month"] == "2026-04"
    assert inherited["daily_budget"] == "1800.00"
    assert [item["key"] for item in inherited["commitments"]] == ["rent"]
    assert inherited["coverage_start"] is None
    budget(service, "may-override", month="2026-05", recurring=False, daily_budget="900")
    assert service.get_budget("2026-05")["daily_budget"] == "900.00"
    assert service.get_budget("2026-06")["daily_budget"] == "1800.00"
    service.delete_budget(month="2026-05", recurring=False, idempotency_key="clear-may")
    assert service.get_budget("2026-05")["daily_budget"] == "1800.00"
    assert service.get_budget("2026-03")["expected_income"] is None


def test_budget_edits_do_not_change_recorded_spending(service):
    record(service, "record", "85")
    budget(service)
    budget(service, "lower", daily_budget="50")
    result = service.summary(month="2026-04")
    assert result["totals"]["expense"] == "85.00"
    assert result["remaining"]["daily_budget"] == "-35.00"


def test_confirmed_calendar_coverage_is_required_for_daily_run_rate(service):
    record(service, "day1", "20", occurred_on="2026-04-01")
    record(service, "day2", "40", occurred_on="2026-04-02")
    budget(service, coverage_start="2026-04-01", coverage_through="2026-04-03")
    result = service.summary(month="2026-04", as_of="2026-04-03")
    assert result["coverage"]["recorded_days"] == 2
    assert result["coverage"]["complete"]
    assert result["daily_average"]["amount"] == "20.00"
    assert result["projection"]["daily_basis"] == "confirmed_coverage_run_rate"
    assert result["projection"]["expense"] == "2600.00"  # 60+27*20+2000 commitments
    result = service.summary(month="2026-04", as_of="2026-04-04")
    assert not result["coverage"]["complete"]
    assert result["projection"]["daily_basis"] == "configured_daily_budget"


def test_same_source_retry_survives_reopen_and_does_not_merge_equal_purchases(store, service):
    first = record(service, "request-one", "24")
    reopened = FinanceService(Store(store.settings))
    assert record(reopened, "request-one", "24") == first
    second = record(reopened, "request-two", "24")
    assert second["id"] != first["id"]
    with pytest.raises(StoreError, match="different fields"):
        record(reopened, "request-one", "25")
    assert reopened.summary(month="2026-04")["totals"]["expense"] == "48.00"


def test_concurrent_retry_creates_one_record(service):
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(lambda _: record(service, "same", "8"), range(8)))
    assert len({row["id"] for row in rows}) == 1
    assert service.list_transactions(month="2026-04")["total"] == 1


def test_correction_receipt_retry_after_other_edit_does_not_overwrite(service):
    item = record(service, "create", "11")
    corrected = service.update_transaction(
        item["id"], idempotency_key="correction", expected_revision=1, amount="12"
    )
    service.update_transaction(
        item["id"], idempotency_key="second-correction", expected_revision=2, amount="13"
    )
    assert (
        service.update_transaction(
            item["id"], idempotency_key="correction", expected_revision=1, amount="12"
        )
        == corrected
    )
    assert service.summary(month="2026-04")["totals"]["expense"] == "13.00"
    with pytest.raises(StoreError, match="changed"):
        service.update_transaction(
            item["id"], idempotency_key="stale", expected_revision=1, amount="15"
        )
    deleted = service.delete_transaction(item["id"], idempotency_key="delete")
    assert service.delete_transaction(item["id"], idempotency_key="delete") == deleted
    assert service.summary(month="2026-04")["totals"]["expense"] == "0.00"


def test_cumulative_total_reconciles_later_details_instead_of_double_counting(service):
    record(
        service,
        "total",
        "200",
        entry_type="aggregate",
        period_start="2026-04-01",
        occurred_on="2026-04-10",
    )
    record(service, "inside", "70", occurred_on="2026-04-03")
    record(service, "after", "30", occurred_on="2026-04-11")
    result = service.summary(month="2026-04")
    assert result["totals"]["expense"] == "230.00"
    with pytest.raises(StoreError, match="overlap"):
        record(
            service,
            "overlap",
            "90",
            entry_type="aggregate",
            period_start="2026-04-08",
            occurred_on="2026-04-12",
        )
    record(service, "excess-detail", "150", occurred_on="2026-04-04")
    result = service.summary(month="2026-04")
    assert result["totals"]["expense"] == "250.00"
    assert "details_exceed_cumulative_total" in result["coverage"]["gaps"]


@pytest.mark.parametrize(
    "values",
    [
        {"amount": "NaN"},
        {"amount": "0"},
        {"amount": "-1"},
        {"amount": "2.001"},
        {"occurred_on": "2026-02-30"},
        {"occurred_on": "2026-4-9"},
        {"kind": "refund"},
    ],
)
def test_invalid_amount_date_and_unlinked_refund_are_rejected(service, values):
    with pytest.raises(StoreError):
        record(service, "invalid", **values)
    assert service.list_transactions(month="2026-04")["total"] == 0


def test_router_direct_record_and_correction_work_without_model(store):
    app = FastAPI()

    @app.exception_handler(StoreError)
    async def handler(_request, exc):
        return JSONResponse(status_code=exc.status, content={"error": exc.code})

    app.include_router(create_router(store), prefix="/v1")
    with TestClient(app) as client:
        payload = {
            "idempotency_key": "direct",
            "kind": "expense",
            "amount": "18.50",
            "occurred_on": "2026-04-09",
        }
        first = client.post("/v1/finance/transactions", json=payload)
        assert first.status_code == 200
        item = first.json()
        assert client.post("/v1/finance/transactions", json=payload).json()["id"] == item["id"]
        assert (
            client.patch(
                f"/v1/finance/transactions/{item['id']}",
                json={"idempotency_key": "patch", "expected_revision": 1, "amount": "19"},
            ).status_code
            == 200
        )
        assert (
            client.get("/v1/finance/summary?month=2026-04").json()["totals"]["expense"] == "19.00"
        )
        assert (
            client.post(
                "/v1/finance/transactions",
                json={**payload, "idempotency_key": "unknown", "secret": "blocked"},
            ).status_code
            == 422
        )


async def test_tool_original_message_scope_survives_routes_and_budget_retry(store):
    conversation = store.create_conversation("财务")
    tools = {
        item.name: item
        for item in create_finance_service_tools(store.settings, conversation["id"], "message-1")
    }
    args = {
        "entry_key": "expense_1",
        "kind": "expense",
        "amount": "17",
        "occurred_on": "2026-04-09",
    }
    first = await tools["record_finance_transaction"].ainvoke(args)
    repeated = {
        item.name: item
        for item in create_finance_service_tools(store.settings, conversation["id"], "message-1")
    }
    assert (await repeated["record_finance_transaction"].ainvoke(args))["id"] == first["id"]
    values = {"month": "2026-04", "entry_key": "budget_1", "changes_json": '{"daily_budget":"700"}'}
    receipt = await tools["update_finance_budget"].ainvoke(values)
    FinanceService(store).set_budget(month="2026-04", idempotency_key="later", daily_budget="600")
    assert await repeated["update_finance_budget"].ainvoke(values) == receipt
    assert FinanceService(store).get_budget("2026-04")["daily_budget"] == "600.00"
    with sqlite3.connect(store.db_path) as db:
        assert db.execute("SELECT COUNT(*) FROM finance_mutations").fetchone()[0] == 3


def test_prior_month_refund_does_not_reopen_this_month_commitment(service):
    budget(service)
    original = record(
        service, "old-rent", "1500", bucket="fixed", commitment_key="rent", occurred_on="2026-03-31"
    )
    record(service, "refund-old-rent", "100", kind="refund", related_transaction_id=original["id"])
    assert service.summary(month="2026-04")["reservations"]["fixed"] == "1500.00"


def test_payment_cannot_consume_an_unrelated_commitment_bucket(service):
    budget(service)
    with pytest.raises(StoreError, match="bucket"):
        record(service, "wrong-bucket", "100", bucket="daily", commitment_key="rent")


def test_refunded_expense_cannot_become_an_aggregate(service):
    purchase = record(service, "purchase", "30")
    record(service, "refund", "10", kind="refund", related_transaction_id=purchase["id"])
    with pytest.raises(StoreError):
        service.update_transaction(
            purchase["id"],
            idempotency_key="convert",
            entry_type="aggregate",
            period_start="2026-04-01",
        )


def test_new_default_from_override_month_takes_effect_immediately(service):
    budget(service, "default-april")
    budget(service, "only-may", month="2026-05", recurring=False, daily_budget="900")
    changed = budget(
        service, "default-from-may", month="2026-05", recurring=True, daily_budget="1100"
    )
    assert changed["daily_budget"] == "1100.00"
    assert changed["recurring"]
    assert service.get_budget("2026-06")["daily_budget"] == "1100.00"


def test_stale_budget_editor_cannot_overwrite_new_agent_budget(service):
    budget(service)
    shown = service.get_budget("2026-05")
    budget(service, "agent-updated", month="2026-05", daily_budget="1700")
    # Both rows have revision=1; the effective source month distinguishes them.
    with pytest.raises(StoreError) as stale:
        budget(
            service,
            "stale-full-save",
            month="2026-05",
            daily_budget="1600",
            expected_revision=shown["revision"],
            expected_source_month=shown["source_month"],
        )
    assert stale.value.code == "revision_conflict"
    assert service.get_budget("2026-05")["daily_budget"] == "1700.00"
    now = service.get_budget("2026-05")
    saved = budget(
        service,
        "fresh-full-save",
        month="2026-05",
        daily_budget="1600",
        expected_revision=now["revision"],
        expected_source_month=now["source_month"],
    )
    assert saved["daily_budget"] == "1600.00"
    assert (
        budget(
            service,
            "fresh-full-save",
            month="2026-05",
            daily_budget="1600",
            expected_revision=now["revision"],
            expected_source_month=now["source_month"],
        )
        == saved
    )
