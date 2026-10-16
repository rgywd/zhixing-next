"""The acceptance driver is tested locally; these tests are NOT model acceptance."""

import importlib.util
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, ToolMessage, messages_to_dict
from pydantic import SecretStr

from zhixing_next.agent_collaboration import _encode_history
from zhixing_next.config import ModelConfig, Settings
from zhixing_next.store import Store
from zhixing_next.worker import Worker

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "accept_agent_collaboration.py"
SPEC = importlib.util.spec_from_file_location("accept_agent_collaboration", SCRIPT)
acceptance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(acceptance)


@pytest.mark.parametrize("text,unsupported", [
    ("不能保证转乘，误接风险由乘客承担。", True),
    ("误接风险不由方案方承担。", True),
    ("把沉默式免责升级为明确政策。", True),
    ("不能保证转乘；责任归属未知。", False),
    ("不保证转乘不代表由乘客承担责任。", False),
])
def test_semantic_review_catches_unprovided_liability_without_banning_unknowns(text, unsupported):
    assert acceptance.unprovided_liability_claim(text) is unsupported


@pytest.mark.parametrize("text,guessed", [
    ("米饭半份，豆腐和青菜一份", True),
    ("豆腐100克，米饭三分之一份", True),
    ("豆腐、青菜、米饭（米饭吃三分之一份）", False),
    ("米饭一半，豆腐青菜份量未知", False),
])
def test_semantic_review_does_not_let_known_rice_quantity_authorize_other_food(text, guessed):
    assert acceptance.guessed_other_food_portion(text) is guessed


@pytest.fixture
def isolated(tmp_path):
    directory = tmp_path / "evidence"
    directory.mkdir(mode=0o700)
    (directory / "ISOLATED_ACCEPTANCE").write_text(acceptance.MARKER, encoding="utf-8")
    settings = Settings(
        data_dir=directory / "state", workspace_root=directory / "workspaces",
        api_token="fictional-test-service-token-only", poll_interval=0.05,
        models={"fixture": ModelConfig(protocol="chat_completions", model="fictional-test-model",
                                         api_key=SecretStr("FICTIONAL-NOT-A-REAL-PROVIDER-KEY"))},
        roles={"chat": "fixture", "task": "fixture", "memory": "fixture"},
    )
    return settings, directory


@pytest.mark.parametrize("change", ["none", "guessed_clock", "missing_note", "reply_as_actual"])
def test_unknown_time_review_requires_source_recording_time_and_no_actual_clock_claim(isolated, change):
    settings, directory = isolated
    store = Store(settings)
    conversation = store.create_conversation("虚构未知时间验收")
    receipt = store.submit_message(conversation["id"], id="lunch", content="今天午饭吃了米饭")
    source_time = receipt["message"]["created_at"]
    meal = {"occurred_at": source_time, "note": "实际用餐时间未知，使用记录时间。"}
    reply = "已记录今天的午餐。"
    if change == "guessed_clock":
        meal["occurred_at"] = (datetime.fromisoformat(source_time) + timedelta(hours=1)).isoformat()
    if change == "missing_note":
        meal["note"] = ""
    if change == "reply_as_actual":
        reply = "已记录实际用餐时间12:30。"
    suite = acceptance.AcceptanceSuite(settings, directory, None, store, None, 1, None)
    assert suite.unknown_meal_time_preserved(meal, "lunch", reply) is (change == "none")


def test_guards_accept_only_new_owned_exact_paths(isolated):
    settings, directory = isolated
    assert acceptance.validate_settings(settings, directory) == directory
    settings.data_dir.mkdir()
    with pytest.raises(acceptance.AcceptanceError, match="new_state_directory_required"):
        acceptance.validate_settings(settings, directory)


@pytest.mark.parametrize(("change", "code"), [
    ({"config_file": Path("/unrelated/config.toml")}, "runtime_config_file_must_be_none"),
    ({"data_dir": Path("/unrelated/state")}, "isolated_state_path_required"),
    ({"workspace_root": Path("/unrelated/workspace")}, "isolated_workspace_path_required"),
])
def test_guards_refuse_ambiguous_settings_without_creating_state(isolated, change, code):
    settings, directory = isolated
    with pytest.raises(acceptance.AcceptanceError, match=code):
        acceptance.validate_settings(settings.model_copy(update=change), directory)
    assert not (directory / "state").exists()


