"""Durable questions and task acceptance evidence, independent of graph replay."""

import json
from typing import Annotated
from uuid import NAMESPACE_URL, uuid5

from langchain_core.tools import InjectedToolCallId, tool
from langgraph.types import interrupt
from pydantic import BaseModel, Field

from .store import StoreError, _json, timestamp


def input_record(row):
    item = dict(row)
    item["options"] = json.loads(item.pop("options_json"))
    return item


class TaskFlow:
    def __init__(self, store):
        self.store = store

    def questions(self, conversation_id=None, run_id=None):
        with self.store._connection() as db:
            rows = db.execute(
                "SELECT q.* FROM input_requests q JOIN runs r ON r.id=q.run_id WHERE q.state='pending' AND r.status IN ('queued','running') AND r.cancel_requested=0 AND (? IS NULL OR r.conversation_id=?) AND (? IS NULL OR r.id=?) ORDER BY q.created_at LIMIT 50",
                (conversation_id, conversation_id, run_id, run_id),
            ).fetchall()
        return {"items": [input_record(row) for row in rows], "next_cursor": None}

    def ask(self, run_id, call_id, question, options):
        identifier = str(uuid5(NAMESPACE_URL, f"input:{run_id}:{call_id}"))
        with self.store._connection(write=True) as db:
            existing = db.execute(
                "SELECT * FROM input_requests WHERE id=?", (identifier,)
            ).fetchone()
            if not existing:
                run = self.store._require(db, "runs", run_id)
                if run["cancel_requested"] or run["status"] != "running":
                    raise StoreError("input_expired", "任务已停止")
                db.execute(
                    "INSERT INTO input_requests(id,run_id,question,options_json,created_at) VALUES(?,?,?,?,?)",
                    (identifier, run_id, question, _json(options), timestamp()),
                )
                self.store._event(
                    db, run_id, "input_required", {"id": identifier, "question": question}
                )
            row = self.store._require(db, "input_requests", identifier)
            if row["question"] != question or json.loads(row["options_json"]) != options:
                raise StoreError("input_conflict", "恢复时问题发生变化")
        return input_record(row)

    def answer(self, identifier, answer):
        with self.store._connection(write=True) as db:
            row = self.store._require(db, "input_requests", identifier)
            run = self.store._require(db, "runs", row["run_id"])
            if run["cancel_requested"] or run["status"] not in {"queued", "running"}:
                raise StoreError("input_expired", "任务已停止，回答未提交")
            if row["state"] != "pending":
                if row["state"] == "answered" and row["answer"] == answer:
                    return input_record(row)
                raise StoreError("input_conflict", "此问题已有回答或已失效")
            db.execute(
                "UPDATE input_requests SET state='answered',answer=?,answered_at=? WHERE id=?",
                (answer, timestamp(), identifier),
            )
            if not db.execute(
                "SELECT 1 FROM input_requests WHERE run_id=? AND state='pending'", (run["id"],)
            ).fetchone():
                phase = (
                    "approval"
                    if db.execute(
                        "SELECT 1 FROM approvals WHERE run_id=? AND state='pending'", (run["id"],)
                    ).fetchone()
                    else "recovering"
                )
                db.execute(
                    "UPDATE runs SET phase=? WHERE id=? AND status='queued'", (phase, run["id"])
                )
            self.store._event(db, run["id"], "input_answered", {"id": identifier})
            return input_record(self.store._require(db, "input_requests", identifier))

    def steps(self, run_id):
        with self.store._connection() as db:
            rows = db.execute(
                "SELECT * FROM task_steps WHERE run_id=? ORDER BY rowid", (run_id,)
            ).fetchall()
        return [
            {
                **{key: row[key] for key in row.keys() if key != "evidence_json"},
                "evidence": json.loads(row["evidence_json"] or "null"),
            }
            for row in rows
        ]

    def plan(self, run_id, steps):
        with self.store._connection(write=True) as db:
            for step in steps:
                existing = db.execute(
                    "SELECT * FROM task_steps WHERE run_id=? AND id=?", (run_id, step.id)
                ).fetchone()
                if existing and existing["description"] != step.description:
                    raise ValueError(
                        "Existing completion conditions are immutable; add a new step instead."
                    )
                db.execute(
                    "INSERT OR IGNORE INTO task_steps(run_id,id,description) VALUES(?,?,?)",
                    (run_id, step.id, step.description),
                )
            self.store._event(db, run_id, "task_plan", {"steps": [s.model_dump() for s in steps]})
        return self.steps(run_id)

    def complete(self, run_id, step_id, evidence, status="passed"):
        with self.store._connection(write=True) as db:
            changed = db.execute(
                "UPDATE task_steps SET status=?,evidence_json=? WHERE run_id=? AND id=?",
                (status, _json(evidence), run_id, step_id),
            ).rowcount
            if not changed:
                raise ValueError("Create the task step before verifying it.")
            self.store._event(
                db,
                run_id,
                "task_check",
                {"step_id": step_id, "status": status, "evidence": evidence},
            )
        return {"step_id": step_id, "status": status, "evidence": evidence}


