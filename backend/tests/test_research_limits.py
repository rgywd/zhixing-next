"""Real graphs keep a wandering research child from consuming its parent's run."""

import asyncio
import hashlib
import json
from typing import Any

import httpx
import pytest
from langchain.agents import create_agent
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from pydantic import Field
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.agent_collaboration import ChildLedger, _decode_history, create_agent_tools
from zhixing_next.resilience import RunBudget
from zhixing_next.runtime import ResearchLimitError, RunControls
from zhixing_next.store import Store, StoreError


def calculation(index):
    return AIMessage(content="", tool_calls=[{
        "name": "calculate", "args": {"expression": f"{index}+1"},
        "id": f"calculate-{index}", "type": "tool_call",
    }])


class LimitCoordinator(ScriptedModel):
    child_id: str
    receipts: list[dict] = Field(default_factory=list)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(messages)
        if len(self.seen) == 1:
            call = {"name": "start_agent", "args": {"task": "Read the evidence and report its limits"}, "id": "start", "type": "tool_call"}
        else:
            for message in reversed(messages):
                if isinstance(message, ToolMessage) and message.name == "wait_agents":
                    receipt = json.loads(message.content)["agents"][0]
                    self.receipts.append(receipt)
                    if receipt["stopped"]:
                        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="The research was incomplete; its verified partial findings are retained."))])
                    break
            call = {"name": "wait_agents", "args": {"agent_ids": [self.child_id]}, "id": f"wait-{len(self.seen)}", "type": "tool_call"}
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[call]))])


class ResumeCoordinator(LimitCoordinator):
    resumed: bool = False

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(messages)
        if len(self.seen) == 1:
            call = {"name": "start_agent", "args": {"task": "Read the evidence and report its limits"}, "id": "start", "type": "tool_call"}
        else:
            latest = next((message for message in reversed(messages) if isinstance(message, ToolMessage)), None)
            if latest and latest.name == "wait_agents":
                receipt = json.loads(latest.content)["agents"][0]
                self.receipts.append(receipt)
                if receipt["status"] == "failed" and receipt["error_code"] == "research_limit_with_summary" and not self.resumed:
                    assert receipt["can_send"]
                    self.resumed = True
                    call = {"name": "send_agent", "args": {"agent_id": self.child_id, "message": "Do not use tools. Return the final findings based on the evidence already read, keeping unknowns unknown."}, "id": "continue-same-child", "type": "tool_call"}
                    return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[call]))])
                if receipt["status"] == "completed":
                    return ChatResult(generations=[ChatGeneration(message=AIMessage(content="The same assistant returned its final findings with stated limits."))])
            call = {"name": "wait_agents", "args": {"agent_ids": [self.child_id]}, "id": f"wait-{len(self.seen)}", "type": "tool_call"}
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[call]))])


async def test_limited_research_can_continue_same_history_and_root_budget(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    run = make_run("resume-limited-research")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    first = ScriptedModel(replies=[*[calculation(index) for index in range(5)], AIMessage(content="Verified calculations; the source question remains unchecked.")])
    continued = ScriptedModel(replies=[AIMessage(content="Final findings: the five calculations are known; the source question remains unknown.")])
    models = iter([first, continued])
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: next(models))
    parent = ResumeCoordinator(replies=[], child_id=child_id)
    answer = await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=parent)
    assert "same assistant" in answer
    initial, final = parent.receipts
    assert initial["status"] == "failed" and initial["result_version"] == 1
    assert initial["error_code"] == "research_limit_with_summary" and "部分总结" in initial["result"]
    assert final["agent_id"] == child_id and final["status"] == "completed" and final["result_version"] == 2
    assert final["error_code"] is None and final["can_send"]
    assert len(first.seen) == 6 and len(continued.seen) == 1
    context = continued.seen[0]
    assert sum(isinstance(message, ToolMessage) and message.name == "calculate" for message in context) == 5
    assert any(isinstance(message, AIMessage) and message.additional_kwargs.get("zhixing_research_limit") == "research_limit_with_summary" for message in context)
    assert any(isinstance(message, HumanMessage) and "Do not use tools" in str(message.content) for message in context)
    store = Store(settings)
    ledger = ChildLedger(store, run["id"])
    assert len(ledger.all()) == 1 and ledger.get(child_id)["result"] == final["result"]
    assert RunBudget(store, run["id"]).summary()["model_attempts"] == len(parent.seen) + 7
    with store._connection() as db:
        delivery = db.execute("SELECT status FROM agent_child_inputs WHERE child_id=?", (child_id,)).fetchone()
    assert delivery["status"] == "applied"


