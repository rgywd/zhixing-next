import json

import pytest
from langchain_core.messages import AIMessage
from test_memory import complete, model, setup
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.memory import create_memory_read_tools, organize_run, personal_memory_context
from zhixing_next.store import Store


@pytest.mark.parametrize("agent_id", [None, "finance", "health"])
async def test_old_global_preference_reaches_main_and_specialists_without_personal_leak(tmp_path, agent_id):
    settings = make_settings(tmp_path)
    store = Store(settings)
    preference = store.add_memory("用户偏好回答先给结论，再用简短中文说明")
    private = store.add_memory("阿岚是用户的伴侣，不喜欢香菜")
    for index in range(230):
        store.add_memory(f"隔离样例编号 {index} 喜欢紫色陶罐")
    run = make_run("ordinary", "解释一下为什么天空是蓝色的")
    if agent_id:
        run["agent"] = store.get_agent(agent_id)
    observer = ScriptedModel(replies=[AIMessage(content="因为空气会散射阳光。")])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls,
                            acknowledge=ignore, model_override=observer)
    supplied = str(observer.seen[0])
    assert preference["content"] in supplied
    assert private["content"] not in supplied
    assert "紫色陶罐" not in supplied
    store.update_memory(preference["id"], "用户偏好详细解释回答")
    assert store.memory_reset_revision(run["conversation_id"]) == 1
    store.delete_memory(private["id"])
    assert store.memory_reset_revision(run["conversation_id"]) == 1


def test_role_recall_tracks_the_relationship_even_when_result_page_only_has_other_fact(tmp_path):
    _, store = setup(tmp_path)
    relation = store.add_memory("阿岚是用户的伴侣")
    for index in range(30):
        store.add_memory(f"阿岚的周末偏好记录 {index} 是散步")
    conversation = store.create_conversation("与对象度周末")["id"]
    tool = next(item for item in create_memory_read_tools(store, conversation)
                if item.name == "search_personal_memories")
    result = tool.invoke({"query": "我对象的周末偏好", "offset": 25})
    assert any("阿岚" in item["content"] for item in result["items"])
    assert relation["id"] in {item["id"] for item in result["recall_context"]["facts"]}
    store.update_memory(relation["id"], "阿岚是用户的前伴侣，现已分开")
    assert store.memory_reset_revision(conversation) == 1


