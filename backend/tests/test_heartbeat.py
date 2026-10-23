import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel

from zhixing_next.config import Settings
from zhixing_next.growth import GrowthService
from zhixing_next.heartbeat import HeartbeatService, run_heartbeat
from zhixing_next.store import Store, timestamp
from zhixing_next.worker import Worker

NOW = datetime(2030, 1, 1, 4, tzinfo=UTC)


@pytest.fixture
def setup(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work", poll_interval=0.1)
    store = Store(settings)
    chat = store.create_conversation("日常")
    memory = store.add_memory("用户喜欢简洁表达，也喜欢茶")
    return settings, store, chat, memory, GrowthService(store), HeartbeatService(store)


def enable(growth, chat, **changes):
    return growth.patch_preferences({"enabled": True, "topics": {"茶": "allow"},
                                     "quiet_start": None, "quiet_end": None,
                                     "min_interval_minutes": 15, **changes}, chat["id"])


def answer(content="下午泡杯茶时，可以顺便让眼睛休息一下。", topic="茶", goals=(), **maintenance):
    return {"maintenance": maintenance, "message": {"topic": topic, "content": content, "goal_ids": list(goals)},
            "checked_goal_ids": list(goals)}


def goal(growth, chat, *, id="goal", interval=None, due=NOW, topic="阅读"):
    return growth.save_goal({"title": "提醒我阅读", "topic": topic, "next_check_at": timestamp(due),
                             "interval_seconds": interval}, id=id, conversation_id=chat["id"])


def test_default_maintenance_is_silent_and_unchanged_context_is_not_reprocessed(setup):
    _, store, chat, memory, growth, service = setup
    assert not growth.read_state()["preferences"]["enabled"]
    snapshot = service.claim(NOW)
    assert snapshot and not snapshot["delivery_allowed"]
    result = service.finish(snapshot, answer(understanding=[{
        "key": "表达", "content": "用户喜欢简洁表达", "memory_refs": [memory["id"]],
    }]), NOW)
    assert result["status"] == "silent"
    assert store.list_messages(chat["id"])["items"] == []
    assert growth.read_state()["understanding"][0]["content"] == "用户喜欢简洁表达"
    assert service.claim(NOW + timedelta(hours=1)) is None


def test_atomic_claim_delivery_restart_and_memory_exposure(setup):
    settings, store, chat, memory, growth, service = setup
    enable(growth, chat)
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(lambda _: service.claim(NOW), range(8)))
    snapshot = next(item for item in claims if item)
    assert sum(item is not None for item in claims) == 1
    delivered = service.finish(snapshot, answer(), NOW)
    assert delivered["status"] == "delivered"
    assert service.finish(snapshot, answer(), NOW)["status"] == "superseded"
    reopened = HeartbeatService(Store(settings))
    reopened.recover(NOW)
    assert reopened.claim(NOW + timedelta(hours=1)) is None
    messages = store.list_messages(chat["id"])["items"]
    assert len(messages) == 1 and messages[0]["role"] == "assistant"
    assert messages[0]["run_id"] is None
    assert store.list_runs()["items"] == []
    assert reopened.recent_messages(chat["id"])[0]["memory_versions"] == {memory["id"]: memory["updated_at"]}
    revision = store.memory_reset_revision(chat["id"])
    store.delete_memory(memory["id"])
    assert reopened.recent_messages(chat["id"]) == []
    assert store.memory_reset_revision(chat["id"]) > revision


@pytest.mark.parametrize("change", ["forget", "correct", "preferences", "goal"])
def test_stale_inflight_decision_cannot_write_or_send(setup, change):
    _, store, chat, memory, growth, service = setup
    enable(growth, chat)
    goal(growth, chat)
    snapshot = service.claim(NOW)
    if change == "forget":
        store.delete_memory(memory["id"])
    elif change == "correct":
        store.update_memory(memory["id"], "用户不喜欢茶")
    elif change == "preferences":
        growth.patch_preferences({"enabled": False})
    else:
        growth.save_goal({"status": "cancelled"}, id="goal")
    result = service.finish(snapshot, answer(understanding=[{
        "key": "茶", "content": "用户喜欢茶", "memory_refs": [memory["id"]],
    }]), NOW)
    assert result["status"] == "stale"
    assert not store.list_messages(chat["id"])["items"]
    assert not growth.read_state()["understanding"]


