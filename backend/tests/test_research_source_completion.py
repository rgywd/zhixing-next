"""Complete actual source receipts end exploration before the local safety cap."""

import hashlib
import json

import httpx
import pytest
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import Field
from test_agent_collaboration import Coordinator, persisted_run
from test_research_limits import LimitCoordinator
from test_research_source_contract import workspace_for
from test_runtime import ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent
from test_runtime_file_contracts import SchemaModel, call

from zhixing_next.agent_collaboration import SOURCE_SCOPE_KEY, ChildLedger, ResearchSourceGuard
from zhixing_next.resilience import RunBudget
from zhixing_next.runtime import ResearchLimitError, RunControls, _research_sources_complete
from zhixing_next.store import Store
from zhixing_next.thinking_chat import ThinkingChatOpenAI
from zhixing_next.tools import create_file_tools


def initial(paths=("a.txt",)):
    return HumanMessage(content="Read selected evidence", id="request", additional_kwargs={SOURCE_SCOPE_KEY: list(paths)})


def receipt(path="a.txt", identifier="read", **changes):
    payload = {"path": path, "content": "FACT", "complete": True, "truncated": False}
    payload.update(changes)
    return ToolMessage(content=json.dumps(payload), name="read_text_file", tool_call_id=identifier)


@pytest.mark.parametrize("case", [
    "generic", "missing_source", "missing_call", "wrong_id", "wrong_name", "failed",
    "wrong_path", "nested", "string_boolean", "truncated", "later_failed", "later_incomplete", "new_human",
])
def test_source_completion_requires_latest_matching_actual_outer_receipts(case):
    messages = [initial(), call("read_text_file", {"path": "a.txt"}, "read"), receipt()]
    assert _research_sources_complete(messages)
    if case == "generic":
        messages[0] = initial(())
    elif case == "missing_source":
        messages[0] = initial(("a.txt", "b.txt"))
    elif case == "missing_call":
        messages.pop(1)
    elif case == "wrong_id":
        messages[-1] = receipt(identifier="not-the-call")
    elif case == "wrong_name":
        messages[-1] = messages[-1].model_copy(update={"name": "read_document"})
    elif case == "failed":
        messages[-1] = messages[-1].model_copy(update={"status": "error"})
    elif case == "wrong_path":
        messages[-1] = receipt("b.txt")
    elif case == "nested":
        messages[-1] = messages[-1].model_copy(update={"content": json.dumps({"path": "a.txt", "content": {"complete": True, "truncated": False}})})
    elif case == "string_boolean":
        messages[-1] = receipt(complete="true")
    elif case == "truncated":
        messages[-1] = receipt(truncated=True)
    elif case in {"later_failed", "later_incomplete"}:
        messages.extend([call("read_text_file", {"path": "a.txt"}, "read-again"), receipt(identifier="read-again", complete=False)])
        if case == "later_failed":
            messages[-1] = messages[-1].model_copy(update={"status": "error"})
    elif case == "new_human":
        messages.append(HumanMessage(content="A new factual correction", id="followup"))
    assert not _research_sources_complete(messages)


class ToolChoiceModel(SchemaModel):
    choices: list = Field(default_factory=list)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        self.choices.append(kwargs.get("tool_choice"))
        return await super()._agenerate(messages, stop, run_manager, **kwargs)


