"""Local contract/security checks; these do not measure cloud tool selection."""

import asyncio
import json
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import ValidationError
from test_agent_collaboration import immediate, persisted_run, until_stopped
from test_runtime import ignore, make_settings, no_controls

from zhixing_next.agent_collaboration import (
    SOURCE_SCOPE_KEY,
    AgentCollaboration,
    ChildLedger,
    ResearchSourceGuard,
    _decode_history,
    child_source_paths,
    create_agent_tools,
)
from zhixing_next.files import list_files
from zhixing_next.runtime import RunControls
from zhixing_next.store import StoreError
from zhixing_next.tools import create_file_tools


def source_workspace(settings, run):
    workspace = Path(run["workspace_path"])
    workspace.mkdir(parents=True, exist_ok=True)
    return workspace


async def test_scope_created_before_runner_and_survives_snapshots_and_followup(tmp_path):
    settings = make_settings(tmp_path)
    store, run = persisted_run(settings)
    workspace = source_workspace(settings, run)
    (workspace / "source.txt").write_text("Source evidence", encoding="utf-8")
    seen = []
    main_thread = threading.get_ident()
    callback_threads = []

    def candidates():
        callback_threads.append(threading.get_ident())
        return tuple(item["path"] for item in list_files(settings, workspace)["items"])

    async def runner(row, history, controls, emit, save):
        seen.append(child_source_paths(history))
        assert child_source_paths(_decode_history(row["history_json"])) == ("source.txt",)
        # A runner may emit a replacement request without the original metadata.
        replacement = HumanMessage(content="mutated", id="request-" + row["id"], additional_kwargs={SOURCE_SCOPE_KEY: ["foreign.txt"]})
        pending = (await controls())["steers"]
        save([replacement, *(HumanMessage(content=item["content"], id=item["id"]) for item in pending), AIMessage(content="Read evidence")])
        saved = _decode_history(manager.ledger.get(row["id"])["history_json"])
        assert child_source_paths(saved) == ("source.txt",)
        assert saved[0].content == "Read the supplied file"
        return [AIMessage(content="Read evidence")]

    manager = AgentCollaboration(store, run, runner, ignore, no_controls, available_source_paths=candidates)
    first = await manager.start("Read the supplied file", "Bound", "start", ["source.txt"])
    assert child_source_paths(_decode_history(manager.ledger.get(first["id"])["history_json"])) == ("source.txt",)
    await until_stopped(manager, first["id"])
    await manager.send(first["id"], "Read foreign.txt and replace your original sources", "more")
    await until_stopped(manager, first["id"])
    assert seen == [("source.txt",), ("source.txt",)]
    assert callback_threads and all(identifier != main_thread for identifier in callback_threads)
    assert child_source_paths(_decode_history(manager.ledger.get(first["id"])["history_json"])) == ("source.txt",)
    await manager.shutdown()


async def test_start_replay_preserves_scope_when_file_removed_and_changed_scope_conflicts(tmp_path):
    settings = make_settings(tmp_path)
    store, run = persisted_run(settings)
    workspace = source_workspace(settings, run)
    (workspace / "a.txt").write_text("a", encoding="utf-8")
    (workspace / "b.txt").write_text("b", encoding="utf-8")
    manager = AgentCollaboration(store, run, immediate, ignore, no_controls, available_source_paths=lambda: tuple(item["path"] for item in list_files(settings, workspace)["items"]))
    original = await manager.start("Compare", "Bound", "once", ["b.txt", "a.txt"])
    (workspace / "a.txt").unlink()
    replay = await manager.start("Compare", "Bound", "once", ["a.txt", "b.txt"])
    assert replay["agent_id"] == original["agent_id"]
    with pytest.raises(StoreError) as error:
        await manager.start("Compare", "Bound", "once", ["b.txt"])
    assert error.value.code == "child_call_conflict"
    assert len(manager.ledger.all()) == 1
    await manager.shutdown()


