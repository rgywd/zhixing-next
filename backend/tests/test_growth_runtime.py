import json

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls, run_agent

from zhixing_next.api import create_app
from zhixing_next.growth import GrowthService
from zhixing_next.growth_tools import GROWTH_WRITE_TOOLS
from zhixing_next.store import Store


def call(name, args, key):
    return AIMessage(content='', tool_calls=[{'name': name, 'args': args, 'id': key, 'type': 'tool_call'}])


async def test_real_graph_saves_preferences_goal_persona_and_skill_for_next_conversation(tmp_path):
    settings = make_settings(tmp_path)
    run = make_run('growth', '以后温和一点。主动帮我跟进阅读，每天下午四点问进展，记住先检查现有资料再开始。')
    model = ScriptedModel(replies=[
        call('read_assistant_growth', {}, 'read'),
        call('save_proactive_preferences', {'changes': {'enabled': True, 'topics': {'reading': 'allow'},
             'guidance': {'style': '简短温和'}}, 'entry_key': 'prefs'}, 'prefs'),
        call('save_personal_goal', {'changes': {'title': '完成阅读', 'topic': 'reading',
             'next_check_at': '2026-10-24T16:00:00+08:00', 'interval_seconds': 86400}, 'entry_key': 'reading'}, 'goal'),
        call('evolve_assistant_persona', {'content': '温和而有主见，愿意随共同经历成长。',
             'reason': '用户反馈', 'entry_key': 'style'}, 'persona'),
        call('save_learned_skill', {'key': 'research-first', 'content': '开始之前先检查现有资料。',
             'reason': '用户选择的方法', 'entry_key': 'method'}, 'skill'),
        AIMessage(content='已保存偏好和跟进安排。'),
    ])
    await run_agent(settings, run, persona='用户配置保持独立', emit=ignore, controls=no_controls,
                    acknowledge=ignore, model_override=model)
    receipts = [item for messages in model.seen for item in messages if isinstance(item, ToolMessage)]
    assert receipts and all(item.status != 'error' for item in receipts)
    state = GrowthService(Store(settings)).read_state()
    assert state['preferences']['enabled'] is True
    assert state['preferences']['guidance']['style'] == '简短温和'
    assert state['goals'][0]['interval_seconds'] == 86400
    assert state['learned_skills'][0]['key'] == 'research-first'
    next_model = ScriptedModel(replies=[AIMessage(content='我们先看看已有资料。')])
    follow = make_run('new-growth-chat', '帮我研究一个问题')
    follow['conversation_id'] = 'new-conversation'
    await run_agent(settings, follow, persona='用户配置保持独立', emit=ignore, controls=no_controls,
                    acknowledge=ignore, model_override=next_model)
    system = '\n'.join(str(item.content) for item in next_model.seen[0] if isinstance(item, SystemMessage))
    assert 'You have your own personality and a soul.' in system
    assert '温和而有主见' in system and '开始之前先检查现有资料' in system
    assert '用户配置保持独立' in system


@pytest.mark.parametrize('mode', ['readonly', 'forget'])
async def test_research_or_forget_cannot_change_growth(tmp_path, mode):
    settings = make_settings(tmp_path)
    run = make_run('growth-boundary', '忘记我的旧地址' if mode == 'forget' else '分析已有偏好')
    if mode == 'readonly':
        run['agent_delivery'] = {'id': 'consult', 'source_run_id': 'other', 'source_conversation_id': 'other'}
    model = ScriptedModel(replies=[AIMessage(content='收到。')])
    await run_agent(settings, run, persona='', emit=ignore, controls=no_controls,
                    acknowledge=ignore, model_override=model)
    assert not set(model.bound_names) & GROWTH_WRITE_TOOLS
    assert GrowthService(Store(settings)).read_state()['revision'] == 0


def test_growth_api_auth_partial_update_and_scheduled_receipt(tmp_path):
    settings = make_settings(tmp_path).model_copy(update={'api_token': 'test-service-token-do-not-use'})
    app = create_app(settings)
    with TestClient(app) as unauthenticated:
        assert unauthenticated.get('/v1/growth').status_code == 401
    with TestClient(app, headers={'Authorization': f'Bearer {settings.api_token}'}) as client:
        conversation = client.post('/v1/conversations', json={'title': '成长'}).json()['id']
        first = client.patch('/v1/growth/preferences', json={'enabled': True, 'conversation_id': conversation,
                  'topics': {'reading': 'allow', 'work': 'block'}, 'guidance': {'style': '简短'}})
        assert first.status_code == 200, first.text
        second = client.patch('/v1/growth/preferences', json={'snooze_until': '2026-10-24T08:00:00+08:00'})
        assert second.status_code == 200
        assert second.json()['topics']['work'] == 'block' and second.json()['enabled']
        goal = client.post('/v1/growth/goals', json={'id': 'reading', 'conversation_id': conversation,
                          'title': '完成阅读', 'next_check_at': '2026-10-24T16:00:00+08:00'})
        assert goal.status_code == 200, goal.text
        assert client.patch('/v1/growth/goals/reading', json={'status': 'cancelled'}).json()['next_check_at'] is None
        assert client.patch('/v1/growth/goals/reading', json={'next_check_at': '2026-10-24T16:00:00'}).status_code == 422
        assert client.put('/v1/growth/persona', json={'content': '温柔、有好奇心', 'reason': '共同选择'}).status_code == 200
        assert client.get('/v1/growth/heartbeat').status_code == 200
        assert 'api_token' not in json.dumps(client.get('/v1/growth').json())


