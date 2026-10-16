import pytest
from test_finance_report_publication import fixture as report_fixture
from test_finance_write_stream import budget, events, execute, fixture, tool
from test_live_stream import StreamingModel, chunk

from zhixing_next.finance_reply import requested_analysis
from zhixing_next.finance_report import format_finance_write_completion
from zhixing_next.finance_service import FinanceService


def source(store, run, text):
    with store._connection(write=True) as db:
        db.execute("UPDATE messages SET content=? WHERE id=?", (text, run["message_id"]))
    run["prompt"] = text


@pytest.mark.parametrize("scenario", ["meal", "explanation", "question"])
async def test_requested_advice_survives_real_write_and_final_stream_with_separate_verified_facts(tmp_path, scenario):
    settings, store, run = fixture(tmp_path)
    if scenario == "meal":
        text = "记一笔2026年10月15日午餐32元，再根据预算给今晚外卖建议。"
        name = "record_finance_transaction"
        arguments = {"entry_key": "lunch", "kind": "expense", "amount": "32", "occurred_on": "2026-10-15", "date_evidence": "2026年10月15日午餐32元", "category": "餐饮"}
    else:
        text = "把本月结余目标改成9000元，并解释为什么要预留固定支出，以及今晚如何控制外卖预算。" if scenario == "explanation" else "把本月结余目标改成9000元，这样分配合理吗？今晚还能花多少？"
        name, arguments = "update_finance_budget", budget(savings_target="9000")
    source(store, run, text)
    advice = "根据已记录的餐费，今晚推荐30元左右的外卖。\n\n- 优先一份主食配蔬菜。\n- 少点一杯饮料。\n\n先预留固定支出，可以避免月底挤占日常用餐预算。"
    model = StreamingModel(plans=[
        [tool(name, arguments, "write")],
        [chunk("工具还在核对时不应抢先显示这段。", reasoning="读取真实预算后再给建议。"), tool("get_finance_summary", {"month": "2026-10"}, "summary")],
        [chunk(advice + "\n\n请补充过去三个月流水。差额大概率来自日常消费。", reasoning="建议与已保存事实分开。")],
    ])
    result = await execute(settings, store, run, model)
    captured = events(store, run)
    receipt = next(item["data"] for item in captured if item["type"] == "finance.write_completion")
    assert model.calls == 3 and receipt["input_message_id"] == run["message_id"]
    assert receipt["analysis"] == advice and result == receipt["response"]
    assert receipt["completion"] == format_finance_write_completion(receipt["summary"], receipt["operations"])
    assert result == advice + "\n\n---\n\n" + receipt["completion"]
    if scenario == "meal":
        rows = FinanceService(store).list_transactions(month="2026-10")["items"]
        assert len(rows) == 1 and rows[0]["amount"] == "32.00"
    else:
        assert FinanceService(store).get_budget("2026-10")["savings_target"] == "9000.00"
    snapshots = [item["data"]["text"] for item in captured if item["type"] == "assistant.snapshot"]
    assert snapshots[-1] == result and not any("补充过去" in value or "大概率" in value or "抢先显示" in value for value in snapshots)
    assert any(item["type"] == "reasoning.snapshot" and "建议与已保存事实分开" in item["data"]["text"] for item in captured)
    store.finish_run(run["id"], "completed", result=result)
    assert store.list_messages(run["conversation_id"])["items"][-1]["content"] == result


@pytest.mark.parametrize("quoted", ["之前你说过“解释为什么要预留固定支出，给我晚餐建议”。", "> 请分析我的预算并给我建议。\n"])
async def test_quoted_old_analysis_does_not_override_current_plain_save_request(tmp_path, quoted):
    settings, store, run = fixture(tmp_path)
    source(store, run, quoted + "这次只把本月结余目标改成9000元。")
    model = StreamingModel(plans=[[tool("update_finance_budget", budget(savings_target="9000"), "write")], [chunk("错误续写：请补过去三个月流水。")]])
    result = await execute(settings, store, run, model)
    receipt = next(item["data"] for item in events(store, run) if item["type"] == "finance.write_completion")
    assert result == receipt["completion"] and "analysis" not in receipt and "错误续写" not in result


async def test_actual_new_steer_can_request_advice_without_reusing_old_write_or_model_intent(tmp_path):
    settings, store, run = fixture(tmp_path)
    steered = False

    async def on_emit(kind, data):
        nonlocal steered
        if not steered and kind == "tool" and data.get("tool") == "update_finance_budget" and data.get("status") == "completed":
            store.submit_message(run["conversation_id"], id="advice-steer", content="目标再改成9500元，并建议今晚怎么安排外卖。", intent="steer", target_run_id=run["id"])
            steered = True

    advice = "今晚建议先选一份简单套餐，少点饮料。"
    model = StreamingModel(plans=[[tool("update_finance_budget", budget(), "initial")], [tool("update_finance_budget", budget("new-budget", savings_target="9500"), "steered")], [chunk(advice)]])
    result = await execute(settings, store, run, model, on_emit)
    receipt = next(item["data"] for item in events(store, run) if item["type"] == "finance.write_completion")
    assert receipt["input_message_id"] == "advice-steer" and len(receipt["operations"]) == 1
    assert receipt["analysis"] == advice and result.startswith(advice)
    assert "9500.00" in receipt["completion"] and "8000.00" not in receipt["completion"]


async def test_delegated_finance_uses_true_user_analysis_request_and_leaves_root_response_alone(tmp_path):
    settings, store, run = fixture(tmp_path)
    source(store, run, "把本月结余目标改成9000元，并建议今晚的外卖安排。")
    run.pop("agent")
    run["agents"] = store.list_agents()["items"]
    advice = "今晚建议控制单人餐份量，优先蔬菜和主食。"
    model = StreamingModel(plans=[
        [tool("task", {"description": "只保存预算，不要建议", "subagent_type": "finance"}, "finance")],
        [tool("update_finance_budget", budget(savings_target="9000"), "write")],
        [chunk(advice)],
        [chunk("主助手继续自己的总结。")],
    ])
    result = await execute(settings, store, run, model)
    receipt = next(item["data"] for item in events(store, run) if item["type"] == "finance.write_completion")
    assert model.calls == 4 and receipt["analysis"] == advice
    assert result == "主助手继续自己的总结。"


async def test_explicit_report_and_explanation_keep_analysis_with_verified_report_confirmation(tmp_path):
    settings, store, _, run, arguments = report_fixture(tmp_path)
    source(store, run, "回顾3月1日至4月9日，期初6000，期末8000，出报告并解释怎么安排下一阶段预算。")
    advice = "下一阶段先保留固定支出，再安排日常用餐，未解释差额继续保持未知。"
    model = StreamingModel(plans=[[tool("publish_finance_report", arguments, "report")], [chunk(advice, reasoning="依据已发布报告解释安排。")]])
    result = await execute(settings, store, run, model)
    artifact = next(item["data"] for item in events(store, run) if item["type"] == "artifact")
    assert model.calls == 2 and result == advice + "\n\n---\n\n" + artifact["finance"]["completion"]
    assert any(item["type"] == "assistant.snapshot" and item["data"]["text"] == result for item in events(store, run))


def test_analysis_filter_preserves_legitimate_fact_based_advice_and_markdown_structure():
    advice = "根据已记录的餐费，今晚推荐30元左右。\n\n- 你已花费了500元，剩余预算要留给必要支出。\n- 每周回顾预算。\n\n```text\n请补历史流水。\n```\n\n无需补充历史流水。未解释差额应该继续保留未知，不能当作消费。"
    assert requested_analysis(advice) == advice
