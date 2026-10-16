"""Real graphs keep a wandering research child from consuming its parent's run."""

import asyncio
import hashlib
import json
from typing import Any

import pytest
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from pydantic import Field
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.agent_collaboration import ChildLedger, _decode_history
from zhixing_next.resilience import RunBudget
from zhixing_next.runtime import ResearchLimitError, RunControls
from zhixing_next.store import Store


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
