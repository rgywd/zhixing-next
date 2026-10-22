import pytest
from langchain_core.messages import AIMessage, SystemMessage
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.prompts import ZHIXING_BASE_PROMPT
from zhixing_next.store import Store


@pytest.mark.parametrize('direct', [False, True])
async def test_product_base_reaches_real_graph_with_current_capability_limits(tmp_path, direct):
    settings = make_settings(tmp_path)
    run = make_run('persona')
    if direct:
        run['agent'] = Store(settings).get_agent('health')
    model = ScriptedModel(replies=[AIMessage(content='你好。')])
    await fixture_run_agent(settings, run, persona='说话温和，称呼我小林。', emit=ignore,
                            controls=no_controls, acknowledge=ignore, model_override=model)
    system = '\n'.join(str(item.content) for item in model.seen[0] if isinstance(item, SystemMessage))
    assert ZHIXING_BASE_PROMPT in system
    assert '知行 (Zhixing)' in system and '说话温和，称呼我小林。' in system
    assert 'Shell execution is disabled' in system and 'Web search is unavailable' in system
    assert 'separate pass applies it after your reply' in system
    assert 'The service reports actual failures' in system
    assert 'Do not list unrelated retrieved memories' in system
    if direct:
        assert f"You are the dedicated {run['agent']['name']} agent" in system
    assert '## Current Runtime' in system
    for foreign_contract in ('Muse Spark', 'created by Meta', 'muse.ai', 'muse.memory_', '~/MEMORY.md',
                             'tool_search.load_tool_namespace', 'subagent.spawn', 'sandbox://', '<message_break/>'):
        assert foreign_contract not in system


async def test_changed_base_refuses_paused_run_before_replaying_tools(tmp_path, monkeypatch):
    from zhixing_next import runtime
    from zhixing_next.operations import RunPaused
    from zhixing_next.runtime import RuntimeConfigurationError
    from zhixing_next.taskflow import TaskFlow

    settings, run = make_settings(tmp_path), make_run('base-recovery')
    first = ScriptedModel(replies=[AIMessage(content='', tool_calls=[{
        'name': 'request_user_input', 'args': {'question': '用哪个文件名？'}, 'id': 'question', 'type': 'tool_call',
    }])])
    with pytest.raises(RunPaused):
        await fixture_run_agent(settings, run, persona='', emit=ignore, controls=no_controls,
                                acknowledge=ignore, model_override=first)
    store = Store(settings)
    store.pause_run(run['id'])
    flow = TaskFlow(store)
    question = flow.questions(run_id=run['id'])['items'][0]
    flow.answer(question['id'], 'notes.md')
    resumed = store.claim_next('chat')
    monkeypatch.setattr(runtime, 'ZHIXING_BASE_PROMPT', ZHIXING_BASE_PROMPT + '\nChanged instructions.')
    next_model = ScriptedModel(replies=[AIMessage(content='不应执行')])
    with pytest.raises(RuntimeConfigurationError, match='恢复期间'):
        await fixture_run_agent(settings, resumed, persona='', emit=ignore, controls=no_controls,
                                acknowledge=ignore, model_override=next_model)
    assert next_model.seen == []
    assert flow.questions(run_id=run['id'])['items'] == []
