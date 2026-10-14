"""Runtime business errors remain actionable without exposing generic tool details."""

import json
from datetime import datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls, run_agent

from zhixing_next import runtime
from zhixing_next.health_service import HealthService
from zhixing_next.runtime import RunControls
from zhixing_next.store import Store, StoreError


def call(name, args, identifier):
    return AIMessage(
        content="", tool_calls=[{"name": name, "args": args, "id": identifier, "type": "tool_call"}]
    )


async def test_delegated_health_conflict_can_read_fresh_context_and_save_new_recommendation(
    tmp_path,
):
    settings = make_settings(tmp_path)
    store = Store(settings)
    run = {**make_run(), "agents": store.list_agents()["items"]}
    proposal = {
        "context_revision": 8,
        "target_date": datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat(),
        "entry_key": "dinner-1",
        "meal_type": "dinner",
        "options": [
            {
                "id": "first",
                "title": "豆腐配蔬菜饭",
                "description": "家常蒸豆腐、蔬菜与米饭",
                "ingredients": ["豆腐", "蔬菜", "米饭"],
                "portion": "按饥饿感调整份量",
                "substitutions": ["豆腐可换鸡蛋"],
                "reason": "可按实际用餐条件准备",
            }
        ],
    }
    model = ScriptedModel(
        replies=[
            call(
                "task",
                {
                    "description": "保存晚餐建议，如记录已变先读当前规范重新生成",
                    "subagent_type": "agent_health",
                },
                "delegate",
            ),
            call("save_meal_recommendation", proposal, "stale"),
            call("query_health_context", {}, "read-current"),
            call("save_meal_recommendation", {**proposal, "context_revision": 0}, "publish-fresh"),
            AIMessage(content="已按当前记录保存建议"),
            AIMessage(content="晚餐建议已保存"),
        ]
    )
    assert (
        await run_agent(
            settings,
            run,
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=model,
        )
        == "晚餐建议已保存"
    )
    error = next(
        message
        for messages in model.seen
        for message in messages
        if isinstance(message, ToolMessage) and message.tool_call_id == "stale"
    )
    assert error.status == "error"
    assert json.loads(error.content) == {
        "error": {
            "code": "stale_health_context",
            "message": "Health records or agreements changed; read current context and regenerate",
        }
    }
    assert len(HealthService(store).list("recommendations")["items"]) == 1


@pytest.mark.parametrize("name", ["read_text_file", "record_finance_observation"])
async def test_generic_or_legacy_store_errors_do_not_leak_uncontrolled_details(name):
    request = SimpleNamespace(tool_call={"name": name, "id": "failed", "args": {}}, state={})

    async def fail(_request):
        raise StoreError("unexpected", "/private/synthetic-sensitive-value")

    events = []

    async def emit(kind, data):
        events.append((kind, data))

    result = await RunControls(no_controls, emit)._invoke_tool(request, fail)
    assert result.status == "error"
    assert "synthetic-sensitive-value" not in result.content
    assert "Check the tool's permitted inputs" in result.content
    assert "synthetic-sensitive-value" not in str(events)


async def test_generic_service_exception_is_still_sanitized():
    request = SimpleNamespace(
        tool_call={"name": "record_life_meal", "id": "failed", "args": {}}, state={}
    )

    async def fail(_request):
        raise RuntimeError("synthetic-internal-detail")

    result = await RunControls(no_controls, ignore)._invoke_tool(request, fail)
    assert result.status == "error"
    assert "synthetic-internal-detail" not in result.content


async def test_main_and_both_fixed_children_use_one_shanghai_business_clock(tmp_path, monkeypatch):
    class AdvancingClock:
        calls = 0

        @classmethod
        def now(cls, zone):
            assert zone.key == "Asia/Shanghai"
            current = datetime(2026, 4, 10, 9, 30, tzinfo=ZoneInfo("Asia/Shanghai")) + timedelta(
                seconds=cls.calls
            )
            cls.calls += 1
            return current

    captured = {}
    original = runtime.create_deep_agent

    def capture(**kwargs):
        captured.update(kwargs)
        return original(**kwargs)

    monkeypatch.setattr(runtime, "datetime", AdvancingClock)
    monkeypatch.setattr(runtime, "create_deep_agent", capture)
    settings = make_settings(tmp_path)
    store = Store(settings)
    run = {**make_run(prompt="昨天午饭记一下"), "agents": store.list_agents()["items"]}
    model = ScriptedModel(replies=[AIMessage(content="当前业务日期已明确")])
    await run_agent(
        settings,
        run,
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    clock = "Current service time: 2026-04-10T09:30:00+08:00. Resolve relative dates from the user's stated context; ask only for an ambiguity that changes a record. "
    assert clock in captured["system_prompt"]
    children = {item["name"]: item["system_prompt"] for item in captured["subagents"]}
    assert clock in children["finance"]
    assert clock in children["agent_health"]
    assert AdvancingClock.calls == 1
