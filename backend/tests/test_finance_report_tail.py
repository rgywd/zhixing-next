import pytest
from test_finance_mixed_reply import source
from test_finance_report_publication import fixture
from test_finance_write_stream import events, execute, tool
from test_live_stream import StreamingModel, chunk

from zhixing_next.finance_service import FinanceService
from zhixing_next.operations import Journal


def capture_requests(monkeypatch):
    from zhixing_next.runtime import RunControls

    requests = []
    original = RunControls.awrap_model_call

    async def observe(self, request, handler):
        async def capture(prepared):
            requests.append({"finance": self.finance_completion, "tools": [item.get("name") if isinstance(item, dict) else item.name for item in prepared.tools], "tool_choice": prepared.tool_choice})
            return await handler(prepared)

        return await original(self, request, capture)

    monkeypatch.setattr(RunControls, "awrap_model_call", observe)
    return requests


async def test_published_report_has_one_tools_closed_analysis_call_and_preserves_final_stream(tmp_path, monkeypatch):
    settings, store, _, run, arguments = fixture(tmp_path)
    source(store, run, "生成财务回顾报告，并给今晚餐费预算建议。")
    requests = capture_requests(monkeypatch)
    advice = "今晚建议选择30元左右的简单套餐，少点饮料。"
    model = StreamingModel(plans=[[tool("publish_finance_report", arguments, "report")], [chunk(advice, reasoning="直接用已交付报告给建议，不再试算系数。")]])
    result = await execute(settings, store, run, model)
    artifact = next(item["data"] for item in events(store, run) if item["type"] == "artifact")
    assert model.calls == 2 and len(requests) == 2
    assert "calculate" in requests[0]["tools"] and requests[1]["tools"] == [] and requests[1]["tool_choice"] is None
    assert result == advice + "\n\n---\n\n" + artifact["finance"]["completion"]
    assert not any(item["tool"] == "calculate" for item in Journal(settings).receipts(run["id"])["items"])
    captured = events(store, run)
    assert any(item["type"] == "assistant.snapshot" and item["data"]["text"] == result for item in captured)
    assert any(item["type"] == "reasoning.snapshot" and "不再试算" in item["data"]["text"] for item in captured)


@pytest.mark.parametrize("with_advice", [False, True])
async def test_provider_cannot_execute_unavailable_tools_after_report_or_start_another_loop(tmp_path, monkeypatch, with_advice):
    settings, store, _, run, arguments = fixture(tmp_path)
    source(store, run, "生成报告并建议今晚怎么安排餐费。")
    requests = capture_requests(monkeypatch)
    advice = "今晚建议选择简单套餐。"
    last = ([chunk(advice)] if with_advice else []) + [tool("calculate", {"expression": "6320*0.15/15"}, "forbidden-calculation")]
    model = StreamingModel(plans=[[tool("publish_finance_report", arguments, "report")], last])
    result = await execute(settings, store, run, model)
    assert model.calls == 2 and requests[-1]["tools"] == []
    assert result.startswith(advice if with_advice else "报告已交付，这次未形成额外建议。")
    assert not any(item["tool"] == "calculate" for item in Journal(settings).receipts(run["id"])["items"])
    blocked = [item for item in events(store, run) if item["type"] == "tool" and item["data"].get("tool") == "calculate"]
    assert len(blocked) == 1 and blocked[0]["data"]["error"] == "tools_closed_after_finance_report"
    store.finish_run(run["id"], "completed", result=result)
    assert store.get_run(run["id"])["status"] == "completed"


async def test_finance_report_tail_does_not_close_main_or_health_tools(tmp_path, monkeypatch):
    settings, store, _, run, arguments = fixture(tmp_path)
    source(store, run, "生成财务报告并给晚餐建议，再核对健康约定。")
    run.pop("agent")
    run["agents"] = store.list_agents()["items"]
    requests = capture_requests(monkeypatch)
    model = StreamingModel(plans=[
        [tool("task", {"description": "生成报告并给餐费建议", "subagent_type": "finance"}, "finance")],
        [tool("publish_finance_report", arguments, "report")],
        [chunk("晚餐建议控制饮料和加购。")],
        [tool("task", {"description": "核对健康约定", "subagent_type": "agent_health"}, "health")],
        [chunk("健康约定也已核对。")],
        [chunk("报告和晚餐建议已整理，健康约定已核对。")],
    ])
    result = await execute(settings, store, run, model)
    assert model.calls == 6 and result == "报告和晚餐建议已整理，健康约定已核对。"
    assert requests[2]["finance"] and requests[2]["tools"] == []
    assert "task" in requests[3]["tools"] and "query_health_context" in requests[4]["tools"] and "task" in requests[5]["tools"]


async def test_new_seen_steer_during_report_tail_reopens_tools_before_new_finance_write(tmp_path, monkeypatch):
    settings, store, _, run, arguments = fixture(tmp_path)
    source(store, run, "生成报告并建议今晚餐费。")
    requests = capture_requests(monkeypatch)
    sent = False

    async def on_emit(kind, data):
        nonlocal sent
        if not sent and kind == "reasoning.snapshot" and data["text"] == "准备旧报告建议。":
            store.submit_message(run["conversation_id"], id="after-report-input", content="把2026年4月结余目标改9500元，这次不用建议。", intent="steer", target_run_id=run["id"])
            sent = True

    model = StreamingModel(plans=[
        [tool("publish_finance_report", arguments, "report")],
        [chunk("不应显示的旧建议。", reasoning="准备旧报告建议。"), tool("calculate", {"expression": "1+1"}, "old-decision")],
        [tool("update_finance_budget", {"entry_key": "steered", "month": "2026-04", "changes": {"savings_target": "9500"}}, "new-write")],
        [chunk("模型最终确认。")],
    ])
    result = await execute(settings, store, run, model, on_emit)
    assert model.calls == 4 and requests[1]["tools"] == []
    assert "update_finance_budget" in requests[2]["tools"] and "calculate" in requests[2]["tools"]
    assert FinanceService(store).get_budget("2026-04")["savings_target"] == "9500.00"
    receipt = next(item["data"] for item in events(store, run) if item["type"] == "finance.write_completion")
    assert receipt["input_message_id"] == "after-report-input" and result == receipt["completion"]
    assert not any(item["tool"] == "calculate" for item in Journal(settings).receipts(run["id"])["items"])
    assert not any(item["type"] == "assistant.snapshot" and "不应显示的旧建议" in item["data"]["text"] for item in events(store, run))
