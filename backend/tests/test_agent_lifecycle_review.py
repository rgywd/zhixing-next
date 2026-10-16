import asyncio
import hashlib

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import ValidationError
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.agent_collaboration import (
    ACTIVE,
    RESULT_WINDOW,
    AgentCollaboration,
    ChildLedger,
    create_agent_tools,
)
from zhixing_next.live_stream import LiveModelStream
from zhixing_next.resilience import RunBudget, RunLimitError
from zhixing_next.store import Store, StoreError


def persisted_run(settings):
    store = Store(settings)
    conversation = store.create_conversation("生命周期回归")
    store.submit_message(conversation["id"], id="request", content="核对研究结论")
    return store, store.claim_next("chat")


async def test_valid_wait_timeouts_do_not_trigger_the_identical_tool_loop_guard(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))

    async def child_runner(*args):
        await asyncio.Event().wait()

    manager = AgentCollaboration(store, run, child_runner, ignore, no_controls)
    budget = RunBudget(store, run["id"])
    child = await manager.start("question", "reader", "start")
    await asyncio.sleep(0)
    snapshot = await manager.wait([child["id"]], timeout_ms=0)
    state = {"messages": [HumanMessage(content="question", id="request")]}
    try:
        for sequence in range(6):
            args = {"agent_ids": [child["id"]], "after": snapshot["cursor"], "timeout_ms": 1}
            budget.reserve("tool_calls")
            budget.check_loop({"name": "wait_agents", "id": f"wait-{sequence}", "args": args}, state)
            snapshot = await manager.wait([child["id"]], after=snapshot["cursor"], timeout_ms=1)
            assert snapshot["timed_out"]
        assert budget.summary()["tool_calls"] == 6
        assert manager.ledger.get(child["id"])["status"] == "running"
        # The exception applies only to moving-state waits, not repetitive work.
        with pytest.raises(RunLimitError, match="连续重复同一工具"):
            for sequence in range(4):
                budget.reserve("tool_calls")
                budget.check_loop({"name": "calculate", "id": f"calc-{sequence}", "args": {"expression": "1+2"}}, state)
    finally:
        await manager.shutdown()


@pytest.mark.parametrize("limit", ["tool_calls", "total_tokens"])
def test_wait_exemption_keeps_shared_call_and_token_limits(tmp_path, limit):
    settings = make_settings(tmp_path)
    settings.limits.tool_calls = 3
    store, run = persisted_run(settings)
    budget = RunBudget(store, run["id"])
    for sequence in range(3):
        budget.reserve("tool_calls")
        budget.check_loop({"name": "wait_agents", "id": str(sequence), "args": {}}, {})
    if limit == "total_tokens":
        with store._connection(write=True) as db:
            db.execute("UPDATE run_usage SET tool_calls=0,input_tokens=? WHERE run_id=?", (settings.limits.total_tokens, run["id"]))
    with pytest.raises(RunLimitError):
        budget.reserve("tool_calls")


async def test_long_child_result_is_saved_in_full_and_paged_without_losing_unicode(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))
    content = "事实🔬" * 12000 + "最后的关键结论"

    async def child_runner(*args):
        return [AIMessage(content=content)]

    manager = AgentCollaboration(store, run, child_runner, ignore, no_controls)
    child = await manager.start("read", "reader", "start")
    tools = {item.name: item for item in create_agent_tools(manager)}
    try:
        first = (await tools["wait_agents"].ainvoke({"agent_ids": [child["id"]]}))["agents"][0]
        assert first["status"] == "completed" and first["result_version"] == 1
        assert first["result_length"] == len(content)
        assert first["result_offset"] == 0
        assert first["result_truncated"] and first["next_result_offset"] == RESULT_WINDOW
        assert len(first["result"]) == RESULT_WINDOW
        collected = first["result"]
        page = first
        while page["next_result_offset"] is not None:
            page = (await tools["wait_agents"].ainvoke({
                "agent_ids": [child["id"]], "result_offset": page["next_result_offset"],
            }))["agents"][0]
            assert page["result_version"] == first["result_version"]
            collected += page["result"]
        assert not page["result_truncated"]
        assert collected == content
        assert ChildLedger(Store(store.settings), run["id"]).get(child["id"])["result"] == content
        with pytest.raises(StoreError, match="nonnegative"):
            await manager.wait([child["id"]], result_offset=-1)
        with pytest.raises(ValidationError):
            await tools["wait_agents"].ainvoke({"result_offset": -1})
    finally:
        await manager.shutdown()