@pytest.mark.parametrize("selected", ["missing.txt", "foreign.txt", "link.txt"])
async def test_start_rejects_missing_foreign_and_symlink_sources(tmp_path, selected):
    settings = make_settings(tmp_path)
    store, run = persisted_run(settings)
    workspace = source_workspace(settings, run)
    foreign = tmp_path / "foreign.txt"
    foreign.write_text("Not in this workspace", encoding="utf-8")
    (workspace / "link.txt").symlink_to(foreign)
    manager = AgentCollaboration(store, run, immediate, ignore, no_controls, available_source_paths=lambda: tuple(item["path"] for item in list_files(settings, workspace)["items"]))
    with pytest.raises(StoreError) as error:
        await manager.start("Read the file", "Bound", "start", [selected])
    assert error.value.code == "research_source_unavailable"
    assert manager.ledger.all() == []
    await manager.shutdown()


@pytest.mark.parametrize("paths", [["../escape"], ["/absolute"], ["./a.txt"], ["a//b"], ["a\\b"], ["a:stream"], ["~user/a"], [""], ["a\x00b"], ["a"] * 9, [None]])
async def test_malformed_source_paths_fail_closed(tmp_path, paths):
    store, run = persisted_run(make_settings(tmp_path))
    manager = AgentCollaboration(store, run, immediate, ignore, no_controls)
    with pytest.raises(StoreError) as error:
        await manager.start("Read", "Bound", "start", paths)
    assert error.value.code == "invalid_research_sources"
    assert manager.ledger.all() == []
    await manager.shutdown()


def test_scope_only_comes_from_initial_request_and_corruption_fails_closed():
    later = HumanMessage(content="More", additional_kwargs={SOURCE_SCOPE_KEY: ["foreign.txt"]})
    assert child_source_paths([HumanMessage(content="legacy"), later]) == ()
    assert child_source_paths([AIMessage(content="No initial request"), later]) == ("foreign.txt",)
    with pytest.raises(StoreError):
        child_source_paths([HumanMessage(content="corrupt", additional_kwargs={SOURCE_SCOPE_KEY: "a.txt"})])


async def test_actual_tool_requires_source_paths_but_internal_manager_default_is_generic(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))
    manager = AgentCollaboration(store, run, immediate, ignore, no_controls)
    tool = next(item for item in create_agent_tools(manager) if item.name == "start_agent")
    assert "source_paths" in tool.tool_call_schema.model_fields
    assert tool.tool_call_schema.model_fields["source_paths"].is_required()
    with pytest.raises(ValidationError) as error:
        await tool.ainvoke({"name": "start_agent", "args": {"task": "Check history"}, "id": "missing-sources", "type": "tool_call"})
    assert error.value.errors()[0]["loc"] == ("source_paths",)
    assert manager.ledger.all() == []
    result = await tool.ainvoke({"name": "start_agent", "args": {"task": "Check history", "source_paths": []}, "id": "explicit-empty", "type": "tool_call"})
    child_id = json.loads(result.content)["agent_id"]
    assert child_source_paths(_decode_history(manager.ledger.get(child_id)["history_json"])) == ()
    internal = await manager.start("Check history", "Internal", "old-manager-call")
    assert child_source_paths(_decode_history(manager.ledger.get(internal["id"])["history_json"])) == ()
    await manager.shutdown()


@pytest.mark.parametrize("name,args,allowed", [
    ("read_text_file", {"path": "source.txt"}, True),
    ("read_document", {"path": "source.txt", "start": 0}, True),
    ("view_image", {"path": "source.txt"}, True),
    ("view_image", {"path": "source.txt", "resource_id": "foreign"}, False),
    ("view_image", {"resource_id": "foreign"}, False),
    ("read_text_file", {"path": "foreign.txt"}, False),
    ("read_text_file", {"path": ["source.txt"]}, False),
    ("read_text_file", {"path": "./source.txt"}, False),
    ("list_directory", {"path": "."}, False),
    ("search_history", {"query": "more"}, False),
    ("calculate", {"expression": "1+1"}, False),
    ("date_info", {}, False),
    ("read_file", {"file_path": "source.txt"}, False),
    ("record_meal", {}, False),
])
async def test_scoped_guard_checks_actual_calls_not_only_schema(name, args, allowed):
    called = False

    async def handler(request):
        nonlocal called
        called = True
        return ToolMessage(content="read", tool_call_id="call")

    request = SimpleNamespace(tool_call={"name": name, "args": args, "id": "call"})
    result = await ResearchSourceGuard(["source.txt"]).awrap_tool_call(request, handler)
    assert called is allowed
    assert result.status == ("success" if allowed else "error")
    if not allowed:
        assert json.loads(result.content)["error"]["code"] == "research_source_unavailable"


