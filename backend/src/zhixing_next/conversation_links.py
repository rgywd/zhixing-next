"""Durable, read-only requests between existing conversations.

Only the worker owning a conversation may run its graph. Sending just enqueues;
waiting checkpoints the caller and releases its worker slot. An assistant's
message is never new user authority or input to personal-memory extraction.
"""

from __future__ import annotations

from typing import Annotated
from uuid import NAMESPACE_URL, uuid5

from langchain_core.tools import InjectedToolCallId, tool
from langgraph.types import interrupt

from .store import TERMINAL, StoreError, _json, timestamp

WAIT_PHASE = "agent_wait"
MAX_DELIVERIES = 8


def migrate(db):
    if "origin" not in {row[1] for row in db.execute("PRAGMA table_info(runs)")}:
        db.execute("ALTER TABLE runs ADD COLUMN origin TEXT")
    db.execute("""CREATE TABLE IF NOT EXISTS conversation_deliveries(
        id TEXT PRIMARY KEY,source_run_id TEXT NOT NULL REFERENCES runs(id),
        source_conversation_id TEXT NOT NULL REFERENCES conversations(id),
        target_conversation_id TEXT NOT NULL REFERENCES conversations(id),
        target_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        call_id TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,
        UNIQUE(source_run_id,call_id))""")
    db.execute("""CREATE TABLE IF NOT EXISTS conversation_waits(
        source_run_id TEXT NOT NULL REFERENCES runs(id),
        delivery_id TEXT NOT NULL REFERENCES conversation_deliveries(id),
        PRIMARY KEY(source_run_id,delivery_id))""")


def delivery_for_run(db, run_id):
    row = db.execute(
        "SELECT id,source_run_id,source_conversation_id,target_conversation_id "
        "FROM conversation_deliveries WHERE target_run_id=?", (run_id,),
    ).fetchone()
    return dict(row) if row else None


def _receipt(db, row):
    run = db.execute("SELECT * FROM runs WHERE id=?", (row["target_run_id"],)).fetchone()
    conversation = db.execute(
        "SELECT blocked FROM conversations WHERE id=?", (row["target_conversation_id"],),
    ).fetchone()
    state = run["status"]
    attention = state not in TERMINAL and (
        bool(conversation["blocked"]) or run["phase"] in {"approval", "input"}
    )
    result = {
        "delivery_id": row["id"], "source_run_id": row["source_run_id"],
        "target_conversation_id": row["target_conversation_id"],
        "target_run_id": row["target_run_id"], "origin": "agent_message",
        "status": state, "terminal": state in TERMINAL,
        "needs_attention": attention, "read_only": True,
    }
    if state in TERMINAL:
        text = run["result"]
        reply = db.execute("SELECT id FROM messages WHERE run_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1", (run["id"],)).fetchone()
        result.update(result=text[:16000] if text else text, error=run["error"],
                      result_truncated=bool(text and len(text) > 16000),
                      reply_message_id=reply["id"] if reply else None)
    elif attention:
        result["attention_reason"] = "conversation_blocked" if conversation["blocked"] else run["phase"]
    return result


def wait_pending(db, run_id):
    rows = db.execute(
        "SELECT d.* FROM conversation_waits w JOIN conversation_deliveries d "
        "ON d.id=w.delivery_id WHERE w.source_run_id=?", (run_id,),
    ).fetchall()
    receipts = [_receipt(db, row) for row in rows]
    return bool(receipts) and not any(item["needs_attention"] for item in receipts) and any(
        not item["terminal"] for item in receipts
    )


def wake_waiters(db, store):
    """Called in the finishing transaction and on worker maintenance (lost-wake safe)."""
    rows = db.execute(
        "SELECT id FROM runs WHERE status='queued' AND phase=?", (WAIT_PHASE,),
    ).fetchall()
    for row in rows:
        if not wait_pending(db, row["id"]):
            db.execute("UPDATE runs SET phase='recovering' WHERE id=?", (row["id"],))
            store._event(db, row["id"], "conversation.reply_ready", {})