async def test_own_growth_write_then_pause_can_resume_without_replaying(tmp_path):
    from zhixing_next.operations import RunPaused
    from zhixing_next.taskflow import TaskFlow

    settings = make_settings(tmp_path)
    run = make_run('growth-pause', '先变得温和一点，然后问我选哪一本书')
    first = ScriptedModel(replies=[
        call('evolve_assistant_persona', {'content': '温和、有耐心。', 'reason': '用户反馈', 'entry_key': 'style'}, 'style'),
        call('request_user_input', {'question': '选哪本书？'}, 'question'),
    ])
    with pytest.raises(RunPaused):
        await run_agent(settings, run, persona='', emit=ignore, controls=no_controls,
                        acknowledge=ignore, model_override=first)
    store = Store(settings)
    store.pause_run(run['id'])
    revision = GrowthService(store).read_state()['revision']
    flow = TaskFlow(store)
    question = flow.questions(run_id=run['id'])['items'][0]
    flow.answer(question['id'], '第一本')
    resumed = store.claim_next('chat')
    final = ScriptedModel(replies=[AIMessage(content='那就从第一本开始。')])
    await run_agent(settings, resumed, persona='', emit=ignore, controls=no_controls,
                    acknowledge=ignore, model_override=final)
    assert final.seen
    assert GrowthService(store).read_state()['revision'] == revision


