import sqlite3

import httpx
import pytest
from langgraph.errors import GraphRecursionError
from test_finance_write_stream import budget, tool
from test_live_stream import StreamingModel, chunk

from zhixing_next.api import create_app
from zhixing_next.config import ModelConfig, PathGrant, Settings
from zhixing_next.finance_service import FinanceService
from zhixing_next.operations import Journal, OperationRunner
from zhixing_next.recovery import has_run_checkpoint
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store
from zhixing_next.worker import Worker


def fixture(tmp_path, *, finance=True):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work", api_token="synthetic-resume-test-token", models={"chat": ModelConfig(protocol="chat_completions", model="resume-test", api_key="synthetic-provider-key")})
    store = Store(settings)
    conversation = store.create_conversation("原消息恢复", agent_id="finance" if finance else None)["id"]
    store.submit_message(conversation, id="original-input", content="2026年10月预算目标改9000，并生成账本报告。")
    return settings, store, store.claim_next("chat")


async def api_resume(settings, run):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(settings)), base_url="http://test", headers={"Authorization": "Bearer " + settings.api_token}) as client:
        return await client.post(f"/v1/runs/{run['id']}/resume")


async def fail_after_budget(settings, store, run, *, recursion=False):
    plans = [[tool("update_finance_budget", budget(savings_target="9000"), "budget")]]
    plans += [[tool("calculate", {"expression": f"{index}+1"}, f"calculation-{index}")] for index in range(80)] if recursion else [[ValueError("synthetic failure after save")]]
    model = StreamingModel(plans=plans)

    async def runner(settings, run, **callbacks):
        return await run_agent(settings, run, **callbacks, model_override=model)

    await Worker(settings, runner)._execute(run)
    failed = store.get_run(run["id"])
    assert failed["status"] == "failed" and failed["recovery_enabled"]
    assert has_run_checkpoint(settings, failed)
    assert FinanceService(store).get_budget("2026-10")["savings_target"] == "9000.00"
    return model


@pytest.mark.parametrize("legacy_cleanup", [False, True])
async def test_api_retries_same_failed_graph_after_real_recursion_without_duplicate_finance_write(tmp_path, legacy_cleanup):
    settings, store, run = fixture(tmp_path)
    model = await fail_after_budget(settings, store, run, recursion=True)
    assert model.calls > 2
    assert store.get_run(run["id"])["error"] == "这次回复未完成，已保存的记录会保留，可以重试继续。"
    if legacy_cleanup:
        # Reproduce the old terminal cleanup, not a run/state bypass.
        with store._connection(write=True) as db:
            for table in ("run_model_configs", "agent_model_configs", "run_agent_assignments"):
                db.execute(f"DELETE FROM {table} WHERE run_id=?", (run["id"],))
    resumed = await api_resume(settings, run)
    assert resumed.status_code == 200 and resumed.json()["id"] == run["id"]
    assert resumed.json()["message_id"] == run["message_id"] and resumed.json()["phase"] == "recovering"
    assert (await api_resume(settings, run)).json() == resumed.json()
    claimed = store.claim_next("chat")
    assert claimed["id"] == run["id"]
    assert store.settings_for_run(claimed).models["chat"].model == "resume-test"
    continuation = StreamingModel(plans=[[tool("publish_finance_report", {"start_date": "2026-10-01", "end_date": "2026-10-31", "filename": "resumed.md"}, "report")]])

    async def runner(settings, run, **callbacks):
        return await run_agent(settings, run, **callbacks, model_override=continuation)

    await Worker(settings, runner)._execute(claimed)
    completed = store.get_run(run["id"])
    assert completed["status"] == "completed" and continuation.calls == 1
    events = store.list_events(run["id"], limit=1000)["items"]
    artifact = next(item["data"] for item in events if item["type"] == "artifact")
    assert completed["result"] == artifact["finance"]["completion"]
    messages = [item for item in store.list_messages(run["conversation_id"])["items"] if item["role"] == "assistant"]
    assert len(messages) == 1 and messages[0]["content"] == completed["result"]
    assert messages[0]["attachments"][0]["id"] == artifact["resource"]["id"]
    assert len([item for item in Journal(settings).receipts(run["id"])["items"] if item["tool"] == "update_finance_budget"]) == 1
    with store._connection() as db:
        assert db.execute("SELECT COUNT(*) FROM finance_mutations").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM run_model_configs WHERE run_id=?", (run["id"],)).fetchone()[0] == 0
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(settings)), base_url="http://test", headers={"Authorization": "Bearer " + settings.api_token}) as client:
        report = await client.get(f"/v1/resources/{artifact['resource']['id']}/text")
    assert report.status_code == 200 and "财务回顾" in report.text