def test_guard_refuses_broad_directory_permissions_and_symlink_marker(isolated):
    settings, directory = isolated
    directory.chmod(0o755)
    with pytest.raises(acceptance.AcceptanceError, match="mode_0700"):
        acceptance.validate_settings(settings, directory)
    directory.chmod(0o700)
    marker = directory / "ISOLATED_ACCEPTANCE"
    target = directory / "real-marker"
    marker.rename(target)
    marker.symlink_to(target)
    with pytest.raises(acceptance.AcceptanceError, match="isolation_marker_required"):
        acceptance.validate_settings(settings, directory)


def test_private_evidence_is_0600_redacted_and_refuses_symlinks(isolated):
    settings, directory = isolated
    acceptance.private_write(directory, "private.json", {
        "authorization": "credential", "text": settings.api_token, "result": "Bearer abc123",
    }, settings.api_token)
    target = directory / "private.json"
    assert target.stat().st_mode & 0o777 == 0o600
    assert json.loads(target.read_text()) == {
        "authorization": "[redacted]", "text": "[redacted]", "result": "Bearer [redacted]",
    }
    (directory / "linked.json").symlink_to(target)
    with pytest.raises(acceptance.AcceptanceError, match="unsafe_evidence_path"):
        acceptance.private_write(directory, "linked.json", {}, settings.api_token)


def test_default_cli_only_prints_help_without_reading_configuration():
    result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True,
                            env={"PATH": os.environ.get("PATH", ""),
                                 "ZHIXING_CONFIG": "/must-not-read-this/config.toml"}, check=True)
    assert "--run" in result.stdout and not result.stderr


def test_cli_refuses_external_config_before_load_settings(isolated, monkeypatch):
    _, directory = isolated
    monkeypatch.setenv("ZHIXING_CONFIG", "/must-not-read-this/config.toml")
    with pytest.raises(acceptance.AcceptanceError, match="cli_config_must_be_inside"):
        acceptance.main(["--run", "--evidence-dir", str(directory)])


def test_parallel_evidence_does_not_count_queued_or_finished_children_as_running():
    def row(child, status):
        return {"child_id": child, "status": status}

    assert acceptance.parallel_peak([row("a", "running"), row("a", "queued"),
                                      row("b", "running"), row("b", "completed")]) == 1
    assert acceptance.parallel_peak([row("a", "running"), row("b", "running"),
                                      row("a", "completed"), row("b", "completed")]) == 2


def test_collected_results_require_successful_final_versions_and_actual_text():
    receipt = {"value": {"data": {"content": json.dumps({"agents": [
        {"id": "a", "status": "completed", "result_version": 2, "result": "actual"},
        {"id": "b", "status": "running", "result_version": 1, "result": "old"},
        {"id": "c", "status": "completed", "result_version": 0, "result": None},
    ]})}}}
    assert acceptance.observed_wait_results([receipt]) == {("a", 2)}


def test_fixture_read_assertion_requires_a_successful_tool_result():
    history = [
        AIMessage(content="", tool_calls=[
            {"id": "ok", "name": "read_text_file", "args": {"path": "uploads/supply.txt"}},
            {"id": "bad", "name": "read_text_file", "args": {"path": "uploads/delivery.txt"}},
        ]),
        ToolMessage(content="synthetic data", tool_call_id="ok", status="success"),
        ToolMessage(content="failed", tool_call_id="bad", status="error"),
    ]
    assert acceptance.successful_read_paths({"history_json": json.dumps(messages_to_dict(history))}) == {"uploads/supply.txt"}


def test_fixture_reads_support_native_typed_history_and_provider_metadata():
    history = [AIMessage(content="", additional_kwargs={"signature": b"\x00\xff"}, tool_calls=[
        {"id": "read", "name": "read_text_file", "args": {"path": "uploads/supply.txt"}},
    ]), ToolMessage(content="synthetic data", tool_call_id="read")]
    assert acceptance.successful_read_paths({"history_json": _encode_history(history)}) == {"uploads/supply.txt"}


def test_completed_results_may_be_closed_only_after_observing_same_final_version():
    children = [
        {"id": "a", "status": "closed", "result_version": 2, "result": "supply"},
        {"id": "b", "status": "closed", "result_version": 1, "result": "delivery"},
    ]
    assert acceptance.child_results_collected(children, {("a", 2), ("b", 1)})
    assert not acceptance.child_results_collected(children, {("a", 1), ("b", 1)})
    children[0]["result"] = None
    assert not acceptance.child_results_collected(children, {("a", 2), ("b", 1)})


