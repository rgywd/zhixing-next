import json
from types import SimpleNamespace

import httpx
import pytest
from langchain_core.messages import AIMessage, ToolMessage
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.resources import capture_file
from zhixing_next.retrieval import create_retrieval_tools
from zhixing_next.runtime import RunControls
from zhixing_next.store import Store
from zhixing_next.tool_errors import ToolFailure, safe_tool_failure
from zhixing_next.webtools import fetch_public_page, read_public_page


def call(name, args, identifier):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": identifier, "type": "tool_call"}])


@pytest.mark.parametrize("agent_id", [None, "finance", "health"])
async def test_same_graph_can_repair_wrong_reader_without_repeating_user_input(tmp_path, agent_id):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("reader repair")
    workspace = store.workspace_for(conversation["id"])
    (workspace / "notes.txt").write_text("Actual saved content.")
    run = {**make_run("reader-repair"), "conversation_id": conversation["id"]}
    if agent_id:
        run["agent"] = {"id": agent_id, "name": "fixture", "description": "", "instructions": "", "tools": []}
    model = ScriptedModel(replies=[
        call("read_document", {"path": "notes.txt"}, "wrong-reader"),
        call("read_text_file", {"path": "notes.txt"}, "right-reader"),
        AIMessage(content="Read successfully."),
    ])
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    await fixture_run_agent(settings, run, persona="", emit=emit, controls=no_controls, acknowledge=ignore, model_override=model)
    replies = [message for message in model.seen[-1] if isinstance(message, ToolMessage)]
    error = json.loads(replies[0].content)["error"]
    assert error["code"] == "document_format_unsupported"
    assert "read_text_file" in error["next_action"] and not error["retryable"]
    assert replies[0].status == "error"
    assert json.loads(replies[1].content)["content"] == "Actual saved content."
    assert any(kind == "tool" and event.get("status") == "failed" and event.get("tool_call_id") == "wrong-reader" for kind, event in events)


