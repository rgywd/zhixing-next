import asyncio
import json
import logging
from uuid import uuid4

import httpx
import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel

from zhixing_next import worker
from zhixing_next.config import Settings
from zhixing_next.memory import organize_run
from zhixing_next.store import Store
from zhixing_next.webtools import read_public_page
from zhixing_next.worker import Worker


def setup_store(tmp_path):
    settings = Settings(
        data_dir=tmp_path / "data", workspace_root=tmp_path / "work", poll_interval=0.05
    )
    return settings, Store(settings)


def submit(store, conversation, prompt, kind="chat"):
    return store.submit_message(conversation["id"], id=str(uuid4()), content=prompt, kind=kind)[
        "run"
    ]


async def wait_for(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(0.02)


async def test_other_conversation_can_chat_during_task_and_cancel_preserves_queue(tmp_path):
    settings, store = setup_store(tmp_path)
    work = store.create_conversation("研究")
    chat = store.create_conversation("闲聊")
    task = submit(store, work, "先处理文件", "task")
    queued = submit(store, work, "处理后做表", "task")
    conversation = submit(store, chat, "你好")
    entered = asyncio.Event()

    async def runner(settings, run, **callbacks):
        if run["id"] == task["id"]:
            entered.set()
            await asyncio.Event().wait()
        return "已收到：" + run["prompt"]

    stop = asyncio.Event()
    running = asyncio.create_task(Worker(settings, runner).run(stop))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        await wait_for(lambda: store.get_run(conversation["id"])["status"] == "completed")
        assert store.get_run(task["id"])["status"] == "running"
        assert store.get_run(queued["id"])["status"] == "queued"
        store.cancel_run(task["id"])
        await wait_for(lambda: store.get_run(task["id"])["status"] == "cancelled")
        assert store.get_run(queued["id"])["status"] == "queued"
        store.resume_conversation(work["id"])
        await wait_for(lambda: store.get_run(queued["id"])["status"] == "completed")
    finally:
        stop.set()
        await running


async def test_worker_restart_retains_interrupted_run_and_pending_input(tmp_path):
    settings, store = setup_store(tmp_path)
    conversation = store.create_conversation("持久会话")
    first = submit(store, conversation, "可能写了文件", "task")
    second = submit(store, conversation, "检查结果", "task")
    # Simulate the previous process claiming a run and disappearing before finishing it.
    assert store.claim_next("task")["id"] == first["id"]
    store.add_event(first["id"], "tool", {"name": "write_file", "status": "started"})

    async def runner(settings, run, **callbacks):
        return "仅处理新输入：" + run["prompt"]

    worker = Worker(settings, runner)
    stop = asyncio.Event()
    running = asyncio.create_task(worker.run(stop))
    try:
        await wait_for(lambda: store.get_run(first["id"])["status"] == "interrupted")
        assert store.get_run(second["id"])["status"] == "queued"
        assert any(event["type"] == "tool" for event in store.list_events(first["id"])["items"])
        store.resume_conversation(conversation["id"])
        await wait_for(lambda: store.get_run(second["id"])["status"] == "completed")
        assert store.get_run(first["id"])["status"] == "interrupted"
    finally:
        stop.set()
        await running


async def test_only_one_worker_can_own_a_data_directory(tmp_path):
    settings, store = setup_store(tmp_path)

    async def runner(*args, **kwargs):
        return "ok"

    stop = asyncio.Event()
    first = asyncio.create_task(Worker(settings, runner).run(stop))
    try:
        await wait_for(store.worker_online)
        with pytest.raises(RuntimeError, match="Another worker"):
            await Worker(settings, runner).run(asyncio.Event())
    finally:
        stop.set()
        await first


async def test_worker_organizes_new_memory_and_explicit_forget(tmp_path, monkeypatch):
    settings, store = setup_store(tmp_path)
    conversation = store.create_conversation("设备")

    async def runner(_settings, _run, **_callbacks):
        return "收到。"

    async def scripted_organizer(settings, store, run):
        if "忘" in run["prompt"]:
            actions = [{"op": "forget", "id": store.memory_candidates()[0]["id"]}]
        else:
            actions = [{"op": "add", "content": "用户的设备是 Mac mini，内存 16GB"}]
        model = FakeListChatModel(responses=[json.dumps({"actions": actions}, ensure_ascii=False)])
        return await organize_run(settings, store, run, model_override=model)

    monkeypatch.setattr(worker, "organize_run", scripted_organizer)
    stop = asyncio.Event()
    running = asyncio.create_task(Worker(settings, runner).run(stop))
    try:
        first = submit(store, conversation, "我的设备是 Mac mini，内存 16GB")
        await wait_for(lambda: store.get_run(first["id"])["memory_processed"] == 1)
        assert len(store.list_memories()["items"]) == 1
        second = submit(store, conversation, "忘掉我的设备配置")
        await wait_for(lambda: store.get_run(second["id"])["memory_processed"] == 1)
        assert store.list_memories()["items"] == []
    finally:
        stop.set()
        await running


@pytest.mark.parametrize("forget", [False, True])
async def test_worker_drops_in_flight_memory_write_after_direct_change(tmp_path, monkeypatch, forget):
    settings, store = setup_store(tmp_path)
    conversation = store.create_conversation("记忆一致性")
    saved = store.add_memory("用户的代号是蓝莓灯塔")
    entered, release = asyncio.Event(), asyncio.Event()

    async def runner(_settings, _run, **_callbacks):
        return "收到。"

    async def scripted_organizer(settings, store, run):
        if "蓝莓灯塔" in run["prompt"]:
            entered.set()
            await release.wait()
            content = "用户的代号是蓝莓灯塔"
        else:
            content = "用户喜欢茶"
        model = FakeListChatModel(responses=[json.dumps({
            "actions": [{"op": "add", "content": content}],
        }, ensure_ascii=False)])
        return await organize_run(settings, store, run, model_override=model)

    monkeypatch.setattr(worker, "organize_run", scripted_organizer)
    stop = asyncio.Event()
    running = asyncio.create_task(Worker(settings, runner).run(stop))
    try:
        old = submit(store, conversation, "记住我的代号是蓝莓灯塔")
        await asyncio.wait_for(entered.wait(), 5)
        if forget:
            store.delete_memory(saved["id"])
        else:
            store.update_memory(saved["id"], "用户的代号是青山")
        new = submit(store, conversation, "记住我喜欢茶")
        release.set()
        await wait_for(lambda: store.get_run(new["id"])["memory_processed"] == 1)
        assert store.get_run(old["id"])["memory_processed"] == 1
        facts = [item["content"] for item in store.list_memories()["items"]]
        assert "用户喜欢茶" in facts
        assert "用户的代号是蓝莓灯塔" not in facts
        assert ("用户的代号是青山" in facts) is not forget
    finally:
        release.set()
        stop.set()
        await running


async def test_explicit_memory_failure_is_not_reported_as_saved(tmp_path):
    settings, store = setup_store(tmp_path)
    conversation = store.create_conversation("记忆")

    async def runner(_settings, _run, **_callbacks):
        return "我理解了你的要求。"

    stop = asyncio.Event()
    running = asyncio.create_task(Worker(settings, runner).run(stop))
    try:
        run = submit(store, conversation, "记住，我喜欢茶")
        await wait_for(lambda: store.get_run(run["id"])["memory_processed"] == -1)
        messages = store.list_messages(conversation["id"])["items"]
        assert "尚未生效" in messages[-1]["content"]
        assert store.list_memories()["items"] == []
    finally:
        stop.set()
        await running


def test_worker_default_logs_omit_http_query_parameters(monkeypatch, caplog):
    marker = "audit-query-marker-not-a-secret"

    async def resolver(_url):
        return "93.184.216.34"

    async def exercise_request():
        transport = httpx.MockTransport(
            lambda _request: httpx.Response(
                200, headers={"content-type": "text/plain"}, text="public document"
            )
        )
        result = await read_public_page(
            f"https://example.test/document?access_token={marker}",
            transport=transport,
            resolver=resolver,
        )
        assert result["text"] == "public document"
        logging.getLogger("httpcore").debug("request target includes %s", marker)
        worker.logger.info("worker audit request completed")

    monkeypatch.setattr(worker, "_serve", exercise_request)
    # Restore per-library levels after exercising the real command-line logging setup.
    with (
        caplog.at_level(logging.INFO),
        caplog.at_level(logging.DEBUG, logger="httpx"),
        caplog.at_level(logging.DEBUG, logger="httpcore"),
    ):
        worker.main()
    assert "worker audit request completed" in caplog.text
    assert marker not in caplog.text
    assert "access_token=" not in caplog.text
