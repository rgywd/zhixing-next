"""Queued input actions preserve message identity and serialize with worker claims."""

import asyncio
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage
from test_runtime import ScriptedModel

from zhixing_next.api import create_app
from zhixing_next.config import ModelConfig, Settings
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store, StoreError


@pytest.fixture
def store(tmp_path):
    return Store(Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work",
                          api_token="isolated-queue-test-service-token"))


def enqueue(store, conversation, identifier, **kwargs):
    return store.submit_message(conversation, id=identifier, content=identifier, **kwargs)


def pair(store):
    conversation = store.create_conversation("队列测试")["id"]
    target = enqueue(store, conversation, "original")["run"]
    store.claim_next("chat")
    source = enqueue(store, conversation, "followup")["run"]
    return conversation, target, source


def raw_message(store, identifier):
    with sqlite3.connect(store.db_path) as db:
        db.row_factory = sqlite3.Row
        return dict(db.execute("SELECT * FROM messages WHERE id=?", (identifier,)).fetchone())


def test_withdraw_is_idempotent_and_does_not_change_active_or_prior_block(store):
    conversation, target, source = pair(store)
    later = enqueue(store, conversation, "later")["run"]
    first = store.withdraw_queued(source["id"])
    assert first == Store(store.settings).withdraw_queued(source["id"])
    assert first["message"]["status"] == "rejected"
    assert first["run"]["status"] == "cancelled"
    assert store.get_run(target["id"])["status"] == "running"
    assert not store.get_controls(target["id"])["cancel_requested"]
    assert not store.get_conversation(conversation)["blocked"]
    store.finish_run(target["id"], "failed", error="fixture failure")
    store.withdraw_queued(later["id"])
    assert store.get_conversation(conversation)["blocked"]


@pytest.mark.parametrize("change", ["task", "approval", "input", "recovering", "started", "assistant_task"])
def test_only_never_started_plain_user_chat_is_eligible(store, change):
    _, target, source = pair(store)
    with store._connection(write=True) as db:
        if change == "task":
            db.execute("UPDATE runs SET kind='task' WHERE id=?", (source["id"],))
        elif change in {"approval", "input", "recovering"}:
            db.execute("UPDATE runs SET phase=? WHERE id=?", (change, source["id"]))
        elif change == "started":
            db.execute("UPDATE runs SET started_at='2026-10-15' WHERE id=?", (source["id"],))
        else:
            message = raw_message(store, "followup")
            original = json.loads(message["request_json"])
            original["source_run_id"] = target["id"]
            db.execute("UPDATE messages SET request_json=? WHERE id='followup'", (json.dumps(original),))
    before = raw_message(store, "followup")
    for action in [lambda: store.withdraw_queued(source["id"]),
                   lambda: store.steer_queued(source["id"], target["id"])]:
        with pytest.raises(StoreError, match="no longer") as error:
            action()
        assert error.value.status == 409
        assert raw_message(store, "followup") == before
    assert store.get_run(target["id"])["status"] == "running"


def test_promotion_keeps_original_retry_and_does_not_requeue_or_cancel_target(store):
    conversation, target, source = pair(store)
    before = raw_message(store, "followup")
    result = store.steer_queued(source["id"], target["id"])
    after = raw_message(store, "followup")
    for key in ["id", "seq", "content", "attachments_json", "created_at", "request_json"]:
        assert before[key] == after[key]
    assert result["message"]["submitted_intent"] == "queue"
    assert result["message"]["intent"] == "steer"
    assert result["message"]["run_id"] == target["id"]
    assert result["source_run"]["status"] == "cancelled"
    assert not store.get_conversation(conversation)["blocked"]
    assert not store.get_controls(target["id"])["cancel_requested"]
    assert [m["id"] for m in store.get_controls(target["id"])["steers"]] == ["followup"]
    # Simulate a lost HTTP response and retry from a fresh Store process.
    assert Store(store.settings).steer_queued(source["id"], target["id"]) == result
    retried_original = enqueue(store, conversation, "followup")
    assert retried_original == {"message": result["message"], "run": result["run"]}
    with pytest.raises(StoreError):
        store.withdraw_queued(source["id"])
    assert not store.get_controls(target["id"])["cancel_requested"]
    store.acknowledge_steers(target["id"], ["followup"])
    store.finish_run(target["id"], "completed", result="done")
    terminal = store.steer_queued(source["id"], target["id"])
    assert terminal["message"]["status"] == "applied"
    assert terminal["run"]["status"] == "completed"
    assert store.claim_next("chat") is None
    with pytest.raises(StoreError):
        store.steer_queued(source["id"], "different-target")
    assert [e["type"] for e in store.list_events(target["id"])["items"]].count("queue_promoted") == 1


