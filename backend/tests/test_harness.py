import asyncio
from types import SimpleNamespace

import httpx
import pytest
from langchain_core.messages import AIMessage
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls, run_agent

from zhixing_next.operations import RunPaused
from zhixing_next.resilience import RunBudget, RunLimitError, failure_kind, retry_delay
from zhixing_next.store import Store, StoreError
from zhixing_next.taskflow import TaskFlow, TaskStep


def call(name, args, identifier):
    return AIMessage(
        content="", tool_calls=[{"name": name, "args": args, "id": identifier, "type": "tool_call"}]
    )


class TransientModel(ScriptedModel):
    attempts: int = 0

    async def _agenerate(self, *args, **kwargs):
        self.attempts += 1
        if self.attempts == 2:
            raise httpx.ConnectError("test transport failure")
        return await super()._agenerate(*args, **kwargs)


async def test_model_retry_does_not_replay_completed_write_and_usage_is_durable(tmp_path):
    settings = make_settings(tmp_path)
    settings.limits.retry_base_seconds = 0
    model = TransientModel(
        replies=[
            call("write_text_file", {"path": "once.txt", "content": "once"}, "write"),
            AIMessage(
                content="done",
                usage_metadata={"input_tokens": 7, "output_tokens": 3, "total_tokens": 10},
            ),
        ]
    )
    run = make_run()
    assert (
        await run_agent(
            settings,
            run,
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=model,
        )
        == "done"
    )
    store = Store(settings)
    with store._connection() as db:
        assert (
            db.execute("SELECT count(*) FROM operations WHERE tool='write_text_file'").fetchone()[0]
            == 1
        )
    usage = RunBudget(store, run["id"]).summary()
    assert usage["model_attempts"] == 3
    assert usage["input_tokens"] == 7
    assert usage["output_tokens"] == 3
    assert usage["unknown_usage"] == 2


def test_provider_failure_classification_and_retry_after():
    for code in (429, 500, 503):
        exc = Exception("private provider data")
        exc.status_code = code
        assert failure_kind(exc)[1]
    exc.status_code = 401
    assert failure_kind(exc) == ("authentication", False)
    exc.status_code = 400
    assert not failure_kind(exc)[1]
    exc.response = SimpleNamespace(headers={"retry-after": "100"})
    assert retry_delay(exc, 0, 1) == 30


@pytest.mark.parametrize(
    "control", [{"cancel_requested": True}, {"steers": [{"id": "new", "content": "新要求"}]}]
)
async def test_retry_wait_can_be_interrupted_by_cancel_or_new_instruction(tmp_path, control):
    settings = make_settings(tmp_path)
    settings.limits.retry_base_seconds = 10
    store = Store(settings)
    conversation = store.create_conversation("重试控制")["id"]
    store.submit_message(conversation, id="input", content="工作")
    run = store.claim_next("chat")
    current = {}
    calls = 0

    async def handler(request):
        nonlocal calls
        calls += 1
        raise httpx.ConnectError("test transient failure")

    async def controls():
        return current

    async def emit(kind, _data):
        if kind == "retry":
            current.update(control)

    budget = RunBudget(store, run["id"])
    if control.get("cancel_requested"):
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(budget.invoke_model(handler, None, controls, emit), 0.5)
    else:
        response = await asyncio.wait_for(budget.invoke_model(handler, None, controls, emit), 0.5)
        assert response.result[0].content == ""
    assert calls == 1


async def test_budget_stops_without_an_extra_model_request(tmp_path):
    settings = make_settings(tmp_path)
    settings.limits.model_attempts = 1
    model = ScriptedModel(
        replies=[
            call("read_text_file", {"path": "missing"}, "read"),
            AIMessage(content="should not run"),
        ]
    )
    with pytest.raises(RunLimitError):
        await run_agent(
            settings,
            make_run(),
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=model,
        )
    assert len(model.seen) == 1


