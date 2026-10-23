"""Real SQLite receipts, partial edits and forgotten-evidence isolation."""

import sqlite3

import pytest

from zhixing_next.config import Settings
from zhixing_next.growth import GrowthService
from zhixing_next.store import Store, StoreError


@pytest.fixture
def service(tmp_path):
    return GrowthService(Store(Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work")))


def test_v14_upgrade_preserves_user_persona_and_creates_conservative_defaults(service):
    service.store.set_assistant("小知", "说话温和")
    with service.store._connection(write=True) as db:
        for table in ("growth_receipts", "growth_goals", "growth_understanding", "growth_skills", "growth_state"):
            db.execute(f"DROP TABLE {table}")
        db.execute("PRAGMA user_version=14")
    reopened = Store(service.store.settings)
    state = GrowthService(reopened).read_state()
    assert reopened.get_assistant() == {"name": "小知", "persona": "说话温和"}
    assert state["evolved_persona"] == "" and state["goals"] == state["learned_skills"] == []
    assert state["preferences"]["enabled"] is False
    assert state["preferences"]["maintenance_enabled"] is True
    with sqlite3.connect(reopened.db_path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 15


def test_preferences_merge_delete_cas_and_replay_original_receipt(service):
    conversation = service.store.create_conversation("主动服务")["id"]
    first = service.patch_preferences({"enabled": True, "topics": {"health": "allow", "work": "block"},
                                       "guidance": {"tone": "温和简短"}, "expected_revision": 0},
                                      conversation_id=conversation, operation_key="prefs-1")
    service.patch_preferences({"topics": {"health": None}, "guidance": {"timing": "只在有变化时联系"}})
    restarted = GrowthService(Store(service.store.settings))
    assert restarted.patch_preferences({"enabled": True, "topics": {"health": "allow", "work": "block"},
                                         "guidance": {"tone": "温和简短"}, "expected_revision": 0},
                                        conversation_id=conversation, operation_key="prefs-1") == first
    current = restarted.read_state()["preferences"]
    assert current["topics"] == {"work": "block"}
    assert current["guidance"] == {"tone": "温和简短", "timing": "只在有变化时联系"}
    assert current["target_conversation_id"] == conversation
    with pytest.raises(StoreError) as conflict:
        service.patch_preferences({"enabled": False, "expected_revision": 0})
    assert conflict.value.code == "revision_conflict"
    assert restarted.read_state()["preferences"]["enabled"] is True
    with pytest.raises(StoreError) as reused:
        service.patch_preferences({"enabled": False}, operation_key="prefs-1")
    assert reused.value.code == "idempotency_conflict"


@pytest.mark.parametrize("changes", [
    {"enabled": True}, {"timezone": "Unknown/Nowhere"}, {"quiet_start": "25:00"},
    {"enabled": None}, {"topics": None}, {"daily_limit": 0},
    {"quiet_start": None}, {"snooze_until": "2026-10-23T12:00:00"},
])
def test_invalid_preferences_do_not_commit(service, changes):
    before = service.read_state()
    with pytest.raises(StoreError):
        service.patch_preferences(changes)
    assert service.read_state() == before


def test_persona_and_skill_are_durable_distinct_from_user_persona_and_stale_evidence_hidden(service):
    service.store.set_assistant("知行", "用户自选人格")
    memory = service.store.add_memory("用户偏好简短回答")
    refs = {memory["id"]: memory["updated_at"]}
    persona = service.update_persona("习惯先说最有用的结论", "用户交流偏好", memory_refs=refs,
                                     expected_revision=0, operation_key="persona-1")
    saved = service.save_skill("brief-answer", "先给结论，再解释关键证据", "已确认表达偏好", memory_refs=refs,
                               expected_revision=persona["revision"], operation_key="skill-1")
    assert GrowthService(Store(service.store.settings)).read_state()["learned_skills"][0] == saved
    assert service.store.get_assistant()["persona"] == "用户自选人格"
    service.store.delete_memory(memory["id"])
    state = service.read_state()
    assert state["evolved_persona"] == "" and state["learned_skills"] == []
    with pytest.raises(StoreError) as error:
        service.update_persona("旧偏好", "旧依据", memory_refs=refs)
    assert error.value.code == "stale_growth_evidence"


def test_maintenance_is_atomic_against_memories_and_manual_edits(service):
    memory = service.store.add_memory("阿岚是用户的伴侣，喜欢陶艺")
    snapshot = service.snapshot()
    changes = {"evolved_persona": "细心倾听", "persona_reason": "保持相关理解",
               "persona_memory_refs": [memory["id"]],
               "understanding": [{"key": "relationships", "content": "用户重视阿岚的陶艺兴趣", "memory_refs": [memory["id"]]}]}
    assert service.apply_maintenance(changes, snapshot["revision"], snapshot["memory_versions"])
    assert service.read_state()["understanding"][0]["content"] == "用户重视阿岚的陶艺兴趣"
    assert not service.apply_maintenance(changes, snapshot["revision"], snapshot["memory_versions"])
    latest = service.snapshot()
    service.store.update_memory(memory["id"], "阿岚是用户的前伴侣")
    assert not service.apply_maintenance(changes, latest["revision"], latest["memory_versions"])
    assert service.read_state()["understanding"] == []
    current = service.snapshot()
    invalid = {"evolved_persona": "这不应留下", "understanding": [{"key": "bad", "content": "没有依据的画像"}]}
    with pytest.raises(StoreError):
        service.apply_maintenance(invalid, current["revision"], current["memory_versions"])
    assert service.read_state() == current


def test_goal_partial_changes_preserve_schedule_and_stop_on_completion(service):
    conversation = service.store.create_conversation("目标")["id"]
    goal = service.save_goal({"title": "健身计划", "context": "从每周两次开始", "topic": "health",
                              "next_check_at": "2026-10-24T09:00:00+08:00", "interval_seconds": 86400},
                             id="fitness-goal", conversation_id=conversation, operation_key="goal-1")
    paused = service.save_goal({"status": "paused", "expected_revision": goal["revision"]}, id=goal["id"])
    assert paused["context"] == goal["context"] and paused["next_check_at"] == goal["next_check_at"]
    with pytest.raises(StoreError) as stale:
        service.save_goal({"status": "completed", "expected_revision": goal["revision"]}, id=goal["id"])
    assert stale.value.code == "revision_conflict"
    complete = service.save_goal({"status": "completed"}, id=goal["id"])
    assert complete["next_check_at"] is None and complete["status"] == "completed"
    assert service.save_goal({"title": "健身计划", "context": "从每周两次开始", "topic": "health",
                              "next_check_at": "2026-10-24T09:00:00+08:00", "interval_seconds": 86400},
                             id="fitness-goal", conversation_id=conversation, operation_key="goal-1") == goal
    assert service.read_state()["goals"][0]["status"] == "completed"


def test_skill_delete_replay_does_not_delete_later_user_recreation(service):
    service.save_skill("procedure", "先读取原文件", "可靠经验")
    deleted = service.delete_skill("procedure", operation_key="delete-1")
    service.save_skill("procedure", "先读取原文件，再修改", "更新经验")
    assert service.delete_skill("procedure", operation_key="delete-1") == deleted
    assert service.read_state()["learned_skills"][0]["content"] == "先读取原文件，再修改"


def test_completed_goal_history_does_not_exhaust_active_goal_capacity(tmp_path):
    store = Store(Settings(data_dir=tmp_path / 'data', workspace_root=tmp_path / 'work'))
    chat = store.create_conversation('目标历史')
    service = GrowthService(store)
    for index in range(100):
        service.save_goal({'title': f'已完成目标{index}', 'status': 'completed'},
                          id=f'done-{index}', conversation_id=chat['id'])
    saved = service.save_goal({'title': '新的阅读计划'}, id='new', conversation_id=chat['id'])
    assert saved['status'] == 'active'