@pytest.mark.parametrize("state", ["completed", "cancel_requested", "other_conversation"])
def test_invalid_target_leaves_queued_message_and_configuration_untouched(store, state):
    _, target, source = pair(store)
    if state == "completed":
        store.finish_run(target["id"], "completed", result="done")
    elif state == "cancel_requested":
        store.cancel_run(target["id"])
    else:
        other = store.create_conversation("别的对话")["id"]
        target = enqueue(store, other, "other")["run"]
        store.claim_next("chat")
    before = raw_message(store, "followup")
    with pytest.raises(StoreError):
        store.steer_queued(source["id"], target["id"])
    assert raw_message(store, "followup") == before
    assert store.get_run(source["id"])["status"] == "queued"
    with sqlite3.connect(store.db_path) as db:
        assert db.execute("SELECT COUNT(*) FROM run_model_configs WHERE run_id=?", (source["id"],)).fetchone()[0] == 1


@pytest.mark.parametrize("target_images", [False, True])
def test_promotion_reuses_attachments_checks_target_snapshot_and_cleans_only_source(tmp_path, target_images):
    models = {"image": ModelConfig(protocol="chat_completions", model="fixture-image", image_input=True),
              "target": ModelConfig(protocol="chat_completions", model="fixture-target", image_input=target_images)}
    store = Store(Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work", models=models))
    conversation = store.create_conversation("图片")["id"]
    target = enqueue(store, conversation, "target", model_id="target")["run"]
    store.claim_next("chat")
    attachment = store.register_resource("fixture-image", conversation, path="image.png", name="image.png",
                                         mime_type="image/png", size=17, sha256="a" * 64)
    source = enqueue(store, conversation, "image-guidance", model_id="image", attachments=[attachment["id"]])["run"]
    before = raw_message(store, "image-guidance")
    if not target_images:
        with pytest.raises(StoreError) as error:
            store.steer_queued(source["id"], target["id"])
        assert error.value.code == "image_not_supported"
        assert raw_message(store, "image-guidance") == before
        assert store.get_run(source["id"])["status"] == "queued"
        return
    result = store.steer_queued(source["id"], target["id"])
    assert result["message"]["attachments"] == [attachment]
    assert store.run_attachments(target["id"]) == [attachment]
    assert raw_message(store, "image-guidance")["request_json"] == before["request_json"]
    with sqlite3.connect(store.db_path) as db:
        for table in ["run_model_configs", "run_agent_assignments", "agent_model_configs"]:
            assert db.execute(f"SELECT COUNT(*) FROM {table} WHERE run_id=?", (source["id"],)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM run_model_configs WHERE run_id=?", (target["id"],)).fetchone()[0] == 1


def test_withdraw_racing_worker_claim_never_cancels_a_claimed_run(store):
    conversation = store.create_conversation("抢占")["id"]
    source = enqueue(store, conversation, "source")["run"]
    start = Barrier(2)

    def claim():
        start.wait()
        return Store(store.settings).claim_next("chat")

    def withdraw():
        start.wait()
        try:
            return Store(store.settings).withdraw_queued(source["id"])
        except StoreError as error:
            assert error.status == 409
            return None

    with ThreadPoolExecutor(2) as pool:
        a, b = pool.submit(claim), pool.submit(withdraw)
        claimed, withdrawn = a.result(), b.result()
    final = store.get_run(source["id"])
    if claimed:
        assert withdrawn is None
        assert final["status"] == "running"
        assert not final["cancel_requested"]
    else:
        assert withdrawn["run"]["status"] == "cancelled"
    assert not store.get_conversation(conversation)["blocked"]


@pytest.mark.parametrize("claim_after_finish", [False, True])
def test_promotion_racing_target_finish_and_worker_claim_has_one_delivery(store, claim_after_finish):
    _, target, source = pair(store)
    start = Barrier(2)

    def finish():
        start.wait()
        process = Store(store.settings)
        process.finish_run(target["id"], "completed", result="done")
        return process.claim_next("chat") if claim_after_finish else None

    def promote():
        start.wait()
        try:
            return Store(store.settings).steer_queued(source["id"], target["id"])
        except StoreError as error:
            assert error.status == 409
            return None

    with ThreadPoolExecutor(2) as pool:
        a, b = pool.submit(finish), pool.submit(promote)
        claimed, promoted = a.result(), b.result()
    message = raw_message(store, "followup")
    if promoted:
        assert claimed is None
        assert message["run_id"] == target["id"]
        assert message["status"] == "rejected"  # Completed before this guidance was consumed.
        assert store.get_run(source["id"])["status"] == "cancelled"
    else:
        assert message["run_id"] == source["id"] and message["intent"] == "queue"
        assert store.get_run(source["id"])["status"] == ("running" if claimed else "queued")
    assert not store.get_controls(target["id"])["steers"]
    assert not store.get_run(target["id"])["cancel_requested"]


async def test_real_graph_applies_promoted_message_once_and_acknowledges_checkpoint(store):
    conversation, target, source = pair(store)
    target = {**target, "workspace_path": str(store.workspace_for(conversation))}
    entered, release = asyncio.Event(), asyncio.Event()
    model = ScriptedModel(replies=[AIMessage(content="outdated"), AIMessage(content="incorporated")],
                          entered=entered, release=release)

    async def emit(kind, data):
        store.add_event(target["id"], kind, data)

    async def controls():
        return store.get_controls(target["id"])

    async def acknowledge(ids):
        store.acknowledge_steers(target["id"], ids)

    task = asyncio.create_task(run_agent(store.settings, target, persona="test", emit=emit,
                                        controls=controls, acknowledge=acknowledge, model_override=model))
    await asyncio.wait_for(entered.wait(), 5)
    store.steer_queued(source["id"], target["id"])
    store.steer_queued(source["id"], target["id"])
    release.set()
    assert await asyncio.wait_for(task, 10) == "incorporated"
    assert len(model.seen) == 2
    assert sum(isinstance(m, HumanMessage) and m.id == "followup" for m in model.seen[-1]) == 1
    assert not store.get_controls(target["id"])["steers"]
    store.acknowledge_steers(target["id"], ["followup"])
    events = store.list_events(target["id"])["items"]
    assert [e["data"] for e in events if e["type"] == "steer_applied"] == [{"message_ids": ["followup"]}]
    store.finish_run(target["id"], "completed", result="incorporated")
    assert store.claim_next("chat") is None
    assert len([m for m in store.list_messages(conversation)["items"] if m["role"] == "assistant"]) == 1


def test_authenticated_api_routes_preserve_retry_receipts_and_validate_body(store):
    _, target, source = pair(store)
    app = create_app(store.settings)
    with TestClient(app) as client:
        path = f"/v1/runs/{source['id']}/queued/steer"
        assert client.post(path, json={"target_run_id": target["id"]}).status_code == 401
        client.headers["Authorization"] = "Bearer " + store.settings.api_token
        assert client.post(path, json={"target_run_id": target["id"], "content": "changed"}).status_code == 422
        result = client.post(path, json={"target_run_id": target["id"]})
        assert result.status_code == 200
        assert client.post(path, json={"target_run_id": target["id"]}).json() == result.json()
        assert client.post(f"/v1/runs/{source['id']}/queued/withdraw").status_code == 409
        later = enqueue(store, target["conversation_id"], "later")["run"]
        response = client.post(f"/v1/runs/{later['id']}/queued/withdraw")
        assert response.status_code == 200
        assert response.json()["run"]["status"] == "cancelled"
