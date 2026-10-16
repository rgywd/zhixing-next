"""AI dates cite real user event statements; observations never date purchases."""

from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from test_runtime import ScriptedModel, ignore, make_settings, no_controls

from zhixing_next.finance_service import FinanceService
from zhixing_next.finance_tools import create_finance_service_tools
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store, StoreError


@pytest.fixture
def setup(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("日期来源", agent_id="finance")["id"]
    return store, conversation


def user(store, conversation, content, *, role="user", created_at="2026-04-09T07:00:00+00:00"):
    identifier = str(uuid4())
    with store._connection(write=True) as db:
        db.execute(
            "INSERT INTO messages(id,conversation_id,role,content,intent,status,created_at) VALUES(?,?,?,?,'queue','applied',?)",
            (identifier, conversation, role, content, created_at),
        )
    return identifier


def tools(store, conversation, source):
    return {
        item.name: item
        for item in create_finance_service_tools(store.settings, conversation, source)
    }


def fields(**kwargs):
    return {
        "entry_key": "expense",
        "kind": "expense",
        "amount": "32",
        "occurred_on": "2026-04-09",
        "category": "午饭",
        **kwargs,
    }


@pytest.mark.parametrize(
    "quote",
    [
        "今天午饭32元",
        "今日午饭32元",
        "4月9日付了午饭32元",
        "四月九号吃午饭32元",
        "4.09付了午饭32元",
        "2026-04-09午饭32元",
    ],
)
async def test_explicit_actual_event_date_works_naturally(setup, quote):
    store, conversation = setup
    source = user(store, conversation, quote)
    result = await tools(store, conversation, source)["record_finance_transaction"].ainvoke(
        fields(date_evidence=quote)
    )
    assert result["occurred_on"] == "2026-04-09"
    assert result["date_verification"]["source_message_id"] == source


@pytest.mark.parametrize(
    "quote",
    [
        "午饭4.09元",
        "花了4.09",
        "目前资产4月9日有6000",
        "4月9日余额6000",
        "每月4月9日支付房租",
        "4月9日计划买手机",
        "4月9日覆盖的房租",
        "4月9日没有买手机",
    ],
)
async def test_amount_observation_schedule_coverage_or_negation_is_not_event_day(setup, quote):
    store, conversation = setup
    source = user(store, conversation, quote)
    with pytest.raises(StoreError) as error:
        await tools(store, conversation, source)["record_finance_transaction"].ainvoke(
            fields(date_evidence=quote)
        )
    assert error.value.code == "unverified_finance_date"
    assert "date_precision=range" in str(error.value)
    assert FinanceService(store).list_transactions(month="2026-04")["total"] == 0


async def test_historical_review_does_not_assign_its_asset_dates_to_purchases(setup):
    store, conversation = setup
    content = "3月2日的时候资产有6000，到现在发了两笔工资，手里还有7000。大件有手机1200和电脑2300。"
    source = user(store, conversation, content)
    tool = tools(store, conversation, source)["record_finance_transaction"]
    for quote in (None, "3月2日的时候资产有6000", content, "今天买了手机1200"):
        with pytest.raises(StoreError):
            await tool.ainvoke(fields(category="手机", date_evidence=quote))
    result = await tool.ainvoke(
        fields(
            category="手机",
            occurred_on=None,
            date_precision="range",
            date_start="2026-03-02",
            date_end="2026-04-09",
        )
    )
    assert result["date_precision"] == "range" and result["date_verification"] is None
    assert FinanceService(store).summary(month="2026-04")["unallocated"]["count"] == 1


async def test_same_day_range_cannot_bypass_evidence(setup):
    store, conversation = setup
    source = user(store, conversation, "昨天买的手机，价钱1200")
    with pytest.raises(StoreError):
        await tools(store, conversation, source)["record_finance_transaction"].ainvoke(
            fields(
                date_precision="range",
                date_start="2026-04-09",
                date_end="2026-04-09",
                date_evidence="昨天买的手机",
            )
        )


async def test_quote_must_be_verbatim_user_source_and_can_reference_history(setup):
    store, conversation = setup
    historical = user(store, conversation, "4月9日付了房租900元")
    current = user(store, conversation, "请整理前面房租记录")
    available = tools(store, conversation, current)
    result = await available["record_finance_transaction"].ainvoke(
        fields(
            category="房租", date_evidence="4月9日付了房租900元", date_source_message_id=historical
        )
    )
    assert result["date_verification"]["source_message_id"] == historical
    assistant = user(store, conversation, "4月9日买手机1200元", role="assistant")
    for source_id in (assistant, "nonexistent"):
        with pytest.raises(StoreError):
            await available["record_finance_transaction"].ainvoke(
                fields(
                    entry_key=source_id,
                    category="手机",
                    date_evidence="4月9日买手机1200元",
                    date_source_message_id=source_id,
                )
            )
    with pytest.raises(StoreError, match="different transaction subject"):
        await available["record_finance_transaction"].ainvoke(
            fields(
                entry_key="wrong-subject",
                category="手机",
                date_evidence="4月9日付了房租900元",
                date_source_message_id=historical,
            )
        )


async def test_relative_date_is_bound_to_original_message_clock_not_replay_clock(setup):
    store, conversation = setup
    source = user(
        store, conversation, "昨天午饭32元", created_at="2026-04-09T16:10:00+00:00"
    )  # Shanghai Apr 10
    result = await tools(store, conversation, source)["record_finance_transaction"].ainvoke(
        fields(date_evidence="昨天午饭32元")
    )
    assert result["date_verification"]["message_business_date"] == "2026-04-10"
    assert result["occurred_on"] == "2026-04-09"


async def test_range_to_day_correction_needs_actual_event_quote_but_amount_change_does_not(setup):
    store, conversation = setup
    service = FinanceService(store)
    original = service.create_transaction(
        idempotency_key="historical",
        kind="expense",
        amount="900",
        date_precision="range",
        date_start="2026-03-01",
        date_end="2026-04-09",
        category="房租",
    )
    source = user(store, conversation, "房租每月九号交，这次四月九交的")
    available = tools(store, conversation, source)
    args = {
        "transaction_id": original["id"],
        "entry_key": "actual-date",
        "changes": {"occurred_on": "2026-04-09"},
    }
    with pytest.raises(StoreError):
        await available["correct_finance_transaction"].ainvoke(args)
    corrected = await available["correct_finance_transaction"].ainvoke(
        {**args, "date_evidence": "这次四月九交的"}
    )
    assert corrected["date_precision"] == "day"
    assert (
        await available["correct_finance_transaction"].ainvoke(
            {"transaction_id": original["id"], "entry_key": "amount", "changes": {"amount": "950"}}
        )
    )["amount"] == "950.00"


async def test_batch_checks_all_precise_dates_before_any_write_and_strips_proof_fields(setup):
    store, conversation = setup
    source = user(store, conversation, "今天午饭32元。手机具体哪天买的不清楚")
    tool = tools(store, conversation, source)["apply_finance_transaction_batch"]
    operations = [
        {
            "operation": "create",
            "fields": {key: value for key, value in fields().items() if key != "entry_key"},
            "date_evidence": "今天午饭32元",
        },
        {
            "operation": "create",
            "fields": {
                "kind": "expense",
                "amount": "1200",
                "occurred_on": "2026-04-09",
                "category": "手机",
            },
        },
    ]
    with pytest.raises(StoreError):
        await tool.ainvoke({"entry_key": "batch", "operations": operations})
    assert FinanceService(store).list_transactions(month="2026-04")["total"] == 0
    operations[1]["fields"].update(
        occurred_on=None, date_precision="range", date_start="2026-03-01", date_end="2026-04-09"
    )
    result = await tool.ainvoke({"entry_key": "batch", "operations": operations})
    assert len(result["items"]) == 2
    assert result["date_verifications"][0]["basis"] == "user_stated_event_date"


async def test_actual_graph_rejects_invented_purchase_day_then_keeps_historical_range(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("历史回顾", agent_id="finance")["id"]
    source = "3月2日资产6000，现在资产7000，大件手机1200，购买日期没有说明。"
    store.submit_message(conversation, id="historical-input", content=source)
    run = store.claim_next("chat")
    run["agent"] = store.get_agent("finance")

    def call(args, identifier):
        return AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "record_finance_transaction",
                    "args": args,
                    "id": identifier,
                    "type": "tool_call",
                }
            ],
        )

    model = ScriptedModel(
        replies=[
            call(fields(category="手机", date_evidence="3月2日资产6000"), "invented-day"),
            call(
                fields(
                    category="手机",
                    occurred_on=None,
                    date_precision="range",
                    date_start="2026-03-02",
                    date_end="2026-04-09",
                ),
                "preserved-range",
            ),
            AIMessage(content="已保留原范围。"),
        ]
    )
    await run_agent(
        settings,
        run,
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    error = next(
        message
        for message in model.seen[-1]
        if isinstance(message, ToolMessage) and message.tool_call_id == "invented-day"
    )
    assert (
        error.status == "error"
        and "unverified_finance_date" in error.content
        and "not invent a day" in error.content
    )
    rows = FinanceService(store).list_transactions(month="2026-04")["items"]
    assert len(rows) == 1 and rows[0]["date_precision"] == "range"


@pytest.mark.parametrize(
    "quote,target", [("去年3月买了手机", "2025-03"), ("2024年3月买了手机", "2024-03")]
)
async def test_month_precision_honors_explicit_year_and_last_year(setup, quote, target):
    store, conversation = setup
    source = user(store, conversation, quote)
    tool = tools(store, conversation, source)["record_finance_transaction"]
    with pytest.raises(StoreError):
        await tool.ainvoke(
            fields(
                category="手机",
                occurred_on=None,
                date_precision="month",
                date_start="2026-03",
                date_evidence=quote,
            )
        )
    result = await tool.ainvoke(
        fields(
            category="手机",
            occurred_on=None,
            date_precision="month",
            date_start=target,
            date_evidence=quote,
        )
    )
    assert result["date_start"][:7] == target


@pytest.mark.parametrize(
    "content,quote",
    [
        ("计划2026-04-09买手机", "2026-04-09买手机"),
        ("不是2026-04-09买的手机", "2026-04-09买的手机"),
        ("2026-04-09手机估值1200元", "2026-04-09手机估值1200元"),
    ],
)
async def test_quote_cannot_crop_away_original_plan_negation_or_valuation(setup, content, quote):
    store, conversation = setup
    source = user(store, conversation, content)
    with pytest.raises(StoreError):
        await tools(store, conversation, source)["record_finance_transaction"].ainvoke(
            fields(category="手机", date_evidence=quote)
        )


async def test_same_source_different_transaction_day_cannot_be_reused(setup):
    store, conversation = setup
    source = user(store, conversation, "4月9日交房租；手机不知道哪天买的")
    with pytest.raises(StoreError):
        await tools(store, conversation, source)["record_finance_transaction"].ainvoke(
            fields(category="手机", date_evidence="4月9日交房租")
        )


async def test_partial_range_end_correction_does_not_become_false_single_day(setup):
    store, conversation = setup
    service = FinanceService(store)
    original = service.create_transaction(
        idempotency_key="history",
        kind="expense",
        amount="100",
        date_precision="range",
        date_start="2026-03-01",
        date_end="2026-04-08",
    )
    source = user(store, conversation, "回顾区间截止到4月9日，不知道具体购买日")
    result = await tools(store, conversation, source)["correct_finance_transaction"].ainvoke(
        {
            "transaction_id": original["id"],
            "entry_key": "extend-range",
            "changes": {"date_end": "2026-04-09"},
        }
    )
    assert result["date_precision"] == "range" and result["date_start"] == "2026-03-01"
    assert result["date_end"] == result["occurred_on"] == "2026-04-09"


@pytest.mark.parametrize("agent_id", [None, "finance"])
async def test_actual_graph_main_and_finance_share_readonly_asset_reconciliation(
    tmp_path, agent_id
):
    import json

    from zhixing_next.operations import Journal

    settings = make_settings(tmp_path)
    store = Store(settings)
    service = FinanceService(store)
    for key, kind, amount in [
        ("salary", "income", "4800"),
        ("purchase", "expense", "1700"),
        ("withdrawal", "transfer", "100"),
    ]:
        service.create_transaction(
            idempotency_key=key,
            kind=kind,
            amount=amount,
            date_precision="range",
            date_start="2026-03-01",
            date_end="2026-04-09",
        )
    conversation = store.create_conversation("资产核对", agent_id=agent_id)["id"]
    store.submit_message(
        conversation, id="assets", content="核对3月1日到4月9日，资产从6000到8000。"
    )
    run = store.claim_next("chat")
    if agent_id:
        run["agent"] = store.get_agent(agent_id)
    else:
        run["agents"] = store.list_agents()["items"]
    model = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "reconcile_finance_assets",
                        "id": "reconcile",
                        "type": "tool_call",
                        "args": {
                            "start_date": "2026-03-01",
                            "end_date": "2026-04-09",
                            "opening_assets": "6000",
                            "closing_assets": "8000",
                        },
                    }
                ],
            ),
            AIMessage(content="按程序返回的已知流水口径核对，不把内部转账重复计入。"),
        ]
    )
    await run_agent(
        settings,
        run,
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    receipt = next(
        message
        for message in model.seen[-1]
        if isinstance(message, ToolMessage) and message.tool_call_id == "reconcile"
    )
    assert receipt.status == "success"
    result = json.loads(receipt.content)
    assert result["scope"] == "known_flows_only" and result["read_only"]
    assert result["flows"]["income"] == "4800.00" and result["flows"]["transfer"] == "100.00"
    assert result["calculation"]["expected_closing"] == "9100.00"
    assert result["calculation"]["unexplained_difference"] == "1100.00"
    assert "+ 100.00" not in result["calculation"]["formula"]
    assert result["flows"]["transfer_excluded_from_asset_change"]
    assert Journal(settings).approvals()["items"] == []