@pytest.mark.parametrize("reason", ["no_recovery", "no_checkpoint", "cancelled", "context_advanced"])
async def test_failed_resume_api_keeps_rejection_guards(tmp_path, reason):
    settings, store, run = fixture(tmp_path)
    if reason == "context_advanced":
        await fail_after_budget(settings, store, run)
        store.resume_conversation(run["conversation_id"])
        store.submit_message(run["conversation_id"], id="later-input", content="之后的新问题")
        later = store.claim_next("chat")
        store.finish_run(later["id"], "completed", result="后续已执行")
    else:
        if reason != "no_recovery":
            store.enable_recovery(run["id"])
        if reason == "cancelled":
            store.cancel_run(run["id"])
        store.finish_run(run["id"], "cancelled" if reason == "cancelled" else "failed", error="synthetic")
    response = await api_resume(settings, run)
    assert response.status_code == (409 if reason == "context_advanced" else 422)
    assert response.json()["error"]["code"] == ("context_advanced" if reason == "context_advanced" else "cannot_resume")
    assert store.get_run(run["id"])["status"] in {"failed", "cancelled"}


@pytest.mark.parametrize("change", ["permissions", "instructions"])
async def test_legacy_failed_resume_still_rejects_changed_runtime_before_any_new_effect(tmp_path, change):
    settings, store, run = fixture(tmp_path)
    await fail_after_budget(settings, store, run)
    with store._connection(write=True) as db:
        for table in ("run_model_configs", "agent_model_configs", "run_agent_assignments"):
            db.execute(f"DELETE FROM {table} WHERE run_id=?", (run["id"],))
    if change == "permissions":
        settings.grants = [PathGrant(path=tmp_path)]
    else:
        agent = store.get_agent("finance")
        store.update_agent("finance", **{key: agent[key] for key in ("name", "description", "tools", "visible")}, instructions=agent["instructions"] + " changed")
    assert (await api_resume(settings, run)).status_code == 200
    after = StreamingModel(plans=[[chunk("不得执行。")]])

    async def runner(settings, run, **callbacks):
        return await run_agent(settings, run, **callbacks, model_override=after)

    await Worker(settings, runner)._execute(store.claim_next("chat"))
    assert after.calls == 0 and store.get_run(run["id"])["status"] == "failed"
    assert "配置发生变化" in store.get_run(run["id"])["error"]
    with store._connection() as db:
        assert db.execute("SELECT COUNT(*) FROM finance_mutations").fetchone()[0] == 1


async def test_failed_resume_preserves_unknown_task_effect_review_instead_of_blind_replay(tmp_path, monkeypatch):
    settings, store, run = fixture(tmp_path, finance=False)
    first = StreamingModel(plans=[[tool("task", {"description": "核对预算", "subagent_type": "finance"}, "unknown-task")]])

    async def lost_receipt(self, call, handler):
        operation = self.journal.prepare(self.run["id"], call, {"kind": "tool", "description": call["name"], "arguments": call["args"]})
        self.journal.set_state(operation["id"], "started")
        raise GraphRecursionError("synthetic unknown outcome")

    async def initial(settings, run, **callbacks):
        return await run_agent(settings, run, **callbacks, model_override=first)

    with monkeypatch.context() as patch:
        patch.setattr(OperationRunner, "invoke", lost_receipt)
        await Worker(settings, initial)._execute(run)
    assert (await api_resume(settings, run)).status_code == 200
    after = StreamingModel(plans=[])

    async def continuation(settings, run, **callbacks):
        return await run_agent(settings, run, **callbacks, model_override=after)

    await Worker(settings, continuation)._execute(store.claim_next("chat"))
    pending = store.get_run(run["id"])
    assert pending["status"] == "queued" and pending["phase"] == "approval" and after.calls == 0
    assert Journal(settings).approvals(run_id=run["id"])["items"][0]["kind"] == "uncertain"
    assert FinanceService(store).get_budget("2026-10")["savings_target"] is None


@pytest.mark.parametrize("kind,payload", [("json", b"[]"), ("json", b'{"channel_values":[]}'), ("msgpack", b"\xc1")])
async def test_corrupt_checkpoint_fails_closed_without_preventing_failed_status(tmp_path, kind, payload):
    settings, store, run = fixture(tmp_path)

    async def emit(kind, data):
        store.add_event(run["id"], kind, data)

    async def controls():
        return store.get_controls(run["id"])

    async def acknowledge(ids):
        store.acknowledge_steers(run["id"], ids)

    run["agent"] = store.get_agent("finance")
    await run_agent(settings, run, persona="", emit=emit, controls=controls, acknowledge=acknowledge, model_override=StreamingModel(plans=[[chunk("核对完成。")]]))
    assert has_run_checkpoint(settings, run)
    with sqlite3.connect(settings.data_dir / "checkpoints.sqlite") as db:
        db.execute("UPDATE checkpoints SET type=?,checkpoint=? WHERE thread_id=? AND checkpoint_ns=''", (kind, payload, run["conversation_id"]))
    store.finish_run(run["id"], "failed", error="bounded failure")
    assert store.get_run(run["id"])["status"] == "failed" and not has_run_checkpoint(settings, run)
    response = await api_resume(settings, run)
    assert response.status_code == 422 and response.json()["error"]["code"] == "cannot_resume"
