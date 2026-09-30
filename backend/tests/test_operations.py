import json
from pathlib import Path

import httpx
import pytest
from langchain_core.messages import AIMessage, ToolMessage
from test_runtime import ScriptedModel, ignore, no_controls

from zhixing_next.api import create_app
from zhixing_next.config import PathGrant, Settings
from zhixing_next.operations import Journal, RunPaused
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store, StoreError
from zhixing_next.tools import FileAccess
from zhixing_next.worker import Worker


class Crash(BaseException):
    """Simulate process loss without the worker's ordinary exception cleanup."""


@pytest.fixture
def setup(tmp_path):
    external = tmp_path / "documents"
    external.mkdir()
    target = external / "notes.txt"
    target.write_text("original")
    settings = Settings(
        data_dir=tmp_path / "data",
        workspace_root=tmp_path / "workspaces",
        api_token="x" * 30,
        grants=[PathGrant(path=external, writable=True)],
    )
    store = Store(settings)
    conversation = store.create_conversation("恢复和批准")["id"]
    store.submit_message(conversation, id="first", content="修改文件", kind="task")
    run = store.claim_next("task")
    return settings, store, run, target


def write_call(path, identifier="write", content="updated", overwrite=True):
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "write_text_file",
                "args": {"path": str(path), "content": content, "overwrite": overwrite},
                "id": identifier,
                "type": "tool_call",
            }
        ],
    )


async def invoke(settings, run, model):
    return await run_agent(
        settings,
        run,
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )


async def test_overwrite_approval_is_durable_scoped_idempotent_and_resumes_original_run(setup):
    settings, store, run, target = setup
    model = ScriptedModel(replies=[write_call(target), AIMessage(content="文件已更新")])

    async def runner(settings, run, **callbacks):
        return await run_agent(settings, run, **callbacks, model_override=model)

    worker = Worker(settings, runner)
    store.submit_message(run["conversation_id"], id="later", content="后续输入", kind="task")
    await worker._execute(run)
    assert target.read_text() == "original"
    assert store.get_run(run["id"])["phase"] == "approval"
    assert Store(settings).claim_next("task") is None
    app = create_app(settings)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test"
    ) as client:
        assert (await client.get("/v1/approvals")).status_code == 401
        client.headers["Authorization"] = "Bearer " + settings.api_token
        approval = (await client.get("/v1/approvals")).json()["items"][0]
        assert approval["details"]["path"] == str(target)
        assert (
            "-original" in approval["details"]["preview"]
            and "+updated" in approval["details"]["preview"]
        )
        preview = f"/v1/approvals/{approval['id']}/file"
        assert (await client.get(preview)).content == b"updated"
        assert (await client.get(preview, params={"version": "before"})).content == b"original"
        route = f"/v1/approvals/{approval['id']}/decision"
        first = await client.post(route, json={"decision": "approve"})
        assert first.status_code == 200
        assert (await client.post(route, json={"decision": "approve"})).json() == first.json()
        assert (await client.post(route, json={"decision": "deny"})).status_code == 409
    resumed = Store(settings).claim_next("task")
    assert resumed["id"] == run["id"]
    await worker._execute(resumed)
    assert target.read_text() == "updated"
    assert store.get_run(run["id"])["status"] == "completed"
    assert store.claim_next("task")["message_id"] == "later"
    operation = Journal(settings).receipts(run["id"])["items"][0]
    assert operation["state"] == "succeeded" and operation["plan"]["backup"]
    assert (
        settings.data_dir / "operation-files" / operation["id"] / "before"
    ).read_text() == "original"
    receipt = next(
        json.loads(message.content)
        for message in model.seen[-1]
        if isinstance(message, ToolMessage) and message.tool_call_id == "write"
    )
    assert receipt["authorization"] == {
        "required": True,
        "id": approval["id"],
        "state": "approve",
        "decided_at": first.json()["decided_at"],
    }
    assert "App 没有版本历史或一键恢复入口" in receipt["backup_restore"]