def test_quiet_hours_preserve_due_goal_and_coalesce_only_on_delivery(setup):
    _, store, chat, _, growth, service = setup
    enable(growth, chat, quiet_start="22:00", quiet_end="08:00")
    quiet = NOW.replace(hour=15)  # 23:00 Shanghai, across midnight.
    goal(growth, chat, interval=3600, due=quiet - timedelta(hours=4))
    snapshot = service.claim(quiet)
    assert not snapshot["delivery_allowed"]
    service.finish(snapshot, answer(topic="阅读", goals=["goal"]), quiet)
    before = growth.read_state()["goals"][0]["next_check_at"]
    morning = quiet + timedelta(hours=10)
    snapshot = service.claim(morning)
    result = service.finish(snapshot, answer(topic="阅读", goals=["goal"]), morning)
    assert result["status"] == "delivered"
    saved = growth.read_state()["goals"][0]
    assert saved["next_check_at"] != before
    assert datetime.fromisoformat(saved["next_check_at"]) > morning
    assert saved["status"] == "active"
    assert len(store.list_messages(chat["id"])["items"]) == 1


def test_silent_check_does_not_consume_one_shot_and_goals_route_to_their_conversation(setup):
    _, store, chat, _, growth, service = setup
    other = store.create_conversation("第二个对话")
    enable(growth, chat)
    goal(growth, chat, id="first", due=NOW - timedelta(minutes=1))
    goal(growth, other, id="second")
    snapshot = service.claim(NOW)
    assert [item["id"] for item in snapshot["due_goals"]] == ["first"]
    service.finish(snapshot, {"maintenance": {}, "message": None, "checked_goal_ids": ["first", "second"]}, NOW)
    assert all(item["next_check_at"] for item in growth.read_state()["goals"])
    later = NOW + timedelta(minutes=16)
    snapshot = service.claim(later)
    assert snapshot["target_conversation_id"] == other["id"]  # Silent first goal cannot starve other chats.
    service.finish(snapshot, answer(topic="阅读", goals=["first", "second"]), later)
    goals = {item["id"]: item for item in growth.read_state()["goals"]}
    assert goals["second"]["next_check_at"] is None
    assert goals["first"]["next_check_at"] is not None
    assert not store.list_messages(chat["id"])["items"]
    later += timedelta(minutes=16)
    snapshot = service.claim(later)
    assert snapshot["target_conversation_id"] == chat["id"]
    service.finish(snapshot, answer(topic="阅读", goals=["first"]), later)
    assert len(store.list_messages(other["id"])["items"]) == 1


def test_delivery_rechecks_actual_time_snooze_frequency_daily_limit_and_blocked_topics(setup):
    _, store, chat, _, growth, service = setup
    enable(growth, chat, daily_limit=1)
    snapshot = service.claim(NOW)
    service.finish(snapshot, answer(), NOW)
    store.add_memory("用户刚开始学围棋")
    assert not service.claim(NOW + timedelta(minutes=16))["delivery_allowed"]
    service.recover(NOW + timedelta(minutes=16))
    growth.patch_preferences({"daily_limit": 3, "snooze_until": timestamp(NOW + timedelta(days=1))})
    snapshot = service.claim(NOW + timedelta(minutes=17))
    assert not snapshot["delivery_allowed"]
    service.finish(snapshot, answer(content="不同的新消息"), NOW + timedelta(minutes=17))
    growth.patch_preferences({"snooze_until": None, "topics": {"茶": "block"}})
    goal(growth, chat, topic="茶")
    snapshot = service.claim(NOW + timedelta(hours=1))
    result = service.finish(snapshot, answer(goals=["goal"]), NOW + timedelta(hours=1))
    assert result["reason"] == "blocked_topic"
    assert growth.read_state()["goals"][0]["next_check_at"] is not None
    assert len(store.list_messages(chat["id"])["items"]) == 1


