import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest

from zhixing_next.config import Settings
from zhixing_next.sqlite_policy import safe_journal_mode
from zhixing_next.store import _SCHEMA, Store, StoreError


@pytest.fixture
def store(tmp_path):
    return Store(Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work"))


def _remove_v12_schema(db):
    # Historical upgrade fixtures must actually represent their old schemas.
    tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    for table in tables:
        if table.startswith(("health_", "life_")) or (
            table.startswith("finance_") and table != "finance_observations"
        ):
            db.execute(f'DROP TABLE "{table}"')
    db.execute("DELETE FROM agents WHERE id='health'")


def enqueue(store, conversation, identifier, kind="task"):
    return store.submit_message(conversation, id=identifier, content=identifier, kind=kind)["run"]


def test_schema_and_persona_survive_reopen(store):
    store.set_assistant("知行", "记得先核实出处")
    reopened = Store(store.settings)
    assert reopened.get_assistant()["persona"] == "记得先核实出处"
    with sqlite3.connect(store.db_path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 13
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == safe_journal_mode().lower()


def test_existing_v1_database_gains_agents_without_losing_conversations(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work")
    settings.data_dir.mkdir()
    with sqlite3.connect(settings.data_dir / "app.sqlite") as db:
        for statement in _SCHEMA:
            db.execute(statement)
        db.execute(
            "INSERT INTO conversations(id,title,workspace_path,created_at,updated_at) VALUES('old','旧对话','/tmp/old','2026-09-01','2026-09-01')"
        )
        db.execute("PRAGMA user_version=1")
    upgraded = Store(settings)
    assert upgraded.get_conversation("old")["agent_id"] is None
    assert upgraded.get_agent("finance")["kind"] == "service"
    assert Store(settings).get_agent("finance")["id"] == "finance"


def test_v2_finance_agent_customization_survives_tool_upgrade(store):
    with sqlite3.connect(store.db_path) as db:
        db.execute("DROP TABLE approvals")
        db.execute("DROP TABLE operations")
        db.execute("ALTER TABLE runs DROP COLUMN recovery_enabled")
        db.execute("ALTER TABLE runs DROP COLUMN recovery_count")
        db.execute("ALTER TABLE runs DROP COLUMN phase")
        db.execute("DROP TABLE resources")
        db.execute("ALTER TABLE messages DROP COLUMN attachments_json")
        db.execute("ALTER TABLE runs DROP COLUMN attachments_json")
        db.execute("DROP TABLE memory_exposures")
        db.execute("ALTER TABLE conversations DROP COLUMN memory_reset_revision")
        db.execute("DROP TABLE memories")
        db.execute("ALTER TABLE runs DROP COLUMN memory_processed")
        db.execute("DROP TABLE search_providers")
        db.execute("ALTER TABLE runs DROP COLUMN search_provider_id")
        db.execute("DROP TABLE model_roles")
        db.execute("ALTER TABLE runs DROP COLUMN reasoning_effort")
        db.execute("ALTER TABLE runs DROP COLUMN model_id")
        db.execute("ALTER TABLE conversations DROP COLUMN reasoning_effort")
        db.execute("ALTER TABLE conversations DROP COLUMN model_id")
        db.execute("DROP TABLE finance_observations")
        db.execute(
            "UPDATE agents SET instructions='用户自定要求',tools_json='[]' WHERE id='finance'"
        )
        _remove_v12_schema(db)
        db.execute("PRAGMA user_version=2")
    upgraded = Store(store.settings)
    finance = upgraded.get_agent("finance")
    assert finance["instructions"] == "用户自定要求"
    assert "record_finance_observation" in finance["tools"]
    assert upgraded.list_finance_observations() == {"balances": [], "recent": []}


def test_v4_upgrade_keeps_old_conversations_without_reprocessing_them(store):
    conversation = store.create_conversation("旧对话")["id"]
    run = enqueue(store, conversation, "old", kind="chat")
    store.claim_next("chat")
    store.finish_run(run["id"], "completed", result="旧回复")
    with sqlite3.connect(store.db_path) as db:
        db.execute("DROP TABLE approvals")
        db.execute("DROP TABLE operations")
        db.execute("ALTER TABLE runs DROP COLUMN recovery_enabled")
        db.execute("ALTER TABLE runs DROP COLUMN recovery_count")
        db.execute("ALTER TABLE runs DROP COLUMN phase")
        db.execute("DROP TABLE resources")
        db.execute("ALTER TABLE messages DROP COLUMN attachments_json")
        db.execute("ALTER TABLE runs DROP COLUMN attachments_json")
        db.execute("DROP TABLE memory_exposures")
        db.execute("ALTER TABLE conversations DROP COLUMN memory_reset_revision")
        db.execute("DROP TABLE memories")
        db.execute("ALTER TABLE runs DROP COLUMN memory_processed")
        db.execute("DROP TABLE search_providers")
        db.execute("ALTER TABLE runs DROP COLUMN search_provider_id")
        _remove_v12_schema(db)
        db.execute("PRAGMA user_version=4")
    upgraded = Store(store.settings)
    assert upgraded.get_run(run["id"])["memory_processed"] == 1
    assert upgraded.next_memory_run() is None
    assert upgraded.get_conversation(conversation)["title"] == "旧对话"


def test_v5_memory_database_gains_search_without_losing_memories(store):
    memory = store.add_memory("用户喜欢简洁回答")
    with sqlite3.connect(store.db_path) as db:
        db.execute("DROP TABLE approvals")
        db.execute("DROP TABLE operations")
        db.execute("ALTER TABLE runs DROP COLUMN recovery_enabled")
        db.execute("ALTER TABLE runs DROP COLUMN recovery_count")
        db.execute("ALTER TABLE runs DROP COLUMN phase")
        db.execute("DROP TABLE resources")
        db.execute("ALTER TABLE messages DROP COLUMN attachments_json")
        db.execute("ALTER TABLE runs DROP COLUMN attachments_json")
        db.execute("DROP TABLE memory_exposures")
        db.execute("ALTER TABLE conversations DROP COLUMN memory_reset_revision")
        db.execute("DROP TABLE search_providers")
        db.execute("ALTER TABLE runs DROP COLUMN search_provider_id")
        _remove_v12_schema(db)
        db.execute("PRAGMA user_version=5")
    upgraded = Store(store.settings)
    assert upgraded.list_memories()["items"][0]["id"] == memory["id"]
    assert upgraded.list_search_providers()["items"] == []
    with sqlite3.connect(store.db_path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 13


def test_v8_migration_preserves_legacy_crash_behavior_and_queue(store):
    conversation = store.create_conversation("升级前任务")["id"]
    run = enqueue(store, conversation, "first")
    store.claim_next("task")
    queued = enqueue(store, conversation, "later")
    with sqlite3.connect(store.db_path) as db:
        db.execute("DROP TABLE approvals")
        db.execute("DROP TABLE operations")
        db.execute("ALTER TABLE runs DROP COLUMN recovery_enabled")
        db.execute("ALTER TABLE runs DROP COLUMN recovery_count")
        db.execute("ALTER TABLE runs DROP COLUMN phase")
        _remove_v12_schema(db)
        db.execute("PRAGMA user_version=8")
    upgraded = Store(store.settings)
    upgraded.recover_interrupted()
    assert upgraded.get_run(run["id"])["status"] == "interrupted"
    assert not upgraded.get_run(run["id"])["recovery_enabled"]
    assert upgraded.get_run(queued["id"])["status"] == "queued"
    assert upgraded.claim_next("task") is None
    with pytest.raises(StoreError):
        upgraded.resume_run(run["id"])


def test_duplicate_messages_and_competing_claims_are_atomic(store):
    conversation = store.create_conversation("研究")["id"]
    with ThreadPoolExecutor(max_workers=6) as pool:
        receipts = list(pool.map(lambda _: enqueue(store, conversation, "same-id"), range(12)))
    assert len({run["id"] for run in receipts}) == 1
    with ThreadPoolExecutor(max_workers=6) as pool:
        claims = list(pool.map(lambda _: store.claim_next("task"), range(12)))
    assert sum(run is not None for run in claims) == 1
    with pytest.raises(StoreError, match="different content"):
        store.submit_message(conversation, id="same-id", content="changed", kind="task")
    assert len(store.list_runs()["items"]) == 1


def test_fifo_across_kinds_and_concurrent_conversations(store):
    first = store.create_conversation("长期项目")["id"]
    other = store.create_conversation("另一个话题")["id"]
    chat = enqueue(store, first, "first-chat", "chat")
    task = enqueue(store, first, "then-task")
    other_task = enqueue(store, other, "other-task")
    assert store.claim_next("task")["id"] == other_task["id"]
    assert store.claim_next("task") is None
    assert store.claim_next("chat")["id"] == chat["id"]
    assert store.claim_next("task") is None
    store.finish_run(chat["id"], "completed", result="继续研究")
    assert store.claim_next("task")["id"] == task["id"]


def test_steer_lifecycle_and_terminal_race(store):
    conversation = store.create_conversation("引导")["id"]
    run = enqueue(store, conversation, "initial")
    store.claim_next("task")
    payload = dict(
        id="steer-1", content="近三年", kind="task", intent="steer", target_run_id=run["id"]
    )
    accepted = store.submit_message(conversation, **payload)
    assert accepted["message"]["status"] == "accepted"
    store.acknowledge_steers(run["id"], ["steer-1"])
    store.acknowledge_steers(run["id"], ["steer-1"])
    assert store.submit_message(conversation, **payload)["message"]["status"] == "applied"
    pending = dict(payload, id="steer-2")
    store.submit_message(conversation, **pending)
    store.finish_run(run["id"], "completed", result="已完成")
    assert store.submit_message(conversation, **pending)["message"]["status"] == "rejected"
    with pytest.raises(StoreError) as exc:
        store.submit_message(conversation, **dict(payload, id="late"))
    assert exc.value.code == "stale_steer"
    events = store.list_events(run["id"])["items"]
    assert [event["type"] for event in events] == ["started", "steer_applied", "completed"]
    assert not store.get_controls(run["id"])["steers"]


@pytest.mark.parametrize("terminal", ["failed", "cancelled", "interrupted"])
def test_terminal_failures_block_but_preserve_queue(store, terminal):
    conversation = store.create_conversation("持久任务")["id"]
    first = enqueue(store, conversation, "first")
    second = enqueue(store, conversation, "second")
    store.claim_next("task")
    store.finish_run(first["id"], terminal, error="inspect result")
    reopened = Store(store.settings)
    assert reopened.claim_next("task") is None
    assert reopened.get_run(second["id"])["status"] == "queued"
    reopened.resume_conversation(conversation)
    assert reopened.claim_next("task")["id"] == second["id"]


def test_cancel_wins_if_committed_before_completion(store):
    conversation = store.create_conversation("取消")["id"]
    first = enqueue(store, conversation, "first")
    later = enqueue(store, conversation, "later")
    store.claim_next("task")
    requested = store.cancel_run(first["id"])
    assert requested["status"] == "running" and requested["cancel_requested"]
    store.finish_run(first["id"], "completed", result="tool already produced output")
    assert store.get_run(first["id"])["status"] == "cancelled"
    assert store.get_run(later["id"])["status"] == "queued"
    assert not [m for m in store.list_messages(conversation)["items"] if m["role"] == "assistant"]
    store.finish_run(first["id"], "completed", result="duplicate finish")
    assert len(store.list_events(first["id"])["items"]) == 2


def test_crash_recovery_preserves_progress_and_rejects_pending_steer(store):
    conversation = store.create_conversation("崩溃恢复")["id"]
    run = enqueue(store, conversation, "work")
    later = enqueue(store, conversation, "later")
    store.claim_next("task")
    store.add_event(run["id"], "tool", {"path": "report.txt", "status": "completed"})
    store.submit_message(
        conversation, id="pending", content="加对照", intent="steer", target_run_id=run["id"]
    )
    restarted = Store(store.settings)
    restarted.recover_interrupted()
    restarted.recover_interrupted()
    assert restarted.get_run(run["id"])["status"] == "interrupted"
    assert restarted.get_run(later["id"])["status"] == "queued"
    assert restarted.claim_next("task") is None
    events = restarted.list_events(run["id"])["items"]
    assert [e["type"] for e in events] == ["started", "tool", "interrupted"]
    assert restarted.list_events(run["id"], after=events[0]["seq"])["items"] == events[1:]


def test_schedule_atomicity_coalescing_and_non_overlap(store):
    conversation = store.create_conversation("定时报告")["id"]
    now = datetime.now(UTC)
    schedule = dict(
        id="daily",
        conversation_id=conversation,
        prompt="总结",
        next_run_at=now - timedelta(hours=3),
        interval_seconds=60,
    )
    store.create_schedule(**schedule)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: store.tick_schedules(now), range(8)))
    assert len(store.list_runs()["items"]) == 1
    state = store.list_schedules()["items"][0]
    assert datetime.fromisoformat(state["next_run_at"]) == now + timedelta(seconds=60)
    store.tick_schedules(now + timedelta(hours=1))
    assert len(store.list_runs()["items"]) == 1
    assert store.create_schedule(**schedule)["last_run_id"] == state["last_run_id"]
    active = store.claim_next("task")
    store.finish_run(active["id"], "completed", result="报告")
    restarted = Store(store.settings)
    restarted.tick_schedules(now + timedelta(hours=1))
    assert len(restarted.list_runs()["items"]) == 2
    assert datetime.fromisoformat(
        restarted.list_schedules()["items"][0]["next_run_at"]
    ) > now + timedelta(hours=1)


def test_one_shot_schedule_pause_resume_cannot_replay_same_fire(store):
    conversation = store.create_conversation("一次性")["id"]
    store.create_schedule(
        id="once",
        conversation_id=conversation,
        prompt="一次",
        next_run_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    store.update_schedule("once", False)
    store.tick_schedules()
    assert store.list_runs()["items"] == []
    store.update_schedule("once", True)
    store.tick_schedules()
    run = store.claim_next("task")
    store.finish_run(run["id"], "completed", result="done")
    store.update_schedule("once", True)
    store.tick_schedules()
    assert len(store.list_runs()["items"]) == 1
    assert not store.list_schedules()["items"][0]["enabled"]


def test_recent_and_incremental_windows(store):
    conversation = store.create_conversation("历史")["id"]
    for number in range(7):
        enqueue(store, conversation, f"m-{number}")
    latest = store.list_messages(conversation, limit=3, latest=True)
    assert [item["id"] for item in latest["items"]] == ["m-4", "m-5", "m-6"]
    earlier = store.list_messages(conversation, limit=3, before=int(latest["previous_cursor"]))
    assert [item["id"] for item in earlier["items"]] == ["m-1", "m-2", "m-3"]
    incremental = store.list_messages(conversation, cursor=earlier["items"][-1]["seq"])
    assert incremental["items"] == latest["items"]
    assert [r["prompt"] for r in store.list_runs(conversation, limit=2, latest=True)["items"]] == [
        "m-5",
        "m-6",
    ]


def test_workspace_and_heartbeat_persist(store):
    project = store.create_project("资料")
    conversation = store.create_conversation("项目", project["id"])
    enqueue(store, conversation["id"], "project-task")
    assert store.claim_next("task")["workspace_path"] == project["workspace_path"]
    assert not store.worker_online()
    store.heartbeat()
    assert Store(store.settings).worker_online()


def test_schedule_transaction_rolls_back_fire_and_queue_together(store, monkeypatch):
    conversation = store.create_conversation("调度事务")["id"]
    due = datetime.now(UTC) - timedelta(seconds=5)
    store.create_schedule(id="atomic", conversation_id=conversation, prompt="一次", next_run_at=due)
    original = store._enqueue

    def fail_after_enqueue(*args):
        original(*args)
        raise RuntimeError("simulated interruption before commit")

    monkeypatch.setattr(store, "_enqueue", fail_after_enqueue)
    with pytest.raises(RuntimeError):
        store.tick_schedules()
    assert store.list_runs()["items"] == []
    assert store.list_messages(conversation)["items"] == []
    assert store.list_schedules()["items"][0]["enabled"]
    Store(store.settings).tick_schedules()
    assert len(store.list_runs()["items"]) == 1


def test_steer_racing_completion_never_reaches_next_run(store):
    conversation = store.create_conversation("竞态")["id"]
    first = enqueue(store, conversation, "first")
    second = enqueue(store, conversation, "second")
    store.claim_next("task")

    def submit():
        try:
            return store.submit_message(
                conversation,
                id="race",
                content="限定来源",
                intent="steer",
                target_run_id=first["id"],
            )
        except StoreError as exc:
            assert exc.code == "stale_steer"
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        steer = pool.submit(submit)
        finish = pool.submit(store.finish_run, first["id"], "completed", result="done")
        receipt = steer.result()
        finish.result()
    if receipt:
        message = [m for m in store.list_messages(conversation)["items"] if m["id"] == "race"][0]
        assert message["status"] == "rejected"
        assert message["run_id"] == first["id"]
    assert store.claim_next("task")["id"] == second["id"]
    assert store.get_controls(second["id"])["steers"] == []


def test_queue_cancel_is_durable_and_does_not_drop_other_messages(store):
    conversation = store.create_conversation("队列取消")["id"]
    first = enqueue(store, conversation, "first")
    second = enqueue(store, conversation, "second")
    cancelled = store.cancel_run(first["id"])
    assert cancelled["status"] == "cancelled"
    assert not store.get_conversation(conversation)["blocked"]
    assert Store(store.settings).claim_next("task")["id"] == second["id"]


def test_withdrawing_followup_does_not_pause_current_or_next_run(store):
    conversation = store.create_conversation("撤回后续要求")["id"]
    active = enqueue(store, conversation, "active")
    withdrawn = enqueue(store, conversation, "withdrawn")
    retained = enqueue(store, conversation, "retained")
    store.claim_next("task")
    store.cancel_run(withdrawn["id"])
    assert store.get_run(active["id"])["status"] == "running"
    assert not store.get_conversation(conversation)["blocked"]
    store.finish_run(active["id"], "completed", result="done")
    assert store.claim_next("task")["id"] == retained["id"]


def test_withdrawing_followup_preserves_existing_failure_block(store):
    conversation = store.create_conversation("失败后撤回")["id"]
    active = enqueue(store, conversation, "active")
    withdrawn = enqueue(store, conversation, "withdrawn")
    retained = enqueue(store, conversation, "retained")
    store.claim_next("task")
    store.finish_run(active["id"], "failed", error="requires review")
    store.cancel_run(withdrawn["id"])
    assert store.get_conversation(conversation)["blocked"]
    assert store.claim_next("task") is None
    store.resume_conversation(conversation)
    assert store.claim_next("task")["id"] == retained["id"]


def test_v11_service_migration_preserves_history_and_stops_old_schedules(store):
    from zhixing_next.finance_tools import FINANCE_TOOL_NAMES
    from zhixing_next.health_tools import HEALTH_TOOL_NAMES

    project = store.create_project("历史项目")
    conversation = store.create_conversation("旧会话", project["id"])["id"]
    store.submit_message(conversation, id="legacy-message", content="旧记录", kind="chat")
    observation = store.record_finance_observation(
        kind="balance",
        platform="历史账户",
        amount="81",
        note="观察值",
        conversation_id=conversation,
    )
    store.create_schedule(
        id="old-enabled",
        conversation_id=conversation,
        prompt="旧主动计划",
        next_run_at=datetime.now(UTC) + timedelta(days=1),
    )
    with sqlite3.connect(store.db_path) as db:
        _remove_v12_schema(db)
        db.execute(
            "UPDATE agents SET instructions='我的专属财务指令',tools_json='[\"list_finance_observations\",\"view_image\"]' WHERE id='finance'"
        )
        db.execute("PRAGMA user_version=11")
    migrated = Store(store.settings)
    assert migrated.get_conversation(conversation)["project_id"] == project["id"]
    assert migrated.list_messages(conversation)["items"][0]["content"] == "旧记录"
    assert migrated.list_finance_observations()["balances"][0]["id"] == observation["id"]
    assert migrated.get_agent("finance")["instructions"] == "我的专属财务指令"
    assert set(FINANCE_TOOL_NAMES) <= set(migrated.get_agent("finance")["tools"])
    assert "list_finance_observations" in migrated.get_agent("finance")["tools"]
    assert migrated.get_agent("health")["kind"] == "service"
    assert set(HEALTH_TOOL_NAMES) <= set(migrated.get_agent("health")["tools"])
    assert not migrated.list_schedules()["items"][0]["enabled"]
    migrated.tick_schedules(datetime.now(UTC) + timedelta(days=2))
    assert len(migrated.list_runs()["items"]) == 1
    reopened = Store(store.settings)
    assert reopened.get_agent("finance")["instructions"] == "我的专属财务指令"
    with reopened._connection() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 13
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_new_service_tools_remain_fixed_and_custom_agents_cannot_gain_them(store):
    from zhixing_next.finance_tools import FINANCE_TOOL_NAMES
    from zhixing_next.health_tools import HEALTH_TOOL_NAMES
    from zhixing_next.life_tools import LIFE_TOOL_NAMES

    custom = store.create_agent(
        name="普通助手",
        description="只读",
        instructions="读取资料",
        tools=["read_text_file"],
        visible=True,
    )
    for tool_name in [*FINANCE_TOOL_NAMES, *HEALTH_TOOL_NAMES, *LIFE_TOOL_NAMES]:
        with pytest.raises(StoreError) as created:
            store.create_agent(
                name="越权助手", description="", instructions="", tools=[tool_name], visible=True
            )
        assert created.value.code == "tool_not_allowed"
        with pytest.raises(StoreError) as updated:
            store.update_agent(
                custom["id"],
                name="普通助手",
                description="",
                instructions="",
                tools=[tool_name],
                visible=True,
            )
        assert updated.value.code == "tool_not_allowed"
    for identifier in ("finance", "health"):
        service_agent = store.get_agent(identifier)
        with pytest.raises(StoreError) as raised:
            store.update_agent(
                identifier,
                name=service_agent["name"],
                description=service_agent["description"],
                instructions=service_agent["instructions"],
                tools=[*service_agent["tools"], LIFE_TOOL_NAMES[0]],
                visible=True,
            )
        assert raised.value.code == "tool_not_allowed"