@pytest.mark.parametrize("provider_ignores_none", [False, True])
async def test_real_root_child_finishes_after_actual_full_read_and_rejects_ignored_none(tmp_path, monkeypatch, provider_ignores_none):
    settings = make_settings(tmp_path)
    run = make_run("source-finish")
    workspace = workspace_for(settings, run)
    (workspace / "uploads" / "supply.txt").write_text("PINE-17: two days advance confirmation; no inventory guarantee.")
    child = ToolChoiceModel(replies=[
        call("read_text_file", {"path": "uploads/supply.txt"}, "actual-read"),
        call("read_text_file", {"path": "uploads/supply.txt"}, "must-not-execute") if provider_ignores_none else AIMessage(content="PINE-17 requires advance confirmation. Inventory remains unknown."),
    ])
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child)
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    parent = LimitCoordinator(replies=[], child_id=child_id, source_paths=["uploads/supply.txt"]) if provider_ignores_none else Coordinator(replies=[], child_id=child_id, source_paths=["uploads/supply.txt"])
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    await fixture_run_agent(settings, run, persona="", emit=emit, controls=no_controls, acknowledge=ignore, model_override=parent)
    assert len(child.seen) == 2 and child.choices == [None, "none"]
    assert "All selected source files have now been completely read" in str(child.seen[-1])
    starts = [data for kind, data in events if kind == "tool" and data.get("child_id") == child_id and data["status"] == "started"]
    assert [item["tool_call_id"] for item in starts] == ["actual-read"]
    row = ChildLedger(Store(settings), run["id"]).get(child_id)
    assert row["status"] == ("failed" if provider_ignores_none else "completed")
    assert row["error_code"] == ("ResearchLimitError" if provider_ignores_none else None)
    assert row["result_version"] == (0 if provider_ignores_none else 1)
    if provider_ignores_none:
        assert row["result"] is None and ChildLedger.can_send(row)
    else:
        assert row["result"] == "PINE-17 requires advance confirmation. Inventory remains unknown."
        assert "部分总结" not in row["result"]


@pytest.mark.parametrize("streaming", [False, True])
async def test_actual_openai_transport_receives_none_without_tools_after_source_read(tmp_path, monkeypatch, streaming):
    settings = make_settings(tmp_path)
    run = make_run("source-transport")
    workspace = workspace_for(settings, run)
    (workspace / "uploads" / "supply.txt").write_text("PINE-17 source evidence")
    requests = []

    def serve(request):
        requests.append(json.loads(request.content))
        message = {"role": "assistant", "content": "Source evidence is collected; remaining details are unknown."}
        if len(requests) == 1:
            message = {"role": "assistant", "content": "", "tool_calls": [{"id": "actual-read", "type": "function", "function": {"name": "read_text_file", "arguments": json.dumps({"path": "uploads/supply.txt"})}}]}
        finish = "tool_calls" if len(requests) == 1 else "stop"
        if request_json := requests[-1].get("stream"):
            assert request_json is True
            if "tool_calls" in message:
                message["tool_calls"][0]["index"] = 0
            chunk = {"id": "synthetic-completion", "object": "chat.completion.chunk", "model": "qwen3.8-flash", "choices": [{"index": 0, "delta": message, "finish_reason": None}]}
            final = {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content="data: " + json.dumps(chunk) + "\n\ndata: " + json.dumps(final) + "\n\ndata: [DONE]\n\n")
        return httpx.Response(200, json={"id": "synthetic-completion", "object": "chat.completion", "model": "qwen3.8-flash", "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
        model = ThinkingChatOpenAI(model="qwen3.8-flash", api_key="synthetic", base_url="https://example.invalid/v1", http_async_client=client, use_responses_api=False, max_retries=0, streaming=streaming, disable_streaming=not streaming)
        monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: model)
        child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
        await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=Coordinator(replies=[], child_id=child_id, source_paths=["uploads/supply.txt"]))
    assert len(requests) == 2 and requests[0]["tools"]
    assert requests[1]["tool_choice"] == "none" and not requests[1].get("tools")
    assert requests[1].get("stream", False) is streaming