@pytest.mark.parametrize("decision", ["deny", "approve"])
async def test_denial_or_changed_target_never_overwrites_new_content(setup, decision):
    settings, store, run, target = setup
    model = ScriptedModel(replies=[write_call(target), AIMessage(content="保留现有文件")])
    with pytest.raises(RunPaused):
        await invoke(settings, run, model)
    store.pause_run(run["id"])
    approval = Journal(settings).approvals()["items"][0]
    Journal(settings).decide(approval["id"], decision)
    target.write_text("newer content")
    result = await invoke(settings, store.claim_next("task"), model)
    assert result == "保留现有文件"
    assert target.read_text() == "newer content"
    assert Journal(settings).receipts(run["id"])["items"][0]["state"] in {"denied", "failed"}


@pytest.mark.parametrize("boundary", ["after_write", "after_receipt"])
async def test_crash_reconciles_actual_file_without_repeating_write(setup, monkeypatch, boundary):
    settings, store, run, _ = setup
    target = Path(run["workspace_path"]) / "result.txt"
    count = 0
    original_write = FileAccess.write_bytes
    original_state = Journal.set_state

    def write_then_crash(self, *args, **kwargs):
        nonlocal count
        count += 1
        result = original_write(self, *args, **kwargs)
        if boundary == "after_write":
            raise Crash()
        return result

    def receipt_then_crash(self, identifier, state, result=None):
        original_state(self, identifier, state, result)
        if boundary == "after_receipt" and state == "succeeded":
            raise Crash()

    monkeypatch.setattr(FileAccess, "write_bytes", write_then_crash)
    monkeypatch.setattr(Journal, "set_state", receipt_then_crash)
    with pytest.raises(Crash):
        await invoke(
            settings, run, ScriptedModel(replies=[write_call("result.txt", overwrite=False)])
        )
    assert target.read_text() == "updated" and count == 1
    modified = target.stat().st_mtime_ns
    monkeypatch.setattr(FileAccess, "write_bytes", original_write)
    monkeypatch.setattr(Journal, "set_state", original_state)
    reopened = Store(settings)
    reopened.recover_interrupted()
    resumed = reopened.claim_next("task")
    assert resumed["id"] == run["id"] and resumed["phase"] == "recovering"
    model = ScriptedModel(replies=[AIMessage(content="继续交付")])
    assert await invoke(settings, resumed, model) == "继续交付"
    assert target.stat().st_mtime_ns == modified
    receipts = Journal(settings).receipts(run["id"])["items"]
    assert len(receipts) == 1 and receipts[0]["state"] == "succeeded"
    receipt = next(
        json.loads(message.content)
        for message in model.seen[-1]
        if isinstance(message, ToolMessage) and message.tool_call_id == "write"
    )
    assert receipt["authorization"] == {"required": False}


async def test_schedule_commit_is_reconciled_from_real_service_record(setup, monkeypatch):
    settings, store, run, _ = setup
    call = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "schedule_task",
                "args": {"prompt": "稍后检查", "next_run_at": "2099-01-01T10:00:00+08:00"},
                "id": "schedule",
                "type": "tool_call",
            }
        ],
    )
    original = Store.create_schedule

    def created_then_crash(self, **kwargs):
        original(self, **kwargs)
        raise Crash()

    monkeypatch.setattr(Store, "create_schedule", created_then_crash)
    with pytest.raises(Crash):
        await invoke(settings, run, ScriptedModel(replies=[call]))
    monkeypatch.setattr(Store, "create_schedule", original)
    assert len(store.list_schedules()["items"]) == 1
    store.recover_interrupted()
    resumed = store.claim_next("task")
    model = ScriptedModel(replies=[AIMessage(content="核对现有计划后继续")])
    await invoke(settings, resumed, model)
    assert Journal(settings).approvals()["items"] == []
    assert len(store.list_schedules()["items"]) == 1
    assert store.list_schedules()["items"][0]["id"] in str(model.seen[0])


