"""Opt-in real Docker integration: ZHIXING_TEST_DOCKER=1 uv run pytest -q."""

import asyncio
import os
from pathlib import Path

import httpx
import pytest
from langchain_core.messages import AIMessage
from test_operations import Crash
from test_runtime import ScriptedModel, ignore, no_controls

from zhixing_next.api import create_app
from zhixing_next.artifacts import create_artifact_tool
from zhixing_next.browser import create_browser_tool
from zhixing_next.config import ExecutionConfig, Settings
from zhixing_next.execution import DockerSandbox, cleanup_orphans, docker
from zhixing_next.operations import Journal, RunPaused
from zhixing_next.resources import resource_bytes
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store
from zhixing_next.worker import Worker

pytestmark = pytest.mark.skipif(
    os.environ.get("ZHIXING_TEST_DOCKER") != "1",
    reason="requires built zhixing-sandbox:1 image and Docker",
)


@pytest.fixture
def execution(tmp_path):
    settings = Settings(
        data_dir=tmp_path / "data",
        workspace_root=tmp_path / "workspaces",
        execution=ExecutionConfig(enabled=True),
    )
    store = Store(settings)
    conversation = store.create_conversation("执行验收")["id"]
    store.submit_message(conversation, id="input", content="生成报告", kind="task")
    run = store.claim_next("task")
    events = []

    async def emit(kind, data):
        events.append((kind, data))
        store.add_event(run["id"], kind, data)

    return settings, store, run, events, emit


async def test_real_graph_executes_and_publishes_downloadable_workbook(execution):
    settings, store, run, events, emit = execution
    command = "python - <<'PY'\nfrom openpyxl import Workbook\nw=Workbook(); s=w.active; s.append(['项目','金额']); s.append(['资料',12.5]); w.save('report.xlsx')\nPY"
    model = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "execute",
                        "args": {"command": command},
                        "id": "exec",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "publish_artifact",
                        "args": {"path": "report.xlsx"},
                        "id": "publish",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="表格已生成并重新读取。"),
        ]
    )
    result = await run_agent(
        settings,
        run,
        persona="",
        emit=emit,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    store.finish_run(run["id"], "completed", result=result)
    artifacts = [data for kind, data in events if kind == "artifact"]
    assert len(artifacts) == 1, events
    artifact = artifacts[0]
    assert "workbook_reopened" in artifact["verification"]["checks"]
    assert resource_bytes(settings, artifact["resource"])[:2] == b"PK"
    assert (
        store.list_messages(run["conversation_id"])["items"][-1]["attachments"][0]["id"]
        == artifact["resource"]["id"]
    )
    assert "execute" in model.bound_names
    code, containers = await docker("ps", "-aq", "--filter", f"label=zhixing.run={run['id']}")
    assert code == 0 and containers.strip() == ""


async def test_cancel_stops_actual_child_process_and_receipt_precedes_terminal(execution):
    settings, store, run, events, emit = execution
    workspace = Path(run["workspace_path"])
    model = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "execute",
                        "args": {
                            "command": "touch started; (sleep 3; touch should-not-exist) & wait"
                        },
                        "id": "child",
                        "type": "tool_call",
                    }
                ],
            )
        ]
    )

    async def runner(settings, run, **callbacks):
        async def observed_emit(kind, data):
            events.append((kind, data))
            await callbacks["emit"](kind, data)

        return await run_agent(
            settings, run, **{**callbacks, "emit": observed_emit}, model_override=model
        )

    worker = Worker(settings, runner)
    task = asyncio.create_task(worker._execute(run))
    worker.active["task"] = (run["id"], task)
    store.submit_message(run["conversation_id"], id="followup", content="后续要求", kind="task")
    async with asyncio.timeout(30):
        while not (workspace / "started").exists():
            if task.done():
                await task
            await asyncio.sleep(0.05)
    settings.api_token = "x" * 30
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(create_app(settings)),
        base_url="http://test",
        headers={"Authorization": "Bearer " + settings.api_token},
    ) as client:
        assert (await client.post(f"/v1/runs/{run['id']}/cancel")).status_code == 200
    await worker.tick()
    await task
    assert store.get_run(run["id"])["status"] == "cancelled"
    assert store.claim_next("task") is None
    assert any(
        kind == "execution" and data["status"] == "cancelled" and data["stopped"]
        for kind, data in events
    )
    await asyncio.sleep(3.1)
    assert not (workspace / "should-not-exist").exists()


