"""Offline usability analysis must expose missing evidence and preserve privacy."""

import importlib.util
import json
import subprocess
import sys
import types
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "tool_usability_eval.py"
SPEC = importlib.util.spec_from_file_location("tool_usability_eval", SCRIPT)
evaluation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evaluation)


def event(tool, identifier, status, **extra):
    return {"type": "tool", "data": {"tool": tool, "tool_call_id": identifier,
                                      "status": status, **extra}}


def evidence(events=None, **extra):
    result = {"message_id": "user-1", "run": {"status": "completed", "model_id": "fixture"},
              "operations": [], "snapshot": {}, **extra}
    if events is not None:
        result.update(events=events, events_complete=True)
    return result


def test_complete_is_not_business_success_or_truthful_success_claim():
    result = evaluation.analyse_turn(evidence())
    assert result["completed"]
    assert result["business_verification"]["passed"] is None
    assert result["business_verification"]["false_success"] is None
    assert result["first_parameter_failure"] is None
    assert result["entry"] == "unknown"


def test_parameter_failure_and_same_tool_retry_are_counted_separately_from_completion():
    events = [
        event("record_weight", "bad", "started"),
        event("record_weight", "bad", "failed", failure_category="parameter_validation",
              error_code="invalid_tool_arguments"),
        event("record_weight", "good", "started"),
        event("record_weight", "good", "completed"),
    ]
    result = evaluation.analyse_turn(evidence(events), {
        "entry": "direct", "expected_first_tools": ["record_weight"],
    })
    assert result["entry"] == "direct"
    assert result["total_tool_calls"] == 2
    assert result["first_business_tool_correct"] is True
    assert result["first_parameter_failure"] is True
    assert result["known_parameter_failures"] == 1
    assert result["retries_after_failure"] == result["recovered_tool_sequences"] == 1


def test_reused_call_id_after_new_start_is_another_attempt():
    events = [event("record_weight", "same", "started"),
              event("record_weight", "same", "failed", error="ValidationError"),
              event("record_weight", "same", "started"),
              event("record_weight", "same", "completed")]
    result = evaluation.analyse_turn(evidence(events))
    assert result["total_tool_calls"] == 2
    assert result["known_parameter_failures"] == 1


def test_duplicate_terminal_events_are_not_extra_calls():
    result = evaluation.analyse_turn(evidence([
        event("record_weight", "same", "started"),
        event("record_weight", "same", "completed"),
        event("record_weight", "same", "completed"),
    ]))
    assert result["total_tool_calls"] == 1


def test_root_and_children_scope_reused_provider_call_ids_independently():
    attempts, coverage = evaluation.tool_attempts(evidence([
        event("calculate", "call-1", "started"),
        event("read_text_file", "call-1", "started", child_id="child-a"),
        event("read_text_file", "call-1", "started", child_id="child-b"),
        event("read_text_file", "call-1", "failed", child_id="child-a",
              failure_category="parameter_validation"),
        event("calculate", "call-1", "completed"),
        event("read_text_file", "call-1", "completed", child_id="child-b"),
    ]))
    assert coverage == "events" and len(attempts) == 3
    assert [(item["child_id"], item["tool"], item["status"]) for item in attempts] == [
        (None, "calculate", "completed"), ("child-a", "read_text_file", "failed"),
        ("child-b", "read_text_file", "completed"),
    ]


def test_success_in_another_child_is_not_recovery_of_the_failed_child():
    result = evaluation.analyse_turn(evidence([
        event("read_text_file", "same", "failed", child_id="child-a",
              failure_category="parameter_validation"),
        event("read_text_file", "same", "completed", child_id="child-b"),
    ]))
    assert result["retries_after_failure"] == result["recovered_tool_sequences"] == 0
    assert result["unrecovered_tool_names"] == 1


def test_successful_context_read_does_not_hide_first_write_parameter_failure():
    result = evaluation.analyse_turn(evidence([
        event("query_health_context", "read", "completed"),
        event("record_weight", "bad", "failed", failure_category="parameter_validation"),
    ]))
    assert result["first_parameter_failure"] is False
    assert result["first_write_parameter_failure"] is True


