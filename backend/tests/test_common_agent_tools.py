import asyncio
import base64
import hashlib
import io
import json
import threading

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from PIL import Image
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.common_reports import create_report_tool
from zhixing_next.common_tools import (
    assign_common_tools,
    create_calculation_tools,
    create_common_tools,
    evaluate_expression,
    last_business_day,
)
from zhixing_next.config import PathGrant
from zhixing_next.operations import Journal, OperationRunner
from zhixing_next.resources import capture_file, create_image_tool, resource_bytes
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store, StoreError
from zhixing_next.tools import create_file_tools


def call(name, args, identifier):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": identifier, "type": "tool_call"}])


@pytest.mark.parametrize(("expression", "expected"), [
    ("16500-10000-2000-180", "4320"), ("0.1+0.2", "0.3"),
    ("(1800+2100)/3", "1300"), ("2**-3", "0.125"), ("10%3", "1"), ("-5//2", "-3"), ("-5%2", "1"),
])
def test_decimal_calculation_is_actual_and_deterministic(expression, expected):
    assert evaluate_expression(expression) == expected


@pytest.mark.parametrize("expression", [
    "__import__('os').environ", "(1).__class__", "[1,2]", "sum([1])", "True+1", "2**1000000",
    "1/0", "1e999", "0x123", "1+" * 200 + "1",
])
def test_calculator_rejects_code_and_unbounded_work(expression):
    with pytest.raises(ValueError):
        evaluate_expression(expression)


def test_last_business_day_is_explicit_about_calendar_and_user_exceptions():
    assert last_business_day("2026-10")["date"] == "2026-10-30"
    assert last_business_day("2026-12")["date"] == "2026-12-31"
    assert last_business_day("2026-10")["calendar_basis"] == "weekdays_only"
    result = last_business_day("2026-10", working_dates=["2026-10-31"])
    assert result["date"] == "2026-10-31" and result["calendar_basis"] == "user_overrides"
    result = last_business_day("2026-12", non_working_dates=["2026-12-31"])
    assert result["date"] == "2026-12-30" and "未接入官方" in result["calendar_note"]
    with pytest.raises(ValueError):
        last_business_day("2026-12", working_dates=["2026-12-31"], non_working_dates=["2026-12-31"])


async def test_date_tool_actual_weekday_range_and_bounds():
    dates = {item.name: item for item in create_calculation_tools()}["date_info"]
    assert (await dates.ainvoke({"operation": "weekday", "date": "2026-10-16"}))["weekday_name"] == "周五"
    result = await dates.ainvoke({"operation": "business_days", "start": "2026-10-29", "end": "2026-11-02", "working_dates": ["2026-10-31"], "non_working_dates": ["2026-10-30"]})
    assert result["dates"] == ["2026-10-29", "2026-10-31", "2026-11-02"]
    assert (await dates.ainvoke({"operation": "add_days", "date": "2026-12-31", "days": 1}))["date"] == "2027-01-01"
    paydays = await dates.ainvoke({"operation": "monthly_last_business_days", "start": "2026-10-16", "end": "2026-12-31"})
    assert paydays["dates"] == ["2026-10-30", "2026-11-30", "2026-12-31"]
    with pytest.raises(ValueError):
        await dates.ainvoke({"operation": "business_days", "start": "2025-01-01", "end": "2026-10-16"})