class ConversationLinks:
    def __init__(self, store):
        self.store = store

    def send(self, source_run_id, call_id, target_conversation_id, content):
        if not isinstance(content, str) or not content.strip() or len(content) > 10000:
            raise StoreError("invalid_agent_message", "Provide a nonempty request of at most 10000 characters", 422)
        identifier = "delivery-" + uuid5(NAMESPACE_URL, f"{source_run_id}:{call_id}").hex
        with self.store._connection(write=True) as db:
            previous = db.execute("SELECT * FROM conversation_deliveries WHERE id=?", (identifier,)).fetchone()
            if previous:
                if previous["target_conversation_id"] != target_conversation_id or previous["content"] != content:
                    raise StoreError("delivery_conflict", "This delivery already has different content or a target")
                return _receipt(db, previous)
            source = self.store._require(db, "runs", source_run_id)
            target = self.store._require(db, "conversations", target_conversation_id)
            if source["status"] != "running" or source["cancel_requested"]:
                raise StoreError("source_not_running", "The sending run is no longer active")
            if delivery_for_run(db, source_run_id):
                raise StoreError("agent_message_read_only", "A forwarded assistant request cannot send further requests", 403)
            if source["conversation_id"] == target_conversation_id:
                raise StoreError("same_conversation", "Answer in the current conversation; do not send to yourself", 422)
            if target["blocked"]:
                raise StoreError("target_blocked", "This conversation is paused; choose another conversation or let the user resume it")
            count = db.execute(
                "SELECT COUNT(*) FROM conversation_deliveries WHERE source_run_id=?", (source_run_id,),
            ).fetchone()[0]
            if count >= MAX_DELIVERIES:
                raise StoreError("delivery_limit", "This run has reached its cross-conversation request limit", 422)
            # Dependencies follow conversations because FIFO also blocks runs in
            # the same conversation. Reject cycles before committing a new edge.
            cycle = db.execute("""WITH RECURSIVE reachable(id) AS (
                SELECT ? UNION SELECT d.target_conversation_id
                FROM conversation_deliveries d JOIN reachable r ON d.source_conversation_id=r.id
                JOIN runs target ON target.id=d.target_run_id
                WHERE target.status IN ('queued','running'))
                SELECT 1 FROM reachable WHERE id=?""",
                (target_conversation_id, source["conversation_id"]),
            ).fetchone()
            if cycle:
                raise StoreError("conversation_cycle", "This request would create a conversation dependency cycle", 422)
            now = timestamp()
            message_id = "agent-message-" + uuid5(NAMESPACE_URL, identifier).hex
            metadata = {
                "conversation_id": target_conversation_id, "content": content,
                "intent": "queue", "kind": "chat", "origin": "agent_message",
                "source_run_id": source_run_id, "source_conversation_id": source["conversation_id"],
                "delivery_id": identifier, "read_only": True,
            }
            target_run_id = self.store._enqueue(
                db, target_conversation_id, message_id, content, "chat", _json(metadata),
            )
            # Forwarded content must not become a new personal-memory source.
            db.execute("UPDATE runs SET memory_processed=1,origin='agent_message' WHERE id=?", (target_run_id,))
            db.execute(
                "INSERT INTO conversation_deliveries VALUES(?,?,?,?,?,?,?,?)",
                (identifier, source_run_id, source["conversation_id"], target_conversation_id,
                 target_run_id, call_id, content, now),
            )
            self.store._event(db, source_run_id, "conversation.message_sent", {
                "delivery_id": identifier, "target_conversation_id": target_conversation_id,
                "target_run_id": target_run_id, "status": "accepted", "read_only": True,
            })
            self.store._event(db, target_run_id, "conversation.message_received", {
                "delivery_id": identifier, "source_conversation_id": source["conversation_id"],
                "origin": "agent_message", "read_only": True,
            })
            return _receipt(db, self.store._require(db, "conversation_deliveries", identifier))

    def read(self, source_run_id, delivery_id):
        with self.store._connection() as db:
            row = self.store._require(db, "conversation_deliveries", delivery_id)
            if row["source_run_id"] != source_run_id:
                raise StoreError("delivery_scope", "This delivery belongs to another run", 403)
            return _receipt(db, row)

    def prepare_wait(self, source_run_id, delivery_ids):
        if not delivery_ids or len(delivery_ids) > MAX_DELIVERIES or len(set(delivery_ids)) != len(delivery_ids):
            raise StoreError("invalid_deliveries", "Choose one to eight distinct delivery IDs returned by send_conversation_message", 422)
        with self.store._connection(write=True) as db:
            source = self.store._require(db, "runs", source_run_id)
            if source["status"] != "running" or source["cancel_requested"]:
                raise StoreError("source_not_running", "The waiting run is no longer active")
            rows = [self.store._require(db, "conversation_deliveries", item) for item in delivery_ids]
            if any(row["source_run_id"] != source_run_id for row in rows):
                raise StoreError("delivery_scope", "A delivery belongs to another run", 403)
            receipts = [_receipt(db, row) for row in rows]
            pending = not any(item["needs_attention"] for item in receipts) and any(
                not item["terminal"] for item in receipts
            )
            if pending:
                # A model may issue independent waits in one tool batch. Keep
                # their union so one branch cannot erase another dependency.
                db.executemany("INSERT OR IGNORE INTO conversation_waits VALUES(?,?)", [(source_run_id, item) for item in delivery_ids])
            else:
                db.executemany("DELETE FROM conversation_waits WHERE source_run_id=? AND delivery_id=?", [(source_run_id, item) for item in delivery_ids])
            return {"replies": receipts, "waiting": pending}

    def refresh(self):
        with self.store._connection(write=True) as db:
            wake_waiters(db, self.store)

    def list(self, source_run_id):
        with self.store._connection() as db:
            self.store._require(db, "runs", source_run_id)
            rows = db.execute("SELECT * FROM conversation_deliveries WHERE source_run_id=? ORDER BY created_at", (source_run_id,)).fetchall()
            return {"items": [_receipt(db, row) for row in rows]}


