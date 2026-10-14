"""Actual food plus explicit payment commit together, including retry receipts."""

import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from zhixing_next.config import Settings
from zhixing_next.finance_service import FinanceService
from zhixing_next.health_service import HealthService
from zhixing_next.life_service import LifeService, migrate
from zhixing_next.life_tools import create_life_tools
from zhixing_next.store import Store, StoreError


@pytest.fixture
def store(tmp_path):
    value = Store(Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work"))
    with value._connection(write=True) as db:
        migrate(db)
    return value


def meal(**changes):
    return {
        "occurred_at": "2026-04-09T12:00:00+08:00",
        "meal_type": "lunch",
        "description": "鸡腿饭",
        "portion": "米饭剩了一半",
        **changes,
    }


def save(store, **changes):
    values = {
        "source_id": "original-message",
        "entry_key": "lunch-1",
        "conversation_id": "main",
        "meal": meal(),
        "amount": "26",
        "occurred_on": "2026-04-09",
    }
    values.update(changes)
    return LifeService(store).record_meal(**values)


def count(store, table):
    with sqlite3.connect(store.db_path) as db:
        return db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def test_combined_food_and_payment_have_actual_linked_receipts(store):
    receipt = save(store)
    assert receipt["saved"] and receipt["atomic"]
    assert receipt["finance"]["amount"] == "26.00"
    assert receipt["meal"]["description"] == "鸡腿饭"
    event = LifeService(store).list_events()["items"][0]
    assert event["id"] == receipt["event_id"]
    assert event["finance_id"] == receipt["finance"]["id"]
    assert event["meal_id"] == receipt["meal"]["id"]
    assert count(store, "life_receipts") == 1


def test_unknown_amount_records_food_without_inventing_a_payment(store):
    receipt = save(store, amount=None, occurred_on=None)
    assert receipt["finance"] is None
    assert not receipt["payment_recorded"]
    assert count(store, "finance_transactions") == 0
    assert count(store, "health_meals") == 1


def test_same_source_retry_and_other_route_after_reopen_do_not_duplicate(store):
    first = save(store)
    reopened = Store(store.settings)
    assert save(reopened, conversation_id="delegated-route") == first
    assert count(reopened, "health_meals") == count(reopened, "finance_transactions") == 1
    with pytest.raises(StoreError, match="different"):
        save(reopened, amount="28")


def test_same_message_distinct_entries_remain_distinct(store):
    first = save(store)
    second = save(store, entry_key="lunch-2")
    assert first["event_id"] != second["event_id"]
    assert count(store, "health_meals") == count(store, "finance_transactions") == 2


def test_invalid_meal_rolls_back_payment_and_all_receipts(store):
    with pytest.raises(StoreError):
        save(store, meal=meal(description=""))
    for table in (
        "health_meals",
        "finance_transactions",
        "finance_mutations",
        "life_events",
        "life_receipts",
    ):
        assert count(store, table) == 0
    assert save(store)["saved"]
    assert count(store, "finance_transactions") == 1


def test_failure_after_health_write_rolls_back_both_then_retry_succeeds(store, monkeypatch):
    original = HealthService.create

    def crash_after_actual_write(self, *args, **kwargs):
        original(self, *args, **kwargs)
        raise RuntimeError("simulated interruption after domain writes")

    with monkeypatch.context() as patch:
        patch.setattr(HealthService, "create", crash_after_actual_write)
        with pytest.raises(RuntimeError):
            save(store)
    for table in (
        "health_meals",
        "finance_transactions",
        "finance_mutations",
        "health_writes",
        "life_events",
        "life_receipts",
    ):
        assert count(store, table) == 0
    assert save(store)["saved"]
    assert count(store, "health_meals") == count(store, "finance_transactions") == 1


def test_finance_failure_never_saves_meal(store):
    with pytest.raises(StoreError):
        save(store, amount="-1")
    assert count(store, "health_meals") == count(store, "finance_transactions") == 0


def test_missing_payment_business_date_fails_before_any_write(store):
    with pytest.raises(StoreError, match="business date"):
        save(store, occurred_on=None)
    assert count(store, "life_events") == 0


def test_atomic_correction_updates_both_original_records_and_months(store):
    first = save(store)
    corrected = LifeService(store).correct_meal(
        first["event_id"],
        source_id="correction-message",
        entry_key="date-and-food",
        meal_changes={"occurred_at": "2026-03-31T12:00:00+08:00", "description": "鱼饭"},
        finance_changes={"occurred_on": "2026-03-31", "amount": "24"},
    )
    assert corrected["finance"]["id"] == first["finance"]["id"]
    assert corrected["meal"]["id"] == first["meal"]["id"]
    assert corrected["meal"]["description"] == "鱼饭"
    assert FinanceService(store).summary(month="2026-03")["totals"]["expense"] == "24.00"
    assert FinanceService(store).summary(month="2026-04")["totals"]["expense"] == "0.00"
    assert count(store, "health_meals") == count(store, "finance_transactions") == 1


def test_correction_failure_rolls_back_other_domain_and_retry_only_changes_once(store):
    first = save(store)
    service = LifeService(store)
    args = {
        "source_id": "correct",
        "entry_key": "correction",
        "meal_changes": {"description": "豆腐饭"},
        "finance_changes": {"amount": "invalid"},
    }
    with pytest.raises(StoreError):
        service.correct_meal(first["event_id"], **args)
    assert HealthService(store).list("meals")["items"][0]["description"] == "鸡腿饭"
    args["finance_changes"] = {"amount": "22"}
    corrected = service.correct_meal(first["event_id"], **args)
    assert service.correct_meal(first["event_id"], **args) == corrected
    assert corrected["meal"]["revision"] == 2
    assert corrected["finance"]["revision"] == 2


def test_correction_retry_after_later_domain_edit_does_not_reapply_old_change(store):
    first = save(store)
    args = {"source_id": "correct", "entry_key": "correct-1", "finance_changes": {"amount": "21"}}
    corrected = LifeService(store).correct_meal(first["event_id"], **args)
    FinanceService(store).update_transaction(
        first["finance"]["id"], idempotency_key="separate-correction", amount="20"
    )
    reopened = LifeService(Store(store.settings))
    assert reopened.correct_meal(first["event_id"], **args) == corrected
    assert FinanceService(store).summary(month="2026-04")["totals"]["expense"] == "20.00"


def test_concurrent_retries_are_atomic_and_deduplicated(store):
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(lambda _: save(store), range(8)))
    assert len({row["event_id"] for row in rows}) == 1
    assert count(store, "health_meals") == count(store, "finance_transactions") == 1


async def test_composite_tools_use_original_message_and_allow_linked_correction(store):
    tools = {item.name: item for item in create_life_tools(store.settings, "main", "tool-message")}
    args = {"entry_key": "meal-1", "meal": meal(), "amount": "26", "occurred_on": "2026-04-09"}
    first = await tools["record_life_meal"].ainvoke(args)
    assert await tools["record_life_meal"].ainvoke(args) == first
    changed = {
        item.name: item for item in create_life_tools(store.settings, "main", "correction-message")
    }
    receipt = await changed["correct_life_meal"].ainvoke(
        {
            "event_id": first["event_id"],
            "entry_key": "fix-1",
            "meal_changes": {"portion": "吃完"},
            "finance_changes": {"amount": "25"},
        }
    )
    assert receipt["finance"]["amount"] == "25.00"
    assert receipt["meal"]["portion"] == "吃完"
