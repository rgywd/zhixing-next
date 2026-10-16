"""Known-flow asset reconciliation must be exact, scoped, and read-only."""

import pytest

from zhixing_next.config import Settings
from zhixing_next.finance_reconcile import reconcile_assets
from zhixing_next.finance_service import FinanceService, migrate
from zhixing_next.store import Store, StoreError


@pytest.fixture
def service(tmp_path):
    store = Store(Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work"))
    with store._connection(write=True) as db:
        migrate(db)
    return FinanceService(store)


def record(service, key, amount, **fields):
    return service.create_transaction(
        idempotency_key=key,
        kind=fields.pop("kind", "expense"),
        amount=amount,
        occurred_on=fields.pop("occurred_on", "2026-04-10"),
        **fields,
    )


def reconcile(service, **fields):
    return reconcile_assets(
        service,
        start_date=fields.pop("start_date", "2026-04-01"),
        end_date=fields.pop("end_date", "2026-04-30"),
        opening_assets=fields.pop("opening_assets", "10000"),
        closing_assets=fields.pop("closing_assets", "10000"),
        **fields,
    )


def codes(result):
    return {gap["code"] for gap in result["gaps"]}


def test_transfer_never_becomes_income_or_asset_gain(service):
    transaction = record(service, "own-funds", "4200", kind="transfer", note="自己账户间转账")
    result = reconcile(service, closing_assets="9500")
    assert result["flows"]["income"] == "0.00"
    assert result["flows"]["transfer"] == "4200.00"
    assert result["flows"]["transfer_excluded_from_asset_change"]
    assert transaction["id"] in result["included"]["transaction_ids"]
    assert result["calculation"]["unexplained_difference"] == "500.00"
    assert result["calculation"]["difference_meaning"] == "unexplained_net_outflow"
    assert "不会写入账本" in result["calculation"]["interpretation"]


def test_decimal_income_refund_and_actual_values_in_formula(service):
    purchase = record(service, "purchase", "14.17")
    record(service, "refund", "4.05", kind="refund", related_transaction_id=purchase["id"])
    record(service, "salary", "100.21", kind="income")
    result = reconcile(service, opening_assets="300.10", closing_assets="380.19")
    assert result["flows"]["expense"] == "14.17"
    assert result["flows"]["refund"] == "4.05"
    assert result["flows"]["net_expense"] == "10.12"
    assert result["calculation"]["expected_closing"] == "390.19"
    assert result["calculation"]["actual_net_change"] == "80.09"
    assert result["calculation"]["unexplained_difference"] == "10.00"
    assert all(
        value in result["calculation"]["formula"]
        for value in ("300.10", "100.21", "10.12", "390.19", "380.19", "80.09", "10.00")
    )


def test_refund_counts_in_its_actual_period_even_when_purchase_was_earlier(service):
    purchase = record(service, "old-purchase", "80", occurred_on="2026-03-31")
    record(service, "new-refund", "25", kind="refund", related_transaction_id=purchase["id"])
    result = reconcile(service, closing_assets="10025")
    assert result["flows"]["expense"] == "0.00"
    assert result["flows"]["refund"] == "25.00"
    assert result["flows"]["net_expense"] == "-25.00"
    assert result["calculation"]["unexplained_difference"] == "0.00"
    assert purchase["id"] not in result["included"]["transaction_ids"]


def test_cross_month_range_counted_only_when_wholly_in_period(service):
    item = record(
        service,
        "uncertain-pay",
        "250",
        kind="income",
        occurred_on=None,
        date_precision="range",
        date_start="2026-03-22",
        date_end="2026-04-08",
    )
    whole = reconcile(service, start_date="2026-03-01")
    assert whole["flows"]["income"] == "250.00"
    assert item["id"] in whole["included"]["transaction_ids"]
    partial = reconcile(service)
    assert partial["flows"]["income"] == "0.00"
    assert item["id"] in partial["excluded"]["transaction_ids"]
    assert "transaction_partially_intersects_period" in codes(partial)


def test_month_precision_does_not_require_invented_day(service):
    item = record(
        service,
        "monthly",
        "90",
        occurred_on=None,
        date_precision="month",
        date_start="2026-04",
    )
    whole = reconcile(service)
    assert whole["flows"]["net_expense"] == "90.00"
    assert item["id"] in whole["included"]["transaction_ids"]
    assert reconcile(service, start_date="2026-04-02")["flows"]["net_expense"] == "0.00"


def test_cumulative_uses_its_full_period_not_only_end_day(service):
    aggregate = record(service, "total", "100", entry_type="aggregate", period_start="2026-04-01")
    partial = reconcile(service, start_date="2026-04-05")
    assert partial["flows"]["net_expense"] == "0.00"
    assert aggregate["id"] in partial["excluded"]["transaction_ids"]
    assert "cumulative_partially_intersects_period" in codes(partial)


def test_cumulative_details_and_refunds_are_not_counted_twice(service):
    aggregate = record(service, "total", "100", entry_type="aggregate", period_start="2026-04-01")
    purchase = record(service, "known", "60", occurred_on="2026-04-04")
    refund = record(
        service,
        "refund",
        "10",
        kind="refund",
        occurred_on="2026-04-05",
        related_transaction_id=purchase["id"],
    )
    record(service, "after-total", "15", occurred_on="2026-04-11")
    result = reconcile(service)
    assert result["flows"]["net_expense"] == "115.00"
    assert result["flows"]["refund"] == "10.00"
    assert result["flows"]["expense"] == "125.00"
    assert set(result["included"]["covered_transaction_ids"]) == {purchase["id"], refund["id"]}
    assert aggregate["id"] in result["included"]["transaction_ids"]


def test_income_aggregate_also_excludes_covered_details(service):
    record(
        service,
        "income-total",
        "200",
        kind="income",
        entry_type="aggregate",
        period_start="2026-04-01",
    )
    record(service, "income-detail", "80", kind="income", occurred_on="2026-04-02")
    assert reconcile(service)["flows"]["income"] == "200.00"


def test_known_details_exceeding_cumulative_are_kept_with_conflict(service):
    record(service, "total", "100", entry_type="aggregate", period_start="2026-04-01")
    record(service, "detail", "120", occurred_on="2026-04-03")
    result = reconcile(service)
    assert result["flows"]["net_expense"] == "120.00"
    assert "details_exceed_cumulative_total" in codes(result)


def test_partial_overlap_with_aggregate_never_guesses_detail_allocation(service):
    record(service, "total", "100", entry_type="aggregate", period_start="2026-04-01")
    item = record(
        service,
        "spanning",
        "80",
        occurred_on=None,
        date_precision="range",
        date_start="2026-04-05",
        date_end="2026-04-20",
    )
    result = reconcile(service)
    assert result["flows"]["net_expense"] == "100.00"
    assert item["id"] in result["excluded"]["transaction_ids"]
    assert "uncertain_record_overlaps_cumulative_total" in codes(result)


def test_zero_no_change_is_read_only_not_proof_of_complete_records(service):
    with service.store._connection() as db:
        before = "\n".join(db.iterdump())
    result = reconcile(service, opening_assets="0", closing_assets="0", approximate=False)
    assert result["scope"] == "known_flows_only"
    assert result["read_only"] is True
    assert result["calculation"]["unexplained_difference"] == "0.00"
    assert result["calculation"]["difference_meaning"] == "balanced_known_flows"
    assert codes(result) == {"record_coverage_not_confirmed"}
    with service.store._connection() as db:
        assert "\n".join(db.iterdump()) == before
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_nonempty_ledger_and_budget_are_unchanged_by_unexplained_gain(service):
    record(service, "lunch", "25.10")
    service.set_budget(month="2026-04", idempotency_key="plan", expected_income="100")
    with service.store._connection() as db:
        before = "\n".join(db.iterdump())
    result = reconcile(service, closing_assets="11000")
    assert result["calculation"]["unexplained_difference"] == "-1025.10"
    assert result["calculation"]["difference_meaning"] == "unexplained_net_inflow"
    assert result["flows"]["income"] == "0.00"  # Expected salary is not an actual flow.
    with service.store._connection() as db:
        assert "\n".join(db.iterdump()) == before


def test_coverage_requires_each_month_and_does_not_inherit_previous_confirmation(service):
    service.set_budget(
        month="2026-03",
        idempotency_key="coverage",
        coverage_start="2026-03-01",
        coverage_through="2026-03-31",
    )
    partial = reconcile(service, start_date="2026-03-01", approximate=False)
    assert not partial["coverage"]["complete"]
    assert [item["complete"] for item in partial["coverage"]["months"]] == [True, False]
    exact = reconcile(service, start_date="2026-03-15", end_date="2026-03-31", approximate=False)
    assert exact["coverage"]["complete"] and exact["gaps"] == []
    assert "approximate_assets" in codes(
        reconcile(service, start_date="2026-03-01", end_date="2026-03-31")
    )


def test_ledger_query_does_not_drop_rows_after_first_page(service):
    for index in range(65):
        record(service, f"small-{index}", "0.01")
    assert reconcile(service)["flows"]["net_expense"] == "0.65"


@pytest.mark.parametrize(
    "fields",
    [
        {"start_date": "2026-05-01"},
        {"opening_assets": "-1"},
        {"closing_assets": "NaN"},
        {"approximate": "false"},
        {"end_date": "2026-04-31"},
    ],
)
def test_invalid_dates_and_assets_are_rejected(service, fields):
    with pytest.raises(StoreError):
        reconcile(service, **fields)
