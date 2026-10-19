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
from pathlib import PurePosixPath
from typing import Annotated, Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    ToolMessage,
    messages_from_dict,
)
from langchain_core.tools import InjectedToolCallId, tool
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from pydantic import Field

from .store import StoreError, timestamp

ACTIVE = {"queued", "running", "closing"}
RESULT_WINDOW = 16000
# Deep Agents offloads tool text above 80k serialized characters. Keep the whole
# multi-agent receipt below that boundary, including JSON escapes and metadata.
RESULT_MESSAGE_LIMIT = 60000
SOURCE_SCOPE_KEY = "zhixing_research_source_paths"
MAX_SOURCE_PATHS = 8
SOURCE_READERS = frozenset({"read_text_file", "read_document", "view_image"})
SCOPED_RESEARCH_TOOLS = SOURCE_READERS
FILESYSTEM_TOOLS = SOURCE_READERS | frozenset({
    "inspect_environment", "list_directory", "write_text_file", "copy_file",
    "ls", "read_file", "write_file", "edit_file", "delete_file", "glob", "grep", "execute",
})
READ_ONLY_TOOLS = frozenset({
    "list_directory", "read_text_file", "read_document", "fetch_public_page",
    "calculate", "date_info", "search_history", "read_history",
    "read_history_message", "find_resources", "read_saved_resource",
    "browse_personal_memories", "view_image", "search_web",
    "list_finance_observations", "get_finance_summary", "list_finance_transactions",
    "reconcile_finance_assets", "query_health_context", "query_life_events",
})


def _bound_result_pages(snapshot):
    def encoded_size(value):
        return max(len(json.dumps(value, ensure_ascii=ascii_only)) for ascii_only in (True, False))

    if encoded_size(snapshot) <= RESULT_MESSAGE_LIMIT:
        return snapshot

    def trimmed(page_size):
        agents = []
        for row in snapshot["agents"]:
            if row["result"] is None:
                agents.append(row)
                continue
            text = row["result"][:page_size]
            end = row["result_offset"] + len(text)
            agents.append({
                **row, "result": text,
                "result_truncated": end < row["result_length"],
                "next_result_offset": end if end < row["result_length"] else None,
            })
        return {**snapshot, "agents": agents}

    low, high = 0, max(len(row["result"] or "") for row in snapshot["agents"])
    if encoded_size(trimmed(0)) > RESULT_MESSAGE_LIMIT:
        raise StoreError("agent_receipt_too_large", "Read a smaller selection of agent handles; no result page was delivered.", 422)
    while low < high:
        midpoint = (low + high + 1) // 2
        if encoded_size(trimmed(midpoint)) <= RESULT_MESSAGE_LIMIT:
            low = midpoint
        else:
            high = midpoint - 1
    return trimmed(low)


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


def _normalise_source_paths(paths):
    if not isinstance(paths, (list, tuple)) or len(paths) > MAX_SOURCE_PATHS:
        raise StoreError("invalid_research_sources", "Choose at most eight source_paths from the available workspace files.", 422)
    for path in paths:
        if (not isinstance(path, str) or not path or len(path) > 2000
                or path.startswith(("/", "~")) or "\\" in path or ":" in path
                or any(ord(char) < 32 for char in path)
                or ".." in PurePosixPath(path).parts or path == "."
                or PurePosixPath(path).as_posix() != path):
            raise StoreError("invalid_research_sources", "Use the exact relative source_paths returned in the available workspace files.", 422)
    return tuple(sorted(set(paths)))


def child_source_paths(history):
    """Read only the initial request's trusted scope, never task/follow-up text."""
    initial = next((message for message in history if isinstance(message, HumanMessage)), None)
    if initial is None or SOURCE_SCOPE_KEY not in initial.additional_kwargs:
        return ()  # Pre-scope children retain generic history/web access only.
    return _normalise_source_paths(initial.additional_kwargs[SOURCE_SCOPE_KEY])


def _preserve_source_request(previous, history):
    """A runner snapshot cannot replace or remove the original scope anchor."""
    initial = next((message for message in previous if isinstance(message, HumanMessage)), None)
    if initial is None or SOURCE_SCOPE_KEY not in initial.additional_kwargs:
        return history
    child_source_paths(previous)  # Fail closed rather than downgrade corrupt scope.
    return [initial, *(message for message in history if message.id != initial.id)]


