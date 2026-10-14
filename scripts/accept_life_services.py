#!/usr/bin/env python3
"""Real-model acceptance against an EMPTY, isolated local backend only.

Required environment (never pass a token as a CLI argument):
  ZHIXING_ACCEPT_BASE=http://127.0.0.1:<isolated-port>
  ZHIXING_API_TOKEN=<isolated instance access token>
  ZHIXING_ACCEPT_ISOLATED=fictional-only
  ZHIXING_ACCEPT_DIR=<absolute private acceptance directory>
The directory must contain a regular ISOLATED_ACCEPTANCE file containing exactly
"zhixing-next-fictional-acceptance-v1" and belong to the current OS user.

From backend's uv environment:
  uv run python ../scripts/accept_life_services.py --stage all
  uv run python ../scripts/accept_life_services.py --stage setup
  uv run python ../scripts/accept_life_services.py --stage dual_record

Stages are ordered; individual stages require preceding stages to have passed.
Completed stages are not repeated. In-flight submissions reuse their saved UUID
and exact prompt. Failed model runs are never silently re-enqueued with a new
source ID, because that could duplicate a partial write. Inspect private evidence
and fix/resume the isolated run instead. This does not test native notifications,
photo understanding, a physical device, production deployment or clinical safety.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID, uuid4, uuid5
from zoneinfo import ZoneInfo

import httpx

MARKER = "zhixing-next-fictional-acceptance-v1"
STAGES = ("setup", "dual_record", "recommendation", "replacement", "adoption", "correction", "rule_change", "review")
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
SENSITIVE_KEYS = re.compile(r"api.?key|token|password|secret|authorization|cookie", re.I)


class AcceptanceFailure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise AcceptanceFailure(code)


def redact(value, token):
    if isinstance(value, dict):
        return {key: "[redacted]" if SENSITIVE_KEYS.search(key) else redact(item, token)
                for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item, token) for item in value]
    if isinstance(value, str):
        value = value.replace(token, "[redacted]") if token else value
        value = re.sub(r"(?i)Bearer\s+\S+", "Bearer [redacted]", value)
        return re.sub(r"\b(?:sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,})", "[redacted]", value)
    return value


def private_write(directory, name, value, token):
    target = directory / name
    require(not target.is_symlink(), "unsafe_evidence_path")
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as file:
        temporary = Path(file.name)
        os.chmod(temporary, 0o600)
        json.dump(redact(value, token), file, ensure_ascii=False, indent=2)
        file.write("\n")
    temporary.replace(target)


def isolation():
    require(os.environ.get("ZHIXING_ACCEPT_ISOLATED") == "fictional-only", "isolation_flag_required")
    base = os.environ.get("ZHIXING_ACCEPT_BASE", "").rstrip("/")
    parsed = urlsplit(base)
    require(parsed.scheme in {"http", "https"} and parsed.hostname == "127.0.0.1"
            and parsed.username is None and parsed.password is None
            and not parsed.path and not parsed.query and not parsed.fragment,
            "isolated_loopback_endpoint_required")
    token = os.environ.get("ZHIXING_API_TOKEN", "")
    require(bool(token), "isolated_api_token_required")
    supplied = os.environ.get("ZHIXING_ACCEPT_DIR", "")
    directory = Path(supplied)
    require(bool(supplied) and directory.is_absolute() and directory.is_dir()
            and not directory.is_symlink(), "private_acceptance_directory_required")
    directory = directory.resolve()
    info = directory.stat()
    require(info.st_uid == os.getuid(), "acceptance_directory_owner_mismatch")
    os.chmod(directory, 0o700)
    marker = directory / "ISOLATED_ACCEPTANCE"
    require(marker.is_file() and not marker.is_symlink() and marker.stat().st_size < 200,
            "isolation_marker_required")
    require(marker.read_text(encoding="utf-8").strip() == MARKER, "isolation_marker_mismatch")
    return base, token, directory


class Acceptance:
    def __init__(self, client, directory, token, timeout):
        self.client, self.directory, self.token, self.timeout = client, directory, token, timeout
        state_path = directory / "state.json"
        require(not state_path.is_symlink(), "unsafe_state_path")
        if state_path.exists():
            self.state = json.loads(state_path.read_text(encoding="utf-8"))
            require(self.state.get("schema") == 1 and self.state.get("marker") == MARKER,
                    "acceptance_state_mismatch")
            require(self.state.get("base") == str(client.base_url).rstrip("/"), "instance_endpoint_changed")
        else:
            self.assert_empty_instance()
            namespace = str(uuid4())
            self.state = {"schema": 1, "marker": MARKER, "namespace": namespace,
                          "base": str(client.base_url).rstrip("/"),
                          "today": datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat(),
                          "server_name": f"隔离验收-{namespace}", "messages": {},
                          "completed": [], "results": {}}
            self.save()

    def request(self, method, path, payload=None, params=None):
        try:
            response = self.client.request(method, path, json=payload, params=params)
        except httpx.HTTPError as exc:
            raise AcceptanceFailure("backend_connection_failed") from exc
        if response.is_error or response.is_redirect:
            code = "http_request_failed"
            with contextlib.suppress(ValueError, AttributeError):
                remote = response.json().get("error", {}).get("code")
                if remote and re.fullmatch(r"[a-z_]{1,80}", remote):
                    code = remote
            raise AcceptanceFailure(code)
        try:
            return response.json()
        except ValueError as exc:
            raise AcceptanceFailure("backend_returned_invalid_json") from exc

    def save(self):
        private_write(self.directory, "state.json", self.state, self.token)

    def assert_empty_instance(self):
        # This deliberately refuses a clone that still contains personal data.
        for path in ("/v1/conversations", "/v1/memories", "/v1/resources", "/v1/projects"):
            require(not self.request("GET", path, params={"limit": 1}).get("items"),
                    "instance_contains_existing_user_data")
        health = self.request("GET", "/v1/health/summary")
        require(not any(health.get(key) for key in ("all_rules", "recent_meals", "weights", "steps", "recommendations")),
                "instance_contains_existing_health_data")
        for kind in ("meals", "weights", "steps", "rules", "recommendations"):
            require(not self.request("GET", f"/v1/health/{kind}", params={"limit": 1})["items"],
                    "instance_contains_existing_health_history")
        profile = health["profile"]
        require(profile.get("height_cm") is None and not any(profile.get(key) for key in (
            "activity_limitations", "food_allergies", "food_exclusions", "preferences", "goals", "note")),
                "instance_contains_existing_health_profile")
        require(not self.request("GET", "/v1/finance/transactions").get("items"),
                "instance_contains_existing_finance_data")
        budget = self.request("GET", "/v1/finance/budget")
        require(budget.get("revision", 0) == 0, "instance_contains_existing_finance_budget")
        observations = self.request("GET", "/v1/finance/observations")
        require(not any(value for value in observations.values() if isinstance(value, (list, dict))),
                "instance_contains_existing_finance_observations")

    def server_guard(self, allow_unmarked=False):
        assistant = self.request("GET", "/v1/assistant")
        if assistant["name"] == self.state["server_name"]:
            return
        require(allow_unmarked and not self.state["completed"], "server_acceptance_marker_mismatch")
        self.assert_empty_instance()
        self.request("PUT", "/v1/assistant", {"name": self.state["server_name"],
                     "persona": "这是隔离的虚构产品验收实例。正常调用真实模型与服务工具，所有测试事实均为虚构；不接触生产个人数据。"})

    def snapshots(self):
        today = self.state["today"]
        yesterday = (datetime.fromisoformat(today) - timedelta(days=1)).date().isoformat()
        transactions = {}
        for month in {today[:7], yesterday[:7]}:
            page = self.request("GET", "/v1/finance/transactions", params={"month": month, "limit": 100})
            require(page.get("total", len(page["items"])) <= 100, "unexpected_finance_record_count")
            transactions.update({item["id"]: item for item in page["items"]})
        return {"health": self.request("GET", "/v1/health/summary", params={"date": today}),
                "meals": self.request("GET", "/v1/health/meals", params={"limit": 500})["items"],
                "transactions": list(transactions.values())}

    def chat(self, key, prompt):
        require(datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat() == self.state["today"],
                "acceptance_session_date_has_passed")
        message = self.state["messages"].get(key)
        if not message:
            message = {"id": str(uuid5(UUID(self.state["namespace"]), key)), "content": prompt, "kind": "chat"}
            self.state["messages"][key] = message
            self.save()  # Persist identity and exact text BEFORE network mutation.
        receipt = self.request("POST", f"/v1/conversations/{self.state['conversation_id']}/messages", message)
        run_id = receipt["run"]["id"]
        deadline = time.monotonic() + self.timeout
        while True:
            run = self.request("GET", f"/v1/runs/{run_id}")
            if run["status"] in TERMINAL:
                break
            require(run.get("phase") not in {"input", "approval"}, "model_requested_interactive_input")
            require(time.monotonic() < deadline, "model_run_timeout")
            time.sleep(2)
        operations = self.request("GET", f"/v1/runs/{run_id}/operations")["items"]
        evidence = {"message_id": message["id"], "run": run, "operations": operations,
                    "snapshot": self.snapshots()}
        private_write(self.directory, f"turn-{key}.json", evidence, self.token)
        require(run["status"] == "completed", f"model_run_{run['status']}")
        require(bool(run.get("result")), "model_response_missing")
        return evidence

    @staticmethod
    def succeeded(evidence, tool_name):
        return any(item.get("tool") == tool_name and item.get("state") == "succeeded"
                   for item in evidence["operations"])

    @staticmethod
    def from_source(items, evidence):
        return [item for item in items if item.get("source_id") == evidence["message_id"]]

    def setup(self):
        self.server_guard(allow_unmarked=True)
        namespace, today = self.state["namespace"], self.state["today"]
        profile = self.request("GET", "/v1/health/profile")
        self.request("PUT", "/v1/health/profile", {**profile, "height_cm": 172,
                     "activity_limitations": ["避免跑跳"], "food_allergies": ["花生"],
                     "preferences": ["清淡口味", "没有厨房，优先方便购买的餐食"],
                     "goals": ["通过可持续的饮食安排管理体重"], "note": "隔离验收虚构资料"})
        for identifier, content, kind, terms in (
            ("no-peanut", "不能吃花生", "restriction", ["花生", "peanut"]),
            ("balanced-dinner", "晚餐搭配蔬菜、蛋白质与合适份量的主食，尊重饥饱感", "guideline", []),
        ):
            self.request("POST", "/v1/health/rules", {"id": f"accept:{namespace}:{identifier}",
                         "content": content, "kind": kind, "excluded_terms": terms, "origin": "user"})
        yesterday = (datetime.fromisoformat(today) - timedelta(days=1)).date().isoformat()
        for suffix, day, value in (("previous", yesterday, 71.2), ("current", today, 70.9)):
            self.request("POST", "/v1/health/weights", {"id": f"accept:{namespace}:weight:{suffix}",
                         "measured_at": f"{day}T08:00:00+08:00", "value": value, "unit": "kg",
                         "note": "隔离验收虚构测量，不能当作减重效果"})
        self.request("PUT", "/v1/finance/budget", {"month": today[:7], "idempotency_key": f"accept:{namespace}:budget",
                     "recurring": True, "expected_income": "9800", "savings_target": "5200", "daily_budget": "1800",
                     "commitments": [{"key": "fictional-rent", "label": "虚构固定安排", "kind": "fixed", "amount": "1900"}]})
        conversations = self.request("GET", "/v1/conversations", params={"limit": 100})["items"]
        title = f"隔离闭环验收-{namespace}"
        require(all(item["title"] == title for item in conversations), "unexpected_conversation_in_isolated_instance")
        require(len(conversations) <= 1, "duplicate_acceptance_conversations")
        conversation = conversations[0] if conversations else self.request("POST", "/v1/conversations", {"title": title})
        self.state["conversation_id"] = conversation["id"]
        self.save()
        return {"conversation_id": conversation["id"], "seeded_rules": 2, "seeded_weights": 2}

    def dual_record(self):
        today = self.state["today"]
        evidence = self.chat("dual-record", f"今天是{today}。我今天午饭实际花了24.60元，吃的是豆腐、青菜和米饭，米饭剩了一半。请把明确餐费和实际饮食一起记录，这是同一顿唯一的一笔午饭；不要把计划当已吃，也不需要给建议。")
        tx = self.from_source(evidence["snapshot"]["transactions"], evidence)
        meals = self.from_source(evidence["snapshot"]["meals"], evidence)
        require(len(tx) == len(meals) == 1, "dual_record_missing_or_duplicated")
        require(Decimal(tx[0]["amount"]) == Decimal("24.60") and tx[0]["kind"] == "expense", "meal_payment_incorrect")
        require(meals[0]["status"] == "recorded" and "豆腐" in meals[0]["description"], "actual_food_incorrect")
        require(self.succeeded(evidence, "record_life_meal"), "atomic_meal_tool_receipt_missing")
        replay = self.request("POST", f"/v1/conversations/{self.state['conversation_id']}/messages",
                              self.state["messages"]["dual-record"])
        require(replay["run"]["id"] == evidence["run"]["id"], "message_replay_created_new_run")
        after_replay = self.snapshots()
        require(len(after_replay["meals"]) == len(after_replay["transactions"]) == 1,
                "message_replay_duplicated_records")
        self.state.update(lunch_finance_id=tx[0]["id"], lunch_meal_id=meals[0]["id"])
        return {"run_id": evidence["run"]["id"], "finance_id": tx[0]["id"], "meal_id": meals[0]["id"], "atomic_receipt": True, "message_replay_idempotent": True}

    def recommendation(self):
        evidence = self.chat("recommendation", "请让健康助手读取当前有效饮食约定、过敏限制、近期实际饮食和餐费摘要，给我今晚两项可以照着吃的选择并保存到健康服务。每项说明食物组合、份量、替换和依据。我没有厨房，不要编造附近商家或实时价格。")
        recs = self.from_source(evidence["snapshot"]["health"]["recommendations"], evidence)
        require(len(recs) == 1 and len(recs[0]["options"]) == 2, "saved_recommendation_missing")
        rec = recs[0]
        require(rec["status"] == "current" and rec["basis"]["rule_revisions"], "recommendation_basis_missing_or_stale")
        require("花生" in rec["basis"]["food_restrictions"], "known_allergy_not_in_basis")
        require(self.succeeded(evidence, "save_meal_recommendation"), "recommendation_tool_receipt_missing")
        self.state["first_recommendation_id"] = rec["id"]
        return {"run_id": evidence["run"]["id"], "recommendation_id": rec["id"], "options": len(rec["options"])}

    def replacement(self):
        evidence = self.chat("replacement", "刚才那份晚餐建议需要换一下：今天只能点外卖，买不到建议里的成品搭配。请保存这次替换和困难，再读取更新后的上下文给两个适合外卖点单的候选并保存。仍遵守我的禁忌；只记录选择困难，不要记成已经吃过。")
        health = evidence["snapshot"]["health"]
        original = next(item for item in health["recommendations"] if item["id"] == self.state["first_recommendation_id"])
        require(original["latest_feedback"] and original["latest_feedback"]["action"] == "replaced", "replacement_feedback_not_saved")
        require("外卖" in original["latest_feedback"]["note"], "replacement_difficulty_missing")
        new = self.from_source(health["recommendations"], evidence)
        require(len(new) == 1 and new[0]["status"] == "current", "replacement_recommendation_missing_or_stale")
        require(len(evidence["snapshot"]["meals"]) == 1, "recommendation_became_intake")
        self.state["chosen_recommendation_id"] = new[0]["id"]
        self.state["chosen_option"] = new[0]["options"][0]
        return {"run_id": evidence["run"]["id"], "replacement_recommendation_id": new[0]["id"], "difficulty_saved": True}

    def adoption(self):
        choice = self.chat("adoption-choice", "最新保存的两项晚饭推荐，我选第一项。请先只保存我的采纳；我还没有吃，不要创建实际饮食或支出。")
        rec = next(item for item in choice["snapshot"]["health"]["recommendations"] if item["id"] == self.state["chosen_recommendation_id"])
        require(rec["latest_feedback"] and rec["latest_feedback"]["action"] == "accepted"
                and rec["latest_feedback"]["option_id"] == self.state["chosen_option"]["id"], "adoption_not_saved")
        require(len(choice["snapshot"]["meals"]) == len(choice["snapshot"]["transactions"]) == 1, "adoption_became_actual_record")
        title = self.state["chosen_option"]["title"]
        actual = self.chat("adoption-actual", f"现在晚饭实际吃完了：我吃了刚才选的「{title}」，主食实际只吃了半份，蔬菜吃完了，外卖花费27.80元。请记录明确餐费和实际饮食，关联刚才采纳的推荐。不要再次记采纳，也不要把推荐份量当实际份量。")
        meals = self.from_source(actual["snapshot"]["meals"], actual)
        tx = self.from_source(actual["snapshot"]["transactions"], actual)
        require(len(meals) == len(tx) == 1, "actual_dinner_missing_or_duplicated")
        require(meals[0]["recommendation_id"] == self.state["chosen_recommendation_id"], "actual_dinner_not_linked_to_choice")
        require("半" in meals[0]["portion"], "actual_portion_not_recorded")
        require(Decimal(tx[0]["amount"]) == Decimal("27.80"), "dinner_payment_incorrect")
        self.state.update(dinner_meal_id=meals[0]["id"], dinner_finance_id=tx[0]["id"])
        return {"choice_run_id": choice["run"]["id"], "actual_run_id": actual["run"]["id"], "meal_id": meals[0]["id"], "finance_id": tx[0]["id"], "adoption_is_not_intake": True}

    def correction(self):
        yesterday = (datetime.fromisoformat(self.state["today"]) - timedelta(days=1)).date().isoformat()
        evidence = self.chat("correction", f"纠正刚才最早那顿豆腐青菜午饭：实际发生在昨天{yesterday}，花费是26.40元，米饭实际吃了半份。请在原来的同一顿上同时改餐费、日期和饮食份量，不要新增记录；今晚外卖那顿不变。")
        snapshot = evidence["snapshot"]
        require(len(snapshot["meals"]) == len(snapshot["transactions"]) == 2, "correction_added_or_removed_records")
        lunch = next(item for item in snapshot["meals"] if item["id"] == self.state["lunch_meal_id"])
        tx = next(item for item in snapshot["transactions"] if item["id"] == self.state["lunch_finance_id"])
        require(lunch["occurred_at"][:10] == tx["occurred_on"] == yesterday, "linked_dates_not_corrected")
        require(Decimal(tx["amount"]) == Decimal("26.40") and lunch["revision"] > 1, "correction_not_persisted")
        require(self.succeeded(evidence, "correct_life_meal"), "atomic_correction_receipt_missing")
        return {"run_id": evidence["run"]["id"], "same_finance_id": tx["id"], "same_meal_id": lunch["id"], "counts": {"meals": 2, "transactions": 2}}

    def rule_change(self):
        before = self.snapshots()["health"]["revision"]
        evidence = self.chat("rule-change", "从现在起再加一条明确饮食禁忌：我不吃香菜。其他规范继续沿用。请保存这条要求，并确认旧的晚饭建议需要按新约定刷新。这一步只改约定，不要新增饮食或推荐。")
        health = evidence["snapshot"]["health"]
        require(health["revision"] > before, "agreement_revision_did_not_change")
        known = "香菜" in health["profile"]["food_exclusions"] or any(
            item["kind"] == "restriction" and "香菜" in item["excluded_terms"] for item in health["rules"])
        require(known, "new_explicit_food_exclusion_not_saved")
        require(all(item["status"] == "stale" for item in health["recommendations"]), "old_recommendation_remained_current")
        return {"run_id": evidence["run"]["id"], "new_context_revision": health["revision"], "old_recommendations_stale": True}

    def review(self):
        evidence = self.chat("review", "请做一次简短回顾：读取实际饮食、体重记录，以及上次只能点外卖而替换建议的困难，引用纠正后的真实记录，给下一餐一项能执行的调整。没有记录的餐次只表示未知，不能当成没吃。不要推荐在家做饭，不新增实际饮食、支出或规范。")
        snapshot = evidence["snapshot"]
        require(len(snapshot["meals"]) == len(snapshot["transactions"]) == 2, "review_mutated_actual_records")
        choices = snapshot["health"]["review"]["recent_choices"]
        require(any(item["latest_feedback"]["action"] == "replaced" and "外卖" in item["latest_feedback"]["note"] for item in choices), "review_lost_replacement_difficulty")
        require(any(item["id"] == self.state["chosen_recommendation_id"] and any(
            meal["id"] == self.state["dinner_meal_id"] for meal in item["actual_meals"]) for item in choices), "review_lost_choice_actual_link")
        require("外卖" in evidence["run"]["result"], "review_text_did_not_reference_difficulty")
        require(self.succeeded(evidence, "query_health_context"), "review_did_not_read_current_health_context")
        require(snapshot["health"]["review"]["unknown_is_not_nonadherence"], "missing_records_treated_as_nonadherence")
        return {"run_id": evidence["run"]["id"], "linked_choices": len(choices), "weight_measurements": len(snapshot["health"]["weights"]),
                "manual_review_required": ["建议份量和替换是否可执行", "是否遵守禁忌和活动限制", "是否引用纠正后的真实记录和外卖困难", "是否避免编造商家价格和漏记指责"]}

    def run(self, stage):
        requested = STAGES if stage == "all" else (stage,)
        if "setup" in self.state["completed"]:
            self.server_guard()
        for name in requested:
            index = STAGES.index(name)
            require(all(previous in self.state["completed"] for previous in STAGES[:index]), "prior_acceptance_stage_required")
            if name in self.state["completed"]:
                continue
            if name != "setup":
                self.server_guard()
            try:
                result = getattr(self, name)()
            except AcceptanceFailure as exc:
                private_write(self.directory, f"failure-{name}.json", {"code": exc.code, "stage": name}, self.token)
                raise
            self.state["results"][name] = result
            self.state["completed"].append(name)
            self.save()
        snapshot = self.snapshots()
        return {"status": "automated_pass_manual_review_required" if "review" in self.state["completed"] else "stage_passed",
                "completed_stages": self.state["completed"], "conversation_id": self.state.get("conversation_id"),
                "counts": {"transactions": len(snapshot["transactions"]), "meals": len(snapshot["meals"]),
                           "weights": len(snapshot["health"]["weights"]), "recommendations": len(snapshot["health"]["recommendations"])},
                "record_ids": {key: self.state[key] for key in ("lunch_finance_id", "lunch_meal_id", "dinner_finance_id", "dinner_meal_id", "first_recommendation_id", "chosen_recommendation_id") if key in self.state},
                "manual_review_required": "review" in self.state["completed"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stage", choices=("all", *STAGES), default="all")
    parser.add_argument("--timeout", type=int, default=600, help="Maximum seconds per real model run")
    args = parser.parse_args()
    require(1 <= args.timeout <= 3600, "invalid_model_timeout")
    base, token, directory = isolation()
    lock_path = directory / ".acceptance.lock"
    require(not lock_path.is_symlink(), "unsafe_acceptance_lock")
    with lock_path.open("a+") as lock:
        os.chmod(lock_path, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise AcceptanceFailure("acceptance_already_running") from exc
        with httpx.Client(base_url=base, headers={"Authorization": f"Bearer {token}"},
                          timeout=30, follow_redirects=False, trust_env=False) as client:
            try:
                result = Acceptance(client, directory, token, args.timeout).run(args.stage)
            except Exception as exc:
                private_write(directory, "last-error.json", {"type": type(exc).__name__, "message": str(exc)}, token)
                raise
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except AcceptanceFailure as error:
        print(json.dumps({"status": "failed", "code": error.code}))
        sys.exit(1)
    except Exception:
        # Never print exception repr: HTTP libraries can retain headers or content.
        print(json.dumps({"status": "failed", "code": "acceptance_script_error"}))
        sys.exit(1)