@pytest.mark.parametrize("agent_id", [None, "finance", "health", "custom-fixture"])
async def test_every_direct_identity_has_the_same_general_tools_and_real_report(tmp_path, agent_id):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("通用能力")
    run = make_run("common-" + str(agent_id))
    run["conversation_id"] = conversation["id"]
    if agent_id:
        run["agent"] = {"id": agent_id, "name": "测试助手", "description": "测试", "instructions": "读取真实信息", "tools": []}
    model = ScriptedModel(replies=[
        call("calculate", {"expression": "16500-10000-2000-180"}, "calc"),
        call("date_info", {"operation": "last_business_day", "month": "2026-12"}, "date"),
        call("publish_report", {"filename": "财务报告.md", "content": "# 预算报告\n\n剩余可用：4320 元。"}, "report"),
        AIMessage(content="报告已交付。"),
    ])

    async def emit(kind, data):
        store.add_event(run["id"], kind, data)

    result = await fixture_run_agent(settings, run, persona="", emit=emit, controls=no_controls, acknowledge=ignore, model_override=model)
    expected = {"search_history", "read_history", "read_history_message", "find_resources", "read_saved_resource", "browse_personal_memories", "list_directory", "read_document", "read_text_file", "fetch_public_page", "calculate", "date_info", "publish_report"}
    assert expected <= set(model.bound_names)
    if agent_id:
        assert {"task", "write_text_file", "execute", "write_file", "read_file"}.isdisjoint(model.bound_names)
    assert "search_web" not in model.bound_names
    receipts = [json.loads(message.content) for message in model.seen[-1] if isinstance(message, ToolMessage)]
    assert receipts[0]["result"] == "4320"
    assert receipts[1]["date"] == "2026-12-31"
    resource = receipts[2]["resource"]
    assert resource["conversation_id"] == conversation["id"]
    assert resource["name"] == "财务报告.md"
    assert resource["path"].startswith("report-")
    assert "4320" in resource_bytes(settings, resource).decode()
    store.finish_run(run["id"], "completed", result=result)
    assert store.list_messages(conversation["id"])["items"][-1]["attachments"][0]["id"] == resource["id"]


@pytest.mark.parametrize("agent_id", ["finance", "health", "research-fixture"])
async def test_delegated_agents_share_history_and_publish_into_root_conversation(tmp_path, agent_id):
    settings = make_settings(tmp_path)
    store = Store(settings)
    source = store.create_conversation("旧约定")["id"]
    store.submit_message(source, id="old-income", content="此前约定的收入预期为 16500 元")
    store.add_memory("每月结余目标为 10000 元")
    run = make_run("delegate-" + agent_id)
    run["agents"] = [{"id": agent_id, "name": "委派助手", "description": "读取信息", "instructions": "整理", "tools": []}]
    name = "finance" if agent_id == "finance" else "agent_" + agent_id.replace("-", "_")
    model = ScriptedModel(replies=[
        call("task", {"description": "从历史取回约定并交付报告", "subagent_type": name}, "delegate"),
        call("search_history", {"query": "收入预期"}, "history"),
        call("browse_personal_memories", {}, "memory"),
        call("publish_report", {"filename": "恢复报告.txt", "content": "收入预期 16500，结余目标 10000。"}, "report"),
        AIMessage(content="已按真实历史提供报告。"),
        AIMessage(content="可以打开报告了。"),
    ])

    async def emit(kind, data):
        store.add_event(run["id"], kind, data)

    assert await fixture_run_agent(settings, run, persona="", emit=emit, controls=no_controls, acknowledge=ignore, model_override=model) == "可以打开报告了。"
    events = store.list_events(run["id"], limit=1000)["items"]
    artifact = next(item["data"] for item in events if item["type"] == "artifact")
    assert artifact["resource"]["conversation_id"] == run["conversation_id"]
    assert "16500" in resource_bytes(settings, artifact["resource"]).decode()
    assert any("## Current Specialist Runtime" in str(message.content)
               and "知行 (Zhixing)" in str(message.content)
               for messages in model.seen for message in messages if message.type == "system")
    assert any("每月结余目标" in str(message.content) for messages in model.seen for message in messages if isinstance(message, ToolMessage))