async def test_reading_derived_understanding_registers_forgetting_exposure(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    fact = store.add_memory('用户喜欢安静地读书。')
    growth = GrowthService(store)
    snapshot = growth.snapshot()
    assert growth.apply_maintenance({'understanding': [{'key': 'reading', 'content': '偏好安静阅读',
                                    'memory_refs': [fact['id']]}]}, snapshot['revision'], snapshot['memory_versions'])
    model = ScriptedModel(replies=[call('read_assistant_growth', {}, 'read'), AIMessage(content='知道了。')])
    run = make_run('derived-read', '看看你对我的理解')
    await run_agent(settings, run, persona='', emit=ignore, controls=no_controls,
                    acknowledge=ignore, model_override=model)
    before = store.memory_reset_revision(run['conversation_id'])
    store.delete_memory(fact['id'])
    assert store.memory_reset_revision(run['conversation_id']) > before
    assert growth.read_state()['understanding'] == []


async def test_steer_can_change_same_preference_entry_in_one_run(tmp_path):
    from zhixing_next.runtime import run_agent as actual_run_agent

    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation('主动偏好引导')['id']
    store.submit_message(conversation, id='original-growth', content='阅读可以主动提醒')
    run = store.claim_next('chat')
    guided = False

    async def emit(kind, data):
        nonlocal guided
        store.add_event(run['id'], kind, data)
        if kind == 'tool' and data.get('tool') == 'save_proactive_preferences' and data.get('status') == 'completed' and not guided:
            guided = True
            store.submit_message(conversation, id='growth-steer', content='改成暂时不要主动发消息',
                                 intent='steer', target_run_id=run['id'])

    async def controls():
        return store.get_controls(run['id'])

    async def acknowledge(ids):
        store.acknowledge_steers(run['id'], ids)

    model = ScriptedModel(replies=[
        call('save_proactive_preferences', {'changes': {'enabled': True}, 'entry_key': 'prefs'}, 'prefs'),
        call('save_proactive_preferences', {'changes': {'enabled': False}, 'entry_key': 'prefs'}, 'prefs'),
        AIMessage(content='已调整。'),
    ])
    await actual_run_agent(settings, run, persona='', emit=emit, controls=controls,
                           acknowledge=acknowledge, model_override=model)
    assert guided
    assert GrowthService(store).read_state()['preferences']['enabled'] is False
    with store._connection() as db:
        keys = [row[0] for row in db.execute('SELECT operation_key FROM growth_receipts')]
    assert any('original-growth' in key for key in keys) and any('growth-steer' in key for key in keys)


def test_goal_receipt_exposes_quiet_deferral_without_inventing_exception():
    from zhixing_next.growth_schema import DEFAULT_PREFERENCES
    from zhixing_next.growth_tools import goal_delivery_context

    preferences = {**DEFAULT_PREFERENCES, 'enabled': True}
    goal = {'status': 'active', 'next_check_at': '2026-10-24T00:20:00+08:00'}
    receipt = goal_delivery_context(preferences, goal)
    assert receipt['deferral_reasons'] == ['quiet_hours']
    assert receipt['not_before'] == '2026-10-24T00:00:00+00:00'
    assert '00:20' in receipt['confirmation'] and '08:00' in receipt['confirmation']
    assert '准点' in receipt['confirmation']
    preferences['snooze_until'] = '2026-10-24T23:00:00+08:00'
    receipt = goal_delivery_context(preferences, goal)
    assert receipt['deferral_reasons'] == ['snoozed', 'quiet_hours']
    assert receipt['not_before'] == '2026-10-25T00:00:00+00:00'


async def test_same_user_input_cannot_rewrite_saved_goal_using_new_entry_key(tmp_path):
    from uuid import NAMESPACE_URL, uuid5

    settings = make_settings(tmp_path)
    run = make_run('one-goal-input', '一小时后问我小说写得怎么样')
    identifier = str(uuid5(NAMESPACE_URL, f"growth:{run['message_id']}:goal:writing"))
    original_time = '2026-10-24T00:20:00+08:00'
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    model = ScriptedModel(replies=[
        call('save_personal_goal', {'changes': {'title': '完成初稿', 'next_check_at': original_time},
                                   'entry_key': 'writing'}, 'create'),
        call('save_personal_goal', {'changes': {'next_check_at': '2026-10-24T08:05:00+08:00'},
                                   'goal_id': identifier, 'entry_key': 'new-entry-cannot-reschedule'}, 'rewrite'),
        AIMessage(content='已保存原检查时间；消息须等免打扰结束后。'),
    ])
    await run_agent(settings, run, persona='', emit=emit, controls=no_controls,
                    acknowledge=ignore, model_override=model)
    store = Store(settings)
    goal = GrowthService(store).read_state()['goals'][0]
    assert goal['id'] == identifier and goal['next_check_at'] == original_time and goal['revision'] == 1
    assert any(data.get('error_code') == 'idempotency_conflict' for kind, data in events if kind == 'tool')
    with store._connection() as db:
        assert db.execute('SELECT COUNT(*) FROM growth_receipts').fetchone()[0] == 1
        assert db.execute('SELECT operation_key FROM growth_receipts').fetchone()[0] == f"growth:{run['message_id']}:goal:{identifier}"


async def test_new_applied_steer_can_change_same_goal_schedule(tmp_path):
    from uuid import NAMESPACE_URL, uuid5

    from zhixing_next.runtime import run_agent as actual_run_agent

    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation('目标引导')['id']
    store.submit_message(conversation, id='original-goal', content='明天下午四点问阅读进展')
    run = store.claim_next('chat')
    identifier = str(uuid5(NAMESPACE_URL, 'growth:original-goal:goal:reading'))
    guided = False

    async def emit(kind, data):
        nonlocal guided
        store.add_event(run['id'], kind, data)
        if kind == 'tool' and data.get('tool') == 'save_personal_goal' and data.get('status') == 'completed' and not guided:
            guided = True
            store.submit_message(conversation, id='goal-time-steer', content='改到明天下午五点',
                                 intent='steer', target_run_id=run['id'])

    async def controls():
        return store.get_controls(run['id'])

    async def acknowledge(ids):
        store.acknowledge_steers(run['id'], ids)

    model = ScriptedModel(replies=[
        call('save_personal_goal', {'changes': {'title': '阅读', 'next_check_at': '2026-10-24T16:00:00+08:00'},
                                   'entry_key': 'reading'}, 'create'),
        call('save_personal_goal', {'changes': {'next_check_at': '2026-10-24T17:00:00+08:00'},
                                   'goal_id': identifier, 'entry_key': 'same-goal-new-user-input'}, 'change'),
        AIMessage(content='已经按你的新要求改到五点。'),
    ])
    await actual_run_agent(settings, run, persona='', emit=emit, controls=controls,
                           acknowledge=acknowledge, model_override=model)
    goal = GrowthService(store).read_state()['goals'][0]
    assert guided and goal['next_check_at'] == '2026-10-24T17:00:00+08:00' and goal['revision'] == 2
    with store._connection() as db:
        keys = {row[0] for row in db.execute('SELECT operation_key FROM growth_receipts')}
    assert keys == {f'growth:original-goal:goal:{identifier}', f'growth:goal-time-steer:goal:{identifier}'}


async def test_failed_goal_save_can_be_corrected_before_any_receipt_commits(tmp_path):
    settings = make_settings(tmp_path)
    run = make_run('goal-validation-retry', '明天下午四点问阅读进展')
    model = ScriptedModel(replies=[
        call('save_personal_goal', {'changes': {'next_check_at': '2026-10-24T16:00:00+08:00'},
                                   'entry_key': 'reading'}, 'missing-title'),
        call('save_personal_goal', {'changes': {'title': '完成阅读', 'next_check_at': '2026-10-24T16:00:00+08:00'},
                                   'entry_key': 'reading'}, 'corrected'),
        AIMessage(content='阅读跟进已保存。'),
    ])
    await run_agent(settings, run, persona='', emit=ignore, controls=no_controls,
                    acknowledge=ignore, model_override=model)
    store = Store(settings)
    goals = GrowthService(store).read_state()['goals']
    assert len(goals) == 1 and goals[0]['title'] == '完成阅读' and goals[0]['revision'] == 1
    with store._connection() as db:
        assert db.execute('SELECT COUNT(*) FROM growth_receipts').fetchone()[0] == 1
