import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage
from test_memory import complete, model, setup
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.memory import create_memory_read_tools, organize_run, relevant_memories
from zhixing_next.store import Store, StoreError


def tools_for(store, conversation):
    return {item.name: item for item in create_memory_read_tools(store, conversation)}


def test_old_relationship_is_searchable_without_exposing_unrelated_memories(tmp_path):
    _, store = setup(tmp_path)
    saved = store.add_memory('用户的朋友林岚喜欢陶艺，周末常一起去陶艺工作室')
    for index in range(230):
        store.add_memory(f'用户收藏的编号 {index}')
    conversation = store.create_conversation('给朋友挑礼物')['id']
    reader = tools_for(store, conversation)
    result = reader['search_personal_memories'].invoke({'query': '林岚 喜欢什么'})
    assert [item['id'] for item in result['items']] == [saved['id']]
    assert relevant_memories(store, '林岚有什么兴趣？')[0]['id'] == saved['id']
    assert reader['search_personal_memories'].invoke({'query': '不存在的紫色企鹅'}) == {
        'items': [], 'next_offset': None,
    }
    store.update_memory(saved['id'], '用户的朋友林岚现在更喜欢木工')
    assert store.memory_reset_revision(conversation) == 1


def test_search_pagination_is_literal_and_only_records_returned_exposures(tmp_path):
    _, store = setup(tmp_path)
    for index in range(26):
        store.add_memory(f'用户喜欢茶具款式 {index}')
    unrelated = store.add_memory('用户使用 SQLite')
    conversation = store.create_conversation('茶具')['id']
    reader = tools_for(store, conversation)
    first = reader['search_personal_memories'].invoke({'query': '茶具'})
    second = reader['search_personal_memories'].invoke({'query': '茶具', 'offset': first['next_offset']})
    assert len(first['items']) == 25 and len(second['items']) == 1
    assert second['next_offset'] is None
    assert not ({item['id'] for item in first['items']} & {item['id'] for item in second['items']})
    assert store.search_memories("%_'; DROP TABLE memories; --")['items'] == []
    store.delete_memory(unrelated['id'])
    assert store.memory_reset_revision(conversation) == 0
    store.delete_memory(second['items'][0]['id'])
    assert store.memory_reset_revision(conversation) == 1


async def test_organizer_finds_old_fact_and_updates_its_source(tmp_path):
    settings, store = setup(tmp_path)
    original = store.create_conversation('原来')['id']
    complete(store, original, 'old', '我的朋友林岚喜欢陶艺')
    saved = store.add_memory('用户的朋友林岚喜欢陶艺', source_message_id='old')
    for index in range(220):
        store.add_memory(f'用户收藏的编号 {index}')
    conversation = store.create_conversation('后来')['id']
    run = complete(store, conversation, 'new', '纠正一下，林岚现在喜欢木工，不做陶艺了')
    observer = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(content=json.dumps({'actions': [{
        'op': 'replace', 'id': saved['id'], 'content': '用户的朋友林岚现在喜欢木工，已不做陶艺',
        'source_message_id': 'new',
    }]}, ensure_ascii=False))))
    assert await organize_run(settings, store, run, model_override=observer)
    request = json.loads(observer.ainvoke.call_args.args[0][-1].content)
    assert saved['id'] in {item['id'] for item in request['existing_memories']}
    reader_conversation = store.create_conversation('回溯')['id']
    reader = tools_for(store, reader_conversation)
    current = reader['read_personal_memory'].invoke({'memory_id': saved['id']})
    assert current['source']['message_id'] == 'new'
    assert current['source']['conversation_id'] == conversation
    assert '木工' in current['content']
    assert store.memory_reset_revision(original) == 1
    store.delete_memory(saved['id'])
    assert store.memory_reset_revision(reader_conversation) == 1
    with pytest.raises(StoreError):
        reader['read_personal_memory'].invoke({'memory_id': saved['id']})
    assert not store.search_memories('林岚')['items']


async def test_source_is_bound_to_applied_user_message_not_another_chat(tmp_path):
    settings, store = setup(tmp_path)
    other = store.create_conversation('无关')['id']
    complete(store, other, 'other-message', '这不是本轮来源')
    conversation = store.create_conversation('设备')['id']
    store.submit_message(conversation, id='initial', content='我的电脑是 16GB')
    run = store.claim_next('chat')
    store.submit_message(conversation, id='steer', content='更正为 24GB', intent='steer', target_run_id=run['id'])
    store.acknowledge_steers(run['id'], ['steer'])
    store.finish_run(run['id'], 'completed', result='收到')
    assert await organize_run(settings, store, run, model_override=model(
        {'op': 'add', 'content': '用户电脑为 24GB', 'source_message_id': 'steer'},
        {'op': 'add', 'content': '不该保存的异源事实', 'source_message_id': 'other-message'},
    ))
    saved = store.list_memories()['items']
    assert len(saved) == 1 and saved[0]['source_message_id'] == 'steer'
    store.update_memory(saved[0]['id'], '用户电脑为 32GB')
    assert store.get_memory(saved[0]['id'])['source'] is None
    assert store.get_memory(saved[0]['id'])['source_message_id'] is None