async def test_common_files_cannot_escape_into_host_grants_or_service_database(tmp_path):
    settings = make_settings(tmp_path)
    external = tmp_path / "granted"
    external.mkdir()
    (external / "income.txt").write_text("private external content")
    settings.grants = [PathGrant(path=external, writable=True)]
    store = Store(settings)
    conversation = store.create_conversation("权限测试")["id"]
    workspace = store.workspace_for(conversation)
    workspace.mkdir(parents=True, exist_ok=True)
    tools = {item.name: item for item in create_common_tools(settings, {"conversation_id": conversation}, workspace, ignore)}
    (workspace / "upload.txt").write_text("当前附件")
    assert "当前附件" in (await tools["read_text_file"].ainvoke({"path": "upload.txt"}))["content"]
    for path in [str(external / "income.txt"), str(settings.data_dir / "app.sqlite"), "../outside.txt"]:
        with pytest.raises(PermissionError):
            await tools["read_text_file"].ainvoke({"path": path})
    assert {"write_text_file", "execute", "inspect_environment"}.isdisjoint(tools)
    assigned = {item.name: item for item in assign_common_tools(list(tools.values()), ["read_text_file"], {item.name: item for item in create_file_tools(settings, workspace)})}
    with pytest.raises(PermissionError):
        await assigned["read_text_file"].ainvoke({"path": str(external / "income.txt")})