def test_model_failure_retries_are_bounded_and_restart_does_not_lose_claim(setup):
    settings, _, chat, _, growth, service = setup
    enable(growth, chat)
    snapshot = service.claim(NOW)
    restarted = HeartbeatService(Store(settings))
    restarted.recover(NOW)
    assert service.finish(snapshot, answer(), NOW)["status"] == "superseded"
    current = NOW
    for _ in range(3):
        snapshot = restarted.claim(current)
        assert snapshot is not None
        restarted.fail(snapshot, RuntimeError("private error text must not persist"), current)
        current += timedelta(hours=1)
    assert restarted.claim(current) is None
    assert restarted.status()["last_error"] == "RuntimeError"
    assert "private" not in json.dumps(restarted.status())
    growth.patch_preferences({"guidance": {"语气": "简短自然"}})
    assert restarted.claim(current + timedelta(hours=1)) is not None


async def test_real_model_adapter_path_is_bounded_and_writes_only_returned_receipt(setup):
    _, store, chat, memory, growth, service = setup
    enable(growth, chat)
    now = datetime.now(UTC) + timedelta(seconds=1)
    snapshot = service.claim(now)
    model = FakeListChatModel(responses=[json.dumps(answer(understanding=[{
        "key": "交流", "content": "用简洁表达交流", "memory_refs": [memory["id"]],
    }]), ensure_ascii=False)])
    result = await run_heartbeat(store.settings, store, snapshot, model_override=model)
    assert result["status"] == "delivered"
    assert growth.read_state()["understanding"][0]["key"] == "交流"
    assert store.list_messages(chat["id"])["items"][0]["id"] == result["message_id"]


async def test_worker_cancels_background_for_new_user_and_shutdown_releases_claim(setup, monkeypatch):
    import zhixing_next.heartbeat as heartbeat

    settings, store, chat, _, growth, service = setup
    enable(growth, chat)
    entered = asyncio.Event()

    async def reflection(_settings, _store, snapshot):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            HeartbeatService(_store).release(snapshot)
            raise

    async def runner(_settings, _run, **_callbacks):
        return "收到"

    monkeypatch.setattr(heartbeat, "run_heartbeat", reflection)
    worker = Worker(settings, runner)
    stop = asyncio.Event()
    task = asyncio.create_task(worker.run(stop))
    try:
        await asyncio.wait_for(entered.wait(), 3)
        run = store.submit_message(chat["id"], id=str(uuid4()), content="现在聊聊")["run"]
        async with asyncio.timeout(3):
            while store.get_run(run["id"])["status"] != "completed":
                await asyncio.sleep(0.01)
        assert service.status()["receipts"][0]["status"] == "interrupted"
        assert not store.get_conversation(chat["id"])["blocked"]
    finally:
        stop.set()
        await task
    assert not service.status()["running"]


def test_blocked_earliest_goal_cannot_starve_other_conversation_and_service_target_is_kept(setup):
    _, store, chat, _, growth, service = setup
    health = store.create_conversation("饮食", agent_id="health")
    enable(growth, chat, topics={"减肥": "block"})
    goal(growth, chat, id="blocked", topic="减肥", due=NOW - timedelta(hours=1))
    goal(growth, health, id="meal", topic="用餐")
    snapshot = service.claim(NOW)
    assert snapshot["target_conversation_id"] == health["id"]
    assert [item["id"] for item in snapshot["due_goals"]] == ["meal"]
    service.finish(snapshot, answer(content="到午餐时间了，今天想吃什么？", topic="用餐", goals=["meal"]), NOW)
    assert store.list_messages(chat["id"])["items"] == []
    assert len(store.list_messages(health["id"])["items"]) == 1
    assert {item["id"]: item for item in growth.read_state()["goals"]}["blocked"]["next_check_at"] is not None


