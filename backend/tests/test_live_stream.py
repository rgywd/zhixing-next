"""Actual LangGraph streaming, durable cursors and unchanged final-message semantics."""

import asyncio

import httpx
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGenerationChunk
from pydantic import Field

from zhixing_next.config import Settings
from zhixing_next.live_stream import MAX_EVENT_BYTES, MAX_TEXT, LiveModelStream, visible_parts
from zhixing_next.resilience import RunBudget, RunLimitError
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store


class StreamingModel(BaseChatModel):
    plans: list = Field(default_factory=list)
    pauses: dict = Field(default_factory=dict)
    calls: int = 0

    @property
    def _llm_type(self):
        return "real-stream-test"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, *args, **kwargs):
        raise AssertionError("messages mode must use the native stream")

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        call = self.calls
        self.calls += 1
        for index, value in enumerate(self.plans[call]):
            if isinstance(value, Exception):
                raise value
            yield ChatGenerationChunk(message=value)
            if pair := self.pauses.get((call, index)):
                pair[0].set()
                await pair[1].wait()
            await asyncio.sleep(0)


def chunk(text="", reasoning=None, **kwargs):
    return AIMessageChunk(content=text, additional_kwargs={} if reasoning is None else {"reasoning_content": reasoning}, **kwargs)


def setup_run(tmp_path, *, limits=None):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work", **({"limits": limits} if limits else {}))
    store = Store(settings)
    conversation = store.create_conversation("流式测试")
    store.submit_message(conversation["id"], id="request", content="只检查测试目录", kind="chat")
    return settings, store, store.claim_next("chat")


async def execute(settings, store, run, model, on_emit=None):
    async def emit(kind, data):
        store.add_event(run["id"], kind, data)
        if on_emit:
            await on_emit(kind, data)

    async def controls():
        return store.get_controls(run["id"])

    async def acknowledge(ids):
        store.acknowledge_steers(run["id"], ids)

    return await run_agent(settings, run, persona="SYSTEM-PRIVATE-ONLY", emit=emit,
                           controls=controls, acknowledge=acknowledge, model_override=model)


def events(store, run):
    return store.list_events(run["id"], limit=1000)["items"]


async def test_real_graph_text_reasoning_and_tool_events_arrive_before_final_message(tmp_path):
    settings, store, run = setup_run(tmp_path)
    entered, release, observed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    model = StreamingModel(plans=[
        [chunk(reasoning="先核对测试目录。"), chunk("我先核对。"), chunk(tool_call_chunks=[{"name": "list_directory", "args": '{"path":"."}', "id": "list-fixture", "index": 0}], usage_metadata={"input_tokens": 5, "output_tokens": 3, "total_tokens": 8})],
        [chunk("目录"), chunk("已核对。", usage_metadata={"input_tokens": 7, "output_tokens": 4, "total_tokens": 11})],
    ], pauses={(1, 0): (entered, release)})

    async def on_emit(kind, data):
        if kind == "assistant.snapshot" and data["text"] == "目录":
            observed.set()

    task = asyncio.create_task(execute(settings, store, run, model, on_emit))
    await asyncio.wait_for(entered.wait(), 5)
    await asyncio.wait_for(observed.wait(), 5)
    assert not task.done()
    current = events(store, run)
    live = [item for item in current if item["type"] in {"assistant.snapshot", "reasoning.snapshot"}]
    assert any(item["type"] == "reasoning.snapshot" and item["data"]["text"] == "先核对测试目录。" for item in live)
    assert {item["data"]["status"] for item in current if item["type"] == "tool"} >= {"started", "completed"}
    assert len({item["data"]["message_id"] for item in live}) == 2
    assert all(set(item["data"]) == {"stream_id", "message_id", "text"} for item in live)
    assert "SYSTEM-PRIVATE-ONLY" not in str(current)
    assert not any(item["type"] == "completed" for item in current)
    release.set()
    answer = await task
    assert answer == "目录已核对。"
    assert [item["data"]["text"] for item in events(store, run) if item["type"] == "assistant.snapshot"][-1] == answer
    usage = RunBudget(store, run["id"]).summary()
    assert (usage["model_attempts"], usage["input_tokens"], usage["output_tokens"], usage["unknown_usage"]) == (2, 12, 7, 0)
    store.finish_run(run["id"], "completed", result=answer)
    store.finish_run(run["id"], "completed", result="must not duplicate")
    with store._connection() as db:
        assert db.execute("SELECT COUNT(*) FROM messages WHERE run_id=? AND role='assistant'", (run["id"],)).fetchone()[0] == 1
    process = store.reply_processes(run["conversation_id"], [run["id"]])["items"][0]
    assert [part["type"] for part in process["parts"]] == ["reasoning", "text", "tool", "text"]
    assert process["parts"][-1]["id"] == process["final_part_id"]
    assert process["parts"][-1]["text"] == answer
    first = store.list_events(run["id"], limit=2)
    remaining = store.list_events(run["id"], after=first["items"][-1]["seq"], limit=1000)
    assert all(item["seq"] > first["items"][-1]["seq"] for item in remaining["items"])
    assert len({item["seq"] for item in first["items"] + remaining["items"]}) == len(events(store, run))