async def test_explicit_search_and_model_image_gates_are_shared(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("可选能力")["id"]
    workspace = store.workspace_for(conversation)
    run = {"conversation_id": conversation, "search_provider": {"id": "fixture", "name": "search", "kind": "brave", "api_key": "private-fixture"}}
    enabled = create_common_tools(settings, run, workspace, ignore, image_input=True)
    available = {item.name: item for item in enabled}
    assert {"search_web", "view_image"} <= available.keys()
    disabled = create_common_tools(settings, {"conversation_id": conversation}, workspace, ignore)
    assigned = {item.name for item in assign_common_tools(disabled, ["search_web", "view_image"], available)}
    assert {"search_web", "view_image"}.isdisjoint(assigned)


async def test_common_image_tool_reads_immutable_history_without_host_or_current_workspace_access(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    source, current = (store.create_conversation(title)["id"] for title in ["旧截图", "财务新会话"])
    output = io.BytesIO()
    Image.new("RGB", (12, 8), "red").save(output, format="PNG")
    source_workspace = store.workspace_for(source)
    (source_workspace / "statement.png").write_bytes(output.getvalue())
    resource = capture_file(settings, source, "statement.png")
    (source_workspace / "statement.png").write_bytes(b"changed working copy")
    workspace = store.workspace_for(current)
    run = {"conversation_id": current}
    tools = {item.name: item for item in create_common_tools(settings, run, workspace, ignore, image_input=True)}
    blocks = await tools["view_image"].ainvoke({"resource_id": resource["id"]})
    data = base64.b64decode(blocks[0]["image_url"]["url"].split(",", 1)[1])
    assert Image.open(io.BytesIO(data)).size == (12, 8)
    assert "view_image" not in {item.name for item in create_common_tools(settings, run, workspace, ignore)}
    with pytest.raises(StoreError):
        await create_image_tool(settings, workspace, current).ainvoke({"resource_id": resource["id"]})
    with pytest.raises(PermissionError):
        await tools["view_image"].ainvoke({"path": str(source_workspace / "statement.png")})
    (settings.data_dir / "resources" / resource["id"]).write_bytes(b"tampered original")
    with pytest.raises(StoreError) as invalid:
        await tools["view_image"].ainvoke({"resource_id": resource["id"]})
    assert invalid.value.code == "resource_changed"


async def test_reports_are_immutable_idempotent_bounded_and_reject_linked_paths(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("报告")["id"]
    workspace = store.workspace_for(conversation)
    workspace.mkdir(parents=True, exist_ok=True)
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    report = create_report_tool(settings, {"conversation_id": conversation}, workspace, emit)
    arguments = {"filename": "report.csv", "content": "项目,金额\n房租,2000\n"}
    first = await report.ainvoke(arguments)
    second = await report.ainvoke(arguments)
    assert first == second and first["verification"]["checks"][-1] == "csv_parse"
    assert first["verification"]["sha256"] == hashlib.sha256(arguments["content"].encode()).hexdigest()
    for filename in ["../report.md", "/etc/report.txt", "folder/report.md", "report.html", ".env", "a\\report.txt"]:
        with pytest.raises((ValueError, PermissionError)):
            await report.ainvoke({"filename": filename, "content": "报告"})
    with pytest.raises(ValueError):
        await report.ainvoke({"filename": "large.md", "content": "字" * 90000})
    target = workspace / first["resource"]["path"]
    target.unlink()
    outside = tmp_path / "outside"
    outside.write_text("outside")
    target.symlink_to(outside)
    with pytest.raises(PermissionError):
        await report.ainvoke(arguments)
    assert outside.read_text() == "outside" and len(events) == 2


async def test_publish_report_replays_after_crash_without_new_resource_or_approval(tmp_path):
    class Crash(BaseException):
        pass

    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("恢复报告")["id"]
    store.submit_message(conversation, id="input", content="交付报告")
    run = store.claim_next("chat")
    workspace = store.workspace_for(conversation)
    workspace.mkdir(parents=True, exist_ok=True)
    runner = OperationRunner(settings, {**run, "workspace_path": str(workspace)})

    async def emit(kind, data):
        store.add_event(run["id"], kind, data)

    tool = create_report_tool(settings, run, workspace, emit)
    arguments = {"filename": "receipt.md", "content": "# 已核验的报告"}
    request = {"id": "report-write", "name": "publish_report", "args": arguments}
    seen = []

    async def crashed():
        seen.append(await tool.ainvoke(arguments))
        raise Crash()

    with pytest.raises(Crash):
        await runner.invoke(request, crashed)
    assert Journal(settings).receipts(run["id"])["items"][0]["state"] == "started"

    async def recovered():
        result = await tool.ainvoke(arguments)
        return ToolMessage(content=json.dumps(result), tool_call_id=request["id"])

    result = await OperationRunner(settings, {**run, "workspace_path": str(workspace)}).invoke(request, recovered)
    resource = json.loads(result.content)["resource"]
    assert resource["id"] == seen[0]["resource"]["id"]
    assert Journal(settings).approvals()["items"] == []
    assert Journal(settings).receipts(run["id"])["items"][0]["state"] == "succeeded"
    store.finish_run(run["id"], "completed", result="报告可打开")
    assert len(store.list_messages(conversation)["items"][-1]["attachments"]) == 1


async def test_cancellation_waits_for_actual_report_publication_receipt(tmp_path, monkeypatch):
    import zhixing_next.common_reports as reports

    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("取消报告")["id"]
    store.submit_message(conversation, id="input", content="报告")
    run = store.claim_next("chat")
    entered, release = threading.Event(), threading.Event()
    original = reports.capture_file

    def delayed_capture(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)

    monkeypatch.setattr(reports, "capture_file", delayed_capture)
    events = []

    async def emit(kind, data):
        events.append((kind, data))
        store.add_event(run["id"], kind, data)

    model = ScriptedModel(replies=[call("publish_report", {"filename": "actual.txt", "content": "实际交付"}, "report")])
    task = asyncio.create_task(run_agent(settings, run, persona="", emit=emit, controls=no_controls, acknowledge=ignore, model_override=model))
    assert await asyncio.to_thread(entered.wait, 5)
    task.cancel()
    await asyncio.sleep(0.05)
    assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    artifact = next(data for kind, data in events if kind == "artifact")
    assert resource_bytes(settings, artifact["resource"]).decode() == "实际交付"
    assert ("tool", {"tool": "publish_report", "tool_call_id": "report", "status": "completed", "cancel_requested": True}) in events
