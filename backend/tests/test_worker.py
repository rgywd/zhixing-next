import asyncio
from uuid import uuid4

import pytest

from zhixing_next.config import Settings
from zhixing_next.store import Store
from zhixing_next.worker import Worker


def setup_store(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work", poll_interval=0.05)
    return settings, Store(settings)


def submit(store, conversation, prompt, kind="chat"):
    return store.submit_message(conversation["id"], id=str(uuid4()), content=prompt, kind=kind)["run"]


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
