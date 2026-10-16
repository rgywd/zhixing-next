"""Assistant consultations stay historical data, never future user evidence."""

import json
from uuid import uuid4

import pytest
from langchain_core.messages import HumanMessage
from test_runtime import make_settings

from zhixing_next.finance_context import delegated_finance_input
from zhixing_next.finance_dates import (
    normalize_history_range,
    verify_budget_due_days,
    verify_date_evidence,
)
from zhixing_next.finance_report_context import resolve_finance_report_context
from zhixing_next.finance_service import FinanceService
from zhixing_next.retrieval import create_retrieval_tools
from zhixing_next.runtime import _finance_source, _seen_finance_input
from zhixing_next.store import Store, StoreError


@pytest.fixture
def state(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("Finance evidence", agent_id="finance")["id"]
    return settings, store, conversation


def source(store, conversation, content, *, origin=None, run_id=None):
    identifier = str(uuid4())
    request = None if origin is None else json.dumps({"intent": "queue", "origin": origin})
    with store._connection(write=True) as db:
        db.execute("INSERT INTO messages(id,conversation_id,role,content,intent,run_id,status,created_at,request_json) VALUES(?,?,'user',?,'queue',?,'applied','2026-04-09T07:00:00+00:00',?)", (identifier, conversation, content, run_id, request))
    return identifier


def verify_day(store, conversation, current, evidence_id):
    return verify_date_evidence(store, conversation_id=conversation, source_id=current, fields={"occurred_on": "2026-04-08", "category": "午餐"}, evidence="2026年4月8日午餐32元", evidence_source_id=evidence_id)


def verify_rule(store, current, evidence_id):
    return verify_budget_due_days(FinanceService(store), month="2026-04", changes={"commitments_upsert": [{"key": "rent", "label": "房租", "kind": "fixed", "amount": "1200", "due_day": 12}]}, source_id=current, evidence="房租统一按12日支付", evidence_source_id=evidence_id)


def test_future_user_turn_cannot_quote_internal_message_as_transaction_date(state):
    _, store, conversation = state
    forwarded = source(store, conversation, "2026年4月8日午餐32元", origin="agent_message")
    actual = source(store, conversation, "帮我整理历史记录")
    with pytest.raises(StoreError) as error:
        verify_day(store, conversation, actual, forwarded)
    assert error.value.code == "unverified_finance_date"


def test_future_user_turn_cannot_quote_internal_message_as_recurring_rule(state):
    _, store, conversation = state
    forwarded = source(store, conversation, "房租统一按12日支付", origin="agent_message")
    actual = source(store, conversation, "整理付款安排")
    with pytest.raises(StoreError) as error:
        verify_rule(store, actual, forwarded)
    assert error.value.code == "unverified_budget_due_day"


def test_internal_message_cannot_authorize_finance_report_scope(state):
    settings, store, conversation = state
    forwarded = source(store, conversation, "给我4月报告", origin="agent_message")
    fields, receipt = resolve_finance_report_context(settings, store, conversation_id=conversation, source_id=forwarded, requested={"start_date": "2026-03-01", "end_date": "2026-03-31", "opening_assets": None, "closing_assets": None, "approximate": True}, period_evidence="给我4月报告")
    assert fields["start_date"] == "2026-03-01"
    assert fields["end_date"] == "2026-03-31"
    assert receipt["basis"] == "provided_period"


def test_runtime_does_not_bind_or_fallback_to_forwarded_input(state):
    settings, store, conversation = state
    store.submit_message(conversation, id="internal-current", content="房租统一按12日支付")
    run = store.claim_next("chat")
    with store._connection(write=True) as db:
        db.execute("UPDATE messages SET request_json=? WHERE id=?", (json.dumps({"origin": "agent_message"}), run["message_id"]))
    messages = [HumanMessage(content=run["prompt"], id=run["message_id"])]
    assert _seen_finance_input(store, run["id"], messages) is None
    token = delegated_finance_input.set(run["message_id"])
    try:
        assert _seen_finance_input(store, run["id"], []) is None
    finally:
        delegated_finance_input.reset(token)
    assert _finance_source(settings, run["id"], []) is None


@pytest.mark.parametrize("origin", [None, "user"])
def test_actual_user_and_legacy_null_sources_keep_date_and_rule_authority(state, origin):
    settings, store, conversation = state
    message = source(store, conversation, "2026年4月8日午餐32元，房租统一按12日支付，给我4月报告", origin=origin)
    assert verify_day(store, conversation, message, message)["source_message_id"] == message
    assert verify_rule(store, message, message)
    requested, context = resolve_finance_report_context(settings, store, conversation_id=conversation, source_id=message, requested={"start_date": "2026-03-01", "end_date": "2026-03-31", "opening_assets": None, "closing_assets": None, "approximate": True}, period_evidence="给我4月报告")
    assert requested["start_date"] == "2026-04-01"
    assert context["basis"] == "current_user_period"


async def test_internal_message_remains_readable_as_historical_data(state):
    _, store, conversation = state
    forwarded = source(store, conversation, "咨询结论仅供参考", origin="agent_message")
    tools = {item.name: item for item in create_retrieval_tools(store)}
    result = await tools["read_history_message"].ainvoke({"message_id": forwarded})
    assert result["content"] == "咨询结论仅供参考"


@pytest.mark.parametrize("origin", [None, "user", "agent_message"])
def test_history_range_normalization_uses_only_real_user_span(state, origin):
    _, store, conversation = state
    message = source(store, conversation, "3月5日资产6000，到现在提取过两次公积金，共2000元", origin=origin)
    fields = {"date_precision": "range", "date_start": "2026-04-01", "date_end": "2026-04-09", "category": "公积金", "amount": "2000"}
    result = normalize_history_range(store, source_id=message, fields=fields)
    assert result["date_start"] == ("2026-04-01" if origin == "agent_message" else "2026-03-05")
    assert result["date_end"] == "2026-04-09"
