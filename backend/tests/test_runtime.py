import asyncio
import sqlite3
from types import SimpleNamespace
from typing import Any

import aiosqlite
import pytest
from deepagents import create_deep_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field

from zhixing_next.config import ModelConfig, Settings
from zhixing_next.models import ModelConfigurationError, create_model
from zhixing_next.runtime import RunControls, RuntimeState, _prepare_checkpointer, run_agent
from zhixing_next.store import Store


class ScriptedModel(BaseChatModel):
    replies: list[AIMessage]
    seen: list[list[Any]] = Field(default_factory=list)
    bound_names: list[str] = Field(default_factory=list)
    entered: Any = None
    release: Any = None

    @property
    def _llm_type(self):
        return "scripted-test"

    def bind_tools(self, tools, **kwargs):
        self.bound_names = [
            tool.get("name") if isinstance(tool, dict) else tool.name for tool in tools
        ]
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(messages)
        return ChatResult(generations=[ChatGeneration(message=self.replies.pop(0))])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        if not self.seen and self.entered is not None:
            self.entered.set()
            await self.release.wait()
        return self._generate(messages, stop, run_manager, **kwargs)


def make_settings(tmp_path):
    return Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "workspaces")


def make_run(message_id="m1", prompt="hello"):
    return {
        "id": f"run-{message_id}",
        "conversation_id": "conversation-one",
        "message_id": message_id,
        "prompt": prompt,
        "kind": "chat",
    }


async def ignore(*args):
    return None


async def no_controls():
    return {"cancel_requested": False, "steers": []}


async def test_real_graph_file_tool_and_persistent_conversation(tmp_path):
    settings = make_settings(tmp_path)
    first = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "write_text_file",
                        "args": {"path": "result.txt", "content": "real file"},
                        "id": "tool-one",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="Written."),
        ]
    )
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    assert (
        await run_agent(
            settings,
            make_run(),
            persona="Be kind",
            emit=emit,
            controls=no_controls,
            acknowledge=ignore,
            model_override=first,
        )
        == "Written."
    )
    artifact = settings.workspace_root / "conversations" / "conversation-one" / "result.txt"
    assert artifact.read_text() == "real file"
    assert any(kind == "tool" and data["status"] == "completed" for kind, data in events)
    assert "execute" not in first.bound_names and "task" not in first.bound_names
    second = ScriptedModel(replies=[AIMessage(content="Remembered.")])
    await run_agent(
        settings,
        make_run("m2", "remember prior input"),
        persona="Be kind",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
        model_override=second,
    )
    assert [message.id for message in second.seen[0] if isinstance(message, HumanMessage)] == [
        "m1",
        "m2",
    ]


async def test_new_conversation_receives_relevant_personal_memory(tmp_path):
    settings = make_settings(tmp_path)
    Store(settings).add_memory("用户的 Mac mini 内存为 16GB")
    model = ScriptedModel(replies=[AIMessage(content="你的 Mac mini 是 16GB。")])
    run = make_run("other-message", "我的 Mac mini 内存是多少？")
    run["conversation_id"] = "other-conversation"
    assert await run_agent(settings, run, persona="", emit=ignore,
                           controls=no_controls, acknowledge=ignore,
                           model_override=model) == "你的 Mac mini 是 16GB。"
    assert "用户的 Mac mini 内存为 16GB" in str(model.seen[0])


