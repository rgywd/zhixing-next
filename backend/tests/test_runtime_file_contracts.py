"""Model-visible file and research contracts follow actual runtime capabilities."""

import hashlib
import json

import aiosqlite
import pytest
from deepagents import create_deep_agent
from deepagents.backends import StateBackend
from deepagents.backends.utils import create_file_data
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from pydantic import Field
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.runtime import RunControls, RuntimeState, _prepare_checkpointer
from zhixing_next.store import Store

VIRTUAL_TOOLS = {"ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep"}


class SchemaModel(ScriptedModel):
    menus: list[dict] = Field(default_factory=list)

    def bind_tools(self, tools, **kwargs):
        self.menus.append({item.name: {"schema": item.tool_call_schema.model_json_schema(), "description": item.description} for item in tools if not isinstance(item, dict)})
        return super().bind_tools(tools, **kwargs)


def call(name, args, identifier):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": identifier, "type": "tool_call"}])


async def test_root_first_call_uses_real_upload_reader_without_virtual_bait(tmp_path):
    settings = make_settings(tmp_path)
    run = make_run("physical-upload")
    upload = settings.workspace_root / "conversations" / run["conversation_id"] / "uploads" / "evidence.txt"
    upload.parent.mkdir(parents=True)
    upload.write_text("Physical upload evidence")
    model = SchemaModel(replies=[call("read_text_file", {"path": "uploads/evidence.txt"}, "read-upload"), AIMessage(content="Read the actual upload.")])
    result = await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    assert result == "Read the actual upload."
    assert VIRTUAL_TOOLS.isdisjoint(model.menus[0])
    assert {"read_text_file", "list_directory"} <= model.menus[0].keys()
    receipt = next(message for message in model.seen[-1] if isinstance(message, ToolMessage) and message.tool_call_id == "read-upload")
    assert json.loads(receipt.content)["content"] == "Physical upload evidence"
    prompt = str(model.seen[0])
    assert "do not expand the task into hypothetical business dimensions" in prompt
    assert "When a source path is already provided, delegate its reading directly" in prompt
    assert "completed agents do not need close_agent" in prompt


@tool
def large_evidence() -> str:
    """Read a synthetic large evidence source."""
    return "evidence row\n" * 12000 + "TAIL-PROOF"


async def test_real_sdk_offload_reveals_only_its_exact_internal_read_path():
    model = SchemaModel(replies=[
        call("large_evidence", {}, "huge-result"),
        call("read_file", {"file_path": "/large_tool_results/huge-result", "offset": 12000, "limit": 1}, "read-tail"),
        AIMessage(content="Read the offloaded tail."),
    ])
    graph = create_deep_agent(model=model, tools=[large_evidence], backend=StateBackend(), middleware=[RunControls(no_controls, ignore)])
    result = await graph.ainvoke({"messages": [HumanMessage(content="Read the complete evidence")]})
    assert "read_file" not in model.menus[0]
    internal = model.menus[1]["read_file"]
    assert "existing SDK internal" in internal["description"]
    assert "/large_tool_results/huge-result" in str(internal["schema"])
    assert (VIRTUAL_TOOLS - {"read_file"}).isdisjoint(model.menus[1])
    assert "/large_tool_results/huge-result" in result["files"]
    receipt = next(message for message in result["messages"] if isinstance(message, ToolMessage) and message.tool_call_id == "read-tail")
    assert receipt.status == "success" and "TAIL-PROOF" in receipt.content


@pytest.mark.parametrize("restricted", [False, True])
async def test_real_graph_refuses_virtual_host_paths_and_restricted_internal_reads(tmp_path, restricted):
    host = tmp_path / "host-evidence.txt"
    host.write_text("HOST-MARKER")
    internal = "/conversation_history/saved.md"
    attempted = internal if restricted else str(host)
    model = SchemaModel(replies=[call("read_file", {"file_path": attempted}, "forged-read"), AIMessage(content="The unavailable reader was refused.")])
    guard = RunControls(no_controls, ignore, restricted_files=restricted)
    graph = create_deep_agent(model=model, backend=StateBackend(), middleware=[guard])
    result = await graph.ainvoke({"messages": [HumanMessage(content="Read")], "files": {internal: create_file_data("INTERNAL-MARKER"), str(host): create_file_data("VIRTUAL-HOST-MARKER")}})
    receipt = next(message for message in result["messages"] if isinstance(message, ToolMessage) and message.tool_call_id == "forged-read")
    assert receipt.status == "error" and "not available" in receipt.content
    assert "VIRTUAL-HOST-MARKER" not in str(model.seen[-1]) and "INTERNAL-MARKER" not in str(model.seen[-1])
    assert any("read_file" in menu for menu in model.menus) is not restricted


async def test_sandbox_profile_retains_its_existing_sdk_file_surface():
    model = SchemaModel(replies=[call("read_file", {"file_path": "/workspace/fixture.txt"}, "sandbox-read"), AIMessage(content="Read the existing sandbox path.")])
    graph = create_deep_agent(model=model, backend=StateBackend(), middleware=[RunControls(no_controls, ignore, execution_enabled=True)])
    result = await graph.ainvoke({"messages": [HumanMessage(content="Read the sandbox fixture")], "files": {"/workspace/fixture.txt": create_file_data("SANDBOX-FIXTURE")}})
    assert VIRTUAL_TOOLS - {"delete"} <= model.menus[0].keys()
    receipt = next(message for message in result["messages"] if isinstance(message, ToolMessage) and message.tool_call_id == "sandbox-read")
    assert receipt.status == "success" and "SANDBOX-FIXTURE" in receipt.content