def test_journal_only_counts_are_lower_bounds_and_do_not_guess_error_category():
    result = evaluation.analyse_turn(evidence(operations=[
        {"tool": "record_weight", "state": "failed"},
        {"tool": "record_weight", "state": "succeeded"},
    ]), {"expected_first_tools": ["record_weight"]})
    assert result["trace_coverage"] == "journal_lower_bound"
    assert result["total_tool_calls"] == 2
    assert result["first_business_tool_correct"] is None
    assert result["first_parameter_failure"] is None
    assert result["unclassified_failed_calls"] == 1


def test_partial_events_do_not_claim_first_choice_or_route():
    data = evidence([event("record_weight", "ok", "completed")])
    data["events_complete"] = False
    result = evaluation.analyse_turn(data, {"entry": "main", "expected_first_tools": ["record_weight"]})
    assert result["first_business_tool_correct"] is None
    assert result["entry"] == "unknown"


def test_route_groups_use_actual_delegation_and_preserve_requested_entry():
    data = evidence([event("task", "delegate", "started"),
                     event("record_weight", "record", "completed"),
                     event("task", "delegate", "completed")])
    result = evaluation.analyse_turn(data, {"entry": "main"})
    assert result["entry"] == "delegated"
    assert result["requested_entry"] == "main"
    assert result["requested_route_observed"] is None
    assert result["first_business_tool"] == "record_weight"


def test_independent_record_assertions_detect_duplicate_and_false_success():
    data = evidence([event("record_weight", "ok", "completed")],
                    snapshot={"health": {"weights": [
                        {"source_id": "user-1", "value": 70.9},
                        {"source_id": "user-1", "value": 70.9},
                    ]}}, business_verification={"success_claim": True})
    result = evaluation.analyse_turn(data, {
        "expected_records": [{"collection": "health.weights", "count": 1,
                              "fields": {"value": 70.9}}],
        "expected_success_tools": ["record_weight"],
    })["business_verification"]
    assert result["passed"] is False
    assert result["duplicate_write"] is True
    assert result["false_success"] is True


def test_other_sources_do_not_satisfy_expected_records():
    data = evidence(snapshot={"meals": [{"source_id": "another-user-message"}]})
    result = evaluation.verify_business(data, {"expected_records": [
        {"collection": "meals", "count": 1},
    ]})
    assert result["passed"] is False
    assert result["duplicate_write"] is False


def test_snapshot_and_receipt_both_required_when_specified():
    data = evidence([], snapshot={"budget": {"daily_budget": "1800.00"}})
    result = evaluation.analyse_turn(data, {
        "expected_success_tools": ["update_finance_budget"],
        "snapshot_checks": [{"path": "budget.daily_budget", "equals": "1800.00"}],
    })
    assert result["business_verification"]["passed"] is False


def test_supplied_business_verification_supports_existing_acceptance_assertions():
    result = evaluation.analyse_turn(evidence(business_verification={
        "passed": True, "duplicate_write": False, "success_claim": True,
    }))["business_verification"]
    assert result == {"passed": True, "duplicate_write": False, "success_claim": True,
                      "false_success": False, "assertions": 0, "unknown_assertions": 0}


def test_aggregate_keeps_unknown_denominators_and_groups_models_and_entries():
    turns = [evaluation.analyse_turn(evidence([]), {"entry": "main"}),
             evaluation.analyse_turn(evidence([]), {"entry": "direct"})]
    report = evaluation.summarise(turns)
    assert len(report["groups"]) == 2
    assert all(group["first_business_tool_correct"]["known"] == 0 for group in report["groups"])
    assert all(group["first_business_tool_correct"]["rate"] is None for group in report["groups"])