async def test_agent_can_browse_paraphrased_memory_question(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("城市")["id"]
    city = None
    for note in ("用户居住在上海", "用户养一只橘猫", "用户在做知行项目", "用户喜欢跑步", "用户喜欢热茶"):
        saved = store.add_memory(note)
        if "上海" in note:
            city = saved["id"]
    model = ScriptedModel(replies=[
        AIMessage(content="", tool_calls=[{
            "name": "browse_personal_memories", "args": {"offset": 0},
            "id": "memory-lookup", "type": "tool_call",
        }]),
        AIMessage(content="你住在上海。"),
    ])
    run = make_run("city-question", "我现在在哪座城市生活？")
    run["conversation_id"] = conversation
    assert await run_agent(
        settings, run, persona="",
        emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model,
    ) == "你住在上海。"
    assert any("用户居住在上海" in str(message.content)
               for message in model.seen[-1] if isinstance(message, ToolMessage))
    store.delete_memory(city)
    assert store.memory_reset_revision(conversation) == 1


async def test_forget_clears_old_model_context_but_keeps_visible_chat(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    source = store.create_conversation("猫")["id"]
    unrelated = store.create_conversation("游戏攻略")["id"]

    def current(message_id, prompt, conversation_id=source):
        run = make_run(message_id, prompt)
        run["conversation_id"] = conversation_id
        return run

    saved = store.add_memory("用户的猫叫蓝莓灯塔")
    first = ScriptedModel(replies=[AIMessage(content="你的猫叫蓝莓灯塔。")])
    await run_agent(settings, current("first", "我家猫叫什么？"), persona="",
                    emit=ignore, controls=no_controls, acknowledge=ignore, model_override=first)
    other = ScriptedModel(replies=[AIMessage(content="先看地图。")])
    await run_agent(settings, current("other", "讲个游戏攻略", unrelated), persona="",
                    emit=ignore, controls=no_controls, acknowledge=ignore, model_override=other)

    forgetting = ScriptedModel(replies=[AIMessage(content="我会处理这条遗忘要求。")])
    await run_agent(settings, current("forget", "请忘记我家猫的名字"), persona="",
                    emit=ignore, controls=no_controls, acknowledge=ignore, model_override=forgetting)
    assert "蓝莓灯塔" not in str(forgetting.seen[0])
    assert "browse_personal_memories" not in forgetting.bound_names

    store.delete_memory(saved["id"])
    assert store.memory_reset_revision(source) == 1
    assert store.memory_reset_revision(unrelated) == 0
    later = ScriptedModel(replies=[AIMessage(content="我不知道。")])
    await run_agent(settings, current("later", "我家猫叫什么？"), persona="",
                    emit=ignore, controls=no_controls, acknowledge=ignore, model_override=later)
    assert "蓝莓灯塔" not in str(later.seen[0])
    other_later = ScriptedModel(replies=[AIMessage(content="继续攻略。")])
    await run_agent(settings, current("other-later", "继续", unrelated), persona="",
                    emit=ignore, controls=no_controls, acknowledge=ignore, model_override=other_later)
    assert any(isinstance(message, HumanMessage) and message.content == "讲个游戏攻略"
               for message in other_later.seen[0])


async def test_web_search_tool_is_bound_only_for_selected_run(tmp_path):
    settings = make_settings(tmp_path)
    enabled = make_run("search-on")
    enabled["search_provider"] = {"id": "provider-1", "name": "测试 Brave", "kind": "brave", "api_key": "test-secret"}
    first = ScriptedModel(replies=[AIMessage(content="完成")])
    await run_agent(settings, enabled, persona="", emit=ignore, controls=no_controls,
        acknowledge=ignore, model_override=first)
    assert "search_web" in first.bound_names
    disabled = make_run("search-off")
    second = ScriptedModel(replies=[AIMessage(content="完成")])
    await run_agent(settings, disabled, persona="", emit=ignore, controls=no_controls,
        acknowledge=ignore, model_override=second)
    assert "search_web" not in second.bound_names


async def test_named_subagent_delegation_and_direct_tool_boundary(tmp_path):
    settings = make_settings(tmp_path)
    finance = {
        "id": "finance", "name": "财务助手", "description": "讨论财务问题",
        "instructions": "不要猜金额", "tools": ["record_finance_observation", "list_finance_observations", "remove_finance_observation"],
    }
    delegated = make_run()
    delegated["agents"] = [finance]
    model = ScriptedModel(replies=[
        AIMessage(content="", tool_calls=[{
            "name": "task", "args": {"description": "梳理用户提供的收支", "subagent_type": "finance"},
            "id": "delegate-1", "type": "tool_call",
        }]),
        AIMessage(content="需要用户提供金额。"),
        AIMessage(content="财务助手说需要用户提供金额。"),
    ])
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    assert await run_agent(settings, delegated, persona="", emit=emit,
        controls=no_controls, acknowledge=ignore, model_override=model) == "财务助手说需要用户提供金额。"
    assert ("tool", {"tool": "task", "tool_call_id": "delegate-1", "status": "completed"}) in events
    direct = make_run("m2", "继续讨论")
    direct["conversation_id"] = Store(settings).create_conversation("财务", agent_id="finance")["id"]
    direct["agent"] = finance
    direct_model = ScriptedModel(replies=[
        AIMessage(content="", tool_calls=[{
            "name": "record_finance_observation",
            "args": {"kind": "balance", "platform": "支付宝", "amount": "20.50", "note": "用户口述"},
            "id": "finance-record", "type": "tool_call",
        }]),
        AIMessage(content="已记录用户口述余额。"),
    ])
    await run_agent(settings, direct, persona="", emit=ignore,
        controls=no_controls, acknowledge=ignore, model_override=direct_model)
    assert "task" not in direct_model.bound_names
    assert "write_text_file" not in direct_model.bound_names
    assert Store(settings).list_finance_observations()["balances"][0]["amount"] == "20.50"
    refused = make_run("m3", "不要委派未知助手")
    refused["conversation_id"] = "refused-agent"
    refused["agents"] = [finance]
    malicious = ScriptedModel(replies=[
        AIMessage(content="", tool_calls=[{
            "name": "task", "args": {"description": "尝试", "subagent_type": "general-purpose"},
            "id": "delegate-denied", "type": "tool_call",
        }]),
        AIMessage(content="无法调用未知助手。"),
    ])
    assert await run_agent(settings, refused, persona="", emit=ignore,
        controls=no_controls, acknowledge=ignore, model_override=malicious) == "无法调用未知助手。"


async def test_native_model_metadata_survives_checkpoint_and_is_removed_on_switch(
    tmp_path, monkeypatch
):
    settings = make_settings(tmp_path)
    config = ModelConfig(protocol="gemini", model="first", api_key_env="UNUSED_TEST_KEY")
    first = ScriptedModel(
        replies=[
            AIMessage(
                content=[
                    {
                        "type": "text",
                        "text": "answer",
                        "extras": {"signature": "opaque-test-signature"},
                    }
                ],
                additional_kwargs={"provider_state": "opaque-test-state"},
            )
        ]
    )
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *_: first)
    monkeypatch.setattr("zhixing_next.runtime.configured_model", lambda *_: ("test", config))
    await run_agent(
        settings, make_run(), persona="", emit=ignore, controls=no_controls, acknowledge=ignore
    )
    second = ScriptedModel(replies=[AIMessage(content="same provider")])
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *_: second)
    await run_agent(
        settings,
        make_run("m2", "continue"),
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
    )
    previous = next(message for message in second.seen[0] if isinstance(message, AIMessage))
    assert previous.additional_kwargs["provider_state"] == "opaque-test-state"
    assert previous.content[0]["extras"]["signature"] == "opaque-test-signature"
    config = ModelConfig(protocol="responses", model="second", api_key_env="UNUSED_TEST_KEY")
    third = ScriptedModel(replies=[AIMessage(content="new provider")])
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *_: third)
    await run_agent(
        settings,
        make_run("m3", "switch"),
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
    )
    previous = next(message for message in third.seen[0] if isinstance(message, AIMessage))
    assert previous.content == "answer"
    assert previous.additional_kwargs == {}