class ResearchSourceGuard(AgentMiddleware):
    """Enforce the persisted source scope even for forged raw model calls."""

    def __init__(self, paths):
        self.paths = frozenset(_normalise_source_paths(paths))

    def _rejection(self, request):
        call = request.tool_call
        name, args = call["name"], call.get("args", {})
        allowed = (
            name in SCOPED_RESEARCH_TOOLS - SOURCE_READERS or (
                name in SOURCE_READERS and isinstance(args, dict)
                and isinstance(args.get("path"), str) and args["path"] in self.paths
                and not args.get("resource_id")
            )
        ) if self.paths else name in READ_ONLY_TOOLS and name not in FILESYSTEM_TOOLS
        if allowed:
            return None
        return ToolMessage(
            content=json.dumps({"error": {
                "code": "research_source_unavailable",
                "message": "This tool or source is outside this child's fixed scope. Use its selected source paths, or report that the requested evidence is unavailable; no read was performed.",
            }}),
            tool_call_id=call["id"], name=name, status="error",
        )

    async def awrap_tool_call(self, request, handler):
        rejected = self._rejection(request)
        if rejected is not None:
            return rejected
        try:
            result = await handler(request)
        except (FileNotFoundError, PermissionError) as exc:
            if not self.paths or request.tool_call["name"] not in SOURCE_READERS:
                raise
            return self._unreadable_source(request, exc)
        return self._relative_receipt(request, result)

    def wrap_tool_call(self, request, handler):
        rejected = self._rejection(request)
        if rejected is not None:
            return rejected
        try:
            result = handler(request)
        except (FileNotFoundError, PermissionError) as exc:
            if not self.paths or request.tool_call["name"] not in SOURCE_READERS:
                raise
            return self._unreadable_source(request, exc)
        return self._relative_receipt(request, result)

    @staticmethod
    def _unreadable_source(request, exc):
        return ToolMessage(
            content=json.dumps({"error": {
                "code": "file_not_found" if isinstance(exc, FileNotFoundError) else "file_access_denied",
                "message": "The selected source is currently unreadable; no source content was returned.",
                "next_action": "Keep the missing evidence unknown and report it to the main assistant. This child's selected source scope cannot change; do not search for replacement sources.",
                "retryable": False,
            }}),
            tool_call_id=request.tool_call["id"], name=request.tool_call["name"], status="error",
        )

    def _relative_receipt(self, request, result):
        # Physical readers return a host absolute path. A scoped child must see
        # its exact callable enum path instead, including on document pages.
        if (not self.paths or request.tool_call["name"] not in SOURCE_READERS
                or not isinstance(result, ToolMessage) or result.status != "success"
                or not isinstance(result.content, str)):
            return result
        try:
            payload = json.loads(result.content)
        except (ValueError, TypeError):
            return result
        if not isinstance(payload, dict) or "path" not in payload:
            return result
        payload["path"] = request.tool_call["args"]["path"]
        return result.model_copy(update={"content": json.dumps(payload, ensure_ascii=False)})


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
        if row["status"] != "failed" or row["error_code"] not in {"research_limit_with_summary", "ResearchLimitError"}:
            return False
        if row["error_code"] == "research_limit_with_summary" and not row["result"]:
            return False
        try:
            history = _decode_history(row["history_json"])
            return isinstance(history, list) and bool(history) and all(isinstance(message, BaseMessage) for message in history) and any(isinstance(message, AIMessage) for message in history)
        except Exception:
            return False

    @staticmethod
    def public(row, *, result_offset=0):
        if type(result_offset) is not int or result_offset < 0:
            raise StoreError("invalid_result_offset", "result_offset must be a nonnegative integer.", 422)
        result = row["result"]
        length = len(result) if result is not None else 0
        end = result_offset + RESULT_WINDOW
        can_send = ChildLedger.can_send(row)
        return {key: row[key] for key in ("id", "name", "status", "error_code", "result_version")} | {
            "agent_id": row["id"], "stopped": row["status"] not in ACTIVE,
            "can_send": can_send,
            "continuation_reason": ("research_limit_without_summary" if row["error_code"] == "ResearchLimitError" else "research_limit_with_summary") if can_send and row["status"] == "failed" else None,
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

    def create(self, call_id, name, task, max_children, *, source_paths=()):
        source_paths = _normalise_source_paths(source_paths)
        identifier = "a_" + hashlib.sha256(f"{self.root_run_id}:{call_id}".encode()).hexdigest()[:16]
        with self.store._connection(write=True) as db:
            old = db.execute("SELECT * FROM agent_children WHERE id=?", (identifier,)).fetchone()
            if old:
                if old["task"] != task or old["name"] != name or child_source_paths(_decode_history(old["history_json"])) != source_paths:
                    raise StoreError("child_call_conflict", "This start call already created a different request. Use its existing handle.")
                return dict(old), False
            count = db.execute("SELECT count(*) FROM agent_children WHERE root_run_id=?", (self.root_run_id,)).fetchone()[0]
            if count >= max_children:
                raise StoreError("child_limit", "This run has reached its research-agent limit. Use an existing child or finish the research yourself.", 422)
            now = timestamp()
            history = [HumanMessage(content=task, id="request-" + identifier, additional_kwargs={SOURCE_SCOPE_KEY: list(source_paths)})]
            db.execute("INSERT INTO agent_children(id,root_run_id,start_call_id,name,task,status,history_json,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?)", (identifier, self.root_run_id, call_id, name, task, _encode_history(history), now, now))
            self._event(db, identifier, "queued")
            return self._require(db, identifier), True

    def update(self, child_id, status, *, result=None, error_code=None, history=None):
        with self.store._connection(write=True) as db:
            old = self._require(db, child_id)
            db.execute("UPDATE agent_children SET status=?,result=?,error_code=?,history_json=?,result_version=?,updated_at=? WHERE id=?", (
                status, result if result is not None else old["result"], error_code,
                _encode_history(_preserve_source_request(_decode_history(old["history_json"]), history)) if history is not None else old["history_json"],
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
            old = self._require(db, child_id)
            history = _preserve_source_request(_decode_history(old["history_json"]), history)
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

    def __init__(self, store, run, runner: Callable[..., Awaitable[list]], emit, controls, *, max_children=4, concurrency=2, available_source_paths=None):
        self.run, self.runner, self.emit, self.controls = run, runner, emit, controls
        self.ledger = ChildLedger(store, run["id"])
        self.ledger.interrupt_orphans()
        self.max_children = max_children
        self.semaphore = asyncio.Semaphore(concurrency)
        self.children: dict[str, Child] = {}
        self.changed = asyncio.Condition()
        self.shutting_down = False
        self.observed_results: dict[str, tuple[str, int]] = {}
        self.result_read_ranges: dict[str, tuple[str, int, list[tuple[int, int]]]] = {}
        self.dismissed_results: dict[str, tuple[str, int]] = {}
        self.available_source_paths = available_source_paths or (lambda: ())

    async def _notify(self, row):
        async with self.changed:
            self.changed.notify_all()
        await self.emit("agent.child", {"child_id": row["id"], "status": row["status"], "result_version": row["result_version"], "stopped": row["status"] not in ACTIVE})

    async def start(self, task, name, call_id, source_paths=()):
        source_paths = _normalise_source_paths(source_paths)
        # Replays keep their original handle even if a source later disappears;
        # changing that call's scope is still an idempotency conflict.
        existing = next((row for row in self.ledger.all() if row["start_call_id"] == call_id), None)
        if existing is None and source_paths:
            available = await asyncio.to_thread(self.available_source_paths)
            if not set(source_paths).issubset(available):
                raise StoreError("research_source_unavailable", "Choose source_paths from this conversation's currently available workspace files. No research agent was created.", 422)
        row, created = self.ledger.create(call_id, name, task, self.max_children, source_paths=source_paths)
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
                child.history = _decode_history(self.ledger.get(child.id)["history_json"])
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

                def save_snapshot(history, *, applied_ids=None):
                    self.ledger.save_snapshot(child.id, history, applied_ids=applied_ids)
                    child.history = list(history)

                child.history = await self.runner(row, child.history, controls, emit, save_snapshot)
                if child.close_requested or self.shutting_down:
                    raise asyncio.CancelledError()
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
            # A local-limit follow-up can be accepted while this terminal
            # notification is still in flight. Its graph already unwound; own
            # the queued instruction rather than leaving it without a runner.
            if not child.close_requested and not self.shutting_down and self.ledger.pending(child.id) and self.ledger.get(child.id)["status"] == "queued":
                child.task = asyncio.create_task(self._execute(child))

    def active(self):
        return [row for row in self.ledger.all() if row["status"] in ACTIVE]

    def _observe_result_page(self, row):
        identity = (row["status"], row["result_version"])
        previous = self.result_read_ranges.get(row["id"])
        ranges = list(previous[2]) if previous and previous[:2] == identity else []
        start = row["result_offset"]
        end = start + len(row["result"] or "")
        if start <= row["result_length"]:
            ranges.append((start, end))
        merged = []
        for start, end in sorted(ranges):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))
        self.result_read_ranges[row["id"]] = (*identity, merged)

    def _fully_observed(self, row):
        identity = (row["status"], row["result_version"])
        if self.dismissed_results.get(row["id"]) == identity:
            return True
        evidence = self.result_read_ranges.get(row["id"])
        return bool(
            self.observed_results.get(row["id"]) == identity
            and evidence and evidence[:2] == identity and evidence[2]
            and evidence[2][0][0] == 0
            and evidence[2][0][1] >= len(row["result"] or "")
        )

    def outstanding(self):
        return [row for row in self.ledger.all() if row["status"] in ACTIVE or (row["status"] != "closed" and not self._fully_observed(row))]

    def has_unread_result_pages(self, rows):
        for row in rows:
            evidence = self.result_read_ranges.get(row["id"])
            if (evidence and evidence[:2] == (row["status"], row["result_version"])
                    and any(end > start for start, end in evidence[2])
                    and not self._fully_observed(row)):
                return True
        return False

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
        snapshot = _bound_result_pages(snapshot)
        for row in snapshot["agents"]:
            self.observed_results[row["id"]] = (row["status"], row["result_version"])
            self._observe_result_page(row)
        return snapshot

    async def close(self, child_id):
        row = self.ledger.get(child_id)
        child = self.children.get(child_id)
        if row["status"] == "interrupted":
            self.observed_results[child_id] = (row["status"], row["result_version"])
            self.dismissed_results[child_id] = (row["status"], row["result_version"])
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
        source_paths: Annotated[list[str], Field(max_length=MAX_SOURCE_PATHS, description="Select the exact paths of the workspace files needed for this task from the available choices. This fixed read-only scope persists across follow-ups; task text cannot add paths. Use [] for general history/resources/web research, which has no filesystem access.")],
        name: Annotated[str, Field(min_length=1, max_length=80)] = "Research",
    ) -> dict:
        """Start a bounded read-only research agent; return its stable agent_id immediately. Select source_paths from the available workspace choices instead of copying or inventing paths in task text. Selected paths are its entire filesystem/evidence scope and cannot be expanded by send_agent; [] instead permits general history/resources/web research with no filesystem access. Pass the original question, only necessary context, and ask for concise evidence findings with known limits. Do not expand unknown dimensions, request unsupported inferences, or ask the child to reproduce a full report or the whole prompt. It cannot record service data, publish files, execute code or delegate. Use the named finance/health task tool for service operations. Receive the needed results with wait_agents before your final answer; an already-read terminal result needs no close_agent cleanup. Close only work you are abandoning."""
        return await collaboration.start(task, name, tool_call_id, source_paths=source_paths)

    @tool
    async def send_agent(
        agent_id: str,
        message: Annotated[str, Field(min_length=1, max_length=12000)],
        tool_call_id: Annotated[str, InjectedToolCallId],
    ) -> dict:
        """Add an instruction to a research agent whose receipt has can_send=true; follow that boolean rather than memorizing error classes. Running agents consume it at model/tool boundaries; completed agents continue with their own history. A local boundary may stop a child with a partial result or no summary: status=failed and result=null are not completion. When can_send=true, valid saved context is available; continue the same child with a narrower follow-up, such as summarizing already-read evidence without more tools, rather than recreating it merely for a local limit. Each continuation keeps the same root budget and local research limit. A queued delivery is not proof it has been applied. When can_send=false, that child cannot continue."""
        return await collaboration.send(agent_id, message, tool_call_id)

    @tool
    async def wait_agents(
        agent_ids: Annotated[list[str] | None, Field(max_length=4)] = None,
        after: Annotated[int, Field(ge=0)] = 0,
        timeout_ms: Annotated[int, Field(ge=0, le=30000)] = 10000,
        result_offset: Annotated[int, Field(ge=0, description="Leave at zero for the first result read. Continue only when that agent's result_truncated=true and next_result_offset is not null: select that one agent and copy its exact next_result_offset here. If result_truncated=false or next_result_offset=null, all available result text has been returned; never guess an offset or reread the same version.")] = 0,
    ) -> dict:
        """Read research-agent status/results; wait for new results (default up to 10 seconds). Omit agent_ids for all agents. Reuse the returned cursor as after while agents are queued/running; timeout is not completion. Results include result_version, stopped, can_send, continuation_reason, result_length, result_truncated and next_result_offset. Continue a result only when result_truncated=true AND next_result_offset is not null: select that one agent_id and pass the exact returned next_result_offset as result_offset. If result_truncated=false or next_result_offset=null, all available result text is already in the receipt; never invent an offset or reread the same result_version. Check result_version across pages; restart at zero only if a follow-up produced a new version. An already-read terminal result needs no close_agent cleanup; use it and finish once all needed results are collected. A local-limit failure remains failed even with partial text; result=null means no summary, and any retained older result does not complete the latest instruction. Follow can_send: true means send_agent can continue the same saved context with a narrower instruction, without a new root budget; false means it cannot continue. Error codes are diagnostics, not the continuation contract."""
        return await collaboration.wait(agent_ids, after=after, timeout_ms=timeout_ms, result_offset=result_offset)

    @tool
    async def close_agent(agent_id: str) -> dict:
        """Abandon research work that is no longer needed. Already-read terminal results need no cleanup call. Waits for in-flight model/read-tool work to actually stop before returning stopped=true. Keeps its existing result; interrupted reports a previous owner stopped it."""
        return await collaboration.close(agent_id)

    return [start_agent, send_agent, wait_agents, close_agent]