async def test_timeout_isolation_and_orphan_reconciliation(execution):
    settings, store, run, events, emit = execution
    workspace = Path(run["workspace_path"])
    sandbox = DockerSandbox(settings, workspace, run["id"], emit)
    os.environ["ZHIXING_TEST_SENTINEL"] = "never-inherit-this-secret"
    try:
        result = await sandbox.aexecute(
            'test -z "$ZHIXING_TEST_SENTINEL" && test ! -e /var/run/docker.sock && test ! -e /host && python -c \'import socket; s=socket.socket(); s.settimeout(1); assert s.connect_ex(("1.1.1.1",443)) != 0\''
        )
        assert result.exit_code == 0, result.output
        assert (await sandbox.aexecute("touch /etc/not-allowed")).exit_code != 0
        payload = b"large binary\0" * 100000
        uploaded = await sandbox.aupload_files([("/workspace/large.bin", payload)])
        assert uploaded[0].error is None
        assert (await sandbox.adownload_files(["/workspace/large.bin"]))[0].content == payload
        assert (await sandbox.adownload_files(["/dev/zero"]))[0].error
        assert (await sandbox.aexecute("sleep 20", timeout=1)).exit_code == 124
        await sandbox.start()
        settings.execution.enabled = False
        await cleanup_orphans(settings)
        assert (await docker("inspect", sandbox.id))[0] != 0
        assert any(
            data.get("reason") == "worker_restart"
            for kind, data in [
                (event["type"], event["data"]) for event in store.list_events(run["id"])["items"]
            ]
        )
    finally:
        os.environ.pop("ZHIXING_TEST_SENTINEL", None)
        await sandbox.close()


async def test_cancelled_file_transfer_cannot_restart_a_closed_container(execution):
    settings, store, run, events, emit = execution
    sandbox = DockerSandbox(settings, Path(run["workspace_path"]), run["id"], emit)
    try:
        assert (await sandbox.aexecute("mkfifo blocked")).exit_code == 0
        transfer = asyncio.create_task(sandbox.aupload_files([("/workspace/blocked", b"test")]))
        await asyncio.sleep(0.2)
        transfer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await transfer
        await sandbox.close()
        assert (await docker("inspect", sandbox.id))[0] != 0
        with pytest.raises(RuntimeError, match="already stopped"):
            await sandbox.aexecute("touch should-not-start")
    finally:
        await sandbox.close()


async def test_worker_reconciles_leftover_container_before_next_task(execution):
    settings, store, run, events, emit = execution
    sandbox = DockerSandbox(settings, Path(run["workspace_path"]), run["id"], emit)
    other = store.create_conversation("下一项任务")["id"]
    store.submit_message(other, id="next", content="检查", kind="task")
    try:
        await sandbox.aexecute("touch leftover")
        store.finish_run(run["id"], "failed", error="stop was unconfirmed")

        async def runner(*args, **kwargs):
            assert (await docker("inspect", sandbox.id))[0] != 0
            return "previous process stopped"

        worker = Worker(settings, runner)
        await worker.tick()
        await worker.active["task"][1]
        assert store.list_messages(other)["items"][-1]["content"] == "previous process stopped"
    finally:
        await sandbox.close()


async def test_browser_interacts_with_real_javascript_and_captures_result(execution):
    settings, store, run, events, emit = execution
    workspace = Path(run["workspace_path"])
    (workspace / "index.html").write_text(
        """<html><body><label>Name <input id="name"></label><button id="save">Save</button><div id="result"></div><a href="sample.txt" download>Download</a><script>document.querySelector('#save').onclick = () => { document.querySelector('#result').textContent = document.querySelector('#name').value; };</script></body></html>"""
    )
    (workspace / "sample.txt").write_text("actual downloaded content")
    sandbox = DockerSandbox(settings, workspace, run["id"], emit)
    try:
        # Local fixture stays inside the network-disabled container.
        await sandbox.aexecute(
            'python -c \'import subprocess; subprocess.Popen(["python","-m","http.server","8765"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)\''
        )
        browser = create_browser_tool(sandbox)
        opened = await browser.ainvoke({"action": "navigate", "url": "http://127.0.0.1:8765"})
        assert "Name" in opened["snapshot"]
        await browser.ainvoke({"action": "fill", "selector": "#name", "text": "知行验收"})
        result = await browser.ainvoke({"action": "click", "selector": "button"})
        assert "知行验收" in result["text"]
        assert (workspace / "browser-preview.png").is_file()
        download = await browser.ainvoke({"action": "download", "selector": "a"})
        assert (
            workspace / download["download"].removeprefix("/workspace/")
        ).read_text() == "actual downloaded content"
    finally:
        await sandbox.close()