async def test_repeated_tool_loop_is_bounded(tmp_path):
    model = ScriptedModel(
        replies=[call("read_text_file", {"path": "missing"}, f"read{i}") for i in range(6)]
    )
    with pytest.raises(RunLimitError, match="连续重复"):
        await run_agent(
            make_settings(tmp_path),
            make_run(),
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=model,
        )
    assert len(model.seen) == 4


async def test_question_survives_restart_and_answer_is_authorized_in_store(tmp_path):
    settings, run = make_settings(tmp_path), make_run()
    first = ScriptedModel(
        replies=[
            call(
                "request_user_input",
                {"question": "交付哪种格式？", "options": ["PDF", "DOCX"]},
                "question",
            )
        ]
    )
    with pytest.raises(RunPaused):
        await run_agent(
            settings,
            run,
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=first,
        )
    store = Store(settings)
    store.pause_run(run["id"])
    assert store.get_run(run["id"])["phase"] == "input"
    assert store.claim_next("chat") is None
    flow = TaskFlow(Store(settings))
    item = flow.questions(run_id=run["id"])["items"][0]
    flow.answer(item["id"], "PDF")
    assert flow.answer(item["id"], "PDF")["answer"] == "PDF"
    claimed = store.claim_next("chat")
    second = ScriptedModel(replies=[AIMessage(content="按 PDF 继续。")])
    assert (
        await run_agent(
            settings,
            claimed,
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=second,
        )
        == "按 PDF 继续。"
    )
    assert any("PDF" in str(m.content) and m.type == "tool" for m in second.seen[0])
    assert not flow.questions(run_id=run["id"])["items"]


async def test_cancelled_question_cannot_be_answered(tmp_path):
    settings, run = make_settings(tmp_path), make_run()
    with pytest.raises(RunPaused):
        await run_agent(
            settings,
            run,
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=ScriptedModel(
                replies=[call("request_user_input", {"question": "哪个日期？"}, "q")]
            ),
        )
    store = Store(settings)
    store.pause_run(run["id"])
    flow = TaskFlow(store)
    item = flow.questions(run_id=run["id"])["items"][0]
    store.cancel_run(run["id"])
    with pytest.raises(StoreError, match="停止"):
        flow.answer(item["id"], "明天")
    assert not flow.questions(run_id=run["id"])["items"]


async def test_final_answer_cannot_skip_declared_acceptance_steps(tmp_path):
    settings, run = make_settings(tmp_path), make_run()
    run["kind"] = "task"
    model = ScriptedModel(
        replies=[
            call(
                "set_task_plan", {"steps": [{"id": "check", "description": "确认交付内容"}]}, "plan"
            ),
            *[AIMessage(content="已完成") for _ in range(3)],
        ]
    )
    with pytest.raises(RunLimitError, match="未验证"):
        await run_agent(
            settings,
            run,
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=model,
        )
    assert TaskFlow(Store(settings)).steps(run["id"])[0]["status"] == "pending"


async def test_background_process_lifecycle_and_task_check(execution):
    # Reuse the opt-in real Docker fixture without mocking the process lifecycle.
    from zhixing_next.execution import DockerSandbox
    from zhixing_next.processes import Processes
    from zhixing_next.taskflow import create_taskflow_tools

    settings, store, run, _, emit = execution
    sandbox = DockerSandbox(settings, store.workspace_for(run["conversation_id"]), run["id"], emit)
    manager = Processes(store, run, sandbox)
    try:
        receipt = await manager.start("sleep 2; printf completed > result.txt", 10)
        assert receipt["state"] in {"starting", "running"}
        independent = await sandbox.aexecute("printf independent")
        assert independent.output == "independent"
        for _ in range(30):
            receipt = await manager.action(receipt["id"], "read")
            if receipt["state"] == "completed":
                break
            await asyncio.sleep(0.1)
        assert receipt["exit_code"] == 0
        flow = TaskFlow(store)
        flow.plan(run["id"], [TaskStep(id="output", description="content matches")])
        check = next(
            t for t in create_taskflow_tools(store, run, sandbox) if t.name == "check_task_step"
        )
        await check.ainvoke(
            {"step_id": "output", "command": 'test "$(cat result.txt)" = completed'}
        )
        assert flow.steps(run["id"])[0]["status"] == "passed"
        long = await manager.start("sleep 30 & wait", 10)
        await asyncio.sleep(0.2)
        await manager.action(long["id"], "stop")
        await asyncio.sleep(0.3)
        stopped = await manager.action(long["id"], "read")
        assert stopped["state"] == "stopped"
        assert stopped["exit_code"] != 0
    finally:
        await sandbox.close()


