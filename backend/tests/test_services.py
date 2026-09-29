from datetime import UTC, datetime, timedelta

import pytest

from zhixing_next.config import Settings
from zhixing_next.services import create_background_task_tool, create_schedule_tools
from zhixing_next.store import Store


async def test_natural_chat_dispatch_is_durable_and_idempotent(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "workspaces")
    store = Store(settings)
    conversation = store.create_conversation("委托")["id"]
    store.submit_message(conversation, id="chat", content="做一份表格")
    run = store.claim_next("chat")
    tool = create_background_task_tool(settings, run)
    first = await tool.ainvoke({"instructions": "做表格并检查"})
    second = await tool.ainvoke({"instructions": "做表格并检查"})
    assert first == second and first["status"] == "queued"
    assert store.claim_next("task") is None
    store.finish_run(run["id"], "completed", result="已开始处理")
    claimed = Store(settings).claim_next("task")
    assert claimed["id"] == first["run_id"] and claimed["prompt"] == "做表格并检查"
    task_input = next(
        item
        for item in store.list_messages(conversation)["items"]
        if item["run_id"] == claimed["id"]
    )
    assert task_input["origin"] == "assistant_task"
    store.finish_run(claimed["id"], "completed", result="表格完成")
    assert store.memory_context(claimed["id"]) == []
    from zhixing_next.memory import organize_run

    # No configured cloud model is needed for an empty user-fact extraction.
    assert await organize_run(settings, store, claimed)
    assert store.list_memories()["items"] == []


async def test_schedule_tools_operate_real_service_and_validate_timezone(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "workspaces")
    store = Store(settings)
    conversation = store.create_conversation("提醒")["id"]
    store.submit_message(conversation, id="chat", content="明天整理资料")
    run = store.claim_next("chat")
    tools = {item.name: item for item in create_schedule_tools(settings, run)}
    due = datetime.now(UTC) + timedelta(days=1)
    payload = {"prompt": "整理资料", "next_run_at": due.isoformat()}
    first = await tools["schedule_task"].ainvoke(payload)
    assert await tools["schedule_task"].ainvoke(payload) == first
    assert (await tools["list_scheduled_tasks"].ainvoke({}))["items"][0]["id"] == first["id"]
    paused = await tools["set_schedule_enabled"].ainvoke(
        {"schedule_id": first["id"], "enabled": False}
    )
    assert not paused["enabled"]
    with pytest.raises(ValueError):
        await tools["schedule_task"].ainvoke(
            {**payload, "next_run_at": due.replace(tzinfo=None).isoformat()}
        )
