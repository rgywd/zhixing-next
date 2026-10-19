"""Linked meal/payment writes bind each checkpointed user input after Steer."""

from langchain_core.messages import AIMessage
from test_finance_write_stream import execute
from test_runtime import ScriptedModel, make_settings

from zhixing_next.finance_context import active_finance_input, delegated_finance_input
from zhixing_next.finance_service import FinanceService
from zhixing_next.health_service import HealthService, source_key
from zhixing_next.meal_input import UNKNOWN_MEAL_TIME_NOTE
from zhixing_next.operations import Journal
from zhixing_next.store import Store


def call(name, args, identifier="shared-provider-id"):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": identifier, "type": "tool_call"}])


async def test_new_steer_meal_uses_its_own_source_time_and_same_call_id_does_not_replay_first(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("Linked source")['id']
    store.submit_message(conversation, id="meal-first", content="今天午饭花24.60，吃了青菜和米饭。")
    with store._connection(write=True) as db:
        db.execute("UPDATE messages SET created_at='2026-10-16T07:42:13+00:00' WHERE id='meal-first'")
    run = store.claim_next("chat")
    sent = False

    async def on_emit(kind, data):
        nonlocal sent
        if not sent and kind == "tool" and data.get("tool") == "record_life_meal" and data.get("status") == "completed":
            store.submit_message(conversation, id="meal-steer", content="再记今天晚饭26元，吃了豆腐。", intent="steer", target_run_id=run["id"])
            with store._connection(write=True) as db:
                db.execute("UPDATE messages SET created_at='2026-10-17T11:17:29+00:00' WHERE id='meal-steer'")
            sent = True

    model = ScriptedModel(replies=[
        call("record_life_meal", {"entry_key": "meal", "meal": {"description": "青菜和米饭"}, "amount": "24.60", "occurred_on": "2026-10-16"}),
        call("record_life_meal", {"entry_key": "meal", "meal": {"description": "豆腐"}, "amount": "26", "occurred_on": "2026-10-17"}),
        AIMessage(content="已记录两顿。"),
    ])
    await execute(settings, store, run, model, on_emit)
    meals = {row["source_id"]: row for row in HealthService(store).list("meals")["items"]}
    assert set(meals) == {"meal-first", "meal-steer"}
    assert meals["meal-first"]["occurred_at"] == "2026-10-16T15:42:13+08:00"
    assert meals["meal-steer"]["occurred_at"] == "2026-10-17T19:17:29+08:00"
    assert all(UNKNOWN_MEAL_TIME_NOTE in row["note"] for row in meals.values())
    transactions = {row["source_id"]: row for row in FinanceService(store).list_transactions(month="2026-10")["items"]}
    assert set(transactions) == {"meal-first", "meal-steer"}
    assert transactions["meal-first"]["amount"] == "24.60" and transactions["meal-steer"]["amount"] == "26.00"
    assert all(meals[key]["occurred_at"][:10] == row["occurred_on"] for key, row in transactions.items())
    operations = Journal(settings).receipts(run["id"])["items"]
    assert {row["call_id"] for row in operations} == {"shared-provider-id", "shared-provider-id:meal-steer"}
    assert all(row["state"] == "succeeded" for row in operations)
    assert active_finance_input.get() is None and delegated_finance_input.get() is None


async def test_linked_date_correction_reads_clock_evidence_from_steer_and_keeps_both_dates_consistent(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("Linked correction")['id']
    store.submit_message(conversation, id="meal-first", content="10月16日12:20吃午饭，花24.60。")
    run = store.claim_next("chat")
    sent = False

    async def on_emit(kind, data):
        nonlocal sent
        if not sent and kind == "tool" and data.get("tool") == "record_life_meal" and data.get("status") == "completed":
            store.submit_message(conversation, id="meal-correction", content="那顿其实是10月15日18:40吃的，金额23元。", intent="steer", target_run_id=run["id"])
            sent = True

    event_id = "life:" + source_key("meal-first", "meal")
    model = ScriptedModel(replies=[
        call("record_life_meal", {"entry_key": "meal", "meal": {"description": "午饭", "occurred_at": "2026-10-16T12:20:00+08:00"}, "amount": "24.60", "occurred_on": "2026-10-16"}),
        call("correct_life_meal", {"event_id": event_id, "entry_key": "fix", "meal_changes": {"occurred_at": "2026-10-15T18:40:00+08:00"}, "finance_changes": {"occurred_on": "2026-10-15", "amount": "23"}}),
        AIMessage(content="已纠正。"),
    ])
    await execute(settings, store, run, model, on_emit)
    meals = HealthService(store).list("meals")["items"]
    payments = FinanceService(store).list_transactions(month="2026-10")["items"]
    assert len(meals) == len(payments) == 1
    assert meals[0]["occurred_at"] == "2026-10-15T18:40:00+08:00"
    assert UNKNOWN_MEAL_TIME_NOTE not in meals[0]["note"]
    assert payments[0]["occurred_on"] == "2026-10-15" and payments[0]["amount"] == "23.00"
    operations = Journal(settings).receipts(run["id"])["items"]
    assert {row["call_id"] for row in operations} == {"shared-provider-id", "shared-provider-id:meal-correction"}
    assert all(row["state"] == "succeeded" for row in operations)
