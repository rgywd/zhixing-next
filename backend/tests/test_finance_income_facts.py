"""Known withdrawal text cannot become invented contribution income via labels."""

from uuid import uuid4

import pytest
from test_runtime import make_settings

from zhixing_next.finance_context import active_finance_input
from zhixing_next.finance_service import FinanceService
from zhixing_next.finance_tools import create_finance_service_tools
from zhixing_next.store import Store, StoreError


@pytest.fixture
def state(tmp_path):
    store = Store(make_settings(tmp_path))
    conversation = store.create_conversation("来源事实", agent_id="finance")["id"]
    return store, conversation


def user(store, conversation, text, role="user"):
    identifier = str(uuid4())
    with store._connection(write=True) as db:
        db.execute(
            "INSERT INTO messages(id,conversation_id,role,content,intent,status,created_at) VALUES(?,?,?,?, 'queue','applied','2026-04-09T07:00:00+00:00')",
            (identifier, conversation, role, text),
        )
    return identifier


def tools(store, conversation, source):
    return {
        item.name: item
        for item in create_finance_service_tools(store.settings, conversation, source)
    }


def fields(**changes):
    return {
        "entry_key": "income",
        "kind": "income",
        "amount": "600",
        "category": "公积金新缴存",
        "date_precision": "range",
        "date_start": "2026-03-01",
        "date_end": "2026-04-09",
        **changes,
    }


def review_text():
    return "3月1日算上公积金有20000，到现在发了两个月工资加公积金提取，工资到账数额是6200，公积金是300，各自乘2。手机900。加上未提取的公积金现在26000。"


@pytest.mark.parametrize("category", ["公积金新缴存", "工资", "其他", "新收入"])
@pytest.mark.parametrize("note", ["", "用户确认新增缴存"])
async def test_original_withdrawals_cannot_be_laundered_by_empty_note_or_different_label(
    state, category, note
):
    store, conversation = state
    source = user(store, conversation, review_text())
    with pytest.raises(StoreError) as error:
        await tools(store, conversation, source)["record_finance_transaction"].ainvoke(
            fields(category=category, note=note)
        )
    assert error.value.code == "existing_asset_is_transfer"
    assert "未保存" in str(error.value) and "kind=transfer" in str(error.value)
    assert "不要通过删除备注" in str(error.value) and "也不要索要" in str(error.value)
    assert FinanceService(store).list_transactions(month="2026-04")["total"] == 0


@pytest.mark.parametrize("amount", ["6200", "12400"])
async def test_same_source_salary_and_explicit_multiplier_are_real_income(state, amount):
    store, conversation = state
    source = user(store, conversation, review_text())
    row = await tools(store, conversation, source)["record_finance_transaction"].ainvoke(
        fields(category="工资", amount=amount)
    )
    assert row["kind"] == "income"
    assert row["income_fact_verification"]["amount"] == f"{amount}.00"


@pytest.mark.parametrize(
    "amount,category",
    [
        ("20000", "工资"),
        ("26000", "工资"),
        ("900", "工资"),
        ("6200", "公积金缴存"),
        ("300", "公积金缴存"),
    ],
)
async def test_no_borrowed_asset_purchase_or_other_subject_amount_authorizes_contribution(
    state, amount, category
):
    store, conversation = state
    source = user(store, conversation, review_text())
    with pytest.raises(StoreError):
        await tools(store, conversation, source)["record_finance_transaction"].ainvoke(
            fields(amount=amount, category=category)
        )


@pytest.mark.parametrize(
    "text",
    [
        "单位新增缴存公积金200元，另提取已有公积金100元。",
        "单位新缴存公积金200元，同时提取原有100元。",
        "公积金新缴存200元并提取100元。",
        "公积金新缴存200元、提取100元，工资700元。",
    ],
)
async def test_explicit_new_contribution_and_withdrawal_are_separate_real_flows(state, text):
    store, conversation = state
    source = user(store, conversation, text)
    available = tools(store, conversation, source)
    income = await available["record_finance_transaction"].ainvoke(fields(amount="200"))
    transfer = await available["record_finance_transaction"].ainvoke(
        fields(entry_key="transfer", kind="transfer", category="公积金提取", amount="100")
    )
    assert income["kind"] == "income" and transfer["kind"] == "transfer"
    with pytest.raises(StoreError):
        await available["record_finance_transaction"].ainvoke(
            fields(entry_key="wrong", amount="100")
        )


@pytest.mark.parametrize(
    "text",
    [
        "没有新增缴存200元，只是提取公积金100元。",
        "没新增缴存200元，只是提取公积金100元。",
        "从未新增缴存200元，只是提取公积金100元。",
        "计划新增缴存200元，已经提取公积金100元。",
        "如果新增缴存200元，另外提取公积金100元。",
    ],
)
async def test_cropping_negation_or_plan_does_not_create_a_positive_fact(state, text):
    store, conversation = state
    source = user(store, conversation, text)
    with pytest.raises(StoreError):
        await tools(store, conversation, source)["record_finance_transaction"].ainvoke(
            fields(amount="200", fact_evidence="新增缴存200元")
        )