class TaskStep(BaseModel):
    id: str = Field(min_length=1, max_length=60, pattern=r"^[a-zA-Z0-9_-]+$")
    description: str = Field(min_length=1, max_length=500)


def create_taskflow_tools(store, run, sandbox):
    flow = TaskFlow(store)

    @tool
    def request_user_input(
        question: Annotated[str, Field(min_length=1, max_length=1000)],
        tool_call_id: Annotated[str, InjectedToolCallId],
        options: Annotated[list[str], Field(max_length=5)] = [],
    ) -> dict:
        """Pause for a necessary missing fact or preference. Ask only when it changes the next action; ordinary reversible choices are yours. Answers come only from the authenticated App, never from graph resume data."""
        row = flow.ask(run["id"], tool_call_id, question, options)
        while row["state"] == "pending":
            interrupt({"input_request_id": row["id"]})
            row = flow.ask(run["id"], tool_call_id, question, options)
        if row["state"] != "answered":
            raise ValueError("The question expired; do not act on it.")
        return {"question": question, "answer": row["answer"]}

    @tool
    def set_task_plan(steps: Annotated[list[TaskStep], Field(min_length=1, max_length=20)]) -> list:
        """Declare concrete completion conditions before a multi-step task. IDs are stable and existing conditions cannot be deleted. Each step must be checked or explicitly blocked before delivery."""
        return flow.plan(run["id"], steps)

    @tool
    def block_task_step(
        step_id: str, reason: Annotated[str, Field(min_length=1, max_length=1000)]
    ) -> dict:
        """Record a genuinely blocked condition with its reason. This produces a partial/failed task outcome, never a successful delivery."""
        return flow.complete(run["id"], step_id, {"reason": reason}, "blocked")

    @tool
    def verify_task_evidence(
        step_id: str,
        operation_ids: Annotated[list[str], Field(min_length=1, max_length=20)],
        explanation: Annotated[str, Field(min_length=1, max_length=1000)],
    ) -> dict:
        """Complete a research/delivery step using successful durable operation IDs from task_receipts. The explanation must compare the actual results to the condition. This records evidence, not independent semantic or visual validation."""
        from .operations import READ_TOOLS, Journal

        journal = Journal(store.settings)
        for identifier in operation_ids:
            row = journal.operation(identifier)
            if not row or row["run_id"] != run["id"] or row["state"] != "succeeded":
                raise ValueError("Evidence must be a successful operation belonging to this task.")
            if row["tool"] not in READ_TOOLS | {
                "publish_artifact",
                "write_text_file",
                "copy_file",
                "check_task_step",
                "gitlab_create_issue",
                "gitlab_update_issue",
            }:
                raise ValueError(
                    "Use read results, verified files or confirmed service receipts; a started process is not delivery evidence."
                )
        return flow.complete(
            run["id"],
            step_id,
            {"operation_ids": operation_ids, "explanation": explanation, "kind": "agent_review"},
        )

    @tool
    def task_receipts() -> dict:
        """Inspect this task's completion conditions and durable operation IDs before checking or delivering work."""
        from .operations import Journal

        return {
            "steps": flow.steps(run["id"]),
            "operations": Journal(store.settings).receipts(run["id"])["items"],
        }

    tools = [request_user_input]
    if run["kind"] == "task":
        tools.extend([set_task_plan, block_task_step, verify_task_evidence, task_receipts])
        if sandbox:

            @tool
            async def check_task_step(
                step_id: str, command: Annotated[str, Field(min_length=1, max_length=20000)]
            ) -> dict:
                """Run an actual verification command in the sandbox. Exit zero passes the named condition; errors keep it pending. Use assertions on delivered content, not mere file existence."""
                if not any(s["id"] == step_id for s in flow.steps(run["id"])):
                    raise ValueError("Create the task step before running its check.")
                result = await sandbox.aexecute(command)
                if result.exit_code != 0:
                    raise ValueError(
                        f"Verification did not pass (exit {result.exit_code}): {result.output[-2000:]}"
                    )
                return flow.complete(
                    run["id"],
                    step_id,
                    {
                        "command": command,
                        "exit_code": result.exit_code,
                        "output": result.output[-4000:],
                        "kind": "command",
                    },
                )

            tools.append(check_task_step)
    return tools