async def test_nonzero_command_is_a_failed_receipt(execution):
    from zhixing_next.operations import Journal
    from zhixing_next.runtime import run_agent as actual_run

    settings, _, run, _, emit = execution
    model = ScriptedModel(
        replies=[
            call("execute", {"command": "printf failed; exit 7"}, "bad-command"),
            AIMessage(content="命令未成功"),
        ]
    )
    await actual_run(
        settings,
        run,
        persona="",
        emit=emit,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    assert Journal(settings).receipts(run["id"])["items"][0]["state"] == "failed"


async def test_custom_skill_is_mounted_readonly_and_discovered_by_agent(execution, tmp_path):
    from zhixing_next.execution import DockerSandbox
    from zhixing_next.runtime import run_agent as actual_run

    settings, store, run, _, emit = execution
    skill = tmp_path / "custom-skills" / "acceptance-skill" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text(
        "---\nname: acceptance-skill\ndescription: Verify custom skill mounting\n---\nInspect actual outputs before delivery."
    )
    settings.execution.skills_dir = skill.parent.parent
    sandbox = DockerSandbox(settings, store.workspace_for(run["conversation_id"]), run["id"], emit)
    try:
        result = await sandbox.aexecute("cat /custom-skills/acceptance-skill/SKILL.md")
        assert result.exit_code == 0 and "Inspect actual outputs" in result.output
        denied = await sandbox.aexecute(
            "printf overwrite > /custom-skills/acceptance-skill/SKILL.md"
        )
        assert denied.exit_code != 0
    finally:
        await sandbox.close()
    model = ScriptedModel(replies=[AIMessage(content="已发现技能")])
    await actual_run(
        settings,
        run,
        persona="",
        emit=emit,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    assert "Verify custom skill mounting" in str(model.seen[0])


@pytest.mark.parametrize("command", ["sleep 30 & wait", "exec >/dev/null 2>&1; sleep 30"])
async def test_process_timeout_and_container_end_have_real_outcomes(execution, command):
    from zhixing_next.execution import DockerSandbox
    from zhixing_next.processes import Processes

    settings, store, run, _, emit = execution
    sandbox = DockerSandbox(settings, store.workspace_for(run["conversation_id"]), run["id"], emit)
    manager = Processes(store, run, sandbox)
    try:
        process = await manager.start(command, 1)
        await asyncio.sleep(1.5)
        receipt = await manager.action(process["id"], "read")
        assert receipt["state"] == "timed_out" and receipt["exit_code"] != 0
        process = await manager.start("sleep 30 & wait", 30)
    finally:
        await sandbox.close()
    replacement = DockerSandbox(
        settings, store.workspace_for(run["conversation_id"]), run["id"], emit
    )
    receipt = await Processes(store, run, replacement).action(process["id"], "read")
    assert receipt["state"] == "interrupted" and receipt["exit_code"] is None


@pytest.fixture
def execution(tmp_path):
    import os

    from zhixing_next.config import ExecutionConfig

    if os.getenv("ZHIXING_TEST_DOCKER") != "1":
        pytest.skip("requires actual Docker image")
    settings = make_settings(tmp_path)
    settings.execution = ExecutionConfig(enabled=True)
    store = Store(settings)
    conversation = store.create_conversation("后台进程验收")["id"]
    store.submit_message(conversation, id="input", content="验证交付", kind="task")
    run = store.claim_next("task")
    return settings, store, run, [], ignore
