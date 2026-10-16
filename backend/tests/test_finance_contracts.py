"""Strict AI-first writes, truthful uncertain dates, recurrence and atomic corrections."""

import json
import sqlite3

import pytest
from pydantic import ValidationError

from zhixing_next.config import Settings
from zhixing_next.finance_service import FinanceService, migrate
from zhixing_next.finance_tools import create_finance_service_tools
from zhixing_next.store import Store, StoreError


@pytest.fixture
def service(tmp_path):
    store = Store(Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work"))
    with store._connection(write=True) as db:
        migrate(db)
    return FinanceService(store)


def patch(service, key, changes, month="2026-10", recurring=True, **kwargs):
    return service.patch_budget(
        month=month, idempotency_key=key, recurring=recurring, changes=changes, **kwargs
    )


def record(service, key="record", **fields):
    return service.create_transaction(
        idempotency_key=key,
        kind=fields.pop("kind", "income"),
        amount=fields.pop("amount", "4800"),
        occurred_on=fields.pop("occurred_on", "2026-10-15"),
        **fields,
    )


def rent():
    return {
        "key": "quarterly-rent",
        "label": "住房",
        "amount": "3600",
        "kind": "fixed",
        "every_months": 3,
        "anchor_month": "2026-09",
        "due_day": 10,
        "monthly_cost": "1200",
    }


async def test_tool_amount_outside_changes_is_rejected_and_structured_amount_is_verified(service):
    conversation = service.store.create_conversation("contract regression")
    tools = {
        item.name: item
        for item in create_finance_service_tools(
            service.store.settings, conversation["id"], "strict-message"
        )
    }
    original = record(service)
    args = {
        "transaction_id": original["id"],
        "entry_key": "correct",
        "changes_json": "{}",
        "amount": "4500",
    }
    with pytest.raises(ValidationError, match="Extra inputs"):
        await tools["correct_finance_transaction"].ainvoke(args)
    assert service.list_transactions(month="2026-10")["items"][0]["amount"] == "4800.00"
    result = await tools["correct_finance_transaction"].ainvoke(
        {
            "transaction_id": original["id"],
            "entry_key": "correct-valid",
            "changes": {"amount": "4500"},
        }
    )
    assert result["amount"] == "4500.00" and result["verified"]
    assert result["changed_fields"] == ["amount"]
    with pytest.raises(StoreError, match="never both"):
        await tools["correct_finance_transaction"].ainvoke(
            {
                "transaction_id": original["id"],
                "entry_key": "ambiguous",
                "changes": {"amount": "1"},
                "changes_json": '{"amount":"2"}',
            }
        )


async def test_every_finance_tool_forbids_unknown_top_level_fields(service):
    conversation = service.store.create_conversation("schema")
    for tool in create_finance_service_tools(
        service.store.settings, conversation["id"], "schema-message"
    ):
        assert tool.args_schema.model_config["extra"] == "forbid", tool.name
    tools = {
        item.name: item
        for item in create_finance_service_tools(
            service.store.settings, conversation["id"], "schema-message"
        )
    }
    with pytest.raises(ValidationError):
        await tools["update_finance_budget"].ainvoke(
            {"month": "2026-10", "entry_key": "bad-nested", "changes": {"unexpected": "ignored?"}}
        )


def test_budget_patches_never_drop_income_or_unmentioned_rent(service):
    patch(
        service,
        "setup",
        {"expected_income": "14000", "savings_target": "8000", "commitments_upsert": [rent()]},
    )
    patch(service, "december-only", {"savings_target": "7000"}, month="2026-12", recurring=False)
    result = patch(
        service,
        "clear-target-only",
        {"clear_fields": ["savings_target"]},
        month="2026-12",
        recurring=False,
    )
    assert result["savings_target"] is None
    assert result["expected_income"] == "14000.00"
    assert result["commitments"][0]["amount"] == "3600.00"
    assert service.get_budget("2027-01")["savings_target"] == "8000.00"
    for changes in (
        {"expected_income": None},
        {"commitments": None},
        {"savings_target": "7", "clear_fields": ["savings_target"]},
    ):
        with pytest.raises(StoreError):
            patch(service, json.dumps(changes), changes)
    assert service.get_budget("2026-12")["expected_income"] == "14000.00"


def test_single_month_override_inherits_later_default_changes(service):
    patch(
        service,
        "default",
        {"expected_income": "14000", "savings_target": "8000", "commitments_upsert": [rent()]},
    )
    patch(service, "future-target", {"savings_target": "7000"}, month="2026-12", recurring=False)
    patch(service, "salary-change", {"expected_income": "14500"}, month="2026-11")
    assert service.get_budget("2026-12")["expected_income"] == "14500.00"
    assert service.get_budget("2026-12")["savings_target"] == "7000.00"
    changed_rent = {**rent(), "amount": "3900", "monthly_cost": "1300"}
    patch(service, "rent-change", {"commitments_upsert": [changed_rent]}, month="2026-11")
    assert service.get_budget("2026-12")["commitments"][0]["amount"] == "3900.00"


def test_recurring_patch_supersedes_only_same_month_changed_override_fields(service):
    patch(service, "default", {"expected_income": "14000", "savings_target": "8000"})
    patch(
        service,
        "override",
        {"expected_income": "12000", "savings_target": "7000"},
        month="2026-12",
        recurring=False,
    )
    patch(service, "new-default", {"expected_income": "15000"}, month="2026-12")
    assert service.get_budget("2026-12")["expected_income"] == "15000.00"
    assert service.get_budget("2026-12")["savings_target"] == "7000.00"
    assert service.get_budget("2027-01")["savings_target"] == "8000.00"


def test_legacy_commitment_list_is_keyed_upsert_not_replace(service):
    patch(service, "setup", {"commitments_upsert": [rent()]})
    patch(
        service,
        "legacy-small-update",
        {"commitments": [{"key": "metro", "label": "交通", "amount": "200", "kind": "fixed"}]},
    )
    assert {item["key"] for item in service.get_budget("2026-10")["commitments"]} == {
        "quarterly-rent",
        "metro",
    }
    patch(service, "explicit-remove", {"commitment_keys_remove": ["metro"]})
    assert [item["key"] for item in service.get_budget("2026-10")["commitments"]] == [
        "quarterly-rent"
    ]


def test_budget_revision_guard_and_idempotency_replay(service):
    first = patch(service, "setup", {"expected_income": "14000"})
    result = patch(
        service,
        "correct",
        {"expected_income": "14500"},
        expected_revision=first["revision"],
        expected_source_month=first["source_month"],
    )
    assert result["expected_income"] == "14500.00"
    assert (
        patch(
            service,
            "correct",
            {"expected_income": "14500"},
            expected_revision=first["revision"],
            expected_source_month=first["source_month"],
        )
        == result
    )
    with pytest.raises(StoreError) as error:
        patch(
            service,
            "stale",
            {"expected_income": "1"},
            expected_revision=first["revision"],
            expected_source_month=first["source_month"],
        )
    assert error.value.code == "revision_conflict"


def test_quarterly_rent_cash_reserve_is_not_monthly_cost_plus_payment(service):
    patch(service, "setup", {"commitments_upsert": [{**rent(), "paid_through": "2026-11"}]})
    october = service.summary(month="2026-10")
    assert october["commitments"]["monthly_cost"] == "1200.00"
    assert october["commitments"]["cash_due"] == "0.00"
    assert october["reservations"]["fixed"] == "0.00"
    assert october["commitments"]["items"][0]["next_due_on"] == "2026-12-10"
    december = service.summary(month="2026-12")
    assert december["commitments"]["monthly_cost"] == "1200.00"
    assert december["commitments"]["cash_due"] == "3600.00"
    assert december["reservations"]["total"] == "3600.00"


def test_paid_coverage_offsets_future_due_without_rewriting_payment_date(service):
    patch(service, "setup", {"commitments_upsert": [rent()]})
    paid = record(
        service,
        "early-quarter-payment",
        kind="expense",
        amount="3600",
        bucket="fixed",
        commitment_key="quarterly-rent",
        occurred_on="2026-10-15",
        coverage_start="2026-12",
        coverage_end="2027-02",
    )
    assert paid["occurred_on"] == "2026-10-15"
    december = service.summary(month="2026-12")
    assert december["totals"]["expense"] == "0.00"
    assert december["reservations"]["total"] == "0.00"
    assert december["commitments"]["items"][0]["next_due_on"] == "2027-03-10"
    record(
        service,
        "partial-refund",
        kind="refund",
        amount="100",
        related_transaction_id=paid["id"],
        occurred_on="2026-10-16",
    )
    assert service.summary(month="2026-12")["reservations"]["total"] == "100.00"


def test_month_precision_has_no_invented_day_or_daily_average(service):
    row = record(service, occurred_on=None, date_precision="month", date_start="2026-09")
    assert (row["date_start"], row["date_end"], row["date_precision"]) == (
        "2026-09-01",
        "2026-09-30",
        "month",
    )
    result = service.summary(month="2026-09")
    assert result["totals"]["income"] == "4800.00"
    assert result["coverage"]["recorded_days"] == 0
    assert "transaction_day_unknown" in result["coverage"]["gaps"]
    with pytest.raises(StoreError):
        record(service, "unknown-month", occurred_on=None, date_precision="month")


def test_cross_month_unknown_income_never_becomes_income_of_range_end_month(service):
    original = record(service)
    row = service.update_transaction(
        original["id"],
        idempotency_key="uncertain-history",
        date_precision="range",
        date_start="2026-08-05",
        date_end="2026-10-15",
    )
    assert row["occurred_on"] == "2026-10-15"  # compatibility storage, not accounting attribution
    for month in ("2026-08", "2026-09", "2026-10"):
        result = service.summary(month=month)
        assert result["totals"]["income"] == "0.00"
        assert result["unallocated"]["count"] == 1
        assert result["unallocated"]["items"][0]["id"] == original["id"]
        assert "cross_month_dates_unallocated" in result["coverage"]["gaps"]
    service.update_transaction(
        original["id"], idempotency_key="clarified", occurred_on="2026-09-30"
    )
    assert service.summary(month="2026-09")["totals"]["income"] == "4800.00"
    assert service.summary(month="2026-10")["unallocated"]["count"] == 0


def test_atomic_split_conserves_money_survives_retry_and_never_doubles_total(service):
    original = record(service)
    operations = [
        {
            "operation": "update",
            "transaction_id": original["id"],
            "expected_revision": 1,
            "fields": {"amount": "3000", "category": "工资"},
        },
        {
            "operation": "create",
            "fields": {
                "kind": "income",
                "amount": "1800",
                "occurred_on": "2026-10-15",
                "category": "奖金",
            },
        },
    ]
    first = service.apply_transaction_batch(idempotency_key="split", operations=operations)
    assert first["conserved"] and first["verified"]
    assert first["before"]["income"] == first["after"]["income"] == "4800.00"
    assert service.apply_transaction_batch(idempotency_key="split", operations=operations) == first
    assert service.list_transactions(month="2026-10")["total"] == 2
    assert service.summary(month="2026-10")["totals"]["income"] == "4800.00"


def test_failed_batch_rolls_back_all_rows_and_receipt(service):
    original = record(service)
    operations = [
        {"operation": "update", "transaction_id": original["id"], "fields": {"amount": "3000"}},
        {
            "operation": "create",
            "fields": {"kind": "income", "amount": "1000", "occurred_on": "2026-10-15"},
        },
    ]
    with pytest.raises(StoreError) as error:
        service.apply_transaction_batch(idempotency_key="bad-split", operations=operations)
    assert error.value.code == "batch_total_mismatch"
    assert service.list_transactions(month="2026-10")["items"][0]["amount"] == "4800.00"
    with service.store._connection() as db:
        assert (
            db.execute("SELECT COUNT(*) FROM finance_mutations WHERE key='bad-split'").fetchone()[0]
            == 0
        )
    operations[1]["fields"]["amount"] = "1800"
    assert service.apply_transaction_batch(idempotency_key="bad-split", operations=operations)[
        "conserved"
    ]


def test_classification_correction_in_batch_requires_explicit_reason(service):
    original = record(service)
    operations = [
        {"operation": "update", "transaction_id": original["id"], "fields": {"kind": "transfer"}}
    ]
    with pytest.raises(StoreError):
        service.apply_transaction_batch(
            idempotency_key="silent-total-change", operations=operations
        )
    with pytest.raises(StoreError):
        service.apply_transaction_batch(
            idempotency_key="no-reason", operations=operations, conserve_total=False
        )
    service.apply_transaction_batch(
        idempotency_key="transfer-not-income",
        operations=operations,
        conserve_total=False,
        reason="用户明确这是账户间转入",
    )
    result = service.summary(month="2026-10")
    assert result["totals"]["income"] == "0.00" and result["totals"]["transfer"] == "4800.00"


def test_income_schedule_uses_shared_date_helper_and_never_doubles_received_income(service):
    patch(
        service,
        "schedule",
        {"expected_income": "4800", "income_schedule": {"rule": "last_business_day"}},
    )
    record(service)
    result = service.summary(month="2026-10")
    assert result["expected_income_on"] == "2026-10-30"
    assert result["income_schedule"]["calendar_basis"] == "weekdays_only"
    assert result["projection"]["income"] == "4800.00"
    assert result["projection"]["expected_income_remaining"] == "0.00"
    assert service.summary(month="2026-12")["expected_income_on"] == "2026-12-31"


def test_old_override_migration_is_idempotent_and_does_not_freeze_unchanged_fields(service):
    patch(service, "base", {"expected_income": "14000", "savings_target": "8000"})
    old = {
        "expected_income": "14000.00",
        "savings_target": "7000.00",
        "daily_budget": None,
        "commitments": [],
        "coverage_start": None,
        "coverage_through": None,
    }
    with service.store._connection(write=True) as db:
        db.execute(
            "INSERT INTO finance_budgets VALUES(?,0,?,1,?)",
            ("2026-12", json.dumps(old), "migration"),
        )
        migrate(db)
        before = db.execute(
            "SELECT data_json FROM finance_budgets WHERE month='2026-12'"
        ).fetchone()[0]
        migrate(db)
        assert (
            db.execute("SELECT data_json FROM finance_budgets WHERE month='2026-12'").fetchone()[0]
            == before
        )
    patch(service, "raise", {"expected_income": "15000"}, month="2026-11")
    assert service.get_budget("2026-12")["expected_income"] == "15000.00"
    assert service.get_budget("2026-12")["savings_target"] == "7000.00"
    with sqlite3.connect(service.store.db_path) as db:
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_uncertain_expense_date_does_not_imply_refund_precedes_it(service):
    original = record(
        service,
        kind="expense",
        amount="100",
        occurred_on=None,
        date_precision="month",
        date_start="2026-10",
    )
    refund = record(
        service,
        "refund",
        kind="refund",
        amount="20",
        occurred_on="2026-10-15",
        related_transaction_id=original["id"],
    )
    assert refund["amount"] == "20.00"
    service.update_transaction(
        original["id"],
        idempotency_key="wider-uncertainty",
        date_precision="range",
        date_start="2026-09-01",
        date_end="2026-10-31",
    )
    with pytest.raises(StoreError, match="follow its refunds"):
        service.update_transaction(
            original["id"], idempotency_key="actually-after-refund", occurred_on="2026-10-16"
        )


def test_ambiguous_partial_cumulative_overlap_is_explicitly_not_exact(service):
    record(
        service,
        "cumulative",
        kind="expense",
        amount="200",
        entry_type="aggregate",
        period_start="2026-10-01",
        occurred_on="2026-10-10",
    )
    record(
        service,
        "uncertain",
        kind="expense",
        amount="80",
        occurred_on=None,
        date_precision="range",
        date_start="2026-10-08",
        date_end="2026-10-12",
    )
    result = service.summary(month="2026-10")
    assert "uncertain_record_overlaps_cumulative_total" in result["coverage"]["gaps"]
    assert "totals_include_potential_overlap_not_exact" in result["projection"]["assumptions"]
    assert not result["projection"]["reliable"]


def test_conflicting_date_fields_never_silently_choose_one(service):
    with pytest.raises(StoreError, match="conflicts"):
        record(service, date_end="2026-10-16")
    with pytest.raises(StoreError, match="never invent individual payment months"):
        record(service, occurred_on="2026-10-15", date_precision="month", date_start="2026-09")


@pytest.mark.parametrize(
    "category,note",
    [
        ("公积金提取", "转入银行卡"),
        ("提取公积金", ""),
        ("存款取出", ""),
        ("余额", "已有余额提现"),
        ("理财", "赎回本金"),
        ("provident fund withdrawal", ""),
        ("savings withdrawal", ""),
    ],
)
def test_explicit_existing_asset_withdrawal_is_rejected_as_income_then_saved_as_transfer(
    service, category, note
):
    with pytest.raises(StoreError) as error:
        record(service, "incorrect-income", category=category, note=note)
    assert error.value.code == "existing_asset_is_transfer"
    assert "kind=transfer" in str(error.value)
    assert service.list_transactions(month="2026-10")["total"] == 0
    row = record(service, "correct-transfer", kind="transfer", category=category, note=note)
    assert row["kind"] == "transfer"


@pytest.mark.parametrize("category", ["工资", "公积金新缴存", "存款利息收入", "理财新收益"])
def test_new_external_earnings_and_contributions_are_still_income(service, category):
    assert record(service, category=category)["kind"] == "income"


@pytest.mark.parametrize(
    "old_label,new_label",
    [
        ("房租（月度预留）+水电", "租金（季度）"),
        ("地铁通勤（月度预留）", "通勤"),
        ("手机套餐", "话费"),
        ("医疗保险（月度预留）", "医疗保险"),
        ("音乐订阅（月度预留）", "音乐订阅"),
    ],
)
def test_same_purpose_key_conflict_gives_actionable_keys_without_writing(
    service, old_label, new_label
):
    patch(
        service,
        "old",
        {
            "commitments_upsert": [
                {"key": "existing-cost", "label": old_label, "amount": "900", "kind": "fixed"}
            ]
        },
    )
    incoming = {
        "key": "replacement-cost",
        "label": new_label,
        "amount": "2700",
        "kind": "fixed",
        "every_months": 3,
        "anchor_month": "2026-09",
        "monthly_cost": "900",
    }
    with pytest.raises(StoreError) as error:
        patch(service, "would-duplicate", {"commitments_upsert": [incoming]})
    assert error.value.code == "duplicate_commitment"
    assert "existing-cost" in str(error.value) and "Reuse its key" in str(error.value)
    assert len(service.get_budget("2026-10")["commitments"]) == 1
    result = patch(
        service,
        "explicit-replacement",
        {"commitments_upsert": [incoming], "commitment_keys_remove": ["existing-cost"]},
    )
    assert [item["key"] for item in result["commitments"]] == ["replacement-cost"]
    assert result["verification"]["monthly_cost"] == "900.00"
    assert result["verification"]["cash_due"] == "0.00"
    assert result["verification"]["checked_against_saved_records"]


def test_distinct_same_purpose_cost_requires_explicit_coexistence(service):
    patch(
        service,
        "first-property",
        {
            "commitments_upsert": [
                {"key": "home", "label": "房租", "amount": "900", "kind": "fixed"}
            ]
        },
    )
    result = patch(
        service,
        "explicit-second-property",
        {
            "commitments_upsert": [
                {
                    "key": "other-property",
                    "label": "另一处租金",
                    "amount": "100",
                    "kind": "fixed",
                    "separate_from_keys": ["home"],
                }
            ]
        },
    )
    assert len(result["commitments"]) == 2
    assert result["verification"]["remaining_due"] == "1000.00"


def test_quarterly_payment_cannot_silently_become_monthly_amount(service):
    with pytest.raises(StoreError, match="actual payment amount divided"):
        patch(
            service,
            "wrong-amount",
            {"commitments_upsert": [{**rent(), "amount": "1200", "monthly_cost": "1200"}]},
        )
    rounded = {**rent(), "amount": "1000", "monthly_cost": "333.33"}
    result = patch(service, "cent-rounding", {"commitments_upsert": [rounded]})
    assert result["verification"]["monthly_cost"] == "333.33"


def test_same_patch_cannot_introduce_two_keys_for_one_cost(service):
    values = [
        {"key": key, "label": label, "amount": "900", "kind": "fixed"}
        for key, label in [("rent-a", "房租"), ("rent-b", "租金")]
    ]
    with pytest.raises(StoreError) as error:
        patch(service, "duplicate-new-pair", {"commitments_upsert": values})
    assert error.value.code == "duplicate_commitment"
    assert service.get_budget("2026-10")["commitments"] == []


async def test_real_graph_sees_finance_errors_and_corrects_without_false_success(tmp_path):
    from langchain_core.messages import AIMessage, ToolMessage
    from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls, run_agent

    settings = make_settings(tmp_path)
    store = Store(settings)
    service = FinanceService(store)
    patch(
        service,
        "initial",
        {
            "commitments_upsert": [
                {
                    "key": "existing-rent",
                    "label": "房租（月度预留）",
                    "amount": "900",
                    "kind": "fixed",
                }
            ]
        },
    )
    run = make_run("finance-errors")
    run["agent"] = store.get_agent("finance")

    def call(name, args, identifier):
        return AIMessage(
            content="",
            tool_calls=[{"name": name, "args": args, "id": identifier, "type": "tool_call"}],
        )

    withdrawal = {
        "entry_key": "withdrawal",
        "kind": "income",
        "amount": "100",
        "occurred_on": "2026-10-15",
        "category": "公积金提取",
    }
    quarterly = {
        "key": "new-rent",
        "label": "季度租金",
        "kind": "fixed",
        "amount": "2700",
        "every_months": 3,
        "anchor_month": "2026-09",
        "monthly_cost": "900",
    }
    model = ScriptedModel(
        replies=[
            call("record_finance_transaction", withdrawal, "wrong-income"),
            call(
                "record_finance_transaction",
                {**withdrawal, "kind": "transfer", "entry_key": "withdrawal-correct"},
                "correct-transfer",
            ),
            call(
                "update_finance_budget",
                {
                    "entry_key": "new-quarter",
                    "month": "2026-10",
                    "changes": {"commitments_upsert": [quarterly]},
                },
                "duplicate-rent",
            ),
            call(
                "update_finance_budget",
                {
                    "entry_key": "reuse-existing",
                    "month": "2026-10",
                    "changes": {"commitments_upsert": [{**quarterly, "key": "existing-rent"}]},
                },
                "correct-cycle",
            ),
            call("get_finance_summary", {"month": "2026-10"}, "readback"),
            AIMessage(content="已核对实际保存的分类及周期。"),
        ]
    )
    result = await run_agent(
        settings,
        run,
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    assert result == "已核对实际保存的分类及周期。"
    messages = {
        message.tool_call_id: message
        for context in model.seen
        for message in context
        if isinstance(message, ToolMessage)
    }
    assert messages["wrong-income"].status == "error"
    assert (
        "existing_asset_is_transfer" in messages["wrong-income"].content
        and "kind=transfer" in messages["wrong-income"].content
    )
    assert messages["duplicate-rent"].status == "error"
    assert (
        "existing-rent" in messages["duplicate-rent"].content
        and "Reuse its key" in messages["duplicate-rent"].content
    )
    saved = json.loads(messages["readback"].content)
    assert saved["totals"]["income"] == "0.00" and saved["totals"]["transfer"] == "100.00"
    assert len(saved["budget"]["commitments"]) == 1
    assert saved["commitments"]["monthly_cost"] == "900.00"
