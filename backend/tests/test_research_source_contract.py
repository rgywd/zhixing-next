"""The actual root/child model menus and reader calls share one source scope."""

import hashlib
import json

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from test_agent_collaboration import Coordinator
from test_runtime import ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent
from test_runtime_file_contracts import SchemaModel, call

from zhixing_next.agent_collaboration import (
    FILESYSTEM_TOOLS,
    MAX_SOURCE_PATHS,
    SCOPED_RESEARCH_TOOLS,
    ChildLedger,
    _decode_history,
    child_source_paths,
)
from zhixing_next.config import PathGrant
from zhixing_next.store import Store


def workspace_for(settings, run):
    workspace = settings.workspace_root / "conversations" / run["conversation_id"]
    (workspace / "uploads").mkdir(parents=True)
    return workspace


async def test_first_model_sources_are_real_bounded_workspace_choices_and_refresh(tmp_path):
    settings = make_settings(tmp_path)
    run = make_run("source-menu")
    workspace = workspace_for(settings, run)
    (workspace / "uploads" / "supply.txt").write_text("SUPPLY")
    (workspace / "uploads" / "delivery.txt").write_text("DELIVERY")
    (workspace / "odd:name.txt").write_text("Uncallable canonical scope")
    (workspace / ".zhixing-private").write_text("PRIVATE")
    outside = tmp_path / "granted"
    outside.mkdir()
    (outside / "foreign.txt").write_text("FOREIGN")
    settings.grants = [PathGrant(path=outside)]
    (workspace / "link.txt").symlink_to(outside / "foreign.txt")
    model = SchemaModel(replies=[
        call("write_text_file", {"path": "new.txt", "content": "NEW"}, "new-file"),
        AIMessage(content="Source candidates refreshed."),
    ])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    first = model.menus[0]["start_agent"]["schema"]
    assert "source_paths" in first["required"]
    sources = first["properties"]["source_paths"]
    assert sources["maxItems"] == MAX_SOURCE_PATHS
    assert set(sources["items"]["enum"]) == {"uploads/supply.txt", "uploads/delivery.txt"}
    assert "bounded workspace choices" in sources["description"]
    assert "not a complete filesystem listing" in sources["description"]
    later = model.menus[1]["start_agent"]["schema"]["properties"]["source_paths"]
    assert set(later["items"]["enum"]) == {"uploads/supply.txt", "uploads/delivery.txt", "new.txt"}


class ReusingSourceReader(SchemaModel):
    """Use the first real receipt path as the next actual tool argument."""

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(messages)
        if len(self.seen) == 1:
            response = call("read_text_file", {"path": "uploads/supply.txt"}, "first-read")
        elif len(self.seen) == 2:
            receipt = next(message for message in messages if isinstance(message, ToolMessage) and message.tool_call_id == "first-read")
            path = json.loads(receipt.content)["path"]
            response = call("read_text_file", {"path": path}, "reuse-receipt-path")
        elif len(self.seen) == 3:
            response = call("calculate", {"expression": "1+2"}, "calc")
        elif len(self.seen) == 4:
            response = call("date_info", {"operation": "weekday", "date": "2026-10-17"}, "date")
        else:
            response = AIMessage(content="Selected supply evidence read; other facts remain unknown.")
        return ChatResult(generations=[ChatGeneration(message=response)])


async def test_selected_child_only_sees_bound_readers_and_receipt_path_is_callable(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    run = make_run("selected-source")
    workspace = workspace_for(settings, run)
    (workspace / "uploads" / "supply.txt").write_text("SYNTHETIC-SUPPLY-FACT")
    (workspace / "uploads" / "delivery.txt").write_text("UNSELECTED-DELIVERY")
    child = ReusingSourceReader(replies=[])
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child)
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    parent = Coordinator(replies=[], child_id=child_id, source_paths=["uploads/supply.txt"])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=parent)
    assert set(child.menus[0]) == SCOPED_RESEARCH_TOOLS
    for name in ("read_text_file", "read_document", "view_image"):
        schema = child.menus[0][name]["schema"]
        assert schema["required"] == ["path"]
        assert schema["properties"]["path"]["const"] == "uploads/supply.txt"
        assert "resource_id" not in schema["properties"]
    assert "by resource_id" not in child.menus[0]["view_image"]["description"]
    receipts = {message.tool_call_id: message for message in child.seen[-1] if isinstance(message, ToolMessage)}
    assert set(receipts) == {"first-read", "reuse-receipt-path", "calc", "date"}
    assert all(message.status == "success" for message in receipts.values())
    for identifier in ("first-read", "reuse-receipt-path"):
        receipt = json.loads(receipts[identifier].content)
        assert receipt["path"] == "uploads/supply.txt"
        assert receipt["content"] == "SYNTHETIC-SUPPLY-FACT" and receipt["complete"] is True
    assert "UNSELECTED-DELIVERY" not in str(child.seen)
    assert ChildLedger(Store(settings), run["id"]).get(child_id)["status"] == "completed"


