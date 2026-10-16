"""The acceptance driver is tested locally; these tests are NOT model acceptance."""

import hashlib
import importlib.util
import json
import os
import sqlite3
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
    ("路线安排完全空白，既未承诺可靠换乘，也未声明免责；责任归属未知。", False),
    ("没有说明赔付标准，风险由乘客承担。", True),
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


@pytest.mark.parametrize("change", ["none", "guessed_clock", "missing_note"])
def test_unknown_time_assertion_checks_saved_source_recording_time_not_reply_wording(isolated, change):
    settings, directory = isolated
    store = Store(settings)
    conversation = store.create_conversation("虚构未知时间验收")
    receipt = store.submit_message(conversation["id"], id="lunch", content="今天午饭吃了米饭")
    source_time = receipt["message"]["created_at"]
    meal = {"occurred_at": source_time, "note": "实际用餐时间未知，使用记录时间。"}
    if change == "guessed_clock":
        meal["occurred_at"] = (datetime.fromisoformat(source_time) + timedelta(hours=1)).isoformat()
    if change == "missing_note":
        meal["note"] = ""
    suite = acceptance.AcceptanceSuite(settings, directory, None, store, None, 1, None)
    assert suite.unknown_meal_time_preserved(meal, "lunch") is (change == "none")


@pytest.mark.parametrize("description,consistent", [
    ("午饭：豆腐、青菜、米饭（米饭剩了一半）", False),
    ("豆腐、青菜、米饭剩半", False),
    ("午饭：豆腐、青菜、米饭", True),
    ("午饭：豆腐、青菜、米饭（米饭吃约三分之一）", True),
])
async def test_linked_correction_checker_rejects_superseded_quantity_in_saved_description(
    isolated, monkeypatch, description, consistent,
):
    # Synthetic snapshots exercise the real case checker. This is not a model
    # choice test or a natural-language reply classifier.
    settings, directory = isolated
    store = Store(settings)
    conversation = store.create_conversation("虚构联餐纠正检查")
    source = store.submit_message(conversation["id"], id="lunch", content="午饭24.60元，豆腐青菜米饭，米饭剩了一半")
    meal = {"id": "meal", "source_id": "lunch", "description": "午饭：豆腐、青菜、米饭（米饭剩了一半）",
            "portion": "米饭剩了一半", "occurred_at": source["message"]["created_at"],
            "note": "实际用餐时间未知，使用记录时间。"}
    transaction = {"id": "payment", "source_id": "lunch", "amount": "24.60"}
    snapshots = {
        "linked_meal": {"meals": [meal], "transactions": [transaction]},
        "linked_meal_correction": {
            "meals": [{**meal, "description": description, "portion": "米饭吃约三分之一"}],
            "transactions": [{**transaction, "amount": "22.60"}],
        },
    }
    suite = acceptance.AcceptanceSuite(settings, directory, None, store, None, 1, None)

    async def existing_conversation(*args):
        return conversation["id"]

    async def supplied_snapshot(key, *args):
        evidence = {"message_id": "lunch", "snapshot": snapshots[key],
                    "run": {"result": "已按明确纠正更新原来的同一条记录。"}, "events": [],
                    "operations": [{"tool": "record_life_meal" if key == "linked_meal" else "correct_life_meal",
                                    "state": "succeeded"}]}
        suite.evidence[key] = evidence
        return evidence

    monkeypatch.setattr(suite, "conversation", existing_conversation)
    monkeypatch.setattr(suite, "turn", supplied_snapshot)
    if consistent:
        await suite.linked_meal()
    else:
        with pytest.raises(acceptance.AcceptanceError, match="linked_meal_correction_business_assertion_failed"):
            await suite.linked_meal()
    assert suite.case_results["linked_meal"]["passed"]
    corrected = suite.case_results["linked_meal_correction"]
    assert corrected["passed"] is consistent
    assert corrected["checks"]["superseded_rice_fact_removed_from_description"] is consistent
    assert corrected["checks"]["corrected_portion"] and corrected["checks"]["food_preserved"]


