import pytest
from langchain_core.messages import HumanMessage
from test_finance_mixed_reply import source
from test_finance_report_publication import Crash
from test_finance_write_stream import budget, events, execute, fixture, tool
from test_live_stream import StreamingModel, chunk

from zhixing_next.finance_context import active_finance_input, delegated_finance_input
from zhixing_next.finance_service import FinanceService
from zhixing_next.operations import Journal
from zhixing_next.runtime import _seen_finance_input


async def test_main_seen_steer_is_inherited_by_finance_advice_date_evidence_and_report(tmp_path):
    settings, store, run = fixture(tmp_path)
    source(store, run, "本月结余目标改成9000元。")
    run.pop("agent")
    run["agents"] = store.list_agents()["items"]
    sent = False

    async def on_emit(kind, data):
        nonlocal sent
        if not sent and kind == "reasoning.snapshot" and data["text"] == "先处理初始预算。":
            store.submit_message(run["conversation_id"], id="parent-steer", content="目标改成9500元，2026年10月16日晚餐32元记账，生成报告，并建议今晚外卖预算。", intent="steer", target_run_id=run["id"])
            sent = True

    advice = "今晚建议选择简单套餐，饮料可以省下。"
    model = StreamingModel(plans=[
        [chunk(reasoning="先处理初始预算。"), tool("task", {"description": "旧预算，不执行", "subagent_type": "finance"}, "obsolete")],
        [tool("task", {"description": "按用户新要求保存9500目标、晚餐32元、生成报告并给建议", "subagent_type": "finance"}, "finance")],
        [tool("update_finance_budget", budget(savings_target="9500"), "budget")],
        [tool("record_finance_transaction", {"entry_key": "dinner", "kind": "expense", "amount": "32", "occurred_on": "2026-10-16", "date_evidence": "2026年10月16日晚餐32元"}, "dinner")],
        [tool("publish_finance_report", {"start_date": "2026-10-01", "end_date": "2026-10-16", "filename": "steered.md"}, "report")],
        [chunk(advice)],
        [chunk("主助手保留建议与报告，继续自己的回复。")],
    ])
    result = await execute(settings, store, run, model, on_emit)
    captured = events(store, run)
    receipt = next(item["data"] for item in captured if item["type"] == "finance.write_completion")
    artifact = next(item["data"] for item in captured if item["type"] == "artifact")
    assert model.calls == 7 and result == "主助手保留建议与报告，继续自己的回复。"
    assert receipt["input_message_id"] == artifact["verification"]["finance_input_id"] == "parent-steer"
    assert receipt["analysis"] == advice and receipt["response"].startswith(advice)
    assert FinanceService(store).get_budget("2026-10")["savings_target"] == "9500.00"
    row = FinanceService(store).list_transactions(month="2026-10")["items"][0]
    assert row["source_id"] == "parent-steer" and row["occurred_on"] == "2026-10-16" and row["amount"] == "32.00"
    assert {item["call_id"] for item in Journal(settings).receipts(run["id"])["items"]} >= {"budget:parent-steer", "dinner:parent-steer", "report:parent-steer"}
    assert delegated_finance_input.get() is None and active_finance_input.get() is None


def test_unseen_steer_cannot_override_inherited_source_and_real_child_human_takes_priority(tmp_path):
    _, store, run = fixture(tmp_path)
    store.submit_message(run["conversation_id"], id="not-yet-seen", content="目标改9500，并给建议。", intent="steer", target_run_id=run["id"])
    token = delegated_finance_input.set(run["message_id"])
    try:
        assert _seen_finance_input(store, run["id"], [HumanMessage(content="模型临时写的建议说明", id="synthetic-child")]) == run["message_id"]
        assert _seen_finance_input(store, run["id"], [HumanMessage(content="实际新要求", id="not-yet-seen")]) == "not-yet-seen"
    finally:
        delegated_finance_input.reset(token)
    token = delegated_finance_input.set("not-yet-seen")
    try:
        assert _seen_finance_input(store, "unrelated-run", []) is None
    finally:
        delegated_finance_input.reset(token)


