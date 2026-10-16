"""Continuing a finance report preserves verified period and asset observations."""

import copy
from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage
from test_finance_report_publication import fixture, publisher
from test_runtime import ScriptedModel, ignore, no_controls

from zhixing_next.finance_context import active_finance_input
from zhixing_next.finance_report_context import latest_verified_report
from zhixing_next.resources import resource_bytes
from zhixing_next.runtime import run_agent
from zhixing_next.store import StoreError


async def first_report(tmp_path):
    settings, store, service, run, arguments = fixture(tmp_path)
    events = []
    receipt = await publisher(settings, store, run, events).ainvoke(arguments)
    store.finish_run(run["id"], "completed", "已交付")
    return settings, store, service, run, arguments, receipt


def follow(store, conversation, content):
    identifier = str(uuid4())
    store.submit_message(conversation, id=identifier, content=content)
    with store._connection(write=True) as db:
        db.execute(
            "UPDATE messages SET created_at='2026-04-10T07:00:00+00:00' WHERE id=?", (identifier,)
        )
    run = store.claim_next("chat")
    run["agent"] = store.get_agent("finance")
    return run


@pytest.mark.parametrize(
    "content",
    [
        "给我写个报告吧，等会儿再调整。",
        "生成报告并给今晚餐费预算建议。",
        "不要4月报告，继续整份回顾。",
    ],
)
async def test_followup_preserves_period_and_assets_despite_model_current_month_args(
    tmp_path, content
):
    settings, store, service, old_run, args, first = await first_report(tmp_path)
    run = follow(store, old_run["conversation_id"], content)
    service.create_transaction(
        idempotency_key="fresh", kind="expense", amount="10", occurred_on="2026-04-08"
    )
    events = []
    request = {"start_date": "2026-04-01", "end_date": "2026-04-30", "filename": "review.md"}
    tool = publisher(settings, store, run, events)
    receipt = await tool.ainvoke(request)
    facts = receipt["finance"]["facts"]
    assert facts["period"] == first["finance"]["facts"]["period"]
    assert facts["assets"] == first["finance"]["facts"]["assets"]
    assert facts["flows"]["income"] == "4800.00" and facts["flows"]["net_expense"] == "1710.00"
    assert facts["calculation"]["unexplained_difference"] == "1090.00"
    assert receipt["finance"]["context"]["inherited_resource_id"] == first["resource"]["id"]
    assert "2026-03-01 至 2026-04-09" in resource_bytes(settings, receipt["resource"]).decode()
    service.create_transaction(
        idempotency_key="later", kind="expense", amount="20", occurred_on="2026-04-08"
    )
    assert await publisher(settings, store, run, events).ainvoke(request) == receipt
    assert len(events) == 1


@pytest.mark.parametrize(
    "content", ["给我4月报告。", "报告只看4月。", "写一份2026年4月份的收支报告。"]
)
async def test_actual_new_month_can_narrow_report_without_carrying_old_assets(tmp_path, content):
    settings, store, service, old_run, args, first = await first_report(tmp_path)
    run = follow(store, old_run["conversation_id"], content)
    receipt = await publisher(settings, store, run, []).ainvoke(args)
    assert receipt["finance"]["facts"]["period"] == {
        "start_date": "2026-04-01",
        "end_date": "2026-04-30",
    }
    assert receipt["finance"]["facts"]["assets"] is None
    assert receipt["finance"]["context"]["basis"] == "current_user_period"


async def test_current_user_range_overrides_model_dates_and_must_be_real_quote(tmp_path):
    settings, store, service, old_run, args, first = await first_report(tmp_path)
    run = follow(store, old_run["conversation_id"], "报告改为3月2日至4月8日。今晚再聊。")
    tool = publisher(settings, store, run, [])
    receipt = await tool.ainvoke({**args, "period_evidence": "3月2日至4月8日"})
    assert receipt["finance"]["facts"]["period"] == {
        "start_date": "2026-03-02",
        "end_date": "2026-04-08",
    }
    for quote in ("4月报告", "今晚再聊"):
        with pytest.raises(StoreError) as error:
            await tool.ainvoke({**args, "period_evidence": quote})
        assert error.value.code == "unverified_finance_report_scope"