@pytest.mark.parametrize("reply", [
    "实际用餐时刻：未知，18:37只是消息发送时间，不代表吃饭时间。",
    "实际用餐时间是18:37。",  # Incorrect: independent review must reject it.
    "风险由乘客承担。",  # A heuristic flag is not a completed semantic review.
    "风险责任未知。",
])
def test_all_natural_replies_require_independent_review_even_without_flags(reply):
    evidence = {"run": {"result": reply}}
    acceptance.AcceptanceSuite.semantic_review(evidence)
    assert evidence["semantic_review"]["status"] == "required"
    assert evidence["semantic_review"]["review_all_replies_even_without_flags"] is True
    assert "passed" not in evidence["semantic_review"]


@pytest.mark.parametrize("reply,additional", [
    ("Every Wednesday HARBOR-42 does not operate; other-day schedules are unknown.", "Transfers are not guaranteed."),
    ("HARBOR-42 每周三不停航，其他日子都有班次，保证转乘。", "HARBOR-42 周三停航这句话是错的，保证转乘。"),
])
def test_required_claims_bind_full_replies_without_classifying_factual_fidelity(reply, additional):
    evidence = {"run": {"result": reply}}
    claims = [{"id": "prior_context_in_real_reply", "reply": "additional_reply", "must_check": "Compare the actual reply with its prior facts."}]
    acceptance.AcceptanceSuite.semantic_review(evidence, additional_reply=additional, required_claims=claims)
    review = evidence["semantic_review"]
    assert review["status"] == "required" and review["required_claims"] == claims
    assert review["full_reply_sha256"] == hashlib.sha256(reply.encode("utf-8")).hexdigest()
    assert review["full_additional_reply_sha256"] == hashlib.sha256(additional.encode("utf-8")).hexdigest()
    assert "passed" not in review


async def supplied_consultation_case(isolated, monkeypatch, *, reply, defect=None):
    """Exercise the checker with synthetic receipts, not a real model run."""
    settings, directory = isolated
    store = Store(settings)
    target, source = "existing-target", "source"
    with sqlite3.connect(settings.data_dir / "checkpoints.sqlite") as db:
        db.execute("CREATE TABLE checkpoints(thread_id TEXT)")
        db.execute("INSERT INTO checkpoints VALUES(?)", (target,))
    suite = acceptance.AcceptanceSuite(settings, directory, None, store, None, 1, None)
    identifiers = iter((target, source))

    async def conversation(*args):
        return next(identifiers)

    events = [
        {"type": "tool", "data": {"tool": "send_conversation_message", "tool_call_id": "send", "status": "started"}},
        {"type": "tool", "data": {"tool": "send_conversation_message", "tool_call_id": "send", "status": "completed"}},
        {"type": "paused", "data": {"reason": "agent_wait"}},
    ]
    if defect == "worker_wait_missing":
        events = events[:-1]

    async def turn(key, *args):
        evidence = {"run": {"id": "setup-run" if key == "consultation_target_setup" else "source-run", "status": "completed", "result": reply},
                    "events": events if key == "conversation_consultation" else [], "events_complete": True,
                    "operations": [{"tool": "search_history", "state": "succeeded"}, {"tool": "wait_conversation_replies", "state": "succeeded"}],
                    "snapshot": {}, "before_snapshot": {}, "evaluation": {}}
        suite.evidence[key] = evidence
        return evidence

    receipt = {"target_run_id": "target-run", "target_conversation_id": target,
               "read_only": True, "terminal": True, "status": "completed",
               "reply_message_id": "actual-target-reply", "result": reply}
    if defect == "target_reply_missing":
        receipt["result"] = ""
    elif defect == "wrong_target":
        receipt["target_conversation_id"] = "unexpected-target"
    elif defect == "not_readonly":
        receipt["read_only"] = False

    async def request(method, path, *args, **kwargs):
        if path == "/v1/conversations":
            return {"items": [{"id": target}, {"id": source}]}
        if path == "/v1/runs/source-run/conversation-messages":
            return {"items": [] if defect == "target_delivery_missing" else [receipt]}
        if path == "/v1/runs/target-run":
            return {"id": "target-run", "status": "completed", "result": receipt["result"]}
        raise AssertionError("Unexpected checker request")

    async def target_events(run_id):
        assert run_id == "target-run"
        return [{"type": "conversation.message_received", "data": {"read_only": True}}]

    monkeypatch.setattr(suite, "conversation", conversation)
    monkeypatch.setattr(suite, "turn", turn)
    monkeypatch.setattr(suite, "request", request)
    monkeypatch.setattr(suite, "events", target_events)
    return suite