def test_clock_can_enter_quiet_hours_between_generation_and_delivery(setup):
    _, store, chat, _, growth, service = setup
    enable(growth, chat, quiet_start="22:00", quiet_end="08:00")
    evening = NOW.replace(hour=13, minute=59)
    goal(growth, chat, due=evening)
    snapshot = service.claim(evening)
    assert snapshot["delivery_allowed"]
    result = service.finish(snapshot, answer(topic="阅读", goals=["goal"]), evening + timedelta(minutes=2))
    assert result["status"] == "silent" and result["reason"] == "quiet_hours"
    assert store.list_messages(chat["id"])["items"] == []
    assert growth.read_state()["goals"][0]["next_check_at"] is not None


def test_interval_goal_can_deliver_same_content_on_next_occurrence(setup):
    _, store, chat, _, growth, service = setup
    enable(growth, chat)
    goal(growth, chat, interval=3600)
    first = service.claim(NOW)
    assert service.finish(first, answer(topic="阅读", goals=["goal"]), NOW)["status"] == "delivered"
    later = NOW + timedelta(hours=1)
    second = service.claim(later)
    assert service.finish(second, answer(topic="阅读", goals=["goal"]), later)["status"] == "delivered"
    assert len(store.list_messages(chat["id"])["items"]) == 2


def test_message_insert_failure_rolls_back_maintenance_and_claim_is_recoverable(setup):
    _, store, chat, memory, growth, service = setup
    enable(growth, chat)
    snapshot = service.claim(NOW)
    with store._connection(write=True) as db:
        db.execute("CREATE TRIGGER block_heartbeat BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'test delivery failure'); END")
    with pytest.raises(Exception, match="test delivery failure"):
        service.finish(snapshot, answer(understanding=[{
            "key": "茶", "content": "用户喜欢茶", "memory_refs": [memory["id"]],
        }]), NOW)
    assert growth.read_state()["understanding"] == []
    assert service.status()["running"]
    with store._connection(write=True) as db:
        db.execute("DROP TRIGGER block_heartbeat")
    assert service.finish(snapshot, answer(), NOW)["status"] == "delivered"


@pytest.mark.parametrize("paused", ["blocked", "approval", "input", "agent_wait"])
def test_retained_paused_queue_does_not_starve_independent_due_goal(setup, paused):
    _, store, chat, _, growth, service = setup
    abandoned = store.create_conversation("暂停的旧对话")
    first = store.submit_message(abandoned["id"], id=str(uuid4()), content="旧要求")["run"]
    store.submit_message(abandoned["id"], id=str(uuid4()), content="旧排队消息")
    if paused == "blocked":
        store.claim_next("chat")
        store.finish_run(first["id"], "cancelled")
    else:
        with store._connection(write=True) as db:
            db.execute("UPDATE runs SET phase=? WHERE id=?", (paused, first["id"]))
    enable(growth, chat)
    goal(growth, chat)
    snapshot = service.claim(NOW)
    assert snapshot is not None
    assert service.finish(snapshot, answer(topic="阅读", goals=["goal"]), NOW)["status"] == "delivered"
    assert len(store.list_messages(chat["id"])["items"]) == 1


def test_bounded_reflection_prioritizes_new_facts_and_rejects_unseen_evidence(setup):
    _, store, _, old, _, service = setup
    for index in range(205):
        store.add_memory(f"用户偏好的阅读话题编号是 {index}")
    newest = store.add_memory("用户最近开始学习陶艺")
    snapshot = service.claim(NOW)
    assert len(snapshot["memories"]) == 200
    assert snapshot["memories"][0]["id"] == newest["id"]
    assert old["id"] not in {item["id"] for item in snapshot["memories"]}
    assert old["id"] in snapshot["memory_versions"]
    with pytest.raises(ValueError, match="not supplied"):
        service.finish(snapshot, {"maintenance": {"understanding": [{
            "key": "旧偏好", "content": "旧偏好推断", "memory_refs": [old["id"]],
        }]}, "message": None}, NOW)