def test_orchestration_usability_counts_failed_generic_task_before_research_start():
    def event(tool, identifier, status, **extra):
        return {"type": "tool", "data": {"tool": tool, "tool_call_id": identifier,
                                          "status": status, **extra}}

    evidence = {"events_complete": True, "events": [
        event("task", "bad1", "failed"), event("task", "bad2", "failed"),
        event("start_agent", "start", "started"), event("start_agent", "start", "completed"),
        event("read_text_file", "same", "completed", child_id="a"),
        event("read_text_file", "same", "completed", child_id="b"),
    ]}
    metric = acceptance.orchestration_usability(evidence, "start_agent")
    assert metric["first_orchestration_tool"] == "task"
    assert metric["first_orchestration_choice_correct"] is False
    assert metric["failed_tool_calls"] == metric["root_failed_calls"] == 2
    assert metric["total_tool_calls"] == 5 and metric["child_failed_calls"] == 0
    evidence["events"] = evidence["events"][2:]
    fixed = acceptance.orchestration_usability(evidence, "start_agent")
    assert fixed["first_orchestration_choice_correct"] is True and fixed["failed_tool_calls"] == 0


def test_business_choice_specs_allow_real_context_reads_without_scoring_research_as_finance_health():
    specifications = acceptance.BUSINESS_SCENARIOS
    assert set(specifications) == {"health_weight", "health_profile_patch", "linked_meal", "linked_meal_correction"}
    assert "query_health_context" in specifications["health_weight"]["expected_first_tools"]
    assert "query_life_events" in specifications["linked_meal_correction"]["expected_first_tools"]
    assert specifications["linked_meal_correction"]["expected_success_tools"] == ["correct_life_meal"]
    assert "parallel_research" not in specifications and "conversation_consultation" not in specifications


@pytest.mark.parametrize("fail_assertion", [False, True])
async def test_driver_uses_actual_asgi_queue_worker_and_saves_truthful_failure(
    isolated, monkeypatch, fail_assertion,
):
    settings, directory = isolated
    workers, inputs = [], []

    async def fake_model_runner(settings, run, *, persona, emit, controls, acknowledge):
        # Only the model runner is mocked. API, queue, worker and receipt storage
        # remain real; this validates driver wiring, not tool-selection behavior.
        inputs.append(run)
        assert run["memory_processed"] == 1
        return "这是测试运行器的回复。"

    def worker_factory(settings):
        worker = Worker(settings, runner=fake_model_runner)
        workers.append(worker)
        return worker

    class MinimalSuite(acceptance.AcceptanceSuite):
        async def run(self):
            conversation = await self.conversation("离线驱动器测试")
            result = await self.turn("driver_case", conversation, "请概括这条虚构测试消息。")
            assert result["run"]["status"] == "completed"
            self.checked("driver_case", {"deliberate_check": not fail_assertion})
            return {"status": "passed", "real_model_run": False, "checks": self.case_results}

    monkeypatch.setattr("zhixing_next.worker.Worker", worker_factory)
    monkeypatch.setattr(acceptance, "AcceptanceSuite", MinimalSuite)
    result = await acceptance.run_acceptance(settings, directory, case_timeout=3)
    assert result["status"] == ("failed" if fail_assertion else "passed")
    assert inputs and workers[0].store.next_memory_run() is None
    evidence = json.loads((directory / "turn-driver_case.json").read_text())
    assert evidence["business_verification"]["passed"] is not fail_assertion
    assert evidence["run"]["status"] == "completed"
    if fail_assertion:
        error = json.loads((directory / "error.json").read_text())
        assert set(error) == {"exception_type", "frames"}
        assert error["frames"] and all(set(frame) == {"file", "function", "line"} for frame in error["frames"])
        assert all("/" not in frame["file"] for frame in error["frames"])
    assert not workers[0].active and workers[0].memory_task is None
    for path in directory.glob("*.json"):
        assert path.stat().st_mode & 0o777 == 0o600
        assert "FICTIONAL-NOT-A-REAL-PROVIDER-KEY" not in path.read_text()


async def test_timeout_retains_incomplete_run_instead_of_fabricating_success(isolated, monkeypatch):
    import asyncio

    settings, directory = isolated

    async def blocked_model(*args, **kwargs):
        await asyncio.Event().wait()

    class TimeoutSuite(acceptance.AcceptanceSuite):
        async def run(self):
            conversation = await self.conversation("超时驱动器测试")
            await self.turn("timeout_case", conversation, "概括这条虚构消息。")

    monkeypatch.setattr("zhixing_next.worker.Worker", lambda settings: Worker(settings, runner=blocked_model))
    monkeypatch.setattr(acceptance, "AcceptanceSuite", TimeoutSuite)
    result = await acceptance.run_acceptance(settings, directory, case_timeout=1)
    assert result["status"] == "failed" and result["code"] == "case_timeout"
    evidence = json.loads((directory / "turn-timeout_case.json").read_text())
    assert evidence["run"]["status"] != "completed"
    assert not evidence.get("business_verification", {}).get("passed")
