"""Bounded research children owned by one run, outside the user chat queue.

Children have durable handles and receipts, but active Python/model calls do not
survive a process restart. A new owner marks those calls interrupted rather than
claiming they are still running or silently repeating them.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Any

from langchain_core.messages import messages_from_dict
from langchain_core.tools import InjectedToolCallId, tool
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from pydantic import Field

from .store import StoreError, timestamp

ACTIVE = {"queued", "running", "closing"}
RESULT_WINDOW = 16000
READ_ONLY_TOOLS = frozenset({
    "list_directory", "read_text_file", "read_document", "fetch_public_page",
    "calculate", "date_info", "search_history", "read_history",
    "read_history_message", "find_resources", "read_saved_resource",
    "browse_personal_memories", "view_image", "search_web",
    "list_finance_observations", "get_finance_summary", "list_finance_transactions",
    "reconcile_finance_assets", "query_health_context", "query_life_events",
})


def _encode_history(history):
    # Match LangGraph's native serialization rather than drop provider metadata
    # when Gemini signatures or other values contain bytes/datetime/Decimal.
    kind, payload = JsonPlusSerializer().dumps_typed(history)
    return json.dumps({"encoding": kind, "payload": base64.b64encode(payload).decode("ascii")})


def _decode_history(value):
    saved = json.loads(value)
    if isinstance(saved, list):
        return messages_from_dict(saved)
    return JsonPlusSerializer().loads_typed((saved["encoding"], base64.b64decode(saved["payload"])))


def migrate(db) -> None:
    """Add the child ledger; callable from the owning product schema migration."""
    db.execute("""CREATE TABLE IF NOT EXISTS agent_children(
        id TEXT PRIMARY KEY,root_run_id TEXT NOT NULL REFERENCES runs(id),
        start_call_id TEXT NOT NULL,name TEXT NOT NULL,task TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','closing','closed','interrupted')),
        result TEXT,error_code TEXT,history_json TEXT NOT NULL DEFAULT '[]',
        result_version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        UNIQUE(root_run_id,start_call_id))""")
    db.execute("CREATE INDEX IF NOT EXISTS agent_children_root ON agent_children(root_run_id,status)")
    db.execute("""CREATE TABLE IF NOT EXISTS agent_child_inputs(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
        child_id TEXT NOT NULL REFERENCES agent_children(id),call_id TEXT NOT NULL,
        content TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','applied','cancelled','interrupted')),
        created_at TEXT NOT NULL,UNIQUE(child_id,call_id))""")
    db.execute("""CREATE TABLE IF NOT EXISTS agent_child_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,root_run_id TEXT NOT NULL REFERENCES runs(id),
        child_id TEXT NOT NULL REFERENCES agent_children(id),status TEXT NOT NULL,
        created_at TEXT NOT NULL)""")


def interrupt_orphans(db, root_run_id=None):
    """Call after worker ownership is acquired, before recovering root runs."""
    rows = db.execute("SELECT id,root_run_id FROM agent_children WHERE status IN ('queued','running','closing') AND (? IS NULL OR root_run_id=?)", (root_run_id, root_run_id)).fetchall()
    for row in rows:
        now = timestamp()
        db.execute("UPDATE agent_children SET status='interrupted',error_code='owner_restarted',updated_at=? WHERE id=?", (now, row["id"]))
        db.execute("UPDATE agent_child_inputs SET status='interrupted' WHERE child_id=? AND status='queued'", (row["id"],))
        db.execute("INSERT INTO agent_child_events(root_run_id,child_id,status,created_at) VALUES(?,?,'interrupted',?)", (row["root_run_id"], row["id"], now))
    return len(rows)


class ChildLedger:
    def __init__(self, store, root_run_id):
        self.store, self.root_run_id = store, root_run_id
        with store._connection(write=True) as db:
            migrate(db)

    def _require(self, db, child_id):
        row = db.execute("SELECT * FROM agent_children WHERE id=? AND root_run_id=?", (child_id, self.root_run_id)).fetchone()
        if row is None:
            raise StoreError("child_not_found", "Use an agent_id returned by start_agent in this run.", 404)
        return dict(row)

    @staticmethod
    def can_send(row):
        if row["status"] in {"queued", "running", "completed"}:
            return True
        if row["status"] != "failed" or row["error_code"] != "research_limit_with_summary" or not row["result"]:
            return False
        try:
            history = _decode_history(row["history_json"])
            return isinstance(history, list) and bool(history)
        except Exception:
            return False

    @staticmethod
    def public(row, *, result_offset=0):
        if type(result_offset) is not int or result_offset < 0:
            raise StoreError("invalid_result_offset", "result_offset must be a nonnegative integer.", 422)
        result = row["result"]
        length = len(result) if result is not None else 0
        end = result_offset + RESULT_WINDOW
        return {key: row[key] for key in ("id", "name", "status", "error_code", "result_version")} | {
            "agent_id": row["id"], "stopped": row["status"] not in ACTIVE,
            "can_send": ChildLedger.can_send(row),
            "result": result[result_offset:end] if result is not None else None,
            "result_offset": result_offset, "result_length": length,
            "result_truncated": end < length,
            "next_result_offset": end if end < length else None,
        }

    def get(self, child_id):
        with self.store._connection() as db:
            return self._require(db, child_id)

    def all(self):
        with self.store._connection() as db:
            return [dict(row) for row in db.execute("SELECT * FROM agent_children WHERE root_run_id=? ORDER BY created_at,id", (self.root_run_id,))]

    def _event(self, db, child_id, status):
        db.execute("INSERT INTO agent_child_events(root_run_id,child_id,status,created_at) VALUES(?,?,?,?)", (self.root_run_id, child_id, status, timestamp()))

    def create(self, call_id, name, task, max_children):
        identifier = "a_" + hashlib.sha256(f"{self.root_run_id}:{call_id}".encode()).hexdigest()[:16]
        with self.store._connection(write=True) as db:
            old = db.execute("SELECT * FROM agent_children WHERE id=?", (identifier,)).fetchone()
            if old:
                if old["task"] != task or old["name"] != name:
                    raise StoreError("child_call_conflict", "This start call already created a different request. Use its existing handle.")
                return dict(old), False
            count = db.execute("SELECT count(*) FROM agent_children WHERE root_run_id=?", (self.root_run_id,)).fetchone()[0]
            if count >= max_children:
                raise StoreError("child_limit", "This run has reached its research-agent limit. Use an existing child or finish the research yourself.", 422)
            now = timestamp()
            db.execute("INSERT INTO agent_children(id,root_run_id,start_call_id,name,task,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)", (identifier, self.root_run_id, call_id, name, task, now, now))
            self._event(db, identifier, "queued")
            return self._require(db, identifier), True

    def update(self, child_id, status, *, result=None, error_code=None, history=None):
        with self.store._connection(write=True) as db:
            old = self._require(db, child_id)
            db.execute("UPDATE agent_children SET status=?,result=?,error_code=?,history_json=?,result_version=?,updated_at=? WHERE id=?", (
                status, result if result is not None else old["result"], error_code,
                _encode_history(history) if history is not None else old["history_json"],
                old["result_version"] + int(result is not None), timestamp(), child_id,
            ))
            self._event(db, child_id, status)
            if status in {"closed", "failed", "interrupted"}:
                db.execute("UPDATE agent_child_inputs SET status=? WHERE child_id=? AND status='queued'", ("cancelled" if status == "closed" else "interrupted", child_id))
            return self._require(db, child_id)

    def send(self, child_id, call_id, message):
        identifier = "d_" + hashlib.sha256(f"{child_id}:{call_id}".encode()).hexdigest()[:16]
        with self.store._connection(write=True) as db:
            child = self._require(db, child_id)
            old = db.execute("SELECT * FROM agent_child_inputs WHERE id=?", (identifier,)).fetchone()
            if old:
                if old["content"] != message:
                    raise StoreError("child_delivery_conflict", "This send call already delivered a different instruction.")
                return dict(old), False
            if not self.can_send(child):
                raise StoreError("child_unavailable", "This agent has stopped and cannot accept instructions (can_send=false). Use its saved result or start a new research agent.", 422)
            db.execute("INSERT INTO agent_child_inputs(id,child_id,call_id,content,status,created_at) VALUES(?,?,?,?,'queued',?)", (identifier, child_id, call_id, message, timestamp()))
            if child["status"] in {"completed", "failed"}:
                db.execute("UPDATE agent_children SET status='queued',error_code=NULL,updated_at=? WHERE id=?", (timestamp(), child_id))
            self._event(db, child_id, "instruction_queued")
            return dict(db.execute("SELECT * FROM agent_child_inputs WHERE id=?", (identifier,)).fetchone()), True

    def pending(self, child_id):
        with self.store._connection() as db:
            self._require(db, child_id)
            return [dict(row) for row in db.execute("SELECT * FROM agent_child_inputs WHERE child_id=? AND status='queued' ORDER BY seq", (child_id,))]

    def save_snapshot(self, child_id, history, *, applied_ids=None):
        present = {message.id for message in history}
        if applied_ids is not None:
            present.intersection_update(applied_ids)
        with self.store._connection(write=True) as db:
            self._require(db, child_id)
            db.execute("UPDATE agent_children SET history_json=?,updated_at=? WHERE id=?", (_encode_history(history), timestamp(), child_id))
            for identifier in present:
                db.execute("UPDATE agent_child_inputs SET status='applied' WHERE id=? AND child_id=?", (identifier, child_id))

    def snapshot(self, child_ids=None, *, result_offset=0):
        with self.store._connection() as db:
            rows = [self._require(db, identifier) for identifier in child_ids] if child_ids is not None else [dict(row) for row in db.execute("SELECT * FROM agent_children WHERE root_run_id=? ORDER BY created_at,id", (self.root_run_id,))]
            cursor = db.execute("SELECT coalesce(max(seq),0) FROM agent_child_events WHERE root_run_id=?", (self.root_run_id,)).fetchone()[0]
            return {"agents": [self.public(row, result_offset=result_offset) for row in rows], "cursor": cursor}

    def interrupt_orphans(self):
        with self.store._connection(write=True) as db:
            return interrupt_orphans(db, self.root_run_id)


@dataclass
class Child:
    id: str
    task: asyncio.Task | None = None
    close_requested: bool = False
    history: list[Any] = field(default_factory=list)


class AgentCollaboration:
    """Own all in-process children; no child can outlive its owning runtime."""

    def __init__(self, store, run, runner: Callable[..., Awaitable[list]], emit, controls, *, max_children=4, concurrency=2):
        self.run, self.runner, self.emit, self.controls = run, runner, emit, controls
        self.ledger = ChildLedger(store, run["id"])
        self.ledger.interrupt_orphans()
        self.max_children = max_children
        self.semaphore = asyncio.Semaphore(concurrency)
        self.children: dict[str, Child] = {}
        self.changed = asyncio.Condition()
        self.shutting_down = False
        self.observed_results: dict[str, tuple[str, int]] = {}

    async def _notify(self, row):
        async with self.changed:
            self.changed.notify_all()
        await self.emit("agent.child", {"child_id": row["id"], "status": row["status"], "result_version": row["result_version"], "stopped": row["status"] not in ACTIVE})

    async def start(self, task, name, call_id):
        row, created = self.ledger.create(call_id, name, task, self.max_children)
        if created:
            child = Child(row["id"])
            self.children[child.id] = child
            child.task = asyncio.create_task(self._execute(child))
            await self._notify(row)
        return self.ledger.public(row)

    async def send(self, child_id, message, call_id):
        receipt, created = self.ledger.send(child_id, call_id, message)
        if created:
            child = self.children.get(child_id)
            if child is None:
                row = self.ledger.get(child_id)
                child = Child(child_id, history=_decode_history(row["history_json"]))
                self.children[child_id] = child
            if child.task is None or child.task.done():
                child.task = asyncio.create_task(self._execute(child))
            await self._notify(self.ledger.get(child_id))
        return {"agent_id": child_id, "delivery_id": receipt["id"], "status": receipt["status"]}

    async def _execute(self, child):
        try:
            async with self.semaphore:
                if child.close_requested or self.shutting_down:
                    raise asyncio.CancelledError()
                row = self.ledger.update(child.id, "running")
                await self._notify(row)

                async def controls():
                    root = await self.controls()
                    return {
                        "cancel_requested": child.close_requested or self.shutting_down or root.get("cancel_requested", False),
                        "steers": [{"id": item["id"], "content": item["content"], "attachments": []} for item in self.ledger.pending(child.id)],
                    }

                async def emit(kind, data):
                    # Child model text is delivered only in its final result; root
                    # prose must never be overwritten by interleaved child text.
                    if kind.startswith(("assistant.", "reasoning.")):
                        return
                    await self.emit(kind, {**data, "child_id": child.id})

                child.history = await self.runner(row, child.history, controls, emit, lambda history, *, applied_ids=None: self.ledger.save_snapshot(child.id, history, applied_ids=applied_ids))
                if child.close_requested or self.shutting_down:
                    raise asyncio.CancelledError()
                from langchain_core.messages import AIMessage

                final = next((message for message in reversed(child.history) if isinstance(message, AIMessage) and not message.tool_calls), None)
                if final is None:
                    raise RuntimeError("child_missing_result")
                result = final.content if isinstance(final.content, str) else final.text
                limited = final.additional_kwargs.get("zhixing_research_limit") == "research_limit_with_summary"
                pending = bool(self.ledger.pending(child.id))
                row = self.ledger.update(child.id, "failed" if limited else "queued" if pending else "completed", result=result, error_code="research_limit_with_summary" if limited else None, history=child.history)
                await self._notify(row)
                # A late instruction may arrive while a model is finishing. Keep
                # owning that delivery rather than strand a queued follow-up.
                if self.ledger.pending(child.id):
                    self.ledger.update(child.id, "queued")
                    child.task = asyncio.create_task(self._execute(child))
        except asyncio.CancelledError:
            status = "closed" if child.close_requested else "interrupted"
            row = self.ledger.update(child.id, status, error_code=None if child.close_requested else "owner_stopped", history=child.history or None)
            await self._notify(row)
        except Exception as exc:
            # LangGraph can wrap a cancelled model/tool node. Only claim stop
            # after that graph invocation has actually unwound.
            status = "closed" if child.close_requested else "interrupted" if self.shutting_down else "failed"
            row = self.ledger.update(child.id, status, error_code=None if child.close_requested else "owner_stopped" if self.shutting_down else type(exc).__name__, history=child.history or None)
            await self._notify(row)

    def active(self):
        return [row for row in self.ledger.all() if row["status"] in ACTIVE]

    def outstanding(self):
        return [row for row in self.ledger.all() if row["status"] in ACTIVE or (row["status"] != "closed" and self.observed_results.get(row["id"]) != (row["status"], row["result_version"]))]

    async def wait(self, child_ids=None, *, after=0, timeout_ms=10000, result_offset=0):
        if not 0 <= timeout_ms <= 30000:
            raise StoreError("invalid_wait", "timeout_ms must be between 0 and 30000.", 422)
        if type(result_offset) is not int or result_offset < 0:
            raise StoreError("invalid_result_offset", "result_offset must be a nonnegative integer.", 422)
        # Startup and input-queue events are observable in the cursor, but they
        # must not wake the model merely to learn that research has started.
        def actionable(snapshot):
            for row in snapshot["agents"]:
                observed = self.observed_results.get(row["id"])
                if snapshot["cursor"] > after and row["result_version"] > (observed[1] if observed else 0):
                    return True
                if row["status"] not in ACTIVE and observed != (row["status"], row["result_version"]):
                    return True
            return False

        deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
        timed_out = False
        async with self.changed:
            snapshot = self.ledger.snapshot(child_ids, result_offset=result_offset)
            while (not result_offset and any(row["status"] in ACTIVE for row in snapshot["agents"])
                   and not actionable(snapshot)):
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    timed_out = True
                    break
                try:
                    await asyncio.wait_for(self.changed.wait(), remaining)
                except TimeoutError:
                    timed_out = True
                    break
                snapshot = self.ledger.snapshot(child_ids, result_offset=result_offset)
            snapshot = self.ledger.snapshot(child_ids, result_offset=result_offset)
        snapshot["timed_out"] = timed_out
        for row in snapshot["agents"]:
            self.observed_results[row["id"]] = (row["status"], row["result_version"])
        return snapshot

    async def close(self, child_id):
        row = self.ledger.get(child_id)
        child = self.children.get(child_id)
        if row["status"] == "interrupted":
            self.observed_results[child_id] = (row["status"], row["result_version"])
            return self.ledger.public(row)
        if child and child.task and not child.task.done():
            child.close_requested = True
            row = self.ledger.update(child_id, "closing")
            await self._notify(row)
            child.task.cancel()
            await asyncio.shield(asyncio.gather(child.task, return_exceptions=True))
            if self.ledger.get(child_id)["status"] in ACTIVE:
                row = self.ledger.update(child_id, "closed")
                await self._notify(row)
        elif row["status"] != "closed":
            row = self.ledger.update(child_id, "closed")
            await self._notify(row)
        row = self.ledger.get(child_id)
        self.observed_results[child_id] = (row["status"], row["result_version"])
        return self.ledger.public(row)

    async def shutdown(self):
        self.shutting_down = True
        tasks = [child.task for child in self.children.values() if child.task and not child.task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.shield(asyncio.gather(*tasks, return_exceptions=True))
        # Tasks cancelled before their coroutine first runs have no finally block.
        for row in self.active():
            row = self.ledger.update(row["id"], "interrupted", error_code="owner_stopped")
            await self._notify(row)


def create_agent_tools(collaboration):
    @tool
    async def start_agent(
        task: Annotated[str, Field(min_length=1, max_length=12000, description="The original research question, only necessary context and source locations, and the desired concise findings. Preserve the original scope and unknowns; do not expand unasked dimensions, infer missing facts, or ask for a full report repeating the whole prompt.")],
        tool_call_id: Annotated[str, InjectedToolCallId],
        name: Annotated[str, Field(min_length=1, max_length=80)] = "Research",
    ) -> dict:
        """Start a bounded read-only research agent; return its stable agent_id immediately. Pass the original question, only necessary source/context details, and ask for concise evidence findings with known limits. Do not expand unknown dimensions, request unsupported inferences, or ask the child to reproduce a full report or the whole prompt. It can read authorized history/resources and search when enabled; it cannot record service data, publish files, execute code or delegate. Use the named finance/health task tool for service operations. Receive the needed results with wait_agents before your final answer; an already-read terminal result needs no close_agent cleanup. Close only work you are abandoning."""
        return await collaboration.start(task, name, tool_call_id)

    @tool
    async def send_agent(
        agent_id: str,
        message: Annotated[str, Field(min_length=1, max_length=12000)],
        tool_call_id: Annotated[str, InjectedToolCallId],
    ) -> dict:
        """Add an instruction to a research agent whose receipt has can_send=true. Running agents consume it at model/tool boundaries; completed agents continue with their own history. A failed research_limit_with_summary result is partial, not complete; it can continue with its saved evidence and a narrower follow-up, such as summarizing without more tools. Each continuation keeps the same root budget and local research limit. A queued delivery is not proof it has been applied. Closed/interrupted agents and other failures cannot continue."""
        return await collaboration.send(agent_id, message, tool_call_id)

    @tool
    async def wait_agents(
        agent_ids: Annotated[list[str] | None, Field(max_length=4)] = None,
        after: Annotated[int, Field(ge=0)] = 0,
        timeout_ms: Annotated[int, Field(ge=0, le=30000)] = 10000,
        result_offset: Annotated[int, Field(ge=0, description="Leave at zero for the first result read. Continue only when that agent's result_truncated=true and next_result_offset is not null: select that one agent and copy its exact next_result_offset here. If result_truncated=false or next_result_offset=null, all available result text has been returned; never guess an offset or reread the same version.")] = 0,
    ) -> dict:
        """Read research-agent status/results; wait for new results (default up to 10 seconds). Omit agent_ids for all agents. Reuse the returned cursor as after while agents are queued/running; timeout is not completion. Results include result_version, stopped, can_send, result_length, result_truncated and next_result_offset. Continue a result only when result_truncated=true AND next_result_offset is not null: select that one agent_id and pass the exact returned next_result_offset as result_offset. If result_truncated=false or next_result_offset=null, all available result text is already in the receipt; never invent an offset or reread the same result_version. Check result_version across pages; restart at zero only if a follow-up produced a new version. An already-read terminal result needs no close_agent cleanup; use it and finish once all needed results are collected. A failed research_limit_with_summary result is partial; when can_send=true, send_agent can continue the same agent with its saved context."""
        return await collaboration.wait(agent_ids, after=after, timeout_ms=timeout_ms, result_offset=result_offset)

    @tool
    async def close_agent(agent_id: str) -> dict:
        """Abandon research work that is no longer needed. Already-read terminal results need no cleanup call. Waits for in-flight model/read-tool work to actually stop before returning stopped=true. Keeps its existing result; interrupted reports a previous owner stopped it."""
        return await collaboration.close(agent_id)

    return [start_agent, send_agent, wait_agents, close_agent]