async def test_unread_terminal_result_and_explicit_pages_return_while_another_child_runs(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))
    done = asyncio.Event()
    content = "evidence-" * 5000

    async def child_runner(row, *args):
        if row["name"] == "ready":
            done.set()
            return [AIMessage(content=content)]
        await asyncio.Event().wait()

    manager = AgentCollaboration(store, run, child_runner, ignore, no_controls)
    ready = await manager.start("first", "ready", "first")
    pending = await manager.start("second", "pending", "second")
    try:
        await done.wait()
        snapshot = manager.ledger.snapshot()
        # Even an up-to-date cursor cannot hide an unread terminal receipt.
        result = await asyncio.wait_for(manager.wait(after=snapshot["cursor"], timeout_ms=30000), 0.5)
        assert not result["timed_out"]
        assert next(row for row in result["agents"] if row["id"] == ready["id"])["status"] == "completed"
        assert next(row for row in result["agents"] if row["id"] == pending["id"])["status"] in ACTIVE
        page = await asyncio.wait_for(manager.wait(after=result["cursor"], timeout_ms=30000, result_offset=RESULT_WINDOW), 0.5)
        assert next(row for row in page["agents"] if row["id"] == ready["id"])["result"] == content[RESULT_WINDOW:RESULT_WINDOW * 2]
    finally:
        await manager.shutdown()


async def test_followup_result_changes_version_and_uses_its_own_page_lengths(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))
    versions = ["first-" * 6000, "second-" * 2500]
    invocations = 0

    async def child_runner(row, history, controls, emit, save):
        nonlocal invocations
        incoming = (await controls())["steers"]
        messages = [*history, *[HumanMessage(content=item["content"], id=item["id"]) for item in incoming], AIMessage(content=versions[invocations])]
        invocations += 1
        save(messages)
        return messages

    manager = AgentCollaboration(store, run, child_runner, ignore, no_controls)
    child = await manager.start("first", "reader", "start")
    try:
        first = (await manager.wait([child["id"]]))["agents"][0]
        await manager.send(child["id"], "Check a new question", "follow")
        second = (await manager.wait([child["id"]]))["agents"][0]
        assert first["result_version"] == 1 and second["result_version"] == 2
        assert second["result_length"] == len(versions[1])
        assert (await manager.wait([child["id"]], result_offset=RESULT_WINDOW))["agents"][0]["result"] == versions[1][RESULT_WINDOW:]
        assert manager.ledger.pending(child["id"]) == []
    finally:
        await manager.shutdown()


async def test_closing_interrupted_child_acknowledges_its_receipt_for_parent_final_gate(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))

    async def child_runner(*args):
        await asyncio.Event().wait()

    first_owner = AgentCollaboration(store, run, child_runner, ignore, no_controls)
    child = await first_owner.start("read", "reader", "start")
    await first_owner.shutdown()
    new_owner = AgentCollaboration(store, run, child_runner, ignore, no_controls)
    receipt = await new_owner.close(child["id"])
    assert receipt["status"] == "interrupted" and receipt["stopped"]
    assert new_owner.outstanding() == []
    assert await new_owner.close(child["id"]) == receipt
    await new_owner.shutdown()


class StoppingModel(ScriptedModel):
    stopped: asyncio.Event

    async def _agenerate(self, *args, **kwargs):
        try:
            return await super()._agenerate(*args, **kwargs)
        finally:
            self.stopped.set()


async def test_live_flush_failure_still_stops_child_before_root_returns(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    run = make_run("flush-failure")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    entered, release, stopped = asyncio.Event(), asyncio.Event(), asyncio.Event()
    child_model = StoppingModel(replies=[AIMessage(content="Should not finish")], entered=entered, release=release, stopped=stopped)
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child_model)
    original = LiveModelStream.flush

    async def broken_flush(stream):
        if any(row["status"] in ACTIVE for row in ChildLedger(Store(settings), run["id"]).all()):
            await entered.wait()
            raise OSError("injected stream persistence failure")
        return await original(stream)

    monkeypatch.setattr(LiveModelStream, "flush", broken_flush)
    parent_model = ScriptedModel(replies=[AIMessage(content="", tool_calls=[{
        "name": "start_agent", "args": {"task": "read evidence", "source_paths": []}, "id": "start", "type": "tool_call",
    }]), AIMessage(content="waiting")])
    try:
        with pytest.raises(OSError, match="injected"):
            await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=parent_model)
        assert entered.is_set() and stopped.is_set()
        assert ChildLedger(Store(settings), run["id"]).get(child_id)["status"] == "interrupted"
    finally:
        release.set()


async def test_waiting_for_child_still_respects_root_active_time_budget(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    settings.limits.active_seconds = 1
    run = make_run("time-limit")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    stopped = asyncio.Event()
    child_model = StoppingModel(replies=[AIMessage(content="Should not finish")], entered=asyncio.Event(), release=asyncio.Event(), stopped=stopped)
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child_model)
    parent_model = ScriptedModel(replies=[
        AIMessage(content="", tool_calls=[{"name": "start_agent", "args": {"task": "read evidence", "source_paths": []}, "id": "start", "type": "tool_call"}]),
        AIMessage(content="", tool_calls=[{"name": "wait_agents", "args": {"agent_ids": [child_id], "timeout_ms": 30000}, "id": "wait", "type": "tool_call"}]),
    ])
    with pytest.raises(RunLimitError, match="累计执行时间预算"):
        await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=parent_model)
    assert stopped.is_set()
    assert ChildLedger(Store(settings), run["id"]).get(child_id)["status"] == "interrupted"
