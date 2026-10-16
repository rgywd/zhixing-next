#!/usr/bin/env python3
"""Explicit real-model acceptance in a NEW, private, fictional-only instance.

Embedding API (the private bootstrap supplies model settings; never print them):
  await run_acceptance(settings, evidence_dir)

The directory must already have mode 0700 and a regular ISOLATED_ACCEPTANCE file
containing zhixing-next-fictional-acceptance-v1. settings.data_dir must be its
nonexistent state child; workspace_root must be its nonexistent workspaces child;
config_file must be None. No production database or credential discovery occurs.

Default CLI only prints help. Explicit CLI: --run --evidence-dir /private/path.
If ZHIXING_CONFIG is used it must point INSIDE that directory, and configure the
same isolated paths and models via environment references. A successful real run
finishes review_pending (CLI exit 3): programmatic checks alone cannot establish
semantic success. Bind a separate independent review to source/model/evidence
hashes; no second cloud run is needed just to read that evidence. Mocked tests
do not count as real-model acceptance.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import sqlite3
import stat
import sys
import tempfile
import traceback
from datetime import datetime, timedelta
from pathlib import Path
from uuid import uuid4, uuid5
from zoneinfo import ZoneInfo

MARKER = "zhixing-next-fictional-acceptance-v1"
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
BUSINESS_SCENARIOS = {
    "health_weight": {
        "expected_first_tools": ["query_health_context", "record_weight"],
        "expected_success_tools": ["record_weight"],
    },
    "health_profile_patch": {
        "expected_first_tools": ["query_health_context", "save_health_profile"],
        "expected_success_tools": ["save_health_profile"],
    },
    "linked_meal": {
        "expected_first_tools": ["query_life_events", "query_health_context", "get_finance_summary",
                                 "list_finance_transactions", "record_life_meal"],
        "expected_success_tools": ["record_life_meal"],
    },
    "linked_meal_correction": {
        "expected_first_tools": ["query_life_events", "query_health_context", "get_finance_summary",
                                 "list_finance_transactions", "correct_life_meal"],
        "expected_success_tools": ["correct_life_meal"],
    },
}


class AcceptanceError(Exception):
    """Fixed public code only; never attach model/configuration/HTTP content."""


def require(condition, code):
    if not condition:
        raise AcceptanceError(code)


def completed_morning_date(now):
    """Keep the explicit 08:00 measurement in the past, including midnight runs."""
    local = now.astimezone(ZoneInfo("Asia/Shanghai"))
    return (local if local.hour >= 8 else local - timedelta(days=1)).date().isoformat()


def linked_meal_old_rice_fact_in_description(description):
    """Finite saved-field check for this fixture, not a natural-reply grader."""
    compact = "".join(description.split())
    return any(fact in compact for fact in (
        "米饭剩了一半", "米饭剩一半", "米饭剩半", "米饭吃了一半", "米饭吃一半",
        "米饭半份", "米饭半碗", "米饭剩1/2", "米饭剩了1/2",
    ))


def validate_directory(evidence_dir):
    supplied = Path(evidence_dir)
    require(supplied.is_absolute() and supplied.is_dir() and not supplied.is_symlink(),
            "private_evidence_directory_required")
    directory = supplied.resolve()
    info = directory.stat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
            "evidence_directory_must_be_owned_mode_0700")
    marker = directory / "ISOLATED_ACCEPTANCE"
    require(marker.is_file() and not marker.is_symlink() and marker.stat().st_size < 200,
            "isolation_marker_required")
    require(marker.read_text(encoding="utf-8").strip() == MARKER, "isolation_marker_mismatch")
    return directory


def validate_settings(settings, evidence_dir):
    directory = validate_directory(evidence_dir)
    require(settings.config_file is None, "runtime_config_file_must_be_none")
    require(settings.data_dir == directory / "state", "isolated_state_path_required")
    require(settings.workspace_root == directory / "workspaces", "isolated_workspace_path_required")
    require(not settings.data_dir.exists() and not settings.data_dir.is_symlink(),
            "new_state_directory_required")
    require(not settings.workspace_root.exists() and not settings.workspace_root.is_symlink(),
            "new_workspace_directory_required")
    require(not settings.grants and not settings.execution.enabled and not settings.gitlab.projects,
            "external_capabilities_must_be_disabled")
    require(len(settings.api_token) >= 24, "isolated_api_token_required")
    require(settings.roles.get("chat") in settings.models, "chat_model_required")
    return directory


def private_write(directory, filename, value, token):
    require(Path(filename).name == filename, "unsafe_evidence_filename")
    target = directory / filename
    require(not target.is_symlink(), "unsafe_evidence_path")

    def redact(item):
        if isinstance(item, dict):
            return {key: "[redacted]" if re.search(r"api.?key|token|password|secret|authorization|cookie", key, re.I)
                    else redact(value) for key, value in item.items()}
        if isinstance(item, list):
            return [redact(value) for value in item]
        if isinstance(item, str):
            item = item.replace(token, "[redacted]") if token else item
            item = re.sub(r"(?i)Bearer\s+\S+", "Bearer [redacted]", item)
            return re.sub(r"\b(?:sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,})", "[redacted]", item)
        return item

    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as file:
        temporary = Path(file.name)
        os.chmod(temporary, 0o600)
        json.dump(redact(value), file, ensure_ascii=False, indent=2)
        file.write("\n")
    temporary.replace(target)


def observed_wait_results(receipts):
    observed = set()
    for receipt in receipts:
        with contextlib.suppress(KeyError, TypeError, ValueError):
            content = json.loads(receipt["value"]["data"]["content"])
            observed.update((agent["id"], agent["result_version"]) for agent in content["agents"]
                            if agent["status"] == "completed" and agent.get("result"))
    return observed


def parallel_peak(timeline):
    active, peak = set(), 0
    for event in timeline:
        if event["status"] == "running":
            active.add(event["child_id"])
        elif event["status"] in {"queued", "completed", "failed", "closed", "interrupted"}:
            active.discard(event["child_id"])
        peak = max(peak, len(active))
    return peak


def successful_read_paths(child):
    from langchain_core.messages import AIMessage, ToolMessage

    from zhixing_next.agent_collaboration import _decode_history

    # The product owns native/provider-aware history serialization. Reusing its
    # decoder supports both older list receipts and typed msgpack state.
    history = _decode_history(child["history_json"])
    successful = {message.tool_call_id for message in history
                  if isinstance(message, ToolMessage) and message.status != "error"}
    return {call["args"]["path"] for message in history if isinstance(message, AIMessage)
            for call in message.tool_calls
            if call.get("id") in successful and call.get("name") in {"read_text_file", "read_document"}
            and isinstance(call.get("args", {}).get("path"), str)}


def child_results_collected(children, observed):
    # Closing a child after collecting its completed result is normal cleanup.
    # A closed status alone is insufficient: require the exact observed version.
    return len(children) >= 2 and all(
        row["status"] in {"completed", "closed"} and row["result"]
        and (row["id"], row["result_version"]) in observed for row in children)


def orchestration_usability(evidence, expected_first):
    path = Path(__file__).with_name("tool_usability_eval.py")
    spec = importlib.util.spec_from_file_location("_collaboration_tool_usability", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    attempts, coverage = module.tool_attempts(evidence)
    orchestration = {"task", "start_agent", "send_agent", "wait_agents", "close_agent",
                     "send_conversation_message", "read_conversation_reply", "wait_conversation_replies"}
    choices = [item["tool"] for item in attempts if not item.get("child_id") and item["tool"] in orchestration]
    return {"trace_coverage": coverage, "total_tool_calls": len(attempts),
            "failed_tool_calls": sum(item["status"] == "failed" for item in attempts),
            "root_failed_calls": sum(item["status"] == "failed" and not item.get("child_id") for item in attempts),
            "child_failed_calls": sum(item["status"] == "failed" and bool(item.get("child_id")) for item in attempts),
            "first_orchestration_tool": choices[0] if choices else None,
            "first_orchestration_choice_correct": bool(choices) and choices[0] == expected_first if coverage == "events" else None}


def unprovided_liability_claim(text):
    """Catch unsupported additions in these fictional fixtures, not general NLI."""
    for clause in re.split(r"[，,。；;\n]", text):
        if any(phrase in clause for phrase in ("不能推断", "不代表", "不等于", "没有说明", "未说明", "未提供", "未知", "无法判断")):
            continue
        # "未声明免责" explicitly withholds an allocation. Keep the positive
        # exemption/assignment checks; do not turn a negated mention into a claim.
        clause = re.sub(r"(?:未|没有|不)(?:声明|规定|约定|构成|等于|意味着|代表)(?:任何)?[‘“\"']?免责[’”\"']?", "", clause)
        if re.search(r"免责|(?:由|归)(?:乘客|用户|方案方|承运方)[^，,。；;]{0,12}(?:承担|负责|负担)|(?:风险|责任)[^，,。；;]{0,12}不由", clause):
            return True
    return False


def guessed_other_food_portion(text):
    # Only rice has a quantity in the unchanged natural meal fixture. Remove
    # its clause before checking whether quantities were invented for the sides.
    for clause in re.split(r"[，,。；;\n]", text):
        clause = re.sub(r"米饭.*", "", clause)
        if any(word in clause for word in ("未知", "未提供", "未说明", "不详")):
            continue
        if re.search(r"(?:豆腐|青菜).*?(?:[一二三四五六七八九十两\d]+(?:份|碗|克|g)|各一)", clause):
            return True
    return False


class AcceptanceSuite:
    def __init__(self, settings, directory, client, store, worker_task, timeout, tick_gate):
        self.settings, self.directory, self.client, self.store = settings, directory, client, store
        self.worker_task, self.timeout = worker_task, timeout
        self.tick_gate = tick_gate
        self.namespace, self.today = uuid4(), datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
        self.evidence, self.case_results = {}, {}

    def write(self, filename, value):
        private_write(self.directory, filename, value, self.settings.api_token)

    async def request(self, method, path, payload=None, **kwargs):
        response = await self.client.request(method, path, json=payload, **kwargs)
        require(not response.is_error and not response.is_redirect, "isolated_api_request_failed")
        try:
            return response.json()
        except ValueError as exc:
            raise AcceptanceError("isolated_api_returned_invalid_json") from exc

    async def conversation(self, title, agent_id=None):
        body = {"title": title}
        if agent_id:
            body["agent_id"] = agent_id
        return (await self.request("POST", "/v1/conversations", body))["id"]

    async def snapshot(self):
        return {
            "health": await self.request("GET", "/v1/health/summary", params={"date": self.today}),
            "meals": (await self.request("GET", "/v1/health/meals", params={"limit": 100}))["items"],
            "transactions": (await self.request("GET", "/v1/finance/transactions",
                                                params={"month": self.today[:7], "limit": 100}))["items"],
        }

    async def events(self, run_id):
        items, after = [], 0
        for _ in range(100):
            page = await self.request("GET", f"/v1/runs/{run_id}/events", params={"after": after, "limit": 100})
            items.extend(page["items"])
            cursor = page.get("next_cursor")
            if cursor is None:
                return items
            require(int(cursor) > after, "event_cursor_did_not_advance")
            after = int(cursor)
        raise AcceptanceError("event_evidence_limit_exceeded")

    async def submit(self, key, conversation, prompt, *, target_run_id=None):
        message = {"id": str(uuid5(self.namespace, key)), "content": prompt, "kind": "chat"}
        if target_run_id:
            message.update(intent="steer", target_run_id=target_run_id)
        self.write(f"input-{key}.json", {"conversation_id": conversation, "message": message})
        # Skip unrelated memory-model calls for fictional acceptance inputs. The
        # same lock excludes the first worker tick until this flag is persisted.
        async with self.tick_gate:
            reply = await self.request("POST", f"/v1/conversations/{conversation}/messages", message)
            with self.store._connection(write=True) as db:
                db.execute("UPDATE runs SET memory_processed=1 WHERE id=?", (reply["run"]["id"],))
        return message["id"], reply["run"]["id"]

    async def capture(self, key, message_id, run_id, before, entry):
        run = await self.request("GET", f"/v1/runs/{run_id}")
        evidence = {"message_id": message_id, "run": run, "events": await self.events(run_id),
                    "events_complete": True, "before_snapshot": before, "snapshot": await self.snapshot(),
                    "operations": (await self.request("GET", f"/v1/runs/{run_id}/operations"))["items"],
                    "evaluation": {"scenario_id": key, "variant": "natural", "entry": entry,
                                   **BUSINESS_SCENARIOS.get(key, {})}}
        self.evidence[key] = evidence
        self.write(f"turn-{key}.json", evidence)
        return evidence

    async def wait(self, key, message_id, run_id, before, entry, hook=None):
        try:
            async with asyncio.timeout(self.timeout):
                while True:
                    require(not self.worker_task.done(), "worker_stopped_before_completion")
                    run = await self.request("GET", f"/v1/runs/{run_id}")
                    if hook:
                        await hook(run)
                    if run["status"] in TERMINAL:
                        break
                    require(run.get("phase") not in {"approval", "input"}, "unexpected_interactive_input")
                    await asyncio.sleep(0.05)
        except TimeoutError as exc:
            await self.request("POST", f"/v1/runs/{run_id}/cancel")
            await self.capture(key, message_id, run_id, before, entry)
            raise AcceptanceError("case_timeout") from exc
        except Exception:
            # Preserve the actual incomplete run when a hook/assertion fails.
            with contextlib.suppress(Exception):
                await self.capture(key, message_id, run_id, before, entry)
            raise
        evidence = await self.capture(key, message_id, run_id, before, entry)
        require(evidence["run"]["status"] == "completed", "model_run_not_completed")
        require(bool(evidence["run"].get("result")), "model_reply_missing")
        return evidence

    async def turn(self, key, conversation, prompt, entry="main", hook=None):
        before = await self.snapshot()
        message_id, run_id = await self.submit(key, conversation, prompt)
        return await self.wait(key, message_id, run_id, before, entry, hook)

    @staticmethod
    def succeeded(evidence, name):
        return any(item.get("tool") == name and item.get("state") == "succeeded"
                   for item in evidence["operations"]) or any(
            event.get("type") == "tool" and event.get("data", {}).get("tool") == name
            and event["data"].get("status") == "completed" for event in evidence["events"])

    @staticmethod
    def consultation_assertions(result, deliveries, target_events, *, target_id,
                                checkpointed, conversations_unchanged, usability):
        """Pure hard checks shared by live cases and evidence-only reanalysis.

        Checkpoint and conversation-set proofs must come from the same bound
        run's recorded evidence; replay must not invent new API/SQLite receipts.
        Factual fidelity is independently reviewed, never classified here.
        """
        from zhixing_next.agent_collaboration import READ_ONLY_TOOLS

        receipt = deliveries[0] if len(deliveries) == 1 else {}
        target_tools = [event["data"]["tool"] for event in target_events if event.get("type") == "tool"]
        return {
            "first_orchestration_choice_correct": usability["first_orchestration_choice_correct"] is True,
            "no_failed_tool_calls": usability["trace_coverage"] == "events" and usability["failed_tool_calls"] == 0
            and usability["target_failed_tool_calls"] == 0,
            "existing_conversation_found_by_history": AcceptanceSuite.succeeded(result, "search_history"),
            "no_new_conversation_created": conversations_unchanged,
            "target_real_initial_checkpoint": checkpointed,
            "one_delivery_to_existing_target": len(deliveries) == 1 and receipt.get("target_conversation_id") == target_id,
            "actual_readonly_reply": receipt.get("read_only") is True and receipt.get("terminal") is True
            and receipt.get("status") == "completed" and bool(receipt.get("reply_message_id")) and bool(receipt.get("result")),
            "wait_released_worker_slot": any(event.get("type") == "paused" and event.get("data", {}).get("reason") == "agent_wait"
                                              for event in result["events"]),
            "real_wait_tool_receipt": AcceptanceSuite.succeeded(result, "wait_conversation_replies"),
            "readonly_authority_received": any(event.get("type") == "conversation.message_received"
                                                and event.get("data", {}).get("read_only") is True for event in target_events),
            "target_only_read_tools": all(tool in READ_ONLY_TOOLS for tool in target_tools),
            "business_state_unchanged": result["before_snapshot"] == result["snapshot"],
        }

    def checked(self, key, assertions, *, duplicate_write=None):
        evidence = self.evidence[key]
        passed = all(assertions.values())
        evidence["business_verification"] = {"passed": passed, "duplicate_write": duplicate_write,
                                              "success_claim": None, "assertions": assertions}
        self.write(f"turn-{key}.json", evidence)
        self.case_results[key] = {"passed": passed, "checks": assertions}
        if "collaboration_tool_usability" in evidence:
            self.case_results[key]["tool_usability"] = evidence["collaboration_tool_usability"]
        if "semantic_review" in evidence:
            self.case_results[key]["semantic_review"] = evidence["semantic_review"]
        require(passed, f"{key}_business_assertion_failed")

    def unknown_meal_time_preserved(self, meal, message_id):
        with self.store._connection() as db:
            source = db.execute("SELECT created_at FROM messages WHERE id=?", (message_id,)).fetchone()
        if not source or "实际用餐时间未知" not in meal.get("note", ""):
            return False
        # HealthService persists seconds. Compare at that existing precision;
        # the semantic requirement is source recording time, never a guessed clock.
        same_instant = datetime.fromisoformat(meal["occurred_at"].replace("Z", "+00:00")).replace(microsecond=0) == datetime.fromisoformat(source[0].replace("Z", "+00:00")).replace(microsecond=0)
        return same_instant

    @staticmethod
    def semantic_review(evidence, *, meal=None, additional_reply="", required_claims=()):
        """Hints for independent reading, never proof or automatic rejection.

        Natural-language negatives and paraphrases cannot be judged reliably by
        these fixture-specific expressions. The reviewer must read the entire
        source, reply and saved state, including cases with no heuristic flags.
        """
        text = evidence["run"]["result"] + "\n" + additional_reply
        evidence["semantic_review"] = {
            "status": "required", "review_all_replies_even_without_flags": True,
            "required_claims": list(required_claims),
            "full_reply_sha256": hashlib.sha256(evidence["run"]["result"].encode("utf-8")).hexdigest(),
            "full_additional_reply_sha256": hashlib.sha256(additional_reply.encode("utf-8")).hexdigest(),
            "liability_wording_flag": unprovided_liability_claim(text),
            "reply_contains_clock": bool(re.search(r"(?<!\d)\d{1,2}:\d{2}(?!\d)|\d{1,2}点\d{1,2}分", text)),
            "other_food_quantity_flag": guessed_other_food_portion(
                text + (f"\n{meal['description']}\n{meal['portion']}" if meal else "")),
        }

    async def health(self):
        conversation = await self.conversation("虚构健康协作验收", "health")
        profile = await self.request("GET", "/v1/health/profile")
        baseline = await self.request("PUT", "/v1/health/profile", {
            **profile, "height_cm": 172, "activity_limitations": ["避免跑跳"],
            "food_allergies": ["花生"], "preferences": ["清淡"], "goals": ["规律进食"],
        })
        measurement_date = completed_morning_date(datetime.now(ZoneInfo("Asia/Shanghai")))
        weight = await self.turn("health_weight", conversation,
                                 f"{measurement_date}上午八点实际称重70.9公斤，帮我记录这次测量。", "direct")
        rows = [row for row in weight["snapshot"]["health"]["weights"] if row.get("source_id") == weight["message_id"]]
        self.semantic_review(weight)
        self.checked("health_weight", {
            "one_actual_weight": len(rows) == 1,
            "actual_value_and_unit": len(rows) == 1 and rows[0]["value"] == 70.9 and rows[0]["unit"] == "kg",
            "explicit_measurement_clock_preserved": len(rows) == 1 and datetime.fromisoformat(
                rows[0]["measured_at"].replace("Z", "+00:00")).astimezone(ZoneInfo("Asia/Shanghai")).isoformat().startswith(measurement_date + "T08:00:00"),
            "real_tool_receipt": self.succeeded(weight, "record_weight"),
        }, duplicate_write=len(rows) > 1)
        changed = await self.turn("health_profile_patch", conversation,
                                  "把我的饮食档案中不吃的食物增加香菜，原来的身高、过敏、活动限制和目标都保持。", "direct")
        after = changed["snapshot"]["health"]["profile"]
        self.semantic_review(changed)
        self.checked("health_profile_patch", {
            "new_exclusion_saved": "香菜" in after["food_exclusions"],
            "other_profile_facts_preserved": all(after[key] == baseline[key] for key in (
                "height_cm", "activity_limitations", "food_allergies", "preferences", "goals")),
            "real_tool_receipt": self.succeeded(changed, "save_health_profile"),
        })

    async def linked_meal(self):
        conversation = await self.conversation("虚构联合记餐验收")
        recorded = await self.turn("linked_meal", conversation,
                                  f"今天是{self.today}，今天午饭花了24.60元，实际吃了豆腐、青菜和米饭，米饭剩了一半。请把这同一顿的餐费和实际饮食一起记录。")
        snapshot, source = recorded["snapshot"], recorded["message_id"]
        tx = [row for row in snapshot["transactions"] if row.get("source_id") == source]
        meals = [row for row in snapshot["meals"] if row.get("source_id") == source]
        self.semantic_review(recorded, meal=meals[0] if len(meals) == 1 else None)
        self.checked("linked_meal", {
            "one_payment_and_one_meal": len(tx) == len(meals) == 1,
            "explicit_payment": len(tx) == 1 and tx[0]["amount"] == "24.60",
            "actual_food": len(meals) == 1 and "豆腐" in meals[0]["description"],
            "unknown_clock_preserved": len(meals) == 1 and self.unknown_meal_time_preserved(meals[0], source),
            "atomic_receipt": self.succeeded(recorded, "record_life_meal"),
        }, duplicate_write=len(tx) > 1 or len(meals) > 1)
        corrected = await self.turn("linked_meal_correction", conversation,
                                   "刚才那顿午饭的花费我说错了，实际是22.60元；米饭实际只吃了三分之一，请改原来的同一条，其他内容保留。")
        new_tx = [row for row in corrected["snapshot"]["transactions"] if row["id"] == tx[0]["id"]]
        new_meals = [row for row in corrected["snapshot"]["meals"] if row["id"] == meals[0]["id"]]
        self.semantic_review(corrected, meal=new_meals[0] if len(new_meals) == 1 else None)
        self.checked("linked_meal_correction", {
            "same_original_ids": len(new_tx) == len(new_meals) == 1,
            "corrected_amount": len(new_tx) == 1 and new_tx[0]["amount"] == "22.60",
            "corrected_portion": len(new_meals) == 1 and any(text in new_meals[0]["portion"] for text in ("三分之一", "1/3")),
            "superseded_rice_fact_removed_from_description": len(new_meals) == 1
            and not linked_meal_old_rice_fact_in_description(new_meals[0]["description"]),
            "food_preserved": len(new_meals) == 1 and all(
                food in f"{new_meals[0]['description']} {new_meals[0]['portion']}"
                for food in ("豆腐", "青菜", "米饭")),
            "unknown_clock_unchanged": len(new_meals) == 1 and self.unknown_meal_time_preserved(new_meals[0], source),
            "no_extra_records": len(corrected["snapshot"]["meals"]) == len(snapshot["meals"])
            and len(corrected["snapshot"]["transactions"]) == len(snapshot["transactions"]),
            "atomic_correction_receipt": self.succeeded(corrected, "correct_life_meal"),
        }, duplicate_write=len(corrected["snapshot"]["meals"]) > len(snapshot["meals"])
        or len(corrected["snapshot"]["transactions"]) > len(snapshot["transactions"]))

    def child_rows(self, run_id):
        with self.store._connection() as db:
            return [dict(row) for row in db.execute(
                "SELECT * FROM agent_children WHERE root_run_id=? ORDER BY created_at,id", (run_id,))]

    async def upload(self, conversation, filename, content):
        response = await self.client.put(f"/v1/conversations/{conversation}/files/{uuid4()}",
                                         params={"filename": filename}, content=content.encode("utf-8"),
                                         headers={"Content-Type": "application/octet-stream"})
        require(response.status_code == 200, "synthetic_fixture_upload_failed")
        return response.json()["path"]

    async def research(self):
        from zhixing_next.agent_collaboration import READ_ONLY_TOOLS

        conversation = await self.conversation("虚构并行资料研究")
        supply = await self.upload(conversation, "supply.txt", "虚构供货方案 PINE-17：按订单备货，需要提前两天确认。资料没有说明价格和库存，不能推断。")
        delivery = await self.upload(conversation, "delivery.txt", "虚构配送方案 MAPLE-29：城区隔日配送，需完整地址。资料没有承诺偏远地区配送；不要自行补充承诺。")
        initial_ids, followup = set(), {}

        async def supplement(run):
            rows = self.child_rows(run["id"])
            if len(rows) >= 2 and not followup:
                require(run["status"] == "running", "research_finished_before_followup")
                initial_ids.update(row["id"] for row in rows)
                message_id, _ = await self.submit("research_supplement", conversation,
                    "补充两条刚确认的限制：偏远地区不承诺配送，城区订单需要周二确认。请把它们补给刚才负责配送的那位研究助手，继续用原来的助手，不另外换人；收齐两份最终结果后再汇总。",
                    target_run_id=run["id"])
                followup["message_id"] = message_id

        result = await self.turn("parallel_research", conversation,
            f"请安排两位只读研究助手并行工作：一位独立读取工作目录中的 {supply} 核对供货约束，另一位独立读取 {delivery} 核对配送约束。请分别取回两份独立结论，再汇总两者的方案代号、已知限制与未知项。只读资料，不修改文件或业务记录；两份结果都收齐前不要结束。", hook=supplement)
        rows = self.child_rows(result["run"]["id"])
        with self.store._connection() as db:
            inputs = [dict(row) for row in db.execute(
                "SELECT * FROM agent_child_inputs WHERE child_id IN (SELECT id FROM agent_children WHERE root_run_id=?)", (result["run"]["id"],))]
            timeline = [dict(row) for row in db.execute(
                "SELECT * FROM agent_child_events WHERE root_run_id=? ORDER BY seq", (result["run"]["id"],))]
            wait_receipts = [json.loads(row[0]) for row in db.execute(
                "SELECT result_json FROM operations WHERE run_id=? AND tool='wait_agents' AND state='succeeded' AND result_json IS NOT NULL", (result["run"]["id"],))]
        observed = observed_wait_results(wait_receipts)
        read_paths = {row["id"]: successful_read_paths(row) for row in rows}
        child_tool_events = [event["data"] for event in result["events"] if event.get("type") == "tool"
                             and event.get("data", {}).get("child_id")]
        self.write("research-private-ledger.json", {"children": rows, "inputs": inputs,
                                                   "timeline": timeline, "wait_receipts": wait_receipts})
        text = result["run"]["result"]
        usability = orchestration_usability(result, "start_agent")
        self.semantic_review(result)
        result["collaboration_tool_usability"] = usability
        result["evaluation"]["expected_first_orchestration_tool"] = "start_agent"
        self.checked("parallel_research", {
            "first_orchestration_choice_correct": usability["first_orchestration_choice_correct"] is True,
            "no_failed_tool_calls": usability["trace_coverage"] == "events" and usability["failed_tool_calls"] == 0,
            "at_least_two_children": len(rows) >= 2,
            "actual_parallel_overlap": parallel_peak(timeline) >= 2,
            "independent_fixture_reads": any(
                first != second and any(path.endswith(supply) for path in first_paths)
                and any(path.endswith(delivery) for path in second_paths)
                for first, first_paths in read_paths.items() for second, second_paths in read_paths.items()),
            "all_independent_results_collected": child_results_collected(rows, observed),
            "both_fixture_codes_in_results": all(any(code in (row["result"] or "") for row in rows)
                                                  for code in ("PINE-17", "MAPLE-29")),
            "both_fixture_codes_in_final": all(code in text for code in ("PINE-17", "MAPLE-29")),
            "followup_reused_original_children": bool(followup) and set(row["id"] for row in rows) == initial_ids,
            "followup_actually_applied": any(row["status"] == "applied" and row["child_id"] in initial_ids for row in inputs),
            "supplement_in_child_and_final": all(word in text for word in ("偏远", "周二")) and any(
                all(word in (row["result"] or "") for word in ("偏远", "周二", "配送")) for row in rows),
            "children_only_used_read_tools": bool(child_tool_events) and all(event["tool"] in READ_ONLY_TOOLS for event in child_tool_events),
            "business_state_unchanged": result["before_snapshot"] == result["snapshot"],
        }, duplicate_write=False)

    async def consultation(self):
        target = await self.conversation("虚构接驳路线咨询")
        initial = await self.turn("consultation_target_setup", target,
            "这段对话专门讨论一个虚构接驳方案：码头代号是 HARBOR-42，每周三停航，其他日子的班次未知；不能保证转乘。请概括这些已提供的事实和未知项，暂不做其他操作。")
        with sqlite3.connect(f"file:{self.settings.data_dir / 'checkpoints.sqlite'}?mode=ro", uri=True) as db:
            checkpointed = db.execute("SELECT COUNT(*) FROM checkpoints WHERE thread_id=?", (target,)).fetchone()[0] > 0
        require(checkpointed and initial["run"]["status"] == "completed", "target_real_checkpoint_missing")
        self.semantic_review(initial, required_claims=[{
            "id": "provided_facts_in_reply", "reply": "reply",
            "must_check": "The setup reply faithfully summarizes HARBOR-42's Wednesday suspension, keeps other-day schedules unknown and transfers not guaranteed, and does not invent liability, compensation or other facts. Read the full reply in any language; matching words do not establish factual fidelity.",
        }])
        self.checked("consultation_target_setup", {
            "real_initial_checkpoint": checkpointed,
        })
        source = await self.conversation("虚构跨对话咨询")
        conversations_before = {row["id"] for row in (await self.request("GET", "/v1/conversations", params={"limit": 100}))["items"]}
        result = await self.turn("conversation_consultation", source,
            "请找到我之前那段‘虚构接驳路线咨询’对话，向那个已有对话询问：周三能否从 HARBOR-42 出发，还有哪些已知限制？请等收到那边针对这次问题的实际回复，再向我汇总。只咨询，不修改业务资料，也不要创建一个新对话来代替它。")
        deliveries = (await self.request("GET", f"/v1/runs/{result['run']['id']}/conversation-messages"))["items"]
        targets = []
        for receipt in deliveries:
            target_run = await self.request("GET", f"/v1/runs/{receipt['target_run_id']}")
            target_events = await self.events(receipt["target_run_id"])
            targets.append({"receipt": receipt, "run": target_run, "events": target_events})
        self.write("consultation-private-deliveries.json", targets)
        conversations_after = {row["id"] for row in (await self.request("GET", "/v1/conversations", params={"limit": 100}))["items"]}
        receipt = deliveries[0] if len(deliveries) == 1 else {}
        target_events = targets[0]["events"] if len(targets) == 1 else []
        usability = orchestration_usability(result, "send_conversation_message")
        usability["target_failed_tool_calls"] = sum(orchestration_usability({
            "events": item["events"], "events_complete": True,
        }, "send_conversation_message")["failed_tool_calls"] for item in targets)
        result["collaboration_tool_usability"] = usability
        result["evaluation"]["expected_first_orchestration_tool"] = "send_conversation_message"
        self.semantic_review(result, additional_reply=receipt.get("result", ""), required_claims=[{
            "id": "prior_context_in_real_reply", "reply": "additional_reply",
            "must_check": "The actual target reply uses its prior HARBOR-42 context faithfully: Wednesday departures are suspended, other-day schedules remain unknown and transfers are not guaranteed. Verify the retained prior facts beyond those repeated in the consultation question; do not infer liability, fees or guarantees from uncertainty. Read the full reply in any language.",
        }, {
            "id": "actual_reply_in_source_summary", "reply": "reply",
            "must_check": "The source reply faithfully summarizes the actual target reply, preserving its Wednesday suspension, known limitations and unknowns without reversing, strengthening or inventing claims. Compare both complete replies; shared words alone are not evidence of agreement.",
        }])
        self.checked("conversation_consultation", self.consultation_assertions(
            result, deliveries, target_events, target_id=target, checkpointed=checkpointed,
            conversations_unchanged=conversations_before == conversations_after, usability=usability,
        ), duplicate_write=False)

    async def run(self):
        for name, case in (("health", self.health), ("linked_meal", self.linked_meal),
                           ("parallel_research", self.research), ("conversation_consultation", self.consultation)):
            self.write("progress.json", {"case": name, "status": "running", "completed": list(self.case_results)})
            await case()
        return {"status": "review_pending", "programmatic_checks_passed": True,
                "real_model_run": True, "checks": self.case_results,
                "turns": len(self.evidence), "manual_review_required": True,
                "verification_scope": "programmatic_assertions_only",
                "semantic_review_status": "required", "memory_evaluation": False}


async def drive_worker(worker, stop, tick_gate):
    """Use the real coordinator/runner, excluding memory work before dispatch."""
    from filelock import FileLock

    with FileLock(worker.settings.data_dir / "worker.lock").acquire(timeout=0):
        worker.store.recover_interrupted()
        try:
            while not stop.is_set():
                async with tick_gate:
                    await worker.tick()
                try:
                    await asyncio.wait_for(stop.wait(), worker.settings.poll_interval)
                except TimeoutError:
                    pass
        finally:
            tasks = [task for _, task in worker.active.values()]
            if worker.memory_task is not None:
                tasks.append(worker.memory_task)
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            worker.active.clear()


async def run_acceptance(settings, evidence_dir, *, case_timeout=240):
    """Run real API/worker/graphs. Caller owns provider configuration and billing."""
    import httpx

    from zhixing_next.api import create_app
    from zhixing_next.worker import Worker

    directory = validate_settings(settings, evidence_dir)
    require(1 <= case_timeout <= 3600, "invalid_case_timeout")
    app = create_app(settings)
    stop = asyncio.Event()
    tick_gate = asyncio.Lock()
    worker_task = asyncio.create_task(drive_worker(Worker(settings), stop, tick_gate))
    suite = None
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://isolated.test",
                                    headers={"Authorization": f"Bearer {settings.api_token}"},
                                    timeout=30, follow_redirects=False, trust_env=False) as client:
            suite = AcceptanceSuite(settings, directory, client, app.state.store, worker_task,
                                    case_timeout, tick_gate)
            try:
                summary = await suite.run()
            except Exception as exc:
                suite.write("error.json", {"exception_type": type(exc).__name__, "frames": [
                    {"file": Path(frame.filename).name, "function": frame.name, "line": frame.lineno}
                    for frame in traceback.extract_tb(exc.__traceback__)
                ]})
                summary = {"status": "failed", "real_model_run": True,
                           "code": exc.args[0] if isinstance(exc, AcceptanceError) else type(exc).__name__,
                           "checks": suite.case_results, "turns": len(suite.evidence),
                           "manual_review_required": True, "memory_evaluation": False}
            suite.write("summary.json", summary)
            return summary
    finally:
        stop.set()
        try:
            await asyncio.wait_for(worker_task, timeout=30)
        except (TimeoutError, asyncio.CancelledError):
            worker_task.cancel()
            await asyncio.gather(worker_task, return_exceptions=True)
        except Exception:
            if suite:
                suite.write("worker-shutdown.json", {"status": "failed"})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", action="store_true", help="Explicitly enable real model calls")
    parser.add_argument("--evidence-dir")
    parser.add_argument("--case-timeout", type=int, default=240)
    args = parser.parse_args(argv)
    if not args.run:
        parser.print_help()
        return 0
    require(args.evidence_dir is not None, "private_evidence_directory_required")
    directory = validate_directory(args.evidence_dir)
    supplied_config = os.environ.get("ZHIXING_CONFIG")
    if supplied_config:
        path = Path(supplied_config)
        require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(directory),
                "cli_config_must_be_inside_evidence_directory")
    from zhixing_next.config import load_settings

    settings = load_settings().model_copy(update={"config_file": None})
    summary = asyncio.run(run_acceptance(settings, directory, case_timeout=args.case_timeout))
    print(json.dumps(summary, ensure_ascii=False))
    # Exit 3 means the run is complete but cannot be accepted without a separate
    # independent review bound to these unchanged inputs, outputs and snapshots.
    return 0 if summary["status"] == "passed" else 3 if summary["status"] == "review_pending" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        code = exc.args[0] if isinstance(exc, AcceptanceError) else "acceptance_failed"
        print(json.dumps({"status": "failed", "code": code}))
        sys.exit(1)