async def test_runtime_marks_ambiguous_and_former_titles_without_picking_a_person(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    store.add_memory("小林是用户的同事")
    store.add_memory("小周是用户的同事")
    store.add_memory("小林喜欢抹茶")
    store.add_memory("小周喜欢咖啡")
    observer = ScriptedModel(replies=[AIMessage(content="你指哪位同事？")])
    await fixture_run_agent(settings, make_run("ambiguous", "给我同事送什么饮品？"), persona="",
                            emit=ignore, controls=no_controls, acknowledge=ignore,
                            model_override=observer)
    supplied = str(observer.seen[0])
    assert "multiple people" in supplied and "同事" in supplied
    assert "小林喜欢抹茶" not in supplied and "小周喜欢咖啡" not in supplied
    store.add_memory("阿岚是用户的前伴侣，现已分开")
    context = personal_memory_context(store, "我对象喜欢什么？")
    assert context["blocked_aliases"]
    assert not any("阿岚" in fact["content"] for fact in context["support"])


async def test_core_read_racing_with_correction_invalidates_next_context(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    store = Store(settings)
    preference = store.add_memory("用户偏好简短回答")
    original = Store.core_memory_candidates
    corrected = False

    def racing_core(self):
        nonlocal corrected
        facts = original(self)
        if not corrected:
            corrected = True
            self.update_memory(preference["id"], "用户偏好详细回答")
        return facts

    monkeypatch.setattr(Store, "core_memory_candidates", racing_core)
    observer = ScriptedModel(replies=[AIMessage(content="示例。")])
    run = make_run("racing-core", "解释光的散射")
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls,
                            acknowledge=ignore, model_override=observer)
    assert store.memory_reset_revision(run["conversation_id"]) == 1


@pytest.mark.parametrize("agent_id,route", [("finance", "finance"), ("health", "agent_health")])
async def test_named_delegated_specialist_receives_same_bounded_personal_context(tmp_path, agent_id, route):
    settings = make_settings(tmp_path)
    store = Store(settings)
    store.add_memory("用户偏好回答先给结论，再用简短中文说明")
    store.add_memory("阿岚是用户的伴侣，不喜欢香菜")
    run = make_run("delegate", "我对象有什么饮食偏好？只读回答")
    run["agents"] = [store.get_agent(agent_id)]
    observer = ScriptedModel(replies=[
        AIMessage(content="", tool_calls=[{
            "name": "task", "args": {"subagent_type": route, "description": "只读回答对象的饮食偏好"},
            "id": "specialist", "type": "tool_call",
        }]),
        AIMessage(content="阿岚不喜欢香菜。"),
        AIMessage(content="阿岚不喜欢香菜。"),
    ])
    await fixture_run_agent(settings, run, persona="", emit=ignore, controls=no_controls,
                            acknowledge=ignore, model_override=observer)
    assert len(observer.seen) == 3
    child_context = str(observer.seen[1])
    assert "用户偏好回答先给结论，再用简短中文说明" in child_context
    assert "阿岚是用户的伴侣，不喜欢香菜" in child_context


def test_ambiguous_role_decision_tracks_candidates_without_disclosing_private_preferences(tmp_path):
    _, store = setup(tmp_path)
    first = store.add_memory("小林是用户的同事")
    second = store.add_memory("小周是用户的同事")
    store.add_memory("小林喜欢抹茶")
    conversation = store.create_conversation("歧义")["id"]
    tool = next(item for item in create_memory_read_tools(store, conversation)
                if item.name == "search_personal_memories")
    result = tool.invoke({"query": "我同事喜欢什么？"})
    assert result["recall_context"]["ambiguous_aliases"]
    assert "小林喜欢抹茶" not in str(result)
    assert "_recall_dependencies" not in result
    store.delete_memory(second["id"])
    assert store.memory_reset_revision(conversation) == 1
    store.update_memory(first["id"], "小林是用户的前同事")


@pytest.mark.parametrize("query", [
    "她喜欢什么？", "今晚跟她吃什么？", "他有什么爱好？", "告诉我她喜欢什么？", "你知道他喜欢什么吗？",
])
def test_pronoun_alone_does_not_inject_any_persons_private_facts(tmp_path, query):
    _, store = setup(tmp_path)
    store.add_memory("阿岚是用户的伴侣")
    store.add_memory("阿岚喜欢咖啡")
    store.add_memory("小周是用户的同事，喜欢抹茶")
    context = personal_memory_context(store, query)
    assert context["related"] == [] and context["support"] == []
    assert not context["ambiguous_aliases"]


@pytest.mark.parametrize("query", ["我那个朋友喜欢什么？", "我的那位同事喜欢什么？"])
def test_qualified_ambiguous_titles_do_not_fall_back_to_generic_likes(tmp_path, query):
    _, store = setup(tmp_path)
    store.add_memory("阿岚是用户的朋友，喜欢咖啡")
    store.add_memory("小周是用户的朋友，喜欢抹茶")
    store.add_memory("阿岚是用户的同事")
    store.add_memory("小周是用户的同事")
    context = personal_memory_context(store, query)
    assert context["ambiguous_aliases"]
    assert context["related"] == [] and context["support"] == []


@pytest.mark.parametrize("query", ["其他", "吉他", "维他命", "利他", "排他", "他山之石"])
def test_nonperson_words_do_not_become_pronoun_queries(tmp_path, query):
    _, store = setup(tmp_path)
    saved = store.add_memory(f"用户想了解{query}")
    assert [item["id"] for item in store.search_memories(query)["items"]] == [saved["id"]]


async def test_organizer_can_correct_old_person_via_title_and_forget_without_resurrection(tmp_path):
    settings, store = setup(tmp_path)
    relation = store.add_memory("阿岚是用户的伴侣，不喜欢香菜")
    style = store.add_memory("用户偏好回答先给结论，再用简短中文说明")
    for index in range(230):
        store.add_memory(f"较新的无关样例 {index}")
    conversation = store.create_conversation("纠正对象偏好")["id"]
    run = complete(store, conversation, "correction", "纠正一下，我对象只是偏好少放香菜，没有忌口")
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    organizer = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(content=json.dumps({
        "actions": [{"op": "replace", "id": relation["id"],
                     "content": "阿岚是用户的伴侣，偏好少放香菜，没有相关忌口", "source_message_id": "correction"}],
    }, ensure_ascii=False))))
    assert await organize_run(settings, store, run, model_override=organizer)
    supplied = json.loads(organizer.ainvoke.call_args.args[0][-1].content)
    assert relation["id"] in {item["id"] for item in supplied["existing_memories"]}
    forgotten = complete(store, conversation, "forget", "忘掉我对象的饮食偏好，保留人物关系和表达偏好")
    assert await organize_run(settings, store, forgotten, model_override=model({
        "op": "replace", "id": relation["id"], "content": "阿岚是用户的伴侣", "source_message_id": "forget",
    }))
    context = personal_memory_context(store, "我对象吃什么？")
    facts = [*context["related"], *context["support"]]
    assert any("阿岚" in fact["content"] for fact in facts)
    assert all("香菜" not in fact["content"] for fact in facts)
    assert style["id"] in {item["id"] for item in context["core"]}