async def test_steer_replaces_obsolete_tool_decision_and_ack_is_durable(tmp_path):
    settings = make_settings(tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()
    model = ScriptedModel(
        entered=entered,
        release=release,
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "write_text_file",
                        "args": {"path": "must-not-exist.txt", "content": "obsolete"},
                        "id": "obsolete-tool",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="Applied the new instruction."),
        ],
    )
    steers = []
    acked = []

    async def controls():
        return {"cancel_requested": False, "steers": steers}

    async def acknowledge(ids):
        async with aiosqlite.connect(settings.data_dir / "checkpoints.sqlite") as connection:
            saver = await _prepare_checkpointer(connection)
            reader = create_deep_agent(
                model=ScriptedModel(replies=[]), checkpointer=saver, state_schema=RuntimeState
            )
            saved = await reader.aget_state({"configurable": {"thread_id": "conversation-one"}})
        assert set(ids) <= {message.id for message in saved.values["messages"]}
        acked.extend(ids)

    task = asyncio.create_task(
        run_agent(
            settings,
            make_run(),
            persona="",
            emit=ignore,
            controls=controls,
            acknowledge=acknowledge,
            model_override=model,
        )
    )
    await asyncio.wait_for(entered.wait(), 10)
    steers.append({"id": "steer-1", "content": "Do not create any file."})
    release.set()
    assert await task == "Applied the new instruction."
    assert acked == ["steer-1"]
    assert any(message.id == "steer-1" for message in model.seen[-1])
    assert not (
        settings.workspace_root / "conversations" / "conversation-one" / "must-not-exist.txt"
    ).exists()


async def test_cancellation_interrupts_inflight_model(tmp_path):
    entered, release = asyncio.Event(), asyncio.Event()
    model = ScriptedModel(entered=entered, release=release, replies=[AIMessage(content="too late")])
    task = asyncio.create_task(
        run_agent(
            make_settings(tmp_path),
            make_run(),
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=model,
        )
    )
    await asyncio.wait_for(entered.wait(), 10)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not model.seen


async def test_steer_at_tool_boundary_skips_operation(tmp_path):
    settings = make_settings(tmp_path)
    calls = 0

    async def controls():
        nonlocal calls
        calls += 1
        return {
            "cancel_requested": False,
            "steers": [{"id": "late-steer", "content": "Do not write."}] if calls >= 3 else [],
        }

    model = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "write_text_file",
                        "args": {"path": "stale.txt", "content": "stale"},
                        "id": "late-tool",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="Skipped."),
        ]
    )
    await run_agent(
        settings,
        make_run(),
        persona="",
        emit=ignore,
        controls=controls,
        acknowledge=ignore,
        model_override=model,
    )
    assert not (
        settings.workspace_root / "conversations" / "conversation-one" / "stale.txt"
    ).exists()
    assert any(message.id == "late-steer" for message in model.seen[-1])