async def test_operation_planning_file_denial_is_safe_and_can_repair_in_same_run(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("write repair")["id"]
    forbidden = tmp_path / "outside-do-not-echo.txt"
    run = {**make_run("write-repair"), "conversation_id": conversation}
    model = ScriptedModel(replies=[
        call("write_text_file", {"path": str(forbidden), "content": "result"}, "denied-write"),
        call("write_text_file", {"path": "result.txt", "content": "result"}, "permitted-write"),
        AIMessage(content="Saved."),
    ])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    reply = next(message for message in model.seen[-1] if isinstance(message, ToolMessage) and message.tool_call_id == "denied-write")
    assert reply.status == "error" and json.loads(reply.content)["error"]["code"] == "file_access_denied"
    assert "do-not-echo" not in reply.content and str(tmp_path) not in reply.content
    assert not forbidden.exists()
    assert (store.workspace_for(conversation) / "result.txt").read_text() == "result"


async def test_malformed_write_parameters_can_be_repaired_before_operation_planning(tmp_path):
    from zhixing_next.operations import Journal

    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("parameter repair")["id"]
    run = {**make_run("parameter-repair"), "conversation_id": conversation}
    model = ScriptedModel(replies=[
        call("write_text_file", {"path": {"secret": "do-not-echo"}, "content": "result"}, "malformed-write"),
        call("write_text_file", {"path": "result.txt", "content": "result"}, "permitted-write"),
        AIMessage(content="Saved."),
    ])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    reply = next(message for message in model.seen[-1] if isinstance(message, ToolMessage) and message.tool_call_id == "malformed-write")
    assert reply.status == "error" and json.loads(reply.content)["error"]["code"] == "invalid_tool_parameters"
    assert "do-not-echo" not in reply.content
    assert (store.workspace_for(conversation) / "result.txt").read_text() == "result"
    assert {item["call_id"] for item in Journal(settings).receipts(run["id"])["items"]} == {"permitted-write"}


@pytest.mark.parametrize(("exception", "code"), [
    (FileNotFoundError("/private/service/token=do-not-echo"), "file_not_found"),
    (PermissionError("/private/service/token=do-not-echo"), "file_access_denied"),
    (UnicodeDecodeError("utf8", b"\xff", 0, 1, "do-not-echo"), "text_encoding_unsupported"),
    (RuntimeError("/private/service/token=do-not-echo"), "file_operation_failed"),
])
def test_file_feedback_never_echoes_raw_paths_values_or_unknown_errors(exception, code):
    result = safe_tool_failure(exception, "read_text_file")
    assert result["code"] == code and result["next_action"]
    assert "do-not-echo" not in json.dumps(result) and "/private/service" not in json.dumps(result)
    assert safe_tool_failure(exception, "unrelated_tool") is None


async def test_file_parameter_feedback_is_actionable_without_echoing_values():
    # Validate before ToolNode can format all of the supplied values into its error.
    import tempfile
    from pathlib import Path

    from zhixing_next.tools import create_file_tools

    with tempfile.TemporaryDirectory() as directory:
        settings = make_settings(Path(directory))
        tool = next(item for item in create_file_tools(settings, settings.workspace_root) if item.name == "read_text_file")
        request = SimpleNamespace(tool=tool, tool_call={"id": "bad-input", "name": tool.name, "args": {"path": {"secret": "do-not-echo"}}}, state={"messages": []})
        called = False

        async def handler(request):
            nonlocal called
            called = True

        reply = await RunControls(no_controls, ignore)._invoke_tool(request, handler)
    error = json.loads(reply.content)["error"]
    assert error["code"] == "invalid_tool_parameters" and error["fields"][0]["field"] == "path"
    assert reply.status == "error" and not called and "do-not-echo" not in reply.content


@pytest.mark.parametrize(("status", "code", "retryable"), [(404, "page_not_found", False), (429, "page_rate_limited", True), (403, "page_access_denied", False), (503, "page_http_error", True)])
async def test_web_http_errors_are_repairable_and_real_failures(monkeypatch, status, code, retryable):
    async def resolver(url):
        return "93.184.216.34"

    async def read(url):
        return await read_public_page(url, resolver=resolver, transport=httpx.MockTransport(lambda request: httpx.Response(status)))

    monkeypatch.setattr("zhixing_next.webtools.read_public_page", read)
    request = SimpleNamespace(tool=fetch_public_page, tool_call={"id": "web", "name": "fetch_public_page", "args": {"url": "https://source.example/private?token=do-not-echo"}}, state={"messages": []})
    events = []

    async def emit(kind, event):
        events.append((kind, event))

    async def handler(request):
        return await fetch_public_page.ainvoke(request.tool_call["args"])

    reply = await RunControls(no_controls, emit)._invoke_tool(request, handler)
    error = json.loads(reply.content)["error"]
    assert error["code"] == code and error["retryable"] is retryable and error["next_action"]
    assert reply.status == "error" and events[-1][1]["status"] == "failed"
    assert "do-not-echo" not in reply.content and "source.example" not in reply.content


async def test_invalid_url_is_actionable_without_exposing_url_credentials():
    with pytest.raises(ToolFailure) as caught:
        await fetch_public_page.ainvoke({"url": "https://source.example:invalid/?token=do-not-echo"})
    assert caught.value.receipt["code"] == "page_url_invalid"
    assert "do-not-echo" not in json.dumps(caught.value.receipt)


@pytest.mark.parametrize("media_type", ["text/markdown", "text/csv", "application/json"])
async def test_public_text_formats_do_not_require_upload_round_trip(media_type):
    async def resolver(url):
        return "93.184.216.34"

    content = '{"description":"<p>Keep literal markup</p>"}'
    result = await read_public_page("https://source.example/text", resolver=resolver,
                                    transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": media_type}, text=content)))
    assert result["text"] == content


async def test_saved_resource_long_line_is_completely_readable_via_returned_cursor(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("long report")["id"]
    workspace = store.workspace_for(conversation)
    content = "甲" * 25001 + "\nActual final record"
    (workspace / "report.txt").write_text(content)
    resource = capture_file(settings, conversation, "report.txt")
    reader = next(item for item in create_retrieval_tools(store) if item.name == "read_saved_resource")
    arguments = {"resource_id": resource["id"]}
    chunks = []
    for _ in range(4):
        result = await reader.ainvoke(arguments)
        chunks.append(result["text"])
        assert len(result["text"]) <= 12000
        if result["next_start"] is None:
            break
        arguments.update(start=result["next_start"], char_offset=result["next_char_offset"] or 0)
    assert "".join(chunks) == content
    assert len(chunks) == 3


async def test_document_parse_error_does_not_expose_parser_data(tmp_path):
    from zhixing_next.tools import FileAccess

    settings = make_settings(tmp_path)
    settings.workspace_root.mkdir(parents=True)
    (settings.workspace_root / "broken.docx").write_bytes(b"not-a-zip do-not-echo")
    with pytest.raises(ToolFailure) as caught:
        FileAccess(settings, settings.workspace_root).read_document("broken.docx")
    assert caught.value.receipt["code"] == "document_parse_failed"
    assert "do-not-echo" not in json.dumps(caught.value.receipt)


@pytest.mark.parametrize("delegated", [False, True])
async def test_health_writes_bind_actual_seen_input_and_reuse_provider_ids_after_steer(tmp_path, delegated):
    from test_finance_write_stream import execute, tool
    from test_live_stream import StreamingModel, chunk

    from zhixing_next.finance_context import active_finance_input, delegated_finance_input
    from zhixing_next.health_service import HealthService
    from zhixing_next.operations import Journal

    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("health source", agent_id=None if delegated else "health")["id"]
    store.submit_message(conversation, id="health-first", content="记录2026年10月15日早上8点体重95公斤。")
    run = store.claim_next("chat")
    if delegated:
        run["agents"] = store.list_agents()["items"]
    else:
        run["agent"] = store.get_agent("health")
    sent = False

    async def on_emit(kind, data):
        nonlocal sent
        if not sent and kind == "tool" and data.get("tool") == ("task" if delegated else "record_weight") and data.get("status") == "completed":
            store.submit_message(conversation, id="health-steer", content="再记录2026年10月16日早上8点体重94.5公斤。", intent="steer", target_run_id=run["id"])
            sent = True

    first = tool("record_weight", {"measured_at": "2026-10-15T08:00:00+08:00", "value": 95, "entry_key": "weight"}, "same-weight")
    second = tool("record_weight", {"measured_at": "2026-10-16T08:00:00+08:00", "value": 94.5, "entry_key": "weight"}, "same-weight")
    if delegated:
        arguments = {"description": "记录当前用户给出的体重。", "subagent_type": "agent_health"}
        plans = [[tool("task", arguments, "same-health-task")], [first], [chunk("第一条已保存。")],
                 [tool("task", arguments, "same-health-task")], [second], [chunk("第二条已保存。")], [chunk("已完成。")]]
    else:
        plans = [[first], [second], [chunk("已保存两次测量。")]]
    await execute(settings, store, run, StreamingModel(plans=plans), on_emit)
    rows = HealthService(store).list("weights")["items"]
    assert len(rows) == 2
    assert {row["source_id"] for row in rows} == {"health-first", "health-steer"}
    assert {float(row["value_kg"]) for row in rows} == {95, 94.5}
    receipts = Journal(settings).receipts(run["id"])["items"]
    assert {item["call_id"] for item in receipts} >= {"same-weight", "same-weight:health-steer"}
    assert all(item["state"] == "succeeded" for item in receipts)
    assert active_finance_input.get() is None and delegated_finance_input.get() is None
