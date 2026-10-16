"""Regressions for the actual diet/choice/correction loop and retry safety."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from zhixing_next.api import create_app
from zhixing_next.config import Settings
from zhixing_next.health_service import HealthService, migrate
from zhixing_next.health_tools import HEALTH_TOOL_NAMES, create_health_tools
from zhixing_next.store import Store, StoreError


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    value = ["2026-04-05T10:00:00+00:00"]
    monkeypatch.setattr("zhixing_next.health_service._now", lambda: value[0])
    return value


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work",
                    api_token="health-test-token")


@pytest.fixture
def service(settings):
    return HealthService(Store(settings))


def editable(record):
    return {key: value for key, value in record.items()
            if key not in {"created_at", "updated_at", "value_kg", "deleted", "status"}}


def meal(identifier="meal-1", **overrides):
    return {"id": identifier, "occurred_at": "2026-04-05T12:30:00+08:00",
            "description": "清蒸鱼、蔬菜和米饭", "meal_type": "lunch",
            "portion": "米饭剩了一部分", **overrides}


def recommendation(service, identifier="rec-1", **overrides):
    return {"id": identifier, "context_revision": service.summary("2026-04-05")["revision"],
            "target_date": "2026-04-05", "meal_type": "dinner",
            "options": [{"id": "fish", "title": "清蒸鱼配蔬菜", "description": "搭配一份米饭",
                         "ingredients": ["鱼", "蔬菜", "米饭"], "portion": "按饥饱感调整",
                         "substitutions": ["豆腐替换鱼"], "reason": "遵守当前约定"}], **overrides}


def test_empty_health_context_has_no_fabricated_measurements_or_adherence(service):
    context = service.summary("2026-04-05")
    assert context["profile"]["height_cm"] is None
    assert context["profile"]["goals"] == []
    assert context["meals"] == context["weights"] == context["steps"] == []
    assert context["review"]["unknown_is_not_nonadherence"] is True
    assert context["review"]["weight_trend"]["change_kg"] is None
    assert context["reminders"]["enabled"] is False
    assert context["reminders"]["slots"] == []


def test_actual_record_retry_survives_restart_and_does_not_merge_same_day_food(service, settings):
    first = service.create("meals", meal())
    again = HealthService(Store(settings)).create("meals", meal())
    assert again["id"] == first["id"]
    assert len(service.list("meals")["items"]) == 1
    service.create("meals", meal("meal-2"))
    assert len(service.list("meals")["items"]) == 2
    with pytest.raises(StoreError, match="different health data") as error:
        service.create("meals", meal(description="另一顿饭"))
    assert error.value.code == "idempotency_conflict"
    assert len(service.list("meals")["items"]) == 2


def test_profile_revisions_and_durable_change_receipts(service, settings):
    profile = {**service.profile(), "height_cm": 172, "activity_limitations": ["不能跳跃"]}
    result = service.set_profile(profile, operation_key="profile-change-1")
    assert result["height_cm"] == 172
    revised = service.set_profile({**result, "height_cm": 173})
    assert revised["revision"] == 2
    # A retry after another successful write returns its original durable receipt,
    # and does not reset the profile to the old value.
    receipt = HealthService(Store(settings)).set_profile(profile, operation_key="profile-change-1")
    assert receipt == result
    assert service.profile()["height_cm"] == 173
    with pytest.raises(StoreError) as error:
        service.set_profile({**profile, "height_cm": 174})
    assert error.value.code == "revision_conflict"


def test_profile_patch_preserves_restrictions_and_retries_do_not_reapply_old_fields(service, settings):
    original = service.set_profile({**service.profile(), "height_cm": 172,
                                   "food_allergies": ["花生"], "activity_limitations": ["不能跑步"]})
    first = service.patch_profile({"preferences": ["清淡"]}, operation_key="patch-profile")
    assert first["food_allergies"] == ["花生"]
    assert first["activity_limitations"] == ["不能跑步"]
    assert first["height_cm"] == 172
    service.patch_profile({"height_cm": 173})
    replay = HealthService(Store(settings)).patch_profile({"preferences": ["清淡"]}, operation_key="patch-profile")
    assert replay == first and service.profile()["height_cm"] == 173
    with pytest.raises(StoreError) as error:
        service.patch_profile({"revision": original["revision"], "height_cm": 174})
    assert error.value.code == "revision_conflict"
    # Even an unchanged value with an explicitly stale revision must not hide a conflict.
    with pytest.raises(StoreError):
        service.patch_profile({"revision": original["revision"], "height_cm": 173})
    assert service.profile()["food_allergies"] == ["花生"]


def test_reminder_patch_preserves_slots_quiet_hours_and_timezone(service):
    first = service.set_reminders({**service.reminders(), "enabled": True,
                                  "slots": [{"id": "dinner", "time": "18:00"}],
                                  "quiet_start": "22:00", "quiet_end": "08:00"})
    changed = service.patch_reminders({"tone": "轻声提醒"})
    assert changed["enabled"] and changed["slots"] == first["slots"]
    assert changed["timezone"] == first["timezone"]
    assert (changed["quiet_start"], changed["quiet_end"]) == ("22:00", "08:00")
    with pytest.raises(StoreError):
        service.patch_reminders({"revision": first["revision"], "enabled": False})


@pytest.mark.parametrize("kind,record,changes,retained", [
    ("meals", {"occurred_at": "2026-04-05T12:30:00+08:00", "description": "午饭", "portion": "半碗"},
     {"description": "米饭和蔬菜"}, {"portion": "半碗", "occurred_at": "2026-04-05T12:30:00+08:00"}),
    ("weights", {"measured_at": "2026-04-05T09:00:00+08:00", "value": 80},
     {"value": 81}, {"unit": "kg", "measured_at": "2026-04-05T09:00:00+08:00"}),
    ("rules", {"content": "避免花生", "kind": "restriction", "excluded_terms": ["花生"]},
     {"status": "paused"}, {"content": "避免花生", "excluded_terms": ["花生"]}),
])
def test_record_patch_keeps_omitted_facts_provenance_and_explicit_revision_guards(service, settings, kind, record, changes, retained):
    original = service.create(kind, {**record, "source_id": "original", "conversation_id": "source-chat"})
    first = service.patch_record(kind, original["id"], changes, operation_key=f"patch-{kind}")
    assert all(first[key] == value for key, value in retained.items())
    assert first["source_id"] == "original" and first["conversation_id"] == "source-chat"
    later = {"content": "继续避免花生"} if kind == "rules" else {"note": "稍后补充"}
    service.patch_record(kind, original["id"], later)
    assert HealthService(Store(settings)).patch_record(kind, original["id"], changes,
                                                     operation_key=f"patch-{kind}") == first
    with pytest.raises(StoreError) as error:
        service.patch_record(kind, original["id"], {**changes, "revision": original["revision"]})
    assert error.value.code == "revision_conflict"
    with pytest.raises(StoreError):
        service.patch_record(kind, original["id"], {"made_up_field": True})


async def test_health_tools_patch_only_changed_fields_and_bind_actual_seen_inputs(settings):
    from zhixing_next.finance_context import active_finance_input, delegated_finance_input

    store = Store(settings)
    conversation = store.create_conversation("健康")
    store.submit_message(conversation["id"], id="first-input", content="4月5日12:30吃的午饭")
    store.submit_message(conversation["id"], id="second-input", content="另一顿在4月5日12:30吃的")
    service = HealthService(store)
    service.patch_profile({"food_allergies": ["花生"], "activity_limitations": ["不能跑步"]})
    available = {item.name: item for item in create_health_tools(settings, "health-chat", "first-input")}
    profile = await available["save_health_profile"].ainvoke({"profile": {"preferences": ["清淡"]}, "entry_key": "profile"})
    assert profile["food_allergies"] == ["花生"] and profile["activity_limitations"] == ["不能跑步"]
    args = {"occurred_at": "2026-04-05T12:30:00+08:00", "description": "午饭", "entry_key": "meal"}
    first = await available["record_meal"].ainvoke(args)
    token = delegated_finance_input.set("second-input")
    try:
        second = await available["record_meal"].ainvoke({**args, "description": "晚饭"})
        assert second["source_id"] == "second-input" and second["id"] != first["id"]
        active = active_finance_input.set("first-input")
        try:
            replay = await available["record_meal"].ainvoke(args)
            assert replay["id"] == first["id"] and replay["source_id"] == "first-input"
        finally:
            active_finance_input.reset(active)
    finally:
        delegated_finance_input.reset(token)
    fixed = await available["correct_health_record"].ainvoke({"kind": "meals", "identifier": first["id"],
                                                               "record": {"portion": "半碗"}, "entry_key": "fix"})
    assert fixed["description"] == "午饭" and fixed["portion"] == "半碗"
    deleted = await available["delete_health_record"].ainvoke({"kind": "meals", "identifier": first["id"], "entry_key": "retract"})
    assert deleted["deleted"]


def test_rules_effective_days_pause_and_ai_proposals_are_not_silently_adopted(service):
    rule = service.create("rules", {"id": "one-day", "content": "今天少放盐",
                                   "effective_from": "2026-04-05", "effective_until": "2026-04-05"})
    assert service.summary("2026-04-05")["rules"][0]["id"] == rule["id"]
    assert service.summary("2026-04-06")["rules"] == []
    all_fields = {key: value for key, value in rule.items() if key not in {"created_at", "updated_at"}}
    paused = service.update("rules", rule["id"], {**all_fields, "status": "paused"})
    assert paused["status"] == "paused"
    assert service.summary("2026-04-05")["rules"] == []
    proposal = service.create("rules", {"id": "proposal", "content": "晚饭增加蔬菜",
                                       "origin": "assistant_proposal"})
    assert proposal["status"] == "proposed"
    assert service.summary("2026-04-05")["rules"] == []
    original = {key: value for key, value in proposal.items() if key not in {"created_at", "updated_at"}}
    service.update("rules", proposal["id"], {**original, "confirmed": True, "status": "active"})
    assert service.summary("2026-04-06")["rules"][0]["id"] == "proposal"


def test_candidates_validate_known_restrictions_and_require_ingredient_information(service):
    service.set_profile({**service.profile(), "food_allergies": ["花生"]})
    unsafe = recommendation(service)
    unsafe["options"][0]["ingredients"].append("花生油")
    with pytest.raises(StoreError) as error:
        service.create("recommendations", unsafe)
    assert error.value.code == "health_restriction_conflict"
    missing = recommendation(service)
    missing["options"][0]["ingredients"] = []
    with pytest.raises(StoreError) as error:
        service.create("recommendations", missing)
    assert error.value.code == "ingredients_required"
    service.create("rules", {"id": "no-fish", "content": "不吃鱼", "kind": "restriction",
                             "excluded_terms": ["鱼"]})
    with pytest.raises(StoreError) as error:
        service.create("recommendations", recommendation(service))
    assert error.value.code == "health_restriction_conflict"
    assert service.list("recommendations")["items"] == []


def test_candidate_final_publication_and_acceptance_revalidate_current_context(service):
    generating = recommendation(service)
    service.create("rules", {"id": "new-rule", "content": "晚上只能吃外卖"})
    with pytest.raises(StoreError) as error:
        service.create("recommendations", generating)
    assert error.value.code == "stale_health_context"
    published = service.create("recommendations", recommendation(service))
    assert published["status"] == "current"
    assert published["basis"]["rule_revisions"][0]["id"] == "new-rule"
    assert published["basis"]["rule_snapshots"][0]["content"] == "晚上只能吃外卖"
    service.create("meals", meal())
    assert service.list("recommendations")["items"][0]["status"] == "stale"
    with pytest.raises(StoreError) as error:
        service.feedback(published["id"], {"id": "choice", "action": "accepted", "option_id": "fish"})
    assert error.value.code == "stale_health_context"
    # Returning an old save receipt exposes stale status rather than publishing anew.
    assert service.create("recommendations", recommendation(service, context_revision=published["context_revision"]))["status"] == "stale"


def test_complete_choice_actual_record_next_day_review_and_correction_survive_restart(service, settings):
    rule = service.create("rules", {"id": "vegetables", "content": "晚餐搭配蔬菜"})
    rec = service.create("recommendations", recommendation(service))
    choice = {"id": "accepted", "action": "accepted", "option_id": "fish", "note": "今天只能点外卖"}
    service.feedback(rec["id"], choice)
    assert service.summary("2026-04-05")["meals"] == []  # A plan never becomes intake.
    actual = service.create("meals", meal(recommendation_id=rec["id"], note="外卖有点咸"))
    assert HealthService(Store(settings)).feedback(rec["id"], choice)["id"] == "accepted"
    next_day = HealthService(Store(settings)).summary("2026-04-06")
    review = next_day["review"]["recent_choices"][0]
    assert review["latest_feedback"]["note"] == "今天只能点外卖"
    assert review["actual_meals"][0]["note"] == "外卖有点咸"
    changed = {key: value for key, value in actual.items() if key not in {"created_at", "updated_at"}}
    changed["description"] = "豆腐、蔬菜和米饭"
    changed["occurred_at"] = "2026-04-04T12:30:00+08:00"
    service.update("meals", actual["id"], changed, operation_key="correct-original")
    # Replaying the original create cannot undo the correction or add a second food record.
    retried = service.create("meals", meal(recommendation_id=rec["id"], note="外卖有点咸"))
    assert retried["description"] == changed["description"]
    assert len(service.list("meals")["items"]) == 1
    review = service.summary("2026-04-06")["review"]["recent_choices"][0]
    assert review["actual_meals"][0]["occurred_at"].startswith("2026-04-04")
    assert service.summary("2026-04-06")["all_rules"][0]["id"] == rule["id"]


def test_replacement_feedback_preserves_difficulty_and_never_manufactures_intake(service):
    rec = service.create("recommendations", recommendation(service))
    before = service.summary("2026-04-05")["revision"]
    service.feedback(rec["id"], {"id": "replace", "action": "replaced", "note": "没有厨房，换方便购买的"})
    context = service.summary("2026-04-06")
    assert context["revision"] > before
    assert context["review"]["recent_choices"][0]["latest_feedback"]["action"] == "replaced"
    assert context["recent_meals"] == []
    following = service.create("recommendations", recommendation(service, "rec-2", target_date="2026-04-06", context="根据上次没有厨房的困难选择方便购买的"))
    assert following["context_revision"] == context["revision"]


def test_correction_and_delete_are_idempotent_without_losing_later_changes(service):
    original = service.create("meals", meal())
    record = {key: value for key, value in original.items() if key not in {"created_at", "updated_at"}}
    first = service.update("meals", original["id"], {**record, "portion": "半份米饭"}, operation_key="correction-1")
    later = {key: value for key, value in first.items() if key not in {"created_at", "updated_at"}}
    service.update("meals", original["id"], {**later, "note": "用户后来补充"})
    assert service.update("meals", original["id"], {**record, "portion": "半份米饭"}, operation_key="correction-1") == first
    current = service.list("meals")["items"][0]
    assert current["note"] == "用户后来补充"
    service.delete("meals", original["id"], current["revision"], operation_key="delete-1")
    assert service.delete("meals", original["id"], current["revision"], operation_key="delete-1")["deleted"] is True
    assert service.list("meals")["items"] == []
    assert service.create("meals", meal())["deleted"] is True
    assert service.list("meals")["items"] == []


def test_original_weight_units_daily_coverage_and_single_day_is_not_a_trend(service):
    first = service.create("weights", {"id": "weight-1", "measured_at": "2026-04-04T08:00:00+08:00", "value": 154, "unit": "lb"})
    assert first["unit"] == "lb"
    assert first["value_kg"] == pytest.approx(69.853)
    service.create("weights", {"id": "weight-2", "measured_at": "2026-04-04T21:00:00+08:00", "value": 71, "unit": "kg"})
    assert service.summary("2026-04-04")["review"]["weight_trend"]["change_kg"] is None
    service.create("weights", {"id": "weight-3", "measured_at": "2026-04-05T08:00:00+08:00", "value": 70, "unit": "kg"})
    trend = service.summary("2026-04-05")["review"]["weight_trend"]
    assert trend["count"] == 3
    assert trend["days"] == 2
    assert trend["latest_kg"] == 70
    assert trend["change_kg"] == pytest.approx(-0.4265, abs=0.001)
    assert service.profile()["goals"] == []  # No automatic target reduction.


def test_photo_estimates_have_range_and_basis_and_cannot_turn_into_exact_intake(service):
    estimate = {"minimum": 300, "maximum": 700, "basis": "照片可见食材，份量与油量未知"}
    saved = service.create("meals", meal(estimated_energy=estimate))
    assert saved["estimated_energy"]["minimum"] == 300
    assert saved["estimated_energy"]["maximum"] == 700
    with pytest.raises(StoreError):
        service.create("meals", meal("invalid", estimated_energy={"minimum": 400, "maximum": 200, "basis": "照片"}))
    skipped = service.create("meals", meal("skipped", description="", status="skipped", portion=""))
    assert skipped["status"] == "skipped"
    context = service.summary("2026-04-05")
    assert context["review"]["recorded_meals"] == 1
    assert context["review"]["skipped_meals"] == 1


def test_reminder_preferences_validate_timezone_quiet_hours_and_pause_is_persistent(service, settings):
    original = service.reminders()
    payload = {**original, "enabled": True, "timezone": "Europe/Paris", "slots": [
        {"id": "dinner", "time": "18:30", "meal_type": "dinner", "kind": "meal"}],
        "quiet_start": "22:00", "quiet_end": "08:00", "paused_dates": ["2026-04-05"]}
    saved = service.set_reminders(payload, operation_key="reminder-change")
    assert HealthService(Store(settings)).reminders() == saved
    assert service.set_reminders(payload, operation_key="reminder-change") == saved
    for invalid in ({"timezone": "Not/A_Zone"}, {"quiet_end": None}, {"max_per_day": 0},
                    {"slots": [{"id": "bad", "time": "25:00"}]}):
        with pytest.raises(StoreError):
            service.set_reminders({**saved, **invalid})
    assert service.summary("2026-04-05")["reminders"]["paused_dates"] == ["2026-04-05"]


def test_model_independent_api_records_and_corrections_require_auth_and_preserve_dates(settings):
    app = create_app(settings)
    with TestClient(app) as client:
        assert client.get("/v1/health/summary").status_code == 401
        client.headers["Authorization"] = f"Bearer {settings.api_token}"
        assert client.get("/v1/health/summary?date=2026-04-05").status_code == 200
        first = client.post("/v1/health/meals", json=meal()).json()
        assert first["id"] == "meal-1"
        assert client.post("/v1/health/meals", json=meal()).json()["id"] == first["id"]
        changed = {key: value for key, value in first.items() if key not in {"created_at", "updated_at"}}
        changed["occurred_at"] = "2026-04-04T12:30:00+08:00"
        updated = client.put("/v1/health/meals/meal-1", json=changed)
        assert updated.status_code == 200
        assert client.get("/v1/health/summary?date=2026-04-05").json()["meals"] == []
        assert len(client.get("/v1/health/summary?date=2026-04-04").json()["meals"]) == 1
        assert client.delete(f"/v1/health/meals/meal-1?revision={updated.json()['revision']}").status_code == 200
        assert client.get("/v1/health/meals").json()["items"] == []
        assert client.post("/v1/health/weights", json={"value": "nan", "measured_at": "bad"}).status_code == 422
        assert client.get("/v1/health/summary?date=not-a-date").status_code == 422


def test_agent_tools_retry_across_routing_and_only_receive_narrow_finance_context(settings):
    store = Store(settings)
    conversation = store.create_conversation("健康")
    store.submit_message(conversation["id"], id="original-message", content="4月5日12:30吃了米饭和青菜")
    tools = {item.name: item for item in create_health_tools(settings, conversation["id"], "original-message")}
    assert set(tools) == set(HEALTH_TOOL_NAMES)
    args = {"occurred_at": "2026-04-05T12:30:00+08:00", "description": "米饭和青菜", "entry_key": "meal:lunch:1"}
    first = asyncio.run(tools["record_meal"].ainvoke(args))
    restarted = {item.name: item for item in create_health_tools(settings, "another-routing-context", "original-message")}
    # Source message identity should survive main/child routing. conversation_id is
    # contextual provenance, not part of the logical record identity.
    repeated = asyncio.run(restarted["record_meal"].ainvoke(args))
    assert repeated["id"] == first["id"]
    assert repeated["conversation_id"] == conversation["id"]
    assert len(HealthService(store).list("meals")["items"]) == 1
    assert first["source_id"] == "original-message"
    context = asyncio.run(tools["query_health_context"].ainvoke({"date": "2026-04-05"}))
    assert "meal_budget_context" in context
    assert "budget" not in context["meal_budget_context"]
    assert "transactions" not in context["meal_budget_context"]
    assert "income" not in context["meal_budget_context"]


def test_health_migration_is_reentrant_and_preserves_profile_records_and_receipts(service):
    initial_request = {**service.profile(), "preferences": ["清淡口味"]}
    profile = service.set_profile(initial_request, operation_key="profile-before-migration")
    first = service.create("meals", meal())
    with service.store._connection(write=True) as db:
        migrate(db)
        migrate(db)
    assert service.profile() == profile
    assert service.create("meals", meal())["id"] == first["id"]
    assert len(service.list("meals")["items"]) == 1
    # Replayed change receipt remains usable after reentrant migration.
    assert service.set_profile(initial_request, operation_key="profile-before-migration") == profile


def test_recommendation_expires_when_its_local_date_passes_without_any_write(service, clock):
    rec = service.create("recommendations", recommendation(service))
    assert rec["status"] == "current"
    revision = service.summary()["revision"]
    # Shanghai moves to April 6 although UTC is still April 5. No data changed.
    clock[0] = "2026-04-05T17:00:00+00:00"
    assert service.summary()["date"] == "2026-04-06"
    assert service.summary()["revision"] == revision
    assert service.list("recommendations")["items"][0]["status"] == "stale"
    with pytest.raises(StoreError) as error:
        service.feedback(rec["id"], {"id": "late-choice", "action": "accepted", "option_id": "fish"})
    assert error.value.code == "stale_health_context"
    with pytest.raises(StoreError):
        service.create("recommendations", recommendation(service, "late-publication"))