@pytest.mark.parametrize("reset_by_revision", [False, True])
async def test_context_reset_deletes_internal_state_files_and_cannot_reveal_them_next_turn(tmp_path, reset_by_revision):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("Internal history privacy")
    internal_files = {"/large_tool_results/old-result": create_file_data("PRIVATE-FACT"), "/conversation_history/old.md": create_file_data("PRIVATE-FACT")}
    config = {"configurable": {"thread_id": conversation["id"]}}
    async with aiosqlite.connect(settings.data_dir / "checkpoints.sqlite") as connection:
        saver = await _prepare_checkpointer(connection)
        graph = create_deep_agent(model=ScriptedModel(replies=[AIMessage(content="Old answer")]), checkpointer=saver, state_schema=RuntimeState)
        await graph.ainvoke({"messages": [HumanMessage(content="PRIVATE-FACT")], "files": {**internal_files, "/notes/keep.txt": create_file_data("KEEP")}, "model_identity": "test-model", "memory_reset_revision": 0}, config)
        await graph.aupdate_state(config, {"_summarization_event": {"summary_message": HumanMessage(content="PRIVATE-SUMMARY"), "cutoff_index": 999}, "_summarization_session_id": "old-summary-session"})
    if reset_by_revision:
        with store._connection(write=True) as db:
            db.execute("UPDATE conversations SET memory_reset_revision=1 WHERE id=?", (conversation["id"],))
    run = make_run("context-reset", "继续回答" if reset_by_revision else "请忘记这条私人资料")
    run["conversation_id"] = conversation["id"]
    upload = settings.workspace_root / "conversations" / conversation["id"] / "uploads" / "keep.txt"
    upload.parent.mkdir(parents=True)
    upload.write_text("PHYSICAL-KEEP")
    reset = SchemaModel(replies=[AIMessage(content="Context reset handled.")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=reset)
    assert "PRIVATE-FACT" not in str(reset.seen[0])
    assert "PRIVATE-SUMMARY" not in str(reset.seen[0])
    assert run["prompt"] in str(reset.seen[0])
    later_run = {**make_run("after-reset", "Continue"), "conversation_id": conversation["id"]}
    later = SchemaModel(replies=[call("read_file", {"file_path": "/large_tool_results/old-result"}, "old-private-path"), AIMessage(content="The old private reference is unavailable.")])
    await fixture_run_agent(settings, later_run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=later)
    assert "read_file" not in later.menus[0] and "PRIVATE-FACT" not in str(later.seen) and "PRIVATE-SUMMARY" not in str(later.seen)
    receipt = next(message for message in later.seen[-1] if isinstance(message, ToolMessage) and message.tool_call_id == "old-private-path")
    assert receipt.status == "error"
    async with aiosqlite.connect(settings.data_dir / "checkpoints.sqlite") as connection:
        saver = await _prepare_checkpointer(connection)
        graph = create_deep_agent(model=ScriptedModel(replies=[]), checkpointer=saver, state_schema=RuntimeState)
        state = await graph.aget_state(config)
    assert set(internal_files).isdisjoint(state.values["files"])
    assert state.values["files"]["/notes/keep.txt"]["content"] == "KEEP"
    assert state.values.get("_summarization_event") is None
    assert state.values.get("_summarization_session_id") != "old-summary-session"
    assert upload.read_text() == "PHYSICAL-KEEP"


class ResearchReader(SchemaModel):
    child_id: str
    pages: list[dict] = Field(default_factory=list)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(messages)
        if len(self.seen) == 1:
            response = call("start_agent", {"task": "Read the supplied evidence"}, "start")
        else:
            latest = next((message for message in reversed(messages) if isinstance(message, ToolMessage)), None)
            if latest and latest.name == "wait_agents":
                snapshot = json.loads(latest.content)
                receipt = snapshot["agents"][0]
                self.pages.append(receipt)
                if receipt["stopped"] and not receipt["result_truncated"]:
                    return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Collected the complete research result."))])
                if receipt["result_truncated"]:
                    assert "result_offset" in self.menus[-1]["wait_agents"]["schema"]["properties"]
                    response = call("wait_agents", {"agent_ids": [self.child_id], "after": snapshot["cursor"], "result_offset": receipt["next_result_offset"]}, "read-next-page")
                    return ChatResult(generations=[ChatGeneration(message=response)])
            response = call("wait_agents", {"agent_ids": [self.child_id]}, f"wait-{len(self.seen)}")
        return ChatResult(generations=[ChatGeneration(message=response)])


@pytest.mark.parametrize("long_result", [False, True])
async def test_wait_schema_pages_only_when_a_real_child_result_needs_it(tmp_path, monkeypatch, long_result):
    settings = make_settings(tmp_path)
    run = make_run("wait-schema")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    child = ScriptedModel(replies=[AIMessage(content="evidence " * (2200 if long_result else 1))])
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child)
    model = ResearchReader(replies=[], child_id=child_id)
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    wait_menus = [menu["wait_agents"]["schema"] for menu in model.menus if "wait_agents" in menu]
    assert wait_menus
    if long_result:
        assert any("result_offset" in schema["properties"] for schema in wait_menus)
        assert len(model.pages) == 2 and model.pages[0]["next_result_offset"] == model.pages[1]["result_offset"]
    else:
        assert all("result_offset" not in schema["properties"] for schema in wait_menus)
    prompt = str(child.seen[0])
    assert "do not estimate unsupported timing or probabilities" in prompt