@pytest.mark.parametrize("reply", [
    "HARBOR-42: Every Wednesday it does not operate. Schedules on other days remain unknown. Transfers are not guaranteed.",
    "HARBOR-42 每周三不停航，其他日子都有班次，保证转乘。周三停航是错误说法。",
])
async def test_consultation_factual_fidelity_always_requires_review_regardless_of_language_or_shared_words(isolated, monkeypatch, reply):
    suite = await supplied_consultation_case(isolated, monkeypatch, reply=reply)
    await suite.consultation()
    for name, claim_ids in (
        ("consultation_target_setup", {"provided_facts_in_reply"}),
        ("conversation_consultation", {"prior_context_in_real_reply", "actual_reply_in_source_summary"}),
    ):
        case = suite.case_results[name]
        assert case["passed"]  # Mechanical receipts only, never factual approval.
        review = case["semantic_review"]
        assert review["status"] == "required" and "passed" not in review
        assert {claim["id"] for claim in review["required_claims"]} == claim_ids
        assert claim_ids.isdisjoint(case["checks"])
        assert review["full_reply_sha256"] == hashlib.sha256(reply.encode("utf-8")).hexdigest()
    review = suite.case_results["conversation_consultation"]["semantic_review"]
    assert review["full_additional_reply_sha256"] == hashlib.sha256(reply.encode("utf-8")).hexdigest()
    # The same pure checker can replay bound saved receipts without API calls.
    saved = json.loads((suite.directory / "consultation-private-deliveries.json").read_text())
    evidence = suite.evidence["conversation_consultation"]
    before = json.dumps(evidence, sort_keys=True)
    recorded = suite.case_results["conversation_consultation"]["checks"]
    replay = suite.consultation_assertions(
        evidence, [item["receipt"] for item in saved], saved[0]["events"], target_id="existing-target",
        checkpointed=recorded["target_real_initial_checkpoint"],
        conversations_unchanged=recorded["no_new_conversation_created"],
        usability=evidence["collaboration_tool_usability"],
    )
    assert replay == recorded and json.dumps(evidence, sort_keys=True) == before


@pytest.mark.parametrize("defect,failed_check", [
    ("target_reply_missing", "actual_readonly_reply"),
    ("target_delivery_missing", "one_delivery_to_existing_target"),
    ("wrong_target", "one_delivery_to_existing_target"),
    ("not_readonly", "actual_readonly_reply"),
    ("worker_wait_missing", "wait_released_worker_slot"),
])
async def test_consultation_missing_actual_target_or_hard_receipt_still_fails(isolated, monkeypatch, defect, failed_check):
    suite = await supplied_consultation_case(isolated, monkeypatch, reply="Every Wednesday HARBOR-42 does not operate.", defect=defect)
    with pytest.raises(acceptance.AcceptanceError, match="conversation_consultation_business_assertion_failed"):
        await suite.consultation()
    case = suite.case_results["conversation_consultation"]
    assert case["passed"] is False and case["checks"][failed_check] is False
    assert case["semantic_review"]["status"] == "required" and "passed" not in case["semantic_review"]


async def test_programmatic_completion_never_self_approves_semantics(isolated, monkeypatch):
    settings, directory = isolated
    suite = acceptance.AcceptanceSuite(settings, directory, None, None, None, 1, None)

    async def completed_programmatic_case():
        pass

    for name in ("health", "linked_meal", "research", "consultation"):
        monkeypatch.setattr(suite, name, completed_programmatic_case)
    result = await suite.run()
    assert result["status"] == "review_pending"
    assert result["programmatic_checks_passed"] is True
    assert result["manual_review_required"] is True and result["semantic_review_status"] == "required"


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


@pytest.mark.parametrize(("clock", "expected"), [
    ("2026-10-17T00:30:00+08:00", "2026-10-16"),
    ("2026-10-17T07:59:59+08:00", "2026-10-16"),
    ("2026-10-17T08:00:00+08:00", "2026-10-17"),
    ("2026-10-16T23:59:59-04:00", "2026-10-17"),
])
def test_explicit_measurement_fixture_never_uses_a_future_morning(clock, expected):
    from datetime import datetime

    assert acceptance.completed_morning_date(datetime.fromisoformat(clock)) == expected
