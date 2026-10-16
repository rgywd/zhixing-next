import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from test_runtime import ScriptedModel, ignore, make_settings, no_controls

from zhixing_next.finance_service import FinanceService
from zhixing_next.operations import Journal
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store
from zhixing_next.worker import Worker


class Crash(BaseException):
    pass


def fixture(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    service = FinanceService(store)
    original = service.create_transaction(
        idempotency_key="received", kind="income", amount="16500", occurred_on="2026-10-15"
    )
    conversation = store.create_conversation("工资拆分", agent_id="finance")["id"]
    store.submit_message(
        conversation, id="split-input", content="2026年10月15日收到16500，拆成工资15000和奖金1500"
    )
    run = store.claim_next("chat")
    run["agent"] = store.get_agent("finance")
    arguments = {
        "entry_key": "split-salary",
        "operations": [
            {
                "operation": "update",
                "transaction_id": original["id"],
                "expected_revision": 1,
                "fields": {"amount": "15000", "category": "工资"},
            },
            {
                "operation": "create",
                "date_evidence": "2026年10月15日收到16500",
                "fields": {
                    "kind": "income",
                    "amount": "1500",
                    "occurred_on": "2026-10-15",
                    "category": "奖金",
                },
            },
        ],
    }
    call = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "apply_finance_transaction_batch",
                "args": arguments,
                "id": "split-batch",
                "type": "tool_call",
            }
        ],
    )
    return settings, store, service, run, call


async def invoke(settings, run, model, controls=no_controls):
    return await run_agent(
        settings,
        run,
        persona="",
        emit=ignore,
        controls=controls,
        acknowledge=ignore,
        model_override=model,
    )


async def test_batch_committed_before_journal_crash_replays_same_receipt_without_duplicate_or_approval(
    tmp_path, monkeypatch
):
    settings, store, service, run, call = fixture(tmp_path)
    original = FinanceService.apply_transaction_batch

    def committed_then_crash(self, **kwargs):
        result = original(self, **kwargs)
        assert result["verified"] and result["conserved"]
        raise Crash()

    with monkeypatch.context() as patch:
        patch.setattr(FinanceService, "apply_transaction_batch", committed_then_crash)
        with pytest.raises(Crash):
            await invoke(settings, run, ScriptedModel(replies=[call]))
    assert service.list_transactions(month="2026-10")["total"] == 2
    assert service.summary(month="2026-10")["totals"]["income"] == "16500.00"
    receipt = Journal(settings).receipts(run["id"])["items"]
    assert (
        len(receipt) == 1
        and receipt[0]["tool"] == "apply_finance_transaction_batch"
        and receipt[0]["state"] == "started"
    )
    store.recover_interrupted()
    resumed = Store(settings).claim_next("chat")
    resumed["agent"] = store.get_agent("finance")
    model = ScriptedModel(replies=[AIMessage(content="工资和奖金已分别保存，总收入保持16500。")])
    assert await invoke(settings, resumed, model) == "工资和奖金已分别保存，总收入保持16500。"
    assert Journal(settings).approvals()["items"] == []
    receipt = Journal(settings).receipts(run["id"])["items"]
    assert len(receipt) == 1 and receipt[0]["state"] == "succeeded"
    actual = next(
        json.loads(message.content)
        for message in model.seen[0]
        if isinstance(message, ToolMessage) and message.tool_call_id == "split-batch"
    )
    assert actual["before"]["income"] == actual["after"]["income"] == "16500.00"
    assert sorted(row["amount"] for row in service.list_transactions(month="2026-10")["items"]) == [
        "1500.00",
        "15000.00",
    ]


async def test_cancel_before_batch_boundary_starts_no_mutation_or_journal(tmp_path):
    settings, store, service, run, call = fixture(tmp_path)

    async def cancelled():
        return {"cancel_requested": True, "steers": []}

    with pytest.raises(asyncio.CancelledError):
        await invoke(settings, run, ScriptedModel(replies=[call]), controls=cancelled)
    assert service.list_transactions(month="2026-10")["total"] == 1
    assert service.list_transactions(month="2026-10")["items"][0]["amount"] == "16500.00"
    assert Journal(settings).receipts(run["id"])["items"] == []


async def test_worker_preserves_cancelled_receipt_and_pauses_followup_queue(tmp_path):
    settings, store, service, run, call = fixture(tmp_path)
    store.submit_message(run["conversation_id"], id="later", content="等会再继续")
    store.cancel_run(run["id"])

    async def runner(settings, run, **callbacks):
        return await run_agent(
            settings, run, **callbacks, model_override=ScriptedModel(replies=[call])
        )

    await Worker(settings, runner)._execute(run)
    assert store.get_run(run["id"])["status"] == "cancelled"
    assert store.claim_next("chat") is None
    assert store.get_conversation(run["conversation_id"])["blocked"]
    assert service.list_transactions(month="2026-10")["total"] == 1
    assert Journal(settings).receipts(run["id"])["items"] == []
