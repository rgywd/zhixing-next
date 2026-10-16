import json

from langchain_core.messages import AIMessage, ToolMessage
from test_runtime import ScriptedModel, ignore, make_settings, no_controls

from zhixing_next.finance_service import FinanceService
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store


def call(name, args, identifier):
    return AIMessage(
        content="", tool_calls=[{"name": name, "args": args, "id": identifier, "type": "tool_call"}]
    )


async def test_finance_schema_feedback_excludes_input_values_and_allows_model_correction(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("字段纠错", agent_id="finance")["id"]
    store.submit_message(conversation, id="input", content="2026年10月15日午餐32元")
    run = store.claim_next("chat")
    run["agent"] = store.get_agent("finance")
    arguments = {
        "entry_key": "lunch",
        "kind": "expense",
        "amount": "32",
        "occurred_on": "2026-10-15",
        "date_evidence": "2026年10月15日午餐32元",
    }
    model = ScriptedModel(
        replies=[
            call(
                "record_finance_transaction",
                {**arguments, "unknown_field": "SENSITIVE-INPUT-MUST-NOT-ECHO"},
                "invalid",
            ),
            call("record_finance_transaction", arguments, "corrected"),
            AIMessage(content="已记录32元午餐。"),
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
    message = next(
        item
        for item in model.seen[-1]
        if isinstance(item, ToolMessage) and item.tool_call_id == "invalid"
    )
    assert message.status == "error" and len(message.content) <= 2000
    error = json.loads(message.content)["error"]
    assert error["code"] == "invalid_finance_parameters"
    assert error["fields"][0]["field"] == "unknown_field"
    assert (
        "SENSITIVE-INPUT-MUST-NOT-ECHO" not in message.content
        and "input_value" not in message.content
    )
    assert FinanceService(store).summary(month="2026-10")["totals"]["expense"] == "32.00"


async def test_unexpected_host_file_exception_still_hides_internal_details(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("内部异常保护", agent_id="finance")["id"]
    store.submit_message(conversation, id="input", content="读附件")
    run = store.claim_next("chat")
    run["agent"] = store.get_agent("finance")

    def failed(*args, **kwargs):
        raise RuntimeError("SENSITIVE-HOST-PATH-OR-CREDENTIAL")

    monkeypatch.setattr("zhixing_next.tools.FileAccess.read_text", failed)
    model = ScriptedModel(
        replies=[
            call("read_text_file", {"path": "report.txt"}, "read"),
            AIMessage(content="文件读取失败。"),
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
    message = next(
        item
        for item in model.seen[-1]
        if isinstance(item, ToolMessage) and item.tool_call_id == "read"
    )
    assert message.status == "error" and "SENSITIVE-HOST" not in message.content
