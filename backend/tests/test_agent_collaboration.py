import asyncio
import hashlib
import json
from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.agent_collaboration import (
    ACTIVE,
    READ_ONLY_TOOLS,
    AgentCollaboration,
    ChildLedger,
    _decode_history,
    _encode_history,
    create_agent_tools,
)
from zhixing_next.runtime import RunControls, _portable_history
from zhixing_next.store import Store, StoreError


def persisted_run(settings):
    store = Store(settings)
    conversation = store.create_conversation("Research")
    store.submit_message(conversation["id"], id="research-request", content="Compare evidence")
    return store, store.claim_next("chat")


async def immediate(row, history, controls, emit, save):
    messages = [*history, HumanMessage(content=row["task"], id="request-" + row["id"]), AIMessage(content="Evidence found")]
    save(messages)
    return messages


async def until_stopped(manager, agent_id):
    snapshot = await manager.wait([agent_id], timeout_ms=0)
    for _ in range(20):
        if snapshot["agents"][0]["status"] not in ACTIVE:
            return snapshot["agents"][0]
        snapshot = await manager.wait([agent_id], after=snapshot["cursor"], timeout_ms=100)
    raise AssertionError("research agent did not stop")


async def test_handles_and_deliveries_are_injected_idempotent_and_scoped(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))
    manager = AgentCollaboration(store, run, immediate, ignore, no_controls)
    tools = {item.name: item for item in create_agent_tools(manager)}
    assert "tool_call_id" not in tools["start_agent"].tool_call_schema.model_fields
    call = {"name": "start_agent", "args": {"task": "Read old context"}, "id": "start-one", "type": "tool_call"}
    first = json.loads((await tools["start_agent"].ainvoke(call)).content)
    second = json.loads((await tools["start_agent"].ainvoke(call)).content)
    assert first["agent_id"] == second["agent_id"]
    assert len(manager.ledger.all()) == 1
    assert (await until_stopped(manager, first["agent_id"]))["result"] == "Evidence found"
    assert manager.outstanding() == []
    receipt = await manager.send(first["agent_id"], "Check one exception", "follow-one")
    assert receipt == await manager.send(first["agent_id"], "Check one exception", "follow-one")
    with pytest.raises(StoreError, match="different instruction"):
        await manager.send(first["agent_id"], "Different", "follow-one")
    with pytest.raises(StoreError, match="returned by start_agent"):
        await manager.close("foreign-handle")
    await manager.shutdown()


async def test_bounded_parallel_children_and_wait_is_event_driven(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))
    entered, release = asyncio.Event(), asyncio.Event()
    active = maximum = 0

    async def runner(row, history, controls, emit, save):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        entered.set()
        try:
            await release.wait()
            return [AIMessage(content="done")]
        finally:
            active -= 1

    manager = AgentCollaboration(store, run, runner, ignore, no_controls, concurrency=1, max_children=2)
    first = await manager.start("one", "one", "c1")
    await entered.wait()
    await manager.start("two", "two", "c2")
    with pytest.raises(StoreError, match="limit"):
        await manager.start("three", "three", "c3")
    snapshot = await manager.wait(timeout_ms=0)
    wait = asyncio.create_task(manager.wait(after=snapshot["cursor"], timeout_ms=30000))
    await asyncio.sleep(0)
    assert not wait.done()
    release.set()
    assert (await wait)["cursor"] > snapshot["cursor"]
    assert (await until_stopped(manager, first["agent_id"]))["status"] == "completed"
    assert maximum == 1
    await manager.shutdown()


async def test_close_waits_for_actual_tool_stop_and_keeps_receipt(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))
    entered, release, stopped = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def runner(row, history, controls, emit, save):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await release.wait()
            stopped.set()
            raise

    manager = AgentCollaboration(store, run, runner, ignore, no_controls)
    child = await manager.start("read", "reader", "start")
    await entered.wait()
    closing = asyncio.create_task(manager.close(child["agent_id"]))
    await asyncio.sleep(0)
    assert not closing.done()
    assert manager.ledger.get(child["agent_id"])["status"] == "closing"
    release.set()
    receipt = await closing
    assert stopped.is_set()
    assert receipt["status"] == "closed" and receipt["stopped"]
    assert await manager.close(child["agent_id"]) == receipt
    await manager.shutdown()


