"""Actual health graph contracts cannot substitute meals/notes for finance writes."""

import hashlib

import pytest
from langchain_core.messages import AIMessage, SystemMessage
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import Field
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.health_tools import (
    HEALTH_CAPABILITY_INSTRUCTIONS,
    HEALTH_INSTRUCTIONS,
    HEALTH_TOOL_NAMES,
    create_health_tools,
)
from zhixing_next.life_tools import LIFE_INSTRUCTIONS, create_life_tools
from zhixing_next.store import Store


class CapabilityModel(ScriptedModel):
    menus: list[set[str]] = Field(default_factory=list)

    def bind_tools(self, tools, **kwargs):
        self.menus.append({item.get("name") if isinstance(item, dict) else item.name for item in tools})
        return super().bind_tools(tools, **kwargs)


def test_runtime_capability_text_does_not_change_the_migration_builtin():
    # v14 migration matches this exact old built-in; current limits are appended
    # at runtime rather than modifying the persisted-default discriminator.
    assert hashlib.sha256(HEALTH_INSTRUCTIONS.encode()).hexdigest() == "147ee923e0e7d856c8682cdfc54ebcb9355c3dca2777ef53a8d1121708e5b7aa"
    assert HEALTH_CAPABILITY_INSTRUCTIONS not in HEALTH_INSTRUCTIONS


def test_joint_tool_and_nested_food_field_exclude_payment_placeholder_meals(tmp_path):
    settings = make_settings(tmp_path)
    life = {item.name: item for item in create_life_tools(settings, "conversation", "source")}
    health = {item.name: item for item in create_health_tools(settings, "conversation", "source")}
    assert "主助手必须直接调用record_life_meal" in LIFE_INSTRUCTIONS
    assert "联合新增或纠正不得通过task交给健康或财务子助手" in LIFE_INSTRUCTIONS
    assert "财务流水未写入就不能把备注称为记账或实质完成" in LIFE_INSTRUCTIONS
    schema = convert_to_openai_tool(life["record_life_meal"])["function"]
    assert "required atomic entry" in schema["description"]
    description = schema["parameters"]["properties"]["meal"]["properties"]["description"]["description"]
    assert "Actual food names and preparation" in description
    assert "never a payment/fee placeholder or a substitute finance record" in description
    assert "a meal or its note is never a saved finance transaction" in health["record_meal"].description


@pytest.mark.parametrize("custom_tools", [False, True])
@pytest.mark.parametrize("delegated", [False, True])
async def test_actual_health_graph_receives_capability_boundary_without_more_tools(
    tmp_path, custom_tools, delegated,
):
    settings = make_settings(tmp_path)
    agent = Store(settings).get_agent("health")
    if custom_tools:
        agent = {**agent, "tools": ["record_weight"], "instructions": "请用简短中文。"}
    run = make_run("health-capability", "午饭花24.60元，吃了豆腐青菜米饭，请将同一顿一起记录。")
    if delegated:
        run["agents"] = [agent]
        model = CapabilityModel(replies=[
            AIMessage(content="", tool_calls=[{
                "name": "task", "args": {"subagent_type": "agent_health", "description": run["prompt"]},
                "id": "health-request", "type": "tool_call",
            }]),
            AIMessage(content="当前健康工具没有联合原子能力，尚未新增餐食或财务流水。"),
            AIMessage(content="需由主助手联合工具完成，不能把备注称为财务保存。"),
        ])
    else:
        run["agent"] = agent
        model = CapabilityModel(replies=[AIMessage(content="当前未执行联合写入。")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    health_inputs = [messages for messages in model.seen if any(
        isinstance(message, SystemMessage) and HEALTH_CAPABILITY_INSTRUCTIONS in str(message.content)
        for message in messages
    )]
    assert len(health_inputs) == 1
    health_menus = [menu for menu in model.menus if "record_weight" in menu]
    assert health_menus
    expected = set(agent["tools"]) & set(HEALTH_TOOL_NAMES)
    assert all(menu & set(HEALTH_TOOL_NAMES) == expected for menu in health_menus)
    assert all({"record_life_meal", "correct_life_meal", "record_finance_transaction", "correct_finance_transaction"}.isdisjoint(menu)
               for menu in health_menus)
    if custom_tools:
        assert "请用简短中文。" in str(health_inputs[0])
