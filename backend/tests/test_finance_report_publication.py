"""Program-generated finance facts use the common real artifact/journal path."""

import asyncio
import json
import threading

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from pydantic import ValidationError
from test_runtime import ScriptedModel, ignore, make_settings, no_controls

from zhixing_next.finance_service import FinanceService
from zhixing_next.finance_tools import create_finance_service_tools
from zhixing_next.operations import Journal, OperationRunner
from zhixing_next.resources import resource_bytes
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store, StoreError


class Crash(BaseException):
    pass


def fixture(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    service = FinanceService(store)
    service.patch_budget(
        month="2026-03",
        idempotency_key="budget",
        changes={
            "expected_income": "14000",
            "savings_target": "8000",
            "commitments_upsert": [
                {
                    "key": "rent",
                    "label": "房租",
                    "kind": "fixed",
                    "amount": "3600",
                    "every_months": 3,
                    "anchor_month": "2026-03",
                    "due_day": 10,
                    "monthly_cost": "1200",
                    "paid_through": "2026-05",
                },
                {"key": "metro", "label": "通勤", "kind": "fixed", "amount": "200"},
            ],
        },
    )
    for key, kind, amount in [
        ("income", "income", "4800"),
        ("purchase", "expense", "1700"),
        ("withdrawal", "transfer", "100"),
    ]:
        service.create_transaction(
            idempotency_key=key,
            kind=kind,
            amount=amount,
            date_precision="range",
            date_start="2026-03-01",
            date_end="2026-04-09",
            note="internal note revision=99 coverage hidden",
        )
    conversation = store.create_conversation("报告", agent_id="finance")["id"]
    store.submit_message(
        conversation, id="report-input", content="回顾3月1日至4月9日，期初6000，期末8000"
    )
    run = store.claim_next("chat")
    run["agent"] = store.get_agent("finance")
    arguments = {
        "start_date": "2026-03-01",
        "end_date": "2026-04-09",
        "opening_assets": "6000",
        "closing_assets": "8000",
        "filename": "review.md",
    }
    return settings, store, service, run, arguments


def ledger(store):
    with store._connection() as db:
        return {
            name: [dict(row) for row in db.execute("SELECT * FROM " + name + " ORDER BY rowid")]
            for name in ("finance_transactions", "finance_budgets", "finance_mutations")
        }


def publisher(settings, store, run, events):
    async def emit(kind, data):
        events.append((kind, data))
        store.add_event(run["id"], kind, data)

    return next(
        item
        for item in create_finance_service_tools(
            settings, run["conversation_id"], run["message_id"], run=run, emit=emit
        )
        if item.name == "publish_finance_report"
    )


async def test_domain_report_publishes_program_facts_and_cannot_accept_model_content(tmp_path):
    settings, store, service, run, arguments = fixture(tmp_path)
    events = []
    tool = publisher(settings, store, run, events)
    before = ledger(store)
    with pytest.raises(ValidationError):
        await tool.ainvoke({**arguments, "content": "incorrect arithmetic"})
    with pytest.raises(ValidationError):
        await tool.ainvoke({**arguments, "title": "incorrect conclusion"})
    receipt = await tool.ainvoke(arguments)
    assert ledger(store) == before
    assert (
        receipt["finance"]["program_generated"] and not receipt["finance"]["model_supplied_content"]
    )
    assert receipt["verification"]["finance_report_key"]
    content = resource_bytes(settings, receipt["resource"]).decode()
    assert receipt["finance"]["facts"]["calculation"]["unexplained_difference"] == "1100.00"
    assert "1100.00" in content and "9100.00" in content
    assert "coverage" not in content and "revision" not in content
    assert all(row["id"] not in content for row in before["finance_transactions"])
    assert "补表" not in content and "请补齐" not in content
    assert events == [("artifact", receipt)]
    # Re-enter with the same source and args: no second event/resource, even if
    # another input changes the ledger after the first artifact committed.
    service.create_transaction(
        idempotency_key="later", kind="expense", amount="10", occurred_on="2026-04-09"
    )
    replay = await publisher(settings, store, run, events).ainvoke(arguments)
    assert replay == receipt and events == [("artifact", receipt)]
    assert resource_bytes(settings, replay["resource"]).decode() == content


async def test_ordinary_report_omits_missing_asset_pair_without_requesting_forms(tmp_path):
    settings, store, service, run, arguments = fixture(tmp_path)
    events = []
    tool = publisher(settings, store, run, events)
    arguments.pop("opening_assets")
    arguments.pop("closing_assets")
    receipt = await tool.ainvoke(arguments)
    assert receipt["finance"]["facts"]["assets"] is None
    assert receipt["finance"]["facts"]["calculation"] is None
    text = resource_bytes(settings, receipt["resource"]).decode()
    assert "不推算资产差额" in text
    assert "请补" not in text and "补表" not in text
    with pytest.raises(StoreError):
        await tool.ainvoke({**arguments, "opening_assets": "6000"})


async def test_finance_report_crash_after_artifact_replays_verified_receipt(tmp_path):
    settings, store, service, run, arguments = fixture(tmp_path)
    events = []
    tool = publisher(settings, store, run, events)
    runner = OperationRunner(
        settings, {**run, "workspace_path": str(store.workspace_for(run["conversation_id"]))}
    )
    call = {"id": "domain-report", "name": "publish_finance_report", "args": arguments}
    published = []

    async def crashed():
        published.append(await tool.ainvoke(arguments))
        raise Crash()

    with pytest.raises(Crash):
        await runner.invoke(call, crashed)
    assert Journal(settings).receipts(run["id"])["items"][0]["state"] == "started"
    service.create_transaction(
        idempotency_key="changed-after-artifact",
        kind="expense",
        amount="5",
        occurred_on="2026-04-09",
    )

    async def recovered():
        receipt = await publisher(settings, store, run, events).ainvoke(arguments)
        return ToolMessage(content=json.dumps(receipt), tool_call_id=call["id"])

    result = await OperationRunner(
        settings, {**run, "workspace_path": str(store.workspace_for(run["conversation_id"]))}
    ).invoke(call, recovered)
    receipt = json.loads(result.content)
    assert receipt == published[0]
    assert len([item for item in events if item[0] == "artifact"]) == 1
    assert Journal(settings).receipts(run["id"])["items"][0]["state"] == "succeeded"
    assert Journal(settings).approvals()["items"] == []


async def test_reentry_does_not_silently_replace_a_changed_immutable_report(tmp_path):
    settings, store, service, run, arguments = fixture(tmp_path)
    events = []
    tool = publisher(settings, store, run, events)
    receipt = await tool.ainvoke(arguments)
    (settings.data_dir / "resources" / receipt["resource"]["id"]).write_bytes(b"changed")
    with pytest.raises(StoreError):
        await publisher(settings, store, run, events).ainvoke(arguments)
    assert len(events) == 1


@pytest.mark.parametrize("delegated", [False, True])
async def test_real_graph_report_attaches_to_original_conversation(tmp_path, delegated):
    settings, store, service, run, arguments = fixture(tmp_path)
    if delegated:
        run.pop("agent")
        run["agents"] = store.list_agents()["items"]
    responses = []
    if delegated:
        responses.append(
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "task",
                        "args": {"description": "生成实际账本报告", "subagent_type": "finance"},
                        "id": "finance",
                        "type": "tool_call",
                    }
                ],
            )
        )
    responses += [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "publish_finance_report",
                    "args": arguments,
                    "id": "report",
                    "type": "tool_call",
                }
            ],
        ),
        AIMessage(content="报告已交付。"),
    ]
    if delegated:
        responses.append(AIMessage(content="可以打开附件。"))
    model = ScriptedModel(replies=responses)

    async def emit(kind, data):
        store.add_event(run["id"], kind, data)

    before = ledger(store)
    result = await run_agent(
        settings,
        run,
        persona="",
        emit=emit,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    assert ledger(store) == before
    artifact = next(
        item["data"]
        for item in store.list_events(run["id"], limit=1000)["items"]
        if item["type"] == "artifact"
    )
    assert artifact["resource"]["conversation_id"] == run["conversation_id"]
    assert artifact["finance"]["facts"]["calculation"]["unexplained_difference"] == "1100.00"
    store.finish_run(run["id"], "completed", result=result)
    attachments = store.list_messages(run["conversation_id"])["items"][-1]["attachments"]
    assert attachments[0]["id"] == artifact["resource"]["id"]
    assert Journal(settings).approvals()["items"] == []


async def test_cancellation_waits_for_actual_finance_report_file_receipt(tmp_path, monkeypatch):
    import zhixing_next.common_reports as reports

    settings, store, service, run, arguments = fixture(tmp_path)
    entered, release = threading.Event(), threading.Event()
    original = reports.capture_file

    def delayed_capture(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)

    monkeypatch.setattr(reports, "capture_file", delayed_capture)
    events = []

    async def emit(kind, data):
        events.append((kind, data))
        store.add_event(run["id"], kind, data)

    model = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "publish_finance_report",
                        "args": arguments,
                        "id": "report",
                        "type": "tool_call",
                    }
                ],
            )
        ]
    )
    task = asyncio.create_task(
        run_agent(
            settings,
            run,
            persona="",
            emit=emit,
            controls=no_controls,
            acknowledge=ignore,
            model_override=model,
        )
    )
    assert await asyncio.to_thread(entered.wait, 5)
    task.cancel()
    await asyncio.sleep(0.03)
    assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    artifact = next(data for kind, data in events if kind == "artifact")
    assert artifact["verification"]["finance_report_key"]
    assert resource_bytes(settings, artifact["resource"])
    assert (
        "tool",
        {
            "tool": "publish_finance_report",
            "tool_call_id": "report",
            "status": "completed",
            "cancel_requested": True,
        },
    ) in events
