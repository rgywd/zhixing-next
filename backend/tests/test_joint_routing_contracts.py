"""The first model contract routes a linked meal/payment to its real atomic tool."""

import pytest
from langchain_core.messages import AIMessage
from test_agent_task_contract import ContractModel
from test_runtime import ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.store import Store

JOINT_TOOLS = {"record_life_meal", "correct_life_meal"}


async def test_main_first_model_routes_joint_creation_and_correction_before_specialists(tmp_path):
    settings = make_settings(tmp_path)
    run = make_run("joint-routing")
    run["agents"] = Store(settings).list_agents()["items"]
    model = ContractModel(replies=[AIMessage(content="Ready")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    assert JOINT_TOOLS <= model.contracts.keys()
    task = model.contracts["task"]["description"]
    assert task.startswith("Joint meal-and-expense operations stay in the main assistant:")
    assert "record_life_meal for creation and correct_life_meal for correction" in task
    assert "Do not delegate a linked meal-and-payment operation to health or finance through task" in task
    health_entry = next(line for line in task.splitlines() if line.startswith("- agent_health:"))
    assert "Independent health requests only" in health_entry and "financial-ledger" in health_entry
    prompt = str(model.seen[0])
    assert "independent health-only requests" in prompt
    assert "this route excludes joint meal-and-expense creation or correction" in prompt
    assert "Separate independent service requests may use different agents" in prompt
    assert "Never delegate this linked operation to health or finance through task" in prompt
    assert "A single message may need multiple available services" not in prompt
    assert "For food, diet agreements" not in prompt


async def test_absent_joint_tools_are_not_advertised_as_available(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    run = make_run("no-joint-capability")
    run["agents"] = Store(settings).list_agents()["items"]
    monkeypatch.setattr("zhixing_next.life_tools.create_life_tools", lambda *args, **kwargs: [])
    model = ContractModel(replies=[AIMessage(content="Ready")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    assert JOINT_TOOLS.isdisjoint(model.contracts)
    task = model.contracts["task"]["description"]
    assert task.startswith("Task does not provide atomic joint meal-and-expense operations")
    assert all(name not in task for name in JOINT_TOOLS)
    prompt = str(model.seen[0])
    assert "No joint meal-and-expense write tool is available here" in prompt
    assert all(name not in prompt for name in JOINT_TOOLS)


@pytest.mark.parametrize("direct_health", [False, True])
async def test_readonly_consultation_does_not_advertise_joint_write_routing(tmp_path, direct_health):
    settings = make_settings(tmp_path)
    store = Store(settings)
    run = make_run("readonly-joint-routing", "请基于现有资料给出只读意见")
    run["agent_delivery"] = {"id": "consultation", "source_run_id": "source", "source_conversation_id": "other"}
    if direct_health:
        run["agent"] = {**store.get_agent("health"), "instructions": "始终使用中文回答。"}
    else:
        run["agents"] = store.list_agents()["items"]
    model = ContractModel(replies=[AIMessage(content="Read-only findings")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    assert (JOINT_TOOLS | {"task", "record_meal", "record_finance_transaction"}).isdisjoint(model.contracts)
    prompt = str(model.seen[0])
    assert all(name not in prompt for name in JOINT_TOOLS)
    assert "Joint meal-and-expense creation or correction must use" not in prompt
    if direct_health:
        assert "始终使用中文回答。" in prompt
        assert "a meal or note is not a financial-ledger write" in prompt
