#!/usr/bin/env python3
"""Measure tool usability from private acceptance receipts; offline by default.

Offline (never reads credentials or calls a model):
  python scripts/tool_usability_eval.py /absolute/private/evidence
  python scripts/tool_usability_eval.py /absolute/private/evidence --manifest manifest.json

Explicit real-model run, using the SAME empty-instance/loopback guards and private
directory environment variables as accept_life_services.py:
  uv run python ../scripts/tool_usability_eval.py --run-case weight --entry direct

--entry delegated sends the same natural prompt to the main assistant and checks
that delegation actually occurred. It does not insert tool names into the prompt.
Raw prompts, replies, event payloads and service snapshots stay in mode-0600 files;
stdout contains metrics only. A completed run alone never proves a business write
or a truthful success claim. Old receipts without events retain unknown metrics.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from uuid import UUID, uuid5
from zoneinfo import ZoneInfo

CATALOG_PATH = Path(__file__).with_name("tool_usability_scenarios.json")
MAX_EVIDENCE_BYTES = 20 * 1024 * 1024
BUSINESS_TOOLS = {
    "get_finance_summary", "list_finance_transactions", "record_finance_transaction",
    "correct_finance_transaction", "delete_finance_transaction", "update_finance_budget",
    "apply_finance_transaction_batch", "reconcile_finance_assets", "publish_finance_report",
    "query_health_context", "save_health_profile", "save_diet_rule", "record_meal",
    "record_weight", "record_steps", "save_meal_recommendation",
    "record_recommendation_feedback", "correct_health_record", "delete_health_record",
    "save_health_reminders", "record_life_meal", "correct_life_meal", "query_life_events",
}
BUSINESS_READ_TOOLS = {
    "get_finance_summary", "list_finance_transactions", "reconcile_finance_assets",
    "query_health_context", "query_life_events",
}
ENTRIES = {"main", "direct", "delegated"}
SAFE_LABEL = re.compile(r"^[\w.:-]{1,160}$")


class EvaluationError(Exception):
    """Only fixed error codes, never evidence or HTTP content, reach stdout."""


def require(condition, code):
    if not condition:
        raise EvaluationError(code)


def load_json(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "regular_json_file_required")
    require(path.stat().st_size <= MAX_EVIDENCE_BYTES, "evidence_too_large")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise EvaluationError("invalid_json_evidence") from exc


def safe_label(value, fallback="unknown"):
    # Do not echo arbitrary labels from private evidence into public summaries.
    return value if isinstance(value, str) and SAFE_LABEL.fullmatch(value) else fallback


def catalog():
    data = load_json(CATALOG_PATH)
    return {case["id"]: case for case in data["cases"]}


def tool_attempts(evidence):
    """Count actual starts, including retries with a reused provider call ID.

    The operations API is a durable journal, not a complete call trace: read-only
    calls/replays may be absent, and its public receipts omit args/results. Prefer
    tool events and explicitly identify journal-only counts as lower bounds.
    """
    events = evidence.get("events")
    if isinstance(events, dict):
        events = events.get("items", [])
    if isinstance(events, list):
        attempts, pending, latest = [], {}, {}
        for event in events:
            if event.get("type") != "tool":
                continue
            data = event.get("data", {})
            tool, identifier = data.get("tool"), data.get("tool_call_id")
            if not isinstance(tool, str) or not isinstance(identifier, str):
                continue
            status = data.get("status")
            if status not in {"started", "completed", "failed"}:
                continue
            # Providers may reuse a call ID in the root and multiple children.
            # Child identity scopes the start/end pairing within the shared trace.
            source = data.get("child_id") or "root"
            key = (source, identifier)
            if status == "started" or key not in latest:
                attempt = {"tool": tool, "status": "started", "failure_category": None,
                           "child_id": data.get("child_id")}
                attempts.append(attempt)
                pending[key] = attempt
                latest[key] = attempt
            attempt = latest[key]
            if status != "started":
                attempt.update(status=status, failure_category=data.get("failure_category"),
                               error_code=data.get("error_code"), error=data.get("error"))
                pending.pop(key, None)
        # If pagination was truncated, precise total/first-call claims are unsafe.
        return attempts, "events" if evidence.get("events_complete") is True else "partial_events"
    attempts = []
    for operation in evidence.get("operations", []):
        state = operation.get("state")
        attempts.append({"tool": operation.get("tool", "unknown"),
                         "status": {"succeeded": "completed", "failed": "failed",
                                    "denied": "failed"}.get(state, "started"),
                         "failure_category": None})
    return attempts, "journal_lower_bound"


def parameter_failure(attempt):
    if attempt["status"] == "completed":
        return False
    if attempt.get("failure_category") == "parameter_validation":
        return True
    # Older events only exposed the exception class; this one is unambiguous.
    if attempt.get("error") == "ValidationError":
        return True
    return None


def path_value(value, path):
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return None, False
        value = value[part]
    return value, True


def verify_business(evidence, specification):
    """Independent snapshot assertions, or explicit results from another verifier.

    Success-claim review is deliberately separate: neither status=completed nor
    a keyword in model prose is treated as a verified claim of a successful write.
    """
    supplied = evidence.get("business_verification", {})
    supplied = supplied if isinstance(supplied, dict) else {}
    assertions, duplicate_checks = [], []
    before, after = evidence.get("before_snapshot"), evidence.get("snapshot")
    source = evidence.get("message_id")
    for check in specification.get("expected_records", []):
        rows, found = path_value(after, check["collection"])
        if not found or not isinstance(rows, list) or not source:
            assertions.append(None)
            duplicate_checks.append(None)
            continue
        rows = [row for row in rows if row.get("source_id") == source]
        expected_count = check["count"]
        duplicate_checks.append(len(rows) > expected_count)
        matches = all(
            all(row.get(field) == expected for field, expected in check.get("fields", {}).items())
            and all(text in str(row.get(field, ""))
                    for field, text in check.get("contains", {}).items())
            for row in rows
        )
        assertions.append(len(rows) == expected_count and matches)
    for collection in specification.get("unchanged_collections", []):
        old, old_found = path_value(before, collection)
        new, new_found = path_value(after, collection)
        assertions.append(old == new if old_found and new_found else None)
    for path in specification.get("preserved_paths", []):
        old, old_found = path_value(before, path)
        new, new_found = path_value(after, path)
        assertions.append(old == new if old_found and new_found else None)
    for check in specification.get("snapshot_checks", []):
        value, found = path_value(after, check["path"])
        if not found:
            assertions.append(None)
        elif "equals" in check:
            assertions.append(value == check["equals"])
        else:
            assertions.append(check["contains"] in value if isinstance(value, (str, list)) else False)
    if assertions:
        passed = False if False in assertions else True if None not in assertions else None
    else:
        passed = supplied.get("passed") if type(supplied.get("passed")) is bool else None
    if duplicate_checks:
        duplicate = True if True in duplicate_checks else False if None not in duplicate_checks else None
    else:
        duplicate = supplied.get("duplicate_write")
        duplicate = duplicate if type(duplicate) is bool else None
    claim = supplied.get("success_claim")
    claim = claim if type(claim) is bool else None
    false_success = claim and not passed if claim is not None and passed is not None else None
    return {"passed": passed, "duplicate_write": duplicate, "success_claim": claim,
            "false_success": false_success, "assertions": len(assertions),
            "unknown_assertions": sum(item is None for item in assertions)}


def analyse_turn(evidence, specification=None):
    specification = specification or evidence.get("evaluation", {})
    attempts, coverage = tool_attempts(evidence)
    complete = coverage == "events"
    business = [item for item in attempts if item["tool"] in BUSINESS_TOOLS]
    first = business[0] if business else None
    writes = [item for item in business if item["tool"] not in BUSINESS_READ_TOOLS]
    first_write = writes[0] if writes else None
    allowed = specification.get("expected_first_tools")
    first_choice = (first is not None and first["tool"] in allowed) if complete and allowed else None
    first_parameter_failure = parameter_failure(first) if complete and first else None
    failed = [item for item in attempts if item["status"] == "failed"]
    pending, retries, recovered = set(), 0, 0
    for attempt in attempts:
        tool = attempt["tool"]
        source_tool = (attempt.get("child_id"), tool)
        if source_tool in pending:
            retries += 1
            if attempt["status"] == "completed":
                pending.remove(source_tool)
                recovered += 1
        if attempt["status"] == "failed":
            pending.add(source_tool)
    requested = specification.get("entry", "unknown")
    delegated = any(item["tool"] == "task" for item in attempts)
    actual_entry = "direct" if requested == "direct" else "delegated" if delegated else "main"
    if not complete and requested != "direct" and not delegated:
        actual_entry = "unknown"
    business_verification = verify_business(evidence, specification)
    expected_success_tools = specification.get("expected_success_tools", [])
    if expected_success_tools:
        receipts = {item.get("tool") for item in evidence.get("operations", [])
                    if item.get("state") == "succeeded"}
        succeeded = {item["tool"] for item in attempts if item["status"] == "completed"}
        receipt_ok = bool(set(expected_success_tools) & (receipts | succeeded))
        # An absent receipt in partial evidence is unknown; never infer success
        # from a matching snapshot left over from a previous case.
        if not receipt_ok:
            business_verification["passed"] = False if complete else None
            claim = business_verification["success_claim"]
            business_verification["false_success"] = claim if complete and claim is not None else None
    run = evidence.get("run", {})
    return {
        "scenario_id": safe_label(specification.get("scenario_id", "unlabelled")),
        "variant": safe_label(specification.get("variant", "original")),
        "model_id": safe_label(run.get("model_id") or specification.get("model_id")),
        "model_scope": "parent_run", "requested_entry": requested if requested in ENTRIES else "unknown",
        "entry": actual_entry, "delegation_observed": delegated,
        # Main entry permits normal routing; only delegated/direct imposes a route.
        "requested_route_observed": actual_entry == requested if requested in {"direct", "delegated"} and complete else None,
        "completed": run.get("status") == "completed",
        "trace_coverage": coverage, "first_business_tool": safe_label(first["tool"]) if first else None,
        "first_business_tool_correct": first_choice,
        "first_parameter_failure": first_parameter_failure,
        "first_business_write": safe_label(first_write["tool"]) if first_write else None,
        "first_write_parameter_failure": parameter_failure(first_write) if complete and first_write else None,
        "total_tool_calls": len(attempts), "failed_tool_calls": len(failed),
        "known_parameter_failures": sum(parameter_failure(item) is True for item in failed),
        "unclassified_failed_calls": sum(not item.get("failure_category")
                                          and parameter_failure(item) is None for item in failed),
        # Same-tool retries are an observable proxy, not proof of corrected semantics.
        "retries_after_failure": retries, "recovered_tool_sequences": recovered,
        "unrecovered_tool_names": len(pending), "business_verification": business_verification,
    }


def metric(values):
    known = [value for value in values if type(value) is bool]
    return {"true_count": sum(known), "known": len(known), "unknown": len(values) - len(known),
            "rate": sum(known) / len(known) if known else None}


def summarise(turns):
    grouped = defaultdict(list)
    for turn in turns:
        grouped[(turn["model_id"], turn["entry"])].append(turn)
    groups = []
    for (model, entry), rows in sorted(grouped.items()):
        groups.append({
            "model_id": model, "entry": entry, "turns": len(rows),
            "first_business_tool_correct": metric([row["first_business_tool_correct"] for row in rows]),
            "first_parameter_failure": metric([row["first_parameter_failure"] for row in rows]),
            "first_write_parameter_failure": metric([row["first_write_parameter_failure"] for row in rows]),
            "business_completed": metric([row["business_verification"]["passed"] for row in rows]),
            "false_success": metric([row["business_verification"]["false_success"] for row in rows]),
            "duplicate_write": metric([row["business_verification"]["duplicate_write"] for row in rows]),
            "total_tool_calls": sum(row["total_tool_calls"] for row in rows),
            "failed_tool_calls": sum(row["failed_tool_calls"] for row in rows),
            "retries_after_failure": sum(row["retries_after_failure"] for row in rows),
            "complete_traces": sum(row["trace_coverage"] == "events" for row in rows),
        })
    comparable = defaultdict(list)
    for turn in turns:
        comparable[(turn["model_id"], turn["scenario_id"], turn["variant"])].append(turn)
    comparisons = [
        {"model_id": model, "scenario_id": scenario, "variant": variant,
         "comparable_entries": len({row["entry"] for row in rows} - {"unknown"}),
         "initial_state_equivalence": "not_verified",
         "entries": [{"entry": row["entry"],
                      "business_completed": row["business_verification"]["passed"],
                      "first_write_parameter_failure": row["first_write_parameter_failure"],
                      "failed_tool_calls": row["failed_tool_calls"]} for row in rows]}
        for (model, scenario, variant), rows in sorted(comparable.items())
        if scenario != "unlabelled"
    ]
    return {"schema": 1, "mode": "offline_analysis", "groups": groups, "turns": turns,
            "cross_entry_comparisons": comparisons,
            "limitations": ["journal-only call counts are lower bounds",
                             "retry counts mean subsequent calls to the same failed tool",
                             "success claims require an explicit independent review",
                             "cross-entry comparisons match scenario/variant, not initial service state",
                             "parent model labels do not identify delegated child models"]}


def analyse_directory(directory, manifest=None):
    directory = Path(directory)
    require(directory.is_dir() and not directory.is_symlink(), "evidence_directory_required")
    manifest = load_json(manifest) if manifest else {}
    turns = []
    for path in sorted(directory.glob("turn-*.json")):
        evidence = load_json(path)
        specification = manifest.get(path.name, evidence.get("evaluation", {}))
        turns.append(analyse_turn(evidence, specification))
    require(bool(turns), "no_turn_evidence")
    return summarise(turns)


def collect_events(acceptance, run_id):
    events, after = [], 0
    for _ in range(100):
        page = acceptance.request("GET", f"/v1/runs/{run_id}/events",
                                  params={"after": after, "limit": 100})
        items = page["items"]
        events.extend(items)
        cursor = page.get("next_cursor")
        if cursor is None:
            return events, True
        require(int(cursor) > after, "event_cursor_did_not_advance")
        after = int(cursor)
    return events, False


def collect_snapshot(acceptance):
    snapshot = acceptance.snapshots()
    snapshot["budget"] = acceptance.request("GET", "/v1/finance/budget")
    return snapshot


def run_case(case_id, entry, variant, model_id, timeout):
    """Explicit online path; reuse guarded transport, stable IDs and private IO."""
    import httpx
    from accept_life_services import Acceptance, isolation, private_write

    cases = catalog()
    require(case_id in cases, "unknown_case")
    case = cases[case_id]
    require(0 <= variant < len(case["prompts"]), "unknown_prompt_variant")
    require(entry != "direct" or case.get("agent_id"), "case_requires_main_entry")
    base, token, directory = isolation()
    lock_path = directory / ".acceptance.lock"
    require(not lock_path.is_symlink(), "unsafe_acceptance_lock")
    with lock_path.open("a+") as lock:
        os.chmod(lock_path, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise EvaluationError("acceptance_already_running") from exc
        with httpx.Client(base_url=base, headers={"Authorization": f"Bearer {token}"},
                          timeout=30, follow_redirects=False, trust_env=False) as client:
            acceptance = Acceptance(client, directory, token, timeout)
            acceptance.server_guard(allow_unmarked=True)
            require(acceptance.state["today"] == datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat(),
                    "acceptance_session_date_has_passed")
            key = f"usability-{case_id}-{entry}-{variant}-{model_id or 'default'}"
            require(SAFE_LABEL.fullmatch(key), "invalid_case_identity")
            state_path = directory / "usability-state.json"
            state = load_json(state_path) if state_path.exists() else {}
            item = state.get(key)
            if item is None:
                body = {"title": f"调用体验虚构验收 {case_id} {entry}"}
                if entry == "direct":
                    body["agent_id"] = case["agent_id"]
                conversation = acceptance.request("POST", "/v1/conversations", body)
                prompt = case["prompts"][variant].format(today=acceptance.state["today"],
                                                       month=acceptance.state["today"][:7])
                message = {"id": str(uuid5(UUID(acceptance.state["namespace"]), key)),
                           "content": prompt, "kind": "chat"}
                if model_id:
                    message["model_id"] = model_id
                item = {"conversation_id": conversation["id"], "message": message,
                        "before_snapshot": collect_snapshot(acceptance)}
                state[key] = item
                private_write(directory, "usability-state.json", state, token)
            # The exact saved message ID/text survives a dropped network response.
            # A failed run is inspected, never silently re-enqueued as a new turn.
            receipt = acceptance.request("POST", f"/v1/conversations/{item['conversation_id']}/messages",
                                         item["message"])
            run_id, deadline = receipt["run"]["id"], time.monotonic() + timeout
            while True:
                run = acceptance.request("GET", f"/v1/runs/{run_id}")
                if run["status"] in {"completed", "failed", "cancelled", "interrupted"}:
                    break
                require(run.get("phase") not in {"approval", "input"}, "interactive_input_requested")
                require(time.monotonic() < deadline, "model_run_timeout")
                time.sleep(2)
            events, complete = collect_events(acceptance, run_id)
            snapshot = collect_snapshot(acceptance)
            specification = {**case, "scenario_id": case_id, "entry": entry,
                             "variant": str(variant), "model_id": model_id}
            specification.pop("prompts", None)
            evidence = {"message_id": item["message"]["id"], "run": run,
                        "operations": acceptance.request("GET", f"/v1/runs/{run_id}/operations")["items"],
                        "events": events, "events_complete": complete,
                        "before_snapshot": item["before_snapshot"], "snapshot": snapshot,
                        "evaluation": specification}
            private_write(directory, f"turn-{key}.json", evidence, token)
            return summarise([analyse_turn(evidence)])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directory", nargs="?", help="Private turn-*.json evidence directory")
    parser.add_argument("--manifest", help="Optional filename-to-scenario metadata JSON")
    parser.add_argument("--run-case", help="Explicitly call a real model on a guarded isolated backend")
    parser.add_argument("--entry", choices=sorted(ENTRIES), default="main")
    parser.add_argument("--variant", type=int, default=0)
    parser.add_argument("--model-id")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--list-cases", action="store_true")
    args = parser.parse_args(argv)
    require(not (args.directory and args.run_case), "choose_offline_or_online")
    if args.list_cases:
        result = {"mode": "catalog", "cases": list(catalog().values())}
    elif args.run_case:
        require(1 <= args.timeout <= 3600, "invalid_timeout")
        result = run_case(args.run_case, args.entry, args.variant, args.model_id, args.timeout)
        result["mode"] = "explicit_isolated_model_run"
    else:
        require(args.directory is not None, "offline_evidence_directory_required")
        result = analyse_directory(args.directory, args.manifest)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Do not print repr/tracebacks: evidence and HTTP errors can contain secrets.
        code = exc.args[0] if isinstance(exc, EvaluationError) else "evaluation_failed"
        with contextlib.suppress(Exception):
            from accept_life_services import AcceptanceFailure

            if isinstance(exc, AcceptanceFailure):
                code = exc.code
        print(json.dumps({"status": "failed", "code": code}))
        sys.exit(1)
