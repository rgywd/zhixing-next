"""Common redundant model hints cannot block otherwise unambiguous operations."""

from uuid import uuid4

from test_finance_report_publication import fixture, ledger, publisher
from test_runtime import make_settings

from zhixing_next.finance_service import FinanceService
from zhixing_next.finance_tools import create_finance_service_tools
from zhixing_next.store import Store


def tools(tmp_path, text):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("格式兼容", agent_id="finance")["id"]
    source = str(uuid4())
    store.submit_message(conversation, id=source, content=text)
    return store, {tool.name: tool for tool in create_finance_service_tools(settings, conversation, source)}


async def test_range_precision_normalizes_redundant_day_and_item_label_on_retry(tmp_path):
    store, available = tools(tmp_path, "4月1日到4月9日期间买过书18元")
    args = {
        "entry_key": "new-purchases", "conserve_total": False, "reason": "记录明确新增消费",
        "operations": [{"operation": "create", "entry_key": "book", "fields": {
            "kind": "expense", "amount": "18", "category": "图书", "date_precision": "range",
            "date_start": "2026-04-01", "date_end": "2026-04-09", "occurred_on": "2026-04-01",
        }}],
    }
    first = await available["apply_finance_transaction_batch"].ainvoke(args)
    args["operations"][0]["entry_key"] = "another-redundant-label"
    args["operations"][0]["fields"]["occurred_on"] = "2026-04-02"
    assert await available["apply_finance_transaction_batch"].ainvoke(args) == first
    rows = FinanceService(store).list_transactions(month="2026-04")["items"]
    assert len(rows) == 1
    assert (rows[0]["date_precision"], rows[0]["date_start"], rows[0]["date_end"], rows[0]["occurred_on"]) == (
        "range", "2026-04-01", "2026-04-09", "2026-04-09",
    )


async def test_monthly_cost_is_derived_instead_of_requiring_model_arithmetic(tmp_path):
    store, available = tools(tmp_path, "三月起每3个月交房租4000元")
    args = {"entry_key": "budget", "month": "2026-03", "changes": {"commitments_upsert": [{
        "key": "rent", "label": "房租", "kind": "fixed", "amount": "4000",
        "every_months": 3, "anchor_month": "2026-03", "monthly_cost": "1300",
    }]}}
    first = await available["update_finance_budget"].ainvoke(args)
    args["changes"]["commitments_upsert"][0]["monthly_cost"] = "1333.33"
    assert await available["update_finance_budget"].ainvoke(args) == first
    commitment = FinanceService(store).get_budget("2026-03")["commitments"][0]
    assert commitment["amount"] == "4000.00"
    assert commitment["monthly_cost"] == "1333.33"


async def test_history_range_is_canonical_for_record_correct_and_atomic_batch(tmp_path):
    store, available = tools(tmp_path, "8月5日到10月15日期间回顾，公积金提取两次合计4000元，房租覆盖九月到十一月")
    args = {"entry_key": "withdrawals", "kind": "transfer", "amount": "4000",
            "category": "公积金提取", "date_precision": "range",
            "date_start": "2026-09-01", "date_end": "2026-10-15"}
    first = await available["record_finance_transaction"].ainvoke(args)
    assert first["date_start"] == "2026-08-05"
    args["date_start"] = "2026-08-05"
    assert await available["record_finance_transaction"].ainvoke(args) == first
    corrected = await available["correct_finance_transaction"].ainvoke({
        "transaction_id": first["id"], "entry_key": "keep-real-period",
        "changes": {"date_precision": "range", "date_start": "2026-09-01", "date_end": "2026-10-15"},
    })
    assert corrected["date_start"] == "2026-08-05"
    await available["apply_finance_transaction_batch"].ainvoke({
        "entry_key": "keep-real-period-batch", "operations": [{
            "operation": "update", "transaction_id": first["id"],
            "fields": {"date_precision": "range", "date_start": "2026-09-01", "date_end": "2026-10-15"},
        }],
    })
    rows = FinanceService(store).list_transactions(month="2026-10")["items"]
    assert len(rows) == 1 and rows[0]["date_start"] == "2026-08-05"


async def test_report_accepts_redundant_entry_labels_without_duplicating_artifacts(tmp_path):
    settings, store, _, run, args = fixture(tmp_path)
    events = []
    tool = publisher(settings, store, run, events)
    before = ledger(store)
    first = await tool.ainvoke({**args, "entry_key": "report-one"})
    second = await tool.ainvoke({**args, "entry_key": "report-two"})
    assert first == second
    assert ledger(store) == before
    assert len([event for event in events if event[0] == "artifact"]) == 1