@pytest.mark.parametrize('direct', [False, True])
async def test_real_graph_reads_old_memory_and_source_without_write_access(tmp_path, direct):
    settings = make_settings(tmp_path)
    store = Store(settings)
    saved = store.add_memory('用户的朋友林岚喜欢陶艺')
    for index in range(210):
        store.add_memory(f'用户收藏的编号 {index}')
    run = make_run('recall', '林岚喜欢什么？')
    if direct:
        run['agent'] = store.get_agent('finance')
    agent_model = ScriptedModel(replies=[
        AIMessage(content='', tool_calls=[{
            'name': 'search_personal_memories', 'args': {'query': '林岚'}, 'id': 'search', 'type': 'tool_call',
        }]),
        AIMessage(content='', tool_calls=[{
            'name': 'read_personal_memory', 'args': {'memory_id': saved['id']}, 'id': 'read', 'type': 'tool_call',
        }]),
        AIMessage(content='林岚喜欢陶艺。'),
    ])
    assert await fixture_run_agent(settings, run, persona='', emit=ignore, controls=no_controls,
                                   acknowledge=ignore, model_override=agent_model) == '林岚喜欢陶艺。'
    from langchain_core.messages import ToolMessage
    receipts = [json.loads(item.content) for item in agent_model.seen[-1] if isinstance(item, ToolMessage)]
    assert receipts[0]['items'][0]['id'] == saved['id']
    assert receipts[1]['content'] == saved['content']
    assert not {'write_personal_memory', 'delete_personal_memory'} & set(agent_model.bound_names)


@pytest.mark.parametrize('reader_name', ['search_personal_memories', 'read_personal_memory'])
@pytest.mark.parametrize('operation', ['replace', 'forget'])
def test_new_readers_detect_correction_or_forget_during_read(tmp_path, monkeypatch, reader_name, operation):
    _, store = setup(tmp_path)
    saved = store.add_memory('用户的朋友林岚喜欢陶艺')
    conversation = store.create_conversation('读取中')['id']
    reader = tools_for(store, conversation)[reader_name]
    method = 'search_memories' if reader_name == 'search_personal_memories' else 'get_memory'
    original = getattr(store, method)

    def racing_read(*args, **kwargs):
        result = original(*args, **kwargs)
        if operation == 'replace':
            store.update_memory(saved['id'], '用户的朋友林岚喜欢木工')
        else:
            store.delete_memory(saved['id'])
        return result

    monkeypatch.setattr(store, method, racing_read)
    reader.invoke({'query': '林岚'} if reader_name == 'search_personal_memories' else {'memory_id': saved['id']})
    assert store.memory_reset_revision(conversation) == 1
    assert all('陶艺' not in item['content'] for item in store.list_memories()['items'])


async def test_specific_missing_fact_never_injects_unrelated_notes_and_stops_broad_browse(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    store.add_memory('无关的紫色占位资料，仅供测试')
    assert relevant_memories(store, '你还记得岚岚喜欢什么吗？仅根据保存的记忆回答。') == []
    assert relevant_memories(store, '你记得我什么？')
    agent_model = ScriptedModel(replies=[
        AIMessage(content='', tool_calls=[{
            'name': 'search_personal_memories', 'args': {'query': '岚岚'}, 'id': 'missing', 'type': 'tool_call',
        }]),
        AIMessage(content='没有找到相关已保存信息。'),
    ])
    await fixture_run_agent(settings, make_run('missing-person', '岚岚喜欢什么？'), persona='',
                            emit=ignore, controls=no_controls, acknowledge=ignore, model_override=agent_model)
    assert 'browse_personal_memories' not in agent_model.bound_names
    assert 'search_personal_memories' in agent_model.bound_names
    assert '紫色占位资料' not in str(agent_model.seen[-1])
    next_model = ScriptedModel(replies=[AIMessage(content='可以查看保存的记忆。')])
    await fixture_run_agent(settings, make_run('broad-person', '你记得我什么？'), persona='',
                            emit=ignore, controls=no_controls, acknowledge=ignore, model_override=next_model)
    assert 'browse_personal_memories' in next_model.bound_names
