"""Single-host product state. Network/model work never runs inside these transactions."""

import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from .config import Settings
from .sqlite_policy import safe_journal_mode

TERMINAL = {"completed", "failed", "cancelled", "interrupted"}


class StoreError(Exception):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def timestamp(value: datetime | None = None) -> str:
    return (value or datetime.now(UTC)).astimezone(UTC).isoformat(timespec="microseconds")


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _record(row):
    if row is None:
        return None
    result = dict(row)
    result.pop("request_json", None)
    result.pop("workspace_path", None)
    for key in ("blocked", "cancel_requested", "enabled"):
        if key in result:
            result[key] = bool(result[key])
    return result


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        settings.workspace_root.mkdir(parents=True, exist_ok=True)
        self.db_path = settings.data_dir / "app.sqlite"
        with self._connection() as db:
            self.journal_mode = db.execute(f"PRAGMA journal_mode={safe_journal_mode()}").fetchone()[
                0
            ]
            db.execute("BEGIN IMMEDIATE")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 1:
                raise RuntimeError("Database schema is newer than this server")
            if version == 0:
                # Individual statements keep schema creation and its version in one transaction.
                for statement in _SCHEMA:
                    db.execute(statement)
                db.execute("PRAGMA user_version=1")
            db.commit()

    @contextmanager
    def _connection(self, write=False):
        db = sqlite3.connect(self.db_path, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=5000")
        db.execute("PRAGMA synchronous=FULL")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            if write:
                db.commit()
        except BaseException:
            if db.in_transaction:
                db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _require(db, table, identifier):
        # table is an internal constant from the methods below, never client input.
        row = db.execute(f"SELECT * FROM {table} WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise StoreError("not_found", "Resource not found", 404)
        return row

    @staticmethod
    def _event(db, run_id, event_type, data):
        db.execute(
            "INSERT INTO events(run_id,type,data,created_at) VALUES(?,?,?,?)",
            (run_id, event_type, _json(data), timestamp()),
        )

    @staticmethod
    def _page(rows, limit, cursor_key="seq"):
        return {
            "items": [_record(row) for row in rows[:limit]],
            "next_cursor": str(rows[limit - 1][cursor_key]) if len(rows) > limit else None,
        }

    def get_assistant(self):
        with self._connection() as db:
            row = db.execute("SELECT name,persona FROM assistant WHERE id=1").fetchone()
            return dict(row)

    def set_assistant(self, name, persona):
        with self._connection(write=True) as db:
            db.execute("UPDATE assistant SET name=?,persona=? WHERE id=1", (name, persona))
        return {"name": name, "persona": persona}

    def create_project(self, name):
        identifier = str(uuid4())
        path = self.settings.workspace_root / "projects" / identifier
        path.mkdir(parents=True)
        with self._connection(write=True) as db:
            db.execute(
                "INSERT INTO projects(id,name,workspace_path,created_at) VALUES(?,?,?,?)",
                (identifier, name, str(path.resolve()), timestamp()),
            )
            return dict(self._require(db, "projects", identifier))

    def list_projects(self, cursor=0, limit=50):
        with self._connection() as db:
            rows = db.execute(
                "SELECT rowid AS seq,* FROM projects WHERE rowid>? ORDER BY rowid LIMIT ?",
                (cursor, limit + 1),
            ).fetchall()
            page = self._page(rows, limit)
            for result, row in zip(page["items"], rows):
                result["workspace_path"] = row["workspace_path"]
                result.pop("seq", None)
            return page

    def create_conversation(self, title, project_id=None):
        identifier = str(uuid4())
        with self._connection() as db:
            project = self._require(db, "projects", project_id) if project_id else None
        workspace = (
            Path(project["workspace_path"])
            if project
            else self.settings.workspace_root / "conversations" / identifier
        )
        workspace.mkdir(parents=True, exist_ok=True)
        now = timestamp()
        with self._connection(write=True) as db:
            db.execute(
                "INSERT INTO conversations(id,title,project_id,workspace_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (identifier, title, project_id, str(workspace.resolve()), now, now),
            )
            return _record(self._require(db, "conversations", identifier))

    def get_conversation(self, conversation_id):
        with self._connection() as db:
            return _record(self._require(db, "conversations", conversation_id))

    def workspace_for(self, conversation_id):
        with self._connection() as db:
            return Path(self._require(db, "conversations", conversation_id)["workspace_path"])

    def list_conversations(self, cursor=0, limit=50, *, before=None, latest=False):
        with self._connection() as db:
            if latest or before is not None:
                rows = db.execute(
                    "SELECT rowid AS seq,* FROM conversations WHERE (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT ?",
                    (before, before, limit + 1),
                ).fetchall()
                items = [_record(row) for row in reversed(rows[:limit])]
                return {
                    "items": items,
                    "next_cursor": None,
                    "previous_cursor": str(items[0]["seq"]) if len(rows) > limit else None,
                }
            rows = db.execute(
                "SELECT rowid AS seq,* FROM conversations WHERE rowid>? ORDER BY rowid LIMIT ?",
                (cursor, limit + 1),
            ).fetchall()
            return self._page(rows, limit)

    @staticmethod
    def _enqueue(db, conversation_id, message_id, content, kind, request_json):
        run_id, now = str(uuid4()), timestamp()
        db.execute(
            "INSERT INTO messages(id,conversation_id,role,content,intent,run_id,status,created_at,request_json) VALUES(?,?,'user',?,'queue',?,'accepted',?,?)",
            (message_id, conversation_id, content, run_id, now, request_json),
        )
        db.execute(
            "INSERT INTO runs(id,conversation_id,message_id,kind,prompt,created_at) VALUES(?,?,?,?,?,?)",
            (run_id, conversation_id, message_id, kind, content, now),
        )
        db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now, conversation_id))
        return run_id

    def submit_message(
        self, conversation_id, *, id, content, intent="queue", kind="chat", target_run_id=None
    ):
        request_json = _json(
            {
                "conversation_id": conversation_id,
                "content": content,
                "intent": intent,
                "kind": kind,
                "target_run_id": target_run_id,
            }
        )
        with self._connection(write=True) as db:
            self._require(db, "conversations", conversation_id)
            previous = db.execute("SELECT * FROM messages WHERE id=?", (id,)).fetchone()
            if previous:
                if previous["request_json"] != request_json:
                    raise StoreError(
                        "id_conflict", "Message ID already exists with different content"
                    )
                return {
                    "message": _record(previous),
                    "run": _record(self._require(db, "runs", previous["run_id"])),
                }
            if intent == "steer":
                run = self._require(db, "runs", target_run_id)
                if (
                    run["conversation_id"] != conversation_id
                    or run["status"] != "running"
                    or run["cancel_requested"]
                ):
                    raise StoreError(
                        "stale_steer", "The target run is no longer accepting guidance"
                    )
                run_id = run["id"]
                now = timestamp()
                db.execute(
                    "INSERT INTO messages(id,conversation_id,role,content,intent,run_id,status,created_at,request_json) VALUES(?,?,'user',?,'steer',?,'accepted',?,?)",
                    (id, conversation_id, content, run_id, now, request_json),
                )
                db.execute(
                    "UPDATE conversations SET updated_at=? WHERE id=?", (now, conversation_id)
                )
            else:
                run_id = self._enqueue(db, conversation_id, id, content, kind, request_json)
            return {
                "message": _record(self._require(db, "messages", id)),
                "run": _record(self._require(db, "runs", run_id)),
            }

    def list_messages(self, conversation_id, cursor=0, limit=50, *, before=None, latest=False):
        with self._connection() as db:
            self._require(db, "conversations", conversation_id)
            if latest or before is not None:
                rows = db.execute(
                    "SELECT * FROM messages WHERE conversation_id=? AND (? IS NULL OR seq<?) ORDER BY seq DESC LIMIT ?",
                    (conversation_id, before, before, limit + 1),
                ).fetchall()
                items = [_record(row) for row in reversed(rows[:limit])]
                return {
                    "items": items,
                    "next_cursor": None,
                    "previous_cursor": str(items[0]["seq"]) if len(rows) > limit else None,
                }
            rows = db.execute(
                "SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?",
                (conversation_id, cursor, limit + 1),
            ).fetchall()
            return self._page(rows, limit)

    def get_run(self, run_id):
        with self._connection() as db:
            return _record(self._require(db, "runs", run_id))

    def list_runs(
        self, conversation_id=None, cursor=0, limit=50, *, before=None, latest=False, status=None
    ):
        with self._connection() as db:
            if conversation_id:
                self._require(db, "conversations", conversation_id)
            if latest or before is not None:
                rows = db.execute(
                    "SELECT * FROM runs WHERE (? IS NULL OR conversation_id=?) AND (? IS NULL OR status=?) AND (? IS NULL OR seq<?) ORDER BY seq DESC LIMIT ?",
                    (conversation_id, conversation_id, status, status, before, before, limit + 1),
                ).fetchall()
                items = [_record(row) for row in reversed(rows[:limit])]
                return {
                    "items": items,
                    "next_cursor": None,
                    "previous_cursor": str(items[0]["seq"]) if len(rows) > limit else None,
                }
            rows = db.execute(
                "SELECT * FROM runs WHERE seq>? AND (? IS NULL OR conversation_id=?) AND (? IS NULL OR status=?) ORDER BY seq LIMIT ?",
                (cursor, conversation_id, conversation_id, status, status, limit + 1),
            ).fetchall()
            return self._page(rows, limit)

    def claim_next(self, kind):
        with self._connection(write=True) as db:
            row = db.execute(
                """SELECT r.*,c.workspace_path FROM runs r JOIN conversations c ON c.id=r.conversation_id
                WHERE r.kind=? AND r.status='queued' AND c.blocked=0
                  AND NOT EXISTS(SELECT 1 FROM runs active WHERE active.conversation_id=r.conversation_id AND active.status='running')
                  AND NOT EXISTS(SELECT 1 FROM runs earlier WHERE earlier.conversation_id=r.conversation_id AND earlier.status='queued' AND earlier.seq<r.seq)
                ORDER BY r.seq LIMIT 1""",
                (kind,),
            ).fetchone()
            if row is None:
                return None
            now = timestamp()
            db.execute("UPDATE runs SET status='running',started_at=? WHERE id=?", (now, row["id"]))
            db.execute("UPDATE messages SET status='applied' WHERE id=?", (row["message_id"],))
            self._event(db, row["id"], "started", {})
            result = _record(self._require(db, "runs", row["id"]))
            result["workspace_path"] = row["workspace_path"]
            return result

    def get_controls(self, run_id):
        with self._connection() as db:
            run = self._require(db, "runs", run_id)
            steers = db.execute(
                "SELECT * FROM messages WHERE run_id=? AND intent='steer' AND status='accepted' ORDER BY seq",
                (run_id,),
            ).fetchall()
            return {
                "cancel_requested": bool(run["cancel_requested"]),
                "steers": [_record(row) for row in steers],
            }

    def acknowledge_steers(self, run_id, ids):
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            if run["status"] != "running":
                return
            applied = []
            for identifier in ids:
                changed = db.execute(
                    "UPDATE messages SET status='applied' WHERE id=? AND run_id=? AND intent='steer' AND status='accepted'",
                    (identifier, run_id),
                ).rowcount
                if changed:
                    applied.append(identifier)
            if applied:
                self._event(db, run_id, "steer_applied", {"message_ids": applied})

    def add_event(self, run_id, type, data):
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            if run["status"] == "running":
                self._event(db, run_id, type, data)

    def list_events(self, run_id, after=0, limit=100):
        with self._connection() as db:
            self._require(db, "runs", run_id)
            rows = db.execute(
                "SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
                (run_id, after, limit + 1),
            ).fetchall()
            page = self._page(rows, limit)
            for item in page["items"]:
                item["data"] = json.loads(item["data"])
            return page

    def _finish(self, db, run, status, result=None, error=None):
        if run["status"] in TERMINAL:
            return
        if status == "completed" and run["cancel_requested"]:
            status = "cancelled"
        now = timestamp()
        db.execute(
            "UPDATE runs SET status=?,result=?,error=?,finished_at=? WHERE id=?",
            (status, result, error, now, run["id"]),
        )
        db.execute(
            "UPDATE messages SET status='rejected' WHERE run_id=? AND status='accepted'",
            (run["id"],),
        )
        # Withdrawing a queued follow-up changes no active execution or prior failure block.
        should_block = status != "completed" and not (
            status == "cancelled" and run["status"] == "queued"
        )
        db.execute(
            "UPDATE conversations SET blocked=MAX(blocked,?),updated_at=? WHERE id=?",
            (int(should_block), now, run["conversation_id"]),
        )
        if status == "completed" and result is not None:
            db.execute(
                "INSERT INTO messages(id,conversation_id,role,content,intent,run_id,status,created_at) VALUES(?,?,'assistant',?,'queue',?,'applied',?)",
                (str(uuid4()), run["conversation_id"], result, run["id"], now),
            )
        self._event(db, run["id"], status, {"result": result, "error": error})

    def finish_run(self, run_id, status, result=None, error=None):
        if status not in TERMINAL:
            raise ValueError("finish_run requires a terminal status")
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            self._finish(db, run, status, result, error)

    def cancel_run(self, run_id):
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            if run["status"] not in TERMINAL:
                db.execute("UPDATE runs SET cancel_requested=1 WHERE id=?", (run_id,))
                if run["status"] == "queued":
                    self._finish(db, run, "cancelled")
            return _record(self._require(db, "runs", run_id))

    def resume_conversation(self, conversation_id):
        with self._connection(write=True) as db:
            self._require(db, "conversations", conversation_id)
            db.execute(
                "UPDATE conversations SET blocked=0,updated_at=? WHERE id=?",
                (timestamp(), conversation_id),
            )
            return _record(self._require(db, "conversations", conversation_id))

    def recover_interrupted(self):
        with self._connection(write=True) as db:
            for row in db.execute("SELECT * FROM runs WHERE status='running'").fetchall():
                self._finish(
                    db,
                    row,
                    "interrupted",
                    error="Worker stopped before completion; inspect prior tool receipts before retrying",
                )

    def create_schedule(self, *, id, conversation_id, prompt, next_run_at, interval_seconds=None):
        due = (
            timestamp(next_run_at)
            if isinstance(next_run_at, datetime)
            else timestamp(datetime.fromisoformat(next_run_at))
        )
        request_json = _json(
            {
                "conversation_id": conversation_id,
                "prompt": prompt,
                "next_run_at": due,
                "interval_seconds": interval_seconds,
            }
        )
        with self._connection(write=True) as db:
            self._require(db, "conversations", conversation_id)
            existing = db.execute("SELECT * FROM schedules WHERE id=?", (id,)).fetchone()
            if existing:
                if existing["request_json"] != request_json:
                    raise StoreError(
                        "id_conflict", "Schedule ID already exists with different content"
                    )
                return _record(existing)
            db.execute(
                "INSERT INTO schedules(id,conversation_id,prompt,next_run_at,interval_seconds,created_at,request_json) VALUES(?,?,?,?,?,?,?)",
                (id, conversation_id, prompt, due, interval_seconds, timestamp(), request_json),
            )
            return _record(self._require(db, "schedules", id))

    def list_schedules(self, cursor=0, limit=50):
        with self._connection() as db:
            rows = db.execute(
                "SELECT rowid AS seq,* FROM schedules WHERE rowid>? ORDER BY rowid LIMIT ?",
                (cursor, limit + 1),
            ).fetchall()
            page = self._page(rows, limit)
            for item in page["items"]:
                item.pop("seq", None)
            return page

    def update_schedule(self, schedule_id, enabled):
        with self._connection(write=True) as db:
            self._require(db, "schedules", schedule_id)
            db.execute("UPDATE schedules SET enabled=? WHERE id=?", (int(enabled), schedule_id))
            return _record(self._require(db, "schedules", schedule_id))

    def tick_schedules(self, now=None):
        current = now or datetime.now(UTC)
        with self._connection(write=True) as db:
            schedules = db.execute(
                """SELECT s.* FROM schedules s WHERE s.enabled=1 AND s.next_run_at<=?
                AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=s.last_run_id AND r.status IN ('queued','running'))
                ORDER BY s.next_run_at""",
                (timestamp(current),),
            ).fetchall()
            for schedule in schedules:
                # Uniqueness and queue insertion share the transaction with advancing the due time.
                inserted = db.execute(
                    "INSERT OR IGNORE INTO schedule_fires(schedule_id,scheduled_at) VALUES(?,?)",
                    (schedule["id"], schedule["next_run_at"]),
                ).rowcount
                if inserted:
                    run_id = self._enqueue(
                        db,
                        schedule["conversation_id"],
                        str(uuid4()),
                        schedule["prompt"],
                        "task",
                        None,
                    )
                    db.execute(
                        "UPDATE schedules SET last_run_id=? WHERE id=?", (run_id, schedule["id"])
                    )
                if schedule["interval_seconds"] is None:
                    db.execute("UPDATE schedules SET enabled=0 WHERE id=?", (schedule["id"],))
                else:
                    due = datetime.fromisoformat(schedule["next_run_at"])
                    interval = schedule["interval_seconds"]
                    missed = int((current - due).total_seconds() // interval) + 1
                    next_due = due + timedelta(seconds=missed * interval)
                    db.execute(
                        "UPDATE schedules SET next_run_at=? WHERE id=?",
                        (timestamp(next_due), schedule["id"]),
                    )

    def heartbeat(self):
        with self._connection(write=True) as db:
            db.execute(
                "INSERT INTO worker_state(id,heartbeat_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at",
                (timestamp(),),
            )

    def worker_online(self):
        with self._connection() as db:
            row = db.execute("SELECT heartbeat_at FROM worker_state WHERE id=1").fetchone()
            if row is None:
                return False
            age = (datetime.now(UTC) - datetime.fromisoformat(row[0])).total_seconds()
            return 0 <= age < 15


_SCHEMA = [
    "CREATE TABLE assistant(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL,persona TEXT NOT NULL)",
    "INSERT INTO assistant VALUES(1,'知行','')",
    "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace_path TEXT NOT NULL,created_at TEXT NOT NULL)",
    "CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,project_id TEXT REFERENCES projects(id),workspace_path TEXT NOT NULL,blocked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
    "CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,intent TEXT NOT NULL CHECK(intent IN ('queue','steer')),run_id TEXT,status TEXT NOT NULL CHECK(status IN ('accepted','applied','rejected')),created_at TEXT NOT NULL,request_json TEXT)",
    "CREATE INDEX messages_conversation ON messages(conversation_id,seq)",
    "CREATE INDEX messages_controls ON messages(run_id,intent,status)",
    "CREATE TABLE runs(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES conversations(id),message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),kind TEXT NOT NULL CHECK(kind IN ('chat','task')),status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),prompt TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,result TEXT,error TEXT,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT)",
    "CREATE INDEX runs_queue ON runs(status,kind,seq)",
    "CREATE INDEX runs_conversation ON runs(conversation_id,status,seq)",
    "CREATE UNIQUE INDEX one_running_per_conversation ON runs(conversation_id) WHERE status='running'",
    "CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL)",
    "CREATE INDEX events_run ON events(run_id,seq)",
    "CREATE TABLE schedules(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),prompt TEXT NOT NULL,next_run_at TEXT NOT NULL,interval_seconds INTEGER CHECK(interval_seconds>0),enabled INTEGER NOT NULL DEFAULT 1,last_run_id TEXT REFERENCES runs(id),created_at TEXT NOT NULL,request_json TEXT NOT NULL)",
    "CREATE TABLE schedule_fires(schedule_id TEXT NOT NULL REFERENCES schedules(id),scheduled_at TEXT NOT NULL,PRIMARY KEY(schedule_id,scheduled_at))",
    "CREATE TABLE worker_state(id INTEGER PRIMARY KEY CHECK(id=1),heartbeat_at TEXT NOT NULL)",
]