@pytest.mark.parametrize("asset_input", ["stale_pair", "closing_only", "omitted"])
async def test_new_current_balance_replaces_stale_value_and_dates_it_to_actual_source(
    tmp_path, asset_input
):
    settings, store, service, old_run, args, first = await first_report(tmp_path)
    run = follow(store, old_run["conversation_id"], "现在余额更新到8200，请重新出报告。")
    # The model still supplying the old pair must not erase the actual update.
    if asset_input == "closing_only":
        args = {"closing_assets": "8200"}
    elif asset_input == "omitted":
        args = {}
    receipt = await publisher(settings, store, run, []).ainvoke(args)
    facts = receipt["finance"]["facts"]
    assert facts["assets"]["opening"] == "6000.00" and facts["assets"]["closing"] == "8200.00"
    assert facts["period"] == {"start_date": "2026-03-01", "end_date": "2026-04-10"}
    assert facts["calculation"]["unexplained_difference"] == "900.00"


async def test_historical_asset_correction_keeps_original_observation_period(tmp_path):
    settings, store, service, old_run, args, first = await first_report(tmp_path)
    run = follow(
        store, old_run["conversation_id"], "期初资产更正为6500，期末资产更正为8300，再给我报告。"
    )
    receipt = await publisher(settings, store, run, []).ainvoke({})
    facts = receipt["finance"]["facts"]
    assert facts["assets"]["opening"] == "6500.00" and facts["assets"]["closing"] == "8300.00"
    assert facts["period"] == first["finance"]["facts"]["period"]


async def test_future_unseen_user_scope_and_single_account_balance_do_not_replace_context(tmp_path):
    settings, store, service, old_run, args, first = await first_report(tmp_path)
    run = follow(store, old_run["conversation_id"], "银行卡余额改成900，再给我报告。")
    future_id = str(uuid4())
    store.submit_message(
        run["conversation_id"],
        id=future_id,
        content="4月报告，现在总资产9800",
        intent="steer",
        target_run_id=run["id"],
    )
    token = active_finance_input.set(run["message_id"])
    try:
        receipt = await publisher(settings, store, run, []).ainvoke({})
    finally:
        active_finance_input.reset(token)
    assert receipt["finance"]["facts"]["period"] == first["finance"]["facts"]["period"]
    assert receipt["finance"]["facts"]["assets"] == first["finance"]["facts"]["assets"]


async def test_report_context_ignores_unverified_and_other_conversation_artifacts(tmp_path):
    settings, store, service, run, args, first = await first_report(tmp_path)
    fake = copy.deepcopy(first)
    fake["verification"]["sha256"] = "0" * 64
    fake["finance"]["facts"]["period"] = {"start_date": "2026-04-01", "end_date": "2026-04-30"}
    store.add_event(run["id"], "artifact", fake, allow_terminal=True)
    selected = latest_verified_report(settings, store, run["conversation_id"])
    assert selected["period"] == first["finance"]["facts"]["period"]
    other = store.create_conversation("另一份报表", agent_id="finance")["id"]
    assert latest_verified_report(settings, store, other) is None


async def test_first_report_can_default_to_known_ledger_without_user_date_form(tmp_path):
    settings, store, service, run, args = fixture(tmp_path)
    with store._connection(write=True) as db:
        db.execute("UPDATE messages SET content='生成财务报告' WHERE id=?", (run["message_id"],))
    receipt = await publisher(settings, store, run, []).ainvoke({})
    assert receipt["finance"]["facts"]["period"] == {
        "start_date": "2026-03-01",
        "end_date": "2026-04-09",
    }
    assert receipt["finance"]["context"]["basis"] == "known_ledger_period"


async def test_real_graph_continues_verified_scope_when_provider_sends_narrow_period(tmp_path):
    settings, store, service, old_run, args, first = await first_report(tmp_path)
    run = follow(store, old_run["conversation_id"], "继续生成报告，我今晚再调整。")
    model = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "publish_finance_report",
                        "id": "continue",
                        "type": "tool_call",
                        "args": {"start_date": "2026-04-01", "end_date": "2026-04-30"},
                    }
                ],
            )
        ]
    )

    async def emit(kind, data):
        store.add_event(run["id"], kind, data)

    result = await run_agent(
        settings,
        run,
        persona="",
        emit=emit,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    assert "2026-03-01 至 2026-04-09" in result and "4800.00" in result
    with store._connection() as db:
        assert (
            db.execute(
                "SELECT COUNT(*) FROM events WHERE run_id=? AND type='artifact'", (run["id"],)
            ).fetchone()[0]
            == 1
        )
