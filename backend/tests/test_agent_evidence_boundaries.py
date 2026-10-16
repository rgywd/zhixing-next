"""Grounding rules must reach the actual main, consulted and research models."""

import hashlib

import pytest
from langchain_core.messages import AIMessage, SystemMessage
from test_agent_collaboration import Coordinator
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.store import Store


def system_text(model):
    return "\n".join(str(message.content) for message in model.seen[0] if isinstance(message, SystemMessage))


def assert_shared_evidence_limits(prompt):
    assert "不能保证转乘" in prompt
    assert "does not establish who bears liability" in prompt
    assert "original user statement or an identified source explicitly supports" in prompt
    assert "do not turn another assistant's inference into an original user fact" in prompt
    assert "Never invent an exact meal time or serving count" in prompt
    assert "do not silently use submission time or one serving" in prompt
    assert "recording metadata, explicitly distinguished from the actual eating time" in prompt


@pytest.mark.parametrize("consulted", [False, True])
async def test_main_and_consulted_models_receive_evidence_and_meal_uncertainty_rules(tmp_path, consulted):
    settings = make_settings(tmp_path)
    run = make_run("evidence", "已知方案不能保证转乘，说明能确认的事实。")
    if consulted:
        run["agent"] = Store(settings).get_agent("finance")
        run["agent_delivery"] = {"id": "consult", "source_run_id": "source", "source_conversation_id": "source-chat"}
    model = ScriptedModel(replies=[AIMessage(content="已阅读。")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    prompt = system_text(model)
    assert_shared_evidence_limits(prompt)
    if consulted:
        assert "report limitations as limitations" in prompt
        assert "cannot mistake an inference for a user statement" in prompt


async def test_actual_research_graph_receives_the_same_grounding_limits(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    run = make_run("research-evidence")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    child = ScriptedModel(replies=[AIMessage(content="研究片段。")])
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child)
    parent = Coordinator(replies=[], child_id=child_id)
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=parent)
    prompt = system_text(child)
    assert_shared_evidence_limits(prompt)
    assert "distinguish quoted facts from your own analysis" in prompt
    assert "uncertain outcome does not establish responsibility for costs or compensation" in prompt