async def test_steer_after_crash_preserves_real_effect_and_new_instruction(setup, monkeypatch):
    settings, store, run, _ = setup
    original = FileAccess.write_bytes

    def written_then_crash(self, *args, **kwargs):
        original(self, *args, **kwargs)
        raise Crash()

    monkeypatch.setattr(FileAccess, "write_bytes", written_then_crash)
    with pytest.raises(Crash):
        await invoke(
            settings, run, ScriptedModel(replies=[write_call("result.txt", overwrite=False)])
        )
    target = Path(run["workspace_path"]) / "result.txt"
    modified = target.stat().st_mtime_ns
    store.submit_message(
        run["conversation_id"],
        id="steer",
        content="保留已生成文件，先总结",
        intent="steer",
        target_run_id=run["id"],
    )
    monkeypatch.setattr(FileAccess, "write_bytes", original)
    store.recover_interrupted()
    model = ScriptedModel(replies=[AIMessage(content="按新要求总结")])

    async def controls():
        return store.get_controls(run["id"])

    async def acknowledge(ids):
        store.acknowledge_steers(run["id"], ids)

    await run_agent(
        settings,
        store.claim_next("task"),
        persona="",
        emit=ignore,
        controls=controls,
        acknowledge=acknowledge,
        model_override=model,
    )
    assert target.stat().st_mtime_ns == modified
    assert "保留已生成文件，先总结" in str(model.seen[0])
    assert "reconciled" in str(model.seen[0])
    assert not store.get_controls(run["id"])["steers"]
    assert Journal(settings).receipts(run["id"])["items"][0]["state"] == "succeeded"


async def test_completed_receipt_does_not_replace_a_later_file_version(setup, monkeypatch):
    settings, store, run, _ = setup
    original = Journal.set_state

    def saved_then_crash(self, identifier, state, result=None):
        original(self, identifier, state, result)
        if state == "succeeded":
            raise Crash()

    monkeypatch.setattr(Journal, "set_state", saved_then_crash)
    with pytest.raises(Crash):
        await invoke(
            settings, run, ScriptedModel(replies=[write_call("result.txt", overwrite=False)])
        )
    monkeypatch.setattr(Journal, "set_state", original)
    target = Path(run["workspace_path"]) / "result.txt"
    target.write_text("changed after completion")
    store.recover_interrupted()
    model = ScriptedModel(replies=[AIMessage(content="检查新版本")])
    await invoke(settings, store.claim_next("task"), model)
    assert target.read_text() == "changed after completion"
    assert "文件现在已变化或缺失" in str(model.seen[0])


async def test_multiple_pending_decisions_and_denial_survive_restart(setup):
    settings, store, run, target = setup
    second = target.parent / "second.txt"
    second.write_text("second original")
    calls = write_call(target).tool_calls + write_call(second, identifier="second").tool_calls
    model = ScriptedModel(
        replies=[
            AIMessage(content="", tool_calls=calls),
            write_call(second, identifier="repeat"),
            AIMessage(content="仅替换了获准文件"),
        ]
    )
    with pytest.raises(RunPaused):
        await invoke(settings, run, model)
    store.pause_run(run["id"])
    journal = Journal(settings)
    pending = journal.approvals()["items"]
    assert len(pending) == 2
    first = next(item for item in pending if item["details"]["path"] == str(target))
    other = next(item for item in pending if item["id"] != first["id"])
    journal.decide(first["id"], "approve")
    assert Store(settings).claim_next("task") is None
    journal.decide(other["id"], "deny")
    assert await invoke(settings, store.claim_next("task"), model) == "仅替换了获准文件"
    assert target.read_text() == "updated" and second.read_text() == "second original"
    assert journal.approvals()["items"] == []


async def test_explicit_persistent_overwrite_grant_needs_no_prompt(setup):
    settings, store, run, target = setup
    settings.grants[0].overwrite = "allow"
    model = ScriptedModel(replies=[write_call(target), AIMessage(content="按已有授权完成")])
    await invoke(settings, run, model)
    assert target.read_text() == "updated" and Journal(settings).approvals()["items"] == []