async def test_cancel_waits_for_started_file_operation_to_settle():
    entered, release = asyncio.Event(), asyncio.Event()
    events = []

    async def emit(kind, data):
        events.append(data)

    async def handler(request):
        entered.set()
        await release.wait()
        return "written"

    request = SimpleNamespace(
        tool_call={"id": "one", "name": "write_text_file"}, state={"messages": []}
    )
    task = asyncio.create_task(RunControls(no_controls, emit).awrap_tool_call(request, handler))
    await entered.wait()
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert events[-1]["status"] == "completed" and events[-1]["cancel_requested"]


async def test_cancel_interrupts_async_web_tool_without_waiting_for_response():
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def handler(request):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    request = SimpleNamespace(
        tool_call={"id": "web", "name": "fetch_public_page"}, state={"messages": []}
    )
    task = asyncio.create_task(RunControls(no_controls, ignore).awrap_tool_call(request, handler))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 0.5)
    assert cancelled.is_set()


async def test_concurrent_conversations_and_safe_checkpoint_journal(tmp_path, monkeypatch):
    monkeypatch.setattr("zhixing_next.runtime.safe_journal_mode", lambda: "DELETE")
    settings = make_settings(tmp_path)
    runs = [
        make_run("one"),
        {**make_run("two"), "conversation_id": "conversation-two", "kind": "task"},
    ]
    results = await asyncio.gather(
        *[
            run_agent(
                settings,
                run,
                persona="",
                emit=ignore,
                controls=no_controls,
                acknowledge=ignore,
                model_override=ScriptedModel(replies=[AIMessage(content=run["id"])]),
            )
            for run in runs
        ]
    )
    assert results == ["run-one", "run-two"]
    with sqlite3.connect(settings.data_dir / "checkpoints.sqlite") as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "delete"


@pytest.mark.parametrize("protocol", ["chat_completions", "responses", "gemini"])
def test_protocol_selection_without_network(tmp_path, monkeypatch, protocol):
    monkeypatch.setenv("ZHIXING_TEST_MODEL_KEY", "placeholder-for-unit-test-only")
    settings = make_settings(tmp_path)
    settings.models = {
        "primary": ModelConfig(
            protocol=protocol,
            model="test-model",
            api_key_env="ZHIXING_TEST_MODEL_KEY",
            base_url="https://example.invalid/v1",
            reasoning_effort="none" if protocol != "gemini" else None,
        )
    }
    settings.roles = {"chat": "primary"}
    model = create_model(settings, "chat")
    if protocol == "gemini":
        assert type(model).__name__ == "ChatGoogleGenerativeAI"
        assert model.base_url == "https://example.invalid/v1"
    else:
        assert model.use_responses_api == (protocol == "responses")
        assert model.reasoning_effort == "none"
    monkeypatch.delenv("ZHIXING_TEST_MODEL_KEY")
    with pytest.raises(ModelConfigurationError):
        create_model(settings, "chat")


def test_selected_model_and_thinking_depth_reach_protocol_client(tmp_path, monkeypatch):
    monkeypatch.setenv("ZHIXING_TEST_MODEL_KEY", "placeholder-for-unit-test-only")
    settings = make_settings(tmp_path)
    settings.models = {
        "one": ModelConfig(
            protocol="chat_completions", model="chat-one", api_key_env="ZHIXING_TEST_MODEL_KEY",
            reasoning_effort="none", reasoning_levels=["auto", "none", "high"],
        ),
        "two": ModelConfig(
            protocol="responses", model="chat-two", api_key_env="ZHIXING_TEST_MODEL_KEY",
            reasoning_levels=["auto", "high"],
        ),
        "gemini": ModelConfig(
            protocol="gemini", model="gemini-3-test", api_key_env="ZHIXING_TEST_MODEL_KEY",
            reasoning_levels=["auto", "low", "high"],
        ),
    }
    settings.roles = {"chat": "one"}
    assert create_model(settings, "chat", "two", "high").reasoning_effort == "high"
    assert create_model(settings, "chat", "one", "auto").reasoning_effort is None
    assert create_model(settings, "chat", "gemini", "low").reasoning_effort == "low"
    with pytest.raises(ModelConfigurationError, match="thinking depth"):
        create_model(settings, "chat", "gemini", "none")