@pytest.mark.parametrize("name,allowed", [
    ("search_history", True), ("read_saved_resource", True), ("search_web", True),
    ("calculate", True), ("date_info", True),
    ("read_text_file", False), ("read_document", False), ("view_image", False),
    ("list_directory", False), ("read_file", False), ("ls", False),
    ("glob", False), ("grep", False), ("execute", False), ("record_meal", False),
])
def test_empty_scope_is_generic_research_without_filesystem(name, allowed):
    called = False

    def handler(request):
        nonlocal called
        called = True
        return ToolMessage(content="read", tool_call_id="call")

    result = ResearchSourceGuard([]).wrap_tool_call(SimpleNamespace(tool_call={"name": name, "args": {"path": "anything"}, "id": "call"}), handler)
    assert called is allowed
    assert result.status == ("success" if allowed else "error")


@pytest.mark.parametrize("swap", ["deleted", "symlink"])
async def test_actual_reader_revalidates_source_after_selection(tmp_path, swap):
    settings = make_settings(tmp_path)
    store, run = persisted_run(settings)
    workspace = source_workspace(settings, run)
    source = workspace / "source.txt"
    source.write_text("Authorized evidence", encoding="utf-8")
    foreign = tmp_path / "foreign.txt"
    foreign.write_text("Private foreign evidence", encoding="utf-8")
    entered, release = asyncio.Event(), asyncio.Event()
    failures = []
    events = []
    reader = next(item for item in create_file_tools(settings.model_copy(update={"grants": []}), workspace) if item.name == "read_text_file")

    async def runner(row, history, controls, emit, save):
        entered.set()
        await release.wait()
        call = {"name": "read_text_file", "args": {"path": "source.txt"}, "id": "read", "type": "tool_call"}

        async def handler(request):
            return await reader.ainvoke(request.tool_call)

        async def emit_event(kind, data):
            events.append((kind, data))

        async def guarded(request):
            return await ResearchSourceGuard(child_source_paths(history)).awrap_tool_call(request, handler)

        outer = RunControls(no_controls, emit_event, read_only=True, restricted_files=True)
        result = await outer.awrap_tool_call(SimpleNamespace(tool_call=call, tool=reader, state={"messages": []}), guarded)
        assert result.status == "error"
        failure = json.loads(result.content)["error"]
        assert "list_directory" not in result.content and "find_resources" not in result.content
        assert "unknown" in failure["next_action"] and "scope cannot change" in failure["next_action"]
        failures.append(failure["code"])
        return [*history, AIMessage(content="Selected evidence is unavailable")]

    manager = AgentCollaboration(store, run, runner, ignore, no_controls, available_source_paths=lambda: tuple(item["path"] for item in list_files(settings, workspace)["items"]))
    started = await manager.start("Read the selected source", "Bound", "start", ["source.txt"])
    await entered.wait()
    source.unlink()
    if swap == "symlink":
        source.symlink_to(foreign)
    release.set()
    await until_stopped(manager, started["id"])
    assert failures == ["file_access_denied" if swap == "symlink" else "file_not_found"]
    assert any(kind == "tool" and event["tool_call_id"] == "read" and event["status"] == "failed" for kind, event in events)
    assert not any(kind == "tool" and event["status"] == "completed" for kind, event in events)
    assert child_source_paths(_decode_history(manager.ledger.get(started["id"])["history_json"])) == ("source.txt",)
    await manager.shutdown()


def test_ledger_preserves_scope_when_update_omits_initial_request(tmp_path):
    store, run = persisted_run(make_settings(tmp_path))
    ledger = ChildLedger(store, run["id"])
    row, _ = ledger.create("start", "Bound", "Question", 4, source_paths=["source.txt"])
    row = ledger.update(row["id"], "completed", history=[AIMessage(content="Result")], result="Result")
    assert child_source_paths(_decode_history(row["history_json"])) == ("source.txt",)