async def test_recovery_resets_uncommitted_partial_without_replaying_it_as_a_message(tmp_path):
    settings, store, run = setup_run(tmp_path)
    entered, release, observed = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def on_emit(kind, data):
        if kind == "assistant.snapshot":
            observed.set()

    original = StreamingModel(plans=[[chunk("未确认的旧片段"), chunk("不可到达")]], pauses={(0, 0): (entered, release)})
    task = asyncio.create_task(execute(settings, store, run, original, on_emit))
    await asyncio.wait_for(observed.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    store.recover_interrupted()
    resumed = store.claim_next("chat")
    assert resumed["id"] == run["id"]
    answer = await execute(settings, store, resumed, StreamingModel(plans=[[chunk("恢复后的真实结果")]]))
    assert answer == "恢复后的真实结果"
    resets = [item for item in events(store, run) if item["type"] == "assistant.reset"]
    assert len(resets) == 2 and resets[0]["data"]["stream_id"] != resets[1]["data"]["stream_id"]
    later = [item for item in events(store, run) if item["seq"] > resets[-1]["seq"] and item["type"] == "assistant.snapshot"]
    assert later and all(item["data"]["stream_id"] == resets[-1]["data"]["stream_id"] for item in later)
    assert "未确认的旧片段" not in str(later)
    store.finish_run(run["id"], "completed", result=answer)
    with store._connection() as db:
        assert [row[0] for row in db.execute("SELECT content FROM messages WHERE run_id=? AND role='assistant'", (run["id"],))] == [answer]


async def test_retry_uses_new_message_identity_and_stream_usage_still_limits_tools(tmp_path):
    settings, store, run = setup_run(tmp_path)
    settings.limits.retry_base_seconds = 0
    answer = await execute(settings, store, run, StreamingModel(plans=[
        [chunk("失败请求的未确认内容", id="provider-reuses-id"), httpx.ConnectError("PRIVATE PROVIDER PAYLOAD")],
        [chunk("重新生成的回答", id="provider-reuses-id", usage_metadata={"input_tokens": 3, "output_tokens": 2, "total_tokens": 5})],
    ]))
    assert answer == "重新生成的回答"
    snapshots = [item["data"] for item in events(store, run) if item["type"] == "assistant.snapshot"]
    assert len(snapshots) == 2 and snapshots[0]["message_id"] != snapshots[1]["message_id"]
    assert snapshots[-1]["text"] == answer
    attempts = [item["data"] for item in events(store, run) if item["type"] == "assistant.attempt"]
    assert [item["status"] for item in attempts] == ["failed", "completed"]
    process = store.reply_processes(run["conversation_id"], [run["id"]])["items"][0]
    assert [part["attempt_status"] for part in process["parts"] if part["type"] == "text"] == ["failed", "completed"]
    assert "PRIVATE PROVIDER PAYLOAD" not in str(events(store, run))
    assert RunBudget(store, run["id"]).summary()["unknown_usage"] == 1

    settings, store, run = setup_run(tmp_path / "limited", limits={"total_tokens": 5})
    model = StreamingModel(plans=[[chunk(tool_call_chunks=[{"name": "list_directory", "args": '{"path":"."}', "id": "limited-tool", "index": 0}], usage_metadata={"input_tokens": 3, "output_tokens": 2, "total_tokens": 5})]])
    with pytest.raises(RunLimitError, match="token"):
        await execute(settings, store, run, model)
    assert model.calls == 1
    assert not any(item["type"] == "tool" and item["data"]["status"] == "started" for item in events(store, run))


async def test_stream_projection_filters_untrusted_fields_and_is_bounded():
    recorded = []

    async def emit(kind, data):
        recorded.append((kind, data))

    live = LiveModelStream(emit, clock=lambda: 0)
    await live.start()
    metadata = {"langgraph_node": "model", "zhixing_live_model_id": "one"}
    await live.receive(HumanMessage(content="SYSTEM OR USER PRIVATE"), metadata)
    await live.receive(ToolMessage(content="SECRET TOOL OUTPUT", tool_call_id="one"), metadata)
    await live.receive(AIMessage(content="INTERNAL SUMMARY"), {**metadata, "langgraph_node": "before_model"})
    await live.receive(AIMessage(content="INTERNAL SUMMARY"), {**metadata, "lc_source": "summarization"})
    await live.receive(AIMessage(content="HIDDEN MODEL"), {**metadata, "tags": ["langsmith:nostream"]})
    message = AIMessageChunk(content=[{"type": "text", "text": "正文"}, {"type": "reasoning", "reasoning": "实际思考", "signature": "NEVER"}, {"type": "tool_use", "input": "NEVER ARGS"}], additional_kwargs={"private": "NEVER REQUEST"})
    await live.receive(message, metadata)
    await live.receive(chunk("x" * (MAX_TEXT * 2)), metadata)
    await live.flush()
    assert all(len(item["text"]) <= MAX_TEXT for _, item in recorded if "text" in item)
    assert "NEVER" not in str(recorded) and "PRIVATE" not in str(recorded) and "INTERNAL" not in str(recorded)
    assert any(kind == "reasoning.snapshot" and item["text"] == "实际思考" for kind, item in recorded)
    size = len(recorded)
    await live.flush()
    assert len(recorded) == size
    await live.receive(chunk("😀" * MAX_TEXT), {**metadata, "zhixing_live_model_id": "emoji"})
    emoji = recorded[-1][1]
    assert 0 < len(emoji["text"].encode("utf-16-le")) // 2 <= MAX_TEXT
    assert emoji["truncated"] is True
    for i in range(70):
        await live.receive(chunk("r" * MAX_TEXT), {**metadata, "zhixing_live_model_id": str(i)})
    assert live.bytes <= MAX_EVENT_BYTES and len(live.messages) == 64


def test_visible_reasoning_is_actual_explicit_content_only():
    assert visible_parts(AIMessage(content="正文", additional_kwargs={"reasoning_content": "供应商思考", "request": "private"})) == ("正文", "供应商思考")
    assert visible_parts(AIMessage(content=[{"type": "reasoning", "summary": [{"type": "summary_text", "text": "实际摘要"}], "encrypted_content": "hidden"}, {"type": "thinking", "thinking": "实际思考", "signature": "hidden"}])) == ("", "实际摘要实际思考")


async def test_user_cancel_retains_partial_only_and_late_events_cannot_cross_runs(tmp_path):
    settings, store, run = setup_run(tmp_path)
    entered, release, observed = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def on_emit(kind, data):
        if kind == "assistant.snapshot":
            observed.set()

    task = asyncio.create_task(execute(settings, store, run, StreamingModel(
        plans=[[chunk("取消前实际收到的内容"), chunk("不得成为最终回答")]],
        pauses={(0, 0): (entered, release)},
    ), on_emit))
    await asyncio.wait_for(observed.wait(), 5)
    store.cancel_run(run["id"])
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    store.finish_run(run["id"], "cancelled")
    before = events(store, run)
    store.add_event(run["id"], "assistant.snapshot", {"stream_id": "late", "message_id": "late", "text": "不得写入"})
    assert events(store, run) == before
    with store._connection() as db:
        assert db.execute("SELECT COUNT(*) FROM messages WHERE run_id=? AND role='assistant'", (run["id"],)).fetchone()[0] == 0
    other = store.create_conversation("独立会话")
    store.submit_message(other["id"], id="other-request", content="独立运行", kind="chat")
    another = store.claim_next("chat")
    assert await execute(settings, store, another, StreamingModel(plans=[[chunk("独立答案")]])) == "独立答案"
    assert all(item["run_id"] == another["id"] for item in events(store, another))
    assert "取消前" not in str(events(store, another))
    assert events(store, run) == before


async def test_streaming_approval_pause_and_resume_preserve_one_tool_effect_and_final(tmp_path):
    from zhixing_next.config import PathGrant
    from zhixing_next.operations import Journal, RunPaused

    settings, store, run = setup_run(tmp_path)
    external = tmp_path / "external"
    external.mkdir()
    target = external / "notes.txt"
    target.write_text("before")
    settings.grants = [PathGrant(path=external, writable=True)]
    args = __import__("json").dumps({"path": str(target), "content": "approved", "overwrite": True})
    model = StreamingModel(plans=[
        [chunk("准备更新已授权文件。", reasoning="先等明确批准。"), chunk(tool_call_chunks=[{"name": "write_text_file", "args": args, "id": "approved-once", "index": 0}])],
        [chunk("批准后已更新。")],
    ])
    with pytest.raises(RunPaused):
        await execute(settings, store, run, model)
    store.pause_run(run["id"])
    assert target.read_text() == "before"
    assert any(item["type"] == "reasoning.snapshot" for item in events(store, run))
    approval = Journal(settings).approvals(run_id=run["id"])["items"][0]
    Journal(settings).decide(approval["id"], "approve")
    resumed = store.claim_next("chat")
    assert resumed["id"] == run["id"]
    result = await execute(settings, store, resumed, model)
    assert result == "批准后已更新。" and target.read_text() == "approved"
    store.finish_run(run["id"], "completed", result=result)
    with store._connection() as db:
        assert db.execute("SELECT COUNT(*) FROM operations WHERE run_id=? AND tool='write_text_file' AND state='succeeded'", (run["id"],)).fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM messages WHERE run_id=? AND role='assistant'", (run["id"],)).fetchone()[0] == 1
    assert len([item for item in events(store, run) if item["type"] == "assistant.reset"]) == 2
