"""Cross-chat yielding must preserve research already started in the same run."""

import asyncio
import hashlib
from typing import Any

import pytest
from langchain_core.messages import AIMessage
from test_runtime import ScriptedModel, ignore, make_settings, no_controls

from zhixing_next.agent_collaboration import ChildLedger
from zhixing_next.conversation_links import ConversationLinks
from zhixing_next.operations import RunPaused
from zhixing_next.resilience import RunLimitError
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store


def call(name, args, identifier):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": identifier, "type": "tool_call"}])


async def test_cross_chat_pause_finishes_research_and_resume_requires_observing_result(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    store = Store(settings)
    source = store.create_conversation("Source")
    target = store.create_conversation("Target")
    store.submit_message(source["id"], id="mix", content="Research and consult the other conversation")
    run = store.claim_next("chat")
    delivery = ConversationLinks(store).send(run["id"], "consult", target["id"], "Read existing facts")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:research".encode()).hexdigest()[:16]
    entered, release, waiting = asyncio.Event(), asyncio.Event(), asyncio.Event()
    child = ScriptedModel(replies=[AIMessage(content="RESEARCH-FACT")], entered=entered, release=release)
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child)
    parent = ScriptedModel(replies=[
        call("start_agent", {"task": "Research independent facts", "source_paths": []}, "research"),
        call("wait_conversation_replies", {"delivery_ids": [delivery["delivery_id"]]}, "wait-chat"),
    ])

    async def emit(kind, data):
        store.add_event(run["id"], kind, data)
        if kind == "tool" and data.get("tool") == "wait_conversation_replies" and data.get("status") == "started":
            waiting.set()

    active = asyncio.create_task(run_agent(settings, run, persona="", emit=emit, controls=no_controls, acknowledge=ignore, model_override=parent))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        await asyncio.wait_for(waiting.wait(), 2)
        await asyncio.sleep(0.02)
        assert not active.done(), "cross-chat interrupt cancelled the active research"
        assert ChildLedger(store, run["id"]).get(child_id)["status"] == "running"
    finally:
        release.set()
        outcome = (await asyncio.gather(active, return_exceptions=True))[0]
    assert isinstance(outcome, RunPaused)
    child_row = ChildLedger(store, run["id"]).get(child_id)
    assert child_row["status"] == "completed" and child_row["result"] == "RESEARCH-FACT"
    store.pause_run(run["id"])
    claimed = store.claim_next("chat")
    assert claimed["id"] == delivery["target_run_id"]
    store.finish_run(claimed["id"], "completed", result="OTHER-CHAT-FACT")
    resumed = store.claim_next("chat")
    assert resumed["id"] == run["id"]
    continuation = ScriptedModel(replies=[
        AIMessage(content="Premature result without reading research"),
        call("wait_agents", {"agent_ids": [child_id], "timeout_ms": 0}, "read-research"),
        AIMessage(content="Both evidence sources received."),
    ])
    result = await run_agent(settings, resumed, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=continuation)
    assert result == "Both evidence sources received."
    assert any("unfinished work or unread results" in str(message.content) for messages in continuation.seen for message in messages)
    assert "RESEARCH-FACT" in str(continuation.seen[-1])
    assert "OTHER-CHAT-FACT" in str(continuation.seen[-1])


class StoppingModel(ScriptedModel):
    stopped: Any

    async def _agenerate(self, *args, **kwargs):
        try:
            return await super()._agenerate(*args, **kwargs)
        finally:
            self.stopped.set()


@pytest.mark.parametrize("stop", ["cancel", "budget"])
async def test_research_drain_is_bounded_and_cancellation_stops_actual_model(tmp_path, monkeypatch, stop):
    settings = make_settings(tmp_path)
    if stop == "budget":
        settings.limits.active_seconds = 1
    store = Store(settings)
    source, target = store.create_conversation("Source"), store.create_conversation("Target")
    store.submit_message(source["id"], id="mixed", content="Research and consult")
    run = store.claim_next("chat")
    delivery = ConversationLinks(store).send(run["id"], "consult", target["id"], "Read history")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:research".encode()).hexdigest()[:16]
    stopped, draining = asyncio.Event(), asyncio.Event()
    child = StoppingModel(replies=[], entered=asyncio.Event(), release=asyncio.Event(), stopped=stopped)
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child)
    parent = ScriptedModel(replies=[
        call("start_agent", {"task": "Research evidence", "source_paths": []}, "research"),
        call("wait_conversation_replies", {"delivery_ids": [delivery["delivery_id"]]}, "wait-chat"),
    ])

    async def emit(kind, data):
        if kind == "progress" and data.get("stage") == "finishing_research_before_conversation_wait":
            draining.set()

    active = asyncio.create_task(run_agent(settings, run, persona="", emit=emit, controls=no_controls, acknowledge=ignore, model_override=parent))
    await asyncio.wait_for(draining.wait(), 2)
    if stop == "cancel":
        active.cancel()
    with pytest.raises(asyncio.CancelledError if stop == "cancel" else RunLimitError):
        await asyncio.wait_for(active, 2)
    assert stopped.is_set()
    assert ChildLedger(store, run["id"]).get(child_id)["status"] == "interrupted"
    assert store.get_run(delivery["target_run_id"])["status"] == "queued"