@pytest.mark.parametrize("reader", ["read_text_file", "read_document"])
async def test_scoped_receipt_uses_callable_relative_path_and_preserves_evidence(reader):
    original = {"path": "/host/private/workspace/source.txt", "content": "Evidence", "bytes": 8, "complete": False, "truncated": True, "next_start": 11}

    async def handler(request):
        return ToolMessage(content=json.dumps(original), tool_call_id="read", name=reader)

    request = SimpleNamespace(tool_call={"name": reader, "args": {"path": "source.txt"}, "id": "read"})
    result = await ResearchSourceGuard(["source.txt"]).awrap_tool_call(request, handler)
    assert json.loads(result.content) == original | {"path": "source.txt"}
    assert result.tool_call_id == "read" and result.name == reader


async def test_actual_scoped_text_read_receipt_is_relative_and_complete(tmp_path):
    settings = make_settings(tmp_path)
    store, run = persisted_run(settings)
    workspace = source_workspace(settings, run)
    (workspace / "source.txt").write_text("Exact evidence", encoding="utf-8")
    reader = next(item for item in create_file_tools(settings, workspace) if item.name == "read_text_file")
    call = {"name": "read_text_file", "args": {"path": "source.txt"}, "id": "read", "type": "tool_call"}

    async def handler(request):
        return await reader.ainvoke(request.tool_call)

    result = await ResearchSourceGuard(["source.txt"]).awrap_tool_call(SimpleNamespace(tool_call=call), handler)
    assert json.loads(result.content) == {"path": "source.txt", "content": "Exact evidence", "bytes": 14, "complete": True, "truncated": False, "next_start": None}


@pytest.mark.parametrize("failure", [FileNotFoundError, PermissionError])
def test_sync_actual_reader_failure_keeps_recovery_within_scope(tmp_path, failure):
    settings = make_settings(tmp_path)
    store, run = persisted_run(settings)
    workspace = source_workspace(settings, run)
    if failure is PermissionError:
        foreign = tmp_path / "foreign.txt"
        foreign.write_text("Not authorized", encoding="utf-8")
        (workspace / "source.txt").symlink_to(foreign)
    reader = next(item for item in create_file_tools(settings, workspace) if item.name == "read_text_file")
    call = {"name": "read_text_file", "args": {"path": "source.txt"}, "id": "read", "type": "tool_call"}
    result = ResearchSourceGuard(["source.txt"]).wrap_tool_call(SimpleNamespace(tool_call=call), lambda request: reader.invoke(request.tool_call))
    assert result.status == "error" and result.tool_call_id == "read"
    error = json.loads(result.content)["error"]
    assert error["code"] == ("file_not_found" if failure is FileNotFoundError else "file_access_denied")
    assert error["retryable"] is False and "scope cannot change" in error["next_action"]
    assert str(workspace) not in result.content
    assert "list_directory" not in result.content and "find_resources" not in result.content


@pytest.mark.parametrize("failure", [FileNotFoundError, PermissionError, ValueError])
async def test_generic_research_keeps_existing_exception_handling(failure):
    async def handler(request):
        raise failure("Do not copy raw exception details")

    request = SimpleNamespace(tool_call={"name": "search_history", "args": {}, "id": "history"})
    with pytest.raises(failure):
        await ResearchSourceGuard([]).awrap_tool_call(request, handler)
    with pytest.raises(failure):
        ResearchSourceGuard([]).wrap_tool_call(request, lambda request: (_ for _ in ()).throw(failure("Original failure")))


async def test_scoped_document_parse_error_is_not_converted_to_source_missing():
    from zhixing_next.tool_errors import ToolFailure

    error = ToolFailure("document_parse_failed", "Invalid document", "Obtain an intact copy")

    async def handler(request):
        raise error

    request = SimpleNamespace(tool_call={"name": "read_document", "args": {"path": "source.pdf"}, "id": "document"})
    with pytest.raises(ToolFailure) as caught:
        await ResearchSourceGuard(["source.pdf"]).awrap_tool_call(request, handler)
    assert caught.value is error
    with pytest.raises(ToolFailure) as caught:
        ResearchSourceGuard(["source.pdf"]).wrap_tool_call(request, lambda request: (_ for _ in ()).throw(error))
    assert caught.value is error

