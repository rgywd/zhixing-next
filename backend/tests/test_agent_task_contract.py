"""The first model call sees usable delegation choices, never a disabled bait."""

import json

import pytest
from langchain_core.messages import AIMessage
from pydantic import Field, ValidationError
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.runtime import RunControls
from zhixing_next.store import Store


class ContractModel(ScriptedModel):
    contracts: dict[str, dict] = Field(default_factory=dict)

    def bind_tools(self, tools, **kwargs):
        self.contracts = {
            item.name: {"description": item.description, "schema": item.tool_call_schema.model_json_schema(), "input_schema": item.args_schema.model_json_schema()}
            for item in tools if not isinstance(item, dict)
        }
        return super().bind_tools(tools, **kwargs)


async def test_first_model_task_contract_contains_only_available_named_choices(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    run = make_run("task-contract")
    run["agents"] = [*store.list_agents()["items"], {
        "id": "disabled-researcher", "name": "Disabled researcher", "description": "Unavailable model", "instructions": "", "tools": [], "model_id": "missing-model",
    }]
    model = ContractModel(replies=[AIMessage(content="Ready")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    task = model.contracts["task"]
    assert task["schema"]["properties"]["subagent_type"]["enum"] == ["agent_health", "finance"]
    assert task["input_schema"]["additionalProperties"] is False
    visible = json.dumps(task, ensure_ascii=False)
    assert "general-purpose" not in visible
    assert "Unavailable" not in visible and "disabled" not in visible
    assert "start_agent" in task["description"]
    assert "Launch an ephemeral subagent" not in task["description"]
    assert "general-purpose" not in str(model.seen[0])
    assert "start_agent" in model.contracts


async def test_no_named_agents_exposes_research_without_inventing_task_route(tmp_path):
    settings = make_settings(tmp_path)
    model = ContractModel(replies=[AIMessage(content="Ready")])
    await fixture_run_agent(settings, make_run("no-specialists"), persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    assert "start_agent" in model.contracts and "task" not in model.contracts
    prompt = str(model.seen[0])
    assert "delegate to finance" not in prompt and "delegate to agent_health" not in prompt
    assert "general-purpose" not in prompt
    assert "task tool" not in prompt


@pytest.mark.parametrize("direct", [False, True])
async def test_readonly_consultation_has_no_model_visible_business_delegation(tmp_path, direct):
    settings = make_settings(tmp_path)
    store = Store(settings)
    run = make_run("consult-task-contract")
    run["agent_delivery"] = {"id": "consult", "source_run_id": "other", "source_conversation_id": "other"}
    if direct:
        run["agent"] = {**store.get_agent("finance"), "instructions": "始终使用中文，先列依据后列结论。"}
    else:
        run["agents"] = store.list_agents()["items"]
    model = ContractModel(replies=[AIMessage(content="Read-only answer")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    assert {"task", "start_agent", "send_conversation_message", "record_finance_transaction", "publish_report"}.isdisjoint(model.contracts)
    prompt = str(model.seen[0])
    assert "delegate to finance" not in prompt and "delegate to agent_health" not in prompt
    assert "task tool" not in prompt
    assert "read-only consultation" in prompt
    if direct:
        assert "始终使用中文，先列依据后列结论。" in prompt
        assert "configured write workflows provide no authorization" in prompt
        assert "清楚的收支直接记录" not in prompt  # service write workflow is absent


def test_task_literal_is_validated_from_actual_allowed_names():
    guard = RunControls(no_controls, ignore, {"finance", "agent_health"})
    assert guard.named_task_schema.model_validate({"description": "Read budget", "subagent_type": "finance"}).subagent_type == "finance"
    with pytest.raises(ValidationError):
        guard.named_task_schema.model_validate({"description": "Research", "subagent_type": "general-purpose"})