@pytest.mark.parametrize("status,error_code,result,valid_history", [
    ("failed", "ResearchLimitError", "Saved result", True),
    ("failed", "GraphRecursionError", "Saved result", True),
    ("failed", "research_limit_with_summary", None, True),
    ("failed", "research_limit_with_summary", "Saved result", False),
    ("closed", "research_limit_with_summary", "Saved result", True),
    ("closing", "research_limit_with_summary", "Saved result", True),
    ("interrupted", "research_limit_with_summary", "Saved result", True),
])
def test_only_saved_limited_summaries_can_resume_failed_children(tmp_path, status, error_code, result, valid_history):
    store = Store(make_settings(tmp_path))
    conversation = store.create_conversation("Resume boundary")
    store.submit_message(conversation["id"], id="request", content="Check evidence")
    run = store.claim_next("chat")
    ledger = ChildLedger(store, run["id"])
    child, _ = ledger.create("start", "reader", "Check evidence", 4)
    row = ledger.update(child["id"], status, result=result, error_code=error_code, history=[HumanMessage(content="Evidence"), AIMessage(content="Partial")] if valid_history else [])
    assert not ledger.public(row)["can_send"]
    with pytest.raises(StoreError, match="can_send=false"):
        ledger.send(child["id"], "follow", "Summarize the evidence")


def test_accepted_limited_summary_is_queued_without_falsely_completing_it(tmp_path):
    store = Store(make_settings(tmp_path))
    conversation = store.create_conversation("Resume boundary")
    store.submit_message(conversation["id"], id="request", content="Check evidence")
    run = store.claim_next("chat")
    ledger = ChildLedger(store, run["id"])
    child, _ = ledger.create("start", "reader", "Check evidence", 4)
    before = ledger.update(child["id"], "failed", result="Partial findings", error_code="research_limit_with_summary", history=[HumanMessage(content="Evidence"), AIMessage(content="Partial")])
    receipt, created = ledger.send(child["id"], "follow", "Summarize the evidence")
    after = ledger.get(child["id"])
    assert created and receipt["status"] == "queued" and after["status"] == "queued"
    assert after["error_code"] is None and ledger.public(after)["can_send"]
    assert after["result"] == before["result"] and after["result_version"] == before["result_version"] == 1
    assert after["history_json"] == before["history_json"]
    # The model-visible contract advertises the same boundary as the hard guard.
    tools = {item.name: item for item in create_agent_tools(None)}
    assert "can_send=true" in tools["send_agent"].description
    assert "research_limit_with_summary" in tools["wait_agents"].description


@pytest.mark.parametrize("ignore_closed_tools", [False, True])
async def test_real_root_child_stops_at_six_models_and_preserves_honest_partial(tmp_path, monkeypatch, ignore_closed_tools):
    settings = make_settings(tmp_path)
    run = make_run("bounded-research")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    child = ScriptedModel(replies=[
        *[calculation(index) for index in range(5)],
        calculation(99) if ignore_closed_tools else AIMessage(content="The five calculations are verified; the broader source question remains unchecked."),
    ])
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child)
    parent = LimitCoordinator(replies=[], child_id=child_id)
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    answer = await fixture_run_agent(settings, run, persona="", emit=emit, controls=no_controls, acknowledge=ignore, model_override=parent)
    assert "incomplete" in answer
    assert len(child.seen) == 6
    assert "No more tools are available" in str(child.seen[-1])
    starts = [data for kind, data in events if kind == "tool" and data.get("child_id") == child_id and data["status"] == "started"]
    assert len(starts) == 5 and not any(item["tool_call_id"] == "calculate-99" for item in starts)
    receipt = parent.receipts[-1]
    assert receipt["stopped"] and receipt["status"] == "failed"
    # The same root budget counts both graphs; no separate unaccounted model run.
    assert RunBudget(Store(settings), run["id"]).summary()["model_attempts"] == len(parent.seen) + 6
    saved = ChildLedger(Store(settings), run["id"]).get(child_id)
    assert saved["status"] == "failed" and saved["error_code"] == receipt["error_code"]
    if ignore_closed_tools:
        assert saved["error_code"] == "ResearchLimitError"
        assert saved["result"] is None and saved["result_version"] == 0
    else:
        assert saved["error_code"] == "research_limit_with_summary" and saved["result_version"] == 1
        assert "部分总结" in saved["result"] and "five calculations" in saved["result"]
        final = _decode_history(saved["history_json"])[-1]
        assert final.additional_kwargs["zhixing_research_limit"] == "research_limit_with_summary"


@tool
def calculate(expression: str) -> str:
    """Return a synthetic calculation receipt."""
    return expression


async def test_research_cap_does_not_change_other_readonly_graphs():
    model = ScriptedModel(replies=[*[calculation(index) for index in range(7)], AIMessage(content="All requested checks are done.")])
    guard = RunControls(no_controls, ignore, read_only=True)
    graph = create_agent(model=model, tools=[calculate], middleware=[guard])
    result = await graph.ainvoke({"messages": [HumanMessage(content="Check all seven inputs")]})
    assert result["messages"][-1].content == "All requested checks are done."
    assert len(model.seen) == 8 and guard.research_model_calls == 0


