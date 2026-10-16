import asyncio
import json

import pytest
from pydantic import ValidationError
from test_live_stream import StreamingModel, chunk
from test_runtime import make_settings

from zhixing_next.finance_report import format_finance_write_completion
from zhixing_next.finance_service import FinanceService
from zhixing_next.operations import Journal, decode_result
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store
from zhixing_next.tools import create_finance_tools


def tool(name, arguments, identifier):
    return chunk(tool_call_chunks=[{"name": name, "args": json.dumps(arguments), "id": identifier, "index": 0}])


def fixture(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("财务写入流式", agent_id="finance")["id"]
    store.submit_message(conversation, id="write-input", content="安排2026年10月预算：预计收入15000，结余目标先8000，核对后改9000。")
    with store._connection(write=True) as db:
        db.execute("UPDATE messages SET created_at='2026-10-15T10:00:00+00:00' WHERE id='write-input'")
    run = store.claim_next("chat")
    run["agent"] = store.get_agent("finance")
    return settings, store, run


def budget(entry_key="budget-1", **changes):
    return {"month": "2026-10", "entry_key": entry_key, "changes": {"expected_income": "15000", "savings_target": "8000", **changes}}


async def execute(settings, store, run, model, on_emit=None):
    async def emit(kind, data):
        store.add_event(run["id"], kind, data)
        if on_emit:
            await on_emit(kind, data)

    async def controls():
        return store.get_controls(run["id"])

    async def acknowledge(ids):
        store.acknowledge_steers(run["id"], ids)

    return await run_agent(settings, run, persona="", emit=emit, controls=controls, acknowledge=acknowledge, model_override=model)


def events(store, run):
    return store.list_events(run["id"], limit=1000)["items"]


async def test_successful_writes_continue_all_planning_then_program_final_hides_only_provider_text(tmp_path, monkeypatch):
    import zhixing_next.runtime as runtime

    graphs = []
    create = runtime.create_deep_agent

    def capture(**kwargs):
        graph = create(**kwargs)
        graphs.append(graph)
        return graph

    monkeypatch.setattr(runtime, "create_deep_agent", capture)
    settings, store, run = fixture(tmp_path)
    model = StreamingModel(plans=[
        [chunk("先读取现有安排。", reasoning="先保存预算。"), tool("update_finance_budget", budget(), "budget-1")],
        [chunk("差额大概率是日常消费，要补押金。", reasoning="核对保存的预算。"), tool("get_finance_summary", {"month": "2026-10"}, "read")],
        [chunk("请继续补历史流水。", reasoning="继续完成目标修正。"), tool("update_finance_budget", budget("budget-2", savings_target="9000"), "budget-2")],
        [chunk("还差押金，差额应该算日常消费。", reasoning="按实际修改回执结束。")],
    ])
    result = await execute(settings, store, run, model)
    assert model.calls == 4
    assert FinanceService(store).get_budget("2026-10")["savings_target"] == "9000.00"
    captured = events(store, run)
    receipt = next(item["data"] for item in captured if item["type"] == "finance.write_completion")
    assert result == receipt["completion"] == format_finance_write_completion(receipt["summary"], receipt["operations"])
    assert receipt["input_message_id"] == run["message_id"] and receipt["summary"]["month"] == "2026-10"
    assert len(receipt["operations"]) == 2
    with store._connection() as db:
        for identifier, value in zip(receipt["operation_ids"], receipt["operations"], strict=True):
            row = db.execute("SELECT * FROM operations WHERE id=?", (identifier,)).fetchone()
            assert row["run_id"] == run["id"] and row["state"] == "succeeded" and row["tool"] == value["tool"]
            assert json.loads(decode_result(json.loads(row["result_json"])).content) == value["receipt"]
    text = "\n".join(item["data"]["text"] for item in captured if item["type"] == "assistant.snapshot")
    assert "先读取现有安排。" in text and result in text
    assert not any(value in text for value in ("差额大概率", "补押金", "补历史流水", "差额应该算"))
    thoughts = "\n".join(item["data"]["text"] for item in captured if item["type"] == "reasoning.snapshot")
    assert all(value in thoughts for value in ("先保存预算", "核对保存", "继续完成", "按实际修改"))
    assert {item["data"]["tool"] for item in captured if item["type"] == "tool" and item["data"].get("status") == "completed"} >= {"update_finance_budget", "get_finance_summary"}
    import aiosqlite

    async with aiosqlite.connect(settings.data_dir / "checkpoints.sqlite") as connection:
        graphs[0].checkpointer = await runtime._prepare_checkpointer(connection)
        saved = await graphs[0].aget_state({"configurable": {"thread_id": run["conversation_id"]}})
    assert saved.values["messages"][-1].content == result
    assert saved.values["messages"][-1].additional_kwargs["zhixing_program_finance_write"] is True
    store.finish_run(run["id"], "completed", result=result)
    assert store.list_messages(run["conversation_id"])["items"][-1]["content"] == result


async def test_finance_child_program_final_does_not_suppress_or_stop_root_or_health(tmp_path):
    settings, store, run = fixture(tmp_path)
    run.pop("agent")
    run["agents"] = store.list_agents()["items"]
    model = StreamingModel(plans=[
        [tool("task", {"description": "保存并核对预算", "subagent_type": "finance"}, "finance")],
        [tool("update_finance_budget", budget(), "budget")],
        [chunk("财务错误押金猜测。", reasoning="财务核对实际记录。"), tool("get_finance_summary", {"month": "2026-10"}, "summary")],
        [chunk("请补押金以及流水。")],
        [tool("task", {"description": "核对当前健康约定", "subagent_type": "agent_health"}, "health")],
        [chunk("健康部分继续按已有约定安排。")],
        [chunk("财务已核验保存，健康部分也已核对。")],
    ])
    result = await execute(settings, store, run, model)
    assert model.calls == 7 and result == "财务已核验保存，健康部分也已核对。"
    captured = events(store, run)
    assert len([item for item in captured if item["type"] == "finance.write_completion"]) == 1
    text = "\n".join(item["data"]["text"] for item in captured if item["type"] == "assistant.snapshot")
    assert "财务错误押金" not in text and "请补押金" not in text
    # Child messages are carried back as task receipts; the root stream remains its own.
    assert result in text


@pytest.mark.parametrize("failed_write", [False, True])
async def test_no_successful_writes_keep_normal_finance_streaming(tmp_path, failed_write):
    settings, store, run = fixture(tmp_path)
    plans = [[tool("update_finance_budget", budget(expected_income="-1"), "invalid")]] if failed_write else []
    plans.append([chunk("这次只讨论现有安排，未保存新数据。", reasoning="正常分析。")])
    model = StreamingModel(plans=plans)
    result = await execute(settings, store, run, model)
    assert result == "这次只讨论现有安排，未保存新数据。"
    captured = events(store, run)
    assert not any(item["type"] == "finance.write_completion" for item in captured)
    assert any(item["type"] == "assistant.snapshot" and item["data"]["text"] == result for item in captured)


async def test_new_steer_after_successful_write_takes_priority_and_can_return_normal_chat(tmp_path):
    settings, store, run = fixture(tmp_path)
    model = StreamingModel(plans=[
        [tool("update_finance_budget", budget(), "budget")],
        [chunk("旧决定要求补押金。", reasoning="准备旧财务答复。")],
        [chunk("收到，我们先聊聊心情。")],
    ])

    async def on_emit(kind, data):
        if kind == "reasoning.snapshot" and data["text"] == "准备旧财务答复。":
            store.submit_message(run["conversation_id"], id="chat-steer", content="先别解释财务，我们聊聊心情。", intent="steer", target_run_id=run["id"])

    result = await execute(settings, store, run, model, on_emit)
    assert model.calls == 3 and result == "收到，我们先聊聊心情。"
    assert not any(item["type"] == "finance.write_completion" for item in events(store, run))
    assert "旧决定要求补押金" not in "\n".join(item["data"]["text"] for item in events(store, run) if item["type"] == "assistant.snapshot")


async def test_cancel_after_successful_write_preserves_receipt_without_final_claim(tmp_path):
    settings, store, run = fixture(tmp_path)
    model = StreamingModel(plans=[[tool("update_finance_budget", budget(), "budget")], [chunk("错误的补押金。", reasoning="准备取消前答复。")]])

    async def on_emit(kind, data):
        if kind == "reasoning.snapshot" and data["text"] == "准备取消前答复。":
            store.cancel_run(run["id"])

    with pytest.raises(asyncio.CancelledError):
        await execute(settings, store, run, model, on_emit)
    assert FinanceService(store).get_budget("2026-10")["expected_income"] == "15000.00"
    assert Journal(settings).receipts(run["id"])["items"][0]["state"] == "succeeded"
    assert not any(item["type"] == "finance.write_completion" for item in events(store, run))


async def test_partial_failure_reports_successful_part_without_pretending_all_finished(tmp_path):
    settings, store, run = fixture(tmp_path)
    model = StreamingModel(plans=[[tool("update_finance_budget", budget(), "budget")], [tool("read_text_file", {"path": "missing.txt"}, "missing")], [tool("get_finance_summary", {"month": "2026-10"}, "summary")], [chunk("错误地声称所有内容都完成，需要补押金。")]])
    result = await execute(settings, store, run, model)
    receipt = next(item["data"] for item in events(store, run) if item["type"] == "finance.write_completion")
    assert receipt["summary"]["write_completion_partial"] is True
    assert result == format_finance_write_completion(receipt["summary"], receipt["operations"])
    assert "尚未成功" in result and len(receipt["operations"]) == 1


async def test_provider_failure_after_write_keeps_real_receipt_and_does_not_claim_completion(tmp_path):
    settings, store, run = fixture(tmp_path)
    model = StreamingModel(plans=[[tool("update_finance_budget", budget(), "budget")], [chunk("不应显示的押金猜测。", reasoning="真实失败前思考。"), ValueError("provider failed")]])
    with pytest.raises(ValueError, match="provider failed"):
        await execute(settings, store, run, model)
    captured = events(store, run)
    assert FinanceService(store).get_budget("2026-10")["expected_income"] == "15000.00"
    assert not any(item["type"] == "finance.write_completion" for item in captured)
    assert not any(item["type"] == "assistant.snapshot" and "押金" in item["data"]["text"] for item in captured)
    assert any(item["type"] == "reasoning.snapshot" and "失败前思考" in item["data"]["text"] for item in captured)


async def test_new_user_run_does_not_summarize_old_checkpoint_writes_or_suppress_normal_stream(tmp_path):
    settings, store, run = fixture(tmp_path)
    first = await execute(settings, store, run, StreamingModel(plans=[[tool("update_finance_budget", budget(), "budget")], [chunk("第一次结束。")]]))
    store.finish_run(run["id"], "completed", result=first)
    store.submit_message(run["conversation_id"], id="new-user-question", content="现在聊聊近况。")
    next_run = store.claim_next("chat")
    next_run["agent"] = store.get_agent("finance")
    result = await execute(settings, store, next_run, StreamingModel(plans=[[chunk("好的，最近怎么样？")]]))
    captured = events(store, next_run)
    assert result == "好的，最近怎么样？"
    assert not any(item["type"] == "finance.write_completion" for item in captured)
    assert any(item["type"] == "assistant.snapshot" and item["data"]["text"] == result for item in captured)


@pytest.mark.parametrize("remove", [False, True])
async def test_balance_observation_only_write_has_real_completion_without_becoming_income(tmp_path, remove):
    settings, store, run = fixture(tmp_path)
    if remove:
        original = store.record_finance_observation(kind="balance", platform="测试账户", amount="5200.50", note="用户口述余额", conversation_id=run["conversation_id"])
        name, arguments = "remove_finance_observation", {"observation_id": original["id"]}
        prompt = "删掉刚才说错的测试账户余额观察。"
    else:
        name, arguments = "record_finance_observation", {"kind": "balance", "platform": "测试账户", "amount": "5200.50", "note": "用户口述余额"}
        prompt = "测试账户现在余额5200.50元，保存一下。"
    with store._connection(write=True) as db:
        db.execute("UPDATE messages SET content=? WHERE id=?", (prompt, run["message_id"]))
    run["prompt"] = prompt
    model = StreamingModel(plans=[[tool(name, arguments, "observation")], [chunk("余额已当作新收入入账，接下来需要补押金。", reasoning="核对余额观察的真实保存回执。")]])
    result = await execute(settings, store, run, model)
    captured = events(store, run)
    receipt = next(item["data"] for item in captured if item["type"] == "finance.write_completion")
    assert model.calls == 2 and [item["tool"] for item in receipt["operations"]] == [name]
    assert result == receipt["completion"] == format_finance_write_completion(receipt["summary"], receipt["operations"])
    assert ("删除 1 条财务观察" if remove else "保存 1 条余额观察") in result
    assert "没有可确认成功" not in result
    assert receipt["summary"]["totals"]["income"] == receipt["summary"]["totals"]["expense"] == "0.00"
    assert len(store.list_finance_observations()["balances"]) == (0 if remove else 1)
    text = "\n".join(item["data"]["text"] for item in captured if item["type"] == "assistant.snapshot")
    assert result in text and "新收入入账" not in text and "补押金" not in text
    assert any(item["type"] == "reasoning.snapshot" and "真实保存回执" in item["data"]["text"] for item in captured)


@pytest.mark.parametrize("kind", ["income", "expense"])
async def test_legacy_observation_tool_rejects_new_cashflow_before_database_write(tmp_path, kind):
    settings, store, run = fixture(tmp_path)
    observer = next(item for item in create_finance_tools(settings, run["conversation_id"]) if item.name == "record_finance_observation")
    with pytest.raises(ValidationError) as error:
        await observer.ainvoke({"kind": kind, "platform": "测试账户", "amount": "5200.50"})
    assert error.value.errors()[0]["type"] == "literal_error"
    with store._connection() as db:
        assert db.execute("SELECT COUNT(*) FROM finance_observations").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM finance_transactions").fetchone()[0] == 0