def test_offline_cli_does_not_import_online_client_or_echo_private_content(tmp_path):
    secret = "PRIVATE-PROMPT-AND-REPLY"
    path = tmp_path / "turn-case.json"
    path.write_text(json.dumps(evidence([], run={"status": "completed", "result": secret},
                                        snapshot={"secret": secret})), encoding="utf-8")
    result = subprocess.run([sys.executable, str(SCRIPT), str(tmp_path)], check=True,
                            capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
    assert secret not in result.stdout + result.stderr
    assert json.loads(result.stdout)["mode"] == "offline_analysis"


def test_catalog_has_twelve_natural_scenarios_and_variants_without_tool_prompts():
    cases = evaluation.catalog()
    assert len(cases) == 12
    for case in cases.values():
        assert len(case["prompts"]) >= 2
        assert all(not any(tool in prompt for tool in evaluation.BUSINESS_TOOLS)
                   for prompt in case["prompts"])
        assert case["expected_first_tools"] and case["expected_success_tools"]


def test_offline_reader_rejects_symlink_and_oversize_files(tmp_path):
    target = tmp_path / "private.json"
    target.write_text("{}", encoding="utf-8")
    link = tmp_path / "turn-link.json"
    link.symlink_to(target)
    with pytest.raises(evaluation.EvaluationError, match="regular_json_file_required"):
        evaluation.load_json(link)
    with target.open("wb") as file:
        file.truncate(evaluation.MAX_EVIDENCE_BYTES + 1)
    with pytest.raises(evaluation.EvaluationError, match="evidence_too_large"):
        evaluation.load_json(target)


def test_collect_events_paginates_and_detects_nonadvancing_cursor():
    class Client:
        def request(self, method, path, params):
            assert method == "GET" and "events" in path
            return {"items": [{"seq": params["after"] + 1}],
                    "next_cursor": "1" if params["after"] == 0 else None}

    assert evaluation.collect_events(Client(), "run") == ([{"seq": 1}, {"seq": 2}], True)


def test_online_driver_is_explicit_preserves_identity_and_writes_private_evidence(tmp_path, monkeypatch):
    messages, conversations = [], []

    class Acceptance:
        def __init__(self, *args):
            self.state = {"today": datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat(),
                          "namespace": "12345678-1234-5678-1234-567812345678"}

        def server_guard(self, allow_unmarked):
            assert allow_unmarked is True

        def snapshots(self):
            rows = [{"source_id": messages[-1]["id"], "value": 70.9, "unit": "kg"}] if messages else []
            return {"health": {"weights": rows}, "transactions": [], "meals": []}

        def request(self, method, path, payload=None, params=None):
            if method == "POST" and path == "/v1/conversations":
                conversations.append(payload)
                return {"id": "conversation"}
            if method == "POST" and path.endswith("/messages"):
                messages.append(payload)
                return {"run": {"id": "run"}}
            if path.endswith("/events"):
                return {"items": [event("record_weight", "write", "completed")], "next_cursor": None}
            if path.endswith("/operations"):
                return {"items": [{"tool": "record_weight", "state": "succeeded"}]}
            if path == "/v1/finance/budget":
                return {}
            assert path == "/v1/runs/run"
            return {"status": "completed", "model_id": "fake-model"}

    def private_write(directory, name, value, token):
        assert token == "fictional-test-token"
        path = directory / name
        path.write_text(json.dumps(value), encoding="utf-8")
        path.chmod(0o600)

    module = types.ModuleType("accept_life_services")
    module.Acceptance = Acceptance
    module.isolation = lambda: ("http://127.0.0.1:1", "fictional-test-token", tmp_path)
    module.private_write = private_write
    monkeypatch.setitem(sys.modules, "accept_life_services", module)
    first = evaluation.run_case("weight", "direct", 0, None, 30)
    second = evaluation.run_case("weight", "direct", 0, None, 30)
    assert len(conversations) == 1 and conversations[0]["agent_id"] == "health"
    assert messages[0] == messages[1]
    assert first["turns"][0]["business_verification"]["passed"] is True
    assert second["turns"][0]["entry"] == "direct"
    saved = list(tmp_path.glob("turn-*.json"))
    assert len(saved) == 1 and saved[0].stat().st_mode & 0o777 == 0o600


def test_same_scenario_variant_is_compared_across_actual_entries():
    turns = [evaluation.analyse_turn(evidence([]), {
        "scenario_id": "weight", "variant": "0", "entry": entry,
    }) for entry in ("main", "direct")]
    comparison = evaluation.summarise(turns)["cross_entry_comparisons"][0]
    assert comparison["comparable_entries"] == 2
    assert {item["entry"] for item in comparison["entries"]} == {"main", "direct"}
