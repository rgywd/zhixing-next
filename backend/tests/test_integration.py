"""Real API, SQLite store, worker, Deep Agents graph, and physical file I/O.

Only the cloud model is substituted; no service credentials or network are used.
"""

import asyncio
import threading
from pathlib import Path
from uuid import uuid4

import httpx
from langchain_core.messages import AIMessage, ToolMessage
from test_resources import png
from test_runtime import ScriptedModel

from zhixing_next.api import create_app
from zhixing_next.config import ModelConfig, PathGrant, Settings
from zhixing_next.runtime import run_agent
from zhixing_next.tools import FileAccess
from zhixing_next.worker import Worker


async def wait_status(client, run_id, expected):
    async with asyncio.timeout(10):
        while True:
            run = (await client.get(f"/v1/runs/{run_id}")).json()
            if run["status"] == expected:
                return run
            assert run["status"] not in {"failed", "interrupted"}, run
            await asyncio.sleep(0.02)


def settings_for(tmp_path):
    return Settings(
        data_dir=tmp_path / "data",
        workspace_root=tmp_path / "workspaces",
        api_token="integration-only-placeholder-token",
        poll_interval=0.05,
    )


async def test_finance_shared_chat_reads_upload_searches_and_keeps_tool_scope(tmp_path, monkeypatch):
    settings = settings_for(tmp_path)
    settings.models = {"selected": ModelConfig(
        protocol="chat_completions", model="test", api_key_env="UNUSED_TEST_KEY",
        reasoning_levels=["high"], image_input=True,
    )}
    outside = tmp_path / "main-assistant-files"
    outside.mkdir()
    (outside / "private.txt").write_text("must not reach finance", encoding="utf-8")
    (outside / "private.png").write_bytes(png())
    settings.grants = [PathGrant(path=outside, writable=True)]
    searches = []

    async def fake_search(provider, query):
        searches.append((provider["kind"], query))
        return {"items": [{"title": "Source", "url": "https://example.com/fees", "text": "Fee terms"}]}

    monkeypatch.setattr("zhixing_next.search.search_provider", fake_search)
    app = create_app(settings)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test",
        headers={"Authorization": f"Bearer {settings.api_token}"}) as client:
        conversation = (await client.post("/v1/conversations", json={"title": "财务", "agent_id": "finance"})).json()["id"]
        prefix = f"/v1/conversations/{conversation}"
        upload = await client.put(f"{prefix}/files/{uuid4()}", params={"filename": "statement.txt"},
            content=b"Account fee: 12.50", headers={"Content-Type": "application/octet-stream"})
        assert upload.status_code == 200
        image = await client.put(f"{prefix}/files/{uuid4()}", params={"filename": "statement.png"},
            content=png(), headers={"Content-Type": "application/octet-stream"})
        assert image.status_code == 200
        provider = (await client.post("/v1/search/providers", json={
            "name": "Test search", "kind": "brave", "api_key": "test-only-secret",
        })).json()
        assert (await client.put(f"{prefix}/model", json={"model_id": "selected", "reasoning_effort": "high"})).status_code == 200
        model = ScriptedModel(replies=[
            AIMessage(content="", tool_calls=[
                {"name": "read_text_file", "args": {"path": upload.json()["path"]}, "id": "read-upload", "type": "tool_call"},
                {"name": "read_text_file", "args": {"path": str(outside / "private.txt")}, "id": "deny-outside", "type": "tool_call"},
                {"name": "view_image", "args": {"resource_id": image.json()["id"]}, "id": "view-upload", "type": "tool_call"},
                {"name": "view_image", "args": {"path": str(outside / "private.png")}, "id": "deny-image", "type": "tool_call"},
                {"name": "search_web", "args": {"query": "account fees"}, "id": "search-fees", "type": "tool_call"},
            ]),
            AIMessage(content="附件手续费为 12.50，搜索来源 https://example.com/fees。"),
        ])
        next_model = ScriptedModel(replies=[AIMessage(content="未联网。")])
        observed = []

        async def runner(settings, run, **callbacks):
            observed.append((run["agent_id"], run["model_id"], run["reasoning_effort"]))
            selected = model if run["search_provider"] else next_model
            return await run_agent(settings, run, **callbacks, model_override=selected)

        body = {"id": "finance-files", "content": "分析附件中的手续费并查公开信息", "search_provider_id": provider["id"],
            "attachments": [upload.json()["id"], image.json()["id"]]}
        receipt = (await client.post(f"{prefix}/messages", json=body)).json()
        assert [item["id"] for item in receipt["message"]["attachments"]] == body["attachments"]
        stop = asyncio.Event()
        worker = asyncio.create_task(Worker(settings, runner).run(stop))
        try:
            await wait_status(client, receipt["run"]["id"], "completed")
            assert observed == [("finance", "selected", "high")]
            results = {item.tool_call_id: item for item in model.seen[-1] if isinstance(item, ToolMessage)}
            assert "Account fee: 12.50" in results["read-upload"].content
            assert results["deny-outside"].status == "error"
            assert results["deny-image"].status == "error"
            assert results["view-upload"].content[0]["image_url"]["url"].startswith("data:image/jpeg;base64,")
            assert "must not reach finance" not in str(model.seen)
            assert "https://example.com/fees" in results["search-fees"].content
            assert searches == [("brave", "account fees")]
            assert "test-only-secret" not in str(model.seen)
            assert {"read_document", "list_directory", "record_finance_observation"} <= set(model.bound_names)
            assert not {"write_text_file", "execute", "task", "browse_personal_memories"} & set(model.bound_names)
            retry = (await client.post(f"{prefix}/messages", json=body)).json()
            assert retry["run"]["id"] == receipt["run"]["id"]
            next_receipt = (await client.post(f"{prefix}/messages", json={"id": "finance-off", "content": "继续"})).json()
            await wait_status(client, next_receipt["run"]["id"], "completed")
            assert "search_web" not in next_model.bound_names
            assert searches == [("brave", "account fees")]
        finally:
            stop.set()
            await worker