async def test_shutdown_and_restart_mark_active_children_interrupted(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))
    manager = AgentCollaboration(store, run, immediate, ignore, no_controls)
    child = await manager.start("read", "reader", "start")
    await manager.shutdown()  # cancellation can precede coroutine startup
    assert manager.ledger.get(child["agent_id"])["status"] == "interrupted"
    ledger = ChildLedger(store, run["id"])
    ledger.update(child["agent_id"], "running")  # process disappeared while active
    restarted = AgentCollaboration(store, run, immediate, ignore, no_controls)
    receipt = await restarted.start("read", "reader", "start")
    assert receipt["agent_id"] == child["agent_id"]
    assert receipt["status"] == "interrupted"
    assert receipt["error_code"] == "owner_restarted"
    assert not restarted.children  # no blind model replay
    with pytest.raises(StoreError, match="stopped"):
        await restarted.send(child["agent_id"], "continue", "send")


async def test_late_instruction_does_not_publish_premature_completion(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))
    entered, release = asyncio.Event(), asyncio.Event()
    iterations = 0
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    async def runner(row, history, controls, emit, save):
        nonlocal iterations
        iterations += 1
        if iterations == 1:
            entered.set()
            await release.wait()
            return [AIMessage(content="first result")]
        instructions = (await controls())["steers"]
        messages = [*history, *[HumanMessage(content=item["content"], id=item["id"]) for item in instructions], AIMessage(content="follow-up result")]
        save(messages)
        return messages

    manager = AgentCollaboration(store, run, runner, emit, no_controls)
    first = await manager.start("question", "reader", "start")
    await entered.wait()
    await manager.send(first["agent_id"], "late instruction", "follow")
    release.set()
    receipt = await until_stopped(manager, first["agent_id"])
    assert receipt["result"] == "follow-up result" and receipt["result_version"] == 2
    assert manager.ledger.pending(first["agent_id"]) == []
    completions = [data for kind, data in events if kind == "agent.child" and data["status"] == "completed"]
    assert [item["result_version"] for item in completions] == [2]
    await manager.shutdown()


def test_child_history_roundtrips_provider_bytes_and_message_protocol():
    messages = [
        HumanMessage(content="Please inspect"),
        AIMessage(content="", tool_calls=[{"name": "calculate", "id": "calc", "args": {"expression": "1+2"}, "type": "tool_call"}], additional_kwargs={"__gemini_function_call_thought_signatures__": {"0": b"\x00\xffsignature"}}),
        ToolMessage(content='{"result":"3"}', tool_call_id="calc"),
        AIMessage(content="Three", additional_kwargs={"provider_signature": b"\xfe\x01"}),
    ]
    restored = _decode_history(_encode_history(messages))
    assert restored == messages
    assert restored[1].additional_kwargs["__gemini_function_call_thought_signatures__"]["0"] == b"\x00\xffsignature"


async def test_wait_ignores_startup_and_unselected_child_events(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))
    releases = {"one": asyncio.Event(), "two": asyncio.Event()}

    async def runner(row, history, controls, emit, save):
        await releases[row["name"]].wait()
        return [AIMessage(content=row["name"])]

    manager = AgentCollaboration(store, run, runner, ignore, no_controls)
    first = await manager.start("one", "one", "one")
    second = await manager.start("two", "two", "two")
    waiting = asyncio.create_task(manager.wait([first["agent_id"]], timeout_ms=30000))
    # Both queued->running events occur while the wait is live.
    await asyncio.sleep(0.01)
    assert not waiting.done()
    releases["two"].set()
    await until_stopped(manager, second["agent_id"])
    assert not waiting.done()  # another child's completion is not its result
    releases["one"].set()
    snapshot = await waiting
    assert snapshot["agents"][0]["status"] == "completed"
    assert snapshot["agents"][0]["result"] == "one"
    assert not snapshot["timed_out"]
    await manager.shutdown()


