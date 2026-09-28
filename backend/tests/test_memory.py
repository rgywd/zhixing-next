import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage

from zhixing_next.config import Settings
from zhixing_next.memory import organize_run, relevant_memories
from zhixing_next.store import Store, StoreError


def setup(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work")
    return settings, Store(settings)


def complete(store, conversation_id, message_id, prompt, result="我理解了。"):
    store.submit_message(conversation_id, id=message_id, content=prompt)
    run = store.claim_next("chat")
    store.finish_run(run["id"], "completed", result=result)
    return run


def model(*actions):
    return FakeListChatModel(responses=[json.dumps({"actions": actions}, ensure_ascii=False)])


async def test_remember_correct_forget_and_cross_conversation_retrieval(tmp_path):
    settings, store = setup(tmp_path)
    first = store.create_conversation("设备")["id"]
    run = complete(store, first, "message-1", "记住，我的 Mac mini 是 16GB 内存")
    assert await organize_run(settings, store, run, model_override=model(
        {"op": "add", "content": "用户的 Mac mini 内存为 16GB"}
    ))
    saved = store.list_memories()["items"]
    assert len(saved) == 1 and saved[0]["source_message_id"] == "message-1"
    assert store.get_run(run["id"])["memory_processed"] == 1
    assert not await organize_run(settings, store, run, model_override=model())
    assert relevant_memories(store, "我的 Mac mini 内存是多少？")[0]["id"] == saved[0]["id"]

    second = store.create_conversation("另一个话题")["id"]
    corrected = complete(store, second, "message-2", "纠正一下，我的 Mac mini 其实是 24GB")
    assert await organize_run(settings, store, corrected, model_override=model(
        {"op": "replace", "id": saved[0]["id"], "content": "用户的 Mac mini 内存为 24GB"}
    ))
    assert store.list_memories()["items"][0]["content"].endswith("24GB")

    forgotten = complete(store, second, "message-3", "忘掉我 Mac mini 的内存配置")
    assert await organize_run(settings, store, forgotten, model_override=model(
        {"op": "forget", "id": saved[0]["id"]}
    ))
    assert store.list_memories()["items"] == []
    assert relevant_memories(store, "Mac mini 的内存？") == []


async def test_only_explicit_forget_and_no_credential_memory(tmp_path):
    settings, store = setup(tmp_path)
    saved = store.add_memory("用户喜欢简洁回答")
    conversation = store.create_conversation("普通聊天")["id"]
    run = complete(store, conversation, "message-1", "讲个笑话")
    assert await organize_run(settings, store, run, model_override=model(
        {"op": "forget", "id": saved["id"]},
        {"op": "add", "content": "用户的 API key 是 abc"},
    ))
    assert [item["id"] for item in store.list_memories()["items"]] == [saved["id"]]
    with pytest.raises(StoreError, match="credential"):
        store.add_memory("我的密码是 abc")


def test_failed_memory_pass_is_visible_and_retriable(tmp_path):
    _, store = setup(tmp_path)
    conversation = store.create_conversation("聊天")["id"]
    run = complete(store, conversation, "message-1", "记住我喜欢茶")
    store.fail_memory_run(run["id"])
    assert store.memory_status() == {"pending": 0, "failed": 1}
    assert store.retry_memory_runs() == 1
    assert store.next_memory_run()["id"] == run["id"]


async def test_trivial_greeting_needs_no_memory_model(tmp_path):
    settings, store = setup(tmp_path)
    conversation = store.create_conversation("打招呼")["id"]
    run = complete(store, conversation, "greeting", "你好")
    assert await organize_run(settings, store, run)
    assert store.memory_status() == {"pending": 0, "failed": 0}


async def test_forget_blocks_older_in_flight_run_from_recreating_memory(tmp_path):
    settings, store = setup(tmp_path)
    earlier = store.create_conversation("长任务")["id"]
    store.submit_message(earlier, id="old-message", content="我的旧设备是 A", kind="task")
    old_run = store.claim_next("task")
    saved = store.add_memory("用户的旧设备是 A")
    other = store.create_conversation("新会话")["id"]
    forgotten = complete(store, other, "forget-message", "忘记我的旧设备")
    assert await organize_run(settings, store, forgotten, model_override=model(
        {"op": "forget", "id": saved["id"]}
    ))
    store.finish_run(old_run["id"], "completed", result="旧任务完成")
    assert store.get_run(old_run["id"])["memory_processed"] == 1
    assert store.next_memory_run() is None


async def test_forget_does_not_reextract_from_retained_chat(tmp_path):
    settings, store = setup(tmp_path)
    conversation = store.create_conversation("设备")["id"]
    fact = "我的代号是蓝莓灯塔"
    first = complete(store, conversation, "fact", fact, result=f"收到，{fact}。")
    assert await organize_run(settings, store, first, model_override=model(
        {"op": "add", "content": fact}
    ))
    saved = store.list_memories()["items"][0]
    forgotten = complete(store, conversation, "forget", "忘记我的代号")
    assert await organize_run(settings, store, forgotten, model_override=model(
        {"op": "forget", "id": saved["id"]}
    ))
    later = complete(store, conversation, "later", "明天聊聊散步")
    observer = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(content='{"actions":[]}')))
    assert await organize_run(settings, store, later, model_override=observer)
    request = json.loads(observer.ainvoke.call_args.args[0][-1].content)
    assert fact not in json.dumps(request, ensure_ascii=False)
    assert request["recent_conversation"] == [{"role": "user", "content": "明天聊聊散步"}]
    assert store.list_memories()["items"] == []


async def test_explicit_memory_request_can_reference_last_answer_and_applied_steer(tmp_path):
    settings, store = setup(tmp_path)
    conversation = store.create_conversation("项目")["id"]
    previous = complete(store, conversation, "previous", "给这个项目取个名字", result="叫作青山计划。")
    assert await organize_run(settings, store, previous, model_override=model())
    current = complete(store, conversation, "remember", "记住这个")
    observer = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(content='{"actions":[]}')))
    assert await organize_run(settings, store, current, model_override=observer)
    request = json.loads(observer.ainvoke.call_args.args[0][-1].content)
    assert request["recent_conversation"] == [
        {"role": "assistant", "content": "叫作青山计划。"},
        {"role": "user", "content": "记住这个"},
    ]

    saved = store.add_memory("用户正在推进青山计划")
    store.submit_message(conversation, id="task", content="继续讨论项目")
    steered = store.claim_next("chat")
    store.submit_message(
        conversation, id="steer", content="忘记青山计划", intent="steer", target_run_id=steered["id"]
    )
    store.acknowledge_steers(steered["id"], ["steer"])
    store.finish_run(steered["id"], "completed", result="收到。")
    assert await organize_run(settings, store, steered, model_override=model(
        {"op": "forget", "id": saved["id"]}
    ))
    assert store.list_memories()["items"] == []