async def test_delegated_agent_resumes_its_pending_file_decision(setup):
    settings, store, run, target = setup
    agent = {
        "id": "writer",
        "name": "文件助手",
        "description": "编辑资料",
        "instructions": "按要求编辑",
        "tools": ["write_text_file"],
    }
    run["agents"] = [agent]
    model = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "task",
                        "args": {"description": "更新资料", "subagent_type": "agent_writer"},
                        "id": "delegate",
                        "type": "tool_call",
                    }
                ],
            ),
            write_call(target),
            AIMessage(content="文件已更新"),
            AIMessage(content="委托完成"),
        ]
    )
    with pytest.raises(RunPaused):
        await invoke(settings, run, model)
    store.pause_run(run["id"])
    assert target.read_text() == "original"
    journal = Journal(settings)
    journal.decide(journal.approvals()["items"][0]["id"], "approve")
    resumed = store.claim_next("task")
    resumed["agents"] = [agent]
    assert await invoke(settings, resumed, model) == "委托完成"
    assert target.read_text() == "updated" and len(model.seen) == 4


def test_recovery_budget_and_manual_resume_reject_advanced_context(setup):
    _, store, run, _ = setup
    store.enable_recovery(run["id"])
    for expected in range(1, 4):
        store.recover_interrupted()
        assert store.claim_next("task")["recovery_count"] == expected
    store.submit_message(
        run["conversation_id"],
        id="pending-steer",
        content="保留原件",
        intent="steer",
        target_run_id=run["id"],
    )
    store.recover_interrupted()
    assert store.get_run(run["id"])["status"] == "interrupted"
    assert store.claim_next("task") is None
    resumed = store.resume_run(run["id"])
    assert resumed["phase"] == "recovering" and resumed["recovery_count"] == 0
    assert store.get_controls(run["id"])["steers"][0]["id"] == "pending-steer"
    assert store.resume_run(run["id"]) == resumed
    store.claim_next("task")
    store.finish_run(run["id"], "interrupted")
    store.resume_conversation(run["conversation_id"])
    store.submit_message(run["conversation_id"], id="new-context", content="新的要求", kind="task")
    assert store.claim_next("task")["id"] != run["id"]
    with pytest.raises(StoreError, match="该会话已执行后续任务"):
        store.resume_run(run["id"])


async def test_recovery_detects_changed_permissions_and_does_not_execute(setup):
    settings, store, run, target = setup
    with pytest.raises(RunPaused):
        await invoke(settings, run, ScriptedModel(replies=[write_call(target)]))
    store.pause_run(run["id"])
    Journal(settings).decide(Journal(settings).approvals()["items"][0]["id"], "approve")
    settings.grants = []
    with pytest.raises(ValueError, match="配置发生变化"):
        await invoke(settings, store.claim_next("task"), ScriptedModel(replies=[]))
    assert target.read_text() == "original"


async def test_final_checkpoint_is_delivered_without_reinvoking_model(setup):
    settings, store, run, _ = setup
    assert (
        await invoke(settings, run, ScriptedModel(replies=[AIMessage(content="已经完成")]))
        == "已经完成"
    )
    # Worker dies between the final durable checkpoint and app.sqlite completion.
    store.recover_interrupted()
    model = ScriptedModel(replies=[])
    result = await invoke(settings, store.claim_next("task"), model)
    store.finish_run(run["id"], "completed", result=result)
    assert model.seen == []
    assert [
        m["content"]
        for m in store.list_messages(run["conversation_id"])["items"]
        if m["role"] == "assistant"
    ] == ["已经完成"]


async def test_cancel_pending_approval_revokes_it_and_preserves_queue(setup):
    settings, store, run, target = setup
    with pytest.raises(RunPaused):
        await invoke(settings, run, ScriptedModel(replies=[write_call(target)]))
    store.pause_run(run["id"])
    approval = Journal(settings).approvals()["items"][0]
    store.submit_message(run["conversation_id"], id="later", content="随后再说")
    store.cancel_run(run["id"])
    with pytest.raises(StoreError):
        Journal(settings).decide(approval["id"], "approve")
    assert target.read_text() == "original" and store.get_run(run["id"])["status"] == "cancelled"
    assert store.get_conversation(run["conversation_id"])["blocked"]
    assert store.claim_next("chat") is None
    assert any(
        item["message_id"] == "later" and item["status"] == "queued"
        for item in store.list_runs()["items"]
    )