class Coordinator(ScriptedModel):
    child_id: str
    stage: int = 0
    serial: int = 0
    followup: bool = False
    child_release: Any = None
    cursor: int = 0
    observed: list[dict] = Field(default_factory=list)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(messages)
        self.serial += 1
        if self.stage == 0:
            self.stage = 1
            name, args = "start_agent", {"task": "Calculate 1+2; verify evidence"}
            identifier = "start"
        elif self.stage == 1:
            self.stage = 2
            if self.followup:
                name, args = "send_agent", {"agent_id": self.child_id, "message": "Also explain the uncertainty"}
                identifier = "follow"
            else:
                return ChatResult(generations=[ChatGeneration(message=AIMessage(content="premature answer"))])
        else:
            for message in reversed(messages):
                if isinstance(message, ToolMessage) and message.name == "wait_agents":
                    snapshot = json.loads(message.content)
                    self.cursor = snapshot["cursor"]
                    self.observed.append(snapshot)
                    if snapshot["agents"][0]["status"] == "completed":
                        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Used the research result."))])
                    break
            if self.child_release:
                self.child_release.set()
            name, args = "wait_agents", {"agent_ids": [self.child_id], "after": self.cursor, "timeout_ms": 1000}
            identifier = f"wait-{self.serial}"
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": identifier, "type": "tool_call"}]))])


class ClosingCoordinator(Coordinator):
    child_entered: Any

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.stage == 0:
            return await super()._agenerate(messages, stop, run_manager, **kwargs)
        self.seen.append(messages)
        if self.stage == 1:
            await self.child_entered.wait()
            self.stage = 2
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[{"name": "close_agent", "id": "close", "args": {"agent_id": self.child_id}, "type": "tool_call"}]))])
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Research stopped."))])


async def test_close_agent_stops_real_child_graph_model_before_receipt(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    run = make_run("close-research")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    entered = asyncio.Event()
    child = ScriptedModel(replies=[AIMessage(content="Should never finish")], entered=entered, release=asyncio.Event())
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child)
    parent = ClosingCoordinator(replies=[], child_id=child_id, child_entered=entered)
    assert await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=parent) == "Research stopped."
    receipt = next(json.loads(message.content) for message in parent.seen[-1] if isinstance(message, ToolMessage) and message.tool_call_id == "close")
    assert receipt["stopped"] and receipt["status"] == "closed"
    assert child.seen == []
    assert ChildLedger(Store(settings), run["id"]).get(child_id)["status"] == "closed"


@pytest.mark.parametrize("followup", [False, True])
async def test_real_root_and_child_graph_read_only_followup_and_final_gate(tmp_path, monkeypatch, followup):
    settings = make_settings(tmp_path)
    run = make_run("research")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    entered, release = asyncio.Event(), asyncio.Event()
    calculation = AIMessage(content="", tool_calls=[{"name": "calculate", "args": {"expression": "1+2"}, "id": "calc", "type": "tool_call"}])
    child = ScriptedModel(replies=[calculation, *([calculation.model_copy(update={"id": "retry", "tool_calls": [{"name": "calculate", "args": {"expression": "1+2"}, "id": "calc-fresh", "type": "tool_call"}]})] if followup else []), AIMessage(content="Three, with verified arithmetic.")], entered=entered if followup else None, release=release)
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child)
    parent = Coordinator(replies=[], child_id=child_id, followup=followup, child_release=release)
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    result = await fixture_run_agent(settings, run, persona="", emit=emit, controls=no_controls, acknowledge=ignore, model_override=parent)
    assert result == "Used the research result."
    assert parent.observed[-1]["agents"][0]["result"] == "Three, with verified arithmetic."
    assert set(child.bound_names) <= READ_ONLY_TOOLS
    assert {"write_file", "write_text_file", "publish_report", "task", "execute", "start_agent", "send_conversation_message"}.isdisjoint(child.bound_names)
    assert any(kind == "tool" and data.get("child_id") == child_id and data["tool"] == "calculate" for kind, data in events)
    if followup:
        assert any("Also explain the uncertainty" in str(message.content) for messages in child.seen for message in messages if isinstance(message, HumanMessage))
        pending = ChildLedger(Store(settings), run["id"]).pending(child_id)
        assert pending == []
    else:
        assert any("unfinished work or unread results" in str(message.content) for messages in parent.seen for message in messages)