async def test_invalid_artifact_cannot_be_published(execution):
    settings, store, run, events, emit = execution
    sandbox = DockerSandbox(settings, Path(run["workspace_path"]), run["id"], emit)
    try:
        await sandbox.aexecute("printf invalid > broken.xlsx")
        publish = create_artifact_tool(settings, run, sandbox, emit)
        with pytest.raises(ValueError, match="validation failed"):
            await publish.ainvoke({"path": "broken.xlsx"})
        assert not any(kind == "artifact" for kind, _ in events)
    finally:
        await sandbox.close()


async def test_bridge_execution_waits_for_authenticated_run_authorization(execution):
    settings, store, run, events, emit = execution
    settings.execution.network = "bridge"
    model = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "execute",
                        "args": {"command": "touch authorized"},
                        "id": "network-step",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="执行完成"),
        ]
    )
    with pytest.raises(RunPaused):
        await run_agent(
            settings,
            run,
            persona="",
            emit=emit,
            controls=no_controls,
            acknowledge=ignore,
            model_override=model,
        )
    store.pause_run(run["id"])
    assert not (Path(run["workspace_path"]) / "authorized").exists()
    journal = Journal(settings)
    approval = journal.approvals()["items"][0]
    assert approval["kind"] == "network"
    journal.decide(approval["id"], "approve")
    resumed = store.claim_next("task")
    await run_agent(
        settings,
        resumed,
        persona="",
        emit=emit,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    assert (Path(run["workspace_path"]) / "authorized").exists()
    assert journal.approvals()["items"] == []


@pytest.mark.parametrize("retry_once", [False, True])
async def test_unknown_shell_effect_is_not_replayed_after_restart(
    execution, monkeypatch, retry_once
):
    settings, store, run, events, emit = execution
    command = "printf 'once\\n' >> counter.txt"
    first = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "execute",
                        "args": {"command": command},
                        "id": "append",
                        "type": "tool_call",
                    }
                ],
            )
        ]
    )
    original = Journal.set_state

    def crash_before_receipt(self, identifier, state, result=None):
        if state == "succeeded":
            raise Crash()
        return original(self, identifier, state, result)

    monkeypatch.setattr(Journal, "set_state", crash_before_receipt)
    with pytest.raises(Crash):
        await run_agent(
            settings,
            run,
            persona="",
            emit=emit,
            controls=no_controls,
            acknowledge=ignore,
            model_override=first,
        )
    monkeypatch.setattr(Journal, "set_state", original)
    store.recover_interrupted()
    resumed = store.claim_next("task")
    next_model = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "execute",
                        "args": {"command": "cat counter.txt"},
                        "id": "inspect",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="已核对实际写入次数"),
        ]
    )
    with pytest.raises(RunPaused):
        await run_agent(
            settings,
            resumed,
            persona="",
            emit=emit,
            controls=no_controls,
            acknowledge=ignore,
            model_override=next_model,
        )
    store.pause_run(run["id"])
    approval = Journal(settings).approvals()["items"][0]
    assert approval["kind"] == "uncertain" and next_model.seen == []
    if retry_once:
        Journal(settings).decide(approval["id"], "retry")
        monkeypatch.setattr(Journal, "set_state", crash_before_receipt)
        with pytest.raises(Crash):
            await run_agent(
                settings,
                store.claim_next("task"),
                persona="",
                emit=emit,
                controls=no_controls,
                acknowledge=ignore,
                model_override=next_model,
            )
        monkeypatch.setattr(Journal, "set_state", original)
        assert (Path(run["workspace_path"]) / "counter.txt").read_text() == "once\nonce\n"
        store.recover_interrupted()
        with pytest.raises(RunPaused):
            await run_agent(
                settings,
                store.claim_next("task"),
                persona="",
                emit=emit,
                controls=no_controls,
                acknowledge=ignore,
                model_override=next_model,
            )
        store.pause_run(run["id"])
        renewed = Journal(settings).approvals()["items"][0]
        assert renewed["id"] != approval["id"] and next_model.seen == []
        approval = renewed
    Journal(settings).decide(approval["id"], "skip")
    result = await run_agent(
        settings,
        store.claim_next("task"),
        persona="",
        emit=emit,
        controls=no_controls,
        acknowledge=ignore,
        model_override=next_model,
    )
    assert result == "已核对实际写入次数"
    assert (Path(run["workspace_path"]) / "counter.txt").read_text() == "once\n" * (
        2 if retry_once else 1
    )
