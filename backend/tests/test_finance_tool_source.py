"""Finance writes follow the trusted input seen by the executing graph."""

from contextlib import contextmanager
from uuid import uuid4

import pytest
from test_finance_report_publication import fixture as report_state
from test_finance_report_publication import publisher
from test_runtime import make_settings

from zhixing_next.finance_context import active_finance_input, delegated_finance_input
from zhixing_next.finance_service import FinanceService
from zhixing_next.finance_tools import create_finance_service_tools
from zhixing_next.store import Store


@contextmanager
def bind(variable, value):
    token = variable.set(value)
    try:
        yield
    finally:
        variable.reset(token)


@pytest.fixture
def state(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("新消息来源", agent_id="finance")["id"]
    sources = []
    for day, text in (
        ("09", "今天午饭30元，房租按季度支付。"),
        ("10", "今天午饭40元，房租统一按 7 日支付。"),
    ):
        identifier = str(uuid4())
        sources.append(identifier)
        with store._connection(write=True) as db:
            db.execute(
                "INSERT INTO messages(id,conversation_id,role,content,intent,status,created_at) VALUES(?,?,'user',?,'steer','applied',?)",
                (identifier, conversation, text, f"2026-04-{day}T07:00:00+00:00"),
            )
    available = {
        item.name: item for item in create_finance_service_tools(settings, conversation, sources[0])
    }
    return store, sources, available


def meal(day="09", amount="30", **fields):
    return {
        "entry_key": "meal",
        "kind": "expense",
        "amount": amount,
        "occurred_on": f"2026-04-{day}",
        "category": "午饭",
        "date_evidence": f"今天午饭{amount}元",
        **fields,
    }


@pytest.mark.parametrize("variable", [active_finance_input, delegated_finance_input])
async def test_new_input_changes_write_source_and_same_entry_replays_per_source(state, variable):
    store, (original, current), tools = state
    tool = tools["record_finance_transaction"]
    first = await tool.ainvoke(meal())
    with bind(variable, current):
        second = await tool.ainvoke(meal("10", "40"))
        assert await tool.ainvoke(meal("10", "40")) == second
        historical = await tool.ainvoke(meal(entry_key="history", date_source_message_id=original))
    assert await tool.ainvoke(meal()) == first
    assert first["id"] != second["id"]
    assert first["source_id"] == original and second["source_id"] == current
    assert second["date_verification"]["source_message_id"] == current
    assert historical["source_id"] == current
    assert historical["date_verification"]["source_message_id"] == original
    assert FinanceService(store).list_transactions(month="2026-04")["total"] == 3


async def test_new_input_rule_defaults_to_new_source_with_stable_budget_retries(state):
    store, (_, current), tools = state
    item = {
        "key": "rent",
        "label": "房租",
        "kind": "fixed",
        "amount": "3600",
        "every_months": 3,
        "anchor_month": "2026-03",
        "monthly_cost": "1200",
    }
    args = {
        "entry_key": "budget",
        "month": "2026-04",
        "changes": {"commitments_upsert": [item]},
    }
    tool = tools["update_finance_budget"]
    first = await tool.ainvoke(args)
    changed = {
        **args,
        "changes": {"commitments_upsert": [{**item, "due_day": 7}]},
        "date_evidence": "房租统一按 7 日支付",
    }
    with bind(delegated_finance_input, current):
        second = await tool.ainvoke(changed)
        assert await tool.ainvoke(changed) == second
    assert await tool.ainvoke(args) == first
    assert second["commitments"][0]["due_day"] == 7
    assert FinanceService(store).get_budget("2026-04")["commitments"][0]["due_day"] == 7


async def test_correct_batch_and_delete_keys_and_date_defaults_follow_current_input(state):
    store, (_, current), tools = state
    first = await tools["record_finance_transaction"].ainvoke(meal())
    correction = {
        "transaction_id": first["id"],
        "entry_key": "correct",
        "changes": {"amount": "31"},
    }
    await tools["correct_finance_transaction"].ainvoke(correction)
    old_batch = {
        "entry_key": "batch",
        "operations": [
            {
                "operation": "create",
                "fields": {
                    key: value
                    for key, value in meal().items()
                    if key not in {"entry_key", "date_evidence"}
                },
                "date_evidence": "今天午饭30元",
            }
        ],
    }
    batch1 = await tools["apply_finance_transaction_batch"].ainvoke(old_batch)
    await tools["delete_finance_transaction"].ainvoke(
        {"transaction_id": batch1["items"][0]["record"]["id"], "entry_key": "delete"}
    )
    with bind(active_finance_input, current):
        corrected = await tools["correct_finance_transaction"].ainvoke(
            {
                **correction,
                "changes": {"amount": "40", "occurred_on": "2026-04-10"},
                "date_evidence": "今天午饭40元",
            }
        )
        assert corrected["date_verification"]["source_message_id"] == current
        new_batch = {
            **old_batch,
            "operations": [
                {
                    "operation": "create",
                    "fields": {
                        key: value
                        for key, value in meal("10", "40").items()
                        if key not in {"entry_key", "date_evidence"}
                    },
                    "date_evidence": "今天午饭40元",
                }
            ],
        }
        batch2 = await tools["apply_finance_transaction_batch"].ainvoke(new_batch)
        assert batch2["items"][0]["record"]["source_id"] == current
        assert batch2["date_verifications"][0]["source_message_id"] == current
        assert await tools["apply_finance_transaction_batch"].ainvoke(new_batch) == batch2
        deleted = await tools["delete_finance_transaction"].ainvoke(
            {"transaction_id": batch2["items"][0]["record"]["id"], "entry_key": "delete"}
        )
        assert deleted["deleted"] is True
    assert FinanceService(store).list_transactions(month="2026-04")["total"] == 1


async def test_report_preserves_active_priority_and_delegated_source_scope(tmp_path):
    settings, store, service, run, arguments = report_state(tmp_path)
    events = []
    tool = publisher(settings, store, run, events)
    first = await tool.ainvoke(arguments)
    with bind(delegated_finance_input, "actual-seen-steer"):
        with bind(active_finance_input, run["message_id"]):
            assert await tool.ainvoke(arguments) == first
        service.patch_budget(
            month="2026-04", idempotency_key="steer-budget", changes={"savings_target": "8100"}
        )
        second = await tool.ainvoke(arguments)
        assert await tool.ainvoke(arguments) == second
    assert second["verification"]["finance_input_id"] == "actual-seen-steer"
    assert (
        second["verification"]["finance_report_key"] != first["verification"]["finance_report_key"]
    )
    assert second["resource"]["id"] != first["resource"]["id"]
    assert len(events) == 2