async def test_new_human_reopens_tools_and_complete_proof_wins_on_sixth_model(tmp_path):
    settings = make_settings(tmp_path)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "a.txt").write_text("Source a")
    read = next(item for item in create_file_tools(settings, workspace) if item.name == "read_text_file")
    incoming = []

    async def controls():
        return {"cancel_requested": False, "steers": incoming}

    class SteerAfterRead(ToolChoiceModel):
        async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
            result = await super()._agenerate(messages, stop, run_manager, **kwargs)
            if len(self.seen) == 2:
                incoming.append({"id": "factual-followup", "content": "The date is Tuesday"})
            return result

    model = SteerAfterRead(replies=[call("read_text_file", {"path": "a.txt"}, "first"), AIMessage(content="Obsolete summary"), call("read_text_file", {"path": "a.txt"}, "new-read"), AIMessage(content="Current evidence with Tuesday clarification.")])
    guard = RunControls(controls, ignore, read_only=True, research=True)
    graph = create_agent(model=model, tools=[read], middleware=[guard, ResearchSourceGuard(["a.txt"])])
    result = await graph.ainvoke({"messages": [initial()]})
    assert model.choices == [None, "none", None, "none"]
    assert result["messages"][-1].content == "Current evidence with Tuesday clarification."
    assert "factual-followup" in guard.research_consumed_ids
    assert "Obsolete summary" not in str(result["messages"])

    sixth = ToolChoiceModel(replies=[AIMessage(content="All assigned source evidence is read; relevant unknowns remain unknown.")])
    guard = RunControls(no_controls, ignore, read_only=True, research=True)
    guard.research_model_calls = 5
    graph = create_agent(model=sixth, tools=[read], middleware=[guard])
    result = await graph.ainvoke({"messages": [initial(), call("read_text_file", {"path": "a.txt"}, "read"), receipt()]})
    assert sixth.choices == ["none"] and guard.research_model_calls == 6
    assert "zhixing_research_limit" not in result["messages"][-1].additional_kwargs


@pytest.mark.parametrize("summary", [AIMessage(content=""), AIMessage(content="", invalid_tool_calls=[{"name": "read_text_file", "args": "bad", "id": "invalid", "error": "invalid"}])])
async def test_empty_or_invalid_source_summary_fails_without_false_completion(summary):
    model = ToolChoiceModel(replies=[summary])
    guard = RunControls(no_controls, ignore, read_only=True, research=True)
    graph = create_agent(model=model, middleware=[guard])
    with pytest.raises(ResearchLimitError):
        await graph.ainvoke({"messages": [initial(), call("read_text_file", {"path": "a.txt"}, "read"), receipt()]})


async def test_retry_wakeup_preserves_new_instruction_and_reopens_source_read(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    store, run = persisted_run(settings)
    workspace = tmp_path / "source-workspace"
    workspace.mkdir()
    (workspace / "a.txt").write_text("Actual evidence")
    read = next(item for item in create_file_tools(settings, workspace) if item.name == "read_text_file")
    incoming = []

    async def controls():
        return {"cancel_requested": False, "steers": incoming}

    class RetryWithSteer(ToolChoiceModel):
        failed_once: bool = False

        async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
            if not self.failed_once:
                self.failed_once = True
                self.seen.append(messages)
                self.choices.append(kwargs.get("tool_choice"))
                incoming.append({"id": "retry-followup", "content": "The date is Tuesday"})
                raise httpx.ConnectError("Synthetic retryable connection error")
            return await super()._agenerate(messages, stop, run_manager, **kwargs)

    monkeypatch.setattr("zhixing_next.resilience.retry_delay", lambda *args: 1)
    model = RetryWithSteer(replies=[call("read_text_file", {"path": "a.txt"}, "new-read"), AIMessage(content="Evidence with Tuesday clarification.")])
    guard = RunControls(controls, ignore, budget=RunBudget(store, run["id"]), read_only=True, research=True)
    graph = create_agent(model=model, tools=[read], middleware=[guard, ResearchSourceGuard(["a.txt"])])
    result = await graph.ainvoke({"messages": [initial(), call("read_text_file", {"path": "a.txt"}, "old-read"), receipt(identifier="old-read")]})
    assert result["messages"][-1].content == "Evidence with Tuesday clarification."
    assert model.choices == ["none", None, "none"]
    assert "retry-followup" in guard.research_consumed_ids
    assert RunBudget(store, run["id"]).summary()["model_attempts"] == 3
