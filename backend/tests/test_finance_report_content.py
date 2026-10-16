"""Finance report text is built from real ledger formulas, never model arithmetic."""

import re

import pytest

from zhixing_next.config import Settings
from zhixing_next.finance_report import build_finance_report
from zhixing_next.finance_service import FinanceService
from zhixing_next.store import Store, StoreError


@pytest.fixture
def service(tmp_path):
    return FinanceService(
        Store(Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work"))
    )


def record(service, key, amount, **fields):
    return service.create_transaction(
        idempotency_key=key,
        kind=fields.pop("kind", "expense"),
        amount=amount,
        occurred_on=fields.pop("occurred_on", "2026-10-10"),
        **fields,
    )


def report(service, **fields):
    return build_finance_report(
        service,
        start_date=fields.pop("start_date", "2026-10-01"),
        end_date=fields.pop("end_date", "2026-10-16"),
        **fields,
    )


def setup_budget(service):
    service.set_budget(
        month="2026-09",
        idempotency_key="budget",
        expected_income="16500",
        savings_target="10000",
        daily_budget="4000",
        commitments=[
            {
                "key": "rent",
                "label": "住房",
                "kind": "fixed",
                "amount": "3600",
                "every_months": 3,
                "anchor_month": "2026-09",
                "due_day": 10,
                "monthly_cost": "1200",
            }
        ],
        income_schedule={"rule": "last_business_day"},
    )
    record(
        service,
        "rent-paid",
        "3600",
        occurred_on="2026-09-10",
        bucket="fixed",
        commitment_key="rent",
        coverage_start="2026-09",
        coverage_end="2026-11",
    )


def test_formula_is_exact_reconciliation_receipt_and_transfer_never_changes_income(service):
    record(service, "pay", "12000", kind="income")
    record(service, "device", "3000")
    record(service, "own-transfer", "5000", kind="transfer")
    result = report(service, opening_assets="20000", closing_assets="28000", approximate=False)
    facts, content = result["facts"], result["content"]
    assert facts["flows"]["income"] == "12000.00"
    assert facts["flows"]["transfer"] == "5000.00"
    assert facts["calculation"]["expected_closing"] == "29000.00"
    assert facts["calculation"]["unexplained_difference"] == "1000.00"
    assert facts["calculation"]["formula"] in content
    assert "内部转账共 ¥5000.00" in content
    assert "不计入新增收入或合计资产变化" in content
    assert "34000.00" not in content  # Incorrectly adding the transfer to asset income.
    assert "差额不是已经发生的消费或收入" in content
    assert "假设" not in content and "额外缴存" not in content


def test_closing_and_next_due_month_use_saved_remaining_not_monthly_cost(service):
    setup_budget(service)
    record(service, "living", "2300")
    result = report(service)
    budgets = result["facts"]["budgets"]
    assert [item["month"] for item in budgets] == ["2026-10", "2026-12"]
    current, future = budgets
    assert current["total_spend_budget"] == "4200.00"
    assert current["daily_budget"] == "1700.00"
    assert current["reserved_cash"] == "0.00"
    assert future["total_spend_budget"] == "2900.00"
    assert future["reserved_cash"] == "3600.00"
    assert future["monthly_cost"] == "1200.00"
    assert future["cash_due"] == "3600.00"
    assert (
        "16500.00 - 结余目标 10000.00 - 已记净支出 0.00 - 待付预留 3600.00 = 剩余可支配 2900.00"
        in future["formula"]
    )
    for item in budgets:
        expected = service.summary(month=item["month"], as_of="2026-10-16")
        assert item["total_spend_budget"] == expected["remaining"]["total_spend_budget"]
        assert item["daily_budget"] == expected["remaining"]["daily_budget"]
        assert item["formula"] in result["content"]
    assert "月成本 ¥1200.00；本月到期现金 ¥3600.00；尚待支付 ¥3600.00" in result["content"]
    assert "5300.00" not in result["content"]  # A monthly cost is not the quarterly cash due.
    assert "预计发薪日 2026-12-31，仅是日程安排" in result["content"]
    assert "未接入官方节假日调休" in result["content"]


def test_range_and_month_dates_keep_actual_precision_and_coverage_uses_human_terms(service):
    record(
        service,
        "month-device",
        "500",
        occurred_on=None,
        date_precision="month",
        date_start="2026-06",
        category="设备",
    )
    record(
        service,
        "range-pay",
        "800",
        kind="income",
        occurred_on=None,
        date_precision="range",
        date_start="2026-06-12",
        date_end="2026-07-09",
        category="历史工资",
    )
    record(
        service,
        "rent",
        "1200",
        occurred_on="2026-07-10",
        coverage_start="2026-07",
        coverage_end="2026-09",
        category="房租",
    )
    content = report(service, start_date="2026-06-01", end_date="2026-07-31")["content"]
    assert "2026年6月（具体日期未确定）" in content
    assert "2026-06-12 至 2026-07-09（具体付款日未确定）" in content
    assert "| 2026-06-30 |" not in content
    assert "支付对应2026年7月至2026年9月费用" in content
    assert not any(
        word in content
        for word in (
            "coverage_start",
            "coverage_end",
            "revision",
            "source_id",
            "date_precision",
            "commitment_key",
            "补表",
            "补齐",
            "请提供",
        )
    )
    assert not re.search(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", content)


def test_without_observations_uses_same_totals_without_invented_assets(service):
    record(service, "total", "200", entry_type="aggregate", period_start="2026-10-01")
    original = record(service, "detail", "80", occurred_on="2026-10-03")
    record(
        service,
        "refund",
        "10",
        kind="refund",
        occurred_on="2026-10-04",
        related_transaction_id=original["id"],
    )
    record(service, "transfer", "1000", kind="transfer")
    without_assets = report(service)
    with_assets = report(service, opening_assets="5000", closing_assets="4800")
    assert without_assets["facts"]["flows"] == with_assets["facts"]["flows"]
    assert without_assets["facts"]["flows"]["net_expense"] == "200.00"
    assert without_assets["facts"]["assets"] is None
    assert without_assets["facts"]["calculation"] is None
    assert "未提供同范围的期初、期末资产观察" in without_assets["content"]
    assert "预计期末资产" not in without_assets["content"]
    assert "已含在期间累计金额中" in without_assets["content"]


def test_one_snapshot_and_explicit_as_of_are_used_for_every_business_read(service, monkeypatch):
    setup_budget(service)
    connections, observations, dates = [], [], []
    original_summary, original_reconcile = service.summary, service.reconcile_assets

    def summary(**kwargs):
        connections.append(kwargs["_db"])
        dates.append(kwargs["as_of"])
        assert kwargs["_db"].in_transaction
        return original_summary(**kwargs)

    def reconcile(**kwargs):
        connections.append(kwargs["_db"])
        observations.append((kwargs["opening_assets"], kwargs["closing_assets"]))
        assert kwargs["_db"].in_transaction
        return original_reconcile(**kwargs)

    monkeypatch.setattr(service, "summary", summary)
    monkeypatch.setattr(service, "reconcile_assets", reconcile)
    first = report(service)
    second = report(service)
    assert first == second
    assert observations == [(None, None), (None, None)]
    assert dates == ["2026-10-16"] * 4
    assert connections[0] is connections[1] is connections[2]
    assert connections[3] is connections[4] is connections[5]


def test_partial_ranges_are_explained_and_not_split_into_invented_days(service):
    record(
        service,
        "range",
        "800",
        occurred_on=None,
        date_precision="range",
        date_start="2026-09-01",
        date_end="2026-10-10",
    )
    result = report(service)
    assert result["facts"]["flows"]["net_expense"] == "0.00"
    assert "2026-09-01 至 2026-10-10" in result["content"]
    assert "未猜测拆分到某天或某月" in result["content"]
    assert "尚无足够记录" in result["content"]


def test_detail_limit_changes_display_only_and_markdown_is_escaped(service):
    for index in range(105):
        record(
            service,
            f"meal-{index}",
            "0.01",
            category="<script>\n## 餐食|[外链](https://example.test)",
            note="<script>\n## x [外链](https://example.test) " + "长" * 900,
        )
    result = report(service)
    assert result["facts"]["record_count"] == 105
    assert result["facts"]["shown_record_count"] == 100
    assert result["facts"]["flows"]["net_expense"] == "1.05"
    assert "其余记录可在账本中查看" in result["content"]
    assert "<script>" not in result["content"]
    assert "\n## x" not in result["content"]
    assert "\\[外链\\]" in result["content"]
    assert len(result["content"].encode()) <= 256 * 1024
    assert result["content"].startswith("# 财务回顾\n")


def test_raw_note_is_not_a_report_field_or_a_route_for_internal_storage_metadata(service):
    record(
        service,
        "lunch",
        "35",
        category="午饭",
        note="internal note revision=99 coverage hidden source_id=private",
    )
    content = report(service)["content"]
    assert "午饭" in content
    assert not any(
        word in content for word in ("revision", "coverage", "source_id", "internal note")
    )


def test_builder_never_mutates_records_budget_or_operation_receipts(service):
    setup_budget(service)
    record(service, "expense", "75.50")
    with service.store._connection() as db:
        before = "\n".join(db.iterdump())
    report(service, opening_assets="10000", closing_assets="9000")
    with service.store._connection() as db:
        assert "\n".join(db.iterdump()) == before


def test_safe_receipt_has_no_original_ids_or_raw_rows(service):
    row = record(service, "expense", "75.50")
    setup_budget(service)
    facts = report(service, opening_assets="10000", closing_assets="9000")["facts"]
    assert row["id"] not in str(facts)
    assert "transaction_ids" not in str(facts)
    assert "revision" not in str(facts)
    assert facts["calculation"]["unexplained_difference"] == "924.50"


def test_inconsistent_budget_receipt_is_rejected_instead_of_printing_wrong_formula(
    service, monkeypatch
):
    setup_budget(service)
    original = service.summary

    def inconsistent(**kwargs):
        result = original(**kwargs)
        result["remaining"]["total_spend_budget"] = "999.99"
        return result

    monkeypatch.setattr(service, "summary", inconsistent)
    with pytest.raises(StoreError, match="inconsistent"):
        report(service)


@pytest.mark.parametrize(
    "fields",
    [
        {"opening_assets": "100"},
        {"closing_assets": "100"},
        {"approximate": "false"},
        {"start_date": "2026-11-01"},
    ],
)
def test_invalid_report_inputs_are_rejected_not_turned_into_questions(service, fields):
    with pytest.raises(StoreError):
        report(service, **fields)
