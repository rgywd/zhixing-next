"""Successful writes have a concise factual completion, independent of provider prose."""

import copy

from test_runtime import make_settings

from zhixing_next.finance_report import format_finance_write_completion
from zhixing_next.store import Store
from zhixing_next.tools import create_finance_tools


def summary():
    return {
        "month": "2026-04",
        "budget": {
            "expected_income": "14000.00",
            "savings_target": "8000.00",
            "commitments": [{"key": "rent", "label": "房租", "amount": "3600.00"}],
        },
        "commitments": {
            "items": [
                {
                    "key": "rent",
                    "label": "房租",
                    "next_due_on": None,
                    "next_due_month": "2026-06",
                    "next_due_precision": "month",
                }
            ]
        },
        "income_schedule": {"rule": "last_business_day"},
    }


def record(identifier="private-id", **fields):
    return {
        "id": identifier,
        "kind": "expense",
        "amount": "32.00",
        "deleted": False,
        "entry_type": "detail",
        "date_precision": "range",
        "date_start": "2026-03-01",
        "date_end": "2026-04-09",
        "occurred_on": "2026-04-09",
        **fields,
    }


def test_budget_only_completion_never_claims_rent_payment_or_report_publication():
    text = format_finance_write_completion(
        summary(), [{"tool": "update_finance_budget", "receipt": {"month": "2026-04"}}]
    )
    assert "保存预算修改" in text and "结余目标 ¥8000.00" in text
    assert "2026年6月（具体日未确定）" in text and "约定付款额 ¥3600.00" in text
    assert "付款安排不等于实际支出" in text and "未确认的支付不会自动入账" in text
    assert "最后一个工作日" in text and "仅作预计安排" in text
    for forbidden in (
        "报告",
        "已交租",
        "日常消费",
        "差额",
        "押金",
        "请",
        "补表",
        "全部",
        "？",
        "private-id",
        "revision",
        "coverage",
    ):
        assert forbidden not in text


def test_saved_records_preserve_actual_precision_and_deduplicate_same_record_updates():
    operations = [
        {"tool": "record_finance_transaction", "receipt": record()},
        {"tool": "correct_finance_transaction", "receipt": record(amount="40.00")},
        {
            "tool": "record_finance_transaction",
            "receipt": record(
                "another", date_precision="day", date_start="2026-04-09", date_end="2026-04-09"
            ),
        },
    ]
    text = format_finance_write_completion(summary(), operations)
    assert "新增 2 笔记录" in text and "纠正 1 笔" not in text
    assert "2026-03-01 至 2026-04-09（具体付款日未确定）" in text
    assert "private-id" not in text and "another" not in text


def test_batch_create_correct_and_delete_are_counted_only_from_actual_successes():
    operations = [
        {
            "tool": "apply_finance_transaction_batch",
            "receipt": {
                "items": [
                    {"operation": "create", "record": record("new")},
                    {"operation": "update", "record": record("corrected")},
                    {"operation": "delete", "record": {"id": "deleted", "deleted": True}},
                ]
            },
        },
        {"tool": "record_finance_transaction", "receipt": {"error": {"message": "not saved"}}},
    ]
    text = format_finance_write_completion(summary(), operations)
    assert "新增 1 笔记录" in text and "纠正 1 笔记录" in text and "删除 1 笔误记" in text
    assert "not saved" not in text and "deleted" not in text
    partial = summary()
    partial["write_completion_partial"] = True
    assert format_finance_write_completion(partial, operations).endswith(
        "另有操作尚未成功，以上只包含已核验的保存结果。"
    )


def test_empty_or_failed_receipts_do_not_claim_success_or_infer_missing_spending():
    assert format_finance_write_completion(summary(), []) == "当前没有可确认成功的财务写入回执。"
    assert (
        format_finance_write_completion(
            summary(),
            [{"tool": "record_finance_transaction", "receipt": {"error": {"code": "failed"}}}],
        )
        == "当前没有可确认成功的财务写入回执。"
    )


def test_known_due_day_is_kept_and_absent_budget_values_are_not_invented():
    value = copy.deepcopy(summary())
    value["commitments"]["items"][0].update(next_due_on="2026-06-12", next_due_precision="day")
    value["budget"]["expected_income"] = value["budget"]["savings_target"] = None
    text = format_finance_write_completion(
        value, [{"tool": "update_finance_budget", "receipt": {"month": "2026-04"}}]
    )
    assert "2026-06-12" in text
    assert "预计收入" not in text and "结余目标" not in text
    assert "预计收入 ¥0.00" not in text and "结余目标 ¥0.00" not in text


async def test_real_balance_save_and_remove_receipts_have_factual_completions(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("余额记录", agent_id="finance")["id"]
    tools = {item.name: item for item in create_finance_tools(settings, conversation)}
    saved = await tools["record_finance_observation"].ainvoke(
        {
            "kind": "balance",
            "platform": "备用账户",
            "amount": "500.00",
            "note": "private note revision=99 coverage hidden",
        }
    )
    operation = {"tool": "record_finance_observation", "receipt": saved}
    text = format_finance_write_completion(summary(), [operation, operation])
    assert "保存 1 条余额观察" in text
    assert "余额观察仅记录账户状态，不计为新增收入或支出。" in text
    assert "没有可确认成功" not in text
    for forbidden in (saved["id"], saved["note"], "revision", "coverage", "报告", "请补"):
        assert forbidden not in text

    removed = await tools["remove_finance_observation"].ainvoke({"observation_id": saved["id"]})
    assert removed == {"deleted": True}
    text = format_finance_write_completion(
        summary(), [{"tool": "remove_finance_observation", "receipt": removed}]
    )
    assert "删除 1 条财务观察" in text
    assert "不计为新增收入或支出" in text
    assert saved["id"] not in text and saved["note"] not in text
    assert "没有可确认成功" not in text


def test_unconfirmed_balance_removal_does_not_claim_success():
    for receipt in ({"deleted": False}, {"deleted": "true"}, {"error": {"code": "not_found"}}):
        assert format_finance_write_completion(
            summary(), [{"tool": "remove_finance_observation", "receipt": receipt}]
        ) == "当前没有可确认成功的财务写入回执。"
