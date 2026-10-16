"""An AI cannot turn observation/payment dates into a recurring payment rule."""

from uuid import uuid4

import pytest
from test_runtime import make_settings

from zhixing_next.finance_service import FinanceService
from zhixing_next.finance_tools import create_finance_service_tools
from zhixing_next.store import Store, StoreError


@pytest.fixture
def state(tmp_path):
    store = Store(make_settings(tmp_path))
    conversation = store.create_conversation("付款规则", agent_id="finance")["id"]
    return store, conversation


def source(store, conversation, content):
    identifier = str(uuid4())
    with store._connection(write=True) as db:
        db.execute(
            "INSERT INTO messages(id,conversation_id,role,content,intent,status,created_at) VALUES(?,?,'user',?,'queue','applied','2026-04-09')",
            (identifier, conversation, content),
        )
    return identifier


def tool(store, conversation, message):
    return next(
        item
        for item in create_finance_service_tools(store.settings, conversation, message)
        if item.name == "update_finance_budget"
    )


def arguments(day=1, entry="budget"):
    item = {
        "key": "rent",
        "label": "房租",
        "amount": "3600",
        "kind": "fixed",
        "every_months": 3,
        "anchor_month": "2026-03",
        "monthly_cost": "1200",
    }
    if day is not None:
        item["due_day"] = day
    return {"entry_key": entry, "month": "2026-04", "changes": {"commitments_upsert": [item]}}


@pytest.mark.parametrize(
    "quote",
    [
        "3月2日资产有6000，3月至5月房租3600",
        "3月12日交了房租",
        "房租每三个月交一次，这次3月12日交了",
        "计划3月12日交房租",
        "房租付款日还不确定",
        "房租不是统一按1日支付",
    ],
)
async def test_observation_coverage_actual_payment_or_uncertainty_cannot_set_recurring_day(
    state, quote
):
    store, conversation = state
    message = source(store, conversation, quote)
    with pytest.raises(StoreError) as error:
        await tool(store, conversation, message).ainvoke({**arguments(12), "date_evidence": quote})
    assert error.value.code == "unverified_budget_due_day"
    assert "Do not guess the 1st" in str(error.value) and "do not" in str(error.value).lower()
    assert FinanceService(store).get_budget("2026-04")["commitments"] == []
    saved = await tool(store, conversation, message).ainvoke(arguments(None, "month-only"))
    assert "due_day" not in saved["commitments"][0]
    assert (
        FinanceService(store).summary(month="2026-04")["commitments"]["items"][0]["next_due_on"]
        is None
    )
    assert FinanceService(store).list_transactions(month="2026-04")["total"] == 0


@pytest.mark.parametrize(
    "quote", ["房租统一按12日支付", "每月十二号交房租", "房租每三个月12号交一次"]
)
async def test_explicit_recurring_payment_day_saves_without_user_forms(state, quote):
    store, conversation = state
    message = source(store, conversation, quote)
    receipt = await tool(store, conversation, message).ainvoke(
        {**arguments(12), "date_evidence": quote}
    )
    assert receipt["commitments"][0]["due_day"] == 12
    assert (
        FinanceService(store).summary(month="2026-04")["commitments"]["items"][0]["next_due_on"]
        == "2026-06-12"
    )


async def test_same_confirmed_day_needs_no_new_quote_and_older_replay_stays_idempotent(state):
    store, conversation = state
    service = FinanceService(store)
    service.patch_budget(
        month="2026-04", idempotency_key="manual", changes=arguments(12)["changes"]
    )
    message = source(store, conversation, "把这份付款安排的金额保持为3600")
    available = tool(store, conversation, message)
    args = arguments(12, "unchanged-day")
    first = await available.ainvoke(args)
    service.patch_budget(
        month="2026-04", idempotency_key="manual-new-day", changes=arguments(15)["changes"]
    )
    assert await available.ainvoke(args) == first
    assert service.get_budget("2026-04")["commitments"][0]["due_day"] == 15
    with pytest.raises(StoreError):
        await available.ainvoke(arguments(11, "unsupported-new-day"))


async def test_rule_quote_must_be_real_user_statement_for_the_same_cost(state):
    store, conversation = state
    message = source(store, conversation, "房租统一按12日支付，通勤日还没定")
    available = tool(store, conversation, message)
    with pytest.raises(StoreError):
        await available.ainvoke(
            {
                **arguments(12),
                "date_evidence": "房租统一按12日支付",
                "date_source_message_id": "invented",
            }
        )
    changed = arguments(12)
    changed["changes"]["commitments_upsert"][0].update(key="commute", label="通勤")
    with pytest.raises(StoreError):
        await available.ainvoke({**changed, "date_evidence": "房租统一按12日支付"})


async def test_recurring_rule_quote_preserves_spaces_and_does_not_use_wages_day_for_rent(state):
    store, conversation = state
    message = source(
        store, conversation, "房租支付统一按 7 日计算，然后采用季度付款。工资每月20日到账。"
    )
    available = tool(store, conversation, message)
    receipt = await available.ainvoke({**arguments(7), "date_evidence": "房租支付统一按 7 日计算"})
    assert receipt["commitments"][0]["due_day"] == 7
    with pytest.raises(StoreError):
        await available.ainvoke(
            {**arguments(20, "not-wages-day"), "date_evidence": "工资每月20日到账"}
        )
    other = source(store, conversation, "房租每月7日、工资每月20日到账")
    with pytest.raises(StoreError):
        await tool(store, conversation, other).ainvoke(
            {**arguments(20, "mixed-rule"), "date_evidence": "房租每月7日、工资每月20日到账"}
        )
