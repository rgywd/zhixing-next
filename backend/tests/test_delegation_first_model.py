"""Capture the complete post-SDK first model contract, not an authored prompt fragment."""

import json

from langchain_core.messages import AIMessage, SystemMessage
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import Field
from test_agent_task_contract import ContractModel
from test_runtime import ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.store import Store


class WireContractModel(ContractModel):
    wire_tools: list[dict] = Field(default_factory=list)

    def bind_tools(self, tools, **kwargs):
        self.wire_tools = [convert_to_openai_tool(item) for item in tools]
        return super().bind_tools(tools, **kwargs)


async def test_complete_first_model_separates_sync_business_and_live_research(tmp_path):
    settings = make_settings(tmp_path)
    run = make_run("first-wire", "请启动两位只读研究助手分别读取supply.txt和delivery.txt，并行核对资料，期间还要向原助手补充要求。")
    run["agents"] = Store(settings).list_agents()["items"]
    model = WireContractModel(replies=[AIMessage(content="Contract capture")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    system = "\n".join(str(message.content) for message in model.seen[0] if isinstance(message, SystemMessage))
    functions = {item["function"]["name"]: item["function"] for item in model.wire_tools}
    order = list(functions)
    assert order.index("start_agent") < order.index("task") == len(order) - 1
    assert order.index("record_life_meal") < order.index("task")
    task = functions["task"]
    assert task["description"].startswith("Synchronous specialist business service:")
    assert "each call blocks until one final service report" in task["description"]
    assert "no persistent agent_id, non-blocking start/wait lifecycle or later send_agent follow-up" in task["description"]
    assert "For independent or parallel file/evidence research, use start_agent" in task["description"]
    finance = next(line for line in task["description"].splitlines() if line.startswith("- finance:"))
    assert "Financial ledger, income/expense, cash-flow and budget services only" in finance
    assert "not a general file or document researcher" in finance
    health = next(line for line in task["description"].splitlines() if line.startswith("- agent_health:"))
    assert "Independent health requests only" in health and "not a general file researcher" in health
    parameters = task["parameters"]["properties"]
    assert list(parameters) == ["subagent_type", "description"]
    assert parameters["subagent_type"]["enum"] == ["agent_health", "finance"]
    assert "synchronous service call" in parameters["description"]["description"]
    complete_contract = system + json.dumps(task, ensure_ascii=False)
    for sdk_prose in (
        "Launch an ephemeral subagent to handle a complex, multi-step task",
        "Launch multiple agents concurrently when their tasks are independent",
        "When only general-purpose is available",
        "Tell the agent whether to create content, analyze, or only research",
    ):
        assert sdk_prose not in complete_contract
    assert "stable agent_id" in functions["start_agent"]["description"]
    assert "For independent evidence-gathering questions use start_agent" in system
