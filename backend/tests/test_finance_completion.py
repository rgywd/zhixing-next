"""Final finance replies describe immutable report facts without provider guesses."""

import copy

import pytest
from test_finance_report_publication import fixture, publisher

from zhixing_next.finance_report import format_finance_completion


def facts():
    rent = {
        "label": "房租",
        "monthly_cost": "1200.00",
        "cash_due": "0.00",
        "remaining_due": "0.00",
        "next_due_on": "2026-06-10",
        "next_due_month": "2026-06",
        "next_due_precision": "day",
    }
    return {
        "period": {"start_date": "2026-03-01", "end_date": "2026-04-09"},
        "record_count": 3,
        "flows": {"income": "4800.00", "net_expense": "1700.00", "transfer": "100.00"},
        "assets": {"approximate": True},
        "calculation": {"unexplained_difference": "1100.00"},
        "budgets": [
            {"month": "2026-04", "savings_target": "8000.00", "commitments": [rent]},
            {
                "month": "2026-06",
                "commitments": [{**rent, "cash_due": "3600.00", "remaining_due": "3600.00"}],
            },
        ],
    }


def test_completion_quotes_only_actual_report_facts_and_due_cash():
    text = format_finance_completion(facts())
    assert text.startswith("财务回顾已交付，可直接打开附件。")
    assert "2026-03-01 至 2026-04-09 的 3 条记录" in text
    assert "已知收入 ¥4800.00，净支出 ¥1700.00" in text
    assert "内部转账 ¥100.00 单列，不计入新增收入" in text
    assert "结余目标 ¥8000.00，可以调整" in text
    assert "下一房租付款安排为 2026-06-10，到期现金 ¥3600.00" in text
    assert "1200.00" not in text  # Monthly cost cannot replace payment cash.
    assert "差额 约 ¥1100.00，仅为未解释的资产变化，未认定为消费" in text
    for forbidden in (
        "很可能",
        "日常消费",
        "请",
        "补表",
        "补充",
        "全部完成",
        "全部记好",
        "?",
        "？",
        "revision",
        "coverage",
        "source_id",
    ):
        assert forbidden not in text


def test_completion_never_guesses_payment_day_or_assets_without_observations():
    value = facts()
    value["assets"] = value["calculation"] = None
    for budget in value["budgets"]:
        budget["commitments"][0].update(next_due_on=None, next_due_precision="month")
    text = format_finance_completion(value)
    assert "2026年6月（具体日未确定）" in text
    assert "2026-06-01" not in text and "差额" not in text
    value["budgets"][0]["savings_target"] = None
    assert "结余目标" not in format_finance_completion(value)


@pytest.mark.parametrize("difference", ["-200.00", "0.00", "200.00"])
def test_difference_retains_sign_without_inventing_a_consumption_explanation(difference):
    value = facts()
    value["calculation"]["unexplained_difference"] = difference
    text = format_finance_completion(value)
    assert "¥" + difference in text
    assert "新增缴存" not in text and "漏记" not in text and "日常消费" not in text


def test_completion_does_not_print_internal_fields_or_claim_other_actions_finished():
    value = facts()
    value["source_id"] = "fd1645c8-2eb8-445b-9496-7dd8b6b5a925"
    value["revision"] = 99
    value["coverage"] = {"missing": "ask the user"}
    value["budgets"][0]["commitments"][0]["note"] = "need six missing forms"
    text = format_finance_completion(value)
    assert "fd1645c8" not in text and "99" not in text
    assert "ask" not in text and "forms" not in text
    assert "所有" not in text and "已修复" not in text


def test_several_independent_rents_are_not_combined_or_arbitrarily_chosen():
    value = facts()
    value["budgets"][0]["commitments"].append(copy.deepcopy(value["budgets"][0]["commitments"][0]))
    text = format_finance_completion(value)
    assert "下一房租" not in text
    assert "结余目标" in text


async def test_completion_is_generated_in_real_artifact_and_reused_after_ledger_change(tmp_path):
    settings, store, service, run, arguments = fixture(tmp_path)
    events = []
    receipt = await publisher(settings, store, run, events).ainvoke(arguments)
    completion = receipt["finance"]["completion"]
    assert completion == format_finance_completion(receipt["finance"]["facts"])
    assert events[0][1]["finance"]["completion"] == completion
    service.create_transaction(
        idempotency_key="after-report", kind="income", amount="20", occurred_on="2026-04-09"
    )
    recovered = await publisher(settings, store, run, events).ainvoke(arguments)
    assert recovered["finance"]["completion"] == completion
    assert recovered == receipt and len(events) == 1


async def test_report_key_uses_only_actual_seen_input_context_and_preserves_legacy_scope(tmp_path):
    import hashlib
    import json

    from zhixing_next.finance_context import active_finance_input

    settings, store, service, run, arguments = fixture(tmp_path)
    events = []
    first = await publisher(settings, store, run, events).ainvoke(arguments)
    canonical_arguments = {
        "start_date": arguments["start_date"],
        "end_date": arguments["end_date"],
        "opening_assets": arguments["opening_assets"],
        "closing_assets": arguments["closing_assets"],
        "approximate": True,
        "filename": arguments["filename"],
    }
    original_key = hashlib.sha256(
        json.dumps(
            [run["message_id"], canonical_arguments],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    assert first["verification"]["finance_report_key"] == original_key
    assert first["verification"]["finance_input_id"] == run["message_id"]
    token = active_finance_input.set(run["message_id"])
    try:
        assert await publisher(settings, store, run, events).ainvoke(arguments) == first
    finally:
        active_finance_input.reset(token)
    # An unrelated ledger update does not change this completed input's snapshot.
    service.patch_budget(
        month="2026-03", idempotency_key="new-target", changes={"savings_target": "9000"}
    )
    assert await publisher(settings, store, run, events).ainvoke(arguments) == first
    token = active_finance_input.set("actually-seen-new-steer")
    try:
        changed = await publisher(settings, store, run, events).ainvoke(arguments)
        assert changed["verification"]["finance_report_key"] != original_key
        assert changed["verification"]["finance_input_id"] == "actually-seen-new-steer"
        assert changed["resource"]["id"] != first["resource"]["id"]
        assert changed["finance"]["facts"]["budgets"][0]["savings_target"] == "9000.00"
        assert "¥9000.00" in changed["finance"]["completion"]
        assert await publisher(settings, store, run, events).ainvoke(arguments) == changed
    finally:
        active_finance_input.reset(token)
    assert len(events) == 2
    assert events[1][1]["verification"]["finance_input_id"] == "actually-seen-new-steer"
    assert await publisher(settings, store, run, events).ainvoke(arguments) == first
    assert len(events) == 2 and active_finance_input.get() is None