async def test_same_task_and_mutation_ids_after_steer_execute_new_child_instead_of_old_receipt(tmp_path):
    settings, store, run = fixture(tmp_path)
    source(store, run, "本月结余目标改成9000元。")
    run.pop("agent")
    run["agents"] = store.list_agents()["items"]
    sent = False

    async def on_emit(kind, data):
        nonlocal sent
        if not sent and kind == "tool" and data.get("tool") == "task" and data.get("status") == "completed":
            store.submit_message(run["conversation_id"], id="second-task-input", content="目标改9500元，并建议今晚外卖预算。", intent="steer", target_run_id=run["id"])
            sent = True

    task_args = {"description": "按当前用户要求更新预算并给分析", "subagent_type": "finance"}
    advice = "今晚建议选择简单套餐，把饮料预算省下来。"
    model = StreamingModel(plans=[
        [tool("task", task_args, "same-task")],
        [tool("update_finance_budget", budget("same-entry", savings_target="9000"), "same-write")],
        [chunk("首次纯保存不应留下模型建议。")],
        [tool("task", task_args, "same-task")],
        [tool("update_finance_budget", budget("same-entry", savings_target="9500"), "same-write")],
        [chunk(advice)],
        [chunk("主助手按新要求完成。")],
    ])
    result = await execute(settings, store, run, model, on_emit)
    receipts = [item["data"] for item in events(store, run) if item["type"] == "finance.write_completion"]
    assert model.calls == 7 and result == "主助手按新要求完成。"
    assert len(receipts) == 2 and receipts[0]["input_message_id"] == run["message_id"]
    assert "analysis" not in receipts[0]
    assert receipts[1]["input_message_id"] == "second-task-input" and receipts[1]["analysis"] == advice
    assert FinanceService(store).get_budget("2026-10")["savings_target"] == "9500.00"
    journal = Journal(settings).receipts(run["id"])["items"]
    assert {item["call_id"] for item in journal} == {"same-task", "same-write", "same-task:second-task-input", "same-write:second-task-input"}
    assert all(item["state"] == "succeeded" for item in journal)
    assert delegated_finance_input.get() is None and active_finance_input.get() is None


async def test_same_mutation_provider_and_entry_ids_are_isolated_across_steer_and_recover_exactly(tmp_path, monkeypatch):
    settings, store, run = fixture(tmp_path)
    source(store, run, "本月结余目标改成9000元。")
    original = FinanceService.patch_budget

    def commit_then_crash(self, **kwargs):
        result = original(self, **kwargs)
        if kwargs["changes"].get("savings_target") == "9500":
            raise Crash()
        return result

    sent = False

    async def on_emit(kind, data):
        nonlocal sent
        if not sent and kind == "tool" and data.get("tool") == "update_finance_budget" and data.get("status") == "completed":
            store.submit_message(run["conversation_id"], id="same-id-steer", content="改为9500元，并解释怎么安排晚餐。", intent="steer", target_run_id=run["id"])
            sent = True

    with monkeypatch.context() as patch:
        patch.setattr(FinanceService, "patch_budget", commit_then_crash)
        with pytest.raises(Crash):
            await execute(settings, store, run, StreamingModel(plans=[[tool("update_finance_budget", budget("same-entry", savings_target="9000"), "same-call")], [tool("update_finance_budget", budget("same-entry", savings_target="9500"), "same-call")]]), on_emit)
    assert FinanceService(store).get_budget("2026-10")["savings_target"] == "9500.00"
    store.recover_interrupted()
    resumed = store.claim_next("chat")
    resumed["agent"] = store.get_agent("finance")
    advice = "晚餐可以先选一份简单套餐，把预算留给必要支出。"
    after = StreamingModel(plans=[[chunk(advice)]])
    result = await execute(settings, store, resumed, after)
    receipt = next(item["data"] for item in events(store, resumed) if item["type"] == "finance.write_completion")
    assert after.calls == 1 and result.startswith(advice) and receipt["input_message_id"] == "same-id-steer"
    assert len(receipt["operations"]) == 1 and receipt["operations"][0]["receipt"]["savings_target"] == "9500.00"
    rows = Journal(settings).receipts(run["id"])["items"]
    assert {item["call_id"] for item in rows} == {"same-call", "same-call:same-id-steer"}
    assert all(item["state"] == "succeeded" for item in rows) and Journal(settings).approvals()["items"] == []
    with store._connection() as db:
        assert db.execute("SELECT COUNT(*) FROM finance_mutations").fetchone()[0] == 2