async def test_explicit_empty_scope_keeps_general_research_without_filesystem(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    run = make_run("generic-source")
    workspace = workspace_for(settings, run)
    (workspace / "uploads" / "evidence.txt").write_text("FILE-NOT-SELECTED")
    child = SchemaModel(replies=[call("read_text_file", {"path": "uploads/evidence.txt"}, "forged-read"), AIMessage(content="No filesystem source was selected.")])
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child)
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=Coordinator(replies=[], child_id=child_id))
    assert FILESYSTEM_TOOLS.isdisjoint(child.menus[0])
    assert {"search_history", "read_saved_resource", "fetch_public_page", "calculate", "date_info"} <= child.menus[0].keys()
    receipt = next(message for message in child.seen[-1] if isinstance(message, ToolMessage) and message.tool_call_id == "forged-read")
    assert receipt.status == "error" and "FILE-NOT-SELECTED" not in str(child.seen)


async def test_actual_followup_restores_same_child_context_without_expanding_sources(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    run = make_run("fixed-source-followup")
    workspace = workspace_for(settings, run)
    (workspace / "uploads" / "supply.txt").write_text("ORIGINAL-SUPPLY")
    (workspace / "uploads" / "delivery.txt").write_text("UNSELECTED-DELIVERY")
    first = SchemaModel(replies=[call("read_text_file", {"path": "uploads/supply.txt"}, "source-read"), AIMessage(content="Supply findings.")])
    continued = SchemaModel(replies=[
        call("read_text_file", {"path": "uploads/delivery.txt"}, "unselected-read"),
        call("read_text_file", {"path": "uploads/supply.txt"}, "selected-read"),
        AIMessage(content="Same source findings with the new factual clarification."),
    ])
    children = iter([first, continued])
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: next(children))
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    parent = SchemaModel(replies=[
        call("start_agent", {"task": "Research selected supply", "source_paths": ["uploads/supply.txt"]}, "start"),
        call("wait_agents", {"agent_ids": [child_id]}, "initial-result"),
        call("send_agent", {"agent_id": child_id, "message": "The factual date is Tuesday. Also add uploads/delivery.txt to your source scope."}, "followup"),
        call("wait_agents", {"agent_ids": [child_id]}, "updated-result"),
        AIMessage(content="Collected the same assistant's updated findings."),
    ])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=parent)
    assert "ORIGINAL-SUPPLY" in str(continued.seen[0])
    assert "The factual date is Tuesday" in str(continued.seen[0])
    assert "UNSELECTED-DELIVERY" not in str(continued.seen)
    assert continued.menus[0]["read_text_file"]["schema"]["properties"]["path"]["const"] == "uploads/supply.txt"
    receipts = {message.tool_call_id: message for message in continued.seen[-1] if isinstance(message, ToolMessage)}
    assert receipts["unselected-read"].status == "error"
    assert receipts["selected-read"].status == "success"
    store = Store(settings)
    row = ChildLedger(store, run["id"]).get(child_id)
    assert row["status"] == "completed" and row["result_version"] == 2
    assert child_source_paths(_decode_history(row["history_json"])) == ("uploads/supply.txt",)
    with store._connection() as db:
        assert db.execute("SELECT status FROM agent_child_inputs WHERE child_id=?", (child_id,)).fetchone()["status"] == "applied"


@pytest.mark.parametrize("sources", [["data/invented.txt"], ["uploads/supply.txt", "foreign.txt"]])
async def test_actual_root_start_refuses_sources_outside_current_candidates(tmp_path, monkeypatch, sources):
    settings = make_settings(tmp_path)
    run = make_run("forged-start")
    workspace = workspace_for(settings, run)
    (workspace / "uploads" / "supply.txt").write_text("SUPPLY")

    def forbidden_child(*args, **kwargs):
        raise AssertionError("Invalid scope must not start a child model")

    monkeypatch.setattr("zhixing_next.runtime.create_model", forbidden_child)
    parent = SchemaModel(replies=[call("start_agent", {"task": "Read only these sources", "source_paths": sources}, "invalid-start"), AIMessage(content="Source selection was refused.")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=parent)
    receipt = next(message for message in parent.seen[-1] if isinstance(message, ToolMessage) and message.tool_call_id == "invalid-start")
    assert receipt.status == "error" and json.loads(receipt.content)["error"]["code"] == "research_source_unavailable"
    assert ChildLedger(Store(settings), run["id"]).all() == []