async def test_correction_uses_original_source_and_can_reference_actual_historical_correction(
    state,
):
    store, conversation = state
    original = user(store, conversation, "期间提取公积金200元。")
    available = tools(store, conversation, original)
    row = await available["record_finance_transaction"].ainvoke(
        fields(kind="transfer", category="公积金提取", amount="200")
    )
    current = user(store, conversation, "整理上笔记录")
    token = active_finance_input.set(current)
    args = {
        "transaction_id": row["id"],
        "entry_key": "correction",
        "changes": {"kind": "income", "category": "其他", "note": ""},
    }
    try:
        with pytest.raises(StoreError):
            await available["correct_finance_transaction"].ainvoke(args)
        historical = user(store, conversation, "之前记错了，实际是单位新增缴存公积金200元。")
        corrected = await available["correct_finance_transaction"].ainvoke(
            {
                **args,
                "fact_source_message_id": historical,
                "fact_evidence": "实际是单位新增缴存公积金200元",
            }
        )
    finally:
        active_finance_input.reset(token)
    assert corrected["kind"] == "income"
    assert corrected["income_fact_verification"]["source_message_id"] == historical


async def test_fake_or_assistant_fact_quote_cannot_authorize_income(state):
    store, conversation = state
    original = user(store, conversation, "提取公积金200元。")
    assistant = user(store, conversation, "新增缴存公积金200元", role="assistant")
    available = tools(store, conversation, original)
    for source, quote in [(original, "新增缴存公积金200元"), (assistant, "新增缴存公积金200元")]:
        with pytest.raises(StoreError):
            await available["record_finance_transaction"].ainvoke(
                fields(amount="200", fact_source_message_id=source, fact_evidence=quote)
            )


async def test_explicit_correction_reuses_known_amount_without_requiring_user_to_repeat_it(state):
    store, conversation = state
    original = user(store, conversation, "期间提取公积金200元。")
    available = tools(store, conversation, original)
    row = await available["record_finance_transaction"].ainvoke(
        fields(kind="transfer", category="公积金提取", amount="200")
    )
    current = user(store, conversation, "这笔实际是单位新缴存公积金，不是提取。")
    token = active_finance_input.set(current)
    try:
        corrected = await available["correct_finance_transaction"].ainvoke(
            {
                "transaction_id": row["id"],
                "entry_key": "actual-nature",
                "changes": {"kind": "income", "category": "公积金新缴存", "note": ""},
            }
        )
        assert corrected["amount"] == "200.00"
        # Where the known withdrawal activates the guard, a nature-only
        # correction cannot authorize an extra record without an amount.
        original_token = active_finance_input.set(original)
        try:
            with pytest.raises(StoreError):
                await available["record_finance_transaction"].ainvoke(
                    fields(amount="200", fact_source_message_id=current)
                )
        finally:
            active_finance_input.reset(original_token)
        with pytest.raises(StoreError):
            await available["correct_finance_transaction"].ainvoke(
                {
                    "transaction_id": row["id"],
                    "entry_key": "changed-money",
                    "changes": {"amount": "300"},
                }
            )
    finally:
        active_finance_input.reset(token)


@pytest.mark.parametrize("operation", ["create", "update"])
async def test_batch_validates_income_facts_before_any_write(state, operation):
    store, conversation = state
    source = user(store, conversation, "期间提取公积金200元。")
    available = tools(store, conversation, source)
    original = await available["record_finance_transaction"].ainvoke(
        fields(kind="transfer", category="公积金提取", amount="200")
    )
    bad = {
        "operation": operation,
        "fields": {
            key: value
            for key, value in fields(amount="200", category="其他").items()
            if key != "entry_key"
        },
    }
    if operation == "update":
        bad["transaction_id"] = original["id"]
    with pytest.raises(StoreError):
        await available["apply_finance_transaction_batch"].ainvoke(
            {
                "entry_key": "batch",
                "operations": [
                    {
                        "operation": "create",
                        "fields": {
                            key: value
                            for key, value in fields(kind="transfer", amount="50").items()
                            if key != "entry_key"
                        },
                    },
                    bad,
                ],
                "conserve_total": False,
                "reason": "整理用户金额",
            }
        )
    actual = FinanceService(store).list_transactions(month="2026-04")["items"]
    assert (
        len(actual) == 1 and actual[0]["id"] == original["id"] and actual[0]["kind"] == "transfer"
    )


async def test_attachment_without_explicit_withdrawal_text_keeps_existing_flow_and_http_compatibility(
    state,
):
    store, conversation = state
    source = user(store, conversation, "记录附件中的公积金缴存。")
    row = await tools(store, conversation, source)["record_finance_transaction"].ainvoke(
        fields(amount="200")
    )
    assert row["kind"] == "income" and row["income_fact_verification"] is None
    withdrawal_source = user(store, conversation, "提取公积金200元")
    # Manual HTTP/service input remains the user's explicit edit, as before.
    manual = FinanceService(store).create_transaction(
        idempotency_key="manual",
        source_id=withdrawal_source,
        **{key: value for key, value in fields(amount="200").items() if key != "entry_key"},
    )
    assert manual["kind"] == "income"