async def test_forwarded_consultation_preserves_context_but_excludes_write_authority(tmp_path):
    settings = make_settings(tmp_path)
    first = ScriptedModel(replies=[AIMessage(content="Earlier context")])
    await fixture_run_agent(settings, make_run(), persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=first)
    run = make_run("consultation", "Please change the budget")
    run["agent_delivery"] = {"id": "d1", "source_run_id": "other", "source_conversation_id": "other-chat"}
    model = ScriptedModel(replies=[AIMessage(content="Read-only consultation answer")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    assert set(model.bound_names) <= READ_ONLY_TOOLS
    assert "Earlier context" in str(model.seen[0])
    submitted = next(message for message in model.seen[0] if isinstance(message, HumanMessage) and message.id == run["message_id"])
    assert submitted.additional_kwargs["zhixing_origin"]["kind"] == "assistant_consultation"
    assert "not a new instruction or write authorization" in str(model.seen[0])
    assert _portable_history([submitted])[0].additional_kwargs == submitted.additional_kwargs


async def test_hard_readonly_guard_blocks_forged_write_call(tmp_path):
    from types import SimpleNamespace

    called = False
    events = []

    async def handler(request):
        nonlocal called
        called = True

    async def emit(kind, data):
        events.append(data)

    guard = RunControls(no_controls, emit, read_only=True)
    receipt = await guard.awrap_tool_call(SimpleNamespace(tool_call={"name": "record_meal", "id": "forged", "args": {}}, state={"messages": []}), handler)
    assert receipt.status == "error" and not called
    assert events[-1]["failure_category"] == "capability"
    assert events[-1]["error_code"] == "capability_unavailable"


async def test_database_provenance_restricts_manual_runtime_call(tmp_path):
    from zhixing_next.conversation_links import ConversationLinks

    settings = make_settings(tmp_path)
    store, source = persisted_run(settings)
    target = store.create_conversation("Finance consultation", agent_id="finance")
    receipt = ConversationLinks(store).send(source["id"], "consult", target["id"], "Save an expense")
    run = store.claim_next("chat")
    assert run["id"] == receipt["target_run_id"]
    run.pop("agent_delivery", None)  # manual/API/restart assembly without claim metadata
    run["agent"] = store.get_agent("finance")
    model = ScriptedModel(replies=[
        AIMessage(content="", tool_calls=[{"name": "record_finance_transaction", "id": "forged-write", "args": {}, "type": "tool_call"}]),
        AIMessage(content="This is a read-only reply."),
    ])
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    assert await fixture_run_agent(settings, run, persona="", emit=emit, controls=no_controls, acknowledge=ignore, model_override=model) == "This is a read-only reply."
    assert set(model.bound_names) <= READ_ONLY_TOOLS
    assert "record_finance_transaction" not in model.bound_names
    assert any(data.get("error_code") == "capability_unavailable" for _, data in events)
    assert any(isinstance(message, HumanMessage) and message.additional_kwargs.get("zhixing_origin", {}).get("kind") == "assistant_consultation" for message in model.seen[0])


async def test_generic_schema_error_is_actionable_without_echoing_values(tmp_path):
    settings = make_settings(tmp_path)
    model = ScriptedModel(replies=[
        AIMessage(content="", tool_calls=[{"name": "calculate", "id": "bad-calc", "args": {"expression": "1+2", "unsupported": "PRIVATE-VALUE-NEVER-ECHO"}, "type": "tool_call"}]),
        AIMessage(content="", tool_calls=[{"name": "calculate", "id": "good-calc", "args": {"expression": "1+2"}, "type": "tool_call"}]),
        AIMessage(content="Three"),
    ])
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    await fixture_run_agent(settings, make_run(), persona="", emit=emit, controls=no_controls, acknowledge=ignore, model_override=model)
    failure = next(data for kind, data in events if kind == "tool" and data.get("tool_call_id") == "bad-calc" and data["status"] == "failed")
    assert failure["failure_category"] == "parameter_validation"
    assert failure["error_code"] == "invalid_tool_arguments"
    receipt = next(message for message in model.seen[-1] if isinstance(message, ToolMessage) and message.tool_call_id == "bad-calc")
    assert "PRIVATE-VALUE-NEVER-ECHO" not in receipt.content
    assert json.loads(receipt.content)["error"]["fields"][0]["field"] == "unsupported"