async def test_api_worker_graph_uploaded_source_to_downloadable_artifact(tmp_path):
    settings = settings_for(tmp_path)
    app = create_app(settings)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {settings.api_token}"},
    ) as client:
        await client.put("/v1/assistant", json={"name": "小知", "persona": "核实文件证据后回答"})
        project = (await client.post("/v1/projects", json={"name": "文件研究"})).json()
        conversation = (
            await client.post(
                "/v1/conversations", json={"title": "资料整理", "project_id": project["id"]}
            )
        ).json()["id"]
        upload = await client.put(
            f"/v1/conversations/{conversation}/files/{uuid4()}",
            params={"filename": "source.txt"},
            content=b"Source evidence.",
            headers={"Content-Type": "application/octet-stream"},
        )
        assert upload.status_code == 200
        source_path = upload.json()["path"]
        model = ScriptedModel(
            replies=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_text_file",
                            "args": {"path": source_path},
                            "id": "read-source",
                            "type": "tool_call",
                        }
                    ],
                ),
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "write_text_file",
                            "args": {"path": "report.md", "content": "# Report\nSource evidence."},
                            "id": "write-report",
                            "type": "tool_call",
                        }
                    ],
                ),
                AIMessage(content="报告已写入 report.md，依据 source.txt。"),
            ]
        )

        async def runner(settings, run, **callbacks):
            return await run_agent(settings, run, **callbacks, model_override=model)

        body = {"id": "file-task", "content": f"读取 {source_path}，生成 report.md", "kind": "task"}
        receipt = (
            await client.post(f"/v1/conversations/{conversation}/messages", json=body)
        ).json()
        run_id = receipt["run"]["id"]
        stop = asyncio.Event()
        worker_task = asyncio.create_task(Worker(settings, runner).run(stop))
        try:
            finished = await wait_status(client, run_id, "completed")
            assert "report.md" in finished["result"]
            downloaded = await client.get(
                f"/v1/conversations/{conversation}/files/content", params={"path": "report.md"}
            )
            assert (
                downloaded.status_code == 200
                and downloaded.content == b"# Report\nSource evidence."
            )
            retry = (
                await client.post(f"/v1/conversations/{conversation}/messages", json=body)
            ).json()
            assert retry["run"]["id"] == run_id and retry["run"]["status"] == "completed"
            events = (await client.get(f"/v1/runs/{run_id}/events")).json()["items"]
            assert (
                sum(
                    event["type"] == "tool"
                    and event["data"].get("tool") == "write_text_file"
                    and event["data"].get("status") == "completed"
                    for event in events
                )
                == 1
            )
            assert len(model.seen) == 3
        finally:
            stop.set()
            await worker_task