def create_conversation_tools(store, run):
    links = ConversationLinks(store)

    @tool
    async def send_conversation_message(
        target_conversation_id: str, message: str,
        tool_call_id: Annotated[str, InjectedToolCallId],
    ) -> dict:
        """Ask an EXISTING OTHER conversation a bounded read-only question using its history and identity. Find its ID with search_history; never invent an ID. Returns a durable delivery_id and acceptance, not an answer or completed work. The receiving assistant cannot mutate data or forward requests. To collect its answer call wait_conversation_replies. Cancelling your run does not withdraw an accepted independent request."""
        return links.send(run["id"], tool_call_id, target_conversation_id, message)

    @tool
    async def read_conversation_reply(delivery_id: str) -> dict:
        """Read the actual status and, when finished, result of a delivery created by this run. A failed/cancelled/interrupted target is not a successful answer. Use wait_conversation_replies to wait without polling. Long results are bounded; read_history_message(reply_message_id) retrieves more when result_truncated is true."""
        return links.read(run["id"], delivery_id)

    @tool
    async def wait_conversation_replies(delivery_ids: list[str]) -> dict:
        """Wait for one to eight deliveries returned by send_conversation_message. Saves progress and releases the chat slot, then resumes when all replies finish or one needs user attention. Returns actual results and failure states. Do not poll read_conversation_reply in a loop."""
        result = links.prepare_wait(run["id"], delivery_ids)
        while result["waiting"]:
            interrupt({"conversation_delivery_ids": delivery_ids})
            result = links.prepare_wait(run["id"], delivery_ids)
        return result

    return [send_conversation_message, read_conversation_reply, wait_conversation_replies]