async def test_retry_wakeup_without_provider_response_does_not_acknowledge_input(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("Retry receipt")
    store.submit_message(conversation["id"], id="request", content="Check the evidence")
    run = store.claim_next("chat")
    calls = 0

    async def controls():
        nonlocal calls
        calls += 1
        return {"cancel_requested": False, "steers": [{"id": "new-input", "content": "A correction"}] if calls > 1 else []}

    async def failed_provider(request):
        raise httpx.ConnectError("Synthetic connection failure")

    monkeypatch.setattr("zhixing_next.resilience.retry_delay", lambda *args: 1)
    guard = RunControls(controls, ignore, budget=RunBudget(store, run["id"]), research=True)
    message = HumanMessage(content="Not successfully consumed", id="unconsumed-input")
    request = ModelRequest(model=ScriptedModel(replies=[]), messages=[message], tools=[], state={"messages": [message]})
    response = await guard.awrap_model_call(request, failed_provider)
    assert response.result[0].content == ""  # Budget's wakeup, not a provider result.
    assert guard.research_consumed_ids == set()


class BoundaryModel(ScriptedModel):
    final_entered: Any
    final_release: Any
    stopped: Any

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        if len(self.seen) == 5:
            self.final_entered.set()
            try:
                await self.final_release.wait()
            finally:
                self.stopped.set()
        return await super()._agenerate(messages, stop, run_manager, **kwargs)


class BoundaryCoordinator(LimitCoordinator):
    child_entered: Any
    child_release: Any

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        if len(self.seen) == 1:
            self.seen.append(messages)
            await self.child_entered.wait()
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[{
                "name": "send_agent", "args": {"agent_id": self.child_id, "message": "Correct the assumption"},
                "id": "late-followup", "type": "tool_call",
            }]))])
        if len(self.seen) == 2:
            self.child_release.set()
        return await super()._agenerate(messages, stop, run_manager, **kwargs)


@pytest.mark.parametrize("at_final_boundary", [False, True])
async def test_delivery_receipt_tracks_actual_model_consumption_not_history_snapshot(tmp_path, monkeypatch, at_final_boundary):
    settings = make_settings(tmp_path)
    run = make_run("delivery-at-boundary")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    entered, release, stopped = asyncio.Event(), asyncio.Event(), asyncio.Event()
    if at_final_boundary:
        child = BoundaryModel(replies=[*[calculation(index) for index in range(5)], AIMessage(content="Obsolete summary")], final_entered=entered, final_release=release, stopped=stopped)
    else:
        child = ScriptedModel(replies=[calculation(0), AIMessage(content="The new instruction is included in this result.")], entered=entered, release=release)
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child)
    parent = BoundaryCoordinator(replies=[], child_id=child_id, child_entered=entered, child_release=release)
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=parent)
    store = Store(settings)
    row = ChildLedger(store, run["id"]).get(child_id)
    with store._connection() as db:
        delivery = dict(db.execute("SELECT * FROM agent_child_inputs WHERE child_id=?", (child_id,)).fetchone())
    history = _decode_history(row["history_json"])
    assert any(isinstance(message, HumanMessage) and message.id == delivery["id"] for message in history)
    model_saw_delivery = any(isinstance(message, HumanMessage) and message.id == delivery["id"] for messages in child.seen for message in messages)
    if at_final_boundary:
        assert row["status"] == "failed" and row["error_code"] == "ResearchLimitError"
        assert delivery["status"] == "interrupted" and not model_saw_delivery
        assert stopped.is_set() and len(child.seen) == 6
        assert row["result"] is None
    else:
        assert row["status"] == "completed" and row["error_code"] is None
        assert delivery["status"] == "applied" and model_saw_delivery
        assert "new instruction" in row["result"]


async def test_summary_boundary_still_checks_cancel_and_does_not_discard_steer():
    entered, release, stopped = asyncio.Event(), asyncio.Event(), asyncio.Event()
    incoming = []

    async def controls():
        return {"cancel_requested": False, "steers": incoming}

    model = BoundaryModel(replies=[*[calculation(index) for index in range(5)], AIMessage(content="Obsolete summary")], final_entered=entered, final_release=release, stopped=stopped)
    guard = RunControls(controls, ignore, read_only=True, research=True)
    graph = create_agent(model=model, tools=[calculate], middleware=[guard])
    task = asyncio.create_task(graph.ainvoke({"messages": [HumanMessage(content="Research")]}, {"recursion_limit": 50}))
    await asyncio.wait_for(entered.wait(), 2)
    incoming.append({"id": "new-instruction", "content": "Correct the assumption", "attachments": []})
    release.set()
    with pytest.raises(ResearchLimitError):
        await task
    assert stopped.is_set() and len(model.seen) == 6
    # The obsolete final response is rejected, rather than returned as current.
    assert "new-instruction" in guard.steer_ids

    entered, release, stopped = asyncio.Event(), asyncio.Event(), asyncio.Event()
    model = BoundaryModel(replies=[*[calculation(index) for index in range(5)], AIMessage(content="Never delivered")], final_entered=entered, final_release=release, stopped=stopped)
    guard = RunControls(no_controls, ignore, read_only=True, research=True)
    graph = create_agent(model=model, tools=[calculate], middleware=[guard])
    task = asyncio.create_task(graph.ainvoke({"messages": [HumanMessage(content="Research")]}))
    await asyncio.wait_for(entered.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stopped.is_set()