async def test_api_steer_and_cancel_have_durable_store_receipts(tmp_path):
    settings = settings_for(tmp_path)
    app = create_app(settings)
    first_entered, first_release = asyncio.Event(), asyncio.Event()
    cancel_entered, cancel_release = asyncio.Event(), asyncio.Event()
    models = {
        "initial": ScriptedModel(
            entered=first_entered,
            release=first_release,
            replies=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "write_text_file",
                            "args": {"path": "obsolete.md", "content": "old plan"},
                            "id": "obsolete",
                            "type": "tool_call",
                        }
                    ],
                ),
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "write_text_file",
                            "args": {"path": "corrected.md", "content": "new requirement"},
                            "id": "corrected",
                            "type": "tool_call",
                        }
                    ],
                ),
                AIMessage(content="已按新要求完成。"),
            ],
        ),
        "cancel me": ScriptedModel(
            entered=cancel_entered,
            release=cancel_release,
            replies=[AIMessage(content="should not appear")],
        ),
        "after cancel": ScriptedModel(replies=[AIMessage(content="新的排队请求已完成。")]),
        "other chat": ScriptedModel(replies=[AIMessage(content="任务期间可以继续聊天。")]),
    }

    async def runner(settings, run, **callbacks):
        return await run_agent(settings, run, **callbacks, model_override=models[run["prompt"]])

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {settings.api_token}"},
    ) as client:
        conversation = (await client.post("/v1/conversations", json={"title": "任务控制"})).json()[
            "id"
        ]
        other = (await client.post("/v1/conversations", json={"title": "另聊"})).json()["id"]

        async def send(prompt, *, target=conversation, kind="task"):
            return (
                await client.post(
                    f"/v1/conversations/{target}/messages",
                    json={"id": str(uuid4()), "content": prompt, "kind": kind},
                )
            ).json()["run"]["id"]

        initial = await send("initial")
        stop = asyncio.Event()
        worker_task = asyncio.create_task(Worker(settings, runner).run(stop))
        try:
            await asyncio.wait_for(first_entered.wait(), 10)
            other_run = await send("other chat", target=other, kind="chat")
            await wait_status(client, other_run, "completed")
            steer = await client.post(
                f"/v1/conversations/{conversation}/messages",
                json={
                    "id": "durable-steer",
                    "content": "Use corrected.md instead.",
                    "intent": "steer",
                    "target_run_id": initial,
                },
            )
            assert steer.json()["message"]["status"] == "accepted"
            first_release.set()
            await wait_status(client, initial, "completed")
            messages = (await client.get(f"/v1/conversations/{conversation}/messages")).json()[
                "items"
            ]
            assert (
                next(message for message in messages if message["id"] == "durable-steer")["status"]
                == "applied"
            )
            files = (await client.get(f"/v1/conversations/{conversation}/files")).json()["items"]
            assert {file["path"] for file in files} == {"corrected.md"}
            events = (await client.get(f"/v1/runs/{initial}/events")).json()["items"]
            assert sum(event["type"] == "steer_applied" for event in events) == 1
            to_cancel = await send("cancel me")
            queued = await send("after cancel")
            await asyncio.wait_for(cancel_entered.wait(), 10)
            receipt = (await client.post(f"/v1/runs/{to_cancel}/cancel")).json()
            assert receipt["cancel_requested"]
            await wait_status(client, to_cancel, "cancelled")
            assert (await client.get(f"/v1/runs/{queued}")).json()["status"] == "queued"
            assert (await client.get(f"/v1/conversations/{conversation}")).json()["blocked"]
            await client.post(f"/v1/conversations/{conversation}/resume")
            await wait_status(client, queued, "completed")
            assert not models["cancel me"].seen
        finally:
            first_release.set()
            cancel_release.set()
            stop.set()
            await worker_task


async def test_cancel_during_file_write_reports_actual_receipt_and_never_replays(
    tmp_path, monkeypatch
):
    settings = settings_for(tmp_path)
    app = create_app(settings)
    entered, release = threading.Event(), threading.Event()
    original = FileAccess.write_bytes
    writes = []

    def delayed_write(self, path, content, **kwargs):
        entered.set()
        assert release.wait(5)
        writes.append(path)
        return original(self, path, content, **kwargs)

    monkeypatch.setattr(FileAccess, "write_bytes", delayed_write)
    first = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "write_text_file",
                        "args": {
                            "path": "settled.txt",
                            "content": "finished before cancellation receipt",
                        },
                        "id": "slow-file",
                        "type": "tool_call",
                    }
                ],
            )
        ]
    )
    following = ScriptedModel(replies=[AIMessage(content="Checked the interrupted task context.")])

    async def runner(settings, run, **callbacks):
        return await run_agent(
            settings,
            run,
            **callbacks,
            model_override=first if run["prompt"] == "write" else following,
        )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {settings.api_token}"},
    ) as client:
        conversation = (
            await client.post("/v1/conversations", json={"title": "取消中的文件"})
        ).json()["id"]
        submitted = (
            await client.post(
                f"/v1/conversations/{conversation}/messages",
                json={"id": "slow-input", "content": "write", "kind": "task"},
            )
        ).json()["run"]["id"]
        queued = (
            await client.post(
                f"/v1/conversations/{conversation}/messages",
                json={"id": "inspect-input", "content": "inspect", "kind": "task"},
            )
        ).json()["run"]["id"]
        stop = asyncio.Event()
        worker_task = asyncio.create_task(Worker(settings, runner).run(stop))
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            await client.post(f"/v1/runs/{submitted}/cancel")
            await asyncio.sleep(0.1)
            assert (await client.get(f"/v1/runs/{submitted}")).json()["status"] == "running"
            release.set()
            await wait_status(client, submitted, "cancelled")
            downloaded = await client.get(
                f"/v1/conversations/{conversation}/files/content", params={"path": "settled.txt"}
            )
            assert downloaded.content == b"finished before cancellation receipt"
            events = (await client.get(f"/v1/runs/{submitted}/events")).json()["items"]
            assert any(
                event["type"] == "tool"
                and event["data"].get("status") == "completed"
                and event["data"].get("cancel_requested")
                for event in events
            )
            assert (await client.get(f"/v1/runs/{queued}")).json()["status"] == "queued"
            await client.post(f"/v1/conversations/{conversation}/resume")
            await wait_status(client, queued, "completed")
            assert len(writes) == 1 and Path(writes[0]).name == "settled.txt"
            assert any(
                getattr(message, "tool_call_id", None) == "slow-file"
                for message in following.seen[0]
            )
        finally:
            release.set()
            stop.set()
            await worker_task
